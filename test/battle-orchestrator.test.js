// Battle Royale with Orchestrator ticked, the board's side (card a47807, the user, 14 November 2026: "we run each of these in the card
// terminal mode ... And the same goes for each of its subagents that it spawns"). A battle card that orchestrates runs in its card
// terminal, and every card it opens with `board.js add` carries its battle and runs in a card terminal with permission bypass; an
// ordinary orchestrator's cards stay headless. The VS Code stand-in of test/orchestrator-board.test.js; no session or process is started:
// Starts are recorded or use a fake PTY.
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
const vscode = { EventEmitter, ThemeIcon: class {}, TabInputCustom: class { constructor(uri) { this.uri = uri; } }, ViewColumn: { Beside: -2 },
  commands: { executeCommand: async () => undefined },
  Uri: { from: (parts) => ({ ...parts, toString: () => `${parts.scheme}://${parts.authority}${parts.path}` }), file: (p) => ({ fsPath: p }) },
  workspace: { openTextDocument: async (o) => ({ content: o?.content }), getConfiguration: () => ({ get: (_k, d) => d }) },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined, showInformationMessage: async () => undefined, showTextDocument: async () => undefined,
    createTerminal: (options) => { const t = { options, name: options.name, sent: [], show() {}, dispose() { t.exit(); }, exit(code = 0) { t.exitStatus = { code }; vscode.window.terminals = vscode.window.terminals.filter((x) => x !== t); }, sendText: (text) => t.sent.push(text), exitStatus: undefined, processId: Promise.resolve(4242) };
      vscode.window.terminals.push(t); return t; } } };
const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-battle-orch-home-"));
process.env.HOME = process.env.USERPROFILE = home;
process.env.ENTOMATICAL_USAGE_DIR = path.join(home, "usage");
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board } = require("../out/board.js");
const o = require("../out/orchestrator.js");

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const made = [], boards = [];
test.after(() => { for (const b of boards) b.dispose(); for (const d of made) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ACCOUNTS = [{ name: "acct", configDir: path.join(home, "acct") }, { name: "Grok · Work", provider: "grok", configDir: path.join(home, "grok") },
  { name: "Antigravity", provider: "antigravity", configDir: path.join(home, "agy") }];

/** A board in a throwaway repo whose starts are recorded: Claude and Codex cards get a stand-in terminal named as the board names its own. */
function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-battle-orch-"));
  made.push(repo);
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t"); sh(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false); // no 3 s poll: the tests tick by hand
  boards.push(board);
  board.accountList = () => ACCOUNTS;
  board.accountFolderList = () => ACCOUNTS.map((a) => a.configDir);
  board.preflightHeadless = async () => {};
  board.requestRateMs = 0;
  board.tick();
  const starts = [];
  board.start = async (t) => { starts.push(["start", t.id]); board.update(t, { sessionId: `s-${t.id}` }); return vscode.window.createTerminal({ name: `En ${t.id}` }); };
  board.startCardTerminal = async (t) => { starts.push(["startCardTerminal", t.id]); board.update(t, { cardTerminalStarted: true, status: "running", boardSessionId: `b-${t.id}` }); };
  board.startHeadless = async (t) => { starts.push(["startHeadless", t.id]); board.update(t, { sessionId: `h-${t.id}`, headless: true }); };
  return { repo, board, starts };
}
const event = (board, id, e) => fs.appendFileSync(board.eventsFile(id), JSON.stringify({ t: Date.now(), ...e }) + "\n");
async function request(board, body) {
  const inbox = path.join(board.dir, "inbox");
  const nonce = `n${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(path.join(inbox, `${nonce}.json`), JSON.stringify({ v: 1, at: "now", ...body }));
  await board.processInbox();
  for (let i = 0; i < 20 && !fs.existsSync(path.join(inbox, "done", `${nonce}.json`)); i++) await sleep(50);
  return JSON.parse(fs.readFileSync(path.join(inbox, "done", `${nonce}.json`), "utf8"));
}
/** A battle card with Orchestrator ticked, as the battle handler adds it (extension.ts), its session up and its turn over (Review). */
function battleMaster(board, account = "acct", caps = { ...o.DEFAULT_CAPS }) {
  const m = board.add("Race · Claude", "Battle Royale: …", account, undefined, undefined, undefined, undefined,
    { permission: "bypass", cardTerminal: true, battle: "b4771e00", ...o.battleRun(caps) });
  if (m.provider) board.update(m, { cardTerminalStarted: true, boardSessionId: `b-${m.id}`, status: "review" });
  else board.update(m, { sessionId: `s-${m.id}`, status: "review" });
  return m;
}
const session = (t) => t.provider ? t.boardSessionId : t.sessionId;

test("board.add: a battle card that orchestrates keeps its card terminal and is not headless; a Grok one runs in its own terminal, not over ACP; an ordinary orchestrator is unchanged", () => {
  const { board } = fixture();
  const m = battleMaster(board);
  assert.deepEqual([m.cardTerminal, m.headless, m.battle, m.permission, m.orchestrator, !!m.approved, m.runPolicy],
    [true, undefined, "b4771e00", "bypass", { caps: o.DEFAULT_CAPS, opened: 0 }, true, { allow: [], deny: [], noSync: true }]);
  const g = battleMaster(board, "Grok · Work");
  assert.deepEqual([g.provider, g.cardTerminal, g.headless, g.acpSelections], ["grok", undefined, undefined, undefined], "Grok always uses its own terminal; no ACP selections");
  // Without a battle: an orchestrator's Card terminal is dropped, as before.
  const plain = board.add("Plain", "p", "acct", undefined, undefined, undefined, undefined, { cardTerminal: true, orchestrator: { caps: { ...o.DEFAULT_CAPS }, opened: 0 }, headless: true });
  assert.deepEqual([plain.cardTerminal, plain.headless], [undefined, true]);
});

test("board.js add by a battle card: the card carries the battle, runs in a card terminal with bypass on the asked account, model and effort; the same request by an ordinary orchestrator makes a headless card", async () => {
  const { board, starts } = fixture();
  const m = battleMaster(board);
  // The run was approved when the battle started: no plan, no approval needed.
  const r = await request(board, { op: "add", by: m.id, session: session(m), title: "Helper", prompt: "Write the lexer.", model: "haiku", effort: "low", permission: "edits" });
  assert.equal(r.error, undefined);
  assert.deepEqual([r.created, r.started, r.permission], [true, true, "bypass"]);
  const h = board.get(r.id);
  assert.deepEqual([h.battle, h.cardTerminal, h.headless, h.permission, h.openedBy, h.watchedBy, h.parentId, h.account, h.model, h.effort],
    ["b4771e00", true, undefined, "bypass", m.id, m.id, m.id, "acct", "haiku", "low"]);
  assert.deepEqual(starts, [["start", h.id]], "started in its card terminal, not headless");
  assert.equal(m.orchestrator.opened, 1);
  // A Grok helper runs in Grok's own terminal; one the helper opens (with --may-open) inherits the battle too.
  const rg = await request(board, { op: "add", by: m.id, session: session(m), title: "Grok helper", prompt: "Review it.", account: "Grok · Work", mayOpen: true });
  const gh = board.get(rg.id);
  assert.deepEqual([rg.started, gh.provider, gh.battle, gh.headless, gh.acpSelections, gh.permission, !!gh.orchestrator], [true, "grok", "b4771e00", undefined, undefined, "bypass", true]);
  assert.deepEqual(starts.at(-1), ["startCardTerminal", gh.id]);
  const rgg = await request(board, { op: "add", by: gh.id, session: session(gh), title: "Grandchild", prompt: "Count lines.", account: "acct" });
  const gg = board.get(rgg.id);
  assert.deepEqual([gg.battle, gg.cardTerminal, gg.headless, gg.openedBy, gg.provider], ["b4771e00", true, undefined, gh.id, undefined]);
  assert.deepEqual(starts.at(-1), ["start", gg.id]);
  // A standing role is fed by the board itself: it keeps the battle look and runs headless, as before.
  const rr = await request(board, { op: "add", by: m.id, session: session(m), title: "Research", prompt: "Which parser?", role: "research" });
  assert.deepEqual([board.get(rr.id).battle, board.get(rr.id).headless, starts.at(-1)], ["b4771e00", true, ["startHeadless", rr.id]]);
  // Helpers count against the run's caps: four opened in the run.
  assert.equal(m.orchestrator.opened, 4);
  // An ordinary orchestrator: the same request makes a headless card with no battle, as before.
  const p = board.add("Plain", "p", "acct", undefined, undefined, undefined, undefined, { orchestrator: { caps: { ...o.DEFAULT_CAPS }, opened: 0 }, headless: true, approved: { at: "x", hash: "h" } });
  board.update(p, { sessionId: "s-plain", status: "review" });
  const rp = await request(board, { op: "add", by: p.id, session: "s-plain", title: "Helper", prompt: "Write the lexer.", model: "haiku", effort: "low", permission: "edits" });
  const ph = board.get(rp.id);
  assert.deepEqual([ph.battle, ph.cardTerminal, ph.headless, ph.permission], [undefined, undefined, true, "edits"]);
  assert.deepEqual(starts.at(-1), ["startHeadless", ph.id]);
});

test("a battle run's caps and the running limit hold for its helpers", async () => {
  const { board, starts } = fixture();
  const m = battleMaster(board, "acct", { ...o.DEFAULT_CAPS, open: 1 });
  const first = await request(board, { op: "add", by: m.id, session: session(m), title: "One", prompt: "1" });
  assert.equal(first.started, true);
  assert.equal((await request(board, { op: "add", by: m.id, session: session(m), title: "Two", prompt: "2" })).error, "open cap (1)");
  // The running limit (startPolicy): the helper waits in Queued, held, and is not started.
  board.update(board.get(first.id), { status: "done" });
  board.startPolicy = () => "Waiting: 1 of 1 running";
  const held = await request(board, { op: "add", by: m.id, session: session(m), title: "Three", prompt: "3" });
  assert.deepEqual([held.started, board.get(held.id).held, board.get(held.id).cardTerminal, starts.length], [false, true, true, 1]);
  const retry = () => request(board, { op: "resume", by: m.id, session: session(m), id: held.id });
  assert.match((await retry()).error, /Waiting: 1 of 1 running/);
  board.startPolicy = () => undefined;
  assert.equal((await retry()).ok, true);
  assert.deepEqual(starts.at(-1), ["start", held.id]);
});

test("the opener is told when its helper's turn ends: typed into a Claude opener's card terminal, and into a Grok opener's after its turn-done", async () => {
  const { board } = fixture();
  const m = battleMaster(board);
  const mTerm = vscode.window.createTerminal({ name: `En ${m.id}` }); // the opener's card terminal (the board's own terminal for it)
  const h = board.get((await request(board, { op: "add", by: m.id, session: session(m), title: "Lexer", prompt: "Write the lexer." })).id);
  event(board, h.id, { hook_event_name: "SessionStart", session_id: h.sessionId });
  event(board, h.id, { hook_event_name: "UserPromptSubmit", prompt: "p" });
  board.syncStatus(h.id);
  assert.equal(h.status, "running");
  // The helper's turn ends (its Stop hook): the opener, idle in Review, gets the settle line typed into its terminal.
  event(board, h.id, { hook_event_name: "Stop", last_assistant_message: "Lexer written." });
  board.syncStatus(h.id); board.publishStatus();
  await sleep(100);
  assert.equal(h.status, "review");
  assert.ok(mTerm.sent.some((s) => s.includes(`Child settled: ${h.id}`) && s.includes("Lexer written.")), mTerm.sent.join("\n---\n"));
  // A Grok opener in its own card terminal: the notice waits while it runs, and is typed in once it reports its turn done.
  const g = battleMaster(board, "Grok · Work");
  const writes = [];
  board.cardTerminals.has = (id) => [g.id, h.id].includes(id) || false;
  board.cardTerminals.write = (id, data) => { writes.push([id, data]); };
  board.update(g, { status: "running" });
  const gh = board.get((await request(board, { op: "add", by: g.id, session: session(g), title: "Grok helper", prompt: "Review it.", account: "Grok · Work" })).id);
  board.cardTerminals.has = (id) => [g.id, h.id, gh.id].includes(id);
  // The Grok helper's turn ends the way a Grok card terminal's does: board.js turn-done from its own session.
  assert.equal((await request(board, { op: "turn-done", by: gh.id, session: session(gh) })).ok, true);
  board.publishStatus();
  await sleep(300);
  assert.equal(writes.length, 0, "not typed while the opener runs");
  assert.ok(board.pendingNotices.get(g.id)?.has(gh.id), "queued for the opener");
  assert.equal((await request(board, { op: "turn-done", by: g.id, session: session(g) })).ok, true);
  board.publishStatus();
  await sleep(400);
  assert.ok(writes.some(([id, data]) => id === g.id && data.includes(`Child settled: ${gh.id}`)), JSON.stringify(writes));
  assert.deepEqual(writes.at(-1), [g.id, "\r"]);
  assert.equal(g.status, "running", "the Enter runs the opener's next turn");
});

// The displayed composer and the process's input mode are independent in this fixture.
// Nothing here invokes agy or makes a terms decision.
async function antigravityBattle(maxRunning = 0) {
  const { board } = fixture();
  delete board.startCardTerminal;
  board.maxRunning = () => maxRunning;
  board.agyModelIds = () => ["gemini-4-carbon-low"];
  const terminals = new Map();
  board.cardTerminals.spawn = (_file, _args, { env }) => {
    const proc = { mode: "composer", writes: [], onData(fn) { this.output = fn; }, onExit() {}, resize() {}, kill() {},
      write(data) { this.writes.push([this.mode, data]); this.afterWrite?.(data); } };
    terminals.set(env.ENTOMATICAL_TASK, proc);
    return proc;
  };
  const opener = board.add("Race · Antigravity", "Delegate.", "Antigravity", undefined, "carbon", undefined, undefined,
    { battle: "b4771e00", ...o.battleRun({ ...o.DEFAULT_CAPS }) });
  await board.startCardTerminal(opener);
  const ask = (card, op, fields) => request(board, { op, by: card.id, session: session(card), ...fields });
  const add = await ask(opener, "add", { title: "Marker helper", prompt: "Write the marker.", account: "Antigravity", model: "carbon" });
  assert.equal(add.created, true, JSON.stringify(add));
  const helper = board.get(add.id);
  async function show(card, mode, line) {
    const proc = terminals.get(card.id);
    proc.mode = mode;
    proc.output("\x1b[2J\x1b[H" + line);
    for (let i = 0; i < 100; i++) {
      if (board.cardTerminals.screen(card.id).text === line) return;
      await sleep(10);
    }
    assert.fail(`Timed out rendering "${line}"`);
  }
  async function finishDelivery(card) {
    for (let i = 0; i < 100 && board.delivering.has(card.id); i++) await sleep(10);
    assert.equal(board.delivering.has(card.id), false);
  }
  return { board, opener, helper, terminals, ask, show, finishDelivery };
}

test("an initialized Antigravity opener frees the only slot and wakes on settlement", async () => {
  const { toStart, dispatchHeld } = require("../out/queue.js");
  const { board, opener, helper, terminals, ask, show, finishDelivery } = await antigravityBattle(1);
  assert.equal(helper.status, "queued");
  assert.match(board.startWait(helper), /1 of 1 running/);
  assert.deepEqual(toStart(board.tasks, 1), []);
  await show(opener, "composer", "Message >");
  assert.equal((await ask(opener, "turn-done")).ok, true);
  assert.equal(board.startWait(helper), undefined);
  assert.deepEqual(toStart(board.tasks, 1), [helper]);
  assert.equal((await dispatchHeld(board, helper, () => board.startInCard(helper))).state, "started");
  await show(helper, "composer", "Message >");
  assert.equal((await ask(helper, "turn-done")).ok, true);
  board.publishStatus();
  await finishDelivery(opener);
  const openerWrites = terminals.get(opener.id).writes;
  assert.ok(openerWrites.every(([mode]) => mode === "composer"));
  const input = openerWrites.map(([, data]) => data).join("");
  assert.ok(input.includes(`Child settled: ${helper.id}`) && input.endsWith("\r"), JSON.stringify(input));
  assert.equal(opener.status, "running");
});

test("an explicit send wakes an initialized Antigravity battle helper", async () => {
  const { opener, helper, terminals, ask, show, finishDelivery } = await antigravityBattle();
  await show(helper, "composer", "Message >");
  assert.equal((await ask(helper, "turn-done")).ok, true);
  assert.equal((await ask(opener, "send", { id: helper.id, text: "Check the marker." })).ok, true);
  await finishDelivery(helper);
  const helperWrites = terminals.get(helper.id).writes;
  assert.ok(helperWrites.every(([mode]) => mode === "composer"));
  const input = helperWrites.map(([, data]) => data).join("");
  assert.ok(input.includes("Check the marker.") && input.endsWith("\r"), JSON.stringify(input));
  assert.equal(helper.status, "running");
});

for (const dialog of ["Choose your color scheme:", "Terms of Service & Data Use"]) {
  test(`F89 must retain a settlement while the opener shows "${dialog}"`, async t => {
    const { board, opener, helper, terminals, ask, show, finishDelivery } = await antigravityBattle();
    await show(opener, "onboarding", dialog);
    assert.equal((await ask(opener, "turn-done")).ok, true);
    assert.equal((await ask(helper, "turn-done")).ok, true);
    board.publishStatus();
    await finishDelivery(opener);
    const pending = JSON.parse(fs.readFileSync(board.notificationsFile, "utf8")).pending[opener.id];
    const proc = terminals.get(opener.id);
    const blocked = { writes: proc.writes.slice(), status: opener.status, retained: !!pending?.[helper.id] };
    // Simulate the provider presenting a composer later. The fixture sends no onboarding input.
    await show(opener, "composer", "Message >");
    board.deliverNotices(opener.id);
    await finishDelivery(opener);
    const resumed = proc.writes.filter(([mode]) => mode === "composer").map(([, data]) => data).join("");
    t.todo("Open F89 native failure: a PTY write has no provider receipt.");
    assert.deepEqual(blocked, { writes: [], status: "review", retained: true });
    assert.ok(resumed.includes(`Child settled: ${helper.id}`) && resumed.endsWith("\r"), JSON.stringify(resumed));
    assert.equal(opener.status, "running");
  });
}

test("Antigravity's last rendered prompt and PTY generation cannot distinguish an unpublished input-mode change", async () => {
  const { board, opener, terminals, show } = await antigravityBattle();
  await show(opener, "composer", "Message >");
  const visible = () => ({ attachment: board.cardTerminals.attach(opener.id), screen: board.cardTerminals.screen(opener.id) });
  const before = visible();
  const proc = terminals.get(opener.id);
  proc.mode = "onboarding";
  assert.deepEqual(visible(), before, "before the redraw even the raw output and generation are identical");
  proc.output("\x1b[2J\x1b[HTerms of Service & Data Use");
  assert.equal(board.cardTerminals.screen(opener.id).text, before.screen.text, "xterm still has the previous text until it parses the bytes");
  assert.ok(board.cardTerminals.attach(opener.id).snapshot.endsWith("Terms of Service & Data Use"));
});

test("F89 must keep a notice when the input target changes between the text and Enter", async t => {
  const { board, opener, helper, terminals, ask, show, finishDelivery } = await antigravityBattle();
  await show(opener, "composer", "Message >");
  const proc = terminals.get(opener.id);
  proc.afterWrite = data => { if (data !== "\r") proc.mode = "onboarding"; }; // the process hasn't emitted its redraw yet
  assert.equal((await ask(opener, "turn-done")).ok, true);
  assert.equal((await ask(helper, "turn-done")).ok, true);
  board.publishStatus();
  await finishDelivery(opener);
  const pending = JSON.parse(fs.readFileSync(board.notificationsFile, "utf8")).pending[opener.id];
  t.todo("Open F89 race. The PTY write succeeds in either mode.");
  assert.deepEqual({ enterInDialog: proc.writes.some(([mode, data]) => mode === "onboarding" && data === "\r"),
    status: opener.status, retained: !!pending?.[helper.id] }, { enterInDialog: false, status: "review", retained: true });
});

test("the opener reads and types its helper's card terminal (F89)", async () => {
  const { board } = fixture();
  const m = battleMaster(board);
  const h = board.get((await request(board, { op: "add", by: m.id, session: session(m), title: "Lexer", prompt: "Write the lexer." })).id);
  const writes = [];
  board.cardTerminals.screen = (id) => id === h.id ? { text: "lexer.ts written", state: "running", cols: 80, rows: 24 } : undefined;
  board.cardTerminals.has = (id) => id === h.id;
  board.cardTerminals.write = (id, data) => { writes.push([id, data]); };
  const shot = await request(board, { op: "screen", id: h.id, by: m.id, session: session(m) });
  assert.deepEqual([shot.ok, shot.text], [true, "lexer.ts written"]);
  const typed = await request(board, { op: "type", id: h.id, by: m.id, session: session(m), text: "Add tests too.", enter: true });
  assert.equal(typed.ok, true);
  assert.deepEqual(writes, [[h.id, "Add tests too."], [h.id, "\r"]]);
});

test("a battle root's plan keeps its approval and tells its turn to go on; it takes no caps file and may not finish itself", async () => {
  const { board } = fixture();
  const m = battleMaster(board);
  const mTerm = vscode.window.createTerminal({ name: `En ${m.id}` });
  fs.writeFileSync(board.planFile(m), "## Steps\n- Lexer\n- Parser\n"); // the repo itself: the stubbed start made no worktree
  const approved = m.approved;
  const r = await request(board, { op: "plan", by: m.id, session: session(m) });
  assert.deepEqual([r.ok, r.note], [true, o.BATTLE_APPROVED_NOTICE]);
  assert.deepEqual([m.approved, m.plan.steps, m.status], [approved, 2, "review"], "approved still, not waiting for the user in Needs input");
  await sleep(100);
  assert.ok(mTerm.sent.some((s) => s.includes(o.BATTLE_APPROVED_NOTICE)), "the turn that ended to wait is told to go on");
  assert.equal((await request(board, { op: "plan", by: m.id, session: session(m), caps: { open: 9 } })).error, o.BATTLE_CAPS_REFUSAL);
  board.update(m, { worktree: board.repo });
  assert.equal((await request(board, { op: "finish", by: m.id, session: session(m), self: true })).error, o.BATTLE_FINISH_REFUSAL);
});
