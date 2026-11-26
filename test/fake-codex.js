#!/usr/bin/env node
// Fake `codex app-server` for codex.test.js: answers initialize, account/read, model/list (two pages; gpt-a is marked isDefault, as Codex
// marks its default model) and account/rateLimits/read.
// It first sends a notification and a server request whose id clashes with the client's, which the client must ignore.
// FAKE_CODEX_LOGGED_OUT=1 reports no account; FAKE_CODEX_FAIL=1 refuses every request but initialize.
// hooks/list lists the `-c hooks.<Event>=…` overrides it was started with (as Codex's session-flags layer), untrusted unless their key
// is in FAKE_CODEX_TRUSTED (comma-separated), plus one unapproved hook of the user's own. FAKE_CODEX_LOG gets one line per request.
// FAKE_CODEX_CONFIG names a JSON file standing in for config.toml: config/read returns it as the effective config, and
// config/batchWrite upserts into it (keyPath split at dots, value merged one level deep), so a trust it records holds for the
// next app-server. Without it config/read is an unknown method, as in a Codex that cannot report folder trust.
const fs = require("fs");
const readline = require("readline");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const snake = (name) => name.replace(/[A-Z]/g, (c, i) => (i ? "_" : "") + c.toLowerCase());
function sessionHooks() {
  const trusted = (process.env.FAKE_CODEX_TRUSTED || "").split(",").filter(Boolean);
  const args = process.argv.slice(2), hooks = [];
  for (let i = 0; i < args.length; i++) {
    const m = args[i] === "-c" && /^hooks\.(\w+)=.*command=(".*")\}\]\}\]$/.exec(args[i + 1] || "");
    if (!m) continue;
    const key = `/<session-flags>/config.toml:${snake(m[1])}:0:0`;
    hooks.push({ key, source: "sessionFlags", command: JSON.parse(m[2]), trustStatus: trusted.includes(key) ? "trusted" : "untrusted", currentHash: `sha256:${m[1]}` });
  }
  return [...hooks, { key: "/home/u/.codex/config.toml:stop:0:0", source: "user", command: "node other.js", trustStatus: "untrusted", currentHash: "sha256:theirs" }];
}
const answers = {
  "hooks/list": (p) => ({ data: [{ cwd: p.cwds?.[0], hooks: sessionHooks(), warnings: [], errors: [] }] }),
  "config/batchWrite": (p) => {
    const file = process.env.FAKE_CODEX_CONFIG;
    if (file) {
      const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      for (const e of p.edits || []) {
        const keys = e.keyPath.split("."), last = keys.pop();
        let at = config;
        for (const k of keys) at = at[k] ??= {};
        at[last] = e.mergeStrategy === "upsert" ? { ...at[last], ...e.value } : e.value;
      }
      fs.writeFileSync(file, JSON.stringify(config));
    }
    return { status: "ok" };
  },
  ...(process.env.FAKE_CODEX_CONFIG && { "config/read": () => ({ config: fs.existsSync(process.env.FAKE_CODEX_CONFIG) ? JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_CONFIG, "utf8")) : {}, origins: {}, layers: null }) }),
  initialize: () => ({}),
  // thread/name/set answers {} as the real CLI does; FAKE_CODEX_NAMES names a file that records each call as "<threadId>\t<name>\n".
  "thread/name/set": (p) => { if (process.env.FAKE_CODEX_NAMES) fs.appendFileSync(process.env.FAKE_CODEX_NAMES, `${p.threadId}\t${p.name}\n`); return {}; },
  "account/read": () => ({ account: process.env.FAKE_CODEX_LOGGED_OUT ? null : { type: "chatgpt", email: "User@Example.Test", planType: "pro" }, requiresOpenaiAuth: true }),
  "model/list": (p) => p.cursor === "page-2"
    ? { data: [{ model: "gpt-b", hidden: false, supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" }], nextCursor: null }
    : { data: [{ model: "gpt-a", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "ultra" }], defaultReasoningEffort: "medium" },
      { model: "gpt-hidden", hidden: true, supportedReasoningEfforts: ["low"] }], nextCursor: "page-2" },
  "account/rateLimits/read": () => ({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1793000000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1793600000 } } }),
};
send({ method: "account/updated", params: {} });
send({ id: 1, method: "item/tool/requestUserInput", params: {} });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return; // the "initialized" notification
  if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ method: m.method, params: m.params, argv: process.argv.slice(2) }) + "\n");
  const answer = process.env.FAKE_CODEX_FAIL && m.method !== "initialize" ? undefined : answers[m.method];
  send(answer ? { id: m.id, result: answer(m.params || {}) } : { id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
});
