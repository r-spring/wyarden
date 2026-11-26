// The four ideas (docs/parity/FEATURES.md), built as F77 Efficiency summary, F78 Plan first, F79 Asked you something
// and F80 Quiet and Repeating. Fixtures and fake data only: no model, no CLI, no VS Code.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

// board.js imports "vscode": the same small stand-in board.test.js uses.
class EventEmitter {
  listeners = [];
  event = (l) => (this.listeners.push(l), { dispose() {} });
  fire(e) { for (const l of this.listeners) l(e); }
  dispose() {}
}
const vscode = { EventEmitter, ThemeIcon: class {}, commands: { executeCommand: async () => {} },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined, createTerminal: () => ({ show() {}, dispose() {}, sendText() {} }) } };
const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-four-home-"));
process.env.HOME = process.env.USERPROFILE = home;
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board, planEnded, repeating } = require("../out/board.js");
const { parseIndex, efficiency, firstStopAt, cardSummary, kilo, median } = require("../out/efficiency.js");
const { asks, hash } = require("../hook/hook.js");

const made = [], boards = [];
test.after(() => { for (const b of boards) b.dispose(); for (const d of made) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
const tmp = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `entomatical-${name}-`)); made.push(d); return d; };
const open = () => { const repo = tmp("four"); const b = new Board(repo, path.join(repo, "hook.js"), path.join(repo, "hookdir")); b.startNudgeMs = 600_000; boards.push(b); return b; };
const writeEvents = (board, task, events) => fs.writeFileSync(board.eventsFile(task.id), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
const settings = (board, task) => { board.writeHooks(task); return JSON.parse(fs.readFileSync(board.hooksFile(task.id), "utf8")); };

// ---- F79: the heuristic, at least eight replies --------------------------------------------------------------------------------
test("asks: questions and option lists ask; statements, a question mid-text and code ending in ? do not", () => {
  const cases = [
    ["Should I also update the README?", true],
    ["I found two copies of the config.\n\n**Want me to delete the older one?**\n", true], // closing markdown and whitespace
    ["Shall I continue？", true], // full-width question mark
    ["Two ways to fix it:\n\n1. Keep the cache and add a key\n2. Drop the cache\n\nWhich one should I take? I will wait for your answer.", true], // a list, then a question
    ["Which do you prefer?\n\na) Rename the file\nb) Leave it and add a note", true], // the question just before a lettered list
    ["Why did it fail? The path had a typo. I fixed it, and npm test passes now.", false], // a question mid-text in a statement
    ["All done. What changed:\n1. Built the wrapper\n2. Ran the tests\nEverything passes.", false], // a list but no question
    ["Here is the pattern:\n```js\nconst re = /colou?r?/;\nconst x = ok ? a : b?\n```", false], // a closed code block ending in ?
    ["Use this:\n```\nmatch foo?", false], // an unclosed code block ending in ?
    ["Should I? " + "x".repeat(700) + "\n1. a\n2. b", false], // the only question is further back than 600 characters
    ["Is this right? `npm test` passed.", false],
    ["Did you mean `git status --short`?`", true],
    ["", false],
  ];
  for (const [text, want] of cases) assert.equal(asks(text), want, JSON.stringify(text.slice(0, 60)));
  assert.equal(asks(undefined), false);
});

test("hook.js writes asks at Stop and a short hash at PostToolUse, never the tool input", () => {
  const dir = tmp("hook"), out = path.join(dir, "e.jsonl");
  const run = (event) => execFileSync(process.execPath, [path.join(__dirname, "..", "hook", "hook.js"), out], { input: JSON.stringify(event) });
  run({ hook_event_name: "Stop", last_assistant_message: "Ready. Shall I push it?" });
  run({ hook_event_name: "Stop", last_assistant_message: "Pushed." });
  run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test -- --secret-flag" } });
  run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test -- --secret-flag" } });
  run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm run build" } });
  run({ hook_event_name: "UserPromptSubmit", prompt: "go" });
  const lines = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.asks), [true, false, undefined, undefined, undefined, undefined]);
  assert.match(lines[2].hash, /^[0-9a-f]{8}$/);
  assert.equal(lines[2].hash, lines[3].hash);
  assert.notEqual(lines[2].hash, lines[4].hash);
  assert.equal(lines[2].hash, hash({ tool_name: "Bash", tool_input: { command: "npm test -- --secret-flag" } }));
  assert.equal("hash" in lines[5], false);
  assert.equal(JSON.stringify(lines).includes("tool_input"), false);
});

test("Codex hook rows keep their own turn identity across overlapping submits and legacy rows", () => {
  const board = open(), task = board.add("", "Plan the change."), thread = "fixture-thread";
  board.update(task, { provider: "codex", sessionId: thread });
  const legacy = { t: 1, hook_event_name: "SessionStart", session_id: thread };
  writeEvents(board, task, [legacy]);
  const rows = [
    ["UserPromptSubmit", "A"], ["UserPromptSubmit", "B"], ["Stop", "A"], ["Interrupt", "A"],
    ["PermissionRequest", "B"], ["PostToolUse", "B"], ["SubagentStart", "B"], ["SubagentStop", "B"],
  ];
  const run = (name, id, launch = "") => execFileSync(process.execPath,
    [path.join(__dirname, "..", "hook", "hook.js")], {
      env: { ...process.env, ENTOMATICAL_RUNTIME: "codex", ENTOMATICAL_EVENTS: board.eventsFile(task.id), ENTOMATICAL_TERMINAL_LAUNCH: launch },
      input: JSON.stringify({ hook_event_name: name, session_id: thread, turn_id: id, tool_response: { secret: "fixture-private" } }),
    });
  for (const [name, id] of rows) run(name, id);
  const invalid = [undefined, null, { secret: "fixture-private" }, ["A"], 7, "", " ", "A\nB", "a".repeat(129)];
  for (const id of invalid) run("Stop", id);
  const outsideTurn = ["SessionStart", "SessionEnd", "Notification"];
  for (const name of outsideTurn) run(name, "unrelated-id");
  run("UserPromptSubmit", "C", "fixture-resumed-launch");
  const [old, ...events] = board.events(task.id);
  assert.deepEqual(old, legacy);
  assert.deepEqual(events.map(({ t, ...row }) => row), [
    ...rows.map(([hook_event_name, turn_id]) => ({ hook_event_name, session_id: thread, turn_id })),
    ...invalid.map(() => ({ hook_event_name: "Stop", session_id: thread })),
    ...outsideTurn.map(hook_event_name => ({ hook_event_name, session_id: thread })),
    { hook_event_name: "UserPromptSubmit", session_id: thread, turn_id: "C", terminal_launch_id: "fixture-resumed-launch" },
  ]);
});

test("the shared hook omits turn_id for the Claude hook command and other runtimes", () => {
  const board = open(), task = board.add("Claude", "Report.");
  const file = board.eventsFile(task.id), hook = path.join(__dirname, "..", "hook", "hook.js");
  const cases = [["claude", [hook, file]], ["codex", [hook, file]], ["claude", [hook]], ["grok", [hook]], ["", [hook]]];
  for (const [runtime, args] of cases) {
    execFileSync(process.execPath, args, {
      env: { ...process.env, ENTOMATICAL_RUNTIME: runtime, ENTOMATICAL_EVENTS: file, ENTOMATICAL_TERMINAL_LAUNCH: "" },
      input: JSON.stringify({ hook_event_name: "Stop", session_id: "claude-thread", turn_id: "foreign-turn" }),
    });
  }
  assert.deepEqual(board.events(task.id).map(({ t, ...row }) => row),
    Array(cases.length).fill({ hook_event_name: "Stop", session_id: "claude-thread" }));
});

test("a panel hook routes only a registered session to its own event file", () => {
  const dir = tmp("panel-hook"), hook = path.join(dir, "hook.js"), events = path.join(dir, "events.jsonl");
  fs.copyFileSync(path.join(__dirname, "..", "hook", "hook.js"), hook);
  fs.mkdirSync(path.join(dir, "panel-sessions"));
  fs.writeFileSync(path.join(dir, "panel-sessions", "thread-1.json"), JSON.stringify({ events }));
  const run = (id) => execFileSync(process.execPath, [hook], {
    env: { ...process.env, ENTOMATICAL_EVENTS: "", ENTOMATICAL_RUNTIME: "" }, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: id, turn_id: "panel-turn", prompt: "hello" }),
  });
  run("thread-1"); run("other-thread"); run("../thread-1");
  const lines = fs.readFileSync(events, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map((x) => [x.session_id, x.turn_id, x.prompt]), [["thread-1", "panel-turn", "hello"]]);
});

// ---- F80 --------------------------------------------------------------------------------------------------------------------------
test("Repeating counts identical calls since the prompt, from 5, skipping subagents and other events; a new prompt or call resets it", () => {
  const call = (h, extra = {}) => ({ t: 1, hook_event_name: "PostToolUse", tool_name: "Bash", hash: h, ...extra });
  const four = [call("aaaa1111"), call("aaaa1111"), { t: 1, hook_event_name: "PermissionRequest" }, call("aaaa1111"), call("bbbb2222", { agent_id: "sub" }), call("aaaa1111")];
  assert.equal(repeating(four), undefined); // four in a row: not yet
  assert.deepEqual(repeating([...four, call("aaaa1111")]), { tool: "Bash", n: 5 });
  assert.deepEqual(repeating([...four, call("aaaa1111"), call("aaaa1111")]), { tool: "Bash", n: 6 });
  assert.equal(repeating([...four, call("cccc3333"), call("aaaa1111")]), undefined); // a different call broke the run
  assert.equal(repeating([...four, { t: 1, hook_event_name: "UserPromptSubmit" }, call("aaaa1111")]), undefined);
  assert.deepEqual(repeating([...four, call(undefined), call("aaaa1111")]), { tool: "Bash", n: 5 }); // events from an older hook (no hash) are skipped
  assert.equal(repeating([call(undefined), call(undefined), call(undefined), call(undefined), call(undefined)]), undefined);
});

test("Quiet: the host sends the last event time of a running board card only; Repeating only while the turn runs", () => {
  const board = open();
  const task = board.add("t", "do it");
  const t0 = Date.now() - 25 * 60_000;
  writeEvents(board, task, [0, 1, 2, 3, 4].map((i) => ({ t: t0 + i, hook_event_name: "PostToolUse", tool_name: "Read", hash: "dddd4444" })));
  board.update(task, { status: "running" });
  assert.equal(board.lastEventAt(task), t0 + 4);
  assert.deepEqual(board.repeatingOf(task), { tool: "Read", n: 5 });
  assert.equal(board.statusOf(task).repeating, "Read ×5");
  board.update(task, { status: "review" });
  assert.deepEqual([board.lastEventAt(task), board.repeatingOf(task)], [undefined, undefined]);
  board.update(task, { status: "running", adopted: true }); // a found session: no Quiet
  assert.equal(board.lastEventAt(task), undefined);
});

test("Quiet: a running card's own terminal output counts as activity, whatever its provider (Antigravity fires no hooks)", () => {
  const board = open();
  const task = board.add("t", "do it");
  writeEvents(board, task, [{ t: Date.now() - 25 * 60_000, hook_event_name: "UserPromptSubmit" }]);
  board.update(task, { status: "running", provider: "antigravity", cardTerminalStarted: true });
  assert.ok(board.statusOf(task).quiet >= 25);
  const now = Date.now();
  board.cardTerminals.lastOutputAt = (id) => (id === task.id ? now : undefined);
  assert.equal(board.lastEventAt(task), now);
  assert.equal(board.statusOf(task).quiet, 0);
});

// ---- F79 on the board ---------------------------------------------------------------------------------------------------------------
test("a Stop that asks puts asks on the Review card before its status fires; running again clears it; a plain Stop never sets it", () => {
  const board = open();
  const task = board.add("t", "do it");
  const seen = [];
  board.onStatus((e) => seen.push([e.to, e.task.asks]));
  board.update(task, { sessionId: "s-asks", status: "running" });
  writeEvents(board, task, [{ t: Date.now() - 2, hook_event_name: "UserPromptSubmit", prompt: "go" }, { t: Date.now() - 1, hook_event_name: "Stop", last_assistant_message: "Which one?", asks: true }]);
  board.syncStatus(task.id);
  assert.deepEqual([task.status, task.asks], ["review", true]);
  assert.deepEqual(seen.at(-1), ["review", true]); // the notification reads it here
  assert.equal(board.statusOf(task).asks, true);
  board.update(task, { status: "running" }); // a follow-up
  assert.equal(task.asks, undefined);
  writeEvents(board, task, [{ t: Date.now() - 1, hook_event_name: "UserPromptSubmit", prompt: "a" }, { t: Date.now(), hook_event_name: "Stop", last_assistant_message: "Done.", asks: false }]);
  board.syncStatus(task.id);
  assert.deepEqual([task.status, task.asks, board.statusOf(task).asks], ["review", undefined, false]);
});

// ---- F78 ----------------------------------------------------------------------------------------------------------------------------
for (const ending of ["Stop", "StopFailure", "Interrupt"]) test(`first published Codex planning Review after ${ending}`, () => {
  const board = open(), task = board.add("", "Propose a change.");
  board.update(task, { provider: "codex", sessionId: "planning-thread", status: "running", planFirst: true });
  const snapshot = card => [card.status, card.planFirst, card.asks, card.interrupted];
  const saved = () => JSON.parse(fs.readFileSync(board.file, "utf8")).find(card => card.id === task.id);
  const redraws = [], notifications = [];
  board.onChange(() => { if (task.status === "review") redraws.push([snapshot(task), snapshot(saved())]); });
  board.onStatus(({ to, task: card }) => { if (to === "review") notifications.push(snapshot(card)); });
  const runHook = event => execFileSync(process.execPath, [path.join(__dirname, "..", "hook", "hook.js"), board.eventsFile(task.id)], {
    input: JSON.stringify({ session_id: task.sessionId, ...event }),
  });
  runHook({ hook_event_name: "SessionStart" });
  runHook({ hook_event_name: "UserPromptSubmit", prompt: "Propose a change." });
  runHook({ hook_event_name: ending, ...(ending === "Stop" ? { last_assistant_message: "Do you approve this plan?" } : {}) });
  board.syncStatus(task.id);
  const expected = ending === "Stop" ? ["review", undefined, true, undefined] : ["review", true, undefined, true];
  assert.deepEqual(redraws[0], [expected, expected], "first Review redraw and the file it published");
  assert.deepEqual(notifications, [expected]);
});

for (const route of ["panel", "rollout"]) test(`a resumed ${route} Review cannot borrow a previous turn's planning reply`, () => {
  const board = open(), task = board.add("", "Plan the change.");
  const thread = "12345678-1234-1234-1234-123456789abc", transcript = path.join(board.repo, `rollout-${thread}.jsonl`);
  board.update(task, { sessionId: thread, provider: "codex", codexEditor: true, codexPanelBridge: route === "panel",
    transcript, planFirst: true, status: "running" });
  fs.mkdirSync(path.join(board.repo, "workflows"));
  fs.writeFileSync(path.join(board.repo, "workflows", "old.plan.json"), "{}");
  writeEvents(board, task, [
    { hook_event_name: "UserPromptSubmit" },
    { hook_event_name: "Stop", last_assistant_message: "Approve old.plan.json?", asks: true },
    { hook_event_name: "SessionStart", source: "resume" },
  ].map((event, i) => ({ t: Date.now() + i, session_id: thread, ...event })));
  // Only B is present in this rollout. A single visible turn does not establish that the Stop belongs to B.
  fs.writeFileSync(transcript, ["task_started", "task_complete"].map(type => JSON.stringify({
    type: "event_msg", payload: { type, turn_id: "B", ...(type === "task_complete" ? { last_agent_message: "No file was produced." } : {}) },
  })).join("\n") + "\n");
  const reviews = [];
  board.onStatus(({ to }) => { if (to === "review") reviews.push([task.asks, task.planFile]); });
  if (route === "panel") board.codexPanelEvent({ taskId: task.id, threadId: thread, method: "turn/completed", status: "completed" });
  else board.discover();
  assert.deepEqual(reviews, [[undefined, undefined]]);
  const saved = JSON.parse(fs.readFileSync(board.file, "utf8")).find(card => card.id === task.id);
  assert.deepEqual([saved.status, saved.asks, saved.planFile], ["review", undefined, undefined]);
});

test("a failed planning Review write retries before notifying or changing resume settings", t => {
  const board = open(), task = board.add("Plan", "Propose a change.", undefined, undefined, undefined, undefined, undefined, { permission: "edits", planFirst: true });
  board.update(task, { sessionId: "s-plan", status: "running", continued: true });
  assert.equal(settings(board, task).permissions.defaultMode, "plan");
  writeEvents(board, task, [{ t: Date.now() - 1, hook_event_name: "SessionStart" }, { t: Date.now(), hook_event_name: "Stop", asks: true }]);
  const reviews = [];
  board.onStatus(({ to }) => reviews.push(to));
  const rename = fs.renameSync;
  const fail = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === board.file) throw new Error("fixture: cannot replace tasks.json");
    return rename(from, to);
  });
  assert.throws(() => board.syncStatus(task.id), /cannot replace tasks.json/);
  fail.mock.restore();
  const check = (status, planFirst, asks, continued, mode) => {
    const saved = JSON.parse(fs.readFileSync(board.file, "utf8")).find(card => card.id === task.id);
    for (const row of [task, saved]) assert.deepEqual([row.status, row.planFirst, row.asks, row.continued], [status, planFirst, asks, continued]);
    assert.equal(JSON.parse(fs.readFileSync(board.hooksFile(task.id), "utf8")).permissions.defaultMode, mode);
  };
  check("running", true, undefined, true, "plan");
  assert.deepEqual(reviews, []);
  board.syncStatus(task.id, true);
  check("review", undefined, true, undefined, "acceptEdits");
  assert.deepEqual(reviews, ["review"]);
});

test("a moved planning card clears an acknowledged continuation in its first Review write", t => {
  for (const started of [true, false]) {
    const board = open(), task = board.add("", "Continue planning.");
    board.update(task, { sessionId: "moved", continued: true, planFirst: true, permission: "edits", status: "running" });
    board.update(task, { usageRuns: undefined }); // isolate the continuation write from usage accounting
    board.deliveryTrigger = () => {}; // the turn counter normally makes a separate, unrelated write
    settings(board, task);
    board.tick(); // this owner has already refreshed the panel-history settings
    writeEvents(board, task, [...(started ? [{ t: 1, hook_event_name: "SessionStart" }] : []), { t: Date.now(), hook_event_name: "Stop", asks: true }]);
    const writes = [], reviews = [];
    const rename = fs.renameSync;
    const fault = t.mock.method(fs, "renameSync", (from, to) => {
      if (to === board.file) {
        const row = JSON.parse(fs.readFileSync(from, "utf8")).find(card => card.id === task.id);
        writes.push([row.status, row.planFirst, row.continued, row.asks]);
        if (writes.length === 2) throw new Error("fixture: second tasks.json write");
      }
      return rename(from, to);
    });
    board.onStatus(({ to }) => reviews.push(to));
    board.syncStatus(task.id);
    fault.mock.restore();
    board.syncStatus(task.id, true);
    assert.deepEqual(writes, [["review", undefined, started ? undefined : true, true]]);
    assert.equal(JSON.parse(fs.readFileSync(board.file, "utf8")).find(card => card.id === task.id).continued, started ? undefined : true);
    assert.deepEqual(reviews, ["review"]);
    assert.equal(JSON.parse(fs.readFileSync(board.hooksFile(task.id), "utf8")).permissions.defaultMode, "acceptEdits");
  }
});

test("the owner retries failed resume settings writes without publishing another Review", t => {
  const board = open(), task = board.add("", "Continue planning.");
  board.update(task, { sessionId: "moved", continued: true, planFirst: true, permission: "edits", status: "running" });
  settings(board, task);
  board.tick();
  const file = board.hooksFile(task.id), original = fs.readFileSync(file, "utf8"), reviews = [];
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
  writeEvents(board, task, [{ t: Date.now() - 1, hook_event_name: "SessionStart" }, { t: Date.now(), hook_event_name: "Stop", asks: true }]);
  board.onStatus(({ to }) => reviews.push(to));
  let attempts = 0;
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (dest, data, ...options) => {
    if (dest === file) {
      if (++attempts === 1) throw new Error("fixture: settings unavailable");
      if (attempts === 2) {
        write(dest, "{"); // the next poll must also repair an interrupted in-place write
        throw new Error("fixture: settings write failed");
      }
    }
    return write(dest, data, ...options);
  });
  board.syncStatus(task.id);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  board.tick();
  assert.equal(attempts, 2);
  board.tick();
  board.tick();
  assert.equal(attempts, 3);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).permissions.defaultMode, "acceptEdits");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(reviews, ["review"]);
});

test("a read-only Claude settings file refuses a rewrite and the owner retries after access is restored", {
  skip: process.platform === "win32" || process.getuid() === 0,
}, () => {
  const board = open(), task = board.add("", "Continue planning.");
  board.update(task, { sessionId: "moved", continued: true, planFirst: true, permission: "edits", status: "running" });
  settings(board, task);
  board.tick();
  const file = board.hooksFile(task.id), before = fs.readFileSync(file);
  fs.chmodSync(file, 0o400);
  try {
    writeEvents(board, task, [{ t: Date.now() - 1, hook_event_name: "SessionStart" }, { t: Date.now(), hook_event_name: "Stop", asks: true }]);
    board.syncStatus(task.id);
    assert.deepEqual([task.status, task.continued, task.planFirst, task.asks], ["review", undefined, undefined, true]);
    assert.throws(() => board.writeHooks(task), { code: "EACCES" });
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.statSync(file).mode & 0o777, 0o400);
  } finally { fs.chmodSync(file, 0o600); }
  board.tick();
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).permissions.defaultMode, "acceptEdits");
});

test("rewriting existing Claude settings preserves group access under a restrictive umask", { skip: process.platform === "win32" }, () => {
  const board = open(), task = board.add("", "Propose a change.");
  const file = board.hooksFile(task.id);
  settings(board, task);
  fs.chmodSync(file, 0o640);
  board.update(task, { permission: "edits" });
  const previous = process.umask(0o077);
  try {
    assert.equal(settings(board, task).permissions.defaultMode, "acceptEdits");
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  } finally { process.umask(previous); }
});

test("writing Claude settings through a dangling relative symlink creates its target", { skip: process.platform === "win32" }, () => {
  const board = open(), task = board.add("", "Propose a change.");
  board.update(task, { permission: "edits" });
  const file = board.hooksFile(task.id), target = path.join(path.dirname(file), "target.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(path.basename(target), file);
  board.writeHooks(task);
  assert.equal(fs.readlinkSync(file), path.basename(target));
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).permissions.defaultMode, "acceptEdits");
});

test("a returning owner repairs panel-history settings using the previous owner's saved Review", () => {
  const board = open(), task = board.add("", "Continue planning.");
  board.update(task, { sessionId: "moved", continued: true, planFirst: true, permission: "edits", status: "running" });
  const file = board.hooksFile(task.id), owner = path.join(board.dir, "owner.json");
  const mode = () => JSON.parse(fs.readFileSync(file, "utf8")).permissions.defaultMode;
  settings(board, task);
  board.tick();
  fs.writeFileSync(owner, JSON.stringify({ pid: process.ppid, at: Date.now() }));
  board.tick();
  const rows = JSON.parse(fs.readFileSync(board.file, "utf8"));
  Object.assign(rows.find(row => row.id === task.id), { status: "review", planFirst: undefined, continued: undefined, asks: true });
  fs.writeFileSync(board.file, JSON.stringify(rows)); // the other owner closes after saving Review but before rewriting settings
  board.tick();
  assert.equal(mode(), "plan");
  fs.writeFileSync(owner, JSON.stringify({ pid: process.ppid, at: Date.now() - 60_000 }));
  board.tick();
  assert.equal(mode(), "acceptEdits");
  assert.equal(board.get(task.id).asks, true);
});

test("Plan first writes plan mode for the first turn only, ahead of the permission pick; the first Stop takes it out so a resume does not plan again", () => {
  const board = open();
  const task = board.add("t", "do it", undefined, undefined, undefined, undefined, undefined, { permission: "edits", planFirst: true });
  assert.equal(task.planFirst, true);
  assert.deepEqual(settings(board, task).permissions, { defaultMode: "plan" });
  board.update(task, { sessionId: "s-plan", status: "running" });
  // A subagent's Stop and a StopFailure do not end the plan turn.
  writeEvents(board, task, [{ t: Date.now() - 3, hook_event_name: "SessionStart" }, { t: Date.now() - 2, hook_event_name: "UserPromptSubmit", prompt: "do it" },
    { t: Date.now() - 1, hook_event_name: "Stop", agent_id: "sub1", last_assistant_message: "sub done" }]);
  board.syncStatus(task.id);
  assert.equal(task.planFirst, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(board.hooksFile(task.id), "utf8")).permissions, { defaultMode: "plan" });
  fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ t: Date.now(), hook_event_name: "Stop", last_assistant_message: "Plan done and built." }) + "\n");
  board.syncStatus(task.id);
  assert.equal(task.planFirst, undefined);
  assert.equal(JSON.parse(fs.readFileSync(board.file, "utf8")).find((t) => t.id === task.id).planFirst, undefined); // saved
  // The file on disk, which every resume passes with --settings, has the card's own mode again (rewritten, not only at the next launch).
  assert.deepEqual(JSON.parse(fs.readFileSync(board.hooksFile(task.id), "utf8")).permissions, { defaultMode: "acceptEdits" });
  // Without a pick, the key goes away entirely: the account's own default.
  const plain = board.add("p", "x", undefined, undefined, undefined, undefined, undefined, { planFirst: true });
  assert.deepEqual(settings(board, plain).permissions, { defaultMode: "plan" });
  plain.planFirst = undefined;
  assert.equal(settings(board, plain).permissions, undefined);
});

test("the plan also ends when it was approved (ExitPlanMode ran); Esc or an API error leaves it", () => {
  assert.equal(planEnded([{ t: 1, hook_event_name: "PostToolUse", tool_name: "ExitPlanMode" }]), true);
  assert.equal(planEnded([{ t: 1, hook_event_name: "PostToolUse", tool_name: "ExitPlanMode", agent_id: "sub" }]), false);
  assert.equal(planEnded([{ t: 1, hook_event_name: "StopFailure", error: "rate_limit" }, { t: 2, hook_event_name: "PostToolUse", tool_name: "Read" }]), false);
  assert.equal(planEnded([{ t: 1, hook_event_name: "UserPromptSubmit" }]), false);
});

test("Plan first is dropped for a headless card", () => {
  const board = open();
  const headless = board.add("h", "x", undefined, undefined, undefined, undefined, undefined, { headless: true, planFirst: true });
  assert.equal(headless.planFirst, undefined);
});

// the user, 12 November 2026: "when a codex model is selected, the plan first button should use Astra at ultra effort".
test("Plan first on Codex runs the newest Astra at ultra effort, whatever was picked", () => {
  const codexModule = require("../out/codex.js");
  const saved = { models: codexModule.codexModels, ok: codexModule.codexEffortOk };
  let listed = [{ model: "gpt-6.1-sol", efforts: ["low", "max", "ultra"] }, { model: "gpt-6-astra", efforts: ["medium", "ultra"] }, { model: "gpt-6.1-astra", efforts: ["high", "ultra"] }];
  codexModule.codexModels = () => listed;
  codexModule.codexEffortOk = (model, effort) => listed.filter((m) => !model || m.model === model).some((m) => m.efforts.includes(effort));
  try {
    const board = open();
    board.accountList = () => [{ name: "codex", provider: "codex" }];
    const card = board.add("c", "x", "codex", undefined, "sol", "low", undefined, { planFirst: true, permission: "bypass" });
    assert.deepEqual([card.provider, card.planFirst, card.model, card.effort, card.permission], ["codex", true, "astra", "ultra", "bypass"]);
    // Without Plan first the pick stands.
    const plain = board.add("p", "x", "codex", undefined, "sol", "low");
    assert.deepEqual([plain.planFirst, plain.model, plain.effort], [undefined, "sol", "low"]);
    // Headless (Orchestrator) drops Plan first and keeps the pick.
    const headless = board.add("h", "x", "codex", undefined, "sol", "low", undefined, { headless: true, planFirst: true });
    assert.deepEqual([headless.planFirst, headless.model, headless.effort], [undefined, "sol", "low"]);
    // Refused with the reason when the Codex CLI lists no Astra, or the newest Astra has no ultra.
    listed = [{ model: "gpt-6.1-sol", efforts: ["ultra"] }];
    assert.throws(() => board.add("n", "x", "codex", undefined, undefined, undefined, undefined, { planFirst: true }), { message: "Plan first on Codex runs Astra at ultra effort, and the Codex CLI lists no Astra model." });
    listed = [{ model: "gpt-6.1-astra", efforts: ["high"] }];
    assert.throws(() => board.add("n", "x", "codex", undefined, undefined, undefined, undefined, { planFirst: true }), { message: "Plan first on Codex runs Astra at ultra effort, and gpt-6.1-astra does not offer ultra." });
  } finally { codexModule.codexModels = saved.models; codexModule.codexEffortOk = saved.ok; }
});

// ---- F77 ----------------------------------------------------------------------------------------------------------------------------
const S = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const call = (id, promptId, at, ctx, output, extra = {}) => ({ k: "c", f: 0, at, promptId, messageId: id, model: "claude-opus-5-5", tools: ["Bash"], input: 10, cacheRead: ctx - 110, cacheWrite: 100, output, ...extra });
/** Two prompts; the second began after the first Stop (10:05). A subagent call of prompt 1, a call written twice, and a half-written last line. */
const indexText = () => [
  { k: "f", f: 0, file: "/x/s.jsonl", account: "main" },
  { k: "f", f: 1, file: "/x/s/subagents/agent-a.jsonl", agentId: "a", account: "main" },
  { k: "p", f: 0, n: 1, promptId: "p1", at: "2026-11-05T10:00:00.000Z" },
  call("m1", "p1", "2026-11-05T10:00:10.000Z", 20_000, 500),
  call("m2", "p1", "2026-11-05T10:01:00.000Z", 40_000, 300),
  call("m2", "p1", "2026-11-05T10:01:00.000Z", 40_000, 300), // the same call twice (an index from before 4 November)
  call("s1", "p1", "2026-11-05T10:02:00.000Z", 90_000, 1000, { f: 1, tools: ["Read"] }), // a subagent: counts with its parent's prompt
  { k: "p", f: 0, n: 2, promptId: "p2", at: "2026-11-05T10:10:00.000Z" },
  call("m3", "p2", "2026-11-05T10:10:30.000Z", 60_000, 200, { model: "claude-sonnet-5-5" }),
].map((l) => JSON.stringify(l)).join("\n") + '\n{"k":"c","f":0,"messageId":"m4","inp';
const STOP = Date.parse("2026-11-05T10:05:00.000Z");

test("the efficiency summary folds the ledger index: calls, context mean and end, output, and the tail after the first Stop", () => {
  const index = parseIndex(indexText());
  assert.equal(index.calls.length, 4); // m2 once, the half line skipped
  const e = efficiency(index, STOP);
  const total = (ctx, out) => ctx + out;
  const all = total(20_000, 500) + total(40_000, 300) + total(90_000, 1000) + total(60_000, 200);
  assert.deepEqual({ ...e, rows: undefined, models: undefined }, { prompts: 2, calls: 4, perPrompt: 2, meanContext: (20_000 + 40_000 + 90_000 + 60_000) / 4, endContext: 60_000, output: 2000, tokens: all,
    tail: total(60_000, 200) / all, tailFrom: "stop", rows: undefined, models: undefined });
  assert.deepEqual(e.models, { "claude-opus-5-5": 3, "claude-sonnet-5-5": 1 });
  assert.deepEqual(e.rows.map((r) => [r.n, r.calls, r.meanContext, r.output, r.tail, r.tools]), [[1, 3, 50_000, 1800, false, { Bash: 2, Read: 1 }], [2, 1, 60_000, 200, true, { Bash: 1 }]]);
  // No Stop recorded: the tail starts at the second prompt (here the same); one prompt: no tail; no calls: no data, never zeros.
  assert.equal(efficiency(index).tailFrom, "prompt");
  assert.equal(efficiency(index).tail, e.tail);
  assert.equal(efficiency({ ...index, prompts: index.prompts.slice(0, 1) }, STOP).tail, 0);
  assert.equal(efficiency(parseIndex("")), undefined);
  assert.equal(efficiency(parseIndex("{broken")), undefined);
  // A Stop after both prompts began: nothing is correction yet.
  assert.equal(efficiency(index, Date.parse("2026-11-05T11:00:00.000Z")).tail, 0);
  assert.deepEqual(cardSummary(e), { prompts: 2, calls: 4, perPrompt: 2, meanContext: 52_500, endContext: 60_000, output: 2000, tail: Math.round(e.tail * 100) });
  assert.deepEqual([kilo(88_400), kilo(1_250), kilo(900), median([3, 1, 2]), median([4, 1, 2, 3]), median([])], ["88k", "1.3k", "900", 2, 2.5, undefined]);
  // The first Stop is the session's own: a subagent's, or another session's (before Switch account), does not count.
  assert.equal(firstStopAt([{ t: 1, hook_event_name: "Stop", agent_id: "x" }, { t: 2, hook_event_name: "Stop", session_id: "old" }, { t: 3, hook_event_name: "Stop", session_id: S }], S), 3);
});

test("the per-prompt rows come from one pass over the calls, not a filter per prompt, with the same rows (audit finding 13)", () => {
  // 40 prompts, 400 calls, some with no prompt id or one the index does not name; each call counts its promptId reads.
  let reads = 0;
  const lines = [{ k: "f", f: 0 }];
  for (let p = 1; p <= 40; p++) {
    lines.push({ k: "p", f: 0, n: p, promptId: `p${p}`, at: new Date(Date.UTC(2026, 10, 5, 10, p)).toISOString() });
    for (let c = 0; c < 10; c++) lines.push(call(`m${p}-${c}`, c === 9 ? undefined : c === 8 ? "unknown" : `p${p}`, new Date(Date.UTC(2026, 10, 5, 10, p, c)).toISOString(), 1000 * c + 200, c, { tools: [c % 2 ? "Bash" : "Read"] }));
  }
  const index = parseIndex(lines.map((l) => JSON.stringify(l)).join("\n"));
  const e = efficiency(index, STOP);
  // The filter per prompt it replaced, as the reference.
  const expected = [...index.prompts].sort((a, b) => a.n - b.n).map((p) => {
    const mine = index.calls.filter((c) => c.promptId && c.promptId === p.promptId), tools = {};
    for (const c of mine) for (const t of c.tools) tools[t] = (tools[t] ?? 0) + 1;
    const ctx = (c) => c.input + c.cacheRead + c.cacheWrite;
    return [p.n, mine.length, mine.length ? Math.round(mine.reduce((s, c) => s + ctx(c), 0) / mine.length) : 0, mine.reduce((s, c) => s + c.output, 0),
      mine.reduce((s, c) => s + ctx(c) + c.output, 0), tools];
  });
  assert.deepEqual(e.rows.map((r) => [r.n, r.calls, r.meanContext, r.output, r.tokens, r.tools]), expected);
  const counted = { ...index, calls: index.calls.map((c) => { const { promptId, ...rest } = c; return Object.defineProperty(rest, "promptId", { get: () => (reads++, promptId), enumerable: true }); }) };
  assert.deepEqual(efficiency(counted, STOP), e);
  assert.ok(reads <= 6 * index.calls.length, // the tail check reads it up to 3 times, the pass twice; a filter per prompt read it 80 times a call
 `promptId read ${reads} times for ${index.calls.length} calls: a pass, not one per prompt`);
});

test("efficiencyOf: No ledger data yet (undefined) for a Codex card, no session or an unindexed one; the numbers once the ledger has it", () => {
  const board = open();
  board.ledgerDir = tmp("ledger");
  const task = board.add("t", "x");
  assert.equal(board.efficiencyOf(task), undefined); // no session
  board.update(task, { sessionId: S, status: "review" });
  assert.equal(board.efficiencyOf(task), undefined); // not indexed yet
  fs.mkdirSync(path.join(board.ledgerDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(board.ledgerDir, "sessions", `${S}.jsonl`), indexText());
  writeEvents(board, task, [{ t: STOP, hook_event_name: "Stop", session_id: S, last_assistant_message: "ok" }]);
  const e = board.efficiencyOf(task);
  assert.deepEqual([e.prompts, e.calls, e.tailFrom, Math.round(e.tail * 100)], [2, 4, "stop", 28]);
  // The ledger appends: a new call is read at the next look (cached by size and time otherwise).
  fs.appendFileSync(path.join(board.ledgerDir, "sessions", `${S}.jsonl`), "\n" + JSON.stringify(call("m5", "p2", "2026-11-05T10:11:00.000Z", 70_000, 100)) + "\n");
  assert.equal(board.efficiencyOf(task).calls, 5);
  board.update(task, { provider: "codex" });
  assert.equal(board.efficiencyOf(task), undefined); // the ledger covers Claude only
});

test("ledger.js summary and compare print the same numbers, with the card's first Stop and check result found from its worktree", () => {
  const ledger = tmp("ledger-tool"), repo = tmp("ledger-repo");
  const cwd = path.join(repo, ".entomatical", "wt", "c0ffee");
  fs.mkdirSync(path.join(ledger, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(ledger, "sessions", `${S}.jsonl`), indexText());
  const S2 = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
  fs.writeFileSync(path.join(ledger, "sessions", `${S2}.jsonl`), JSON.stringify({ k: "p", n: 1, promptId: "q1", at: "2026-11-05T09:00:00.000Z" }) + "\n" + JSON.stringify(call("x1", "q1", "2026-11-05T09:00:01.000Z", 30_000, 50)) + "\n");
  const tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  fs.writeFileSync(path.join(ledger, "sessions.json"), JSON.stringify({ [S]: { account: "main", file: "/x", cwd, first: "2026-11-05T10:00:10.000Z", last: "2026-11-05T10:10:30.000Z", prompts: 2, calls: 4, tokens },
    [S2]: { account: "main", file: "/y", cwd: repo, first: "2026-11-05T09:00:01.000Z", last: "2026-11-05T09:00:01.000Z", prompts: 1, calls: 1, tokens } }));
  fs.mkdirSync(path.join(repo, ".entomatical", "events"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".entomatical", "events", "c0ffee.jsonl"), JSON.stringify({ t: STOP, hook_event_name: "Stop", session_id: S }) + "\n");
  fs.mkdirSync(path.join(repo, ".entomatical", "checks", "c0ffee", "1730800000000"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".entomatical", "checks", "c0ffee", "1730800000000", "receipt.json"), JSON.stringify({ status: "complete", checksPassed: true }));
  const tool = (...args) => execFileSync(process.execPath, [path.join(__dirname, "..", "tools", "ledger.js"), ...args], { env: { ...process.env, ENTOMATICAL_LEDGER_DIR: ledger }, encoding: "utf8" });
  const out = tool("summary", "aaaa").trim().split("\n");
  assert.equal(out[0], `${S}\t2 prompts · 4 calls · 2/prompt · ctx 53k mean, 60k end · out 2k · tail 28% (after the first Stop) · checks passed`);
  assert.deepEqual(out.slice(1), ["prompt\tcalls\tmean ctx\toutput\ttail\ttools", "#1\t3\t50k\t1.8k\t\tBash×2 Read×1", "#2\t1\t60k\t200\tyes\tBash×1"]);
  assert.match(tool("summary", "bbbb"), /1 prompts · 1 calls · 1\/prompt · ctx 30k mean, 30k end · out 50 · tail 0% \(after the first prompt; no Stop event found\)\n/);
  const cmp = tool("compare", "--since", "2026-11-05").trim().split("\n");
  assert.deepEqual(cmp, ["model\tsessions\tmedian calls/prompt\tmean ctx\tmedian tail", "claude-opus-5-5\t2\t1.5\t48k\t14%"]);
  assert.equal(tool("compare", "--since", "2026-12-01").trim(), "model\tsessions\tmedian calls/prompt\tmean ctx\tmedian tail");
  // The ledger owner places efficiency.js beside ledger.js, so the copied tool runs on its own.
  const placed = tmp("placed");
  for (const [from, to] of [["tools/ledger.js", "ledger.js"], ["out/efficiency.js", "efficiency.js"]]) fs.copyFileSync(path.join(__dirname, "..", from), path.join(placed, to));
  assert.match(execFileSync(process.execPath, [path.join(placed, "ledger.js"), "summary", "aaaa"], { env: { ...process.env, ENTOMATICAL_LEDGER_DIR: ledger }, encoding: "utf8" }), /tail 28%/);
});
