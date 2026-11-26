const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// Exercise the real card action without starting providers or touching any live board.
function fixture({ panel = false, terminal = false } = {}) {
  const calls = [], task = { id: "task", title: "Task", sessionId: "thread", status: "review", interrupted: true, worktree: "/wt" };
  const vscode = {
    TabInputWebview: class {},
    workspace: { getConfiguration: () => ({ get: (key) => key === "claudeProcessWrapper" && panel
      ? path.join(os.homedir(), ".entomatical", process.platform === "win32" ? "entomatical-claude.exe" : "entomatical-claude") : undefined }) },
    window: { tabGroups: { all: [], close: async () => {} } },
  };
  const filename = require.resolve("../out/extension.js"), extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = (name) => name === "vscode" ? vscode : name === "./sessions" ? { DEFAULT_DIR: "/history" } : name === "./profiles" ? require("../out/profiles.js") : name.startsWith("./") ? {} : require(name);
  extension._compile(fs.readFileSync(filename, "utf8") + '\nmodule.exports.action = handle; module.exports.pending = resuming;\n', filename);
  const term = { show: () => calls.push("focus-terminal") };
  const board = {
    tasks: [task], external: new Map(), get: () => task,
    mustOwn() {}, refresh() {}, reconcile() {}, resetUnstarted: () => false,
    terminal: () => terminal ? term : undefined, canResumeInPanel: () => true,
    live: () => terminal ? [task.id] : [],
    waitingToStart: () => false,
    update(t, patch) { Object.assign(t, patch); },
    openInCodex: async () => calls.push("focus-editor"),
    openInPanel: async (...args) => calls.push(["panel", ...args.slice(1)]),
    continueTask: async (_task, openPanel) => { calls.push("continue"); if (openPanel) await openPanel(); },
  };
  return { board, task, calls, pending: extension.exports.pending, resume: () => extension.exports.action(board, { type: "resume", id: task.id }) };
}

test("Resume reconciles a stale card and only focuses a session already working or awaiting input", async () => {
  for (const status of ["running", "needs-input"]) {
    const f = fixture({ terminal: true });
    f.board.reconcile = () => Object.assign(f.task, { status, interrupted: undefined });
    await f.resume();
    assert.deepEqual(f.calls, ["focus-terminal"]);
    assert.equal(f.pending.size, 0);
  }
});

test("Resume prevents duplicate dispatch, keeps pending until acknowledgement, and unlocks after rejection", async () => {
  const f = fixture();
  let finish;
  f.board.continueTask = () => { f.calls.push("continue"); return new Promise((resolve) => { finish = resolve; }); };
  const first = f.resume();
  await f.resume();
  assert.deepEqual(f.calls, ["continue"]);
  assert.equal(f.pending.has(f.task.id), true);
  finish(); await first;
  assert.equal(f.pending.size, 0);
  f.board.continueTask = async () => { throw new Error("not accepted"); };
  await assert.rejects(f.resume(), /not accepted/);
  assert.equal(f.pending.size, 0);
  assert.equal(f.task.interrupted, true, "failed dispatch never claims the card resumed");
});

test("Resume only focuses a terminal waiting for setup, so it cannot type into a menu", async () => {
  const f = fixture({ terminal: true });
  f.board.waitingToStart = () => true;
  await f.resume();
  assert.deepEqual(f.calls, ["focus-terminal"]);
});

test("Claude panel Resume supplies the continuation to the native editor open command", async () => {
  const f = fixture({ panel: true });
  await f.resume();
  assert.deepEqual(f.calls, ["continue", ["panel", process.env.CLAUDE_CONFIG_DIR || "/history", "Resume."]]);
});
