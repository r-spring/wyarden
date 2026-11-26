// The board's "refine" message handler in src/extension.ts, run end to end against fake modules (the same isolated loading as
// extension-create.test.js). The account lookup is the real Board.prototype.configDirOf; only the model call is replaced.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
// board.js imports "vscode"; load it once with a bare stand-in (configDirOf touches none of it), then restore the loader.
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? {} : load.call(this, request, ...rest); };
const { Board } = require("../out/board");
Module._load = load;
const textActions = require("../out/text-actions");

const CLAUDE = { name: "me@example.test", configDir: "/fake/claude-me" };
const CODEX = { name: "Codex · me@example.test", provider: "codex" };

const { helperTabStub } = require("./helper-tab-stub");

/** extra.modules replaces or adds modules; extra.board adds to the board (the F102 pick tests below). */
function fixture(generate, extra = {}) {
  const calls = [], messages = [], stub = helperTabStub(), tabs = stub.tabs;
  const forbid = () => { throw new Error("This test must not launch a process."); };
  const disposable = { dispose() {} };
  const vscode = {
    Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join("/") }) },
    workspace: { onDidChangeConfiguration: () => disposable, getConfiguration: () => ({ get: (key, fallback) => fallback }) },
    window: { showErrorMessage: forbid, showWarningMessage: forbid, showInformationMessage: forbid, withProgress: (options, run) => run({ report() {} }) },
    ProgressLocation: { Notification: 15 },
  };
  const modules = {
    vscode,
    child_process: { execFile: forbid, execFileSync: forbid, spawn: forbid },
    "./board": { accounts: () => [CLAUDE, CODEX] },
    "./accounts": { accountRows: () => [], activeConfigDir: () => "", onAccountsChanged: () => disposable },
    "./codex": { codexAccounts: () => [CODEX], codexBinary: () => "/fake/codex", codexTextPath: () => "/fake/codex", codexModels: () => [{ model: "gpt-a", efforts: ["medium"] }, { model: "gpt-6-astra", efforts: ["high", "max", "ultra"] }] },
    "./sessions": { DEFAULT_DIR: "/fake/home/.claude", otherAccountDirs: dir => [`other-than:${dir}`] },
    "./refine-context": { refinementContext: (...a) => `context of ${a[0]}, ${a.length} args` },
    "./jobs": { projectInventory: () => undefined }, // no repository here: the advisory lint makes no existence checks
    "./prompt-lint": require("../out/prompt-lint"),
    "./text-actions": { helperPolicy: textActions.helperPolicy, generateText: async (...args) => {
      calls.push({ configDir: args[3], model: args[4], effort: args[7], codexPath: args[8], fallbacks: args[9], context: args[10], executor: args[12],
        ...(args[13] ? { draft: args[2], handoff: args[13] } : {}) });
      if (generate) return generate(...args);
      return { value: { kind: "unchanged", revision: "", questions: [], assumptions: [] }, model: args[4] };
    } },
    "./helper-tab": stub.module,
    "./action-picks": require("../out/action-picks"),
    "./handoffs": require("../out/handoffs"), // Refine draft's handoff detection (plan 70d079 step 4)
    ...extra.modules,
  };
  const filename = require.resolve("../out/extension.js");
  const extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = name => {
    if (name in modules) return modules[name];
    if (name === "./obsidian-board") return { obsidianSnapshot: () => undefined, contextSource: () => "asana" };
    if (name === "./error-log") return require("../out/error-log.js"); // F103: the Review and Finish error log, in the board's folder
    if (name === "./cardTerminal") return require(path.join(path.dirname(filename), name));
    if (name === "./profiles") return require("../out/profiles.js"); // pure: capability profiles (phase 2)
    if (name.startsWith("./")) return {};
    return require(name);
  };
  extension._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.BoardViewForTest = BoardView;\n", filename);
  // A board with only what refine touches; configDirOf is the production method over this account list.
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "refine-board-"));
  const board = { repo: "/fake/repo", tasks: [{ title: "Other work", status: "running" }], dir, get: () => undefined, onChange: () => disposable, accountList: () => [CLAUDE, CODEX], configDirOf: Board.prototype.configDirOf, ...extra.board };
  const view = new extension.exports.BoardViewForTest({ path: "/ext" }, board);
  function attach() {
    let receive; const disposers = [];
    view.resolveWebviewView({
      webview: { cspSource: "csp", asWebviewUri: uri => uri.path, postMessage: async m => { messages.push(m); },
        onDidReceiveMessage: cb => { receive = cb; return disposable; } },
      onDidDispose: cb => { disposers.push(cb); return disposable; },
    });
    return { send: m => receive(m), dispose: () => disposers.splice(0).forEach(d => d()) };
  }
  const first = attach();
  return { send: first.send, attach, calls, messages, tabs, deactivate: () => extension.exports.deactivate(),
    close() { first.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("disposing each board attachment releases the owner registered for its draft helpers", async (t) => {
  const f = fixture();
  t.after(() => f.close());
  for (let i = 0; i < 8; i++) {
    const board = f.attach();
    try {
      await board.send({ type: "refine", requestId: `r${i}`, draft: "Fix the bug", account: CLAUDE.name });
      const tab = f.tabs.at(-1);
      assert.equal(tab.key, `${tab.boardKey}:new:refine`);
      assert.equal(tab.events.at(-1)[0], "finish");
    } finally { board.dispose(); }
    assert.deepEqual(f.tabs.at(-1), { released: f.tabs.at(-2).boardKey });
  }
  assert.equal(new Set(f.tabs.filter(tab => tab.key).map(tab => tab.boardKey)).size, 8);
});

// Since 4 November 2026 (the user, Q2) Refine ignores the task's model and effort: the newest Astra at its highest effort on Codex, Fable at max on Claude.
test("Refine draft on a Codex account runs on Codex, on the newest Astra at its highest effort", async () => {
  const f = fixture();
  try {
    await f.send({ type: "refine", requestId: "r1", draft: "Fix the bug", account: CODEX.name, model: "gpt-a", effort: "medium" });
    const reply = f.messages.find(m => m.refinement)?.refinement;
    assert.equal(reply.error, undefined, reply.error);
    assert.equal(reply.kind, "unchanged");
    assert.deepEqual(f.calls.map(({ executor, ...c }) => c), [{ configDir: "", model: "gpt-6-astra", effort: "ultra", codexPath: "/fake/codex", fallbacks: [], context: "context of /fake/repo, 1 args" }]);
    assert.match(f.calls[0].executor, /^A new Codex CLI session \(gpt-a\)/, "Refine is told who receives the result");
  } finally { f.close(); }
});

test("UI-H04: a fresh view attributes an applied Refine revision using the finished host receipt", async (t) => {
  const revision = "Verify the fixture.", requestId = "saved-refine";
  let receipt;
  const first = fixture(async (dir, purpose) => {
    assert.equal(purpose, "refine");
    receipt = path.join(dir, "refine-receipt.json");
    fs.writeFileSync(receipt, JSON.stringify({ kind: "refine", receiptStatus: "done", outcome: "revision" }));
    return { value: { kind: "revision", revision, questions: [], assumptions: [] }, model: "fable", receipt };
  });
  t.after(first.close);
  await first.send({ type: "refine", requestId, id: "card", draft: "Check it.", account: CLAUDE.name });
  assert.equal(first.messages.find((m) => m.refinement).refinement.revision, revision);
  const dir = path.dirname(path.dirname(path.dirname(receipt)));
  const task = { id: "card", title: "Fixture", status: "running" };
  const restored = fixture(undefined, { board: { dir, get: () => task, async send() {} }, modules: { "./compile": require("../out/compile") } });
  t.after(restored.close);
  const send = { type: "send", id: task.id, text: revision, helpers: [{ requestId, kind: "refine", edited: false, receipt: "untrusted" }] };
  await restored.send(send);
  fs.writeFileSync(receipt, JSON.stringify({ kind: "refine", receiptStatus: "failed" }));
  await restored.send(send);
  const rows = fs.readFileSync(path.join(dir, "provenance.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map((r) => [r.source, r.helpers[0].receipt]), [["refine", path.relative(dir, receipt)], ["unknown", null]]);
});

test("Refine draft in handoff mode: a marker draft or a bare docs/handoffs path reaches generateText as a handoff, and the board and tab say so", async () => {
  const repo = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ab-refine-handoff-"));
  const f = fixture((...args) => ({ value: { kind: "revision", revision: `Goal: x.\n\nFull handoff: ${args[13]?.path}`, questions: [], assumptions: [] }, model: "fable" }));
  try {
    const dir = path.join(repo, "docs", "handoffs"), file = path.join(dir, "next.md");
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, "# Next\nShip it.\n");
    const marker = `<!-- handoff: ${file.replace(/\\/g, "/")} -->\n# Next (edited)\n`;
    await f.send({ type: "refine", requestId: "h1", draft: marker, account: CLAUDE.name });
    await f.send({ type: "refine", requestId: "h2", draft: ` ${file} `, account: CLAUDE.name });
    await f.send({ type: "refine", requestId: "h3", draft: path.join(dir, "missing.md"), account: CLAUDE.name });
    const p = file.replace(/\\/g, "/");
    assert.deepEqual(f.calls.map((c) => c.handoff), [{ path: p, text: "# Next (edited)\n" }, { path: p, text: "# Next\nShip it.\n" }, undefined]);
    assert.equal(f.calls[1].draft, `<!-- handoff: ${p} -->\n# Next\nShip it.\n`, "a bare path is read and sent with its marker line");
    assert.deepEqual(f.messages.filter((m) => m.refinementMode).map((m) => m.refinementMode), [
      { requestId: "h1", target: "new", handoff: "next.md" }, { requestId: "h2", target: "new", handoff: "next.md" }], "no mode message for an ordinary draft");
    const replies = f.messages.filter((m) => m.refinement).map((m) => m.refinement);
    assert.deepEqual(replies.map((r) => [r.requestId, r.handoff, r.original]), [["h1", "next.md", marker], ["h2", "next.md", ` ${file} `], ["h3", undefined, path.join(dir, "missing.md")]],
      "the original is the box's text, so Apply's check still holds");
    const logged = (i) => f.tabs[i].events.filter((e) => e[0] === "output").map((e) => e[3]);
    assert.ok(logged(0).includes(`Handoff detected: writing a task prompt from next.md (${p}).`), "the Refine tab says so");
    assert.ok(!logged(2).some((l) => /Handoff/.test(l)), "not for an ordinary draft");
    assert.ok(f.tabs[0].events.find((e) => e[0] === "finish")[1].notes.includes(`Task prompt for a new session, from the handoff ${p}.`));
  } finally { f.close(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("Refine draft on a Claude account runs on Fable at max in that account's folder, with the other accounts as fallbacks", async () => {
  const f = fixture();
  try {
    await f.send({ type: "refine", requestId: "r2", draft: "Fix the bug", account: CLAUDE.name, model: "sonnet", effort: "high" });
    const reply = f.messages.find(m => m.refinement)?.refinement;
    assert.equal(reply.error, undefined, reply.error);
    assert.deepEqual(f.calls.map(({ executor, ...c }) => c), [{ configDir: CLAUDE.configDir, model: "fable", effort: "max", codexPath: undefined, fallbacks: [`other-than:${CLAUDE.configDir}`], context: "context of /fake/repo, 1 args" }]);
  } finally { f.close(); }
});

test("Refine draft opens its tab, streams the run into it, and still posts the result to the board's draft box", async () => {
  const f = fixture(async (...args) => {
    args[11].prompt("THE PACKET"); args[11].line("Claude sonnet started."); args[11].line("Let me think", "thinking"); args[11].line('{"kind"', "answer");
    return { value: { kind: "revision", revision: "Goal: x", questions: [], assumptions: ["A"] }, model: "claude-sonnet-5-5" };
  });
  try {
    await f.send({ type: "refine", requestId: "r3", draft: "Fix the bug", account: CLAUDE.name, model: "sonnet", effort: "high" });
    const tab = f.tabs[0];
    assert.equal(tab.key, "1:new:refine");
    assert.equal(tab.run.title, "Refine draft");
    assert.equal(tab.run.kind, "refine");
    assert.equal(tab.run.draft, "Fix the bug");
    assert.equal(tab.run.detail, `fable · max effort · ${CLAUDE.name}`);
    assert.deepEqual(tab.events.slice(0, 6), [["output", "", "log", "Model: maximum policy: Claude Fable at max effort."], ["output", "", "log", "Project context gathered (29 characters)."], ["prompt", "THE PACKET"],
      ["output", "", "log", "Claude sonnet started."], ["output", "", "thinking", "Let me think"], ["output", "", "answer", '{"kind"']]);
    assert.deepEqual(tab.events.at(-1), ["finish", { text: "Goal: x", notes: ["Assumption: A", "The result is also on the board under the new-task box: apply it, or answer the questions, there."] }, "claude-sonnet-5-5"]);
    const reply = f.messages.find(m => m.refinement)?.refinement;
    assert.deepEqual(reply, { requestId: "r3", target: "new", original: "Fix the bug", kind: "revision", revision: "Goal: x", questions: [], assumptions: ["A"], lint: [], model: "claude-sonnet-5-5", effort: "max" },
      "the board gets the same message as before the tab existed");
    await f.send({ type: "showHelper", requestId: "r3" });
    assert.deepEqual(f.tabs.at(-1), { shown: "r3" });
  } finally { f.close(); }
});

test("Cancelling from the board marks the tab cancelled; a bad selection shows as a failure in the tab and an error on the board", async () => {
  const f = fixture((...args) => new Promise((resolve, reject) => { args[6].addEventListener("abort", () => reject(new Error("Text generation cancelled or timed out."))); }));
  try {
    const running = f.send({ type: "refine", requestId: "r4", id: "task-1", draft: "Fix the bug", account: CLAUDE.name, model: "sonnet", effort: "high" });
    await new Promise(r => setImmediate(r));
    assert.equal(f.tabs[0].key, "1:task-1:refine");
    await f.send({ type: "cancelHelper", requestId: "r4" });
    await running;
    assert.deepEqual(f.tabs[0].events.at(-1), ["fail", "Text generation cancelled or timed out.", true]);
    assert.equal(f.messages.find(m => m.refinement)?.refinement.error, "Text generation cancelled or timed out.");
    await f.send({ type: "refine", requestId: "r5", draft: "Fix the bug", account: "nobody", model: "sonnet", effort: "high" });
    assert.deepEqual(f.tabs.at(-1).events, [["fail", "Select an available account before refining or improving a draft.", false]]);
  } finally { f.close(); }
});

test("advisory lint: a revision that carries a helper folder path is flagged to the board and the tab, and still offered whole", async () => {
  const leaked = "Goal: fix it. Context: run from /x/.entomatical/helpers/b3f41ee9-49c8-447e-a7a2-d05ff4d185c2 (branch main, clean working tree).";
  const f = fixture(async (...args) => ({ value: { kind: "revision", revision: leaked, questions: [], assumptions: [] }, model: "claude-fable-5-1" }));
  try {
    await f.send({ type: "refine", requestId: "r6", draft: "Fix it.", account: CLAUDE.name, model: "sonnet", effort: "high" });
    const reply = f.messages.find(m => m.refinement)?.refinement;
    assert.equal(reply.revision, leaked, "nothing is removed");
    assert.deepEqual(reply.lint.map(l => l.kind), ["helper-path", "git-status"]);
    assert.ok(f.tabs[0].events.at(-1)[1].notes.some(n => n.startsWith("Check: Names an Entomatical helper folder")));
  } finally { f.close(); }
});

test("a reloaded board stops its running helpers, and deactivate() stops every helper (F19-2, F19-3)", async () => {
  const hang = (...args) => new Promise((resolve, reject) => { args[6].addEventListener("abort", () => reject(new Error("Text generation cancelled or timed out."))); });
  let f = fixture(hang);
  try {
    const running = f.send({ type: "refine", requestId: "r7", draft: "Fix it.", account: CLAUDE.name, model: "sonnet", effort: "high" });
    await new Promise(r => setImmediate(r));
    await f.send({ type: "ready" }).catch(() => {}); // the redraw after it needs modules this fixture leaves out; the abort comes first
    await running;
    assert.deepEqual(f.tabs[0].events.at(-1), ["fail", "Text generation cancelled or timed out.", true], "the reload cancelled the call");
  } finally { f.close(); }
  f = fixture(hang);
  try {
    const running = f.send({ type: "refine", requestId: "r8", draft: "Fix it.", account: CLAUDE.name, model: "sonnet", effort: "high" });
    await new Promise(r => setImmediate(r));
    f.deactivate();
    await running;
    assert.equal(f.tabs[0].events.at(-1)[2], true, "deactivate cancelled the call");
  } finally { f.close(); }
});

// F102 (the user, 13 November 2026): a right-click pick is the action's default from then on, and the handlers run on it.
// The redraw after setActionPick needs modules this fixture leaves out; the pick is stored before it.
const setPick = (f, action, pick) => f.send({ type: "setActionPick", action, pick }).catch(() => {});

test("F102: Refine draft runs on its right-click pick (Opus at high), Improve keeps its own default, and Reset to default restores Fable at max", async () => {
  const compiled = [];
  const f = fixture(undefined, { modules: { "./compile": { ...require("../out/compile"), compileDraft: async (...args) => {
    compiled.push({ configDir: args[3], model: args[4], effort: args[5], via: args[8] });
    return { record: { status: "ok", conflicts: [] }, receipt: "receipt", model: args[4], dropped: [], sourceOnly: [], quarantined: [] };
  } } } });
  try {
    await setPick(f, "refine", { provider: "claude", model: "opus", effort: "high" });
    await f.send({ type: "refine", requestId: "p1", draft: "Fix the bug", account: CLAUDE.name, model: "sonnet", effort: "low" });
    await f.send({ type: "compile", requestId: "p2", draft: "Fix the bug", account: CLAUDE.name, model: "sonnet", effort: "low" });
    assert.deepEqual(f.calls.map((c) => [c.configDir, c.model, c.effort]), [[CLAUDE.configDir, "opus", "high"]], "Refine ran on the pick");
    assert.deepEqual(f.tabs[0].events[0], ["output", "", "log", "Model: your pick: Claude opus at high effort."]);
    assert.equal(f.tabs[0].run.detail, `opus · high effort · ${CLAUDE.name}`);
    assert.deepEqual(compiled.map((c) => [c.configDir, c.model, c.effort]), [[CLAUDE.configDir, "fable", "max"]], "Improve has no pick: the maximum policy");
    await setPick(f, "refine", {});
    await f.send({ type: "refine", requestId: "p3", draft: "Fix the bug", account: CLAUDE.name });
    assert.deepEqual(f.calls.at(-1).model + "/" + f.calls.at(-1).effort, "fable/max");
  } finally { f.close(); }
});

test("F102: Improve prompt's pick names the Codex account and a model: it runs there although the form's account is Claude", async () => {
  const compiled = [];
  const f = fixture(undefined, { modules: { "./compile": { ...require("../out/compile"), compileDraft: async (...args) => {
    compiled.push({ configDir: args[3], model: args[4], effort: args[5], via: args[8] });
    return { record: { status: "ok", conflicts: [] }, receipt: "receipt", model: args[4], dropped: [], sourceOnly: [], quarantined: [] };
  } } } });
  try {
    await setPick(f, "improve", { account: CODEX.name, provider: "codex", model: "astra", effort: "high" });
    await f.send({ type: "compile", requestId: "q1", draft: "Fix the bug", account: CLAUDE.name, model: "sonnet", effort: "low" });
    assert.equal(f.messages.find((m) => m.compilation)?.compilation.error, undefined);
    assert.deepEqual(compiled, [{ configDir: "", model: "gpt-6-astra", effort: "high", via: "/fake/codex" }]);
    // A pick of an account that is no longer on the board falls back to the form's account and its default.
    await setPick(f, "improve", { account: "gone@example.test", provider: "codex", model: "astra" });
    await f.send({ type: "compile", requestId: "q2", draft: "Fix the bug", account: CLAUDE.name });
    assert.deepEqual(compiled.at(-1), { configDir: CLAUDE.configDir, model: "fable", effort: "max", via: undefined });
  } finally { f.close(); }
});

test("F102: Review runs on its pick (Opus at high on the card's account); with no pick it is Fable at medium as before", async () => {
  const routes = [];
  const reviewStub = { ...require("../out/done-review"), canReview: () => undefined, reviewInput: async () => ({ work: { diff: "", untracked: "", cut: [], skipped: [] } }),
    reviewPrompt: () => "THE PROMPT", worktreeSnapshot: async () => undefined, reviewMarkdown: () => "md", writeReview: () => "/fake/review.md",
    reviewWork: async (dir, prompt, route, signal, meta) => { routes.push({ model: route.model, effort: route.effort, configDir: route.configDir, provider: meta.provider ?? "claude" });
      return { result: { verdict: "done", findings: [], other: "", explanation: "", prompt: "", questions: [] }, model: route.model, receipt: "r" }; } };
  const task = { id: "c1", title: "Card", prompt: "p", status: "review", account: CLAUDE.name, worktree: "/fake/wt", completion: { doneWhen: "x", commands: [] } };
  const f = fixture(undefined, { modules: { "./done-review": reviewStub }, board: { get: (id) => (id === "c1" ? task : undefined), tasks: [task], mustOwn() {}, isOwner: () => true, update() {} } });
  try {
    await f.send({ type: "reviewWork", id: "c1" }).catch(() => {});
    await setPick(f, "review", { provider: "claude", model: "opus", effort: "high" });
    await f.send({ type: "reviewWork", id: "c1" }).catch(() => {});
    // A pick made for Codex does not apply to a Claude card's own account; naming the Codex account moves the review there.
    await setPick(f, "review", { provider: "codex", model: "astra", effort: "high" });
    await f.send({ type: "reviewWork", id: "c1" }).catch(() => {});
    await setPick(f, "review", { account: CODEX.name, provider: "codex", model: "astra", effort: "high" });
    await f.send({ type: "reviewWork", id: "c1" }).catch(() => {});
    assert.deepEqual(routes, [
      { model: "fable", effort: "medium", configDir: CLAUDE.configDir, provider: "claude" },
      { model: "opus", effort: "high", configDir: CLAUDE.configDir, provider: "claude" },
      { model: "fable", effort: "medium", configDir: CLAUDE.configDir, provider: "claude" },
      { model: "gpt-6-astra", effort: "high", configDir: "", provider: "codex" }]);
  } finally { f.close(); }
});

test("F102: Finish hands its pick (model, effort, permission mode) to the board's finish; with none it hands none", async () => {
  const task = { id: "c1", title: "Card", prompt: "p", status: "review", account: CLAUDE.name, worktree: "/fake/wt", branch: "task/c1" };
  const handed = [];
  const f = fixture(undefined, { board: { get: (id) => (id === "c1" ? task : undefined), tasks: [task], finalReply: () => "",
    complete: async (...args) => { handed.push(args[5]); return false; } } });
  try {
    await f.send({ type: "finish", id: "c1" }).catch(() => {});
    await setPick(f, "finish", { provider: "claude", model: "opus", effort: "high", permission: "bypass" });
    await f.send({ type: "finish", id: "c1" }).catch(() => {});
    assert.deepEqual(handed, [{ pick: undefined }, { pick: { provider: "claude", model: "opus", effort: "high", permission: "bypass" } }]);
  } finally { f.close(); }
});
