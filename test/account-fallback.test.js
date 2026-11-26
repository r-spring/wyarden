const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { providerFailure } = require("../out/worker");
const { otherAccountDirs, DEFAULT_DIR } = require("../out/sessions");

// The shape of a real Fable-limit answer (28 Oct 2026, sample-project): exit 1, empty stderr, the reason only in the JSON.
const LIMIT = "You've reached your Fable limit. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";
const limited = [
  { type: "system", subtype: "init", model: "claude-fable-5-1" },
  { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day_overage_included", resetsAt: 1793329200 } },
  { type: "assistant", api_error_status: 429, error: "rate_limit", message: { model: "<synthetic>", content: [{ type: "text", text: LIMIT }] } },
  { type: "result", subtype: "success", is_error: true, api_error_status: 429, result: LIMIT },
];

test("providerFailure reads the provider's own reason and spots usage limits", () => {
  assert.deepEqual(providerFailure(JSON.stringify(limited), "", true), { message: LIMIT, limited: true });
  assert.deepEqual(providerFailure("not json", "Error: not logged in\n", true), { message: "Error: not logged in", limited: false });
  assert.deepEqual(providerFailure("", "", true), { message: undefined, limited: false });
  // Codex exec's JSON lines (seen 26 Oct 2026 on a rate-limited review).
  const codex = [{ type: "thread.started" }, { type: "turn.started" }, { type: "error", message: "exceeded retry limit, last status: 429 Too Many Requests" },
    { type: "turn.failed", error: { message: "exceeded retry limit, last status: 429 Too Many Requests" } }].map((e) => JSON.stringify(e)).join("\n");
  assert.deepEqual(providerFailure(codex, "", false), { message: "exceeded retry limit, last status: 429 Too Many Requests", limited: true });
});

test("otherAccountDirs: every other signed-in Claude folder, in order, ~/.claude written as empty", () => {
  const all = [{ name: "a", configDir: "" }, { name: "b", configDir: "/h/.claude-accounts/b" }, { name: "c", configDir: "/h/.claude-accounts/c" }];
  assert.deepEqual(otherAccountDirs("", all), ["/h/.claude-accounts/b", "/h/.claude-accounts/c"]);
  assert.deepEqual(otherAccountDirs(DEFAULT_DIR, all), ["/h/.claude-accounts/b", "/h/.claude-accounts/c"]);
  assert.deepEqual(otherAccountDirs("/h/.claude-accounts/b", all), ["", "/h/.claude-accounts/c"]);
});

// Runs in its own Node process: spawn is replaced before the worker loads.
async function fallback() {
  const assert = require("node:assert/strict"), path = require("node:path");
  const { EventEmitter } = require("node:events"), { PassThrough, Writable } = require("node:stream");
  const [workerFile, textFile, dir, limitedJson] = process.argv.slice(2);
  const calls = [];
  let limitedAccounts = new Set(), brokenAccounts = new Set(), fableOnly = false;
  const models = [];
  require("node:child_process").spawn = (binary, args, options) => {
    // The CLI is handed the full id (models.ts CLAUDE_MODEL_IDS); model is its family for the fake's own answer.
    const account = options.env.CLAUDE_CONFIG_DIR ?? "", id = args[args.indexOf("--model") + 1], model = id.replace(/^claude-([a-z]+)-[\d-]+$/, "$1");
    calls.push(account); models.push(`${id}/${args[args.indexOf("--effort") + 1]}`);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    const ok = { type: "result", subtype: "success", is_error: false, session_id: "s", structured_output: { title: "Fallback check" }, subagent_stats: { spawned: 0 },
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: { [`claude-${model}-5-5`]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } };
    child.stdin = new Writable({ write(c, e, cb) { cb(); }, final(cb) {
      cb(); queueMicrotask(() => {
        if (limitedAccounts.has(account) && (!fableOnly || model === "fable")) { child.stdout.end(limitedJson); child.emit("close", 1); }
        else if (brokenAccounts.has(account)) { child.stderr.end("Error: not logged in\n"); child.stdout.end(""); child.emit("close", 1); }
        else { child.stdout.end(JSON.stringify(ok)); child.emit("close", 0); }
      });
    } });
    return child;
  };
  const { generateText } = require(textFile);
  const signal = new AbortController().signal;
  // The first account is over its limit: the call is answered by the next one, and says so.
  limitedAccounts = new Set(["", "/a/b"]);
  const r = await generateText(path.join(dir, "one"), "title", "Name this.", "", "haiku", "", signal, undefined, undefined, ["/a/b", "/a/c"]);
  assert.deepEqual(calls, ["", "/a/b", "/a/c"]);
  assert.equal(r.configDir, "/a/c");
  assert.equal(r.note, "~/.claude, b hit a usage limit, so c answered instead.");
  // Every account over its limit: one clear error naming them all and the provider's reason.
  calls.length = 0; limitedAccounts = new Set(["", "/a/b"]);
  await assert.rejects(generateText(path.join(dir, "two"), "title", "Name this.", "", "haiku", "", signal, undefined, undefined, ["/a/b"]),
    (e) => /Every signed-in Claude account hit a usage limit \(~\/\.claude, b\)\. Claude on b stopped \(exit 1\): You've reached your Fable limit/.test(e.message)
      && e.allLimited === true && e.accounts.join() === "~/.claude,b" && e.reason.startsWith("You've reached your Fable limit."));
  assert.deepEqual(calls, ["", "/a/b"]);
  // A single account over its limit is every account too: the flag textJob moves Fable to Opus on.
  calls.length = 0;
  await assert.rejects(generateText(path.join(dir, "solo"), "title", "Name this.", "", "haiku", "", signal), (e) => e.allLimited === true && e.accounts.join() === "~/.claude" && e.reason.startsWith("You've reached your Fable limit."));
  // Any other failure stops at once, with the provider's own message, and never tries another account.
  calls.length = 0; limitedAccounts = new Set(); brokenAccounts = new Set([""]);
  await assert.rejects(generateText(path.join(dir, "three"), "title", "Name this.", "", "haiku", "", signal, undefined, undefined, ["/a/b"]),
    (e) => /Claude on ~\/\.claude stopped \(exit 1\): Error: not logged in/.test(e.message) && !e.allLimited);
  assert.deepEqual(calls, [""]);
  // the user, 29 Oct 2026: Fable over its limit on every account carries on with Opus, at the same effort, trying each account again.
  calls.length = 0; models.length = 0; brokenAccounts = new Set(); limitedAccounts = new Set(["", "/a/b"]); fableOnly = true;
  const opus = await generateText(path.join(dir, "four"), "title", "Name this.", "", "fable", "", signal, "max", undefined, ["/a/b"]);
  assert.deepEqual(calls, ["", "/a/b", ""]);
  assert.deepEqual(models, ["claude-fable-5-2/max", "claude-fable-5-2/max", "claude-opus-5-5/max"]);
  assert.equal(opus.model, "claude-opus-5-5");
  assert.equal(opus.note, "Every signed-in Claude account hit its Fable limit, so Opus answered instead.");
  // Other models never change: an Opus call over its limit is still an error.
  calls.length = 0; models.length = 0; fableOnly = false; limitedAccounts = new Set([""]);
  await assert.rejects(generateText(path.join(dir, "five"), "title", "Name this.", "", "opus", "", signal), (e) => e.allLimited === true);
  assert.deepEqual(models, ["claude-opus-5-5/medium"]);
}

test("a Claude helper call that hits a usage limit moves to the next signed-in account; other failures do not", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-fallback-"));
  try {
    const script = path.join(dir, "fallback.cjs");
    fs.writeFileSync(script, `(${fallback.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`);
    execFileSync(process.execPath, [script, require.resolve("../out/worker"), require.resolve("../out/text-actions"), dir, JSON.stringify(limited)], { encoding: "utf8", timeout: 15_000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
