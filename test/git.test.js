const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const g = require("../out/git.js");

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const made = []; // every folder fixture() makes: each worktree, then its repo; removed when this file's tests are done
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

/** A throwaway repo with one commit, plus a worktree on branch task/t1 with one committed and one uncommitted change. */
function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-repo-"));
  const worktree = path.join(repo, ".entomatical", "wt", "t1");
  made.push(worktree, repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "t@t");
  sh(repo, "config", "user.name", "t");
  sh(repo, "config", "core.autocrlf", "false"); // Git for Windows defaults to true, which prints "LF will be replaced by CRLF" warnings
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  fs.writeFileSync(path.join(repo, ".entomatical", ".gitignore"), "*\n"); // as Board's constructor does; without it git reports .entomatical/ as untracked and the repo is never clean
  sh(repo, "worktree", "add", "-q", "-b", "task/t1", worktree, "HEAD");
  fs.writeFileSync(path.join(worktree, "a.txt"), "one\ntwo\n");
  sh(worktree, "commit", "-qam", "task change");
  fs.writeFileSync(path.join(worktree, "b.txt"), "new\n");
  return { repo, worktree, branch: "task/t1" };
}

test("changes: committed and uncommitted work against the branch point", async () => {
  const { repo, worktree, branch } = fixture();
  const c = await g.changes(repo, worktree, branch);
  assert.match(c.diff, /\+two/);
  assert.deepEqual(c.untracked, ["b.txt"]);
});

test("git: a failing command throws with git's message", async () => {
  const { repo } = fixture();
  await assert.rejects(g.git(repo, ["checkout", "no-such-branch"]), /no-such-branch/);
});

test("mergeTask merges a clean branch into a clean repo", async () => {
  const { repo, worktree, branch } = fixture();
  sh(worktree, "add", "b.txt");
  sh(worktree, "commit", "-qm", "add b");
  await g.mergeTask(repo, branch);
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "one\ntwo\n");
  assert.ok(fs.existsSync(path.join(repo, "b.txt")));
  assert.equal(await g.isClean(repo), true);
});

test("mergeTask refuses a dirty repo", async () => {
  const { repo, branch } = fixture();
  fs.writeFileSync(path.join(repo, "a.txt"), "edited\n");
  await assert.rejects(g.mergeTask(repo, branch), /uncommitted changes/);
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "edited\n");
});

test("mergeTask ignores untracked files in the repo, and git will not overwrite one", async () => {
  const { repo, worktree, branch } = fixture();
  sh(worktree, "add", "b.txt");
  sh(worktree, "commit", "-qm", "add b");
  fs.writeFileSync(path.join(repo, "b.txt"), "mine\n"); // untracked, where the merge would write
  await assert.rejects(g.mergeTask(repo, branch), /b\.txt/); // git's own words name the file in the way
  assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "mine\n");
  fs.renameSync(path.join(repo, "b.txt"), path.join(repo, "notes.txt")); // untracked, out of the way
  await g.mergeTask(repo, branch);
  assert.equal(fs.readFileSync(path.join(repo, "b.txt"), "utf8"), "new\n");
  assert.equal(fs.readFileSync(path.join(repo, "notes.txt"), "utf8"), "mine\n");
});

test("mergeTask aborts a conflict and leaves the repo clean", async () => {
  const { repo, branch } = fixture();
  fs.writeFileSync(path.join(repo, "a.txt"), "one\nthree\n");
  sh(repo, "commit", "-qam", "conflicting change on main");
  await assert.rejects(g.mergeTask(repo, branch), /Merge failed/);
  assert.equal(await g.isClean(repo), true);
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "one\nthree\n");
});

test("discardWorktree removes the worktree and branch, and refuses the repo itself", async () => {
  const { repo, worktree, branch } = fixture();
  await g.discardWorktree(repo, worktree, branch);
  assert.equal(fs.existsSync(worktree), false);
  assert.doesNotMatch(sh(repo, "branch", "--list"), /task\/t1/);
  await assert.rejects(g.discardWorktree(repo, repo, "main"), /not a task worktree/);
  assert.ok(fs.existsSync(path.join(repo, "a.txt")));
});

test("discardWorktree finishes when the folder and branch are already gone", async () => {
  const { repo, worktree, branch } = fixture();
  fs.rmSync(worktree, { recursive: true }); // deleted by hand: git still lists it and the branch is still there
  await g.discardWorktree(repo, worktree, branch);
  assert.doesNotMatch(sh(repo, "branch", "--list"), /task\/t1/);
  assert.doesNotMatch(sh(repo, "worktree", "list"), /wt\/t1/);
  await g.discardWorktree(repo, worktree, branch); // nothing left at all: still fine
});

test("discardWorktree throws, and leaves the folder, when git will not remove the worktree", async () => {
  const { repo, worktree, branch } = fixture();
  sh(repo, "worktree", "lock", worktree);
  await assert.rejects(g.discardWorktree(repo, worktree, branch), /task\/t1/);
  assert.ok(fs.existsSync(worktree));
  assert.match(sh(repo, "branch", "--list"), /task\/t1/);
});

test("discardWorktree throws while a program is using the folder, and finishes on a retry", { skip: process.platform !== "win32" && "only Windows refuses to delete a program's working folder" }, async () => {
  const { repo, worktree, branch } = fixture();
  const program = spawn(process.execPath, ["-e", "process.stdout.write('up'); setInterval(() => {}, 1000)"], { cwd: worktree, stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((r) => program.stdout.once("data", r)); // its working folder is set once it has spoken
  try {
    await assert.rejects(g.discardWorktree(repo, worktree, branch));
    assert.ok(fs.existsSync(worktree));
    assert.doesNotMatch(sh(repo, "branch", "--list"), /task\/t1/); // git let go of the worktree and branch: a merge cannot be redone, so Board.finish records it first
  } finally {
    program.kill();
    await new Promise((r) => program.once("exit", r));
  }
  await g.discardWorktree(repo, worktree, branch);
  assert.equal(fs.existsSync(worktree), false);
  assert.doesNotMatch(sh(repo, "branch", "--list"), /task\/t1/);
});

// Found 31 October 2026 in the Windows parity run (F15/F16): Stop, then "Delete card and worktree" about 2 s later, failed with
// "EPERM, Permission denied: '<worktree>'" because the stopped session's process had not let go of its working folder yet.
test("discardWorktree waits for a program that is leaving the folder, as a session just stopped does", { skip: process.platform !== "win32" && "only Windows refuses to delete a program's working folder" }, async () => {
  const { repo, worktree, branch } = fixture();
  const program = spawn(process.execPath, ["-e", "process.stdout.write('up'); setTimeout(() => {}, 1200)"], { cwd: worktree, stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((r) => program.stdout.once("data", r)); // its working folder is set once it has spoken; it leaves about 1.2 s later
  try {
    await g.discardWorktree(repo, worktree, branch);
  } finally {
    await new Promise((r) => (program.exitCode !== null ? r() : program.once("exit", r)));
  }
  assert.equal(fs.existsSync(worktree), false);
  assert.doesNotMatch(sh(repo, "branch", "--list"), /task\/t1/);
});

test("sharedCommits counts the parent commits a subtask's merge would bring in, and none once they are merged", async () => {
  const { repo, branch } = fixture(); // task/t1 has one commit that main lacks
  sh(repo, "branch", "child", branch);
  assert.equal(await g.sharedCommits(repo, "child", branch), 1);
  assert.equal(await g.sharedCommits(repo, "main", branch), 0); // branched from HEAD: nothing of the parent's
  sh(repo, "merge", "-q", "--no-ff", "--no-edit", branch);
  assert.equal(await g.sharedCommits(repo, "child", branch), 0); // the parent's work is in main already
  assert.equal(await g.sharedCommits(repo, "child", "no-such-branch"), 0);
});

/**
 * Commits a file no checkout can write, so a worktree of that commit fails partway: on Windows a path past 260 characters with git's
 * long paths off (the sample-project case, 30 Oct 2026), elsewhere a 300-character name (past the 255-byte limit). On Windows the
 * user's global git config is hidden until the test ends: Git 2.52 kept a global core.longpaths=true over the repo's own false.
 */
function unwritable(t, repo) {
  if (process.platform === "win32") {
    const empty = path.join(repo, ".entomatical", "empty.gitconfig");
    fs.writeFileSync(empty, "");
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = empty;
    t.after(() => { if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = before; });
  }
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "x\n", encoding: "utf8" }).trim();
  const name = process.platform === "win32" ? ["a", "b", "c"].map((c) => c.repeat(100)).join("/") : "n".repeat(300);
  sh(repo, "update-index", "--add", "--cacheinfo", `100644,${blob},deep/${name}.txt`);
  sh(repo, "commit", "-qm", "a name too long to check out");
  sh(repo, "branch", "bad");
}

test("addWorktree: a refused checkout's error starts with git's reason, not its 'Preparing worktree' progress line", async () => {
  // 17 November 2026: Finish's notification read only "Preparing worktree (checking out 'task/94a532')"; the reason was under it.
  const { repo, branch } = fixture();
  const again = path.join(repo, ".entomatical", "wt", "t1-again");
  made.unshift(again);
  await assert.rejects(g.addWorktree(repo, again, branch, "HEAD"), (e) => {
    assert.match(e.message.split("\n")[0], /^fatal: 'task\/t1' is already (used by worktree|checked out) at /);
    return true;
  });
  assert.equal(fs.existsSync(again), false);
});

test("addWorktree: a failed checkout is undone, so the next Start fails the same way and not on 'branch already exists'", async (t) => {
  const { repo } = fixture();
  unwritable(t, repo);
  const wt = path.join(repo, ".entomatical", "wt", "t9");
  for (let i = 0; i < 2; i++) {
    await assert.rejects(g.addWorktree(repo, wt, "task/t9", "bad"), (e) => /Git could not check out the task's worktree/.test(e.message) && !/already exists/.test(e.message)
      && (process.platform !== "win32" || /260-character limit.*git config --global core\.longpaths true/s.test(e.message)));
    assert.equal(sh(repo, "branch", "--list", "task/t9"), ""); // the branch this call made is gone
    assert.equal(fs.existsSync(wt), false); // and so is the folder it filled
    const listed = sh(repo, "worktree", "list", "--porcelain").split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => path.normalize(line.slice("worktree ".length)));
    assert.ok(!listed.includes(path.normalize(wt)), "the failed worktree is no longer listed");
  }
  // A branch that was there before is the user's: a failed checkout of it keeps it.
  sh(repo, "branch", "task/t7", "bad");
  await assert.rejects(g.addWorktree(repo, path.join(repo, ".entomatical", "wt", "t7"), "task/t7", "HEAD"), /could not check out/);
  assert.match(sh(repo, "branch", "--list", "task/t7"), /task\/t7/);
});

test("addWorktree: a folder it could not delete is named, and the user's own unmounted worktrees stay listed", async (t) => {
  const { repo } = fixture();
  const mine = `${repo}-mine`; // on a drive that is not mounted now
  made.push(mine);
  sh(repo, "worktree", "add", "-q", "-b", "mine", mine, "HEAD");
  fs.rmSync(mine, { recursive: true, force: true });
  unwritable(t, repo);
  const rm = fs.promises.rm;
  const tried = [];
  fs.promises.rm = async (p) => { tried.push(p); throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); }; // a virus scanner holds it past the retries
  t.after(() => { fs.promises.rm = rm; });
  const wt = path.join(repo, ".entomatical", "wt", "t5");
  await assert.rejects(g.addWorktree(repo, wt, "task/t5", "bad"), new RegExp(`could not delete ${wt.replace(/\\/g, "\\\\")}; delete it before the next Start`));
  assert.deepEqual(tried, [wt]); // Entomatical's own removal, which ext4 hides: git deletes the folder itself there
  assert.match(sh(repo, "worktree", "list", "--porcelain"), /branch refs\/heads\/mine/);
});

test("addWorktree: a git hook that fails after a complete checkout keeps the worktree and its branch, with a warning", async (t) => {
  const { repo } = fixture();
  // A hook that fails with a reason, as a missing git-lfs does. In a folder that may run programs: linux's /tmp is mounted noexec.
  const hooks = fs.mkdtempSync(path.join(require("./exec-tmpdir").execTmpdir(), "ab-hooks-"));
  t.after(() => fs.rmSync(hooks, { recursive: true, force: true }));
  fs.writeFileSync(path.join(hooks, "post-checkout"), "#!/bin/sh\necho 'git-lfs: command not found (post-checkout)' >&2\nexit 2\n", { mode: 0o755 });
  sh(repo, "config", "core.hooksPath", hooks);
  const wt = path.join(repo, ".entomatical", "wt", "t4");
  const warning = await g.addWorktree(repo, wt, "task/t4", "HEAD");
  assert.match(warning, /worktree was made, but git reported an error/);
  assert.match(warning, /git-lfs: command not found/); // the hook's own reason, not git's checkout progress
  assert.match(sh(repo, "branch", "--list", "task/t4"), /task\/t4/);
  assert.equal(sh(wt, "rev-parse", "--abbrev-ref", "HEAD"), "task/t4");
  assert.equal(fs.readFileSync(path.join(wt, "a.txt"), "utf8"), "one\n");
});

test("addWorktree: on Windows the long-paths advice shows only while core.longpaths is off", { skip: process.platform === "win32" && "a real Windows checkout succeeds once long paths are on; the test above covers off" }, async (t) => {
  const { repo } = fixture();
  unwritable(t, repo); // a 300-character name: fails here whatever core.longpaths says, so Windows is played by process.platform
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...real, value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", real));
  const wt = path.join(repo, ".entomatical", "wt", "t3");
  await assert.rejects(g.addWorktree(repo, wt, "task/t3", "bad"), /260-character limit.*core\.longpaths true", then Start again/s);
  sh(repo, "config", "core.longpaths", "true");
  await assert.rejects(g.addWorktree(repo, wt, "task/t3", "bad"), (e) => /too long for this file system/.test(e.message) && !/longpaths/.test(e.message));
});

test("addWorktree: an existing branch is checked out; a leftover folder is named and nothing is made", async () => {
  const { repo } = fixture();
  sh(repo, "branch", "task/t8", "main"); // made by an earlier start that could not record it
  const wt = path.join(repo, ".entomatical", "wt", "t8");
  await g.addWorktree(repo, wt, "task/t8", "HEAD");
  assert.equal(sh(wt, "rev-parse", "--abbrev-ref", "HEAD"), "task/t8");
  const left = path.join(repo, ".entomatical", "wt", "t6");
  fs.mkdirSync(left, { recursive: true });
  fs.writeFileSync(path.join(left, "a.txt"), "half a checkout\n");
  await assert.rejects(g.addWorktree(repo, left, "task/t6", "HEAD"), /left over from a start that failed partway/);
  assert.equal(sh(repo, "branch", "--list", "task/t6"), "");
  assert.equal(fs.readFileSync(path.join(left, "a.txt"), "utf8"), "half a checkout\n"); // left for the user to check
});

// node_modules link (failed tool calls report, 4-6 Nov 2026): a new worktree shares the checkout's packages, git does not see the link,
// and discarding the worktree removes only the link.
test("linkModules links only a node_modules that npm filled (has .package-lock.json)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-mods2-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-mods2wt-"));
  made.push(worktree, repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(worktree, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(worktree, "package.json"), "{}\n");
  fs.mkdirSync(path.join(repo, "node_modules"));
  assert.equal(g.linkModules(repo, worktree), false);
  assert.equal(fs.existsSync(path.join(worktree, "node_modules")), false, "an empty folder gives no link");
  fs.writeFileSync(path.join(repo, "node_modules", ".package-lock.json"), "{}\n");
  assert.equal(g.linkModules(repo, worktree), true);
  assert.ok(fs.lstatSync(path.join(worktree, "node_modules")).isSymbolicLink());
});

test("addWorktree links the checkout's node_modules, and discard leaves the packages alone", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-mods-"));
  const worktree = path.join(repo, ".entomatical", "wt", "m1");
  made.push(worktree, repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "t@t");
  sh(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
  fs.mkdirSync(path.join(repo, ".entomatical"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".entomatical", ".gitignore"), "*\n");
  fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(repo, "node_modules", ".package-lock.json"), "{}\n");

  assert.equal(await g.addWorktree(repo, worktree, "task/m1", "HEAD"), undefined);
  assert.ok(fs.lstatSync(path.join(worktree, "node_modules")).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(worktree, "node_modules", "pkg", "index.js")));
  assert.equal(await g.isClean(worktree), true, sh(worktree, "status", "--porcelain"));
  assert.equal(g.linkModules(repo, worktree), false); // already there

  await g.discardWorktree(repo, worktree, "task/m1");
  assert.equal(fs.existsSync(worktree), false);
  assert.ok(fs.existsSync(path.join(repo, "node_modules", "pkg", "index.js")), "the checkout's packages survive");
});
