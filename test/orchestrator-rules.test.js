// src/orchestrator.ts: the request schema, every refusal of spec section 8 (F69), the plan summary, settle notices, account headroom
// and the headless command line (F71, F76). Pure: no board, no files.
const test = require("node:test");
const assert = require("node:assert/strict");
const o = require("../out/orchestrator.js");

const caps = { ...o.DEFAULT_CAPS, total: 12, depth: 2 };
const T = (id, extra = {}) => ({ id, title: `Card ${id}`, prompt: "p", status: "review", createdAt: "2026-11-04T10:00:00Z", updatedAt: "2026-11-04T10:00:00Z", ...extra });
const master = (extra = {}) => T("aaaaaa", { orchestrator: { caps, opened: 0 }, sessionId: "sess-a", approved: { at: "x", hash: "h" }, ...extra });
const child = (id, extra = {}) => T(id, { openedBy: "aaaaaa", watchedBy: "aaaaaa", headless: true, sessionId: `sess-${id}`, ...extra });
const ctx = (extra = {}) => ({ enabled: true, now: 1_000_000, lastRequestAt: new Map(), unprocessed: () => 0, capsOf: (root) => root.orchestrator?.caps ?? caps, catalogue: undefined,
  accountSignedIn: (n) => n === "acct", accountUsage: () => undefined, models: ["opus", "sonnet", "haiku", "fable"], efforts: ["low", "medium", "high", "xhigh", "max"], permissions: ["ask", "edits", "auto", "bypass"], ...extra });
const add = (extra = {}) => ({ v: 1, op: "add", by: "aaaaaa", session: "sess-a", at: "now", nonce: "n1", title: "t", prompt: "p", parent: null, account: null, model: null, effort: null, permission: null, completion: null, autoRule: false, after: [], start: "auto", mayOpen: false, ...extra });
const req = (op, extra = {}) => ({ v: 1, op, by: "aaaaaa", session: "sess-a", at: "now", nonce: "n1", ...extra });

test("new orchestration schema preserves runtime and approved scope proposals", () => {
  const parsed = o.validateRequest(add({ runtime: "codex", model: "gpt-6.1-sol" }), "n");
  assert.equal(parsed.request.runtime, "codex");
  assert.equal(parsed.request.model, "gpt-6.1-sol");
  assert.equal(o.normalizeModel("claude-fable-5-1"), "fable");
  const proposal = { caps: { total: 600, depth: 4 }, policy: { allow: ["read-anywhere"], deny: ["email"], noSync: true } };
  assert.deepEqual(o.validateRequest(req("plan", proposal), "n").request.policy, proposal.policy);
  assert.match(o.validateRequest(req("plan", { caps: { depth: 9 } }), "n").error, /depth/);
  assert.match(o.validateRequest(add({ runtime: "invalid" }), "n").error, /runtime/);
});

test("completion never credits an unstarted or interrupted card, and adoption cannot form a cycle", () => {
  const tasks = [master(), child("bbbbbb", { sessionId: undefined }), child("cccccc", { interrupted: true })];
  assert.match(o.refusal(req("done", { id: "bbbbbb" }), tasks, ctx()), /Never started/);
  assert.match(o.refusal(req("done", { id: "cccccc" }), tasks, ctx()), /Interrupted/);
  assert.match(o.refusal(req("adopt", { id: "aaaaaa" }), tasks, ctx()), /cycle/);
  assert.equal(o.refusal(req("send", { by: "cccccc", session: "sess-cccccc", id: "aaaaaa", text: "status" }), tasks, ctx()), undefined);
  assert.match(o.refusal(req("ready"), tasks, ctx()), /Descendants/);
  tasks[1].cancelled = tasks[2].cancelled = true;
  assert.equal(o.refusal(req("ready"), tasks, ctx()), undefined);
  assert.deepEqual([o.runSummary(tasks[0], tasks, () => 0).done, o.runSummary(tasks[0], tasks, () => 0).cancelled], [0, 2]);
});

test("an orchestrator adopts an ACP card or a subtree containing one, except one open in its provider's own terminal", () => {
  for (const provider of ["grok", "antigravity"]) for (const status of ["review", "running"]) {
    const direct = T("bbbbbb", { provider, status });
    assert.equal(o.refusal(req("adopt", { id: direct.id }), [master(), direct], ctx()), undefined);
    const parent = T("cccccc"), nested = T("dddddd", { provider, status, openedBy: parent.id });
    assert.equal(o.refusal(req("adopt", { id: parent.id }), [master(), parent, nested], ctx()), undefined);
    const open = T("eeeeee", { provider, status, cardTerminalStarted: true }), live = ctx({ live: (t) => t.id === open.id });
    const name = provider === "grok" ? "Grok" : "Antigravity";
    assert.equal(o.refusal(req("adopt", { id: open.id }), [master(), open], ctx()), undefined, "an exited terminal card may be adopted");
    assert.equal(o.refusal(req("adopt", { id: open.id }), [master(), open], live), `Card eeeeee is open in ${name}'s own terminal; stop it first, as an adopted card runs unattended over ACP`);
    const holder = T("ffffff"), inner = { ...open, openedBy: holder.id };
    assert.match(o.refusal(req("adopt", { id: holder.id }), [master(), holder, inner], live), /Card eeeeee is open in/);
  }
});

test("CORE-GOV-02: adopt refuses a card the user took over, or one holding such a card; ordinary adoption still works", () => {
  const hint = (id) => `Ask with \`board.js request-takeover ${id} --reason "..."\``;
  const operatorTaken = T("bbbbbb", { takenOver: true });
  assert.equal(o.refusal(req("adopt", { id: "bbbbbb" }), [master(), operatorTaken], ctx()), `adopt: the user took card bbbbbb over himself; it stays his. ${hint("bbbbbb")}.`);
  const parent = T("cccccc"), takenChild = T("dddddd", { openedBy: "cccccc", takenOver: true });
  assert.equal(o.refusal(req("adopt", { id: "cccccc" }), [master(), parent, takenChild], ctx()), `adopt: the user took card dddddd under cccccc over himself; it stays his. ${hint("cccccc")}.`);
  const ownTaken = child("eeeeee", { takenOver: true });
  assert.match(o.refusal(req("adopt", { id: "eeeeee" }), [master(), ownTaken], ctx()), /^adopt: the user took card eeeeee over himself/);
  // Ordinary adoption: a live card of another run, a card of the user's own, and the caller's own descendant.
  const otherRoot = T("ffffff", { orchestrator: { caps, opened: 1 }, sessionId: "sess-f", approved: { at: "x", hash: "h" } });
  const otherLive = T("gggggg", { openedBy: "ffffff", watchedBy: "ffffff", status: "running", sessionId: "sess-g" });
  const tasks = [master(), otherRoot, otherLive, T("hhhhhh"), child("iiiiii"), T("jjjjjj", { openedBy: "iiiiii" })];
  const live = ctx({ live: (t) => t.id === "gggggg" });
  for (const id of ["gggggg", "hhhhhh", "iiiiii", "jjjjjj"]) assert.equal(o.refusal(req("adopt", { id }), tasks, live), undefined, id);
});

test("a sub-orchestrator cannot reclaim a card assigned to its ancestor", () => {
  const coordinator = child("bbbbbb", { orchestrator: { caps, root: "aaaaaa", opened: 1 } });
  const assigned = child("cccccc");
  const tasks = [master(), coordinator, assigned];
  const byCoordinator = (op) => req(op, { by: coordinator.id, session: coordinator.sessionId, id: assigned.id });
  assert.match(o.refusal(byCoordinator("adopt"), tasks, ctx()), /assigned to ancestor aaaaaa/);
  assert.match(o.refusal(byCoordinator("done"), tasks, ctx()), /^Card cccccc is controlled by aaaaaa \(.*\)\. Ask with `board\.js request-takeover cccccc --reason "\.\.\."` or message the owner/);
  assert.equal(o.refusal(byCoordinator("send"), tasks, ctx()), undefined);
  assert.equal(o.refusal(req("adopt", { id: assigned.id }), tasks, ctx()), undefined);
});

test("validateRequest: the fixed schema, unknown fields, caps and enums", () => {
  const ok = o.validateRequest({ v: 1, op: "add", by: "aaaaaa", session: "s", at: "now", title: " T ", prompt: "P", after: ["bbbbbb"], start: "manual", mayOpen: true, completion: { commands: ["npm test"], doneWhen: "d" } }, "n");
  assert.deepEqual(ok.request, { v: 1, op: "add", by: "aaaaaa", session: "s", at: "now", nonce: "n", title: "T", prompt: "P", parent: null, account: null, model: null, effort: null, permission: null, completion: { commands: ["npm test"], doneWhen: "d" }, autoRule: false, after: ["bbbbbb"], start: "manual", mayOpen: true });
  const bad = (raw) => o.validateRequest(raw, "n").error;
  assert.equal(bad(null), "Not a request object");
  assert.equal(bad({ v: 2, op: "add", by: "aaaaaa" }), "Unknown request version");
  assert.equal(bad({ v: 1, op: "merge", by: "aaaaaa" }), "Unknown op merge");
  assert.equal(bad({ v: 1, op: "add", by: "" }), "Missing by: run this from a task session (ENTOMATICAL_TASK)");
  assert.equal(bad({ v: 1, op: "add", by: "aaaaaa", title: "t", prompt: "p", top: true }), 'Unknown field "top" for add');
  assert.equal(bad({ v: 1, op: "add", by: "aaaaaa", title: "t" }), "add needs prompt");
  assert.equal(bad({ v: 1, op: "add", by: "aaaaaa", title: "t", prompt: "x".repeat(24_001) }), "prompt is longer than 24000 characters");
  assert.equal(bad({ v: 1, op: "add", by: "aaaaaa", title: "t", prompt: "p", start: "later" }), "start must be auto or manual");
  assert.equal(bad({ v: 1, op: "add", by: "aaaaaa", title: "t", prompt: "p", after: ["nope"] }), "after must be a list of card ids");
  assert.equal(bad({ v: 1, op: "add", by: "aaaaaa", title: "t", prompt: "p", completion: { commands: "npm test" } }), "completion needs commands: up to ten strings");
  assert.equal(bad({ v: 1, op: "send", by: "aaaaaa", id: "bbbbbb" }), "send needs text");
  assert.equal(bad({ v: 1, op: "send", by: "aaaaaa", id: "zz", text: "t" }), "id is not a card id");
  assert.equal(bad({ v: 1, op: "note", by: "aaaaaa", text: "  " }), "note needs text");
  assert.equal(bad({ v: 1, op: "plan", by: "aaaaaa", id: "bbbbbb" }), 'Unknown field "id" for plan');
  assert.equal(o.validateRequest({ v: 1, op: "plan", by: "aaaaaa" }, "n").request.op, "plan");
});

test("refusals in order: disabled, not an orchestrator, session binding, rate, unprocessed", () => {
  const tasks = [master(), T("cccccc")];
  assert.equal(o.refusal(add(), tasks, ctx({ enabled: false })), "Orchestrator disabled (entomatical.orchestrator.enabled is off)");
  assert.equal(o.refusal(add({ by: "cccccc" }), tasks, ctx()), "Not an orchestrator");
  assert.equal(o.refusal(add({ by: "dddddd" }), tasks, ctx()), "Not an orchestrator");
  assert.match(o.refusal(add({ session: "other" }), tasks, ctx()), /^Not bound: session other is not this card's controller/);
  // The d60bfd controller fix also applies to messages and ordinary child cards.
  for (const r of [add({ session: null }), req("stop", { id: "bbbbbb", session: null }), req("note", { text: "x", session: null }), req("plan", { session: null }), req("receive", { by: "bbbbbb", session: null })])
    assert.match(o.refusal(r, [...tasks, child("bbbbbb", { status: "running" })], ctx()), /^Not bound: the request names no session/);
  assert.equal(o.refusal(add(), [master({ sessionId: undefined })], ctx()), "Not bound: the card has no session yet");
  assert.equal(o.refusal(add(), tasks, ctx({ lastRequestAt: new Map([["aaaaaa", 999_500]]) })), "Rate: at most one request per second");
  assert.equal(o.refusal(add(), tasks, ctx({ lastRequestAt: new Map([["aaaaaa", 998_000]]) })), undefined);
  assert.equal(o.refusal(add(), tasks, ctx({ rateMs: 0, lastRequestAt: new Map([["aaaaaa", 1_000_001]]) })), undefined);
  assert.equal(o.refusal(add(), tasks, ctx({ unprocessed: () => 21 })), "Rate: more than 20 requests waiting");
});

test("add: paused, not approved, parent, open and total caps, depth and may-open, account, points, model, effort, permission, after, catalogue", () => {
  assert.equal(o.refusal(add(), [master({ paused: true })], ctx()), "Run paused");
  assert.equal(o.refusal(add(), [master({ approved: undefined })], ctx()), "Plan not approved");
  assert.equal(o.refusal(add({ parent: "bbbbbb" }), [master(), child("bbbbbb")], ctx()), "add: the parent must be your own card (subtasks only in this version)");
  assert.equal(o.refusal(add({ parent: "aaaaaa" }), [master()], ctx()), undefined);
  const four = [master({ orchestrator: { caps, opened: 4 } }), child("b00001"), child("b00002"), child("b00003"), child("b00004", { status: "running" })];
  assert.equal(o.refusal(add(), four, ctx()), "open cap (4)");
  four[1].status = "done";
  assert.equal(o.refusal(add(), four, ctx()), undefined, "a Done child frees its slot");
  assert.equal(o.refusal(add(), [master({ orchestrator: { caps, opened: 12 } })], ctx()), "total cap (12)");
  assert.equal(o.refusal(add(), [master({ orchestrator: { caps: { ...caps, open: 1 }, opened: 0 } }), child("b00001")], ctx()), "open cap (1)");
  // A --may-open child (depth 1) may open grandchildren (depth 2) but not with --may-open; a grandchild may not open at all.
  const grand = [master(), child("b00001", { orchestrator: { caps, opened: 0, root: "aaaaaa" } }), T("c00001", { openedBy: "b00001", watchedBy: "b00001", sessionId: "sess-c00001", orchestrator: { caps, opened: 0, root: "aaaaaa" } })];
  assert.equal(o.refusal(add({ by: "b00001", session: "sess-b00001" }), grand, ctx()), undefined);
  assert.equal(o.refusal(add({ by: "b00001", session: "sess-b00001", mayOpen: true }), grand, ctx()), "may-open: a card at depth 2 may not open cards (depth cap 2)");
  assert.equal(o.refusal(add({ by: "c00001", session: "sess-c00001" }), grand, ctx()), "depth cap (2)");
  assert.match(o.refusal(add({ by: "b00001", session: "sess-a" }), grand, ctx()), /^Not bound: session sess-a is not this card's controller/, "the master's session cannot act as its coordinator");
  assert.equal(o.refusal(add({ mayOpen: true }), [master()], ctx()), undefined);
  assert.equal(o.refusal(add({ account: "nobody" }), [master()], ctx()), "Account not signed in: nobody");
  assert.equal(o.refusal(add({ account: "acct" }), [master({ orchestrator: { caps: { ...caps, pointsFiveHour: 40 }, opened: 0 } })], ctx({ accountUsage: () => ({ fiveHour: 41 }) })), "pointsFiveHour cap (40): the account has used 41");
  assert.equal(o.refusal(add({ account: "acct" }), [master({ orchestrator: { caps: { ...caps, pointsFiveHour: 40 }, opened: 0 } })], ctx({ accountUsage: () => ({ fiveHour: 39 }) })), undefined);
  assert.match(o.refusal(add({ account: "acct" }), [master({ orchestrator: { caps: { ...caps, pointsFiveHour: 40 }, opened: 0 } })], ctx({ accountUsage: () => ({ week: 10, quotaCoverage: "weekly-only" }) })), /five-hour usage is unknown/);
  assert.equal(o.refusal(add({ model: "gpt" }), [master()], ctx()), "Unknown model gpt. Valid models: opus, sonnet, haiku, fable");
  assert.equal(o.refusal(add({ effort: "ultra" }), [master()], ctx()), "Unknown effort ultra. Valid efforts: low, medium, high, xhigh, max");
  assert.equal(o.refusal(add({ permission: "root" }), [master()], ctx()), "Unknown permission root. Valid permissions: ask, edits, auto, bypass");
  assert.equal(o.refusal(add({ after: ["ffffff"] }), [master()], ctx()), "after: no card ffffff");
  assert.equal(o.refusal(add({ after: ["bbbbbb"] }), [master(), child("bbbbbb")], ctx()), undefined);
  const catalogue = { "npm-test": { run: "npm test" } };
  assert.equal(o.refusal(add({ completion: { commands: ["npm test", "rm -rf x"] } }), [master()], ctx({ catalogue })), "Check not in workflows/checks.json: rm -rf x");
  assert.equal(o.refusal(add({ completion: { commands: ["npm test"] } }), [master()], ctx({ catalogue })), undefined);
  assert.equal(o.refusal(add({ completion: { commands: ["anything"] } }), [master()], ctx({ catalogue: undefined })), undefined, "no catalogue: nothing is limited");
});

test("send, resume, stop, done, plan: ownership, taken over, busy, the follow-up cap, and the master-only plan", () => {
  const tasks = [master(), child("bbbbbb"), child("cccccc", { openedBy: "zzzzzz", watchedBy: "zzzzzz" }), child("dddddd", { status: "running" }), child("eeeeee", { takenOver: true }),
    child("ffffff", { followUps: 3 }), child("a00001", { status: "needs-input" }), child("a00002", { status: "queued", sessionId: undefined }), child("a00003", { status: "done" })];
  const send = (id, extra = {}) => o.refusal(req("send", { id, text: "t", ...extra }), tasks, ctx());
  assert.equal(send("bbbbbb"), undefined);
  assert.equal(send("cccccc"), undefined);
  assert.equal(send("999999"), "No card 999999");
  assert.equal(send("dddddd"), undefined);
  assert.equal(send("eeeeee"), undefined);
  assert.equal(send("ffffff"), undefined);
  assert.equal(send("a00001"), undefined);
  assert.equal(send("a00002"), undefined);
  assert.equal(send("a00003"), undefined);
  assert.equal(o.refusal(req("resume", { id: "dddddd" }), tasks, ctx()), "busy");
  assert.equal(o.refusal(req("resume", { id: "eeeeee" }), tasks, ctx()), "taken over");
  assert.equal(o.refusal(req("resume", { id: "a00002" }), tasks, ctx()), undefined);
  assert.equal(o.refusal(req("resume", { id: "bbbbbb" }), tasks, ctx()), undefined);
  assert.equal(o.refusal(req("stop", { id: "bbbbbb" }), tasks, ctx()), "not running");
  assert.equal(o.refusal(req("stop", { id: "dddddd" }), tasks, ctx()), undefined);
  assert.equal(o.refusal(req("stop", { id: "bbbbbb" }), tasks, ctx({ live: (t) => t.id === "bbbbbb" })), undefined);
  assert.equal(o.refusal(req("stop", { id: "a00002" }), tasks, ctx()), "not running (never started: no process to stop)");
  assert.equal(o.refusal(req("done", { id: "a00003" }), tasks, ctx()), "done");
  assert.equal(o.refusal(req("done", { id: "bbbbbb" }), tasks, ctx()), undefined);
  assert.equal(o.refusal(req("note", { text: "hi" }), tasks, ctx()), undefined);
  assert.equal(o.refusal(req("plan"), tasks, ctx()), undefined);
  const sub = [master(), child("bbbbbb", { orchestrator: { caps, opened: 0, root: "aaaaaa" } })];
  assert.equal(o.refusal(req("plan", { by: "bbbbbb", session: "sess-bbbbbb" }), sub, ctx()), undefined);
});

test("F117: the owner rejects an ambiguous receive even if an earlier snapshot resolved the sender", () => {
  const card = master({ provider: "codex", codexEditor: true });
  const receive = req("receive", { by: card.id, session: card.sessionId });
  const duplicateId = { ...card, sessionId: "another-thread" };
  for (const tasks of [[card, duplicateId], [duplicateId, card]]) {
    assert.match(o.refusal(receive, tasks, ctx()), /Ambiguous card id/);
  }
  const duplicateThread = { ...card, id: "dddddd" };
  for (const tasks of [[card, duplicateThread], [duplicateThread, card]]) {
    assert.match(o.refusal(receive, tasks, ctx()), /Ambiguous editor thread/);
  }
});

test("explicit controller binding works for detached sessions and legacy rebound cards", () => {
  assert.equal(o.refusal(req("rebind", { session: "chat-2" }), [master()], ctx()), undefined);
  assert.match(o.refusal(req("rebind", { session: null }), [master()], ctx()), /^Not bound: the request names no session/);
  const legacy = master({ takenOver: true, orchestrator: { caps, opened: 0, session: "chat-2" } });
  assert.equal(o.boundSession(legacy), "chat-2");
  assert.equal(o.refusal(add({ session: "chat-2" }), [legacy], ctx()), undefined);
  assert.match(o.refusal(add(), [legacy], ctx()), /^Not bound: session sess-a/);
  legacy.controller = { sessionId: "chat-3", mode: "external", at: "now" };
  assert.equal(o.boundSession(legacy), "chat-3");
  assert.equal(o.refusal(add({ session: "chat-3" }), [legacy], ctx()), undefined);
  assert.match(o.refusal(add({ session: "chat-2" }), [legacy], ctx()), /^Not bound: session chat-2/);
});

test("Codex children and explicit Bypass follow the repaired runtime and permission policy", () => {
  const c = ctx({ providerOf: () => "codex", accountSignedIn: () => true, models: ["gpt-6.1-sol"] });
  assert.equal(o.refusal(add({ account: "Codex", model: "gpt-6.1-sol", permission: "bypass" }), [master({ account: "Codex" })], c), undefined);
  assert.equal(o.refusal(add({ permission: "bypass" }), [master({ permission: "ask" })], ctx()), undefined);
});

test("checks wait for plan approval and uncancelled descendants", () => {
  assert.equal(o.checksWait(T("cccccc"), []), undefined);
  assert.equal(o.checksWait(master({ approved: undefined, plan: { at: "x", steps: 2, points: 4 } }), [master()]), "the plan waits for approval");
  const run = [master(), child("bbbbbb", { status: "running" }), child("b00002", { status: "done" })];
  assert.equal(o.checksWait(run[0], run), "1 card of its run still open");
  run[1].cancelled = true;
  assert.equal(o.checksWait(run[0], run), undefined);
});

test("the run: its root, its cards, depths and the master of a card", () => {
  const tasks = [master(), child("b00001", { orchestrator: { caps, opened: 0, root: "aaaaaa" } }), T("c00001", { openedBy: "b00001" }), T("other")];
  assert.equal(o.runRoot(tasks[1], tasks).id, "aaaaaa");
  assert.equal(o.runRoot(tasks[3], tasks), undefined);
  assert.deepEqual(o.runCards("aaaaaa", tasks).map((t) => t.id), ["b00001", "c00001"]);
  assert.deepEqual([0, 1, 2].map((i) => o.depthOf(tasks[i], tasks)), [0, 1, 2]);
  assert.equal(o.masterOf(tasks[2], tasks).id, "aaaaaa");
  const caps2 = o.capsFrom({ open: 2, depth: 5, followUps: "x", pointsFiveHour: 40 });
  assert.deepEqual(caps2, { open: 2, total: 600, depth: 5, followUps: 3, pending: 3, watchers: 3, perWatcher: 4, pointsFiveHour: 40 });
  assert.deepEqual(o.capsFrom(undefined), o.DEFAULT_CAPS);
});

test("prompts: the opened-by line, the master's first message, and the plan summary from ORCHESTRATION.md", () => {
  assert.match(o.APPROVED_NOTICE("18:00"), /at 18:00/);
  assert.equal(o.prefixPrompt("Parity sweep", "aaaaaa", "Do X.", new Date("2026-11-04T12:00:00Z")), 'Opened by orchestrator "Parity sweep" (aaaaaa) on 2026-11-04.\n\nDo X.');
  assert.match(o.masterPrompt("# Brief\n\n1. Rules.\n", "Run the sweep."), /^You are an orchestrator card on the Entomatical\. The brief below.*\$ENTOMATICAL_TASK\.\n\n# Brief\n\n1\. Rules\.\n\n---\n\nYour task:\n\nRun the sweep\.$/s);
  assert.deepEqual(o.planSummary("# Plan\n\n## Steps\n\n1. Scout\n2. Check F14\n- [x] done already\n- Notes\n\n## Budget\n\n- 10 pp\n"), { steps: 3, points: 6 });
  assert.deepEqual(o.planSummary("intro\n- one\n- two\n"), { steps: 2, points: 4 });
  assert.deepEqual(o.planSummary("nothing here"), { steps: 0, points: 0 });
  // the 'lists no steps' refusal ends with an example list that planSummary accepts
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "board.ts"), "utf8");
  const m = /lists no steps \(a list under a Steps heading\)\. Example:\\n(## Steps(?:\\n- [^"\\]+)+)"/.exec(src);
  assert.ok(m, "the refusal holds a Steps example");
  const example = m[1].replace(/\\n/g, "\n");
  assert.equal(example.split("\n").length, 3);
  assert.equal(o.planSummary(example).steps, 2);
});

test("settle notices: what counts as settled, the wake guard key, and the batched text", () => {
  const rec = (extra = {}) => ({ id: "b", status: "review", checks: null, chips: [], last: "ok", line: "b  review  ok", ...extra });
  assert.equal(o.isSettled(rec()), true);
  assert.equal(o.isSettled(rec({ status: "running" })), false);
  assert.equal(o.isSettled(rec({ checks: "running" })), false);
  assert.equal(o.isSettled(rec({ status: "needs-input" })), true);
  assert.equal(o.isSettled(rec({ status: "done" })), true);
  assert.equal(o.settleKey(rec()), o.settleKey(rec({ line: "different line, same state" })));
  assert.notEqual(o.settleKey(rec()), o.settleKey(rec({ chips: ["interrupted"] })));
  assert.equal(o.noticeText(["b  review  ok"]), "Child settled: b  review  ok");
  assert.equal(o.noticeText(["one", "two"]), "Children settled:\n- one\n- two");
});

test("account headroom: the lowest weekly use with a 5-hour window under 95 %, never the account that just hit its limit", () => {
  const accounts = [{ name: "a", fiveHour: 99, week: 10 }, { name: "b", fiveHour: 12, week: 3 }, { name: "c", fiveHour: 0, week: 69 }, { name: "d" }];
  assert.equal(o.bestAccount(accounts), "b");
  assert.equal(o.bestAccount(accounts.filter((x) => x.name !== "d")), "b");
  assert.equal(o.bestAccount(accounts, "b"), "c");
  assert.equal(o.bestAccount([{ name: "unmeasured" }, { name: "partial", week: 1 }]), undefined);
  assert.equal(o.bestAccount([{ name: "a", fiveHour: 99, week: 1 }, { name: "b", fiveHour: 1, week: 99 }]), undefined);
});

test("resuming a done child counts against the open cap, as a cancelled one does", () => {
  const one = { ...caps, open: 1 };
  const tasks = [master({ orchestrator: { caps: one, opened: 2 } }), child("b00001", { status: "done" }), child("b00002")];
  assert.equal(o.refusal(req("resume", { id: "b00001" }), tasks, ctx({ capsOf: () => one })), "open cap (1)");
  tasks[2].status = "done";
  assert.equal(o.refusal(req("resume", { id: "b00001" }), tasks, ctx({ capsOf: () => one })), undefined);
});

test("the headless command line and script: print mode, streamed, nobody answers prompts, the session, the resume, the orchestrator's window", () => {
  const plan = { claude: "C:\\u\\claude.exe", hooks: "C:\\r\\.entomatical\\hooks\\b.json", sessionId: "11111111-1111-1111-1111-111111111111", resume: false, title: "My child", named: true, promptFile: "C:\\r\\.entomatical\\launch\\b.prompt.txt", stream: "C:\\r\\.entomatical\\stream\\b.jsonl", stderr: "C:\\r\\.entomatical\\stream\\b.stderr.txt", cwd: "C:\\r" };
  assert.deepEqual(o.headlessArgs(plan), ["-p", "--output-format", "stream-json", "--verbose", "--permission-prompts", "none", "--settings", plan.hooks, "--session-id", plan.sessionId, "--name", "My child"]);
  assert.deepEqual(o.headlessArgs({ ...plan, resume: true, orchestrator: true }), ["-p", "--output-format", "stream-json", "--verbose", "--permission-prompts", "none", "--settings", plan.hooks, "--autocompact", "150k", "--resume", plan.sessionId]);
  const cmd = o.headlessScript(plan, "win32");
  // F91: ENTOMATICAL_NO_PROMPTS=1 for the claude process only, so its hooks know nobody can answer a prompt.
  assert.match(cmd, /^@echo off\r\nset ENTOMATICAL_NO_PROMPTS=1\r\ncd \/d "C:\\r" \|\| exit \/b 1\r\n"C:\\u\\claude\.exe" -p --output-format stream-json --verbose --permission-prompts none --settings C:\\r\\\.entomatical\\hooks\\b\.json --session-id 1111.* --name "My child" < "C:\\r\\\.entomatical\\launch\\b\.prompt\.txt" > "C:\\r\\\.entomatical\\stream\\b\.jsonl" 2> "C:\\r\\\.entomatical\\stream\\b\.stderr\.txt"\r\n$/);
  const sh = o.headlessScript({ ...plan, claude: "claude", title: "it's" }, "linux");
  // No `exec`: sh must keep the hidden terminal's pty open. With all three streams redirected, an exec'd claude left nothing holding
  // the pty and VS Code ended it within 0.3 s, before it read its prompt (linux, 4 Nov 2026, the headless-launch regression).
  assert.match(sh, /^#!\/bin\/sh\nENTOMATICAL_NO_PROMPTS=1 'claude' '-p'.* '--name' 'it'\\''s' < '.*b\.prompt\.txt' > '.*b\.jsonl' 2> '.*b\.stderr\.txt'\n$/);
  assert.deepEqual(Object.keys(o.headlessFiles("C:\\r\\.entomatical", "b")), ["promptFile", "followUpFile", "script", "stream", "stderr"]);
  // The main checkout as a working directory (fix 1), last: --add-dir takes every value up to the next option.
  const withRepo = { ...plan, repo: "C:\\Dev Stuff\\repo" };
  assert.deepEqual(o.headlessArgs(withRepo).slice(-2), ["--add-dir", "C:\\Dev Stuff\\repo"]);
  assert.deepEqual(o.headlessArgs(withRepo).slice(0, -2), o.headlessArgs(plan));
  assert.match(o.headlessScript(withRepo, "win32"), / --name "My child" --add-dir "C:\\Dev Stuff\\repo" < /);
  assert.match(o.headlessScript({ ...withRepo, repo: "/home/r/it's" }, "linux"), / '--add-dir' '\/home\/r\/it'\\''s' < /);
});

test("a card title with cmd.exe's special characters is made inert in the Windows script and unchanged on Linux (audit 10 November 2026, finding 8)", () => {
  const title = 'Q&A "100%" <x>|^';
  const plan = { claude: "C:\\u\\claude.exe", hooks: "C:\\h.json", sessionId: "s", resume: false, title, named: true, promptFile: "C:\\p.txt", stream: "C:\\s.jsonl", stderr: "C:\\e.txt", cwd: "C:\\r" };
  const line = o.headlessScript(plan, "win32").split("\r\n")[3];
  assert.match(line, / --session-id s --name "QA 100 x" < "C:\\p\.txt" > "C:\\s\.jsonl" 2> "C:\\e\.txt"$/);
  assert.ok(o.headlessScript(plan, "linux").includes(` '--name' 'Q&A "100%" <x>|^' < `));
});

test("every % in the Windows script's command line is doubled to %%, Linux unchanged, and a title of only stripped characters gives no --name (audit 11 November 2026, finding 8)", () => {
  const d = "C:\\Users\\50%off\\";
  const plan = { claude: d + "claude.exe", hooks: d + "h%1.json", sessionId: "s", resume: false, title: "%&", named: true, promptFile: d + "p.txt", stream: d + "s.jsonl", stderr: d + "e.txt", cwd: d, repo: "C:\\%PATH%" };
  const lines = o.headlessScript(plan, "win32").split("\r\n");
  assert.deepEqual(lines.slice(0, 2), ["@echo off", "set ENTOMATICAL_NO_PROMPTS=1"]);
  assert.equal(lines[2], 'cd /d "C:\\Users\\50%%off\\" || exit /b 1');
  assert.equal(lines[3], '"C:\\Users\\50%%off\\claude.exe" -p --output-format stream-json --verbose --permission-prompts none --settings C:\\Users\\50%%off\\h%%1.json --session-id s --add-dir C:\\%%PATH%% < "C:\\Users\\50%%off\\p.txt" > "C:\\Users\\50%%off\\s.jsonl" 2> "C:\\Users\\50%%off\\e.txt"');
  assert.doesNotMatch(lines[3], /--name/);
  assert.equal(o.headlessScript(plan, "linux"), "#!/bin/sh\nENTOMATICAL_NO_PROMPTS=1 'C:\\Users\\50%off\\claude.exe' '-p' '--output-format' 'stream-json' '--verbose' '--permission-prompts' 'none' '--settings' 'C:\\Users\\50%off\\h%1.json' '--session-id' 's' '--name' '%&' '--add-dir' 'C:\\%PATH%' < 'C:\\Users\\50%off\\p.txt' > 'C:\\Users\\50%off\\s.jsonl' 2> 'C:\\Users\\50%off\\e.txt'\n");
});

test("F71: cmd.exe starts the hidden script by its bare name from its folder, so a board folder and worktree holding %OS% work (live check, 12 November 2026)", { skip: process.platform !== "win32" && "cmd.exe only" }, () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { spawnSync } = require("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ab-pct-"));
  try {
    const board = path.join(root, "b %OS% x", ".entomatical"), wt = path.join(root, "w %OS% y"), tools = path.join(root, "tools");
    for (const d of [path.join(board, "launch"), path.join(board, "stream"), wt, tools]) fs.mkdirSync(d, { recursive: true });
    const out = path.join(tools, "seen.json"), js = path.join(tools, "fake.js");
    // A stand-in claude (in a folder without %) that records where it ran and what it read on stdin.
    fs.writeFileSync(js, `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ cwd: process.cwd(), stdin: require("fs").readFileSync(0, "utf8") }));`);
    fs.writeFileSync(path.join(tools, "claude.cmd"), `@"${process.execPath}" "${js}" %*\r\n`);
    const files = o.headlessFiles(board, "abc123");
    fs.writeFileSync(files.promptFile, "hello");
    const plan = { claude: path.join(tools, "claude.cmd"), hooks: path.join(board, "h.json"), sessionId: "s", resume: false, promptFile: files.promptFile, stream: files.stream, stderr: files.stderr, cwd: wt };
    fs.writeFileSync(files.script, o.headlessScript(plan, "win32"));
    // The old launch, the full path on cmd's command line: cmd expands %OS% in it and does not find the script.
    assert.notEqual(spawnSync("cmd.exe", ["/d", "/c", files.script], { cwd: wt, encoding: "utf8" }).status, 0);
    assert.equal(fs.existsSync(out), false);
    const l = o.headlessLaunch(files.script, wt, "win32");
    assert.deepEqual(l, { shellPath: "cmd.exe", shellArgs: ["/d", "/c", ".\\abc123.run.cmd"], cwd: path.join(board, "launch") });
    const r = spawnSync(l.shellPath, l.shellArgs, { cwd: l.cwd, encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), { cwd: wt, stdin: "hello" });
    assert.ok(fs.existsSync(files.stream), "the stream file is written");
    assert.deepEqual(o.headlessLaunch("/b/launch/x.run.sh", "/w", "linux"), { shellPath: "/bin/sh", shellArgs: ["/b/launch/x.run.sh"], cwd: "/w" });
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

test("headless permissions: Accept edits and Auto get the project's commands for both shells; Ask, Bypass, plan and attended cards get none", () => {
  for (const mode of ["acceptEdits", "auto"]) assert.deepEqual(o.headlessPermissions(mode, true), { defaultMode: mode, allow: o.HEADLESS_ALLOW });
  for (const mode of ["default", "bypassPermissions", "plan"]) assert.deepEqual(o.headlessPermissions(mode, true), { defaultMode: mode });
  assert.deepEqual(o.headlessPermissions("acceptEdits", false), { defaultMode: "acceptEdits" }); // a person answers its prompts
  // The calls refused on 4-6 November 2026: git through PowerShell, copying out of the main checkout, the board command.
  for (const rule of ["PowerShell(git *)", "PowerShell(node *)", "PowerShell(Copy-Item *)", "PowerShell(Get-ChildItem *)", "Bash(git *)", "Bash(cp *)", "Bash(node *)"])
    assert.ok(o.HEADLESS_ALLOW.includes(rule), rule);
  // Prefix rules only: no bare tool name, which would allow every command.
  assert.ok(o.HEADLESS_ALLOW.every((r) => /^(Bash|PowerShell)\([^()]+ \*\)$/.test(r)));
});

test("the stream's last assistant text and the run summary", () => {
  const line = (o) => JSON.stringify(o);
  const tail = [line({ type: "assistant", message: { content: [{ type: "text", text: "First\nsecond" }] }, timestamp: "2026-11-04T12:00:00Z" }), line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }), line({ type: "user" })].join("\n");
  assert.deepEqual(o.streamText(tail), { text: "First", at: Date.parse("2026-11-04T12:00:00Z") });
  assert.equal(o.streamText("garbage\n" + line({ type: "assistant", message: { content: [{ type: "text", text: "sub" }] }, parent_tool_use_id: "x" })), undefined);
  const tasks = [master(), child("b00001", { status: "running" }), child("b00002", { status: "needs-input" }), child("b00003", { status: "done" }), child("b00004", { interrupted: true })];
  const r = o.runSummary(tasks[0], tasks, (t) => (t.id === "b00003" ? 2.5 : 0));
  assert.deepEqual([r.running, r.needsYou, r.done, r.open, r.points, r.children.map((c) => c.id)], [1, 2, 1, 3, 2.5, ["b00001", "b00002", "b00003", "b00004"]]);
  assert.equal(r.children[3].interrupted, true);
  const partial = o.runSummary(tasks[0], tasks, t => t.id === "b00003" ? null : 2.5);
  assert.equal(partial.points, null);
  assert.equal(partial.children.find(c => c.id === "b00003").points, null);
});

test("discard, switch, finish self: the schema and the refusals before any git or account change", () => {
  // The schema: finish takes self: true or a card id (F120, the test below), never both; switch needs an account; there is no merge,
  // push, publish or install verb.
  assert.deepEqual(o.validateRequest({ v: 1, op: "finish", by: "aaaaaa", self: true }, "n").request.self, true);
  assert.equal(o.validateRequest({ v: 1, op: "finish", by: "aaaaaa" }, "n").error, "finish needs self: true (your own card's run) or the id of a card whose work has landed");
  assert.equal(o.validateRequest({ v: 1, op: "finish", by: "aaaaaa", self: true, id: "bbbbbb" }, "n").error, "finish takes a card id or self, not both");
  assert.equal(o.validateRequest({ v: 1, op: "switch", by: "aaaaaa", id: "bbbbbb" }, "n").error, "switch needs account");
  assert.equal(o.validateRequest({ v: 1, op: "switch", by: "aaaaaa", id: "bbbbbb", account: " spare " }, "n").request.account, "spare");
  for (const op of ["merge", "push", "publish", "install"]) assert.equal(o.validateRequest({ v: 1, op, by: "aaaaaa" }, "n").error, `Unknown op ${op}`);
  const wt = { worktree: "/w/b", branch: "task/b" };
  const tasks = [master({ worktree: "/w/a", branch: "task/aaaaaa" }), child("bbbbbb", wt), child("cccccc", { ...wt, status: "running" }), child("dddddd", { ...wt, takenOver: true }),
    child("eeeeee"), child("ffffff", { ...wt, openedBy: "zzzzzz", watchedBy: "zzzzzz" }), child("a00001", { ...wt, account: "acct" })];
  const r = (op, extra, c = {}, list = tasks) => o.refusal(req(op, extra), list, ctx({ accountSignedIn: (n) => ["acct", "spare", "full"].includes(n), accountUsage: (n) => ({ fiveHour: n === "full" ? 97 : 10 }), ...c }));
  assert.equal(r("discard", { id: "bbbbbb" }), undefined, "allowed here; the ancestor check runs on the board next");
  assert.equal(r("discard", { id: "cccccc" }), "busy: stop it first");
  assert.equal(r("discard", { id: "bbbbbb" }, { live: (t) => t.id === "bbbbbb" }), "busy: stop it first", "a hidden run still ending");
  assert.equal(r("discard", { id: "dddddd" }), "taken over");
  assert.equal(r("discard", { id: "eeeeee" }), "discard: no worktree (already finished or discarded)");
  assert.match(r("discard", { id: "ffffff" }), /^Card ffffff is controlled by zzzzzz \(no longer on the board\)\. You may `board\.js claim ffffff --reason "\.\.\."` \(owner terminal\)\.$/);
  assert.equal(r("switch", { id: "bbbbbb", account: "spare" }), undefined);
  assert.equal(r("switch", { id: "cccccc", account: "spare" }), "busy: stop it first");
  assert.equal(r("switch", { id: "bbbbbb", account: "nobody" }), "Account not signed in: nobody");
  assert.equal(r("switch", { id: "a00001", account: "acct" }), "switch: already on acct");
  assert.equal(r("switch", { id: "bbbbbb", account: "full" }), "switch: full has no headroom (5-hour window 97 % used)");
  assert.match(r("switch", { id: "bbbbbb", account: "spare" }, { accountUsage: () => ({ week: 2, quotaCoverage: "incomplete" }) }), /incomplete quota readings/);
  assert.equal(r("switch", { id: "bbbbbb", account: "spare" }, {}, [master({ paused: true }), child("bbbbbb", wt)]), "Run must be approved and unpaused");
  // finish self: only the master, only with its run closed, once.
  assert.equal(r("finish", { self: true }), "finish: 5 cards of the run are still open");
  assert.equal(o.refusal(req("finish", { self: true }), [master({ worktree: "/w/a" }), child("bbbbbb", { status: "done" }), child("cccccc", { cancelled: true })], ctx()), undefined, "Done and cancelled cards are closed");
  assert.equal(o.refusal(req("finish", { self: true }), [master({ worktree: "/w/a", finishAsked: { at: "x" } })], ctx()), "finish: already asked; the board reviews the run when this turn ends, or the card waits for the user");
  assert.equal(o.refusal(req("finish", { self: true }), [master()], ctx()), "finish: nothing to finish (the card has no worktree)");
  const sub = [master(), child("bbbbbb", { worktree: "/w/b", orchestrator: { caps, opened: 0, root: "aaaaaa" } })];
  assert.equal(o.refusal(req("finish", { by: "bbbbbb", session: "sess-bbbbbb", self: true }), sub, ctx()), "finish: only the master asks to finish");
});

// F120 (the user, 18 November 2026: "you should be able to click done or finish things"). These are the rights; what git must show
// (clean worktree, every commit landed) is the board's part, test/orchestrator-board.test.js "F120: ...".
test("F120: finish <id>: the request form, and which card the root of an approved run may ask the board to close", () => {
  const v = (extra) => o.validateRequest({ v: 1, op: "finish", by: "aaaaaa", ...extra }, "n");
  assert.deepEqual([v({ id: "bbbbbb" }).request.id, v({ id: "bbbbbb" }).request.self], ["bbbbbb", undefined]);
  assert.equal(v({ id: "nope" }).error, "id is not a card id");
  assert.equal(v({ id: 7 }).error, "id must be text");
  assert.equal(v({ self: false }).error, "self must be true");
  assert.equal(v({ self: false, id: "bbbbbb" }).error, "self must be true");
  assert.equal(v({ id: "bbbbbb", account: "spare" }).error, 'Unknown field "account" for finish');

  const wt = { worktree: "/w/b", branch: "task/b" };
  const run = (extra = {}, more = []) => [master({ worktree: "/w/a", ...extra }), child("bbbbbb", wt), T("c00001", wt), ...more];
  const r = (id, list = run(), c = {}, by = {}) => o.refusal(req("finish", { id, ...by }), list, ctx(c));
  // Allowed: a card of the caller's run and a card of the user's own (no opener), in Review with the session ended.
  assert.equal(r("bbbbbb"), undefined);
  assert.equal(r("c00001"), undefined);
  // The caller: the root of an approved, unpaused, ordinary run, and never for its own card.
  assert.equal(r("aaaaaa"), "finish: for your own card use `board.js finish self`");
  const only = "finish: only the root of an ordinary run asks the board to finish a card";
  const coordinator = child("dddddd", { ...wt, orchestrator: { caps, opened: 0, root: "aaaaaa" } });
  assert.equal(r("c00001", run({}, [coordinator]), {}, { by: "dddddd", session: "sess-dddddd" }), only, "a coordinator under the root");
  assert.equal(r("bbbbbb", run({ planRun: { name: "p", file: "p.json", review: "checks" } })), only, "a plan card");
  assert.equal(r("bbbbbb", run({ battle: "b1" })), only, "a battle card");
  assert.equal(r("bbbbbb", run({ approved: undefined })), "Run must be approved and unpaused");
  assert.equal(r("bbbbbb", run({ paused: true })), "Run must be approved and unpaused");
  // The card: of the caller's run or the user's own, never another run's, a run's root or a governed card.
  const other = T("eeeeee", { orchestrator: { caps, opened: 0 }, sessionId: "sess-e", approved: { at: "x", hash: "h" }, ...wt });
  const theirs = T("ffffff", { ...wt, openedBy: "eeeeee", watchedBy: "eeeeee" });
  assert.match(r("ffffff", run({}, [other, theirs])), /^Card ffffff is controlled by eeeeee \(/, "a card another run opened");
  assert.equal(r("eeeeee", run({}, [other])), "finish: card eeeeee is the root of a run; a root stays with the user");
  assert.equal(r("c00001", [master({ worktree: "/w/a" }), T("c00001", { ...wt, governedBy: "g00001" })]),
    "finish: card c00001 belongs to governed run g00001; it reaches the target only through that run's readiness check");
  assert.equal(r("nobody"), "No card nobody");
  // Its state: in Review, its session ended, not taken over, a worktree to remove, nothing open below it.
  const one = (extra) => [master({ worktree: "/w/a" }), child("bbbbbb", { ...wt, ...extra })];
  assert.equal(r("bbbbbb", one({ status: "done" })), "done");
  assert.equal(r("bbbbbb", one({ takenOver: true })), "finish: the user took card bbbbbb over; it is his to finish");
  const notReview = "finish: card bbbbbb is not in Review with its session ended";
  for (const status of ["queued", "running", "needs-input"]) assert.equal(r("bbbbbb", one({ status })), notReview, status);
  assert.equal(r("bbbbbb", run(), { live: (t) => t.id === "bbbbbb" }), notReview, "in Review, but its hidden run is still ending");
  assert.equal(r("bbbbbb", one({ worktree: undefined })), "finish: card bbbbbb has no worktree, so there is nothing to remove");
  const below = (extra) => [...one({ orchestrator: { caps, opened: 1, root: "aaaaaa" } }), T("a00001", { openedBy: "bbbbbb", watchedBy: "bbbbbb", ...extra })];
  assert.equal(r("bbbbbb", below({})), "Descendants are not finished");
  assert.equal(r("bbbbbb", below({ status: "done" })), undefined);
  assert.equal(r("bbbbbb", below({ cancelled: true })), undefined);
  // With the setting off, or from a card that is not an orchestrator, it is refused as every other request is.
  assert.equal(r("bbbbbb", run(), { enabled: false }), "Orchestrator disabled (entomatical.orchestrator.enabled is off)");
  assert.equal(r("c00001", run(), {}, { by: "bbbbbb", session: "sess-bbbbbb" }), "Not an orchestrator");
});

test("the measured points budget: run-wide, unknown cards named and never counted as zero, 80 % then 100 % once each; distinct from pointsFiveHour", () => {
  assert.equal(o.capsFrom({ points: 20 }).points, 20);
  assert.equal(o.capsFrom({ points: -1 }).points, undefined);
  assert.equal(o.capsFrom({}).points, undefined);
  assert.deepEqual(o.validateRequest({ v: 1, op: "plan", by: "aaaaaa", caps: { points: 30 } }, "n").request.caps, { points: 30 }, "the root may propose a budget with its plan");
  const withCap = (points) => master({ orchestrator: { caps: { ...caps, points }, opened: 0 } });
  const tasks = [withCap(20), child("b00001"), child("b00002"), child("b00003"), T("c00001")];
  const cost = { aaaaaa: 2, b00001: 6, b00002: undefined, b00003: 8.5, c00001: 50 };
  const b = o.runBudget(tasks[0], tasks, (t) => cost[t.id]);
  assert.deepEqual(b, { cap: 20, used: 16.5, percent: 82, unknown: ["b00002"] }, "the user's own card c00001 is not in the run");
  assert.equal(o.runBudget(master(), tasks, () => 1), undefined, "no caps.points: no budget");
  assert.equal(o.budgetStep(b, undefined), 80);
  assert.equal(o.budgetStep(b, 80), undefined, "told once");
  assert.equal(o.budgetStep({ ...b, percent: 100 }, 80), 100);
  assert.equal(o.budgetStep({ ...b, percent: 130 }, undefined), 100, "straight past 80: the pause");
  assert.equal(o.budgetStep({ ...b, percent: 130 }, 100), undefined, "paused once; the user's Resume run is not undone");
  assert.match(o.BUDGET_NOTICE(b), /^Budget: this run has used 16\.5 of its 20 points of the 5-hour window \(82 %\); 1 card has no measurable reading and count as unknown\. At 100 %/);
  assert.match(o.BUDGET_NOTICE({ ...b, percent: 100, unknown: [] }), /\(100 %\)\. The board paused the run/);
  assert.equal(o.refusal(add(), [master({ paused: "budget", orchestrator: { caps: { ...caps, points: 20 }, opened: 0 } })], ctx()), "Run paused: points budget reached (caps.points 20); the user's Resume run continues it");
  assert.equal(o.refusal(add(), [master({ paused: true })], ctx()), "Run paused", "the user's own pause is unchanged");
});

test("archiveSet: the master and its run; a card left on the board under one of them stops the archive", () => {
  const tasks = [master(), child("b00001"), T("c00001", { openedBy: "b00001", watchedBy: "b00001" }), T("d00001"), T("e00001", { parentId: "b00001" }), T("f00001", { dependsOn: ["c00001"] })];
  const { cards, outside } = o.archiveSet(tasks[0], tasks);
  assert.deepEqual(cards.map((t) => t.id), ["aaaaaa", "b00001", "c00001"]);
  assert.deepEqual(outside.map((t) => t.id), ["e00001", "f00001"]);
});
