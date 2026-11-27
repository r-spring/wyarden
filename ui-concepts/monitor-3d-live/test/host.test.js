// The extension host's two small parts, against a stand-in for `vscode`: the tab (its policy, its HTML and the
// messages it carries) and what a double-click does. No editor is started. Every path and name is invented.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../lib/contract.js');
const { MonitorView, policy, fillTemplate, validScope, SCOPE_KEY } = require('../lib/view.js');
const actions = require('../lib/actions.js');

const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

/** As much of `vscode` as the two files touch. Everything it is asked to do is written to `calls`. */
function fakeVscode(answers = {}) {
  const calls = [];
  const uri = value => ({ value, fsPath: value, toString: () => value });
  const panels = [];
  const vscode = {
    calls, panels,
    Uri: { joinPath: (base, ...parts) => uri([base.value, ...parts].join('/')), file: p => uri('file:' + p), parse: (text, strict) => uri(text) },
    ViewColumn: { Active: -1, Beside: -2 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    window: {
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
          reveal() { panel.revealed++; },
          onDidChangeViewState: fn => { panel.handlers.state = fn; },
          onDidDispose: fn => { panel.handlers.dispose = fn; }
        };
        panels.push(panel);
        return panel;
      },
      showTextDocument: async (u, options) => { calls.push(['showTextDocument', u.value, options]); },
      showQuickPick: async (items, options) => { calls.push(['showQuickPick', items.map(i => (typeof i === 'string' ? i : i.label))]); return answers.pick ? answers.pick(items) : undefined; },
      showWarningMessage: async (text, options, ...buttons) => { calls.push(['showWarningMessage', text, options && options.detail, buttons]); return answers.confirm; },
      showInformationMessage: async text => { calls.push(['showInformationMessage', text]); }
    },
    commands: { executeCommand: async (name, ...args) => { calls.push(['executeCommand', name, args[0] && args[0].value]); } },
    env: { openExternal: async u => { calls.push(['openExternal', u.value]); return true; } }
  };
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
function makeView(t, { folders = [{ path: '/home/example/proj', name: 'proj' }], saved, answers } = {}) {
  const vscode = fakeVscode(answers), context = fakeContext(t, saved), client = fakeClient(), logs = [];
  const collectors = { claude: { state: 'missing', folders: 2, installed: 0 } };
  const view = new MonitorView(vscode, context, { client, folders: () => folders, collectors: () => collectors, log: m => logs.push(m) });
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

test('the tab: scripts on, nothing kept while hidden, only the media folder readable, and no placeholder left in its HTML', t => {
  const { vscode, view } = makeView(t);
  view.show();
  const panel = vscode.panels[0];
  assert.equal(panel.type, 'wyardenMonitor.view');
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

test('a tab restored from the last session becomes the live one, unless a tab was already opened: then it is closed', t => {
  const restored = vscode => { const panel = vscode.window.createWebviewPanel('wyardenMonitor.view', '3D Monitor', -1, {}); panel.disposed = 0; panel.dispose = () => { panel.disposed++; }; return panel; };
  let made = makeView(t);
  const first = restored(made.vscode);
  made.view.restore(first);
  assert.equal(made.view.panel, first, 'with no tab open, the restored one is taken');
  assert.ok(first.webview.html.includes('nonce'), 'and gets the page');
  assert.equal(first.disposed, 0);

  made = makeView(t);
  made.view.show();
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

test('ready: the page gets the look, the hub state and the workspaces, and the hub is asked for a fresh snapshot of this window\'s folder', t => {
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
  assert.deepEqual(client.updates, [{ scope: C.wsKey('/home/example/proj'), snapshot: true }]);
  view.fromHub({ type: 'records', scope: 'all', records: [{ ev: 'tool.start' }] });
  assert.deepEqual(panel.posted[3], { v: 1, type: 'records', scope: 'all', records: [{ ev: 'tool.start' }] });
});

test('the scope: the saved choice, else this window\'s own workspace, else every open workspace', t => {
  assert.equal(makeView(t, { saved: { [SCOPE_KEY]: 'bbbbbbbbbbbb' } }).view.wanted(), 'bbbbbbbbbbbb');
  assert.equal(makeView(t, { saved: { [SCOPE_KEY]: 'not a key' } }).view.wanted(), C.wsKey('/home/example/proj'), 'a saved value of the wrong shape is ignored');
  assert.equal(makeView(t, { folders: [] }).view.wanted(), 'all');
  // A window with several folders is one workspace: its key is the window's, not its first folder's.
  const two = [{ path: '/home/example/proj', name: 'proj' }, { path: '/home/example/tools', name: 'tools' }];
  const view = makeView(t, { folders: two }).view;
  assert.equal(view.wanted(), C.windowKey(two.map(f => f.path)));
  assert.notEqual(view.wanted(), C.wsKey('/home/example/proj'));
  assert.equal(view.own(), view.wanted());
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

test('a hidden or closed tab asks the hub for nothing, and a page that loads again asks afresh', t => {
  const { vscode, view, client } = makeView(t);
  view.show();
  const panel = vscode.panels[0];
  say(panel, { v: 1, type: 'ready' });
  client.updates.length = 0;
  panel.visible = false; panel.handlers.state();
  assert.deepEqual(client.updates, [{ scope: null }]);
  view.fromHub({ type: 'records', scope: 'all', records: [] });
  assert.equal(panel.posted.filter(m => m.type === 'records').length, 0, 'no record goes to a page that is not there');
  panel.visible = true;
  say(panel, { v: 1, type: 'ready' });
  assert.deepEqual(client.updates[1], { scope: C.wsKey('/home/example/proj'), snapshot: true });
  panel.handlers.dispose();
  assert.deepEqual(client.updates[2], { scope: null });
  view.show();
  assert.equal(vscode.panels.length, 2, 'after it was closed, Open makes a new tab');
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
  assert.deepEqual(client.updates, [{ scope: C.wsKey('/home/example/proj'), snapshot: true }]);
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
  assert.deepEqual(vscode.calls, [['showTextDocument', 'file:' + file, { preview: true, viewColumn: -2 }]]);
  say(panel, { v: 1, type: 'act', action: 'erase', target: { class: 'resource', id: 'x' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vscode.calls.length, 1, 'an action that is not on the list does nothing');
});
