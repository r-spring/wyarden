import type { Board, Task } from "./board";

// Start after, a limit on running sessions, and interrupted runs, for ordinary cards (the user, 3 November 2026; F82). Taken from the
// workflow scheduler (workflow.ts, F66) and made general: a plan step keeps its own gates there, and nothing here touches one.
// Pure of VS Code so tests drive it directly.

export interface QueueTask {
  id: string; title: string; status: string; createdAt: string;
  sessionId?: string; dependsOn?: string[]; workflow?: unknown;
  /** Opened by, or reported to, an orchestrator or a plan card: its work counts only once that card has merged it and marked it Done. */
  openedBy?: string; watchedBy?: string;
  /** Added with auto-start on but held back: the board starts it once waitReason clears. */
  held?: boolean;
  /** The last turn ended without a Stop (Esc, a declined prompt, the session gone): unfinished work, never a finished card. */
  interrupted?: boolean;
  /** Thrown away with Discard (F72): Done in its column, but its work never landed, so it releases nobody. */
  discarded?: boolean;
  /** The title of a Start after card that was discarded and then deleted from the board (F72): this card stays held. */
  blocked?: string;
  completion?: { commands: string[] };
  checks?: { status: string };
}

/** Holds a session slot: in Running, or started and not yet reporting (queued with a session id). */
export const active = (t: QueueTask) => t.status === "running" || (t.status === "queued" && !!t.sessionId);

/**
 * A card that releases the cards waiting on it: Done, or in Review after a real Stop with its acceptance checks passed (or none).
 * A watched card (an orchestrator's child, a plan step) only at Done: until its watcher merges it, a card that branches from the
 * watcher's branch would not have its changes (plan files, F72, 5 November 2026). A discarded card never: its work did not land.
 */
export const finished = (t: QueueTask) => !t.discarded && (t.status === "done"
  || (!(t.watchedBy ?? t.openedBy) && t.status === "review" && !t.interrupted && (!t.completion?.commands.length || t.checks?.status === "complete")));

// The discarded-blocker rule (discarded, blocked, discardedText) is from the parallel F72 build on card 3a156f's helper branch
// (commit 52c573d, src/queue.ts), taken unchanged at the user's choice of 5 November 2026.
/** The wait text of a card whose Start after card was discarded (spec 4.4 and 6): it stays Queued until the user starts or deletes it. */
export const discardedText = (title: string) => `blocked: ${title} discarded`;

/** Why an ordinary card cannot start by itself yet, or undefined. maxRunning 0 means no limit. */
export function waitReason(task: QueueTask, tasks: QueueTask[], maxRunning: number, starting?: (id: string) => boolean): string | undefined {
  if (!task.workflow && task.blocked) return discardedText(task.blocked);
  for (const id of task.workflow ? [] : task.dependsOn ?? []) { // workflow.ts owns workflow dependencies
    const d = tasks.find((t) => t.id === id);
    if (!d) continue; // a deleted card holds nothing back (a discarded one that was deleted left `blocked` behind)
    if (d.discarded) return discardedText(d.title);
    if (!finished(d)) return d.status === "review" && d.interrupted ? `Waiting: ${d.title} was interrupted` : `Starts after ${d.title}`;
  }
  if (maxRunning <= 0) return undefined;
  const running = tasks.filter(t => t.id !== task.id && (active(t) || starting?.(t.id))).length;
  if (maxRunning > 0 && running >= maxRunning) return `Waiting for a session slot (${running} of ${maxRunning} running)`;
  return undefined;
}

/** The held cards to start now, oldest first, without going over the limit. */
export function toStart(tasks: QueueTask[], maxRunning: number): QueueTask[] {
  const out: QueueTask[] = [];
  let running = tasks.filter(active).length;
  for (const t of tasks.filter((t) => t.held && t.status === "queued" && !t.sessionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (maxRunning > 0 && running >= maxRunning) break;
    if (waitReason(t, tasks, 0)) continue; // a start-after wait; the slot check is the running count here
    out.push(t);
    running++;
  }
  return out;
}

/** The panel returned a result before the Board finished updating the card and its pending messages. */
export class PanelUpdateError extends Error {}

type Dispatch = { state: "waiting" | "started" } | { state: "retry"; at: number } | { state: "failed" | "result-error"; error: string };

/** A saved plan's initial dispatch and the board's queue use the same decision and durable retry state. */
export async function dispatchHeld(board: Board, task: Task, launch: () => Promise<unknown>): Promise<Dispatch> {
  const { openedBy, watchedBy, transfers, terminalLaunch } = task;
  const dispatched = board.dispatchTime(task);
  const current = () => board.isOwner() && board.get(task.id) === task && !task.cancelled && !task.takenOver && !task.controller &&
    !task.stepHold && task.openedBy === openedBy && task.watchedBy === watchedBy && task.transfers === transfers;
  if (!task.held || task.sessionId || task.status !== "queued" || board.isStarting(task.id) || !current()) return { state: "waiting" };
  const resumingAttempt = task.startRetryAt && task.workflow?.attempt && task.workflow.outcome === "pending" && !task.workflow.scope;
  if ((task.workflow && !resumingAttempt && board.readinessOf(task)?.state !== "ready") || board.startWait(task)) return { state: "waiting" };
  if (task.launchError && !task.startRetryAt) return { state: "waiting" };
  if (task.startRetryAt && task.startRetryAt > Date.now()) return { state: "retry", at: task.startRetryAt };
  const retry = !!task.startRetryAt;
  try {
    await launch();
    if (current() && (task.sessionId || task.cardTerminalStarted || active(task))) {
      if (task.held || task.launchError || task.startRetryAt) board.update(task, { held: undefined, launchError: undefined, startRetryAt: undefined });
      return { state: "started" };
    }
  } catch (e) {
    if (e instanceof PanelUpdateError) return { state: "result-error", error: e.message };
    if (!current() || !task.held || task.status !== "queued" || task.sessionId || board.startWait(task)) return { state: "waiting" };
    const error = e instanceof Error ? e.message : String(e);
    const unconfirmed = task.panelPending || task.terminalLaunch !== terminalLaunch || dispatched !== board.dispatchTime(task) ||
      (task.workflow?.scope && task.workflow.attempt);
    const refusedModel = !!(e as { modelRefused?: boolean } | null)?.modelRefused;
    const startRetryAt = retry || unconfirmed || refusedModel || board.profileProblem(task) ? undefined : Date.now() + 15_000;
    board.update(task, { launchError: error, startRetryAt });
    return startRetryAt ? { state: "retry", at: startRetryAt } : { state: "failed", error };
  }
  return { state: "waiting" };
}
