// Finds Claude Code sessions already running in a repo, whoever started them (terminal or Claude Code panel).
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { Account, Status } from "./board";

export interface LiveSession {
  pid: number;
  /** Linux start ticks of a discovered Codex rollout writer, checked again before Stop. */
  processStart?: string;
  sessionId: string;
  cwd: string;
  status?: string;
  configDir: string;
  account?: string;
  name?: string;
  /** Who named the session, from its session file: "user" for a rename, "auto" for the CLI's generated name. */
  nameSource?: string;
  /** A Codex TUI found through /proc (codex.ts); unset = Claude. */
  provider?: "codex";
  /** The card status a Codex session's rollout shows (statusOf uses it instead of `status`). */
  cardStatus?: Status;
  /** A Codex session's rollout file. */
  transcript?: string;
  /** The name other Claude sessions use to message this one (the CLI's own name, placeholder included). */
  address?: string;
  /** When the CLI last wrote `status` (ms). */
  statusUpdatedAt?: number;
  /** When the CLI's process started, as its session file records it (see processStart). With the pid it names one process. */
  procStart?: string;
}

export const DEFAULT_DIR = path.join(os.homedir(), ".claude");

const norm = (p: string) => process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
/** Two account folders are the same under host path semantics, "" meaning ~/.claude. */
export const sameFolder = (a: string, b: string) => norm(a || DEFAULT_DIR) === norm(b || DEFAULT_DIR);

export const ACCOUNTS_ROOT = path.join(os.homedir(), ".claude-accounts");

/** One config folder and what the CLI says about its login. configDir "" is ~/.claude. */
export interface AccountStatus {
  configDir: string;
  loggedIn: boolean;
  email?: string;
  plan?: string;
}

let found: Account[] = [];
let statuses: AccountStatus[] = [];
/** Logged-in accounts from the last discoverAccounts() run. */
export const foundAccounts = () => found;
/** Every account folder from the last run, logged in or not. */
export const accountStatuses = () => statuses;

/** Use the folder's credentials even if the editor inherited a different CLI login. */
export function claudeAccountEnv(configDir: string): Record<string, string | null> {
  const keys = ["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];
  const cleared = Object.fromEntries([...keys, ...Object.keys(process.env).filter(key => keys.includes(key.toUpperCase()))].map(key => [key, null]));
  return { ...cleared, CLAUDE_CONFIG_DIR: configDir || null };
}

/** Only the current CLI response can confirm an attempted login. */
export async function freshAuthStatus(configDir: string): Promise<AccountStatus | undefined> {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(claudeAccountEnv(configDir))) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  let stdout = "";
  let success = true;
  try {
    stdout = (await promisify(execFile)("claude", ["auth", "status"], { cwd: os.homedir(), env, timeout: 30_000, windowsHide: true })).stdout;
  } catch (e) {
    const error = e as { code?: number; stdout?: string };
    if (error.code !== 1) return undefined;
    success = false; // logged out exits 1 but still prints its JSON
    stdout = error.stdout ?? "";
  }
  try {
    const s = JSON.parse(stdout);
    if (typeof s?.loggedIn !== "boolean" || (s.loggedIn && !success)) return undefined;
    // Emails are compared case-insensitively everywhere, so they are kept in lower case.
    let plan = s.subscriptionType;
    if (plan === "max" && (s.planTier === "max_5x" || s.planTier === "max_20x")) plan = `${s.planTier} (CLI tier)`;
    const status = { configDir, loggedIn: s.loggedIn, email: typeof s.email === "string" ? s.email.trim().toLowerCase() : undefined, plan };
    lastStatus().set(configDir, status);
    saveStatuses();
    return status;
  } catch {
    return undefined;
  }
}

/** A slow or unavailable CLI does not erase the last account seen by discovery. */
export async function authStatus(configDir: string): Promise<AccountStatus> {
  return await freshAuthStatus(configDir) ?? lastStatus().get(configDir) ?? { configDir, loggedIn: false };
}
// Kept on disk too: the first checks after a restart are the slowest (a cold CLI, antivirus), and one that failed then had no earlier
// answer, so the account vanished and its cards could not start ("Account … is not available") until the 15-minute poll.
export const authStatusFile = () => path.join(USAGE_DIR, "auth-status.json");
let statusCache: Map<string, AccountStatus> | undefined;
const lastStatus = () => {
  if (!statusCache) {
    statusCache = new Map();
    try { for (const s of JSON.parse(fs.readFileSync(authStatusFile(), "utf8")) as AccountStatus[]) if (typeof s?.configDir === "string") statusCache.set(s.configDir, s); } catch { /* none saved yet */ }
  }
  return statusCache;
};
const saveStatuses = () => {
  try { fs.mkdirSync(USAGE_DIR, { recursive: true }); writeFileAtomic(authStatusFile(), JSON.stringify([...lastStatus().values()])); } catch { /* the next check saves it */ }
};
/** After a sign-out or removal the folder's old login must not stand in for a check that fails (a new login in the same folder). */
export const forgetAuthStatus = (configDir: string) => { if (lastStatus().delete(configDir)) saveStatuses(); };

/** ~/.claude plus every folder in ~/.claude-accounts. */
export function accountFolders(): string[] {
  try {
    // "<folder>.lock" is the CLI's lock while it refreshes a login, not an account; running the CLI in it leaves it behind.
    return ["", ...fs.readdirSync(ACCOUNTS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.endsWith(".lock")).map((d) => path.join(ACCOUNTS_ROOT, d.name))];
  } catch {
    return [""]; // no ~/.claude-accounts yet
  }
}

/**
 * The email a folder belongs to (the user, 13 November 2026: "accounts need to stay in their own folders"): the one saved for it when
 * it was logged in through Entomatical, else its own name when that is an email (~/.claude-accounts/personal@example.com).
 */
export function meantFor(configDir: string, saved: Record<string, string>): string | undefined {
  const hit = Object.entries(saved).find(([dir]) => sameFolder(dir, configDir))?.[1];
  const name = configDir ? path.basename(configDir) : "";
  return (hit ?? (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(name) ? name : undefined))?.toLowerCase();
}

/**
 * Asks the CLI which email ~/.claude and each folder in ~/.claude-accounts is logged into. A folder signed in as another email than
 * the one it belongs to (`saved`, see meantFor) is left out: no card, new task or helper call runs in it until it is logged in again.
 */
export async function discoverAccounts(oneAtATime = false, saved: Record<string, string> = {}): Promise<Account[]> {
  const asked: AccountStatus[] = [];
  if (oneAtATime) for (const dir of accountFolders()) asked.push(await authStatus(dir));
  statuses = oneAtATime ? asked : await Promise.all(accountFolders().map(authStatus));
  return (found = usableAccounts(statuses, saved));
}

/** The folders cards may run in: signed in, and as the email they belong to. */
export function usableAccounts(all: AccountStatus[], saved: Record<string, string>): Account[] {
  const own = (s: AccountStatus) => { const want = meantFor(s.configDir, saved); return !want || want === s.email; };
  // Two folders logged into the same email get their folder in the name, so the picker can tell them apart.
  const list: Account[] = all.filter((s) => s.loggedIn && s.email && own(s)).map((s) => ({ name: s.email!, configDir: s.configDir }));
  const dupes = new Set(list.map((a) => a.name).filter((n, i, names) => names.indexOf(n) !== i));
  return list.map((a) => (dupes.has(a.name) ? { ...a, name: `${a.name} (${a.configDir ? path.basename(a.configDir!) : "~/.claude"})` } : a));
}

/** The other signed-in Claude account folders ("" = ~/.claude), in account order: where a helper call goes when this one hits a usage limit. */
export const otherAccountDirs = (configDir: string, all: Account[] = found) =>
  all.map((a) => a.configDir ?? "").filter((d, i, dirs) => !sameFolder(d, configDir) && dirs.findIndex((e) => sameFolder(e, d)) === i);

export const inside = (root: string, p: string) => {
  const rel = path.relative(root, p);
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
};

/**
 * A session belongs to a repo's board when it runs in the repo, but inside .entomatical only in the board's own
 * worktrees (.entomatical\wt). Anything else there, such as a test repo, is another project.
 */
export const inRepo = (repo: string, cwd: string) => {
  const board = path.join(repo, ".entomatical");
  return inside(repo, cwd) && (!inside(board, cwd) || inside(path.join(board, "wt"), cwd));
};

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Adapted from vishalguptax/claude-code-manager src/core/atomicWrite.ts (commit 0e2d85f3,
// Apache-2.0). Modified: trimmed to the write-temp-then-rename core.
// Also retries the rename a few times: antivirus on Windows briefly locks files (EPERM/EBUSY).
export function writeFileAtomic(filePath: string, data: string, durable = false): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    if (durable) { const fd = fs.openSync(tmp, "w"); try { writeWhole(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    else fs.writeFileSync(tmp, data);
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(tmp, filePath);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY")) throw err;
        const until = Date.now() + 50 * attempt;
        while (Date.now() < until); // ponytail: brief busy-wait keeps writes synchronous; at most 300 ms in total
      }
    }
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** writeFileAtomic plus fsync of the file and (not on Windows, which cannot open a folder) its folder: the record survives a power cut. */
export function writeFileDurable(filePath: string, data: string): void {
  writeFileAtomic(filePath, data, true);
  fsyncDir(path.dirname(filePath));
}
/** Appends one line and fsyncs it (journals). */
export function appendDurable(filePath: string, line: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, "a");
  try { writeWhole(fd, line.endsWith("\n") ? line : line + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
/** fs.writeSync reports a short write (a full disk) only by its count: that is an error here, never a silently torn record. */
function writeWhole(fd: number, data: string) {
  if (fs.writeSync(fd, data) !== Buffer.byteLength(data)) throw new Error("Short write: the disk may be full");
}
function fsyncDir(dir: string) {
  if (process.platform === "win32") return;
  try { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* best effort */ }
}

// ---- Phase 4 (master plan section 11, "External-effect recovery"): durable operation records ----
// One file per operation under .entomatical/operations/<id>.json, written durably before and after its effect. Intent is persisted
// (prepared) before the effect; the observed outcome (effect-observed) before the board's own bookkeeping; committed after it.
// uncertain: the board cannot tell whether the effect happened; nothing replays it until the user or reconciliation settles it.
// abandoned: the effect is known not to have happened (a refusal or reconciliation that found the refs unchanged).
export type OpState = "prepared" | "effect-observed" | "committed" | "uncertain" | "abandoned";
export interface Operation {
  id: string; kind: "integrate" | "target"; card: string; run: string; actor: string;
  /** The board instance that carries it out; another owner leaves a young record alone (it may still be in flight). */
  owner?: string;
  /** the user's explicit authorization for a target effect: when, whether push was granted, and what he acknowledged. */
  authorization?: { by: "user"; at: string; merge: true; push: boolean; acks?: string[] };
  /** What had to hold just before the effect: exact revisions and refs (candidate, target sha, destination head, submitted head). */
  pre: Record<string, string | boolean | undefined>;
  state: OpState; at: string; updated: string;
  /** Result facts: refs after, conflict files, the reason it was abandoned or uncertain. */
  result?: Record<string, unknown>;
  /** The effect succeeded but removing worktrees or branches did not: only cleanup is retried, never the merge or push. */
  cleanup?: "pending" | "done";
  /** Who settled it: the user acknowledging an uncertain one, or reconciliation finding the refs unchanged. */
  settled?: { by: "user" | "reconcile"; at: string };
}
export const OPEN_OPS: OpState[] = ["prepared", "effect-observed", "uncertain"];
export class Operations {
  constructor(private dir: string) {}
  private file(id: string) { return path.join(this.dir, `${id}.json`); }
  list(): Operation[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir).filter((n) => n.endsWith(".json")); } catch { return []; }
    const out: Operation[] = [];
    for (const n of names) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(this.dir, n), "utf8"))); }
      // A damaged record is never read as "no operation": it becomes an uncertain one, kept beside the damaged bytes.
      catch { out.push({ id: n.slice(0, -5), kind: "target", card: "?", run: "?", actor: "?", pre: {}, state: "uncertain", at: "", updated: "", result: { damaged: path.join(this.dir, n) } }); }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }
  get(id: string): Operation | undefined { return this.list().find((o) => o.id === id); }
  open(o: Omit<Operation, "id" | "state" | "at" | "updated">): Operation {
    const at = new Date().toISOString();
    const op: Operation = { ...o, id: `${o.kind}-${o.card}-${Date.parse(at).toString(36)}-${Math.random().toString(36).slice(2, 6)}`, state: "prepared", at, updated: at };
    fs.mkdirSync(this.dir, { recursive: true });
    writeFileDurable(this.file(op.id), JSON.stringify(op, null, 1));
    return op;
  }
  set(op: Operation, patch: Partial<Operation>): Operation {
    Object.assign(op, patch, { updated: new Date().toISOString() });
    writeFileDurable(this.file(op.id), JSON.stringify(op, null, 1));
    return op;
  }
}

// ---- Phase 4: durable request journal (inbox) ----
// inbox/done keeps only the newest 200 answers, so a nonce seen before must be remembered elsewhere for as long as a replay could come.
// Each request is journaled "started" (with a hash of its body) before it is handled, and "answered" after; the answer itself is kept
// only when writing it failed, so the next pass answers from the journal instead of handling the request again.
export const REQUEST_HORIZON_MS = 30 * 24 * 3600_000;
export interface RequestEntry { nonce: string; hash: string; state: "started" | "answered"; at: number; answer?: Record<string, unknown> }
export class RequestJournal {
  private entries?: Map<string, RequestEntry>;
  private seenStat = "";
  /** The file ends in a torn line: the next entry starts on a new line, or it would be lost with the torn bytes. */
  private torn = false;
  constructor(private file: string, private horizonMs = REQUEST_HORIZON_MS) {}
  /** Read again whenever the file changed since this window last read or wrote it: another owner window may have journaled requests. */
  private load(): Map<string, RequestEntry> {
    const st = fs.statSync(this.file, { throwIfNoEntry: false }), stat = st ? `${st.size}:${st.mtimeMs}` : "";
    if (this.entries && stat === this.seenStat) return this.entries;
    this.seenStat = stat;
    const m = new Map<string, RequestEntry>();
    let text = "";
    try { text = fs.readFileSync(this.file, "utf8"); } catch { /* none yet */ }
    this.torn = text !== "" && !text.endsWith("\n");
    for (const line of text.split("\n")) { if (!line) continue; try { const e = JSON.parse(line) as RequestEntry; m.set(e.nonce, { ...m.get(e.nonce), ...e }); } catch { /* a torn last line */ } }
    return (this.entries = m);
  }
  get(nonce: string): RequestEntry | undefined { return this.load().get(nonce); }
  /** Shown to get() only once it is on disk (RT-12). A failed append may have left part or all of the line, so the next read decides from the file. */
  record(e: RequestEntry) {
    const m = this.load();
    try { appendDurable(this.file, (this.torn ? "\n" : "") + JSON.stringify(e)); } catch (err) { this.entries = undefined; throw err; }
    m.set(e.nonce, e);
    this.torn = false;
    const st = fs.statSync(this.file, { throwIfNoEntry: false });
    this.seenStat = st ? `${st.size}:${st.mtimeMs}` : "";
  }
  private compacted = 0;
  /**
   * Drops entries older than the horizon once the file passes 1 MB and has doubled since the last compaction (so a busy month of
   * requests is not rewritten on every pass). Requests older than the horizon are refused, never replayed.
   */
  compact(now = Date.now()) {
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size < Math.max(1_000_000, 2 * this.compacted)) return;
    const keep = [...this.load().values()].filter((e) => now - e.at < this.horizonMs);
    const text = keep.map((e) => JSON.stringify(e)).join("\n") + (keep.length ? "\n" : "");
    writeFileDurable(this.file, text); // a failure leaves the old file and the cache that matches it
    this.entries = new Map(keep.map((e) => [e.nonce, e]));
    this.torn = false;
    this.compacted = Buffer.byteLength(text);
    const st = fs.statSync(this.file, { throwIfNoEntry: false });
    this.seenStat = st ? `${st.size}:${st.mtimeMs}` : "";
  }
  get horizon() { return this.horizonMs; }
}

/**
 * Owner lock for a repo's board. The owner rewrites the file with a timestamp on every tick; a claimant defers
 * only to an owner whose heartbeat is fresh and whose pid is alive. A pid alone is not trusted: Windows reuses
 * pids, and a closed window's pid came back as an unrelated process and locked the board.
 * The rewrite is a rename, never a truncate, and a failed read is tried once more a few ms later. Otherwise a
 * claimant that polls just as the owner renews finds the file empty or locked, reads that as "no owner" and takes the board.
 */
/**
 * takeover: only a window's own tick may take the board from a stale or dead owner, since only the tick reloads the old owner's last
 * save first; any other call (a hook-driven update, a click) refuses until then. A takeover rereads the file 10 ms after writing
 * it and holds only if it still names this window: two windows taking over at once would both think they won.
 */
export function claimOwner(file: string, pid = process.pid, now = Date.now(), staleMs = 15_000, isAlive: (pid: number) => boolean = alive, takeover = false): boolean {
  const read = (): { pid?: unknown; at?: unknown } | undefined => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return undefined; // no owner yet, or unreadable
    }
  };
  let o = read();
  if (!o) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); // 10 ms, blocking, only after a failed read: the owner may be replacing the file right now
    o = read() ?? {}; // still unreadable: claim it
  }
  if (o.pid === pid) {
    writeFileAtomic(file, JSON.stringify({ pid, at: now }));
    return true;
  }
  const fresh = typeof o.at === "number" && now - o.at < staleMs;
  if (!takeover || (fresh && typeof o.pid === "number" && isAlive(o.pid))) return false;
  writeFileAtomic(file, JSON.stringify({ pid, at: now }));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  return read()?.pid === pid;
}

// The CLI keeps <config dir>/sessions/<pid>.json while it runs: pid, sessionId, cwd, name, status (busy | idle).
// Undocumented; seen in CLI 2.1.299 and 2.1.300. Read only.
// A crashed session's file whose pid got reused would read as alive. On Linux the CLI writes procStart, its process's start time
// (/proc/<pid>/stat field 22: equal for a live CLI 2.1.318 session, checked 4 Nov 2026), so a different process with that pid is ignored.
// On Windows the start time is not compared here: reading it starts a process, and this runs on every scan (the board ignores the
// sessions its own Stop ended, board.ts scan). Where a reused pid would cost work, Finish compares it (ownerState below, M-02).
const sameProcess = (s: { pid: number; procStart?: unknown }) => {
  // Only the form checked (clock ticks since boot): a CLI that wrote it another way must not make every live session look gone.
  if (process.platform !== "linux" || typeof s.procStart !== "string" || !/^\d+$/.test(s.procStart)) return true;
  try {
    const stat = fs.readFileSync(`/proc/${s.pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === s.procStart; // fields after "(comm)" start at field 3
  } catch { return true; } // unreadable: alive() already said it runs
};

// ---- M-02: one process by its pid and when it started ----
// A pid alone names whichever process holds it now: Windows gave a stopped helper's pid to an unrelated process within the same
// recovery (12 November 2026, card d99db8). The CLI's session file records when its process started (procStart), in the form the OS
// reports it: Linux, clock ticks since boot (/proc/<pid>/stat field 22, checked 4 November 2026, CLI 2.1.318); Windows, the process's
// creation time as a FILETIME (equal to Get-Process's StartTime.ToFileTimeUtc() for 3 of 3 live sessions, 19 November 2026, CLI 2.1.328).

/**
 * A process the board recorded as one card's own: its pid, when it started (when the record says), and what it is, in words.
 * read: `started` is this OS's own reading (processStart), not what a session file said, so it compares with a later reading
 * whatever form the CLI writes.
 */
export interface OwnedProcess { pid: number; started?: string; what: string; read?: boolean }

/**
 * Two start times name the same start. On Windows to the microsecond: the second reading below (CIM) has no finer digit. For 5 of 5
 * live sessions on 19 November 2026 (CLI 2.1.328, powershell.exe 5.1) Get-Process gave procStart itself and CIM gave procStart with
 * its last digit as 0.
 */
export const sameStart = (a: string, b: string, platform: NodeJS.Platform = process.platform) =>
  platform === "win32" && a.length > 1 && b.length > 1 ? a.slice(0, -1) === b.slice(0, -1) : a === b;

/** When a live process started, in procStart's form; undefined when it is gone, cannot be read, or this OS has no reading. */
export async function processStart(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || undefined;
    } catch { return undefined; }
  }
  if (process.platform !== "win32") return undefined;
  try {
    // The pid is a checked integer, and nothing else is put in the command. Get-Process is refused the start time of a process that
    // runs elevated or as another user ("Access is denied"); CIM reads it for those too, to the microsecond (sameStart).
    const ps = `$ErrorActionPreference = 'Stop'; try { (Get-Process -Id ${pid}).StartTime.ToFileTimeUtc() } catch { $p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p -and $p.CreationDate) { $p.CreationDate.ToFileTimeUtc() } }`;
    const out = (await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 15_000, windowsHide: true })).stdout.trim();
    return /^\d+$/.test(out) ? out : undefined;
  } catch { return undefined; }
}

/**
 * Whether a recorded process has ended. Gone: "exited". There with the recorded start: "running". There, started at another time
 * than recorded: "replaced". The pid is another process's now, provided the two times are in the same form; the caller decides
 * that (a session file's form is the CLI's own and undocumented). There, with no start recorded or none readable: "unknown", which
 * is never taken for an exit.
 */
export async function ownerState(p: OwnedProcess, isAlive: (pid: number) => boolean = alive, startOf: (pid: number) => Promise<string | undefined> = processStart): Promise<"exited" | "replaced" | "running" | "unknown"> {
  if (!isAlive(p.pid)) return "exited";
  if (!p.started) return "unknown";
  const now = await startOf(p.pid);
  if (now === undefined) return isAlive(p.pid) ? "unknown" : "exited"; // it ended between the two looks, or cannot be read
  return sameStart(now, p.started) ? "running" : "replaced";
}

export function liveSessions(repo: string): LiveSession[] {
  return accountFolders().flatMap((configDir) => {
    const dir = configDir || DEFAULT_DIR;
    const account = found.find((a) => a.configDir === configDir)?.name; // unknown until discoverAccounts finishes
    let files: string[];
    try {
      files = fs.readdirSync(path.join(dir, "sessions")).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    return files.flatMap((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, "sessions", f), "utf8"));
        const ok = typeof s.pid === "number" && typeof s.sessionId === "string" && typeof s.cwd === "string";
        return ok && inRepo(repo, s.cwd) && alive(s.pid) && sameProcess(s)
          ? [{ pid: s.pid, sessionId: s.sessionId, cwd: s.cwd, status: s.status, configDir: dir, account, name: sessionName(s), address: typeof s.name === "string" && s.name ? s.name : undefined,
            ...(typeof s.nameSource === "string" ? { nameSource: s.nameSource } : {}),
            ...(typeof s.statusUpdatedAt === "number" ? { statusUpdatedAt: s.statusUpdatedAt } : {}),
            ...(typeof s.procStart === "string" && /^\d+$/.test(s.procStart) ? { procStart: s.procStart } : {}) }]
          : [];
      } catch {
        return []; // mid-write or not ours
      }
    });
  });
}

/** A session file's name, unless it is the CLI's placeholder (nameSource "derived": folder name plus two hex digits, e.g. "c40724-15"). */
export const sessionName = (s: { name?: unknown; nameSource?: unknown }) => (typeof s.name === "string" && s.nameSource !== "derived" ? s.name : undefined);

// Seen values: busy, idle, or no status at all. CLI 2.1.312 also writes "waiting" (with waitingFor) while a dialog such as a permission
// prompt waits on the user; an older CLI may not, and its wait still reads as review.
export const statusOf = (s: LiveSession): Status => s.cardStatus ?? (s.status === "busy" ? "running" : s.status === "waiting" ? "needs-input" : "review");

export const transcriptPath = (configDir: string, cwd: string, sessionId: string) =>
  path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);

/** Where one Claude session's files sit: its transcripts (<id>.jsonl) and its session folders (<id>, which hold subagents/). */
export interface SessionPlaces { transcripts: string[]; folders: string[] }

/** Rebuilt at most this often (ms), or sooner when a caller's file has gone, but then at most every SESSION_INDEX_FORCED_MS. */
export const SESSION_INDEX_MS = 60_000;
const SESSION_INDEX_FORCED_MS = 5_000;
let sessionIndex: { at: number; dirs: string; places: Map<string, SessionPlaces> } | undefined;
let sessionListings = 0;

/**
 * Every Claude session's files under <config folder>/projects/<any project folder>, for each config folder given. A resumed session
 * can sit under another account and another project folder than its card computes: card 19d7e9 (9 November 2026) ran in a worktree that
 * was merged and deleted, then was resumed from the main checkout under another account, whose cwd had a lower-case drive letter
 * ("c--..." beside "C--..."), so its subagents were only there. One listing serves every card; `generation` changes when it is redone.
 */
export function sessionPlaces(configDirs: string[], sessionId: string, force = false, now = Date.now()): SessionPlaces & { generation: number } {
  const dirs = configDirs.map((d) => path.resolve(d || DEFAULT_DIR)).filter((d, i, all) => all.findIndex((e) => norm(e) === norm(d)) === i);
  const key = dirs.join("\n");
  const age = sessionIndex ? now - sessionIndex.at : Infinity;
  if (!sessionIndex || sessionIndex.dirs !== key || age >= SESSION_INDEX_MS || (force && age >= SESSION_INDEX_FORCED_MS)) {
    const places = new Map<string, SessionPlaces>();
    const place = (id: string) => places.get(id) ?? (places.set(id, { transcripts: [], folders: [] }), places.get(id)!);
    for (const dir of dirs) {
      const projects = path.join(dir, "projects");
      let folders: fs.Dirent[];
      try { folders = fs.readdirSync(projects, { withFileTypes: true }); } catch { continue; }
      for (const folder of folders) {
        if (!folder.isDirectory()) continue;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(path.join(projects, folder.name), { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const file = path.join(projects, folder.name, e.name);
          if (e.isFile() && e.name.endsWith(".jsonl")) place(e.name.slice(0, -6)).transcripts.push(file);
          else if (e.isDirectory()) place(e.name).folders.push(file);
        }
      }
    }
    sessionIndex = { at: now, dirs: key, places };
    sessionListings++;
  }
  const found = sessionIndex.places.get(sessionId);
  return { transcripts: found?.transcripts ?? [], folders: found?.folders ?? [], generation: sessionListings };
}
/** Drops the listing, so the next sessionPlaces call lists again. Tests use it. */
export const forgetSessionPlaces = () => void (sessionIndex = undefined);

/**
 * The Claude Code panel lists past sessions from its workspace's own project folder only (includeWorktrees: false,
 * extension 2.1.308), so a session run in a task worktree never shows in its history. Hard-link the transcript into
 * the repo's project folder of each config folder: the same append-only file under a second name, never a copy.
 * A config folder on another filesystem or drive (EXDEV) cannot hold a hard link, and a copy would go stale as the
 * session appends, so that folder is skipped: once, quietly, and never retried. Returns the links made.
 */
export function linkIntoHistory(transcript: string, configDirs: string[], repo: string, sessionId: string): string[] {
  if (!fs.existsSync(transcript)) return [];
  const made: string[] = [];
  const dirs = configDirs.filter((d, i) => configDirs.findIndex((e) => norm(e) === norm(d)) === i);
  for (const dir of dirs) {
    const seen = transcriptPath(dir, repo, sessionId);
    const pair = `${norm(transcript)}\n${norm(seen)}`;
    if (norm(seen) === norm(transcript) || crossDevice.has(pair) || fs.existsSync(seen)) continue;
    const created = fs.mkdirSync(path.dirname(seen), { recursive: true });
    try {
      fs.linkSync(transcript, seen);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      crossDevice.add(pair);
      if (created) fs.rmSync(created, { recursive: true, force: true }); // only the empty folders made just now
      continue;
    }
    made.push(seen);
  }
  return made;
}
/** Transcript and history paths that sit on different filesystems: linkIntoHistory does not try them again. */
const crossDevice = new Set<string>();

/**
 * Makes a saved conversation resumable from another account folder: `claude --resume` looks for the transcript under its own
 * CLAUDE_CONFIG_DIR. Links the transcript and the files of its session folder (subagent transcripts) to `dest`, falling back to a
 * copy where a hard link is refused (another drive). A conversation is not a login; no credential file is touched.
 * Returns the files made.
 */
export function carryTranscript(transcript: string, dest: string): string[] {
  if (!fs.existsSync(transcript) || norm(transcript) === norm(dest)) return [];
  const made: string[] = [];
  const place = (from: string, to: string) => {
    if (fs.existsSync(to)) {
      // The same file (a hard link) is as long as its source. A shorter one is a copy an earlier move left (another drive): resuming it
      // would drop everything said since, so it is set aside and placed again.
      if (fs.statSync(to).size >= fs.statSync(from).size) return;
      fs.renameSync(to, `${to}.${Date.now()}.stale`);
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
    made.push(to);
  };
  place(transcript, dest);
  const folder = transcript.replace(/\.jsonl$/, ""), destFolder = dest.replace(/\.jsonl$/, "");
  const walk = (dir: string) => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const from = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(from);
      else if (entry.isFile()) place(from, path.join(destFolder, path.relative(folder, from)));
    }
  };
  if (folder !== transcript) walk(folder);
  return made;
}

/** One prompt the user sent and, once the turn answered it, the assistant's final text (first 600 characters). */
export interface Exchange { text: string; reply?: string; replyStatus?: "partial" }
export const REPLY_CAP = 600;

const cache = new Map<string, { key: string; identity: string; offset: number; anchor: Buffer; exchanges: Exchange[]; times: number[]; view: { exchanges: Exchange[]; times: number[] } }>();

const titleCache = new Map<string, { size: number; mtime: number; offset: number; custom?: string; generated?: string }>();

/** Follow Claude's title records, including stopped sessions. Later scans read only appended bytes.
 * customOnly: only a rename (custom-title), never Claude's generated ai-title. */
export function sessionTitle(file: string, opts: { customOnly?: boolean } = {}): string | undefined {
  const pick = (hit?: { custom?: string; generated?: string }) => hit?.custom || (opts.customOnly ? undefined : hit?.generated);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const st = fs.fstatSync(fd);
    let hit = titleCache.get(file);
    if (hit?.size === st.size && hit.mtime === st.mtimeMs) return pick(hit);
    if (!hit || st.size <= hit.size) hit = { size: 0, mtime: 0, offset: 0 };
    let position = hit.offset;
    let pending = Buffer.alloc(0);
    const chunk = Buffer.alloc(64 * 1024);
    while (position < st.size) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, st.size - position), position);
      if (!count) break;
      position += count;
      pending = Buffer.concat([pending, chunk.subarray(0, count)]);
      let start = 0;
      for (let end = pending.indexOf(10); end >= 0; end = pending.indexOf(10, start)) {
        const line = pending.subarray(start, end).toString("utf8");
        start = end + 1;
        if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "custom-title" && typeof entry.customTitle === "string" && entry.customTitle.trim()) hit.custom = entry.customTitle.trim();
          if (entry.type === "ai-title" && typeof entry.aiTitle === "string" && entry.aiTitle.trim()) hit.generated = entry.aiTitle.trim();
        } catch { /* Preserve the last valid title. */ }
      }
      pending = Buffer.from(pending.subarray(start));
    }
    hit.offset = position - pending.length;
    hit.size = st.size;
    hit.mtime = st.mtimeMs;
    titleCache.set(file, hit);
    return pick(hit);
  } catch {
    return pick(titleCache.get(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export interface Subagent {
  id: string;
  type: string;
  description: string;
  /** Finished: its last message was a final answer. Otherwise it is working, or died with its parent. */
  done: boolean;
  /** Tool calls so far. */
  steps: number;
  /** What it is doing right now: the last tool call or line of text. */
  doing: string;
  /** False when no transcript was read, so `steps` is not a count. Unset means the count is real. */
  known?: boolean;
  updated: number;
  model?: string;
  effort?: string;
  parentId?: string;
  lifecycle?: "hook" | "transcript";
}

/** Most bytes of one subagent transcript read per pass. */
export const MAX_SUBAGENT_READ = 8 * 1024 * 1024;

const agentCache = new Map<string, { key: string; agent: Subagent; offset: number; identity: string; toolIds: Set<string> }>();

/** One line describing a tool call, e.g. "Read src/board.ts". */
function toolLine(name: string, input: Record<string, unknown>): string {
  const arg = input.file_path ?? input.pattern ?? input.command ?? input.description ?? input.prompt ?? input.query ?? input.url ?? "";
  return `${name} ${String(arg).split("\n")[0]}`.trim().slice(0, 120);
}

/** One subagent transcript (`agent-<id>.jsonl`). Missing file returns undefined. */
export function readSubagent(file: string): Subagent | undefined {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return undefined; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = agentCache.get(file);
  if (hit?.key === key) return hit.agent;
  let meta: Record<string, string> = {};
  try {
    meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8"));
  } catch {
    // older layout without a meta file
  }
  const identity = `${st.dev}:${st.ino}`;
  const previous = hit && hit.identity === identity && st.size >= hit.offset && st.size !== hit.offset ? hit : undefined;
  let offset = previous?.offset ?? 0;
  const toolIds = previous?.toolIds ?? new Set<string>();
  let steps = previous?.agent.steps ?? 0;
  let doing = previous?.agent.doing ?? "starting";
  let done = previous?.agent.done ?? false;
  let model = previous?.agent.model;
  // A subagent transcript can pass 512 MB, more than one string can hold. Read at most the last
  // MAX_SUBAGENT_READ bytes; steps then count only the tail that was read.
  const start = Math.max(offset, st.size - MAX_SUBAGENT_READ);
  let fd: number;
  try { fd = fs.openSync(file, "r"); } catch { return undefined; } // deleted since the stat
  const buffer = Buffer.alloc(st.size - start);
  try { fs.readSync(fd, buffer, 0, buffer.length, start); } finally { fs.closeSync(fd); }
  const first = start > offset ? buffer.indexOf(10) + 1 : 0;
  const end = buffer.lastIndexOf(10);
  const complete = end < first ? "" : buffer.subarray(first, end).toString("utf8");
  if (end >= 0) offset = start + end + 1;
  for (const line of complete.split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
      if (typeof e.message.model === "string") model = e.message.model;
      for (const part of e.message.content) {
        if (part.type === "tool_use") {
          if (!part.id || !toolIds.has(part.id)) steps++;
          if (part.id) toolIds.add(part.id);
          doing = toolLine(part.name, part.input ?? {});
        } else if (part.type === "text" && part.text?.trim()) doing = part.text.trim().split("\n")[0].slice(0, 120);
      }
      done = e.message.stop_reason === "end_turn";
    } catch {
      // partial line still being written
    }
  }
  const agent: Subagent = { id: path.basename(file).slice(6, -6), type: meta.agentType ?? "agent", description: meta.description ?? "", done, steps, doing, updated: st.mtimeMs, model, parentId: meta.parentAgentId, lifecycle: "transcript" };
  agentCache.set(file, { key, agent, offset, identity, toolIds });
  return agent;
}

/**
 * The subagents a session spawned, from <transcript folder>\<session id>\subagents\agent-*.jsonl and their
 * .meta.json. Same CLI layout caveat as the transcripts themselves.
 */
export function subagents(transcript: string): Subagent[] {
  const dir = path.join(transcript.replace(/\.jsonl$/, ""), "subagents");
  let files: string[];
  try {
    files = [];
    const visit = (root: string) => {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.isSymbolicLink()) continue;
        const file = path.join(root, e.name);
        if (e.isDirectory()) visit(file);
        else if (e.name.startsWith("agent-") && e.name.endsWith(".jsonl")) files.push(path.relative(dir, file));
      }
    };
    visit(dir);
  } catch {
    return [];
  }
  return files.flatMap((f) => {
    const agent = readSubagent(path.join(dir, f));
    return agent ? [agent] : [];
  });
}

/** Text Claude writes into the user's side of a transcript, not typed by the user. */
export const notTyped = (text: string) => /^\s*(?:\[Request interrupted\b|<(?:task-notification|system-reminder|teammate-message|cross-session-message|agent-message|browser_instruction|ide_opened_file|ide_selection|local-command-(?:caveat|stdout|stderr)|command-(?:name|message|args)|bash-(?:input|stdout|stderr))(?=[\s>]))/.test(text);

/** An idle process can still be running tools. Only a transcript's explicit interruption note proves an interrupted turn. */
export function transcriptInterrupted(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - 64 * 1024);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start) lines.shift();
    for (const line of lines.reverse()) {
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== "user" && e.type !== "assistant") continue;
      const content = e.message?.content;
      const text = typeof content === "string" ? content : Array.isArray(content)
        ? content.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n") : "";
      return e.type === "user" && text.startsWith("[Request interrupted");
    }
  } catch { /* unreadable is unknown, never evidence of interruption */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return false;
}

/**
 * What the user typed into a session, oldest first, each with the last assistant text before the next prompt (its answer).
 * Skips tool results, injected <...> blocks and interruption notes.
 */
export const transcriptExchanges = (file: string): Exchange[] => transcriptTurns(file).exchanges;

/**
 * transcriptExchanges, with when each prompt was written (ms, NaN when the line has no timestamp). A transcript only grows, so a
 * later call reads only the bytes appended since (the board reads a live card's transcript on every render; 11 November 2026, a whole
 * read each time froze the extension host); a replaced, rewritten or shorter file is read again from the start. A last line with no
 * newline yet is read but not kept: it may still be being written.
 */
export function transcriptTurns(file: string): { exchanges: Exchange[]; times: number[] } {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { exchanges: [], times: [] };
  }
  const key = `${st.size}:${st.mtimeMs}`, identity = `${st.dev}:${st.ino}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit.view;
  let fd: number;
  try { fd = fs.openSync(file, "r"); } catch { return { exchanges: [], times: [] }; }
  try {
    let from = hit && hit.identity === identity && st.size >= hit.offset ? hit : undefined;
    // Rewritten in place rather than appended to (same file, not shorter): the bytes before where the last read stopped differ.
    if (from?.anchor.length) {
      const now = Buffer.alloc(from.anchor.length);
      if (fs.readSync(fd, now, 0, now.length, from.offset - now.length) !== now.length || !now.equals(from.anchor)) from = undefined;
    }
    // Copies: an Exchange handed out earlier must not change under its holder when the last one gets its reply.
    const exchanges = from ? from.exchanges.slice() : [], times = from ? from.times.slice() : [];
    // Read in slices, each cut at its last newline: a first read of a large transcript never makes one string of all of it.
    let position = from?.offset ?? 0, pending = Buffer.alloc(0);
    while (position < st.size) {
      const chunk = Buffer.alloc(Math.min(TRANSCRIPT_SLICE, st.size - position));
      const count = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (!count) break;
      position += count;
      const data = pending.length ? Buffer.concat([pending, chunk.subarray(0, count)]) : chunk.subarray(0, count);
      const end = data.lastIndexOf(10) + 1;
      if (end) applyTurns(data.subarray(0, end).toString("utf8"), exchanges, times);
      pending = data.subarray(end);
    }
    const offset = position - pending.length;
    let view = { exchanges, times };
    if (pending.length) {
      const more = exchanges.slice(), moreTimes = times.slice();
      applyTurns(pending.toString("utf8"), more, moreTimes);
      view = { exchanges: more, times: moreTimes };
    }
    const anchor = Buffer.alloc(Math.min(TRANSCRIPT_ANCHOR, offset));
    if (anchor.length) fs.readSync(fd, anchor, 0, anchor.length, offset - anchor.length);
    cache.set(file, { key, identity, offset, anchor, exchanges, times, view });
    return view;
  } catch {
    return { exchanges: [], times: [] };
  } finally {
    fs.closeSync(fd);
  }
}

/** Bytes of a transcript read per slice, and bytes kept from before where a read stopped to tell an append from a rewrite. */
export const TRANSCRIPT_SLICE = 8 * 1024 * 1024;
const TRANSCRIPT_ANCHOR = 64;

/** Adds the prompts and answers in these complete transcript lines to `into`, with each prompt's time in `at`. */
function applyTurns(text: string, into: Exchange[], at: number[]) {
  for (const line of text.split("\n")) {
    const user = line.includes('"type":"user"');
    if (!user && !line.includes('"type":"assistant"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.isMeta || e.isSidechain) continue;
      const c = e.message?.content;
      const said = typedText(typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text).join("\n") : "");
      if (!said.trim()) continue;
      if (e.type === "user") { if (!notTyped(said)) { into.push({ text: said }); at.push(Date.parse(e.timestamp)); } }
      else if (e.type === "assistant" && into.length) into[into.length - 1] = { ...into[into.length - 1], reply: said.trim().slice(0, REPLY_CAP) };
    } catch {
      // a line still being written
    }
  }
}

/** What the user typed. While Claude in Chrome is connected, Claude Code (2.1.318) puts its ~4,100-character
 *  <browser_instruction> block in front of a panel prompt, and the card showed that instead (seen on the Linux machine, 4 November 2026). */
export function typedText(text: string): string {
  const end = "</browser_instruction>";
  const i = text.startsWith("<browser_instruction>") ? text.indexOf(end) : -1;
  return i < 0 ? text : text.slice(i + end.length).trimStart();
}


/** One quota window as its provider reports it: its length in minutes, percent used (0-100) and reset time in seconds. */
export interface UsageWindow {
  minutes: number;
  pct?: number;
  resets?: number;
}

/**
 * One account's latest quota reading, as the CLI reported it. Percentages 0-100; reset times in seconds.
 * Claude's two subscription windows are `fiveHour` and `week`. A provider with other limits (Codex) reports `windows` instead,
 * each with its real length, so the board labels them as that provider applies them rather than forcing them into Claude's shape.
 */
export interface Usage {
  /** Explicit window coverage from a Claude quota reply. Older snapshots may omit it. */
  quotaCoverage?: "weekly-only" | "incomplete";
  fiveHour?: number;
  week?: number;
  fiveHourResets?: number;
  weekResets?: number;
  windows?: UsageWindow[];
  at: number;
  source: "statusline" | "stream" | "query";
}

/** A window's short name from its length: "5-hour", "weekly", else "{n}-hour" or "{n}-day". The board's labels add " limit". */
export const windowName = (minutes: number) =>
  minutes === 300 ? "5-hour" : minutes === 7 * 1440 ? "weekly" : minutes < 1440 ? `${minutes / 60}-hour` : `${minutes / 1440}-day`;

export const USAGE_DIR = process.env.ENTOMATICAL_USAGE_DIR || path.join(os.homedir(), ".entomatical", "usage");

/** File name for an account's usage: "main" for ~/.claude, else its folder name. Mirrored in wrapper/entomatical-claude.js usageKey. */
export const usageKey = (configDir: string) => (configDir && norm(configDir) !== norm(DEFAULT_DIR) ? path.basename(configDir).replace(/[^\w.@-]/g, "_") : "main");

export function readUsage(configDir: string, dir = USAGE_DIR, key = usageKey(configDir)): Usage | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), "utf8"));
    if (!raw || !Number.isFinite(raw.at) || raw.at <= 0 || raw.at > Date.now() + 60_000) return undefined;
    const pct = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : undefined;
    const reset = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
    const windows = Array.isArray(raw.windows)
      ? raw.windows.filter((w: any) => typeof w?.minutes === "number" && w.minutes > 0).map((w: any) => ({ minutes: w.minutes, pct: pct(w.pct), resets: reset(w.resets) }))
      : undefined;
    return { fiveHour: pct(raw.fiveHour), week: pct(raw.week), fiveHourResets: reset(raw.fiveHourResets), weekResets: reset(raw.weekResets),
      ...(windows?.length ? { windows } : {}),
      ...(raw.quotaCoverage === "weekly-only" || raw.quotaCoverage === "incomplete" ? { quotaCoverage: raw.quotaCoverage } : {}),
      at: raw.at, source: raw.source === "query" ? "query" : raw.source === "stream" ? "stream" : "statusline" };
  } catch {
    return undefined; // no reading yet
  }
}

const replyCache = new Map<string, { key: string; text: string | undefined }>();

/** First line of the latest assistant text in a transcript, capped at 160 characters. Reads only the tail, and only when the file changed. */
export function lastAssistantText(file: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    const { size, mtimeMs } = fs.fstatSync(fd);
    const key = `${size}:${mtimeMs}`;
    const hit = replyCache.get(file);
    if (hit?.key === key) return hit.text;
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    let reply: string | undefined;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"type":"assistant"')) continue;
      try {
        const e = JSON.parse(lines[i]);
        const text = Array.isArray(e.message?.content) ? e.message.content.find((p: { type: string }) => p.type === "text")?.text : undefined;
        if (typeof text === "string" && text.trim()) {
          reply = text.trim().split("\n")[0].slice(0, 160);
          break;
        }
      } catch {
        // a cut-off first line of the tail, or still being written
      }
    }
    replyCache.set(file, { key, text: reply });
    return reply;
  } finally {
    fs.closeSync(fd);
  }
}

/** Which notification a status change deserves. Found sessions get none: the user is already working in them. */
export function transitionNote(from: Status, to: Status, adopted: boolean | undefined, error?: string): "input" | "done" | undefined {
  if (adopted) return undefined;
  if (error && to === "review") return "done"; // an API error ended the turn, from any column (a first prompt refused within one poll, a follow-up in Review)
  if (from === to) return undefined;
  if (to === "needs-input") return "input";
  if (to === "review" && (from === "running" || from === "needs-input")) return "done";
  return undefined;
}
