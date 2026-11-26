// Delivers a card's work to the main checkout without finishing the card (the user, 15 November 2026: every third turn, and at the
// end). No VS Code imports, so test/deliver.test.js runs it against throwaway repos. Built from Finish's steps in finish.ts.
import * as fs from "fs";
import * as path from "path";
import { git } from "./git";
import { MergeConflict, assertTaskCheckout, checkedOut, commitStaged, fallbackMessage, gitOperationUnderWay, integrate, landedIn, overlapWith, planFinish, secretLike, stagedFiles } from "./finish";

export type Delivery =
  | { delivered: string; committed: number; files: number; skipped?: string[] }
  | { nothing: true; skipped?: string[] }
  | { refused: string; files?: string[]; skipped?: string[] };

/**
 * A checkout's identity: its real path, lower-cased on Windows, where one folder is spelled both c:\… and C:\… . A folder that is gone
 * is named by its resolved path. The board records it with each delivery (deliverNow), and the tests count deliveries by it:
 * deliveries are one at a time per checkout, and two boards on two checkouts deliver at the same time (19 November 2026, M-05).
 */
export function checkoutId(dir: string): string {
  let real = path.resolve(dir);
  try { real = fs.realpathSync.native(real); } catch { /* gone: the resolved path names it */ }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

const lines = (text: string) => (text ? text.split("\n") : []);
const first = (e: unknown) => (e as Error).message.split("\n").filter((l) => l.trim()).slice(0, 4).join(" ");

/**
 * Commits what is uncommitted in the card's worktree, merges the main checkout's current branch into the task branch there (local
 * branch only), then fast-forwards the main checkout to the task branch. Never pushes, fetches, removes the worktree or branch, or
 * stashes, resets, commits or discards anything in the main checkout. An expected refusal is returned, not thrown.
 * Git-ignored files are not delivered: git add -A leaves them out. Secret-like files (secretLike) are never committed; they stay
 * uncommitted in the worktree and are listed as skipped, as Finish never commits them either.
 * The commit made here stays on the task branch whatever happens later, so a refusal after it loses nothing.
 */
export async function deliver(repo: string, worktree: string, branch: string, title: string, turn?: number): Promise<Delivery> {
  if (!checkedOut(worktree)) return { refused: "The card's worktree folder is gone or is not a git checkout, so there is nothing to deliver." };
  if (await gitOperationUnderWay(repo, true)) {
    return { refused: "The main checkout has a merge, rebase, cherry-pick or revert under way; finish or abort it there first." };
  }
  let plan;
  try {
    plan = { ...(await planFinish(repo, worktree, branch)), remote: undefined, remoteBranch: undefined }; // local target only
    await assertTaskCheckout(worktree, branch, false);
  }
  catch (e) { return { refused: first(e) }; } // the main checkout is not on a branch, or the branch is gone

  let committed = 0, skipped: string[] = [];
  if (plan.dirty.length) {
    try {
      // stageAll refuses secrets outright; Deliver commits the rest and leaves them out.
      const unmerged = lines(await git(worktree, ["diff", "--name-only", "--diff-filter=U"]));
      if (unmerged.length) throw new Error(`The worktree has unresolved merge conflicts in ${unmerged.join(", ")}.`);
      await git(worktree, ["add", "-A"]);
      skipped = secretLike(await stagedFiles(worktree));
      if (skipped.length) await git(worktree, ["reset", "-q", "--", ...skipped.map((f) => `:(literal)${f}`)]);
      const staged = await stagedFiles(worktree);
      // A skipped file still staged would be committed while the board says it was left out.
      if (secretLike(staged).length) throw new Error(`Could not unstage ${secretLike(staged).join(", ")}, so nothing was delivered.`);
      committed = staged.length;
      if (committed) {
        await assertTaskCheckout(worktree, branch, false);
        await commitStaged(worktree, fallbackMessage(title) + (turn === undefined ? "" : ` (turn ${turn})`));
      }
    } catch (e) { return { refused: first(e), ...(skipped.length ? { skipped } : {}) }; }
  }
  const also = skipped.length ? { skipped } : {};

  if (!committed && await landedIn(repo, branch, plan)) return { nothing: true, ...also };
  try { await integrate(worktree, branch, plan); }
  catch (e) {
    if (e instanceof MergeConflict) return { refused: `Merging ${plan.target} into ${branch} conflicts, so nothing was delivered; resolve it in the worktree.`, files: e.files, ...also };
    return { refused: first(e), ...also };
  }

  const { overlap } = await overlapWith(repo, "", branch, plan.target);
  if (overlap.length) return { refused: `The main checkout has uncommitted changes to files this card changed, so nothing was delivered.`, files: overlap, ...also };
  const before = await git(repo, ["rev-parse", "HEAD"]);
  try {
    await assertTaskCheckout(worktree, branch, false);
    if (await git(repo, ["symbolic-ref", "--quiet", "HEAD"]) !== `refs/heads/${plan.target}`)
      return { refused: `The main checkout moved off ${plan.target}.`, ...also };
    await git(repo, ["merge", "--ff-only", "-q", branch]);
  }
  catch (e) { return { refused: `Git would not fast-forward the main checkout: ${first(e)}`, ...also }; }
  const files = lines(await git(repo, ["diff", "--name-only", before, "HEAD"])).length;
  return { delivered: await git(repo, ["rev-parse", "--short", "HEAD"]), committed, files, ...also };
}

/**
 * Whether a card's work is delivered now, and the turn count it keeps (the user, 15 November 2026). `every` is
 * entomatical.deliver.everyTurns (0: never; only Finish delivers). "turn": the card's main session finished a turn; "review": it reached
 * Review some other way. Delivering resets the count whatever the result.
 */
export function deliveryDue(every: number, turns: number, event: "turn" | "review"): { deliver: boolean; turns: number } {
  if (!(every > 0)) return { deliver: false, turns: 0 };
  const n = turns + (event === "turn" ? 1 : 0);
  return event === "review" || n >= every ? { deliver: true, turns: 0 } : { deliver: false, turns: n };
}
