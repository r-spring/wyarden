// activate() in src/extension.ts: a speech-settings migration that fails (config.update rejects when the user settings.json has an
// error or cannot be written) must warn and carry on, not stop the board from registering its view.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");

test("a failed speech-settings migration warns and activation continues", async () => {
  const warnings = [];
  let continued = false;
  const stop = new Error("stop here: activation got past the migration");
  const vscode = { window: { showWarningMessage: (m) => { warnings.push(m); return Promise.resolve(undefined); } } };
  const filename = require.resolve("../out/extension.js"), extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = (name) => {
    if (name === "vscode") return vscode;
    if (name === "./speech-settings") return {
      migrateSpeechSettings: async () => { throw new Error("Unable to write into user settings."); },
      registerSpeechSettings: () => { continued = true; throw stop; }, // the next step; the test ends here
    };
    if (name === "./profiles") return require("../out/profiles.js"); // pure: capability profiles (phase 2)
    if (name.startsWith("./")) return {};
    return require(name);
  };
  extension._compile(fs.readFileSync(filename, "utf8"), filename);
  await assert.rejects(extension.exports.activate({ secrets: {}, subscriptions: [] }), (e) => e === stop);
  assert.equal(continued, true);
  assert.deepEqual(warnings, ["Entomatical: old speech settings were not carried forward: Unable to write into user settings."]);
});
