// Claude Code and Codex hook: append the event from stdin as one JSON line to the file in argv[2].
// Codex sends the same JSON shape (hook_event_name, session_id, transcript_path = its rollout file, prompt, last_assistant_message).
// Codex sessions pass the file in ENTOMATICAL_EVENTS instead, so their hook command (and Codex's approval of it) is the same for every task.
// Only small fields are kept; tool results can be megabytes and the board rereads this file.
// desc (F70, 4 November 2026): one short line per tool call for the card's live line, "Edit src/board.ts", "Bash npm test",
// "Grep foo": the tool name and the first 80 characters of its main argument, with a path under cwd made relative. The tool's full
// input is never copied.
// asks (F79): at Stop, whether the reply ends by asking something (asks() below), as one boolean. hash (F80): at PostToolUse, the
// first 8 hex characters of sha1(tool_name + tool_input), so the board can see the same call repeated without storing the input.
// agent (F96, 8 November 2026): for an Agent result, the sub-agent's id, type, model, tokens, tool calls, time, status and reply length;
// the reply itself is never copied. A background dispatch (every one seen in interactive cards on Claude Code 2.1.319; a headless card's
// ran in the foreground on Windows) has no tokens yet at its result, so
// its id, status, tokens, tool calls and time go on the UserPromptSubmit line of the notification that reports its end (9 November 2026).
// stop_hook_active (17 November 2026): Claude Code sets it true on a Stop that follows a Stop-hook block, so a hook-forced turn shows
// in the card's events; false is kept as sent. The block reason is not in the Stop input and is not recorded.
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const KEEP = ["hook_event_name", "session_id", "cwd", "transcript_path", "prompt", "source", "notification_type", "tool_name", "last_assistant_message", "agent_id", "agent_type", "agent_transcript_path", "model", "effort", "effort_level", "error", "stop_hook_active"];
const CODEX_TURN_HOOKS = new Set(["UserPromptSubmit", "PermissionRequest", "PostToolUse", "Stop", "Interrupt", "SubagentStart", "SubagentStop"]);
const out = process.argv[2] || process.env.ENTOMATICAL_EVENTS;
const describe = (event) => {
  const input = event.tool_input;
  if (typeof event.tool_name !== "string" || !input || typeof input !== "object") return undefined;
  const cwd = typeof event.cwd === "string" ? event.cwd.replace(/\\/g, "/").replace(/\/$/, "") : "";
  const rel = (p) => { const q = String(p).replace(/\\/g, "/"); return cwd && q.toLowerCase().startsWith(cwd.toLowerCase() + "/") ? q.slice(cwd.length + 1) : String(p); };
  const arg = input.file_path ?? input.notebook_path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.skill ?? input.prompt ?? "";
  const text = `${event.tool_name} ${rel(arg).split("\n")[0]}`.trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
};
/** fields without its undefined ones, or undefined when none is left. */
const present = (fields) => {
  const kept = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) kept[k] = v;
  return Object.keys(kept).length ? kept : undefined;
};
/** An Agent result's figures (F96): each field only when its source is there and of the expected type, so no prompt or reply text gets in. */
const agentSummary = (event) => {
  const input = event.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};
  const r = event.tool_response && typeof event.tool_response === "object" ? event.tool_response : {};
  const chars = typeof r.content === "string" ? r.content.length
    : Array.isArray(r.content) ? r.content.reduce((n, b) => n + (typeof b?.text === "string" ? b.text.length : 0), 0) : undefined;
  const str = (v) => (typeof v === "string" ? v : undefined), num = (v) => (Number.isFinite(v) ? v : undefined);
  return present({ id: str(r.agentId), type: str(input.subagent_type), model: str(r.resolvedModel), tokens: num(r.totalTokens),
    calls: num(r.totalToolUseCount), ms: num(r.totalDurationMs), status: str(r.status), chars });
};
// How a completed sub-agent's notification ends (Claude Code 2.1.319; the only two endings among 166 seen on linux by 9 November 2026,
// the <worktree> element for an agent run in a worktree of its own).
const USAGE_END = /<\/result>\n<usage><subagent_tokens>(\d{1,12})<\/subagent_tokens><tool_uses>(\d{1,9})<\/tool_uses><duration_ms>(\d{1,12})<\/duration_ms><\/usage>\n(?:<worktree>[^\n]{0,2000}<\/worktree>\n)?<\/task-notification>\s{0,4}$/;
/**
 * A background sub-agent's figures from the <task-notification> prompt that reports its end (F96, 9 November 2026; format of Claude
 * Code 2.1.319): <task-id> (the agent_id of its SubagentStart line) and <status> before <summary>Agent "…", the reply in <result>, then
 * <usage><subagent_tokens>…</subagent_tokens><tool_uses>…</tool_uses><duration_ms>…</duration_ms></usage> at the very end. The summary
 * holds the dispatcher's description and the result the sub-agent's reply, so the id and status are read only before the summary and
 * the usage only where it ends the prompt (USAGE_END): a reply cut short or a description cannot plant figures. A prompt holding a
 * second notification gets nothing rather than one agent's id with another's usage, as does a background command's, a monitor's or a
 * workflow's. A failed agent has no usage: its id and status only.
 */
const notifiedAgent = (prompt) => {
  if (typeof prompt !== "string" || !prompt.startsWith("<task-notification>") || prompt.includes("<task-notification>", 1)) return undefined;
  const at = prompt.indexOf("<summary>");
  if (at < 0 || at > 2000 || !prompt.startsWith('<summary>Agent "', at)) return undefined;
  const head = prompt.slice(0, at);
  const id = /<task-id>([A-Za-z0-9_-]{1,64})<\/task-id>/.exec(head)?.[1];
  if (!id) return undefined;
  const usage = USAGE_END.exec(prompt.slice(-2600));
  return present({ id, status: /<status>([a-z_]{1,32})<\/status>/.exec(head)?.[1],
    tokens: usage ? Number(usage[1]) : undefined, calls: usage ? Number(usage[2]) : undefined, ms: usage ? Number(usage[3]) : undefined });
};
/**
 * Whether a reply ends by asking the user something (F79). No model: true when the text, with fenced code blocks left out, ends with a
 * question mark once trailing whitespace and closing markdown are ignored, or when its last 600 characters hold an option list (two
 * numbered or lettered lines at least) together with a question. A "?" inside code, or a question mid-text in a statement, is not one.
 */
function asks(text) {
  if (typeof text !== "string") return false;
  // Fenced blocks go first, an unclosed last one too: a regex or a ternary ending in "?" is not a question to the user.
  const prose = text.replace(/(^|\n)[ \t]*(```|~~~)[\s\S]*?(\n[ \t]*\2[^\n]*|$)/g, "$1");
  const end = prose.replace(/[\s*_~`)\]"'”’»>]+$/u, "");
  if (/[?？]$/.test(end)) return true;
  // Keep the classifier self-contained: the panel installer embeds this function in its standalone sidecar.
  // A line of a numbered or lettered option list: "1. ", "2) ", "(3) ", "a. ", "B) ", "(c) ", also bold ("**1.**") or after a bullet.
  const OPTION = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?(?:\(?\d{1,2}\)|\d{1,2}[.)]|\(?[A-Za-z]\)|[A-Za-z][.)])(?:\*\*|__)?\s+\S/;
  // A sentence that ends in a question mark (also full-width), before whitespace, closing markdown or the end.
  const QUESTION = /[?？](?=[\s*_~`)\]"'”’»]*(?:\s|$))/;
  const tail = prose.slice(-600);
  const options = tail.split("\n").filter((l) => OPTION.test(l)).length;
  return options >= 2 && QUESTION.test(tail);
}
const hash = (event) => crypto.createHash("sha1").update(`${event.tool_name}\u0000${JSON.stringify(event.tool_input ?? null)}`).digest("hex").slice(0, 8);

// F91 (fix 10 of the failed tool calls plan, 6 November 2026): a headless run nobody can answer (ENTOMATICAL_NO_PROMPTS=1, set by the
// board's headless launch script) stops itself when its calls keep getting refused, instead of trying call after call. In such a run
// Claude Code fires PermissionRequest for every call it is about to refuse (2.1.319, checked live), so each one is a refusal here.
// Both rules count the main thread's refusals within one prompt (since its UserPromptSubmit; a compaction does not reset them):
// the same call refused a second time, or the 8th refusal with no successful call (PostToolUse) since the first of them.
const REFUSAL_REPEAT = 2;
const REFUSAL_STREAK = 8;
/** The call's identity for "the same call twice": the tool and its input without description and timeout. Never the input itself. */
const callId = (event) => {
  const input = event.tool_input && typeof event.tool_input === "object" ? { ...event.tool_input } : event.tool_input ?? null;
  if (input && typeof input === "object") { delete input.description; delete input.timeout; }
  return crypto.createHash("sha1").update(`${event.tool_name}\u0000${JSON.stringify(input)}`).digest("hex").slice(0, 8);
};
/**
 * Whether this refusal stops the run. lines: this session's event lines in order, the new one (line) among them, as each hook appends
 * and then reads (parallel calls may both stop; both answer the same). Returns undefined or { rule, n, desc }: n is the refusals in
 * this prompt so far. Subagent lines (agent_id) neither count nor reset.
 */
function refusalStop(lines, line) {
  if (line.hook_event_name !== "PermissionRequest" || line.agent_id !== undefined) return undefined;
  const main = lines.filter((l) => l.agent_id === undefined);
  const from = main.findLastIndex((l) => l.hook_event_name === "UserPromptSubmit") + 1;
  const prompt = main.slice(from);
  const refused = prompt.filter((l) => l.hook_event_name === "PermissionRequest");
  const desc = line.desc ?? line.tool_name;
  const n = refused.length;
  if (line.call && refused.filter((l) => l.call === line.call).length >= REFUSAL_REPEAT) return { rule: "repeat", n, desc };
  const streak = prompt.slice(prompt.findLastIndex((l) => l.hook_event_name === "PostToolUse") + 1).filter((l) => l.hook_event_name === "PermissionRequest").length;
  return streak >= REFUSAL_STREAK ? { rule: "streak", n, desc } : undefined;
}
/** The PermissionRequest answer that refuses the call and ends the run at it (checked live: error_during_execution, then --resume continues). */
const stopDecision = (stop) => ({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", interrupt: true,
  message: `Entomatical stopped this run: ${stop.n} calls in this prompt were refused, the last: ${stop.desc}. Nothing that needs approval can run in this headless session. Wait for a follow-up.` } } });
/** This session's lines from the last 256 KB of the events file. */
function sessionLines(file, session) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size, length = Math.min(size, 256 * 1024), buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8"), lines = (length < size ? text.slice(text.indexOf("\n") + 1) : text).split("\n");
    return lines.map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter((l) => l && l.session_id === session);
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

const append = (event, env = process.env, print = (text) => process.stdout.write(text)) => {
  // The editor's shared app-server cannot give each hook process a different environment. Entomatical registers only its own
  // panel threads beside this script; all other sessions still have no destination and are ignored.
  let destination;
  if (typeof event.session_id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(event.session_id)) {
    try {
      const route = JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), "panel-sessions", `${event.session_id}.json`), "utf8"));
      if (typeof route.events === "string" && path.isAbsolute(route.events)) destination = route.events;
    } catch { /* no route for this session */ }
  }
  // Claude's hook takes an output argument. Codex uses its runtime environment or a registered panel route.
  const codex = !process.argv[2] && (env.ENTOMATICAL_RUNTIME === "codex" || (!env.ENTOMATICAL_RUNTIME && !!destination));
  destination ||= out;
  if (!destination) return; // a Codex session Entomatical did not start
  const line = { t: Date.now() };
  if (env.ENTOMATICAL_TERMINAL_LAUNCH) line.terminal_launch_id = env.ENTOMATICAL_TERMINAL_LAUNCH;
  for (const k of KEEP) if (event[k] !== undefined) line[k] = event[k];
  if (codex && CODEX_TURN_HOOKS.has(event.hook_event_name)
    && typeof event.turn_id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(event.turn_id)) line.turn_id = event.turn_id;
  const desc = describe(event);
  if (desc) line.desc = desc;
  if (event.hook_event_name === "Stop" && typeof event.last_assistant_message === "string") line.asks = asks(event.last_assistant_message);
  if (event.hook_event_name === "PostToolUse" && typeof event.tool_name === "string") line.hash = hash(event);
  if (event.hook_event_name === "PostToolUse" && event.tool_name === "Agent") { const a = agentSummary(event); if (a) line.agent = a; }
  if (event.hook_event_name === "UserPromptSubmit") { const a = notifiedAgent(event.prompt); if (a) line.agent = a; }
  if (event.hook_event_name === "PermissionRequest" && typeof event.tool_name === "string") line.call = callId(event);
  fs.appendFileSync(destination, JSON.stringify(line) + "\n");
  // F91: only a run with nobody to answer is stopped; elsewhere a person answers the prompt and nothing is printed.
  if (env.ENTOMATICAL_NO_PROMPTS !== "1" || line.hook_event_name !== "PermissionRequest" || line.agent_id !== undefined) return;
  const stop = refusalStop(sessionLines(destination, line.session_id), line);
  if (!stop) return; // Claude Code's own refusal applies
  // A line of its own after the refusal, which the board reads (Needs input with the reason); it is not counted as a refusal.
  fs.appendFileSync(destination, JSON.stringify({ t: Date.now(), hook_event_name: "RefusalStop", session_id: line.session_id,
    terminal_launch_id: line.terminal_launch_id, refusal_stop: stop }) + "\n");
  print(JSON.stringify(stopDecision(stop)));
};
const parse = (text) => { try { return JSON.parse(text) ?? {}; } catch { return {}; } };
if (require.main === module) {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (data += c)).on("end", () => append(parse(data)));
}
module.exports = { asks, hash, describe, agentSummary, notifiedAgent, callId, refusalStop, stopDecision, append, REFUSAL_REPEAT, REFUSAL_STREAK };
