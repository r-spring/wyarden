// More → Switch account (and Start's ownership check), driven through the extension's real message handler with stand-ins for VS Code and the account modules.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const HOME = path.resolve("/home-test");
const DIRS = { main: "", alternate: path.join(HOME, ".claude-accounts", "alternate"), organization: path.join(HOME, ".claude-accounts", "organization") };
// What this machine had on 28 October 2026: ~/.claude and alternate both logged into one email, organization another, plus Codex.
const ACCOUNTS = [
  { name: "personal@example.com (~/.claude)", configDir: DIRS.main },
  { name: "personal@example.com (alternate)", configDir: DIRS.alternate },
  { name: "team@example.com", configDir: DIRS.organization },
  { name: "Codex · team@example.com", configDir: "", provider: "codex" },
];
const ROWS = [
  { configDir: DIRS.main, loggedIn: true, email: "personal@example.com", plan: "max", usage: { fiveHour: 100, week: 49 } },
  { configDir: DIRS.alternate, loggedIn: true, email: "personal@example.com", plan: "max", usage: { fiveHour: 100, week: 50 } },
  { configDir: DIRS.organization, loggedIn: true, email: "team@example.com", plan: "max", usage: { fiveHour: 4, week: 25 } },
  { configDir: path.join(HOME, ".codex"), provider: "codex", loggedIn: true, email: "team@example.com", usage: { week: 20 } },
];

// listed: session ids the CLI lists as live (sessions/<pid>.json), which includes the board's own terminals. exits: a stopped session
// leaves that list once its process exits and the board rescans; false = it never does.
// owner: false is a window that does not hold the board, where the real switchAccount refuses (mustOwn). panelDeclined: false leaves
// the profile unanswered on "Open Entomatical tasks in the Claude Code panel?", so Start would ask it.
// tabs: editor tabs as { label, viewType } (a webview's viewType, as VS Code reports it); closed ones are logged in order with the runs.
// others: the board's other cards (their titles matter to which Claude tab is this card's).
function fixture({ task, pick, answer, configDirOf, running = false, listed = [], exits = true, owner = true, panelDeclined = true, tabs = [], others = [], realBoard }) {
  const log = { picks: undefined, pickOptions: undefined, warnings: [], errors: [], switched: [], ran: [], infos: [], stopped: 0, killed: 0, rescans: 0, order: [], dialogs: 0 };
  class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
  const group = { tabs: tabs.map((t) => ({ label: t.label, input: new TabInputWebview(t.viewType) })) };
  const vscode = {
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    TabInputWebview,
    window: {
      showQuickPick: async (items, options) => { log.picks = items; log.pickOptions = options; log.dialogs++; return pick && items.find(pick); },
      showOpenDialog: async () => { log.dialogs++; return undefined; },
      showInputBox: async () => { log.dialogs++; return undefined; },
      showWarningMessage: async (message, options, ...buttons) => { log.warnings.push({ message, detail: options?.detail, buttons }); return answer; },
      showErrorMessage: (m) => { log.errors.push(m); }, showInformationMessage: async (m) => { log.infos.push(m); },
      tabGroups: { all: [group], close: async (tab) => { group.tabs = group.tabs.filter((t) => t !== tab); log.order.push(["closed", tab.label]); return true; } },
    },
  };
  const stubs = {
    "./board": { Board: class {}, accounts: () => ACCOUNTS, paste: (t) => t },
    "./accounts": { accountRows: () => ROWS, rescan: async () => { log.rescans++; }, activeConfigDir: () => "" },
    "./sessions": { DEFAULT_DIR: path.join(HOME, ".claude"), sameFolder: (a, b) => path.resolve(a || path.join(HOME, ".claude")).toLowerCase() === path.resolve(b || path.join(HOME, ".claude")).toLowerCase() },
  };
  const filename = require.resolve("../out/extension.js");
  const extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = (name) => (name === "vscode" ? vscode : name === "./profiles" ? require("../out/profiles.js") : name.startsWith("./") ? stubs[name] ?? {} : require(name));
  extension._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.handleForTest = handle; module.exports.useStateForTest = (s) => { state = s; };\n", filename);
  extension.exports.useStateForTest({ get: (key) => key === "panelDeclined" && panelDeclined });
  let live = running;
  const board = realBoard ?? {
    tasks: [task, ...others],
    accountList: () => ACCOUNTS,
    get: (id) => (id === task.id ? task : undefined),
    configDirOf: configDirOf ?? (() => { throw new Error(`Account ${task.account} is not available.`); }),
    own: () => (live ? [task.id] : []),
    live: () => (live ? [task.id] : []),
    refresh() {}, reconcile() {},
    waitingToStart: () => false,
    external: new Map(listed.map((id) => [id, { sessionId: id, pid: 1 }])),
    terminal: () => undefined,
    stop: () => { log.stopped++; live = false; },
    killSession: (t) => { log.killed++; board.external.delete(t.sessionId); return true; },
    ended: async () => { if (exits) board.external.delete(task.sessionId); return !live && !board.external.has(task.sessionId); },
    resetUnstarted: () => false,
    mustOwn: () => { if (!owner) throw new Error("Another VS Code window runs this repo's board."); },
    canSwitch: (t, name) => !!t.sessionId && ACCOUNTS.find((a) => a.name === name).provider !== t.provider, // the real one's refusals: see the real-Board test below
    switchAccount: (t, name) => { board.mustOwn(); log.switched.push(name); const other = ACCOUNTS.find((a) => a.name === name).provider !== t.provider; return t.sessionId && !other ? "resume" : "start"; },
    resume: async (t) => { log.ran.push(["resume", t.id]); log.order.push(["resume", t.id]); return { show() {} }; },
    continueTask: async (t) => { await board.resume(t, "Resume."); },
    start: async (t) => { log.ran.push(["start", t.id]); return { show() {} }; },
  };
  return { log, board, run: (type = "switchAccount", extra = {}) => extension.exports.handleForTest(board, { type, id: task.id, ...extra }) };
}

test("Switch account works when the card's account no longer resolves, and lists every other account including Codex", async () => {
  const task = { id: "f511b5", title: "Limited", account: "[bottobot's Gmail]", sessionId: "s1", status: "review" };
  const f = fixture({ task, pick: (i) => i.label === "team@example.com" });
  await f.run();
  assert.equal(f.log.rescans, 1);
  assert.deepEqual(f.log.picks.map((i) => i.label), ACCOUNTS.map((a) => a.name)); // the unresolved account excludes nothing
  assert.match(f.log.picks.find((i) => i.label.startsWith("Codex")).description, /Codex · starts a new conversation/);
  assert.equal(f.log.picks.find((i) => i.label === "team@example.com").detail, "5-hour 4% · weekly 25%"); // a Max account whose reading has a 5-hour figure shows it (F57)
  assert.deepEqual(f.log.warnings, []); // same provider, not running: no confirmation needed
  assert.deepEqual(f.log.switched, ["team@example.com"]);
  assert.deepEqual(f.log.ran, [["resume", "f511b5"]]);
});

test("Switch account leaves out the card's own folder and warns where a folder shares its login and limit", async () => {
  const task = { id: "t2", title: "On main", account: "personal@example.com (~/.claude)", status: "queued" };
  const f = fixture({ task, configDirOf: () => DIRS.main, pick: (i) => i.label === "team@example.com" });
  await f.run();
  assert.deepEqual(f.log.picks.map((i) => i.label), ["personal@example.com (alternate)", "team@example.com", "Codex · team@example.com"]);
  assert.match(f.log.picks[0].description, /same login as this task's account, so the same limit/);
  assert.doesNotMatch(f.log.picks[1].description, /same login/);
  assert.deepEqual(f.log.ran, [["start", "t2"]]); // a queued task starts on the new account
});

test("Moving a started Claude task to Codex asks first, then starts a new session; declining changes nothing", async () => {
  const task = { id: "t3", title: "Started", account: "team@example.com", sessionId: "s3", status: "review" };
  const declined = fixture({ task, configDirOf: () => DIRS.organization, pick: (i) => i.label.startsWith("Codex"), answer: undefined });
  await declined.run();
  assert.equal(declined.log.warnings.length, 1);
  assert.deepEqual(declined.log.warnings[0].buttons, ["Start new session"]);
  assert.match(declined.log.warnings[0].detail, /Codex cannot continue this conversation, so a new Codex session starts in the same worktree/);
  assert.deepEqual(declined.log.switched, []);
  const accepted = fixture({ task, configDirOf: () => DIRS.organization, pick: (i) => i.label.startsWith("Codex"), answer: "Start new session" });
  await accepted.run();
  assert.deepEqual(accepted.log.switched, ["Codex · team@example.com"]);
  assert.deepEqual(accepted.log.ran, [["start", "t3"]]);
});

test("A running session is stopped after confirmation before it moves; a Codex card is offered only Claude accounts", async () => {
  const task = { id: "t4", title: "Running", account: "team@example.com", sessionId: "s4", status: "running" };
  const f = fixture({ task, running: true, configDirOf: () => DIRS.organization, pick: (i) => i.label === "personal@example.com (alternate)", answer: "Stop and switch" });
  await f.run();
  assert.deepEqual(f.log.warnings.map((w) => w.buttons), [["Stop and switch"]]);
  assert.equal(f.log.stopped, 1);
  assert.deepEqual(f.log.ran, [["resume", "t4"]]);
  const codexTask = { id: "t5", title: "Codex task", account: "Codex · team@example.com", provider: "codex", status: "queued" };
  const c = fixture({ task: codexTask, configDirOf: () => "", pick: () => false });
  await c.run();
  assert.deepEqual(c.log.picks.map((i) => i.label), ACCOUNTS.filter((a) => !a.provider).map((a) => a.name));
});

test("Stop and switch works on the board's own terminal, which the CLI also lists as a live session; one open elsewhere is refused", async () => {
  const task = { id: "t6", title: "Own terminal", account: "team@example.com", sessionId: "s6", status: "running" };
  const own = fixture({ task, running: true, listed: ["s6"], configDirOf: () => DIRS.organization, pick: (i) => i.label === "personal@example.com (alternate)", answer: "Stop and switch" });
  await own.run();
  assert.deepEqual(own.log.warnings.map((w) => w.buttons), [["Stop and switch"]]);
  assert.equal(own.log.stopped, 1);
  assert.deepEqual(own.log.switched, ["personal@example.com (alternate)"]);
  assert.deepEqual(own.log.ran, [["resume", "t6"]]);
  // A process that never exits: a clear error, and the account is not changed.
  const stuck = fixture({ task, running: true, listed: ["s6"], exits: false, configDirOf: () => DIRS.organization, pick: (i) => i.label === "personal@example.com (alternate)", answer: "Stop and switch" });
  await assert.rejects(stuck.run(), /did not end within 10 seconds/);
  assert.deepEqual(stuck.log.switched, []);
  // Listed but not the board's own (a Claude panel or another window): refused before any confirmation.
  const elsewhere = fixture({ task, listed: ["s6"], configDirOf: () => DIRS.organization, pick: (i) => i.label === "personal@example.com (alternate)", answer: "Stop and switch" });
  await assert.rejects(elsewhere.run(), /open in another window/);
  assert.deepEqual([elsewhere.log.warnings, elsewhere.log.stopped, elsewhere.log.switched], [[], 0, []]);
});

// the user, 30 October 2026: picking the account is enough. A session open in this window's Claude panel (its CLI is a descendant of this
// extension host) is ended by the board after "Stop and switch", and the task resumes on the new account, in the panel when it is on.
test("Switch account ends a session open in this window's Claude panel itself, then resumes the task on the new account", async () => {
  const task = { id: "t7", title: "In the panel", account: "team@example.com", sessionId: "s7", status: "review", panel: true };
  const f = fixture({ task, listed: ["s7"], configDirOf: () => DIRS.organization, pick: (i) => i.label === "personal@example.com (alternate)", answer: "Stop and switch" });
  f.board.external.set("s7", { sessionId: "s7", pid: process.pid }); // this process stands in for the panel's CLI: its ancestry includes the extension host
  await f.run();
  assert.deepEqual(f.log.warnings.map((w) => w.buttons), [["Stop and switch"]]);
  assert.match(f.log.warnings[0].detail, /Claude panel is ended first/);
  assert.deepEqual([f.log.killed, f.log.stopped], [1, 0]);
  assert.deepEqual(f.log.switched, ["personal@example.com (alternate)"]);
  assert.deepEqual(f.log.ran, [["resume", "t7"]]);
  // Declining leaves the session running and the account unchanged.
  const no = fixture({ task, listed: ["s7"], configDirOf: () => DIRS.organization, pick: (i) => i.label === "personal@example.com (alternate)", answer: undefined });
  no.board.external.set("s7", { sessionId: "s7", pid: process.pid });
  await no.run();
  assert.deepEqual([no.log.killed, no.log.switched, no.log.ran], [0, [], []]);
});

// Seen on Windows, 31 October 2026 (Claude Code 2.1.314): the extension keeps one tab per session, and opening a session whose tab is
// still there only reveals that tab. After "Stop and switch" the old tab stayed with "Claude Code process exited with code 1" and
// nothing resumed until a message was typed there. The board now closes that tab once its session has ended, so the resume opens a
// new tab, which resumes at once on the new account. Only a single Claude tab with the session's title is closed (Claude shortens
// titles over 25 characters to 24 and "…"); none is closed when it is ambiguous.
test("Switch account closes the ended panel session's own Claude tab before resuming, so a new tab resumes on the new account", async () => {
  const title = "Panel task with a rather long title";
  const task = { id: "t8", title, account: "team@example.com", sessionId: "s8", status: "review", panel: true };
  const claude = "mainThreadWebview-claudeVSCodePanel";
  const tabs = [{ label: "Panel task with a rather…", viewType: claude }, { label: "Another session", viewType: claude },
    { label: "Panel task with a rather…", viewType: "mainThreadWebview-markdown.preview" }];
  const f = fixture({ task, listed: ["s8"], configDirOf: () => DIRS.organization, pick: (i) => i.label === "personal@example.com (alternate)", answer: "Stop and switch", tabs });
  f.board.external.set("s8", { sessionId: "s8", pid: process.pid });
  await f.run();
  assert.equal(f.log.killed, 1);
  assert.deepEqual(f.log.order, [["closed", "Panel task with a rather…"], ["resume", "t8"]]);
  // Two Claude tabs that could be this session's: neither is closed, and the task still resumes.
  const twice = fixture({ task, listed: ["s8"], configDirOf: () => DIRS.organization, pick: (i) => i.label === "personal@example.com (alternate)", answer: "Stop and switch",
    tabs: [{ label: title.slice(0, 24) + "…", viewType: claude }, { label: title, viewType: claude }] });
  twice.board.external.set("s8", { sessionId: "s8", pid: process.pid });
  await twice.run();
  assert.deepEqual(twice.log.order, [["resume", "t8"]]);
  // A running terminal session has no Claude tab to close.
  const term = fixture({ task: { ...task, panel: undefined }, running: true, configDirOf: () => DIRS.organization, pick: (i) => i.label === "personal@example.com (alternate)", answer: "Stop and switch",
    tabs: [{ label: title, viewType: claude }] });
  await term.run();
  assert.deepEqual(term.log.order, [["resume", "t8"]]);
});

test("Switch account in a window that does not hold the board refuses before stopping anything", async () => {
  const task = { id: "t7", title: "Running elsewhere-owned", account: "team@example.com", sessionId: "s7", status: "running" };
  const f = fixture({ task, running: true, owner: false, configDirOf: () => DIRS.organization, pick: (i) => i.label === "personal@example.com (alternate)", answer: "Stop and switch" });
  await assert.rejects(f.run(), /Another VS Code window runs this repo's board/);
  // Before: "Stop and switch" ended the session, waited for it, and only then switchAccount refused.
  assert.deepEqual([f.log.stopped, f.log.switched, f.log.ran], [0, [], []]);
});

// F45, found on Windows on 31 October 2026: Start asked VS Code's panel question first and was refused only after, so Use panel in a
// window that does not own the board set that profile's claudeCode.claudeProcessWrapper and then started nothing.
test("Delete in a window that does not hold the board refuses before asking to confirm (F45)", async () => {
  const task = { id: "t9", title: "Delete elsewhere-owned", account: "team@example.com", status: "queued" };
  const f = fixture({ task, owner: false });
  await assert.rejects(f.run("delete"), /Another VS Code window runs this repo's board/);
  assert.deepEqual(f.log.warnings, []);
});

// F45 review, 4 November 2026: each of these asked a question, opened a dialog or ran a long Fable call before the refusal.
test("Merge, Discard, Add task with the Fable rule, Accept/close result and Approve scope in a window that does not hold the board refuse before any dialog", async () => {
  const task = { id: "t10", title: "Elsewhere-owned", account: "team@example.com", status: "review", branch: "task/t10", worktree: "/nowhere",
    workflow: { attempt: "a1", outcome: "pending", resources: [], scope: { operations: ["read"], sources: [], destinations: [], toolVersion: "1", bounds: "b" } } };
  for (const [type, extra] of [["merge"], ["discard"], ["create", { prompt: "p", autoRule: true }], ["closeStep"], ["approveScope"]]) {
    const f = fixture({ task, owner: false, answer: "Merge" });
    await assert.rejects(f.run(type, extra), /Another VS Code window runs this repo's board/, type); // before: a dialog first, or (create) a TypeError from the Fable call's stand-in
    assert.deepEqual([f.log.warnings, f.log.dialogs], [[], 0], type);
  }
});

test("Switch account offers a found Claude session only Claude accounts: it cannot change provider", async () => {
  const task = { id: "t11", title: "Found", account: "team@example.com", sessionId: "s11", status: "review", adopted: true };
  const f = fixture({ task, configDirOf: () => DIRS.organization, pick: () => false });
  await f.run();
  assert.deepEqual(f.log.picks.map((i) => i.label), ["personal@example.com (~/.claude)", "personal@example.com (alternate)"]); // before: Codex too, then refused after any Stop
});

test("Switch account closes a Claude tab only when its label fits this card's title and no other card's; otherwise it says to close it", async () => {
  const task = { id: "t12", title: "Fix the login page header", account: "team@example.com", sessionId: "s12", status: "review", panel: true };
  const claude = "mainThreadWebview-claudeVSCodePanel";
  const tabs = [{ label: "Fix the login page header", viewType: claude }];
  const base = { task, listed: ["s12"], configDirOf: () => DIRS.organization, pick: (i) => i.label === "personal@example.com (alternate)", answer: "Stop and switch", tabs };
  // A shortened label that also fits another card's title could be that card's session: closing it would end that session.
  const shared = fixture({ ...base, tabs: [{ label: "Fix the login page heade…", viewType: claude }], others: [{ id: "o1", title: "Fix the login page header colours", sessionId: "so1" }] });
  shared.board.external.set("s12", { sessionId: "s12", pid: process.pid });
  shared.board.external.set("so1", { sessionId: "so1", pid: process.pid }); // that card's session is live: the tab could be its
  await shared.run();
  assert.deepEqual(shared.log.order, [["resume", "t12"]]); // before: closed
  assert.match(shared.log.infos.join("\n"), /close the old Claude tab of "Fix the login page header" yourself/);
  // A panel card whose session already died: its lingering tab is closed too, so the resume opens a new tab.
  const dead = fixture({ ...base, listed: [] });
  await dead.run();
  assert.deepEqual(dead.log.order, [["closed", "Fix the login page header"], ["resume", "t12"]]); // before: left open
  assert.deepEqual(dead.log.infos, []);
  // Another card that fits the label but has no live session cannot own the tab: closing it ends nothing, so it is closed.
  const idle = fixture({ ...base, tabs: [{ label: "Fix the login page heade…", viewType: claude }], others: [{ id: "o2", title: "Fix the login page header colours" }] });
  idle.board.external.set("s12", { sessionId: "s12", pid: process.pid });
  await idle.run();
  assert.deepEqual(idle.log.order[0], ["closed", "Fix the login page heade…"]);
});

// The stand-in board above answers canSwitch itself, which is how a refusal after the Stop slipped through: this one is the real Board.
test("Switch account against the real Board: a move it would refuse is refused before the confirmation, and the running session keeps running", async () => {
  const os = require("node:os");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-switch-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-switch-repo-"));
  const env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home; // the real board reads account folders under the home folder
  class EventEmitter { listeners = []; event = (l) => (this.listeners.push(l), { dispose() {} }); fire(e) { for (const l of this.listeners) l(e); } dispose() {} }
  const boardVscode = { EventEmitter, window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined } };
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === "vscode" ? boardVscode : load.call(this, request, ...rest); };
  let board;
  try {
    const { Board } = require("../out/board.js");
    board = new Board(repo, path.join(repo, "none", "hook.js"), path.join(repo, "hookdir"));
    const own = ACCOUNTS.find((a) => a.name === "team@example.com");
    board.accountList = () => ACCOUNTS;
    board.accountFolderList = () => [DIRS.organization];
    const task = board.add("Running here", "p", own.name);
    board.update(task, { sessionId: "s13", worktree: repo, status: "running" });
    let disposed = false;
    const term = { name: `En ${task.id}`, exitStatus: undefined, dispose: () => { disposed = true; term.exitStatus = { code: 0 }; } };
    boardVscode.window.terminals.push(term); // the board's own terminal: own() lists the task
    assert.deepEqual(board.own(), [task.id]);
    const f = fixture({ task, realBoard: board, pick: (i) => {
      if (i.label !== "personal@example.com (alternate)") return false;
      board.accountList = () => [own]; // account signed out after it was listed, before the switch
      return true;
    }, answer: "Stop and switch" });
    await assert.rejects(f.run(), /personal@example.com \(alternate\) is not signed in/);
    assert.deepEqual([f.log.warnings, disposed, task.account], [[], false, own.name]); // before: "Stop and switch" asked and the session stopped, then refused
  } finally {
    board?.dispose();
    Module._load = load;
    process.env.HOME = env.HOME; process.env.USERPROFILE = env.USERPROFILE;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Start in a window that does not hold the board refuses before asking about the Claude Code panel", async () => {
  const task = { id: "t8", title: "Queued elsewhere-owned", account: "team@example.com", status: "queued" };
  const f = fixture({ task, owner: false, panelDeclined: false });
  await assert.rejects(f.run("start"), /Another VS Code window runs this repo's board/);
  assert.deepEqual([f.log.infos, f.log.ran], [[], []]);
});
