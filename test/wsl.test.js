const test = require("node:test");
const assert = require("node:assert/strict");
const { toWsl, fromWsl, wslCommand, wslEnv, WSL_CODEX_SCRIPT } = require("../out/wsl.js");

test("Codex in WSL runs in a memory-capped scope that keeps Codex alive when a command it ran is killed (8 November 2026)", () => {
  // Checked live through wsl.exe on 8 November 2026: the scope's memory.max is 33% of the VM, its slice's 85%, and taskkill /T on
  // wsl.exe still ends the Linux process. Here: the script keeps those limits and its plain fallback when systemd is not running.
  assert.match(WSL_CODEX_SCRIPT, /systemd-run --user --scope --quiet --collect --slice=entomatical-codex\.slice -p MemoryMax=33% -p MemorySwapMax=2G -p OOMPolicy=continue -- codex "\$@"/);
  assert.match(WSL_CODEX_SCRIPT, /set-property --runtime entomatical-codex\.slice MemoryMax=85%/);
  assert.match(WSL_CODEX_SCRIPT, /\/systemd\/private" \] && command -v systemd-run/);
  assert.match(WSL_CODEX_SCRIPT, /; fi; exec codex "\$@"$/);
});

test("Windows and WSL paths convert both ways (F61)", () => {
  assert.equal(toWsl("C:\\Users\\example\\Dev Stuff\\a.js"), "/mnt/c/Users/example/Dev Stuff/a.js");
  assert.equal(toWsl("C:/Users/example"), "/mnt/c/Users/example");
  assert.equal(toWsl("D:\\"), "/mnt/d");
  assert.equal(toWsl("\\\\wsl.localhost\\Ubuntu\\home\\example\\.codex"), "/home/example/.codex");
  assert.equal(toWsl("\\\\wsl$\\Ubuntu\\home"), "/home");
  assert.equal(toWsl("/already/linux"), "/already/linux");
  assert.equal(fromWsl("/mnt/c/Users/example/x y", "Ubuntu"), "C:\\Users\\example\\x y");
  assert.equal(fromWsl("/home/example/.codex/sessions/r.jsonl", "Ubuntu"), "\\\\wsl.localhost\\Ubuntu\\home\\example\\.codex\\sessions\\r.jsonl");
  assert.equal(fromWsl("relative", "Ubuntu"), "relative");
});

test("a path for another WSL distribution is rejected before launch or conversion", () => {
  const wrong = "\\\\wsl.localhost\\Debian\\home\\example\\task";
  assert.throws(() => toWsl(wrong, "Ubuntu"), /Debian.*Ubuntu/);
  assert.throws(() => wslCommand({ distro: "Ubuntu" }, ["app-server"], wrong), /Debian.*Ubuntu/);
  assert.equal(toWsl("\\\\wsl$\\UBUNTU\\home\\example", "Ubuntu"), "/home/example");
});

test("Codex in WSL runs through wsl.exe with a login shell, and ENTOMATICAL_EVENTS crosses as a path (F61)", () => {
  assert.deepEqual(wslCommand({ distro: "Ubuntu" }, ["exec", "-"], "C:\\wt"),
    { file: "wsl.exe", args: ["-d", "Ubuntu", "--cd", "C:\\wt", "--exec", "/bin/bash", "-lc", WSL_CODEX_SCRIPT, "codex", "exec", "-"] });
  assert.deepEqual(wslCommand({ distro: "Ubuntu" }, ["login"]).args.slice(0, 3), ["-d", "Ubuntu", "--exec"]);
  assert.equal(wslEnv({ ENTOMATICAL_EVENTS: "C:\\e.jsonl" }, ["ENTOMATICAL_EVENTS"]).WSLENV, "ENTOMATICAL_EVENTS/p");
  assert.equal(wslEnv({ ENTOMATICAL_EVENTS: "C:\\e", WSLENV: "FOO/u:ENTOMATICAL_EVENTS" }, ["ENTOMATICAL_EVENTS"]).WSLENV, "FOO/u:ENTOMATICAL_EVENTS/p");
  assert.equal(wslEnv({}, ["ENTOMATICAL_EVENTS"]).WSLENV, "");
});
