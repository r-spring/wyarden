/**
 * The Review and Finish error log (F103). the user, 13 November 2026: "I need the extension to log errors when the Review or Finish
 * doesn't complete." Each way either ends without completing (a thrown error, a model or runner error, a usage limit, a timeout, a
 * refusal, an invalid model reply, a cancel, a window reload) is one JSON line in <board dir>/errors.jsonl, beside tasks.json, kept
 * under LOG_CAP, and a one-line summary goes to the sink (the extension's "Entomatical" Output channel). No VS Code dependency.
 *
 * A run in flight is a small run record in <board dir>/runs/ (startRun), removed when the run ends. One still there when a window
 * activates, whose extension host is gone, was cut off by a reload or a crash: logInterrupted logs it as interrupted.
 * Never logged: prompts, diffs, environment variables, tokens. Text fields are cut and pass through redact().
 */
import * as fs from "fs";
import * as path from "path";

export type Level = "error" | "warn" | "info";
export type Action = "review" | "finish";
export type Outcome = "failed" | "runner-error" | "limit" | "timeout" | "refused" | "remote-refused" | "invalid-reply" | "cancelled"
  | "interrupted" | "waiting" | "fallback";
export interface LogEntry {
  at: string; level: Level; action: Action; outcome: Outcome; stage: string; card: { id: string; title: string };
  provider?: string; account?: string; model?: string; effort?: string; permission?: string;
  durationMs?: number; message: string; exitCode?: number | null; stderr?: string; receipt?: string; file?: string;
}
export type RunMeta = Pick<LogEntry, "provider" | "account" | "model" | "effort" | "permission" | "receipt" | "file">;

export const LOG_NAME = "errors.jsonl";
export const LOG_CAP = 2 * 1024 * 1024;
const MESSAGE_MAX = 2000, STDERR_MAX = 2048;
export const logFile = (boardDir: string) => path.join(boardDir, LOG_NAME);

let sink: ((line: string) => void) | undefined;
/** Where each entry's one-line summary goes as well (the Output channel); undefined: only the file. */
export function setSink(fn: ((line: string) => void) | undefined) { sink = fn; }

/**
 * Text with what looks like a credential replaced by [redacted]: NAME=value where the name says token, secret, key, password, auth,
 * credential or cookie; a Bearer value; API keys and tokens by their known prefixes.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    .replace(/\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|auth|credential|cookie)[A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1$2[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})/g, "[redacted]");
}
const clip = (s: string, max: number, end = false) => (s.length <= max ? s : end ? `…${s.slice(-max)}` : `${s.slice(0, max)}…`);
const str = (v: unknown, max = 300) => (typeof v === "string" && v ? redact(clip(v, max)) : undefined);

/** One line for the Output channel. */
export function summary(e: LogEntry): string {
  const who = [e.provider, e.account, e.model && `${e.model}${e.effort ? ` · ${e.effort}` : ""}`].filter(Boolean).join(", ");
  return `[${e.at}] ${e.level.toUpperCase()} ${e.action} ${e.outcome} at "${e.stage}": "${e.card.title}" (${e.card.id})${who ? ` [${who}]` : ""}`
    + `${e.durationMs !== undefined ? ` after ${Math.round(e.durationMs / 100) / 10} s` : ""}: ${e.message.split("\n")[0]}`
    + `${e.exitCode !== undefined ? ` (exit ${e.exitCode})` : ""}`;
}

/**
 * Appends one entry: only LogEntry's own fields are kept (anything else the caller passes, an env or a prompt, is dropped), text is
 * cut and redacted. Past cap the oldest lines go, keeping the newest half. Never throws: the log must not break Review or Finish.
 */
export function appendEntry(boardDir: string, raw: Partial<LogEntry> & Pick<LogEntry, "action" | "card" | "message">, cap = LOG_CAP): LogEntry {
  const e: LogEntry = {
    at: typeof raw.at === "string" ? raw.at : new Date().toISOString(), level: raw.level ?? "error", action: raw.action, outcome: raw.outcome ?? "failed",
    stage: str(raw.stage, 200) ?? "(unknown)", card: { id: String(raw.card?.id ?? ""), title: str(raw.card?.title, 200) ?? "" },
    ...Object.fromEntries((["provider", "account", "model", "effort", "permission", "receipt", "file"] as const).flatMap((k) => (str(raw[k]) ? [[k, str(raw[k])]] : []))),
    ...(typeof raw.durationMs === "number" ? { durationMs: Math.round(raw.durationMs) } : {}),
    message: redact(clip(String(raw.message ?? ""), MESSAGE_MAX)),
    ...(raw.exitCode !== undefined ? { exitCode: typeof raw.exitCode === "number" ? raw.exitCode : null } : {}),
    ...(typeof raw.stderr === "string" && raw.stderr.trim() ? { stderr: redact(clip(raw.stderr.trim(), STDERR_MAX, true)) } : {}),
  };
  const line = JSON.stringify(e) + "\n", file = logFile(boardDir);
  try {
    fs.mkdirSync(boardDir, { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* no log yet */ }
    if (size + Buffer.byteLength(line) > cap) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean), kept: string[] = [];
      for (let i = lines.length - 1, used = 0; i >= 0; i--) {
        const n = Buffer.byteLength(lines[i]) + 1;
        if (used + n > cap / 2) break;
        kept.unshift(lines[i]); used += n;
      }
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, kept.length ? kept.join("\n") + "\n" : "");
      fs.renameSync(tmp, file);
    }
    fs.appendFileSync(file, line);
  } catch { /* the log is evidence, never a blocker */ }
  try { sink?.(summary(e)); } catch { /* a closed channel */ }
  return e;
}

/** What an error carries about its runner: exit code and stderr tail (worker.ts, finish.ts), also on its cause; a usage limit. */
export function errorDetail(err: unknown): { message: string; exitCode?: number | null; stderr?: string; limited: boolean } {
  const chain: any[] = [];
  for (let e: any = err; e && typeof e === "object" && chain.length < 4; e = e.cause) chain.push(e);
  const pick = <T>(f: (e: any) => T | undefined) => chain.map(f).find((v) => v !== undefined);
  const attempt = pick((e) => (Array.isArray(e.attempts) ? [...e.attempts].reverse().find((a: any) => a && a.outcome !== "answered") : undefined));
  const own = pick((e) => (e.exitCode === null || typeof e.exitCode === "number" ? e.exitCode : undefined));
  const exitCode = own !== undefined ? own : typeof attempt?.exitCode === "number" ? attempt.exitCode : undefined;
  return { message: err instanceof Error ? err.message : String(err), exitCode, stderr: pick((e) => (typeof e.stderrTail === "string" ? e.stderrTail : undefined)),
    limited: !!pick((e) => (e.allLimited || e.limited ? true : undefined)) };
}

const TIMEOUT = /timed out|time ?out|fifteen minutes|still running after|aborted due to timeout/i;
const LIMIT = /usage limit|Fable limit|rate limit|hit its .* limit/i;
const INVALID = /returned (an invalid|no) |said (Done|Not done|Unsure) but|no structured answer|no result record|was not accepted|ended its turn with/i;
const REFUSED = /already being finished|already running|still working|started working while|Another VS Code window|no worktree|look like secrets|unresolved merge conflicts|uncommitted changes|is not on a branch|no longer exists|not Done or cancelled|cannot be reviewed|Review works on|reviews this card|judges this card|worktree is gone|Only a run's master/i;

/** The outcome an error stands for. RemoteRefused and refusals by text; the rest by the runner's own words. */
export function outcomeOf(err: unknown, stage = ""): Outcome {
  const d = errorDetail(err);
  if ((err as { name?: string })?.constructor?.name === "RemoteRefused" || (err as { remoteRef?: string })?.remoteRef) return "remote-refused";
  if (d.limited || LIMIT.test(d.message)) return "limit";
  if (TIMEOUT.test(d.message)) return "timeout";
  if (REFUSED.test(d.message) || stage === "Checking the task") return "refused";
  if (INVALID.test(d.message)) return "invalid-reply";
  if (d.exitCode !== undefined || d.stderr) return "runner-error";
  return "failed";
}

export interface RunLog {
  readonly startedAt: number;
  /** The stage reached; kept in the run record, so an interrupted run says where it was. */
  stage(name: string): void;
  set(meta: RunMeta): void;
  /** The run ended without completing; level error, unless given (a cancel is info). */
  failed(err: unknown, opts?: { outcome?: Outcome; level?: Level; message?: string }): LogEntry;
  /** Something worth a line that did not end the run (a fallback commit message). */
  note(level: Level, outcome: Outcome, message: string, err?: unknown): LogEntry;
  /** The run ended (completed, or already logged): removes its run record. */
  end(): void;
}
const runsDir = (boardDir: string) => path.join(boardDir, "runs");
interface RunRecord extends RunMeta { action: Action; card: { id: string; title: string }; pid: number; startedAt: string; stage: string }

/** Starts a run's record (a review or a Finish) and returns its logger. */
export function startRun(boardDir: string, action: Action, card: { id: string; title: string }, meta: RunMeta = {}, firstStage = "Starting"): RunLog {
  const startedAt = Date.now(), file = path.join(runsDir(boardDir), `${action}-${card.id.replace(/[^\w-]/g, "_")}-${startedAt}-${process.pid}.json`);
  let stage = firstStage, m: RunMeta = { ...meta }, ended = false;
  const write = () => {
    if (ended) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const record: RunRecord = { action, card: { id: card.id, title: card.title }, pid: process.pid, startedAt: new Date(startedAt).toISOString(), stage, ...m };
      fs.writeFileSync(file, JSON.stringify(record));
    } catch { /* evidence only */ }
  };
  write();
  const entry = (level: Level, outcome: Outcome, message: string, err?: unknown) => {
    const d = err === undefined ? undefined : errorDetail(err);
    return appendEntry(boardDir, { level, action, outcome, stage, card, ...m, durationMs: Date.now() - startedAt, message,
      ...(d?.exitCode !== undefined ? { exitCode: d.exitCode } : {}), ...(d?.stderr ? { stderr: d.stderr } : {}) });
  };
  const log: RunLog = {
    startedAt,
    stage(name) { stage = name; write(); },
    set(meta) { m = { ...m, ...meta }; write(); },
    failed(err, opts = {}) {
      const outcome = opts.outcome ?? outcomeOf(err, stage);
      const e = entry(opts.level ?? (outcome === "cancelled" ? "info" : outcome === "interrupted" ? "warn" : "error"), outcome, opts.message ?? errorDetail(err).message, err);
      log.end();
      if (err && typeof err === "object") try { Object.defineProperty(err, "logged", { value: true, configurable: true }); } catch { /* frozen */ }
      return e;
    },
    note: (level, outcome, message, err) => entry(level, outcome, message, err),
    end() { if (ended) return; ended = true; try { fs.rmSync(file, { force: true }); } catch { /* left for the next activation */ } },
  };
  return log;
}

/** The error was logged already (RunLog.failed marks it), so an outer catch does not log it again. */
export const wasLogged = (err: unknown) => !!(err && typeof err === "object" && (err as { logged?: boolean }).logged);

const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
/**
 * At activation: each run record whose extension host is gone (a reload, a crash, VS Code closed) is logged as interrupted at the
 * stage it had reached, then removed. A record of a live host (another window's run) is left alone.
 */
export function logInterrupted(boardDir: string, alive: (pid: number) => boolean = pidAlive): LogEntry[] {
  const dir = runsDir(boardDir), logged: LogEntry[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return logged; }
  for (const name of names) {
    const file = path.join(dir, name);
    let r: RunRecord;
    try { r = JSON.parse(fs.readFileSync(file, "utf8")); } catch { try { fs.rmSync(file, { force: true }); } catch { /* */ } continue; }
    if (typeof r.pid === "number" && r.pid !== process.pid && alive(r.pid)) continue;
    if (r.pid === process.pid) continue; // this window's own run
    const started = Date.parse(r.startedAt);
    logged.push(appendEntry(boardDir, { level: "warn", action: r.action === "finish" ? "finish" : "review", outcome: "interrupted", stage: r.stage, card: r.card ?? { id: "", title: "" },
      provider: r.provider, account: r.account, model: r.model, effort: r.effort, permission: r.permission, receipt: r.receipt, file: r.file,
      ...(Number.isFinite(started) ? { durationMs: Date.now() - started } : {}),
      message: `The ${r.action === "finish" ? "Finish" : "review"} was cut off when its window reloaded or closed (extension host ${r.pid} is gone).` }));
    try { fs.rmSync(file, { force: true }); } catch { /* */ }
  }
  return logged;
}
