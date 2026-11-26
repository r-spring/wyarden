const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// board.js imports "vscode", which exists only inside VS Code. This stand-in has just what Board touches (as in board.test.js).
class EventEmitter {
  listeners = [];
  event = (l) => (this.listeners.push(l), { dispose() {} });
  fire(e) { for (const l of this.listeners) l(e); }
  dispose() {}
}
const vscode = { EventEmitter, ThemeIcon: class {}, commands: { executeCommand: async () => {} },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined } };
const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-home-"));
process.env.HOME = process.env.USERPROFILE = home;
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board } = require("../out/board.js");
const { alive, readJson, saveJson } = require("../out/jobs.js");
const { runChecks, failureReadout } = require("../out/worker.js");

/**
 * Removes a test folder, retrying for up to 30 s. Node's own maxRetries gives up on EPERM at once on Windows (measured on Node 26,
 * 12 November 2026), and a killed check's powershell or conhost can keep the folder as its working folder for seconds under load.
 */
async function removeDir(dir) {
  for (const until = Date.now() + 30_000; ;) {
    try { return fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(e.code) || Date.now() > until) throw e; }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// The worker runs each command in powershell.exe on Windows and /bin/sh elsewhere.
const exit = (code) => process.platform === "win32" ? `& '${process.execPath}' -e 'process.exit(${code})'` : `'${process.execPath}' -e 'process.exit(${code})'`;

test("a task with commands runs its checks at Review", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-checks-"));
  const board = new Board(repo, path.join(repo, "hook.js"));
  try {
    const rule = (commands) => ({ commands, doneWhen: "It works." });
    const pass = board.add("Pass", "p", undefined, undefined, undefined, undefined, rule([exit(0), exit(0)]));
    const fail = board.add("Fail", "f", undefined, undefined, undefined, undefined, rule([exit(0), exit(3)]));
    const none = board.add("None", "n");
    pass.worktree = fail.worktree = repo; // checks run only in a worktree that exists
    const results = [];
    board.checks.onResult = (task, passed, error) => results.push([task.title, passed, error]);
    board.update(pass, { status: "running" }); // not ready for review: nothing runs
    assert.equal(pass.checks, undefined);
    for (const t of [pass, fail, none]) board.update(t, { status: "review" });
    assert.equal(pass.checks.status, "running");
    assert.equal(fail.checks.status, "running");
    assert.equal(none.checks, undefined); // no commands
    const done = () => [pass, fail].every((t) => t.checks.status !== "running");
    for (let i = 0; i < 150 && !done(); i++) { await new Promise((r) => setTimeout(r, 200)); board.checks.sync(); }
    assert.equal(pass.checks.status, "complete");
    assert.equal(fail.checks.status, "error");
    for (const task of [pass, fail]) {
      const job = readJson(path.join(task.checks.run, "job.json")), receipt = readJson(path.join(task.checks.run, "receipt.json"));
      assert.match(job.ruleId, /^[0-9a-f]{64}$/);
      assert.equal(receipt.ruleId, job.ruleId);
      assert.deepEqual(receipt.commands, task.completion.commands);
    }
    // powershell.exe -Command reports any failed native command as exit 1.
    const code = process.platform === "win32" ? 1 : 3;
    assert.match(fail.checks.error, new RegExp(`^Acceptance check 2 failed: .+ exited with ${code}\\.$`));
    assert.equal(fail.checks.failure.exitCode, code); // the card's What failed and Fix it read this
    assert.deepEqual(results.map(([t, p]) => [t, p]).sort(), [["Fail", false], ["Pass", true]]);
    assert.ok(fs.existsSync(path.join(fail.checks.run, "check-1.json")));
    // Recording a result is not a change to the work: the card keeps its place.
    const before = pass.updatedAt;
    board.checks.start(pass);
    assert.equal(pass.updatedAt, before);
    // Retry checks starts a new run in its own folder.
    const first = fail.checks.run;
    board.checks.start(fail);
    assert.equal(fail.checks.status, "running");
    assert.notEqual(fail.checks.run, first);
  } finally {
    // The retried workers run in the repo: let them finish before it goes (under a full npm test they can take seconds).
    for (let i = 0; i < 100 && board.tasks.some((t) => t.checks?.status === "running"); i++) { await new Promise((r) => setTimeout(r, 200)); board.checks.sync(); }
    board.dispose();
    await removeDir(repo);
  }
});
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test("a worker that died mid-run is reported as interrupted and not run again; a stopped session's move to Review runs nothing", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-checks-"));
  const board = new Board(repo, path.join(repo, "hook.js"));
  try {
    const task = board.add("Died", "d", undefined, undefined, undefined, undefined, { commands: [exit(0)], doneWhen: "It works." });
    board.update(task, { status: "running" });
    // A Stop or a closed session moves the card quietly (board.ts discover): that work is unfinished, so its checks do not run.
    board.status.fire({ task, from: "running", to: "review", quiet: true });
    assert.equal(task.checks, undefined);
    // A run whose worker is gone without a receipt (killed, crashed): its launch record names a process that has exited.
    const run = path.join(board.dir, "checks", task.id, "1");
    const dead = require("node:child_process").spawnSync(process.execPath, ["-e", "0"]).pid;
    saveJson(path.join(run, "launch.json"), { status: "running", pid: dead, heartbeat: Date.now(), bootTime: Date.now() - os.uptime() * 1000 });
    board.recordChecks(task, { status: "running", run });
    const results = [];
    board.checks.onResult = (t, passed, error) => results.push([t.title, passed, error]);
    board.checks.sync();
    board.checks.sync(); // reported once
    const interrupted = "Acceptance checks were interrupted. Retry checks when ready.";
    assert.deepEqual(results, [["Died", false, interrupted]]);
    assert.deepEqual(task.checks, { status: "error", run, error: interrupted });
    assert.deepEqual(fs.readdirSync(path.dirname(run)), ["1"]); // not run again by itself: its commands may have changed things
  } finally {
    board.dispose();
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test("the check worker records success and failure without any model calls", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-worker-"));
  try {
    for (const [name, command, status] of [["pass", "exit 0", "complete"], ["fail", "exit 9", "error"]]) {
      const input = path.join(dir, name, "job.json");
      saveJson(input, { cwd: dir, commands: [command], revision: "abc123", phase: "delivery", at: "2026-11-04T22:39:13Z" });
      await runChecks(input);
      const receipt = readJson(path.join(path.dirname(input), "receipt.json"));
      assert.equal(receipt.status, status);
      assert.deepEqual([receipt.revision, receipt.phase, receipt.at], ["abc123", "delivery", "2026-11-04T22:39:13Z"]);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a detached check worker finishes after its launching host exits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-worker-"));
  let receipt;
  try {
    const input = path.join(dir, "detached", "job.json");
    saveJson(input, { cwd: dir, commands: [process.platform === "win32" ? "Start-Sleep -Milliseconds 200; exit 0" : "sleep 0.2; exit 0"] });
    const code = `require(${JSON.stringify(path.resolve(__dirname, "../out/jobs.js"))}).startWorker(${JSON.stringify(input)});`;
    require("node:child_process").execFileSync(process.execPath, ["-e", code], { timeout: 5000 });
    for (let i = 0; i < 100; i++) {
      const file = path.join(path.dirname(input), "receipt.json");
      if (fs.existsSync(file)) receipt = readJson(file);
      if (receipt?.status === "complete" || receipt?.status === "error") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(receipt?.status, "complete", receipt?.error);
  } finally {
    // The worker writes its final receipt and then exits. On Windows its working folder (inside dir) cannot be removed while it
    // runs (EPERM), so wait for it to exit, then remove with a bounded retry for the moment its handles close.
    // Up to 20 s: 5 s ran out under the full suite's load (12 November 2026) and the remove then hit EPERM; an exited worker ends the wait at once.
    for (let i = 0; i < 400 && receipt?.pid && alive(receipt.pid); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    // A remove that still fails is not this test's failure: test/run.js deletes the whole test folder at the end. It failed here
    // with EPERM in two full-suite runs on a busy machine (12 November 2026) and never with the file run alone.
    try { await removeDir(dir); } catch { /* left for test/run.js */ }
  }
});

/** A board and one card with these check commands, whose worktree is the repo folder itself. */
function checked(commands) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-checks-"));
  const board = new Board(repo, path.join(repo, "hook.js"));
  const task = board.add("Checked", "c", undefined, undefined, undefined, undefined, { commands, doneWhen: "It works." });
  task.worktree = repo;
  const done = async () => {
    board.checks.stop?.(task); // ?.: the test still reports its own failure on code without stop()
    for (let i = 0; i < 100 && board.tasks.some((t) => t.checks?.status === "running"); i++) { await new Promise((r) => setTimeout(r, 100)); board.checks.sync(); }
    board.dispose();
    await removeDir(repo);
  };
  board.checks.onResult = () => {};
  return { repo, board, task, done };
}
const launched = async (run) => {
  for (let i = 0; i < 100 && !fs.existsSync(path.join(run, "launch.json")); i++) await new Promise((r) => setTimeout(r, 50));
  return readJson(path.join(run, "launch.json")).pid;
};
const sleepFor = (s) => process.platform === "win32" ? `Start-Sleep ${s}` : `sleep ${s}`;

for (const outcome of ["pass", "fail", "interrupt"]) {
  test(`a check worker exits during polling: ${outcome}`, { skip: !["win32", "linux"].includes(process.platform) }, async (t) => {
    const command = `${process.platform === "win32" ? "& " : ""}'${process.execPath}' check.cjs`;
    const { repo, board, task, done } = checked([command]);
    const cwd = task.worktree = path.join(repo, "work");
    const release = path.join(repo, "release");
    try {
      fs.mkdirSync(cwd);
      fs.writeFileSync(path.join(cwd, "tracked"), "before\n");
      fs.writeFileSync(path.join(cwd, "check.cjs"), [
        "const fs = require('node:fs'), wait = new Int32Array(new SharedArrayBuffer(4));",
        "const deadline = Date.now() + 30000;",
        "while (!fs.existsSync('../release')) { if (Date.now() > deadline) process.exit(99); Atomics.wait(wait, 0, 0, 10); }",
        outcome === "pass" ? "fs.appendFileSync('tracked', 'checked\\n');"
          : outcome === "fail" ? "console.error('not ok - fixture'); process.exitCode = 7;" : "",
      ].join("\n"));
      const git = (...args) => require("node:child_process").execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      git("init", "-q");
      git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
      board.checks.onResult = undefined; // Only the explicit poll below may collect the result.
      board.checks.start(task);
      const started = task.checks;
      assert.equal(started.clean, true);
      assert.equal(started.revision, git("rev-parse", "HEAD"));
      const file = path.join(started.run, "receipt.json");
      for (let i = 0; i < 600 && !fs.existsSync(file); i++) await new Promise(r => setTimeout(r, 50));

      // Hold the poll after its actual running read until the detached worker exits.
      // While this thread waits, an exited Linux child can still have a zombie pid with an empty cmdline.
      t.mock.method(require("../out/jobs"), "readJson", (name) => {
        assert.equal(name, file);
        const running = readJson(file);
        assert.equal(running.status, "running");
        if (outcome === "interrupt") process.kill(running.pid, "SIGKILL");
        fs.writeFileSync(release, "");
        const wait = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 30000;
        while (alive(running.pid) && (process.platform !== "linux" || fs.readFileSync(`/proc/${running.pid}/cmdline`).length)) {
          assert.ok(Date.now() < deadline, "worker did not exit");
          Atomics.wait(wait, 0, 0, 10);
        }
        return running;
      }, { times: 1 });
      const results = [];
      board.checks.onResult = (card, passed, error) => results.push([card.id, passed, error]);
      board.checks.sync();
      board.checks.sync();
      const receipt = readJson(file);
      const job = readJson(path.join(started.run, "job.json"));
      assert.deepEqual([receipt.commands, receipt.ruleId, receipt.revision, receipt.at, receipt.phase],
        [[command], job.ruleId, started.revision, started.at, "task"]);
      assert.match(job.ruleId, /^[0-9a-f]{64}$/);
      const passed = outcome === "pass";
      const status = passed ? "complete" : "error";
      assert.equal(receipt.status, outcome === "interrupt" ? "running" : status);
      const expected = { ...started, status, clean: false };
      if (passed) {
        assert.equal(fs.readFileSync(path.join(cwd, "tracked"), "utf8"), "before\nchecked\n");
      } else if (outcome === "fail") {
        const exitCode = process.platform === "win32" ? 1 : 7;
        expected.error = `Acceptance check 1 failed: ${command} exited with ${exitCode}.`;
        expected.failure = receipt.failure;
        assert.deepEqual([receipt.failure.command, receipt.failure.exitCode, receipt.failure.lines], [command, exitCode, ["not ok - fixture"]]);
      } else {
        expected.error = "Acceptance checks were interrupted. Retry checks when ready.";
      }
      assert.deepEqual(readJson(board.file).find(card => card.id === task.id).checks, expected);
      assert.deepEqual(results, [[task.id, passed, expected.error]]);
      assert.deepEqual(fs.readdirSync(path.dirname(started.run)), [path.basename(started.run)]);
    } finally {
      fs.writeFileSync(release, "");
      board.checks.onResult ??= () => {};
      await done();
    }
  });
}

test("a turn ended by an API error runs no checks and leaves the card Interrupted, so it releases no Start after card", async () => {
  const { board, task, done } = checked([exit(0)]);
  try {
    const { finished } = require("../out/queue.js");
    board.update(task, { status: "running" });
    board.update(task, { status: "review" }, "rate_limit"); // StopFailure (board.ts syncStatus), or a Fable limit resuming on Opus
    assert.deepEqual([task.checks, task.interrupted, finished(task)], [undefined, true, false]);
  } finally { await done(); }
});

test("checks never run in the main checkout: a card whose worktree is gone says so and starts no worker", async () => {
  const { repo, board, task, done } = checked([exit(0)]);
  try {
    const gone = "This task's worktree is gone, so its checks cannot run.";
    for (const worktree of [undefined, path.join(repo, "removed")]) { // Finish, Merge and Discard clear it; or it was deleted by hand
      task.worktree = worktree;
      board.recordChecks(task, { status: "complete", run: "an-old-run" });
      board.checks.start(task);
      // No run folder: the tooltip must not name an old run's logs beside "worktree is gone".
      assert.deepEqual([task.checks.status, task.checks.error, task.checks.run], ["error", gone, ""]);
    }
    assert.equal(fs.existsSync(path.join(board.dir, "checks", task.id)), false);
  } finally { await done(); }
});

test("a result that finished while no window watched waits for onResult, so VS Code announces it", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-checks-"));
  let board = new Board(repo, path.join(repo, "hook.js"));
  try {
    const task = board.add("Closed", "c", undefined, undefined, undefined, undefined, { commands: [exit(0)], doneWhen: "It works." });
    const run = path.join(board.dir, "checks", task.id, "1");
    saveJson(path.join(run, "receipt.json"), { status: "complete", checksPassed: true });
    board.recordChecks(task, { status: "running", run });
    board.dispose();
    board = new Board(repo, path.join(repo, "hook.js")); // its constructor ticks before the extension sets onResult
    assert.equal(board.get(task.id).checks.status, "running");
    const results = [];
    board.checks.onResult = (t, passed, error) => results.push([t.title, passed, error]);
    board.checks.sync();
    assert.deepEqual(results, [["Closed", true, undefined]]);
  } finally {
    board.dispose();
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test("one run per card: a new run ends the earlier one still going, with its commands", async () => {
  const { board, task, done } = checked([sleepFor(30)]);
  try {
    board.update(task, { status: "review" });
    const first = await launched(task.checks.run);
    await new Promise((r) => setTimeout(r, 500)); // its command has started
    board.checks.start(task); // Retry checks
    for (let i = 0; i < 100 && alive(first); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(first), false);
    assert.equal(task.checks.status, "running");
  } finally { await done(); }
});

test("a run whose worker stopped beating for over 60 s is dead, even when its pid is in use again", async () => {
  const { board, task, done } = checked([exit(0)]);
  try {
    const run = path.join(board.dir, "checks", task.id, "1");
    saveJson(path.join(run, "receipt.json"), { status: "running", pid: process.pid, heartbeat: Date.now() - 61_000, bootTime: Date.now() - os.uptime() * 1000 });
    board.recordChecks(task, { status: "running", run });
    board.checks.sync();
    assert.deepEqual([task.checks.status, task.checks.error], ["error", "Acceptance checks were interrupted. Retry checks when ready."]);
  } finally { await done(); }
});

test("Linux: a live worker with an old heartbeat (suspend, a stall) is still running, and a new start ends it", { skip: process.platform !== "linux" }, async () => {
  const { board, task, done } = checked([exit(0)]);
  const run = path.join(board.dir, "checks", task.id, "1");
  // Stands in for the worker: its command line names the run's job.json, as jobs.ts startWorker's does.
  const stalled = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", path.join(run, "job.json")], { detached: true, stdio: "ignore" });
  try {
    saveJson(path.join(run, "receipt.json"), { status: "running", pid: stalled.pid, heartbeat: Date.now() - 120_000, bootTime: Date.now() - os.uptime() * 1000 });
    board.recordChecks(task, { status: "running", run });
    board.checks.sync();
    assert.equal(task.checks.status, "running");
    board.checks.start(task); // Retry checks: one run per worktree
    for (let i = 0; i < 100 && alive(stalled.pid); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(stalled.pid), false);
  } finally { try { stalled.kill(); } catch { /* gone */ } await done(); }
});

test("Linux: a receipt's pid now used by another process is not the worker: it is not killed, and the run reads as interrupted", { skip: process.platform !== "linux" }, async () => {
  const { board, task, done } = checked([exit(0)]);
  const run = path.join(board.dir, "checks", task.id, "1");
  const other = require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  try {
    saveJson(path.join(run, "receipt.json"), { status: "running", pid: other.pid, heartbeat: Date.now(), bootTime: Date.now() - os.uptime() * 1000 });
    board.recordChecks(task, { status: "running", run });
    board.checks.stop(task);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(alive(other.pid), true);
    board.checks.sync();
    assert.deepEqual([task.checks.status, task.checks.error], ["error", "Acceptance checks were interrupted. Retry checks when ready."]);
  } finally { other.kill(); await done(); }
});

test("a start that throws leaves an error on the card, not the earlier pass", async () => {
  const { board, task, done } = checked([exit(0)]);
  try {
    board.recordChecks(task, { status: "complete", run: "old" });
    fs.mkdirSync(path.join(board.dir, "checks"), { recursive: true });
    fs.writeFileSync(path.join(board.dir, "checks", task.id), ""); // a file where its run folders go: the run cannot be written
    assert.throws(() => board.checks.start(task));
    assert.equal(task.checks.status, "error");
    assert.match(task.checks.error, /^Acceptance checks could not start: /);
  } finally { await done(); }
});

test("Retry checks in a window that does not own the board says so", async () => {
  const { board, task, done } = checked([exit(0)]);
  const owner = path.join(board.dir, "owner.json");
  try {
    fs.writeFileSync(owner, JSON.stringify({ pid: process.ppid, at: Date.now() })); // another window, stood in for by the parent process
    assert.throws(() => board.checks.start(task), /Another VS Code window runs this repo's board/);
    assert.equal(task.checks, undefined);
  } finally { fs.rmSync(owner, { force: true }); await done(); }
});

test("a card keeps its newest 10 run folders, and deleting the card removes them", async () => {
  const { board, task, done } = checked([exit(0)]);
  try {
    const dir = path.join(board.dir, "checks", task.id);
    for (let i = 1; i <= 11; i++) fs.mkdirSync(path.join(dir, String(i)), { recursive: true });
    board.checks.start(task);
    const kept = fs.readdirSync(dir).map(Number).sort((a, b) => a - b);
    assert.deepEqual(kept.slice(0, 9), [3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal(kept.length, 10);
    for (let i = 0; i < 600 && task.checks.status === "running"; i++) { await new Promise((r) => setTimeout(r, 100)); board.checks.sync(); }
    assert.notEqual(task.checks.status, "running", "the check run did not end within 60 s");
    board.remove(task);
    // On Windows an ended check can hold its run folder a moment longer; remove() then skips it (board.ts), so only that newest run may be left.
    if (process.platform === "win32" && fs.existsSync(dir)) {
      assert.equal(fs.readdirSync(dir).length <= 1, true, "only the in-use run folder may be left");
      await removeDir(dir);
    }
    assert.equal(fs.existsSync(dir), false);
  } finally { await done(); }
});

test("check commands do not inherit ELECTRON_RUN_AS_NODE from the worker", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-worker-"));
  const was = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = "1"; // as jobs.ts starts the worker
  try {
    const input = path.join(dir, "env", "job.json");
    saveJson(input, { cwd: dir, commands: [process.platform === "win32" ? "if ($env:ELECTRON_RUN_AS_NODE) { exit 1 }" : 'test -z "$ELECTRON_RUN_AS_NODE"'] });
    await runChecks(input);
    assert.equal(readJson(path.join(path.dirname(input), "receipt.json")).status, "complete");
  } finally {
    if (was === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a heartbeat that cannot be written does not crash the worker", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-worker-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  t.mock.timers.enable({ apis: ["setInterval"] });
  const input = path.join(dir, "beat", "job.json");
  const receipt = path.join(dir, "beat", "receipt.json");
  saveJson(input, { cwd: dir, commands: ["exit 0"] });
  const running = runChecks(input);
  assert.equal(readJson(receipt).status, "running");
  const writes = t.mock.method(require("../out/jobs"), "saveJson");
  fs.rmSync(receipt);
  fs.mkdirSync(path.join(receipt, "occupied"), { recursive: true });
  try {
    t.mock.timers.tick(5000);
    assert.equal(writes.mock.callCount(), 1);
    const beat = writes.mock.calls[0];
    assert.equal(beat.arguments[0], receipt);
    assert.ok(beat.error, "the heartbeat actually failed to write its receipt");
  } finally {
    fs.rmSync(receipt, { recursive: true });
    await running;
  }
  assert.equal(readJson(receipt).status, "complete");
});

test("a failed check records its command, exit code, the lines naming the failure and the end of its output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-worker-"));
  try {
    const input = path.join(dir, "run", "job.json");
    const script = path.join(dir, "out.js");
    fs.writeFileSync(script, ["console.log('ok 1 - adds');", "console.log('\\u001b[31mnot ok 2 - subtracts\\u001b[0m');",
      "console.log('  AssertionError: expected 1 to equal 2');", "console.log('ℹ fail 0');", "for (let i = 0; i < 40; i++) console.log('line ' + i);",
      "process.exit(4);"].join("\n"));
    const command = `${process.platform === "win32" ? "& " : ""}'${process.execPath}' '${script}'`;
    saveJson(input, { cwd: dir, commands: [command] });
    await runChecks(input);
    const { failure } = readJson(path.join(dir, "run", "receipt.json"));
    assert.equal(failure.command, command);
    assert.equal(failure.exitCode, process.platform === "win32" ? 1 : 4);
    assert.deepEqual(failure.lines, ["not ok 2 - subtracts", "  AssertionError: expected 1 to equal 2"]); // colour codes gone; "fail 0" is no failure
    assert.equal(failure.tail.split("\n").length, 30);
    assert.match(failure.tail, /line 39$/);
    assert.equal(failure.log, path.join(dir, "run", "check-0.log"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a synthetic check failure names the missing launcher and excludes every passed test", () => {
  // Authored passed-title decoys and a missing-launcher failure block; no historical input.
  const result = failureReadout(path.join(__dirname, "fixtures", "orchestrator-check.synthetic.log"));
  assert.ok(result.lines.some((line) => /entomatical-claude\.exe ENOENT/.test(line)));
  assert.ok(result.lines.every((line) => !/^\s*[✔✓]/.test(line)), result.lines.join("\n"));
  assert.ok(result.lines.some((line) => /✖ wrapper passes streams unchanged/.test(line)));
});

test("orchestrator planning and coordination stops cannot run delivery acceptance", async () => {
  const { board, task, done } = checked([exit(0)]);
  try {
    task.orchestrator = { caps: {}, opened: 0 };
    board.update(task, { status: "running" });
    board.update(task, { status: "review", plan: { at: "now", steps: 2, points: 4 } });
    assert.equal(task.checks, undefined);
    board.checks.start(task); // Retry does not silently turn a planning phase into delivery.
    assert.equal(task.checks, undefined);
    task.deliveryReady = true;
    board.checks.start(task);
    assert.equal(task.checks.status, "running");
    assert.equal(task.checks.phase, "delivery");
    assert.ok(Date.parse(task.checks.at));
    const job = readJson(path.join(task.checks.run, "job.json"));
    assert.equal(job.phase, "delivery");
    assert.equal(job.at, task.checks.at);
  } finally { await done(); }
});

test("What failed on a synthetic regression log: the ENOENT failing block, its command, exit code and full log, and none of the passed tests that mention failures", async () => {
  // Authored regression input and ten incorrect passed-title selections; no historical log or receipt.
  const fixture = path.join(__dirname, "fixtures", "check-enoent.synthetic.log");
  const old = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "check-enoent-previous-lines.json"), "utf8")).failure.lines;
  assert.equal(old.length, 10);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-enoent-"));
  try {
    const input = path.join(dir, "run", "job.json");
    const script = path.join(dir, "replay.js");
    fs.writeFileSync(script, `process.stdout.write(require("fs").readFileSync(${JSON.stringify(fixture)})); process.exitCode = 1;`);
    const command = `${process.platform === "win32" ? "& " : ""}'${process.execPath}' '${script}'`;
    saveJson(input, { cwd: dir, commands: [command] });
    await runChecks(input);
    const receipt = readJson(path.join(dir, "run", "receipt.json"));
    const { failure } = receipt;
    assert.deepEqual([receipt.checksPassed, failure.command, failure.exitCode, failure.log], [false, command, 1, path.join(dir, "run", "check-0.log")]);
    assert.equal(fs.readFileSync(failure.log, "utf8"), fs.readFileSync(fixture, "utf8"), "the full log is kept unchanged");
    assert.equal(failure.lines[0], "test at test\\metrics.test.js:86:1");
    assert.equal(failure.lines[1], "✖ wrapper passes streams unchanged and records only usage metadata across reset and resume (14.5956ms)");
    assert.match(failure.lines[2], /^ {2}Error: spawnSync .*wrapper\\entomatical-claude\.exe ENOENT$/);
    assert.ok(failure.lines.includes("    code: 'ENOENT',"));
    assert.ok(failure.lines.length <= 10 && failure.lines.every((l) => !/^\s+at\s/.test(l)), "no stack frames");
    for (const l of old) assert.ok(!failure.lines.includes(l), `a passed test is not a failure: ${l}`);
    assert.ok(failure.lines.every((l) => !l.trimStart().startsWith("✔")));
    assert.match(failure.tail, /code: 'ENOENT'/);
    // Straight from the file too, and a log with no summary block: passed titles that say "failure" never count.
    assert.deepEqual(failureReadout(fixture).lines, failure.lines);
    const plain = path.join(dir, "plain.log");
    fs.writeFileSync(plain, ["✔ a failed check shows What failed (5.1ms)", "ok 3 - errors are reported", "PASS test/failure.test.js", "not ok 4 - subtracts", "  AssertionError: 1 !== 2"].join("\n"));
    assert.deepEqual(failureReadout(plain).lines, ["not ok 4 - subtracts", "  AssertionError: 1 !== 2"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- BUG-14 (19 November 2026): a check's time limit is measured, finite, and never "none" (src/checks.ts checkLimitMs).

test("BUG-14: every check command gets a whole, finite time limit, and it is still one after its job file is written and read", () => {
  const { checkLimitMs, checkLimitsMs, CHECK_TIME_FACTOR, DEFAULT_CHECK_MINUTES, MAX_CHECK_LIMIT_MS } = require("../out/checks.js");
  const byDefault = DEFAULT_CHECK_MINUTES * CHECK_TIME_FACTOR * 60_000;
  assert.equal(checkLimitMs(11), 11 * CHECK_TIME_FACTOR * 60_000);
  assert.equal(checkLimitMs(0.001), 180, "a fraction of a minute stays what it says");
  // Not an estimate: the default, never no limit. Infinity is what JSON.parse gives for 1e999, and what JSON.stringify writes as null.
  for (const minutes of [undefined, null, 0, -1, NaN, Infinity, -Infinity, "11", true, {}, [11]]) assert.equal(checkLimitMs(minutes), byDefault, String(minutes));
  assert.equal(checkLimitMs(1e-12), 1, "never rounded down to 0, which the worker reads as no limit");
  // Node runs a timer longer than 2^31-1 ms after 1 ms: a huge estimate must not end its check at once.
  assert.ok(MAX_CHECK_LIMIT_MS < 2 ** 31 - 1);
  for (const minutes of [MAX_CHECK_LIMIT_MS / 60_000, 11_931, 1e9, Number.MAX_VALUE]) assert.equal(checkLimitMs(minutes), MAX_CHECK_LIMIT_MS, String(minutes));

  // As a catalogue file gives them, through the job file to the worker (worker.ts: `const limit = job.limitsMs?.[i]`).
  const catalogue = JSON.parse('{"inf":{"run":"a","minutes":1e999},"zero":{"run":"b","minutes":0},"none":{"run":"c"},"text":{"run":"d","minutes":"5"},"huge":{"run":"e","minutes":99999999},"ok":{"run":"f","minutes":4}}');
  assert.equal(catalogue.inf.minutes, Infinity);
  const commands = ["a", "b", "c", "d", "e", "f", "ok", "not in the catalogue"];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-limits-"));
  try {
    saveJson(path.join(dir, "job.json"), { commands, limitsMs: checkLimitsMs(commands, catalogue) });
    const { limitsMs } = readJson(path.join(dir, "job.json"));
    assert.deepEqual(limitsMs, [byDefault, byDefault, byDefault, byDefault, MAX_CHECK_LIMIT_MS, 4 * CHECK_TIME_FACTOR * 60_000, 4 * CHECK_TIME_FACTOR * 60_000, byDefault]);
    assert.ok(limitsMs.every((ms) => Number.isSafeInteger(ms) && ms >= 1 && ms <= MAX_CHECK_LIMIT_MS));
    assert.deepEqual(readJson(path.join(dir, "job.json")).limitsMs, checkLimitsMs(commands, catalogue), "nothing became null on the way");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(checkLimitsMs(["npm test"], undefined), [byDefault], "no catalogue: still a limit");
});

test("BUG-14: the shipped catalogue's limit for the full suite covers its slowest measured run with two more ahead in the queue", () => {
  const { readCatalogue, checkLimitsMs, CHECK_TIME_FACTOR, MAX_CHECK_LIMIT_MS } = require("../out/checks.js");
  const catalogue = readCatalogue(path.join(__dirname, ".."));
  // Windows, the slow machine. 521.3 s: the test runner's duration in the audit's run (docs/plans/2026-11-18-workspace-remediation.md,
  // exit 1, 3 failed), which the old limit of 2 x 3 minutes stopped. `npm test` alone on 19 November 2026, both past those 360 s:
  // 383.0 s at 1e7119c8 (3.6 s before the queue, 0 s waiting, 379.5 s holding the lock; exit 0, 1,595 tests, 35 skipped) and
  // 407.9 s at 7998967e (3.7 s, 0 s, 404.2 s; exit 1, 1,599 tests, 1 failed: test/plan-setup-webview.test.js, which passes alone).
  // Linux, on main, 23 November 2026: 112 to 132 s (docs/evidence/bug-14-2026-11-23).
  const SLOWEST_RUN_S = 521.3, MEASURED_ALONE_S = 407.9, HEADROOM = 1.25;
  const full = Object.keys(catalogue).filter((name) => /^npm test\b/.test(catalogue[name].run));
  assert.deepEqual(full, ["test"], "the entry that runs the whole suite (the public workflows/checks.json omits the private parent-test)");
  for (const name of full) {
    const { run, minutes } = catalogue[name];
    assert.ok(Number.isInteger(minutes) && minutes * 60 >= SLOWEST_RUN_S * HEADROOM, `${name}: ${minutes} minutes is the slowest run plus a quarter, rounded up`);
    assert.ok((minutes - 1) * 60 < SLOWEST_RUN_S * HEADROOM, `${name}: and no more than that, so the estimate stays a measurement`);
    const [limit] = checkLimitsMs([run], catalogue);
    assert.equal(limit, minutes * CHECK_TIME_FACTOR * 60_000);
    assert.ok(limit > Math.max(SLOWEST_RUN_S, MEASURED_ALONE_S) * 1000, `${name}: an ordinary run ends inside its limit`);
    assert.ok(limit >= 3 * SLOWEST_RUN_S * 1000, `${name}: its own run and two slow runs ahead of it on the suite lock`);
    assert.ok(limit <= 60 * 60_000, `${name}: a suite that hangs is still stopped within the hour`);
  }
  // Every shipped entry, whatever it runs.
  const limits = checkLimitsMs(Object.values(catalogue).map((entry) => entry.run), catalogue);
  assert.equal(limits.length, Object.keys(catalogue).length);
  assert.ok(limits.every((ms) => Number.isSafeInteger(ms) && ms >= 60_000 && ms <= MAX_CHECK_LIMIT_MS), limits.join(" "));
});

test("BUG-14: the worker holds each command to its own limit: one inside its limit passes, the next one past its limit is stopped", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-worker-"));
  // A node one-liner as a check command in each shell's quoting (no double quote and no $ inside it).
  const node = (js) => `${process.platform === "win32" ? "& " : ""}'${process.execPath}' -e "${js}"`;
  try {
    const input = path.join(dir, "limits", "job.json");
    const inside = node("setTimeout(() => {}, 300)"), stuck = node("setTimeout(() => {}, 120000)");
    // 60 s for 0.3 s of work: a loaded machine has taken 25 s to start and end a check (test/finish.test.js). 0.5 s for 120 s.
    saveJson(input, { cwd: dir, commands: [inside, stuck], limitsMs: [60_000, 500] });
    const started = Date.now();
    await runChecks(input);
    const receipt = readJson(path.join(dir, "limits", "receipt.json"));
    assert.deepEqual([receipt.status, receipt.checksPassed], ["error", false]);
    assert.equal(receipt.error, `Error: Acceptance check 2 timed out: ${stuck} ran past its limit of 0.5 seconds and was stopped.`);
    assert.ok(Date.now() - started < 60_000, "it did not wait for the stuck command to end by itself");
    const first = readJson(path.join(dir, "limits", "check-0.json")), second = readJson(path.join(dir, "limits", "check-1.json"));
    assert.deepEqual([first.exitCode, first.timedOut], [0, undefined]);
    assert.equal(second.timedOut, true);
    assert.equal(receipt.failure.command, stuck);
  } finally { try { await removeDir(dir); } catch { /* a stopped command's shell can hold it a while longer: left for test/run.js */ } }
});

test("Fix it types the failure into the board's live terminal, and hands a panel session the prompt to paste", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-fix-"));
  const board = new Board(repo, path.join(repo, "hook.js"));
  try {
    const task = board.add("Fix", "f", undefined, undefined, undefined, undefined, { commands: ["npm test"], doneWhen: "Tests pass." });
    await assert.rejects(board.fixChecks(task), /no failed acceptance check/);
    const failure = { command: "npm test", exitCode: 1, lines: ["not ok 2 - subtracts"], tail: "…\nnot ok 2 - subtracts", log: "/x/check-0.log" };
    board.update(task, { status: "review", sessionId: "s1", panel: true });
    board.recordChecks(task, { status: "error", run: "/x", error: "Acceptance check 1 failed: npm test exited with 1.", failure });
    const prompt = board.fixPrompt(task);
    for (const part of ["`npm test` failed (exit 1)", "Lines naming the failure:\nnot ok 2 - subtracts", "End of its output:", "Full log: /x/check-0.log", "fix it"])
      assert.ok(prompt.includes(part), part);
    assert.equal(await board.fixChecks(task), "paste"); // a panel session: the board cannot type into it
    const typed = [];
    board.terminals.set(task.id, { sendText: (t) => typed.push(t) });
    assert.equal(await board.fixChecks(task), "sent");
    assert.equal(typed.length, 1);
    assert.ok(typed[0].includes(prompt));
  } finally {
    board.dispose();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a refused Running save leaves the previous worker, card and listeners intact", { skip: process.platform !== "linux" }, async t => {
  const { board, task, done } = checked([sleepFor(60)]);
  try {
    const other = board.add("Other", "Unrelated edit");
    board.update(task, { status: "needs-input", deliveryReady: true });
    board.checks.start(task);
    const { pid } = readJson(path.join(task.checks.run, "launch.json"));
    const saved = () => readJson(board.file).find(row => row.id === task.id);
    const before = saved();
    let redraws = 0, notices = 0;
    board.onChange(() => redraws++);
    board.onStatus(() => notices++);
    const rename = fs.renameSync;
    t.mock.method(fs, "renameSync", (from, to) => {
      if (to === board.file) throw new Error("fixture: failed before Running commit");
      return rename(from, to);
    });
    assert.throws(() => board.update(task, { status: "running" }), /failed before Running commit/);
    assert.deepEqual([redraws, notices], [0, 0]);
    assert.equal(board.get(task.id), task);
    assert.deepEqual(JSON.parse(JSON.stringify(task)), before);
    assert.deepEqual(saved(), before);
    assert.ok(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(path.join(task.checks.run, "job.json")));
    fs.renameSync.mock.restore();
    board.update(other, { title: "Edited" });
    assert.deepEqual(saved(), before);
  } finally { fs.renameSync.mock?.restore(); await done(); }
});

test("retiring a check preserves the replay cursor and keeps its evidence through a failed Delete", { skip: process.platform !== "linux" }, async t => {
  const { board, task, done } = checked([sleepFor(60)]);
  try {
    board.update(task, { status: "needs-input" });
    board.checks.start(task);
    const { run } = task.checks, pid = await launched(run);
    const proc = `/proc/${pid}/cmdline`;
    const read = fs.readFileSync;
    const eio = t.mock.method(fs, "readFileSync", (file, ...args) => {
      if (file === proc) throw Object.assign(new Error("cannot read worker identity"), { code: "EIO" });
      return read(file, ...args);
    });
    assert.throws(() => board.update(task, { status: "running" }), /worker identity/);
    assert.equal(task.checks.run, run);
    eio.mock.restore();
    // Keep the real worker alive until the retry. The actual receipt retains its PID.
    const kill = process.kill;
    const signal = t.mock.method(process, "kill", (target, sig) => target === -pid && sig === "SIGTERM" || kill(target, sig));
    board.update(task, { status: "running" });
    const cursor = task.updatedAt;
    assert.throws(() => board.remove(task), /previous acceptance check/);
    assert.ok(board.get(task.id) && fs.existsSync(run));
    assert.ok(signal.mock.calls.some(call => call.arguments[0] === -pid));
    signal.mock.restore();
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 100 && task.retiringChecks?.length; i++) { board.checks.sync(); await pause(20); }
    assert.equal(task.retiringChecks, undefined);
    assert.equal(task.updatedAt, cursor);
    board.remove(task);
    assert.equal(board.get(task.id), undefined);
  } finally { t.mock.restoreAll(); await done(); }
});

for (const fault of ["host exit", "receipt EIO"]) {
  test(`recover the old detached check after the Running commit / ${fault}`, { skip: process.platform !== "linux" }, async t => {
    const { repo, board, task, done } = checked([sleepFor(60)]);
    const owner = path.join(board.dir, "owner.json");
    const workers = [];
    const running = ({ pid, run }) => {
      try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(path.join(run, "job.json")); }
      catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return false; throw error; }
    };
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    let reopened;
    try {
      board.update(task, { status: "needs-input", deliveryReady: true });
      board.checks.start(task);
      const run = task.checks.run, old = { run, pid: await launched(run) };
      workers.push(old);
      const receipt = path.join(run, "receipt.json");
      for (let i = 0; i < 100 && !fs.existsSync(receipt); i++) await delay(50);
      assert.equal(readJson(receipt).pid, old.pid);
      assert.ok(running(old));
      board.dispose();
      saveJson(owner, { pid: 0, at: 0 });
      const child = require("node:child_process").spawnSync(process.execPath,
        [path.join(__dirname, "fixtures/check-transition-host.cjs"), repo, task.id, fault], { encoding: "utf8", timeout: 10000 });
      assert.equal(child.status, fault === "host exit" ? 81 : 0, child.error?.message ?? child.stderr);
      if (fault === "receipt EIO") {
        const { committed, injected } = JSON.parse(child.stdout);
        assert.ok(committed);
        t.diagnostic(`receipt EIO injections after commit: ${injected}`);
      }
      const saved = readJson(board.file).find(row => row.id === task.id);
      assert.equal(saved.status, "running");
      reopened = new Board(repo, path.join(repo, "hook.js"), undefined, false);
      reopened.checks.onResult = () => {};
      reopened.begin();
      assert.ok(reopened.isOwner());
      reopened.tick();
      for (let i = 0; i < 40 && running(old); i++) await delay(25);
      const card = reopened.get(task.id);
      const signals = t.mock.method(process, "kill");
      reopened.checks.start(card);
      const next = { run: card.checks.run, pid: await launched(card.checks.run) };
      workers.push(next);
      assert.notEqual(next.run, old.run);
      assert.notEqual(next.pid, old.pid);
      reopened.tick();
      assert.ok(!signals.mock.calls.some(({ arguments: [pid, signal] }) => Math.abs(pid) === next.pid && signal !== 0),
        "recovery must not signal the replacement");
      await delay(100);
      assert.ok(running(next), "recovery must spare the replacement");
      assert.equal(running(old), false, "the old worker still runs alongside the replacement");
    } finally {
      reopened?.dispose();
      for (const signal of ["SIGTERM", "SIGKILL"]) {
        for (const w of workers) {
          if (!running(w)) continue;
          try { process.kill(-w.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
        }
        for (let i = 0; i < 100 && workers.some(running); i++) await delay(25);
      }
      assert.ok(!workers.some(running), "fixture workers must exit before removing their files");
      if (workers.length) { board.dispose(); await removeDir(repo); }
      else await done();
    }
  });
}
