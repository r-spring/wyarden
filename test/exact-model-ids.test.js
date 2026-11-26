// Exact model ids on every launch path (the user, 17 November 2026: "All models from all providers must be called by their exact model
// names so there is never a mixup for any reason."). The board's lists and stored cards keep short names; what reaches a CLI or an
// ACP session is an exact id, resolved at launch from the provider's own list, or the start is refused. Other files check the rest:
// acp-board.test.js (Grok and Antigravity terminals), acp-unattended.test.js (unattended ACP), acp-helpers.test.js (ACP helpers),
// headless-codex.test.js (Codex app-server), claude-model-ids.test.js (Claude), models.test.js (isExactModel). No CLI runs here.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

class EventEmitter {
  listeners = [];
  event = (l) => (this.listeners.push(l), { dispose() {} });
  fire(e) { for (const l of this.listeners) l(e); }
  dispose() {}
}
const vscode = { EventEmitter, ThemeIcon: class {}, commands: { executeCommand: async () => {} }, workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
  window: { terminals: [], onDidCloseTerminal: () => ({ dispose() {} }), showWarningMessage: async () => undefined, createTerminal: () => ({ show() {}, dispose() {}, sendText() {} }) } };
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { Board } = require("../out/board.js");
const { codexArgs, codexDefaultModel } = require("../out/codex.js");
const { acpModelChoice, parseGrokModels, grokArgs } = require("../out/acp.js");

const made = [], boards = [];
test.after(() => { for (const b of boards) b.dispose(); for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
function codexBoard() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ab-exact-ids-")); made.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const board = new Board(repo, path.join(repo, "hook.js"), undefined, false); boards.push(board);
  board.accountList = () => [{ name: "Codex · t@t", provider: "codex" }, { name: "acct", configDir: "" }];
  board.accountFolderList = () => [];
  board.tick(); // this window owns the board
  return board;
}

test("Codex: -m is always an exact id; a card on Default model runs the id model/list marks as default, or does not start", () => {
  assert.deepEqual(codexArgs({ model: "gpt-6.2-sol", prompt: "Go" }).slice(0, 2), ["-m", "gpt-6.2-sol"]);
  assert.throws(() => codexArgs({ model: "sol", prompt: "Go" }), /Codex would be handed "sol", not an exact model id/);
  assert.equal(codexDefaultModel([{ model: "gpt-6.1-sol", efforts: [] }, { model: "gpt-6.2-sol", efforts: [], isDefault: true }]), "gpt-6.2-sol");
  assert.equal(codexDefaultModel([{ model: "gpt-6.1-sol", efforts: [] }]), undefined);

  const board = codexBoard();
  let ids = ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-sol"], fallback = "gpt-6.2-sol";
  board.codexModelIds = () => ids;
  board.codexDefaultId = () => fallback;
  const argv = (task) => board.codexArgsFor(task, false);
  const plain = board.add("Plain", "Go", "Codex · t@t");
  assert.equal(plain.model, undefined, "the card keeps Default model");
  assert.deepEqual(argv(plain).slice(0, 2), ["-m", "gpt-6.2-sol"], "Default model is sent as Codex's own default id");
  const sol = board.add("Sol", "Go", "Codex · t@t", undefined, "sol");
  assert.equal(sol.model, "sol", "the card keeps the short name");
  assert.deepEqual(argv(sol).slice(0, 2), ["-m", "gpt-6.2-sol"], "the short name is sent as the newest listed id");
  const old = board.add("Old", "Go", "Codex · t@t", undefined, "gpt-6.1-sol");
  assert.deepEqual(argv(old).slice(0, 2), ["-m", "gpt-6.1-sol"], "F123: an older full id Codex still lists runs as picked");
  for (const task of [plain, sol, old]) assert.ok(!argv(task).includes("sol"), "the short name never reaches the CLI");
  assert.equal(plain.sentModel, "gpt-6.2-sol", "the card records the id it was handed");
  assert.equal(board.modelOf(plain), "gpt-6.2-sol", "Session details: Default model → gpt-6.2-sol");
  // A resumed thread keeps the model it ran on, even after Codex's newest or default moved.
  ids = ["gpt-6.3-sol", ...ids]; fallback = "gpt-6.3-sol";
  board.update(sol, { sessionId: "thread-1" });
  assert.deepEqual(board.codexArgsFor(sol, true).slice(0, 3), ["resume", "-m", "gpt-6.2-sol"]);
  assert.deepEqual(argv(board.add("New sol", "Go", "Codex · t@t", undefined, "sol")).slice(0, 2), ["-m", "gpt-6.3-sol"], "a new start runs the newest");
  const claude = board.add("Claude", "Go", "acct", undefined, "haiku");
  assert.equal(board.modelOf(claude), "claude-haiku-5-5", "Session details name the full Claude id");
  ids = ids.slice(1);
  fallback = undefined;
  assert.throws(() => argv(plain), /This Codex card uses Codex's default model, and Codex has not said which model that is/);
  ids = [];
  assert.throws(() => argv(sol), /This Codex card names sol, and Codex has not listed its models yet, so its exact id is unknown\./);
  assert.deepEqual(argv({ ...sol, model: "gpt-6.1-sol" }).slice(0, 2), ["-m", "gpt-6.1-sol"], "a full id (an older card's) passes before any list");
});

test("Grok: `grok models` names the default; --model takes only an exact id", () => {
  // grok 1.0.77's `grok models`, 17 November 2026 (this machine, signed out).
  const text = "You are not authenticated.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n  - grok-4.5\n";
  assert.deepEqual(parseGrokModels(text), { ids: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"], default: "grok-4.7" });
  assert.deepEqual(parseGrokModels("Default model: grok-5\n"), { ids: [], default: "grok-5" });
  assert.deepEqual(parseGrokModels("error: not found\n"), { ids: [], default: undefined });
  assert.deepEqual(parseGrokModels("  * grok-5 (default) Grok 5, fastest\n  - grok-4.7   Grok 4.7\n  * Note: sign in first\n"), { ids: ["grok-5", "grok-4.7"], default: "grok-5" }, "text after an id is not part of it");
  assert.deepEqual(grokArgs({ model: "grok-4.7", permission: "bypass" }), ["--model=grok-4.7", "--permission-mode=bypassPermissions"]);
  assert.deepEqual(grokArgs({ permission: "ask" }), ["--permission-mode=default"], "board.add's check of a permission alone");
  assert.throws(() => grokArgs({ model: "grok" }), /Grok would be handed "grok", not an exact model id/);
});

test("ACP: the model selected on a session is a named model's newest advertised id, or the session's own exact id; never an alias", () => {
  const option = (currentValue, values) => [{ id: "agent_model", name: "Model", category: "model", currentValue, values: values.map((value) => ({ value, name: value })) }];
  const grok = option("grok-4.7", ["grok-4.7", "grok-4.7-build-fast", "grok-4.6"]);
  assert.equal(acpModelChoice("grok", grok, undefined, "Grok · Work").value, "grok-4.7", "no model: the current one, by its exact id");
  assert.equal(acpModelChoice("grok", grok, "grok", "Grok · Work").value, "grok-4.7", "a short name: the newest of its family");
  assert.equal(acpModelChoice("grok", grok, "build", "Grok · Work").value, "grok-4.7-build-fast");
  assert.equal(acpModelChoice("grok", grok, "grok-4.6", "Grok · Work").value, "grok-4.6", "F123: an advertised exact id runs as picked");
  assert.equal(acpModelChoice("grok", grok, "grok", "Grok · Work").option.id, "agent_model");
  assert.throws(() => acpModelChoice("grok", option("auto", ["auto", "grok-4.7"]), undefined, "Grok · Work"), /Grok · Work would run "auto", which is not an exact model id, so nothing was started\. Add a new card with one of its exact ids, or move this card to another account: grok-4.7./);
  assert.throws(() => acpModelChoice("grok", grok, "huge", "Grok · Work"), /Grok · Work does not advertise model huge\. It offers: grok-4\.7, grok-4\.7-build-fast, grok-4\.6\./);
  assert.throws(() => acpModelChoice("grok", option(undefined, ["grok-4.7"]), undefined, "Grok · Work"), /Grok · Work does not say which model it is on, so the exact model is unknown\./);
  assert.throws(() => acpModelChoice("antigravity", [], undefined, "Antigravity"), /Antigravity advertises no model choice, so the exact model it would run is unknown and nothing was started\./);
});
