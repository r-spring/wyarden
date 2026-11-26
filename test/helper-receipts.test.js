// Helper calls run outside the repository and keep an exact record of every provider process (4 November 2026 review, items 1.1, 1.2,
// 2.6): src/worker.ts neutralExecutionDir, helperInputKey, HelperAttempt, and the mixed-failure message.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { insideRepository, neutralExecutionDir, helperInputKey } = require("../out/worker");

test("the neutral execution folder is fresh, empty and outside any repository; repositories are found by their .git entry", () => {
  const a = neutralExecutionDir(), b = neutralExecutionDir();
  try {
    assert.notEqual(a.dir, b.dir);
    assert.equal(a.outsideRepository, true);
    assert.equal(insideRepository(a.dir), false);
    assert.deepEqual(fs.readdirSync(a.dir), []);
    assert.equal(insideRepository(__dirname), true, "this test file sits in the Entomatical repository");
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), "ab-repo-"));
    fs.writeFileSync(path.join(fake, ".git"), "gitdir: elsewhere\n"); // a worktree's .git is a file
    fs.mkdirSync(path.join(fake, "deep", "er"), { recursive: true });
    assert.equal(insideRepository(path.join(fake, "deep", "er")), true);
    fs.rmSync(fake, { recursive: true, force: true });
  } finally { fs.rmSync(a.dir, { recursive: true, force: true }); fs.rmSync(b.dir, { recursive: true, force: true }); }
});

test("the input key changes with any of provider, model, effort, prompt or schema", () => {
  const base = { provider: "claude", model: "fable", effort: "max", prompt: "p", schema: { a: 1 } };
  const k = helperInputKey(base);
  assert.equal(helperInputKey({ ...base }), k);
  for (const change of [{ provider: "codex" }, { model: "opus" }, { effort: "high" }, { prompt: "p " }, { schema: { a: 2 } }])
    assert.notEqual(helperInputKey({ ...base, ...change }), k, JSON.stringify(change));
});

// The real runner with spawn intercepted, in its own Node process (as test/account-fallback.test.js does).
async function scenarios() {
  const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
  const { EventEmitter } = require("node:events"), { PassThrough, Writable } = require("node:stream");
  const [workerFile, dir] = process.argv.slice(2);
  const spawns = [];
  let plan = []; // per spawn: "ok" | "limited" | "slow"
  const LIMIT = "You've reached your Fable limit.";
  const limited = JSON.stringify([{ type: "system", subtype: "init", cwd: "x", claude_code_version: "2.1.318" },
    { type: "rate_limit_event", rate_limit_info: { status: "rejected" } }, { type: "result", subtype: "success", is_error: true, api_error_status: 429, result: LIMIT }]);
  require("node:child_process").spawn = (file, args, options) => {
    const kind = plan.shift() ?? "ok", model = (args[args.indexOf("--model") + 1] || "gpt-a").replace(/^claude-([a-z]+)-[\d-]+$/, "$1");
    const inputSaved = fs.existsSync(path.join(currentDir, "text.input.json"));
    spawns.push({ file, args, cwd: options.cwd, account: options.env.CLAUDE_CONFIG_DIR ?? "", inputSaved, cwdExists: fs.existsSync(options.cwd) });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { child.killed = true; return true; };
    const ok = [{ type: "system", subtype: "init", cwd: options.cwd, claude_code_version: "2.1.318", model: `claude-${model}-5-5` },
      { type: "assistant", message: { model: `claude-${model}-5-5`, content: [] }, session_id: "s" },
      { type: "result", subtype: "success", is_error: false, session_id: "s", structured_output: { title: "Receipt check" }, subagent_stats: { spawned: 0 }, total_cost_usd: 0.25,
        usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: { [`claude-${model}-5-5`]: { inputTokens: 3, outputTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }];
    child.stdin = new Writable({ write(c, e, cb) { cb(); }, final(cb) {
      cb();
      if (kind === "slow") { setTimeout(() => { child.stdout.end(JSON.stringify(ok)); child.emit("close", 0); }, 50); return; } // answers after the cancel
      queueMicrotask(() => {
        if (kind === "limited") { child.stdout.end(limited); child.emit("close", 1); }
        else { child.stdout.end(JSON.stringify(ok)); child.emit("close", 0); }
      });
    } });
    return child;
  };
  const { textCall, textJob } = require(workerFile);
  let currentDir = "";
  const schema = { type: "object", properties: { title: { type: "string" } } };
  const at = (name) => (currentDir = path.join(dir, name));

  // 1. One answer: neutral cwd outside the helper folder, input saved first, the attempt recorded with the provider's own telemetry.
  const one = await textCall(at("one"), "haiku", path.join(dir, "acct-a"), "Name this.", schema, new AbortController().signal, "low");
  const s1 = spawns[0];
  assert.ok(s1.inputSaved, "the input record exists before the process starts");
  assert.ok(s1.cwdExists && !s1.cwd.startsWith(dir) && path.basename(s1.cwd).startsWith("entomatical-helper-"), s1.cwd);
  assert.equal(fs.existsSync(s1.cwd), false, "the neutral folder is removed after the process exits");
  assert.equal(one.attempts.length, 1);
  const a = one.attempts[0];
  assert.deepEqual([a.outcome, a.account, a.model, a.effort, a.cwd, a.wslCd, a.cwdOutsideRepository, a.exitCode], ["answered", "acct-a", "haiku", "low", s1.cwd, null, true, 0]);
  assert.deepEqual(a.reported, { model: "claude-haiku-5-5", cwd: s1.cwd, version: "2.1.318" });
  assert.equal(a.costUsd, 0.25);
  assert.equal(a.argv[a.argv.indexOf("--json-schema") + 1], "<text.schema.json>", "the long inline schema is named, not copied");
  assert.ok(!JSON.stringify(a).includes("CLAUDE_CONFIG_DIR"), "no environment is recorded");
  assert.ok(fs.existsSync(path.join(currentDir, a.providerOutput)), "each attempt has its own output file");
  assert.ok(typeof one.durationMs === "number" && one.inputKey);
  // Asked again with the same input, the saved answer is reused without a process; with a different prompt it is not.
  const again = await textCall(currentDir, "haiku", path.join(dir, "acct-a"), "Name this.", schema, new AbortController().signal, "low");
  assert.equal(spawns.length, 1);
  assert.equal(again.inputKey, one.inputKey);
  await textCall(currentDir, "haiku", path.join(dir, "acct-a"), "Name something else.", schema, new AbortController().signal, "low");
  assert.equal(spawns.length, 2, "a different input is a new call");

  // 2. Account fallback: the limited attempt and the answering one are both recorded.
  plan = ["limited", "ok"];
  const two = await textCall(at("two"), "fable", path.join(dir, "acct-a"), "Refine.", schema, new AbortController().signal, "max", undefined, [path.join(dir, "acct-b")]);
  assert.deepEqual(two.attempts.map((x) => [x.n, x.account, x.outcome]), [[1, "acct-a", "limited"], [2, "acct-b", "answered"]]);
  assert.match(two.note, /acct-a hit a usage limit, so acct-b answered instead/);
  assert.ok(two.attempts[0].providerOutput !== two.attempts[1].providerOutput);

  // 3. A limit, then a cancel: the message says what happened, and it is not "every account hit a usage limit".
  plan = ["limited", "slow"];
  const controller = new AbortController();
  const p3 = textCall(at("three"), "fable", path.join(dir, "acct-a"), "Refine.", schema, controller.signal, "max", undefined, [path.join(dir, "acct-b")]);
  setTimeout(() => controller.abort(), 10);
  const e3 = await p3.then(() => assert.fail("a cancelled call must not succeed"), (e) => e);
  assert.equal(e3.message, "acct-a hit a usage limit; acct-b then failed: Text generation cancelled or timed out.");
  assert.equal(e3.allLimited, false);
  assert.deepEqual(e3.attempts.map((x) => x.outcome), ["limited", "cancelled"]);
  await new Promise((r) => setTimeout(r, 80)); // the late answer arrives
  assert.equal(e3.attempts[1].outcome, "cancelled", "a late close does not turn the cancel into success");
  assert.ok(fs.existsSync(path.join(currentDir, "text.provider-output.jsonl")), "the late output is still kept as evidence");
  assert.equal(fs.existsSync(path.join(currentDir, "text.result.json")), false);

  // 4. Every account limited: the old message stands, and allLimited lets textJob move Fable to Opus; both runs' attempts are kept.
  plan = ["limited", "limited", "ok"];
  const four = await textJob(at("four"), "fable", path.join(dir, "acct-a"), "Refine.", schema, new AbortController().signal, "max", undefined, [path.join(dir, "acct-b")]);
  assert.deepEqual(four.attempts.map((x) => [x.n, x.model, x.outcome]), [[1, "fable", "limited"], [2, "fable", "limited"], [3, "opus", "answered"]]);

  // 5. Codex in WSL: the neutral folder goes to wsl.exe --cd, and is recorded as such.
  spawns.length = 0;
  require("node:child_process").spawn = (file, args, options) => {
    spawns.push({ file, args, cwd: options.cwd, wslUtf8: options.env.WSL_UTF8 });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdin = new Writable({ write(c, e, cb) { cb(); }, final(cb) { cb(); queueMicrotask(() => {
      child.stdout.end([{ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ title: "WSL" }) } }, { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } }]
        .map((e) => JSON.stringify(e)).join("\n") + "\n"); child.emit("close", 0); }); } });
    return child;
  };
  const five = await textCall(at("five"), "gpt-a", "", "Name this.", schema, new AbortController().signal, "medium", "wsl:Ubuntu");
  const w = spawns[0];
  assert.equal(w.file, "wsl.exe");
  assert.equal(w.args[w.args.indexOf("--cd") + 1], w.cwd);
  assert.equal(w.wslUtf8, "1", "wsl.exe writes its own messages as UTF-8, not UTF-16 (F20-4)");
  assert.ok(!w.cwd.startsWith(dir));
  assert.deepEqual([five.attempts[0].provider, five.attempts[0].wslCd, five.attempts[0].reported], ["codex", w.cwd, { model: null, cwd: null, version: null }]);
  assert.deepEqual(five.attempts[0].usage, { input_tokens: 5, output_tokens: 2 });
}

test("attempts: neutral cwd, input first, telemetry, fallback, a cancel after a limit, Fable to Opus, Codex in WSL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-helper-receipts-"));
  try {
    const script = path.join(dir, "scenarios.cjs");
    fs.writeFileSync(script, `(${scenarios.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`);
    execFileSync(process.execPath, [script, require.resolve("../out/worker"), dir], { encoding: "utf8", timeout: 20_000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Findings from session 3482f4's review of F19/F20 (4 November 2026): split UTF-8, Codex error events, stray lines, the no-tool flags.
async function codexAndEncoding() {
  const assert = require("node:assert/strict"), path = require("node:path");
  const { EventEmitter } = require("node:events"), { PassThrough, Writable } = require("node:stream");
  const [workerFile, dir] = process.argv.slice(2);
  let emit = () => {};
  const spawns = [];
  require("node:child_process").spawn = (file, args) => {
    spawns.push(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdin = new Writable({ write(c, e, cb) { cb(); }, final(cb) { cb(); queueMicrotask(() => emit(child)); } });
    return child;
  };
  const { textCall } = require(workerFile);
  const schema = { type: "object" }, signal = new AbortController().signal;
  const title = "Überprüfe die Tests · 中文 ✓";
  const writeSplit = (stream, text) => { const b = Buffer.from(text, "utf8"); for (let i = 0; i < b.length; i += 7) stream.write(b.subarray(i, i + 7)); };

  // Claude stream-json and Claude json, delivered 7 bytes at a time so every multi-byte character is split somewhere.
  for (const stream of [true, false]) {
    const seen = [];
    emit = (child) => {
      const model = "claude-haiku-5-5";
      const events = [{ type: "system", subtype: "init" }, { type: "assistant", message: { model, content: [] }, session_id: "s" },
        { type: "result", subtype: "success", is_error: false, session_id: "s", structured_output: { title }, subagent_stats: { spawned: 0 },
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: { [model]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }];
      writeSplit(child.stdout, stream ? events.map((e) => JSON.stringify(e)).join("\n") : JSON.stringify(events));
      child.stdout.end(); child.emit("close", 0);
    };
    const r = await textCall(path.join(dir, `claude-${stream}`), "haiku", "", "p", schema, signal, "low", undefined, [], stream ? (t) => seen.push(t) : undefined);
    assert.equal(r.value.title, title, `Claude ${stream ? "stream-json" : "json"}`);
  }

  // Codex: a stray login-shell line, a reconnect error event, then the answer, split mid-character.
  const answer = (text) => [{ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ title: text }) } }, { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } }];
  emit = (child) => {
    const lines = ["Welcome to Ubuntu (printed by ~/.profile)", JSON.stringify({ type: "thread.started" }),
      JSON.stringify({ type: "error", message: "Reconnecting... 1/2 (stream disconnected before completion)" }), ...answer(title).map((e) => JSON.stringify(e))];
    writeSplit(child.stdout, lines.join("\n") + "\n"); child.stdout.end(); child.emit("close", 0);
  };
  const c = await textCall(path.join(dir, "codex-reconnect"), "gpt-a", "", "p", schema, signal, "medium", "/fake/codex");
  assert.equal(c.value.title, title, "a reconnect error followed by an answer is an answer");
  const flags = spawns.at(-1);
  for (const f of ["--sandbox", "read-only", "--disable", "shell_tool", 'web_search="disabled"', "project_doc_max_bytes=0", "--ignore-user-config", "--ignore-rules"])
    assert.ok(flags.includes(f), `Codex flag ${f}`);
  assert.equal(flags[flags.indexOf("--sandbox") + 1], "read-only");

  // An error event with no answer and no completed turn still fails, as does turn.failed.
  emit = (child) => { child.stdout.end(JSON.stringify({ type: "error", message: "unexpected status 401" }) + "\n"); child.emit("close", 0); };
  await assert.rejects(textCall(path.join(dir, "codex-error"), "gpt-a", "", "p", schema, signal, "medium", "/fake/codex"), /Codex stopped: unexpected status 401/);
  emit = (child) => { child.stdout.end([...answer("x"), { type: "turn.failed", error: { message: "boom" } }].map((e) => JSON.stringify(e)).join("\n") + "\n"); child.emit("close", 0); };
  await assert.rejects(textCall(path.join(dir, "codex-failed"), "gpt-a", "", "p", schema, signal, "medium", "/fake/codex"), /Codex stopped: boom/);

  // F103: a Claude process that exits non-zero leaves its exit code and the end of its stderr on the error, for the error log.
  emit = (child) => { child.stderr.write(`${"w".repeat(5000)}\nError: not logged in\n`); setImmediate(() => { child.stdout.end(""); child.emit("close", 1); }); };
  const failed = await textCall(path.join(dir, "claude-exit"), "haiku", "", "p", schema, signal, "low").then(() => undefined, (e) => e);
  assert.match(failed.message, /stopped \(exit 1\): Error: not logged in/);
  assert.equal(failed.exitCode, 1);
  assert.ok(failed.stderrTail.endsWith("Error: not logged in\n") && failed.stderrTail.length === 2048, "the last 2 KB of stderr");
}

test("split UTF-8 survives on Claude and Codex; a Codex reconnect error before an answer is not a failure; stray lines are skipped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-helper-codex-"));
  try {
    const script = path.join(dir, "codex.cjs");
    fs.writeFileSync(script, `(${codexAndEncoding.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`);
    execFileSync(process.execPath, [script, require.resolve("../out/worker"), dir], { encoding: "utf8", timeout: 20_000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Codex text actions publish and cache only a completed turn's answer", async (t) => {
  const { generateText } = require("../out/text-actions");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ab-codex-turn-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recording = path.join(root, "events.jsonl");
  const childProcess = require("node:child_process"), spawn = childProcess.spawn;
  let launches = 0;
  // Run a local Node CLI on both platforms with the worker's real stdin, stdout and exit handling.
  t.mock.method(childProcess, "spawn", (file, args, options) => {
    assert.equal(file, "fixture-codex");
    launches++;
    return spawn(process.execPath, ["-e", 'process.stdin.resume(); process.stdout.write(require("node:fs").readFileSync(process.argv[1]));', recording], options);
  });
  const started = { type: "turn.started" }, completed = { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } };
  const message = (value) => ({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } });
  const record = (...events) => fs.writeFileSync(recording, events.map((event) => JSON.stringify(event)).join("\n"));
  const read = (folder, file) => JSON.parse(fs.readFileSync(path.join(folder, file), "utf8"));
  const answers = [];
  const run = (folder, purpose) => generateText(folder, purpose, "Name the work", "", "gpt-a", "", new AbortController().signal,
    "medium", "fixture-codex", [], "", { line: (text, channel) => { if (channel === "answer") answers.push(text); } });

  const titles = path.join(root, "titles");
  record(message({ title: "interim" }));
  await assert.rejects(run(titles, "title"), /completed turn/i);
  assert.equal(fs.existsSync(path.join(titles, "text.result.json")), false);
  assert.deepEqual(answers, []);

  const draft = { kind: "revision", revision: "Check the result.", questions: [], assumptions: [] };
  const revise = message(draft);
  for (const [name, events, reason] of [
    ["incomplete", [started, revise], /completed turn/i],
    ["failed", [started, revise, { type: "turn.failed", error: { message: "interrupted" } }], /interrupted/],
    ["later turn", [started, revise, started, completed], /no structured answer/i],
    ["earlier completion", [started, completed, revise], /completed turn/i],
    ["unstructured final", [started, revise, { type: "item.completed", item: { type: "agent_message", text: "Still working." } }, completed], /no structured answer/i],
  ]) {
    const folder = path.join(root, name);
    record(...events);
    await assert.rejects(run(folder, "refine"), reason);
    const receipt = read(folder, "refine-receipt.json"), [attempt] = receipt.attempts;
    assert.deepEqual([receipt.receiptStatus, attempt.outcome, attempt.exitCode], ["failed", "failed", 0]);
    assert.match(attempt.error, reason);
    assert.equal(fs.readFileSync(path.join(folder, attempt.providerOutput), "utf8"), fs.readFileSync(recording, "utf8"));
    assert.equal(fs.existsSync(path.join(folder, "text.result.json")), false);
    assert.deepEqual(answers, []);
  }

  record(started, { type: "error", message: "Reconnecting... 1/2" }, message({ title: "interim" }), message({ title: "Completed title" }), completed);
  const result = await run(titles, "title");
  assert.deepEqual([result.value.title, result.attempts[0].outcome, result.usage], ["Completed title", "answered", completed.usage]);
  assert.deepEqual(answers, [JSON.stringify(result.value)]);
  const calls = launches;
  assert.deepEqual((await run(titles, "title")).value, result.value);
  assert.equal(launches, calls, "the completed answer is reusable");

  // An earlier build could cache the same title and answered receipt from an incomplete stream.
  const saved = read(titles, "text.result.json");
  record(message(saved.value));
  fs.copyFileSync(recording, path.join(titles, "text.provider-output.jsonl"));
  await assert.rejects(run(titles, "title"), /completed turn/i);
  assert.equal(launches, calls + 1, "retry the unproven cached answer");
  assert.equal(fs.existsSync(path.join(titles, "text.result.json")), false);
});

// Refine draft and Improve prompt receipts: pending before the process, exact input, then the outcome (item 1.2).
async function operationReceipts() {
  const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
  const { EventEmitter } = require("node:events"), { PassThrough, Writable } = require("node:stream");
  const [textFile, dir] = process.argv.slice(2);
  let emit = () => {}, receiptAtSpawn;
  let watch = "";
  require("node:child_process").spawn = (file, args) => {
    receiptAtSpawn = fs.existsSync(watch) ? JSON.parse(fs.readFileSync(watch, "utf8")) : undefined;
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdin = new Writable({ write(c, e, cb) { cb(); }, final(cb) { cb(); queueMicrotask(() => emit(child)); } });
    return child;
  };
  const { generateText, REFINE_PROMPT_VERSION } = require(textFile);
  const codexAnswer = (value) => (child) => { child.stdout.end([{ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } },
    { type: "turn.completed", usage: { input_tokens: 9, output_tokens: 3 } }].map((e) => JSON.stringify(e)).join("\n") + "\n"); child.emit("close", 0); };
  const draft = "Fix the flaky test.\n\n- keep `test/voice.test.js`\n  - indented line\tand a tab\nÜmlaut 中文", answers = "Which?\nAll of them";

  emit = codexAnswer({ kind: "revision", revision: "Goal: fixed.", questions: [], assumptions: [] });
  const folder = path.join(dir, "refine"); watch = path.join(folder, "refine-receipt.json");
  const r = await generateText(folder, "refine", draft, "", "gpt-a", answers, new AbortController().signal, "medium", "/fake/codex", [], "CONTEXT");
  assert.equal(receiptAtSpawn?.receiptStatus, "pending", "the receipt exists before the provider process starts");
  assert.equal(receiptAtSpawn.draft, draft, "multi-line text is stored exactly");
  const done = JSON.parse(fs.readFileSync(watch, "utf8"));
  assert.equal(r.receipt, watch);
  assert.deepEqual([done.receiptStatus, done.kind, done.promptVersion, done.outcome, done.revisionChars, done.answers, done.context, done.provider, done.requestedModel],
    ["done", "refine", REFINE_PROMPT_VERSION, "revision", 12, answers, "CONTEXT", "codex", "gpt-a"]);
  assert.ok(done.input.includes(draft) && done.attempts.length === 1 && typeof done.durationMs === "number");
  assert.equal(done.mode, "draft");

  // Handoff mode (plan 70d079 step 4): its own prompt version and mode, the Full handoff line made exact, unchanged refused.
  const { HANDOFF_REFINE_PROMPT_VERSION } = require(textFile);
  const hp = "C:/repo/docs/handoffs/next.md", handoff = { path: hp, text: "# Goal\nShip it.\n" }, boxed = `<!-- handoff: ${hp} -->\n${handoff.text}`;
  emit = codexAnswer({ kind: "revision", revision: "Goal: ship it.", questions: [], assumptions: [] });
  const hfolder = path.join(dir, "refine-handoff"); watch = path.join(hfolder, "refine-receipt.json");
  const hr = await generateText(hfolder, "refine", boxed, "", "gpt-a", "", new AbortController().signal, "medium", "/fake/codex", [], "", undefined, "", handoff);
  assert.equal(hr.value.revision, `Goal: ship it.\n\nFull handoff: ${hp}`);
  const hdone = JSON.parse(fs.readFileSync(watch, "utf8"));
  assert.deepEqual([hdone.receiptStatus, hdone.mode, hdone.promptVersion, hdone.handoffPath, hdone.draft, hdone.revisionChars],
    ["done", "handoff", HANDOFF_REFINE_PROMPT_VERSION, hp, boxed, hr.value.revision.length]);
  assert.ok(hdone.input.includes(`HANDOFF:\n<handoff>\n${handoff.text}\n</handoff>`) && !hdone.input.includes("DRAFT:"));
  emit = codexAnswer({ kind: "unchanged", revision: "", questions: [], assumptions: [] });
  const hsame = path.join(dir, "refine-handoff-same"); watch = path.join(hsame, "refine-receipt.json");
  await assert.rejects(generateText(hsame, "refine", boxed, "", "gpt-a", "", new AbortController().signal, "medium", "/fake/codex", [], "", undefined, "", handoff), /unchanged/);
  assert.equal(JSON.parse(fs.readFileSync(watch, "utf8")).receiptStatus, "failed");

  // A failure keeps the attempt; a cancel is recorded as cancelled, not failed.
  emit = (child) => { child.stdout.end(JSON.stringify({ type: "turn.failed", error: { message: "boom" } }) + "\n"); child.emit("close", 0); };
  const failing = path.join(dir, "refine-fail"); watch = path.join(failing, "refine-receipt.json");
  await assert.rejects(generateText(failing, "refine", draft, "", "gpt-a", "", new AbortController().signal, "medium", "/fake/codex"), /boom/);
  const failed = JSON.parse(fs.readFileSync(watch, "utf8"));
  assert.deepEqual([failed.receiptStatus, failed.attempts.length, failed.attempts[0].outcome], ["failed", 1, "failed"]);
  assert.match(failed.error, /boom/);
  emit = () => {}; // never answers
  const controller = new AbortController(), cancelling = path.join(dir, "refine-cancel"); watch = path.join(cancelling, "refine-receipt.json");
  const pending = generateText(cancelling, "refine", draft, "", "gpt-a", "", controller.signal, "medium", "/fake/codex");
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, /cancelled/);
  const cancelled = JSON.parse(fs.readFileSync(watch, "utf8"));
  assert.deepEqual([cancelled.receiptStatus, cancelled.attempts[0].outcome], ["cancelled", "cancelled"]);
  // A title call writes no refine receipt.
  emit = codexAnswer({ title: "Short title" });
  const titled = path.join(dir, "title");
  await generateText(titled, "title", "Name it", "", "gpt-a", "", new AbortController().signal, "low", "/fake/codex");
  assert.equal(fs.existsSync(path.join(titled, "refine-receipt.json")), false);
}

test("Refine writes a pending receipt before the call with its exact input, then done, failed or cancelled with its attempts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-refine-receipt-"));
  try {
    const script = path.join(dir, "receipts.cjs");
    fs.writeFileSync(script, `(${operationReceipts.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`);
    execFileSync(process.execPath, [script, require.resolve("../out/text-actions"), dir], { encoding: "utf8", timeout: 20_000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
