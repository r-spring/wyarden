// Claude Code SubagentStop hook for ab-* sub-agents (F96, scoped sub-agents): when a reply breaks the format its agent definition names
// (first line starts with the prefix, at most the line cap, counted after leading and trailing blank lines are dropped), it answers
// decision "block" and Claude Code sends the reason to the sub-agent as its next instruction.
// It never blocks a sub-agent that is already continuing because of a stop hook (stop_hook_active), a missing or empty reply, or any
// other agent type. Prints nothing when the reply passes; on any error it prints nothing and exits 0, so the sub-agent stops as asked.
// The prefixes and caps mirror the "Reply:" line of each .claude/agents/ab-*.md body.
const FORMATS = {
  "ab-reviewer": { prefix: "VERDICT: ", lines: 60 },
  "ab-host-investigator": { prefix: "VERDICT: ", lines: 40 },
  "ab-fixer": { prefix: "RESULT: ", lines: 25 },
  "ab-parity-checker": { prefix: "RESULT: ", lines: 40 },
  "ab-mapper": { prefix: "RESULT: ", lines: 40 },
  "ab-test-gate": { prefix: "RESULT: ", lines: 15 },
};

/** The SubagentStop output that sends an ab-* sub-agent back to fix its reply, or undefined to let it stop. */
function gate(event) {
  const type = event?.agent_type;
  const message = event?.last_assistant_message;
  // hasOwn, so a type such as "constructor" never reads an Object prototype key.
  if (!Object.hasOwn(FORMATS, type) || event.stop_hook_active === true || typeof message !== "string" || message === "") return undefined;
  const all = message.split("\n");
  const first = all.findIndex((line) => line.trim() !== "");
  if (first < 0) return undefined; // a reply of blank lines only counts as empty
  const lines = all.slice(first, all.findLastIndex((line) => line.trim() !== "") + 1);
  const { prefix, lines: cap } = FORMATS[type];
  if (lines[0].startsWith(prefix) && lines.length <= cap) return undefined;
  return {
    decision: "block",
    reason: `Reply format for ${type}: first line starts with "${prefix}", at most ${cap} lines. Send the reply again in that form and nothing else.`,
  };
}

if (require.main === module) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("error", () => {}).on("data", (c) => (data += c)).on("end", () => {
    try {
      const out = gate(JSON.parse(data) ?? {});
      if (out) process.stdout.write(JSON.stringify(out));
    } catch { /* fail open: the sub-agent stops with the reply it gave */ }
  });
}
module.exports = { FORMATS, gate };
