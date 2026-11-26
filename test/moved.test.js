// F118: a board's saved paths follow its folder when the workspace folder is renamed or moved (src/moved.ts).
// The case that started it: the workspace folder, named after the product's earlier name, became "Dev Stuff/Entomatical" on
// 17 November 2026 and 54 cards kept the old folder.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { rerootBoardPath, rerootTasks } = require("../out/moved.js");

const win = process.platform === "win32";
// The earlier names, spelled in two parts: tools/rename-identifiers.js would turn them into today's, and the old and the new
// folder of these cases would become one (test/product-name.test.js keeps the earlier name out of every tracked file).
const OLD_NAME = ["Agent", "Board"].join(""), OLD_BOARD = "." + OLD_NAME.toLowerCase();
// The same shapes on either machine: a drive path on Windows, a home path on Linux.
const root = win ? "C:\\Users\\r\\Dev Stuff" : "/home/r/Dev Stuff";
const oldRepo = path.join(root, OLD_NAME), repo = path.join(root, "Entomatical");
const board = path.join(repo, ".entomatical"), oldBoard = path.join(oldRepo, ".entomatical");

test("a path in the old folder's board moves into this board; the rest of it is kept", () => {
  assert.equal(rerootBoardPath(path.join(oldBoard, "wt", "974566"), board), path.join(board, "wt", "974566"));
  assert.equal(rerootBoardPath(path.join(oldBoard, "checks", "f9d926", "1793596875402", "check-3.log"), board), path.join(board, "checks", "f9d926", "1793596875402", "check-3.log"));
  assert.equal(rerootBoardPath(path.join(oldBoard, "reviews", "f2b1fd", "r.md"), board), path.join(board, "reviews", "f2b1fd", "r.md"));
  // A folder moved to another parent, not only renamed.
  assert.equal(rerootBoardPath(path.join(path.dirname(root), "elsewhere", "x", ".entomatical", "wt", "a"), board), path.join(board, "wt", "a"));
});

test("a path that is right already comes back unchanged to the byte, so a second pass corrects nothing", () => {
  const right = path.join(board, "wt", "974566");
  assert.equal(rerootBoardPath(right, board), right);
  const once = rerootBoardPath(path.join(oldBoard, "wt", "a"), board);
  assert.equal(rerootBoardPath(once, board), once);
  if (win) {
    // Windows names one folder in several ways (VS Code hands the board "c:\...", tasks.json holds "C:\..."): none is a correction.
    for (const p of ["c:\\users\\r\\dev stuff\\entomatical\\.Entomatical\\wt\\a", "C:/Users/r/Dev Stuff/Entomatical/.entomatical/wt/a"]) assert.equal(rerootBoardPath(p, board), p);
    assert.equal(rerootBoardPath("C:\\Users\\r\\Dev Stuff\\Entomatical\\.entomatical\\wt\\a", "c:\\Users\\r\\Dev Stuff\\Entomatical\\.entomatical"), "C:\\Users\\r\\Dev Stuff\\Entomatical\\.entomatical\\wt\\a");
  }
});

test("paths outside any board folder, relative paths and other values are left alone", () => {
  const keep = [
    path.join(oldRepo, "docs", "plan.md"), // in the old repository, but not in its board folder: nothing says where it went
    oldRepo,
    oldBoard, // a board folder itself, with nothing under it
    path.join(oldRepo, ".entomatical-speech", "events", "a.jsonl"), // another folder: the name must be a whole segment
    path.join(root, ".claude", "projects", `c--Users-r-Dev-Stuff-${OLD_NAME}--entomatical-wt-a`, "s.jsonl"),
    path.join("helpers", "x", "receipt.json"),
    "",
  ];
  for (const p of keep) assert.equal(rerootBoardPath(p, board), p);
  assert.equal(rerootBoardPath(undefined, board), undefined);
});

test("a board inside another board's folder is matched at its own depth", () => {
  // A test repository under .entomatical/tmp, or a worktree's own board.
  const inner = path.join(board, "tmp", "t-1", "repo"), innerBoard = path.join(inner, ".entomatical");
  const own = path.join(innerBoard, "wt", "a");
  assert.equal(rerootBoardPath(own, innerBoard), own);
  // The outer board's folder is not the inner board's: a path with only that one segment stays.
  const outer = path.join(board, "wt", "b");
  assert.equal(rerootBoardPath(outer, innerBoard), outer);
  // The outer folder was renamed: the inner board's paths follow it.
  assert.equal(rerootBoardPath(path.join(oldBoard, "tmp", "t-1", "repo", ".entomatical", "wt", "a"), innerBoard), own);
  // And the outer board still moves a path that runs through an inner board.
  assert.equal(rerootBoardPath(path.join(oldBoard, "wt", "a", ".entomatical", "events", "e.jsonl"), board), path.join(board, "wt", "a", ".entomatical", "events", "e.jsonl"));
});

test("a board folder that was itself renamed: paths under an earlier name move when that name is given", () => {
  // The real case: the board folder had the earlier name until the identifier rename of 18 November 2026.
  assert.notEqual(OLD_BOARD, path.basename(board)); // the two names differ, or every line below would pass with nothing moved
  const under = path.join(repo, OLD_BOARD, "wt", "a"); // saved while the folder had its earlier name
  assert.equal(rerootBoardPath(under, board), under); // not asked for: left alone
  assert.equal(rerootBoardPath(under, board, [OLD_BOARD]), path.join(board, "wt", "a"));
  // The workspace folder and the board folder were both renamed.
  assert.equal(rerootBoardPath(path.join(oldRepo, OLD_BOARD, "checks", "a", "1"), board, [OLD_BOARD]), path.join(board, "checks", "a", "1"));
  const right = path.join(board, "wt", "a");
  assert.equal(rerootBoardPath(right, board, [OLD_BOARD]), right);
  const tasks = [{ id: "a", worktree: under }];
  assert.equal(rerootTasks(tasks, board, [OLD_BOARD]), 1);
  assert.equal(tasks[0].worktree, right);
  assert.equal(rerootTasks(tasks, board, [OLD_BOARD]), 0);
});

test("rerootTasks corrects a card's worktree, check run, failure log and review paths, counts them, and touches nothing else", () => {
  const transcript = path.join(root, ".claude", "projects", "c--old", "s.jsonl");
  const tasks = [
    { id: "a", prompt: `Read ${path.join(oldRepo, "docs", "x.md")}`, worktree: path.join(oldBoard, "wt", "a"), ranIn: path.join(oldBoard, "wt", "a"), transcript,
      checks: { status: "error", run: path.join(oldBoard, "checks", "a", "1"), failure: { command: "npm test", exitCode: 1, lines: [], tail: path.join(oldBoard, "x"), log: path.join(oldBoard, "checks", "a", "1", "check-1.log") } },
      doneReview: { file: path.join(oldBoard, "reviews", "a", "r.md"), receipt: path.join(oldBoard, "helpers", "u", "review-receipt.json") } },
    { id: "b", worktree: path.join(board, "wt", "b"), checks: { status: "complete", run: path.join(board, "checks", "b", "2") } },
    { id: "c" },
  ];
  const before = JSON.parse(JSON.stringify(tasks));
  assert.equal(rerootTasks(tasks, board), 5);
  assert.equal(tasks[0].worktree, path.join(board, "wt", "a"));
  assert.equal(tasks[0].checks.run, path.join(board, "checks", "a", "1"));
  assert.equal(tasks[0].checks.failure.log, path.join(board, "checks", "a", "1", "check-1.log"));
  assert.equal(tasks[0].doneReview.file, path.join(board, "reviews", "a", "r.md"));
  assert.equal(tasks[0].doneReview.receipt, path.join(board, "helpers", "u", "review-receipt.json"));
  // Records of what happened stay as written: the prompt, the failure's tail, the transcript, and ranIn (Grok and Antigravity file usage under the folder's name at the time).
  assert.equal(tasks[0].prompt, before[0].prompt);
  assert.equal(tasks[0].checks.failure.tail, before[0].checks.failure.tail);
  assert.equal(tasks[0].transcript, transcript);
  assert.equal(tasks[0].ranIn, before[0].ranIn);
  assert.deepEqual(tasks.slice(1), before.slice(1));
  assert.equal(rerootTasks(tasks, board), 0);
});
