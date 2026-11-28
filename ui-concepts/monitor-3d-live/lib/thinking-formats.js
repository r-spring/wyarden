/* Wyarden 3D monitor, working mock-up: what one record of a Codex, Grok Build or Antigravity session holds as reasoning.
 *
 * lib/thinking.js reads the thinking one session has done. A Claude Code transcript has its own code
 * there. For the three formats here, `readThinking(file, { format })` takes the same steps (one stat,
 * the bounded tail read, the window's cut first line dropped, a line parsed only when it holds the
 * format's mark, a thought counted once, the cleaning, the cut and the limits, the same answer) and
 * asks this file one thing only: what a parsed record holds as reasoning.
 *
 * A reader is { mark, items, tellsUnrecorded }:
 *   mark             text a line must hold to be worth parsing. A cheap filter only: the record test in
 *                    `items` is what keeps everything else out.
 *   items(record)    pure, never throws, takes any parsed JSON value, returns [] or [{ key, at, text, cut? }]:
 *                      key   what a thought is counted once by; lib/thinking.js hashes it and never returns it
 *                      at    the record's own time in ms, or null
 *                      text  the reasoning text as written (cleaned later); may be blank
 *                      cut   true when the tool itself cut the text (Antigravity only)
 *   tellsUnrecorded  whether a blank item means "the model reasoned and no text was recorded". When it
 *                    is false, a blank item is passed over and `unrecorded` is always 0.
 *
 * Each format is the tool's own and undocumented unless said. What follows was seen on this machine on
 * 28 November 2026. Only counts were read, never the text of a real session.
 *
 * Codex CLI 0.172.0: a "rollout" file, one JSON record per line, appended to while the session runs.
 * A reasoning record is {timestamp: ISO 8601 text, type: "response_item", payload: {type: "reasoning",
 * id: "rs_...", summary: [{type: "summary_text", text}, ...], encrypted_content: a long base64 text,
 * ...}}. Its text is its summary entries' texts with a blank line between them. Codex writes no summary
 * text when its reasoning summaries are off: of the 127,452 reasoning records written here since
 * October, 0 had any. So a reasoning record with no summary text counts as unrecorded. Codex writes the
 * same reasoning a second time as {type: "event_msg", payload: {type: "item_completed", item: {type:
 * "Reasoning", summary_text, raw_content}}}. That twin is never read (it would count twice), and
 * neither raw_content nor encrypted_content is ever read. Answers (payload.type "message", role
 * "assistant"), prompts (role "user" or "developer") and tool calls (the other payload types) are never
 * read. A thought is counted once by its payload.id when that is a non-empty text, else by its text.
 * One line of a real file was 58 MB long. A line longer than the read window falls outside it, and the
 * part of it inside the window is dropped as the window's cut first line.
 *
 * Grok Build 1.0.92: updates.jsonl in the session's folder, the session's Agent Client Protocol update
 * stream, append-only (so says the tool's own bundled guide). A reasoning line is {jsonrpc: "2.0",
 * method: "session/update", params: {sessionId, update: {sessionUpdate: "agent_thought_chunk", content:
 * {type: "text", text}}, _meta: {updateType: "AgentThoughtChunk", promptId, agentTimestampMs: a number
 * of ms}}}. One line is one whole thought (one per model call), not a token. Only `agent_thought_chunk` is read, its text at
 * params.update.content.text when that is a text, its time at params._meta.agentTimestampMs when that is
 * a number. Answers (agent_message_chunk), prompts (user_message_chunk) and tool calls (tool_call and
 * tool_call_update, their inputs in rawInput) are never read. A call the model gave no summary for
 * leaves no line here, so this format cannot tell "reasoned, no text": a blank chunk is passed over and
 * `unrecorded` is 0. A thought is counted once by its time and text.
 *
 * Antigravity (agy) 1.5.19: transcript_full.jsonl, one record per step, never rewritten. Beside it,
 * transcript.jsonl holds the same records with long texts cut near 4 KB and named in a
 * `truncated_fields` array. A model call is {step_index: a number, type: "PLANNER_RESPONSE", status,
 * source, created_at, model, content: the answer, thinking: the thinking text, tool_calls, input_tokens,
 * ...}. Only that type with a non-blank `thinking` text is read; `content` and `tool_calls` never are,
 * nor any record of another type, whatever it holds. created_at is taken as ISO 8601 text or a number of
 * ms; anything else is no time. When `truncated_fields` names "thinking", the tool cut the thought: it is
 * marked `cut`, its text as the tool left it. About 40% of the calls that used thinking tokens have no
 * text, and the record does not say so reliably, so a blank one is passed over and `unrecorded` is 0. A
 * thought is counted once by its step_index when that is a number, else by its time and text.
 *
 * Privacy: these records also hold prompts, answers, tool inputs and results, ids, paths and encrypted
 * content. An item holds the reasoning text, its time, whether the tool cut it, and a key that
 * lib/thinking.js hashes and never returns. This file needs no other module and keeps nothing.
 */
'use strict';

/** Every format readThinking takes. 'claude' is read by lib/thinking.js's own code; the others by READERS here. */
const FORMATS = Object.freeze(['claude', 'codex', 'grok', 'antigravity']);

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** A time in ms: ISO 8601 text or a finite number, else null. */
function msOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Codex: a `response_item` whose payload is `reasoning`; its summary texts, a blank line between them. Blank when it has none. */
function codexItems(record) {
  if (!isObject(record) || record.type !== 'response_item') return [];
  const p = record.payload;
  if (!isObject(p) || p.type !== 'reasoning') return [];
  const parts = [];
  if (Array.isArray(p.summary)) {
    for (const entry of p.summary) if (isObject(entry) && typeof entry.text === 'string' && entry.text.trim()) parts.push(entry.text);
  }
  const text = parts.join('\n\n');
  const key = typeof p.id === 'string' && p.id ? 'id\n' + p.id : 'text\n' + text;
  return [{ key, at: msOf(record.timestamp), text }];
}

/** Grok Build: a `session/update` line whose update is `agent_thought_chunk`, its content's text. */
function grokItems(record) {
  if (!isObject(record) || !isObject(record.params)) return [];
  const update = record.params.update;
  if (!isObject(update) || update.sessionUpdate !== 'agent_thought_chunk') return [];
  const content = update.content;
  if (!isObject(content) || typeof content.text !== 'string') return [];
  const meta = record.params._meta;
  const at = isObject(meta) && typeof meta.agentTimestampMs === 'number' && Number.isFinite(meta.agentTimestampMs) ? meta.agentTimestampMs : null;
  return [{ key: 'at\n' + at + '\n' + content.text, at, text: content.text }];
}

/** Antigravity: a `PLANNER_RESPONSE` step with a non-blank `thinking` text; `cut` when the tool says it cut that text. */
function antigravityItems(record) {
  if (!isObject(record) || record.type !== 'PLANNER_RESPONSE') return [];
  const text = record.thinking;
  if (typeof text !== 'string' || !text.trim()) return [];
  const at = msOf(record.created_at);
  const step = record.step_index;
  const key = typeof step === 'number' && Number.isFinite(step) ? 'step\n' + step : 'at\n' + at + '\n' + text;
  const cut = Array.isArray(record.truncated_fields) && record.truncated_fields.includes('thinking');
  return [cut ? { key, at, text, cut: true } : { key, at, text }];
}

const reader = (mark, items, tellsUnrecorded) => Object.freeze({ mark, items, tellsUnrecorded });
/** The reader of each format but 'claude', by its name in FORMATS. */
const READERS = Object.freeze({
  codex: reader('"reasoning"', codexItems, true),
  grok: reader('agent_thought_chunk', grokItems, false),
  antigravity: reader('"thinking"', antigravityItems, false)
});

module.exports = { FORMATS, READERS, codexItems, grokItems, antigravityItems };
