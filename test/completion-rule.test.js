const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { validRule, withRule } = require("../out/text-actions");

const GOAL = { goalFound: true, goal: "The test suite passes.", doneWhen: "npm test exits 0.", commands: ["npm test"] };

test("validRule keeps a found goal, drops commands that change things, and refuses broken answers", () => {
  const { rule, dropped } = validRule({ ...GOAL, commands: [" npm test ", "git push origin main", "Remove-Item -Recurse out", "npm install", "Test-Path README.md"] }, false);
  assert.deepEqual(rule, { goal: "The test suite passes.", doneWhen: "npm test exits 0.", commands: ["npm test", "Test-Path README.md"] });
  assert.deepEqual(dropped, ["git push origin main", "Remove-Item -Recurse out", "npm install"]);
  // No goal in the prompt: Haiku may say so; a writer may not.
  assert.deepEqual(validRule({ goalFound: false, goal: "", doneWhen: "", commands: ["npm test"] }, false), { dropped: [] });
  assert.throws(() => validRule({ goalFound: false, goal: "", doneWhen: "", commands: [] }, true), /did not write a goal/);
  assert.throws(() => validRule({ ...GOAL, doneWhen: " " }, false), /left the goal or its done-when sentence empty/);
  for (const bad of [null, { ...GOAL, goalFound: "yes" }, { ...GOAL, commands: "npm test" }, { ...GOAL, commands: Array(6).fill("npm test") }, { ...GOAL, goal: "x".repeat(1001) }, { ...GOAL, goal: "a\x07b" }])
    assert.throws(() => validRule(bad, false), /invalid completion rule/);
  // One command per line: a multi-line entry is dropped, not split. Blank entries are left out.
  assert.deepEqual(validRule({ ...GOAL, commands: ["npm test\nnpm run lint", " "] }, false), { rule: { goal: GOAL.goal, doneWhen: GOAL.doneWhen, commands: [] }, dropped: ["npm test\nnpm run lint"] });
});

test("withRule appends the goal, the done-when sentence and the checks to the prompt", () => {
  const rule = { goal: "The test suite passes.", doneWhen: "npm test exits 0.", commands: ["npm test", "npm run lint"] };
  assert.equal(withRule("Fix the failing test.\n\n", rule), [
    "Fix the failing test.", "", "Done when (added by Entomatical)", "Goal: The test suite passes.", "Done when: npm test exits 0.",
    "Acceptance checks Entomatical runs in this worktree when you stop (each must exit 0):", "- npm test", "- npm run lint"].join("\n"));
  assert.equal(withRule("Tidy up.", { ...rule, commands: [] }),
    "Tidy up.\n\nDone when (added by Entomatical)\nGoal: The test suite passes.\nDone when: npm test exits 0.");
});

// Runs in its own Node process: spawn is replaced before the worker loads.
async function chain() {
  const assert = require("node:assert/strict"), path = require("node:path");
  const { EventEmitter } = require("node:events"), { PassThrough, Writable } = require("node:stream");
  const [textFile, dir] = process.argv.slice(2);
  const rule = { goalFound: true, goal: "Tests and lint pass.", doneWhen: "npm test and npm run lint exit 0.", commands: ["npm test", "npm run lint", "git push"] };
  let value = rule, calls = [], usedAccounts = [], limited = new Set(), broken = false, sent = "";
  require("node:child_process").spawn = (binary, args, options) => {
    const model = args[args.indexOf("--model") + 1].replace(/^claude-([a-z]+)-[\d-]+$/, "$1"), account = options.env.CLAUDE_CONFIG_DIR;
    calls.push(`${model}/${args[args.indexOf("--effort") + 1]}`);
    usedAccounts.push(account);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdin = new Writable({ write(c, e, cb) { sent += c; cb(); }, final(cb) {
      cb(); queueMicrotask(() => {
        if (broken) { child.stderr.end("Error: not logged in\n"); child.stdout.end(""); return child.emit("close", 1); }
        if (limited.has(account)) {
          child.stdout.end(JSON.stringify({ type: "result", is_error: true, api_error_status: 429, result: "You have reached your Fable limit." }));
          return child.emit("close", 1);
        }
        child.stdout.end(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s", subagent_stats: { spawned: 0 },
          structured_output: value,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          modelUsage: { [`claude-${model}-5-1`]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }));
        child.emit("close", 0);
      });
    } });
    return child;
  };
  const { completionRule, reviewRules } = require(textFile);
  const models = { configDir: path.join(dir, "primary"), fallbackConfigDirs: [path.join(dir, "other")] };
  let n = 0;
  const run = async (signal = new AbortController().signal, commands = true) => {
    const steps = []; calls = []; usedAccounts = [];
    const r = await completionRule(path.join(dir, String(n++)), "Fix it and keep lint clean.", {}, models, signal, (s) => steps.push(s), commands);
    return { ...r, steps };
  };

  // One writer at high effort, with the same check filtering and the observed model identity.
  let r = await run();
  assert.deepEqual(calls, ["fable/high"]);
  assert.deepEqual(r.steps, ["Fable is writing the completion rule at high effort…"]);
  // A bare PowerShell Test-Path exits 0 even when the path is missing, so the writer is told each command must fail by itself.
  assert.match(sent, /Each command must itself exit non-zero when its check fails: a bare PowerShell Test-Path X/);
  assert.deepEqual([r.rule.goal, r.rule.commands, r.dropped], ["Tests and lint pass.", ["npm test", "npm run lint"], ["git push"]]);
  assert.deepEqual([r.writer, r.effort, r.answered], ["claude-fable-5-1", "high", []]);
  for (const field of ["haiku", "opus", "judgment"]) assert.equal(field in r, false);
  // Done when alone: an ordinary card's writer is told to leave commands empty, and commands it returns anyway are dropped.
  sent = "";
  r = await run(undefined, false);
  assert.doesNotMatch(sent, /at most five shell commands/);
  assert.match(sent, /leave commands empty/); assert.match(sent, /cannot run anything/); assert.match(sent, /one fact/);
  assert.deepEqual([r.rule.commands, r.dropped, r.rule.promptVersion], [[], [], "done-when-2026-11-08"]);
  value = { ...rule, goalFound: false };
  await assert.rejects(run(), /did not write a goal/);
  value = rule; broken = true;
  await assert.rejects(run(), /not logged in/);
  assert.deepEqual(calls, ["fable/high"]);

  // An account limit may switch accounts, but never switches the requested model.
  broken = false; limited = new Set([models.configDir]);
  r = await run();
  assert.deepEqual(calls, ["fable/high", "fable/high"]);
  assert.deepEqual(usedAccounts, [models.configDir, ...models.fallbackConfigDirs]);
  assert.equal(r.answered[0].configDir, models.fallbackConfigDirs[0]);
  assert.match(r.answered[0].note, /primary hit a usage limit, so other answered instead/);
  limited.add(models.fallbackConfigDirs[0]);
  await assert.rejects(run(), /Every signed-in Claude account hit a usage limit/);
  assert.deepEqual(calls, ["fable/high", "fable/high"]);
  limited.clear();
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(run(cancelled.signal), /cancelled/);
  assert.deepEqual(calls, []);

  // Saved comparison cards keep their existing review behavior and records.
  value = { haikuGoodEnough: false, verdict: "Haiku's checks would have missed the lint error in the diff." };
  const legacy = { ...r.rule, model: "claude-opus-5-5", dropped: [] };
  calls = [];
  const v = await reviewRules(path.join(dir, "review"), { prompt: "Fix it.", haiku: legacy, opus: legacy, pick: "opus", checks: "All acceptance checks passed.", work: "diff" }, models, new AbortController().signal);
  assert.deepEqual([calls, v.haikuGoodEnough, v.model], [["fable/high"], false, "claude-fable-5-1"]);

  // The Done when drop-down (the user, 13 November 2026): a Claude rule runs on the model and effort picked; leaving either out keeps Fable at high.
  value = rule;
  for (const [pick, call, step] of [[{ model: "opus", effort: "max" }, "opus/max", "Opus is writing the completion rule at max effort…"],
    [{ model: "haiku", effort: "medium" }, "haiku/medium", "Haiku is writing the completion rule at medium effort…"],
    [{ model: "opus" }, "opus/high", "Opus is writing the completion rule at high effort…"], [{ effort: "low" }, "fable/low", "Fable is writing the completion rule at low effort…"]]) {
    const steps = []; calls = [];
    const picked = await completionRule(path.join(dir, String(n++)), "Fix it.", {}, { ...models, ...pick }, new AbortController().signal, (s) => steps.push(s), false);
    assert.deepEqual([calls, steps, picked.effort, picked.writer], [[call], [step], call.split("/")[1], `claude-${call.split("/")[0]}-5-1`]);
  }
}

test("Fable alone writes at high effort, preserves account fallback, refuses model fallback, keeps legacy reviews and honours a picked Claude model and effort", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-rule-"));
  try {
    const script = path.join(dir, "chain.cjs");
    fs.writeFileSync(script, `(${chain.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`);
    execFileSync(process.execPath, [script, require.resolve("../out/text-actions"), dir], { encoding: "utf8", timeout: 15_000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
