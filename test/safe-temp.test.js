const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const guard = path.join(__dirname, "safe-temp.js");
const boardTests = path.join(__dirname, "board-tool.test.js");

function run(temp, args) {
  const env = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp };
  delete env.NODE_TEST_CONTEXT; // this child runs its own test runner
  return spawnSync(process.execPath, args, {
    env, encoding: "utf8", timeout: 10_000,
  });
}

test("direct board tool tests refuse a temporary directory beneath a board", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ab-temp-guard-"));
  try {
    const repo = path.join(base, "repo"), temp = path.join(repo, "temp");
    fs.mkdirSync(path.join(repo, ".entomatical"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".entomatical", "tasks.json"), "[]");
    fs.mkdirSync(temp);
    const result = run(temp, ["--test", "--test-name-pattern=--help lists", boardTests]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /Unsafe temporary directory/);
    assert.equal(fs.existsSync(path.join(repo, ".entomatical", "inbox")), false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("the test preflight accepts a plain temporary directory and one under a home folder, and rejects repository and board parents", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ab-temp-guard-"));
  try {
    const safe = path.join(base, "safe"), repo = path.join(base, "repo"), nested = path.join(repo, "temp");
    fs.mkdirSync(safe);
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(nested);
    const allowed = run(safe, [guard]);
    assert.equal(allowed.status, 0, allowed.stderr);
    const refused = run(nested, [guard]);
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /Unsafe temporary directory/);
    // A home folder: its .entomatical holds the files the extension places and no tasks.json, so it is not a board.
    const home = path.join(base, "home"), homeTemp = path.join(home, "AppData", "Local", "Temp");
    fs.mkdirSync(path.join(home, ".entomatical", "hook"), { recursive: true });
    fs.mkdirSync(homeTemp, { recursive: true });
    const underHome = run(homeTemp, [guard]);
    assert.equal(underHome.status, 0, underHome.stderr);
    fs.writeFileSync(path.join(home, ".entomatical", "tasks.json"), "[]");
    const underBoard = run(homeTemp, [guard]);
    assert.equal(underBoard.status, 1, underBoard.stderr);
    assert.match(underBoard.stderr, /Unsafe temporary directory/);
    if (process.platform !== "win32") {
      const alias = path.join(base, "linked-temp");
      fs.symlinkSync(nested, alias, "dir");
      const linked = run(alias, [guard]);
      assert.equal(linked.status, 1, linked.stderr);
      assert.match(linked.stderr, /Unsafe temporary directory/);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
