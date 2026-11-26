// Plan steps on Grok and Antigravity (orchestrator run 0db6d1, step 3): a plan names a Grok or Antigravity account like a Claude or
// Codex one; its model and effort are checked against what the account last advertised (or queued before it advertised anything); the
// steps run headless through runHeadlessAcp and settle like Claude steps. The agents are test/fake-acp.js, a real process speaking ACP
// that advertises only fake ids: there is no fixed Grok or Antigravity model list.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync, spawn } = require("node:child_process");
require("./safe-temp").assertSafeTemp();

class EventEmitter {
  listeners = [];
  event = (l) => (this.listeners.push(l), { dispose() {} });
  fire(e) { for (const l of this.listeners) l(e); }
  dispose() {}
}
let modals = 0;
const vscode = { EventEmitter, ThemeIcon: class {}, commands: { executeCommand: async () => {} },
  Uri: { from: (parts) => ({ ...parts, toString: () => `${parts.scheme}://${parts.authority}${parts.path}` }), file: (p) => ({ fsPath: p }) },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => { modals++; return undefined; }, showInformationMessage: async () => undefined } };
const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-plan-acp-home-"));
process.env.HOME = process.env.USERPROFILE = home;
process.env.ENTOMATICAL_USAGE_DIR = path.join(home, "usage");
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board } = require("../out/board.js");
const { AcpSession } = require("../out/acp.js");
const P = require("../out/plan.js");
const { toStart } = require("../out/queue.js");

const FAKE = path.join(__dirname, "fake-acp.js");
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 60 s: the Grok step's merge ran past 15 s under the board's full-suite load (12 November 2026); an idle machine settles in a few seconds.
const until = async (what, ok, ms = 60000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (ok()) return; assert.fail(`timed out waiting for ${what}`); };
const made = [], boards = [];
// Node 26 on Windows: rmSync fails EPERM at once while an ended fake agent still holds a worktree as its cwd; retry for up to 30 s.
const removeDir = async (dir) => {
  for (const end = Date.now() + 30000; ; await sleep(250)) {
    try { return fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(e.code) || Date.now() > end) throw e; }
  }
};
test.after(async () => { for (const b of boards) b.dispose(); for (const d of [...made, home]) await removeDir(d); });

const CATALOGUE = { unit: { run: "npm test" } };
const GROK = { name: "Grok · Work", provider: "grok", configDir: path.join(home, "grok-work") };
const AGY = { name: "Antigravity · Shared", provider: "antigravity", configDir: "" };

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-plan-acp-"));
  made.push(repo);
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t"); sh(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  fs.mkdirSync(path.join(repo, "workflows")); fs.writeFileSync(path.join(repo, "workflows", "checks.json"), JSON.stringify(CATALOGUE));
  const file = path.join(repo, "workflows", "acp.plan.json");
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  boards.push(board);
  board.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }, GROK, AGY];
  board.accountFolderList = () => [path.join(home, "acct")];
  board.preflightHeadless = async () => {};
  board.requestRateMs = 0;
  // Checks record "running" on the step's committed revision; each test finishes them (as test/plan.test.js does).
  board.checks.start = (t) => { if (t.completion?.commands.length && t.worktree) board.recordChecks(t, { status: "running", run: "mock", revision: sh(t.worktree, "rev-parse", "HEAD") }); };
  const log = path.join(repo, ".entomatical", "fake-acp.log");
  const runs = [];
  // The board's ACP start, with the fake agent as the process: the real AcpSession, permission handler and settle path run.
  board.probeAcpCatalogs = false; // F92 catalog probe: checked in refused-start.test.js; these fakes count every session
  board.runAcp = (provider, cwd, profile, update, permission, env) => {
    runs.push({ provider, cwd, profile, env });
    const child = spawn(process.execPath, [FAKE], { cwd, env: { ...env, FAKE_ACP_PROVIDER: provider, FAKE_ACP_LOG: log }, windowsHide: true });
    return new AcpSession(child, update, permission);
  };
  board.tick();
  const requests = () => { try { return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { repo, board, file, runs, requests };
}
const plan = (extra, steps) => ({ v: 1, name: "Two agents", review: "checks", steps, ...extra });

test("a plan with a Grok step and an Antigravity step validates against each account's advertised options, or queues them", () => {
  const efforts = ["fake-low", "fake-high"];
  const profiles = [
    { name: "acct", provider: "claude", models: ["opus", "sonnet"].map((id) => ({ id, efforts: ["low", "high"] })), permissions: ["ask", "edits", "auto", "bypass"] },
    { name: GROK.name, provider: "grok", models: ["fake-model-a", "fake-model-b"].map((id) => ({ id, efforts })), efforts, permissions: ["ask", "bypass"] },
    { name: AGY.name, provider: "antigravity", models: [], efforts: [], permissions: ["ask", "bypass"], pending: true },
  ];
  const rules = { catalogue: CATALOGUE, models: ["opus", "sonnet"], efforts: ["low", "high"], permissions: ["ask", "edits", "auto", "bypass"], profiles, defaultAccount: "acct", maxSteps: 12 };
  const errorsOf = (raw) => { const v = P.validatePlanFile(raw, rules); return "errors" in v ? v.errors : []; };
  const good = plan({}, [
    { id: "g", title: "On Grok", goal: "g", account: GROK.name, model: "fake-model-b", effort: "fake-high", permission: "bypass", checks: ["unit"] },
    // Antigravity has advertised nothing yet: its model is queued and checked when the session opens (as board.ts add).
    { id: "a", title: "On Antigravity", goal: "g", account: AGY.name, model: "fake-model-a", checks: ["unit"], after: ["g"] },
    // A provider's name picks its only account, as resolveAccount does.
    { id: "n", title: "By name", goal: "g", account: "grok", effort: "fake-low", checks: ["unit"] }]);
  assert.deepEqual(errorsOf(good), []);
  const result = P.validatePlanFile(good, rules);
  assert.match(P.planPreview(result.plan, result.cards, CATALOGUE).join("\n"), /On Grok · account: Grok · Work .* fake-model-b · fake-high effort · bypass permissions/);
  const bad = errorsOf(plan({}, [
    { id: "g", title: "On Grok", goal: "g", account: GROK.name, model: "fake-model-z", checks: ["unit"] },
    { id: "e", title: "Effort", goal: "g", account: GROK.name, effort: "max", checks: ["unit"] },
    { id: "p", title: "Permission", goal: "g", account: AGY.name, permission: "edits", checks: ["unit"] }])).join("\n");
  for (const want of [/Step "g" "model" must be one of fake-model-a, fake-model-b/, /Step "e" "effort" is not available/, /Step "p" "permission" must be one of ask, bypass/]) assert.match(bad, want);
  assert.doesNotMatch(bad, /Claude only|not supported/);
});

test("board.checkPlan offers Grok and Antigravity accounts, from their last advertised catalog", () => {
  const { board, file } = fixture();
  // Nothing advertised yet: any model is queued.
  assert.ok("cards" in board.checkPlan(plan({ account: GROK.name, model: "fake-model-b" }, [{ id: "g", title: "G", goal: "g", checks: ["unit"] }])));
  board.rememberAcpOptions({ provider: "grok", configDir: GROK.configDir, account: GROK.name },
    [{ id: "agent_model", name: "Model", category: "model", values: [{ value: "fake-model-a", name: "A" }] }, { id: "reasoning", name: "Thinking", category: "thought_level", values: [{ value: "fake-high", name: "High" }] }]);
  assert.ok("cards" in board.checkPlan(plan({ account: GROK.name, model: "fake-model-a", effort: "fake-high" }, [{ id: "g", title: "G", goal: "g", checks: ["unit"] }])));
  const v = board.checkPlan(plan({ account: GROK.name, model: "fake-model-b" }, [{ id: "g", title: "G", goal: "g", checks: ["unit"] }]));
  assert.match(v.errors.join(" "), /"model" must be one of fake-model-a/);
  void file;
});

test('advertised ACP without Ask support is refused during plan preflight before creating cards', async () => {
  const { board, file, runs } = fixture();
  board.rememberAcpOptions({ provider: 'grok', configDir: GROK.configDir, account: GROK.name },
    [{ id: 'agent_model', name: 'Model', category: 'model', values: [{ value: 'fake-model-a', name: 'A' }] }]);
  assert.ok(board.acpAskRefusal(GROK));
  const raw = plan({}, [{ id: 'g', title: 'Ask worker', goal: 'g', account: GROK.name, model: 'fake-model-a', permission: 'ask', checks: ['unit'] }]);
  const checked = board.checkPlan(raw);
  assert.ok(checked.errors, 'unsupported Ask must fail the same preflight used by setup preview');
  assert.match(checked.errors.join('\n'), /Step "g"/);
  assert.equal(board.tasks.length, 0);
  await assert.rejects(board.runPlan(raw, file), /Ask|ask/);
  assert.equal(board.tasks.length, 0); assert.equal(runs.length, 0);
  for (const role of ['judge', 'scribe']) {
    const rolePlan = plan({ account: GROK.name, permission: 'ask', ...(role === 'judge' ? { judge: 'fake-model-a' } : { scribe: { model: 'fake-model-a', documents: ['REPORT.md'], after: ['g'] } }) },
      [{ id: 'g', title: 'Bypass worker', goal: 'g', permission: 'bypass', checks: ['unit'] }]);
    assert.match(board.checkPlan(rolePlan).errors.join('\n'), role === 'judge' ? /Judge:/ : /Scribe:/);
  }
});

test("pausing a run during ACP configuration keeps the worker prompt out of the agent session", async () => {
  const { board, file, requests } = fixture();
  const start = board.runAcp;
  board.runAcp = (...args) => {
    const session = start(...args), configure = session.configure.bind(session);
    session.configure = async (...settings) => {
      await configure(...settings);
      board.pauseRun(board.tasks.find(t => t.planRun));
    };
    return session;
  };
  const raw = plan({}, [{ id: "w", title: "Worker", goal: "Do not submit this prompt.", account: GROK.name, model: "fake-model-b", checks: ["unit"] }]);
  const { card, steps: [worker] } = await board.runPlan(raw, file);
  assert.equal(card.paused, true);
  assert.deepEqual([worker.status, worker.held, worker.sessionId], ["queued", true, undefined]);
  assert.equal(requests().some(r => r.method === "session/prompt"), false);
  assert.equal(board.events(worker.id).some(e => e.hook_event_name === "UserPromptSubmit"), false);
});

test("a plan with a Grok step and an Antigravity step runs headless through ACP to settled: both merged and Done", async () => {
  const { board, file, runs, requests } = fixture();
  const raw = plan({}, [
    { id: "g", title: "Grok writes", goal: "Write the Grok file.", account: GROK.name, model: "fake-model-b", effort: "fake-high", checks: ["unit"] },
    { id: "a", title: "Antigravity writes", goal: "Write the Antigravity file.", account: AGY.name, checks: ["unit"], after: ["g"] }]);
  const { card, steps: [grok, agy] } = await board.runPlan(raw, file);
  assert.deepEqual([grok.provider, agy.provider], ["grok", "antigravity"]);
  // No permission in the plan: an ACP step gets bypass, as the preview says and a headless Claude step gets.
  assert.deepEqual([grok.permission, agy.permission], ["bypass", "bypass"]);
  assert.deepEqual(grok.acpSelections, { model: "fake-model-b", thought_level: "fake-high" });
  await until("Grok step settles", () => grok.checks?.status === "running");
  assert.equal(fs.readFileSync(path.join(grok.worktree, "fake-grok.txt"), "utf8"), "written by fake grok\n");
  assert.equal(sh(grok.worktree, "status", "--porcelain"), "", "the step's work is committed before its checks");
  board.recordChecks(grok, { status: "complete", run: "mock", revision: grok.checks.revision });
  await until("Grok step merged and Done", () => grok.status === "done");
  // The extension's startHeld starts what the queue releases (src/extension.ts); a board alone does not, so the test does it the same way.
  assert.deepEqual(toStart(board.tasks, 0).map((t) => t.id), [agy.id], "the Antigravity step is released once the Grok step is Done");
  await board.startHeadless(agy);
  await until("Antigravity step settles", () => agy.checks?.status === "running");
  board.recordChecks(agy, { status: "complete", run: "mock", revision: agy.checks.revision });
  await until("Antigravity step merged and Done", () => agy.status === "done");
  await until("plan delivered", () => card.deliveryReady === true);
  for (const name of ["fake-grok.txt", "fake-antigravity.txt"]) assert.ok(fs.existsSync(path.join(card.worktree, name)), `${name} merged into the plan branch`);
  // The Grok profile reached the agent; the model and thought level were set from the fake agent's own ids; bypass allowed the write.
  assert.deepEqual(runs.map((r) => [r.provider, r.profile]), [["grok", GROK.configDir], ["antigravity", ""]]);
  const set = requests().filter((r) => r.method === "session/set_config_option" && r.provider === "grok").map((r) => [r.params.configId, r.params.value]);
  assert.deepEqual(set, [["agent_model", "fake-model-b"], ["reasoning", "fake-high"]]);
  assert.deepEqual(requests().filter((r) => r.permissionOutcome).map((r) => [r.provider, r.permissionOutcome.outcome, r.permissionOutcome.optionId]),
    [["grok", "selected", "yes"], ["antigravity", "selected", "yes"]]);
  assert.equal(modals, 0, "an unattended step never opens a permission dialog");
  for (const t of [grok, agy]) assert.ok(board.events(t.id).some((e) => e.hook_event_name === "Stop" && e.source === "acp"), `${t.title} ended with an ACP Stop`);
});
