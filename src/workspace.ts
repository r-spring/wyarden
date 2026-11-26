// Where Entomatical may run and where its files go (the user, 13 November 2026): worktrees and temporary folders live inside the active
// workspace, never in the system temp folder or at a drive root. Entomatical runs only in a window with a saved workspace file, a folder
// open, and that folder a git repository's top folder. Everything it makes goes under <folder>/.entomatical: worktrees in wt/, temporary
// folders in tmp/. Plain Node (no vscode import), so tests, tools/board.js and test/run.js use the same rules.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** A file in <folder>/.entomatical/tmp marking it as the top of Entomatical's temporary folders. Upward searches stop there. */
export const TEMP_MARKER = "ENTOMATICAL-TEMP-ROOT";

export interface WorkspaceCheck {
  /** The board's folder: the workspace's first folder, when every requirement is met. */
  repo?: string;
  /** What is missing, in the order to fix it. Empty when repo is set. */
  missing: string[];
}

/**
 * workspaceFile: the window's workspace file (vscode.workspace.workspaceFile), scheme "untitled" before it is saved.
 * folders: the workspace's folders. toplevel: git's top folder for a folder, undefined outside git.
 */
export function checkWorkspace(workspaceFile: { scheme: string; fsPath: string } | undefined, folders: string[], toplevel: (dir: string) => string | undefined): WorkspaceCheck {
  const missing: string[] = [];
  if (workspaceFile?.scheme !== "file") missing.push("Save this window as a workspace: File → Save Workspace As… (a .code-workspace file).");
  const folder = folders[0];
  if (!folder) missing.push("Add the project folder: File → Add Folder to Workspace….");
  else {
    const top = toplevel(folder);
    if (!top) missing.push(`Make ${folder} a git repository: run git init in it.`);
    else if (!samePath(top, folder)) missing.push(`Open the repository's top folder (${top}), not ${folder}: worktrees and temporary folders go inside the open folder.`);
  }
  return missing.length ? { missing } : { repo: path.resolve(folder!), missing };
}

const samePath = (a: string, b: string) => {
  const real = (p: string) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const norm = (p: string) => (process.platform === "linux" ? real(p) : real(p).toLowerCase());
  return norm(a) === norm(b);
};

/** <repo>/.entomatical/tmp, made with its marker when missing. */
export function tempRoot(repo: string): string {
  const root = path.join(repo, ".entomatical", "tmp");
  const marker = path.join(root, TEMP_MARKER);
  if (!fs.existsSync(marker)) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(marker, "Entomatical's temporary folders for this workspace. Searches for a git repository or a board stop here.\n");
  }
  return root;
}

/** The data folder's name before 18 November 2026, in two parts so tools/rename-identifiers.js has nothing to rename here. */
const OLD_DATA = "." + ["agent", "board"].join("");
/**
 * The first old data folder in `dirs` (the home folder, the workspace folder) with no .entomatical beside it: tools/cutover-entomatical.js
 * has not moved it yet, and a board started now would be empty. Undefined when there is none.
 */
export function unmovedDataFolder(dirs: string[]): string | undefined {
  return dirs.map((d) => path.join(d, OLD_DATA)).find((old) => fs.existsSync(old) && !fs.existsSync(path.join(path.dirname(old), ".entomatical")));
}

/** True when dir holds the temporary-folder marker: an upward search for a repository or a board stops at it. */
export const isTempRoot = (dir: string) => fs.existsSync(path.join(dir, TEMP_MARKER));

let home: string | undefined;
/** The active board's folder, for temporary folders made outside a Board (speech). */
export const setWorkspaceRepo = (repo: string | undefined) => void (home = repo);
export const workspaceRepo = () => home;

/** A new folder for one job: under the workspace's .entomatical/tmp, or the system temp folder only when no board is open. */
export function makeTemp(prefix: string, repo = home): string {
  const base = repo ? path.join(tempRoot(repo), prefix.replace(/-$/, "")) : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix.endsWith("-") ? prefix : `${prefix}-`));
}

/** Environment for a process working under the workspace's temp root: its temp folder, and git kept from climbing into the repository. */
export function tempEnv(dir: string, root: string): Record<string, string> {
  return { TMP: dir, TEMP: dir, TMPDIR: dir, GIT_CEILING_DIRECTORIES: root };
}