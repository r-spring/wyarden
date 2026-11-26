const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const modes = { Production: 1, Development: 2, Test: 3 };
const routes = {
  selftest: "selfTest", "selftest-panel": "panelTest", "selftest-codex": "codexSelfTest", "selftest-finish": "finishTest",
};
const names = Object.keys(routes);
const noop = () => {};
const uri = (fsPath) => ({ scheme: "file", fsPath });

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "selftest-activation-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scratch = path.join(root, "fixture"), repo = path.join(scratch, "repo"), dir = path.join(repo, ".entomatical");
  const origin = path.join(scratch, "origin.git"), workspace = path.join(scratch, "fixture.code-workspace");
  const tempMarker = path.join(root, "ENTOMATICAL-TEMP-ROOT");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tempMarker, "");
  fs.writeFileSync(workspace, JSON.stringify({ folders: [{ path: "repo" }] }));
  const g = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, "no-global-config"), GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
  g(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "fixture\n");
  g(repo, "add", "a.txt");
  g(repo, "commit", "-qm", "fixture");
  g(scratch, "init", "-q", "--bare", "-b", "main", origin);
  g(repo, "remote", "add", "origin", origin);
  g(repo, "push", "-qu", "origin", "main");
  const head = g(repo, "rev-parse", "HEAD");
  function arm(markers = names, change = {}, checkout = repo) {
    for (const name of markers) {
      fs.writeFileSync(path.join(checkout, ".entomatical", name), JSON.stringify({ test: name, repo: checkout, head, armedAt: Date.now(), account: "fixture-account", ...change }));
    }
  }
  const read = (markers = names, data = dir) => markers.map((name) => fs.readFileSync(path.join(data, name), "utf8"));
  return { root, scratch, repo, dir, workspace, origin, tempMarker, g, arm, read, head };
}

// Load the emitted activation and its real fixture gate. Replace all native routines before activation and allow only
// read-only Git from the gate. All ordinary startup hooks are inert in this host.
function host(f, options = {}) {
  const calls = [], pending = [], probes = [], gitCalls = [], effects = [], errors = [];
  const registered = new Set(), configListeners = new Set();
  let board;
  const maybeProbe = (f) => { if (names.includes(path.basename(f))) probes.push(f); };
  const markerFs = { ...fs };
  for (const name of ["lstatSync", "existsSync", "readFileSync", "unlinkSync"]) {
    markerFs[name] = (file, ...args) => { maybeProbe(file); return fs[name](file, ...args); };
  }
  const disposable = { dispose: noop };
  const conf = {
    get: (key, fallback) => key === "commandsToSkipShell" ? ["entomatical.dictateTerminal"] : options.settings?.[key] ?? fallback,
    update: (...args) => effects.push(["settings", ...args]),
  };
  const vscode = {
    ExtensionMode: modes, Uri: { file: uri }, StatusBarAlignment: { Left: 1 }, RelativePattern: class {},
    commands: { registerCommand: (id) => { registered.add(id); return disposable; }, executeCommand: (...args) => effects.push(["command", ...args]) },
    workspace: {
      workspaceFile: uri(f.workspace), workspaceFolders: [{ uri: uri(f.repo) }], getConfiguration: () => conf,
      onDidChangeConfiguration: (cb) => { configListeners.add(cb); return { dispose: () => configListeners.delete(cb) }; },
      createFileSystemWatcher: () => ({ ...disposable, onDidCreate: noop, onDidChange: noop, onDidDelete: noop }),
    },
    window: {
      showWarningMessage: (m) => errors.push(m), showErrorMessage: (m) => errors.push(m),
      onDidOpenTerminal: () => disposable,
      createOutputChannel: () => disposable, createStatusBarItem: () => ({ ...disposable, show: noop }),
      registerWebviewViewProvider: noop, registerWebviewPanelSerializer: noop,
    },
  };
  const scopedGit = { git: async (cwd, args) => {
    gitCalls.push([cwd, args]);
    if (options.git) return options.git(cwd, args);
    assert.ok([f.repo, f.origin].includes(cwd));
    assert.ok(["rev-parse", "symbolic-ref", "config", "remote"].includes(args[0]));
    if (args[0] === "config") assert.equal(args[1], "--get");
    if (args[0] === "remote") assert.equal(args[1], "get-url");
    return f.g(cwd, ...args);
  } };
  const stubs = {
    vscode, fs: markerFs, os: { ...os, homedir: () => path.join(f.root, "home") },
    "./board": { accounts: () => options.accounts ?? [], Board: class {
      constructor(repo) {
        board = options.board ?? this;
        if (options.board) return board;
        this.repo = repo; this.dir = f.dir; this.tasks = []; this.checks = {};
      }
      begin() {}
      announceTakeoverAsks() {}
      onRun() { return disposable; }
      onChange() { return disposable; }
      onStatus() { return disposable; }
      add(...args) { effects.push(["card", ...args]); }
    } },
    "./git": scopedGit,
    "./workspace": {
      TEMP_MARKER: "ENTOMATICAL-TEMP-ROOT", unmovedDataFolder: noop, setWorkspaceRepo: noop,
      checkWorkspace: () => ({ repo: f.repo, missing: [] }),
    },
    "./accounts": { initAccounts: noop, onAccountsChanged: noop, accountRows: () => [], externalProviderAccounts: () => [], activeConfigDir: () => "" },
    "./queue": require("../out/queue.js"),
    "./action-picks": { readPicks: noop },
    "./asana-board": { registerAsana: noop },
    "./codex": { codexChoice: () => ({ via: "wsl" }), findCodexWsl: () => ({}), useCodexWsl: noop, codexWsl: noop, placeCodexHook: noop },
    "./error-log": { logFile: () => path.join(f.dir, "unused.jsonl"), logInterrupted: noop, setSink: noop },
    "./headless-activity": { HeadlessActivity: class {} },
    "./ledger": { Ledger: class { start() {} whileOwned() {} } },
    "./model-sync": { restoreClaudeModels: noop },
    "./obsidian-board": { registerObsidian: noop },
    "./operator": { ensureOperatorToken: noop },
    "./profiles": { PROFILE_FILE: "profiles.json" },
    "./readonly-docs": { registerReadOnlyDocs: noop },
    "./reload-request": { watchReloadRequests: noop },
    "./speech-settings": { migrateSpeechSettings: noop, registerSpeechSettings: noop },
    "./startup": { quietStartup: noop },
  };
  function load(name) {
    const filename = require.resolve(`../out/${name}.js`), mod = new Module(filename, module);
    mod.filename = filename;
    mod.require = (id) => stubs[id] ?? (id.startsWith("./") ? {} : require(id));
    mod._compile(fs.readFileSync(filename, "utf8"), filename);
    return mod.exports;
  }
  const { runSelfTests, ...liveRoutines } = load("selftest");
  assert.ok(Object.values(routes).every((name) => name in liveRoutines));
  stubs["./selftest"] = { runSelfTests: (...args) => {
    const run = runSelfTests(...args);
    pending.push(run);
    return run;
  } };
  for (const [marker, method] of Object.entries(routes)) stubs["./selftest"][method] = async (board, ...args) => {
    calls.push([marker, board.repo, ...args]);
  };
  const extension = load("extension");
  const context = { subscriptions: [], globalState: { get: noop }, extensionPath: f.root };
  return {
    vscode, calls, probes, gitCalls, effects, errors, registered, finishTest: liveRoutines.finishTest,
    get board() { return board; },
    change(key) { for (const cb of configListeners) cb({ affectsConfiguration: (name) => name === key }); },
    async activate(extensionMode) {
      await extension.activate({ ...context, extensionMode });
      await Promise.all(pending.splice(0));
      assert.deepEqual(errors, []);
      assert.deepEqual(effects, []);
    },
  };
}

test("activation uses validated workflow and takeover defaults and accepts zero", async (t) => {
  const f = fixture(t);
  for (const [slots, minutes, expected] of [
    [undefined, undefined, [3, 1_800_000]], [-1, -1, [3, 1_800_000]], [1.5, "5", [3, 1_800_000]],
    [Infinity, NaN, [3, 1_800_000]], [0, 0, [0, 0]], [2, 0.5, [2, 30_000]],
  ]) {
    const h = host(f, { settings: { "workflow.localBudget": slots, "orchestrator.claimAfterMinutes": minutes } });
    await h.activate(modes.Test);
    assert.deepEqual([h.board.localBudget, h.board.claimGraceMs], expected);
  }
});

test("Settings refreshes preparation admission and idle-holder claims in the activated window", async (t) => {
  const f = fixture(t);
  t.mock.method(os, "homedir", () => path.join(f.root, "home"));
  const vscode = { EventEmitter: class {
    listeners = new Set();
    event = cb => { this.listeners.add(cb); return { dispose: () => this.listeners.delete(cb) }; };
    fire(value) { for (const cb of this.listeners) cb(value); }
    dispose() { this.listeners.clear(); }
  }, window: { terminals: [], onDidCloseTerminal: () => ({ dispose: noop }) } };
  const load = Module._load;
  const mock = t.mock.method(Module, "_load", function (id, ...args) { return id === "vscode" ? vscode : load.call(this, id, ...args); });
  const { Board } = require("../out/board.js");
  mock.mock.restore();
  const board = new Board(f.repo, path.join(f.dir, "hook.js"), f.dir, false);
  t.after(() => board.dispose());
  assert.ok(board.isOwner(true));
  board.begin = noop; // Keep the real gates, event emitter and fixture owner. Disable the live session poll.
  board.accountList = () => [];
  const settings = {}, h = host(f, { board, settings });
  await h.activate(modes.Test);

  const idle = new Date(Date.now() - 45 * 60_000).toISOString();
  const task = (id, extra) => ({ id, title: id, prompt: id, status: "review", createdAt: idle, updatedAt: idle, ...extra });
  const prep = id => task(id, { workflow: { resources: ["local"], outcome: "pending" } });
  const first = prep("first"), running = prep("running"), waiting = prep("waiting");
  const asker = task("aaaaaa", { orchestrator: { caps: {} }, approved: { at: idle }, sessionId: "fixture-asker" });
  const holder = task("bbbbbb", {}), target = task("cccccc", { openedBy: holder.id });
  board.tasks.push(first, running, waiting, asker, holder, target);
  const claim = () => board.refusalOf({ op: "claim", by: asker.id, session: asker.sessionId, id: target.id, reason: "fixture" });
  const { mark } = require("../out/workflow.js");
  board.gate(first);
  board.gate(running);
  mark(running, board.workflow, "running");
  mark(first, board.workflow, "ended"); // Only the higher numbered slot remains occupied.
  const claims = board.workflow.claims();
  assert.equal(claims.length, 1);
  assert.equal(board.readinessOf(waiting).state, "ready");
  assert.equal(claim(), undefined);
  const refreshes = [];
  board.onChange(() => refreshes.push([board.readinessOf(waiting).state, claim()]));
  settings["workflow.localBudget"] = 1;
  h.change("entomatical.quietStartup");
  assert.deepEqual(refreshes, []);
  assert.equal(board.readinessOf(waiting).state, "ready");

  h.change("entomatical.workflow.localBudget");
  assert.deepEqual(refreshes, [["resource", undefined]]);
  assert.throws(() => board.gate(waiting), /1 of 1 in use/);
  assert.throws(() => board.gate(first), /Waiting for a local session slot/);
  assert.deepEqual(board.workflow.claims(), claims);
  assert.equal(board.readinessOf(running).text, "Running");

  settings["orchestrator.claimAfterMinutes"] = 60;
  h.change("entomatical.orchestrator.claimAfterMinutes");
  assert.equal(refreshes.length, 2);
  assert.equal(refreshes[1][0], "resource");
  assert.match(refreshes[1][1], /controlled by bbbbbb.*request-takeover/);
  assert.equal(target.openedBy, holder.id);
  board.gate(running);
  assert.deepEqual(board.workflow.claims(), claims, "the running attempt continues in its original slot");
  mark(running, board.workflow, "ended");
  assert.equal(board.readinessOf(waiting).state, "ready");
  board.gate(waiting);
  assert.deepEqual(board.workflow.claims().map(c => c.task), [waiting.id]);
});

test("activation registers the commands contributed to the board context menu", async (t) => {
  const h = host(fixture(t));
  await h.activate(modes.Production);
  for (const { command } of require("../package.json").contributes.menus["webview/context"]) {
    assert.ok(h.registered.has(command), `Missing menu command ${command}`);
  }
});

test("Finish stops before creating a card when the explicitly named account is unavailable", async (t) => {
  const f = fixture(t);
  const h = host(f, { accounts: [{ name: "first", configDir: path.join(f.root, "first") }] });
  const board = { add: (...args) => h.effects.push(["card", ...args]) };
  await assert.rejects(h.finishTest(board, f.origin, "absent"), /account folder is unavailable: absent/);
  assert.deepEqual([h.effects, h.gitCalls], [[], []]);
});

test("Finish uses the first account when omitted and makes no fetch after a late origin refusal", async (t) => {
  const f = fixture(t), other = path.join(f.dir, "selftest-other-clone");
  const h = host(f, {
    accounts: [{ name: "first", configDir: path.join(f.root, "first") }],
    git: (cwd, args) => {
      assert.ok([f.repo, f.dir, f.origin, other].includes(cwd));
      assert.notEqual(args[0], "fetch");
      return f.g(cwd, ...args);
    },
  });
  const task = { id: "fixture-card", worktree: f.repo, status: "review" };
  let chosenAccount, completed = 0;
  const board = {
    repo: f.repo, dir: f.dir,
    add: (_title, _prompt, account) => { chosenAccount = account; return task; },
    start: async () => ({}), waitForEvent: async () => ({}), terminal: noop,
    complete: async (_task, confirm, _step, _close, _limits, helpers) => {
      completed++;
      assert.equal(await confirm({ target: "main", remote: "origin", remoteBranch: "main" }, []), true);
      f.g(f.repo, "remote", "set-url", "--push", "origin", "https://example.invalid/late.git");
      await helpers.beforePush(f.repo);
      assert.fail("Finish authorized a non-fixture push destination");
    },
  };
  await h.finishTest(board, f.origin, "");
  const steps = fs.readFileSync(path.join(f.dir, "selftest-finish-result.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(chosenAccount, "first");
  assert.equal(completed, 1);
  assert.match(steps.find((step) => step.step === "finished").error, /exactly one local fetch and push destination/);
  assert.equal(h.gitCalls.filter(([, args]) => args[0] === "fetch").length, 0);
  assert.deepEqual(h.gitCalls.filter(([, args]) => args[0] === "push").map(([cwd]) => cwd), [other]);
  assert.equal(f.g(f.repo, "rev-parse", "HEAD"), f.head);
});

for (const [label, mode] of [["Production", modes.Production], ["missing mode", undefined], ["unknown mode", 99]]) {
  test(`${label} activation never probes the four triggers`, async (t) => {
    const f = fixture(t), h = host(f);
    f.arm();
    const before = f.read();
    await h.activate(mode);
    assert.deepEqual([h.probes, h.gitCalls, h.calls], [[], [], []]);
    assert.deepEqual(f.read(), before);
  });
}

for (const [label, mode] of [["Development", modes.Development], ["Test", modes.Test]]) {
  test(`${label} dispatches each exact fixture trigger once`, async (t) => {
    const f = fixture(t), h = host(f);
    f.arm();
    if (mode === modes.Test) f.arm(["selftest-finish"], { account: undefined });
    await h.activate(mode);
    assert.deepEqual(h.calls, [
      ["selftest", f.repo], ["selftest-panel", f.repo], ["selftest-codex", f.repo],
      ["selftest-finish", f.repo, f.origin, mode === modes.Test ? "" : "fixture-account"],
    ]);
    for (const name of names) assert.equal(fs.existsSync(path.join(f.dir, name)), false);
    await h.activate(mode);
    assert.equal(h.calls.length, 4);
    assert.equal(f.g(f.origin, "rev-parse", "main"), f.head);
  });
}

for (const [label, change] of [
  ["outside marked scratch", (f) => fs.unlinkSync(f.tempMarker)],
  ["different workspace file", (f, h) => {
    const second = path.join(f.scratch, "other.code-workspace");
    fs.copyFileSync(f.workspace, second);
    h.vscode.workspace.workspaceFile = uri(second);
  }],
  ["multiple workspace folders", (f, h) => h.vscode.workspace.workspaceFolders.push({ uri: uri(f.scratch) })],
  ["different checkout in the editor", (f, h) => { h.vscode.workspace.workspaceFolders[0].uri = uri(f.scratch); }],
  ["different Git top level", (f) => f.g(f.repo, "config", "core.worktree", f.scratch)],
  ["legacy marker contents", (f) => names.forEach((name) => fs.writeFileSync(path.join(f.dir, name), ""))],
  ["marker for another checkout", (f) => f.arm(names, { repo: path.join(f.root, "elsewhere") })],
  ["marker for another revision", (f) => f.g(f.repo, "commit", "--allow-empty", "-qm", "new HEAD")],
  ["marker for another route", (f) => f.arm(names, { test: "something-else" })],
  ["expired markers on the exact checkout", (f) => f.arm(names, { armedAt: Date.now() - 16 * 60_000 })],
]) {
  test(`Development preserves all triggers with ${label}`, async (t) => {
    const f = fixture(t), h = host(f);
    f.arm();
    change(f, h);
    const before = f.read();
    const head = f.g(f.repo, "rev-parse", "HEAD");
    await h.activate(modes.Development);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(f.read(), before);
    assert.equal(f.g(f.repo, "rev-parse", "HEAD"), head);
    assert.equal(f.g(f.origin, "rev-parse", "main"), f.head);
  });
}

test("Development leaves an explicitly armed linked worktree and its main checkout intact", async (t) => {
  const f = fixture(t);
  const scratch = path.join(f.root, "linked"), repo = path.join(scratch, "repo"), dir = path.join(repo, ".entomatical");
  const workspace = path.join(scratch, "fixture.code-workspace");
  fs.mkdirSync(scratch);
  f.g(f.repo, "worktree", "add", "-qb", "fixture-linked", repo);
  fs.copyFileSync(f.workspace, workspace);
  fs.mkdirSync(dir);
  f.arm();
  f.arm(names, {}, repo);
  const before = f.read(names, dir), main = f.read();
  const h = host({ ...f, repo, dir, workspace });
  await h.activate(modes.Development);
  assert.deepEqual([h.probes, h.gitCalls, h.calls], [[], [], []]);
  assert.deepEqual(f.read(names, dir), before);
  assert.deepEqual(f.read(), main);
  assert.equal(f.g(repo, "symbolic-ref", "HEAD"), "refs/heads/fixture-linked");
  assert.equal(f.g(repo, "rev-parse", "HEAD"), f.head);
  assert.equal(f.g(f.repo, "rev-parse", "HEAD"), f.head);
});

const finishOnly = ["selftest-finish"];
for (const [label, change] of [
  ["missing origin", (f) => f.g(f.repo, "remote", "remove", "origin")],
  ["non-local origin", (f) => f.g(f.repo, "remote", "set-url", "origin", "https://example.invalid/fixture.git")],
  ["bare origin outside the fixture", (f) => {
    const other = path.join(f.root, "other.git");
    f.g(f.root, "clone", "-q", "--bare", f.origin, other);
    f.g(f.repo, "remote", "set-url", "origin", other);
  }],
  ["external push URL", (f) => f.g(f.repo, "remote", "set-url", "--push", "origin", "https://example.invalid/fixture.git")],
  ["rewritten URL", (f) => f.g(f.repo, "config", "url.https://example.invalid/fixture.git.insteadOf", f.origin)],
  ["multiple origin URLs", (f) => f.g(f.repo, "remote", "set-url", "--add", "origin", f.origin)],
  ["wrong tracked branch", (f) => f.g(f.repo, "config", "branch.main.merge", "refs/heads/other")],
  ["non-bare sibling origin", (f) => f.g(f.origin, "config", "core.bare", "false")],
  ["bare origin missing main", (f) => f.g(f.origin, "update-ref", "-d", "refs/heads/main")],
  ["bare origin sharing Git storage outside the fixture", (f) => {
    const other = path.join(f.root, "other.git");
    f.g(f.root, "clone", "-q", "--bare", f.origin, other);
    fs.writeFileSync(path.join(f.origin, "commondir"), `${other}\n`);
    assert.equal(fs.realpathSync.native(f.g(f.origin, "rev-parse", "--git-common-dir")), other);
  }],
]) {
  test(`Finish refuses ${label} before dispatch and preserves the trigger`, async (t) => {
    const f = fixture(t), h = host(f);
    f.arm(finishOnly);
    change(f);
    const before = f.read(finishOnly);
    const mainAtOrigin = () => f.g(f.scratch, `--git-dir=${f.origin}`, "for-each-ref", "--format=%(objectname)", "refs/heads/main");
    const remoteHead = mainAtOrigin();
    await h.activate(modes.Development);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(f.read(finishOnly), before);
    assert.equal(f.g(f.repo, "rev-parse", "HEAD"), f.head);
    // Read the bare fixture directly, including the cases that changed core.bare or removed main.
    assert.equal(mainAtOrigin(), remoteHead);
  });
}
