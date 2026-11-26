// Codex (OpenAI) account, models and usage, read through the Codex CLI's own app-server protocol (JSON-RPC lines on stdio),
// plus its per-thread rollout files (token counts, spawned agents, found sessions). See the Codex event contract.
// Entomatical never opens Codex's login file (auth.json): sign-in, the account's email and its quota all come from the CLI.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChildProcess, execFile, execFileSync, spawn, spawnSync } from "child_process";
import { createInterface } from "readline";
import type { Account, Status } from "./board";
import type { Measurement, Tokens } from "./metrics";
import { CodexWsl, fromWsl, rememberCodexHome, toWsl, WSL_PREFIX, wslCommand, wslEnv } from "./wsl";
import { isTempRoot } from "./workspace";
import { Exchange, inRepo, inside, LiveSession, readUsage, REPLY_CAP, Subagent, Usage, USAGE_DIR, usageKey, UsageWindow, writeFileAtomic } from "./sessions";
import { exactModel } from "./models";

/** The CLI's own folder. There is one Codex account: whichever this folder is signed into. */
export let CODEX_DIR = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

let wsl: CodexWsl | undefined;
/** The WSL distro Codex runs in (Windows, when the Codex extension runs Codex in WSL); undefined: Codex runs natively. */
export const codexWsl = () => wsl;
/**
 * Codex runs in `distro` from now on, with its home folder `home` (a Windows path into WSL, e.g. \\wsl.localhost\Ubuntu\home\example\.codex).
 * With no distro, Codex runs natively again in `home` (tests).
 */
export function useCodexWsl(distro: string | undefined, home: string) {
  wsl = distro ? { distro } : undefined;
  if (distro) rememberCodexHome(distro, home);
  CODEX_DIR = home;
  SESSIONS = path.join(CODEX_DIR, "sessions");
}
/**
 * The distro the Codex extension picks (its first distro whose name starts with "ubuntu", from `wsl.exe --list --quiet`, which
 * prints UTF-16) and Codex's home there as a Windows path. Undefined when WSL or such a distro is missing.
 */
export function findCodexWsl(): { distro: string; home: string } | undefined {
  try {
    const distro = ubuntuIn(execFileSync("wsl.exe", WSL_LIST, { encoding: "utf16le", timeout: 15_000, windowsHide: true }));
    if (!distro) return undefined;
    const home = execFileSync("wsl.exe", wslHomeArgs(distro), { encoding: "utf8", timeout: 15_000, windowsHide: true }).trim();
    return home ? { distro, home } : undefined;
  } catch { return undefined; }
}
const WSL_LIST = ["--list", "--quiet"];
const ubuntuIn = (list: string) => list.replace(/\0/g, "").split(/\r?\n/).map((s) => s.trim()).find((s) => s.toLowerCase().startsWith("ubuntu"));
const wslHomeArgs = (distro: string) => ["-d", distro, "--exec", "/bin/bash", "-lc", 'wslpath -w "${CODEX_HOME:-$HOME/.codex}"'];
/** findCodexWsl without blocking the extension host: for the retries while WSL does not answer. */
export async function findCodexWslLater(): Promise<{ distro: string; home: string } | undefined> {
  const run = (args: string[], encoding: BufferEncoding) => new Promise<string | undefined>((ok) => {
    try { execFile("wsl.exe", args, { encoding, timeout: 15_000, windowsHide: true }, (e, out) => ok(e ? undefined : String(out))); }
    catch { ok(undefined); }
  });
  const distro = ubuntuIn((await run(WSL_LIST, "utf16le")) ?? "");
  const home = distro && (await run(wslHomeArgs(distro), "utf8"))?.trim();
  return distro && home ? { distro, home } : undefined;
}

/**
 * WSL mode is on but WSL did not answer (8 November 2026: WSL hung for four hours, Entomatical quietly fell back to Windows Codex, and
 * resuming a WSL session there failed with exit code 1). Until WSL answers, every Codex start fails with this message instead.
 */
export const WSL_NOT_ANSWERING = "Codex runs in WSL (chatgpt.runCodexInWindowsSubsystemForLinux), but WSL is not answering, so no Codex task can start. " +
  "Entomatical keeps checking. If WSL stays stuck, run `wsl --shutdown` in a Windows terminal.";
let wslAwaited = false;
/** WSL mode is on and WSL has not answered yet: Codex must not run on Windows instead. */
export const awaitCodexWsl = (awaited = true) => { wslAwaited = awaited; };
const nativeAllowed = () => { if (wslAwaited) throw new Error(WSL_NOT_ANSWERING); };

/**
 * Resuming needs the Codex that recorded the session: a transcript under \\wsl.localhost\ (or \\wsl$\) lives in WSL's ~/.codex,
 * which Windows Codex cannot see. Throws when the session and the Codex that would resume it are on different sides.
 */
export function checkResumable(transcript: string | undefined) {
  const recordedIn = transcript && /^\\\\(?:\?\\UNC\\)?(?:wsl\$|wsl\.localhost)\\([^\\]+)/i.exec(transcript)?.[1];
  if (!recordedIn || wsl) return;
  nativeAllowed();
  throw new Error(`This Codex session was recorded in WSL (${recordedIn}), but Codex now runs on Windows, which cannot open it. ` +
    "Turn on chatgpt.runCodexInWindowsSubsystemForLinux and reload the window to resume it.");
}

/** The Codex a text job runs (worker.ts): the binary, or `wsl:<distro>` in WSL mode. */
export const codexTextPath = () => (wsl ? `${WSL_PREFIX}${wsl.distro}` : (nativeAllowed(), codexBinary()));
/** A path as Codex sees it (a WSL path in WSL mode), and back. */
export const toCodexPath = (p: string) => (wsl ? toWsl(p, wsl.distro) : p);
export const fromCodexPath = (p: string) => (wsl ? fromWsl(p, wsl.distro) : p);

/** How to start `codex <args>` in `cwd`: in WSL mode through wsl.exe, otherwise the binary itself. `env` gets what must cross into WSL. */
export function codexCommand(args: string[], cwd?: string, env: NodeJS.ProcessEnv = process.env): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (!wsl) { nativeAllowed(); return { file: codexBinary(), args, env }; }
  // TMPDIR: the card's temporary folder in the workspace (workspace.ts), as its /mnt path, so WSL Codex does not use the distro's /tmp.
  return { ...wslCommand(wsl, args, cwd), env: wslEnv(env, ["ENTOMATICAL_EVENTS", "ENTOMATICAL_REPO", "TMPDIR"], ["ENTOMATICAL_TASK", "ENTOMATICAL_RUNTIME", "ENTOMATICAL_SESSION", "ENTOMATICAL_NO_SYNC", "ENTOMATICAL_PARENT", "ENTOMATICAL_ROOT", "ENTOMATICAL_TERMINAL_LAUNCH"]) };
}

let binary: string | undefined;
/** The installed `codex` on PATH, which the user keeps current; never the Codex extension's bundled copy, which updates rarely.
 *  The extension sets `entomatical.codexPath` here when it is not empty. */
export const codexBinary = () => (binary ??= installedBinary());
export const setCodexBinary = (file: string) => { binary = nativeCodexBinary(file); };
/** The native codex.exe an npm install keeps beside its launchers in `dir`, x64 first. */
const npmVendor = (dir: string) => [["x64", "x86_64-pc-windows-msvc"], ["arm64", "aarch64-pc-windows-msvc"]].map(([cpu, triple]) =>
  path.win32.join(dir, "node_modules", "@openai", "codex", "node_modules", "@openai", `codex-win32-${cpu}`, "vendor", triple, "bin", "codex.exe"));
/** Normalize an explicit npm launcher exactly as PATH discovery does. npm writes three side by side (`codex.cmd`, `codex.ps1` and the
 *  extensionless shell script `codex`); spawn() can start none of them without a shell, so each maps to the native codex.exe. */
export function nativeCodexBinary(file: string, platform = process.platform, exists = fs.existsSync): string {
  if (platform !== "win32" || !path.win32.isAbsolute(file) || !/[\\/]codex(?:\.cmd|\.ps1)?$/i.test(file)) return file;
  // Preserve an unresolved setting so the runner preflight reports its failure without disabling extension activation.
  return npmVendor(path.win32.dirname(file)).find((f) => exists(f)) ?? file;
}
/**
 * Which Codex Entomatical runs (F61): entomatical.codexPath when set; else, on Windows with chatgpt.runCodexInWindowsSubsystemForLinux
 * on, the one in WSL; else chatgpt.cliExecutable when that file exists; else the installed `codex` on PATH (installedBinary).
 */
export function codexChoice(codexPath: string, cliExecutable: string | null | undefined, wslOn: boolean, platform = process.platform,
  exists = fs.existsSync): { via: "codexPath" | "wsl" | "cliExecutable" | "PATH"; file?: string } {
  if (codexPath) return { via: "codexPath", file: codexPath };
  if (platform === "win32" && wslOn) return { via: "wsl" };
  if (cliExecutable && exists(cliExecutable)) return { via: "cliExecutable", file: cliExecutable };
  return { via: "PATH" };
}
/** A regular file this user may run: not a folder named codex, nor a file without the execute bit (or on a noexec mount). */
const runnable = (file: string) => {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
};
/** The first `codex` on PATH. On Windows npm installs a `codex.cmd` launcher, which spawn() cannot start without a shell,
 *  so this returns the native codex.exe that launcher runs (it stays at the same path when npm updates the package).
 *  Elsewhere a relative PATH entry is skipped: it would name a file in whatever folder the editor started in. */
export function installedBinary(pathVar = process.env.PATH ?? process.env.Path ?? "", platform = process.platform,
  exists: (file: string) => boolean = platform === "win32" ? fs.existsSync : runnable): string {
  const win = platform === "win32";
  const vendor = npmVendor;
  for (const dir of pathVar.split(win ? ";" : ":").filter(Boolean)) {
    const join = win ? path.win32.join : path.posix.join;
    if (!win) { if (path.posix.isAbsolute(dir) && exists(join(dir, "codex"))) return join(dir, "codex"); continue; }
    if (exists(join(dir, "codex.exe"))) return join(dir, "codex.exe");
    if (exists(join(dir, "codex.cmd"))) { const exe = vendor(dir).find((f) => exists(f)); if (exe) return exe; }
  }
  return "codex"; // not installed: spawning fails with ENOENT, which names the missing command
}

/** The first line `file args` prints (`codex --version`: "codex-cli 0.166.0"), or undefined when it does not run within 15 s. */
export function codexVersion(file: string, args = ["--version"]): Promise<string | undefined> {
  return new Promise((ok) => {
    try {
      execFile(nativeCodexBinary(file), args, { timeout: 15_000, windowsHide: true }, (e, out) => ok(e ? undefined : String(out).trim().split(/\r?\n/)[0] || undefined));
    } catch { ok(undefined); } // spawn throws at once for some files (a .cmd on Windows)
  });
}
/** The Codex extension's own codex: <its folder>/bin/<platform>/codex (codex.exe on Windows), or undefined. */
export function bundledCodex(extensionPath: string | undefined, platform = process.platform): string | undefined {
  if (!extensionPath) return undefined;
  try {
    for (const dir of fs.readdirSync(path.join(extensionPath, "bin"))) {
      const file = path.join(extensionPath, "bin", dir, platform === "win32" ? "codex.exe" : "codex");
      if (fs.existsSync(file)) return file;
    }
  } catch { /* no bin folder */ }
  return undefined;
}

export type Request = (method: string, params?: unknown) => Promise<any>;

export interface RpcClient {
  request: Request;
  /** Sends a notification (no answer expected). */
  notify: (method: string, params?: unknown) => void;
  /** Fails every unanswered request and stops reading; after the process ended. */
  close: (error: Error) => void;
}

/**
 * JSON-RPC lines over a child's stdio, as `codex app-server` speaks them: answers go to their requests and notifications to
 * `onNotification`. The server's own requests (approvals, questions) are ignored, or with `unattended` refused at once, so a turn
 * nobody is there to answer does not hang on them.
 */
export function rpcClient(child: ChildProcess, onNotification?: (method: string, params: any) => void, unattended = false,
  onRequest?: (method: string, params: any) => void): RpcClient {
  const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  let next = 1;
  const write = (m: unknown) => { try { child.stdin?.write(JSON.stringify(m) + "\n"); } catch { /* ended */ } };
  const request: Request = (method, params = {}) => new Promise((ok, fail) => {
    const id = next++;
    pending.set(id, { ok, fail });
    write({ id, method, params });
  });
  const reader = createInterface({ input: child.stdout! });
  reader.on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (typeof m?.id === "number" && !("method" in m)) { // an answer
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.fail(new Error(m.error.message || "Codex refused the request.")); else p.ok(m.result);
    } else if (m?.method && m.id !== undefined) {
      onRequest?.(m.method, m.params);
      if (unattended) write({ id: m.id, error: { code: -32601, message: "Nobody is attending this session." } });
    }
    else if (m?.method) onNotification?.(m.method, m.params);
  });
  const close = (error: Error) => { reader.close(); for (const p of pending.values()) p.fail(error); pending.clear(); };
  return { request, notify: (method, params) => write(params === undefined ? { method } : { method, params }), close };
}

/** One short app-server conversation: initialize, run `work`, then close the CLI. `args` are extra options, such as `-c` overrides. */
export function appServer<T>(work: (request: Request) => Promise<T>,
  { file, env = process.env, timeoutMs = 30_000, signal, args = [] }: { file?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal; args?: string[] } = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Cancelled."));
    // An explicit file (tests' fake) runs as is; otherwise the configured Codex, in WSL when Codex runs there.
    const run = file ? { file, args: ["app-server", ...args], env } : codexCommand(["app-server", ...args], undefined, env);
    const child = spawn(run.file, run.args, { env: run.env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const rpc = rpcClient(child);
    let done = false;
    const finish = (error?: Error, value?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      rpc.close(error ?? new Error("Codex closed."));
      child.kill();
      if (error) reject(error); else resolve(value as T);
    };
    const cancel = () => finish(new Error("Cancelled."));
    const timer = setTimeout(() => finish(new Error("Codex did not answer in time. Check its sign-in and try again.")), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    child.on("error", (e) => finish(e));
    child.on("exit", () => finish(new Error("Codex exited before answering.")));
    child.stdin.on("error", (e) => finish(e));
    rpc.request("initialize", { clientInfo: { name: "entomatical", version: "1" }, capabilities: {} })
      .then(() => { rpc.notify("initialized"); return work(rpc.request); })
      .then((value) => finish(undefined, value), (e) => finish(e instanceof Error ? e : new Error(String(e))));
  });
}

/**
 * Names a Codex thread (app-server `thread/name/set`, codex-cli 0.163; `thread/name/updated` is a notification and is
 * refused as a request). This updates thread metadata, not the VS Code tab label: the Codex extension owns that label and may
 * omit exec threads from its lookup. A successful call is not evidence that the visible tab title changed.
 */
export function nameCodexThread(threadId: string, name: string, opts: { file?: string; signal?: AbortSignal } = {}): Promise<void> {
  return appServer(async (request) => { await request("thread/name/set", { threadId, name }); }, { timeoutMs: 20_000, ...opts });
}

/** Every page of model/list, as the CLI returns them. */
export async function listModels(request: Request): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | undefined;
  do {
    const page = await request("model/list", cursor ? { cursor } : {});
    all.push(...(Array.isArray(page?.data) ? page.data : []));
    cursor = typeof page?.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
  } while (cursor);
  return all;
}

/** isDefault: the model Codex runs when none is named (model/list `isDefault`); the board sends that id, never nothing (17 November 2026). */
export interface CodexModel { model: string; efforts: string[]; defaultEffort?: string; isDefault?: boolean }
export interface CodexStatus { loggedIn: boolean; email?: string; plan?: string; models: CodexModel[]; error?: string }

let status: CodexStatus | undefined; // undefined: no Codex CLI on this machine
export const codexStatus = () => status;
export const codexModels = () => status?.models ?? [];
/** The id Codex runs when none is named, as its model/list marks it; undefined before Codex listed one. */
export const codexDefaultModel = (models: readonly CodexModel[] = codexModels()) => models.find((m) => m.isDefault)?.model;

/**
 * The model Codex runs in `cwd` when none is named: `model` in its effective config (config.toml in CODEX_HOME or the WSL home, and a
 * project's own), from `config/read`. Undefined when none is set or this Codex cannot say (its model/list default then applies).
 * Seen 17 November 2026: config.toml set gpt-6.1-sol while model/list marked gpt-6.2-sol as default.
 */
export async function codexConfigModel(cwd: string): Promise<string | undefined> {
  try {
    return await appServer(async (request) => {
      const model = (await request("config/read", { cwd: toCodexPath(cwd) }))?.config?.model;
      return typeof model === "string" && model.trim() ? model.trim() : undefined;
    }, { timeoutMs: 20_000 });
  } catch { return undefined; }
}

/** Asks the CLI who it is signed in as and which models that account may use. */
export async function discoverCodex(): Promise<void> {
  try {
    status = await appServer(async (request) => {
      const account = (await request("account/read", {}))?.account;
      if (!account) return { loggedIn: false, models: [] };
      const models = (await listModels(request)).filter((m) => typeof m?.model === "string" && !m.hidden).map((m) => ({
        model: m.model as string,
        efforts: (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : [])
          .map((e: any) => (typeof e === "string" ? e : e?.reasoningEffort)).filter((e: unknown): e is string => typeof e === "string"),
        defaultEffort: typeof m.defaultReasoningEffort === "string" ? m.defaultReasoningEffort : undefined,
        ...(m.isDefault === true ? { isDefault: true } : {}),
      }));
      return { loggedIn: true, email: typeof account.email === "string" ? account.email.toLowerCase() : undefined, plan: account.planType ?? undefined, models };
    });
  } catch (e) {
    // A slow or busy CLI keeps the last good answer, so Codex tasks and menus do not vanish until the next scan.
    const error = e instanceof Error ? e.message : String(e);
    status = (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : status?.loggedIn ? { ...status, error } : { loggedIn: false, models: [], error };
  }
}

/** The signed-in Codex account. Named apart from a Claude account that uses the same email. */
export const codexAccounts = (): Account[] => (status?.loggedIn ? [{ name: `Codex · ${status.email ?? "API key"}`, configDir: "", provider: "codex" }] : []);

/** Whether a Codex model (or, with no model chosen, any of them) offers this effort level. */
export const codexEffortOk = (model: string | undefined, effort: string) => codexModels().filter((m) => !model || m.model === model).some((m) => m.efforts.includes(effort));

/**
 * Codex's quota windows as Entomatical's Usage, each kept at the length Codex itself reports (`windowDurationMins`), never forced into
 * Claude's 5-hour and weekly shape. OpenAI's limits differ by plan: Plus and Business Standard have a five-hour window and a weekly one,
 * Pro 100/200/500 and Business Premium have no five-hour limit (weekly only), Go has a monthly allowance, and Enterprise/Edu with flexible
 * pricing have no fixed windows. Sources, read 29 October 2026: https://developers.openai.com/codex/pricing (now https://learn.chatgpt.com/docs/pricing)
 * and https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work. Seen in practice: a Pro plan reports one 10080-minute
 * window as `primary` with no `secondary` (26 Oct 2026); the app-server fake reports 300 and 10080.
 * Accepts the app-server's camelCase fields and the rollout files' snake_case ones (`token_count.rate_limits`).
 */
export function parseCodexUsage(limits: any, at = Date.now()): Usage {
  const windows: UsageWindow[] = [];
  for (const w of [limits?.primary, limits?.secondary]) {
    const pct = w?.usedPercent ?? w?.used_percent, mins = w?.windowDurationMins ?? w?.window_minutes, reset = w?.resetsAt ?? w?.resets_at;
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100 || typeof mins !== "number" || !(mins > 0)) continue;
    windows.push({ minutes: mins, pct, resets: typeof reset === "number" && reset > 0 ? reset : undefined });
  }
  if (!windows.length) throw new Error("Codex did not report its usage limits. Try Refresh again later.");
  windows.sort((a, b) => a.minutes - b.minutes); // shortest first, as the board lists Claude's
  return { at, source: "query", windows };
}

/** The same quota read the CLI's own /status uses. No prompt and no model turn. */
export const codexUsage = (signal?: AbortSignal) =>
  appServer(async (request) => parseCodexUsage((await request("account/rateLimits/read", {}))?.rateLimits), { signal });

/** The hook events a Codex session reports to hook.js, in Claude's own JSON shape (checked live on codex-cli 0.163, 26 Oct 2026). */
export const CODEX_HOOKS = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "PostToolUse", "Stop", "Interrupt", "SubagentStart", "SubagentStop", "SessionEnd"];

/** hook.js copied to a fixed path, so the hook command (and so Codex's approval of it) stays the same across Entomatical updates. */
export const CODEX_HOOK = path.join(os.homedir(), ".entomatical", "codex-hook.js");

/** Copies the bundled hook script to CODEX_HOOK when it differs. */
export function placeCodexHook(bundled: string, target = CODEX_HOOK) {
  if (!fs.existsSync(bundled)) return;
  const data = fs.readFileSync(bundled);
  if (fs.existsSync(target) && fs.readFileSync(target).equals(data)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}

/**
 * The hooks as per-session config overrides (`-c hooks.<Event>=…`, PascalCase keys). The command is the same for every task, the
 * events file travelling in ENTOMATICAL_EVENTS, because Codex runs only hooks the user approved and keys that approval to a hash of
 * the hook's definition. A JSON string is also a TOML string, so paths with spaces or backslashes reach Codex intact.
 */
export function hookArgs(hook = CODEX_HOOK): string[] {
  const command = JSON.stringify(hookCommand(hook));
  return CODEX_HOOKS.flatMap((event) => ["-c", `hooks.${event}=[{matcher="*",hooks=[{type="command",command=${command}}]}]`]);
}
const hookCommand = (hook: string) => `node "${toCodexPath(hook).replace(/\\/g, "/")}"`; // in WSL: the WSL node and /mnt/c path

/** The same hook definitions as hookArgs, for a thread started in the editor's existing app-server. */
export function hookConfig(hook = CODEX_HOOK): Record<string, unknown> {
  return Object.fromEntries(CODEX_HOOKS.map((event) => [`hooks.${event}`, [{ matcher: "*", hooks: [{ type: "command", command: hookCommand(hook) }] }]]));
}

/**
 * Permission menu choice -> Codex config overrides, after Codex's own /approvals presets (the user, 3 November 2026). Codex has no
 * separate "accept edits" mode: its Auto already edits the workspace freely. codex-cli 0.167 refuses to start with
 * approval_policy="untrusted" ("no longer supported"), so Ask is now Codex's Read Only preset: every write or command outside
 * the read-only sandbox asks first (14 November 2026).
 */
export interface CodexPermissions {
  approvalPolicy: "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}
export const CODEX_PERMISSIONS: Record<string, CodexPermissions> = {
  ask: { approvalPolicy: "on-request", sandbox: "read-only" },
  auto: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  bypass: { approvalPolicy: "never", sandbox: "danger-full-access" },
};

function codexPermissionOverrides({ permission, role }: { permission?: string; role?: string }): Partial<CodexPermissions> {
  if (permission !== undefined && (typeof permission !== "string" || !Object.hasOwn(CODEX_PERMISSIONS, permission))) {
    throw new Error(`Unknown Codex permission mode "${String(permission)}". Select Ask, Auto or Bypass before starting or resuming.`);
  }
  const policy = permission === undefined ? {} : CODEX_PERMISSIONS[permission];
  return role === "judge" || role === "research" ? { ...policy, sandbox: "read-only" } : policy;
}

/** Older cards without a selection keep the editor's original workspace-write/never first turn. */
export function codexThreadPermissions(task: { permission?: string; role?: string }): CodexPermissions {
  return { approvalPolicy: "never", sandbox: "workspace-write", ...codexPermissionOverrides(task) };
}

/** Arguments for an interactive Codex session in a terminal. Its environment must carry ENTOMATICAL_EVENTS (the task's events file). */
export function codexArgs(o: { model?: string; effort?: string; permission?: string; role?: string; editorDefaults?: boolean; hook?: string; prompt?: string; resume?: string }): string[] {
  const { approvalPolicy, sandbox } = o.editorDefaults ? codexThreadPermissions(o) : codexPermissionOverrides(o);
  const permission = [...(approvalPolicy ? ["-c", `approval_policy="${approvalPolicy}"`] : []), ...(sandbox ? ["-c", `sandbox_mode="${sandbox}"`] : [])];
  // Only an exact id goes to Codex (the user, 17 November 2026); the board resolves short names and the default first (codexLaunchModel).
  const options = [...(o.model ? ["-m", exactModel("codex", o.model)] : []), ...(o.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(o.effort)}`] : []), ...permission, ...hookArgs(o.hook)];
  // A resume runs where it is started (the task's worktree), not in the folder Codex's thread store remembers. In WSL that store
  // lower-cases /mnt paths, and Codex, which compares trust keys exactly on Linux, then stopped on its "Trust this folder?" screen
  // for the lower-case copy (codex-cli 0.166.0, 2 November 2026). tui.resume_cwd also skips Codex's "which folder?" prompt.
  if (o.resume !== undefined) return ["resume", ...options, "-c", 'tui.resume_cwd="current"', o.resume || "--last", ...(o.prompt ? [o.prompt] : [])]; // --last: the newest session in this worktree
  return [...options, "--", o.prompt ?? ""];
}

/** Deliver a continuation to the editor's existing thread, using the CLI's queue rather than another conversation or writer. */
export function queueCodexMessage(thread: string, prompt: string, cwd: string): Promise<void> {
  const run = codexCommand(["queue", "--thread", thread, "--message", prompt, "--resume"], cwd);
  // A wake warning can accompany delivery to an existing writer. The caller confirms a new turn in the rollout or hooks.
  return new Promise((resolve, reject) => {
    execFile(run.file, run.args, { cwd, env: run.env, timeout: 30_000, windowsHide: true }, (error) => error ? reject(error) : resolve());
  });
}

export interface HookTrust { key: string; currentHash: string }

/** What Codex would stop for before a session in a folder: Entomatical's unapproved hooks, and a repo it has not trusted. */
export interface CodexApprovals {
  hooks: HookTrust[];
  /** The repo root to trust, when Codex would open on its "Folder access … Trust this folder?" screen. */
  folder?: string;
  /** Codex has this folder marked untrusted; it then opens on "Open restricted / Quit" instead. */
  markedUntrusted?: boolean;
  /** Why this Codex could not report folder trust (no `config/read`); the folder is then left to Codex's own screen. */
  folderUnknown?: string;
  /** Codex in WSL: the task worktree, which Codex trusts on its own (see trustRoot), trusted together with `folder`. */
  worktree?: string;
  /** The repo is already trusted and only its worktree is not: Entomatical records the worktree without asking again. */
  inherited?: boolean;
}

const realPath = (p: string) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

/**
 * The folder Codex asks to trust for `cwd`, found as codex-cli does (`resolve_root_git_project_for_trust`): the nearest folder with a
 * `.git`, and for a linked worktree, whose `.git` file points into `<repo>/.git/worktrees/<name>`, the main repo's folder. Codex 0.164
 * names that folder on its trust screen ("Trusting will apply to the repository root"). Undefined outside git and in a submodule.
 * Codex in WSL (`linux`) is a Linux program and cannot follow the `gitdir: C:/…` Git for Windows writes, so it asks to trust the
 * worktree folder itself (seen 5 November 2026, the Codex cwd regression).
 */
export function trustRoot(cwd: string, linux = !!wsl): string | undefined {
  for (let dir = realPath(cwd); ;) {
    const dotGit = path.join(dir, ".git");
    let stat: fs.Stats | undefined;
    try { stat = fs.statSync(dotGit); } catch { /* not here */ }
    // A `.git` folder without HEAD is not a repository (git says "not a git repository" and keeps looking upward): Codex's
    // bwrap sandbox leaves an empty /tmp/.git as a mount target (seen 30 October 2026), which made every /tmp folder look trusted.
    if (stat?.isDirectory()) { if (fs.existsSync(path.join(dotGit, "HEAD"))) return dir; }
    else if (stat?.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
      if (!m) return undefined;
      if (linux && /^[A-Za-z]:[\\/]/.test(m[1].trim())) return dir;
      const worktrees = path.dirname(realPath(path.resolve(dir, m[1].trim())));
      return path.basename(worktrees) === "worktrees" ? path.dirname(path.dirname(worktrees)) : undefined;
    }
    const up = path.dirname(dir);
    if (up === dir || isTempRoot(dir)) return undefined; // the workspace's .entomatical/tmp: git stops there too (workspace.ts)
    dir = up;
  }
}

/**
 * Codex's `projects` keys are paths as Codex wrote them. Native Windows Codex compares them as Windows paths do (any case, either
 * slash). Codex in WSL is a Linux program and compares them exactly, so Entomatical does too, in Codex's own (WSL) form of the path:
 * otherwise a key in another case looks trusted here while Codex still stops on its "Trust this folder?" screen (seen 2 November
 * 2026 on resume, the WSL resume regression).
 */
const winPath = (p: string) => p.replace(/^\\\\\?\\/, "").replace(/\//g, "\\").toLowerCase();
const samePath = (a: string, b: string) => { // a: as Codex wrote it; b: a Windows path here
  if (wsl) return a === toCodexPath(b);
  return process.platform === "win32" ? winPath(a) === winPath(b) : a === b;
};

/**
 * The trust level Codex applies in `cwd`, from its effective config (`config/read`): the folder's own `projects` entry, else its repo
 * root's. A parent folder's trust does not count (checked with codex-cli 0.163 on 29 Oct 2026: a trusted parent still ran read-only).
 */
export function folderTrust(config: any, cwd: string): { root?: string; level?: string } {
  const root = trustRoot(cwd);
  const projects = config?.projects && typeof config.projects === "object" ? config.projects : {};
  const level = (folder: string | undefined) => {
    const key = folder === undefined ? undefined : Object.keys(projects).find((k) => samePath(k, folder));
    const value = key === undefined ? undefined : projects[key]?.trust_level;
    return typeof value === "string" ? value : undefined;
  };
  return { root, level: level(realPath(cwd)) ?? level(root) };
}

/**
 * Asks Codex, in one app-server conversation started with the same hook flags as a session, which of Entomatical's hooks it has not
 * approved (`hooks/list`) and whether it trusts the folder's repo (`config/read`, the effective config with its `projects` table).
 */
export async function pendingApprovals(cwd: string, hook = CODEX_HOOK): Promise<CodexApprovals> {
  const command = hookCommand(hook);
  return appServer(async (request) => {
    const list = await request("hooks/list", { cwds: [toCodexPath(cwd)] });
    const listed: any[] = list?.data?.[0]?.hooks ?? [];
    const hooks = listed.filter((h) => h.source === "sessionFlags" && h.command === command && (h.trustStatus === "untrusted" || h.trustStatus === "modified"))
      .map((h) => ({ key: h.key, currentHash: h.currentHash }));
    let read: any;
    try { read = await request("config/read", { cwd: toCodexPath(cwd) }); } catch (e) { return { hooks, folderUnknown: e instanceof Error ? e.message : String(e) }; }
    if (!read?.config || typeof read.config !== "object") return { hooks, folderUnknown: "Codex's config/read returned no config." };
    const { root, level } = folderTrust(read.config, cwd);
    if (!root || level === "trusted") return { hooks };
    // Codex in WSL asks about a task worktree on its own. Trusting the repo already covers it, so ask about the repo as before
    // (once per repo) and record the worktree with it; when the repo is trusted, record the worktree without asking.
    const repo = wsl ? trustRoot(cwd, false) : undefined;
    if (repo && repo !== root) {
      const repoLevel = folderTrust(read.config, repo).level;
      return repoLevel === "trusted" ? { hooks, folder: repo, worktree: root, inherited: true }
        : { hooks, folder: repo, worktree: root, markedUntrusted: repoLevel === "untrusted" || level === "untrusted" };
    }
    return { hooks, folder: root, markedUntrusted: level === "untrusted" };
  }, { args: hookArgs(hook) });
}

/**
 * Records approval the way Codex's own screens do, in one `config/batchWrite` to its config.toml: hooks.state.<key>.trusted_hash, as
 * its /hooks screen writes, and projects."<root>".trust_level = "trusted", as "Trust and continue" writes. Upserts keep every other
 * entry. Unlike `--dangerously-bypass-hook-trust`, other unapproved hooks stay off.
 */
export async function approveCodex({ hooks, folder, worktree }: Pick<CodexApprovals, "hooks" | "folder" | "worktree">): Promise<void> {
  const edits: unknown[] = [];
  if (hooks.length) edits.push({ keyPath: "hooks.state", value: Object.fromEntries(hooks.map((h) => [h.key, { trusted_hash: h.currentHash }])), mergeStrategy: "upsert" });
  // The path is a key inside the value: a keyPath of projects.<root> would split at the dots a folder name can hold.
  const trusted = [folder, worktree].filter((f): f is string => !!f);
  if (trusted.length) edits.push({ keyPath: "projects", value: Object.fromEntries(trusted.map((f) => [toCodexPath(f), { trust_level: "trusted" }])), mergeStrategy: "upsert" });
  if (edits.length) await appServer((request) => request("config/batchWrite", { edits }));
}

// ---- Rollout files: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl, one JSON record per line, flushed per line.
// The board reads them for token counts (`token_count`), spawned agents (`SubAgentActivity` items), prompts and, for found sessions, status.

let SESSIONS = path.join(CODEX_DIR, "sessions");
const zero = (): Tokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
const add = (a: Tokens, b: Tokens) => { for (const k of Object.keys(a) as Array<keyof Tokens>) a[k] += b[k]; };
const firstLine = (s: string) => s.trim().split("\n")[0].slice(0, 120);

export type RolloutTerminalFact = Readonly<{
  ordinal?: number;
  turnId?: string;
  outcome: "completed" | "aborted";
  reply?: string;
} & ({ threadAttribution: "explicit"; threadId: string } | { threadAttribution: "unknown" })>;

const rolloutObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
const rolloutId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(v);

/** Project one parsed JSONL row. Thread attribution describes only the terminal payload's own declaration.
 * An untagged row can appear in either local or copied history. Its file location does not establish ownership. */
export function rolloutTerminalFact(row: unknown): RolloutTerminalFact | undefined {
  if (!rolloutObject(row) || row.type !== "event_msg" || !rolloutObject(row.payload)) return;
  const p = row.payload;
  if (p.type !== "task_complete" && p.type !== "turn_aborted") return;
  const attribution = rolloutId(p.thread_id)
    ? { threadAttribution: "explicit" as const, threadId: p.thread_id }
    : { threadAttribution: "unknown" as const };
  return Object.freeze({
    ...attribution,
    ...(typeof row.ordinal === "number" && Number.isSafeInteger(row.ordinal) && row.ordinal >= 0 ? { ordinal: row.ordinal } : {}),
    ...(rolloutId(p.turn_id) ? { turnId: p.turn_id } : {}),
    outcome: p.type === "task_complete" ? "completed" : "aborted",
    ...(p.type === "task_complete" && typeof p.last_agent_message === "string" ? { reply: p.last_agent_message } : {}),
  });
}

/** What one rollout file says so far. */
export interface Rollout {
  file: string;
  /** Thread id, from the file name. */
  thread: string;
  cwd?: string;
  /** When the thread started (session_meta), in ms. */
  startedAt?: number;
  /** "cli" for a TUI, "exec", "vscode", or "subagent" for a spawned agent's own thread. */
  source?: string;
  parent?: string;
  nickname?: string;
  role?: string;
  agentPath?: string;
  /** The current turn's model (turn_context). */
  model?: string;
  /** The user's messages, each with the final message of the turn that answered it. */
  exchanges: Exchange[];
  lastReply?: string;
  /** The last turn's state: running until task_complete or turn_aborted. */
  turn?: "running" | "review";
  /** Lifecycle events for an older turn must not end a newer resumed turn. */
  turnId?: string;
  /** How many turns have started (task_started). */
  turns: number;
  /** Unanswered tool calls by call id; true when the call needs the user's approval (an escalated command or a patch). */
  pending: Map<string, boolean>;
  /** Codex counts cached input inside input; here input excludes it, so the four add up as for Claude. */
  tokens: Tokens;
  models: Record<string, Tokens>;
  /** The thread's running total at the last token_count, as Codex wrote it (input excluding cached, as above). */
  lastTotal?: Tokens;
  contextWindow?: number;
  /** Time of the last token count, in ms. */
  at?: number;
  rateLimits?: unknown;
  /** Spawned agents by thread id: path or task, started | interacted | completed, nickname. */
  agents: Map<string, { path?: string; kind: string; updated: number; nickname?: string }>;
  /** Tool calls so far, and the last one or the last line of text. */
  steps: number;
  doing: string;
  /** The last turn ended with a final answer. */
  done: boolean;
}

const ROLLOUT_SAMPLE = 1024;
const rollouts = new Map<string, {
  identity: string; offset: number; modified: bigint; changed: bigint;
  head: Buffer; end: Buffer; fragments: Buffer[]; state: Rollout;
}>();
const rolloutIdentity = (st: fs.BigIntStats) => `${st.dev}:${st.ino}:${st.birthtimeNs}`;

function readRolloutRange(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const count = fs.readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, count);
}

function applyRolloutBytes(state: Rollout, fragments: Buffer[], bytes: Buffer) {
  let start = 0;
  for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
    let record = bytes.subarray(start, end);
    start = end + 1;
    if (fragments.length) {
      fragments.push(record);
      record = Buffer.concat(fragments);
      fragments.length = 0;
    }
    const line = record.toString("utf8");
    if (!line.trim()) continue;
    try { apply(state, JSON.parse(line)); } catch { /* a damaged line is skipped */ }
  }
  // Keep only unfinished bytes, without pinning the overlap or completed records. Join the pieces once, at the newline.
  if (start < bytes.length) fragments.push(Buffer.from(bytes.subarray(start)));
}

const usageOf = (u: any): Tokens | undefined => {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  const input = n(u?.input_tokens), cached = n(u?.cached_input_tokens) ?? 0, write = n(u?.cache_write_input_tokens) ?? 0, output = n(u?.output_tokens);
  return input === undefined || output === undefined ? undefined : { input: Math.max(0, input - cached), cacheRead: cached, cacheWrite: write, output };
};

function apply(s: Rollout, r: any) {
  const p = r?.payload, at = Date.parse(r?.timestamp) || Date.now();
  if (!p || typeof p !== "object") return;
  if (r.type === "session_meta") {
    // A spawned agent's rollout repeats its parent's session_meta after its own (seen 29 Oct 2026); only the file's own thread describes it.
    if (typeof p.id === "string" && p.id !== s.thread) return;
    if (typeof p.cwd === "string") s.cwd = p.cwd;
    if (typeof p.timestamp === "string") s.startedAt = Date.parse(p.timestamp) || undefined;
    const spawn = p.source?.subagent?.thread_spawn;
    if (typeof p.source === "string") s.source = p.source;
    else if (spawn) Object.assign(s, { source: "subagent", parent: spawn.parent_thread_id, nickname: spawn.agent_nickname ?? undefined, role: spawn.agent_role ?? undefined, agentPath: spawn.agent_path ?? undefined });
    else if (p.source && typeof p.source === "object") s.source = Object.keys(p.source)[0];
  } else if (r.type === "turn_context") {
    if (typeof p.model === "string") s.model = p.model;
  } else if (r.type === "event_msg") {
    if (p.type === "task_started") { s.turn = "running"; s.turnId = p.turn_id; s.turns++; s.done = false; s.pending.clear(); }
    else if (p.type === "task_complete") {
      if (p.turn_id && s.turnId && p.turn_id !== s.turnId) return;
      s.turn = "review"; s.done = true; s.pending.clear();
      if (typeof p.last_agent_message === "string") { s.lastReply = p.last_agent_message; const last = s.exchanges.at(-1); if (last) last.reply = p.last_agent_message.trim().slice(0, REPLY_CAP); }
    }
    else if (p.type === "turn_aborted") {
      if (p.turn_id && s.turnId && p.turn_id !== s.turnId) return;
      s.turn = "review"; s.done = false; s.pending.clear();
    }
    else if (p.type === "token_count") {
      // Codex often writes the same token_count 2-4 times with no response between (measured: one rollout's last_token_usage summed to
      // 2,901,427 against its own final total of 1,915,232). So the thread's running total decides: each event adds what the total grew by,
      // and a repeat adds nothing. A total that went down means Codex restarted its counters, so that total is all new. Without a total, last.
      const total = usageOf(p.info?.total_token_usage), last = usageOf(p.info?.last_token_usage), prev = s.lastTotal;
      let grew = last;
      if (total) {
        const keys = Object.keys(total) as Array<keyof Tokens>;
        grew = prev && keys.every((k) => total[k] >= prev[k]) ? Object.fromEntries(keys.map((k) => [k, total[k] - prev[k]])) as unknown as Tokens : total;
        s.lastTotal = total;
      }
      if (grew) { add(s.tokens, grew); const m = s.model ?? "unknown"; add((s.models[m] ??= zero()), grew); }
      if (typeof p.info?.model_context_window === "number") s.contextWindow = p.info.model_context_window;
      if (p.rate_limits && typeof p.rate_limits === "object") s.rateLimits = p.rate_limits;
      s.at = at;
    } else if (p.type === "item_completed") {
      const item = p.item;
      if (item?.type === "UserMessage") {
        const text = (Array.isArray(item.content) ? item.content : []).filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n");
        if (text.trim()) s.exchanges.push({ text });
      } else if (item?.type === "AgentMessage") {
        const text = (Array.isArray(item.content) ? item.content : []).find((c: any) => typeof c?.text === "string")?.text;
        if (text?.trim()) s.doing = firstLine(text);
      } else if (item?.type === "SubAgentActivity" && typeof item.agent_thread_id === "string") {
        s.agents.set(item.agent_thread_id, { ...s.agents.get(item.agent_thread_id), path: typeof item.agent_path === "string" ? item.agent_path : undefined, kind: String(item.kind ?? ""), updated: at });
      } else if (item?.type === "CollabAgentToolCall" && Array.isArray(item.receiver_agents)) {
        // codex-cli 0.163 records spawn_agent / wait calls this way; agents_states holds "pending_init", "running" or {completed: "…"} per agent.
        for (const a of item.receiver_agents) {
          if (typeof a?.thread_id !== "string") continue;
          const state = item.agents_states?.[a.thread_id];
          const kind = state === "pending_init" ? "started" : state === "running" || state === undefined ? "interacted" : "completed";
          const prev = s.agents.get(a.thread_id);
          s.agents.set(a.thread_id, { path: prev?.path ?? (typeof item.prompt === "string" ? firstLine(item.prompt) : undefined), kind, updated: at, nickname: typeof a.agent_nickname === "string" ? a.agent_nickname : prev?.nickname });
        }
      }
    }
  } else if (r.type === "response_item") {
    if ((p.type === "custom_tool_call" || p.type === "function_call") && typeof p.call_id === "string") {
      const input = typeof p.input === "string" ? p.input : typeof p.arguments === "string" ? p.arguments : "";
      s.steps++;
      s.doing = firstLine(`${p.name ?? "tool"} ${input}`);
      s.pending.set(p.call_id, p.name === "apply_patch" || input.includes("require_escalated"));
    } else if (p.type === "custom_tool_call_output" || p.type === "function_call_output") s.pending.delete(p.call_id);
  }
}

/** The rollout's state, updated from complete JSONL records. Unchanged polls read no file contents. */
export function readRollout(file: string): Rollout | undefined {
  let c = rollouts.get(file);
  let fd: number | undefined;
  try {
    const seen = fs.statSync(file, { bigint: true });
    if (c && c.offset === Number(seen.size) && c.modified === seen.mtimeNs && c.changed === seen.ctimeNs && c.identity === rolloutIdentity(seen)) return c.state;
    fd = fs.openSync(file, "r");
    const st = fs.fstatSync(fd, { bigint: true }), identity = rolloutIdentity(st), size = Number(st.size);
    if (c && (c.identity !== identity || size <= c.offset)) c = undefined;
    // Rollouts normally append. Verify both ends of the consumed prefix on growth, including at a complete line.
    // An in-place rewrite confined to the unsampled middle would require rereading that middle or a writer generation ID.
    if (c && c.offset > c.end.length && !readRolloutRange(fd, 0, c.head.length).equals(c.head)) c = undefined;
    const position = c ? c.offset - c.end.length : 0;
    let bytes = readRolloutRange(fd, position, size - position);
    if (c && !bytes.subarray(0, c.end.length).equals(c.end)) {
      c = undefined;
      if (position) bytes = readRolloutRange(fd, 0, size);
    }
    if (!c) {
      c = { identity, offset: 0, modified: st.mtimeNs, changed: st.ctimeNs, head: Buffer.alloc(0), end: Buffer.alloc(0), fragments: [],
        state: { file, thread: path.basename(file, ".jsonl").slice(-36), exchanges: [], turns: 0, pending: new Map(), tokens: zero(), models: {}, agents: new Map(), steps: 0, doing: "starting", done: false } };
      rollouts.set(file, c);
    }
    const appended = bytes.subarray(c.end.length);
    applyRolloutBytes(c.state, c.fragments, appended);
    if (c.offset === c.end.length) c.head = Buffer.from(bytes.subarray(0, ROLLOUT_SAMPLE));
    c.end = Buffer.from(bytes.subarray(-ROLLOUT_SAMPLE));
    c.offset += appended.length;
    c.modified = st.mtimeNs;
    c.changed = st.ctimeNs;
    return c.state;
  } catch { rollouts.delete(file); return undefined; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** A found session's card status from its rollout: Needs input while an escalated command or a patch waits for the user. */
export const rolloutStatus = (r: Rollout): Status | undefined =>
  r.turn === "running" ? ([...r.pending.values()].some(Boolean) ? "needs-input" : "running") : r.turn;

/** Every day folder under sessions, newest first. */
function dayFolders(): string[] {
  const list = (dir: string) => { try { return fs.readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort().reverse(); } catch { return []; } };
  return list(SESSIONS).flatMap((y) => list(path.join(SESSIONS, y)).flatMap((m) => list(path.join(SESSIONS, y, m)).map((d) => path.join(SESSIONS, y, m, d))));
}
const rolloutFiles = (day: string) => { try { return fs.readdirSync(day).filter((n) => n.startsWith("rollout-") && n.endsWith(".jsonl")); } catch { return []; } };

const located = new Map<string, { file?: string; at: number }>();
/** The rollout file of a thread, found by its id in the file name. A miss is retried after 10 s. */
export function rolloutFor(thread: string): string | undefined {
  const hit = located.get(thread);
  if (hit && (hit.file || Date.now() - hit.at < 10_000)) return hit.file;
  let file: string | undefined;
  for (const day of dayFolders()) {
    const name = rolloutFiles(day).find((n) => n.endsWith(`-${thread}.jsonl`));
    if (name) { file = path.join(day, name); break; }
  }
  located.set(thread, { file, at: Date.now() });
  return file;
}

function firstRolloutMeta(file: string) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(1 << 18);
  let length: number;
  try { length = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
  const newline = buf.subarray(0, length).indexOf(10);
  try {
    const record = JSON.parse(buf.toString("utf8", 0, newline < 0 ? length : newline));
    return record?.type === "session_meta" ? record.payload : undefined;
  } catch { return undefined; }
}

/**
 * The Codex build that ran a thread: its rollout's first record (session_meta) carries cli_version and originator ("entomatical",
 * "codex_vscode", ...), seen in Codex 0.169 rollouts on 16 November 2026. Unknown, with the reason, when that cannot be read.
 */
export function codexHarness(thread: string): { version?: string; entrypoint?: string; unknown?: string } {
  const file = rolloutFor(thread);
  if (!file) return { unknown: `codex: no rollout file for thread ${thread} in ${SESSIONS} (archived threads are compressed in archived_sessions, which is not read)` };
  let p: any;
  try { p = firstRolloutMeta(file); } catch (e) { return { unknown: `codex: rollout unreadable: ${e instanceof Error ? e.message : String(e)}` }; }
  if (typeof p?.cli_version !== "string") return { unknown: `codex: the rollout's first record has no session_meta cli_version (${file})` };
  return { version: p.cli_version, entrypoint: typeof p.originator === "string" ? p.originator : typeof p.source === "string" ? p.source : undefined };
}

const NO_CACHE_WRITES ="Codex reports no cache writes (its cache_write_input_tokens has been 0 in every turn seen); reasoning tokens are counted inside output.";

let savedUsageAt = 0;
/** The rollout's latest rate limits refresh the Codex account's usage file, as Claude's status line does for its accounts. */
function saveRolloutUsage(r: Rollout) {
  if (!r.rateLimits || !r.at || r.at <= savedUsageAt) return;
  savedUsageAt = r.at;
  if ((readUsage(CODEX_DIR)?.at ?? 0) >= r.at) return;
  try {
    fs.mkdirSync(USAGE_DIR, { recursive: true });
    writeFileAtomic(path.join(USAGE_DIR, `${usageKey(CODEX_DIR)}.json`), JSON.stringify(parseCodexUsage(r.rateLimits, r.at)));
  } catch { /* limits without a known window, or an unwritable folder: Refresh still works */ }
}

/** Token measurement of a Codex thread and the agents it spawned, from their rollout files. */
export function codexMeasurement(file: string | undefined): Measurement {
  const m: Measurement = { tokens: zero(), complete: false, source: "unknown", models: {}, gaps: [], diagnostics: [] };
  const r = file ? readRollout(file) : undefined;
  if (!r) { m.gaps.push(file ? `Codex's session file could not be read: ${file}` : "Codex names its session file at the first turn; nothing to measure yet."); return m; }
  saveRolloutUsage(r);
  const threads = [r, ...[...r.agents.keys()].map((id) => { const f = rolloutFor(id); return f ? readRollout(f) : undefined; })];
  for (const t of threads) {
    if (!t) { m.gaps.push("A spawned agent's session file was not found; its tokens are missing."); continue; }
    for (const [model, tokens] of Object.entries(t.models)) add((m.models[model] ??= zero()), tokens);
    add(m.tokens, t.tokens);
    if (t.at) m.at = Math.max(m.at ?? 0, t.at);
  }
  if (!m.at) { m.gaps.push("No finished model response yet."); return m; }
  m.source = "stream";
  m.total = m.tokens.input + m.tokens.cacheRead + m.tokens.cacheWrite + m.tokens.output;
  m.gaps.push(NO_CACHE_WRITES);
  if (threads.some((t) => t?.turn === "running")) m.gaps.push("A turn is still running; its tokens are added as each response ends.");
  m.complete = m.gaps.length === 1;
  return m;
}

/** The agents a Codex thread spawned (SubAgentActivity items), each described from its own rollout when that exists. */
export function codexSubagents(file: string): Subagent[] {
  const r = readRollout(file);
  if (!r) return [];
  return [...r.agents].map(([id, a]) => {
    const childFile = rolloutFor(id), child = childFile ? readRollout(childFile) : undefined;
    let updated = a.updated;
    try { if (childFile) updated = Math.max(updated, fs.statSync(childFile).mtimeMs); } catch { /* keep the parent's time */ }
    return { id, type: child?.nickname || a.nickname || child?.role || "agent", description: a.path ?? child?.agentPath ?? "", done: a.kind === "completed" || (!!child?.done && child.turn !== "running"),
      steps: child?.steps ?? 0, doing: child?.doing ?? (a.kind === "started" ? "starting" : a.kind), updated, model: child?.model, lifecycle: "transcript" as const };
  });
}

// Found Linux TUIs. An open writable rollout identifies its writer independently of cwd and timestamps.
export interface CodexProcess { pid: number; cwd: string; startTicks?: string; rollouts?: string[] }

const readText = (file: string) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };
const startTicks = (dir: string, pid = path.basename(dir)) => {
  const stat = readText(path.join(dir, "stat"));
  if (!stat.startsWith(pid + " (codex) ")) return undefined;
  const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; // /proc stat field 22
  return /^\d+$/.test(ticks ?? "") ? ticks : undefined;
};

function writableRollouts(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const fds = path.join(dir, "fd");
  for (const fd of fs.readdirSync(fds)) {
    let file: string;
    try { file = fs.readlinkSync(path.join(fds, fd)); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // closed during enumeration
      throw err;
    }
    if (!path.isAbsolute(file) || !inside(SESSIONS, file) || !/^rollout-.*\.jsonl$/.test(path.basename(file))) continue;
    const info = readText(path.join(dir, "fdinfo", fd));
    const flags = /^flags:\s*([0-7]+)$/m.exec(info);
    if (!flags) throw new Error("Unreadable rollout descriptor");
    const mode = parseInt(flags[1], 8) & 3;
    if (mode !== fs.constants.O_WRONLY && mode !== fs.constants.O_RDWR) continue;
    // A descriptor number or pathname can be reused during the scan. Match the open file to the named file.
    const st = fs.statSync(file, { bigint: true });
    if (!st.isFile() || st.ino.toString() !== /^ino:\s*(\d+)$/m.exec(info)?.[1] || fs.readlinkSync(path.join(fds, fd)) !== file)
      throw new Error("Rollout descriptor changed");
    files.set(file, fd);
  }
  return files;
}

/** Read only process evidence from this repo's Codex TUIs. An incomplete snapshot has no actionable identity. */
export function codexProcesses(repo?: string, procDir = "/proc", exactCwd = false): CodexProcess[] {
  if (process.platform !== "linux") return [];
  let pids: string[];
  try { pids = fs.readdirSync(procDir).filter((n) => /^[1-9]\d*$/.test(n)); } catch { return []; }
  const out: CodexProcess[] = [];
  for (const pid of pids) {
    const dir = path.join(procDir, pid);
    if (readText(path.join(dir, "comm")).trim() !== "codex") continue;
    const ticks = startTicks(dir);
    const args = readText(path.join(dir, "cmdline")).split("\0");
    if (!args[0] || args.includes("app-server") || args[1] === "exec" || args[1] === "review") continue;
    let cwd: string;
    try { cwd = fs.readlinkSync(path.join(dir, "cwd")); } catch { continue; }
    if (repo && (exactCwd ? path.relative(repo, cwd) !== "" : !inRepo(repo, cwd))) continue;
    let rollouts: string[] | undefined;
    try { if (ticks) rollouts = [...writableRollouts(dir).keys()]; } catch { /* incomplete evidence */ }
    out.push({ pid: Number(pid), cwd, startTicks: ticks === startTicks(dir) ? ticks : undefined, rollouts });
  }
  return out;
}

export function liveCodexSessions(repo: string, account?: string, processes = codexProcesses(repo), unresolved?: Set<string>): LiveSession[] {
  const local = processes.filter((p) => inRepo(repo, p.cwd));
  // Count every writer, including a TUI holding several rollouts. Even two different files can name the same thread.
  const claims = new Map<string, number>();
  const incomplete = new Set(local.filter(p => !p.startTicks || !p.rollouts).map(p => path.resolve(p.cwd)));
  for (const p of local) for (const file of p.rollouts ?? []) {
    const thread = path.basename(file, ".jsonl").slice(-36);
    claims.set(thread, (claims.get(thread) ?? 0) + 1);
  }
  const out: LiveSession[] = [];
  for (const p of local) {
    const file = p.rollouts?.length === 1 ? p.rollouts[0] : undefined;
    let r: Rollout | undefined;
    try {
      if (file && !incomplete.has(path.resolve(p.cwd))) {
        const meta = firstRolloutMeta(file);
        if (meta?.source === "cli" && typeof meta.cwd === "string" && path.isAbsolute(meta.cwd) && path.relative(p.cwd, meta.cwd) === "" &&
            meta.id === path.basename(file, ".jsonl").slice(-36) && claims.get(meta.id) === 1) r = readRollout(file);
      }
    } catch { /* rollout disappeared during discovery */ }
    if (!r) {
      unresolved?.add(p.cwd);
      continue;
    }
    out.push({ pid: p.pid, processStart: p.startTicks, sessionId: r.thread, cwd: p.cwd, configDir: CODEX_DIR, account, provider: "codex", cardStatus: rolloutStatus(r) ?? "review", transcript: file });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

// FD 3 is the verified process, inherited across spawn. Recheck the writer after the helper starts, immediately before signalling.
const signalCodexWriter = `
import os, signal, sys
numeric, ticks, cwd, rollout, writer = sys.argv[1:]
proc = "/proc/self/fd/3"
with open(proc + "/stat") as f:
    stat = f.read()
with open(proc + "/fdinfo/" + writer) as f:
    flags = next(int(line.split()[1], 8) for line in f if line.startswith("flags:"))
if not (os.path.samefile(proc, numeric) and stat.startswith(os.path.basename(numeric) + " (codex) ")
        and stat.rsplit(") ", 1)[1].split()[19] == ticks and os.readlink(proc + "/cwd") == cwd
        and (flags & os.O_ACCMODE) in (os.O_WRONLY, os.O_RDWR) and os.path.samefile(proc + "/fd/" + writer, rollout)):
    sys.exit(1)
signal.pidfd_send_signal(3, signal.SIGTERM)
`;

/** Signal the process through the same open /proc/<pid> directory used to verify its identity (pidfd_send_signal(2)).
 * A reused PID cannot redirect the signal. Node has no pidfd signal API; absence of Python's binding leaves Stop unavailable. */
export function stopCodexWriter(live: LiveSession, procDir = "/proc"): boolean {
  if (process.platform !== "linux" || live.provider !== "codex" || !live.processStart || !live.transcript ||
      !Number.isSafeInteger(live.pid) || live.pid <= 0 || live.pid === process.pid) return false;
  let fd: number | undefined;
  try {
    const numeric = path.join(procDir, String(live.pid));
    fd = fs.openSync(numeric, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    const pinned = `/proc/self/fd/${fd}`;
    // Check competing claims in this folder without opening any other thread's transcript.
    for (const peer of codexProcesses(live.cwd, procDir, true)) {
      if (peer.pid !== live.pid && (!peer.startTicks || !peer.rollouts ||
          peer.rollouts.some(file => path.basename(file, ".jsonl").slice(-36) === live.sessionId))) return false;
    }
    const meta = firstRolloutMeta(live.transcript);
    if (meta?.id !== live.sessionId || meta.source !== "cli" || typeof meta.cwd !== "string" || path.relative(live.cwd, meta.cwd) !== "") return false;
    const writers = writableRollouts(pinned), writer = writers.get(live.transcript);
    if (writers.size !== 1 || !writer || startTicks(pinned, String(live.pid)) !== live.processStart) return false;
    return spawnSync("/usr/bin/python3", ["-I", "-S", "-c", signalCodexWriter, numeric, live.processStart, live.cwd, live.transcript, writer],
      { stdio: ["ignore", "ignore", "ignore", fd], timeout: 2000 }).status === 0;
  } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
