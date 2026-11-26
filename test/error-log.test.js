// The Review and Finish error log (F103, src/error-log.ts): append, the size cap, redaction, the run records and interrupted runs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const log = require("../out/error-log.js");

const boardDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ab-error-log-")); test.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const entries = (dir) => fs.readFileSync(path.join(dir, "errors.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const card = { id: "c1", title: "Tidy the README" };

test("appendEntry writes one JSON line per entry to <board dir>/errors.jsonl and a one-line summary to the sink", () => {
  const dir = boardDir(), lines = [];
  log.setSink((l) => lines.push(l));
  test.after(() => log.setSink(undefined));
  log.appendEntry(dir, { action: "review", outcome: "timeout", stage: "Calling the reviewer", card, provider: "claude", account: "work", model: "fable", effort: "medium",
    durationMs: 900_012.4, message: "Stopped after fifteen minutes without an answer.", receipt: "/b/helpers/x/review-receipt.json" });
  log.appendEntry(dir, { level: "info", action: "finish", outcome: "cancelled", stage: "Checking the task", card, message: "Finish was cancelled at its dialog." });
  const [a, b] = entries(dir);
  assert.deepEqual(Object.keys(a), ["at", "level", "action", "outcome", "stage", "card", "provider", "account", "model", "effort", "receipt", "durationMs", "message"]);
  assert.deepEqual([a.level, a.durationMs, b.level, b.action], ["error", 900012, "info", "finish"]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[\S+\] ERROR review timeout at "Calling the reviewer": "Tidy the README" \(c1\) \[claude, work, fable · medium\] after 900 s: Stopped after fifteen minutes/);
  assert.equal(log.logFile(dir), path.join(dir, "errors.jsonl"));
});

test("no secrets: unknown fields (an env, a prompt) are dropped, credential-like text is redacted, and long text is cut", () => {
  const dir = boardDir();
  log.appendEntry(dir, { action: "review", card, stage: "Calling the reviewer", message: `Authorization: Bearer abcdefghijklmnop failed; key sk-ant-api03-ABCDEFGHIJKLMNOP ${"m".repeat(5000)}`,
    stderr: `${"s".repeat(4000)}\nOPENAI_API_KEY=sk-proj-1234567890abcdef\nGROQ_API_KEY: "gsk_abcdefghijklmnop"\npassword=hunter2 token='t0k3n' AKIAABCDEFGHIJKLMNOP\nexit`,
    env: { ANTHROPIC_API_KEY: "sk-ant-secret" }, prompt: "the whole prompt", exitCode: 1 });
  const [e] = entries(dir), text = JSON.stringify(e);
  assert.equal(e.env, undefined); assert.equal(e.prompt, undefined);
  for (const secret of ["abcdefghijklmnop", "sk-ant-api03", "sk-proj-1234", "gsk_abcdef", "hunter2", "t0k3n", "AKIAABCDEFGHIJKLMNOP", "sk-ant-secret", "the whole prompt"])
    assert.ok(!text.includes(secret), `${secret} is not in the log`);
  assert.match(e.stderr, /OPENAI_API_KEY=\[redacted\]\nGROQ_API_KEY: \[redacted\]\npassword=\[redacted\] token=\[redacted\] \[redacted\]\nexit$/);
  assert.ok(e.stderr.length <= 2049 && e.stderr.startsWith("…"), "the stderr's end is kept");
  assert.ok(e.message.length <= 2001);
  assert.equal(e.exitCode, 1);
});

test("past the cap the oldest lines go: the newest half is kept and the new line is appended", () => {
  const dir = boardDir(), cap = 4000;
  for (let i = 0; i < 40; i++) log.appendEntry(dir, { action: "finish", card, stage: "Pushing", message: `failure ${i} ${"x".repeat(100)}` }, cap);
  const size = fs.statSync(path.join(dir, "errors.jsonl")).size, kept = entries(dir);
  assert.ok(size <= cap, `${size} bytes`);
  assert.match(kept.at(-1).message, /^failure 39 /);
  assert.ok(kept.length >= 10 && !kept.some((e) => /^failure 0 /.test(e.message)), "the oldest are gone");
  assert.deepEqual(kept.map((e) => +e.message.split(" ")[1]), kept.map((_, i) => 40 - kept.length + i), "in order, none lost in between");
});

test("outcomeOf: limits, timeouts, refusals, invalid replies, runner errors (exit code or stderr, also on a cause)", () => {
  const err = (m, extra = {}) => Object.assign(new Error(m), extra);
  assert.equal(log.outcomeOf(err("Every signed-in Claude account hit a usage limit (a, b).", { allLimited: true })), "limit");
  assert.equal(log.outcomeOf(err("You've reached your Fable limit.")), "limit");
  assert.equal(log.outcomeOf(err("Stopped after fifteen minutes without an answer.")), "timeout");
  assert.equal(log.outcomeOf(err('"X" is already being finished. Nothing was changed.')), "refused");
  assert.equal(log.outcomeOf(err("anything"), "Checking the task"), "refused");
  assert.equal(log.outcomeOf(err("The reviewer returned an invalid verdict.")), "invalid-reply");
  assert.equal(log.outcomeOf(err("Finish stopped while merging: …", { cause: err("did not merge", { exitCode: 1, stderrTail: "x" }) })), "runner-error");
  assert.equal(log.outcomeOf(err("Something broke.")), "failed");
  assert.deepEqual(log.errorDetail(err("outer", { cause: err("inner", { exitCode: null, stderrTail: "tail" }) })), { message: "outer", exitCode: null, stderr: "tail", limited: false });
});

test("startRun keeps a run record while it runs and removes it when it ends; failed() logs once and marks the error", () => {
  const dir = boardDir();
  const run = log.startRun(dir, "finish", card, { account: "work" }, "Checking the task");
  const records = () => fs.readdirSync(path.join(dir, "runs"));
  assert.equal(records().length, 1);
  run.stage("Pushing to origin/main");
  run.set({ model: "opus", effort: "high", permission: "acceptEdits" });
  const record = JSON.parse(fs.readFileSync(path.join(dir, "runs", records()[0]), "utf8"));
  assert.deepEqual([record.pid, record.stage, record.model, record.card], [process.pid, "Pushing to origin/main", "opus", card]);
  const e = new Error("Push to origin/main failed: denied");
  run.failed(e);
  assert.equal(log.wasLogged(e), true);
  assert.deepEqual(records(), []);
  const [entry] = entries(dir);
  assert.deepEqual([entry.stage, entry.model, entry.effort, entry.permission, entry.account], ["Pushing to origin/main", "opus", "high", "acceptEdits", "work"]);
  const ok = log.startRun(dir, "review", card);
  ok.end();
  assert.deepEqual(records(), []);
  assert.equal(entries(dir).length, 1, "a run that completes logs nothing");
});

test("interrupted on activation: a run record whose extension host is gone is logged as interrupted at its stage; a live host's is left", () => {
  const dir = boardDir(), runs = path.join(dir, "runs");
  fs.mkdirSync(runs, { recursive: true });
  const write = (name, r) => fs.writeFileSync(path.join(runs, name), JSON.stringify({ card, startedAt: new Date(Date.now() - 5000).toISOString(), ...r }));
  write("review-dead.json", { action: "review", pid: 999_001, stage: "Calling the reviewer", model: "fable", effort: "medium", account: "work", receipt: "/b/helpers/x/review-receipt.json" });
  write("finish-dead.json", { action: "finish", pid: 999_002, stage: "Resolving the conflict in a.txt", permission: "acceptEdits" });
  write("review-live.json", { action: "review", pid: 999_003, stage: "Gathering the work" });
  fs.writeFileSync(path.join(runs, "broken.json"), "{");
  const logged = log.logInterrupted(dir, (pid) => pid === 999_003);
  assert.deepEqual(logged.map((e) => [e.level, e.action, e.outcome, e.stage]).sort(), [
    ["warn", "finish", "interrupted", "Resolving the conflict in a.txt"], ["warn", "review", "interrupted", "Calling the reviewer"]]);
  const review = entries(dir).find((e) => e.action === "review");
  assert.deepEqual([review.model, review.receipt], ["fable", "/b/helpers/x/review-receipt.json"]);
  assert.ok(review.durationMs >= 5000);
  assert.match(review.message, /cut off when its window reloaded or closed \(extension host 999001 is gone\)/);
  assert.deepEqual(fs.readdirSync(runs), ["review-live.json"]);
  assert.deepEqual(log.logInterrupted(dir, () => true), [], "logged once");
});

test("a log that cannot be written never throws into Review or Finish", () => {
  const dir = boardDir(), file = path.join(dir, "not-a-folder");
  fs.writeFileSync(file, "x");
  assert.doesNotThrow(() => log.appendEntry(file, { action: "review", card, message: "m" }));
});
