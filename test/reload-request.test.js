// F84: `board.js reload-windows` writes a request; each installed window reloads once when it is newer than the window's start.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { wantsReload, watchReloadRequests } = require("../out/reload-request");
const { main } = require("../tools/board.js");

test("a request reloads only windows that started before it", () => {
  const now = Date.now();
  assert.equal(wantsReload(JSON.stringify({ at: now }), now - 1000), true);
  assert.equal(wantsReload(JSON.stringify({ at: now - 5000 }), now - 1000), false, "older than the window: it was already reloaded");
  assert.equal(wantsReload(JSON.stringify({ at: now + 3_600_000 }), now - 1000), false, "far in the future: a broken clock, not a request");
  assert.equal(wantsReload("not json", 0), false);
  assert.equal(wantsReload("{}", 0), false);
});

test("a request written after the window started but before its watcher's first poll still reloads it", async () => {
  // Under the full suite's load on linux (6 November 2026) fs.watchFile's first stat came after board.js wrote the file, so the
  // file never "changed" and the window never reloaded. Writing it before the watcher starts makes that order certain.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ab-reload-"));
  const file = path.join(home, ".entomatical", "reload-request.json");
  let w;
  try {
    let reloads = 0;
    const startedAt = Date.now() - 1000;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), by: "abc123" }));
    w = watchReloadRequests(startedAt, () => reloads++, file, 20);
    for (let i = 0; i < 100 && !reloads; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(reloads, 1);
  } finally { w?.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("board.js reload-windows writes the request, and a watching window reloads once", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ab-reload-"));
  const file = path.join(home, ".entomatical", "reload-request.json");
  let w;
  try {
    let reloads = 0, out = "";
    const startedAt = Date.now() - 1000;
    w = watchReloadRequests(startedAt, () => reloads++, file, 20);
    const code = await main(["reload-windows"], { cwd: home, env: { ENTOMATICAL_TASK: "abc123" }, home, write: (s) => (out += s) });
    assert.equal(code, 0);
    assert.match(out, /reload/);
    const req = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(req.by, "abc123");
    for (let i = 0; i < 100 && !reloads; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(reloads, 1);
    fs.writeFileSync(file, JSON.stringify({ at: Date.now() }));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(reloads, 1, "one reload per window: the reloaded window starts a fresh watcher");
  } finally { w?.dispose(); fs.rmSync(home, { recursive: true, force: true }); } // a failed assert must not leave the poll keeping the file alive
});

test("a request written while the watcher's first stat is still queued reloads the window", () => {
  // Forces the race the full suite hit (6 November 2026): with one libuv thread busy, fs.watchFile's first stat runs after the write,
  // takes the request as its baseline and never sees a change. The watcher must read the file itself.
  const script = `
    const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
    const { watchReloadRequests } = require(${JSON.stringify(path.resolve(__dirname, "../out/reload-request.js"))});
    const file = path.join(process.argv[1], 'reload-request.json');
    let reloads = 0;
    crypto.pbkdf2('x', 'y', 300000, 32, 'sha512', () => {}); // holds the only thread pool thread
    const w = watchReloadRequests(Date.now() - 1000, () => reloads++, file, 20);
    fs.writeFileSync(file, JSON.stringify({ at: Date.now() }));
    setTimeout(() => { w.dispose(); process.stdout.write(String(reloads)); }, 1500);
  `;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-reload-"));
  try {
    const out = require("node:child_process").execFileSync(process.execPath, ["-e", script, dir], { env: { ...process.env, UV_THREADPOOL_SIZE: "1" }, encoding: "utf8" });
    assert.equal(out, "1");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
