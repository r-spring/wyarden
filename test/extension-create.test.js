const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");

const STUCK = Symbol("a title helper that never answers"); // fixture({ title: STUCK })

function fixture({ autoStart, startError, title, provider, codexModels = [], maxRunning, allowInfo, wrapper, linkAsana } = {}) {
  const added = [], starts = [], shown = [], errors = [], warnings = [], updates = [], titled = [], infos = [];
  const forbid = () => { throw new Error("This test must not open a window or launch a process."); };
  const vscode = {
    workspace: { getConfiguration: section => ({ get: (key, fallback) => {
      if (section === "entomatical" && key === "autoStart") return autoStart ?? fallback;
      if (section === "entomatical" && key === "maxRunning") return maxRunning ?? fallback;
      // wrapper: the Claude panel is on (extension.ts WRAPPER), so an ordinary Claude card starts in the panel.
      if (section === "claudeCode" && key === "claudeProcessWrapper") return wrapper ? require("node:path").join(require("node:os").homedir(), ".entomatical", process.platform === "win32" ? "entomatical-claude.exe" : "entomatical-claude") : undefined;
      throw new Error(`Unexpected setting ${section}.${key}`);
    } }) },
    window: { showErrorMessage: message => { errors.push(message); }, showInformationMessage: allowInfo ? (message) => { infos.push(message); } : forbid, showWarningMessage: message => { warnings.push(message); },
      setStatusBarMessage: () => ({ dispose() {} }) },
  };
  // The title helper: records what it was asked for; `title` is its answer, or an Error it fails with.
  const stubs = {
    "./text-actions": { generateText: async (dir, purpose, draft, configDir, model, answers, signal, effort, codexPath, fallbacks) => {
      titled.push({ purpose, draft, configDir, model, effort, codexPath, fallbacks });
      if (title instanceof Error) throw title;
      if (title instanceof Promise) return title.then((t) => ({ value: { title: t }, model })); // answers when the test says
      if (title === STUCK) return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))); // answers only when stopped
      return { value: { title }, model };
    } },
    "./codex": { codexModels: () => codexModels, codexBinary: () => "/bin/codex", codexTextPath: () => "/bin/codex" },
    "./sessions": { otherAccountDirs: () => ["/other"] },
    "./queue": require("../out/queue.js"), // pure: the real Start after and running-limit rules
    "./models": require("../out/models.js"), // pure: newest of a family (fix 11)
    "./plan": require("../out/plan.js"), // pure: Plan first's planning prompt (F99)
    "./compile": require("../out/compile.js"), // the accepted-specification binding (phase 1); no model is called
    "./orchestrator": require("../out/orchestrator.js"), // pure: the brief before the task (masterPrompt)
    "./battle": require("../out/battle.js"), // pure: inCardTerminal
    "./asana-board": { linkAsana },
  };
  const filename = require.resolve("../out/extension.js");
  const extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = name => {
    if (name === "vscode") return vscode;
    if (name === "child_process") return { execFile: forbid, execFileSync: forbid, spawn: forbid };
    if (name === "./profiles") return require("../out/profiles.js"); // pure: capability profiles (phase 2)
    if (name.startsWith("./")) return stubs[name] ?? {}; // No account discovery, board polling, or other provider modules.
    return require(name);
  };
  // Expose the compiled private handler only in this isolated test module.
  // panelDeclined selects the terminal path without calling activate or opening UI.
  extension._compile(fs.readFileSync(filename, "utf8") +
    '\nstate = { get: key => key === "panelDeclined" }; module.exports.createHandler = handle; module.exports.startHeld = startHeld; module.exports.replaceHandler = f => { handle = f; };\n', filename);
  const tasks = [];
  const board = {
    add(...args) {
      added.push(args);
      const [titleArg, prompt] = args;
      const task = { id: `saved-${tasks.length + 1}`, status: "queued", createdAt: new Date().toISOString(), ...(args[7]?.dependsOn ? { dependsOn: args[7].dependsOn } : {}), ...(args[7]?.orchestrator ? { orchestrator: args[7].orchestrator, cardTerminal: true } : {}), /* as Board.add: an orchestrator gets its card terminal */ title: titleArg.trim() || prompt.split("\n")[0].slice(0, 60), named: !!titleArg.trim() || undefined, prompt, provider };
      tasks.push(task);
      return task;
    },
    get(id) { return tasks.find(task => task.id === id); },
    isStarting: () => false,
    dispatchTime: () => undefined,
    profileProblem: () => undefined,
    dispatchHeld(task, launch) { return stubs["./queue"].dispatchHeld(this, task, launch); },
    startWait(task) { return stubs["./queue"].waitReason(task, tasks, maxRunning ?? 0) ?? this.planCapacityWait?.(task); },
    tasks,
    dir: "/board", configDirOf: () => "/acct",
    mustOwn() {}, // this window owns the board
    update(task, patch) { updates.push({ id: task.id, ...patch }); Object.assign(task, patch); },
    async start(task) {
      starts.push(task.id);
      if (startError) throw new Error(startError);
      return { show: focus => shown.push(focus) };
    },
    startInPanel: forbid,
  };
  return { create: message => extension.exports.createHandler(board, { type: "create", ...message }), board,
    startHeld: () => extension.exports.startHeld(board), replaceHandler: f => extension.exports.replaceHandler(f),
    handle: message => extension.exports.createHandler(board, message),
    added, tasks, starts, shown, errors, warnings, updates, titled, infos };
}

const request = {
  title: "Preserve selected settings", prompt: "Implement the approved task.", account: "selected-account",
  parentId: "parent-task", model: "fable", effort: "max",
};

test("BUG-05: Add passes the webview's Asana selection through automatic naming and warns on refusal", async () => {
  const title = Promise.withResolvers();
  const selections = [];
  const f = fixture({ title: title.promise, linkAsana: async (_board, task, selection) => {
    selections.push({ title: task.title, selection });
    throw new Error("The Asana selection expired. Refresh and pick again.");
  } });
  const adding = f.create({ ...request, title: "", asana: "new", asanaProject: "1", asanaGeneration: 7 });
  assert.deepEqual(selections, []);
  title.resolve("Named card");
  await adding;
  assert.deepEqual(selections, [{ title: "Named card", selection: { choice: "new", project: "1", generation: 7 } }]);
  assert.equal(f.tasks[0].asana, undefined);
  assert.match(f.warnings[0], /card was added without an Asana task.*selection expired/);
});

test("a plan waiting for its run cap does not reserve another card's free global slot", async () => {
  const f = fixture({ maxRunning: 1 });
  f.board.isOwner = () => true;
  f.board.planCapacityWait = task => task.id === "blocked" ? "Waiting for run capacity" : undefined;
  f.tasks.push({ id: "blocked", title: "Blocked plan step", status: "queued", held: true, createdAt: "1" },
    { id: "ready", title: "Ready card", status: "queued", held: true, createdAt: "2" });
  const started = [];
  f.replaceHandler(async (board, message) => { started.push(message.id); board.update(board.get(message.id), { status: "running", sessionId: "session" }); });
  await f.startHeld();
  assert.deepEqual(started, ["ready"]);
  assert.equal(f.board.get("blocked").held, true);
});

test("workflow dependencies, resource waits and operator gates keep automatic starts held until ready", async () => {
  const f = fixture();
  f.board.isOwner = () => true; f.board.planCapacityWait = () => undefined;
  const step = { id: "gated", title: "Gated", status: "queued", held: true, createdAt: "1", workflow: {} };
  f.tasks.push(step);
  const starts = [];
  f.replaceHandler(async (board, message) => { starts.push(message.id); board.update(step, { sessionId: "started" }); });
  for (const state of ["dependency", "resource", "blocked", "attempt", "closed"]) {
    f.board.readinessOf = () => ({ state });
    await f.startHeld();
    assert.equal(step.held, true, state);
    assert.deepEqual(starts, [], state);
  }
  f.board.readinessOf = () => ({ state: "ready" });
  await f.startHeld();
  assert.deepEqual(starts, ["gated"]);
  assert.equal(step.held, undefined);
});

test("an unstarted held card keeps its dispatch error, retries once, and waits for manual Start after another failure", async () => {
  const f = fixture();
  f.board.isOwner = () => true;
  const task = { id: "retry", title: "Retry", status: "queued", held: true, createdAt: "1" };
  f.tasks.push(task);
  let attempts = 0;
  f.replaceHandler(async () => { attempts++; throw new Error("Provider unavailable"); });
  await f.startHeld();
  assert.deepEqual([attempts, task.held, task.launchError], [1, true, "Provider unavailable"]);
  assert.ok(task.startRetryAt > Date.now());
  await f.startHeld();
  assert.equal(attempts, 1, "writing the failure does not trigger a retry loop");
  task.startRetryAt = Date.now() - 1;
  await f.startHeld();
  await f.startHeld();
  assert.deepEqual([attempts, task.held, task.startRetryAt, task.launchError], [2, true, undefined, "Provider unavailable"]);
  assert.equal(f.errors.length, 1);
});

test("a provider's explicit model refusal or an unconfirmed terminal dispatch needs inspection before retry", async () => {
  for (const reason of ["model", "terminal"]) {
    const f = fixture(), task = { id: reason, title: reason, status: "queued", held: true, createdAt: "1" };
    f.tasks.push(task);
    f.board.isOwner = () => true;
    f.replaceHandler(async () => {
      if (reason === "model") throw Object.assign(new Error("Invalid model"), { modelRefused: true });
      task.terminalLaunch = { sessionId: "issued" };
      throw new Error("Terminal disconnected");
    });
    await f.startHeld();
    assert.ok(task.launchError);
    assert.equal(task.startRetryAt, undefined);
    assert.equal((await f.board.dispatchHeld(task, () => assert.fail("unexpected retry"))).state, "waiting");
  }
});

// Since 0.7.5 acceptance checks come only from the Haiku completion rule (test/prepare-task.test.js); the typed checks and OR/AND rule are gone.
test("create defaults to auto-start and retains model, effort and parent; typed checks are no longer read", async () => {
  const f = fixture();
  await f.create({ ...request, checks: "npm test", completionMode: "both" });
  assert.deepEqual(f.added, [[request.title, request.prompt, request.account, request.parentId, request.model, request.effort, undefined]]);
  assert.deepEqual(f.starts, ["saved-1"]);
  assert.deepEqual(f.shown, [true]);
  assert.deepEqual(f.errors, []);
});

test("F69: the Orchestrator tickbox passes no headless; with the panel on, a Claude or Codex orchestrator starts through Board.start (its card terminal), never the panel or headless", async () => {
  const orchestrate = (f) => { Object.assign(f.board, { orchestratorEnabled: () => true, capsOf: () => ({ open: 4 }), briefPath: "/no/brief.md" }); return f; };
  const f = orchestrate(fixture({ wrapper: true }));
  await f.create({ ...request, mayOpen: true, cardTerminal: true });
  assert.deepEqual(f.added[0][7], { permission: "bypass", orchestrator: { caps: { open: 4 }, opened: 0 } }, "no headless; Board.add gives the card terminal");
  assert.match(f.added[0][1], /Implement the approved task\.$/, "the brief comes first, the task last");
  assert.deepEqual([f.starts, f.shown, f.errors], [["saved-1"], [true], []], "Board.start: the terminal, not the panel");
  // The control: the same fixture sends an ordinary card to the panel, which this test forbids.
  const plain = fixture({ wrapper: true });
  await plain.create(request);
  assert.deepEqual(plain.starts, []);
  assert.match(plain.errors.join("\n"), /must not open a window/);
  // A Codex orchestrator starts the same way; one saved before this change, with no card terminal, still starts headless.
  const codex = orchestrate(fixture({ wrapper: true, provider: "codex", title: "unused" }));
  const headless = [];
  codex.board.startHeadless = async (task) => { headless.push(task.id); };
  await codex.create({ ...request, orchestrator: true });
  assert.deepEqual([headless, codex.starts, codex.errors], [[], ["saved-1"], []]);
  codex.tasks.push({ id: "older", status: "queued", title: "older", createdAt: "", provider: "codex", orchestrator: { caps: {}, opened: 0 } });
  await codex.handle({ type: "start", id: "older" });
  assert.deepEqual([headless, codex.starts], [["older"], ["saved-1"]]);
});

test("new tasks auto-start with three sessions already running by default", async () => {
  const f = fixture();
  for (const id of ["one", "two", "three"]) f.tasks.push({ id, status: "running", title: id, createdAt: "" });
  await f.create(request);
  assert.deepEqual(f.starts, ["saved-4"]);
  assert.equal(f.tasks[3].held, undefined);
  assert.equal(require("../package.json").contributes.configuration.properties["entomatical.maxRunning"].default, 0);
});

test("the running limit holds a new card in Queued instead of starting it (F82); a startAfter field in the message is ignored", async () => {
  const f = fixture({ title: "unused" });
  await f.create({ ...request, parentId: "" });
  assert.deepEqual(f.starts, ["saved-1"]); // card 1 has no session id in this stand-in, so it does not count as running
  await f.create({ ...request, parentId: "", startAfter: "saved-1" });
  assert.equal(f.added[1].length, 7, "no dependsOn step is passed");
  assert.deepEqual([f.tasks[1].dependsOn, f.tasks[1].held, f.starts], [undefined, undefined, ["saved-1", "saved-2"]]);
  const full = fixture({ maxRunning: 1 });
  full.tasks.push({ id: "busy", status: "running", title: "busy", createdAt: "" });
  await full.create(request);
  assert.deepEqual([full.starts, full.tasks[1].held], [[], true]);
});

test("auto-start disabled saves exactly one queued task without launching", async () => {
  const f = fixture({ autoStart: false });
  await f.create(request);
  assert.equal(f.tasks.length, 1);
  assert.equal(f.tasks[0].status, "queued");
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.shown, []);
  assert.deepEqual(f.errors, []);
});

test("start failure is reported after saving and does not reject create or duplicate its task", async () => {
  const f = fixture({ autoStart: true, startError: "Synthetic launch failure" });
  await assert.doesNotReject(f.create(request));
  assert.equal(f.added.length, 1);
  assert.equal(f.tasks.length, 1);
  assert.equal(f.tasks[0].status, "queued");
  assert.deepEqual(f.starts, ["saved-1"]);
  assert.deepEqual(f.shown, []);
  assert.deepEqual(f.errors, ["Entomatical: Synthetic launch failure"]);
});

test("invalid creation requests fail before saving or auto-starting", async () => {
  const f = fixture({ autoStart: true });
  await assert.rejects(f.create({ ...request, prompt: " \n" }), /needs a prompt/);
  assert.deepEqual(f.added, []);
  assert.deepEqual(f.starts, []);
});

// the user, 30 October 2026: an untitled task is named before its first start, so the session is created under that name.
test("an untitled task is named by Haiku at low effort before it starts; a typed title is kept as is", async () => {
  const f = fixture({ title: "Fix login redirect" });
  await f.create({ ...request, title: "" });
  assert.equal(f.titled.length, 1);
  assert.deepEqual([f.titled[0].purpose, f.titled[0].model, f.titled[0].effort, f.titled[0].configDir, f.titled[0].codexPath, f.titled[0].fallbacks],
    ["title", "haiku", "low", "/acct", undefined, ["/other"]]);
  assert.equal(f.titled[0].draft, request.prompt);
  assert.deepEqual(f.updates, [{ id: "saved-1", title: "Fix login redirect", named: true }]);
  assert.deepEqual([f.tasks[0].title, f.tasks[0].named, f.starts, f.warnings], ["Fix login redirect", true, ["saved-1"], []]);
  const typed = fixture({ title: "unused" });
  await typed.create(request);
  assert.deepEqual([typed.titled, typed.updates, typed.starts], [[], [], ["saved-1"]]);
});

// The Haiku title drop-down (the user, 13 November 2026): only haiku, opus, fable and low to max are taken; anything else is the default.
test("an untitled Claude task is named by the model and effort picked on the form; an unknown pick is Haiku at low", async () => {
  const f = fixture({ title: "Named" });
  await f.create({ ...request, title: "", titleModel: "opus", titleEffort: "high" });
  assert.deepEqual([f.titled[0].model, f.titled[0].effort], ["opus", "high"]);
  const bad = fixture({ title: "Named" });
  await bad.create({ ...request, title: "", titleModel: "sonnet", titleEffort: "ultra" });
  assert.deepEqual([bad.titled[0].model, bad.titled[0].effort], ["haiku", "low"]);
  const failed = fixture({ title: new Error("No.") });
  await failed.create({ ...request, title: "", titleModel: "fable", titleEffort: "max" });
  assert.match(failed.warnings[0], /Fable 5.2 did not name it/);
  // A Codex task is still named by Luna at low effort.
  const codex = fixture({ title: "Named", provider: "codex", codexModels: [{ model: "gpt-6-luna", efforts: ["low"] }] });
  await codex.create({ ...request, title: "", titleModel: "opus", titleEffort: "max" });
  assert.deepEqual([codex.titled[0].model, codex.titled[0].effort], ["gpt-6-luna", "low"]);
});

test("an untitled Codex task is named by the newest Luna model at low effort through the Codex CLI", async () => {
  const models = [{ model: "gpt-5.6-luna", efforts: ["low"] }, { model: "gpt-6-luna", efforts: ["low"] }, { model: "gpt-6.1-sol", efforts: ["low"] }];
  const f = fixture({ title: "Add retry to fetch", provider: "codex", codexModels: models });
  await f.create({ ...request, title: "" });
  assert.deepEqual([f.titled[0].model, f.titled[0].effort, f.titled[0].codexPath, f.titled[0].fallbacks, f.titled[0].configDir], ["gpt-6-luna", "low", "/bin/codex", [], ""]);
  assert.deepEqual([f.tasks[0].title, f.starts], ["Add retry to fetch", ["saved-1"]]);
  // No Luna model: the task keeps its prompt's first line and still starts, with a warning.
  const none = fixture({ title: "unused", provider: "codex", codexModels: [{ model: "gpt-6.1-sol", efforts: ["low"] }] });
  await none.create({ ...request, title: "" });
  assert.deepEqual([none.tasks[0].title, none.starts], [request.prompt, ["saved-1"]]);
  assert.match(none.warnings[0], /Luna did not name it.*Luna model/);
});

test("a failed title keeps the prompt's first line and the task still starts; auto-start off names nothing", async () => {
  const f = fixture({ title: new Error("Every account hit its limit.") });
  await f.create({ ...request, title: "" });
  assert.deepEqual([f.tasks[0].title, f.tasks[0].named, f.starts, f.updates], [request.prompt, undefined, ["saved-1"], []]);
  assert.match(f.warnings[0], /Haiku 5.5 did not name it. Every account hit its limit/);
  const off = fixture({ autoStart: false, title: "unused" });
  await off.create({ ...request, title: "" });
  assert.deepEqual([off.titled, off.starts], [[], []]);
});

test("the Haiku title tickbox unticked leaves an untitled task under its prompt's first line", async () => {
  const f = fixture({ title: "unused" });
  await f.create({ ...request, title: "", autoTitle: false });
  assert.deepEqual([f.titled, f.updates, f.tasks[0].title, f.starts], [[], [], request.prompt, ["saved-1"]]);
  const ticked = fixture({ title: "Named" });
  await ticked.create({ ...request, title: "", autoTitle: true });
  assert.equal(ticked.tasks[0].title, "Named");
});

test("a title helper that has not answered in 45 s is stopped; the task starts under its prompt's first line", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ title: STUCK });
  const create = f.create({ ...request, title: "" });
  await new Promise(setImmediate); // up to the helper's call
  assert.equal(f.titled.length, 1);
  t.mock.timers.tick(44_999);
  await new Promise(setImmediate);
  assert.deepEqual(f.starts, [], "still waiting just before the deadline");
  t.mock.timers.tick(1);
  await create;
  assert.deepEqual([f.tasks[0].title, f.tasks[0].named, f.updates, f.starts], [request.prompt, undefined, [], ["saved-1"]]);
  assert.match(f.warnings[0], /starts under its prompt's first line; Haiku 5.5 did not name it/);
});

test("Start pressed while Haiku names the card waits for the automatic start instead of starting it without its name (F53)", async () => {
  let answer;
  const f = fixture({ title: new Promise((r) => { answer = r; }), allowInfo: true });
  const creating = f.create({ ...request, title: "", parentId: "" });
  await new Promise((r) => setImmediate(r));
  await f.handle({ type: "start", id: "saved-1" });
  assert.deepEqual(f.starts, []);
  assert.match(f.infos[0], /is being named\. It starts once its title is made, or waits its turn/);
  answer("Named by Haiku");
  await creating;
  assert.deepEqual(f.starts, ["saved-1"]); // the one start, after the title
});

// F99: Plan first sends the planning prompt (docs/orchestrator/PLANNER.md, its paths filled) with the task last; Haiku names the task
// from the prompt as typed, before the wrap. A card add() did not keep planFirst for (Codex, headless) gets the prompt as typed.
test("Plan first: the card is sent the planning prompt with the task last, named from the task as typed", async () => {
  const f = fixture({ title: "Split the parser" });
  f.board.repo = "/repo";
  const add = f.board.add;
  f.board.add = (...args) => Object.assign(add(...args), args[7]?.planFirst ? { planFirst: true } : {});
  await f.create({ ...request, title: "", planFirst: true });
  assert.equal(f.added[0][7].planFirst, true);
  assert.equal(f.titled[0].draft, request.prompt, "Haiku names the task, not the template");
  const sent = f.tasks[0].prompt;
  assert.match(sent, /^Plan this task\. A plan of two or more steps becomes an Entomatical plan file/);
  assert.match(sent, /If the approved plan is a single step, write no plan file/); // the user, 14 November 2026
  assert.match(sent, /workflows\/<short-kebab-name>\.plan\.json/);
  assert.ok(sent.includes(require("node:path").join("/repo", "workflows", "checks.json")), "the repo's check catalogue by its path");
  assert.doesNotMatch(sent, /\{\{(task|guide|schema|checks)\}\}/);
  assert.ok(sent.endsWith(`Task:\n\n${request.prompt}`) || sent.endsWith(`Task:\r\n\r\n${request.prompt}`));
  assert.deepEqual(f.starts, ["saved-1"]);
  const kept = fixture({ title: "unused" });
  kept.board.repo = "/repo";
  await kept.create({ ...request, planFirst: true }); // this stand-in's add() drops planFirst, as the board's does for Codex
  assert.equal(kept.tasks[0].prompt, request.prompt);
});
