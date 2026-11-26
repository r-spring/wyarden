// setPanel in src/extension.ts: claudeProcessWrapper is per VS Code profile, ~/.entomatical/inner-wrapper is one file per machine.
// Runs the compiled module isolated (as extension-create.test.js does) with HOME pointed at a temporary folder.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const win = process.platform === "win32";

/** A machine with one Entomatical install and several profiles; each profile has its own setting and globalState. */
function machine() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-panel-"));
  const dir = path.join(home, ".entomatical");
  fs.mkdirSync(dir);
  const wrapper = path.join(dir, win ? "entomatical-claude.exe" : "entomatical-claude");
  fs.writeFileSync(wrapper, "");
  const inner = path.join(dir, "inner-wrapper");
  const cap = path.join(home, "claude-slice-exec");
  fs.writeFileSync(cap, "");
  let current; // the active profile
  const warnings = [];
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    window: { showWarningMessage: async (message) => void warnings.push(message) },
    workspace: { getConfiguration: section => ({
      get: key => (assert.equal(`${section}.${key}`, "claudeCode.claudeProcessWrapper"), current.setting),
      update: async (key, value, target) => { assert.equal(target, 1); current.setting = value; },
    }) },
  };
  const forbid = () => { throw new Error("This test must not launch a process."); };
  const filename = require.resolve("../out/extension.js");
  const extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = name => {
    if (name === "vscode") return vscode;
    if (name === "child_process") return { execFile: forbid, execFileSync: forbid, spawn: forbid };
    if (name === "./profiles") return require("../out/profiles.js"); // pure: capability profiles (phase 2)
    if (name.startsWith("./")) return {};
    return require(name);
  };
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home; // WRAPPER and INNER are fixed at load
  try {
    extension._compile(fs.readFileSync(filename, "utf8") +
      "\nmodule.exports.setPanelForTest = setPanel; module.exports.useStateForTest = s => { state = s; }; module.exports.placeWrapperForTest = placeWrapper; module.exports.wrapperIsOnForTest = wrapperIsOn; module.exports.placesFilesForTest = placesFiles; module.exports.setDevWrapperForTest = w => { devWrapper = w; }; module.exports.isRetiredForTest = isRetiredWrapper; module.exports.swapWrapperForTest = swapWrapper;\n", filename);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const profiles = {};
  /** Switches to a profile (its own setting and globalState), creating it with `setting` the first time. */
  const use = (name, setting) => {
    if (!profiles[name]) profiles[name] = { setting, memento: new Map() };
    current = profiles[name];
    const memento = current.memento;
    extension.exports.useStateForTest({ get: k => memento.get(k), update: async (k, v) => { memento.set(k, v); } });
    return current;
  };
  const panel = on => extension.exports.setPanelForTest(on);
  const innerText = () => (fs.existsSync(inner) ? fs.readFileSync(inner, "utf8").trim() : "");
  return { home, dir, wrapper, inner, cap, use, panel, innerText, warnings, place: (ext) => extension.exports.placeWrapperForTest(ext), isOn: () => extension.exports.wrapperIsOnForTest(),
    placesFiles: (mode) => extension.exports.placesFilesForTest(mode), setDev: (w) => extension.exports.setDevWrapperForTest(w), isRetired: (w) => extension.exports.isRetiredForTest(w), swap: (...a) => extension.exports.swapWrapperForTest(...a) };
}

/** An extension folder whose wrapper/ holds the .js (and on Windows the launcher .exe) with this text. */
function extensionWith(js) {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-ext-"));
  fs.mkdirSync(path.join(ext, "wrapper"));
  fs.writeFileSync(path.join(ext, "wrapper", "entomatical-claude.js"), js);
  if (win) fs.writeFileSync(path.join(ext, "wrapper", "entomatical-claude.exe"), "EXE");
  return ext;
}

test("placeWrapper puts the wrapper files in ~/.entomatical: the launcher and the .js beside it on Windows, the .js alone elsewhere", () => {
  const m = machine(); // m.wrapper holds an old empty copy
  const ext = extensionWith("JS");
  m.place(ext);
  assert.equal(fs.readFileSync(m.wrapper, "utf8"), win ? "EXE" : "JS");
  if (win) assert.equal(fs.readFileSync(path.join(m.dir, "entomatical-claude.js"), "utf8"), "JS");
  // Windows: a running .exe cannot be overwritten, so the old copy is moved aside. Elsewhere a temp copy is renamed over it, leaving nothing behind.
  if (win) assert.equal(fs.readdirSync(m.dir).filter((f) => f.startsWith("entomatical-claude.old-")).length, 1);
  else assert.deepEqual(fs.readdirSync(m.dir).filter((f) => f.startsWith("entomatical-claude")), ["entomatical-claude"]);
  fs.writeFileSync(path.join(ext, "wrapper", "entomatical-claude.js"), "JS2"); // an update that changes only the .js
  m.place(ext);
  assert.equal(fs.readFileSync(win ? path.join(m.dir, "entomatical-claude.js") : m.wrapper, "utf8"), "JS2");
  assert.equal(fs.readFileSync(m.wrapper, "utf8"), win ? "EXE" : "JS2");
  assert.deepEqual(m.warnings, []);
});

test("placeWrapper on Linux: the copy is executable, an equal copy that lost its execute bit gets it back, a failure is one warning", { skip: win && "Windows has no execute bit and moves the old copy aside" }, (t) => {
  const m = machine();
  const ext = extensionWith("JS");
  m.place(ext);
  assert.equal(fs.statSync(m.wrapper).mode & 0o777, 0o755);
  fs.chmodSync(m.wrapper, 0o644);
  m.place(ext); // same content
  assert.equal(fs.statSync(m.wrapper).mode & 0o777, 0o755);
  if (process.getuid?.() === 0) return t.diagnostic("root can write a read-only folder: failure part skipped");
  fs.writeFileSync(path.join(ext, "wrapper", "entomatical-claude.js"), "JS2");
  fs.chmodSync(m.dir, 0o555); // the new copy cannot be written
  try {
    m.place(ext); // must not throw: activation goes on
  } finally {
    fs.chmodSync(m.dir, 0o755);
  }
  assert.equal(fs.readFileSync(m.wrapper, "utf8"), "JS", "the old copy is still there and whole");
  assert.equal(m.warnings.length, 1);
  assert.match(m.warnings[0], /could not update the panel wrapper .*EACCES/);
});

test("Windows wrapper swap: copy to .new, then swap; a failed copy or final rename leaves the old wrapper in place and no .new (audit 10 November 2026, finding 9)", () => {
  const m = machine();
  const bundled = path.join(m.home, "bundled.exe"), target = path.join(m.dir, "entomatical-claude.exe"), old = path.join(m.dir, "entomatical-claude.old-1.exe");
  fs.writeFileSync(bundled, "NEW");
  fs.writeFileSync(target, "OLD");
  const left = () => fs.readdirSync(m.dir).filter((f) => f.startsWith("entomatical-claude.exe.new") || f.startsWith("entomatical-claude.old-"));
  const boom = () => { throw new Error("EBUSY"); };
  assert.throws(() => m.swap(bundled, target, old, { ...fs, copyFileSync: boom }), /EBUSY/);
  assert.equal(fs.readFileSync(target, "utf8"), "OLD");
  assert.deepEqual(left(), []);
  // the copy works but the .new cannot be renamed into place
  assert.throws(() => m.swap(bundled, target, old, { ...fs, renameSync: (from, to) => (from.endsWith(".new") ? boom() : fs.renameSync(from, to)) }), /EBUSY/);
  assert.equal(fs.readFileSync(target, "utf8"), "OLD", "the old copy is put back");
  assert.deepEqual(left(), []);
  m.swap(bundled, target, old);
  assert.equal(fs.readFileSync(target, "utf8"), "NEW");
  assert.deepEqual(left(), ["entomatical-claude.old-1.exe"]);
  assert.equal(fs.readFileSync(old, "utf8"), "OLD");
});

test("only an installed build replaces the machine-wide files in ~/.entomatical, unless ENTOMATICAL_PLACE_FILES=1", () => {
  const m = machine();
  const saved = process.env.ENTOMATICAL_PLACE_FILES;
  try {
    delete process.env.ENTOMATICAL_PLACE_FILES;
    assert.deepEqual([1, 2, 3].map(m.placesFiles), [true, false, false], "Production yes; Development and Test hosts no");
    process.env.ENTOMATICAL_PLACE_FILES = "1";
    assert.deepEqual([1, 2, 3].map(m.placesFiles), [true, true, true]);
  } finally {
    if (saved === undefined) delete process.env.ENTOMATICAL_PLACE_FILES; else process.env.ENTOMATICAL_PLACE_FILES = saved;
  }
});

test("Use panel in a profile with no wrapper keeps another profile's memory cap in inner-wrapper", async () => {
  const m = machine();
  const linux = m.use("linux", m.cap);
  await m.panel(true);
  assert.equal(linux.setting, m.wrapper);
  assert.equal(m.innerText(), m.cap);
  const other = m.use("default", undefined);
  await m.panel(true);
  assert.equal(other.setting, m.wrapper);
  assert.equal(m.innerText(), m.cap, "an empty setting must not clear the machine-wide inner wrapper");
});

test("inner-wrapper is never set to Entomatical's own wrapper", async () => {
  const m = machine();
  fs.writeFileSync(m.inner, m.cap);
  m.use("odd", path.join(path.dirname(m.wrapper), ".", "..", ".entomatical", path.basename(m.wrapper))); // the same file, spelled differently
  await m.panel(true);
  assert.equal(m.innerText(), m.cap);
});

test("Use terminal puts back what each profile had: the cap where it was set, nothing where none was", async () => {
  const m = machine();
  const linux = m.use("linux", m.cap);
  await m.panel(true);
  const other = m.use("default", undefined);
  await m.panel(true);
  await m.panel(false);
  assert.equal(other.setting, undefined, "a profile that had no wrapper gets none back");
  m.use("linux");
  await m.panel(false);
  assert.equal(linux.setting, m.cap, "the profile's own wrapper (the slice cap) comes back");
  assert.equal(m.innerText(), m.cap);
});

test("Use terminal leaves a wrapper that is not Entomatical's alone", async () => {
  const m = machine();
  const p = m.use("linux", m.cap);
  await m.panel(false);
  assert.equal(p.setting, m.cap);
});

test("An install from before per-profile memory still restores from inner-wrapper", async () => {
  const m = machine();
  fs.writeFileSync(m.inner, m.cap + "\n");
  const p = m.use("linux", m.wrapper); // panel on, no wrapperBefore recorded
  await m.panel(false);
  assert.equal(p.setting, m.cap);
});

// A retired Entomatical build (the speech edition, retired 2 November 2026) may have left its own wrapper, a copy of ours in
// ~/.entomatical-speech, in the setting and in inner-wrapper files. It is replaced, never started.
function retiredBuild(m) {
  const dir = path.join(m.home, ".entomatical-speech");
  fs.mkdirSync(dir);
  const wrapper = path.join(dir, win ? "entomatical-claude.exe" : "entomatical-claude");
  fs.writeFileSync(wrapper, "");
  return { wrapper, setInner: (w) => fs.writeFileSync(path.join(dir, "inner-wrapper"), w) };
}

test("a retired build's wrapper in the setting with a memory cap inside it: Use panel puts ours in and keeps the cap", async () => {
  const m = machine();
  const retired = retiredBuild(m);
  retired.setInner(m.cap);
  const p = m.use("default", retired.wrapper);
  assert.equal(m.isOn(), false);
  await m.panel(true);
  assert.equal(p.setting, m.wrapper);
  assert.equal(m.innerText(), m.cap, "the cap the retired build kept runs inside ours; the retired wrapper is dropped");
  assert.equal(m.isOn(), true);
  await m.panel(false);
  assert.equal(p.setting, m.cap);
});

test("a retired build's wrapper in the setting with ours inside it: Use panel puts ours in and records no inner wrapper", async () => {
  const m = machine();
  const retired = retiredBuild(m);
  retired.setInner(m.wrapper);
  const p = m.use("default", retired.wrapper);
  await m.panel(true);
  assert.equal(p.setting, m.wrapper);
  assert.equal(m.innerText(), "", "never our own wrapper, which would start itself forever");
  await m.panel(false);
  assert.equal(p.setting, undefined);
});

test("a dev host's own bundled wrapper set by hand is kept and counts as on; another build's is still replaced (F58, run d60bfd)", async () => {
  const m = machine();
  const ext = extensionWith("JS");
  const dev = path.join(ext, "wrapper", win ? "entomatical-claude.exe" : "entomatical-claude.js");
  m.setDev(dev); // activate does this when it places no files (an Extension Development Host)
  const p = m.use("devhost", dev);
  assert.equal(m.isRetired(dev), false, "before the fix it was taken for a retired build's wrapper");
  assert.equal(m.isOn(), true);
  await m.panel(true);
  assert.equal(p.setting, dev, "Use panel leaves the worktree wrapper in place, not the installed one");
  assert.equal(m.innerText(), "");
  await m.panel(false);
  assert.equal(p.setting, undefined, "Use terminal takes it off, as it does ours");
  const other = extensionWith("OTHER");
  const otherWrapper = path.join(other, "wrapper", win ? "entomatical-claude.exe" : "entomatical-claude.js");
  assert.equal(m.isRetired(otherWrapper), true, "a different build's copy is still retired");
  m.setDev(undefined);
  assert.equal(m.isRetired(dev), true, "an installed build (no dev wrapper) still replaces it");
  if (win) { // VS Code passes the extension path with a lower-case drive letter; the setting typed by hand has C:\ (live dev host, 5 Nov 2026)
    m.setDev(dev[0].toLowerCase() + dev.slice(1));
    const q = m.use("devhost-case", dev[0].toUpperCase() + dev.slice(1).replace(/\\/g, "/"));
    assert.equal(m.isRetired(q.setting), false, "the same file in another case and slash style");
    assert.equal(m.isOn(), true);
    await m.panel(true);
    assert.equal(q.setting, dev[0].toUpperCase() + dev.slice(1).replace(/\\/g, "/"), "left as typed");
    const upper = m.use("own-case", m.wrapper.toUpperCase());
    assert.equal(m.isRetired(upper.setting), false, "our own wrapper in capitals is ours, never a retired build's");
  }
});

test("the wrapper never starts a retired build's wrapper named in inner-wrapper", () => {
  const { execFileSync } = require("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-retired-"));
  const temp = path.join(home, "tmp");
  const repo = path.join(home, "repo");
  const worktree = path.join(repo, ".entomatical", "wt", "t1");
  fs.mkdirSync(temp);
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(path.join(repo, ".entomatical", "launch"));
  fs.writeFileSync(path.join(repo, ".entomatical", "launch", "pending.txt"), `${worktree}\n\n\n`);
  const retiredDir = path.join(home, ".entomatical-speech");
  fs.mkdirSync(retiredDir);
  const retired = path.join(retiredDir, win ? "entomatical-claude.exe" : "entomatical-claude");
  fs.writeFileSync(retired, ""); // not runnable: starting it would fail, and claude would not run
  fs.mkdirSync(path.join(home, ".entomatical"));
  fs.writeFileSync(path.join(home, ".entomatical", "inner-wrapper"), retired);
  const seen = path.join(home, "claude-saw.json");
  const claude = path.join(home, "fake-claude.js");
  fs.writeFileSync(claude, `require("fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ cwd: process.cwd() }));`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, TMPDIR: temp };
  delete env.CLAUDE_CODE_CONFIG_PROBE;
  delete env.ENTOMATICAL_WRAPPED;
  const js = path.join(__dirname, "..", "wrapper", "entomatical-claude.js");
  execFileSync(process.execPath, [js, process.execPath, claude, "--output-format", "stream-json"], { cwd: repo, env, input: "" });
  const saw = JSON.parse(fs.readFileSync(seen, "utf8"));
  assert.equal(fs.realpathSync(saw.cwd), fs.realpathSync(worktree), "claude was started directly, in the worktree");
  assert.match(fs.readFileSync(path.join(temp, "entomatical-wrapper.log"), "utf8"), /inner= args=/);
});

/**
 * Runs the real wrapper over a fake claude in `cwd`, with HOME and the temp folder in `home` (never the live launch folder or log).
 * The panel's first line goes in on stdin; returns what claude saw: its cwd, CLAUDE_CONFIG_DIR, args and stdin lines.
 */
function wrapperRun(home, cwd, nodeArgs = []) {
  const { execFileSync } = require("node:child_process");
  const temp = path.join(home, "tmp");
  fs.mkdirSync(temp, { recursive: true });
  const seen = path.join(home, "claude-saw.json");
  const claude = path.join(home, "fake-claude.js");
  fs.writeFileSync(claude, `let s = ""; process.stdin.on("data", (b) => (s += b)).on("end", () => require("fs").writeFileSync(${JSON.stringify(seen)},
    JSON.stringify({ cwd: process.cwd(), config: process.env.CLAUDE_CONFIG_DIR, args: process.argv.slice(2), lines: s.trim().split("\\n") })));`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, TMPDIR: temp };
  delete env.CLAUDE_CODE_CONFIG_PROBE;
  delete env.ENTOMATICAL_WRAPPED;
  const js = path.join(__dirname, "..", "wrapper", "entomatical-claude.js");
  execFileSync(process.execPath, [...nodeArgs, js, process.execPath, claude, "--output-format", "stream-json", "--input-format", "stream-json"],
    { cwd, env, input: '{"type":"control_request"}\n' });
  return { ...JSON.parse(fs.readFileSync(seen, "utf8")), log: fs.readFileSync(path.join(temp, "entomatical-wrapper.log"), "utf8") };
}

/** A repo whose board has a fresh pending.txt for worktree wt/t1, with a first prompt and a session name. */
function pendingRepo(home, repo = path.join(home, "repo")) {
  const worktree = path.join(repo, ".entomatical", "wt", "t1"), launch = path.join(repo, ".entomatical", "launch");
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(launch, { recursive: true });
  const prompt = path.join(launch, "t1.prompt.txt");
  fs.writeFileSync(prompt, "do t1");
  fs.writeFileSync(path.join(launch, "pending.txt"), [worktree, "", "", prompt, "T1"].join("\r\n"));
  return { repo, worktree, launch, prompt };
}

test("a new chat started inside a task worktree does not take the main repo's pending.txt; a board opened on a worktree still gets its own", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-inside-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { repo, launch } = pendingRepo(home);
  const other = path.join(repo, ".entomatical", "wt", "other");
  fs.mkdirSync(other);
  const saw = wrapperRun(home, other);
  assert.equal(fs.realpathSync(saw.cwd), fs.realpathSync(other));
  assert.deepEqual([saw.lines.length, saw.args.includes("--name")], [1, false], "no prompt and no name from the other card's launch");
  assert.ok(fs.existsSync(path.join(launch, "pending.txt")), "left for the card it belongs to");
  assert.match(saw.log, /is inside .*: no launch file for a new session/);
  // A VS Code window opened on the worktree writes that worktree's own .entomatical/launch: its panel takes it.
  const own = pendingRepo(home, other);
  const ran = wrapperRun(home, other);
  assert.equal(fs.realpathSync(ran.cwd), fs.realpathSync(own.worktree));
  assert.equal(JSON.parse(ran.lines[1]).message.content, "do t1");
  assert.equal(ran.args[ran.args.indexOf("--name") + 1], "T1");
});

test("a claim held up by a locked file is retried, and a delete that fails still sends the first prompt", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-locked-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { repo, worktree, launch } = pendingRepo(home);
  // As Windows antivirus does with a just-written file: the rename fails twice with EBUSY, and every delete in the launch folder fails.
  const patch = path.join(home, "locked.js");
  fs.writeFileSync(patch, `const fs = require("fs"), launch = ${JSON.stringify(launch)}; let busy = 2;
    const rename = fs.renameSync, rm = fs.rmSync;
    fs.renameSync = (a, b) => { if (a.startsWith(launch) && busy-- > 0) throw Object.assign(new Error("busy"), { code: "EBUSY" }); return rename(a, b); };
    fs.rmSync = (p, o) => { if (String(p).startsWith(launch)) throw Object.assign(new Error("locked"), { code: "EPERM" }); return rm(p, o); };`);
  const saw = wrapperRun(home, repo, ["-r", patch]);
  assert.equal(fs.realpathSync(saw.cwd), fs.realpathSync(worktree));
  assert.equal(JSON.parse(saw.lines[1]).message.content, "do t1");
  assert.equal(saw.args[saw.args.indexOf("--name") + 1], "T1");
  assert.match(saw.log, /could not delete .*: EPERM/);
});

// The wrapper's own process handling (F58, review of 4 November 2026). Every run has a scratch home and temp folder, never the
// machine's ~/.entomatical/inner-wrapper or the live wrapper log; the fake claudes are node scripts, so nothing real runs.
const { spawn, spawnSync, execFileSync } = require("node:child_process");
const { execTmpdir } = require("./exec-tmpdir.js");
const js = path.join(__dirname, "..", "wrapper", "entomatical-claude.js");
const linuxOnly = win && "Windows ends claude with the launcher's job, not process groups";

function scratch(t) {
  const home = fs.mkdtempSync(path.join(execTmpdir(), "entomatical-w-")); // the inner wrapper below is a script that must run
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const temp = path.join(home, "tmp");
  fs.mkdirSync(temp);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, TMPDIR: temp, ENTOMATICAL_USAGE_DIR: path.join(home, "usage") };
  for (const k of ["CLAUDE_CODE_CONFIG_PROBE", "ENTOMATICAL_WRAPPED", "CLAUDE_CONFIG_DIR"]) delete env[k];
  const script = (name, code, mode = 0o644) => { const f = path.join(home, name); fs.writeFileSync(f, code, { mode }); return f; };
  const setInner = (file) => { fs.mkdirSync(path.join(home, ".entomatical"), { recursive: true }); fs.writeFileSync(path.join(home, ".entomatical", "inner-wrapper"), file); };
  return { home, temp, env, script, setInner, log: () => fs.readFileSync(path.join(temp, "entomatical-wrapper.log"), "utf8") };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check, ms) {
  for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 25))) if (Date.now() > end) return false;
  return true;
}
const exited = (child) => new Promise((ok) => child.on("exit", (code, signal) => ok({ code, signal })));
const killAll = (pids) => { for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } };

test("the wrapper returns claude's exit code, and an inner wrapper that is missing is logged and skipped", (t) => {
  const s = scratch(t);
  s.setInner(path.join(s.home, "gone.sh"));
  const r = spawnSync(process.execPath, [js, process.execPath, "-e", "process.exit(7)"], { cwd: s.home, env: s.env, input: "" });
  assert.equal(r.status, 7);
  assert.match(s.log(), /inner wrapper .*gone\.sh is missing: claude starts without it/);
});

test("SIGTERM goes to claude's whole group; the wrapper exits 143 when claude ends and kills a tool child that ignored it", { skip: linuxOnly }, async (t) => {
  const s = scratch(t);
  const pids = path.join(s.home, "pids.json");
  const claude = s.script("claude.js", `const tool = require("child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('armed'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
    tool.stdout.once("data", () => { require("fs").writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, tool.pid])); console.log("ready"); });
    setInterval(() => {}, 1000);`);
  const w = spawn(process.execPath, [js, process.execPath, claude], { cwd: s.home, env: s.env, stdio: ["pipe", "pipe", "inherit"] });
  await new Promise((ok) => w.stdout.once("data", ok));
  const [claudePid, toolPid] = JSON.parse(fs.readFileSync(pids, "utf8"));
  t.after(() => killAll([claudePid, toolPid]));
  const sent = performance.now();
  w.kill("SIGTERM");
  assert.deepEqual(await exited(w), { code: 143, signal: null });
  assert.ok(performance.now() - sent < 2500, "it ended when claude did, not at the 3 s backstop");
  assert.ok(await until(() => !alive(claudePid) && !alive(toolPid), 2000), "claude and its tool child are gone");
});

test("when VSCodium stops reading (EPIPE), the wrapper ends claude's group instead of dying alone", { skip: linuxOnly }, async (t) => {
  const s = scratch(t);
  const pidFile = path.join(s.home, "pid");
  const claude = s.script("claude.js", `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.on("error", () => {});
    setInterval(() => process.stdout.write("x".repeat(1000) + "\\n"), 2);`); // keeps writing, ignores its stdin
  const w = spawn(process.execPath, [js, process.execPath, claude], { cwd: s.home, env: s.env, stdio: ["pipe", "pipe", "ignore"] });
  await new Promise((ok) => w.stdout.once("data", ok));
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  t.after(() => killAll([pid]));
  w.stdout.destroy(); // VSCodium went away
  await exited(w);
  assert.ok(await until(() => !alive(pid), 2000), "claude is gone");
  assert.match(s.log(), /stdout closed: EPIPE/);
});

test("everything claude prints reaches a reader that starts 2 s late, before the wrapper exits", { skip: win && "uses /bin/sh" }, (t) => {
  const s = scratch(t);
  const claude = s.script("claude.js", "const b = Buffer.alloc(1 << 20, 120); for (let i = 0; i < 8; i++) process.stdout.write(b);");
  const r = spawnSync("/bin/sh", ["-c", '"$N" "$W" "$N" "$C" < /dev/null | (sleep 2; wc -c)'], { cwd: s.home, env: { ...s.env, N: process.execPath, W: js, C: claude }, encoding: "utf8" });
  assert.equal(Number(r.stdout.trim()), 8 << 20);
});

test("a line longer than 1 MB passes through whole, and the usage line after it is still read", (t) => {
  const s = scratch(t);
  const event = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1792075800 } } } });
  const claude = s.script("claude.js", `const big = "y".repeat(1 << 16); for (let i = 0; i < 64; i++) process.stdout.write(big); process.stdout.write("\\n" + ${JSON.stringify(event)} + "\\n");`);
  const out = execFileSync(process.execPath, [js, process.execPath, claude], { cwd: s.home, env: s.env, input: "", maxBuffer: 1 << 26 });
  assert.equal(out.length, (64 << 16) + 1 + event.length + 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, "usage", "main.json"), "utf8")).fiveHour, 25);
});

test("the inner wrapper gets ENTOMATICAL_WRAPPED as a depth; one level of nesting keeps the inner wrapper, a second runs claude directly", { skip: win && "the inner wrapper here is a shell script" }, (t) => {
  const s = scratch(t);
  const mark = path.join(s.home, "inner-ran");
  s.setInner(s.script("inner.sh", `#!/bin/sh\necho ran >> "${mark}"\nexec "$@"\n`, 0o755));
  const claude = s.script("claude.js", 'console.log(process.env.ENTOMATICAL_WRAPPED || "unset")');
  const run = (extra) => execFileSync(process.execPath, [js, process.execPath, claude], { cwd: s.home, env: { ...s.env, ...extra }, input: "", encoding: "utf8" }).trim();
  assert.equal(run({}), "1");
  assert.equal(run({ ENTOMATICAL_WRAPPED: "1" }), "2", "a VSCodium started from a panel session's tool: its panels keep the inner wrapper");
  assert.equal(run({ ENTOMATICAL_WRAPPED: "2" }), "unset", "a loop through a renamed copy stops: no third round");
  assert.equal(fs.readFileSync(mark, "utf8"), "ran\nran\n", "the inner wrapper ran twice");
});

test("a claude that Node cannot start without a shell (a .cmd on Windows) gives exit 127 and one line, not a crash", (t) => {
  const s = scratch(t);
  const patch = s.script("throw.js", 'require("child_process").spawn = () => { throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" }); };');
  const claude = path.join(s.home, "claude.cmd");
  const r = spawnSync(process.execPath, ["-r", patch, js, claude], { cwd: s.home, env: s.env, input: "", encoding: "utf8" });
  assert.equal(r.status, 127);
  assert.equal(r.stderr, `entomatical-claude: could not start ${claude}: spawn EINVAL\n`);
});

test("the Windows launcher finds node.exe only in full PATH folders, never through a relative entry read against the repo", { skip: !win && "the launcher is Windows-only" }, (t) => {
  const exe = path.join(__dirname, "..", "wrapper", "entomatical-claude.exe");
  if (!fs.existsSync(exe)) return t.skip("wrapper/entomatical-claude.exe is not built (npm run build:wrapper)");
  const s = scratch(t);
  const repo = path.join(s.home, "repo");
  fs.mkdirSync(path.join(repo, "bin"), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(repo, "node.exe")); // a repo's own node.exe: must never be started
  fs.copyFileSync(process.execPath, path.join(repo, "bin", "node.exe"));
  // Also a drive-relative entry (`C:bin`, read against the current folder on that drive) and a root-relative one (`\…\repo\bin`,
  // read against the current drive): both name the repo's bin here, and neither is a full path (Windows review item, 5 November 2026).
  const driveRelative = repo.slice(0, 2) + "bin", rootRelative = path.join(repo, "bin").slice(2);
  for (const PATH of [".", "bin", `.;bin;${path.join(s.home, "nowhere")}`, driveRelative, rootRelative]) {
    const r = spawnSync(exe, ["--version"], { cwd: repo, env: { ...s.env, PATH, Path: undefined }, input: "", encoding: "utf8" });
    assert.equal(r.status, 127, `PATH=${PATH}: ${r.stdout} ${r.stderr}`);
    assert.match(r.stderr, /node\.exe is not on PATH/);
  }
  const ok = spawnSync(exe, [process.execPath, "-e", "process.exit(5)"], { cwd: repo, env: { ...s.env, PATH: `.;${path.dirname(process.execPath)}`, Path: undefined }, input: "", encoding: "utf8" });
  assert.equal(ok.status, 5, `a full PATH entry after a relative one is used: ${ok.stderr}`);
});

test("the launch and prompt files are read before anything changes: a held prompt file is retried, an unreadable one leaves the session as started", (t) => {
  const run = (code) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-read-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const r = pendingRepo(home);
    const patch = path.join(home, "held.js");
    fs.writeFileSync(patch, `const fs = require("fs"), read = fs.readFileSync; let busy = 2;
      fs.readFileSync = (p, o) => { if (String(p) === ${JSON.stringify(r.prompt)} && (${JSON.stringify(code)} === "EACCES" || busy-- > 0)) throw Object.assign(new Error("held"), { code: ${JSON.stringify(code)} }); return read(p, o); };`);
    return { ...r, saw: wrapperRun(home, r.repo, ["-r", patch]) };
  };
  const held = run("EBUSY");
  assert.equal(fs.realpathSync(held.saw.cwd), fs.realpathSync(held.worktree));
  assert.equal(JSON.parse(held.saw.lines[1]).message.content, "do t1");
  const lost = run("EACCES");
  assert.equal(fs.realpathSync(lost.saw.cwd), fs.realpathSync(lost.repo), "not moved to the worktree without its prompt");
  assert.deepEqual([lost.saw.lines.length, lost.saw.args.includes("--name")], [1, false]);
  assert.match(lost.saw.log, /launch file ignored: held/);
  assert.ok(fs.existsSync(path.join(lost.repo, ".entomatical", "launch", "pending.txt")), "the claim is given back for the next start");
});

test("a CLI that ignores SIGTERM is SIGKILLed at the 3 s backstop and the wrapper exits 143", { skip: linuxOnly }, async (t) => {
  const s = scratch(t);
  const stubborn = s.script("stubborn.js", `process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);`);
  const w = spawn(process.execPath, [js, process.execPath, stubborn], { cwd: s.home, env: s.env, stdio: ["pipe", "pipe", "inherit"] });
  await new Promise((ok) => w.stdout.once("data", ok));
  const sent = performance.now();
  w.kill("SIGTERM");
  assert.deepEqual(await exited(w), { code: 143, signal: null });
  const took = performance.now() - sent;
  assert.ok(took >= 2500 && took < 4500, `the backstop, about 3 s: ${took} ms`);
});

test("the wrapper log becomes .1 past 1 MB, and a new log is readable by its user only", { skip: win && "file modes" }, (t) => {
  const s = scratch(t);
  const log = path.join(s.temp, "entomatical-wrapper.log");
  fs.writeFileSync(log, "x".repeat((1 << 20) + 1));
  execFileSync(process.execPath, [js, process.execPath, "-e", ""], { cwd: s.home, env: s.env, input: "" });
  assert.equal(fs.statSync(`${log}.1`).size, (1 << 20) + 1);
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
});
