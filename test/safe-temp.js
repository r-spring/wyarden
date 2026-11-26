// Test fixtures create boards and worktrees. Never place them beneath a real repository or board.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// A repository is a folder holding .git; a board is one holding .entomatical/tasks.json, which is what tools/board.js looks for
// above the folder it runs in. An .entomatical folder without tasks.json is not a board: the home folder has one (the files the
// extension places), and counting it refused every temp folder under the user profile, the default one on Windows included
// (12 November 2026: cards had been told to set TMP to a folder at the drive root to get past that).
const MARKERS = [".git", path.join(".entomatical", "tasks.json")];
const TEMP_MARKER = "ENTOMATICAL-TEMP-ROOT";

/** The nearest folder at or above `temp` that is a repository or a board, or undefined when there is none. */
function unsafeAncestor(temp) {
  const starts = new Set([path.resolve(temp), fs.realpathSync(temp)]);
  for (const start of starts) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (MARKERS.some((name) => fs.existsSync(path.join(dir, name)))) return dir;
      // A workspace's .entomatical/tmp (src/workspace.ts): git, tools/board.js and the board's own searches all stop here, so fixtures
      // made below it never reach the repository or board above (the user, 13 November 2026: temp folders stay inside the workspace).
      if (fs.existsSync(path.join(dir, TEMP_MARKER))) break;
      if (path.dirname(dir) === dir) break;
    }
  }
  return undefined;
}

function assertSafeTemp(temp = os.tmpdir()) {
  const dir = unsafeAncestor(temp);
  if (dir) throw new Error(`Unsafe temporary directory: ${temp} is inside ${dir}. Set TMPDIR, TMP or TEMP to a directory outside repositories and boards.`);
}

module.exports = { assertSafeTemp, unsafeAncestor };
if (require.main === module) {
  try { assertSafeTemp(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
