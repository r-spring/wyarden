#!/usr/bin/env node
// Strict-route probe check (the user, 17 November 2026). Interactive Claude transcripts use chained
// attachment records. Require the root through the first reply, an initial agent listing and an
// explicit deferred-tool list. Later attachments can reveal a violation, but cannot fill a gap at start.
// Usage: node tools/strict-probe-check.js <transcript.jsonl> [--allow mcp1,mcp2]
"use strict";
const fs = require("fs");

const identifier = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const validId = value => typeof value === "string" && identifier.test(value);
const named = value => typeof value === "string" && value.trim().length > 0;

function names(a, field, { optional = false, server = false } = {}) {
  if (optional && !(field in a)) return [];
  const values = a[field];
  if (!Array.isArray(values)) throw new Error("invalid " + a.type + "." + field);
  return values.map(value => {
    const name = server && typeof value === "object" ? value?.name : value;
    if (!named(name)) throw new Error("invalid entry in " + a.type + "." + field);
    return name;
  });
}

function seen(file) {
  const out = {
    sessionId: null, inconclusive: null, initialMcpServers: new Set(),
    skills: new Set(), mcpServers: new Set(), mcpTools: new Set(), failedMcp: new Set(),
    pendingMcp: new Set(), needsAuthMcp: new Set(), agents: new Set(), hooks: new Set(),
  };
  let parent = null, prompt = false, reply = false, initialAgents = false, initialTools = false;
  const ids = new Set();
  function declare(name) {
    out.mcpServers.add(name);
    if (!reply) out.initialMcpServers.add(name);
  }
  let lineNumber = 0;
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      lineNumber++;
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      if (!named(o?.type)) throw new Error("unrecognized transcript record");
      if ("sessionId" in o) {
        if (!validId(o.sessionId) || (out.sessionId && o.sessionId !== out.sessionId)) throw new Error("invalid or mixed session IDs");
        out.sessionId = o.sessionId;
      }
      if (!["attachment", "user", "assistant", "system"].includes(o.type) && !("parentUuid" in o)) {
        if (!["file-history-snapshot", "queue-operation", "last-prompt", "ai-title", "custom-title"].includes(o.type) ||
            "attachment" in o || "message" in o || "session_id" in o) throw new Error("unrecognized transcript envelope");
        continue; // Auxiliary metadata such as file-history-snapshot does not advance the message chain.
      }
      if (!validId(o.sessionId) || !validId(o.uuid) || o.isSidechain !== false ||
          o.parentUuid !== parent || ids.has(o.uuid)) throw new Error("incomplete or ambiguous main-session chain");
      if ((!reply && (o.isCompactSummary || o.logicalParentUuid || o.subtype === "compact_boundary")) ||
          ("attachment" in o && o.type !== "attachment")) throw new Error("ambiguous transcript boundary or attachment");
      ids.add(o.uuid);
      parent = o.uuid;
      if (o.type === "user" || o.type === "assistant") {
        if (o.message?.role !== o.type || !(Array.isArray(o.message.content) || (o.type === "user" && named(o.message.content)))) {
          throw new Error("invalid turn record");
        }
        if (o.type === "user") {
          if (!reply && o.isMeta) throw new Error("missing initial user turn");
          if (prompt && !reply) throw new Error("ambiguous first turn");
          prompt = true;
        } else {
          if (!prompt) throw new Error("missing first prompt");
          reply = true;
        }
        continue;
      }
      if (o.type !== "attachment") continue;
      const a = o.attachment;
      if (!named(a?.type)) throw new Error("malformed attachment");
      switch (a.type) {
        case "deferred_tools_delta":
          for (const name of [...names(a, "addedNames"), ...names(a, "readdedNames", { optional: true })]) {
            if (!name.startsWith("mcp__")) continue;
            const [, server, ...tool] = name.split("__");
            if (!named(server) || !named(tool.join("__"))) throw new Error("malformed MCP tool name");
            out.mcpTools.add(name);
            declare(server);
          }
          for (const [field, target] of [["failedMcpServers", out.failedMcp], ["pendingMcpServers", out.pendingMcp], ["needsAuthMcpServers", out.needsAuthMcp]]) {
            for (const name of names(a, field, { optional: true, server: true })) target.add(name);
          }
          if (!reply) initialTools = true;
          break;
        case "mcp_instructions_delta":
          for (const name of names(a, "addedNames")) declare(name);
          break;
        case "agent_listing_delta":
          for (const name of names(a, "addedTypes")) out.agents.add(name);
          if (!reply && a.isInitial === true) initialAgents = true;
          break;
        case "skill_listing": {
          const listed = names(a, "names");
          if ("skillCount" in a && a.skillCount !== listed.length) throw new Error("inconsistent skill count");
          for (const name of listed) out.skills.add(name);
          break;
        }
        case "hook_success": case "hook_blocking_error": case "hook_non_blocking_error":
          if (!named(a.command) || !named(a.hookEvent || a.hookName)) throw new Error("malformed hook attachment");
          out.hooks.add((a.hookEvent || a.hookName) + ": " + a.command);
          break;
      }
    }
    if (!reply || !initialTools || !initialAgents) out.inconclusive = "missing first turn or initial capability listing";
  } catch (error) {
    out.inconclusive = "line " + lineNumber + ": " + (error instanceof SyntaxError ? "invalid JSON" : error.message);
  }
  return out;
}

function judge(s, allow) {
  if (!validId(s.sessionId) || s.inconclusive !== null) return ["INCONCLUSIVE: " + (s.inconclusive || "missing session evidence")];
  const bad = [];
  for (const n of s.skills) bad.push("skill " + n);
  for (const n of s.mcpServers) if (!allow.includes(n)) bad.push("MCP server " + n);
  for (const [status, servers] of [["failed", s.failedMcp], ["pending", s.pendingMcp], ["needs-auth", s.needsAuthMcp]]) {
    for (const n of servers) bad.push(status + " MCP server " + n);
  }
  for (const n of s.agents) if (n.includes(":")) bad.push("plugin agent " + n);
  for (const h of s.hooks) if (/[\\/]\.claude[\\/]plugins[\\/]|CLAUDE_PLUGIN_ROOT/.test(h)) bad.push("plugin hook " + h);
  for (const n of allow) if (!s.initialMcpServers.has(n)) bad.push("selected MCP server " + n + " is missing from the initial listing");
  return bad;
}

module.exports = { seen, judge };

if (require.main === module) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) { console.error("usage: node tools/strict-probe-check.js <transcript.jsonl> [--allow mcp1,mcp2]"); process.exit(2); }
  const s = seen(file), i = rest.indexOf("--allow");
  console.log(JSON.stringify(s, (k, v) => v instanceof Set ? [...v].sort() : v, 1));
  if (s.inconclusive) {
    console.log("INCONCLUSIVE: " + s.inconclusive);
    process.exitCode = 1;
  } else if (i >= 0) {
    const bad = judge(s, (rest[i + 1] || "").split(",").filter(Boolean));
    console.log(bad.length ? "FAIL: " + bad.join("; ") : "PASS: only the selected MCP servers; no skill, plugin agent or plugin hook");
    process.exitCode = bad.length ? 1 : 0;
  }
}
