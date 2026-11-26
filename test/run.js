// Runs `node --test` with a temporary folder of its own and deletes it afterwards. The tests make about fifty folders a run
// (prompt comparisons, panels, voice, webviews); isolate their artifacts so cleanup covers interrupted tests.
// Since 13 November 2026 that folder is inside the workspace (the user: worktrees and temporary folders stay in the active workspace):
// under <main checkout>/.entomatical/tmp (src/workspace.ts), whose marker file stops git, tools/board.js and safe-temp from climbing
// into the repository above. A card's session already has its own folder there as TMP; outside a repository the system temp folder
// is used as before.
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { tempRoot, TEMP_MARKER } = require("../out/workspace.js");

/** The temp root at or above dir, when dir is inside one. */
function rootAbove(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, TEMP_MARKER))) return d;
    if (path.dirname(d) === d) return undefined;
  }
}
/** The main checkout of the repository the tests run in (a worktree's too), or undefined outside git. */
function mainCheckout() {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return path.dirname(common);
  } catch { return undefined; }
}

const inherited = rootAbove(os.tmpdir());
const repo = inherited ? undefined : mainCheckout();
const real = (p) => fs.realpathSync(p);
// TMPDIR inside the repository with no marker above it (a card's folder in a checkout tools/cutover-entomatical.js has not moved yet,
// whose marker still has the old name): the run's own folder becomes the root, so nothing is made beside the old data folder.
const own = !inherited && repo !== undefined && !path.relative(real(repo), real(os.tmpdir())).startsWith("..");
let root = inherited ?? (repo && !own ? tempRoot(repo) : undefined);
// Short names: fixtures nest worktrees several levels deep, and Windows paths stop at 260 characters.
const base = inherited || own ? os.tmpdir() : root ?? os.tmpdir();
fs.mkdirSync(base, { recursive: true });
const { assertSafeTemp } = require("./safe-temp");
if (!own) try { assertSafeTemp(base); } catch (error) { console.error(error.message); process.exit(1); }
const lockRoot = root ?? (repo && tempRoot(repo));
const temp = fs.mkdtempSync(path.join(base, root || own ? "t-" : "entomatical-test-"));
if (own) {
  fs.writeFileSync(path.join(temp, TEMP_MARKER), "This test run's temporary folder. Searches for a git repository or a board stop here.\n");
  root = temp;
  try { assertSafeTemp(temp); } catch (error) { console.error(error.message); fs.rmSync(temp, { recursive: true, force: true }); process.exit(1); }
}
const env = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp, ...(root ? { GIT_CEILING_DIRECTORIES: root } : {}) };
// rm-retry.js: a test folder still held for a moment by a background git is deleted once that git ends (see the file).
env.ENTOMATICAL_TEST_LOCK = lockRoot ? path.join(lockRoot, "full-test.lock") : "";
// shares.js: a selected test file that has share files (test/finish.test.js) runs as several processes at once. It is loaded
// after full-test-lock.js, which settles the selection first.
env.ENTOMATICAL_TEST_SHARES = "ask";
const preload = ["full-test-lock.js", "shares.js", "rm-retry.js"].flatMap((name) => ["--require", path.join(__dirname, name)]);
const run = spawnSync(process.execPath, [...preload, "--test", ...process.argv.slice(2)], { stdio: "inherit", env });
try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
catch (error) { console.error(`Could not delete the test folder ${temp}: ${error.message}`); }
process.exit(run.status ?? 1);
