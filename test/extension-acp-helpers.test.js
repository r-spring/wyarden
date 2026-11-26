// Helpers driven from src/extension.ts on a Grok account (orchestrator run 0db6d1): Refine draft, Improve prompt, the automatic title
// and the completion rule run on that same Grok account through worker.ts's ACP path, never on a Claude account. The extension is
// loaded in isolation (as extension-refine.test.js); text-actions, compile and worker are the real modules, and the only stand-in is
// the ACP agent process: test/fake-acp.js, which advertises only fake ids (there is no fixed Grok model list).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { spawn } = require("node:child_process");
require("./safe-temp").assertSafeTemp();
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? {} : load.call(this, request, ...rest); };
const { Board } = require("../out/board");
Module._load = load;
const worker = require("../out/worker");
const { AcpSession } = require("../out/acp");
const { helperTabStub } = require("./helper-tab-stub");

const FAKE = path.join(__dirname, "fake-acp.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-ext-acp-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
const LOG = path.join(root, "fake-acp.log");
const CLAUDE = { name: "me@example.test", configDir: path.join(root, "claude-me") };
const GROK = { name: "Grok · Work", provider: "grok", configDir: path.join(root, "grok-work") };
const starts = [];
worker.acpHelper.start = (provider, cwd, grokHome, onUpdate, onPermission, env) => {
  starts.push({ provider, grokHome });
  return new AcpSession(spawn(process.execPath, [FAKE], { cwd, env: { ...env, FAKE_ACP_PROVIDER: provider, FAKE_ACP_LOG: LOG }, windowsHide: true }), onUpdate, onPermission);
};
const prompts = () => { try { return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.method === "session/prompt"); } catch { return []; } };

function fixture() {
  const messages = [], notices = [], stub = helperTabStub(), tabs = stub.tabs;
  const forbid = (what) => () => { throw new Error(`This test must not ${what}.`); };
  const disposable = { dispose() {} };
  const vscode = {
    Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join("/") }) },
    ProgressLocation: { Notification: 15 },
    workspace: { onDidChangeConfiguration: () => disposable, getConfiguration: () => ({ get: (key, fallback) => fallback }) },
    window: { showErrorMessage: forbid("show an error"), showWarningMessage: async (m) => { notices.push(["warning", m]); }, showInformationMessage: async (m) => { notices.push(["info", m]); },
      setStatusBarMessage: (m) => (notices.push(["status", m]), disposable),
      withProgress: async (options, run) => { notices.push(["progress", options.title]); return run({ report: (r) => notices.push(["step", r.message]) }, { isCancellationRequested: false, onCancellationRequested: () => disposable }); } },
  };
  const modules = {
    vscode,
    child_process: { execFile: forbid("launch a process"), execFileSync: forbid("launch a process"), spawn: forbid("launch a process") },
    "./board": { accounts: () => [CLAUDE, GROK] },
    // A Claude IDE default exists: the helpers must still not use it for a Grok account.
    "./accounts": { accountRows: () => [], activeConfigDir: () => CLAUDE.configDir, onAccountsChanged: () => disposable },
    "./codex": { codexAccounts: () => [], codexBinary: () => "/fake/codex", codexTextPath: () => "/fake/codex", codexModels: () => [] },
    "./sessions": { DEFAULT_DIR: path.join(root, ".claude"), otherAccountDirs: (dir) => [`other-than:${dir}`] },
    "./refine-context": { refinementContext: () => "" },
    "./jobs": { projectInventory: () => undefined, projectContext: () => ({}) },
    "./checks": { limitToCatalogue: (commands) => ({ kept: commands, refused: [] }), readCatalogue: () => undefined },
    "./prompt-lint": require("../out/prompt-lint"),
    "./handoffs": require("../out/handoffs"), // Refine draft's handoff detection (plan 70d079 step 4)
    "./text-actions": require("../out/text-actions"),
    "./compile": require("../out/compile"),
    "./helper-tab": stub.module,
  };
  const filename = require.resolve("../out/extension.js");
  const extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = (name) => {
    if (name in modules) return modules[name];
    if (name === "./obsidian-board") return { obsidianSnapshot: () => undefined, contextSource: () => "asana" };
    if (name === "./error-log") return require("../out/error-log.js"); // F103: the Review and Finish error log, in the board's folder
    if (name === "./cardTerminal") return require(path.join(path.dirname(filename), name));
    if (name === "./profiles") return require("../out/profiles.js"); // pure: capability profiles (phase 2)
    if (name === "./models") return require("../out/models.js"); // pure: helper names with their version (F123)
    if (name.startsWith("./")) return {};
    return require(name);
  };
  extension._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.BoardViewForTest = BoardView; module.exports.autoTitleForTest = autoTitle; module.exports.prepareRuleForTest = prepareRule; module.exports.applyGeneratedTitleForTest = applyGeneratedTitle;\n", filename);
  const tasks = [];
  const board = { repo: path.join(root, "repo"), tasks, dir: path.join(root, "board"), get: (id) => tasks.find((t) => t.id === id), onChange: () => disposable,
    accountList: () => [CLAUDE, GROK], configDirOf: Board.prototype.configDirOf, update: (t, patch) => Object.assign(t, patch) };
  const view = new extension.exports.BoardViewForTest({ path: "/ext" }, board);
  let receive; const disposers = [];
  view.resolveWebviewView({
    webview: { cspSource: "csp", asWebviewUri: (uri) => uri.path, postMessage: async (m) => { messages.push(m); }, onDidReceiveMessage: (cb) => { receive = cb; return disposable; } },
    onDidDispose: (cb) => { disposers.push(cb); return disposable; },
  });
  return { send: (m) => receive(m), messages, notices, tabs, board, tasks, ext: extension.exports, close: () => disposers.forEach((d) => d()) };
}

test("Refine draft and Improve prompt on a Grok account run on that account's ACP agent with its default model", async () => {
  const f = fixture();
  try {
    let before = starts.length;
    await f.send({ type: "refine", requestId: "r1", draft: "Fix the login test", account: GROK.name, model: "fake-model-b", effort: "fake-high" });
    const refined = f.messages.find((m) => m.refinement)?.refinement;
    assert.equal(refined.error, undefined, refined.error);
    assert.deepEqual([refined.kind, refined.revision, refined.model], ["revision", "Refined by fake grok.", "fake-model-a"], "the agent's default model answered");
    assert.deepEqual(starts.slice(before), [{ provider: "grok", grokHome: GROK.configDir }], "the job reached the Grok account's ACP path, in its own profile");
    assert.equal(f.tabs[0].run.detail, "Uses the agent's default model · Grok · Work");
    before = starts.length;
    await f.send({ type: "compile", requestId: "c1", draft: "Explain the test.", account: GROK.name });
    const compiled = f.messages.find((m) => m.compilation)?.compilation;
    assert.equal(compiled.error, undefined, compiled.error);
    assert.equal(compiled.record.outcome.goal, "Explain the test.");
    assert.deepEqual(starts.slice(before), [{ provider: "grok", grokHome: GROK.configDir }]);
    assert.match(prompts().at(-1).params.prompt[0].text, /EXECUTOR:\nA new Grok CLI session/);
  } finally { f.close(); }
});

test("the automatic title and the completion rule of a Grok task run on its own Grok account", async () => {
  const f = fixture();
  try {
    const task = { id: "abc123", title: "fix the login test", prompt: "Fix the login test in auth.spec.ts", account: GROK.name, provider: "grok", configDir: GROK.configDir };
    f.tasks.push(task);
    let before = starts.length;
    await f.ext.autoTitleForTest(f.board, task);
    assert.deepEqual([task.title, task.named], ["Fake grok title", true]);
    assert.deepEqual(starts.slice(before), [{ provider: "grok", grokHome: GROK.configDir }]);
    assert.ok(f.notices.some(([k, m]) => k === "status" && m === "Entomatical: naming the task with Grok · Work…"));
    before = starts.length;
    const r = await f.ext.prepareRuleForTest(f.board, "Make npm test pass.", GROK.name, false);
    assert.deepEqual(r.completion, { commands: [], doneWhen: "The fake check passes.", goal: "The fake goal is reached.", writer: "fake-model-a", effort: "default", promptVersion: "done-when-2026-11-08" });
    assert.match(r.prompt, /Done when \(added by Entomatical\)/);
    assert.deepEqual(starts.slice(before), [{ provider: "grok", grokHome: GROK.configDir }]);
    assert.ok(f.notices.some(([k, m]) => k === "progress" && m === "Entomatical: Done when, the agent's default model on Grok · Work"));
    assert.ok(!f.notices.some(([, m]) => /Fable|Haiku/.test(m ?? "")), "nothing says Claude wrote it");
  } finally { f.close(); }
});

test("Generate title on a started Grok or Antigravity card renames only the board title, never through Claude's saved-session path", async () => {
  const f = fixture();
  try {
    const forbid = (what) => () => { throw new Error(`Generate title must not ${what} for an ACP card.`); };
    Object.assign(f.board, { isOwner: () => true, nameThread: async () => false, terminal: forbid("send /rename to a terminal"), transcriptOf: forbid("read a Claude transcript") });
    for (const provider of ["grok", "antigravity"]) {
      const task = { id: `t-${provider}`, title: "old", prompt: "p", account: GROK.name, provider, sessionId: `${provider}-session`, status: "review", worktree: f.board.repo };
      f.tasks.push(task);
      await f.ext.applyGeneratedTitleForTest(f.board, task, "New board title");
      assert.deepEqual([task.title, task.named, task.sessionId], ["New board title", true, `${provider}-session`]);
    }
  } finally { f.close(); }
});