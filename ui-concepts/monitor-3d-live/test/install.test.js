/* Wyarden 3D monitor, working mock-up: tests for the collector installer (lib/install.js).
 *
 * The installer edits the user's real Claude Code settings, so these tests hold it to being exact
 * and reversible: other settings untouched and in order, a second set-up a no-op byte for byte,
 * removal the inverse of set-up over a few hundred generated files, and nothing written anywhere
 * but the folders it was given. Every test works in its own temporary folder; no real home folder
 * is read. All tokens, ports and names here are invented.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const install = require('../lib/install.js');
const contract = require('../lib/contract.js');

const HUB = { v: 1, port: 21001, ingest: 'testIngestToken_0123456789abcdefghijklmnop', control: 'x'.repeat(40) };
const OLD = { v: 1, port: 21777, ingest: 'olderIngestToken-abcdefghijklmnopqrstuvwxyz0', control: 'y'.repeat(40) };
const URL_NOW = contract.hookUrl(HUB, 'claude');
const URL_OLD = contract.hookUrl(OLD, 'claude');
const NAMES = install.EVENTS.map(e => e.name);
const ours = (url = URL_NOW) => ({ type: 'http', url, timeout: 1 });
const cmd = (name, extra = {}) => ({ type: 'command', command: 'node ' + name + '.js', timeout: 5, ...extra });

/* ---------- helpers ---------- */

function makeRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wym-')); }
function withRoot(fn) {
  const root = makeRoot();
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function folder(root, name = 'acct') { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; }
const settingsOf = dir => path.join(dir, 'settings.json');
function put(dir, text) { fs.writeFileSync(settingsOf(dir), text); return text; }
const putJson = (dir, json, indent = 2) => put(dir, JSON.stringify(json, null, indent) + '\n');
const read = dir => fs.readFileSync(settingsOf(dir), 'utf8');
const parse = text => JSON.parse(text.replace(/^\uFEFF/, ''));

/** Every path under `root` with a hash of each file's bytes: any write shows up as a difference. */
function snapshot(root) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name), rel = path.relative(root, p);
      if (e.isDirectory()) { out.push(rel + '/'); walk(p); }
      else out.push(rel + ' ' + crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'));
    }
  })(root);
  return out;
}
const tmpLeft = dir => fs.readdirSync(dir).filter(n => n.endsWith('.tmp'));

/** Each entry of ours in a parsed file: [event, group index, hook index, url]. */
function oursIn(json) {
  const found = [];
  for (const [ev, groups] of Object.entries(json.hooks || {})) {
    groups.forEach((g, gi) => g.hooks.forEach((h, hi) => { if (install.isOurs(h)) found.push([ev, gi, hi, h.url]); }));
  }
  return found;
}
function setUpAndWrite(dirs, hub = HUB) {
  const changes = install.plan(dirs, hub);
  const results = install.apply(changes);
  return { changes, results };
}

/* ---------- the table and the entry ---------- */

test('EVENTS is the measured list of eleven, matcher only on the tool events', () => {
  assert.deepEqual(NAMES, ['UserPromptSubmit', 'Stop', 'StopFailure', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'PermissionRequest', 'PermissionDenied', 'Notification', 'SubagentStart', 'SubagentStop']);
  assert.deepEqual(install.EVENTS.filter(e => e.matcher).map(e => e.name), ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
  assert.ok(!NAMES.includes('SessionStart') && !NAMES.includes('SessionEnd'));
  assert.ok(Object.isFrozen(install.EVENTS) && install.EVENTS.every(Object.isFrozen));
});

test('entryFor is the http entry with the contract address and a 1 s timeout', () => {
  assert.deepEqual(install.entryFor(HUB), { type: 'http', url: URL_NOW, timeout: 1 });
  assert.ok(contract.isHookUrl(install.entryFor(HUB).url));
});

test('a hub without a valid port or token is refused', () => {
  withRoot(root => {
    const d = folder(root);
    assert.throws(() => install.plan([d], null), TypeError);
    assert.throws(() => install.plan([d], { port: 21001, ingest: 'has space' }), TypeError);
    assert.throws(() => install.status([d], {}), TypeError);
  });
});

/* ---------- missing things ---------- */

test('a missing file: created with our entries alone, 2 spaces and a final newline', () => {
  withRoot(root => {
    const d = folder(root);
    const [c] = install.plan([d], HUB);
    assert.equal(c.exists, false);
    assert.equal(c.before, '');
    assert.equal(c.changed, true);
    assert.equal(c.state, 'missing');
    assert.equal(c.error, null);
    assert.equal(c.file, settingsOf(d));
    assert.equal(c.added, NAMES.length);
    const want = { hooks: {} };
    for (const e of install.EVENTS) want.hooks[e.name] = [e.matcher ? { matcher: '*', hooks: [ours()] } : { hooks: [ours()] }];
    assert.equal(c.after, JSON.stringify(want, null, 2) + '\n');
    assert.equal(fs.existsSync(settingsOf(d)), false, 'plan wrote nothing');
    const [r] = install.apply([c]);
    assert.deepEqual(r, { file: settingsOf(d), written: true, reason: null });
    assert.equal(read(d), c.after);
    assert.deepEqual(tmpLeft(d), []);
  });
});

test('a missing folder: an error, and nothing is created', () => {
  withRoot(root => {
    const gone = path.join(root, 'no-such-account');
    const before = snapshot(root);
    const [c] = install.plan([gone], HUB);
    assert.equal(c.changed, false);
    assert.match(c.error, /does not exist/);
    assert.ok(c.error.includes(gone));
    assert.equal(c.after, '');
    assert.deepEqual(install.apply([c]), [{ file: c.file, written: false, reason: c.error }]);
    const [r] = install.planRemoval([gone]);
    assert.ok(r.error && !r.changed);
    assert.deepEqual(snapshot(root), before);
  });
});

test('a folder path that is a file: an error', () => {
  withRoot(root => {
    const f = path.join(root, 'plain-file');
    fs.writeFileSync(f, 'x');
    const [c] = install.plan([f], HUB);
    assert.match(c.error, /not a folder/);
    assert.equal(c.changed, false);
  });
});

test('removal on a missing file changes nothing', () => {
  withRoot(root => {
    const d = folder(root);
    const [c] = install.planRemoval([d]);
    assert.equal(c.exists, false);
    assert.equal(c.changed, false);
    assert.equal(c.error, null);
    assert.equal(c.after, '');
    assert.deepEqual(install.apply([c]), [{ file: c.file, written: false, reason: 'no change' }]);
    assert.equal(fs.existsSync(settingsOf(d)), false);
  });
});

/* ---------- what is kept ---------- */

test('an empty object gets hooks alone, in 2 spaces', () => {
  withRoot(root => {
    const d = folder(root);
    put(d, '{}\n');
    const [c] = install.plan([d], HUB);
    assert.equal(c.state, 'missing');
    assert.ok(c.after.startsWith('{\n  "hooks": {\n    "UserPromptSubmit": ['));
    assert.equal(c.reformatted, false);
    install.apply([c]);
    install.apply(install.planRemoval([d]));
    assert.equal(read(d), '{}\n');
  });
});

test('other keys and other hooks are kept untouched and in order; ours goes after them', () => {
  withRoot(root => {
    const d = folder(root);
    const foreignHttp = { type: 'http', url: 'http://127.0.0.1:9999/other-tool/hook', timeout: 3 };
    const nearMisses = [
      { type: 'command', url: URL_NOW, command: 'echo' },                                   // our address, but not an http entry
      { type: 'http', url: URL_NOW.replace('http:', 'https:') },                            // not our scheme
      { type: 'http', url: URL_NOW.replace('127.0.0.1', 'localhost') },                     // not our host
      { type: 'http', url: URL_NOW + '/extra' }                                             // not our path
    ];
    const original = {
      env: { SOME_FLAG: '1' },
      permissions: { allow: ['Read'], deny: [] },
      hooks: {
        Stop: [{ hooks: [cmd('stop-a', { async: true })] }, { hooks: [foreignHttp] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [cmd('bash-guard')] }, { matcher: 'Edit|Write', hooks: [cmd('edit-guard')] }],
        PostToolUse: [{ hooks: [cmd('post')] }],
        Notification: [{ matcher: 'idle_prompt', hooks: [cmd('notify')] }],
        SessionStart: [{ hooks: nearMisses }],
        PreCompact: [{ hooks: [cmd('compact')] }]
      },
      model: 'some-model',
      theme: 'dark'
    };
    const text = putJson(d, original);
    const [c] = install.plan([d], HUB);
    assert.equal(c.state, 'missing');
    const after = parse(c.after);
    assert.deepEqual(Object.keys(after), ['env', 'permissions', 'hooks', 'model', 'theme']);
    assert.deepEqual(Object.keys(after.hooks), ['Stop', 'PreToolUse', 'PostToolUse', 'Notification', 'SessionStart', 'PreCompact',
      ...NAMES.filter(n => !['Stop', 'PreToolUse', 'PostToolUse', 'Notification'].includes(n))]);
    for (const k of ['env', 'permissions', 'model', 'theme']) assert.deepEqual(after[k], original[k]);
    // Stop: into the first group with no matcher, after its own entry.
    assert.deepEqual(after.hooks.Stop, [{ hooks: [cmd('stop-a', { async: true }), ours()] }, { hooks: [foreignHttp] }]);
    // PreToolUse: no group with matcher "*", absent or "": a new group after the others.
    assert.deepEqual(after.hooks.PreToolUse, [...original.hooks.PreToolUse, { matcher: '*', hooks: [ours()] }]);
    // PostToolUse: a group with no matcher catches every tool, so ours joins it.
    assert.deepEqual(after.hooks.PostToolUse, [{ hooks: [cmd('post'), ours()] }]);
    // Notification takes no matcher here: its only group has one, so a new group.
    assert.deepEqual(after.hooks.Notification, [original.hooks.Notification[0], { hooks: [ours()] }]);
    assert.deepEqual(after.hooks.SessionStart, original.hooks.SessionStart, 'near misses are not ours');
    assert.deepEqual(after.hooks.PreCompact, original.hooks.PreCompact);
    assert.equal(oursIn(after).length, NAMES.length);
    install.apply([c]);
    const [r] = install.planRemoval([d], HUB);
    assert.equal(r.state, 'installed');
    assert.equal(r.removed, NAMES.length);
    install.apply([r]);
    assert.equal(read(d), text, 'removal gives back the original text, byte for byte');
  });
});

test('a matcher of "*" or "" is joined; the first such group wins', () => {
  withRoot(root => {
    const d = folder(root);
    putJson(d, { hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [cmd('a')] }, { matcher: '', hooks: [cmd('b')] }, { matcher: '*', hooks: [cmd('c')] }],
      PostToolUse: [{ matcher: '*', hooks: [cmd('d')] }]
    } });
    const after = parse(install.plan([d], HUB)[0].after);
    assert.deepEqual(after.hooks.PreToolUse[1], { matcher: '', hooks: [cmd('b'), ours()] });
    assert.deepEqual(after.hooks.PreToolUse[2], { matcher: '*', hooks: [cmd('c')] });
    assert.deepEqual(after.hooks.PostToolUse, [{ matcher: '*', hooks: [cmd('d'), ours()] }]);
  });
});

/* ---------- a second set-up, stale entries, copies ---------- */

test('set-up is idempotent, byte for byte', () => {
  withRoot(root => {
    const d = folder(root);
    putJson(d, { env: { A: 'b' }, hooks: { Stop: [{ hooks: [cmd('x')] }] } }, 4);
    setUpAndWrite([d]);
    const text = read(d);
    const [c] = install.plan([d], HUB);
    assert.equal(c.state, 'installed');
    assert.equal(c.changed, false);
    assert.equal(c.after, c.before);
    assert.equal(c.before, text);
    assert.deepEqual([c.added, c.replaced, c.collapsed], [0, 0, 0]);
    assert.deepEqual(install.apply([c]), [{ file: c.file, written: false, reason: 'no change' }]);
    assert.equal(read(d), text);
  });
});

test('our entry with its keys in another order is current, and is not rewritten', () => {
  withRoot(root => {
    const d = folder(root);
    setUpAndWrite([d]);
    const json = parse(read(d));
    json.hooks.Stop[0].hooks[0] = { timeout: 1, url: URL_NOW, type: 'http' };
    putJson(d, json);
    const [c] = install.plan([d], HUB);
    assert.equal(c.state, 'installed');
    assert.equal(c.changed, false);
  });
});

test('a stale entry is replaced in place, keeping its position in its group', () => {
  withRoot(root => {
    const d = folder(root);
    setUpAndWrite([d], OLD);
    const json = parse(read(d));
    json.hooks.PreToolUse[0].hooks = [cmd('first'), ours(URL_OLD), cmd('last')];
    json.hooks.Stop = [{ hooks: [cmd('s1')] }, { hooks: [ours(URL_OLD)] }];
    putJson(d, json);
    const [c] = install.plan([d], HUB);
    assert.equal(c.state, 'stale');
    assert.equal(c.replaced, NAMES.length);
    assert.equal(c.added, 0);
    const after = parse(c.after);
    assert.deepEqual(after.hooks.PreToolUse[0].hooks, [cmd('first'), ours(), cmd('last')]);
    assert.deepEqual(after.hooks.Stop, [{ hooks: [cmd('s1')] }, { hooks: [ours()] }]);
    assert.ok(oursIn(after).every(([, , , url]) => url === URL_NOW));
    assert.deepEqual(Object.keys(after.hooks), Object.keys(json.hooks));
  });
});

test('an entry of ours with a changed timeout is stale and is put right', () => {
  withRoot(root => {
    const d = folder(root);
    setUpAndWrite([d]);
    const json = parse(read(d));
    json.hooks.Stop[0].hooks[0].timeout = 30;
    putJson(d, json);
    const [c] = install.plan([d], HUB);
    assert.equal(c.state, 'stale');
    assert.equal(c.replaced, 1);
    assert.deepEqual(parse(c.after).hooks.Stop[0].hooks[0], ours());
  });
});

test('two of ours in one event are collapsed to one, and the change says so', () => {
  withRoot(root => {
    const d = folder(root);
    setUpAndWrite([d]);
    const json = parse(read(d));
    json.hooks.Stop[0].hooks.push(ours(URL_OLD));                       // a copy in the same group
    json.hooks.PreToolUse.push({ matcher: '*', hooks: [ours()] });       // a copy in a group of its own
    json.hooks.PostToolUse = [{ hooks: [cmd('keep'), ours(URL_OLD)] }, { matcher: '*', hooks: [ours()] }];
    putJson(d, json);
    const [c] = install.plan([d], HUB);
    assert.equal(c.state, 'stale');
    assert.equal(c.collapsed, 3);
    assert.equal(c.replaced, 1, 'the first one in PostToolUse was stale');
    const after = parse(c.after);
    assert.deepEqual(after.hooks.Stop, [{ hooks: [ours()] }]);
    assert.deepEqual(after.hooks.PreToolUse, [{ matcher: '*', hooks: [ours()] }], 'the group the copy emptied is gone');
    assert.deepEqual(after.hooks.PostToolUse, [{ hooks: [cmd('keep'), ours()] }]);
    for (const n of NAMES) assert.equal(oursIn(after).filter(([ev]) => ev === n).length, 1, n);
    install.apply([c]);
    assert.equal(install.plan([d], HUB)[0].changed, false);
  });
});

test('ours under an event not registered (SessionStart, SessionEnd): stale; set-up and removal delete it', () => {
  withRoot(root => {
    const d = folder(root);
    setUpAndWrite([d]);
    const json = parse(read(d));
    json.hooks.SessionStart = [{ hooks: [cmd('start'), ours(URL_OLD)] }];
    json.hooks.SessionEnd = [{ hooks: [ours()] }];
    putJson(d, json);
    const [c] = install.plan([d], HUB);
    assert.equal(c.state, 'stale');
    assert.equal(c.collapsed, 2);
    const after = parse(c.after);
    assert.deepEqual(after.hooks.SessionStart, [{ hooks: [cmd('start')] }]);
    assert.equal(own(after.hooks, 'SessionEnd'), false, 'the event list it emptied is gone');
    assert.equal(install.status([d], HUB).stale, 1);
    // Removal finds it too, without set-up first.
    putJson(d, json);
    const [r] = install.planRemoval([d]);
    const gone = parse(r.after);
    assert.deepEqual(oursIn(gone), []);
    assert.deepEqual(gone.hooks.SessionStart, [{ hooks: [cmd('start')] }]);
    assert.equal(r.removed, NAMES.length + 2);
  });
});
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/* ---------- removal ---------- */

test('removal leaves groups, events and a hooks object that were already empty alone', () => {
  withRoot(root => {
    const d = folder(root);
    const original = { hooks: {
      PreToolUse: [{ matcher: '*', hooks: [] }, { matcher: 'Bash', hooks: [cmd('b')] }],
      Stop: [{ hooks: [] }],
      PreCompact: []
    }, other: true };
    const text = putJson(d, original);
    const [c] = install.plan([d], HUB);
    const after = parse(c.after);
    assert.deepEqual(after.hooks.PreToolUse.slice(0, 2), original.hooks.PreToolUse, 'never into an empty group');
    assert.deepEqual(after.hooks.PreToolUse[2], { matcher: '*', hooks: [ours()] });
    assert.deepEqual(after.hooks.Stop, [{ hooks: [] }, { hooks: [ours()] }]);
    assert.deepEqual(after.hooks.PreCompact, []);
    install.apply([c]);
    install.apply(install.planRemoval([d]));
    assert.equal(read(d), text);
    // And removal on the original itself changes nothing at all.
    const [r] = install.planRemoval([d]);
    assert.equal(r.changed, false);
    assert.equal(r.after, text);
    put(d, '{"hooks":{}}');
    assert.equal(install.planRemoval([d])[0].changed, false);
  });
});

test('known limit: a hooks object or a registered event list that was empty before set-up is gone after removal', () => {
  // `{"hooks": {}}` and `{}` give the same file after set-up, so no removal can tell them apart.
  // Removal takes the reading that leaves nothing of ours behind: the empty container goes.
  withRoot(root => {
    const d = folder(root);
    for (const [start, end] of [['{"hooks":{}}', '{}'], ['{"hooks":{"Stop":[]},"a":1}', '{"a":1}']]) {
      put(d, start);
      install.apply(install.plan([d], HUB));
      install.apply(install.planRemoval([d]));
      assert.equal(read(d), end);
    }
  });
});

/* ---------- the round trip, over generated files ---------- */

/** A small seeded generator (mulberry32), so a failing case can be made again from its seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function generator(seed) {
  const r = rng(seed);
  const int = n => Math.floor(r() * n);
  const pick = list => list[int(list.length)];
  // Characters made from codes, so this file holds no raw character outside ASCII.
  const CAFE = 'caf' + String.fromCharCode(0xe9);
  const STRINGS = ['', 'plain', 'with "quotes"', 'line\nbreak', 'tab\there', 'slash/and\\back', CAFE,
    String.fromCharCode(0x2603) + ' snow', 'emoji ' + String.fromCharCode(0xd83d, 0xde00)];
  const scalar = () => pick([() => pick(STRINGS), () => int(1000) - 500, () => int(1000) / 8, () => r() < 0.5, () => null])();
  function value(depth) {
    const k = depth > 2 ? 2 : int(4);
    if (k === 0) { const o = {}; for (let i = int(4); i > 0; i--) o[pick(['a', 'b', 'mode', 'list', 'x_' + int(50), CAFE])] = value(depth + 1); return o; }
    if (k === 1) return Array.from({ length: int(4) }, () => value(depth + 1));
    return scalar();
  }
  const FOREIGN = [
    () => cmd('c' + int(9)),
    () => cmd('d' + int(9), { async: true, args: ['--flag'] }),
    () => ({ type: 'http', url: 'http://127.0.0.1:' + (9000 + int(99)) + '/other/claude', timeout: 2 }),
    () => ({ type: 'command', url: URL_NOW }),
    () => ({ type: 'http', url: URL_NOW.replace('127.0.0.1', 'localhost') }),
    () => ({ type: 'prompt', prompt: pick(STRINGS) })
  ];
  const MATCHERS = [undefined, undefined, '*', '', 'Bash', 'Edit|Write', 'mcp__.*'];
  const EVENT_POOL = [...NAMES, 'SessionStart', 'SessionEnd', 'PreCompact', 'PostToolBatch'];
  function group() {
    const g = {};
    const m = pick(MATCHERS);
    if (r() < 0.15) g.note = pick(STRINGS);                       // a key Claude Code may add some day
    if (m !== undefined) g.matcher = m;
    g.hooks = Array.from({ length: r() < 0.15 ? 0 : 1 + int(3) }, () => pick(FOREIGN)());
    if (r() < 0.2) { const h = g.hooks; delete g.hooks; g.after = 1; g.hooks = h; }
    return g;
  }
  function hooks() {
    const h = {};
    const names = EVENT_POOL.filter(() => r() < 0.3);
    if (names.length === 0) names.push(pick(EVENT_POOL));
    for (const n of names.sort(() => r() - 0.5)) {
      // An empty list is made only for an event not registered: see the known limit above.
      const len = NAMES.includes(n) ? 1 + int(3) : int(3);
      h[n] = Array.from({ length: len }, group);
    }
    return h;
  }
  // Text outside `hooks` that JSON.parse and JSON.stringify would not give back: it must survive as it is.
  const ODD_KEYS = ['"10"', '"2"', '"env"', '"env"', '"caf\\u00e9"', '"__proto__"', '"model"', '"a\\/b"'];
  const ODD_VALUES = ['1e400', '-0', '12345678901234567890', '1.50', '{"10":"a","2":"b"}', '{"a":1,"a":2}',
    '"caf\\u00e9 \\ud83d\\ude00"', '[ 1 ,2 ,  {"x" :true} ]', '{ }', '[]', 'null'];
  /** A value given as its text, written into the file as it is. */
  function Raw(text) { this.text = text; }
  /** The file's text, written member by member, with where the `hooks` value sits (or null). */
  function write(members, style) {
    const sep = style.indent ? ': ' : ':';
    let text = style.bom + '{', span = null;
    members.forEach(([key, value], i) => {
      if (i > 0) text += ',';
      if (style.indent) text += style.eol + style.indent;
      text += key + sep;
      const v = value instanceof Raw ? value.text : JSON.stringify(value, null, style.indent).split('\n').join(style.eol + style.indent);
      if (key === '"hooks"') span = [text.length, text.length + v.length];
      text += v;
    });
    if (style.indent && members.length) text += style.eol;
    text += '}' + (style.final ? style.eol : '');
    return { text, span };
  }
  return function settings() {
    const members = [];
    for (let i = int(6); i > 0; i--) {
      members.push(r() < 0.5 ? [pick(ODD_KEYS), new Raw(pick(ODD_VALUES))] :[JSON.stringify(pick(['permissions', 'theme', 'k' + int(100)])), value(1)]);
    }
    const hooksAt = r() < 0.75 ? int(members.length + 1) : -1;   // where "hooks" goes, or no "hooks"
    if (hooksAt >= 0) members.splice(hooksAt, 0, ['"hooks"', hooks()]);
    const style = {
      bom: r() < 0.2 ? String.fromCharCode(0xfeff) : '',
      eol: r() < 0.3 ? '\r\n' : '\n',
      indent: pick(['  ', '  ', '    ', '\t', '']),
      final: r() < 0.8
    };
    const hooksValue = hooksAt >= 0 ? members[hooksAt][1] : undefined;
    return { ...write(members, style), style, hooks: hooksValue };
  };
}

test('round trip over 300 generated files: set-up then removal gives back the original, byte for byte', () => {
  withRoot(root => {
    const d = folder(root);
    const seed = 20261126;
    const next = generator(seed);
    let joined = 0, reproduced = 0;
    let withHooks = 0, odd = 0;
    for (let i = 0; i < 300; i++) {
      const { text, span, style, hooks } = next();
      const label = 'seed ' + seed + ', case ' + i + ', style ' + JSON.stringify(style);
      put(d, text);
      assert.doesNotThrow(() => parse(text), label + ': the generator wrote JSON');
      if (/1e400|"10"|-0|\\u00e9|"a":1,"a":2/.test(text)) odd++;
      const [c] = install.plan([d], HUB);
      assert.equal(c.error, null, label);
      assert.equal(c.state, 'missing', label);
      assert.equal(c.changed, true, label);
      assert.equal(c.reformatted, false, label);
      if (span) {
        // Every byte outside the hooks value is the same.
        withHooks++;
        const tail = text.length - span[1];
        assert.equal(c.after.slice(0, span[0]), text.slice(0, span[0]), label + ': before the hooks value');
        assert.equal(c.after.slice(c.after.length - tail), text.slice(span[1]), label + ': after the hooks value');
        const mid = JSON.parse(c.after.slice(span[0], c.after.length - tail));
        const found = oursIn({ hooks: mid });
        assert.deepEqual(found.map(f => f[0]).sort(), [...NAMES].sort(), label + ': one of ours per registered event');
        joined += found.filter(([ev, gi]) => hooks[ev] && gi < hooks[ev].length).length;
      } else {
        // The original text, with one member added before the closing brace.
        const close = text.lastIndexOf('}');
        assert.equal(c.after.slice(c.after.length - (text.length - close)), text.slice(close), label + ': the end');
        const stem = text.slice(0, close).replace(/[\s]+$/, '');
        assert.ok(c.after.startsWith(stem), label + ': the start');
      }
      assert.deepEqual(install.apply([c]).map(x => x.written), [true], label);
      const again = install.plan([d], HUB)[0];
      assert.equal(again.state, 'installed', label);
      assert.equal(again.changed, false, label);
      const [r] = install.planRemoval([d], HUB);
      assert.equal(r.error, null, label);
      assert.equal(r.removed, NAMES.length, label);
      install.apply([r]);
      assert.equal(read(d), text, label + ': the same text, byte for byte');
      reproduced++;
    }
    assert.equal(reproduced, 300);
    assert.ok(withHooks > 150 && withHooks < 290, 'both kinds of file were made (' + withHooks + ' with hooks)');
    assert.ok(odd > 100, 'many files held text JSON.stringify would change (' + odd + ')');
    assert.ok(joined > 50, 'the cases often put ours into an existing group (' + joined + ')');
    assert.deepEqual(tmpLeft(d), []);
  });
});

/* ---------- text JSON.stringify would not give back ---------- */

// Each holds something a parse and a rewrite of the whole file would change.
const ODD_OUTSIDE = [
  ['number-like keys', '"env": {"10": "a", "2": "b"}'],
  ['odd numbers', '"n": 1e400, "b": 12345678901234567890, "z": -0, "f": 1.50'],
  ['a repeated key', '"a": 1, "a": 2'],
  ['escapes', '"s": "caf\\u00e9 \\ud83d\\ude00 \\/"']
];

test('odd text outside hooks, with no hooks member: set-up then removal is byte for byte', () => {
  withRoot(root => {
    const d = folder(root);
    for (const [name, inner] of ODD_OUTSIDE) {
      for (const text of ['{' + inner + '}', '{\n  ' + inner + '\n}\n', '{\r\n\t' + inner + '\r\n}']) {
        put(d, text);
        const [c] = install.plan([d], HUB);
        assert.equal(c.error, null, name);
        assert.ok(c.after.startsWith(text.slice(0, text.lastIndexOf('}')).replace(/\s+$/, '')), name + ': the original text comes first');
        install.apply([c]);
        assert.equal(install.plan([d], HUB)[0].changed, false, name + ': a second set-up changes nothing');
        install.apply(install.planRemoval([d]));
        assert.equal(read(d), text, name);
      }
    }
  });
});

test('odd text outside hooks, with a hooks member: every byte outside its value is kept', () => {
  withRoot(root => {
    const d = folder(root);
    const hooksText = '{\n    "PreCompact": [\n      {\n        "hooks": [\n          {\n            "type": "command",\n            "command": "x"\n          }\n        ]\n      }\n    ]\n  }';
    for (const [name, inner] of ODD_OUTSIDE) {
      const head = '{\n  ' + inner + ',\n  "hooks": ', tail = ',\n  ' + inner.replace(/"(\w+)":/g, '"$1x":') + '\n}\n';
      const text = put(d, head + hooksText + tail);
      const [c] = install.plan([d], HUB);
      assert.equal(c.error, null, name);
      assert.equal(c.reformatted, false, name);
      assert.ok(c.after.startsWith(head) && c.after.endsWith(tail), name + ': outside the value, unchanged');
      install.apply([c]);
      const [r] = install.planRemoval([d]);
      assert.ok(r.after.startsWith(head) && r.after.endsWith(tail), name + ': unchanged by removal too');
      install.apply([r]);
      assert.equal(read(d), text, name);
    }
  });
});

test('removal deletes a member it empties with its comma and line, wherever it sits', () => {
  withRoot(root => {
    const d = folder(root);
    const cases = [
      ['{\n  "a": 1,\n  "hooks": HOOKS,\n  "b": 2\n}\n', '{\n  "a": 1,\n  "b": 2\n}\n'],
      ['{\n  "hooks": HOOKS,\n  "b": 2\n}\n', '{\n  "b": 2\n}\n'],
      ['{\n  "a": 1,\n  "hooks": HOOKS\n}\n', '{\n  "a": 1\n}\n'],
      ['{\n  "hooks": HOOKS\n}\n', '{}\n'],
      ['{"hooks":HOOKS}', '{}']
    ];
    for (const [shape, want] of cases) {
      const value = JSON.stringify({ Stop: [{ hooks: [ours()] }], SessionEnd: [{ hooks: [ours(URL_OLD)] }] });
      put(d, shape.replace('HOOKS', value));
      const [r] = install.planRemoval([d]);
      assert.equal(r.after, want, JSON.stringify(shape));
    }
  });
});

test('a hooks key given twice is refused, however it is spelled', () => {
  withRoot(root => {
    const d = folder(root);
    for (const text of ['{"hooks": {}, "hooks": {}}', '{"hooks": {}, "a": 1, "hoo\\u006bs": {"Stop": []}}']) {
      put(d, text);
      for (const c of [install.plan([d], HUB)[0], install.planRemoval([d])[0]]) {
        assert.match(c.error, /"hooks" key more than once/);
        assert.equal(c.changed, false);
        assert.equal(c.after, text);
      }
    }
  });
});

test('hooks that would not survive a rewrite are refused: number-like keys, odd numbers, a repeated key', () => {
  withRoot(root => {
    const d = folder(root);
    const entry = extra => '{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "x"' + extra + '}]}]}}';
    const refused = [
      ['number-like keys', entry(', "10": 1, "2": 2')],
      ['number-like event names', '{"hooks": {"10": [], "2": []}}'],
      ['1e400', entry(', "timeout": 1e400')],
      ['a large integer', entry(', "timeout": 12345678901234567890')],
      ['minus zero', entry(', "timeout": -0')],
      ['a repeated key', entry(', "type": "command"')]
    ];
    for (const [name, text] of refused) {
      put(d, text);
      for (const c of [install.plan([d], HUB)[0], install.planRemoval([d])[0]]) {
        assert.match(c.error, /cannot rewrite exactly/, name);
        assert.equal(c.state, 'unreadable', name);
        assert.equal(c.changed, false, name);
        assert.equal(c.after, text, name);
      }
    }
    // What is the same number or text once rewritten is accepted.
    for (const extra of [', "timeout": 5.0', ', "timeout": 1e1', ', "command2": "caf\\u00e9"']) {
      put(d, entry(extra));
      const [c] = install.plan([d], HUB);
      assert.equal(c.error, null, extra);
      assert.equal(c.reformatted, true, extra);
    }
  });
});

test('a file nested 200,000 levels deep, or larger than the limit, gives an error record at once', () => {
  withRoot(root => {
    const d = folder(root);
    const deep = 200000;
    for (const text of ['{"a": ' + '['.repeat(deep) + ']'.repeat(deep) + '}', '{"hooks": {"Stop": ' + '['.repeat(deep) + ']'.repeat(deep) + '}}']) {
      put(d, text);
      const t0 = Date.now();
      const [c] = install.plan([d], HUB);
      const [r] = install.planRemoval([d]);
      const s = install.status([d], HUB);
      assert.ok(Date.now() - t0 < 1000, 'took ' + (Date.now() - t0) + ' ms');
      assert.match(c.error, /nested more than 256 levels/);
      assert.match(r.error, /nested more than 256 levels/);
      assert.equal(s.unreadable, 1);
      assert.equal(c.changed, false);
    }
    // Exactly at the limit is accepted.
    put(d, '{"a": ' + '['.repeat(install.MAX_DEPTH - 1) + ']'.repeat(install.MAX_DEPTH - 1) + '}');
    assert.equal(install.plan([d], HUB)[0].error, null);
    fs.writeFileSync(settingsOf(d), '{"a": "' + 'x'.repeat(install.MAX_BYTES) + '"}');
    assert.match(install.plan([d], HUB)[0].error, /larger than 1 MB/);
  });
});

test('no error ever quotes the file: not a key, not a value', () => {
  withRoot(root => {
    const d = folder(root);
    const SECRET = 'sk-SECRET-abc123';
    const texts = [
      '{"hooks": {"' + SECRET + '": 1}}',
      '{"hooks": {"' + SECRET + '": [1]}}',
      '{"hooks": {"' + SECRET + '": [], "' + SECRET + '": []}}',
      '{"hooks": {"Stop": [{"hooks": [{"' + SECRET + '": 1e400}]}]}}',
      '{"' + SECRET + '": 1,}',
      '{"env": {"KEY": "' + SECRET + '"}, oops}',
      '["' + SECRET + '"]',
      '{"hooks": "' + SECRET + '"}',
      '{"' + SECRET + '": "' + SECRET + '"'
    ];
    for (const text of texts) {
      put(d, text);
      const errors = [install.plan([d], HUB)[0].error, install.planRemoval([d])[0].error];
      for (const e of errors) {
        assert.ok(e, text);
        assert.ok(!e.includes('SECRET') && !e.includes('abc123'), e);
      }
    }
  });
});

test('apply refuses a hand-made change whose file is not settings.json in its own folder', () => {
  withRoot(root => {
    const d = folder(root), other = folder(root, 'other');
    const made = { dir: d, file: path.join(root, 'elsewhere.json'), exists: false, before: '', after: '{}', changed: true, error: null };
    const cases = [
      made,
      { ...made, file: settingsOf(other) },
      { ...made, file: path.join(d, 'settings.local.json') },
      { ...made, dir: undefined }
    ];
    const before = snapshot(root);
    for (const c of cases) assert.deepEqual(install.apply([c]), [{ file: c.file, written: false, reason: 'not a change made by plan' }]);
    assert.deepEqual(snapshot(root), before);
  });
});

/* ---------- the file's text style ---------- */

test('indentation, line ends, final newline and byte order mark are kept', () => {
  withRoot(root => {
    const d = folder(root);
    const json = { env: { A: 'x' }, hooks: { Stop: [{ hooks: [cmd('s')] }] }, list: [1, 2] };
    const cases = [
      ['2 spaces, LF', { bom: '', eol: '\n', indent: '  ', final: true }],
      ['4 spaces, LF', { bom: '', eol: '\n', indent: '    ', final: true }],
      ['tab, LF', { bom: '', eol: '\n', indent: '\t', final: true }],
      ['minified, no newline', { bom: '', eol: '\n', indent: '', final: false }],
      ['minified, newline', { bom: '', eol: '\n', indent: '', final: true }],
      ['2 spaces, CRLF', { bom: '', eol: '\r\n', indent: '  ', final: true }],
      ['4 spaces, CRLF, no final', { bom: '', eol: '\r\n', indent: '    ', final: false }],
      ['BOM, 2 spaces', { bom: '\uFEFF', eol: '\n', indent: '  ', final: true }],
      ['BOM, tab, CRLF', { bom: '\uFEFF', eol: '\r\n', indent: '\t', final: true }],
      ['3 spaces', { bom: '', eol: '\n', indent: '   ', final: true }]
    ];
    for (const [name, style] of cases) {
      const text = put(d, install.serialize(json, style));
      assert.deepEqual(install.detectStyle(text), { bom: style.bom, eol: style.eol, indent: style.indent }, name);
      const [c] = install.plan([d], HUB);
      assert.equal(c.reformatted, false, name);
      const mid = parse(c.after);
      assert.equal(c.after, install.serialize(mid, style), name + ': written in the same style');
      assert.equal(c.after.startsWith('\uFEFF'), style.bom !== '', name + ': the mark is kept');
      if (style.eol === '\r\n') assert.ok(!/[^\r]\n/.test(c.after), name + ': no bare LF');
      else assert.ok(!c.after.includes('\r'), name + ': no CR');
      install.apply([c]);
      install.apply(install.planRemoval([d]));
      assert.equal(read(d), text, name + ': back to the same bytes');
    }
  });
});

test('hand-aligned text outside hooks survives untouched; the new member copies its layout', () => {
  withRoot(root => {
    const d = folder(root);
    const text = put(d, '{\n  "theme":   "dark",\n  "model" : "m"\n}\n');
    const [c] = install.plan([d], HUB);
    assert.equal(c.reformatted, false);
    assert.equal(c.changed, true);
    assert.ok(c.after.startsWith('{\n  "theme":   "dark",\n  "model" : "m",\n  "hooks" : {\n    "UserPromptSubmit": ['), c.after.slice(0, 80));
    assert.ok(c.after.endsWith('\n  }\n}\n'));
    install.apply([c]);
    install.apply(install.planRemoval([d]));
    assert.equal(read(d), text);
  });
});

test('a hooks value in another layout is rewritten in the file style, marked reformatted, and nothing else moves', () => {
  withRoot(root => {
    const d = folder(root);
    const head = '{\n  "theme":   "dark",\n  "hooks": ';
    const tail = ',\n  "model" : "m"\n}\n';
    put(d, head + '{ "PreCompact": [ { "hooks": [ { "type": "command", "command": "x", "timeout": 5.0 } ] } ] }' + tail);
    const [c] = install.plan([d], HUB);
    assert.equal(c.error, null);
    assert.equal(c.reformatted, true);
    assert.ok(c.after.startsWith(head) && c.after.endsWith(tail));
    assert.ok(c.after.slice(head.length).startsWith('{\n    "PreCompact": [\n      {\n'));
  });
});

/* ---------- files that are refused ---------- */

test('a file that does not parse, or has the wrong shape, is never rewritten', () => {
  withRoot(root => {
    const d = folder(root);
    const bad = [
      ['comments', '{\n  // a comment\n  "theme": "dark"\n}\n', /not plain JSON/],
      ['block comment', '/* x */ {"theme": "dark"}', /not plain JSON/],
      ['trailing comma', '{\n  "theme": "dark",\n}\n', /not plain JSON/],
      ['truncated', '{"hooks": {"Stop": [', /not plain JSON/],
      ['empty file', '', /not plain JSON/],
      ['top level array', '[]', /top level/],
      ['top level string', '"x"', /top level/],
      ['top level null', 'null', /top level/],
      ['hooks is an array', '{"hooks": []}', /"hooks" value that is not an object/],
      ['hooks is a string', '{"hooks": "none"}', /"hooks" value/],
      ['hooks is null', '{"hooks": null}', /"hooks" value/],
      ['event is an object', '{"hooks": {"Stop": {"hooks": []}}}', /whose value is not a list/],
      ['event is null', '{"hooks": {"PreCompact": null}}', /whose value is not a list/],
      ['group is a string', '{"hooks": {"Stop": ["x"]}}', /hook group/],
      ['group has no hooks list', '{"hooks": {"Stop": [{"matcher": "*"}]}}', /hook group/],
      ['group hooks is an object', '{"hooks": {"Stop": [{"hooks": {}}]}}', /hook group/]
    ];
    for (const [name, text, why] of bad) {
      put(d, text);
      for (const c of [install.plan([d], HUB)[0], install.planRemoval([d])[0]]) {
        assert.equal(c.exists, true, name);
        assert.equal(c.state, 'unreadable', name);
        assert.equal(c.changed, false, name);
        assert.equal(c.before, text, name);
        assert.equal(c.after, text, name);
        assert.match(c.error, why, name);
        assert.ok(c.error.includes(settingsOf(d)), name + ': the sentence names the file');
        assert.deepEqual(install.apply([c]), [{ file: c.file, written: false, reason: c.error }], name);
      }
      assert.equal(read(d), text, name + ': not rewritten');
      assert.equal(install.status([d], HUB).unreadable, 1, name);
    }
  });
});

test('the refusal never quotes the file, which can hold a secret', () => {
  withRoot(root => {
    const d = folder(root);
    put(d, '{"env": {"API_KEY": "invented-secret-value-123"}, oops}');
    const [c] = install.plan([d], HUB);
    assert.ok(c.error && !c.error.includes('invented-secret'));
  });
});

test('a file that is not UTF-8 is refused', () => {
  withRoot(root => {
    const d = folder(root);
    fs.writeFileSync(settingsOf(d), Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]));
    const [c] = install.plan([d], HUB);
    assert.match(c.error, /not UTF-8/);
    assert.equal(c.changed, false);
  });
});

/* ---------- apply ---------- */

test('apply refuses a file that changed after the plan was made, and leaves no temporary file', () => {
  withRoot(root => {
    const d = folder(root);
    putJson(d, { theme: 'dark' });
    const [c] = install.plan([d], HUB);
    const edited = put(d, JSON.stringify({ theme: 'light' }, null, 2) + '\n');
    assert.deepEqual(install.apply([c]), [{ file: c.file, written: false, reason: 'changed since it was shown' }]);
    assert.equal(read(d), edited);
    assert.deepEqual(tmpLeft(d), []);
  });
});

test('apply refuses when a missing file appeared, or an existing one went, after the plan', () => {
  withRoot(root => {
    const d = folder(root);
    const [c] = install.plan([d], HUB);
    put(d, '{"made": "meanwhile"}');
    assert.equal(install.apply([c])[0].reason, 'changed since it was shown');
    assert.equal(read(d), '{"made": "meanwhile"}');
    const [c2] = install.plan([d], HUB);
    fs.unlinkSync(settingsOf(d));
    assert.equal(install.apply([c2])[0].reason, 'changed since it was shown');
    assert.equal(fs.existsSync(settingsOf(d)), false);
    assert.deepEqual(tmpLeft(d), []);
  });
});

test('apply removes its temporary file when a write or the rename fails', () => {
  withRoot(root => {
    const d = folder(root);
    const text = putJson(d, { theme: 'dark' });
    const [c] = install.plan([d], HUB);
    const fail = (name, code) => ({ ...fs, [name]() { const e = new Error('invented failure'); e.code = code; throw e; } });
    let made = 0;
    const counting = { ...fs, openSync(...a) { made++; return fs.openSync(...a); } };
    for (const [step, code] of [['renameSync', 'EIO'], ['writeFileSync', 'ENOSPC'], ['fsyncSync', 'EIO']]) {
      const io = { ...fail(step, code), openSync: counting.openSync };
      const [r] = install.apply([c], { io });
      assert.equal(r.written, false, step);
      assert.ok(r.reason.includes(code), step + ': ' + r.reason);
      assert.equal(read(d), text, step + ': the target is untouched');
      assert.deepEqual(tmpLeft(d), [], step + ': no temporary file');
    }
    assert.equal(made, 3, 'a temporary file was made each time, then removed');
  });
});

test('apply on success: one result per change, the file written, no temporary file', () => {
  withRoot(root => {
    const a = folder(root, 'a'), b = folder(root, 'b'), gone = path.join(root, 'gone');
    putJson(a, { theme: 'dark' });
    const changes = install.plan([a, b, gone], HUB);
    const results = install.apply(changes);
    assert.deepEqual(results.map(r => [r.file, r.written]), [[settingsOf(a), true], [settingsOf(b), true], [settingsOf(gone), false]]);
    assert.equal(read(a), changes[0].after);
    assert.equal(read(b), changes[1].after);
    assert.deepEqual([...tmpLeft(a), ...tmpLeft(b)], []);
    assert.equal(fs.existsSync(gone), false);
  });
});

test('apply refuses something that is not a change from plan', () => {
  assert.deepEqual(install.apply([null, { file: 'x' }]).map(r => r.written), [false, false]);
  const dir = path.join(os.tmpdir(), 'wym-never-made');
  // A record made by hand is refused whatever it says, even one that names the right file.
  for (const after of ['not json', '[]', '{"made": "by hand"}'])
    assert.equal(install.apply([{ dir, file: path.join(dir, 'settings.json'), before: '', after, changed: true, error: null }])[0].reason, 'not a change made by plan');
  withRoot(root => {
    const d = folder(root);
    putJson(d, { theme: 'dark' });
    const before = read(d);
    // A copy of a real record is not the record: only the very object plan returned is written.
    const [real] = install.plan([d], HUB);
    const copy = Object.assign({}, real, { after: '{"made": "by hand"}\n' });
    assert.deepEqual(install.apply([copy]).map(r => [r.written, r.reason]), [[false, 'not a change made by plan']]);
    assert.equal(read(d), before, 'nothing was written');
    // The real record, with its new text spoiled afterwards, is refused for what the text is.
    for (const spoiled of ['not json', '[]']) {
      const [c] = install.plan([d], HUB);
      c.after = spoiled;
      assert.equal(install.apply([c])[0].reason, 'the new text is not JSON');
    }
    assert.equal(read(d), before);
    assert.deepEqual(tmpLeft(d), []);
  });
});

test('set-up never takes a null, or any other odd entry, out of a user\'s hook list', () => {
  withRoot(root => {
    const cases = [
      { hooks: { Stop: [{ matcher: 'keep', note: 'x', hooks: [null] }] } },
      { hooks: { Stop: [{ hooks: ['a', null, 'b'] }] } },
      { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [null, { type: 'command', command: 'example' }, null] }], Other: [{ hooks: [null] }] } },
      { hooks: { Stop: [{ hooks: [null] }, { hooks: [{ type: 'http', url: contract.hookUrl(HUB, 'claude'), timeout: 1 }, { type: 'http', url: contract.hookUrl(HUB, 'claude'), timeout: 1 }, null] }] } }
    ];
    cases.forEach((original, i) => {
      const d = folder(root, 'acct-' + i);
      putJson(d, original);
      const [change] = install.plan([d], HUB);
      assert.equal(change.error, null);
      const after = JSON.parse(change.after);
      // Every entry that is not ours is still there, in order, in every group that was there.
      const others = json => Object.entries(json.hooks).map(([ev, groups]) => [ev, groups.map(g => g.hooks.filter(h => !install.isOurs(h)))]);
      const kept = others(after).map(([ev, groups]) => [ev, groups.filter(list => list.length > 0)]).filter(([, groups]) => groups.length > 0);
      assert.deepEqual(kept, others(original).map(([ev, groups]) => [ev, groups.filter(list => list.length > 0)]).filter(([, groups]) => groups.length > 0), 'case ' + i);
      assert.equal(change.collapsed, i === 3 ? 1 : 0, 'only a second entry of ours counts as collapsed, case ' + i);
      install.apply([change]);
      install.apply(install.planRemoval([d]));
      if (i < 3) assert.deepEqual(JSON.parse(read(d)), original, 'set-up and removal give the file back, case ' + i);
    });
  });
});

test('apply keeps the file mode (POSIX)', { skip: process.platform === 'win32' && 'file modes are POSIX only' }, () => {
  withRoot(root => {
    const d = folder(root);
    putJson(d, { theme: 'dark' });
    fs.chmodSync(settingsOf(d), 0o640);
    install.apply(install.plan([d], HUB));
    assert.equal(fs.statSync(settingsOf(d)).mode & 0o777, 0o640);
    install.apply(install.planRemoval([d]));
    assert.equal(fs.statSync(settingsOf(d)).mode & 0o777, 0o640);
  });
});

test('a settings file that is a link: the real file is written and the link is kept', (t) => {
  withRoot(root => {
    const d = folder(root, 'acct'), real = folder(root, 'dotfiles');
    const realFile = path.join(real, 'claude-settings.json');
    fs.writeFileSync(realFile, '{\n  "theme": "dark"\n}\n');
    try { fs.symlinkSync(realFile, settingsOf(d), 'file'); } catch (e) { t.skip('links cannot be made here (' + e.code + ')'); return; }
    install.apply(install.plan([d], HUB));
    assert.ok(fs.lstatSync(settingsOf(d)).isSymbolicLink(), 'still a link');
    assert.equal(install.plan([d], HUB)[0].state, 'installed');
    assert.deepEqual(tmpLeft(real), []);
    fs.unlinkSync(realFile);
    const [c] = install.plan([d], HUB);
    assert.match(c.error, /link to a file that does not exist/);
  });
});

/* ---------- status ---------- */

test('status and state, for every state', () => {
  withRoot(root => {
    const inst = folder(root, 'installed'), part = folder(root, 'partly'), miss = folder(root, 'missing');
    const stale = folder(root, 'stale'), bad = folder(root, 'unreadable'), none = folder(root, 'none');
    setUpAndWrite([inst, part, stale]);
    const json = parse(read(part));
    delete json.hooks.Stop;
    putJson(part, json);
    putJson(miss, { theme: 'dark' });
    install.apply(install.plan([stale], OLD));
    put(bad, '{ nope');
    const states = install.plan([inst, part, miss, stale, bad, none], HUB).map(c => c.state);
    assert.deepEqual(states, ['installed', 'partly', 'missing', 'stale', 'unreadable', 'missing']);
    assert.deepEqual(install.status([inst], HUB), { state: 'installed', folders: 1, installed: 1, stale: 0, unreadable: 0 });
    assert.deepEqual(install.status([inst, part], HUB), { state: 'partly', folders: 2, installed: 1, stale: 0, unreadable: 0 });
    assert.deepEqual(install.status([miss, none], HUB), { state: 'missing', folders: 2, installed: 0, stale: 0, unreadable: 0 });
    assert.deepEqual(install.status([stale], HUB), { state: 'partly', folders: 1, installed: 0, stale: 1, unreadable: 0 });
    assert.deepEqual(install.status([inst, bad], HUB), { state: 'partly', folders: 2, installed: 1, stale: 0, unreadable: 1 });
    assert.deepEqual(install.status([bad], HUB), { state: 'missing', folders: 1, installed: 0, stale: 0, unreadable: 1 });
    assert.deepEqual(install.status([], HUB), { state: 'missing', folders: 0, installed: 0, stale: 0, unreadable: 0 });
    // Removal without a hub cannot tell stale from current; with one it can.
    assert.equal(install.planRemoval([stale])[0].state, 'installed');
    assert.equal(install.planRemoval([stale], HUB)[0].state, 'stale');
  });
});

/* ---------- nothing written anywhere else ---------- */

test('no function writes outside the folders it was given', () => {
  withRoot(root => {
    const a = folder(root, 'given'), b = folder(root, 'not-given'), gone = path.join(root, 'gone');
    putJson(a, { theme: 'dark' });
    putJson(b, { theme: 'light' });
    fs.writeFileSync(path.join(root, 'beside.txt'), 'x');
    const start = snapshot(root);
    install.plan([a, gone], HUB);
    install.planRemoval([a, gone]);
    install.status([a, gone], HUB);
    assert.deepEqual(snapshot(root), start, 'planning and status write nothing');
    install.apply(install.plan([a, gone], HUB));
    const afterSetUp = snapshot(root);
    const changed = afterSetUp.filter(line => !start.includes(line));
    assert.deepEqual(changed.map(l => l.split(' ')[0]), [path.join('given', 'settings.json')]);
    assert.equal(afterSetUp.length, start.length, 'no file added or removed');
    install.apply(install.planRemoval([a, gone]));
    assert.deepEqual(snapshot(root), start, 'removal restores the tree exactly');
  });
});
