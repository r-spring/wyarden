// Host side of the board's follow-up send: what BoardView posts to the webview.
// out/extension.js runs on VS Code stand-ins; no window, process or model is used.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

function hostFixture(board, sidebar = {}, settings = {}) { // sidebar: the sidebar view's other fields (visible, onDidChangeVisibility)
  const posted = [], errors = [], warnings = [], disposers = [];
  const forbid = () => { throw new Error("This test must not open a window or launch a process."); };
  const vscode = {
    Uri: { joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }), onDidChangeConfiguration: () => ({ dispose() {} }) },
    window: { showErrorMessage: (m) => { errors.push(m); }, showInformationMessage: forbid, showWarningMessage: (m) => { warnings.push(m); } },
  };
  const filename = require.resolve("../out/extension.js");
  const extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = (name) => {
    if (name === "./local-time") return require("../out/local-time.js");
    if (name === "vscode") return vscode;
    if (name === "./speech-settings") return { speechSnapshot: () => ({ provider: "claude", providers: [], models: [] }) };
    if (name === "./asana-board") return { asanaSnapshot: () => undefined }; // no Asana project set
    if (name === "./obsidian-board") return { obsidianSnapshot: () => undefined, contextSource: () => "asana" };
    if (name === "child_process") return { execFile: forbid, execFileSync: forbid, spawn: forbid };
    if (name === "./board") return { accounts: () => [] };
    if (name === "./accounts") return { accountRows: () => [], externalProviderAccounts: () => [], activeConfigDir: () => "", onAccountsChanged: () => ({ dispose() {} }) };
    if (name === "./sessions") return { DEFAULT_DIR: path.join(os.homedir(), ".claude"), sameFolder: (a, b) => path.resolve(a || path.join(os.homedir(), ".claude")).toLowerCase() === path.resolve(b || path.join(os.homedir(), ".claude")).toLowerCase() };
    if (name === "./codex") return { codexAccounts: () => [], codexModels: () => [] };
    if (name === "./acp") return { antigravityChoices: () => [] }; // F88: the form's Antigravity models
    if (name === "./usage-history") return require("../out/usage-history.js"); // pure: reads nothing the fixture forbids
    if (name === "./efficiency") return require("../out/efficiency.js"); // pure (F77): formats what the stub board returns
    if (name === "./done-review") return require("../out/done-review.js"); // F97: each card's reviewable and findings are worked out per post
    if (name === "./helper-receipt") return require("../out/helper-receipt.js");
    if (["./battle", "./orchestrator", "./council", "./compile"].includes(name)) return require(`../out/${name.slice(2)}`);
    if (name === "./plan") return require("../out/plan.js"); // pure: Plan first's planning prompt in the state (F99)
    if (name === "./models" || name === "./acp") return require(`../out/${name.slice(2)}.js`); // pure model names (fix 11); acp only runs agy when asked
    if (name === "./cardTerminal") return require(path.join(path.dirname(filename), name));
    if (name === "./profiles") return require("../out/profiles.js"); // pure: capability profiles (phase 2)
    if (name.startsWith("./")) return {};
    return require(name);
  };
  extension._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.BoardView = BoardView;\n", filename);
  let receive;
  const webview = (into = posted) => ({ cspSource: "test", asWebviewUri: (u) => u.fsPath, postMessage: (m) => { into.push(m); return Promise.resolve(true); }, onDidReceiveMessage: (cb) => { receive = cb; } });
  const view = new extension.exports.BoardView({ fsPath: "ext" }, board);
  view.resolveWebviewView(Object.assign(sidebar, { webview: webview(), onDidDispose: (cb) => disposers.push(cb) })); // the same object: a test changes its visible
  /** The board's editor tab beside the sidebar: its posts go to `into`. */
  const tab = (into) => view.deserializeWebviewPanel({ webview: webview(into), onDidDispose: (cb) => disposers.push(cb) });
  return { receive: (m) => receive(m), posted, errors, warnings, window: vscode.window, tab, dispose: () => disposers.forEach((d) => d()) }; // dispose stops the 15-second re-post timer
}

function board() {
  const root = { id: "root", title: "Root", prompt: "Goal", status: "review", sessionId: "s1", worktree: "/wt/root" };
  const sub = { id: "sub", title: "Sub", prompt: "Part", status: "queued", parentId: "root" };
  const other = { id: "other", title: "Other", prompt: "Unrelated", status: "queued" };
  const sends = [];
  return {
    sends, dir: path.join(os.tmpdir(), "ab-webview-gates"), tasks: [root, sub, other],
    onChange: () => ({ dispose() {} }), get(id) { return this.tasks.find((t) => t.id === id); },
    prompts: () => [], subagentsOf: () => [], orchestratorEnabled: () => true, notInMainOf: () => undefined, deliverEveryTurns: () => 3, doingOf: () => undefined, timelineOf: () => [], runSummaryOf: () => undefined, finalReply: () => undefined, lastReply: () => "", metrics: { session: () => undefined }, waitingToStart: () => false, readinessOf: () => undefined, lanes: () => [], efficiencyOf: () => undefined, repeatingOf: () => undefined, lastEventAt: () => undefined, archivedRuns: () => [], modelOf: () => undefined,
    doingOf: () => undefined, timelineOf: () => [], runSummaryOf: () => undefined, finalReply: () => undefined,
    live: () => [], own: () => [], firstTurn: () => [], panelFirstTurn: () => [], accountList: () => [], isOwner: () => true, // Review shows on root in the owning window
    send(task, text) { if (task.id === "other") throw new Error("This session has ended. Resume it first."); sends.push([task.id, text]); },
  };
}

test("a follow-up the host sent is confirmed with sent; a refused one comes back as failed, with no sent", async () => {
  const b = board();
  const f = hostFixture(b);
  test.after(f.dispose);
  await f.receive({ type: "send", id: "sub", text: "more" });
  assert.deepEqual(b.sends, [["sub", "more"]]);
  assert.ok(f.posted.some((m) => m.sent === "sub"));
  f.posted.length = 0;
  await f.receive({ type: "send", id: "other", text: "kept" });
  assert.deepEqual(f.posted.find((m) => m.failed)?.failed, { type: "send", id: "other", text: "kept" });
  assert.ok(!f.posted.some((m) => "sent" in m));
  assert.match(f.errors[0], /session has ended/);
});

test("UI-H03: only a delivered follow-up gets a success acknowledgement and a provenance line", async (t) => {
  const b = board();
  b.dir = fs.mkdtempSync(path.join(os.tmpdir(), "follow-up-"));
  t.after(() => fs.rmSync(b.dir, { recursive: true, force: true }));
  const f = hostFixture(b);
  t.after(f.dispose);
  const removed = { type: "send", id: "sub", sendId: "request-a", text: "original\ntext" };
  const valid = { ...removed, id: "root", sendId: "request-b" };
  b.tasks = b.tasks.filter((card) => card.id !== removed.id);
  const file = path.join(b.dir, "provenance.jsonl");
  const acks = () => f.posted.filter((m) => m.failed || m.sent);
  await f.receive(removed);
  assert.deepEqual({ sends: b.sends, acks: acks(), lines: fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").length : 0 },
    { sends: [], acks: [{ failed: removed }], lines: 0 });
  const blank = { ...valid, text: "  " };
  await f.receive(blank);
  assert.deepEqual(acks().at(-1), { failed: blank });
  await f.receive(valid);
  assert.deepEqual(b.sends, [[valid.id, valid.text]]);
  assert.deepEqual(acks(), [{ failed: removed }, { failed: blank }, { sent: valid.id, sendId: valid.sendId }]);
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map((r) => [r.event, r.task, r.promptSha256]), [["follow-up", valid.id,
    require("node:crypto").createHash("sha256").update(valid.text).digest("hex")]]);
});

// Real board methods without starting its constructor's polling or providers.
function boardMethods() {
  const load = Module._load;
  let Board;
  try {
    Module._load = function (name, ...args) { return name === "vscode" ? { window: { terminals: [] } } : load.call(this, name, ...args); };
    ({ Board } = require("../out/board"));
  } finally { Module._load = load; }
  return Board.prototype;
}

test("UI-H04: board allocations bind Create, Plan first and each surviving Battle contestant to their prompt outcomes", async (t) => {
  const b = board(), methods = boardMethods();
  b.dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-outcomes-"));
  t.after(() => fs.rmSync(b.dir, { recursive: true, force: true }));
  const taskFile = path.join(b.dir, "tasks.json"), receiptFile = path.join(b.dir, "provenance.jsonl");
  const receipts = () => fs.readFileSync(receiptFile, "utf8").trim().split("\n").map(JSON.parse);
  const recordedAtSetup = [];
  Object.assign(b, { tasks: [], repo: b.dir, briefPath: path.join(b.dir, "BRIEF.md"), accountList: () => [{ name: "fixture" }],
    mustOwn() {}, capsOf: () => ({}), add: methods.add, resolveAccount: (name) => b.accountList().find((a) => a.name === name),
    profileProblem(task) {
      recordedAtSetup.push(receipts().at(-1).task);
      if (task.title.endsWith("Claude 3")) throw new Error("fixture setup interrupted");
    },
    save() { fs.writeFileSync(taskFile, JSON.stringify(this.tasks)); },
    update(task, patch) { Object.assign(task, patch); this.save(); } });
  fs.writeFileSync(b.briefPath, "Fixture orchestrator brief");
  const f = hostFixture(b, {}, { autoStart: false, "battleRoyale.enabled": true, "battleRoyale.clearArena": false,
    "battleRoyale.contestants": ["opus", "invalid", "haiku"].map((model) => ({ provider: "claude", model })) });
  t.after(f.dispose);
  const prompt = "  Compare these results.\nKeep the totals.  ";
  const hash = require("node:crypto").createHash("sha256").update(prompt).digest("hex");
  const create = { type: "create", prompt, account: "fixture" };
  for (const [createId, fields] of [["first", {}], ["second", {}], ["plan", { planFirst: true }]]) {
    await f.receive({ ...create, createId, ...fields });
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.posted.find((p) => p.created === createId), { created: createId, task: b.tasks.at(-1).id });
  }
  const [first, second, plan] = b.tasks;
  assert.equal(first.prompt, second.prompt);
  assert.ok(plan.prompt.includes(prompt.trim()) && !plan.prompt.startsWith(prompt));
  await f.receive({ ...create, type: "battle", orchestrator: true });
  assert.deepEqual(f.errors, []);
  assert.equal(f.warnings.length, 2);
  assert.match(f.warnings[0], /made no Claude 2 card.*Unknown model/);
  assert.match(f.warnings[1], /was added but setup did not finish.*fixture setup interrupted/);
  assert.equal(b.tasks.length, 5);
  assert.deepEqual(recordedAtSetup, b.tasks.map((card) => card.id));
  for (const card of b.tasks.slice(3)) assert.match(card.prompt, /Fixture orchestrator brief[\s\S]+Battle Royale/i);
  const lines = receipts();
  assert.deepEqual(lines.map((p) => [p.event, p.task, p.promptSha256, p.chars, p.source]),
    b.tasks.map((card) => ["create", card.id, hash, prompt.length, "raw"]));
  await f.receive({ ...create, createId: "refused", parentId: "gone" });
  assert.ok(f.posted.some((p) => p.failed?.createId === "refused"));
  assert.deepEqual(receipts(), lines);
  await f.receive({ type: "send", id: second.id, text: "follow-up" });
  b.update(first, { status: "done", checks: { status: "complete" } });
  b.update(second, { status: "done", checks: { status: "error" } });
  fs.mkdirSync(path.join(b.dir, "measurements"));
  for (const [id, total] of [[first.id, 100], [second.id, 300]]) {
    fs.writeFileSync(path.join(b.dir, "measurements", id + ".json"), JSON.stringify({ total, tokens: {}, source: "ledger" }));
  }
  const { rows } = require("../tools/prompt-outcomes").join(b.dir);
  assert.deepEqual(rows.map((r) => [r.task, r.checks, r.followUps, r.outcome, r.tokens]), [
    [first.id, "complete", 0, "passed", 100], [second.id, "error", 1, "failed", 300],
    ...b.tasks.slice(2).map((card) => [card.id, "none", 0, null, null])]);
});

// Use the real board send path, with one inert editor terminal.
function attachCodexTerminal(b, card, term) {
  const methods = boardMethods();
  card.provider = "codex";
  Object.assign(b, { send: methods.send, typeInto: methods.typeInto, terminal: methods.terminal,
    terminalSendBlocked: methods.terminalSendBlocked, approvalWaits: methods.approvalWaits, busySubagents: methods.busySubagents, external: new Map(), events: b.events ?? (() => []),
    terminals: new Map([[card.id, term]]), codexRuns: new Map(), codexPanelRuns: new Map(), codexPanelStarts: new Map(), codexEnterMs: 500,
    gate() {}, invalidateDelivery: methods.invalidateDelivery, update(task, patch) { Object.assign(task, patch); } });
}

function windowsReceive(fixture, message) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    return fixture.receive(message);
  } finally { Object.defineProperty(process, "platform", platform); }
}

test("F97: More > Follow-up on an exhausted Finish submits only to the stopped session, including at delayed Enter", async (t) => {
  for (const outcome of ["submitted", "new permission", "subagent permission", "live waiting", "another session", "new session start",
    "ended before paste", "ended before Enter", "resumed before Enter", "foreign end", "child A still waiting", "child A waiting before Enter", "child A answered"]) await t.test(outcome, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const b = board(), card = b.get("root"), writes = [];
    b.dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-follow-up-"));
    t.after(() => fs.rmSync(b.dir, { recursive: true, force: true }));
    Object.assign(card, { status: "needs-input", orchestrator: { opened: 0, caps: {} }, finishAsked: { at: new Date().toISOString() },
      selfFinish: { step: "Not done after 2 automatic rounds." }, autoRounds: 2, mergeRetries: 1 });
    const stop = { hook_event_name: "Stop", session_id: card.sessionId, t: Date.now() };
    const events = [stop];
    b.events = () => events;
    b.checks = { stop() {} };
    if (outcome === "subagent permission") events.unshift({ ...stop, hook_event_name: "PermissionRequest", agent_id: "child" });
    if (outcome === "another session") stop.session_id = "old";
    if (outcome === "new session start") events.push({ ...stop, hook_event_name: "SessionStart" });
    if (outcome === "ended before paste") events.push({ ...stop, hook_event_name: "SessionEnd" }, stop); // a late Stop cannot revive the CLI
    if (outcome === "foreign end") events.push({ ...stop, session_id: "other", hook_event_name: "SessionEnd" });
    const childWait = () => {
      events.push({ ...stop, agent_id: "A", hook_event_name: "PermissionRequest" },
        { ...stop, agent_id: "A", session_id: "foreign", hook_event_name: "PermissionRequest" },
        { ...stop, agent_id: "A", session_id: "foreign", hook_event_name: "PostToolUse" },
        { ...stop, hook_event_name: "UserPromptSubmit", prompt: "<task-notification>child B ended</task-notification>" },
        { ...stop, session_id: "foreign", hook_event_name: "UserPromptSubmit", prompt: "Other work" }, stop,
        { ...stop, agent_id: "B", hook_event_name: "PostToolUse" });
      card.status = "running"; // a sibling's activity was already applied
    };
    if (outcome === "child A still waiting" || outcome === "child A answered") childWait();
    if (outcome === "child A answered") events.push({ ...stop, t: stop.t + 1, agent_id: "A", hook_event_name: "SubagentStop" });
    attachCodexTerminal(b, card, { sendText(data) { writes.push(data); } });
    if (outcome === "live waiting") b.external.set(card.sessionId, { status: "waiting", statusUpdatedAt: stop.t + 1 });
    const f = hostFixture(b);
    t.after(f.dispose);
    const m = { type: "send", id: card.id, sendId: "follow-up", text: "Read round.txt again." };
    const pending = windowsReceive(f, m);
    assert.deepEqual([card.autoRounds, card.mergeRetries], [2, 1]);
    if (outcome === "new permission") events.push({ ...stop, hook_event_name: "PermissionRequest" }); // same column, hook not yet applied
    if (outcome === "ended before Enter") events.push({ ...stop, hook_event_name: "SessionEnd" });
    if (outcome === "resumed before Enter") events.push({ ...stop, hook_event_name: "SessionEnd" }, { ...stop, hook_event_name: "SessionStart" }, stop);
    if (outcome === "child A waiting before Enter") childWait();
    t.mock.timers.tick(500);
    await pending;
    const sent = ["submitted", "foreign end", "child A answered"].includes(outcome);
    assert.deepEqual(f.posted.filter(p => p.sent || p.failed), [sent ? { sent: card.id, sendId: m.sendId } : { failed: m }]);
    const paste = "\u001b[200~" + m.text + "\u001b[201~";
    const withheldEnter = ["new permission", "ended before Enter", "resumed before Enter", "child A waiting before Enter"].includes(outcome);
    assert.deepEqual(writes, sent ? [paste, "\r"] : withheldEnter ? [paste] : []);
    assert.deepEqual([card.autoRounds, card.mergeRetries], sent ? [0, 0] : [2, 1]);
    assert.ok(card.finishAsked);
  });
});

for (const [actor, response, offset, sent, reverse = false] of [
  ["child", undefined, 0, false],
  ["untagged child", "PostToolUse", -50, false], ["untagged child", "PostToolUse", 0, false],
  ["untagged child", "PostToolUse", 50, true], ["untagged child", "PostToolUse", 50, true, true],
  ["untagged child", "SubagentStop", 50, true], ["untagged child", "PostToolUse", undefined, false],
  ["child", "SubagentStop", -50, false], ["child", "SubagentStop", 50, true],
  ["child", "Interrupt", -50, false], ["child", "Interrupt", 50, true],
  ["owner", "Interrupt", -50, false], ["owner", "Interrupt", 0, false], ["owner", "Interrupt", 50, true],
]) test(`F97: delayed Enter after resumed Escape with ${actor} ${response ?? "pending"} at ${offset} ms${reverse ? " appended first" : ""}`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const b = board(), card = b.get("root"), writes = [];
  b.dir = fs.mkdtempSync(path.join(os.tmpdir(), "resumed-escape-"));
  t.after(() => fs.rmSync(b.dir, { recursive: true, force: true }));
  const launchId = "resumed", term = { sendText: text => writes.push(text) };
  const hook = (hook_event_name, fields = {}) => ({ hook_event_name, t: Date.now(), session_id: card.sessionId, terminal_launch_id: launchId, ...fields });
  const events = [hook("SessionStart"), hook("Stop"), hook("UserPromptSubmit", { prompt: "Correct the title." }), hook("Interrupt")];
  Object.assign(card, { status: "review", interrupted: true, finishAsked: { at: new Date().toISOString(), resume: { before: 0, sessionId: card.sessionId, launchId } } });
  b.events = () => events;
  b.checks = { stop() {} };
  b.finishTerminalLaunches = new WeakMap([[term, launchId]]);
  attachCodexTerminal(b, card, term);
  const f = hostFixture(b);
  t.after(f.dispose);
  const m = { type: "send", id: card.id, sendId: "follow-up", text: "Try again" };
  const pending = windowsReceive(f, m);
  const paste = "\u001b[200~Try again\u001b[201~";
  assert.deepEqual(writes, [paste]);
  const requestAt = events.at(-1).t + 100;
  const child = { agent_id: "child", terminal_launch_id: actor === "untagged child" ? undefined : launchId };
  const request = hook("PermissionRequest", { ...child, t: requestAt });
  if (response) {
    const reply = hook(response, { ...(actor === "owner" ? {} : child), t: offset === undefined ? undefined : requestAt + offset });
    events.push(...(reverse ? [reply, request] : [request, reply]));
  } else events.push(request);
  t.mock.timers.tick(500);
  await pending;
  assert.deepEqual(writes, sent ? [paste, "\r"] : [paste]);
  assert.deepEqual(f.posted.filter(p => p.sent || p.failed), [sent ? { sent: card.id, sendId: m.sendId } : { failed: m }]);
});

for (const [requestAt, answerAt] of [[25], [30], [31], [25, 24], [25, 25], [25, 26]]) {
  test(`F97: delayed Enter with a first SessionStart at 30, request at ${requestAt}, answer at ${answerAt ?? "none"}`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const b = board(), card = b.get("root"), writes = [];
    b.dir = fs.mkdtempSync(path.join(os.tmpdir(), "first-start-"));
    t.after(() => fs.rmSync(b.dir, { recursive: true, force: true }));
    const launchId = "resumed", term = { sendText: text => writes.push(text) };
    const append = (hook_event_name, t, fields = {}) => fs.appendFileSync(b.eventsFile(card.id),
      JSON.stringify({ hook_event_name, t, session_id: card.sessionId, terminal_launch_id: launchId, ...fields }) + "\n");
    Object.assign(b, { events: boardMethods().events, eventsFile: () => path.join(b.dir, "events.jsonl"), eventCache: new Map(),
      finishTerminalLaunches: new WeakMap([[term, launchId]]), checks: { stop() {} } });
    card.finishAsked = { at: new Date().toISOString(), resume: { before: 1, sessionId: card.sessionId, launchId } };
    attachCodexTerminal(b, card, term);
    append("PermissionRequest", 10, { agent_id: "old-child", terminal_launch_id: "old" });
    append("UserPromptSubmit", 20, { prompt: "Correct the title." });
    append("SessionStart", 30, { source: "resume" });
    append("Stop", 40);
    const f = hostFixture(b);
    t.after(f.dispose);
    const message = { type: "send", id: card.id, sendId: "follow-up", text: "Try again" };
    const pending = windowsReceive(f, message), paste = "\u001b[200~Try again\u001b[201~";
    assert.deepEqual(writes, [paste]);
    append("PermissionRequest", requestAt, { agent_id: "A" });
    if (answerAt !== undefined) append("SubagentStop", answerAt, { agent_id: "A" });
    t.mock.timers.tick(500);
    await pending;
    const sent = answerAt > requestAt;
    assert.deepEqual(writes, sent ? [paste, "\r"] : [paste]);
    assert.deepEqual(b.approvalWaits(card).children, sent ? [] : ["A"]);
    assert.deepEqual(f.posted.filter(p => p.sent || p.failed), [sent ? { sent: card.id, sendId: message.sendId } : { failed: message }]);
  });
}

test("F97: an approval recorded before the first verified SessionStart survives until an answer or a subsequent restart", () => {
  const task = { sessionId: "owner", finishAsked: { resume: { before: 1, sessionId: "owner", launchId: "new" } } };
  const events = [];
  const hook = (hook_event_name, t, fields = {}) => ({ hook_event_name, t, terminal_launch_id: "new", session_id: "owner", ...fields });
  const pending = () => boardMethods().approvalWaits(task, events);
  events.push(hook("PermissionRequest", 10, { terminal_launch_id: "old", agent_id: "old-child" }),
    hook("PermissionRequest", 25, { agent_id: "A" }), hook("Notification", 26),
    hook("SessionStart", 27, { agent_id: "B" }), hook("SessionStart", 28, { source: "compact" }),
    hook("SessionStart", 29, { session_id: undefined }), hook("SessionStart", 29, { session_id: "foreign" }),
    hook("SessionStart", 30, { source: "resume" }));
  assert.deepEqual(pending(), { session: true, children: ["A"] });
  events.push(hook("PostToolUse", 32));
  assert.deepEqual(pending(), { session: false, children: ["A"] });
  events.push(hook("SessionStart", 50), hook("PermissionRequest", 50, { agent_id: "B" }));
  assert.deepEqual(pending(), { session: false, children: ["B"] });
});

test("F97: an owner event releases only older approvals, across siblings and sessions", () => {
  const task = { sessionId: "owner" }, events = [];
  const pending = () => boardMethods().approvalWaits(task, events);
  const hook = (hook_event_name, t, agent_id, session_id = task.sessionId) => ({ hook_event_name, t, agent_id, session_id });
  events.push(hook("PermissionRequest", 10, "A"), hook("PermissionRequest", 20, "B", "one"),
    hook("Notification", 30, "B", "two"), hook("PermissionRequest", 40), hook("Interrupt", 25));
  assert.deepEqual(pending(), { session: true, children: ["B"] });
  events.push(hook("SubagentStop", 25, "B")); // the parent reports a child's stop
  assert.deepEqual(pending(), { session: true, children: ["B"] });
  events.push({ ...hook("UserPromptSubmit", 35), prompt: "Continue." });
  assert.deepEqual(pending(), { session: true, children: [] });
  events.push(hook("SessionStart", 40));
  assert.deepEqual(pending(), { session: true, children: [] });
  events.push(hook("PostToolUse", 41));
  assert.deepEqual(pending(), { session: false, children: [] });
  events.push(hook("PermissionRequest", undefined, "C"), hook("SubagentStop", 100, "C"));
  assert.deepEqual(pending(), { session: false, children: ["C"] });
});

test("UI-H03: the Windows Codex host records a follow-up only after its guarded Enter", async (t) => {
  for (const outcome of ["closed", "approval", "removed", "replaced", "write error", "submitted"]) await t.test(outcome, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const b = board(), card = b.get("root"), writes = [];
    b.dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-submit-"));
    t.after(() => fs.rmSync(b.dir, { recursive: true, force: true }));
    card.autoRounds = 3;
    const reviewFile = path.join(b.dir, "review.json");
    fs.writeFileSync(reviewFile, "{}");
    card.doneReview = { verdict: "done", findings: [], other: "", receipt: reviewFile };
    const decisions = () => (JSON.parse(fs.readFileSync(reviewFile, "utf8")).decisions || []).map((d) => d.action);
    const term = { sendText(text, newline) {
      if (text === "\r" && outcome === "write error") throw new Error("Terminal closed during Enter");
      writes.push([text, newline]);
    } };
    let invalidations = 0;
    attachCodexTerminal(b, card, term);
    b.invalidateDelivery = () => { invalidations++; };
    const f = hostFixture(b);
    t.after(f.dispose);
    const m = { type: "send", id: card.id, sendId: "from-composer", text: "whole\nfollow-up" };
    const acks = () => f.posted.filter((p) => p.sent || p.failed);
    const file = path.join(b.dir, "provenance.jsonl");
    const receipts = () => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : [];
    const pending = windowsReceive(f, m);
    const paste = ["\u001b[200~" + m.text + "\u001b[201~", false];
    t.mock.timers.tick(499);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(writes, [paste]);
    assert.deepEqual([acks(), receipts(), invalidations, card.autoRounds], [[], [], 0, 3], "the paste alone is pending");
    assert.deepEqual(decisions(), []);
    if (outcome === "closed") term.exitStatus = { code: 0 };
    if (outcome === "approval") card.status = "needs-input";
    if (outcome === "removed") b.tasks = b.tasks.filter((task) => task !== card);
    if (outcome === "replaced") b.terminals.set(card.id, { sendText: assert.fail });
    t.mock.timers.tick(1);
    await pending;
    assert.deepEqual(f.posted.at(-1).tasks.map((task) => task.id), b.tasks.map((task) => task.id), "the refreshed snapshot follows the acknowledgement");
    if (outcome === "submitted") {
      assert.deepEqual(writes, [paste, ["\r", false]]);
      assert.deepEqual(acks(), [{ sent: card.id, sendId: m.sendId }]);
      assert.deepEqual(receipts().map((r) => [r.event, r.task, r.chars]), [["follow-up", card.id, m.text.length]]);
      assert.deepEqual([invalidations, card.autoRounds], [1, 0]);
      assert.deepEqual(decisions(), ["worked-after-done"]);
    } else {
      assert.deepEqual(writes, [paste]);
      assert.deepEqual([acks(), receipts(), invalidations, card.autoRounds], [[{ failed: m }], [], 0, 3]);
      assert.deepEqual(decisions(), []);
    }
  });
});

async function boardPage(t) {
  const cdp = require("./compile-webview-cdp");
  if (!cdp.edgePath()) { t.skip("A supported browser is unavailable."); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "board-draft-"));
  let edge, page;
  t.after(async () => {
    page?.close();
    await edge?.kill();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const url = require("node:url").pathToFileURL(path.join(__dirname, "compile-webview-harness.html")).href;
  edge = await cdp.launchEdge(url, scratch);
  const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((p) => p.url === url), "the board page");
  page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
  const evaluate = (js) => page.evaluate(js);
  await cdp.waitFor(() => evaluate("window.__ready"), "the board script");
  return { scratch, page, evaluate, cdp };
}

test("F116: reload restores the ordinary draft and asks for plan reselection only after an interrupted setup", { timeout: 60_000 }, async (t) => {
  const browser = await boardPage(t);
  if (!browser) return;
  const { evaluate, page, cdp } = browser;
  const host = hostFixture(board());
  t.after(host.dispose);
  const notices = [];
  host.window.showInformationMessage = (message) => notices.push(message);
  const selectPlan = () => evaluate(`__host({ selectedPlan: { selectionId: 'fixture', file: 'workflow.json',
    raw: { v: 1, name: 'Reload test', review: 'checks', steps: [{ id: 'a', title: 'Alpha', goal: 'Goal' }] } } })`);
  const reload = async () => {
    await evaluate("window.__ready = false");
    await page.send("Page.reload");
    await cdp.waitFor(() => evaluate("window.__ready === true"), "reloaded board");
    const ready = await evaluate("window.__posted.find(m => m.type === 'ready')");
    await host.receive(ready);
  };

  await evaluate(`promptBox.value = 'Unfinished ordinary task'; promptBox.dispatchEvent(new Event('input'))`);
  await selectPlan();
  assert.equal(await evaluate("taskForm.hidden"), true);
  await reload();
  assert.deepEqual(await evaluate(`({ draft: promptBox.value, editable: !taskForm.hidden && !promptBox.readOnly,
    setupClosed: planSetup.element.hidden, runs: __posted.filter(m => ['runPlan', 'startSelectedPlan', 'create'].includes(m.type)).length })`),
    { draft: "Unfinished ordinary task", editable: true, setupClosed: true, runs: 0 });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Run a plan….*choose the plan again/i);

  await reload();
  await selectPlan();
  await evaluate(`[...document.querySelectorAll('.plan-setup button')].find(b => b.textContent === 'Cancel plan').click()`);
  await reload();
  await selectPlan();
  await evaluate("__host({ planStarted: true })");
  await reload();
  assert.equal(notices.length, 1, "ordinary reload, cancellation and successful completion stay quiet");
});

test("UI-H04: Apply, reload and Add bind the persisted Improve receipt to the same card in the spec and outcome report", { timeout: 60_000 }, async (t) => {
  const browser = await boardPage(t);
  if (!browser) return;
  const { scratch, page, evaluate, cdp } = browser, compile = require("../out/compile");
  await evaluate(cdp.HELPERS);
  const request = await evaluate('window.__h.setBox("A draft"); window.__h.click("Improve prompt"); window.__h.lastCompile()');
  const result = cdp.fixtures.readyResult(request.requestId, request.draft);
  result.rendered = compile.renderExecutionPrompt(result.record);
  const helperDir = path.join(scratch, "helpers", "previous-run");
  fs.mkdirSync(helperDir, { recursive: true });
  const file = path.join(helperDir, "compile-receipt.json");
  fs.writeFileSync(file, JSON.stringify({ kind: "improve", receiptStatus: "done", draft: request.draft }));
  const candidate = compile.saveCandidate(scratch, request.requestId, "new", request.draft, "", compile.controlsOf(request), { ...result, receipt: file });
  await evaluate(`window.__h.inject(${JSON.stringify(result)}); window.__h.click("Apply improved prompt"); true`);
  await evaluate("window.__ready = false");
  await page.send("Page.reload");
  await cdp.waitFor(() => evaluate("window.__ready === true"), "restored board script");
  const message = await evaluate('taskButton.click(); window.__posted.find((m) => m.type === "create")');
  assert.deepEqual(message.helpers, [{ kind: "improve", requestId: request.requestId, edited: false }]);

  const b = board();
  Object.assign(b, { dir: scratch, tasks: [], add: boardMethods().add, mustOwn() {},
    accountList: () => [{ name: request.account }], resolveAccount: () => ({ name: request.account }),
    save() { fs.writeFileSync(path.join(scratch, "tasks.json"), JSON.stringify(this.tasks)); } });
  const host = hostFixture(b, {}, { autoStart: false }); // a fresh attachment with no in-memory helper receipts
  t.after(host.dispose);
  message.helpers[0].receipt = "untrusted-webview-path";
  await host.receive(message);
  assert.deepEqual(host.errors, []);
  const [card] = b.tasks;
  assert.equal(card.spec.revisions[0].receipt, candidate.receipt);
  assert.equal(compile.loadCandidate(scratch, request.requestId).usedBy, card.id);
  const lines = () => fs.readFileSync(path.join(scratch, "provenance.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines()[0].helpers, [{ kind: "improve", edited: false, receipt: candidate.receipt }]);
  const { join, summary } = require("../tools/prompt-outcomes");
  assert.deepEqual(join(scratch).rows.map((r) => [r.task, r.source, r.edited]), [[card.id, "improve", false]]);

  fs.unlinkSync(file); // The saved candidate still identifies the helper and its output.
  await host.receive({ ...message, prompt: "Edited after Apply", helpers: [{ ...message.helpers[0], edited: true }] });
  assert.deepEqual(lines()[1].helpers, [{ kind: "improve", edited: true, receipt: null }]);
  await host.receive({ ...message, helpers: [{ kind: "improve", requestId: "expired", receipt: file, edited: false }] });
  assert.deepEqual(lines()[2].helpers, [{ kind: "unknown", edited: null, receipt: null }]);
  assert.deepEqual(Object.keys(summary(join(scratch).rows)), ["improve, applied as is", "improve, edited after", "unknown"]);
});

test("UI-H03: the browser recovers a removed card's draft and matches each acknowledgement to its send", { timeout: 60_000 }, async (t) => {
  const browser = await boardPage(t);
  if (!browser) return;
  const { scratch, evaluate } = browser;
  const host = (message) => evaluate(`window.__host(${JSON.stringify(message)}); true`);
  const boardState = board();
  boardState.dir = scratch;
  const fixture = hostFixture(boardState);
  t.after(fixture.dispose);
  async function deliver(message, afterPaste) {
    fixture.posted.length = 0;
    const pending = windowsReceive(fixture, message);
    afterPaste?.();
    await pending;
    const replies = fixture.posted.filter((m) => m.sent || m.failed);
    assert.equal(replies.length, 1);
    await host(replies[0]);
  }
  const snapshot = (...ids) => host({ accounts: ["acct"], own: ids, live: ids, tasks: ids.map((id) => ({ id, title: id, prompt: "p", status: "running", account: "acct" })) });
  async function submit(id, text) {
    await host({ cardAction: { type: "followUp", id } });
    return evaluate(`(() => {
      const box = document.querySelector('textarea[data-draft-target="${id}"]');
      box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event("input"));
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
      return window.__posted.filter((m) => m.type === "send").at(-1);
    })()`);
  }
  await snapshot("a", "b");
  const card = { id: "b", title: "b", prompt: "p", status: "running" }, writes = [];
  const term = { sendText: (text) => writes.push(text) };
  boardState.tasks = [card]; // a disappeared in the other view
  attachCodexTerminal(boardState, card, term);
  boardState.codexEnterMs = 10;
  await evaluate(`for (const id of ["a", "b"]) refinements.set(id, { kind: "revision", requestId: id, original: id, revision: "proposal " + id }); true`);
  const a = await submit("a", "  original A\nsecond line  ");
  const b = await submit("b", "valid B");
  await host({ sent: a.id, sendId: b.sendId });
  await deliver(a);
  await snapshot("b");
  assert.equal(await evaluate("promptBox.value"), a.text, "restore before deletion pruning");
  await deliver(b);
  assert.deepEqual(await evaluate("vscode.getState().followUps"), []);
  assert.deepEqual(await evaluate("vscode.getState().refinements.map(([id, r]) => [id, r.revision])"), [["new", "proposal a"]]);
  assert.equal(await evaluate(`document.querySelector('[data-refine-target="new"] [aria-label="Proposed draft"]').value`), "proposal a");
  assert.deepEqual(writes, ["\u001b[200~" + b.text + "\u001b[201~", "\r"]);
  assert.notEqual(a.sendId, b.sendId);

  const next = await submit("b", "new B");
  await host({ sent: b.id, sendId: b.sendId }); // duplicate from the previous round
  await deliver(next, () => { card.status = "needs-input"; });
  await snapshot("b");
  assert.equal(await evaluate(`document.querySelector('textarea[data-draft-target="b"]').value`), next.text);
  assert.equal(await evaluate("promptBox.value"), a.text);

  card.status = "running";
  const again = await evaluate(`document.querySelector('textarea[data-draft-target="b"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
    window.__posted.filter((m) => m.type === "send").at(-1)`);
  await snapshot(); // the deletion arrives before this failure
  await deliver(again, () => { term.exitStatus = { code: 0 }; });
  assert.equal(await evaluate("promptBox.value"), a.text, "an occupied new-task composer keeps its own draft");
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="Unsent follow-up for b"]').value`), next.text);
  assert.equal(writes.filter((text) => text === "\r").length, 1);
  assert.equal(fs.readFileSync(path.join(scratch, "provenance.jsonl"), "utf8").trim().split("\n").length, 1);
});

test("a board change builds the board's message once and sends it to the sidebar and the tab alike (audit finding 13)", async () => {
  const b = board(), changed = [];
  let built = 0;
  b.onChange = (fn) => (changed.push(fn), { dispose() {} });
  b.prompts = () => (built++, []);
  const f = hostFixture(b), inTab = [];
  test.after(f.dispose);
  await f.tab(inTab);
  f.posted.length = 0; built = 0;
  changed.forEach((fn) => fn());
  assert.equal(changed.length, 1, "one subscription for every webview");
  assert.equal(built, b.tasks.length, "each card is built once, not once per webview");
  assert.equal(f.posted.length, 1);
  assert.equal(inTab.length, 1);
  assert.equal(f.posted[0], inTab[0], "the same message");
  assert.deepEqual(f.posted[0].tasks.map((t) => t.id), ["root", "sub", "other"]);
});

// 11 November 2026: the board's build reads transcripts on the extension host's thread; each board change built it again, and the
// host froze often enough to make Claude Code's mic start late.
test("a burst of board changes builds the board once, then once more at most 500 ms later; a webview's own message builds at once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const b = board(), changed = [];
  let built = 0;
  b.onChange = (fn) => (changed.push(fn), { dispose() {} });
  b.prompts = () => (built++, []);
  const f = hostFixture(b);
  t.after(f.dispose);
  for (let i = 0; i < 20; i++) changed.forEach((fn) => fn());
  assert.equal(built / b.tasks.length, 1, "the first change builds at once; the 19 after it wait");
  assert.equal(f.posted.filter((m) => m.tasks).length, 1);
  t.mock.timers.tick(499);
  assert.equal(built / b.tasks.length, 1, "not before 500 ms");
  t.mock.timers.tick(1);
  assert.equal(built / b.tasks.length, 2, "one build for the rest of the burst");
  t.mock.timers.tick(10_000);
  assert.equal(built / b.tasks.length, 2, "nothing more without a new change");
  changed.forEach((fn) => fn());
  assert.equal(built / b.tasks.length, 3, "a change after a quiet spell builds at once");
  changed.forEach((fn) => fn()); // waits for the gap
  await f.receive({ type: "ready" }); // a reloaded webview: built now, and it stands in for the waiting build
  assert.equal(built / b.tasks.length, 4);
  t.mock.timers.tick(10_000);
  assert.equal(built / b.tasks.length, 4);
});

test("no board build while no board webview is visible; one when it shows again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const b = board(), changed = [], shown = [];
  let built = 0;
  b.onChange = (fn) => (changed.push(fn), { dispose() {} });
  b.prompts = () => (built++, []);
  const sidebar = { visible: false, onDidChangeVisibility: (fn) => (shown.push(fn), { dispose() {} }) };
  const f = hostFixture(b, sidebar);
  t.after(f.dispose);
  changed.forEach((fn) => fn());
  t.mock.timers.tick(5_000);
  changed.forEach((fn) => fn());
  assert.equal(built, 0, "hidden: nothing built");
  assert.equal(f.posted.filter((m) => m.tasks).length, 0);
  sidebar.visible = true;
  shown.forEach((fn) => fn());
  assert.equal(built / b.tasks.length, 1, "shown: built once");
  assert.equal(f.posted.filter((m) => m.tasks).length, 1);
  shown.forEach((fn) => fn());
  assert.equal(built / b.tasks.length, 1, "shown again with nothing missed: no build");
});

test("a headless follow-up refused later (a paused run) comes back as failed with its error, not sent", async () => {
  const b = board();
  b.send = (task) => Promise.reject(new Error(`Run paused: ${task.id}`)); // send returns followUpHeadless's promise (d8c3fab)
  const f = hostFixture(b);
  test.after(f.dispose);
  await f.receive({ type: "send", id: "sub", text: "more" });
  assert.deepEqual(f.posted.find((m) => m.failed)?.failed, { type: "send", id: "sub", text: "more" });
  assert.ok(!f.posted.some((m) => "sent" in m));
  assert.match(f.errors[0], /Run paused: sub/);
});

test("an idle Grok follow-up uses the managed provider session and reports failures", async () => {
  const b = board(), task = b.tasks[0];
  task.provider = "grok"; task.headless = true;
  const followed = [];
  b.followUpHeadless = async (card, text) => { if (text === "bad") throw new Error("Unable to resume"); followed.push([card.id, text]); };
  const f = hostFixture(b);
  test.after(f.dispose);
  await f.receive({ type: "send", id: "root", text: "continue" });
  assert.deepEqual(followed, [["root", "continue"]]);
  assert.ok(f.posted.some((m) => m.sent === "root"));
  f.posted.length = 0;
  await f.receive({ type: "send", id: "root", text: "bad" });
  assert.deepEqual(f.posted.find((m) => m.failed)?.failed, { type: "send", id: "root", text: "bad" });
  assert.match(f.errors[0], /Unable to resume/);
});
