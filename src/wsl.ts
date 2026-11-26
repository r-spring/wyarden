// Codex inside WSL, for a Windows machine whose Codex extension runs there (chatgpt.runCodexInWindowsSubsystemForLinux). the user,
// 1 November 2026: "Codex has to run in WSL", so Entomatical starts the same WSL `codex` and reads the same WSL ~/.codex as the extension.
// Pure helpers, no vscode: the text worker (worker.ts) uses them too.

/** A text job's codexPath that means "Codex in this WSL distro": `wsl:Ubuntu`. */
export const WSL_PREFIX = "wsl:";

/** A WSL distro that runs Codex. Set only on Windows. */
export interface CodexWsl { distro: string }

/** Codex's home folder per distro, as a Windows path (set by codex.ts useCodexWsl), so a helper can check its AGENTS.md (worker.ts). */
const codexHomes = new Map<string, string>();
export const rememberCodexHome = (distro: string, home: string) => { codexHomes.set(distro, home); };
export const codexHomeIn = (distro: string) => codexHomes.get(distro);

/** A Windows path as WSL sees it: C:\a b\c -> /mnt/c/a b/c; \\wsl.localhost\<distro>\home\x -> /home/x. Other paths are kept. */
export function toWsl(p: string, distro?: string): string {
  const unc = /^\\\\(?:\?\\UNC\\)?(?:wsl\$|wsl\.localhost)\\([^\\]+)(\\.*)?$/i.exec(p);
  if (unc) {
    if (distro && unc[1].toLowerCase() !== distro.toLowerCase()) throw new Error(`Path belongs to WSL distro ${unc[1]}, but Codex runs in ${distro}.`);
    return (unc[2] ?? "\\").replace(/\\/g, "/");
  }
  const drive = /^(?:\\\\\?\\)?([a-zA-Z]):[\\/]?(.*)$/.exec(p);
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`.replace(/\/$/, "") || "/";
  return p;
}

/** A WSL path as Windows sees it: /mnt/c/a/b -> C:\a\b; /home/x -> \\wsl.localhost\<distro>\home\x. */
export function fromWsl(p: string, distro: string): string {
  const drive = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(p);
  if (drive) return `${drive[1].toUpperCase()}:\\${(drive[2] ?? "").replace(/\//g, "\\")}`;
  return p.startsWith("/") ? `\\\\wsl.localhost\\${distro}${p.replace(/\//g, "\\")}` : p;
}

/**
 * Memory limits for Codex in WSL (8 November 2026: one Codex session's runaway test filled the whole 24 GB VM, and the out-of-memory
 * kill then took WSL down; the WSL process-scope contract). Each Codex runs in its own systemd user scope inside
 * entomatical-codex.slice: one session gets at most CODEX_SESSION_MEMORY of the VM, all of them together CODEX_SLICE_MEMORY.
 * OOMPolicy=continue: when a command Codex ran is killed for memory, Codex itself keeps running and sees the failed command.
 * Without it the user manager's default (stop) ends the whole session (checked 8 November 2026).
 */
export const CODEX_SLICE = "entomatical-codex.slice";
export const CODEX_SESSION_MEMORY = "33%";
export const CODEX_SLICE_MEMORY = "85%";
export const CODEX_SESSION_SWAP = "2G";

/** The login-shell script that starts Codex: in a capped scope when the distro's systemd user manager is running, else directly. */
export const WSL_CODEX_SCRIPT = [
  `if [ -S "\${XDG_RUNTIME_DIR:-/nonexistent}/systemd/private" ] && command -v systemd-run >/dev/null 2>&1; then`,
  `systemctl --user set-property --runtime ${CODEX_SLICE} MemoryMax=${CODEX_SLICE_MEMORY} >/dev/null 2>&1;`,
  `exec systemd-run --user --scope --quiet --collect --slice=${CODEX_SLICE} -p MemoryMax=${CODEX_SESSION_MEMORY}`,
  `-p MemorySwapMax=${CODEX_SESSION_SWAP} -p OOMPolicy=continue -- codex "$@"; fi; exec codex "$@"`,
].join(" ");

/**
 * Runs `codex <args>` in the distro: the `codex` on its login PATH (bash -l reads ~/.profile), in `cwd` (a Windows path; wsl.exe
 * converts it), under the memory limits above. Checked 1 November 2026 through wsl.exe: arguments with spaces, quotes, newlines, `$`,
 * backslashes and an empty one arrive unchanged, and taskkill /T on wsl.exe ends the Linux process too (rechecked with the scope,
 * 8 November 2026: systemd-run --scope execs Codex in place, so it stays wsl.exe's child).
 */
export function wslCommand(wsl: CodexWsl, args: string[], cwd?: string): { file: string; args: string[] } {
  if (cwd) toWsl(cwd, wsl.distro); // validate the distro before wsl.exe interprets the Windows path
  return { file: "wsl.exe", args: ["-d", wsl.distro, ...(cwd ? ["--cd", cwd] : []), "--exec", "/bin/bash", "-lc", WSL_CODEX_SCRIPT, "codex", ...args] };
}

/**
 * The environment for wsl.exe: the named variables cross into WSL, `paths` each a path that wsl.exe converts (WSLENV's /p flag),
 * `plain` as they are (an id such as ENTOMATICAL_TASK; a /p flag on a non-path is left alone by wsl.exe, but plain is honest).
 */
export function wslEnv(env: NodeJS.ProcessEnv, paths: string[], plain: string[] = []): NodeJS.ProcessEnv {
  const names = [...paths, ...plain];
  const have = (env.WSLENV ?? "").split(":").filter(Boolean).filter((v) => !names.includes(v.split("/")[0]));
  return { ...env, WSLENV: [...have, ...paths.filter((n) => env[n] !== undefined).map((n) => `${n}/p`), ...plain.filter((n) => env[n] !== undefined)].join(":") };
}
