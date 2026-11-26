// Rename, 17 November 2026: a card's terminal tab is "En <id>" (Entomatical); one opened before the rename as "AB <id>" is still
// the card's terminal, so a card running through the upgrade is found, not started twice (F43's note in docs/parity/FEATURES.md).
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const vscode = { EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} }, ThemeIcon: class {}, window: { terminals: [] } };
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? vscode : load.call(this, request, ...rest); };
const { terminalName, isCardTerminal } = require("../out/board.js");

test("a card's terminal is named En <id>, and its AB <id> terminal from before the rename still counts as its own", () => {
  const card = { id: "a1b2c3" };
  assert.equal(terminalName(card), "En a1b2c3");
  assert.equal(isCardTerminal("En a1b2c3", card), true);
  assert.equal(isCardTerminal("AB a1b2c3", card), true);
  assert.equal(isCardTerminal("En ffffff", card), false);
  assert.equal(isCardTerminal("AB ffffff", card), false);
  assert.equal(isCardTerminal("a1b2c3", card), false);
});
