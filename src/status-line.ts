// The status record the board writes to .entomatical/status.jsonl, one line per card change, for machines (spec 4.2 and 5.4, F70;
// 4 November 2026). Pure of VS Code so tests build records directly. asks (F79) is whether a Review card's last reply asked something
// (null outside Review), repeating (F80) names a run of identical tool calls ("Bash ×6") while the turn runs, and quiet is the minutes
// since the card's last event. The judge is not built: judged is null.
import type { HookEvent, Status, Task } from "./board";
import { localTime } from "./local-time";

export interface StatusRecord {
  id: string;
  /** Evidence for the card's current session, independent of its board column. */
  launchState: ReturnType<typeof launchState>;
  /** When this record was written (ms). */
  at: number;
  status: Status;
  /** When the card entered its current column (ms). */
  since: number;
  title: string;
  /** null: no commands. pending: checks have no result yet, or the orchestrator's delivery is not ready. */
  checks: "passed" | "failed" | "running" | "pending" | "interrupted" | null;
  /** F79: true when a Review card's last reply asks the user something; null outside Review. */
  asks: boolean | null;
  quiet: number | null;
  repeating: string | null;
  judged: "pass" | "fail" | null;
  /** The live line: what the session is doing right now, from the latest tool call's description. */
  doing: string | null;
  /** The first line of the last reply (160 characters at most). */
  last: string | null;
  watchedBy: string | null;
  openedBy: string | null;
  role: Task["role"] | null;
  /** Chips a watcher reacts to: needs input, interrupted, headless, taken over (by the user, or "taken over by <id>" / "handed to <id>", F95), takeover asked by <id>, paused, waits for reset. */
  chips: string[];
  /** The one-line form of this record (statusLine), so board.js prints exactly what the board wrote. */
  line: string;
}

/** The status record's fields that are not a change: a new record is written only when the rest differs. */
export const CHANGE_KEY = (r: StatusRecord) => JSON.stringify({ ...r, at: 0, quiet: 0, line: "" });

/** The live line from the events file: the latest tool call's description while the turn is still running. */
export function liveLine(events: HookEvent[]): { text: string; at: number } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.hook_event_name === "Stop" || e.hook_event_name === "StopFailure" || e.hook_event_name === "Interrupt") return undefined; // the turn ended
    if (typeof e.desc === "string" && e.agent_id === undefined) return { text: e.desc, at: e.t };
  }
  return undefined;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const first = (s: unknown) => (typeof s === "string" ? s.trim().split("\n")[0] : "");

/** One short label per event, for the card's Timeline and `show`: the tool line, the prompt's first words, or the event's name. */
export function eventLabel(e: HookEvent): string {
  if (typeof e.desc === "string") return e.desc;
  switch (e.hook_event_name) {
    case "UserPromptSubmit": return clip(`Prompt: ${first(e.prompt)}`, 80);
    case "Stop": return clip(`Stop: ${first(e.last_assistant_message)}`, 80);
    case "StopFailure": return `StopFailure: ${e.error ?? "API error"}`;
    case "PermissionRequest": return clip(`Permission: ${e.tool_name ?? ""}`, 80);
    case "SessionStart": return `SessionStart${e.source ? ` (${e.source})` : ""}`;
    default: return String(e.hook_event_name ?? "event");
  }
}

const time = localTime;

/** The last `n` events as timeline lines, oldest first. Subagent events are left out. */
export const timeline = (events: HookEvent[], n = 20) => events.filter((e) => e.agent_id === undefined).slice(-n).map((e) => ({ t: e.t, text: `${time(e.t)} ${eventLabel(e)}` }));

/** Minutes since the card's last event, or null before any. */
export const quietMinutes = (events: HookEvent[], now = Date.now()) => (events.length ? Math.max(0, Math.floor((now - events[events.length - 1].t) / 60_000)) : null);

export const ago = (ms: number, now = Date.now()) => {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};

/** The one-line form of a record (spec 4.2). Fixed field order, so a reader can split it with its eyes. */
export function statusLine(r: StatusRecord, now = Date.now()): string {
  const chips = r.chips.length ? `  [${r.chips.join(", ")}]` : "";
  return `${r.id}  ${r.status.padEnd(11)} ${ago(r.since, now).padStart(8)}  checks:${r.checks ?? "none"}  asks:${r.asks === null ? "-" : r.asks ? "yes" : "no"}  quiet:${r.quiet ?? "-"}${r.repeating ? `  repeating:"${r.repeating}"` : ""}${r.judged ? `  judged:${r.judged}` : ""}${r.doing ? `  doing:"${r.doing}"` : ""}${chips}  "${clip(r.title, 80)}"  last: "${r.last ?? ""}"`;
}

export interface RecordInput {
  events: HookEvent[]; lastReply?: string; now?: number;
  /** Includes transcript and worker activity that did not produce a hook. */
  lastActivityAt?: number;
  /** Settle notices queued for this card that could not go yet (the board's pendingNotices). */
  noticesWaiting?: number;
  /** Why an orchestrator's own checks wait (orchestrator.ts checksWait): they read pending even after an older result. */
  checksWait?: string;
  /** Repeating (F80, board.ts repeating): the run of identical tool calls of a running turn. */
  repeating?: { tool: string; n: number };
}

/** F91: "Stopped after 8 refused calls (last: Write a.txt)", what a card its hook stopped is doing, so its parent's notice says it. */
export const refusalText = (stop: NonNullable<Task["refusalStop"]>) => `Stopped after ${stop.n} refused calls${stop.desc ? ` (last: ${stop.desc})` : ""}`;

/** A session id is allocated before dispatch. Only a matching card-level provider event confirms startup. */
export function launchState(task: Task, events: HookEvent[]) {
  if (task.cancelled) return "cancelled";
  if (task.launchError) return "failed";
  if (task.planRun?.review === "checks") return "no-session";
  if (task.sessionId && events.some((e) => e.hook_event_name === "SessionStart" && e.agent_id === undefined && e.session_id === task.sessionId)) return "confirmed";
  if (task.terminalLaunch && task.terminalLaunch.sessionId === task.sessionId) return task.terminalLaunch.exited ? "exited-unconfirmed" : "dispatched";
  if (task.cardTerminalStarted) return "dispatched";
  if (task.sessionId || task.panelPending) return "requested";
  if (task.held || task.role === "judge" || task.role === "scribe") return "waiting";
  return task.status === "queued" ? "queued" : "unknown";
}

/** The status record of a card now. */
export function statusRecord(task: Task, input: RecordInput): StatusRecord {
  const now = input.now ?? Date.now();
  const stopped = task.status === "needs-input" && task.refusalStop ? refusalText(task.refusalStop) : undefined;
  const live = stopped ? { text: stopped } : ["running", "needs-input"].includes(task.status) ? liveLine(input.events) : undefined;
  const chips: string[] = [];
  if (task.status === "needs-input") chips.push("needs input");
  if (stopped) chips.push("refused calls");
  // A cancelled card is closed on purpose: it is not interrupted work (F95 live check: cancelling one raised "needs you").
  if (task.interrupted && task.status === "review" && !task.cancelled) chips.push("interrupted");
  if (task.headless) chips.push("headless");
  if (task.takenOver) chips.push("taken over");
  const moved = task.transfers?.at(-1); // F95: while the card stays where its last transfer put it
  if (moved && moved.to === task.openedBy) chips.push(`${moved.op === "handoff" ? "handed to" : "taken over by"} ${moved.to}`);
  if (task.takeoverAsk) chips.push(`takeover asked by ${task.takeoverAsk.by}`);
  if (task.paused) chips.push("paused");
  if (task.deliveryReady) chips.push("delivery ready");
  if (task.cancelled) chips.push("cancelled");
  if (task.waitsForReset) chips.push(`waits for reset ${localTime(task.waitsForReset.at)}`);
  if (task.plan && !task.approved) chips.push("plan ready");
  const rebound = task.controller?.sessionId ?? task.orchestrator?.session;
  if (rebound) chips.push(`rebound to ${rebound.slice(0, 8)}`);
  if (input.noticesWaiting) chips.push(`notices waiting ${input.noticesWaiting}`);
  // An assigned check is pending until it runs; a waiting delivery cannot reuse an older result.
  const c = task.checks?.status;
  const checks = !task.completion?.commands.length ? null : c === "running" ? "running" : input.checksWait ? "pending"
    : c === "complete" ? "passed" : c === "error" ? (/^Acceptance checks were interrupted\./.test(task.checks?.error ?? "") ? "interrupted" : "failed") : "pending";
  const r: StatusRecord = {
    id: task.id, at: now, status: task.status, since: Date.parse(task.statusAt ?? task.updatedAt) || now, title: task.title,
    launchState: launchState(task, input.events), checks, asks: task.status === "review" ? task.asks === true : null,
    quiet: input.lastActivityAt === undefined ? quietMinutes(input.events, now) : Math.max(0, Math.floor((now - input.lastActivityAt) / 60_000)),
    repeating: input.repeating ? `${input.repeating.tool} ×${input.repeating.n}` : null, judged: task.judged ?? null,
    doing: live?.text ?? null, last: input.lastReply ? clip(input.lastReply, 160) : null,
    watchedBy: task.watchedBy ?? task.openedBy ?? null, openedBy: task.openedBy ?? null, role: task.role ?? null, chips, line: "",
  };
  r.line = statusLine(r, now);
  return r;
}
