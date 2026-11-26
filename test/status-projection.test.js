// The status projection (status.jsonl, F70) a save writes looks only at the cards whose board inputs changed (Board.statusInputs);
// its output must be byte-identical to the full pass every card used to get. Random edits, each compared with that full pass.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

class EventEmitter { listeners = []; event = (l) => (this.listeners.push(l), { dispose() {} }); fire(e) { for (const l of this.listeners) l(e); } dispose() {} }
const vscode = { EventEmitter, ThemeIcon: class {}, TabInputCustom: class {}, ViewColumn: { Beside: -2 }, commands: { executeCommand: async () => {} },
  Uri: { from: (p) => p, file: (p) => ({ fsPath: p }) }, workspace: { openTextDocument: async () => ({}), getConfiguration: () => ({ get: (_k, d) => d }) },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined, showInformationMessage: async () => undefined, createTerminal: () => { throw new Error("no sessions"); } } };
const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-proj-home-"));
process.env.HOME = process.env.USERPROFILE = home;
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board } = require("../out/board.js");
const { CHANGE_KEY } = require("../out/status-line.js");

test.after(() => fs.rmSync(home, { recursive: true, force: true }));
/** A throwaway repository and a board that owns it (no 3 s poll). */
function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-proj-"));
  const sh = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  sh("init", "-q", "-b", "main"); sh("config", "user.email", "t@t"); sh("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "x\n"); sh("add", "."); sh("commit", "-qm", "init");
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false);
  t.after(() => { board.dispose(); fs.rmSync(repo, { recursive: true, force: true }); });
  board.accountList = () => [{ name: "acct", configDir: path.join(home, "acct") }];
  board.accountFolderList = () => [path.join(home, "acct")];
  board.tick();
  return board;
}
const lastLine = (board, id) => fs.readFileSync(board.statusFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).findLast((r) => r.id === id);

test("a save's status projection (changed cards only) is byte-identical to a full pass after random edits", (t) => {
  const realNow = Date.now, NOW = realNow();
  Date.now = () => NOW; // one clock for both passes, so at, quiet and the line's age compare byte for byte
  t.after(() => { Date.now = realNow; });
  const board = fixture(t);
  const cards = Array.from({ length: 40 }, (_, i) => board.add(`card ${i}`, "p", "acct"));
  board.publishStatus(true);

  // The reference: what the full pass (every card's record, before this change) appends, kept apart with its own change keys.
  const ref = new Map(fs.readFileSync(board.statusFile, "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return [r.id, CHANGE_KEY(r)]; }));
  const fullPass = () => {
    let out = "";
    for (const c of board.tasks) { const r = board.statusOf(c, NOW), k = CHANGE_KEY(r); if (ref.get(c.id) === k) continue; ref.set(c.id, k); out += JSON.stringify(r) + "\n"; }
    return out;
  };
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const pick = (xs) => xs[rand(xs.length)];
  let looked = 0; // lastReply runs twice per record built (change key, then the record); update may read it once more itself
  const lastReply = board.lastReply.bind(board);
  board.lastReply = (c) => { looked++; return lastReply(c); };
  const edits = [
    (c) => board.update(c, { status: pick(["running", "review", "needs-input", "done"]) }),
    (c) => board.update(c, { title: `renamed ${rand(1000)}` }),
    (c) => board.update(c, { interrupted: !c.interrupted }),
    (c) => board.update(c, { headless: !c.headless, paused: !c.paused }),
    (c) => board.update(c, { asks: !c.asks }),
    (c) => board.update(c, { cancelled: !c.cancelled }),
    (c) => board.update(c, { completion: { commands: ["npm test"] }, checks: pick([undefined, { status: "running" }, { status: "complete" }, { status: "error", error: "boom" }]) }),
    (c) => board.update(c, { waitsForReset: { at: NOW + 3_600_000 } }),
    (c) => board.update(c, { prompt: `edited ${rand(1000)}` }), // a change that no record shows
  ];
  let written = 0;
  for (let step = 0; step < 300; step++) {
    const c = pick(board.tasks), before = fs.statSync(board.statusFile).size;
    looked = 0;
    if (rand(6) === 0 && ["running", "needs-input"].includes(c.status)) {
      // An events file change is not a save: the watcher's full pass reads it (a new live line).
      fs.mkdirSync(path.dirname(board.eventsFile(c.id)), { recursive: true });
      fs.appendFileSync(board.eventsFile(c.id), JSON.stringify({ t: NOW, hook_event_name: "PostToolUse", tool_name: "Bash", desc: `Bash step ${step}` }) + "\n");
      board.publishStatus();
    } else {
      pick(edits)(c);
      assert.ok(looked <= 4, `step ${step}: a save of one card looked at ${looked} replies (a full pass reads ${board.tasks.length})`);
    }
    const appended = fs.readFileSync(board.statusFile, "utf8").slice(before);
    assert.equal(appended, fullPass(), `step ${step}`);
    written += appended ? 1 : 0;
  }
  assert.ok(written > 100, `most edits wrote a record (${written})`);
  // The file's last line per card equals a rewrite of every card.
  const last = new Map(fs.readFileSync(board.statusFile, "utf8").split("\n").filter(Boolean).map((l) => [JSON.parse(l).id, l]));
  board.publishStatus(true);
  assert.deepEqual(fs.readFileSync(board.statusFile, "utf8").split("\n").filter(Boolean), cards.map((c) => last.get(c.id)));
});

test("a save that changes only a child still rewrites its orchestrator's checks (another card's input)", (t) => {
  const board = fixture(t);
  const root = board.add("root", "p", "acct");
  board.update(root, { orchestrator: { caps: {}, opened: 1 }, completion: { commands: ["npm test"] }, checks: { status: "complete" }, status: "review" });
  const child = board.add("child", "p", "acct");
  board.update(child, { openedBy: root.id, watchedBy: "ffffff", status: "running" }); // its settle notice goes elsewhere, so only checks move
  board.publishStatus(true);
  assert.equal(lastLine(board, root.id).checks, "pending", "its run still has an open card");
  board.update(child, { status: "done" }); // the root card itself is not changed by this save
  assert.equal(board.pendingNotices.get(root.id)?.size, undefined);
  assert.equal(lastLine(board, root.id).checks, "passed");
  assert.equal(lastLine(board, root.id).checks, board.statusOf(root).checks);
});
