// Helpers on Grok and Antigravity (orchestrator run 0db6d1, step 3): titles, completion rules, Refine and Improve run as one headless
// ACP prompt (worker.ts acpAttempt) on a Grok or Antigravity account. The agent is test/fake-acp.js, a real process speaking ACP that
// advertises only fake ids; no real Grok or Antigravity runs and no model name is invented.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
require("./safe-temp").assertSafeTemp();

const worker = require("../out/worker.js");
const { AcpSession } = require("../out/acp.js");
const { generateText, completionRule, reviewRules, helperPolicy } = require("../out/text-actions.js");
const { compileDraft } = require("../out/compile.js");

const FAKE = path.join(__dirname, "fake-acp.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-acp-helpers-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
const GROK_HOME = path.join(root, "grok-work");
const LOG = path.join(root, "fake-acp.log");
const starts = [];
// The helper's ACP start, with the fake agent as the process; the real AcpSession and helper code run.
worker.acpHelper.start = (provider, cwd, grokHome, onUpdate, onPermission, env) => {
  starts.push({ provider, cwd, grokHome, inherited: ["ENTOMATICAL_SESSION", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].filter((k) => k in env) });
  return new AcpSession(spawn(process.execPath, [FAKE], { cwd, env: { ...env, FAKE_ACP_PROVIDER: provider, FAKE_ACP_LOG: LOG }, windowsHide: true }), onUpdate, onPermission);
};
const requests = () => { try { return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const signal = () => new AbortController().signal;
let n = 0;
const dir = (name) => path.join(root, `${++n}-${name}`);
const GROK = [{ name: "Grok · Work", provider: "grok" }];

test("a title on a Grok account: one ACP prompt with the schema in the packet, no tools, no inherited board identity", async () => {
  process.env.ENTOMATICAL_SESSION = "abcdef"; // a board session's identity must not reach a helper
  try {
    const lines = [];
    const before = starts.length;
    const r = await generateText(dir("title"), "title", "Fix the flaky login test in auth.spec.ts", GROK_HOME, "", "", signal(), undefined, { acp: "grok" }, [], "", { line: (t, s) => lines.push([s ?? "line", t]) });
    assert.deepEqual(r.value, { title: "Fake grok title" });
    assert.deepEqual(starts.slice(before).map((s) => [s.provider, s.grokHome, s.inherited.length]), [["grok", GROK_HOME, 0]]);
    // Not "outside process.cwd()": the neutral folder is under <main checkout>/.entomatical/tmp by design (rule 11), and a suite run
    // from the main checkout has that checkout as its cwd. The intent is that no working tree (the repository or a card's worktree) holds it.
    assert.equal(worker.insideRepository(starts.at(-1).cwd), false, "the agent runs in a neutral folder, not the repository");
    const prompt = requests().filter((q) => q.method === "session/prompt").at(-1).params.prompt[0].text;
    assert.match(prompt, /Generate a concise 3–7 word session title/);
    assert.match(prompt, /matches this JSON Schema:\n\{"type":"object"/);
    // The helper refused the agent's tool request; the streamed thought and answer reached the helper tab.
    assert.deepEqual(requests().filter((q) => q.permissionOutcome).at(-1).permissionOutcome, { outcome: "cancelled" });
    assert.ok(lines.some(([s, t]) => s === "thinking" && /Thinking/.test(t)) && lines.some(([s]) => s === "answer"));
    // No model named: the agent's own default answered, selected by its exact id (17 November 2026), and the attempt records what the agent reported.
    assert.deepEqual(requests().filter((q) => q.method === "session/set_config_option").map((q) => [q.params.configId, q.params.value]), [["agent_model", "fake-model-a"]]);
    assert.equal(r.model, "fake-model-a");
    assert.deepEqual(r.attempts.map((a) => [a.provider, a.outcome, a.model, a.reported.model, a.executable]), [["grok", "answered", "", "fake-model-a", "grok"]]);
  } finally { delete process.env.ENTOMATICAL_SESSION; }
});

test("Refine on a Grok account uses the chosen advertised model and effort; an unadvertised one fails clearly", async () => {
  const choice = { model: "fake-model-b", effort: "fake-high", via: { acp: "grok" } };
  const d = dir("refine");
  const r = await generateText(d, "refine", "make login work", GROK_HOME, choice.model, "", signal(), choice.effort, choice.via);
  assert.equal(r.value.kind, "revision"); assert.equal(r.value.revision, "Refined by fake grok.");
  assert.equal(r.model, "fake-model-b");
  assert.deepEqual(requests().filter((q) => q.method === "session/set_config_option").slice(-2).map((q) => [q.params.configId, q.params.value]),
    [["agent_model", "fake-model-b"], ["reasoning", "fake-high"]]);
  const receipt = JSON.parse(fs.readFileSync(r.receipt, "utf8"));
  assert.deepEqual([receipt.provider, receipt.requestedModel, receipt.requestedEffort], ["grok", "fake-model-b", "fake-high"]);
  await assert.rejects(generateText(dir("refine-bad"), "refine", "make login work", GROK_HOME, "fake-model-z", "", signal(), "", { acp: "grok" }),
    /Grok on grok-work does not advertise model fake-model-z\. It offers: fake-model-a, fake-model-b/);
});

test("a saved Grok answer is reused only for the same provider, model, effort and input", async () => {
  const d = dir("reuse");
  await generateText(d, "title", "Same draft", GROK_HOME, "", "", signal(), undefined, { acp: "grok" });
  const before = starts.length;
  await generateText(d, "title", "Same draft", GROK_HOME, "", "", signal(), undefined, { acp: "grok" });
  assert.equal(starts.length, before, "the same input reuses the saved answer");
  await generateText(d, "title", "Same draft", "", "", "", signal(), undefined, { acp: "antigravity" });
  assert.equal(starts.length, before + 1, "another provider is another input");
  assert.notEqual(worker.helperInputKey({ provider: "grok", model: "", effort: "", prompt: "p", schema: {} }),
    worker.helperInputKey({ provider: "antigravity", model: "", effort: "", prompt: "p", schema: {} }));
});

test("completion rules and their review run on a Grok account", async () => {
  const steps = [];
  const models = { configDir: GROK_HOME, fallbackConfigDirs: [], via: { acp: "grok" }, model: "fake-model-b" };
  const r = await completionRule(dir("rule"), "Make npm test pass.", { scripts: ["test"] }, models, signal(), (s) => steps.push(s));
  assert.deepEqual(r.rule, { goal: "The fake goal is reached.", doneWhen: "The fake check passes.", commands: ["npm test"] });
  assert.deepEqual([r.writer, r.effort], ["fake-model-b", "default"]);
  assert.deepEqual(steps, ["Grok is writing the completion rule at its default effort…"]);
  const review = await reviewRules(dir("review"), { prompt: "Make npm test pass.", checks: "passed", work: "diff" }, models, signal());
  assert.deepEqual([review.haikuGoodEnough, review.verdict, review.model], [true, "Haiku's rule was good enough.", "fake-model-b"]);
});

test("Improve and the helper policy on a Grok account", async () => {
  const policy = helperPolicy("Grok · Work", [], undefined, GROK);
  assert.deepEqual([policy.provider, policy.model, policy.effort, policy.via], ["grok", "", "", { acp: "grok" }]);
  assert.match(policy.source, /Grok: the agent's default model at its default effort/);
  const d = dir("improve");
  const r = await compileDraft(d, "Explain the test.", "", GROK_HOME, policy.model, policy.effort, signal(), [], policy.via);
  assert.equal(r.record.outcome.goal, "Explain the test.");
  assert.equal(r.model, "fake-model-a");
  const receipt = JSON.parse(fs.readFileSync(path.join(d, "compile-receipt.json"), "utf8"));
  assert.equal(receipt.provider, "grok");
});

test("a helper whose agent runs a preapproved tool fails and cancels the turn", async () => {
  process.env.FAKE_ACP_HELPER_TOOL = "1";
  const cancel = AcpSession.prototype.cancel;
  let cancels = 0;
  AcpSession.prototype.cancel = function (...args) { cancels++; return cancel.apply(this, args); };
  try {
    const lines = [];
    await assert.rejects(generateText(dir("tool"), "title", "Run a tool anyway", GROK_HOME, "", "", signal(), undefined, { acp: "grok" }, [], "", { line: (t, s) => lines.push([s ?? "line", t]) }),
      /Grok on grok-work ran a tool \(Run shell\); helpers use no tools, so the answer was discarded/);
    assert.ok(lines.some(([, t]) => /ran a tool \(Run shell\).*turn is cancelled/.test(t)));
    assert.equal(cancels, 1, "the helper cancels the agent's turn");
  } finally { delete process.env.FAKE_ACP_HELPER_TOOL; AcpSession.prototype.cancel = cancel; }
});

test("a Grok helper call is cancelled by its signal", async () => {
  const controller = new AbortController();
  const call = generateText(dir("cancel"), "title", "Cancel me", GROK_HOME, "", "", controller.signal, undefined, { acp: "grok" });
  controller.abort();
  await assert.rejects(call, /cancelled/);
});
