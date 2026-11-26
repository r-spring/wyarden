// The read-only project context sent with a refinement (src/refine-context.ts), so the helper can answer what the folder
// already makes clear instead of asking.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { refinementContext, CONTEXT_LIMIT } = require("../out/refine-context");

function folder(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-refine-ctx-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test("refinement context carries CLAUDE.md, README.md and the scripts, and no task list (25 November 2026)", () => {
  const dir = folder({ "CLAUDE.md": "﻿# Rules\nUse PowerShell.", "README.md": "# Widget\nBuilds widgets.", "package.json": JSON.stringify({ name: "widget", scripts: { test: "node --test" } }) });
  try {
    const text = refinementContext(dir);
    assert.match(text, /CLAUDE\.md \(opening\):\n# Rules\nUse PowerShell\./);
    assert.match(text, /README\.md \(opening\):\n# Widget/);
    assert.match(text, /"scripts":\{"test":"node --test"\}/);
    assert.doesNotMatch(text, /Open tasks/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("refinement context is bounded and survives a folder with no notes", () => {
  const dir = folder({ "README.md": "x".repeat(50_000) });
  try {
    const text = refinementContext(dir);
    assert.ok(text.length <= CONTEXT_LIMIT);
    assert.match(text, /\[truncated\]/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const empty = folder({});
  try { assert.match(refinementContext(empty), /^Repository: /); } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test("a big package.json no longer pushes CLAUDE.md and README.md out of the context", () => {
  const deps = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`some-long-dependency-name-${i}`, "^1.2.3"]));
  const dir = folder({ "CLAUDE.md": "# Rules\nKeep it small.", "README.md": "# Big\nA big project.", "package.json": JSON.stringify({ name: "big", dependencies: deps, scripts: { test: "node --test" } }) });
  try {
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Rules\nKeep it small.\n" + "r".repeat(3000)); // notes at their full 1,500
    fs.writeFileSync(path.join(dir, "README.md"), "# Big\nA big project.\n" + "b".repeat(3000));
    const text = refinementContext(dir);
    assert.ok(text.length <= CONTEXT_LIMIT);
    assert.match(text, /"scripts":\{"test":"node --test"\}/); // the scripts come first, so the cut leaves them whole
    assert.doesNotMatch(text, /some-long-dependency-name-\d+\n\[truncated\]/); // cut at an entry boundary
    assert.match(text, /CLAUDE\.md \(opening\):\n# Rules/);
    assert.match(text, /README\.md \(opening\):\n# Big/);
    assert.match(text, /\[truncated\]/); // the inventory gave way
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a note file that is a symlink out of the repo or a FIFO is not read", { timeout: 5000, skip: process.platform === "win32" && "FIFOs do not exist on Windows; the symlink test below runs there" }, () => {
  const dir = folder({});
  const secret = fs.mkdtempSync(path.join(os.tmpdir(), "ab-secret-"));
  try {
    fs.writeFileSync(path.join(secret, "token.json"), "SECRET-TOKEN");
    fs.symlinkSync(path.join(secret, "token.json"), path.join(dir, "README.md"));
    require("node:child_process").execFileSync("mkfifo", [path.join(dir, "CLAUDE.md")]); // would block a plain read
    const text = refinementContext(dir);
    assert.doesNotMatch(text, /SECRET-TOKEN|README\.md|CLAUDE\.md/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(secret, { recursive: true, force: true }); }
});

test("a note file linked to another file inside the repo is read; one linked outside is not (CLAUDE.md -> AGENTS.md)", (t) => {
  const dir = folder({ "AGENTS.md": "# Shared rules\nRun npm test." });
  const secret = fs.mkdtempSync(path.join(os.tmpdir(), "ab-secret-"));
  try {
    fs.writeFileSync(path.join(secret, "token.json"), "SECRET-TOKEN");
    try {
      fs.symlinkSync(path.join(dir, "AGENTS.md"), path.join(dir, "CLAUDE.md"), "file");
      fs.symlinkSync(path.join(secret, "token.json"), path.join(dir, "README.md"), "file");
    } catch (e) { if (e.code === "EPERM") return t.skip("creating symlinks needs Developer Mode on Windows"); throw e; }
    const text = refinementContext(dir);
    assert.match(text, /CLAUDE\.md \(opening\):\n# Shared rules/);
    assert.doesNotMatch(text, /SECRET-TOKEN/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(secret, { recursive: true, force: true }); }
});
