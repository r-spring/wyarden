// test/shares.js: a long test file runs as several processes at once, and whichever way it is run, each of its tests runs once.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { share, shareFiles } = require("./shares");

const SEVEN = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"];

/**
 * A folder shaped like this repository: test/run.js with what it loads, test/long.test.js (seven tests, two share files) and
 * test/other.test.js (one test, no shares). Every test appends its name and its process to the file SHARES_RAN names.
 */
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shares-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const tests = path.join(dir, "test");
  fs.mkdirSync(tests);
  fs.mkdirSync(path.join(dir, "out"));
  fs.copyFileSync(require.resolve("../out/workspace"), path.join(dir, "out", "workspace.js"));
  for (const name of ["run.js", "full-test-lock.js", "shares.js", "rm-retry.js", "safe-temp.js"]) fs.copyFileSync(path.join(__dirname, name), path.join(tests, name));
  fs.writeFileSync(path.join(dir, "ENTOMATICAL-TEMP-ROOT"), "");
  const note = `() => require("node:fs").appendFileSync(process.env.SHARES_RAN, name + " " + process.pid + "\\n")`;
  fs.writeFileSync(path.join(tests, "long.test.js"),
    `const test = require("./shares").share(require("node:test"), __filename);\nfor (const name of ${JSON.stringify(SEVEN)}) test(name, ${note});\n`);
  for (const n of [2, 3]) fs.writeFileSync(path.join(tests, `long.share${n}.js`), `require("./shares").load(__filename);\n`);
  fs.writeFileSync(path.join(tests, "other.test.js"), `const name = "other";\nrequire("node:test")(name, ${note});\n`);
  let runs = 0;
  /** Runs node in the folder: through test/run.js, or `node --test` itself. signal: what the run finds in the environment. */
  return function run(args, { direct = false, signal } = {}) {
    const ran = path.join(dir, `ran-${runs++}.txt`);
    const env = { ...process.env, TMP: dir, TEMP: dir, TMPDIR: dir, SHARES_RAN: ran };
    delete env.NODE_TEST_CONTEXT; // or node would take the run for a test file of this one
    delete env.ENTOMATICAL_TEST_SHARES; // this run's own signal
    if (signal !== undefined) env.ENTOMATICAL_TEST_SHARES = typeof signal === "string" ? signal : JSON.stringify({ pid: process.pid, files: [path.join(tests, "long.test.js")], ...signal });
    const child = spawnSync(process.execPath, [...(direct ? ["--test"] : ["test/run.js"]), ...args], { cwd: dir, env, encoding: "utf8", windowsHide: true, timeout: 120_000 });
    const lines = fs.existsSync(ran) ? fs.readFileSync(ran, "utf8").split("\n").filter(Boolean).map((line) => line.split(" ")) : [];
    const output = `${child.stdout}${child.stderr}`;
    assert.equal(child.status, 0, output);
    return { names: lines.map(([name]) => name).sort(), processes: new Set(lines.filter(([name]) => name !== "other").map(([, pid]) => pid)).size, output };
  };
}

test("a file with share files, run through test/run.js: every test runs once, in as many processes as there are shares", (t) => {
  const run = fixture(t);
  const alone = run(["test/long.test.js"]);
  assert.deepEqual(alone.names, SEVEN, "naming the file alone still runs all of its tests");
  assert.equal(alone.processes, 3);
  for (const args of [["test/*.test.js"], []]) {
    const whole = run(args);
    assert.deepEqual(whole.names, [...SEVEN, "other"].sort(), `selection ${JSON.stringify(args)}: ${whole.output}`);
    assert.equal(whole.processes, 3);
  }
  const named = run(["test/long.test.js", "test/long.share2.js", "test/long.share3.js"]);
  assert.deepEqual(named.names, SEVEN, "share files named beside their test file are not run a second time");
});

test("every other way of running the file runs all of its tests in one process", (t) => {
  const run = fixture(t);
  const cases = [
    ["node --test without run.js", undefined],
    ["a signal that names another coordinator", {}],
    ["a signal that is not JSON", "{"],
    ["run.js's question, left unanswered", "ask"],
  ];
  for (const [what, signal] of cases) {
    const all = run(["test/long.test.js"], { direct: true, signal });
    assert.deepEqual(all.names, SEVEN, what);
    assert.equal(all.processes, 1, what);
  }
  const one = run(["test/long.share2.js"], { direct: true });
  assert.deepEqual(one.names, ["t2", "t5"], "a share file named by itself runs its own share");
});

test("share(): the file's own `test` when no shares run, and the share files in the order of their numbers", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shares-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "x.test.js"), real = () => undefined;
  assert.equal(share(real, file), real, "no share files");
  for (const name of ["x.share10.js", "x.share2.js", "y.share2.js", "x.share3.txt"]) fs.writeFileSync(path.join(dir, name), "");
  assert.deepEqual(shareFiles(file).map((f) => path.basename(f)), ["x.share2.js", "x.share10.js"]);
  assert.equal(share(real, file), real, "share files, and no run of them");
});

test("this repository's share files each load a test file that takes its `test` from share()", () => {
  const names = fs.readdirSync(__dirname), found = names.filter((name) => /\.share\d+\.js$/.test(name));
  assert.ok(found.length > 0, "test/finish.test.js has share files");
  for (const name of found) {
    const testFile = path.join(__dirname, name.replace(/\.share\d+\.js$/, ".test.js"));
    assert.ok(fs.existsSync(testFile), `${name}: ${testFile} is there`);
    // Without it every share would run the whole file again.
    assert.match(fs.readFileSync(testFile, "utf8"), /^const test = require\("\.\/shares"\)\.share\(require\("node:test"\), __filename\);$/m, name);
    assert.match(fs.readFileSync(path.join(__dirname, name), "utf8"), /^require\("\.\/shares"\)\.load\(__filename\);$/m, name);
    assert.ok(shareFiles(testFile).includes(path.join(__dirname, name)), name);
  }
});
