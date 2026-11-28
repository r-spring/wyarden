'use strict';

const contract = require('../contract.js');
const { EVENTS, configDirs, planConfig, status, apply } = require('./grok-config.js');

const own = (value, name) => value && typeof value === 'object' && Object.hasOwn(value, name) ? value[name] : undefined;
const aliased = (value, name, alias) => own(value, name) ?? own(value, alias);
const eventNames = new Map();
for (const name of EVENTS) {
  eventNames.set(name, name);
  eventNames.set(name[0].toLowerCase() + name.slice(1), name);
  eventNames.set(name.replace(/[A-Z]/g, (letter, index) => (index ? '_' : '') + letter.toLowerCase()), name);
}

const classes = new Map([
  ['read_file', 'read'], ['list_dir', 'read'],
  ['search_replace', 'edit'], ['write', 'edit'], ['grep', 'search'],
  ['run_terminal_command', 'execute'], ['web_search', 'fetch'], ['web_fetch', 'fetch'],
  ['spawn_subagent', 'agent'], ['ask_user_question', 'ask']
]);
const resourceArgs = new Map([
  ['read_file', ['target_file', 'file', 'read']],
  ['search_replace', ['file_path', 'file', 'write']],
  ['list_dir', ['target_directory', 'dir', 'read']],
  ['grep', ['path', 'dir', 'search']]
]);
const abs = value => contract.isAbsolute(value) && value === contract.cleanText(value, contract.MAX_PATH) ? value : null;
const namePattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/;
const datePattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/;
const maxWaiting = 200;

function eventName(payload) {
  const nativeName = own(payload, 'hookEventName');
  const compatibleName = own(payload, 'hook_event_name');
  const name = eventNames.get(nativeName ?? compatibleName);
  return nativeName !== undefined && compatibleName !== undefined && eventNames.get(compatibleName) !== name ? undefined : name;
}

function matches(payload, context) {
  // Grok sends Claude's snake_case fields too. Its camelCase session ID identifies the envelope on either URL.
  const session = own(payload, 'sessionId');
  const alias = own(payload, 'session_id');
  return context.source === 'hook' && contract.isSessionId(session) && (alias === undefined || alias === session) && !!eventName(payload);
}

function toolTarget(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const label = namePattern.test(raw) ? contract.safeName(raw) : 'unknown';
  const qualified = /^(?:mcp__)?([A-Za-z0-9_.-]+?)__([A-Za-z0-9_.-]+)$/.exec(label);
  if (qualified) return { server: contract.safeName(qualified[1]), tool: contract.safeName(qualified[2]) };
  return { tool: label, class: classes.get(raw) || 'other' };
}

function resourceOf(tool, input, root, cwd) {
  if (tool === 'web_search') return { kind: 'search', op: 'search' };
  const rule = resourceArgs.get(tool);
  if (!rule) return null;
  const [field, kind, op] = rule;
  const target = own(input, field);
  if (typeof target !== 'string' || !target || target.length > contract.MAX_PATH || target.endsWith(' [truncated]')) return null;
  const kept = contract.keptPath(root, cwd, target);
  return kept === null ? null : { kind, op, path: kept };
}

function createAdapter(_options = {}) {
  const waiting = new Set();

  function normalise(payload, { t, rootInfo }) {
    const session = own(payload, 'sessionId');
    const event = eventName(payload);
    const key = 'grok:' + session;
    const toolCwd = abs(own(payload, 'cwd'));
    const workspace = abs(own(payload, 'workspaceRoot'));
    // Grok's workspaceRoot can be above the folder where the CLI was launched.
    const cwd = toolCwd && (!workspace || contract.isInside(workspace, toolCwd)) ? toolCwd : workspace;
    const root = cwd && rootInfo ? rootInfo(cwd) : null;
    const source = 'hook';
    const src = source + ':' + event;
    const turn = contract.safeId(own(payload, 'promptId'));
    const timestamp = own(payload, 'timestamp');
    const at = typeof timestamp === 'string' && datePattern.test(timestamp) ? Date.parse(timestamp) : NaN;
    const events = [];
    const add = (ev, fields = {}, grade = 'exact', from = src) => {
      const entry = { v: 1, t, agent: 'grok', session, ws: root?.ws || '', ev, grade, src: from, ...fields };
      if (Number.isFinite(at)) entry.at = at;
      if (turn) entry.turn = turn;
      events.push(entry);
    };
    const clearPermission = (answer = 'unknown') => {
      if (waiting.delete(key)) add('wait.end', { why: 'permission', answer }, 'derived');
    };

    switch (event) {
      case 'SessionStart': {
        waiting.delete(key);
        const start = own(payload, 'source');
        add('session.start', {
          ...(['new', 'load'].includes(start) ? { source: start } : {}),
          ...(root?.name ? { root: { name: root.name } } : {})
        });
        break;
      }
      case 'SessionEnd': {
        waiting.delete(key);
        const reason = own(payload, 'reason');
        add('session.end', ['shutdown', 'channel_closed'].includes(reason) ? { reason } : {});
        break;
      }
      case 'UserPromptSubmit':
        waiting.delete(key);
        add('turn.start');
        break;
      case 'Stop':
      case 'StopFailure':
      case 'StopCancelled': {
        // Grok emits a second, shutdown Stop after SessionEnd. Treat only the real turn stop as completion.
        if (event === 'Stop' && own(payload, 'reason') !== 'end_turn') break;
        clearPermission();
        add('turn.end', { outcome: event === 'Stop' ? 'done' : event === 'StopFailure' ? 'failed' : 'interrupted' });
        break;
      }
      case 'Notification': {
        const type = aliased(payload, 'notificationType', 'notification_type');
        if (type === 'permission_prompt') {
          if (waiting.has(key)) break;
          waiting.add(key);
          if (waiting.size > maxWaiting) waiting.delete(waiting.values().next().value);
          add('wait.start', { why: 'permission' });
        } else if (type === 'idle_prompt') {
          add('wait.start', { why: 'idle' });
        }
        break;
      }
      default: {
        const rawTool = aliased(payload, 'toolName', 'tool_name');
        const call = contract.safeId(aliased(payload, 'toolUseId', 'tool_use_id'));
        const target = toolTarget(rawTool);
        if (event === 'PreToolUse') {
          if (!call || !target) break;
          add(target.server ? 'mcp.start' : 'tool.start', { call, ...target }, target.server ? 'derived' : 'exact');
          const resource = resourceOf(rawTool, aliased(payload, 'toolInput', 'tool_input'), root, toolCwd || cwd);
          if (resource) add('resource.touch', { call, ...resource }, 'derived', 'args:' + target.tool);
          break;
        }
        clearPermission(event === 'PermissionDenied' ? 'refused' : 'allowed');
        if (!call) break;
        const result = aliased(payload, 'toolResult', 'tool_response');
        const fileMissing = rawTool === 'read_file' && own(result, 'FileNotFound') !== undefined;
        const ok = event === 'PostToolUse' && !fileMissing;
        const duration = aliased(payload, 'durationMs', 'duration_ms');
        const fields = { call, ok };
        if (target) fields.tool = target.tool;
        if (target?.server) fields.server = target.server;
        if (Number.isFinite(duration) && duration >= 0) {
          fields.ms = duration;
          fields.msGrade = 'exact';
        }
        if (!ok) fields.error = event === 'PermissionDenied' ? 'denied' : 'tool_error';
        add(target?.server ? 'mcp.end' : 'tool.end', fields, target?.server ? 'derived' : 'exact');
      }
    }
    return { agent: 'grok', session, key, cwd, root, source, events };
  }

  return {
    provider: 'grok', routes: ['grok', 'claude'], matches, normalise, planConfig,
    forget: key => waiting.delete(key), size: () => waiting.size
  };
}

module.exports = { createAdapter, configDirs, planConfig, status, apply };
