// Host side of Add task with the completion rule tickbox (src/extension.ts prepareRule); the title is test/extension-create.test.js's.
// out/extension.js runs on VS Code stand-ins; the helpers are stand-ins too, so no model is called.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { withRule } = require("../out/text-actions.js");
const { findingsText } = require("../out/done-review.js");
const { helperTabStub } = require("./helper-tab-stub");
// board.js imports "vscode"; load it once with a bare stand-in (sendPrompt touches none of it), then restore the loader.
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? {} : load.call(this, request, ...rest); };
const { Board } = require("../out/board");
Module._load = load;

function host(board, helpers, cancelled = false) {
  const posted = [], errors = [], infos = [], warnings = [], reports = [], disposers = [], clipboard = [];
  const tabStub = helperTabStub();
  const forbid = () => { throw new Error("This test must not open a window or launch a process."); };
  const vscode = {
    Uri: { joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
    env: { clipboard: { writeText: async (t) => { clipboard.push(t); } } },
    ProgressLocation: { Notification: 15 },
    // Auto-start off: the test is about the card that gets added, not its session.
    workspace: { getConfiguration: () => ({ get: (key, fallback) => (key === "autoStart" ? false : fallback) }), onDidChangeConfiguration: () => ({ dispose() {} }) },
    window: { showErrorMessage: (m) => { errors.push(m); }, showInformationMessage: async (m) => { infos.push(m); }, showWarningMessage: async (m) => { warnings.push(m); },
      withProgress: async (_o, work) => work({ report: (p) => reports.push(p.message) },
        { isCancellationRequested: cancelled, onCancellationRequested: (cb) => { if (cancelled) setTimeout(cb, 5); return { dispose() {} }; } }) },
  };
  const filename = require.resolve("../out/extension.js");
  const extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = (name) => {
    if (name === "./local-time") return require("../out/local-time.js");
    if (name === "vscode") return vscode;
    if (name === "./speech-settings") return { speechSnapshot: () => ({ provider: "claude", providers: [], models: [] }) };
    if (name === "./asana-board") return { asanaSnapshot: () => undefined }; // no Asana project set
    if (name === "child_process") return { execFile: forbid, execFileSync: forbid, spawn: forbid };
    if (name === "./board") return { accounts: () => [{ name: "work", configDir: "/acc/work" }, { name: "other", configDir: "/acc/other" }] };
    if (name === "./accounts") return { accountRows: () => [], externalProviderAccounts: () => [], activeConfigDir: () => "", onAccountsChanged: () => ({ dispose() {} }) };
    if (name === "./sessions") return { DEFAULT_DIR: path.join(os.homedir(), ".claude"), sameFolder: (a, b) => path.resolve(a || path.join(os.homedir(), ".claude")).toLowerCase() === path.resolve(b || path.join(os.homedir(), ".claude")).toLowerCase(), otherAccountDirs: () => ["/acc/other"] };
    if (name === "./codex") return { codexAccounts: () => [], codexModels: () => CODEX_MODELS, codexBinary: () => "codex", codexTextPath: () => "codex" };
    if (name === "./acp") return { antigravityChoices: () => [] }; // F88: the form's Antigravity models
    if (name === "./text-actions") return { ...require("../out/text-actions.js"), ...helpers };
    if (name === "./done-review") return { ...require("../out/done-review.js"), ...helpers }; // the Review button's reviewer (F97)
    if (name === "./plan") return require("../out/plan.js"); // pure: Plan first's planning prompt in the state (F99)
    if (name === "./helper-tab") return tabStub.module;
    if (name === "./helper-receipt") return require("../out/helper-receipt.js");
    if (name === "./jobs") return { projectContext: () => ({ package: { scripts: { test: "node --test" } } }) };
    if (name === "./queue") return require("../out/queue.js");
    if (name === "./usage-history") return require("../out/usage-history.js");
    if (name === "./git") return require("../out/git.js"); // only reviewRule calls it, on a throwaway repo
    if (name === "./checks") return require("../out/checks.js"); // the check catalogue (F76) limits the rule's commands; this repo has none
    if (name === "./orchestrator") return require("../out/orchestrator.js");
    if (name === "./efficiency") return require("../out/efficiency.js"); // pure: Model efficiency (F93) runs on every post
    if (name === "./obsidian-board") return { obsidianSnapshot: () => undefined, contextSource: () => "asana" };
    if (name === "./models" || name === "./acp") return require(`../out/${name.slice(2)}.js`); // pure model names (fix 11); acp only runs agy when asked
    if (name === "./error-log") return require("../out/error-log.js"); // F103: the Review and Finish error log, in the board's folder
    if (name === "./cardTerminal") return require(path.join(path.dirname(filename), name));
    if (name === "./profiles") return require("../out/profiles.js"); // pure: capability profiles (phase 2)
    if (name === "./council") return require("../out/council.js"); // pure: saved councils (phase 5)
    if (name.startsWith("./")) return {};
    return require(name);
  };
  extension._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.BoardView = BoardView;\nmodule.exports.reviewRule = reviewRule;\n", filename);
  let receive;
  const webview = { cspSource: "test", asWebviewUri: (u) => u.fsPath, postMessage: (m) => { posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: (cb) => { receive = cb; } };
  new extension.exports.BoardView({ fsPath: "ext" }, board).resolveWebviewView({ webview, onDidDispose: (cb) => disposers.push(cb) });
  return { receive: (m) => receive(m), posted, errors, infos, warnings, reports, clipboard, tabs: tabStub.tabs, dispose: () => disposers.forEach((d) => d()), reviewRule: extension.exports.reviewRule };
}
const CODEX_MODELS = [{ model: "gpt-5.6-astra", efforts: ["medium"] }, { model: "gpt-6-astra", efforts: ["low", "medium", "high"] }];

function board() {
  const added = [];
  return {
    added, dir: path.join(os.tmpdir(), "ab-prepare-task"), repo: "/repo", tasks: [], accountList: () => [{ name: "work" }, { name: "other" }],
    onChange: () => ({ dispose() {} }), get() { return undefined; }, live: () => [], own: () => [], firstTurn: () => [], panelFirstTurn: () => [], lanes: () => [], archivedRuns: () => [], orchestratorEnabled: () => true, notInMainOf: () => undefined, deliverEveryTurns: () => 3, capsOf: () => ({}), briefPath: "/nonexistent-brief.md",
    configDirOf: (t) => `/acc/${t.account}`, mustOwn: () => undefined, // this window owns the board
    add(...args) { added.push(args); return { id: "new1" }; },
  };
}

const RULE = { goal: "The README reads cleanly.", doneWhen: "README.md is tidied and nothing else changed.", commands: ["Test-Path README.md"] };
const create = { type: "create", title: "", prompt: "Tidy up the README a bit.", account: "work", parentId: "", model: "haiku", effort: "low" };

test("Done when ticked: Fable writes the goal and done-when, with no commands, for an ordinary card", async () => {
  const calls = [], commandsArg = [];
  const writer = "claude-fable-5-1", effort = "high";
  const helpers = {
    generateText: async () => { calls.push("title"); return { value: { title: "unused" } }; }, // auto-start is off here: nothing is named
    completionRule: async (dir, prompt, project, models, signal, onStep, commands) => {
      calls.push(["rule", prompt, models.configDir, models.fallbackConfigDirs, project.package.scripts.test]);
      commandsArg.push(commands);
      onStep("Fable is writing the completion rule at high effort…");
      return { rule: commands ? RULE : { ...RULE, commands: [], promptVersion: "done-when-2026-11-08" }, dropped: commands ? ["git push"] : [], writer, effort, answered: [] };
    },
  };
  const b = board(), f = host(b, helpers);
  test.after(f.dispose);
  await f.receive({ ...create, autoTitle: true, autoRule: true });
  assert.deepEqual(f.errors, []);
  assert.deepEqual(calls, [["rule", create.prompt, "/acc/work", ["/acc/other"], "node --test"]]);
  assert.deepEqual(commandsArg, [false]);
  const doneWhen = RULE.doneWhen, goal = RULE.goal;
  assert.deepEqual(b.added[0][6], { commands: [], doneWhen, goal, writer, effort, promptVersion: "done-when-2026-11-08" });
  assert.equal(b.added[0][1], withRule(create.prompt, { goal, doneWhen, commands: [] }));
  assert.deepEqual(f.reports, ["Fable is writing the completion rule at high effort…"]);
  assert.equal(f.infos[0], "Entomatical: Fable 5.2 wrote when the task is done at high effort.");
  assert.deepEqual(f.warnings, []);
});

// The Done when drop-down (the user, 13 November 2026): the rule runs on the picked Claude model and effort, and the messages say which.
test("Done when ticked with a picked model and effort: the rule is written on it; an unknown pick is Fable at high", async () => {
  const seen = [];
  const helpers = { completionRule: async (dir, prompt, project, models, signal, onStep, commands) => {
    seen.push([models.model, models.effort]); return { rule: { ...RULE, commands: [] }, dropped: [], writer: "w", effort: models.effort, answered: [] }; } };
  const b = board(), f = host(b, helpers);
  test.after(f.dispose);
  await f.receive({ ...create, autoRule: true, ruleModel: "opus", ruleEffort: "max" });
  await f.receive({ ...create, autoRule: true, ruleModel: "sonnet", ruleEffort: "huge" });
  assert.deepEqual(f.errors, []);
  assert.deepEqual(seen, [["opus", "max"], ["fable", "high"]]);
  assert.deepEqual(f.infos.slice(0, 2), ["Entomatical: Opus 5.5 wrote when the task is done at max effort.", "Entomatical: Fable 5.2 wrote when the task is done at high effort."]);
});

test("Done when ticked with Orchestrator: the writer still writes check commands", async () => {
  const commandsArg = [];
  const helpers = { completionRule: async (dir, prompt, project, models, signal, onStep, commands) => {
    commandsArg.push(commands); return { rule: RULE, dropped: [], writer: "w", effort: "high", answered: [] }; } };
  const b = board(), f = host(b, helpers);
  test.after(f.dispose);
  await f.receive({ ...create, autoRule: true, orchestrator: true });
  assert.deepEqual(f.errors, []);
  assert.deepEqual(commandsArg, [true]);
  assert.deepEqual(b.added[0][6].commands, RULE.commands);
});

test("new Fable-only completion rules do not run the legacy model comparison at Review", async () => {
  const task = { id: "new1", worktree: "/worktree", completion: { ...RULE, writer: "claude-fable-5-1", effort: "high" } };
  let compared = false;
  const b = board(), f = host(b, { reviewRules: async () => { compared = true; } });
  test.after(f.dispose);
  await f.reviewRule(b, task, "All acceptance checks passed.");
  assert.equal(compared, false);
  assert.deepEqual(task.completion, { ...RULE, writer: "claude-fable-5-1", effort: "high" });
});

test("unticked, the rule is not written; a rule that fails still adds the task", async () => {
  const calls = [];
  const helpers = { completionRule: async () => { calls.push("rule"); throw new Error("Claude on ~/.claude stopped (exit 1): Error: not logged in"); } };
  const b = board(), f = host(b, helpers);
  test.after(f.dispose);
  await f.receive({ ...create, autoRule: false });
  await f.receive({ ...create, autoRule: true });
  assert.deepEqual(calls, ["rule"]);
  assert.deepEqual(b.added.map((a) => [a[1], a[6]]), [[create.prompt, undefined], [create.prompt, undefined]]);
  assert.match(f.warnings[0], /^Entomatical: the task starts without a Done when\. Claude on ~\/\.claude stopped/);
});

test("Cancel adds no card and gives the text back to the form", async () => {
  const helpers = { completionRule: (...args) => new Promise((_, reject) => args[4].addEventListener("abort", () => reject(new Error("Text generation cancelled.")))) };
  const b = board(), f = host(b, helpers, true);
  test.after(f.dispose);
  await f.receive({ ...create, autoRule: true });
  assert.deepEqual(b.added, []);
  assert.deepEqual(f.posted.find((m) => m.failed)?.failed, { ...create, autoRule: true });
  assert.match(f.errors[0], /Cancelled; the prompt is back in the form\./);
});


// Live run on Windows, 31 October 2026: the session made ok.txt and stopped without committing it, and Fable at Review was told the
// work had "no commits, changed files, or diff". A file the work added but did not commit is part of the work Fable judges.
test("Fable at Review sees files the work added but has not committed", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-review-work-"));
  const g = (cwd, ...a) => require("node:child_process").execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    fs.writeFileSync(path.join(repo, "README.md"), "x\n");
    g(repo, "init", "-q"); g(repo, "add", "README.md"); g(repo, "commit", "-q", "-m", "init");
    const worktree = path.join(repo, "wt");
    g(repo, "worktree", "add", "-q", "-b", "task/t1", worktree);
    fs.writeFileSync(path.join(worktree, "ok.txt"), "ok\n");
    const rule = { ...RULE, model: "claude-opus-5-5", dropped: [] };
    const task = { id: "t1", prompt: "Create ok.txt.", worktree, completion: { ...RULE, haiku: rule, opus: rule, judgment: { pick: "opus" } } };
    let input;
    const b = { ...board(), repo, get: () => task, update: (t, patch) => Object.assign(t, patch) };
    const f = host(b, { reviewRules: async (_dir, i) => { input = i; return { haikuGoodEnough: true, verdict: "Both check ok.txt.", model: "claude-fable-5-1" }; } });
    test.after(f.dispose);
    await f.reviewRule(b, task, "All acceptance checks passed.");
    assert.equal(task.completion.review.verdict, "Both check ok.txt.");
    assert.match(input.work, /^New files not yet committed:\nok\.txt$/m);
  } finally { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});

// the user, 8 November 2026: F94's automatic done-when judge is retired (F97's Review button judges on request). This only guards the removed names;
// it does not run the Review trigger, which lives in activate() and needs a live Board.
test("F94 retired: no judge entry point is left (judgeDoneWhen not exported; the extension has no judgeRule or judgeDoneWhen)", () => {
  assert.equal(require("../out/text-actions.js").judgeDoneWhen, undefined);
  const source = fs.readFileSync(require.resolve("../out/extension.js"), "utf8");
  assert.doesNotMatch(source, /judgeRule|judgeDoneWhen/);
});

// ---- The Review button (F97): src/extension.ts runDoneReview and the review messages. The reviewer is a stand-in; nothing calls a model.
const NOT_DONE = { findings: [{ condition: "README.md is tidied.", status: "not-met", evidence: "README.md is unchanged." }], other: "",
  explanation: "Nothing in the work changes README.md.", verdict: "not-done", prompt: "Tidy README.md: fix the headings and the list.", questions: [] };
const DONE = { findings: [{ condition: "README.md is tidied.", status: "met", evidence: "README.md:1-9 has the new headings." }], other: "A typo in docs/a.md.",
  explanation: "The headings and list are fixed.", verdict: "done", prompt: "", questions: [] };
const INPUT = { kind: "card", title: "Tidy the README", prompt: "Tidy up the README a bit.", followUps: [], children: [],
  work: { summary: "Commits since the branch point:\nnone", diff: "", untracked: "", cut: [], skipped: [] } };
const CARD = { title: "Tidy the README", prompt: "Tidy up the README a bit.", status: "review", worktree: "/wt/card", account: "work" };
const decisions = (file) => (JSON.parse(fs.readFileSync(file, "utf8")).decisions ?? []).map((d) => d.action);

/** board() with what a review, the card list and Accept prompt touch. Accept's route is the real Board.sendPrompt (Fix it's). */
function reviewBoard(tasks) {
  const b = board(), sent = [];
  Object.assign(b, { dir: fs.mkdtempSync(path.join(os.tmpdir(), "ab-review-host-")), tasks, sent,
    get: (id) => b.tasks.find((t) => t.id === id), update: (t, patch) => Object.assign(t, patch),
    configDirOf: (t) => (t.provider ? "" : `/acc/${t.account}`), // as Board.configDirOf: a Codex card has no Claude folder
    metrics: { session: () => undefined }, send: (t, text) => sent.push([t.id, text]),
    sendPrompt: Board.prototype.sendPrompt, terminal: (t) => (t.id === "term" ? {} : undefined), codexRuns: new Map(), external: new Map(), everReady: () => true, isOwner: () => true });
  for (const k of ["prompts", "subagentsOf", "lastReply", "waitingToStart", "readinessOf", "doingOf", "timelineOf", "runSummaryOf", "efficiencyOf", "repeatingOf", "lastEventAt", "modelOf", "finalReply"]) b[k] = () => undefined;
  test.after(() => fs.rmSync(b.dir, { recursive: true, force: true }));
  return b;
}

/** reviewInput and reviewWork stand-ins: each call answers the next result, with a receipt file as the real one writes. */
function reviewer(b, results) {
  const calls = [];
  const helpers = {
    reviewInput: async (_board, task, answers) => ({ ...INPUT, title: task.title, answers }),
    reviewWork: async (dir, prompt, route, signal, meta, onOutput) => {
      // The card shows Reviewing… meanwhile.
      const call = { dir, prompt, route, meta, signal, running: b.tasks.find((t) => t.doneReviewRun && !t.doneReviewRun.error)?.doneReviewRun };
      calls.push(call);
      onOutput?.("Reading the work.", "thinking");
      const result = results.shift();
      if (result instanceof Function) return result(signal);
      fs.mkdirSync(dir, { recursive: true });
      call.receipt = path.join(dir, "review-receipt.json");
      fs.writeFileSync(call.receipt, JSON.stringify({ kind: "review", receiptStatus: "done" }));
      return { result, model: "claude-fable-5-1", receipt: call.receipt };
    },
  };
  return { calls, helpers };
}
const lastCards = (f) => f.posted.filter((m) => m.tasks?.length).at(-1).tasks;

test("Review runs Fable at medium effort on the card's account, writes the findings file and keeps the verdict on the card", async () => {
  const task = { ...CARD, id: "c1" };
  const b = reviewBoard([task]), r = reviewer(b, [NOT_DONE]), f = host(b, r.helpers);
  test.after(f.dispose);
  task.autoRounds = 2;
  task.mergeRetries = 1;
  await f.receive({ type: "reviewWork", id: "c1" });
  assert.deepEqual(f.errors, []);
  const [call] = r.calls;
  assert.deepEqual(call.route, { model: "fable", effort: "medium", configDir: "/acc/work", fallback: ["/acc/other"] });
  assert.equal(call.meta.provider, undefined);
  assert.equal(call.meta.input.title, task.title);
  assert.match(call.prompt, /^<task_prompt-[0-9a-f]{8}>\nTidy up the README a bit\.\n/m); // reviewPrompt's packet
  assert.equal(path.dirname(call.dir), path.join(b.dir, "helpers"));
  assert.deepEqual(Object.keys(call.running).sort(), ["at", "effort", "model", "requestId"]); // the card said Reviewing… while it ran
  assert.deepEqual([call.running.model, call.running.effort], ["fable", "medium"]);
  assert.equal(task.doneReviewRun, undefined);
  const r1 = task.doneReview;
  assert.deepEqual({ ...r1, file: undefined, at: undefined }, { ...NOT_DONE, file: undefined, at: undefined, model: "claude-fable-5-1", effort: "medium", receipt: call.receipt });
  assert.equal(r1.file, path.join(b.dir, "reviews", "c1", `${r1.at.replace(/[:.]/g, "-")}.md`));
  const markdown = fs.readFileSync(r1.file, "utf8");
  assert.match(markdown, /^Verdict: Not done$/m);
  assert.match(markdown, /^Reviewer: claude-fable-5-1 · medium effort$/m);
  assert.deepEqual([task.autoRounds, task.mergeRetries], [0, 0], "a manual Review resets both budgets");
  // Its own helper tab: the packet sent, the reviewer's live output, then the MD file's text.
  const [tab] = f.tabs;
  assert.deepEqual([tab.run.kind, tab.run.title, tab.run.target, tab.run.detail], ["work", "Review: Tidy the README", "c1", "fable · medium effort · work"]);
  assert.equal(tab.run.requestId, call.running.requestId);
  assert.deepEqual(tab.events, [["prompt", call.prompt], ["output", "", "thinking", "Reading the work."], ["finish", { text: markdown, notes: [] }, "claude-fable-5-1"]]);
});

test("Review on a Codex card runs the newest Astra at medium effort through the Codex CLI", async () => {
  const task = { ...CARD, id: "x1", account: "Codex · me@example.test", provider: "codex" };
  const b = reviewBoard([task]), r = reviewer(b, [DONE]), f = host(b, r.helpers);
  test.after(f.dispose);
  await f.receive({ type: "reviewWork", id: "x1" });
  assert.deepEqual(f.errors, []);
  assert.deepEqual(r.calls[0].route, { model: "gpt-6-astra", effort: "medium", configDir: "", via: "codex", fallback: [] });
  assert.equal(r.calls[0].meta.provider, "codex");
  assert.equal(task.doneReview.verdict, "done");
  assert.equal(task.doneReview.effort, "medium");
});

test("Accept prompt sends the prompt through the Fix it route", async () => {
  const term = { ...CARD, id: "term", sessionId: "s1", finishAsked: { at: "2026-11-08T10:00:00.000Z" } };
  const panel = { ...CARD, id: "panel", sessionId: "s2", panel: true };
  const b = reviewBoard([term, panel]), r = reviewer(b, [NOT_DONE, NOT_DONE]), f = host(b, r.helpers);
  test.after(f.dispose);
  for (const id of ["term", "panel"]) { await f.receive({ type: "reviewWork", id }); await f.receive({ type: "acceptReview", id }); }
  await f.receive({ type: "acceptReview", id: "term" }); // a second press sends nothing more
  assert.deepEqual(f.errors, []);
  // The board's own terminal gets it typed in.
  assert.deepEqual(b.sent, [["term", NOT_DONE.prompt]]);
  assert.equal(term.doneReview.sent, "sent");
  assert.equal(term.finishAsked, undefined);
  // A Claude panel session cannot be typed into: the prompt goes on the clipboard, as Fix it's does.
  assert.deepEqual(f.clipboard, [NOT_DONE.prompt]);
  assert.equal(panel.doneReview.sent, "copied");
  assert.deepEqual(f.infos, [`Entomatical: the prompt for "${panel.title}" is on the clipboard. Paste it into its session.`]);
  for (const t of [term, panel]) assert.deepEqual(decisions(t.doneReview.receipt), ["accept"]);
  // Fix it's own toast keeps its words.
  b.fixPrompt = () => "Make the failing check pass.";
  await f.receive({ type: "checksFix", id: "panel" });
  assert.equal(f.infos.at(-1), `Entomatical: the fix prompt for "${panel.title}" is on the clipboard. Paste it into its session.`);
});

test("Review outcomes are recorded on the receipts", async () => {
  const task = { ...CARD, id: "c1" };
  const b = reviewBoard([task]), r = reviewer(b, [NOT_DONE, DONE]), f = host(b, r.helpers);
  test.after(f.dispose);
  await f.receive({ type: "reviewWork", id: "c1" });
  const first = task.doneReview.receipt;
  await f.receive({ type: "reviewWork", id: "c1" });
  assert.deepEqual(decisions(first), ["superseded"]);
  assert.deepEqual(decisions(task.doneReview.receipt), []);
  const [card] = lastCards(f);
  assert.equal(card.reviewFindings, findingsText(task.doneReview));
  assert.equal(card.reviewable, true);
  // A follow-up after a Done verdict is the main sign of a false Done: recorded once.
  task.mergeRetries = 2;
  await f.receive({ type: "send", id: "c1", text: "Also fix the typo in docs/a.md." });
  // the user's typed follow-up resets the automatic rounds; the board's own sendBack (auto-finish.ts) calls followUpHeadless, not this
  // handler, and counts a round instead (test/finish.test.js "auto-finish: Not done sends the reviewer's prompt …").
  assert.deepEqual([task.autoRounds, task.mergeRetries], [0, 0]);
  await f.receive({ type: "send", id: "c1", text: "And the link." });
  assert.deepEqual(b.sent.map((s) => s[1]), ["Also fix the typo in docs/a.md.", "And the link."]);
  assert.deepEqual(decisions(task.doneReview.receipt), ["worked-after-done"]);
  assert.equal(task.doneReview.workedAfter, true);
  assert.deepEqual(decisions(first), ["superseded"]);
});

test("Cancel review stops the call, the card says Review cancelled. until Dismiss, and a review that fails keeps the last verdict", async () => {
  const task = { ...CARD, id: "c1" };
  const waitForAbort = (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Text generation cancelled."))));
  const b = reviewBoard([task]), r = reviewer(b, [NOT_DONE, waitForAbort, async () => { throw new Error("The reviewer returned no findings."); }]), f = host(b, r.helpers);
  test.after(f.dispose);
  await f.receive({ type: "reviewWork", id: "c1" });
  const kept = task.doneReview;
  const running = f.receive({ type: "reviewWork", id: "c1" });
  for (let i = 0; i < 500 && !r.calls[1]; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(r.calls[1], "the second review reached the reviewer");
  await f.receive({ type: "ready" }); // a reloaded webview asks for the cards; the review goes on
  assert.equal(lastCards(f)[0].reviewable, false, "no second Review while one runs");
  await f.receive({ type: "cancelReview", id: "c1" });
  await running;
  assert.equal(r.calls[1].signal.aborted, true);
  assert.equal(task.doneReviewRun.error, "Review cancelled.");
  assert.deepEqual(f.tabs[1].events.at(-1), ["fail", "Review cancelled.", true]);
  assert.deepEqual(f.errors, [], "Cancel is not an error: the card says it");
  assert.equal(task.doneReview, kept);
  assert.deepEqual(decisions(kept.receipt), [], "a cancelled review supersedes nothing");
  await f.receive({ type: "dismissReview", id: "c1" });
  assert.equal(task.doneReviewRun, undefined);
  await f.receive({ type: "reviewWork", id: "c1" });
  assert.equal(task.doneReviewRun.error, "The reviewer returned no findings.");
  assert.deepEqual(f.tabs[2].events.at(-1), ["fail", "The reviewer returned no findings.", false]);
  assert.deepEqual(f.errors, ["Entomatical: The reviewer returned no findings."]);
  assert.equal(task.doneReview, kept);
});

// F103 (the user, 13 November 2026): every Review that ends without a verdict is a line in the board's errors.jsonl and the Output channel.
const errorLog = (b) => { try { return fs.readFileSync(path.join(b.dir, "errors.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const until = async (ok) => { for (let i = 0; i < 500 && !ok(); i++) await new Promise((resolve) => setImmediate(resolve)); assert.ok(ok()); };

test("F103: a review the runner fails is logged with its exit code, the end of its stderr (secrets redacted), the stage, card, model and receipt", async () => {
  const task = { ...CARD, id: "e1" };
  const failing = async () => { throw Object.assign(new Error("Claude on work stopped (exit 1): Error: not logged in"), { exitCode: 1,
    stderrTail: "warming up\nANTHROPIC_API_KEY=sk-ant-abcdef1234567890 was rejected\nError: not logged in" }); };
  const b = reviewBoard([task]), r = reviewer(b, [failing, async () => { throw new Error("The reviewer said Done but not every condition is met."); }]), f = host(b, r.helpers);
  test.after(f.dispose);
  await f.receive({ type: "reviewWork", id: "e1" });
  assert.equal(task.doneReviewRun.error, "Claude on work stopped (exit 1): Error: not logged in", "the card's own notice is unchanged");
  const [e] = errorLog(b);
  assert.deepEqual([e.level, e.action, e.outcome, e.stage, e.card, e.provider, e.account, e.model, e.effort, e.exitCode],
    ["error", "review", "runner-error", "Calling the reviewer", { id: "e1", title: "Tidy the README" }, "claude", "work", "fable", "medium", 1]);
  assert.match(e.stderr, /warming up[\s\S]*Error: not logged in$/);
  assert.match(e.stderr, /ANTHROPIC_API_KEY=\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(e), /sk-ant-abcdef|Tidy up the README a bit/, "no secret and no prompt in the log");
  assert.equal(e.receipt, path.join(r.calls[0].dir, "review-receipt.json"));
  assert.equal(typeof e.durationMs, "number");
  assert.ok(!Number.isNaN(Date.parse(e.at)));
  await f.receive({ type: "dismissReview", id: "e1" });
  await f.receive({ type: "reviewWork", id: "e1" });
  assert.deepEqual([errorLog(b)[1].outcome, errorLog(b)[1].message], ["invalid-reply", "The reviewer said Done but not every condition is met."]);
  assert.deepEqual(fs.readdirSync(path.join(b.dir, "runs")), [], "the run records are gone once logged");
  // Show log with no Output channel (this host never ran activate()) falls back to Open error log, which has no board here either.
  await f.receive({ type: "showErrorLog", id: "e1" });
  assert.deepEqual(f.infos.slice(-1), ["Entomatical: no Review or Finish has failed on this board yet, so there is no error log."]);
});

test("F103: a review that times out after fifteen minutes is logged as a timeout; Cancel review as info; a refused Review as refused", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const task = { ...CARD, id: "e2" }, working = { ...CARD, id: "e3", status: "running" };
  const waitForAbort = (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Text generation cancelled."))));
  const b = reviewBoard([task, working]), r = reviewer(b, [waitForAbort, waitForAbort]), f = host(b, r.helpers);
  test.after(f.dispose);
  const timedOut = f.receive({ type: "reviewWork", id: "e2" });
  await until(() => r.calls[0]);
  t.mock.timers.tick(900_000);
  await timedOut;
  assert.equal(task.doneReviewRun.error, "Stopped after fifteen minutes without an answer.");
  const cancelled = f.receive({ type: "reviewWork", id: "e2" });
  await until(() => r.calls[1]);
  await f.receive({ type: "cancelReview", id: "e2" });
  await cancelled;
  await f.receive({ type: "reviewWork", id: "e3" });
  assert.deepEqual(errorLog(b).map((e) => [e.level, e.outcome, e.stage, e.card.id, e.message]), [
    ["error", "timeout", "Calling the reviewer", "e2", "Stopped after fifteen minutes without an answer."],
    ["info", "cancelled", "Calling the reviewer", "e2", "Review cancelled."],
    ["error", "refused", "Checking the card", "e3", "Review works on a card in Review."]]);
});

test("Accept prompt pressed twice sends once, and a newer review that lands meanwhile keeps its own fields", async () => {
  const term = { ...CARD, id: "term", sessionId: "s1" }, other = { ...CARD, id: "other", sessionId: "s2" };
  const b = reviewBoard([term, other]), r = reviewer(b, [NOT_DONE, NOT_DONE]), f = host(b, r.helpers);
  test.after(f.dispose);
  await f.receive({ type: "reviewWork", id: "term" });
  term.autoRounds = 2; // the automatic rounds ran out since (autoFinish waits with this prompt on the card)
  term.mergeRetries = 2;
  await Promise.all([f.receive({ type: "acceptReview", id: "term" }), f.receive({ type: "acceptReview", id: "term" })]); // the second before the first is done
  assert.deepEqual(f.errors, []);
  assert.deepEqual(b.sent, [["term", NOT_DONE.prompt]]);
  assert.deepEqual(decisions(term.doneReview.receipt), ["accept"]);
  assert.equal(term.doneReview.sent, "sent");
  assert.deepEqual([term.autoRounds, term.mergeRetries], [0, 0], "Accept is the user's own action: it resets the automatic rounds, as a manual Review does");
  // A newer review replaces the card's while the prompt is being sent: the old one's receipt gets accept, the newer one stays unsent.
  await f.receive({ type: "reviewWork", id: "other" });
  const accepted = other.doneReview, newer = { ...NOT_DONE, file: "/newer.md", model: "m", effort: "medium", at: "2026-11-08T12:00:00.000Z", receipt: "/newer-receipt.json" };
  b.sendPrompt = async (t) => { t.doneReview = newer; return "sent"; };
  await f.receive({ type: "acceptReview", id: "other" });
  assert.equal(other.doneReview, newer);
  assert.equal(newer.sent, undefined);
  assert.deepEqual(decisions(accepted.receipt), ["accept"]);
});

test("a run another window left shown running gets the interrupted text on Cancel review, and Review then runs", async () => {
  const running = { requestId: "r0", at: "2026-11-08T10:00:00.000Z", model: "fable", effort: "medium" };
  const cancelled = { ...CARD, id: "c1", doneReviewRun: { ...running } }, pressed = { ...CARD, id: "c2", doneReviewRun: { ...running } };
  const b = reviewBoard([cancelled, pressed]), r = reviewer(b, [NOT_DONE, DONE]), f = host(b, r.helpers); // this window holds no call for them
  test.after(f.dispose);
  await f.receive({ type: "cancelReview", id: "c1" });
  assert.deepEqual(cancelled.doneReviewRun, { ...running, error: "The review was interrupted when the window closed. Press Review to run it again." });
  for (const id of ["c1", "c2"]) await f.receive({ type: "reviewWork", id });
  assert.deepEqual(f.errors, []);
  assert.equal(r.calls.length, 2);
  assert.deepEqual([cancelled.doneReview.verdict, pressed.doneReview.verdict], ["not-done", "done"]);
  assert.ok([cancelled, pressed].every((t) => t.doneReviewRun === undefined));
});

test("Review on a Grok card whose account is not in the account list is refused and runs nothing on Claude", async () => {
  const task = { ...CARD, id: "g1", account: "Grok · gone@example.test", provider: "grok" };
  const b = reviewBoard([task]), r = reviewer(b, [DONE]), f = host(b, r.helpers);
  test.after(f.dispose);
  await f.receive({ type: "reviewWork", id: "g1" });
  assert.deepEqual(f.errors, ["Entomatical: This card's Grok account is not set up, so it cannot be reviewed."]);
  assert.deepEqual(r.calls, []);
  assert.equal(task.doneReviewRun, undefined);
  assert.equal(task.doneReview, undefined);
});

test("Review is refused for a plan step and for a headless child not taken over, with canReview's text", async () => {
  const plan = { ...CARD, id: "plan1", planRun: { review: "checks" } };
  const step = { ...CARD, id: "step1", openedBy: "plan1" };
  const child = { ...CARD, id: "kid1", headless: true, openedBy: "m1" };
  const b = reviewBoard([plan, step, child]), r = reviewer(b, []), f = host(b, r.helpers);
  test.after(f.dispose);
  for (const id of ["step1", "kid1"]) await f.receive({ type: "reviewWork", id });
  assert.deepEqual(f.errors, ["Entomatical: A plan's own reviewer judges this card.", "Entomatical: Its orchestrator reviews this card."]);
  assert.deepEqual(r.calls, []);
  assert.ok([step, child].every((t) => !t.doneReviewRun && !t.doneReview));
  assert.deepEqual(lastCards(f).map((t) => t.reviewable), [false, false, false]);
});

test("Review shows only in the window that owns the board", async () => {
  const b = reviewBoard([{ ...CARD, id: "c1" }]), f = host(b, reviewer(b, []).helpers);
  test.after(f.dispose);
  b.isOwner = () => false;
  await f.receive({ type: "ready" });
  assert.equal(lastCards(f)[0].reviewable, false);
  b.isOwner = () => true;
  await f.receive({ type: "ready" });
  assert.equal(lastCards(f)[0].reviewable, true);
});

/**
 * activate() on stand-ins: the board is `fake`, the reviewer `helpers`, and every other module answers anything with anything, so only
 * the activation steps that touch the board run for real.
 */
async function activateWith(fake, helpers = {}) {
  const anything = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : anything), apply: () => anything, construct: () => anything });
  const stub = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : anything) });
  // A saved workspace whose one folder is the board's repository (workspace.ts checkWorkspace).
  const vscode = stub({ workspace: stub({ getConfiguration: () => ({ get: (_k, fallback) => fallback }),
    workspaceFile: { scheme: "file", fsPath: `${fake.repo}/project.code-workspace` }, workspaceFolders: [{ uri: { scheme: "file", fsPath: fake.repo } }] }) });
  const tabStub = helperTabStub(), forbid = () => { throw new Error("This test must not launch a process."); };
  const filename = require.resolve("../out/extension.js"), extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = (name) => {
    if (name === "vscode") return vscode;
    if (name === "child_process") return { execFile: forbid, spawn: forbid, execFileSync: () => `${fake.repo}\n` }; // repoRoot's git rev-parse
    if (name === "os") return { ...require("os"), homedir: () => fake.repo }; // not the real home, whose old data folder would stop activation
    if (name === "./board") return { Board: function () { return fake; }, accounts: () => [] };
    if (name === "./done-review") return { ...require("../out/done-review.js"), ...helpers };
    if (name === "./plan") return require("../out/plan.js"); // pure: Plan first's planning prompt in the state (F99)
    if (name === "./helper-tab") return tabStub.module;
    if (name === "./helper-receipt") return require("../out/helper-receipt.js");
    if (name === "./workspace") return require("../out/workspace.js");
    if (name === "./cardTerminal") return require(path.join(path.dirname(filename), name));
    if (name === "./profiles") return require("../out/profiles.js"); // pure: capability profiles (phase 2)
    if (name === "./council") return require("../out/council.js"); // pure: saved councils (phase 5)
    if (name.startsWith("./")) return anything;
    return require(name);
  };
  extension._compile(fs.readFileSync(filename, "utf8"), filename);
  const disposable = { dispose() {} };
  Object.assign(fake, { onRun: () => disposable, onChange: () => disposable, onStatus: () => disposable, begin() {}, checks: {}, announceTakeoverAsks() {} });
  await extension.exports.activate({ extensionUri: { fsPath: "ext" }, extensionPath: "/ext", subscriptions: [], globalState: anything, secrets: anything });
  return { tabs: tabStub.tabs };
}

test("the board's doneReviewer runs the same review without a tab and keeps the automatic rounds", async () => {
  const task = { ...CARD, id: "m1", autoRounds: 1 };
  const b = reviewBoard([task]), r = reviewer(b, [NOT_DONE]);
  b.isOwner = () => true;
  const { tabs } = await activateWith(b, r.helpers);
  const pending = b.doneReviewer(task, { auto: true });
  assert.equal(b.reviewIsLive(task.id), true);
  const review = await pending;
  assert.equal(b.reviewIsLive(task.id), false);
  assert.equal(review, task.doneReview);
  assert.equal(review.verdict, "not-done");
  assert.ok(fs.existsSync(review.file));
  assert.deepEqual(tabs, []);
  assert.equal(task.autoRounds, 1);
  assert.equal(r.calls[0].route.model, "fable");
});

// Task 7 fix round 2: a review records the worktree as it was when its input was gathered, so autoFinish can tell a later edit.
// Only autoFinish uses it, so only a run's master pays for it: an ordinary card's review records none.
test("Review records the worktree snapshot taken when it gathered its input, for a run's master only", async () => {
  const { worktreeSnapshot } = require("../out/done-review.js");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-review-snapshot-"));
  const g = (...a) => require("node:child_process").execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: repo, stdio: "ignore" });
  test.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, "README.md"), "x\n"); g("init", "-q"); g("add", "."); g("commit", "-qm", "init");
  fs.writeFileSync(path.join(repo, "new.txt"), "uncommitted\n");
  const task = { ...CARD, id: "s1", worktree: repo, orchestrator: { caps: {}, opened: 1 } }, plain = { ...CARD, id: "p1", worktree: repo };
  const b = reviewBoard([task, plain]), r = reviewer(b, [DONE, DONE]), f = host(b, r.helpers);
  test.after(f.dispose);
  const at = await worktreeSnapshot(repo);
  for (const id of ["s1", "p1"]) await f.receive({ type: "reviewWork", id });
  assert.deepEqual(f.errors, []);
  assert.equal(task.doneReview.snapshot, at);
  assert.ok(plain.doneReview && !("snapshot" in plain.doneReview), "an ordinary card's review records no snapshot");
  fs.writeFileSync(path.join(repo, "new.txt"), "edited\n"); // the same status line, another size
  assert.notEqual(await worktreeSnapshot(repo), at);
});

// Task 7 (Ruling 12): the user's own Review (or Send answers after an Unsure) that comes back Done on a master that asked to finish
// continues the self-finish with that review; any other verdict, or a card that did not ask, fires nothing.
test("a manual Review with verdict Done on a card that asked to finish fires finishReady carrying that review", async () => {
  const orchestrator = { caps: {}, opened: 1 }, finishAsked = { at: "2026-11-08T10:00:00.000Z" };
  const asked = { ...CARD, id: "m1", orchestrator, finishAsked }, plain = { ...CARD, id: "c1", orchestrator }, notDone = { ...CARD, id: "m2", orchestrator, finishAsked };
  const ordinary = { ...CARD, id: "o1", finishAsked }; // not a run's master: never finished unattended
  const retry = { ...asked, id: "m3", finishAsked: { ...finishAsked, reviewInterrupted: true },
    selfFinish: { error: "Automatic finish was interrupted. Press Review to retry." } };
  const b = reviewBoard([asked, plain, notDone, ordinary, retry]), r = reviewer(b, [DONE, DONE, NOT_DONE, DONE, DONE]), f = host(b, r.helpers);
  test.after(f.dispose);
  const fired = [];
  b.runEvents = { fire: (e) => fired.push(e) };
  for (const id of ["m1", "c1", "m2", "o1", "m3"]) await f.receive({ type: "reviewWork", id });
  assert.deepEqual(f.errors, []);
  assert.deepEqual(fired.map((e) => [e.kind, e.master.id]), [["finishReady", "m1"], ["finishReady", "m3"]]);
  assert.equal(fired[0].review, asked.doneReview);
  assert.equal(fired[1].review, retry.doneReview);
  assert.equal(retry.selfFinish, undefined);
  assert.equal(retry.doneReviewRun, undefined);
});
