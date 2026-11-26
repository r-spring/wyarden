// Battle Royale's arena (src/arena.ts, the user, 14 November 2026): the pure choice of leftover processes, the warning, call-off, stop and
// sweep over stand-in boards, and the Board methods they call. Nothing here lists or ends a real process: the listing and the kill are
// stand-ins, and the Board methods run on stand-in `this` objects.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const arena = require("../out/arena.js");
const { leftovers, warnArena, callOff, stopArena, sweepArena, ARENA_WARNING, ARENA_CALLED_OFF, ARENA_STOPPED } = arena;

// board.js imports "vscode"; the Board methods below are called on stand-in objects, so loading it is all this needs.
class EventEmitter { event = () => ({ dispose() {} }); fire() {} dispose() {} }
const vscode = { EventEmitter, ThemeIcon: class {}, window: { terminals: [] } };
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board } = require("../out/board.js");
Module._load = load;

const proc = (pid, ppid, command, started) => ({ pid, ppid, name: "p", command, ...(started === undefined ? {} : { started }) });

test("leftovers on Windows: two boards' worktree and temp paths in any case and slash, their children, never the host, its ancestors or a look-alike", () => {
  const roots = ["C:\\Users\\user\\Dev\\Entomatical", "D:\\work\\other repo\\"];
  const procs = [
    // The VS Code main process was opened on a worktree, and is the extension host's parent: protected as its ancestor.
    proc(100, 1, '"C:\\Program Files\\Microsoft VS Code\\Code.exe" C:\\Users\\user\\Dev\\Entomatical\\.entomatical\\wt\\abc123', 10),
    proc(200, 100, '"C:\\Program Files\\Microsoft VS Code\\Code.exe" --type=extensionHost --extensionDevelopmentPath=C:\\Users\\user\\Dev\\Entomatical\\.entomatical\\wt\\abc123', 20),
    proc(210, 100, '"C:\\Program Files\\Microsoft VS Code\\Code.exe" --type=renderer', 21), // a sibling of the host, named nowhere
    proc(300, 1, '"C:\\Users\\user\\.local\\bin\\claude.exe" --settings "c:/users/user/dev/entomatical/.entomatical/wt/abc123/hooks.json"', 30),
    proc(301, 300, "node server.js", 31), // started after its parent: its child
    proc(302, 300, "conhost.exe 0x4", 29), // started before 300: an older process that had 300's pid as parent, not its child
    proc(303, 301, "git status", 32), // a grandchild
    proc(400, 1, 'node "D:\\work\\other repo\\.entomatical\\tmp\\t-1\\run.js"', 40),
    proc(401, 1, "node C:\\USERS\\USER\\DEV\\ENTOMATICAL\\.ENTOMATICAL\\WT\\XYZ\\a.js", 41), // case does not matter on Windows
    proc(500, 1, "node C:\\Users\\user\\Dev\\Entomatical2\\.entomatical\\wt\\abc\\a.js", 50), // another repo whose name starts the same
    proc(501, 1, 'node "C:\\Users\\user\\Dev\\Entomatical\\.entomatical\\wt-old\\a.js"', 51), // a look-alike folder
    proc(502, 1, 'git worktree list "C:\\Users\\user\\Dev\\Entomatical\\.entomatical\\wt"', 52), // the folder itself, nothing under it
    proc(503, 1, "node E:\\Users\\user\\Dev\\Entomatical\\.entomatical\\wt\\abc\\a.js", 53), // the same path on another drive
    proc(4, 0, "C:\\Users\\user\\Dev\\Entomatical\\.entomatical\\wt\\abc", 1), // a system pid, whatever its line says
  ];
  assert.deepEqual(leftovers(procs, roots, [200], "win32"), [300, 301, 303, 400, 401]);
  // A protected pid's ancestors are found from the list itself: protecting the host shields the main process too.
  assert.ok(!leftovers(procs, roots, [200], "win32").includes(100));
  // Without a protected pid the host and the main process would go, which is why the extension always passes its own.
  assert.deepEqual(leftovers(procs, roots, [], "win32"), [100, 200, 210, 300, 301, 303, 400, 401]);
  // The same lines read as Linux's: backslashes and another case name no Linux path.
  assert.deepEqual(leftovers(procs, roots, [200], "linux"), []);
});

test("leftovers on Linux: exact case, a path only where a path can start, children by parent pid, the host's own parent never", () => {
  const roots = ["/home/rob/Entomatical", "/srv/b"];
  const procs = [
    proc(1, 0, "/sbin/init /home/rob/Entomatical/.entomatical/wt/abc/x"),
    proc(40, 1, "/usr/share/codium/codium /home/rob/Entomatical/.entomatical/wt/abc"), // the host's parent: protected
    proc(50, 40, "/usr/share/codium/codium --type=utility"), // the extension host
    proc(60, 1, "/usr/bin/node /home/rob/Entomatical/.entomatical/wt/abc/tools/x.js"),
    proc(61, 60, "sh -c sleep 100"),
    proc(70, 1, "make --directory=/srv/b/.entomatical/tmp/t-9"),
    proc(80, 1, "/usr/bin/node /mnt/backup/home/rob/Entomatical/.entomatical/wt/abc/x.js"), // a copy elsewhere
    proc(81, 1, "/usr/bin/node /home/rob/entomatical/.entomatical/wt/abc/x.js"), // another case is another folder on Linux
    proc(82, 1, "cat /srv/b/.entomatical/tmpfile"),
  ];
  assert.deepEqual(leftovers(procs, roots, [50], "linux"), [60, 61, 70]);
});

/** A stand-in board: its calls in order, and every call that would finish, cancel, remove or delete is refused and counted. */
function standIn({ repo = "/r", owner = true, stopError } = {}) {
  const calls = [], forbidden = [];
  const tasks = [];
  const board = {
    repo, tasks, calls, forbidden,
    isOwner: () => owner,
    live: () => tasks.filter((t) => t.live).map((t) => t.id),
    liveRun: (m) => [...tasks.filter((t) => t.live && t.openedBy === m.id), ...(m.live ? [m] : [])],
    stopRun(m) { calls.push(["stopRun", m.id]); m.paused = true; for (const t of board.liveRun(m)) { t.live = false; t.status = "review"; } },
    stop(t) { if (stopError?.(t)) throw new Error(stopError(t)); calls.push(["stop", t.id]); t.live = false; t.status = "review"; t.interrupted = true; },
    pauseRun(m) { calls.push(["pauseRun", m.id]); m.paused = true; },
    resumeRun(m) { calls.push(["resumeRun", m.id]); m.paused = undefined; },
    update(t, patch) { calls.push(["update", t.id, patch]); Object.assign(t, patch); },
    warnBattle(t, text) { calls.push(["warn", t.id, text]); return t.how ?? "typed"; },
    battleNotice(id, text) { calls.push(["notice", id, text]); return text === undefined && !!tasks.find((t) => t.id === id)?.unread; },
    noteEvent(id, name, desc) { calls.push(["event", id, name, desc]); },
    async retryCleanups() { calls.push(["retryCleanups"]); return { removed: 1, failed: [] }; },
    checks: { stop(t) { calls.push(["checks.stop", t.id]); t.checks = { status: "error" }; } },
  };
  for (const name of ["finish", "remove", "cancel", "archiveRun", "send", "markDone", "discard", "merge"]) board[name] = () => { forbidden.push(name); throw new Error(`${name} must not be called`); };
  return board;
}
/** One board with a run (master and a running child), a live card, a card waiting on a prompt, a held card, a paused run and a Done card. */
function arenaBoard(options) {
  const b = standIn(options);
  b.tasks.push(
    { id: "m1", title: "run", status: "running", orchestrator: { opened: 1 }, live: true, how: "notice" },
    { id: "c1", title: "child", status: "running", openedBy: "m1", live: true },
    { id: "a1", title: "alone", status: "running", live: true },
    { id: "w1", title: "waiting", status: "needs-input", live: true, how: "wait" },
    { id: "k1", title: "checking", status: "review", checks: { status: "running" } },
    { id: "q1", title: "held", status: "queued", held: true },
    { id: "m2", title: "budget run", status: "review", orchestrator: { opened: 0 }, paused: "budget" },
    { id: "d1", title: "done", status: "done" },
  );
  return b;
}
const get = (b, id) => b.tasks.find((t) => t.id === id);

test("warnArena pauses every run, clears held and tells each live card; callOff resumes only what it paused and puts held back", () => {
  const b = arenaBoard();
  const w = warnArena([b], () => false, 1234);
  assert.equal(w.at, 1234);
  assert.deepEqual(b.calls, [["pauseRun", "m1"], ["update", "q1", { held: undefined }],
    ["warn", "m1", ARENA_WARNING], ["warn", "c1", ARENA_WARNING], ["warn", "a1", ARENA_WARNING], ["warn", "w1", ARENA_WARNING], ["warn", "k1", ARENA_WARNING]]);
  assert.deepEqual([get(b, "m1").paused, get(b, "q1").held, get(b, "m2").paused], [true, undefined, "budget"]);
  assert.deepEqual(w.told.map((t) => t.id), ["m1", "c1", "a1", "k1"]); // w1 only gets the wait
  // the user started the held card himself meanwhile: the call-off leaves it running.
  const started = arenaBoard();
  const ws = warnArena([started], () => false, 0);
  Object.assign(get(started, "q1"), { status: "running", sessionId: "s" });
  callOff(ws);
  assert.equal(get(started, "q1").held, undefined);
  b.calls.length = 0;
  callOff(w);
  // The call-offs go before the runs resume: Resume run must not deliver the warning to an orchestrator that went idle meanwhile.
  assert.deepEqual(b.calls, [["notice", "m1", undefined], ["warn", "m1", ARENA_CALLED_OFF], ["warn", "c1", ARENA_CALLED_OFF], ["warn", "a1", ARENA_CALLED_OFF],
    ["warn", "k1", ARENA_CALLED_OFF], ["resumeRun", "m1"], ["update", "q1", { held: true }]]);
  assert.deepEqual([get(b, "m1").paused, get(b, "q1").held, get(b, "m2").paused], [undefined, true, "budget"]);
  assert.deepEqual(b.forbidden, []);
  // An orchestrator that has not read its warning just loses it: no call-off to read either.
  const unread = arenaBoard();
  const wu = warnArena([unread], () => false, 0);
  get(unread, "m1").unread = true;
  unread.calls.length = 0;
  callOff(wu);
  assert.deepEqual(unread.calls.filter((c) => c[1] === "m1"), [["notice", "m1", undefined], ["resumeRun", "m1"]]);
});

test("warnArena is best effort: a card whose warning throws only gets the wait, and the rest are still told", () => {
  const b = arenaBoard();
  b.warnBattle = (t, text) => { if (t.id === "c1") throw new Error("no terminal"); b.calls.push(["warn", t.id, text]); return "typed"; };
  const w = warnArena([b], () => false, 0);
  assert.deepEqual(w.told.map((t) => t.id), ["m1", "a1", "w1", "k1"]);
});

test("stopArena: Stop run, then each card still live, its checks and its review or helpers; a failing stop is collected and the rest go on; nothing is finished, cancelled or removed", () => {
  const b = arenaBoard({ stopError: (t) => (t.id === "a1" ? "boom" : undefined) });
  const reviewed = [];
  const busy = (id) => id === "r1";
  b.tasks.push({ id: "r1", title: "reviewing", status: "review" }, { id: "e1", title: "ended by itself", status: "review" });
  const r = stopArena([b], busy, (id) => { reviewed.push(id); return id === "r1"; });
  assert.deepEqual(b.calls.filter((c) => c[0] !== "event" && c[0] !== "notice"), [["stopRun", "m1"], ["stop", "w1"], ["checks.stop", "k1"]]);
  assert.deepEqual(r, { cards: 5, runs: 1, failures: ['"alone": boom'] });
  // Each stopped card: the event and its unread warning dropped; the failed one and the cards with nothing running get neither.
  assert.deepEqual(b.calls.filter((c) => c[0] === "event").map((c) => c[1]), ["m1", "c1", "w1", "k1", "r1"]);
  assert.ok(b.calls.filter((c) => c[0] === "event").every((c) => c[2] === "BattleRoyale" && c[3] === ARENA_STOPPED));
  assert.deepEqual(b.calls.filter((c) => c[0] === "notice"), [["notice", "m1", undefined], ["notice", "c1", undefined], ["notice", "w1", undefined], ["notice", "k1", undefined], ["notice", "r1", undefined]]);
  assert.deepEqual(reviewed, ["m1", "c1", "a1", "w1", "k1", "r1"]); // e1 and d1 have nothing running: not touched at all
  assert.deepEqual(b.forbidden, []);
  assert.ok(b.calls.every((c) => c[0] !== "update")); // no card was set Done, cancelled or merged
});

test("sweepArena ends what leftovers chose under the cleared boards, retries their merged folders, and collects a failed listing", async () => {
  const one = standIn({ repo: path.join(os.tmpdir(), "repo-one") }), two = standIn({ repo: path.join(os.tmpdir(), "repo-two") });
  const listed = [proc(10, 1, `node "${path.join(one.repo, ".entomatical", "wt", "x", "a.js")}"`), proc(11, 10, "child"),
    proc(12, 1, `node "${path.join(two.repo, ".entomatical", "tmp", "t-1", "b.js")}"`), proc(13, 1, `node "${path.join(os.tmpdir(), "repo-three", ".entomatical", "wt", "y")}"`)];
  const ended = [];
  const r = await sweepArena([one, two], [process.pid], async () => listed, async (pids) => { ended.push(...pids); return { ended: pids.length, failures: ["process 12: Access is denied."] }; });
  assert.deepEqual(ended, [10, 11, 12]);
  assert.deepEqual(r, { ended: 3, removed: 2, failures: ["process 12: Access is denied."] });
  assert.deepEqual([one.calls, two.calls], [[["retryCleanups"]], [["retryCleanups"]]]);
  const failed = await sweepArena([one], [process.pid], async () => { throw new Error("PowerShell is missing"); }, async () => assert.fail("nothing to end"));
  assert.deepEqual(failed, { ended: 0, removed: 1, failures: ["the process list: PowerShell is missing"] });
});

test("Board.warnBattle types into a terminal session not waiting on a prompt, leaves an orchestrator a notice, and gives the rest only the wait", () => {
  const typed = [], notices = [];
  const term = {};
  const self = (hasTerminal) => ({ terminal: () => (hasTerminal ? term : undefined), typeInto: (t, tm, text) => typed.push([t.id, tm === term, text]), battleNotice: (id, text) => notices.push([id, text]) });
  assert.equal(Board.prototype.warnBattle.call(self(true), { id: "a", status: "running" }, "hi"), "typed");
  assert.equal(Board.prototype.warnBattle.call(self(true), { id: "b", status: "needs-input" }, "hi"), "wait"); // keys could answer its prompt
  assert.equal(Board.prototype.warnBattle.call(self(false), { id: "o", status: "running", orchestrator: { opened: 0 } }, "hi"), "notice");
  assert.equal(Board.prototype.warnBattle.call(self(false), { id: "p", status: "running", provider: "grok" }, "hi"), "wait");
  assert.deepEqual([typed, notices], [[["a", true, "hi"]], [["o", "hi"]]]);
});

test("Board.battleNotice queues the card's battle notice, and with no text drops only that one", () => {
  const queued = [];
  let saved = 0;
  const self = { pendingNotices: new Map([["o", new Map([["battle", "warning"], ["message:1", "keep me"]])], ["p", new Map([["battle", "warning"]])]]),
    loadNotifications() {}, saveNotifications() { saved++; }, queueNotice: (id, key, text) => queued.push([id, key, text]) };
  Board.prototype.battleNotice.call(self, "o", "called off");
  assert.deepEqual(queued, [["o", "battle", "called off"]]);
  const dropped = ["o", "p", "q"].map((id) => Board.prototype.battleNotice.call(self, id, undefined)); // q has none: nothing saved
  assert.deepEqual([dropped, [...self.pendingNotices.get("o")], self.pendingNotices.has("p"), saved], [[true, true, false], [["message:1", "keep me"]], false, 2]);
});

test("Board.retryCleanups deletes a merged card's empty leftover folder and marks it Done; a folder holding files, a live card and an unmerged card are left", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arena-cleanup-"));
  try {
    const folder = (name, file) => { const d = path.join(root, name); fs.mkdirSync(path.join(d, "empty"), { recursive: true }); if (file) fs.writeFileSync(path.join(d, file), "x"); return d; };
    const tasks = [
      { id: "ok", title: "landed", status: "review", merged: true, cleanupPending: true, worktree: folder("ok"), branch: "task/ok" },
      { id: "files", title: "wrote since", status: "review", merged: true, cleanupPending: true, worktree: folder("files", "notes.txt"), branch: "task/files" },
      { id: "live", title: "running", status: "running", merged: true, cleanupPending: true, worktree: folder("live"), branch: "task/live" },
      { id: "open", title: "not merged", status: "review", worktree: folder("open"), branch: "task/open" },
    ];
    const removed = [];
    const self = { tasks, live: () => ["live"], mustOwn() {}, transcriptOf: () => undefined,
      async removeWorktree(t) { removed.push(t.id); fs.rmSync(t.worktree, { recursive: true, force: true }); },
      update(t, patch) { Object.assign(t, patch); } };
    const r = await Board.prototype.retryCleanups.call(self, []);
    assert.deepEqual(removed, ["ok"]);
    assert.equal(r.removed, 1);
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0], /^the folder of "wrote since" \(.*files\): it still holds files: notes\.txt$/);
    assert.deepEqual([tasks[0].status, tasks[0].worktree, tasks[0].cleanupPending, tasks[0].merged], ["done", undefined, undefined, true]);
    assert.ok(fs.existsSync(path.join(tasks[1].worktree, "notes.txt")));
    assert.deepEqual([tasks[2].status, tasks[3].status], ["running", "review"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
