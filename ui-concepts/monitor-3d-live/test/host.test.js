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

/**
 * As much of `vscode` as the two files touch. Everything it is asked to do is written to `calls`.
 *   answers.terminals  [{name, pid, fails}]: `pid` a number, or a thenable as it is; `fails` makes show() throw. Left out: no list at all.
 *   answers.commands   what getCommands answers
 */
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
      showInformationMessage: async text => { calls.push(['showInformationMessage', text]); },
      terminals: answers.terminals && answers.terminals.map(spec => ({
        name: spec.name,
        processId: typeof spec.pid === 'number' ? Promise.resolve(spec.pid) : spec.pid,
        show: (...args) => { calls.push(['terminal.show', spec.name, ...args]); if (spec.fails) throw new Error('invented'); }
      }))
    },
    commands: {
      executeCommand: async (name, ...args) => { calls.push(['executeCommand', name, typeof args[0] === 'string' ? args[0] : args[0] && args[0].value]); },
      getCommands: async filter => { calls.push(['getCommands', filter]); return answers.commands || []; }
    },
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
  assert.deepEqual(vscode.calls, [['showTextDocument', 'file:' + file, { preview: true, viewColumn: -2 }]]);
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
    ancestors: async pid => { asked.ancestors.push(pid); return 'tree' in over ? over.tree : { chain: [PID, SHELL, HOST, 1], known: true, start: START }; },
    hostPid: 'hostPid' in over ? over.hostPid : HOST
  };
  for (const name of ['resolve', 'session', 'ancestors']) if (typeof over[name] === 'function') deps[name] = over[name];
  return deps;
}
const entry = extra => ({ session: SID, pid: PID, entry: 'claude-vscode', procStart: START, ...extra });
const tree = extra => ({ chain: [PID, SHELL, HOST, 1], known: true, start: START, ...extra });
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
    ['8b: no command to show a chat panel', { answers: { commands: ['example.other'] } }, 'no-panel-command', [['getCommands', true], info('noPanelCommand')]],
    ['8c: a chat panel of this window', {}, 'panel', [['getCommands', true], ['executeCommand', PANEL, SID]]],
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

test('focus: the chat panel command runs only when the file says chat panel, the process is under this host, and the start times agree', async () => {
  // All three hold: the one command runs, once.
  let got = await runFocus();
  assert.equal(got.outcome, 'panel');
  assert.deepEqual(got.ran, [['executeCommand', PANEL, SID]]);
  // Each condition false on its own, from the same answers. Claude Code's command is present each time, so only the condition stops it.
  const alone = [
    ['the file says a terminal', { entry: entry({ entry: 'cli' }) }, 'unshown'],
    ['the file says nothing of where it runs', { entry: entry({ entry: undefined }) }, 'unshown'],
    ['the file says no terminal', { entry: entry({ entry: 'sdk-cli' }) }, 'headless'],
    ['this host is not in the chain', { tree: tree({ chain: [PID, SHELL, 7000, 1] }) }, 'elsewhere'],
    ['this host\'s pid is not known', { hostPid: undefined }, 'elsewhere'],
    ['the start times are 1 ms apart', { tree: tree({ start: '133774000000010000' }) }, 'stale'],
    ['the start times are 1 ms apart, the other way', { tree: tree({ start: '133773999999990000' }) }, 'stale']
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

test('focus: a start time that is not known, or not digits, skips the check', async () => {
  const far = '100000000000000000';
  for (const [what, options] of [
    ['no start in the file', { entry: entry({ procStart: undefined }), tree: tree({ start: far }) }],
    ['no start from the system', { tree: tree({ start: undefined }) }],
    ['a start from the system that is a number', { tree: tree({ start: 100000000000000000 }) }],
    ['a start that is not digits', { entry: entry({ procStart: '-133774000000000000' }), tree: tree({ start: far }) }]
  ]) {
    const got = await runFocus(options);
    assert.equal(got.outcome, 'panel', what);
  }
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
  assert.deepEqual(Object.keys(seen[1][2]).sort(), ['folders', 'resolve'], 'open gets what it got before');
});

test('the view, through focus, shows a chat panel session of this window', async t => {
  const { vscode, view, client } = makeView(t, { answers: { terminals: [], commands: [PANEL] }, deps: {
    session: id => (id === SID ? entry() : null), ancestors: async pid => (pid === PID ? tree() : { chain: [pid], known: true }), hostPid: HOST
  } });
  client.answer = () => ({ kind: 'session', agent: 'claude', session: SID, cwd: '/home/example/proj', root: null, pid: PID });
  view.show();
  const panel = vscode.panels[0];
  say(panel, { v: 1, type: 'ready' });
  say(panel, { v: 1, type: 'act', action: 'focus', target: { class: 'agent', id: 'a:claude:' + SID } });
  await until(() => vscode.calls.some(c => c[0] === 'executeCommand'));
  assert.deepEqual(vscode.calls, [['getCommands', true], ['executeCommand', PANEL, SID]]);
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
