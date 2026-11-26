// F87: a Grok or Antigravity card terminal fires no hook, and the board does not read its screen (the user, 9 November 2026: "Grok and
// Antigravity can decide for themselves"). The agent ends each turn with `board.js turn-done`, which its first prompt asks for; the
// card moves from Running to Review, not Interrupted, so Finish takes it without a Stop (Windows F93 check, 9 November 2026: the card
// stayed Running at the CLI's prompt until Stop, which read Interrupted). Enter typed in the terminal runs it again. Fake PTY; no CLI runs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
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
const { Board, cardTerminalTurnNote, CARD_TERMINAL_RESUME_NOTE } = require("../out/board.js");
const CARD_TERMINAL_TURN_NOTE = cardTerminalTurnNote(path.join(os.homedir(), ".entomatical", "board.js")); // Board's default boardCli

function fakePty() {
  return { pid: 999, onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; }, write() {}, resize() {}, kill() {} };
}
let nonces = 0;
const ask = (board, by, session, extra = {}) => board.handleRequest({ v: 1, op: "turn-done", by: by.id, session, at: new Date().toISOString(), ...extra }, `n${++nonces}`);

function setup(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-ct-turn-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  t.after(() => { board.dispose(); fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  board.accountList = () => [{ name: "Grok · Work", provider: "grok", configDir: path.join(repo, "grok") },
    { name: "Antigravity", provider: "antigravity", configDir: path.join(repo, "agy") }];
  board.accountFolderList = () => [];
  board.requestRateMs = 0;
  // The terminals' exact ids (17 November 2026): Grok's named default and Antigravity's newest Opus; no CLI is run.
  board.grokModels = async () => ({ ids: ["grok-4.7"], default: "grok-4.7" });
  board.agyModelIds = () => ["claude-opus-5-5"];
  const spawned = [];
  board.cardTerminals.spawn = (file, args, options) => { const pty = fakePty(); spawned.push({ file, args, env: options.env, pty }); return pty; };
  board.tick();
  return { board, spawned };
}

test("turn-done moves the caller's own running Grok or agy card terminal to Review, Finish then has nothing busy, Enter runs it again", async (t) => {
  const { board, spawned } = setup(t);
  const grok = board.add("Grok task", "Reply with the single word OK.", "Grok · Work");
  await board.startCardTerminal(grok);
  assert.equal(grok.status, "running");
  const first = spawned[0];
  assert.equal(first.args.at(-1).endsWith(`\n\n${CARD_TERMINAL_TURN_NOTE}`), true, "the first prompt asks for turn-done");
  assert.match(CARD_TERMINAL_TURN_NOTE, /run: node "[^"~]+[\\/]board\.js" turn-done$/, "an absolute, quoted path: a Windows shell may not expand ~");
  assert.equal(cardTerminalTurnNote("D:\\ext\\tools\\board.js"), 'Entomatical: as the last step of every turn, run: node "D:\\ext\\tools\\board.js" turn-done', "a dev host names its own tools/board.js");
  // What board.js needs is in the terminal's environment, and it is what the board binds.
  assert.equal(first.env.ENTOMATICAL_TASK, grok.id);
  assert.equal(first.env.ENTOMATICAL_REPO, board.repo);
  assert.equal(first.env.ENTOMATICAL_RUNTIME, "grok");
  assert.equal(first.env.ENTOMATICAL_SESSION, grok.boardSessionId);

  // Another card's session cannot report this card's turn.
  const agy = board.add("Agy task", "Say hi.", "Antigravity", undefined, "opus");
  await board.startCardTerminal(agy);
  const agyPrompt = spawned[1].args.at(-1);
  assert.equal(agyPrompt.endsWith(CARD_TERMINAL_TURN_NOTE), true, "Antigravity's first prompt asks for it too");
  assert.match((await ask(board, grok, agy.boardSessionId)).error, /^Not bound/);
  assert.match((await ask(board, grok, null)).error, /^Not bound/);
  assert.equal(grok.status, "running");
  // The verb names no card: a request for another one is refused by the schema.
  assert.match((await ask(board, grok, grok.boardSessionId, { id: agy.id })).error, /Unknown field "id"/);

  const done = await ask(board, grok, grok.boardSessionId);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(grok.status, "review");
  assert.equal(grok.interrupted, undefined, "a finished turn is not Interrupted");
  assert.deepEqual(board.busyWith(grok), [], "Finish takes it without a Stop");
  assert.equal(board.live().includes(grok.id), true, "the terminal stays open at its prompt");
  assert.match((await ask(board, grok, grok.boardSessionId)).error, /turn-done: card \w+ is review, not running/);
  assert.equal(agy.status, "running", "the other card is untouched");

  // the user types a follow-up: keys alone change nothing, Enter starts a turn; a pasted newline is not Enter.
  const generation = board.cardTerminals.attach(grok.id).generation;
  board.cardTerminals.input(grok.id, generation, "more please");
  board.cardTerminals.input(grok.id, generation, "\u001b[200~line one\rline two\u001b[201~");
  assert.equal(grok.status, "review");
  board.cardTerminals.input(grok.id, generation, "\r");
  assert.equal(grok.status, "running", "Running again on a new prompt");
  assert.equal((await ask(board, grok, grok.boardSessionId)).ok, true);
  assert.equal(grok.status, "review");

  // Stop mid-turn is still unfinished work; Resume's prompt carries the line too.
  board.cardTerminals.input(grok.id, generation, "\r");
  assert.equal(grok.status, "running");
  board.stop(grok);
  spawned[0].pty.exit({ exitCode: 1 });
  assert.equal(grok.status, "review");
  assert.equal(grok.interrupted, true);
  assert.match((await ask(board, grok, grok.boardSessionId)).error, /turn-done: card \w+ (has no live terminal|is review)/);
  await board.startCardTerminal(grok, true);
  const resumed = spawned[2].args.at(-1);
  assert.equal(resumed.startsWith(CARD_TERMINAL_RESUME_NOTE), true);
  assert.equal(resumed.endsWith(CARD_TERMINAL_TURN_NOTE), true, "the resume prompt asks for turn-done");
});

test("turn-done is refused for a card that is not a Grok or Antigravity card terminal, and works with the orchestrator off", async (t) => {
  const { board } = setup(t);
  board.orchestratorEnabled = () => false;
  const plain = board.add("Not started", "Wait.", "Grok · Work");
  plain.boardSessionId = "11111111-2222-3333-4444-555555555555";
  assert.match((await ask(board, plain, plain.boardSessionId)).error, /is not a Grok or Antigravity card terminal/);
  const grok = board.add("Grok task", "Go.", "Grok · Work");
  await board.startCardTerminal(grok);
  const done = await ask(board, grok, grok.boardSessionId);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(grok.status, "review");
});

test("F105: Antigravity's first-run color scheme at 31x13 reports one terminal wait without submitting input or ending the turn", async (t) => {
  const { board, spawned } = setup(t);
  const terms = board.cardTerminals;
  // Parse on the test clock, as in the narrow Grok waiting fixture.
  const makeScreen = terms.headless;
  terms.headless = (cols, rows) => {
    const screen = makeScreen(cols, rows);
    screen.options.logLevel = "off";
    screen.write = data => screen._core.writeSync(data);
    return screen;
  };
  const agy = board.add("Color choice", "Reply with ORCHID-1057.", "Antigravity", undefined, "opus", undefined, undefined, { battle: "b4771e00" });
  const grok = board.add("Other provider", "Go.", "Grok · Work");
  await board.startCardTerminal(agy);
  await board.startCardTerminal(grok);
  const [first, other] = spawned.map(s => s.pty);
  const writes = [];
  for (const pty of [first, other]) pty.write = data => writes.push(data);
  for (const card of [agy, grok]) terms.resize(card.id, terms.attach(card.id).generation, 31, 13);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tick = ms => t.mock.timers.tick(ms);
  const waits = card => board.events(card.id).filter(e => e.hook_event_name === "TerminalWaiting").map(e => e.desc);
  const clear = "\x1b[2J\x1b[H";
  const dialog = clear + "Welcome to Antigravity CLI!\r\n\r\nChoose your color scheme:\r\n  terminal\r\n  dark";
  const redraw = (pty, text) => {
    pty.data(text);
    tick(400);
  };
  redraw(other, dialog);
  redraw(first, dialog);
  tick(29_950);
  assert.deepEqual(waits(agy), []);
  // Clear just before the deadline, before the redraw's 400 ms debounce can cancel it.
  first.data("\r\n".repeat(13) + clear);
  assert.match(terms.screen(agy.id).text, /Choose your color scheme:/);
  tick(50);
  assert.deepEqual(waits(agy), []);
  tick(31_000);
  assert.deepEqual(waits(agy), []);
  for (const screen of ["Welcome to Antigravity CLI!\r\nTerms of Service & Data Use\r\nPrevious    Done",
    "Choose your color scheme:\r\n  terminal", "> Welcome to Antigravity CLI!\r\n> Choose your color scheme:"]) {
    redraw(first, clear + screen);
    tick(31_000);
    assert.deepEqual(waits(agy), [], screen);
  }
  redraw(first, dialog);
  tick(15_000);
  redraw(first, dialog);
  tick(15_000);
  assert.deepEqual(waits(agy), ["Waiting at: Choose your color scheme:"]);
  redraw(first, dialog);
  tick(31_000);
  assert.deepEqual(waits(agy), ["Waiting at: Choose your color scheme:"]);
  assert.deepEqual(waits(grok), []);
  assert.deepEqual(writes, []);
  assert.equal(agy.status, "running");
  assert.ok(board.events(agy.id).every(e => e.hook_event_name !== "Stop"));
});
