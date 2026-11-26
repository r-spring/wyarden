const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { execFileSync, spawn } = require("node:child_process");
require("./safe-temp").assertSafeTemp();

class VSCodeEvent {
  event = () => ({ dispose() {} });
  fire() {}
  dispose() {}
}
const vscode = { EventEmitter: VSCodeEvent, ThemeIcon: class {},
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }),
    showWarningMessage: async () => undefined, showInformationMessage: async () => undefined } };
const load = Module._load;
Module._load = function (request, ...args) { return request === "vscode" ? vscode : load.call(this, request, ...args); };
const { Board } = require("../out/board.js");
const { DEFAULT_CAPS, boundSession } = require("../out/orchestrator.js");

function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-acp-identity-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const board = new Board(repo, path.join(repo, "hook.js"), path.join(repo, "hooks"), false);
  board.accountList = () => [{ name: "Claude", configDir: path.join(repo, "claude") },
    { name: "Codex", provider: "codex", configDir: path.join(repo, "codex") },
    { name: "Grok", provider: "grok", configDir: path.join(repo, "grok") },
    { name: "Antigravity", provider: "antigravity", configDir: "" }];
  board.accountFolderList = () => [];
  board.preflightHeadless = async () => {};
  board.requestRateMs = 0;
  // The terminals' exact ids: Grok's named default and Antigravity's newest Opus (no CLI is run).
  board.grokModels = async () => ({ ids: ["grok-4.7"], default: "grok-4.7" });
  board.agyModelIds = () => ["claude-opus-5-5"];
  board.tick();
  const runs = [];
  board.probeAcpCatalogs = false; // F92 catalog probe: checked in refused-start.test.js; these fakes count every session
  const stopped = [];
  board.killTree = (child) => stopped.push(child);
  board.runAcp = (provider, cwd, _profile, update, permission, env) => {
    const child = Object.assign(new EventEmitter(), { pid: 2 ** 30, kill: () => true });
    let finish;
    const result = new Promise((resolve) => { finish = () => resolve("end_turn"); });
    const run = { provider, cwd, env, child, finish, update, permission, closed: false, closes: 0, cancels: 0 };
    runs.push(run);
    // A model choice with the id the session is on: the board selects it explicitly (exact ids only, 17 November 2026).
    return { child, open: async (_cwd, id) => id ?? `${provider}-conversation`,
      options: () => [{ id: "model", name: "Model", category: "model", currentValue: "fake-model-a", values: [{ value: "fake-model-a", name: "Fake model A" }] }],
      configure: async (id, value) => { (run.configured ??= []).push([id, value]); }, prompt: () => result,
      cancel: () => run.cancels++, close: () => { run.closes++; run.closed = true; } };
  };
  // Only fake identity values are inherited; no provider process or login is used.
  const inherited = { ENTOMATICAL_SESSION: "parent-controller", CODEX_THREAD_ID: "parent-codex", CLAUDE_CODE_SESSION_ID: "parent-claude" };
  for (const [key, value] of Object.entries(inherited)) {
    const before = process.env[key]; process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
  t.after(() => { board.dispose(); fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { repo, board, runs, stopped };
}

async function cli(board, cwd, argv, env) {
  const pump = setInterval(() => void board.processInbox(), 20);
  try {
    return await new Promise((resolve, reject) => {
      // Same as running tools/board.js, but with a 60 s answer wait instead of 20 s so a loaded machine does not time out.
      const runner = `require(${JSON.stringify(path.resolve(__dirname, "../tools/board.js"))}).main(process.argv.slice(1), { cwd: process.cwd(), env: process.env, `
        + `write: (s) => process.stdout.write(s), timeoutMs: 60000 }).then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(e.message + "\\n"); process.exitCode = 1; });`;
      const child = spawn(process.execPath, ["-e", runner, ...argv], { cwd, env });
      let out = "", err = "";
      child.stdout.on("data", (data) => { out += data; });
      child.stderr.on("data", (data) => { err += data; });
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, out, err }));
    });
  } finally { clearInterval(pump); }
}
const master = (board, account) => board.add("Controller", "Coordinate.", account, undefined, undefined, undefined, undefined,
  { orchestrator: { caps: { ...DEFAULT_CAPS }, opened: 0 }, headless: true, approved: { at: "now", hash: "approved" } });
const until = async (fn) => {
  const deadline = Date.now() + 30_000;
  while (!fn() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fn(), "fake ACP turn did not settle");
};

test("RT-04: a prior host's retirement receipt holds only its own repository and card until exit can be verified", async (t) => {
  const first = fixture(t), other = fixture(t);
  const card = master(first.board, "Grok"), independent = master(other.board, "Grok");
  other.board.update(independent, { id: card.id });
  const dir = path.join(first.board.dir, "retiring", card.id), file = path.join(dir, "prior-run.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 30 }));
  const realKill = process.kill, queries = [];
  let error;
  t.mock.method(process, "kill", (pid, signal) => {
    if (pid !== 2 ** 30) return realKill(pid, signal);
    queries.push(signal);
    if (error) throw Object.assign(new Error(error), { code: error });
    return true;
  });
  await other.board.startHeadless(independent);
  assert.deepEqual(queries, []);
  for (error of [undefined, "EPERM"]) await assert.rejects(first.board.startHeadless(card), /previous provider process to exit/);
  assert.equal(first.runs.length, 0);
  assert.ok(fs.existsSync(file));
  error = "ESRCH";
  await first.board.startHeadless(card);
  assert.deepEqual(queries, [0, 0, 0]);
  assert.equal(first.runs.length, 1);
  assert.equal(fs.existsSync(file), false);
  for (const { runs } of [first, other]) {
    runs[0].finish();
    await until(() => runs[0].closed);
    runs[0].child.emit("close", 0);
  }
});

for (const stage of ["catalog", "open", "configure"]) {
  test(`RT-04: dispose during ACP ${stage} fences a delayed start`, async (t) => {
    const { repo, board, stopped } = fixture(t);
    const task = master(board, "Grok");
    const child = new EventEmitter();
    let resolve, closes = 0, prompts = 0;
    const wait = () => new Promise(done => { resolve = done; });
    board.probeAcpCatalogs = stage === "catalog";
    board.runAcp = () => ({
      child, open: stage === "configure" ? async () => "provider-id" : wait,
      configure: wait, options: () => [{ id: "model", category: "model", currentValue: "test-model", values: [{ value: "test-model" }] }],
      prompt: async () => { prompts++; return "end_turn"; }, close: () => closes++,
    });
    const launched = board.startHeadless(task);
    await until(() => !!resolve);
    board.dispose();
    board.dispose();
    assert.deepEqual(stopped, [child]);
    assert.equal(closes, 1);
    const next = new Board(repo, path.join(repo, "hook.js"), path.join(repo, "hooks"), false);
    t.after(() => next.dispose());
    const card = next.get(task.id);
    assert.equal(card.sessionId, stage === "configure" ? "provider-id" : undefined);
    assert.equal(card.status, stage === "configure" ? "review" : "queued");
    assert.equal(!!card.interrupted, stage !== "catalog", "a catalog probe alone never started a card turn");
    next.update(card, { title: "Successor" });
    const saved = fs.readFileSync(next.file), events = next.events(card.id);
    const catalog = path.join(board.dir, "acp-catalog.json");
    const catalogBytes = () => fs.existsSync(catalog) ? fs.readFileSync(catalog) : undefined;
    const before = catalogBytes();
    resolve("old-session");
    await assert.rejects(launched);
    assert.deepEqual(fs.readFileSync(next.file), saved);
    assert.deepEqual(next.events(card.id), events);
    assert.deepEqual(catalogBytes(), before);
    assert.deepEqual([prompts, closes, stopped.length], [0, 1, 1]);
    if (stage === "catalog") assert.equal(card.worktree, undefined);
    await assert.rejects(card.sessionId ? next.followUpHeadless(card, "retry") : next.startHeadless(card), /previous provider process to exit/);
    child.emit("close", 0);
  });
}

for (const [runtime, account] of [["grok", "Grok"], ["antigravity", "Antigravity"]]) {
  test(`RT-04: ${runtime} disposal interrupts the active turn once and rejects late callbacks after replacement`, async (t) => {
    const { repo, board, runs, stopped } = fixture(t);
    const task = master(board, account);
    await board.startHeadless(task);
    const [old] = runs;
    if (runtime === "grok") board.stop(task); // the tree-stop adapter returns before the actual child exits
    board.dispose();
    board.dispose();
    assert.deepEqual(stopped, [old.child]);
    assert.deepEqual([old.cancels, old.closes, board.codexRuns.size], [1, 1, 0]);
    const replacement = new Board(repo, path.join(repo, "hook.js"), path.join(repo, "hooks"), false);
    t.after(() => replacement.dispose());
    replacement.accountList = board.accountList;
    replacement.runAcp = board.runAcp;
    replacement.killTree = board.killTree;
    const card = replacement.get(task.id);
    assert.deepEqual([card.status, card.interrupted, card.sessionId, card.boardSessionId],
      ["review", true, task.sessionId, old.env.ENTOMATICAL_SESSION]);
    assert.equal(board.events(card.id).filter(e => e.hook_event_name === "Interrupt").length, 1);
    await assert.rejects(replacement.followUpHeadless(card, "Too soon"), /previous provider process to exit/);
    assert.equal(runs.length, 1);
    old.child.emit("exit", 0);
    await replacement.followUpHeadless(card, "Replacement turn.");
    const saved = fs.readFileSync(board.file, "utf8"), events = fs.readFileSync(board.eventsFile(card.id), "utf8");
    for (const update of [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old" } },
      { sessionUpdate: "tool_call", title: "Old tool" }, { sessionUpdate: "config_option_update" },
      { sessionUpdate: "unsupported_client_request", method: "old" }]) old.update(update);
    assert.equal(await old.permission({}), undefined);
    old.finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fs.readFileSync(board.file, "utf8"), saved);
    assert.equal(fs.readFileSync(board.eventsFile(card.id), "utf8"), events);
    assert.deepEqual(stopped, [old.child]);
    assert.equal(old.closes, 1);
    assert.deepEqual([runs.length, runs[1].closed, card.status], [2, false, "running"]);
    runs[1].finish();
    await until(() => runs[1].closed);
    runs[1].child.emit("close", 0);
  });

  test(`${runtime}: fake ACP environment can add and send as its own card across follow-ups and reload`, async (t) => {
    const { repo, board, runs } = fixture(t);
    const task = master(board, account);
    await board.startHeadless(task);
    const run = runs[0], id = run.env.ENTOMATICAL_SESSION;
    assert.ok(id);
    assert.equal(id, task.boardSessionId);
    assert.equal(boundSession(task), id);
    assert.notEqual(id, task.sessionId);
    assert.notEqual(id, "parent-controller");
    for (const key of Object.keys(run.env)) assert.ok(!["CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID"].includes(key.toUpperCase()));
    const add = await cli(board, run.cwd, ["add", "--title", "Worker", "--prompt", "Wait.", "--runtime", "claude", "--start", "manual"], run.env);
    assert.equal(add.code, 0, add.out + add.err);
    const worker = board.get(add.out.trim().split(/\s+/)[0]);
    assert.equal(worker.openedBy, task.id);
    assert.equal(worker.parentId, task.id);
    const send = await cli(board, run.cwd, ["send", worker.id, "--text", "Message from ACP."], run.env);
    assert.equal(send.code, 0, send.out + send.err);
    assert.match(board.receiveMessages(worker.id).join("\n"), new RegExp(`Message from card ${task.id}.*[\\s\\S]*Message from ACP\\.`));
    const receipts = fs.readdirSync(path.join(board.dir, "inbox", "done")).map((file) => JSON.parse(fs.readFileSync(path.join(board.dir, "inbox", "done", file), "utf8")));
    for (const op of ["add", "send"]) assert.ok(receipts.some((r) => r.op === op && r.by === task.id && r.session === id && !r.error));
    // Foreign ids cannot impersonate this card even when they name its task id.
    const refused = await cli(board, run.cwd, ["send", worker.id, "--text", "Wrong controller."], { ...run.env, ENTOMATICAL_SESSION: "parent-controller" });
    assert.equal(refused.code, 1);
    assert.match(refused.out, /Not bound/);
    run.finish();
    await until(() => run.closed);
    await board.followUpHeadless(task, "Continue.");
    assert.equal(runs[1].env.ENTOMATICAL_SESSION, id);
    assert.equal(runs[1].env.CODEX_THREAD_ID, undefined);
    assert.equal(runs[1].env.CLAUDE_CODE_SESSION_ID, undefined);
    runs[1].finish();
    await until(() => runs[1].closed);
    assert.equal(JSON.parse(fs.readFileSync(path.join(board.dir, "tasks.json"), "utf8")).find((x) => x.id === task.id).boardSessionId, id);
    board.dispose();
    const restored = new Board(repo, path.join(repo, "hook.js"), path.join(repo, "hooks"), false);
    t.after(() => restored.dispose());
    assert.equal(restored.taskEnv(restored.get(task.id)).ENTOMATICAL_SESSION, id);
  });

  test(`${runtime}: native terminal receives its card identity and rebind accepts ENTOMATICAL_SESSION only`, async (t) => {
    const { board } = fixture(t);
    let env, proc;
    board.cardTerminals.spawn = (_file, _args, options) => {
      env = options.env;
      return proc = { pid: 999, onData() {}, onExit(fn) { this.exit = fn; }, write() {}, resize() {}, kill() {} };
    };
    const task = board.add("Terminal", "Investigate.", account, undefined, runtime === "antigravity" ? "opus" : undefined);
    await board.startCardTerminal(task);
    assert.equal(env.ENTOMATICAL_TASK, task.id);
    assert.equal(env.ENTOMATICAL_REPO, board.repo);
    assert.equal(env.ENTOMATICAL_RUNTIME, runtime);
    assert.equal(env.ENTOMATICAL_SESSION, task.boardSessionId);
    const controller = task.boardSessionId;
    assert.equal(env.CODEX_THREAD_ID, undefined);
    assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
    const own = await cli(board, task.worktree, ["send", task.id, "--text", "Self message."], env);
    assert.equal(own.code, 0, own.out + own.err);
    proc.exit({ exitCode: 0 });
    await board.startCardTerminal(task);
    assert.equal(env.ENTOMATICAL_SESSION, controller);
    const detached = { ...env, ENTOMATICAL_SESSION: "detached-acp", CODEX_THREAD_ID: "foreign-codex", CLAUDE_CODE_SESSION_ID: "foreign-claude" };
    // Security audit lead 1: a session that is not the card's own is bound only once the user allows it.
    let asked = 0;
    board.confirmRebind = async () => { asked++; return false; };
    const denied = await cli(board, task.worktree, ["rebind"], detached);
    assert.equal(denied.code, 1);
    assert.match(denied.out, /Waiting for the user/);
    await until(() => asked === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(task.controller, undefined, "a refused rebind changes nothing");
    let allow;
    board.confirmRebind = () => { asked++; return new Promise((resolve) => { allow = resolve; }); };
    const rebind = await cli(board, task.worktree, ["rebind"], detached);
    assert.equal(rebind.code, 1);
    assert.match(rebind.out, /Waiting for the user/);
    const again = await cli(board, task.worktree, ["rebind"], detached);
    assert.match(again.out, /Waiting for the user/);
    assert.equal(asked, 2, "no stacked prompt while one is open");
    allow(true);
    await until(() => task.controller?.sessionId === "detached-acp");
    const rebound = await cli(board, task.worktree, ["send", task.id, "--text", "Rebound."], detached);
    assert.equal(rebound.code, 0, rebound.out + rebound.err);
    const stale = await cli(board, task.worktree, ["send", task.id, "--text", "Stale."], env);
    assert.equal(stale.code, 1);
    assert.match(stale.out, /Not bound/);
    proc.exit({ exitCode: 0 });
    await board.startCardTerminal(task);
    assert.equal(env.ENTOMATICAL_SESSION, controller);
    assert.equal(task.controller, undefined, "a successful managed restart reclaims board control");
    const restarted = await cli(board, task.worktree, ["send", task.id, "--text", "Restarted."], env);
    assert.equal(restarted.code, 0, restarted.out + restarted.err);
  });
}

test("rebind from the card's own session binds at once without asking the user", async (t) => {
  const { repo, board } = fixture(t);
  const task = master(board, "Claude");
  board.update(task, { sessionId: "own-claude" });
  board.confirmRebind = async () => { throw new Error("must not ask"); };
  const env = { ...process.env, ...board.taskEnv(task), CLAUDE_CODE_SESSION_ID: "own-claude" };
  const rebind = await cli(board, repo, ["rebind"], env);
  assert.equal(rebind.code, 0, rebind.out + rebind.err);
  assert.equal(task.controller.sessionId, "own-claude");
  assert.equal(task.controller.mode, "external");
});

for (const runtime of ["claude", "codex"]) {
  test(`${runtime}-launched CLI can add both Grok and Antigravity workers`, async (t) => {
    const { repo, board, runs } = fixture(t);
    const task = master(board, runtime === "claude" ? "Claude" : "Codex");
    board.update(task, { sessionId: `${runtime}-controller` });
    const env = { ...process.env, ...board.taskEnv(task), CLAUDE_CODE_SESSION_ID: runtime === "claude" ? task.sessionId : "foreign-claude",
      CODEX_THREAD_ID: runtime === "codex" ? task.sessionId : "foreign-codex" };
    for (const target of ["grok", "antigravity"]) {
      const result = await cli(board, repo, ["add", "--title", target, "--prompt", "Work.", "--runtime", target], env);
      assert.equal(result.code, 0, result.out + result.err);
      const child = board.get(result.out.trim());
      assert.equal(child.provider, target);
      assert.equal(child.openedBy, task.id);
      assert.equal(child.status, "running");
      const run = runs.at(-1);
      assert.equal(run.provider, target);
      assert.equal(run.env.ENTOMATICAL_SESSION, child.boardSessionId);
      assert.notEqual(run.env.ENTOMATICAL_SESSION, task.sessionId);
      assert.equal(run.env.CODEX_THREAD_ID, undefined);
      assert.equal(run.env.CLAUDE_CODE_SESSION_ID, undefined);
      const impersonating = await cli(board, run.cwd, ["send", task.id, "--text", "Act as parent."], { ...run.env, ENTOMATICAL_TASK: task.id });
      assert.equal(impersonating.code, 1);
      assert.match(impersonating.out, /Not bound/);
    }
  });
}
