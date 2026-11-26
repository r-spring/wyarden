const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// selftest.js imports "vscode" (and board.js, which does too), which exists only inside VS Code. Nothing here runs a self-test,
// so an empty stand-in is enough. The home folder points at a throwaway one, as in board.test.js, so loading touches no account folder.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-home-"));
process.env.HOME = process.env.USERPROFILE = home;
const load = Module._load;
Module._load = function (request, ...rest) { return request === "vscode" ? {} : load.call(this, request, ...rest); };
const { approvalPrompt, answerApproval } = require("../out/selftest.js");
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test("the Codex self-test's approval prompt: Linux keeps touch; Windows uses PowerShell's New-Item, as Git's touch.exe crashes in Codex's Windows sandbox; both ask for approval outright", () => {
  const linux = approvalPrompt("linux");
  assert.match(linux, /`touch approval-selftest\.txt`/);
  assert.match(linux, /request approval to run it outside the sandbox/); // without it, Codex in WSL gave up on the refused command (2 November 2026)
  assert.match(linux, /reply DONE\.$/);
  const win = approvalPrompt("win32");
  assert.doesNotMatch(win, /\btouch\b/);
  assert.match(win, /`New-Item -ItemType File approval-selftest\.txt`/);
  assert.match(win, /request approval to run it outside the sandbox/);
  assert.match(win, /reply DONE\.$/);
});

test("the Codex self-test answers an approval prompt: on Windows only after two seconds, as Codex draws its prompt after the PermissionRequest hook and an early y lands in its message box; elsewhere at once", async () => {
  const sent = [];
  const term = { sendText: (text, addNewLine) => sent.push([text, addNewLine]) };
  await answerApproval(term, "linux");
  assert.deepEqual(sent, [["y", false]]);
  sent.length = 0;
  const started = Date.now();
  const answered = answerApproval(term, "win32");
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(sent, [], "nothing typed while Codex may still be drawing its prompt");
  await answered;
  assert.deepEqual(sent, [["y", false]]);
  assert.ok(Date.now() - started >= 1990);
});
