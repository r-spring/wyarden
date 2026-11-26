// F102 (the user, 13 November 2026): the right-click picks of the helper buttons (src/action-picks.ts), how each action's runner applies
// them, and that no pick is today's behaviour exactly. The handlers themselves are run in test/extension-refine.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const picks = require("../out/action-picks");
const { helperPolicy } = require("../out/text-actions");
const { reviewerModel } = require("../out/done-review");
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? {} : load.call(this, request, ...rest); };
const finish = require("../out/finish");
Module._load = load;

const CODEX = { accounts: ["cx"], models: [{ model: "gpt-6-astra", efforts: ["medium", "high", "ultra"] }, { model: "gpt-6.1-sol", efforts: ["low", "max"] }] };

test("cleanPick keeps only what the action can use; an empty pick is a reset; an unknown action is refused", () => {
  assert.deepEqual(picks.cleanPick("review", { account: "a@x", provider: "claude", model: "opus", effort: "high", permission: "bypass", extra: 1 }),
    { action: "review", pick: { account: "a@x", provider: "claude", model: "opus", effort: "high" } }, "no permission mode outside Finish");
  assert.deepEqual(picks.cleanPick("finish", { account: "a@x", provider: "claude", model: "opus", permission: "bypass" }),
    { action: "finish", pick: { provider: "claude", model: "opus", permission: "bypass" } }, "Finish takes no account");
  assert.deepEqual(picks.cleanPick("finish", { provider: "codex", model: "astra", permission: "ask" }), { action: "finish", pick: undefined }, "Finish is Claude only, and never Ask");
  assert.deepEqual(picks.cleanPick("refine", {}), { action: "refine", pick: undefined });
  assert.deepEqual(picks.cleanPick("refine", { provider: "claude" }), { action: "refine", pick: undefined }, "a provider alone picks nothing");
  assert.throws(() => picks.cleanPick("deploy", {}), /Unknown action deploy/);
  assert.deepEqual(picks.readPicks({ refine: { model: "x" }, improve: { provider: "claude", effort: "max" }, deploy: { account: "a" } }), { improve: { provider: "claude", effort: "max" } });
  assert.deepEqual(picks.readPicks(undefined), {});
});

test("helperPolicy: no pick is the maximum policy exactly; a pick applies only on its own provider", () => {
  assert.deepEqual(helperPolicy("me", ["me"], CODEX), { account: "me", model: "fable", effort: "max", source: "maximum policy: Claude Fable at max effort" });
  assert.deepEqual(helperPolicy("cx", ["me"], CODEX), { account: "cx", model: "gpt-6-astra", effort: "ultra", provider: "codex",
    source: "maximum policy: the newest Astra the Codex CLI lists (gpt-6-astra) at its highest effort (ultra)" });
  assert.deepEqual(helperPolicy("me", ["me"], CODEX, [], { provider: "claude", model: "opus", effort: "high" }),
    { account: "me", model: "opus", effort: "high", source: "your pick: Claude opus at high effort" });
  assert.equal(helperPolicy("me", ["me"], CODEX, [], { provider: "claude", effort: "low" }).model, "fable", "an effort alone keeps Fable");
  assert.equal(helperPolicy("me", ["me"], CODEX, [], { provider: "codex", model: "sol" }).model, "fable", "a Codex pick does not apply on Claude");
  // Codex: a short name runs the newest id; an effort it does not list falls back to the default's, else its highest.
  assert.deepEqual(helperPolicy("cx", ["me"], CODEX, [], { provider: "codex", model: "sol", effort: "high" }), { account: "cx", model: "gpt-6.1-sol", effort: "max", provider: "codex", source: "your pick: Codex gpt-6.1-sol at max effort" });
  assert.equal(helperPolicy("cx", ["me"], CODEX, [], { provider: "codex", model: "astra", effort: "medium" }).effort, "medium");
  // A pick of a listed model works where no Astra is listed (the default would refuse).
  assert.throws(() => helperPolicy("cx", ["me"], { accounts: ["cx"], models: [{ model: "gpt-6.1-sol", efforts: ["max"] }] }), /did not advertise a astra model/);
  assert.equal(helperPolicy("cx", ["me"], { accounts: ["cx"], models: [{ model: "gpt-6.1-sol", efforts: ["max"] }] }, [], { provider: "codex", model: "sol" }).model, "gpt-6.1-sol");
  // Grok: the advertised id as given, on the Grok account only.
  const grok = [{ name: "g", provider: "grok" }];
  assert.deepEqual(helperPolicy("g", [], CODEX, grok, { provider: "grok", model: "grok-5", effort: "high" }).model + "/" + helperPolicy("g", [], CODEX, grok, { provider: "grok", model: "grok-5", effort: "high" }).effort, "grok-5/high");
  assert.equal(helperPolicy("g", [], CODEX, grok, { provider: "antigravity", model: "x" }).model, "", "another provider's pick: the agent's default");
});

test("reviewerModel: no pick is Fable at medium or Astra at medium; a pick for the card's provider replaces them", () => {
  assert.deepEqual(reviewerModel(undefined, CODEX.models), { model: "fable", effort: "medium" });
  assert.deepEqual(reviewerModel("codex", CODEX.models), { model: "gpt-6-astra", effort: "medium" });
  assert.deepEqual(reviewerModel("grok", CODEX.models), { model: "", effort: "" });
  assert.deepEqual(reviewerModel(undefined, CODEX.models, { provider: "claude", model: "opus", effort: "high" }), { model: "opus", effort: "high" });
  assert.deepEqual(reviewerModel(undefined, CODEX.models, { provider: "codex", model: "sol" }), { model: "fable", effort: "medium" });
  assert.deepEqual(reviewerModel("codex", CODEX.models, { provider: "codex", model: "sol" }), { model: "gpt-6.1-sol", effort: "max" }, "medium is not listed: the highest");
  assert.deepEqual(reviewerModel("grok", CODEX.models, { provider: "grok", effort: "low" }), { model: "", effort: "low" });
  assert.deepEqual(reviewerModel(undefined, CODEX.models, { provider: "claude", model: "gpt-x", effort: "ultra" }), { model: "fable", effort: "medium" }, "nothing Claude takes: the default");
});

test("Finish: no pick is Haiku for the commit message and acceptEdits with the session's own model for a conflict; a pick sets both", () => {
  assert.deepEqual(picks.finishRun(undefined), { messageModel: "haiku", messageEffort: undefined, model: undefined, effort: undefined, permission: "acceptEdits" });
  assert.deepEqual(picks.finishRun({ provider: "claude", model: "opus", effort: "high", permission: "bypass" }),
    { messageModel: "opus", messageEffort: "high", model: "opus", effort: "high", permission: "bypassPermissions" });
  assert.deepEqual(picks.finishRun({ permission: "auto" }).permission, "auto");
});

test("headlessClaude passes the Finish pick's model, effort and permission mode; without one its arguments are as before", async () => {
  const cp = require("node:child_process"), was = cp.spawn, seen = [];
  cp.spawn = (bin, args) => {
    seen.push(args);
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => true;
    c.stdin = new Writable({ write(chunk, _e, cb) { cb(); }, final(cb) { cb(); queueMicrotask(() => { c.stdout.end("ok"); c.emit("close", 0); }); } });
    return c;
  };
  try {
    await finish.headlessClaude("/wt", "", "sess-1", "PROMPT", new AbortController().signal);
    await finish.headlessClaude("/wt", "", "sess-1", "PROMPT", new AbortController().signal, undefined, picks.finishRun({ provider: "claude", model: "opus", effort: "high", permission: "bypass" }));
  } finally { cp.spawn = was; }
  const tools = finish.helperTools();
  assert.deepEqual(seen[0], ["-p", "--resume", "sess-1", "--permission-mode", "acceptEdits", "--disallowedTools", ...finish.HELPER_DENIED, "--allowedTools", tools]);
  assert.deepEqual(seen[1], ["-p", "--resume", "sess-1", "--model", "claude-opus-5-5", "--effort", "high", "--permission-mode", "bypassPermissions", "--disallowedTools", ...finish.HELPER_DENIED, "--allowedTools", tools]); // the full id (models.ts CLAUDE_MODEL_IDS)
});
