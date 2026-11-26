// Battle Royale's arena (the user, 14 November 2026): before a battle's cards start, every card and run of every board this window owns
// is warned, given 30 seconds, stopped and parked ("interrupting orchestrators and other agents giving them 30 seconds to pause, save, do
// whatever they need to because the cards are getting shutdown to clear the arena… killing orphan processes and other similar resource
// freeing techniques"). He chose stop and park: nothing is merged, pushed, finished, cancelled or deleted, except the leftover folders of
// merged cards that Finish could not delete. The extension (src/extension.ts) holds the popup's messages, the countdown and the report;
// this file holds what it does to the boards, the pure choice of leftover processes, and the one OS-specific part: listing and ending them.
import * as fs from "fs";
import { execFile } from "child_process";
import type { Board, Task } from "./board";

export const ARENA_WARNING = "Battle Royale is starting. This card is shut down in 30 seconds. Stop now, save or commit your work in this worktree, and write one line saying where you stopped.";
export const ARENA_CALLED_OFF = "Battle Royale was called off. Carry on.";
/** The card event of each card the battle stopped (its Timeline shows it). */
export const ARENA_STOPPED = "Stopped for Battle Royale";

/** The Board calls the arena makes. Tests pass stand-ins. */
export type ArenaBoard = Pick<Board, "repo" | "tasks" | "isOwner" | "live" | "liveRun" | "stopRun" | "stop" | "pauseRun" | "resumeRun" | "update"
  | "warnBattle" | "battleNotice" | "noteEvent" | "retryCleanups"> & { checks: { stop(task: Task): void } };

const isMaster = (t: Task) => !!t.orchestrator && !t.orchestrator.root;
/** The runs a battle stops: a run with a card running, or an unfinished one that is not paused (it may still open cards). */
export function arenaRuns(b: ArenaBoard): Task[] {
  return b.tasks.filter((t) => isMaster(t) && !t.cancelled && (b.liveRun(t).length > 0 || (t.status !== "done" && !t.paused)));
}
/**
 * The cards a battle stops: a session running (a terminal, card terminal, panel or headless run), its acceptance checks running, or a
 * review or helper call the extension runs for it (`busy`).
 */
export function arenaCards(b: ArenaBoard, busy: (id: string) => boolean): Task[] {
  const live = new Set(b.live());
  return b.tasks.filter((t) => live.has(t.id) || t.checks?.status === "running" || busy(t.id));
}
/** The boards of this window, split into the ones it owns (cleared) and the ones another window owns (skipped and reported). */
export function arenaBoards(boards: readonly ArenaBoard[]): { owned: ArenaBoard[]; skipped: ArenaBoard[] } {
  const owned: ArenaBoard[] = [], skipped: ArenaBoard[] = [];
  for (const b of boards) (b.isOwner() ? owned : skipped).push(b);
  return { owned, skipped };
}

/** What a warning changed, so a call-off can put it back. */
export interface Warned {
  /** When it went out (ms): the 30 seconds run from here. */
  at: number;
  /** Cards that were told, by typed text or a notice; a session that takes neither only gets the wait. */
  told: { board: ArenaBoard; id: string; how: "typed" | "notice" }[];
  /** Runs it paused (a run paused before is not resumed by a call-off). */
  paused: { board: ArenaBoard; id: string }[];
  /** Queued cards whose `held` it cleared: they keep their Start button but no longer start by themselves. */
  held: { board: ArenaBoard; id: string }[];
}

const find = (board: ArenaBoard, id: string) => board.tasks.find((t) => t.id === id);

/**
 * The warning: every run is paused so no new card opens, held cards stop waiting to start, and every card with work running is told it
 * is shut down in 30 seconds (Board.warnBattle). Best effort: a failure leaves that card or run as it was.
 */
export function warnArena(boards: readonly ArenaBoard[], busy: (id: string) => boolean, now: number): Warned {
  const w: Warned = { at: now, told: [], paused: [], held: [] };
  for (const board of boards) {
    for (const run of arenaRuns(board)) {
      if (run.paused) continue;
      try { board.pauseRun(run); w.paused.push({ board, id: run.id }); } catch { /* best effort */ }
    }
    for (const t of board.tasks.filter((x) => x.status === "queued" && x.held)) {
      try { board.update(t, { held: undefined }); w.held.push({ board, id: t.id }); } catch { /* best effort */ }
    }
    for (const t of arenaCards(board, busy)) {
      try { const how = board.warnBattle(t, ARENA_WARNING); if (how !== "wait") w.told.push({ board, id: t.id, how }); } catch { /* the card only gets the wait */ }
    }
  }
  return w;
}

/**
 * No after a warning: the told cards hear it is off, the runs it paused resume and the held cards wait to start again. An orchestrator
 * that has not read its warning yet just loses it (Resume run would otherwise wake an idle one with it); one that read it is told.
 */
export function callOff(w: Warned): void {
  for (const { board, id, how } of w.told) {
    const t = find(board, id);
    if (!t) continue;
    try {
      if (how === "notice" && board.battleNotice(id, undefined)) continue; // unread: dropped
      board.warnBattle(t, ARENA_CALLED_OFF);
    } catch { /* best effort */ }
  }
  for (const { board, id } of w.paused) {
    const run = find(board, id);
    if (run?.paused === true) try { board.resumeRun(run); } catch { /* best effort */ } // paused otherwise since (a budget): left so
  }
  for (const { board, id } of w.held) {
    const t = find(board, id);
    if (t && t.status === "queued" && !t.sessionId && !t.held) try { board.update(t, { held: true }); } catch { /* best effort */ }
  }
}

export interface Stopped { cards: number; runs: number; failures: string[] }
const said = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The stop, after the wait: Stop run on each run (its cards land in Review, interrupted, worktrees kept), Stop on each card still
 * running, then each card's checks, and the review and helper calls the extension runs for it (`stopWork`, true when it stopped any).
 * A card whose work ended by itself meanwhile is left alone. Every stopped card gets the event "Stopped for Battle Royale", and an
 * unread warning in its inbox is dropped. Never throws: a failure is collected and the battle goes on. Nothing is committed, merged,
 * pushed, finished, cancelled or deleted.
 */
export function stopArena(boards: readonly ArenaBoard[], busy: (id: string) => boolean, stopWork: (id: string) => boolean): Stopped {
  const out: Stopped = { cards: 0, runs: 0, failures: [] };
  for (const board of boards) {
    const targets = new Map(arenaCards(board, busy).map((t) => [t.id, t]));
    const stopped = new Set<string>();
    for (const run of arenaRuns(board)) {
      const cards = board.liveRun(run);
      try {
        board.stopRun(run);
        out.runs++;
        for (const t of cards) { stopped.add(t.id); targets.set(t.id, t); }
      } catch (e) { out.failures.push(`run "${run.title}": ${said(e)}`); }
    }
    const live = new Set(board.live());
    for (const t of targets.values()) {
      let done = stopped.has(t.id);
      if (!done && live.has(t.id)) try { board.stop(t); done = true; } catch (e) { out.failures.push(`"${t.title}": ${said(e)}`); }
      if (t.checks?.status === "running") try { board.checks.stop(t); done = true; } catch (e) { out.failures.push(`checks of "${t.title}": ${said(e)}`); }
      try { if (stopWork(t.id)) done = true; } catch (e) { out.failures.push(`the review or helpers of "${t.title}": ${said(e)}`); }
      if (!done) continue;
      out.cards++;
      try { board.noteEvent(t.id, "BattleRoyale", ARENA_STOPPED); } catch { /* the event is a record, never a blocker */ }
      try { board.battleNotice(t.id, undefined); } catch { /* best effort */ }
    }
  }
  return out;
}

/** One process as the OS lists it. started: when it started (ms on Windows, clock ticks since boot on Linux), for ordering only. */
export interface Proc { pid: number; ppid: number; name: string; command: string; started?: number }

/**
 * The leftover processes the sweep ends (pure): each process whose command line names a path under <root>/.entomatical/wt/ or
 * <root>/.entomatical/tmp/ of a cleared board, with every process below it, never a protected pid (the extension host), anything above
 * one, or a system pid (4 and below). A path counts only where a path can start (the line's start, a space, a quote, = , ; : ( or /), so
 * /backup/home/rob/Entomatical does not pass for /home/rob/Entomatical. On Windows paths compare without case and with either slash. A
 * child counts only when it started after its parent: Windows hands a dead parent's pid to new processes.
 */
export function leftovers(procs: readonly Proc[], roots: readonly string[], protect: readonly number[], platform: NodeJS.Platform = process.platform): number[] {
  const win = platform === "win32";
  const norm = (s: string) => (win ? s.replace(/\\/g, "/").toLowerCase() : s);
  const dirs = roots.flatMap((r) => { const base = norm(r).replace(/\/+$/, ""); return [`${base}/.entomatical/wt/`, `${base}/.entomatical/tmp/`]; });
  const names = (command: string) => {
    const line = norm(command ?? "");
    return dirs.some((d) => {
      for (let i = line.indexOf(d); i >= 0; i = line.indexOf(d, i + 1)) {
        if ((i === 0 || /[\s"'=,;:(/]/.test(line[i - 1])) && /[^\s"'/]/.test(line[i + d.length] ?? "")) return true;
      }
      return false;
    });
  };
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const parentOf = (p: Proc) => {
    const up = byPid.get(p.ppid);
    return up && up.pid !== p.pid && !(up.started !== undefined && p.started !== undefined && up.started > p.started) ? up : undefined;
  };
  const shield = new Set<number>();
  for (const pid of protect) {
    shield.add(pid);
    for (let p = byPid.get(pid), n = 0; p && n < 256; n++) { p = parentOf(p); if (p) shield.add(p.pid); }
  }
  const children = new Map<number, Proc[]>();
  for (const p of procs) { const up = parentOf(p); if (up) children.set(up.pid, [...(children.get(up.pid) ?? []), p]); }
  const out = new Set<number>(), visit = procs.filter((p) => names(p.command));
  while (visit.length) {
    const p = visit.pop()!;
    if (out.has(p.pid) || shield.has(p.pid) || p.pid <= 4) continue;
    out.add(p.pid);
    visit.push(...(children.get(p.pid) ?? []));
  }
  return [...out].sort((a, b) => a - b);
}

/** Every process with its command line: Windows asks PowerShell (CIM), Linux reads /proc. */
export async function listProcesses(): Promise<Proc[]> {
  if (process.platform === "win32") {
    // CreationDate as ms since 1601 fits a JSON number; a process without one (System) has none.
    const ps = "$ErrorActionPreference = 'SilentlyContinue'; @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; command = [string]$_.CommandLine; started = $(if ($_.CreationDate) { [int64]($_.CreationDate.ToFileTimeUtc() / 10000) } else { $null }) } }) | ConvertTo-Json -Compress -Depth 2";
    const out = await new Promise<string>((resolve, reject) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")],
      { encoding: "utf8", maxBuffer: 1 << 26, timeout: 60_000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
    const list = JSON.parse(out);
    if (!Array.isArray(list) || !list.length) throw new Error("PowerShell listed no processes.");
    return list.map((p: any) => ({ pid: Number(p.pid), ppid: Number(p.ppid), name: String(p.name ?? ""), command: String(p.command ?? ""), ...(typeof p.started === "number" ? { started: p.started } : {}) }));
  }
  // /proc/<pid>/stat: the name in parentheses (it may hold spaces), then state, ppid … and starttime, the 22nd field.
  const out: Proc[] = [];
  for (const entry of fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const command = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      out.push({ pid: Number(entry), ppid: Number(fields[1]) || 0, name: stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")), command, started: Number(fields[19]) || 0 });
    } catch { /* ended while listed, or not ours to read */ }
  }
  if (!out.length) throw new Error("/proc listed no processes.");
  return out;
}

/**
 * Ends each pid on its own (the tree is already in the list, so no protected process below one can be reached): taskkill /F on Windows,
 * SIGTERM on Linux. A pid already gone is neither ended nor a failure.
 */
export async function endProcesses(pids: readonly number[]): Promise<{ ended: number; failures: string[] }> {
  const r = { ended: 0, failures: [] as string[] };
  if (process.platform !== "win32") {
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); r.ended++; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") r.failures.push(`process ${pid}: ${said(e)}`); }
    }
    return r;
  }
  const one = (pid: number) => new Promise<void>((resolve) => execFile("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true, timeout: 15_000 }, (err) => {
    // taskkill exits 128 when the process is not found.
    if (!err) r.ended++; else if ((err as { code?: unknown }).code !== 128) r.failures.push(`process ${pid}: ${said(err).split(/\r?\n/).filter(Boolean).at(-1)}`);
    resolve();
  }));
  for (let i = 0; i < pids.length; i += 8) await Promise.all(pids.slice(i, i + 8).map(one));
  return r;
}

/**
 * The sweep, after the stop: the leftover processes of the cleared boards are ended, then the folders of merged cards that Finish could
 * not delete are retried (Board.retryCleanups). Never throws.
 */
export async function sweepArena(boards: readonly ArenaBoard[], protect: readonly number[],
  list: () => Promise<Proc[]> = listProcesses, end: (pids: readonly number[]) => Promise<{ ended: number; failures: string[] }> = endProcesses):
  Promise<{ ended: number; removed: number; failures: string[] }> {
  const out = { ended: 0, removed: 0, failures: [] as string[] };
  try {
    const pids = leftovers(await list(), boards.map((b) => b.repo), protect);
    const r = await end(pids);
    out.ended = r.ended;
    out.failures.push(...r.failures);
  } catch (e) { out.failures.push(`the process list: ${said(e)}`); }
  for (const board of boards) {
    try { const r = await board.retryCleanups(); out.removed += r.removed; out.failures.push(...r.failed); }
    catch (e) { out.failures.push(`merged worktrees: ${said(e)}`); }
  }
  return out;
}
