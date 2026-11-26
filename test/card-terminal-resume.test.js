// Card faebc2 (6 November 2026): an in-card terminal interrupted by Stop, its process exiting or a window reload keeps its
// card, and Resume starts a new terminal on the same card and worktree. Fake PTY only; no provider CLI runs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync, spawn } = require("node:child_process");
require("./safe-temp").assertSafeTemp();

class VSCodeEvent {
  listeners = [];
  event = (fn) => (this.listeners.push(fn), { dispose() {} });
  fire(value) { this.listeners.forEach((fn) => fn(value)); }
  dispose() {}
}
const vscode = { EventEmitter: VSCodeEvent, ThemeIcon: class {},
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }),
    showWarningMessage: async () => undefined, showInformationMessage: async () => undefined } };
const load = Module._load;
Module._load = function (request, ...args) { return request === "vscode" ? vscode : load.call(this, request, ...args); };
const { Board, CARD_TERMINAL_RESUME_NOTE, cardTerminalTurnNote } = require("../out/board.js");
const CARD_TERMINAL_TURN_NOTE = cardTerminalTurnNote(path.join(os.homedir(), ".entomatical", "board.js")); // Board's default boardCli
const { NOT_RUNNING_BOARD } = require("../out/cardTerminal.js");

function repoFor(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-ct-resume-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  // This hook runs before the tests' own board.dispose() hooks (node:test runs after hooks in order), and one that throws skips
  // the rest: the boards were left with their poll timers and the file never ended (16 November 2026). So dispose them here first.
  t.after(() => {
    for (const board of boards.get(repo) ?? []) board.dispose();
    boards.delete(repo);
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return repo;
}
/** Every board made on a test repo, disposed before the repo is deleted. */
const boards = new Map();
/** A board as one window has it, with a fake PTY recording every spawn. */
function windowOn(repo) {
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  boards.set(repo, [...(boards.get(repo) ?? []), board]);
  board.accountList = () => [{ name: "Grok · Work", provider: "grok", configDir: path.join(repo, "grok") }];
  board.accountFolderList = () => [];
  board.grokModels = async () => ({ ids: ["grok-4.7"], default: "grok-4.7" }); // the exact id the terminal gets (no CLI is run)
  const spawns = [];
  board.cardTerminals.spawn = (file, args, options) => {
    const proc = { pid: 999, onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; }, write() {}, resize() {}, kill() {} };
    spawns.push({ file, args, options, proc });
    return proc;
  };
  return { board, spawns };
}
const state = (board, task) => board.cardTerminals.attach(task.id)?.state;

async function resumes(board, spawns, task, worktree) {
  const before = spawns.length, generation = board.cardTerminals.attach(task.id)?.generation;
  await board.startCardTerminal(task, true);
  assert.equal(spawns.length, before + 1, "Resume starts a new terminal");
  assert.equal(board.get(task.id), task, "the same card");
  assert.equal(task.worktree, worktree, "the same worktree");
  assert.equal(spawns.at(-1).options.cwd, worktree);
  assert.deepEqual(spawns.at(-1).args, ["--model=grok-4.7", "--permission-mode=bypassPermissions", "--", `${CARD_TERMINAL_RESUME_NOTE}\n\nInvestigate.\n\n${CARD_TERMINAL_TURN_NOTE}`]); // F88: a card with no permission runs Grok on its most permissive mode
  assert.equal(task.status, "running");
  assert.equal(task.interrupted, undefined);
  assert.equal(task.cardTerminalStarted, true);
  assert.equal(board.live().includes(task.id), true);
  assert.notEqual(board.cardTerminals.attach(task.id).generation, generation, "a new terminal generation");
}

test("an in-card terminal stopped by Stop keeps its card and Resume continues it", async (t) => {
  const repo = repoFor(t), { board, spawns } = windowOn(repo);
  t.after(() => board.dispose());
  board.tick();
  const task = board.add("Task", "Investigate.", "Grok · Work");
  await assert.rejects(board.startCardTerminal(task, true), /no terminal to resume/);
  await board.startCardTerminal(task);
  const worktree = task.worktree;
  board.stop(task);
  spawns.at(-1).proc.exit({ exitCode: 1 });
  assert.equal(task.status, "review");
  assert.equal(task.interrupted, true);
  assert.equal(state(board, task), "exited", "the ended terminal still attaches, it does not report a lost board");
  await resumes(board, spawns, task, worktree);
});

test("deleting a card detaches its session while a late PTY exit belongs only to the original handle", async (t) => {
  const repo = repoFor(t), { board, spawns } = windowOn(repo);
  const accounts = [...board.accountList(), { name: "Claude", configDir: path.join(repo, "claude") }];
  board.accountList = () => accounts;
  board.tick();
  const original = board.add("First", "Work.", "Claude", undefined, undefined, undefined, undefined, { cardTerminal: true });
  board.update(original, { sessionId: "fixture-session", worktree: repo });
  const term = board.launch(original, false), first = spawns.at(-1).proc;
  board.remove(original);
  assert.equal(board.get(original.id), undefined);
  assert.equal(term.exitStatus, undefined);

  const replacement = board.add("Second", "Investigate.", "Grok · Work");
  board.update(replacement, { id: original.id });
  assert.equal(board.terminal(replacement), undefined, "the old session cannot receive replacement input");
  await board.startCardTerminal(replacement);
  first.exit({ exitCode: 17 });
  assert.equal(term.exitStatus.code, 17);
  assert.equal(replacement.status, "running");
  assert.equal(replacement.interrupted, undefined);
  assert.equal(state(board, replacement), "running");
  spawns.at(-1).proc.exit({ exitCode: 0 });
  assert.equal(replacement.status, "review");
  await board.deliveries;
});

test("an in-card terminal whose process exits keeps its card and Resume continues it", async (t) => {
  const repo = repoFor(t), { board, spawns } = windowOn(repo);
  t.after(() => board.dispose());
  board.tick();
  const task = board.add("Task", "Investigate.", "Grok · Work");
  await board.startCardTerminal(task);
  const worktree = task.worktree;
  spawns.at(-1).proc.exit({ exitCode: 0 });
  assert.equal(task.status, "review");
  assert.equal(task.interrupted, true);
  await resumes(board, spawns, task, worktree);
  await assert.rejects(board.startCardTerminal(task, true), /already running/);
});

test("after a window reload the card waits for this window to own the board, then Resume continues it", async (t) => {
  const repo = repoFor(t);
  const first = windowOn(repo);
  first.board.tick();
  const task = first.board.add("Task", "Investigate.", "Grok · Work");
  await first.board.startCardTerminal(task);
  const worktree = task.worktree;
  // Reload: the old extension host is disposed (its PTY dies with it) while its process and fresh heartbeat linger a moment.
  const oldHost = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => oldHost.kill());
  first.board.dispose();
  fs.writeFileSync(path.join(repo, ".entomatical", "owner.json"), JSON.stringify({ pid: oldHost.pid, at: Date.now() }));
  const { board, spawns } = windowOn(repo);
  t.after(() => board.dispose());
  board.tick();
  const card = board.get(task.id);
  assert.ok(card, "the card is still on the board");
  assert.equal(card.cardTerminalStarted, true);
  // The webview's attach is refused for now with the reason, not "no longer owns": card-terminal.js asks again on its next render.
  assert.throws(() => board.cardTerminals.attach(card.id), (e) => e.message === NOT_RUNNING_BOARD);
  await assert.rejects(board.startCardTerminal(card, true), /Another VS Code window/);
  oldHost.kill();
  await new Promise((resolve) => oldHost.exitCode !== null || oldHost.signalCode ? resolve() : oldHost.once("exit", resolve));
  board.tick(); // takes the board over, reloading tasks.json
  assert.equal(board.cardTerminals.attach(card.id), undefined, "attaches once this window owns the board; no terminal survived the reload");
  // The interrupted run is recorded once the reload's grace period has passed (discover's 10 s rule for a restarting process).
  board.get(task.id).updatedAt = new Date(Date.now() - 11_000).toISOString();
  board.tick();
  const owned = board.get(task.id);
  assert.equal(owned.status, "review");
  assert.equal(owned.interrupted, true);
  await resumes(board, spawns, owned, worktree);
});

// 18 November 2026: typing in a card terminal lagged. Each key and each output chunk read and rewrote owner.json.
test("typing and output in a card terminal do not touch owner.json each time; another window's takeover still stops them", async (t) => {
  const repo = repoFor(t), { board, spawns } = windowOn(repo);
  t.after(() => board.dispose());
  board.tick();
  const task = board.add("Task", "Investigate.", "Grok · Work");
  await board.startCardTerminal(task);
  const { generation } = board.cardTerminals.attach(task.id), proc = spawns.at(-1).proc;
  const written = [];
  proc.write = (data) => written.push(data);
  let checks = 0;
  const isOwner = board.isOwner.bind(board);
  board.isOwner = (...args) => (checks++, isOwner(...args));
  for (let i = 0; i < 200; i++) { board.cardTerminals.input(task.id, generation, "x"); proc.data("x"); }
  assert.equal(written.length, 200, "every key reached the program");
  assert.ok(checks <= 1, `owner.json was checked ${checks} times for 200 keys and 200 output chunks`);
  // Another window owns the board now: the next tick sees it and nothing more is accepted.
  fs.writeFileSync(path.join(repo, ".entomatical", "owner.json"), JSON.stringify({ pid: process.ppid, at: Date.now() }));
  board.tick();
  assert.throws(() => board.cardTerminals.input(task.id, generation, "y"), (e) => e.message === NOT_RUNNING_BOARD);
});

test("the board's CSP lets xterm's colour style attributes through and nothing else inline", () => {
  const { BOARD_CSP } = require("../out/cardTerminal.js");
  const csp = BOARD_CSP("vscode-csp", "abc");
  assert.match(csp, /style-src-attr 'unsafe-inline'/);
  assert.match(csp, /style-src vscode-csp 'nonce-abc';/);
  assert.match(csp, /script-src 'nonce-abc';/);
  assert.equal((csp.match(/unsafe-inline/g) ?? []).length, 1);
  // Why: xterm 6 draws a 24-bit colour as a style attribute on the cell. If an upgrade stops doing that, this rule can go.
  const xterm = fs.readFileSync(require.resolve("@xterm/xterm/lib/xterm.js"), "utf8");
  assert.match(xterm, /_addStyle\(\w,\w\)\{\w\.setAttribute\("style"/);
});
