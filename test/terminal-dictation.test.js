const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');

function fixture(provider = 'parakeet', options = {}) {
  const calls = [], updates = [], status = { show() {}, hide() {}, dispose() { this.disposed = true; } };
  const terminal = { sent: [], sendText(...args) { this.sent.push(args); } };
  const other = { sent: [], sendText(...args) { this.sent.push(args); } };
  let stops = 0, cancels = 0;
  const recordings = [], closeListeners = new Set(), commands = new Map();
  const engine = (selection, handlers) => {
    let finish;
    const closed = new Promise(resolve => { finish = resolve; });
    calls.push(selection.provider); recordings.push({ events: handlers, finish }); handlers.recording();
    return { closed, stop: async () => { stops++; handlers.text('hello'); finish(); }, cancel: () => { cancels++; if (!options.delayClose) finish(); } };
  };
  const config = { skipped: ['workbench.action.toggleSidebarVisibility'], get(key, fallback) {
    return key === 'commandsToSkipShell' ? this.skipped : fallback;
  }, async update(key, value, scope) { updates.push({ key, value, scope }); this.skipped = value; } };
  const vscode = {
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose: () => commands.delete(id) }; } },
    Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join('/') }) },
    window: { activeTerminal: terminal, terminals: [terminal, other], createStatusBarItem: () => status,
      onDidCloseTerminal: fn => { closeListeners.add(fn); return { dispose: () => closeListeners.delete(fn) }; }, showErrorMessage: assert.fail },
    workspace: { getConfiguration: () => config, onDidChangeConfiguration: () => ({ dispose() {} }) },
    ConfigurationTarget: { Global: 1 }, StatusBarAlignment: { Left: 1 },
  };
  const filename = require.resolve('../out/extension'), extension = new Module(filename, module);
  extension.filename = filename;
  extension.require = name => name === 'vscode' ? vscode
    : name === './voice' ? { dictate: engine, dictateStream: engine }
    : name === './speech-settings' ? { migrateSpeechSettings() {}, registerSpeechSettings() {}, speechOptions: options.selection || (async () => ({ provider })) }
    : name === './workspace' ? { unmovedDataFolder() {} }
    : name === './board' ? { paste: text => `\x1b[200~${text}\x1b[201~\r` }
    : name === './cardTerminal' ? { BOARD_CSP: () => '' }
    : name === './accounts' ? { onAccountsChanged: () => ({ dispose() {} }) }
    : name.startsWith('./') ? {} : require(name);
  extension._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.speechTest={dictateTerminal,enableTerminalDictationShortcut,BoardView};', filename);
  const { BoardView, ...speech } = extension.exports.speechTest;
  const view = new BoardView({ path: '/extension' }, { onChange() {} });
  function attach(kind) {
    const messages = [], disposers = [];
    let receive;
    const host = { webview: { asWebviewUri: uri => uri.path, postMessage: message => messages.push(message),
      onDidReceiveMessage: fn => { receive = fn; } }, onDidDispose: fn => disposers.push(fn) };
    if (kind === 'sidebar') view.resolveWebviewView(host);
    else view.deserializeWebviewPanel(host);
    return { messages, toggle: () => receive({ type: 'dictate' }), close: () => disposers.splice(0).forEach(fn => fn()) };
  }
  async function activateSpeech() {
    const subscriptions = [], stop = new Error('stop after speech registration');
    await assert.rejects(extension.exports.activate({ subscriptions, extensionPath: '/extension', get extensionMode() { throw stop; } }), e => e === stop);
    return { cancel: commands.get('entomatical.cancelDictation'), deactivate() {
      const closing = extension.exports.deactivate();
      subscriptions.forEach(subscription => subscription.dispose());
      return closing;
    } };
  }
  return { ...speech, activateSpeech, attach, recordings, calls, updates, status, terminal, other, vscode, config, finish: () => recordings.at(-1).finish(),
    close: (target = terminal) => closeListeners.forEach(fn => fn(target)), get events() { return recordings.at(-1).events; },
    get stops() { return stops; }, get cancels() { return cancels; } };
}

function surfaces(f, t) {
  const terminal = { toggle: f.dictateTerminal, close: f.close, text: () => f.terminal.sent.map(([s]) => s) };
  const targets = { terminal };
  for (const kind of ['sidebar', 'editor']) {
    const board = f.attach(kind);
    t.after(board.close);
    targets[kind] = { ...board, text: () => board.messages.filter(m => 'dictated' in m).map(m => m.dictated) };
  }
  return targets;
}

for (const kind of ['sidebar', 'editor', 'terminal']) {
  test(kind + ' keeps its final transcript when the other surfaces close first', async t => {
    const f = fixture(), targets = surfaces(f, t), owner = targets[kind];
    const running = owner.toggle();
    await new Promise(setImmediate);
    for (const target of Object.values(targets)) if (target !== owner) target.close();
    assert.equal(f.cancels, 0);
    await owner.toggle(); await running;
    assert.equal(f.stops, 1);
    assert.deepEqual(owner.text(), [kind === 'terminal' ? '\x1b[200~ hello\x1b[201~' : 'hello']);
    for (const target of Object.values(targets)) if (target !== owner) assert.deepEqual(target.text(), []);
    owner.close();
    assert.equal(f.cancels, 0);
  });

  test(kind + ' closing first cancels once and blocks a replacement until closed', async t => {
    const f = fixture('parakeet', { delayClose: true }), targets = surfaces(f, t), owner = targets[kind];
    const running = owner.toggle();
    await new Promise(setImmediate);
    const old = f.recordings[0];
    owner.close();
    assert.equal(f.cancels, 1);
    const [replacement, unrelated] = Object.values(targets).filter(target => target !== owner);
    await replacement.toggle();
    assert.equal(f.recordings.length, 1);
    unrelated.close();
    const messages = owner.messages?.slice();
    old.events.partial?.('stale partial'); old.events.text('stale final');
    old.events.recording(); old.events.transcribing(); old.events.error('stale error');
    old.finish(); await running;
    assert.deepEqual(owner.messages, messages);
    const next = replacement.toggle();
    await new Promise(setImmediate);
    await replacement.toggle(); await next;
    assert.deepEqual(owner.text(), []);
    assert.deepEqual(unrelated.text(), []);
    assert.deepEqual(replacement.text(), [replacement === targets.terminal ? '\x1b[200~ hello\x1b[201~' : 'hello']);
    assert.equal(f.cancels, 1);
  });
}

test('global Cancel keeps the same board from restarting until the old recorder closes', async t => {
  const f = fixture('parakeet', { delayClose: true }), board = f.attach('sidebar');
  t.after(board.close);
  const activation = await f.activateSpeech();
  const first = board.toggle();
  await new Promise(setImmediate);
  activation.cancel(); activation.cancel();
  assert.equal(f.cancels, 1);
  assert.deepEqual(board.messages.at(-1), { dictating: false });
  await board.toggle();
  assert.equal(f.recordings.length, 1);
  const before = board.messages.slice(), old = f.recordings[0];
  old.events.text('old'); old.events.partial('old preview'); old.events.transcribing();
  old.finish(); await first;
  assert.deepEqual(board.messages, before);
  const second = board.toggle();
  await new Promise(setImmediate);
  await board.toggle(); await second;
  assert.deepEqual(board.messages.filter(m => 'dictated' in m), [{ dictated: 'hello' }]);
});

test('a cancelled F8 listener ignores its terminal closing after the board starts, and deactivation cancels the board', async t => {
  const f = fixture('parakeet', { delayClose: true }), board = f.attach('editor');
  t.after(board.close);
  const activation = await f.activateSpeech(), first = f.dictateTerminal();
  await new Promise(setImmediate);
  activation.cancel();
  await board.toggle();
  assert.equal(f.recordings.length, 1);
  f.finish(); await first;
  const second = board.toggle();
  await new Promise(setImmediate);
  f.close();
  assert.equal(f.cancels, 1);
  const closing = activation.deactivate();
  assert.ok(closing instanceof Promise);
  board.close();
  assert.equal(f.cancels, 2);
  for (const recording of f.recordings) { recording.events.text('stale final'); recording.finish(); }
  await Promise.all([closing, second]);
  assert.deepEqual(board.messages.filter(m => 'dictated' in m), []);
  assert.deepEqual(f.terminal.sent, []);
});

for (const provider of ['local', 'parakeet', 'openai', 'groq', 'deepgram']) {
  test(`terminal dictation uses saved ${provider} settings and keeps the original input target`, async () => {
    const f = fixture(provider), running = f.dictateTerminal();
    await new Promise(setImmediate);
    f.vscode.window.activeTerminal = f.other;
    f.events.text('first sentence'); f.events.text('next\nline\x03\x1b');
    f.finish(); await running;
    assert.deepEqual(f.calls, [provider]);
    assert.deepEqual(f.terminal.sent, [['\x1b[200~ first sentence\x1b[201~', false], ['\x1b[200~ next\nline\x1b[201~', false]]);
    assert.deepEqual(f.other.sent, []);
    assert.equal(f.status.disposed, true);
  });
}

test('a second F8 stops the original recording and inserts its final transcript without Enter', async () => {
  const f = fixture(), running = f.dictateTerminal();
  await new Promise(setImmediate);
  f.vscode.window.activeTerminal = f.other;
  await f.dictateTerminal(); await running;
  assert.equal(f.stops, 1); assert.deepEqual(f.calls, ['parakeet']);
  assert.deepEqual(f.terminal.sent, [['\x1b[200~ hello\x1b[201~', false]]);
  assert.deepEqual(f.other.sent, []);
});

test('closing the target cancels dictation and discards late transcripts', async () => {
  const f = fixture(), running = f.dictateTerminal();
  await new Promise(setImmediate);
  f.close(); f.events.text('late transcript'); await running;
  assert.equal(f.cancels, 1); assert.deepEqual(f.terminal.sent, []); assert.equal(f.status.disposed, true);
});

test('closing the target during settings loading never starts the microphone', async () => {
  let loaded;
  const f = fixture('parakeet', { selection: () => new Promise(resolve => { loaded = resolve; }) });
  const running = f.dictateTerminal();
  f.close(); loaded({ provider: 'parakeet' }); await running;
  assert.deepEqual(f.calls, []); assert.deepEqual(f.terminal.sent, []);
});

test('late settings failure from a closed board leaves its replacement recording', async t => {
  let rejectSettings;
  const f = fixture('parakeet', { selection: () => rejectSettings ? { provider: 'parakeet' }
    : new Promise((_, reject) => { rejectSettings = reject; }) });
  const targets = surfaces(f, t), first = targets.editor.toggle();
  targets.editor.close();
  const next = targets.sidebar.toggle();
  await new Promise(setImmediate);
  rejectSettings(new Error('stale settings failure')); await first;
  await targets.sidebar.toggle(); await next;
  assert.deepEqual(f.calls, ['parakeet']);
  assert.deepEqual(targets.editor.text(), []);
  assert.deepEqual(targets.sidebar.text(), ['hello']);
});

test('missing terminal or invalid speech settings fails before recording', async () => {
  const f = fixture(); f.vscode.window.activeTerminal = undefined;
  await assert.rejects(f.dictateTerminal(), /Focus a running terminal/); assert.deepEqual(f.calls, []);
  const broken = fixture('parakeet', { selection: async () => { throw new Error('Choose a Parakeet model'); } });
  await assert.rejects(broken.dictateTerminal(), /Choose a Parakeet model/);
  assert.deepEqual(broken.calls, []); assert.equal(broken.status.disposed, true);
});

test('F8 stays in VS Code while focused in a terminal and preserves other skip-shell commands', async () => {
  const f = fixture();
  f.config.skipped.push('-entomatical.dictateTerminal');
  await f.enableTerminalDictationShortcut(); await f.enableTerminalDictationShortcut();
  assert.deepEqual(f.updates, [{ key: 'commandsToSkipShell', value: ['workbench.action.toggleSidebarVisibility', 'entomatical.dictateTerminal'], scope: 1 }]);
  const bindings = require('../package.json').contributes.keybindings;
  assert.deepEqual(bindings.find(b => b.command === 'entomatical.dictateTerminal'), { key: 'f8', command: 'entomatical.dictateTerminal', when: 'terminalFocus' });
});
