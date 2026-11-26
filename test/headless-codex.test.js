const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { execFileSync } = require("node:child_process");

class VSCodeEvent {
  listeners = [];
  event = (fn) => (this.listeners.push(fn), { dispose() {} });
  fire(value) { this.listeners.forEach((fn) => fn(value)); }
  dispose() {}
}
const vscode = { EventEmitter: VSCodeEvent, ThemeIcon: class {},
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  commands: { executeCommand: async () => { throw new Error("A headless run must not open an editor"); } },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }),
    showWarningMessage: async () => undefined, showInformationMessage: async () => undefined } };
const load = Module._load;
Module._load = function (request, ...args) { return request === "vscode" ? vscode : load.call(this, request, ...args); };
const { Board } = require("../out/board.js");
const { DEFAULT_CAPS } = require("../out/orchestrator.js");

function fixture(t, beforeReply) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-headless-codex-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  board.accountList = () => [{ name: "Codex · test@example.com", provider: "codex" }];
  board.accountFolderList = () => [];
  board.codexModelIds = () => ["gpt-6.1-sol"];
  board.codexDefaultId = () => "gpt-6.1-sol"; // what model/list marks as Codex's default: a card on Default model runs it by its exact id
  board.codexConfiguredModel = async () => undefined; // Codex's config sets no model here (no Codex process is asked)
  board.setCodexName = async () => {};
  board.tick();
  const runs = [];
  board.runCodex = (args, options) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 2 ** 30,
    });
    const send = (message) => child.stdout.write(JSON.stringify(message) + "\n");
    const requests = [];
    let buffer = "";
    child.stdin.on("data", (data) => {
      buffer += data;
      let at;
      while ((at = buffer.indexOf("\n")) !== -1) {
        const request = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); requests.push(request);
        if (request.method && request.id !== undefined) {
          const result = request.method === "thread/start" || request.method === "thread/resume"
            ? { thread: { id: "real-thread" } } : {};
          queueMicrotask(() => {
            beforeReply?.(request);
            if (!child.stdout.writableEnded) send({ id: request.id, result });
          });
        }
      }
    });
    const close = () => { child.stdout.end(); child.stderr.end(); child.emit("close", 0); };
    child.stdin.once("finish", () => queueMicrotask(close));
    child.kill = () => { close(); return true; };
    runs.push({ args, options, child, requests, send });
    return child;
  };
  t.after(() => { board.dispose(); fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { repo, board, runs };
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
// 30 s, as in the other runtime tests: 5 s timed out under the full suite's load (12 November 2026); a met condition returns at once.
const until = async (condition, timeout = 30000) => {
  const deadline = performance.now() + timeout;
  while (!condition() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), "the asynchronous runtime state did not settle before the deadline");
};

test("a Codex card on a short name runs the newest id of its family at every launch (fix 11); an exact listed id is kept (F123)", async (t) => {
  const { board, runs } = fixture(t);
  let ids = ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-6-luna"];
  board.codexModelIds = () => ids;
  const master = board.add("Master", "Coordinate", "Codex · test@example.com", undefined, undefined, undefined, undefined,
    { orchestrator: { caps: DEFAULT_CAPS, opened: 0 } });
  board.update(master, { approved: { at: new Date().toISOString(), hash: "test" } });
  const child = board.add("Worker", "Report.", "Codex · test@example.com", master.id, "sol", undefined, undefined, { headless: true, openedBy: master.id, watchedBy: master.id });
  assert.equal(board.add("Exact", "Report.", "Codex · test@example.com", undefined, "gpt-5.6-sol").model, "gpt-5.6-sol", "an exact listed id is stored as picked (F123)");
  assert.equal(child.model, "sol");
  assert.equal(board.modelOf(child), "gpt-6.1-sol", "Session details: sol → gpt-6.1-sol");
  ids = [...ids, "gpt-6.2-sol"]; // a release after the card was added
  await board.startHeadless(child);
  assert.equal(runs[0].requests.find((r) => r.method === "thread/start").params.model, "gpt-6.2-sol");
  assert.equal(board.statusOf(child).launchState, "confirmed");
  runs[0].send({ method: "turn/completed", params: { threadId: "real-thread", turn: { status: "completed" } } });
  await settle();
  assert.throws(() => board.add("Bad", "x", "Codex · test@example.com", undefined, "zeta"), /Unknown model zeta\. Valid: sol, luna, or a full id of one of them\./);
  // Without an account named: a Codex short name picks Codex; gpt-oss is Antigravity's although it starts with gpt-.
  assert.equal(board.resolveAccount(undefined, "luna")?.provider, "codex");
  assert.equal(board.resolveAccount(undefined, "gpt-oss"), undefined);
  assert.equal(board.resolveAccount(undefined, "gpt-6.1-sol")?.provider, "codex");
});

test("headless Codex starts and resumes the same thread with bypass, multiline input and a retained worktree", async (t) => {
  const { board, runs } = fixture(t);
  const master = board.add("Master", "Coordinate", "Codex · test@example.com", undefined, undefined, undefined, undefined,
    { orchestrator: { caps: DEFAULT_CAPS, opened: 0 } });
  board.update(master, { approved: { at: new Date().toISOString(), hash: "test" } });
  const child = board.add("Worker", "Read the requested file outside this workspace.\nThen report.", "Codex · test@example.com", master.id,
    "gpt-6.1-sol", undefined, undefined, { headless: true, openedBy: master.id, watchedBy: master.id });
  board.update(child, { effort: "high" }); // runtime setting; provider-catalog validation is covered by the selection tests
  const launch = board.startHeadless(child);
  await assert.rejects(board.startHeadless(child), /Already starting/);
  assert.equal(await launch, undefined);
  assert.equal(child.provider, "codex");
  assert.equal(child.permission, "bypass");
  assert.equal(child.status, "running");
  assert.equal(child.sessionId, "real-thread");
  assert.equal(fs.existsSync(child.worktree), true);
  assert.equal(child.branch, `task/${child.id}`);
  const first = runs[0];
  assert.deepEqual(first.args, ["app-server", "-c", 'model_reasoning_effort="high"']);
  assert.equal(first.options.env.ENTOMATICAL_TASK, child.id);
  assert.equal(first.options.env.ENTOMATICAL_RUNTIME, "codex");
  assert.equal(first.options.env.ENTOMATICAL_PARENT, master.id);
  assert.equal(first.options.env.ENTOMATICAL_ROOT, master.id);
  assert.equal(first.options.env.ENTOMATICAL_NO_SYNC, "1");
  assert.deepEqual(first.requests.find((r) => r.method === "thread/start").params,
    { cwd: child.worktree, model: "gpt-6.1-sol", sandbox: "danger-full-access", approvalPolicy: "never" });
  assert.match(first.requests.find((r) => r.method === "turn/start").params.input[0].text, /outside this workspace\.\nThen report\./);
  assert.equal(first.requests.find((r) => r.method === "turn/start").params.effort, "high");
  first.send({ method: "item/completed", params: { threadId: "real-thread", item: { type: "agentMessage", text: "Read and reported." } } });
  first.send({ method: "turn/completed", params: { threadId: "real-thread", turn: { status: "completed" } } });
  await settle();
  assert.equal(child.status, "review");
  assert.equal(board.live().includes(child.id), false);
  assert.equal(board.events(child.id).findLast((e) => e.hook_event_name === "Stop").last_assistant_message, "Read and reported.");
  board.update(master, { deliveryReady: true, reported: true, checks: { status: "complete", run: "old" } });
  board.update(child, { checks: { status: "complete", run: "old" } });
  await board.followUpHeadless(child, "Check once more.\nPreserve the first result.");
  assert.equal(master.deliveryReady, undefined);
  assert.equal(master.reported, undefined);
  assert.equal(master.checks, undefined);
  assert.equal(child.checks, undefined);
  assert.equal(child.status, "running");
  const second = runs[1];
  assert.equal(second.requests.some((r) => r.method === "thread/start"), false);
  assert.equal(second.requests.find((r) => r.method === "thread/resume").params.threadId, "real-thread");
  assert.equal(second.requests.find((r) => r.method === "turn/start").params.effort, "high", "the selected effort is applied again to a resumed thread");
  const followup = second.requests.find((r) => r.method === "turn/start").params.input[0].text;
  assert.match(followup, new RegExp(`^Your Entomatical card is ${child.id}.*Parent card: ${master.id}`));
  assert.ok(followup.endsWith("\n\nCheck once more.\nPreserve the first result."));
  board.stop(child);
  await until(() => child.status === "review" && !board.live().includes(child.id));
  assert.equal(child.status, "review");
  assert.equal(child.interrupted, true);
  assert.equal(fs.existsSync(child.worktree), true);
});

for (const reviewer of ["Claude", "Codex"]) {
  test(`saved run: ${reviewer} reviews, corrects and integrates a worker on the other provider, then finishes`, async (t) => {
    const { repo, board, runs } = fixture(t);
    const git = (folder, ...args) => execFileSync("git", args, { cwd: folder, encoding: "utf8" }).trim();
    git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.com");
    const claude = { name: "test-claude", configDir: path.join(repo, ".entomatical", "test-account") };
    const codex = board.accountList()[0];
    board.accountList = () => [claude, codex];
    board.preflightHeadless = async () => {};
    board.requestRateMs = 0;
    const prior = vscode.window.createTerminal;
    t.after(() => { vscode.window.createTerminal = prior; });
    vscode.window.createTerminal = options => {
      const terminal = { options, processId: Promise.resolve(12345), show() {}, dispose() {
        this.exitStatus = { code: 0 };
        vscode.window.terminals = vscode.window.terminals.filter(x => x !== this);
      } };
      vscode.window.terminals.push(terminal);
      return terminal;
    };
    const controller = reviewer === "Codex" ? codex : claude, worker = reviewer === "Claude" ? codex : claude;
    const file = path.join(repo, "workflows", "cross-provider.plan.json");
    const plan = { v: 1, name: "Two providers", review: "model", reviewer: { account: controller.name },
      account: worker.name, steps: [{ id: "edit", title: "Edit a file", goal: "Commit the edited file." }] };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(plan));
    git(repo, "add", "workflows"); git(repo, "commit", "-qm", "plan");
    const original = git(repo, "rev-parse", "HEAD");
    const { card, steps: [child] } = await board.runPlan(plan, file);
    const event = (task, data) => {
      fs.appendFileSync(board.eventsFile(task.id), JSON.stringify({ t: Date.now(), session_id: task.sessionId, ...data }) + "\n");
      board.syncStatus(task.id);
    };
    for (const task of [card, child]) if (!task.provider) event(task, { hook_event_name: "SessionStart" });
    assert.equal(child.openedBy, card.id);
    assert.equal(board.everReady(child), true);
    const end = async task => {
      if (task.provider === "codex") {
        runs.at(-1).send({ method: "turn/completed", params: { threadId: task.sessionId, turn: { status: "completed" } } });
      } else {
        board.terminal(task).dispose();
        event(task, { hook_event_name: "Stop", last_assistant_message: "Ready for review." });
      }
      await until(() => task.status === "review" && !board.hasProcess(task));
    };
    const ask = (op, extra = {}) => board.handleRequest({ v: 1, op, by: card.id, session: card.sessionId, ...extra }, require("node:crypto").randomUUID());
    await end(child);
    const sent = await ask("send", { id: child.id, text: "Correct the file.\nCommit the reviewed change." });
    assert.equal(sent.queued, true, JSON.stringify(sent));
    await until(() => board.hasProcess(child) && child.status === "running");
    const delivered = child.provider === "codex"
      ? runs.at(-1).requests.find(r => r.method === "turn/start").params.input[0].text
      : fs.readFileSync(path.join(board.dir, "launch", `${child.id}.followup.txt`), "utf8");
    assert.match(delivered, /Correct the file\.\nCommit the reviewed change\./);
    fs.writeFileSync(path.join(child.worktree, "reviewed.txt"), "corrected\n");
    git(child.worktree, "add", "reviewed.txt"); git(child.worktree, "commit", "-qm", "corrected");
    const revision = git(child.worktree, "rev-parse", "HEAD");
    await end(child);
    assert.match((await ask("done", { id: child.id })).error, /has not landed/);
    assert.equal(child.status, "review");
    const accepted = await ask("integrate", { id: child.id });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(accepted.integrated.head, revision);
    assert.equal(git(card.worktree, "show", "HEAD:reviewed.txt"), "corrected");
    assert.equal(child.status, "done");
    assert.deepEqual((await ask("integrate", { id: child.id })).integrated, accepted.integrated);
    assert.equal(git(repo, "rev-parse", "HEAD"), original);
    const ready = await ask("ready");
    assert.equal(ready.ok, true, JSON.stringify(ready));
    await end(card);
    const finished = await board.complete(card, async () => true, undefined, undefined, undefined, {
      message: async () => "Finish reviewed work", resolve: async () => { throw new Error("Unexpected conflict"); }
    });
    assert.ok(finished);
    assert.equal(card.status, "done");
    assert.equal(git(repo, "show", "HEAD:reviewed.txt"), "corrected");
  });
}

test("a paused or unapproved run cannot start a held child through a direct runtime call", async (t) => {
  const { board, runs } = fixture(t);
  const master = board.add("Master", "Coordinate", "Codex", undefined, undefined, undefined, undefined,
    { orchestrator: { caps: DEFAULT_CAPS, opened: 0 } });
  const child = board.add("Worker", "A bounded task", "Codex", master.id, undefined, undefined, undefined,
    { headless: true, openedBy: master.id, held: true });
  await assert.rejects(board.startHeadless(child), /Plan not approved/);
  assert.equal(child.worktree, undefined);
  board.update(master, { approved: { at: "now", hash: "test" }, paused: true });
  await assert.rejects(board.startHeadless(child), /Run paused/);
  assert.equal(child.worktree, undefined);
  assert.equal(runs.length, 0);
});

test("pausing during worktree preparation prevents the prepared child from launching", async (t) => {
  const { board, runs } = fixture(t);
  const master = board.add("Master", "Coordinate", "Codex", undefined, undefined, undefined, undefined,
    { orchestrator: { caps: DEFAULT_CAPS, opened: 0 }, approved: { at: "now", hash: "test" } });
  const child = board.add("Worker", "A bounded task", "Codex", master.id, undefined, undefined, undefined,
    { headless: true, openedBy: master.id });
  board.beforeStart = async () => { board.pauseRun(master); };
  await assert.rejects(board.startHeadless(child), /Run paused/);
  assert.equal(runs.length, 0);
  assert.equal(child.sessionId, undefined);
  assert.equal(fs.existsSync(child.worktree), true, "the prepared worktree is preserved for resume");
});

for (const action of ["pause", "stop"]) {
  test(`a run ${action} during Codex's thread handshake prevents the worker prompt`, async t => {
    const { board, runs } = fixture(t, request => {
      if (request.method !== "thread/start") return;
      if (action === "pause") board.pauseRun(root);
      else assert.equal(board.stopRun(root), 1, "Stop finds the process before it has a provider thread ID");
    });
    const acct = board.accountList()[0].name;
    const root = board.add("Controller", "Lead.", acct, undefined, undefined, undefined, undefined,
      { orchestrator: { caps: DEFAULT_CAPS, opened: 0 }, approved: { at: "now", hash: "test" } });
    const child = board.add("Worker", "Do not submit this prompt.", acct, root.id, undefined, undefined, undefined,
      { headless: true, openedBy: root.id, held: true });
    await assert.rejects(board.startHeadless(child), /paused|stopped|closed|exited/i);
    assert.ok(root.paused);
    assert.deepEqual([child.status, child.held, child.sessionId], ["queued", true, undefined]);
    assert.equal(runs[0].requests.some(r => r.method === "turn/start"), false);
    assert.equal(board.events(child.id).some(e => e.hook_event_name === "UserPromptSubmit"), false);
  });
}

test("a headless Codex approval request becomes needs-input instead of disappearing into an unattended refusal", async (t) => {
  const { board, runs } = fixture(t);
  board.requestRateMs = 0;
  const master = board.add("Master", "Coordinate", "Codex", undefined, undefined, undefined, undefined,
    { orchestrator: { caps: DEFAULT_CAPS, opened: 0 }, approved: { at: "now", hash: "test" }, sessionId: "master-session" });
  const task = board.add("Worker", "Do the work", "Codex · test@example.com", master.id, undefined, undefined, undefined, { headless: true, openedBy: master.id });
  await board.startHeadless(task);
  runs[0].send({ id: 71, method: "item/commandExecution/requestApproval", params: { threadId: "real-thread", reason: "External tool needs consent" } });
  await settle();
  assert.equal(task.status, "needs-input");
  assert.equal(board.events(task.id).at(-1).message, "External tool needs consent");
  assert.equal(runs[0].requests.find((r) => r.id === 71).error.message, "Nobody is attending this session.");
  runs[0].send({ method: "item/completed", params: { threadId: "real-thread", item: { type: "commandExecution" } } });
  runs[0].send({ method: "turn/completed", params: { threadId: "real-thread", turn: { status: "completed" } } });
  await settle();
  assert.equal(task.status, "needs-input", "completion must not hide the unanswered prompt");
  assert.equal(board.live().includes(task.id), false);
  assert.equal(board.events(task.id).at(-1).message, "External tool needs consent");
  const request = (op) => board.handleRequest({ v: 1, at: "now", op, by: master.id, session: master.sessionId, id: task.id }, op);
  assert.match((await request("cancel")).error, /Stop the card/);
  board.external.set(task.sessionId, { sessionId: task.sessionId, pid: 2 ** 30 });
  board.killSession = () => true;
  board.stop(task);
  assert.equal(task.status, "needs-input", "Stop waits for a real external session to exit before changing its state");
  board.external.delete(task.sessionId);
  const recordedEvents = board.events(task.id).length;
  board.stop(task);
  assert.equal(task.status, "review");
  assert.equal(task.interrupted, true);
  assert.equal(fs.existsSync(task.worktree), true);
  assert.equal(board.events(task.id).length, recordedEvents);
  assert.equal(board.events(task.id).at(-1).message, "External tool needs consent");
  assert.equal((await request("cancel")).ok, true);
  assert.equal(task.cancelled, true);
  assert.equal(board.runSummaryOf(master).done, 0);
});

test("a live adopted Codex card applies pending Bypass and releases its detached controller only after a successful managed restart", async (t) => {
  const { board, runs } = fixture(t);
  board.requestRateMs = 0;
  const master = board.add("Master", "Coordinate", "Codex", undefined, undefined, undefined, undefined,
    { orchestrator: { caps: DEFAULT_CAPS, opened: 0 }, approved: { at: "now", hash: "test" }, sessionId: "master-session",
      runPolicy: { allow: ["read authorized outside reference"], deny: ["publish to production"], noSync: true } });
  const child = board.add("Existing card", "ORIGINAL_TASK_MUST_NOT_REPEAT", "Codex", undefined, undefined, undefined, undefined,
    { headless: true, permission: "ask" });
  await board.startHeadless(child);
  const request = (body, nonce) => board.handleRequest({ v: 1, at: "now", ...body }, nonce);
  board.confirmRebind = async () => true; // the user clicks Allow
  assert.match((await request({ op: "rebind", by: child.id, session: "detached-controller" }, "rebind")).error, /Waiting for the user/);
  await new Promise((resolve) => setImmediate(resolve)); // the user's Allow binds after the answer
  const target = { by: master.id, session: master.sessionId, id: child.id };
  assert.match((await request({ op: "adopt", ...target }, "adopt")).error, /took card .* over/);
  assert.equal((await request({ op: "request-takeover", ...target, reason: "Resume this worker in my run" }, "request-transfer")).ok, true);
  board.approveTakeover(child.id, child.takeoverAsk);
  assert.equal(child.permission, "ask", "adoption cannot change an already-running sandbox");
  assert.equal(child.pendingPermission, "bypass");
  assert.equal(child.controller.sessionId, "detached-controller");
  runs[0].send({ method: "turn/completed", params: { threadId: "real-thread", turn: { status: "completed" } } });
  await settle();
  const runner = board.runCodex;
  board.runCodex = () => { throw new Error("temporary runner failure"); };
  await assert.rejects(board.followUpHeadless(child, "resume"), /temporary runner failure/);
  assert.equal(child.permission, "ask");
  assert.equal(child.pendingPermission, "bypass");
  assert.equal(child.controller.sessionId, "detached-controller");
  board.runCodex = runner;
  board.queueNotice(child.id, "message:test", "PENDING_MESSAGE_ONLY_ONCE");
  await board.followUpHeadless(child, "resume");
  assert.equal(child.permission, "bypass");
  assert.equal(child.pendingPermission, undefined);
  assert.equal(child.controller, undefined);
  const resumed = runs[1].requests.find((r) => r.method === "thread/resume");
  assert.equal(resumed.params.sandbox, "danger-full-access");
  assert.equal(resumed.params.approvalPolicy, "never");
  const prompt = runs[1].requests.find((r) => r.method === "turn/start").params.input[0].text;
  assert.match(prompt, new RegExp(`Parent card: ${master.id}\\. Root orchestrator: ${master.id}`));
  assert.match(prompt, /allowed: read authorized outside reference; denied: publish to production/);
  assert.ok(prompt.endsWith("\n\nresume"));
  assert.doesNotMatch(prompt, /ORIGINAL_TASK_MUST_NOT_REPEAT|PENDING_MESSAGE_ONLY_ONCE/);
  assert.deepEqual(board.receiveMessages(child.id), ["PENDING_MESSAGE_ONLY_ONCE"], "refreshing run context does not consume or duplicate the separate inbox");
  assert.equal((await request({ op: "receive", by: child.id, session: child.sessionId }, "receive")).ok, true);
  board.stop(child);
  await until(() => !board.live().includes(child.id));
});

test("ordinary headless turns keep their original prompt and multiline follow-up unchanged", async (t) => {
  const { board, runs } = fixture(t);
  const task = board.add("Ordinary card", "Original ordinary task.\nSecond line.", "Codex", undefined, undefined, undefined, undefined, { headless: true });
  await board.startHeadless(task);
  assert.equal(runs[0].requests.find((r) => r.method === "turn/start").params.input[0].text, "Original ordinary task.\nSecond line.");
  assert.equal("effort" in runs[0].requests.find((r) => r.method === "turn/start").params, false, "an unset effort keeps the provider default");
  runs[0].send({ method: "turn/completed", params: { threadId: "real-thread", turn: { status: "completed" } } });
  await settle();
  await board.followUpHeadless(task, "Ordinary follow-up.\nSecond line.");
  assert.equal(runs[1].requests.find((r) => r.method === "turn/start").params.input[0].text, "Ordinary follow-up.\nSecond line.");
  board.stop(task);
  await until(() => !board.live().includes(task.id));
});

test("a failed headless Codex launch rejects and clears the placeholder session without a successful stop", async (t) => {
  const { board } = fixture(t);
  board.runCodex = () => { throw new Error("configured runner missing"); };
  const task = board.add("Worker", "Do the work", "Codex · test@example.com", undefined, undefined, undefined, undefined, { headless: true });
  await assert.rejects(board.startHeadless(task), /configured runner missing/);
  assert.equal(task.sessionId, undefined);
  assert.equal(board.everReady(task), false);
  assert.equal(board.events(task.id).some((e) => e.hook_event_name === "Stop"), false);
});

test("research roles use the Codex read-only sandbox even when the run defaults to bypass", async (t) => {
  const { board, runs } = fixture(t);
  const master = board.add("Master", "Coordinate", "Codex", undefined, undefined, undefined, undefined,
    { orchestrator: { caps: DEFAULT_CAPS, opened: 0 }, approved: { at: "now", hash: "test" } });
  const research = board.add("Research", "Answer with evidence", "Codex", master.id, undefined, undefined, undefined,
    { headless: true, openedBy: master.id, role: "research", permission: "bypass" });
  await board.startHeadless(research);
  const started = runs[0].requests.find((r) => r.method === "thread/start").params;
  assert.equal(started.sandbox, "read-only");
  assert.equal(started.model, "gpt-6.1-sol", "a card on Default model starts its thread on Codex's default, by its exact id (17 November 2026)");
  board.stop(research);
  await until(() => !board.live().includes(research.id));
});

test("a checks-reviewed plan starts a Codex worker through the app server and merges its accepted work", async (t) => {
  const { repo, board, runs } = fixture(t);
  const codex = require("../out/codex.js");
  const previousModels = codex.codexModels, previousEffort = codex.codexEffortOk;
  codex.codexModels = () => [{ model: "gpt-6.1-sol", efforts: ["low", "high"] }];
  codex.codexEffortOk = (model, effort) => model === "gpt-6.1-sol" && ["low", "high"].includes(effort);
  t.after(() => { codex.codexModels = previousModels; codex.codexEffortOk = previousEffort; });
  fs.mkdirSync(path.join(repo, "workflows"));
  fs.writeFileSync(path.join(repo, "workflows", "checks.json"), JSON.stringify({ unit: { run: "echo safe" } }));
  board.checks.start = (t) => board.recordChecks(t, { status: "running", run: "mock", revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: t.worktree, encoding: "utf8" }).trim() });
  const plan = { v: 1, name: "Codex plan", review: "checks", account: "Codex · test@example.com", permission: "auto", model: "gpt-6.1-sol", effort: "high",
    steps: [{ id: "work", title: "Codex worker", goal: "Report.", checks: ["unit"] }] };
  const { card, steps: [worker] } = await board.runPlan(plan, path.join(repo, "workflows", "test.plan.json"));
  assert.equal(card.provider, "codex");
  assert.equal(worker.provider, "codex");
  assert.equal(worker.status, "running");
  const run = runs[0];
  assert.equal(run.requests.find((r) => r.method === "thread/start").params.approvalPolicy, "on-request");
  assert.equal(run.requests.find((r) => r.method === "turn/start").params.effort, "high", "the workflow approval reaches the worker turn");
  assert.match(run.requests.find((r) => r.method === "turn/start").params.input[0].text, /Step 1 of 1 of plan "Codex plan"/);
  run.send({ method: "item/completed", params: { threadId: "real-thread", item: { type: "agentMessage", text: "Reported." } } });
  run.send({ method: "turn/completed", params: { threadId: "real-thread", turn: { status: "completed" } } });
  await until(() => worker.status === "review" && !board.live().includes(worker.id));
  await until(() => worker.checks?.status === "running");
  board.recordChecks(worker, { status: "complete", run: "test-log", revision: worker.checks.revision });
  await until(() => worker.status === "done", 10000);
  assert.equal(card.deliveryReady, true);
});

test("a Codex root's pressure watcher runs Sol at medium, not the root's model and effort (F73)", async (t) => {
  const { board, runs } = fixture(t);
  const codex = require("../out/codex.js");
  const previousModels = codex.codexModels, previousEffort = codex.codexEffortOk;
  codex.codexModels = () => [{ model: "gpt-6.1-sol", efforts: ["low", "medium", "high"] }, { model: "gpt-6.1-terra", efforts: ["low", "medium", "high"] }];
  codex.codexEffortOk = (model, effort) => ["low", "medium", "high"].includes(effort);
  t.after(() => { codex.codexModels = previousModels; codex.codexEffortOk = previousEffort; });
  board.codexModelIds = () => ["gpt-6.1-sol", "gpt-6.1-terra"];
  board.preflightHeadless = async () => {};
  board.requestRateMs = 0;
  board.watcherPath = path.join(__dirname, "..", "docs", "orchestrator", "WATCHER.md");
  const root = board.add("Codex run", "Coordinate.", "Codex · test@example.com", undefined, "terra", "high", undefined,
    { orchestrator: { caps: { ...DEFAULT_CAPS, pending: 2, open: 3 }, opened: 0, session: "ctl" }, headless: true, approved: { at: "now", hash: "h", pressureWatchers: true } });
  board.update(root, { status: "running" });
  const a = board.add("A", "a", "Codex · test@example.com", root.id, undefined, undefined, undefined, { openedBy: root.id, watchedBy: root.id });
  const b = board.add("B", "b", "Codex · test@example.com", root.id, undefined, undefined, undefined, { openedBy: root.id, watchedBy: root.id });
  board.update(a, { status: "review" }); board.update(b, { status: "review" });
  await until(() => board.tasks.some((x) => x.role === "sub" && board.live().includes(x.id)));
  const watcher = board.tasks.find((x) => x.role === "sub");
  assert.deepEqual([watcher.provider, watcher.account, watcher.model, watcher.effort], ["codex", root.account, "sol", "medium"]);
  const requests = runs.at(-1).requests, thread = requests.find((r) => r.method === "thread/start").params, turn = requests.find((r) => r.method === "turn/start").params;
  assert.deepEqual([thread.model, turn.effort], ["gpt-6.1-sol", "medium"], "the launch runs the newest Sol at medium");
  assert.match(watcher.prompt, /^You are a pressure watcher on an Entomatical run\./);
  assert.ok(watcher.prompt.includes(`Root: ${root.id}`));
});

// Exact ids only (the user, 17 November 2026): a Codex launch reads Codex's model list again when it is not known yet (a start right after
// a window reload), and with still no exact id it is refused before the card changes: no session, no Codex process, no prompt sent.
test("exact ids: a Codex start re-reads the model list once when it is unknown; with no default it refuses and the card stays unstarted", async (t) => {
  const { board, runs } = fixture(t);
  let ids = [], fallback, reads = 0;
  board.codexModelIds = () => ids;
  board.codexDefaultId = () => fallback;
  board.discoverCodexModels = async () => { reads++; };
  const master = board.add("Master", "Coordinate", "Codex", undefined, undefined, undefined, undefined,
    { orchestrator: { caps: DEFAULT_CAPS, opened: 0 }, approved: { at: "now", hash: "test" } });
  const child = board.add("Child", "Work", "Codex", master.id, undefined, undefined, undefined, { headless: true, openedBy: master.id, permission: "bypass" });
  await assert.rejects(board.startHeadless(child), /This Codex card uses Codex's default model, and Codex has not said which model that is/);
  assert.deepEqual([reads, runs.length, child.sessionId], [1, 0, undefined], "read once, nothing started");
  board.discoverCodexModels = async () => { reads++; ids = ["gpt-6.2-sol", "gpt-6.1-sol"]; fallback = "gpt-6.2-sol"; };
  await board.startHeadless(child);
  assert.equal(reads, 2);
  assert.equal(runs[0].requests.find((r) => r.method === "thread/start").params.model, "gpt-6.2-sol", "Codex's default, by its exact id");
  board.stop(child);
  await until(() => !board.live().includes(child.id));
});

// Review of task/exactids, 17 November 2026: with no -m Codex runs the `model` its config.toml sets (gpt-6.1-sol here) even when
// model/list marks another as default (gpt-6.2-sol), so a Default-model card is handed the configured one; a follow-up resumes the
// thread on the model it ran on, even after the config or the list moved.
test("exact ids: Default model runs the model Codex's config sets, over model/list's default; a follow-up keeps the thread's model", async (t) => {
  const { board, runs } = fixture(t);
  let configured = "gpt-6.1-sol";
  const asked = [];
  board.codexModelIds = () => ["gpt-6.2-sol", "gpt-6.1-sol"];
  board.codexDefaultId = () => "gpt-6.2-sol";
  board.codexConfiguredModel = async (cwd) => { asked.push(cwd); return configured; };
  const master = board.add("Master", "Coordinate", "Codex", undefined, undefined, undefined, undefined,
    { orchestrator: { caps: DEFAULT_CAPS, opened: 0 }, approved: { at: "now", hash: "test" } });
  const child = board.add("Child", "Work", "Codex", master.id, undefined, undefined, undefined, { headless: true, openedBy: master.id, permission: "bypass" });
  await board.startHeadless(child);
  assert.equal(runs[0].requests.find((r) => r.method === "thread/start").params.model, "gpt-6.1-sol", "the configured model, not model/list's default");
  // F92: read first for the folder the card branches from (before its worktree exists), then in its own worktree.
  assert.deepEqual([asked, child.sentModel, board.modelOf(child)], [[board.repo, child.worktree], "gpt-6.1-sol", "gpt-6.1-sol"]);
  runs[0].send({ method: "turn/completed", params: { threadId: "real-thread", turn: { status: "completed" } } });
  await until(() => !board.live().includes(child.id));
  configured = undefined;
  await board.followUpHeadless(child, "Next.");
  assert.equal(runs[1].requests.find((r) => r.method === "thread/resume").params.model, "gpt-6.1-sol", "the resumed thread keeps its model");
  board.stop(child);
  await until(() => !board.live().includes(child.id));
});
