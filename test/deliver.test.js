// deliver(): a card's work reaches the main checkout without Finish. Throwaway repos, made as test/finish.test.js makes them.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { deliver } = require("../out/deliver.js");

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const made = [];
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

/** repo on main (optionally with a bare origin as upstream); worktree on task/t1 branched from it, with nothing of its own yet. */
function fixture({ remote = false } = {}) {
  const root = fs.mkdtempSync(path.join(require("./exec-tmpdir").execTmpdir(), "ab-deliver-"));
  made.push(root);
  const origin = path.join(root, "origin.git"), repo = path.join(root, "repo"), worktree = path.join(repo, ".entomatical", "wt", "t1");
  sh(root, "init", "-q", "-b", "main", repo);
  for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"], ["core.autocrlf", "false"]]) sh(repo, "config", k, v);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  fs.writeFileSync(path.join(repo, "other.txt"), "other\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
  if (remote) {
    sh(root, "init", "-q", "--bare", "-b", "main", origin);
    sh(repo, "remote", "add", "origin", origin);
    sh(repo, "push", "-q", "-u", "origin", "main");
  }
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  fs.writeFileSync(path.join(repo, ".entomatical", ".gitignore"), "*\n");
  sh(repo, "worktree", "add", "-q", "-b", "task/t1", worktree, "HEAD");
  return { root, origin, repo, worktree, branch: "task/t1" };
}
const put = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text);
const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");
const run = (fx, turn) => deliver(fx.repo, fx.worktree, fx.branch, "Card title", turn);

test("uncommitted and untracked work reaches the main checkout; a second call has nothing", async () => {
  const fx = fixture();
  put(fx.worktree, "a.txt", "one\ntwo\n");
  put(fx.worktree, "new.txt", "new\n");
  const r = await run(fx, 3);
  assert.deepEqual(r, { delivered: sh(fx.repo, "rev-parse", "--short", "HEAD"), committed: 2, files: 2 });
  assert.equal(read(fx.repo, "a.txt"), "one\ntwo\n");
  assert.equal(read(fx.repo, "new.txt"), "new\n");
  assert.equal(sh(fx.repo, "log", "-1", "--format=%s"), "Card title (turn 3)");
  assert.equal(sh(fx.worktree, "status", "--porcelain"), "");
  assert.deepEqual(await run(fx), { nothing: true });
  assert.ok(fs.existsSync(fx.worktree) && sh(fx.repo, "branch", "--list", fx.branch), "worktree and branch kept");
});

test("a secret-like file is skipped and not committed", async () => {
  const fx = fixture();
  put(fx.worktree, ".env", "TOKEN=x\n");
  put(fx.worktree, "b.txt", "b\n");
  const r = await run(fx);
  assert.equal(r.committed, 1);
  assert.deepEqual(r.skipped, [".env"]);
  assert.equal(sh(fx.repo, "ls-tree", "-r", "--name-only", "HEAD").includes(".env"), false);
  assert.ok(fs.existsSync(path.join(fx.worktree, ".env")), "left in the worktree");
  assert.ok(!fs.existsSync(path.join(fx.repo, ".env")));
});

test("a secret-like file whose name git C-quotes is skipped and not committed", async () => {
  const fx = fixture();
  put(fx.worktree, "caf\u00e9.pem", "KEY\n");
  put(fx.worktree, "b.txt", "b\n");
  const r = await run(fx);
  assert.equal(r.committed, 1);
  assert.deepEqual(r.skipped, ["caf\u00e9.pem"]);
  assert.equal(sh(fx.repo, "ls-tree", "-r", "--name-only", "HEAD").includes(".pem"), false);
  assert.ok(fs.existsSync(path.join(fx.worktree, "caf\u00e9.pem")), "left in the worktree");
});

test("a conflict with main is refused; the worktree is clean and main unchanged", async () => {
  const fx = fixture();
  put(fx.repo, "a.txt", "main side\n"); sh(fx.repo, "commit", "-qam", "main change");
  const mainHead = sh(fx.repo, "rev-parse", "HEAD");
  put(fx.worktree, "a.txt", "card side\n");
  const r = await run(fx);
  assert.match(r.refused, /conflicts/);
  assert.deepEqual(r.files, ["a.txt"]);
  assert.equal(sh(fx.worktree, "status", "--porcelain"), "");
  assert.equal(sh(fx.repo, "rev-parse", "HEAD"), mainHead);
  assert.equal(read(fx.repo, "a.txt"), "main side\n");
  assert.equal(sh(fx.worktree, "log", "-1", "--format=%s"), "Card title", "the card's commit stays on its branch");
});

test("uncommitted changes in main to a file the card changed are refused and kept", async () => {
  const fx = fixture();
  put(fx.repo, "a.txt", "user's edit\n");
  put(fx.worktree, "a.txt", "card edit\n");
  const r = await run(fx);
  assert.match(r.refused, /uncommitted changes/);
  assert.deepEqual(r.files, ["a.txt"]);
  assert.equal(read(fx.repo, "a.txt"), "user's edit\n");
});

test("unrelated uncommitted changes in main survive a delivery", async () => {
  const fx = fixture();
  put(fx.repo, "other.txt", "user's edit\n");
  put(fx.repo, "scratch.txt", "untracked\n");
  put(fx.worktree, "a.txt", "card edit\n");
  const r = await run(fx);
  assert.ok(r.delivered, JSON.stringify(r));
  assert.equal(read(fx.repo, "a.txt"), "card edit\n");
  assert.equal(read(fx.repo, "other.txt"), "user's edit\n");
  assert.equal(read(fx.repo, "scratch.txt"), "untracked\n");
});

test("a main checkout on a detached HEAD is refused", async () => {
  const fx = fixture();
  sh(fx.repo, "checkout", "-q", "--detach");
  put(fx.worktree, "a.txt", "card edit\n");
  const r = await run(fx);
  assert.match(r.refused, /not on a branch/);
  assert.equal(sh(fx.worktree, "status", "--porcelain"), "M a.txt", "nothing changed");
});

for (const detached of [false, true]) {
  test(`Deliver preserves a dirty worktree on ${detached ? "detached HEAD" : "another branch"}`, async () => {
    const fx = fixture();
    const target = sh(fx.repo, "rev-parse", "HEAD");
    sh(fx.worktree, "checkout", "-q", ...(detached ? ["--detach"] : ["-b", "other"]));
    put(fx.worktree, "a.txt", "off-branch commit\n");
    sh(fx.worktree, "commit", "-qam", "off-branch commit");
    const original = sh(fx.worktree, "rev-parse", "HEAD");
    put(fx.worktree, "b.txt", "untracked edit\n");

    const result = await run(fx);
    assert.match(result.refused, /task\/t1|branch|detached/i);
    assert.equal(sh(fx.repo, "rev-parse", "HEAD"), target);
    assert.equal(sh(fx.repo, "rev-parse", fx.branch), target);
    assert.equal(sh(fx.worktree, "rev-parse", "HEAD"), original);
    assert.equal(sh(fx.worktree, "status", "--porcelain"), "?? b.txt");
  });
}

test("delivery works twice with new work in between, also when main moved", async () => {
  const fx = fixture();
  put(fx.worktree, "b.txt", "b\n");
  assert.ok((await run(fx, 3)).delivered);
  put(fx.repo, "other.txt", "main moved\n"); sh(fx.repo, "commit", "-qam", "main change");
  put(fx.worktree, "c.txt", "c\n");
  const r = await run(fx, 6);
  assert.equal(r.committed, 1);
  assert.equal(r.files, 1);
  assert.equal(read(fx.repo, "c.txt"), "c\n");
  assert.equal(read(fx.repo, "other.txt"), "main moved\n");
});

test("with a remote, nothing is pushed", async () => {
  const fx = fixture({ remote: true });
  const remoteHead = sh(fx.origin, "rev-parse", "main");
  put(fx.worktree, "b.txt", "b\n");
  assert.ok((await run(fx)).delivered);
  assert.equal(sh(fx.origin, "rev-parse", "main"), remoteHead);
  assert.equal(sh(fx.origin, "branch", "--list", fx.branch), "");
});

test("a worktree that is gone, or a merge under way in main, is refused", async () => {
  const fx = fixture();
  assert.match((await deliver(fx.repo, path.join(fx.root, "nowhere"), fx.branch, "t")).refused, /not a git checkout/);
  put(fx.worktree, "b.txt", "b\n");
  fs.writeFileSync(path.join(fx.repo, ".git", "MERGE_HEAD"), sh(fx.repo, "rev-parse", "HEAD") + "\n");
  assert.match((await run(fx)).refused, /merge, rebase/);
});

test("checkoutId: one checkout has one identity however its path is spelled; another folder, or one that is gone, has its own", () => {
  const { checkoutId } = require("../out/deliver.js");
  const fx = fixture();
  const id = checkoutId(fx.repo);
  assert.equal(checkoutId(path.join(fx.repo, "sub", "..") + path.sep), id);
  const link = path.join(fx.root, "link");
  fs.symlinkSync(fx.repo, link, "junction"); // a junction on Windows (no privilege needed), a symlink elsewhere
  assert.equal(checkoutId(link), id);
  assert.notEqual(checkoutId(fx.worktree), id); // the card's worktree is another checkout
  const gone = path.join(fx.root, "Gone", "repo");
  if (process.platform === "win32") {
    for (const spelled of [fx.repo.toUpperCase(), fx.repo.toLowerCase()]) assert.equal(checkoutId(spelled), id); // c:\… and C:\… are one folder
    assert.equal(checkoutId(gone), path.resolve(gone).toLowerCase());
  } else {
    assert.notEqual(checkoutId(fx.repo.toUpperCase()), id); // another path where case counts
    assert.equal(checkoutId(gone), path.resolve(gone));
  }
});

test("deliveryDue: every third turn, at once on another Review, never at 0", () => {
  const { deliveryDue } = require("../out/deliver.js");
  assert.deepEqual(deliveryDue(3, 0, "turn"), { deliver: false, turns: 1 });
  assert.deepEqual(deliveryDue(3, 1, "turn"), { deliver: false, turns: 2 });
  assert.deepEqual(deliveryDue(3, 2, "turn"), { deliver: true, turns: 0 });
  assert.deepEqual(deliveryDue(3, 0, "turn"), { deliver: false, turns: 1 }); // after the reset, counting starts again
  assert.deepEqual(deliveryDue(3, 1, "review"), { deliver: true, turns: 0 });
  assert.deepEqual(deliveryDue(1, 0, "turn"), { deliver: true, turns: 0 });
  assert.deepEqual(deliveryDue(2, 0, "turn"), { deliver: false, turns: 1 });
  for (const event of ["turn", "review"]) assert.deepEqual(deliveryDue(0, 5, event), { deliver: false, turns: 0 });
});
