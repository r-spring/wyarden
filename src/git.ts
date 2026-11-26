// Git operations for task worktrees. No VS Code imports, so test/git.test.js can run them against a throwaway repo.
import { execFile, execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

const run = promisify(execFile);

/**
 * Runs git and returns trimmed stdout; a failure throws an Error carrying git's own output (merge conflicts print to stdout, most errors to stderr).
 * GIT_OPTIONAL_LOCKS=0: a status or diff must never take index.lock in a worktree where an agent may be running its own git command.
 */
export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    return (await run("git", args, { cwd, windowsHide: true, maxBuffer: 1 << 26, env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: "0" } })).stdout.trim();
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    const said = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim();
    throw new Error(said || err.message);
  }
}

/** The task's work so far: everything in the worktree, committed or not, against where the branch left the repo. */
export async function changes(repo: string, worktree: string, branch: string): Promise<{ diff: string; untracked: string[] }> {
  const base = await git(repo, ["merge-base", "HEAD", branch]);
  const diff = await git(worktree, ["diff", base]);
  const status = await git(worktree, ["status", "--porcelain", "--untracked-files=all"]);
  const untracked = status.split("\n").filter((l) => l.startsWith("?? ")).map((l) => l.slice(3));
  return { diff, untracked };
}

/** Nothing uncommitted, untracked files included. */
export async function isClean(cwd: string): Promise<boolean> {
  return (await git(cwd, ["status", "--porcelain"])) === "";
}

/** How many commits merging `branch` would bring into the repo's current branch that `branch` shares with `other` (a subtask's parent branch); 0 when they share none. */
export async function sharedCommits(repo: string, branch: string, other: string): Promise<number> {
  const base = await git(repo, ["merge-base", branch, other]).catch(() => ""); // no common commit, or a branch already gone
  return base ? Number(await git(repo, ["rev-list", "--count", `HEAD..${base}`])) : 0;
}

/** Merges the task branch into the repo's current branch. Refuses uncommitted changes to tracked files (untracked ones are safe: git will not overwrite one); a conflict is aborted, leaving the repo as it was. */
export async function mergeTask(repo: string, branch: string, beforeMerge?: () => void): Promise<void> {
  if (await git(repo, ["status", "--porcelain", "--untracked-files=no"])) throw new Error("The repo has uncommitted changes. Commit or stash them, then merge.");
  beforeMerge?.();
  try {
    await git(repo, ["merge", "--no-ff", "--no-edit", branch]);
  } catch (e) {
    await git(repo, ["merge", "--abort"]).catch(() => undefined);
    const said = (e as Error).message.split("\n").slice(0, 6).join("\n");
    throw new Error(`Merge failed: ${said}\nThe repo is unchanged; resolve it in a terminal or ask Claude.`);
  }
}

/**
 * Makes a task's worktree at `worktree` on `branch`: a new branch from `base`, or the existing branch checked out. A checkout that
 * fails is undone (the branch this call made, and the folder it filled), so the next Start is not refused with "a branch named …
 * already exists". Seen 30 Oct 2026 in sample-project: three paths passed Windows' 260-character limit inside .entomatical\wt,
 * git stopped partway, and 0.7.3 kept the branch and a half-filled folder with no .git link, so every later Start failed.
 * Returns a warning for the user when the worktree was made but git reported an error after the checkout (a failing hook).
 */
export async function addWorktree(repo: string, worktree: string, branch: string, base: string): Promise<string | undefined> {
  const here = (w: { folder: string }) => !path.relative(w.folder, worktree); // not ===: Windows paths ignore case
  // A checkout cut off before git could clean up (VS Code killed mid-Start): git keeps it listed, locked, its folder partly filled.
  // Any lock, not the literal "locked initializing": git translates that reason. Nothing else locks a folder under .entomatical/wt.
  const unfinished = locked((await worktrees(repo)).find(here)?.lines ?? []);
  // An earlier start's leftover (not a worktree, or git would have listed it; or one git never finished): it may hold files, so it is the user's to delete.
  if (fs.existsSync(worktree) && (unfinished || fs.readdirSync(worktree).length)) {
    throw new Error(`${worktree} is left over from a start that failed partway and is not a git worktree. Check it holds nothing you need, delete it, and Start again.`);
  }
  if (unfinished) await git(repo, ["worktree", "remove", "-f", "-f", worktree]); // its folder is gone; git drops a locked entry only when told twice
  const made = !(await git(repo, ["branch", "--list", branch]));
  try {
    await git(repo, made ? ["worktree", "add", "-b", branch, worktree, base] : ["worktree", "add", worktree, branch]);
  } catch (e) {
    // Without git's progress line, so its reason comes first: a notification shows the first line, and Finish's error read only
    // "Preparing worktree (checking out 'task/94a532')" while the reason was the line under it (17 November 2026).
    const said = (e as Error).message.split("\n").filter((l) => !/^Preparing worktree \(/.test(l)).join("\n") || (e as Error).message;
    const first = said.split("\n").slice(0, 3).join("\n");
    // A failing post-checkout hook (git-lfs missing, husky) fails the command after a complete checkout. A checkout that really
    // failed is not listed: git removes its own entry then.
    // Listed and unlocked is not enough: git can leave an entry for a folder it never filled. A whole checkout has its .git link and
    // matches HEAD (a reset cut short leaves no index).
    const listed = (await worktrees(repo).catch(() => [])).find(here);
    if (listed && listed.lines.includes(`branch refs/heads/${branch}`) && !locked(listed.lines) && fs.existsSync(path.join(worktree, ".git"))
      && await git(worktree, ["diff", "--quiet", "HEAD"]).then(() => true, () => false)) {
      // The hook's own reason is git's last output; its first lines are the checkout's progress.
      return `The task's worktree was made, but git reported an error after checking it out (a hook, perhaps):\n\n${said.split("\n").filter((l) => l.trim()).slice(-3).join("\n")}`;
    }
    await git(repo, ["worktree", "remove", "--force", worktree]).catch(() => undefined); // registered or not, depending on where git stopped
    // Retried as in discardWorktree: on Windows a virus scanner or the indexer can hold a file just written for a moment.
    const left = await fs.promises.rm(worktree, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
      .then(() => "", () => `\n\nEntomatical could not delete ${worktree}; delete it before the next Start.`);
    if (made) await git(repo, ["branch", "-D", branch]).catch(() => undefined);
    if (!/file ?name too long/i.test(said)) throw new Error(said + left);
    const longPathsOff = process.platform === "win32" && (await git(repo, ["config", "--type=bool", "--get", "core.longpaths"]).catch(() => "")) !== "true"; // unset: git exits 1
    throw new Error((longPathsOff
      ? `Git could not check out the task's worktree: some of the repo's paths pass Windows' 260-character limit inside ${path.dirname(worktree)}. Turn on git's long paths with "git config --global core.longpaths true", then Start again.\n\n${first}`
      : `Git could not check out the task's worktree: a path in the repo is too long for this file system.\n\n${first}`) + left);
  }
  linkModules(repo, worktree);
  return undefined;
}

/**
 * Best effort: a new worktree of a Node project shares the main checkout's node_modules through a link (a junction on Windows, which
 * needs no admin rights), so a task can build and typecheck at once. Without it, sessions hit TS2307 for node-pty and @xterm/headless
 * and improvised junctions by hand (failed tool calls report, 4-6 Nov 2026). Only when the checkout has one and the worktree has none.
 * `npm ci` run through the link empties the main checkout's packages, so hook/agent-fence.js refuses it there (15 Nov 2026).
 */
export function linkModules(repo: string, worktree: string): boolean {
  const target = path.join(path.resolve(repo), "node_modules"), link = path.join(worktree, "node_modules");
  try {
    // An empty node_modules (npm never ran there) is no use to link; npm writes .package-lock.json when it installs.
    if (!fs.existsSync(path.join(worktree, "package.json")) || !fs.existsSync(path.join(target, ".package-lock.json")) || fs.existsSync(link)) return false;
    // A repo's "node_modules/" ignores a folder, not a link to one: without this, status and Finish's add -A see the link (Linux, 6 Nov 2026).
    const exclude = path.resolve(worktree, execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: worktree, windowsHide: true, encoding: "utf8" }).trim());
    const listed = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (!/^\/?node_modules$/m.test(listed)) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.appendFileSync(exclude, `${listed && !listed.endsWith("\n") ? "\n" : ""}/node_modules\n`);
    }
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false; // a worktree without it still works; npm ci fills it
  }
}

/** Removes the node_modules link itself, never what it points at, before a worktree folder is deleted. */
export function unlinkModules(worktree: string): void {
  const link = path.join(worktree, "node_modules");
  try {
    if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  } catch {
    // none, or a real folder the task installed: the folder's own delete handles it
  }
}

/** The repo's worktrees as `git worktree list --porcelain` lists them: each folder (resolved: git prints C:/... on Windows) with its lines. */
export async function worktrees(repo: string): Promise<{ folder: string; lines: string[] }[]> {
  return (await git(repo, ["worktree", "list", "--porcelain"])).split(/\r?\n\r?\n/).map((b) => b.split(/\r?\n/))
    .flatMap((lines) => lines[0].startsWith("worktree ") ? [{ folder: path.resolve(lines[0].slice("worktree ".length)), lines }] : []);
}

/** Locked: git is still checking it out or was cut off partway (`locked initializing`), or the user locked it. Entomatical never locks one. */
export const locked = (lines: string[]) => lines.some((l) => l === "locked" || l.startsWith("locked "));

/** `folder` is under <repo>/.entomatical/wt (or the retired speech edition's .entomatical-speech/wt), the only places Entomatical makes worktrees. */
export function inWorktreeRoot(repo: string, folder: string, dirs = [".entomatical", ".entomatical-speech"]): boolean {
  return dirs.some((d) => {
    const relative = path.relative(path.join(path.resolve(repo), d, "wt"), path.resolve(folder));
    return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

/** Removes a task's worktree folder and branch. Only folders under <repo>\.entomatical\wt are ever removed. */
export async function discardWorktree(repo: string, worktree: string, branch: string, legacySpeech = false): Promise<void> {
  if (!inWorktreeRoot(repo, worktree, [legacySpeech ? ".entomatical-speech" : ".entomatical"])) throw new Error(`${worktree} is not a task worktree of this repo.`);
  // May fail: already gone, locked or in use. The steps below finish the job or throw. No global prune: it would also drop the user's
  // own worktrees on a drive that is not mounted; remove --force already clears this folder's entry when the folder is missing.
  // The shared node_modules link goes first, so no delete below can reach through it into the main checkout's packages.
  unlinkModules(path.resolve(worktree));
  await git(repo, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
  if (await git(repo, ["branch", "--list", branch])) await git(repo, ["branch", "-D", branch]); // already deleted is fine; a branch git will not delete (locked worktree) throws
  // What git left behind; a folder still in use throws. On Windows a session just stopped can hold its working folder for a moment
  // (31 Oct 2026: Stop, then "Delete card and worktree", failed with EPERM), so a busy folder is retried for about 4 s, without blocking.
  await fs.promises.rm(path.resolve(worktree), { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
}
