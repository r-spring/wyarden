const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { CardTerminals, argvFits } = require("../out/cardTerminal.js");

function fakePty() {
  const calls = { input: [], resize: [], killed: 0, workerDisposed: 0 };
  return { pid: 123, calls, _agent: { _conoutSocketWorker: { dispose() { calls.workerDisposed++; } } }, onData(fn) { this.data = fn; return { dispose() {} }; },
    onExit(fn) { this.exit = fn; return { dispose() {} }; },
    write(text) { calls.input.push(text); }, resize(cols, rows) { calls.resize.push([cols, rows]); }, kill() { calls.killed++; } };
}

test("a card terminal opens at twice the old default length", () => {
  let launch;
  const terms = new CardTerminals(() => true, (_file, _args, options) => { launch = options; return fakePty(); });
  try {
    const start = terms.start({ id: "a", provider: "grok", cwd: path.resolve("."), configDir: path.resolve("profile"), prompt: "Go" });
    assert.equal(launch.rows, 48);
    assert.equal(start.rows, 48);
    assert.equal(launch.cols, 80);
    const css = fs.readFileSync(path.join(__dirname, "..", "media", "board.css"), "utf8");
    assert.match(css, /\.card-terminal-screen \{ height: 400px;/);
  } finally { terms.dispose(); }
});

test("a card terminal records when it last printed, and forgets it once exited (F80 Quiet)", () => {
  let pty;
  const terms = new CardTerminals(() => true, () => (pty = fakePty()));
  try {
    terms.start({ id: "a", provider: "antigravity", cwd: path.resolve("."), prompt: "Go" });
    assert.equal(terms.lastOutputAt("a"), undefined);
    const before = Date.now();
    pty.data("working");
    assert.ok(terms.lastOutputAt("a") >= before);
    pty.exit({ exitCode: 0 });
    assert.equal(terms.lastOutputAt("a"), undefined);
  } finally { terms.dispose(); }
});

test("provider PTY routes ordered output, keys and resize to the same live generation", () => {
  let allowed = true, launch;
  const ptys = [], terms = new CardTerminals(() => allowed, (file, args, options) => {
    launch = { file, args, options }; const pty = fakePty(); ptys.push(pty); return pty;
  });
  const data = [], states = [];
  terms.onData((event) => data.push(event)); terms.onState((event) => states.push(event));
  const previousKey = process.env.XAI_API_KEY, previousIdentity = process.env.ENTOMATICAL_SESSION;
  process.env.XAI_API_KEY = "must-not-leak"; process.env.ENTOMATICAL_SESSION = "another-controller";
  try {
    const start = terms.start({ id: "a", provider: "grok", cwd: path.resolve("."), configDir: path.resolve("profile"), prompt: "--always-approve" });
    assert.deepEqual(launch.args, ["--", "--always-approve"]);
    assert.equal(launch.options.env.XAI_API_KEY, undefined);
    assert.equal(launch.options.env.ENTOMATICAL_SESSION, undefined);
    assert.equal(launch.options.env.GROK_HOME, path.resolve("profile"));
    ptys[0].data("\u001b[31mfirst "); ptys[0].data("line\u001b[0m");
    assert.equal(terms.attach("a").snapshot, "\u001b[31mfirst line\u001b[0m");
    assert.deepEqual(data.map((e) => e.data), ["\u001b[31mfirst ", "line\u001b[0m"]);
    terms.input("a", start.generation, "\u001b[A"); terms.resize("a", start.generation, 120, 40);
    assert.deepEqual(ptys[0].calls.input, ["\u001b[A"]); assert.deepEqual(ptys[0].calls.resize, [[120, 40]]);
    assert.throws(() => terms.input("a", "stale", "x"), /ended or been replaced/);
    assert.throws(() => terms.resize("a", start.generation, 10000, 40), /Invalid terminal size/);
    terms.stop("a", start.generation);
    assert.equal(terms.has("a"), true, "process remains live until it actually exits");
    assert.throws(() => terms.input("a", start.generation, "x"), /ended or been replaced/);
    ptys[0].data("tail while stopping");
    assert.ok(terms.attach("a").snapshot.endsWith("tail while stopping"));
    ptys[0].exit({ exitCode: 1 });
    assert.equal(ptys[0].calls.killed, 1, "exit cleanup must not signal a possibly reused PID");
    assert.equal(ptys[0].calls.workerDisposed, process.platform === "win32" ? 1 : 0);
    assert.equal(terms.has("a"), false); assert.equal(terms.attach("a").state, "exited");
    const next = terms.start({ id: "a", provider: "antigravity", cwd: path.resolve("."), prompt: "--dangerously-skip-permissions" });
    assert.deepEqual(launch.args, ["--prompt-interactive=--dangerously-skip-permissions"]);
    ptys[0].data("stale");
    assert.equal(terms.attach("a").snapshot, "");
    assert.notEqual(next.generation, start.generation);
    assert.throws(() => terms.input("a", start.generation, "old"), /ended or been replaced/);
    allowed = false; ptys[1].data("do not forward");
    assert.equal(ptys[1].calls.killed, 1); assert.equal(data.some((e) => e.data === "do not forward"), false);
    assert.throws(() => terms.attach("a"), /taking it over after a reload/);
    assert.ok(states.some((e) => e.state === "stopping"));
  } finally { if (previousKey === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = previousKey; if (previousIdentity === undefined) delete process.env.ENTOMATICAL_SESSION; else process.env.ENTOMATICAL_SESSION = previousIdentity; terms.dispose(); }
});

test("Antigravity terminals pass the card's model, effort and permission as fixed flags before the prompt (F88)", () => {
  let launch;
  const terms = new CardTerminals(() => true, (file, args) => { launch = { file, args }; return fakePty(); });
  try {
    terms.start({ id: "a", provider: "antigravity", cwd: path.resolve("."), prompt: "Go", model: "gemini-4-argon", effort: "low", permission: "bypass" });
    assert.deepEqual(launch.args, ["--model=gemini-4-argon", "--effort=low", "--dangerously-skip-permissions", "--prompt-interactive=Go"]);
    terms.start({ id: "b", provider: "antigravity", cwd: path.resolve("."), prompt: "Go", model: "claude-opus-5-5", effort: "high", permission: "edits" });
    assert.deepEqual(launch.args, ["--model=claude-opus-5-5", "--effort=high", "--mode=accept-edits", "--prompt-interactive=Go"]);
    terms.start({ id: "c", provider: "antigravity", cwd: path.resolve("."), prompt: "Go", permission: "ask" });
    assert.deepEqual(launch.args, ["--prompt-interactive=Go"], "an ACP-era card without choices keeps agy's own defaults");
    launch = undefined;
    assert.throws(() => terms.start({ id: "d", provider: "antigravity", cwd: path.resolve("."), prompt: "Go", model: "gpt-oss-120b" }), /Unknown Antigravity model/);
    assert.throws(() => terms.start({ id: "d", provider: "antigravity", cwd: path.resolve("."), prompt: "Go", model: "claude-opus-5-5", effort: "max" }), /Unknown effort level max/);
    assert.throws(() => terms.start({ id: "d", provider: "antigravity", cwd: path.resolve("."), prompt: "Go", permission: "plan" }), /Unknown permission mode/);
    assert.equal(launch, undefined, "nothing is spawned for a refused choice");
    assert.equal(terms.has("d"), false);
    // Grok takes the exact id the board resolved (17 November 2026, grok 1.0.77 --model); a short name or alias never reaches either CLI.
    terms.start({ id: "e", provider: "grok", cwd: path.resolve("."), configDir: path.resolve("profile"), prompt: "Go", model: "grok-4.7" });
    assert.deepEqual(launch.args, ["--model=grok-4.7", "--", "Go"]);
    launch = undefined;
    assert.throws(() => terms.start({ id: "f", provider: "grok", cwd: path.resolve("."), configDir: path.resolve("profile"), prompt: "Go", model: "grok" }), /Grok would be handed "grok", not an exact model id/);
    assert.throws(() => terms.start({ id: "f", provider: "antigravity", cwd: path.resolve("."), prompt: "Go", model: "opus" }), /Antigravity would be handed "opus", not an exact model id/);
    assert.equal(launch, undefined, "nothing is spawned for a short name");
  } finally { terms.dispose(); }
});

test("terminal replay stays bounded and rejects invalid initial prompts", () => {
  const pty = fakePty(), terms = new CardTerminals(() => true, () => pty);
  assert.throws(() => terms.start({ id: "a", provider: "antigravity", cwd: path.resolve("."), prompt: " " }), /empty/);
  assert.throws(() => terms.start({ id: "a", provider: "antigravity", cwd: path.resolve("."), prompt: "x".repeat(200 * 1024) }), /too long/);
  const state = terms.start({ id: "a", provider: "antigravity", cwd: path.resolve("."), prompt: "--dangerously-skip-permissions" });
  pty.data("x".repeat(600000));
  assert.equal(terms.attach("a").snapshot.length, 512 * 1024);
  terms.stop("a", state.generation); pty.exit({ exitCode: 0 }); terms.dispose();
});

test("Windows natural exit preserves tail output and releases PTY worker without signaling a PID", { skip: process.platform !== "win32", timeout: 15_000 }, () => {
  const { spawnSync } = require("node:child_process");
  const source = `
    const { CardTerminals } = require('./out/cardTerminal.js');
    const pty = require('node-pty');
    let signals = 0, output = '';
    process.kill = () => { signals++; throw new Error('must not signal a PID after exit'); };
    const terms = new CardTerminals(() => true, (_file, _args, options) => pty.spawn(process.execPath, ['-e', "process.stdout.write('TAIL_MARKER_729')"], options));
    terms.onData((e) => output += e.data);
    terms.onState((e) => {
      if (e.state !== 'exited') return;
      if (signals || !output.includes('TAIL_MARKER_729')) process.exitCode = 2;
      console.log(JSON.stringify({ signals, tail: output.includes('TAIL_MARKER_729') }));
    });
    terms.start({ id: 'one', provider: 'antigravity', cwd: process.cwd(), prompt: 'test' });
  `;
  const result = spawnSync(process.execPath, ["-e", source], { cwd: process.cwd(), encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.error, undefined, result.stderr || String(result.error));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"signals":0,"tail":true/);
});

test("Stop ends the PTY's whole process tree on Windows while it runs, and never after it exited (F89)", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const trees = [], done = [];
  const treeKill = (pid, cb) => { trees.push(pid); done.push(cb); };
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const pty = fakePty(), terms = new CardTerminals(() => true, () => pty, undefined, treeKill);
    const s = terms.start({ id: "a", provider: "antigravity", cwd: path.resolve("."), prompt: "go" });
    terms.stop("a", s.generation);
    assert.deepEqual(trees, [123], "taskkill /T is asked for the pty's pid while it is still running");
    assert.equal(pty.calls.killed, 0, "node-pty's kill() would end the root first and orphan the tool processes");
    done[0](null); assert.equal(pty.calls.killed, 0, "taskkill ended the tree: nothing more is signalled");
    terms.stop("a", s.generation); assert.deepEqual(trees, [123], "a second Stop while stopping asks nothing more");
    pty.exit({ exitCode: 1 });
    terms.stop("a"); terms.dispose(); assert.deepEqual(trees, [123], "after exit no pid is signalled");

    const failed = fakePty(), other = new CardTerminals(() => true, () => failed, undefined, treeKill);
    const t = other.start({ id: "b", provider: "antigravity", cwd: path.resolve("."), prompt: "go" });
    other.stop("b", t.generation);
    done[1](new Error("taskkill: access denied"));
    assert.equal(failed.calls.killed, 1, "taskkill failed: node-pty's own kill() still ends the session");
    const late = fakePty(), third = new CardTerminals(() => true, () => late, undefined, treeKill);
    const u = third.start({ id: "c", provider: "antigravity", cwd: path.resolve("."), prompt: "go" });
    third.stop("c", u.generation); late.exit({ exitCode: 1 }); done[2](new Error("not found"));
    assert.equal(late.calls.killed, 0, "a taskkill error after the exit does not signal a possibly reused pid");

    const stand = fakePty(), standIn = new CardTerminals(() => true, () => stand);
    const v = standIn.start({ id: "d", provider: "antigravity", cwd: path.resolve("."), prompt: "go" });
    standIn.stop("d", v.generation);
    assert.equal(trees.length, 3, "an injected spawn with no treeKill (a test stand-in) never gets taskkill");
    assert.equal(stand.calls.killed, 1);

    Object.defineProperty(process, "platform", { value: "linux" });
    const lin = fakePty(), linux = new CardTerminals(() => true, () => lin, undefined, treeKill);
    const w = linux.start({ id: "e", provider: "antigravity", cwd: path.resolve("."), prompt: "go" });
    linux.stop("e", w.generation);
    assert.equal(trees.length, 3, "Linux keeps node-pty's kill() (SIGHUP to the session leader)");
    assert.equal(lin.calls.killed, 1);
  } finally { Object.defineProperty(process, "platform", platform); }
});

for (const [outcome, nativeExitCode] of [
  ["error"], ["success"], ["exit before error"],
  ["native exit 0 before error", 0], ["native exit 17 before error", 17],
]) {
  test(`deleting a stopping Windows PTY preserves its generation through ${outcome} and card-ID reuse`, (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    t.after(() => Object.defineProperty(process, "platform", platform));
    const original = fakePty(), replacement = fakePty(), handles = [original, replacement];
    const callbacks = [], events = [], data = [];
    const terms = new CardTerminals(() => true, () => handles.shift(), () => undefined,
      (pid, done) => { assert.equal(pid, original.pid); callbacks.push(done); });
    terms.onState(event => events.push(event));
    terms.onData(event => data.push(event));
    const request = { id: "a", file: "fixture", args: [], cwd: process.cwd(), env: {} };
    const first = terms.spawnCommand(request);
    terms.stop("a", first.generation);
    terms.forget("a");
    assert.equal(terms.attach("a"), undefined);
    const next = terms.spawnCommand(request);
    assert.notEqual(next.generation, first.generation);
    assert.equal(callbacks.length, 1);
    const error = new Error("fixture tree stop failed");
    if (outcome === "exit before error") original.exit({ exitCode: 17 });
    // The pinned Windows agent records native exit, drains output, then emits the public exit on socket close.
    if (nativeExitCode !== undefined) original._agent.exitCode = nativeExitCode;
    callbacks[0](outcome === "success" ? null : error);
    callbacks[0](error); // a repeated completion cannot trigger a second fallback
    assert.equal(original.calls.killed, outcome === "error" ? 1 : 0);
    const states = () => events.filter(e => e.generation === first.generation).map(e => [e.state, e.exitCode]);
    if (outcome !== "exit before error") {
      assert.deepEqual(states(), [["running", undefined], ["stopping", undefined]]);
      assert.equal(original.calls.workerDisposed, 0);
    }
    const exitCode = nativeExitCode ?? 17;
    original.exit({ exitCode });
    original.data("retired output");
    assert.deepEqual(data, []);
    assert.deepEqual(states(), [["running", undefined], ["stopping", undefined], ["exited", exitCode]]);
    assert.equal(original.calls.workerDisposed, 1);
    assert.equal(events.find(e => e.generation === first.generation && e.state === "exited").retired, true);
    assert.equal(replacement.calls.killed, 0);
    assert.equal(replacement.calls.workerDisposed, 0);
    assert.equal(terms.attach("a").state, "running");
    replacement.exit({ exitCode: 0 });
    terms.dispose();
  });
}

test("Windows Stop during native exit drain keeps tail output and waits for public exit", (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  const pty = fakePty(), events = [];
  const terms = new CardTerminals(() => true, () => pty, () => undefined,
    () => assert.fail("a natively exited process must not receive tree stop"));
  terms.onState(e => events.push([e.state, e.exitCode]));
  terms.spawnCommand({ id: "a", file: "fixture", args: [], cwd: process.cwd(), env: {} });
  pty._agent.exitCode = 0;
  terms.stop("a");
  pty.data("final output");
  assert.equal(terms.attach("a").snapshot, "final output");
  assert.deepEqual(events, [["running", undefined], ["stopping", undefined]]);
  assert.equal(pty.calls.killed, 0);
  assert.equal(pty.calls.workerDisposed, 0);
  pty.exit({ exitCode: 0 });
  assert.deepEqual(events.at(-1), ["exited", 0]);
  assert.equal(pty.calls.workerDisposed, 1);
  terms.dispose();
});

test("Windows Stop followed by deletion ends a tool process that has a console of its own (F89)", { skip: process.platform !== "win32", timeout: 30_000 }, () => {
  const { spawnSync } = require("node:child_process");
  // The pty runs node, which starts a hidden-console child (as Claude starts its PowerShell tool) that pings for 60 s. Stop must end it.
  const source = `
    const { CardTerminals } = require('./out/cardTerminal.js');
    const { execFileSync } = require('child_process');
    const inner = "const c = require('child_process').spawn('ping', ['-n', '60', '127.0.0.1'], { windowsHide: true, detached: true, stdio: 'ignore' }); console.log('CHILD_' + c.pid); setInterval(() => {}, 1000);";
    const terms = new CardTerminals(() => true, undefined, () => undefined);
    let out = '', child = 0;
    terms.onData((e) => { out += e.data; const m = /CHILD_(\\d+)/.exec(out); if (m && !child) { child = +m[1]; terms.stop('one'); terms.forget('one'); } });
    const alive = (pid) => execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH'], { encoding: 'utf8', windowsHide: true }).includes(String(pid));
    terms.onState((e) => {
      if (e.state !== 'exited') return;
      setTimeout(() => {
        const left = child && alive(child);
        if (left) try { execFileSync('taskkill', ['/PID', String(child), '/F'], { windowsHide: true }); } catch {}
        console.log(JSON.stringify({ child: !!child, left }));
        process.exit(left || !child ? 2 : 0);
      }, 1500);
    });
    terms.spawnCommand({ id: 'one', file: process.execPath, args: ['-e', inner], cwd: process.cwd(), env: process.env });
    setTimeout(() => { console.log('TIMEOUT ' + JSON.stringify(out.slice(-200))); process.exit(3); }, 20000);
  `;
  const result = spawnSync(process.execPath, ["-e", source], { cwd: process.cwd(), encoding: "utf8", timeout: 25000, windowsHide: true });
  assert.equal(result.error, undefined, result.stderr || String(result.error));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"child":true,"left":false/);
});

test("a card's model and effort are named in a first terminal line: the provider's terminal starts on the agent's defaults", () => {
  const { terminalModelNotice } = require("../out/cardTerminal.js");
  let launch; const pty = fakePty(), terms = new CardTerminals(() => true, (file, args, options) => { launch = { file, args }; return pty; });
  const data = []; terms.onData((e) => data.push(e.data));
  // Since 17 November 2026 Grok's terminal gets the model as an exact id (--model), so only an effort is left to the agent.
  const notice = terminalModelNotice({ provider: "grok", model: "fake-model-b", effort: "fake-high" });
  assert.equal(notice, "Entomatical: this Grok terminal uses the agent's default effort. The card's choice (effort fake-high) applies to its unattended runs and follow-ups.");
  assert.equal(terminalModelNotice({ provider: "grok", model: "fake-model-b" }), undefined, "a model alone is passed, so no notice");
  assert.equal(terminalModelNotice({ provider: "antigravity" }), undefined, "no choice, no notice");
  terms.start({ id: "a", provider: "grok", cwd: path.resolve("."), configDir: path.resolve("profile"), prompt: "go", notice });
  assert.deepEqual(launch.args, ["--", "go"], "no invented model flag reaches the CLI");
  assert.ok(terms.attach("a").snapshot.includes(notice), "kept in the replay");
  assert.ok(data[0].includes(notice), "sent to an attached view");
  pty.data("agent output");
  assert.ok(terms.attach("a").snapshot.endsWith("agent output"));
  terms.dispose();
});

test("Antigravity's folder trust is answered in a narrow card terminal that wraps the question and cuts off its options", async () => {
  // agy 1.5.2 in a 30x13 card terminal (linux, 6 November 2026): the question wraps onto two lines and the options do not fit, so the
  // card sat at this screen. Enter takes agy's preselected "Yes, I trust this folder".
  const pty = fakePty(), terms = new CardTerminals(() => true, () => pty);
  try {
    terms.start({ id: "a", provider: "antigravity", cwd: path.resolve("."), prompt: "go" });
    pty.data(["Accessing workspace:", "", "/var/tmp/ab-linux-w4-", "TE0HHx/repo/.entomatical/wt/61", "03c8", "", "Do you trust the contents of", "this project?", "",
      "Antigravity CLI requires", "permission to read, edit, and", "execute files here.", ""].join("\r\n"));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.deepEqual(pty.calls.input, ["\r"]);
  } finally { terms.dispose(); }
});

test("Claude's folder trust is answered once with Down and Enter, whether its cursor is drawn as ❯ (now) or > (before)", async () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1000));
  // Current Claude Code in a short card terminal (Windows, 11 November 2026, docs/evidence/parity-win-2026-11-11/F89-stop-files/driver.txt):
  // the question has scrolled off the top, and the cursor on "No, exit" is ❯.
  const now = ["\u001b[2J\u001b[H or work from your team). If not,", " take a moment to review what's in", " this folder first.", "",
    " Claude Code'll be able to read,", " edit, and execute files here.", "", " Security guide", "", " ❯ No, exit", "   Yes, I trust this folder", "",
    " Enter to confirm · Esc to cancel", ""].join("\r\n");
  const before = ["\u001b[2J\u001b[H Is this a project you created or one you trust?", "", " > No, exit", "   Yes, I trust this folder", "",
    " Enter to confirm · Esc to cancel", ""].join("\r\n");
  for (const [name, screen] of [["❯", now], [">", before]]) {
    const pty = fakePty(), terms = new CardTerminals(() => true, () => pty);
    try {
      terms.spawnCommand({ id: "a", file: "claude", args: [], cwd: path.resolve("."), env: {} });
      pty.data(screen); await settle();
      assert.deepEqual(pty.calls.input, ["\u001b[B\r"], `${name}: Down then Enter, from "No, exit" to "Yes, I trust this folder"`);
      pty.data(screen); await settle();
      assert.deepEqual(pty.calls.input, ["\u001b[B\r"], `${name}: answered once`);
    } finally { terms.dispose(); }
  }
  // Not a trust prompt: the cursor already on "Yes" (Down would move it off), and the same words as ordinary output (a diff of this test).
  const other = [
    "\u001b[2J\u001b[H Claude Code'll be able to read, edit, and execute files here.\r\n   No, exit\r\n ❯ Yes, I trust this folder\r\n",
    "\u001b[2J\u001b[H+    \" Claude Code'll be able to read,\", \" edit, and execute files here.\", \" ❯ No, exit\", \"   Yes, I trust this folder\",\r\n",
  ];
  for (const screen of other) {
    const pty = fakePty(), terms = new CardTerminals(() => true, () => pty);
    try {
      terms.spawnCommand({ id: "a", file: "claude", args: [], cwd: path.resolve("."), env: {} });
      pty.data(screen); await settle();
      assert.deepEqual(pty.calls.input, [], JSON.stringify(screen));
    } finally { terms.dispose(); }
  }
});

test("Claude's external-imports and new-MCP-server dialogs are answered once, whether the cursor is drawn as ❯ or > (F89)", async () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1000));
  const run = async (screen, times = 1, strict = false) => {
    const pty = fakePty(), terms = new CardTerminals(() => true, () => pty);
    terms.isStrict = (id) => strict && id === "a";
    try {
      terms.spawnCommand({ id: "a", file: "claude", args: [], cwd: path.resolve("."), env: {} });
      for (let i = 0; i < times; i++) { pty.data(screen); await settle(); }
      return pty.calls.input;
    } finally { terms.dispose(); }
  };
  // Text and cursor start as in Claude Code CLI 2.1.325's own code.
  const imports = (no, yes) => ["\u001b[2J\u001b[H Allow external CLAUDE.md file imports?", "",
    " This project's CLAUDE.md or .claude/rules imports files outside the current working directory. Never allow this for third-party repositories.", "",
    " External imports:", "   /home/someone/shared/rules.md", "", " Important: Only use Claude Code with files you trust.", "",
    ` ${no} No, disable external imports`, ` ${yes} Yes, allow external imports`, "", " Enter to confirm · Esc to cancel", ""].join("\r\n");
  const mcp = (first, last) => ["\u001b[2J\u001b[H New MCP server found in this project: fake-server", "",
    " MCP servers may execute code or access system resources. All tool calls require approval. Learn more in the MCP documentation.", "",
    ` ${first} Use this MCP server`, "   Use this and all future MCP servers in this project", ` ${last} Continue without using this MCP server`, "",
    " Enter to confirm · Esc to cancel", ""].join("\r\n");
  for (const glyph of ["❯", ">"]) {
    assert.deepEqual(await run(imports(glyph, " "), 2), ["\u001b[B\r"], `${glyph}: imports, Down then Enter to "Yes, allow external imports", once`);
    assert.deepEqual(await run(mcp(" ", glyph), 2), ["\u001b[A\u001b[A\r"], `${glyph}: MCP, Up, Up, Enter to "Use this MCP server", once`);
    // A strict capability profile (strict-claude.ts): its servers come with --mcp-config, so Enter keeps "Continue without using this MCP server".
    assert.deepEqual(await run(mcp(" ", glyph), 2, true), ["\r"], `${glyph}: MCP on a strict card, Enter on "Continue without", once`);
    assert.deepEqual(await run(imports(glyph, " "), 1, true), ["\u001b[B\r"], `${glyph}: imports on a strict card unchanged`);
  }
  // The screens a 31x13 card terminal stopped on (linux, 14 November 2026): the titles scrolled off, the options wrapped.
  assert.deepEqual(await run(["\u001b[2J\u001b[H  may pose security risks", "  /en/security", "", "  ❯ No, disable external", "    imports", "    Yes, allow external", "    imports", "",
    "  Enter to confirm · Esc to", "  cancel"].join("\r\n")), ["\u001b[B\r"], "imports, title scrolled off");
  assert.deepEqual(await run(["\u001b[2J\u001b[H  MCP documentation.", "", "    Use this MCP server", "    Use this and all future", "    MCP servers in this", "    project",
    "  ❯ Continue without using", "    this MCP server", "", "  Enter to confirm · Esc to", "  cancel"].join("\r\n")), ["\u001b[A\u001b[A\r"], "MCP, title scrolled off");
  // Not these dialogs: the cursor already on a yes option, and the same words as ordinary output (a diff of this test).
  const other = [
    imports(" ", "❯"), mcp("❯", " "),
    "\u001b[2J\u001b[H+    \" Allow external CLAUDE.md file imports?\", \" ❯ No, disable external imports\", \"   Yes, allow external imports\",\r\n",
    "\u001b[2J\u001b[H+    \" New MCP server found in this project: x\", \" Use this MCP server\", \" Use this and all future MCP servers in this project\", \" ❯ Continue without using this MCP server\",\r\n",
  ];
  for (const screen of other) assert.deepEqual(await run(screen), [], JSON.stringify(screen));
});

test("Antigravity's folder trust with its options shown is answered with Enter for either cursor glyph", async () => {
  for (const cursor of ["❯", ">"]) {
    const pty = fakePty(), terms = new CardTerminals(() => true, () => pty);
    try {
      terms.start({ id: "a", provider: "antigravity", cwd: path.resolve("."), prompt: "go" });
      pty.data(`\u001b[2J\u001b[HDo you trust the contents of this project?\r\n\r\n ${cursor} Yes, I trust this folder\r\n   No, exit\r\n`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.deepEqual(pty.calls.input, ["\r"], cursor);
    } finally { terms.dispose(); }
  }
});

test("a start-up check is answered once, and nothing is answered 60 s after the terminal started", async (t) => {
  const screen = "\u001b[2J\u001b[HDo you trust the contents of this project? Antigravity CLI requires permission to read, edit, and execute files here.\r\n";
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1000));
  const pty = fakePty(), terms = new CardTerminals(() => true, () => pty);
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  try {
    terms.start({ id: "a", provider: "antigravity", cwd: path.resolve("."), prompt: "go" });
    pty.data(screen); await settle();
    assert.deepEqual(pty.calls.input, ["\r"]);
    pty.data("diff output\r\n" + screen); await settle(); // the same words again (a diff of src/cardTerminal.ts)
    assert.deepEqual(pty.calls.input, ["\r"], "an answered check is not answered again");

    const late = fakePty(), lateTerms = new CardTerminals(() => true, () => late);
    try {
      lateTerms.start({ id: "b", provider: "antigravity", cwd: path.resolve("."), prompt: "go" });
      t.mock.timers.setTime(1_800_000_000_000 + 60_000);
      late.data(screen); await settle();
      assert.deepEqual(late.calls.input, [], "60 s after spawn the words are not a start-up check");
    } finally { lateTerms.dispose(); }
  } finally { terms.dispose(); }
});

// F89 Battle Royale (14 November 2026): each dialog drawn with the words the installed CLI holds (Claude Code 2.1.325, Codex 0.167.2,
// Grok 1.0.77), as its screen lays them out, kept under 80 columns so the card terminal does not wrap them.
const draw = (lines) => `\u001b[2J\u001b[H${lines.join("\r\n")}\r\n`;
const asDiff = (lines) => `\u001b[2J\u001b[H${lines.map((l) => `+    "${l}",`).join("\r\n")}\r\n`; // the same words in a diff of a test file
const DIALOGS = [
  { name: "claude-bypass", keys: "\u001b[B\r", lines: [" WARNING: Claude Code running in Bypass Permissions mode", "",
    " In Bypass Permissions mode, Claude Code will not ask for your approval", " before running potentially dangerous commands.", "",
    " By proceeding, you accept all responsibility for actions taken while", " running in Bypass Permissions mode.", "",
    " ❯ No, exit", "   Yes, I accept", "", " Enter to confirm · Esc to cancel"],
    onYes: [" WARNING: Claude Code running in Bypass Permissions mode", "", "   No, exit", " ❯ Yes, I accept"] },
  { name: "claude-trust (folder with settings)", keys: "\u001b[B\r", lines: [" Quick safety check: Is this a project you created or one you trust?",
    " (Like your own code, a well-known open source project, or work from", " your team). If not, take a moment to review what's in this folder first.", "",
    " Claude Code'll be able to read, edit, and execute files here.", "", "   ⚠ This folder pre-approves 2 tool permissions in .claude/settings.json", "",
    " Security guide", "", " ❯ No, continue without these permissions", "   Yes, I trust this folder", "", " Enter to confirm · Esc to cancel"],
    onYes: [" Claude Code'll be able to read, edit, and execute files here.", "", "   No, continue without these permissions", " ❯ Yes, I trust this folder"] },
  { name: "claude-imports", keys: "\u001b[B\r", lines: [" Allow external CLAUDE.md file imports?", "",
    " This project's CLAUDE.md or .claude/rules imports files outside the", " current working directory. Never allow this for third-party repositories.", "",
    " External imports:", "   C:\\Users\\user\\notes\\style.md", "", " ❯ No, disable external imports", "   Yes, allow external imports"],
    onYes: [" Allow external CLAUDE.md file imports?", "", "   No, disable external imports", " ❯ Yes, allow external imports"] },
  { name: "claude-mcp", keys: "\u001b[A\u001b[A\r", lines: [" New MCP server found in this project: playwright", "",
    "   Use this MCP server", "   Use this and all future MCP servers in this project", " ❯ Continue without using this MCP server"],
    onYes: [" New MCP server found in this project: playwright", "", " ❯ Use this MCP server", "   Use this and all future MCP servers in this project",
      "   Continue without using this MCP server"] },
  { name: "grok-trust", keys: "y", lines: ["Do you trust the contents of this directory?", "Grok Build may run or modify contents in this directory,",
    "posing security risks.", "", "  y  Yes, proceed", "  n  No, quit", "", "Enter or y to trust · n or Esc to quit"] },
  // Codex picks by the number drawn beside the label; in another order the yes option has another number, so it is not answered.
  { name: "codex-trust-folder", keys: "1\r", lines: ["  Trust this folder? Codex can read, edit, and run files here, subject to",
    "  your permission settings. Folder settings can run code automatically,", "  even without a model request. Continue only if you trust these files.",
    "  Your trust decision will be saved.", "", "› 1. Trust and continue", "  2. Open restricted", "  3. Quit", "", "  Press enter to continue"],
    onYes: ["  Trust this folder? Codex can read, edit, and run files here, subject to", "", "› 1. Open restricted", "  2. Trust and continue"] },
  { name: "codex-db-rebuilt", keys: "\r", lines: ["Codex rebuilt its local database.",
    "Codex detected a damaged local database, moved it into a backup folder,", "and will continue startup with a fresh database.",
    "Database path: C:\\Users\\user\\.codex\\state_5.sqlite", "Backup folder: C:\\Users\\user\\.codex\\backup", "",
    "Continuing startup with a fresh local database...", "Press Enter to continue."] },
  { name: "codex-rate-limit", keys: "2\r", lines: ["  Approaching rate limits", "  Switch to gpt-6-astra-mini for lower credit usage?", "",
    "› 1. Switch to gpt-6-astra-mini", "     Uses fewer credits for upcoming turns", "  2. Keep current model", "  3. Keep current model (never show again)",
    "", "  Press enter to confirm or esc to go back"],
    onYes: ["  Approaching rate limits", "  Switch to gpt-6-astra-mini for lower credit usage?", "", "› 1. Switch to gpt-6-astra-mini",
      "  2. Keep current model (never show again)", "  3. Keep current model"] },
];

test("F89: each dialog the CLIs show is answered once with exactly its keys; with yes already selected, or as a diff, it is not", async () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1000));
  for (const d of DIALOGS) {
    const pty = fakePty(), terms = new CardTerminals(() => true, () => pty);
    try {
      terms.spawnCommand({ id: "a", file: "cli", args: [], cwd: path.resolve("."), env: {} });
      pty.data(draw(d.lines)); await settle();
      assert.deepEqual(pty.calls.input, [d.keys], `${d.name}: answered with its keys`);
      pty.data(draw(d.lines)); await settle();
      assert.deepEqual(pty.calls.input, [d.keys], `${d.name}: answered once`);
    } finally { terms.dispose(); }
    for (const [kind, screen] of [["yes already selected", d.onYes && draw(d.onYes)], ["diff", asDiff(d.lines)]]) {
      if (!screen) continue;
      const other = fakePty(), otherTerms = new CardTerminals(() => true, () => other);
      try {
        otherTerms.spawnCommand({ id: "a", file: "cli", args: [], cwd: path.resolve("."), env: {} });
        other.data(screen); await settle();
        assert.deepEqual(other.calls.input, [], `${d.name}: ${kind} is not answered`);
      } finally { otherTerms.dispose(); }
    }
  }
});

test("F89: a battle card answers after 60 s and again when a dialog comes back; another card does neither", async (t) => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1000));
  const T0 = 1_800_000_000_000, dialog = draw(DIALOGS[0].lines), keys = DIALOGS[0].keys;
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  for (const battle of [true, false]) {
    t.mock.timers.setTime(T0);
    const pty = fakePty(), terms = new CardTerminals(() => true, () => pty);
    terms.isUnattended = (id) => battle && id === "a";
    try {
      terms.spawnCommand({ id: "a", file: "claude", args: [], cwd: path.resolve("."), env: {} });
      pty.data(dialog); await settle();
      pty.data(draw([" ✻ Working… (3s · esc to interrupt)"])); await settle(); // the dialog left the screen
      t.mock.timers.setTime(T0 + 10_000);
      pty.data(dialog); await settle();
      assert.deepEqual(pty.calls.input, battle ? [keys, keys] : [keys], `battle ${battle}: a second appearance`);
    } finally { terms.dispose(); }

    const late = fakePty(), lateTerms = new CardTerminals(() => true, () => late);
    lateTerms.isUnattended = () => battle;
    try {
      t.mock.timers.setTime(T0);
      lateTerms.spawnCommand({ id: "b", file: "claude", args: [], cwd: path.resolve("."), env: {} });
      t.mock.timers.setTime(T0 + 61_000);
      late.data(dialog); await settle();
      assert.deepEqual(late.calls.input, battle ? [keys] : [], `battle ${battle}: first shown 61 s after the start`);
    } finally { lateTerms.dispose(); }
  }
});

test("F89: an unanswered selection prompt makes one Waiting event after 30 s and types nothing: on any card in its first minute, on an unattended card at any time", async (t) => {
  const prompt = draw(["  Which approach should I take?", "", "› 1. Rewrite the parser", "  2. Patch the tokenizer", "",
    "  Press enter to confirm or esc to go back"]);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const step = async (ms) => { for (let i = 0; i < ms / 100; i++) { t.mock.timers.tick(100); await new Promise((r) => setImmediate(r)); } };
  for (const battle of [true, false]) {
    const pty = fakePty(), terms = new CardTerminals(() => true, () => pty), events = [];
    terms.isUnattended = () => battle;
    terms.onWaiting((e) => events.push(e));
    try {
      terms.spawnCommand({ id: "a", file: "cli", args: [], cwd: path.resolve("."), env: {} });
      pty.data(prompt); await step(500);
      await step(29_000);
      assert.deepEqual(events, [], "not before 30 s");
      await step(1_000);
      assert.deepEqual(events, [{ id: "a", lines: "Which approach should I take? / › 1. Rewrite the parser / 2. Patch the tokenizer" }], `unattended ${battle}`);
      pty.data(prompt); await step(31_000);
      assert.equal(events.length, 1, "one event for one prompt");
      assert.deepEqual(pty.calls.input, [], "nothing typed");
    } finally { terms.dispose(); }
    // A prompt first drawn after the first minute: only an unattended card is still watched.
    const late = fakePty(), lateTerms = new CardTerminals(() => true, () => late), lateEvents = [];
    lateTerms.isUnattended = () => battle;
    lateTerms.onWaiting((e) => lateEvents.push(e));
    try {
      lateTerms.spawnCommand({ id: "b", file: "cli", args: [], cwd: path.resolve("."), env: {} });
      await step(61_000);
      late.data(prompt); await step(31_000);
      assert.equal(lateEvents.length, battle ? 1 : 0, `unattended ${battle}: first drawn after 61 s`);
    } finally { lateTerms.dispose(); }
  }
});

test("F89: waitingPrompt finds a question with its options, not a question above an input box", () => {
  const { waitingPrompt } = require("../out/cardTerminal.js");
  assert.equal(waitingPrompt(" Do you want to proceed?\n\n ❯ Yes\n   No\n\n Esc to cancel"), "Do you want to proceed? / ❯ Yes / No");
  assert.equal(waitingPrompt("Want me to add tests too?\n\n────────────\n❯ yes please\n────────────\n  ? for shortcuts"), undefined);
  assert.equal(waitingPrompt("Done. All tests pass.\n\n❯ 1. not a question above"), undefined);
});

test("the card's terminal is started as a colour terminal: COLORTERM set, NO_COLOR, CI and FORCE_COLOR=0 left out", () => {
  let launch;
  const terms = new CardTerminals(() => true, (file, args, options) => { launch = options; return fakePty(); });
  terms.spawnCommand({ id: "a", file: "claude", args: [], cwd: path.resolve("."), env: { PATH: "p", TERM: "dumb", NO_COLOR: "1", Ci: "true", FORCE_COLOR: "0", COLORTERM: "16", KEEP: "k" } });
  assert.deepEqual(launch.env, { PATH: "p", KEEP: "k", TERM: "xterm-256color", COLORTERM: "truecolor" });
  const { colorEnv } = require("../out/cardTerminal.js");
  assert.equal(colorEnv({ FORCE_COLOR: "3" }).FORCE_COLOR, "3", "a FORCE_COLOR that turns colour on stays");
  terms.dispose();
});

test("the card's terminal takes VS Code's terminal colours, the 16 ANSI colours included; an empty one keeps xterm's default", () => {
  const fs = require("node:fs"), vm = require("node:vm");
  const vars = { "--vscode-terminal-background": " #101010", "--vscode-editor-foreground": "#eeeeee", "--vscode-terminal-ansiRed": "#ff0000", "--vscode-terminal-ansiBrightGreen": "#00ff00" };
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "media", "card-terminal.js"), "utf8"), { window, document: { currentScript: null }, Proxy, Reflect });
  const theme = window.cardTerminalTheme({ getPropertyValue: (n) => vars[n] ?? "" });
  assert.deepEqual({ ...theme }, { background: "#101010", foreground: "#eeeeee", cursor: "#eeeeee", red: "#ff0000", brightGreen: "#00ff00" });
});

test("F89: an orchestrator card's brief fits its terminal; only the OS argv limit refuses a prompt", () => {
  const brief = fs.readFileSync(path.join(__dirname, "..", "docs", "orchestrator", "BRIEF.md"), "utf8");
  assert.ok(brief.length > 8192, "the shipped brief is the size that used to be refused");
  for (const provider of ["grok", "antigravity"]) {
    let launched;
    const terms = new CardTerminals(() => true, (_file, args) => { launched = args; return fakePty(); });
    try {
      terms.start({ id: "o", provider, cwd: path.resolve("."), configDir: path.resolve("profile"), prompt: `${brief}\n\nDo the task.` });
      assert.ok(launched.at(-1).endsWith(`${brief}\n\nDo the task.`), `${provider} gets the whole brief`);
    } finally { terms.dispose(); }
  }
  assert.equal(argvFits("grok.exe", ["--", "x".repeat(32000)], "win32"), true);
  assert.equal(argvFits("grok.exe", ["--", "x".repeat(32767)], "win32"), false);
  assert.equal(argvFits("grok.exe", ["--", '"'.repeat(16370)], "win32"), true);
  assert.equal(argvFits("grok.exe", ["--", '"'.repeat(16400)], "win32"), false, "escaped quotes count twice");
  assert.equal(argvFits("grok", ["--", "x".repeat(128 * 1024 - 1)], "linux"), true);
  assert.equal(argvFits("grok", ["--", "é".repeat(64 * 1024)], "linux"), false, "Linux counts bytes, not characters");
});

// F105 fault 3 (Linux, 17 November 2026): Grok 1.0.77's fullscreen folder trust in a 32x13 card terminal, as recorded in the evidence file
// F105-grok-trust-unanswered-32cols.txt except its folder path line (a private home folder there). Grok cuts the question at the edge, so
// no text row matches; the grok-trust-cut row (grokTrustWaiting on the visible rows) answers it with y, once (F105, 25 November 2026).
test("F89: Grok's trust cut off by a 32-column card terminal gets y once; its full-width layout gets y once", async () => {
  const grok32 = ["", "  task/6f2a32 worktree ~/D/a/…", "", "", "Do you trust the contents of thi", "/home/dev/projects/Entomatical/.",
    " Yes, proceed                 y", " No, quit                     n", "", "", "", "    Grok Build  1.0.77 [stable]", ""];
  const grok48 = ["", "", "", "", "Do you trust the contents of this directory?", "/home/dev/projects/Entomatical/.entomatical/wt",
    `${" Yes, proceed".padEnd(46)}y`, `${" No, quit".padEnd(46)}n`, "", "", "", "Grok Build  1.0.92 [stable]".padStart(47), ""];
  for (const [cols, lines, keys] of [[32, grok32, ["y"]], [48, grok48, ["y"]]]) {
    const pty = fakePty(), terms = new CardTerminals(() => true, () => pty);
    try {
      const { generation } = terms.start({ id: "a", provider: "grok", cwd: path.resolve("."), configDir: path.resolve("profile"), prompt: "Go" });
      terms.resize("a", generation, cols, 13);
      pty.data(draw(lines)); await new Promise((resolve) => setTimeout(resolve, 1000));
      pty.data(draw(lines)); await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.deepEqual(pty.calls.input, keys, `${cols} columns`);
    } finally { terms.dispose(); }
  }
});

// Grok 1.0.92's cut trust question, as the native run of 24 November 2026 recorded it (docs/evidence/grok-narrow-trust-2026-11-24/
// 97ddeb-signed-in/receipt.json, the four lines it kept of each 13-row screen; the other rows are blank here). At 41 columns Grok centres
// the options.
const GROK_CUT = {
  32: ["Do you trust the contents of thi", " Yes, proceed                 y ", " No, quit                     n ", "             Grok Build  1.0.92 "],
  41: ["Do you trust the contents of this directo", "      Yes, proceed                 y     ", "      No, quit                     n     ",
    "                      Grok Build  1.0.92 "],
};
const grokCutScreen = (cols) => ["", "", "", "", GROK_CUT[cols][0], "", GROK_CUT[cols][1], GROK_CUT[cols][2], "", "", "", GROK_CUT[cols][3]];

test("F89: grokTrustWaiting finds only Grok's exact cut trust screen; waitingPrompt is unchanged for it and for other prompts", () => {
  const { waitingPrompt, grokTrustWaiting } = require("../out/cardTerminal.js");
  const screen = (lines) => lines.join("\n");
  assert.equal(grokTrustWaiting(screen(grokCutScreen(32))), "Do you trust the contents of thi / Yes, proceed y / No, quit n");
  assert.equal(grokTrustWaiting(screen(grokCutScreen(41))), "Do you trust the contents of this directo / Yes, proceed y / No, quit n");
  // Grok 1.0.77 at 32x13 (F105-grok-trust-unanswered-32cols.txt; its folder line is not the recorded private one).
  const recorded = ["", " \ue0a0 task/6f2a32 worktree ~/D/a/\u2026", "", "", "Do you trust the contents of thi", "/home/dev/projects/Entomatical/.",
    " Yes, proceed                 y", " No, quit                     n", "", "", "", "    Grok Build  1.0.77 [stable]", ""];
  assert.equal(grokTrustWaiting(screen(recorded)), "Do you trust the contents of thi / Yes, proceed y / No, quit n");
  // The generic finder still does not take Grok's screen, and keeps other prompts' text as it was (spaces included).
  for (const cols of [32, 41]) assert.equal(waitingPrompt(screen(grokCutScreen(cols))), undefined);
  assert.equal(waitingPrompt("Pick one?\n\u276f 1.  Alpha   (default)\n  2.  Beta"), "Pick one? / \u276f 1.  Alpha   (default) / 2.  Beta");
  const [question, yes, no, footer] = GROK_CUT[32];
  const not = {
    "another question over Grok-style options": ["", "", "", "", "Run the tests now?", "", yes, no, "", "", "", footer],
    "the whole question (the trust-yn row answers that one)": ["", "", "", "", "Do you trust the contents of this directory?", "", yes, no, "", footer],
    "the options without the question": ["", "", "", "", "", "", yes, no, "", "", "", footer],
    "only one of the options": ["", "", "", "", question, "", yes, "", "", "", "", footer],
    "a cut line that is not Grok's question": ["", "", "", "", "Do you trust the contents of tha", "", yes, no, "", "", "", footer],
    "too little of the question": ["", "", "", "", "Do you trust the", "", yes, no, "", "", "", footer],
    "the question indented, as in a quote": ["", "", "", "", `  ${question}`, "", yes, no, "", "", "", footer],
    "seven lines between the question and the options": [question, "", "x", "x", "x", "x", "x", "x", yes, no, "", footer],
    "no version footer": ["", "", "", "", question, "", yes, no],
    "another last line where Grok's footer is": ["", "", "", "", question, "", yes, no, "", "", "", "    End of report, 24 November"],
    "a line after the footer": ["", "", "", "", question, "", yes, no, "", footer, "> "],
    "a line between the options and the footer": ["", "", "", "", question, "", yes, no, "Press y", "", footer],
    "the question quoted in ordinary output": ["\u25cf Grok asked: Do you trust the", "  contents of this directory? I said", "  nothing yet.", "", "> "],
    "the dialog in a diff": grokCutScreen(32).map((l) => `+    "${l}",`),
  };
  for (const [kind, lines] of Object.entries(not)) assert.equal(grokTrustWaiting(screen(lines)), undefined, kind);
});

test("F105: Grok's cut trust question at 32 and 41 columns gets exactly one y, and one Waiting event only if it stays 30 s; near misses get neither", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const step = async (ms) => { for (let i = 0; i < ms / 100; i++) { t.mock.timers.tick(100); await new Promise((r) => setImmediate(r)); } };
  // A card terminal as the native run started Grok (spawnCommand, the unattended start-up watcher) at cols x 13; each step draws a
  // screen and lets the given time pass. Its screen parses each write at once: under mocked timers xterm's own write queue can leave a
  // later write unparsed, so a screen that replaced the dialog would never show.
  const syncScreen = (cols, rows) => {
    const screen = new (require("@xterm/headless").Terminal)({ cols, rows, scrollback: 1000, allowProposedApi: true, logLevel: "off" });
    screen.write = (data) => screen._core.writeSync(data);
    return screen;
  };
  const watch = async (cols, battle, steps) => {
    const pty = fakePty(), terms = new CardTerminals(() => true, () => pty, syncScreen), events = [];
    terms.isUnattended = () => battle;
    terms.onWaiting((e) => events.push(e.lines));
    try {
      const { generation } = terms.spawnCommand({ id: "a", file: "grok", args: [], cwd: path.resolve("."), env: {} });
      terms.resize("a", generation, cols, 13);
      for (const [data, ms] of steps) { pty.data(data); await step(ms); }
      return { events, typed: pty.calls.input, lastLines: terms.screen("a", 13).text };
    } finally { terms.dispose(); }
  };
  for (const cols of [32, 41]) {
    const dialog = draw(grokCutScreen(cols)), block = `${GROK_CUT[cols][0]} / Yes, proceed y / No, quit n`;
    for (const battle of [true, false]) {
      assert.equal(require("../out/cardTerminal.js").grokTrustWaiting(grokCutScreen(cols).join("\n")), block);
      const early = await watch(cols, battle, [[dialog, 300]]);
      assert.deepEqual([early.events, early.typed], [[], []], `${cols} columns, unattended ${battle}: nothing before the screen settles`);
      // Grok goes on after the "y": no event.
      const passed = await watch(cols, battle, [[dialog, 1_000], [draw([" ✳ Working…"]), 40_000]]);
      assert.deepEqual([passed.events, passed.typed], [[], ["y"]], `${cols} columns, unattended ${battle}: Grok went on`);
      // The "y" did not take (this stand-in Grok ignores it and redraws the same dialog): answered once, then one Waiting event.
      const stuck = await watch(cols, battle, [[dialog, 10_000], [dialog, 10_000], [dialog, 9_000]]);
      assert.deepEqual([stuck.events, stuck.typed], [[], ["y"]], `${cols} columns, unattended ${battle}: no event before 30 s`);
      const shown = await watch(cols, battle, [[dialog, 10_000], [dialog, 10_000], [dialog, 11_000], [dialog, 31_000], [dialog, 31_000]]);
      assert.deepEqual([shown.events, shown.typed], [[block], ["y"]], `${cols} columns, unattended ${battle}: still there after 30 s`);
    }
  }
  // An unattended card answers it again after it left the screen and came back; any other card only in its first 60 s.
  const again = [[draw(grokCutScreen(32)), 1_000], [draw([" ✳ Working…"]), 1_000], [draw(grokCutScreen(32)), 1_000]];
  assert.deepEqual((await watch(32, true, again)).typed, ["y", "y"], "unattended, shown twice");
  assert.deepEqual((await watch(32, false, again)).typed, ["y"], "attended, shown twice");
  assert.deepEqual((await watch(32, false, [[draw([" ✳ Working…"]), 61_000], [draw(grokCutScreen(32)), 1_000]])).typed, [], "attended, after 60 s");
  const [question, yes, no, footer] = GROK_CUT[32];
  const nearMisses = {
    "the cut question without Grok's footer": ["", "", "", "", question, "", yes, no],
    "the options in the other order": ["", "", "", "", question, "", no, yes, "", "", "", footer],
    "a cut question that is not a prefix of Grok's": ["", "", "", "", "Do you trust the contents of tha", "", yes, no, "", "", "", footer],
  };
  for (const [kind, lines] of Object.entries(nearMisses)) {
    const seen = await watch(32, true, [[draw(lines), 40_000]]);
    assert.deepEqual([seen.events, seen.typed], [[], []], kind);
  }
  const ordinary = (n) => Array.from({ length: n }, (_, i) => `● step ${i + 1}: read src/board.ts`).join("\r\n") + "\r\n";
  const controls = {
    "the question quoted in ordinary output": [[draw(["● Grok asked: Do you trust the", "  contents of this directory?", "", "> "]), 40_000]],
    "the options without the question": [[draw(grokCutScreen(32).map((l) => (l.startsWith("Do you") ? "" : l))), 40_000]],
  };
  for (const [kind, steps] of Object.entries(controls)) {
    const seen = await watch(32, true, steps);
    assert.deepEqual([seen.events, seen.typed], [[], []], kind);
  }
  // A near miss in scrollback: the whole dialog scrolled up and the screen cleared in the same write, so its rows are blank before the
  // screen settles. The board's screen() text reaches back into the scrollback past the blank rows and still holds the whole dialog, but
  // nothing is waiting there and nothing is typed.
  const { grokTrustWaiting } = require("../out/cardTerminal.js");
  const scrolled = await watch(32, true, [[draw(grokCutScreen(32)) + "\r\n".repeat(13) + "\u001b[2J\u001b[H", 40_000]]);
  assert.equal(grokTrustWaiting(scrolled.lastLines), "Do you trust the contents of thi / Yes, proceed y / No, quit n", "the scrollback holds the dialog");
  assert.deepEqual([scrolled.events, scrolled.typed], [[], []], "the dialog in scrollback, the screen blank");
});
