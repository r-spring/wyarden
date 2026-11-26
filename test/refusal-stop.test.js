// F91 (fix 10 of the failed tool calls plan): a headless run's own hook stops it when the same call is refused twice in one prompt, or
// 8 calls in a row are refused with no successful call between. hook/hook.js's pure rule, and the real hook process on an events file.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const hook = require("../hook/hook.js");

const HOOK = path.join(__dirname, "..", "hook", "hook.js");
const S = "session-1";
let t = 0;
const line = (e) => ({ t: ++t, session_id: S, ...e });
const prompt = () => line({ hook_event_name: "UserPromptSubmit", prompt: "Go" });
const ok = (n = 1) => line({ hook_event_name: "PostToolUse", tool_name: "Read", desc: `Read f${n}` });
const refused = (n, input = { file_path: `f${n}.txt`, content: "x" }) => {
  const e = { hook_event_name: "PermissionRequest", tool_name: "Write", tool_input: input };
  return line({ hook_event_name: "PermissionRequest", tool_name: "Write", desc: `Write f${n}.txt`, call: hook.callId(e) });
};
/** Each refusal as the hook sees it: its own line is already appended when it reads (lines includes it). */
function run(lines) {
  const seen = [];
  for (const l of lines) { seen.push(l); const stop = hook.refusalStop(seen, l); if (stop) return { stop, at: seen.length }; }
  return undefined;
}

test("the thresholds are 2 for the same call and 8 in a row", () => {
  assert.equal(hook.REFUSAL_REPEAT, 2);
  assert.equal(hook.REFUSAL_STREAK, 8);
});

test("7 different refusals, then an 8th: stop, rule streak, n 8", () => {
  const r = run([prompt(), ...Array.from({ length: 8 }, (_, i) => refused(i + 1))]);
  assert.deepEqual(r.stop, { rule: "streak", n: 8, desc: "Write f8.txt" });
  assert.equal(run([prompt(), ...Array.from({ length: 7 }, (_, i) => refused(i + 1))]), undefined, "7 do not stop");
});

test("a successful call resets the streak; n counts the whole prompt", () => {
  const lines = [prompt(), ...Array.from({ length: 7 }, (_, i) => refused(i + 1)), ok(), ...Array.from({ length: 7 }, (_, i) => refused(i + 11))];
  assert.equal(run(lines), undefined);
  const r = run([...lines, refused(30)]);
  assert.deepEqual(r.stop, { rule: "streak", n: 15, desc: "Write f30.txt" });
});

test("the same call refused twice stops, its description and timeout ignored", () => {
  const a = refused(1, { command: "git merge --no-edit origin/main", description: "Merge main" });
  const b = refused(1, { command: "git merge --no-edit origin/main", description: "Merge main again", timeout: 60000 });
  assert.equal(a.call, b.call);
  assert.equal(run([prompt(), a]), undefined);
  assert.deepEqual(run([prompt(), a, ok(), b]).stop, { rule: "repeat", n: 2, desc: "Write f1.txt" });
  assert.notEqual(refused(1, { command: "git merge other" }).call, a.call, "another input is another call");
});

test("a failed call that was not refused neither counts nor resets", () => {
  const fail = line({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", desc: "Bash npm test" });
  const lines = [prompt(), ...Array.from({ length: 4 }, (_, i) => refused(i + 1)), fail, ...Array.from({ length: 4 }, (_, i) => refused(i + 5))];
  assert.deepEqual(run(lines).stop, { rule: "streak", n: 8, desc: "Write f8.txt" });
});

test("a new prompt resets both rules; a subagent's refusals are not counted", () => {
  const before = Array.from({ length: 7 }, (_, i) => refused(i + 1));
  assert.equal(run([prompt(), ...before, prompt(), refused(1)]), undefined, "same call, but in the next prompt");
  const sub = Array.from({ length: 9 }, (_, i) => ({ ...refused(i + 1), agent_id: "a1" }));
  assert.equal(run([prompt(), ...sub]), undefined);
  assert.equal(run([prompt(), ...sub, refused(1)]), undefined, "the main thread's first refusal");
});

test("the decision refuses the call and ends the run, with the reason for the model", () => {
  const d = hook.stopDecision({ rule: "streak", n: 8, desc: "Write f8.txt" });
  assert.deepEqual(d, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", interrupt: true,
    message: "Entomatical stopped this run: 8 calls in this prompt were refused, the last: Write f8.txt. Nothing that needs approval can run in this headless session. Wait for a follow-up." } } });
});

/** The real hook process, fed one event on stdin. */
const fire = (events, e, env = {}) => spawnSync(process.execPath, [HOOK, events], {
  input: JSON.stringify(e), encoding: "utf8",
  env: { ...process.env, ENTOMATICAL_NO_PROMPTS: "", ENTOMATICAL_TERMINAL_LAUNCH: "", ...env },
});
const request = (n, cwd) => ({ hook_event_name: "PermissionRequest", session_id: S, cwd, tool_name: "Write", tool_input: { file_path: path.join(cwd, `f${n}.txt`), content: "secret-looking content" }, permission_mode: "default" });

test("the hook process: with ENTOMATICAL_NO_PROMPTS=1 the 8th refusal prints the decision and writes a RefusalStop line; never the input", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-refusal-stop-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = path.join(dir, "events.jsonl");
  assert.equal(fire(events, { hook_event_name: "UserPromptSubmit", session_id: S, prompt: "Write ten files" }, { ENTOMATICAL_NO_PROMPTS: "1" }).stdout, "");
  for (let n = 1; n <= 7; n++) assert.equal(fire(events, request(n, dir), { ENTOMATICAL_NO_PROMPTS: "1" }).stdout, "", `refusal ${n} prints nothing`);
  const eighth = fire(events, request(8, dir), { ENTOMATICAL_NO_PROMPTS: "1" });
  assert.equal(eighth.status, 0);
  assert.deepEqual(JSON.parse(eighth.stdout), hook.stopDecision({ rule: "streak", n: 8, desc: "Write f8.txt" }));
  const lines = fs.readFileSync(events, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 10);
  assert.ok(lines.filter((l) => l.hook_event_name === "PermissionRequest").every((l) => /^[0-9a-f]{8}$/.test(l.call)), "each refusal carries its call id");
  assert.deepEqual(lines.at(-1), { t: lines.at(-1).t, hook_event_name: "RefusalStop", session_id: S, refusal_stop: { rule: "streak", n: 8, desc: "Write f8.txt" } });
  assert.doesNotMatch(fs.readFileSync(events, "utf8"), /secret-looking|tool_input/, "the tool's input is never written");
});

test("the hook process without ENTOMATICAL_NO_PROMPTS (terminal, panel, Codex) never prints anything", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-refusal-stop-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = path.join(dir, "events.jsonl");
  fire(events, { hook_event_name: "UserPromptSubmit", session_id: S, prompt: "Go" });
  for (let n = 1; n <= 10; n++) assert.equal(fire(events, request(n % 3, dir)).stdout, "", "a person answers these prompts");
  assert.equal(fs.readFileSync(events, "utf8").includes("RefusalStop"), false);
});
