// The extension host's two small parts, against a stand-in for `vscode`: the tab (its policy, its HTML and the
// messages it carries) and what a double-click does. No editor is started. Every path and name is invented.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../lib/contract.js');
const { MonitorView, VIEW_TYPE, policy, fillTemplate, validScope, SCOPE_KEY } = require('../lib/view.js');
const actions = require('../lib/actions.js');

const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

/**
 * As much of `vscode` as the two files touch. Everything it is asked to do is written to `calls`.
 *   answers.terminals  [{name, pid, fails}]: `pid` a number, or a thenable as it is; `fails` makes show() throw. Left out: no list at all.
 *   answers.commands   what getCommands answers
 *   answers.statusBar  true: there is a window.setStatusBarMessage, and what it is given goes to `status`. Left out: there is none.
 */
function fakeVscode(answers = {}) {
  const calls = [], status = [];
  const uri = value => ({ value, fsPath: value, toString: () => value });
  const panels = [];
  class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
  const main = { viewColumn: 1, tabs: [] }, floating = { viewColumn: 2, tabs: [] };
  const tabGroups = { activeTabGroup: main, all: [main, floating] };
  const vscode = {
    calls, panels, status, TabInputWebview,
    Uri: { joinPath: (base, ...parts) => uri([base.value, ...parts].join('/')), file: p => uri('file:' + p), parse: (text, strict) => uri(text) },
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    window: {
      tabGroups,
      activeColorTheme: { kind: 2 },
      createWebviewPanel(type, title, column, options) {
        const panel = {
          type, title, options, visible: true, revealed: 0, posted: [], handlers: {},
          webview: {
            cspSource: 'https://example.invalid', options: undefined, html: '',
            asWebviewUri: u => uri('https://example.invalid/' + u.value + '/'),
            postMessage: message => { panel.posted.push(message); return Promise.resolve(true); },
            onDidReceiveMessage: fn => { panel.handlers.message = fn; }
          },
          reveal() { panel.revealed++; }, dispose() { panel.handlers.dispose(); },
          onDidChangeViewState: fn => { panel.handlers.state = fn; },
          onDidDispose: fn => { panel.handlers.dispose = fn; }
        };
        panels.push(panel);
        main.activeTab = { input: new TabInputWebview(type) };
        main.tabs = [main.activeTab];
        tabGroups.activeTabGroup = main;
        return panel;
      },
      showTextDocument: async (u, options) => { calls.push(['showTextDocument', u.value, options]); },
      showQuickPick: async (items, options) => { calls.push(['showQuickPick', items.map(i => (typeof i === 'string' ? i : i.label))]); return answers.pick ? answers.pick(items) : undefined; },
      showWarningMessage: async (text, options, ...buttons) => { calls.push(['showWarningMessage', text, options && options.detail, buttons]); return answers.confirm; },
      showInformationMessage: async text => { calls.push(['showInformationMessage', text]); },
      terminals: answers.terminals && answers.terminals.map(spec => ({
        name: spec.name,
        processId: typeof spec.pid === 'number' ? Promise.resolve(spec.pid) : spec.pid,
        show: (...args) => { calls.push(['terminal.show', spec.name, ...args]); if (spec.fails) throw new Error('invented'); }
      }))
    },
    commands: {
      executeCommand: async (name, ...args) => {
        if (name === 'workbench.action.moveEditorToNewWindow') {
          floating.tabs = main.tabs; floating.activeTab = main.activeTab;
          main.tabs = []; main.activeTab = undefined; tabGroups.activeTabGroup = floating;
        } else calls.push(['executeCommand', name, typeof args[0] === 'string' ? args[0] : args[0] && args[0].value]);
      },
      getCommands: async filter => { calls.push(['getCommands', filter]); return answers.commands || []; }
    },
    env: { openExternal: async u => { calls.push(['openExternal', u.value]); return true; } }
  };
  if (answers.statusBar) vscode.window.setStatusBarMessage = (text, hide) => { status.push({ text, hide }); return { dispose() {} }; };
  return vscode;
}
function fakeContext(t, saved = {}) {
  const dir = temp(t);
  fs.mkdirSync(path.join(dir, 'media'));
  fs.writeFileSync(path.join(dir, 'media', 'page.html'),
    '<meta http-equiv="Content-Security-Policy" content="{{csp}}"><link rel="stylesheet" href="{{base}}/style.css"><script nonce="{{nonce}}" src="{{base}}/a.js"></script><script nonce="{{nonce}}" src="{{base}}/b.js"></script>');
  const state = new Map(Object.entries(saved));
  return { extensionPath: dir, extensionUri: { value: 'ext' }, workspaceState: { get: key => state.get(key), update: async (key, value) => { state.set(key, value); } }, state };
}
function fakeClient() {
  const client = { role: 'hub', updates: [], update(change) { client.updates.push(change); }, resolve: async target => client.answer(target), answer: () => ({ kind: 'none' }) };
  return client;
}
function makeView(t, { folders = [{ path: '/home/example/proj', name: 'proj' }], saved, answers, deps } = {}) {
  const vscode = fakeVscode(answers), context = fakeContext(t, saved), client = fakeClient(), logs = [];
  const collectors = { claude: { state: 'missing', folders: 2, installed: 0 } };
  const view = new MonitorView(vscode, context, { client, folders: () => folders, collectors: () => collectors, log: m => logs.push(m), ...deps });
  return { vscode, context, client, view, logs, collectors };
}
const say = (panel, message) => panel.handlers.message(message);

test('the policy allows what carries the page\'s nonce, and nothing else: no host, no wildcard', () => {
  const text = policy('abc123');
  assert.equal(text, "default-src 'none'; script-src 'nonce-abc123'; style-src 'nonce-abc123'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'");
  for (const word of ['unsafe-inline', 'unsafe-eval', 'wasm', 'http', '*', 'self']) assert.ok(!text.includes(word), word);
});

test('the template\'s three placeholders are filled everywhere', () => {
  const html = fillTemplate('{{csp}}|{{nonce}}|{{base}}/a|{{nonce}}|{{base}}/b', { csp: 'P', nonce: 'N', base: 'B' });
  assert.equal(html, 'P|N|B/a|N|B/b');
});

test('a scope is "all" or a workspace key, nothing else', () => {
  assert.equal(validScope('all'), true);
  assert.equal(validScope('0123456789ab'), true);
  for (const bad of ['ALL', '0123456789a', '0123456789abc', '0123456789aZ', '', null, 5, {}, '../../x']) assert.equal(validScope(bad), false, String(bad));
});

test('open moves only the monitor to a floating group and keeps its webview policy', async t => {
  const { vscode, view } = makeView(t);
  await view.show();
  const panel = vscode.panels[0];
  assert.equal(panel.type, 'wyardenMonitor.window');
  const [main, floating] = vscode.window.tabGroups.all;
  assert.deepEqual(main.tabs, []);
  assert.equal(floating.activeTab.input.viewType, panel.type);
  assert.deepEqual(panel.options.localResourceRoots.map(u => u.value), ['ext/media']);
  assert.equal(panel.options.enableScripts, true);
  assert.equal(panel.options.retainContextWhenHidden, false);
  assert.ok(!panel.webview.html.includes('{{'), 'every placeholder is filled');
  const nonces = [...panel.webview.html.matchAll(/nonce="([^"]+)"/g)].map(m => m[1]);
  assert.equal(nonces.length, 2);
  assert.equal(new Set(nonces).size, 1);
  assert.ok(nonces[0].length >= 20);
  assert.ok(panel.webview.html.includes("'nonce-" + nonces[0] + "'"), 'the policy names the same nonce');
  assert.ok(panel.webview.html.includes('href="https://example.invalid/ext/media/style.css"'), 'no doubled slash in the base');
  view.show();
  assert.equal(vscode.panels.length, 1, 'a second Open shows the same tab');
  assert.equal(panel.revealed, 1);
});

test('a restored monitor becomes the live one, and a late duplicate closes', async t => {
  const restored = vscode => { const panel = vscode.window.createWebviewPanel(VIEW_TYPE, '3D Monitor', -1, {}); panel.disposed = 0; panel.dispose = () => { panel.disposed++; }; return panel; };
  let made = makeView(t);
  const first = restored(made.vscode);
  made.view.restore(first);
  assert.equal(made.view.panel, first, 'with no tab open, the restored one is taken');
  assert.ok(first.webview.html.includes('nonce'), 'and gets the page');
  assert.equal(first.disposed, 0);

  made = makeView(t);
  await made.view.show();
  const live = made.vscode.panels[0], late = restored(made.vscode);
  made.view.restore(late);
  assert.equal(late.disposed, 1, 'a second tab would have no feed, so the restored one is closed');
  assert.equal(made.view.panel, live, 'the live tab stays the live tab');
  assert.equal(live.revealed, 1, 'and is shown');
  assert.equal(late.webview.html, '', 'the closed one was given no page');
});

test('nothing is sent to a page that has not said it is ready', t => {
  const { vscode, view, client } = makeView(t);
  view.show();
  const panel = vscode.panels[0];
  view.fromHub({ type: 'records', scope: 'all', records: [{ ctl: 'snapshot' }] });
  view.setHubState('up');
  assert.deepEqual(panel.posted, []);
  assert.deepEqual(client.updates, [], 'and the hub is asked for nothing');
});

test('ready: the page gets the look, hub state, workspaces and a snapshot of all open workspaces', t => {
  const { vscode, view, client } = makeView(t);
  view.setHubState('up');
  view.fromHub({ type: 'workspaces', list: [{ key: 'aaaaaaaaaaaa', name: 'proj', apps: ['Example Editor'], windows: 1, sessions: 2, needs: 0 }], hidden: 1, scope: 'all' });
  view.show();
  const panel = vscode.panels[0];
  say(panel, { v: 1, type: 'ready' });
  assert.deepEqual(panel.posted.map(m => m.type), ['look', 'hub', 'workspaces']);
  assert.ok(panel.posted.every(m => m.v === 1));
  assert.equal(panel.posted[0].look, 'nexus');
  assert.deepEqual(panel.posted[1], { v: 1, type: 'hub', state: 'up', role: 'hub', collectors: { claude: { state: 'missing', folders: 2, installed: 0 } } });
  assert.deepEqual(panel.posted[2].here, [C.wsKey('/home/example/proj')]);
  assert.equal(panel.posted[2].hidden, 1);
  assert.deepEqual(client.updates, [{ scope: 'all', snapshot: true }]);
  view.fromHub({ type: 'records', scope: 'all', records: [{ ev: 'tool.start' }] });
  assert.deepEqual(panel.posted[3], { v: 1, type: 'records', scope: 'all', records: [{ ev: 'tool.start' }] });
});

test('the scope is the saved choice, or all open workspaces', t => {
  assert.equal(makeView(t, { saved: { [SCOPE_KEY]: 'bbbbbbbbbbbb' } }).view.wanted(), 'bbbbbbbbbbbb');
  assert.equal(makeView(t, { saved: { [SCOPE_KEY]: 'not a key' } }).view.wanted(), 'all', 'a saved value of the wrong shape is ignored');
  assert.equal(makeView(t, { folders: [] }).view.wanted(), 'all');
  // A window with several folders is one workspace: its key is the window's, not its first folder's.
  const two = [{ path: '/home/example/proj', name: 'proj' }, { path: '/home/example/tools', name: 'tools' }];
  const view = makeView(t, { folders: two }).view;
  assert.equal(view.wanted(), 'all');
  assert.equal(view.own(), C.windowKey(two.map(f => f.path)));
  assert.notEqual(view.own(), C.wsKey('/home/example/proj'));
  assert.equal(makeView(t, { folders: [] }).view.own(), '');
});

test('the workspaces message for the page: this window\'s own keys, and a newer hub\'s fields only when they are of the right kind', t => {
  const two = [{ path: '/home/example/proj', name: 'proj' }, { path: '/home/example/tools', name: 'tools' }];
  const own = C.windowKey(two.map(f => f.path));
  const { vscode, view } = makeView(t, { folders: two });
  view.setHubState('up');
  view.show();
  const panel = vscode.panels[0];
  say(panel, { v: 1, type: 'ready' });
  const last = () => panel.posted.filter(m => m.type === 'workspaces').pop();
  const list = [{ key: own, name: 'Example Shop', apps: ['Example Editor'], windows: 1, sessions: 2, needs: 1, folders: ['proj', 'tools'] }];
  // A hub of 0.1.1.
  view.fromHub({ type: 'workspaces', list, hidden: 0, scope: own, total: 2, totalNeeds: 1, watching: true, own });
  assert.deepEqual(last(), { v: 1, type: 'workspaces', list, hidden: 0, scope: own, here: [own, C.wsKey('/home/example/proj'), C.wsKey('/home/example/tools')], total: 2, totalNeeds: 1, watching: true, own });
  // A hub of 0.1.0 sends none of the new fields: none is invented.
  view.fromHub({ type: 'workspaces', list: [], hidden: 0, scope: 'all' });
  assert.deepEqual(Object.keys(last()).sort(), ['here', 'hidden', 'list', 'scope', 'type', 'v']);
  // Fields of the wrong kind are left out, not passed on.
  view.fromHub({ type: 'workspaces', list: [], hidden: 0, scope: 'all', total: 'many', totalNeeds: null, watching: 'yes', own: '../x' });
  assert.deepEqual(Object.keys(last()).sort(), ['here', 'hidden', 'list', 'scope', 'type', 'v']);
});

test('the status bar\'s figures: a count is given only while the hub is looking', t => {
  const { vscode, view } = makeView(t);
  assert.deepEqual(view.figures(), { windows: 0, sessions: 0, needs: 0, counted: false }, 'nothing is known before the hub has spoken');
  const list = [{ key: 'aaaaaaaaaaaa', name: 'a', apps: [], windows: 1, sessions: 2, needs: 1 }, { key: 'bbbbbbbbbbbb', name: 'b', apps: [], windows: 1, sessions: 1, needs: 0 }];
  // A hub of 0.1.1 says whether it is looking.
  view.fromHub({ type: 'workspaces', list, hidden: 0, scope: null, total: 0, totalNeeds: 0, watching: false });
  assert.deepEqual(view.figures(), { windows: 2, sessions: 0, needs: 0, counted: false }, 'not looking: two windows, and no count to show');
  view.fromHub({ type: 'workspaces', list, hidden: 0, scope: 'all', total: 2, totalNeeds: 1, watching: true });
  assert.deepEqual(view.figures(), { windows: 2, sessions: 2, needs: 1, counted: true }, 'a session two windows share is counted once');
  // A hub of 0.1.0 does not say: its sum counts only while this window's own tab is open.
  view.fromHub({ type: 'workspaces', list, hidden: 0, scope: null });
  assert.equal(view.figures().counted, false);
  assert.equal(view.figures().sessions, 3);
  view.show();
  say(vscode.panels[0], { v: 1, type: 'ready' });
  assert.equal(view.figures().counted, true);
});

test('a chip: a valid scope is remembered and asked for; anything else is ignored', t => {
  const { vscode, view, client, context } = makeView(t);
  view.show();
  const panel = vscode.panels[0];
  say(panel, { v: 1, type: 'ready' });
  client.updates.length = 0;
  say(panel, { v: 1, type: 'scope', scope: 'cccccccccccc' });
  assert.deepEqual(client.updates, [{ scope: 'cccccccccccc' }]);
  assert.equal(context.state.get(SCOPE_KEY), 'cccccccccccc');
  for (const bad of [{ v: 1, type: 'scope', scope: '../x' }, { v: 2, type: 'scope', scope: 'all' }, { type: 'scope', scope: 'all' }, null, 'scope', { v: 1, type: 'nonsense' }]) say(panel, bad);
  assert.deepEqual(client.updates, [{ scope: 'cccccccccccc' }], 'nothing more was asked');
});

test('a hidden or closed monitor pauses its feed, and a page that loads again asks afresh', async t => {
  const { vscode, view, client } = makeView(t);
  await view.show();
  const panel = vscode.panels[0];
  say(panel, { v: 1, type: 'ready' });
  client.updates.length = 0;
  panel.visible = false; panel.handlers.state();
  assert.deepEqual(client.updates, [{ scope: null }]);
  view.fromHub({ type: 'records', scope: 'all', records: [] });
  assert.equal(panel.posted.filter(m => m.type === 'records').length, 0, 'no record goes to a page that is not there');
  panel.visible = true;
  say(panel, { v: 1, type: 'ready' });
  assert.deepEqual(client.updates[1], { scope: 'all', snapshot: true });
  panel.handlers.dispose();
  assert.deepEqual(client.updates[2], { scope: null });
  await view.show();
  assert.equal(vscode.panels.length, 2, 'after it was closed, Open makes a new window');
});

test('a hub that went away takes its workspace list with it; one that came back is asked again', t => {
  const { vscode, view, client } = makeView(t);
  view.setHubState('up');
  view.fromHub({ type: 'workspaces', list: [], hidden: 0, scope: 'all' });
  view.show();
  const panel = vscode.panels[0];
  say(panel, { v: 1, type: 'ready' });
  client.updates.length = 0; panel.posted.length = 0;
  view.setHubState('connecting');
  assert.equal(view.workspaces, undefined);
  assert.deepEqual(panel.posted.map(m => [m.type, m.state]), [['hub', 'connecting']]);
  view.setHubState('up');
  assert.deepEqual(client.updates, [{ scope: 'all', snapshot: true }]);
  view.setHubState('nonsense');
  assert.equal(view.hubState, 'connecting', 'an unknown state reads as connecting');
});

test('the look follows the theme kind', t => {
  const { vscode, view } = makeView(t);
  view.show();
  const panel = vscode.panels[0];
  say(panel, { v: 1, type: 'ready' });
  for (const [kind, look] of [[1, 'glasshouse'], [4, 'glasshouse'], [2, 'nexus'], [3, 'nexus']]) {
    vscode.window.activeColorTheme.kind = kind; panel.posted.length = 0; view.sendLook();
    assert.equal(panel.posted[0].look, look);
  }
});

test('a request to act must have the right shape', () => {
  const ok = { action: 'open', target: { class: 'resource', id: 'r:claude:s1:file:src/' } };
  assert.deepEqual(actions.checkAct(ok), { action: 'open', target: { class: 'resource', id: 'r:claude:s1:file:src/' }, member: undefined });
  assert.equal(actions.checkAct({ ...ok, member: 'a.js', extra: 'ignored', target: { ...ok.target, path: 'C:\\x' } }).member, 'a.js');
  assert.equal(Object.keys(actions.checkAct({ ...ok, target: { ...ok.target, path: 'C:\\x' } }).target).join(), 'class,id', 'a page cannot hand over a path');
  const show = { action: 'focus', target: { class: 'agent', id: 'a:claude:s1' } };
  assert.deepEqual(actions.checkAct(show), { action: 'focus', target: { class: 'agent', id: 'a:claude:s1' }, member: undefined }, 'showing a session is an action');
  for (const word of ['Focus', 'show', 'resume', 'start', 'focus ']) assert.equal(actions.checkAct({ ...show, action: word }), null, word);
  for (const bad of [null, {}, { action: 'delete', target: ok.target }, { action: 'open' }, { action: 'open', target: { class: 'window', id: 'x' } },
    { action: 'open', target: { class: 'resource', id: '' } }, { action: 'open', target: { class: 'resource', id: 5 } }, { action: 'open', target: { class: 'resource', id: 'x'.repeat(2000) } }])
    assert.equal(actions.checkAct(bad), null, JSON.stringify(bad));
});

test('open: one file opens in the editor; a file that is not on disk does not', async t => {
  const dir = temp(t), file = path.join(dir, 'a.js');
  fs.writeFileSync(file, '// invented\n');
  const request = { action: 'open', target: { class: 'resource', id: 'r:claude:s1:file:./' } };
  let vscode = fakeVscode();
  const deps = answer => ({ resolve: async () => answer, folders: () => [dir] });
  assert.equal(await actions.open(vscode, deps({ kind: 'file', folder: './', members: [{ name: 'a.js', path: file }] }), request), 'opened');
  assert.deepEqual(vscode.calls, [['showTextDocument', 'file:' + file, { preview: true, viewColumn: -2 }]]);
  vscode = fakeVscode();
  assert.equal(await actions.open(vscode, deps({ kind: 'file', members: [{ name: 'gone.js', path: path.join(dir, 'gone.js') }] }), request), 'missing');
  assert.equal(vscode.calls.filter(c => c[0] === 'showTextDocument').length, 0);
  vscode = fakeVscode();
  assert.equal(await actions.open(vscode, deps({ kind: 'file', members: [{ name: 'a.js', path: 'relative/a.js' }] }), request), 'empty', 'a path that is not absolute is not a path');
  vscode = fakeVscode();
  assert.equal(await actions.open(vscode, deps({ kind: 'file', members: [{ name: 'a.js', path: file }] }), { action: 'open', target: { class: 'agent', id: 'a:claude:s1' } }), 'nothing', 'only a resource opens');
  assert.deepEqual(vscode.calls, []);
});

test('open: a folder group of several files asks which one', async t => {
  const dir = temp(t), a = path.join(dir, 'a.js'), b = path.join(dir, 'b.js');
  fs.writeFileSync(a, ''); fs.writeFileSync(b, '');
  const request = { action: 'open', target: { class: 'resource', id: 'r:claude:s1:file:src/' } };
  const answer = { kind: 'file', folder: 'src/', members: [{ name: 'a.js', path: a }, { name: 'b.js', path: b }] };
  let vscode = fakeVscode({ pick: items => items[1] });
  assert.equal(await actions.open(vscode, { resolve: async () => answer, folders: () => [] }, request), 'opened');
  assert.deepEqual(vscode.calls, [['showQuickPick', ['a.js', 'b.js']], ['showTextDocument', 'file:' + b, { preview: true, viewColumn: -2 }]]);
  vscode = fakeVscode();
  assert.equal(await actions.open(vscode, { resolve: async () => answer, folders: () => [] }, request), 'cancelled');
  assert.equal(vscode.calls.length, 1, 'no file opens when the list is dismissed');
});

test('open: a searched folder is revealed, in the Explorer when it is in this window', async () => {
  const request = { action: 'open', target: { class: 'resource', id: 'r:claude:s1:file:src/' } };
  const answer = { kind: 'dir', path: '/home/example/proj/src' };
  let vscode = fakeVscode();
  await actions.open(vscode, { resolve: async () => answer, folders: () => ['/home/example/proj'] }, request);
  assert.deepEqual(vscode.calls, [['executeCommand', 'revealInExplorer', 'file:/home/example/proj/src']]);
  vscode = fakeVscode();
  await actions.open(vscode, { resolve: async () => answer, folders: () => ['/home/example/other'] }, request);
  assert.deepEqual(vscode.calls, [['executeCommand', 'revealFileInOS', 'file:/home/example/proj/src']]);
});

test('open: an address opens only after it was shown and confirmed, and only a clean http(s) one', async () => {
  const request = { action: 'open', target: { class: 'resource', id: 'r:claude:s1:url:example.com' } };
  const answer = { kind: 'url', urls: ['https://example.com/docs/page'] };
  let vscode = fakeVscode({ confirm: 'Open' });
  assert.equal(await actions.open(vscode, { resolve: async () => answer, folders: () => [] }, request), 'opened');
  assert.equal(vscode.calls[0][0], 'showWarningMessage');
  assert.equal(vscode.calls[0][2], 'https://example.com/docs/page', 'the address is shown in full before it is opened');
  assert.deepEqual(vscode.calls[1], ['openExternal', 'https://example.com/docs/page']);
  vscode = fakeVscode({ confirm: undefined });
  assert.equal(await actions.open(vscode, { resolve: async () => answer, folders: () => [] }, request), 'cancelled');
  assert.equal(vscode.calls.filter(c => c[0] === 'openExternal').length, 0);
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'https://example.com/a?token=1', 'https://user:pw@example.com/a']) {
    vscode = fakeVscode({ confirm: 'Open' });
    assert.equal(await actions.open(vscode, { resolve: async () => ({ kind: 'url', urls: [bad] }), folders: () => [] }, request), 'empty', bad);
    assert.deepEqual(vscode.calls, []);
  }
});

test('open: no answer, a file outside the root, and an unknown node each say so and open nothing', async () => {
  const request = { action: 'open', target: { class: 'resource', id: 'r:claude:s1:file:(outside the workspace)' } };
  for (const [answer, result] of [[{ kind: 'outside' }, 'outside'], [{ kind: 'none' }, 'nothing'], [null, 'no-answer'], [{ kind: 'dir', path: 'relative' }, 'nothing']]) {
    const vscode = fakeVscode();
    assert.equal(await actions.open(vscode, { resolve: async () => answer, folders: () => [] }, request), result);
    assert.equal(vscode.calls.filter(c => ['showTextDocument', 'openExternal', 'executeCommand'].includes(c[0])).length, 0);
  }
  const vscode = fakeVscode();
  assert.equal(await actions.open(vscode, { resolve: async () => { throw new Error('refused'); }, folders: () => [] }, request), 'no-answer');
});

test('the view passes a double-click on to the action, with this window\'s folders', async t => {
  const dir = temp(t), file = path.join(dir, 'a.js');
  fs.writeFileSync(file, '');
  const { vscode, view, client } = makeView(t, { folders: [{ path: dir, name: 'proj' }] });
  client.answer = target => { client.asked = target; return { kind: 'file', members: [{ name: 'a.js', path: file }] }; };
  view.show();
  const panel = vscode.panels[0];
  say(panel, { v: 1, type: 'ready' });
  say(panel, { v: 1, type: 'act', action: 'open', target: { class: 'resource', id: 'r:claude:s1:file:./' }, member: 'a.js' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(client.asked, { id: 'r:claude:s1:file:./', member: 'a.js' });
  assert.deepEqual(vscode.calls, [['showTextDocument', 'file:' + file, { preview: true, viewColumn: 1 }]]);
  say(panel, { v: 1, type: 'act', action: 'erase', target: { class: 'resource', id: 'x' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vscode.calls.length, 1, 'an action that is not on the list does nothing');
});

/* ---------- focus: show a session's terminal or chat panel ---------- */

// The messages, as the contract gives them. Written out here, not taken from the code, so a change to one is seen.
const SAY = {
  noAnswer: '3D Monitor: the hub did not answer.',
  gone: '3D Monitor: this session is no longer live.',
  noProcess: '3D Monitor: no running process is known for this session, so its terminal or chat panel cannot be found.',
  unknown: '3D Monitor: the process list could not be read, so this session\'s terminal or chat panel cannot be found.',
  stale: '3D Monitor: this session has ended. Another program now runs under its process id.',
  panelElsewhere: '3D Monitor: this session\'s chat panel is in another window.',
  unconfirmed: '3D Monitor: this session\'s own process could not be confirmed, so its chat panel was not opened.',
  noPanelCommand: '3D Monitor: this session runs in Claude Code\'s chat panel, but Claude Code\'s command to show it is not available in this window.',
  headless: '3D Monitor: this session runs in the background. It has no terminal or chat panel to show.',
  unshown: '3D Monitor: this session runs in this window, but not in a terminal or chat panel that can be shown from here.',
  elsewhere: '3D Monitor: this session\'s terminal is not in this window. It runs in another window, or outside the editor.'
};
const PANEL = 'claude-vscode.editor.open';
const SID = '00000000-0000-4000-8000-00000000f0c5';
// Invented process ids: the session's process, its parent (a shell), this window's extension host, the system's first process.
const PID = 4300, SHELL = 4200, HOST = 4100;
// FILETIME-sized start times: 18 digits, past what a Number holds exactly.
const START = '133774000000000000';
const AGENT = { action: 'focus', target: { class: 'agent', id: 'a:claude:' + SID }, member: undefined };
const info = key => ['showInformationMessage', SAY[key]];
const warn = key => ['showWarningMessage', SAY[key], undefined, []];

/**
 * Every answer the way a chat panel session of this window gives it: what reaches the one command.
 * `over` replaces one answer. The hub's pid (9999) is not the file's, so a test sees which one is used.
 */
function focusDeps(over = {}) {
  const asked = { resolve: [], session: [], ancestors: [] };
  const deps = {
    asked,
    resolve: async target => { asked.resolve.push(target); return 'answer' in over ? over.answer : { kind: 'session', agent: 'claude', session: SID, cwd: '/home/example/proj', root: '/home/example/proj', pid: 9999 }; },
    session: async id => { asked.session.push(id); return 'entry' in over ? over.entry : { session: SID, pid: PID, entry: 'claude-vscode', procStart: START }; },
    ancestors: async pid => { asked.ancestors.push(pid); return 'tree' in over ? over.tree : { chain: [PID, SHELL, HOST, 1], known: true, start: START, unit: 'filetime' }; },
    hostPid: 'hostPid' in over ? over.hostPid : HOST
  };
  for (const name of ['resolve', 'session', 'ancestors']) if (typeof over[name] === 'function') deps[name] = over[name];
  return deps;
}
const entry = extra => ({ session: SID, pid: PID, entry: 'claude-vscode', procStart: START, ...extra });
const tree = extra => ({ chain: [PID, SHELL, HOST, 1], known: true, start: START, unit: 'filetime', ...extra });
/** One focus, against a window with no terminal and Claude Code's command present unless `answers` says otherwise. */
async function runFocus({ answers = {}, request = AGENT, ...over } = {}) {
  const vscode = fakeVscode({ terminals: [], commands: ['example.other', PANEL], ...answers });
  const deps = focusDeps(over);
  const outcome = await actions.focus(vscode, deps, request);
  return { outcome, calls: vscode.calls, deps, ran: vscode.calls.filter(c => c[0] === 'executeCommand' || c[0] === 'terminal.show') };
}

test('focus: the chat panel command is exported under its own name', () => {
  assert.equal(actions.PANEL_COMMAND, PANEL);
});

test('focus: each step of the table, in order, with its outcome, its one message and what it runs', async () => {
  const flat = x => (typeof x === 'object' ? JSON.stringify(x) : String(x));
  const rows = [
    // [what, options, outcome, every call vscode saw]
    ['1: a node that is not an agent', { request: { ...AGENT, target: { class: 'subagent', id: 'g:claude:' + SID + ':x' } } }, 'nothing', []],
    ['1: a resource', { request: { ...AGENT, target: { class: 'resource', id: 'r:claude:' + SID + ':file:./' } } }, 'nothing', []],
    ['2: the hub throws', { resolve: async () => { throw new Error('invented'); } }, 'no-answer', [warn('noAnswer')]],
    ['2: the hub throws at once', { resolve: () => { throw new Error('invented'); } }, 'no-answer', [warn('noAnswer')]],
    ['2: no answer', { answer: null }, 'no-answer', [warn('noAnswer')]],
    ['2: an answer that is not an object', { answer: 'session' }, 'no-answer', [warn('noAnswer')]],
    ['3: not a session', { answer: { kind: 'none' } }, 'gone', [info('gone')]],
    ['3: a file group', { answer: { kind: 'file', session: SID } }, 'gone', [info('gone')]],
    ['3: an id that would climb out of a folder', { answer: { kind: 'session', session: '../x' } }, 'gone', [info('gone')]],
    ['3: an id that is a number', { answer: { kind: 'session', session: 5 } }, 'gone', [info('gone')]],
    ['3: an id too long', { answer: { kind: 'session', session: 'x'.repeat(129) } }, 'gone', [info('gone')]],
    ['3: no id', { answer: { kind: 'session' } }, 'gone', [info('gone')]],
    ['4: no session file', { entry: null }, 'no-process', [info('noProcess')]],
    ['4: the lookup throws', { session: () => { throw new Error('invented'); } }, 'no-process', [info('noProcess')]],
    ['4: the lookup rejects', { session: async () => { throw new Error('invented'); } }, 'no-process', [info('noProcess')]],
    ['4: a pid that is a string', { entry: entry({ pid: String(PID) }) }, 'no-process', [info('noProcess')]],
    ['4: a pid of 0', { entry: entry({ pid: 0 }) }, 'no-process', [info('noProcess')]],
    ['4: a pid of -1', { entry: entry({ pid: -1 }) }, 'no-process', [info('noProcess')]],
    ['4: a pid that is not whole', { entry: entry({ pid: 4300.5 }) }, 'no-process', [info('noProcess')]],
    ['4: no pid', { entry: entry({ pid: undefined }) }, 'no-process', [info('noProcess')]],
    ['5: the process list throws', { ancestors: () => { throw new Error('invented'); } }, 'unknown', [info('unknown')]],
    ['5: the process list rejects', { ancestors: async () => { throw new Error('invented'); } }, 'unknown', [info('unknown')]],
    ['5: not known', { tree: tree({ known: false }) }, 'unknown', [info('unknown')]],
    ['5: "known" that is not true', { tree: tree({ known: 'true' }) }, 'unknown', [info('unknown')]],
    ['5: a chain that is not a list', { tree: tree({ chain: '4300 4100' }) }, 'unknown', [info('unknown')]],
    ['5: nothing', { tree: null }, 'unknown', [info('unknown')]],
    ['6: another program under the pid', { tree: tree({ start: '133774000000010000' }) }, 'stale', [info('stale')]],
    ['7: its shell is a terminal here', { answers: { terminals: [{ name: 'example shell', pid: SHELL }] } }, 'terminal', [['terminal.show', 'example shell']]],
    ['8a: a chat panel of another window', { tree: tree({ chain: [PID, 7000, 1] }) }, 'elsewhere', [info('panelElsewhere')]],
    ['8b: its own process not confirmed', { tree: tree({ start: undefined, unit: undefined }) }, 'unconfirmed', [info('unconfirmed')]],
    ['8b: not confirmed, and no command either', { tree: tree({ start: undefined, unit: undefined }), answers: { commands: [] } }, 'unconfirmed', [info('unconfirmed')]],
    ['8c: no command to show a chat panel', { answers: { commands: ['example.other'] } }, 'no-panel-command', [['getCommands', true], info('noPanelCommand')]],
    ['8d: a chat panel of this window', {}, 'panel', [['getCommands', true], ['executeCommand', PANEL, SID]]],
    ['9: no terminal at all', { entry: entry({ entry: 'sdk-cli' }) }, 'headless', [info('headless')]],
    ['10: under this window, not in a terminal', { entry: entry({ entry: 'cli' }) }, 'unshown', [info('unshown')]],
    ['11: a terminal elsewhere', { entry: entry({ entry: 'cli' }), tree: tree({ chain: [PID, 7000, 1] }) }, 'elsewhere', [info('elsewhere')]]
  ];
  for (const [what, options, outcome, calls] of rows) {
    const got = await runFocus(options);
    assert.equal(got.outcome, outcome, what);
    assert.deepEqual(got.calls, calls, what + ': ' + got.calls.map(flat).join(' | '));
  }
});

test('focus: the hub is asked about the node; the file is read for the hub\'s session; the file\'s pid is the one walked', async () => {
  const { deps, ran } = await runFocus();
  assert.deepEqual(deps.asked.resolve, [{ id: 'a:claude:' + SID }], 'only the node\'s id goes to the hub');
  assert.deepEqual(deps.asked.session, [SID]);
  assert.deepEqual(deps.asked.ancestors, [PID], 'the session file\'s pid, not the hub\'s');
  assert.deepEqual(ran, [['executeCommand', PANEL, SID]], 'the command gets the session id the hub named');
  const none = await runFocus({ request: { ...AGENT, target: { class: 'tool', id: 't:claude:' + SID + ':x' } } });
  assert.deepEqual(none.deps.asked, { resolve: [], session: [], ancestors: [] }, 'a node that is not an agent asks nothing');
});

test('focus: the chat panel command runs only when all four hold: chat panel, under this host, the same process proved, the command there', async () => {
  // All four hold: the one command runs, once.
  let got = await runFocus();
  assert.equal(got.outcome, 'panel');
  assert.deepEqual(got.ran, [['executeCommand', PANEL, SID]]);
  // Each condition false on its own, from the same answers. Claude Code's command is present each time but the last,
  // so only the condition stops it.
  const alone = [
    ['the file says a terminal', { entry: entry({ entry: 'cli' }) }, 'unshown'],
    ['the file says nothing of where it runs', { entry: entry({ entry: undefined }) }, 'unshown'],
    ['the file says no terminal', { entry: entry({ entry: 'sdk-cli' }) }, 'headless'],
    ['this host is not in the chain', { tree: tree({ chain: [PID, SHELL, 7000, 1] }) }, 'elsewhere'],
    ['this host\'s pid is not known', { hostPid: undefined }, 'elsewhere'],
    ['the start times are 1 ms apart', { tree: tree({ start: '133774000000010000' }) }, 'stale'],
    ['the start times are 1 ms apart, the other way', { tree: tree({ start: '133773999999990000' }) }, 'stale'],
    ['no start time in the file', { entry: entry({ procStart: undefined }) }, 'unconfirmed'],
    ['no start time from the system', { tree: tree({ start: undefined, unit: undefined }) }, 'unconfirmed'],
    ['tick counts that differ', { entry: entry({ procStart: '8000' }), tree: tree({ start: '8001', unit: 'ticks' }) }, 'unconfirmed'],
    // The reviewer's probe: a leftover file that names this host's own pid, and no start time.
    ['a file naming this host\'s pid, with no start time', { entry: { pid: HOST, entry: 'claude-vscode' }, tree: tree({ chain: [HOST, 1], start: START }) }, 'unconfirmed'],
    ['Claude Code\'s command is not there', { answers: { commands: ['example.other'] } }, 'no-panel-command']
  ];
  for (const [what, options, outcome] of alone) {
    got = await runFocus(options);
    assert.equal(got.outcome, outcome, what);
    assert.deepEqual(got.calls.filter(c => c[0] === 'executeCommand'), [], what + ': no command ran');
  }
});

test('focus: the steps keep their order where two would fit', async () => {
  const shell = { terminals: [{ name: 'example shell', pid: SHELL }] };
  let got = await runFocus({ answers: shell, tree: tree({ start: '133774000000010000' }) });
  assert.equal(got.outcome, 'stale', 'a stale process is not shown, even with a terminal on its pid');
  assert.deepEqual(got.ran, []);
  got = await runFocus({ answers: shell });
  assert.equal(got.outcome, 'terminal', 'a terminal wins over the chat panel');
  assert.deepEqual(got.ran, [['terminal.show', 'example shell']]);
  got = await runFocus({ answers: { commands: [] }, tree: tree({ chain: [PID, 7000, 1] }) });
  assert.equal(got.outcome, 'elsewhere', 'a chat panel of another window: the command list is not even read');
  assert.deepEqual(got.calls, [info('panelElsewhere')]);
  got = await runFocus({ entry: entry({ entry: 'sdk-cli' }) });
  assert.equal(got.outcome, 'headless', 'no terminal at all, though under this host');
  got = await runFocus({ entry: entry({ entry: 'cli' }), answers: { terminals: [{ name: 'other', pid: 7000 }] } });
  assert.equal(got.outcome, 'unshown', 'a terminal that is not the session\'s is not shown');
  assert.deepEqual(got.ran, []);
});

test('focus: start times 9999 apart are one process, 10000 apart are two; compared exactly, not as Numbers', async () => {
  // As Numbers, 133774000000000001 and 133774000000010000 are 10000 apart; they are 9999 apart.
  for (const [mine, theirs, outcome] of [
    ['133774000000000001', '133774000000010000', 'panel'],
    ['133774000000010000', '133774000000000001', 'panel'],
    ['133774000000000000', '133774000000010000', 'stale'],
    ['133774000000010000', '133774000000000000', 'stale'],
    [START, START, 'panel']
  ]) {
    const got = await runFocus({ entry: entry({ procStart: mine }), tree: tree({ start: theirs }) });
    assert.equal(got.outcome, outcome, mine + ' and ' + theirs);
  }
});

test('focus: whether the file\'s process is the system\'s, row by row, for a chat panel session under this host', async () => {
  const far = '100000000000000000';
  const rows = [
    // [what, unit, the file's procStart, the system's start, outcome]
    ['filetime, the same', 'filetime', START, START, 'panel'],
    ['filetime, 9999 apart', 'filetime', '133774000000000001', '133774000000010000', 'panel'],
    ['filetime, 10000 apart', 'filetime', '133774000000000000', '133774000000010000', 'stale'],
    ['ticks, equal', 'ticks', '81234567', '81234567', 'panel'],
    ['ticks, 1 apart', 'ticks', '81234567', '81234568', 'unconfirmed'],
    ['ticks, far apart', 'ticks', '81234567', far, 'unconfirmed'],
    ['ticks, equal as numbers, not as written', 'ticks', '081234567', '81234567', 'unconfirmed'],
    ['no unit', undefined, START, START, 'unconfirmed'],
    ['an unknown unit', 'seconds', START, START, 'unconfirmed'],
    ['a unit in the wrong case', 'FILETIME', START, START, 'unconfirmed'],
    ['no start in the file', 'filetime', undefined, START, 'unconfirmed'],
    ['no start from the system', 'filetime', START, undefined, 'unconfirmed'],
    ['a start from the system that is a number', 'filetime', START, 133774000000000000, 'unconfirmed'],
    ['a start in the file that is not digits', 'filetime', '-133774000000000000', START, 'unconfirmed'],
    ['a start from the system that is not digits', 'ticks', '81234567', '81234567 ', 'unconfirmed'],
    ['an empty start', 'ticks', '', '', 'unconfirmed']
  ];
  for (const [what, unit, mine, theirs, outcome] of rows) {
    const got = await runFocus({ entry: entry({ procStart: mine }), tree: tree({ start: theirs, unit }) });
    assert.equal(got.outcome, outcome, what);
    const ran = got.calls.filter(c => c[0] === 'executeCommand');
    assert.deepEqual(ran, outcome === 'panel' ? [['executeCommand', PANEL, SID]] : [], what + ': the command ran only on proof');
    if (outcome === 'unconfirmed') assert.deepEqual(got.calls, [info('unconfirmed')], what);
    if (outcome === 'stale') assert.deepEqual(got.calls, [info('stale')], what);
  }
});

test('focus: with nothing proved, a terminal is still shown, for a terminal session and a chat panel one', async () => {
  const shell = { terminals: [{ name: 'example shell', pid: SHELL }] };
  for (const [what, options] of [
    ['a terminal session, ticks that differ', { entry: entry({ entry: 'cli', procStart: '8000' }), tree: tree({ start: '8001', unit: 'ticks' }) }],
    ['a terminal session, no start time at all', { entry: entry({ entry: 'cli', procStart: undefined }), tree: tree({ start: undefined, unit: undefined }) }],
    ['a chat panel session, no start time in the file', { entry: entry({ procStart: undefined }) }]
  ]) {
    const got = await runFocus({ answers: shell, ...options });
    assert.equal(got.outcome, 'terminal', what);
    assert.deepEqual(got.calls, [['terminal.show', 'example shell']], what);
  }
});

test('focus: the chain is copied, not trusted: its own includes, a Proxy round it, or a getter cannot put this host in it', async () => {
  const proved = { known: true, start: START, unit: 'filetime' };
  // The reviewer's probe: an array whose own `includes` says yes to anything, with this host's pid 7.
  let got = await runFocus({ hostPid: 7, tree: { ...proved, chain: Object.assign([100], { includes: () => true }) } });
  assert.equal(got.outcome, 'elsewhere', 'its own includes');
  assert.deepEqual(got.calls, [info('panelElsewhere')]);
  // A Proxy round an array: every method it is asked for says yes.
  const yes = new Proxy([PID], { get: (target, key) => (typeof key === 'string' && !/^\d+$/.test(key) && key !== 'length' ? () => true : Reflect.get(target, key)), has: () => true });
  assert.ok(Array.isArray(yes), 'the Proxy passes as an array');
  got = await runFocus({ hostPid: 7, tree: { ...proved, chain: yes } });
  assert.equal(got.outcome, 'elsewhere', 'a Proxy');
  assert.deepEqual(got.ran, []);
  // A getter that answers one chain to a check and another to the use.
  let reads = 0;
  const shifty = { ...proved, get chain() { reads++; return reads === 1 ? [] : [PID, SHELL, HOST, 1]; } };
  got = await runFocus({ tree: shifty });
  assert.equal(got.outcome, 'elsewhere', 'a getter');
  assert.deepEqual(got.ran, []);
  assert.equal(reads, 1, 'the chain is read once');
  // Only positive whole numbers are kept, and only the first 64 places are read.
  got = await runFocus({ tree: tree({ chain: [PID, String(HOST), HOST + 0.5, -HOST, null, { valueOf: () => HOST }] }) });
  assert.equal(got.outcome, 'elsewhere', 'nothing that only looks like this host\'s pid');
  const long = n => Array.from({ length: n }, (_, i) => 10000 + i);
  got = await runFocus({ tree: tree({ chain: [...long(63), HOST] }) });
  assert.equal(got.outcome, 'panel', 'the 64th place is read');
  got = await runFocus({ tree: tree({ chain: [...long(64), HOST] }) });
  assert.equal(got.outcome, 'elsewhere', 'the 65th is not');
  // A length that is not a whole number is no chain; a getter that throws is a list that could not be read.
  got = await runFocus({ tree: { ...proved, chain: new Proxy([PID, HOST], { get: (t, k) => (k === 'length' ? 'many' : Reflect.get(t, k)) }) } });
  assert.equal(got.outcome, 'elsewhere');
  got = await runFocus({ tree: { ...proved, get chain() { throw new Error('invented'); } } });
  assert.equal(got.outcome, 'unknown');
  assert.deepEqual(got.calls, [info('unknown')]);
});

test('focus: known, start and unit are read once each; a session id that changes between reads never reaches the command', async () => {
  const reads = { known: 0, start: 0, unit: 0, chain: 0 };
  const counted = { get known() { reads.known++; return true; }, get start() { reads.start++; return START; }, get unit() { reads.unit++; return 'filetime'; }, get chain() { reads.chain++; return [PID, SHELL, HOST, 1]; } };
  let got = await runFocus({ tree: counted });
  assert.equal(got.outcome, 'panel');
  assert.deepEqual(reads, { known: 1, start: 1, unit: 1, chain: 1 });
  // A start time that proves the same process to one read and nothing to the next.
  let startReads = 0;
  got = await runFocus({ tree: { ...tree(), get start() { startReads++; return startReads === 1 ? START : undefined; } } });
  assert.equal(got.outcome, 'panel', 'the one read is the one used');
  assert.equal(startReads, 1);
  // The reviewer's probe: the hub's answer gives a valid id to the check and another value to the use.
  let sessionReads = 0;
  const answer = { kind: 'session', agent: 'claude', get session() { sessionReads++; return sessionReads === 1 ? SID : 'not-a-session --evil'; } };
  got = await runFocus({ answer });
  assert.equal(sessionReads, 1, 'the id is read once');
  assert.deepEqual(got.ran, [['executeCommand', PANEL, SID]], 'the checked id is the one used');
  assert.deepEqual(got.deps.asked.session, [SID]);
  assert.ok(!JSON.stringify(got.calls).includes('evil'));
  // The other way round: a bad id first is no live session, whatever the next read says.
  sessionReads = 0;
  const bad = { kind: 'session', get session() { sessionReads++; return sessionReads === 1 ? 'not-a-session --evil' : SID; } };
  got = await runFocus({ answer: bad });
  assert.equal(got.outcome, 'gone');
  assert.deepEqual(got.calls, [info('gone')]);
  // Getters that throw are a bad answer, not a failure.
  got = await runFocus({ answer: { kind: 'session', get session() { throw new Error('invented'); } } });
  assert.equal(got.outcome, 'gone');
  got = await runFocus({ entry: { get pid() { throw new Error('invented'); } } });
  assert.equal(got.outcome, 'no-process');
});

test('focus: the first terminal in the list whose process is in the chain, whichever answers first', async () => {
  let got = await runFocus({ entry: entry({ entry: 'cli' }), answers: { terminals: [{ name: 'other', pid: 7000 }, { name: 'example shell', pid: SHELL }] } });
  assert.equal(got.outcome, 'terminal');
  assert.deepEqual(got.ran, [['terminal.show', 'example shell']], 'the second, the only one that matches');
  const slow = { then: ok => { setTimeout(() => ok(PID), 20); } };
  got = await runFocus({ answers: { terminals: [{ name: 'first', pid: slow }, { name: 'second', pid: SHELL }] } });
  assert.deepEqual(got.ran, [['terminal.show', 'first']], 'the list\'s order, not the order of the answers');
  got = await runFocus({ entry: entry({ entry: 'cli' }), answers: { terminals: [{ name: 'starting', pid: undefined }, { name: 'none', pid: Promise.resolve(undefined) }] } });
  assert.equal(got.outcome, 'unshown', 'a terminal with no process id matches nothing');
});

test('focus: a terminal whose process id fails, or cannot be read, counts as one with no id', async () => {
  const fails = { then: (ok, no) => no(new Error('invented')) };
  const throws = { then: () => { throw new Error('invented'); } };
  const got = await runFocus({ answers: { terminals: [{ name: 'fails', pid: fails }, { name: 'throws', pid: throws }, { name: 'example shell', pid: SHELL }] } });
  assert.equal(got.outcome, 'terminal');
  assert.deepEqual(got.ran, [['terminal.show', 'example shell']]);
  const vscode = fakeVscode({ commands: [PANEL] });
  vscode.window.terminals = [null, { get processId() { throw new Error('invented'); }, show() { throw new Error('not this one'); } }];
  assert.equal(await actions.focus(vscode, focusDeps({ entry: entry({ entry: 'cli' }) }), AGENT), 'unshown');
});

test('focus: the terminals are waited for 1500 ms and no longer; what answered by then still counts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const never = { then() {} };
  const vscode = fakeVscode({ commands: [PANEL], terminals: [{ name: 'never', pid: never }, { name: 'fails', pid: { then: (ok, no) => no(new Error('invented')) } }, { name: 'example shell', pid: SHELL }] });
  let outcome;
  void actions.focus(vscode, focusDeps(), AGENT).then(o => { outcome = o; });
  await flush();
  t.mock.timers.tick(1499);
  await flush();
  assert.equal(outcome, undefined, 'still waiting at 1499 ms');
  assert.deepEqual(vscode.calls, []);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(outcome, 'terminal', 'done at 1500 ms');
  assert.deepEqual(vscode.calls, [['terminal.show', 'example shell']], 'the terminal that answered is shown; the one that never did is not waited for');

  // When every terminal answers, nothing waits for the timer.
  const quick = fakeVscode({ commands: [PANEL], terminals: [{ name: 'example shell', pid: SHELL }] });
  outcome = undefined;
  void actions.focus(quick, focusDeps(), AGENT).then(o => { outcome = o; });
  await flush();
  assert.equal(outcome, 'terminal', 'no timer had to run');
  // A window where no terminal answers in time goes on to the next step, and never runs the command for a session that is not its own.
  const stuck = fakeVscode({ commands: [PANEL], terminals: [{ name: 'never', pid: never }] });
  outcome = undefined;
  void actions.focus(stuck, focusDeps({ tree: tree({ chain: [PID, 7000, 1] }) }), AGENT).then(o => { outcome = o; });
  await flush();
  t.mock.timers.tick(1500);
  await flush();
  assert.equal(outcome, 'elsewhere');
  assert.deepEqual(stuck.calls, [info('panelElsewhere')]);
});

test('focus: no list of terminals at all is an empty list', async () => {
  let got = await runFocus({ answers: { terminals: undefined } });
  assert.equal(got.outcome, 'panel');
  got = await runFocus({ answers: { terminals: undefined }, entry: entry({ entry: 'cli' }), tree: tree({ chain: [PID, 7000, 1] }) });
  assert.equal(got.outcome, 'elsewhere');
  assert.deepEqual(got.calls, [info('elsewhere')]);
});

test('the view passes a double-click on a session to focus, with its own deps; a file still goes to open', async t => {
  const session = () => null, ancestors = async () => ({ chain: [], known: false });
  const { vscode, view, client } = makeView(t, { deps: { session, ancestors, hostPid: HOST } });
  const seen = [];
  const real = { focus: actions.focus, open: actions.open };
  t.after(() => Object.assign(actions, real));
  actions.focus = async (v, deps, request) => { seen.push(['focus', v, deps, request]); return 'invented'; };
  actions.open = async (v, deps, request) => { seen.push(['open', v, deps, request]); return 'invented'; };
  view.show();
  const panel = vscode.panels[0];
  say(panel, { v: 1, type: 'ready' });
  say(panel, { v: 1, type: 'act', action: 'focus', target: { class: 'agent', id: 'a:claude:' + SID }, member: 'a.js' });
  assert.equal(seen.length, 1);
  const [kind, v, deps, request] = seen[0];
  assert.equal(kind, 'focus');
  assert.equal(v, vscode);
  assert.deepEqual(request, { action: 'focus', target: { class: 'agent', id: 'a:claude:' + SID }, member: 'a.js' });
  assert.equal(deps.session, session);
  assert.equal(deps.ancestors, ancestors);
  assert.equal(deps.hostPid, HOST);
  client.answer = target => { client.asked = target; return { kind: 'none' }; };
  assert.deepEqual(await deps.resolve({ id: 'a:claude:' + SID }), { kind: 'none' });
  assert.deepEqual(client.asked, { id: 'a:claude:' + SID }, 'resolve asks this window\'s hub client');
  say(panel, { v: 1, type: 'act', action: 'open', target: { class: 'resource', id: 'r:claude:' + SID + ':file:./' } });
  assert.deepEqual(seen.map(s => s[0]), ['focus', 'open']);
  assert.deepEqual(seen[1][2].folders(), ['/home/example/proj']);
  assert.equal(seen[1][2].viewColumn, 1, 'files open in the main editor group');
});

test('the view, through focus, shows a chat panel session of this window; the status bar message goes after it', async t => {
  const { vscode, view, client } = makeView(t, { answers: { terminals: [], commands: [PANEL], statusBar: true }, deps: {
    session: id => (id === SID ? entry() : null), ancestors: async pid => (pid === PID ? tree() : { chain: [pid], known: true }), hostPid: HOST
  } });
  client.answer = () => ({ kind: 'session', agent: 'claude', session: SID, cwd: '/home/example/proj', root: null, pid: PID });
  view.show();
  const panel = vscode.panels[0];
  say(panel, { v: 1, type: 'ready' });
  say(panel, { v: 1, type: 'act', action: 'focus', target: { class: 'agent', id: 'a:claude:' + SID } });
  let atHide;
  vscode.status[0].hide.then(() => { atHide = vscode.calls.slice(); });
  await until(() => atHide);
  assert.deepEqual(vscode.calls, [['getCommands', true], ['executeCommand', PANEL, SID]]);
  assert.deepEqual(atHide, vscode.calls, 'the message went only when everything was done');
});

test('the view: while focus runs the status bar says so, until focus has settled, whether it resolved or rejected', async t => {
  const real = actions.focus;
  t.after(() => { actions.focus = real; });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  for (const ending of ['resolves', 'rejects']) {
    const { vscode, view } = makeView(t, { answers: { statusBar: true } });
    let finish;
    actions.focus = () => new Promise((ok, no) => { finish = () => (ending === 'resolves' ? ok('panel') : no(new Error('invented'))); });
    view.show();
    const panel = vscode.panels[0];
    say(panel, { v: 1, type: 'ready' });
    say(panel, { v: 1, type: 'act', action: 'focus', target: { class: 'agent', id: 'a:claude:' + SID } });
    assert.equal(vscode.status.length, 1, ending + ': one message');
    assert.equal(vscode.status[0].text, '$(sync~spin) 3D Monitor: looking for the session…');
    const hide = vscode.status[0].hide;
    assert.equal(typeof hide.then, 'function', 'with a thenable');
    let settled = '';
    hide.then(() => { settled = 'resolved'; }, () => { settled = 'rejected'; });
    await flush();
    assert.equal(settled, '', ending + ': still there while focus runs');
    finish();
    await flush();
    assert.equal(settled, 'resolved', ending + ': gone when focus has settled, and the thenable never rejects');
    assert.deepEqual(vscode.calls, ending === 'rejects' ? [['showWarningMessage', '3D Monitor: that could not be shown (invented).', undefined, []]] : []);
  }
});

test('the view: open gets no status bar message, and a window without the function breaks nothing', async t => {
  let made = makeView(t, { answers: { statusBar: true } });
  made.view.show();
  say(made.vscode.panels[0], { v: 1, type: 'ready' });
  say(made.vscode.panels[0], { v: 1, type: 'act', action: 'open', target: { class: 'resource', id: 'r:claude:' + SID + ':file:./' } });
  await until(() => made.vscode.calls.length);
  assert.deepEqual(made.vscode.status, [], 'no message for open');
  // No setStatusBarMessage at all, and one that is not a function: focus runs to its end as before.
  for (const missing of [undefined, 'not a function']) {
    made = makeView(t, { answers: { terminals: [], commands: [PANEL] }, deps: { session: () => entry(), ancestors: async () => tree(), hostPid: HOST } });
    if (missing !== undefined) made.vscode.window.setStatusBarMessage = missing;
    made.client.answer = () => ({ kind: 'session', agent: 'claude', session: SID, cwd: '/home/example/proj', root: null, pid: PID });
    made.view.show();
    say(made.vscode.panels[0], { v: 1, type: 'ready' });
    say(made.vscode.panels[0], { v: 1, type: 'act', action: 'focus', target: { class: 'agent', id: 'a:claude:' + SID } });
    await until(() => made.vscode.calls.some(c => c[0] === 'executeCommand'));
    assert.deepEqual(made.vscode.calls, [['getCommands', true], ['executeCommand', PANEL, SID]], String(missing));
    assert.deepEqual(made.logs, [], 'nothing threw');
  }
});

test('a view built without the session deps finds no process, says so, and runs nothing', async t => {
  let made = makeView(t, { answers: { terminals: [], commands: [PANEL] } });
  made.client.answer = () => ({ kind: 'session', agent: 'claude', session: SID, cwd: '/home/example/proj', root: null, pid: PID });
  made.view.show();
  say(made.vscode.panels[0], { v: 1, type: 'ready' });
  say(made.vscode.panels[0], { v: 1, type: 'act', action: 'focus', target: { class: 'agent', id: 'a:claude:' + SID } });
  await until(() => made.vscode.calls.length);
  assert.deepEqual(made.vscode.calls, [info('noProcess')]);
  assert.deepEqual(made.logs, [], 'nothing threw');
  // With a session but no way to read the process list: nothing can be found.
  made = makeView(t, { answers: { terminals: [], commands: [PANEL] }, deps: { session: () => entry() } });
  made.client.answer = () => ({ kind: 'session', agent: 'claude', session: SID, cwd: '/home/example/proj', root: null, pid: PID });
  made.view.show();
  say(made.vscode.panels[0], { v: 1, type: 'ready' });
  say(made.vscode.panels[0], { v: 1, type: 'act', action: 'focus', target: { class: 'agent', id: 'a:claude:' + SID } });
  await until(() => made.vscode.calls.length);
  assert.deepEqual(made.vscode.calls, [info('unknown')]);
});

test('the view: a show that fails says "could not be shown"; an open that fails still says "could not be opened"', async t => {
  const { vscode, view, client } = makeView(t, { answers: { terminals: [{ name: 'example shell', pid: SHELL, fails: true }], commands: [PANEL] }, deps: {
    session: () => entry({ entry: 'cli' }), ancestors: async () => tree(), hostPid: HOST
  } });
  client.answer = () => ({ kind: 'session', agent: 'claude', session: SID, cwd: '/home/example/proj', root: null, pid: PID });
  view.show();
  const panel = vscode.panels[0];
  say(panel, { v: 1, type: 'ready' });
  say(panel, { v: 1, type: 'act', action: 'focus', target: { class: 'agent', id: 'a:claude:' + SID } });
  await until(() => vscode.calls.some(c => c[0] === 'showWarningMessage'));
  assert.deepEqual(vscode.calls, [['terminal.show', 'example shell'], ['showWarningMessage', '3D Monitor: that could not be shown (invented).', undefined, []]]);
  vscode.calls.length = 0;
  const real = actions.open;
  t.after(() => { actions.open = real; });
  actions.open = async () => { throw new Error('invented'); };
  say(panel, { v: 1, type: 'act', action: 'open', target: { class: 'resource', id: 'r:claude:' + SID + ':file:./' } });
  await until(() => vscode.calls.length);
  assert.deepEqual(vscode.calls, [['showWarningMessage', '3D Monitor: that could not be opened (invented).', undefined, []]]);
});

/** Wait, a few turns at most, for what an action does after the page's message was handled. */
async function until(happened) {
  for (let i = 0; i < 50 && !happened(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(happened(), 'it happened');
}
