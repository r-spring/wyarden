'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { detectStyle, serialize, MAX_BYTES } = require('../install.js');
const { inspectCodexHooks } = require('./codex-app-server.js');
const { EVENTS: COMMAND_EVENTS } = require('../hook-bridge.js');

const FILE = 'hooks.json';
const MARKER = 'Wyarden 3D Monitor';
const EVENTS = COMMAND_EVENTS.codex;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const marked = hook => hook?.type === 'command' && hook.statusMessage === MARKER;
const nativeEvent = ev => ev[0].toLowerCase() + ev.slice(1);
const sameFile = (one, two) => process.platform === 'win32' ? one.toLowerCase() === two.toLowerCase() : one === two;

function configDirs({ home = os.homedir(), env = process.env } = {}) {
  const dir = env.CODEX_HOME || path.join(home, '.codex');
  return path.isAbsolute(dir) ? [path.normalize(dir)] : [];
}

// Match semantic tokens so serialization cannot silently drop duplicate keys or round numbers.
const jsonTokens = text => text.replace(/"(?:[^"\\]|\\.)*"|[ \t\r\n]+/g, token =>
  token[0] === '"' ? JSON.stringify(JSON.parse(token)) : '');

function readConfig(dir, commandFor) {
  const c = { dir, file: path.join(dir, FILE), exists: false, before: '', after: '', changed: false,
    state: 'missing', error: null, reformatted: false, added: 0, replaced: 0, collapsed: 0, removed: 0 };
  try {
    const stat = fs.lstatSync(c.file);
    c.exists = true;
    // Refuse linked or unusually large files to keep setup bounded and preserve their destination.
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('unsafe file');
    const raw = fs.readFileSync(c.file);
    if (raw.length > MAX_BYTES) throw new Error('oversized file');
    c.before = c.after = raw.toString('utf8');
    if (!Buffer.from(c.before).equals(raw)) throw new Error('invalid UTF-8');
    const text = c.before.replace(/^\ufeff/, '');
    const doc = JSON.parse(text);
    if (!isObject(doc) || jsonTokens(text) !== JSON.stringify(doc) ||
        (Object.hasOwn(doc, 'hooks') && !isObject(doc.hooks))) throw new Error('invalid hooks document');
    const hooks = doc.hooks || {};
    const own = new Map();
    for (const event of EVENTS) {
      const groups = hooks[event] || [];
      if ((Object.hasOwn(hooks, event) && !Array.isArray(hooks[event])) ||
          groups.some(group => !isObject(group) || !Array.isArray(group.hooks))) throw new Error('invalid groups');
      const indices = [];
      groups.forEach((group, index) => {
        if (!group.hooks.some(marked)) return;
        if (group.hooks.length !== 1) throw new Error('mixed Wyarden hook group');
        if (commandFor) {
          const hook = group.hooks[0], command = commandFor('codex', event);
          if (!command || hook.command !== command || (Object.hasOwn(hook, 'commandWindows') && hook.commandWindows !== command) ||
              Object.keys(group).some(key => key !== 'hooks') ||
              Object.keys(hook).some(key => !['type', 'command', 'commandWindows', 'timeout', 'statusMessage'].includes(key))) {
            throw new Error('the reserved Wyarden marker is in an unrelated group');
          }
        }
        indices.push(index);
      });
      if (indices.length) own.set(event, indices);
    }
    c.state = own.size === EVENTS.length ? 'installed' : own.size ? 'partly' : 'missing';
    return { c, doc, hooks, own };
  } catch (error) {
    if (error.code === 'ENOENT' && !c.exists) return { c, doc: {}, hooks: {}, own: new Map() };
    c.state = 'unreadable';
    c.error = 'Codex hooks.json could not be safely edited.';
    return { c };
  }
}

function editConfig(dir, mode, commandFor) {
  const { c, doc, hooks, own } = readConfig(dir, commandFor);
  if (c.error) return c;
  const configured = new Map();
  if (mode === 'add') {
    for (const event of EVENTS) {
      const command = typeof commandFor === 'function' ? commandFor('codex', event) : null;
      if (typeof command !== 'string' || !command.trim() || /[\r\n\0]/.test(command)) {
        c.error = 'The stable Codex hook command is unavailable.';
        return c;
      }
      // Synchronous delivery preserves event order. The transport must return promptly.
      configured.set(event, { hooks: [{ type: 'command', command, timeout: 5, statusMessage: MARKER }] });
    }
  }

  for (const event of EVENTS) {
    const indices = own.get(event) || [];
    if (mode === 'remove' && !indices.length) continue;
    const groups = hooks[event] || [];
    if (mode === 'add') {
      const wanted = configured.get(event);
      const first = indices.shift();
      if (first === undefined) { groups.push(wanted); c.added++; }
      else if (!isDeepStrictEqual(groups[first], wanted)) { groups[first] = wanted; c.replaced++; }
    }
    for (const index of indices.reverse()) {
      // Codex keys approvals by group/handler index. Keep later unrelated groups at their old index.
      if (index === groups.length - 1) groups.pop();
      else groups[index] = { hooks: [] };
      if (mode === 'add') c.collapsed++;
      else c.removed++;
    }
    if (groups.length) hooks[event] = groups;
    else delete hooks[event];
  }
  if (c.added || c.replaced || c.collapsed || c.removed) {
    doc.hooks = hooks;
    const style = detectStyle(c.before, !c.exists);
    c.after = serialize(doc, { ...style, final: !c.exists || c.before.endsWith('\n') });
    c.changed = c.after !== c.before;
    c.reformatted = c.changed && c.exists;
  }
  return c;
}

function planConfig(_hub, { dirs = configDirs(), mode = 'add', commandFor } = {}) {
  if (!['add', 'remove'].includes(mode)) throw new TypeError('Invalid Codex collector mode');
  return dirs.filter(dir => typeof dir === 'string' && path.isAbsolute(dir)).map(dir => editConfig(dir, mode, commandFor));
}

async function status(dirs, _hub, { executable, commandFor, inspectHooks = inspectCodexHooks } = {}) {
  return Promise.all(dirs.map(async dir => {
    const { c, hooks, own } = readConfig(dir, commandFor);
    const result = { dir, file: c.file, state: c.state, error: c.error, approval: 'unavailable' };
    if (!own?.size) return result;
    let data;
    try { data = await inspectHooks(dir, { executable }); } catch { /* status stays unknown when Codex is unavailable */ }
    if (!data) return { ...result, state: 'approval-unknown' };
    if (!Array.isArray(data.data)) return { ...result, state: 'approval-unknown' };
    const hooksByEvent = data.data.flatMap(entry => Array.isArray(entry?.hooks) ? entry.hooks : []);
    const states = [];
    for (const [event, indices] of own) {
      for (const index of indices) {
        const hook = hooks[event][index].hooks[0];
        const expected = process.platform === 'win32' ? hook.commandWindows || hook.command : hook.command;
        const found = hooksByEvent.filter(item => item?.handlerType === 'command' && item.eventName === nativeEvent(event) &&
          item.source === 'user' && typeof item.sourcePath === 'string' && sameFile(c.file, item.sourcePath) &&
          item.statusMessage === MARKER && item.command === expected);
        states.push(found.length === 1 ? found[0] : null);
      }
    }
    if (states.some(item => item?.enabled && ['untrusted', 'modified'].includes(item.trustStatus))) {
      return { ...result, state: 'awaiting-approval', approval: 'awaiting-approval' };
    }
    if (states.some(item => !item || !item.enabled)) return { ...result, state: 'inactive', approval: 'inactive' };
    if (!states.every(item => item.trustStatus === 'trusted')) return { ...result, state: 'approval-unknown' };
    return { ...result, approval: 'approved' };
  }));
}

module.exports = { EVENTS, configDirs, planConfig, status };
