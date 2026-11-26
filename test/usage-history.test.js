const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// The usage folder is read once at module load, so it is pointed at a throwaway folder before anything is required.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-usage-history-"));
const usageDir = path.join(home, "usage");
process.env.ENTOMATICAL_USAGE_DIR = usageDir;
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

// board.js imports "vscode"; this stand-in has what Board touches here.
class EventEmitter { listeners = []; event = (l) => (this.listeners.push(l), { dispose() {} }); fire(e) { for (const l of this.listeners) l(e); } dispose() {} }
const vscode = { EventEmitter, ThemeIcon: class {}, commands: { executeCommand: async () => {} }, Uri: { from: (p) => p },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined, createTerminal: () => ({ show() {}, dispose() {}, sendText() {} }) } };
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };

const h = require("../out/usage-history.js");
const { Board } = require("../out/board.js");

const HOUR = 3600;
const claude = (fiveHour, week, at, resets = { fiveHour: 2_000_000_000, week: 2_000_100_000 }) => ({ fiveHour, week, fiveHourResets: resets.fiveHour, weekResets: resets.week, at, source: "statusline" });

test("readings: Claude's two windows, or a provider's own windows by their real length", () => {
  assert.deepEqual(h.readings(claude(10, 20, 1)), [{ name: "5-hour", pct: 10, resets: 2_000_000_000 }, { name: "weekly", pct: 20, resets: 2_000_100_000 }]);
  assert.deepEqual(h.readings({ at: 1, source: "query", windows: [{ minutes: 10080, pct: 7, resets: 5 }, { minutes: 1440, pct: 1 }] }),
    [{ name: "weekly", pct: 7, resets: 5 }, { name: "1-day", pct: 1, resets: undefined }]);
  assert.deepEqual(h.readings(undefined), []);
});

test("startReading: a window whose reset time has passed counts as 0% at the start", () => {
  const now = 1_800_000_000_000;
  const old = claude(60, 30, now - HOUR * 1000, { fiveHour: now / 1000 - 60, week: now / 1000 + 86_400 });
  const start = h.startReading(old, now);
  assert.equal(start.fiveHour, 0);
  assert.equal(start.fiveHourResets, undefined);
  assert.equal(start.week, 30);
  const codex = h.startReading({ at: 1, source: "query", windows: [{ minutes: 300, pct: 50, resets: now / 1000 - 1 }, { minutes: 10080, pct: 9, resets: now / 1000 + 1 }] }, now);
  assert.deepEqual(codex.windows, [{ minutes: 300, pct: 0 }, { minutes: 10080, pct: 9, resets: now / 1000 + 1 }]);
});

test("legacy reset-only readings cannot supply a run's starting percentage", () => {
  const at = 1_800_000_000_000;
  const resets = at / 1000 - 1;
  const old = { at: at - 5000, source: "query", fiveHour: null, fiveHourResets: resets, weekResets: resets };
  assert.deepEqual(h.readings(h.startReading(old, at)), []);
  assert.deepEqual(h.readings(h.startReading({ ...old, windows: [{ minutes: 300, resets }] }, at)), []);
});

test("taskCost: points per window over the runs; a reset or a drop gives no number; an unfinished run says so", () => {
  const t0 = 1_800_000_000_000;
  const run = (s, e) => ({ startedAt: t0, start: s, endedAt: e ? t0 + 60_000 : undefined, end: e });
  assert.equal(h.taskCost(undefined), undefined);
  assert.equal(h.taskCost([]), undefined);
  const one = h.taskCost([run(claude(10, 20, t0), claude(14, 21, t0 + 60_000))]);
  assert.deepEqual(one, { windows: [{ name: "5-hour", points: 4 }, { name: "weekly", points: 1 }], runs: 1, open: false });
  const two = h.taskCost([run(claude(10, 20, t0), claude(14, 21, t0 + 60_000)), run(claude(14, 21, t0), claude(16, 21, t0 + 60_000))]);
  assert.deepEqual(two.windows, [{ name: "5-hour", points: 6 }, { name: "weekly", points: 1 }]);
  // The 5-hour window's reset time fell inside the run; the weekly one is still comparable.
  const reset = h.taskCost([run(claude(90, 20, t0, { fiveHour: (t0 + 30_000) / 1000, week: 2_000_100_000 }), claude(3, 22, t0 + 60_000))]);
  assert.deepEqual(reset.windows, [{ name: "5-hour", reset: true }, { name: "weekly", points: 2 }]);
  // Usage that went down without an announced reset is a reset too.
  assert.deepEqual(h.taskCost([run(claude(50, 20, t0), claude(2, 20, t0 + 60_000))]).windows, [{ name: "5-hour", reset: true }, { name: "weekly", points: 0 }]);
  // No start reading: unknown.
  assert.deepEqual(h.taskCost([run(undefined, claude(2, 20, t0 + 60_000))]).windows, [{ name: "5-hour", incomplete: true }, { name: "weekly", incomplete: true }]);
  assert.equal(h.taskCost([run(claude(1, 1, t0), undefined)]).open, true);
});

test("a missing endpoint on a resumed run cannot become a complete subtotal or five-hour budget", () => {
  const { parseUsage } = require("../out/usage.js");
  const disagreement = parseUsage({ rate_limits: { five_hour: { utilization: 96 }, seven_day: { utilization: 14 },
    limits: [{ kind: "session", percent: 99 }] } });
  const first = { startedAt: 1, endedAt: 2, start: claude(10, 10, 1), end: claude(12, 12, 2) };
  const second = { startedAt: 3, endedAt: 4, start: first.end, end: { ...disagreement, at: 4 } };
  const task = { usageRuns: [first, second] };
  assert.deepEqual(h.taskCost(task.usageRuns).windows, [{ name: "5-hour", points: 2, incomplete: true }, { name: "weekly", points: 4 }]);
  assert.equal(Board.prototype.fiveHourOf(task), undefined);
  assert.equal(Board.prototype.pointsOf(task), 4);
  for (const usageRuns of [[{ startedAt: 1, endedAt: 2 }, first], [first, { ...second, end: undefined }]]) {
    assert.equal(Board.prototype.fiveHourOf({ usageRuns }), undefined);
    assert.equal(Board.prototype.pointsOf({ usageRuns }), null);
  }
  assert.equal(Board.prototype.fiveHourOf({ usageRuns: [first, { startedAt: 3 }] }), 2);
});

test("recordUsage keeps a reading when it differs from the last kept one, or 15 minutes later", () => {
  const dir = path.join(home, "history-a");
  const t0 = 1_800_000_000_000;
  h.recordUsage("acct", undefined, dir);
  assert.equal(h.readHistory("acct", dir).length, 0);
  h.recordUsage("acct", claude(10, 20, t0), dir);
  h.recordUsage("acct", claude(10, 20, t0 + 1000), dir); // same windows a second later: not kept
  h.recordUsage("acct", claude(10, 20, t0), dir); // the same reading again: not kept
  assert.equal(h.readHistory("acct", dir).length, 1);
  h.recordUsage("acct", claude(11, 20, t0 + 2000), dir); // moved: kept
  h.recordUsage("acct", claude(11, 20, t0 + 16 * 60_000), dir); // unchanged but 15 minutes on: kept
  h.recordUsage("acct", claude(99, 99, t0 - 5000), dir); // older than the last kept: ignored
  const kept = h.readHistory("acct", dir);
  assert.deepEqual(kept.map((u) => [u.fiveHour, u.at]), [[10, t0], [11, t0 + 2000], [11, t0 + 16 * 60_000]]);
  // A torn line is skipped, not fatal.
  fs.appendFileSync(path.join(dir, "acct.history.jsonl"), "{not json\n");
  assert.equal(h.readHistory("acct", dir).length, 3);
});

test("two queried readings whose reset times differ by a few ms inside 15 minutes make one history line", () => {
  const { parseUsage } = require("../out/usage.js");
  const dir = path.join(home, "history-ms");
  const query = (resetsAt) => parseUsage({ rate_limits: { seven_day: { utilization: 62, resets_at: resetsAt } } });
  // Real readings from ~/.entomatical/usage/main.history.jsonl: weekResets 1794538799.683, then a few ms off.
  const first = query("2026-11-13T02:59:59.683Z"), second = query("2026-11-13T02:59:59.691Z");
  second.at = first.at + 60_000;
  h.recordUsage("ms", first, dir);
  h.recordUsage("ms", second, dir);
  assert.equal(h.readHistory("ms", dir).length, 1);
  assert.equal(first.weekResets, Math.round(Date.parse("2026-11-13T02:59:59.683Z") / 1000));
});

// linux, 10 November 2026: 2,491 of main.history.jsonl's 3,957 lines repeated one reading, appended by several extension processes.
test("recordUsage in two separate processes keeps one copy of the same reading", () => {
  const dir = path.join(home, "history-procs");
  const fresh = () => { delete require.cache[require.resolve("../out/usage-history.js")]; return require("../out/usage-history.js"); };
  const one = fresh(), two = fresh();
  assert.notEqual(one, two, "two module instances, as in two extension hosts");
  const t0 = 1_800_000_000_000, first = claude(10, 20, t0), moved = claude(11, 20, t0 + 1000);
  one.recordUsage("acct", first, dir);
  two.recordUsage("acct", { ...first }, dir); // both have now seen the first reading
  one.recordUsage("acct", moved, dir);
  two.recordUsage("acct", { ...moved }, dir); // the same reading again, from the other process: already in the file
  one.recordUsage("acct", claude(11, 20, t0 + 2000), dir); // the same windows a second on: not kept either
  assert.deepEqual(fs.readFileSync(path.join(dir, "acct.history.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).at), [t0, t0 + 1000]);
});

test("recordUsage trims a history past 1 MB to its newest 2000 lines", () => {
  const dir = path.join(home, "history-b");
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ ...claude(1, 1, 1), pad: "x".repeat(400) }) + "\n";
  fs.writeFileSync(path.join(dir, "big.history.jsonl"), line.repeat(3000));
  h.recordUsage("big", claude(2, 2, 2_000_000_000_000), dir);
  const lines = fs.readFileSync(path.join(dir, "big.history.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 2000);
  assert.equal(JSON.parse(lines.at(-1)).fiveHour, 2);
});

test("a run's usage is stamped when the card enters Running and when it reaches Review; a resume is a second run", () => {
  const repo = fs.mkdtempSync(path.join(home, "repo-"));
  fs.mkdirSync(path.join(repo, ".entomatical"), { recursive: true });
  const board = new Board(repo, path.join(repo, "hook.js"));
  test.after(() => board.dispose());
  board.accountList = () => [{ name: "me", configDir: "" }]; // ~/.claude, usage key "main"
  fs.mkdirSync(usageDir, { recursive: true });
  const write = (u) => fs.writeFileSync(path.join(usageDir, "main.json"), JSON.stringify(u));
  write(claude(10, 20, Date.now()));
  const task = board.add("Metered", "prompt", "me");
  board.update(task, { sessionId: "s1", status: "running" });
  assert.equal(task.usageRuns.length, 1);
  assert.equal(task.usageRuns[0].start.fiveHour, 10);
  assert.equal(task.usageRuns[0].endedAt, undefined);
  board.update(task, { status: "needs-input" });
  board.update(task, { status: "running" }); // answering a question is not a new run
  assert.equal(task.usageRuns.length, 1);
  write(claude(14, 21, Date.now()));
  board.update(task, { status: "review" });
  assert.equal(task.usageRuns[0].end.fiveHour, 14);
  assert.deepEqual(h.taskCost(task.usageRuns).windows, [{ name: "5-hour", points: 4 }, { name: "weekly", points: 1 }]);
  // Saved with the task.
  const saved = JSON.parse(fs.readFileSync(path.join(repo, ".entomatical", "tasks.json"), "utf8")).find((t) => t.id === task.id);
  assert.equal(saved.usageRuns[0].end.fiveHour, 14);
  // Resume: a second run; Done closes it.
  board.update(task, { status: "running" });
  write(claude(15, 21, Date.now()));
  board.update(task, { status: "done" });
  assert.equal(task.usageRuns.length, 2);
  assert.deepEqual(h.taskCost(task.usageRuns), { windows: [{ name: "5-hour", points: 5 }, { name: "weekly", points: 1 }], runs: 2, open: false });
  // A found session is not metered.
  const found = board.add("Found", "p", "me");
  found.adopted = true;
  board.update(found, { status: "running" });
  assert.equal(found.usageRuns, undefined);
});
