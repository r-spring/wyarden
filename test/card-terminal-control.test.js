// F89: Claude and Codex sessions in a card terminal, and a parent card that reads and types in a descendant's terminal.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
require("./safe-temp").assertSafeTemp();

class VSCodeEvent {
  listeners = [];
  event = (fn) => (this.listeners.push(fn), { dispose() {} });
  fire(value) { this.listeners.forEach((fn) => fn(value)); }
  dispose() {}
}
const vscode = { EventEmitter: VSCodeEvent, ThemeIcon: class {}, ViewColumn: { Beside: -2 },
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), createTerminal: () => { throw new Error("a card terminal must not open a VS Code terminal"); },
    showWarningMessage: async () => undefined, showInformationMessage: async () => undefined } };
const load = Module._load;
Module._load = function (request, ...args) { return request === "vscode" ? vscode : load.call(this, request, ...args); };
const { Board } = require("../out/board.js");
const { CardTerminals } = require("../out/cardTerminal.js");
const { refusal, validateRequest, ancestorsOf } = require("../out/orchestrator.js");

function fakePty() {
  const pty = { pid: 4242, written: [], killed: 0, onData(fn) { pty.data = fn; }, onExit(fn) { pty.exit = fn; }, write(d) { pty.written.push(d); }, resize() {}, kill() { pty.killed++; } };
  return pty;
}

test("the headless screen shows what the terminal shows, and only webview key input counts as the user's", async () => {
  const pty = fakePty(), terms = new CardTerminals(() => true, () => pty);
  const typed = [];
  terms.onUserInput((e) => typed.push(e.id));
  const s = terms.spawnCommand({ id: "a", file: "claude", args: [], cwd: path.resolve("."), env: {} });
  pty.data("\u001b[2J\u001b[Hhello \u001b[31mred\u001b[0m\r\n> prompt");
  await new Promise((r) => setTimeout(r, 50)); // the headless parser writes asynchronously
  assert.deepEqual(terms.screen("a").text.split("\n"), ["hello red", "> prompt"]);
  terms.input("a", s.generation, "\u001b[?1;2c", false); // xterm's own answer to a device-attributes query
  terms.write("a", "from the board");
  assert.deepEqual(typed, []);
  terms.input("a", s.generation, "x");
  assert.deepEqual(typed, ["a"]);
  assert.deepEqual(pty.written, ["\u001b[?1;2c", "from the board", "x"]);
  const states = [];
  terms.onState((e) => states.push(e.state));
  terms.forget("a");
  assert.deepEqual(states, ["stopping"]);
  assert.equal(terms.screen("a"), undefined);
  pty.exit({ exitCode: 0 });
  assert.deepEqual(states, ["stopping", "exited"]);
  terms.dispose();
});

test("protocol: screen and type validate their fields and are for ancestors only", () => {
  const v = (raw) => validateRequest({ v: 1, by: "aaaaaa", session: "s", ...raw }, "n");
  assert.equal(v({ op: "type", id: "bbbbbb" }).error, "type needs text, keys or enter");
  assert.match(v({ op: "type", id: "bbbbbb", keys: ["alt-f4"] }).error, /keys must be/);
  assert.match(v({ op: "type", id: "bbbbbb", text: "a\u001bb" }).error, /control characters/);
  assert.deepEqual(v({ op: "type", id: "bbbbbb", text: "two\nlines", keys: ["escape"], enter: true }).request.keys, ["escape"]);
  assert.match(v({ op: "screen", id: "bbbbbb", lines: 0 }).error, /lines must be/);
  const tasks = [{ id: "aaaaaa", sessionId: "s", title: "Root" }, { id: "cccccc", parentId: "aaaaaa", title: "Mid", sessionId: "m" },
    { id: "bbbbbb", parentId: "cccccc", title: "Leaf", cardTerminal: true }, { id: "dddddd", title: "Other", sessionId: "o" }];
  assert.deepEqual(ancestorsOf(tasks[2], tasks).map((t) => t.id), ["cccccc", "aaaaaa"]);
  const ctx = { enabled: true, now: 0, lastRequestAt: new Map(), unprocessed: () => 0, capsOf: () => ({}), accountSignedIn: () => true, accountUsage: () => undefined, models: [], efforts: [], permissions: [] };
  const req = (by, session) => ({ ...v({ op: "screen", id: "bbbbbb" }).request, by, session });
  assert.equal(refusal(req("aaaaaa", "s"), tasks, ctx), undefined, "a grandparent that does not orchestrate may read it");
  assert.match(refusal(req("dddddd", "o"), tasks, ctx), /Only an ancestor/);
});

test("a Claude card terminal runs in a PTY; the user's typing reaches its parent and holds the parent's typing until it reads the screen", async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-card-control-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  board.accountList = () => [{ name: "Claude", configDir: path.join(repo, "acct") }];
  board.accountFolderList = () => [];
  board.tick();
  t.after(() => { board.dispose(); fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  let started, pty;
  board.cardTerminals.spawn = (file, args, options) => { started = { file, args, options }; return pty = fakePty(); };
  const parent = board.add("Parent", "Supervise.", "Claude");
  board.update(parent, { sessionId: "parent-session", status: "running" });
  const child = board.add("Child", "Work.", "Claude", parent.id, undefined, undefined, undefined, { cardTerminal: true });
  assert.equal(child.cardTerminal, true);
  assert.equal(board.add("Headless", "x", "Claude", undefined, undefined, undefined, undefined, { cardTerminal: true, headless: true }).cardTerminal, undefined);
  board.update(child, { sessionId: "child-session", worktree: repo });
  const term = board["launch"](child, false);
  assert.match(started.args.join(" "), /^--session-id child-session --settings .*hooks/);
  assert.equal(started.options.env.CLAUDE_CONFIG_DIR, path.join(repo, "acct"));
  assert.equal(started.options.env.ENTOMATICAL_TASK, child.id);
  assert.equal(board.terminal(child), term);
  assert.equal(board.live().includes(child.id), true);
  term.sendText("hello", false);
  assert.deepEqual(pty.written, ["hello"]);

  // A parent may type before the user has typed at all.
  assert.equal(await board.terminalType(parent, child, { keys: ["escape"], text: "new plan", enter: true }), undefined);
  assert.deepEqual(pty.written.slice(1), ["\u001b", "new plan", "\r"]);
  assert.equal(child.terminalInput.by, parent.id);

  // the user types: after 2 s quiet the card says so and the parent gets one notice; the parent's typing is held until it reads the screen.
  const gen = board.cardTerminals.attach(child.id).generation;
  board.cardTerminals.input(child.id, gen, "r");
  assert.match(await board.terminalType(parent, child, { text: "x" }), /the user typed in this card's terminal .* after you last read it/);
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(child.terminalInput.by, "you");
  assert.match(board.receiveMessages(parent.id).join("\n"), new RegExp(`the user typed in the terminal of card ${child.id}`));
  assert.equal(await board.terminalType(parent, child, { text: "y", override: true }), undefined, "--override types over him");
  const shot = board.terminalScreen(parent, child);
  assert.equal(shot.live, true);
  assert.ok(shot.userInputAt);
  assert.equal(await board.terminalType(parent, child, { text: "z" }), undefined, "read it, so it may type");

  // Stop ends the PTY; its exit closes the session like a VS Code terminal.
  board.stop(child);
  assert.equal(pty.killed, 1);
  pty.exit({ exitCode: 0 });
  assert.equal(board.terminal(child), undefined);
  assert.equal(board.live().includes(child.id), false);
  assert.match(await board.terminalType(parent, child, { text: "late" }), /no live card terminal/);
});
