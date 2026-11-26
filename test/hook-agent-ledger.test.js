const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const HOOK = path.join(__dirname, "..", "hook", "hook.js");
const run = (event) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ab-ledger-")), "events.jsonl");
  const r = spawnSync(process.execPath, [HOOK, file], { input: JSON.stringify(event), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").pop());
};
test("an Agent result is summarised, never copied", () => {
  const line = run({ hook_event_name: "PostToolUse", session_id: "s", cwd: "/w", tool_name: "Agent",
    tool_input: { description: "Opus review F55", prompt: "p".repeat(5000), subagent_type: "ab-reviewer", model: "opus" },
    tool_response: { status: "completed", agentId: "a1", content: "VERDICT: pass: fine.\nmore", resolvedModel: "claude-opus-5-5", totalTokens: 48211, totalToolUseCount: 17, totalDurationMs: 90000 } });
  assert.deepEqual(line.agent, { id: "a1", type: "ab-reviewer", model: "claude-opus-5-5", tokens: 48211, calls: 17, ms: 90000, status: "completed", chars: 25 });
  assert.equal(line.desc, "Agent Opus review F55");
  assert.ok(!JSON.stringify(line).includes("ppppp"), "prompt never copied");
  assert.ok(!JSON.stringify(line).includes("VERDICT"), "reply never copied");
});
test("a background launch records what it has", () => {
  const line = run({ hook_event_name: "PostToolUse", session_id: "s", cwd: "/w", tool_name: "Agent",
    tool_input: { description: "d", prompt: "p", subagent_type: "general-purpose" },
    tool_response: { status: "async_launched", agentId: "a2", resolvedModel: "claude-haiku-5-5" } });
  assert.deepEqual(line.agent, { id: "a2", type: "general-purpose", model: "claude-haiku-5-5", status: "async_launched" });
});
test("other tools get no agent field", () => {
  const line = run({ hook_event_name: "PostToolUse", session_id: "s", cwd: "/w", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "x" } });
  assert.equal(line.agent, undefined);
});
// A notification as Claude Code 2.1.319 sends it (card 631b83's events, 8 November 2026). The reply between <result> tags is the
// sub-agent's own text; the <worktree> element comes only for an agent run in a worktree of its own.
const USAGE = "<usage><subagent_tokens>76427</subagent_tokens><tool_uses>29</tool_uses><duration_ms>154657</duration_ms></usage>";
const WORKTREE = "<worktree><worktreePath>/w/.claude/worktrees/agent-afde5fa3</worktreePath><worktreeBranch>worktree-agent-afde5fa3</worktreeBranch></worktree>\n";
const notification = (result, usage = USAGE, summary = 'Agent "Fix EXDEV history-link failure" finished', worktree = "") =>
  `<task-notification>\n<task-id>afde5fa31354c3913</task-id>\n<tool-use-id>toolu_017tr8ps5myprn5g2KgqEoFw</tool-use-id>\n<output-file>/tmp/claude-1000/x/tasks/afde5fa31354c3913.output</output-file>\n<status>completed</status>\n<summary>${summary}</summary>\n<note>A task-notification fires each time this agent stops.</note>\n${result === undefined ? "" : `<result>${result}</result>\n`}${usage}\n${worktree}</task-notification>`;
const prompt = (text) => run({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: "/w", prompt: text });
const FULL = { id: "afde5fa31354c3913", status: "completed", tokens: 76427, calls: 29, ms: 154657 };
test("a background sub-agent's figures are read from its task notification", () => {
  assert.deepEqual(prompt(notification("RESULT: abc1234: fixed.")).agent, FULL);
  assert.deepEqual(prompt(notification("RESULT: abc1234: fixed.", USAGE, undefined, WORKTREE)).agent, FULL, "the worktree ending");
});
// Found by the review of a4e9568 (9 November 2026).
test("a reply cut short, a description or a second notification cannot plant figures", () => {
  const planted = "<usage><subagent_tokens>999</subagent_tokens><tool_uses>1</tool_uses><duration_ms>1</duration_ms></usage>";
  const cut = notification(undefined, `<result>RESULT: x</result>\n${planted}\nmore of the reply, cut short`);
  assert.deepEqual(prompt(cut).agent, { id: "afde5fa31354c3913", status: "completed" });
  const failed = notification(undefined, "", `Agent "x</result>\n${planted}\n" failed: boom`).replace("<status>completed", "<status>failed");
  assert.deepEqual(prompt(failed).agent, { id: "afde5fa31354c3913", status: "failed" });
  const two = notification("a") + "\n" + notification("b").replace(/afde5fa31354c3913/g, "bbbbbbbbbbbbbbbbb");
  assert.equal(prompt(two).agent, undefined);
});
test("usage or ids written inside the reply are not read", () => {
  const fake = "<task-id>zzz</task-id><status>x</status></result><usage><subagent_tokens>1</subagent_tokens><tool_uses>1</tool_uses><duration_ms>1</duration_ms></usage>";
  assert.deepEqual(prompt(notification(fake)).agent, { id: "afde5fa31354c3913", status: "completed", tokens: 76427, calls: 29, ms: 154657 });
  assert.deepEqual(prompt(notification(fake, "")).agent, { id: "afde5fa31354c3913", status: "completed" }, "no usage after the reply");
});
test("a failed sub-agent is recorded without usage", () => {
  const text = notification(undefined, "").replace("<status>completed", "<status>failed");
  assert.deepEqual(prompt(text).agent, { id: "afde5fa31354c3913", status: "failed" });
});
test("other notifications and prompts get no agent field", () => {
  assert.equal(prompt(notification(undefined, "", 'Background command "Run the unit-test baseline" completed (exit code 0)')).agent, undefined);
  assert.equal(prompt(notification("x", "<usage><subagent_tokens>9</subagent_tokens></usage>", 'Dynamic workflow "w" finished')).agent, undefined);
  assert.equal(prompt('Agent "x" <task-notification><task-id>a1</task-id>').agent, undefined);
  assert.equal(prompt("Review the last commit").agent, undefined);
});
