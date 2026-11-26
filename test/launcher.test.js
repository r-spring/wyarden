// wrapper/launcher.cs (wrapper/entomatical-claude.exe): on Windows it starts entomatical-claude.js beside it with node.
// What the launcher alone must get right: arguments arrive intact, the exit code comes back, and ending it ends claude.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");

const launcher = path.join(__dirname, "..", "wrapper", "entomatical-claude.exe");
const skip = process.platform !== "win32" ? "the launcher is Windows only" : !fs.existsSync(launcher) ? "launcher not built: run npm run build:wrapper" : false;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ab-launcher-"));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("launcher passes every argument through intact and returns claude's exit code", { skip }, () => {
  const tricky = ["has space", 'a "quoted" word', "trailing\\", "C:\\Dev Stuff\\x\\", "", "multi\nline"];
  const script = "console.log(JSON.stringify(process.argv.slice(1))); process.exit(3)";
  const r = spawnSync(launcher, [process.execPath, "-e", script, ...tricky], { input: "", encoding: "utf8" });
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), tricky);
});

test("launcher says so when node is not on PATH", { skip }, () => {
  const r = spawnSync(launcher, [process.execPath, "-e", ""], { input: "", encoding: "utf8", env: { ...process.env, PATH: path.join(process.env.SystemRoot || "C:\\Windows", "System32") } });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /node\.exe is not on PATH/);
});

test("ending the launcher ends node and claude with it (kill-on-close job)", { skip, timeout: 90_000 }, async () => {
  const dir = tmp();
  const pidFile = path.join(dir, "claude.pid");
  const script = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
  const child = spawn(launcher, [process.execPath, "-e", script], { stdio: "pipe" });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  let pid;
  try {
    // Up to 30 s for a whole pid: under full-suite load node starts slowly, and the file can exist before its number is written.
    const until = Date.now() + 30_000;
    const readPid = () => { try { return Number(fs.readFileSync(pidFile, "utf8")) || undefined; } catch { return undefined; } };
    while (!(pid = readPid()) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    assert.ok(pid && alive(pid), `claude is running under the launcher (pid ${pid})${stderr ? `; launcher stderr: ${stderr}` : ""}`);
    assert.doesNotMatch(stderr, /could not set up the job object/);
    child.kill(); // TerminateProcess, as when the extension ends a panel's process
    // Up to 30 s: 10 s ran out under the board's full-suite load (12 November 2026); a working job ends it at once.
    const gone = Date.now() + 30_000;
    while (alive(pid) && Date.now() < gone) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(pid), false, `claude ended with the launcher${stderr ? `; launcher stderr: ${stderr}` : ""}`);
  } finally {
    child.kill();
    if (pid && alive(pid)) try { process.kill(pid); } catch { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("the board's first prompt reaches claude through the launcher, multi-line, after the first line", { skip }, () => {
  const repo = tmp();
  const launch = path.join(repo, ".entomatical", "launch");
  fs.mkdirSync(launch, { recursive: true });
  const prompt = path.join(launch, "p.prompt.txt");
  fs.writeFileSync(prompt, 'Line "one"\nline two', "utf8");
  fs.writeFileSync(path.join(launch, "pending.txt"), [repo, "", "", prompt, ""].join("\r\n"));
  const echo = "process.stdin.pipe(process.stdout)";
  const out = execFileSync(launcher, [process.execPath, "-e", echo, "--", "--input-format", "stream-json"],
    { cwd: repo, input: '{"type":"control_request"}\n{"type":"second"}\n', encoding: "utf8" });
  const [initialize, injected, second] = out.trim().split(/\r?\n/);
  assert.equal(initialize, '{"type":"control_request"}');
  assert.deepEqual(JSON.parse(injected), { type: "user", message: { role: "user", content: 'Line "one"\nline two' } });
  assert.equal(second, '{"type":"second"}');
  fs.rmSync(repo, { recursive: true, force: true });
});
