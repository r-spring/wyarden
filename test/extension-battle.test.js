// Battle Royale's host side (src/extension.ts `battle`, the user, 14 November 2026): one message makes a card per provider, each on its
// top model at its top effort, in its card terminal with permission bypass. In the style of test/extension-create.test.js: no window,
// no session, no process; board.add and the starts are recorded.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const BATTLE_PREAMBLE = require("../out/battle.js").battlePreamble(3); // four contestants
const { withRule } = require("../out/text-actions.js");

const ACCOUNTS = [
  { name: "user@claude-one" }, { name: "user@claude-two" },
  { name: "Codex · user@codex", provider: "codex" },
  { name: "Grok · ~/.grok", provider: "grok" },
  { name: "user@antigravity", provider: "antigravity" },
];
const CODEX = [{ model: "gpt-6-luna", efforts: ["low"] }, { model: "gpt-6.1-sol", efforts: ["low", "medium", "high", "xhigh", "ultra"] }];
const RULE = { goal: "The parser is split.", doneWhen: "parser.ts is two files and npm test passes.", commands: [] };
const CAPS = { open: 3, total: 50, depth: 2, followUps: 5, pending: 10, watchers: 1, perWatcher: 4 };
/** The orchestrator brief a battle card with Orchestrator ticked gets first in its message (board.briefPath). */
const BRIEF_FILE = path.join(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "entomatical-battle-brief-")), "BRIEF.md");
fs.writeFileSync(BRIEF_FILE, "# Brief\n\nPlan, open cards, wait.\n");
test.after(() => fs.rmSync(path.dirname(BRIEF_FILE), { recursive: true, force: true }));

/**
 * Battle Royale's arena calls on a stand-in board (src/arena.ts ArenaBoard), each recorded in `log` with the board's repo. A card is
 * live while `live` is set. Any call that would finish, cancel, remove, merge or delete is refused and recorded in `forbidden`.
 */
function arenaApi(board, log, forbidden, { owner = true, stopError } = {}) {
  const repo = board.repo;
  Object.assign(board, {
    isOwner: () => owner,
    mustOwn() { if (!owner) throw new Error("Another VS Code window runs this repo's board."); },
    live: () => board.tasks.filter((t) => t.live).map((t) => t.id),
    liveRun: (m) => [...board.tasks.filter((t) => t.live && t.openedBy === m.id), ...(m.live ? [m] : [])],
    stopRun(m) { log.push(["stopRun", repo, m.id]); m.paused = true; for (const t of board.liveRun(m)) t.live = false; },
    stop(t) { if (stopError?.(t)) throw new Error(stopError(t)); log.push(["stop", repo, t.id]); t.live = false; },
    pauseRun(m) { log.push(["pauseRun", repo, m.id]); m.paused = true; },
    resumeRun(m) { log.push(["resumeRun", repo, m.id]); m.paused = undefined; },
    warnBattle(t, text) { log.push(["warn", repo, t.id, text]); return "typed"; },
    battleNotice(id, text) { log.push(["notice", repo, id, text]); },
    noteEvent(id, name, desc) { log.push(["event", repo, id, desc]); },
    async retryCleanups() { log.push(["retryCleanups", repo]); return { removed: 0, failed: [] }; },
    checks: { stop(t) { log.push(["checks.stop", repo, t.id]); } },
  });
  for (const name of ["finish", "remove", "cancel", "archiveRun", "markDone", "discard", "merge", "send"]) board[name] = () => { forbidden.push(name); throw new Error(`${name} must not be called`); };
  return board;
}

function fixture({ accounts = ACCOUNTS, addError, maxRunning, title = "Split the parser", owner = true, stopError, processes = [], warnMs = 0, orchestratorEnabled = true, battle = {} } = {}) {
  const added = [], starts = [], warnings = [], errors = [], infos = [], titled = [], rules = [], log = [], forbidden = [];
  const forbid = () => { throw new Error("This test must not open a window or launch a process."); };
  const vscode = {
    ProgressLocation: { Notification: 15 },
    workspace: { getConfiguration: (section) => ({ get: (key, fallback) => {
      if (section === "entomatical" && key === "autoStart") return fallback;
      if (section === "entomatical" && key === "maxRunning") return maxRunning ?? fallback;
      // Battle Royale's settings: on here unless a test turns it off (the extension's own default is off).
      if (section === "entomatical" && key.startsWith("battleRoyale.")) return { enabled: true, ...battle }[key.slice(13)] ?? fallback;
      throw new Error(`Unexpected setting ${section}.${key}`);
    } }) },
    window: { showErrorMessage: (m) => { errors.push(m); }, showInformationMessage: (m) => { infos.push(m); }, showWarningMessage: (m) => { warnings.push(m); },
      setStatusBarMessage: () => ({ dispose() {} }),
      withProgress: async (o, work) => {
        if (o.title === "Entomatical: Battle Royale") log.push(["wait"]);
        return work({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
      } },
  };
  const stubs = {
    "./text-actions": { ...require("../out/text-actions.js"),
      generateText: async (dir, purpose, draft, configDir, model, answers, signal, effort) => { titled.push({ purpose, draft, configDir, model, effort }); return { value: { title }, model }; },
      completionRule: async (dir, prompt, project, models) => { rules.push({ prompt, model: models.model, effort: models.effort }); return { rule: RULE, dropped: [], writer: "claude-fable-5-1", effort: models.effort, answered: [] }; } },
    "./board": { accounts: () => accounts },
    "./codex": { codexModels: () => CODEX, codexBinary: () => "/bin/codex", codexTextPath: () => "/bin/codex" },
    "./sessions": { otherAccountDirs: () => ["/other"] },
    "./jobs": { projectContext: () => ({}) },
    "./checks": require("../out/checks.js"),
    "./queue": require("../out/queue.js"),
    "./models": require("../out/models.js"),
    "./plan": require("../out/plan.js"),
    "./battle": require("../out/battle.js"),
    "./orchestrator": require("../out/orchestrator.js"),
    // Never a real process list or kill: the sweep gets `processes` and records what it would end.
    "./arena": { ...require("../out/arena.js"),
      listProcesses: async () => { log.push(["list"]); return processes; },
      endProcesses: async (pids) => { log.push(["end", [...pids]]); return { ended: pids.length, failures: [] }; } },
  };
  const filename = require.resolve("../out/extension.js");
  const extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = (name) => {
    if (name === "vscode") return vscode;
    if (name === "child_process") return { execFile: forbid, execFileSync: forbid, spawn: forbid };
    if (name === "./profiles") return require("../out/profiles.js"); // pure: capability profiles (phase 2)
    if (name.startsWith("./")) return stubs[name] ?? {};
    return require(name);
  };
  extension._compile(fs.readFileSync(filename, "utf8") + '\nstate = { get: key => key === "panelDeclined" }; module.exports.handle = handle;'
    + ` module.exports.arenaMessage = arenaMessage; module.exports.windowBoards = windowBoards; arenaTiming = { warnMs: ${warnMs}, settleMs: 0 };\n`, filename);
  const tasks = [];
  const board = {
    tasks, dir: path.join(__dirname, "no-board"), repo: path.join(__dirname, "no-repo"),
    accountList: () => accounts, configDirOf: () => "/acct", orchestratorEnabled: () => orchestratorEnabled, notInMainOf: () => undefined, deliverEveryTurns: () => 3,
    capsOf: () => ({ ...CAPS }), briefPath: BRIEF_FILE,
    add(...args) {
      if (addError && args[2] === addError.account) throw new Error(addError.message);
      log.push(["add", args[0]]);
      added.push(args);
      const provider = accounts.find((a) => a.name === args[2])?.provider;
      const task = { id: `saved-${tasks.length + 1}`, status: "queued", createdAt: "", title: args[0], prompt: args[1], account: args[2], provider, ...args[7] };
      tasks.push(task);
      return task;
    },
    get(id) { return tasks.find((t) => t.id === id); },
    update(task, patch) { log.push(["update", board.repo, task.id, patch]); Object.assign(task, patch); },
    async start(task) { starts.push(task.id); return { show() {} }; },
    async startCardTerminal(task) { starts.push(task.id); },
    startInPanel: forbid, startHeadless: forbid,
  };
  arenaApi(board, log, forbidden, { owner, stopError });
  /** Another board of this window (one per window today; the arena takes any number). */
  const other = (repo, options) => { const b = arenaApi({ repo, tasks: [], update(t, p) { log.push(["update", repo, t.id, p]); Object.assign(t, p); } }, log, forbidden, options); extension.exports.windowBoards.add(b); return b; };
  return { battle: (m) => extension.exports.handle(board, { type: "battle", ...m }), message: (m) => extension.exports.arenaMessage(board, m, 1), other,
    board, added, tasks, starts, warnings, errors, infos, titled, rules, log, forbidden };
}

/** A run (its master and a child running), a card running alone, a held card, and a Done card. */
function seed(board) {
  board.tasks.push(
    { id: "m1", title: "run", status: "running", createdAt: "", orchestrator: { opened: 1 }, live: true },
    { id: "c1", title: "child", status: "running", createdAt: "", openedBy: "m1", live: true },
    { id: "a1", title: "alone", status: "running", createdAt: "", live: true },
    { id: "q1", title: "held", status: "queued", createdAt: "", held: true },
    { id: "d1", title: "done", status: "done", createdAt: "" });
}
const leftover = (pid, ppid, ...parts) => ({ pid, ppid, name: "node", command: `node "${path.join(...parts)}"` });

// Orchestrator unticked: a battle with it ticked is the test "with Orchestrator ticked …" below (a47807).
const form = { title: "", prompt: "Split parser.ts into a lexer and a parser.", account: "user@claude-two", parentId: "", model: "haiku", effort: "low",
  permission: "ask", planFirst: true, cardTerminal: false, orchestrator: false, asana: "123", obsidian: "note.md" };

test("a battle message makes four cards: same prompt and Done when, each provider's model and effort, card terminal, bypass, one battle id", async () => {
  const f = fixture();
  assert.deepEqual(await f.battle({ ...form, autoTitle: true, autoRule: true }), f.tasks.map((card) => card.id));
  assert.deepEqual(f.errors, []);
  assert.equal(f.added.length, 4);
  // The Done when is written once, on the user's prompt, by the default writer; every card carries it.
  assert.deepEqual(f.rules, [{ prompt: form.prompt, model: "fable", effort: "high" }]);
  const prompt = `${BATTLE_PREAMBLE}\n\n${withRule(form.prompt, RULE)}`;
  for (const a of f.added) {
    assert.equal(a[1], prompt);
    assert.deepEqual(a[6], { commands: [], doneWhen: RULE.doneWhen, goal: RULE.goal, writer: "claude-fable-5-1", effort: "high" });
    assert.equal(a[3], "", "no parent");
  }
  // Account, model and effort per provider; the form's Claude account is used, its model and effort are not.
  assert.deepEqual(f.added.map((a) => [a[2], a[4], a[5]]), [
    ["user@claude-two", "fable", "max"], ["Codex · user@codex", "sol", "ultra"], ["Grok · ~/.grok", "", ""], ["user@antigravity", "carbon", "high"]]);
  const battle = f.added[0][7].battle;
  assert.match(battle, /^[0-9a-f]{8}$/);
  for (const a of f.added) assert.deepEqual(a[7], { permission: "bypass", cardTerminal: true, battle }); // no planFirst, no orchestrator
  // Named once, from the user's prompt; each title ends in its provider.
  assert.equal(f.titled.length, 1);
  assert.deepEqual([f.titled[0].draft, f.titled[0].model, f.titled[0].effort], [form.prompt, "haiku", "low"]);
  assert.deepEqual(f.added.map((a) => a[0]), ["Split the parser · Claude", "Split the parser · Codex", "Split the parser · Grok", "Split the parser · Antigravity"]);
  assert.deepEqual(f.starts, ["saved-1", "saved-2", "saved-3", "saved-4"]);
  assert.deepEqual(f.warnings, []);
  // A second battle gets its own id.
  const g = fixture();
  await g.battle(form);
  assert.notEqual(g.added[0][7].battle, battle);
});

test("with Orchestrator ticked each battle card is an orchestrator in its card terminal: the caps, its run approved, the brief before the Battle Royale line, not headless; the four start there", async () => {
  const { masterPrompt } = require("../out/orchestrator.js");
  const f = fixture();
  await f.battle({ ...form, orchestrator: true });
  assert.deepEqual(f.errors, []);
  assert.equal(f.added.length, 4);
  const battle = f.added[0][7].battle;
  for (const a of f.added) {
    const { orchestrator, approved, runPolicy, ...rest } = a[7];
    assert.deepEqual(rest, { permission: "bypass", cardTerminal: true, battle }, "no headless, no planFirst");
    assert.deepEqual(orchestrator, { caps: CAPS, opened: 0 });
    assert.deepEqual([approved.hash, typeof approved.at, runPolicy], ["battle", "string", { allow: [], deny: [], noSync: true }]);
    assert.equal(a[1], masterPrompt(fs.readFileSync(BRIEF_FILE, "utf8"), `${BATTLE_PREAMBLE}\n\n${form.prompt}`));
  }
  // Each starts in its card terminal: Claude and Codex through start, Grok and Antigravity in theirs; startHeadless would throw here.
  assert.deepEqual(f.starts, ["saved-1", "saved-2", "saved-3", "saved-4"]);
  // The orchestrator setting off: the tickbox changes nothing, as for Add task.
  const off = fixture({ orchestratorEnabled: false });
  await off.battle({ ...form, orchestrator: true });
  for (const a of off.added) assert.deepEqual([a[1], a[7]], [`${BATTLE_PREAMBLE}\n\n${form.prompt}`, { permission: "bypass", cardTerminal: true, battle: off.added[0][7].battle }]);
});

test("a battle honours parent and a typed title; without Done when the prompt is the user's; Haiku title off keeps the prompt's first line", async () => {
  const f = fixture();
  await f.battle({ ...form, title: "Parser race", parentId: "p1", autoTitle: true });
  assert.deepEqual([f.titled, f.rules], [[], []]);
  assert.deepEqual(f.added.map((a) => [a[0], a[3], a[6]]).at(-1), ["Parser race · Antigravity", "p1", undefined]);
  assert.equal(f.added[0][1], `${BATTLE_PREAMBLE}\n\n${form.prompt}`);
  const off = fixture();
  await off.battle({ ...form, autoTitle: false });
  assert.deepEqual([off.titled, off.added[1][0]], [[], `${form.prompt} · Codex`]);
});

test("a skipped provider is named in one warning; a refused card leaves the others and one warning names it and why", async () => {
  const f = fixture({ accounts: ACCOUNTS.filter((a) => a.provider !== "grok"), addError: { account: "Codex · user@codex", message: "Unknown model sol." } });
  assert.deepEqual(await f.battle(form), ["saved-1", "saved-2"]);
  assert.deepEqual(f.added.map((a) => a[0].split(" · ").at(-1)), ["Claude", "Antigravity"]);
  assert.deepEqual(f.starts, ["saved-1", "saved-2"]);
  assert.deepEqual(f.warnings, ["Entomatical: Battle Royale runs without Grok (no Grok account is signed in).", "Entomatical: Battle Royale made no Codex card. Unknown model sol."]);
});

test("the running limit holds battle cards in Queued as it holds a created card", async () => {
  const full = fixture({ maxRunning: 1 });
  full.tasks.push({ id: "busy", status: "running", sessionId: "s", title: "busy", createdAt: "" });
  await full.battle(form);
  assert.deepEqual([full.starts, full.tasks.filter((t) => t.held).length], [[], 4]);
});

test("an empty prompt, or one provider alone, adds nothing and starts nothing", async () => {
  const f = fixture();
  await assert.rejects(f.battle({ ...form, prompt: " \n" }), /needs a prompt/);
  assert.deepEqual([f.added, f.starts, f.titled, f.rules], [[], [], [], []]);
  const alone = fixture({ accounts: [{ name: "user@claude-one" }] });
  await assert.rejects(alone.battle({ ...form, autoTitle: true, autoRule: true }), /at least two contestants, and only Claude can run/);
  assert.deepEqual([alone.added, alone.starts, alone.titled, alone.rules], [[], [], [], []]);
});

// ---- Clearing the arena (src/arena.ts, the user, 14 November 2026): the popup's battlePrepare, battleWarn and battleCancel, then battle. ----

const { ARENA_WARNING, ARENA_CALLED_OFF, ARENA_STOPPED } = require("../out/arena.js");
const kinds = (log) => log.map((c) => c[0]);
const REPO = path.join(__dirname, "no-repo"); // every fixture's board

test("battlePrepare checks, finds the targets and lists the processes, and changes nothing", async () => {
  const g = fixture({ processes: [leftover(70, 1, REPO, ".entomatical", "wt", "abc", "a.js"), leftover(71, 1, __dirname, "elsewhere", ".entomatical", "wt", "x")] });
  seed(g.board);
  const before = structuredClone(g.tasks);
  assert.deepEqual(await g.message({ type: "battlePrepare", ...form }), { battleReady: { cards: 3, runs: 1, skipped: [], processes: 1 } });
  assert.deepEqual(g.log, [["list"]]);
  assert.deepEqual(g.tasks, before);
  assert.deepEqual([g.added, g.starts, g.infos, g.forbidden], [[], [], [], []]);
});

test("battleWarn warns every live card, pauses the run and clears held; battleCancel tells them it is off and puts the run and held back", async () => {
  const f = fixture();
  seed(f.board);
  const repo = f.board.repo;
  assert.equal(await f.message({ type: "battleWarn", ...form }), undefined);
  assert.deepEqual(f.log, [["pauseRun", repo, "m1"], ["update", repo, "q1", { held: undefined }],
    ["warn", repo, "m1", ARENA_WARNING], ["warn", repo, "c1", ARENA_WARNING], ["warn", repo, "a1", ARENA_WARNING]]);
  assert.deepEqual([f.board.get("m1").paused, f.board.get("q1").held], [true, undefined]);
  // A second Yes while warned changes nothing more: the 30 seconds run from the first.
  await f.message({ type: "battleWarn", ...form });
  assert.equal(f.log.length, 5);
  f.log.length = 0;
  assert.equal(await f.message({ type: "battleCancel", ...form }), undefined);
  assert.deepEqual(f.log, [["warn", repo, "m1", ARENA_CALLED_OFF], ["warn", repo, "c1", ARENA_CALLED_OFF], ["warn", repo, "a1", ARENA_CALLED_OFF],
    ["resumeRun", repo, "m1"], ["update", repo, "q1", { held: true }]]);
  assert.deepEqual([f.board.get("m1").paused, f.board.get("q1").held], [undefined, true]);
  await f.message({ type: "battleCancel", ...form }); // nothing warned now: nothing to call off
  assert.equal(f.log.length, 5);
  assert.deepEqual([f.added, f.infos, f.forbidden], [[], [], []]);
});

test("battle after the warning: the wait, then the stop, the sweep and one report, then the four cards", async () => {
  const repo = REPO;
  const procs = [leftover(80, 1, repo, ".entomatical", "wt", "m1", "a.js"), { pid: 81, ppid: 80, name: "git", command: "git status" },
    leftover(82, 1, repo, ".entomatical", "tmp", "t-1", "run.js"), leftover(83, 1, __dirname, "not-a-board", ".entomatical", "wt", "x.js"),
    { pid: process.pid, ppid: 1, name: "node", command: `node "${path.join(repo, ".entomatical", "wt", "host")}"` }];
  const g = fixture({ warnMs: 60, processes: procs });
  seed(g.board);
  await g.message({ type: "battleWarn", ...form });
  await g.battle(form);
  const k = kinds(g.log);
  assert.equal(k.filter((x) => x === "warn").length, 3, "warned once, by the popup's first Yes");
  assert.equal(k.filter((x) => x === "wait").length, 1);
  const at = (kind) => k.indexOf(kind), last = (kind) => k.lastIndexOf(kind);
  assert.ok(last("warn") < at("wait") && at("wait") < at("stopRun") && at("stopRun") < at("stop") && last("stop") < at("list")
    && at("list") < at("end") && at("end") < at("retryCleanups") && at("retryCleanups") < at("add"), k.join(" "));
  assert.deepEqual(g.log.filter((c) => c[0] === "stopRun" || c[0] === "stop").map((c) => c.slice(0, 3)), [["stopRun", repo, "m1"], ["stop", repo, "a1"]]);
  assert.deepEqual(g.log.filter((c) => c[0] === "event").map((c) => [c[2], c[3]]), [["m1", ARENA_STOPPED], ["c1", ARENA_STOPPED], ["a1", ARENA_STOPPED]]);
  // The leftovers under this board's worktree and temp folders, with the child; never this process, nor a folder of no board here.
  assert.deepEqual(g.log.find((c) => c[0] === "end")[1], [80, 81, 82]);
  assert.deepEqual(g.infos, ["Entomatical: Battle Royale cleared the arena. Stopped 3 cards, 1 run; ended 3 leftover processes. Stopped cards wait in Review; Resume continues each."]);
  assert.deepEqual(g.log.filter((c) => c[0] === "add").length, 4);
  assert.equal(k.slice(at("add")).filter((x) => x !== "add" && x !== "update").length, 0, "nothing is stopped after the cards are added");
  assert.deepEqual([g.board.get("q1").held, g.board.get("m1").paused], [undefined, true]); // parked: the held card keeps its Start button
  assert.deepEqual(g.forbidden, []);
  // No warning before: the battle warns first, then waits the whole 30 seconds (here 60 ms).
  const h = fixture({ warnMs: 60 });
  seed(h.board);
  await h.battle(form);
  const hk = kinds(h.log);
  assert.ok(hk.indexOf("pauseRun") < hk.indexOf("wait") && hk.lastIndexOf("warn") < hk.indexOf("wait") && hk.indexOf("wait") < hk.indexOf("stopRun"), hk.join(" "));
});

// ---- The entomatical.battleRoyale settings (the user, 17 November 2026). ----

test("battleRoyale.enabled off: every battle message is refused before anything is warned, stopped or made", async () => {
  const g = fixture({ battle: { enabled: false } });
  seed(g.board);
  const off = /Battle Royale is off\. Turn it on in Settings: Entomatical › Battle Royale: Enabled\./;
  assert.match((await g.message({ type: "battlePrepare", ...form })).battleRefused, off);
  assert.match((await g.message({ type: "battleWarn", ...form })).battleRefused, off);
  await assert.rejects(g.battle(form), off);
  assert.deepEqual([g.added, g.starts, g.log], [[], [], []]);
});

test("battleRoyale.clearArena off: no warning, wait, stop or sweep; the contestants run beside the running cards", async () => {
  const g = fixture({ warnMs: 60, battle: { clearArena: false } });
  seed(g.board);
  assert.equal(await g.message({ type: "battleWarn", ...form }), undefined);
  await g.battle(form);
  assert.deepEqual(kinds(g.log).filter((x) => x !== "add" && x !== "update"), [], "nothing warned, paused, waited for, stopped or listed");
  assert.deepEqual([g.added.length, g.infos], [4, []]);
  assert.equal(g.board.get("q1").held, true);
});

test("battleRoyale.contestants: the count and line-up it names, the preamble counting the others", async () => {
  const g = fixture({ battle: { contestants: [{ provider: "claude", model: "opus", effort: "high" }, { provider: "claude", account: "user@claude-one" }, { provider: "grok" }] } });
  await g.battle(form);
  assert.deepEqual(g.added.map((a) => [a[0], a[2], a[4], a[5]]), [
    ["Split the parser · Claude 1", "user@claude-two", "opus", "high"],
    ["Split the parser · Claude 2", "user@claude-one", "", ""],
    ["Split the parser · Grok", "Grok · ~/.grok", "", ""]]);
  for (const a of g.added) assert.equal(a[1], `${require("../out/battle.js").battlePreamble(2)}\n\n${form.prompt}`);
});

test("a second battle while one clears the arena is refused and calls nothing off; the first still adds its four cards", async () => {
  const f = fixture({ warnMs: 60 });
  seed(f.board);
  await f.message({ type: "battleWarn", ...form });
  const first = f.battle(form);
  await assert.rejects(f.battle(form), /already clearing the arena/);
  await first;
  assert.deepEqual([f.log.filter((c) => c[0] === "add").length, f.log.filter((c) => c[0] === "resumeRun").length], [4, 0]);
});

test("a refused battle clears nothing, and a warning that went out is called off", async () => {
  const alone = fixture({ accounts: [{ name: "user@claude-one" }] });
  seed(alone.board);
  const prepared = await alone.message({ type: "battlePrepare", ...form });
  assert.match(prepared.battleRefused, /^Battle Royale needs at least two contestants, and only Claude can run\./);
  assert.match((await alone.message({ type: "battleWarn", ...form })).battleRefused, /at least two contestants/);
  await assert.rejects(alone.battle(form), /at least two contestants/);
  assert.deepEqual([alone.log, alone.added], [[], []]);
  const notOwned = fixture({ owner: false });
  seed(notOwned.board);
  assert.deepEqual(await notOwned.message({ type: "battlePrepare", ...form }), { battleRefused: "Another VS Code window runs this repo's board." });
  await assert.rejects(notOwned.battle(form), /Another VS Code window/);
  assert.deepEqual(notOwned.log, []);
  const f = fixture();
  seed(f.board);
  await f.message({ type: "battleWarn", ...form });
  f.log.length = 0;
  await assert.rejects(f.battle({ ...form, prompt: " " }), /needs a prompt/);
  assert.deepEqual(kinds(f.log), ["warn", "warn", "warn", "resumeRun", "update"]); // called off
  assert.ok(f.log.filter((c) => c[0] === "warn").every((c) => c[3] === ARENA_CALLED_OFF));
  assert.deepEqual([f.board.get("m1").paused, f.board.get("q1").held, f.added], [undefined, true, []]);
});

test("a board another window owns is skipped and reported; its cards, runs and processes are left alone", async () => {
  const elsewhere = path.join(__dirname, "elsewhere");
  const g = fixture({ processes: [leftover(90, 1, REPO, ".entomatical", "wt", "a1", "x.js"), leftover(91, 1, elsewhere, ".entomatical", "wt", "a1", "x.js")] });
  seed(g.board);
  const gOther = g.other(elsewhere, { owner: false });
  seed(gOther);
  assert.deepEqual(await g.message({ type: "battlePrepare", ...form }), { battleReady: { cards: 3, runs: 1, skipped: [elsewhere], processes: 1 } });
  await g.battle(form);
  assert.deepEqual(g.log.filter((c) => c[1] === elsewhere), []);
  assert.deepEqual(g.log.find((c) => c[0] === "end")[1], [90]);
  assert.equal(g.infos.length, 1);
  assert.match(g.infos[0], new RegExp(`Skipped 1 board another window owns: ${elsewhere.replace(/[\\.]/g, "\\$&")}\\.$`));
  assert.deepEqual([gOther.tasks.find((t) => t.id === "m1").paused, gOther.tasks.find((t) => t.id === "q1").held], [undefined, true]);
});

test("a failing stop does not block the battle; nothing calls finish, cancel or remove, and no card is set Done, cancelled or merged", async () => {
  const f = fixture({ stopError: (t) => (t.id === "a1" ? "its terminal is gone" : undefined) });
  seed(f.board);
  f.board.tasks.push({ id: "k1", title: "checking", status: "review", createdAt: "", checks: { status: "running" } });
  await f.battle({ ...form, autoTitle: true, autoRule: true });
  assert.equal(f.added.length, 4);
  assert.deepEqual(f.starts, f.tasks.slice(-4).map((t) => t.id)); // the four battle cards, each started
  assert.deepEqual(f.log.filter((c) => c[0] === "checks.stop").map((c) => c[2]), ["k1"]);
  // The Done when is written during the wait, before anything is stopped; then the one report.
  assert.deepEqual(f.infos, ["Entomatical: Fable 5.2 wrote when the task is done at high effort.",
    'Entomatical: Battle Royale cleared the arena. Stopped 3 cards, 1 run; ended 0 leftover processes. Stopped cards wait in Review; Resume continues each. Failed: "alone": its terminal is gone.']);
  assert.deepEqual(f.forbidden, []);
  for (const [kind, , , patch] of f.log) if (kind === "update") assert.ok(!("cancelled" in patch) && !("merged" in patch) && patch.status !== "done", JSON.stringify(patch));
  assert.deepEqual(f.errors, []);
});
