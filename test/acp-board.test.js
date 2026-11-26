const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { execFileSync } = require("node:child_process");
require("./safe-temp").assertSafeTemp();

class VSCodeEvent {
  listeners = [];
  event = (fn) => (this.listeners.push(fn), { dispose() {} });
  fire(value) { this.listeners.forEach((fn) => fn(value)); }
  dispose() {}
}
const vscode = { EventEmitter: VSCodeEvent, ThemeIcon: class {},
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }),
    showWarningMessage: async () => undefined, showInformationMessage: async () => undefined } };
const load = Module._load;
Module._load = function (request, ...args) { return request === "vscode" ? vscode : load.call(this, request, ...args); };
const { Board, cardTerminalTurnNote } = require("../out/board.js");
const CARD_TERMINAL_TURN_NOTE = cardTerminalTurnNote(path.join(os.homedir(), ".entomatical", "board.js")); // Board's default boardCli
const { AcpSession } = require("../out/acp.js");
const { DEFAULT_CAPS } = require("../out/orchestrator.js");
const until = async (fn) => {
  const end = Date.now() + 30000; // 5 s timed out under the full suite's load (11 November 2026); a met condition returns at once
  while (!fn() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fn(), "runtime state did not settle");
};

test("Grok and Antigravity cards start, follow up using the same session and switch without carrying credentials", async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-acp-board-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  const approvalDetails = [];
  vscode.window.showWarningMessage = async (_message, options, ...choices) => { approvalDetails.push(options.detail); return choices[0]; };
  board.accountList = () => [{ name: "Grok · Work", provider: "grok", configDir: "/grok/work" },
    { name: "Grok · work", provider: "grok", configDir: "/grok/work-lower" },
    { name: "Grok · Personal", provider: "grok", configDir: "/grok/personal" },
    { name: "Antigravity · Shared", provider: "antigravity", configDir: "" }, { name: "Claude", configDir: "" }];
  board.accountFolderList = () => [];
  board.tick();
  t.after(() => { board.dispose(); fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const runs = [];
  board.probeAcpCatalogs = false; // F92 catalog probe: checked in refused-start.test.js; these fakes count every session
  board.runAcp = (provider, cwd, profile, update, permission, env) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 2 ** 30 });
    const requests = [], replies = [];
    let buffer = "", promptId;
    const configOptions = [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "model-s1", options: [{ value: "model-s1", name: "Small" }, { value: "model-l1", name: "Large" }] },
      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "ask", options: [{ value: "ask", name: "Ask" }, { value: "bypass", name: "Bypass" }] }];
    const send = (x) => child.stdout.write(JSON.stringify(x) + "\n");
    child.stdin.on("data", (data) => {
      buffer += data;
      while (buffer.includes("\n")) {
        const n = buffer.indexOf("\n"), m = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
        if (!m.method) { replies.push(m); continue; }
        requests.push(m);
        if (m.method === "session/prompt") { promptId = m.id; continue; }
        const result = m.method === "initialize" ? { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } }
          : m.method === "session/new" ? { sessionId: `${provider}-session`, configOptions }
          : m.method === "session/resume" ? { configOptions }
          : m.method === "session/set_config_option" ? { configOptions: configOptions.map((o) => o.id === m.params.configId ? { ...o, currentValue: m.params.value } : o) } : {};
        if (m.id !== undefined) queueMicrotask(() => send({ jsonrpc: "2.0", id: m.id, result }));
      }
    });
    child.kill = () => { child.emit("exit", 0); return true; };
    const finish = (id, text) => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    };
    const permissionRequest = (id, call, options = [{ optionId: "allow", name: "Allow once", kind: "allow_once" }]) => send({ jsonrpc: "2.0", id, method: "session/request_permission", params: {
      sessionId: `${provider}-session`, toolCall: call, options } });
    const chunk = (kind, text) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: `${provider}-session`, update: { sessionUpdate: kind, content: { type: "text", text } } } });
    const unsupportedRequest = (id) => send({ jsonrpc: "2.0", id, method: "elicitation/create", params: { sessionId: `${provider}-session` } });
    const optionsUpdate = (opts) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: `${provider}-session`, update: { sessionUpdate: "config_option_update", configOptions: opts } } });
    runs.push({ provider, cwd, profile, env, child, requests, replies, finish, permissionRequest, unsupportedRequest, optionsUpdate, chunk });
    return new AcpSession(child, update, permission);
  };
  const task = board.add("Task", "Investigate.", "Grok · Work");
  assert.equal(board.resolveAccount("Grok · work").configDir, "/grok/work-lower");
  assert.throws(() => board.resolveAccount("GROK · WORK"), /ambiguous/);
  assert.equal(task.provider, "grok");
  assert.equal(task.configDir, "/grok/work");
  await board.start(task);
  assert.equal(task.sessionId, "grok-session");
  assert.equal(task.status, "running");
  fs.mkdirSync(path.join(board.dir, "stream"), { recursive: true });
  fs.writeFileSync(path.join(board.dir, "stream", `${task.id}.jsonl`), JSON.stringify({ type: "assistant", timestamp: "2999-01-01T00:00:00Z", message: { content: [{ type: "text", text: "old Claude stream" }] } }) + "\n");
  assert.notEqual(board.doingOf(task)?.text, "old Claude stream", "ACP activity must not read a previous provider's stream");
  assert.equal(board.firstTurn().includes(task.id), false, "ACP must not be hidden behind the Codex first-turn UI");
  assert.equal(runs[0].env.ENTOMATICAL_SESSION, task.boardSessionId, "the board issues its own controller identity");
  assert.notEqual(task.boardSessionId, task.sessionId, "the controller is independent of the provider conversation");
  runs[0].chunk("agent_thought_chunk", "hidden reasoning");
  runs[0].chunk("agent_message_chunk", "First ");
  runs[0].chunk("agent_message_chunk", "result.");
  await until(() => board.prompts(task).at(-1)?.reply === "First result.");
  assert.equal(board.prompts(task).at(-1).replyStatus, "partial");
  assert.equal(board.lastReply(task), undefined);
  assert.equal(board.finalReply(task), undefined);
  assert.equal(JSON.stringify(board.events(task.id)).includes("hidden reasoning"), false);
  runs[0].chunk("tool_call", "");
  runs[0].chunk("agent_message_chunk", "Then done.");
  await until(() => board.prompts(task).at(-1)?.reply === "First result.\n\nThen done.");
  runs[0].permissionRequest("allow-request", { title: "Run command", rawInput: { command: "npm test" } });
  await until(() => runs[0].replies.length === 1);
  assert.match(approvalDetails[0], /Run command/);
  assert.match(approvalDetails[0], /npm test/);
  assert.equal(runs[0].replies[0].result.outcome.optionId, "allow");
  runs[0].optionsUpdate([{ id: "model", name: "Model", category: "model", type: "select", currentValue: "model-s1", options: [{ value: "model-s1", name: "Small" }, { value: "model-l1", name: "Large" }] },
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "ask", options: [{ value: "bypass", name: "Bypass" }] }]);
  await until(() => task.acpOptions?.find((item) => item.id === "mode")?.values.length === 1);
  const worktree = task.worktree;
  runs[0].finish("grok-session", "");
  await until(() => task.status === "review" && !board.live().includes(task.id));
  assert.equal(board.lastReply(task), "Then done.", "the headline is the last message, after the tool call");
  assert.equal(board.finalReply(task), "First result.\n\nThen done.", "text before and after a tool call does not run together (F87)");
  assert.equal(board.prompts(task).at(-1).replyStatus, undefined, "a completed answer is no longer partial");
  assert.throws(() => board.selectAcpOption(task, "mode", "bypass"), /not yet selectable/);
  assert.throws(() => board.selectAcpOption(task, "model", "unknown"), /not currently advertised/);
  board.update(task, { acpSelections: { mode: "bypass" } }); // persisted task metadata is not an authorization boundary
  await assert.rejects(board.followUpHeadless(task, "Must not run."), /no longer offers a selectable mode/);
  assert.equal(runs[1].requests.some((r) => r.method === "session/prompt"), false);
  board.selectAcpOption(task, "mode", "");
  board.selectAcpOption(task, "model", "model-l1");
  await board.followUpHeadless(task, "Continue.");
  assert.equal(runs[2].requests.find((r) => r.method === "session/resume").params.sessionId, "grok-session");
  assert.equal(runs[2].env.ENTOMATICAL_SESSION, runs[0].env.ENTOMATICAL_SESSION, "follow-ups retain the card's controller");
  assert.equal(runs[2].requests.find((r) => r.method === "session/set_config_option").params.value, "model-l1");
  runs[2].finish("grok-session", "Second result.");
  await until(() => task.status === "review" && !board.live().includes(task.id));
  assert.equal(board.lastReply(task), "Second result.");
  assert.equal(board.switchAccount(task, "Grok · Personal"), "start");
  assert.equal(task.sessionId, undefined);
  assert.equal(task.configDir, "/grok/personal");
  assert.equal(task.worktree, worktree);
  await board.start(task);
  assert.equal(runs[3].profile, "/grok/personal");
  assert.equal(runs[3].requests.some((r) => r.method === "session/resume"), false);
  runs[3].finish("grok-session", "Personal result.");
  await until(() => task.status === "review" && !board.live().includes(task.id));
  assert.equal(board.switchAccount(task, "Antigravity · Shared"), "start");
  assert.equal(task.sessionId, undefined);
  assert.equal(task.worktree, worktree);
  await board.start(task);
  assert.equal(runs[4].provider, "antigravity");
  assert.equal(task.sessionId, "antigravity-session");
  runs[4].permissionRequest("blind-request", { title: "Do something" });
  await until(() => runs[4].replies.length === 1);
  assert.equal(runs[4].replies[0].result.outcome.outcome, "cancelled");
  assert.equal(approvalDetails.length, 1, "an undescribed request never opens a blind approval dialog");
  for (const [id, call] of [["empty-object", { title: "Run command", rawInput: {} }], ["empty-array", { title: "Run command", rawInput: [] }],
    ["blank", { title: "Run command", rawInput: { command: " " }, locations: [{ path: " " }], content: [{ type: "content", content: { type: "text", text: "" } }] }]]) {
    runs[4].permissionRequest(id, call);
    await until(() => runs[4].replies.some((reply) => reply.id === id));
    assert.equal(runs[4].replies.find((reply) => reply.id === id).result.outcome.outcome, "cancelled");
  }
  runs[4].permissionRequest("unknown-kind", { title: "Run command", rawInput: { command: "npm test" } }, [{ optionId: "yes", name: "Allow", kind: "unknown" }]);
  await until(() => runs[4].replies.some((reply) => reply.id === "unknown-kind"));
  assert.equal(runs[4].replies.find((reply) => reply.id === "unknown-kind").result.outcome.outcome, "cancelled");
  assert.equal(approvalDetails.length, 1, "empty and unsupported requests never display an approval");
  runs[4].permissionRequest("reject-file", { title: "Edit file", locations: [{ path: "src/index.ts" }] }, [{ optionId: "reject", name: "No", kind: "reject_once" }]);
  await until(() => runs[4].replies.some((reply) => reply.id === "reject-file"));
  assert.match(approvalDetails[1], /src\/index\.ts/);
  assert.equal(runs[4].replies.find((reply) => reply.id === "reject-file").result.outcome.optionId, "reject");
  runs[4].unsupportedRequest("question");
  await until(() => runs[4].replies.some((reply) => reply.id === "question"));
  assert.equal(runs[4].replies.find((reply) => reply.id === "question").error.code, -32601);
  runs[4].finish("antigravity-session", "Done.");
  await until(() => task.status === "review" && !board.live().includes(task.id));
  assert.equal(task.interrupted, true, "an unanswered agent question must not count as success");
  assert.match(board.events(task.id).at(-1).error, /Unsupported agent request: elicitation\/create/);
  assert.equal(board.prompts(task).at(-1).reply, "Done.");
  assert.equal(board.prompts(task).at(-1).replyStatus, "partial");
  assert.equal(board.finalReply(task), undefined, "failed text is never a completed result");
  await board.followUpHeadless(task, "Try again.");
  const interruptedText = "Interrupted work" + "!".repeat(700);
  runs[5].chunk("agent_message_chunk", interruptedText);
  await until(() => board.prompts(task, Infinity).at(-1)?.reply === interruptedText);
  board.stop(task);
  await until(() => task.status === "review" && !board.live().includes(task.id));
  assert.equal(task.interrupted, true);
  assert.equal(board.prompts(task).at(-1).replyStatus, "partial");
  assert.equal(board.prompts(task).at(-1).reply, interruptedText.slice(0, 600), "the card has a bounded preview");
  assert.equal(board.prompts(task, Infinity).at(-1).reply, interruptedText, "Open retains the full partial reply");
  assert.equal(board.finalReply(task), undefined);
  assert.equal(board.switchAccount(task, "Claude"), "start");
  assert.equal(task.headless, undefined, "ordinary ACP management must not enable unattended Claude");
  assert.equal(task.permission, undefined, "switching must not silently enable bypass");

  board.update(task, { sessionId: "old-claude-session", controller: { sessionId: "old-controller", at: "now", mode: "external" }, takenOver: true });
  assert.equal(board.switchAccount(task, "Antigravity · Shared"), "start");
  assert.equal(task.controller, undefined, "the old provider's external controller must not follow the switch");
  assert.equal(task.takenOver, undefined);
  assert.equal(board.refusalOf({ v: 1, op: "rebind", by: task.id, session: "new-controller", nonce: "n" }), undefined);
  const coordinator = board.add("Coordinator", "Plan.", "Claude", undefined, undefined, undefined, undefined,
    { orchestrator: { caps: DEFAULT_CAPS, opened: 0 }, headless: true });
  assert.equal(board.canSwitch(coordinator, "Grok · Work"), false, "an orchestrator may move to Grok (run 0db6d1); unstarted, so no new session to confirm");

  const acpFactory = board.runAcp;
  let releaseOpen, promptCount = 0;
  board.probeAcpCatalogs = false; // F92 catalog probe: checked in refused-start.test.js; these fakes count every session
  board.runAcp = () => {
    const child = Object.assign(new EventEmitter(), { pid: 2 ** 30, kill: () => true });
    return { child, open: () => new Promise((resolve) => { releaseOpen = resolve; }), options: () => [],
      prompt: async () => { promptCount++; return "end_turn"; }, close() {} };
  };
  const duringOpen = board.add("Stop during open", "Do not run.", "Grok · Work");
  const opening = board.start(duringOpen);
  await until(() => typeof releaseOpen === "function");
  board.stop(duringOpen);
  releaseOpen("late-session");
  await assert.rejects(opening, /stopped or its board ownership changed/);
  assert.equal(promptCount, 0, "a late session/new result must not start a prompt after Stop");

  let releaseConfig;
  board.probeAcpCatalogs = false; // F92 catalog probe: checked in refused-start.test.js; these fakes count every session
  board.runAcp = () => {
    const child = Object.assign(new EventEmitter(), { pid: 2 ** 30, kill: () => true });
    return { child, open: async () => "existing-session", options: () => [{ id: "model", category: "model", name: "Model", values: [{ value: "model-l1", name: "Large" }] }],
      configure: () => new Promise((resolve) => { releaseConfig = resolve; }),
      prompt: async () => { promptCount++; return "end_turn"; }, close() {} };
  };
  const duringConfig = board.add("Stop during configuration", "Do not run.", "Grok · Work");
  board.update(duringConfig, { acpSelections: { model: "model-l1" } });
  const configuring = board.start(duringConfig);
  await until(() => typeof releaseConfig === "function");
  board.stop(duringConfig);
  releaseConfig();
  await assert.rejects(configuring, /stopped or its board ownership changed/);
  assert.equal(promptCount, 0, "a late configuration response must not start a prompt after Stop");
  assert.equal(duringConfig.sessionId, "existing-session", "an existing provider session is retained");
  assert.equal(duringConfig.interrupted, true);

  board.probeAcpCatalogs = false; // F92 catalog probe: checked in refused-start.test.js; these fakes count every session
  board.runAcp = acpFactory;
  const originalKill = board.killTree, originalIsOwner = board.isOwner;
  board.killTree = () => {}; // Windows taskkill can still be pending while the picker resolves.
  try {
    for (const reason of ["stop", "ownership"]) {
      let resolvePicker, pickerChoices;
      vscode.window.showWarningMessage = async (_message, _options, ...choices) => new Promise((resolve) => { resolvePicker = resolve; pickerChoices = choices; });
      const card = board.add(`Permission ${reason}`, "Do work.", "Grok · Work");
      await board.start(card);
      const run = runs.at(-1);
      run.permissionRequest(`permission-${reason}`, { title: "Run command", rawInput: { command: "npm test" } });
      await until(() => !!resolvePicker);
      assert.match(pickerChoices[0].title, /^Allow once/);
      const before = board.events(card.id).filter((e) => e.hook_event_name === "PostToolUse").length;
      if (reason === "stop") board.stop(card); else board.isOwner = () => false;
      resolvePicker(pickerChoices[0]);
      await until(() => run.replies.some((r) => r.id === `permission-${reason}`));
      assert.deepEqual(run.replies.find((r) => r.id === `permission-${reason}`).result.outcome, { outcome: "cancelled" });
      assert.equal(board.events(card.id).filter((e) => e.hook_event_name === "PostToolUse").length, before);
      board.isOwner = originalIsOwner;
      run.child.kill();
      await until(() => !board.live().includes(card.id));
    }
  } finally { board.killTree = originalKill; board.isOwner = originalIsOwner; }
});

test("an Antigravity card keeps its form model, effort and permission and starts its terminal with them (F88)", async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-agy-choices-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  board.accountList = () => [{ name: "Claude", configDir: "" }, { name: "Antigravity · Shared", provider: "antigravity", configDir: "" },
    { name: "Grok · Work", provider: "grok", configDir: path.join(repo, "grok") }];
  board.accountFolderList = () => [];
  board.tick();
  t.after(() => { board.dispose(); fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  let started;
  board.cardTerminals.spawn = (file, args) => { started = { file, args }; return { pid: 999, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }; };
  // What `agy models` listed on 6 November 2026 (fix 11): the terminal runs the newest id of the card's family.
  let agy = ["gemini-4-argon", "gemini-3.8-flash", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b"], discovered = 0;
  board.agyModelIds = () => agy;
  board.discoverAgy = async () => { discovered++; };
  // What `grok models` names for the profile (17 November 2026): the Grok terminal gets that exact id, never nothing.
  const grokHomes = [];
  board.grokModels = async (home) => { grokHomes.push(home); return { ids: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6"], default: "grok-4.7" }; };
  // claude-opus-5-5 is Antigravity's id here, not Claude's "opus", so the card stays on the Antigravity account; it keeps the short name.
  const task = board.add("Task", "Investigate.", "Antigravity · Shared", undefined, "claude-opus-5-5", "high", undefined, { permission: "edits" });
  assert.deepEqual([task.provider, task.account, task.model, task.effort, task.permission], ["antigravity", "Antigravity · Shared", "claude-opus-5-5", "high", "edits"], "an exact id is kept as picked (F123)");
  assert.equal(board.modelOf(task), undefined, "Session details name the id itself");
  await board.startCardTerminal(task);
  assert.deepEqual(started.args, ["--model=claude-opus-5-5", "--effort=high", "--mode=accept-edits", `--prompt-interactive=Investigate.\n\n${CARD_TERMINAL_TURN_NOTE}`]);
  // A newer release is followed with no code change; a sign-in that lists no Argon refuses rather than run another model.
  agy = [...agy, "claude-opus-5-6"];
  const newer = board.add("Newer", "Look.", "Antigravity · Shared", undefined, "opus", "low");
  await board.startCardTerminal(newer);
  assert.equal(started.args[0], "--model=claude-opus-5-6");
  agy = ["claude-opus-5-5"];
  const argon = board.add("Argon", "Look.", "Antigravity · Shared", undefined, "argon", "low");
  await assert.rejects(board.startCardTerminal(argon), /This Antigravity sign-in lists no Argon model\. It lists: claude-opus-5-5\./);
  agy = [];
  await assert.rejects(board.startCardTerminal(argon), /Antigravity has not listed its models \(agy models\)/);
  assert.equal(discovered, 1, "an empty list is read again once");
  // Carbon (the user, 14 November 2026): a card added with model carbon is accepted and runs the newest Carbon agy lists at its effort.
  agy = ["gemini-4-argon-high", "gemini-4-carbon-low", "gemini-4-carbon-medium", "gemini-4-carbon-high", "claude-opus-5-5-high"];
  const carbon = board.add("Carbon", "Look.", "Antigravity · Shared", undefined, "carbon", "medium");
  assert.deepEqual([carbon.provider, carbon.model, carbon.effort], ["antigravity", "carbon", "medium"]);
  assert.equal(board.modelOf(carbon), "gemini-4-carbon", "Session details: carbon → gemini-4-carbon");
  await board.startCardTerminal(carbon);
  assert.deepEqual(started.args.slice(0, 2), ["--model=gemini-4-carbon", "--effort=medium"]);
  agy = ["gemini-4-argon", "claude-opus-5-5"];
  assert.throws(() => board.add("Other", "x", "Antigravity · Shared", undefined, "gemini-3.8-flash", "high"), /Unknown Antigravity model gemini-3\.8-flash\. Valid models: opus, argon, carbon \(each runs its newest version\)/, "F88: Opus, Argon and Carbon only");
  assert.throws(() => board.add("Other", "x", "Antigravity · Shared", undefined, "gemini-4-argon", "max"), /Unknown effort level max/);
  assert.throws(() => board.add("Other", "x", "Grok · Work", undefined, undefined, "high"), /A Grok card in its own terminal runs the model `grok models` names as its default, at Grok's own effort; a model or effort can be picked only for an unattended Grok card/);
  assert.throws(() => board.add("Other", "x", "Grok · Work", undefined, undefined, undefined, undefined, { permission: "plan" }), /Unknown permission mode plan/);
  const grok = board.add("Grok card", "Look.", "Grok · Work", undefined, undefined, undefined, undefined, { permission: "edits" });
  await board.startCardTerminal(grok);
  assert.deepEqual(started.args, ["--model=grok-4.7", "--permission-mode=acceptEdits", "--", `Look.\n\n${CARD_TERMINAL_TURN_NOTE}`], "Grok's default as its exact id");
  assert.deepEqual(grokHomes, [path.join(repo, "grok")], "grok models is asked with the card's profile");
  // Exact ids only (17 November 2026): with no default named, and with no model on an Antigravity card, nothing starts.
  board.grokModels = async () => ({ ids: [] });
  const noDefault = board.add("Grok no default", "Look.", "Grok · Work");
  await assert.rejects(board.startCardTerminal(noDefault), /This Grok card uses Grok's default model, and `grok models` did not say which model that is\./);
  assert.equal(noDefault.cardTerminalStarted, undefined);
  agy = ["gemini-4-argon", "claude-opus-5-5"];
  const plain = board.add("Plain Antigravity", "Look.", "Antigravity · Shared");
  const before = started;
  await assert.rejects(board.startCardTerminal(plain), /This Antigravity card names no model, and agy does not say which model it would use by default\./);
  assert.equal(started, before, "no terminal was started");
  const opus = board.add("Opus Antigravity", "Look.", "Antigravity · Shared", undefined, "opus");
  await board.startCardTerminal(opus);
  assert.deepEqual(started.args, ["--model=claude-opus-5-5", "--dangerously-skip-permissions", `--prompt-interactive=Look.\n\n${CARD_TERMINAL_TURN_NOTE}`], "no pick: Antigravity's most permissive mode");
  assert.equal(board.add("Claude card", "x", "Claude", undefined, "claude-opus-5-5").model, "opus", "on a Claude account the id still means Claude's opus");
  // Moved to Antigravity: a model and effort it does not offer become its default, Opus at high; a permission mode carries over.
  const moved = board.add("Moved", "x", "Claude", undefined, "sonnet", "max", undefined, { permission: "auto" });
  assert.equal(board.switchAccount(moved, "Antigravity · Shared"), "start");
  assert.deepEqual([moved.provider, moved.model, moved.effort, moved.permission], ["antigravity", "opus", "high", "auto"]);
  assert.equal(board.switchAccount(moved, "Claude"), "start");
  // Back on Claude, Antigravity's opus is Claude's opus (fix 11: both short names mean the newest Opus).
  assert.deepEqual([moved.provider ?? "claude", moved.model, moved.effort, moved.permission], ["claude", "opus", "high", "auto"]);
});

test("interactive provider PTY preserves ACP history and stays live until stopped process exits", async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-card-terminal-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  board.accountList = () => [{ name: "Grok · Work", provider: "grok", configDir: path.join(repo, "grok") }];
  board.accountFolderList = () => [];
  board.tick();
  t.after(() => { board.dispose(); fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  let proc, started;
  board.cardTerminals.spawn = (file, args, options) => {
    started = { file, args, options };
    return proc = { pid: 999, onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; }, write() {}, resize() {}, kill() {} };
  };
  board.grokModels = async () => ({ ids: ["grok-4.7"], default: "grok-4.7" });
  const task = board.add("Task", "Investigate.", "Grok · Work");
  task.sessionId = "earlier-acp-conversation";
  fs.writeFileSync(board.eventsFile(task.id), JSON.stringify({ t: Date.now(), source: "acp", hook_event_name: "UserPromptSubmit", prompt: "Earlier" }) + "\n");
  await board.startCardTerminal(task);
  assert.equal(task.sessionId, "earlier-acp-conversation");
  assert.equal(task.cardTerminalStarted, true);
  assert.equal(task.status, "running");
  // A card without a permission mode (here one from before F88) runs Grok's most permissive mode (the user, 6 November 2026).
  assert.deepEqual(started.args, ["--model=grok-4.7", "--permission-mode=bypassPermissions", "--", `Investigate.\n\n${CARD_TERMINAL_TURN_NOTE}`]);
  assert.equal(board.live().includes(task.id), true);
  assert.equal(board.own().includes(task.id), true);
  assert.equal(board.prompts(task)[0].text, "Earlier");
  await assert.rejects(board.startCardTerminal(task), /already running/);
  board.stop(task);
  assert.equal(board.live().includes(task.id), true, "stop is not complete while the process remains alive");
  assert.equal(await board.ended(task, 0), false);
  proc.exit({ exitCode: 1 });
  assert.equal(board.live().includes(task.id), false);
  assert.equal(task.status, "review");
  assert.equal(task.interrupted, true);
  assert.equal(task.sessionId, "earlier-acp-conversation");
});

test("Antigravity offers the models agy lists for its sign-in: the user's three where listed, else agy's own, with no effort flag (F88)", async (t) => {
  const acp = require("../out/acp.js");
  // `agy models` on linux, 6 November 2026 (agy 1.5.2, a Starter Quota sign-in that has neither of the user's two).
  const out = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n";
  const listed = acp.parseAgyModels(out);
  assert.deepEqual(listed, [["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"], ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"], ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"]]);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-agy-listed-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  board.accountList = () => [{ name: "Claude", configDir: "" }, { name: "Antigravity · Shared", provider: "antigravity", configDir: "" }];
  board.accountFolderList = () => [];
  board.tick();
  t.after(() => { acp.setAntigravityModels(undefined); board.dispose(); fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  let started;
  board.cardTerminals.spawn = (file, args) => { started = { file, args }; return { pid: 999, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }; };
  assert.deepEqual(acp.antigravityModels(), [["opus", "Opus (newest)"], ["argon", "Argon (newest)"], ["carbon", "Carbon (newest)"]], "nothing listed yet: the three, as short names (F92)");
  acp.setAntigravityModels(listed);
  assert.deepEqual(acp.antigravityModels(), listed);
  assert.deepEqual(acp.antigravityDefault(), { model: "gemini-3.8-flash-high", effort: undefined });
  assert.throws(() => board.add("Other", "x", "Antigravity · Shared", undefined, "gemini-4-argon", "high"), /Unknown Antigravity model gemini-4-argon\. Valid models: gemini-3\.8-flash-high/);
  assert.throws(() => board.add("Other", "x", "Antigravity · Shared", undefined, "gemini-3.8-flash-low", "low"), /effort/);
  const task = board.add("Task", "Investigate.", "Antigravity · Shared", undefined, "gemini-3.8-flash-low", undefined, undefined, { permission: "bypass" });
  await board.startCardTerminal(task);
  assert.deepEqual(started.args, ["--model=gemini-3.8-flash-low", "--dangerously-skip-permissions", `--prompt-interactive=Investigate.\n\n${CARD_TERMINAL_TURN_NOTE}`]);
  // A sign-in that has one of the user's two (6 November 2026: only these two) offers only that one, under the board's own name.
  acp.setAntigravityModels([["claude-opus-5-5", "Claude Opus 5.5 (Thinking)"], ...listed]);
  assert.deepEqual(acp.antigravityModels(), [["opus", "Opus (claude-opus-5-5)"]], "the newest Opus it lists, as a short name (F92)");
  assert.deepEqual(acp.antigravityDefault(), { model: "opus", effort: "high" });
  // Its ids carry their effort (Windows, 6 November 2026: claude-opus-5-5-high): Opus runs the newest base id at the card's effort.
  acp.setAntigravityModels([["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"], ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"], ["claude-opus-5-6-high", "Claude Opus 5.6 (High)"]]);
  assert.deepEqual(acp.antigravityModels(), [["opus", "Opus (claude-opus-5-6)"]]);
  const opus = board.add("Opus", "Look.", "Antigravity · Shared", undefined, "claude-opus-5-5", "low", undefined, { permission: "bypass" });
  assert.equal(opus.model, "claude-opus-5-5", "kept as given; agy lists no such id, so the launch runs the newest Opus");
  await board.startCardTerminal(opus);
  assert.deepEqual(started.args, ["--model=claude-opus-5-6", "--effort=low", "--dangerously-skip-permissions", `--prompt-interactive=Look.\n\n${CARD_TERMINAL_TURN_NOTE}`]);
  // Carbon (the user, 14 November 2026): with agy listing Carbon beside Opus and Argon, the menu offers the three in that order, Opus first.
  const windows = [["gemini-4-carbon-low", "Gemini 4 Carbon (Low)"], ["gemini-4-carbon-medium", "Gemini 4 Carbon (Medium)"], ["gemini-4-carbon-high", "Gemini 4 Carbon (High)"],
    ["gemini-4-argon-low", "Gemini 4 Argon (Low)"], ["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"], ...listed];
  acp.setAntigravityModels(windows);
  assert.deepEqual(acp.antigravityModels(), [["opus", "Opus (claude-opus-5-5)"], ["argon", "Argon (gemini-4-argon)"], ["carbon", "Carbon (gemini-4-carbon)"]]);
  assert.deepEqual(acp.antigravityDefault(), { model: "opus", effort: "high" }, "Opus stays preselected");
  assert.equal(acp.antigravityTakesEffort("carbon"), true);
  assert.deepEqual(acp.antigravityArgs({ model: "carbon", effort: "low", permission: "bypass" }), ["--model=carbon", "--effort=low", "--dangerously-skip-permissions"]);
  assert.equal(acp.antigravityModelOk("gemini-4-carbon"), true, "a full Carbon id is Carbon");
  assert.throws(() => acp.antigravityArgs({ model: "carbon", effort: "max" }), /Unknown effort level max/);
  // A sign-in that lists no Carbon behaves as before: only the families it lists, and carbon is refused.
  acp.setAntigravityModels(windows.filter(([id]) => !id.includes("carbon")));
  assert.deepEqual(acp.antigravityModels(), [["opus", "Opus (claude-opus-5-5)"], ["argon", "Argon (gemini-4-argon)"]]);
  assert.throws(() => acp.antigravityArgs({ model: "carbon", effort: "high" }), /Unknown Antigravity model carbon\. Valid models: opus, argon \(each runs/);
  assert.throws(() => board.add("Carbon", "x", "Antigravity · Shared", undefined, "carbon", "high"), /Unknown Antigravity model carbon/);
});

test("streamed ACP chunks redraw the board at most once per 500 ms, the first at once and the last always (audit finding 13)", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-acp-redraw-"));
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  t.after(() => { board.dispose(); fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let text = "";
  const drawn = [];
  board.onChange(() => drawn.push(text));
  for (let i = 1; i <= 20; i++) { text += `c${i} `; board.redrawSoon(); t.mock.timers.tick(20); } // 20 chunks in 400 ms
  assert.equal(drawn.length, 1, "the first chunk draws at once, the rest wait");
  t.mock.timers.tick(100);
  assert.equal(drawn.length, 2, "at most two redraws for chunks inside 500 ms");
  assert.equal(drawn.at(-1), text, "the trailing redraw shows the last chunk");
  t.mock.timers.tick(2000);
  assert.equal(drawn.length, 2, "nothing more once the chunks stop");
  text += "late"; board.redrawSoon();
  assert.equal(drawn.length, 3, "a chunk after a quiet spell draws at once");
});

// F123 (the user, 23 November 2026): each account's default model by name, for the menus' "Default: Fable 5.2" entry, and the
// Antigravity menu listing every model `agy models` lists.
test("defaultModels names each account's default; an account whose default is unknown is left out", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-default-models-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, stdio: "pipe" });
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  t.after(() => { board.dispose(); fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const dir = (name, settings) => { const d = path.join(repo, name); fs.mkdirSync(d); if (settings) fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify(settings)); return d; };
  const grokHome = dir("grok");
  const accounts = [{ name: "Fable", configDir: dir("a", { model: "fable" }) }, { name: "Full", configDir: dir("b", { model: "claude-opus-5-5[1m]" }) },
    { name: "Unset", configDir: dir("c", {}) }, { name: "Missing", configDir: path.join(repo, "none") },
    { name: "Codex · x", provider: "codex", configDir: "" }, { name: "Grok · Seen", provider: "grok", configDir: grokHome },
    { name: "Antigravity · Shared", provider: "antigravity", configDir: "" }];
  board.accountList = () => accounts;
  board.codexDefaultId = () => "gpt-6.2-astra";
  const agy = accounts.find((a) => a.provider === "antigravity");
  const model = { id: "model", name: "Model", category: "model", currentValue: "gemini-4-carbon", values: [{ value: "gemini-4-carbon", name: "Gemini 4 Carbon" }] };
  board.rememberAcpOptions({ provider: agy.provider, account: agy.name }, [model], "session/new");
  let asked = 0;
  board.grokModels = async () => { asked++; return { ids: [] }; };
  assert.deepEqual(board.defaultModels(), { Fable: "Fable 5.2", Full: "Opus 5.5", "Codex · x": "Astra 6.2", "Antigravity · Shared": "Gemini 4 Carbon" });
  assert.equal(asked, 1, "`grok models` is asked for a profile whose default has not been seen");
  board.rememberAcpOptions({ provider: agy.provider, account: agy.name }, [{ ...model, currentValue: "unlisted-id" }], "session/new");
  assert.equal(board.defaultModels()[agy.name], undefined, "a fresh session whose current model is unlisted clears the earlier default");
});

test("the Antigravity menu lists every model agy lists, by its id and agy's name; the three until it has answered", (t) => {
  const acp = require("../out/acp.js");
  t.after(() => acp.setAntigravityModels(undefined));
  acp.setAntigravityModels(undefined);
  assert.deepEqual(acp.antigravityChoices().map(([v]) => v), ["opus", "argon", "carbon"]);
  const listed = [["claude-opus-5-5-high", "Claude Opus 5.5 (High)"], ["gemini-4-neon-xhigh", "Gemini 4 Neon (XHigh)"], ["gemini-pro-orchestrator", "Orchestrator (Carbon)"]];
  acp.setAntigravityModels(listed);
  assert.deepEqual(acp.antigravityChoices(), listed);
  for (const [id] of listed) assert.equal(acp.antigravityModelOk(id), true, `${id} is a model a card may pick`);
  assert.equal(acp.antigravityModelOk("gemini-9-none"), false);
});
