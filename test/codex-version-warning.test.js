// noteCodexVersion in src/extension.ts (F61): when the Codex extension runs its bundled codex and Entomatical another version,
// the warning's "Set chatgpt.cliExecutable" button writes the user setting, so both run the same Codex.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");

const OURS = "C:\\Users\\me\\.codex\\packages\\app-server-daemon\\current\\bin\\codex.exe";
const WARNING = `Entomatical: Codex tasks run codex-cli 0.167.2 (${OURS}), but the Codex extension runs its bundled codex-cli 0.169.0-alpha.11.1. ` +
  `Set chatgpt.cliExecutable to ${OURS} so both run the same Codex.`;

/** out/extension.js with a stand-in vscode and ./codex. `answer` is the button pressed on the warning. */
function load({ answer, theirs = "codex-cli 0.169.0-alpha.11.1", missingVersion, bundled = true, wsl, update }) {
  const seen = { warnings: [], errors: [], updates: [] };
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    extensions: { getExtension: (id) => (id === "openai.chatgpt" ? { extensionPath: "ext" } : undefined) },
    window: {
      showWarningMessage: async (message, ...buttons) => { seen.warnings.push({ message, buttons }); return answer; },
      showErrorMessage: async (message) => { seen.errors.push(message); },
    },
    workspace: { getConfiguration: (section) => ({ update: update ?? (async (key, value, target) => { seen.updates.push({ section, key, value, target }); }) }) },
  };
  const codex = {
    codexCommand: (args) => ({ file: OURS, args }),
    codexVersion: async (file) => {
      if (file === missingVersion) return undefined;
      return file === OURS ? "codex-cli 0.167.2" : theirs;
    },
    codexTextPath: () => OURS,
    codexWsl: () => wsl,
    bundledCodex: (root) => (root && bundled ? "bundled" : undefined),
  };
  const filename = require.resolve("../out/extension.js"), extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = (name) => (name === "vscode" ? vscode : name === "./codex" ? codex : name === "./profiles" ? require("../out/profiles.js") : name.startsWith("./") ? {} : require(name));
  extension._compile(fs.readFileSync(filename, "utf8"), filename);
  return { note: extension.exports.noteCodexVersion, seen };
}

test("F61: the bundled-Codex warning's button sets chatgpt.cliExecutable in the user settings", async () => {
  const { note, seen } = load({ answer: "Set chatgpt.cliExecutable" });
  await note("codexPath", true);
  assert.deepEqual(seen.warnings, [{ message: WARNING, buttons: ["Set chatgpt.cliExecutable"] }]);
  assert.deepEqual(seen.updates, [{ section: "chatgpt", key: "cliExecutable", value: OURS, target: 1 }]);
  assert.deepEqual(seen.errors, []);
});

test("F61: the warning dismissed changes no setting", async () => {
  const { note, seen } = load({ answer: undefined });
  await note("PATH", true);
  assert.equal(seen.warnings.length, 1);
  assert.deepEqual(seen.updates, []);
});

test("F61: no warning when chatgpt.cliExecutable is set, the versions match, or Codex runs in WSL", async () => {
  for (const [options, unset] of [[{}, false], [{ theirs: "codex-cli 0.167.2" }, true], [{ wsl: { distro: "Ubuntu" } }, true]]) {
    const { note, seen } = load({ answer: "Set chatgpt.cliExecutable", ...options });
    await note("PATH", unset);
    assert.deepEqual([seen.warnings, seen.updates], [[], []]);
  }
});

test("F61: a missing bundled executable or an unknown CLI version leaves the setting alone", async () => {
  for (const options of [{ bundled: false }, { missingVersion: OURS }, { missingVersion: "bundled" }]) {
    const { note, seen } = load({ answer: "Set chatgpt.cliExecutable", ...options });
    await note("PATH", true);
    assert.deepEqual(seen, { warnings: [], errors: [], updates: [] });
  }
});

test("F61: a setting that cannot be written says why", async () => {
  const { note, seen } = load({ answer: "Set chatgpt.cliExecutable", update: async () => { throw new Error("Unable to write into user settings."); } });
  await note("PATH", true);
  assert.deepEqual(seen.errors, ["Entomatical: chatgpt.cliExecutable was not set: Unable to write into user settings."]);
});
