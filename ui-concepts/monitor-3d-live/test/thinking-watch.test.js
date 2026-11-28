// The selected session's thinking, on the host: lib/thinking-watch.js alone (every dependency faked, a manual
// clock), and through lib/view.js against a stand-in for `vscode`. The privacy tests write an invented transcript
// to a temporary file and read it with the real lib/thinking.js. Every id, text and path here is invented.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkThinking, createWatch, EVERY_MS, FIRST_MS, SLOW_TICKS, STATES } = require('../lib/thinking-watch.js');
const { MonitorView } = require('../lib/view.js');
const thinkingModule = require('../lib/thinking.js');

const SID = '11111111-2222-4333-8444-555555555555';
const OTHER = '66666666-7777-4888-9999-000000000000';
const THIRD = '22222222-3333-4444-8555-666666666666';
const ID = 'a:claude:' + SID, ID2 = 'a:claude:' + OTHER, ID3 = 'a:claude:' + THIRD;
const T1 = '2026-01-02T03:00:01.000Z', T2 = '2026-01-02T03:00:02.000Z', T3 = '2026-01-02T03:00:03.000Z';
const SLOW_MS = EVERY_MS * SLOW_TICKS;

const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wytw-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
async function until(check, ms = 4000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** A clock the test moves by hand. `schedule` returns a function that cancels, as lib/hub-core.js's does. */
function manualClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  const clock = {
    schedule(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn, ms }); return () => { timers.delete(id); }; },
    pending: () => timers.size,
    delays: () => [...timers.values()].map(x => x.ms),
    /** Move on by `ms` and run what fell due, in order. Returns how many ran. */
    advance(ms) {
      now += ms;
      const due = [...timers.entries()].filter(([, x]) => x.at <= now).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      for (const [id, x] of due) { timers.delete(id); x.fn(); }
      return due.length;
    },
    /** Move on to the next timer, however far it is, and run it. */
    next() {
      if (!timers.size) return 0;
      return clock.advance(Math.min(...[...timers.values()].map(x => x.at)) - now);
    }
  };
  return clock;
}
/** A promise the test settles when it chooses. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}

/* ---------- an invented transcript ---------- */

let uid = 0;
const sig = () => 'c2lnbmF0dXJl' + String(++uid).padStart(6, '0');
const line = value => JSON.stringify(value) + '\n';
const reply = (content, at = T1) => line({ type: 'assistant', isSidechain: false, uuid: 'a-' + (++uid), timestamp: at, sessionId: SID, cwd: '/home/example/proj',
  message: { id: 'msg_' + (++uid), role: 'assistant', model: 'example-model', content } });
const thought = text => ({ type: 'thinking', thinking: text, signature: sig() });
const blank = () => ({ type: 'thinking', thinking: '', signature: sig() });
const prompt = text => line({ type: 'user', isSidechain: false, uuid: 'u-' + (++uid), timestamp: T1, sessionId: SID, message: { role: 'user', content: text } });

/* ---------- the parts of `vscode` the view touches, copied from test/host.test.js ---------- */

function fakeVscode() {
  const calls = [], status = [], panels = [];
  const uri = value => ({ value, fsPath: value, toString: () => value });
  // Since 0.1.6 the monitor opens as a tab and is moved to a floating window: the two tab groups stand for that.
  class TabInputWebview { constructor(viewType) { this.viewType = viewType; } }
  const main = { viewColumn: 1, tabs: [] }, floating = { viewColumn: 2, tabs: [] };
  const tabGroups = { activeTabGroup: main, all: [main, floating] };
  const vscode = {
    calls, panels, status, TabInputWebview,
    Uri: { joinPath: (base, ...parts) => uri([base.value, ...parts].join('/')), file: p => uri('file:' + p), parse: text => uri(text) },
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    window: {
      tabGroups,
      activeColorTheme: { kind: 2 },
      createWebviewPanel(type, title, column, options) {
        const panel = {
          type, title, options, visible: true, revealed: 0, posted: [], handlers: {},
          webview: {
            options: undefined, html: '',
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
      showQuickPick: async items => { calls.push(['showQuickPick', items]); },
      showWarningMessage: async (...args) => { calls.push(['showWarningMessage', ...args]); },
      showInformationMessage: async (...args) => { calls.push(['showInformationMessage', ...args]); },
      showErrorMessage: async (...args) => { calls.push(['showErrorMessage', ...args]); },
      setStatusBarMessage: (text, hide) => { status.push(text); calls.push(['setStatusBarMessage', text]); return { dispose() {} }; }
    },
    commands: {
      executeCommand: async (...args) => {
        // The view's own move of the monitor into its floating window is not something a test of thinking counts.
        if (args[0] === 'workbench.action.moveEditorToNewWindow') {
          floating.tabs = main.tabs; floating.activeTab = main.activeTab;
          main.tabs = []; main.activeTab = undefined; tabGroups.activeTabGroup = floating;
        } else calls.push(['executeCommand', ...args]);
      },
      getCommands: async () => { calls.push(['getCommands']); return []; }
    },
    env: { openExternal: async u => { calls.push(['openExternal', u.value]); return true; } }
  };
  return vscode;
}
function fakeContext(t) {
  const dir = temp(t);
  fs.mkdirSync(path.join(dir, 'media'));
  fs.writeFileSync(path.join(dir, 'media', 'page.html'), '<meta http-equiv="Content-Security-Policy" content="{{csp}}"><script nonce="{{nonce}}" src="{{base}}/a.js"></script>');
  const state = new Map();
  const updates = [];
  return { extensionPath: dir, extensionUri: { value: 'ext' }, state, updates,
    workspaceState: { get: key => state.get(key), update: async (key, value) => { updates.push([key, value]); state.set(key, value); } },
    globalState: { get: key => state.get('global:' + key), update: async (key, value) => { updates.push(['global', key, value]); state.set('global:' + key, value); } } };
}
/** The hub client: every argument it is given is kept in `given`. */
function fakeClient(answer) {
  const client = {
    role: 'hub', given: [], updates: [], asked: [],
    update(change) { client.given.push(['update', change]); client.updates.push(change); },
    resolve: async target => { client.given.push(['resolve', target]); client.asked.push(target); return client.answer(target); },
    answer: answer || (() => ({ kind: 'session', agent: 'claude', session: SID, cwd: '/home/example/proj', root: null, pid: 4242 }))
  };
  return client;
}
const entryFor = file => ({ agent: 'claude', session: SID, key: 'claude:' + SID, cwd: '/home/example/proj', pid: 4242, configDir: '/home/example/.claude', transcript: file });
function makeView(t, { session, vscode = fakeVscode(), context = fakeContext(t), client = fakeClient(), clock = manualClock(), logs = [] } = {}) {
  const collectors = { claude: { state: 'missing', folders: 1, installed: 0 } };
  const view = new MonitorView(vscode, context, { client, folders: () => [{ path: '/home/example/proj', name: 'proj' }], collectors: () => collectors,
    log: m => logs.push(m), session, schedule: clock.schedule });
  return { vscode, context, client, clock, logs, view };
}
const say = (panel, message) => panel.handlers.message(message);
const start = (panel, id = ID) => say(panel, { v: 1, type: 'thinking', target: { class: 'agent', id } });
const thinkingPosts = panel => panel.posted.filter(m => m.type === 'thinking');
/** A view with its panel open and ready, on a transcript written now. */
function openView(t, text, options = {}) {
  const file = path.join(temp(t), SID + '.jsonl');
  if (text !== undefined) fs.writeFileSync(file, text);
  const made = makeView(t, { session: id => (id === SID ? entryFor(file) : null), ...options });
  made.view.show();
  const panel = made.vscode.panels[made.vscode.panels.length - 1];
  say(panel, { v: 1, type: 'ready' });
  return { ...made, panel, file };
}
/** The page asks, and the first look (FIRST_MS later) has finished. */
async function startAndLook(made, id = ID) {
  start(made.panel, id);
  assert.deepEqual(made.clock.delays(), [FIRST_MS], 'the first look waits ' + FIRST_MS + ' ms');
  made.clock.advance(FIRST_MS);
  await until(() => made.clock.pending() === 1);
}

/* ---------- the watch alone, on fakes ---------- */

const TRANSCRIPT = '/home/example/.claude/projects/-home-example-proj/' + SID + '.jsonl';
const SESSION = { kind: 'session', agent: 'claude', session: SID };
const ENTRY = { transcript: TRANSCRIPT };
const enoent = () => { const e = new Error('invented'); e.code = 'ENOENT'; return e; };
/** The `n`th of a list (the last repeats): a value, an Error to throw, or a function to call. */
function pick(list, n) {
  if (!list.length) return undefined;
  const x = list[Math.min(n, list.length - 1)];
  if (x instanceof Error) throw x;
  return typeof x === 'function' ? x() : x;
}
/** A watch on fakes. `hub`, `sessions`, `answers` and `stats` give one answer per call, in order. */
function fakeWatch({ hub = [SESSION], sessions = [ENTRY], answers = [], stats = [] } = {}) {
  const clock = manualClock(), posts = [], seen = { resolve: [], session: [], read: [], stat: [] };
  const watch = createWatch({
    resolve: async target => { seen.resolve.push(target); return pick(hub, seen.resolve.length - 1); },
    session: id => { seen.session.push(id); return pick(sessions, seen.session.length - 1); },
    read: async file => { seen.read.push(file); return pick(answers, seen.read.length - 1); },
    stat: async file => { seen.stat.push(file); return pick(stats, seen.stat.length - 1); },
    post: m => posts.push(m), schedule: clock.schedule
  });
  return {
    watch, clock, posts, seen,
    states: () => posts.map(m => m.state),
    /** watch(id), and its first look. */
    async begin(id = ID) { watch.watch(id); clock.advance(FIRST_MS); await settle(); },
    /** The next look, however far away it is. */
    async look() { clock.next(); await settle(); }
  };
}
const answer = (thoughts, extra = {}) => ({ ok: true, size: 100, mtimeMs: 5000, whole: true, thoughts, recorded: thoughts.length, unrecorded: 0, more: 0, ...extra });
const one = (text, extra) => answer([{ at: 1, text }], extra);
const zero = { thoughts: [], recorded: 0, unrecorded: 0, more: 0, whole: true };

test('checkThinking: null stops, an agent id starts, and only exactly that shape is taken; the timings and states', () => {
  assert.deepEqual(checkThinking({ v: 1, type: 'thinking', target: null }), { target: null });
  assert.deepEqual(checkThinking({ v: 1, type: 'thinking', target: { class: 'agent', id: ID } }), { target: { class: 'agent', id: ID } });
  assert.deepEqual(checkThinking({ target: { id: 'a:codex:s-1a2b', class: 'agent' } }), { target: { class: 'agent', id: 'a:codex:s-1a2b' } }, 'key order does not matter');
  assert.deepEqual([EVERY_MS, FIRST_MS, SLOW_TICKS], [3000, 200, 5]);
  assert.deepEqual(STATES, ['recorded', 'unrecorded', 'none', 'not-yet', 'ended', 'gone', 'unreadable']);
});

test('1. a request for a live session posts one "recorded" message to that panel, newest first, with the counts; resolve is asked with the id only, 200 ms later', async t => {
  const made = openView(t,
    prompt('An invented question.') + reply([thought('First invented thought.')], T1) + reply([thought('Second invented thought.')], T2) +
    reply([blank()], T2) + reply([thought('Third invented thought, the newest.')], T3));
  const { panel, client, clock, view } = made;
  panel.posted.length = 0;
  start(panel);
  assert.deepEqual(client.asked, [], 'nothing is asked before the first look');
  clock.advance(FIRST_MS - 1);
  assert.deepEqual(client.asked, []);
  clock.advance(1);
  await until(() => thinkingPosts(panel).length > 0);
  await until(() => clock.pending() === 1);
  assert.deepEqual(panel.posted, [{
    v: 1, type: 'thinking', id: ID, state: 'recorded',
    thoughts: [
      { at: Date.parse(T3), text: 'Third invented thought, the newest.' },
      { at: Date.parse(T2), text: 'Second invented thought.' },
      { at: Date.parse(T1), text: 'First invented thought.' }
    ],
    recorded: 3, unrecorded: 1, more: 0, whole: true
  }]);
  assert.deepEqual(client.asked, [{ id: ID }], 'the hub is asked with the id alone');
  assert.deepEqual(Object.keys(client.asked[0]), ['id']);
  assert.deepEqual(clock.delays(), [EVERY_MS], 'the next look is in 3 s');
  assert.equal(view.thinking.current(), ID);
  // The real file, unchanged: the next tick posts nothing.
  clock.advance(EVERY_MS);
  await until(() => clock.pending() === 1);
  assert.equal(thinkingPosts(panel).length, 1, 'an unchanged transcript posts nothing');
  view.thinking.stop();
});

test('2. a tick with the file unchanged reads nothing and posts nothing; once it changed, one read and one post', async () => {
  const sizes = [{ size: 100, mtimeMs: 5000 }];
  const w = fakeWatch({ answers: [one('Invented one.'), answer([{ at: 2, text: 'Invented two.' }, { at: 1, text: 'Invented one.' }], { size: 180, mtimeMs: 6000 })], stats: [() => sizes[0]] });
  await w.begin();
  assert.equal(w.seen.read.length, 1);
  assert.equal(w.posts.length, 1);
  for (let i = 0; i < 3; i++) await w.look();
  assert.equal(w.seen.stat.length, 3, 'one stat a tick');
  assert.equal(w.seen.read.length, 1, 'no read while size and time are the same');
  assert.equal(w.posts.length, 1, 'and no post');
  sizes[0] = { size: 180, mtimeMs: 6000 };
  await w.look();
  assert.equal(w.seen.read.length, 2);
  assert.equal(w.posts.length, 2);
  assert.deepEqual(w.posts[1].thoughts.map(x => x.text), ['Invented two.', 'Invented one.']);
  await w.look();
  assert.equal(w.seen.read.length, 2, 'the new size and time are remembered');
  assert.equal(w.posts.length, 2);
  assert.equal(w.seen.session.length, 1, 'the session lookup reads files, so it is done once');
  assert.equal(w.seen.resolve.length, 1, 'and so is the hub request');
  w.watch.stop();
});

test('3. looks never overlap; one read at a time per view; a slow answer for an earlier selection is never posted', async () => {
  // A first read that is slow: the clock passes many ticks, and no second look begins.
  const slow = deferred();
  const w = fakeWatch({ answers: [() => slow.promise, one('Invented.')] });
  await w.begin();
  assert.equal(w.seen.read.length, 1);
  assert.equal(w.clock.pending(), 0, 'no next look while a read is pending');
  w.clock.advance(EVERY_MS * 10);
  await settle();
  assert.equal(w.seen.read.length, 1);
  slow.resolve(one('Invented, slow.'));
  await settle();
  assert.equal(w.posts.length, 1);
  assert.equal(w.clock.pending(), 1, 'the next look is scheduled only now');
  w.watch.stop();

  // A's read is still on the disk when B is watched: B's read starts only once A's settled; B's answer is posted, A's is not.
  const slowA = deferred();
  const v = fakeWatch({ answers: [() => slowA.promise, one('For B.')] });
  await v.begin(ID);
  assert.equal(v.seen.read.length, 1);
  await v.begin(ID2);
  assert.equal(v.seen.resolve.length, 2, 'B asked the hub');
  assert.equal(v.seen.read.length, 1, 'but B waits for A\'s read: one read on the disk');
  slowA.resolve(one('Late, for A.'));
  await settle();
  assert.equal(v.seen.read.length, 2, 'B reads once A\'s read has settled');
  assert.deepEqual(v.posts.map(m => [m.id, m.thoughts[0].text]), [[ID2, 'For B.']], 'A\'s late answer was dropped');
  assert.equal(v.clock.pending(), 1, 'one timer: B\'s');
  v.watch.stop();

  // A's read is on the disk; B and then C are watched: when A's read settles, one read starts, for C.
  const slowFirst = deferred();
  const u = fakeWatch({ answers: [() => slowFirst.promise, one('For C.')] });
  await u.begin(ID);
  await u.begin(ID2);
  await u.begin(ID3);
  assert.equal(u.seen.read.length, 1);
  slowFirst.resolve(one('Late, for A.'));
  await settle();
  assert.equal(u.seen.read.length, 2, 'one more read, not two');
  assert.deepEqual(u.posts.map(m => m.id), [ID3]);
  u.watch.stop();

  // A stop while a read is pending: nothing is posted, and nothing is scheduled after it.
  const after = deferred();
  const s = fakeWatch({ answers: [() => after.promise] });
  await s.begin();
  s.watch.stop();
  after.resolve(one('After the stop.'));
  await settle();
  assert.deepEqual(s.posts, []);
  assert.equal(s.clock.pending(), 0);
  assert.equal(s.watch.current(), null);

  // The same while the hub's answer is pending.
  const hub = deferred();
  const h = fakeWatch({ hub: [() => hub.promise], answers: [one('x')] });
  await h.begin();
  h.watch.stop();
  hub.resolve(SESSION);
  await settle();
  assert.deepEqual(h.posts, []);
  assert.deepEqual(h.seen.session, [], 'no lookup after the stop');
  assert.equal(h.clock.pending(), 0);
});

test('3b. watch A, B, A within 200 ms asks once, for A; a stop within 200 ms asks nothing at all', async () => {
  const w = fakeWatch({ answers: [one('For A.')] });
  w.watch.watch(ID);
  w.clock.advance(80);
  w.watch.watch(ID2);
  w.clock.advance(80);
  w.watch.watch(ID);
  await settle();
  assert.deepEqual(w.seen.resolve, [], 'nothing asked yet');
  assert.equal(w.clock.pending(), 1, 'one timer, the last watch\'s');
  w.clock.advance(FIRST_MS);
  await settle();
  assert.deepEqual(w.seen.resolve, [{ id: ID }], 'exactly one hub request, for A');
  assert.equal(w.seen.read.length, 1, 'exactly one read');
  assert.deepEqual(w.posts.map(m => m.id), [ID]);
  w.watch.stop();

  const s = fakeWatch({ answers: [one('Never.')] });
  s.watch.watch(ID);
  s.clock.advance(FIRST_MS - 1);
  s.watch.stop();
  s.clock.advance(EVERY_MS * 10);
  await settle();
  assert.deepEqual([s.seen.resolve, s.seen.session, s.seen.read, s.posts], [[], [], [], []], 'no resolve at all');
  assert.equal(s.clock.pending(), 0);
});

test('4. target null, a hidden tab, a closed tab and a new "ready" each stop the watch, and leave no timer', async t => {
  const text = reply([thought('Invented thought.')]);
  let made = openView(t, text);
  await startAndLook(made);
  assert.equal(made.view.thinking.current(), ID);
  say(made.panel, { v: 1, type: 'thinking', target: null });
  assert.equal(made.view.thinking.current(), null, 'target null');
  assert.equal(made.clock.pending(), 0);

  await startAndLook(made);
  made.panel.visible = false;
  made.panel.handlers.state();
  assert.equal(made.view.thinking.current(), null, 'a hidden tab');
  assert.equal(made.clock.pending(), 0);

  made = openView(t, text);
  await startAndLook(made);
  made.panel.handlers.dispose();
  assert.equal(made.view.thinking.current(), null, 'a closed tab');
  assert.equal(made.clock.pending(), 0);

  made = openView(t, text);
  await startAndLook(made);
  say(made.panel, { v: 1, type: 'ready' });
  assert.equal(made.view.thinking.current(), null, 'a page that loaded again');
  assert.equal(made.clock.pending(), 0);

  // Stopped within the first 200 ms: nothing is asked.
  made = openView(t, text);
  start(made.panel);
  say(made.panel, { v: 1, type: 'thinking', target: null });
  made.clock.advance(EVERY_MS);
  await settle();
  assert.deepEqual(made.client.asked, []);
  assert.equal(made.clock.pending(), 0);

  // Stopped while its read is on the disk: when that read ends, nothing is posted and nothing scheduled.
  made = openView(t, text);
  start(made.panel);
  made.clock.advance(FIRST_MS);
  say(made.panel, { v: 1, type: 'thinking', target: null });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(made.clock.pending(), 0);
  assert.equal(thinkingPosts(made.panel).length, 0);

  // A request from a page that has not said "ready" starts nothing: its answers could not be posted.
  made = makeView(t, { session: () => entryFor('/home/example/x.jsonl') });
  made.view.show();
  start(made.vscode.panels[0]);
  assert.equal(made.view.thinking.current(), null);
  assert.equal(made.clock.pending(), 0);
});

test('5a. the hub naming no session once says nothing; twice says "gone" once, keeps the watch, and looks every fifth tick until the hub answers', async () => {
  const none = { kind: 'none' };
  let w = fakeWatch({ hub: [none, SESSION], answers: [one('Invented.')] });
  await w.begin();
  assert.deepEqual(w.posts, [], 'one look that finds no session says nothing');
  assert.deepEqual(w.clock.delays(), [EVERY_MS], 'and the next look is one tick away');
  await w.look();
  assert.deepEqual(w.states(), ['recorded'], 'no "gone" was ever posted');
  w.watch.stop();

  w = fakeWatch({ hub: [none, none, none, none, SESSION], answers: [one('Invented, once the hub is back.')] });
  await w.begin();
  await w.look();
  assert.deepEqual(w.posts, [{ type: 'thinking', id: ID, state: 'gone', ...zero }], 'two looks agree: "gone", once');
  assert.equal(w.watch.current(), ID, 'the watch goes on');
  assert.deepEqual(w.clock.delays(), [SLOW_MS], 'now a look every fifth tick');
  await w.look();
  assert.deepEqual(w.clock.delays(), [SLOW_MS]);
  await w.look();
  assert.deepEqual(w.states(), ['gone'], 'said once, not again');
  assert.deepEqual(w.clock.delays(), [SLOW_MS]);
  assert.equal(w.seen.resolve.length, 4);
  await w.look();
  assert.deepEqual(w.states(), ['gone', 'recorded'], 'the hub answered: the thinking, at once');
  assert.deepEqual(w.clock.delays(), [EVERY_MS], 'and a look every tick again');
  w.watch.stop();

  // Other answers that name no session: two looks each, then "gone".
  for (const found of [{ kind: 'file' }, { kind: 'session', agent: 'claude', session: '../x' }, { kind: 'session', agent: 'claude' }]) {
    w = fakeWatch({ hub: [found] });
    await w.begin();
    assert.deepEqual(w.posts, [], JSON.stringify(found) + ': one look');
    await w.look();
    assert.deepEqual(w.states(), ['gone'], JSON.stringify(found));
    assert.deepEqual([w.seen.session.length, w.seen.read.length], [0, 0], 'nothing is looked up for it');
    w.watch.stop();
  }

  // A hub request that rejects tells nothing: it neither says nor confirms anything.
  w = fakeWatch({ hub: [none, new Error('invented'), none, SESSION], answers: [one('x')] });
  await w.begin();
  await w.look();
  await w.look();
  assert.deepEqual(w.posts, [], 'none, no answer, none: never two agreeing looks in a row');
  await w.look();
  assert.deepEqual(w.states(), ['recorded']);
  w.watch.stop();
});

test('5b. no session file once says nothing; twice says "ended" once and keeps the watch; when the file is back, the thinking', async () => {
  let w = fakeWatch({ sessions: [null, ENTRY], answers: [one('Invented.')] });
  await w.begin();
  assert.deepEqual(w.posts, [], 'a session file caught half-written, once: nothing');
  await w.look();
  assert.deepEqual(w.states(), ['recorded'], 'no "ended" was ever posted');
  w.watch.stop();

  w = fakeWatch({ sessions: [null, null, null, ENTRY], answers: [one('Invented.')] });
  await w.begin();
  await w.look();
  assert.deepEqual(w.posts, [{ type: 'thinking', id: ID, state: 'ended', ...zero }]);
  assert.equal(w.watch.current(), ID, 'the watch goes on');
  assert.deepEqual(w.clock.delays(), [SLOW_MS], 'a look every fifth tick');
  await w.look();
  assert.deepEqual(w.states(), ['ended']);
  await w.look();
  assert.deepEqual(w.states(), ['ended', 'recorded']);
  assert.deepEqual(w.clock.delays(), [EVERY_MS]);
  assert.equal(w.seen.read.length, 1, 'the transcript was read only once it was known');
  w.watch.stop();

  // "gone" said, then the session file is missing: "ended" also needs two looks, every fifth tick.
  w = fakeWatch({ hub: [{ kind: 'none' }, { kind: 'none' }, SESSION], sessions: [null] });
  await w.begin();
  await w.look();
  await w.look();
  assert.deepEqual(w.states(), ['gone']);
  assert.deepEqual(w.clock.delays(), [SLOW_MS], 'not a success: still every fifth tick');
  await w.look();
  assert.deepEqual(w.states(), ['gone', 'ended']);
  w.watch.stop();
});

test('5c. thoughts already shown are withdrawn only when two looks agree; at the start a negative is said at once', async () => {
  // recorded, then the file is missing for one look, then back as it was: nothing withdrawn, no "not-yet".
  let w = fakeWatch({ answers: [one('Shown.')], stats: [enoent(), { size: 100, mtimeMs: 5000 }] });
  await w.begin();
  await w.look();
  await w.look();
  assert.deepEqual(w.states(), ['recorded']);
  assert.equal(w.seen.read.length, 1);
  w.watch.stop();

  // recorded, the reader says missing for one look, then recorded again.
  w = fakeWatch({ answers: [one('Shown.'), { ok: false, why: 'missing' }, one('Shown, and more.', { size: 200, mtimeMs: 7000 })], stats: [{ size: 200, mtimeMs: 6000 }, { size: 200, mtimeMs: 7000 }] });
  await w.begin();
  await w.look();
  assert.deepEqual(w.states(), ['recorded'], 'one look of "missing" withdraws nothing');
  await w.look();
  assert.deepEqual(w.states(), ['recorded', 'recorded'], 'no "not-yet" between them');
  w.watch.stop();

  // recorded (2), then none (0) on two looks: "none". The second look agrees without a second read: the file did not change.
  w = fakeWatch({ answers: [answer([{ at: 2, text: 'Two.' }, { at: 1, text: 'One.' }]), answer([], { size: 40, mtimeMs: 6000 })], stats: [{ size: 40, mtimeMs: 6000 }] });
  await w.begin();
  await w.look();
  assert.deepEqual(w.states(), ['recorded'], 'one look of "none" withdraws nothing');
  await w.look();
  assert.deepEqual(w.states(), ['recorded', 'none']);
  assert.deepEqual(w.posts[1], { type: 'thinking', id: ID, state: 'none', ...zero });
  assert.equal(w.seen.read.length, 2);
  w.watch.stop();

  // recorded, then "unrecorded" on one look, then the thoughts again: nothing withdrawn.
  w = fakeWatch({ answers: [one('Shown.'), answer([], { unrecorded: 3, size: 1, mtimeMs: 1 }), one('Shown.', { size: 2, mtimeMs: 2 })], stats: [{ size: 1, mtimeMs: 1 }, { size: 2, mtimeMs: 2 }] });
  await w.begin();
  await w.look();
  await w.look();
  assert.deepEqual(w.states(), ['recorded', 'recorded']);
  w.watch.stop();

  // recorded, then not-yet on two looks: "not-yet".
  w = fakeWatch({ answers: [one('Shown.')], stats: [enoent()] });
  await w.begin();
  await w.look();
  await w.look();
  assert.deepEqual(w.states(), ['recorded', 'not-yet']);
  w.watch.stop();

  // At the start, with nothing shown: "not-yet", "none" and "unrecorded" are said at once.
  w = fakeWatch({ answers: [{ ok: false, why: 'missing' }, one('Written at last.')], stats: [enoent(), enoent(), { size: 100, mtimeMs: 5000 }] });
  await w.begin();
  assert.deepEqual(w.posts, [{ type: 'thinking', id: ID, state: 'not-yet', ...zero }]);
  await w.look();
  await w.look();
  assert.deepEqual(w.states(), ['not-yet'], 'not said again while the file is still missing');
  assert.equal(w.seen.read.length, 1, 'and not read again');
  await w.look();
  assert.deepEqual(w.states(), ['not-yet', 'recorded']);
  w.watch.stop();
  w = fakeWatch({ answers: [answer([], { recorded: 0, unrecorded: 4 })] });
  await w.begin();
  assert.deepEqual(w.posts, [{ type: 'thinking', id: ID, state: 'unrecorded', thoughts: [], recorded: 0, unrecorded: 4, more: 0, whole: true }]);
  w.watch.stop();
  w = fakeWatch({ answers: [answer([], { whole: false })] });
  await w.begin();
  assert.deepEqual(w.posts, [{ type: 'thinking', id: ID, state: 'none', thoughts: [], recorded: 0, unrecorded: 0, more: 0, whole: false }], '"none" of the end only: whole is false');
  w.watch.stop();
});

test('5d. a first read that fails twice says "unreadable"; once says nothing; after something was said, failed reads post nothing', async () => {
  const unreadable = { ok: false, why: 'unreadable' };
  let w = fakeWatch({ answers: [unreadable, unreadable, one('Readable now.')], stats: [{ size: 1, mtimeMs: 1 }] });
  await w.begin();
  assert.deepEqual(w.posts, [], 'one failed read: nothing');
  await w.look();
  assert.deepEqual(w.posts, [{ type: 'thinking', id: ID, state: 'unreadable', ...zero }], 'two: "unreadable"');
  assert.deepEqual(w.clock.delays(), [EVERY_MS], 'tried again every tick');
  await w.look();
  assert.deepEqual(w.states(), ['unreadable', 'recorded'], 'read again although the size and time did not change');
  w.watch.stop();

  // "not a file" and a read that rejects are failures too.
  w = fakeWatch({ answers: [{ ok: false, why: 'not-a-file' }, new Error('invented')], stats: [{ size: 1, mtimeMs: 1 }] });
  await w.begin();
  await w.look();
  assert.deepEqual(w.states(), ['unreadable']);
  w.watch.stop();

  w = fakeWatch({ answers: [unreadable, one('Readable now.')], stats: [{ size: 1, mtimeMs: 1 }] });
  await w.begin();
  await w.look();
  assert.deepEqual(w.states(), ['recorded'], 'one failure, then a good read: no "unreadable"');
  w.watch.stop();

  // Something was said: a failed read, once or many times, posts nothing; the next tick reads again.
  for (const shown of [one('Shown.'), answer([])]) {
    w = fakeWatch({ answers: [shown, unreadable, unreadable, unreadable, one('Shown, and more.')], stats: [{ size: 100, mtimeMs: 6000 }] });
    await w.begin();
    for (let i = 0; i < 3; i++) await w.look();
    assert.equal(w.posts.length, 1, shown.thoughts.length ? 'after thoughts' : 'after "none"');
    assert.equal(w.seen.read.length, 4, 'each tick read again');
    await w.look();
    assert.deepEqual(w.states(), [shown.thoughts.length ? 'recorded' : 'none', 'recorded']);
    w.watch.stop();
  }
});

test('5e. another provider\'s session: nothing is posted, nothing is looked up, and no timer is left', async () => {
  for (const agent of ['codex', 'grok', undefined]) {
    const w = fakeWatch({ hub: [{ kind: 'session', agent, session: SID }], answers: [one('Never.')] });
    await w.begin();
    assert.deepEqual(w.posts, [], String(agent));
    assert.equal(w.watch.current(), null, 'the watch ended');
    assert.equal(w.clock.pending(), 0);
    assert.deepEqual([w.seen.session.length, w.seen.read.length], [0, 0]);
  }
});

test('5f. only the answer\'s own fields are passed on, each of the kind it must be', async () => {
  const w = fakeWatch({ answers: [{ ok: true, size: 1, mtimeMs: 2, whole: 'yes', path: '/home/example/x', thoughts: [{ at: 1e300, text: 'Kept.', cut: true, path: '/x' }, { text: 42 }, null, { at: 'noon', text: 'Also kept.' }], recorded: -3, unrecorded: 1.5, more: 2 ** 60 }] });
  await w.begin();
  assert.deepEqual(w.posts, [{ type: 'thinking', id: ID, state: 'recorded', thoughts: [{ at: null, text: 'Kept.' }, { at: null, text: 'Also kept.' }], recorded: 0, unrecorded: 0, more: 0, whole: false }]);
  w.watch.stop();
});

test('a transcript path that is on another machine, relative or too long is "not-yet" at once, ends the watch, and is never stat-ed or read', async () => {
  for (const transcript of ['\\\\server\\share\\projects\\-home-example-proj\\' + SID + '.jsonl', '//server/share/projects/' + SID + '.jsonl', '\\\\?\\UNC\\server\\share\\x.jsonl',
    'projects/-home-example-proj/' + SID + '.jsonl', '', '/home/example/' + 'x'.repeat(4100) + '.jsonl', '/home/example/a\u0000.jsonl', 42, null, undefined, { path: '/home/example/x.jsonl' }]) {
    const w = fakeWatch({ sessions: [{ transcript }], answers: [one('Never read.')], stats: [{ size: 1, mtimeMs: 1 }] });
    await w.begin();
    w.clock.advance(EVERY_MS * 30); await settle();
    const what = JSON.stringify(transcript);
    assert.deepEqual(w.states(), ['not-yet'], what);
    assert.deepEqual(w.seen.stat, [], what + ': no stat');
    assert.deepEqual(w.seen.read, [], what + ': no read');
    assert.equal(w.watch.current(), null, what + ': the watch ended');
    assert.equal(w.clock.pending(), 0);
  }
});

test('6. a malformed request posts nothing, throws nothing, and starts no watch', async t => {
  const made = openView(t, reply([thought('Invented.')]));
  const { panel, client, clock, view, logs, vscode } = made;
  panel.posted.length = 0;
  const bad = [
    { target: { class: 'tool', id: ID } },
    { target: { class: 'subagent', id: ID } },
    { target: { class: 'agent', id: 'a:claude:../../home/example/x.jsonl' } },
    { target: { class: 'agent', id: 'a:claude:C:\\Users\\example\\x.jsonl' } },
    { target: { class: 'agent', id: 'a:claude:/home/example/x.jsonl' } },
    { target: { class: 'agent', id: ID + ':file:./' } },
    { target: { class: 'agent', id: 'a:claude:' + SID + ':' } },
    { target: { class: 'agent', id: 'a:claude:' + 'x'.repeat(129) } },
    { target: { class: 'agent', id: 'a:' + 'z'.repeat(70) + ':' + 'x'.repeat(128) } },      // 201 characters, each part of the right shape
    { target: { class: 'agent', id: 'r:claude:' + SID } },
    { target: { class: 'agent', id: 'a:Claude:' + SID } },
    { target: { class: 'agent', id: 'a:claude:' } },
    { target: { class: 'agent', id: ID + '\n' } },
    { target: { class: 'agent', id: '' } },
    { target: { class: 'agent' } },
    { target: { id: ID } },
    { target: ID },
    { target: [{ class: 'agent', id: ID }] },
    { target: { target: { class: 'agent', id: ID } } },
    { target: { class: 'agent', id: { id: ID } } },
    { target: { class: 'agent', id: [ID] } },
    { target: { class: 'agent', id: ID, path: '/home/example/x.jsonl' } },
    { target: undefined },
    {},
    { target: 42 },
    { target: true }
  ];
  assert.equal(('a:' + 'z'.repeat(70) + ':' + 'x'.repeat(128)).length, 201);
  assert.deepEqual(checkThinking({ target: { class: 'agent', id: 'a:' + 'z'.repeat(69) + ':' + 'x'.repeat(128) } }).target.id.length, 200, 'exactly 200 is taken');
  for (const message of bad) {
    assert.equal(checkThinking(message), undefined, JSON.stringify(message));
    assert.doesNotThrow(() => view.fromPage({ v: 1, type: 'thinking', ...message }));
    assert.equal(view.thinking.current(), null, JSON.stringify(message));
  }
  // A getter that throws, and a message with no version, are refused too.
  const trap = { v: 1, type: 'thinking', get target() { throw new Error('invented'); } };
  assert.equal(checkThinking(trap), undefined);
  assert.doesNotThrow(() => view.fromPage(trap));
  view.fromPage({ type: 'thinking', target: { class: 'agent', id: ID } });
  assert.equal(view.thinking.current(), null, 'no version, no request');
  clock.advance(EVERY_MS);
  await settle();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(panel.posted, []);
  assert.deepEqual(client.asked, [], 'the hub is not asked');
  assert.equal(clock.pending(), 0);
  assert.deepEqual(logs, []);
  assert.deepEqual(vscode.calls, []);

  // A malformed message does not stop a watch that runs.
  await startAndLook(made);
  view.fromPage({ v: 1, type: 'thinking', target: 'stop' });
  assert.equal(view.thinking.current(), ID);
  view.thinking.stop();
});

/* ---------- privacy ---------- */

const CANARY = {
  thinking: 'CANARY-THINKING-7f3a2c', later: 'CANARY-THINKING-LATER-0b1d', prompt: 'CANARY-PROMPT-91c2e4', answer: 'CANARY-ANSWER-5d8e17',
  input: 'CANARY-TOOL-INPUT-26b4f0', command: 'CANARY-COMMAND-3a9d55', result: 'CANARY-RESULT-c7e2a8', signature: 'Q0FOQVJZLVNJR05BVFVSRS03Nzc'
};
/** Every console method and every unhandled rejection, for the length of one test. */
function watchConsole(t) {
  const lines = [], names = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  const real = Object.fromEntries(names.map(n => [n, console[n]]));
  for (const n of names) console[n] = (...args) => { lines.push([n, ...args.map(a => (a instanceof Error ? a.stack : String(a)))].join(' ')); };
  const rejections = [];
  const onRejection = reason => rejections.push(String(reason && reason.stack || reason));
  process.on('unhandledRejection', onRejection);
  t.after(() => { Object.assign(console, real); process.removeListener('unhandledRejection', onRejection); });
  return { lines, rejections };
}
const holds = (value, text) => JSON.stringify(value === undefined ? null : value).includes(text);

test('7. privacy: the thinking reaches the panel that asked and nothing else; the prompt, answer and tool input reach nothing', async t => {
  const seen = watchConsole(t);
  const dir = temp(t), file = path.join(dir, SID + '.jsonl');
  fs.writeFileSync(file,
    prompt(CANARY.prompt) +
    line({ type: 'assistant', isSidechain: false, timestamp: T1, sessionId: SID, message: { id: 'msg_P1', role: 'assistant', content: [
      { type: 'thinking', thinking: CANARY.thinking, signature: CANARY.signature },
      { type: 'text', text: CANARY.answer },
      { type: 'tool_use', id: 'toolu_P1', name: 'Bash', input: { command: CANARY.command, description: CANARY.input } }
    ] } }) +
    line({ type: 'user', isSidechain: false, timestamp: T2, sessionId: SID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_P1', content: CANARY.result }] } }));
  // Two views on the same fakes: two windows' worth of panels, one client, one context, one output channel.
  const vscode = fakeVscode(), context = fakeContext(t), client = fakeClient(), clock = manualClock(), logs = [];
  const session = id => (id === SID ? entryFor(file) : null);
  const one = makeView(t, { session, vscode, context, client, clock, logs });
  const two = makeView(t, { session, vscode, context, client, clock, logs });
  one.view.show(); two.view.show();
  const [panel, other] = vscode.panels;
  say(panel, { v: 1, type: 'ready' }); say(other, { v: 1, type: 'ready' });
  // Some ordinary traffic as well, so the hub client and the workspace state have something in them.
  say(panel, { v: 1, type: 'scope', scope: 'all' });
  one.view.setHubState('up');
  await startAndLook({ panel, clock });
  assert.equal(thinkingPosts(panel).length, 1);
  // A later thought is appended; a tick reads it.
  fs.appendFileSync(file, reply([thought(CANARY.later)], T3));
  clock.advance(EVERY_MS);
  await until(() => thinkingPosts(panel).length === 2);
  await until(() => clock.pending() === 1);
  // The tab is hidden, and comes back: the hub is told the scope, and the page asks again.
  panel.visible = false; panel.handlers.state(); panel.visible = true;
  say(panel, { v: 1, type: 'ready' });
  await startAndLook({ panel, clock });
  assert.equal(thinkingPosts(panel).length, 3);
  one.view.thinking.stop();

  const posts = thinkingPosts(panel);
  assert.deepEqual(posts[1].thoughts.map(x => x.text), [CANARY.later, CANARY.thinking], 'the panel that asked got the thinking');
  for (const m of posts) {
    assert.deepEqual(Object.keys(m), ['v', 'type', 'id', 'state', 'thoughts', 'recorded', 'unrecorded', 'more', 'whole'], 'no size, time, path or session in it');
    for (const x of m.thoughts) assert.deepEqual(Object.keys(x), ['at', 'text']);
  }
  for (const m of panel.posted) if (holds(m, CANARY.thinking)) assert.equal(m.type, 'thinking', 'only in a thinking message');
  // The id is the page's own node id, which names the session; nothing else of where the session lives goes back.
  for (const m of posts) assert.equal(m.id, ID);
  for (const where of [dir, file, path.basename(file), '/home/example/proj', '/home/example/.claude']) assert.ok(!holds(posts, where) && !holds(posts, JSON.stringify(where).slice(1, -1)), 'no path: ' + where);

  const sinks = {
    'the other panel': other.posted,
    'the hub client (every argument it was given)': client.given,
    'the output channel': logs,
    'vscode: notifications, status bar, commands': vscode.calls,
    'the status bar messages': vscode.status,
    'workspaceState and globalState': [...context.state.entries(), ...context.updates],
    'the console': seen.lines,
    'unhandled rejections': seen.rejections
  };
  assert.ok(client.given.length >= 3, 'the client was used');
  assert.deepEqual(thinkingPosts(other), [], 'the second panel receives nothing');
  for (const [name, value] of Object.entries(sinks)) {
    for (const text of [CANARY.thinking, CANARY.later]) assert.ok(!holds(value, text), 'thinking text in ' + name);
  }
  for (const [what, text] of Object.entries(CANARY)) {
    if (what === 'thinking' || what === 'later') continue;
    assert.ok(!holds(panel.posted, text), what + ' reached the page');
    for (const [name, value] of Object.entries(sinks)) assert.ok(!holds(value, text), what + ' in ' + name);
  }
});

test('8. a read that rejects and a session lookup that throws, with text in their errors: nothing logged or shown, nothing thrown, and the next tick goes on', async t => {
  const seen = watchConsole(t);
  const secret = 'CANARY-ERROR-TEXT-' + CANARY.thinking;

  // The session lookup throws once: that look tells nothing, and the next one finds the session.
  const file = path.join(temp(t), SID + '.jsonl');
  fs.writeFileSync(file, reply([thought('Invented, after the fault.')]));
  let lookups = 0;
  const throwing = makeView(t, { session: () => { lookups++; if (lookups === 1) throw new Error(secret + ' ' + file); return entryFor(file); } });
  throwing.view.show();
  const panel = throwing.vscode.panels[0];
  say(panel, { v: 1, type: 'ready' });
  assert.doesNotThrow(() => throwing.view.fromPage({ v: 1, type: 'thinking', target: { class: 'agent', id: ID } }));
  throwing.clock.advance(FIRST_MS);
  await until(() => throwing.clock.pending() === 1);
  assert.equal(lookups, 1);
  assert.deepEqual(thinkingPosts(panel), [], 'nothing posted for the fault');
  assert.equal(throwing.view.thinking.current(), ID, 'the watch survives');
  throwing.clock.advance(EVERY_MS);
  await until(() => thinkingPosts(panel).length === 1);
  assert.equal(lookups, 2, 'the next tick looked again');
  assert.equal(thinkingPosts(panel)[0].state, 'recorded');
  throwing.view.thinking.stop();

  // The reader rejects once. lib/view.js takes thinking.readThinking when the view is made.
  const real = thinkingModule.readThinking;
  let reads = 0;
  thinkingModule.readThinking = async name => { reads++; if (reads === 1) throw new Error(secret + ' ' + name); return real(name); };
  t.after(() => { thinkingModule.readThinking = real; });
  const rejecting = openView(t, reply([thought('Invented, read on the second try.')]));
  thinkingModule.readThinking = real;
  start(rejecting.panel);
  rejecting.clock.advance(FIRST_MS);
  await until(() => rejecting.clock.pending() === 1);
  assert.equal(reads, 1);
  assert.deepEqual(thinkingPosts(rejecting.panel), [], 'one failed read says nothing');
  assert.equal(rejecting.view.thinking.current(), ID);
  rejecting.clock.advance(EVERY_MS);
  await until(() => thinkingPosts(rejecting.panel).length === 1);
  assert.equal(reads, 2, 'the next tick read again');
  assert.deepEqual(thinkingPosts(rejecting.panel)[0].thoughts.map(x => x.text), ['Invented, read on the second try.']);
  rejecting.view.thinking.stop();

  for (const [name, value] of Object.entries({
    'the output channel': [...throwing.logs, ...rejecting.logs], 'vscode calls': [...throwing.vscode.calls, ...rejecting.vscode.calls],
    'the console': seen.lines, 'unhandled rejections': seen.rejections, 'the pages': [...panel.posted, ...rejecting.panel.posted]
  })) assert.ok(!holds(value, 'CANARY-ERROR-TEXT'), 'error text in ' + name);
  assert.deepEqual([...throwing.logs, ...rejecting.logs], [], 'nothing was logged at all');
});
