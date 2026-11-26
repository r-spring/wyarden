// Phase 3 of docs/plans/MASTER-PLAN-capability-profiles-and-orchestration.md (section 8): governed runs. Acceptance AC-B (delegation
// and escalation), AC-C (capacity, fairness, waiting parents, depth), AC-F (brief, overview, cursor events, handoffs) and AC-I (duplicate
// launch and request, restart and owner loss), plus the phase's hard block on every target effect. Pure rules first, then a real Board.
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
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined, showInformationMessage: async () => undefined, showTextDocument: async () => undefined,
    createTerminal: (options) => { const t = { options, shows: [], sent: [], show: (p) => t.shows.push(p), dispose() { t.exitStatus = { code: 0 }; vscode.window.terminals = vscode.window.terminals.filter((x) => x !== t); }, exit(code = 0) { t.exitStatus = { code }; vscode.window.terminals = vscode.window.terminals.filter((x) => x !== t); }, sendText: (s) => t.sent.push(s) };
      terminals.push(t); vscode.window.terminals.push(t); return t; } } };
const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-governed-home-"));
process.env.HOME = process.env.USERPROFILE = home;
process.env.ENTOMATICAL_USAGE_DIR = path.join(home, "usage");
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board } = require("../out/board.js");
const o = require("../out/orchestrator.js");
const P = require("../out/profiles.js");
const cli = require("../tools/board.js");

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const made = [], boards = [];
test.after(() => { for (const b of boards) b.dispose(); for (const d of made) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pure rules (src/orchestrator.ts) ----

const card = (id, extra = {}) => ({ id, title: `T ${id}`, prompt: "p", status: "queued", createdAt: `2026-11-16T00:00:0${id.charCodeAt(5) % 10}.000Z`, updatedAt: "x", ...extra });
const gov = (extra = {}) => ({ v: 1, revision: 1, at: "now", setBy: "user-selection", limits: { active: 3, directChildren: 2, depth: 2 },
  profiles: { "provider-defaults": { mode: "provider-defaults" } }, delegation: { allowed: ["provider-defaults"], defaultChild: "provider-defaults", depth: 2 }, leases: [], seq: 0, ...extra });

test("O2 stays open: a governed configuration has no default limits, and pins only available profile revisions", () => {
  const strict = { mode: "strict", snapshot: { id: "workspace:p1", revision: 2, hash: "h", name: "Tests", variants: {} }, pinnedAt: "now" };
  const pin = (id) => { if (id === "workspace:p1") return strict; if (id === "workspace:old") throw new Error("Capability profile workspace:old is archived; existing tasks keep it, new tasks cannot select it."); throw new Error(`Unknown capability profile ${id}.`); };
  assert.match(o.validateGovernance({ allowed: ["provider-defaults"] }, pin).error, /there are no defaults/);
  assert.match(o.validateGovernance({ limits: { active: 6, directChildren: 3 }, allowed: ["provider-defaults"] }, pin).error, /depth/);
  assert.match(o.validateGovernance({ limits: { active: 2, directChildren: 3, depth: 2 }, allowed: ["provider-defaults"] }, pin).error, /direct children/);
  assert.match(o.validateGovernance({ limits: { active: 6, directChildren: 3, depth: 2 }, allowed: [] }, pin).error, /at least one profile/);
  assert.match(o.validateGovernance({ limits: { active: 6, directChildren: 3, depth: 2 }, allowed: ["workspace:p1@1"] }, pin).error, /unavailable; workspace:p1 is at revision 2/);
  assert.match(o.validateGovernance({ limits: { active: 6, directChildren: 3, depth: 2 }, allowed: ["workspace:old"] }, pin).error, /archived/);
  assert.match(o.validateGovernance({ limits: { active: 6, directChildren: 3, depth: 2 }, allowed: ["provider-defaults"], defaultChild: "workspace:p1" }, pin).error, /not among the allowed/);
  assert.match(o.validateGovernance({ limits: { active: 6, directChildren: 3, depth: 2 }, allowed: ["provider-defaults"], caps: {} }, pin).error, /unknown field caps/);
  const ok = o.validateGovernance({ limits: { active: 6, directChildren: 3, depth: 2 }, allowed: ["provider-defaults", "workspace:p1@2"], defaultChild: "workspace:p1" }, pin).governance;
  assert.deepEqual(ok.delegation, { allowed: ["provider-defaults", "workspace:p1@2"], defaultChild: "workspace:p1@2", depth: 2 });
  assert.deepEqual(ok.profiles["workspace:p1@2"], strict, "the snapshot is pinned at approval");
  assert.equal(ok.setBy, "user-selection");
});

test("AC-B: omission takes the default, no default asks for a choice, unauthorized refs and descendant expansion are refused", () => {
  const g = gov({ profiles: { "provider-defaults": { mode: "provider-defaults" }, "workspace:a@1": { mode: "strict", snapshot: { id: "workspace:a", revision: 1, hash: "h", name: "A", variants: {} }, pinnedAt: "now" } },
    delegation: { allowed: ["provider-defaults", "workspace:a@1"], defaultChild: "provider-defaults", depth: 2 } });
  assert.equal(o.childProfile(g.delegation, g).ref, "provider-defaults");
  assert.equal(o.childProfile(g.delegation, g, "workspace:a").ref, "workspace:a@1", "a bare id resolves to the pinned revision");
  assert.match(o.childProfile({ ...g.delegation, defaultChild: undefined }, g).error, /choice required/);
  assert.match(o.childProfile(g.delegation, g, "workspace:b@1").error, /not in this card's delegation allowance/);
  assert.match(o.childProfile(g.delegation, g, "workspace:a@2").error, /not in this card's delegation allowance/, "another revision is unauthorized");
  assert.match(o.childProfile(undefined, g).error, /a worker opens no cards/);
  // Narrowing: a coordinator gets a subset and fewer edges; its own profile is independent of what it may delegate.
  const narrow = o.narrowDelegation(g.delegation, { allowed: ["workspace:a@1"] }, true).delegation;
  assert.deepEqual(narrow, { allowed: ["workspace:a@1"], depth: 1 });
  assert.match(o.narrowDelegation(narrow, { allowed: ["provider-defaults"] }, true).error, /depth/);
  assert.match(o.narrowDelegation({ allowed: ["workspace:a@1"], depth: 3 }, { allowed: ["provider-defaults"] }, true).error, /outside this card's allowance/);
  assert.match(o.narrowDelegation(g.delegation, { depth: 2 }, true).error, /depth must be from 1 to 1/);
  assert.match(o.narrowDelegation(g.delegation, { allowed: ["workspace:a@1"] }, false).error, /needs --may-open/);
  assert.deepEqual(o.narrowDelegation(g.delegation, undefined, false), {});
});

test("AC-C: leases count root and judges, cap direct children, reserve the next slot for parent continuations and judges, round robin and aging", () => {
  const root = card("r00000", { governed: gov({ limits: { active: 3, directChildren: 2, depth: 2 } }), sessionId: "s" });
  const a = card("a00001", { openedBy: root.id }), b = card("b00002", { openedBy: root.id }), c = card("c00003", { openedBy: root.id });
  const coord = card("d00004", { openedBy: root.id, delegation: { allowed: ["provider-defaults"], depth: 1 }, sessionId: "s4", status: "review" });
  const w1 = card("e00005", { openedBy: coord.id }), judge = card("f00006", { openedBy: root.id, role: "judge" });
  const tasks = [root, a, b, c, coord, w1, judge];
  root.governed.leases = [{ card: root.id, op: "x", at: "now", state: "active" }];
  assert.equal(o.admission(a, root, tasks, []), undefined, "a fresh slot");
  root.governed.leases.push({ card: a.id, op: "x", at: "now", state: "active" }, { card: b.id, op: "x", at: "now", state: "active" });
  assert.match(o.admission(c, root, tasks, []), /3 of 3 active/, "root counts against the limit");
  assert.equal(o.admission(a, root, tasks, []), undefined, "a duplicate launch shares the lease it holds");
  root.governed.leases.pop();
  assert.equal(o.admission(c, root, tasks, []), undefined, "a slot freed");
  root.governed.limits.directChildren = 1;
  assert.match(o.admission(c, root, tasks, []), /already has 1 direct children active/);
  root.governed.limits.directChildren = 2;
  // A parent continuation (coordinator with notices) and a judge come before a new start, whatever their age.
  const waiting = [{ task: c, kind: "start" }, { task: coord, kind: "continuation" }];
  assert.match(o.admission(c, root, tasks, waiting), /reserved for d00004 \(parent continuation\)/);
  assert.equal(o.admission(coord, root, tasks, waiting), undefined);
  assert.equal(o.admissionOrder([{ task: c, kind: "start" }, { task: judge, kind: "judge" }], root.governed, tasks, root.id)[0].task.id, judge.id);
  // Round robin: the group with fewer active leases first; then the oldest wait.
  const order = o.admissionOrder([{ task: c, kind: "start" }, { task: w1, kind: "start" }], root.governed, tasks, root.id);
  assert.equal(order[0].task.id, w1.id, "the coordinator's group holds no lease; the root's holds one");
  const older = card("a00009", { openedBy: root.id, statusAt: "2026-11-15T00:00:00.000Z" });
  assert.equal(o.admissionOrder([{ task: c, kind: "start" }, { task: older, kind: "start" }], root.governed, [...tasks, older], root.id)[0].task.id, older.id);
});

test("AC-C/AC-I: a lease ends only when its session is known to have ended; deadlock is reported, not overbooked", () => {
  const live = new Set(["a00001"]), v = { live: (t) => live.has(t.id), starting: () => false, now: Date.parse("2026-11-16T00:10:00Z") };
  const tasks = [card("a00001", { status: "review" }), card("b00002", { status: "review" }), card("c00003", { status: "queued", sessionId: "s" }), card("d00004", { launchError: "x", status: "review" }), card("e00005", { status: "running" })];
  const g = gov({ leases: [
    { card: "a00001", op: "1", at: "2026-11-16T00:00:00Z", state: "active" }, // live in Review (a terminal waiting): kept
    { card: "b00002", op: "2", at: "2026-11-16T00:00:00Z", state: "active" }, // ended: released
    { card: "c00003", op: "3", at: "2026-11-16T00:09:30Z", state: "reserved" }, // launching, inside the grace: kept
    { card: "d00004", op: "4", at: "2026-11-16T00:09:59Z", state: "reserved" }, // launch failed: released
    { card: "e00005", op: "5", at: "2026-11-16T00:00:00Z", state: "active" }, // Running with no process seen (after a restart): kept until the board settles it
    { card: "gone00", op: "6", at: "2026-11-16T00:00:00Z", state: "active" } ] }); // deleted card: released
  tasks.push(card("h00007", { status: "review", statusAt: "2026-11-16T00:09:50Z" }));
  g.leases.push({ card: "h00007", op: "7", at: "2026-11-16T00:09:40Z", state: "reserved" }); // ran and settled between two looks: released
  const r = o.reconcileLeases(g, tasks, v);
  assert.deepEqual(r.leases.map((l) => l.card), ["a00001", "c00003", "e00005"]);
  assert.deepEqual(r.released.map((l) => l.card), ["b00002", "d00004", "gone00", "h00007"]);
  // Deadlock: every lease held by a session that is not working while ready cards wait.
  const root = card("r00000", { status: "review", governed: gov({ limits: { active: 2, directChildren: 2, depth: 2 } }) });
  const k = card("k00001", { status: "review", openedBy: root.id }), q = card("q00002", { held: true, openedBy: root.id });
  root.governed.leases = [{ card: root.id, op: "1", at: "now", state: "active" }, { card: k.id, op: "2", at: "now", state: "active" }];
  assert.match(o.deadlock(root, [root, k, q], [{ task: q, kind: "start" }]), /Capacity deadlock .*\(r00000 review, k00001 review\) .*\(q00002\)/);
  k.status = "running";
  assert.equal(o.deadlock(root, [root, k, q], [{ task: q, kind: "start" }]), undefined, "a holder at work is progress");
});

test("dependencies: missing or failed never count as accepted; cycles found; declared and submitted overlaps reported", () => {
  const a = card("a00001", { cancelled: true, status: "review" }), b = card("b00002", { discarded: true, status: "done" }), ok = card("c00003", { status: "done" });
  assert.match(o.dependencyBlock(card("x00001", { dependsOn: ["zzzzzz"] }), [a]), /missing/);
  assert.match(o.dependencyBlock(card("x00001", { dependsOn: [a.id] }), [a]), /failed \(cancelled\)/);
  assert.match(o.dependencyBlock(card("x00001", { dependsOn: [b.id] }), [b]), /failed \(discarded\)/);
  assert.equal(o.dependencyBlock(card("x00001", { dependsOn: [ok.id] }), [ok]), undefined);
  const p = card("p00001", { dependsOn: ["q00002"] }), q = card("q00002", { dependsOn: ["p00001"] });
  assert.deepEqual(o.dependencyCycle([p, q]), ["p00001", "q00002", "p00001"]);
  assert.equal(o.dependencyCycle([ok], { id: "(new)", dependsOn: [ok.id] }), undefined);
  const m1 = card("m00001", { assignment: { key: "a", outcome: "o", owns: ["src/ui/"] } }), m2 = card("m00002", { submission: { files: ["src/ui/board.js"] } }), m3 = card("m00003", { assignment: { key: "c", outcome: "o", owns: ["docs"] } });
  assert.deepEqual(o.overlaps([m1, m2, m3]), [{ a: "m00001", b: "m00002", paths: ["src/ui"] }]);
});

test("protocol: add carries profile, assignment and a narrowed delegate; submit is validated; nothing can carry the trusted configuration", () => {
  const by = { v: 1, by: "0db6d1", session: "s", protocol: 3 };
  const add = o.validateRequest({ ...by, op: "add", title: "T", prompt: "P", mayOpen: true, profile: "workspace:a@1", assignment: { key: "ui-1", outcome: "Build it", owns: ["src/ui"] }, delegate: { allowed: ["workspace:a@1"], depth: 1 } }, "n").request;
  assert.deepEqual([add.protocol, add.profile, add.assignment.key, add.delegate.depth], [3, "workspace:a@1", "ui-1", 1]);
  assert.match(o.validateRequest({ ...by, op: "add", title: "T", prompt: "P", delegate: {} }, "n").error, /needs --may-open/);
  assert.match(o.validateRequest({ ...by, op: "add", title: "T", prompt: "P", assignment: { key: "bad key", outcome: "o" } }, "n").error, /assignment.key/);
  assert.match(o.validateRequest({ ...by, op: "add", title: "T", prompt: "P", governed: { limits: {} } }, "n").error, /Unknown field "governed"/);
  assert.match(o.validateRequest({ ...by, op: "add", title: "T", prompt: "P", delegation: {} }, "n").error, /Unknown field "delegation"/);
  assert.match(o.validateRequest({ ...by, op: "submit", head: "zz", summary: "s" }, "n").error, /commit id/);
  const sub = o.validateRequest({ ...by, op: "submit", head: "abcdef1", summary: "done", files: ["a.txt"], claimedChecks: ["npm test"], covers: ["A-01"] }, "n").request;
  assert.deepEqual([sub.head, sub.files, sub.claimedChecks, sub.covers], ["abcdef1", ["a.txt"], ["npm test"], ["A-01"]]);
});

// ---- the board (src/board.ts) ----

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-governed-"));
  made.push(repo);
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t"); sh(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  boards.push(board);
  board.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }, { name: "spare", configDir: path.join(home, "spare") }];
  board.accountFolderList = () => [path.join(home, "acct"), path.join(home, "spare")];
  board.preflightHeadless = async () => {};
  board.requestRateMs = 0;
  board.tick();
  const runEvents = [];
  board.onRun((e) => runEvents.push(e));
  const ws = path.join(repo, "workflows", "capability-profiles.json");
  const tests = P.saveRevision(ws, "workspace", { name: "Tests", variants: { claude: { items: [{ kind: "skill", id: "run-tests" }] } } });
  const pin = (id) => P.pin({ workspace: ws }, id);
  return { repo, board, runEvents, ws, tests, pin };
}
const event = (board, id, e) => fs.appendFileSync(board.eventsFile(id), JSON.stringify({ t: Date.now(), ...e }) + "\n");
const settle = (board, task) => { terminals.find((t) => t.options.name === `En ${task.id}` && !t.exitStatus)?.exit(0); event(board, task.id, { hook_event_name: "Stop", last_assistant_message: "done" }); board.syncStatus(task.id); };
async function request(board, body) {
  const inbox = path.join(board.dir, "inbox");
  fs.mkdirSync(path.join(inbox, "done"), { recursive: true });
  const nonce = `n${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(path.join(inbox, `${nonce}.json`), JSON.stringify({ v: 1, at: "now", ...body }));
  await board.processInbox();
  for (let i = 0; i < 40 && !fs.existsSync(path.join(inbox, "done", `${nonce}.json`)); i++) await sleep(50);
  return JSON.parse(fs.readFileSync(path.join(inbox, "done", `${nonce}.json`), "utf8"));
}
/** A root orchestrator, started headless, with a plan waiting; approved as governed with the given configuration. */
async function governedRoot(f, config) {
  const m = f.board.add("Project", "Ship the export feature.", "acct", undefined, "haiku", "low", undefined, { orchestrator: { caps: { ...o.DEFAULT_CAPS }, opened: 0 }, headless: true });
  await f.board.startHeadless(m);
  event(f.board, m.id, { hook_event_name: "SessionStart", session_id: m.sessionId });
  f.board.update(m, { plan: { steps: 2, points: 1, caps: { ...o.DEFAULT_CAPS } } });
  f.board.govern(m, config, f.pin);
  await f.board.approvePlan(m);
  return m;
}
const LIMITS = { active: 3, directChildren: 2, depth: 2 };
const add = (f, by, extra = {}) => request(f.board, { op: "add", by: by.id, session: by.sessionId, protocol: 3, title: extra.title ?? "Worker", prompt: "Do part of it.", ...extra });
const started = (f, t) => { event(f.board, t.id, { hook_event_name: "SessionStart", session_id: t.sessionId }); };

test("legacy runs stay legacy: govern only a fresh root, never a battle, plan-file, adopted or already-started run; caps unchanged", async () => {
  const f = fixture();
  const legacy = f.board.add("Legacy", "x", "acct", undefined, undefined, undefined, undefined, { orchestrator: { caps: { ...o.DEFAULT_CAPS }, opened: 0 }, headless: true, approved: { at: "now", hash: "h" } });
  assert.equal(o.governedRootOf(legacy, f.board.tasks), undefined, "nothing is retroactively governed");
  assert.throws(() => f.board.govern(legacy, { limits: LIMITS, allowed: ["provider-defaults"] }, f.pin), /not been approved/);
  const battle = f.board.add("B", "x", "acct", undefined, undefined, undefined, undefined, { orchestrator: { caps: { ...o.DEFAULT_CAPS }, opened: 0 }, battle: "b1" });
  assert.throws(() => f.board.govern(battle, { limits: LIMITS, allowed: ["provider-defaults"] }, f.pin), /Battle Royale/);
  const plan = f.board.add("P", "x", "acct", undefined, undefined, undefined, undefined, { orchestrator: { caps: { ...o.DEFAULT_CAPS }, opened: 0 }, planRun: { file: "w.plan.json", review: "checks" } });
  assert.throws(() => f.board.govern(plan, { limits: LIMITS, allowed: ["provider-defaults"] }, f.pin), /plan-file run/);
  const fresh = f.board.add("F", "x", "acct", undefined, undefined, undefined, undefined, { orchestrator: { caps: { ...o.DEFAULT_CAPS }, opened: 0 } });
  assert.throws(() => f.board.govern(fresh, { allowed: ["provider-defaults"] }, f.pin), /no defaults/);
  const g = f.board.govern(fresh, { limits: LIMITS, allowed: ["provider-defaults"] }, f.pin);
  assert.deepEqual(fresh.orchestrator.caps, o.DEFAULT_CAPS, "legacy caps are untouched");
  assert.equal(g.leases.length, 0, "a root with no session holds no lease");
  assert.throws(() => f.board.govern(fresh, { limits: LIMITS, allowed: ["provider-defaults"] }, f.pin), /already governed/);
  f.board.update(fresh, { plan: { steps: 1, points: 1, caps: { ...o.DEFAULT_CAPS } } });
  await assert.rejects(f.board.approvePlan(fresh, { pressureWatchers: true }), /Pressure watchers are not supported in governed runs/);
});

test("AC-B/AC-I: governed add needs protocol 3 and an assignment, resolves the default, is idempotent by key, and refuses escalation", async () => {
  const f = fixture();
  const m = await governedRoot(f, { limits: LIMITS, allowed: ["provider-defaults", `${f.tests.ref}@1`], defaultChild: "provider-defaults" });
  assert.equal(m.governed.leases.length, 1, "the live root holds a lease");
  assert.match((await request(f.board, { op: "add", by: m.id, session: m.sessionId, title: "W", prompt: "P", assignment: { key: "k", outcome: "o" } })).error, /needs board.js protocol 3/);
  assert.match((await add(f, m)).error, /add needs an assignment/);
  assert.match((await add(f, m, { assignment: { key: "k0", outcome: "o" }, profile: "workspace:nope@1" })).error, /not in this card's delegation allowance/);
  assert.match((await add(f, m, { assignment: { key: "k0", outcome: "o" }, watch: [m.id], mayOpen: true })).error, /watch|watchers/);
  const r1 = await add(f, m, { assignment: { key: "export", outcome: "Export keeps column order", owns: ["src/export"] }, start: "manual" });
  assert.equal(r1.created, true, JSON.stringify(r1));
  const child = f.board.get(r1.id);
  assert.deepEqual([child.governedBy, o.profileRef(child.profile), child.assignment.key, child.delegation], [m.id, "provider-defaults", "export", undefined]);
  const n = f.board.tasks.length;
  const again = await add(f, m, { assignment: { key: "export", outcome: "Export keeps column order", owns: ["src/export"] }, start: "manual" });
  assert.deepEqual([again.id, again.created, again.duplicate, f.board.tasks.length], [child.id, false, true, n], "the same key and payload: the same card");
  assert.match((await add(f, m, { assignment: { key: "export", outcome: "Something else" }, start: "manual" })).error, /already used for card/);
  // A strict profile from the allowance is pinned from the run's approved snapshot; phase 2 still blocks its launch (no strict route).
  const r2 = await add(f, m, { title: "Tester", assignment: { key: "tests", outcome: "Tests" }, profile: f.tests.ref, start: "manual" });
  const tester = f.board.get(r2.id);
  assert.equal(tester.profile.snapshot.hash, m.governed.profiles[`${f.tests.ref}@1`].snapshot.hash);
  await assert.rejects(f.board.startHeadless(tester), /route|blocked/i);
  assert.equal(tester.sessionId, undefined, "never broadened into Provider defaults");
  // A coordinator gets a narrowed allowance; it cannot widen it for its own children.
  assert.match((await add(f, m, { title: "C", mayOpen: true, assignment: { key: "c0", outcome: "o" }, delegate: { allowed: ["workspace:other@1"] } })).error, /outside this card's allowance/);
  const r3 = await add(f, m, { title: "Coordinator", mayOpen: true, assignment: { key: "ui", outcome: "UI outcome" }, delegate: { allowed: [`${f.tests.ref}@1`], defaultChild: `${f.tests.ref}@1` } });
  const coord = f.board.get(r3.id);
  assert.deepEqual(coord.delegation, { allowed: [`${f.tests.ref}@1`], defaultChild: `${f.tests.ref}@1`, depth: 1 });
  assert.ok(coord.sessionId, JSON.stringify(r3));
  started(f, coord);
  assert.match((await add(f, coord, { assignment: { key: "w", outcome: "o" }, profile: "provider-defaults" })).error, /not in this card's delegation allowance/, "a descendant never gets more than the root allowed it");
  assert.match((await add(f, coord, { assignment: { key: "w", outcome: "o" }, mayOpen: true })).error, /depth/);
  // the user's own subtask under a governed card is bounded by the root's allowance and joins the run.
  const manual = f.board.add("Manual", "x", "acct", child.id);
  assert.deepEqual([manual.governedBy, o.profileRef(manual.profile)], [m.id, "provider-defaults"]);
  assert.throws(() => f.board.add("Manual 2", "x", "acct", child.id, undefined, undefined, undefined, { profile: { mode: "strict", snapshot: { id: "workspace:x", revision: 1, hash: "h", name: "X", variants: {} }, pinnedAt: "now" } }), /not in this card's delegation allowance/);
  // Requests cannot change the trusted configuration.
  assert.match((await request(f.board, { op: "plan", by: m.id, session: m.sessionId, protocol: 3, caps: { open: 9 } })).error, /keeps the limits and permissions the user approved/);
});

test("AC-C: at most the active limit runs at once, a held child starts only when a lease is released after its session ended", async () => {
  const f = fixture();
  const m = await governedRoot(f, { limits: { active: 2, directChildren: 2, depth: 1 }, allowed: ["provider-defaults"], defaultChild: "provider-defaults" });
  const a = f.board.get((await add(f, m, { title: "A", assignment: { key: "a", outcome: "a" } })).id);
  assert.ok(a.sessionId, "the second lease");
  const rb = await add(f, m, { title: "B", assignment: { key: "b", outcome: "b" } });
  const b = f.board.get(rb.id);
  assert.match(rb.note, /2 of 2 active/);
  assert.deepEqual([b.held, b.sessionId], [true, undefined]);
  await assert.rejects(f.board.startHeadless(b), /Waiting for an execution lease/, "a direct start cannot overbook either");
  assert.ok(m.governed.leases.length <= 2);
  // A's turn ends in Review but its process still runs: the lease stays. Once the process is gone it is released.
  event(f.board, a.id, { hook_event_name: "Stop", last_assistant_message: "done" }); f.board.syncStatus(a.id);
  f.board.tick();
  assert.equal(m.governed.leases.length, 2, "Review is not quiescence while the process lives");
  settle(f.board, a);
  f.board.tick();
  assert.deepEqual(m.governed.leases.map((l) => l.card), [m.id]);
  assert.equal(f.board.governedWait(b), undefined);
  await f.board.startHeadless(b);
  assert.deepEqual(m.governed.leases.map((l) => l.card).sort(), [m.id, b.id].sort());
  const events = fs.readFileSync(path.join(f.board.dir, "governed", `${m.id}.events.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.kind === "lease" && /released/.test(e.text) && e.card === a.id));
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), "sequence numbers rise by one");
});

test("AC-C: a waiting parent yields; its continuation gets the next slot before new work; a failed dependency blocks instead of releasing", async () => {
  const f = fixture();
  const m = await governedRoot(f, { limits: { active: 2, directChildren: 2, depth: 1 }, allowed: ["provider-defaults"], defaultChild: "provider-defaults" });
  const a = f.board.get((await add(f, m, { title: "A", assignment: { key: "a", outcome: "a" } })).id);
  started(f, a);
  const b = f.board.get((await add(f, m, { title: "B", assignment: { key: "b", outcome: "b" }, after: [a.id] })).id);
  const invariant = () => { assert.ok(m.governed.leases.length <= 2); for (const id of f.board.live()) assert.ok(m.governed.leases.some((l) => l.card === id), `live card ${id} holds a lease`); };
  // The root's turn ends with the approval notice still waiting: it continues at once as a parent continuation, under its own lease.
  settle(f.board, m); f.board.tick(); await sleep(100); f.board.tick();
  invariant();
  assert.ok(f.board.live().includes(m.id), "the continuation runs");
  // That turn ends with nothing waiting: the root yields its lease while A keeps running.
  settle(f.board, m); f.board.tick();
  assert.deepEqual(m.governed.leases.map((l) => l.card), [a.id]);
  invariant();
  // A is cancelled: B is blocked, not released and not queued for a lease.
  settle(f.board, a); f.board.tick();
  f.board.update(a, { cancelled: true, status: "review" });
  assert.match(f.board.governedWait(b), /Blocked: dependency .* failed \(cancelled\)/);
  await assert.rejects(f.board.startHeadless(b), /failed \(cancelled\)/);
  // A's settle is a notice for the root: it continues as a parent continuation, under a lease held for the whole launch.
  await sleep(200); f.board.tick();
  invariant();
});

test("AC-E: no route but integrate (children) and the user's authorized Finish (root) reaches a branch; finish self, self-finish, delivery and plan paths refused; legacy keeps its paths", async () => {
  const f = fixture();
  const m = await governedRoot(f, { limits: LIMITS, allowed: ["provider-defaults"], defaultChild: "provider-defaults" });
  const child = f.board.get((await add(f, m, { assignment: { key: "a", outcome: "a" }, start: "manual" })).id);
  await f.board.ensureWorktree(child);
  const manual = f.board.add("Manual", "x", "acct", child.id);
  for (const t of [m, child, manual]) assert.equal(f.board["deliverable"](t), false, `periodic delivery skips ${t.id}`);
  // Merge: the root never; a child only through integrate's readiness (here: no submission yet). Finish: never a child; the root only with authorization.
  await assert.rejects(f.board.finish(m, "merge"), /Merge is blocked: .* root of governed run/);
  for (const t of [child, manual]) await assert.rejects(f.board.finish(t, "merge"), /is blocked[\s\S]*(no validated submission|no worktree|no opener)/);
  for (const t of [child, manual]) await assert.rejects(f.board.complete(t, async () => true), /belongs to governed run .* reaches the target only through the run/);
  await assert.rejects(f.board.complete(m, async () => true), /Not an explicit authorization/);
  assert.match((await request(f.board, { op: "finish", by: m.id, session: m.sessionId, protocol: 3, self: true })).error, /finish self is blocked: .* not an explicit authorization/);
  const { autoFinish } = require("../out/auto-finish.js");
  f.board.update(m, { status: "review" });
  assert.equal(await autoFinish(f.board, m, { review: async () => { throw new Error("no review"); }, closeTab: async () => {} }), "stopped");
  assert.match(m.selfFinish.error, /Self-finish is blocked/);
  // Plan merges and the plan archival commit: refused for a governed card even if one ever carried planRun (govern refuses plan-file runs).
  const planLike = { ...manual, planRun: { file: "x.plan.json", review: "checks" } };
  assert.match(f.board["archivePlan"](planLike), /plan not archived: Plan archival is blocked/);
  f.board.update(manual, { planRun: { file: "x.plan.json", review: "checks" } });
  assert.equal(f.board["planCanProceed"](manual), false, "mergePlanBranch, mergeStep, finishStandingRoles and planDelivered all stop here");
  assert.equal(await f.board["mergePlanBranch"](manual, "main"), false);
  assert.match(await f.board["finishStandingRoles"](manual), /paused or its board owner changed/);
  f.board.update(manual, { planRun: undefined });
  for (const a of ["deliver", "merge", "self-finish", "finish-self", "plan-merge", "plan-archive"]) {
    const r = await f.board.readiness(child, a);
    assert.deepEqual([r.ok, r.reasons[0].code], [false, "route"], a);
  }
  // Unsupported moves stay blocked in both directions.
  assert.match((await request(f.board, { op: "adopt", by: m.id, session: m.sessionId, protocol: 3, id: manual.id })).error, /not supported/);
  const legacy = f.board.add("Legacy root", "x", "acct", undefined, undefined, undefined, undefined, { orchestrator: { caps: { ...o.DEFAULT_CAPS }, opened: 0 }, headless: true, approved: { at: "now", hash: "h" } });
  await f.board.startHeadless(legacy); started(f, legacy);
  assert.match((await request(f.board, { op: "adopt", by: legacy.id, session: legacy.sessionId, id: child.id })).error, /belongs to governed run/);
  assert.equal(o.targetEffectRefusal(legacy, f.board.tasks, "Finish"), undefined, "a legacy card keeps Finish");
  assert.equal((await f.board.readiness(legacy, "target")).ok, true, "readiness is a no-op for a legacy card");
  await f.board.ensureWorktree(legacy);
  assert.equal(f.board["deliverable"](legacy), true, "a legacy root keeps periodic delivery");
});

test("AC-F: submit is checked against git, the parent is told, Done accepts only the submitted HEAD, and overview serves brief, state and cursor events", async () => {
  const f = fixture();
  const m = await governedRoot(f, { limits: LIMITS, allowed: ["provider-defaults"], defaultChild: "provider-defaults" });
  const child = f.board.get((await add(f, m, { assignment: { key: "export", outcome: "Export", owns: ["a.txt"] } })).id);
  started(f, child);
  const say = (body) => request(f.board, { op: "submit", by: child.id, session: child.sessionId, protocol: 3, ...body });
  fs.writeFileSync(path.join(child.worktree, "a.txt"), "two\n");
  assert.match((await say({ head: "abcdef1", summary: "s" })).error, /dirty tree is never a submission/);
  sh(child.worktree, "commit", "-qam", "export"); const head = sh(child.worktree, "rev-parse", "HEAD");
  assert.match((await say({ head: "1234567", summary: "s" })).error, /not this worktree's HEAD/);
  const ok = await say({ head: head.slice(0, 9), summary: "Export keeps order", claimedChecks: ["npm test"], files: [] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual([child.submission.head, child.submission.files, child.submission.checks, child.submission.checksClaimed], [head, ["a.txt"], "none required", ["npm test"]]);
  assert.match([...f.board["pendingNotices"].get(m.id).values()].join("\n"), /Submission from [\s\S]*claimed, not verified: npm test; changed but not listed: a\.txt/);
  assert.match((await request(f.board, { op: "submit", by: m.id, session: m.sessionId, protocol: 3, head, summary: "x" })).error, /root does not submit/);
  // Done: refused once HEAD moved past the submission; accepted at the submitted HEAD.
  settle(f.board, child); f.board.tick();
  fs.writeFileSync(path.join(child.worktree, "b.txt"), "x\n"); sh(child.worktree, "add", "."); sh(child.worktree, "commit", "-qm", "more");
  assert.match((await request(f.board, { op: "done", by: m.id, session: m.sessionId, protocol: 3, id: child.id })).error, /changed after its submission/);
  sh(child.worktree, "reset", "-q", "--hard", head);
  const done = await request(f.board, { op: "done", by: m.id, session: m.sessionId, protocol: 3, id: child.id });
  assert.equal(done.ok, true, JSON.stringify(done));
  // The overview the CLI serves: the host snapshot plus events after a cursor.
  f.board.publishStatus(true); f.board.publishStatus();
  const out = [];
  const io = (env) => ({ cwd: f.repo, env: { ...env, ENTOMATICAL_REPO: f.repo }, write: (s) => out.push(s), home });
  out.length = 0; await cli.main(["overview", "self"], io({ ENTOMATICAL_TASK: child.id }));
  const snap = JSON.parse(out.join(""));
  assert.equal(snap.brief.root, m.id);
  assert.match(snap.brief.outcome, /Ship the export feature/);
  assert.deepEqual(snap.brief.allowances.limits, LIMITS);
  assert.equal(snap.overview.completed[0].id, child.id);
  assert.equal(snap.overview.completed[0].head, head.slice(0, 12));
  assert.equal(snap.overview.council, "not configured");
  assert.equal(typeof snap.cursor, "number");
  out.length = 0; await cli.main(["overview", "--since", String(snap.cursor)], io({ ENTOMATICAL_TASK: m.id }));
  assert.deepEqual(JSON.parse(out.join("")).events, [], "nothing new after the cursor");
  out.length = 0; await cli.main(["overview", "--since", "1"], io({ ENTOMATICAL_TASK: m.id }));
  const delta = JSON.parse(out.join(""));
  assert.ok(delta.events.length && delta.events.every((e) => e.seq > 1));
  assert.ok(delta.events.some((e) => e.kind === "submission" && e.card === child.id));
  // After compaction an old cursor is expired and gets the snapshot to rebuild from.
  const file = path.join(f.board.dir, "governed", `${m.id}.events.jsonl`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").trim().split("\n").slice(-2).join("\n") + "\n");
  out.length = 0; await cli.main(["overview", "--since", "0"], io({ ENTOMATICAL_TASK: m.id }));
  assert.equal(JSON.parse(out.join("")).expired, true);
  // The caller-filtered catalog: only what this card may delegate.
  out.length = 0; await cli.main(["capabilities"], io({ ENTOMATICAL_TASK: m.id }));
  const caps = JSON.parse(out.join(""));
  assert.equal(caps.protocolVersion, 3);
  assert.deepEqual(caps.governed.delegate.map((d) => d.ref), ["provider-defaults"]);
  out.length = 0; await cli.main(["capabilities"], io({ ENTOMATICAL_TASK: child.id }));
  assert.equal(JSON.parse(out.join("")).governed.note, "a worker opens no cards");
});

test("AC-I: a restart keeps leases until it sees the sessions ended; a window that lost the board reserves nothing; resume re-checks the profile", async () => {
  const f = fixture();
  const m = await governedRoot(f, { limits: LIMITS, allowed: ["provider-defaults"], defaultChild: "provider-defaults" });
  const child = f.board.get((await add(f, m, { assignment: { key: "a", outcome: "a" }, start: "manual" })).id);
  // Another window that does not own the board: its gate refuses before reserving anything.
  const other = new Board(f.repo, path.join(f.repo, "hook.js"), undefined, false); boards.push(other);
  other.accountList = f.board.accountList;
  const fresh = { card: child.id, op: "launch:x", at: new Date().toISOString(), state: "reserved" };
  m.governed.leases.push(fresh); f.board.update(m, {}); // a launch the old owner had just reserved
  // Another live window owns the board now (both boards here share this process, so the owner file names another live pid).
  fs.writeFileSync(path.join(f.board.dir, "owner.json"), JSON.stringify({ pid: process.ppid, at: Date.now() }));
  const c0 = f.board.get(child.id); c0.profile = c0.profile; // unchanged
  assert.throws(() => f.board.gate({ ...c0, id: c0.id }), /window|own/i);
  assert.equal(JSON.parse(fs.readFileSync(f.board.file, "utf8")).find((t) => t.id === m.id).governed.leases.length, 2, "nothing reserved by a window that lost the board");
  // The owner goes away: the new owner reads the persisted leases, sees no live session for the root, and releases only that.
  fs.writeFileSync(path.join(f.board.dir, "owner.json"), JSON.stringify({ pid: 0, at: 0 }));
  other.tick();
  const root2 = other.get(m.id);
  assert.deepEqual(root2.governed.leases.map((l) => l.card), [child.id], "the root's ended session is released; the young reservation is kept within its grace");
  // Resume and switch re-check the authorization: a profile the run never approved is refused before anything moves.
  const c2 = other.get(child.id);
  c2.profile = { mode: "strict", snapshot: { id: "workspace:x", revision: 1, hash: "h", name: "X", variants: {} }, pinnedAt: "now" };
  assert.match(other.governedProblem(c2), /not one governed run .* authorized/);
  c2.profile = { mode: "provider-defaults" };
  assert.equal(other.governedProblem(c2), undefined);
  c2.adopted = true;
  assert.match(other.governedProblem(c2), /Adopted or found sessions are not supported/);
});

test("review fixes: no route moves governed cards out; a legacy holder cannot finish them; ordinary add refuses governed fields; sessions without a lease are counted", async () => {
  const f = fixture();
  const m = await governedRoot(f, { limits: { active: 2, directChildren: 2, depth: 1 }, allowed: ["provider-defaults"], defaultChild: "provider-defaults" });
  const child = f.board.get((await add(f, m, { assignment: { key: "a", outcome: "a" }, start: "manual" })).id);
  const legacy = f.board.add("Legacy root", "x", "acct", undefined, undefined, undefined, undefined, { orchestrator: { caps: { ...o.DEFAULT_CAPS }, opened: 0 }, headless: true, approved: { at: "now", hash: "h" } });
  await f.board.startHeadless(legacy); started(f, legacy);
  // the user's operator handoff and a takeover approval go through moveCards, which refuses before anything moves.
  assert.throws(() => f.board["moveCards"](legacy, [m], { via: "operator", op: "handoff", by: "operator" }), /moving cards into or out of a governed run is not supported/);
  assert.throws(() => f.board["moveCards"](m, [legacy], { via: "operator", op: "handoff", by: "operator" }), /not supported/);
  assert.equal(m.openedBy, undefined);
  // Even if a governed card sat under a legacy card, that card's Finish, Merge and delivery would be refused.
  const held = { ...legacy, id: "f00000" }, under = { ...child, openedBy: held.id };
  assert.match(o.targetEffectRefusal(held, [held, under], "Finish"), /governed card .* sits under card f00000/);
  // An ordinary run's add with governed fields is refused, never ignored.
  assert.match((await request(f.board, { op: "add", by: legacy.id, session: legacy.sessionId, protocol: 3, title: "W", prompt: "P", profile: "provider-defaults" })).error, /need a governed run/);
  // A governed session found running without a lease is counted (here the child, started outside gate).
  const leasesBefore = m.governed.leases.length;
  f.board.terminals.set(child.id, { exitStatus: undefined, options: {} });
  f.board.tick();
  assert.ok(m.governed.leases.some((l) => l.card === child.id && l.op.startsWith("found:")), JSON.stringify(m.governed.leases));
  assert.equal(m.governed.leases.length, leasesBefore + 1);
  f.board.terminals.delete(child.id);
  // A root with a manual subtask made before approval cannot become governed (that subtask would be governed with no pinned profile).
  const r2 = f.board.add("R2", "x", "acct", undefined, undefined, undefined, undefined, { orchestrator: { caps: { ...o.DEFAULT_CAPS }, opened: 0 } });
  f.board.add("Sub", "x", "acct", r2.id);
  assert.throws(() => f.board.govern(r2, { limits: LIMITS, allowed: ["provider-defaults"] }, f.pin), /has opened no card/);
  // A launch that throws gives back its unused reservation at once (resume of a card with no session).
  const c3 = f.board.get((await add(f, m, { title: "C3", assignment: { key: "c3", outcome: "c" }, start: "manual" })).id);
  m.governed.leases.push({ card: c3.id, op: "launch:test", at: new Date().toISOString(), state: "reserved" });
  await assert.rejects(f.board["launchStep"](c3, async () => { throw new Error("simulated failure after gate"); }), /simulated/);
  assert.ok(!m.governed.leases.some((l) => l.card === c3.id), "no reservation left behind by a failed launch");
  // releasable: a failed launch or a cancel ends a reservation even while a launch is marked; otherwise a marked launch keeps it.
  assert.equal(o.releasable({ card: "a00001", op: "x", at: "2026-11-16T00:00:00Z", state: "reserved" }, card("a00001", { launchError: "x", status: "review" }), { live: () => false, starting: () => true, now: 0 }), true);
  // A launch still on its way keeps its reservation past the grace time.
  const l = { card: "a00001", op: "x", at: "2026-11-16T00:00:00Z", state: "reserved" };
  assert.equal(o.releasable(l, card("a00001", { status: "review" }), { live: () => false, starting: () => true, now: Date.parse("2026-11-16T01:00:00Z") }), false);
});

test("review fixes: submitted files always count from where the work left the opener's branch, whatever --base says", async () => {
  const f = fixture();
  const m = await governedRoot(f, { limits: LIMITS, allowed: ["provider-defaults"], defaultChild: "provider-defaults" });
  const child = f.board.get((await add(f, m, { assignment: { key: "x", outcome: "x" } })).id);
  started(f, child);
  for (const n of ["one", "two", "three"]) { fs.writeFileSync(path.join(child.worktree, `${n}.txt`), n); sh(child.worktree, "add", "."); sh(child.worktree, "commit", "-qm", n); }
  const head = sh(child.worktree, "rev-parse", "HEAD"), last = sh(child.worktree, "rev-parse", "HEAD~1");
  const r = await request(f.board, { op: "submit", by: child.id, session: child.sessionId, protocol: 3, head, base: last, summary: "three files" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(child.submission.files.sort(), ["one.txt", "three.txt", "two.txt"]);
  assert.deepEqual([child.submission.claimedBase, child.submission.base !== last], [last, true], "the base shown is the one the files were diffed against");
});

// ---- Phase 4 (master plan sections 10 and 11): integration, authorized target effects, operation recovery, durable requests ----

const WIDE = { limits: { active: 5, directChildren: 4, depth: 2 }, allowed: ["provider-defaults"], defaultChild: "provider-defaults" };
/** A governed child that changed `file`, committed and submitted; its session ended. */
async function submitted(f, m, key, file, text, extra = {}) {
  const c = f.board.get((await add(f, m, { title: key, assignment: { key, outcome: key, owns: [file] }, ...extra })).id);
  assert.ok(c.sessionId, `child ${key} started`);
  started(f, c);
  fs.writeFileSync(path.join(c.worktree, file), text); sh(c.worktree, "add", "."); sh(c.worktree, "commit", "-qm", key);
  const head = sh(c.worktree, "rev-parse", "HEAD");
  const r = await request(f.board, { op: "submit", by: c.id, session: c.sessionId, protocol: 3, head, summary: key });
  assert.equal(r.ok, true, JSON.stringify(r));
  settle(f.board, c); f.board.tick();
  return { c, head };
}
const passChecks = (f, t, revision, clean = true) => f.board.update(t, { completion: { commands: ["true"] }, checks: { status: "complete", run: "", revision, clean } });
const codes = (r) => r.reasons.map((x) => x.code);
const ops = (f) => f.board.operations.list();
const { confirmationFor } = require("../out/finish.js");
const auth = (push = false, acks = []) => async r => ({ by: "user", at: new Date().toISOString(), merge: true, push, acks, confirmed: r && confirmationFor(r, push) });
const finish = (f, m, a = auth()) => f.board.complete(m, async () => true, () => {}, async () => {}, undefined, { authorize: a });
function withRemote(f) {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-governed-remote-")); made.push(bare);
  sh(bare, "init", "-q", "--bare", "-b", "main");
  sh(f.repo, "remote", "add", "origin", bare); sh(f.repo, "push", "-q", "-u", "origin", "main");
  return bare;
}
/** A second clone of the remote, to move it as someone else would. */
function otherClone(bare) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-governed-clone-")); made.push(dir);
  execFileSync("git", ["clone", "-q", bare, dir]); sh(dir, "config", "user.email", "o@o"); sh(dir, "config", "user.name", "o");
  return dir;
}
/** The root's session ended, its worktree clean, checks passed at its HEAD: everything Finish needs but the user's authorization. */
function readyRoot(f, m) { f.board["pendingNotices"].delete(m.id); settle(f.board, m); f.board.tick(); assert.ok(!f.board.live().includes(m.id), "the root stays stopped"); const cand = sh(m.worktree, "rev-parse", "HEAD"); passChecks(f, m, cand); return cand; }

// Exercise the extension's real prompts and Board methods with disposable repositories and a scripted modal.
function governedDialogs(warning) {
  const filename = require.resolve("../out/extension.js"), extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = name => {
    if (name === "vscode") return { window: { showWarningMessage: warning } };
    if (name === "./git" || name === "./finish") return require(`../out/${name.slice(2)}.js`);
    return name.startsWith("./") ? {} : require(name);
  };
  extension._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports = { handle, governedAuthorization };", filename);
  return extension.exports;
}

test("Finish expires a displayed candidate even when its replacement passes all checks", async () => {
  const f = fixture(), bare = withRemote(f), m = await governedRoot(f, WIDE);
  await f.board.ensureWorktree(m);
  sh(m.worktree, "commit", "--allow-empty", "-qm", "first candidate");
  const shown = readyRoot(f, m), before = sh(f.repo, "rev-parse", "HEAD");
  let replacement, pushes = 0;
  const push = f.board.pushStep;
  f.board.pushStep = (...args) => { pushes++; return push(...args); };
  const dialog = governedDialogs(async (_message, options, ...buttons) => {
    assert.ok(options.detail.includes(shown.slice(0, 12)));
    sh(m.worktree, "commit", "--allow-empty", "-qm", "replacement candidate");
    replacement = sh(m.worktree, "rev-parse", "HEAD");
    passChecks(f, m, replacement);
    return buttons.find(b => b.includes("and push"));
  });
  const error = await finish(f, m, dialog.governedAuthorization).then(() => "", e => e.message);
  assert.deepEqual([sh(f.repo, "rev-parse", "HEAD"), sh(bare, "rev-parse", "main"), pushes], [before, before, 0]);
  assert.match(error, /confirmation.*expired/i);
  assert.ok(error.includes(replacement.slice(0, 12)));
});

test("Integrate expires the displayed destination when it advances during the modal", async () => {
  const f = fixture(), m = await governedRoot(f, WIDE);
  await f.board.ensureWorktree(m);
  const { c } = await submitted(f, m, "one", "revision.txt", "one\n");
  let replacement, merges = 0;
  const merge = f.board.integrationMerge;
  f.board.integrationMerge = (...args) => { merges++; return merge(...args); };
  const dialog = governedDialogs(async (_message, options) => {
    assert.ok(options.detail.includes(c.submission.head.slice(0, 12)));
    sh(m.worktree, "commit", "--allow-empty", "-qm", "destination advanced");
    replacement = sh(m.worktree, "rev-parse", "HEAD");
    return "Integrate";
  });
  const error = await dialog.handle(f.board, { type: "merge", id: c.id }).then(() => "", e => e.message);
  assert.deepEqual([sh(m.worktree, "rev-parse", "HEAD"), merges], [replacement, 0]);
  assert.match(error, /confirmation.*expired/i);
  assert.ok(error.includes(replacement.slice(0, 12)));
});

test("Finish compares each confirmed fact at the final Git boundary, including the acknowledged condition", async t => {
  const f = fixture(), bare = withRemote(f), m = await governedRoot(f, WIDE);
  await f.board.ensureWorktree(m);
  sh(m.worktree, "commit", "--allow-empty", "-qm", "candidate");
  const cand = readyRoot(f, m), before = sh(bare, "rev-parse", "main");
  const git = require("../out/git.js"), realGit = git.git;
  let merges = 0, pushes = 0;
  t.mock.method(git, "git", (cwd, args) => {
    if (cwd === f.repo && args[0] === "merge") merges++;
    return realGit(cwd, args);
  });
  f.board.pushStep = async () => { pushes++; };
  const uncertain = f.board.operations.open({ kind: "target", card: m.id, run: m.id, actor: "user", pre: { ref: "main" } });
  f.board.operations.set(uncertain, { state: "uncertain", result: { reason: "original condition" } });
  const read = f.board.readiness.bind(f.board);
  const dialog = governedDialogs(async (message, options, ...buttons) => {
    if (message.startsWith("Acknowledge")) { assert.match(options.detail, /original condition/); return "Acknowledge"; }
    assert.ok(options.detail.includes(cand) && options.detail.includes(before));
    return buttons.find(b => b.includes("and push"));
  });
  for (const mutate of [
    r => { r.action = "integrate"; }, r => { r.card = "another-card"; }, r => { r.run = "another-run"; },
    r => { r.candidate = before; }, r => { r.target.ref = "other"; }, r => { r.target.sha = cand; },
    r => { r.target.remote = "other/main"; }, r => { r.target.remoteSha = null; },
    r => { r.target.pushIdentity = "changed"; }, r => { r.reasons[0].text = "changed condition with the same acknowledgement code"; },
    r => { r.reasons = []; },
  ]) {
    let atBoundary = false;
    f.board.readiness = async (...args) => {
      const r = await read(...args);
      if (args[4]) { assert.ok(r.ok); mutate(r); atBoundary = true; }
      return r;
    };
    await assert.rejects(finish(f, m, dialog.governedAuthorization), /confirmation has expired/);
    assert.ok(atBoundary);
    assert.equal(f.board.operations.get(uncertain.id).state, "uncertain");
  }
  assert.deepEqual([merges, pushes, sh(f.repo, "rev-parse", "HEAD"), sh(bare, "rev-parse", "main")], [0, 0, before, before]);
  assert.equal(ops(f).filter(op => op.id !== uncertain.id && op.state === "abandoned").length, 11);
});

test("Integrate expires an acknowledgement revised after the first prompt and a submission replaced during confirmation", async () => {
  const f = fixture(), m = await governedRoot(f, WIDE);
  await f.board.ensureWorktree(m);
  const { c } = await submitted(f, m, "one", "revision.txt", "one\n");
  const before = sh(m.worktree, "rev-parse", "HEAD");
  const op = f.board.operations.open({ kind: "integrate", card: c.id, run: m.id, actor: "user", pre: { into: m.id } });
  f.board.operations.set(op, { state: "uncertain", result: { reason: "first condition" } });
  let merges = 0;
  f.board.integrationMerge = async () => { merges++; throw new Error("unexpected merge"); };
  for (const change of ["acknowledgement", "submission"]) {
    const modal = governedDialogs(async (message, options) => {
      if (message.startsWith("Acknowledge")) return "Acknowledge";
      assert.ok(options.detail.includes(c.submission.head));
      if (change === "acknowledgement") f.board.operations.set(op, { state: "uncertain", result: { reason: "revised condition" } });
      else {
        sh(c.worktree, "commit", "--allow-empty", "-qm", "new submission");
        const head = sh(c.worktree, "rev-parse", "HEAD");
        assert.equal((await f.board.submit(c, { head, summary: "new submission" })).ok, true);
      }
      return "Integrate";
    });
    const error = await modal.handle(f.board, { type: "merge", id: c.id }).then(() => "", e => e.message);
    assert.match(error, /confirmation has expired/);
    assert.ok(error.includes(change === "acknowledgement" ? "revised condition" : c.submission.head));
    assert.equal(f.board.operations.get(op.id).state, "uncertain");
  }
  assert.deepEqual([merges, sh(m.worktree, "rev-parse", "HEAD"), ops(f).length], [0, before, 1]);
});

test("Integrate checks the destination card, branch and acknowledged condition at the last read, then integrates an unchanged decision once", async () => {
  const f = fixture(), m = await governedRoot(f, WIDE);
  await f.board.ensureWorktree(m);
  const { c, head } = await submitted(f, m, "one", "revision.txt", "one\n");
  const before = sh(m.worktree, "rev-parse", "HEAD");
  const uncertain = f.board.operations.open({ kind: "integrate", card: c.id, run: m.id, actor: "user", pre: { into: m.id } });
  f.board.operations.set(uncertain, { state: "uncertain", result: { reason: "original condition" } });
  const dialog = governedDialogs(async (message, options) => {
    if (message.startsWith("Acknowledge")) { assert.match(options.detail, /original condition/); return "Acknowledge"; }
    for (const fact of [c.id, m.id, head, before, m.branch]) assert.ok(options.detail.includes(fact), fact);
    return "Integrate";
  });
  const read = f.board.readiness.bind(f.board), merge = f.board.integrationMerge;
  const merges = [];
  f.board.integrationMerge = (...args) => { merges.push(args.slice(0, 2)); return merge(...args); };
  for (const mutate of [r => { r.destination.card = "other"; }, r => { r.destination.branch = "other"; },
    r => { r.reasons[0].text = "changed condition"; }]) {
    f.board.readiness = async (...args) => { const r = await read(...args); if (args[4]) mutate(r); return r; };
    await assert.rejects(dialog.handle(f.board, { type: "merge", id: c.id }), /confirmation has expired/);
    assert.equal(f.board.operations.get(uncertain.id).state, "uncertain");
  }
  assert.deepEqual([merges.length, sh(m.worktree, "rev-parse", "HEAD")], [0, before]);
  f.board.readiness = read;
  await dialog.handle(f.board, { type: "merge", id: c.id });
  assert.deepEqual(merges, [[m.worktree, head]]);
  assert.equal(f.board.operations.get(uncertain.id).state, "abandoned");
});

test("Finish honors the selected local or push button against distinct fetch and push destinations", async () => {
  for (const choice of ["local", "push", "unavailable"]) {
    const f = fixture(), fetchRepo = withRemote(f), pushRepo = otherClone(fetchRepo);
    sh(pushRepo, "config", "receive.denyCurrentBranch", "updateInstead");
    sh(f.repo, "remote", "set-url", "--push", "origin", choice === "unavailable" ? path.join(pushRepo, "missing") : pushRepo);
    const m = await governedRoot(f, WIDE);
    await f.board.ensureWorktree(m);
    sh(m.worktree, "commit", "--allow-empty", "-qm", "first candidate");
    const previous = sh(m.worktree, "rev-parse", "HEAD");
    sh(m.worktree, "push", "-q", pushRepo, "HEAD:main");
    sh(m.worktree, "commit", "--allow-empty", "-qm", "second candidate");
    const cand = readyRoot(f, m), before = sh(fetchRepo, "rev-parse", "main");
    const dialog = governedDialogs(async (_message, options, ...buttons) => {
      if (choice === "unavailable") assert.deepEqual(buttons, ["Merge into main"]);
      else {
        assert.deepEqual(buttons, ["Merge into main", "Merge and push to origin/main"]);
        assert.ok(options.detail.includes(previous), "shows the push repository's revision");
      }
      return buttons[choice === "push" ? 1 : 0];
    });
    await finish(f, m, dialog.governedAuthorization);
    assert.deepEqual([sh(f.repo, "rev-parse", "main"), sh(fetchRepo, "rev-parse", "main"), sh(pushRepo, "rev-parse", "main")],
      [cand, before, choice === "push" ? cand : previous]);
    assert.equal(ops(f).find(x => x.kind === "target").authorization.push, choice === "push");
  }
});

test("root Finish binds the local write to the confirmed branch and old tip before sending a selected push", async t => {
  for (const push of [false, true]) for (const race of ["switch", "advance"]) await t.test(`${push ? "push first" : "merge only"}, ${race}`, async t => {
    const f = fixture(), bare = withRemote(f), m = await governedRoot(f, WIDE);
    await f.board.ensureWorktree(m);
    const before = sh(f.repo, "rev-parse", "main");
    sh(f.repo, "branch", "other", before);
    sh(m.worktree, "commit", "--allow-empty", "-qm", "eligible intermediate");
    const intermediate = sh(m.worktree, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(m.worktree, "from-root"), "confirmed\n");
    sh(m.worktree, "add", "from-root"); sh(m.worktree, "commit", "-qm", "root candidate");
    readyRoot(f, m);
    const wt = m.worktree;
    let armed = false, raced = false;
    const send = t.mock.method(f.board, "pushStep");
    const move = () => {
      raced = true;
      if (race === "switch") sh(f.repo, "switch", "-q", "other");
      else sh(wt, "update-ref", "refs/heads/main", intermediate, before);
    };
    const git = require("../out/git.js"), realGit = git.git;
    t.mock.method(git, "git", (cwd, args, ...rest) => {
      if (armed && !raced && cwd === f.repo && (args[0] === "merge" || (race === "switch" && args.includes("--git-path") && args.includes("index")))) move();
      return realGit(cwd, args, ...rest);
    });
    const cp = require("child_process"), spawn = cp.spawn;
    t.mock.method(cp, "spawn", (file, args, options) => {
      if (armed && !raced && race === "advance" && options.cwd === wt && args.includes("update-ref")) move();
      return spawn(file, args, options);
    });
    const authorize = governedDialogs(async (_msg, _opts, ...buttons) => buttons[push ? 1 : 0]).governedAuthorization;
    const outcome = await f.board.complete(m, async () => true, stage => { if (stage === "Locking main for Finish" || stage === "Updating main") armed = true; },
      async () => {}, undefined, { authorize }).then(notes => notes.join("\n"), e => e.message);
    assert.ok(raced);
    assert.deepEqual([sh(f.repo, "rev-parse", "other"), sh(f.repo, "rev-parse", "main"), sh(bare, "rev-parse", "main")],
      [before, race === "advance" ? intermediate : before, before]);
    assert.equal(send.mock.callCount(), 0);
    assert.match(outcome, /confirmation has expired/i);
    assert.equal(fs.existsSync(path.join(f.repo, "from-root")), false);
    assert.equal(sh(f.repo, "diff", "--cached", "--name-only"), "");
    const op = ops(f).find(x => x.kind === "target");
    assert.deepEqual([op.state, fs.existsSync(wt), Boolean(m.merged)], ["abandoned", true, false]);
  });
});

test("root Finish keeps the local guards through the push and fast-forward, and records a partial checkout for recovery", async t => {
  for (const partial of [false, true]) await t.test(partial ? "interrupted after push" : "successful push and local update", async t => {
    const f = fixture(), bare = withRemote(f), m = await governedRoot(f, WIDE);
    await f.board.ensureWorktree(m);
    const wt = m.worktree, before = sh(f.repo, "rev-parse", "main");
    sh(f.repo, "branch", "other");
    fs.writeFileSync(path.join(wt, "from-root"), "confirmed\n");
    sh(wt, "add", "from-root"); sh(wt, "commit", "-qm", "root candidate");
    const candidate = readyRoot(f, m), push = f.board.pushStep;
    let pushes = 0;
    f.board.pushStep = (...args) => {
      pushes++;
      assert.throws(() => sh(f.repo, "switch", "other"), /index.lock/);
      assert.throws(() => sh(f.repo, "symbolic-ref", "HEAD", "refs/heads/other"), /HEAD.lock/);
      assert.throws(() => sh(wt, "update-ref", "refs/heads/main", candidate, before), /cannot lock ref/i);
      return push(...args);
    };
    const git = require("../out/git.js"), realGit = git.git;
    t.mock.method(git, "git", async (cwd, args, env) => {
      if (cwd === f.repo && args[0] === "read-tree" && !args.includes("-n")) {
        assert.equal(sh(bare, "rev-parse", "main"), candidate, "remote has accepted the push before local files are installed");
        assert.throws(() => sh(f.repo, "switch", "other"), /index.lock/);
        assert.throws(() => sh(wt, "update-ref", "refs/heads/main", candidate, before), /cannot lock ref/i);
      }
      const result = await realGit(cwd, args, env);
      if (partial && cwd === f.repo && args[0] === "read-tree" && !args.includes("-n")) throw new Error("interrupted root checkout");
      return result;
    });
    const run = finish(f, m, auth(true));
    if (partial) await assert.rejects(run, /Pushed .*Local checkout needs inspection.*prepared index.*interrupted root checkout/);
    else await run;
    const op = ops(f).find(x => x.kind === "target");
    assert.deepEqual([pushes, op.result.remote, sh(bare, "rev-parse", "main"), sh(f.repo, "rev-parse", "other")], [1, candidate, candidate, before]);
    assert.deepEqual([sh(f.repo, "rev-parse", "main"), sh(f.repo, "write-tree")],
      [partial ? before : candidate, sh(f.repo, "rev-parse", (partial ? before : candidate) + "^{tree}")]);
    if (partial) {
      assert.deepEqual([op.state, fs.existsSync(wt), Boolean(m.merged)], ["uncertain", true, false]);
      // A crash before the error was journalled leaves the same refs and the earlier prepared record.
      f.board.operations.set(op, { state: "prepared", result: { remote: candidate } });
      await f.board.reconcileOperations();
      assert.equal(f.board.operations.get(op.id).state, "uncertain");
      assert.ok(fs.existsSync(wt));
    } else assert.deepEqual([op.state, op.result.localUpdated, m.merged], ["committed", true, true]);
  });
});

test("a root checkout obstruction preserves the user's file and prevents the selected push", async t => {
  const f = fixture(), bare = withRemote(f), m = await governedRoot(f, WIDE);
  await f.board.ensureWorktree(m);
  const before = sh(f.repo, "rev-parse", "main");
  fs.writeFileSync(path.join(m.worktree, "from-root"), "candidate\n");
  sh(m.worktree, "add", "from-root"); sh(m.worktree, "commit", "-qm", "root candidate");
  readyRoot(f, m);
  fs.writeFileSync(path.join(f.repo, "from-root"), "user file\n");
  const send = t.mock.method(f.board, "pushStep");
  await assert.rejects(finish(f, m, auth(true)), /confirmation has expired/);
  assert.deepEqual([send.mock.callCount(), sh(bare, "rev-parse", "main"), sh(f.repo, "rev-parse", "main")], [0, before, before]);
  assert.equal(fs.readFileSync(path.join(f.repo, "from-root"), "utf8"), "user file\n");
  assert.equal(sh(f.repo, "diff", "--cached", "--name-only"), "");
  assert.equal(ops(f).find(x => x.kind === "target").state, "abandoned");
  assert.ok(fs.existsSync(m.worktree));
});

test("Finish expires an eligible remote advance at the actual push, including an advance to the candidate", async t => {
  for (const race of ["ancestor", "candidate", "branch created"]) await t.test(race, async () => {
    const f = fixture(), bare = withRemote(f), m = await governedRoot(f, WIDE);
    await f.board.ensureWorktree(m);
    const target = race === "branch created" ? "new-target" : "main";
    sh(f.repo, "config", "branch.main.merge", `refs/heads/${target}`);
    sh(m.worktree, "commit", "--allow-empty", "-qm", "eligible intermediate");
    const intermediate = sh(m.worktree, "rev-parse", "HEAD");
    sh(m.worktree, "commit", "--allow-empty", "-qm", "confirmed candidate");
    const candidate = readyRoot(f, m), before = sh(f.repo, "rev-parse", "main");
    const moved = race === "candidate" ? candidate : intermediate;
    const push = f.board.pushStep;
    let attempts = 0;
    f.board.pushStep = (...args) => {
      attempts++;
      sh(m.worktree, "push", "-q", bare, `${moved}:refs/heads/${target}`);
      return push(...args);
    };
    const dialog = governedDialogs(async (_message, _options, ...buttons) => buttons.find(b => b.includes("and push")));
    const error = await finish(f, m, dialog.governedAuthorization).then(() => "", e => e.message);
    assert.deepEqual([attempts, sh(f.repo, "rev-parse", "main"), sh(bare, "rev-parse", target)], [1, before, moved]);
    assert.match(error, /confirmation has expired/i);
    assert.ok(error.includes(moved));
    assert.equal(ops(f).find(op => op.kind === "target").state, "abandoned");
    assert.ok(fs.existsSync(m.worktree));
  });
});

test("Integrate rechecks the real checkout at the merge adapter after final readiness", async t => {
  for (const race of ["switch branch at same tip", "advance same branch"]) await t.test(race, async t => {
    const f = fixture(), m = await governedRoot(f, WIDE);
    await f.board.ensureWorktree(m);
    const { c } = await submitted(f, m, "one", "revision.txt", "one\n");
    const before = sh(m.worktree, "rev-parse", "HEAD"), merge = f.board.integrationMerge;
    let current, branch, mergeCommands = 0;
    const git = require("../out/git.js"), realGit = git.git;
    t.mock.method(git, "git", (cwd, args) => {
      if (cwd === m.worktree && args[0] === "merge") mergeCommands++;
      return realGit(cwd, args);
    });
    f.board.integrationMerge = (...args) => {
      if (race.startsWith("switch")) sh(m.worktree, "switch", "-qc", "other-destination");
      else sh(m.worktree, "commit", "--allow-empty", "-qm", "destination advanced");
      current = sh(m.worktree, "rev-parse", "HEAD");
      branch = sh(m.worktree, "branch", "--show-current");
      return merge(...args);
    };
    const dialog = governedDialogs(async () => "Integrate");
    const error = await dialog.handle(f.board, { type: "merge", id: c.id }).then(() => "", e => e.message);
    assert.deepEqual([mergeCommands, sh(m.worktree, "rev-parse", branch), sh(m.worktree, "rev-parse", m.branch)],
      [0, current, branch === m.branch ? current : before]);
    assert.match(error, /confirmation has expired/i);
    assert.ok(error.includes(branch) && error.includes(current));
    assert.equal(ops(f).find(op => op.kind === "integrate").state, "abandoned");
    assert.ok(fs.existsSync(c.worktree));
  });
});

test("the push adapter proves ancestry before invoking push and only creates a confirmed absent branch", async t => {
  const f = fixture(), bare = withRemote(f), base = sh(f.repo, "rev-parse", "HEAD");
  sh(f.repo, "commit", "--allow-empty", "-qm", "new tip");
  const tip = sh(f.repo, "rev-parse", "HEAD");
  sh(f.repo, "push", "-q", bare, "HEAD:refs/heads/main");
  // A regression in the ancestry check is observable without allowing any non-fast-forward in this fixture.
  sh(bare, "config", "receive.denyNonFastForwards", "true");
  const git = require("../out/git.js"), realGit = git.git;
  let sends = 0;
  t.mock.method(git, "git", (cwd, args) => { if (args.includes("push")) sends++; return realGit(cwd, args); });
  await assert.rejects(f.board.pushStep(f.repo, bare, "main", base, tip), /cannot fast-forward/i);
  assert.deepEqual([sends, sh(bare, "rev-parse", "main")], [0, tip]);
  await f.board.pushStep(f.repo, bare, "new-target", tip, null);
  assert.deepEqual([sends, sh(bare, "rev-parse", "new-target")], [1, tip]);
});

test("Integrate never writes through a checkout switched after inspecting its status", async t => {
  const f = fixture(), m = await governedRoot(f, WIDE);
  await f.board.ensureWorktree(m);
  const { c } = await submitted(f, m, "one", "revision.txt", "child\n");
  const before = sh(m.worktree, "rev-parse", "HEAD");
  const git = require("../out/git.js"), realGit = git.git;
  let switched = false;
  t.mock.method(git, "git", async (cwd, args, ...rest) => {
    const result = await realGit(cwd, args, ...rest);
    if (!switched && cwd === m.worktree && (args.includes("--porcelain=v2") || args.includes("commit-tree"))) {
      switched = true;
      sh(cwd, "switch", "-qc", "other-destination");
      fs.writeFileSync(path.join(cwd, "keep"), "other branch work\n");
    }
    return result;
  });
  const error = await governedDialogs(async () => "Integrate").handle(f.board, { type: "merge", id: c.id }).then(() => "", e => e.message);
  assert.ok(switched);
  assert.deepEqual([sh(m.worktree, "rev-parse", m.branch), sh(m.worktree, "rev-parse", "other-destination")], [before, before]);
  assert.match(error, /confirmation has expired/i);
  assert.equal(sh(m.worktree, "diff", "--cached", "--name-only"), "");
  assert.equal(fs.readFileSync(path.join(m.worktree, "keep"), "utf8"), "other branch work\n");
  assert.equal(fs.existsSync(path.join(m.worktree, "revision.txt")), false);
  await f.board.reconcileOperations();
  assert.ok(!c.integrated && fs.existsSync(c.worktree));
});

test("a destination advance at ref preparation expires the decision even if the new tip contains the child", async t => {
  const f = fixture(), m = await governedRoot(f, WIDE);
  await f.board.ensureWorktree(m);
  const { c, head } = await submitted(f, m, "one", "revision.txt", "child\n");
  const before = sh(m.worktree, "rev-parse", "HEAD");
  const cp = require("child_process"), spawn = cp.spawn;
  let raced = false;
  t.mock.method(cp, "spawn", (file, args, options) => {
    if (!raced && file === "git" && args.includes("update-ref") && options.cwd === f.repo) {
      raced = true;
      sh(f.repo, "update-ref", `refs/heads/${m.branch}`, head, before);
    }
    return spawn(file, args, options);
  });
  await assert.rejects(governedDialogs(async () => "Integrate").handle(f.board, { type: "merge", id: c.id }), /confirmation has expired/);
  assert.ok(raced);
  assert.deepEqual([sh(m.worktree, "rev-parse", "HEAD"), sh(m.worktree, "write-tree")], [head, sh(f.repo, "rev-parse", before + "^{tree}")]);
  assert.equal(fs.existsSync(path.join(m.worktree, "revision.txt")), false);
  const op = ops(f).find(x => x.kind === "integrate");
  assert.equal(op.state, "abandoned");
  // A crash before recording this refusal must not adopt an unrelated writer's result from ancestry alone.
  f.board.operations.set(op, { state: "prepared" });
  await f.board.reconcileOperations();
  assert.equal(f.board.operations.get(op.id).state, "uncertain");
  assert.ok(!c.integrated && fs.existsSync(c.worktree));
});

test("the checkout, index and named ref stay locked while the real working files are updated", async t => {
  const f = fixture(), m = await governedRoot(f, WIDE);
  await f.board.ensureWorktree(m);
  const { c, head } = await submitted(f, m, "one", "revision.txt", "child\n");
  const before = sh(m.worktree, "rev-parse", "HEAD");
  sh(m.worktree, "branch", "other-destination");
  const git = require("../out/git.js"), realGit = git.git;
  let tested = false;
  t.mock.method(git, "git", async (cwd, args, env) => {
    if (cwd === m.worktree && args[0] === "read-tree" && !args.includes("-n")) {
      tested = true;
      assert.throws(() => sh(cwd, "switch", "other-destination"), /index.lock/);
      assert.throws(() => sh(cwd, "symbolic-ref", "HEAD", "refs/heads/other-destination"), /HEAD.lock/);
      assert.throws(() => sh(f.repo, "update-ref", `refs/heads/${m.branch}`, head, before), /cannot lock ref/i);
    }
    return realGit(cwd, args, env);
  });
  const result = await f.board.integrate(c);
  assert.ok(tested && result.ok);
  assert.deepEqual([sh(m.worktree, "rev-parse", "other-destination"), sh(m.worktree, "rev-parse", "HEAD"), c.integrated.after],
    [before, result.after, result.after]);
  assert.deepEqual(sh(m.worktree, "show", "-s", "--format=%P", result.after).split(" "), [before, head]);
  assert.equal(sh(m.worktree, "status", "--porcelain"), "");
});

test("checkout obstructions preserve user data; a partial checkout retains the child and requires manual recovery", async t => {
  for (const obstruction of ["untracked file", "late staged edit", "partial checkout"]) await t.test(obstruction, async t => {
    const f = fixture(), m = await governedRoot(f, WIDE);
    await f.board.ensureWorktree(m);
    const { c } = await submitted(f, m, "one", "revision.txt", "child\n");
    const before = sh(m.worktree, "rev-parse", "HEAD");
    const index = sh(m.worktree, "rev-parse", "--path-format=absolute", "--git-path", "index");
    const file = path.join(m.worktree, "revision.txt"), git = require("../out/git.js"), realGit = git.git;
    t.mock.method(git, "git", async (cwd, args, env) => {
      const result = await realGit(cwd, args, env);
      if (cwd !== m.worktree) return result;
      if (args.includes("commit-tree") && obstruction !== "partial checkout") {
        fs.writeFileSync(file, "user data\n");
        if (obstruction === "late staged edit") sh(cwd, "add", "revision.txt");
      }
      if (obstruction === "partial checkout" && args[0] === "read-tree" && !args.includes("-n")) throw new Error("interrupted checkout");
      return result;
    });
    const partial = obstruction === "partial checkout";
    await assert.rejects(f.board.integrate(c), partial ? /prepared index.*interrupted checkout/ : /confirmation has expired/);
    await f.board.reconcileOperations();
    const op = ops(f).find(x => x.kind === "integrate");
    assert.equal(op.state, partial ? "uncertain" : "abandoned");
    assert.deepEqual([sh(m.worktree, "rev-parse", "HEAD"), fs.readFileSync(file, "utf8"), fs.existsSync(index + ".lock")],
      [before, partial ? "child\n" : "user data\n", false]);
    assert.equal(sh(m.worktree, "diff", "--cached", "--name-only"), obstruction === "late staged edit" ? "revision.txt" : "");
    assert.ok(!c.integrated && fs.existsSync(c.worktree));
    if (partial) {
      // An interrupted process could have left the journal at prepared with the live ref still unchanged.
      f.board.operations.set(op, { state: "prepared" });
      await f.board.reconcileOperations();
      assert.equal(f.board.operations.get(op.id).state, "uncertain");
    }
  });
});

test("AC-E integrate: exact submitted commit into the opener's branch only after readiness (live, dirty destination, checks, dependency, opener); receipts and staleness", async () => {
  const f = fixture();
  const m = await governedRoot(f, WIDE);
  await f.board.ensureWorktree(m);
  const a = f.board.get((await add(f, m, { title: "A", assignment: { key: "a", outcome: "A", owns: ["a.txt"] } })).id);
  started(f, a);
  fs.writeFileSync(path.join(a.worktree, "a.txt"), "A\n"); sh(a.worktree, "commit", "-qam", "A");
  const head = sh(a.worktree, "rev-parse", "HEAD");
  assert.equal((await request(f.board, { op: "submit", by: a.id, session: a.sessionId, protocol: 3, head, summary: "A" })).ok, true);
  const b = f.board.get((await add(f, m, { title: "B", assignment: { key: "b", outcome: "B" }, after: [a.id], start: "manual" })).id);
  assert.ok(codes(await f.board.readiness(a, "integrate")).includes("live"), "a running child is not integrated (its worktree goes afterwards)");
  settle(f.board, a); f.board.tick();
  // Checks bound to the exact submitted revision.
  f.board.update(a, { completion: { commands: ["true"] } });
  assert.ok(codes(await f.board.readiness(a, "integrate")).includes("checks"));
  passChecks(f, a, "0".repeat(40));
  assert.ok(codes(await f.board.readiness(a, "integrate")).includes("checks-stale"));
  passChecks(f, a, head);
  // Dirty destination.
  fs.writeFileSync(path.join(m.worktree, "a.txt"), "local edit\n");
  assert.ok(codes(await f.board.readiness(a, "integrate")).includes("destination-dirty"));
  sh(m.worktree, "checkout", "--", "a.txt");
  // Dependency not completed.
  await f.board.ensureWorktree(b); fs.writeFileSync(path.join(b.worktree, "b.txt"), "B\n"); sh(b.worktree, "add", "."); sh(b.worktree, "commit", "-qm", "B");
  f.board.update(b, { submission: { head: sh(b.worktree, "rev-parse", "HEAD"), base: sh(m.worktree, "rev-parse", "HEAD"), summary: "B", files: ["b.txt"], checks: "none required", at: "now" } });
  assert.ok(codes(await f.board.readiness(b, "integrate")).includes("dependency"));
  // Only the opener (or the user) integrates; the root has no destination.
  assert.match((await request(f.board, { op: "integrate", by: m.id, session: m.sessionId, id: a.id })).error, /needs board.js protocol 3/);
  assert.ok(codes(await f.board.readiness(a, "integrate", undefined, b.id)).includes("actor"));
  assert.deepEqual(codes(await f.board.readiness(m, "integrate")), ["root"]);
  const ready = await f.board.readiness(a, "integrate", undefined, m.id);
  assert.deepEqual([ready.ok, ready.candidate, ready.destination.card], [true, head, m.id], JSON.stringify(ready));
  const r = await request(f.board, { op: "integrate", by: m.id, session: m.sessionId, protocol: 3, id: a.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  const rootHead = sh(m.worktree, "rev-parse", "HEAD");
  sh(m.worktree, "merge-base", "--is-ancestor", head, rootHead);
  assert.equal(sh(m.worktree, "rev-list", "--count", "--merges", `${r.integrated?.before ?? a.integrated.before}..${rootHead}`), "1", "one merge commit");
  assert.deepEqual([a.status, a.merged, a.integrated.head, a.integrated.after, a.integrated.into, a.worktree], ["done", true, head, rootHead, m.id, undefined]);
  const op = ops(f).find((x) => x.id === a.integrated.op);
  assert.deepEqual([op.kind, op.state, op.cleanup, op.pre.head, op.result.after], ["integrate", "committed", "done", head, rootHead]);
  assert.ok(fs.readFileSync(path.join(f.board.dir, "governed", `${m.id}.events.jsonl`), "utf8").includes('"kind":"integrated"'));
  // The same integration again does nothing more; B is now integrable (its dependency completed).
  assert.ok(codes(await f.board.readiness(a, "integrate")).includes("state"));
  assert.ok(!codes(await f.board.readiness(b, "integrate")).includes("dependency"));
  // the user's Merge on a governed child is the same integration.
  await f.board.finish(b, "merge", confirmationFor(await f.board.readiness(b, "integrate")));
  assert.equal(b.integrated.into, m.id);
  sh(m.worktree, "merge-base", "--is-ancestor", b.submission.head, "HEAD");
});

test("AC-E conflict: an integration that conflicts changes nothing, keeps the child's work and tells the opener; overlap is reported before", async () => {
  const f = fixture();
  const m = await governedRoot(f, WIDE);
  await f.board.ensureWorktree(m);
  const one = await submitted(f, m, "one", "a.txt", "uno\n");
  const two = await submitted(f, m, "two", "a.txt", "dos\n");
  const ready = await f.board.readiness(one.c, "integrate");
  assert.ok(ready.notes.some((n) => n.includes(`overlaps ${two.c.id}`) && n.includes("a.txt")), JSON.stringify(ready.notes));
  assert.equal((await f.board.integrate(one.c)).ok, true);
  const before = sh(m.worktree, "rev-parse", "HEAD");
  const r = await f.board.integrate(two.c);
  assert.deepEqual(r.conflict, ["a.txt"]);
  assert.match(r.error, /Nothing changed/);
  assert.equal(sh(m.worktree, "rev-parse", "HEAD"), before, "the run branch is as it was");
  assert.equal(sh(m.worktree, "status", "--porcelain"), "", "the merge was aborted cleanly");
  assert.deepEqual([two.c.status !== "done", fs.existsSync(two.c.worktree), sh(two.c.worktree, "rev-parse", "HEAD"), two.c.conflict.files], [true, true, two.head, ["a.txt"]]);
  assert.deepEqual(ops(f).find((x) => x.id === r.op).result.outcome, "conflict");
  assert.match([...f.board["pendingNotices"].get(m.id).values()].join("\n"), /conflicts in a\.txt/);
  // The next reconciliation pass must not take the conflict for a committed integration whose cleanup is left (linux F112 check, 18 November 2026).
  const wt = two.c.worktree, branch = two.c.branch;
  await f.board.reconcileOperations();
  assert.deepEqual([fs.existsSync(wt), two.c.worktree, two.c.branch, sh(f.repo, "branch", "--list", branch) !== ""], [true, wt, branch, true], "the conflicted child keeps its worktree and branch");
  assert.equal(sh(wt, "rev-parse", "HEAD"), two.head);
});

test("AC-E target: the user's Finish fast-forwards the exact candidate only after members, combined checks, clean root and target pass; push is a separate grant", async () => {
  const f = fixture();
  const bare = withRemote(f);
  const m = await governedRoot(f, WIDE);
  await f.board.ensureWorktree(m);
  assert.deepEqual(m.governed.target, { ref: "main", sha: sh(f.repo, "rev-parse", "HEAD") }, "the drift baseline is recorded at approval");
  const one = await submitted(f, m, "one", "a.txt", "uno\n");
  const open = f.board.get((await add(f, m, { title: "Open", assignment: { key: "open", outcome: "o" }, start: "manual" })).id);
  await f.board.integrate(one.c);
  let r = await f.board.readiness(m, "target", await auth()());
  for (const c of ["live", "member-open", "checks-none"]) assert.ok(codes(r).includes(c), `${c}: ${JSON.stringify(codes(r))}`);
  f.board.update(open, { cancelled: true, status: "review" });
  const cand = readyRoot(f, m);
  r = await f.board.readiness(m, "target");
  assert.deepEqual(codes(r), ["authorization"], JSON.stringify(r.reasons));
  assert.ok(r.notes.some((n) => /not pushed: push is a separate choice/.test(n)));
  // Dirty root, stale checks, dirty target, target moved: each blocks.
  fs.writeFileSync(path.join(m.worktree, "new.txt"), "x\n");
  assert.ok(codes(await f.board.readiness(m, "target", await auth()())).includes("dirty"));
  fs.rmSync(path.join(m.worktree, "new.txt"));
  fs.writeFileSync(path.join(f.repo, "a.txt"), "wip\n");
  assert.ok(codes(await f.board.readiness(m, "target", await auth()())).includes("target-dirty"));
  sh(f.repo, "checkout", "--", "a.txt");
  fs.writeFileSync(path.join(f.repo, "other.txt"), "main moved\n"); sh(f.repo, "add", "other.txt"); sh(f.repo, "commit", "-qm", "main moved");
  r = await f.board.readiness(m, "target", await auth()());
  assert.ok(codes(r).includes("target-moved"), JSON.stringify(codes(r)));
  await assert.rejects(finish(f, m), /target-moved|which the candidate does not contain/);
  assert.equal(ops(f).filter((x) => x.kind === "target").length, 0, "no operation is opened for a refusal");
  // The root brings main in: a new candidate, so the old checks are stale until run again.
  sh(m.worktree, "merge", "-q", "--no-edit", "main");
  assert.ok(codes(await f.board.readiness(m, "target", await auth()())).includes("checks-stale"));
  const cand2 = readyRoot(f, m);
  assert.notEqual(cand2, cand);
  // the user merges without push: main is the exact candidate; the remote is untouched.
  const remoteBefore = sh(bare, "rev-parse", "main");
  let seen;
  const notes = await finish(f, m, async (rr) => { seen = rr; return auth(false)(rr); });
  assert.ok(Array.isArray(notes));
  assert.equal(seen.candidate, cand2);
  assert.equal(sh(f.repo, "rev-parse", "main"), cand2, "fast-forwarded to exactly the candidate");
  assert.equal(sh(bare, "rev-parse", "main"), remoteBefore, "push was not granted");
  const op = ops(f).find((x) => x.kind === "target");
  assert.deepEqual([op.state, op.cleanup, op.pre.push, op.authorization.push, m.status, m.merged], ["committed", "done", false, false, "done", true]);
  assert.match(fs.readFileSync(path.join(f.board.dir, "governed", `${m.id}.events.jsonl`), "utf8"), /"kind":"target".*not pushed/);
});

test("AC-E push: a remote that moves is refused before or at the push with nothing changed; granted push lands the exact candidate on both", async () => {
  const f = fixture();
  const bare = withRemote(f);
  const m = await governedRoot(f, WIDE);
  await f.board.ensureWorktree(m);
  const one = await submitted(f, m, "one", "a.txt", "uno\n");
  await f.board.integrate(one.c);
  const cand = readyRoot(f, m);
  // Someone pushes to the remote after readiness read it: the real push is refused (never forced); nothing local changes.
  const clone = otherClone(bare);
  const mainBefore = sh(f.repo, "rev-parse", "main");
  const push = f.board.pushStep;
  f.board.pushStep = async (...args) => {
    fs.writeFileSync(path.join(clone, "z.txt"), "z\n"); sh(clone, "add", "."); sh(clone, "commit", "-qm", "z"); sh(clone, "push", "-q", "origin", "main");
    return push(...args);
  };
  await assert.rejects(finish(f, m, auth(true)), /push confirmation has expired/);
  assert.equal(sh(f.repo, "rev-parse", "main"), mainBefore);
  assert.equal(ops(f).find((x) => x.kind === "target").state, "abandoned");
  f.board.pushStep = push;
  // Readiness now sees the remote moved; the root integrates it, checks again, and Finish with push lands the exact candidate.
  assert.ok(codes(await f.board.readiness(m, "target", await auth(true)())).includes("remote-moved"));
  sh(m.worktree, "fetch", "-q", "origin"); sh(m.worktree, "merge", "-q", "--no-edit", "origin/main");
  const cand2 = readyRoot(f, m);
  assert.notEqual(cand2, cand);
  await finish(f, m, auth(true));
  assert.deepEqual([sh(bare, "rev-parse", "main"), sh(f.repo, "rev-parse", "main")], [cand2, cand2]);
  assert.equal(ops(f).filter((x) => x.kind === "target" && x.state === "committed").length, 1);
});

test("AC-E drift and ownership: shell git that put run work on the target needs the user's acknowledgment; a window that lost the board changes nothing", async () => {
  const f = fixture();
  const m = await governedRoot(f, WIDE);
  await f.board.ensureWorktree(m);
  const one = await submitted(f, m, "one", "a.txt", "uno\n");
  await f.board.integrate(one.c);
  readyRoot(f, m);
  // A shell fast-forwards main to the child's submitted commit, outside the board.
  sh(f.repo, "merge", "-q", "--ff-only", one.head);
  const r = await f.board.readiness(m, "target", await auth()());
  assert.deepEqual(r.reasons.map((x) => [x.code, x.ack]), [["drift", "drift"]], JSON.stringify(r.reasons));
  assert.equal(r.ok, false);
  // Ownership lost while the user's dialog was open: the recheck refuses before any operation or effect.
  const mainBefore = sh(f.repo, "rev-parse", "main");
  await assert.rejects(finish(f, m, async r => { fs.writeFileSync(path.join(f.board.dir, "owner.json"), JSON.stringify({ pid: process.ppid, at: Date.now() })); return auth(false, ["drift"])(r); }), /window|own/i);
  assert.equal(sh(f.repo, "rev-parse", "main"), mainBefore);
  assert.equal(ops(f).filter((x) => x.kind === "target").length, 0);
  fs.writeFileSync(path.join(f.board.dir, "owner.json"), JSON.stringify({ pid: 0, at: 0 })); f.board.tick();
  // Acknowledged, Finish goes ahead with the exact candidate.
  await finish(f, m, auth(false, ["drift"]));
  assert.equal(sh(f.repo, "rev-parse", "main"), sh(f.repo, "rev-parse", `${ops(f).find((x) => x.kind === "target").pre.candidate}`));
});

test("AC-I crash boundaries: reconciliation reads the refs before any replay (merge done but unrecorded, never done, unexpected), and cleanup is retried alone", async () => {
  const f = fixture();
  const m = await governedRoot(f, WIDE);
  await f.board.ensureWorktree(m);
  const one = await submitted(f, m, "one", "a.txt", "uno\n");
  const two = await submitted(f, m, "two", "b.txt", "two\n");
  // 1. The board stops after the merge, before recording it.
  const real = f.board.integrationMerge;
  f.board.integrationMerge = async (...args) => { await real(...args); throw new Error("window closed"); };
  await assert.rejects(f.board.integrate(one.c), /window closed/);
  let op = ops(f).find((x) => x.card === one.c.id);
  assert.equal(op.state, "prepared", "intent was persisted before the effect");
  assert.ok(codes(await f.board.readiness(two.c, "integrate")).includes("operation"), "nothing more is integrated into that branch until it is reconciled");
  await f.board.reconcileOperations();
  op = ops(f).find((x) => x.card === one.c.id);
  assert.deepEqual([op.state, one.c.status, one.c.integrated.op], ["committed", "done", op.id]);
  assert.equal(sh(m.worktree, "rev-list", "--count", "--merges", "HEAD"), "1", "merged once, never replayed");
  // 2. The board stops before the merge: reconciliation finds the branch unchanged and abandons the record; integrating again works.
  f.board.integrationMerge = async () => { throw new Error("window closed"); };
  await assert.rejects(f.board.integrate(two.c), /window closed/);
  await f.board.reconcileOperations();
  assert.equal(ops(f).find((x) => x.card === two.c.id).state, "abandoned");
  f.board.integrationMerge = real;
  assert.equal((await f.board.integrate(two.c)).ok, true);
  // 3. A target effect that landed before its record (prepared + main at the candidate): committed by reconciliation, cleanup included.
  const cand = readyRoot(f, m), before = sh(f.repo, "rev-parse", "main");
  const pending = f.board.operations.open({ kind: "target", card: m.id, run: m.id, actor: "user", authorization: { by: "user", at: "now", merge: true, push: false }, pre: { candidate: cand, ref: "main", targetBefore: before, push: false } });
  // 4. Meanwhile something else moved main: an unexpected state is uncertain and blocks until the user acknowledges it.
  fs.writeFileSync(path.join(f.repo, "x.txt"), "x\n"); sh(f.repo, "add", "."); sh(f.repo, "commit", "-qm", "x");
  await f.board.reconcileOperations();
  assert.equal(f.board.operations.get(pending.id).state, "uncertain");
  const r = await f.board.readiness(m, "target", await auth()());
  assert.ok(r.reasons.some((x) => x.ack === `op:${pending.id}`));
  sh(f.repo, "reset", "-q", "--hard", before); // the test's own throwaway commit, not the board's
  const crashed = f.board.operations.open({ kind: "target", card: m.id, run: m.id, actor: "user", authorization: { by: "user", at: "now", merge: true, push: false }, pre: { candidate: cand, ref: "main", targetBefore: before, push: false } });
  sh(f.repo, "merge", "-q", "--ff-only", cand); // the effect happened; the board died before recording it
  const failing = f.board["removeWorktree"].bind(f.board);
  let fail = true;
  f.board["removeWorktree"] = async (t) => { if (fail) { fail = false; throw new Error("EBUSY: folder in use"); } return failing(t); };
  await f.board.reconcileOperations();
  const c = f.board.operations.get(crashed.id);
  assert.deepEqual([c.state, c.cleanup, m.merged, m.cleanupPending], ["committed", "pending", true, true], "effect recorded, cleanup pending, not repeated");
  // Finish again retries only the cleanup: no new operation, main unchanged.
  const notes = await finish(f, m, async () => { throw new Error("not asked: nothing to authorize"); });
  assert.match(notes.join(" "), /only the cleanup was left/);
  assert.deepEqual([f.board.operations.get(crashed.id).cleanup, m.status, sh(f.repo, "rev-parse", "main")], ["done", "done", cand]);
  assert.equal(ops(f).filter((x) => x.kind === "target").length, 2);
});

test("AC-I launches: a reservation another window made is reconciled before a replay launches the card again", async () => {
  const f = fixture();
  const m = await governedRoot(f, WIDE);
  const child = f.board.get((await add(f, m, { assignment: { key: "a", outcome: "a" }, start: "manual" })).id);
  m.governed.leases.push({ card: child.id, op: "launch:old", at: new Date().toISOString(), state: "reserved", owner: "1:crashed" }); f.board.update(m, {});
  await assert.rejects(f.board.startHeadless(child), /reserved by an earlier window[\s\S]*Nothing was started/);
  assert.equal(child.sessionId, undefined);
  // Its grace passes with no session seen: the tick releases it, and the launch goes ahead under a lease of this window.
  m.governed.leases.find((l) => l.op === "launch:old").at = new Date(Date.now() - 300_000).toISOString();
  f.board.tick();
  assert.ok(!m.governed.leases.some((l) => l.op === "launch:old"));
  await f.board.startHeadless(child);
  assert.equal(m.governed.leases.find((l) => l.card === child.id).owner, f.board.instance);
});

test("AC-I requests: the durable journal outlives inbox/done pruning, refuses a reused nonce with another body, never replays a request cut off mid-way, and answers a failed write from the journal", async () => {
  const f = fixture();
  const m = await governedRoot(f, WIDE);
  const inbox = path.join(f.board.dir, "inbox"), done = path.join(inbox, "done");
  const drop = (nonce, body) => fs.writeFileSync(path.join(inbox, `${nonce}.json`), JSON.stringify({ v: 1, at: "now", ...body }));
  const answer = (nonce) => JSON.parse(fs.readFileSync(path.join(done, `${nonce}.json`), "utf8"));
  const body = { op: "add", by: m.id, session: m.sessionId, protocol: 3, title: "W", prompt: "P", assignment: { key: "w1", outcome: "o" }, start: "manual" };
  drop("nA", body); await f.board.processInbox();
  assert.equal(answer("nA").created, true);
  const n = f.board.tasks.length;
  // Pruned from inbox/done (it keeps 200), then replayed: refused from the journal, nothing made twice.
  fs.rmSync(path.join(done, "nA.json")); drop("nA", body); await f.board.processInbox();
  assert.match(answer("nA").error, /already handled/);
  assert.equal(f.board.tasks.length, n);
  fs.rmSync(path.join(done, "nA.json")); drop("nA", { ...body, title: "Other" }); await f.board.processInbox();
  assert.match(answer("nA").error, /reuses a nonce .* different body/);
  // Cut off mid-way (journal says started, no answer): uncertain, not handled again.
  const crypto = require("node:crypto");
  const cut = { v: 1, at: "now", ...body, assignment: { key: "w2", outcome: "o" } };
  f.board.requests.record({ nonce: "nB", hash: crypto.createHash("sha256").update(JSON.stringify(cut)).digest("hex"), state: "started", at: Date.now() });
  fs.writeFileSync(path.join(inbox, "nB.json"), JSON.stringify(cut)); await f.board.processInbox();
  assert.equal(answer("nB").uncertain, true);
  assert.equal(f.board.tasks.length, n);
  // The answer cannot be written: the request stays, its answer is journaled, and the next pass answers it without handling it again.
  // A read-only folder stops the write on Linux. Windows ignores that mode, so there a folder stands where writeFileAtomic
  // (src/sessions.ts) puts its temporary file, `<answer>.<pid>.tmp`, and the write fails before the answer exists.
  const win = process.platform === "win32", blocker = path.join(done, `nC.json.${process.pid}.tmp`);
  if (win) fs.mkdirSync(blocker); else fs.chmodSync(done, 0o555);
  try { drop("nC", { ...body, assignment: { key: "w3", outcome: "o" } }); await f.board.processInbox(); }
  finally { if (win) fs.rmdirSync(blocker); else fs.chmodSync(done, 0o755); }
  assert.ok(fs.existsSync(path.join(inbox, "nC.json")), "kept for the next pass");
  assert.equal(f.board.tasks.length, n + 1, "handled once");
  await f.board.processInbox();
  assert.equal(answer("nC").created, true);
  assert.ok(!fs.existsSync(path.join(inbox, "nC.json")));
  assert.equal(f.board.tasks.length, n + 1, "not handled twice");
  // A request older than the horizon is refused, never handled.
  drop("nD", { ...body, assignment: { key: "w4", outcome: "o" } });
  const old = new Date(Date.now() - 31 * 86_400_000); fs.utimesSync(path.join(inbox, "nD.json"), old, old);
  await f.board.processInbox();
  assert.match(answer("nD").error, /older than the board's request horizon/);
  // A fresh board reads the same journal (it is on disk, not in memory).
  const again = new Board(f.repo, path.join(f.repo, "hook.js"), undefined, false); boards.push(again);
  assert.equal(again.requests.get("nA").state, "answered");
});

test("RT-12 requests: a failed journal append starts nothing; once storage is back the request runs once with a durable receipt; a durable start with no result stays uncertain", async () => {
  const f = fixture();
  const m = await governedRoot(f, WIDE);
  const S = require("../out/sessions.js");
  const inbox = path.join(f.board.dir, "inbox"), done = path.join(inbox, "done"), journal = path.join(inbox, "journal.jsonl");
  const drop = (nonce, key) => fs.writeFileSync(path.join(inbox, `${nonce}.json`), JSON.stringify({ v: 1, at: "now", op: "add", by: m.id, session: m.sessionId, protocol: 3, title: "W", prompt: "P", assignment: { key, outcome: "o" }, start: "manual" }));
  const answer = (nonce) => JSON.parse(fs.readFileSync(path.join(done, `${nonce}.json`), "utf8"));
  const onDisk = (nonce) => new S.RequestJournal(journal).get(nonce)?.state;
  const pending = (nonce) => fs.existsSync(path.join(inbox, `${nonce}.json`));
  const eio = () => Object.assign(new Error("EIO: injected"), { code: "EIO" });
  const settled = (p) => p.then(() => "resolved", (e) => e);
  // Each handler run, with what a fresh reader of the journal saw just before it.
  const handle = f.board["handleRequest"].bind(f.board), runs = [];
  f.board["handleRequest"] = async (raw, nonce) => { runs.push([nonce, onDisk(nonce)]); return handle(raw, nonce); };
  const n = f.board.tasks.length, realOpen = fs.openSync, realSync = fs.fsyncSync, realWrite = fs.writeSync;
  let jfd;
  const openJournal = (fail) => test.mock.method(fs, "openSync", (p, ...rest) => { if (p !== journal) return realOpen(p, ...rest); if (fail) throw eio(); return (jfd = realOpen(p, ...rest)); });
  // 1. Opening the journal fails before a byte is written: not started, not answered, kept for the next pass.
  drop("rA", "r1");
  let open = openJournal(true);
  try { assert.equal(await settled(f.board.processInbox()), "resolved"); } finally { open.mock.restore(); }
  assert.deepEqual([runs, f.board.requests.get("rA"), onDisk("rA"), pending("rA")], [[], undefined, undefined, true]);
  // Storage restored: handled exactly once, after its start was on disk, and its receipt is durable.
  await f.board.processInbox(); await f.board.processInbox();
  assert.deepEqual([runs, answer("rA").created, f.board.tasks.length, onDisk("rA"), pending("rA")], [[["rA", "started"]], true, n + 1, "answered", false]);
  // 2. A possible partial write: the line reached the file but fsync failed. Read back from disk the start is durable and
  //    nothing records how it ended, so it is answered as uncertain and never handled.
  drop("rB", "r2");
  let armed = true;
  open = openJournal(false);
  const sync = test.mock.method(fs, "fsyncSync", (fd) => { if (armed && fd === jfd) { armed = false; throw eio(); } return realSync(fd); });
  try { assert.equal(await settled(f.board.processInbox()), "resolved"); } finally { sync.mock.restore(); open.mock.restore(); }
  assert.deepEqual([runs.length, onDisk("rB"), f.board.requests.get("rB")?.state, pending("rB")], [1, "started", "started", true]);
  await f.board.processInbox();
  assert.deepEqual([answer("rB").uncertain, runs.length, f.board.tasks.length], [true, 1, n + 1]);
  // 3. A short write (a full disk) leaves a torn line: nothing durable says it started, so one retry is safe, and the retry's
  //    start is journaled whole after the torn bytes.
  drop("rC", "r3");
  armed = true;
  open = openJournal(false);
  const write = test.mock.method(fs, "writeSync", (fd, data, ...rest) => { if (armed && fd === jfd) { armed = false; return realWrite(fd, String(data).slice(0, 20)); } return realWrite(fd, data, ...rest); });
  try { assert.equal(await settled(f.board.processInbox()), "resolved"); } finally { write.mock.restore(); open.mock.restore(); }
  assert.deepEqual([runs.length, f.board.requests.get("rC"), onDisk("rC"), pending("rC")], [1, undefined, undefined, true]);
  await f.board.processInbox();
  assert.deepEqual([runs, answer("rC").created, f.board.tasks.length, onDisk("rC"), pending("rC")], [[["rA", "started"], ["rC", "started"]], true, n + 2, "answered", false]);
});

test("AC-I records: a damaged operation file reads as uncertain, never as none; the request journal drops only entries past the horizon", () => {
  const S = require("../out/sessions.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-ops-")); made.push(dir);
  const ops = new S.Operations(path.join(dir, "operations"));
  const op = ops.open({ kind: "integrate", card: "a00001", run: "r00000", actor: "user", pre: { head: "h" } });
  assert.equal(ops.get(op.id).state, "prepared");
  fs.writeFileSync(path.join(dir, "operations", "integrate-x.json"), "{ torn");
  assert.deepEqual(ops.list().map((o) => o.state).sort(), ["prepared", "uncertain"]);
  const file = path.join(dir, "journal.jsonl"), j = new S.RequestJournal(file, 1000);
  const now = Date.now();
  j.record({ nonce: "old", hash: "h", state: "answered", at: now - 5000 });
  j.record({ nonce: "new", hash: "h", state: "answered", at: now });
  fs.appendFileSync(file, `${JSON.stringify({ nonce: "pad", hash: "x".repeat(1_100_000), state: "answered", at: now - 9999 })}\n`);
  new S.RequestJournal(file, 1000).compact(now);
  const after = new S.RequestJournal(file, 1000);
  assert.deepEqual([after.get("old"), after.get("pad"), after.get("new")?.state], [undefined, undefined, "answered"]);
});

test("review fixes (phase 4): Done-but-unintegrated children integrate; coordinators wait for their children; shell merges and dirty checks need more; uncertain and damaged records can be settled", async () => {
  const f = fixture();
  const m = await governedRoot(f, { limits: { active: 5, directChildren: 4, depth: 2 }, allowed: ["provider-defaults"], defaultChild: "provider-defaults" });
  await f.board.ensureWorktree(m);
  // 1. Accepted with board.js done, never integrated: still integrable.
  const one = await submitted(f, m, "one", "a.txt", "uno\n");
  assert.equal((await request(f.board, { op: "done", by: m.id, session: m.sessionId, protocol: 3, id: one.c.id })).ok, true);
  assert.equal(one.c.status, "done");
  assert.ok(!codes(await f.board.readiness(one.c, "integrate")).includes("state"));
  // 2. Checks that ran on a dirty tree (or a moving HEAD) do not cover the revision.
  passChecks(f, one.c, one.head, false);
  assert.ok(codes(await f.board.readiness(one.c, "integrate")).includes("checks-dirty"));
  passChecks(f, one.c, one.head);
  // 3. A coordinator is integrated only after its own children are.
  const coord = f.board.get((await add(f, m, { title: "Coord", mayOpen: true, assignment: { key: "c", outcome: "c" } })).id);
  started(f, coord);
  const w = f.board.get((await add(f, coord, { title: "W", assignment: { key: "w", outcome: "w" }, start: "manual" })).id);
  fs.writeFileSync(path.join(coord.worktree, "c.txt"), "c\n"); sh(coord.worktree, "add", "."); sh(coord.worktree, "commit", "-qm", "c");
  assert.equal((await request(f.board, { op: "submit", by: coord.id, session: coord.sessionId, protocol: 3, head: sh(coord.worktree, "rev-parse", "HEAD"), summary: "c" })).ok, true);
  settle(f.board, coord); f.board.tick();
  assert.ok(codes(await f.board.readiness(coord, "integrate")).includes("children-open"));
  f.board.update(w, { cancelled: true, status: "review" });
  assert.ok(!codes(await f.board.readiness(coord, "integrate")).includes("children-open"));
  // 4. An integration left uncertain blocks that branch until the user acknowledges it in the child's Merge.
  const stuck = f.board.operations.open({ kind: "integrate", card: "ffffff", run: m.id, actor: "user", pre: { into: m.id, branch: m.branch, head: "0".repeat(40), before: "x" } });
  f.board.operations.set(stuck, { state: "uncertain", result: { reason: "test" } });
  const r = await f.board.readiness(one.c, "integrate");
  assert.deepEqual(r.reasons.map((x) => x.ack), [`op:${stuck.id}`]);
  await assert.rejects(f.board.finish(one.c, "merge"), /blocked/);
  await f.board.finish(one.c, "merge", confirmationFor(r));
  assert.deepEqual([one.c.integrated.into, f.board.operations.get(stuck.id).state, f.board.operations.get(stuck.id).settled.by], [m.id, "abandoned", "user"]);
  // 5. A damaged record blocks every run's effects (it could be any of them).
  fs.writeFileSync(path.join(f.board.dir, "operations", "target-zzz.json"), "{ torn");
  assert.ok(codes(await f.board.readiness(coord, "integrate")).includes("operation"));
  fs.rmSync(path.join(f.board.dir, "operations", "target-zzz.json"));
  // 6. A member merged by a shell's git (no receipt) needs acknowledgment at Finish.
  sh(m.worktree, "merge", "-q", "--no-edit", coord.submission.head);
  f.board["pendingNotices"].delete(coord.id); settle(f.board, coord); f.board.tick();
  f.board.update(coord, { status: "done" });
  readyRoot(f, m);
  const t = await f.board.readiness(m, "target", await auth()());
  assert.deepEqual(t.reasons.map((x) => x.ack), [`unreceipted:${coord.id}`], JSON.stringify(t.reasons));
  assert.equal((await f.board.readiness(m, "target", await auth(false, [`unreceipted:${coord.id}`])())).ok, true);
});

test("review fixes (phase 4): a crash after an integration committed but before its cleanup only cleans up; the journal sees another window's entries", async () => {
  const f = fixture();
  const m = await governedRoot(f, { limits: { active: 5, directChildren: 4, depth: 2 }, allowed: ["provider-defaults"], defaultChild: "provider-defaults" });
  await f.board.ensureWorktree(m);
  const one = await submitted(f, m, "one", "a.txt", "uno\n");
  const cleanup = f.board["cleanupMember"].bind(f.board);
  f.board["cleanupMember"] = async () => { throw new Error("window closed"); };
  await assert.rejects(f.board.integrate(one.c), /window closed/);
  const op = ops(f).find((x) => x.card === one.c.id);
  assert.deepEqual([op.state, op.cleanup, fs.existsSync(one.c.worktree)], ["committed", undefined, true]);
  f.board["cleanupMember"] = cleanup;
  const merges = sh(m.worktree, "rev-list", "--count", "--merges", "HEAD");
  await f.board.reconcileOperations();
  assert.deepEqual([f.board.operations.get(op.id).cleanup, one.c.worktree, sh(m.worktree, "rev-list", "--count", "--merges", "HEAD")], ["done", undefined, merges]);
  // Another window appends to the journal: this board reads it before deciding.
  const S = require("../out/sessions.js");
  f.board.requests.get("none");
  new S.RequestJournal(path.join(f.board.dir, "inbox", "journal.jsonl")).record({ nonce: "fromB", hash: "h", state: "started", at: Date.now() });
  assert.equal(f.board.requests.get("fromB")?.state, "started");
});
