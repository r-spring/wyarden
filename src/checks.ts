import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile, execFileSync } from "child_process";
import type { Board, Task } from "./board";
import { checkRuleId, isTop } from "./done-review";
import { runCards } from "./orchestrator";
import { alive, readJson, saveJson, startWorker, type Receipt } from "./jobs";
import { tempEnv, tempRoot } from "./workspace";
import { rerootBoardPath } from "./moved";

/** How many run folders a card keeps under .entomatical/checks/<id>. */
const KEEP_RUNS = 10;
/** Phase 4: the worktree's HEAD when nothing is uncommitted or untracked, else undefined (the checks then cover no single revision). */
function treeAt(worktree: string, branch?: string): string | undefined {
  const run = (args: string[]) => execFileSync("git", args, { cwd: worktree, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 5000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
  try {
    if (branch && run(["symbolic-ref", "HEAD"]) !== `refs/heads/${branch}`) return undefined;
    return run(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]) ? undefined : run(["rev-parse", "HEAD"]);
  } catch { return undefined; }
}

/** Linux: whether pid is this run's worker, whose command line names the run's job.json (jobs.ts startWorker). */
function runsJob(pid: number, run: string, strict: boolean): boolean {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(path.join(run, "job.json")); }
  catch (error) {
    if (strict && !["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    return false;
  }
}

/** Windows: whether pid runs the executable the worker runs as (node, or VS Code's own with ELECTRON_RUN_AS_NODE), so taskkill spares most reused pids. */
function runsWorkerImage(pid: number): boolean {
  try {
    const row = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    return row.trim().toLowerCase().startsWith(`"${path.basename(process.execPath).toLowerCase()}"`);
  } catch { return false; }
}

/** The run's receipt (or its launch record before the worker wrote one), and whether its worker still runs. */
function worker(run: string, strict = false, launchedIn = run): { receipt?: Receipt; live: boolean } {
  let receipt: Receipt | undefined;
  for (const name of ["receipt.json", "launch.json"]) {
    try { receipt = readJson<Receipt>(path.join(run, name)); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  // Linux names the process itself: a stalled worker (suspend, a busy disk) is still found, and a reused pid never is.
  if (process.platform === "linux") return { receipt, live: receipt?.status === "running" && !!receipt.pid && runsJob(receipt.pid, launchedIn, strict) };
  const sameBoot = !receipt?.bootTime || Math.abs(receipt.bootTime - (Date.now() - os.uptime() * 1000)) < 120_000;
  // The worker writes its heartbeat every 5 s: an older one means a dead worker whose pid another process now has.
  const beating = Date.now() - (receipt?.heartbeat ?? 0) < 60_000;
  return { receipt, live: receipt?.status === "running" && !!receipt.pid && alive(receipt.pid) && sameBoot && beating };
}

/**
 * The check catalogue (spec 13.3 item 11, F76; 4 November 2026): `<repo>/workflows/checks.json` names the project's deterministic
 * checks once, `{ "<name>": { "run": "npm test", "what": "unit tests and parity", "minutes": 4 } }`. When the file exists, a
 * completion rule and an orchestrator's `add` may only name commands from it; a command not in it is refused as a check.
 * Without the file ordinary cards keep their existing unrestricted behaviour. Orchestrator planning creates an empty catalogue;
 * an empty catalogue intentionally permits no checks until the project adds entries. Invalid catalogues never disable limits.
 */
export interface CatalogueEntry { run: string; what?: string; minutes?: number }
export type Catalogue = Record<string, CatalogueEntry>;
export const CATALOGUE_PATH = path.join("workflows", "checks.json");
/** The catalogue, or undefined only when absent. A malformed or unreadable file is an actionable configuration error. */
export function readCatalogue(repo: string): Catalogue | undefined {
  const file = path.join(repo, CATALOGUE_PATH);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected an object of named checks");
    const out: Catalogue = {};
    for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!name.trim() || !v || typeof v !== "object" || Array.isArray(v) || typeof (v as CatalogueEntry).run !== "string" || !(v as CatalogueEntry).run.trim())
        throw new Error(`check ${JSON.stringify(name)} needs a nonempty run command`);
      out[name] = v as CatalogueEntry;
    }
    return out;
  } catch (e) { throw new Error(`Invalid ${file}: ${e instanceof Error ? e.message : String(e)}`); }
}
/** Set up the plan's check catalogue without replacing any existing project policy. */
export function ensureCatalogue(repo: string): Catalogue {
  const existing = readCatalogue(repo);
  if (existing) return existing;
  const file = path.join(repo, CATALOGUE_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, "{}\n", { flag: "wx" }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  return readCatalogue(repo)!;
}
const same = (a: string, b: string) => a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");
/** A command's catalogue name, by its `run` text or its name; undefined when the catalogue lacks it. */
export const inCatalogue = (command: string, catalogue: Catalogue) => Object.keys(catalogue).find((name) => same(catalogue[name].run, command) || same(name, command));
/**
 * Audit, 10 November 2026: an auto-finish check is killed after its catalogue `minutes` times CHECK_TIME_FACTOR; no `minutes` counts
 * as the default.
 * BUG-14 (19 November 2026): `minutes` is the estimate of one run with nothing ahead of it: the slowest run measured on a supported
 * machine plus a quarter, rounded up to a whole minute. The limit covers the whole command, and a command can wait before it works:
 * `npm test` queues behind every full run of the workspace (test/full-test-lock.js). So the factor is the queue's share: at 3, a
 * check may wait for two full runs ahead of it and still finish its own.
 */
export const CHECK_TIME_FACTOR = 3, DEFAULT_CHECK_MINUTES = 10;
/** No command's limit is longer than a day, whatever its catalogue entry says. */
export const MAX_CHECK_LIMIT_MS = 24 * 60 * 60_000;
/**
 * One command's time limit in ms from its catalogue `minutes`: always a whole number from 1 to MAX_CHECK_LIMIT_MS, never "none".
 * The worker sets no timer for a limit that is missing, 0 or null (worker.ts runChecks). JSON reads `1e999` as Infinity and writes
 * Infinity back as null, a tiny product would round to 0, and Node runs a timer longer than 2^31-1 ms after 1 ms. So `minutes` that
 * is not a positive finite number counts as the default, and the product is rounded, at least 1 and capped.
 */
export const checkLimitMs = (minutes: unknown) => {
  const estimate = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_CHECK_MINUTES;
  return Math.min(MAX_CHECK_LIMIT_MS, Math.max(1, Math.round(estimate * CHECK_TIME_FACTOR * 60_000)));
};
/** Each command's time limit in ms, for runChecks' job: one for every command, in the catalogue or not. */
export const checkLimitsMs = (commands: string[], catalogue: Catalogue | undefined) =>
  commands.map((c) => checkLimitMs(catalogue?.[inCatalogue(c, catalogue) ?? ""]?.minutes));
/** Splits commands into the ones the catalogue allows (as their `run` text) and the ones it refuses. No catalogue: everything is kept. */
export function limitToCatalogue(commands: string[], catalogue: Catalogue | undefined): { kept: string[]; refused: string[] } {
  if (!catalogue) return { kept: [...commands], refused: [] };
  const kept: string[] = [], refused: string[] = [];
  for (const c of commands) { const name = inCatalogue(c, catalogue); if (name) kept.push(catalogue[name].run); else refused.push(c); }
  return { kept, refused };
}

/**
 * A task's acceptance checks. They run in its worktree each time its work comes to Review, in a detached worker, and the card shows
 * the latest result.
 */
export class TaskChecks {
  /**
   * Called once per finished run: whether every command passed, or why not. The extension says so, with Retry checks on a failure.
   * Until it is set (the board's first tick runs before the extension wires it), finished runs wait, so none goes unannounced.
   */
  onResult?: (task: Task, passed: boolean, error?: string) => void;
  constructor(private board: Board) {}
  /** Whether this task has checks to run. */
  owns(task: Task) {
    return !!task.completion?.commands.length;
  }
  /** Board-run plan delivery evidence. A ready request or explicit retry can start a missing run. */
  deliveryProblem(task: Task, startMissing = false): string | undefined {
    const commands = task.planRun?.deliveryCommands;
    if (!commands) return;
    if (!commands.length || JSON.stringify(commands) !== JSON.stringify(task.completion?.commands))
      return "The delivery rule differs from the commands approved for this plan.";
    const revision = task.worktree && task.branch && treeAt(task.worktree, task.branch);
    if (!revision) return "Delivery checks require a clean checkout of the plan branch. Commit the repair before running ready.";
    const c = task.checks;
    if (c?.status === "running") return "Delivery checks are running. See board.js show self, then retry ready.";
    if (c?.status === "complete" && c.clean && c.revision === revision && c.phase === "delivery" && c.at &&
        path.dirname(c.run) === path.join(this.board.dir, "checks", task.id)) {
      try {
        const receipt = readJson<Receipt>(path.join(c.run, "receipt.json"));
        if (receipt.status === "complete" && receipt.checksPassed === true && receipt.revision === revision &&
            receipt.phase === c.phase && receipt.at === c.at && receipt.ruleId === checkRuleId(task.prompt, task.completion, []) &&
            JSON.stringify(receipt.commands) === JSON.stringify(commands)) return;
      } catch { /* Missing or unreadable receipts cannot release delivery. */ }
    }
    const reason = c?.status === "error" && c.revision === revision ? c.error || "Delivery checks failed." : "No current passing delivery receipt.";
    if (!startMissing) return reason;
    this.start(task, true);
    return `${reason} Started delivery checks on ${revision}. See board.js show self, then retry ready.`;
  }
  /** Pin the checked commit before a Finish or Merge target effect. */
  deliveryRevision(task: Task): string | undefined {
    if (!task.planRun?.deliveryCommands) return;
    const problem = this.deliveryProblem(task);
    if (problem) throw new Error(`${problem} Run board.js ready on the plan card to verify its current commit.`);
    return task.checks!.revision;
  }
  retry(task: Task) {
    if (!task.planRun?.deliveryCommands) return this.start(task);
    if (task.paused || task.cancelled || task.status === "done") throw new Error("Delivery checks require an active plan.");
    const problem = this.deliveryProblem(task, true);
    if (problem && task.checks?.status !== "running") throw new Error(problem);
  }
  /** Runs the checks now (work came to Review, or Retry checks), ending the card's earlier run if it still goes: one run per worktree. */
  start(task: Task, planDelivery = false) {
    if (task.planRun?.deliveryCommands && !planDelivery) return; // the reviewer settling in Review must not launch a second suite
    if (!this.owns(task) || (task.orchestrator && !task.deliveryReady && !planDelivery)) return;
    this.board.mustOwn();
    // Never the main checkout: Finish, Merge and Discard clear the worktree, and Reopen or an old Retry toast can come after.
    if (!task.worktree || !fs.existsSync(task.worktree))
      return this.board.recordChecks(task, { status: "error", run: "", error: "This task's worktree is gone, so its checks cannot run." });
    this.stop(task);
    const run = path.join(this.board.dir, "checks", task.id, String(Date.now()));
    // Recorded first: a start that throws must not leave an older "passed" that releases Start after cards.
    let revision: string | undefined;
    try { revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: task.worktree, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim(); }
    catch { /* A check can run outside a Git repository; absence is explicit in its metadata. */ }
    const context = { revision, phase: task.orchestrator ? "delivery" as const : "task" as const, at: new Date().toISOString(), clean: !!revision && treeAt(task.worktree) === revision };
    this.board.recordChecks(task, { status: "running", run, ...context });
    try {
      const children = isTop(task) ? runCards(task.id, this.board.tasks).map(t => ({ id: t.id, prompt: t.prompt, doneWhen: t.completion?.doneWhen })) : [];
      saveJson(path.join(run, "job.json"), { commands: task.completion!.commands, cwd: task.worktree, ruleId: checkRuleId(task.prompt, task.completion, children), ...context });
      startWorker(path.join(run, "job.json"), tempEnv(this.board.cardTemp(task), tempRoot(this.board.repo)));
    } catch (e) {
      this.board.recordChecks(task, { status: "error", run, ...context, error: `Acceptance checks could not start: ${e instanceof Error ? e.message : e}` });
      throw e;
    }
    this.prune(task.id);
  }
  /** Ends the card's run that is still going, with the commands it started (a process group on Linux, the process tree on Windows). */
  stop(task: Task) {
    const current = this.runningWorker(task);
    if (current) this.stopWorker(current.pid);
  }

  /** Capture which worker a transition will displace, without signalling it before the card commit. */
  runningWorker(task: Task) {
    if (task.checks?.status !== "running" || !task.checks.run) return;
    const { live, receipt } = worker(task.checks.run, true);
    if (live && receipt?.pid) return { run: task.checks.run, pid: receipt.pid };
  }

  /** A crash or temporary receipt read error after the commit leaves the exact old worker on the card for the next owner. */
  retire(task: Task, prune = true) {
    if (!task.retiringChecks?.length) return;
    const remaining = task.retiringChecks.filter(({ run, pid }) => {
      // The worker's command line retains the original job path when its workspace is renamed.
      const local = rerootBoardPath(run, this.board.dir);
      if (path.dirname(local) !== path.join(this.board.dir, "checks", task.id)) return false;
      const current = worker(local, true, run);
      if (!current.live || current.receipt?.pid !== pid) return false;
      this.stopWorker(pid);
      return true; // signalling is asynchronous; the owner checks the same job on its next poll
    });
    if (prune && remaining.length !== task.retiringChecks.length)
      this.board.recordRetiringChecks(task, remaining);
  }

  private stopWorker(pid: number) {
    // Windows names only the executable, so keep the existing process-image check before taskkill.
    if (process.platform === "win32") { if (runsWorkerImage(pid)) execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {}); }
    else try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
  }
  /** Keeps the newest run folders of a card. Best effort: a folder still in use on Windows goes next time. */
  private prune(id: string) {
    const dir = path.join(this.board.dir, "checks", id);
    for (const name of fs.readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(b) - Number(a)).slice(KEEP_RUNS))
      try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch { /* in use */ }
  }
  /** Copies finished runs onto their cards. A worker that died mid-run is not run again by itself: its commands may have changed things. */
  sync() {
    for (const task of this.board.tasks) {
      this.retire(task);
      if (!this.onResult) continue;
      const c = task.checks;
      if (c?.status !== "running") continue;
      const observed = worker(c.run);
      if (observed.live) continue;
      let receipt = observed.receipt;
      if (!receipt || receipt.status === "running") {
        // The worker may have written its final receipt and exited between the first read and the liveness check.
        const file = path.join(c.run, "receipt.json");
        if (fs.existsSync(file)) {
          const latest = readJson<Receipt>(file);
          if (latest.status === "complete" || latest.status === "error") receipt = latest;
        }
      }
      const passed = receipt?.status === "complete" && receipt.checksPassed === true;
      const error = passed ? undefined : receipt?.status === "error" ? (receipt.error || "no reason given").replace(/^Error: /, "") : "Acceptance checks were interrupted. Retry checks when ready.";
      // Phase 4: a pass covers its revision only if the tree stayed clean at that HEAD for the whole run.
      const clean = passed && !!c.clean && !!task.worktree && treeAt(task.worktree) === c.revision;
      this.board.recordChecks(task, { ...c, status: passed ? "complete" : "error", error, ...(c.clean !== undefined ? { clean } : {}), ...(!passed && receipt?.failure ? { failure: receipt.failure } : {}) });
      this.onResult(task, passed, error);
    }
  }
}
