// F118: a board's saved paths after its workspace folder was renamed or moved.
//
// tasks.json keeps a few absolute paths into the board's own folder (<repo>/.entomatical): a card's worktree, its check run and
// that run's failure log, and its review's file and receipt. Rename or move the workspace folder and they still name the old one.
// On 17 November 2026, after the workspace folder took the name "Entomatical" on disk, 54 cards pointed at the old folder: Finish made that
// folder again to check a branch out, then refused to delete "a worktree of another repo". The board corrects these paths
// whenever it reads or writes its list (src/board.ts), so nothing has to be edited by hand.
import * as path from "path";

const win = () => process.platform === "win32";
const segments = (p: string) => p.split(win() ? /[\\/]+/ : /\/+/);
const same = (a: string, b: string) => (win() ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * `saved`, moved into `boardDir` when it lies in the board folder of another place; otherwise `saved` itself, unchanged to the
 * byte (so a path that is right already, in any letter case Windows accepts, is never counted as corrected).
 *
 * The board folder is found by its name as a whole path segment (".entomatical-speech" is another folder). A board can sit inside
 * another board's folder (a test repository under .entomatical/tmp, a worktree's own board), so the segment that counts is the one
 * as deep as this board's: the second such segment for a board that is itself inside one.
 *
 * `earlier`: names the board folder had before, for a board folder that was itself renamed; a path under one of them moves too.
 */
export function rerootBoardPath(saved: string, boardDir: string, earlier: string[] = []): string {
  if (typeof saved !== "string" || !path.isAbsolute(saved)) return saved;
  const home = segments(path.resolve(boardDir)), names = [home[home.length - 1], ...earlier];
  const board = (s: string) => names.some((n) => same(s, n));
  const depth = home.filter(board).length;
  const parts = segments(saved);
  let at = -1;
  for (let i = 0, seen = 0; i < parts.length; i++) if (board(parts[i]) && ++seen === depth) { at = i; break; }
  if (at < 0 || at === parts.length - 1) return saved; // in no board folder, or a board folder itself
  if (at + 1 === home.length && home.every((s, i) => same(s, parts[i]))) return saved; // this board's already
  return path.join(path.resolve(boardDir), ...parts.slice(at + 1));
}

/** The card fields that hold a path into the board's folder. `ranIn` is not one: Grok and Antigravity file their usage under the folder as it was named then. */
interface Movable { worktree?: string; checks?: { run?: string; failure?: { log?: string } }; doneReview?: { file?: string; receipt?: string } }

/** Corrects those fields in place for every card; the number of paths it changed (0 on a second pass). `earlier` as in rerootBoardPath. */
export function rerootTasks(tasks: Movable[], boardDir: string, earlier: string[] = []): number {
  let changed = 0;
  const fix = <T, K extends keyof T>(holder: T | undefined, key: K) => {
    const was = holder?.[key];
    if (!holder || typeof was !== "string") return;
    const now = rerootBoardPath(was, boardDir, earlier);
    if (now !== was) { (holder[key] as unknown as string) = now; changed++; }
  };
  for (const t of tasks) {
    if (!t || typeof t !== "object") continue;
    fix(t, "worktree");
    fix(t.checks, "run");
    fix(t.checks?.failure, "log");
    fix(t.doneReview, "file");
    fix(t.doneReview, "receipt");
  }
  return changed;
}
