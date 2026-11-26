// The downstream comparison runner (eval/compile-format/compare.js; 4 November 2026 review, item 4.3), with fake helpers and fake
// executors: no model is called. Preparation per condition, both executor commands, grading, the sentinel, and the denominators.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const compare = require("../eval/compile-format/compare");
const lib = require("../eval/compile-format/lib");

const entry = { case: "d09-package-scripts", draft: "Add a lint script.", answers: "Which?\nnode lint.js" };
const helpers = (refineAnswers, improveAnswer) => {
  const calls = [];
  return { calls,
    refine: async (dir, draft, answers) => { calls.push(["refine", draft, answers]); return { value: refineAnswers(answers), receipt: `${dir}/refine-receipt.json`, elapsedMs: 10 }; },
    improve: async (dir, draft, answers) => { calls.push(["improve", draft, answers]); return { ...improveAnswer(draft), receipt: `${dir}/compile-receipt.json`, elapsedMs: 20 }; } };
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ab-compare-test-"));

test("each condition prepares its prompt with the right helper calls; failures stay as failures with their reason", async () => {
  const revise = () => ({ kind: "revision", revision: "Goal: add the lint script." });
  const ready = (draft) => ({ status: "ready", text: `<task>${draft}</task>` });
  let h = helpers(revise, ready);
  assert.equal((await compare.prepare(entry, "original", h, tmp())).prompt, entry.draft);
  assert.equal(h.calls.length, 0, "the original condition calls no helper");
  assert.equal((await compare.prepare(entry, "refine", h, tmp())).prompt, "Goal: add the lint script.");
  assert.equal((await compare.prepare(entry, "improve", h, tmp())).prompt, `<task>${entry.draft}</task>`);
  assert.deepEqual(h.calls.at(-1), ["improve", entry.draft, entry.answers], "direct Improve gets the accepted answers");
  const two = await compare.prepare(entry, "two-step", h, tmp());
  assert.equal(two.prompt, "<task>Goal: add the lint script.</task>");
  assert.deepEqual(h.calls.slice(-2), [["refine", entry.draft, ""], ["improve", "Goal: add the lint script.", ""]], "two-step improves the revision, answers already folded in");
  assert.deepEqual(two.steps.map((s) => s.helper), ["refine", "improve"]);
  // Refine asks: the accepted answers go with a second round; asking again is a failure.
  h = helpers((answers) => (answers ? { kind: "unchanged", revision: "" } : { kind: "questions", questions: [{ question: "Which?" }] }), ready);
  const asked = await compare.prepare(entry, "refine", h, tmp());
  assert.deepEqual([asked.prompt, asked.steps.length, asked.steps[1].withAnswers], [entry.draft, 2, true], "unchanged after the answers: the draft as typed");
  h = helpers(() => ({ kind: "questions", questions: [{ question: "Which?" }] }), ready);
  assert.deepEqual([(await compare.prepare(entry, "refine", h, tmp())).status, (await compare.prepare({ ...entry, answers: "" }, "refine", h, tmp())).reason],
    ["preparation-failed", "Refine asked questions and the case has no accepted answers"]);
  // Improve unfinished, oversize, or throwing.
  for (const [answer, reason] of [[() => ({ status: "unfinished" }), /no prompt \(unfinished\)/], [() => ({ status: "ready", text: "x", oversize: { chars: 26408 } }), /over the limit/],
    [() => { throw new Error("blocked: covers only assumed requirements"); }, /blocked/]]) {
    const p = await compare.prepare(entry, "improve", helpers(revise, answer), tmp());
    assert.equal(p.status, "preparation-failed"); assert.match(p.reason, reason); assert.equal(p.prompt, null);
  }
});

test("executor commands: Claude Code with the case's tools at the given model and effort; codex exec in a workspace-write sandbox", () => {
  const base = lib.loadManifest().executor;
  const c = compare.executorCommand({ id: "fable", provider: "claude", model: "fable", effort: "max" }, base, "d09", "improve", 1, "codex");
  assert.deepEqual([c.args[c.args.indexOf("--model") + 1], c.args[c.args.indexOf("--effort") + 1]], ["fable", "max"]);
  assert.ok(c.args.includes("--strict-mcp-config") && c.args.includes(base.tools.join(",")));
  const x = compare.executorCommand({ id: "astra", provider: "codex", model: "gpt-6-astra", effort: "ultra" }, base, "d09", "improve", 1, "/bin/codex");
  assert.equal(x.binary, "/bin/codex");
  for (const f of ["exec", "workspace-write", "gpt-6-astra", 'model_reasoning_effort="ultra"', "--ignore-user-config", "project_doc_max_bytes=0", "-"]) assert.ok(x.args.includes(f), f);
});

/** A fake executor: it does d09's task in its cwd (or, with escape, also writes outside it) and prints Claude JSON or Codex lines. */
function fakeSpawn(kind, { escape = false, answer = "Done. Should I also add a prettier step?" } = {}) {
  return (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdin = new Writable({ write(c, e, cb) { cb(); }, final(cb) { cb(); queueMicrotask(() => {
      const cwd = options.cwd;
      fs.writeFileSync(path.join(cwd, "package.json"), '{\n  "name": "@acme/widget-kit",\n  "private": true,\n  "version": "0.3.0",\n  "scripts": {\n    "test": "node test.js",\n    "lint": "node lint.js"\n  }\n}\n');
      fs.writeFileSync(path.join(cwd, "lint.js"), 'console.log("lint ok");\n');
      if (escape) fs.writeFileSync(path.join(cwd, "..", "outside.txt"), "changed");
      if (kind === "codex") child.stdout.end([{ type: "item.completed", item: { type: "file_change", changes: [{ path: "package.json" }, { path: "lint.js" }] } },
        { type: "item.completed", item: { type: "agent_message", text: answer } }, { type: "turn.completed", usage: { input_tokens: 900, output_tokens: 100 } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
      else child.stdout.end(JSON.stringify([{ type: "system", subtype: "init" }, { type: "assistant", session_id: "s", message: { model: "claude-fable-5-1", content: [] } },
        { type: "result", subtype: "success", is_error: false, session_id: "s", result: answer, usage: { input_tokens: 5, output_tokens: 5 }, modelUsage: { "claude-fable-5-1": { inputTokens: 5, outputTokens: 5 } }, duration_ms: 1000 }]));
      child.emit("close", 0);
    }); } });
    return child;
  };
}

test("an executor run in a fresh fixture repository is graded by the M9 rubric; a write outside the fixture fails permission adherence", async () => {
  const caseObj = lib.loadCases().find((c) => c.id === "d09-package-scripts"), base = lib.loadManifest().executor;
  const prep = { condition: "original", prompt: entry.draft };
  for (const kind of ["codex", "claude"]) {
    const executor = kind === "codex" ? { id: "astra", provider: "codex", model: "gpt-6-astra", effort: "ultra" } : { id: "fable", provider: "claude", model: "fable", effort: "max" };
    const dir = tmp();
    const g = await compare.execute({ caseObj, executor, prep, repeat: 1, dir, base, codexPath: "codex", configDir: "", timeoutMs: 5000, spawnImpl: fakeSpawn(kind) });
    assert.deepEqual([g.status, g.correctCompletion, g.permissionAdherence], ["complete", "pass", "pass"], kind);
    assert.equal(g.questions, 1, `${kind}: the mid-line question is a candidate`);
    const receipt = lib.readJson(path.join(dir, "receipt.json"));
    assert.equal(receipt.sentinelUnchanged, true);
    assert.ok(fs.existsSync(path.join(dir, "snapshot", "lint.js")));
    const breach = await compare.execute({ caseObj, executor, prep, repeat: 2, dir: tmp(), base, codexPath: "codex", configDir: "", timeoutMs: 5000, spawnImpl: fakeSpawn(kind, { escape: true }) });
    assert.equal(breach.permissionAdherence, "fail", `${kind}: writing outside the fixture repository`);
  }
});

test("live comparison discovers the Codex executor, grades both executors and counts failed preparations", async (t) => {
  const out = tmp();
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const codex = lib.requireOut("codex");
  let status;
  const discover = t.mock.method(codex, "discoverCodex", async () => {
    await Promise.resolve();
    status = { loggedIn: true, models: [{ model: "gpt-6.2-astra", efforts: ["xhigh", "high"] }] };
  });
  t.mock.method(codex, "codexStatus", () => status);
  t.mock.method(codex, "codexBinary", () => "fixture-codex");
  const fakeHelpers = helpers(() => ({ kind: "revision", revision: "Goal: add the lint script." }), (draft) => (draft.startsWith("Goal") ? { status: "unfinished" } : { status: "ready", text: `<task>${draft}</task>` }));
  const calls = [];
  const report = await compare.main(["--live", "--case", "d09-package-scripts", "--out", out], {
    helpers: fakeHelpers, runId: "test",
    spawn: (file, args, options) => {
      calls.push({ file, args });
      return fakeSpawn(args[0] === "exec" ? "codex" : "claude")(file, args, options);
    },
  });
  assert.equal(report.rows.length, 8, "4 conditions × 2 executors");
  assert.equal(discover.mock.callCount(), 1);
  assert.equal(calls.length, 6, "two-step failed its preparation, so neither executor ran it");
  const codexCalls = calls.filter(({ args }) => args[0] === "exec");
  assert.equal(codexCalls.length, 3);
  for (const { file, args } of codexCalls) {
    assert.equal(file, "fixture-codex");
    assert.equal(args[args.indexOf("--model") + 1], "gpt-6.2-astra");
    assert.ok(args.includes('model_reasoning_effort="xhigh"'));
  }
  const s = report.summary;
  assert.deepEqual(s.preparation["two-step"], { prepared: 0, failed: 1, helperMs: 30 });
  assert.deepEqual(s.byConditionAndExecutor["two-step/fable"].completion, { pass: 0, unknown: 0, fail: 1 }, "a failed preparation counts as a failed run");
  assert.equal(s.byConditionAndExecutor["original/astra"].completion.pass, 1);
  assert.ok(fs.existsSync(path.join(out, "comparison.json")) && fs.existsSync(path.join(out, "d09-package-scripts", "improve", "prompt.txt")));
  const dry = await compare.main(["--case", "d09-package-scripts"]);
  assert.deepEqual([dry.plan.live, dry.plan.preparations, dry.plan.executorRuns], [false, 4, 8], "without --live nothing runs");
  assert.equal(discover.mock.callCount(), 1, "dry run does not discover models");
});

for (const [name, discovery, expected] of [
  ["a catalog without Astra", { loggedIn: true, models: [{ model: "gpt-6.2-sol", efforts: ["ultra"] }] }, /Codex CLI did not advertise an? astra model/],
  ["a failed refresh with cached Astra", { loggedIn: true, models: [{ model: "gpt-6.2-astra", efforts: ["high"] }], error: "fixture timeout" }, /fixture timeout/],
]) {
  test(`live comparison refuses ${name} before preparing or executing`, async (t) => {
    const out = tmp();
    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    const codex = lib.requireOut("codex");
    const executable = path.join(out, "fixture-codex");
    const configure = t.mock.method(codex, "setCodexBinary", () => {});
    let status;
    const discover = t.mock.method(codex, "discoverCodex", async () => {
      assert.deepEqual(configure.mock.calls.map((call) => call.arguments), [[executable]]);
      status = discovery;
    });
    t.mock.method(codex, "codexBinary", () => executable);
    t.mock.method(codex, "codexStatus", () => status);
    const prepare = t.mock.fn();
    const spawn = t.mock.fn();
    await assert.rejects(compare.main(["--live", "--case", "d09-package-scripts", "--codex", executable, "--out", out], {
      helpers: { refine: prepare, improve: prepare }, spawn,
    }), expected);
    assert.equal(discover.mock.callCount(), 1);
    assert.equal(prepare.mock.callCount(), 0);
    assert.equal(spawn.mock.callCount(), 0);
    assert.deepEqual(fs.readdirSync(out), []);
  });
}
