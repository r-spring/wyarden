const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
// Run in an isolated Node process so its spawn replacement cannot affect other tests.
// Every provider process is intercepted before either production module is loaded.
async function captureProviderRouting() {
  const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
  const { EventEmitter } = require("node:events");
  const { PassThrough, Writable } = require("node:stream");
  const dir = process.argv[4], configDir = path.join(dir, "explicit-account");
  const calls = [];
  let wrongModel = false;
  process.env.CLAUDE_CODE_EFFORT_LEVEL = "low";
  require("node:child_process").spawn = (binary, args, options) => {
    const flag = name => args[args.indexOf(name) + 1];
    const requested = flag("--model").replace(/^claude-([a-z]+)-[\d-]+$/, "$1"), model = `claude-${wrongModel ? "sonnet" : requested}-5-5`;
    const schema = JSON.parse(flag("--json-schema"));
    const value = schema.properties.title ? { title: "Synthetic routing check" }
      : { kind: "unchanged", revision: "", questions: [], assumptions: [] };
    const result = { type: "result", subtype: "success", is_error: false, session_id: "synthetic-routing",
      structured_output: value, subagent_stats: { spawned: 0 },
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: { [model]: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } };
    calls.push({ model: requested, effort: flag("--effort"), configDir: options.env.CLAUDE_CONFIG_DIR });
    assert.equal(args.includes("--fallback-model"), false);
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(options.env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
    assert.deepEqual(JSON.parse(flag("--settings")), { fallbackModel: [], switchModelsOnFlag: false });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdin = new Writable({ write(chunk, encoding, callback) { callback(); }, final(callback) {
      callback(); queueMicrotask(() => { child.stdout.end(JSON.stringify(result)); child.emit("close", 0); });
    } });
    return child;
  };
  const { generateText } = require(process.argv[2]);
  const signal = new AbortController().signal;
  await assert.rejects(generateText(path.join(dir, "missing-effort"), "refine", "Explain the test.", configDir, "opus", "", signal), /effort/i);
  assert.equal(calls.length, 0);
  for (const model of ["opus", "sonnet", "haiku", "fable"]) {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const output = await generateText(path.join(dir, `${model}-${effort}`), "refine", "Planning only: explain the test.", configDir, model, "", signal, effort);
      assert.equal(output.model, `claude-${model}-5-5`);
      assert.deepEqual(calls.at(-1), { model, effort, configDir });
    }
  }
  await generateText(path.join(dir, "deep"), "refine", "Explain the test.", configDir, "fable", "", signal, "max");
  assert.deepEqual(calls.at(-1), { model: "fable", effort: "max", configDir });

  // A conflicting provider identity must fail once, without retrying a different model.
  wrongModel = true;
  const before = calls.length;
  await assert.rejects(generateText(path.join(dir, "wrong-model"), "refine", "Explain the test.", configDir, "opus", "", signal, "high"), /requested opus|identify|model/i);
  assert.equal(calls.length, before + 1);
  assert.deepEqual(calls.at(-1), { model: "opus", effort: "high", configDir });
  wrongModel = false;

  await generateText(path.join(dir, "title"), "title", "Explain the test.", configDir, "haiku", "", signal);
  assert.deepEqual(calls.at(-1), { model: "haiku", effort: "medium", configDir });
  assert.equal(calls.length, 23);
}

test("the provider runner uses exact refinement selections and preserves other callers' medium effort", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-refine-routing-"));
  try {
    const script = path.join(dir, "capture.cjs");
    fs.writeFileSync(script, `(${captureProviderRouting.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`);
    execFileSync(process.execPath, [script, require.resolve("../out/text-actions"), "", dir], { encoding: "utf8", timeout: 15_000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Q2 (the user, 4 November 2026): Refine and Improve always use the most capable model at its highest effort; the account picks the provider.
test("helperPolicy: Fable at max on a Claude account; the newest Astra at its highest effort on Codex; never the task's own model", () => {
  const { helperPolicy } = require("../out/text-actions");
  const codex = { accounts: ["Codex · me"], models: [{ model: "gpt-6-astra", efforts: ["medium", "ultra"] }, { model: "gpt-6.1-astra", efforts: ["low", "high", "max"] },
    { model: "gpt-6.1-sol", efforts: ["low", "ultra"] }, { model: "gpt-6.2-astra", efforts: ["low"], hidden: true }] };
  assert.deepEqual((({ account, model, effort }) => ({ account, model, effort }))(helperPolicy("me@x", ["me@x"], codex)), { account: "me@x", model: "fable", effort: "max" });
  const c = helperPolicy("Codex · me", ["me@x"], codex);
  assert.deepEqual([c.model, c.effort, c.provider], ["gpt-6.1-astra", "max", "codex"], "the newest listed (not hidden) Astra, at the highest effort it offers");
  assert.match(c.source, /newest Astra/);
  assert.throws(() => helperPolicy("Codex · me", [], { accounts: ["Codex · me"], models: [{ model: "gpt-6.1-sol", efforts: ["ultra"] }] }), /did not advertise a astra model/);
  assert.throws(() => helperPolicy("nobody", ["me@x"], codex), /Select an available account/);
  assert.throws(() => helperPolicy(undefined, ["me@x"], codex), /Select an available account/);
});
