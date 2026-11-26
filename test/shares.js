// Shares of a long test file.
//
// `node --test` runs the test files side by side, each in a process of its own, and the tests inside one file one after another.
// test/finish.test.js holds 152 tests that start about 75 git processes each: 922 s as one process on Windows and 199 s as four
// (24 November 2026). So a long file can have share files beside it: <name>.share2.js, <name>.share3.js … for <name>.test.js.
// A share file is one line that loads the test file through load() below, and the test file takes its `test` from share():
// while its shares run, each process registers only every n-th top-level test of the file, its own share of the one list.
//
// Nothing has to name the share files. test/run.js preloads this file into the run's coordinator, after full-test-lock.js has
// settled the selection. For every selected test file that has share files, they are added to the run, and the file is told
// through the environment to keep to the first share. Every other way of running the file runs all of its tests in one process:
// `node --test` without run.js, a signal left by another run (it names its coordinator's pid, and only that coordinator's own
// test processes follow it), and a signal that cannot be read. A share file named by itself runs its own share only.
//
// Two things differ in the report of a file that runs in shares. A failing test gives this file as its `location:`, because node
// takes that from the caller of `test`; its name is the same. And when --test-name-pattern leaves a share without a test, node
// counts that share file as one passed test under its path, as it does for every selected file that has no matching test.
const fs = require("node:fs");
const path = require("node:path");

const SIGNAL = "ENTOMATICAL_TEST_SHARES";
const same = process.platform === "win32" ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;

/** The share files of a test file in the order of their numbers: <name>.share2.js … beside <name>.test.js. */
function shareFiles(testFile) {
  const dir = path.dirname(testFile), stem = path.basename(testFile).replace(/\.test\.js$/i, "");
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.map((name) => /^(.+)\.share(\d+)\.js$/.exec(name)).filter((m) => m && same(m[1], stem))
    .sort((a, b) => a[2] - b[2]).map((m) => path.join(dir, m[0]));
}

/** In a share file's process: the test file it loads, and which share of it (2 for the first share file). */
let loading;

/** A share file's one line: loads its test file, which then registers this share's tests only. */
function load(shareFile) {
  const m = /^(.+)\.share\d+\.js$/.exec(path.basename(shareFile));
  if (!m) throw new Error(`${shareFile} is not a share file: its name is <name>.share<number>.js`);
  const testFile = path.join(path.dirname(shareFile), m[1] + ".test.js");
  const at = shareFiles(testFile).findIndex((file) => same(file, shareFile));
  if (at < 0) throw new Error(`${shareFile} is not among the share files of ${testFile}`);
  loading = { testFile, index: at + 2 };
  require(testFile);
}

/** Which share of testFile this process runs; 0: all of its tests. */
function shareOf(testFile) {
  if (loading && same(loading.testFile, testFile)) return loading.index;
  try {
    const signal = JSON.parse(process.env[SIGNAL] ?? "");
    if (signal.pid === process.ppid && signal.files.some((file) => same(file, testFile))) return 1;
  } catch { /* no run of shares, or a signal that cannot be read: all of the tests */ }
  return 0;
}

/** node:test's `test` for testFile as it is, or one that registers only this process's share of the file's top-level tests. */
function share(test, testFile) {
  const mine = shareOf(testFile), count = shareFiles(testFile).length + 1;
  if (mine < 1 || mine > count || count < 2) return test;
  let n = 0;
  return Object.assign((...args) => (n++ % count === mine - 1 ? test(...args) : undefined), test);
}

// The coordinator of a run started by test/run.js, which asks with "ask". Its test processes load this file too, and find the answer.
if (process.env[SIGNAL] === "ask") {
  const selections = process.argv.slice(1).map((arg) => path.resolve(arg));
  const selected = (file) => selections.some((s) => same(s, file) || path.matchesGlob(file, s));
  const stems = new Set(fs.readdirSync(__dirname).map((name) => /^(.+)\.share\d+\.js$/.exec(name)?.[1]).filter(Boolean));
  const files = [...stems].map((stem) => path.join(__dirname, stem + ".test.js")).filter(selected);
  for (const testFile of files) process.argv.push(...shareFiles(testFile).filter((file) => !selections.some((s) => same(s, file))));
  process.env[SIGNAL] = JSON.stringify({ pid: process.pid, files });
}

module.exports = { share, load, shareFiles };
