// Compile stage, webview and host (M5). Host: the "compile" message handler with VS Code stand-ins and a fake
// compiler, plus the real compiler behind an intercepted claude spawn. Webview: the real media/board.js in
// headless Microsoft Edge driven over CDP with injected compilation results. No model is ever called.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const cdp = require("./compile-webview-cdp");

const accountList = [{ name: "selected-account", configDir: "C:\\accounts\\selected" }, { name: "other-account", configDir: "C:\\accounts\\other" }];
const readyRecord = { version: 1, status: "ready", outcome: { goal: "Explain the test.", deliverable: "", beneficiary: "" }, context: { facts: [], identifiers: [], sources: [], dependencies: [] },
  success: { criteria: [] }, requirements: [], permissions: { authorized: [], confirm: [], prohibited: [] }, unresolved: [], conflicts: [] };
const unfinishedRecord = { ...readyRecord, status: "unfinished", conflicts: [{ earlier: "Keep the order.", later: "Sort alphabetically.", why: "Both govern order." }] };

/** Loads out/extension.js with stand-ins and resolves the board webview; `compile` replaces ./compile's compileDraft. */
function hostFixture({ compile, review = async () => { throw new Error("no review stand-in"); }, codex = { accounts: [], models: [] }, createRepo, completionRule }) {
  const posted = [], calls = [], reviewCalls = [], disposers = [], infos = [], switched = [], warnings = [], starts = [];
  const tabs = require("./helper-tab-stub").helperTabStub(), profiles = require("../out/profiles.js");
  const liveAccounts = [...accountList];
  const forbid = () => { throw new Error("This test must not open a window, launch a process, or create or send a task."); };
  const vscode = {
    ProgressLocation: { Notification: 1 },
    Uri: { joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => fallback }), onDidChangeConfiguration: () => ({ dispose() {} }) },
    window: { showErrorMessage: forbid, showInformationMessage: (m) => { infos.push(m); return Promise.resolve(); },
      withProgress: (_options, run) => run({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
      showWarningMessage: createRepo ? async (m) => { warnings.push(m); } : forbid },
  };
  const filename = require.resolve("../out/extension.js");
  const extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = (name) => {
    if (name === "vscode") return vscode;
    if (name === "child_process") return { execFile: forbid, execFileSync: forbid, spawn: forbid };
    if (name === "./compile") return { ...require("../out/compile"), compileDraft: async (...args) => { calls.push(args); return compile(...args); } };
    if (name === "./prompt-review") return { reviewImprovements: async (...args) => { reviewCalls.push(args); return review(...args); } };
    if (name === "./refine-context") return { refinementContext: (...a) => `context of ${a[0]} with ${a.length} args` };
    if (name === "./helper-tab") return tabs.module;
    if (name === "./jobs") return { projectInventory: () => undefined, projectContext: () => "fixture project" };
    if (name === "./prompt-lint") return require("../out/prompt-lint");
    if (name === "./text-actions") return { ...require("../out/text-actions"), ...(completionRule ? { completionRule } : {}) };
    if (name === "./checks" && completionRule) return require("../out/checks");
    if (name === "./board") return { accounts: () => accountList };
    if (name === "./accounts") return { accountRows: () => [], activeConfigDir: () => "", onAccountsChanged: () => ({ dispose() {} }), useAccount: async (dir) => { switched.push(dir); } };
    if (name === "./sessions") return { DEFAULT_DIR: path.join(os.homedir(), ".claude"), sameFolder: (a, b) => path.resolve(a || path.join(os.homedir(), ".claude")).toLowerCase() === path.resolve(b || path.join(os.homedir(), ".claude")).toLowerCase(), otherAccountDirs: (dir) => accountList.map((a) => a.configDir).filter((d) => d !== dir) };
    if (name === "./codex") return { codexAccounts: () => codex.accounts.map((name) => ({ name, configDir: "", provider: "codex" })), codexModels: () => codex.models,
      codexBinary: () => "codex", codexTextPath: () => "codex-cli", setCodexBinary() {}, placeCodexHook() {} };
    if (name === "./obsidian-board") return { obsidianSnapshot: () => undefined, contextSource: () => "asana" };
    if (name === "./cardTerminal") return require(path.join(path.dirname(filename), name));
    if (name === "./profiles") return profiles;
    if (name === "./queue" && createRepo) return require("../out/queue.js");
    if (name === "./models") return require("../out/models.js"); // pure: helper names with their version (F123)
    if (name.startsWith("./")) return {};
    return require(name);
  };
  extension._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.BoardView = BoardView; module.exports.handle = handle;\n", filename);
  const dir = path.join(os.tmpdir(), "ab-compile-host-test");
  const tasks = [{ id: "task-7", title: "Fix the login test", prompt: "Update the login fixture.", provider: "codex", model: "gpt-6.1-sol", status: "review" }];
  const board = { dir, repo: "/repo", tasks, get: (id) => tasks.find((t) => t.id === id), onChange: () => ({ dispose() {} }), add: forbid, start: forbid, startInPanel: forbid, send: forbid,
    configDirOf: (t) => { if (t.provider === "codex") return ""; const a = accountList.find((x) => x.name === t.account); if (!a) throw new Error(`Account ${t.account} is not available.`); return a.configDir; } };
  if (createRepo) Object.assign(board, {
    repo: createRepo, mustOwn() {}, accountList: () => liveAccounts,
    add(title, prompt, account, parentId, model, effort, completion, step) {
      const task = { id: `task-${tasks.length + 7}`, title, prompt, account, parentId, model, effort, completion, status: "queued", provider: "codex", ...step };
      tasks.push(task); return task;
    },
    profileProblem(task) {
      const result = profiles.resolve(task.profile, { provider: task.provider, mode: "terminal", inventory: { items: [], unknown: [] }, credential: () => false, routes: {} });
      if (result.state === "blocked") return result.reasons.map((r) => r.text).join("; ");
    },
    async start(task) { starts.push(task.id); },
  });
  let receive;
  const webview = { cspSource: "test", asWebviewUri: (u) => u.fsPath, postMessage: (m) => { posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: (cb) => { receive = cb; } };
  new extension.exports.BoardView({ fsPath: "ext" }, board).resolveWebviewView({ webview, onDidDispose: (cb) => disposers.push(cb) });
  return { receive: (m) => receive(m), handle: (m) => extension.exports.handle(board, m), posted, calls, reviewCalls, infos, switched, warnings, tasks, starts, liveAccounts, dir, tabs: tabs.tabs, dispose: () => disposers.forEach((d) => d()) };
}
const request = { type: "compile", requestId: "req-1", account: "selected-account", model: "opus", effort: "low", deep: false, draft: "Explain the test.", answers: "Q1\nUse the fixture." };
const fakeResult = (record) => ({ record, rendered: record.status === "ready" ? { format: "prose", text: "Explain the test. Deliver: the test." } : undefined,
  model: "claude-opus-5-5", usage: {}, elapsedMs: 1, promptVersion: "compile-2026-11-03-c1", receipt: "receipt.json", dropped: ["extra"],
  tally: { requirements: 0, criteria: 0, assumed: 0, mustAsk: 0, unresolved: 0 } });

// Since 4 November 2026 (the user, Q2) Improve ignores the task's model and effort: Fable at max on Claude, the newest Astra at its highest on Codex.
test("host: Improve runs on Fable at max and posts the rendered compilation to the webview only", async () => {
  const f = hostFixture({ compile: async () => fakeResult(readyRecord) });
  try {
    await f.receive({ ...request, deep: true });
    assert.equal(f.calls.length, 1);
    const [dir, draft, answers, configDir, model, effort, signal, fallbackConfigDirs] = f.calls[0];
    assert.ok(dir.startsWith(path.join(f.dir, "helpers") + path.sep) && /[0-9a-f-]{36}$/.test(dir), dir);
    assert.deepEqual([draft, answers, configDir, model, effort], [request.draft, request.answers, "C:\\accounts\\selected", "fable", "max"]);
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.deepEqual(fallbackConfigDirs, ["C:\\accounts\\other"], "the other Claude accounts, for a usage-limit fallback");
    const extra = f.calls[0][9];
    assert.equal(extra.context, "context of /repo with 1 args", "the same read-only project context Refine gets");
    assert.match(extra.executor, /^A new Claude Code session \(opus\) working in its own git worktree/, "the new task's session, not always Fable");
    assert.deepEqual(f.posted, [{ compilation: { requestId: "req-1", target: "new", original: request.draft, status: "ready", record: readyRecord,
      rendered: { format: "prose", text: "Explain the test. Deliver: the test." }, conflicts: [], dropped: ["extra"], sourceOnly: undefined, quarantined: undefined, oversize: undefined, lint: [],
      tally: { requirements: 0, criteria: 0, assumed: 0, mustAsk: 0, unresolved: 0 }, model: "claude-opus-5-5", effort: "max", promptVersion: "compile-2026-11-03-c1",
      controls: { account: "selected-account", model: "opus", effort: "low", permission: "" }, bindable: true } }]);
    assert.deepEqual(Object.keys(f.posted[0]), ["compilation"]); // nothing else leaves the host: no create, no send
    // Phase 1: the host saved the result for Add task to bind, keyed by the request, with the form's four settings.
    const saved = require("../out/compile").loadCandidate(f.dir, "req-1");
    assert.deepEqual([saved.target, saved.text, saved.draft, saved.answers, saved.controls, saved.rendererVersion],
      ["new", "Explain the test. Deliver: the test.", request.draft, request.answers, { account: "selected-account", model: "opus", effort: "low", permission: "" }, require("../out/compile").RENDERER_VERSION]);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual([f.switched, f.infos], [[], []], "no fallback, no default switch");
  } finally { f.dispose(); }
});

test("host: a compile answered by a fallback account makes that account the default", async () => {
  const f = hostFixture({ compile: async () => ({ ...fakeResult(readyRecord), configDir: "C:\\accounts\\other", note: "selected hit a usage limit, so other answered instead." }) });
  try {
    await f.receive({ ...request, requestId: "req-fallback" });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(f.switched, ["C:\\accounts\\other"]);
    assert.match(f.infos.join(), /hit a usage limit; .* is now the default account\.$/);
    assert.equal(f.posted[0].compilation.status, "ready");
  } finally { f.dispose(); }
});

test("host: a fallback account that is already the default is not switched again, but the user still sees the note", async () => {
  const note = "selected hit a usage limit, so ~/.claude answered instead.";
  const f = hostFixture({ compile: async () => ({ ...fakeResult(readyRecord), configDir: "", note }) }); // "" is ~/.claude, the stand-in's IDE default
  try {
    await f.receive({ ...request, requestId: "req-default" });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual([f.switched, f.infos], [[], [`Entomatical: ${note}`]]);
  } finally { f.dispose(); }
});

test("host: the asked-for account answering does not change the default account", async () => {
  const note = "selected hit a usage limit, then answered on retry.";
  const f = hostFixture({ compile: async () => ({ ...fakeResult(readyRecord), configDir: "C:\\accounts\\selected", note }) }); // the account the request asked for
  try {
    await f.receive({ ...request, requestId: "req-same" });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual([f.switched, f.infos], [[], [`Entomatical: ${note}`]]);
  } finally { f.dispose(); }
});

test("host: the selected account is used, its model and effort are not; a task id becomes the target", async () => {
  const f = hostFixture({ compile: async () => fakeResult(readyRecord) });
  try {
    await f.receive({ ...request, requestId: "req-2", id: "task-7", account: "other-account", model: "haiku", effort: "xhigh" });
    assert.deepEqual(f.calls[0].slice(1, 6), [request.draft, request.answers, "C:\\accounts\\other", "fable", "max"]);
    assert.equal(f.posted[0].compilation.target, "task-7");
    // A follow-up box: the reader is that task's live session, which already has its context.
    assert.match(f.calls[0][9].executor, /^The next message to the live Codex CLI session \(gpt-6\.1-sol\) of the task "Fix the login test"\. That session already has/);
    assert.equal(f.posted[0].compilation.effort, "max");
  } finally { f.dispose(); }
});

const CODEX = { accounts: ["Codex · user@example.com"], models: [{ model: "gpt-6.1-sol", efforts: ["low", "max", "ultra"] }, { model: "gpt-6-astra", efforts: ["medium", "ultra"] }] };
test("host: a Codex account improves on the newest Astra at its highest effort on the Codex CLI, with no Claude fallback", async () => {
  const f = hostFixture({ compile: async () => ({ ...fakeResult(readyRecord), model: "gpt-6.1-sol" }), codex: CODEX });
  try {
    await f.receive({ ...request, requestId: "req-codex", account: CODEX.accounts[0], model: "gpt-6.1-sol", effort: "max" });
    const [, draft, answers, configDir, model, effort, , fallbackConfigDirs, codexPath] = f.calls[0];
    assert.deepEqual([draft, answers, configDir, model, effort, fallbackConfigDirs, codexPath], [request.draft, request.answers, "", "gpt-6-astra", "ultra", [], "codex-cli"]);
    assert.match(f.calls[0][9].executor, /^A new Codex CLI session \(gpt-6\.1-sol\) .* Its first turn runs unattended/);
    assert.deepEqual([f.posted[0].compilation.status, f.posted[0].compilation.model, f.posted[0].compilation.effort], ["ready", "gpt-6.1-sol", "ultra"]);
    // The task's own model and effort do not matter, even one that model does not offer.
    await f.receive({ ...request, requestId: "req-codex-any", account: CODEX.accounts[0], model: "gpt-6.1-sol", effort: "xhigh" });
    assert.deepEqual(f.calls[1].slice(4, 6), ["gpt-6-astra", "ultra"]);
    // A Claude account still runs on Claude: no Codex CLI path.
    await f.receive({ ...request, requestId: "req-claude" });
    assert.equal(f.calls[2][8], undefined);
  } finally { f.dispose(); }
});

test("host: Review prompt runs the review on the Codex account and posts it to the webview only; without Codex it says why", async () => {
  const result = { attempts: [{ label: "Terra", model: "gpt-6.1-terra", effort: "max", status: "ready", format: "prose", prompt: "Explain it." }],
    review: { overview: "Terra kept the goal.", attempts: [], comparison: "", takeaways: [], model: "gpt-6-astra", effort: "ultra", elapsedMs: 5 } };
  const none = hostFixture({ compile: async () => fakeResult(readyRecord) });
  try {
    await none.receive({ type: "reviewPrompt", requestId: "rev-0", draft: "Explain the test.", answers: "" });
    assert.deepEqual([none.reviewCalls.length, none.posted.at(-1).compilation.error], [0, "Review prompt needs a signed-in Codex account."]);
  } finally { none.dispose(); }
  const f = hostFixture({ compile: async () => fakeResult(readyRecord), codex: CODEX, review: async (dir, draft, answers, codex, signal, onStage) => { onStage("Astra is reviewing their attempts…"); return result; } });
  try {
    await f.receive({ type: "reviewPrompt", requestId: "rev-1", id: "task-9", draft: request.draft, answers: request.answers, account: "selected-account", model: "opus", effort: "low" });
    const [dir, draft, answers, codex, signal] = f.reviewCalls[0];
    assert.ok(dir.startsWith(path.join(f.dir, "helpers") + path.sep), dir);
    assert.deepEqual([draft, answers, codex], [request.draft, request.answers, { path: "codex-cli", models: CODEX.models }]);
    // task-9 is not on this board, so the reader is the new task the form's account and model would start.
    assert.deepEqual([f.reviewCalls[0][6].context, f.reviewCalls[0][6].executor.slice(0, 40)], ["context of /repo with 1 args", "A new Claude Code session (opus) working"]);
    assert.ok(signal instanceof AbortSignal);
    assert.equal(f.calls.length, 0, "the selected Claude model is not used");
    assert.deepEqual(f.posted, [{ compilationStage: { requestId: "rev-1", target: "task-9", stage: "Astra is reviewing their attempts…" } },
      { compilation: { requestId: "rev-1", target: "task-9", original: request.draft, ...result } }]);
  } finally { f.dispose(); }
});

test("host: an unfinished record is posted with its conflicts and no rendered prompt", async () => {
  const f = hostFixture({ compile: async () => fakeResult(unfinishedRecord) });
  try {
    await f.receive({ ...request, requestId: "req-3" });
    const c = f.posted[0].compilation;
    assert.equal(c.status, "unfinished");
    assert.equal(c.rendered, undefined);
    assert.deepEqual(c.conflicts, unfinishedRecord.conflicts);
    assert.equal(c.promptVersion, "compile-2026-11-03-c1");
  } finally { f.dispose(); }
});

test("host: a bad account, a compiler failure and non-string inputs become webview errors, never windows or processes", async () => {
  const f = hostFixture({ compile: async (dir, draft) => { if (!draft) throw new Error("Use a nonempty draft."); return fakeResult(readyRecord); } });
  try {
    await f.receive({ ...request, requestId: "req-4", account: "missing-account" });
    assert.equal(f.calls.length, 0);
    assert.match(f.posted.at(-1).compilation.error, /account/i);
    assert.deepEqual(Object.keys(f.posted.at(-1).compilation), ["requestId", "target", "error"]);
    await f.receive({ ...request, requestId: "req-5", draft: 42, answers: null });
    assert.deepEqual(f.calls.at(-1).slice(1, 3), ["", ""]);
    assert.match(f.posted.at(-1).compilation.error, /nonempty draft/);
    await f.receive({ ...request, deep: true, requestId: 7 }); // not a string: ignored
    // No model or effort selected is fine since 4 November 2026: helpers always use Fable at max (Q2).
    await f.receive({ type: "compile", requestId: "req-6", account: "selected-account", model: "", effort: "", deep: false, draft: "x", answers: "" });
    assert.equal(f.posted.at(-1).compilation.error, undefined);
    assert.deepEqual(f.calls.at(-1).slice(4, 6), ["fable", "max"]);
    assert.equal(f.posted.length, 3);
  } finally { f.dispose(); }
});

test("host: a duplicate requestId while pending is ignored and cancelHelper aborts the compile", async () => {
  const f = hostFixture({ compile: (...args) => new Promise((resolve, reject) => { args[6].addEventListener("abort", () => reject(new Error("Text generation cancelled."))); }) });
  try {
    const first = f.receive({ ...request, requestId: "req-7" });
    await new Promise((r) => setImmediate(r));
    await f.receive({ ...request, requestId: "req-7" });
    assert.equal(f.calls.length, 1);
    await f.receive({ type: "cancelHelper", requestId: "req-7" });
    await first;
    assert.match(f.posted[0].compilation.error, /cancelled/);
    assert.equal(f.posted.length, 1);
  } finally { f.dispose(); }
});

// The real compiler and text job behind an intercepted claude spawn, in an isolated process so the spawn
// replacement cannot leak into other tests (same technique as test/refinement-routing.test.js).
async function captureCompileRouting() {
  const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
  const { EventEmitter } = require("node:events");
  const { PassThrough, Writable } = require("node:stream");
  const dir = process.argv[2];
  const calls = [];
  const record = { version: 1, status: "ready", outcome: { goal: "Explain the test.", deliverable: "A passing test.", beneficiary: "" }, context: { facts: [], identifiers: [], sources: [], dependencies: [] },
    success: { criteria: [] }, requirements: [{ id: "R1", text: "Keep the fixture small.", provenance: "user", strength: "mandatory", rationale: "" }], permissions: { authorized: [], confirm: [], prohibited: [] }, unresolved: [], conflicts: [] };
  require("node:child_process").spawn = (binary, args, options) => {
    const flag = (name) => args[args.indexOf(name) + 1];
    const requested = flag("--model").replace(/^claude-([a-z]+)-[\d-]+$/, "$1"), model = `claude-${requested}-5-5`;
    const schema = JSON.parse(flag("--json-schema"));
    assert.ok(schema.properties.requirements, "the compile call uses the task record schema");
    calls.push({ model: requested, effort: flag("--effort"), configDir: options.env.CLAUDE_CONFIG_DIR, cwd: options.cwd });
    const result = { type: "result", subtype: "success", is_error: false, session_id: "synthetic-compile", structured_output: record, subagent_stats: { spawned: 0 },
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: { [model]: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } };
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdin = new Writable({ write(chunk, encoding, callback) { callback(); }, final(callback) { callback(); queueMicrotask(() => { child.stdout.end(JSON.stringify(result)); child.emit("close", 0); }); } });
    return child;
  };
  const accountList = [{ name: "selected-account", configDir: path.join(dir, "selected") }];
  const posted = [], disposers = [];
  const forbid = () => { throw new Error("forbidden"); };
  const filename = process.argv[3];
  const extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = (name) => {
    if (name === "vscode") return { Uri: { joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
      workspace: { getConfiguration: () => ({ get: (k, f) => f }), onDidChangeConfiguration: () => ({ dispose() {} }) }, window: { showErrorMessage: forbid, showInformationMessage: forbid } };
    if (name === "./board") return { accounts: () => accountList };
    if (name === "./accounts") return { accountRows: () => [], activeConfigDir: () => "", onAccountsChanged: () => ({ dispose() {} }) };
    if (name === "./codex") return { codexAccounts: () => [], codexModels: () => [], codexBinary: () => "codex", codexTextPath: () => "codex", setCodexBinary() {}, placeCodexHook() {} };
    if (name === "./compile" || name === "./text-actions" || name === "./sessions" || name === "./jobs" || name === "./prompt-lint") return require(path.join(path.dirname(filename), name));
    if (name === "./refine-context") return { refinementContext: () => "" };
    if (name === "./helper-tab") return require(process.argv[4]).helperTabStub().module;
    if (name === "./obsidian-board") return { obsidianSnapshot: () => undefined, contextSource: () => "asana" };
    if (name === "./cardTerminal") return require(path.join(path.dirname(filename), name));
    if (name === "./profiles") return require(path.join(path.dirname(filename), name)); // pure: capability profiles (phase 2)
    if (name === "./models") return require(path.join(path.dirname(filename), name)); // pure: helper names with their version (F123)
    if (name.startsWith("./")) return {};
    return require(name);
  };
  extension._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.BoardView = BoardView;\n", filename);
  const board = { dir, repo: "/repo", tasks: [], get: () => undefined, onChange: () => ({ dispose() {} }), add: forbid, start: forbid, send: forbid, configDirOf: (t) => accountList.find((a) => a.name === t.account).configDir };
  let receive;
  const webview = { cspSource: "test", asWebviewUri: (u) => u.fsPath, postMessage: (m) => { posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: (cb) => { receive = cb; } };
  new extension.exports.BoardView({ fsPath: "ext" }, board).resolveWebviewView({ webview, onDidDispose: (cb) => disposers.push(cb) });
  try {
    await receive({ type: "compile", requestId: "real-1", account: "selected-account", model: "sonnet", effort: "medium", deep: true, draft: "Explain the test.", answers: "" });
    await receive({ type: "compile", requestId: "real-2", account: "selected-account", model: "sonnet", effort: "medium", deep: false, draft: "Explain the test.", answers: "" });
    assert.deepEqual(calls.map((c) => [c.model, c.effort, c.configDir]), [["fable", "max", accountList[0].configDir], ["fable", "max", accountList[0].configDir]], "both on Fable at max since 4 November 2026 (Q2)");
    // Helpers run outside the repository (4 November 2026); their schema, output and receipt stay in the helper folder.
    for (const c of calls) assert.ok(!c.cwd.startsWith(path.join(dir, "helpers")) && path.basename(c.cwd).startsWith("entomatical-helper-"), c.cwd);
    const helperDirs = fs.readdirSync(path.join(dir, "helpers")).map((d) => path.join(dir, "helpers", d));
    assert.equal(posted.length, 2);
    for (const [i, m] of posted.entries()) {
      assert.ok(m.compilation, JSON.stringify(m));
      assert.equal(m.compilation.error, undefined, m.compilation.error);
      assert.equal(m.compilation.status, "ready");
      assert.equal(m.compilation.model, "claude-fable-5-5");
      assert.ok(m.compilation.rendered.text.includes("Keep the fixture small."), m.compilation.rendered.text);
      assert.equal(m.compilation.promptVersion, "compile-2026-11-25-c4");
      assert.ok(!fs.existsSync(calls[i].cwd), "the neutral folder is removed once the process exits");
    }
    assert.equal(helperDirs.filter((d) => fs.existsSync(path.join(d, "compile-receipt.json"))).length, 2, "one receipt per compile, in its helper folder");
  } finally { disposers.forEach((d) => d()); }
}

test("host: the real compiler behind an intercepted claude spawn routes Deep to fable/max and posts a rendered prompt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-compile-routing-"));
  try {
    const script = path.join(dir, "capture.cjs");
    fs.writeFileSync(script, `(${captureCompileRouting.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`);
    execFileSync(process.execPath, [script, dir, require.resolve("../out/extension.js"), require.resolve("./helper-tab-stub")], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- The webview itself, in headless Microsoft Edge ----
test("webview: prompt controls, saved selections and compile scenarios in headless Edge with injected results", { timeout: 120_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview scenarios were not run."); return; }
  const harness = path.resolve(__dirname, "compile-webview-harness.html");
  const url = require("node:url").pathToFileURL(harness).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-compile-webview-"));
  let edge, page;
  const log = [];
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`Edge could not be launched: ${e.message}`); return; }
    const connect = async () => {
      const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
      page?.close();
      page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
      await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading in the harness");
    };
    await connect();
    assert.equal(await page.evaluate("window.__posted.map((m) => m.type).join()"), "ready", "board.js posts only its ready message on load");
    const reload = async () => { await page.send("Page.reload"); await new Promise((r) => setTimeout(r, 500)); await connect(); await page.evaluate(cdp.HELPERS); };
    await cdp.runPromptControlScenarios({ evaluate: (expr) => page.evaluate(expr), reload });
    await cdp.runScenarios({ evaluate: (expr) => page.evaluate(expr), log: (e) => log.push(e), reload });
    // (8) every observation after a compile was requested carried the compilations entry in persisted state.
    assert.ok(log.length >= 14, `observations: ${log.length}`);
    for (const e of log) { assert.equal(e.hasCompilations, true, `step ${e.step}: ${e.action}`); assert.ok(e.keys >= 8, `step ${e.step} persisted ${e.keys} keys`); }
    assert.ok(log.filter((e) => e.compilations.length === 1).length >= 9, "steps with a persisted compilation entry");
    const names = await page.evaluate("window.__posted.map((m) => m.type)");
    assert.ok(!names.some((n) => ["create", "send"].includes(n)), `nothing was created or sent: ${names}`);
  } finally {
    page?.close();
    if (edge) await edge.kill();
    // Edge's child processes can hold its profile a moment after the kill (EPERM seen 30 Oct and 4 Nov 2026 under a full npm test).
    removeScratch(t, scratch);
  }
});

test("UI-B01: Create rechecks its parent, account and pinned profile after the rule writer returns", async (t) => {
  const { saveRevision, PROFILE_FILE } = require("../out/profiles");
  for (const changed of ["none", "parent", "account", "profile revision", "profile removed", "legacy request"]) {
    await t.test(changed, async (sub) => {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-create-context-"));
      const started = Promise.withResolvers(), rule = Promise.withResolvers();
      const f = hostFixture({ createRepo: scratch, completionRule: async () => { started.resolve(); return rule.promise; } });
      try {
        const file = path.join(scratch, "workflows", PROFILE_FILE), variants = { codex: { items: [] } };
        const { ref, revision } = saveRevision(file, "workspace", { name: "Strict fixture", variants });
        const parentId = f.tasks[0].id, account = f.liveAccounts[1].name;
        const create = { type: "create", title: "Fixture child", prompt: "Use the prepared context.", parentId, account, profile: ref, autoRule: true,
          ...(changed === "legacy request" ? {} : { createId: "fixture-request", profileRevision: revision }) };
        const creating = f.handle(create);
        await Promise.race([started.promise, creating.then(() => assert.fail("Create must wait for the rule"))]);
        if (changed === "parent") f.tasks.shift();
        if (changed === "account") f.liveAccounts.pop();
        if (changed === "profile revision" || changed === "legacy request") saveRevision(file, "workspace", { name: "New fixture revision", variants }, ref);
        if (changed === "profile removed") fs.unlinkSync(file);
        rule.resolve({ rule: { commands: [], doneWhen: "Fixture is complete.", goal: "Fixture goal." }, answered: [], dropped: [] });
        if (changed === "none" || changed === "legacy request") {
          await creating;
          const task = f.tasks.at(-1);
          assert.deepEqual([f.tasks.length, task.parentId, task.account, task.profile.snapshot.revision, task.status],
            [2, parentId, account, changed === "none" ? revision : revision + 1, "queued"]);
          assert.equal(task.completion?.doneWhen, "Fixture is complete.");
        } else {
          const field = changed.split(" ")[0];
          const count = f.tasks.length;
          await assert.rejects(creating, { field });
          assert.equal(f.tasks.length, count, "the refusal makes zero Add calls");
        }
        assert.deepEqual(f.starts, [], "the strict profile or the refusal makes zero Start calls");
      } finally { f.dispose(); removeScratch(sub, scratch); }
    });
  }
});

test("UI-B01: a reloaded card draft keeps its parent, second account and held profile, and requires explicit replacements", { timeout: 120_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine."); return; }
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html"));
  url.search = "manual-snapshot";
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-draft-context-"));
  let edge, page, f;
  try {
    const { saveRevision, PROFILE_FILE } = require("../out/profiles");
    const name = "Held draft profile";
    const { ref, revision } = saveRevision(path.join(scratch, "workflows", PROFILE_FILE), "workspace", { name, variants: { codex: { items: [] } } });
    f = hostFixture({ createRepo: scratch });
    const accounts = accountList.map((a) => a.name);
    const profile = { ref, revision, name, scope: "workspace", blocked: { [accounts[1]]: "Strict scope is not enabled for this route." } };
    edge = await cdp.launchEdge(url.href, scratch);
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url === url.href), "the draft-context harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await page.send("Runtime.enable");
    const reload = async () => {
      await page.send("Page.enable");
      await page.evaluate("window.__ready = false");
      await page.send("Page.reload");
      await cdp.waitFor(() => page.evaluate("window.__ready === true"), "recreated board.js to load");
      await page.evaluate(cdp.HELPERS);
    };
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to load");
    const { create, legacy } = await cdp.runDraftContextScenarios({ evaluate: (expr) => page.evaluate(expr), reload, parent: f.tasks[0], accounts, profile });
    assert.ok(!page.events.some((event) => event.method === "Runtime.exceptionThrown"), "the browser scenarios complete without script errors");
    await f.handle(create);
    const card = f.tasks[1];
    assert.deepEqual([card.parentId, card.account, card.status, card.profile.snapshot.id, card.profile.snapshot.revision],
      [f.tasks[0].id, accounts[1], "queued", ref, revision]);
    assert.match(f.warnings[0], /card was added but not started.*strict scope is not enabled/i);
    assert.deepEqual(f.starts, [], "fixture auto-start makes zero start calls for the restored strict profile");
    await f.handle(legacy);
    assert.deepEqual(f.starts, [f.tasks[2].id], "the fixture counts an allowed auto-start for a legacy draft");
  } catch (error) {
    for (const event of page?.events || []) if (event.method === "Runtime.exceptionThrown") t.diagnostic(event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
    throw error;
  } finally { f?.dispose(); page?.close(); if (edge) await edge.kill(); removeScratch(t, scratch); }
});

test("host: Improve prompt and Review prompt each open their own tab and stream into it; the board gets the same messages", async () => {
  const f = hostFixture({ compile: async (...args) => { args[10].prompt("PACKET"); args[10].line("thinking…", "thinking"); return fakeResult(readyRecord); } });
  try {
    await f.receive({ ...request, requestId: "tab-1" });
    const tab = f.tabs[0];
    assert.equal(tab.key, "1:new:improve");
    assert.deepEqual([tab.run.title, tab.run.kind, tab.run.detail], ["Improve prompt", "improve", "fable · max effort · selected-account"]);
    assert.deepEqual(tab.events.slice(0, 3), [["output", "", "log", "Model: maximum policy: Claude Fable at max effort."], ["prompt", "PACKET"], ["output", "", "thinking", "thinking…"]]);
    assert.equal(tab.events.at(-1)[0], "finish");
    assert.equal(tab.events.at(-1)[1].text, "Explain the test. Deliver: the test.");
    assert.equal(f.posted.at(-1).compilation.rendered.text, "Explain the test. Deliver: the test.");
  } finally { f.dispose(); }
  const result = { attempts: [{ label: "Terra", model: "gpt-6.1-terra", effort: "max", status: "ready", prompt: "Explain it." }],
    review: { overview: "Terra kept the goal.", attempts: [], comparison: "", takeaways: [], model: "gpt-6-astra", effort: "ultra", elapsedMs: 5 } };
  const r = hostFixture({ compile: async () => fakeResult(readyRecord), codex: CODEX, review: async (dir, draft, answers, codex, signal, onStage, extra, output) => {
    onStage("Terra and Sol are improving the prompt…"); output("Terra (gpt-6.1-terra)")("T thinks", "thinking"); return result; } });
  try {
    await r.receive({ type: "reviewPrompt", requestId: "tab-2", id: "task-7", draft: request.draft, answers: "", account: "selected-account", model: "opus", effort: "low" });
    const tab = r.tabs[0];
    assert.deepEqual([tab.key, tab.run.title], ["1:task-7:review", "Review: Fix the login test"]);
    assert.deepEqual(tab.events.slice(0, 2), [["stage", "Terra and Sol are improving the prompt…"], ["output", "Terra (gpt-6.1-terra)", "thinking", "T thinks"]]);
    assert.deepEqual(tab.events.at(-1), ["finish", { text: "Terra kept the goal.", notes: ["Terra (gpt-6.1-terra · max effort): finished"] }, "gpt-6-astra"]);
    assert.deepEqual(r.posted.at(-1), { compilation: { requestId: "tab-2", target: "task-7", original: request.draft, ...result } });
  } finally { r.dispose(); }
});

test("webview: the helper tab page in headless Edge: full and batched posts, a quiet live region, Cancel, the result", { timeout: 60_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge (msedge.exe), Chrome or Chromium is not available on this machine; the helper tab page was not driven."); return; }
  const harness = path.resolve(__dirname, "helper-tab-harness.html");
  const url = require("node:url").pathToFileURL(harness).href;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-helper-tab-"));
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, scratch); } catch (e) { t.skip(`Edge could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "helper-tab.js to load");
    await cdp.runHelperTabScenarios({ evaluate: (expr) => page.evaluate(expr) });
  } finally { page?.close(); if (edge) await edge.kill(); removeScratch(t, scratch); }
});

/** Removes an Edge scratch folder. One still held after kill() waited for Edge to exit is reported, not failed: the page checks ran. */
function removeScratch(t, scratch) {
  try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
  catch (e) { t.diagnostic(`left ${scratch} under the temp folder: ${e.code ?? e.message}`); }
}
