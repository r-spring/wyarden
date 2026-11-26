// Makes test/fake-codex.js the Codex binary on both systems. Linux runs it through its #! line. Windows cannot start a script
// directly, so the binary becomes node itself, which runs `app-server` (its first argument) from the working folder: a copy of
// the fake under that name goes in a scratch folder, and the test works from there until done().
const fs = require("fs");
const os = require("os");
const path = require("path");
const fake = path.join(__dirname, "fake-codex.js");

function useFakeCodex(codex) {
  if (process.platform !== "win32") {
    // A Windows checkout read from WSL has CRLF (including the shebang). Run a normalized scratch copy, never chmod the source.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-fake-codex-"));
    const file = path.join(dir, "codex");
    fs.writeFileSync(file, fs.readFileSync(fake, "utf8").replace(/\r\n/g, "\n"), { mode: 0o755 });
    codex.setCodexBinary(file);
    return { file, done() { fs.rmSync(dir, { recursive: true, force: true }); } };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-fake-codex-"));
  fs.copyFileSync(fake, path.join(dir, "app-server"));
  scratch.push(dir);
  const cwd = process.cwd();
  process.chdir(dir);
  codex.setCodexBinary(process.execPath);
  return { file: process.execPath, done() { process.chdir(cwd); } };
}

// A fake that was just killed still holds its working folder for a moment on Windows, so the folders go when the test process ends.
const scratch = [];
process.on("exit", () => { for (const dir of scratch) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still busy: a temp folder */ } });

module.exports = { useFakeCodex };
