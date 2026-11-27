// The whole extension, activated against a stand-in for `vscode`, with a real hub on a loopback port:
// a hook payload posted to the hub must reach the tab as a record, a double-click must open the file,
// and "Set Up Collectors" and "Remove Collectors" must leave a settings file as it was.
// The home folder is a temporary one, so no real Claude folder and no real session is read. Every name is invented.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const C = require('../lib/contract.js');
const ROOT = path.join(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(what, test, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = test();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await wait(25);
  }
}

/** As much of `vscode` as extension.js, view.js and actions.js touch. */
function fakeVscode(folders, answer) {
  const uri = (scheme, p) => ({ scheme, path: p, fsPath: p, toString: () => scheme + ':' + p });
  const v = {
    commands_: new Map(), panels: [], calls: [], bars: [], output: [], providers: new Map(), modals: [],
    version: '0.0.0-test',
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, Beside: -2 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    Uri: {
      file: p => uri('file', p),
      from: parts => uri(parts.scheme, parts.path),
      parse: text => uri('web', text),
      joinPath: (base, ...parts) => uri(base.scheme, [base.path, ...parts].join('/'))
    },
    env: { appName: 'Example Editor', remoteName: undefined, openExternal: async u => { v.calls.push(['openExternal', u.path]); return true; } },
    workspace: {
      name: 'example-workspace',
      workspaceFolders: folders.map(f => ({ uri: uri('file', f), name: path.basename(f) })),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      registerTextDocumentContentProvider: (scheme, provider) => { v.providers.set(scheme, provider); return { dispose() {} }; }
    },
    window: {
      activeColorTheme: { kind: 2 },
      activeTextEditor: undefined,
      onDidChangeActiveColorTheme: () => ({ dispose() {} }),
      createOutputChannel: () => ({ appendLine: line => v.output.push(line), show() {}, dispose() {} }),
      createStatusBarItem: () => { const bar = { text: '', tooltip: '', command: '', shown: false, show() { bar.shown = true; }, dispose() {} }; v.bars.push(bar); return bar; },
      registerWebviewPanelSerializer: () => ({ dispose() {} }),
      createWebviewPanel(type, title, column, options) {
        const panel = {
          type, title, options, visible: true, posted: [], handlers: {},
          webview: {
            cspSource: 'https://example.invalid', html: '', options: undefined,
            asWebviewUri: u => uri('https', '//example.invalid' + u.path),
            postMessage: m => { panel.posted.push(m); return Promise.resolve(true); },
            onDidReceiveMessage: fn => { panel.handlers.message = fn; }
          },
          reveal() {}, onDidChangeViewState: fn => { panel.handlers.state = fn; }, onDidDispose: fn => { panel.handlers.dispose = fn; }
        };
        v.panels.push(panel);
        return panel;
      },
      showTextDocument: async u => { v.calls.push(['showTextDocument', u.path]); },
      showQuickPick: async items => items[0],
      showInformationMessage: async text => { v.calls.push(['info', text]); },
      showErrorMessage: async text => { v.calls.push(['error', text]); },
      showWarningMessage: async (text, options, ...buttons) => {
        if (options && options.modal) { v.modals.push({ text, detail: options.detail, buttons }); return answer(buttons); }
        v.calls.push(['warning', text]);
      }
    },
    commands: {
      registerCommand: (name, fn) => { v.commands_.set(name, fn); return { dispose() {} }; },
      executeCommand: async (name, ...args) => { v.calls.push(['command', name, ...args.filter(a => typeof a === 'string')]); }
    }
  };
  return v;
}

function post(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('activated in a window: a hook payload reaches the tab, a double-click opens the file, and the collector goes in and comes out', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-'));
  const home = path.join(base, 'home'), monitor = path.join(base, 'monitor'), project = path.join(base, 'example-project');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(path.join(project, '.git'));
  fs.writeFileSync(path.join(project, 'src', 'a.js'), '// invented\n');
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const original = JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'example-notify' }] }] } }, null, 2) + '\n';
  fs.writeFileSync(settingsFile, original);

  // The extension, the hub's worker and discovery all read these; set before anything loads.
  const saved = {};
  for (const [key, value] of Object.entries({ WYARDEN_MONITOR_HOME: monitor, USERPROFILE: home, HOME: home, CLAUDE_CONFIG_DIR: undefined, WYARDEN_MONITOR_E2E: undefined })) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  let pressed = buttons => buttons[0];
  const vscode = fakeVscode([project], buttons => pressed(buttons));
  const realLoad = Module._load;
  Module._load = function (request, ...rest) { return request === 'vscode' ? vscode : realLoad.call(this, request, ...rest); };
  const subscriptions = [];
  t.after(async () => {
    for (const s of subscriptions.reverse()) { try { await s.dispose(); } catch { /* closing anyway */ } }
    Module._load = realLoad;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await wait(300);            // the hub's worker lets go of the folder
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const state = new Map();
  const context = {
    subscriptions, extensionPath: ROOT, extensionUri: vscode.Uri.file(ROOT), extensionMode: vscode.ExtensionMode.Production,
    workspaceState: { get: key => state.get(key), update: async (key, value) => { state.set(key, value); } }
  };
  delete require.cache[require.resolve('../extension.js')];
  require('../extension.js').activate(context);

  for (const name of ['wyardenMonitor.open', 'wyardenMonitor.chooseWorkspace', 'wyardenMonitor.setupCollectors', 'wyardenMonitor.removeCollectors', 'wyardenMonitor.status'])
    assert.ok(vscode.commands_.has(name), name + ' is registered');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.contributes.commands.map(c => c.command).sort(), [...vscode.commands_.keys()].sort(), 'the manifest and the code name the same commands');
  assert.equal(vscode.bars[0].command, 'wyardenMonitor.open');
  assert.equal(vscode.bars[0].shown, true);

  // The tab: its page says it is ready, and gets the look, the hub state, the workspaces and a snapshot.
  const hub = C.readHubFile(monitor);
  assert.ok(hub, 'the hub file was made in the folder the test named');
  vscode.commands_.get('wyardenMonitor.open')();
  const panel = vscode.panels[0];
  assert.ok(panel.webview.html.includes('page.js') && !panel.webview.html.includes('{{'), 'the real page.html, filled');
  panel.handlers.message({ v: 1, type: 'ready' });
  const types = () => panel.posted.map(m => m.type);
  await until('the first snapshot', () => panel.posted.some(m => m.type === 'records' && m.records.some(r => r.ctl === 'snapshot')));
  assert.ok(types().includes('look') && types().includes('hub') && types().includes('workspaces'));
  const hubUp = await until('the hub to be up', () => [...panel.posted].reverse().find(m => m.type === 'hub' && m.state === 'up'));
  assert.equal(hubUp.role, 'hub', 'the only window runs the hub');
  assert.deepEqual(hubUp.collectors.claude, { state: 'missing', folders: 1, installed: 0 });
  const spaces = [...panel.posted].reverse().find(m => m.type === 'workspaces');
  assert.deepEqual(spaces.list.map(w => [w.name, w.windows, w.apps]), [['example-project', 1, ['Example Editor']]]);
  assert.deepEqual(spaces.here, [C.wsKey(project)]);
  assert.equal(spaces.scope, C.wsKey(project), 'the window is shown its own folder first');

  // A hook payload, posted the way Claude Code posts it.
  const session = '11111111-2222-4333-8444-555555555555';
  const common = { session_id: session, cwd: project, transcript_path: path.join(home, 'x.jsonl'), prompt_id: 'p-1', permission_mode: 'default' };
  const file = path.join(project, 'src', 'a.js');
  assert.equal(await post(hub.port, C.hookPath(hub.ingest, 'claude'), { ...common, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: file }, tool_use_id: 'toolu_example0001' }), 200);
  const events = () => panel.posted.filter(m => m.type === 'records').flatMap(m => m.records).filter(r => r.ev);
  const start = await until('the tool.start record', () => events().find(r => r.ev === 'tool.start'));
  assert.equal(start.tool, 'Read'); assert.equal(start.src, 'hook:PreToolUse'); assert.equal(start.grade, 'exact');
  const touch = await until('the resource.touch record', () => events().find(r => r.ev === 'resource.touch'));
  assert.equal(touch.path, 'src/a.js');
  assert.equal(await post(hub.port, C.hookPath(hub.ingest, 'claude'), { ...common, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: file }, tool_use_id: 'toolu_example0001', tool_response: { type: 'text' }, duration_ms: 12 }), 200);
  const end = await until('the tool.end record', () => events().find(r => r.ev === 'tool.end'));
  assert.equal(end.ok, true); assert.equal(end.ms, 12);
  const everything = JSON.stringify(panel.posted);
  assert.ok(!everything.includes(base) && !everything.includes(base.replace(/\\/g, '\\\\')) && !everything.includes(base.replace(/\\/g, '/')), 'no absolute path reaches the page');
  assert.ok(!everything.includes(hub.ingest) && !everything.includes(hub.control), 'no token reaches the page');
  assert.equal(await post(hub.port, '/wyarden-monitor/h/' + 'x'.repeat(43) + '/claude', { ...common, hook_event_name: 'PreToolUse' }), 404, 'a wrong token is refused');

  // A double-click on the file's node.
  panel.handlers.message({ v: 1, type: 'act', action: 'open', target: { class: 'resource', id: 'r:claude:' + session + ':file:src/' } });
  const opened = await until('the editor to open', () => vscode.calls.find(c => c[0] === 'showTextDocument'));
  assert.equal(C.relativeIn(project, opened[1]), 'src/a.js');

  // Set-up: shown as a diff first, then written after one confirmation; removal puts the file back.
  await vscode.commands_.get('wyardenMonitor.setupCollectors')();
  assert.ok(vscode.calls.some(c => c[0] === 'command' && c[1] === 'vscode.diff'), 'the change is shown as a diff');
  assert.equal(vscode.modals.length, 1);
  assert.ok(vscode.modals[0].detail.includes(settingsFile), 'the question names the file');
  const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(after.permissions, { allow: ['Read'] });
  assert.equal(after.hooks.Stop[0].hooks[0].command, 'example-notify', 'the other hook is still there, and first');
  assert.equal(after.hooks.PreToolUse[0].hooks[0].url, C.hookUrl(hub, 'claude'));
  assert.equal(after.hooks.SessionStart, undefined); assert.equal(after.hooks.SessionEnd, undefined);
  const told = await until('the page to hear the collector is installed', () => [...panel.posted].reverse().find(m => m.type === 'hub' && m.collectors.claude.state === 'installed'));
  assert.deepEqual(told.collectors.claude, { state: 'installed', folders: 1, installed: 1 });

  await vscode.commands_.get('wyardenMonitor.setupCollectors')();
  assert.equal(vscode.modals.length, 1, 'a second set-up finds nothing to do and asks nothing');

  pressed = () => undefined;                                    // the owner closes the question
  await vscode.commands_.get('wyardenMonitor.removeCollectors')();
  assert.equal(vscode.modals.length, 2);
  assert.ok(fs.readFileSync(settingsFile, 'utf8').includes(C.MARK), 'nothing was removed without a yes');
  pressed = buttons => buttons[0];
  await vscode.commands_.get('wyardenMonitor.removeCollectors')();
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), original, 'after removal the file is byte for byte what it was');

  // Status prints figures and no token.
  await vscode.commands_.get('wyardenMonitor.status')();
  const printed = vscode.output.join('\n');
  assert.match(printed, /Hub: up/);
  assert.ok(!printed.includes(hub.ingest) && !printed.includes(hub.control), 'no token in the output channel');
});
