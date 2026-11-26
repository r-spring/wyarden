// F99 and F92 (the user, 17 November 2026): Claude Code is handed full model ids, never the aliases the board's lists show. It also keeps
// plan mode on Haiku: Claude Code plans on Sonnet for the alias `haiku` and stays on Haiku for the full id
// (docs/evidence/parity-win-2026-11-16/F99-plan-model.md, runs a, b, f). The settings file every card launch path passes (--settings:
// terminal, panel, headless) holds the full id; the card itself keeps its short name. Helper --model: account-fallback.test.js;
// Finish's resolver: action-picks.test.js.
// Fixtures only: no model, no CLI, no VS Code.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

class EventEmitter {
  listeners = [];
  event = (l) => (this.listeners.push(l), { dispose() {} });
  fire(e) { for (const l of this.listeners) l(e); }
  dispose() {}
}
const vscode = { EventEmitter, ThemeIcon: class {}, commands: { executeCommand: async () => {} },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined, createTerminal: () => ({ show() {}, dispose() {}, sendText() {} }) } };
const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-haiku-home-"));
process.env.HOME = process.env.USERPROFILE = home;
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board, MODELS } = require("../out/board.js");
const { CLAUDE_MODEL_IDS, CLAUDE_FAMILIES, claudeModelId } = require("../out/models.js");

const made = [], boards = [];
test.after(() => { for (const b of boards) b.dispose(); for (const d of made) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
const open = () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-haiku-")); made.push(repo);
  const b = new Board(repo, path.join(repo, "hook.js"), path.join(repo, "hookdir")); b.startNudgeMs = 600_000; boards.push(b); return b;
};
const settings = (board, task) => { board.writeHooks(task); return JSON.parse(fs.readFileSync(board.hooksFile(task.id), "utf8")); };

test("F99 one table maps every Claude list name to its full id; other names pass as they are", () => {
  assert.deepEqual(CLAUDE_MODEL_IDS, { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", fable: "claude-fable-5-2" });
  assert.deepEqual(Object.keys(CLAUDE_MODEL_IDS).sort(), [...CLAUDE_FAMILIES].sort()); // every list entry has an id
  assert.deepEqual(Object.keys(CLAUDE_MODEL_IDS).sort(), [...MODELS].sort()); // and every name the board's dropdown offers
  for (const [name, id] of Object.entries(CLAUDE_MODEL_IDS)) assert.equal(claudeModelId(name), id);
  for (const m of ["claude-opus-5-5", "sol", "toString", undefined]) assert.equal(claudeModelId(m), m);
});

test("F99 a Claude card on haiku, and a Plan first one, hand Claude Code claude-haiku-5-5; the card keeps haiku", () => {
  const board = open();
  const plain = board.add("h", "do it", undefined, undefined, "haiku", "low");
  const s = settings(board, plain);
  assert.equal(s.model, "claude-haiku-5-5");
  assert.equal(plain.model, "haiku");
  const plan = board.add("p", "plan it", undefined, undefined, "haiku", "low", undefined, { planFirst: true });
  assert.equal(plan.planFirst, true);
  const ps = settings(board, plan);
  assert.deepEqual([ps.model, ps.permissions], ["claude-haiku-5-5", { defaultMode: "plan" }]);
  assert.equal(plan.model, "haiku");
  assert.equal(JSON.parse(fs.readFileSync(board.file, "utf8")).find((t) => t.id === plan.id).model, "haiku"); // saved as picked
  // After the plan turn (planFirst taken out) the session keeps the full id, so a later switch into plan mode stays on Haiku too.
  plan.planFirst = undefined;
  assert.equal(settings(board, plan).model, "claude-haiku-5-5");
});

test("F99 every Claude model goes in the settings file as its full id; no model and other runtimes are left as they are", () => {
  const board = open();
  for (const m of ["opus", "sonnet", "fable"]) {
    const card = board.add(m, "x", undefined, undefined, m);
    assert.equal(settings(board, card).model, CLAUDE_MODEL_IDS[m]);
    assert.equal(card.model, m);
  }
  assert.equal(settings(board, board.add("none", "x")).model, undefined);
  const grok = board.add("g", "x", undefined, undefined, "haiku");
  grok.provider = "grok";
  assert.equal(settings(board, grok).model, "haiku");
});
