// src/startup.ts: a reload shows the board, keeps the right sidebar shut and stops Codex opening its sidebar on startup.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");

function load() {
  const filename = require.resolve("../out/startup.js");
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.require = name => (name === "vscode" ? {} : require(name));
  mod._compile(fs.readFileSync(filename, "utf8"), filename);
  return mod.exports.quietStartup;
}

function fakeApi({ quiet = true, globalValue, workspaceValue, failCommand } = {}) {
  const commands = [], updates = [];
  const api = {
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    workspace: { getConfiguration: section => ({
      get: (key, fallback) => (section === "entomatical" && key === "quietStartup" ? quiet : fallback),
      inspect: () => ({ globalValue, workspaceValue }),
      update: async (key, value, target) => { updates.push([section, key, value, target]); },
    }) },
    commands: { executeCommand: async command => { commands.push(command); if (command === failCommand) throw new Error("no such command"); } },
  };
  return { api, commands, updates };
}

test("closes the right sidebar, shows the board and turns off Codex's openOnStartup where it is on", async () => {
  const { api, commands, updates } = fakeApi({ globalValue: true, workspaceValue: true });
  await load()(api);
  assert.deepEqual(commands, ["workbench.action.closeAuxiliaryBar", "entomatical.board.focus"]);
  assert.deepEqual(updates, [["chatgpt", "openOnStartup", false, 1], ["chatgpt", "openOnStartup", false, 2]]);
});

test("leaves Codex's setting alone when it is not on", async () => {
  const { api, updates, commands } = fakeApi({ globalValue: false });
  await load()(api);
  assert.deepEqual(updates, []);
  assert.equal(commands.length, 2);
});

test("a missing command does not stop the board being shown", async () => {
  const { api, commands } = fakeApi({ failCommand: "workbench.action.closeAuxiliaryBar" });
  await load()(api);
  assert.deepEqual(commands, ["workbench.action.closeAuxiliaryBar", "entomatical.board.focus"]);
});

test("entomatical.quietStartup off does nothing", async () => {
  const { api, commands, updates } = fakeApi({ quiet: false, globalValue: true });
  await load()(api);
  assert.deepEqual([commands, updates], [[], []]);
});
