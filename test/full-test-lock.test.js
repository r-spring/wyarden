const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { acquire } = require("./full-test-lock");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a crashed owner is recoverable with its exited PID or a now-live PID", t => {
  const file = path.join(fixture(t), "full-test.lock");
  for (const reused of [false, true]) {
    const child = spawnSync(process.execPath, ["-e", "require(process.argv[1]).acquire(process.argv[2]); process.exit(7)",
      require.resolve("./full-test-lock"), file], { timeout: 10000 });
    assert.equal(child.status, 7, child.stderr.toString());
    const previous = JSON.parse(fs.readFileSync(file));
    assert.equal(previous.pid, child.pid);
    if (reused) fs.writeFileSync(file, JSON.stringify({ ...previous, pid: process.pid }));
    // A regression that waits instead of reclaiming fails immediately.
    const release = acquire(file, { log: assert.fail });
    assert.equal(JSON.parse(fs.readFileSync(file)).pid, process.pid);
    release();
    assert.ok(!fs.existsSync(file));
  }
});

test("a live legacy owner survives age and an old release preserves a replacement", t => {
  const file = path.join(fixture(t), "full-test.lock");
  const old = JSON.stringify({ pid: process.pid, at: Date.now(), cwd: __dirname });
  t.mock.method(Date, "now", () => JSON.parse(old).at + 7200000);
  for (const existing of ["{", old]) {
    fs.writeFileSync(file, existing);
    assert.throws(() => acquire(file, { log() { throw Error("still waiting"); } }), /still waiting/);
    assert.equal(fs.readFileSync(file, "utf8"), existing);
  }
  const exited = spawnSync(process.execPath, ["-e", ""], { timeout: 10000 });
  assert.equal(exited.status, 0);
  fs.writeFileSync(file, JSON.stringify({ pid: exited.pid, at: Date.now(), cwd: __dirname }));
  const release = acquire(file, { log: assert.fail });
  fs.writeFileSync(file, old);
  release();
  assert.equal(fs.readFileSync(file, "utf8"), old);
  release();
  assert.equal(fs.readFileSync(file, "utf8"), old);
});

test("a legacy PID born after acquisition is recoverable", { skip: !["linux", "win32"].includes(process.platform) }, t => {
  const file = path.join(fixture(t), "full-test.lock");
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() - 14400000, cwd: __dirname }));
  const release = acquire(file, { log: assert.fail });
  assert.ok(JSON.parse(fs.readFileSync(file)).sqliteOwner);
  release();
});

test("recovery and release can write only the opened generation", t => {
  const file = path.join(fixture(t), "full-test.lock");
  const replacement = JSON.stringify({ pid: process.pid, at: Date.now(), cwd: __dirname });
  for (const phase of ["recover", "release"]) {
    fs.writeFileSync(file, '{"released":true}');
    const release = phase === "release" && acquire(file);
    let replaced = false;
    const method = release ? "renameSync" : "writeSync";
    const original = fs[method];
    const hook = t.mock.method(fs, method, function(...args) {
      if (!replaced) {
        replaced = true;
        fs.unlinkSync(file);
        fs.writeFileSync(file, replacement, { flag: "wx" });
      }
      return original.apply(this, args);
    });
    try {
      if (release) release();
      else assert.throws(() => acquire(file, { log() { throw Error("held"); } }), /held/);
      assert.ok(replaced);
      assert.equal(fs.readFileSync(file, "utf8"), replacement);
      assert.ok(!fs.existsSync(file + ".retiring"));
    } finally { hook.mock.restore(); }
  }
});

async function until(check, message) {
  const deadline = Date.now() + 30000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await delay(20);
  }
}

test("an interrupted retirement preserves a displaced live owner across another claimant", t => {
  const file = path.join(fixture(t), "full-test.lock");
  const retired = file + ".retiring";
  const previous = JSON.stringify({ pid: process.pid, at: Date.now(), cwd: "displaced" });
  const current = JSON.stringify({ pid: process.pid, at: Date.now(), cwd: "current" });
  fs.writeFileSync(retired, previous);
  fs.writeFileSync(file, current);
  const mustWait = () => assert.throws(() => acquire(file, { log() { throw Error("held"); } }), /held/);
  mustWait();
  assert.equal(fs.readFileSync(file, "utf8"), current);
  assert.equal(fs.readFileSync(retired, "utf8"), previous);
  fs.unlinkSync(file);
  mustWait();
  assert.equal(fs.readFileSync(file, "utf8"), previous);
  assert.ok(!fs.existsSync(retired));
});

test("ordinary runner serializes full file selections while focused tests pass an initializing owner", async t => {
  const dir = fixture(t);
  const file = path.join(dir, "full-test.lock");
  const tests = path.join(dir, "test");
  fs.mkdirSync(tests);
  fs.mkdirSync(path.join(dir, "out"));
  fs.copyFileSync(require.resolve("../out/workspace"), path.join(dir, "out", "workspace.js"));
  for (const name of ["run.js", "full-test-lock.js", "shares.js", "rm-retry.js", "safe-temp.js"]) {
    fs.copyFileSync(path.join(__dirname, name), path.join(tests, name));
  }
  fs.writeFileSync(path.join(dir, "ENTOMATICAL-TEMP-ROOT"), "");
  fs.writeFileSync(path.join(tests, "helper.js"), "throw Error('discovered a helper')");
  const files = ["a", "b", "c", "d", "e"].map(name => "test/" + name + ".test.js");
  for (const name of files) fs.writeFileSync(path.join(dir, name),
    `require("node:test")(${JSON.stringify(name)}, () => {
      const fs = require("node:fs");
      if (process.env.EXPECT_OWNER) {
        const record = JSON.parse(fs.readFileSync("full-test.lock"));
        require("node:assert/strict").equal(record.pid, process.ppid);
        fs.writeFileSync(process.env.EXPECT_OWNER, String(record.acquiredAt));
      }
    });`);

  // Stop the first coordinator inside its metadata write, with the OS lock already held.
  fs.writeFileSync(path.join(dir, "barrier.cjs"), `
    const fs = require("node:fs");
    const write = fs.writeFileSync;
    const deadline = Date.now() + 30000;
    const wait = Atomics.wait;
    Atomics.wait = (...args) => {
      if (Date.now() > deadline) throw Error("test process timed out at its lock");
      return wait(...args);
    };
    fs.writeFileSync = function(file, ...args) {
      if (process.env.PAUSE_WRITER && String(file).endsWith("full-test.lock.next")) {
        write(file, "{");
        write("initializing", "");
        while (!fs.existsSync("resume")) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
      return write(file, ...args);
    };`);
  function run(args, extra = {}) {
    const env = { ...process.env, TMP: dir, TEMP: dir, TMPDIR: dir, NODE_OPTIONS: "--require=./barrier.cjs", ...extra };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["test/run.js", ...args],
      { cwd: dir, env, windowsHide: true, timeout: 65000, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", b => { output += b; });
    child.stderr.on("data", b => { output += b; });
    const done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve({ code, output }));
    });
    return { done, waiting: () => output.includes("Waiting for the full test run") };
  }
  async function passed(run, count) {
    const { code, output } = await run.done;
    assert.equal(code, 0, output);
    assert.match(output, new RegExp("(?:#|ℹ) pass " + count + "\\b"));
  }
  const owner = run(["test/*.test.js"], { PAUSE_WRITER: "1", EXPECT_OWNER: "first" });
  const waiters = [];
  try {
    await until(() => fs.existsSync(path.join(dir, "initializing")), "literal glob did not reach the writer barrier");
    for (const args of [["--test-reporter", "tap", "test/*.test.js"], ["--test-concurrency=1", ...files.toReversed()], []]) {
      const runId = "waiter-" + waiters.length;
      waiters.push(run(args, { EXPECT_OWNER: runId }));
    }
    await until(() => waiters.every(w => w.waiting()), "each full selection should report waiting");
    await passed(run(["--test-name-pattern", "test/a", files[0]]), 1);
    await passed(run(["--test-concurrency", "1", "test/[a-d].test.js"]), 4);
    assert.ok(!fs.existsSync(file), "the holder is still initializing");
    assert.equal(fs.readFileSync(file + ".next", "utf8"), "{");
    const resumed = Date.now();
    fs.writeFileSync(path.join(dir, "resume"), "");
    await passed(owner, files.length);
    for (const [i, waiter] of waiters.entries()) {
      await passed(waiter, files.length);
      const at = Number(fs.readFileSync(path.join(dir, "waiter-" + i)));
      assert.ok(at >= resumed && at <= Date.now(), "timestamp outside admission interval");
    }
    assert.ok(!fs.existsSync(file));
  } finally {
    fs.writeFileSync(path.join(dir, "resume"), "");
    await Promise.all([owner, ...waiters].map(run => run.done));
  }
});
