import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, execFileSync } from "child_process";
import { writeFileAtomic } from "./sessions";

export interface Receipt {
  status: "running" | "complete" | "error";
  pid?: number; heartbeat?: number; error?: string;
  checksPassed?: boolean;
  commands?: string[];
  bootTime?: number;
  failure?: CheckFailure;
  revision?: string;
  ruleId?: string;
  phase?: "task" | "delivery";
  at?: string;
}

/** The acceptance check that failed: its command and exit code, the log lines that name the failure, the end of its output, its log. */
export interface CheckFailure { command: string; exitCode: number | null; lines: string[]; tail: string; log: string }

export const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8"));
export const saveJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(value, null, 2));
  const fd = fs.openSync(file, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};

/**
 * The repository's tracked files, cached for 30 seconds per repository and bounded by a 10-second timeout: every Refine, Improve and
 * Review used to run git ls-files synchronously on the extension host (F59-8 in session 3482f4's review). Throws when git cannot list.
 */
const tracked = new Map<string, { at: number; files?: string[]; error?: Error }>();
export function trackedFiles(repo: string): string[] {
  const hit = tracked.get(repo);
  // A failure is cached for the same 30 seconds, so a folder git cannot list does not run it on every call (item 5, second review).
  if (hit && Date.now() - hit.at < 30_000) { if (hit.error) throw hit.error; return hit.files!; }
  try {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 10_000 })
      .split("\0").filter(Boolean);
    tracked.set(repo, { at: Date.now(), files });
    return files;
  } catch (e) { const error = e instanceof Error ? e : new Error(String(e)); tracked.set(repo, { at: Date.now(), error }); throw error; }
}
/** Tracked files and package.json script names, for the advisory prompt lint (src/prompt-lint.ts). Undefined when git cannot list. */
export function projectInventory(repo: string): { files: string[]; scripts: string[] } | undefined {
  try {
    let scripts: string[] = [];
    try { scripts = Object.keys(readJson<any>(path.join(repo, "package.json")).scripts || {}); } catch { /* not every project uses Node */ }
    return { files: trackedFiles(repo), scripts };
  } catch { return undefined; }
}

export function projectContext(repo: string) {
  const context: Record<string, unknown> = {};
  try {
    const files = trackedFiles(repo);
    const extensions: Record<string, number> = {};
    for (const file of files) { const ext = path.extname(file) || "[no extension]"; extensions[ext] = (extensions[ext] || 0) + 1; }
    context.trackedFiles = files.length; context.fileTypes = extensions;
    context.rootEntries = files.filter(f => !f.includes("/")).slice(0, 80);
  } catch { context.repositoryInventory = "unavailable"; }
  try {
    const pkg = readJson<any>(path.join(repo, "package.json"));
    context.package = { name: pkg.name, scripts: pkg.scripts, dependencies: Object.keys(pkg.dependencies || {}), devDependencies: Object.keys(pkg.devDependencies || {}) };
  } catch { /* not every project uses Node */ }
  return context;
}

/** Runs a job file (acceptance checks) in a detached worker that writes receipt.json beside it. */
export function startWorker(input: string, env: Record<string, string> = {}) {
  const dir = path.dirname(input);
  // Parent and child write different files: a fast completion cannot be overwritten by its launch record.
  const child = spawn(process.execPath, [path.join(__dirname, "worker.js"), input], {
    cwd: dir, detached: true, stdio: "ignore", windowsHide: true,
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" }, // env: the card's temporary folder in the workspace (workspace.ts)
  });
  saveJson(path.join(dir, "launch.json"), { status: "running", pid: child.pid, heartbeat: Date.now(), bootTime: Date.now() - os.uptime() * 1000 });
  child.once("error", e => saveJson(path.join(dir, "receipt.json"), { status: "error", error: e.message }));
  child.unref();
}

export function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
