// Worktrees and temporary folders stay inside the active workspace (the user, 13 November 2026), and Entomatical runs only with a saved
// workspace file, a folder open, and that folder a git repository's top folder (src/workspace.ts).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { checkWorkspace, tempRoot, tempEnv, makeTemp, isTempRoot, TEMP_MARKER } = require("../out/workspace.js");
const { insideRepository } = require("../out/worker.js");
const { trustRoot } = require("../out/codex.js");

const made = [];
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const repo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  made.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return fs.realpathSync(dir);
};
const saved = (dir) => ({ scheme: "file", fsPath: path.join(dir, "project.code-workspace") });

test("the board runs only with a saved workspace file, a folder open, and that folder a git repository's top folder", () => {
  const dir = repo(), top = () => dir;
  assert.deepEqual(checkWorkspace(saved(dir), [dir], top), { repo: dir, missing: [] });
  // A folder opened on its own (no workspace file), or a workspace never saved (untitled).
  assert.match(checkWorkspace(undefined, [dir], top).missing.join(" "), /Save Workspace As/);
  assert.match(checkWorkspace({ scheme: "untitled", fsPath: "Untitled-1" }, [dir], top).missing.join(" "), /Save Workspace As/);
  assert.match(checkWorkspace(saved(dir), [], top).missing.join(" "), /Add Folder to Workspace/);
  assert.match(checkWorkspace(saved(dir), [dir], () => undefined).missing.join(" "), /run git init/);
  // A folder inside a repository, not its top folder: worktrees would land outside the open folder.
  const sub = path.join(dir, "sub");
  fs.mkdirSync(sub);
  assert.match(checkWorkspace(saved(dir), [sub], top).missing.join(" "), /top folder/);
  // All three missing are listed in the order to fix them, and no board folder is given.
  const none = checkWorkspace(undefined, [], top);
  assert.equal(none.repo, undefined);
  assert.equal(none.missing.length, 2);
});

test("temporary folders go under <repo>/.entomatical/tmp, where git and the board's searches stop", () => {
  const dir = repo();
  const root = tempRoot(dir);
  assert.equal(root, path.join(dir, ".entomatical", "tmp"));
  assert.ok(isTempRoot(root) && fs.existsSync(path.join(root, TEMP_MARKER)));
  const job = makeTemp("helpers", dir);
  assert.equal(path.dirname(path.dirname(job)), root);
  assert.deepEqual(tempEnv(job, root), { TMP: job, TEMP: job, TMPDIR: job, GIT_CEILING_DIRECTORIES: root });
  // git, with the ceiling, sees no repository there; the board's own searches agree.
  assert.throws(() => execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: job, stdio: "pipe", env: { ...process.env, GIT_CEILING_DIRECTORIES: root } }));
  assert.equal(insideRepository(job), false);
  assert.equal(trustRoot(job, false), undefined);
  // tools/board.js never takes the real board above for a folder below the temp root.
  fs.writeFileSync(path.join(dir, ".entomatical", "tasks.json"), "[]");
  const { findRepo } = require("../tools/board.js");
  assert.equal(findRepo(dir, {}), dir); // the real board is still found from its own folder
  assert.equal(findRepo(job, {}), undefined);
  fs.mkdirSync(path.join(job, ".entomatical")); fs.writeFileSync(path.join(job, ".entomatical", "tasks.json"), "[]");
  assert.equal(findRepo(job, {}), job); // a test board made there is its own
});

test("a home or workspace folder whose data folder still has the old name, and no .entomatical, is named so the board does not start empty", () => {
  const { unmovedDataFolder } = require("../out/workspace.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-")), ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  made.push(home, ws);
  const old = "." + ["agent", "board"].join(""); // two parts: tools/rename-identifiers.js
  assert.equal(unmovedDataFolder([home, ws]), undefined); // neither folder: a first start
  fs.mkdirSync(path.join(ws, old));
  assert.equal(unmovedDataFolder([home, ws]), path.join(ws, old));
  fs.mkdirSync(path.join(ws, ".entomatical"));
  assert.equal(unmovedDataFolder([home, ws]), undefined); // moved (or both present): the new one is used
  fs.mkdirSync(path.join(home, old));
  assert.equal(unmovedDataFolder([home, ws]), path.join(home, old));
});
