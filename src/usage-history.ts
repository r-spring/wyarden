/**
 * Usage history and what a task cost in percentage points.
 *
 * Each account's latest quota reading lives in ~/.entomatical/usage/<key>.json (one overwritten file: statusline.js, both wrappers,
 * accounts.ts and codex.ts write it). That alone cannot say what a task cost, so this keeps a history beside it,
 * <key>.history.jsonl, one reading per line, appended whenever a reading differs from the last one kept (or 15 minutes have passed).
 * A task records the account's reading when its session starts running and again when it reaches Review or Done (Board.stampUsage);
 * the difference is how many percentage points of each window the account moved while the task ran. Other sessions on the same
 * account move the same window, so the figure is "the account's usage moved by" rather than "this task alone used"; the card says so.
 * A window that reset during a run has no comparable figure, and says so instead of a number.
 */
import * as fs from "fs";
import * as path from "path";
import { Usage, USAGE_DIR, windowName } from "./sessions";

/** One run of a task's session: from entering Running to reaching Review or Done. */
export interface UsageRun {
  startedAt: number;
  /** The account's reading when the run started, with windows that had already reset taken as 0. */
  start?: Usage;
  endedAt?: number;
  end?: Usage;
}

/** One window of a reading, by name ("5-hour", "weekly", "{n}-hour", "{n}-day"). */
export interface Reading { name: string; pct: number; resets?: number }

/** Measured movement across finished runs. Points are a subtotal when any run crossed a reset or lacked either endpoint. */
export interface WindowCost { name: string; points?: number; reset?: boolean; incomplete?: boolean }
export interface TaskCost { windows: WindowCost[]; runs: number; open: boolean }

const KEEP_LINES = 2000;
const REPEAT_AFTER = 15 * 60_000;
const historyFile = (key: string, dir: string) => path.join(dir, `${key}.history.jsonl`);

/** A reading's windows by name, in the order the board shows them. */
export function readings(u: Usage | undefined): Reading[] {
  if (!u) return [];
  if (u.windows) return u.windows.filter((w) => typeof w.pct === "number").map((w) => ({ name: windowName(w.minutes), pct: w.pct!, resets: w.resets }));
  const out: Reading[] = [];
  if (typeof u.fiveHour === "number") out.push({ name: "5-hour", pct: u.fiveHour, resets: u.fiveHourResets });
  if (typeof u.week === "number") out.push({ name: "weekly", pct: u.week, resets: u.weekResets });
  return out;
}

const sameReading = (a: Usage, b: Usage) => JSON.stringify(readings(a)) === JSON.stringify(readings(b));

/** The file's last whole reading, read from its tail only: several extension processes append to one history, so no process can cache it. */
function lastInFile(file: string): Usage | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size, tail = Buffer.alloc(Math.min(size, 8192));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    for (const line of tail.toString("utf8").split("\n").reverse()) {
      try { const u = JSON.parse(line); if (u && Number.isFinite(u.at)) return u; } catch { /* a torn or cut-off line */ }
    }
  } catch { /* no history yet */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return undefined;
}

/** Keeps a reading in the account's history when it is new: different windows, or the same ones 15 minutes later. */
export function recordUsage(key: string, usage: Usage | undefined, dir = USAGE_DIR) {
  if (!usage) return;
  const file = historyFile(key, dir);
  // shortcut: two processes reading the tail at the same instant can both append; a lock file if that is ever seen.
  const last = lastInFile(file);
  if (last && (usage.at <= last.at || (sameReading(last, usage) && usage.at - last.at < REPEAT_AFTER))) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, JSON.stringify(usage) + "\n");
  try {
    if (fs.statSync(file).size > 1 << 20) { // bounded: the newest lines are the useful ones
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      fs.writeFileSync(file, lines.slice(-KEEP_LINES).join("\n") + "\n");
    }
  } catch { /* the next append tries again */ }
}

/** The account's kept readings, oldest first. Bad lines are skipped. */
export function readHistory(key: string, dir = USAGE_DIR): Usage[] {
  let text: string;
  try { text = fs.readFileSync(historyFile(key, dir), "utf8"); } catch { return []; }
  const out: Usage[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const u = JSON.parse(line);
      if (u && Number.isFinite(u.at) && u.at > 0) out.push(u);
    } catch { /* a torn line */ }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The reading to take as a run's start: the latest one, except that a window whose reset time had passed by `at` is taken as
 * 0% with no reset time, since the account's usage of it had restarted (any use since is unrecorded, so 0 is the best known value).
 */
export function startReading(latest: Usage | undefined, at: number): Usage | undefined {
  if (!latest) return undefined;
  // Older cache files can contain a reset timestamp for a window whose percentage was missing.
  const measuredAndExpired = (pct?: number, resets?: number) => Number.isFinite(pct) && typeof resets === "number" && resets * 1000 <= at;
  if (latest.windows) return { ...latest, windows: latest.windows.map((w) => (measuredAndExpired(w.pct, w.resets) ? { minutes: w.minutes, pct: 0 } : w)) };
  return { ...latest,
    ...(measuredAndExpired(latest.fiveHour, latest.fiveHourResets) ? { fiveHour: 0, fiveHourResets: undefined } : {}),
    ...(measuredAndExpired(latest.week, latest.weekResets) ? { week: 0, weekResets: undefined } : {}) };
}

/** Percentage points each window moved over the task's runs. */
export function taskCost(runs: UsageRun[] | undefined): TaskCost | undefined {
  if (!runs?.length) return undefined;
  const finished = runs.filter(run => run.endedAt).map(run => ({
    starts: readings(run.start), ends: readings(run.end), endAt: run.end?.at,
  }));
  const names = new Set(finished.flatMap(run => [...run.ends, ...run.starts].map(r => r.name)));
  const windows = Array.from(names, (name): WindowCost => {
    const cost: WindowCost = { name };
    for (const run of finished) {
      const s = run.starts.find(r => r.name === name), e = run.ends.find(r => r.name === name);
      if (!s || !e) { cost.incomplete = true; continue; }
      if ((s.resets !== undefined && run.endAt !== undefined && s.resets * 1000 <= run.endAt) || e.pct < s.pct) { cost.reset = true; continue; }
      cost.points = (cost.points ?? 0) + (e.pct - s.pct);
    }
    return cost;
  });
  return { windows, runs: runs.length, open: !runs.at(-1)!.endedAt };
}
