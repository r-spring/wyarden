// F92 (17 November 2026): a start refused because no exact model id can be found changes nothing on the card. The Windows live check
// (docs/evidence/parity-win-2026-11-17/exact-ids-all-providers.md, check 5b) saw a Codex card and an Antigravity card each get a
// worktree and branch before the refusal. Each start path is checked here: the model is resolved before the worktree exists, and a
// refusal that can only come later (a Codex config read in the new worktree, an unattended ACP session with no catalog yet) removes the
// worktree and branch that start made (an unstarted parent's too), never one that existed. No CLI runs here.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { execFileSync, spawn } = require("node:child_process");
require("./safe-temp").assertSafeTemp();
const until = async (fn, timeout = 30000) => {
  const end = Date.now() + timeout;
  while (!fn() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fn(), "state did not settle");
};

class VSCodeEvent {
  listeners = [];
  event = (l) => (this.listeners.push(l), { dispose() {} });
  fire(e) { for (const l of this.listeners) l(e); }
  dispose() {}
}
const vscode = { EventEmitter: VSCodeEvent, ThemeIcon: class {}, commands: { executeCommand: async () => {} }, workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined, showInformationMessage: async () => undefined,
    createTerminal: () => ({ show() {}, dispose() {}, sendText() {} }) } };
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board } = require("../out/board.js");
const { AcpSession } = require("../out/acp.js");
const { DEFAULT_CAPS } = require("../out/orchestrator.js");

function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-refused-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"); // worktree add works
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  board.accountList = () => [{ name: "acct", configDir: "" }, { name: "Codex · t@t", provider: "codex" },
    { name: "Grok · Work", provider: "grok", configDir: path.join(repo, "grok") }, { name: "Antigravity · Shared", provider: "antigravity", configDir: "" }];
  board.accountFolderList = () => [];
  board.preflightHeadless = async () => {};
  board.discoverCodexModels = async () => {};
  board.discoverAgy = async () => {};
  board.ensureCodexTrust = async () => {};
  board.requestRateMs = 0;
  board.tick(); // this window owns the board
  t.after(() => { board.dispose(); fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const branches = () => git("branch", "--format=%(refname:short)", "--list", "task/*").trim();
  const worktrees = () => git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;
  /** Starts the card, expects the refusal, and checks nothing changed: the card, its parent, worktrees, branches and events. */
  const state = (card) => JSON.stringify({ ...card, updatedAt: undefined }); // the save time may move; nothing else does
  const refused = async (card, start, message, parent) => {
    const before = state(card), parentBefore = parent && state(parent), lists = [branches(), worktrees()];
    await assert.rejects(start(), message);
    assert.equal(state(board.get(card.id)), before, "the card is as it was");
    if (parent) assert.equal(state(board.get(parent.id)), parentBefore, "the parent is as it was");
    assert.deepEqual([branches(), worktrees()], lists, "no worktree or branch is left");
    assert.equal(card.sessionId, undefined);
    assert.equal(card.worktree, undefined);
    assert.equal(board.events(card.id).length, 0, "no event was recorded");
    assert.ok(!fs.existsSync(path.join(repo, ".entomatical", "wt", card.id)), "no worktree folder is left");
  };
  return { repo, board, git, branches, worktrees, refused };
}

test("Codex terminal and headless starts: the model is refused before the worktree; a refusal in the new worktree removes it", async (t) => {
  const { board, git, branches, refused } = fixture(t);
  let ids = ["gpt-6.2-sol"];
  board.codexModelIds = () => ids;
  board.codexDefaultId = () => undefined;
  const sol = board.add("Sol", "Go", "Codex · t@t", undefined, "sol");
  const headless = board.add("Headless sol", "Go", "Codex · t@t", undefined, "sol", undefined, undefined, { headless: true });
  ids = []; // a start right after a window reload, and Codex's list could not be read again
  const unlisted = /This Codex card names sol, and Codex has not listed its models yet, so its exact id is unknown\./;
  await refused(sol, () => board.start(sol), unlisted);
  await refused(headless, () => board.startHeadless(headless), unlisted);

  // Default model: the repo's config names a model, the new worktree's names none and Codex marks no default, so the refusal comes
  // only once the worktree exists. That worktree and its branch, made by this start, are removed again.
  ids = ["gpt-6.2-sol"];
  const asked = [];
  board.codexConfiguredModel = async (cwd) => { asked.push(cwd); return cwd === board.repo ? "gpt-6.2-sol" : undefined; };
  const noDefault = /This Codex card uses Codex's default model, and Codex has not said which model that is/;
  const plain = board.add("Plain", "Go", "Codex · t@t");
  await refused(plain, () => board.start(plain), noDefault);
  assert.deepEqual(asked, [board.repo, path.join(board.repo, ".entomatical", "wt", plain.id)], "refused only once its worktree existed");
  const plainHeadless = board.add("Plain headless", "Go", "Codex · t@t", undefined, undefined, undefined, undefined, { headless: true });
  await refused(plainHeadless, () => board.startHeadless(plainHeadless), noDefault);

  // Windows still holds the new folder when it is removed: the branch is gone, so the card does not point at the folder, and the
  // refusal is still what the start says.
  const held = board.add("Held", "Go", "Codex · t@t");
  const rm = fs.promises.rm;
  fs.promises.rm = async (p, ...rest) => { if (String(p).endsWith(held.id)) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); return rm(p, ...rest); };
  try { await assert.rejects(board.start(held), noDefault); } finally { fs.promises.rm = rm; }
  assert.deepEqual([held.worktree, held.branch, branches()], [undefined, undefined, ""], "no branch, and the card records no worktree");

  // A branch that existed before the start (an earlier version made it and could not record it) is the card's work: never removed.
  const kept = board.add("Kept", "Go", "Codex · t@t");
  git("branch", `task/${kept.id}`);
  await assert.rejects(board.start(kept), noDefault);
  assert.match(branches(), new RegExp(`task/${kept.id}`), "a branch this start did not make is kept");
});

test("Grok and Antigravity card terminals: no exact id refuses before the worktree", async (t) => {
  const { board, refused } = fixture(t);
  board.cardTerminals.spawn = () => assert.fail("nothing is spawned");
  board.grokModels = async () => ({ ids: [] });
  const grok = board.add("Grok", "Look.", "Grok · Work");
  await refused(grok, () => board.startCardTerminal(grok), /This Grok card uses Grok's default model, and `grok models` did not say which model that is\./);
  board.agyModelIds = () => ["claude-opus-5-5"];
  const argon = board.add("Argon", "Look.", "Antigravity · Shared", undefined, "argon", "low");
  await refused(argon, () => board.startCardTerminal(argon), /This Antigravity sign-in lists no Argon model\. It lists: claude-opus-5-5\./);
  board.agyModelIds = () => [];
  await refused(argon, () => board.startCardTerminal(argon), /Antigravity has not listed its models \(agy models\)/);
  // A subtask's start would make its unstarted parent's worktree too: refused first, so neither is made.
  const parent = board.add("Parent", "Plan.", "acct");
  const child = board.add("Child", "Look.", "Grok · Work", parent.id);
  await refused(child, () => board.startCardTerminal(child), /did not say which model that is/, parent);
});

function fakeAcp(t, board, optionsFor) {
  t.mock.method(require("../out/acp.js"), "acpCommand", () => ({ file: process.execPath, args: [], env: {} }));
  const exits = [], cwds = [];
  board.runAcp = (provider, cwd, profile, update, permission) => {
    cwds.push(cwd);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 2 ** 30 });
    let buffer = "";
    const send = (x) => child.stdout.write(JSON.stringify(x) + "\n");
    child.stdin.on("data", (data) => {
      buffer += data;
      while (buffer.includes("\n")) {
        const n = buffer.indexOf("\n"), m = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
        if (!m.method || m.id === undefined) continue;
        assert.notEqual(m.method, "session/prompt", "no prompt is sent");
        const result = m.method === "initialize" ? { protocolVersion: 1, agentCapabilities: {} } : m.method === "session/new" ? { sessionId: "s1", configOptions: optionsFor(cwd) } : {};
        queueMicrotask(() => send({ jsonrpc: "2.0", id: m.id, result }));
      }
    });
    // The agent lets go of its folder a moment after it is killed, as on Windows: the worktree must still be there when it exits.
    let killed = false; // killTree and session.close both kill it
    child.kill = () => { if (!killed) setTimeout(() => { exits.push(fs.existsSync(cwd)); child.emit("exit", 0); }, 300); killed = true; return true; };
    return new AcpSession(child, update, permission);
  };
  return { exits, cwds };
}

test("switching accounts during a cold probe discards the old launch before it publishes models or allocates a worktree", async (t) => {
  const { board, branches, worktrees } = fixture(t);
  const card = board.add("Worker", "Work.", "Grok · Work", undefined, undefined, undefined, undefined, { headless: true });
  const offered = { value: "grok-4.3", name: "Grok 4.3" };
  const { cwds, exits } = fakeAcp(t, board, () => [{ id: "model", name: "Model", category: "model", type: "select", currentValue: offered.value, options: [offered] }]);
  const run = board.runAcp;
  const opened = Promise.withResolvers(), release = Promise.withResolvers();
  board.runAcp = (...args) => {
    assert.equal(args[0], "grok", "the superseded launch must not start the new provider");
    const session = run(...args);
    const open = session.open.bind(session);
    session.open = async (cwd) => { const id = await open(cwd); opened.resolve(); await release.promise; return id; };
    return session;
  };
  const starting = board.startHeadless(card);
  await opened.promise;
  try { board.switchAccount(card, "Antigravity · Shared"); } finally { release.resolve(); }
  await assert.rejects(starting, /changed while preparing the launch/);
  assert.equal(board.acpCatalog(board.resolveAccount("antigravity")), undefined);
  assert.equal(fs.existsSync(path.join(board.dir, "acp-catalog.json")), false);
  assert.deepEqual([cwds, exits], [[board.cardTemp(card)], [true]]);
  assert.deepEqual([card.account, card.status, card.sessionId, card.worktree], ["Antigravity · Shared", "queued", undefined, undefined]);
  assert.deepEqual([branches(), worktrees(), board.events(card.id).length], ["", 1, 0]);
});

test("switching accounts as a missing-runner probe closes supersedes its error and preserves the named default", async (t) => {
  const { board, repo, branches, worktrees } = fixture(t);
  const card = board.add("Worker", "Work.", "Antigravity · Shared", undefined, undefined, undefined, undefined, { headless: true });
  const model = { value: "gemini-4-neon", name: "Gemini 4 Neon" };
  board.rememberAcpOptions(card, [{ id: "model", category: "model", name: "Model", currentValue: model.value, values: [model] }], "session/new");
  const catalog = path.join(board.dir, "acp-catalog.json"), saved = fs.readFileSync(catalog, "utf8");
  const missing = path.join(repo, "missing", "agy");
  t.mock.method(require("../out/acp.js"), "acpCommand", () => ({ file: missing, args: ["acp"], env: {} }));
  const cwds = [];
  board.runAcp = (provider, cwd) => {
    assert.equal(provider, "antigravity");
    cwds.push(cwd);
    const session = new AcpSession(spawn(missing, ["acp"], { cwd }));
    const close = session.close.bind(session);
    session.close = (killChild) => { close(killChild); board.switchAccount(card, "Grok · Work"); };
    return session;
  };
  await assert.rejects(board.startHeadless(card), /changed while preparing the launch/);
  assert.deepEqual(cwds, [board.cardTemp(card)]);
  assert.deepEqual([card.account, card.status, card.sessionId, card.worktree], ["Grok · Work", "queued", undefined, undefined]);
  assert.deepEqual([branches(), worktrees(), board.events(card.id).length], ["", 1, 0]);
  assert.equal(fs.readFileSync(catalog, "utf8"), saved);
  assert.equal(JSON.parse(saved)["antigravity:Antigravity · Shared"].defaultModel, model.value);
});

test("concurrent cold probes publish in reply order and validate each card against its own reply", async (t) => {
  const { board, repo } = fixture(t);
  const account = board.resolveAccount("antigravity");
  const probes = ["gemini-4-carbon", "gemini-4-neon"].map((id) => {
    const card = board.add(id, "Work.", account.name, undefined, "unlisted-id", undefined, undefined, { headless: true });
    return { id, card, cwd: board.cardTemp(card), reply: Promise.withResolvers(), closing: Promise.withResolvers() };
  });
  const byCwd = new Map(probes.map((probe) => [probe.cwd, probe]));
  fakeAcp(t, board, (cwd) => {
    const { id } = byCwd.get(cwd);
    return [{ id: "model", name: "Model", category: "model", type: "select", currentValue: id, options: [{ value: id, name: id }] }];
  });
  const run = board.runAcp;
  board.runAcp = (...args) => {
    const probe = byCwd.get(args[1]), session = run(...args);
    const open = session.open.bind(session);
    session.open = async (cwd) => { await probe.reply.promise; return open(cwd); };
    session.child.kill = () => { probe.closing.resolve(); return true; };
    probe.exit = () => session.child.emit("exit", 0);
    return session;
  };
  const refused = probes.map(({ card, id }) => assert.rejects(board.startHeadless(card), new RegExp(`It offers: ${id}\\.`)));
  await until(() => probes.every((probe) => probe.exit));
  for (const probe of probes) { probe.reply.resolve(); await probe.closing.promise; }
  for (const i of [1, 0]) { probes[i].exit(); await refused[i]; }
  const reopened = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  t.after(() => reopened.dispose());
  reopened.accountList = () => [account];
  assert.deepEqual(reopened.acpCatalog(account).options[0].values.map((v) => v.value), ["gemini-4-neon"]);
  assert.equal(reopened.defaultModels()[account.name], "gemini-4-neon");
});

test("an unlisted Antigravity model refused by the catalog probe leaves both saved cards byte-for-byte unchanged", async (t) => {
  const { board, branches, worktrees } = fixture(t);
  const root = board.add("Run", "Coordinate.", "acct", undefined, undefined, undefined, undefined,
    { orchestrator: { caps: { ...DEFAULT_CAPS }, opened: 1 }, approved: { at: "2026-01-01T00:00:00.000Z", hash: "h" } });
  const worker = board.add("Worker", "Work.", "Antigravity · Shared", root.id, "xenon-not-a-real-model", undefined, undefined,
    { headless: true, openedBy: root.id, watchedBy: root.id, permission: "bypass" });
  const models = [{ value: "gemini-4-carbon", name: "Gemini 4 Carbon" }, { value: "gemini-4-neon", name: "Gemini 4 Neon" }];
  const { cwds, exits } = fakeAcp(t, board, () => [{ id: "agent_model", name: "Model", category: "model", type: "select", currentValue: "gemini-4-neon", options: models }]);
  const catalog = path.join(board.dir, "acp-catalog.json");
  assert.equal(fs.existsSync(catalog), false);
  assert.deepEqual(worker.acpSelections, { model: "xenon-not-a-real-model" });
  const before = fs.readFileSync(board.file, "utf8");

  await assert.rejects(board.startHeadless(worker), /Antigravity · Shared does not advertise model xenon-not-a-real-model/);
  assert.deepEqual([cwds, exits], [[board.cardTemp(worker)], [true]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(catalog, "utf8"))["antigravity:Antigravity · Shared"].options[0].values, models);
  board.acpCatalogs = undefined; // Read the probe's persisted catalog as a reopened board would.
  board.accountList = () => [{ name: worker.account, provider: "antigravity", configDir: "" }];
  assert.equal(board.defaultModels()[worker.account], "Gemini 4 Neon");
  for (const card of [root, worker]) assert.equal(fs.existsSync(board.eventsFile(card.id)), false);
  assert.equal(fs.existsSync(path.join(board.dir, "wt")), false);
  assert.deepEqual([branches(), worktrees()], ["", 1]);
  assert.equal(fs.readFileSync(board.file, "utf8"), before);
  board.tick();
  assert.equal(fs.readFileSync(board.file, "utf8"), before, "the next board poll leaves both cards alone");
});

test("missing agy on headless Start preserves cards and Git work", async (t) => {
  for (const scenario of ["cold catalog", "cached catalog", "cached catalog with existing checkout", "cached catalog with symlinked PATH"]) await t.test(scenario,
    { skip: scenario === "cached catalog with symlinked PATH" && process.platform !== "linux" }, async (t) => {
    const { board, repo, git, branches, worktrees } = fixture(t);
    const parent = board.add("Parent", "Plan.", "acct", undefined, undefined, undefined, undefined,
      { orchestrator: { caps: { ...DEFAULT_CAPS }, opened: 1 }, approved: { at: "now", hash: "h" } });
    const cold = scenario === "cold catalog", existing = scenario === "cached catalog with existing checkout";
    const model = cold ? "xenon-not-a-real-model" : "gemini-4-carbon";
    const child = board.add("Child", "Go", "Antigravity · Shared", parent.id, model, undefined, undefined,
      { headless: true, openedBy: parent.id, watchedBy: parent.id, permission: "bypass" });
    board.update(parent, { deliveryReady: true, reported: true });
    if (!cold) board.rememberAcpOptions(child, [{ id: "agent_model", category: "model", name: "Model", values: [{ value: model, name: model }] }]);
    const folder = path.join(board.dir, "wt", child.id), branch = `task/${child.id}`;
    if (existing) {
      git("worktree", "add", "-qb", branch, folder);
      fs.writeFileSync(path.join(folder, "keep.txt"), "unfinished work");
    }
    const before = fs.readFileSync(board.file, "utf8"), lists = [branches(), worktrees()];
    const tip = existing && git("rev-parse", branch);
    const cwds = [];
    const exe = process.platform === "win32" ? path.join(repo, "missing", "agy.exe") : "agy";
    let lookup = repo;
    if (scenario === "cached catalog with symlinked PATH") {
      lookup = path.join(repo, "bin");
      fs.mkdirSync(path.join(repo, "tools"));
      fs.symlinkSync("tools", lookup);
    }
    t.mock.method(require("../out/acp.js"), "acpCommand", () => ({ file: exe, args: ["acp"], env: { PATH: lookup } }));
    board.runAcp = (_provider, cwd, _config, _update, _permission, env) => {
      cwds.push(cwd);
      env.PATH = lookup;
      return new AcpSession(spawn(exe, ["acp"], { cwd, env }));
    };
    await assert.rejects(board.startHeadless(child), { code: "ENOENT" });
    board.tick();
    assert.deepEqual([branches(), worktrees()], lists);
    assert.deepEqual(cwds, [board.cardTemp(child)]);
    assert.equal(fs.existsSync(path.join(board.dir, "wt", parent.id)), false);
    assert.equal(fs.existsSync(folder), existing);
    for (const card of [parent, child]) assert.equal(fs.existsSync(board.eventsFile(card.id)), false);
    assert.equal(fs.readFileSync(board.file, "utf8"), before);
    if (existing) {
      assert.equal(git("rev-parse", branch), tip);
      assert.equal(fs.readFileSync(path.join(folder, "keep.txt"), "utf8"), "unfinished work");
    }
  });
});

test("cached missing agy refuses a three-level start before allocating or reattaching a branch", async (t) => {
  for (const existing of [false, true]) await t.test(existing ? "existing middle branch" : "all new", async (t) => {
    const { board, repo, git, branches, worktrees } = fixture(t);
    fs.writeFileSync(path.join(repo, "package.json"), "{}");
    git("add", "package.json");
    git("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-qm", "node project");
    fs.mkdirSync(path.join(repo, "node_modules"));
    const lock = path.join(repo, "node_modules", ".package-lock.json");
    fs.writeFileSync(lock, "{}");
    const root = board.add("Root", "Plan.", "acct");
    const middle = board.add("Middle", "Plan.", "acct", root.id);
    const leaf = board.add("Leaf", "Go", "Antigravity · Shared", middle.id, undefined, undefined, undefined, { headless: true });
    const branch = `task/${middle.id}`;
    if (existing) git("branch", branch);
    const tip = existing && git("rev-parse", branch);
    board.rememberAcpOptions(leaf, [{ id: "model", name: "Model", category: "model", values: [{ value: "gemini-4-carbon", name: "Carbon" }] }]);
    const missing = path.join(repo, "missing", "agy");
    t.mock.method(require("../out/acp.js"), "acpCommand", () => ({ file: missing, args: ["acp"], env: {} }));
    board.runAcp = (_provider, cwd) => new AcpSession(spawn(missing, ["acp"], { cwd }));
    const saved = fs.readFileSync(board.file, "utf8");
    await assert.rejects(board.startHeadless(leaf), { code: "ENOENT" });
    assert.equal(fs.readFileSync(board.file, "utf8"), saved);
    assert.equal(fs.existsSync(path.join(board.dir, "wt")), false);
    assert.deepEqual([branches(), worktrees()], [existing ? branch : "", 1]);
    assert.equal(fs.readFileSync(lock, "utf8"), "{}");
    if (existing) assert.equal(git("rev-parse", branch), tip);
  });
});

test("a cold probe retries in the worktree when ENOENT depends on the probe directory", async (t) => {
  for (const scenario of ["relative PATH", "/proc/self/cwd PATH", "/proc/./self/cwd PATH", "/proc/self/cwd symlink",
    "/proc/thread-self/cwd executable", "relative interpreter", "probe directory removed"]) await t.test(scenario,
    { skip: (scenario === "relative PATH" && process.platform === "win32") ||
      ((scenario.startsWith("/proc/") || scenario === "relative interpreter") && process.platform !== "linux") }, async (t) => {
      const { board, repo, git } = fixture(t);
      const child = board.add("Worker", "Go", "Antigravity · Shared", undefined, "fake-model-a", undefined, undefined, { headless: true, permission: "bypass" });
      const alias = path.join(repo, "cwd-alias");
      if (scenario === "/proc/self/cwd symlink") fs.symlinkSync("/proc/self/cwd", alias);
      let name = process.execPath;
      if (scenario !== "probe directory removed") {
        const bin = path.join(repo, "bin");
        fs.mkdirSync(bin);
        name = "fixture-agy";
        fs.symlinkSync(process.execPath, path.join(bin, "fixture-agy"));
        if (scenario === "/proc/thread-self/cwd executable") name = "/proc/thread-self/cwd/bin/fixture-agy";
        git("add", "bin");
        git("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-qm", "worktree-local provider");
        if (scenario === "relative interpreter") {
          const dir = fs.mkdtempSync(path.join(require("./exec-tmpdir").execTmpdir(), "agy-script-"));
          t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
          name = path.join(dir, "agy");
          fs.writeFileSync(name, "#!bin/fixture-agy\n" + fs.readFileSync(path.join(__dirname, "fake-acp.js"), "utf8"), { mode: 0o700 });
        }
      }
      const cwds = [];
      board.runAcp = (_provider, cwd, _config, update, permission, env) => {
        cwds.push(cwd);
        if (scenario === "relative PATH") env.PATH = "bin";
        if (scenario === "/proc/self/cwd PATH") env.PATH = "/proc/self/cwd/bin";
        if (scenario === "/proc/./self/cwd PATH") env.PATH = "/proc/./self/cwd/bin";
        if (scenario === "/proc/self/cwd symlink") env.PATH = path.join(alias, "bin");
        if (scenario === "probe directory removed" && cwds.length === 1) fs.rmdirSync(cwd);
        return new AcpSession(spawn(name, [path.join(__dirname, "fake-acp.js")], { cwd, env, detached: process.platform !== "win32" }), update, permission);
      };
      await board.startHeadless(child);
      await until(() => !board.codexRuns.has(child.id));
      assert.deepEqual(cwds, [board.cardTemp(child), child.worktree]);
      assert.ok(board.events(child.id).some(e => e.hook_event_name === "UserPromptSubmit"));
    });
});

test("late missing agy retains the published checkout and never schedules its removal", async (t) => {
  for (const held of [true, false]) await t.test(held ? "held checkout" : "unheld checkout", async (t) => {
    const { board, repo, git, worktrees } = fixture(t);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "initial");
    git("add", "tracked.txt");
    git("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-qm", "tracked file");
    fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "\nignored.txt\n");
    const parent = board.add("Parent", "Plan.", "acct");
    const child = board.add("Child", "Go", "Antigravity · Shared", parent.id, undefined, undefined, undefined, { headless: true });
    board.rememberAcpOptions(child, [{ id: "model", name: "Model", category: "model", values: [{ value: "gemini-4-carbon", name: "Carbon" }] }]);
    const executable = path.join(repo, "fixture-agy");
    fs.writeFileSync(executable, "present at lookup");
    t.mock.method(require("../out/acp.js"), "acpCommand", () => ({ file: executable, env: {}, args: ["acp"] }));
    const folder = path.join(board.dir, "wt", child.id);
    board.runAcp = (_provider, cwd) => {
      assert.equal(cwd, folder);
      fs.unlinkSync(executable);
      git("-C", cwd, "update-index", "--assume-unchanged", "tracked.txt");
      fs.writeFileSync(path.join(cwd, "tracked.txt"), "edited, hidden from status");
      assert.equal(git("-C", cwd, "status", "--porcelain").trim(), "");
      return new AcpSession(spawn(executable, ["acp"], { cwd }));
    };
    let busy = held;
    board.worktreeHeld = () => busy;
    board.heldRetryMs = 10;
    await assert.rejects(board.startHeadless(child), { code: "ENOENT" });
    assert.equal(fs.readFileSync(path.join(folder, "tracked.txt"), "utf8"), "edited, hidden from status");
    const tip = git("rev-parse", child.branch);
    if (held) {
      fs.writeFileSync(path.join(folder, "committed.txt"), "saved");
      git("-C", folder, "add", "committed.txt");
      git("-C", folder, "-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-qm", "work after refusal");
    }
    const keptTip = git("rev-parse", child.branch);
    if (held) assert.notEqual(keptTip, tip);
    const file = path.join(folder, "ignored.txt");
    fs.writeFileSync(file, "written after failure");
    busy = false;
    assert.equal(board.heldRetries.size, 0);
    await new Promise(resolve => setTimeout(resolve, 30));
    board.tick();
    assert.equal(fs.readFileSync(file, "utf8"), "written after failure");
    assert.equal(fs.readFileSync(path.join(folder, "tracked.txt"), "utf8"), "edited, hidden from status");
    const saved = JSON.parse(fs.readFileSync(board.file, "utf8"));
    for (const card of [child, parent]) {
      const record = saved.find(c => c.id === card.id);
      assert.equal(record.worktree, path.join(board.dir, "wt", card.id));
      assert.equal(record.branch, `task/${card.id}`);
      assert.equal(git("rev-parse", record.branch), card === child ? keptTip : tip);
    }
    assert.equal(worktrees(), 3);
  });
});

test("child branches keep Git's named-base tracking on successful allocation", async (t) => {
  for (const setup of ["always", "inherit"]) await t.test(setup, async (t) => {
    const { board, git } = fixture(t);
    const parent = board.add("Parent", "Plan.", "acct");
    const child = board.add("Child", "Go", "acct", parent.id);
    await board.ensureWorktree(parent);
    git("branch", "--set-upstream-to=main", parent.branch);
    git("config", "branch.autoSetupMerge", setup);
    await board.ensureWorktree(child);
    assert.equal(git("rev-parse", "--abbrev-ref", child.branch + "@{upstream}").trim(), setup === "always" ? parent.branch : "main");
    assert.equal(git("rev-parse", child.branch), git("rev-parse", parent.branch));
  });
});

test("missing agy preserves a checkout awaiting an older F92 cleanup", async (t) => {
  for (const scenario of ["probe ENOENT", "launch ENOENT", "only the parent is held"]) await t.test(scenario, async (t) => {
    const { board, repo, git, worktrees } = fixture(t);
    const parent = board.add("Parent", "Plan.", "acct");
    const child = board.add("Child", "Go", "Antigravity · Shared", parent.id, undefined, undefined, undefined, { headless: true });
    const option = { id: "model", name: "Model", category: "model", type: "select", currentValue: "auto", options: [{ value: "auto", name: "Auto" }] };
    board.rememberAcpOptions(child, [{ ...option, values: option.options }]);
    fakeAcp(t, board, () => [option]);
    let held = true;
    const parentOnly = scenario === "only the parent is held";
    board.worktreeHeld = folder => held && (!parentOnly || folder === parent.worktree);
    board.heldRetryMs = 25;
    await assert.rejects(board.startHeadless(child), /would run "auto"/);
    assert.equal(board.heldRetries.size, 1);
    const retained = parentOnly ? parent : child;
    const folder = retained.worktree, file = path.join(folder, "late.ignored"), tip = git("rev-parse", retained.branch);
    fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "\n*.ignored\n");
    const missing = path.join(repo, "missing", "agy");
    t.mock.method(require("../out/acp.js"), "acpCommand", () => ({ file: scenario === "launch ENOENT" ? process.execPath : missing, args: [], env: {} }));
    board.runAcp = (_provider, cwd) => new AcpSession(spawn(missing, ["acp"], { cwd }));

    // Reproduce the reviewed writer at the final Git command, after any clean-status check.
    const commands = require("../out/git.js"), run = commands.git;
    let removals = 0;
    const write = () => fs.writeFileSync(file, "late ignored work");
    t.mock.method(commands, "git", (cwd, args, ...rest) => {
      if (args[0] === "worktree" && args[1] === "remove" && args.at(-1) === folder) { removals++; write(); }
      return run(cwd, args, ...rest);
    });
    const finished = Promise.withResolvers(), rollback = board.rollbackRefusedWorktrees.bind(board);
    board.rollbackRefusedWorktrees = async (...args) => {
      await rollback(...args);
      if (!board.heldRetries.size) finished.resolve();
    };
    await assert.rejects(board.startHeadless(child), { code: "ENOENT" });
    held = false;
    await until(() => board.heldRetries.size === 0);
    await finished.promise;
    if (!removals) write(); // The checkout is still available to the writer after the timer returns.
    assert.equal(fs.readFileSync(file, "utf8"), "late ignored work");
    assert.equal(removals, 0);
    assert.equal(git("rev-parse", retained.branch), tip);
    assert.deepEqual([retained.worktree, worktrees()], [folder, parentOnly ? 2 : 3]);
  });
});

test("an Antigravity model offered by the probe but refused at launch leaves its saved parent unchanged", async (t) => {
  const { board, refused } = fixture(t);
  const root = board.add("Run", "Coordinate.", "acct", undefined, undefined, undefined, undefined,
    { orchestrator: { caps: { ...DEFAULT_CAPS }, opened: 1 }, approved: { at: "2026-01-01T00:00:00.000Z", hash: "h" } });
  const worker = board.add("Worker", "Work.", "Antigravity · Shared", root.id, "gemini-4-carbon", undefined, undefined,
    { headless: true, openedBy: root.id, watchedBy: root.id, permission: "bypass" });
  const probe = board.cardTemp(worker), worktree = path.join(board.dir, "wt", worker.id);
  const { cwds } = fakeAcp(t, board, (cwd) => {
    const value = cwd === probe ? "gemini-4-carbon" : "gemini-4-argon";
    return [{ id: "agent_model", name: "Model", category: "model", type: "select", currentValue: value, options: [{ value, name: value }] }];
  });
  const savedParent = () => JSON.parse(fs.readFileSync(board.file, "utf8")).find((card) => card.id === root.id);
  const before = savedParent();

  await refused(worker, () => board.startHeadless(worker), /Antigravity · Shared does not advertise model gemini-4-carbon/, root);
  assert.deepEqual(cwds, [probe, worktree]);
  assert.equal(fs.existsSync(path.join(board.dir, "wt", root.id)), false);
  assert.deepEqual(savedParent(), before);
});

test("a new shared sign-in discards the previous default and probes the new inventory", async (t) => {
  const { board } = fixture(t);
  const account = board.resolveAccount("antigravity"), task = { provider: account.provider, account: account.name };
  board.accountList = () => [account];
  const old = [{ id: "m", name: "Model", category: "model", currentValue: "gemini-4-carbon", values: [{ value: "gemini-4-carbon", name: "Carbon" }] }];
  board.rememberAcpOptions(task, old, "session/new");
  assert.equal(board.defaultModels()[account.name], "Carbon");
  board.antigravityLoginId = () => "second-login";
  board.acpCatalogs = undefined;
  assert.equal(board.defaultModels()[account.name], undefined);
  board.rememberAcpOptions(task, old, "session/new", ""); // a late reply from the old login
  assert.equal(board.acpCatalog(account), undefined);
  const worker = board.add("Worker", "Work.", account.name, undefined, "new-unlisted-id", undefined, undefined, { headless: true });
  const { cwds } = fakeAcp(t, board, () => [{ id: "m", name: "Model", category: "model", type: "select", currentValue: "gemini-4-neon", options: [{ value: "gemini-4-neon", name: "Neon" }] }]);
  await assert.rejects(board.startHeadless(worker), /does not advertise model new-unlisted-id.*gemini-4-neon/);
  assert.deepEqual(cwds, [board.cardTemp(worker)]);
  board.acpCatalogs = undefined;
  assert.equal(board.defaultModels()[account.name], "Neon");
});

test("a reader polls the saved default and preserves newer catalog rows when it takes ownership", (t) => {
  const { board, repo } = fixture(t);
  const agy = board.resolveAccount("antigravity"), grok = board.resolveAccount("grok");
  const reader = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  t.after(() => reader.dispose());
  reader.accountList = () => [agy];
  let owner = false;
  reader.isOwner = () => owner;
  const record = (b, a, id) => b.rememberAcpOptions({ account: a.name, provider: a.provider, configDir: a.configDir },
    [{ id: "m", name: "Model", category: "model", currentValue: id, values: [{ value: id, name: id }] }], "session/new");
  assert.equal(reader.defaultModels()[agy.name], undefined);
  record(board, agy, "gemini-4-carbon");
  reader.tick();
  assert.equal(reader.defaultModels()[agy.name], "gemini-4-carbon");
  record(board, agy, "gemini-4-neon");
  owner = true;
  reader.tick();
  record(reader, grok, "grok-4.3");
  reader.acpCatalogs = undefined;
  assert.equal(reader.defaultModels()[agy.name], "gemini-4-neon");
  assert.equal(reader.acpCatalog(grok).options[0].values[0].value, "grok-4.3");
});

test("an identical opening default retries a failed atomic catalog save", (t) => {
  const { board } = fixture(t);
  const account = board.resolveAccount("antigravity"), task = { account: account.name, provider: account.provider };
  board.accountList = () => [account];
  const values = ["gemini-4-carbon", "gemini-4-neon"].map((value) => ({ value, name: value }));
  const record = (id) => board.rememberAcpOptions(task, [{ id: "m", name: "Model", category: "model", currentValue: id, values }], "session/new");
  record("gemini-4-carbon");
  const file = path.join(board.dir, "acp-catalog.json"), rename = fs.renameSync;
  const fault = t.mock.method(fs, "renameSync", (from, to) => { if (to === file) throw new Error("simulated write failure"); return rename(from, to); });
  const error = t.mock.method(console, "error", () => {});
  record("gemini-4-neon");
  assert.equal(error.mock.callCount(), 1);
  assert.equal(board.defaultModels()[account.name], "gemini-4-neon");
  assert.equal(JSON.parse(fs.readFileSync(file))["antigravity:Antigravity · Shared"].defaultModel, "gemini-4-carbon");
  fault.mock.restore();
  record("gemini-4-neon");
  board.acpCatalogs = undefined;
  assert.equal(board.defaultModels()[account.name], "gemini-4-neon");
});

test("unattended ACP with no catalog yet: a session refused for its model leaves no worktree, branch, event or session on the card or its parent", async (t) => {
  const { board, refused } = fixture(t);
  const options = [{ id: "agent_model", name: "Model", category: "model", type: "select", currentValue: "auto", options: [{ value: "auto", name: "Auto" }, { value: "model-s1", name: "Small" }] }];
  const { cwds, exits } = fakeAcp(t, board, () => options);
  const root = board.add("Run", "Coordinate.", "acct", undefined, undefined, undefined, undefined,
    { orchestrator: { caps: { ...DEFAULT_CAPS }, opened: 0 }, headless: true, approved: { at: "now", hash: "h" } });
  const worker = board.add("Worker", "Work.", "Grok · Work", root.id, undefined, undefined, undefined, { headless: true, openedBy: root.id, permission: "bypass" });
  // No catalog saved yet: the account is asked for one by a session in the card's own temporary folder, before any worktree exists
  // (live, 17 November 2026: agy held a refused start's new worktree for about a minute).
  await refused(worker, () => board.startHeadless(worker), /Grok · Work would run "auto", which is not an exact model id, so nothing was started\./, root);
  assert.deepEqual(cwds, [board.cardTemp(worker)], "one probe session, opened outside any worktree");
  assert.deepEqual(exits, [true], "the probe's agent exits before the start goes on");
  // A card naming the alias is refused by the catalog the probe kept, before any session opens.
  const named = board.add("Named", "Work.", "Grok · Work", root.id, "auto", undefined, undefined, { headless: true, openedBy: root.id, permission: "bypass" });
  await refused(named, () => board.startHeadless(named), /would run "auto", which is not an exact model id/, root);
  assert.equal(cwds.length, 1, "no session opened for it");
  // With a catalog but no model on the card (the catalog keeps no current value), the session opens in the new worktree and is
  // refused there; the worktree is removed only once that agent has exited.
  await refused(worker, () => board.startHeadless(worker), /would run "auto", which is not an exact model id/, root);
  assert.deepEqual([cwds.length, exits], [2, [true, true]]);

  // A worktree the agent still holds is kept whole for now (the card keeps it, never a half-removed folder), and removed by a later try
  // once it is free; only what that start made.
  board.heldRetryMs = 50;
  let held = 2;
  board.worktreeHeld = () => held-- > 0;
  const second = board.add("Second", "Work.", "Grok · Work", root.id, undefined, undefined, undefined, { headless: true, openedBy: root.id, permission: "bypass" });
  const editedAt = new Date(Date.parse(root.updatedAt) + 1000).toISOString();
  const clock = t.mock.method(Date.prototype, "toISOString", () => editedAt);
  try {
    await assert.rejects(board.startHeadless(second), /would run "auto"/);
    assert.ok(root.worktree, "the parent's worktree is pending cleanup");
    board.update(root, { title: "Updated run" }); // same wall-clock millisecond as allocation
  } finally { clock.mock.restore(); }
  const folder = second.worktree, branch = second.branch;
  assert.ok(folder && fs.existsSync(path.join(folder, ".git")), "the held worktree is whole");
  assert.match(execFileSync("git", ["branch", "--list", branch], { cwd: board.repo, encoding: "utf8" }), new RegExp(branch), "its branch is kept");
  assert.equal(second.sessionId, undefined);
  await until(() => !second.worktree && !root.worktree);
  assert.equal(second.branch, undefined);
  assert.ok(!fs.existsSync(folder), "removed once free");
  assert.equal(execFileSync("git", ["branch", "--list", branch], { cwd: board.repo, encoding: "utf8" }).trim(), "");
  assert.equal(root.worktree, undefined, "the parent's, made by that start, too");
  const savedRoot = JSON.parse(fs.readFileSync(board.file, "utf8")).find((card) => card.id === root.id);
  assert.deepEqual([savedRoot.title, savedRoot.updatedAt], ["Updated run", editedAt], "delayed cleanup preserves a parent edit made in the allocation millisecond");

  // A card started again while its old worktree was held keeps it: the later try removes nothing.
  held = 1000;
  const third = board.add("Third", "Work.", "Grok · Work", root.id, undefined, undefined, undefined, { headless: true, openedBy: root.id, permission: "bypass" });
  await assert.rejects(board.startHeadless(third), /would run "auto"/);
  board.starting.add(third.id);
  held = 0;
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(third.worktree && fs.existsSync(third.worktree), "kept while the card is starting again");
  board.starting.delete(third.id);
});

test("a second ACP model refusal preserves pending cleanup of both held worktrees", async (t) => {
  const { board, branches, worktrees } = fixture(t);
  const options = [{ id: "agent_model", name: "Model", category: "model", type: "select", currentValue: "auto", options: [{ value: "auto", name: "Auto" }] }];
  const { cwds } = fakeAcp(t, board, () => options);
  const parent = board.add("Parent", "Plan.", "acct");
  const child = board.add("Child", "Go", "Grok · Work", parent.id, undefined, undefined, undefined, { headless: true });
  const noModel = /would run "auto"/;
  await assert.rejects(board.startHeadless(child), noModel); // the preflight probe saves the catalog
  let held = true;
  board.worktreeHeld = () => held;
  board.heldRetryMs = 25;
  await assert.rejects(board.startHeadless(child), noModel);
  const parentFolder = parent.worktree, childFolder = child.worktree;
  assert.ok(parentFolder && childFolder, "both checkouts are pending cleanup");
  await assert.rejects(board.startHeadless(child), noModel);
  assert.deepEqual(cwds, [board.cardTemp(child), childFolder, childFolder]);

  held = false;
  await until(() => !child.worktree && !parent.worktree, 3000);
  assert.deepEqual([branches(), worktrees()], ["", 1]);
  assert.equal(fs.existsSync(childFolder) || fs.existsSync(parentFolder), false);
});

test("a refused start rolls back the parent while retaining the child's preexisting branch", async (t) => {
  const { board, git, branches, worktrees } = fixture(t);
  board.codexModelIds = () => ["gpt-6.2-sol"];
  board.codexDefaultId = () => undefined;
  board.codexConfiguredModel = async (cwd) => cwd === board.repo ? "gpt-6.2-sol" : undefined;
  const parent = board.add("Parent", "Plan.", "acct");
  const child = board.add("Child", "Go", "Codex · t@t", parent.id);
  const branch = `task/${child.id}`;
  git("branch", branch);
  const head = git("rev-parse", branch);
  const timestamp = parent.updatedAt;

  await assert.rejects(board.start(child), /Codex has not said which model that is/);
  assert.equal(child.branch, branch);
  assert.equal(git("rev-parse", branch), head);
  assert.ok(fs.existsSync(path.join(child.worktree, ".git")));
  assert.deepEqual([parent.worktree, parent.branch, parent.updatedAt], [undefined, undefined, timestamp]);
  assert.deepEqual([branches(), worktrees()], [branch, 2]);
});

test("deleting a refused child and keeping its checkout still rolls back the held parent", async (t) => {
  const { board, branches, worktrees } = fixture(t);
  board.codexModelIds = () => ["gpt-6.2-sol"];
  board.codexDefaultId = () => undefined;
  board.codexConfiguredModel = async (cwd) => cwd === board.repo ? "gpt-6.2-sol" : undefined;
  const parent = board.add("Parent", "Plan.", "acct");
  const child = board.add("Child", "Go", "Codex · t@t", parent.id);
  let held = true;
  board.worktreeHeld = () => held;
  board.heldRetryMs = 25;
  await assert.rejects(board.start(child), /Codex has not said which model that is/);
  const parentFolder = parent.worktree, childFolder = child.worktree, childBranch = child.branch;
  assert.ok(parentFolder && childFolder, "both checkouts are pending cleanup");
  board.remove(child); // Delete card, keep worktree

  held = false;
  await until(() => !parent.worktree, 3000);
  assert.equal(board.get(child.id), undefined);
  assert.equal(fs.existsSync(parentFolder), false);
  assert.ok(fs.existsSync(path.join(childFolder, ".git")));
  assert.deepEqual([branches(), worktrees()], [childBranch, 2]);
});

test("discarding a refused child's checkout still rolls back the held parent", async (t) => {
  for (const action of ["Discard", "Delete card and worktree"]) await t.test(action, async (t) => {
    const { board, branches, worktrees } = fixture(t);
    board.codexModelIds = () => ["gpt-6.2-sol"];
    board.codexDefaultId = () => undefined;
    board.codexConfiguredModel = async (cwd) => cwd === board.repo ? "gpt-6.2-sol" : undefined;
    const parent = board.add("Parent", "Plan.", "acct");
    const child = board.add("Child", "Go", "Codex · t@t", parent.id);
    let held = true;
    board.worktreeHeld = () => held;
    board.heldRetryMs = 25;
    await assert.rejects(board.start(child), /Codex has not said which model that is/);
    const parentFolder = parent.worktree, childFolder = child.worktree;
    assert.ok(parentFolder && childFolder, "both checkouts are pending cleanup");
    await board.finish(child, "discard");
    if (action === "Discard") assert.equal(board.get(child.id)?.status, "done");
    else { board.remove(child); assert.equal(board.get(child.id), undefined); }

    held = false;
    await until(() => !parent.worktree, 3000);
    assert.deepEqual([branches(), worktrees()], ["", 1]);
    assert.equal(fs.existsSync(childFolder) || fs.existsSync(parentFolder), false);
  });
});

test("a held parent rollback keeps both worktrees after the refused child starts again", { timeout: 10000 }, async (t) => {
  const { board, git } = fixture(t);
  let modelAvailable = false, held = true;
  board.codexModelIds = () => ["gpt-6.2-sol"];
  board.codexDefaultId = () => undefined;
  board.codexConfiguredModel = async (cwd) => modelAvailable || cwd === board.repo ? "gpt-6.2-sol" : undefined;
  board.runHeadlessCodex = async (card) => board.update(card, { sessionId: "restarted", status: "running" });
  board.worktreeHeld = () => held;
  board.heldRetryMs = 50;
  const parent = board.add("Parent", "Plan.", "acct");
  const child = board.add("Child", "Go", "Codex · t@t", parent.id, undefined, undefined, undefined, { headless: true });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const remove = board.removeRefusedWorktree.bind(board);
  const retries = [];
  board.removeRefusedWorktree = (...args) => {
    const result = remove(...args);
    if (!held) retries.push(result);
    return result;
  };
  await assert.rejects(board.startHeadless(child), /Codex has not said which model that is/);
  const parentFolder = parent.worktree, parentBranch = parent.branch, childFolder = child.worktree;
  assert.ok(childFolder && parentFolder, "both worktrees were retained pending cleanup");

  modelAvailable = true;
  await board.startHeadless(child);
  assert.equal(child.sessionId, "restarted");
  held = false;
  t.mock.timers.tick(board.heldRetryMs);
  assert.ok(retries.length, "at least one cleanup retry ran");
  await Promise.all(retries);
  assert.equal(child.worktree, childFolder);
  assert.equal(parent.worktree, parentFolder);
  assert.ok(fs.existsSync(path.join(parentFolder, ".git")));
  assert.ok(git("branch", "--list", parentBranch).trim());
});

test("a sibling starting during parent rollback branches from the recreated parent", { timeout: 10000 }, async (t) => {
  const { board, git } = fixture(t);
  const parent = board.add("Parent", "Plan.", "acct");
  const step = { headless: true };
  const refused = board.add("Refused", "Go", "Codex · t@t", parent.id, undefined, undefined, undefined, step);
  const sibling = board.add("Sibling", "Go", "Codex · t@t", parent.id, undefined, undefined, undefined, step);
  const parentFolder = path.join(board.dir, "wt", parent.id);
  const parentBranch = `task/${parent.id}`;
  let keepParent = true;
  const preflight = Promise.withResolvers();
  board.codexModelIds = () => ["gpt-6.2-sol"];
  board.codexDefaultId = () => undefined;
  board.codexConfiguredModel = async (cwd) => {
    if (!keepParent) { preflight.resolve(); return "gpt-6.2-sol"; }
    return cwd === board.repo ? "gpt-6.2-sol" : undefined;
  };
  board.runHeadlessCodex = async (card) => board.update(card, { sessionId: "sibling-started", status: "running" });
  board.worktreeHeld = (folder) => folder === parentFolder && keepParent;
  board.heldRetryMs = 50;
  const paused = Promise.withResolvers(), release = Promise.withResolvers();
  const rm = fs.promises.rm;
  const pause = t.mock.method(fs.promises, "rm", async (target, options) => {
    if (target === parentFolder) { paused.resolve(); await release.promise; }
    return rm(target, options);
  });
  try {
    await assert.rejects(board.startHeadless(refused), /Codex has not said which model that is/);
    keepParent = false;
    await paused.promise;
    assert.equal(git("branch", "--list", parentBranch).trim(), "", "Git removed the branch before the board cleared its record");
    assert.equal(parent.branch, parentBranch);
    const started = board.startHeadless(sibling);
    try {
      await preflight.promise;
      await new Promise(setImmediate);
    } finally { release.resolve(); }
    await started;
    assert.equal(sibling.sessionId, "sibling-started");
    assert.equal(parent.worktree, parentFolder);
    assert.equal(git("rev-parse", parentBranch), git("rev-parse", sibling.branch));
  } finally {
    release.resolve();
    pause.mock.restore();
  }
});

test("a refused subtask never removes its parent's new worktree while a sibling is starting", async (t) => {
  const { board, branches } = fixture(t);
  board.codexModelIds = () => ["gpt-6.2-sol"];
  board.codexDefaultId = () => undefined;
  board.codexConfiguredModel = async (cwd) => (cwd === board.repo ? "gpt-6.2-sol" : undefined); // refused once its worktree exists
  const parent = board.add("Parent", "Plan.", "acct");
  const a = board.add("A", "Go", "Codex · t@t", parent.id), b = board.add("B", "Go", "Codex · t@t", parent.id);
  board.starting.add(b.id); // B's Start is under way (it may be branching from the parent now)
  await assert.rejects(board.start(a), /Codex has not said which model that is/);
  board.starting.delete(b.id);
  assert.equal(a.worktree, undefined, "A's own worktree is removed");
  assert.ok(parent.worktree && fs.existsSync(parent.worktree), "the parent's worktree stays for B");
  assert.match(branches(), new RegExp(`task/${parent.id}`));
  // With no sibling starting, the parent's worktree made for A is removed with A's.
  const c = board.add("C", "Go", "Codex · t@t", board.add("Parent 2", "Plan.", "acct").id);
  await assert.rejects(board.start(c), /Codex has not said which model that is/);
  assert.equal(board.get(c.parentId).worktree, undefined);
});
