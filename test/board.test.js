const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

// board.js imports "vscode", which exists only inside VS Code. This stand-in has just what Board touches.
class EventEmitter {
  listeners = [];
  event = (l) => (this.listeners.push(l), { dispose() {} });
  fire(e) { for (const l of this.listeners) l(e); }
  dispose() {}
}
const terminals = []; // options of every terminal a board opened
const sent = []; // text sent into those terminals
const shown = []; // the preserveFocus argument of every terminal show()
const warnings = []; // every warning shown; a test sets `answer` to the button it presses
const ask = { answer: undefined };
const commands = []; // every VS Code command the board ran, with its arguments
const vscode = { EventEmitter, ThemeIcon: class {}, TabInputCustom: class { constructor(uri) { this.uri = uri; } },
  commands: { executeCommand: async (...args) => { commands.push(args); } },
  Uri: { from: (parts) => ({ ...parts, toString: () => `${parts.scheme}://${parts.authority}${parts.path}` }) },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async (message) => (warnings.push(message), ask.answer),
  // shows: this terminal's own show() calls; earlier tests' boards keep their 20-second start nudges running into later tests.
  createTerminal: (options) => { terminals.push(options); const t = { sent: [], shows: [], show: (preserveFocus) => { shown.push(preserveFocus); t.shows.push(preserveFocus); }, dispose() {}, sendText: (text) => { sent.push(text); t.sent.push(text); }, exitStatus: undefined }; return t; } } };
// Board keeps sessions in the panel's history under ~/.claude and ~/.claude-accounts (DEFAULT_DIR, ACCOUNTS_ROOT, read at
// load). Point the home folder at a throwaway one so no test writes into the real account folders.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-home-"));
process.env.HOME = process.env.USERPROFILE = home;
process.env.CODEX_HOME = path.join(home, ".codex");
process.env.ENTOMATICAL_USAGE_DIR = path.join(home, ".entomatical", "usage");
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board, hookNode } = require("../out/board.js");

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Runs `fn` as if on another platform, for code that checks process.platform when it runs. */
function onPlatform(platform, fn) {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...real, value: platform });
  try { return fn(); } finally { Object.defineProperty(process, "platform", real); }
}

const made = []; // every folder fixture() makes: each worktree, then its repo
const boards = []; // every Board open() makes: each one polls on a timer until disposed
test.after(() => {
  for (const b of boards) b.dispose();
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

/** A throwaway repo with one commit, plus a worktree on branch task/t1 holding one more commit. */
function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-board-"));
  const worktree = path.join(repo, ".entomatical", "wt", "t1");
  made.push(worktree, repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "t@t");
  sh(repo, "config", "user.name", "t");
  sh(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  fs.writeFileSync(path.join(repo, ".entomatical", ".gitignore"), "*\n");
  sh(repo, "worktree", "add", "-q", "-b", "task/t1", worktree, "HEAD");
  fs.writeFileSync(path.join(worktree, "a.txt"), "one\ntwo\n");
  sh(worktree, "commit", "-qam", "task change");
  return { repo, worktree, branch: "task/t1" };
}

/** A card's own temporary folder inside the workspace, as its sessions get it (src/workspace.ts). */
const cardTemp = (board, task) => {
  const root = path.join(board.repo, ".entomatical", "tmp"), dir = path.join(root, task.id);
  return { TMP: dir, TEMP: dir, TMPDIR: dir, GIT_CEILING_DIRECTORIES: root };
};

const open = (repo) => {
  const board = new Board(repo, path.join(repo, "hook.js"));
  board.startNudgeMs = 600_000; // an earlier test's 20 s nudge would land in a later test's warnings (the one test of the nudge sets its own)
  board.codexConfiguredModel = async () => undefined; // no Codex process is asked; Codex's config sets no model (codex.test.js reads one)
  boards.push(board);
  return board;
};

test("manual ACP Rename persists each selected card's title across a tasks.json reload", async (t) => {
  const { repo } = fixture();
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  t.after(() => board.dispose());
  assert.ok(board.isOwner(true));
  // Exercise the real save and reload without running the background status publisher.
  board.publishStatus = () => {};
  const cards = ["grok", "antigravity"].map(provider => {
    const card = board.add(provider, "Original prompt");
    board.update(card, { provider, sessionId: provider + "-session", headless: true, status: "review" });
    return card;
  });
  const forbidden = () => assert.fail("ACP Rename entered a native session route");
  Object.assign(board, { nameThread: forbidden, reopenInCodex: forbidden, openInPanel: forbidden, terminal: forbidden, transcriptOf: forbidden });
  board.external.get = forbidden;
  const dialogs = new Map();
  vscode.window.showInputBox = ({ value }) => new Promise(resolve => dialogs.set(value, resolve));
  t.after(() => { delete vscode.window.showInputBox; });
  const filename = require.resolve("../out/extension.js");
  const host = new Module(filename, module);
  host.filename = filename;
  host.paths = module.paths;
  host._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.renameForTest = handle;", filename);
  const pending = cards.map(card => host.exports.renameForTest(board, { type: "rename", id: card.id }));
  assert.deepEqual([...dialogs.keys()], ["grok", "antigravity"]);
  const saved = () => JSON.parse(fs.readFileSync(board.file, "utf8"));
  const fromDisk = saved().reverse();
  for (const card of fromDisk) card.prompt = "Edited while Rename was open";
  fs.writeFileSync(board.file, JSON.stringify(fromDisk));
  board.loadedAt = -1;
  assert.equal(board.reload(), true);
  for (const card of cards) assert.notEqual(board.get(card.id), card);
  for (const [index, card] of cards.entries()) {
    const newTitle = "New " + card.provider;
    dialogs.get(card.provider)("  " + newTitle + "  ");
    await pending[index];
    const persisted = saved();
    assert.equal(persisted.find(row => row.id === card.id).title, newTitle);
    if (index === 0) assert.equal(persisted.find(row => row.id === cards[1].id).title, cards[1].title);
    assert.equal(board.get(card.id).prompt, "Edited while Rename was open");
    assert.equal(card.title, card.provider, "the detached object keeps its original title");
  }
});

test("cards mirror saved session renames even when the session is stopped", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-title-"));
  made.push(repo);
  const board = open(repo);
  const task = board.add("Original card", "Original prompt");
  const transcript = path.join(repo, "session.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "ai-title", aiTitle: "Generated session name" }) + "\n");
  board.update(task, { sessionId: "saved-session", transcript, status: "review" });
  board.tick();
  assert.equal(task.title, "Generated session name");
  fs.appendFileSync(transcript, JSON.stringify({ type: "custom-title", customTitle: "Renamed from Claude tab" }) + "\n");
  board.tick();
  assert.equal(task.title, "Renamed from Claude tab");
  assert.equal(task.prompt, "Original prompt");
  assert.equal(JSON.parse(fs.readFileSync(board.file, "utf8"))[0].title, task.title);
});

test("F53: an untitled card keeps its prompt's first line over Claude's generated title, and takes a rename made in Claude Code", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-title-"));
  made.push(repo);
  const board = open(repo);
  const task = board.add("", "Fix login\nmore");
  assert.equal(task.title, "Fix login");
  const transcript = path.join(repo, "session.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "ai-title", aiTitle: "Generated session name" }) + "\n");
  board.update(task, { sessionId: "f53-session", transcript, status: "review" });
  board.tick();
  assert.equal(task.title, "Fix login"); // before: "Generated session name"
  fs.appendFileSync(transcript, JSON.stringify({ type: "custom-title", customTitle: "Renamed from Claude tab" }) + "\n");
  board.tick();
  assert.equal(task.title, "Renamed from Claude tab");
  assert.equal(JSON.parse(fs.readFileSync(board.file, "utf8"))[0].title, "Renamed from Claude tab");
});

test("subagent lifecycle preserves metadata through sparse stops and later starts", () => {
  const events = [{ t: 1, hook_event_name: "SubagentStart", agent_id: "child", agent_type: "Explore", model: "hook-model", effort_level: "high" }];
  const board = { transcriptOf: () => undefined, events: () => events };
  const observe = () => Board.prototype.subagentsOf.call(board, { id: "task" })[0];
  events.push({ t: 2, hook_event_name: "SubagentStop", agent_id: "child" });
  let agent = observe();
  assert.equal(agent.type, "Explore");
  assert.equal(agent.model, "hook-model");
  assert.equal(agent.effort, "high");
  assert.equal(agent.done, true);
  assert.equal(agent.updated, 2);
  events.push({ t: 3, hook_event_name: "SubagentStart", agent_id: "child", model: "resumed-model", effort: "low" });
  agent = observe();
  assert.equal(agent.type, "Explore");
  assert.equal(agent.model, "resumed-model");
  assert.equal(agent.effort, "low");
  assert.equal(agent.done, false);
  events.push({ t: 4, hook_event_name: "SubagentStop", agent_id: "child", effort_level: "medium" });
  assert.equal(observe().effort, "medium");
});

test("subagent hooks preserve transcript models and leave cached transcript observations unchanged", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-worker-"));
  made.push(repo);
  const transcript = path.join(repo, "session.jsonl");
  const file = path.join(repo, "session", "subagents", "agent-child.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: "assistant", message: { model: "transcript-model", content: [{ type: "text", text: "Working" }] } }) + "\n");
  const { subagents } = require("../out/sessions.js");
  const cached = subagents(transcript)[0];
  const before = { ...cached };
  const events = [
    { t: 1, hook_event_name: "SubagentStart", agent_id: "child", agent_type: "Explore", model: "older-hook-model", effort_level: "high" },
    { t: 2, hook_event_name: "SubagentStop", agent_id: "child" },
  ];
  const [agent] = Board.prototype.subagentsOf.call({ transcriptOf: () => transcript, events: () => events }, { id: "task" });
  assert.equal(agent.model, "transcript-model");
  assert.equal(agent.type, "Explore");
  assert.equal(agent.effort, "high");
  assert.equal(agent.done, true);
  assert.equal(agent.lifecycle, "hook");
  assert.notEqual(agent, cached);
  assert.deepEqual(subagents(transcript)[0], before);
});

test("a finished subagent with no transcript shows its answer, and a blank-type suggestion stop is left out", () => {
  const events = [
    { t: 1, hook_event_name: "SubagentStop", agent_id: "ghost", agent_type: "", last_assistant_message: "npm install and npm run build" },
    { t: 2, hook_event_name: "SubagentStart", agent_id: "child", agent_type: "Explore" },
    { t: 3, hook_event_name: "SubagentStop", agent_id: "child", agent_type: "Explore", last_assistant_message: "Two callers.\nDetails" },
  ];
  const agents = Board.prototype.subagentsOf.call({ transcriptOf: () => undefined, events: () => events }, { id: "task" });
  assert.deepEqual(agents.map((a) => a.id), ["child"]);
  assert.equal(agents[0].doing, "Two callers.");
  assert.equal(agents[0].done, true);
  assert.equal(agents[0].known, false);
  assert.equal(agents[0].type, "Explore");
});

test("blank-type suggestion stops whose agent_transcript_path names a missing file are left out (linux F13, 11 November 2026)", () => {
  // Event shapes from docs/evidence/parity-linux-2026-11-11/F13-files/events-c13a01.jsonl.
  const missing = (id) => path.join(os.tmpdir(), "entomatical-no-such-session", "subagents", `agent-${id}.jsonl`);
  const events = [
    { t: 1, hook_event_name: "SubagentStart", agent_id: "a64c98659ba5a0150", agent_type: "general-purpose" },
    { t: 2, hook_event_name: "SubagentStop", agent_id: "a64c98659ba5a0150", agent_type: "general-purpose", last_assistant_message: "pong", agent_transcript_path: missing("a64c98659ba5a0150") },
    { t: 3, hook_event_name: "SubagentStop", agent_id: "ab70d5ea712bba6ef", agent_type: "", agent_transcript_path: missing("ab70d5ea712bba6ef"), effort: { level: "low" } },
    { t: 4, hook_event_name: "SubagentStop", agent_id: "a8e6bbb2e6fee7a31", agent_type: "", last_assistant_message: "dispatched", agent_transcript_path: missing("a8e6bbb2e6fee7a31") },
    { t: 5, hook_event_name: "SubagentStart", agent_id: "lingering", agent_type: "" },
  ];
  const agents = Board.prototype.subagentsOf.call({ transcriptOf: () => undefined, events: () => events }, { id: "task" });
  assert.deepEqual(agents.map((a) => a.id), ["a64c98659ba5a0150"]);
  assert.equal(agents[0].type, "general-purpose");
  assert.equal(agents[0].doing, "pong");
  assert.equal(agents[0].done, true);
});

test("a blank agent_type does not wipe the type read from the transcript", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-worker-"));
  made.push(repo);
  const transcript = path.join(repo, "session.jsonl");
  const file = path.join(repo, "session", "subagents", "agent-child.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: "assistant", message: { model: "transcript-model", content: [{ type: "text", text: "Working" }] } }) + "\n");
  fs.writeFileSync(file.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ agentType: "Explore", description: "Find callers" }));
  const events = [{ t: 2, hook_event_name: "SubagentStop", agent_id: "child", agent_type: "", last_assistant_message: "npm test" }];
  const [agent] = Board.prototype.subagentsOf.call({ transcriptOf: () => transcript, events: () => events }, { id: "task" });
  assert.equal(agent.type, "Explore");
  assert.equal(agent.description, "Find callers");
  assert.equal(agent.doing, "Working");
  assert.equal(agent.done, true);
});

test("SubagentStop's agent_transcript_path supplies steps when the session folder was not scanned", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-worker-"));
  made.push(repo);
  const file = path.join(repo, "agent-child.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/a.ts" } }, { type: "text", text: "Two callers." }] } }) + "\n");
  const events = [{ t: 2, hook_event_name: "SubagentStop", agent_id: "child", agent_type: "Explore", agent_transcript_path: file, last_assistant_message: "ignored once the file is read" }];
  const [agent] = Board.prototype.subagentsOf.call({ transcriptOf: () => undefined, events: () => events }, { id: "task" });
  assert.equal(agent.steps, 1);
  assert.equal(agent.doing, "Two callers.");
  assert.equal(agent.done, true);
  assert.equal(agent.known, undefined);
  assert.equal(agent.type, "Explore");
});

/** A board with one task on the fixture's worktree. */
function withTask() {
  const f = fixture();
  const board = open(f.repo);
  const task = board.add("t", "do it");
  board.update(task, { worktree: f.worktree, branch: f.branch });
  return { ...f, board, task };
}

test("events are parsed once per change of the file; an unfinished last line waits; a caller's change does not reach the cache", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-events-"));
  made.push(repo);
  const board = open(repo);
  const task = board.add("t", "do it");
  const file = board.eventsFile(task.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ t: 1, hook_event_name: "SessionStart" }) + "\n");
  const reads = [], readFileSync = fs.readFileSync;
  fs.readFileSync = function (f, ...rest) { if (f === file) reads.push(f); return readFileSync.call(this, f, ...rest); };
  try {
    for (let i = 0; i < 5; i++) assert.equal(board.events(task.id).length, 1);
    assert.equal(reads.length, 1); // one render asks several times; the file is read once
    board.events(task.id).push({ t: 9 });
    assert.equal(board.events(task.id).length, 1);
    const next = JSON.stringify({ t: 2, hook_event_name: "UserPromptSubmit", prompt: "go" });
    fs.appendFileSync(file, next.slice(0, 10));
    assert.equal(board.events(task.id).length, 1); // the half-written line is left out
    fs.appendFileSync(file, next.slice(10) + "\n");
    assert.deepEqual(board.events(task.id).map((e) => e.t), [1, 2]);
    assert.equal(reads.length, 3);
    fs.rmSync(file);
    assert.deepEqual(board.events(task.id), []);
  } finally { fs.readFileSync = readFileSync; }
});

test("Changes: a worktree folder deleted by hand is explained without sending the user to Discard", () => {
  const { worktree, board, task } = withTask();
  fs.rmSync(worktree, { recursive: true, force: true });
  assert.throws(() => board.changes(task), (e) => /folder is gone/.test(e.message) && /Merge/.test(e.message) && !/use Discard/i.test(e.message)); // Discard would delete the branch's commits
});

test("Merge: a worktree folder deleted by hand does not stop the branch's commits landing", async () => {
  const { repo, worktree, branch, board, task } = withTask();
  fs.rmSync(worktree, { recursive: true, force: true });
  await board.finish(task, "merge");
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "one\ntwo\n"); // the task's commit is in the repo
  assert.equal(sh(repo, "branch", "--list", branch), "");
  assert.deepEqual([task.status, task.merged, task.worktree], ["done", true, undefined]);
});

test("Finish keeps a Grok card's session folder: its usage files are found by it after the worktree is gone (F93)", async () => {
  const { worktree, board, task } = withTask();
  board.update(task, { provider: "grok" });
  await board.finish(task, "merge");
  assert.deepEqual([task.status, task.worktree, task.ranIn], ["done", undefined, worktree]);
  const claude = withTask();
  await claude.board.finish(claude.task, "merge");
  assert.equal(claude.task.ranIn, undefined);
});

test("Merge still refuses while the worktree holds uncommitted work", async () => {
  const { repo, worktree, board, task } = withTask();
  fs.writeFileSync(path.join(worktree, "b.txt"), "not committed\n");
  await assert.rejects(board.finish(task, "merge"), /uncommitted changes/);
  assert.match(sh(repo, "branch", "--list"), /task\/t1/);
});

test("a Codex task asks once to approve its hook, runs the Codex CLI in its worktree, follows finished turns, and resumes that session", async () => {
  const codex = require("../out/codex.js");
  const fake = require("./fake-codex-use.js").useFakeCodex(codex);
  try {
  await codex.discoverCodex(); // the fake's account and its models gpt-a (medium, ultra) and gpt-b (low, high)
  const { repo } = fixture();
  const board = open(repo);
  const account = "Codex · user@example.test";
  assert.throws(() => board.add("", "x", account, undefined, "opus"), /Unknown model/);
  assert.throws(() => board.add("", "x", "Codex", undefined, "opus"), /Unknown model/);
  assert.throws(() => board.add("", "x", account, undefined, "gpt-b", "ultra"), /Unknown effort/);
  // configDirOf matches account names in any case, so add does too: a differently-cased Codex name must not start Claude.
  const upper = board.add("", "x", account.toUpperCase());
  assert.deepEqual([upper.provider, upper.account], ["codex", account]);
  // Declining the approval leaves the card unstarted: no terminal, no session id.
  const declined = board.add("", "not this one", account);
  const opened0 = terminals.length;
  await assert.rejects(board.start(declined), /not approved/);
  assert.deepEqual([terminals.length, declined.sessionId, warnings.at(-1)], [opened0, undefined, "Let Codex run Entomatical's status hook?"]);
  ask.answer = "Approve";
  const task = board.add("", "fix the bug", account, undefined, "gpt-a", "ultra");
  assert.equal(task.provider, "codex");
  const term = await board.start(task);
  const opened = terminals.at(-1);
  const hooks = codex.hookArgs(codex.CODEX_HOOK); // the same for every task, so one approval covers them all
  assert.deepEqual([opened.shellPath, opened.cwd, opened.env], [fake.file, task.worktree, { ...cardTemp(board, task), TERM: "xterm-256color", COLORTERM: "truecolor", NO_COLOR: null, FORCE_COLOR: "3", ENTOMATICAL_EVENTS: board.eventsFile(task.id), ENTOMATICAL_TASK: task.id, ENTOMATICAL_REPO: board.repo, ENTOMATICAL_RUNTIME: "codex", ENTOMATICAL_SESSION: task.sessionId, ...(process.env.WSLENV !== undefined ? { WSLENV: process.env.WSLENV } : {}) }]);
  assert.deepEqual(opened.shellArgs, ["-m", "gpt-a", "-c", 'model_reasoning_effort="ultra"', ...hooks, "--", "fix the bug"]);
  assert.equal(task.status, "queued"); // the prompt is Codex's start argument; its UserPromptSubmit hook moves the card
  const placeholder = task.sessionId;
  // Hook events as codex-cli 0.163 sends them (26 Oct 2026): the same JSON shape as Claude's, with the thread id and the rollout file.
  const rollout = path.join(repo, "rollout-2026-10-26T03-28-11-thread-9.jsonl");
  const hook = (name, extra = {}) => { fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: name, session_id: "thread-9", transcript_path: rollout, ...extra }) + "\n"); board.syncStatus(task.id); };
  hook("SessionStart", { source: "startup" });
  assert.equal(task.sessionId, "thread-9"); // Codex's own thread id replaces the placeholder
  assert.notEqual(task.sessionId, placeholder);
  hook("UserPromptSubmit", { prompt: "fix the bug" });
  assert.equal(task.status, "running");
  assert.deepEqual(board.prompts(task), [{ text: "fix the bug" }]);
  hook("PermissionRequest", { tool_name: "Bash" });
  assert.equal(task.status, "needs-input");
  const sendsBeforeApproval = sent.length;
  assert.throws(() => board.send(task, "and another"), /waiting on a prompt/); // its Enter could answer the approval
  assert.equal(sent.length, sendsBeforeApproval);
  hook("PostToolUse", { tool_name: "Bash" });
  assert.equal(task.status, "running");
  onPlatform("linux", () => board.send(task, "now add a test")); // mid-turn follow-ups are allowed, as for Claude; Windows: next test
  assert.equal(sent.at(-1), "\u001b[200~now add a test\u001b[201~\r");
  // Another thread's events (a /new in the terminal, a side thread) never move the card or become its reply.
  hook("Stop", { session_id: "other-thread", last_assistant_message: "Titled." });
  assert.equal(task.status, "running");
  hook("Stop", { last_assistant_message: "Fixed it." });
  assert.deepEqual([task.status, board.lastReply(task)], ["review", "Fixed it."]);
  hook("UserPromptSubmit", { prompt: "now add a test" });
  // A spawned agent's hooks arrive in the same session, tagged with agent_id (seen live 26 Oct 2026): listed as a subagent, not as the task's prompt.
  hook("SubagentStart", { agent_id: "01a177d5-3204-7560-9e2b-863225aca663", agent_type: "default" });
  hook("UserPromptSubmit", { prompt: "Reply with the single word OK.", agent_id: "01a177d5-3204-7560-9e2b-863225aca663", agent_type: "default" });
  hook("SubagentStop", { agent_id: "01a177d5-3204-7560-9e2b-863225aca663", agent_type: "default", last_assistant_message: "OK" });
  assert.deepEqual(board.subagentsOf(task).map((a) => [a.id, a.type, a.done, a.lifecycle]), [["01a177d5-3204-7560-9e2b-863225aca663", "default", true, "hook"]]);
  hook("Interrupt"); // Esc during the turn
  assert.equal(task.status, "review");
  assert.deepEqual(board.prompts(task), [{ text: "fix the bug", reply: "Fixed it." }, { text: "now add a test" }]); // each prompt with its readout; the agent's prompt is not the task's
  assert.equal(board.canResumeInPanel(task), false);
  assert.equal(board.transcriptOf(task), rollout); // the rollout file, for measurements and subagents
  assert.equal(board.metrics.session(task).source, "unknown"); // the file does not exist in this test
  term.exitStatus = { code: 0 }; // Codex was closed
  // Codex now holds the approval (the fake reports every one of our hooks trusted), so resuming asks nothing.
  process.env.FAKE_CODEX_TRUSTED = codex.CODEX_HOOKS.map((e) => `/<session-flags>/config.toml:${e.replace(/[A-Z]/g, (ch, i) => (i ? "_" : "") + ch.toLowerCase())}:0:0`).join(",");
  ask.answer = undefined;
  const asked = warnings.length;
  await board.resume(task);
  assert.equal(warnings.length, asked);
  assert.deepEqual(terminals.at(-1).shellArgs, ["resume", "-m", "gpt-a", "-c", 'model_reasoning_effort="ultra"', ...hooks, "-c", 'tui.resume_cwd="current"', "thread-9"]);
  assert.deepEqual(terminals.at(-1).env, { ...cardTemp(board, task), TERM: "xterm-256color", COLORTERM: "truecolor", NO_COLOR: null, FORCE_COLOR: "3", ENTOMATICAL_EVENTS: board.eventsFile(task.id), ENTOMATICAL_TASK: task.id, ENTOMATICAL_REPO: board.repo, ENTOMATICAL_RUNTIME: "codex", ENTOMATICAL_SESSION: task.sessionId, ...(process.env.WSLENV !== undefined ? { WSLENV: process.env.WSLENV } : {}) });
  } finally { fake.done(); delete process.env.FAKE_CODEX_TRUSTED; ask.answer = undefined; }
});

test("a follow-up to a Codex terminal on Windows sends its Enter on its own, after the paste, so Codex submits it", async () => {
  // Seen live 31 October 2026 (codex-cli 0.164.0-alpha.11.1, Windows 11): with the paste and its Enter in one write, Codex took the
  // Enter as a new line in its input box and the follow-up was never sent.
  const codex = require("../out/codex.js");
  const fake = require("./fake-codex-use.js").useFakeCodex(codex);
  process.env.FAKE_CODEX_TRUSTED = codex.CODEX_HOOKS.map((e) => `/<session-flags>/config.toml:${e.replace(/[A-Z]/g, (ch, i) => (i ? "_" : "") + ch.toLowerCase())}:0:0`).join(",");
  try {
    await codex.discoverCodex();
    const { repo } = fixture();
    const board = open(repo);
    board.codexEnterMs = 20;
    const later = () => new Promise((r) => setTimeout(r, 60));
    const task = board.add("", "fix the bug", "Codex · user@example.test");
    const term = await board.start(task);
    const from = sent.length;
    onPlatform("win32", () => board.send(task, "now add a test\nand run it"));
    assert.deepEqual(sent.slice(from), ["\u001b[200~now add a test\nand run it\u001b[201~"]); // no Enter yet
    await later();
    assert.deepEqual(sent.slice(from), ["\u001b[200~now add a test\nand run it\u001b[201~", "\r"]);
    // An approval prompt that came up meanwhile is not answered by that Enter, and a closed terminal gets none.
    onPlatform("win32", () => board.send(task, "one more"));
    board.update(task, { status: "needs-input" });
    await later();
    assert.equal(sent.at(-1), "\u001b[200~one more\u001b[201~");
    board.update(task, { status: "running" });
    onPlatform("win32", () => board.send(task, "last"));
    term.exitStatus = { code: 0 };
    await later();
    assert.equal(sent.at(-1), "\u001b[200~last\u001b[201~");
  } finally { fake.done(); delete process.env.FAKE_CODEX_TRUSTED; }
});

test("a Codex task's thread is the SessionStart that names a rollout, even when a hook-running side thread starts first", () => {
  const { codexThread, ownThread } = require("../out/board.js");
  // Seen 28 Oct 2026: codex exec's memory-consolidation thread fires hooks with transcript_path null.
  const events = [
    { t: 1, hook_event_name: "SessionStart", session_id: "memory", transcript_path: null },
    { t: 2, hook_event_name: "SessionStart", session_id: "task", transcript_path: "/c/rollout-task.jsonl" },
    { t: 3, hook_event_name: "Stop", session_id: "memory" },
    { t: 4, hook_event_name: "UserPromptSubmit", session_id: "task", prompt: "go" },
  ];
  assert.equal(codexThread(events), "task");
  assert.deepEqual(ownThread(events).map((e) => e.t), [2, 4]);
  assert.equal(codexThread(events.filter((e) => e.session_id !== "task")), "memory"); // no rollout named anywhere: the first one
});

// A fake `codex app-server` child: the test reads the board's JSON-RPC requests from the child's stdin and answers on its stdout.
function fakeAppServer(pid) {
  const { EventEmitter: Emitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const child = Object.assign(new Emitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid, killed: 0 });
  const requests = [];
  let waiters = [];
  let buffer = "";
  child.stdin.on("data", (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) { requests.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); }
    waiters = waiters.filter((w) => !w());
  });
  const answer = (id, result) => child.stdout.write(JSON.stringify({ id, result }) + "\n");
  const notify = (method, params) => child.stdout.write(JSON.stringify({ method, params }) + "\n");
  /** The next request of that method the board sends (or already sent). */
  const next = (method) => new Promise((resolve) => {
    const look = () => { const m = requests.find((q) => q.method === method && !q.taken); if (!m) return false; m.taken = true; resolve(m); return true; };
    if (!look()) waiters.push(look);
  });
  return { child, requests, answer, notify, next };
}

for (const route of ["headless", "editor fallback"]) {
  for (const stage of ["thread/start", "active turn"]) {
    test(`RT-04: ${route} app-server disposal during ${stage} releases once and fences late RPC and close`, { timeout: 10000 }, async () => {
      const { repo } = fixture(), board = open(repo);
      board.accountList = () => [{ name: "Fixture", provider: "codex" }];
      board.codexModelReady = board.ensureCodexTrust = async () => {};
      board.codexSend = () => undefined;
      board.setCodexName = async () => {};
      board.codexEditor = () => true;
      board.startCodexPanel = async () => undefined;
      const server = fakeAppServer(2 ** 30), stopped = [];
      board.runCodex = () => server.child;
      board.killTree = child => stopped.push(child);
      const task = board.add("", "First prompt", "Fixture");
      const launched = route === "headless" ? board.startHeadless(task) : board.start(task);
      const result = launched.then(() => "started", error => error.message);
      const init = await server.next("initialize");
      server.answer(init.id, {});
      const thread = await server.next("thread/start");
      if (stage === "active turn") {
        const rollout = path.join(repo, "rollout.jsonl");
        fs.writeFileSync(rollout, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) + "\n");
        server.answer(thread.id, { thread: { id: "real-thread", path: rollout } });
        const turn = await server.next("turn/start");
        server.answer(turn.id, { turn: { id: "turn" } });
        await result;
        await new Promise(resolve => setImmediate(resolve));
      }
      board.dispose();
      board.dispose();
      assert.deepEqual(stopped, [server.child]);
      assert.equal(board.codexRuns.size, 0);
      const replacement = open(repo), card = replacement.get(task.id);
      assert.equal(card.interrupted, true);
      assert.equal(card.sessionId, stage === "active turn" ? "real-thread" : undefined);
      assert.equal(card.status, stage === "active turn" ? "review" : "queued");
      assert.equal(replacement.events(task.id).filter(e => e.hook_event_name === "Interrupt").length, 1);
      if (stage === "active turn" && route === "editor fallback") {
        assert.deepEqual(card.codexEditorPolicy, { threadId: "real-thread", sandbox: "workspace-write" });
        assert.equal(card.codexStopped, 1, "the cut-off rollout cannot reactivate the turn on reload");
      }
      replacement.accountList = board.accountList;
      replacement.codexSend = board.codexSend;
      replacement.codexModelReady = board.codexModelReady;
      replacement.setCodexName = board.setCodexName;
      const nextServer = fakeAppServer(2 ** 30 + 1);
      replacement.runCodex = () => nextServer.child;
      replacement.killTree = child => stopped.push(child);
      const retry = () => card.sessionId ? replacement.followUpHeadless(card, "Retry") : replacement.startHeadless(card);
      await assert.rejects(retry(), /previous provider process to exit/);
      assert.equal(nextServer.requests.length, 0);
      server.child.emit("exit", 0); // the old reader can still produce buffered messages and close later
      const nextRun = retry();
      const nextInit = await nextServer.next("initialize");
      nextServer.answer(nextInit.id, {});
      const nextThread = await nextServer.next(stage === "active turn" ? "thread/resume" : "thread/start");
      if (stage === "active turn") assert.equal(nextThread.params.threadId, "real-thread");
      nextServer.answer(nextThread.id, { thread: { id: "real-thread" } });
      const nextTurn = await nextServer.next("turn/start");
      nextServer.answer(nextTurn.id, {});
      await nextRun;
      const saved = fs.readFileSync(board.file), events = fs.readFileSync(board.eventsFile(card.id));
      const opens = commands.length;
      server.answer(thread.id, { thread: { id: "late-thread" } });
      server.notify("item/completed", { item: { type: "old tool" } });
      server.notify("turn/completed", { turn: { status: "completed" } });
      server.child.emit("close", 0);
      await result;
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(fs.readFileSync(board.file), saved);
      assert.deepEqual(fs.readFileSync(board.eventsFile(card.id)), events);
      assert.equal(commands.length, opens);
      assert.equal(stopped.length, 1);
      assert.ok(replacement.firstTurn().includes(card.id));
      assert.equal(server.requests.filter(r => r.method === "turn/start").length, stage === "active turn" ? 1 : 0);
      replacement.dispose();
      nextServer.child.emit("close", 0);
    });
  }
}

test("RT-04: replacement verifies the hidden Claude terminal and blocks overlapping resumes", async (t) => {
  const { repo } = fixture(), board = open(repo);
  board.accountList = () => [{ name: "Fixture Claude", configDir: path.join(repo, "claude") }];
  const runs = [], closed = [];
  t.mock.method(vscode.window, "createTerminal", options => {
    const term = { name: options.name, creationOptions: options, dispose: () => closed.push(term) };
    runs.push(term);
    return term;
  });
  const task = board.add("", "First prompt", "Fixture Claude");
  const term = await board.startHeadless(task);
  board.dispose();
  board.dispose();
  const wrong = { name: term.name, creationOptions: { ...term.creationOptions, env: { ...term.creationOptions.env, ENTOMATICAL_SESSION: "different" } } };
  vscode.window.terminals = [wrong, term];
  t.after(() => { vscode.window.terminals = []; });
  const replacement = open(repo), card = replacement.get(task.id);
  replacement.accountList = board.accountList;
  assert.equal(replacement.terminal(card), term);
  await assert.rejects(replacement.followUpHeadless(card, "Retry"), /already running/);
  assert.equal(runs.length, 1);
  assert.deepEqual(closed, []);
  // Revived editor terminals can lack launch metadata. A name alone cannot authorize Stop or a concurrent retry.
  vscode.window.terminals = [{ name: term.name }];
  assert.equal(replacement.terminal(card), undefined);
  await assert.rejects(replacement.followUpHeadless(card, "Retry"), /verify/i);
  assert.equal(runs.length, 1);
  const foreign = { name: term.name, creationOptions: { ...term.creationOptions, env: { ...term.creationOptions.env, ENTOMATICAL_REPO: repo + "-other" } } };
  vscode.window.terminals = [foreign];
  await replacement.followUpHeadless(card, "After exit");
  assert.equal(runs.length, 2);
  assert.equal(runs[1].creationOptions.env.ENTOMATICAL_SESSION, card.sessionId);
  replacement.dispose();
});

for (const bridge of ["current", "permissions-only", "legacy", "absent"]) {
  test(`RT-01: first dispatch with ${bridge} Codex panel bridge`, { timeout: 30000 }, async (t) => {
    const codex = require("../out/codex.js");
    const fake = require("./fake-codex-use.js").useFakeCodex(codex);
    t.after(fake.done);
    await codex.discoverCodex();
    const { repo } = fixture(), board = open(repo);
    board.codexEditor = () => true;
    board.ensureCodexTrust = async () => {};
    const account = "Codex fixture";
    board.accountList = () => [{ name: account, provider: "codex" }];
    const panelCalls = [], handlers = new Map(), children = [];
    const prepared = t.mock.method(board, "prepareCodexPanel");
    let provider;
    const connection = {
      initialized: true,
      registerProvider: (_name, handler) => { provider = handler; return { dispose() {} }; },
      sendRequest: (_name, id, method, params) => {
        panelCalls.push({ method, params });
        const result = method === "thread/start" ? { thread: { id: "panel-thread" } } : method === "turn/start" ? { turn: { id: "turn" } } : {};
        queueMicrotask(() => provider.onResult({ id, result }));
      },
    };
    t.mock.method(vscode.commands, "executeCommand", async (name, arg) => {
      if (name === "entomatical.codexPanelPrepared") return board.prepareCodexPanel(arg.taskId, arg.launchToken, arg.threadId);
      if (name === "entomatical.codexPanelCanStart") return board.canStartCodexPanel(arg.taskId, arg.launchToken, arg.threadId);
      if (name === "vscode.openWith" || name === "entomatical.codexPanelEvent") return;
      return handlers.get(name)(arg);
    });
    vscode.extensions = { getExtension: () => ({ activate: async () => {} }) };
    vscode.commands.getCommands = async () => [...handlers.keys()];
    vscode.commands.registerCommand = (name, fn) => { handlers.set(name, fn); return { dispose() {} }; };
    t.after(() => { delete vscode.commands.getCommands; delete vscode.commands.registerCommand; delete vscode.extensions; });
    if (bridge === "current") {
      require("../tools/codex-panel-bridge.cjs")(vscode, connection, [], {
        editorPanels: new Map([[{}, { initialRoute: "/local/panel-thread", ready: true }]]),
      });
    } else if (bridge === "permissions-only") {
      // Both c93fb913 and 7ac27fd5 register these commands but lose the launch token after acknowledgement.
      for (const command of ["codexPanelStartWithPermissions", "codexPanelCancelStart", "codexPanelStop"]) {
        handlers.set("entomatical." + command, () => assert.fail(`older bridge received ${command}`));
      }
    } else if (bridge === "legacy") {
      handlers.set("entomatical.codexPanelStart", () => assert.fail("the installed bypass-only bridge received a dispatch"));
    }
    board.startCodexPanel = require("../out/extension.js").codexPanelStarter(board.panelHook);
    board.runCodex = () => {
      const server = fakeAppServer();
      children.push(server);
      return server.child;
    };
    await t.test("unknown saved permission refuses before dispatch", async () => {
      const task = board.add("Fixture", "first dispatch", account);
      board.update(task, { permission: "obsolete" });
      const before = terminals.length;
      await assert.rejects(board.start(task), /Select Ask, Auto or Bypass before starting/);
      assert.deepEqual([children.length, panelCalls.length, terminals.length, task.sessionId], [0, 0, before, undefined]);
    });
    for (const role of [undefined, "judge", "research"]) {
      for (const [permission, ordinarySandbox] of [["ask", "read-only"], ["auto", "workspace-write"], ["bypass", "danger-full-access"], [undefined, "workspace-write"]]) {
        await t.test(`${role ?? "ordinary"} / ${permission ?? "legacy default"}`, { timeout: 5000 }, async () => {
          const sandbox = role ? "read-only" : ordinarySandbox;
          const task = board.add("Fixture", "first dispatch", account, undefined, undefined, undefined, undefined, { permission, role });
          const before = terminals.length, spawned = children.length, first = panelCalls.length;
          assert.equal(board.routeOf(task).mode, permission === "ask" || permission === "auto" ? "terminal" : "editor");
          const terminal = await board.start(task);
          if (permission === "ask" || permission === "auto") {
            assert.ok(terminal);
            assert.deepEqual([terminals.length - before, children.length - spawned, panelCalls.length - first], [1, 0, 0]);
            const args = terminals.at(-1).shellArgs;
            assert.deepEqual(args.filter((a) => /^(approval_policy|sandbox_mode)=/.test(a)), ['approval_policy="on-request"', `sandbox_mode="${sandbox}"`]);
            assert.deepEqual(args.slice(-2), ["--", task.prompt]);
            assert.equal(task.codexEditor, undefined);
            return;
          }
          assert.equal(terminal, undefined);
          assert.equal(terminals.length, before);
          let requests;
          if (bridge === "current") {
            assert.equal(children.length, spawned);
            requests = panelCalls.slice(first);
            provider.onNotification({ method: "turn/completed", params: { threadId: task.sessionId, turn: { id: "turn", status: "completed" } } });
          } else {
            assert.equal(panelCalls.length, first);
            assert.equal(children.length, spawned + 1);
            const server = children[spawned];
            for (const [method, result] of [["initialize", {}], ["thread/start", { thread: { id: "fallback-thread" } }],
              ["thread/name/set", {}], ["turn/start", { turn: { id: "turn" } }]]) {
              const req = await server.next(method);
              server.answer(req.id, result);
            }
            assert.deepEqual(task.codexEditorPolicy, { threadId: "fallback-thread", sandbox });
            requests = server.requests.filter((r) => r.method !== "initialize" && r.method !== "initialized");
            const closed = new Promise((resolve) => board.onChange(() => { if (!board.firstTurn().includes(task.id)) resolve(); }));
            server.notify("turn/completed", {});
            server.child.emit("close", 0);
            await closed;
          }
          assert.deepEqual(requests.map((r) => r.method), ["thread/start", "thread/name/set", "turn/start"]);
          assert.deepEqual([requests[0].params.approvalPolicy, requests[0].params.sandbox], ["never", sandbox]);
          if (bridge === "current") {
            const expected = { threadId: "panel-thread", sandbox };
            if (task.codexEditorPolicy.launchToken !== undefined) expected.launchToken = prepared.mock.calls.at(-1).arguments[1];
            assert.deepEqual(task.codexEditorPolicy, expected);
          } else assert.equal(task.codexEditorPolicy, undefined, "a reset after missing hooks drops the thread policy");
          assert.deepEqual(requests[2].params, { threadId: bridge === "current" ? "panel-thread" : "fallback-thread", input: [{ type: "text", text: task.prompt }] });
        });
      }
    }
  });
}

test("RT-01: invalid persisted modes leave terminal, workflow and editor starts retryable", async (t) => {
  const { repo } = fixture(), board = open(repo);
  const attempts = [];
  board.codexModelReady = async () => { attempts.push("model"); };
  board.ensureCodexTrust = async () => { attempts.push("trust"); };
  board.codexSend = () => "gpt-a";
  board.runCodex = board.startCodexPanel = board.cardTerminals.spawnCommand = () => assert.fail("unexpected dispatch");
  for (const route of ["extension absent", "editor", "auth-prompt", "admission", "card terminal"]) {
    await t.test(route, async () => {
      const task = board.add("Saved card", "initial prompt");
      const workflow = route === "admission" ? { resources: [], admission: ["login"], outcome: "pending" }
        : route === "auth-prompt" ? { resources: ["auth-prompt"], outcome: "pending" } : undefined;
      board.update(task, { provider: "codex", permission: "obsolete", workflow, cardTerminal: route === "card terminal" });
      board.codexEditor = () => route !== "extension absent";
      board.continuations.set(task.id, "saved continuation");
      const before = terminals.length;
      await assert.rejects(board.start(task), /Unknown Codex permission/);
      assert.deepEqual([attempts, terminals.length, task.sessionId, task.worktree, task.branch, task.workflow?.attempt,
        board.firstTurn(), board.continuations.get(task.id)], [[], before, undefined, undefined, undefined, undefined, [], "saved continuation"]);
      assert.equal(sh(repo, "branch", "--list", `task/${task.id}`), "");
    });
  }
  const task = board.add("Retry", "initial prompt");
  board.update(task, { provider: "codex", permission: "auto" });
  board.continuations.set(task.id, "retry this once");
  board.beforeStart = async () => { board.update(task, { permission: "obsolete" }); };
  await assert.rejects(board.start(task), /Unknown Codex permission/);
  assert.deepEqual([task.sessionId, task.worktree, task.branch, board.continuations.get(task.id)], [undefined, undefined, undefined, "retry this once"]);
  assert.equal(sh(repo, "branch", "--list", `task/${task.id}`), "");
  board.beforeStart = async () => {};
  board.update(task, { permission: "ask" });
  const create = t.mock.method(vscode.window, "createTerminal", () => { throw new Error("terminal unavailable"); });
  await assert.rejects(board.start(task), /terminal unavailable/);
  assert.deepEqual([task.sessionId, task.worktree, task.branch, board.continuations.get(task.id)], [undefined, undefined, undefined, "retry this once"]);
  create.mock.restore();
  const before = terminals.length;
  await board.start(task);
  assert.equal(terminals.length, before + 1);
  assert.deepEqual(terminals.at(-1).shellArgs.slice(-2), ["--", "retry this once"]);
  assert.equal(board.continuations.has(task.id), false);
});

test("RT-01: restored Codex cards require valid permissions before Resume, Continue, Open or a queued prompt", async (t) => {
  const { board, task } = withTask();
  board.update(task, { provider: "codex", permission: "obsolete", sessionId: "saved-thread", status: "review" });
  board.continuations.set(task.id, "pending");
  board.codexModelReady = board.ensureCodexTrust = board.runCodex = board.startCodexPanel = () => assert.fail("unexpected launch");
  t.mock.method(require("../out/codex.js"), "queueCodexMessage", () => assert.fail("unexpected queue"));
  const before = [terminals.length, commands.length, sent.length];
  for (const editor of [false, true]) {
    board.update(task, { codexEditor: editor, codexPanelBridge: editor });
    await assert.rejects(board.resume(task, "follow up"), /Unknown Codex permission/);
    await assert.rejects(board.continueTask(task), /Unknown Codex permission/);
    if (editor) await assert.rejects(board.openInCodex(task), /Unknown Codex permission/);
    assert.deepEqual([terminals.length, commands.length, sent.length], before);
    assert.deepEqual([task.sessionId, task.status, board.continuations.get(task.id)], ["saved-thread", "review", "pending"]);
  }
});

test("RT-01: resume an older editor thread by exact id with its effective terminal permissions", async (t) => {
  const { board, worktree } = withTask();
  board.codexModelReady = board.ensureCodexTrust = async () => {};
  board.codexSend = () => "gpt-a";
  board.runCodex = board.startCodexPanel = () => assert.fail("unexpected child or panel start");
  t.mock.method(require("../out/codex.js"), "queueCodexMessage", () => assert.fail("queued onto an unverified thread"));
  for (const [mode, role, sandbox] of [["ask", undefined, "read-only"], ["auto", undefined, "workspace-write"],
    ["bypass", "judge", "read-only"], [undefined, "research", "read-only"]]) {
    await t.test(`${mode ?? "default"} / ${role ?? "ordinary"}`, async () => {
      const task = board.add("Saved editor", "prompt");
      board.update(task, { provider: "codex", permission: mode, role, codexEditor: true, codexPanelBridge: true,
        sessionId: "saved-thread", worktree, status: "review" });
      assert.equal(board.routeOf(task).mode, "terminal");
      const before = [commands.length, terminals.length];
      await assert.rejects(board.openInCodex(task), /Use Resume/);
      assert.deepEqual([commands.length, terminals.length], before);
      const term = await board.resume(task, "next prompt");
      assert.ok(term);
      const args = terminals.at(-1).shellArgs;
      assert.deepEqual([commands.length, terminals.length], [before[0], before[1] + 1]);
      assert.equal(args[0], "resume");
      assert.deepEqual(args.slice(-2), ["saved-thread", "next prompt"]);
      const approval = mode === "ask" || mode === "auto" ? "on-request" : "never";
      assert.deepEqual(args.filter((a) => /^(approval_policy|sandbox_mode)=/.test(a)),
        [`approval_policy="${approval}"`, `sandbox_mode="${sandbox}"`]);
      assert.deepEqual([task.sessionId, task.codexEditor], ["saved-thread", undefined]);
    });
  }
});

test("RT-01: recheck editor thread identity and policy after opening and before queueing", async (t) => {
  const { board, task } = withTask();
  const codex = require("../out/codex.js");
  const queued = [];
  t.mock.method(codex, "queueCodexMessage", (...args) => queued.push(args));
  board.update(task, { provider: "codex", role: "judge", permission: "bypass", codexEditor: true, codexPanelBridge: true,
    codexEditorPolicy: { threadId: "verified", sandbox: "read-only" }, sessionId: "verified", status: "review" });
  const before = terminals.length;
  await board.resume(task, "first");
  assert.deepEqual(queued, [["verified", "first", task.worktree]]);
  const open = t.mock.method(vscode.commands, "executeCommand", async () => { board.update(task, { permission: "auto" }); });
  await assert.rejects(board.continueTask(task), /Use Resume/);
  board.update(task, { permission: "bypass" });
  open.mock.mockImplementation(async () => { board.update(task, { sessionId: "different" }); });
  await assert.rejects(board.resume(task, "do not queue"), /card changed/);
  assert.equal(board.routeOf(task).mode, "terminal");
  board.codexModelReady = board.ensureCodexTrust = async () => {};
  board.codexSend = () => "gpt-a";
  board.runCodex = board.startCodexPanel = () => assert.fail("unexpected start");
  board.continuations.set(task.id, "pending");
  board.update(task, { permission: "auto" });
  for (const editor of [true, false]) {
    board.update(task, { codexEditor: editor });
    await assert.rejects(board.resume(task, "retry on the saved thread"), /confirmed Codex thread/);
    await assert.rejects(board.continueTask(task), /confirmed Codex thread/);
    board.update(task, { sessionId: "verified" });
    board.ensureCodexTrust = async () => { board.update(task, { sessionId: "different" }); };
    await assert.rejects(board.resume(task, "identity changed during preparation"), /confirmed Codex thread/);
  }
  assert.equal(board.continuations.get(task.id), "pending");
  assert.deepEqual(queued, [["verified", "first", task.worktree]]);
  assert.equal(terminals.length, before);
});

const strictPlanBinding = process.env.ENTOMATICAL_TEST_REQUIRE_F78_BINDING === "1";

test("RT-01: an unrelated SessionStart cannot redirect Resume from the provider-confirmed thread", async (t) => {
  const { board, worktree } = withTask();
  board.codexModelReady = board.ensureCodexTrust = async () => {};
  board.codexSend = () => "gpt-a";
  board.runCodex = board.startCodexPanel = () => assert.fail("unexpected start");
  t.mock.method(require("../out/codex.js"), "queueCodexMessage", () => assert.fail("unexpected editor queue"));
  for (const transport of ["bridge", "fallback", "legacy bridge"]) {
    await t.test(transport, async subtest => {
      const task = board.add("Saved editor", "original");
      board.update(task, { provider: "codex", permission: "auto", codexEditor: true, codexPanelBridge: transport !== "fallback",
        sessionId: "provider-thread", codexEditorPolicy: transport === "legacy bridge" ? undefined : { threadId: "provider-thread", sandbox: "workspace-write",
          ...(transport === "bridge" ? { launchToken: "C" } : {}) }, worktree, status: "review" });
      fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: "SessionStart", session_id: "side-thread", transcript_path: null }) + "\n");
      board.syncStatus(task.id);
      assert.equal(board.resetUnstarted(task), false);
      const before = [terminals.length, commands.length];
      await board.resume(task, "resume prompt");
      assert.deepEqual([terminals.length, commands.length], [before[0] + 1, before[1]]);
      const args = terminals.at(-1).shellArgs;
      assert.deepEqual(args.slice(-2), ["provider-thread", "resume prompt"]);
      assert.equal(args[0], "resume");
      assert.ok(args.includes('approval_policy="on-request"') && args.includes('sandbox_mode="workspace-write"'));
      assert.deepEqual([task.sessionId, terminals.at(-1).env.ENTOMATICAL_SESSION], ["provider-thread", "provider-thread"]);
      assert.deepEqual(board.events(task.id), []);
      assert.equal(task.codexEditorPolicy.sandbox, undefined);
      if (transport === "bridge" && !strictPlanBinding) subtest.todo("terminal Resume should retain an existing launch token");
      assert.equal(task.codexEditorPolicy.launchToken, transport === "bridge" ? "C" : undefined);
    });
  }
});

test("RT-01: an active editor or unrelated SessionStart cannot become a second writer or resume --last", async (t) => {
  const { board, task } = withTask();
  board.codexModelReady = board.ensureCodexTrust = async () => {};
  board.runCodex = board.startCodexPanel = () => assert.fail("unexpected dispatch");
  board.update(task, { provider: "codex", permission: "auto", codexEditor: true, sessionId: "saved-thread", status: "review" });
  fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ hook_event_name: "SessionStart", session_id: "side-thread" }) + "\n");
  board.syncStatus(task.id);
  assert.equal(board.resetUnstarted(task), false);
  const before = [terminals.length, commands.length];
  await assert.rejects(board.resume(task, "resume once"), /Cannot confirm the saved Codex thread/);
  fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ hook_event_name: "SessionStart", session_id: task.sessionId, transcript_path: path.join(task.worktree, "saved.jsonl") }) + "\n");
  board.syncStatus(task.id);
  board.update(task, { codexPanelBridge: true });
  board.codexPanelRuns.set(task.id, task.sessionId);
  await assert.rejects(board.continueTask(task), /Stop its current turn/);
  assert.deepEqual([terminals.length, commands.length], before);
  board.codexPanelRuns.delete(task.id);
  const create = vscode.window.createTerminal;
  t.mock.method(vscode.window, "createTerminal", (options) => {
    fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: task.sessionId }) + "\n");
    return create(options);
  });
  await board.continueTask(task);
  assert.deepEqual(terminals.at(-1).shellArgs.slice(-2), ["saved-thread", "Resume."]);
  assert.deepEqual([terminals.length, commands.length], [before[0] + 1, before[1]]);
});

test("editor mode: a direct panel first turn stays on its card and can be stopped", async () => {
  const codex = require("../out/codex.js");
  const fake = require("./fake-codex-use.js").useFakeCodex(codex);
  try {
    await codex.discoverCodex();
    const { repo } = fixture(), board = open(repo);
    board.codexEditor = () => true;
    board.ensureCodexTrust = async () => {};
    board.codexModelIds = () => ["gpt-6.1-sol"];
    const stopped = [];
    board.startCodexPanel = async (task, prompt, token, env) => {
      assert.equal(task.model, "gpt-6.1-sol", "the panel gets the newest id, not the card's short name");
      assert.equal(prompt, "do this\nthen that");
      assert.equal(env.ENTOMATICAL_TASK, task.id);
      assert.equal(env.ENTOMATICAL_REPO, repo);
      assert.equal(env.ENTOMATICAL_RUNTIME, "codex");
      assert.equal(env.ENTOMATICAL_SESSION, undefined);
      assert.equal(board.prepareCodexPanel(task.id, token, "panel-thread", path.join(repo, "panel-rollout.jsonl")), true);
      const route = JSON.parse(fs.readFileSync(path.join(path.dirname(board.panelHook), "panel-sessions", "panel-thread.json"), "utf8"));
      assert.equal(route.events, board.eventsFile(task.id));
      assert.equal(board.canStartCodexPanel(task.id, token, "panel-thread"), true);
      assert.equal(board.events(task.id)[0].hook_event_name, "SessionStart");
      return { threadId: "panel-thread", transcript: path.join(repo, "panel-rollout.jsonl"), completed: false };
    };
    board.stopCodexPanel = async (threadId) => { stopped.push(threadId); };
    const task = board.add("Panel task", "do this\nthen that", "Codex · user@example.test", undefined, "sol");
    await board.start(task);
    assert.deepEqual([task.sessionId, task.codexPanelBridge, task.status, task.model], ["panel-thread", true, "running", "sol"]);
    assert.deepEqual([board.live(), board.own(), board.firstTurn(), board.panelFirstTurn()], [[task.id], [task.id], [task.id], [task.id]]);
    await board.openInCodex(task);
    assert.equal(String(commands.at(-1)[1]), "openai-codex://route/local/panel-thread");
    await assert.rejects(board.finish(task, "merge"), /still running/);
    board.stop(task);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(stopped, ["panel-thread"]);
    board.codexPanelEvent({ taskId: task.id, threadId: "panel-thread", method: "turn/completed", status: "interrupted" });
    assert.deepEqual([task.status, task.interrupted, board.own()], ["review", true, []]);
    await board.resume(task);
    assert.equal(String(commands.at(-1)[1]), "openai-codex://route/local/panel-thread");
    board.accountList = () => [{ name: "Claude test", configDir: "" }];
    assert.equal(board.switchAccount(task, "Claude test"), "start");
    assert.equal(fs.existsSync(path.join(path.dirname(board.panelHook), "panel-sessions", "panel-thread.json")), false);
  } finally { fake.done(); }
});

// Isolate panel launch, hooks and persistence from any installed Codex account or editor.
function planningPanelFixture() {
  const board = open(fixture().repo);
  board.panelHook = path.join(board.repo, "hook.js");
  board.accountList = () => [{ name: "Fixture", provider: "codex" }];
  board.codexModelReady = board.ensureCodexTrust = async () => {};
  board.codexSend = () => undefined;
  board.codexEditor = () => true;
  const task = board.add("", "Propose a change.", "Fixture");
  board.update(task, { planFirst: true });
  const threadId = "panel-thread";
  const journalStop = () => fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({
    t: Date.now(), hook_event_name: "Stop", session_id: threadId, asks: true, last_assistant_message: "Approve the plan?",
  }) + "\n");
  return { board, task, threadId, journalStop };
}

// With extensionTest (the test context), the board starts through the extension's own codexPanelStarter; only the editor and RPC are fixtures.
const stubCommand = Symbol("stub executeCommand");
function panelTransport(board, threadId, onRequest, extensionTest) {
  const handlers = new Map();
  let provider;
  const bridgeHost = { Uri: vscode.Uri, commands: {
    registerCommand: (name, fn) => handlers.set(name, fn),
    executeCommand: async (name, args) => {
      if (name === "entomatical.codexPanelPrepared") return board.prepareCodexPanel(args.taskId, args.launchToken, args.threadId);
      if (name === "entomatical.codexPanelCanStart") return board.canStartCodexPanel(args.taskId, args.launchToken, args.threadId);
      if (name === "entomatical.codexPanelEvent") board.codexPanelEvent(args);
    },
  } };
  require("../tools/codex-panel-bridge.cjs")(bridgeHost, {
    initialized: true,
    registerProvider: (_, handler) => { provider = handler; },
    sendRequest: (_, id, method, params) => {
      if (method === "turn/start" || method === "turn/interrupt") onRequest(provider, id, method, params);
      else provider.onResult({ id, result: method === "thread/start" ? { thread: { id: threadId } } : {} });
    },
  }, [], { editorPanels: new Map([[{}, { initialRoute: "/local/" + threadId, ready: true }]]) });
  board.stopCodexPanel = handlers.get("entomatical.codexPanelStop");
  board.cancelCodexPanelStart = handlers.get("entomatical.codexPanelCancelStart");
  if (extensionTest) {
    // Use the extension's actual command lookup and git/policy payload. Only the editor and RPC transport are fixtures.
    vscode.extensions = { getExtension: () => ({ activate: async () => {} }) };
    vscode.commands.getCommands = async () => [...handlers.keys()];
    // A test may open a second transport (a reopened board): every restore goes back to the stub's own command.
    const own = vscode.commands.executeCommand[stubCommand] ?? vscode.commands.executeCommand;
    vscode.commands.executeCommand = Object.assign((name, options) => handlers.get(name)(options), { [stubCommand]: own });
    extensionTest.after(() => { vscode.commands.executeCommand = own; delete vscode.extensions; delete vscode.commands.getCommands; });
    board.startCodexPanel = require("../out/extension.js").codexPanelStarter(board.panelHook);
    return provider;
  }
  board.startCodexPanel = (card, prompt, launchToken) => handlers.get("entomatical.codexPanelStartWithTokenStopV1")({
    taskId: card.id, launchToken, cwd: card.worktree, prompt, named: true, title: "Plan", sandbox: "read-only", approvalPolicy: "never",
  });
  return provider;
}

function replacementPanelBoard(board) {
  const replacement = open(board.repo);
  replacement.panelHook = board.panelHook;
  replacement.accountList = board.accountList;
  replacement.codexModelReady = board.codexModelReady;
  replacement.ensureCodexTrust = board.ensureCodexTrust;
  replacement.codexSend = board.codexSend;
  replacement.codexEditor = board.codexEditor;
  return replacement;
}

// Deliver genuine B callbacks after C reuses the card and thread on a new Board.
for (const stage of ["prepared", "running", "running after reopen", "retired", "retired after reopen"]) {
  test(`panel callback ownership / ${stage}`, async t => {
    const { board, task, threadId } = planningPanelFixture();
    const held = [];
    t.mock.method(board, "codexPanelEvent", event => held.push(event));
    const b = panelTransport(board, threadId, (provider, id) => provider.onResult({ id, result: { turn: { id: "B" } } }));
    await board.start(task);
    const active = (provider, ...activeFlags) => provider.onNotification({
      method: "thread/status/changed", params: { threadId, status: { type: "active", activeFlags } },
    });
    const end = (provider, id, status) => provider.onNotification({ method: "turn/completed", params: { threadId, turn: { id, status } } });
    active(b);
    end(b, "B", "completed");
    const runningB = held.find(event => event.method === "thread/status/changed");
    const endedB = held.find(event => event.method === "turn/completed");
    assert.ok(runningB.launchToken && runningB.launchToken === endedB.launchToken);

    board.dispose();
    let receiver = replacementPanelBoard(board), card = receiver.get(task.id);
    receiver.update(card, { sessionId: undefined, codexEditorPolicy: undefined, codexPanelBridge: undefined });
    const sent = Promise.withResolvers(), interrupts = [];
    const c = panelTransport(receiver, threadId, (provider, id, method, params) => {
      if (method === "turn/start") sent.resolve(id);
      else { interrupts.push(params); provider.onResult({ id, result: {} }); }
    });
    const starting = receiver.start(card), id = await sent.promise;
    if (stage !== "prepared") {
      c.onResult({ id, result: { turn: { id: "C" } } });
      await starting;
    }
    if (stage.startsWith("retired")) {
      receiver.stop(card);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(interrupts, [{ threadId, turnId: "C" }]);
      end(c, "C", "interrupted");
      assert.deepEqual([card.status, card.interrupted, receiver.panelFirstTurn()], ["review", true, []]);
    } else {
      active(c, "waitingOnApproval");
      assert.equal(card.status, "needs-input");
    }
    receiver.update(card, { deliveryReady: true, checks: { status: "running", run: "C" } });
    if (stage.endsWith("after reopen")) {
      const previous = receiver;
      previous.dispose();
      receiver = open(board.repo);
      card = receiver.get(task.id);
      t.mock.method(previous, "codexPanelEvent", event => receiver.codexPanelEvent(event));
    }
    const before = fs.readFileSync(receiver.file, "utf8"), route = receiver.panelFirstTurn();
    const stopChecks = t.mock.method(receiver.checks, "stop", () => {});
    if (!strictPlanBinding) t.todo("a stale tagged callback must leave the replacement card and route intact");
    try {
      for (const event of stage.startsWith("retired") ? [runningB, endedB] : [endedB, runningB]) {
        receiver.codexPanelEvent(event);
        assert.equal(fs.readFileSync(receiver.file, "utf8"), before, `B's ${event.method} changed C`);
        assert.deepEqual(receiver.panelFirstTurn(), route);
      }
      assert.equal(stopChecks.mock.callCount(), 0);
    } finally {
      if (stage === "prepared") {
        c.onResult({ id, result: { turn: { id: "C" } } });
        await starting;
      }
    }
    if (stage === "prepared" || stage === "running") {
      receiver.stop(card);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(interrupts, [{ threadId, turnId: "C" }]);
    }
    if (!stage.startsWith("retired")) {
      end(c, "C", "completed");
      assert.deepEqual([card.status, card.interrupted, receiver.panelFirstTurn()], ["review", undefined, []]);
    }
  });
}

// Keep the first Board alive and suspend a real command at each boundary across the handoff.
for (const held of ["prepare", "dispatch", "result", "rejection", "result while reader"]) {
  test(`pending panel start after owner takeover / ${held}`, async t => {
    const { board, task, threadId } = planningPanelFixture();
    const waiting = Promise.withResolvers(), release = Promise.withResolvers();
    const prompts = [], interrupts = [];
    panelTransport(board, threadId, (provider, id, method, params) => {
      if (method === "turn/start") prompts.push(params);
      else interrupts.push(params);
      if (method === "turn/start" && held === "rejection") provider.onResult({ id, error: { message: "old launch failed" } });
      else provider.onResult({ id, result: method === "turn/start" ? { turn: { id: "B" } } : {} });
    });
    const boundary = held === "prepare" ? "prepareCodexPanel" : held === "dispatch" ? "canStartCodexPanel" : "startCodexPanel";
    const original = board[boundary].bind(board);
    t.mock.method(board, boundary, async (...args) => {
      if (boundary === "startCodexPanel") {
        try { return await original(...args); }
        finally { waiting.resolve(); await release.promise; }
      }
      waiting.resolve();
      await release.promise;
      return original(...args);
    });
    const startedB = board.start(task);
    await waiting.promise;
    const lease = t.mock.method(board, "isOwner", () => false);
    // The other owner can publish C before the old window polls; reloading C must suffice in either case.
    if (held === "dispatch" || held === "rejection") board.tick();
    const replacement = replacementPanelBoard(board), card = replacement.get(task.id);
    replacement.update(card, { sessionId: undefined, codexEditorPolicy: undefined, codexPanelBridge: undefined });
    const c = panelTransport(replacement, threadId, (provider, id) => provider.onResult({ id, result: { turn: { id: "C" } } }));
    await replacement.start(card);
    const saved = () => JSON.parse(fs.readFileSync(board.file, "utf8")).find(row => row.id === task.id);
    const tokenC = saved().codexEditorPolicy?.launchToken;
    const regain = () => {
      t.mock.method(replacement, "isOwner", () => false);
      lease.mock.restore();
      assert.notEqual(board.reload("confirm"), undefined);
      assert.equal(board.get(task.id).codexEditorPolicy?.launchToken, tokenC);
    };
    if (held !== "result while reader") regain();
    const before = saved();
    t.mock.method(replacement, "codexPanelEvent", event => board.codexPanelEvent(event));
    if (!strictPlanBinding) t.todo("a former owner must preserve the replacement launch through the handoff");
    release.resolve();
    if (held === "result while reader") await assert.rejects(startedB, /[Aa]nother.*window/);
    else await startedB;
    await new Promise(resolve => setImmediate(resolve));
    if (held === "result while reader") regain();
    assert.deepEqual(saved(), before, "B rewrote C's saved card");
    assert.deepEqual(board.panelFirstTurn(), [], "B reinstalled its own Stop route for C");
    assert.equal(prompts.length, boundary === "startCodexPanel" ? 1 : 0);
    assert.deepEqual(interrupts, held === "result" ? [{ threadId, turnId: "B" }] : []);
    c.onNotification({ method: "thread/status/changed", params: { threadId, status: { type: "active", activeFlags: ["waitingOnApproval"] } } });
    assert.deepEqual([saved().codexEditorPolicy.launchToken, saved().status], [tokenC, "needs-input"]);
    c.onNotification({ method: "turn/completed", params: { threadId, turn: { id: "C", status: "completed" } } });
    assert.deepEqual([saved().codexEditorPolicy.launchToken, saved().status], [tokenC, "review"]);
  });
}

test("reloading the same prepared panel token keeps its dispatch and Stop route", async () => {
  const { board, task, threadId } = planningPanelFixture();
  const sent = Promise.withResolvers(), interrupts = [];
  const provider = panelTransport(board, threadId, (provider, id, method, params) => {
    if (method === "turn/start") sent.resolve(id);
    else { interrupts.push(params); provider.onResult({ id, result: {} }); }
  });
  const starting = board.start(task), id = await sent.promise;
  const token = task.codexEditorPolicy.launchToken;
  board.loadedAt = 0; // force the normal poll to read a fresh copy of the same prepared card
  assert.equal(board.reload(), true);
  provider.onResult({ id, result: { turn: { id: "B" } } });
  await starting;
  const card = board.get(task.id);
  assert.deepEqual([card.codexEditorPolicy.launchToken, card.status, board.panelFirstTurn()], [token, "running", [card.id]]);
  board.stop(card);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(interrupts, [{ threadId, turnId: "B" }]);
  provider.onNotification({ method: "turn/completed", params: { threadId, turn: { id: "B", status: "interrupted" } } });
  assert.deepEqual([card.status, card.interrupted, board.panelFirstTurn()], ["review", true, []]);
});

test("panel callback ownership / legacy card or untagged callback", async () => {
  const { board, task, threadId } = planningPanelFixture();
  panelTransport(board, threadId, (provider, id) => provider.onResult({ id, result: { turn: { id: "C" } } }));
  await board.start(task);
  const event = { taskId: task.id, threadId, method: "thread/status/changed", status: { type: "active", activeFlags: ["waitingOnUserInput"] } };
  board.codexPanelEvent(event);
  assert.equal(task.status, "needs-input");
  board.codexPanelEvent({ taskId: task.id, threadId, method: "turn/completed", status: "completed" });
  assert.deepEqual([task.status, board.panelFirstTurn()], ["review", []]);

  // A pre-upgrade card has a verified thread and sandbox, but no saved token to compare.
  board.update(task, { codexEditorPolicy: { threadId, sandbox: "read-only" } });
  board.codexPanelEvent({ ...event, launchToken: "older-bridge-token" });
  assert.equal(task.status, "needs-input");
});

// Hold the acknowledged provider response independently of the Board's ownership lease.
async function holdPanelReceipt(t, board, task, threadId) {
  const interrupts = [];
  const provider = panelTransport(board, threadId, (connection, id, method, params) => {
    if (method === "turn/interrupt") interrupts.push(params);
    connection.onResult({ id, result: method === "turn/start" ? { turn: { id: "B" } } : {} });
  });
  const formed = Promise.withResolvers(), release = Promise.withResolvers(), start = board.startCodexPanel;
  t.mock.method(board, "startCodexPanel", async (...args) => {
    const result = await start(...args);
    formed.resolve(result);
    await release.promise;
    return result;
  });
  const starting = board.start(task).catch(error => {
    assert.match(error.message, /[Aa]nother.*window/);
  });
  const receipt = await formed.promise;
  assert.deepEqual([receipt.threadId, receipt.turnId, receipt.completed], [threadId, "B", false]);
  return { provider, interrupts, receipt, starting, release };
}

for (const timing of ["live while reader", "completed while reader", "live after regain"]) {
  test(`panel ownership checkpoint / unchanged B / ${timing}`, async t => {
    const { board, task, threadId } = planningPanelFixture();
    const { provider, interrupts, receipt, starting, release } = await holdPanelReceipt(t, board, task, threadId);
    const lease = t.mock.method(board, "isOwner", () => false);
    board.tick();
    const other = open(board.repo);
    other.update(other.get(task.id), { title: "Renamed by temporary owner" });
    const disk = () => JSON.parse(fs.readFileSync(board.file, "utf8")).find(c => c.id === task.id);
    const renamed = disk();
    const regain = () => {
      t.mock.method(other, "isOwner", () => false);
      lease.mock.restore();
      board.tick();
      assert.equal(board.get(task.id).title, renamed.title);
    };
    const completed = timing === "completed while reader";
    if (completed) {
      // The native turn retires even if the Board command receiver is unavailable during the handoff.
      const missed = t.mock.method(board, "codexPanelEvent", () => { throw new Error("receiver unavailable"); });
      provider.onNotification({ method: "turn/completed", params: { threadId, turn: { id: "B", status: "completed" } } });
      assert.equal(missed.mock.calls[0].arguments[0].launchToken, receipt.launchToken);
      missed.mock.restore();
    }
    if (timing === "live after regain") regain();
    release.resolve();
    await starting;
    if (timing !== "live after regain") {
      assert.deepEqual(disk(), renamed, "the reader must leave the temporary owner's persisted card intact");
      regain();
    }
    const routeOnRegain = board.panelFirstTurn().includes(task.id);
    if (!completed) {
      provider.onNotification({ method: "thread/status/changed", params: { threadId, status: { type: "active", activeFlags: ["waitingOnApproval"] } } });
      assert.equal(disk().status, "needs-input");
    }
    const route = board.panelFirstTurn().includes(task.id);
    board.stop(board.get(task.id));
    await new Promise(resolve => setImmediate(resolve));
    const byStop = interrupts.slice();
    // Compare the public Board Stop with the same bridge's exact-token route, which coalesces duplicate interrupts.
    await board.cancelCodexPanelStart(receipt.launchToken);
    const exact = [{ threadId, turnId: "B" }];
    assert.deepEqual(interrupts, completed ? [] : exact);
    t.diagnostic(JSON.stringify({ routeOnRegain, route, byStop, afterDirectTokenStop: interrupts }));
    if (completed && !strictPlanBinding) t.todo("a missed terminal callback must not leave a stale Stop route");
    assert.equal(routeOnRegain, !completed);
    assert.deepEqual([route, byStop], completed ? [false, []] : [true, exact]);
  });
}

test("panel ownership checkpoint / held B result with C still provisional", async t => {
  const { board, task, threadId } = planningPanelFixture();
  const { starting, release } = await holdPanelReceipt(t, board, task, threadId);
  const oldLease = t.mock.method(board, "isOwner", () => false);
  board.tick();
  const replacement = replacementPanelBoard(board), card = replacement.get(task.id);
  replacement.update(card, { sessionId: undefined, codexEditorPolicy: undefined, codexPanelBridge: undefined });
  let prompts = 0;
  const providerC = panelTransport(replacement, threadId, (connection, id, method) => {
    if (method === "turn/start") prompts++;
    connection.onResult({ id, result: { turn: { id: "C" } } });
  });
  const preparing = Promise.withResolvers(), proceed = Promise.withResolvers(), prepare = replacement.prepareCodexPanel.bind(replacement);
  t.mock.method(replacement, "prepareCodexPanel", async (...args) => {
    preparing.resolve();
    await proceed.promise;
    return prepare(...args);
  });
  const startingC = replacement.start(card);
  await preparing.promise;
  const saved = () => JSON.parse(fs.readFileSync(board.file, "utf8")).find(c => c.id === task.id);
  const provisional = saved();
  assert.ok(provisional.sessionId && provisional.sessionId !== threadId);
  assert.equal(provisional.codexEditorPolicy?.launchToken, undefined);
  const newLease = t.mock.method(replacement, "isOwner", () => false);
  oldLease.mock.restore();
  board.reload("confirm");
  assert.equal(board.get(task.id).sessionId, provisional.sessionId);
  release.resolve();
  await starting;
  const kept = JSON.stringify(saved()) === JSON.stringify(provisional);
  t.mock.method(board, "isOwner", () => false);
  newLease.mock.restore();
  replacement.reload("confirm");
  proceed.resolve();
  await startingC;
  providerC.onNotification({ method: "thread/status/changed", params: { threadId, status: { type: "active", activeFlags: ["waitingOnApproval"] } } });
  const actual = { kept, prompts, status: saved().status };
  t.diagnostic(JSON.stringify(actual));
  if (!strictPlanBinding) t.todo("a held result must preserve the replacement provisional row before preparation");
  assert.deepEqual(actual, { kept: true, prompts: 1, status: "needs-input" });
});

// Keep the first-turn RPC open after the bridge times out. The board receives that result only after Stop.
async function heldPanelTimeout(t, replyToInterrupt = (connection, id) => connection.onResult({ id, result: {} })) {
  const { board, task, threadId } = planningPanelFixture();
  let startSent = Promise.withResolvers();
  const timedOut = Promise.withResolvers(), deliver = Promise.withResolvers();
  const interrupts = [];
  const provider = panelTransport(board, threadId, (connection, id, method, params) => {
    if (method === "turn/start") startSent.resolve(id);
    else {
      interrupts.push(params);
      replyToInterrupt(connection, id);
    }
  });
  const start = board.startCodexPanel;
  board.startCodexPanel = async (...args) => {
    const result = await start(...args);
    timedOut.resolve(result);
    await deliver.promise;
    return result;
  };
  const setTimer = global.setTimeout;
  let expire;
  t.mock.method(global, "setTimeout", (fn, ms, ...args) => {
    const timer = setTimer(fn, ms, ...args);
    if (ms === 30_000) expire = () => { clearTimeout(timer); fn(); };
    return timer;
  });
  const starting = board.start(task);
  const id = await startSent.promise;
  startSent = Promise.withResolvers();
  expire();
  const result = await timedOut.promise;
  assert.equal(result.uncertain, true);
  board.startCodexPanel = start; // only the original launch result is held
  return { board, task, threadId, provider, id, nextStart: startSent.promise, result, deliver, starting, interrupts, expireLatest: () => expire() };
}

test("B's delayed panel result cannot stop C after C takes the same thread", async t => {
  const { board, task, threadId, provider, id, nextStart, deliver, starting, interrupts } = await heldPanelTimeout(t);
  const cancel = t.mock.method(board, "cancelCodexPanelStart");
  const end = turnId => provider.onNotification({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted" } } });
  provider.onResult({ id, result: { turn: { id: "B" } } });
  await new Promise(resolve => setImmediate(resolve));
  board.stop(task);
  await new Promise(resolve => setImmediate(resolve));
  end("B");

  const replacement = board.add("Replacement", "Run C", "Fixture");
  const startingC = board.start(replacement);
  provider.onResult({ id: await nextStart, result: { turn: { id: "C" } } });
  await startingC;
  assert.equal(replacement.sessionId, threadId);
  deliver.resolve();
  await starting;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(interrupts, [{ threadId, turnId: "B" }]);
  assert.equal(cancel.mock.callCount(), 2);
  assert.deepEqual(cancel.mock.calls[1].arguments, cancel.mock.calls[0].arguments);
  assert.deepEqual([replacement.status, board.panelFirstTurn()], ["running", [replacement.id]]);

  board.stop(replacement);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(interrupts, [{ threadId, turnId: "B" }, { threadId, turnId: "C" }]);
  end("C");
  await board.deliveries;
});

test("delayed cleanup retries a failed cancellation by the original token even if the result omits it", async t => {
  const { board, task, threadId, provider, id, result, deliver, starting, interrupts } = await heldPanelTimeout(t);
  const cancel = t.mock.method(board, "cancelCodexPanelStart");
  cancel.mock.mockImplementationOnce(async () => { throw new Error("fixture cancellation command failed"); });
  delete result.launchToken; // the Board's start result contract doesn't require the bridge to echo it
  provider.onResult({ id, result: { turn: { id: "B" } } });
  await new Promise(resolve => setImmediate(resolve));
  board.stop(task);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(interrupts, []);
  assert.match(warnings.at(-1), /fixture cancellation command failed/);
  deliver.resolve();
  await starting;
  await new Promise(resolve => setImmediate(resolve));
  const tokens = cancel.mock.calls.map(call => call.arguments[0]);
  assert.ok(tokens[0]);
  assert.deepEqual(tokens, [tokens[0], tokens[0]]);
  assert.deepEqual(interrupts, [{ threadId, turnId: "B" }]);
  provider.onNotification({ method: "turn/completed", params: { threadId, turn: { id: "B", status: "interrupted" } } });
  await board.deliveries;
});

for (const failStopSave of [false, true]) {
  test(`panel cancellation across a held timeout result / failed Stop save ${failStopSave}`, async t => {
    const { board, task, threadId, provider, id, deliver, starting, interrupts } = await heldPanelTimeout(t);
    if (failStopSave) {
      const rename = fs.renameSync;
      const fault = t.mock.method(fs, "renameSync", (from, to) => {
        if (to === board.file) throw new Error("fixture: Stop save failed");
        return rename(from, to);
      });
      assert.throws(() => board.stop(task), /Stop save failed/);
      fault.mock.restore();
      board.stop(task); // retry cancellation while the RPC still has no answer
    }
    provider.onResult({ id, result: { turn: { id: "B" } } });
    await new Promise(resolve => setImmediate(resolve)); // process the late ack and release the bridge's start token
    if (!failStopSave) board.stop(task);
    await new Promise(resolve => setImmediate(resolve));
    const beforeDelivery = interrupts.slice(); // the later cleanup cannot satisfy the initial Stop
    deliver.resolve();
    await starting;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(beforeDelivery, [{ threadId, turnId: "B" }]);
    assert.deepEqual(interrupts, [{ threadId, turnId: "B" }]);
    provider.onNotification({ method: "turn/completed", params: { threadId, turn: { id: "B", status: "interrupted" } } });
    await board.deliveries;
    const saved = JSON.parse(fs.readFileSync(board.file, "utf8")).find(card => card.id === task.id);
    assert.deepEqual([saved.status, saved.interrupted, saved.planFirst, board.panelFirstTurn()], ["review", true, true, []]);
    if (failStopSave) assert.equal(saved.codexPlanDispatch?.turnId, undefined, "a late ack bound a dispatch after cancellation");
  });
}

for (const takeover of [false, true]) {
  test(`late planning acknowledgement between failed Stop and retry / owner takeover ${takeover}`, async t => {
    const { board, task, threadId, provider, id, result, deliver, starting, interrupts } = await heldPanelTimeout(t);
    const saved = () => JSON.parse(fs.readFileSync(board.file, "utf8")).find(c => c.id === task.id);
    const prepared = saved();
    const rename = fs.renameSync;
    const fault = t.mock.method(fs, "renameSync", (from, to) => {
      if (to === board.file) throw new Error("fixture: Stop rename failed");
      return rename(from, to);
    });
    assert.throws(() => board.stop(task), /Stop rename failed/);
    fault.mock.restore();
    assert.deepEqual(saved(), prepared);
    let receiver = board;
    if (takeover) {
      board.dispose();
      receiver = open(board.repo);
    }
    // Deliver the actual bridge callback once. Even the replacement gets the exact token and native turn in this test.
    const receive = t.mock.method(receiver, "codexPanelEvent");
    if (takeover) t.mock.method(board, "codexPanelEvent", event => receiver.codexPanelEvent(event));
    const publishedTurns = [];
    receiver.onChange(() => publishedTurns.push(receiver.get(task.id)?.codexPlanDispatch?.turnId));
    provider.onResult({ id, result: { turn: { id: "B" } } });
    await new Promise(resolve => setImmediate(resolve));
    const accepted = receive.mock.calls.map(c => c.arguments[0]).filter(e => e.method === "dispatch/accepted");
    assert.deepEqual(accepted.map(e => [e.taskId, e.threadId, e.launchToken, e.turnId]), [[task.id, threadId, result.launchToken, "B"]]);
    assert.equal(receiver.canStartCodexPanel(task.id, result.launchToken, threadId), false);
    assert.equal(receiver.prepareCodexPanel(task.id, result.launchToken, threadId), false);
    assert.equal(saved().codexPlanDispatch?.turnId, undefined);
    assert.equal(receiver.get(task.id).codexPlanDispatch?.turnId, undefined);
    if (!takeover) receiver.stop(task);
    // Clean up at the host that actually dispatched B. A new host may have no transport route for it.
    else await board.cancelCodexPanelStart(result.launchToken);
    deliver.resolve();
    await starting;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(interrupts, [{ threadId, turnId: "B" }]);
    provider.onNotification({ method: "turn/completed", params: { threadId, turn: { id: "B", status: "interrupted" } } });
    await receiver.deliveries;
    assert.ok(!publishedTurns.includes("B"));
    assert.deepEqual([saved().planFirst, saved().codexPlanDispatch?.turnId], [true, undefined]);
  });
}

for (const [wait, cleanup] of [["waitingOnApproval", "refused"], ["waitingOnUserInput", "refused"],
  ["waitingOnApproval", "accepted"], ["waitingOnApproval", "disconnect"],
  ["waitingOnUserInput", "disconnected before retry"], ["waitingOnApproval", "late refusal"]]) {
  test(`refused panel interrupt and B's fresh ${wait} on the saved card / cleanup ${cleanup}`, async t => {
    const warned = warnings.length, requests = [];
    const { board, task, threadId, provider, id, deliver, starting, interrupts, expireLatest } = await heldPanelTimeout(t, (_, id) => requests.push(id));
    const cancel = t.mock.method(board, "cancelCodexPanelStart");
    const saved = () => JSON.parse(fs.readFileSync(board.file, "utf8")).find(card => card.id === task.id);
    const active = (...activeFlags) => provider.onNotification({ method: "thread/status/changed", params: { threadId, status: { type: "active", activeFlags } } });
    const refuse = id => provider.onResult({ id, error: { message: "fixture interrupt refused" } });
    provider.onResult({ id, result: { turn: { id: "B" } } });
    await new Promise(resolve => setImmediate(resolve));
    board.stop(task);
    await new Promise(resolve => setImmediate(resolve));
    active();
    const unsent = cleanup === "disconnected before retry";
    const pending = saved();
    refuse(requests[0]);
    active(wait); // a native notification can immediately follow the RPC error, before its promise handlers run
    const afterTokenRefusal = saved();
    await new Promise(resolve => setImmediate(resolve));
    active();
    if (unsent) provider.onFatalError(new Error("fixture disconnected before cleanup"));
    deliver.resolve(); // the old result triggers the Board's cleanup interrupt
    await starting;
    await new Promise(resolve => setImmediate(resolve));
    if (!unsent) active(wait); // an interrupt that reached the wire protects the cancelled launch while pending
    const beforeRetryReply = saved();
    if (unsent) provider.onInitialized();
    else if (cleanup === "late refusal") {
      expireLatest();
      await new Promise(resolve => setImmediate(resolve));
      active(wait);
      assert.equal(saved().status, "running", "a timeout alone cannot report a refusal");
      refuse(requests[1]);
    } else if (cleanup === "refused") refuse(requests[1]);
    else if (cleanup === "accepted") provider.onResult({ id: requests[1], result: {} });
    else { provider.onFatalError(new Error("fixture disconnected during interrupt")); provider.onInitialized(); }
    await new Promise(resolve => setImmediate(resolve));
    active(wait);
    const after = saved();
    provider.onNotification({ method: "turn/completed", params: { threadId, turn: { id: "B", status: "interrupted" } } });
    await board.deliveries;
    assert.deepEqual([pending.status, pending.interrupted], ["review", true]);
    const exact = { threadId, turnId: "B" };
    assert.deepEqual(interrupts, unsent ? [exact] : [exact, exact]);
    assert.equal(cancel.mock.callCount(), 2);
    assert.deepEqual(cancel.mock.calls[1].arguments, cancel.mock.calls[0].arguments);
    assert.deepEqual(warnings.slice(warned).filter(w => w.includes("fixture interrupt refused")),
      ["Entomatical: could not cancel Codex's panel start: fixture interrupt refused"]);
    assert.equal(afterTokenRefusal.status, "needs-input");
    assert.equal(beforeRetryReply.status, "running");
    assert.equal(after.status, unsent || cleanup === "refused" || cleanup === "late refusal" ? "needs-input" : "running");
  });
}

for (const failure of ["metadata rejection", "prepare save"]) {
  test(`panel launch failure after the early SessionStart is surfaced / ${failure}`, async t => {
    const { board, task, threadId } = planningPanelFixture();
    board.startCodexPanel = async (card, prompt, token) => {
      fs.appendFileSync(board.eventsFile(card.id), JSON.stringify({ t: Date.now(), hook_event_name: "SessionStart",
        session_id: threadId, transcript_path: path.join(board.repo, "rollout.jsonl") }) + "\n");
      board.syncStatus(card.id);
      assert.equal(task.sessionId, threadId);
      if (failure === "metadata rejection") throw new Error("fixture: metadata rejection");
      const rename = fs.renameSync;
      const fault = t.mock.method(fs, "renameSync", (from, to) => {
        if (to === board.file) throw new Error("fixture: prepare save");
        return rename(from, to);
      });
      try { board.prepareCodexPanel(card.id, token, threadId); }
      finally { fault.mock.restore(); }
      assert.fail("prepare unexpectedly succeeded");
    };
    await assert.rejects(board.start(task), new RegExp("fixture: " + failure));
    const saved = JSON.parse(fs.readFileSync(board.file, "utf8")).find(card => card.id === task.id);
    assert.equal(saved.planFirst, true);
    assert.equal(board.panelFirstTurn().length, 0);
    if (failure === "metadata rejection") assert.equal(saved.status, "queued");
    if (saved.status === "queued") {
      assert.equal(saved.sessionId, undefined);
      panelTransport(board, threadId, (connection, id) => connection.onResult({ id, result: { turn: { id: "retry" } } }));
      await board.start(task);
      assert.deepEqual([task.status, task.sessionId], ["running", threadId]);
    } else assert.deepEqual([saved.status, saved.interrupted], ["review", true]);
  });
}

// F78 final-gate checkpoint (card 927417, review 9e6652; docs/evidence/f78-final-gate-checkpoint.md). Tests only: the production
// candidates were withdrawn (backup branch backup/927417-f78-gate-b4df22fd). Each case drives the extension's codexPanelStarter and the
// shipping bridge with a synthetic RPC transport, changes the card after the bridge prepared its thread, and records only what reaches
// the provider or Resume's send boundary. An outstanding requirement is a TODO; ENTOMATICAL_TEST_REQUIRE_F78_GATE=1 requires it.
const strictGate = process.env.ENTOMATICAL_TEST_REQUIRE_F78_GATE === "1";
async function finalGateCase(t, change, afterPreparation) {
  const { board, task: planned, threadId } = planningPanelFixture();
  let task = planned;
  const other = board.add("Not finished", "Separate work", "Fixture");
  if (change.includes("governed")) {
    const root = board.add("Governed root", "Run it.", "Fixture");
    board.update(root, { governed: { v: 1, limits: { active: 3, directChildren: 2, depth: 2 }, profiles: { "provider-defaults": { mode: "provider-defaults" } },
      delegation: { allowed: ["provider-defaults"], defaultChild: "provider-defaults", depth: 2 }, leases: [], seq: 0 } });
    task = board.add("Governed subtask", "Propose a change.", "Fixture", root.id);
    assert.equal(task.profile?.mode, "provider-defaults");
    board.update(task, { planFirst: true, dependsOn: [other.id] });
    board.update(other, { status: "done" });
  }
  if (change.startsWith("queued")) board.update(task, { held: true });
  const prompts = [];
  panelTransport(board, threadId, (rpc, id, method, params) => { prompts.push([method, params.threadId]); rpc.onResult({ id, result: { turn: { id: "turn" } } }); }, t);
  const prepare = board.prepareCodexPanel.bind(board);
  t.mock.method(board, "prepareCodexPanel", (...args) => {
    const prepared = prepare(...args);
    if (change.includes("unfinished Start after card")) board.update(task, { dependsOn: [other.id] });
    if (change.includes("already Done")) { board.update(other, { status: "done" }); board.update(task, { dependsOn: [other.id] }); }
    if (change.includes("cancelled")) board.update(other, { cancelled: true });
    if (change.includes("permission Ask")) board.update(task, { permission: "ask" });
    if (change.includes("permission Bypass")) board.update(task, { permission: "bypass" });
    afterPreparation?.(board, task);
    return prepared;
  });
  const gate = t.mock.method(board, "canStartCodexPanel");
  let error;
  const launch = () => board.start(task).catch(e => { error = e.message; throw e; });
  const dispatched = task.held ? await board.dispatchHeld(task, launch) : await launch().catch(() => undefined);
  return { board, task, other, threadId, prompts, gate, error, dispatched };
}
const panelRoute = (board, threadId) => path.join(path.dirname(board.panelHook), "panel-sessions", threadId + ".json");
// The same repository opened by a new Board, with the panel fixture's stand-ins.
function reopenPlanning(board) {
  board.dispose();
  const again = open(board.repo);
  again.panelHook = board.panelHook;
  again.accountList = () => [{ name: "Fixture", provider: "codex" }];
  again.codexModelReady = again.ensureCodexTrust = async () => {};
  again.codexSend = () => undefined;
  again.codexEditor = () => true;
  return again;
}
// The extension's own card action (handle), compiled with it exported, as test/resume.test.js does.
function extensionAction() {
  const filename = require.resolve("../out/extension.js"), extension = new Module(filename, module);
  extension.filename = filename;
  extension.paths = Module._nodeModulePaths(path.dirname(filename));
  extension._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.action = handle;\n", filename);
  return extension.exports.action;
}

// 1. The final gate after preparation. Outstanding on d77720f9: a queued card's new unfinished Start after card and a governed subtask's
// cancelled dependency still let turn/start go out. A manual Start still passes over Start after, as when pressed.
for (const [change, sends, outstanding] of [
  ["nothing", true],
  ["queued: unfinished Start after card", false, true],
  ["queued: Start after card already Done", true],
  ["manual Start: unfinished Start after card", true],
  ["governed subtask: dependency cancelled", false, true],
  ["permission Ask", false],
  ["permission Bypass", false],
]) {
  test(`F78 checkpoint: the final panel gate after preparation / ${change}`, async t => {
    const { board, gate, prompts } = await finalGateCase(t, change);
    t.after(() => board.dispose());
    assert.equal(gate.mock.callCount(), 1);
    const actual = { gate: gate.mock.calls[0].result, prompts: prompts.map(([method]) => method) };
    t.diagnostic(JSON.stringify(actual));
    if (outstanding && !strictGate) t.todo("a card that stopped being eligible during preparation must send no prompt");
    assert.deepEqual(actual, sends ? { gate: true, prompts: ["turn/start"] } : { gate: false, prompts: [] });
  });
}

// 2. A launch that sent nothing must not become a session Resume can continue past first-launch checks, also after a reload. A governed
// subtask's dependency is cancelled during preparation (the gate refuses for it, or for permission Ask as well), or after a launch whose
// gate passed and whose SessionStart journal write then failed before turn/start. Resume runs through the extension's own card action;
// reaching Board.resume, Board.send or a new panel start counts as sending.
for (const failure of ["the gate refuses for the dependency", "the gate refuses for permission Ask",
  "the gate passes, its SessionStart journal write fails, the dependency is cancelled afterwards"]) {
  test(`F78 checkpoint: Resume after an unsent panel launch, reload, governed dependency still cancelled / ${failure}`, async t => {
    const append = fs.appendFileSync;
    let journalFault;
    const afterwards = failure.includes("afterwards");
    const c = await finalGateCase(t, afterwards ? "governed subtask" : "governed subtask: dependency cancelled" + (failure.includes("Ask") ? ", permission Ask" : ""), (board, task) => {
      if (failure.includes("journal")) journalFault = t.mock.method(fs, "appendFileSync", (file, data, ...rest) => {
        if (file === board.eventsFile(task.id) && String(data).includes('"panel-bridge"')) throw new Error("fixture: journal write failed");
        return append(file, data, ...rest);
      });
    });
    journalFault?.mock.restore();
    if (afterwards) c.board.update(c.other, { cancelled: true });
    const launchPrompts = c.prompts.map(([method]) => method);
    const board = reopenPlanning(c.board);
    t.after(() => board.dispose());
    const task = board.get(c.task.id);
    board.tick();
    const reached = [];
    for (const name of ["resume", "send", "startCodexPanel"]) t.mock.method(board, name, async () => { reached.push(name); throw new Error("fixture: Resume reached a send"); });
    vscode.workspace = { getConfiguration: () => ({ get: () => undefined }) };
    t.after(() => { delete vscode.workspace; });
    const resumeError = await extensionAction()(board, { type: "resume", id: task.id }).then(() => undefined, e => e.message);
    const actual = { launchPrompts, resumeReached: reached };
    t.diagnostic(JSON.stringify({ ...actual, launchError: c.error, resumeError, card: [task.status, !!task.sessionId] }));
    if (!strictGate) t.todo("an unsent launch must leave nothing Resume can send on while the card is not eligible");
    assert.deepEqual(actual, { launchPrompts: [], resumeReached: [] });
  });
}

// 3. A queued card refused at the gate sends nothing while ineligible, and its original prompt exactly once when its Start after card is
// Done, also after a reload.
test("F78 checkpoint: a queued card's original prompt goes out exactly once, after its Start after card is Done", async t => {
  const c = await finalGateCase(t, "queued: unfinished Start after card");
  const beforeDone = c.prompts.map(([method]) => method);
  const board = reopenPlanning(c.board);
  t.after(() => board.dispose());
  const task = board.get(c.task.id);
  board.update(board.get(c.other.id), { status: "done" });
  const prompts = [];
  panelTransport(board, "panel-thread-2", (rpc, id, method, params) => {
    prompts.push(params.input?.map(i => i.text).join(""));
    rpc.onResult({ id, result: { turn: { id: "turn-2" } } });
  }, t);
  const launches = t.mock.method(board, "startCodexPanel");
  const states = [];
  for (let i = 0; i < 2; i++) states.push((await board.dispatchHeld(task, () => board.start(task))).state);
  const original = launches.mock.calls[0]?.arguments[1];
  const actual = { beforeDone, afterDone: prompts.length, original: !!original && prompts[0] === original && /Propose a change\./.test(original), states };
  t.diagnostic(JSON.stringify(actual));
  if (!strictGate) t.todo("the refused queued card must start once eligible, with its original prompt, exactly once");
  assert.deepEqual(actual, { beforeDone: [], afterDone: 1, original: true, states: ["started", "waiting"] });
});

// 4. Regression guard for the withdrawn b440258b: a refusal must not delete a hook route another owner wrote for that thread.
test("F78 checkpoint: a refused panel launch leaves a hook route another owner wrote for its thread", async t => {
  const elsewhere = { events: path.join(os.tmpdir(), "other-owner", "events.jsonl") };
  const c = await finalGateCase(t, "permission Ask", (board) => fs.writeFileSync(panelRoute(board, "panel-thread"), JSON.stringify(elsewhere)));
  t.after(() => c.board.dispose());
  assert.deepEqual([c.prompts, c.gate.mock.calls[0].result], [[], false]);
  assert.deepEqual(JSON.parse(fs.readFileSync(panelRoute(c.board, c.threadId), "utf8")), elsewhere);
});

test("direct planning turn: the acknowledged turn reaches first Review with only SessionStart journaled", async t => {
  const receipt = require("./fixtures/direct-panel-planning-turn.json");
  const { board, task } = planningPanelFixture();
  const { thread, turn, finalAnswer, completedAt } = receipt.rollout;
  const notices = receipt.panelAppServer.filter(e => e.event === "notice");
  const ack = receipt.panelAppServer.find(e => e.event === "response" && e.method === "turn/start");
  const sent = Promise.withResolvers();
  const requests = [];
  const connection = panelTransport(board, thread, (_, id, method, params) => {
    requests.push([method, params.threadId]);
    sent.resolve(id);
  });
  const launch = t.mock.method(board, "startCodexPanel");
  const callbacks = t.mock.method(board, "codexPanelEvent");
  const snapshot = card => ({ status: card.status, planFirst: !!card.planFirst, asks: !!card.asks, interrupted: !!card.interrupted });
  const saved = () => JSON.parse(fs.readFileSync(board.file, "utf8")).find(c => c.id === task.id);
  const reviews = [];
  let firstRedraw;
  board.onChange(() => {
    if (task.status === "review" && !firstRedraw) firstRedraw = { memory: snapshot(task), disk: snapshot(saved()), lastReply: board.lastReply(task) ?? null };
  });
  board.onStatus(({ to }) => { if (to === "review") reviews.push(snapshot(task)); });

  const starting = board.start(task);
  const id = await sent.promise;
  connection.onResult({ id, result: { turn: { id: ack.turn, status: ack.status } } });
  const notify = e => connection.onNotification({ method: e.method, params: { threadId: e.thread, turn: { id: e.turn, status: e.status } } });
  const [started, completed] = notices;
  notify(started);
  await starting;
  const result = await launch.mock.calls[0].result;
  const launchToken = launch.mock.calls[0].arguments[2];
  assert.ok(launchToken);
  assert.deepEqual([result.launchToken, result.threadId, result.turnId, result.completed], [launchToken, thread, turn, false]);
  const running = saved();
  assert.deepEqual([running.status, running.planFirst, running.sessionId, running.codexEditorPolicy.threadId], ["running", true, thread, thread]);
  const binding = running.codexPlanDispatch;
  if (binding !== undefined || process.env.ENTOMATICAL_TEST_REQUIRE_F78_BINDING === "1") {
    assert.deepEqual([binding?.launchToken, binding?.threadId, binding?.turnId], [launchToken, thread, turn],
      "the acknowledged planning dispatch must be saved while Running");
  }

  // Reconstruct the private provider file from retained fields. Leave the path out of the board hook and panel messages.
  const day = path.join(process.env.CODEX_HOME, "sessions", ...completedAt.slice(0, 10).split("-"));
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-${completedAt.slice(0, 10)}T00-00-00-${thread}.jsonl`);
  const rows = [{ type: "session_meta", payload: { id: thread, originator: receipt.rollout.originator } },
    { timestamp: completedAt, type: "event_msg", payload: { type: "task_complete", turn_id: turn, last_agent_message: finalAnswer } }];
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  const row = JSON.parse(fs.readFileSync(file, "utf8").trimEnd().split("\n").at(-1));
  const fact = require("../out/codex.js").rolloutTerminalFact(row);
  assert.deepEqual([fact.threadAttribution, fact.turnId, fact.outcome, fact.reply], ["unknown", result.turnId, "completed", finalAnswer]);
  assert.match(fact.reply, /approve this plan\?$/);
  assert.equal(firstRedraw, undefined, "writing the private rollout alone did not publish Review");
  notify(completed);
  await board.deliveries;
  const reported = callbacks.mock.calls.map(call => call.arguments[0]).filter(e => e.method.startsWith("turn/"));
  assert.deepEqual(reported.map(e => [e.method, e.threadId, e.turnId, e.launchToken, e.status]),
    [["turn/started", thread, turn, launchToken, "inProgress"], ["turn/completed", thread, turn, launchToken, "completed"]]);
  assert.deepEqual(board.events(task.id).map(e => [e.hook_event_name, e.session_id]), [["SessionStart", thread]]);
  assert.deepEqual(reviews, [firstRedraw.memory]);
  assert.deepEqual(firstRedraw.disk, firstRedraw.memory);
  assert.equal(firstRedraw.memory.interrupted, false);
  assert.deepEqual(requests, [["turn/start", thread]]);
  // Report the observed fields without making the stale chip a requirement for future implementations.
  t.diagnostic(JSON.stringify({ boundBeforeCompletion: binding?.turnId === turn, firstBoardRedraw: firstRedraw }));
});

// These comparisons exercise the extension starter, shipping bridge, Board callbacks and on-disk hook lookup.
// Run with the existing strict F78 switch to require each outstanding invariant.
function runPanelHook(board, threadId, name, turnId) {
  execFileSync(process.execPath, [board.panelHook], {
    env: { ...process.env, ENTOMATICAL_EVENTS: "", ENTOMATICAL_RUNTIME: "", ENTOMATICAL_TERMINAL_LAUNCH: "" },
    input: JSON.stringify({ session_id: threadId, hook_event_name: name, transcript_path: path.join(board.repo, "rollout.jsonl"),
      ...(name === "Stop" && { turn_id: turnId, last_assistant_message: "Approve this plan?" }) }),
  });
}

function panelHookJournal(board, taskId) {
  const file = board.eventsFile(taskId);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trimEnd().split("\n").filter(Boolean).map(JSON.parse) : [];
}

function journalStops(board, taskId) {
  return panelHookJournal(board, taskId).filter(e => e.hook_event_name === "Stop").map(e => [e.session_id, e.turn_id]);
}

for (const routeOwner of ["foreign", "foreign with write fault", "empty with write fault", "own"]) {
  test(`planning first prepare preserves hook ownership / ${routeOwner}`, async t => {
    const { board, task, threadId } = planningPanelFixture();
    t.after(() => board.dispose());
    const other = board.add("Other planning card", "Separate plan", "Fixture");
    const foreign = routeOwner.startsWith("foreign"), own = routeOwner === "own";
    board.update(other, { planFirst: true, sessionId: foreign ? threadId : "other-thread", status: "running" });
    fs.copyFileSync(path.join(__dirname, "..", "hook", "hook.js"), board.panelHook);
    const routes = path.join(board.repo, "panel-sessions"), route = path.join(routes, threadId + ".json");
    fs.mkdirSync(routes);
    if (foreign || own) fs.writeFileSync(route, JSON.stringify({ events: board.eventsFile(foreign ? other.id : task.id) }));
    const prompts = [];
    panelTransport(board, threadId, (rpc, id, method) => {
      prompts.push(method);
      rpc.onResult({ id, result: { turn: { id: "fixture-turn" } } });
    }, t);
    const prepare = t.mock.method(board, "prepareCodexPanel");
    const rename = fs.renameSync;
    let refusedWrite = false;
    if (routeOwner.endsWith("fault")) t.mock.method(fs, "renameSync", (from, to) => {
      if (to === board.file && !refusedWrite) {
        const row = JSON.parse(fs.readFileSync(from)).find(c => c.id === task.id);
        if (row.sessionId === threadId && row.codexPanelBridge) {
          refusedWrite = true;
          // The hook is a separate process. Rolling back a route after this point cannot recall an appended event.
          runPanelHook(board, threadId, "UserPromptSubmit");
          throw new Error("fixture: prepared-row rename refused");
        }
      }
      return rename(from, to);
    });
    let error;
    try { await board.start(task); } catch (e) { error = e.message; }
    assert.equal(prepare.mock.callCount(), 1);
    if (routeOwner === "empty with write fault") assert.equal(refusedWrite, true);
    if (refusedWrite) assert.match(error, /prepared-row rename refused/);
    const disk = card => JSON.parse(fs.readFileSync(board.file)).find(c => c.id === card.id);
    const afterLaunch = disk(task);
    const dest = fs.existsSync(route) ? JSON.parse(fs.readFileSync(route)).events : undefined;
    for (const name of ["SessionStart", "Stop"]) runPanelHook(board, threadId, name, "fixture-turn");
    board.syncStatus(task.id);
    board.syncStatus(other.id);
    const state = card => [card.status, !!card.planFirst, !!card.asks];
    const actual = { rejected: !!error, prompts, route: dest === board.eventsFile(task.id) ? "launching" : dest === board.eventsFile(other.id) ? "other" : dest,
      afterLaunch: [afterLaunch.status, afterLaunch.sessionId != null], launching: state(disk(task)),
      stops: [journalStops(board, task.id), journalStops(board, other.id)] };
    const review = ["review", false, true], queued = ["queued", true, false];
    const expected = { rejected: !own, prompts: own ? ["turn/start"] : [], route: own ? "launching" : foreign ? "other" : undefined,
      afterLaunch: own ? ["running", true] : ["queued", false], launching: own ? review : queued,
      stops: [own ? [[threadId, "fixture-turn"]] : [], foreign ? [[threadId, "fixture-turn"]] : []] };
    assert.deepEqual(state(task), actual.launching);
    assert.deepEqual(state(other), state(disk(other)));
    if (!foreign) assert.deepEqual(state(disk(other)), ["running", true, false]);
    t.diagnostic(JSON.stringify({ ...actual, other: state(disk(other)) }));
    if (!own && !strictPlanBinding) t.todo("first preparation must preserve hook ownership across rejection");
    const premature = panelHookJournal(board, task.id).filter(e => e.hook_event_name === "UserPromptSubmit").length;
    assert.deepEqual({ ...actual, premature }, { ...expected, premature: 0 });
  });
}

for (const outage of [false, true]) {
  test(`planning hook route contested at installation / storage outage ${outage}`, async t => {
    const { board, task, threadId } = planningPanelFixture();
    t.after(() => board.dispose());
    const other = board.add("Route owner", "Keep my hooks.", "Fixture");
    board.update(other, { planFirst: true, sessionId: threadId, status: "running" });
    fs.copyFileSync(path.join(__dirname, "..", "hook", "hook.js"), board.panelHook);
    const route = path.join(board.repo, "panel-sessions", threadId + ".json");
    const saved = () => JSON.parse(fs.readFileSync(board.file)).find(c => c.id === task.id);
    let contested = false, preparedAtCollision = false;
    const compete = () => {
      if (contested) return;
      // A distinct writer obtains the initially empty name after inspection, immediately before publication.
      execFileSync(process.execPath, ["-e",
        'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({events: process.argv[2]}), {flag:"wx"})',
        route, board.eventsFile(other.id)]);
      contested = true;
      preparedAtCollision = saved().sessionId === threadId && saved().codexPanelBridge === true;
    };
    const rename = fs.renameSync, link = fs.linkSync, openFile = fs.openSync;
    t.mock.method(fs, "linkSync", (from, to) => { if (to === route) compete(); return link(from, to); });
    t.mock.method(fs, "openSync", (file, flags, ...rest) => {
      if (file === route && typeof flags === "string" && flags.includes("x")) compete();
      return openFile(file, flags, ...rest);
    });
    t.mock.method(fs, "renameSync", (from, to) => {
      if (to === route) compete();
      if (to === board.file && contested && outage) throw new Error("fixture: storage unavailable after contention");
      return rename(from, to);
    });
    const prompts = [];
    panelTransport(board, threadId, (rpc, id, method) => {
      prompts.push(method); rpc.onResult({ id, result: { turn: { id: "fixture-turn" } } });
    }, t);
    let error;
    try { await board.start(task); } catch (e) { error = e.message; }
    assert.ok(contested, "the independent writer obtained the empty route name");
    const row = saved();
    // Storage recovers and the hook uses only the public route.
    t.mock.restoreAll();
    for (const name of ["SessionStart", "Stop"]) runPanelHook(board, threadId, name, "fixture-turn");
    board.syncStatus(task.id);
    board.syncStatus(other.id);
    const actual = { rejected: !!error, prompts, foreignRouteKept: JSON.parse(fs.readFileSync(route)).events === board.eventsFile(other.id),
      preparedLoser: row.sessionId === threadId && !!row.codexPanelBridge, stops: [journalStops(board, task.id), journalStops(board, other.id)],
      launchingPlan: !!task.planFirst, launchingAsks: !!task.asks };
    t.diagnostic(JSON.stringify({ preparedAtCollision, ...actual }));
    if (!strictPlanBinding) t.todo("a losing installer must leave the winner's route and hooks intact even if the next save fails");
    assert.deepEqual(actual, { rejected: true, prompts: [], foreignRouteKept: true, preparedLoser: false, stops: [[], [[threadId, "fixture-turn"]]], launchingPlan: true, launchingAsks: false });
  });
}

for (const foreign of [true, false]) {
  test(`planning hook route at card removal / foreign ${foreign}`, t => {
    const { board, task, threadId } = planningPanelFixture();
    t.after(() => board.dispose());
    const other = board.add("Other card", "Wait for the reply.", "Fixture");
    board.update(task, { sessionId: threadId, codexPanelBridge: true, status: "review" });
    board.update(other, { sessionId: foreign ? threadId : "unrelated-thread", status: "running", planFirst: true });
    fs.copyFileSync(path.join(__dirname, "..", "hook", "hook.js"), board.panelHook);
    const dir = path.join(board.repo, "panel-sessions"), route = path.join(dir, threadId + ".json");
    fs.mkdirSync(dir);
    fs.writeFileSync(route, JSON.stringify({ events: board.eventsFile(foreign ? other.id : task.id) }));
    board.remove(task);
    assert.equal(board.get(task.id), undefined);
    for (const name of ["SessionStart", "Stop"]) runPanelHook(board, threadId, name, "fixture-turn");
    board.syncStatus(other.id);
    const actual = [fs.existsSync(route), journalStops(board, other.id)];
    if (!foreign) assert.deepEqual([other.status, !!other.asks], ["running", false]);
    t.diagnostic(JSON.stringify(actual));
    if (foreign && !strictPlanBinding) t.todo("removal must leave another card's route intact");
    assert.deepEqual(actual, foreign ? [true, [[threadId, "fixture-turn"]]] : [false, []]);
  });
}

test("planning hook route cleanup cannot unlink a replacement installed by a second writer", t => {
  const { board, task, threadId } = planningPanelFixture();
  t.after(() => board.dispose());
  const other = board.add("Replacement", "Read my reply.", "Fixture");
  board.update(task, { sessionId: threadId, codexPanelBridge: true, status: "review" });
  board.update(other, { sessionId: threadId, status: "running", planFirst: true });
  fs.copyFileSync(path.join(__dirname, "..", "hook", "hook.js"), board.panelHook);
  const dir = path.join(board.repo, "panel-sessions"), route = path.join(dir, threadId + ".json");
  fs.mkdirSync(dir);
  fs.writeFileSync(route, JSON.stringify({ events: board.eventsFile(task.id) }));
  let replaced = false;
  function releaseThenInstall(file) {
    if (file !== route || replaced) return;
    // A second remover finishes releasing the old owner's file, then a new writer takes the empty name.
    execFileSync(process.execPath, ["-e", [
      'const fs = require("node:fs"), [file, old, next] = process.argv.slice(1);',
      'if (JSON.parse(fs.readFileSync(file)).events !== old) throw Error("unexpected initial route");',
      'fs.unlinkSync(file);',
      'fs.writeFileSync(file, JSON.stringify({events:next}), {flag:"wx"});',
    ].join("\n"), route, board.eventsFile(task.id), board.eventsFile(other.id)]);
    replaced = true;
  }
  for (const method of ["rmSync", "unlinkSync"]) {
    const original = fs[method];
    t.mock.method(fs, method, (file, ...args) => { releaseThenInstall(file); return original(file, ...args); });
  }
  board.remove(task);
  assert.equal(replaced, true);
  for (const name of ["SessionStart", "Stop"]) runPanelHook(board, threadId, name, "fixture-turn");
  board.syncStatus(other.id);
  if (!strictPlanBinding) t.todo("cleanup must still own the entry at unlink");
  assert.deepEqual([fs.existsSync(route), journalStops(board, other.id)], [true, [[threadId, "fixture-turn"]]]);
});

test("planning hook route is readable when the prepared row is first published", async t => {
  const { board, task, threadId } = planningPanelFixture();
  t.after(() => board.dispose());
  fs.copyFileSync(path.join(__dirname, "..", "hook", "hook.js"), board.panelHook);
  let observed;
  board.onChange(() => {
    if (observed !== undefined || !task.codexPanelBridge) return;
    const row = JSON.parse(fs.readFileSync(board.file)).find(c => c.id === task.id);
    assert.deepEqual([row.sessionId, row.codexPanelBridge], [threadId, true]);
    runPanelHook(board, threadId, "UserPromptSubmit");
    observed = board.events(task.id).some(e => e.hook_event_name === "UserPromptSubmit" && e.session_id === threadId);
  });
  panelTransport(board, threadId, (rpc, id) => rpc.onResult({ id, result: { turn: { id: "first" } } }), t);
  await board.start(task);
  assert.equal(observed, true, "an independent hook saw the committed preparation");
});

test("planning hook route survives takeover and is released for a fresh card on removal", async t => {
  const { board, task, threadId } = planningPanelFixture();
  fs.copyFileSync(path.join(__dirname, "..", "hook", "hook.js"), board.panelHook);
  const acknowledgedTurns = [];
  const reply = (rpc, id, method) => {
    assert.equal(method, "turn/start");
    const turnId = "turn-" + (acknowledgedTurns.length + 1);
    acknowledgedTurns.push(turnId);
    rpc.onResult({ id, result: { turn: { id: turnId } } });
  };
  panelTransport(board, threadId, reply, t);
  await board.start(task);
  const route = path.join(board.repo, "panel-sessions", threadId + ".json");
  const previous = fs.readFileSync(route);
  board.dispose();
  const replacement = open(board.repo);
  t.after(() => replacement.dispose());
  replacement.panelHook = board.panelHook;
  assert.deepEqual(fs.readFileSync(route), previous);
  assert.deepEqual(acknowledgedTurns, ["turn-1"]);
  runPanelHook(replacement, threadId, "Stop", acknowledgedTurns[0]);
  assert.deepEqual(journalStops(replacement, task.id), [[threadId, "turn-1"]]);
  replacement.syncStatus(task.id);
  const saved = replacement.get(task.id);
  assert.deepEqual([saved.status, !!saved.planFirst, saved.asks], ["review", false, true]);
  replacement.remove(saved);
  assert.equal(fs.existsSync(route), false);
  replacement.accountList = board.accountList;
  replacement.codexModelReady = replacement.ensureCodexTrust = async () => {};
  replacement.codexSend = () => undefined;
  replacement.codexEditor = () => true;
  const fresh = replacement.add("Next card", "New plan", "Fixture");
  replacement.update(fresh, { planFirst: true });
  panelTransport(replacement, threadId, reply);
  await replacement.start(fresh);
  assert.deepEqual(acknowledgedTurns, ["turn-1", "turn-2"]);
  assert.equal(JSON.parse(fs.readFileSync(route)).events, replacement.eventsFile(fresh.id));
  runPanelHook(replacement, threadId, "Stop", acknowledgedTurns[1]);
  assert.deepEqual(journalStops(replacement, fresh.id), [[threadId, "turn-2"]]);
  replacement.syncStatus(fresh.id);
  assert.deepEqual([fresh.status, !!fresh.planFirst, fresh.asks], ["review", false, true]);
});

test("two independent panel owners contest one shared hook route before acknowledgement", async t => {
  const first = planningPanelFixture(), second = planningPanelFixture();
  const { threadId } = first;
  second.board.panelHook = first.board.panelHook;
  fs.copyFileSync(path.join(__dirname, "..", "hook", "hook.js"), first.board.panelHook);
  const pending = Promise.withResolvers(), prompts = [];
  const connection = panelTransport(first.board, threadId, (_, id, method) => {
    prompts.push(["first", method]);
    pending.resolve(id);
  }, t);
  const starting = first.board.start(first.task);
  const id = await Promise.race([pending.promise, starting.then(() => assert.fail("first launch completed before dispatch"))]);
  let refused = false;
  try {
    panelTransport(second.board, threadId, (rpc, id, method) => {
      prompts.push(["second", method]);
      rpc.onResult({ id, result: { turn: { id: "turn-C" } } });
    }, t);
    try { await second.board.start(second.task); } catch { refused = true; }
  } finally {
    connection.onResult({ id, result: { turn: { id: "turn-B" } } });
    await starting;
  }
  runPanelHook(first.board, threadId, "Stop", "turn-B");
  first.board.syncStatus(first.task.id);
  second.board.syncStatus(second.task.id);
  const observed = { prompts, refused, firstStops: journalStops(first.board, first.task.id), secondStops: journalStops(second.board, second.task.id),
    first: [first.task.status, !!first.task.planFirst], second: [second.task.status, !!second.task.planFirst] };
  t.diagnostic(JSON.stringify(observed));
  if (!strictPlanBinding) t.todo("independent Board owners must arbitrate the shared thread before the second dispatch");
  assert.deepEqual(observed, { prompts: [["first", "turn/start"]], refused: true, firstStops: [[threadId, "turn-B"]], secondStops: [],
    first: ["review", false], second: ["queued", true] });
});

for (const delivery of ["old identified Stop", "old untagged Stop", "current identified Stop"]) {
  test(`reused panel thread after reload / ${delivery}`, async t => {
    const { board, task, threadId } = planningPanelFixture();
    fs.copyFileSync(path.join(__dirname, "..", "hook", "hook.js"), board.panelHook);
    async function start(owner, card, turnId) {
      const rpc = panelTransport(owner, threadId, (provider, id, method) => {
        assert.equal(method, "turn/start");
        provider.onResult({ id, result: { turn: { id: turnId } } });
      }, t);
      const launch = t.mock.method(owner, "startCodexPanel");
      await owner.start(card);
      const [call] = launch.mock.calls;
      const ack = await call.result;
      assert.ok(ack.launchToken);
      assert.deepEqual([ack.launchToken, ack.threadId, ack.turnId], [call.arguments[2], threadId, turnId]);
      return rpc;
    }
    const first = await start(board, task, "turn-B");
    // B's hook process receives the event while B owns the thread. Hold EOF, which triggers the real hook's lookup.
    let delayed;
    if (delivery.startsWith("old")) {
      const exec = require("node:util").promisify(require("node:child_process").execFile);
      delayed = exec(process.execPath, [board.panelHook], { timeout: 30000,
        env: { ...process.env, ENTOMATICAL_EVENTS: "", ENTOMATICAL_RUNTIME: "", ENTOMATICAL_TERMINAL_LAUNCH: "" } });
      const stdin = delayed.child.stdin;
      delayed.catch(() => {}); // Teardown awaits and reports the exit even if setup fails or the child times out.
      t.after(async () => { if (!stdin.writableEnded) stdin.end(); await delayed; });
      await new Promise((resolve, reject) => stdin.write(JSON.stringify({ session_id: threadId, hook_event_name: "Stop",
        ...(delivery === "old identified Stop" && { turn_id: "turn-B" }), last_assistant_message: "Approve the old plan?" }),
      err => err ? reject(err) : resolve()));
    }
    first.onNotification({ method: "turn/completed", params: { threadId, turn: { id: "turn-B", status: "completed" } } });
    assert.equal(task.status, "review");
    board.remove(task);
    board.dispose();
    const next = replacementPanelBoard(board);
    const fresh = next.add("Next plan", "Prepare a new plan.", "Fixture");
    next.update(fresh, { planFirst: true });
    await start(next, fresh, "turn-C");
    next.dispose();
    const reader = replacementPanelBoard(next);
    const snapshot = () => {
      const row = JSON.parse(fs.readFileSync(reader.file)).find(c => c.id === fresh.id);
      return [row.status, !!row.planFirst, !!row.asks];
    };
    const running = ["running", true, false];
    assert.deepEqual(snapshot(), running);
    if (delayed) {
      delayed.child.stdin.end();
      await delayed;
    } else {
      runPanelHook(reader, threadId, "Stop", "turn-C");
      assert.deepEqual(journalStops(reader, fresh.id), [[threadId, "turn-C"]]);
    }
    reader.syncStatus(fresh.id);
    const afterStop = snapshot();
    t.diagnostic(JSON.stringify({ delivery, replacementStops: journalStops(reader, fresh.id), afterStop }));
    if (delayed && !strictPlanBinding) t.todo("a retired launch's delayed hook must not settle the replacement");
    assert.deepEqual(afterStop, delayed ? running : ["review", false, true]);
  });
}

for (const change of ["dependency", "permission", "none"]) {
  test(`planning final gate rechecks dispatch eligibility / ${change}`, async t => {
    const { board, task, threadId } = planningPanelFixture();
    t.after(() => board.dispose());
    const dependency = board.add("Not finished", "Separate work", "Fixture");
    board.update(task, { held: true });
    const prompts = [];
    panelTransport(board, threadId, (rpc, id, method) => {
      prompts.push(method); rpc.onResult({ id, result: { turn: { id: "turn" } } });
    }, t);
    const gate = board.canStartCodexPanel.bind(board);
    const observed = t.mock.method(board, "canStartCodexPanel", (...args) => {
      if (change === "dependency") {
        board.update(task, { dependsOn: [dependency.id] });
        assert.equal(board.startWait(task), "Starts after Not finished");
      }
      if (change === "permission") board.update(task, { permission: "ask" });
      return gate(...args);
    });
    let error;
    try { await board.start(task); } catch (e) { error = e.message; }
    assert.equal(observed.mock.callCount(), 1);
    if (error) assert.match(error, /cancelled before its prompt was sent/);
    const actual = [observed.mock.calls[0].result, prompts, !!error];
    t.diagnostic(JSON.stringify(actual));
    if (change === "dependency" && !strictPlanBinding) t.todo("a new blocking dependency must prevent prompt dispatch");
    assert.deepEqual(actual, change === "none" ? [true, ["turn/start"], false] : [false, [], true]);
  });
}

for (const failStop of [false, true]) {
  test(`planning Stop before preparation leaves Start available after reload / failed rename ${failStop}`, async t => {
    const { board, task, threadId } = planningPanelFixture();
    const prompts = [];
    panelTransport(board, threadId, (rpc, id, method) => {
      prompts.push(method); rpc.onResult({ id, result: { turn: { id: "retry" } } });
    }, t);
    const pending = Promise.withResolvers(), release = Promise.withResolvers();
    const prepare = board.prepareCodexPanel.bind(board);
    t.mock.method(board, "prepareCodexPanel", async (...args) => {
      pending.resolve();
      await release.promise;
      return prepare(...args);
    });
    const starting = board.start(task);
    await pending.promise;
    const saved = () => JSON.parse(fs.readFileSync(board.file)).find(c => c.id === task.id);
    const opening = saved();
    assert.ok(opening.sessionId && opening.sessionId !== threadId);
    if (failStop) {
      const rename = fs.renameSync;
      const fault = t.mock.method(fs, "renameSync", (from, to) => {
        if (to === board.file) throw new Error("fixture: Stop rename refused");
        return rename(from, to);
      });
      try { assert.throws(() => board.stop(task), /Stop rename refused/); } finally { fault.mock.restore(); }
      assert.deepEqual(saved(), opening);
    }
    board.stop(task);
    release.resolve();
    await starting;
    assert.deepEqual(prompts, []);
    const cleanOpening = card => [card.status, !card.sessionId, !card.codexPlanPreparation, !!card.planFirst];
    const live = cleanOpening(task), durable = cleanOpening(saved());
    board.dispose();
    const replacement = open(board.repo), reopened = replacement.get(task.id);
    const afterReload = cleanOpening(reopened);
    t.after(() => replacement.dispose());
    replacement.panelHook = board.panelHook;
    replacement.codexModelReady = replacement.ensureCodexTrust = async () => {};
    replacement.codexSend = () => undefined;
    replacement.codexEditor = () => true;
    panelTransport(replacement, threadId, (rpc, id, method) => {
      prompts.push(method); rpc.onResult({ id, result: { turn: { id: "fresh" } } });
    });
    let error;
    try { await replacement.start(reopened); } catch (e) { error = e.message; }
    const actual = { live, durable, afterReload, prompts, error };
    t.diagnostic(JSON.stringify(actual));
    if (failStop && !strictPlanBinding) t.todo("after a failed Stop write cleanup must remain retryable");
    const queued = ["queued", true, true, true];
    assert.deepEqual(actual, { live: queued, durable: queued, afterReload: queued, prompts: ["turn/start"], error: undefined });
  });
}

test("planning launch result preserves a superseding controller and thread on the same Board", async t => {
  const { board, task, threadId } = planningPanelFixture();
  t.after(() => board.dispose());
  const prompts = [];
  panelTransport(board, threadId, (rpc, id, method) => {
    prompts.push(method); rpc.onResult({ id, result: { turn: { id: "old-turn" } } });
  }, t);
  const start = board.startCodexPanel;
  const received = Promise.withResolvers(), release = Promise.withResolvers();
  board.startCodexPanel = async (...args) => {
    const result = await start(...args);
    received.resolve(result);
    await release.promise;
    return result;
  };
  const starting = board.start(task);
  const old = await received.promise;
  assert.deepEqual([old.threadId, old.turnId], [threadId, "old-turn"]);
  const controller = { sessionId: "new-controller" };
  board.update(task, { sessionId: "new-thread", status: "needs-input", controller });
  release.resolve();
  await starting;
  const saved = JSON.parse(fs.readFileSync(board.file)).find(c => c.id === task.id);
  assert.deepEqual([saved.controller, prompts], [controller, ["turn/start"]]);
  t.diagnostic(JSON.stringify({ threadId: saved.sessionId, status: saved.status }));
  if (!strictPlanBinding) t.todo("a delayed launch result must preserve a superseding session");
  assert.deepEqual([saved.sessionId, saved.status, task.sessionId, task.status],
    ["new-thread", "needs-input", "new-thread", "needs-input"]);
});

// These acceptance gates exercise the eventual binding implementation under its existing strict opt-in.
const requirePlanBinding = { skip: !strictPlanBinding && "requires durable planning-turn binding" };
test("planning acknowledgement survives a storage outage spanning the normal launch result", requirePlanBinding, async t => {
  const { board, task, threadId } = planningPanelFixture();
  const sent = Promise.withResolvers();
  let prompts = 0;
  const bridge = panelTransport(board, threadId, (_rpc, id) => { prompts++; sent.resolve(id); });
  const received = Promise.withResolvers(), deliver = Promise.withResolvers();
  const start = board.startCodexPanel;
  board.startCodexPanel = async (...args) => {
    const result = await start(...args);
    received.resolve();
    await deliver.promise;
    return result;
  };
  const starting = board.start(task), id = await sent.promise;
  bridge.onResult({ id, result: { turn: { id: "B" } } });
  await received.promise;
  bridge.onNotification({ method: "thread/status/changed", params: { threadId, status: { type: "active", activeFlags: ["waitingOnApproval"] } } });
  const saved = () => JSON.parse(fs.readFileSync(board.file, "utf8")).find(c => c.id === task.id);
  assert.equal(task.status, "needs-input");
  board.update(task, { deliveryReady: true, checks: { status: "complete", marker: "intact" } });
  const prepared = saved();
  const rename = fs.renameSync;
  const disk = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === board.file) throw new Error("fixture: storage unavailable after dispatch");
    return rename(from, to);
  });
  deliver.resolve();
  await starting.catch(error => assert.match(error.message, /storage unavailable/));
  disk.mock.restore();
  assert.deepEqual(saved(), prepared);
  board.tick();
  const result = saved();
  assert.equal(prompts, 1);
  assert.deepEqual([result.codexPlanDispatch?.turnId, result.status, result.checks, result.deliveryReady, !!result.interrupted],
    ["B", prepared.status, prepared.checks, prepared.deliveryReady, false]);
});

for (const timing of ["on time", "late"]) {
  test(`planning binding retries a failed acknowledgement on the owner tick / ${timing}`, requirePlanBinding, async t => {
    const { board, task, threadId } = planningPanelFixture();
    const sent = Promise.withResolvers();
    let prompts = 0;
    const bridge = panelTransport(board, threadId, (_rpc, id) => { prompts++; sent.resolve(id); });
    let expire;
    const timer = global.setTimeout;
    t.mock.method(global, "setTimeout", (fn, delay, ...args) => {
      const handle = timer(fn, delay, ...args);
      if (delay === 30_000) expire = () => { clearTimeout(handle); fn(); };
      return handle;
    });
    const saved = () => JSON.parse(fs.readFileSync(board.file, "utf8")).find(c => c.id === task.id);
    const launch = t.mock.method(board, "startCodexPanel");
    const starting = board.start(task), request = await sent.promise;
    const launchToken = launch.mock.calls[0].arguments[2];
    assert.ok(launchToken);
    if (timing === "late") { expire(); await starting; }
    // Reject only the receipt rename. Running, checks and delivery retain their own normal storage paths.
    const rename = fs.renameSync;
    let failures = 0;
    const disk = t.mock.method(fs, "renameSync", (from, to) => {
      if (to === board.file && JSON.parse(fs.readFileSync(from, "utf8")).some(c => c.codexPlanDispatch?.turnId === "B")) {
        failures++;
        throw new Error("fixture: binding rename");
      }
      return rename(from, to);
    });
    bridge.onResult({ id: request, result: { turn: { id: "B" } } });
    await starting;
    await new Promise(resolve => setImmediate(resolve));
    disk.mock.restore();
    assert.equal(failures, 1);
    assert.deepEqual([saved().codexPlanDispatch?.turnId, task.codexPlanDispatch?.turnId], [undefined, undefined]);
    board.update(task, { status: "needs-input", deliveryReady: true, checks: { status: "complete", marker: "test" } });
    const before = saved();
    const statuses = [];
    board.onStatus(e => statuses.push(e.to));
    board.tick();
    const expected = saved();
    const { codexPlanDispatch: binding, ...fields } = expected;
    assert.deepEqual({ ...fields, codexPlanDispatch: before.codexPlanDispatch }, { ...before, codexPlanDispatch: before.codexPlanDispatch });
    assert.deepEqual([binding?.launchToken, binding?.threadId, binding?.turnId],
      [launchToken, threadId, "B"]);
    assert.equal(prompts, 1);
    const ack = { taskId: task.id, threadId, launchToken, method: "dispatch/accepted", turnId: "B" };
    board.codexPanelEvent(ack);
    board.codexPanelEvent({ ...ack, turnId: "other" });
    assert.deepEqual(saved(), expected);
    assert.deepEqual(statuses, []);
    board.dispose();
    assert.deepEqual(open(board.repo).get(task.id).codexPlanDispatch, expected.codexPlanDispatch);
  });
}

test("an uncertain panel dispatch cannot consume an earlier completion's planning Stop", async () => {
  const { board, task, threadId, journalStop } = planningPanelFixture();
  panelTransport(board, threadId, provider => {
    journalStop();
    provider.onNotification({ method: "turn/started", params: { threadId, turn: { id: "B" } } });
    provider.onNotification({ method: "turn/completed", params: { threadId, turn: { id: "A", status: "completed" } } });
    provider.onFatalError(new Error("fixture disconnected after sending turn/start"));
  });
  const published = [];
  board.onStatus(({ to }) => { if (to === "review") published.push([task.planFirst, task.asks]); });
  await board.start(task);
  await board.deliveries;
  for (const snapshot of published) assert.deepEqual(snapshot, [true, undefined]);
  const saved = JSON.parse(fs.readFileSync(board.file, "utf8")).find(card => card.id === task.id);
  assert.deepEqual([saved.planFirst, saved.asks], [true, undefined]);
});

for (const accepted of [false, true]) {
  test(`direct bridge with the root Board: foreign ends cannot settle B / accepted ${accepted}`, async () => {
    const { board, task, threadId } = planningPanelFixture();
    const interrupts = [], reviews = [];
    board.onStatus(({ to }) => { if (to === "review") reviews.push(task.interrupted ? "interrupted" : "success"); });
    const wait = { type: "active", activeFlags: ["waitingOnApproval"] };
    const provider = panelTransport(board, threadId, (provider, id, method, params) => {
      if (method === "turn/interrupt") {
        interrupts.push(params);
        provider.onResult({ id, result: {} });
        return;
      }
      for (const turn of [{ id: "A" }, {}]) provider.onNotification({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
      provider.onNotification({ method: "thread/status/changed", params: { threadId, status: wait } });
      provider.onResult(accepted ? { id, result: { turn: { id: "B" } } } : { id, error: { message: "fixture explicitly rejected B" } });
    });
    if (accepted) {
      await board.start(task);
      assert.deepEqual([task.status, board.panelFirstTurn(), reviews], ["needs-input", [task.id], []]);
      for (const [activeFlags, expected] of [[[], "running"], [["waitingOnApproval"], "needs-input"]]) {
        provider.onNotification({ method: "thread/status/changed", params: { threadId, status: { type: "active", activeFlags } } });
        const saved = JSON.parse(fs.readFileSync(board.file, "utf8")).find(card => card.id === task.id);
        assert.deepEqual([saved.status, saved.interrupted, board.panelFirstTurn()], [expected, undefined, [task.id]]);
      }
      provider.onNotification({ method: "turn/started", params: { threadId, turn: { id: "A" } } });
      provider.onNotification({ method: "turn/completed", params: { threadId, turn: { id: "A", status: "completed" } } });
      board.stop(task);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(interrupts, [{ threadId, turnId: "B" }]);
      provider.onNotification({ method: "turn/completed", params: { threadId, turn: { id: "B", status: "interrupted" } } });
    } else await assert.rejects(board.start(task), /explicitly rejected B/);
    await board.deliveries;
    assert.deepEqual([task.status, board.panelFirstTurn(), reviews], ["review", [], ["interrupted"]]);
  });
}

for (const [cancel, activeFlags] of [[false], [true], [true, []], [true, ["waitingOnApproval"]]]) {
  test(`buffered B success after acknowledgement preserves the saved Review / Stop ${cancel} / active flags ${JSON.stringify(activeFlags)}`, async t => {
    const { board, task, threadId } = planningPanelFixture();
    const sent = Promise.withResolvers(), interrupts = [];
    const provider = panelTransport(board, threadId, (provider, id, method, params) => {
      if (method === "turn/start") { sent.resolve(id); return; }
      interrupts.push(params);
      provider.onResult({ id, result: {} });
    });
    const events = t.mock.method(board, "codexPanelEvent");
    const launch = t.mock.method(board, "startCodexPanel");
    const saved = () => JSON.parse(fs.readFileSync(board.file, "utf8")).find(card => card.id === task.id);
    const starting = board.start(task);
    const id = await sent.promise;
    provider.onNotification({ method: "turn/completed", params: { threadId, turn: { id: "B", status: "completed", error: null,
      itemsView: "summary", items: [{ type: "agentMessage", phase: "final_answer", id: "reply", text: "Approve the plan?" }] } } });
    if (cancel) {
      board.stop(task);
      assert.deepEqual([saved().status, saved().interrupted], ["review", true]);
    }
    let beforeAck;
    if (activeFlags) {
      provider.onNotification({ method: "thread/status/changed", params: { threadId, status: { type: "active", activeFlags } } });
      const card = saved();
      beforeAck = [card.status, card.interrupted, board.panelFirstTurn()];
    }
    provider.onResult({ id, result: { turn: { id: "B" } } });
    await starting;
    await board.deliveries;
    const card = saved(), result = await launch.mock.calls[0].result;
    assert.deepEqual([card.status, card.interrupted, board.panelFirstTurn()], ["review", cancel || undefined, []]);
    assert.deepEqual([result.threadId, result.turnId, result.completed, result.status], [threadId, "B", true, "completed"]);
    const ends = events.mock.calls.map(call => call.arguments[0]).filter(event => event.method === "turn/completed");
    assert.deepEqual(ends.map(event => [event.turnId, event.terminalEvidence.finalAnswer.asks]), cancel ? [] : [["B", true]]);
    if (activeFlags) {
      assert.deepEqual(beforeAck, ["review", true, []]);
      assert.deepEqual(result.threadStatus, { type: "active", activeFlags });
      assert.equal(events.mock.calls.some(call => call.arguments[0].method === "thread/status/changed"), false);
    }
    await assert.rejects(board.stopCodexPanel(threadId), /has not reported an active turn/);
    assert.deepEqual(interrupts, []);
  });
}

test("a failed confirmed panel Review save cannot announce an interruption", async t => {
  const { board, task, threadId, journalStop } = planningPanelFixture();
  let failed = false;
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (!failed && to === board.file && JSON.parse(fs.readFileSync(from, "utf8")).some(c => c.id === task.id && c.status === "review")) {
      failed = true;
      throw new Error("fixture: first Review save failed");
    }
    return rename(from, to);
  });
  board.startCodexPanel = async (card, prompt, token) => {
    assert.ok(board.prepareCodexPanel(card.id, token, threadId));
    assert.ok(board.canStartCodexPanel(card.id, token, threadId));
    journalStop();
    return { threadId, completed: true, status: "completed" };
  };
  const interrupted = [];
  board.onStatus(({ to }) => { if (to === "review" && task.interrupted) interrupted.push(to); });
  // A future writer may retry before returning. A reported write error is also recoverable by hook replay.
  try { await board.start(task); } catch (err) { assert.match(err.message, /first Review save failed/); }
  assert.ok(failed);
  board.syncStatus(task.id);
  await board.deliveries;
  const saved = JSON.parse(fs.readFileSync(board.file, "utf8")).find(card => card.id === task.id);
  assert.deepEqual([saved.status, saved.interrupted, saved.planFirst, saved.asks], ["review", undefined, undefined, true]);
  assert.deepEqual(interrupted, []);
});

test("editor mode: stopping a panel start before its prompt prevents dispatch", async () => {
  const codex = require("../out/codex.js");
  const fake = require("./fake-codex-use.js").useFakeCodex(codex);
  try {
    await codex.discoverCodex();
    const { repo } = fixture(), board = open(repo);
    board.codexEditor = () => true;
    board.ensureCodexTrust = async () => {};
    let ready, release, allowedAfterStop;
    const prepared = new Promise((resolve) => { ready = resolve; });
    const wait = new Promise((resolve) => { release = resolve; });
    board.startCodexPanel = async (task, _prompt, token) => {
      assert.equal(board.prepareCodexPanel(task.id, token, "panel-pending", path.join(repo, "pending.jsonl")), true);
      ready();
      await wait;
      allowedAfterStop = board.canStartCodexPanel(task.id, token, "panel-pending");
      throw new Error("cancelled before prompt");
    };
    const task = board.add("Panel task", "do it", "Codex · user@example.test");
    const starting = board.start(task);
    await prepared;
    board.stop(task);
    release();
    await starting;
    assert.equal(allowedAfterStop, false, "a stopped panel must refuse prompt dispatch");
    assert.deepEqual([task.status, task.interrupted, task.sessionId], ["review", true, "panel-pending"]);
    assert.deepEqual(board.firstTurn(), []);
  } finally { fake.done(); }
});

test("editor mode: the first Codex turn runs in the background, then the conversation opens in Codex's editor and the card follows its rollout", async () => {
  const codex = require("../out/codex.js");
  const fake = require("./fake-codex-use.js").useFakeCodex(codex);
  process.env.FAKE_CODEX_TRUSTED = codex.CODEX_HOOKS.map((e) => `/<session-flags>/config.toml:${e.replace(/[A-Z]/g, (ch, i) => (i ? "_" : "") + ch.toLowerCase())}:0:0`).join(",");
  try {
    await codex.discoverCodex();
    const { repo } = fixture();
    const board = open(repo);
    board.codexEditor = () => true;
    const runs = [];
    board.runCodex = (args, options) => {
      const fake = fakeAppServer(undefined);
      runs.push({ args, options, child: fake.child, fake });
      return fake.child;
    };
    // A real child emits "exit", then "close" once its output has ended; the turn has ended when the board drops it from its own sessions.
    const end = (child, code, id) => {
      const ended = new Promise((r) => board.onChange(() => { if (!board.own().includes(id)) r(); }));
      child.emit("exit", code);
      child.stdout.end(); child.stderr.end();
      child.emit("close", code);
      return ended;
    };
    const task = board.add("", "fix the bug\nthen test it", "Codex · user@example.test", undefined, "gpt-a", "ultra");
    const shown = terminals.length;
    assert.equal(await board.start(task), undefined); // no terminal
    assert.equal(terminals.length, shown);
    assert.equal(task.codexEditor, true);
    const [run] = runs;
    assert.deepEqual(run.args, ["app-server", "-c", 'model_reasoning_effort="ultra"', ...codex.hookArgs(codex.CODEX_HOOK)]);
    assert.deepEqual([run.options.cwd, run.options.env.ENTOMATICAL_EVENTS], [task.worktree, board.eventsFile(task.id)]);
    // The board speaks app-server's protocol: a thread in the worktree, with write access and no approvals (nobody is there), then the turn.
    const init = await run.fake.next("initialize");
    assert.equal(init.params.clientInfo.name, "entomatical");
    run.fake.answer(init.id, {});
    const threadStart = await run.fake.next("thread/start");
    assert.deepEqual(threadStart.params, { cwd: task.worktree, model: "gpt-a", sandbox: "workspace-write", approvalPolicy: "never" });
    const rollout = path.join(repo, "rollout-2026-10-28T05-09-57-thread-7.jsonl");
    run.fake.answer(threadStart.id, { thread: { id: "thread-7", path: rollout, source: "vscode" } });
    const turnStart = await run.fake.next("turn/start");
    assert.deepEqual(turnStart.params, { threadId: "thread-7", input: [{ type: "text", text: "fix the bug\nthen test it" }] }); // the prompt: no quoting or length limit
    assert.equal(run.fake.requests.some((q) => q.method === "thread/name/set"), false, "a title taken from the prompt is not put on the thread");
    run.fake.answer(turnStart.id, { turn: { id: "turn-1", status: "inProgress" } });
    assert.deepEqual([task.sessionId, task.transcript], ["thread-7", rollout]); // Codex's real id and rollout, from thread/start
    assert.deepEqual([board.own(), board.live()], [[task.id], [task.id]]); // Stop works on it
    assert.throws(() => board.send(task, "more"), /first turn in the background/);
    await assert.rejects(board.openInCodex(task), /still on the first turn/);
    // Codex's hooks report the thread, it works, and finishes; the turn's progress (not its deltas) goes to a log.
    const rec = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n";
    fs.writeFileSync(rollout, rec("session_meta", { id: "thread-7", cwd: task.worktree, source: "vscode" }) + rec("event_msg", { type: "task_started" }));
    const hook = (name, extra = {}) => { fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: name, session_id: "thread-7", transcript_path: rollout, ...extra }) + "\n"); board.syncStatus(task.id); };
    hook("SessionStart", { source: "startup" });
    hook("UserPromptSubmit", { prompt: "fix the bug\nthen test it" });
    assert.deepEqual([task.sessionId, task.status], ["thread-7", "running"]);
    run.fake.notify("item/agentMessage/delta", { delta: "Fix" });
    run.fake.notify("item/completed", { item: { type: "agentMessage", text: "Fixed." } });
    fs.appendFileSync(rollout, rec("event_msg", { type: "task_complete", last_agent_message: "Fixed." }));
    hook("Stop", { last_assistant_message: "Fixed." });
    // turn/completed: the board closes app-server's input, which ends a real one; "close" then follows as for any child.
    const inputClosed = new Promise((r) => run.child.stdin.once("finish", r));
    run.fake.notify("turn/completed", { threadId: "thread-7", turn: { id: "turn-1", status: "completed" } });
    await inputClosed;
    await end(run.child, 0, task.id);
    assert.deepEqual([board.own(), task.status], [[], "review"]);
    const opened = commands.at(-1);
    assert.equal(opened[0], "vscode.openWith");
    assert.equal(String(opened[1]), "openai-codex://route/local/thread-7");
    assert.deepEqual(opened.slice(2), ["chatgpt.conversationEditor", { preview: false, preserveFocus: true }]);
    const logged = fs.readFileSync(path.join(board.dir, "codex", `${task.id}.log`), "utf8");
    assert.match(logged, /"item\/completed".*Fixed\./);
    assert.doesNotMatch(logged, /delta/);
    // A follow-up typed in Codex's editor appends to the same rollout: the card follows it, with no hook and no process of its own.
    fs.appendFileSync(rollout, rec("event_msg", { type: "task_started" }));
    board.tick();
    assert.deepEqual([task.status, board.live()], ["running", [task.id]]);
    fs.appendFileSync(rollout, rec("event_msg", { type: "task_complete", last_agent_message: "Tested." }));
    board.tick();
    assert.deepEqual([task.status, board.live()], ["review", []]);
    // Resume and Open both reopen the conversation in Codex's editor.
    const before = commands.length;
    assert.equal(await board.resume(task), undefined);
    assert.equal(String(commands.at(-1)[1]), "openai-codex://route/local/thread-7");
    assert.equal(commands.length, before + 1);
    // A first turn that fails says where its output is, and opens nothing.
    const failing = board.add("", "break", "Codex · user@example.test");
    await board.start(failing);
    await end(runs.at(-1).child, 1, failing.id);
    assert.match(warnings.at(-1), /ended with exit code 1. Its output is in .*codex/);
    assert.equal(commands.length, before + 1);
    // It made no conversation (no SessionStart), so the card is unstarted again: Start shows instead of a Resume that cannot open.
    assert.deepEqual([failing.sessionId, failing.codexEditor, failing.status], [undefined, undefined, "queued"]);
    await board.start(failing); // Start works again
    assert.equal(failing.codexEditor, true);
    await end(runs.at(-1).child, 1, failing.id);
    assert.equal(failing.sessionId, undefined);
  } finally { fake.done(); delete process.env.FAKE_CODEX_TRUSTED; }
});

test("editor mode: a Codex first turn offers only Stop, and deleting its card ends it; its worktree is kept until it has", async () => {
  const codex = require("../out/codex.js");
  const fake = require("./fake-codex-use.js").useFakeCodex(codex);
  process.env.FAKE_CODEX_TRUSTED = codex.CODEX_HOOKS.map((e) => `/<session-flags>/config.toml:${e.replace(/[A-Z]/g, (ch, i) => (i ? "_" : "") + ch.toLowerCase())}:0:0`).join(",");
  try {
    await codex.discoverCodex();
    const { repo } = fixture();
    const board = open(repo);
    board.codexEditor = () => true;
    const { EventEmitter: Emitter } = require("node:events");
    const { PassThrough } = require("node:stream");
    const runs = [];
    // No real process has this pid (Linux caps pids far lower), so Stop's group kill fails and it falls back to kill(), which ends the fake.
    board.runCodex = () => {
      const child = Object.assign(new Emitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 2 ** 30, killed: 0 });
      child.kill = () => { child.killed++; child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit("close", null)); };
      runs.push(child);
      return child;
    };
    const task = board.add("", "fix the bug", "Codex · user@example.test");
    await board.start(task);
    // The board posts first turns so the card hides Open and Follow-up, which would both fail, and keeps Stop.
    assert.deepEqual([board.firstTurn(), board.own(), board.live()], [[task.id], [task.id], [task.id]]);
    // Delete card and worktree is refused while Codex still works in the worktree.
    await assert.rejects(board.finish(task, "discard", true), /still running/);
    assert.ok(fs.existsSync(task.worktree));
    // Deleting the card ends the background turn; when it closes, nothing is reset or opened for the card that is gone.
    const before = { commands: commands.length, warnings: warnings.length };
    const ended = new Promise((r) => board.onChange(() => { if (!board.firstTurn().includes(task.id)) r(); }));
    board.remove(task);
    // Linux signals the (missing) process group and falls back to kill() at once; Windows learns from taskkill's exit first.
    if (process.platform !== "win32") assert.equal(runs[0].killed, 1);
    await ended;
    await new Promise((r) => (runs[0].killed ? r() : runs[0].once("close", r))); // Windows: the fallback kill follows taskkill's exit
    assert.equal(runs[0].killed, 1);
    assert.deepEqual([commands.length, warnings.length], [before.commands, before.warnings]);
    assert.equal(board.tasks.includes(task), false);
    assert.deepEqual([board.firstTurn(), board.own()], [[], []]);
  } finally { fake.done(); delete process.env.FAKE_CODEX_TRUSTED; }
});

test("editor mode: a first turn ended by Stop after Codex reported its conversation goes to Review, not Running for good", async () => {
  // Seen live 31 October 2026 (Windows, codex-cli 0.164): Stop ends `codex exec` before it can close its turn in the rollout, which
  // then read as running for good: the card stayed in Running with Open, and Merge and Discard were hidden, until a new turn.
  const codex = require("../out/codex.js");
  const fake = require("./fake-codex-use.js").useFakeCodex(codex);
  process.env.FAKE_CODEX_TRUSTED = codex.CODEX_HOOKS.map((e) => `/<session-flags>/config.toml:${e.replace(/[A-Z]/g, (ch, i) => (i ? "_" : "") + ch.toLowerCase())}:0:0`).join(",");
  try {
    await codex.discoverCodex();
    const { repo } = fixture();
    const board = open(repo);
    board.codexEditor = () => true;
    const { EventEmitter: Emitter } = require("node:events");
    const { PassThrough } = require("node:stream");
    // No real process has this pid, so Stop's kill fails and it falls back to kill(), which ends the fake (as in the test above).
    board.runCodex = () => {
      const child = Object.assign(new Emitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 2 ** 30 });
      child.kill = () => { child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit("close", null)); };
      return child;
    };
    const task = board.add("Stopped", "run a long command", "Codex · user@example.test");
    await board.start(task);
    const rollout = path.join(repo, "rollout-2026-10-31T19-17-07-thread-11.jsonl");
    const rec = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n";
    fs.writeFileSync(rollout, rec("session_meta", { id: "thread-11", cwd: task.worktree, source: "exec" }) + rec("event_msg", { type: "task_started" })
      + rec("response_item", { type: "custom_tool_call", call_id: "c1", name: "shell", input: "ping -n 60 127.0.0.1" }));
    const hook = (name, extra = {}) => { fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: name, session_id: "thread-11", transcript_path: rollout, ...extra }) + "\n"); board.syncStatus(task.id); };
    const provisional = task.sessionId;
    hook("SessionStart", { session_id: "side-thread", transcript_path: null });
    assert.equal(task.sessionId, provisional);
    hook("SessionStart", { source: "startup" });
    hook("UserPromptSubmit", { prompt: "run a long command" });
    assert.equal(task.status, "running");
    const ended = new Promise((r) => board.onChange(() => { if (!board.firstTurn().includes(task.id)) r(); }));
    board.stop(task);
    await ended;
    // The rollout still shows the cut-off turn running; the card no longer counts as live, and goes to Review like a stopped terminal.
    assert.deepEqual([task.sessionId, task.codexEditor, board.live()], ["thread-11", true, []]);
    task.updatedAt = new Date(Date.now() - 60_000).toISOString();
    board.tick();
    assert.equal(task.status, "review");
    // A turn typed later in Codex's editor moves the card again.
    fs.appendFileSync(rollout, rec("event_msg", { type: "task_started" }));
    board.tick();
    assert.deepEqual([task.status, board.live()], ["running", [task.id]]);
    fs.appendFileSync(rollout, rec("event_msg", { type: "task_complete", last_agent_message: "Done." }));
    board.tick();
    assert.deepEqual([task.status, board.live()], ["review", []]);
  } finally { fake.done(); delete process.env.FAKE_CODEX_TRUSTED; }
});

test("terminal mode: a Codex terminal closed before Codex reported its session starts again, so its prompt is sent", async () => {
  const codex = require("../out/codex.js");
  const fake = require("./fake-codex-use.js").useFakeCodex(codex);
  process.env.FAKE_CODEX_TRUSTED = codex.CODEX_HOOKS.map((e) => `/<session-flags>/config.toml:${e.replace(/[A-Z]/g, (ch, i) => (i ? "_" : "") + ch.toLowerCase())}:0:0`).join(",");
  try {
    await codex.discoverCodex();
    const { repo } = fixture();
    const board = open(repo);
    const task = board.add("", "fix the bug", "Codex · user@example.test");
    const term = await board.start(task);
    assert.ok(task.sessionId); // a made-up id until Codex's SessionStart names the thread
    assert.equal(board.resetUnstarted(task), false); // its terminal is still open (perhaps at Codex's trust prompt)
    term.exitStatus = { code: 0 }; // closed at the trust prompt: no SessionStart
    assert.equal(board.resetUnstarted(task), true);
    assert.equal(task.sessionId, undefined);
    await board.start(task); // what Resume now does: Codex starts with the prompt, not `codex resume --last`
    assert.deepEqual(terminals.at(-1).shellArgs.slice(-2), ["--", "fix the bug"]);
    // Once Codex has reported its thread there is a conversation, so Resume resumes it.
    fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: "SessionStart", session_id: "thread-3", transcript_path: path.join(repo, "rollout-thread-3.jsonl") }) + "\n");
    board.syncStatus(task.id);
    board.terminal(task).exitStatus = { code: 0 };
    assert.equal(board.resetUnstarted(task), false);
    assert.equal(task.sessionId, "thread-3");
  } finally { fake.done(); delete process.env.FAKE_CODEX_TRUSTED; }
});

test("a task moved to Codex keeps its continuation prompt when its first terminal is closed before Codex starts", async () => {
  const codex = require("../out/codex.js");
  const fake = require("./fake-codex-use.js").useFakeCodex(codex);
  process.env.FAKE_CODEX_TRUSTED = codex.CODEX_HOOKS.map((e) => `/<session-flags>/config.toml:${e.replace(/[A-Z]/g, (ch, i) => (i ? "_" : "") + ch.toLowerCase())}:0:0`).join(",");
  try {
    await codex.discoverCodex();
    const { repo } = fixture();
    const board = open(repo);
    const task = board.add("", "fix the bug", "Codex · user@example.test");
    board.continuations.set(task.id, "fix the bug\n\nearlier work is already here"); // what switchAccount sets for a started task moving provider
    const term = await board.start(task);
    assert.deepEqual(terminals.at(-1).shellArgs.slice(-2), ["--", "fix the bug\n\nearlier work is already here"]);
    term.exitStatus = { code: 0 }; // closed at Codex's folder trust screen: no SessionStart
    assert.equal(board.resetUnstarted(task), true);
    await board.start(task);
    assert.deepEqual(terminals.at(-1).shellArgs.slice(-2), ["--", "fix the bug\n\nearlier work is already here"]);
  } finally { fake.done(); delete process.env.FAKE_CODEX_TRUSTED; }
});

test("a Codex task in a repo Codex has not trusted asks to trust it first (with the hook in one dialog when both are due), in both start modes", async () => {
  const codex = require("../out/codex.js");
  const fake = require("./fake-codex-use.js").useFakeCodex(codex);
  const config = path.join(home, "fake-codex-config.json");
  fs.writeFileSync(config, JSON.stringify({ projects: {} }));
  const ours = codex.CODEX_HOOKS.map((e) => `/<session-flags>/config.toml:${e.replace(/[A-Z]/g, (ch, i) => (i ? "_" : "") + ch.toLowerCase())}:0:0`).join(",");
  Object.assign(process.env, { FAKE_CODEX_CONFIG: config, FAKE_CODEX_TRUSTED: ours });
  const trust = () => JSON.parse(fs.readFileSync(config, "utf8")).projects;
  try {
    await codex.discoverCodex();
    const account = "Codex · user@example.test";
    // The hook is approved already, so only the folder is asked about. Declining leaves the card unstarted and Codex's config alone.
    const { repo } = fixture();
    const root = fs.realpathSync.native(repo);
    const board = open(repo);
    const task = board.add("", "fix it", account);
    const opened = terminals.length;
    ask.answer = undefined;
    await assert.rejects(board.start(task), new RegExp(`Not started: Codex was not allowed to trust ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`));
    assert.deepEqual([warnings.at(-1), task.sessionId, terminals.length, trust()], ["Let Codex trust this repo?", undefined, opened, {}]);
    // Approve records exactly what Codex's "Trust and continue" records, for the repo root (not the task's worktree), then starts.
    ask.answer = "Approve";
    await board.start(task);
    assert.deepEqual(trust(), { [root]: { trust_level: "trusted" } });
    assert.equal(terminals.length, opened + 1);
    assert.equal(terminals.at(-1).cwd, task.worktree);
    // Every other task in the repo, and a resume, asks nothing more.
    ask.answer = undefined;
    const asked = warnings.length;
    await board.start(board.add("", "another", account));
    terminals.at(-1).exitStatus = { code: 0 };
    assert.equal(warnings.length, asked);

    // Neither approved yet: one dialog for both, one decline, and one Approve records both.
    delete process.env.FAKE_CODEX_TRUSTED;
    const second = fixture(), root2 = fs.realpathSync.native(second.repo);
    const board2 = open(second.repo);
    board2.codexEditor = () => true; // editor mode: the background `codex exec` must not run before the approval either
    const runs = [];
    board2.runCodex = (args) => { runs.push(args); throw new Error("stop here"); };
    const both = board2.add("", "fix that", account);
    await assert.rejects(board2.start(both), /Not started: Codex's folder trust and status hook were not approved\./);
    assert.deepEqual([warnings.at(-1), both.sessionId, runs.length], ["Let Codex trust this repo and run Entomatical's status hook?", undefined, 0]);
    ask.answer = "Approve";
    await assert.rejects(board2.start(both), /stop here/); // approved, so the first turn was launched
    assert.equal(runs.length, 1);
    const written = JSON.parse(fs.readFileSync(config, "utf8"));
    assert.deepEqual(written.projects[root2], { trust_level: "trusted" });
    assert.equal(written.projects[root].trust_level, "trusted", "the first repo's trust is kept");
    assert.equal(Object.keys(written.hooks.state).length, codex.CODEX_HOOKS.length);
  } finally { fake.done(); delete process.env.FAKE_CODEX_CONFIG; delete process.env.FAKE_CODEX_TRUSTED; ask.answer = undefined; }
});

test("panel starts run one at a time, so each panel takes its own task's launch file", async () => {
  const { repo } = fixture();
  const board = open(repo);
  const pending = path.join(board.dir, "launch", "pending.txt");
  const exec = vscode.commands.executeCommand;
  const claimed = []; // the worktree each new panel's wrapper found in pending.txt
  // A stand-in for the panel wrapper: it claims pending.txt by renaming it, then its session reports SessionStart through the task's hooks.
  vscode.commands.executeCommand = async (...args) => {
    if (args[0] !== "claude-vscode.editor.open") return exec(...args);
    await new Promise((r) => setTimeout(r, 20)); // the panel takes a moment to start: long enough for a second start to overwrite pending.txt
    const mine = `${pending}.claim`;
    fs.renameSync(pending, mine);
    const worktree = fs.readFileSync(mine, "utf8").split(/\r?\n/)[0];
    fs.rmSync(mine);
    claimed.push(worktree);
    const task = board.tasks.find((t) => t.worktree === worktree);
    fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: "SessionStart", session_id: `s-${task.id}` }) + "\n");
  };
  try {
    const a = board.add("A", "do a"), b = board.add("B", "do b");
    await Promise.all([board.startInPanel(a), board.startInPanel(b)]);
    assert.deepEqual(claimed, [a.worktree, b.worktree]);
    assert.deepEqual([a.sessionId, b.sessionId], [`s-${a.id}`, `s-${b.id}`]);
    // A failed start does not hold up the next one.
    const c = board.add("C", "do c"), d = board.add("D", "do d");
    board.update(c, { sessionId: "already" });
    const results = await Promise.allSettled([board.startInPanel(c), board.startInPanel(d)]);
    assert.match(results[0].reason.message, /Already started/);
    assert.equal(d.sessionId, `s-${d.id}`);
  } finally { vscode.commands.executeCommand = exec; }
});

test("a panel start that no wrapper claimed removes pending.txt only while it is still its own", async () => {
  const { repo } = fixture();
  const board = open(repo);
  const pending = path.join(board.dir, "launch", "pending.txt");
  const exec = vscode.commands.executeCommand;
  board.waitForEvent = async () => undefined; // no panel reports in (the 60-second wait, cut short)
  try {
    const a = board.add("A", "do a");
    await assert.rejects(board.startInPanel(a), /did not start through Entomatical's wrapper/);
    assert.equal(fs.existsSync(pending), false); // its own unclaimed file is cleaned up
    assert.equal(fs.existsSync(path.join(board.dir, "launch", `${a.id}.prompt.txt`)), false, "and its prompt file");
    // Meanwhile another start (another window on the same repo) wrote its own pending.txt: that one stays for its panel.
    vscode.commands.executeCommand = async (...args) => { if (args[0] === "claude-vscode.editor.open") fs.writeFileSync(pending, "newer start"); };
    const b = board.add("B", "do b");
    await assert.rejects(board.startInPanel(b), /did not start through Entomatical's wrapper/);
    assert.equal(fs.readFileSync(pending, "utf8"), "newer start");
    assert.equal(fs.existsSync(path.join(board.dir, "launch", `${b.id}.prompt.txt`)), false);
    // The panel command itself fails: nothing of this start is left for a later panel to take.
    fs.rmSync(pending);
    vscode.commands.executeCommand = async (...args) => { if (args[0] === "claude-vscode.editor.open") throw new Error("no Claude Code extension"); };
    const c = board.add("C", "do c");
    await assert.rejects(board.startInPanel(c), /no Claude Code extension/);
    assert.deepEqual([fs.existsSync(pending), fs.existsSync(path.join(board.dir, "launch", `${c.id}.prompt.txt`))], [false, false]);
  } finally { vscode.commands.executeCommand = exec; }
});

test("a panel start the wrapper took that reports in after the wait: a truthful error, then the card takes its session when it does", async () => {
  const { repo } = fixture();
  const board = open(repo);
  const pending = path.join(board.dir, "launch", "pending.txt");
  const exec = vscode.commands.executeCommand;
  board.accountList = () => [{ name: "main", configDir: "" }]; // a Claude card: an earlier test's Codex sign-in can lead the shared list
  board.waitForEvent = async () => undefined; // the 60-second wait, cut short
  vscode.commands.executeCommand = async (...args) => { // a wrapper claims it and deletes the prompt file, as entomatical-claude.js does
    if (args[0] !== "claude-vscode.editor.open") return exec(...args);
    fs.rmSync(fs.readFileSync(pending, "utf8").split(/\r?\n/)[3]);
    fs.rmSync(pending);
  };
  try {
    const task = board.add("Late", "do late");
    board.continuations.set(task.id, "do late\n\nearlier work is already here");
    await assert.rejects(board.startInPanel(task), /took this task but its session has not reported in yet/);
    assert.equal(task.sessionId, undefined);
    // Start again before it reports in: no second panel with the same first prompt in the same worktree.
    let opened = 0;
    vscode.commands.executeCommand = async (...args) => { if (args[0] === "claude-vscode.editor.open") opened++; return exec(...args); };
    await assert.rejects(board.startInPanel(task), /took this task but its session has not reported in yet/);
    assert.equal(opened, 0);
    fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: "SessionStart", session_id: "late-1" }) + "\n");
    board.syncStatus(task.id);
    assert.deepEqual([task.sessionId, task.panel], ["late-1", true]);
    assert.equal(board.promptFor(task), "do late", "its continuation was sent, as after a start in time");
    assert.equal(fs.readFileSync(path.join(board.dir, "launch", "late-1.txt"), "utf8").split(/\r?\n/)[0], task.worktree, "its resume launch file");
    assert.equal(task.panelPending, undefined);
    // A card that is not waiting on a claimed panel start takes no stray SessionStart (a terminal closed in its first second).
    const stray = board.add("Stray", "s");
    fs.appendFileSync(board.eventsFile(stray.id), JSON.stringify({ t: Date.now(), hook_event_name: "SessionStart", session_id: "stray-1" }) + "\n");
    board.syncStatus(stray.id);
    assert.equal(stray.sessionId, undefined);
  } finally { vscode.commands.executeCommand = exec; }
});

test("a claimed panel start whose prompt file a virus scanner kept still counts as claimed, and the file is left alone", async () => {
  const { repo } = fixture();
  const board = open(repo);
  const pending = path.join(board.dir, "launch", "pending.txt");
  const exec = vscode.commands.executeCommand;
  board.accountList = () => [{ name: "main", configDir: "" }];
  board.waitForEvent = async () => undefined;
  let promptFile;
  vscode.commands.executeCommand = async (...args) => { // claimed, but its delete of the prompt file failed
    if (args[0] !== "claude-vscode.editor.open") return exec(...args);
    promptFile = fs.readFileSync(pending, "utf8").split(/\r?\n/)[3];
    fs.rmSync(pending);
  };
  try {
    const task = board.add("Kept", "do it");
    await assert.rejects(board.startInPanel(task), /took this task but its session has not reported in yet/);
    assert.ok(fs.existsSync(promptFile));
  } finally { vscode.commands.executeCommand = exec; }
});

test("a card deleted while its panel start waits behind another does not start", async () => {
  const { repo } = fixture();
  const board = open(repo);
  const exec = vscode.commands.executeCommand;
  let release;
  const opened = [];
  vscode.commands.executeCommand = async (...args) => {
    if (args[0] !== "claude-vscode.editor.open") return exec(...args);
    opened.push(args);
    if (opened.length === 1) await new Promise((r) => (release = r));
  };
  board.waitForEvent = async () => undefined;
  try {
    const a = board.add("A", "do a"), b = board.add("B", "do b");
    const first = board.startInPanel(a), second = board.startInPanel(b);
    while (!release) await new Promise((r) => setTimeout(r, 5)); // A's panel is opening
    board.remove(b);
    release();
    await assert.rejects(first, /did not start through/);
    await assert.rejects(second, /The card was deleted before it started/);
    assert.deepEqual([opened.length, b.worktree], [1, undefined]);
  } finally { vscode.commands.executeCommand = exec; }
});

test("a panel session gets its worktree, account, hooks file, name and first prompt through the real wrapper", async () => {
  const { repo } = fixture();
  const board = open(repo);
  const account = path.join(repo, "acct-alternate");
  board.accountList = () => [{ name: "main", configDir: "" }, { name: "alternate", configDir: account }];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-panelrun-"));
  made.push(temp);
  const seen = path.join(temp, "claude-saw.json"), claude = path.join(temp, "fake-claude.js");
  fs.writeFileSync(claude, `let s = ""; process.stdin.on("data", (b) => (s += b)).on("end", () => require("fs").writeFileSync(${JSON.stringify(seen)},
    JSON.stringify({ cwd: process.cwd(), config: process.env.CLAUDE_CONFIG_DIR, args: process.argv.slice(2), lines: s.trim().split("\\n") })));`);
  const wrapper = path.join(__dirname, "..", "wrapper", "entomatical-claude.js");
  const exec = vscode.commands.executeCommand;
  const runs = [];
  // The Claude panel: it starts its CLI through the wrapper in the workspace folder, with the IDE's own account, and sends its initialize line.
  vscode.commands.executeCommand = async (...args) => {
    if (args[0] !== "claude-vscode.editor.open") return exec(...args);
    execFileSync(process.execPath, [wrapper, process.execPath, claude, "--output-format", "stream-json", "--input-format", "stream-json"],
      { cwd: repo, input: '{"type":"control_request"}\n', env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(repo, "ide-account"), TMPDIR: temp, TEMP: temp, TMP: temp, CLAUDE_CODE_CONFIG_PROBE: "" } });
    const saw = JSON.parse(fs.readFileSync(seen, "utf8"));
    runs.push(saw);
    const task = board.tasks.find((t) => t.worktree && fs.realpathSync(t.worktree) === fs.realpathSync(saw.cwd));
    fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: "SessionStart", session_id: `s-${task.id}` }) + "\n");
  };
  try {
    const named = board.add("Fix the login", "fix it\nsecond line", "alternate"), plain = board.add("", "just do it", "main");
    const prompts = [board.promptFor(named), board.promptFor(plain)];
    await board.startInPanel(named);
    await board.startInPanel(plain);
    const after = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    assert.deepEqual(runs.map((r) => fs.realpathSync(r.cwd)), [named, plain].map((t) => fs.realpathSync(t.worktree)));
    assert.deepEqual(runs.map((r) => r.config), [account, undefined], "the task's account folder; unset for the main account");
    assert.deepEqual(runs.map((r) => after(r.args, "--settings")), [board.hooksFile(named.id), board.hooksFile(plain.id)]);
    assert.deepEqual(runs.map((r) => after(r.args, "--name")), ["Fix the login", undefined]);
    assert.deepEqual(runs.map((r) => JSON.parse(r.lines[1]).message.content), prompts);
    assert.deepEqual([named.sessionId, plain.sessionId], [`s-${named.id}`, `s-${plain.id}`]);
  } finally { vscode.commands.executeCommand = exec; }
});

test("a window that takes the board over loads the previous owner's last save before it saves", () => {
  const { repo } = fixture();
  const dir = path.join(repo, ".entomatical");
  const tasksFile = path.join(dir, "tasks.json");
  const ownerFile = path.join(dir, "owner.json");
  const old = new Date(Date.now() - 60_000).toISOString();
  const card = (id, extra) => ({ id, title: id, prompt: id, status: "queued", createdAt: old, updatedAt: old, ...extra });
  const save = (cards, secondsAhead) => { // a later mtime than the save before it, whatever the clock's granularity
    fs.writeFileSync(tasksFile, JSON.stringify(cards));
    const t = new Date(Date.now() + secondsAhead * 1000);
    fs.utimesSync(tasksFile, t, t);
  };
  const running = card("t1", { status: "running", sessionId: "s1" }); // its session is gone: the new owner moves it to review and saves
  fs.mkdirSync(dir, { recursive: true });
  save([running], 5);
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.ppid, at: Date.now() })); // another window, stood in for by the parent process, owns the board
  const board = open(repo); // so this one only mirrors it
  assert.equal(JSON.parse(fs.readFileSync(ownerFile, "utf8")).pid, process.ppid);
  save([running, card("t2")], 6); // the owner adds a card ...
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.ppid, at: Date.now() - 60_000 })); // ... then stops refreshing its heartbeat
  board.tick();
  assert.equal(JSON.parse(fs.readFileSync(ownerFile, "utf8")).pid, process.pid); // this window took over
  assert.deepEqual(JSON.parse(fs.readFileSync(tasksFile, "utf8")).map((t) => [t.id, t.status]), [["t1", "review"], ["t2", "queued"]]); // t2 survived the new owner's save
});

// F45 review, 4 November 2026: a click or a hook-driven update took a stale owner's board at once and saved over its last save.
test("only the tick takes the board over: a change made first is refused, and the tick loads the old owner's last save", () => {
  const { repo } = fixture();
  const dir = path.join(repo, ".entomatical"), ownerFile = path.join(dir, "owner.json"), tasksFile = path.join(dir, "tasks.json");
  const old = new Date(Date.now() - 60_000).toISOString();
  const card = (id) => ({ id, title: id, prompt: id, status: "queued", createdAt: old, updatedAt: old });
  fs.writeFileSync(tasksFile, JSON.stringify([card("t1")]));
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.ppid, at: Date.now() }));
  const board = open(repo);
  fs.writeFileSync(tasksFile, JSON.stringify([card("t1"), card("t2")])); // the owner's last save ...
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(tasksFile, t, t);
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.ppid, at: Date.now() - 60_000 })); // ... then it stopped
  assert.equal(board.isOwner(), false);
  assert.throws(() => board.add("x", "y"), /Another VS Code window runs this repo's board/); // before: took the board and saved without t2
  assert.equal(JSON.parse(fs.readFileSync(ownerFile, "utf8")).pid, process.ppid);
  board.tick();
  assert.equal(JSON.parse(fs.readFileSync(ownerFile, "utf8")).pid, process.pid);
  assert.deepEqual(JSON.parse(fs.readFileSync(tasksFile, "utf8")).map((c) => c.id), ["t1", "t2"]);
});

test("a window waking from sleep with its own tick stale too waits one tick before taking the board", () => {
  const { repo } = fixture();
  const ownerFile = path.join(repo, ".entomatical", "owner.json");
  fs.mkdirSync(path.dirname(ownerFile), { recursive: true });
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.ppid, at: Date.now() }));
  const board = open(repo);
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.ppid, at: Date.now() - 60_000 })); // the owner slept as well
  board.lastTick = Date.now() - 60_000; // this window's timers paused too
  board.tick();
  assert.equal(JSON.parse(fs.readFileSync(ownerFile, "utf8")).pid, process.ppid); // before: taken at once
  board.tick(); // the owner did not renew within a tick: now it is taken
  assert.equal(JSON.parse(fs.readFileSync(ownerFile, "utf8")).pid, process.pid);
});

test("tasks.json is set aside only on a parse error and only by the owner; a read error keeps the list and tries again", () => {
  const { repo } = fixture();
  const dir = path.join(repo, ".entomatical"), tasksFile = path.join(dir, "tasks.json"), ownerFile = path.join(dir, "owner.json");
  const now = new Date().toISOString();
  const card = (id) => ({ id, title: id, prompt: id, status: "queued", createdAt: now, updatedAt: now });
  const bad = () => fs.readdirSync(dir).filter((n) => n.startsWith("tasks.json.bad-"));
  fs.writeFileSync(tasksFile, "{ not json");
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.ppid, at: Date.now() })); // another window owns it
  const mirror = open(repo);
  mirror.tick();
  assert.deepEqual(bad(), []); // before: this window renamed the owner's file
  fs.writeFileSync(tasksFile, JSON.stringify([card("t1")]));
  mirror.tick();
  assert.deepEqual(mirror.tasks.map((t) => t.id), ["t1"]);
  // A read that fails (a sharing error on Windows) keeps the list; the next tick reads it.
  fs.writeFileSync(tasksFile, JSON.stringify([card("t1"), card("t2")]));
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(tasksFile, t, t);
  const read = fs.readFileSync;
  fs.readFileSync = (f, ...rest) => { if (f === tasksFile) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }); return read(f, ...rest); };
  try { mirror.tick(); } finally { fs.readFileSync = read; }
  assert.deepEqual([mirror.tasks.map((t) => t.id), bad()], [["t1"], []]); // before: set aside, and the board emptied
  mirror.tick();
  assert.deepEqual(mirror.tasks.map((t) => t.id), ["t1", "t2"]);
  // The owner sets a corrupt one aside when it takes the board over.
  fs.writeFileSync(tasksFile, "{ not json");
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.ppid, at: Date.now() - 60_000 }));
  mirror.tick();
  assert.equal(bad().length, 1);
});

// Switch account. Accounts are named by the CLI's email; these tests replace the signed-in list and the folder list.
const { transcriptPath } = require("../out/sessions.js");
const { CONTINUE_NOTE } = require("../out/board.js");
const switchBoard = (repo, folders) => {
  const board = open(repo);
  board.accountList = () => [
    { name: "personal@example.com (~/.claude)", configDir: folders.main },
    { name: "personal@example.com (alternate)", configDir: folders.alternate },
    { name: "team@example.com", configDir: folders.organization },
    { name: "Codex · team@example.com", configDir: "", provider: "codex" },
  ];
  board.accountFolderList = () => [folders.main, folders.alternate, folders.organization];
  return board;
};
const folders = (repo) => ({ main: path.join(repo, "acct-main"), alternate: path.join(repo, "acct-alternate"), organization: path.join(repo, "acct-organization") });
const started = (board, task, sessionId) => {
  fs.mkdirSync(path.dirname(board.eventsFile(task.id)), { recursive: true });
  fs.writeFileSync(board.eventsFile(task.id), JSON.stringify({ t: 1, hook_event_name: "SessionStart", session_id: sessionId }) + "\n");
};

test("Switch account: a task whose account name no longer resolves still moves, and its conversation is found in any folder", () => {
  const { repo, worktree } = fixture();
  const f = folders(repo);
  const board = switchBoard(repo, f);
  // The card says alternate@example.com, but that folder is now logged in as personal@example.com: no account has the old name.
  const task = board.add("Limited task", "Do it", "team@example.com");
  board.update(task, { account: "alternate@example.com", configDir: undefined, sessionId: "sess-1", worktree, status: "review" });
  started(board, task, "sess-1");
  assert.throws(() => board.configDirOf(task), /not available.*Switch account/);
  const from = transcriptPath(f.alternate, worktree, "sess-1");
  const sub = path.join(from.replace(/\.jsonl$/, ""), "subagents", "agent-x.jsonl");
  fs.mkdirSync(path.dirname(sub), { recursive: true });
  fs.writeFileSync(from, '{"type":"user"}\n');
  fs.writeFileSync(sub, '{"type":"assistant"}\n');
  assert.equal(board.switchAccount(task, "team@example.com"), "resume");
  const to = transcriptPath(f.organization, worktree, "sess-1");
  assert.equal(task.account, "team@example.com");
  assert.equal(task.configDir, f.organization);
  assert.equal(board.configDirOf(task), f.organization);
  assert.equal(fs.readFileSync(to, "utf8"), '{"type":"user"}\n');
  assert.ok(fs.existsSync(path.join(to.replace(/\.jsonl$/, ""), "subagents", "agent-x.jsonl")));
  fs.appendFileSync(to, '{"type":"assistant"}\n'); // a hard link: one conversation file under both folders
  assert.equal(fs.readFileSync(from, "utf8"), '{"type":"user"}\n{"type":"assistant"}\n');
  assert.equal(board.transcriptOf(task), to);
});

test("Switch account: the card's folder keeps an account working after its email name changes", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-switch-"));
  made.push(repo);
  const f = folders(repo);
  const board = switchBoard(repo, f);
  const task = board.add("On main", "p", "personal@example.com (~/.claude)");
  assert.equal(task.configDir, f.main); // recorded at creation
  board.update(task, { account: "personal@example.com" }); // the name it had before a second folder shared the email
  assert.equal(board.configDirOf(task), f.main);
});

test("Restart: a card whose account is signed in can be resumed after the program and computer restarted", async () => {
  // Seen 13 Nov 2026 on Windows: after a reboot every card failed with "Account … is not available. Is it still logged in?" while
  // all three folders were signed in. ~/.claude and organization had both come to hold alternate@example.com, so the list named them
  // "alternate@example.com (~/.claude)" and "(organization)" and no card's saved name matched; and the first login checks after boot
  // had not answered yet, so the list held no Claude account at all.
  const { repo, worktree } = fixture();
  const main = path.join(repo, "acct-main"), sns = path.join(repo, "organization"), rs = path.join(repo, "personal@example.com");
  const before = open(repo);
  before.accountList = () => [{ name: "alternate@example.com", configDir: "" }, { name: "personal@example.com (~/.claude)", configDir: main }, { name: "personal@example.com (personal@example.com)", configDir: rs }];
  before.accountFolderList = () => ["", main, rs, sns];
  const old = before.add("Old card", "p", "alternate@example.com");
  before.update(old, { configDir: undefined, sessionId: "sess-r1", worktree, status: "review" }); // cards from before configDir was saved
  const dup = before.add("Dup card", "p", "personal@example.com (personal@example.com)");
  before.update(dup, { configDir: undefined });
  started(before, old, "sess-r1");
  before.dispose();
  // The restart: a new window's board over the same tasks.json, and the account checks not finished yet.
  const board = open(repo);
  board.accountFolderList = () => ["", main, rs, sns];
  board.accountList = () => [{ name: "Codex · team@example.com", configDir: "", provider: "codex" }];
  const task = board.get(old.id), other = board.get(dup.id);
  assert.equal(board.configDirOf(other), rs); // the folder its name ends in
  assert.throws(() => board.configDirOf(task), /still checking/); // a plain name with no folder waits for the check, never "not available"
  // The checks answer: the names now carry suffixes the cards never saw.
  board.accountList = () => [{ name: "alternate@example.com (~/.claude)", configDir: "" }, { name: "alternate@example.com (organization)", configDir: sns }, { name: "personal@example.com", configDir: rs }];
  assert.equal(board.configDirOf(task), "");
  assert.equal(board.configDirOf(other), rs);
  const opened = terminals.length;
  await board.resume(task); // the error was thrown here before
  assert.equal(terminals.length, opened + 1);
  // An account no folder holds any more still says so.
  board.update(other, { account: "someone@else.test" });
  assert.throws(() => board.configDirOf(other), /not available.*Switch account/);
});

test("Accounts stay in their own folders: a folder signed in as another email is not offered to any card", () => {
  // As found on Windows on 13 Nov 2026: organization belongs to team@example.com but was signed in as alternate@example.com.
  const { usableAccounts, meantFor } = require("../out/sessions.js");
  const sns = path.join(home, ".claude-accounts", "organization"), rs = path.join(home, ".claude-accounts", "personal@example.com");
  const saved = { "": "alternate@example.com", [sns]: "team@example.com" };
  assert.equal(meantFor(rs, {}), "personal@example.com"); // a folder named for an email belongs to it
  assert.equal(meantFor(sns, saved), "team@example.com");
  assert.equal(meantFor(sns.toUpperCase(), saved), process.platform === "win32" ? "team@example.com" : undefined);
  assert.equal(meantFor(path.join(home, "unbound"), saved), undefined);
  const statuses = [
    { configDir: "", loggedIn: true, email: "alternate@example.com" },
    { configDir: sns, loggedIn: true, email: "alternate@example.com" },
    { configDir: rs, loggedIn: true, email: "someone@else.test" },
  ];
  assert.deepEqual(usableAccounts(statuses, saved), [{ name: "alternate@example.com", configDir: "" }]); // no "(organization)" twin
  statuses[1].email = "team@example.com"; statuses[2].email = "personal@example.com"; // logged in again correctly
  assert.deepEqual(usableAccounts(statuses, saved).map((a) => a.name), ["alternate@example.com", "team@example.com", "personal@example.com"]);
});

test("Restart: a login check that fails right after boot keeps the folder's last saved login", async () => {
  const sessions = require("../out/sessions.js");
  const dir = path.join(home, "acct-boot");
  fs.mkdirSync(path.dirname(sessions.authStatusFile()), { recursive: true });
  // What the last check before the shutdown saved.
  fs.writeFileSync(sessions.authStatusFile(), JSON.stringify([{ configDir: dir, loggedIn: true, email: "alternate@example.com" }]));
  const pathVar = Object.keys(process.env).find((k) => k.toLowerCase() === "path");
  const saved = process.env[pathVar];
  process.env[pathVar] = ""; // no `claude` to run: the check fails as a cold one timing out does
  try {
    assert.deepEqual(await sessions.authStatus(dir), { configDir: dir, loggedIn: true, email: "alternate@example.com" });
  } finally { process.env[pathVar] = saved; }
  sessions.forgetAuthStatus(dir); // a sign-out drops it from the file too
  assert.deepEqual(JSON.parse(fs.readFileSync(sessions.authStatusFile(), "utf8")), []);
});

test("Switch account: a queued Claude task moves to Codex and back, with models only where that provider has them", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-switch-"));
  made.push(repo);
  const board = switchBoard(repo, folders(repo));
  const task = board.add("Queued", "Build it", "team@example.com", undefined, "opus", "high");
  assert.equal(board.switchAccount(task, "Codex · team@example.com"), "start");
  assert.equal(task.provider, "codex");
  assert.equal(task.account, "Codex · team@example.com");
  assert.equal(task.model, undefined); // opus is not a Codex model
  assert.equal(task.configDir, undefined);
  assert.equal(board.promptFor(task), "Build it"); // never started: the prompt is unchanged
  assert.equal(board.switchAccount(task, "personal@example.com (alternate)"), "start");
  assert.equal(task.provider, undefined);
  assert.equal(board.configDirOf(task), folders(repo).alternate);
});

test("Switch account: a started Claude task moving to Codex starts a new session told to continue the earlier work", () => {
  const { repo, worktree } = fixture();
  const board = switchBoard(repo, folders(repo));
  const task = board.add("Started", "Fix the bug", "team@example.com");
  board.update(task, { sessionId: "sess-2", worktree, status: "review", panel: true });
  started(board, task, "sess-2");
  assert.equal(board.switchAccount(task, "Codex · team@example.com"), "start");
  assert.equal(task.provider, "codex");
  assert.equal(task.sessionId, undefined);
  assert.equal(task.panel, undefined);
  assert.equal(task.status, "queued");
  assert.deepEqual(board.events(task.id), []); // the old session's events are set aside, so the new session starts clean
  assert.ok(fs.readdirSync(path.dirname(board.eventsFile(task.id))).some((n) => n.startsWith(`${task.id}.jsonl.`) && n.endsWith(".before-switch")));
  assert.equal(board.promptFor(task), `Fix the bug\n\n${CONTINUE_NOTE}`);
  assert.equal(task.worktree, worktree); // the work so far stays
});

test("Switch account refuses: an unknown account, the same Codex account, and a found session changing provider", () => {
  const { repo, worktree } = fixture();
  const board = switchBoard(repo, folders(repo));
  const lost = board.add("Lost", "p", "team@example.com");
  board.update(lost, { sessionId: "gone", worktree });
  started(board, lost, "gone");
  assert.throws(() => board.canSwitch(lost, "nobody@example.com"), /not signed in/);
  assert.throws(() => board.switchAccount(lost, "nobody@example.com"), /not signed in/);
  assert.equal(lost.account, "team@example.com");
  const codex = board.add("Codex", "p", "Codex · team@example.com");
  assert.throws(() => board.switchAccount(codex, "Codex · team@example.com"), /already runs on the Codex account/);
  const found = board.add("Found", "p", "team@example.com");
  board.update(found, { adopted: true, sessionId: "ext-1", worktree });
  assert.throws(() => board.canSwitch(found, "Codex · team@example.com"), /found running/);
  assert.throws(() => board.switchAccount(found, "Codex · team@example.com"), /found running/);
});

// F41 review, 4 November 2026. Claude deletes transcripts older than cleanupPeriodDays (7 on linux): such a card could never move.
test("Switch account: a conversation whose transcript is gone starts a new session in the same worktree, and the note survives a reload until it comes up", () => {
  const { repo, worktree } = fixture();
  const board = switchBoard(repo, folders(repo));
  const task = board.add("Old", "Fix it", "team@example.com");
  board.update(task, { sessionId: "old-1", worktree, status: "review" });
  started(board, task, "old-1");
  assert.equal(board.canSwitch(task, "personal@example.com (alternate)"), true); // the extension asks "Start new session" first
  assert.equal(board.switchAccount(task, "personal@example.com (alternate)"), "start"); // before: "saved conversation was not found"
  assert.deepEqual([task.sessionId, task.account, task.status, task.worktree, task.continued], [undefined, "personal@example.com (alternate)", "queued", worktree, true]);
  assert.deepEqual(board.events(task.id), []); // the old events are set aside
  // A reload (another window, or this one restarted) before the new session's first prompt keeps the note: it is on the card.
  const reloaded = switchBoard(repo, folders(repo));
  assert.equal(reloaded.promptFor(reloaded.get(task.id)), `Fix it\n\n${CONTINUE_NOTE}`);
  reloaded.dispose();
  // The new session reported in: its first prompt went with the note, so the next start would not send it again.
  started(board, task, "new-1");
  board.syncStatus(task.id);
  assert.equal(task.continued, undefined);
  assert.equal(board.promptFor(task), "Fix it");
});

test("Switch account to the other provider adds the note whenever the card had a session id, also with no SessionStart recorded", () => {
  const { repo, worktree } = fixture();
  const board = switchBoard(repo, folders(repo));
  const task = board.add("No hooks", "Fix the bug", "team@example.com");
  board.update(task, { sessionId: "s-nohooks", worktree, status: "review" });
  assert.equal(board.canSwitch(task, "Codex · team@example.com"), true);
  board.switchAccount(task, "Codex · team@example.com");
  assert.equal(board.promptFor(task), `Fix the bug\n\n${CONTINUE_NOTE}`); // before: the plain prompt
});

test("Switch account refuses a Codex task still working in Codex's editor, before anything is stopped or moved", () => {
  const { repo } = fixture();
  const board = switchBoard(repo, folders(repo));
  const rollout = path.join(repo, "rollout-2026-11-04T10-00-00-th9.jsonl");
  const rec = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n";
  fs.writeFileSync(rollout, rec("session_meta", { id: "th9", cwd: repo, source: "vscode" }) + rec("event_msg", { type: "task_started" }));
  const task = board.add("In the editor", "go", "Codex · team@example.com");
  board.update(task, { codexEditor: true, transcript: rollout, sessionId: "th9", status: "running", worktree: repo });
  fs.writeFileSync(board.eventsFile(task.id), JSON.stringify({ t: 1, hook_event_name: "SessionStart", session_id: "th9" }) + "\n");
  assert.ok(board.live().includes(task.id));
  assert.throws(() => board.canSwitch(task, "team@example.com"), /working in Codex's editor\. Stop it there first/);
  assert.throws(() => board.switchAccount(task, "team@example.com"), /working in Codex's editor/);
  assert.deepEqual([task.provider, task.sessionId], ["codex", "th9"]); // before: moved to Claude while Codex kept working
  assert.ok(fs.existsSync(board.eventsFile(task.id)));
});

test("Switch account closes a usage run that spans the move with the old account's reading, and stops a provider change's running checks", () => {
  const { repo, worktree } = fixture();
  const f = folders(repo);
  const board = switchBoard(repo, f);
  const usage = path.join(home, ".entomatical", "usage");
  fs.mkdirSync(usage, { recursive: true });
  fs.writeFileSync(path.join(usage, "acct-organization.json"), JSON.stringify({ at: Date.now(), week: 40 }));
  fs.writeFileSync(path.join(usage, "acct-alternate.json"), JSON.stringify({ at: Date.now(), week: 10 }));
  const task = board.add("Metered", "p", "team@example.com");
  board.update(task, { worktree, status: "running" }); // a run opens on organization
  board.switchAccount(task, "personal@example.com (alternate)");
  board.update(task, { status: "review" }); // the run's end, after the move
  // The old account's run ends with its reading, and the card, still Running, opens one on the new account (before: one run ended with alternate's 10).
  assert.deepEqual(task.usageRuns.map((r) => [!!r.endedAt, r.start?.week, r.end?.week]), [[true, 40, 40], [true, 10, 10]]);
  const stopped = [];
  board.checks.stop = (t) => stopped.push(t.id);
  board.update(task, { sessionId: "s-checks" });
  board.switchAccount(task, "Codex · team@example.com");
  assert.deepEqual(stopped, [task.id]); // before: its checks kept running against the old session's work
});

test("Open in panel links the transcript into a history folder on another drive or skips it, instead of failing (EXDEV)", async () => {
  const { board, task, worktree } = claudeTask();
  const { DEFAULT_DIR } = require("../out/sessions.js");
  board.update(task, { sessionId: "xdev-1", status: "review" });
  const real = transcriptPath(DEFAULT_DIR, worktree, "xdev-1");
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '{"type":"user"}\n');
  const other = path.join(home, "other-drive");
  const link = fs.linkSync;
  fs.linkSync = (from, to) => { if (String(to).startsWith(other)) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }); return link(from, to); };
  try { await board.openInPanel(task, other); } finally { fs.linkSync = link; } // before: rejected with EXDEV
  assert.deepEqual(commands.at(-1), ["claude-vscode.editor.open", "xdev-1"]);
});

test("Ending a session in this window's Claude panel records it as stopped, so a file left under a reused pid is not a live session (Windows)", () => {
  const { board, task, worktree } = claudeTask();
  board.update(task, { sessionId: "kill-1", status: "review" });
  const cli = listSession("kill-1", worktree);
  try {
    board.rescan();
    const pid = board.external.get("kill-1").pid;
    assert.equal(board.killSession(task), true);
    assert.ok(board.stoppedSessions.has(`${pid}:kill-1`)); // before: only stop() recorded it
  } finally { cli.kill(); }
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
/** The CLI's sessions/<pid>.json for a live process, as it writes for every interactive session, the board's own terminals included. */
function listSession(sessionId, cwd, extra = {}) {
  const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  const dir = path.join(home, ".claude", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId, cwd, ...extra }));
  return child;
}

test("F53: an untitled card takes a live session's name only when the user gave it; a card with a typed title still takes the auto name", () => {
  const { board, task, worktree } = claudeTask();
  const untitled = board.add("", "Fix login\nmore");
  board.update(untitled, { worktree, provider: undefined, account: undefined, configDir: undefined, sessionId: "f53-live", status: "review" });
  board.update(task, { sessionId: "f53-typed", status: "review" });
  const auto = listSession("f53-live", worktree, { name: "Auto name", nameSource: "auto" });
  const typed = listSession("f53-typed", worktree, { name: "Auto name", nameSource: "auto" });
  try {
    board.rescan();
    board.tick();
    assert.equal(untitled.title, "Fix login"); // before: "Auto name"
    assert.equal(task.title, "Auto name");
    // A rename in Claude Code rewrites the same live session's file. Not kill-and-relist: on Linux a killed child stays a zombie
    // (alive to kill(pid, 0)) until the event loop reaps it, so its stale "auto" file would still be listed beside the new one.
    fs.writeFileSync(path.join(home, ".claude", "sessions", `${auto.pid}.json`), JSON.stringify({ pid: auto.pid, sessionId: "f53-live", cwd: worktree, name: "Auto name", nameSource: "user" }));
    board.rescan();
    board.tick();
    assert.equal(untitled.title, "Auto name");
  } finally { auto.kill(); typed.kill(); }
});

test("Resume right after Stop waits for the stopped CLI to leave the live list; a session the board did not stop is refused at once", async () => {
  const { board, task, worktree } = claudeTask();
  board.update(task, { sessionId: "own-1", status: "review" });
  started(board, task, "own-1");
  const term = await board.resume(task);
  const cli = listSession("own-1", worktree);
  board.rescan();
  assert.ok(board.external.has("own-1")); // the board's own terminal is listed too
  board.stop(task);
  term.exitStatus = { code: 0 };
  setTimeout(() => cli.kill(), 600); // the CLI exits a moment after its terminal closes
  const opened = terminals.length;
  const again = await board.resume(task); // before the fix: "still running elsewhere"
  assert.ok(again);
  assert.equal(terminals.length, opened + 1);
  assert.deepEqual(terminals.at(-1).shellArgs.slice(0, 2), ["--resume", "own-1"]);
  assert.equal(board.external.has("own-1"), false);
  // A session open elsewhere (not stopped by this board) is not waited on.
  again.exitStatus = { code: 0 };
  const other = listSession("own-1", worktree);
  try {
    board.rescan();
    const t0 = Date.now();
    await assert.rejects(board.resume(task), /still running elsewhere/);
    assert.ok(Date.now() - t0 < 1000);
    // ended() gives up after its bound while it stays listed.
    assert.equal(await board.ended(task, 300), false);
  } finally { other.kill(); }
});

test("A Claude card whose session never came up starts again instead of resuming an empty session", async () => {
  const { repo, worktree } = fixture();
  const board = switchBoard(repo, folders(repo));
  const task = board.add("Never ready", "Do it", "team@example.com");
  board.update(task, { sessionId: "never-1", worktree, status: "review" });
  assert.equal(board.everReady(task), false);
  // Switch account: nothing to carry, so it starts on the new account rather than "resume" an empty session.
  assert.equal(board.switchAccount(task, "personal@example.com (alternate)"), "start");
  assert.deepEqual([task.sessionId, task.account], [undefined, "personal@example.com (alternate)"]);
  // Resume: the id is dropped so the extension runs Start (which sends the prompt).
  board.update(task, { sessionId: "never-2" });
  assert.equal(board.resetUnstarted(task), true);
  assert.equal(task.sessionId, undefined);
  // A session that came up, a found one and a panel one keep their id. (A Codex card is reset the same way: see "terminal mode: a Codex terminal closed …".)
  for (const patch of [{ adopted: true }, { panel: true }]) {
    const t = board.add("Kept", "p", "team@example.com");
    board.update(t, { sessionId: "kept", worktree, ...patch });
    assert.equal(board.resetUnstarted(t), false);
    assert.equal(t.sessionId, "kept");
  }
  const ready = board.add("Ready", "p", "team@example.com");
  board.update(ready, { sessionId: "ready-1", worktree });
  started(board, ready, "ready-1");
  assert.equal(board.resetUnstarted(ready), false);
});

test("tick: a Claude card whose session never came up and has nothing running goes back to Start (ready wait ran out, or a reload)", async () => {
  const { board, task } = claudeTask();
  const warned = warnings.length;
  // Started, the 10-minute wait ran out with the terminal still open: the card keeps its id while the terminal runs.
  board.waitForEvent = async () => undefined;
  await board.start(task);
  const term = board.terminal(task);
  assert.ok(term && task.sessionId);
  assert.equal(warnings.length, warned + 1); // "did not report ready in 10 minutes"
  board.tick();
  assert.ok(task.sessionId, "an open terminal keeps the card started");
  // Closing the terminal afterwards: the next tick drops the id, so the card shows Start rather than Resume.
  term.exitStatus = { code: 1 };
  board.tick();
  assert.equal(task.sessionId, undefined);
  assert.equal(JSON.parse(fs.readFileSync(board.file, "utf8")).find((t) => t.id === task.id).sessionId, undefined);
  // After a window reload nothing waits in start(): a saved card with an id, no SessionStart and no terminal is reset too.
  board.update(task, { sessionId: "reloaded-never" });
  board.tick();
  assert.equal(task.sessionId, undefined);
  // Kept: a session that came up, one with a saved conversation, one live elsewhere, and a card past queued.
  board.update(task, { sessionId: "came-up" });
  started(board, task, "came-up");
  board.tick();
  assert.equal(task.sessionId, "came-up");
  fs.rmSync(board.eventsFile(task.id), { force: true });
  const transcript = path.join(board.dir, "kept.jsonl");
  fs.writeFileSync(transcript, "{}\n");
  board.update(task, { sessionId: "has-transcript", transcript });
  board.tick();
  assert.equal(task.sessionId, "has-transcript");
  board.update(task, { transcript: undefined, sessionId: "elsewhere" });
  const remove = sessionFile("elsewhere", task.worktree, "busy");
  try { board.tick(); assert.equal(task.sessionId, "elsewhere"); } finally { remove(); }
  board.update(task, { sessionId: "reviewed", status: "review" });
  board.tick();
  assert.equal(task.sessionId, "reviewed");
});

test("start(): a terminal closed before SessionStart resets the card quietly; the old waiter never types into a resumed session", async () => {
  const { board, task } = claudeTask();
  const warned = warnings.length, typed = sent.length;
  // Closed during onboarding or folder trust: no warning, nothing typed, and the card offers Start again.
  let pending = board.start(task);
  await pause(50);
  board.terminal(task).exitStatus = { code: 1 };
  await pending;
  assert.deepEqual([task.sessionId, warnings.length, sent.length], [undefined, warned, typed]);
  // Closed and resumed at once: the new session's SessionStart is not the old terminal's, so the old waiter sends nothing.
  pending = board.start(task);
  await pause(50);
  board.terminal(task).exitStatus = { code: 1 };
  const id = task.sessionId;
  await board.resume(task);
  started(board, task, id);
  await pending;
  assert.deepEqual([task.sessionId, warnings.length, sent.length], [id, warned, typed]);
  // A launch that fails leaves the card unstarted.
  board.terminal(task).exitStatus = { code: 0 };
  board.update(task, { sessionId: undefined, account: "gone@example.com" });
  board.accountList = () => [{ name: "other@example.com", configDir: path.join(board.dir, "acct-other") }]; // an empty list now means "still checking"
  await assert.rejects(board.start(task), /not available/);
  assert.equal(task.sessionId, undefined);
  // The ordinary path still sends the prompt once its own session is ready.
  board.accountList = () => [];
  board.update(task, { account: undefined });
  fs.rmSync(board.eventsFile(task.id), { force: true });
  pending = board.start(task);
  await pause(50);
  started(board, task, task.sessionId);
  await pending;
  assert.equal(sent.at(-1), "\u001b[200~do it\u001b[201~\r");
});

test("Start reads linked contexts independently so Asana unlink preserves the note", () => {
  const { board, task } = claudeTask();
  board.startContext.set(task.id, "\n\nAsana text");
  board.noteStartContext.set(task.id, "\n\nObsidian text");
  assert.equal(board.promptFor(task), task.prompt + "\n\nAsana text\n\nObsidian text");
  board.startContext.delete(task.id);
  assert.equal(board.promptFor(task), task.prompt + "\n\nObsidian text");
});

test("start(): a first prompt whose turn never started gets one more Enter; a started turn, a waiting prompt or a closed terminal gets none (F97 live check)", async () => {
  const { board, task } = claudeTask();
  board.submitCheckMs = 300;
  const event = (name) => fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: name, session_id: task.sessionId }) + "\n");
  const run = async (between) => {
    board.terminals.delete(task.id);
    board.update(task, { sessionId: undefined, status: "queued" });
    fs.rmSync(board.eventsFile(task.id), { force: true });
    const pending = board.start(task);
    await pause(50);
    started(board, task, task.sessionId);
    const term = await pending;
    assert.deepEqual(term.sent, ["\u001b[200~do it\u001b[201~\r"]);
    between?.();
    await pause(500);
    return term.sent.slice(1);
  };
  assert.deepEqual(await run(), ["\r"]); // the Enter was lost (the prompt sat in Claude's box): one more Enter
  assert.deepEqual(await run(() => event("UserPromptSubmit")), []); // the turn started
  assert.deepEqual(await run(() => event("PermissionRequest")), []); // a prompt is up: an Enter would answer it
  assert.deepEqual(await run(() => board.update(task, { status: "needs-input" })), []);
  assert.deepEqual(await run(() => { board.terminal(task).exitStatus = { code: 0 }; }), []); // closed meanwhile
});

/** Writes the CLI's session file for a live session (this test process's pid) in the throwaway ~/.claude; returns a remover. */
function sessionFile(sessionId, cwd, status) {
  const dir = path.join(home, ".claude", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId, cwd, status, kind: "interactive" }));
  return () => fs.rmSync(file, { force: true });
}
const ago = (ms) => new Date(Date.now() - ms).toISOString();
/** Replaces the task's events with one hook event `age` ms old. */
const onlyEvent = (board, task, name, age, extra = {}) =>
  fs.writeFileSync(board.eventsFile(task.id), JSON.stringify({ t: Date.now() - age, hook_event_name: name, ...extra }) + "\n");
/** withTask on Claude's ~/.claude: an earlier test can leave the fake Codex account first in the account list. */
function claudeTask() {
  const f = withTask();
  f.board.update(f.task, { account: undefined, configDir: undefined, provider: undefined });
  return f;
}

function interruptedTranscript(board, task) {
  const file = board.transcriptOf({ ...task, transcript: undefined }) || path.join(board.repo, `${task.id}-interrupted.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: "user", message: { content: "[Request interrupted by user]" } }) + "\n");
  task.transcript = file;
}

test("with fs.watch failing (EMFILE, out of inotify instances) the board still opens and the 3 s poll moves cards on hook events", () => {
  const watch = fs.watch;
  fs.watch = () => { throw Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" }); };
  let f;
  try { f = claudeTask(); } finally { fs.watch = watch; }
  const { board, task } = f;
  board.update(task, { sessionId: "sess-nowatch", status: "running" });
  onlyEvent(board, task, "Stop", 0);
  board.tick();
  assert.equal(task.status, "review");
});

test("StopFailure (a turn ended by an API error) is registered and moves the card to Review, naming the error", () => {
  const { board, task } = claudeTask();
  board.writeHooks(task);
  const hooks = JSON.parse(fs.readFileSync(board.hooksFile(task.id), "utf8")).hooks;
  assert.ok(hooks.StopFailure && hooks.Stop);
  const seen = [];
  board.onStatus((e) => seen.push(e));
  board.update(task, { sessionId: "sess-fail", status: "running" });
  onlyEvent(board, task, "StopFailure", 0, { error: "rate_limit" });
  board.syncStatus(task.id);
  assert.equal(task.status, "review");
  assert.deepEqual(seen.at(-1), { task, from: "running", to: "review", error: "rate_limit" });
  // A plain Stop names no error.
  board.update(task, { status: "running" });
  onlyEvent(board, task, "Stop", 0);
  board.syncStatus(task.id);
  assert.deepEqual(seen.at(-1), { task, from: "running", to: "review" });
});

test("the permission menu choice goes into a Claude task's --settings file as permissions.defaultMode; unknown modes are refused", () => {
  const { board, task } = claudeTask();
  const settings = () => { board.writeHooks(task); return JSON.parse(fs.readFileSync(board.hooksFile(task.id), "utf8")); };
  assert.equal(settings().permissions, undefined); // Default permissions: the account's own setting
  for (const [pick, mode] of [["ask", "default"], ["edits", "acceptEdits"], ["auto", "auto"], ["bypass", "bypassPermissions"]]) {
    board.update(task, { permission: pick });
    assert.deepEqual(settings().permissions, { defaultMode: mode });
  }
  const added = board.add("", "x", undefined, undefined, undefined, undefined, undefined, { permission: "bypass" }); // offered by both providers
  assert.equal(added.permission, "bypass");
  assert.throws(() => board.add("", "x", undefined, undefined, undefined, undefined, undefined, { permission: "yolo" }), /Unknown permission mode/);
});

test("card settings wire the sub-agent hooks beside hook.js, and plan-folder.js under Stop after hook.js", () => {
  const { board, task } = claudeTask();
  board.writeHooks(task);
  const settings = JSON.parse(fs.readFileSync(board.hooksFile(task.id), "utf8"));
  const cmd = (name, ...rest) => hookCommand(board, name, ...rest);
  assert.deepEqual(settings.hooks.PreToolUse.map((h) => [h.matcher, h.hooks[0]]), [["Bash|PowerShell", cmd("agent-fence.js")], ["Write", cmd("plan-folder.js")]]);
  // F98: plan writes are listed beside the card's settings file and committed once at Stop, after hook.js.
  const planCmd = cmd("plan-folder.js", board.hooksFile(task.id).replace(/\.json$/, ".plan-pending"));
  assert.deepEqual(settings.hooks.PostToolUse[1], { matcher: "Write|Edit|MultiEdit", hooks: [planCmd] });
  assert.equal(settings.hooks.Stop.length, 2);
  assert.deepEqual(settings.hooks.Stop[0].hooks[0], cmd("hook.js", board.eventsFile(task.id)));
  assert.deepEqual(settings.hooks.Stop[1], { hooks: [planCmd] });
  assert.equal(settings.hooks.SubagentStart[0].matcher, undefined);
  assert.deepEqual(settings.hooks.SubagentStart[1], { matcher: "^ab-", hooks: [{ ...cmd("subagent-brief.js"), timeout: 30 }] });
  assert.deepEqual(settings.hooks.SubagentStop[1], { matcher: "^ab-", hooks: [cmd("receipt-gate.js")] });
});

/** The hook entry writeHooks makes for a script beside hook.js: exec form with node.exe on Windows (hookNode), `node "a" "b"` elsewhere. */
function hookCommand(board, name, ...rest) {
  const script = path.join(path.dirname(board.hookScript), name);
  const node = hookNode();
  return node ? { type: "command", command: node, args: [script, ...rest] }
    : { type: "command", command: ["node", ...[script, ...rest].map((p) => `"${p.replace(/\\/g, "/")}"`)].join(" ") };
}

test("hookNode: node.exe from a Windows PATH (quoted folders too) for exec-form hooks; none on Linux or when PATH has no node.exe", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "hook node-"));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "hook empty-"));
  try {
    fs.writeFileSync(path.join(bin, "node.exe"), "");
    assert.equal(hookNode({ PATH: `${empty};"${bin}"` }, "win32"), path.join(bin, "node.exe"));
    assert.equal(hookNode({ Path: `${empty};${bin}` }, "win32"), path.join(bin, "node.exe")); // Windows spells it Path
    assert.equal(hookNode({ PATH: empty }, "win32"), undefined);
    assert.equal(hookNode({ PATH: `${empty};${bin}` }, "linux"), undefined); // Linux keeps the shell form
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("a turn that ends without a Stop marks the card Interrupted until it runs again", () => {
  const { board, task } = claudeTask();
  board.update(task, { sessionId: "sess-int", status: "running" });
  onlyEvent(board, task, "UserPromptSubmit", 20_000);
  board.update(task, { updatedAt: new Date(Date.now() - 20_000).toISOString() });
  task.updatedAt = new Date(Date.now() - 20_000).toISOString();
  board.tick(); // no terminal, no live session: gone, so a quiet Review
  assert.deepEqual([task.status, task.interrupted], ["review", true]);
  board.update(task, { status: "running" });
  assert.equal(task.interrupted, undefined);
  board.update(task, { status: "review" }); // a real Stop
  assert.equal(task.interrupted, undefined);
});

const FABLE_LIMIT = { error: "rate_limit", last_assistant_message: "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model." };
const fableEvents = (board, task, ageMs = 0) => {
  const file = board.eventsFile(task.id), now = Date.now();
  fs.writeFileSync(file, [
    { t: now - ageMs - 2, hook_event_name: "SessionStart", model: "claude-fable-5-1" },
    { t: now - ageMs - 1, hook_event_name: "UserPromptSubmit", prompt: "fix the build" },
    { t: now - ageMs, hook_event_name: "StopFailure", ...FABLE_LIMIT }].map(e => JSON.stringify(e)).join("\n") + "\n");
  // Equal-size replacements in one filesystem clock tick can retain mtime; make fixture changes deterministic.
  fs.utimesSync(file, now / 1000, (now - ageMs) / 1000);
};
const settingsModel = (board, task) => { board.writeHooks(task); return JSON.parse(fs.readFileSync(board.hooksFile(task.id), "utf8")).model; }; // the full id Claude Code is handed (models.ts CLAUDE_MODEL_IDS)

test("a Fable limit sends the account's Fable tasks to Opus from the next launch; other models and stale events are left alone", () => {
  const { board, task } = claudeTask();
  const seen = [];
  board.onStatus((e) => seen.push(e));
  board.update(task, { sessionId: "sess-fable", status: "running", model: "fable" });
  assert.equal(settingsModel(board, task), "claude-fable-5-2");
  fableEvents(board, task, 10 * 60_000); // after a reload: an old limit is not news
  board.syncStatus(task.id);
  assert.equal(settingsModel(board, task), "claude-fable-5-2");
  board.update(task, { status: "running" });
  fableEvents(board, task);
  board.syncStatus(task.id);
  assert.equal(task.status, "review");
  assert.equal(seen.at(-1).error, "Fable limit reached. Resume continues on Opus"); // no live terminal to continue in
  assert.equal(settingsModel(board, task), "claude-opus-5-5");
  // A task on the account default follows the model its sessions reported; an explicit other model is never changed.
  board.update(task, { model: undefined });
  assert.equal(settingsModel(board, task), "claude-opus-5-5");
  board.update(task, { model: "sonnet" });
  assert.equal(settingsModel(board, task), "claude-sonnet-5-5");
});

test("a session record naming the current extension host is never killed", () => {
  const { board, task } = claudeTask();
  board.update(task, { sessionId: "invalid-host-session" });
  board.external.set(task.sessionId, { pid: process.pid, sessionId: task.sessionId });
  const kill = process.kill;
  const killed = [];
  process.kill = (pid, signal) => { killed.push([pid, signal]); return true; };
  try {
    assert.equal(board.killSession(task), false);
    board.stop(task);
    assert.deepEqual(killed, []);
  } finally { process.kill = kill; }
});

test("a Fable limit in a live board terminal resumes the session on Opus and sends the refused prompt again", async () => {
  const { board, task } = claudeTask();
  const calls = [], sent = [];
  let live = { sendText: (t) => sent.push(t) };
  board.terminal = () => live;
  board.isOwner = () => true;
  board.stop = () => { calls.push("stop"); live = undefined; };
  board.ended = async () => true;
  board.resume = async () => { calls.push(`resume:${settingsModel(board, task)}`); live = { sendText: (t) => sent.push(t) }; return live; };
  board.waitForEvent = async () => ({ hook_event_name: "SessionStart" });
  board.update(task, { sessionId: "sess-fable-live", status: "running", model: "fable" });
  fableEvents(board, task);
  board.syncStatus(task.id);
  board.syncStatus(task.id); // the same event is acted on once
  await new Promise((r) => setTimeout(r, 1800));
  assert.deepEqual(calls, ["stop", "resume:claude-opus-5-5"]);
  assert.deepEqual(sent, ["\u001b[200~fix the build\u001b[201~\r"]);
});

test("hook.js keeps StopFailure's error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-hook-"));
  made.push(dir);
  const out = path.join(dir, "e.jsonl");
  execFileSync(process.execPath, [path.join(__dirname, "..", "hook", "hook.js"), out], { input: JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit", error_details: "long text" }) });
  const line = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.deepEqual([line.hook_event_name, line.error, line.error_details], ["StopFailure", "rate_limit", undefined]);
});

test("hook.js keeps stop_hook_active, so a Stop forced by a Stop hook shows in a card's events", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-hook-"));
  made.push(dir);
  const forced = path.join(dir, "forced.jsonl");
  execFileSync(process.execPath, [path.join(__dirname, "..", "hook", "hook.js"), forced], { input: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: "Fixed it." }) });
  const line = JSON.parse(fs.readFileSync(forced, "utf8"));
  assert.deepEqual([line.hook_event_name, line.stop_hook_active, line.last_assistant_message], ["Stop", true, "Fixed it."]);
  const plain = path.join(dir, "plain.jsonl");
  execFileSync(process.execPath, [path.join(__dirname, "..", "hook", "hook.js"), plain], { input: JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "Done." }) });
  assert.equal("stop_hook_active" in JSON.parse(fs.readFileSync(plain, "utf8")), false);
  const unforced = path.join(dir, "unforced.jsonl");
  execFileSync(process.execPath, [path.join(__dirname, "..", "hook", "hook.js"), unforced], { input: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Done." }) });
  assert.equal(JSON.parse(fs.readFileSync(unforced, "utf8")).stop_hook_active, false);
});

test("a board card whose session went idle without a Stop (Esc, or No at a permission prompt) moves to Review quietly; a waiting prompt keeps Needs input", () => {
  const { board, task, worktree } = claudeTask();
  const seen = [];
  board.onStatus((e) => seen.push(e));
  board.update(task, { sessionId: "sess-esc", status: "running" });
  task.updatedAt = ago(10_000);
  onlyEvent(board, task, "UserPromptSubmit", 10_000);
  // Busy: still working, however old its last hook event.
  let drop = sessionFile("sess-esc", worktree, "busy");
  try {
    board.tick();
    assert.equal(task.status, "running");
    // Idle, but the last hook event is fresh: a prompt just sent, before the CLI marks itself busy.
    drop(); drop = sessionFile("sess-esc", worktree, "idle");
    onlyEvent(board, task, "UserPromptSubmit", 0);
    board.tick();
    assert.equal(task.status, "running");
    // Idle and settled still does not prove interruption: a long tool can leave that state.
    onlyEvent(board, task, "PostToolUse", 6_000);
    board.tick();
    assert.equal(task.status, "running");
    interruptedTranscript(board, task);
    board.tick();
    assert.equal(task.status, "review");
    assert.deepEqual(seen.at(-1), { task, from: "running", to: "review", quiet: true });
    // A permission prompt: the session file says "waiting" (CLI 2.1.312), so Needs input stays however long it waits.
    board.update(task, { status: "needs-input" });
    task.updatedAt = ago(60_000);
    onlyEvent(board, task, "PermissionRequest", 60_000);
    drop(); drop = sessionFile("sess-esc", worktree, "waiting");
    board.tick();
    assert.equal(task.status, "needs-input");
    // Answered "No, tell Claude what to do differently": idle, no Stop.
    drop(); drop = sessionFile("sess-esc", worktree, "idle");
    board.tick();
    assert.equal(task.status, "review");
    // A Codex card is left to its own Interrupt hook.
    board.update(task, { status: "running", provider: "codex" });
    task.updatedAt = ago(60_000);
    assert.equal(board.interrupted(task), false);
  } finally { drop(); }
});

test("resuming a card whose turn ended without a Stop (No at a permission prompt, or Esc) keeps it in Review: hook events before the new SessionStart are the old process's", () => {
  // Seen on Windows, 31 October 2026 (card ba6eed): declined at a permission prompt, the card went to Review quietly; Resume in the panel
  // then fired SessionStart, the board read the old Notification again and warned "needs your input" until the idle scan moved it back.
  const { board, task } = claudeTask();
  board.update(task, { sessionId: "sess-resume", status: "review" });
  const seen = [];
  board.onStatus((e) => seen.push(e));
  const write = (names) => fs.writeFileSync(board.eventsFile(task.id), names.map((name, i) => JSON.stringify({ t: Date.now() - 60_000 + i, hook_event_name: name })).join("\n") + "\n");
  for (const before of [["UserPromptSubmit", "PermissionRequest", "Notification"], ["UserPromptSubmit", "PostToolUse"]]) {
    write(["SessionStart", ...before, "SessionStart"]);
    board.syncStatus(task.id);
    assert.equal(task.status, "review", `after ${before.at(-1)} and a resume`);
  }
  assert.deepEqual(seen, []);
  // The resumed session's own events still move the card.
  write(["SessionStart", "UserPromptSubmit", "PostToolUse", "SessionStart", "UserPromptSubmit"]);
  board.syncStatus(task.id);
  assert.equal(task.status, "running");
});

test("Delete card, keep worktree: a board card whose session still runs in a panel does not come back as a found card", () => {
  const { board, task, worktree } = claudeTask();
  const { transcriptPath } = require("../out/sessions.js");
  const transcript = transcriptPath(path.join(home, ".claude"), worktree, "sess-del");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "do it" } }) + "\n");
  board.update(task, { sessionId: "sess-del", status: "review" });
  const drop = sessionFile("sess-del", worktree, "idle"); // resumed in a Claude panel: a live session the board did not start
  try {
    board.tick();
    assert.equal(board.tasks.length, 1);
    board.remove(task);
    board.tick();
    assert.deepEqual(board.tasks, []);
    assert.ok(JSON.parse(fs.readFileSync(board.dismissedFile, "utf8")).includes("sess-del"));
  } finally { drop(); }
});

test("statusOf: a found session waiting on a prompt needs input", () => {
  const { statusOf } = require("../out/sessions.js");
  assert.deepEqual(["busy", "waiting", "idle", undefined].map((status) => statusOf({ status })), ["running", "needs-input", "review", "review"]);
});

test("a terminal session with no SessionStart after the wait says it waits on a prompt, and the warning's button shows its terminal with focus", async () => {
  const { board, task } = claudeTask();
  // Long enough that a slow resume under a full `npm test` still sees "not yet"; the checks below poll rather than sleep a fixed time.
  board.startNudgeMs = 1000;
  // A name of its own: earlier tests' boards (all "t") keep their 20-second nudges running and may warn meanwhile.
  board.update(task, { title: "waits on a prompt", sessionId: "sess-wait", status: "review" });
  onlyEvent(board, task, "SessionStart", 0, { source: "startup" });
  ask.answer = "Show terminal";
  const until = async (ok) => { for (let i = 0; i < 80 && !ok(); i++) await new Promise((r) => setTimeout(r, 100)); };
  try {
    await board.resume(task); // e.g. after Switch account to a folder that never ran the terminal CLI: its theme picker waits
    assert.equal(board.waitingToStart(task), false); // not yet
    await until(() => board.terminal(task).shows.length > 0);
    assert.equal(board.waitingToStart(task), true); // the earlier SessionStart is from before this launch
    assert.ok(warnings.some((w) => /"waits on a prompt" is waiting for Claude to start\. Answer the prompt in its terminal/.test(w)));
    assert.deepEqual(board.terminal(task).shows, [false]); // only this task's terminal: another test's nudge may answer "Show terminal" meanwhile
    fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: "SessionStart", source: "resume" }) + "\n");
    assert.equal(board.waitingToStart(task), false);
  } finally { ask.answer = undefined; }
  // A session that reports SessionStart in time gets no warning.
  const quick = board.add("started in time", "p");
  board.update(quick, { account: undefined, configDir: undefined, provider: undefined, worktree: task.worktree, sessionId: "sess-quick", status: "review" });
  await board.resume(quick);
  fs.appendFileSync(board.eventsFile(quick.id), JSON.stringify({ t: Date.now(), hook_event_name: "SessionStart", source: "resume" }) + "\n");
  await new Promise((r) => setTimeout(r, board.startNudgeMs + 300)); // past its nudge
  assert.ok(!warnings.some((w) => w.includes('"started in time"')));
  assert.equal(board.waitingToStart(quick), false);
  // No terminal, no waiting line.
  assert.equal(board.waitingToStart(board.add("n", "p")), false);
});

test("the start warning still appears if the wall clock has not advanced when its timer fires", async () => {
  const { board, task } = claudeTask();
  board.startNudgeMs = 30;
  board.update(task, { title: "clock did not advance", sessionId: "sess-clock", status: "review" });
  onlyEvent(board, task, "SessionStart", 0, { source: "startup" });
  const now = Date.now;
  const frozen = now();
  Date.now = () => frozen;
  try {
    await board.resume(task);
    for (let i = 0; i < 30 && !warnings.some((w) => w.includes('"clock did not advance"')); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(warnings.some((w) => w.includes('"clock did not advance"')));
  } finally { Date.now = now; }
});

test("the start warning does not appear after the terminal process has exited", async () => {
  const { board, task } = claudeTask();
  board.startNudgeMs = 30;
  board.update(task, { title: "terminal exited", sessionId: "sess-exited", status: "review" });
  onlyEvent(board, task, "SessionStart", 0, { source: "startup" });
  await board.resume(task);
  const term = board.terminal(task);
  assert.ok(term);
  term.exitStatus = { code: 0 };
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(!warnings.some((w) => w.includes('"terminal exited"')));
});

test("a subtask of a parent not started yet branches from the parent's new branch, not HEAD; a finished parent's subtask branches from HEAD", async () => {
  const repo = fixture().repo;
  const board = open(repo);
  const parent = board.add("parent", "p");
  const child = board.add("child", "c", undefined, parent.id);
  await board.ensureWorktree(child);
  assert.equal(parent.branch, `task/${parent.id}`);
  assert.ok(fs.existsSync(parent.worktree));
  assert.equal(parent.status, "queued"); // its worktree is made, its session not started
  assert.equal(sh(repo, "merge-base", child.branch, parent.branch), sh(repo, "rev-parse", parent.branch));
  fs.writeFileSync(path.join(parent.worktree, "p.txt"), "parent\n");
  sh(parent.worktree, "add", ".");
  sh(parent.worktree, "commit", "-qm", "parent work");
  const second = board.add("second", "s", undefined, parent.id);
  await board.ensureWorktree(second);
  assert.equal(await board.parentCommits(second), 1);
  assert.equal(await board.parentCommits(child), 0); // branched before the parent's commit, so its merge brings none of it
  const finished = board.add("finished", "f");
  board.update(finished, { status: "done" });
  const late = board.add("late", "l", undefined, finished.id);
  await board.ensureWorktree(late);
  assert.equal(finished.worktree, undefined);
  assert.equal(sh(repo, "rev-parse", late.branch), sh(repo, "rev-parse", "HEAD"));
  assert.equal(await board.parentCommits(late), 0);
});

test("hasUncommitted: modified or untracked files in the worktree count; a clean or deleted worktree does not", async () => {
  const { worktree, board, task } = withTask();
  assert.equal(await board.hasUncommitted(task), false);
  fs.writeFileSync(path.join(worktree, "new.txt"), "untracked\n");
  assert.equal(await board.hasUncommitted(task), true);
  fs.rmSync(path.join(worktree, "new.txt"));
  fs.writeFileSync(path.join(worktree, "a.txt"), "edited\n");
  assert.equal(await board.hasUncommitted(task), true);
  fs.rmSync(worktree, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); // Windows: git's last status can hold the folder (EPERM) a moment
  assert.equal(await board.hasUncommitted(task), false);
});

// A window that does not own the board: every change that acts outside tasks.json first is refused before it acts.
test("a window that does not own the board refuses Start, panel Start, worktree, Switch account and Delete before acting", async () => {
  const { repo, worktree } = fixture();
  const dir = path.join(repo, ".entomatical");
  const now = new Date().toISOString();
  const card = (id, extra) => ({ id, title: id, prompt: id, status: "queued", createdAt: now, updatedAt: now, ...extra });
  fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([card("fresh"), card("moved", { sessionId: "sess-m", worktree, branch: "task/t1", status: "review" })]));
  fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid: process.ppid, at: Date.now() })); // another window, stood in for by the parent process
  const board = switchBoard(repo, folders(repo));
  assert.equal(board.isOwner(), false);
  const fresh = board.get("fresh"), moved = board.get("moved");
  const notOwner = /Another VS Code window runs this repo's board/;
  const before = terminals.length, ran = commands.length;
  await assert.rejects(board.start(fresh), notOwner);
  await assert.rejects(board.startInPanel(fresh), notOwner);
  await assert.rejects(board.ensureWorktree(fresh), notOwner);
  assert.equal(sh(repo, "branch", "--list", "task/fresh"), ""); // no branch left behind to block the owner's Start
  assert.ok(!fs.existsSync(path.join(dir, "wt", "fresh")));
  assert.equal(terminals.length, before);
  assert.equal(commands.length, ran); // no panel opened
  // Switch account to the other provider sets the old events aside; refused first, SessionStart stays where Resume reads it.
  started(board, moved, "sess-m");
  assert.throws(() => board.switchAccount(moved, "Codex · team@example.com"), notOwner);
  assert.ok(fs.existsSync(board.eventsFile(moved.id)));
  assert.deepEqual(fs.readdirSync(path.join(dir, "events")).filter((f) => f.includes("before-switch")), []);
  // Resume and Open in panel launch a session (F45 review, 4 November 2026): before, both started one here.
  await assert.rejects(board.resume(moved), notOwner);
  await assert.rejects(board.openInPanel(moved), notOwner);
  assert.deepEqual([terminals.length, commands.length], [before, ran]);
  assert.throws(() => board.remove(moved), notOwner);
  assert.ok(!fs.existsSync(path.join(dir, "dismissed.json")) || !JSON.parse(fs.readFileSync(path.join(dir, "dismissed.json"), "utf8")).includes("sess-m"));
});

test("ensureWorktree reuses a task branch left by an earlier start that was never recorded, with or without its worktree", async () => {
  const { repo } = fixture();
  const board = open(repo);
  // Branch and worktree both left behind (what `worktree add -b` made before the save was refused).
  const left = board.add("left", "p");
  const leftDir = path.join(repo, ".entomatical", "wt", left.id);
  sh(repo, "worktree", "add", "-q", "-b", `task/${left.id}`, leftDir, "HEAD");
  await board.ensureWorktree(left);
  assert.equal(left.branch, `task/${left.id}`);
  // .native: the folder's true spelling. A card's TMP (F104) can name the drive "c:", and plain realpathSync keeps that letter's case.
  assert.equal(fs.realpathSync.native(left.worktree), fs.realpathSync.native(leftDir));
  // Only the branch is left (its folder deleted by hand): the worktree is made again on that branch, keeping its commits.
  const bare = board.add("bare", "p");
  const bareDir = path.join(repo, ".entomatical", "wt", bare.id);
  sh(repo, "worktree", "add", "-q", "-b", `task/${bare.id}`, bareDir, "HEAD");
  fs.writeFileSync(path.join(bareDir, "b.txt"), "kept\n");
  sh(bareDir, "add", ".");
  sh(bareDir, "commit", "-qm", "earlier work");
  fs.rmSync(bareDir, { recursive: true, force: true });
  await board.ensureWorktree(bare);
  assert.equal(bare.branch, `task/${bare.id}`);
  assert.equal(fs.readFileSync(path.join(bare.worktree, "b.txt"), "utf8"), "kept\n");
  assert.equal(sh(bare.worktree, "rev-parse", "--abbrev-ref", "HEAD"), `task/${bare.id}`);
});

/** The worktree is whole: on its task branch, every file checked out, nothing uncommitted, listed by git and not locked. */
function intact(repo, task) {
  assert.equal(sh(task.worktree, "rev-parse", "--abbrev-ref", "HEAD"), `task/${task.id}`);
  assert.equal(fs.readFileSync(path.join(task.worktree, "a.txt"), "utf8"), "one\n");
  assert.equal(sh(task.worktree, "status", "--porcelain"), "");
  const entry = sh(repo, "worktree", "list", "--porcelain").split("\n\n").find((b) => b.includes(`branch refs/heads/task/${task.id}`));
  assert.ok(entry && !/^locked/m.test(entry));
}

test("two Starts of one card at once leave one intact worktree: the second is refused, and worktree calls at once share one run", async () => {
  const { repo } = fixture();
  const board = open(repo);
  board.waitForEvent = async () => undefined; // no CLI runs here: the ready wait ends at once
  const card = () => { const t = board.add("t", "p"); board.update(t, { account: undefined, configDir: undefined, provider: undefined }); return t; };
  const a = card();
  const [first, second, panel] = await Promise.allSettled([board.start(a), board.start(a), board.startInPanel(a)]); // a double click, or the auto start after naming and a Start press
  assert.equal(first.status, "fulfilled");
  assert.match(second.reason.message, /^Already starting\.$/);
  assert.match(panel.reason.message, /^Already starting\.$/);
  intact(repo, a);
  const b = card();
  await Promise.all([board.ensureWorktree(b), board.ensureWorktree(b)]);
  intact(repo, b);
  // A subtask's start makes its parent's worktree; the parent's own start at the same moment waits on that run.
  const parent = card(), sub = board.add("s", "p", undefined, parent.id);
  await Promise.all([board.ensureWorktree(sub), board.ensureWorktree(parent)]);
  intact(repo, parent);
  assert.equal(sh(repo, "merge-base", "--is-ancestor", parent.branch, sub.branch), "");
});

test("ensureWorktree adopts only an unlocked worktree under .entomatical/wt, and leaves the user's own unmounted worktrees listed", async () => {
  const { repo } = fixture();
  const board = open(repo);
  const mine = `${repo}-mine`; // the user's own worktree on a drive that is not mounted now
  made.push(mine);
  sh(repo, "worktree", "add", "-q", "-b", "mine", mine, "HEAD");
  fs.rmSync(mine, { recursive: true, force: true });
  // A checkout cut off before git could clean up (VS Code killed mid-Start): git keeps it locked. Its files would be committed as deletions.
  const cut = board.add("cut", "p");
  const cutDir = path.join(repo, ".entomatical", "wt", cut.id);
  sh(repo, "worktree", "add", "-q", "-b", `task/${cut.id}`, cutDir, "HEAD");
  sh(repo, "worktree", "lock", "--reason", "initializing", cutDir);
  fs.rmSync(path.join(cutDir, "a.txt"));
  await assert.rejects(board.ensureWorktree(cut), /left over from a start that failed partway/);
  assert.equal(cut.worktree, undefined);
  fs.rmSync(cutDir, { recursive: true, force: true }); // the user deletes it, as the message says: the next Start makes it again
  await board.ensureWorktree(cut);
  intact(repo, cut);
  // A listed, unlocked worktree whose folder was emptied has no .git link: a session there would work in the main checkout's tree.
  const empty = board.add("empty", "p");
  const emptyDir = path.join(repo, ".entomatical", "wt", empty.id);
  sh(repo, "worktree", "add", "-q", "-b", `task/${empty.id}`, emptyDir, "HEAD");
  for (const f of fs.readdirSync(emptyDir)) fs.rmSync(path.join(emptyDir, f), { recursive: true, force: true });
  await board.ensureWorktree(empty).catch(() => undefined); // not adopted; this Start may fail on git's leftover entry
  if (empty.worktree) intact(repo, empty);
  else { await board.ensureWorktree(empty); intact(repo, empty); } // the failed Start cleared it: the next one makes it whole
  // The task's branch checked out in the main checkout is not the task's worktree: Start fails rather than run the task there.
  const main = board.add("main", "p");
  sh(repo, "checkout", "-q", "-b", `task/${main.id}`);
  await assert.rejects(board.ensureWorktree(main), /already/);
  assert.equal(main.worktree, undefined);
  sh(repo, "checkout", "-q", "main");
  assert.match(sh(repo, "worktree", "list", "--porcelain"), new RegExp(`branch refs/heads/mine`)); // no prune dropped it
});

// Hooks name copies of hook.js and statusline.js at a fixed path, not the versioned extension folder an update deletes.
const { placeHookScripts } = require("../out/board.js");
const bundle = (version, body = "// hook\n") => {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), `example-publisher.entomatical-${version}-`));
  made.push(ext);
  fs.mkdirSync(path.join(ext, "hook"));
  fs.writeFileSync(path.join(ext, "hook", "hook.js"), body);
  for (const name of ["statusline", "subagent-brief", "receipt-gate", "agent-fence", "plan-folder"]) fs.writeFileSync(path.join(ext, "hook", `${name}.js`), `// ${name}\n`);
  return path.join(ext, "hook", "hook.js");
};

test("placeHookScripts copies the six hook scripts to a fixed folder, rewriting them only when they differ", () => {
  const fixed = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-fixed-"));
  made.push(fixed);
  const dir = path.join(fixed, "hook");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agent-router.js"), "// retired\n");
  const first = bundle("0.7.3");
  assert.equal(placeHookScripts(first, dir), path.join(dir, "hook.js"));
  assert.equal(fs.readFileSync(path.join(dir, "hook.js"), "utf8"), "// hook\n");
  assert.equal(fs.readFileSync(path.join(dir, "statusline.js"), "utf8"), "// statusline\n");
  const old = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000); // whole seconds: utimes keeps them exactly
  fs.utimesSync(path.join(dir, "hook.js"), old, old);
  placeHookScripts(bundle("0.7.3"), dir); // same content: left alone
  assert.equal(fs.statSync(path.join(dir, "hook.js")).mtimeMs, old.getTime());
  placeHookScripts(bundle("0.7.4", "// hook v2\n"), dir); // an update: replaced
  assert.equal(fs.readFileSync(path.join(dir, "hook.js"), "utf8"), "// hook v2\n");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["agent-fence.js", "hook.js", "plan-folder.js", "receipt-gate.js", "statusline.js", "subagent-brief.js"]); // no temp file or retired router left
  // Nothing bundled (or not copyable): the given path, as before.
  const missing = path.join(fixed, "nowhere", "hook.js");
  assert.equal(placeHookScripts(missing, dir), missing);
  // Any one script missing from the bundle: the bundled path too.
  const partial = bundle("0.7.5");
  fs.rmSync(path.join(path.dirname(partial), "agent-fence.js"));
  assert.equal(placeHookScripts(partial, dir), partial);
});

test("a task's hooks file names the fixed scripts, and an old one naming a deleted extension folder is refreshed", () => {
  const { repo, worktree } = fixture();
  const fixed = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical fixed-")); // a space, as a Windows profile path may hold
  made.push(fixed);
  const dir = path.join(fixed, "hook");
  const board = new Board(repo, bundle("0.7.3"), dir);
  boards.push(board);
  assert.equal(board.hookScript, path.join(dir, "hook.js"));
  const task = board.add("t", "p");
  board.update(task, { account: undefined, configDir: undefined, provider: undefined, worktree, branch: "task/t1", sessionId: "sess-h", status: "review" });
  // Written by Entomatical 0.5.5, whose folder VSCodium has deleted since.
  const gone = "/home/x/.vscode-oss/extensions/example-publisher.entomatical-0.5.5/hook";
  fs.writeFileSync(board.hooksFile(task.id), JSON.stringify({ statusLine: { command: `node "${gone}/statusline.js"` }, hooks: { Stop: [{ hooks: [{ type: "command", command: `node "${gone}/hook.js" "x"` }] }] } }));
  board.tick();
  const text = fs.readFileSync(board.hooksFile(task.id), "utf8");
  const settings = JSON.parse(text);
  const fwd = (p) => p.replace(/\\/g, "/");
  assert.deepEqual(settings.hooks.Stop[0].hooks[0], hookCommand(board, "hook.js", board.eventsFile(task.id)));
  assert.ok(settings.statusLine.command.startsWith(`node "${fwd(path.join(dir, "statusline.js"))}" `)); // the status line has no exec form
  assert.ok(!text.includes("entomatical-0.5.5"));
  // Unchanged content is not written again.
  const old = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  fs.utimesSync(board.hooksFile(task.id), old, old);
  board.writeHooks(task);
  assert.equal(fs.statSync(board.hooksFile(task.id)).mtimeMs, old.getTime());
});

test("a Claude card with a saved transcript but no SessionStart (hooks pointed at a deleted folder) is kept: Resume and Switch account continue it", () => {
  const { repo, worktree } = fixture();
  const f = folders(repo);
  const board = switchBoard(repo, f);
  const task = board.add("Hookless", "Do it", "team@example.com");
  board.update(task, { sessionId: "hookless-1", worktree, status: "queued" });
  assert.equal(board.everReady(task), false); // no transcript yet: never came up
  const from = transcriptPath(f.organization, worktree, "hookless-1");
  fs.mkdirSync(path.dirname(from), { recursive: true });
  fs.writeFileSync(from, '{"type":"user"}\n');
  assert.equal(board.everReady(task), true);
  // Resume: the conversation is not discarded, so the extension resumes rather than starting over.
  assert.equal(board.resetUnstarted(task), false);
  board.tick(); // nor does discover() reset it
  assert.equal(task.sessionId, "hookless-1");
  // Claude to Claude: the conversation is carried and resumed, not dropped for a fresh start.
  assert.equal(board.switchAccount(task, "personal@example.com (alternate)"), "resume");
  assert.equal(task.sessionId, "hookless-1");
  assert.equal(fs.readFileSync(transcriptPath(f.alternate, worktree, "hookless-1"), "utf8"), '{"type":"user"}\n');
});

test("a panel start that fails keeps a moved task's continuation prompt for the next Start", async () => {
  const { repo } = fixture();
  const board = open(repo);
  board.waitForEvent = async () => undefined; // no panel reports in
  const task = board.add("Moved", "do it");
  board.continuations.set(task.id, "do it\n\nearlier work is already here"); // what switchAccount sets for a started task moving provider
  await assert.rejects(board.startInPanel(task), /did not start through Entomatical's wrapper/);
  assert.equal(task.sessionId, undefined);
  assert.equal(board.promptFor(task), "do it\n\nearlier work is already here");
});

test("editor mode: a Codex first turn that ends after another window's save reloaded the tasks still resets its card", async () => {
  const codex = require("../out/codex.js");
  const fake = require("./fake-codex-use.js").useFakeCodex(codex);
  process.env.FAKE_CODEX_TRUSTED = codex.CODEX_HOOKS.map((e) => `/<session-flags>/config.toml:${e.replace(/[A-Z]/g, (ch, i) => (i ? "_" : "") + ch.toLowerCase())}:0:0`).join(",");
  try {
    await codex.discoverCodex();
    const { repo } = fixture();
    const board = open(repo);
    board.codexEditor = () => true;
    const { EventEmitter: Emitter } = require("node:events");
    const { PassThrough } = require("node:stream");
    let child;
    board.runCodex = () => (child = Object.assign(new Emitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: undefined }));
    const task = board.add("", "fix the bug", "Codex · user@example.test");
    await board.start(task);
    assert.ok(task.sessionId);
    board.loadedAt = -1; // as if another window saved tasks.json: reload() replaces every task object
    board.reload();
    const fresh = board.get(task.id);
    assert.notEqual(fresh, task);
    const ended = new Promise((r) => board.onChange(() => { if (!board.own().includes(task.id)) r(); }));
    child.stdout.end(); child.stderr.end();
    child.emit("close", 1); // no SessionStart: Codex made no conversation
    await ended;
    await new Promise((r) => setImmediate(r));
    assert.deepEqual([fresh.sessionId, fresh.codexEditor, fresh.status], [undefined, undefined, "queued"]);
    assert.match(warnings.at(-1), /ended with exit code 1/);
  } finally { fake.done(); delete process.env.FAKE_CODEX_TRUSTED; }
});

test("a Codex first-turn retry keeps continuation text but reads linked context only once, fresh", async () => {
  const codex = require("../out/codex.js");
  const fake = require("./fake-codex-use.js").useFakeCodex(codex);
  process.env.FAKE_CODEX_TRUSTED = codex.CODEX_HOOKS.map((e) => `/<session-flags>/config.toml:${e.replace(/[A-Z]/g, (ch, i) => (i ? "_" : "") + ch.toLowerCase())}:0:0`).join(",");
  try {
    await codex.discoverCodex();
    const { repo } = fixture(), board = open(repo), runs = [];
    board.codexEditor = () => true;
    board.runCodex = () => { const server = fakeAppServer(undefined); runs.push(server); return server.child; };
    let reads = 0;
    board.beforeStart = async (task) => board.startContext.set(task.id, `\n\nObsidian context ${++reads}`);
    const task = board.add("", "fix it", "Codex · user@example.test");
    board.continuations.set(task.id, "fix it\n\nearlier work remains");
    await board.start(task);
    const first = runs[0];
    const init = await first.next("initialize"); first.answer(init.id, {});
    const thread = await first.next("thread/start"); first.answer(thread.id, { thread: { id: "thread-1" } });
    const turn = await first.next("turn/start");
    assert.equal(turn.params.input[0].text, "fix it\n\nearlier work remains\n\nObsidian context 1");
    first.answer(turn.id, { turn: { id: "turn-1" } });
    await new Promise((r) => setImmediate(r)); // the request was accepted, but SessionStart never arrived
    const ended = new Promise((r) => board.onChange(() => { if (!board.own().includes(task.id)) r(); }));
    first.child.stdout.end(); first.child.stderr.end(); first.child.emit("close", 1);
    await ended;
    assert.equal(board.promptFor(task), "fix it\n\nearlier work remains\n\nObsidian context 1");
    await board.start(task);
    assert.equal(board.promptFor(task), "fix it\n\nearlier work remains\n\nObsidian context 2");
    const again = new Promise((r) => board.onChange(() => { if (!board.own().includes(task.id)) r(); }));
    runs[1].child.stdout.end(); runs[1].child.stderr.end(); runs[1].child.emit("close", 1);
    await again;
  } finally { fake.done(); delete process.env.FAKE_CODEX_TRUSTED; }
});

test("opening in the panel links a conversation saved under another account folder into the task's, and names the path when none has it", async () => {
  const { repo, worktree } = fixture();
  const f = folders(repo);
  const board = switchBoard(repo, f);
  const task = board.add("T", "work", "personal@example.com (alternate)");
  board.update(task, { sessionId: "s-moved", worktree });
  const before = commands.length;
  await assert.rejects(board.openInPanel(task), new RegExp(`no saved conversation \\(looked for .*${path.basename(f.alternate)}.*s-moved\\.jsonl\\)`));
  assert.equal(commands.length, before, "no Claude panel was opened");
  const real = transcriptPath(f.main, worktree, "s-moved"); // the session ran on ~/.claude; the card's account is alternate
  fs.mkdirSync(path.dirname(real), { recursive: true }); fs.writeFileSync(real, "{}\n");
  await board.openInPanel(task, f.organization); // the panel itself is on a third account
  assert.deepEqual(commands.slice(before).map((c) => c[0]), ["claude-vscode.editor.open"]);
  const own = transcriptPath(f.alternate, worktree, "s-moved"), seen = transcriptPath(f.organization, worktree, "s-moved");
  assert.ok(fs.existsSync(own), "linked into the task's account folder, where the wrapper resumes it");
  assert.ok(fs.existsSync(seen), "linked into the panel's history folder");
  assert.equal(fs.statSync(own).ino, fs.statSync(real).ino, "the same file, not a copy");
  assert.equal(fs.statSync(seen).ino, fs.statSync(real).ino);
  assert.equal(fs.statSync(transcriptPath(f.organization, repo, "s-moved")).ino, fs.statSync(real).ino, "in the repo's project folder, the one the panel lists");
});

test("opening in the panel finds a conversation saved under the folder's old name after the workspace folder was renamed (F118)", async () => {
  const { repo, worktree } = fixture();
  const f = folders(repo);
  const board = switchBoard(repo, f);
  const task = board.add("T", "work", "personal@example.com (alternate)");
  board.update(task, { sessionId: "s-renamed", worktree });
  // The session ran while the folder had another name, and Claude names a project folder after the cwd.
  const real = transcriptPath(f.alternate, path.join(path.dirname(repo), "name-before-the-rename", ".entomatical", "wt", "t1"), "s-renamed");
  fs.mkdirSync(path.dirname(real), { recursive: true }); fs.writeFileSync(real, "{}\n");
  require("../out/sessions.js").forgetSessionPlaces(); // an earlier test's listing is seconds old
  const before = commands.length;
  await board.openInPanel(task, f.alternate);
  assert.deepEqual(commands.slice(before).map((c) => c[0]), ["claude-vscode.editor.open"]);
  const own = transcriptPath(f.alternate, worktree, "s-renamed");
  assert.equal(fs.statSync(own).ino, fs.statSync(real).ino, "the same file, under the project folder named after the worktree's path now");
  assert.equal(board.everReady(task), true); // and a terminal Resume takes it for a conversation to resume
});

// linux, 6 November 2026 (F82, Claude Code 2.1.318): Resume in the panel left "Resume." in the panel's message box and never sent it,
// because the extension only types an initialPrompt into the input (setInputText). The wrapper sends it instead, from the launch file.
test("Resume in the panel gives the wrapper the prompt to send, not the panel's message box", async () => {
  const { repo, worktree } = fixture();
  const f = folders(repo);
  const board = switchBoard(repo, f);
  const task = board.add("T", "work", "personal@example.com (alternate)");
  board.update(task, { sessionId: "s-resume", worktree });
  const real = transcriptPath(f.alternate, worktree, "s-resume");
  fs.mkdirSync(path.dirname(real), { recursive: true }); fs.writeFileSync(real, "{}\n");
  const before = commands.length;
  await board.openInPanel(task, f.organization, "Resume.");
  assert.deepEqual(commands.slice(before), [["claude-vscode.editor.open", "s-resume"]], "no initialPrompt for the panel to leave unsent");
  const lines = fs.readFileSync(path.join(repo, ".entomatical", "launch", "s-resume.txt"), "utf8").split("\r\n");
  assert.equal(lines[0], worktree);
  assert.equal(fs.readFileSync(lines[3], "utf8"), "Resume.", "the launch file names the prompt file the wrapper sends once");
  await board.openInPanel(task, f.organization); // a plain open (Open, history) carries no prompt
  assert.equal(fs.readFileSync(path.join(repo, ".entomatical", "launch", "s-resume.txt"), "utf8").split("\r\n").length, 3);
});

// the user, 31 October 2026: Resume on d3d51a opened a blank chat. The panel's list had no such session (the panel lists ~/.claude while the
// IDE setting names an account), so the webview started a new one. Every board tick keeps the session in the folder the panel really lists.
test("a board session stays in the history folder the panel really lists, when that is not the IDE's account", () => {
  const { repo, worktree } = fixture();
  const f = folders(repo);
  const board = switchBoard(repo, f);
  board.ideConfigDir = () => f.organization;
  board.panelHistoryDir = () => f.main;
  const task = board.add("T", "work", "personal@example.com (alternate)");
  const real = transcriptPath(f.alternate, worktree, "s-listed");
  fs.mkdirSync(path.dirname(real), { recursive: true }); fs.writeFileSync(real, "{}\n");
  board.update(task, { sessionId: "s-listed", worktree, transcript: real });
  board.keepHistory(task);
  assert.equal(fs.statSync(transcriptPath(f.main, repo, "s-listed")).ino, fs.statSync(real).ino);
});

// the user, 30 October 2026: Codex tabs stopped showing the card's title. Codex has no --name, so the board names the thread itself: when
// SessionStart gives the card Codex's thread id, and again when a turn ends (Codex names threads itself after a turn). Only user or
// generated titles (named) go on the thread; a title taken from the prompt would hide Codex's own.
test("a named Codex card's title goes on its thread when the thread is known and after each turn; an unnamed card's does not", async () => {
  const { repo } = fixture();
  const board = open(repo);
  const names = [];
  board.setCodexName = async (thread, name) => { names.push([thread, name]); };
  const task = board.add("Fix the login bug", "fix the bug", "Codex · user@example.test");
  board.update(task, { sessionId: "made-up" });
  const hook = (name, extra = {}) => { fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: name, session_id: "thread-9", ...extra }) + "\n"); board.syncStatus(task.id); };
  assert.equal(await board.nameThread(task), false, "before SessionStart the id is not Codex's");
  hook("SessionStart", { source: "startup" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([task.sessionId, names], ["thread-9", [["thread-9", "Fix the login bug"]]]);
  hook("UserPromptSubmit", { prompt: "fix the bug" });
  await new Promise((r) => setImmediate(r));
  assert.equal(names.length, 1, "a running turn sets nothing");
  hook("Stop", { last_assistant_message: "Fixed." });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([task.status, names.length], ["review", 2]);
  assert.equal(await board.nameThread(task), false, "the same title at the same status is not sent twice");
  board.update(task, { title: "Login fix" , named: true });
  assert.equal(await board.nameThread(task), true);
  assert.deepEqual(names.at(-1), ["thread-9", "Login fix"]);
  // A failure is reported and does not stick: the next attempt tries again.
  board.setCodexName = async () => { throw new Error("Codex closed."); };
  board.update(task, { title: "Another" , named: true });
  const w = warnings.length;
  assert.equal(await board.nameThread(task), false);
  assert.match(warnings[w], /did not take the title "Another"/);
  board.setCodexName = async (thread, name) => { names.push([thread, name]); };
  assert.equal(await board.nameThread(task), true);
  // Unnamed: the title came from the prompt, so Codex keeps its own naming.
  const plain = board.add("", "run the tests", "Codex · user@example.test");
  board.update(plain, { sessionId: "x" });
  fs.appendFileSync(board.eventsFile(plain.id), JSON.stringify({ t: Date.now(), hook_event_name: "SessionStart", session_id: "thread-10" }) + "\n"); board.syncStatus(plain.id);
  await new Promise((r) => setImmediate(r));
  assert.equal(await board.nameThread(plain), false);
  assert.ok(!names.some(([t]) => t === "thread-10"));
});

test("the prompt list pairs each prompt with the first 600 characters of its turn's answer, from hook events and from a saved transcript", () => {
  const { board, task } = claudeTask();
  const long = (c) => c.repeat(700);
  fs.writeFileSync(board.eventsFile(task.id), [
    { t: 1, hook_event_name: "UserPromptSubmit", prompt: "first" }, { t: 2, hook_event_name: "Stop", last_assistant_message: long("a") },
    { t: 3, hook_event_name: "UserPromptSubmit", prompt: "second" }, { t: 4, hook_event_name: "Stop", last_assistant_message: "short" }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  assert.deepEqual(board.prompts(task), [{ text: "first", reply: long("a").slice(0, 600) }, { text: "second", reply: "short" }]);
  const transcript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ab-answers-")), "t.jsonl");
  fs.writeFileSync(transcript, [{ type: "user", message: { content: "found prompt" } }, { type: "assistant", message: { content: [{ type: "text", text: long("b") }] } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  board.update(task, { transcript });
  assert.deepEqual(board.prompts(task), [{ text: "found prompt", reply: long("b").slice(0, 600) }]);
});

test("RT-08: the card prompt list preserves a Codex reply written one UTF-8 byte at a time", () => {
  const { board, task } = claudeTask();
  const transcript = path.join(board.repo, "history.jsonl");
  board.update(task, { provider: "codex", transcript });
  const text = "How was the café?", reply = "Excellent ☕ 🦊";
  const prompt = { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text }] } };
  const line = (payload) => JSON.stringify({ type: "event_msg", payload }) + "\n";
  fs.writeFileSync(transcript, line(prompt));
  const answer = Buffer.from(line({ type: "task_complete", last_agent_message: reply }));
  const split = answer.indexOf("🦊");
  fs.appendFileSync(transcript, answer.subarray(0, split));
  for (let i = split; i < split + 4; i++) {
    fs.appendFileSync(transcript, answer.subarray(i, i + 1));
    assert.deepEqual(board.prompts(task), [{ text }]);
  }
  fs.appendFileSync(transcript, answer.subarray(split + 4));
  assert.deepEqual(board.prompts(task), [{ text, reply }]);
  assert.deepEqual(board.prompts(task), [{ text, reply }]);
});

test("merging speech history keeps legacy events readable and does not import it again after deletion", () => {
  const { repo } = fixture();
  const legacy = path.join(repo, '.entomatical-speech');
  fs.mkdirSync(path.join(legacy, 'events'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'tasks.json'), JSON.stringify([{id:'old001',title:'Speech task',prompt:'done',status:'done',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}]));
  fs.writeFileSync(path.join(legacy, 'events', 'old001.jsonl'), JSON.stringify({t:Date.now(),hook_event_name:'Stop',last_assistant_message:'Kept answer'})+'\n');
  const board = open(repo), task = board.get('old001');
  assert.equal(task.legacySpeechId,'old001');
  assert.equal(board.lastReply(task),'Kept answer');
  assert.equal(board.eventsFile(task.id),path.join(legacy,'events','old001.jsonl'));
  board.tasks.splice(board.tasks.indexOf(task),1);board.save();board.importedSpeech=false;board.tick();
  assert.equal(board.get('old001'),undefined);
  assert.ok(fs.existsSync(path.join(legacy,'tasks.json')));
});

for (const interrupted of [undefined, "tasks.json", "speech-imported.json"]) {
  test(`speech import keeps deletion history across later imports and reopens (interrupted: ${interrupted ?? "none"})`, () => {
    const { repo } = fixture();
    const dir = path.join(repo, ".entomatical");
    const legacy = path.join(repo, ".entomatical-speech");
    const source = path.join(legacy, "tasks.json");
    const marker = path.join(dir, "speech-imported.json");
    const card = id => ({ id, title: id, prompt: id, status: "done", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const first = card("old001"), second = card("old002");
    fs.mkdirSync(legacy);
    fs.writeFileSync(source, JSON.stringify([first]));
    let board = open(repo);
    board.remove(board.get(first.id));
    board.dispose();
    const original = JSON.stringify([first, second]);
    fs.writeFileSync(source, original);

    if (interrupted) {
      const target = path.join(dir, interrupted), rename = fs.renameSync;
      let failures = 0;
      fs.renameSync = function (from, to) {
        if (!failures && to === target) {
          failures++;
          throw Object.assign(new Error("Injected speech migration interruption"), { code: "EIO" });
        }
        return rename(from, to);
      };
      try { board = open(repo); } finally { fs.renameSync = rename; }
      assert.equal(failures, 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(marker)), [first.id]);
      assert.equal(!!board.get(second.id), interrupted === "speech-imported.json");
      board.tick();
      board.dispose();
    }
    for (let i = 0; i < 2; i++) {
      board = open(repo);
      assert.equal(board.get(first.id), undefined);
      assert.equal(board.get(second.id)?.legacySpeechId, second.id);
      assert.deepEqual(JSON.parse(fs.readFileSync(marker)), [first.id, second.id]);
      board.dispose();
    }
    assert.equal(fs.readFileSync(source, "utf8"), original);
  });
}

// Codex's editor titles a tab from the thread's name only when the tab opens, so Rename closes and reopens an open tab.
test("reopenInCodex closes the task's open Codex tab and opens it again; nothing when none is open", async () => {
  const { repo } = fixture();
  const board = open(repo);
  const task = board.add("Named", "work", "Codex · user@example.test");
  board.update(task, { sessionId: "thread-9", worktree: path.join(repo, "wt"), adopted: true });
  const closed = [];
  const tab = (p) => ({ input: new vscode.TabInputCustom({ scheme: "openai-codex", path: p }) });
  vscode.window.tabGroups = { all: [{ tabs: [tab("/local/other"), { input: {} }] }, { tabs: [tab("/local/thread-9")] }], close: async (tabs) => { closed.push(...tabs); } };
  try {
    const before = commands.length;
    assert.equal(await board.reopenInCodex(task), true);
    assert.deepEqual(closed.map((t) => t.input.uri.path), ["/local/thread-9"]);
    assert.equal(commands.length, before + 1);
    assert.deepEqual([commands.at(-1)[0], String(commands.at(-1)[1])], ["vscode.openWith", "openai-codex://route/local/thread-9"]);
    vscode.window.tabGroups.all = [{ tabs: [tab("/local/other")] }];
    assert.equal(await board.reopenInCodex(task), false);
    assert.equal(commands.length, before + 1);
  } finally { delete vscode.window.tabGroups; }
});

// F06 fixes of 4 November 2026.
// The board caches an events file by its size and mtime; a rewrite of the same size within the same clock tick would read as unchanged
// (seen on Windows, 4 November 2026: the hold-the-Review test flaked), so each write gets a later mtime.
let eventsWrites = 0;
const writeEvents = (board, task, events) => {
  const file = board.eventsFile(task.id);
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const at = new Date(Date.now() + ++eventsWrites);
  fs.utimesSync(file, at, at);
};

test("a subagent's Stop or StopFailure leaves the parent card Running; its permission prompt still needs input", () => {
  const { board, task } = claudeTask();
  board.update(task, { sessionId: "sess-sub", status: "running" });
  const now = Date.now();
  const events = [{ t: now - 3, hook_event_name: "SessionStart" }, { t: now - 2, hook_event_name: "UserPromptSubmit", prompt: "go" },
    { t: now - 1, hook_event_name: "StopFailure", agent_id: "a1", error: "overloaded" }, { t: now, hook_event_name: "Stop", agent_id: "a1" }];
  writeEvents(board, task, events);
  board.syncStatus(task.id);
  assert.equal(task.status, "running"); // seen 4 Nov 2026 on card 817bb4: a subagent's StopFailure moved it to Review mid-turn
  writeEvents(board, task, [...events, { t: now + 1, hook_event_name: "PermissionRequest", agent_id: "a1" }]);
  board.syncStatus(task.id);
  assert.equal(task.status, "needs-input");
  writeEvents(board, task, [...events, { t: now + 1, hook_event_name: "PostToolUse" }, { t: now + 2, hook_event_name: "Stop" }]);
  board.syncStatus(task.id);
  assert.equal(task.status, "review"); // the task's own Stop
});

test("a window that takes the board over applies hook events no window watched before it scans: a Stop during a reload is a normal Review", () => {
  const { repo } = fixture();
  const dir = path.join(repo, ".entomatical");
  const old = new Date(Date.now() - 60_000).toISOString();
  fs.mkdirSync(path.join(dir, "events"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([{ id: "t1", title: "t1", prompt: "t1", status: "running", sessionId: "s1", createdAt: old, updatedAt: old }]));
  fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid: process.ppid, at: Date.now() })); // another window owns it
  const board = open(repo);
  const now = Date.now();
  fs.writeFileSync(path.join(dir, "events", "t1.jsonl"), [{ t: now - 60_000, hook_event_name: "SessionStart" }, { t: now - 59_000, hook_event_name: "UserPromptSubmit", prompt: "t1" },
    { t: now, hook_event_name: "Stop", last_assistant_message: "Done." }].map((e) => JSON.stringify(e)).join("\n") + "\n"); // while that window was reloading
  fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid: process.ppid, at: Date.now() - 60_000 }));
  const seen = [];
  board.onStatus((e) => seen.push([e.to, !!e.quiet]));
  board.tick();
  const task = board.get("t1");
  assert.deepEqual([task.status, task.interrupted, seen], ["review", undefined, [["review", false]]]); // not a quiet "session gone"
  board.tick();
  assert.equal(seen.length, 1); // replayed once
});

test("a replayed hook event older than the card's last change does not move it (poll mode after Esc)", () => {
  const watch = fs.watch;
  fs.watch = () => { throw Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" }); };
  let f;
  try { f = claudeTask(); } finally { fs.watch = watch; }
  const { board, task } = f;
  board.update(task, { sessionId: "sess-esc", status: "running" });
  onlyEvent(board, task, "UserPromptSubmit", 20_000);
  board.update(task, { status: "review" }); // the idle scan's quiet Review after Esc, newer than the prompt
  board.tick();
  assert.equal(task.status, "review");
});

test("Codex interrupts are unfinished work: the Interrupt hook and an aborted turn in Codex's editor move the card quietly", () => {
  const { repo, board, task } = withTask();
  const seen = [];
  board.onStatus((e) => seen.push([e.to, !!e.quiet]));
  board.update(task, { provider: "codex", sessionId: "th1", status: "running" });
  const now = Date.now();
  writeEvents(board, task, [{ t: now - 2, hook_event_name: "SessionStart", session_id: "th1" }, { t: now - 1, hook_event_name: "UserPromptSubmit", session_id: "th1", prompt: "go" },
    { t: now, hook_event_name: "Interrupt", session_id: "th1" }]);
  board.syncStatus(task.id);
  assert.deepEqual([task.status, task.interrupted, seen.at(-1)], ["review", true, ["review", true]]);
  // Codex's editor: the card follows its rollout; turn_aborted is Esc there, task_complete a finished turn.
  const rollout = path.join(repo, "rollout-2026-11-04T10-00-00-th2.jsonl");
  const rec = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n";
  const editor = board.add("e", "go", "Codex · user@example.test");
  board.update(editor, { provider: "codex", codexEditor: true, transcript: rollout, sessionId: "th2", status: "running", worktree: repo });
  fs.writeFileSync(rollout, rec("session_meta", { id: "th2", cwd: repo, source: "vscode" }) + rec("event_msg", { type: "task_started" }) + rec("event_msg", { type: "turn_aborted" }));
  board.tick();
  assert.deepEqual([editor.status, editor.interrupted, seen.at(-1)], ["review", true, ["review", true]]);
  fs.appendFileSync(rollout, rec("event_msg", { type: "task_started" }));
  board.tick();
  fs.appendFileSync(rollout, rec("event_msg", { type: "task_complete", last_agent_message: "Done." }));
  board.tick();
  assert.deepEqual([editor.status, editor.interrupted, seen.at(-1)], ["review", undefined, ["review", false]]);
});

test("Merge, Discard and Finish refuse while the card's acceptance checks are running", async () => {
  const { repo, board, task } = withTask();
  board.recordChecks(task, { status: "running", run: path.join(board.dir, "checks", task.id, "1") });
  // A check that never exits would hold the card for good: the card offers Retry checks while they run (board.js), and this says so.
  const running = /Acceptance checks are still running\. Wait for them, or use Retry checks to start them again\./;
  await assert.rejects(board.finish(task, "merge"), running);
  await assert.rejects(board.finish(task, "discard"), running);
  // the user, 7 November 2026: Finish never stops work under way, so it refuses before its dialog.
  let asked = false;
  await assert.rejects(board.complete(task, async () => (asked = true)), /is still working \(its acceptance checks are running\)\. Finish does not stop work/);
  assert.equal(asked, false);
  assert.match(sh(repo, "branch", "--list"), /task\/t1/);
  assert.deepEqual([task.status, task.checks.status], ["queued", "running"]);
});

test("a parent's Stop while a background subagent still works keeps the card Running; the Stop after the re-prompt gives one Review (card 817bb4)", () => {
  const { board, task, worktree } = claudeTask();
  const seen = [];
  board.onStatus((e) => seen.push([e.from, e.to, !!e.quiet]));
  board.update(task, { sessionId: "sess-bg", status: "running" });
  // Card 817bb4's events from 10:14:26 on 4 November 2026 (agent a1ea61, general-purpose), at their real offsets in seconds.
  const base = Date.now() - 120_000, at = (s, name, agent, extra = {}) => ({ t: base + s * 1000, hook_event_name: name, ...(agent ? { agent_id: "a1ea61", agent_type: "general-purpose" } : {}), ...extra });
  const events = [at(-60, "SessionStart", false, { source: "resume" }), at(0, "SubagentStart", true), at(0, "UserPromptSubmit", false, { prompt: "go" }),
    at(1, "PostToolUse", true), at(3, "PostToolUse"), at(3, "UserPromptSubmit", false, { prompt: "more" }), at(8, "PostToolUse", true), at(8, "PostToolUse"),
    at(10, "Stop", false, { last_assistant_message: "Started the agent." })];
  writeEvents(board, task, events);
  board.syncStatus(task.id);
  assert.equal(task.status, "running");
  events.push(...[11, 12, 12, 13, 14, 16, 16, 17, 25].map((s) => at(s, "PostToolUse", true)));
  writeEvents(board, task, events);
  board.syncStatus(task.id);
  assert.equal(task.status, "running");
  // Its session is idle between the agent's tool calls: the idle scan leaves the card alone while the agent works.
  task.updatedAt = ago(60_000);
  const drop = sessionFile("sess-bg", worktree, "idle");
  try { board.tick(); } finally { drop(); }
  assert.equal(task.status, "running");
  events.push(at(30, "SubagentStop", true), at(31, "UserPromptSubmit", false, { prompt: "<task-notification>done</task-notification>" }), at(40, "Stop", false, { last_assistant_message: "All done." }));
  writeEvents(board, task, events);
  board.syncStatus(task.id);
  assert.equal(task.status, "review");
  assert.deepEqual(seen.filter(([, to]) => to === "review"), [["running", "review", false]]);
});

test("a subagent that never sent SubagentStop and has been silent for 15 minutes does not hold its parent's Stop", () => {
  const { board, task } = claudeTask();
  board.update(task, { sessionId: "sess-crash", status: "running" });
  const now = Date.now();
  writeEvents(board, task, [{ t: now - 16 * 60_000, hook_event_name: "SubagentStart", agent_id: "gone" }, { t: now - 1000, hook_event_name: "UserPromptSubmit", prompt: "go" },
    { t: now, hook_event_name: "Stop" }]);
  board.syncStatus(task.id);
  assert.equal(task.status, "review");
});

test("poll mode: a Stop followed within one poll by a rename still moves the card to Review", () => {
  const watch = fs.watch;
  fs.watch = () => { throw Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" }); };
  let f;
  try { f = claudeTask(); } finally { fs.watch = watch; }
  const { board, task } = f;
  board.update(task, { sessionId: "sess-rename", status: "running" });
  const t = Date.now();
  onlyEvent(board, task, "Stop", 0);
  fs.utimesSync(board.eventsFile(task.id), t / 1000, t / 1000);
  board.update(task, { title: "Renamed" });
  task.updatedAt = new Date(t + 5).toISOString(); // the rename, 5 ms after the Stop
  board.tick();
  assert.equal(task.status, "review");
});

test("a StopFailure written after the idle scan's quiet Review still warns and marks the card Interrupted, once (F42)", () => {
  const { board, task, worktree } = claudeTask();
  const seen = [];
  board.onStatus((e) => seen.push(e));
  board.update(task, { sessionId: "sess-late", status: "running" });
  task.updatedAt = ago(10_000);
  onlyEvent(board, task, "UserPromptSubmit", 10_000);
  const drop = sessionFile("sess-late", worktree, "idle");
  interruptedTranscript(board, task);
  try { board.tick(); } finally { drop(); } // the CLI does not await StopFailure: its session file said idle first
  assert.deepEqual(seen.at(-1), { task, from: "running", to: "review", quiet: true });
  fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: "StopFailure", error: "rate_limit" }) + "\n");
  board.syncStatus(task.id);
  assert.deepEqual(seen.at(-1), { task, from: "review", to: "review", error: "rate_limit" });
  assert.equal(task.interrupted, true);
  const count = seen.length;
  board.syncStatus(task.id);
  assert.equal(seen.length, count); // one warning per StopFailure
});

test("poll mode: a follow-up refused by an API error on a card already in Review warns and marks it Interrupted (F42)", () => {
  const watch = fs.watch;
  fs.watch = () => { throw Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" }); };
  let f;
  try { f = claudeTask(); } finally { fs.watch = watch; }
  const { board, task } = f;
  const seen = [];
  board.onStatus((e) => seen.push([e.from, e.to, e.error]));
  board.update(task, { sessionId: "sess-poll", status: "review" });
  const now = Date.now();
  writeEvents(board, task, [{ t: now - 1, hook_event_name: "UserPromptSubmit", prompt: "again" }, { t: now, hook_event_name: "StopFailure", error: "overloaded" }]); // both within one poll
  board.tick();
  assert.deepEqual([seen.at(-1), task.interrupted], [["review", "review", "overloaded"], true]);
  board.tick();
  assert.equal(seen.length, 2);
});

test("a found card resumed in a board terminal leaves Running when its turn ends without a Stop (F42)", () => {
  const { board, task, worktree } = claudeTask();
  board.update(task, { sessionId: "sess-found", status: "running", adopted: true });
  board.terminals.set(task.id, { exitStatus: undefined, dispose() {}, sendText() {}, show() {} });
  task.updatedAt = ago(10_000);
  onlyEvent(board, task, "PostToolUse", 10_000);
  const drop = sessionFile("sess-found", worktree, "idle");
  interruptedTranscript(board, task);
  try { board.tick(); } finally { drop(); board.terminals.delete(task.id); }
  assert.equal(task.status, "review");
});

test("one session id in two session files: the board keeps the one at work, else the one that changed last, in either listing order (F42)", () => {
  const { board, worktree } = claudeTask();
  const dir = path.join(home, ".claude", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, status, statusUpdatedAt) => fs.writeFileSync(path.join(dir, name), JSON.stringify({ pid: process.pid, sessionId: "sess-twice", cwd: worktree, status, statusUpdatedAt }));
  try {
    for (const [a, b] of [["a.json", "b.json"], ["b.json", "a.json"]]) {
      write(a, "idle", 2); write(b, "busy", 1);
      board.rescan();
      assert.equal(board.external.get("sess-twice").status, "busy");
      write(a, "idle", 1); write(b, "waiting", 2); write(b, "idle", 3);
      board.rescan();
      assert.equal(board.external.get("sess-twice").statusUpdatedAt, 3);
    }
  } finally { for (const n of ["a.json", "b.json"]) fs.rmSync(path.join(dir, n), { force: true }); }
});

test("a session file whose pid now belongs to another process is not a live session: Linux compares procStart (F42)", { skip: process.platform !== "linux" }, () => {
  const { board, worktree } = claudeTask();
  const file = path.join(home, ".claude", "sessions", "reused.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  try {
    for (const [procStart, live] of [[started, true], ["1", false], ["2026-11-04T10:00:00Z", true]]) { // a form not checked counts as live, or a changed CLI would hide every session
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId: "sess-reused", cwd: worktree, status: "idle", procStart }));
      board.rescan();
      assert.equal(board.external.has("sess-reused"), live, procStart);
    }
  } finally { fs.rmSync(file, { force: true }); }
});

test("a session file left by a session the board's Stop ended is ignored once 15 s have passed, so a reused pid does not keep it live (F42)", () => {
  const { board, task, worktree } = claudeTask();
  board.update(task, { sessionId: "sess-stopped", status: "running" });
  board.terminals.set(task.id, { exitStatus: undefined, dispose() {}, sendText() {}, show() {} });
  const drop = sessionFile("sess-stopped", worktree, "busy");
  try {
    board.rescan();
    board.stop(task);
    board.terminals.delete(task.id);
    board.rescan();
    assert.equal(board.external.has("sess-stopped"), true); // still exiting: Resume waits for it (settle)
    for (const [k, at] of board.stoppedSessions) board.stoppedSessions.set(k, at - 16_000);
    board.rescan();
    assert.equal(board.external.has("sess-stopped"), false);
  } finally { drop(); }
});

test("after /clear a Claude card takes the new session id from SessionStart, so its idle scan keeps working (F42)", () => {
  const { board, task } = claudeTask();
  board.update(task, { sessionId: "sess-before", status: "running" });
  const now = Date.now();
  writeEvents(board, task, [{ t: now - 3, hook_event_name: "SessionStart", session_id: "sess-before", source: "startup" }, { t: now - 2, hook_event_name: "UserPromptSubmit", prompt: "go" },
    { t: now - 1, hook_event_name: "Stop" }, { t: now, hook_event_name: "SessionStart", session_id: "sess-after", source: "clear" }]);
  board.syncStatus(task.id);
  assert.equal(task.sessionId, "sess-after");
  assert.equal(task.transcript, undefined); // the stored path named the old conversation
});

for (const provider of ["codex", undefined]) test(`F97: a late Stop from the ended process cannot authorize the replacement ${provider || "Claude"} terminal`, async () => {
  const { board, task } = withTask();
  board.codexModelReady = board.ensureCodexTrust = async () => {};
  board.codexSend = () => "gpt-a";
  const session = "same-thread", ended = Date.now() - 1000, file = board.eventsFile(task.id);
  const event = (hook_event_name, t) => ({ hook_event_name, t, session_id: session });
  board.update(task, { provider, account: undefined, configDir: undefined, cardTerminal: !provider, sessionId: session, orchestrator: { opened: 0, caps: {} }, finishAsked: { at: new Date().toISOString() },
    status: "needs-input", selfFinish: { step: "Not done after 2 automatic rounds.", eventsAtWait: 3 }, autoRounds: 2, mergeRetries: 1 });
  writeEvents(board, task, [event("SessionStart", ended - 2), event("Stop", ended - 1), event("SessionEnd", ended)]);
  let cardEnv;
  board.cardSession = (_task, _file, _args, env) => {
    cardEnv = env;
    return { sent: [], sendText(text) { this.sent.push(text); } };
  };
  const term = await board.resume(task), env = provider ? terminals.at(-1).env : cardEnv;
  const send = () => board.send(task, "Correct the title.", true, "confirm-submit");
  fs.appendFileSync(file, JSON.stringify(event("Stop", ended - 1)) + "\n"); // written late, carries the old timestamp
  assert.throws(send, /waiting on a prompt/);
  const hook = (launchEnv, name, fields = {}) => execFileSync(process.execPath, [path.resolve(__dirname, "../hook/hook.js"), file], {
    env: { ...process.env, ...launchEnv }, input: JSON.stringify({ ...event(name, ended), ...fields }) });
  hook({ ENTOMATICAL_TERMINAL_LAUNCH: "old-launch" }, "Stop"); // a delayed old hook process can also stamp a fresh time
  assert.throws(send, /waiting on a prompt/);
  assert.deepEqual([term.sent, task.autoRounds, task.mergeRetries], [[], 2, 1]);
  hook(env, "SessionStart");
  hook(env, "Stop");
  let oldTime = ended - 100;
  const legacy = (name, actor = "child", session_id = session) => fs.appendFileSync(file,
    JSON.stringify({ ...event(name, ++oldTime), agent_id: actor, session_id }) + "\n");
  legacy("PermissionRequest");
  legacy("SubagentStop", "other-child");
  legacy("SubagentStop", "child", "foreign");
  assert.throws(send, /waiting on a prompt/);
  legacy("SubagentStop");
  assert.deepEqual(board.approvalWaits(task).children, [], "the old child's matching completion resolves its old request");
  assert.equal(board.terminalSendBlocked(task, term, "confirm-submit"), false);
  legacy("PermissionRequest");
  hook(env, "SubagentStop", { agent_id: "child" });
  assert.throws(send, /waiting on a prompt/, "a current completion cannot answer an untagged request");
  hook(env, "PermissionRequest", { agent_id: "child" });
  legacy("SubagentStop"); // the same actor also has an outstanding request from the replacement
  hook({ ENTOMATICAL_TERMINAL_LAUNCH: "old-launch" }, "SubagentStop", { agent_id: "child" });
  hook(env, "Stop");
  assert.throws(send, /waiting on a prompt/);
  hook(env, "SubagentStop", { agent_id: "child" });
  const current = board.terminal.bind(board), other = { sent: [], sendText(text) { this.sent.push(text); } };
  board.terminal = () => other; // the old process's valid Stop cannot authorize another terminal with the same card identity
  assert.throws(send, /cannot identify this terminal.*Resume/);
  assert.deepEqual(other.sent, []);
  other.creationOptions = { env }; // VS Code can restore a handle with the original creation environment
  assert.equal(board.terminalSendBlocked(task, other, "confirm-submit"), false);
  board.terminal = current;
  await send();
  // On Windows a Codex follow-up is two writes: the paste, then its Enter once Codex's paste burst is over (typeInto).
  const sent = provider === "codex" && process.platform === "win32" ? ["\u001b[200~Correct the title.\u001b[201~", "\r"] : ["\u001b[200~Correct the title.\u001b[201~\r"];
  assert.deepEqual(term.sent, sent);

  // A saved resume from before launch IDs cannot tie a same-session Stop to its process.
  delete task.finishAsked.resume.launchId;
  assert.throws(send, /Resume/);
  assert.deepEqual(term.sent, sent, "a refused send writes nothing");
});

test("an untitled card takes the first line with words once markup is gone: an improved prompt is not titled <task> (F53)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-title-"));
  made.push(repo);
  const board = open(repo);
  assert.equal(board.add("", "<task>\n  <goal>Fix the flaky tests</goal>\n</task>").title, "Fix the flaky tests");
  assert.equal(board.add("", "\n\nPlain first line\nsecond").title, "Plain first line");
  assert.equal(board.add("", "<task></task>").title, "Untitled");
  assert.equal(board.add("", "Check x < 10 and y > 5").title, "Check x < 10 and y > 5"); // only the compiler's tags go
  assert.equal(board.add("", "Convert List<String> to an array").title, "Convert List<String> to an array");
  assert.equal(board.add("", '<source_content>\n  <document label="log">\nERROR at line 1\n  </document>\n</source_content>\n<task>\n  <goal>Fix a &lt; b</goal>\n</task>').title, "Fix a < b");
});

test("finish self: the master's checks run at its Stop and finishReady fires only after they pass; no Needs input, no dialog", () => {
  const { board, task: m } = withTask();
  const child = board.add("child", "part");
  board.update(child, { openedBy: m.id, status: "done" });
  // What `board.js finish self` leaves mid-turn: the request and delivery ready, the card still running.
  board.update(m, { status: "running", sessionId: "sess-fin", headless: true, orchestrator: { caps: {}, opened: 1 }, completion: { commands: ["node -e 0"], doneWhen: "x" } });
  board.update(m, { finishAsked: { at: new Date().toISOString() }, deliveryReady: true });
  const started = [], ready = [], warned = warnings.length;
  board.checks.start = (t) => { if (!t.deliveryReady) return; started.push(t.id); board.recordChecks(t, { status: "running", run: "r" }); };
  board.onRun((e) => { if (e.kind === "finishReady") ready.push(e.master.id); });
  board.update(m, { status: "review" }); // its Stop
  assert.deepEqual([started, ready, m.status], [[m.id], [], "review"], "the checks start once; nothing fires before they pass");
  board.recordChecks(m, { status: "complete", run: "r" });
  assert.deepEqual([ready, m.status, m.reported], [[m.id], "review", undefined], "finishReady, not the run's finished notice");
  assert.equal(warnings.length, warned, "no dialog");
  // The next turn's checks fail: the card waits in Needs input with the existing Fix it, and nothing fires.
  board.update(m, { status: "running" });
  board.update(m, { status: "review" });
  assert.deepEqual(started, [m.id, m.id], "deliveryReady is set again at the Stop, so the checks run");
  board.recordChecks(m, { status: "error", run: "r", error: "Acceptance check 1 failed" });
  assert.deepEqual([ready, m.status], [[m.id], "needs-input"]);
  // With no commands, finishReady fires at the Stop itself.
  board.update(m, { status: "running", completion: { commands: [], doneWhen: "x" } });
  board.update(m, { status: "review" });
  assert.deepEqual([ready, started.length], [[m.id, m.id], 2]);
});

test("Finish refuses while a subagent still works, but not for one silent for 15 minutes that never sent SubagentStop", async () => {
  const { board, task } = withTask();
  board.update(task, { status: "review", sessionId: "sess-fin" });
  board.terminals.set(task.id, { sendText() {}, dispose() {} });
  const now = Date.now();
  writeEvents(board, task, [{ t: now - 2000, hook_event_name: "SubagentStart", agent_id: "busy" }, { t: now - 1000, hook_event_name: "Stop" }]);
  // Refused, nothing stopped (7 November 2026). The board shows a working subagent as its session running, so either line.
  await assert.rejects(board.complete(task, async () => true), /is still working \((its session is working|a subagent is still running)\)/);
  assert.ok(board.terminals.has(task.id));
  writeEvents(board, task, [{ t: now - 16 * 60_000, hook_event_name: "SubagentStart", agent_id: "gone" }, { t: now - 1000, hook_event_name: "Stop" }]);
  let asked = false; // the crashed one is not work under way: the dialog opens
  assert.equal(await board.complete(task, async () => { asked = true; return false; }), false);
  assert.equal(asked, true);
  board.terminals.delete(task.id);
});

test("a subagent ended by its own Stop or StopFailure, or replaced by a resumed session, does not hold the parent's Stop (F42)", () => {
  const { board, task } = claudeTask();
  const now = Date.now();
  // Card 817bb4: SubagentStart, the agent's own StopFailure 0.4 s later, the parent's Stop 3.6 s after, never a SubagentStop.
  board.update(task, { sessionId: "sess-own", status: "running" });
  writeEvents(board, task, [{ t: now - 5000, hook_event_name: "UserPromptSubmit", prompt: "go" }, { t: now - 4000, hook_event_name: "SubagentStart", agent_id: "a1" },
    { t: now - 3600, hook_event_name: "StopFailure", agent_id: "a1", error: "rate_limit" }, { t: now, hook_event_name: "Stop" }]);
  board.syncStatus(task.id);
  assert.equal(task.status, "review");
  // An agent orphaned by Stop or Esc, then Resume: the resumed session's first Stop is the end of its turn.
  board.update(task, { status: "running" });
  writeEvents(board, task, [{ t: now - 9000, hook_event_name: "SubagentStart", agent_id: "a2" }, { t: now - 3000, hook_event_name: "SessionStart", source: "resume" },
    { t: now - 2000, hook_event_name: "UserPromptSubmit", prompt: "again" }, { t: now, hook_event_name: "Stop" }]);
  board.syncStatus(task.id);
  assert.equal(task.status, "review");
});

test("a subagent that ended after the parent's Stop holds the Review for the CLI's re-prompt, then lets it go (F42)", () => {
  const { board, task } = claudeTask();
  board.update(task, { sessionId: "sess-just", status: "running" });
  const seen = [];
  board.onStatus((e) => seen.push(e.to));
  const now = Date.now();
  const events = [{ t: now - 9000, hook_event_name: "UserPromptSubmit", prompt: "go" }, { t: now - 8000, hook_event_name: "SubagentStart", agent_id: "a3" },
    { t: now - 3000, hook_event_name: "Stop" }, { t: now - 1000, hook_event_name: "SubagentStop", agent_id: "a3" }];
  writeEvents(board, task, events);
  board.syncStatus(task.id);
  assert.equal(task.status, "running"); // the re-prompt usually follows within a second
  events[3].t = now - 20_000; events[2].t = now - 21_000; // no re-prompt came
  writeEvents(board, task, events);
  board.syncStatus(task.id, true);
  assert.equal(task.status, "review");
  assert.deepEqual(seen, ["review"]); // one Review, one toast
});

test("worker session starts do not replace the parent, and active workers repair a stale Interrupted card", () => {
  const { board, task, worktree } = claudeTask();
  board.update(task, { sessionId: "parent", status: "review", interrupted: true }, undefined, true);
  const now = Date.now();
  writeEvents(board, task, [
    { t: now - 30_000, hook_event_name: "SessionStart", session_id: "parent", source: "startup" },
    { t: now - 25_000, hook_event_name: "UserPromptSubmit", prompt: "work" },
    { t: now - 20_000, hook_event_name: "SubagentStart", agent_id: "worker" },
    { t: now - 15_000, hook_event_name: "SessionStart", agent_id: "worker", session_id: "child", source: "startup" },
    { t: now - 10_000, hook_event_name: "Interrupt" },
  ]);
  const drop = sessionFile("parent", worktree, "idle");
  try {
    board.syncStatus(task.id);
    assert.equal(board.busySubagents(task), true);
    assert.deepEqual([task.status, task.interrupted], ["running", undefined]);
    board.tick();
    assert.equal(task.status, "running", "idle parent cannot end active workers");
    fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ t: now, hook_event_name: "SubagentStop", agent_id: "worker" }) + "\n");
    board.syncStatus(task.id, true);
    assert.deepEqual([task.status, task.interrupted], ["review", true], "the real parent interruption remains once its worker ends");
    task.cancelled = true;
    board.subagentsOf = () => [{ id: "other-worker", done: false, updated: Date.now() }];
    board.tick();
    assert.equal(task.status, "review", "worker activity cannot revive a cancelled card");
  } finally { drop(); }
});

test("quiet includes transcript and worker activity, and unchanged running editor turns still refresh the board", () => {
  const { board, task, repo } = withTask();
  const now = Date.now(), old = now - 25 * 60_000;
  const transcript = path.join(repo, "activity.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) + "\n");
  fs.utimesSync(transcript, old / 1000, old / 1000);
  board.update(task, { sessionId: "editor", provider: "codex", codexEditor: true, transcript, status: "running" });
  onlyEvent(board, task, "UserPromptSubmit", 25 * 60_000);
  let workers = [];
  board.subagentsOf = () => workers;
  assert.ok(board.lastEventAt(task) <= old + 1000);
  workers = [{ id: "child", done: false, updated: now }];
  assert.equal(board.lastEventAt(task), now);
  assert.equal(board.statusOf(task).quiet, 0);
  workers = [];
  board.tick();
  let changed = 0;
  board.onChange(() => changed++);
  fs.appendFileSync(transcript, JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec", call_id: "call" } }) + "\n");
  board.tick();
  assert.ok(changed > 0, "fresh activity is posted even without a column change or hooks");
  assert.ok(board.lastEventAt(task) >= now - 1000);
});

test("a completed or aborted Codex parent stays active while its worker runs, then settles to its actual outcome", () => {
  const { board, task, repo } = withTask();
  const transcript = path.join(repo, "workers.jsonl");
  const record = (payload) => JSON.stringify({ type: "event_msg", payload }) + "\n";
  fs.writeFileSync(transcript, record({ type: "task_started", turn_id: "turn" }) + record({ type: "turn_aborted", turn_id: "turn" }));
  board.update(task, { sessionId: "editor", provider: "codex", codexEditor: true, transcript, status: "review", interrupted: true }, undefined, true);
  let done = false;
  board.subagentsOf = () => [{ id: "child", done, updated: Date.now() }];
  board.tick();
  assert.deepEqual([task.status, task.interrupted], ["running", undefined]);
  done = true;
  board.tick();
  assert.deepEqual([task.status, task.interrupted], ["review", true]);
  fs.appendFileSync(transcript, record({ type: "task_started", turn_id: "new" }));
  fs.appendFileSync(transcript, record({ type: "turn_aborted", turn_id: "turn" }));
  board.tick();
  assert.deepEqual([task.status, task.interrupted], ["running", undefined], "late old-turn abort is ignored");
  fs.appendFileSync(transcript, record({ type: "task_complete", turn_id: "new" }));
  board.tick();
  assert.deepEqual([task.status, task.interrupted], ["review", undefined]);
});

test("Resume focuses a live idle terminal, submits once, and clears Interrupted on acknowledgement", async () => {
  const { board, task } = claudeTask();
  board.update(task, { sessionId: "session", status: "review", interrupted: true }, undefined, true);
  const text = [], focus = [], chips = [];
  board.onChange(() => { if (task.status === "running") chips.push(board.statusOf(task).chips); });
  board.terminals.set(task.id, { show: (preserve) => focus.push(preserve), sendText: (value) => {
    text.push(value);
    fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: "UserPromptSubmit", prompt: "Resume." }) + "\n");
  } });
  await board.continueTask(task);
  assert.deepEqual(focus, [false]);
  assert.deepEqual(text, ["\u001b[200~Resume.\u001b[201~\r"]);
  assert.deepEqual([task.status, task.interrupted], ["running", undefined]);
  assert.ok(chips.length && chips.every((value) => !value.includes("interrupted")), "the first published Running state is already consistent");
});

test("Resume supplies a cold terminal's continuation as the startup prompt", async () => {
  const { board, task } = claudeTask();
  board.update(task, { sessionId: "session", status: "review", interrupted: true }, undefined, true);
  interruptedTranscript(board, task);
  const term = await board.resume(task, "Resume.");
  assert.ok(term);
  assert.deepEqual(terminals.at(-1).shellArgs.slice(-2), ["--", "Resume."]);
});

test("Resume focuses Codex's existing editor and queues its continuation without creating a terminal", async () => {
  const codex = require("../out/codex.js"), original = codex.queueCodexMessage;
  const { board, task, repo } = withTask();
  const transcript = path.join(repo, "resume-editor.jsonl");
  const record = (payload) => JSON.stringify({ type: "event_msg", payload }) + "\n";
  fs.writeFileSync(transcript, record({ type: "task_started", turn_id: "old" }) + record({ type: "turn_aborted", turn_id: "old" }));
  board.update(task, { provider: "codex", codexEditor: true, codexPanelBridge: true, sessionId: "editor-thread", transcript, status: "review", interrupted: true }, undefined, true);
  const queued = [], before = terminals.length;
  codex.queueCodexMessage = async (...args) => {
    assert.deepEqual(commands.at(-1).slice(2), ["chatgpt.conversationEditor", { preview: false, preserveFocus: false }]);
    queued.push(args);
    fs.appendFileSync(transcript, record({ type: "task_started", turn_id: "new" }));
  };
  try {
    await board.continueTask(task);
    assert.deepEqual(queued, [["editor-thread", "Resume.", task.worktree]]);
    assert.equal(terminals.length, before);
    assert.deepEqual([task.status, task.interrupted], ["running", undefined]);
  } finally { codex.queueCodexMessage = original; }
});

test("a new real Stop clears an interrupted card even when the new turn finished before the board saw Running", () => {
  const { board, task } = claudeTask();
  board.update(task, { sessionId: "session", status: "review", interrupted: true }, undefined, true);
  onlyEvent(board, task, "Stop", 0);
  board.syncStatus(task.id);
  assert.equal(task.interrupted, undefined);
});

test("a StopFailure older than ten minutes on a card already in Review does not mark it Interrupted (F42)", () => {
  const { board, task } = claudeTask();
  board.update(task, { sessionId: "sess-old", status: "review" });
  task.updatedAt = new Date(Date.now() - 3600_000).toISOString();
  writeEvents(board, task, [{ t: Date.now() - 1800_000, hook_event_name: "StopFailure", error: "rate_limit" }]);
  board.syncStatus(task.id);
  assert.notEqual(task.interrupted, true);
});

test("a board made without starting fires its first tick's replayed StopFailure to listeners wired before begin() (F42)", () => {
  const { board, task, repo } = claudeTask();
  board.update(task, { sessionId: "sess-reload", status: "review" });
  task.updatedAt = new Date(Date.now() - 60_000).toISOString();
  board.save();
  writeEvents(board, task, [{ t: Date.now() - 1000, hook_event_name: "StopFailure", error: "overloaded" }]);
  board.dispose();
  fs.writeFileSync(path.join(repo, ".entomatical", "owner.json"), JSON.stringify({ pid: 999999999, at: Date.now() - 600_000 })); // a dead owner: the reload
  const again = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  boards.push(again);
  const seen = [];
  again.onStatus((e) => seen.push(e.error));
  again.begin();
  assert.deepEqual(seen, ["overloaded"]);
});

test("a takeover whose tasks.json cannot be read just then gives the claim back, so no save writes a stale list over the old owner's (F45)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-giveback-"));
  made.push(repo);
  const dir = path.join(repo, ".entomatical");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid: 999999999, at: Date.now() - 600_000 })); // the owner window closed
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  boards.push(board);
  fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([{ id: "t2", title: "the old owner's last card", prompt: "p", status: "queued", createdAt: "", updatedAt: "" }]));
  const read = fs.readFileSync;
  fs.readFileSync = function (f, ...rest) { if (String(f).endsWith("tasks.json")) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); return read.call(this, f, ...rest); };
  try { board.begin(); } finally { fs.readFileSync = read; }
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8")).pid, 0); // given back
  assert.throws(() => board.add("new", "p"), /Another VS Code window/); // a save now refuses instead of writing the stale list
  board.tick(); // readable again: the takeover finishes with the old owner's card
  assert.ok(board.tasks.some((t) => t.id === "t2"));
});

test("sendPrompt types into the board's live terminal; a headless orchestrator gets it as a headless follow-up; a panel card returns paste", async () => {
  const { board, task } = withTask();
  board.update(task, { status: "review", sessionId: "s-sp", panel: true });
  assert.equal(await board.sendPrompt(task, "P1"), "paste");
  const typed = [];
  board.terminals.set(task.id, { sendText: (t) => typed.push(t), dispose() {} });
  assert.equal(await board.sendPrompt(task, "P2"), "sent");
  assert.ok(typed.join("").includes("P2"));
  board.terminals.delete(task.id);
  board.update(task, { headless: true, panel: false });
  const got = [];
  board.followUpHeadless = async (t, text) => { got.push([t.id, text]); return undefined; };
  assert.equal(await board.sendPrompt(task, "P3"), "sent");
  assert.deepEqual(got, [[task.id, "P3"]]);
  board.update(task, { takenOver: true });
  assert.equal(await board.sendPrompt(task, "P4"), "paste");
  assert.equal(got.length, 1, "a taken-over card is not sent a headless follow-up");
});

test("F69: an orchestrator added on a Claude or Codex account is not headless, runs in its card terminal and has its notice typed there", async () => {
  const { board } = withTask();
  board.accountList = () => [{ name: "main", configDir: "" }, { name: "Codex · someone", configDir: "", provider: "codex" }];
  const step = () => ({ permission: "bypass", orchestrator: { caps: board.capsOf(), opened: 0 }, planFirst: true });
  const orch = board.add("Orchestrate", "brief and task", "main", undefined, undefined, undefined, undefined, step());
  assert.deepEqual([orch.headless, orch.planFirst, orch.cardTerminal, orch.permission], [undefined, undefined, true, "bypass"]);
  assert.deepEqual(board.routeOf(orch), { provider: "claude", mode: "in-card" });
  const codex = board.add("Orchestrate", "brief and task", "Codex · someone", undefined, undefined, undefined, undefined, step());
  assert.deepEqual([codex.provider, codex.headless, codex.cardTerminal, board.routeOf(codex).mode], ["codex", undefined, true, "in-card"]);
  // Unchanged: an orchestrator a run opened (--may-open) is headless and has no card terminal; a card saved as headless stays so.
  const sub = board.add("Coordinate", "p", "main", undefined, undefined, undefined, undefined, { ...step(), headless: true, openedBy: orch.id, watchedBy: orch.id, cardTerminal: true });
  assert.deepEqual([sub.headless, sub.cardTerminal], [true, undefined]);
  const old = board.add("Orchestrate", "p", "main", undefined, undefined, undefined, undefined, { ...step(), headless: true });
  assert.deepEqual([old.headless, old.cardTerminal], [true, undefined]);
  // With no terminal the notice waits; with one it is typed there, never sent as a headless follow-up.
  board.followUpHeadless = async () => { throw new Error("a visible orchestrator gets no headless follow-up"); };
  board.update(orch, { status: "review", sessionId: "s-orch" });
  board.queueNotice(orch.id, "plan", "Child settled: abc123 is in Review.");
  await board.deliverNotices(orch.id);
  const typed = [];
  board.terminals.set(orch.id, { sendText: (t) => typed.push(t), dispose() {} });
  assert.deepEqual(typed, [], "nothing can be typed before the terminal is there");
  await board.deliverNotices(orch.id);
  assert.ok(typed.join("").includes("Child settled: abc123 is in Review."), typed.join(""));
});

test("deleting a card removes its reviews folder and keeps its reports", () => {
  const { board, task } = withTask();
  const rev = path.join(board.dir, "reviews", task.id), rep = path.join(board.dir, "reports", `${task.id}.md`);
  fs.mkdirSync(rev, { recursive: true });
  fs.mkdirSync(path.dirname(rep), { recursive: true });
  fs.writeFileSync(path.join(rev, "x.md"), "x");
  fs.writeFileSync(rep, "r");
  board.remove(task);
  assert.equal(fs.existsSync(rev), false);
  assert.equal(fs.existsSync(rep), true);
});

test("deleting a card drops its inbox and wake guard from notifications.json and keeps the other cards'", () => {
  const { board, task } = withTask();
  const file = path.join(board.dir, "notifications.json");
  fs.writeFileSync(file, JSON.stringify({ pending: { [task.id]: { a: "for the deleted card" }, other: { b: "kept" } }, notified: { [task.id]: "k1", other: "k2" } }));
  board.loadNotifications(true);
  board.remove(task);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { pending: { other: { b: "kept" } }, notified: { other: "k2" } });
});

// Deliver every N turns (the user, 15 November 2026): the board calls deliver() at a card's Nth turn end and when it reaches Review otherwise.
/** Until every queued delivery has run. */
const delivered = async (board) => { let p; do { p = board.deliveries; await p; } while (p !== board.deliveries); };
/** A Claude card on the fixture's worktree; turn(file) writes file there and plays one turn through its hook events. */
function deliveryCard() {
  const f = claudeTask();
  f.board.update(f.task, { sessionId: "s-deliver", status: "running" });
  let t = Date.now();
  const events = [{ t: t++, hook_event_name: "SessionStart" }];
  const play = (...more) => { events.push(...more.map((e) => ({ t: t++, ...e }))); writeEvents(f.board, f.task, events); f.board.syncStatus(f.task.id); };
  const turn = async (file, during = []) => {
    fs.writeFileSync(path.join(f.worktree, file), `${file}\n`);
    play({ hook_event_name: "UserPromptSubmit", prompt: "go" });
    assert.equal(f.task.status, "running");
    for (const e of during) play(e);
    play({ hook_event_name: "Stop" });
    assert.equal(f.task.status, "review");
    await delivered(f.board);
  };
  const inMain = (file) => fs.existsSync(path.join(f.repo, file));
  return { ...f, turn, inMain };
}

test("deliver: the third turn's Stop delivers, the first two and a sub-agent's Stop do not; the count restarts", async () => {
  const { board, task, turn, inMain } = deliveryCard();
  await turn("one.txt", [{ hook_event_name: "Stop", agent_id: "a1" }]);
  assert.equal(task.status, "review");
  assert.equal(task.deliveryTurns, 1); // the sub-agent's Stop was not a turn
  await turn("two.txt");
  assert.equal(task.deliveryTurns, 2);
  assert.equal(inMain("one.txt"), false);
  assert.equal(task.delivery, undefined);
  await turn("three.txt");
  assert.equal(task.deliveryTurns, undefined);
  for (const f of ["one.txt", "two.txt", "three.txt"]) assert.equal(inMain(f), true, f);
  assert.equal(task.delivery.sha, sh(board.repo, "rev-parse", "--short", "HEAD"));
  assert.equal(task.delivery.files, 4); // a.txt from the fixture's commit, and the three new files
  assert.match(fs.readFileSync(board.eventsFile(task.id), "utf8"), /"hook_event_name":"Delivery","delivered"/);
  assert.equal(JSON.parse(fs.readFileSync(board.file, "utf8")).find((t) => t.id === task.id).delivery.sha, task.delivery.sha); // saved with the card
  await turn("four.txt");
  assert.equal(task.deliveryTurns, 1);
  assert.equal(inMain("four.txt"), false);
});

test("deliver: a queued delivery rechecks whether an interrupted Finish is waiting for Review", async () => {
  const { board, task, repo } = deliveryCard();
  const before = sh(repo, "rev-parse", "main");
  board.update(task, { status: "review" }, undefined, true);
  assert.ok(board.deliveryQueued.has(task.id));
  board.update(task, { finishAsked: { at: task.updatedAt, reviewInterrupted: true } });
  await delivered(board);
  assert.equal(sh(repo, "rev-parse", "main"), before);
  assert.equal(task.delivery, undefined);
  assert.ok(!board.events(task.id).some(e => e.hook_event_name === "Delivery"));
});

test("deliver: reaching Review another way (a quiet end) delivers at once; the setting at 0 never delivers", async () => {
  const { board, task, worktree, inMain } = deliveryCard();
  fs.writeFileSync(path.join(worktree, "b.txt"), "b\n");
  board.update(task, { status: "review" }, undefined, true); // Esc, or the session gone
  await delivered(board);
  assert.equal(inMain("b.txt"), true);
  assert.equal(task.deliveryTurns, undefined);

  const off = deliveryCard();
  off.board.deliverEveryTurns = () => 0;
  for (const f of ["one.txt", "two.txt", "three.txt"]) await off.turn(f);
  off.board.update(off.task, { status: "running" });
  off.board.update(off.task, { status: "review" }, undefined, true);
  await delivered(off.board);
  assert.equal(off.inMain("one.txt"), false);
  assert.equal(off.task.delivery, undefined);
  assert.equal(off.task.deliveryTurns, undefined);
  assert.equal(off.task.turns, 3); // F108: counted whatever the setting
});

test("deliver: a refusal is recorded on the card and in its events, and the next trigger tries again", async () => {
  const { board, task, repo, turn, inMain } = deliveryCard();
  board.deliverEveryTurns = () => 1;
  fs.writeFileSync(path.join(repo, "a.txt"), "edited in the main folder\n"); // the card changed a.txt too
  await turn("one.txt");
  assert.match(task.delivery.refused, /uncommitted changes to files this card changed/);
  assert.equal(task.delivery.sha, undefined);
  assert.equal(task.deliveryTurns, undefined);
  assert.equal(task.status, "review"); // nothing was asked of the session
  assert.match(fs.readFileSync(board.eventsFile(task.id), "utf8"), /"hook_event_name":"Delivery","refused"/);
  assert.equal(inMain("one.txt"), false);
  sh(repo, "checkout", "--", "a.txt");
  await turn("two.txt");
  assert.equal(task.delivery.refused, undefined);
  assert.equal(inMain("one.txt") && inMain("two.txt"), true);
});

test("deliver: a plan step (openedBy) and a card on no task/ branch are left alone", async () => {
  const step = deliveryCard();
  step.board.deliverEveryTurns = () => 1;
  step.board.update(step.task, { openedBy: "plan1" });
  await step.turn("one.txt");
  step.board.update(step.task, { status: "running" });
  step.board.update(step.task, { status: "review" }, undefined, true);
  await delivered(step.board);
  assert.equal(step.inMain("one.txt"), false);
  assert.equal(step.task.delivery, undefined);
  assert.equal(step.task.deliveryTurns, undefined);
  assert.equal(step.task.turns, 1); // F108: counted though the card is not delivered

  const other = deliveryCard();
  other.board.deliverEveryTurns = () => 1;
  sh(other.worktree, "checkout", "-q", "-b", "feature");
  other.board.update(other.task, { branch: "feature" });
  await other.turn("one.txt");
  assert.equal(other.inMain("one.txt"), false);
});

test("notInMain: commits the main checkout's branch lacks, plus 1 for uncommitted or untracked files; none on a plan step or with git failing", async () => {
  const { board, task, repo, worktree } = deliveryCard();
  await board.refreshNotInMain();
  assert.equal(board.notInMainOf(task), 1); // the fixture's "task change" commit
  fs.writeFileSync(path.join(worktree, "new.txt"), "new\n"); // untracked
  await board.refreshNotInMain();
  assert.equal(board.notInMainOf(task), 2);
  sh(worktree, "add", "new.txt"); sh(worktree, "commit", "-qm", "one");
  fs.writeFileSync(path.join(worktree, "two.txt"), "2\n"); sh(worktree, "add", "two.txt"); sh(worktree, "commit", "-qm", "two");
  await board.refreshNotInMain();
  assert.equal(board.notInMainOf(task), 3);
  fs.appendFileSync(path.join(worktree, "a.txt"), "changed\n"); // uncommitted
  await board.refreshNotInMain();
  assert.equal(board.notInMainOf(task), 4);
  sh(worktree, "checkout", "--", "a.txt");
  sh(repo, "merge", "-q", "--ff-only", task.branch); // the main checkout has it all now
  await board.refreshNotInMain();
  assert.equal(board.notInMainOf(task), 0);
  board.update(task, { openedBy: "plan1" }); // its opener is not on the board: counted as a plan step, so nothing
  await board.refreshNotInMain();
  assert.equal(board.notInMainOf(task), undefined);
  // F108: an orchestrator's card is counted though never delivered by itself; a plan's step is neither.
  const orch = board.add("orchestrator", "o"), plan = board.add("plan", "run");
  board.update(orch, { orchestrator: { caps: {}, opened: 1 } });
  board.update(plan, { planRun: { name: "p", file: "workflows/p.plan.json", review: "checks" } });
  board.update(task, { openedBy: orch.id });
  assert.deepEqual([board.countsWork(task), board.deliverable(task)], [true, false]);
  fs.writeFileSync(path.join(worktree, "sub.txt"), "sub\n");
  await board.refreshNotInMain();
  assert.equal(board.notInMainOf(task), 1, "the orchestrator's card shows its untracked file");
  fs.rmSync(path.join(worktree, "sub.txt"));
  board.update(task, { openedBy: plan.id });
  assert.deepEqual([board.countsWork(task), board.deliverable(task)], [false, false]);
  for (const c of [orch, plan]) board.update(c, { status: "done" });
  board.update(task, { openedBy: undefined });
  assert.deepEqual([board.countsWork(task), board.deliverable(task)], [true, true]);
  sh(repo, "checkout", "-q", "--detach"); // the main checkout on no branch: no number
  await board.refreshNotInMain();
  assert.equal(board.notInMainOf(task), undefined);
});

/**
 * Counts deliver() calls by the checkout they write (checkoutId), and can hold one checkout's deliveries inside deliver().
 * out/deliver.js's `deliver` is one function for the whole process, and every board an earlier test of this file opened is still
 * alive and delivers on its own timer (a card left Running with no session goes to Review quietly, which delivers at once).
 * Measured on 19 November 2026, Windows: one run of this file made 37 deliver() calls into 32 checkouts, up to 13 at once, and
 * never two at once into one checkout; 7 of them started during a later test than the one that made their checkout (the notInMain
 * test's board, two tests on). So a count over every call measures the file, not a board's queue: that was M-05's "2 versus 1"
 * (and "3 !== 1") in the full suite, where the machine is slow enough for those deliveries to still be running.
 */
function deliveryMeter() {
  const mod = require("../out/deliver.js"), real = mod.deliver;
  const checkouts = new Map(), holds = new Map();
  let active = 0, most = 0;
  const of = (repo) => {
    const id = mod.checkoutId(repo);
    if (!checkouts.has(id)) checkouts.set(id, { id, active: 0, most: 0, entered: [] });
    return checkouts.get(id);
  };
  const counted = async (...args) => {
    const m = of(args[0]), hold = holds.get(m.id);
    m.most = Math.max(m.most, ++m.active);
    most = Math.max(most, ++active);
    m.entered.push(args[1]); // the worktree: which card's delivery this is
    try {
      if (hold) { hold.inside(); await hold.open; }
      return await real(...args);
    } finally { m.active--; active--; }
  };
  mod.deliver = counted;
  return {
    /** One checkout's count: `entered`, the worktrees delivered into it in order; `active`, now; `most`, at once. */
    of,
    /** Every checkout's deliveries together: how many now, and the most at once. This is all the test counted before. */
    all: () => ({ active, most }),
    /** That checkout's deliveries wait inside deliver() until release(); `entered` settles once the first one is there. */
    hold(repo) {
      let inside, release;
      const entered = new Promise((r) => { inside = r; }), open = new Promise((r) => { release = r; });
      holds.set(mod.checkoutId(repo), { inside, open, release });
      return { entered, release };
    },
    restore() { for (const h of holds.values()) h.release(); if (mod.deliver === counted) mod.deliver = real; },
  };
}
/** The card's Delivery lines in its events file: what each delivery left, and the checkout it wrote. */
const deliveryEvents = (board, task) => fs.readFileSync(board.eventsFile(task.id), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.hook_event_name === "Delivery");

test("deliver: two cards whose turns end together are delivered one after the other", { timeout: 300_000 }, async () => {
  const { checkoutId } = require("../out/deliver.js");
  const { board, task, repo, worktree } = deliveryCard();
  board.deliverEveryTurns = () => 1;
  const wt2 = path.join(repo, ".entomatical", "wt", "t2");
  sh(repo, "worktree", "add", "-q", "-b", "task/t2", wt2, "HEAD");
  const second = board.add("t2", "do it too");
  board.update(second, { worktree: wt2, branch: "task/t2", status: "running" });
  board.update(task, { status: "running" });
  fs.writeFileSync(path.join(worktree, "first.txt"), "1\n");
  fs.writeFileSync(path.join(wt2, "second.txt"), "2\n");
  // Another board on another checkout, as every earlier test of this file leaves one behind: its delivery runs at the same time
  // as this board's, and must count for its own checkout only.
  const other = deliveryCard();
  other.board.deliverEveryTurns = () => 1;
  fs.writeFileSync(path.join(other.worktree, "other.txt"), "3\n");
  const full = (dir, rev) => sh(dir, "rev-parse", rev);
  const start = full(repo, "HEAD");
  const meter = deliveryMeter(), here = meter.hold(repo), there = meter.hold(other.repo);
  try {
    board.update(task, { status: "review" }); // the first card's turn ends: its delivery starts, and is held inside deliver()
    await here.entered;
    assert.deepEqual([board.deliveryRunning.id, board.deliveryRunning.target], [task.id, checkoutId(repo)]);
    board.update(second, { status: "review" }); // the second card reaches Review while the first is being delivered
    other.board.update(other.task, { status: "review" });
    await there.entered; // the other board's delivery is under way too, into its own checkout
    await new Promise((r) => setImmediate(r)); // a second delivery that nothing held back would be inside deliver() by now
    assert.deepEqual(meter.of(repo).entered, [worktree], "the second card waits for the first card's delivery");
    assert.equal(board.deliveryQueued.has(second.id), true);
    assert.deepEqual([meter.of(repo).active, meter.of(other.repo).active], [1, 1]);
    assert.ok(meter.all().active >= 2, "two deliveries are under way at once: one into each checkout");
    assert.equal(full(repo, "HEAD"), start); // nothing has reached the main folder while its delivery is held
    here.release();
    there.release();
    await delivered(board);
    await delivered(other.board);
  } finally { meter.restore(); }

  // Peak concurrency, by target: one into each checkout, exactly as many deliveries as cards, in the order their turns ended.
  const mine = meter.of(repo), theirs = meter.of(other.repo);
  assert.notEqual(mine.id, theirs.id);
  assert.deepEqual([mine.entered, mine.most], [[worktree, wt2], 1]);
  assert.deepEqual([theirs.entered, theirs.most], [[other.worktree], 1]);
  assert.ok(meter.all().most >= 2, "over every checkout together more than one delivery ran at once: the count the test made before");

  // Files: each accepted change is in the main folder once, added by one commit of main, and neither board's work is in the other's.
  const added = (dir, file) => sh(dir, "log", "--diff-filter=A", "--format=%H", "main", "--", file).split("\n").filter(Boolean);
  const files = (dir, rev) => sh(dir, "ls-tree", "-r", "--name-only", rev).split("\n");
  assert.deepEqual([fs.readFileSync(path.join(repo, "first.txt"), "utf8"), fs.readFileSync(path.join(repo, "second.txt"), "utf8")], ["1\n", "2\n"]);
  assert.deepEqual([added(repo, "first.txt").length, added(repo, "second.txt").length, added(other.repo, "other.txt").length], [1, 1, 1]);
  assert.deepEqual(["first.txt", "second.txt", "other.txt"].map((f) => fs.existsSync(path.join(other.repo, f))), [false, false, true]);
  assert.equal(fs.existsSync(path.join(repo, "other.txt")), false);
  assert.equal(sh(repo, "status", "--porcelain"), ""); // the main folder is clean: nothing half delivered

  // SHAs: each receipt names the commit its own delivery left the main folder at. The first is the first card's branch, with
  // first.txt and without second.txt; the second is on top of it, holds both, and is where the main folder is now.
  const sha1 = full(repo, task.delivery.sha), sha2 = full(repo, second.delivery.sha);
  assert.deepEqual([sha1, sha2], [full(repo, "task/t1"), full(repo, "HEAD")]);
  assert.equal(sha2, full(repo, "task/t2"));
  assert.deepEqual(["first.txt", "second.txt"].map((f) => files(repo, sha1).includes(f)), [true, false]);
  assert.deepEqual(["first.txt", "second.txt"].map((f) => files(repo, sha2).includes(f)), [true, true]);
  assert.deepEqual([added(repo, "first.txt")[0], sh(repo, "merge-base", sha1, sha2)], [sha1, sha1]); // first.txt came with receipt 1, which is under receipt 2
  assert.equal(full(other.repo, other.task.delivery.sha), full(other.repo, "HEAD"));
  // The same receipts in the cards' events, one each, with the checkout the delivery wrote.
  assert.deepEqual(deliveryEvents(board, task).map((e) => [e.delivered, e.target]), [[task.delivery.sha, mine.id]]);
  assert.deepEqual(deliveryEvents(board, second).map((e) => [e.delivered, e.target]), [[second.delivery.sha, mine.id]]);
  assert.deepEqual(deliveryEvents(other.board, other.task).map((e) => [e.delivered, e.target]), [[other.task.delivery.sha, theirs.id]]);
});

// F108 (the user, 17 November 2026): the delivery commit is titled "<title> (turn N)", N the card's total finished turns.
/** The newest non-merge commit subject on the card's task branch. */
const lastSubject = (f) => sh(f.repo, "log", "--no-merges", "-1", "--format=%s", f.task.branch);

test("deliver: the third turn's delivery commit is titled with the card title and (turn 3)", async () => {
  const f = deliveryCard();
  for (const file of ["one.txt", "two.txt", "three.txt"]) await f.turn(file);
  assert.equal(f.task.turns, 3);
  assert.equal(lastSubject(f), `${f.task.title} (turn 3)`);
});

test("deliver: turns 4, 5 and 6 deliver as (turn 6), the card's total, not the turns since the last delivery", async () => {
  const f = deliveryCard();
  for (const file of ["1.txt", "2.txt", "3.txt", "4.txt", "5.txt", "6.txt"]) await f.turn(file);
  assert.equal(f.task.turns, 6);
  assert.equal(f.task.deliveryTurns, undefined);
  assert.equal(lastSubject(f), `${f.task.title} (turn 6)`);
  assert.equal(JSON.parse(fs.readFileSync(f.board.file, "utf8")).find((t) => t.id === f.task.id).turns, 6); // saved with the card
});

test("deliver: a quiet end before any turn commits with the card title alone, never (turn 0)", async () => {
  const f = deliveryCard();
  fs.writeFileSync(path.join(f.worktree, "b.txt"), "b\n");
  f.board.update(f.task, { status: "review" }, undefined, true);
  await delivered(f.board);
  assert.equal(f.task.turns, undefined);
  assert.equal(lastSubject(f), f.task.title);
});

for (const how of ["merge", "discard"]) {
  test(`deliver: ${how} waits for a running delivery and Delete refuses it`, async (t) => {
    const { board, task, worktree } = deliveryCard();
    board.deliverEveryTurns = () => 1;
    fs.writeFileSync(path.join(worktree, "b.txt"), "b\n");
    board.update(task, { status: "review" }, undefined, true);
    await new Promise((r) => setImmediate(r));
    assert.ok(board.deliveryRunning, "the delivery started");
    assert.throws(() => board.remove(task), /being delivered/);
    const finish = board.finishHeld;
    let deliveryAtFinish;
    t.mock.method(board, "finishHeld", function (...args) {
      deliveryAtFinish = !!board.deliveryRunning;
      return finish.apply(this, args);
    });
    try {
      await board.finish(task, how);
    } finally {
      await delivered(board);
    }
    assert.equal(deliveryAtFinish, false, "delivery finished before the worktree operation began");
    assert.equal(task.status, "done");
    assert.equal(fs.readFileSync(path.join(board.repo, "b.txt"), "utf8"), "b\n");
    assert.equal(fs.existsSync(worktree), false);
  });
}

test("a renamed workspace folder: cards saved under the old folder's board follow this one, and the owner writes that once (F118)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-moved-"));
  made.push(repo);
  const dir = path.join(repo, ".entomatical"), tasksFile = path.join(dir, "tasks.json");
  const old = path.join(path.dirname(repo), "entomatical-before-rename", ".entomatical"); // not on disk: the folder was renamed
  fs.mkdirSync(dir, { recursive: true });
  const card = { id: "m1", title: "moved", prompt: "p", status: "done", createdAt: "", updatedAt: "", worktree: path.join(old, "wt", "m1"), branch: "task/m1",
    checks: { status: "complete", run: path.join(old, "checks", "m1", "1") } };
  fs.writeFileSync(tasksFile, JSON.stringify([card]));
  const onDisk = () => JSON.parse(fs.readFileSync(tasksFile, "utf8"))[0];
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  boards.push(board);
  assert.equal(board.get("m1").worktree, path.join(dir, "wt", "m1")); // every window shows the corrected path
  assert.equal(onDisk().worktree, card.worktree); // only the window that owns the board writes it
  board.begin();
  assert.equal(onDisk().worktree, path.join(dir, "wt", "m1"));
  assert.equal(onDisk().checks.run, path.join(dir, "checks", "m1", "1"));
  const written = fs.statSync(tasksFile).mtimeMs;
  board.tick();
  assert.equal(fs.statSync(tasksFile).mtimeMs, written); // nothing left to correct: no second write
});

for (const file of ["result", "notifications"]) {
  test(`queued panel Start reports a post-dispatch write failure once and sends one prompt / ${file}`, async t => {
    const { board, task, threadId } = planningPanelFixture();
    board.update(task, { held: true });
    if (file === "notifications") board.queueNotice(task.id, "fixture", "Included in the first prompt.");
    const filename = require.resolve("../out/extension.js"), extension = new Module(filename, module);
    extension.filename = filename;
    extension.paths = Module._nodeModulePaths(path.dirname(filename));
    extension._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.startHeldForTest = startHeld;\n", filename);
    const errors = [];
    vscode.window.showErrorMessage = async message => errors.push(message);
    t.after(() => { delete vscode.window.showErrorMessage; });
    const failure = `fixture: accepted turn B ${file} write failed (EIO)`;
    let prompts = 0, failures = 0;
    panelTransport(board, threadId, (rpc, id, method) => {
      assert.equal(method, "turn/start");
      prompts++;
      const rename = fs.renameSync;
      const fault = t.mock.method(fs, "renameSync", (from, to) => {
        if (file === "notifications" ? to !== board.notificationsFile
          : to !== board.file || JSON.parse(fs.readFileSync(from)).find(item => item.id === task.id)?.status !== "running") return rename(from, to);
        fault.mock.restore();
        failures++;
        throw Object.assign(new Error(failure), { code: "EIO" });
      });
      rpc.onResult({ id, result: { turn: { id: "B" } } });
    }, t);
    await extension.exports.startHeldForTest(board);
    await extension.exports.startHeldForTest(board);
    assert.equal(prompts, 1);
    assert.equal(failures, 1);
    const saved = JSON.parse(fs.readFileSync(board.file)).find(row => row.id === task.id);
    assert.equal(saved.sessionId, threadId);
    assert.equal(saved.status, file === "notifications" ? "running" : "queued");
    if (file === "notifications") assert.ok(JSON.parse(fs.readFileSync(board.notificationsFile)).pending[task.id].fixture);
    assert.equal(saved.startRetryAt, undefined);
    t.diagnostic(`saved status=${saved.status}, interrupted=${!!saved.interrupted}, visible errors=${JSON.stringify(errors)}`);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes(failure), errors[0]);
    assert.doesNotMatch(errors[0], /could not start|could not record|provider rejected/i);
    assert.ok(!saved.interrupted, "the acknowledged turn must not record a provider interruption");
  });
}
