// Run the actual CLI against generated commands and throwaway Git repositories; no host, credentials or real board is used.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { WorkflowStore, admit } = require("../out/workflow.js");
const { assertSafeTemp } = require("./safe-temp");

assertSafeTemp();
const runner = path.resolve(__dirname, "../tools/run-attempt.js");

function fixture(t, scope, board) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-workflow-runner-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo"), hooks = path.join(dir, "hooks");
  for (const d of [repo, hooks]) fs.mkdirSync(d);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"]) delete env[key];
  const git = (...args) => {
    const result = spawnSync("git", ["-c", `core.hooksPath=${hooks}`, ...args], { cwd: repo, env, encoding: "utf8", timeout: 10_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  };
  git("init", "--initial-branch=main");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "generated fixture");
  const store = new WorkflowStore(path.join(repo, ".entomatical", "workflow"));
  const task = { id: "generated", title: "Generated phase", createdAt: "", workflow: { resources: ["auth-prompt", "external-worker"], outcome: "pending" } };
  if (scope) { task.workflow.scope = scope; store.approve(scope); }
  const boardRoot = board === "linked" ? path.join(dir, "linked board") : board && repo;
  if (board === "linked") git("worktree", "add", "-b", "linked", boardRoot);
  const attempt = admit(task, store, { localBudget: 1, boardRoot, owner: board && `${process.pid}:fixture` });
  assert.ok(attempt);
  const cli = (args, passedRepo = repo) => spawnSync(process.execPath, [runner, passedRepo, attempt.id, ...args], { cwd: passedRepo, env, encoding: "utf8", timeout: 10_000, windowsHide: true });
  const start = (args) => {
    const child = spawn(process.execPath, [runner, repo, attempt.id, ...args], { cwd: repo, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
    const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr })); });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await done; } });
    return { child, done };
  };
  const marker = path.join(dir, "phase-ran");
  const bounds = ["--timeout-ms", "2000", "--kill-after-ms", "100", "--"];
  const phase = ["run", "Inspecting", ...bounds, process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'generated phase')", marker];
  const phaseDir = path.join(store.dir, "attempts", `${attempt.id}.phases`);
  return { dir, repo, git, store, task, attempt, cli, start, marker, phase, bounds, phaseDir, boardRoot, env };
}

function saveBoard(repo, tasks) {
  const dir = path.join(repo, ".entomatical");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "tasks.json");
  fs.writeFileSync(file, JSON.stringify(tasks));
  return file;
}

for (const board of ["main", "linked"]) for (const legacy of [false, true]) {
  for (const verb of ["run", "admit", "auth-done"]) test(`runner: ${verb} rechecks an edited ${board} board task (${legacy ? "legacy" : "new"} attempt)`, (t) => {
    const f = fixture(t, undefined, board);
    if (legacy) {
      delete f.attempt.boardRoot;
      f.store.saveAttempt(f.attempt);
    }
    if (board === "linked") {
      // A card with the same id but a different attempt belongs to the calling checkout.
      saveBoard(f.repo, [{ ...f.task, workflow: { ...f.task.workflow, attempt: "other" } }]);
    }
    const file = saveBoard(f.boardRoot, [{ ...f.task, workflow: { ...f.task.workflow, resources: ["writer-typo"] } }]);
    const original = fs.readFileSync(file, "utf8"), claims = f.store.claims(), attempt = f.store.attempt(f.attempt.id);
    const command = verb === "run" ? f.phase : [verb, "generated-ssh", "2"];
    const denied = f.cli(command);
    assert.equal(denied.status, 3, denied.stderr);
    assert.match(denied.stderr, /explicit reconciliation/);
    assert.deepEqual(f.store.claims(), claims);
    assert.deepEqual(f.store.attempt(f.attempt.id), attempt);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(fs.existsSync(f.marker), false);
    assert.equal(fs.existsSync(f.phaseDir), false);
    assert.equal(fs.existsSync(path.join(f.store.dir, "attempts", `${attempt.id}.active-phase.json`)), false);
    assert.equal(f.store.admitted("generated-ssh"), false);
    assert.equal(f.store.receipt(attempt.id), undefined);

    saveBoard(f.boardRoot, [f.task]);
    const allowed = f.cli(command);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(verb === "run" ? fs.existsSync(f.marker) : f.store.admitted("generated-ssh"), true);
  });
}

test("runner: an edit at phase lock acquisition blocks the pending admission", (t) => {
  const f = fixture(t, undefined, "main"), file = saveBoard(f.repo, [f.task]);
  const hook = path.join(f.dir, "edit-at-lock.cjs");
  fs.writeFileSync(hook, `
    const fs = require("node:fs"), open = fs.openSync;
    fs.openSync = function(file, ...args) {
      const fd = open.call(this, file, ...args);
      if (String(file).endsWith(".active-phase.json") && args[0] === "wx") {
        const tasks = JSON.parse(fs.readFileSync(process.env.FIXTURE_TASKS, "utf8"));
        tasks[0].workflow.resources = ["writer-typo"];
        fs.writeFileSync(process.env.FIXTURE_TASKS, JSON.stringify(tasks));
      }
      return fd;
    };
  `);
  f.env.NODE_OPTIONS = `--require "${hook.replaceAll("\\", "/")}"`;
  f.env.FIXTURE_TASKS = file;
  const result = f.cli(["admit", "generated-ssh", "2"]);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /explicit reconciliation/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8"))[0].workflow.resources, ["writer-typo"]);
  assert.equal(f.store.admitted("generated-ssh"), false);
});

test("runner: a pinned board is authoritative and legacy board ownership must be unambiguous", (t) => {
  const f = fixture(t, undefined, "linked");
  saveBoard(f.repo, [f.task]); // A copy of the exact card on the wrong board.
  const file = saveBoard(f.boardRoot, []);
  const command = ["admit", "generated-ssh", "2"];
  for (const contents of ["[]", "{}", "invalid JSON", undefined]) {
    if (contents === undefined) fs.unlinkSync(file); else fs.writeFileSync(file, contents);
    assert.equal(f.cli(command).status, 3);
    assert.equal(f.store.admitted("generated-ssh"), false);
  }
  saveBoard(f.boardRoot, [f.task]);
  delete f.attempt.boardRoot;
  delete f.attempt.owner; // The oldest attempts have only a window PID.
  f.store.saveAttempt(f.attempt);
  assert.match(f.cli(command).stderr, /multiple saved tasks/);
  assert.equal(f.store.admitted("generated-ssh"), false);
  saveBoard(f.repo, []);
  assert.equal(f.cli(command).status, 0);
});

async function waitFor(predicate, description) {
  const until = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < until, `timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const source of ["attempt", "claim", "matching claim"]) for (const verb of ["run", "admit", "auth-done"]) test(`runner: ${verb} refuses an unknown persisted ${source} resource before mutation or execution`, (t) => {
  const f = fixture(t), legacy = "retired-worker-fixture";
  let file;
  if (source === "attempt") {
    f.store.saveAttempt({ ...f.attempt, id: "legacy", resources: [legacy] });
    file = path.join(f.store.dir, "attempts", "legacy.json");
  } else {
    const dir = path.join(f.store.dir, "claims", legacy);
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, "0.json");
    const owner = source === "matching claim" ? f.attempt : { id: "legacy", task: "legacy" };
    fs.writeFileSync(file, JSON.stringify({ resource: legacy, slot: 0, attempt: owner.id, task: owner.task, window: 1, at: "" }));
    if (source === "matching claim") f.store.saveAttempt({ ...f.attempt, resources: [...f.attempt.resources, legacy] });
  }
  const before = fs.readFileSync(file, "utf8"), claims = f.store.claims(), attempt = f.store.attempt(f.attempt.id);
  const result = f.cli(verb === "run" ? f.phase : [verb, "generated-ssh", "2"]);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /explicit reconciliation/);
  assert.equal(fs.existsSync(f.marker), false);
  assert.equal(f.store.admitted("generated-ssh"), false);
  assert.deepEqual(f.store.claims(), claims);
  assert.deepEqual(f.store.attempt(f.attempt.id), attempt);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(fs.existsSync(f.phaseDir), false);
});

test("runner: completing authentication releases only the prompt and permits the next phase", (t) => {
  const f = fixture(t), originalResources = [...f.task.workflow.resources], before = Date.now();
  const auth = f.cli(["auth-done", "generated-ssh", "2"]);
  assert.equal(auth.status, 0, auth.stderr);
  assert.deepEqual(f.store.attempt(f.attempt.id).resources, ["external-worker"]);
  assert.deepEqual(f.task.workflow.resources, originalResources, "the step still requires authentication for any future attempt");
  assert.deepEqual(f.store.claims().map((c) => c.resource), ["external-worker"]);
  assert.equal(f.store.admitted("generated-ssh"), true);
  const admission = JSON.parse(fs.readFileSync(path.join(f.store.dir, "admission", "generated-ssh.json"), "utf8"));
  assert.ok(admission.expires >= before + 120_000 && admission.expires <= Date.now() + 120_000);
  const run = f.cli(f.phase);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(f.marker, "utf8"), "generated phase");
  assert.equal(f.store.attempt(f.attempt.id).phase, "Inspecting");
  assert.equal(fs.existsSync(path.join(f.store.dir, "attempts", `${f.attempt.id}.active-phase.json`)), false);
  assert.equal(f.store.receipt(f.attempt.id), undefined, "a successful phase is not acceptance");
});

test("runner: a second auth-done cannot renew the admission after releasing its claim", (t) => {
  const f = fixture(t);
  assert.equal(f.cli(["auth-done", "generated-ssh", "2"]).status, 0);
  const file = path.join(f.store.dir, "admission", "generated-ssh.json"), admission = fs.readFileSync(file, "utf8");
  const again = f.cli(["auth-done", "generated-ssh", "20"]);
  assert.equal(again.status, 3);
  assert.match(again.stderr, /authentication prompt is not held/);
  assert.equal(fs.readFileSync(file, "utf8"), admission);
});

test("runner: releasing authentication never waives the payload claim", (t) => {
  const f = fixture(t);
  assert.equal(f.cli(["auth-done", "generated-ssh", "2"]).status, 0);
  f.store.release(f.attempt.id, "external-worker");
  const run = f.cli(f.phase);
  assert.equal(run.status, 3);
  assert.match(run.stderr, /no longer holds external-worker/);
  assert.equal(fs.existsSync(f.marker), false);
});

test("runner: nested linked worktrees resolve the same canonical workflow store as Board", (t) => {
  const f = fixture(t), nested = path.join(f.repo, ".entomatical", "wt", "nested");
  f.git("worktree", "add", "-b", "nested", nested);
  const auth = f.cli(["auth-done", "generated-ssh", "2"], nested);
  assert.equal(auth.status, 0, auth.stderr);
  assert.deepEqual(f.store.attempt(f.attempt.id).resources, ["external-worker"]);
  const run = f.cli(f.phase, nested);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(f.marker, "utf8"), "generated phase");
  assert.equal(fs.existsSync(path.join(nested, ".entomatical", "workflow")), false);
});

test("runner: admission requires an explicit finite positive lifetime before changing claims or attempt", (t) => {
  const f = fixture(t), original = f.store.attempt(f.attempt.id);
  for (const verb of ["auth-done", "admit"]) {
    for (const ttl of [undefined, "NaN", "Infinity", "0", "-1", "1e309", "1e305", "1e-100"]) {
      const result = f.cli([verb, "generated-ssh", ...(ttl === undefined ? [] : [ttl])]);
      assert.equal(result.status, 3, `${verb} ${ttl}: ${result.stderr}`);
      assert.deepEqual(f.store.attempt(f.attempt.id), original);
      assert.equal(f.store.claims().length, 2);
      assert.equal(f.store.admitted("generated-ssh"), false);
      assert.equal(fs.existsSync(path.join(f.store.dir, "admission", "generated-ssh.json")), false, "invalid input writes no admission record");
    }
  }
  const result = f.cli(["admit", "generated-mount", "0.5"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.store.admitted("generated-mount"), true);
  assert.deepEqual(f.store.attempt(f.attempt.id), original, "ordinary admission never completes authentication");
  assert.equal(f.store.claims().length, 2);
});

for (const stopped of [{ state: "ended" }, { outcome: "failed" }, { outcome: "unknown" }]) {
  test(`runner: ${JSON.stringify(stopped)} refuses phases and authentication completion`, (t) => {
    const f = fixture(t);
    f.store.saveAttempt({ ...f.store.attempt(f.attempt.id), ...stopped });
    for (const args of [f.phase, ["auth-done", "generated-ssh", "2"]]) {
      const result = f.cli(args);
      assert.equal(result.status, 3, result.stderr);
      assert.match(result.stderr, /no retry/);
    }
    assert.equal(fs.existsSync(f.marker), false);
    assert.equal(f.store.admitted("generated-ssh"), false);
  });
}

test("runner: absent, invalid or overflowing phase bounds refuse execution and create no intent", (t) => {
  const f = fixture(t), command = f.phase.slice(7);
  const invalid = [
    ["run", "Inspecting", "--", ...command],
    ...["0", "-1", "1.5", "NaN", "Infinity", "2147483648"].flatMap((bad) => [
      ["run", "Inspecting", "--timeout-ms", bad, "--kill-after-ms", "100", "--", ...command],
      ["run", "Inspecting", "--timeout-ms", "2000", "--kill-after-ms", bad, "--", ...command],
    ]),
  ];
  for (const args of invalid) {
    const result = f.cli(args);
    assert.equal(result.status, 3, result.stderr);
    assert.equal(fs.existsSync(f.marker), false);
    assert.equal(fs.existsSync(f.phaseDir), false);
    assert.equal(f.store.claims().length, 2);
  }
});

test("runner: a completed phase cannot repeat, a different phase can follow, and argv is hash-only", (t) => {
  const f = fixture(t), secretMarker = "generated-sensitive-argument";
  const command = ["run", "Inspecting", ...f.bounds, process.execPath, "-e", "require('node:fs').appendFileSync(process.argv[1], 'x')", f.marker, secretMarker];
  assert.equal(f.cli(command).status, 0);
  const again = f.cli(command);
  assert.equal(again.status, 3);
  assert.match(again.stderr, /already has an intent/);
  assert.equal(fs.readFileSync(f.marker, "utf8"), "x");
  assert.equal(f.cli(["run", "Verifying", ...f.bounds, process.execPath, "-e", "process.exit(0)"]).status, 0);
  const records = fs.readdirSync(f.phaseDir).map((file) => fs.readFileSync(path.join(f.phaseDir, file), "utf8")).join("\n");
  const log = fs.readFileSync(path.join(f.store.dir, "attempts", `${f.attempt.id}.phases.jsonl`), "utf8");
  assert.equal((records + log).includes(secretMarker), false);
  const results = log.trim().split("\n").map(JSON.parse);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.outcome === "success" && /^[a-f0-9]{64}$/.test(r.commandHash) && !Object.hasOwn(r, "command")));
  assert.equal(f.store.claims().length, 2);
});

test("runner: an active phase excludes both duplicate and different concurrent phases", async (t) => {
  const f = fixture(t);
  // The first phase holds until the test writes <marker>.go, so a slow machine cannot end it before the two refused runs.
  const hold = "const fs = require('node:fs'); fs.writeFileSync(process.argv[1], 'ready'); const t = setInterval(() => { if (fs.existsSync(process.argv[1] + '.go')) clearInterval(t); }, 20)";
  const first = f.start(["run", "Inspecting", "--timeout-ms", "30000", "--kill-after-ms", "100", "--", process.execPath, "-e", hold, f.marker]);
  await waitFor(() => fs.existsSync(f.marker), "generated phase startup");
  assert.equal(fs.readdirSync(f.phaseDir).filter((name) => name.endsWith(".intent.json")).length, 1, "durable intent exists before the command's side effect");
  for (const phase of ["Inspecting", "Uploading"]) {
    const second = f.cli(["run", phase, ...f.bounds, process.execPath, "-e", "throw new Error('must not run')"]);
    assert.equal(second.status, 3);
    assert.match(second.stderr, /active or unreconciled phase/);
  }
  fs.writeFileSync(f.marker + ".go", "");
  const result = await first.done;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.store.claims().length, 2);
});

test("runner: a prior durable intent without a result blocks execution and records unknown", (t) => {
  const f = fixture(t), crypto = require("node:crypto");
  fs.mkdirSync(f.phaseDir);
  const phaseId = crypto.createHash("sha256").update("Inspecting").digest("hex");
  fs.writeFileSync(path.join(f.phaseDir, `${phaseId}.intent.json`), JSON.stringify({ phase: "Inspecting", runnerPid: 1 }));
  const result = f.cli(f.phase);
  assert.equal(result.status, 3);
  assert.equal(fs.existsSync(f.marker), false);
  assert.equal(f.store.attempt(f.attempt.id).outcome, "unknown");
  assert.equal(f.store.claims().length, 2);
});

for (const failure of ["nonzero", "spawn"]) {
  test(`runner: ${failure} failure ends the attempt without releasing workflow claims`, (t) => {
    const f = fixture(t);
    const command = failure === "nonzero" ? [process.execPath, "-e", "process.exit(7)"] : [path.join(f.dir, "no-generated-executable")];
    const result = f.cli(["run", "Inspecting", ...f.bounds, ...command]);
    assert.equal(result.status, failure === "nonzero" ? 7 : 1, result.stderr);
    assert.equal(f.store.attempt(f.attempt.id).outcome, "failed");
    assert.equal(f.store.claims().length, 2);
    assert.equal(f.cli(f.phase).status, 3, "a failed command is not automatically retried");
  });
}

test("runner: deadline escalates TERM to KILL for a generated POSIX process group and records unknown", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t), pids = path.join(f.dir, "generated-pids.json");
  const code = `const fs = require('node:fs'), { spawn } = require('node:child_process');
    const leaf = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    process.on('SIGTERM', () => {}); fs.writeFileSync(process.argv[1], JSON.stringify([process.pid, leaf.pid])); setInterval(() => {}, 1000);`;
  const before = Date.now();
  const result = f.cli(["run", "Inspecting", "--timeout-ms", "800", "--kill-after-ms", "150", "--", process.execPath, "-e", code, pids]);
  assert.equal(result.status, 124, result.stderr);
  assert.ok(Date.now() - before < 4000, "controller remains bounded");
  const children = JSON.parse(fs.readFileSync(pids, "utf8"));
  const running = (pid) => {
    try {
      process.kill(pid, 0);
      // A killed orphan may await the container's init reaper; a zombie is not a running process.
      return process.platform !== "linux" || !/^Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]);
    } catch { return false; }
  };
  await waitFor(() => children.every((pid) => !running(pid)), "generated process group cleanup");
  assert.equal(f.store.attempt(f.attempt.id).outcome, "unknown");
  assert.equal(f.store.claims().length, 2);
  assert.equal(f.cli(f.phase).status, 3);
  const resultRecord = JSON.parse(fs.readFileSync(path.join(f.phaseDir, fs.readdirSync(f.phaseDir).find((file) => file.endsWith(".result.json"))), "utf8"));
  assert.match(resultRecord.reason, /deadline.*remote state unproved/);
});

test("runner: interruption ends a generated phase as unknown and retains its claims", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  const active = f.start(["run", "Inspecting", ...f.bounds, process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)", f.marker]);
  await waitFor(() => fs.existsSync(f.marker), "generated phase startup");
  active.child.kill("SIGTERM");
  const result = await active.done;
  assert.equal(result.status, 124, result.stderr);
  assert.match(f.store.attempt(f.attempt.id).reason, /interrupted/);
  assert.equal(f.store.attempt(f.attempt.id).outcome, "unknown");
  assert.equal(f.store.claims().length, 2);
});

test("runner: an externally signalled command remains unknown rather than an ordinary failed exit", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const result = f.cli(["run", "Inspecting", ...f.bounds, process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"]);
  assert.equal(result.status, 124, result.stderr);
  assert.equal(f.store.attempt(f.attempt.id).outcome, "unknown");
  assert.equal(f.store.claims().length, 2);
});

test("runner: a scoped phase requires the original approval expiry and unchanged scope snapshot", (t) => {
  const scope = { operations: ["generated command"], sources: ["generated"], destinations: ["temporary fixture"], toolVersion: "fixture-v1", bounds: "generated child only", expires: new Date(Date.now() + 60_000).toISOString() };
  const allowed = fixture(t, scope);
  assert.equal(allowed.cli(allowed.phase).status, 0);
  for (const change of ["extended", "removed", "invalid", "expired", "scope-content", "approval-content", "approval-missing-scope", "approval-corrupt-scope"]) {
    const f = fixture(t, structuredClone(scope)), a = f.store.attempt(f.attempt.id);
    if (change === "extended") a.scope.expires = new Date(Date.now() + 120_000).toISOString();
    if (change === "removed") delete a.scope.expires;
    if (change === "scope-content") a.scope.bounds = "changed since dispatch";
    if (change === "invalid" || change === "expired") {
      a.scope.expires = change === "invalid" ? "invalid-generated-date" : new Date(Date.now() - 1).toISOString();
      const file = path.join(f.store.dir, "approvals", `${a.scopeHash}.json`), ap = JSON.parse(fs.readFileSync(file, "utf8"));
      ap.scope.expires = a.scope.expires;
      fs.writeFileSync(file, JSON.stringify(ap));
    }
    if (change.startsWith("approval-")) {
      const file = path.join(f.store.dir, "approvals", `${a.scopeHash}.json`), ap = JSON.parse(fs.readFileSync(file, "utf8"));
      if (change === "approval-content") ap.scope.bounds = "changed approval contents with original scopeHash field";
      if (change === "approval-missing-scope") delete ap.scope;
      if (change === "approval-corrupt-scope") ap.scope = "invalid-generated-scope";
      fs.writeFileSync(file, JSON.stringify(ap));
    }
    f.store.saveAttempt(a);
    const result = f.cli(f.phase);
    assert.equal(result.status, 3, `${change}: ${result.stderr}`);
    assert.match(result.stderr, /scope|expiry|expired/);
    assert.equal(fs.existsSync(f.marker), false);
    assert.equal(fs.existsSync(f.phaseDir), false, "the command is rejected before its intent or execution");
    assert.equal(f.store.claims().length, 2);
  }
});

test("runner: phase admissions must still be current, while admit/auth-done may establish them", (t) => {
  for (const state of ["missing", "expired", "fresh"]) {
    const f = fixture(t), a = f.store.attempt(f.attempt.id);
    a.admission = ["generated-ssh"];
    f.store.saveAttempt(a);
    if (state === "expired") f.store.admit("generated-ssh", -1);
    if (state === "fresh") assert.equal(f.cli(["auth-done", "generated-ssh", "2"]).status, 0, "authentication completion is allowed to establish missing admission");
    const result = f.cli(f.phase);
    assert.equal(result.status, state === "fresh" ? 0 : 3, result.stderr);
    assert.equal(fs.existsSync(f.marker), state === "fresh");
    assert.equal(fs.existsSync(f.phaseDir), state === "fresh", "stale admission refuses before intent");
    assert.equal(f.store.claims().length, state === "fresh" ? 1 : 2);
    if (state !== "fresh") {
      assert.equal(f.cli(["admit", "generated-ssh", "2"]).status, 0, "explicit admission remains available to prepare access");
      assert.equal(f.store.admitted("generated-ssh"), true);
    }
  }
});

test("runner: new phase files are private without changing existing artifact directories", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t), attempts = path.join(f.store.dir, "attempts"), original = fs.statSync(attempts).mode & 0o777;
  assert.equal(f.cli(f.phase).status, 0);
  assert.equal(fs.statSync(attempts).mode & 0o777, original);
  assert.equal(fs.statSync(f.phaseDir).mode & 0o777, 0o700);
  for (const file of fs.readdirSync(f.phaseDir)) assert.equal(fs.statSync(path.join(f.phaseDir, file)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(attempts, `${f.attempt.id}.phases.jsonl`)).mode & 0o777, 0o600);
});

for (const outcome of ["failed", "unknown"]) {
  test(`runner: concurrent auth-done/admit cannot overwrite a phase's ${outcome} state`, async (t) => {
    const f = fixture(t);
    const code = `require('node:fs').writeFileSync(process.argv[1], 'ready'); ${outcome === "failed" ? "setTimeout(() => process.exit(7), 500)" : "setInterval(() => {}, 1000)"}`;
    const phase = f.start(["run", "Inspecting", "--timeout-ms", outcome === "failed" ? "2000" : "800", "--kill-after-ms", "100", "--", process.execPath, "-e", code, f.marker]);
    await waitFor(() => fs.existsSync(f.marker), "generated phase startup");
    for (const verb of ["auth-done", "admit"]) {
      const result = f.cli([verb, "generated-ssh", "2"]);
      assert.equal(result.status, 3, result.stderr);
      assert.match(result.stderr, /active or unreconciled/);
    }
    assert.equal((await phase.done).status, outcome === "failed" ? 7 : 124);
    const terminal = f.store.attempt(f.attempt.id);
    assert.equal(terminal.outcome, outcome);
    for (const verb of ["auth-done", "admit"]) assert.equal(f.cli([verb, "generated-ssh", "2"]).status, 3);
    assert.deepEqual(f.store.attempt(f.attempt.id), terminal, "metadata cannot restore the startup snapshot over the terminal outcome");
    assert.deepEqual(f.store.claims().map((c) => c.resource).sort(), ["auth-prompt", "external-worker"]);
    assert.equal(fs.existsSync(path.join(f.store.dir, "admission", "generated-ssh.json")), false);
  });
}

test("runner: two concurrent auth completions cannot both succeed", async (t) => {
  const f = fixture(t);
  const first = f.start(["auth-done", "generated-ssh", "2"]), second = f.start(["auth-done", "generated-ssh", "20"]);
  const results = await Promise.all([first.done, second.done]);
  assert.deepEqual(results.map((r) => r.status).sort(), [0, 3]);
  assert.deepEqual(f.store.attempt(f.attempt.id).resources, ["external-worker"]);
  assert.deepEqual(f.store.claims().map((c) => c.resource), ["external-worker"]);
  assert.equal(f.store.admitted("generated-ssh"), true);
});
