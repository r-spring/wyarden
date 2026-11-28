'use strict';

const crypto = require('node:crypto');
const contract = require('../contract.js');
const { EVENTS, configDirs, planConfig, status } = require('./codex-config.js');
const { liveCodexSessions } = require('./codex-app-server.js');

const provider = 'codex';
const MAX_SESSIONS = 200;
const MAX_CALLS = 200;
const permissionModes = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']);
const own = (value, key) => value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined;
const hasText = value => typeof value === 'string' && value.length > 0;
const cwdOf = value => hasText(value) && value.length <= contract.MAX_PATH &&
  contract.isAbsolute(value) && value === contract.cleanText(value, contract.MAX_PATH) ? value : null;
const lifecycle = new Map([
  ['SessionStart', 'session.start'], ['SessionEnd', 'session.end'], ['UserPromptSubmit', 'turn.start'],
  ['Stop', 'turn.end'], ['Interrupt', 'turn.end'], ['SubagentStart', 'subagent.start'], ['SubagentStop', 'subagent.stop']
]);

function matches(payload, { source }) {
  const event = own(payload, 'hook_event_name');
  const transcript = own(payload, 'transcript_path');
  if (source !== 'hook' || !EVENTS.includes(event) || !cwdOf(own(payload, 'cwd')) ||
      !contract.isSessionId(own(payload, 'session_id')) || (transcript !== null && typeof transcript !== 'string')) return false;
  if (event === 'SessionEnd') return own(payload, 'reason') === 'other' && own(payload, 'model') === undefined;
  if (!hasText(own(payload, 'model')) || !permissionModes.has(own(payload, 'permission_mode'))) return false;
  if (event === 'SessionStart') return ['startup', 'resume', 'clear', 'compact', 'fork'].includes(own(payload, 'source'));
  if (!hasText(own(payload, 'turn_id'))) return false;
  if (['PreToolUse', 'PostToolUse', 'PermissionRequest'].includes(event) && !hasText(own(payload, 'tool_name'))) return false;
  if (event === 'PreToolUse' || event === 'PostToolUse') return hasText(own(payload, 'tool_use_id'));
  if (event === 'SubagentStart' || event === 'SubagentStop') return hasText(own(payload, 'agent_id'));
  return true;
}

function describe(name) {
  const tool = contract.safeName(name);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { tool: contract.safeName(mcp[2]), server: contract.safeName(mcp[1]), class: 'mcp' };
  return { tool, class: name === 'Bash' ? 'execute' : name === 'apply_patch' ? 'edit' : 'other' };
}

function resultOf(info, response) {
  if (info.server && own(response, 'isError') === true) return { ok: false, error: 'tool_error' };
  // Unified exec sends raw output. A PostToolUse receipt is tool completion, with no exit status.
  // Only an explicit numeric field can establish a command's exit status.
  const exitCode = info.class === 'execute' ? own(response, 'exit_code') : undefined;
  if (Number.isInteger(exitCode) && exitCode !== 0) return { ok: false, error: 'tool_error' };
  return { ok: true };
}

function patchPaths(input, root, cwd) {
  const text = own(input, 'command');
  if (typeof text !== 'string' || !text.startsWith('*** Begin Patch') || !root) return [];
  const paths = new Map();
  // At most 32 paths per patch are published, even when one patch edits hundreds of files.
  for (const match of text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): ([^\r\n]+)$/gm)) {
    const file = contract.keptPath(root, cwd, match[1]);
    if (file) paths.set(JSON.stringify(file), file);
    if (paths.size === 32) break;
  }
  return [...paths.values()];
}

function remember(map, key, value, limit) {
  map.delete(key);
  if (map.size >= limit) map.delete(map.keys().next().value);
  map.set(key, value);
}

function createAdapter(options = {}) {
  const sessions = new Map();
  const salt = options.salt ?? crypto.randomBytes(16).toString('hex');

  function normalise(payload, { t, source, rootInfo = contract.rootInfo }) {
    const event = payload.hook_event_name;
    const session = payload.session_id;
    const key = provider + ':' + session;
    const eventCwd = cwdOf(payload.cwd);
    const s = sessions.get(key) || { cwd: eventCwd, calls: new Map(), wait: null };
    if (event === 'SessionStart' || event === 'UserPromptSubmit') s.cwd = eventCwd;
    remember(sessions, key, s, MAX_SESSIONS);
    const root = rootInfo(s.cwd);
    const events = [];
    const turn = contract.safeId(own(payload, 'turn_id'));
    const by = contract.safeId(own(payload, 'agent_id'));
    const emit = (ev, fields, grade = 'exact') => events.push({
      v: 1, t, agent: provider, session, ws: root?.ws || '', ev, grade, src: 'hook:' + event,
      ...(turn && { turn }), ...fields
    });
    const endWait = (answer) => {
      if (!s.wait) return;
      emit('wait.end', { why: 'permission', answer }, 'derived');
      s.wait = null;
    };

    if (lifecycle.has(event)) {
      let fields = {};
      if (event === 'SessionStart') {
        fields = { source: payload.source, model: contract.safeName(payload.model) };
        if (root?.name) fields.root = { name: root.name };
      } else if (event === 'SessionEnd') {
        fields.reason = 'other';
        sessions.delete(key);
      } else if (event === 'Stop' || event === 'Interrupt') {
        if (s.wait?.turn === turn) endWait('unknown');
        fields.outcome = event === 'Stop' ? 'done' : 'interrupted';
      } else if (event === 'UserPromptSubmit' && !by) {
        endWait('unknown');
      } else if (event === 'SubagentStart' || event === 'SubagentStop') {
        fields = { sub: by };
        const type = contract.safeName(own(payload, 'agent_type'));
        if (type) fields.type = type;
      }
      if (event !== 'UserPromptSubmit' || !by) emit(lifecycle.get(event), fields);
    } else {
      const info = describe(payload.tool_name);
      const input = own(payload, 'tool_input');
      const hash = event !== 'PostToolUse' || s.wait ? contract.inputHash(payload.tool_name, input, salt) : undefined;
      const call = contract.safeId(own(payload, 'tool_use_id'));
      const details = info.server ? { tool: info.tool, server: info.server } : { tool: info.tool, class: info.class };
      if (event === 'PermissionRequest') {
        s.wait = { turn, hash, by };
        emit('wait.start', { why: 'permission', tool: info.tool });
      } else if (event === 'PreToolUse') {
        if (!s.calls.has(call)) remember(s.calls, call, { t, by }, MAX_CALLS);
        emit(info.server ? 'mcp.start' : 'tool.start', { call, ...details, hash, ...(by && { by }) }, info.server ? 'derived' : 'exact');
      } else {
        if (s.wait?.turn === turn && s.wait.by === by && s.wait.hash === hash) endWait('allowed');
        const started = s.calls.get(call);
        s.calls.delete(call);
        const actor = by || started?.by;
        const result = resultOf(info, own(payload, 'tool_response'));
        const duration = started && t >= started.t ? { ms: t - started.t, msGrade: 'derived' } : {};
        emit(info.server ? 'mcp.end' : 'tool.end', { call, ...details, ...result, ...duration, ...(actor && { by: actor }) },
          info.server || info.class === 'execute' ? 'derived' : 'exact');
        if (info.class === 'edit' && result.ok) {
          for (const path of patchPaths(input, root, eventCwd)) {
            emit('resource.touch', { call, kind: 'file', op: 'write', path, ...(actor && { by: actor }) }, 'derived');
          }
        }
      }
    }
    return { agent: provider, session, key, cwd: s.cwd, root, source, events };
  }

  return { provider, routes: [provider], matches, normalise, planConfig,
    forget: key => sessions.delete(key), size: () => sessions.size };
}

module.exports = { createAdapter, configDirs, planConfig, status, liveCodexSessions, EVENTS };
