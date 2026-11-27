/* Wyarden 3D monitor, working mock-up: the extension.
 *
 * In every window it does three small things:
 *   1. It tells the hub which folders this window has open, over one connection that stays open.
 *      That connection is how the hub knows the workspace is alive; when the window closes, it drops.
 *      If no hub is running, this window starts it (a worker thread; no new process).
 *   2. It offers the tab ("Wyarden 3D Monitor: Open", or the item in the status bar). A double-click on
 *      a session there reads this machine's process list once, to find that session's terminal or chat
 *      panel; on Windows that is one run of Windows PowerShell from the system folder.
 *   3. It offers set-up and removal of Claude Code's collector. Nothing is installed on activation.
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
const procs = require('./lib/procs.js');
const { MonitorView, VIEW_TYPE } = require('./lib/view.js');

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
  let collectorsNow = { claude: { state: 'missing', folders: 0, installed: 0 } };
  const refreshCollectors = () => {
    try { const s = install.status(discover.claudeConfigDirs(), hub); collectorsNow = { claude: { state: s.state, folders: s.folders, installed: s.installed } }; }
    catch (error) { log('collectors: ' + error.message); }
    return collectorsNow;
  };
  const view = new MonitorView(vscode, context, {
    client, folders, collectors: () => collectorsNow, log: message => log('view', message),
    // For a double-click on a session: its own file, then its process's ancestors, read only then.
    session: id => discover.liveClaudeSessions(discover.claudeConfigDirs()).find(s => s.session === id) || null,
    ancestors: pid => procs.ancestors(pid),
    hostPid: process.pid
  });

  client.onState = state => { log('hub', state + (client.role ? ' (' + client.role + ')' : '')); view.setHubState(state); showBar(); };
  client.onMessage = message => { view.fromHub(message); if (message && message.type === 'workspaces') showBar(); };
  client.start();
  context.subscriptions.push({ dispose: () => client.stop() });
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => client.update({ folders: folders() })));
  context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(() => view.sendLook()));

  /* ---------- the status bar item: where the tab is opened from ---------- */

  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  bar.command = 'wyardenMonitor.open';
  context.subscriptions.push(bar);
  function showBar() {
    const f = view.figures();
    // Sessions are counted only while a monitor tab is open somewhere: with none open the hub is not looking,
    // and "0 live sessions" would be a guess. So the count, and the bell, are shown only when it is a count.
    bar.text = '$(pulse) 3D Monitor' + (f.counted && f.needs ? ' $(bell) ' + f.needs : '');
    bar.tooltip = view.hubState !== 'up' ? 'Wyarden 3D Monitor: the hub is ' + (view.hubState === 'blocked' ? 'blocked: another program holds its port' : 'starting')
      : 'Wyarden 3D Monitor: ' + f.windows + ' open workspace' + (f.windows === 1 ? '' : 's') +
        (f.counted ? ', ' + f.sessions + ' live session' + (f.sessions === 1 ? '' : 's') : '') + '. Click to open.';
    bar.show();
  }
  showBar();

  /* ---------- the tab ---------- */

  const open = () => { refreshCollectors(); view.show(); };
  context.subscriptions.push(vscode.commands.registerCommand('wyardenMonitor.open', open));
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
    async deserializeWebviewPanel(panel) { refreshCollectors(); view.restore(panel); }
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
    open();
  }));

  /* ---------- collectors ---------- */

  const shown = new Map();      // a change's text, for the diff editor
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, { provideTextDocumentContent: uri => shown.get(uri.toString()) || '' }));
  /** Show one planned change as a diff, before anything is written. */
  async function showChange(change, index, title) {
    const left = vscode.Uri.from({ scheme: DIFF_SCHEME, path: '/' + index + '/now/settings.json' });
    const right = vscode.Uri.from({ scheme: DIFF_SCHEME, path: '/' + index + '/after/settings.json' });
    shown.set(left.toString(), change.before); shown.set(right.toString(), change.after);
    await vscode.commands.executeCommand('vscode.diff', left, right, title + ': ' + change.file, { preview: index === 0 });
  }
  async function changeCollectors(kind) {
    const dirs = discover.claudeConfigDirs();
    if (!dirs.length) { void vscode.window.showInformationMessage('Wyarden 3D Monitor: no Claude Code folder was found on this machine.'); return; }
    const plan = kind === 'add' ? install.plan(dirs, hub) : install.planRemoval(dirs);
    const refused = plan.filter(c => c.error), todo = plan.filter(c => c.changed && !c.error);
    for (const c of refused) log('collectors', c.error);
    if (!todo.length) {
      void vscode.window.showInformationMessage('Wyarden 3D Monitor: ' + (kind === 'add' ? 'the collector is already in every Claude Code settings file.' : 'no settings file holds the collector.') +
        (refused.length ? ' ' + refused.length + ' file(s) could not be read; see the output channel.' : ''));
      refreshCollectors(); view.sendHub();
      return;
    }
    const title = kind === 'add' ? 'Add the 3D monitor\'s collector' : 'Remove the 3D monitor\'s collector';
    shown.clear();
    await showChange(todo[0], 0, title);
    const n = todo.length, files = n === 1 ? '1 settings file' : n + ' settings files';
    const yes = kind === 'add' ? 'Add to ' + files : 'Remove from ' + files, all = 'Show every change';
    const detail = (kind === 'add'
      ? 'Each file gets ' + install.EVENTS.length + ' hook entries that post Claude Code\'s events to the monitor on this machine (127.0.0.1). Nothing else in the file changes, and "Remove Collectors" takes them out again. A session that is already running may report only after it restarts.' +
        '\n\nNot on a machine that other people log in to: while no editor is open, another program there could listen on the monitor\'s port and receive what the hooks post.'
      : 'Only the monitor\'s own entries are taken out. Nothing else in the file changes.') +
      '\n\n' + todo.map(c => c.file).join('\n') + (refused.length ? '\n\nNot changed, because it could not be read:\n' + refused.map(c => c.file).join('\n') : '');
    let answer = await vscode.window.showWarningMessage(title + ' ' + (kind === 'add' ? 'to' : 'from') + ' ' + files + '?', { modal: true, detail }, yes, ...(n > 1 ? [all] : []));
    if (answer === all) {
      for (let i = 1; i < todo.length; i++) await showChange(todo[i], i, title);
      answer = await vscode.window.showWarningMessage(title + ' ' + (kind === 'add' ? 'to' : 'from') + ' ' + files + '?', { modal: true, detail }, yes);
    }
    if (answer !== yes) return;
    const results = install.apply(todo), failed = results.filter(r => !r.written);
    for (const r of failed) log('collectors', r.file + ': ' + r.reason);
    refreshCollectors(); view.sendHub();
    const done = results.length - failed.length;
    void vscode.window[failed.length ? 'showWarningMessage' : 'showInformationMessage']('Wyarden 3D Monitor: ' +
      (kind === 'add' ? 'collector added to ' : 'collector removed from ') + done + ' of ' + results.length + ' settings file(s).' +
      (failed.length ? ' ' + failed.map(r => r.reason).join('; ') + '.' : ''));
  }
  context.subscriptions.push(vscode.commands.registerCommand('wyardenMonitor.setupCollectors', () => changeCollectors('add').catch(error => vscode.window.showErrorMessage('Wyarden 3D Monitor: ' + error.message))));
  context.subscriptions.push(vscode.commands.registerCommand('wyardenMonitor.removeCollectors', () => changeCollectors('remove').catch(error => vscode.window.showErrorMessage('Wyarden 3D Monitor: ' + error.message))));

  /* ---------- status: the figures, for the owner ---------- */

  context.subscriptions.push(vscode.commands.registerCommand('wyardenMonitor.status', async () => {
    const c = refreshCollectors().claude;
    out.appendLine('');
    out.appendLine('Editor: ' + vscode.env.appName + ' ' + vscode.version + ' on ' + process.platform + (vscode.env.remoteName ? ' (remote: ' + vscode.env.remoteName + ')' : ''));
    out.appendLine('Hub: ' + view.hubState + (client.role ? ', this window is the ' + client.role : '') + ', port ' + hub.port);
    out.appendLine('Claude Code collector: ' + c.state + ' (' + c.installed + ' of ' + c.folders + ' account folders)');
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
