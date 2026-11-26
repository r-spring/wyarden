// Host dialogs in src/extension.ts, run against a fake board (the same isolated loading as extension-create.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");

function fixture({ uncommitted = false, parentCommits = 0, answer, provider, namedThread = true, tabOpen = false } = {}) {
  const warnings = [], finished = [], removed = [], information = [], names = [], reopened = [], terminalsStarted = [];
  const accountCalls = [];
  const inputs = [], updates = [], commands = [];
  const accountActions = Object.fromEntries(["addGrokAccount", "grokLogIn", "openGrok", "removeGrokAccount", "addAntigravityAccount", "antigravityLogIn", "openAntigravity", "hideAntigravityAccount"]
    .map((name) => [name, (...args) => { accountCalls.push([name, ...args]); }]));
  const forbid = () => { throw new Error("This test must not launch a process."); };
  const vscode = {
    window: {
      showWarningMessage: async (message, options, ...buttons) => (warnings.push({ message, detail: options.detail, buttons }), answer),
      showInputBox: async options => { inputs.push(options); return answer; },
      showInformationMessage: async message => { information.push(message); },
    },
    commands: { executeCommand: async (...args) => { commands.push(args); } },
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
  };
  const filename = require.resolve("../out/extension.js");
  const extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = name => {
    if (name === "vscode") return vscode;
    if (name === "child_process") return { execFile: forbid, execFileSync: forbid, spawn: forbid };
    if (name === "./git") return { git: async () => "main" }; // the merge target
    if (name === "./accounts") return { ...accountActions, activeConfigDir: () => "/fixture/claude" };
    if (name === "./board") return { paste: text => `pasted: ${text}` };
    if (name === "./asana-board") return { commentOnFinish: async () => {} };
    if (name === "./obsidian-board") return { appendOnFinish: async () => {} };
    if (name === "./error-log") return require("../out/error-log.js"); // F103: the Review and Finish error log, in the board's folder
    if (name === "./profiles") return require("../out/profiles.js"); // pure: capability profiles (phase 2)
    if (name.startsWith("./")) return {};
    return require(name);
  };
  extension._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.handleForTest = handle;\n", filename);
  const task = { id: "t1", provider, title: "Card", status: "review", worktree: "/repo/.entomatical/wt/t1", branch: "task/t1", parentId: "p1" };
  const board = {
    repo: "/repo",
    isOwner: () => true,
    mustOwn() {}, // this window owns the board (Delete asks first since F45)
    update: (task, changes) => { updates.push(changes); Object.assign(task, changes); },
    nameThread: async task => { names.push(task.title); return namedThread; },
    reopenInCodex: async task => { reopened.push(task.id); return tabOpen; },
    tasks: [task],
    get: id => board.tasks.find(card => card.id === id),
    mustOwn: () => {},
    hasUncommitted: async () => uncommitted,
    parentCommits: async () => parentCommits,
    finalReply: () => undefined,
    startCardTerminal: async t => { terminalsStarted.push(t.id); },
    finish: async (t, how) => { finished.push(how); },
    remove: t => { removed.push(t.id); },
  };
  return { run: type => extension.exports.handleForTest(board, { type, id: task.id }), accountMessage: m => extension.exports.handleForTest(undefined, m), accountCalls, warnings, finished, removed, information, names, reopened, terminalsStarted, task, board, inputs, updates, commands };
}

test("account messages dispatch to their own provider, and never fall through to Claude", async () => {
  const f = fixture();
  await f.accountMessage({ type: "accountAdd", provider: "grok" });
  await f.accountMessage({ type: "accountLogin", provider: "grok", configDir: "/profile" });
  await f.accountMessage({ type: "accountOpen", provider: "antigravity" });
  await f.accountMessage({ type: "accountRemove", provider: "antigravity" });
  assert.deepEqual(f.accountCalls, [["addGrokAccount"], ["grokLogIn", "/profile"], ["openAntigravity"], ["hideAntigravityAccount"]]);
  await assert.rejects(f.accountMessage({ type: "accountUse", provider: "grok" }), /Unsupported Grok/);
  await assert.rejects(f.accountMessage({ type: "accountLogin", provider: "unknown" }), /Unknown account provider/);
});

test("Delete warns that removing the worktree throws away its uncommitted work, and keeps both choices", async () => {
  const f = fixture({ uncommitted: true, answer: "Delete card and worktree" });
  await f.run("delete");
  assert.deepEqual(f.warnings[0].buttons, ["Delete card, keep worktree", "Delete card and worktree"]);
  assert.match(f.warnings[0].detail, /uncommitted or untracked changes/);
  assert.match(f.warnings[0].detail, /"Delete card and worktree" throws them away/);
  assert.deepEqual(f.finished, ["discard"]);
  assert.deepEqual(f.removed, ["t1"]);
});

test("Delete of a clean worktree adds no warning", async () => {
  const f = fixture({ answer: "Delete card, keep worktree" });
  await f.run("delete");
  assert.equal(f.warnings[0].detail, undefined);
  assert.deepEqual(f.finished, []);
  assert.deepEqual(f.removed, ["t1"]);
});

test("dismissing Delete preserves the card and its dirty worktree", async () => {
  const f = fixture({ uncommitted: true });
  await f.run("delete");
  assert.equal(f.warnings.length, 1);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.finished, []);
});

test("Merge explains any parent commits and runs only after confirmation", async () => {
  const none = fixture();
  await none.run("merge");
  assert.doesNotMatch(none.warnings[0].message, /parent/);
  assert.deepEqual(none.finished, []);
  const some = fixture({ parentCommits: 2, answer: "Merge" });
  await some.run("merge");
  assert.match(some.warnings[0].message, /This includes its parent's commits that are not in main yet\./);
  assert.deepEqual(some.finished, ["merge"]);
});

// Codex's editor titles a tab from the thread's name only when the tab opens, so a renamed thread's open tab is reopened.
test("Codex Rename names the thread and reopens its open tab, saying so", async () => {
  const f = fixture({ provider: "codex", answer: "  Updated title  " });
  await f.run("rename");
  assert.equal(f.task.title, "Updated title");
  assert.equal(f.task.named, true);
  assert.deepEqual(f.names, ["Updated title"]);
  assert.deepEqual(f.reopened, ["t1"]);
  assert.deepEqual(f.information, ["Entomatical: Codex's thread is named “Updated title”."]);
  const open = fixture({ provider: "codex", answer: "Second title", tabOpen: true });
  await open.run("rename");
  assert.deepEqual(open.information, ["Entomatical: Codex's thread is named “Second title”, and its tab was reopened with that title."]);
});

test("Codex Rename preserves a cancelled title and does not announce an unsuccessful thread update", async () => {
  const cancelled = fixture({ provider: "codex" });
  await cancelled.run("rename");
  assert.equal(cancelled.task.title, "Card");
  assert.deepEqual(cancelled.names, []);
  assert.deepEqual(cancelled.information, []);
  const failed = fixture({ provider: "codex", answer: "Card only", namedThread: false });
  await failed.run("rename");
  assert.equal(failed.task.title, "Card only");
  assert.deepEqual(failed.names, ["Card only"]);
  assert.deepEqual(failed.information, []);
  assert.deepEqual(failed.reopened, [], "the tab is reopened only once the thread carries the new name");
});

for (const provider of ["grok", "antigravity"]) {
  for (const answer of ["  New title  ", undefined]) {
    test(`${provider} Rename ${answer ? "accepts" : "cancels"} a title on a stopped headless card`, async () => {
      const f = fixture({ provider, answer });
      Object.assign(f.task, { headless: true, sessionId: "saved-acp-session", interrupted: true });
      const unexpected = call => () => assert.fail(`ACP Rename called ${call}`);
      Object.assign(f.board, { external: { get: unexpected("external process lookup") }, terminal: unexpected("terminal"),
        openInPanel: unexpected("openInPanel"), transcriptOf: unexpected("transcriptOf") });
      await f.run("rename");
      assert.equal(f.inputs.length, 1);
      const [input] = f.inputs;
      assert.equal(input.value, "Card");
      assert.equal(input.prompt, "Rename card");
      for (const invalid of ["  ", "two\nlines", "control\x00char"]) assert.ok(input.validateInput(invalid));
      assert.equal(input.validateInput("  New title  "), undefined);
      assert.equal(f.task.title, answer ? "New title" : "Card");
      assert.deepEqual(f.updates, answer ? [{ title: "New title", named: true }] : []);
      assert.deepEqual(f.names, []);
      assert.deepEqual(f.reopened, []);
      assert.deepEqual(f.commands, []);
    });
  }
  test(`${provider} Rename works before first start and during a run`, async () => {
    for (const state of [{ status: "queued" }, { status: "running", sessionId: "active-acp-session" }]) {
      const f = fixture({ provider, answer: "New title" });
      Object.assign(f.task, state);
      await f.run("rename");
      assert.deepEqual(f.updates, [{ title: "New title", named: true }]);
      assert.deepEqual(f.names, []);
    }
  });

  for (const [change, intervene] of [
    ["provider", f => { f.task.provider = "codex"; }],
    ["account", f => { f.task.account = "Another account"; }],
    ["account folder", f => { f.task.configDir = "/other-profile"; }],
    ["session", f => { f.task.sessionId = "replacement-session"; }],
    ["board session", f => { f.task.boardSessionId = "replacement-board-session"; }],
    ["card owner", f => { f.task.openedBy = "new-parent"; }],
    ["card identity", f => { f.board.tasks = [{ ...f.task, createdAt: "later" }]; }],
    ["deletion", f => { f.board.tasks = []; }],
    ["ownership", f => { f.board.isOwner = () => false; }],
    ["title", f => { f.task.title = "Independently renamed"; }],
  ]) {
    test(`${provider} Rename preserves the board after a change to ${change} during input`, async () => {
      const f = fixture({ provider, answer: "Stale title" });
      Object.assign(f.task, { headless: true, sessionId: "saved-acp-session" });
      const pending = f.run("rename");
      assert.equal(f.inputs.length, 1);
      intervene(f);
      const expected = structuredClone(f.board.tasks);
      await assert.rejects(pending, /changed|removed|owns/i);
      assert.deepEqual(f.board.tasks, expected);
      assert.deepEqual(f.updates, []);
      assert.deepEqual(f.names, []);
      assert.deepEqual(f.reopened, []);
      assert.deepEqual(f.commands, []);
    });
  }
}

test("Claude Rename uses the saved session's panel or sends /rename to its idle terminal", async () => {
  const f = fixture({ answer: "  Terminal title  " }); // Claude cards can have no provider field.
  f.task.sessionId = "saved-claude-session";
  const panels = [], sent = [];
  f.board.external = new Map();
  f.board.terminal = () => undefined;
  f.board.openInPanel = async (task, dir) => { panels.push([task.id, dir]); };
  await f.run("rename");
  assert.deepEqual(panels, [["t1", "/fixture/claude"]]);
  assert.deepEqual(f.commands, [["claude-vscode.primaryEditor.open", f.task.sessionId], ["claude-vscode.renameSessionTab"]]);
  assert.equal(f.inputs.length, 0);

  f.board.terminal = () => ({ sendText: (...args) => sent.push(args) });
  await f.run("rename");
  assert.equal(f.inputs[0].prompt, "Rename session");
  assert.deepEqual(sent, [["pasted: /rename Terminal title", false]]);
  assert.deepEqual(f.updates, []);
});

test("starting a terminal accurately explains which earlier history is preserved", async () => {
  const acp = fixture({ provider: "grok", answer: "Start new terminal" });
  acp.task.sessionId = "old-acp";
  await acp.run("startTerminal");
  assert.match(acp.warnings[0].detail, /ACP conversation and its recorded history remain available/);
  assert.match(acp.warnings[0].detail, /does not resume it/);
  assert.deepEqual(acp.terminalsStarted, ["t1"]);

  const native = fixture({ provider: "antigravity", answer: "Start new terminal" });
  native.task.cardTerminalStarted = true;
  await native.run("startTerminal");
  assert.match(native.warnings[0].detail, /previous terminal output will be replaced/);
  assert.match(native.warnings[0].detail, /cannot verify whether the provider saved that conversation/);
  assert.doesNotMatch(native.warnings[0].detail, /history remain available/);
  assert.deepEqual(native.terminalsStarted, ["t1"]);

  const cancel = fixture({ provider: "grok" });
  cancel.task.cardTerminalStarted = true;
  await cancel.run("startTerminal");
  assert.deepEqual(cancel.terminalsStarted, []);
});
