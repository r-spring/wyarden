// F95 (docs/agents/README.md): claim, claim-tree, request-takeover, handoff, actionable refusals, the
// audit record, the claim hold and the operator's terminal. The handoff's seven acceptance tests run on a real Board with the same
// VS Code stand-in as test/orchestrator-board.test.js; the rules' edges run on src/orchestrator.ts directly.
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
const terminals = [];
const vscode = { EventEmitter, ThemeIcon: class {}, TabInputCustom: class { constructor(uri) { this.uri = uri; } }, ViewColumn: { Beside: -2 },
  commands: { executeCommand: async () => {} },
  Uri: { from: (parts) => ({ ...parts, toString: () => `${parts.scheme}://${parts.authority}${parts.path}` }), file: (p) => ({ fsPath: p }) },
  workspace: { openTextDocument: async (o) => ({ content: o?.content }), getConfiguration: () => ({ get: (_k, d) => d }) },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined, showErrorMessage: async () => undefined, showInformationMessage: async () => undefined, showTextDocument: async () => undefined,
    createTerminal: (options) => { const t = { options, shows: [], sent: [], show: (p) => t.shows.push(p), dispose() { t.exitStatus = { code: 0 }; vscode.window.terminals = vscode.window.terminals.filter((x) => x !== t); }, exit(code = 0) { t.exitStatus = { code }; vscode.window.terminals = vscode.window.terminals.filter((x) => x !== t); }, sendText: (text) => t.sent.push(text), exitStatus: undefined, processId: Promise.resolve(4242) };
      terminals.push(t); vscode.window.terminals.push(t); return t; } } };
const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-takeover-home-"));
process.env.HOME = process.env.USERPROFILE = home;
process.env.ENTOMATICAL_USAGE_DIR = path.join(home, "usage");
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board } = require("../out/board.js");
const o = require("../out/orchestrator.js");
const op = require("../out/operator.js");

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const made = [], boards = [];
test.after(() => { for (const b of boards) b.dispose(); for (const d of made) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-takeover-"));
  made.push(repo);
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t"); sh(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  boards.push(board);
  board.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }];
  board.accountFolderList = () => [path.join(home, "acct")];
  board.preflightHeadless = async () => {};
  board.requestRateMs = 0;
  board.operatorTokenFile = path.join(repo, "operator-token");
  board.tick();
  const runEvents = [];
  board.onRun((e) => runEvents.push(e));
  return { repo, board, runEvents };
}
const event = (board, id, e) => fs.appendFileSync(board.eventsFile(id), JSON.stringify({ t: Date.now(), ...e }) + "\n");
const approved = { at: "x", hash: "h" };
const PLAN = { name: "parity", file: "workflows/parity.plan.json", review: "model" };
/** A root orchestrator with a live hidden run (its terminal stays open until settle). */
async function root(board, extra = {}) {
  const m = board.add("Root", "Run.", "acct", undefined, "haiku", "low", undefined, { orchestrator: { caps: { ...o.DEFAULT_CAPS }, opened: 0 }, headless: true, approved, ...extra });
  await board.startHeadless(m);
  event(board, m.id, { hook_event_name: "SessionStart", session_id: m.sessionId });
  board.update(m, { status: "running" }); // its first turn
  return m;
}
const settle = (board, task) => { terminals.find((t) => t.options.name === `En ${task.id}` && !t.exitStatus)?.exit(0); event(board, task.id, { hook_event_name: "Stop", last_assistant_message: "done" }); board.syncStatus(task.id); };
/** A finished run: its root Done, with no session left. */
function deadRoot(board, extra = {}) {
  const m = board.add("Old run", "Run.", "acct", undefined, "haiku", "low", undefined, { orchestrator: { caps: { ...o.DEFAULT_CAPS }, opened: 1 }, headless: true, approved, ...extra });
  board.update(m, { status: "done", sessionId: "old-root-session" });
  return m;
}
const card = (board, owner, title, extra = {}) => {
  const c = board.add(title, "p", "acct", owner.id, undefined, undefined, undefined, { openedBy: owner.id, watchedBy: owner.id, headless: true, ...extra });
  board.update(c, { status: "review", sessionId: `s-${c.id}` });
  event(board, c.id, { hook_event_name: "SessionStart", session_id: c.sessionId });
  return c;
};
async function request(board, body) {
  const inbox = path.join(board.dir, "inbox");
  const nonce = `n${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(path.join(inbox, `${nonce}.json`), JSON.stringify({ v: 1, at: "now", ...body }));
  await board.processInbox();
  for (let i = 0; i < 20 && !fs.existsSync(path.join(inbox, "done", `${nonce}.json`)); i++) await sleep(50);
  return JSON.parse(fs.readFileSync(path.join(inbox, "done", `${nonce}.json`), "utf8"));
}
const as = (caller) => (body) => ({ by: caller.id, session: caller.sessionId, ...body });
async function cli(board, repo, argv, env) {
  const tool = require("../tools/board.js");
  const out = [];
  const pump = setInterval(() => void board.processInbox(), 30);
  try { const code = await tool.main(argv, { cwd: repo, env: { ENTOMATICAL_REPO: repo, ...env }, write: (s) => out.push(s), home }); return { code, out: out.join("") }; }
  finally { clearInterval(pump); }
}
const transfers = (board) => fs.existsSync(board.transfersFile) ? fs.readFileSync(board.transfersFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

test("1: owner Done, target in Review, a plan-file root of the same plan file claims it; stop and cancel then work, and the move is recorded", async () => {
  const { repo, board } = fixture();
  const old = deadRoot(board, { planRun: PLAN });
  const leftover = card(board, old, "Research and inventory");
  const current = await root(board, { planRun: PLAN });
  const req = as(current);
  // Before: adopt is refused for a plan-file run, and its refusal names the claim that works.
  assert.match((await request(board, req({ op: "adopt", id: leftover.id }))).error, new RegExp(`^adopt: this run follows a plan file.*\\(F72\\)\\. You may \`board\\.js claim ${leftover.id} --reason "\\.\\.\\."\` instead\\.$`));
  assert.match((await request(board, req({ op: "stop", id: leftover.id }))).error, new RegExp(`^Card ${leftover.id} is controlled by ${old.id} \\(done just now\\)\\. You may \`board\\.js claim ${leftover.id} --reason "\\.\\.\\."\` \\(owner terminal, same plan file\\)\\.$`));
  const claimed = await request(board, req({ op: "claim", id: leftover.id, reason: "superseded by this run" }));
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assert.deepEqual([leftover.openedBy, leftover.watchedBy, leftover.parentId, leftover.sessionId], [current.id, current.id, current.id, `s-${leftover.id}`]);
  assert.ok(board.statusOf(leftover).chips.includes(`taken over by ${current.id}`));
  board.update(leftover, { status: "running" }); // resumed by its new controller
  assert.equal((await request(board, req({ op: "stop", id: leftover.id }))).ok, true);
  board.update(leftover, { status: "review" });
  assert.equal((await request(board, req({ op: "cancel", id: leftover.id }))).ok, true);
  assert.equal(leftover.cancelled, true);
  assert.ok(!board.statusOf(leftover).chips.includes("interrupted"), "a cancelled card is not interrupted work (the live check's stray needs-you toast)");
  const [record] = transfers(board);
  assert.deepEqual({ ...record, at: undefined }, { op: "takeover", via: "claim", id: leftover.id, from: old.id, to: current.id, by: current.id, reason: "superseded by this run", at: undefined });
  assert.equal(leftover.transfers.length, 1);
  // board.js shows and lists it.
  const env = { ENTOMATICAL_TASK: current.id, CLAUDE_CODE_SESSION_ID: current.sessionId };
  assert.match((await cli(board, repo, ["show", leftover.id], env)).out, new RegExp(`taken over: ${old.id} -> ${current.id} by ${current.id} \\(claim\\) at .*: superseded by this run`));
  assert.match((await cli(board, repo, ["events", leftover.id], env)).out, /"via":"claim"/);
});

test("2: a live owner: claim is refused with the request-takeover hint; the request reaches the user and the owner; Approve moves the card and wakes the requester", async () => {
  const { board, runEvents } = fixture();
  const owner = await root(board);
  const target = card(board, owner, "Live owner's card");
  const asker = await root(board);
  settle(board, asker);
  board.update(asker, { takenOver: true }); // keep its inbox for inspection: an idle headless root would be woken with it
  const req = as(asker);
  const refused = await request(board, req({ op: "claim", id: target.id, reason: "need it" }));
  assert.equal(refused.error, `Card ${target.id} is controlled by ${owner.id} (running). Ask with \`board.js request-takeover ${target.id} --reason "..."\` or message the owner (\`board.js send ${owner.id} --text "..."\`).`);
  const asked = await request(board, req({ op: "request-takeover", id: target.id, reason: "it duplicates my step" }));
  assert.equal(asked.ok, true, JSON.stringify(asked));
  assert.match(asked.note, new RegExp(`its owner ${owner.id} was told`));
  assert.equal(target.openedBy, owner.id, "nothing moves before the user answers");
  const notice = runEvents.find((e) => e.kind === "takeoverAsked");
  assert.deepEqual([notice.task.id, notice.by.id, notice.text], [target.id, asker.id, "it duplicates my step"]);
  assert.ok(board.statusOf(target).chips.includes(`takeover asked by ${asker.id}`));
  assert.deepEqual([o.runSummary(owner, board.tasks, () => 0).needsYou, o.runSummary(owner, board.tasks, () => 0).children[0].asked], [1, true], "the run row shows it as needing the user");
  assert.match(board.receiveMessages(owner.id).join("\n"), new RegExp(`board\\.js handoff ${target.id} --to ${asker.id}`));
  assert.match((await request(board, req({ op: "request-takeover", id: target.id, reason: "again" }))).error, /already asked/);
  assert.equal(board.approveTakeover(target.id, target.takeoverAsk), `Card ${target.id} is ${asker.id}'s now.`);
  assert.deepEqual([target.openedBy, target.takeoverAsk, target.transfers.at(-1).approvedBy, target.transfers.at(-1).via], [asker.id, undefined, "the user", "request"]);
  board.loadNotifications(true);
  assert.match(board.receiveMessages(asker.id).join("\n"), new RegExp(`Takeover granted by the user: you control card ${target.id}`));
  // Deny: the request goes and the asker is told.
  const other = card(board, owner, "Second");
  await request(board, req({ op: "request-takeover", id: other.id, reason: "x" }));
  // A window opened later shows the waiting request's Approve and Deny again.
  const seen = runEvents.length;
  assert.equal(board.announceTakeoverAsks(), 1);
  assert.deepEqual(runEvents.slice(seen).map((e) => [e.kind, e.task.id, e.by.id, e.text]), [["takeoverAsked", other.id, asker.id, "x"]]);
  assert.match(require("fs").readFileSync(require("path").join(__dirname, "..", "src", "extension.ts"), "utf8"), /board\.announceTakeoverAsks\(\)/);
  board.denyTakeover(other.id, other.takeoverAsk);
  assert.deepEqual([other.openedBy, other.takeoverAsk], [owner.id, undefined]);
  board.loadNotifications(true);
  assert.match(board.receiveMessages(asker.id).join("\n"), /the user denied your request/);
});

// Drive the emitted notification handler with deferred choices. All decisions still go through the fixture's Board.
function takeoverDialogs(t, board) {
  const dialogs = [], errors = [];
  t.mock.method(vscode.window, "showWarningMessage", (message, ...choices) =>
    new Promise(resolve => dialogs.push({ message, choices, resolve })));
  t.mock.method(vscode.window, "showErrorMessage", message => errors.push(message));
  const filename = require.resolve("../out/extension.js"), extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = name => name === "vscode" ? vscode : name.startsWith("./") ? {} : require(name);
  extension._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.notify = showTakeoverRequest;", filename);
  board.onRun(({ kind, task, by }) => {
    if (kind !== "takeoverAsked") return;
    const done = extension.exports.notify(board, task, by);
    dialogs.at(-1).done = done;
  });
  return { dialogs, errors };
}

for (const choice of ["Approve", "Deny"]) {
  test(`a stale ${choice} reports expiry and preserves the next ask; its own notification can still decide it`, async t => {
    const { board, repo } = fixture();
    const owner = await root(board), first = await root(board), next = await root(board);
    const target = card(board, owner, "Disputed card");
    const ask = (by, reason) => request(board, as(by)({ op: "request-takeover", id: target.id, reason }));
    const { dialogs, errors } = takeoverDialogs(t, board);
    assert.equal((await ask(first, "first reason")).ok, true);
    const original = { ...target.takeoverAsk };
    assert.ok(original.id);
    assert.equal(dialogs[0].message, `Entomatical: "${first.title}" (${first.id}) asks to take over "${target.title}" (${target.id}): first reason`);
    assert.deepEqual(dialogs[0].choices, ["Approve", "Deny", "Open"]);
    assert.match((await ask(next, "please")).error, /already has a takeover request/);
    assert.deepEqual(target.takeoverAsk, original);

    op.ensureOperatorToken(board.operatorTokenFile);
    const denied = await cli(board, repo, ["deny", target.id], { ENTOMATICAL_OPERATOR_TOKEN: op.readOperatorToken(board.operatorTokenFile) });
    assert.equal(denied.code, 0, denied.out);
    assert.equal((await ask(next, "second reason")).ok, true);
    const replacement = { ...target.takeoverAsk };
    assert.ok(replacement.id && replacement.id !== original.id);
    const stored = () => JSON.parse(fs.readFileSync(board.file, "utf8")).find(task => task.id === target.id);
    const before = stored();
    assert.deepEqual(before.takeoverAsk, replacement);
    dialogs[0].resolve(choice);
    await dialogs[0].done;
    assert.deepEqual(errors, [`Entomatical: The takeover request for card ${target.id} has expired.`]);
    assert.deepEqual(stored(), before);
    assert.deepEqual([target.openedBy, target.takeoverAsk, transfers(board)], [owner.id, replacement, []]);

    dialogs[1].resolve(choice);
    await dialogs[1].done;
    assert.deepEqual([target.openedBy, target.takeoverAsk, errors.length], [choice === "Approve" ? next.id : owner.id, undefined, 1]);
  });
}

test("re-announced legacy requests use the requester, timestamp and reason until settled", async t => {
  const { board } = fixture();
  const owner = await root(board), by = await root(board), target = card(board, owner, "Legacy");
  const legacy = { by: by.id, at: "2026-10-01T00:00:00.000Z", reason: "original reason" };
  board.update(target, { takeoverAsk: { ...legacy } });
  const { dialogs, errors } = takeoverDialogs(t, board);
  assert.equal(board.announceTakeoverAsks(), 1);
  Object.assign(target.takeoverAsk, { reason: "changed after display" });
  dialogs[0].resolve("Deny");
  await dialogs[0].done;
  assert.deepEqual(errors, [`Entomatical: The takeover request for card ${target.id} has expired.`]);
  assert.deepEqual([target.openedBy, target.takeoverAsk.reason], [owner.id, "changed after display"]);
  for (const change of [{ by: owner.id }, { at: "2026-10-02T00:00:00.000Z" }, { reason: "changed" }, { id: "new-id" }]) {
    const other = { ...legacy, ...change };
    board.update(target, { takeoverAsk: other });
    assert.throws(() => board.approveTakeover(target.id, legacy), /has expired/);
    assert.deepEqual([target.openedBy, target.takeoverAsk], [owner.id, other]);
  }
  // Identical text and time cannot make a fresh request match another ID.
  assert.throws(() => board.denyTakeover(target.id, { ...legacy, id: "earlier-id" }), /has expired/);
  // A reload can replace a matching legacy object before the user answers.
  board.update(target, { takeoverAsk: { ...legacy } });
  assert.equal(board.announceTakeoverAsks(), 1);
  board.update(target, { takeoverAsk: { ...legacy } });
  dialogs[1].resolve("Approve");
  await dialogs[1].done;
  assert.deepEqual([target.openedBy, target.takeoverAsk, errors.length], [by.id, undefined, 1]);
});

test("3: a plan-file run and a live unrelated run's card: claim and adopt are refused, adopt keeps its F72 reason, both name request-takeover", async () => {
  const { board } = fixture();
  const unrelated = await root(board);
  const theirs = card(board, unrelated, "Theirs");
  const mine = await root(board, { planRun: PLAN });
  const req = as(mine);
  assert.match((await request(board, req({ op: "claim", id: theirs.id, reason: "x" }))).error, new RegExp(`controlled by ${unrelated.id} \\(running\\)\\. Ask with \`board\\.js request-takeover ${theirs.id}`));
  assert.match((await request(board, req({ op: "adopt", id: theirs.id }))).error, new RegExp(`^adopt: this run follows a plan file, which lists every step \\(F72\\)\\. Ask with \`board\\.js request-takeover ${theirs.id} --reason "\\.\\.\\."\`, or message its owner\\.$`));
  assert.equal(theirs.openedBy, unrelated.id);
});

test("4: claim-tree on a Done root with one live descendant: the dead cards move, the live one and the card under it are listed and left alone", async () => {
  const { board } = fixture();
  const old = deadRoot(board);
  const a = card(board, old, "a"), b = card(board, old, "b"), live = card(board, old, "live"), under = card(board, live, "under live");
  board.update(a, { status: "queued", held: true, sessionId: undefined });
  const finished = card(board, old, "finished"); board.update(finished, { status: "done" });
  board.update(live, { status: "running" });
  const collector = await root(board);
  const result = await request(board, as(collector)({ op: "claim-tree", id: old.id, reason: "collect the leftovers" }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([[...result.moved].sort(), result.live, result.waiting], [[a.id, b.id].sort(), [live.id], [under.id]]);
  assert.deepEqual([a.openedBy, b.openedBy, live.openedBy, under.openedBy, finished.openedBy], [collector.id, collector.id, old.id, live.id, old.id]);
  assert.match(result.note, new RegExp(`${old.id} itself stays with the user`));
  assert.equal(a.held, undefined);
  assert.match(a.stepHold, new RegExp(`Control transferred to ${collector.id}`));
  assert.ok(!require("../out/queue.js").toStart(board.tasks, 0).includes(a), "claiming a queued card never dispatches it");
  assert.deepEqual(transfers(board).map((r) => [r.id, r.via]).sort(), [[a.id, "claim-tree"], [b.id, "claim-tree"]].sort());
  // The root's own refusal names claim-tree; a root that still runs is refused.
  const busy = await root(board), busyCard = card(board, busy, "c");
  assert.match((await request(board, as(collector)({ op: "claim-tree", id: busy.id, reason: "x" }))).error, new RegExp(`^Card ${busy.id} is running; claim-tree takes only a finished or idle run`));
  assert.equal(busyCard.openedBy, busy.id);
});

test("5: handoff self by the owner needs no approval and moves the verbs to the receiver", async () => {
  const { board } = fixture();
  const giver = await root(board), receiver = await root(board);
  const x = card(board, giver, "x"), y = card(board, giver, "y");
  const done = card(board, giver, "done one"); board.update(done, { status: "done" });
  const given = await request(board, as(giver)({ op: "handoff", self: true, to: receiver.id, reason: "I am finishing" }));
  assert.equal(given.ok, true, JSON.stringify(given));
  assert.deepEqual([x.openedBy, y.openedBy, done.openedBy], [receiver.id, receiver.id, giver.id]);
  assert.ok(board.statusOf(x).chips.includes(`handed to ${receiver.id}`));
  assert.equal((await request(board, as(receiver)({ op: "cancel", id: x.id }))).ok, true);
  assert.match((await request(board, as(giver)({ op: "cancel", id: y.id }))).error, new RegExp(`^Card ${y.id} is controlled by ${receiver.id} \\(running\\)`));
  assert.match(board.receiveMessages(receiver.id).join("\n"), new RegExp(`Handoff: card ${giver.id} \\(Root\\) gave you`));
  assert.deepEqual(transfers(board).map((r) => [r.op, r.via, r.by]), [["handoff", "handoff", giver.id], ["handoff", "handoff", giver.id]]);
  // A handoff to a card that cannot hold cards, or under the card itself, is refused.
  assert.equal((await request(board, as(receiver)({ op: "handoff", id: y.id, to: y.id }))).error, `handoff: card ${y.id} is not an orchestrator, so it cannot hold cards`);
  const coordinator = card(board, y, "coordinator under y", { orchestrator: { caps: { ...o.DEFAULT_CAPS }, opened: 0, root: receiver.id } });
  assert.equal((await request(board, as(receiver)({ op: "handoff", id: y.id, to: coordinator.id }))).error, `handoff: card ${coordinator.id} is under ${y.id}; that would create a cycle`);
});

test("6: the user's terminal: no ENTOMATICAL_TASK and a valid operator token stops a card; a wrong token reads as Missing by; a card's session cannot sign", async () => {
  const { repo, board } = fixture();
  op.ensureOperatorToken(board.operatorTokenFile);
  const token = op.readOperatorToken(board.operatorTokenFile);
  assert.match(token, /^[0-9a-f]{64}$/);
  op.ensureOperatorToken(board.operatorTokenFile);
  assert.equal(op.readOperatorToken(board.operatorTokenFile), token, "a second window keeps the token");
  const owner = await root(board);
  const running = card(board, owner, "running"); board.update(running, { status: "running" });
  const stopped = [];
  board.stop = (t) => stopped.push(t.id);
  const ok = await cli(board, repo, ["stop", running.id], { ENTOMATICAL_OPERATOR_TOKEN: token });
  assert.deepEqual([ok.code, ok.out, stopped], [0, `${running.id}  Stopped ${running.id}.\n`, [running.id]]);
  const wrong = await cli(board, repo, ["stop", running.id], { ENTOMATICAL_OPERATOR_TOKEN: "0".repeat(64) });
  assert.deepEqual([wrong.code, wrong.out], [1, "refused: Missing by: run this from a task session (ENTOMATICAL_TASK)\n"]);
  const none = await cli(board, repo, ["stop", running.id], {});
  assert.equal(none.out, "refused: Missing by: run this from a task session (ENTOMATICAL_TASK)\n");
  const unresolved = { ENTOMATICAL_OPERATOR_TOKEN: token, CODEX_THREAD_ID: "editor-thread" };
  for (const duplicate of [false, true]) {
    if (duplicate) {
      for (const title of ["First editor", "Second editor"]) board.update(board.add(title, "p"), { provider: "codex", codexEditor: true, sessionId: unresolved.CODEX_THREAD_ID });
    }
    assert.match((await cli(board, repo, ["stop", running.id], unresolved)).out, /refused: Missing by/);
    await assert.rejects(cli(board, repo, ["stop", running.id, "--operator"], unresolved), /--operator is for the user's own terminal/);
    assert.deepEqual(stopped, [running.id], "only the operator terminal stopped the card");
  }
  await assert.rejects(cli(board, repo, ["stop", running.id, "--operator"], { ENTOMATICAL_TASK: owner.id }), /--operator is for the user's own terminal/);
  await assert.rejects(cli(board, repo, ["add", "--title", "t", "--prompt", "p"], { ENTOMATICAL_OPERATOR_TOKEN: token }), /From the user's terminal: stop, resume/);
  // The inbox answer keeps the signature, never the token; a replayed file under another nonce is refused.
  const done = fs.readdirSync(path.join(board.dir, "inbox", "done")).map((f) => fs.readFileSync(path.join(board.dir, "inbox", "done", f), "utf8"));
  assert.ok(done.length && done.every((t) => !t.includes(token)));
  const signed = JSON.parse(done.find((t) => t.includes('"ok":true')));
  delete signed.ok; delete signed.note;
  assert.equal(op.verifyOperator(signed, "another-nonce", token), false);
  // Approve and deny from the terminal; handoff to an orchestrator.
  const asker = await root(board);
  await request(board, as(asker)({ op: "request-takeover", id: running.id, reason: "please" }));
  await assert.rejects(cli(board, repo, ["approve", running.id, "--operator"], {}), /No operator token at ~\/\.entomatical\/operator-token/, "--operator reads the home folder's token, which this test never made");
  const approve2 = await cli(board, repo, ["approve", running.id], { ENTOMATICAL_OPERATOR_TOKEN: token });
  assert.deepEqual([approve2.code, running.openedBy], [0, asker.id], approve2.out);
  const back = await cli(board, repo, ["handoff", running.id, "--to", owner.id, "--reason", "back"], { ENTOMATICAL_OPERATOR_TOKEN: token });
  assert.deepEqual([back.code, running.openedBy, running.transfers.at(-1).via], [0, owner.id, "operator"], back.out);
  await assert.rejects(cli(board, repo, ["approve", running.id], { ENTOMATICAL_TASK: owner.id }), /approve answers a takeover request and is the user's/);
});

test("6b: the user's terminal send to a hidden card of a paused run reports Run paused, not Sent", async () => {
  const { repo, board } = fixture();
  op.ensureOperatorToken(board.operatorTokenFile);
  const token = op.readOperatorToken(board.operatorTokenFile);
  const owner = await root(board);
  const idle = card(board, owner, "idle");
  board.update(idle, { worktree: repo });
  board.update(owner, { paused: true });
  const sent = await cli(board, repo, ["send", idle.id, "--text", "more"], { ENTOMATICAL_OPERATOR_TOKEN: token });
  assert.deepEqual([sent.code, sent.out], [1, "refused: Run paused\n"]);
});

test("6c: the user's terminal resume sends \"Resume.\" as the card's button does; a hidden card gets the interrupted nudge; a running or never-started card is refused", async () => {
  const { repo, board } = fixture();
  op.ensureOperatorToken(board.operatorTokenFile);
  const env = { ENTOMATICAL_OPERATOR_TOKEN: op.readOperatorToken(board.operatorTokenFile) };
  const named = (t) => terminals.filter((x) => x.options.name === `En ${t.id}`);
  // A card of the user's own, cut off by a window reload: Review, Interrupted, its session gone.
  const plain = board.add("Plain", "p", "acct");
  board.update(plain, { status: "review", interrupted: true, sessionId: "plain-session", worktree: repo });
  event(board, plain.id, { hook_event_name: "SessionStart", session_id: plain.sessionId });
  const resumed = await cli(board, repo, ["resume", plain.id], env);
  assert.deepEqual([resumed.code, resumed.out], [0, `${plain.id}  Resumed ${plain.id}.\n`]);
  const [term] = named(plain);
  assert.equal(named(plain).length, 1);
  assert.deepEqual(term.options.shellArgs.slice(0, 2), ["--resume", "plain-session"]);
  assert.deepEqual(term.options.shellArgs.slice(-2), ["--", "Resume."], "the session's next message, not an idle prompt");
  // One whose session never came up: "Resume." must not become the first prompt of an empty conversation.
  const unstarted = board.add("Unstarted", "p", "acct");
  board.update(unstarted, { status: "review", sessionId: "never-started", worktree: repo, cancelled: true });
  const refused = await cli(board, repo, ["resume", unstarted.id], env);
  assert.deepEqual([refused.code, refused.out], [1, "refused: Not started: its session never came up. Press Start on the card.\n"]);
  assert.deepEqual([named(unstarted).length, unstarted.cancelled], [0, true], "nothing launched or changed");
  // A hidden card of a run keeps its own path, and a running card is left alone.
  const owner = await root(board);
  const hidden = card(board, owner, "hidden", { worktree: repo });
  board.update(hidden, { interrupted: true });
  const nudged = [];
  board.followUpHeadless = async (t, text) => { nudged.push([t.id, text]); };
  const hid = await cli(board, repo, ["resume", hidden.id], env);
  assert.deepEqual([hid.code, nudged], [0, [[hidden.id, o.INTERRUPTED_NUDGE]]], hid.out);
  board.update(plain, { status: "running" });
  const busy = await cli(board, repo, ["resume", plain.id], env);
  assert.deepEqual([busy.code, busy.out, named(plain).length], [1, "refused: busy: it is running\n", 1]);
});

test("7: two collectors claim the same orphan within the hour: the second is told who holds it, even after the first has finished", async () => {
  const { board } = fixture();
  const old = deadRoot(board);
  const orphan = card(board, old, "orphan");
  const first = await root(board), second = await root(board);
  assert.equal((await request(board, as(first)({ op: "claim", id: orphan.id, reason: "mine" }))).ok, true);
  const refused = (await request(board, as(second)({ op: "claim", id: orphan.id, reason: "mine too" }))).error;
  assert.match(refused, new RegExp(`^Card ${orphan.id} was claimed by ${first.id} at \\d\\d:\\d\\d UTC; it stays with ${first.id} for an hour`));
  board.update(first, { status: "done" });
  assert.match((await request(board, as(second)({ op: "claim", id: orphan.id, reason: "mine too" }))).error, new RegExp(`was claimed by ${first.id}`));
  assert.equal(orphan.openedBy, first.id);
});

// ---- the rules on their own ----
const caps = { ...o.DEFAULT_CAPS };
const T = (id, extra = {}) => ({ id, title: `Card ${id}`, prompt: "p", status: "review", createdAt: "2026-11-08T10:00:00Z", updatedAt: "2026-11-08T10:00:00Z", statusAt: "2026-11-08T10:00:00Z", ...extra });
const NOW = Date.parse("2026-11-08T10:20:00Z"); // 20 minutes after the cards' last change
const ctx = (extra = {}) => ({ enabled: true, now: 1, wallNow: NOW, lastRequestAt: new Map(), unprocessed: () => 0, capsOf: (r) => r.orchestrator?.caps ?? caps,
  accountSignedIn: () => true, accountUsage: () => undefined, models: [], efforts: [], permissions: [], ...extra });
const me = (extra = {}) => T("aaaaaa", { orchestrator: { caps, opened: 0 }, sessionId: "s-a", approved, status: "running", ...extra });
const claim = (id, extra = {}) => ({ v: 1, op: "claim", by: "aaaaaa", session: "s-a", at: "now", nonce: "n", id, reason: "r", ...extra });

test("claim waits 30 minutes for a holder in Review (configurable), none for one of the same plan file or a Done one; the user's cards and run roots", () => {
  const holder = T("bbbbbb", { orchestrator: { caps, opened: 1 }, sessionId: "s-b" }), target = T("cccccc", { openedBy: "bbbbbb", watchedBy: "bbbbbb" });
  const tasks = [me(), holder, target];
  assert.match(o.refusal(claim("cccccc"), tasks, ctx()), /^Card cccccc is controlled by bbbbbb \(review, idle since 20 min ago\)\. Ask with/);
  assert.equal(o.refusal(claim("cccccc"), tasks, ctx({ claimGraceMs: 10 * 60_000 })), undefined);
  assert.equal(o.refusal(claim("cccccc"), tasks, ctx({ wallNow: NOW + 11 * 60_000 })), undefined, "31 minutes idle");
  assert.match(o.refusal(claim("cccccc"), tasks, ctx({ wallNow: NOW + 11 * 60_000, idleSince: () => NOW - 60_000 })), /idle since 12 min ago/, "recent activity counts, not only the column change");
  const samePlan = [me({ planRun: PLAN }), { ...holder, planRun: PLAN }, target];
  assert.equal(o.refusal(claim("cccccc"), samePlan, ctx()), undefined, "an earlier run of the same plan file: no wait");
  assert.equal(o.refusal(claim("cccccc"), [me(), { ...holder, status: "done" }, target], ctx()), undefined);
  assert.match(o.refusal(claim("cccccc"), [me(), holder, target], ctx({ live: (t) => t.id === "bbbbbb", wallNow: NOW + 3_600_000 })), /controlled by bbbbbb \(review, session live\)/);
  assert.match(o.refusal(claim("cccccc"), [me(), { ...holder, status: "done" }, { ...target, takenOver: true }], ctx()), /^the user took card cccccc over himself/);
  assert.match(o.refusal(claim("cccccc"), [me(), { ...holder, status: "done" }, { ...target, status: "running" }], ctx()), /has a live session \(running\); claim never moves a live session/);
  // A holder further up the chain still running holds the card too.
  const mid = T("dddddd", { openedBy: "bbbbbb", status: "done" }), deep = T("eeeeee", { openedBy: "dddddd" });
  assert.match(o.refusal(claim("eeeeee"), [me(), { ...holder, status: "running" }, mid, deep], ctx()), /controlled by bbbbbb \(running\)/);
  assert.match(o.refusal(claim("bbbbbb"), tasks, ctx()), /^claim: card bbbbbb is a run's root; `board\.js claim-tree bbbbbb/);
  assert.match(o.refusal(claim("ffffff"), [...tasks, T("ffffff")], ctx()), /^Card ffffff is the user's: no orchestrator opened it\. Adopt it \(`board\.js adopt ffffff`\), or ask with `board\.js request-takeover ffffff/);
  assert.match(o.refusal(claim("ffffff"), [me({ planRun: PLAN }), holder, target, T("ffffff")], ctx()), /^Card ffffff is the user's: no orchestrator opened it\. Ask with/);
});

test("claim: only the root, unless the approved caps carry mayClaim 1; never a cycle; validation and capsFrom", () => {
  const sub = T("dddddd", { orchestrator: { caps, opened: 0, root: "aaaaaa" }, openedBy: "aaaaaa", sessionId: "s-d", approved });
  const target = T("cccccc", { openedBy: "bbbbbb" });
  const tasks = (rootCaps) => [me({ orchestrator: { caps: rootCaps, opened: 1 } }), sub, T("bbbbbb", { status: "done", orchestrator: { caps, opened: 1 } }), target];
  const bySub = claim("cccccc", { by: "dddddd", session: "s-d" });
  assert.match(o.refusal(bySub, tasks(caps), ctx()), /^claim: only the run's root may claim, or a coordinator whose approved plan has mayClaim 1/);
  assert.equal(o.refusal(bySub, tasks({ ...caps, mayClaim: 1 }), ctx()), undefined);
  assert.match(o.refusal(claim("aaaaaa", { by: "dddddd", session: "s-d" }), tasks({ ...caps, mayClaim: 1 }), ctx()), /already yours|cycle|assigned to ancestor|run's root/);
  assert.deepEqual(o.capsFrom({ mayClaim: 1 }).mayClaim, 1);
  assert.equal(o.capsFrom({ mayClaim: 0 }).mayClaim, undefined);
  assert.match(o.validateRequest({ v: 1, op: "plan", by: "aaaaaa", caps: { mayClaim: 2 } }, "n").error, /mayClaim must be 0 or 1/);
  assert.equal(o.validateRequest({ v: 1, op: "claim", by: "aaaaaa", id: "cccccc" }, "n").error, "claim needs reason");
  assert.equal(o.validateRequest({ v: 1, op: "handoff", by: "aaaaaa", id: "cccccc", self: true, to: "bbbbbb" }, "n").error, "handoff takes a card id or self, not both");
  assert.deepEqual(o.validateRequest({ v: 1, op: "handoff", by: "aaaaaa", at: "t", self: true, to: "bbbbbb", reason: " r " }, "n").request, { v: 1, op: "handoff", by: "aaaaaa", session: null, at: "t", nonce: "n", self: true, to: "bbbbbb", reason: "r" });
});

test("operator signatures: the HMAC covers the nonce and the whole body, and expires", () => {
  const token = "ab".repeat(32), at = new Date(NOW).toISOString();
  const body = { v: 1, by: "operator", session: null, at, op: "stop", id: "cccccc" };
  const signed = { ...body, mac: op.operatorMac(token, "nonce-1", body) };
  assert.equal(op.verifyOperator(signed, "nonce-1", token, NOW), true);
  assert.equal(op.verifyOperator(signed, "nonce-2", token, NOW), false);
  assert.equal(op.verifyOperator({ ...signed, id: "dddddd" }, "nonce-1", token, NOW), false);
  assert.equal(op.verifyOperator(signed, "nonce-1", "cd".repeat(32), NOW), false);
  assert.equal(op.verifyOperator(signed, "nonce-1", token, NOW + 6 * 60_000), false);
  assert.equal(op.verifyOperator(signed, "nonce-1", undefined, NOW), false);
  assert.match(op.validateOperatorRequest({ op: "discard", id: "cccccc" }).error, /Discard and Finish stay on the card/);
});
