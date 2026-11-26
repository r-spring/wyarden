const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { AcpSession, acpCommand } = require("../out/acp.js");

function agent({ load = true, resume = false, configOptions = [], modes = [] } = {}) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const requests = [], replies = [];
  let buffer = "";
  const send = (x) => child.stdout.write(JSON.stringify(x) + "\n");
  child.stdin.on("data", (data) => {
    buffer += data;
    while (buffer.includes("\n")) {
      const n = buffer.indexOf("\n"), m = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
      if (!m.method) { replies.push(m); continue; }
      requests.push(m);
      const result = m.method === "initialize" ? { protocolVersion: 1, agentCapabilities: { loadSession: load, ...(resume ? { sessionCapabilities: { resume: {} } } : {}) } }
        : m.method === "session/new" ? { sessionId: "agent-session", configOptions, modes: { availableModes: modes } }
        : m.method === "session/set_config_option" ? { configOptions: configOptions.map((o) => o.id === m.params.configId ? { ...o, currentValue: m.params.value } : o) }
        : m.method === "session/load" || m.method === "session/resume" ? {} : m.method === "session/prompt" ? { stopReason: "end_turn" } : undefined;
      if (m.id !== undefined) queueMicrotask(() => send({ jsonrpc: "2.0", id: m.id, result }));
    }
  });
  child.kill = () => { child.stdout.end(); child.emit("exit", 0); return true; };
  return { child, requests, replies, send };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

test("ACP opens, resumes, streams updates and never fabricates permission approval", async () => {
  const { child, requests, replies, send } = agent();
  const updates = [];
  const session = new AcpSession(child, (update) => updates.push(update));
  assert.equal(await session.open("/project"), "agent-session");
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agent-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } });
  send({ jsonrpc: "2.0", id: "permission-1", method: "session/request_permission", params: { sessionId: "agent-session", options: [{ optionId: "yes", kind: "allow_once" }] } });
  await turn();
  assert.equal(updates[0].content.text, "hello");
  assert.deepEqual(replies[0].result.outcome, { outcome: "cancelled" });
  assert.equal(await session.prompt("first"), "end_turn");
  assert.equal(requests.find((r) => r.method === "session/prompt").params.prompt[0].text, "first");
  session.close();
  const resumed = agent();
  const next = new AcpSession(resumed.child);
  assert.equal(await next.open("/project", "agent-session"), "agent-session");
  assert.equal(resumed.requests.find((r) => r.method === "session/load").params.sessionId, "agent-session");
  next.close();
  const agy = agent({ load: false, resume: true });
  const resumedAgy = new AcpSession(agy.child);
  assert.equal(await resumedAgy.open("/project", "agy-session"), "agy-session");
  assert.equal(agy.requests.find((r) => r.method === "session/resume").params.sessionId, "agy-session");
  resumedAgy.close();
});

test("ACP accepts only values advertised by the session and verifies each applied selection", async () => {
  const fake = agent({ configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "small",
    options: [{ group: "models", name: "Models", options: [{ value: "small", name: "Small" }, { value: "large", name: "Large" }] }] }] });
  const session = new AcpSession(fake.child);
  await session.open("/project");
  assert.deepEqual(session.options()[0].values, [{ value: "small", name: "Small" }, { value: "large", name: "Large" }]);
  await assert.rejects(session.configure("model", "not-offered"), /did not offer/);
  assert.equal(fake.requests.some((r) => r.method === "session/set_config_option"), false);
  await session.configure("model", "large");
  assert.equal(session.options()[0].currentValue, "large");
  assert.equal(fake.requests.find((r) => r.method === "session/set_config_option").params.configId, "model");
  session.close();
  const legacy = agent({ modes: [{ id: "ask", name: "Ask" }, { id: "plan", name: "Plan" }] });
  const old = new AcpSession(legacy.child);
  await old.open("/project");
  await old.configure("__acp_mode", "plan");
  assert.equal(legacy.requests.find((r) => r.method === "session/set_mode").params.modeId, "plan");
  old.close();
});

test("ACP never answers a pending permission after closure or accepts unknown option kinds", async () => {
  const fake = agent();
  let release;
  const session = new AcpSession(fake.child, undefined, () => new Promise((resolve) => { release = resolve; }));
  await session.open("/project");
  fake.send({ jsonrpc: "2.0", id: "pending", method: "session/request_permission", params: { sessionId: "agent-session", options: [{ optionId: "yes", kind: "allow_once" }] } });
  await turn();
  session.close();
  release("yes");
  await turn();
  assert.deepEqual(fake.replies, [], "closing the transport invalidates the outstanding picker");

  const other = agent();
  const unrecognized = new AcpSession(other.child, undefined, async () => "yes");
  await unrecognized.open("/project");
  other.send({ jsonrpc: "2.0", id: "unknown", method: "session/request_permission", params: { sessionId: "agent-session", options: [{ optionId: "yes", kind: "future_kind" }] } });
  await turn();
  assert.deepEqual(other.replies[0].result.outcome, { outcome: "cancelled" });
  unrecognized.close();
});

test("ACP refuses an unsupported resume and isolates provider credential selection", async () => {
  const fake = agent({ load: false });
  const session = new AcpSession(fake.child);
  await assert.rejects(session.open("/project", "old"), /cannot load/);
  assert.equal(fake.requests.some((r) => r.method === "session/load"), false);
  session.close();
  const grok = acpCommand("grok", "/grok/profile", { PATH: "/bin", XAI_API_KEY: "secret", GROK_DEPLOYMENT_KEY: "secret" });
  assert.deepEqual(grok.args, ["agent", "stdio"]);
  assert.equal(grok.env.GROK_HOME, "/grok/profile");
  assert.equal(grok.env.XAI_API_KEY, undefined);
  assert.equal(grok.env.GROK_DEPLOYMENT_KEY, undefined);
  const agy = acpCommand("antigravity", undefined, { PATH: "/bin", GEMINI_API_KEY: "secret", GOOGLE_APPLICATION_CREDENTIALS: "secret" });
  assert.deepEqual(agy.args, ["acp"]);
  assert.equal(agy.env.GEMINI_API_KEY, undefined);
  assert.equal(agy.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  const windowsShim = acpCommand("grok", "C:\\Grok\\Work", { PATH: "" }, "win32");
  if (windowsShim.file === "cmd.exe") assert.deepEqual(windowsShim.args, ["/d", "/c", "grok", "agent", "stdio"]);
  else assert.match(windowsShim.file, /grok\.exe$/i);
});
