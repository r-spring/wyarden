// A fake ACP agent (newline-delimited JSON-RPC on stdin/stdout) standing in for `grok agent stdio` and `agy acp` in tests. It
// advertises only fake ids (fake-model-a, fake-model-b, fake-low, fake-high): the repo has no Grok or Antigravity model list and tests
// must not invent one. Two kinds of turn:
// - a helper packet (it ends with "matches this JSON Schema:"): it streams a thought, asks for a tool permission (a helper must refuse),
//   then answers with a JSON object fitted to the schema's fields;
// - any other prompt (a plan step): it asks permission to write a file, and on allow writes fake-<provider>.txt in its cwd.
// FAKE_ACP_LOG: append every request it receives as one JSON line. FAKE_ACP_PROVIDER: the provider it plays.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const provider = process.env.FAKE_ACP_PROVIDER || "grok";
let options = [
  { id: "agent_model", name: "Model", category: "model", type: "select", currentValue: "fake-model-a",
    options: [{ value: "fake-model-a", name: "Fake model A" }, { value: "fake-model-b", name: "Fake model B" }] },
  { id: "reasoning", name: "Thinking", category: "thought_level", type: "select", currentValue: "fake-low",
    options: [{ value: "fake-low", name: "Fake low" }, { value: "fake-high", name: "Fake high" }] },
];
const RECORD = { version: 1, status: "ready", outcome: { goal: "Explain the test.", deliverable: "A passing test.", beneficiary: "" },
  context: { facts: [], identifiers: [], sources: [], dependencies: [] }, success: { criteria: [] },
  requirements: [{ id: "R1", text: "Keep the fixture small.", provenance: "user", strength: "mandatory", rationale: "" }],
  permissions: { authorized: [], confirm: [], prohibited: [] }, unresolved: [], conflicts: [] };

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const log = (m) => { if (process.env.FAKE_ACP_LOG) fs.appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify({ provider, cwd: process.cwd(), ...m }) + "\n"); };
let nextId = 1000, sessionId;
const waiting = new Map();
const ask = (params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method: "session/request_permission", params }); });
const update = (u) => send({ method: "session/update", params: { sessionId, update: u } });
const say = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

/** An answer for the helper schema, by its fields. */
function answer(schema) {
  const p = schema?.properties ?? {};
  if (p.title) return { title: `Fake ${provider} title` };
  if (p.revision) return { kind: "revision", revision: `Refined by fake ${provider}.`, questions: [], assumptions: [] };
  if (p.goalFound) return { goalFound: true, goal: "The fake goal is reached.", doneWhen: "The fake check passes.", commands: ["npm test"] };
  if (p.haikuGoodEnough) return { haikuGoodEnough: true, verdict: "Haiku's rule was good enough." };
  if (p.requirements) return RECORD;
  return {};
}

async function turn(id, text) {
  const marker = "matches this JSON Schema:\n";
  if (text.includes(marker)) {
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking about it." } });
    const outcome = await ask({ sessionId, toolCall: { title: "Read a file", kind: "read", rawInput: { path: "x" } },
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "No", kind: "reject_once" }] });
    log({ permissionOutcome: outcome });
    // FAKE_ACP_HELPER_TOOL: an agent whose own settings preapprove a tool runs it without asking; the helper must fail the turn.
    if (process.env.FAKE_ACP_HELPER_TOOL) update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Run shell", kind: "execute", status: "pending" });
    const schema = JSON.parse(text.slice(text.lastIndexOf(marker) + marker.length));
    const json = JSON.stringify(answer(schema));
    // Fenced and in two chunks, as a model may reply: the helper must still find the one object.
    say("```json\n" + json.slice(0, 5)); say(json.slice(5) + "\n```");
    return send({ id, result: { stopReason: "end_turn" } });
  }
  const outcome = await ask({ sessionId, toolCall: { title: `Write fake-${provider}.txt`, kind: "edit", rawInput: { path: `fake-${provider}.txt` } },
    options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "No", kind: "reject_once" }] });
  log({ permissionOutcome: outcome });
  if (outcome?.outcome === "selected" && outcome.optionId === "yes") {
    update({ sessionUpdate: "tool_call", title: `Write fake-${provider}.txt` });
    fs.writeFileSync(path.join(process.cwd(), `fake-${provider}.txt`), `written by fake ${provider}\n`);
    say(`Wrote fake-${provider}.txt.`);
  } else say("Not allowed to write.");
  send({ id, result: { stopReason: "end_turn" } });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (!m.method) { const r = waiting.get(m.id); waiting.delete(m.id); return r?.(m.result?.outcome); }
  log({ method: m.method, params: m.params });
  if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } } });
  if (m.method === "session/new") { sessionId = `fake-${provider}-session`; return send({ id: m.id, result: { sessionId, configOptions: options } }); }
  if (m.method === "session/resume") { sessionId = m.params.sessionId; return send({ id: m.id, result: { configOptions: options } }); }
  if (m.method === "session/set_config_option") {
    options = options.map((o) => o.id === m.params.configId ? { ...o, currentValue: m.params.value } : o);
    return send({ id: m.id, result: { configOptions: options } });
  }
  if (m.method === "session/prompt") return void turn(m.id, m.params.prompt.map((p) => p.text).join(""));
  if (m.method === "session/cancel") return;
  if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: "Unsupported" } });
});
