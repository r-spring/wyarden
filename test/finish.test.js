// The card's Finish button, run against throwaway repos with a local bare "origin". No VS Code window, no claude process.
// A run through test/run.js spreads these tests over four processes (this file and its three share files, test/shares.js),
// so no test may count on another one of this file having run before it.
const test = require("./shares").share(require("node:test"), __filename);
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

class EventEmitter {
  listeners = [];
  event = (l) => (this.listeners.push(l), { dispose() {} });
  fire(e) { for (const l of this.listeners) l(e); }
  dispose() {}
}
const infos = [], opened = []; // the self-finish's notification and the report it opens beside the board
const vscode = { EventEmitter, ViewColumn: { Beside: -2 }, Uri: { file: (p) => ({ fsPath: p }) }, workspace: { openTextDocument: async (uri) => uri },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage() {}, showInformationMessage: async (...a) => { infos.push(a); },
    showTextDocument: async (doc, options) => { opened.push([doc.fsPath, options]); } } };
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board } = require("../out/board.js");
const f = require("../out/finish.js");
const { autoFinish, AUTO_ROUNDS } = require("../out/auto-finish.js");
const { reviewInput, validReview, runConditions, worktreeSnapshot } = require("../out/done-review.js");

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const made = [], boards = [];
// A board left open ticks every 3 s and reads git for its cards every 15 s (refreshNotInMain), so each test's boards are closed
// when it ends. afterEach runs after a subtest too, whose test is still using them: only a top-level test closes.
test.afterEach((t) => { if (t.fullName === t.name) for (const b of boards.splice(0)) b.dispose(); });
test.after(() => { for (const b of boards) b.dispose(); for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

/**
 * origin (bare) <- repo on main with upstream; worktree on task/t1 with one committed change. kids: child worktrees c1, c2 … on
 * task/c1, task/c2 …, branched from task/t1, each with one commit adding c<n>.txt (an orchestrator's run: runFor).
 */
function fixture({ upstream = true, dirty = false, kids = 0, existingFile, existingContent = "already delivered\n" } = {}) {
  const root = fs.mkdtempSync(path.join(require("./exec-tmpdir").execTmpdir(), "ab-finish-"));
  made.push(root);
  const origin = path.join(root, "origin.git"), repo = path.join(root, "repo"), worktree = path.join(repo, ".entomatical", "wt", "t1");
  sh(root, "init", "-q", "--bare", "-b", "main", origin);
  sh(root, "init", "-q", "-b", "main", repo);
  for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"], ["core.autocrlf", "false"]]) sh(repo, "config", k, v);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  if (existingFile) fs.writeFileSync(path.join(repo, existingFile), existingContent);
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
  sh(repo, "remote", "add", "origin", origin);
  if (upstream) sh(repo, "push", "-q", "-u", "origin", "main");
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  fs.writeFileSync(path.join(repo, ".entomatical", ".gitignore"), "*\n");
  sh(repo, "worktree", "add", "-q", "-b", "task/t1", worktree, "HEAD");
  fs.writeFileSync(path.join(worktree, "a.txt"), "one\ntwo\n");
  sh(worktree, "commit", "-qam", "task change");
  if (dirty) fs.writeFileSync(path.join(worktree, "b.txt"), "new\n");
  const children = [];
  for (let i = 1; i <= kids; i++) {
    const child = { worktree: path.join(repo, ".entomatical", "wt", `c${i}`), branch: `task/c${i}` };
    sh(repo, "worktree", "add", "-q", "-b", child.branch, child.worktree, "task/t1");
    fs.writeFileSync(path.join(child.worktree, `c${i}.txt`), `child ${i}\n`);
    sh(child.worktree, "add", "."); sh(child.worktree, "commit", "-qm", `child ${i} work`);
    children.push(child);
  }
  return { root, origin, repo, worktree, branch: "task/t1", children };
}

/** A Board whose card t1 owns the fixture's worktree. term: a stand-in live terminal; onSend: what the "session" does with a follow-up. */
function boardFor(fx, { live = false, sessionId, onSend } = {}) {
  const board = new Board(fx.repo, path.join(fx.repo, "hook.js"));
  boards.push(board);
  const task = board.add("Finish me", "Do the work");
  board.update(task, { worktree: fx.worktree, branch: fx.branch, sessionId, status: "review" });
  const events = [], sent = [];
  let open = live;
  board.events = () => events;
  board.terminal = (t) => (t.id === task.id && open ? { dispose() { open = false; } } : undefined);
  board.send = (t, text) => { sent.push({ id: t.id, text }); onSend?.(text, events); };
  return { board, task, sent, events };
}
const yes = async () => true;

/** Fast limits and stand-ins, so no model is called: the commit message is fixed, and a conflict "resolution" is scripted. */
const quick = { closeMs: 2000, pollMs: 20, resolveMs: 5000 };
const noModel = { message: async () => "Commit by Finish", resolve: async () => { throw new Error("no conflict expected"); } };
const run = (board, task, opts = {}) => board.complete(task, opts.confirm ?? yes, opts.step ?? (() => undefined), opts.closeTab, quick, { ...noModel, ...opts.helpers });
/** Another clone pushes a change of `file` to origin. */
function pushFromOther(fx, file, text) {
  const other = path.join(fx.root, `other-${made.length}-${Math.random().toString(36).slice(2, 6)}`);
  // autocrlf off from the clone on: set afterwards, the CRLF checkout of a.txt would be committed as a change to every line.
  sh(fx.root, "clone", "-q", "-c", "core.autocrlf=false", fx.origin, other);
  for (const [k, v] of [["user.email", "o@o"], ["user.name", "o"]]) sh(other, "config", k, v);
  fs.appendFileSync(path.join(other, file), text);
  sh(other, "add", "."); sh(other, "commit", "-qm", `theirs ${file}`); sh(other, "push", "-q", "origin", "main");
}

test("planFinish: target, remote, uncommitted files and unmerged commits; no upstream means local only", async () => {
  const fx = fixture({ dirty: true });
  const plan = await f.planFinish(fx.repo, fx.worktree, fx.branch);
  assert.equal(plan.target, "main");
  assert.equal(plan.remote, "origin");
  assert.equal(plan.remoteBranch, "main");
  assert.deepEqual(plan.dirty, ["?? b.txt"]);
  assert.equal(plan.commits.length, 1);
  const fy = fixture({ upstream: false });
  const local = await f.planFinish(fy.repo, fy.worktree, fy.branch);
  assert.equal(local.remote, undefined);
});

for (const removeBranch of [false, true]) {
  test(`Finish preserves a detached commit when the card branch is ${removeBranch ? "gone" : "present"}`, async () => {
    const fx = fixture({ upstream: false });
    const { board, task } = boardFor(fx);
    const target = sh(fx.repo, "rev-parse", "HEAD");
    sh(fx.worktree, "checkout", "-q", "--detach");
    fs.writeFileSync(path.join(fx.worktree, "detached.txt"), "work to recover\n");
    sh(fx.worktree, "add", "detached.txt");
    sh(fx.worktree, "commit", "-qm", "work on detached HEAD");
    const detached = sh(fx.worktree, "rev-parse", "HEAD");
    if (removeBranch) sh(fx.repo, "branch", "-D", fx.branch);

    await assert.rejects(run(board, task), /detached|not on task\/t1/i);
    assert.equal(task.status, "review");
    assert.equal(sh(fx.worktree, "rev-parse", "HEAD"), detached);
    assert.equal(sh(fx.worktree, "show", "HEAD:detached.txt"), "work to recover");
    assert.equal(sh(fx.repo, "rev-parse", "HEAD"), target);
  });
}

for (const during of ["confirmation", "commit message"]) {
  test(`Finish preserves a different branch checked out during ${during}`, async () => {
    const fx = fixture({ dirty: true });
    const { board, task } = boardFor(fx);
    const original = sh(fx.worktree, "rev-parse", "HEAD");
    const target = sh(fx.origin, "rev-parse", "main");
    const switchBranch = () => sh(fx.worktree, "checkout", "-qb", "other");
    const opts = during === "confirmation"
      ? { confirm: async () => { switchBranch(); return true; } }
      : { helpers: { message: async () => { switchBranch(); return "Fixture commit"; } } };

    await assert.rejects(run(board, task, opts), /task\/t1|branch|checkout/i);
    assert.equal(task.status, "review");
    assert.equal(sh(fx.worktree, "symbolic-ref", "--short", "HEAD"), "other");
    assert.equal(sh(fx.worktree, "rev-parse", "HEAD"), original);
    assert.equal(fs.readFileSync(path.join(fx.worktree, "b.txt"), "utf8"), "new\n");
    assert.equal(sh(fx.repo, "rev-parse", "HEAD"), target);
    assert.equal(sh(fx.origin, "rev-parse", "main"), target);
  });
}

for (const upstream of [false, true]) {
  test(`Finish preserves a checkout switched during acceptance before ${upstream ? "pushing" : "merging locally"}`, async () => {
    const fx = fixture({ upstream });
    const { board, task } = boardFor(fx);
    const target = sh(fx.repo, "rev-parse", "HEAD");
    const beforePush = async () => {
      sh(fx.worktree, "checkout", "-qb", "other");
      sh(fx.worktree, "commit", "-q", "--allow-empty", "-m", "unrelated work");
    };
    await assert.rejects(run(board, task, { helpers: { beforePush } }), /not on task\/t1/);
    assert.equal(task.status, "review");
    assert.equal(sh(fx.worktree, "log", "-1", "--format=%s"), "unrelated work");
    assert.equal(sh(fx.repo, "rev-parse", "main"), target);
    if (upstream) assert.equal(sh(fx.origin, "rev-parse", "main"), target);
  });
}

test("Finish keeps a different branch selected by the conflict resolver and skips acceptance", async () => {
  const fx = fixture();
  const { board, task } = boardFor(fx);
  pushFromOther(fx, "a.txt", "remote edit\n");
  const target = sh(fx.origin, "rev-parse", "main");
  let checked = false;
  const resolve = async () => {
    sh(fx.worktree, "checkout", "-qb", "other", "origin/main");
    return { code: 0, output: "" };
  };
  await assert.rejects(run(board, task, { helpers: { resolve, beforePush: async () => { checked = true; } } }), /not on task\/t1/);
  assert.equal(checked, false);
  assert.equal(task.status, "review");
  assert.equal(sh(fx.worktree, "symbolic-ref", "--short", "HEAD"), "other");
  assert.equal(sh(fx.origin, "rev-parse", "main"), target);
});

for (const [operation, marker] of [
  ["cherry-pick", "CHERRY_PICK_HEAD"], ["revert", "REVERT_HEAD"], ["rebase", "REBASE_HEAD"], ["merge", "MERGE_HEAD"],
]) {
  test(`Finish ${operation === "merge" ? "delivers" : "preserves"} a resolved ${operation}`, async () => {
    const fx = fixture({ upstream: false });
    const { board, task } = boardFor(fx);
    fs.writeFileSync(path.join(fx.repo, "a.txt"), "main edit\n");
    sh(fx.repo, "commit", "-qam", "main edit");
    const target = sh(fx.repo, "rev-parse", "HEAD");
    assert.throws(() => sh(fx.worktree, operation, target));
    const interrupted = sh(fx.worktree, "rev-parse", marker);
    const original = sh(fx.worktree, "rev-parse", "HEAD");
    if (operation === "merge") sh(fx.worktree, "checkout", "--ours", "--", "a.txt");
    else fs.writeFileSync(path.join(fx.worktree, "a.txt"), "resolved edit\n");
    sh(fx.worktree, "add", "a.txt");
    const index = sh(fx.worktree, "write-tree");

    if (operation === "merge") {
      await run(board, task);
      assert.equal(task.status, "done");
      assert.equal(sh(fx.repo, "show", "HEAD:a.txt"), sh(fx.repo, "show", `${original}:a.txt`));
      const merges = sh(fx.repo, "log", "--merges", "--format=%P").split("\n");
      assert.ok(merges.includes(`${original} ${target}`), "the card's resolved merge reached main with both parents");
      return;
    }
    await assert.rejects(run(board, task), /in progress|under way|detached|rebase|revert|cherry.pick/i);
    assert.equal(task.status, "review");
    assert.equal(sh(fx.worktree, "rev-parse", marker), interrupted);
    assert.equal(sh(fx.worktree, "rev-parse", "HEAD"), original);
    assert.equal(sh(fx.worktree, "write-tree"), index);
    assert.equal(sh(fx.repo, "rev-parse", "HEAD"), target);
  });
}

test("Finish on a clean task pushes to the remote first, then fast-forwards local main, deletes the worktree and marks the card done", async () => {
  const fx = fixture();
  const { board, task, sent } = boardFor(fx);
  const steps = [];
  assert.deepEqual(await run(board, task, { step: (s) => steps.push(s) }), []);
  assert.deepEqual(steps, ["Checking the task", "Closing the session", "Merging with origin/main", "Pushing to origin/main", "Updating main", "Telling related sessions", "Deleting the worktree"]);
  assert.match(sh(fx.origin, "log", "--oneline", "main"), /task change/);
  assert.equal(sh(fx.repo, "rev-parse", "main"), sh(fx.origin, "rev-parse", "main")); // local follows the remote
  assert.equal(fs.existsSync(fx.worktree), false);
  assert.equal(sh(fx.repo, "branch", "--list", fx.branch), "");
  assert.equal(task.status, "done");
  assert.equal(task.merged, true);
  assert.deepEqual(sent, []);
});

test("Finish closes the session's terminal and waits for it to end before it commits what is left, with the written message", async () => {
  const fx = fixture({ dirty: true });
  const { board, task, sent } = boardFor(fx, { live: true, sessionId: "s1" });
  let closedBeforeCommit;
  const message = async (diff) => { closedBeforeCommit = !board.terminal(task); assert.match(diff, /b\.txt/); return "Add b.txt"; };
  await run(board, task, { helpers: { message } });
  assert.equal(closedBeforeCommit, true);
  assert.deepEqual(sent, []); // nothing is asked of the session any more
  assert.match(sh(fx.origin, "log", "--oneline", "main"), /Add b\.txt/);
  assert.equal(fs.existsSync(fx.worktree), false);
});

test("a session open in a Claude panel tab: Finish closes the tab and waits until its process is gone; one that stays stops Finish", async () => {
  const pin = (board, alive) => Object.defineProperty(board, "external", { get: () => new Map(alive() ? [["s1", { pid: 1, sessionId: "s1", cwd: "x", configDir: "" }]] : []), set() {} });
  const fx = fixture();
  const a = boardFor(fx, { sessionId: "s1" });
  let open = true, closed = [];
  pin(a.board, () => open);
  simulated(a.board); // M-02: the pinned pid is no process of this machine's, so the board is not left to ask the OS about it
  await run(a.board, a.task, { closeTab: async (t) => { closed.push(t.id); setTimeout(() => (open = false), 100); } });
  assert.deepEqual(closed, [a.task.id]);
  assert.equal(a.task.status, "done");
  const fy = fixture();
  const b = boardFor(fy, { sessionId: "s1" });
  pin(b.board, () => true);
  simulated(b.board);
  const killed = [];
  b.board.killSession = (t) => (killed.push(t.id), true); // a stand-in: the pinned pid is not a real session
  await assert.rejects(run(b.board, b.task, { closeTab: async () => undefined }), /closing the session: Its session is still running after 2 seconds\. Close its tab/);
  assert.deepEqual(killed, [b.task.id]); // a tab that did not close is ended once, as Switch account ends one, before Finish gives up
  assert.equal(fs.existsSync(fy.worktree), true);
});

test("files that look like secrets are never committed by Finish", async () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.worktree, ".env"), "TOKEN=x\n");
  const { board, task } = boardFor(fx);
  await assert.rejects(run(board, task), /committing the work: These look like secrets.*\.env/s);
  assert.equal(sh(fx.worktree, "status", "--porcelain"), "?? .env"); // left unstaged
  assert.equal(fs.existsSync(fx.worktree), true);
});

test("the remote moved on: Finish merges its latest into the task branch, pushes, and local main follows", async () => {
  const fx = fixture();
  pushFromOther(fx, "c.txt", "theirs\n");
  const { board, task } = boardFor(fx);
  assert.deepEqual(await run(board, task), []);
  const remoteLog = sh(fx.origin, "log", "--oneline", "main");
  assert.match(remoteLog, /task change/);
  assert.match(remoteLog, /theirs c\.txt/);
  assert.equal(sh(fx.repo, "rev-parse", "main"), sh(fx.origin, "rev-parse", "main"));
  assert.equal(fs.readFileSync(path.join(fx.repo, "c.txt"), "utf8"), "theirs\n");
});

test("a conflict with the remote is resolved by the headless run in the worktree, then pushed; one it does not resolve stops Finish", async () => {
  const fx = fixture();
  pushFromOther(fx, "a.txt", "remote line\n");
  const { board, task } = boardFor(fx);
  let asked;
  const original = sh(fx.worktree, "rev-parse", "HEAD");
  const target = sh(fx.origin, "rev-parse", "main");
  const resolve = async (prompt) => {
    asked = prompt;
    assert.throws(() => sh(fx.worktree, "merge", "--no-edit", target));
    fs.writeFileSync(path.join(fx.worktree, "a.txt"), "one\ntwo\nremote line\n");
    sh(fx.worktree, "add", "a.txt"); sh(fx.worktree, "commit", "-qm", "Resolve");
    return { code: 0, output: "done" };
  };
  const beforePush = async (cwd) => {
    sh(cwd, "merge-base", "--is-ancestor", original, "HEAD");
    sh(cwd, "merge-base", "--is-ancestor", target, "HEAD");
  };
  assert.deepEqual(await run(board, task, { helpers: { resolve, beforePush } }), []);
  assert.match(asked, new RegExp(`Merging origin/main into task/t1 conflicts in a\\.txt\\..*git merge --no-edit ${target}.*Do not push`, "s"));
  sh(fx.origin, "merge-base", "--is-ancestor", original, "main");
  sh(fx.origin, "merge-base", "--is-ancestor", target, "main");
  assert.equal(sh(fx.origin, "show", "main:a.txt"), "one\ntwo\nremote line");
  assert.equal(sh(fx.repo, "for-each-ref", "refs/entomatical/finish-recovery"), "");
  assert.equal(task.status, "done");

  const fy = fixture();
  pushFromOther(fy, "a.txt", "remote line\n");
  const beforePlainFailure = sh(fy.origin, "rev-parse", "main");
  const b = boardFor(fy);
  await assert.rejects(run(b.board, b.task, { helpers: { resolve: async () => ({ code: 1, output: "could not tell" }) } }), /merging with origin\/main: Merging origin\/main into task\/t1 conflicts in a\.txt\. The headless Claude run did not merge it: could not tell.*The worktree was kept/s);
  assert.equal(fs.existsSync(fy.worktree), true);
  assert.equal(sh(fy.origin, "rev-parse", "main"), beforePlainFailure);

  // The dialog shows text as typed: the reply's markdown marks are taken out and the cut starts at a word (16 November 2026).
  const { plainTail } = require("../out/finish.js");
  assert.equal(plainTail("that's\nyour call.\n- **`Summary.pdf`:** a binary file.\n\n## Next\n* tell me"), "that's your call. Summary.pdf: a binary file. Next tell me");
  assert.equal(plainTail("keep my_file__name.txt and 2 * 3"), "keep my_file__name.txt and 2 * 3");
  assert.equal(plainTail(`${"word ".repeat(100)}end`, 12), "…word end");
  const fz = fixture();
  pushFromOther(fz, "a.txt", "remote line\n");
  const beforeMarkdownFailure = sh(fz.origin, "rev-parse", "main");
  const c = boardFor(fz);
  await assert.rejects(run(c.board, c.task, { helpers: { resolve: async () => ({ code: 1, output: "- **`a.txt`:** your call" }) } }), /did not merge it: a\.txt: your call /);
  assert.equal(sh(fz.origin, "rev-parse", "main"), beforeMarkdownFailure);
  assert.equal(fs.existsSync(fz.worktree), true);
});

for (const scenario of ["land both histories", "lose the merge before integration", "lose the merge during acceptance", "new work before cleanup"]) {
  test(`Finish push retry: ${scenario}`, async (t) => {
    const fx = fixture(), { board, task } = boardFor(fx);
    const original = sh(fx.worktree, "rev-parse", "HEAD");
    pushFromOther(fx, "a.txt", "remote line\n");
    const base = sh(fx.origin, "rev-parse", "main");
    const resolve = t.mock.fn(async () => {
      assert.throws(() => sh(fx.worktree, "merge", "--no-edit", base));
      fs.writeFileSync(path.join(fx.worktree, "a.txt"), "one\ntwo\nremote line\n");
      sh(fx.worktree, "commit", "-qam", "Resolve");
      return { code: 0, output: "done" };
    });
    const push = t.mock.method(f, "pushTask");
    const cleanup = t.mock.method(board, "removeWorktree");
    let resolved, newerBase, candidate;
    const beforePush = t.mock.fn(async (cwd) => {
      candidate = sh(cwd, "rev-parse", "HEAD");
      if (!resolved) {
        resolved = candidate;
        pushFromOther(fx, "later.txt", "advanced remote\n"); // the first real push must retry
        newerBase = sh(fx.origin, "rev-parse", "main");
      } else {
        sh(cwd, "merge-base", "--is-ancestor", resolved, candidate);
        sh(cwd, "merge-base", "--is-ancestor", newerBase, candidate);
        if (scenario === "lose the merge during acceptance") sh(cwd, "reset", "--keep", newerBase);
      }
    });
    const step = name => {
      if (name === "Merging with origin/main" && resolved && scenario === "lose the merge before integration")
        sh(fx.worktree, "reset", "--keep", base);
      if (name === "Deleting the worktree" && scenario === "new work before cleanup")
        fs.writeFileSync(path.join(fx.worktree, "new.txt"), "keep me\n");
    };
    const result = run(board, task, { step, helpers: { resolve, beforePush } });
    if (scenario === "new work before cleanup") {
      await assert.rejects(result, /worktree changed after its conflict resolution landed/);
      assert.equal(cleanup.mock.callCount(), 0);
      assert.equal(sh(fx.origin, "rev-parse", "main"), candidate);
      assert.equal(fs.readFileSync(path.join(fx.worktree, "new.txt"), "utf8"), "keep me\n");
    } else if (scenario !== "land both histories") {
      const beforeIntegration = scenario === "lose the merge before integration";
      await assert.rejects(result, beforeIntegration ? /retry lost the previously verified conflict resolution/ : /moved off the verified conflict resolution/);
      assert.equal(beforePush.mock.callCount(), beforeIntegration ? 1 : 2);
      assert.equal(task.status, "review");
      assert.equal(sh(fx.origin, "rev-parse", "main"), newerBase);
      assert.equal(sh(fx.worktree, "rev-parse", "HEAD"), newerBase);
      assert.ok(sh(fx.repo, "for-each-ref", "--contains", original, "refs/entomatical/finish-recovery"));
      assert.equal(cleanup.mock.callCount(), 0);
      assert.equal(push.mock.callCount(), 1);
    } else {
      await result;
      assert.equal(task.status, "done");
      assert.equal(sh(fx.origin, "rev-parse", "main"), candidate);
      assert.deepEqual(push.mock.calls.map(call => call.arguments[2]), [resolved, candidate]);
      assert.equal(sh(fx.repo, "for-each-ref", "refs/entomatical/finish-recovery"), "");
    }
    assert.equal(resolve.mock.callCount(), 1);
  });
}

test("Finish keeps a newer checkout made while verifying the resolver's failed ancestry", async (t) => {
  const fx = fixture(), { board, task } = boardFor(fx);
  const original = sh(fx.worktree, "rev-parse", "HEAD");
  pushFromOther(fx, "a.txt", "remote line\n");
  const base = sh(fx.origin, "rev-parse", "main");
  const resolve = async () => {
    sh(fx.worktree, "reset", "--keep", base);
    return { code: 0, output: "done" };
  };
  const isAncestor = f.isAncestor;
  let newer;
  t.mock.method(f, "isAncestor", async (cwd, from, to) => {
    const result = await isAncestor(cwd, from, to);
    if (cwd === fx.worktree && from === original && to === base) {
      sh(cwd, "checkout", "-qb", "work-in-progress");
      fs.writeFileSync(path.join(cwd, "new.txt"), "new work\n");
      sh(cwd, "add", "new.txt");
      sh(cwd, "commit", "-qm", "New work");
      newer = sh(cwd, "rev-parse", "HEAD");
    }
    return result;
  });
  await assert.rejects(run(board, task, { helpers: { resolve } }), /did not keep this task's commits/);
  assert.equal(sh(fx.worktree, "symbolic-ref", "--short", "HEAD"), "work-in-progress");
  assert.equal(sh(fx.worktree, "rev-parse", "HEAD"), newer);
  assert.equal(sh(fx.worktree, "show", "HEAD:new.txt"), "new work");
  assert.equal(sh(fx.repo, "rev-parse", fx.branch), base);
  assert.equal(sh(fx.repo, "rev-parse", `refs/entomatical/finish-recovery/${task.id}/${original}`), original);
  assert.equal(sh(fx.origin, "rev-parse", "main"), base);
  assert.equal(task.status, "review");
});

for (const moved of ["base", "task"]) {
  test(`Finish keeps the conflicted inputs when the ${moved} ref moves after abort`, async (t) => {
    const fx = fixture();
    const { board, task } = boardFor(fx);
    const original = sh(fx.worktree, "rev-parse", "HEAD");
    pushFromOther(fx, "a.txt", "remote line\n");
    const base = sh(fx.origin, "rev-parse", "main");
    const step = (name) => {
      if (name !== "Resolving the conflict in a.txt") return;
      assert.equal(sh(fx.worktree, "status", "--porcelain"), ""); // integrate has already aborted
      if (moved === "base") sh(fx.worktree, "update-ref", "refs/remotes/origin/main", original, base);
      else sh(fx.worktree, "reset", "--keep", base);
    };
    const resolve = t.mock.fn(async () => ({ code: 0, output: "done" }));
    const beforePush = t.mock.fn();
    await assert.rejects(run(board, task, { step, helpers: { resolve, beforePush } }),
      moved === "base" ? /did not merge it/ : /did not keep this task's commits/);
    assert.equal(resolve.mock.callCount(), 1);
    assert.ok(resolve.mock.calls[0].arguments[0].includes(`git merge --no-edit ${base}`));
    assert.equal(beforePush.mock.callCount(), 0);
    assert.equal(task.status, "review");
    assert.equal(sh(fx.origin, "rev-parse", "main"), base);
    assert.equal(sh(fx.worktree, "rev-parse", "HEAD"), moved === "base" ? original : base);
    assert.equal(sh(fx.repo, "rev-parse", `refs/entomatical/finish-recovery/${task.id}/${original}`), original);
  });
}

for (const moveAfterChecks of [false, true]) {
  test(`local Finish ${moveAfterChecks ? "keeps the original task if acceptance replaces the merge" : "lands a verified conflict resolution"}`, async () => {
    const fx = fixture({ upstream: false });
    const { board, task } = boardFor(fx);
    fs.appendFileSync(path.join(fx.repo, "a.txt"), "local line\n");
    sh(fx.repo, "commit", "-qam", "local edit");
    const base = sh(fx.repo, "rev-parse", "main"), original = sh(fx.worktree, "rev-parse", "HEAD");
    const resolve = async () => {
      assert.throws(() => sh(fx.worktree, "merge", "--no-edit", base));
      fs.writeFileSync(path.join(fx.worktree, "a.txt"), "one\ntwo\nlocal line\n");
      sh(fx.worktree, "commit", "-qam", "Resolve");
      return { code: 0, output: "done" };
    };
    const beforePush = async (cwd) => {
      sh(cwd, "merge-base", "--is-ancestor", original, "HEAD");
      sh(cwd, "merge-base", "--is-ancestor", base, "HEAD");
      if (moveAfterChecks) sh(cwd, "reset", "--hard", base);
    };
    const finish = run(board, task, { helpers: { resolve, beforePush } });
    if (moveAfterChecks) {
      await assert.rejects(finish, /moved off the verified conflict resolution/);
      assert.equal(task.status, "review");
      assert.equal(sh(fx.repo, "rev-parse", "main"), base);
      assert.equal(sh(fx.worktree, "rev-parse", "HEAD"), base);
      assert.ok(sh(fx.repo, "for-each-ref", "--contains", original, "--format=%(refname)"));
    } else {
      await finish;
      sh(fx.repo, "merge-base", "--is-ancestor", original, "main");
      sh(fx.repo, "merge-base", "--is-ancestor", base, "main");
      assert.equal(sh(fx.repo, "show", "main:a.txt"), "one\ntwo\nlocal line");
      assert.equal(task.status, "done");
    }
  });
}

for (const scenario of ["base only", "local base only", "task only with moved base ref", "dirty", "switched"]) {
  test(`Finish rejects a conflict resolver that loses an input: ${scenario}`, async (t) => {
    const local = scenario === "local base only";
    const fx = fixture({ upstream: !local });
    const { board, task } = boardFor(fx);
    if (local) {
      fs.appendFileSync(path.join(fx.repo, "a.txt"), "local line\n");
      sh(fx.repo, "commit", "-qam", "local edit");
    } else pushFromOther(fx, "a.txt", "remote line\n");
    const main = sh(fx.repo, "rev-parse", "main");
    const base = local ? main : sh(fx.origin, "rev-parse", "main");
    const original = sh(fx.worktree, "rev-parse", "HEAD");
    const beforePush = t.mock.fn();
    const push = t.mock.method(f, "pushTask");
    const cleanup = t.mock.method(board, "removeWorktree");
    const resolve = async () => {
      // This resolver acts only on the disposable fixture worktree and its local refs.
      if (scenario === "task only with moved base ref") {
        sh(fx.worktree, "update-ref", "refs/remotes/origin/main", original);
      } else {
        sh(fx.worktree, "reset", "--hard", base);
        if (scenario === "switched") sh(fx.worktree, "checkout", "-qb", "other");
        if (scenario === "dirty" || scenario === "switched") {
          fs.appendFileSync(path.join(fx.worktree, "a.txt"), "staged edit\n");
          sh(fx.worktree, "add", "a.txt");
          fs.appendFileSync(path.join(fx.worktree, "a.txt"), "unstaged edit\n");
        }
      }
      return { code: 0, output: "done" };
    };

    const reason = scenario === "switched" ? /not on task\/t1/ : scenario === "dirty" ? /uncommitted changes/
      : scenario.startsWith("task only") ? /did not merge it/ : /did not keep this task's commits/;
    await assert.rejects(run(board, task, { helpers: { resolve, beforePush } }), reason);
    assert.deepEqual([beforePush, push, cleanup].map(spy => spy.mock.callCount()), [0, 0, 0]);
    assert.equal(task.status, "review");
    assert.ok(!task.merged);
    assert.equal(sh(fx.repo, "rev-parse", "main"), main);
    if (!local) assert.equal(sh(fx.origin, "rev-parse", "main"), base);
    if (scenario === "dirty" || scenario === "switched") {
      assert.equal(sh(fx.worktree, "symbolic-ref", "--short", "HEAD"), scenario === "dirty" ? fx.branch : "other");
      assert.equal(sh(fx.worktree, "rev-parse", "HEAD"), base);
      assert.match(sh(fx.worktree, "show", ":a.txt"), /staged edit$/);
      assert.match(fs.readFileSync(path.join(fx.worktree, "a.txt"), "utf8"), /staged edit\nunstaged edit\n$/);
      assert.ok(sh(fx.repo, "for-each-ref", "--contains", original, "--format=%(refname)"), "a ref keeps the original task commit");
    } else {
      assert.equal(sh(fx.worktree, "rev-parse", "HEAD"), scenario.startsWith("task only") ? original : base);
      assert.equal(sh(fx.worktree, "show", `refs/entomatical/finish-recovery/${task.id}/${original}:a.txt`), "one\ntwo");
    }
    if (scenario === "base only") {
      // A fresh Finish must not treat the resolver's base-only checkout as already landed.
      await assert.rejects(run(board, task), /does not contain the saved task commit/);
      assert.equal(task.status, "review");
      assert.equal(cleanup.mock.callCount(), 0);
      assert.equal(push.mock.callCount(), 0);
      sh(fx.worktree, "merge", "--no-commit", "-s", "ours", original);
      fs.writeFileSync(path.join(fx.worktree, "a.txt"), "one\ntwo\nremote line\n");
      sh(fx.worktree, "commit", "-qam", "Recover original task");
      await run(board, task);
      assert.equal(task.status, "done");
      sh(fx.origin, "merge-base", "--is-ancestor", original, "main");
      sh(fx.origin, "merge-base", "--is-ancestor", base, "main");
      assert.equal(sh(fx.repo, "for-each-ref", "refs/entomatical/finish-recovery"), "");
    }
  });
}

// linux, 4 November 2026: a resolver with no conversation to resume (a Codex task, or no session) came back as a found card.
test("a resolver that starts a new conversation gets a known session id the board dismisses, so it never shows as a found card", { skip: process.platform === "win32" }, async () => {
  const fx = fixture();
  pushFromOther(fx, "a.txt", "remote line\n");
  const { board, task } = boardFor(fx);
  board.accountList = () => [{ name: "t@t", configDir: path.join(fx.root, "account") }];
  board.update(task, { account: "t@t" });
  const bin = path.join(fx.root, "bin"), argsFile = path.join(fx.root, "args.txt");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "$@" > '${argsFile}'\nexit 1\n`, { mode: 0o755 }); // a stand-in: no model
  const was = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${was}`;
  try { await assert.rejects(run(board, task, { helpers: { resolve: undefined } }), /did not merge it/); } finally { process.env.PATH = was; }
  const id = fs.readFileSync(argsFile, "utf8").match(/--session-id ([0-9a-f-]{36})/)?.[1];
  assert.ok(id, "the resolver is started with --session-id");
  assert.ok(JSON.parse(fs.readFileSync(board.dismissedFile, "utf8")).includes(id));
});

// Exact ids only (the user, 17 November 2026): with no Finish pick, the conflict resolver of a Claude card runs the card's own model
// (headlessClaude hands Claude Code its full id, action-picks.test.js); before, it passed no --model and ran the account's default.
test("with no Finish pick, a Claude card's conflict resolver runs the card's own model, not the account's default", async () => {
  const fx = fixture();
  pushFromOther(fx, "a.txt", "remote line\n");
  const { board, task } = boardFor(fx);
  board.update(task, { model: "haiku" });
  const was = f.headlessClaude, seen = [];
  f.headlessClaude = async (...args) => { seen.push(args[6]); return { code: 1, output: "left for the test" }; };
  try { await assert.rejects(run(board, task, { helpers: { resolve: undefined } }), /did not merge it: left for the test/); } finally { f.headlessClaude = was; }
  assert.deepEqual(seen.map((r) => r.model), ["haiku"]);
});

test("with no Finish pick, another provider's card's conflict resolver runs Claude Opus by name, never Claude's default", async () => {
  const fx = fixture();
  pushFromOther(fx, "a.txt", "remote line\n");
  const { board, task } = boardFor(fx);
  board.accountList = () => [{ name: "t@t", configDir: path.join(fx.root, "account") }, { name: "Codex · t@t", provider: "codex" }];
  board.update(task, { account: "Codex · t@t", provider: "codex", model: "sol" });
  const was = f.headlessClaude, seen = [];
  f.headlessClaude = async (...args) => { seen.push(args[6]); return { code: 1, output: "left for the test" }; };
  try { await assert.rejects(run(board, task, { helpers: { resolve: undefined } }), /did not merge it: left for the test/); } finally { f.headlessClaude = was; }
  assert.deepEqual(seen.map((r) => r.model), ["opus"], "headlessClaude hands it to Claude Code as claude-opus-5-5");
});

test("uncommitted local edits to a file the task changes: the push still happens, local main is left alone, and Finish says so", async () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.repo, "a.txt"), "one\nlocal work in progress\n");
  const { board, task } = boardFor(fx);
  const notes = await run(board, task);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Could not update main in the main checkout from origin\/main: it has uncommitted changes to a\.txt\..*Pull it there when ready/s);
  assert.match(sh(fx.origin, "log", "--oneline", "main"), /task change/);
  assert.equal(fs.readFileSync(path.join(fx.repo, "a.txt"), "utf8"), "one\nlocal work in progress\n");
  assert.equal(task.status, "done");
});

test("local main with commits of its own is merged with the remote's branch, which now holds the task", async () => {
  const fx = fixture();
  fs.writeFileSync(path.join(fx.repo, "z.txt"), "local\n"); sh(fx.repo, "add", "z.txt"); sh(fx.repo, "commit", "-qm", "local only");
  const { board, task } = boardFor(fx);
  assert.deepEqual(await run(board, task), []);
  const log = sh(fx.repo, "log", "--oneline", "main");
  assert.match(log, /task change/);
  assert.match(log, /local only/);
  assert.equal(sh(fx.origin, "log", "--oneline", "main").includes("local only"), false); // Finish pushes the task, not local work
});

test("no remote: Finish merges into local main with a merge commit; uncommitted local edits to the task's files stop it", async () => {
  const fx = fixture({ upstream: false });
  const { board, task } = boardFor(fx);
  const steps = [];
  assert.deepEqual(await run(board, task, { step: (s) => steps.push(s) }), []);
  assert.deepEqual(steps, ["Checking the task", "Closing the session", "Merging with main", "Merging into main", "Telling related sessions", "Deleting the worktree"]);
  assert.match(sh(fx.repo, "log", "--oneline", "-1", "main"), /Merge branch 'task\/t1'/);
  const fy = fixture({ upstream: false });
  fs.writeFileSync(path.join(fy.repo, "a.txt"), "one\nlocal\n");
  const b = boardFor(fy);
  await assert.rejects(run(b.board, b.task), /merging into main: Could not update main.*uncommitted changes to a\.txt.*The worktree was kept/s);
  assert.equal(fs.readFileSync(path.join(fy.repo, "a.txt"), "utf8"), "one\nlocal\n");
});

// the user, 7 November 2026: "the finish button shouldn't end a session that's busy ... It shouldn't just instantly kill their jobs."
// Work under way is refused before any dialog, and nothing is stopped or changed; once it has ended, Finish goes ahead.
test("a working session is refused before the dialog and keeps working; once its turn ends, Finish lands what it left", async () => {
  const fx = fixture({ dirty: true });
  const a = boardFor(fx, { live: true, sessionId: "s1" });
  a.board.update(a.task, { status: "running" });
  let asked = false;
  await assert.rejects(run(a.board, a.task, { confirm: async () => (asked = true) }),
    /^Error: Finish stopped while checking the task: "Finish me" is still working \(its session is working\)\. Finish does not stop work: wait for it to end, or press Stop first, then Finish again\. Nothing was changed\. The worktree was kept\.$/);
  assert.equal(asked, false); // no dialog
  assert.ok(a.board.terminal(a.task)); // still open
  assert.equal(a.task.status, "running");
  assert.equal(sh(fx.origin, "log", "--oneline", "main").includes("task change"), false);
  a.board.update(a.task, { status: "review" }); // the turn ended
  let state;
  const steps = [];
  assert.deepEqual(await run(a.board, a.task, { step: (s) => steps.push(s), confirm: async (plan, related, s) => { state = s; return true; } }), []);
  assert.deepEqual([state.open, state.asking], [true, false]);
  assert.equal(steps[1], "Closing the session");
  assert.equal(a.board.terminal(a.task), undefined);
  assert.equal(sh(fx.origin, "show", "main:b.txt"), "new");
  assert.deepEqual([a.task.status, a.task.merged, fs.existsSync(fx.worktree)], ["done", true, false]);
});

test("a session that starts working while the dialog is open is not stopped: Finish refuses after the dialog too", async () => {
  const fx = fixture();
  const a = boardFor(fx, { live: true, sessionId: "s1" });
  await assert.rejects(run(a.board, a.task, { confirm: async () => { a.board.update(a.task, { status: "running" }); return true; } }),
    /closing the session: It started working while the dialog was open \(its session is working\)\. Nothing was stopped: press Finish again once it is done\. Nothing was changed\./);
  assert.ok(a.board.terminal(a.task));
  assert.deepEqual([a.task.status, fs.existsSync(fx.worktree)], ["running", true]);
});

test("a session waiting on a prompt is no work under way: the dialog says the prompt goes unanswered, and Finish closes it", async () => {
  const fx = fixture();
  const a = boardFor(fx, { live: true, sessionId: "s1" });
  a.board.update(a.task, { status: "needs-input" });
  let state;
  await run(a.board, a.task, { confirm: async (plan, related, s) => { state = s; return true; } });
  assert.deepEqual([state.open, state.asking], [true, true]);
  assert.equal(a.board.terminal(a.task), undefined);
  assert.deepEqual([a.task.status, fs.existsSync(fx.worktree)], ["done", false]);
});

test("running acceptance checks refuse Finish; nothing is stopped and the run keeps its result", async () => {
  const fx = fixture();
  const { board, task } = boardFor(fx);
  const checks = { status: "running", run: path.join(board.dir, "checks", task.id, "1") };
  board.recordChecks(task, checks);
  await assert.rejects(run(board, task), /is still working \(its acceptance checks are running\)/);
  assert.deepEqual([task.checks?.status, task.status, fs.existsSync(fx.worktree)], ["running", "review", true]);
});

test("a master whose run still has live cards refuses Finish; the run is not stopped or paused", async () => {
  const fx = fixture();
  const { board, task } = boardFor(fx);
  const child = board.add("Child", "work");
  board.update(child, { openedBy: task.id, status: "running" });
  let open = true;
  const terminal = board.terminal;
  board.terminal = (t) => (t.id === child.id && open ? { dispose() { open = false; } } : terminal(t));
  await assert.rejects(run(board, task), /is still working \(1 card of its run is still running\)/);
  assert.equal(open, true);
  assert.deepEqual([task.paused, task.status, child.status], [undefined, "review", "running"]);
});

test("work already merged (the session pushed it itself): Finish skips merge and push, updates local main, deletes the worktree", async () => {
  const fx = fixture();
  sh(fx.worktree, "push", "-q", "origin", "HEAD:main"); // also moves origin/main, which the check reads
  const { board, task } = boardFor(fx);
  let state;
  const steps = [];
  assert.deepEqual(await run(board, task, { step: (s) => steps.push(s), confirm: async (p, r, s) => { state = s; return true; } }), []);
  assert.equal(state.landed, true);
  assert.deepEqual(steps, ["Checking the task", "Closing the session", "Updating main", "Telling related sessions", "Deleting the worktree"]);
  assert.equal(sh(fx.repo, "rev-parse", "main"), sh(fx.origin, "rev-parse", "main"));
  assert.equal(sh(fx.repo, "branch", "--list", fx.branch), "");
  assert.deepEqual([task.status, task.merged, task.worktree, fs.existsSync(fx.worktree)], ["done", true, undefined, false]);
  // No remote, merged into local main by hand: no merge step at all.
  const fy = fixture({ upstream: false });
  sh(fy.repo, "merge", "-q", "--no-edit", fy.branch);
  const b = boardFor(fy);
  const local = [];
  assert.deepEqual(await run(b.board, b.task, { step: (s) => local.push(s) }), []);
  assert.deepEqual(local, ["Checking the task", "Closing the session", "Telling related sessions", "Deleting the worktree"]);
  assert.deepEqual([b.task.status, b.task.merged], ["done", true]);
});

test("a worktree folder deleted by hand: Finish checks its branch out again, so the branch's commits still land", async () => {
  const fx = fixture();
  fs.rmSync(fx.worktree, { recursive: true, force: true });
  const { board, task } = boardFor(fx);
  let state;
  const steps = [];
  assert.deepEqual(await run(board, task, { step: (s) => steps.push(s), confirm: async (p, r, s) => { state = s; return true; } }), []);
  assert.deepEqual([state.restore, state.noBranch, state.landed], [true, false, false]);
  assert.equal(steps[2], "Checking out task/t1 again");
  assert.match(sh(fx.origin, "log", "--oneline", "main"), /task change/);
  assert.deepEqual([task.status, task.merged, fs.existsSync(fx.worktree)], ["done", true, false]);
});

test("the card's folder is gone but git has its branch checked out in another worktree folder: Finish uses that one", async () => {
  // 17 November 2026, cards 94a532 and dd0d4b: the card named a folder that was gone while git had the branch checked out elsewhere,
  // so "Checking out task/<id> again" failed with git's "fatal: 'task/<id>' is already used by worktree at …" after the session closed.
  const fx = fixture();
  const elsewhere = path.join(fx.repo, ".entomatical", "wt", "t1-moved");
  sh(fx.repo, "worktree", "move", fx.worktree, elsewhere);
  fs.writeFileSync(path.join(elsewhere, "c.txt"), "uncommitted\n"); // work only that folder holds
  const { board, task } = boardFor(fx);
  let state;
  const steps = [];
  assert.deepEqual(await run(board, task, { step: (s) => steps.push(s), confirm: async (p, r, s) => { state = s; return true; } }), []);
  assert.equal(state.restore, false); // the folder is not gone, so nothing is checked out again
  assert.ok(!steps.some((s) => /again/.test(s)), steps.join(", "));
  assert.match(sh(fx.origin, "log", "--oneline", "main"), /task change/);
  assert.equal(sh(fx.origin, "show", "main:c.txt"), "uncommitted");
  assert.deepEqual([task.status, task.merged, fs.existsSync(elsewhere), fs.existsSync(fx.worktree)], ["done", true, false, false]);
});

test("the card's folder is gone and git lists its branch in another folder that is also gone: Finish checks it out again", async () => {
  const fx = fixture();
  const elsewhere = path.join(fx.repo, ".entomatical", "wt", "t1-moved");
  sh(fx.repo, "worktree", "move", fx.worktree, elsewhere);
  fs.rmSync(elsewhere, { recursive: true, force: true });
  const { board, task } = boardFor(fx);
  const steps = [];
  assert.deepEqual(await run(board, task, { step: (s) => steps.push(s) }), []);
  assert.equal(steps[2], "Checking out task/t1 again");
  assert.match(sh(fx.origin, "log", "--oneline", "main"), /task change/);
  assert.deepEqual([task.status, task.merged, fs.existsSync(fx.worktree)], ["done", true, false]);
});

test("the card's folder is gone and its branch is checked out outside the board's worktrees: Finish refuses before closing anything", async () => {
  const fx = fixture();
  const outside = path.join(fx.root, "mine");
  sh(fx.repo, "worktree", "move", fx.worktree, outside);
  const { board, task } = boardFor(fx);
  const steps = [];
  await assert.rejects(run(board, task, { step: (s) => steps.push(s) }), /checking the task: .*git has task\/t1 checked out at .*mine, which is not one of this board's worktrees/s);
  assert.deepEqual(steps, ["Checking the task"]);
  assert.ok(fs.existsSync(path.join(outside, "a.txt")));
  assert.equal(task.status, "review");
});

test("a leftover folder with no .git link is not a checkout: git never runs in it, so the main checkout's changes stay untouched", async () => {
  const fx = fixture();
  sh(fx.repo, "worktree", "remove", "--force", fx.worktree);
  fs.mkdirSync(fx.worktree, { recursive: true });
  fs.writeFileSync(path.join(fx.worktree, "stray.txt"), "left over\n");
  fs.writeFileSync(path.join(fx.repo, "a.txt"), "one\nmain work in progress\n"); // git there would reach this
  const { board, task } = boardFor(fx);
  let plan;
  await assert.rejects(run(board, task, { confirm: async (p) => { plan = p; return true; } }), /checking out task\/t1 again: .*is left over from a start that failed partway/s);
  assert.deepEqual(plan.dirty, []); // before: the main checkout's a.txt, which Finish would have committed onto main
  assert.equal(sh(fx.repo, "status", "--porcelain"), "M a.txt");
  assert.match(sh(fx.repo, "log", "--oneline", "-1"), /init/); // nothing was committed onto main
});

test("branch and folder both gone: Finish just moves the card to Done, not marked merged, and says nothing was merged", async () => {
  const fx = fixture();
  sh(fx.repo, "worktree", "remove", "--force", fx.worktree);
  sh(fx.repo, "branch", "-D", fx.branch);
  const { board, task } = boardFor(fx);
  let seen;
  const notes = await run(board, task, { confirm: async (plan, related, state) => { seen = { plan, noBranch: state.noBranch }; return true; } });
  assert.deepEqual(seen, { plan: undefined, noBranch: true });
  assert.deepEqual(notes, ["Its branch task/t1 was already gone, so nothing was merged."]);
  assert.deepEqual([task.status, task.merged, task.worktree, task.branch], ["done", undefined, undefined, undefined]);
  // Gone branch, worktree detached with uncommitted work: the one refusal, as nothing could carry that work.
  const fy = fixture();
  sh(fy.worktree, "checkout", "-q", "--detach");
  sh(fy.repo, "branch", "-D", fy.branch);
  fs.writeFileSync(path.join(fy.worktree, "c.txt"), "unsaved\n");
  const b = boardFor(fy);
  await assert.rejects(run(b.board, b.task), /checking the task: Its branch task\/t1 is gone and its worktree has uncommitted changes/);
  assert.equal(fs.readFileSync(path.join(fy.worktree, "c.txt"), "utf8"), "unsaved\n");
});

// 12 November 2026 (docs/plans/2026-11-12-finish-worktree-tool-lock.md): Codex's MCP helpers kept a merged card's worktree as their
// cwd, so Windows would not delete the folder. Linux deletes a folder that is a process's cwd, so the lock itself is Windows only.
test("a tool process holding the worktree folder (Windows): Finish lands the work, says only the folder is left and marks cleanup pending; Finish again once it ends only deletes the folder", { skip: process.platform !== "win32" && "a process's cwd does not lock a folder on Linux" }, async () => {
  const fx = fixture();
  const { board, task } = boardFor(fx, { sessionId: "s1" });
  const { spawn } = require("node:child_process");
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { cwd: fx.worktree, stdio: "ignore" });
  await new Promise((r) => holder.once("spawn", r));
  try {
    const before = sh(fx.origin, "rev-parse", "main");
    await assert.rejects(run(board, task), (e) => {
      assert.match(e.message, /^Work merged and pushed to origin\/main; its worktree .*t1 was kept whole, because something the board has no record of still has the folder open, often a tool the session started \(for a Codex editor session, that window's Codex helpers\)\. Close it\. Then press Finish again: it only retries the cleanup\./s);
      assert.doesNotMatch(e.message, /nothing was merged|worktree was kept/);
      return true;
    });
    const landed = sh(fx.origin, "rev-parse", "main");
    assert.notEqual(landed, before);
    assert.match(sh(fx.origin, "log", "--oneline", "-1", "main"), /task change/);
    assert.deepEqual([task.merged, task.cleanupPending, task.status === "done"], [true, true, false]);
    // M-02 (19 November 2026): the folder is asked about before git touches it, so the worktree is whole, not emptied and deregistered.
    assert.ok(fs.existsSync(path.join(fx.worktree, ".git")) && fs.existsSync(path.join(fx.worktree, "a.txt")) && sh(fx.repo, "branch", "--list", fx.branch) !== "");
    assert.deepEqual([task.cleanup.sha, task.cleanup.into, task.cleanup.holders.map((h) => h.owner)], [landed, "origin/main", ["unknown"]]);
    await assert.rejects(board.resume(task), /This task is already merged; its folder only waits to be deleted\. Press Finish to delete it, or start a new card\./);
    holder.kill();
    await new Promise((r) => holder.once("exit", r));
    const head = sh(fx.repo, "rev-parse", "HEAD");
    assert.deepEqual(await run(board, task), [`Its work was already in origin/main (${landed.slice(0, 7)}); only its worktree was left, and it was deleted.`]);
    assert.deepEqual([task.status, task.merged, task.cleanupPending, task.worktree], ["done", true, undefined, undefined]);
    assert.equal(fs.existsSync(fx.worktree), false);
    assert.deepEqual([sh(fx.origin, "rev-parse", "main"), sh(fx.repo, "rev-parse", "HEAD")], [landed, head]); // no new commit or push
  } finally { holder.kill(); }
});

test("Finish retains the recovery ref through failed folder removal and releases it on cleanup retry", async (t) => {
  const fx = fixture(), { board, task } = boardFor(fx);
  const tip = sh(fx.worktree, "rev-parse", "HEAD");
  const ref = `refs/entomatical/finish-recovery/${task.id}/${tip}`;
  sh(fx.repo, "update-ref", ref, tip);
  const rm = fs.promises.rm.bind(fs.promises);
  const blocked = t.mock.method(fs.promises, "rm", async (folder, options) => {
    if (folder !== fx.worktree) return rm(folder, options);
    // Simulate the Windows folder lock after Git removed the registration and branch.
    fs.mkdirSync(folder, { recursive: true });
    throw Object.assign(new Error("busy folder"), { code: "EBUSY" });
  });
  await assert.rejects(run(board, task), /Work merged and pushed to origin\/main; only its temporary folder/);
  assert.equal(sh(fx.repo, "rev-parse", ref), tip);
  assert.equal(sh(fx.origin, "rev-parse", "main"), tip);
  assert.equal(sh(fx.repo, "branch", "--list", fx.branch), "");
  assert.deepEqual([task.merged, task.cleanupPending, task.status === "done"], [true, true, false]);
  blocked.mock.restore();
  assert.deepEqual(await run(board, task), ["Its work was already merged; the leftover folder was deleted."]);
  assert.equal(task.status, "done");
  assert.equal(fs.existsSync(fx.worktree), false);
  assert.equal(sh(fx.repo, "for-each-ref", ref), "");
  assert.equal(sh(fx.origin, "rev-parse", "main"), tip);
});

test("Finish reports a recovery ref deletion failure after delivering and removing the worktree", async () => {
  const fx = fixture(), { board, task } = boardFor(fx);
  const tip = sh(fx.worktree, "rev-parse", "HEAD");
  const ref = `refs/entomatical/finish-recovery/${task.id}/${tip}`;
  sh(fx.repo, "update-ref", ref, tip);
  fs.writeFileSync(path.join(fx.repo, ".git", ref + ".lock"), "");
  const notes = await run(board, task);
  assert.equal(task.status, "done");
  assert.equal(fs.existsSync(fx.worktree), false);
  assert.equal(sh(fx.origin, "rev-parse", "main"), tip);
  assert.equal(sh(fx.repo, "rev-parse", ref), tip);
  assert.equal(notes.length, 1);
  assert.ok(notes[0].includes(ref));
  assert.match(notes[0], /worktree was removed/i);
});

/** The state that lock leaves on any machine: the work on origin and main, branch and registration gone, an empty folder kept. */
function leftoverAfterMerge() {
  const fx = fixture();
  sh(fx.worktree, "push", "-q", "origin", `${fx.branch}:main`);
  sh(fx.repo, "pull", "-q", "--ff-only");
  sh(fx.repo, "worktree", "remove", "--force", fx.worktree);
  sh(fx.repo, "branch", "-D", fx.branch);
  fs.mkdirSync(fx.worktree, { recursive: true });
  const b = boardFor(fx, { sessionId: "s1" });
  b.board.update(b.task, { merged: true, cleanupPending: true });
  return { fx, ...b };
}

test("a merged card's leftover folder holding files a session wrote since: Finish refuses, names them and keeps them; empty folders are deleted", async () => {
  const { fx, board, task } = leftoverAfterMerge();
  fs.mkdirSync(path.join(fx.worktree, "sub", "empty"), { recursive: true });
  fs.writeFileSync(path.join(fx.worktree, "sub", "notes.txt"), "written after the merge\n");
  await assert.rejects(run(board, task), /deleting the worktree: Its leftover folder .*t1 still holds files: sub[\\/]notes\.txt\. Move what you want to keep, then Finish again, or Discard\./s);
  assert.equal(fs.readFileSync(path.join(fx.worktree, "sub", "notes.txt"), "utf8"), "written after the merge\n");
  assert.deepEqual([task.status === "done", task.cleanupPending], [false, true]);
  fs.rmSync(path.join(fx.worktree, "sub", "notes.txt"));
  const head = sh(fx.origin, "rev-parse", "main");
  assert.deepEqual(await run(board, task), ["Its work was already merged; the leftover folder was deleted."]);
  assert.deepEqual([task.status, task.merged, task.cleanupPending], ["done", true, undefined]);
  assert.equal(fs.existsSync(fx.worktree), false);
  assert.equal(sh(fx.origin, "rev-parse", "main"), head);
});

test("Resume, Start and follow-ups refuse a worktree folder that is no longer a git checkout, so git never runs in the main checkout", async () => {
  const { fx, board, task } = leftoverAfterMerge();
  let launched = 0;
  board.launch = async () => { launched++; };
  const said = /This task is already merged; its folder only waits to be deleted\. Press Finish to delete it, or start a new card\./;
  await assert.rejects(board.resume(task), said);
  assert.throws(() => board.gate(task), said); // Start, panel starts and follow-ups pass the same gate
  board.update(task, { merged: undefined, cleanupPending: undefined });
  assert.throws(() => board.gate(task), /is no longer a git checkout, so a session there would run git in the main checkout/);
  assert.equal(launched, 0);
  fs.rmSync(fx.worktree, { recursive: true });
  board.gate(task); // a folder that is gone is not refused here: Resume's own checks handle it
});

test("Finish checks ownership again after its dialog: a window that lost the board meanwhile changes nothing", async () => {
  const fx = fixture();
  const a = boardFor(fx, { live: true, sessionId: "s1" });
  const owner = path.join(a.board.dir, "owner.json");
  const lost = async () => { fs.writeFileSync(owner, JSON.stringify({ pid: process.ppid, at: Date.now() })); return true; }; // another window took it while the dialog was open
  try {
    await assert.rejects(run(a.board, a.task, { confirm: lost }), /Another VS Code window runs this repo's board/);
  } finally { fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, at: Date.now() })); }
  assert.ok(a.board.terminal(a.task)); // before: the session was closed and the work committed and pushed
  assert.equal(sh(fx.origin, "log", "--oneline", "main").includes("task change"), false);
});

test("related live sessions (parent and subtasks) are told before the worktree goes", async () => {
  const fx = fixture();
  const { board, task, sent } = boardFor(fx);
  const child = board.add("Child", "Sub work", "", task.id);
  const terminal = board.terminal;
  board.terminal = (t) => (t.id === child.id ? { dispose() {} } : terminal(t));
  let related;
  await run(board, task, { confirm: async (plan, r) => { related = r.map((t) => t.id); return true; } });
  assert.deepEqual(related, [child.id]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, child.id);
  assert.match(sent[0].text, /is finished\. Its branch task\/t1 was pushed to origin\/main, and main was updated from there\. Its worktree .* is being removed now/);
});

test("a related session waiting on a prompt no longer stops Finish: it is not told, and Finish says so", async () => {
  const fx = fixture();
  const { board, task, sent } = boardFor(fx);
  const child = board.add("Child", "Sub work", "", task.id);
  board.update(child, { status: "needs-input" });
  const terminal = board.terminal;
  board.terminal = (t) => (t.id === child.id ? { dispose() {} } : terminal(t));
  let waiting;
  const notes = await run(board, task, { confirm: async (plan, r, state) => { waiting = state.waiting.map((t) => t.id); return true; } });
  assert.deepEqual(waiting, [child.id]);
  assert.deepEqual(sent, []); // a note would have answered its prompt
  assert.deepEqual(notes, ['"Child" was waiting on a prompt, so it was not told that this task\'s worktree is gone.']);
  assert.equal(task.status, "done");
});

test("the headless run continues the task's own conversation on its account, in the worktree, with edits and commands allowed", () => {
  const dir = fs.mkdtempSync(path.join(require("./exec-tmpdir").execTmpdir(), "ab-headless-"));
  made.push(dir);
  const script = path.join(dir, "h.cjs");
  fs.writeFileSync(script, `
    const { EventEmitter } = require("node:events"), { PassThrough, Writable } = require("node:stream");
    let seen, input = "";
    require("node:child_process").spawn = (bin, args, opts) => {
      seen = { args, cwd: opts.cwd, config: opts.env.CLAUDE_CONFIG_DIR, key: opts.env.ANTHROPIC_API_KEY ?? null, token: opts.env.CLAUDE_CODE_OAUTH_TOKEN ?? null };
      const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => true;
      c.stdin = new Writable({ write(chunk, _e, cb) { input += chunk; cb(); }, final(cb) { cb(); queueMicrotask(() => { c.stdout.end("ok"); c.emit("close", 0); }); } });
      return c;
    };
    const f = require(process.argv[2]);
    f.headlessClaude(process.argv[3], process.argv[4], "sess-1", "PROMPT", new AbortController().signal)
      .then((r) => console.log(JSON.stringify({ seen, input, r })));`);
  const out = JSON.parse(execFileSync(process.execPath, [script, require.resolve("../out/finish.js"), path.join(dir, "wt"), path.join(dir, "account")], { encoding: "utf8", timeout: 15000,
    env: { ...process.env, ANTHROPIC_API_KEY: "sk-test", CLAUDE_CODE_OAUTH_TOKEN: "tok-test" } }));
  assert.equal(out.seen.cwd, path.join(dir, "wt"));
  assert.equal(out.seen.config, path.join(dir, "account"));
  assert.equal(out.seen.key, null, "the account's login is used, not an inherited API key (the worker's environment())");
  assert.equal(out.seen.token, null);
  assert.deepEqual(out.seen.args.slice(0, 3), ["-p", "--resume", "sess-1"]);
  assert.ok(out.seen.args.includes("acceptEdits"));
  assert.equal(out.seen.args[out.seen.args.indexOf("--allowedTools") + 1], f.helperTools());
  assert.equal(out.input, "PROMPT"); // the prompt goes on stdin, not the command line
  assert.deepEqual(out.r, { code: 0, output: "ok" });
});

// The flaky "a resolver that starts a new conversation…" run: a child that exits before reading its prompt crashed it with write EPIPE.
test("a headless child that exits without reading its prompt gives its own failed result, not an uncaught EPIPE", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(require("./exec-tmpdir").execTmpdir(), "ab-epipe-"));
  made.push(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho gone\nexit 3\n", { mode: 0o755 }); // never reads stdin
  const was = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${was}`;
  try {
    // 4 MB fills the pipe, so the write is still pending when the child exits.
    const r = await f.headlessClaude(dir, "", undefined, "x".repeat(4 << 20), new AbortController().signal);
    assert.deepEqual(r, { code: 3, output: "gone" });
  } finally { process.env.PATH = was; }
});

test("the merge helper may use PowerShell on Windows, where sessions run git through it (fix 5); elsewhere the list is unchanged", () => {
  assert.deepEqual(f.HELPER_DENIED, ["Bash(git push:*)", "Bash(git switch:*)"]);
  assert.equal(f.helperTools("win32"), "Bash PowerShell Read Edit Write Glob Grep");
  assert.equal(f.helperTools("linux"), "Bash Read Edit Write Glob Grep");
  assert.equal(f.helperTools("darwin"), "Bash Read Edit Write Glob Grep");
});

test("Finish with beforePush: it runs after each merge with the remote's latest and before the push; an ordinary Finish without it is unchanged", async () => {
  const fx = fixture();
  pushFromOther(fx, "c.txt", "theirs\n");
  const { board, task } = boardFor(fx);
  const steps = [], seen = [];
  const beforePush = async (worktree) => { seen.push([worktree, fs.existsSync(path.join(worktree, "c.txt"))]); };
  assert.deepEqual(await run(board, task, { step: (s) => steps.push(s), helpers: { beforePush } }), []);
  assert.deepEqual(seen, [[fx.worktree, true]], "the remote's latest is already merged when it runs");
  assert.deepEqual(steps, ["Checking the task", "Closing the session", "Merging with origin/main", "Running the acceptance checks", "Pushing to origin/main", "Updating main", "Telling related sessions", "Deleting the worktree"]);
  // One that throws stops Finish before the push, and the worktree is kept.
  const fy = fixture();
  const b = boardFor(fy);
  await assert.rejects(run(b.board, b.task, { helpers: { beforePush: async () => { throw new Error("Acceptance check 1 failed: exit 1 exited with 1."); } } }),
    /running the acceptance checks: Acceptance check 1 failed.*The worktree was kept/s);
  assert.equal(sh(fy.origin, "log", "--oneline", "main").includes("task change"), false);
  assert.equal(fs.existsSync(fy.worktree), true);
  // Without it the steps are the ordinary Finish's.
  const fz = fixture();
  const c = boardFor(fz), plain = [];
  assert.deepEqual(await run(c.board, c.task, { step: (s) => plain.push(s) }), []);
  assert.deepEqual(plain, ["Checking the task", "Closing the session", "Merging with origin/main", "Pushing to origin/main", "Updating main", "Telling related sessions", "Deleting the worktree"]);
});

test("a second Finish of the same card while one is in flight is refused and changes nothing; the first finishes normally", async () => {
  const fx = fixture();
  const { board, task } = boardFor(fx);
  let release, reached;
  const at = new Promise((r) => { reached = r; });
  const first = run(board, task, { helpers: { beforePush: () => { reached(); return new Promise((r) => { release = r; }); } } });
  await at; // the first is mid-Finish, before its push
  const confirms = [];
  await assert.rejects(run(board, task, { confirm: async () => { confirms.push(1); return true; } }), /"Finish me" is already being finished\. Nothing was changed\./);
  assert.deepEqual(confirms, [], "no dialog for the refused one");
  release();
  assert.deepEqual(await first, []);
  assert.match(sh(fx.origin, "log", "--oneline", "main"), /task change/);
  assert.deepEqual([task.status, fs.existsSync(fx.worktree), board.completing.size], ["done", false, 0]);
});

test("CORE-DEL-3: Merge and Discard while Finish holds the card are refused, keeping branch, worktree and both heads; after it, Finish and Merge work", async () => {
  const fx = fixture();
  const { board, task } = boardFor(fx);
  let release, reached;
  const at = new Promise((r) => { reached = r; });
  const first = run(board, task, { helpers: { beforePush: () => { reached(); return new Promise((r) => { release = r; }); } } });
  await at; // Finish holds the card, before its push
  const heads = () => [sh(fx.repo, "rev-parse", "main"), sh(fx.repo, "rev-parse", fx.branch)];
  const before = heads();
  await assert.rejects(board.finish(task, "merge"), /Finish is active on "Finish me": Merge was refused\. Nothing was changed\./);
  await assert.rejects(board.finish(task, "discard"), /Finish is active on "Finish me": Discard was refused\. Nothing was changed\./);
  assert.deepEqual([heads(), sh(fx.repo, "branch", "--list", fx.branch) !== "", fs.existsSync(fx.worktree), task.merged, task.status], [before, true, true, undefined, "review"]);
  release();
  assert.deepEqual(await first, []);
  assert.match(sh(fx.origin, "log", "--oneline", "main"), /task change/);
  assert.deepEqual([task.status, fs.existsSync(fx.worktree), board.completing.size], ["done", false, 0]);
  // A Merge, once nothing holds its card, still lands; Finish is refused while that Merge holds it.
  const fy = fixture({ upstream: false });
  const b = boardFor(fy);
  const merging = b.board.finish(b.task, "merge");
  await assert.rejects(run(b.board, b.task), /"Finish me" is already being finished\. Nothing was changed\./);
  await merging;
  assert.deepEqual([b.task.status, b.task.merged, fs.existsSync(fy.worktree), b.board.completing.size], ["done", true, false, 0]);
  assert.match(sh(fy.repo, "log", "--oneline", "main"), /task change/);
});

// F103 (the user, 13 November 2026): each Finish that does not complete is a line in the board's errors.jsonl (src/error-log.ts).
const errorLog = (board) => { try { return fs.readFileSync(path.join(board.dir, "errors.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

test("F103: a refused second Finish and a cancelled dialog are logged (refused as an error, the cancel as info); a Finish that completes logs nothing", async () => {
  const fx = fixture();
  const { board, task } = boardFor(fx);
  let release, reached;
  const at = new Promise((r) => { reached = r; });
  const first = run(board, task, { helpers: { beforePush: () => { reached(); return new Promise((r) => { release = r; }); } } });
  await at;
  await assert.rejects(run(board, task), /already being finished/);
  release();
  await first;
  const fy = fixture(), b = boardFor(fy);
  assert.equal(await run(b.board, b.task, { confirm: async () => false }), false);
  assert.deepEqual(errorLog(board).map((e) => [e.level, e.action, e.outcome, e.stage, e.card, e.message]),
    [["error", "finish", "refused", "Checking the task", { id: task.id, title: "Finish me" }, '"Finish me" is already being finished. Nothing was changed.']]);
  assert.deepEqual(errorLog(b.board).map((e) => [e.level, e.outcome, e.stage, e.message, e.model, e.permission]),
    [["info", "cancelled", "Checking the task", "Finish was cancelled at its dialog. Nothing was changed.", "haiku", "acceptEdits"]]);
  assert.deepEqual(fs.readdirSync(path.join(board.dir, "runs")), [], "no run record is left behind");
});

test("F103: a conflict the resolver cannot settle is logged at its stage with the resolver's exit code and output tail, secrets redacted", async () => {
  const fx = fixture();
  pushFromOther(fx, "a.txt", "remote line\n");
  const { board, task } = boardFor(fx);
  const output = `${"x".repeat(3000)}\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx\nCould not tell how to combine them.`;
  await assert.rejects(run(board, task, { helpers: { resolve: async () => ({ code: 1, output }) } }), /did not merge it/);
  const [e] = errorLog(board);
  assert.deepEqual([e.level, e.action, e.outcome, e.stage, e.exitCode], ["error", "finish", "runner-error", "Resolving the conflict in a.txt", 1]);
  assert.match(e.message, /^Finish stopped while merging with origin\/main: Merging origin\/main into task\/t1 conflicts in a\.txt\. The headless Claude run did not merge it/);
  assert.match(e.stderr, /GITHUB_TOKEN=\[redacted\]\nCould not tell how to combine them\.$/);
  assert.ok(e.stderr.length <= 2049, "only the end of the output is kept");
  assert.doesNotMatch(JSON.stringify(e), /ghp_abcdef/);
});

// ---- An orchestrator finishes by itself (F97 section 9, src/auto-finish.ts). The reviewer is a stand-in; the remote is the local bare origin.

/** The fixture as an orchestrator's run: the master card owns t1, a child card each child worktree (Done, with a Done when). */
function runFor(fx, { commands } = {}) {
  const { board, task: master } = boardFor(fx, { sessionId: "sess-m" });
  board.update(master, { orchestrator: { caps: {}, opened: fx.children.length }, headless: true, finishAsked: { at: new Date().toISOString() }, deliveryReady: true,
    completion: { commands: commands ?? [], doneWhen: "a.txt exists." } });
  const children = fx.children.map((c, i) => {
    const child = board.add(`Child ${i + 1}`, `Do part ${i + 1}`);
    board.update(child, { openedBy: master.id, worktree: c.worktree, branch: c.branch, status: "done", completion: { commands: [], doneWhen: `c${i + 1}.txt exists.` } });
    return child;
  });
  const followUps = [], needsYou = [];
  board.followUpHeadless = async (t, text) => { followUps.push(text); };
  board.onRun((e) => { if (e.kind === "needsYou") needsYou.push(e.text); });
  fx.reviewScope = { kind: "orchestrator", prompt: master.prompt, followUps: [], doneWhen: master.completion.doneWhen,
    children: children.map(t => ({ id: t.id, doneWhen: t.completion.doneWhen })) };
  return { board, master, children, followUps, needsYou };
}
/** A reviewer's verdict as runDoneReview stores it; unmet: the conditions it finds not met. */
function verdict(fx, kind, unmet = []) {
  const receipt = path.join(fx.root, `receipt-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(receipt, JSON.stringify({ kind: "review", receiptStatus: "done" }));
  const result = { findings: unmet.length ? unmet.map((condition) => ({ condition, status: "not-met", evidence: "missing" })) : [{ condition: "c1.txt exists.", status: "met", evidence: "c1.txt:1" }],
    other: "", explanation: "Because.", verdict: kind, prompt: kind === "not-done" ? `Reopen a card for ${unmet.join(" and ")}.` : "",
    questions: kind === "unsure" ? [{ question: "Is c1.txt enough?", suggested: "Yes." }] : [], file: path.join(fx.root, "review.md"), model: "fable", effort: "medium",
    at: new Date().toISOString(), receipt };
  if (kind !== "done" || !fx.reviewScope) return result;
  const scope = fx.reviewScope, files = ["a.txt", ...fx.children.map((_, i) => `c${i + 1}.txt`)];
  const findings = runConditions(scope.doneWhen, scope.children).map((condition, i) =>
    ({ conditionIndex: i + 1, condition, status: "met", evidence: `File: ${files[i]}` }));
  return { ...result, ...validReview({ ...result, findings }, { ...scope, candidateFiles: files, work: { fileLines: new Map() } }) };
}
/**
 * The deps autoFinish gets: the stand-in reviewer answers each call with the next result (a function is called with the card first,
 * as a reviewer that takes a while). Like runDoneReview, it records the worktree's snapshot when it gathers its input.
 */
function deps(results) {
  const calls = [];
  return { calls, closeTab: async () => undefined, limits: quick, helpers: noModel,
    review: async (t, opts) => {
      calls.push(opts);
      const snapshot = await worktreeSnapshot(t.worktree), next = results.shift();
      return { ...(await (typeof next === "function" ? next(t) : next)), snapshot };
    } };
}
const decisions = (file) => (JSON.parse(fs.readFileSync(file, "utf8")).decisions ?? []).map((d) => d.action);

test("owner takeover reconciles the saved automatic review before replay; a second restart still waits for Review", async () => {
  const fx = fixture(), { board, master } = runFor(fx);
  const file = path.join(board.dir, "tasks.json"), read = () => fs.readFileSync(file, "utf8");
  const before = sh(fx.origin, "rev-parse", "main");
  const localBefore = sh(fx.repo, "rev-parse", "main");
  const candidate = sh(fx.worktree, "rev-parse", "HEAD");
  assert.notEqual(candidate, localBefore);
  const run = { requestId: "test-review", model: "fable", effort: "medium", at: master.finishAsked.at };
  let snapshot;
  await autoFinish(board, master, deps([() => {
    board.update(master, { doneReviewRun: run, status: "running", turns: 2, deliveryTurns: 2 });
    snapshot = read(); // Exactly what the next window would load if this review lost its owner here.
    return verdict(fx, "unsure");
  }]));
  assert.deepEqual(JSON.parse(snapshot)[0].selfFinish, { step: "Reviewing the run" });
  board.dispose();
  fs.writeFileSync(file, snapshot);
  const events = board.eventsFile(master.id);
  fs.writeFileSync(events, JSON.stringify({ t: Date.parse(JSON.parse(snapshot)[0].updatedAt) + 1, hook_event_name: "Stop" }) + "\n");
  const replays = [], d = deps([]);
  const reopen = () => {
    const owner = new Board(fx.repo, path.join(fx.repo, "hook.js"), undefined, false);
    boards.push(owner);
    owner.onRun(e => { if (e.kind === "finishReady") replays.push(autoFinish(owner, e.master, d, e.review)); });
    return owner;
  };
  const first = reopen();
  first.isOwner = () => false;
  first.tick();
  assert.equal(read(), snapshot, "a mirror leaves the active review with its owner");
  first.isOwner = () => true;
  first.tick();
  await first.deliveries;
  const repaired = read(), [card] = JSON.parse(repaired);
  assert.equal(sh(fx.repo, "rev-parse", "main"), localBefore, "replaying the third Stop cannot deliver to local main");
  assert.equal(sh(fx.origin, "rev-parse", "main"), before);
  assert.equal(card.status, "review");
  assert.equal(card.turns, 3, "the Stop was replayed");
  assert.equal(card.deliveryTurns, 2, "the paused delivery was not scheduled");
  assert.equal(card.delivery, undefined);
  assert.doesNotMatch(fs.readFileSync(events, "utf8"), /"Delivery"/);
  assert.deepEqual(card.doneReviewRun, { ...run, error: "The review was interrupted when the window closed. Press Review to run it again." });
  assert.deepEqual(card.selfFinish, { error: "Automatic finish was interrupted. Press Review to retry." });
  assert.deepEqual(card.finishAsked, { at: run.at, reviewInterrupted: true });
  first.dispose();
  const second = reopen();
  second.tick();
  await second.deliveries;
  assert.equal(read(), repaired, "the second owner makes no further change");
  const current = second.get(master.id);
  assert.deepEqual(await Promise.all(replays), ["stopped"], "the replayed Stop cannot start automatic Finish");
  second.recordChecks(current, { status: "complete" });
  assert.deepEqual(await Promise.all(replays), ["stopped", "stopped"]);
  assert.deepEqual(d.calls, []);
  assert.equal(sh(fx.repo, "rev-parse", "main"), localBefore);
  assert.equal(sh(fx.origin, "rev-parse", "main"), before);
  assert.ok(fs.existsSync(fx.worktree));
  // A Done supplied by an explicit Review uses the ordinary delivery checks and finishes once.
  const retry = { ...verdict(fx, "done"), snapshot: await worktreeSnapshot(fx.worktree) };
  assert.equal(await autoFinish(second, current, d, retry), "finished");
  assert.deepEqual(d.calls, []);
  assert.equal(sh(fx.repo, "rev-parse", "main"), candidate);
  assert.equal(sh(fx.origin, "rev-parse", "main"), candidate);
});

test("auto-finish: a Done review merges every Done child, pushes to the remote, deletes the run's worktrees and writes the report", async () => {
  const fx = fixture({ dirty: true, kids: 1 });
  pushFromOther(fx, "c.txt", "theirs\n");
  // The master's checks run again once the remote's latest is merged: c.txt only comes from there.
  const { board, master, children: [child] } = runFor(fx, { commands: [`node -e "require('fs').accessSync('c.txt')"`] });
  const hooks = path.join(board.dir, "hooks", `${child.id}.json`);
  fs.writeFileSync(hooks, "{}");
  const wait = path.join(board.dir, "wait", child.id);
  fs.mkdirSync(wait, { recursive: true });
  fs.writeFileSync(path.join(wait, "controller.json"), "{}");
  fs.writeFileSync(wait + ".json", "{}");
  const d = deps([verdict(fx, "done")]);
  const pushes = pushCounter(fx);
  infos.length = 0; opened.length = 0;
  assert.equal(await autoFinish(board, master, d), "finished");
  assert.equal(pushes(), 1, "checks that pass inside their limit: one push");
  assert.deepEqual(d.calls, [{ auto: true }]);
  const remote = sh(fx.origin, "log", "--oneline", "main");
  for (const commit of [/child 1 work/, /task change/, /Commit by Finish/, /theirs c\.txt/]) assert.match(remote, commit);
  assert.equal(fs.existsSync(fx.children[0].worktree), false);
  assert.equal(sh(fx.repo, "branch", "--list", "task/c1"), "");
  assert.equal(fs.existsSync(fx.worktree), false, "the master's own worktree went with Finish");
  assert.equal(fs.existsSync(hooks), false);
  assert.deepEqual([fs.existsSync(wait), fs.existsSync(wait + ".json")], [false, false]);
  const report = path.join(board.dir, "reports", `${master.id}.md`);
  const text = fs.readFileSync(report, "utf8");
  assert.match(text, /Child 1/);
  assert.ok(text.includes(sh(fx.origin, "rev-parse", "main")), "the report names the pushed commit");
  assert.match(text, /child 1 work/);
  assert.deepEqual([master.status, child.status, master.selfFinish.report], ["done", "done", report]);
  assert.equal(infos.length, 1);
  assert.equal(infos[0].at(-1), "Open report");
  assert.deepEqual(opened, [[report, { viewColumn: -2, preview: true, preserveFocus: true }]]);
});

test("auto-finish: Not done sends the reviewer's prompt to the orchestrator and clears its finish request; after 2 automatic rounds it waits in Needs input", async () => {
  const fx = fixture({ kids: 1 });
  const { board, master, followUps } = runFor(fx);
  const before = sh(fx.origin, "rev-parse", "main");
  const results = [verdict(fx, "not-done", ["A"]), verdict(fx, "not-done", ["B"]), verdict(fx, "not-done", ["C"])];
  const first = results[0];
  const d = deps(results);
  assert.equal(await autoFinish(board, master, d), "sent-back");
  assert.deepEqual([master.finishAsked, master.autoRounds, master.doneReview.sent], [undefined, 1, "auto"]);
  assert.deepEqual(decisions(first.receipt), ["auto"]);
  assert.equal(await autoFinish(board, master, d), "sent-back");
  assert.equal(master.autoRounds, AUTO_ROUNDS);
  assert.equal(await autoFinish(board, master, d), "asked");
  assert.deepEqual(followUps, ["Reopen a card for A.", "Reopen a card for B."]);
  assert.equal(master.status, "needs-input");
  assert.equal(master.doneReview.prompt, "Reopen a card for C.", "the prompt stays on the card for Accept prompt");
  assert.equal(master.doneReview.sent, undefined);
  assert.equal(sh(fx.origin, "rev-parse", "main"), before, "nothing is pushed");
  assert.equal(fs.existsSync(fx.worktree), true);
});

for (const route of ["direct terminal", "batched terminal", "resumed terminal", "promptless resume", "resume without echo", "composer"]) test(`F97: a ${route} follow-up restarts the standing Finish at round zero, then its automatic repair consumes round one`, async () => {
  const fx = fixture(), { board, master, followUps } = runFor(fx);
  board.update(master, { headless: false, autoRounds: 2, mergeRetries: 1 });
  const events = board.events(master.id), writes = [], term = { sendText: text => writes.push(text) };
  board.terminal = () => term;
  delete board.send; // exercise the production terminal sender
  board.deliverEveryTurns = () => 0;
  let terminalLaunch;
  const hook = (t, name, fields = {}) => ({ t, session_id: master.sessionId, hook_event_name: name, terminal_launch_id: terminalLaunch, ...fields });
  events.push(hook(Date.now() - 1000, "UserPromptSubmit", { prompt: "Previous work" }), hook(Date.now() - 900, "Stop"));
  const unmet = () => verdict(fx, "not-done", ["round.txt"]);
  assert.equal(await autoFinish(board, master, deps([unmet()])), "asked");
  assert.equal(master.selfFinish.step, "Not done after 2 automatic rounds.");
  const request = master.finishAsked, at = Date.parse(master.statusAt);
  const seen = [], reviews = [];
  board.onRun(e => {
    if (e.kind !== "finishReady") return;
    seen.push([master.finishAsked.at, master.autoRounds, master.mergeRetries]);
    reviews.push(autoFinish(board, master, deps([t => {
      assert.deepEqual([t.autoRounds, t.mergeRetries], [0, 0]);
      return unmet();
    }])));
  });
  if (route === "batched terminal") {
    events.push(hook(at, "Note"));
    board.syncStatus(master.id); // watcher read of the old Stop
    assert.deepEqual([master.status, master.autoRounds, seen.length], ["needs-input", 2, 0]);
  }
  const prompt = route === "composer" ? "<task-notification>literal text supplied in the composer</task-notification>"
    : "<main> should contain the corrected title.";
  if (route === "composer") {
    // The More > Follow-up host message, handled against the fixture's real Board and terminal sender.
    const filename = require.resolve("../out/extension.js"), extension = new Module(filename, module);
    extension.require = name => name.startsWith("./") ? {} : require(name);
    extension._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.handle = handle;", filename);
    assert.equal(await extension.exports.handle(board, { type: "send", id: master.id, text: prompt }), "sent");
    assert.deepEqual(writes.splice(0), ["\u001b[200~" + prompt + "\u001b[201~\r"]);
    assert.deepEqual([master.finishAsked, master.autoRounds, master.mergeRetries], [request, 0, 0]);
  }
  const promptAt = route === "direct terminal" ? at + 1 : at;
  if (route.includes("resume")) {
    events.push(hook(at, "SessionEnd"), hook(at, "UserPromptSubmit", { prompt: "Late old prompt" }), hook(at, "Stop"));
    board.syncStatus(master.id);
    assert.deepEqual([seen, master.autoRounds, master.mergeRetries], [[], 2, 1]);
    const launchPrompt = route === "promptless resume" ? undefined : route === "resume without echo" ? "Resume." : prompt;
    board.launch = (task, resume, initial, launchId) => {
      terminalLaunch = launchId;
      assert.equal(resume, true);
      assert.equal(initial, launchPrompt);
      events.push(hook(at, "SessionStart", { source: "resume" }));
      if (route === "resumed terminal") events.push(hook(at, "UserPromptSubmit", { prompt: initial }), hook(at, "Stop"));
      return term;
    };
    if (route === "promptless resume") await board.startInCard(master);
    else await board.resume(master, launchPrompt);
    board.syncStatus(master.id);
    assert.deepEqual([seen, master.autoRounds, master.mergeRetries], [[], 2, 1]);
  }
  if (route === "direct terminal") {
    delete master.selfFinish.eventsAtWait; // a saved card from before the fix
  }
  if (route === "direct terminal" || route === "batched terminal") {
    events.push(hook(promptAt, "UserPromptSubmit", { prompt: "<task-notification>Agent finished.</task-notification>" }));
    if (route === "direct terminal") board.syncStatus(master.id);
    events.push(hook(promptAt, "Stop"), hook(promptAt, "Stop", { session_id: "foreign" }));
    if (route === "direct terminal") {
      board.syncStatus(master.id);
      assert.deepEqual([master.autoRounds, master.mergeRetries, seen, master.finishAsked], [2, 1, [], request]);
    }
  }
  events.push(hook(promptAt, "UserPromptSubmit", { prompt }));
  if (route === "direct terminal") {
    board.syncStatus(master.id);
    assert.deepEqual([master.status, master.autoRounds, master.mergeRetries], ["running", 0, 0]);
    events.push(hook(promptAt + 1, "Stop", { session_id: "foreign" }));
    board.syncStatus(master.id);
    assert.deepEqual([master.status, seen], ["running", []], "only the owning Stop can resume the pending Finish");
  }
  events.push(hook(promptAt + 1, "Stop"));
  board.syncStatus(master.id, true);
  assert.deepEqual(seen, [[request.at, 0, 0]]);
  assert.deepEqual(await Promise.all(reviews), ["sent-back"]);
  assert.deepEqual(writes, ["\u001b[200~Reopen a card for round.txt.\u001b[201~\r"]);
  assert.deepEqual(followUps, [], "the board used the open interactive session");
  events.push(hook(at + 4, "UserPromptSubmit", { prompt: "Reopen a card for round.txt." }));
  board.syncStatus(master.id);
  assert.deepEqual([master.autoRounds, master.mergeRetries, master.finishAsked], [1, 0, undefined]);
});

for (const order of ["start first", "prompt first"]) test(`F97: an older saved wait keeps an unknown launch turn exhausted with ${order}`, async () => {
  for (const cursor of [false, true]) {
    const fx = fixture(), { board, master } = runFor(fx);
    board.update(master, { headless: false, provider: order === "prompt first" ? "codex" : undefined, autoRounds: 2, mergeRetries: 1 });
    const events = board.events(master.id), step = "Not done after 2 automatic rounds.";
    board.terminal = () => ({});
    board.update(master, { status: "needs-input", selfFinish: cursor ? { step, eventsAtWait: 0 } : { step } });
    let t = Date.parse(master.statusAt);
    const hook = (name, fields = {}) => ({ t: ++t, hook_event_name: name, session_id: master.sessionId, ...fields });
    const prompt = cursor ? "A custom launch instruction." : "Resume.";
    const seen = [];
    board.onRun(e => { if (e.kind === "finishReady") seen.push([master.autoRounds, master.mergeRetries]); });
    if (order === "prompt first") {
      events.push(hook("UserPromptSubmit", { prompt }));
      board.syncStatus(master.id, true);
      assert.deepEqual([master.autoRounds, master.mergeRetries, seen], [2, 1, []]);
    }
    events.push(hook("SessionStart", { source: "resume" }));
    if (order === "start first") events.push(hook("UserPromptSubmit", { prompt }));
    events.push(hook("Stop"));
    board.syncStatus(master.id, true);
    assert.deepEqual([master.status, master.autoRounds, master.mergeRetries, seen], ["needs-input", 2, 1, []]);
    events.push(hook("UserPromptSubmit", { prompt }), hook("Stop"));
    board.syncStatus(master.id, true);
    assert.deepEqual(seen, [[0, 0]], "the same instruction on a subsequent turn is new work");
  }
});

for (const read of ["one read", "separate reads"]) for (const launchPrompt of [undefined, "Correct the title."])
test(`F97: Codex receives a ${launchPrompt ? "launch echo" : "genuine prompt"} before SessionStart in ${read}`, async () => {
  const fx = fixture(), { board, master } = runFor(fx);
  board.update(master, { headless: false, provider: "codex", autoRounds: 2, mergeRetries: 1 });
  delete board.events; // use the file-backed Codex thread filter across both watcher orderings
  const seen = [];
  const append = (...events) => fs.appendFileSync(board.eventsFile(master.id), events.map(e => JSON.stringify(e) + "\n").join(""));
  let t = Date.now(), terminalLaunch;
  const hook = (name, fields = {}) => ({ t: ++t, hook_event_name: name, session_id: master.sessionId, terminal_launch_id: terminalLaunch, ...fields });
  append(hook("SessionStart", { source: "startup" }), hook("Stop"));
  assert.equal(await autoFinish(board, master, deps([verdict(fx, "not-done", ["missing"])])), "asked");
  append(hook("SessionEnd"));
  board.onRun(e => { if (e.kind === "finishReady") seen.push([master.autoRounds, master.mergeRetries]); });
  const term = { sendText: () => assert.fail("a new terminal must stop before the composer can write") };
  board.codexModelReady = board.ensureCodexTrust = async () => {};
  board.launch = (_task, resume, prompt, launchId) => {
    assert.deepEqual([resume, prompt], [true, launchPrompt]);
    terminalLaunch = launchId;
    return term;
  };
  board.terminal = () => term;
  delete board.send;
  if (launchPrompt) await board.resume(master, launchPrompt);
  else await board.startInCard(master);
  board.update(master, JSON.parse(JSON.stringify({ finishAsked: master.finishAsked, selfFinish: master.selfFinish })));
  append(hook("UserPromptSubmit", { prompt: "Correct the title." }));
  if (read === "separate reads") {
    board.syncStatus(master.id);
    assert.throws(() => board.send(master, "Premature", true, "confirm-submit"), /waiting on a prompt/);
  }
  append(hook("SessionStart", { source: "resume" }), hook("Stop"));
  board.syncStatus(master.id, true);
  if (launchPrompt) {
    assert.deepEqual([master.status, master.autoRounds, master.mergeRetries, seen], ["needs-input", 2, 1, []]);
    append(hook("UserPromptSubmit", { prompt: launchPrompt }), hook("Stop"));
    board.syncStatus(master.id, true);
  }
  assert.deepEqual([master.status, seen], ["review", [[0, 0]]]);
});

test("F97: a resumed terminal must supply its own Stop before a composer send", async () => {
  const fx = fixture(), { board, master } = runFor(fx);
  board.update(master, { headless: false, autoRounds: 2, mergeRetries: 1 });
  const events = board.events(master.id), writes = [];
  const stop = { t: Date.now(), hook_event_name: "Stop", session_id: master.sessionId };
  events.push(stop);
  assert.equal(await autoFinish(board, master, deps([verdict(fx, "not-done", ["missing"])])), "asked");
  const term = { sendText: text => writes.push(text) };
  let terminalLaunch;
  board.launch = (_task, _resume, _prompt, launchId) => { terminalLaunch = launchId; return term; };
  board.terminal = () => term;
  delete board.send;
  await board.resume(master);
  const send = () => board.send(master, "Follow up", true, "confirm-submit");
  assert.throws(send, /waiting on a prompt/);
  events.push({ ...stop, terminal_launch_id: terminalLaunch, session_id: "foreign" }, { ...stop, terminal_launch_id: terminalLaunch, agent_id: "child" });
  assert.throws(send, /waiting on a prompt/);
  assert.deepEqual([writes, master.autoRounds, master.mergeRetries], [[], 2, 1]);
  events.push({ ...stop, terminal_launch_id: terminalLaunch });
  await send();
  assert.deepEqual(writes, ["\u001b[200~Follow up\u001b[201~\r"]);
});

for (const read of ["batched", "separate"]) test(`F97: the first Claude correction after /clear resets the standing Finish (${read})`, async () => {
  const fx = fixture(), { board, master } = runFor(fx);
  board.update(master, { headless: false, autoRounds: 2, mergeRetries: 1 });
  const events = board.events(master.id), seen = [];
  const old = master.sessionId, next = "replacement", t = Date.now();
  const hook = (hook_event_name, session_id, extra = {}) => ({ t, hook_event_name, session_id, ...extra });
  events.push(hook("Stop", old));
  assert.equal(await autoFinish(board, master, deps([verdict(fx, "not-done", ["missing"])])), "asked");
  board.onRun(e => { if (e.kind === "finishReady") seen.push([master.autoRounds, master.mergeRetries]); });
  events.push(hook("SessionStart", next, { source: "clear" }));
  if (read === "separate") board.syncStatus(master.id);
  events.push(hook("UserPromptSubmit", next, { prompt: "Correct the title." }));
  if (read === "separate") board.syncStatus(master.id);
  events.push(hook("Stop", old), hook("Stop", next));
  board.syncStatus(master.id, true);
  assert.deepEqual([master.sessionId, seen], [next, [[0, 0]]]);
});

for (const resumed of [false, true]) test(`F97: a direct Codex correction on the ${resumed ? "resumed" : "same"} terminal can be interrupted and followed up`, async () => {
  const fx = fixture({ upstream: false }), { board, master } = runFor(fx);
  board.update(master, { headless: false, provider: "codex", autoRounds: 2, mergeRetries: 1 });
  const events = board.events(master.id), writes = [], seen = [];
  const term = { sendText: text => writes.push(text) };
  board.terminal = () => term;
  board.deliverEveryTurns = () => 0;
  delete board.send;
  let t = Date.now(), terminalLaunch;
  const hook = (hook_event_name, extra = {}) => ({ t: ++t, session_id: master.sessionId, hook_event_name, terminal_launch_id: terminalLaunch, ...extra });
  events.push(hook("SessionStart"), hook("Stop"));
  assert.equal(await autoFinish(board, master, deps([verdict(fx, "not-done", ["missing"])])), "asked");
  board.onRun(e => { if (e.kind === "finishReady") seen.push(e); });
  if (resumed) {
    events.push(hook("SessionEnd"));
    board.codexModelReady = board.ensureCodexTrust = async () => {};
    board.launch = (_task, _resume, _prompt, launchId) => { terminalLaunch = launchId; return term; };
    await board.resume(master);
    events.push(hook("SessionStart", { source: "resume" }), hook("Stop"));
    board.syncStatus(master.id);
    assert.deepEqual([master.autoRounds, master.mergeRetries, seen], [2, 1, []]);
  }
  const send = () => board.send(master, "Try again", true, "confirm-submit");
  events.push(hook("UserPromptSubmit", { prompt: "Fix the missing title." }));
  board.syncStatus(master.id);
  assert.deepEqual([master.status, master.autoRounds, master.mergeRetries], ["running", 0, 0]);
  events.push(hook("Interrupt"));
  board.syncStatus(master.id);
  assert.deepEqual([master.status, master.interrupted, seen], ["review", true, []]);
  assert.throws(() => board.send(master, "Auto repair", false, "automatic-submit"), /waiting on a prompt/);
  events.push(hook("PermissionRequest", { agent_id: "child" }));
  assert.throws(send, /waiting on a prompt/);
  events.push(hook("SubagentStop", { agent_id: "child" }));
  await send();
  // On Windows a Codex follow-up is two writes: the paste, then its Enter once Codex's paste burst is over (typeInto).
  const sent = process.platform === "win32" ? ["\u001b[200~Try again\u001b[201~", "\r"] : ["\u001b[200~Try again\u001b[201~\r"];
  assert.deepEqual(writes, sent);
  if (resumed) {
    events.push(hook("SessionEnd"), hook("Interrupt"));
    assert.throws(send, /waiting on a prompt/);
    events.push(hook("SessionStart", { source: "resume" }), hook("Stop", { terminal_launch_id: "old" }),
      hook("Stop", { session_id: "foreign" }), hook("Stop", { agent_id: "child" }), hook("Interrupt"));
    assert.throws(send, /waiting on a prompt/, "this session lifecycle has no Stop from its owner");
    assert.deepEqual(writes, sent, "a refused send writes nothing");
  }
});

test("F97: /clear replaces the stopped Claude session before a composer send", async () => {
  const fx = fixture(), { board, master } = runFor(fx);
  board.update(master, { headless: false, autoRounds: 2, mergeRetries: 1 });
  const events = board.events(master.id), writes = [];
  const term = { sendText: text => writes.push(text) };
  board.terminal = () => term;
  delete board.send;
  const old = master.sessionId, next = "cleared-session";
  let time = Date.now();
  const hook = (session_id, hook_event_name, fields = {}) => ({ t: ++time, session_id, hook_event_name, ...fields });
  events.push(hook(old, "Stop"));
  assert.equal(await autoFinish(board, master, deps([verdict(fx, "not-done", ["missing"])])), "asked");
  const send = () => board.send(master, "Follow up", true, "confirm-submit");
  events.push(hook(next, "SessionStart", { source: "clear" }), hook(old, "Stop"));
  assert.throws(send, /waiting on a prompt/, "the click can beat the watcher");
  events.push(hook(next, "SessionStart", { source: "resume" }), hook(next, "PermissionRequest"));
  board.syncStatus(master.id);
  assert.equal(master.sessionId, next);
  assert.equal(board.approvalWaits(master).session, true);
  assert.throws(send, /waiting on a prompt/);
  events.push(hook(next, "PostToolUse"), hook(old, "Stop"));
  assert.equal(board.approvalWaits(master).session, false);
  assert.throws(send, /waiting on a prompt/, "only the replacement can supply the required Stop");
  assert.deepEqual([writes, master.autoRounds, master.mergeRetries], [[], 2, 1]);
  events.push(hook(next, "Stop"));
  await send();
  assert.deepEqual(writes, ["\u001b[200~Follow up\u001b[201~\r"]);
});

for (const tag of ["cross-session-message", "agent-message"]) test(`F97: <${tag}> preserves the review wait and a child's unanswered approval`, async () => {
  const fx = fixture(), { board, master } = runFor(fx);
  board.update(master, { headless: false, autoRounds: 2, mergeRetries: 1 });
  const events = board.events(master.id), writes = [];
  board.terminal = () => ({ sendText: text => writes.push(text) });
  delete board.send;
  let time = Date.now();
  const hook = (hook_event_name, fields = {}) => ({ t: ++time, session_id: master.sessionId, hook_event_name, ...fields });
  events.push(hook("Stop"));
  assert.equal(await autoFinish(board, master, deps([verdict(fx, "not-done", ["missing"])])), "asked");
  events.push(hook("PermissionRequest", { agent_id: "A" }), hook("UserPromptSubmit", { prompt: `<${tag} from="B">Completed</${tag}>` }), hook("Stop"));
  board.syncStatus(master.id);
  assert.deepEqual([master.status, master.autoRounds, master.mergeRetries], ["needs-input", 2, 1]);
  assert.deepEqual(board.approvalWaits(master).children, ["A"]);
  assert.throws(() => board.send(master, "Follow up", true, "confirm-submit"), /waiting on a prompt/);
  assert.deepEqual(writes, []);
  events.push(hook("UserPromptSubmit", { prompt: `<${tag}-example> is the element to fix.` }), hook("Stop"));
  board.syncStatus(master.id);
  assert.deepEqual([master.status, master.autoRounds, master.mergeRetries, board.approvalWaits(master).children], ["review", 0, 0, []]);
});

test("F97: child, foreign, blank and notification hooks cannot refund an exhausted review", async () => {
  const fx = fixture(), { board, master } = runFor(fx);
  board.update(master, { headless: false, autoRounds: 2, mergeRetries: 1 });
  board.terminal = () => ({});
  const events = board.events(master.id);
  assert.equal(await autoFinish(board, master, deps([verdict(fx, "not-done", ["still missing"])])), "asked");
  let at = Date.parse(master.statusAt);
  const emit = (fields) => events.push({ t: ++at, hook_event_name: "UserPromptSubmit", session_id: master.sessionId, prompt: "Repair it.", ...fields });
  emit({ agent_id: "child" }); emit({ session_id: "foreign" }); emit({ prompt: "  " }); emit({ prompt: "<task-notification>done</task-notification>" });
  board.syncStatus(master.id);
  let finishes = 0;
  board.onRun(e => { if (e.kind === "finishReady") finishes++; });
  emit({ hook_event_name: "Stop", session_id: "foreign" });
  board.syncStatus(master.id);
  assert.deepEqual([master.status, master.autoRounds, master.mergeRetries, finishes], ["needs-input", 2, 1, 0]);
  assert.equal(master.selfFinish.step, "Not done after 2 automatic rounds.");
});

test("F97: a paused interactive run receives no automatic terminal repair", async () => {
  const fx = fixture(), { board, master } = runFor(fx);
  board.update(master, { headless: false, paused: true, autoRounds: 1, mergeRetries: 0 });
  const writes = [];
  board.terminal = () => ({ sendText: text => writes.push(text) });
  delete board.send;
  board.events(master.id).push({ hook_event_name: "Stop", session_id: master.sessionId, t: Date.now() });
  assert.equal(await autoFinish(board, master, deps([verdict(fx, "not-done", ["missing"])])), "stopped");
  assert.match(master.selfFinish.error, /Run paused/);
  assert.deepEqual([master.autoRounds, writes], [1, []]);
});

test("auto-finish: a second automatic Not done with the same unmet conditions stops in Needs input instead of sending the same prompt again", async () => {
  const fx = fixture({ kids: 1 });
  const { board, master, followUps } = runFor(fx);
  const before = sh(fx.origin, "rev-parse", "main");
  const d = deps([verdict(fx, "not-done", ["A", "B"]), verdict(fx, "not-done", ["B", "A"])]);
  assert.equal(await autoFinish(board, master, d), "sent-back");
  assert.equal(await autoFinish(board, master, d), "asked");
  assert.equal(followUps.length, 1);
  assert.equal(master.selfFinish.step, "The same conditions are still unmet after an automatic round.");
  assert.equal(master.status, "needs-input");
  assert.equal(sh(fx.origin, "rev-parse", "main"), before);
});

test("auto-finish: an indexed review agrees with a saved unnumbered unmet condition", async () => {
  const fx = fixture({ kids: 1 });
  const { board, master, followUps } = runFor(fx);
  const previous = verdict(fx, "not-done", ["B", "A"]);
  const current = verdict(fx, "not-done", ["A", "B"]);
  current.findings.forEach((f, i) => { f.conditionIndex = i + 1; });
  board.update(master, { autoRounds: 1, doneReview: { ...previous, sent: "auto" } }); // saved before separate merge retries
  assert.equal(await autoFinish(board, master, deps([current])), "asked");
  assert.equal(master.selfFinish.step, "The same conditions are still unmet after an automatic round.");
  assert.equal(followUps.length, 0);
});

test("auto-finish: progress between two conditions with identical wording earns the next round", async () => {
  const fx = fixture({ kids: 1 });
  const { board, master, followUps } = runFor(fx);
  const rounds = [1, 2].map(unmet => {
    const review = verdict(fx, "not-done", ["A"]);
    review.findings = [1, 2].map(conditionIndex => ({
      conditionIndex, condition: "A", status: conditionIndex === unmet ? "not-met" : "met", evidence: "file:1",
    }));
    return review;
  });
  const d = deps(rounds);
  assert.equal(await autoFinish(board, master, d), "sent-back");
  assert.equal(await autoFinish(board, master, d), "sent-back");
  assert.equal(followUps.length, 2);
});

test("auto-finish: numbered results with different finding text still refer to the same fixed declaration", async () => {
  const fx = fixture(), { board, master, followUps } = runFor(fx);
  const replies = ["The required file is absent.", "a.txt has not been created."].map(label => {
    const review = verdict(fx, "not-done", [label]);
    review.findings[0].conditionIndex = 1;
    return review;
  });
  const d = deps(replies);
  assert.equal(await autoFinish(board, master, d), "sent-back");
  const { owner, saved } = reopenRun(fx, board, master, followUps);
  assert.equal(await autoFinish(owner, saved, d), "asked");
  assert.equal(saved.selfFinish.step, "The same conditions are still unmet after an automatic round.");
  assert.equal(followUps.length, 1);
});

test("auto-finish: Unsure waits in Needs input with the questions and pushes nothing", async () => {
  const fx = fixture({ kids: 1 });
  const { board, master, followUps, needsYou } = runFor(fx);
  const before = sh(fx.origin, "rev-parse", "main");
  assert.equal(await autoFinish(board, master, deps([verdict(fx, "unsure")])), "asked");
  assert.equal(master.status, "needs-input");
  assert.deepEqual(master.doneReview.questions, [{ question: "Is c1.txt enough?", suggested: "Yes." }]);
  assert.ok(master.finishAsked, "Send answers continues the finish with a Done (the reviewWork case)");
  assert.deepEqual(followUps, []);
  assert.equal(needsYou.length, 1);
  assert.equal(sh(fx.origin, "rev-parse", "main"), before);
  assert.equal(fs.existsSync(fx.children[0].worktree), true);
  assert.deepEqual(errorLog(board).map((e) => [e.level, e.outcome, e.stage, e.message]), [["info", "waiting", "Automatic finish: Reviewing the run", "The reviewer is unsure: its questions are on the card."]]);
});

function conflictingChild() {
  const fx = fixture({ kids: 1 });
  // The master changed a.txt after the child branched; the child changed the same line.
  fs.writeFileSync(path.join(fx.worktree, "a.txt"), "one\ntwo\nmaster\n"); sh(fx.worktree, "commit", "-qam", "master change");
  fs.writeFileSync(path.join(fx.children[0].worktree, "a.txt"), "one\ntwo\nchild\n"); sh(fx.children[0].worktree, "commit", "-qam", "child change");
  return fx;
}

test("auto-finish: repeated child merge failures stop after two merge prompts and push nothing", async () => {
  const fx = conflictingChild();
  const { board, master, followUps } = runFor(fx);
  const before = sh(fx.origin, "rev-parse", "main"), head = sh(fx.worktree, "rev-parse", "HEAD");
  const d = deps([verdict(fx, "done")]);
  assert.equal(await autoFinish(board, master, d), "sent-back");
  assert.equal(followUps.length, 1);
  assert.match(followUps[0], /^Merging Child 1 \(task\/c1\) into your branch failed: .*conflict.*\. Merge it, resolve the conflict, commit, then call board\.js finish self again\.$/is);
  assert.deepEqual(d.calls, [], "no review before the children are merged");
  assert.deepEqual([master.mergeRetries, master.autoRounds, master.finishAsked], [1, undefined, undefined]);
  assert.equal(await autoFinish(board, master, d), "sent-back");
  assert.equal(await autoFinish(board, master, d), "stopped");
  assert.deepEqual([master.mergeRetries, master.autoRounds, followUps.length, master.status], [2, undefined, 2, "needs-input"]);
  assert.match(master.selfFinish.error, /Merge failed/);
  assert.deepEqual(d.calls, []);
  assert.equal(sh(fx.origin, "rev-parse", "main"), before, "the remote is unchanged");
  assert.deepEqual([sh(fx.worktree, "rev-parse", "HEAD"), sh(fx.worktree, "status", "--porcelain")], [head, ""], "the merge was aborted");
  assert.equal(fs.existsSync(fx.children[0].worktree), true);
});

function reopenRun(fx, board, master, followUps) {
  board.dispose();
  const owner = new Board(fx.repo, path.join(fx.repo, "hook.js"), undefined, false);
  boards.push(owner);
  owner.followUpHeadless = async (t, text) => { followUps.push(text); };
  return { owner, saved: owner.get(master.id) };
}

// Only the provider answer is scripted. The real review input and validator assign the condition numbers.
function numberedReview(fx, board, unmetNumber, message) {
  return async task => {
    const scope = await reviewInput(board, task);
    const conditions = runConditions(scope.doneWhen, scope.children);
    const result = { ...verdict(fx, "not-done", [conditions[unmetNumber - 1]]), explanation: message, prompt: message };
    const findings = conditions.map((condition, i) => ({ condition, conditionIndex: i + 1, status: i + 1 === unmetNumber ? "not-met" : "met", evidence: message }));
    return { ...result, ...validReview({ ...result, findings }, scope) };
  };
}

for (const [scenario, original, changed, firstNumber, nextNumber, outcome] of [
  ["paraphrased finding", "A\nB", "A\nB", 1, 1, "asked"],
  ["reordered declarations", "A\nB", "B\nA", 1, 2, "asked"],
  ["replacement rule", "A\nB", "C\nB", 1, 1, "sent-back"],
  ["replacement child", "A\nB", "A\nB", 3, 3, "sent-back"],
  ["different unmet rule", "A\nB", "A\nB", 1, 2, "sent-back"],
  ["ambiguous duplicate after reorder", "A\nA\nB", "B\nA\nA", 2, 2, "sent-back"],
]) test(`auto-finish after conflict and reload: ${scenario}`, async () => {
  const fx = conflictingChild();
  const { board, master, children: [child], followUps } = runFor(fx);
  board.update(master, { completion: { commands: [], doneWhen: original } });
  const before = sh(fx.origin, "rev-parse", "main");
  const d = deps([numberedReview(fx, board, firstNumber, "The required output is missing.")]);
  assert.equal(await autoFinish(board, master, d), "sent-back");
  assert.deepEqual([master.mergeRetries, master.autoRounds, d.calls.length], [1, undefined, 0]);
  sh(fx.worktree, "merge", "-q", "--no-edit", "-X", "ours", fx.children[0].branch);
  board.update(master, { finishAsked: { at: new Date().toISOString() } });
  assert.equal(await autoFinish(board, master, d), "sent-back");
  assert.equal(master.doneReview.sent, "auto");
  const { owner, saved } = reopenRun(fx, board, master, followUps);
  assert.deepEqual([saved.mergeRetries, saved.autoRounds], [1, 1]);
  assert.deepEqual(saved.doneReview.declarations, [...original.split("\n").map(s => [null, s]), [child.id, child.completion.doneWhen]]);
  if (scenario === "replacement child") {
    owner.update(owner.get(child.id), { openedBy: undefined });
    const replacement = owner.add("Replacement", child.prompt);
    owner.update(replacement, { openedBy: saved.id, status: "done", completion: child.completion });
  }
  owner.update(saved, { finishAsked: { at: new Date().toISOString() }, completion: { ...saved.completion, doneWhen: changed } });
  const next = numberedReview(fx, owner, nextNumber, "Create the output that is still absent.");
  assert.equal(await autoFinish(owner, saved, deps([next])), outcome);
  if (outcome === "asked") {
    assert.equal(saved.selfFinish.step, "The same conditions are still unmet after an automatic round.");
    assert.deepEqual([saved.autoRounds, saved.status, followUps.length, saved.doneReview.sent], [1, "needs-input", 2, undefined]);
  } else {
    assert.deepEqual([saved.autoRounds, followUps.length, saved.doneReview.sent], [2, 3, "auto"]);
  }
  assert.equal(saved.mergeRetries, 1);
  assert.equal(sh(fx.origin, "rev-parse", "main"), before);
});

for (const [history, reviewCount, mergeCount] of [
  ["merges only", 0, 2], ["merges already resolved before reload", 0, 2], ["mixed", 1, 1], ["review charges", 2, 0],
]) test(`auto-finish migrates a persisted combined budget: ${history}`, async () => {
  const fx = conflictingChild(), { board, master, followUps } = runFor(fx);
  const previous = verdict(fx, "not-done", ["Earlier condition"]);
  board.update(master, { autoRounds: 2, ...(reviewCount ? { doneReview: { ...previous, sent: "auto" } } : {}) });
  if (history === "mixed") {
    const conflict = "Merging Child 1 (task/c1) into your branch failed: conflict. Merge it, resolve the conflict, commit, then call board.js finish self again.";
    fs.writeFileSync(board.eventsFile(master.id), [master.prompt, previous.prompt, conflict].map(prompt => JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt })).join("\n") + "\n");
  }
  const { owner, saved } = reopenRun(fx, board, master, followUps);
  const d = deps([numberedReview(fx, owner, 1, "Create the missing output.")]);
  if (history === "merges only") {
    assert.equal(await autoFinish(owner, saved, d), "stopped", "two old conflicts leave no third merge prompt");
    assert.equal(followUps.length, 0);
    assert.equal(d.calls.length, 0);
  }
  sh(fx.worktree, "merge", "-q", "--no-edit", "-X", "ours", fx.children[0].branch);
  assert.equal(await autoFinish(owner, saved, d), reviewCount === 2 ? "asked" : "sent-back");
  assert.deepEqual([saved.mergeRetries, saved.autoRounds], [mergeCount, Math.min(2, reviewCount + 1)]);
  assert.equal(followUps.length, reviewCount === 2 ? 0 : 1);
});

test("auto-finish: checks that fail after merging the remote's latest stop before the push", async () => {
  const fx = fixture({ kids: 1 });
  pushFromOther(fx, "c.txt", "theirs\n");
  const { board, master, needsYou } = runFor(fx, { commands: ["exit 1"] });
  const pushes = pushCounter(fx);
  assert.equal(await autoFinish(board, master, deps([verdict(fx, "done")])), "stopped");
  assert.equal(pushes(), 0, "a failed check: no push");
  // BUG-14: with no catalogue in the repo the command still ran under a limit, the default one (10 minutes x 3).
  assert.deepEqual(lastChecks(board, master).job.limitsMs, [30 * 60_000]);
  assert.equal(sh(fx.origin, "log", "--oneline", "main").includes("task change"), false, "the remote does not have the master's commit");
  assert.match(master.selfFinish.error, /Acceptance check 1 failed/);
  assert.equal(master.status, "needs-input");
  assert.deepEqual(needsYou, [master.selfFinish.error]);
  // Logged once, by Finish itself, at the step it stopped in; autoFinish does not log it again.
  assert.deepEqual(errorLog(board).map((e) => [e.action, e.outcome, e.stage]), [["finish", "failed", "Running the acceptance checks"]]);
  assert.equal(fs.existsSync(fx.worktree), true, "the master's worktree is kept");
  assert.equal(fs.existsSync(fx.children[0].worktree), true, "nothing is deleted");
  assert.ok(sh(fx.repo, "branch", "--list", "task/c1"));
});

test("auto-finish: a check that runs past its catalogue minutes times the factor is killed and reported as a failed check; nothing is pushed", async () => {
  const fx = fixture({ kids: 1 });
  // It sleeps 120 s and must be killed well before: 20 s with a 15 s bound failed at 25.8 s under the board's full-suite load (12 November 2026).
  const slow = `node -e "setTimeout(() => {}, 120000)"`;
  // 0.001 minutes x 3 = 180 ms
  fs.mkdirSync(path.join(fx.repo, "workflows"), { recursive: true });
  fs.writeFileSync(path.join(fx.repo, "workflows", "checks.json"), JSON.stringify({ slow: { run: slow, minutes: 0.001 } }));
  const { board, master } = runFor(fx, { commands: [slow] });
  const pushes = pushCounter(fx);
  const started = Date.now();
  assert.equal(await autoFinish(board, master, deps([verdict(fx, "done")])), "stopped");
  assert.ok(Date.now() - started < 60000, "it did not wait for the check to end by itself");
  assert.ok(master.selfFinish.error.startsWith(`Finish stopped while running the acceptance checks: Acceptance check 1 timed out: ${slow} ran past its limit of 0.2 seconds and was stopped.`), master.selfFinish.error);
  assert.equal(master.status, "needs-input");
  assert.equal(pushes(), 0, "a stuck check: no push");
  assert.equal(sh(fx.origin, "log", "--oneline", "main").includes("task change"), false);
  assert.equal(fs.existsSync(fx.worktree), true);
  // The default when the catalogue gives no minutes, and with no catalogue at all.
  const { checkLimitsMs, CHECK_TIME_FACTOR, DEFAULT_CHECK_MINUTES } = require("../out/checks.js");
  assert.deepEqual(checkLimitsMs([slow, "npm test"], { slow: { run: slow, minutes: 2 } }), [2 * CHECK_TIME_FACTOR * 60_000, DEFAULT_CHECK_MINUTES * CHECK_TIME_FACTOR * 60_000]);
  assert.deepEqual(checkLimitsMs(["npm test"], undefined), [DEFAULT_CHECK_MINUTES * CHECK_TIME_FACTOR * 60_000]);
});

// ---- BUG-14 (19 November 2026): what each outcome of the checks before the push does to the delivery. The limits are short ones set
// through the fixture's catalogue, as the real ones are set (workflows/checks.json of the main folder); the pushes are counted at the
// remote itself. The check commands keep their files in ../ of the master's worktree: .entomatical/wt, ignored, and in no worktree.

/** How many pushes origin has accepted on main since this call: its reflog gets one entry for each. */
function pushCounter(fx) {
  sh(fx.origin, "config", "core.logAllRefUpdates", "always");
  const entries = () => sh(fx.origin, "reflog", "show", "--format=%H", "main").split("\n").filter(Boolean).length;
  const before = entries();
  return () => entries() - before;
}
/** The fixture's check catalogue: each command with its minutes (its limit is minutes x 3). */
function catalogueFor(fx, entries) {
  fs.mkdirSync(path.join(fx.repo, "workflows"), { recursive: true });
  fs.writeFileSync(path.join(fx.repo, "workflows", "checks.json"), JSON.stringify(Object.fromEntries(entries.map(([run, minutes], i) => [`check-${i + 1}`, { run, minutes }]))));
}
/** The card's newest check run: the job the worker was given, and what it recorded. */
function lastChecks(board, master) {
  const dir = path.join(board.dir, "checks", master.id), run = path.join(dir, fs.readdirSync(dir).sort((a, b) => Number(a) - Number(b)).at(-1));
  const read = (name) => JSON.parse(fs.readFileSync(path.join(run, name), "utf8"));
  return { job: read("job.json"), receipt: read("receipt.json"), check: (i) => read(`check-${i}.json`) };
}
const beside = (fx, name) => path.join(fx.worktree, "..", name);
/** The pid a check command wrote to ../pid once it started. Up to 60 s: a shell and node start slowly under the whole suite. */
async function checkPid(fx) {
  for (let i = 0; i < 600; i++) {
    const pid = fs.existsSync(beside(fx, "pid")) ? Number(fs.readFileSync(beside(fx, "pid"), "utf8")) : 0;
    if (pid) return pid;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the check command did not start within 60 s");
}
/** Waits for a check command that wrote ../pid to be gone: a stopped one holds the worktree as its folder until it is. */
async function checkEnded(fx) {
  const pid = fs.existsSync(beside(fx, "pid")) ? Number(fs.readFileSync(beside(fx, "pid"), "utf8")) : 0;
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; pid && i < 300 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
}
/** A delivery that was prevented: nothing reached the remote, and the candidate is whole for the next try. Returns that candidate. */
function keptForRetry(fx, board, master, pushes) {
  assert.equal(pushes(), 0, "nothing was pushed");
  assert.equal(sh(fx.origin, "log", "--oneline", "main").includes("task change"), false, "the remote does not have the master's commit");
  assert.equal(fs.existsSync(fx.worktree), true, "the master's worktree is kept");
  assert.deepEqual([sh(fx.worktree, "rev-parse", "--abbrev-ref", "HEAD"), sh(fx.worktree, "status", "--porcelain")], [fx.branch, ""], "on its branch, with nothing uncommitted");
  const log = sh(fx.worktree, "log", "--oneline");
  for (const commit of [/task change/, /child 1 work/]) assert.match(log, commit);
  assert.equal(fs.existsSync(fx.children[0].worktree), true, "no child is cleaned up");
  assert.ok(sh(fx.repo, "branch", "--list", "task/c1"));
  assert.ok(master.finishAsked, "its request to finish stands");
  assert.equal(board.completing.size, 0, "and nothing holds the card");
  return sh(fx.worktree, "rev-parse", "HEAD");
}
/** The next try delivered it: one push, of exactly the candidate that was kept. */
function deliveredOnce(fx, master, pushes, candidate) {
  assert.equal(pushes(), 1, "exactly one push");
  assert.equal(sh(fx.origin, "rev-parse", "main"), candidate, "of the candidate that was kept");
  assert.deepEqual([master.status, fs.existsSync(fx.worktree), master.finishAsked], ["done", false, undefined]);
}

test("BUG-14: only checks that pass inside their limit let the push go. One candidate is kept through a failed check, one ended from outside, one stopped at its limit and one that passed while the master worked again; then it is pushed once", async () => {
  const fx = fixture({ kids: 1 });
  // One check command for every try; ../mode says what it does this time. fail: exits 1. work: 1.5 s of work, then 0. hold: goes on
  // until ../go exists. (Its text has no "timeout" in it: the error log reads that word in a message as an outcome.)
  const check = `node -e "const fs = require('fs'), mode = fs.readFileSync('../mode', 'utf8'); fs.writeFileSync('../pid', String(process.pid)); if (mode === 'fail') process.exit(1); setInterval(() => { if (mode === 'work' || fs.existsSync('../go')) process.exit(0); }, mode === 'work' ? 1500 : 50)"`;
  const { board, master } = runFor(fx, { commands: [check] });
  const pushes = pushCounter(fx);
  /** One finish with the check in this mode under this estimate; during: what happens once the check command runs. */
  const attempt = async (mode, minutes, during) => {
    fs.rmSync(beside(fx, "pid"), { force: true });
    fs.writeFileSync(beside(fx, "mode"), mode);
    catalogueFor(fx, [[check, minutes]]);
    const finishing = autoFinish(board, master, deps([verdict(fx, "done")]));
    if (during) await during(await checkPid(fx));
    return finishing;
  };
  const stoppedAt = "Finish stopped while running the acceptance checks: ";
  // 2 minutes x 3 = 6 minutes wherever the limit must not be what ends it: a loaded machine has taken 25 s to start and end one check.

  // 1. It fails.
  assert.equal(await attempt("fail", 2), "stopped");
  assert.ok(master.selfFinish.error.startsWith(`${stoppedAt}Acceptance check 1 failed: ${check} exited with 1.`), master.selfFinish.error);
  let run = lastChecks(board, master);
  assert.deepEqual([run.job.limitsMs, run.check(0).exitCode, run.check(0).timedOut, run.receipt.checksPassed], [[6 * 60_000], 1, undefined, false]);
  assert.equal(master.status, "needs-input");
  const candidate = keptForRetry(fx, board, master, pushes);

  // 2. It is ended from outside before it finishes: Task Manager, an out-of-memory kill, a Stop that reaches it.
  const started = Date.now();
  assert.equal(await attempt("hold", 2, (pid) => process.kill(pid)), "stopped");
  assert.ok(Date.now() - started < 5 * 60_000, "it ended when the command was ended, before its limit");
  // Windows: PowerShell reports an ended native command as 1. Elsewhere: the shell's 143, or no exit code when the signal ended it.
  assert.match(master.selfFinish.error, /^Finish stopped while running the acceptance checks: Acceptance check 1 failed: .* exited with (1|143|null)\./);
  run = lastChecks(board, master);
  assert.deepEqual([run.check(0).timedOut, run.receipt.checksPassed], [undefined, false], "ended, not timed out");
  assert.equal(keptForRetry(fx, board, master, pushes), candidate);

  // 3. It is slower than its limit. 0.002 minutes x 3 = 360 ms for 1.5 s of work: an estimate under what the check takes, as the
  // catalogue's two minutes were under the suite's six and a half.
  assert.equal(await attempt("work", 0.002), "stopped");
  assert.ok(master.selfFinish.error.startsWith(`${stoppedAt}Acceptance check 1 timed out: ${check} ran past its limit of 0.4 seconds and was stopped.`), master.selfFinish.error);
  run = lastChecks(board, master);
  assert.deepEqual([run.job.limitsMs, run.check(0).timedOut, run.receipt.status, run.receipt.checksPassed], [[360], true, "error", false]);
  assert.equal(keptForRetry(fx, board, master, pushes), candidate);
  await checkEnded(fx);

  // 4. It passes, but the master started working while it ran (the user's follow-up, a notice that woke it).
  assert.equal(await attempt("hold", 2, () => { board.update(master, { status: "running" }); fs.writeFileSync(beside(fx, "go"), ""); }), "stopped");
  run = lastChecks(board, master);
  assert.deepEqual([run.receipt.status, run.receipt.checksPassed], ["complete", true], "the checks themselves passed");
  assert.ok(master.selfFinish.error.startsWith(`${stoppedAt}It started working while its acceptance checks ran, so nothing was pushed.`), master.selfFinish.error);
  assert.equal(master.status, "running", "a working card keeps its column");
  assert.equal(keptForRetry(fx, board, master, pushes), candidate);
  board.update(master, { status: "review" }, undefined, true); // its turn ended (quiet: this board starts no check run of its own here)

  // The board's error log has one line for each, at the step they stopped in.
  assert.deepEqual(errorLog(board).map((e) => [e.action, e.outcome, e.stage]), ["failed", "failed", "timeout", "refused"].map((outcome) => ["finish", outcome, "Running the acceptance checks"]));

  // 5. The check of try 3 again, with its estimate above its measured time: it passes inside its limit, and the candidate is pushed.
  assert.equal(await attempt("work", 2), "finished");
  deliveredOnce(fx, master, pushes, candidate);
});

test("BUG-14: this repository's full-suite checks give Finish room for the slowest measured healthy run behind two queued full runs, and stay finite", () => {
  const { checkLimitsMs, readCatalogue } = require("../out/checks.js");
  // Slowest healthy full run measured on a supported host: Windows, 521.3 s (docs/evidence/bug-14-2026-11-23/README.md).
  // The suite lock queues full runs, and the deadline counts that wait (Linux: 79 s of a 186 s Finish check).
  const slowestMs = 521_300, catalogue = readCatalogue(path.join(__dirname, ".."));
  for (const name of ["test", "parent-test"]) {
    const [limit] = checkLimitsMs([catalogue[name].run], catalogue);
    assert.ok(limit >= 3 * slowestMs, `${name}: ${limit} ms cannot hold a run behind two others`);
    assert.ok(limit <= 60 * 60_000, `${name}: ${limit} ms no longer stops a stalled suite within the hour`);
  }
});

test("auto-finish holds a missing required file when its sole producer was cancelled", async () => {
  const fx = fixture({ kids: 1 });
  const { board, master, children: [producer] } = runFor(fx);
  board.update(producer, { cancelled: true, status: "review" });
  const before = sh(fx.origin, "rev-parse", "main");
  const delegated = verdict(fx, "done");
  delete delegated.wholeRunEvidence;
  delegated.findings = [{ condition: "c1.txt exists.", status: "left-to-child", evidence: producer.title }];
  const saved = { ...delegated, snapshot: await worktreeSnapshot(master.worktree) };
  const d = deps([async () => {
    const input = await reviewInput(board, master);
    assert.ok(!input.candidateFiles.includes("c1.txt"));
    const claimed = verdict(fx, "done");
    claimed.findings[1].evidence = "File: a.txt"; // recycle the master's real output for the missing child deliverable
    return { ...claimed, ...validReview(claimed, input) };
  }]);
  const result = await autoFinish(board, master, d, saved);
  assert.equal(sh(fx.origin, "rev-parse", "main"), before, "delivery must not start");
  assert.equal(master.status, "needs-input");
  assert.notEqual(result, "finished");
  assert.match(master.selfFinish.error, /evidence.*c1\.txt/);
  assert.equal(d.calls.length, 1);
  assert.ok(!fs.existsSync(path.join(master.worktree, "c1.txt")));
  assert.ok(fs.existsSync(path.join(producer.worktree, "c1.txt")));
});

test("auto-finish holds a required file deleted from the candidate even when the reviewer cites its genuine diff", async () => {
  const fx = fixture();
  const { board, master } = runFor(fx);
  const before = sh(fx.origin, "rev-parse", "main");
  fs.unlinkSync(path.join(master.worktree, "a.txt"));
  let deliveries = 0;
  board.completeHeld = async () => { deliveries++; };
  const result = await autoFinish(board, master, deps([async () => {
    const input = await reviewInput(board, master);
    assert.match(input.work.diff, /deleted file mode/);
    assert.ok(!input.candidateFiles.includes("a.txt"));
    const claimed = verdict(fx, "done");
    return { ...claimed, ...validReview(claimed, input) };
  }]));
  assert.notEqual(result, "finished");
  assert.match(master.selfFinish.error, /evidence.*a\.txt/);
  assert.deepEqual([deliveries, master.status, sh(fx.origin, "rev-parse", "main")], [0, "needs-input", before]);
});

test("auto-finish accepts direct evidence for a required unchanged file in the original tree", async () => {
  const fx = fixture({ existingFile: "kept.md" });
  const { board, master } = runFor(fx);
  board.update(master, { completion: { commands: [], doneWhen: "kept.md exists." } });
  const result = await autoFinish(board, master, deps([async () => {
    const input = await reviewInput(board, master);
    assert.doesNotMatch(input.work.diff, /kept\.md/);
    assert.ok(input.candidateFiles.includes("kept.md"));
    const claimed = { ...verdict(fx, "done"), findings: [{ conditionIndex: 1, condition: "kept.md exists.", status: "met", evidence: "File: kept.md" }] };
    return { ...claimed, ...validReview(claimed, input) };
  }]));
  assert.equal(result, "finished");
  assert.equal(sh(fx.origin, "show", "main:kept.md"), "already delivered");
});

test("auto-finish accepts a verified spelling edit and a rename from a historical path", async () => {
  const fx = fixture({ existingFile: "README.md", existingContent: "The relase is ready.\n" });
  const { board, master } = runFor(fx);
  const edit = "Correct the spelling error in README.md.", rename = "Rename a.txt to guide.txt.";
  board.update(master, { completion: { commands: [], doneWhen: edit + "\n" + rename } });
  fs.writeFileSync(path.join(master.worktree, "README.md"), "The release is ready.\n");
  sh(master.worktree, "mv", "a.txt", "guide.txt");
  const claimed = { ...verdict(fx, "done"), findings: [
    { conditionIndex: 1, condition: edit, status: "met", evidence: "File: README.md\nQuote: The release is ready.\nWhy: The new sentence fixes 'relase' to 'release'." },
    { conditionIndex: 2, condition: rename, status: "met", evidence: "Removed: a.txt\nFile: guide.txt\nQuote: two\nWhy: The guide contains the original two lines under its new name." },
  ] };
  const result = await autoFinish(board, master, deps([async () => {
    const input = await reviewInput(board, master);
    assert.ok(input.work.removed.includes("a.txt"));
    const validate = (findings) => validReview({ ...claimed, findings }, input);
    const [a, b] = claimed.findings;
    assert.throws(() => validate([{ ...a, evidence: a.evidence.replace("The release is ready.", "Invented line.") }, b]), /evidence/);
    assert.throws(() => validate([{ ...a, evidence: "File: README.md\nQuote: The release is ready." }, b]), /evidence/);
    assert.throws(() => validate([a, { ...b, evidence: a.evidence }]), /evidence/);
    return { ...claimed, ...validate([a, b]) };
  }]));
  assert.equal(result, "finished", master.selfFinish?.error);
  assert.equal(sh(fx.origin, "show", "main:README.md"), "The release is ready.");
  assert.equal(sh(fx.origin, "show", "main:guide.txt"), "one\ntwo");
  assert.ok(!sh(fx.origin, "ls-tree", "--name-only", "main").includes("a.txt"));
});

test("auto-finish accepts the developer's explicit waiver for the named output of a cancelled child", async () => {
  const fx = fixture({ kids: 1 });
  const { board, master, children: [producer] } = runFor(fx);
  board.update(producer, { cancelled: true, status: "review", completion: undefined, prompt: "Deliver c1.txt.\nUse the agreed format." });
  const condition = `[${producer.id}] ${producer.prompt}`;
  const waiver = `Waive: 2. ${condition.replace(/\s+/g, " ")}`;
  const question = `Should this output be omitted? To approve, reply with this line:\n${waiver}`;
  board.update(master, { doneReview: { ...verdict(fx, "unsure"), questions: [{ question, suggested: "" }] } });
  const claimed = { ...verdict(fx, "done"), findings: [
    { conditionIndex: 1, condition: "a.txt exists.", status: "met", evidence: "File: a.txt" },
    { conditionIndex: 2, condition, status: "met", evidence: waiver },
  ] };
  const declined = await reviewInput(board, master, question + "\nKeep it required.");
  assert.throws(() => validReview(claimed, declined), /evidence.*c1\.txt/);
  const prompts = board.prompts.bind(board);
  board.prompts = t => [...prompts(t), { text: waiver }];
  assert.throws(() => validReview(claimed, { ...declined, followUps: [waiver] }), /evidence.*c1\.txt/);
  assert.deepEqual((await reviewInput(board, master)).approvalLines, [], "a session message cannot authorize a waiver");
  board.prompts = prompts;
  master.doneReview.questions[0].suggested = waiver;
  const prefilled = await reviewInput(board, master, question + "\n" + waiver);
  assert.throws(() => validReview(claimed, prefilled), /evidence.*c1\.txt/);
  master.doneReview.questions[0].suggested = "";
  const approved = await reviewInput(board, master, question + "\n" + waiver);
  const manual = { ...claimed, ...validReview(claimed, approved), snapshot: await worktreeSnapshot(master.worktree) };
  // A later tree edit requires fresh file evidence. A verified waiver for the same named condition survives that review.
  fs.writeFileSync(path.join(master.worktree, "extra.txt"), "a later edit\n");
  const d = deps([async () => {
    const fresh = await reviewInput(board, master);
    assert.deepEqual(fresh.approvalLines, [waiver]);
    return { ...claimed, ...validReview(claimed, fresh) };
  }]);
  assert.equal(await autoFinish(board, master, d, manual), "finished");
  assert.equal(d.calls.length, 1);
  assert.ok(fs.readFileSync(master.selfFinish.report, "utf8").includes(waiver));
  assert.ok(!sh(fx.origin, "ls-tree", "--name-only", "main").includes("c1.txt"));
  assert.ok(fs.existsSync(path.join(producer.worktree, "c1.txt")));
});

test("auto-finish: a cancelled child with commits not in the run's branch keeps its worktree and branch and is named in the report", async () => {
  const fx = fixture({ kids: 2 });
  const { board, master, children: [one, two] } = runFor(fx);
  board.update(two, { cancelled: true, status: "review" });
  fs.writeFileSync(path.join(master.worktree, "c2.txt"), "delivered by the master\n");
  const hooks = path.join(board.dir, "hooks", `${two.id}.json`);
  fs.writeFileSync(hooks, "{}");
  assert.equal(await autoFinish(board, master, deps([verdict(fx, "done")])), "finished");
  const remote = sh(fx.origin, "log", "--oneline", "main");
  assert.match(remote, /child 1 work/);
  assert.equal(remote.includes("child 2 work"), false, "a cancelled card is not merged");
  assert.equal(sh(fx.origin, "show", "main:c2.txt"), "delivered by the master");
  assert.equal(fs.existsSync(fx.children[0].worktree), false);
  assert.equal(fs.existsSync(fx.children[1].worktree), true);
  assert.ok(sh(fx.repo, "branch", "--list", "task/c2"));
  // Left behind as it was: its column, its worktree and branch, and its temporary files.
  assert.deepEqual([one.status, two.status, two.cancelled, two.worktree], ["done", "review", true, fx.children[1].worktree]);
  assert.equal(fs.existsSync(hooks), true);
  assert.match(fs.readFileSync(master.selfFinish.report, "utf8"), /## Left behind\n\n- "Child 2"/);
});

test("auto-finish: a master that is running when finishReady fires, or starts during the review, is left untouched", async () => {
  const fx = fixture({ dirty: true, kids: 1 });
  const { board, master } = runFor(fx);
  board.update(master, { status: "running" }); // a follow-up, or a notice that woke it
  board.update(master, { finishAsked: { at: "x" } }); // running cleared delivery ready, not the request
  const head = sh(fx.worktree, "rev-parse", "HEAD"), before = sh(fx.origin, "rev-parse", "main");
  const d = deps([verdict(fx, "done")]);
  assert.equal(await autoFinish(board, master, d), "stopped");
  assert.deepEqual([d.calls, master.status, master.finishAsked, master.selfFinish], [[], "running", { at: "x" }, undefined]);
  assert.deepEqual([sh(fx.worktree, "rev-parse", "HEAD"), sh(fx.worktree, "status", "--porcelain")], [head, "?? b.txt"], "nothing committed or merged");
  assert.equal(sh(fx.origin, "rev-parse", "main"), before);
  // It starts while the review runs: nothing is pushed, and the card keeps running with its request.
  board.update(master, { status: "review" });
  const e = deps([]);
  e.review = async () => { board.update(master, { status: "running" }); return verdict(fx, "done"); };
  assert.equal(await autoFinish(board, master, e), "stopped");
  assert.deepEqual([master.status, !!master.finishAsked, master.selfFinish], ["running", true, undefined]);
  assert.equal(sh(fx.origin, "rev-parse", "main"), before);
  assert.equal(fs.existsSync(fx.children[0].worktree), true);
  // A failure while it runs names the error, but never moves a running card to Needs input.
  board.update(master, { status: "review" });
  e.review = async () => { board.update(master, { status: "running" }); throw new Error("Stopped after fifteen minutes without an answer."); };
  assert.equal(await autoFinish(board, master, e), "stopped");
  assert.deepEqual([master.status, master.selfFinish.error], ["running", "Stopped after fifteen minutes without an answer."]);
  // Nor while its checks run after a Stop (busyWith): the card keeps its column.
  board.update(master, { status: "review" });
  e.review = async () => { board.recordChecks(master, { status: "running", run: path.join(board.dir, "checks", master.id, "1") }); throw new Error("The reviewer failed."); };
  assert.equal(await autoFinish(board, master, e), "stopped");
  assert.deepEqual([master.status, master.selfFinish.error], ["review", "The reviewer failed."]);
});

test("auto-finish: a manual Done from before the merge is reviewed again once a child is merged; that Not done stops the push", async () => {
  const fx = fixture({ kids: 1 });
  const { board, master, followUps } = runFor(fx);
  const before = sh(fx.origin, "rev-parse", "main");
  const d = deps([verdict(fx, "not-done", ["c1.txt exists."])]);
  assert.equal(await autoFinish(board, master, d, { ...verdict(fx, "done"), snapshot: await worktreeSnapshot(fx.worktree) }), "sent-back");
  assert.deepEqual(d.calls, [{ auto: true }], "the merged state is reviewed");
  assert.match(sh(fx.worktree, "log", "--oneline", "-3"), /Merge branch 'task\/c1'/);
  assert.deepEqual([followUps.length, sh(fx.origin, "rev-parse", "main")], [1, before], "nothing is pushed");
  // Nothing to commit or merge, and the worktree as the reviewer read it: the manual Done stands, with no second review.
  const fy = fixture();
  const b = runFor(fy), e = deps([]);
  assert.equal(await autoFinish(b.board, b.master, e, { ...verdict(fy, "done"), snapshot: await worktreeSnapshot(fy.worktree) }), "finished");
  assert.deepEqual(e.calls, []);
  assert.match(sh(fy.origin, "log", "--oneline", "main"), /task change/);
});

test("auto-finish: a failure after the push leaves the master Done, with the error on the card and in the report", async () => {
  const fx = fixture();
  // A child's worktree outside .entomatical/wt, which discardWorktree refuses to delete.
  const outside = path.join(fx.root, "outside-c1");
  sh(fx.repo, "worktree", "add", "-q", "-b", "task/c1", outside, "task/t1");
  fs.writeFileSync(path.join(outside, "c1.txt"), "child 1\n"); sh(outside, "add", "."); sh(outside, "commit", "-qm", "child 1 work");
  fx.children.push({ worktree: outside, branch: "task/c1" });
  const { board, master, needsYou } = runFor(fx);
  assert.equal(await autoFinish(board, master, deps([verdict(fx, "done")])), "finished");
  assert.match(sh(fx.origin, "log", "--oneline", "main"), /child 1 work/);
  assert.equal(master.status, "done");
  assert.match(master.selfFinish.error, /^Cleaning up stopped: .*is not a task worktree of this repo/);
  assert.match(fs.readFileSync(master.selfFinish.report, "utf8"), /## Notes\n\n- Cleaning up stopped: /);
  assert.deepEqual(needsYou, [master.selfFinish.error]);
  assert.equal(fs.existsSync(outside), true);
});

test("auto-finish: a plan-run master is refused with canReview's text and waits in Needs input", async () => {
  const fx = fixture({ kids: 1 });
  const { board, master } = runFor(fx);
  board.update(master, { planRun: { name: "p", file: "p.json", review: "checks" } });
  const before = sh(fx.origin, "rev-parse", "main"), d = deps([verdict(fx, "done")]);
  assert.equal(await autoFinish(board, master, d), "stopped");
  assert.deepEqual([master.selfFinish.error, master.status, d.calls], ["A plan's own reviewer judges this card.", "needs-input", []]);
  assert.equal(sh(fx.origin, "rev-parse", "main"), before);
});

test("auto-finish: a card that is not a run's master is never finished unattended", async () => {
  const fx = fixture();
  const { board, task } = boardFor(fx);
  board.update(task, { finishAsked: { at: new Date().toISOString() } });
  const before = sh(fx.origin, "rev-parse", "main"), d = deps([verdict(fx, "done")]);
  assert.equal(await autoFinish(board, task, d), "stopped");
  assert.equal(task.selfFinish.error, "Only a run's master card finishes by itself.");
  assert.deepEqual([d.calls, sh(fx.origin, "rev-parse", "main"), fs.existsSync(fx.worktree)], [[], before, true]);
});

test("auto-finish: a second finishReady for the same master while it finishes does not run a second finish beside it", async () => {
  const fx = fixture({ kids: 1 });
  const { board, master } = runFor(fx);
  let release;
  const d = deps([new Promise((r) => { release = r; })]);
  const first = autoFinish(board, master, d);
  assert.equal(await autoFinish(board, master, d), "stopped");
  // the user's Finish button meanwhile is refused too: no unchecked push, no worktree deleted under the run.
  await assert.rejects(run(board, master), /is already being finished/);
  assert.equal(fs.existsSync(fx.worktree), true);
  release(verdict(fx, "done"));
  assert.equal(await first, "finished");
  assert.equal(d.calls.length, 1, "the run finished, so the remembered trigger has nothing left to do");
  assert.equal(board.completing.size, 0);
});

test("auto-finish: a finishReady that arrives while a run is under way is not lost: autoFinish runs again once that run leaves", async () => {
  const fx = fixture({ kids: 1 });
  const { board, master } = runFor(fx);
  let second;
  // While the first review reads, the master's next Stop sends finishReady again; that review comes back Unsure.
  const d = deps([async () => { second = autoFinish(board, master, d); return verdict(fx, "unsure"); }, verdict(fx, "done")]);
  assert.equal(await autoFinish(board, master, d), "finished");
  assert.equal(await second, "stopped", "the trigger itself only waits");
  assert.equal(d.calls.length, 2, "the remembered trigger reviewed the run again");
  assert.match(sh(fx.origin, "log", "--oneline", "main"), /child 1 work/);
});

test("auto-finish: a master edit made while the review reads is never pushed unreviewed: a second review runs on the new state", async () => {
  const fx = fixture({ kids: 1 });
  const { board, master, followUps } = runFor(fx);
  const before = sh(fx.origin, "rev-parse", "main");
  // the user typed to the master during the review: it edited a file and stopped again before the verdict came back.
  const edit = (fixture, text) => async (t) => { fs.writeFileSync(path.join(t.worktree, "late.txt"), text); return verdict(fixture, "done"); };
  const d = deps([edit(fx, "late\n"), verdict(fx, "not-done", ["late.txt is wrong."])]);
  assert.equal(await autoFinish(board, master, d), "sent-back");
  assert.equal(d.calls.length, 2, "the Done did not cover the edit, so the new state was reviewed");
  assert.deepEqual([followUps, sh(fx.origin, "rev-parse", "main")], [["Reopen a card for late.txt is wrong.."], before]);
  // It changes again during that second review: nothing is pushed, and it waits in Needs input with the request kept (no later Stop may come).
  const fy = fixture({ kids: 1 });
  const b = runFor(fy), e = deps([edit(fy, "one\n"), edit(fy, "two\n")]);
  const was = sh(fy.origin, "rev-parse", "main");
  assert.equal(await autoFinish(b.board, b.master, e), "asked");
  const changed = "The run's files changed while it was being reviewed, so the push waits for you.";
  assert.deepEqual([e.calls.length, sh(fy.origin, "rev-parse", "main"), !!b.master.finishAsked, b.master.status, b.master.selfFinish.step], [2, was, true, "needs-input", changed]);
  assert.deepEqual(b.needsYou, [changed]);
  assert.equal(fs.readFileSync(path.join(fy.worktree, "late.txt"), "utf8"), "two\n", "the edit stays where it was made");
});

test("auto-finish: a Done whose worktree state could not be recorded waits in Needs input and pushes nothing", async () => {
  const fx = fixture({ kids: 1 });
  const { board, master, needsYou } = runFor(fx);
  const before = sh(fx.origin, "rev-parse", "main");
  const d = deps([]);
  d.review = async () => verdict(fx, "done"); // runDoneReview's worktreeSnapshot threw (a diff over git()'s buffer): no snapshot
  assert.equal(await autoFinish(board, master, d), "asked");
  const text = "The worktree state could not be recorded, so the push waits for you.";
  assert.deepEqual([master.status, master.selfFinish.step, !!master.finishAsked], ["needs-input", text, true]);
  assert.deepEqual(needsYou, [text]);
  assert.equal(sh(fx.origin, "rev-parse", "main"), before, "nothing is pushed");
  assert.equal(fs.existsSync(fx.children[0].worktree), true);
});

test("auto-finish: a manual Done whose snapshot no longer matches the worktree triggers a fresh review", async () => {
  const fx = fixture({ kids: 1 });
  const { board, master } = runFor(fx);
  sh(fx.worktree, "merge", "-q", "--no-edit", "task/c1"); // the run is merged when the user reviews it
  const manual = { ...verdict(fx, "done"), snapshot: await worktreeSnapshot(fx.worktree) };
  fs.writeFileSync(path.join(fx.worktree, "after.txt"), "made after the review\n"); sh(fx.worktree, "add", "."); sh(fx.worktree, "commit", "-qm", "after the review");
  const d = deps([verdict(fx, "done")]);
  assert.equal(await autoFinish(board, master, d, manual), "finished");
  assert.deepEqual(d.calls, [{ auto: true }]);
  assert.match(sh(fx.origin, "log", "--oneline", "main"), /after the review/);
});

test("updateLocal leaves the owner's own merge in progress alone: it throws and their resolved files stay", async () => {
  const fx = fixture({ upstream: false });
  sh(fx.repo, "checkout", "-q", "-b", "side"); fs.writeFileSync(path.join(fx.repo, "a.txt"), "side\n"); sh(fx.repo, "commit", "-qam", "side");
  sh(fx.repo, "checkout", "-q", "main"); fs.writeFileSync(path.join(fx.repo, "a.txt"), "main\n"); sh(fx.repo, "commit", "-qam", "main");
  assert.throws(() => execFileSync("git", ["merge", "side"], { cwd: fx.repo, stdio: "ignore" }));
  fs.writeFileSync(path.join(fx.repo, "a.txt"), "resolved\n"); sh(fx.repo, "add", "a.txt");
  await assert.rejects(f.updateLocal(fx.repo, fx.branch, { target: "main", dirty: [], commits: [], mainDirty: [], overlap: [] }), /merge is already in progress/);
  assert.equal(fs.readFileSync(path.join(fx.repo, "a.txt"), "utf8"), "resolved\n");
  assert.ok(sh(fx.repo, "rev-parse", "-q", "--verify", "MERGE_HEAD"), "the owner's merge is still in progress");
});

test("stageAll refuses a worktree with unmerged paths: nothing is staged or committed", async () => {
  const fx = fixture();
  sh(fx.repo, "checkout", "-q", "-b", "side"); fs.writeFileSync(path.join(fx.repo, "a.txt"), "side\n"); sh(fx.repo, "commit", "-qam", "side"); sh(fx.repo, "checkout", "-q", "main");
  assert.throws(() => execFileSync("git", ["merge", "side"], { cwd: fx.worktree, stdio: "ignore" }));
  const head = sh(fx.worktree, "rev-parse", "HEAD");
  await assert.rejects(f.stageAll(fx.worktree), /unresolved merge conflicts in a\.txt/);
  assert.equal(sh(fx.worktree, "diff", "--name-only", "--diff-filter=U"), "a.txt", "still unmerged, not marked resolved");
  assert.equal(sh(fx.worktree, "rev-parse", "HEAD"), head);
});

test("pushTask: a [remote rejected] push (a hook said no) throws instead of being retried as a moved remote", async () => {
  const fx = fixture();
  const hook = path.join(fx.origin, "hooks", "pre-receive");
  fs.writeFileSync(hook, "#!/bin/sh\necho protected >&2\nexit 1\n"); fs.chmodSync(hook, 0o755);
  await assert.rejects(f.pushTask(fx.worktree, { target: "main", remote: "origin", remoteBranch: "main", dirty: [], commits: [], mainDirty: [], overlap: [] }), /Push to origin\/main failed:[^]*remote rejected/);
});

// the user, 11 November 2026: when the remote does not accept Finish, whatever the reason, the Finish button asks the card's own
// session whether to fix the cause (src/extension.ts askCard). The board keeps the refusal's type, step and what was done.
test("a push the remote refuses stops Finish with a RemoteRefused carrying git's words, the step and what was done; nothing is pushed", async () => {
  const fx = fixture({ dirty: true });
  const hook = path.join(fx.origin, "hooks", "pre-receive");
  fs.writeFileSync(hook, "#!/bin/sh\necho protected branch: GH006 >&2\nexit 1\n"); fs.chmodSync(hook, 0o755);
  const { board, task, sent } = boardFor(fx);
  const e = await run(board, task).then(() => undefined, (x) => x);
  assert.ok(e instanceof f.RemoteRefused, `a RemoteRefused, not ${e}`);
  assert.match(e.message, /^Finish stopped while pushing to origin\/main: Push to origin\/main failed:[^]*protected branch: GH006[^]*Already done: Committed 1 file\.[^]*The worktree was kept\.$/);
  assert.equal(e.step, "Pushing to origin/main");
  assert.deepEqual(e.done, ["Committed 1 file."]);
  assert.equal(e.remoteRef, "origin/main");
  assert.match(e.said, /protected branch: GH006/);
  assert.equal(fs.existsSync(fx.worktree), true);
  assert.notEqual(task.status, "done");
  assert.ok(!task.merged);
  assert.equal(sh(fx.origin, "log", "--oneline", "main").includes("Commit by Finish"), false);
  assert.deepEqual(sent, []); // the board sends nothing itself: the Finish button asks the session

  const prompt = f.refusalPrompt(task.title, fx.branch, e);
  assert.match(prompt, /^Entomatical note: the user pressed Finish on the task "Finish me", and origin\/main did not accept it while pushing to origin\/main\./);
  assert.match(prompt, /Already done: Committed 1 file\./);
  assert.match(prompt, /```\n[^]*protected branch: GH006[^]*\n```/);
  assert.match(prompt, /Do not edit or create files, commit, merge, rebase, push, or change any setting yet\./);
  assert.match(prompt, /End your reply with exactly one question: "Shall I go ahead and fix this\?" Then stop and wait for the user's answer\./);
  assert.match(prompt, /do not push or merge/);
});

test("a fetch the remote refuses is a RemoteRefused too; a conflict the helper cannot resolve stays a plain error", async () => {
  const fx = fixture();
  fs.renameSync(fx.origin, `${fx.origin}-gone`);
  const { board, task } = boardFor(fx);
  const e = await run(board, task).then(() => undefined, (x) => x);
  assert.ok(e instanceof f.RemoteRefused, `a RemoteRefused, not ${e}`);
  assert.equal(e.step, "Merging with origin/main");
  assert.match(e.message, /^Finish stopped while merging with origin\/main: Could not fetch origin\/main:[^]*Nothing was changed\. The worktree was kept\.$/);
  assert.equal(fs.existsSync(fx.worktree), true);

  const fy = fixture();
  pushFromOther(fy, "a.txt", "remote line\n");
  const b = boardFor(fy);
  const c = await run(b.board, b.task, { helpers: { resolve: async () => ({ code: 1, output: "could not tell" }) } }).then(() => undefined, (x) => x);
  assert.match(String(c?.message), /conflicts in a\.txt/);
  assert.equal(c instanceof f.RemoteRefused, false);
});

test("refusalPrompt keeps at most 20 lines of git's message and cannot be closed early by a fence in it", () => {
  const r = new f.RemoteRefused("x", ["```", ...Array.from({ length: 30 }, (_, i) => `remote: line ${i + 1}`)].join("\n"), "origin/main");
  const prompt = f.refusalPrompt("T", "task/t", r);
  assert.match(prompt, /remote: line 19\n/);
  assert.doesNotMatch(prompt, /remote: line 20/);
  assert.equal(prompt.match(/```/g).length, 2);
  assert.match(prompt, /did not accept it\. Finish stopped there/); // no step known: no "while"
});
/** Delivers the card's work to the main folder as the board does at a Review reached another way, and waits for it. */
async function deliverFirst(fx, board, task) {
  fs.writeFileSync(path.join(fx.worktree, "b.txt"), "delivered\n");
  board.update(task, { status: "running" });
  board.update(task, { status: "review" }, undefined, true);
  let p; do { p = board.deliveries; await p; } while (p !== board.deliveries);
  assert.ok(task.delivery?.sha, JSON.stringify(task.delivery));
  assert.equal(fs.readFileSync(path.join(fx.repo, "b.txt"), "utf8"), "delivered\n");
}

test("Finish after a delivery, with a remote: still pushes, local main follows, the worktree goes", async () => {
  const fx = fixture();
  const { board, task } = boardFor(fx);
  await deliverFirst(fx, board, task);
  assert.doesNotMatch(sh(fx.origin, "log", "--oneline", "main"), /task change/); // delivery never pushes
  await run(board, task);
  assert.match(sh(fx.origin, "log", "--oneline", "main"), /task change/);
  assert.equal(sh(fx.repo, "rev-parse", "main"), sh(fx.origin, "rev-parse", "main"));
  assert.equal(fs.existsSync(fx.worktree), false);
  assert.equal(sh(fx.repo, "branch", "--list", fx.branch), "");
  assert.equal(task.status, "done");
  assert.equal(task.merged, true);
});

test("Finish after a delivery, with no remote: finds the work already in main and removes the worktree", async () => {
  const fx = fixture({ upstream: false });
  sh(fx.repo, "remote", "remove", "origin");
  const { board, task } = boardFor(fx);
  await deliverFirst(fx, board, task);
  const head = sh(fx.repo, "rev-parse", "main");
  await run(board, task);
  assert.equal(sh(fx.repo, "rev-parse", "main"), head); // nothing more to merge
  assert.equal(fs.existsSync(fx.worktree), false);
  assert.equal(sh(fx.repo, "branch", "--list", fx.branch), "");
  assert.equal(task.status, "done");
  assert.equal(task.merged, true);
});

// ---- A delivery and a Finish never write one checkout at the same time (M-05's delivery part, 19 November 2026).

/** Until the board's delivery queue is empty. */
const drained = async (board) => { let p; do { p = board.deliveries; await p; } while (p !== board.deliveries); };
/**
 * Holds the deliveries into one checkout inside deliver() until release(), and writes "delivery in" and "delivery out" on
 * `timeline`. Told apart by checkoutId: out/deliver.js's deliver is one function for every board this file has opened.
 * out: called as a delivery leaves, before anything that waited for it goes on.
 */
function holdDeliveries(repo, timeline, out = () => undefined) {
  const mod = require("../out/deliver.js"), real = mod.deliver, target = mod.checkoutId(repo);
  let inside, release;
  const entered = new Promise((r) => { inside = r; }), open = new Promise((r) => { release = r; });
  const held = async (...args) => {
    if (mod.checkoutId(args[0]) !== target) return real(...args);
    timeline.push("delivery in");
    inside();
    try { await open; return await real(...args); } finally { timeline.push("delivery out"); out(); }
  };
  mod.deliver = held;
  return { entered, release, restore() { release(); if (mod.deliver === held) mod.deliver = real; } };
}
/**
 * Finish's own wait for a running delivery writes "finish waits", and the held delivery is let go 50 ms later. A Finish that never
 * asks leaves the delivery held to the end; one that asks and does not wait (deliveryIdle() with no await) has those 50 ms, and
 * then the whole delivery, to go on by itself: what it did by then is read in holdDeliveries' `out`, as the delivery leaves.
 */
function releaseWhenFinishWaits(board, gate, timeline, seen = () => undefined) {
  const idle = board.deliveryIdle.bind(board);
  board.deliveryIdle = () => { seen(); timeline.push("finish waits"); setTimeout(gate.release, 50); return idle(); };
}
/** The fixture with no remote: Finish merges into the local main, as a delivery does. */
function localFixture(options) {
  const fx = fixture({ ...options, upstream: false });
  sh(fx.repo, "remote", "remove", "origin");
  return fx;
}
/** A second card of the same board, on a worktree of its own from main, with one commit adding `file`. */
function otherCard(fx, board, file) {
  const worktree = path.join(fx.repo, ".entomatical", "wt", "t2");
  sh(fx.repo, "worktree", "add", "-q", "-b", "task/t2", worktree, "main");
  fs.writeFileSync(path.join(worktree, file), "other\n");
  sh(worktree, "add", "."); sh(worktree, "commit", "-qm", "other card's work");
  const task = board.add("Other card", "Do the other work");
  board.update(task, { worktree, branch: "task/t2", status: "review" });
  return task;
}
/** The card writes b.txt and reaches Review another way (Esc, the session gone): the board delivers its work at once. */
function reachReview(fx, board, task) {
  fs.writeFileSync(path.join(fx.worktree, "b.txt"), "delivered\n");
  board.update(task, { status: "running" });
  board.update(task, { status: "review" }, undefined, true);
}
const full = (dir, rev) => sh(dir, "rev-parse", rev);
/** The commits of `branch` that added `file`. */
const added = (dir, file, branch = "main") => sh(dir, "log", "--diff-filter=A", "--format=%H", branch, "--", file).split("\n").filter(Boolean);
const filesAt = (dir, rev) => sh(dir, "ls-tree", "-r", "--name-only", rev).split("\n");

// A Merge or Discard of a card that is held already does not wait: it is refused (CORE-DEL-3, 23 November 2026; the next test).
test("Finish and Merge that start during another card's delivery wait for it: neither does anything before the delivery has left", { timeout: 300_000 }, async () => {
  for (const how of ["Finish", "Merge"]) {
    const fx = localFixture();
    const { board, task } = boardFor(fx);
    const other = otherCard(fx, board, "other.txt");
    const timeline = [];
    let asDeliveryLeft; // what the other card's Finish had done by then: nothing
    const gate = holdDeliveries(fx.repo, timeline, () => { asDeliveryLeft ??= { steps: timeline.filter((l) => l.startsWith("finish: ")), merged: other.merged, status: other.status, inMain: filesAt(fx.repo, "main").includes("other.txt") }; });
    try {
      reachReview(fx, board, task);
      await gate.entered; // the first card's delivery is inside deliver(), held
      assert.deepEqual([board.deliveryRunning.id, fs.existsSync(path.join(fx.repo, "b.txt"))], [task.id, false]);
      releaseWhenFinishWaits(board, gate, timeline);
      if (how === "Finish") await run(board, other, { step: (s) => timeline.push(`finish: ${s}`) });
      else { await board.finish(other, "merge"); timeline.push("finish: merged"); }
      gate.release(); // only a Finish that never waited leaves it held until here
      await drained(board);
    } finally { gate.restore(); }
    assert.deepEqual(timeline.slice(0, 4), ["delivery in", "finish waits", "delivery out", how === "Finish" ? "finish: Checking the task" : "finish: merged"], how);
    assert.deepEqual(asDeliveryLeft, { steps: [], merged: undefined, status: "review", inMain: false }, `${how} went on while the delivery was under way`);
    // Both changes are in the main folder once. The delivery's receipt is the commit it left there, before the other card's merge.
    const receipt = full(fx.repo, task.delivery.sha);
    assert.deepEqual([added(fx.repo, "b.txt"), added(fx.repo, "other.txt").length], [[receipt], 1], how);
    assert.deepEqual(["b.txt", "other.txt"].map((f) => filesAt(fx.repo, receipt).includes(f)), [true, false], how);
    assert.deepEqual(["b.txt", "other.txt"].map((f) => filesAt(fx.repo, "main").includes(f)), [true, true], how);
    assert.equal(sh(fx.repo, "merge-base", receipt, "main"), receipt, how); // the delivered commit is under main's head
    assert.equal(sh(fx.repo, "status", "--porcelain"), "", how);
    assert.deepEqual([other.status, other.merged, fs.existsSync(path.join(fx.repo, ".entomatical", "wt", "t2"))], ["done", true, false], how);
    assert.deepEqual([task.status, fs.existsSync(fx.worktree), board.completing.size], ["review", true, 0], how); // the delivered card is not finished
  }
});

test("Merge and Discard of a card that is held already are refused while the delivery of its own worktree is under way: the work is delivered, and the worktree and branch stay", { timeout: 300_000 }, async () => {
  const fx = localFixture();
  const { board, task } = boardFor(fx);
  const timeline = [];
  const kept = () => [task.status, task.merged, fs.existsSync(path.join(fx.worktree, "b.txt")), sh(fx.repo, "branch", "--list", fx.branch) !== ""];
  const gate = holdDeliveries(fx.repo, timeline);
  try {
    reachReview(fx, board, task);
    await gate.entered; // the delivery is inside deliver(), held, with the card's worktree still to commit and merge in
    board.completing.set(task.id, "Finish"); // as an automatic finish of this card holds it while it waits for the same delivery
    // Before 19 November 2026 these went straight on, beside the delivery (M-05). They do not wait for the holder either: they are refused.
    await assert.rejects(board.finish(task, "merge"), /Finish is active on "Finish me": Merge was refused\. Nothing was changed\./);
    await assert.rejects(board.finish(task, "discard"), /Finish is active on "Finish me": Discard was refused\. Nothing was changed\./);
    timeline.push("refused");
    assert.deepEqual(kept(), ["review", undefined, true, true], "a refused Merge or Discard changed the card beside its delivery");
    assert.equal(fs.existsSync(path.join(fx.repo, "b.txt")), false, "and the delivery is still held: nothing has reached the main folder");
    board.completing.delete(task.id);
    gate.release();
    await drained(board);
  } finally { gate.restore(); }
  assert.deepEqual(timeline, ["delivery in", "refused", "delivery out"]);
  // The delivery was whole: its receipt is the main folder's head and added b.txt, once. The card keeps its worktree and branch.
  const receipt = full(fx.repo, task.delivery.sha);
  assert.deepEqual([receipt, added(fx.repo, "b.txt")], [full(fx.repo, "main"), [receipt]]);
  assert.equal(fs.readFileSync(path.join(fx.repo, "b.txt"), "utf8"), "delivered\n");
  assert.equal(sh(fx.repo, "status", "--porcelain"), "");
  assert.deepEqual([...kept(), board.completing.size], ["review", undefined, true, true, 0]);
});

test("a card that reaches Review while another card's Finish holds the main folder is delivered only after that Finish has left", { timeout: 300_000 }, async () => {
  const fx = localFixture();
  const { board, task } = boardFor(fx);
  board.deliveryPollMs = 5;
  const other = otherCard(fx, board, "other.txt");
  const timeline = [], gate = holdDeliveries(fx.repo, timeline);
  gate.release(); // nothing is held here: the gate only writes the timeline
  try {
    let atDialog, answer;
    const asked = new Promise((r) => { atDialog = r; }), go = new Promise((r) => { answer = r; });
    const finishing = run(board, other, { step: (s) => timeline.push(`finish: ${s}`), confirm: async () => { atDialog(); await go; return true; } })
      .then(() => timeline.push("finish left"));
    await asked; // Finish holds the main folder, at its dialog
    reachReview(fx, board, task);
    await new Promise((r) => setTimeout(r, 60)); // twelve of the delivery's polls: one that did not wait is inside deliver() at once
    assert.deepEqual(timeline.filter((l) => l.startsWith("delivery")), [], "no delivery starts while Finish holds the main folder");
    assert.deepEqual([board.deliveryQueued.has(task.id), board.deliveryRunning, task.delivery], [true, undefined, undefined]);
    answer();
    await finishing;
    await drained(board);
  } finally { gate.restore(); }
  assert.ok(timeline.includes("finish: Merging into main"), timeline.join(" | "));
  assert.deepEqual(timeline.slice(-3), ["finish left", "delivery in", "delivery out"], timeline.join(" | "));
  // Both changes are in the main folder once; the delivery came second, so its receipt is main's head and holds both.
  const receipt = full(fx.repo, task.delivery.sha);
  assert.equal(receipt, full(fx.repo, "main"));
  assert.deepEqual([added(fx.repo, "b.txt").length, added(fx.repo, "other.txt").length], [1, 1]);
  assert.deepEqual(["b.txt", "other.txt"].map((f) => filesAt(fx.repo, receipt).includes(f)), [true, true]);
  assert.equal(sh(fx.repo, "status", "--porcelain"), "");
  assert.deepEqual([other.status, other.merged, task.status, board.completing.size], ["done", true, "review", 0]);
});

test("auto-finish: a delivery of the master's own work that is under way is waited for before its worktree is committed or merged into", { timeout: 300_000 }, async () => {
  const fx = fixture({ dirty: true, kids: 1 });
  const { board, master } = runFor(fx);
  board.deliverEveryTurns = () => 1; // the Stop below is a delivery turn (by default every third is)
  const remote = full(fx.origin, "main"), head = full(fx.worktree, "HEAD");
  const timeline = [], d = deps([verdict(fx, "done")]);
  let atWait, afterDelivery;
  // As the delivery left: where the remote and the main folder were, and how far the automatic finish had come (no further).
  const gate = holdDeliveries(fx.repo, timeline, () => { afterDelivery ??= { remote: full(fx.origin, "main"), inMain: fs.existsSync(path.join(fx.repo, "b.txt")), step: master.selfFinish?.step, reviews: d.calls.length }; });
  // What the automatic finish had done when it first waited for the delivery: no review, no commit, b.txt still untracked.
  releaseWhenFinishWaits(board, gate, timeline, () => { atWait ??= { reviews: d.calls.length, head: full(fx.worktree, "HEAD"), dirty: sh(fx.worktree, "status", "--porcelain") }; });
  let outcome;
  try {
    // As the extension does: the master's Stop after `finish self` fires finishReady, and autoFinish starts on a timer.
    const finished = new Promise((resolve, reject) => board.onRun((e) => { if (e.kind === "finishReady") setTimeout(() => autoFinish(board, master, d).then(resolve, reject)); }));
    board.update(master, { status: "running" });
    board.update(master, { status: "review" }); // its Stop: the delivery starts and is held inside deliver(); finishReady fires
    await gate.entered;
    assert.equal(board.deliveryRunning.id, master.id);
    outcome = await finished;
    gate.release();
    await drained(board);
  } finally { gate.restore(); }
  assert.equal(outcome, "finished");
  assert.deepEqual(atWait, { reviews: 0, head, dirty: "?? b.txt" }, "the automatic finish wrote the worktree while its delivery was under way");
  assert.deepEqual(timeline.slice(0, 3), ["delivery in", "finish waits", "delivery out"]);
  // The delivery stayed local: when it left, b.txt was in the main folder and the remote was where it had been. Finish pushed it.
  assert.deepEqual(afterDelivery, { remote, inMain: true, step: "Closing the run's sessions", reviews: 0 });
  const receipt = full(fx.repo, master.delivery.sha);
  assert.deepEqual(added(fx.origin, "b.txt"), [receipt]); // once, by the delivery's commit, which Finish pushed with the rest
  assert.deepEqual(["b.txt", "c1.txt"].map((f) => filesAt(fx.origin, "main").includes(f)), [true, true]);
  assert.equal(full(fx.repo, "main"), full(fx.origin, "main"));
  assert.deepEqual([master.status, fs.existsSync(fx.worktree), board.completing.size], ["done", false, 0]);
});

// ---- FR2 / GAP-02 (19 November 2026): the vault as Finish's destination ----
// Everything is in the fixture's throwaway folder: a repo whose main still tracks an origin that is a DISABLED placeholder (a repo
// after it left GitHub), a local bare repository standing for the vault's mirror, and a fake helper, a node script that "uploads" by
// pushing main to that bare repository. Nothing here starts a real vault helper, a live vault or a key: the helper's program is this
// test's own node, and the terminal stand-in below refuses to start anything else.
const { spawn } = require("node:child_process");

/**
 * VS Code's terminal, as far as the vault helper uses it: createTerminal starts the program it is given with its arguments, a close
 * is reported with the program's exit code, and a terminal closed by hand (dispose) ends its program and reports no code.
 */
const closeListeners = new Set(), vaultTerminals = [];
vscode.window.onDidCloseTerminal = (l) => { closeListeners.add(l); return { dispose() { closeListeners.delete(l); } }; };
vscode.window.createTerminal = (options) => {
  assert.equal(options.shellPath, process.execPath, "these tests start only their own node as a vault helper");
  // strictEnv: the environment given is the whole of it. Without it VS Code adds the window's own and terminal.integrated.env.*.
  const child = spawn(options.shellPath, options.shellArgs, { cwd: options.cwd, env: options.strictEnv ? options.env : { ...process.env, ...options.env }, stdio: "ignore", windowsHide: true });
  let byHand = false;
  const term = { options, shown: undefined, exitStatus: undefined,
    processId: new Promise((r) => { child.once("spawn", () => r(child.pid)); child.once("error", () => r(undefined)); }),
    show(preserveFocus) { term.shown = { preserveFocus }; },
    dispose() { byHand = true; child.kill(); } };
  child.once("close", (code) => { term.exitStatus = { code: byHand || code === null ? undefined : code }; for (const l of [...closeListeners]) l(term); });
  vaultTerminals.push(term);
  return term;
};

/**
 * The fake helper. "push" pushes main to the fixture's bare repository (vault.git beside the script); "verify" exits 0 only when
 * that repository's main is the repo's main. ../mode says what push does this time: ok, fail (exit 3, after printing what looks
 * like a credential) or hang (waits for ../go, then pushes). Every run is a line in calls.jsonl, with the board's tasks.json as it
 * was when the helper started.
 */
const FAKE_VAULT = `const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const dir = __dirname, verb = process.argv[2], repo = process.cwd(), mirror = path.join(dir, "vault.git");
const read = (name, none) => { try { return fs.readFileSync(path.join(dir, name), "utf8").trim(); } catch { return none; } };
const mode = read("mode", "ok");
const env = { ...process.env }; delete env.GIT_TRACE2_EVENT; // the helper's own git is not Entomatical's
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
let board = ""; try { board = fs.readFileSync(path.join(repo, ".entomatical", "tasks.json"), "utf8"); } catch {}
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ verb, mode, pid: process.pid, args: process.argv.slice(2), board }) + "\\n");
if (verb === "verify") { let there = ""; try { there = git(mirror, "rev-parse", "main"); } catch {} process.exit(there && there === git(repo, "rev-parse", "main") ? 0 : 1); }
if (verb !== "push") process.exit(64);
const push = () => { git(repo, "push", "-q", mirror, "main:main"); process.exit(0); };
if (mode === "fail") { console.error("vault: PIN refused; token=ghp_abcdefghijklmnopqrstuvwx"); process.exit(3); }
if (mode === "hang") setInterval(() => { if (fs.existsSync(path.join(dir, "go"))) push(); }, 25);
else push();
`;

/** The fixture as a vault repo. settings: what entomatical.finish.vaults holds for it (a test may replace it). */
function vaultFixture({ verify = false, timeoutSeconds = 120, ...options } = {}) {
  const fx = fixture(options);
  // main still tracks origin, and origin's URL is a placeholder: a path that is not there, so git fails at once and reaches no network.
  sh(fx.repo, "remote", "set-url", "origin", "DISABLED-origin");
  assert.deepEqual([sh(fx.repo, "config", "branch.main.remote"), sh(fx.repo, "config", "branch.main.merge")], ["origin", "refs/heads/main"]);
  const mirror = path.join(fx.root, "vault.git"), script = path.join(fx.root, "fake-vault.js");
  sh(fx.root, "init", "-q", "--bare", "-b", "main", mirror);
  fs.writeFileSync(script, FAKE_VAULT);
  const entry = { name: "test vault", command: process.execPath, args: [script, "push"], ...(verify ? { verifyArgs: [script, "verify"] } : {}), timeoutSeconds };
  const calls = () => { try { return fs.readFileSync(path.join(fx.root, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { ...fx, mirror, script, entry, settings: { [fx.repo]: entry }, calls,
    mode: (m) => fs.writeFileSync(path.join(fx.root, "mode"), m), go: () => fs.writeFileSync(path.join(fx.root, "go"), ""),
    /** How many times the helper was started to upload, and to check. */
    uploads: () => calls().filter((c) => c.verb === "push").length, checks: () => calls().filter((c) => c.verb === "verify").length,
    /** main in the vault's mirror; "" while it has none. */
    inVault: () => { try { return sh(mirror, "rev-parse", "-q", "--verify", "refs/heads/main"); } catch { return ""; } },
    /** Merge commits Finish made on main (its first-parent line: a merge inside a task branch is not one of them). */
    merges: () => Number(sh(fx.repo, "rev-list", "--merges", "--first-parent", "--count", "main")) };
}
function vaultBoard(fx, options) {
  const made = boardFor(fx, options);
  made.board.vaultOf = () => fx.settings;
  return made;
}
const until = async (cond, what = "the condition") => {
  for (let i = 0; i < 3000; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`${what} did not come within 60 s`);
};
const seven = (sha) => sha.slice(0, 7);
/** the user's own Finish: the answer of the dialog that showed the vault and its command. Any other caller answers true (`yes`). */
const approve = async () => ({ upload: true });
const NO_APPROVAL = "this Finish had no approval to upload; only the user's own Finish or Upload to Vault starts one";
const pendingText = (sha, why, behind = true) => `Merged into main (${seven(sha)}) locally; upload to test vault pending: ${why}. ${behind ? "test vault is behind until it is uploaded." : "Check test vault before uploading again."}`;
/** One line per fixture in the test output: the named branch, the commit it keeps, merges into it, helper runs, and what the card says. */
const vaultLine = (t, name, fx, task) => t.diagnostic(`vault fixture "${name}": branch=${task.vault?.branch ?? "main"} retained=${sh(fx.repo, "rev-parse", "--short", "main")} merges=${fx.merges()} uploads=${fx.uploads()} status="${task.vault ? f.vaultStatus(task.vault) : "(no vault record)"}"`);

/** The command line of every git process started while `during` runs (GIT_TRACE2_EVENT), this test's own included: `during` runs none. */
async function gitCalls(fx, during) {
  const file = path.join(fx.root, `trace-${Math.random().toString(36).slice(2, 8)}.jsonl`), before = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = file;
  try { await during(); } finally { if (before === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = before; }
  const events = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return events.filter((e) => (e.event === "start" || e.event === "child_start") && Array.isArray(e.argv)).map((e) => (e.event === "start" ? e.argv.slice(1) : e.argv).join(" "));
}
/** A git command that talks to a remote (or a transport git starts for one), by its subcommand: options before it are passed over. */
function remoteGit(line) {
  const words = line.split(" ");
  let i = 0;
  while (i < words.length && words[i].startsWith("-")) i += words[i] === "-c" || words[i] === "-C" ? 2 : 1;
  return /^(git-)?(fetch|pull|push|ls-remote|clone|remote|submodule|send-pack|fetch-pack|upload-pack|receive-pack|remote-\w+|ssh|scp)(\.exe)?$/i.test(path.basename(words[i] ?? ""));
}

test("vault: only a repo the user listed has one, bound to an installed helper outside the repo with its fixed arguments; a setting that cannot be trusted as written is refused", () => {
  const fx = vaultFixture();
  assert.equal(f.vaultFor(undefined, fx.repo), undefined);
  assert.equal(f.vaultFor({}, fx.repo), undefined);
  assert.equal(f.vaultFor({ [path.join(fx.root, "another-repo")]: fx.entry }, fx.repo), undefined, "another repo's vault is not this one's");
  const dest = f.vaultFor(fx.settings, fx.repo);
  assert.deepEqual([dest.name, dest.command, dest.args, dest.verifyArgs, dest.timeoutMs], ["test vault", process.execPath, [fx.script, "push"], undefined, 120_000]);
  assert.ok(dest.display.includes(fx.script) && dest.display.endsWith(" push"), dest.display);
  if (process.platform === "win32") assert.equal(f.vaultFor({ [fx.repo.toUpperCase()]: fx.entry }, fx.repo).id, dest.id, "the same folder in another case");
  // What an approval is bound to: the program and its arguments. Its name and its limit are not part of it.
  assert.notEqual(f.vaultFor({ [fx.repo]: { ...fx.entry, args: [fx.script, "push", "--all"] } }, fx.repo).id, dest.id);
  assert.notEqual(f.vaultFor({ [fx.repo]: { ...fx.entry, verifyArgs: [fx.script, "verify"] } }, fx.repo).id, dest.id);
  assert.equal(f.vaultFor({ [fx.repo]: { ...fx.entry, name: "renamed", timeoutSeconds: 5 } }, fx.repo).id, dest.id);
  const refused = (entry, why) => assert.throws(() => f.vaultFor({ [fx.repo]: entry }, fx.repo),
    (e) => e.message.startsWith("The vault set for this repo in entomatical.finish.vaults cannot be used: ") && why.test(e.message), JSON.stringify(entry));
  refused({ command: "vault-helper", args: ["push"] }, /command must be the full path of the installed helper/); // a name looked up on PATH is not a named file
  refused({ command: path.join(fx.repo, "tools", "upload.js") }, /command is a file inside the repo, which any session can write/);
  refused({ command: path.join(fx.repo, "..helper") }, /command is a file inside the repo/); // a name that starts with two dots is not a way out of the folder
  refused({ command: process.execPath, args: "push" }, /args must be a list of strings/);
  refused({ command: process.execPath, args: [1] }, /args must be a list of strings/);
  refused({ command: process.execPath, verifyArgs: [] }, /verifyArgs must be a list of strings/);
  refused({ command: process.execPath, timeoutSeconds: 0 }, /timeoutSeconds must be a number from 1 to 3600/);
  refused("vault-helper push", /its value must be an object with a command/);
  assert.doesNotMatch(f.vaultFor({ [fx.repo]: { command: process.execPath, args: ["--token=ghp_abcdefghijklmnopqrstuvwx"] } }, fx.repo).display, /ghp_/, "an argument that looks like a credential is not shown");
  assert.match(f.vaultHelperMissing({ command: path.join(fx.root, "not-installed") }), /^its helper .*not-installed is not installed \(no such file\)$/);
  assert.equal(f.vaultHelperMissing(dest), undefined);
  // A file that is there but is no program is not started either: its terminal would only wait for the limit.
  const script = path.join(fx.root, process.platform === "win32" ? "helper.ps1" : "helper.sh");
  fs.writeFileSync(script, "exit 0\n", { mode: 0o644 });
  assert.match(f.vaultHelperMissing({ command: script }), process.platform === "win32" ? /is not a program Windows can start \(\.exe, \.com, \.cmd or \.bat\)$/ : /is not executable$/);
  // A setting that cannot be used stops Finish before it changes anything.
  const { board, task } = boardFor(fx);
  board.vaultOf = () => ({ [fx.repo]: { command: "vault-helper" } });
  return assert.rejects(run(board, task), /^Error: Finish stopped while checking the task: The vault set for this repo in entomatical\.finish\.vaults cannot be used: command must be the full path of the installed helper\..* Nothing was changed\. The worktree was kept\.$/)
    .then(() => assert.deepEqual([task.status, task.vault, fs.existsSync(fx.worktree), fx.merges()], ["review", undefined, true, 0]));
});

test("vault: Finish of a repo whose main still tracks a disabled origin merges locally, shows the vault before it asks, and uploads with the helper; no git command talks to a remote", async (t) => {
  const fx = vaultFixture();
  const { board, task } = boardFor(fx);
  // With no vault set, this repo finishes as it always did: to its upstream, which refuses (what card a761a7 met).
  let calls = await gitCalls(fx, async () => {
    await assert.rejects(run(board, task), (e) => e instanceof f.RemoteRefused && /^Finish stopped while merging with origin\/main: Could not fetch origin\/main/.test(e.message));
  });
  assert.ok(calls.some(remoteGit), `the trace sees the fetch Finish made: ${calls.join(" | ")}`);
  assert.deepEqual([task.status, task.vault, fx.merges(), fx.uploads(), fs.existsSync(fx.worktree)], ["review", undefined, 0, 0, true]);

  board.vaultOf = () => fx.settings;
  const steps = [];
  let shown;
  calls = await gitCalls(fx, async () => {
    assert.deepEqual(await run(board, task, { step: (s) => steps.push(s), confirm: async (plan) => { shown = plan; return { upload: true }; } }), []);
  });
  // Before the confirmation: the destination and the command it runs, and no remote.
  assert.deepEqual([shown.remote, shown.remoteBranch, shown.vault.name, shown.vault.command, shown.vault.args], [undefined, undefined, "test vault", process.execPath, [fx.script, "push"]]);
  assert.deepEqual(steps, ["Checking the task", "Closing the session", "Merging with main", "Merging into main", "Telling related sessions", "Deleting the worktree",
    "Uploading main to test vault: enter your PIN and touch the key when its terminal asks"]);
  assert.ok(calls.some((c) => /^merge /.test(c)), "the trace is of this Finish");
  assert.deepEqual(calls.filter(remoteGit), [], "no fetch, push, ls-remote or transport was started by Entomatical");
  const merged = sh(fx.repo, "rev-parse", "main");
  assert.deepEqual([task.status, task.merged, fs.existsSync(fx.worktree), sh(fx.repo, "branch", "--list", fx.branch), fx.merges()], ["done", true, false, "", 1]);
  assert.match(sh(fx.repo, "log", "--oneline", "main"), /task change/);
  const v = task.vault;
  assert.deepEqual([v.state, v.branch, v.sha, v.attempts, v.last.outcome, v.last.exitCode, v.uploaded.sha, v.destination.name, v.approved.by, v.running, v.why],
    ["uploaded", "main", merged, 1, "uploaded", 0, merged, "test vault", "user", undefined, undefined]);
  assert.deepEqual([fx.inVault(), fx.uploads()], [merged, 1], "the vault's mirror holds exactly the merged commit, from one run of the helper");
  // The helper ran as the setting says, in a terminal of its own that is not kept across a reload.
  const term = vaultTerminals.at(-1);
  assert.deepEqual([term.options.shellPath, term.options.shellArgs, term.options.cwd, term.options.isTransient, term.options.strictEnv, term.options.name, term.shown],
    [process.execPath, [fx.script, "push"], fx.repo, true, true, "Vault upload: test vault", { preserveFocus: false }]);
  // Its environment is this process's own and the whole of it (strictEnv): nothing is added, by Entomatical or by a terminal setting
  // a workspace file could hold, and Electron's and VS Code's own variables are left out. (The trace's variable was set for this run.)
  const given = Object.keys(term.options.env).filter((k) => k !== "GIT_TRACE2_EVENT");
  assert.ok(given.length > 3 && given.every((k) => term.options.env[k] === process.env[k]) && !given.some((k) => /^(ELECTRON_|VSCODE_)/i.test(k)), given.join(" "));
  assert.deepEqual(f.vaultHelperEnv({ PATH: "/bin", HOME: "/home/r", ELECTRON_RUN_AS_NODE: "1", VSCODE_PID: "7", vscode_ipc: "x", UNSET: undefined }), { PATH: "/bin", HOME: "/home/r" });
  // When the helper started, the board's file already said what was merged, on which branch, where it goes and that the upload was under way.
  const atStart = JSON.parse(fx.calls()[0].board).find((c) => c.id === task.id);
  assert.deepEqual([atStart.status, atStart.merged, atStart.worktree, atStart.vault.state, atStart.vault.sha, atStart.vault.branch, atStart.vault.destination.id, atStart.vault.attempts, atStart.vault.running.kind],
    ["done", true, undefined, "uploading", merged, "main", v.destination.id, 1, "upload"]);
  assert.equal(f.vaultStatus(v), `Merged into main (${seven(merged)}) and uploaded to test vault.`);
  assert.deepEqual(board.vaultWaiting(), []);
  vaultLine(t, "success", fx, task);
});

test("vault: a helper that refuses after the merge leaves main merged with the upload pending; the next approved try uploads that same commit, and nothing is merged again", async (t) => {
  const fx = vaultFixture();
  const { board, task } = vaultBoard(fx);
  fx.mode("fail");
  const notes = await run(board, task, { confirm: approve });
  const merged = sh(fx.repo, "rev-parse", "main");
  assert.deepEqual(notes, [pendingText(merged, "its helper refused it (exit 3)")]);
  assert.deepEqual([task.status, task.merged, fs.existsSync(fx.worktree), fx.merges(), fx.uploads(), fx.inVault()], ["done", true, false, 1, 1, ""]);
  assert.deepEqual([task.vault.state, task.vault.sha, task.vault.branch, task.vault.attempts, task.vault.last.outcome, task.vault.last.exitCode, task.vault.uncertain], ["pending", merged, "main", 1, "refused", 3, undefined]);
  assert.deepEqual(board.vaultWaiting().map((c) => c.id), [task.id]);
  // Only how the helper ended is kept: nothing it printed is read, so none of it is on the card or in the log.
  const logged = errorLog(board).at(-1);
  assert.deepEqual([logged.action, logged.level, logged.outcome, logged.stage, logged.exitCode, logged.message], ["finish", "warn", "failed", "Uploading to test vault", 3, notes[0]]);
  assert.doesNotMatch(JSON.stringify([board.tasks, errorLog(board)]), /ghp_|PIN refused/);
  vaultLine(t, "failure after merge", fx, task);
  // A route with no approval starts nothing, and what the card says stays.
  assert.deepEqual([(await board.uploadVault(task)).last.outcome, fx.uploads()], ["refused", 1]);
  // the user's Upload: the same commit to the same destination. Nothing needs asking, and nothing is merged.
  fx.mode("ok");
  const done = await board.uploadVault(task, { approve: true, confirm: async () => { throw new Error("nothing to ask: the branch is where it was, and the last try reported its own result"); } });
  assert.deepEqual([done.state, done.sha, done.attempts, done.last.exitCode, fx.uploads(), fx.merges(), fx.inVault(), sh(fx.repo, "rev-parse", "main")], ["uploaded", merged, 2, 0, 2, 1, merged, merged]);
  assert.deepEqual(board.vaultWaiting(), []);
  vaultLine(t, "retry", fx, task);
});

test("vault: a helper stopped at its limit, or a terminal closed by hand, reports no result: merged locally, upload pending, and the next upload waits for the helper's check or for the user", async (t) => {
  // A. No check is set for the helper, so only the user can settle it.
  const fx = vaultFixture({ timeoutSeconds: 2 });
  const { board, task } = vaultBoard(fx);
  fx.mode("hang");
  const notes = await run(board, task, { confirm: approve });
  const merged = sh(fx.repo, "rev-parse", "main");
  assert.deepEqual(notes, [pendingText(merged, "its helper did not finish within 2 seconds and was stopped, so whether anything reached test vault is not known", false)]);
  assert.deepEqual([task.status, task.vault.state, task.vault.uncertain, task.vault.last.outcome, task.vault.last.exitCode, task.vault.attempts, fx.merges(), fx.inVault()], ["done", "pending", true, "timeout", null, 1, 1, ""]);
  assert.equal(errorLog(board).at(-1).outcome, "timeout");
  vaultLine(t, "timeout", fx, task);
  const ran = fx.uploads(); // 1, unless the limit came before the helper had written its line
  let r = await board.uploadVault(task, { approve: true }); // nobody to ask
  assert.deepEqual([r.state, r.uncertain, r.last.outcome, r.attempts, fx.uploads()], ["pending", true, "unconfirmed", 1, ran]);
  assert.equal(f.vaultStatus(r), pendingText(merged, "its last upload did not report a result (timeout); it waits for the user to confirm before another upload", false));
  const asked = [];
  r = await board.uploadVault(task, { approve: true, confirm: async (q) => { asked.push(q.kind); return false; } }); // the user says no
  assert.deepEqual([asked, r.state, r.attempts, fx.uploads()], [["uncertain"], "pending", 1, ran]);
  // He says yes, then closes the helper's terminal before it is done.
  fx.settings = { [fx.repo]: { ...fx.entry, timeoutSeconds: 120 } }; // the same destination: its limit is not part of what was approved
  const closing = board.uploadVault(task, { approve: true, confirm: async () => true });
  await until(() => fx.uploads() === ran + 1, "the helper's start");
  vaultTerminals.at(-1).dispose();
  r = await closing;
  assert.deepEqual([r.state, r.uncertain, r.last.outcome, r.last.exitCode, r.attempts], ["pending", true, "cancelled", null, 2]);
  assert.equal(f.vaultStatus(r), pendingText(merged, "the upload was cancelled before its helper reported a result, so whether anything reached test vault is not known", false));
  vaultLine(t, "cancelled", fx, task);
  fx.mode("ok");
  r = await board.uploadVault(task, { approve: true, confirm: async () => true });
  assert.deepEqual([r.state, r.attempts, fx.uploads(), fx.inVault(), fx.merges()], ["uploaded", 3, ran + 2, merged, 1]);

  // B. With the helper's own check: an upload that had reached the vault before the helper was stopped is found there, and it is not uploaded twice.
  const fy = vaultFixture({ verify: true, timeoutSeconds: 2 });
  const b = vaultBoard(fy);
  fy.mode("hang");
  await run(b.board, b.task, { confirm: approve });
  const kept = sh(fy.repo, "rev-parse", "main"), before = fy.uploads();
  assert.deepEqual([b.task.vault.uncertain, b.task.vault.last.outcome], [true, "timeout"]);
  sh(fy.repo, "push", "-q", fy.mirror, "main:main"); // what the stopped helper had already sent
  r = await b.board.uploadVault(b.task, { approve: true }); // nobody is asked: the helper's check settles it
  assert.deepEqual([r.state, r.last.outcome, r.last.exitCode, r.attempts, r.uncertain, fy.uploads(), fy.checks()], ["uploaded", "verified", 0, 1, undefined, before, 1]);
  assert.equal(f.vaultStatus(r), `Merged into main (${seven(kept)}); test vault already had it (its helper checked).`);
  vaultLine(t, "unknown outcome, settled by the helper's check", fy, b.task);

  // C. The check says the vault does not have it: that settles it too, and the approved commit is uploaded without a question.
  const fz = vaultFixture({ verify: true, timeoutSeconds: 2 });
  const c = vaultBoard(fz);
  fz.mode("hang");
  await run(c.board, c.task, { confirm: approve });
  const base = fz.uploads();
  fz.mode("ok");
  r = await c.board.uploadVault(c.task, { approve: true });
  assert.deepEqual([r.state, r.last.outcome, r.attempts, fz.uploads(), fz.checks(), fz.inVault(), fz.merges()], ["uploaded", "uploaded", 2, base + 1, 1, sh(fz.repo, "rev-parse", "main"), 1]);
});

test("vault: a helper that is not installed is never started: main stays merged with the upload pending, and another destination is uploaded to only once the user approves it", async (t) => {
  const fx = vaultFixture();
  const absent = path.join(fx.root, "not-installed", "vault-helper");
  fx.settings = { [fx.repo]: { name: "test vault", command: absent, args: ["push"] } };
  const { board, task } = vaultBoard(fx);
  const terminals = vaultTerminals.length;
  const notes = await run(board, task, { confirm: approve });
  const merged = sh(fx.repo, "rev-parse", "main");
  assert.deepEqual(notes, [pendingText(merged, `its helper ${absent} is not installed (no such file)`)]);
  assert.deepEqual([task.status, task.merged, task.vault.state, task.vault.attempts, task.vault.last.outcome, vaultTerminals.length - terminals, fx.uploads(), fx.merges()], ["done", true, "pending", 0, "missing-helper", 0, 0, 1]);
  assert.equal(errorLog(board).at(-1).outcome, "runner-error");
  vaultLine(t, "missing helper", fx, task);
  // The setting now names another program: that is not the destination this merge was approved for.
  fx.settings = { [fx.repo]: fx.entry };
  let r = await board.uploadVault(task, { approve: true });
  assert.deepEqual([r.state, r.last.outcome, r.attempts, fx.uploads()], ["pending", "unconfirmed", 0, 0]);
  assert.match(r.why, /^this repo's vault setting changed since the merge: it now runs .*fake-vault\.js"? push, and .*vault-helper"? push was approved; it waits for the user to approve the new destination$/);
  const asked = [];
  r = await board.uploadVault(task, { approve: true, confirm: async (q) => { asked.push([q.kind, q.destination.command, q.record.destination.display.includes(absent)]); return true; } });
  assert.deepEqual(asked, [["destination", process.execPath, true]]);
  assert.deepEqual([r.state, r.attempts, r.destination.id, fx.uploads(), fx.inVault(), fx.merges()], ["uploaded", 1, f.vaultFor(fx.settings, fx.repo).id, 1, merged, 1]);
  const text = f.vaultQuestionText({ kind: "destination", record: task.vault, destination: f.vaultFor(fx.settings, fx.repo) });
  assert.deepEqual([text.title, text.yes], ["Upload to another destination?", "Upload there"]);
  assert.match(text.detail, /Nothing is uploaded unless you approve the new destination\.$/);
});

test("vault: the window closes while the helper waits for the PIN: after the reload the card says merged locally with an upload nobody saw end, and the retry uploads once with nothing merged again", async (t) => {
  const fx = vaultFixture();
  const first = vaultBoard(fx);
  const tasksFile = path.join(fx.repo, ".entomatical", "tasks.json");
  const onDisk = () => JSON.parse(fs.readFileSync(tasksFile, "utf8")).find((c) => c.id === first.task.id);
  fx.mode("hang");
  const finishing = run(first.board, first.task, { confirm: approve });
  await until(() => fx.uploads() === 1 && onDisk().vault?.running?.pid, "the helper's start and its process on the card");
  const merged = sh(fx.repo, "rev-parse", "main");
  const whenItClosed = fs.readFileSync(tasksFile); // all the closed window ever wrote
  assert.deepEqual([onDisk().status, onDisk().merged, onDisk().vault.state, onDisk().vault.sha, onDisk().vault.branch, onDisk().vault.attempts, onDisk().vault.destination.name],
    ["done", true, "uploading", merged, "main", 1, "test vault"]);
  // Another window, while the helper still runs: it starts no second upload beside it. That window is another process, with no
  // queue in common with this one, so its board is asked past the queue the two boards share here (one process).
  const beside = new Board(fx.repo, path.join(fx.repo, "hook.js"), undefined, false);
  beside.vaultOf = () => fx.settings;
  await assert.rejects(beside["uploadVaultNow"](beside.get(first.task.id), undefined, () => undefined), /^Error: An upload to test vault that another window started at \S+ is still running\. Wait for it to end, then try again\.$/);
  assert.deepEqual([fx.uploads(), onDisk().vault.state, onDisk().vault.attempts], [1, "uploading", 1], "nothing was started or written by the other window");
  beside.dispose();
  // The window goes, and the helper's terminal with it. What it would have written about the helper's end is never written.
  vaultTerminals.at(-1).dispose();
  await finishing;
  first.board.dispose();
  fs.writeFileSync(tasksFile, whenItClosed);

  const after = new Board(fx.repo, path.join(fx.repo, "hook.js")); // its first tick settles what the old window left
  boards.push(after);
  after.vaultOf = () => fx.settings;
  const card = after.get(first.task.id);
  assert.deepEqual([card.status, card.merged, card.worktree, card.vault.state, card.vault.uncertain, card.vault.last.outcome, card.vault.sha, card.vault.branch, card.vault.attempts, card.vault.running],
    ["done", true, undefined, "pending", true, "interrupted", merged, "main", 1, undefined]);
  assert.equal(f.vaultStatus(card.vault), pendingText(merged, "the window closed while its helper ran, so whether anything reached test vault is not known", false));
  assert.deepEqual(after.vaultWaiting().map((c) => c.id), [card.id]);
  assert.deepEqual([sh(fx.repo, "rev-parse", "main"), fx.merges(), fx.inVault()], [merged, 1, ""], "the work is on main, as merged");
  vaultLine(t, "reload", fx, card);
  // The retry: asked first, since nobody saw the last one end; then one run of the helper for the commit that was merged.
  fx.mode("ok");
  let r = await after.uploadVault(card, { approve: true });
  assert.deepEqual([r.state, r.last.outcome, fx.uploads()], ["pending", "unconfirmed", 1]);
  const asked = [];
  r = await after.uploadVault(card, { approve: true, confirm: async (q) => { asked.push(q.kind); return true; } });
  assert.deepEqual([asked, r.state, r.sha, r.attempts, fx.uploads(), fx.merges(), fx.inVault()], [["uncertain"], "uploaded", merged, 2, 2, 1, merged]);
  vaultLine(t, "retry after reload", fx, card);
});

test("vault: main moved after the merge: no more than was approved is uploaded until the helper's check or the user settles the new state", async (t) => {
  const fx = vaultFixture({ verify: true });
  const { board, task } = vaultBoard(fx);
  fx.mode("fail");
  await run(board, task, { confirm: approve });
  const merged = sh(fx.repo, "rev-parse", "main");
  // Someone commits on main: another card's Finish, or the user himself.
  const commitOnMain = (name) => { fs.writeFileSync(path.join(fx.repo, name), "later\n"); sh(fx.repo, "add", name); sh(fx.repo, "commit", "-qm", `later work: ${name}`); return sh(fx.repo, "rev-parse", "main"); };
  const tip = commitOnMain("later.txt");
  fx.mode("ok");
  // Nobody to ask: the helper's check says the vault does not hold main as it is, and the upload waits.
  let r = await board.uploadVault(task, { approve: true });
  assert.deepEqual([r.state, r.sha, r.last.outcome, r.attempts, fx.uploads(), fx.checks(), fx.inVault()], ["pending", merged, "unconfirmed", 1, 1, 1, ""]);
  assert.deepEqual([r.checked.exitCode, r.checked.timedOut], [1, undefined], "how the helper's check ended is kept");
  assert.equal(f.vaultStatus(r), pendingText(merged, `main moved from ${seven(merged)} to ${seven(tip)} since the merge, so an upload would carry more than was approved; it waits for the user to confirm the new state`));
  vaultLine(t, "moved branch", fx, task);
  const asked = [];
  r = await board.uploadVault(task, { approve: true, confirm: async (q) => { asked.push([q.kind, q.tip, q.contains, q.record.sha]); return false; } }); // the user says no
  assert.deepEqual([asked, r.state, r.sha, fx.uploads()], [[["moved", tip, true, merged]], "pending", merged, 1]);
  const text = f.vaultQuestionText({ kind: "moved", record: r, destination: f.vaultFor(fx.settings, fx.repo), tip, contains: true });
  assert.deepEqual([text.title, text.yes], ["Upload main as it is now?", `Upload ${seven(tip)}`]);
  assert.match(text.detail, /which contains it and more\.\nThe upload to test vault would carry main as it is now\. Nothing is uploaded unless you confirm the new state\.$/);
  // He confirms the new state: that is what is uploaded, once, and the record says so.
  r = await board.uploadVault(task, { approve: true, confirm: async () => true });
  assert.deepEqual([r.state, r.sha, r.uploaded.sha, r.attempts, fx.uploads(), fx.inVault(), fx.merges()], ["uploaded", tip, tip, 2, 2, tip, 1]);
  vaultLine(t, "moved branch, new state confirmed", fx, task);

  // A second card merged with no approval; main moves again, and the vault gets main some other way (the user ran the helper himself).
  const other = otherCard(fx, board, "o.txt");
  assert.deepEqual(await run(board, other), [pendingText(sh(fx.repo, "rev-parse", "main"), NO_APPROVAL)]);
  const later = commitOnMain("later-2.txt");
  sh(fx.repo, "push", "-q", fx.mirror, "main:main");
  const uploads = fx.uploads();
  r = await board.uploadVault(other, { approve: true }); // nobody is asked: the helper's check finds the vault holds main as it is
  assert.deepEqual([r.state, r.last.outcome, r.attempts, r.uploaded.sha, fx.uploads(), fx.inVault()], ["uploaded", "verified", 0, later, uploads, later]);
});

test("vault: main rewritten so that it no longer holds the merged work: the helper's check is not taken for proof, and only the user's confirmation uploads the new state", async (t) => {
  const fx = vaultFixture({ verify: true });
  const { board, task } = vaultBoard(fx);
  fx.mode("fail");
  await run(board, task, { confirm: approve });
  const merged = sh(fx.repo, "rev-parse", "main");
  // main is set back to before the merge and goes on from there; the vault is then given main as it is now (by hand).
  sh(fx.repo, "reset", "-q", "--hard", "HEAD~1");
  fs.writeFileSync(path.join(fx.repo, "elsewhere.txt"), "other work\n"); sh(fx.repo, "add", "elsewhere.txt"); sh(fx.repo, "commit", "-qm", "main goes on without the merge");
  const tip = sh(fx.repo, "rev-parse", "main");
  assert.throws(() => sh(fx.repo, "merge-base", "--is-ancestor", merged, tip), "the fixture's main does not hold the merged commit");
  sh(fx.repo, "push", "-q", fx.mirror, "main:main");
  fx.mode("ok");
  // The vault matches main, so the helper's check would exit 0. It is not asked: a vault that matches this main does not have the work.
  let r = await board.uploadVault(task, { approve: true });
  assert.deepEqual([r.state, r.last.outcome, r.sha, r.uploaded, fx.checks(), fx.uploads()], ["pending", "unconfirmed", merged, undefined, 0, 1]);
  assert.equal(f.vaultStatus(r), pendingText(merged, `main moved from ${seven(merged)} to ${seven(tip)} since the merge and no longer holds the merged commit (it was reset or rewritten); it waits for the user to confirm the new state`));
  const asked = [];
  r = await board.uploadVault(task, { approve: true, confirm: async (q) => { asked.push([q.kind, q.contains, q.tip]); return false; } });
  assert.deepEqual([asked, r.state, fx.checks(), fx.uploads()], [[["moved", false, tip]], "pending", 0, 1]);
  assert.match(f.vaultQuestionText({ kind: "moved", record: r, destination: f.vaultFor(fx.settings, fx.repo), tip, contains: false }).detail, new RegExp(`which no longer contains ${seven(merged)} \\(it was reset or rewritten\\)`));
  vaultLine(t, "rewritten branch", fx, task);
});

test("vault: two cards whose records name different settings still take turns: one helper at a time for the repo's vault", async () => {
  const fx = vaultFixture();
  const { board, task } = vaultBoard(fx);
  const other = otherCard(fx, board, "o.txt");
  fx.mode("fail");
  await run(board, other, { confirm: approve }); // refused, and recorded under the setting as it is now
  // The setting changes (the helper gets a check): what is merged from now on is recorded under another id.
  fx.settings = { [fx.repo]: { ...fx.entry, verifyArgs: [fx.script, "verify"] } };
  fx.mode("hang");
  const finishing = run(board, task, { confirm: approve });
  await until(() => fx.uploads() === 2, "the second card's helper");
  assert.notEqual(task.vault.destination.id, other.vault.destination.id);
  const asked = [], running = () => vaultTerminals.filter((x) => x.options.cwd === fx.repo && !x.exitStatus).length;
  const pressed = board.uploadVault(other, { approve: true, confirm: async (q) => { asked.push(q.kind); return true; } });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual([asked, fx.uploads(), fx.checks(), running()], [[], 2, 0, 1], "the first card's upload waits its turn: one helper runs, and nothing is asked yet");
  fx.go();
  assert.deepEqual(await finishing, []);
  const r = await pressed;
  // Its turn: the user approves the setting as it is now, and the helper's check finds the vault already holds main (the upload just made).
  assert.deepEqual([asked, r.state, r.last.outcome, r.destination.id, fx.uploads(), fx.checks(), fx.inVault()], [["destination"], "uploaded", "verified", task.vault.destination.id, 2, 1, sh(fx.repo, "rev-parse", "main")]);
});

test("vault: a second press while the helper runs starts no second upload: Finish is refused, and Upload waits its turn and finds it done", async (t) => {
  const fx = vaultFixture();
  const { board, task } = vaultBoard(fx);
  fx.mode("hang");
  const finishing = run(board, task, { confirm: approve });
  await until(() => fx.uploads() === 1, "the helper's start");
  await assert.rejects(run(board, task, { confirm: approve }), /is already being finished\. Nothing was changed\./);
  const presses = [board.uploadVault(task, { approve: true }), board.uploadVault(task, { approve: true })];
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual([fx.uploads(), task.vault.state, vaultTerminals.filter((x) => x.options.cwd === fx.repo).length], [1, "uploading", 1], "they wait behind the upload under way");
  fx.go();
  assert.deepEqual(await finishing, []);
  const merged = sh(fx.repo, "rev-parse", "main");
  assert.deepEqual((await Promise.all(presses)).map((r) => [r.state, r.attempts]), [["uploaded", 1], ["uploaded", 1]]);
  assert.deepEqual([fx.uploads(), fx.merges(), fx.inVault(), task.vault.attempts], [1, 1, merged, 1]);
  vaultLine(t, "double click", fx, task);

  // Two presses on a pending upload: one run of the helper.
  const fy = vaultFixture();
  const b = vaultBoard(fy);
  fy.mode("fail");
  await run(b.board, b.task, { confirm: approve });
  fy.mode("hang");
  const both = [b.board.uploadVault(b.task, { approve: true }), b.board.uploadVault(b.task, { approve: true })];
  await until(() => fy.uploads() === 2, "the helper's second start");
  fy.go();
  assert.deepEqual((await Promise.all(both)).map((r) => [r.state, r.attempts]), [["uploaded", 2], ["uploaded", 2]]);
  assert.deepEqual([fy.uploads(), fy.merges(), fy.inVault()], [2, 1, sh(fy.repo, "rev-parse", "main")]);
  vaultLine(t, "double click on a pending upload", fy, b.task);
});

test("vault: one upload carries every earlier merge of the branch, so an earlier card's pending upload is settled by it", async (t) => {
  const fx = vaultFixture();
  const { board, task } = vaultBoard(fx);
  const other = otherCard(fx, board, "o.txt");
  const terminals = vaultTerminals.length;
  const notes = await run(board, other); // a route with no approval
  const first = sh(fx.repo, "rev-parse", "main");
  assert.deepEqual(notes, [pendingText(first, NO_APPROVAL)]);
  assert.deepEqual([other.status, other.merged, other.vault.state, other.vault.sha, other.vault.last.outcome, other.vault.approved, fx.uploads(), vaultTerminals.length - terminals, fx.merges()],
    ["done", true, "pending", first, "unauthorized", undefined, 0, 0, 1]);
  assert.deepEqual(await run(board, task, { confirm: approve }), []);
  const merged = sh(fx.repo, "rev-parse", "main");
  assert.deepEqual([task.vault.state, task.vault.sha, other.vault.state, other.vault.uploaded.sha, other.vault.uploaded.coveredBy, other.vault.attempts, fx.uploads(), fx.merges(), fx.inVault()],
    ["uploaded", merged, "uploaded", first, merged, 0, 1, 2, merged]);
  assert.equal(f.vaultStatus(other.vault), `Merged into main (${seven(first)}); test vault has it with the upload of ${seven(merged)}.`);
  assert.deepEqual(board.vaultWaiting(), []);
  vaultLine(t, "two cards, one upload", fx, task);
});

test("vault: an orchestrator that finishes by itself merges locally, has no approval to upload and stops with the upload pending; its report and its notice say so", async (t) => {
  const fx = vaultFixture({ kids: 1 });
  const { board, master, needsYou } = runFor(fx);
  board.vaultOf = () => fx.settings;
  const terminals = vaultTerminals.length;
  infos.length = 0; opened.length = 0;
  const d = deps([verdict(fx, "done")]);
  const calls = await gitCalls(fx, async () => { assert.equal(await autoFinish(board, master, d), "finished"); });
  assert.ok(calls.filter((c) => /^merge /.test(c)).length >= 2, `the trace is of this finish (the child's merge and main's): ${calls.length} git commands`);
  assert.deepEqual(calls.filter(remoteGit), [], "no git command of the automatic finish talks to a remote");
  const merged = sh(fx.repo, "rev-parse", "main");
  assert.deepEqual([master.status, master.merged, fs.existsSync(fx.worktree), fx.uploads(), vaultTerminals.length - terminals, fx.inVault(), fx.merges()], ["done", true, false, 0, 0, "", 1]);
  assert.deepEqual([master.vault.state, master.vault.sha, master.vault.branch, master.vault.attempts, master.vault.last.outcome, master.vault.approved], ["pending", merged, "main", 0, "unauthorized", undefined]);
  const status = pendingText(merged, NO_APPROVAL);
  assert.equal(f.vaultStatus(master.vault), status);
  assert.deepEqual(needsYou, [status]);
  const report = fs.readFileSync(master.selfFinish.report, "utf8");
  assert.ok(report.includes(`main at ${merged} (merged here; nothing is pushed in a repo with a vault, and the upload to test vault is pending: see Notes)`), report);
  assert.ok(report.includes(`- ${status}`), report);
  assert.match(infos[0][0], /finished by itself: \w{7} is on main; the upload to test vault is pending\.$/);
  for (const commit of [/child 1 work/, /task change/]) assert.match(sh(fx.repo, "log", "--oneline", "main"), commit);
  vaultLine(t, "self-finish", fx, master);
  // the user's Upload afterwards: one run of the helper, for the commit the run merged.
  const r = await board.uploadVault(master, { approve: true });
  assert.deepEqual([r.state, r.sha, r.attempts, fx.uploads(), fx.inVault(), fx.merges()], ["uploaded", merged, 1, 1, merged, 1]);
});

test("vault: a background delivery brings the work into main and starts no upload; the user's Finish afterwards finds nothing to merge and uploads main as it is", async (t) => {
  const fx = vaultFixture();
  const { board, task } = vaultBoard(fx);
  const terminals = vaultTerminals.length;
  const calls = await gitCalls(fx, () => deliverFirst(fx, board, task));
  assert.ok(calls.some((c) => /^commit /.test(c)) && calls.some((c) => /^merge --ff-only /.test(c)), `the trace is of this delivery: ${calls.length} git commands`);
  assert.deepEqual(calls.filter(remoteGit), []);
  const delivered = sh(fx.repo, "rev-parse", "main");
  assert.deepEqual([task.vault, fx.uploads(), vaultTerminals.length - terminals, fx.inVault(), task.status, board.vaultWaiting()], [undefined, 0, 0, "", "review", []]);
  let shown, state;
  assert.deepEqual(await run(board, task, { confirm: async (plan, _related, s) => { shown = plan; state = s; return { upload: true }; } }), []);
  assert.deepEqual([state.landed, shown.vault.name, shown.remote], [true, "test vault", undefined]);
  assert.deepEqual([sh(fx.repo, "rev-parse", "main"), fx.merges(), task.status, task.vault.state, task.vault.sha, fx.uploads(), fx.inVault()], [delivered, 0, "done", "uploaded", delivered, 1, delivered]);
  vaultLine(t, "delivery, then Finish", fx, task);
});

// ---- M-02, Finish (19 November 2026): the card's writers close before its worktree goes ----
// Before: Finish took a closed tab, or 15 quiet seconds after its Stop, for the end of the session, and removed the worktree with
// whatever was still writing there (12 November 2026, cards 4fa8cf and d99db8). Every process in these tests is simulated: the board
// is told what is there (Board.processAlive, Board.processStart, the session list) instead of asking the OS, so nothing on this
// machine is looked up by name and nothing is ended. The last test asks the OS about one process: this test's own node child.

/** Simulated processes, pid -> when it started. */
function simulated(board) {
  const procs = new Map();
  board.processAlive = (pid) => procs.has(pid);
  board.processStart = async (pid) => procs.get(pid);
  return procs;
}
/** The CLI's session list as a scan leaves it: what `list()` has now, without the files of sessions the board ended over 15 s ago (Board.scan). */
const sessionList = (board, list) => Object.defineProperty(board, "external", { configurable: true, set() {},
  get: () => new Map(list().filter((s) => !(Date.now() - (board.stoppedSessions.get(`${s.pid}:${s.sessionId}`) ?? Infinity) > 15_000)).map((s) => [s.sessionId, s])) });
/**
 * Card t1 with a session the board started: its terminal, and its CLI (process 4101, started at "100") as the session list and the
 * simulated OS show it. onStop: what the board's Stop does to them (s.listed: the CLI's session file is there). s.owners: whose the
 * board's own record says that process is, read as the board stops it.
 */
function ownedSession(fx, onStop, { pid = 4101, started = "100", fileNamesStart = true } = {}) {
  const made = boardFor(fx, { sessionId: "s1" });
  const procs = simulated(made.board), s = { open: true, listed: true, stops: 0, kills: 0, owners: [] };
  procs.set(pid, started);
  // fileNamesStart false: a session file with no procStart, as Codex's and an older CLI's.
  sessionList(made.board, () => (s.listed ? [{ pid, sessionId: "s1", cwd: fx.worktree, configDir: "", ...(fileNamesStart ? { procStart: started } : {}) }] : []));
  made.board.terminal = (t) => (t.id === made.task.id && s.open ? { dispose() {
    s.open = false; s.stops++;
    s.owners = [...made.board.closing].flatMap(([card, list]) => list.map((p) => `${p.what}, started ${p.started}: card ${card}`));
    onStop(s, procs);
  } } : undefined);
  made.board.killSession = () => { s.kills++; return true; };
  return { ...made, procs, s, pid };
}
/** From here on, origin keeps a line for every update of its main: one per push it accepted. */
function counted(fx) { sh(fx.origin, "config", "core.logAllRefUpdates", "always"); return fx; }
const pushes = (fx) => { try { return fs.readFileSync(path.join(fx.origin, "logs", "refs", "heads", "main"), "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
/** What Finish has done so far: the merges it started (its steps, over every Finish of the card), the pushes origin took, the uploads. */
const did = (fx, steps, uploads = 0) => ({ merges: steps.filter((s) => /^Merging with /.test(s)).length, pushes: pushes(fx), uploads });
const mpu = (d) => `${d.merges}/${d.pushes}/${d.uploads}`;
/** One line per fixture in the test output: whether the worktree survived, whose the helper was, and the counts around the retry. */
const m02Line = (t, name, o) => t.diagnostic(`M-02 fixture "${name}": worktree ${o.worktree}; helper: ${o.helper}; owner: ${o.owner}; merges/pushes/uploads before retry ${o.before}, after retry ${o.after}`);
/** Finish with a 1 s wait for a session or a writer to end, looked at every 20 ms. */
const brief = { closeMs: 1000, pollMs: 20, resolveMs: 5000 };
/** Finish, with its steps added to `steps` (kept over a retry, so the counts are of every Finish of the card). */
const finishIn = (board, task, steps, opts = {}) => board.complete(task, opts.confirm ?? yes, (s) => { steps.push(s); opts.step?.(s); }, opts.closeTab, opts.limits ?? quick, { ...noModel, ...opts.helpers });
const cleanedUp = (sha, into = "origin/main") => `Its work was already in ${into} (${sha.slice(0, 7)}); only its worktree was left, and it was deleted.`;

test("F60 normal Finish: Stop exits the session, but a separate helper retains the worktree and its open stdin", { skip: process.platform !== "linux" }, async t => {
  const { once } = require("node:events"), { processStart } = require("../out/sessions.js");
  const fx = fixture({ upstream: false }), { board, task } = boardFor(fx, { sessionId: "s1" });
  const fifo = path.join(fx.root, "transport");
  execFileSync("mkfifo", [fifo]);
  const transport = fs.openSync(fifo, "r+");
  // As in 655cf3, the transport outlives the session. Only this fixture writes the helper's exit message.
  const session = spawn(process.execPath, ["-e", `
    const child = require("node:child_process").spawn(process.execPath,
      ["-e", "process.stdin.once('data', () => process.exit(0)); setTimeout(() => process.exit(1), 30000).unref()"],
      { detached: true, stdio: [4, 1, "ignore"] });
    child.unref();
    process.send(child.pid);
    process.on("disconnect", () => process.exit(0));
  `], { cwd: fx.worktree, stdio: ["ignore", "pipe", "inherit", "ipc", transport] });
  const ended = once(session, "exit"), helperClosed = once(session.stdout, "end");
  session.stdout.resume();
  t.after(async () => {
    if (session.connected) session.disconnect();
    fs.writeSync(transport, "exit\n"); fs.closeSync(transport);
    await helperClosed;
  });
  const [helper] = await once(session, "message");
  const started = await processStart(session.pid), helperStart = await processStart(helper);
  assert.ok(started && helperStart);
  sessionList(board, () => session.connected ? [{ sessionId: "s1", pid: session.pid, procStart: started, cwd: fx.worktree }] : []);
  board.terminal = () => session.connected ? { dispose: () => session.disconnect() } : undefined;
  board.stop(task);
  await ended;
  assert.equal(await processStart(session.pid), undefined);
  assert.equal(fs.readlinkSync(`/proc/${helper}/cwd`), fs.realpathSync(fx.worktree));
  const main = sh(fx.repo, "rev-parse", "main"), tip = sh(fx.worktree, "rev-parse", "HEAD");
  const held = new RegExp(`process ${helper}.*working directory`, "i");
  await assert.rejects(run(board, task), held);
  fs.writeFileSync(path.join(fx.worktree, "later.txt"), "keep\n");
  await assert.rejects(run(board, task), held);
  assert.deepEqual([await processStart(helper), sh(fx.repo, "rev-parse", "main"), sh(fx.worktree, "rev-parse", fx.branch),
    sh(fx.worktree, "status", "--porcelain"), task.status, task.merged, task.cleanup], [helperStart, main, tip, "?? later.txt", "review", undefined, undefined]);
  fs.writeSync(transport, "exit\n");
  await helperClosed;
  assert.deepEqual(await run(board, task), []);
  assert.deepEqual([task.status, fs.existsSync(fx.worktree), sh(fx.repo, "show", "main:later.txt")], ["done", false, "keep"]);
});

test("F60 normal Finish: closes its own idle terminal and ignores a similarly named sibling worktree", { skip: process.platform !== "linux" }, async t => {
  const { once } = require("node:events"), { processStart } = require("../out/sessions.js");
  const fx = fixture(), { board, task } = boardFor(fx, { sessionId: "s1" });
  const sibling = fx.worktree + "-other";
  fs.mkdirSync(sibling);
  const hold = cwd => {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { cwd, stdio: ["pipe", "ignore", "ignore"] });
    const exit = once(child, "exit");
    t.after(async () => { child.stdin.end(); await exit; });
    return child;
  };
  const own = hold(fx.worktree), other = hold(sibling), started = await processStart(own.pid);
  let closes = 0;
  sessionList(board, () => own.exitCode === null ? [{ sessionId: "s1", pid: own.pid, procStart: started, cwd: fx.worktree }] : []);
  board.terminal = () => closes ? undefined : { dispose() { closes++; own.stdin.end(); } };
  assert.deepEqual(await run(board, task), []);
  assert.deepEqual([closes, own.exitCode, fs.readlinkSync(`/proc/${other.pid}/cwd`), task.status, fs.existsSync(fx.worktree)],
    [1, 0, fs.realpathSync(sibling), "done", false]);
});

test("F60 normal Finish: cleanup-only and automatic Finish bypass the new cwd scan", { skip: process.platform !== "linux" }, async t => {
  const fx = fixture(), { board, task } = boardFor(fx);
  const late = path.join(fx.worktree, "late.txt");
  await assert.rejects(run(board, task, { step(s) { if (s === "Telling related sessions") fs.writeFileSync(late, "keep"); } }), /only retries the cleanup/);
  const landed = task.cleanup.sha, automatic = fixture({ kids: 1 }), { board: owner, master } = runFor(automatic);
  const read = fs.promises.readdir;
  let scans = 0;
  t.mock.method(fs.promises, "readdir", (dir, ...args) => {
    if (dir === "/proc") scans++;
    return read(dir, ...args);
  });
  await assert.rejects(run(board, task), /late\.txt/);
  fs.renameSync(late, path.join(fx.root, "saved"));
  assert.deepEqual(await run(board, task), [cleanedUp(landed)]);
  assert.equal(await autoFinish(owner, master, deps([verdict(automatic, "done")])), "finished");
  assert.equal(scans, 0);
});

test("F60 normal Finish: an empty procfs listing keeps the dirty checkout untouched", { skip: process.platform !== "linux" }, async t => {
  const fx = fixture({ dirty: true }), { board, task } = boardFor(fx);
  const before = sh(fx.repo, "rev-parse", "main", fx.branch), read = fs.promises.readdir;
  t.mock.method(fs.promises, "readdir", (dir, ...args) => dir === "/proc" ? Promise.resolve([]) : read(dir, ...args));
  await assert.rejects(run(board, task), /Cannot check working directories/);
  assert.deepEqual([sh(fx.repo, "rev-parse", "main", fx.branch), sh(fx.worktree, "status", "--porcelain"), task.status], [before, "?? b.txt", "review"]);
});
/** What a kept cleanup leaves: the worktree whole, its branch at the result, the transcript's path, and a status that says what to do. */
function keptWhole(fx, board, task, { sha, into = "origin/main", why }) {
  assert.deepEqual([task.status === "done", task.merged, task.cleanupPending], [false, true, true]);
  assert.ok(fs.existsSync(path.join(fx.worktree, ".git")) && fs.existsSync(path.join(fx.worktree, "a.txt")), "the worktree is whole");
  assert.equal(sh(fx.repo, "rev-parse", fx.branch), sha, "its branch still names the result");
  assert.deepEqual([task.cleanup.sha, task.cleanup.into], [sha, into]);
  assert.match(task.cleanup.why, why);
  assert.ok(task.transcript, "the transcript's path is on the card");
  assert.equal(task.transcript, board.transcriptOf(task));
  assert.match(f.cleanupStatus(task.cleanup, fx.worktree), /^Its work is in \S+ \(\w{7}\); only its worktree .* is left, kept whole because .* Finish again retries only that cleanup: nothing is merged, pushed or uploaded again\.$/s);
  assert.deepEqual(board.cleanupWaiting().map((c) => c.id), [task.id]);
}

test("M-02 confirmed owner exit: Finish's Stop ends the session's own process, known by pid and start time; the work lands once and the worktree goes", async (t) => {
  const fx = counted(fixture());
  const a = ownedSession(fx, (s, procs) => { s.listed = false; procs.delete(4101); }); // the CLI ends and takes its session file with it
  const steps = [];
  assert.deepEqual(await finishIn(a.board, a.task, steps), []);
  assert.deepEqual(a.s.owners, [`its session (process 4101), started 100: card ${a.task.id}`], "the process the board stops is on record as this card's");
  assert.deepEqual([a.s.stops, a.s.kills, a.task.status, a.task.merged, a.task.cleanupPending, a.task.cleanup, fs.existsSync(fx.worktree)], [1, 0, "done", true, undefined, undefined, false]);
  assert.equal(sh(fx.repo, "branch", "--list", fx.branch), "");
  assert.deepEqual(did(fx, steps), { merges: 1, pushes: 1, uploads: 0 });
  m02Line(t, "confirmed owner exit", { worktree: "removed", helper: "session process 4101 (start 100), gone when asked", owner: `card ${a.task.id}`, before: mpu(did(fx, steps)), after: "no retry" });
});

test("M-02 delayed exit: a closed tab is no proof. Finish waits for the session's process before it merges, and for the card's own checks before the folder goes", async (t) => {
  const fx = counted(fixture());
  let exitedAt = 0, mergedAt = 0;
  // The session file goes at once, as when a tab closes; the process takes 300 ms more.
  const a = ownedSession(fx, (s, procs) => { s.listed = false; setTimeout(() => { procs.delete(4101); exitedAt = Date.now(); }, 300); });
  const steps = [];
  assert.deepEqual(await finishIn(a.board, a.task, steps, { step: (s) => { if (/^Merging with /.test(s)) mergedAt = Date.now(); } }), []);
  assert.ok(exitedAt && mergedAt >= exitedAt, `the merge started ${mergedAt - exitedAt} ms after the process ended, not beside it`);
  assert.deepEqual([a.task.status, fs.existsSync(fx.worktree), a.s.kills, did(fx, steps)], ["done", false, 0, { merges: 1, pushes: 1, uploads: 0 }]);
  m02Line(t, "delayed exit (session process)", { worktree: "removed", helper: `session process 4101, gone 300 ms after its tab; the merge started ${mergedAt - exitedAt} ms after that`, owner: `card ${a.task.id}`, before: mpu(did(fx, steps)), after: "no retry" });
  // At the folder itself: the card's own acceptance checks start after the merge and take 300 ms. The folder is there until they end.
  const fy = counted(fixture());
  const b = boardFor(fy, { sessionId: "s1" });
  let thereWhenTheyEnded;
  const later = [];
  assert.deepEqual(await finishIn(b.board, b.task, later, { step: (s) => {
    if (s !== "Telling related sessions") return;
    b.task.checks = { status: "running", run: "r1" };
    setTimeout(() => { thereWhenTheyEnded = fs.existsSync(path.join(fy.worktree, ".git")); b.task.checks = { status: "complete", run: "r1" }; }, 300);
  } }), []);
  assert.deepEqual([thereWhenTheyEnded, b.task.status, b.task.cleanup, fs.existsSync(fy.worktree), did(fy, later)], [true, "done", undefined, false, { merges: 1, pushes: 1, uploads: 0 }]);
  m02Line(t, "delayed exit (acceptance checks)", { worktree: "removed, after the checks ended", helper: "the card's acceptance checks, 300 ms", owner: `card ${b.task.id}`, before: mpu(did(fy, later)), after: "no retry" });
});

test("M-02 unrelated and shared processes: a pid that went to another process is neither waited for nor ended; another card's session in the folder is left running and the worktree stays", async (t) => {
  // Unrelated: the CLI ended and its pid is another process's now (another start time). That one is not the card's: Finish goes on.
  const fx = counted(fixture());
  const a = ownedSession(fx, (s, procs) => { s.listed = false; procs.set(4101, "999"); });
  const steps = [];
  assert.deepEqual(await finishIn(a.board, a.task, steps), []);
  assert.deepEqual([a.task.status, fs.existsSync(fx.worktree), a.s.kills, a.procs.get(4101), did(fx, steps)], ["done", false, 0, "999", { merges: 1, pushes: 1, uploads: 0 }], "the unrelated process is still there");
  m02Line(t, "unrelated process (reused pid)", { worktree: "removed", helper: "process 4101 with start 999, where the card's session had start 100", owner: "not the card's: left alone", before: mpu(did(fx, steps)), after: "no retry" });

  // Finish's fallback for an idle panel session whose tab closed asks the same question before it ends anything: a session file left
  // under a pid that is another process's by now ends nothing. That a start differs counts only once the board has seen, on a session
  // that is running, that it reads a start as the CLI writes it. Until then nobody can say whose the process is: it is neither ended
  // nor passed over, and Finish stops with nothing changed.
  const fp = counted(fixture());
  const p = boardFor(fp, { sessionId: "s1" });
  const stale = simulated(p.board), others = [];
  stale.set(4102, "777"); // not the process the file names (start 100)
  let ended = 0;
  sessionList(p.board, () => [{ pid: 4102, sessionId: "s1", cwd: fp.worktree, configDir: "", procStart: "100" }, ...others]);
  p.board.killSession = () => { ended++; return true; };
  const panel = [];
  await assert.rejects(finishIn(p.board, p.task, panel, { closeTab: async () => undefined, limits: brief }),
    /^Error: Finish stopped while closing the session: Its session is still running after 1 seconds\. Close its tab, then press Finish again\. Nothing was changed\. The worktree was kept\.$/);
  assert.deepEqual([ended, stale.get(4102), p.task.status, did(fp, panel)], [0, "777", "review", { merges: 0, pushes: 0, uploads: 0 }]);
  // Another session runs elsewhere, and its start reads as its file says: now the stale file is known for what it is.
  p.board.dismissed.add("elsewhere");
  stale.set(4999, "5");
  others.push({ pid: 4999, sessionId: "elsewhere", cwd: fp.root, configDir: "", procStart: "5" });
  assert.deepEqual(await finishIn(p.board, p.task, panel, { closeTab: async () => undefined }), []);
  assert.deepEqual([ended, stale.get(4102), stale.get(4999), p.task.status, fs.existsSync(fp.worktree), did(fp, panel)], [0, "777", "5", "done", false, { merges: 1, pushes: 1, uploads: 0 }]);
  // Where the process is still the one its file names, the fallback ends it, once, as before.
  const fq = fixture();
  const q = boardFor(fq, { sessionId: "s1" });
  const own = simulated(q.board);
  own.set(4103, "100");
  let listed = true, endedOwn = 0;
  sessionList(q.board, () => (listed ? [{ pid: 4103, sessionId: "s1", cwd: fq.worktree, configDir: "", procStart: "100" }] : []));
  q.board.killSession = () => { endedOwn++; listed = false; own.delete(4103); return true; };
  assert.deepEqual(await finishIn(q.board, q.task, [], { closeTab: async () => undefined }), []);
  assert.deepEqual([endedOwn, q.task.status, fs.existsSync(fq.worktree)], [1, "done", false]);

  // Shared: another card's session runs in this card's folder. It is not this card's to close: it is left running and the worktree stays.
  const fz = counted(fixture());
  const c = boardFor(fz, { sessionId: "s1" });
  const other = c.board.add("Other card", "works in the same folder");
  c.board.update(other, { worktree: fz.worktree, branch: fz.branch, sessionId: "s2", status: "review" });
  let otherOpen = true, otherStops = 0;
  c.board.terminal = (x) => (x.id === other.id && otherOpen ? { dispose() { otherOpen = false; otherStops++; } } : undefined);
  const shared = [];
  await assert.rejects(finishIn(c.board, c.task, shared), (e) => {
    assert.match(e.message, /^Work merged and pushed to origin\/main; its worktree .*t1 was kept whole, because its folder is in use by the session of "Other card", which is card \w+'s\. It was left running: end it yourself when it is done\. Then press Finish again: it only retries the cleanup\./s);
    return true;
  });
  const landed = sh(fz.origin, "rev-parse", "main");
  keptWhole(fz, c.board, c.task, { sha: landed, why: /in use by the session of "Other card"/ });
  assert.deepEqual([otherOpen, otherStops, other.status, c.task.cleanup.holders], [true, 0, "review", [{ what: 'the session of "Other card"', owner: other.id, state: "open" }]]);
  const before = did(fz, shared);
  assert.deepEqual(before, { merges: 1, pushes: 1, uploads: 0 });
  otherOpen = false; // the other card's session ends by itself
  assert.deepEqual(await finishIn(c.board, c.task, shared), [cleanedUp(landed)]);
  assert.deepEqual([did(fz, shared), sh(fz.origin, "rev-parse", "main"), c.task.status, c.task.cleanup, c.task.cleanupPending, fs.existsSync(fz.worktree)], [before, landed, "done", undefined, undefined, false]);
  m02Line(t, "shared (another card's session in the folder)", { worktree: "survived the first Finish; removed by the retry, once that session had ended", helper: 'the session of "Other card", never stopped', owner: `card ${other.id}`, before: mpu(before), after: mpu(did(fz, shared)) });
});

test("M-02 unknown ownership: a session in the folder that no card holds, a process nobody can say has ended, and a folder something unknown has open all keep the worktree; nothing is ended", async (t) => {
  // 1. A Claude session runs in the card's folder, and no card of the board holds it (the user dismissed it from the board).
  const fx = counted(fixture());
  const a = boardFor(fx, { sessionId: "s1" });
  const procs = simulated(a.board);
  procs.set(5200, "40");
  let there = true, ended = 0;
  a.board.dismissed.add("stranger");
  sessionList(a.board, () => (there ? [{ pid: 5200, sessionId: "stranger", cwd: path.join(fx.worktree, "sub"), configDir: "", procStart: "40" }] : []));
  a.board.killSession = () => { ended++; return true; };
  const steps = [];
  await assert.rejects(finishIn(a.board, a.task, steps), /^Error: Work merged and pushed to origin\/main; its worktree .*t1 was kept whole, because its folder is in use by a Claude session \(process 5200\), which no card of this board owns\. It was left running: end it yourself when it is done\. Then press Finish again: it only retries the cleanup\. Already done: Pushed to origin\/main\.$/s);
  const landed = sh(fx.origin, "rev-parse", "main");
  keptWhole(fx, a.board, a.task, { sha: landed, why: /which no card of this board owns/ });
  assert.deepEqual([a.task.cleanup.holders, ended, procs.get(5200)], [[{ what: "a Claude session (process 5200)", owner: "unknown", state: "open" }], 0, "40"]);
  const before = did(fx, steps);
  assert.deepEqual(before, { merges: 1, pushes: 1, uploads: 0 });
  // Finish again while it is still there: only the cleanup is tried, and it is refused again. Nothing is merged or pushed a second time.
  await assert.rejects(finishIn(a.board, a.task, steps), /its folder is in use by a Claude session \(process 5200\), which no card of this board owns/);
  assert.deepEqual([did(fx, steps), sh(fx.origin, "rev-parse", "main"), ended], [before, landed, 0]);
  await assert.rejects(a.board.resume(a.task), /This task is already merged; its folder only waits to be deleted\. Press Finish to delete it, or start a new card\./);
  there = false; procs.delete(5200); // the user closed it
  assert.deepEqual(await finishIn(a.board, a.task, steps), [cleanedUp(landed)]);
  assert.deepEqual([did(fx, steps), sh(fx.origin, "rev-parse", "main"), a.task.status, a.task.cleanup, fs.existsSync(fx.worktree), a.board.cleanupWaiting()], [before, landed, "done", undefined, false, []]);
  m02Line(t, "unknown ownership (a session no card holds)", { worktree: "survived two Finishes; removed by the third, once that session was gone", helper: "Claude session, process 5200, in the card's folder; never ended by the board", owner: "unknown", before: mpu(before), after: mpu(did(fx, steps)) });

  // 2. The session's process is still there under its pid, and its start time cannot be read: nobody can say it ended. Nothing is merged.
  const fy = counted(fixture());
  const b = ownedSession(fy, (s) => { s.listed = false; });
  b.board.processStart = async () => undefined;
  const second = [];
  await assert.rejects(finishIn(b.board, b.task, second, { limits: brief }),
    /^Error: Finish stopped while closing the session: Whether its session \(process 4101\) has ended cannot be told after 1 seconds: its process id is in use and its start time cannot be read or compared\. Check that it is gone, then press Finish again \(after a window reload, if it is\)\. Nothing was changed\. The worktree was kept\.$/);
  assert.deepEqual([did(fy, second), b.task.merged, b.task.status, fs.existsSync(path.join(fy.worktree, ".git")), b.s.kills, b.procs.has(4101)], [{ merges: 0, pushes: 0, uploads: 0 }, undefined, "review", true, 0, true]);
  const unsure = did(fy, second);
  b.procs.delete(4101);
  assert.deepEqual(await finishIn(b.board, b.task, second, { limits: brief }), []);
  assert.deepEqual([did(fy, second), b.task.status, fs.existsSync(fy.worktree)], [{ merges: 1, pushes: 1, uploads: 0 }, "done", false]);
  m02Line(t, "unknown ownership (a process whose start cannot be read)", { worktree: "survived the first Finish, which merged nothing; removed by the second, once the process was gone", helper: "process 4101, on record as the card's session, start unreadable", owner: `card ${b.task.id}, its end not provable`, before: mpu(unsure), after: mpu(did(fy, second)) });

  // 3. Something the board has no record of has the folder open (Board.worktreeHeld: on Windows the folder cannot be renamed).
  const fz = counted(fixture());
  const c = boardFor(fz, { sessionId: "s1" });
  let held = true;
  c.board.worktreeHeld = () => held;
  const third = [];
  await assert.rejects(finishIn(c.board, c.task, third, { limits: brief }), /^Error: Work merged and pushed to origin\/main; its worktree .*t1 was kept whole, because something the board has no record of still has the folder open, often a tool the session started \(for a Codex editor session, that window's Codex helpers\)\. Close it\. Then press Finish again: it only retries the cleanup\./s);
  const there3 = sh(fz.origin, "rev-parse", "main");
  keptWhole(fz, c.board, c.task, { sha: there3, why: /still has the folder open/ });
  assert.deepEqual(c.task.cleanup.holders, [{ what: "a process that has the folder open", owner: "unknown", state: "open" }]);
  const held3 = did(fz, third);
  held = false;
  assert.deepEqual(await finishIn(c.board, c.task, third, { limits: brief }), [cleanedUp(there3)]);
  assert.deepEqual([did(fz, third), held3, c.task.status, fs.existsSync(fz.worktree)], [held3, { merges: 1, pushes: 1, uploads: 0 }, "done", false]);
  m02Line(t, "unknown ownership (the folder is held open)", { worktree: "survived the first Finish, whole; removed by the retry, once it was free", helper: "whatever has the folder open", owner: "unknown", before: mpu(held3), after: mpu(did(fz, third)) });
  // A folder held only for a moment (a scanner, a git of Finish's own) is waited out, as the delete always outwaited it: no refusal.
  const fw = counted(fixture());
  const d = boardFor(fw, { sessionId: "s1" });
  let probes = 0;
  d.board.worktreeHeld = () => ++probes <= 3;
  assert.deepEqual(await finishIn(d.board, d.task, [], { limits: brief }), []);
  assert.deepEqual([probes, d.task.status, d.task.cleanup, fs.existsSync(fw.worktree)], [4, "done", undefined, false]);
});

test("M-02 a session whose file names no start (Codex, an older CLI): Finish reads the process's start itself before it closes it, waits for that process, and knows another under the same pid", async (t) => {
  // The process takes 300 ms after its Stop; its session file says nothing about when it started.
  const fx = counted(fixture());
  let exitedAt = 0, mergedAt = 0;
  const a = ownedSession(fx, (s, procs) => { s.listed = false; setTimeout(() => { procs.delete(4101); exitedAt = Date.now(); }, 300); }, { fileNamesStart: false });
  const steps = [];
  assert.deepEqual(await finishIn(a.board, a.task, steps, { step: (s) => { if (/^Merging with /.test(s)) mergedAt = Date.now(); } }), []);
  assert.deepEqual(a.s.owners, [`its session (process 4101), started 100: card ${a.task.id}`], "recorded by the board's own reading");
  assert.ok(exitedAt && mergedAt >= exitedAt, `the merge started ${mergedAt - exitedAt} ms after the process ended`);
  assert.deepEqual([a.task.status, fs.existsSync(fx.worktree), a.s.kills, did(fx, steps)], ["done", false, 0, { merges: 1, pushes: 1, uploads: 0 }]);
  m02Line(t, "delayed exit (a session file with no start)", { worktree: "removed", helper: "session process 4101, its start read by the board, gone 300 ms after its Stop", owner: `card ${a.task.id}`, before: mpu(did(fx, steps)), after: "no retry" });
  // Its pid is another process's by the time Finish asks: both starts are the board's own readings, so that is known at once.
  const fy = fixture();
  const b = ownedSession(fy, (s, procs) => { s.listed = false; procs.set(4101, "999"); }, { fileNamesStart: false });
  assert.deepEqual(await finishIn(b.board, b.task, []), []);
  assert.deepEqual([b.task.status, fs.existsSync(fy.worktree), b.s.kills, b.procs.get(4101)], ["done", false, 0, "999"]);
  // A start that cannot be read while it runs leaves no record, and Finish goes by the session list alone, as before.
  const fz = fixture();
  const c = ownedSession(fz, (s) => { s.listed = false; }, { fileNamesStart: false });
  c.board.processStart = async () => undefined;
  assert.deepEqual(await finishIn(c.board, c.task, []), []);
  assert.deepEqual([c.task.status, c.s.owners, fs.existsSync(fz.worktree)], ["done", [], false]);
});

test("M-02 the routes of a card whose branch is gone: a leftover folder is kept while a session nobody owns runs in it, by Finish and by the sweep's retry, and goes once it is free", async () => {
  const { fx, board, task } = leftoverAfterMerge();
  const procs = simulated(board);
  procs.set(5300, "70");
  let there = true;
  board.dismissed.add("stranger");
  board.releaseLimits = { closeMs: 300, pollMs: 20 };
  sessionList(board, () => (there ? [{ pid: 5300, sessionId: "stranger", cwd: fx.worktree, configDir: "", procStart: "70" }] : []));
  const before = [sh(fx.origin, "rev-parse", "main"), sh(fx.repo, "rev-parse", "HEAD")];
  // The sweep's retry (Board.retryCleanups) passes the same gate as Finish.
  const swept = await board.retryCleanups();
  assert.equal(swept.removed, 0);
  assert.match(swept.failed.join(" "), /its worktree .*t1 was kept whole, because its folder is in use by a Claude session \(process 5300\), which no card of this board owns/);
  await assert.rejects(run(board, task), /^Error: Work merged; its worktree .*t1 was kept whole, because its folder is in use by a Claude session \(process 5300\), which no card of this board owns\. It was left running: end it yourself when it is done\. Then press Finish again: it only retries the cleanup\./s);
  // No commit is on record for a folder that is no checkout: the status says merged, and names no commit.
  assert.deepEqual([fs.existsSync(fx.worktree), task.status === "done", task.cleanupPending, task.cleanup.sha, task.cleanup.holders.map((h) => h.owner), procs.get(5300)], [true, false, true, "", ["unknown"], "70"]);
  assert.match(f.cleanupStatus(task.cleanup, fx.worktree), /^Its work is merged; only its worktree .* is left, kept whole because its folder is in use by a Claude session/);
  there = false; procs.delete(5300);
  assert.deepEqual(await board.retryCleanups(), { removed: 1, failed: [] });
  assert.deepEqual([task.status, task.merged, task.cleanup, task.cleanupPending, fs.existsSync(fx.worktree), sh(fx.origin, "rev-parse", "main"), sh(fx.repo, "rev-parse", "HEAD")], ["done", true, undefined, undefined, false, ...before]);
});

test("M-02 late file: a file written after the merge and before the folder goes is kept and never committed; Finish again only cleans up, and refuses while the file or a commit made since is there", async (t) => {
  const fx = counted(fixture());
  const { board, task } = boardFor(fx, { sessionId: "s1" });
  const late = path.join(fx.worktree, "late.txt"), steps = [];
  await assert.rejects(finishIn(board, task, steps, { step: (s) => { if (s === "Telling related sessions") fs.writeFileSync(late, "written after the merge\n"); } }),
    /^Error: Work merged and pushed to origin\/main; its worktree .*t1 was kept whole, because its worktree holds files written since its work landed: late\.txt\. Move what you want to keep \(or Discard to drop them\)\. Then press Finish again: it only retries the cleanup\./s);
  const landed = sh(fx.origin, "rev-parse", "main");
  keptWhole(fx, board, task, { sha: landed, why: /holds files written since its work landed: late\.txt/ });
  assert.deepEqual([fs.readFileSync(late, "utf8"), sh(fx.worktree, "status", "--porcelain"), sh(fx.worktree, "rev-parse", "HEAD"), task.cleanup.holders], ["written after the merge\n", "?? late.txt", landed, []]);
  const before = did(fx, steps);
  assert.deepEqual(before, { merges: 1, pushes: 1, uploads: 0 });
  // Finish again with the file still there. Its dialog is told that only the cleanup is left, and it writes no commit.
  let state;
  const message = async () => { throw new Error("a cleanup-only Finish writes no commit"); };
  await assert.rejects(finishIn(board, task, steps, { confirm: async (plan, related, s) => { state = s; return true; }, helpers: { message } }), /holds files written since its work landed: late\.txt/);
  assert.deepEqual([state.cleanupOnly.sha, state.cleanupOnly.into], [landed, "origin/main"]);
  assert.deepEqual([did(fx, steps), sh(fx.origin, "rev-parse", "main"), sh(fx.worktree, "rev-parse", "HEAD"), sh(fx.worktree, "status", "--porcelain"), fs.readFileSync(late, "utf8")],
    [before, landed, landed, "?? late.txt", "written after the merge\n"]);
  // A commit made there since is not merged again either: it keeps the worktree, and its branch.
  sh(fx.worktree, "add", "late.txt"); sh(fx.worktree, "commit", "-qm", "committed after the merge");
  const since = sh(fx.worktree, "rev-parse", "HEAD");
  await assert.rejects(finishIn(board, task, steps, { helpers: { message } }), /because its worktree is at \w{7}, which is not in the target \(\w{7} is what landed; this was committed since\)\. Merge it yourself, or Discard to drop it\./);
  assert.deepEqual([did(fx, steps), sh(fx.origin, "rev-parse", "main"), sh(fx.repo, "rev-parse", fx.branch), sh(fx.worktree, "show", "HEAD:late.txt")], [before, landed, since, "written after the merge"]);
  // the user takes what he wants out of the folder (here: the commit is dropped). Then only the folder goes.
  sh(fx.worktree, "reset", "-q", "--hard", landed);
  assert.deepEqual(await finishIn(board, task, steps, { helpers: { message } }), [cleanedUp(landed)]);
  assert.deepEqual([did(fx, steps), sh(fx.origin, "rev-parse", "main"), task.status, task.merged, task.cleanup, task.cleanupPending, fs.existsSync(fx.worktree)], [before, landed, "done", true, undefined, undefined, false]);
  m02Line(t, "late file", { worktree: "survived three Finishes with late.txt in it (uncommitted, then committed on its branch); removed by the fourth, once it was taken out", helper: "whatever wrote late.txt after the merge", owner: "not known to the board", before: mpu(before), after: mpu(did(fx, steps)) });
});

test("M-02 timeout: a writer of the card that does not end in time keeps the worktree, the transcript, the result and a status that says what to do; the retry only cleans up", async (t) => {
  const fx = counted(fixture());
  const { board, task } = boardFor(fx, { sessionId: "s1" });
  const steps = [], transcript = board.transcriptOf(task);
  // The card's acceptance checks start right after the merge and do not end within the wait (1 s here).
  await assert.rejects(finishIn(board, task, steps, { limits: brief, step: (s) => { if (s === "Telling related sessions") task.checks = { status: "running", run: "r1" }; } }),
    /^Error: Work merged and pushed to origin\/main; its worktree .*t1 was kept whole, because its acceptance checks had not ended after 1 seconds\. Nothing else was stopped: close it, or wait for it to end\. Then press Finish again: it only retries the cleanup\./s);
  const landed = sh(fx.origin, "rev-parse", "main");
  keptWhole(fx, board, task, { sha: landed, why: /^its acceptance checks had not ended after 1 seconds\./ });
  assert.deepEqual([task.cleanup.holders, task.transcript, task.checks.status], [[{ what: "its acceptance checks", owner: task.id, state: "open" }], transcript, "running"]);
  const logged = errorLog(board).at(-1);
  assert.deepEqual([logged.action, logged.stage], ["finish", "Deleting the worktree"]);
  const before = did(fx, steps);
  assert.deepEqual(before, { merges: 1, pushes: 1, uploads: 0 });
  // While they run, Finish again is refused before its dialog, as for any card that is working.
  await assert.rejects(finishIn(board, task, steps, { limits: brief }), /is still working \(its acceptance checks are running\)\. Finish does not stop work/);
  assert.deepEqual([did(fx, steps), sh(fx.origin, "rev-parse", "main"), fs.existsSync(path.join(fx.worktree, ".git"))], [before, landed, true]);
  task.checks = { status: "complete", run: "r1" };
  assert.deepEqual(await finishIn(board, task, steps, { limits: brief }), [cleanedUp(landed)]);
  assert.deepEqual([did(fx, steps), sh(fx.origin, "rev-parse", "main"), task.status, task.transcript, task.cleanup, fs.existsSync(fx.worktree)], [before, landed, "done", transcript, undefined, false]);
  m02Line(t, "timeout", { worktree: "survived two Finishes; removed by the third, once the checks had ended", helper: "the card's acceptance checks, still running after the 1 s wait", owner: `card ${task.id}`, before: mpu(before), after: mpu(did(fx, steps)) });
});

test("M-02 approvals: a subagent waiting for an approval is work under way and refuses Finish; the session's own unanswered prompt is still the user's to close", async () => {
  const fx = fixture();
  const a = boardFor(fx, { live: true, sessionId: "s1" });
  a.events.push({ t: 1, hook_event_name: "SessionStart", session_id: "s1" }, { t: 2, hook_event_name: "SubagentStart", agent_id: "ag1" },
    { t: 3, hook_event_name: "PermissionRequest", agent_id: "ag1", tool_name: "Bash" });
  a.board.update(a.task, { status: "needs-input" });
  let asked = false;
  await assert.rejects(run(a.board, a.task, { confirm: async () => (asked = true) }),
    /^Error: Finish stopped while checking the task: "Finish me" is still working \(a subagent is waiting for an approval\)\. Finish does not stop work: wait for it to end, or press Stop first, then Finish again\. Nothing was changed\. The worktree was kept\.$/);
  assert.deepEqual([asked, !!a.board.terminal(a.task), a.task.status, fs.existsSync(fx.worktree)], [false, true, "needs-input", true]);
  // It was answered and the subagent ended. Now the session itself asks for a permission: the prompt Finish's dialog names, and closes.
  a.events.push({ t: 4, hook_event_name: "PostToolUse", agent_id: "ag1", tool_name: "Bash" }, { t: 5, hook_event_name: "SubagentStop", agent_id: "ag1" },
    { t: 6, hook_event_name: "PermissionRequest", tool_name: "Edit" });
  let state;
  await run(a.board, a.task, { confirm: async (plan, related, s) => { state = s; return true; } });
  assert.deepEqual([state.open, state.asking, a.board.terminal(a.task), a.task.status, fs.existsSync(fx.worktree)], [true, true, undefined, "done", false]);
  // Esc during a subagent's prompt: the subagent sends no stop of its own, and its request must not hold the card from then on.
  const fy = fixture();
  const b = boardFor(fy, { live: true, sessionId: "s1" });
  b.events.push({ t: 1, hook_event_name: "SessionStart", session_id: "s1" }, { t: 2, hook_event_name: "PermissionRequest", agent_id: "ag1", tool_name: "Bash" });
  b.board.update(b.task, { status: "needs-input" });
  await assert.rejects(run(b.board, b.task), /is still working \(a subagent is waiting for an approval\)/);
  b.events.push({ t: 3, hook_event_name: "Interrupt" });
  b.board.update(b.task, { status: "review" });
  await run(b.board, b.task);
  assert.deepEqual([b.task.status, fs.existsSync(fy.worktree)], ["done", false]);
});

test("M-02 vault: a cleanup kept after the local merge starts no upload, and Finish again neither merges nor uploads; Upload to Vault then uploads that one commit, once", async (t) => {
  const fx = vaultFixture();
  const { board, task } = vaultBoard(fx, { sessionId: "s1" });
  let held = true;
  board.worktreeHeld = () => held;
  await assert.rejects(run(board, task, { confirm: approve }),
    /^Error: Work merged into main; its worktree .*t1 was kept whole, because something the board has no record of still has the folder open.* Then press Finish again: it only retries the cleanup\. Already done: Merged into main\. It is not uploaded to test vault yet: run "Entomatical: Upload to Vault" for that\.$/s);
  const merged = sh(fx.repo, "rev-parse", "main"), result = sh(fx.repo, "rev-parse", fx.branch);
  keptWhole(fx, board, task, { sha: result, into: "main", why: /still has the folder open/ });
  assert.deepEqual([fx.merges(), fx.uploads(), task.vault.state, task.vault.sha], [1, 0, "pending", merged]);
  const before = `${fx.merges()}/0/${fx.uploads()}`;
  held = false;
  // the user's Finish again, with the answer that approved the upload before: only the cleanup. Nothing is merged; the helper is not started.
  assert.deepEqual(await run(board, task, { confirm: approve }), [cleanedUp(result, "main"), pendingText(merged, "not uploaded yet")]);
  assert.deepEqual([fx.merges(), fx.uploads(), sh(fx.repo, "rev-parse", "main"), task.status, task.cleanup, fs.existsSync(fx.worktree)], [1, 0, merged, "done", undefined, false]);
  m02Line(t, "vault repo (the folder is held open)", { worktree: "survived the first Finish; removed by the retry", helper: "whatever has the folder open", owner: "unknown", before, after: `${fx.merges()}/0/${fx.uploads()}` });
  // The upload is its own step, asked for by name: that one commit, once.
  const done = await board.uploadVault(task, { approve: true, confirm: async () => { throw new Error("nothing to ask: the branch is where it was"); } });
  assert.deepEqual([done.state, done.sha, fx.merges(), fx.uploads(), fx.inVault()], ["uploaded", merged, 1, 1, merged]);
});

test("M-02 a real process: this test's own node child is told from another start under the same pid, a pid alone never says it ended, and it is gone once it has exited", { skip: !["win32", "linux"].includes(process.platform) && "a process's start time is read on Windows and Linux only" }, async () => {
  const s = require("../out/sessions.js");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore", windowsHide: true });
  await new Promise((r) => child.once("spawn", r));
  try {
    const started = await s.processStart(child.pid);
    assert.match(String(started), /^\d+$/, "its start time, as the CLI's session file would record it");
    assert.equal(await s.ownerState({ pid: child.pid, started, what: "the child" }), "running");
    assert.equal(await s.ownerState({ pid: child.pid, started: String(BigInt(started) + 10_000_000n), what: "the child" }), "replaced", "the same pid with another start is another process");
    // Windows compares to the microsecond, the finest its second reading (CIM) gives; elsewhere a start is compared as written.
    assert.deepEqual([s.sameStart("134395810138120901", "134395810138120900", "win32"), s.sameStart("134395810138120901", "134395810138120911", "win32"), s.sameStart("8421", "8420", "linux"), s.sameStart("8421", "8421", "linux")], [true, false, false, true]);
    assert.equal(await s.ownerState({ pid: child.pid, what: "the child" }), "unknown", "with no start on record, a live pid says nothing");
    child.kill();
    await new Promise((r) => child.once("exit", r));
    await until(() => !s.alive(child.pid), "the child's pid to be gone");
    assert.equal(await s.ownerState({ pid: child.pid, started, what: "the child" }), "exited");
    assert.equal(await s.processStart(child.pid), undefined);
  } finally { child.kill(); }
});

// Added by the audit of the M-02 tests above (card 04e321, 19 November 2026): the incident in its own order. the user presses Stop, the
// tab closes and the session file goes, the process stays; then he presses Finish. The tests above end the session through Finish's
// own close, and none reaches the limit of the wait for a process the board has on record as still running.
test("M-02 Stop, then Finish: a session the user stopped whose process has not ended holds Finish back at its limit, with nothing merged and nothing ended; once the process has gone, Finish lands the work once and the worktree goes", async (t) => {
  const fx = counted(fixture());
  const a = ownedSession(fx, (s) => { s.listed = false; }); // the tab closes and the session file goes; process 4101 stays
  const base = sh(fx.origin, "rev-parse", "main"), steps = [];
  a.board.stop(a.task);
  assert.deepEqual([a.s.stops, a.s.owners, a.board.live().includes(a.task.id), a.procs.get(4101)], [1, [`its session (process 4101), started 100: card ${a.task.id}`], false, "100"],
    "stopped and off the board's list, on record as this card's, with its process still there");
  await assert.rejects(finishIn(a.board, a.task, steps, { limits: brief }),
    /^Error: Finish stopped while closing the session: Its session \(process 4101\) was stopped and has not ended after 1 seconds\. End it, then press Finish again\. Nothing was changed\. The worktree was kept\.$/);
  assert.deepEqual([did(fx, steps), sh(fx.origin, "rev-parse", "main"), a.task.status === "done", a.task.merged, a.task.cleanup, fs.existsSync(path.join(fx.worktree, ".git")), sh(fx.worktree, "status", "--porcelain"), a.s.kills, a.procs.get(4101)],
    [{ merges: 0, pushes: 0, uploads: 0 }, base, false, undefined, undefined, true, "", 0, "100"], "nothing merged, pushed or ended; the card and its worktree are as they were");
  const before = mpu(did(fx, steps));
  a.procs.delete(4101); // it ends
  assert.deepEqual(await finishIn(a.board, a.task, steps, { limits: brief }), []);
  assert.deepEqual([did(fx, steps), a.task.status, a.task.merged, a.task.cleanup, fs.existsSync(fx.worktree), a.s.stops, a.s.kills], [{ merges: 1, pushes: 1, uploads: 0 }, "done", true, undefined, false, 1, 0]);
  m02Line(t, "Stop, then Finish (the process outlives its tab)", { worktree: "survived the first Finish untouched; removed by the second, once the process had gone", helper: "session process 4101 (start 100), stopped by the user's Stop and still running after the 1 s wait", owner: `card ${a.task.id}`, before, after: mpu(did(fx, steps)) });
});

// ---- Finish acceptance (19 November 2026, card 04e321: the last step of the Finish repair plan) ----
// Every route Finish has, once each, from a fresh throwaway repository: a local bare repository stands for the remote, and in a
// vault repo the fake helper above uploads to a second one. Each state a route leaves prints one "finish route" line: the refs in
// the repo and in the bare repositories, the branch Finish named, how often a helper ran, what Finish has done so far (merges it
// started / pushes the remote took / uploads), the card, and whether its worktree is there. A route that stopped half-way is taken
// up by a second try, which may do only what was left. Select them with --test-name-pattern="Finish acceptance".

/** A ref's commit in a repository; "" when it has none. */
const refIn = (dir, name) => { try { return sh(dir, "rev-parse", "-q", "--verify", name); } catch { return ""; } };
const abbrev = (sha) => (sha ? seven(sha) : "none");
/** Finish's dialog answering `answer`; what it was shown is kept in `seen`. */
const dialog = (seen, answer = true) => async (plan, related, state) => { Object.assign(seen, { plan, state }); return answer; };
/** The branch Finish names for the work, and where it goes from there. */
const namedBranch = (plan) => `${plan.target} (${plan.remote ? `pushed to ${plan.remote}/${plan.remoteBranch}` : plan.vault ? `local, then uploaded to ${plan.vault.name}` : "local only"})`;
function routeLine(t, route, fx, task, { named, ops, helper }) {
  const v = task.vault;
  const runs = helper ?? (fx.mirror ? `${fx.uploads()} to upload, ${fx.checks()} to check (the card counts ${v?.attempts ?? 0})` : "0 (no helper on this route)");
  t.diagnostic(`finish route "${route}": local main=${abbrev(refIn(fx.repo, "refs/heads/main"))}, ${fx.branch}=${abbrev(refIn(fx.repo, `refs/heads/${fx.branch}`))}; `
    + `bare origin main=${abbrev(refIn(fx.origin, "refs/heads/main"))}${fx.mirror ? `, bare vault main=${abbrev(fx.inVault())}` : ""}; named branch=${named}; helper attempts=${runs}; `
    + `merges/pushes/uploads=${ops}; card=${task.status}${task.merged ? ", merged" : ""}${task.cleanupPending ? ", cleanup pending" : ""}${v ? `, vault ${v.state}` : ""}; worktree=${fs.existsSync(fx.worktree) ? "there" : "gone"}`);
}
/** The card as a finished Finish leaves it: Done, merged, nothing waiting, its worktree and branch gone. */
const closed = (fx, task) => assert.deepEqual([task.status, task.merged, task.cleanup, task.cleanupPending, task.worktree, task.branch, fs.existsSync(fx.worktree), refIn(fx.repo, `refs/heads/${fx.branch}`)],
  ["done", true, undefined, undefined, undefined, undefined, false, ""]);
/**
 * The window closes and another opens: a new Board over the same folder. written: tasks.json as the closed window left it (a window
 * that is killed runs no handler, so whatever this process wrote after that moment is taken back).
 */
function reopened(fx, old, id, written) {
  old.dispose();
  if (written) fs.writeFileSync(path.join(fx.repo, ".entomatical", "tasks.json"), written);
  const board = new Board(fx.repo, path.join(fx.repo, "hook.js"));
  boards.push(board);
  board.events = () => [];
  board.terminal = () => undefined;
  board.send = () => undefined;
  if (fx.settings) board.vaultOf = () => fx.settings;
  return { board, task: board.get(id) };
}
const neverCommits = { message: async () => { throw new Error("nothing is left to commit"); } };

test("Finish acceptance: local only (main has no upstream): one merge commit on local main, nothing reaches the bare remote, the card is Done and its worktree and branch are gone", async (t) => {
  const fx = counted(fixture({ upstream: false }));
  const { board, task } = boardFor(fx);
  const base = sh(fx.repo, "rev-parse", "main"), tip = sh(fx.repo, "rev-parse", fx.branch), steps = [], seen = {};
  assert.deepEqual(await finishIn(board, task, steps, { confirm: dialog(seen) }), []);
  assert.deepEqual([seen.plan.target, seen.plan.remote, seen.plan.vault], ["main", undefined, undefined]);
  const main = sh(fx.repo, "rev-parse", "main");
  assert.deepEqual(sh(fx.repo, "rev-list", "--parents", "-1", "main").split(" "), [main, base, tip], "one merge commit: main as it was, and the task's commit");
  assert.deepEqual([refIn(fx.origin, "refs/heads/main"), sh(fx.origin, "for-each-ref")], ["", ""], "the bare remote was given nothing");
  assert.deepEqual(did(fx, steps), { merges: 1, pushes: 0, uploads: 0 });
  closed(fx, task);
  assert.equal(task.vault, undefined);
  routeLine(t, "local only", fx, task, { named: namedBranch(seen.plan), ops: mpu(did(fx, steps)) });
});

test("Finish acceptance: an upstream on a bare remote: the task's commit is pushed there once, local main follows it, the card is Done and its worktree and branch are gone", async (t) => {
  const fx = counted(fixture());
  const { board, task } = boardFor(fx);
  const base = sh(fx.origin, "rev-parse", "main"), tip = sh(fx.repo, "rev-parse", fx.branch), steps = [], seen = {};
  assert.notEqual(tip, base);
  assert.deepEqual(await finishIn(board, task, steps, { confirm: dialog(seen) }), []);
  assert.deepEqual([seen.plan.target, seen.plan.remote, seen.plan.remoteBranch, seen.plan.vault], ["main", "origin", "main", undefined]);
  assert.deepEqual([sh(fx.origin, "rev-parse", "main"), sh(fx.repo, "rev-parse", "main")], [tip, tip], "the remote has the task's commit, and local main is the same commit");
  assert.deepEqual(did(fx, steps), { merges: 1, pushes: 1, uploads: 0 });
  closed(fx, task);
  routeLine(t, "upstream", fx, task, { named: namedBranch(seen.plan), ops: mpu(did(fx, steps)) });
});

test("Finish acceptance: a vault repo whose helper succeeds: merged into local main and uploaded by one run of the helper; the disabled origin is sent nothing", async (t) => {
  const fx = counted(vaultFixture());
  const { board, task } = vaultBoard(fx);
  const base = sh(fx.repo, "rev-parse", "main"), steps = [], seen = {};
  assert.deepEqual(await finishIn(board, task, steps, { confirm: dialog(seen, { upload: true }) }), []);
  const merged = sh(fx.repo, "rev-parse", "main");
  assert.deepEqual([seen.plan.target, seen.plan.remote, seen.plan.vault.name], ["main", undefined, "test vault"]);
  assert.deepEqual([fx.merges(), fx.inVault(), sh(fx.origin, "rev-parse", "main"), pushes(fx)], [1, merged, base, 0], "one merge, which the vault's mirror holds; the bare origin is where it was");
  assert.deepEqual([fx.uploads(), fx.checks(), task.vault.state, task.vault.branch, task.vault.sha, task.vault.attempts, task.vault.last.outcome], [1, 0, "uploaded", "main", merged, 1, "uploaded"]);
  closed(fx, task);
  assert.deepEqual(board.vaultWaiting(), []);
  routeLine(t, "vault, uploaded", fx, task, { named: namedBranch(seen.plan), ops: mpu(did(fx, steps, fx.uploads())) });
});

test("Finish acceptance: a vault repo whose helper refuses: the merge stays on local main with the upload pending, and the retry uploads that commit and merges nothing", async (t) => {
  const fx = counted(vaultFixture());
  const { board, task } = vaultBoard(fx);
  const base = sh(fx.origin, "rev-parse", "main"), steps = [], seen = {};
  fx.mode("fail");
  const notes = await finishIn(board, task, steps, { confirm: dialog(seen, { upload: true }) });
  const merged = sh(fx.repo, "rev-parse", "main");
  assert.deepEqual(notes, [pendingText(merged, "its helper refused it (exit 3)")]);
  assert.deepEqual([fx.merges(), fx.inVault(), fx.uploads(), task.vault.state, task.vault.branch, task.vault.sha, task.vault.attempts, task.vault.last.outcome, task.vault.last.exitCode],
    [1, "", 1, "pending", "main", merged, 1, "refused", 3], "merged once and kept; the helper ran once and the vault has nothing");
  closed(fx, task); // the card and its worktree are settled before the helper starts, whatever it then says
  assert.deepEqual(board.vaultWaiting().map((c) => c.id), [task.id]);
  const before = did(fx, steps, fx.uploads());
  assert.deepEqual(before, { merges: 1, pushes: 0, uploads: 1 });
  routeLine(t, "vault, upload pending", fx, task, { named: namedBranch(seen.plan), ops: mpu(before) });
  // The retry is Upload to Vault, approved by the user: the same commit to the same destination, with nothing to ask and nothing merged.
  fx.mode("ok");
  const r = await board.uploadVault(task, { approve: true, confirm: async () => { throw new Error("nothing to ask: the branch is where it was, and the last try reported its own result"); } });
  assert.deepEqual([r.state, r.sha, r.attempts, fx.inVault(), sh(fx.repo, "rev-parse", "main"), fx.merges(), sh(fx.origin, "rev-parse", "main")], ["uploaded", merged, 2, merged, merged, 1, base]);
  assert.deepEqual(did(fx, steps, fx.uploads()), { ...before, uploads: 2 }, "the retry added one upload and nothing else");
  assert.deepEqual(board.vaultWaiting(), []);
  routeLine(t, "vault, upload pending: the retry", fx, task, { named: namedBranch(seen.plan), ops: mpu(did(fx, steps, fx.uploads())) });
});

test("Finish acceptance: only the cleanup is left after landing: the worktree is kept whole while something has its folder open, and after a reload Finish again deletes it and merges and pushes nothing", async (t) => {
  const fx = counted(fixture());
  const first = boardFor(fx, { sessionId: "s1" });
  first.board.worktreeHeld = () => true; // something the board has no record of has the folder open, on either OS
  const steps = [], seen = {};
  await assert.rejects(finishIn(first.board, first.task, steps, { confirm: dialog(seen) }),
    /^Error: Work merged and pushed to origin\/main; its worktree .*t1 was kept whole, because something the board has no record of still has the folder open.* Then press Finish again: it only retries the cleanup\./s);
  const landed = sh(fx.origin, "rev-parse", "main");
  keptWhole(fx, first.board, first.task, { sha: landed, why: /still has the folder open/ });
  assert.equal(sh(fx.repo, "rev-parse", "main"), landed, "local main followed the remote before the cleanup was tried");
  const before = did(fx, steps);
  assert.deepEqual(before, { merges: 1, pushes: 1, uploads: 0 });
  routeLine(t, "upstream, cleanup pending", fx, first.task, { named: namedBranch(seen.plan), ops: mpu(before) });
  // The window is reloaded and the folder is free by then. What is left is on the card, so the new window's Finish only cleans up.
  const again = reopened(fx, first.board, first.task.id);
  assert.deepEqual([again.task.status === "done", again.task.merged, again.task.cleanupPending, again.task.cleanup.sha, again.task.cleanup.into, again.board.cleanupWaiting().map((c) => c.id)],
    [false, true, true, landed, "origin/main", [first.task.id]]);
  const retry = [], state = {};
  assert.deepEqual(await finishIn(again.board, again.task, retry, { confirm: dialog(state), helpers: neverCommits }), [cleanedUp(landed)]);
  assert.deepEqual([state.state.cleanupOnly.sha, state.state.cleanupOnly.into], [landed, "origin/main"], "its dialog is told that only the cleanup is left");
  assert.deepEqual(retry, ["Checking the task", "Closing the session", "Deleting the worktree"]);
  assert.deepEqual([did(fx, [...steps, ...retry]), sh(fx.origin, "rev-parse", "main"), sh(fx.repo, "rev-parse", "main")], [before, landed, landed], "no merge, no push, and both mains where they were");
  closed(fx, again.task);
  assert.deepEqual(again.board.cleanupWaiting(), []);
  routeLine(t, "upstream, cleanup pending: the retry after a reload", fx, again.task, { named: namedBranch(seen.plan), ops: mpu(did(fx, [...steps, ...retry])) });
});

test("Finish acceptance: an orchestrator's own finish runs its check before the push: a failing check keeps the candidate and pushes nothing, and that candidate is pushed once when the check passes", async (t) => {
  const fx = counted(fixture({ kids: 1 }));
  // The run's one check passes once ../pass exists, and writes how each of its runs ended to ../runs: beside the worktrees, ignored,
  // and in none of them. (A finish that completes deletes the card's own check records, so the command keeps the count itself.)
  const check = `node -e "const fs = require('fs'), ok = fs.existsSync('../pass'); fs.appendFileSync('../runs', ok ? 'pass ' : 'fail '); process.exit(ok ? 0 : 1)"`;
  catalogueFor(fx, [[check, 2]]); // 2 minutes x 3: the limit is there, and is not what ends either run
  const { board, master, children: [child] } = runFor(fx, { commands: [check] });
  const base = sh(fx.origin, "rev-parse", "main"), count = () => pushes(fx);
  const checkRuns = () => fs.readFileSync(beside(fx, "runs"), "utf8").trim().split(" ");
  const line = (route) => routeLine(t, route, fx, master, { named: "main (pushed to origin/main)", ops: `not counted/${pushes(fx)}/0`,
    helper: `${checkRuns().length} of the check before the push (${checkRuns().join(", ")}), each under a limit of 6 minutes` });

  assert.equal(await autoFinish(board, master, deps([verdict(fx, "done")])), "stopped");
  const run = lastChecks(board, master);
  assert.deepEqual([run.job.limitsMs, run.check(0).exitCode, run.check(0).timedOut, run.receipt.checksPassed, checkRuns()], [[6 * 60_000], 1, undefined, false, ["fail"]]);
  assert.ok(master.selfFinish.error.startsWith(`Finish stopped while running the acceptance checks: Acceptance check 1 failed: ${check} exited with 1.`), master.selfFinish.error);
  const candidate = keptForRetry(fx, board, master, count);
  assert.deepEqual([sh(fx.origin, "rev-parse", "main"), sh(fx.repo, "rev-parse", "main"), master.status], [base, base, "needs-input"], "the remote and local main are where they were");
  line("automatic, the check before the push fails");

  fs.writeFileSync(beside(fx, "pass"), "");
  // The newest check run is read as the push step starts: after the finish, the card's check records are gone with it.
  let atPush;
  const update = board.update.bind(board);
  board.update = (task, patch, ...rest) => {
    if (patch?.selfFinish?.step === "Pushing to origin/main") { const now = lastChecks(board, master); atPush = [now.job.limitsMs, now.check(0).exitCode, now.check(0).timedOut, now.receipt.checksPassed, now.job.at > run.job.at]; }
    return update(task, patch, ...rest);
  };
  assert.equal(await autoFinish(board, master, deps([verdict(fx, "done")])), "finished");
  assert.deepEqual(atPush, [[6 * 60_000], 0, undefined, true, true], "when the push started, a new run of the check had passed inside its limit");
  assert.deepEqual(checkRuns(), ["fail", "pass"], "the check ran once more, and passed");
  deliveredOnce(fx, master, count, candidate);
  assert.deepEqual([sh(fx.repo, "rev-parse", "main"), child.status, fs.existsSync(fx.children[0].worktree), refIn(fx.repo, "refs/heads/task/c1"), refIn(fx.repo, `refs/heads/${fx.branch}`)], [candidate, "done", false, "", ""]);
  line("automatic, the check before the push passes");
});

test("Finish acceptance: a Finish cut off by its window closing is taken up by the next one, which does only what was left: after the push, no second merge or push; in a vault repo after the merge, no second merge and one upload", async (t) => {
  const tasksFile = (fy) => path.join(fy.repo, ".entomatical", "tasks.json");
  let written; // all the closed window ever wrote
  const cutAt = (fy, name) => (s) => { if (s === name) { written = fs.readFileSync(tasksFile(fy)); throw new Error("the window closed"); } };

  // A. With an upstream: the window goes after the remote took the push and before local main was brought up to it.
  const fx = counted(fixture());
  const first = boardFor(fx);
  const base = sh(fx.repo, "rev-parse", "main"), tip = sh(fx.repo, "rev-parse", fx.branch), steps = [], seen = {};
  await assert.rejects(finishIn(first.board, first.task, steps, { confirm: dialog(seen), step: cutAt(fx, "Updating main") }), /the window closed/);
  const a = reopened(fx, first.board, first.task.id, written);
  assert.deepEqual([sh(fx.origin, "rev-parse", "main"), sh(fx.repo, "rev-parse", "main"), a.task.merged, a.task.cleanup, a.task.status === "done", fs.existsSync(path.join(fx.worktree, ".git")), refIn(fx.repo, `refs/heads/${fx.branch}`)],
    [tip, base, true, undefined, false, true, tip], "the remote has the push; local main, the card and the worktree are as the window left them");
  const before = did(fx, steps);
  assert.deepEqual(before, { merges: 1, pushes: 1, uploads: 0 });
  routeLine(t, "upstream, cut off after the push", fx, a.task, { named: namedBranch(seen.plan), ops: mpu(before) });
  const retry = [], state = {};
  assert.deepEqual(await finishIn(a.board, a.task, retry, { confirm: dialog(state), helpers: neverCommits }), []);
  assert.equal(state.state.landed, true, "its dialog is told that the work is in the target already");
  assert.deepEqual(retry, ["Checking the task", "Closing the session", "Updating main", "Telling related sessions", "Deleting the worktree"], "what was left: local main, then the worktree");
  assert.deepEqual([did(fx, [...steps, ...retry]), sh(fx.origin, "rev-parse", "main"), sh(fx.repo, "rev-parse", "main")], [before, tip, tip], "no second merge or push; local main is the pushed commit now");
  closed(fx, a.task);
  routeLine(t, "upstream, cut off after the push: the retry", fx, a.task, { named: namedBranch(seen.plan), ops: mpu(did(fx, [...steps, ...retry])) });

  // B. In a vault repo: the window goes after the merge into local main, before the worktree is deleted and the helper started.
  const fy = counted(vaultFixture());
  const v1 = vaultBoard(fy);
  const vsteps = [], vseen = {};
  await assert.rejects(finishIn(v1.board, v1.task, vsteps, { confirm: dialog(vseen, { upload: true }), step: cutAt(fy, "Telling related sessions") }), /the window closed/);
  const merged = sh(fy.repo, "rev-parse", "main");
  const b = reopened(fy, v1.board, v1.task.id, written);
  assert.deepEqual([fy.merges(), fy.uploads(), fy.inVault(), b.task.merged, b.task.vault.state, b.task.vault.sha, b.task.vault.branch, b.task.vault.attempts, b.task.status === "done", fs.existsSync(path.join(fy.worktree, ".git"))],
    [1, 0, "", true, "pending", merged, "main", 0, false, true], "merged once and on the card as pending; the helper never ran");
  const vbefore = did(fy, vsteps, fy.uploads());
  assert.deepEqual(vbefore, { merges: 1, pushes: 0, uploads: 0 });
  routeLine(t, "vault, cut off after the merge", fy, b.task, { named: namedBranch(vseen.plan), ops: mpu(vbefore) });
  const vretry = [];
  assert.deepEqual(await finishIn(b.board, b.task, vretry, { confirm: dialog({}, { upload: true }), helpers: neverCommits }), []);
  assert.deepEqual(vretry, ["Checking the task", "Closing the session", "Telling related sessions", "Deleting the worktree", "Uploading main to test vault: enter your PIN and touch the key when its terminal asks"], "what was left: the worktree, then the upload");
  assert.deepEqual([sh(fy.repo, "rev-parse", "main"), fy.merges(), fy.uploads(), fy.inVault(), b.task.vault.state, b.task.vault.sha, b.task.vault.attempts, pushes(fy)], [merged, 1, 1, merged, "uploaded", merged, 1, 0], "no second merge; that commit is uploaded by one run of the helper");
  closed(fy, b.task);
  routeLine(t, "vault, cut off after the merge: the retry", fy, b.task, { named: namedBranch(vseen.plan), ops: mpu(did(fy, [...vsteps, ...vretry], fy.uploads())) });
});

test("auto-finish: a detached orchestrator keeps its unstaged files and every child checkout", async () => {
  const fx = fixture({ dirty: true, kids: 1 });
  const { board, master } = runFor(fx);
  sh(fx.worktree, "checkout", "-q", "--detach");
  const head = sh(fx.worktree, "rev-parse", "HEAD"), remote = sh(fx.origin, "rev-parse", "main");
  const d = deps([]);
  assert.equal(await autoFinish(board, master, d), "stopped");
  assert.match(master.selfFinish.error, /detached HEAD/);
  assert.equal(master.status, "needs-input");
  assert.deepEqual(d.calls, []);
  assert.equal(sh(fx.worktree, "rev-parse", "HEAD"), head);
  assert.equal(sh(fx.worktree, "status", "--porcelain"), "?? b.txt");
  assert.equal(sh(fx.origin, "rev-parse", "main"), remote);
  assert.ok(fs.existsSync(fx.children[0].worktree));
});

test("auto-finish: switching branches while writing the orchestrator's commit message preserves the staged changes", async () => {
  const fx = fixture({ dirty: true });
  const { board, master } = runFor(fx);
  const head = sh(fx.worktree, "rev-parse", "HEAD"), remote = sh(fx.origin, "rev-parse", "main");
  const d = deps([]);
  d.helpers = { message: async () => {
    sh(fx.worktree, "checkout", "-qb", "user-work");
    return "Must never be committed";
  } };
  assert.equal(await autoFinish(board, master, d), "stopped");
  assert.match(master.selfFinish.error, /user-work/);
  assert.equal(master.status, "needs-input");
  assert.deepEqual(d.calls, []);
  assert.equal(sh(fx.worktree, "rev-parse", "user-work"), head);
  assert.equal(sh(fx.worktree, "rev-parse", fx.branch), head);
  assert.equal(sh(fx.worktree, "diff", "--cached", "--name-only"), "b.txt");
  assert.equal(sh(fx.origin, "rev-parse", "main"), remote);
});

test("auto-finish: cleanup preserves a child's detached commit and a leftover file, and removes an empty leftover", async () => {
  const fx = fixture({ kids: 3 });
  const { board, master, children } = runFor(fx);
  const [detached, leftover, empty] = fx.children;
  let childHead;
  const d = deps([() => {
    // The recorded branches have been merged; the worktrees change while the reviewer reads the master.
    sh(detached.worktree, "checkout", "-q", "--detach");
    sh(detached.worktree, "commit", "-q", "--allow-empty", "-m", "Detached work");
    childHead = sh(detached.worktree, "rev-parse", "HEAD");
    for (const c of [leftover, empty]) {
      sh(fx.repo, "worktree", "remove", c.worktree);
      fs.mkdirSync(c.worktree);
    }
    fs.writeFileSync(path.join(leftover.worktree, "keep.txt"), "Keep this file\n");
    return verdict(fx, "done");
  }]);
  assert.equal(await autoFinish(board, master, d), "finished");
  assert.equal(sh(detached.worktree, "rev-parse", "HEAD"), childHead);
  assert.ok(sh(fx.repo, "branch", "--list", detached.branch));
  assert.equal(fs.readFileSync(path.join(leftover.worktree, "keep.txt"), "utf8"), "Keep this file\n");
  assert.ok(sh(fx.repo, "branch", "--list", leftover.branch));
  assert.equal(fs.existsSync(empty.worktree), false);
  assert.equal(sh(fx.repo, "branch", "--list", empty.branch), "");
  assert.deepEqual(children.map((c) => c.worktree), [detached.worktree, leftover.worktree, undefined]);
  const report = fs.readFileSync(master.selfFinish.report, "utf8");
  assert.match(report, /## Left behind\n\n- "Child 1".*detached HEAD/);
  assert.match(report, /- "Child 2".*keep\.txt/);
});
