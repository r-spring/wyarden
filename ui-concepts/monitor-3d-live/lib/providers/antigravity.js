'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const contract = require('../contract.js');
const { MAX_BYTES, detectStyle, serialize } = require('../install.js');

const provider = 'antigravity';
const FILE = 'hooks.json';
const GROUP = 'wyarden-monitor-antigravity';
const EVENTS = Object.freeze(['SessionStart', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop']);
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const TOOL_CLASSES = new Map([['call_mcp_tool', 'mcp'], ['run_command', 'execute'], ['read_url_content', 'fetch']]);
const TARGETS = new Map([
  ['read_file', ['file', 'read', 'Path']],
  ['view_file', ['file', 'read', 'AbsolutePath']],
  ['write_to_file', ['file', 'write', 'TargetFile']],
  ['replace_file_content', ['file', 'write', 'TargetFile']],
  ['multi_replace_file_content', ['file', 'write', 'TargetFile']],
  ['list_dir', ['dir', 'search', 'DirectoryPath']],
  ['find_by_name', ['dir', 'search', 'SearchDirectory']],
  ['grep_search', ['dir', 'search', 'SearchPath']],
  ['read_url_content', ['url', 'read', 'Url']],
  ['search_web', ['search', 'search', 'query']]
]);
const index = value => Number.isSafeInteger(value) && value >= 0;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validPath = value => contract.isAbsolute(value) && value === contract.cleanText(value, contract.MAX_PATH);
const eagerMcp = name => name.startsWith('mcp_');

// The fixed command's event also covers versions that omit hookEventName from stdin.
function tagHookPayload(event, payload) {
  if (!EVENTS.includes(event) || !isObject(payload) ||
      (Object.hasOwn(payload, 'hookEventName') && payload.hookEventName !== event)) return null;
  return { ...payload, hookEventName: event };
}

function hookAcknowledgement(event) {
  if (event === 'PreToolUse') return { decision: 'allow' };
  if (event === 'Stop') return { decision: 'stop' };
  return {};
}

function workspaceOf(payload) {
  const roots = payload.workspacePaths.filter(validPath);
  if (validPath(payload.cwd) && (!roots.length || roots.some(root => contract.isInside(root, payload.cwd)))) return payload.cwd;
  return roots[0] || null;
}

function toolFields(name, args) {
  if (name === 'call_mcp_tool') {
    const server = contract.safeName(args.ServerName), tool = contract.safeName(args.ToolName);
    if (server && tool) return { tool, server, serverSource: 'args' };
  }
  return { tool: name };
}

function resource(kind, op, value, root, cwd, server) {
  if (typeof value !== 'string' || !value || value !== contract.cleanText(value, contract.MAX_PATH)) return null;
  if (kind === 'search') return { kind, op };
  if (kind === 'url' || kind === 'mcp-resource') {
    const url = contract.cleanUrl(value);
    if (url) return { kind: 'url', op, url };
    const scheme = /^([a-z][a-z0-9+.-]{0,31}):/i.exec(value)?.[1];
    return kind === 'mcp-resource' && scheme && !contract.isAbsolute(value)
      ? { kind, op, scheme: scheme.toLowerCase(), ...(server && { server }) } : null;
  }
  const kept = contract.keptPath(root, cwd, value);
  return kept == null ? null : { kind, op, path: kept };
}

function touches(name, args, fields, root, cwd) {
  const input = name === 'call_mcp_tool' ? args.Arguments : eagerMcp(name) ? args : null;
  if (isObject(input)) {
    return [resource('file', 'unknown', input.path, root, cwd),
      resource('file', 'unknown', input.file_path, root, cwd),
      resource('url', 'unknown', input.url),
      resource('mcp-resource', 'unknown', input.uri, root, cwd, fields.server)].filter(Boolean);
  }
  const target = TARGETS.get(name);
  if (!target) return [];
  const [kind, op, field] = target;
  const touch = resource(kind, op, args[field], root, cwd);
  return touch ? [touch] : [];
}

function createAdapter(_options = {}) {
  const sessions = new Map();
  return {
    provider,
    routes: [provider],
    matches(payload, { source }) {
      return source === 'hook' && isObject(payload) && contract.isSessionId(payload.conversationId) &&
        Array.isArray(payload.workspacePaths) && EVENTS.includes(payload.hookEventName);
    },
    normalise(payload, { t, source, rootInfo }) {
      const event = payload.hookEventName, session = payload.conversationId;
      const key = provider + ':' + session;
      const toolEvent = TOOL_EVENTS.has(event), stop = event === 'Stop';
      const invocation = event === 'PreInvocation' || event === 'PostInvocation';
      const call = payload.toolCall;
      const toolName = toolEvent && isObject(call) ? contract.safeName(call.name) : '';
      if (toolEvent && (!index(payload.stepIdx) || !toolName ||
          (call.args !== undefined && !isObject(call.args)))) return null;
      if (invocation && (!index(payload.invocationNum) || !index(payload.initialNumSteps))) return null;
      if (stop && (!index(payload.executionNum) || typeof payload.fullyIdle !== 'boolean')) return null;
      if ((stop || event === 'PostToolUse') && payload.error !== undefined && typeof payload.error !== 'string') return null;

      const cwd = workspaceOf(payload);
      const root = cwd && rootInfo ? rootInfo(cwd) : null;
      const base = { v: 1, t, agent: provider, session, ws: root?.ws || '', grade: 'exact', src: 'hook:' + event };
      const events = [];
      const state = sessions.get(key) || { calls: new Map(), turn: '' };
      sessions.delete(key);
      sessions.set(key, state);
      if (sessions.size > 500) sessions.delete(sessions.keys().next().value);

      if (event === 'SessionStart') {
        const model = contract.safeName(payload.modelName);
        events.push({ ...base, ev: 'session.start', ...(model && { model }) });
      } else if (event === 'PreInvocation' && (!state.turn || payload.invocationNum === 0)) {
        state.turn = 'invocation-' + payload.initialNumSteps + '-' + payload.invocationNum;
        events.push({ ...base, ev: 'turn.start', turn: state.turn, grade: 'derived' });
      } else if (stop && payload.fullyIdle) {
        const failed = Boolean(payload.error) || /^(?:error|max_steps_exceeded)$/i.test(payload.terminationReason);
        const interrupted = /^(?:cancel(?:led|ed)?|interrupt(?:ed)?)$/i.test(payload.terminationReason);
        events.push({ ...base, ev: 'turn.end', grade: 'derived', ...(state.turn && { turn: state.turn }),
          outcome: interrupted ? 'interrupted' : failed ? 'failed' : 'done' });
        state.turn = '';
      } else if (toolEvent) {
        const id = 'step-' + payload.stepIdx;
        const start = event === 'PreToolUse';
        const args = call.args || {};
        const open = state.calls.get(id);
        const named = toolFields(toolName, args);
        const fields = open?.fields || named;
        const tool = { ...base, ...fields, call: id,
          ev: (fields.server ? 'mcp.' : 'tool.') + (start ? 'start' : 'end') };
        if (fields.server) tool.grade = 'derived';
        if (state.turn) tool.turn = state.turn;
        if (start) {
          const op = TARGETS.get(call.name)?.[1];
          const type = TOOL_CLASSES.get(toolName) || (op === 'write' ? 'edit' : op);
          if (!fields.server) tool.class = eagerMcp(toolName) ? 'mcp' : type || 'other';
          if (!open) state.calls.set(id, { t, fields });
          if (state.calls.size > 256) state.calls.delete(state.calls.keys().next().value);
        } else {
          tool.ok = !payload.error;
          if (!tool.ok) tool.error = 'tool_error';
          if (open && t >= open.t) {
            open.ms ??= t - open.t;
            tool.ms = open.ms;
            tool.msGrade = 'derived';
          }
        }
        events.push(tool);
        if (start || !open) {
          for (const touch of touches(toolName, args, fields, root, cwd)) {
            events.push({ ...base, ...touch, ev: 'resource.touch', call: id, grade: 'derived', src: 'args:' + toolName });
          }
        }
      }
      // PostInvocation and non-idle Stop are observations of an execution that can still be running.
      return { agent: provider, session, key, cwd, root, source, events };
    },
    planConfig,
    forget: key => sessions.delete(key),
    size: () => sessions.size
  };
}

function configDirs({ home, env = process.env } = {}) {
  return [path.join(home || (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir(), '.gemini', 'config')];
}

function desiredGroup(commandFor) {
  return Object.fromEntries(EVENTS.map(event => {
    const command = commandFor(provider, event);
    if (typeof command !== 'string' || !command.trim() || /[\r\n\0]/.test(command)) throw new TypeError('invalid Antigravity hook command');
    const handler = { type: 'command', command, timeout: 5 };
    return [event, TOOL_EVENTS.has(event) ? [{ matcher: '*', hooks: [handler] }] : [handler]];
  }));
}

// The parsed file is valid JSON. Find top-level delimiters to preserve every unrelated value byte for byte.
function boundaries(text) {
  const edges = [];
  let depth = 0;
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\],]/g)) {
    const token = match[0];
    if ((depth === 0 && token === '{') || (depth === 1 && (token === ',' || token === '}'))) edges.push(match.index);
    if (token === '{' || token === '[') depth++;
    if (token === '}' || token === ']') depth--;
  }
  return edges;
}

function configChange(dir, mode, wanted) {
  const c = { dir, file: path.join(dir, FILE), exists: false, before: '', after: '', changed: false,
    state: 'missing', error: null, reformatted: false, added: 0, replaced: 0, collapsed: 0, removed: 0 };
  const refuse = message => ({ ...c, after: c.before, state: 'unreadable', error: message });
  try {
    const stat = fs.lstatSync(c.file);
    c.exists = true;
    if (!stat.isFile() || stat.size > MAX_BYTES) return refuse('Expected a regular Antigravity hooks JSON file within the size limit.');
    const raw = fs.readFileSync(c.file);
    if (raw.length > MAX_BYTES) return refuse('The Antigravity hooks exceed the configuration size limit.');
    c.before = c.after = raw.toString('utf8');
    if (!Buffer.from(c.before).equals(raw)) return refuse('Antigravity hooks are not UTF-8.');
  } catch (error) {
    if (error.code !== 'ENOENT' || c.exists) return refuse('Could not read Antigravity hooks (' + (error.code || 'error') + ').');
  }
  if (!wanted) return refuse('A stable Wyarden command is required to identify Antigravity hooks.');
  const text = c.exists ? c.before : '{}\n';
  let json;
  try { json = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return refuse('Antigravity hooks are not valid JSON.'); }
  if (!isObject(json)) return refuse('Antigravity hooks must be a JSON object.');

  const edges = boundaries(text);
  const positions = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const name = /^\s*("(?:[^"\\]|\\.)*")\s*:/.exec(text.slice(edges[i] + 1, edges[i + 1]));
    if (name && JSON.parse(name[1]) === GROUP) positions.push(i);
  }
  if (positions.length > 1) return refuse('The Wyarden Antigravity hook group is ambiguous.');
  const at = positions[0];
  const group = at === undefined ? null : json[GROUP];
  let count = 0;
  if (at !== undefined) {
    const collision = 'The reserved Antigravity hook group contains a command or setting Wyarden does not own.';
    if (!isObject(group) || !Object.entries(group).every(([event, handlers]) =>
      event === 'enabled' ? typeof handlers === 'boolean' : Object.hasOwn(wanted, event) && isDeepStrictEqual(handlers, wanted[event]))) return refuse(collision);
    const member = text.slice(edges[at] + 1, edges[at + 1]);
    const compact = member.replace(/"(?:[^"\\]|\\.)*"|\s+/g, token => token.startsWith('"')
      ? JSON.stringify(JSON.parse(token)) : '');
    // Comparing the member with the parsed form also detects shadowed duplicate keys within it.
    if (compact !== JSON.stringify({ [GROUP]: group }).slice(1, -1)) return refuse(collision);
    count = Object.keys(group).filter(event => event !== 'enabled').length;
    if (!count) return refuse('The reserved Antigravity hook group contains no Wyarden commands.');
    c.state = group.enabled === false ? 'stale' : count === EVENTS.length ? 'installed' : 'partly';
  }

  if (mode === 'remove') {
    if (at === undefined) return c;
    const last = at === edges.length - 2;
    const end = last ? text.slice(0, edges[at + 1]).trimEnd().length : edges[at + 1] + 1;
    const start = last && at > 0 ? edges[at] : edges[at] + 1;
    c.after = text.slice(0, start) + text.slice(end);
    c.removed = count;
  } else {
    if (c.state === 'installed') return c;
    const style = detectStyle(text, !Object.keys(json).length);
    const addition = serialize({ [GROUP]: wanted }, { ...style, bom: '' }).slice(1, -1).trimEnd();
    if (at === undefined) {
      const point = text.slice(0, edges.at(-1)).trimEnd().length;
      const separator = Object.keys(json).length ? ',' : '';
      c.after = text.slice(0, point) + separator + addition + text.slice(point);
      if (!c.exists) c.after = serialize({ [GROUP]: wanted }, { ...style, final: true });
    } else {
      c.after = text.slice(0, edges[at] + 1) + addition + text.slice(edges[at + 1]);
    }
    if (Buffer.byteLength(c.after) > MAX_BYTES) return refuse('The planned Antigravity hooks exceed the configuration size limit.');
    c.added = EVENTS.length - count;
    if (group?.enabled === false) c.replaced = count;
  }
  c.changed = true;
  return c;
}

function planConfig(_hub, { dirs = configDirs(), mode = 'add', commandFor } = {}) {
  if (mode !== 'add' && mode !== 'remove') throw new TypeError('invalid Antigravity configuration mode');
  const wanted = typeof commandFor === 'function' ? desiredGroup(commandFor) : null;
  return Array.from(dirs, dir => configChange(dir, mode, wanted));
}

function status(dirs, hub, options = {}) {
  const changes = planConfig(hub, { ...options, dirs, mode: 'remove' });
  const count = state => changes.filter(change => change.state === state).length;
  const folders = changes.length, installed = count('installed'), stale = count('stale');
  const state = folders > 0 && installed === folders ? 'installed' : installed + stale + count('partly') > 0 ? 'partly' : 'missing';
  return { state, folders, installed, stale, unreadable: count('unreadable') };
}

module.exports = { createAdapter, configDirs, status, EVENTS, hookAcknowledgement, tagHookPayload };
