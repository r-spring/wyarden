// The board's side of the orchestrator (F69 to F71, F75, F76): the task environment, status.jsonl, the live line, headless runs,
// the inbox and its refusals. Same VS Code stand-in as test/board.test.js, with what these paths touch.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

class EventEmitter {
  listeners = [];
  event = (l) => (this.listeners.push(l), { dispose() {} });
  fire(e) { for (const l of this.listeners) l(e); }
  dispose() {}
}
const terminals = []; // options of every terminal a board opened
const warnings = [], infos = [];
const commands = [];
const vscode = { EventEmitter, ThemeIcon: class {}, TabInputCustom: class { constructor(uri) { this.uri = uri; } },
  ViewColumn: { Beside: -2 },
  commands: { executeCommand: async (...args) => { commands.push(args); } },
  Uri: { from: (parts) => ({ ...parts, toString: () => `${parts.scheme}://${parts.authority}${parts.path}` }), file: (p) => ({ fsPath: p }) },
  workspace: { openTextDocument: async (o) => ({ content: o?.content }), getConfiguration: () => ({ get: (_k, d) => d }) },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async (message) => { warnings.push(message); return undefined; }, showInformationMessage: async (message) => { infos.push(message); return undefined; },
    showTextDocument: async () => undefined,
    createTerminal: (options) => { const t = { options, shows: [], show: (p) => t.shows.push(p), dispose() { t.exitStatus = { code: 0 }; vscode.window.terminals = vscode.window.terminals.filter((x) => x !== t); }, sendText: (text) => (t.sent ??= []).push(text), exitStatus: undefined, processId: Promise.resolve(4242) };
      terminals.push(options); vscode.window.terminals.push(t); return t; } } };
const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-orch-home-"));
process.env.HOME = process.env.USERPROFILE = home;
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board } = require("../out/board.js");

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const made = [], boards = [];
test.after(() => { for (const b of boards) b.dispose(); for (const d of made) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

/** A throwaway repo with one commit and a board that owns it, with one signed-in Claude account "acct". */
function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-orch-"));
  made.push(repo);
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t"); sh(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false); // no 3 s poll: the tests tick by hand
  boards.push(board);
  board.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }];
  board.accountFolderList = () => [path.join(home, "acct")];
  board.tick(); // takes the board
  return { repo, board };
}
const event = (board, id, e) => fs.appendFileSync(board.eventsFile(id), JSON.stringify({ t: Date.now(), ...e }) + "\n");
const statusLines = (board) => fs.existsSync(board.statusFile) ? fs.readFileSync(board.statusFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

test("every task session gets its card, repository and session identity in Claude settings and the terminal environment", async () => {
  const { repo, board } = fixture();
  const task = board.add("t", "p", "acct");
  board.update(task, { worktree: repo, branch: "main" });
  const starting = board.start(task); // waits for SessionStart; closing the terminal below ends that wait
  await new Promise((r) => setTimeout(r, 100));
  const hooks = JSON.parse(fs.readFileSync(board.hooksFile(task.id), "utf8"));
  try {
    // The card's own temporary folder inside the workspace (workspace.ts), with git stopped at the temp root.
    const temp = path.join(repo, ".entomatical", "tmp", task.id), cardTemp = { TMP: temp, TEMP: temp, TMPDIR: temp, GIT_CEILING_DIRECTORIES: path.join(repo, ".entomatical", "tmp") };
    assert.deepEqual(hooks.env, { ...cardTemp, ENTOMATICAL_EVENTS: board.eventsFile(task.id), ENTOMATICAL_TASK: task.id, ENTOMATICAL_REPO: repo, ENTOMATICAL_SESSION: task.sessionId, ENTOMATICAL_RUNTIME: "claude", PYTHONUTF8: "1" });
    assert.ok(fs.existsSync(temp));
    const opened = terminals.at(-1);
    assert.equal(opened.env.TMP, temp);
    assert.equal(opened.env.ENTOMATICAL_TASK, task.id);
    assert.equal(opened.env.ENTOMATICAL_REPO, repo);
    assert.equal(opened.env.ENTOMATICAL_SESSION, task.sessionId);
    assert.equal(opened.env.ENTOMATICAL_RUNTIME, "claude");
    assert.equal(opened.env.CLAUDE_CONFIG_DIR, path.join(home, "acct"));
  } finally {
    vscode.window.terminals.at(-1).dispose();
    await starting;
  }
});

test("status.jsonl: the owner writes every card when it takes the board, then one line per change (not per tick), with the card's time in its column", async () => {
  const { board } = fixture();
  const t1 = board.add("first", "p", "acct"), t2 = board.add("second", "p", "acct");
  let lines = statusLines(board);
  assert.deepEqual(lines.map((l) => [l.id, l.status]), [[t1.id, "queued"], [t2.id, "queued"]]);
  assert.equal(lines[0].since, Date.parse(t1.statusAt));
  board.tick(); board.tick();
  assert.equal(statusLines(board).length, 2, "ticks with nothing changed add no lines");
  board.update(t2, { status: "running" });
  lines = statusLines(board);
  assert.equal(lines.length, 3);
  assert.deepEqual([lines[2].id, lines[2].status, lines[2].asks, lines[2].repeating, lines[2].judged, lines[2].role], [t2.id, "running", null, null, null, null]);
  assert.ok(lines[2].since >= lines[1].since);
  assert.match(lines[2].line, new RegExp(`^${t2.id}  running .*"second"`));
  // A new window taking the board over rewrites the file with every card.
  board.published.clear(); board.publishStatus(true);
  assert.equal(statusLines(board).length, 2);
});

test("the live line follows the latest tool description while the card runs, and the timeline lists the last events", () => {
  const { board } = fixture();
  const task = board.add("live", "p", "acct");
  board.update(task, { sessionId: "s1", status: "running" });
  event(board, task.id, { hook_event_name: "SessionStart" });
  event(board, task.id, { hook_event_name: "UserPromptSubmit", prompt: "p" });
  event(board, task.id, { hook_event_name: "PostToolUse", tool_name: "Bash", desc: "Bash npm test" });
  assert.equal(board.doingOf(task).text, "Bash npm test");
  board.publishStatus();
  assert.equal(statusLines(board).at(-1).doing, "Bash npm test");
  event(board, task.id, { hook_event_name: "PostToolUse", tool_name: "Edit", desc: "Edit src/board.ts" });
  assert.equal(board.doingOf(task).text, "Edit src/board.ts");
  const before = statusLines(board).length;
  board.publishStatus();
  assert.equal(statusLines(board).length, before + 1, "a new live line is a change");
  assert.deepEqual(board.timelineOf(task).map((l) => l.text.slice(9)), ["SessionStart", "Prompt: p", "Bash npm test", "Edit src/board.ts"]);
  event(board, task.id, { hook_event_name: "Stop", last_assistant_message: "done" });
  board.syncStatus(task.id);
  assert.equal(task.status, "review");
  assert.equal(board.doingOf(task), undefined);
});

test("a tool call during a turn redraws the board (the live line moved) even though the status did not change", async () => {
  const { board } = fixture();
  const task = board.add("redraw", "p", "acct");
  board.update(task, { sessionId: "s2", status: "running" });
  event(board, task.id, { hook_event_name: "SessionStart" });
  await new Promise((r) => setTimeout(r, 300)); // the events watcher sees the file
  let changes = 0;
  board.onChange(() => changes++);
  event(board, task.id, { hook_event_name: "PostToolUse", tool_name: "Bash", desc: "Bash npm test" });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(task.status, "running");
  assert.ok(changes >= 1, `the board said it changed (${changes})`);
  assert.equal(board.doingOf(task).text, "Bash npm test");
});
