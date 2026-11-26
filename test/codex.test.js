const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// codex.js reads CODEX_HOME and the usage folder once, at load: both point at throwaway folders for this file's tests.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-codex-home-"));
process.env.CODEX_HOME = home;
process.env.ENTOMATICAL_USAGE_DIR = path.join(home, "usage");
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const c = require("../out/codex.js");

const { useFakeCodex } = require("./fake-codex-use.js");
/** Runs fn with the fake app-server as the Codex binary (see fake-codex-use.js), on Windows and Linux alike. */
async function withFake(fn) {
  const fake = useFakeCodex(c);
  try { return await fn(fake.file); } finally { fake.done(); }
}

test("the Codex binary is the installed codex on PATH, never the Codex extension's bundled copy (F61)", () => {
  // Linux: the first `codex` on PATH, the npm Node launcher included.
  assert.equal(c.installedBinary("/usr/bin:/home/r/.local/bin", "linux", (f) => f === "/home/r/.local/bin/codex"), "/home/r/.local/bin/codex");
  // Windows: a codex.exe on PATH wins; npm's codex.cmd launcher resolves to the native codex.exe it runs.
  assert.equal(c.installedBinary("C:\\tools;C:\\npm", "win32", (f) => f === "C:\\tools\\codex.exe"), "C:\\tools\\codex.exe");
  const exe = "C:\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
  assert.equal(c.installedBinary("C:\\x;C:\\npm", "win32", (f) => f === "C:\\npm\\codex.cmd" || f === exe), exe);
  // An extension folder is never searched: with nothing on PATH the answer is plain "codex", which fails loudly.
  assert.equal(c.installedBinary("C:\\x", "win32", () => false), "codex");
});

test("an explicit Codex npm .cmd setting resolves the native executable without a shell", () => {
  const shim = "C:\\Users\\test user\\npm\\codex.cmd";
  const exe = "C:\\Users\\test user\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
  assert.equal(c.nativeCodexBinary(shim, "win32", (file) => file === shim || file === exe), exe);
  assert.equal(c.nativeCodexBinary(shim, "win32", () => false), shim, "an unresolved setting remains available for runner diagnostics");
  assert.equal(c.nativeCodexBinary("/usr/local/bin/codex", "linux"), "/usr/local/bin/codex");
  // npm's other two launchers beside codex.cmd (found on Windows, 5 November 2026): PowerShell and the extensionless shell script.
  for (const other of ["C:\\Users\\test user\\npm\\codex.ps1", "C:\\Users\\test user\\npm\\codex"]) assert.equal(c.nativeCodexBinary(other, "win32", (file) => file === exe), exe);
  assert.equal(c.nativeCodexBinary("C:\\tools\\codex.exe", "win32", () => true), "C:\\tools\\codex.exe", "a real executable is left alone");
  assert.equal(c.nativeCodexBinary("codex", "win32", () => true), "codex", "a bare name is not resolved against the editor's folder");
});

test("which Codex runs: codexPath, then WSL (Windows with the setting on), then an existing chatgpt.cliExecutable, then PATH (F61)", () => {
  const exists = (f) => f === "/opt/codex";
  assert.deepEqual(c.codexChoice("/my/codex", "/opt/codex", true, "win32", exists), { via: "codexPath", file: "/my/codex" });
  assert.deepEqual(c.codexChoice("", "/opt/codex", true, "win32", exists), { via: "wsl" });
  assert.deepEqual(c.codexChoice("", "/opt/codex", true, "linux", exists), { via: "cliExecutable", file: "/opt/codex" }, "the WSL setting means nothing off Windows");
  assert.deepEqual(c.codexChoice("", "/gone/codex", false, "linux", exists), { via: "PATH" }, "a cliExecutable that is not there");
  assert.deepEqual(c.codexChoice("", null, false, "win32", exists), { via: "PATH" });
});

test("Linux PATH lookup takes only an executable regular file, in an absolute folder (F61)", { skip: process.platform === "win32" && "the Windows branch checks existence" }, (t) => {
  const { execTmpdir } = require("./exec-tmpdir.js");
  const root = fs.mkdtempSync(path.join(execTmpdir(), "entomatical-path-")); // access(X_OK) fails on a noexec mount
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const [plain, folder, good] = ["plain", "folder", "good"].map((d) => (fs.mkdirSync(path.join(root, d)), path.join(root, d)));
  fs.writeFileSync(path.join(plain, "codex"), "#!/bin/sh\n", { mode: 0o644 }); // no execute bit
  fs.mkdirSync(path.join(folder, "codex")); // a folder named codex
  fs.writeFileSync(path.join(good, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(c.installedBinary([plain, folder, good].join(":"), "linux"), path.join(good, "codex"));
  const cwd = process.cwd();
  try {
    process.chdir(root);
    assert.equal(c.installedBinary("good", "linux"), "codex", "a relative PATH entry is never searched");
  } finally {
    process.chdir(cwd);
  }
});

test("codexVersion and bundledCodex: the first line of --version, and the Codex extension's bin/<platform>/codex (F61)", async (t) => {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-chatgpt-"));
  t.after(() => fs.rmSync(ext, { recursive: true, force: true }));
  assert.equal(c.bundledCodex(ext), undefined);
  assert.equal(c.bundledCodex(undefined), undefined);
  fs.mkdirSync(path.join(ext, "bin", "linux-x86_64"), { recursive: true });
  fs.writeFileSync(path.join(ext, "bin", "linux-x86_64", "codex"), "");
  assert.equal(c.bundledCodex(ext, "linux"), path.join(ext, "bin", "linux-x86_64", "codex"));
  assert.equal(await c.codexVersion(process.execPath, ["-e", "console.log('codex-cli 9.9.9\\nmore')"]), "codex-cli 9.9.9");
  assert.equal(await c.codexVersion(path.join(ext, "missing")), undefined);
});

test("Codex usage keeps each window at the length Codex reports (Plus: 5-hour and weekly; Pro: weekly only; any other length as is); app-server and rollout field names", () => {
  assert.deepEqual(c.parseCodexUsage({ primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1793000000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1793600000 } }, 5),
    { at: 5, source: "query", windows: [{ minutes: 300, pct: 12, resets: 1793000000 }, { minutes: 10080, pct: 40, resets: 1793600000 }] });
  // Seen 26 Oct 2026 on a Pro plan: one weekly window as primary, no secondary. No 5-hour window is invented for it.
  assert.deepEqual(c.parseCodexUsage({ primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1793608189 }, secondary: null }, 5),
    { at: 5, source: "query", windows: [{ minutes: 10080, pct: 1, resets: 1793608189 }] });
  // The same limits as a rollout's token_count record writes them (snake_case).
  assert.deepEqual(c.parseCodexUsage({ primary: { used_percent: 1, window_minutes: 10080, resets_at: 1793608189 }, secondary: null, plan_type: "promax" }, 5),
    { at: 5, source: "query", windows: [{ minutes: 10080, pct: 1, resets: 1793608189 }] });
  // A length Claude does not have (a day, or Go's monthly allowance) is kept rather than dropped or relabelled; shortest first.
  assert.deepEqual(c.parseCodexUsage({ primary: { usedPercent: 9, windowDurationMins: 43200 }, secondary: { usedPercent: 5, windowDurationMins: 1440 } }, 5),
    { at: 5, source: "query", windows: [{ minutes: 1440, pct: 5, resets: undefined }, { minutes: 43200, pct: 9, resets: undefined }] });
  for (const bad of [undefined, {}, { primary: { usedPercent: 140, windowDurationMins: 300 } }, { primary: { usedPercent: 5, windowDurationMins: 0 } }, { primary: { usedPercent: 5 } }]) {
    assert.throws(() => c.parseCodexUsage(bad), /did not report/);
  }
});

const hookFlags = (hook) => c.CODEX_HOOKS.flatMap((e) => ["-c", `hooks.${e}=[{matcher="*",hooks=[{type="command",command=${JSON.stringify(`node "${hook}"`)}}]}]`]);

test("Codex session arguments: model, effort, one hook override per event, the prompt after --, and resume; no trust bypass", () => {
  const hook = "C:\\Users\\x y\\codex-hook.js";
  const hooks = hookFlags("C:/Users/x y/codex-hook.js");
  assert.equal(hooks.length, 18);
  assert.deepEqual(c.hookArgs(hook), hooks);
  const start = c.codexArgs({ model: "gpt-a", effort: "ultra", hook, prompt: "-p looks like a flag\nline two" });
  assert.deepEqual(start, ["-m", "gpt-a", "-c", 'model_reasoning_effort="ultra"', ...hooks, "--", "-p looks like a flag\nline two"]);
  // The command inside the TOML is a JSON string: quotes, spaces and (forward-slashed) backslashes survive.
  const command = /command=(".*")\}\]\}\]$/.exec(start[5])[1];
  assert.equal(JSON.parse(command), 'node "C:/Users/x y/codex-hook.js"');
  // The same command for every task (the events file travels in ENTOMATICAL_EVENTS), so one approval covers them all.
  assert.ok(!start.join(" ").includes("events"));
  assert.ok(!start.includes("--dangerously-bypass-hook-trust"));
  assert.deepEqual(c.codexArgs({ hook, prompt: "go" }), [...hooks, "--", "go"]);
  // A resume runs in the folder it is started in (the worktree), never the one Codex's thread store remembers: in WSL that store
  // holds a lower-case copy of the path, which Codex (case-sensitive there) would stop to trust again (2 November 2026).
  const here = ["-c", 'tui.resume_cwd="current"'];
  assert.deepEqual(c.codexArgs({ hook, resume: "thread-1" }), ["resume", ...hooks, ...here, "thread-1"]);
  assert.deepEqual(c.codexArgs({ hook, resume: "thread-1", prompt: "Resume." }), ["resume", ...hooks, ...here, "thread-1", "Resume."]);
  assert.deepEqual(c.codexArgs({ hook, model: "gpt-b", resume: "" }), ["resume", "-m", "gpt-b", ...hooks, ...here, "--last"]);
  // The permission menu: Codex's /approvals presets as config overrides; Codex has no accept-edits mode.
  assert.deepEqual(c.codexArgs({ hook, permission: "bypass", prompt: "go" }), ["-c", 'approval_policy="never"', "-c", 'sandbox_mode="danger-full-access"', ...hooks, "--", "go"]);
  assert.deepEqual(c.codexArgs({ hook, permission: "ask", resume: "t" }), ["resume", "-c", 'approval_policy="on-request"', "-c", 'sandbox_mode="read-only"', ...hooks, ...here, "t"]);
  for (const permission of ["edits", "", null, false, 0, ["ask"], "toString"]) {
    assert.throws(() => c.codexArgs({ hook, permission, prompt: "go" }), /Unknown Codex permission/);
    assert.throws(() => c.codexArgs({ hook, permission, resume: "t" }), /Unknown Codex permission/);
  }
  // Without a hook path, the fixed copy in ~/.entomatical, which placeCodexHook keeps current.
  assert.deepEqual(c.codexArgs({ prompt: "go" }), [...c.hookArgs(c.CODEX_HOOK), "--", "go"]);
});

test("hook approval: only Entomatical's unapproved hooks are listed, and approving writes their hashes as Codex's /hooks screen does", async () => {
  const log = path.join(home, "requests.jsonl");
  process.env.FAKE_CODEX_LOG = log;
  const hook = "C:/x/codex-hook.js";
  try {
    await withFake(async () => {
      const { hooks: pending } = await c.pendingApprovals("/repo/.entomatical/wt/t1", hook);
      // Nine of ours, none of the user's own: that one stays off, unlike under --dangerously-bypass-hook-trust.
      assert.equal(pending.length, 9);
      assert.ok(pending.every((h) => h.key.includes("<session-flags>")));
      const requests = () => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.method !== "initialize");
      const [list] = requests();
      assert.deepEqual(list.params, { cwds: ["/repo/.entomatical/wt/t1"] });
      assert.deepEqual(list.argv.filter((a) => a !== "app-server"), c.hookArgs(hook)); // listed exactly as a session passes them
      fs.rmSync(log);
      await c.approveCodex({ hooks: pending.slice(0, 2) });
      const [write] = requests();
      assert.deepEqual(write.params, { edits: [{ keyPath: "hooks.state", mergeStrategy: "upsert", value: {
        "/<session-flags>/config.toml:session_start:0:0": { trusted_hash: "sha256:SessionStart" },
        "/<session-flags>/config.toml:user_prompt_submit:0:0": { trusted_hash: "sha256:UserPromptSubmit" } } }] });
      fs.rmSync(log);
      await c.approveCodex({ hooks: [] });
      assert.equal(fs.existsSync(log), false, "nothing to approve makes no call");
      process.env.FAKE_CODEX_TRUSTED = "/<session-flags>/config.toml:session_start:0:0";
      assert.equal((await c.pendingApprovals("/repo", hook)).hooks.length, 8);
    });
  } finally { delete process.env.FAKE_CODEX_LOG; delete process.env.FAKE_CODEX_TRUSTED; }
});

/** A throwaway repo with one commit, a subfolder and a linked worktree, as Entomatical makes them; plus a folder outside git. */
function trustFixture() {
  const top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-trust-")));
  const repo = path.join(top, "My.Repo"), worktree = path.join(repo, ".entomatical", "wt", "t1"), loose = path.join(top, "loose");
  fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
  fs.mkdirSync(loose);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  git("worktree", "add", "-q", "-b", "task/t1", worktree);
  return { top, repo, worktree, loose, done: () => fs.rmSync(top, { recursive: true, force: true }) };
}

test("trustRoot finds the folder Codex asks to trust: the repo, also from a subfolder, and the main repo for a linked worktree", () => {
  const f = trustFixture();
  try {
    assert.equal(c.trustRoot(f.repo), f.repo);
    assert.equal(c.trustRoot(path.join(f.repo, "sub")), f.repo);
    // codex-cli 0.164's screen in a worktree: "Trusting will apply to the repository root: <main repo>" (seen 29 Oct 2026).
    assert.equal(c.trustRoot(f.worktree), f.repo);
    assert.equal(c.trustRoot(f.loose), undefined);
    fs.mkdirSync(path.join(f.loose, ".git")); // an empty .git folder, as Codex's sandbox leaves in /tmp: not a repository
    assert.equal(c.trustRoot(path.join(f.loose)), undefined);
    assert.equal(c.trustRoot(path.join(f.repo, "sub")), f.repo, "a real repository still counts");
  } finally { f.done(); }
});

test("folderTrust reads the folder's own projects entry, else its repo root's; a trusted parent folder does not count", () => {
  const f = trustFixture();
  try {
    const level = (projects, cwd = f.worktree) => c.folderTrust({ projects }, cwd).level;
    assert.deepEqual(c.folderTrust({ projects: {} }, f.worktree), { root: f.repo, level: undefined });
    assert.equal(level({ [f.repo]: { trust_level: "trusted" } }), "trusted");
    assert.equal(level({ [f.repo]: { trust_level: "untrusted" } }), "untrusted");
    assert.equal(level({ [f.repo]: { trust_level: "trusted" }, [f.worktree]: { trust_level: "untrusted" } }), "untrusted");
    assert.equal(level({ [f.top]: { trust_level: "trusted" } }), undefined);
    assert.equal(level({ [f.repo]: {} }), undefined);
    assert.equal(c.folderTrust({}, f.repo).level, undefined); // no projects table at all
    assert.equal(c.folderTrust(undefined, f.repo).level, undefined);
  } finally { f.done(); }
});

test("folderTrust compares projects keys as the Codex that wrote them does: any case natively on Windows, exactly in WSL (F61)", { skip: process.platform !== "win32" && "Windows paths" }, () => {
  const f = trustFixture();
  const swapCase = (p) => p.replace(/[a-z]/gi, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()));
  const level = (projects, cwd = f.worktree) => c.folderTrust({ projects }, cwd).level;
  try {
    // Native Windows Codex: a key in another case or with forward slashes is the same folder.
    assert.equal(level({ [swapCase(f.repo)]: { trust_level: "trusted" } }), "trusted");
    assert.equal(level({ [f.repo.replace(/\\/g, "/")]: { trust_level: "trusted" } }), "trusted");
    // Codex in WSL writes /mnt/c/... keys and, being a Linux program, matches them exactly: the lower-case copy its thread store
    // keeps is not the trusted folder (it stopped on "Trust this folder?" for it on resume, 2 November 2026).
    c.useCodexWsl("Ubuntu", path.join(f.top, "codex-home"));
    const key = (p) => "/mnt/" + p[0].toLowerCase() + p.slice(2).replace(/\\/g, "/");
    assert.equal(level({ [key(f.repo)]: { trust_level: "trusted" } }, f.repo), "trusted");
    assert.equal(level({ [key(f.worktree)]: { trust_level: "untrusted" }, [key(f.repo)]: { trust_level: "trusted" } }), "untrusted");
    assert.equal(level({ [key(f.repo).toLowerCase()]: { trust_level: "trusted" } }, f.repo), undefined);
    assert.equal(level({ [key(swapCase(f.repo))]: { trust_level: "trusted" } }, f.repo), undefined);
    assert.equal(level({ [f.repo]: { trust_level: "trusted" } }, f.repo), undefined, "a Windows-form key is not what WSL Codex wrote");
    // Git for Windows writes the worktree's `.git` as `gitdir: C:/…`, which Linux Codex cannot follow: it asks about the worktree
    // itself, so the repo's trust does not reach it (Codex stopped on "Trust this folder?" for it, 5 November 2026).
    assert.match(fs.readFileSync(path.join(f.worktree, ".git"), "utf8"), /^gitdir: [A-Za-z]:\//);
    assert.equal(c.trustRoot(f.worktree), f.worktree);
    assert.equal(c.trustRoot(f.worktree, false), f.repo, "native Codex still follows it to the repo");
    assert.equal(level({ [key(f.repo)]: { trust_level: "trusted" } }), undefined);
    assert.equal(level({ [key(f.worktree)]: { trust_level: "trusted" } }), "trusted");
  } finally { c.useCodexWsl(undefined, home); f.done(); }
});

test("while WSL mode waits for WSL, Codex never starts on Windows instead (8 November 2026)", () => {
  try {
    c.awaitCodexWsl();
    assert.throws(() => c.codexCommand(["--version"]), /WSL is not answering/);
    assert.throws(() => c.codexTextPath(), /WSL is not answering/);
    assert.throws(() => c.checkResumable("\\\\wsl.localhost\\Ubuntu\\home\\example\\.codex\\sessions\\r.jsonl"), /WSL is not answering/);
    c.useCodexWsl("Ubuntu", path.join(home, "wsl-home")); // WSL answers: its Codex runs
    assert.equal(c.codexCommand(["--version"]).file, "wsl.exe");
    assert.equal(c.codexCommand([], undefined, { ENTOMATICAL_TERMINAL_LAUNCH: "test-launch" }).env.WSLENV, "ENTOMATICAL_TERMINAL_LAUNCH");
  } finally { c.awaitCodexWsl(false); c.useCodexWsl(undefined, home); }
});

test("a session recorded in WSL is not resumed by Windows Codex (8 November 2026)", () => {
  const wslRollout = "\\\\wsl.localhost\\Ubuntu\\home\\example\\.codex\\sessions\\2026\\11\\08\\rollout-x.jsonl";
  assert.throws(() => c.checkResumable(wslRollout), /recorded in WSL \(Ubuntu\).*runCodexInWindowsSubsystemForLinux/);
  assert.throws(() => c.checkResumable("\\\\wsl$\\Ubuntu\\home\\r.jsonl"), /recorded in WSL/);
  assert.doesNotThrow(() => c.checkResumable("C:\\Users\\example\\.codex\\sessions\\r.jsonl"));
  assert.doesNotThrow(() => c.checkResumable(undefined));
  try {
    c.useCodexWsl("Ubuntu", path.join(home, "wsl-home"));
    assert.doesNotThrow(() => c.checkResumable(wslRollout), "WSL Codex resumes its own sessions");
  } finally { c.useCodexWsl(undefined, home); }
});

test("a helper names Codex's own AGENTS.md, also the WSL distro's (unannounced in WSL before 5 November 2026)", (t) => {
  const w = require("../out/worker.js");
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-agents-")), wslHome = path.join(top, "codex-home");
  fs.mkdirSync(wslHome);
  t.after(() => { c.useCodexWsl(undefined, home); fs.rmSync(top, { recursive: true, force: true }); });
  c.useCodexWsl("Ubuntu", wslHome);
  assert.equal(w.codexAgentsNote("Ubuntu"), undefined, "no AGENTS.md, no line");
  fs.writeFileSync(path.join(wslHome, "AGENTS.md"), "rules\n");
  assert.match(w.codexAgentsNote("Ubuntu"), /^Codex also reads \/.*\/AGENTS\.md \(6 bytes\)/); // the temp folder may hold a space ("Dev Stuff")
  assert.equal(w.codexAgentsNote("Debian"), undefined, "a distro whose Codex home is unknown is not guessed");
});

test("folder trust: an untrusted repo is reported with the hooks in one app-server, and approving writes what Codex's trust screen does", async () => {
  const f = trustFixture();
  const log = path.join(f.top, "requests.jsonl"), config = path.join(f.top, "config.json");
  const hook = "C:/x/codex-hook.js";
  Object.assign(process.env, { FAKE_CODEX_LOG: log, FAKE_CODEX_CONFIG: config });
  const requests = () => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.method !== "initialize");
  try {
    await withFake(async () => {
      fs.writeFileSync(config, JSON.stringify({ model: "m", projects: { "/elsewhere": { trust_level: "trusted" } } }));
      const pending = await c.pendingApprovals(f.worktree, hook);
      assert.deepEqual([pending.hooks.length, pending.folder, pending.markedUntrusted, pending.folderUnknown], [9, f.repo, false, undefined]);
      assert.deepEqual(requests().map((r) => [r.method, r.params]), [["hooks/list", { cwds: [f.worktree] }], ["config/read", { cwd: f.worktree }]]);
      assert.equal(new Set(requests().map((r) => JSON.stringify(r.argv))).size, 1, "one app-server answers both");
      fs.rmSync(log);
      await c.approveCodex(pending);
      const [write] = requests();
      assert.equal(write.method, "config/batchWrite");
      assert.equal(write.params.edits.length, 2, "one write for both approvals");
      assert.deepEqual(write.params.edits[1], { keyPath: "projects", value: { [f.repo]: { trust_level: "trusted" } }, mergeStrategy: "upsert" });
      assert.deepEqual(JSON.parse(fs.readFileSync(config, "utf8")).projects, { "/elsewhere": { trust_level: "trusted" }, [f.repo]: { trust_level: "trusted" } }); // upsert keeps the rest
      const after = await c.pendingApprovals(f.worktree, hook);
      assert.equal(after.folder, undefined);
      fs.rmSync(log);
      await c.approveCodex({ hooks: [] });
      assert.equal(fs.existsSync(log), false, "nothing to approve makes no call");
      // A WSL worktree Codex trusts on its own is written in the same edit as its repo.
      await c.approveCodex({ hooks: [], folder: f.repo, worktree: f.worktree });
      assert.deepEqual(requests()[0].params.edits, [{ keyPath: "projects", value: { [f.repo]: { trust_level: "trusted" }, [f.worktree]: { trust_level: "trusted" } }, mergeStrategy: "upsert" }]);
      fs.rmSync(log);
      // Marked untrusted: Codex 0.164 still stops, on "Open restricted / Quit", so it is asked about too.
      fs.writeFileSync(config, JSON.stringify({ projects: { [f.repo]: { trust_level: "untrusted" } } }));
      assert.deepEqual([(await c.pendingApprovals(f.repo, hook)).folder, (await c.pendingApprovals(f.repo, hook)).markedUntrusted], [f.repo, true]);
      // Outside git Codex has no repo to ask about.
      assert.equal((await c.pendingApprovals(f.loose, hook)).folder, undefined);
      // A Codex without config/read: the hooks are still reported, and the folder is left to Codex's own screen.
      delete process.env.FAKE_CODEX_CONFIG;
      const old = await c.pendingApprovals(f.worktree, hook);
      assert.deepEqual([old.hooks.length, old.folder], [9, undefined]);
      assert.match(old.folderUnknown, /unknown method config\/read/);
    });
  } finally { delete process.env.FAKE_CODEX_LOG; delete process.env.FAKE_CODEX_CONFIG; f.done(); }
});

test("placeCodexHook copies the hook script only when it differs", () => {
  const target = path.join(home, "entomatical", "codex-hook.js");
  const bundled = path.join(__dirname, "..", "hook", "hook.js");
  c.placeCodexHook(bundled, target);
  assert.equal(fs.readFileSync(target, "utf8"), fs.readFileSync(bundled, "utf8"));
  fs.writeFileSync(target, "old");
  c.placeCodexHook(bundled, target);
  assert.equal(fs.readFileSync(target, "utf8"), fs.readFileSync(bundled, "utf8"));
  c.placeCodexHook(path.join(home, "missing.js"), target); // no bundled script: the copy is left alone
  assert.equal(fs.readFileSync(target, "utf8"), fs.readFileSync(bundled, "utf8"));
});

// Rollout records as codex-cli 0.163 wrote them on 26 Oct 2026, trimmed to the fields the board reads.
const day = path.join(home, "sessions", "2026", "10", "26");
const rolloutPath = (thread, time = "03-18-35") => path.join(day, `rollout-2026-10-26T${time}-${thread}.jsonl`);
const meta = (thread, cwd, source = "cli", ts = "2026-10-26T10:18:35.435Z") => ({ timestamp: ts, ordinal: 0, type: "session_meta", payload: { id: thread, timestamp: ts, cwd, originator: "codex-tui", source } });
const ev = (type, payload, ts = "2026-10-26T10:19:47.379Z") => ({ timestamp: ts, type: "event_msg", payload: { type, ...payload } });
const usage = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
const tokens = (last, total, ts) => ev("token_count", { info: { total_token_usage: total, last_token_usage: last, model_context_window: 258400 },
  rate_limits: { limit_id: "codex", primary: { used_percent: 1, window_minutes: 10080, resets_at: 1793608189 }, secondary: null, plan_type: "promax" } }, ts);
const user = (text) => ev("item_completed", { item: { type: "UserMessage", id: "u1", content: [{ type: "text", text }] } });
const call = (id, name, input) => ({ timestamp: "2026-10-26T10:19:50.010Z", type: "response_item", payload: { type: "custom_tool_call", id: `ctc_${id}`, call_id: id, name, input, status: "completed" } });
const output = (id) => ({ timestamp: "2026-10-26T10:20:38.756Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: "" } });
const turnContext = (model) => ({ timestamp: "2026-10-26T10:19:47.398Z", type: "turn_context", payload: { turn_id: "t", cwd: "/w", model, effort: "low" } });
const write = (file, records) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, records.map((r) => JSON.stringify(r) + "\n").join("")); };
const append = (file, records) => fs.appendFileSync(file, records.map((r) => JSON.stringify(r) + "\n").join(""));

test("a rollout read incrementally: prompts, turns, an escalated command waiting for approval, interrupts, tokens and rate limits", () => {
  const file = rolloutPath("01a177b8-1536-79a0-8e24-9548b05a924e");
  write(file, [meta("01a177b8-1536-79a0-8e24-9548b05a924e", "/w"), turnContext("gpt-5.6-luna"), ev("task_started", { turn_id: "t1" }), user("Reply with the single word OK."),
    tokens(usage(21200, 0, 5), usage(21200, 0, 5), "2026-10-26T10:18:37.967Z"), ev("task_complete", { turn_id: "t1", last_agent_message: "OK" }, "2026-10-26T10:18:37.998Z")]);
  let r = c.readRollout(file);
  assert.deepEqual([r.thread, r.cwd, r.source, r.model, r.exchanges, r.lastReply, r.turn, c.rolloutStatus(r)], ["01a177b8-1536-79a0-8e24-9548b05a924e", "/w", "cli", "gpt-5.6-luna", [{ text: "Reply with the single word OK.", reply: "OK" }], "OK", "review", "review"]);
  assert.deepEqual(r.tokens, { input: 21200, cacheRead: 0, cacheWrite: 0, output: 5 });
  assert.equal(r.at, Date.parse("2026-10-26T10:18:37.967Z"));
  // Turn 2: the model asks to run an escalated command. Until its output lands, the session waits for the user.
  append(file, [ev("task_started", { turn_id: "t2" }), user("Run the shell command `touch x`."),
    call("call_1", "exec", 'const r = await tools.exec_command({cmd:"touch x",sandbox_permissions:"require_escalated",justification:"May I?"});')]);
  r = c.readRollout(file);
  assert.deepEqual([r.turn, c.rolloutStatus(r), r.steps, r.doing, r.exchanges.length, r.exchanges[1]], ["running", "needs-input", 1, 'exec const r = await tools.exec_command({cmd:"touch x",sandbox_permissions:"require_escalated",justification:"May I?"});', 2, { text: "Run the shell command `touch x`." }]);
  append(file, [output("call_1")]);
  assert.equal(c.rolloutStatus(c.readRollout(file)), "running");
  // Cached input is counted inside input by Codex; the board keeps the two apart, so the four token fields add up.
  append(file, [tokens(usage(21218, 20992, 6), usage(42418, 20992, 11), "2026-10-26T10:20:41.069Z"), ev("task_complete", { turn_id: "t2", last_agent_message: "DONE" })]);
  r = c.readRollout(file);
  assert.deepEqual([r.tokens, r.models, r.lastReply, r.turn], [{ input: 21426, cacheRead: 20992, cacheWrite: 0, output: 11 }, { "gpt-5.6-luna": { input: 21426, cacheRead: 20992, cacheWrite: 0, output: 11 } }, "DONE", "review"]);
  // Esc during a turn: Codex writes turn_aborted, which ends the turn like task_complete.
  append(file, [ev("task_started", { turn_id: "t3" }), call("call_2", "exec", 'tools.exec_command({cmd:"sleep 90"})')]);
  assert.equal(c.rolloutStatus(c.readRollout(file)), "running"); // a plain command needs no approval
  append(file, [ev("turn_aborted", { turn_id: "t3", reason: "interrupted" })]);
  assert.deepEqual([c.readRollout(file).turn, c.readRollout(file).pending.size], ["review", 0]);
  // A half-written last line waits; once complete it counts.
  const half = JSON.stringify(user("typed later"));
  fs.appendFileSync(file, half.slice(0, 20));
  assert.equal(c.readRollout(file).exchanges.length, 2);
  fs.appendFileSync(file, half.slice(20) + "\n");
  assert.equal(c.readRollout(file).exchanges.length, 3);
  // A damaged line is skipped without losing the rest.
  append(file, ["not json", user("after damage")]);
  assert.equal(c.readRollout(file).exchanges.at(-1).text, "after damage");
});

test("terminal facts describe historical rows independently of a running turn or an older final answer", () => {
  const thread = "01a1e990-8db4-7df2-b076-3ac5fe53f2cc", file = rolloutPath(thread);
  const a = "01a1e990-8dce-7510-859c-441594127688", b = "01a1e995-2839-73e1-a896-d56ac1e63357";
  const row = (ordinal, type, payload) => ({ ...ev(type, payload), ordinal });
  const rows = [meta(thread, "/w"), row(1, "task_started", { turn_id: a }),
    row(41, "item_completed", { thread_id: thread, turn_id: a, item: { type: "AgentMessage", phase: "final_answer" } }),
    row(45, "task_complete", { turn_id: a, last_agent_message: "reply A" }), row(46, "task_started", { turn_id: b }),
    row(52, "item_completed", { thread_id: thread, turn_id: b, item: { type: "CommandExecution" } })];
  write(file, rows);
  const aggregate = c.readRollout(file);
  assert.deepEqual([aggregate.turnId, c.rolloutStatus(aggregate), aggregate.lastReply], [b, "running", "reply A"]);
  assert.equal("completion" in aggregate, false);
  const facts = rows.map(c.rolloutTerminalFact).filter(Boolean);
  assert.deepEqual(facts, [{ ordinal: 45, turnId: a, outcome: "completed", reply: "reply A", threadAttribution: "unknown" }]);
  const abort = row(53, "turn_aborted", { turn_id: b, thread_id: thread, reason: "fixture private" });
  const abortFact = c.rolloutTerminalFact(abort);
  assert.deepEqual(abortFact, { ordinal: 53, threadId: thread, turnId: b, outcome: "aborted", threadAttribution: "explicit" });
  assert.deepEqual([rows[1], rows[2], rows[4], abort].map(c.rolloutTerminalFact).filter(Boolean), [abortFact]);
  assert.ok(Object.isFrozen(facts[0]) && Object.isFrozen(abortFact));
});

test("fork headers and corroborating items cannot turn an untagged terminal row into an attributed fact", () => {
  const child = "01a2094b-a75e-7c10-90e8-00c76e1a728b", parent = "01a20914-c39e-7361-b49a-e6d355cf5766";
  const header = { ...meta(child, "/w"), payload: { id: child, parent_thread_id: parent, subagent_history_start_ordinal: 213 } };
  // Redacted November fork: a copied success at 87 and the child's own success at 283; neither terminal declares a thread.
  const end = ordinal => ({ ...ev("task_complete", { turn_id: "turn-" + ordinal, last_agent_message: "redacted" }), ordinal });
  const rows = [meta("", "/w"), end(87), header,
    ev("item_completed", { thread_id: child, turn_id: "turn-283", item: { type: "AgentMessage", phase: "final_answer" } }), end(283)];
  assert.deepEqual(rows.map(c.rolloutTerminalFact).filter(Boolean), [87, 283].map(ordinal => ({
    ordinal, turnId: "turn-" + ordinal, outcome: "completed", reply: "redacted", threadAttribution: "unknown",
  })));
  const copied = { ...end(87), payload: { ...end(87).payload, thread_id: parent } };
  assert.equal(c.rolloutTerminalFact(copied).threadId, parent);
});

test("terminal facts validate identifiers and ordinals and copy only row-owned scalar fields", () => {
  for (const invalid of [undefined, null, "", " ", "bad\nid", {}, ["A"], 7, "a".repeat(129)]) {
    const record = ev("task_complete", { turn_id: invalid, thread_id: invalid, last_agent_message: { secret: "private" } });
    assert.deepEqual(c.rolloutTerminalFact(record), { outcome: "completed", threadAttribution: "unknown" });
  }
  for (const ordinal of [-1, null, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(c.rolloutTerminalFact({ ...ev("turn_aborted", { last_agent_message: "other reply" }), ordinal }),
      { outcome: "aborted", threadAttribution: "unknown" });
  }
  const record = { ...ev("task_complete", { turn_id: "A:1._-2", thread_id: "T", tool_response: "private", root_turn_id: "other" }), ordinal: 0 };
  const fact = c.rolloutTerminalFact(record);
  record.payload.turn_id = "different";
  assert.deepEqual(fact, { ordinal: 0, turnId: "A:1._-2", outcome: "completed", threadId: "T", threadAttribution: "explicit" });
  for (const other of [null, "damaged", {}, { type: "event_msg", payload: null }, ev("task_started", {}),
    { ...record, type: "response_item" }]) assert.equal(c.rolloutTerminalFact(other), undefined);
});

test("RT-08: interleaved rollout polls preserve every UTF-8 split in prompts and replies", () => {
  const histories = [];
  for (const character of ["é", "界", "🦊"]) {
    for (let split = 1; split < Buffer.byteLength(character); split++) {
      const file = path.join(home, `history-${histories.length}.jsonl`);
      const text = `ask ${character} ${split}`, reply = `answer ${character} ${split}`;
      const records = [user(text), ev("task_complete", { last_agent_message: reply })];
      const [promptLine, replyLine] = records.map((record) => Buffer.from(JSON.stringify(record) + "\n"));
      const promptCut = promptLine.indexOf(character) + split, replyCut = replyLine.indexOf(character) + split;
      fs.writeFileSync(file, promptLine.subarray(0, promptCut));
      assert.deepEqual(c.readRollout(file).exchanges, []);
      histories.push({ file, text, reply, promptEnd: promptLine.subarray(promptCut),
        replyStart: replyLine.subarray(0, replyCut), replyEnd: replyLine.subarray(replyCut) });
    }
  }
  for (const { file, text, promptEnd, replyStart } of histories) {
    assert.deepEqual(c.readRollout(file).exchanges, []);
    fs.appendFileSync(file, Buffer.concat([promptEnd, replyStart]));
    assert.deepEqual(c.readRollout(file).exchanges, [{ text }]);
  }
  for (const { file, text, reply, replyEnd } of histories) {
    assert.deepEqual(c.readRollout(file).exchanges, [{ text }]);
    fs.appendFileSync(file, replyEnd);
    assert.deepEqual(c.readRollout(file).exchanges, [{ text, reply }]);
    assert.deepEqual(c.readRollout(file).exchanges, [{ text, reply }]);
  }
});

test("RT-08: truncating or replacing a rollout discards its unfinished UTF-8 and prior exchanges", () => {
  for (const change of ["truncate", "truncate and regrow", "replace"]) {
    const file = path.join(home, `${change}.jsonl`);
    write(file, [user("old prompt")]);
    const partial = Buffer.from(JSON.stringify(user("unfinished 🦊")));
    fs.appendFileSync(file, partial.subarray(0, partial.indexOf("🦊") + 2));
    assert.deepEqual(c.readRollout(file).exchanges, [{ text: "old prompt" }]);

    const text = "fresh café", reply = "only the replacement history should appear 🦊";
    const fresh = [ev("task_started", { turn_id: "new" }), user(text), ev("task_complete", { turn_id: "new", last_agent_message: reply })];
    if (change === "truncate") {
      fs.truncateSync(file, 0);
      assert.deepEqual(c.readRollout(file).exchanges, []);
      append(file, fresh);
    } else if (change === "truncate and regrow") {
      const previousSize = fs.statSync(file).size;
      write(file, fresh);
      assert.ok(fs.statSync(file).size > previousSize);
    } else {
      write(file + ".new", fresh);
      assert.ok(fs.statSync(file + ".new").size >= fs.statSync(file).size);
      fs.renameSync(file + ".new", file);
    }
    assert.deepEqual(c.readRollout(file).exchanges, [{ text, reply }]);
    assert.deepEqual(c.readRollout(file).exchanges, [{ text, reply }]);
  }
});

test("RT-08: a regrown rollout can change its first record or its cursor, at a newline or inside UTF-8", () => {
  const padding = ev("ignored", { pad: "x".repeat(4096) });
  const suffix = "q".repeat(100) + "🦊";
  for (const changed of ["head", "cursor"]) for (const boundary of ["newline", "partial"]) {
    const file = path.join(home, `${changed}-${boundary}.jsonl`);
    const rows = (version) => [user(changed === "head" ? version : "same first"), padding,
      user((changed === "cursor" ? version : "same last") + suffix)];
    const old = Buffer.from(rows("older").map((record) => JSON.stringify(record)).join("\n") + "\n");
    const cut = boundary === "newline" ? old.length : old.indexOf("🦊") + 2;
    fs.writeFileSync(file, old.subarray(0, cut));
    const inode = fs.statSync(file).ino;
    assert.equal(c.readRollout(file).exchanges.length, boundary === "newline" ? 2 : 1);
    write(file, [...rows("newer"), ev("task_complete", { last_agent_message: "final" })]);
    assert.equal(fs.statSync(file).ino, inode);
    assert.ok(fs.statSync(file).size > cut);
    const expected = [{ text: changed === "head" ? "newer" : "same first" },
      { text: (changed === "cursor" ? "newer" : "same last") + suffix, reply: "final" }];
    assert.deepEqual(c.readRollout(file).exchanges, expected);
    assert.deepEqual(c.readRollout(file).exchanges, expected);
  }
});

test("RT-08: a changed ctime exposes a same-size rewrite with restored mtime", async (t) => {
  const file = path.join(home, "restored-mtime.jsonl");
  const fixed = new Date("2026-01-01T00:00:00Z");
  write(file, [user("older é")]);
  fs.utimesSync(file, fixed, fixed);
  const before = fs.statSync(file, { bigint: true });
  assert.deepEqual(c.readRollout(file).exchanges, [{ text: "older é" }]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  write(file, [user("newer é")]);
  fs.utimesSync(file, fixed, fixed);
  const after = fs.statSync(file, { bigint: true });
  assert.deepEqual([after.ino, after.size, after.mtimeNs], [before.ino, before.size, before.mtimeNs]);
  if (after.ctimeNs === before.ctimeNs) return t.skip("the file system exposed no timestamp change");
  assert.deepEqual(c.readRollout(file).exchanges, [{ text: "newer é" }]);
});

test("RT-08: fragmented rollouts copy and read linear bytes, with bounded reads on append and none on unchanged polls", (t) => {
  function measure(work) {
    const read = fs.readSync, from = Buffer.from, concat = Buffer.concat;
    const io = { readCalls: 0, readBytes: 0, fromBytes: 0, concatBytes: 0 };
    fs.readSync = function (...args) {
      const count = read.apply(this, args);
      io.readCalls++; io.readBytes += count;
      return count;
    };
    Buffer.from = function (value, ...args) {
      const result = from.call(this, value, ...args);
      if (Buffer.isBuffer(value)) io.fromBytes += result.length;
      return result;
    };
    Buffer.concat = function (...args) {
      const result = concat.apply(this, args);
      io.concatBytes += result.length;
      return result;
    };
    try { work(); } finally { fs.readSync = read; Buffer.from = from; Buffer.concat = concat; }
    return io;
  }
  const file = path.join(home, "fragment-cost.jsonl"), chunk = 32 * 1024;
  const text = "x".repeat(4 * 1024 * 1024) + "🦊";
  const line = Buffer.from(JSON.stringify(user(text)) + "\n");
  const reply = Buffer.from(JSON.stringify(ev("task_complete", { last_agent_message: "final" })) + "\n");
  const fragmented = measure(() => {
    for (let i = 0; i < line.length; i += chunk) {
      fs.appendFileSync(file, line.subarray(i, i + chunk));
      const exchanges = c.readRollout(file).exchanges;
      assert.equal(exchanges.length, i + chunk >= line.length ? 1 : 0);
    }
  });
  const unchanged = measure(() => { for (let i = 0; i < 100; i++) c.readRollout(file); });
  fs.appendFileSync(file, reply);
  const append = measure(() => {
    const exchanges = c.readRollout(file).exchanges;
    assert.equal(exchanges.length, 1);
    assert.ok(exchanges[0].text === text && exchanges[0].reply === "final");
  });
  t.diagnostic(JSON.stringify({ lineBytes: line.length, replyBytes: reply.length, fragmented, unchanged, append }));
  assert.deepEqual(unchanged, { readCalls: 0, readBytes: 0, fromBytes: 0, concatBytes: 0 });
  assert.ok(fragmented.concatBytes <= line.length);
  assert.ok(fragmented.fromBytes + fragmented.concatBytes < 3 * line.length);
  assert.ok(fragmented.readBytes <= line.length + 4096 * Math.ceil(line.length / chunk));
  assert.ok(append.readBytes <= reply.length + 4096);
});

test("measurement and subagents of a Codex thread come from its rollout and the spawned agents' own rollouts; rate limits refresh the usage file", () => {
  const parent = "01a176a2-a6ea-7dc0-9f97-69808c9a0eea", child = "01a176a3-0000-7000-8000-000000000001", missing = "01a176a3-0000-7000-8000-00000000dead";
  const file = rolloutPath(parent, "02-10-49");
  write(file, [meta(parent, "/w"), turnContext("gpt-5.6-sol"), ev("task_started", { turn_id: "t1" }), user("Research with helpers."),
    ev("item_completed", { item: { type: "SubAgentActivity", id: "call_a", kind: "started", agent_thread_id: child, agent_path: "/root/gpu_6900xt" } }, "2026-10-26T10:19:48.000Z"),
    ev("item_completed", { item: { type: "SubAgentActivity", id: "call_b", kind: "started", agent_thread_id: missing, agent_path: "/root/lost" } }, "2026-10-26T10:19:48.000Z"),
    tokens(usage(1000, 400, 50), usage(1000, 400, 50), "2026-10-26T10:19:49.000Z")]);
  const childFile = rolloutPath(child, "02-11-00");
  write(childFile, [{ ...meta(child, "/w", { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: "/root/gpu_6900xt", agent_nickname: "Nietzsche", agent_role: null } } }) },
    turnContext("gpt-5.6-luna"), ev("task_started", { turn_id: "c1" }), call("call_c", "exec", 'tools.exec_command({cmd:"lspci"})'), output("call_c"),
    tokens(usage(300, 100, 20), usage(300, 100, 20), "2026-10-26T10:19:50.500Z"), ev("task_complete", { turn_id: "c1", last_agent_message: "Found it." })]);
  let m = c.codexMeasurement(file);
  assert.equal(m.source, "stream");
  assert.deepEqual(m.tokens, { input: 800, cacheRead: 500, cacheWrite: 0, output: 70 });
  assert.deepEqual(m.models, { "gpt-5.6-sol": { input: 600, cacheRead: 400, cacheWrite: 0, output: 50 }, "gpt-5.6-luna": { input: 200, cacheRead: 100, cacheWrite: 0, output: 20 } });
  assert.deepEqual([m.total, m.complete, m.at], [1370, false, Date.parse("2026-10-26T10:19:50.500Z")]);
  assert.ok(m.gaps.some((g) => /no cache writes/.test(g)) && m.gaps.some((g) => /spawned agent's session file was not found/.test(g)) && m.gaps.some((g) => /still running/.test(g)), m.gaps.join(" | "));
  // The token_count's rate limits reached the Codex usage file (the Accounts row reads it).
  const saved = JSON.parse(fs.readFileSync(path.join(home, "usage", `${path.basename(home)}.json`), "utf8")); // named after the Codex folder: ".codex.json" in use
  assert.deepEqual(saved, { at: Date.parse("2026-10-26T10:19:49.000Z"), source: "query", windows: [{ minutes: 10080, pct: 1, resets: 1793608189 }] });
  const agents = c.codexSubagents(file);
  assert.equal(agents.length, 2);
  assert.deepEqual({ ...agents[0], updated: 0 }, { id: child, type: "Nietzsche", description: "/root/gpu_6900xt", done: true, steps: 1, doing: 'exec tools.exec_command({cmd:"lspci"})', updated: 0, model: "gpt-5.6-luna", lifecycle: "transcript" });
  assert.deepEqual({ ...agents[1], updated: 0 }, { id: missing, type: "agent", description: "/root/lost", done: false, steps: 0, doing: "starting", updated: 0, model: undefined, lifecycle: "transcript" });
  append(file, [ev("item_completed", { item: { type: "SubAgentActivity", id: "subagent-completed-x", kind: "completed", agent_thread_id: missing, agent_path: "/root/lost" } }), ev("task_complete", { turn_id: "t1", last_agent_message: "Done." })]);
  m = c.codexMeasurement(file);
  assert.equal(c.codexSubagents(file)[1].done, true);
  assert.deepEqual([m.complete, m.gaps.length], [false, 2]); // the lost agent's tokens are still missing
  // codex-cli 0.163's own spawn_agent / wait records (seen live 26 Oct 2026): CollabAgentToolCall items with the agents' states.
  const third = "01a177d5-3204-7560-9e2b-863225aca663";
  const collab = (tool, states, extra = {}) => ev("item_completed", { item: { type: "CollabAgentToolCall", id: `exec-${tool}`, tool, status: "completed", sender_thread_id: parent, receiver_thread_ids: [third],
    receiver_agents: [{ thread_id: third, agent_nickname: "Herschel" }], agents_states: states, ...extra } }, "2026-10-26T10:50:23.175Z");
  append(file, [collab("spawn_agent", { [third]: "pending_init" }, { prompt: "Reply with the single word OK.\nSecond line.", model: "gpt-5.6-luna" })]);
  assert.deepEqual({ ...c.codexSubagents(file)[2], updated: 0 }, { id: third, type: "Herschel", description: "Reply with the single word OK.", done: false, steps: 0, doing: "starting", updated: 0, model: undefined, lifecycle: "transcript" });
  append(file, [collab("wait", { [third]: { completed: "OK" } })]);
  assert.deepEqual([c.codexSubagents(file)[2].done, c.codexSubagents(file)[2].type, c.codexSubagents(file).length], [true, "Herschel", 3]);
  assert.deepEqual(c.codexMeasurement(undefined), { tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, complete: false, source: "unknown", models: {}, gaps: ["Codex names its session file at the first turn; nothing to measure yet."], diagnostics: [] });
});

test("a repeated token_count adds nothing: the thread's own running total decides, and a total that went down starts again", () => {
  // Shapes from rollout 01a1820c (28 Oct 2026, codex-cli 0.163): the same token_count written 2-4 times between responses.
  const thread = "01a1820c-7c4c-7242-8a6b-4994ef0fa9d8", file = rolloutPath(thread, "03-26-58");
  const a = usage(23685, 0, 352), b = usage(31356, 23808, 409), ab = usage(55041, 23808, 761), c3 = usage(41844, 31616, 348), abc = usage(96885, 55424, 1109);
  write(file, [meta(thread, "/w"), turnContext("gpt-5.6-sol"), ev("task_started", { turn_id: "t1" }),
    tokens(a, a, "2026-10-28T10:27:07.359Z"), tokens(b, ab, "2026-10-28T10:27:15.287Z"), tokens(b, ab, "2026-10-28T10:27:16.000Z"), tokens(b, ab, "2026-10-28T10:27:17.000Z")]);
  const sum = (t) => t.input + t.cacheRead + t.cacheWrite + t.output;
  assert.equal(sum(c.readRollout(file).tokens), 55041 + 761); // not 23685+352 + 3 × (31356+409)
  append(file, [tokens(c3, abc, "2026-10-28T10:27:23.782Z"), tokens(c3, abc, "2026-10-28T10:27:24.000Z")]);
  let r = c.readRollout(file);
  assert.deepEqual(r.tokens, { input: 96885 - 55424, cacheRead: 55424, cacheWrite: 0, output: 1109 }); // equals Codex's own final total
  assert.deepEqual(r.models, { "gpt-5.6-sol": r.tokens });
  // Codex restarted its counters (a total lower than before): that total is all new.
  append(file, [tokens(usage(1000, 0, 10), usage(1000, 0, 10), "2026-10-28T11:00:00.000Z")]);
  assert.equal(sum(c.readRollout(file).tokens), 96885 + 1109 + 1010);
  // An older record with no total falls back to that response's own count.
  append(file, [ev("token_count", { info: { last_token_usage: usage(500, 0, 5) } }, "2026-10-28T11:00:01.000Z")]);
  assert.equal(sum(c.readRollout(file).tokens), 96885 + 1109 + 1010 + 505);
  // A spawned agent's rollout repeats the parent's session_meta (forked context), but its totals start at its own first response.
  const child = "01a1866f-5b1b-70f1-8c4a-c50b4c1a218d", childFile = rolloutPath(child, "23-53-27");
  write(childFile, [meta(child, "/w", { subagent: { thread_spawn: { parent_thread_id: thread, depth: 1, agent_path: "/root/x", agent_nickname: "Kant", agent_role: null } } }), meta(thread, "/w", "exec"),
    turnContext("gpt-5.6-luna"), tokens(usage(72356, 71168, 363), usage(72356, 71168, 363), "2026-10-29T06:53:33.695Z"),
    tokens(usage(84497, 72576, 673), usage(156853, 143744, 1036), "2026-10-29T06:53:44.531Z"), tokens(usage(84497, 72576, 673), usage(156853, 143744, 1036), "2026-10-29T06:53:45.000Z")]);
  r = c.readRollout(childFile);
  assert.equal(r.source, "subagent");
  assert.deepEqual(r.tokens, { input: 156853 - 143744, cacheRead: 143744, cacheWrite: 0, output: 1036 });
});

test("Codex discovery separates processes and rollout cwds in case-distinct Linux checkouts", { skip: process.platform !== "linux" }, () => {
  const processes = ["Repo", "repo"].map((name, index) => {
    const cwd = path.join(home, name, "..notes"), pid = 101 + index;
    fs.mkdirSync(cwd, { recursive: true });
    const thread = "01a177b8-1536-79a0-8e24-9548b05a9" + pid;
    write(rolloutPath(thread), [meta(thread, cwd)]);
    return { pid, cwd, startTicks: String(pid), rollouts: [rolloutPath(thread)], thread };
  });
  for (const p of processes) {
    assert.deepEqual(c.liveCodexSessions(path.dirname(p.cwd), undefined, processes).map(s => [s.pid, s.sessionId]), [[p.pid, p.thread]]);
    assert.deepEqual(c.liveCodexSessions(path.dirname(p.cwd), undefined, processes.filter(q => q !== p)), []);
  }
});

test("found Codex sessions require a CLI rollout matching the process cwd and thread", () => {
  const cwd = path.join(home, "identity"), repo = cwd;
  const thread = "01a177c0-e164-7030-9798-eb04f5926ebd", file = rolloutPath(thread);
  const p = { pid: 11, cwd, startTicks: "123", rollouts: [file] };
  const find = () => c.liveCodexSessions(repo, "Codex · r@x", [p]);
  for (const record of [meta(thread, cwd, "exec"), meta(thread, cwd + "2"), meta("different-thread", cwd)]) {
    write(file, [record]); assert.deepEqual(find(), []); fs.unlinkSync(file);
  }
  write(file, [meta(thread, cwd), ev("task_started", { turn_id: "t" }), user("hello")]);
  assert.deepEqual(find(), [{ pid: 11, processStart: "123", sessionId: thread, cwd, configDir: home,
    account: "Codex · r@x", provider: "codex", cardStatus: "running", transcript: file }]);
  append(file, [ev("task_complete", { turn_id: "t", last_agent_message: "OK" })]);
  assert.equal(find()[0]?.cardStatus, "review");
  assert.deepEqual(c.liveCodexSessions(repo, undefined, [{ ...p, startTicks: undefined }]), []);
  assert.deepEqual(c.liveCodexSessions(repo, undefined, [{ ...p, rollouts: [] }]), []);
  assert.deepEqual(c.liveCodexSessions(repo, undefined, [p, { pid: 12, cwd, startedAt: 1 }]), []);
  if (process.platform !== "linux") assert.deepEqual(c.codexProcesses(), []);
});

test("two Codex TUIs keep their threads under reversed scans and interleaved writes, and Stop verifies the current writer", { skip: process.platform !== "linux" }, (t) => {
  const repo = path.join(home, "owner-repo"), proc = path.join(home, "proc");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const threads = ["01900000-0000-7000-8000-000000000101", "01900000-0000-7000-8000-000000000102"];
  const files = threads.map(thread => rolloutPath(thread));
  const stat = (pid, ticks) => fs.writeFileSync(path.join(proc, String(pid), "stat"), `${pid} (codex) S ${"0 ".repeat(18)}${ticks} 0\n`);
  const descriptor = (pid, fd, file, flags = "0100001") => {
    const dir = path.join(proc, String(pid)), link = path.join(dir, "fd", fd);
    fs.rmSync(link, { force: true });
    fs.symlinkSync(file, link);
    fs.writeFileSync(path.join(dir, "fdinfo", fd), `flags:\t${flags}\nino:\t${fs.statSync(file, { bigint: true }).ino}\n`);
  };
  for (const [i, thread] of threads.entries()) {
    const pid = 101 + i, dir = path.join(proc, String(pid));
    fs.mkdirSync(path.join(dir, "fd"), { recursive: true });
    fs.mkdirSync(path.join(dir, "fdinfo"));
    fs.symlinkSync(repo, path.join(dir, "cwd"));
    fs.writeFileSync(path.join(dir, "comm"), "codex\n");
    fs.writeFileSync(path.join(dir, "cmdline"), "codex\0");
    stat(pid, pid);
    write(files[i], [meta(thread, repo), user("prompt " + pid)]);
    descriptor(pid, "3", files[i]);
  }
  // Drive the board through discovery and Stop. Only process enumeration, Claude sessions, VS Code and the signal are fixtures.
  let reverse = false;
  const discover = c.liveCodexSessions;
  t.mock.method(c, "liveCodexSessions", (repo, account, _, unresolved) => {
    const ps = c.codexProcesses(repo, proc);
    return discover(repo, account, reverse ? ps.reverse() : ps, unresolved);
  });
  const stopWriter = c.stopCodexWriter;
  t.mock.method(c, "stopCodexWriter", live => stopWriter(live, proc));
  t.mock.method(require("../out/sessions.js"), "liveSessions", () => []);
  const warnings = [], signals = [];
  const Module = require("node:module"), load = Module._load;
  const vscode = { EventEmitter: class { event() { return { dispose() {} }; } fire() {} dispose() {} },
    window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: message => warnings.push(message) } };
  const stub = t.mock.method(Module, "_load", function (name, ...args) { return name === "vscode" ? vscode : load.call(this, name, ...args); });
  const { Board } = require("../out/board.js");
  stub.mock.restore();
  const board = new Board(repo, path.join(repo, "hook.js"), path.join(repo, "hooks"), false);
  t.after(() => board.dispose());
  assert.ok(board.isOwner(true));
  const numericSignals = [];
  t.mock.method(process, "kill", (pid, signal) => numericSignals.push([pid, signal]));
  const child = require("node:child_process"), spawn = child.spawnSync;
  let beforeHelper = () => {}, helperAvailable = true;
  t.mock.method(child, "spawnSync", (file, args, opts) => {
    if (file !== "/usr/bin/python3") return spawn(file, args, opts);
    beforeHelper();
    if (!helperAvailable) return { status: null, error: new Error("missing Python") };
    // Exercise the shipped Python checks against the inherited directory FD. Replace only the kernel signal with a recorder.
    const record = 'import os, signal\nsignal.pidfd_send_signal = lambda fd, sig: print(os.readlink("/proc/self/fd/" + str(fd)), sig.name)\n';
    const result = spawn(file, [...args.slice(0, 3), record + args[3], ...args.slice(4)],
      { ...opts, stdio: ["ignore", "pipe", "pipe", opts.stdio[3]], encoding: "utf8" });
    if (result.stdout?.trim()) {
      const match = /\/(\d+) (SIGTERM)$/.exec(result.stdout.trim());
      assert.ok(match, result.stdout);
      signals.push([Number(match[1]), match[2]]);
    }
    return result;
  });
  const b = { id: "b", provider: "codex", sessionId: threads[1], status: "running" };
  // Both processes only reading rollouts: no prompt is imported, and no target is signalled.
  for (const [i, file] of files.entries()) descriptor(101 + i, "3", file, "0100000");
  board.discover();
  board.stop(b);
  assert.deepEqual(board.tasks, []);
  assert.deepEqual(signals, []);
  assert.ok(warnings.some(m => m.includes(repo) && m.includes("Stop")));
  for (const [i, file] of files.entries()) descriptor(101 + i, "3", file);
  for (const i of [1, 0, 1]) {
    reverse = !reverse;
    append(files[i], [ev("task_started", { turn_id: "turn" + i })]);
    board.discover();
    assert.deepEqual([...board.external.values()].map(s => [s.pid, s.sessionId]), [[101, threads[0]], [102, threads[1]]]);
    assert.deepEqual(board.tasks.map(task => [task.sessionId, task.prompt]), [[threads[0], "prompt 101"], [threads[1], "prompt 102"]]);
    board.stop(board.tasks.find(task => task.sessionId === b.sessionId));
    assert.deepEqual(signals.splice(0), [[102, "SIGTERM"]]);
  }
  // Recycle the numeric path after JS verified its writer and opened its process handle. FD 3 still names the old directory.
  const numeric = path.join(proc, "102"), retired = path.join(proc, "retired");
  beforeHelper = () => { fs.renameSync(numeric, retired); fs.mkdirSync(numeric); };
  assert.equal(board.killSession(board.tasks[1]), false);
  assert.deepEqual(signals, []);
  fs.rmdirSync(numeric); fs.renameSync(retired, numeric);
  beforeHelper = () => stat(102, 999);
  assert.equal(board.killSession(board.tasks[1]), false);
  assert.deepEqual(signals, []);
  stat(102, 102);
  // A writer can also change threads between Node's verification and the helper's signal boundary.
  beforeHelper = () => descriptor(102, "3", files[0]);
  assert.equal(board.killSession(board.tasks[1]), false);
  assert.deepEqual(signals, []);
  beforeHelper = () => {};
  descriptor(102, "3", files[1]);
  helperAvailable = false;
  assert.equal(board.killSession(board.tasks[1]), false);
  assert.match(warnings.at(-1), /original terminal/);
  assert.deepEqual(signals, []);
  helperAvailable = true;
  // Cached ownership is insufficient: a reused PID, a competing writer, or a closed descriptor prevents Stop.
  stat(102, 999);
  board.stop(b);
  stat(102, 102);
  descriptor(101, "4", files[1]);
  board.stop(b);
  for (const task of board.tasks) task.updatedAt = new Date(0).toISOString();
  board.discover();
  assert.equal(board.external.size, 0);
  assert.ok(board.tasks.every(task => task.status !== "done"));
  reverse = !reverse;
  board.discover();
  board.stop(b);
  assert.deepEqual(signals, []);
  fs.unlinkSync(path.join(proc, "101", "fd", "4"));
  board.discover();
  fs.unlinkSync(path.join(proc, "102", "fd", "3"));
  board.stop(b);
  assert.deepEqual(signals, []);
  assert.deepEqual(numericSignals, []);
  // A board-owned Codex terminal still stops through its managed handle while external ownership is unavailable.
  let disposed = 0;
  t.mock.method(board, "terminal", () => ({ dispose: () => disposed++ }));
  board.stop(b);
  assert.equal(disposed, 1);
  assert.deepEqual(signals, []);
});

test("discovery reads the account and every visible model through the app-server, ignoring server-initiated messages", async () => withFake(async () => {
  await c.discoverCodex();
  assert.deepEqual(c.codexStatus(), { loggedIn: true, email: "user@example.test", plan: "pro", models: [
    { model: "gpt-a", efforts: ["medium", "ultra"], defaultEffort: "medium", isDefault: true }, // model/list marks Codex's default (17 November 2026)
    { model: "gpt-b", efforts: ["low", "high"], defaultEffort: "low" },
  ] });
  assert.deepEqual(c.codexAccounts(), [{ name: "Codex · user@example.test", configDir: "", provider: "codex" }]);
  assert.equal(c.codexEffortOk("gpt-a", "ultra"), true);
  assert.equal(c.codexDefaultModel(), "gpt-a", "a card on Default model runs this id");
  assert.equal(c.codexEffortOk("gpt-b", "ultra"), false);
  assert.equal(c.codexEffortOk(undefined, "high"), true);
  const usage = await c.codexUsage();
  assert.deepEqual(usage, { at: usage.at, source: "query", windows: [{ minutes: 300, pct: 12, resets: 1793000000 }, { minutes: 10080, pct: 40, resets: 1793600000 }] });
  process.env.FAKE_CODEX_FAIL = "1"; // a scan that fails keeps the last good answer, plus its error
  try { await c.discoverCodex(); } finally { delete process.env.FAKE_CODEX_FAIL; }
  assert.equal(c.codexStatus().loggedIn, true);
  assert.match(c.codexStatus().error, /unknown method account\/read/);
  assert.equal(c.codexAccounts().length, 1);
}));

test("discovery: signed out lists no account; a missing CLI lists no Codex at all", async () => {
  process.env.FAKE_CODEX_LOGGED_OUT = "1";
  try {
    await withFake(() => c.discoverCodex());
    assert.deepEqual(c.codexStatus(), { loggedIn: false, models: [] });
    assert.deepEqual(c.codexAccounts(), []);
  } finally { delete process.env.FAKE_CODEX_LOGGED_OUT; }
  c.setCodexBinary(path.join(os.tmpdir(), "no-such-codex-binary"));
  await c.discoverCodex();
  assert.equal(c.codexStatus(), undefined);
});

test("an app-server call can be cancelled, times out, and reports a refused request", () => withFake(async (fake) => {
  const controller = new AbortController();
  const pending = c.appServer(() => new Promise(() => {}), { file: fake, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /Cancelled/);
  await assert.rejects(c.appServer(() => new Promise(() => {}), { file: fake, timeoutMs: 200 }), /did not answer in time/);
  await assert.rejects(c.appServer((request) => request("no/such/method"), { file: fake }), /unknown method/);
}));

test("hook.js records a Codex hook event from stdin with its thread id and rollout path, as it does Claude's", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-hook-"));
  try {
    const events = path.join(dir, "events.jsonl");
    const hook = path.join(__dirname, "..", "hook", "hook.js");
    // The payload as codex-cli 0.163 sent it on 26 Oct 2026 (tool_input is dropped: only small fields are kept; since F70 a short desc of the call stays).
    const env = { ...process.env, ENTOMATICAL_RUNTIME: "codex", ENTOMATICAL_EVENTS: events, ENTOMATICAL_TERMINAL_LAUNCH: "" };
    execFileSync(process.execPath, [hook], { env, input: JSON.stringify({ session_id: "01a177c0-e164-7030-9798-eb04f5926ebd", turn_id: "01a177c1-9212-7103-b3ef-d11666d85bcc",
      transcript_path: "/home/r/.codex/sessions/2026/10/26/rollout-2026-10-26T03-28-11-01a177c0-e164-7030-9798-eb04f5926ebd.jsonl", cwd: "/w", hook_event_name: "PermissionRequest",
      model: "gpt-5.6-luna", permission_mode: "default", tool_name: "Bash", tool_input: { command: "touch approval-test2.txt", description: "May I?" } }) });
    execFileSync(process.execPath, [hook], { env, input: "not json" });
    const lines = fs.readFileSync(events, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => ({ ...l, t: 0 })), [{ t: 0, hook_event_name: "PermissionRequest", session_id: "01a177c0-e164-7030-9798-eb04f5926ebd", turn_id: "01a177c1-9212-7103-b3ef-d11666d85bcc", cwd: "/w",
      transcript_path: "/home/r/.codex/sessions/2026/10/26/rollout-2026-10-26T03-28-11-01a177c0-e164-7030-9798-eb04f5926ebd.jsonl", tool_name: "Bash", model: "gpt-5.6-luna", desc: "Bash touch approval-test2.txt", call: lines[0].call }, { t: 0 }]);
    assert.match(lines[0].call, /^[0-9a-f]{8}$/, "F91: a refusal's call id, never its input");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Codex's editor tab shows a thread's name when it has one, so the board sets it (thread/name/set; thread/name/update is refused by codex-cli 0.163).
test("nameCodexThread sets a thread's name through the app-server", async () => {
  const os = require("node:os");
  const names = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-names-")), "names.txt");
  process.env.FAKE_CODEX_NAMES = names;
  try {
    await withFake((file) => c.nameCodexThread("thread-7", "Fix the login bug", { file }));
    assert.equal(fs.readFileSync(names, "utf8"), "thread-7\tFix the login bug\n");
  } finally { delete process.env.FAKE_CODEX_NAMES; fs.rmSync(path.dirname(names), { recursive: true, force: true }); }
});

// rpcClient is the JSON-RPC side of appServer and of a Codex task's first turn (board.ts runFirstCodexTurn).
test("rpcClient answers requests, passes notifications on, refuses the server's own requests, and fails what is pending on close", async () => {
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
  let written = "";
  child.stdin.on("data", (d) => { written += d; });
  const seen = [];
  const rpc = c.rpcClient(child, (method, params) => seen.push([method, params]), true);
  const answer = rpc.request("thread/start", { cwd: "/w" });
  const refused = rpc.request("no/such/method");
  rpc.notify("initialized");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(written.trim().split("\n").map((l) => JSON.parse(l)), [
    { id: 1, method: "thread/start", params: { cwd: "/w" } }, { id: 2, method: "no/such/method", params: {} }, { method: "initialized" }]);
  written = "";
  child.stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } }) + "\n");
  child.stdout.write(JSON.stringify({ id: 7, method: "item/commandExecution/requestApproval", params: { command: "rm -rf" } }) + "\n"); // the server asks
  child.stdout.write("not json\n" + JSON.stringify({ id: 1, result: { thread: { id: "t" } } }) + "\n" + JSON.stringify({ id: 2, error: { message: "unknown method" } }) + "\n");
  assert.deepEqual(await answer, { thread: { id: "t" } });
  await assert.rejects(refused, /unknown method/);
  assert.deepEqual(seen, [["turn/completed", { turn: { status: "completed" } }]]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(JSON.parse(written.trim()), { id: 7, error: { code: -32601, message: "Nobody is attending this session." } }); // refused, not left hanging
  const pending = rpc.request("thread/read");
  rpc.close(new Error("Codex closed."));
  await assert.rejects(pending, /Codex closed/);
});

// Review of task/exactids, 17 November 2026: with no -m Codex runs its config's `model`, so a Default-model card is handed that one.
test("codexConfigModel reads the model Codex's effective config sets; none set, or no config/read, gives undefined", async () => withFake(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-codex-config-")), config = path.join(dir, "config.json");
  try {
    fs.writeFileSync(config, JSON.stringify({ model: "gpt-6.1-sol", model_reasoning_effort: "high" }));
    process.env.FAKE_CODEX_CONFIG = config;
    assert.equal(await c.codexConfigModel(dir), "gpt-6.1-sol");
    fs.writeFileSync(config, JSON.stringify({ projects: {} }));
    assert.equal(await c.codexConfigModel(dir), undefined, "no model set: model/list's default applies");
    delete process.env.FAKE_CODEX_CONFIG;
    assert.equal(await c.codexConfigModel(dir), undefined, "a Codex without config/read cannot say");
  } finally { delete process.env.FAKE_CODEX_CONFIG; fs.rmSync(dir, { recursive: true, force: true }); }
}));
