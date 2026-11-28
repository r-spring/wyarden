/* Wyarden 3D monitor, working mock-up: the extension.
 *
 * In every window it does three small things:
 *   1. It tells the hub which folders this window has open, over one connection that stays open.
 *      That connection is how the hub knows the workspace is alive; when the window closes, it drops.
 *      If no hub is running, this window starts it (a worker thread; no new process).
 *   2. It offers a floating monitor ("Wyarden 3D Monitor: Open", or the item in the status bar). A double-click on
 *      a session checks this machine's process list to find the terminal or chat panel in its editor.
 *   3. It offers reviewed set-up and removal of provider collectors.
 *
 * It reads no workspace setting and runs nothing from a workspace, so it also works in a
 * restricted (untrusted) window. Only stable `vscode` API is used: VS Code, VSCodium and Code - OSS
 * run the same file, on Windows and Linux.
 */
'use strict';
const vscode = require('vscode');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const C = require('./lib/contract.js');
const { createHubClient } = require('./lib/hub-client.js');
const discover = require('./lib/discover.js');
const install = require('./lib/install.js');
const collectors = require('./lib/collectors.js');
const procs = require('./lib/procs.js');
const { MonitorView, VIEW_TYPE, LEGACY_VIEW_TYPE } = require('./lib/view.js');

const DIFF_SCHEME = 'wyarden-monitor-change';

/** This window's folders that are on a disk. A virtual folder has no path an agent could work in. */
const folders = () => (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file').map(f => ({ path: f.uri.fsPath, name: f.name }));
/**
 * This window's name as its title shows it: the workspace file's name when the window has one
 * ("Example Shop.code-workspace" is "Example Shop"), else the editor's name for it, else its folder.
 * The chip for this window carries this name, so the owner finds the window he is looking at.
 */
function windowName() {
  const file = vscode.workspace.workspaceFile;
  if (file && file.scheme === 'file') { const base = path.basename(file.fsPath).replace(/\.code-workspace$/i, ''); if (base) return C.windowName(base); }
  return C.windowName(vscode.workspace.name) || (folders()[0] && folders()[0].name) || 'no folder';
}

function activate(context) {
  const out = vscode.window.createOutputChannel('Wyarden 3D Monitor');
  const log = (level, message) => out.appendLine(new Date().toISOString().slice(11, 19) + ' ' + (message === undefined ? level : level + ': ' + message));
  context.subscriptions.push(out);

  let hub;
  try { hub = C.ensureHubFile(); }
  catch (error) { log('error', error.message); void vscode.window.showErrorMessage('Wyarden 3D Monitor: ' + error.message); return; }

  const client = createHubClient({
    window: { id: crypto.randomBytes(6).toString('hex'), app: vscode.env.appName, name: windowName(), pid: process.pid, folders: folders() },
    log
  });
  const bridge = collectors.bridgeFor(C.monitorHome());
  const providerIds = Object.keys(collectors.providers);
  let collectorsNow = {};
  let collectorProbe;
  function refreshCollectors() {
    collectorProbe ??= Promise.all(providerIds.map(async provider => {
      const current = await collectors.status(provider, hub, bridge).catch(() => ({ state: 'unavailable' }));
      const previous = collectorsNow[provider];
      if (previous?.state === current.state && previous.folders === current.folders && previous.installed === current.installed) return;
      collectorsNow = { ...collectorsNow, [provider]: current };
      view.sendHub();
    })).then(() => collectorsNow).finally(() => { collectorProbe = undefined; });
    return collectorProbe;
  }
  const view = new MonitorView(vscode, context, {
    client, folders, collectors: () => collectorsNow, log: message => log('view', message),
    // For a double-click on a session: its own file, then its process's ancestors, read only then.
    session: key => key.startsWith('claude:') ? discover.liveClaudeSessions(discover.claudeConfigDirs()).find(s => s.key === key) || null : null,
    ancestors: pid => procs.ancestors(pid),
    hostPid: process.pid,
    focusWindow: async () => {
      try { await vscode.commands.executeCommand('workbench.action.switchToMainWindow'); }
      catch { await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup'); }
    }
  });

  client.onState = state => { log('hub', state + (client.role ? ' (' + client.role + ')' : '')); view.setHubState(state); showBar(); };
  client.onMessage = message => { view.fromHub(message); if (message && message.type === 'workspaces') showBar(); };
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => client.update({ folders: folders() })));
  context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(() => view.sendLook()));

  /* ---------- the status bar item ---------- */

  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  bar.command = 'wyardenMonitor.open';
  context.subscriptions.push(bar);
  function showBar() {
    const f = view.figures();
    // Sessions are counted only while a monitor is open somewhere: with none open the hub is not looking,
    // and "0 live sessions" would be a guess. So the count, and the bell, are shown only when it is a count.
    bar.text = '$(pulse) 3D Monitor' + (f.counted && f.needs ? ' $(bell) ' + f.needs : '');
    bar.tooltip = view.hubState !== 'up' ? 'Wyarden 3D Monitor: the hub is ' + (view.hubState === 'blocked' ? 'blocked: another program holds its port' : 'starting')
      : 'Wyarden 3D Monitor: ' + f.windows + ' open workspace' + (f.windows === 1 ? '' : 's') +
        (f.counted ? ', ' + f.sessions + ' live session' + (f.sessions === 1 ? '' : 's') : '') + '. Click to open.';
    bar.show();
  }
  showBar();
  // The hub client starts only now. Its first state ("connecting") arrives inside start(), and what hears it
  // sets the status bar item: started before the item was made, every start-up logged a ReferenceError.
  client.start();
  context.subscriptions.push({ dispose: () => client.stop() });
  const collectorTimer = setInterval(() => { if (view.ready) void refreshCollectors(); }, 8000);
  collectorTimer.unref();
  context.subscriptions.push({ dispose: () => clearInterval(collectorTimer) });

  /* ---------- the monitor ---------- */

  const open = () => { void refreshCollectors(); return view.show(); };
  context.subscriptions.push(vscode.commands.registerCommand('wyardenMonitor.open', open));
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
    async deserializeWebviewPanel(panel) { void refreshCollectors(); view.restore(panel); }
  }));
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(LEGACY_VIEW_TYPE, {
    async deserializeWebviewPanel(panel) { panel.dispose(); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('wyardenMonitor.chooseWorkspace', async () => {
    const list = (view.workspaces && view.workspaces.list) || [], mine = [view.own(), ...folders().map(f => C.wsKey(f.path))];
    const counted = view.figures().counted;
    const items = [{ label: 'All open workspaces', scope: C.ALL }].concat(list.map(w => ({
      label: w.name, scope: w.key,
      description: [counted ? (w.sessions || 0) + ' live' + (w.needs ? ', ' + w.needs + ' waiting for you' : '') : '', mine.includes(w.key) ? 'this window' : ''].filter(Boolean).join(' · '),
      detail: [Array.isArray(w.folders) && w.folders.length > 1 ? 'Folders: ' + w.folders.join(', ') : '', (w.apps || []).join(', ')].filter(Boolean).join(' · ')
    })));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Show which workspace in the 3D monitor? One for each editor window that is open now.' });
    if (!pick) return;
    view.setScope(pick.scope);
    await open();
  }));

  /* ---------- collectors ---------- */

  const shown = new Map();      // a change's text, for the diff editor
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, { provideTextDocumentContent: uri => shown.get(uri.toString()) || '' }));
  /** Show one planned change as a diff, before anything is written. */
  async function showChange({ provider, change }, index, title, mode, reviewId) {
    const name = path.basename(change.file);
    const prefix = '/' + reviewId + '/' + index;
    const left = vscode.Uri.from({ scheme: DIFF_SCHEME, path: prefix + '/now/' + name });
    const right = vscode.Uri.from({ scheme: DIFF_SCHEME, path: prefix + '/after/' + name });
    const preview = collectors.preview(provider, change, mode, bridge);
    shown.set(left.toString(), preview.before); shown.set(right.toString(), preview.after);
    await vscode.commands.executeCommand('vscode.diff', left, right, title + ': ' + change.file, { preview: index === 0 });
  }
  async function changeCollectors(kind) {
    const plan = [], refused = [];
    for (const provider of providerIds) {
      const spec = collectors.providers[provider];
      try {
        const dirs = collectors.dirsFor(provider);
        plan.push(...collectors.plan(provider, dirs, hub, bridge, kind).map(change => ({ provider, change })));
      } catch { refused.push(spec.label + ' — the collector could not be planned.'); }
    }
    if (kind === 'add' && plan.some(({ provider, change }) => collectors.providers[provider].command && !change.error)) {
      const change = install.planBridge(bridge.dir, bridge.file);
      if (change.error) {
        refused.push(change.error);
        for (const item of plan) if (collectors.providers[item.provider].command && !item.change.error) item.blocked = true;
      } else if (change.changed) plan.push({ provider: 'bridge', change });
    }
    const todo = plan.filter(({ change, blocked }) => change.changed && !change.error && !blocked);
    for (const { provider, change } of plan) {
      if (change.error) refused.push(collectors.providers[provider].label + ' — ' + change.file + ' — ' + change.error);
    }
    if (!todo.length) {
      const message = plan.length ? 'No collector changes are needed.' : 'No supported provider profile was found. Start the provider once, then try again.';
      if (refused.length) void vscode.window.showWarningMessage('Wyarden 3D Monitor: ' + refused.join('\n'));
      else void vscode.window.showInformationMessage('Wyarden 3D Monitor: ' + message);
      void refreshCollectors();
      return;
    }
    const title = kind === 'add' ? 'Add Wyarden collectors' : 'Remove Wyarden collectors';
    shown.clear();
    const reviewId = crypto.randomBytes(8).toString('hex');
    await showChange(todo[0], 0, title, kind, reviewId);
    const n = todo.length, files = n === 1 ? '1 file' : n + ' files';
    const yes = kind === 'add' ? 'Add to ' + files : 'Remove from ' + files, all = 'Show every change';
    const selected = [...new Set(todo.map(item => item.provider).filter(provider => provider !== 'bridge'))];
    const steps = kind === 'add' ? selected.map(provider => collectors.providers[provider].restart).join('\n') :
      'Restart affected provider sessions to unload hooks that were already running.';
    const detail = 'The preview lists Wyarden entries and hides private settings and tokens.' +
      (kind === 'add' ? ' These hooks send events to 127.0.0.1. Use collectors on a single-user machine with the editor open.' : '') +
      '\n\n' + todo.map(({ provider, change }) => (collectors.providers[provider]?.label || 'Local command') + ' — ' + change.file).join('\n') +
      '\n\n' + steps + (refused.length ? '\n\nSkipped:\n' + refused.join('\n') : '');
    let answer = await vscode.window.showWarningMessage(title + '?', { modal: true, detail }, yes, ...(n > 1 ? [all] : []));
    if (answer === all) {
      for (let i = 1; i < todo.length; i++) await showChange(todo[i], i, title, kind, reviewId);
      answer = await vscode.window.showWarningMessage(title + '?', { modal: true, detail }, yes);
    }
    if (answer !== yes) return;
    const bridgeEdit = todo.find(item => item.provider === 'bridge');
    const prepared = bridgeEdit && install.apply([bridgeEdit.change])[0];
    const results = todo.map(({ provider, change }) => {
      if (provider === 'bridge') return prepared;
      if (kind === 'add' && collectors.providers[provider].command &&
          (prepared ? !prepared.written : install.planBridge(bridge.dir, bridge.file).error || !fs.existsSync(bridge.file))) {
        return { file: change.file, written: false, reason: 'the local collector command is unavailable' };
      }
      return install.apply([change])[0];
    });
    const failed = results.filter(r => !r.written);
    for (const r of failed) log('collectors', r.file + ': ' + r.reason);
    const done = results.length - failed.length;
    void vscode.window[failed.length || refused.length ? 'showWarningMessage' : 'showInformationMessage']('Wyarden 3D Monitor: ' +
      'Updated ' + done + ' of ' + results.length + ' files.' + (done && steps ? ' ' + steps.replaceAll('\n', ' ') : '') +
      (failed.length ? ' Open Status for write details.' : ''));
    await collectorProbe;
    await refreshCollectors();
  }
  let changing;
  const reviewCollectors = mode => {
    changing ??= changeCollectors(mode).catch(() => vscode.window.showErrorMessage('Wyarden 3D Monitor: collector setup or removal could not be completed.'))
      .finally(() => { changing = undefined; });
    return changing;
  };
  context.subscriptions.push(vscode.commands.registerCommand('wyardenMonitor.setupCollectors', () => reviewCollectors('add')));
  context.subscriptions.push(vscode.commands.registerCommand('wyardenMonitor.removeCollectors', () => reviewCollectors('remove')));

  /* ---------- status: the figures, for the owner ---------- */

  context.subscriptions.push(vscode.commands.registerCommand('wyardenMonitor.status', async () => {
    const states = await refreshCollectors();
    out.appendLine('');
    out.appendLine('Editor: ' + vscode.env.appName + ' ' + vscode.version + ' on ' + process.platform + (vscode.env.remoteName ? ' (remote: ' + vscode.env.remoteName + ')' : ''));
    out.appendLine('Hub: ' + view.hubState + (client.role ? ', this window is the ' + client.role : '') + ', port ' + hub.port);
    for (const provider of providerIds) {
      const c = states[provider];
      out.appendLine(collectors.providers[provider].label + ' collector: ' + c.state +
        (c.folders === undefined ? '' : ' (' + c.installed + ' of ' + c.folders + ' profiles)'));
    }
    out.appendLine('This window: ' + windowName() + ' (folders: ' + (folders().map(f => f.name).join(', ') || 'none') + ')');
    try { out.appendLine('Hub figures: ' + JSON.stringify(await client.status(), null, 2)); }
    catch (error) { out.appendLine('Hub figures: not available (' + error.message + ')'); }
    out.show(true);
  }));

  e2e(context, { view, client, open, log, bar: () => bar.tooltip });
}

/**
 * For the check that drives a real editor (test/e2e): only in a development or test host, and only
 * when WYARDEN_MONITOR_E2E names a file. It opens the tab and writes what this window sees to that
 * file, as counts and names only.
 */
function e2e(context, parts) {
  const file = process.env.WYARDEN_MONITOR_E2E;
  if (!file || context.extensionMode === vscode.ExtensionMode.Production) return;
  const seen = { started: Date.now(), editor: vscode.env.appName + ' ' + vscode.version, platform: process.platform, states: [], messages: {}, events: {}, sources: {},
    drops: 0, snapshots: 0, nodes: 0, sessions: 0, workspaces: [], scope: '', role: '', opened: '' };
  const write = () => { try { fs.writeFileSync(file, JSON.stringify(seen, null, 2)); } catch { /* the check reads what is there */ } };
  const onState = parts.client.onState, onMessage = parts.client.onMessage;
  let tried = false;
  /** Once, for the first file the scene holds: do what a double-click does, and note whether an editor opened on it. */
  const tryOpen = id => {
    if (tried) return;
    tried = true;
    parts.view.fromPage({ v: C.VERSION, type: 'act', action: 'open', target: { class: 'resource', id } });
    setTimeout(() => { const editor = vscode.window.activeTextEditor; seen.opened = editor ? 'an editor opened on a ' + (editor.document.uri.scheme) + ' document' : 'no editor opened'; write(); }, 2500);
  };
  parts.client.onState = state => { seen.states.push(state); seen.role = parts.client.role || ''; onState(state); write(); };
  parts.client.onMessage = message => {
    seen.messages[message.type] = (seen.messages[message.type] || 0) + 1;
    if (message.type === 'workspaces') {
      seen.workspaces = message.list.map(w => ({ name: w.name, sessions: w.sessions, windows: w.windows, apps: w.apps, folders: w.folders, key: w.key }));
      seen.scope = message.scope; seen.own = message.own; seen.watching = message.watching; seen.total = message.total;
    }
    if (message.type === 'records') for (const r of message.records) {
      if (r.ctl === 'snapshot') { seen.snapshots++; try { const s = JSON.parse(r.state).state; seen.nodes = s.nodes.$map.length; seen.sessions = s.sessions.$map.length; } catch { /* counted anyway */ } }
      else if (r.ctl === 'drop') seen.drops++;
      else if (r.ev) {
        seen.events[r.ev] = (seen.events[r.ev] || 0) + 1;
        const source = String(r.src || '?').split(':')[0];
        seen.sources[source] = (seen.sources[source] || 0) + 1;
        if (process.env.WYARDEN_MONITOR_E2E_OPEN && r.ev === 'resource.touch' && r.kind === 'file' && typeof r.path === 'string' && r.session) {
          const cut = r.path.lastIndexOf('/');
          tryOpen('r:' + r.agent + ':' + r.session + ':file:' + (cut < 0 ? './' : r.path.slice(0, cut + 1)));
        }
      }
    }
    onMessage(message);
    seen.bar = parts.bar();                      // the status bar's hover text, as it reads after this message
    write();
  };
  parts.log('e2e', 'writing what this window sees to the file the check named');
  // The tab opens after a pause, so the hover text from before any tab was open is on record too.
  setTimeout(() => { seen.barBeforeTab = parts.bar(); parts.open(); write(); }, Number(process.env.WYARDEN_MONITOR_E2E_WAIT) || 1500);
}

function deactivate() { /* everything is disposed through context.subscriptions */ }

module.exports = { activate, deactivate };
