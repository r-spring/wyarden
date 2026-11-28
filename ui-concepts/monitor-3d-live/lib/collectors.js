'use strict';
const fs = require('node:fs');
const path = require('node:path');
const C = require('./contract.js');
const discover = require('./discover.js');
const install = require('./install.js');
const { createProviderRouter } = require('./provider-router.js');
const codex = require('./providers/codex.js');
const grok = require('./providers/grok.js');
const antigravity = require('./providers/antigravity.js');

const fileIn = (...parts) => dir => path.join(dir, ...parts);
const providers = Object.freeze({
  claude: { label: 'Claude Code', configDirs: discover.claudeConfigDirs, status: install.status, events: install.EVENTS.map(e => e.name),
    restart: 'Restart an existing Claude Code session if its calls are still derived.' },
  codex: { ...codex, label: 'Codex', fileIn: fileIn('hooks.json'), events: codex.EVENTS, command: true,
    restart: 'Restart Codex, open /hooks, and review and approve the Wyarden commands there.' },
  grok: { ...grok, label: 'Grok Build', fileIn: fileIn('hooks', 'wyarden-monitor.json'), events: require('./providers/grok-config.js').EVENTS,
    restart: 'Restart Grok Build to load Wyarden’s HTTP hooks.' },
  antigravity: { ...antigravity, label: 'Antigravity', fileIn: fileIn('hooks.json'), events: antigravity.EVENTS, command: true,
    restart: 'Restart Antigravity to load the wyarden-monitor-antigravity hook group.' }
});

const adapters = () => [codex, grok, antigravity].map(provider => provider.createAdapter());
let configRouter;
function planConfig(...args) {
  configRouter ??= createProviderRouter(adapters());
  return configRouter.planConfig(...args);
}

function executable(name, env = process.env) {
  const binary = process.platform === 'win32' ? name + '.exe' : name;
  for (const entry of (env.PATH || env.Path || '').split(path.delimiter)) {
    const dir = entry.replace(/^"|"$/g, '');
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, binary);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch { /* try the next absolute PATH entry */ }
  }
  return undefined;
}

const shWord = value => "'" + value.replaceAll("'", "'\\''") + "'";
const psWord = value => "'" + value.replaceAll("'", "''") + "'";

function bridgeFor(home) {
  const file = path.resolve(home, 'collector-v1.js');
  const node = executable('node');
  const windows = process.platform === 'win32';
  const powershell = windows && path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const commandFor = (provider, event) => {
    if (!node || !providers[provider]?.command || !providers[provider].events.includes(event)) return null;
    if (!windows) return [shWord(node), shWord(file), provider, event].join(' ');
    if (!/^[a-z]:\\[a-z0-9_\\.-]+$/i.test(powershell) || !fs.existsSync(powershell)) return null;
    // Codex can choose cmd or PowerShell. A fixed PowerShell launcher passes paths with spaces through either shell.
    const script = '& ' + [psWord(node), psWord(file), provider, event].join(' ');
    return powershell + ' -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
  };
  return { dir: path.dirname(file), file, node, commandFor };
}

function dirsFor(provider, options) {
  return providers[provider].configDirs(options).filter(dir => {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
  });
}

async function status(provider, hub, bridge) {
  const spec = providers[provider], dirs = dirsFor(provider);
  if (dirs.length && spec.command && !bridge.commandFor(provider, spec.events[0])) {
    return { state: 'runtime-unavailable', folders: dirs.length, installed: 0 };
  }
  const binary = provider === 'codex' ? executable('codex') : undefined;
  const options = { commandFor: bridge.commandFor, executable: binary };
  const rows = provider === 'codex' && !binary
    ? await spec.status(dirs, hub, { ...options, inspectHooks: async () => null })
    : await spec.status(dirs, hub, options);
  function result(state, installed) {
    if (spec.command && ['installed', 'partly', 'awaiting-approval', 'approval-unknown', 'inactive'].includes(state)) {
      const change = install.planBridge(bridge.dir, bridge.file);
      if (change.error || !change.exists) return { state: 'bridge-unavailable', folders: dirs.length, installed: 0 };
    }
    return { state, folders: dirs.length, installed };
  }
  if (Array.isArray(rows)) {
    const count = state => rows.filter(row => row.state === state).length;
    const installed = count('installed');
    const state = ['awaiting-approval', 'approval-unknown', 'inactive', 'partly'].find(s => count(s)) ||
      (installed ? (installed === rows.length ? 'installed' : 'partly') : count('unreadable') ? 'unreadable' : 'missing');
    return result(state, installed);
  }
  return result(rows.state === 'missing' && rows.unreadable ? 'unreadable' : rows.state, rows.installed);
}

function plan(provider, dirs, hub, bridge, mode) {
  if (provider === 'claude') return mode === 'add' ? install.plan(dirs, hub) : install.planRemoval(dirs);
  if (dirs.length && providers[provider].command && !bridge.commandFor(provider, providers[provider].events[0])) {
    return dirs.map(dir => ({ file: providers[provider].fileIn(dir), error: 'The collector needs Node.js on the editor’s PATH and Windows PowerShell on Windows.' }));
  }
  return install.planProvider(provider, hub, dirs, { mode, commandFor: bridge.commandFor });
}

// Build the preview from the known collector entries. User values and operational tokens never enter the diff provider.
function preview(provider, change, mode, bridge) {
  if (provider === 'bridge') return { before: '', after: change.after };
  const spec = providers[provider];
  function side(text, after) {
    let config;
    try { config = JSON.parse(text.replace(/^\ufeff/, '')); } catch { config = {}; }
    const events = [];
    for (const event of spec.events) {
      const groups = config.hooks?.[event];
      const owned = provider === 'antigravity' ? Object.hasOwn(config['wyarden-monitor-antigravity'] || {}, event) :
        Array.isArray(groups) && groups.some(group => group.hooks?.some(h => provider === 'codex'
          ? h?.type === 'command' && h.statusMessage === 'Wyarden 3D Monitor'
          : h?.type === 'http' && C.isHookUrl(h.url)));
      if (owned) events.push(event);
    }
    const result = { collector: spec.label, entries: events, delivery: spec.command ? 'Local Wyarden command' : 'HTTP to 127.0.0.1 (token hidden)' };
    if (after && events.length && spec.command) result.command = [bridge.node, bridge.file, provider, '<event>'];
    if (after) result.changes = mode === 'add' ? { added: change.added, updated: change.replaced, duplicatesRemoved: change.collapsed } : { removed: change.removed };
    return JSON.stringify(result, null, 2) + '\n';
  }
  return { before: side(change.before, false), after: side(change.after, true) };
}

module.exports = { adapters, providers, planConfig, executable, bridgeFor, dirsFor, status, plan, preview };
