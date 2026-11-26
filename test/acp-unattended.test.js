// Grok and Antigravity as first-class unattended runtimes (orchestrator run 0db6d1, step 1): add accepts them for plan steps,
// orchestrators and openedBy workers; --model and --effort map to the agent's advertised ACP options (never a fixed list);
// bypass answers permission requests with allow-once, the account default raises them to the parent; capabilities list them.
// Every agent here is a fake ACP process; no real Grok or Antigravity runs.
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
let modals = 0;
const vscode = { EventEmitter: VSCodeEvent, ThemeIcon: class {},
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }),
    showWarningMessage: async () => { modals++; return undefined; }, showInformationMessage: async () => undefined } };
const load = Module._load;
Module._load = function (request, ...args) { return request === "vscode" ? vscode : load.call(this, request, ...args); };
const { Board } = require("../out/board.js");
const { AcpSession } = require("../out/acp.js");
const { DEFAULT_CAPS, validateRequest } = require("../out/orchestrator.js");
const until = async (fn) => {
  const end = Date.now() + 30000; // 5 s timed out under the full suite's load (12 November 2026); a met condition returns at once
  while (!fn() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fn(), "runtime state did not settle");
};

// The option ids differ from their categories, so a queued --model must be mapped by category.
const OPTIONS = [
  { id: "agent_model", name: "Model", category: "model", type: "select", currentValue: "model-s1", options: [{ value: "model-s1", name: "Small" }, { value: "model-l1", name: "Large" }] },
  { id: "reasoning", name: "Thinking", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
  // Fake mode ids. An unattended Ask card must select the one that asks first (askMode): the default may run tools without asking.
  { id: "agent_mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "auto-approve", name: "Auto approve" }, { value: "ask-first", name: "Ask before tools" }] },
];

function fixture(t, advertised = OPTIONS) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-acp-unattended-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  board.accountList = () => [{ name: "acct", configDir: "" }, { name: "Grok · Work", provider: "grok", configDir: "/grok/work" },
    { name: "Antigravity · Shared", provider: "antigravity", configDir: "" }];
  board.accountFolderList = () => [];
  board.preflightHeadless = async () => {};
  board.requestRateMs = 0;
  board.tick();
  t.after(() => { board.dispose(); fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const runs = [];
  board.probeAcpCatalogs = false; // F92 catalog probe: checked in refused-start.test.js; these fakes count every session
  board.runAcp = (provider, cwd, profile, update, permission, env) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 2 ** 30 });
    const requests = [], replies = [];
    let buffer = "", promptId, options = advertised;
    const send = (x) => child.stdout.write(JSON.stringify(x) + "\n");
    child.stdin.on("data", (data) => {
      buffer += data;
      while (buffer.includes("\n")) {
        const n = buffer.indexOf("\n"), m = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
        if (!m.method) { replies.push(m); continue; }
        requests.push(m);
        if (m.method === "session/prompt") { promptId = m.id; continue; }
        if (m.method === "session/set_config_option") options = options.map((o) => o.id === m.params.configId ? { ...o, currentValue: m.params.value } : o);
        const result = m.method === "initialize" ? { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } }
          : m.method === "session/new" ? { sessionId: `${provider}-session`, configOptions: options }
          : m.method === "session/resume" || m.method === "session/set_config_option" ? { configOptions: options } : {};
        if (m.id !== undefined) queueMicrotask(() => send({ jsonrpc: "2.0", id: m.id, result }));
      }
    });
    child.kill = () => { child.emit("exit", 0); return true; };
    const finish = () => send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    const ask = (id, kind, options = [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" }, { optionId: "no", name: "No", kind: "reject_once" }]) =>
      send({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId: `${provider}-session`, toolCall: { title: `Tool ${id}`, kind, rawInput: { command: "npm test" } }, options } });
    const reply = (id) => replies.find((r) => r.id === id)?.result?.outcome;
    runs.push({ provider, profile, env, requests, replies, finish, ask, reply });
    return new AcpSession(child, update, permission);
  };
  const root = board.add("Run", "Coordinate.", "acct", undefined, undefined, undefined, undefined,
    { orchestrator: { caps: { ...DEFAULT_CAPS }, opened: 0 }, headless: true, approved: { at: "now", hash: "h" } });
  return { repo, board, runs, root };
}

test("add accepts Grok and Antigravity for a plan step, an orchestrator and an openedBy worker; --model and --effort queue in acpSelections", async (t) => {
  const { board, root } = fixture(t);
  const plan = board.add("Plan: two", "", "acct", undefined, undefined, undefined, undefined, { orchestrator: { caps: { ...DEFAULT_CAPS }, opened: 2 },
    planRun: { name: "two", file: "workflows/two.plan.json", review: "model" }, approved: { at: "now", hash: "h" }, headless: true });
  for (const account of ["Grok · Work", "Antigravity · Shared"]) {
    const step = board.add("Step", "Work.", account, plan.id, undefined, undefined, undefined, { headless: true, openedBy: plan.id, watchedBy: plan.id, permission: "bypass" });
    const orchestrator = board.add("Coordinator", "Plan.", account, undefined, undefined, undefined, undefined, { orchestrator: { caps: { ...DEFAULT_CAPS }, opened: 0 }, headless: true });
    const worker = board.add("Worker", "Work.", account, root.id, "some-model", "deep", undefined, { headless: true, openedBy: root.id });
    for (const card of [step, orchestrator, worker]) assert.equal(card.provider, account.startsWith("Grok") ? "grok" : "antigravity");
    assert.equal(step.permission, "bypass");
    // No catalog yet: the values are queued under their category and checked when the session opens.
    assert.deepEqual(worker.acpSelections, { model: "some-model", thought_level: "deep" });
    assert.deepEqual([worker.model, worker.effort], ["some-model", "deep"]);
  }
  assert.throws(() => board.add("Bad", "Work.", "Grok · Work", root.id, undefined, undefined, undefined, { headless: true, openedBy: root.id, permission: "edits" }), /Unknown permission mode edits/);
  assert.throws(() => board.add("Gone", "Work.", "Grok · Missing"), /Unknown provider account/);
  assert.equal(board.resolveAccount(undefined, undefined, "grok").name, "Grok · Work");
  assert.equal(board.resolveAccount(undefined, undefined, "antigravity").name, "Antigravity · Shared");
  assert.equal(board.resolveAccount("grok").name, "Grok · Work");
  assert.equal(board.resolveAccount("acct", undefined, "grok"), undefined, "a runtime filters out another provider's account");
  assert.equal(validateRequest({ v: 1, op: "add", by: "abcdef", title: "T", prompt: "P", runtime: "antigravity" }, "n").request.runtime, "antigravity");
  assert.match(validateRequest({ v: 1, op: "add", by: "abcdef", title: "T", prompt: "P", runtime: "gemini" }, "n").error, /runtime must be claude, codex, grok or antigravity/);
});

test("advertised options become the account's catalog; an unadvertised --model or --effort fails clearly at add or at session open", async (t) => {
  const { board, runs, root } = fixture(t);
  // Before any catalog: a value the agent then does not advertise fails the card at session open, before any prompt.
  const blind = board.add("Blind", "Work.", "Antigravity · Shared", root.id, "imagined", undefined, undefined, { headless: true, openedBy: root.id });
  await assert.rejects(board.startHeadless(blind), /Antigravity · Shared does not advertise model imagined\. It offers: model-s1, model-l1/);
  assert.equal(runs[0].requests.some((r) => r.method === "session/prompt"), false);
  // F92: refused before the card records the session: no event, no session id, and no worktree or branch made for it or its parent.
  assert.deepEqual([board.events(blind.id).length, blind.sessionId, blind.worktree, root.worktree], [0, undefined, undefined, undefined]);
  // A queued, advertised value is mapped from its category to the option's real id.
  const queued = board.add("Queued", "Work.", "Grok · Work", root.id, "model-l1", "high", undefined, { headless: true, openedBy: root.id, permission: "bypass" });
  await board.startHeadless(queued);
  const set = runs[1].requests.filter((r) => r.method === "session/set_config_option").map((r) => [r.params.configId, r.params.value]);
  assert.deepEqual(set, [["agent_model", "model-l1"], ["reasoning", "high"]], "the model is applied first, then the thought level");
  runs[1].finish();
  await until(() => queued.status === "review" && !board.live().includes(queued.id));
  // Now Grok · Work has a catalog: add checks against it, and capabilities and board.js models list it as last seen.
  const catalog = JSON.parse(fs.readFileSync(path.join(board.dir, "acp-catalog.json"), "utf8"));
  assert.deepEqual(Object.values(catalog).map((c) => c.options.map((o) => o.id)), [["agent_model", "reasoning", "agent_mode"], ["agent_model", "reasoning", "agent_mode"]]);
  assert.equal(JSON.stringify(catalog).includes("currentValue"), false, "ids and labels only");
  assert.throws(() => board.add("Wrong", "Work.", "Grok · Work", root.id, "huge", undefined, undefined, { headless: true, openedBy: root.id }), /Grok · Work does not advertise model huge\. Last seen: model-s1, model-l1/);
  assert.throws(() => board.add("Wrong", "Work.", "Grok · Work", root.id, "model-s1", "max", undefined, { headless: true, openedBy: root.id }), /does not advertise effort max\. Last seen: low, high/);
  assert.deepEqual(board.add("Right", "Work.", "Grok · Work", root.id, "model-s1", "low", undefined, { headless: true, openedBy: root.id }).acpSelections, { agent_model: "model-s1", reasoning: "low" });
  board.publishStatus(true);
  const caps = JSON.parse(fs.readFileSync(path.join(board.dir, "capabilities.json"), "utf8"));
  assert.deepEqual(caps.capabilities.headless, ["claude", "codex", "grok", "antigravity"]);
  assert.deepEqual(caps.models.filter((m) => m.runtime === "grok").map((m) => [m.id, m.account, m.efforts, typeof m.lastSeen]),
    [["model-s1", "Grok · Work", ["low", "high"], "string"], ["model-l1", "Grok · Work", ["low", "high"], "string"]]);
  assert.deepEqual([...new Set(caps.accounts.map((a) => a.runtime))], ["claude", "grok", "antigravity"]);
  // The orchestrator path refuses an unadvertised model with the same list.
  board.update(root, { sessionId: "controller" });
  assert.equal(board.refusalOf({ v: 1, op: "add", by: root.id, session: "controller", nonce: "n", title: "T", prompt: "P", runtime: "grok", model: "huge" }), "Unknown model huge. Valid models: model-s1, model-l1");
  assert.equal(board.refusalOf({ v: 1, op: "add", by: root.id, session: "controller", nonce: "n", title: "T", prompt: "P", runtime: "grok", model: "model-l1", effort: "high", permission: "bypass" }), undefined);
});

test("Antigravity refreshes a legacy catalog from a new ACP session before applying the card's model", async (t) => {
  const advertised = structuredClone(OPTIONS);
  const { board, runs, root } = fixture(t, advertised);
  const account = board.resolveAccount("antigravity");
  const worker = board.add("Worker", "Work.", account.name, root.id, "model-l1", undefined, undefined,
    { headless: true, openedBy: root.id, permission: "bypass" });
  board.accountList = () => [account];
  const catalog = path.join(board.dir, "acp-catalog.json");
  const options = OPTIONS.map(({ id, name, category, options: values }) => ({ id, name, category, values }));
  fs.writeFileSync(catalog, JSON.stringify({ [`antigravity:${account.name}`]: { at: "2026-11-23T00:00:00Z", options } }));
  board.acpCatalogs = undefined;
  assert.equal(board.defaultModels()[account.name], undefined);

  await board.startHeadless(worker);
  assert.equal(worker.sentModel, "model-l1");
  assert.equal(worker.acpOptions.find((o) => o.category === "model").currentValue, "model-l1");
  board.acpCatalogs = undefined;
  assert.equal(board.defaultModels()[account.name], "Small", "the account label comes from session/new before the explicit pick");
  runs[0].finish();
  await until(() => worker.status === "review" && !board.live().includes(worker.id));
  advertised[0].currentValue = "model-l1"; // session/resume reports this card's explicit pick.
  advertised[0].options[0].name = "Small (updated)";
  await board.followUpHeadless(worker, "Continue.");
  assert.ok(runs[1].requests.some((r) => r.method === "session/resume"));
  assert.equal(board.defaultModels()[account.name], "Small (updated)", "a same-login resume still refreshes the advertised labels");
  runs[1].finish();
  await until(() => worker.status === "review" && !board.live().includes(worker.id));
});

test("a resumed Antigravity session from the previous login cannot supply the new login's catalog", async (t) => {
  const advertised = structuredClone(OPTIONS);
  const { board, runs } = fixture(t, advertised);
  const account = board.resolveAccount("antigravity");
  board.accountList = () => [account];
  let login = "login-A";
  board.antigravityLoginId = () => login;
  const old = board.add("Old", "Work.", account.name, undefined, undefined, undefined, undefined, { headless: true, permission: "bypass" });
  await board.startHeadless(old);
  assert.equal(JSON.parse(fs.readFileSync(board.file)).find((card) => card.id === old.id).acpLoginId, login);
  runs.at(-1).finish();
  await until(() => old.status === "review" && !board.live().includes(old.id));

  login = "login-B";
  await board.followUpHeadless(old, "Continue.");
  assert.ok(runs.at(-1).requests.some((r) => r.method === "session/resume"));
  assert.equal(old.acpOptions.find((o) => o.category === "model").currentValue, "model-s1");
  runs.at(-1).finish();
  await until(() => old.status === "review" && !board.live().includes(old.id));
  board.acpCatalogs = undefined; // Reload from disk before adding B's card.
  const neon = "gemini-4-neon";
  advertised[0].currentValue = neon;
  advertised[0].options = [{ value: neon, name: "Gemini 4 Neon" }];
  const fresh = board.add("New", "Work.", account.name, undefined, neon, undefined, undefined, { headless: true, permission: "bypass" });
  board.probeAcpCatalogs = true;
  await board.startHeadless(fresh);
  assert.equal(runs.length, 4, "B used a cold probe and a new session");
  assert.equal(fresh.sentModel, neon);
  assert.equal(board.defaultModels()[account.name], "Gemini 4 Neon");
  runs.at(-1).finish();
  await until(() => fresh.status === "review" && !board.live().includes(fresh.id));

  // A legacy card with unknown login can still resume after B's default is known.
  board.update(old, { acpLoginId: undefined });
  advertised[0] = structuredClone(OPTIONS[0]);
  await board.followUpHeadless(old, "Continue old conversation.");
  assert.equal(old.acpOptions.find((o) => o.category === "model").currentValue, "model-s1");
  board.acpCatalogs = undefined;
  assert.equal(board.defaultModels()[account.name], "Gemini 4 Neon");
  runs.at(-1).finish();
  await until(() => old.status === "review" && !board.live().includes(old.id));
});

test("bypass answers with allow once; the account default refuses and raises a PermissionRequest; judges only read", async (t) => {
  const { board, runs, root } = fixture(t);
  modals = 0;
  const bypass = board.add("Bypass", "Work.", "Grok · Work", root.id, undefined, undefined, undefined, { headless: true, openedBy: root.id, permission: "bypass" });
  await board.startHeadless(bypass);
  runs[0].ask("p1", "execute");
  await until(() => runs[0].reply("p1"));
  assert.deepEqual(runs[0].reply("p1"), { outcome: "selected", optionId: "yes" });
  runs[0].finish();
  await until(() => bypass.status === "review" && !board.live().includes(bypass.id));
  assert.equal(bypass.interrupted, undefined, "an allowed request is a normal turn");

  const asks = board.add("Default", "Work.", "Antigravity · Shared", root.id, undefined, undefined, undefined, { headless: true, openedBy: root.id });
  await board.startHeadless(asks);
  assert.equal(asks.permission, undefined, "an ACP card is never silently given bypass");
  runs[1].ask("p2", "edit");
  await until(() => runs[1].reply("p2"));
  assert.deepEqual(runs[1].reply("p2"), { outcome: "cancelled" });
  assert.equal(board.events(asks.id).at(-1).hook_event_name, "PermissionRequest");
  assert.match(board.events(asks.id).at(-1).message, /Agent requests permission: Tool p2/);
  runs[1].finish();
  await until(() => !board.live().includes(asks.id) && asks.status === "needs-input");
  assert.equal(board.events(asks.id).at(-1).hook_event_name, "PermissionRequest", "the turn's end does not hide the unanswered request");
  assert.equal(board.statusOf(asks).status, "needs-input", "the parent's settle notice says it needs input");

  const judge = board.add("Judge", "Review.", "Grok · Work", root.id, undefined, undefined, undefined, { headless: true, openedBy: root.id, role: "judge", permission: "bypass" });
  await board.startHeadless(judge);
  runs[2].ask("w", "edit");
  runs[2].ask("r", "read");
  await until(() => runs[2].reply("w") && runs[2].reply("r"));
  assert.deepEqual(runs[2].reply("w"), { outcome: "cancelled" }, "a judge's write is refused even under bypass");
  assert.deepEqual(runs[2].reply("r"), { outcome: "selected", optionId: "yes" });
  runs[2].finish();
  await until(() => judge.status === "review" && !board.live().includes(judge.id));
  assert.equal(modals, 0, "no unattended request opened a modal");
});

test("an orchestrator's add --runtime grok opens a worker through the ACP path; Switch moves it between Grok accounts", async (t) => {
  const { board, runs } = fixture(t);
  board.accountList = () => [{ name: "acct", configDir: "" }, { name: "Grok · Work", provider: "grok", configDir: "/grok/work" },
    { name: "Grok · Home", provider: "grok", configDir: "/grok/home" }, { name: "Antigravity · Shared", provider: "antigravity", configDir: "" }];
  const m = board.add("Run", "Coordinate.", "acct", undefined, undefined, undefined, undefined,
    { orchestrator: { caps: { ...DEFAULT_CAPS }, opened: 0 }, headless: true, approved: { at: "now", hash: "h" }, permission: "edits" });
  board.update(m, { sessionId: "controller" });
  const answer = await board.handleRequest({ v: 1, op: "add", by: m.id, session: "controller", title: "Grok worker", prompt: "Work.", runtime: "grok" }, "n1");
  assert.equal(answer.error, undefined);
  assert.equal(answer.started, true);
  const child = board.get(answer.id);
  assert.deepEqual([child.provider, child.account, child.openedBy, runs[0].profile], ["grok", "Grok · Work", m.id, "/grok/work"]);
  assert.equal(child.permission, "ask", "Claude's edits has no ACP equivalent: the child asks, never a wider bypass");
  runs[0].finish();
  await until(() => child.status === "review" && !board.live().includes(child.id));
  assert.equal(board.switchAccount(child, "Grok · Home"), "start");
  assert.deepEqual([child.provider, child.configDir, child.permission, child.sessionId], ["grok", "/grok/home", "ask", undefined]);
  const wide = await board.handleRequest({ v: 1, op: "add", by: m.id, session: "controller", title: "Antigravity worker", prompt: "Work.", runtime: "antigravity", permission: "bypass", model: "model-s1" }, "n2");
  assert.match(wide.error, /Permission bypass is wider than this coordinator's own \(edits\)/, "a child never gets wider permission than its parent");
  const anti = await board.handleRequest({ v: 1, op: "add", by: m.id, session: "controller", title: "Antigravity worker", prompt: "Work.", runtime: "antigravity", model: "model-s1" }, "n3");
  assert.equal(anti.error, undefined);
  assert.deepEqual([board.get(anti.id).provider, board.get(anti.id).permission, board.get(anti.id).acpSelections], ["antigravity", "ask", { model: "model-s1" }]);
});

test("a child never gets wider permission than its coordinator; an ACP coordinator on its account default gives ask", async (t) => {
  const { childPermission } = require("../out/board.js");
  assert.deepEqual(childPermission({}, false), { permission: "bypass" }, "Claude or Codex coordinator, unset: the unattended default stays");
  assert.deepEqual(childPermission({ provider: "grok" }, true), { permission: "ask" });
  assert.deepEqual(childPermission({ provider: "antigravity" }, false), { permission: "ask" }, "a Claude child of an asking ACP parent asks too");
  assert.deepEqual(childPermission({ permission: "edits" }, true), { permission: "ask" });
  assert.deepEqual(childPermission({ permission: "auto" }, false, "edits"), { permission: "edits" }, "narrower is allowed");
  assert.match(childPermission({ permission: "auto" }, false, "bypass").error, /wider than this coordinator's own \(auto\)/);
  assert.deepEqual(childPermission({ provider: "grok", permission: "bypass" }, true, "bypass"), { permission: "bypass" });

  const { board, runs } = fixture(t);
  const grok = board.add("Grok run", "Coordinate.", "Grok · Work", undefined, undefined, undefined, undefined,
    { orchestrator: { caps: { ...DEFAULT_CAPS }, opened: 0, session: "ctl" }, headless: true, approved: { at: "now", hash: "h" } });
  const ask = { v: 1, op: "add", by: grok.id, session: "ctl", title: "W", prompt: "Work." };
  const plain = await board.handleRequest({ ...ask, runtime: "grok" }, "a1");
  assert.equal(plain.error, undefined);
  assert.equal(board.get(plain.id).permission, "ask", "account default on the ACP parent: the child asks, never bypass");
  const claude = await board.handleRequest({ ...ask, account: "acct", start: "manual" }, "a2");
  assert.equal(claude.error, undefined, claude.error);
  assert.equal(board.get(claude.id).permission, "ask");
  const bypass = await board.handleRequest({ ...ask, runtime: "antigravity", permission: "bypass" }, "a3");
  assert.match(bypass.error, /wider than this coordinator's own \(ask\)/);
  assert.equal(board.tasks.filter((x) => x.openedBy === grok.id).length, 2, "a refused request creates no card");
  board.update(grok, { permission: "bypass" });
  const allowed = await board.handleRequest({ ...ask, runtime: "antigravity", permission: "bypass" }, "a4");
  assert.equal(allowed.error, undefined, allowed.error);
  assert.equal(board.get(allowed.id).permission, "bypass", "explicit bypass under a bypass parent");
  for (const r of runs) r.finish();
});

test("Grok and Antigravity cards can be adopted (not while open in their own terminal) and get no wider permission than the adopter", async (t) => {
  const { board } = fixture(t);
  const grok = board.add("Grok run", "Coordinate.", "Grok · Work", undefined, undefined, undefined, undefined,
    { orchestrator: { caps: { ...DEFAULT_CAPS }, opened: 0, session: "ctl" }, headless: true, approved: { at: "now", hash: "h" } });
  const loose = board.add("Loose", "Work.", "Antigravity · Shared");
  const answer = await board.handleRequest({ v: 1, op: "adopt", by: grok.id, session: "ctl", id: loose.id }, "d1");
  assert.equal(answer.error, undefined, answer.error);
  assert.deepEqual([loose.openedBy, loose.headless, loose.permission], [grok.id, true, "ask"], "adopted under an asking ACP parent: it asks");
  const open = board.add("Open", "Work.", "Grok · Work");
  board.update(open, { cardTerminalStarted: true, status: "running" });
  const has = board.cardTerminals.has.bind(board.cardTerminals);
  board.cardTerminals.has = (id) => id === open.id || has(id);
  assert.match((await board.handleRequest({ v: 1, op: "adopt", by: grok.id, session: "ctl", id: open.id }, "d2")).error,
    new RegExp(`Card ${open.id} is open in Grok's own terminal; stop it first`));
  board.cardTerminals.has = has;
});

// CORE-GOV-04: an ACP root is bound by its board session id, not its provider session id, and has no legacy orchestrator.session.
for (const [provider, account, profile] of [["grok", "Grok · Work", "/grok/work"], ["antigravity", "Antigravity · Shared", ""]])
test(`a ${provider} coordinator can open a pressure watcher on its own account, asking like its parent`, async (t) => {
  const { board, runs } = fixture(t);
  const root = board.add(`${provider} run`, "Coordinate.", account, undefined, "model-l1", "high", undefined,
    { orchestrator: { caps: { ...DEFAULT_CAPS, pending: 2, open: 3 }, opened: 0 }, headless: true, approved: { at: "now", hash: "h", pressureWatchers: true } });
  board.update(root, { status: "running", sessionId: "provider-s", boardSessionId: "board-s" });
  const a = board.add("A", "a", "acct", root.id, undefined, undefined, undefined, { openedBy: root.id, watchedBy: root.id });
  const b = board.add("B", "b", "acct", root.id, undefined, undefined, undefined, { openedBy: root.id, watchedBy: root.id });
  board.update(a, { status: "review" }); board.update(b, { status: "review" });
  await until(() => board.tasks.some((x) => x.role === "sub" && board.live().includes(x.id)));
  const watcher = board.tasks.find((x) => x.role === "sub");
  assert.deepEqual([watcher.provider, watcher.account, watcher.permission, watcher.openedBy, watcher.orchestrator.root, runs.at(-1).profile],
    [provider, account, "ask", root.id, root.id, profile]);
  assert.deepEqual([watcher.model, watcher.effort], ["model-l1", "high"], "F73: ACP has no Opus or Sol, so the watcher keeps the root's model and effort");
  assert.deepEqual([a.watchedBy, b.watchedBy], [watcher.id, watcher.id]);
  runs.at(-1).finish();
  await until(() => !board.live().includes(watcher.id));
});

test("Ask selects the agent's advertised mode that asks first; an account that advertises none refuses Ask clearly", async (t) => {
  const { askMode } = require("../out/acp.js");
  const mode = (...values) => [{ id: "m", name: "Mode", category: "mode", values: values.map((v) => ({ value: v, name: v })) }];
  // The live Antigravity list (6 November 2026): default ran tools without asking, so only plan qualifies; Grok advertised no mode.
  assert.equal(askMode(mode("default", "accept-edits", "plan"))?.value, "plan");
  assert.equal(askMode(mode("plan", "read-only", "ask"))?.value, "ask", "asking first wins over read-only and plan");
  assert.equal(askMode(mode("auto-approve", "yolo", "default")), undefined, "a mode that allows without asking never counts");
  assert.equal(askMode([]), undefined);

  // An agent that advertises an asking mode: an unattended Ask card runs in it, after the model.
  const { board, runs, root } = fixture(t);
  const asks = board.add("Ask", "Work.", "Antigravity · Shared", root.id, "model-l1", undefined, undefined, { headless: true, openedBy: root.id, permission: "ask" });
  await board.startHeadless(asks);
  const set = runs[0].requests.filter((r) => r.method === "session/set_config_option").map((r) => [r.params.configId, r.params.value]);
  assert.deepEqual(set, [["agent_model", "model-l1"], ["agent_mode", "ask-first"]]);
  assert.equal(asks.acpOptions.find((o) => o.category === "mode").currentValue, "ask-first");
  runs[0].ask("p", "execute");
  await until(() => runs[0].reply("p"));
  assert.deepEqual(runs[0].reply("p"), { outcome: "cancelled" }, "its request is refused and raised to the parent");
  assert.equal(board.events(asks.id).at(-1).hook_event_name, "PermissionRequest");
  runs[0].finish();
  await until(() => !board.live().includes(asks.id));
  assert.equal(board.acpAskMode(board.resolveAccount("Antigravity · Shared")), "ask-first", "the catalog keeps the mode list");

  // An agent with no asking mode (as Grok live): the card fails before any prompt, and once seen, add and the orchestrator refuse it.
  const none = OPTIONS.filter((o) => o.category !== "mode");
  const g = fixture(t, none);
  const grokAsk = g.board.add("Ask", "Work.", "Grok · Work", g.root.id, undefined, undefined, undefined, { headless: true, openedBy: g.root.id, permission: "ask" });
  await assert.rejects(g.board.startHeadless(grokAsk), /Grok · Work advertises no mode that asks for approval \(modes: none\), so Ask cannot be enforced on an unattended card/);
  assert.equal(g.runs[0].requests.some((r) => r.method === "session/prompt"), false, "no turn runs while pretending to ask");
  assert.throws(() => g.board.add("Again", "Work.", "Grok · Work", g.root.id, undefined, undefined, undefined, { headless: true, openedBy: g.root.id, permission: "ask" }), /advertises no mode that asks for approval/);
  assert.ok(g.board.add("Bypass", "Work.", "Grok · Work", g.root.id, undefined, undefined, undefined, { headless: true, openedBy: g.root.id, permission: "bypass" }), "bypass is still accepted");
  g.board.update(g.root, { sessionId: "controller", permission: "ask" });
  const refused = await g.board.handleRequest({ v: 1, op: "add", by: g.root.id, session: "controller", title: "W", prompt: "Work.", runtime: "grok" }, "k1");
  assert.match(refused.error, /Grok · Work advertises no mode that asks for approval/);
});

// Exact ids only (the user, 17 November 2026): an unattended card with no model selects, by its exact id, the model the session reports
// it is on, rather than leave it to the agent; a session on an alias such as "auto", or one with no model choice, starts nothing.
test("exact ids: a card on its account's default model selects the session's own exact id; an alias or no model choice refuses the start", async (t) => {
  const { board, runs, root } = fixture(t);
  const plain = board.add("Plain", "Work.", "Grok · Work", root.id, undefined, undefined, undefined, { headless: true, openedBy: root.id, permission: "bypass" });
  await board.startHeadless(plain);
  const set = runs[0].requests.filter((r) => r.method === "session/set_config_option").map((r) => [r.params.configId, r.params.value]);
  assert.deepEqual(set, [["agent_model", "model-s1"]], "the session's current model, named exactly, before the prompt");
  runs[0].finish();
  await until(() => plain.status === "review" && !board.live().includes(plain.id));

  const auto = fixture(t, OPTIONS.map((o) => o.category === "model" ? { ...o, currentValue: "auto", options: [{ value: "auto", name: "Auto" }, ...o.options] } : o));
  const onAuto = auto.board.add("Auto", "Work.", "Grok · Work", auto.root.id, undefined, undefined, undefined, { headless: true, openedBy: auto.root.id, permission: "bypass" });
  await assert.rejects(auto.board.startHeadless(onAuto), /Grok · Work would run "auto", which is not an exact model id, so nothing was started\. Add a new card with one of its exact ids, or move this card to another account: model-s1, model-l1./);
  assert.equal(auto.runs[0].requests.some((r) => r.method === "session/prompt"), false, "no prompt was sent");
  assert.equal(onAuto.sessionId, undefined, "a session refused for its model was never prompted: the card is unstarted again");
  const named = auto.board.add("Named auto", "Work.", "Grok · Work", auto.root.id, "auto", undefined, undefined, { headless: true, openedBy: auto.root.id, permission: "bypass" });
  const runsBefore = auto.runs.length;
  await assert.rejects(auto.board.startHeadless(named), /would run "auto", which is not an exact model id/);
  assert.deepEqual([auto.runs.length, named.sessionId], [runsBefore, undefined], "the account's catalog refuses it before any session opens");

  const none = fixture(t, OPTIONS.filter((o) => o.category !== "model"));
  const blind = none.board.add("No choice", "Work.", "Antigravity · Shared", none.root.id, undefined, undefined, undefined, { headless: true, openedBy: none.root.id, permission: "bypass" });
  await assert.rejects(none.board.startHeadless(blind), /Antigravity · Shared advertises no model choice, so the exact model it would run is unknown/);
  assert.equal(none.runs[0].requests.some((r) => r.method === "session/prompt"), false);
});
