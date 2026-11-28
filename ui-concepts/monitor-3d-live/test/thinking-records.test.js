// Thinking records: from (tool, session id) to the path of the tool's own record of that session.
// Everything runs against temporary folders the tests make; every id, name, text and path in them is invented.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { recordOf, AGENTS, MAX_CODEX_FOLDERS, MAX_GROK_PARENTS } = require('../lib/thinking-records.js');

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';
const HOME_VAR = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wyr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const mkdir = p => { fs.mkdirSync(p, { recursive: true }); return p; };
/** A small invented file, its folders made first. */
const write = file => { mkdir(path.dirname(file)); fs.writeFileSync(file, '{"invented":true}\n'); return file; };
/** Swap fs.promises[name] for this test only; `make` gets the real one. */
function wrap(t, name, make) {
  const real = fs.promises[name];
  fs.promises[name] = make(real);
  t.after(() => { fs.promises[name] = real; });
}
const failing = (code, message = 'CANARY-ERROR-TEXT') => { const e = new Error(message); e.code = code; return e; };

/**
 * Every fs call made while `fn` runs, as [{ name, at }]: each function on fs.promises and on fs is
 * wrapped for that time only, so a call of any kind (readdir, stat, lstat, realpath, open, access,
 * a sync one) is seen.
 */
async function traced(fn) {
  const calls = [], undo = [];
  const wrapAll = (obj, label) => {
    for (const name of Object.keys(obj)) {
      const real = obj[name];
      if (typeof real !== 'function' || /^[A-Z]/.test(name)) continue;
      obj[name] = function (...args) {
        calls.push({ name: label + name, at: typeof args[0] === 'string' ? args[0] : String(args[0]) });
        return real.apply(this, args);
      };
      undo.push(() => { obj[name] = real; });
    }
  };
  wrapAll(fs.promises, 'promises.');
  wrapAll(fs, '');
  try { return { result: await fn(), calls }; } finally { for (const u of undo) u(); }
}
/** A folder link to `target` at `at`: a junction on Windows (no rights needed), a symlink elsewhere. False when the platform refuses. */
function linkDir(target, at) {
  try { fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir'); return true; } catch { return false; }
}
const NO_LINK = 'this platform would not make a folder link here, so the link case cannot be built';

/* ---------- Codex ---------- */

const rollout = (id, stamp = '2026-11-28T10-00-00') => 'rollout-' + stamp + '-' + id + '.jsonl';
function codexHome(t) {
  const home = tmp(t);
  return { home, sessions: path.join(home, '.codex', 'sessions') };
}
const codex = (id, home, extra = {}) => recordOf('codex', id, { home, env: {}, ...extra });

test('Codex: the record is found from the id, with the codex format, under <home>/.codex when CODEX_HOME is unset', async t => {
  const { home, sessions } = codexHome(t);
  const file = write(path.join(sessions, '2026', '11', '28', rollout(ID)));
  write(path.join(sessions, '2026', '11', '28', rollout(OTHER, '2026-11-28T09-00-00')));
  const r = await codex(ID, home);
  assert.deepEqual(r, { file, format: 'codex' });
  assert.deepEqual(Object.keys(r), ['file', 'format']);
  assert.deepEqual(await codex(OTHER, home), { file: path.join(sessions, '2026', '11', '28', rollout(OTHER, '2026-11-28T09-00-00')), format: 'codex' });
});

test('Codex: CODEX_HOME is honoured, and then <home>/.codex is not looked in', async t => {
  const { home, sessions } = codexHome(t);
  const elsewhere = path.join(tmp(t), 'codex-home');
  const file = write(path.join(elsewhere, 'sessions', '2026', '11', '28', rollout(ID)));
  write(path.join(sessions, '2026', '11', '28', rollout(OTHER)));
  assert.deepEqual(await codex(ID, home, { env: { CODEX_HOME: elsewhere } }), { file, format: 'codex' });
  assert.equal(await codex(OTHER, home, { env: { CODEX_HOME: elsewhere } }), null, 'only CODEX_HOME is looked in');
  assert.equal(await codex(ID, home), null, 'without CODEX_HOME, <home>/.codex is looked in, and it does not hold this one');
});

test('Codex: found whatever day folder it is in, however many newer ones there are', async t => {
  const { home, sessions } = codexHome(t);
  for (const [y, m, d] of [['2026', '11', '28'], ['2026', '11', '27'], ['2026', '10', '05'], ['2025', '12', '31']]) {
    write(path.join(sessions, y, m, d, rollout(OTHER.slice(0, -2) + d, y + '-' + m + '-' + d + 'T08-00-00')));
  }
  const file = write(path.join(sessions, '2025', '01', '02', rollout(ID, '2025-01-02T23-59-59')));
  assert.deepEqual(await codex(ID, home), { file, format: 'codex' });
});

test('Codex: the newest folders are looked at first; a file in the newest day is found without listing any older folder', async t => {
  const { home, sessions } = codexHome(t);
  const file = write(path.join(sessions, '2026', '11', '28', rollout(ID)));
  write(path.join(sessions, '2026', '11', '27', rollout(OTHER)));
  write(path.join(sessions, '2026', '10', '05', rollout(OTHER)));
  write(path.join(sessions, '2025', '12', '31', rollout(OTHER)));
  const { result, calls } = await traced(() => codex(ID, home));
  assert.deepEqual(result, { file, format: 'codex' });
  const listed = calls.filter(c => c.name === 'promises.readdir').map(c => c.at);
  assert.deepEqual(listed, [sessions, path.join(sessions, '2026'), path.join(sessions, '2026', '11'), path.join(sessions, '2026', '11', '28')]);
  assert.ok(!calls.some(c => c.name.startsWith('promises.open') || c.name === 'promises.readFile'), 'no file is opened');
});

test('Codex: a name that merely holds the id is not a match, and the whole name decides between two candidates', async t => {
  const { home, sessions } = codexHome(t);
  const day = path.join(sessions, '2026', '11', '28');
  const SHORT = '2222-3333';
  const longer = write(path.join(day, rollout(ID + 'ff')));          // another id that has ID as its prefix
  write(path.join(day, rollout(ID) + '.bak'));
  write(path.join(day, rollout('x' + ID)));                           // another id that has ID as its tail
  write(path.join(day, ID + '.jsonl'));
  write(path.join(day, 'rollout-' + ID + '.jsonl'));                  // no creation time
  write(path.join(day, rollout(ID, '2026-11-28T10-00')));             // a time of another shape
  write(path.join(day, 'old-' + rollout(ID)));
  write(path.join(day, rollout('1111-' + SHORT)));                    // a short id with "-" that is the tail of another
  assert.equal(await codex(ID, home), null);
  assert.equal(await codex(SHORT, home), null);
  assert.deepEqual(await codex(ID + 'ff', home), { file: longer, format: 'codex' }, 'the longer id finds its own file');
  const own = write(path.join(sessions, '2026', '11', '01', rollout(ID, '2026-11-01T07-00-00')));
  assert.deepEqual(await codex(ID, home), { file: own, format: 'codex' }, 'past the near misses, the right file');
});

test('Codex: entries at the wrong depth, or in folders not named as dates, are ignored', async t => {
  const { home, sessions } = codexHome(t);
  write(path.join(sessions, rollout(ID)));
  write(path.join(sessions, '2026', rollout(ID)));
  write(path.join(sessions, '2026', '11', rollout(ID)));
  write(path.join(sessions, '2026', '11', '28', 'deeper', rollout(ID)));
  write(path.join(sessions, '2026x', '11', '28', rollout(ID)));
  write(path.join(sessions, '2026', '1', '28', rollout(ID)));
  write(path.join(sessions, '2026', '11', '8', rollout(ID)));
  write(path.join(home, '.codex', rollout(ID)));
  assert.equal(await codex(ID, home), null);
});

test('Codex: a match that is a folder, not a file, is no record', async t => {
  const { home, sessions } = codexHome(t);
  mkdir(path.join(sessions, '2026', '11', '28', rollout(ID)));
  assert.equal(await codex(ID, home), null);
});

test('Codex: a missing sessions folder, a missing home, and a day folder that cannot be listed', async t => {
  const { home, sessions } = codexHome(t);
  assert.equal(await codex(ID, home), null, 'no .codex at all');
  mkdir(path.join(home, '.codex'));
  assert.equal(await codex(ID, home), null, '.codex without sessions');
  assert.equal(await codex(ID, path.join(home, 'nobody')), null, 'a home that does not exist');
  const newest = path.join(sessions, '2026', '11', '28');
  write(path.join(newest, rollout(ID)));
  const file = write(path.join(sessions, '2026', '11', '27', rollout(ID, '2026-11-27T10-00-00')));
  wrap(t, 'readdir', real => async (dir, ...rest) => { if (dir === newest) throw failing('EACCES'); return real(dir, ...rest); });
  assert.deepEqual(await codex(ID, home), { file, format: 'codex' }, 'the unreadable folder is skipped, the next one is looked in');
  fs.promises.readdir = async () => { throw failing('EACCES'); };
  assert.equal(await codex(ID, home), null, 'a sessions folder that cannot be listed');
});

test('Codex: a day folder that is a link to a folder outside is not followed, even when the outside file is a match', async t => {
  const { home, sessions } = codexHome(t);
  const outside = path.join(tmp(t), 'outside');
  write(path.join(outside, rollout(ID)));
  mkdir(path.join(sessions, '2026', '11'));
  const at = path.join(sessions, '2026', '11', '28');
  if (!linkDir(outside, at)) { t.skip(NO_LINK); return; }
  const entry = fs.readdirSync(path.join(sessions, '2026', '11'), { withFileTypes: true }).find(e => e.name === '28');
  assert.ok(entry && !entry.isDirectory() && entry.isSymbolicLink(), 'the link is listed as a link, not as a folder');
  assert.equal(await codex(ID, home), null);
  // Were the listing fooled into taking the link for a folder, the real-path check still keeps the answer inside.
  wrap(t, 'readdir', real => async (dir, options) => {
    const list = await real(dir, options);
    return dir === path.join(sessions, '2026', '11') ? list.map(e => Object.assign(Object.create(Object.getPrototypeOf(e)), e, { isDirectory: () => true })) : list;
  });
  wrap(t, 'lstat', () => fs.promises.stat);
  assert.equal(await codex(ID, home), null);
});

test('Codex: a home that is itself a link (moved to another folder) still works; the answer is inside its real sessions folder', async t => {
  const real = path.join(tmp(t), 'real-codex-home');
  const file = write(path.join(real, 'sessions', '2026', '11', '28', rollout(ID)));
  const linked = path.join(tmp(t), 'linked-codex-home');
  if (!linkDir(real, linked)) { t.skip(NO_LINK); return; }
  assert.deepEqual(await recordOf('codex', ID, { home: tmp(t), env: { CODEX_HOME: linked } }),
    { file: path.join(linked, path.relative(real, file)), format: 'codex' });
});

test('Codex: the cap on folders listed holds; past it the answer is null, not a longer walk', async t => {
  assert.equal(MAX_CODEX_FOLDERS, 5000);
  const { home, sessions } = codexHome(t);
  for (const d of ['05', '04', '03', '02']) write(path.join(sessions, '2026', '11', d, rollout(OTHER, '2026-11-' + d + 'T10-00-00')));
  const file = write(path.join(sessions, '2026', '11', '01', rollout(ID, '2026-11-01T10-00-00')));
  // sessions, 2026, 11, then the day folders 05 .. 01: eight listings reach the file.
  const short = await traced(() => codex(ID, home, { maxCodexFolders: 7 }));
  assert.equal(short.result, null);
  assert.equal(short.calls.filter(c => c.name === 'promises.readdir').length, 7);
  assert.deepEqual(await codex(ID, home, { maxCodexFolders: 8 }), { file, format: 'codex' });
  assert.deepEqual(await codex(ID, home), { file, format: 'codex' }, 'with the default cap');
  assert.deepEqual(await codex(ID, home, { maxCodexFolders: 1e9 }), { file, format: 'codex' }, 'an option above the cap is the cap');
  for (let i = 1; i <= 60; i++) mkdir(path.join(sessions, '2027', '01', String(i).padStart(2, '0')));
  const many = await traced(() => codex(ID, home, { maxCodexFolders: 20 }));
  assert.equal(many.result, null);
  assert.equal(many.calls.filter(c => c.name === 'promises.readdir').length, 20);
});

/* ---------- Grok Build ---------- */

function grokHome(t) {
  const home = tmp(t);
  return { home, sessions: path.join(home, '.grok', 'sessions') };
}
const grok = (id, home, extra = {}) => recordOf('grok', id, { home, env: {}, ...extra });

test('Grok: found from the id under a parent whose name is not the encoded working folder, with the grok format', async t => {
  const { home, sessions } = grokHome(t);
  write(path.join(sessions, encodeURIComponent('C:\\Users\\example\\project'), OTHER, 'updates.jsonl'));
  const file = write(path.join(sessions, 'not-the-encoded-folder', ID, 'updates.jsonl'));
  write(path.join(sessions, 'a-plain-file'));
  const r = await grok(ID, home);
  assert.deepEqual(r, { file, format: 'grok' });
  assert.deepEqual(Object.keys(r), ['file', 'format']);
});

test('Grok: GROK_HOME is honoured, and with it unset <home>/.grok is used', async t => {
  const { home, sessions } = grokHome(t);
  const elsewhere = path.join(tmp(t), 'grok-home');
  const there = write(path.join(elsewhere, 'sessions', 'p', ID, 'updates.jsonl'));
  const here = write(path.join(sessions, 'p', OTHER, 'updates.jsonl'));
  assert.deepEqual(await grok(ID, home, { env: { GROK_HOME: elsewhere } }), { file: there, format: 'grok' });
  assert.equal(await grok(OTHER, home, { env: { GROK_HOME: elsewhere } }), null);
  assert.deepEqual(await grok(OTHER, home, { env: { GROK_HOME: '   ' } }), { file: here, format: 'grok' }, 'a blank GROK_HOME is unset');
  assert.deepEqual(await grok(OTHER, home), { file: here, format: 'grok' });
});

test('Grok: a relative GROK_HOME is made absolute from this process\'s folder, as lib/providers/grok-config.js does', async t => {
  const dir = path.join(tmp(t), 'grok-home');
  const file = write(path.join(dir, 'sessions', 'p', ID, 'updates.jsonl'));
  const relative = path.relative(process.cwd(), dir);
  if (path.isAbsolute(relative)) { t.skip('the temporary folder is on another drive than this process\'s folder'); return; }
  assert.deepEqual(await grok(ID, tmp(t), { env: { GROK_HOME: relative } }), { file: path.resolve(relative, 'sessions', 'p', ID, 'updates.jsonl'), format: 'grok' });
  assert.equal(path.relative(file, path.resolve(relative, 'sessions', 'p', ID, 'updates.jsonl')), '', 'the same file, whatever the case of the drive letter');
});

test('Grok: a session folder without updates.jsonl, or one where it is a folder, is no record', async t => {
  const { home, sessions } = grokHome(t);
  mkdir(path.join(sessions, 'p', ID));
  write(path.join(sessions, 'p', ID, 'other.jsonl'));
  assert.equal(await grok(ID, home), null);
  mkdir(path.join(sessions, 'p', ID, 'updates.jsonl'));
  assert.equal(await grok(ID, home), null);
});

test('Grok: an id that is a prefix of another folder\'s name is not a match; between two candidates the exact one is chosen', async t => {
  const { home, sessions } = grokHome(t);
  write(path.join(sessions, 'a-parent', ID + 'ff', 'updates.jsonl'));
  write(path.join(sessions, 'a-parent', 'x' + ID, 'updates.jsonl'));
  assert.equal(await grok(ID, home), null);
  const file = write(path.join(sessions, 'b-parent', ID, 'updates.jsonl'));
  assert.deepEqual(await grok(ID, home), { file, format: 'grok' });
});

test('Grok: a missing sessions folder, and a parent that cannot be looked in', async t => {
  const { home, sessions } = grokHome(t);
  assert.equal(await grok(ID, home), null);
  mkdir(path.join(home, '.grok'));
  assert.equal(await grok(ID, home), null);
  const blocked = path.join(sessions, 'a-parent', ID);
  write(path.join(blocked, 'updates.jsonl'));
  const file = write(path.join(sessions, 'b-parent', ID, 'updates.jsonl'));
  wrap(t, 'lstat', real => async (p, ...rest) => { if (p === blocked) throw failing('EACCES'); return real(p, ...rest); });
  assert.deepEqual(await grok(ID, home), { file, format: 'grok' }, 'the parent that cannot be looked in is skipped');
  wrap(t, 'readdir', () => async () => { throw failing('EPERM'); });
  assert.equal(await grok(ID, home), null, 'a sessions folder that cannot be listed');
});

test('Grok: a session folder or a parent that is a link to a folder outside is not followed', async t => {
  const { home, sessions } = grokHome(t);
  const outside = path.join(tmp(t), 'outside');
  write(path.join(outside, 'updates.jsonl'));
  write(path.join(outside, ID, 'updates.jsonl'));
  mkdir(path.join(sessions, 'a-parent'));
  if (!linkDir(outside, path.join(sessions, 'a-parent', ID))) { t.skip(NO_LINK); return; }
  assert.ok(fs.lstatSync(path.join(sessions, 'a-parent', ID)).isSymbolicLink(), 'lstat sees the link as a link');
  assert.equal(await grok(ID, home), null, 'a session folder that is a link');
  assert.ok(linkDir(outside, path.join(sessions, 'b-parent')));
  const entry = fs.readdirSync(sessions, { withFileTypes: true }).find(e => e.name === 'b-parent');
  assert.ok(entry && !entry.isDirectory(), 'a parent that is a link is not listed as a folder');
  assert.equal(await grok(ID, home), null, 'a parent that is a link');
  // Only the real-path check stands between a link at the id level and the answer once lstat is fooled.
  wrap(t, 'lstat', () => fs.promises.stat);
  assert.equal(await grok(ID, home), null, 'with lstat following links, the real-path check refuses');
});

test('Grok: the cap on parents holds; past it the answer is null', async t => {
  assert.equal(MAX_GROK_PARENTS, 5000);
  const { home, sessions } = grokHome(t);
  for (const p of ['p1', 'p2', 'p3', 'p4']) write(path.join(sessions, p, OTHER + p, 'updates.jsonl'));
  const file = write(path.join(sessions, 'p5', ID, 'updates.jsonl'));
  const short = await traced(() => grok(ID, home, { maxGrokParents: 4 }));
  assert.equal(short.result, null);
  assert.equal(short.calls.filter(c => c.name === 'promises.lstat').length, 4, 'one lstat for each parent looked in');
  assert.deepEqual(await grok(ID, home, { maxGrokParents: 5 }), { file, format: 'grok' });
  assert.deepEqual(await grok(ID, home), { file, format: 'grok' });
});

/* ---------- Antigravity ---------- */

const logs = (home, root, id = ID) => path.join(home, '.gemini', root, 'brain', id, '.system_generated', 'logs');
const agy = (id, home, extra = {}) => recordOf('antigravity', id, { home, env: {}, ...extra });

test('Antigravity: found from the id, with the antigravity format; the full transcript over the cut one', async t => {
  const home = tmp(t);
  const full = write(path.join(logs(home, 'antigravity-cli'), 'transcript_full.jsonl'));
  write(path.join(logs(home, 'antigravity-cli'), 'transcript.jsonl'));
  const r = await agy(ID, home);
  assert.deepEqual(r, { file: full, format: 'antigravity' });
  assert.deepEqual(Object.keys(r), ['file', 'format']);
});

test('Antigravity: the cut transcript alone is found when the full one is absent', async t => {
  const home = tmp(t);
  const cut = write(path.join(logs(home, 'antigravity-cli'), 'transcript.jsonl'));
  assert.deepEqual(await agy(ID, home), { file: cut, format: 'antigravity' });
});

test('Antigravity: antigravity-cli before antigravity before antigravity-ide', async t => {
  const home = tmp(t);
  const ide = write(path.join(logs(home, 'antigravity-ide'), 'transcript_full.jsonl'));
  assert.deepEqual(await agy(ID, home), { file: ide, format: 'antigravity' });
  const app = write(path.join(logs(home, 'antigravity'), 'transcript.jsonl'));
  assert.deepEqual(await agy(ID, home), { file: app, format: 'antigravity' });
  const cli = write(path.join(logs(home, 'antigravity-cli'), 'transcript.jsonl'));
  assert.deepEqual(await agy(ID, home), { file: cli, format: 'antigravity' }, 'the CLI\'s cut file before the app\'s full one');
});

test('Antigravity: a .db beside the transcripts is never named, opened or returned', async t => {
  const home = tmp(t);
  const dir = logs(home, 'antigravity-cli');
  write(path.join(dir, 'transcript.db'));
  write(path.join(dir, 'transcript_full.db'));
  write(path.join(path.dirname(dir), 'state.db'));
  const none = await traced(() => agy(ID, home));
  assert.equal(none.result, null, 'only .db files: no record');
  const full = write(path.join(dir, 'transcript_full.jsonl'));
  const found = await traced(() => agy(ID, home));
  assert.deepEqual(found.result, { file: full, format: 'antigravity' });
  for (const c of [...none.calls, ...found.calls]) assert.ok(!c.at.endsWith('.db'), c.name + ' named a .db file');
  assert.ok(!found.calls.some(c => c.name.includes('open') || c.name.includes('readFile')), 'no file is opened');
});

test('Antigravity: the home is the option, else ' + HOME_VAR + ' from the environment', async t => {
  const home = tmp(t);
  const full = write(path.join(logs(home, 'antigravity'), 'transcript_full.jsonl'));
  assert.deepEqual(await recordOf('antigravity', ID, { env: { [HOME_VAR]: home } }), { file: full, format: 'antigravity' });
  assert.equal(await recordOf('antigravity', ID, { home: tmp(t), env: { [HOME_VAR]: home } }), null, 'the option wins');
});

test('Antigravity: a conversation folder without the logs, and one that is a link outside, are no record', async t => {
  const home = tmp(t);
  mkdir(path.join(home, '.gemini', 'antigravity-cli', 'brain', ID));
  write(path.join(home, '.gemini', 'antigravity-cli', 'brain', ID, 'transcript_full.jsonl'));
  assert.equal(await agy(ID, home), null, 'at the wrong depth');
  const outside = path.join(tmp(t), 'outside');
  write(path.join(outside, '.system_generated', 'logs', 'transcript_full.jsonl'));
  mkdir(path.join(home, '.gemini', 'antigravity', 'brain'));
  if (!linkDir(outside, path.join(home, '.gemini', 'antigravity', 'brain', ID))) { t.skip(NO_LINK); return; }
  assert.equal(await agy(ID, home), null, 'a conversation folder that is a link');
  wrap(t, 'lstat', () => fs.promises.stat);
  assert.equal(await agy(ID, home), null, 'with lstat following links, the real-path check refuses');
});

/* ---------- refusals ---------- */

test('refusals: an unknown agent, a bad id, or a home that is not a local absolute path touch no disk at all', async t => {
  const good = tmp(t);
  write(path.join(good, '.codex', 'sessions', '2026', '11', '28', rollout(ID)));
  const FOREIGN = process.platform === 'win32' ? '/home/example' : 'C:\\Users\\example';
  const cases = [];
  for (const agent of ['claude', 'Codex', 'CODEX', 'codex ', '', 'constructor', '__proto__', 'toString', null, undefined, 42, ['codex']]) {
    cases.push([agent, ID, { home: good, env: {} }]);
  }
  for (const id of ['..', '.', 'a/b', 'a\\b', 'a:b', 'C:', '../' + ID, ID + '/..', 'a.b', 'a b', 'x'.repeat(129), '', null, undefined, 7, [ID]]) {
    for (const agent of AGENTS) cases.push([agent, id, { home: good, env: {} }]);
  }
  const badHomes = ['\\\\server\\share', '//server/x', '\\\\?\\C:\\example', '\\\\.\\pipe\\example', 'relative/home', 'relative\\home', '.',
    FOREIGN, good + '\0x', path.join(good, 'a'.repeat(C_MAX_PATH() + 1)), 42, null];
  for (const home of badHomes) for (const agent of AGENTS) {
    if (agent === 'antigravity' && !home) continue;   // an empty home means "not given" there, as in lib/providers/antigravity.js
    cases.push([agent, ID, { home, env: {} }]);
  }
  for (const home of ['', 'relative']) cases.push(['codex', ID, { home, env: {} }], ['grok', ID, { home, env: {} }]);
  for (const bad of ['\\\\server\\share', '//server/x', FOREIGN, 'relative-codex-home']) cases.push(['codex', ID, { home: good, env: { CODEX_HOME: bad } }]);
  // GROK_HOME is made absolute with path.resolve, as lib/providers/grok-config.js does, so a foreign-form or relative value
  // becomes a local folder and is looked in. Only a value that is still on another machine afterwards is a refusal.
  for (const bad of ['//server/x', ...(process.platform === 'win32' ? ['\\\\server\\share'] : [])]) cases.push(['grok', ID, { home: good, env: { GROK_HOME: bad } }]);
  for (const bad of ['\\\\server\\share', '//server/x', FOREIGN, 'relative']) cases.push(['antigravity', ID, { env: { [HOME_VAR]: bad } }]);
  const { result, calls } = await traced(async () => {
    const out = [];
    for (const [agent, id, options] of cases) out.push(await recordOf(agent, id, options));
    return out;
  });
  assert.deepEqual(calls, [], 'no fs call of any kind');
  result.forEach((r, i) => assert.equal(r, null, 'case ' + i + ' (' + String(cases[i][0]) + ') gives null'));
  assert.deepEqual(await codex(ID, good), { file: path.join(good, '.codex', 'sessions', '2026', '11', '28', rollout(ID)), format: 'codex' }, 'the good home works');
});
function C_MAX_PATH() { return require('../lib/contract.js').MAX_PATH; }

test('AGENTS is the three tools, and cannot be changed by a caller', () => {
  assert.deepEqual([...AGENTS], ['codex', 'grok', 'antigravity']);
  assert.ok(Object.isFrozen(AGENTS));
});

/* ---------- never throws, never logs ---------- */

test('never throws or rejects, logs nothing, and no error text comes out: options that throw, odd answers from the disk', async t => {
  const said = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    const real = console[m];
    console[m] = (...args) => said.push(args);
    t.after(() => { console[m] = real; });
  }
  const home = tmp(t);
  write(path.join(home, '.codex', 'sessions', '2026', '11', '28', rollout(ID)));
  write(path.join(home, '.grok', 'sessions', 'p', ID, 'updates.jsonl'));
  write(path.join(logs(home, 'antigravity-cli'), 'transcript_full.jsonl'));
  const throwing = { get env() { throw new Error('CANARY-ERROR-TEXT'); }, home };
  const homeThrows = { env: {}, get home() { throw new Error('CANARY-ERROR-TEXT'); } };
  // No home here: with a home given, Antigravity never reads the environment (as in lib/providers/antigravity.js).
  // Each tool reads the environment before the disk, so the throw comes first.
  const envThrows = { env: new Proxy({}, { get() { throw new Error('CANARY-ERROR-TEXT'); } }) };
  const answers = [];
  for (const agent of AGENTS) {
    answers.push(await recordOf(agent, ID, throwing), await recordOf(agent, ID, homeThrows), await recordOf(agent, ID, envThrows));
  }
  const odd = [
    ['readdir', async () => 42], ['readdir', async () => [null, 7, { name: 5 }]], ['readdir', async () => { throw failing('EIO'); }],
    ['lstat', async () => null], ['lstat', async () => { throw failing('EIO'); }], ['lstat', async () => ({ isFile: () => { throw new Error('CANARY-ERROR-TEXT'); }, isDirectory: () => true })],
    ['realpath', async () => { throw failing('EIO'); }], ['realpath', async () => 42], ['realpath', async () => '\\\\server\\share\\x']
  ];
  for (const [name, fake] of odd) {
    const real = fs.promises[name];
    fs.promises[name] = fake;
    // Antigravity's paths are fixed, so it lists no folder: an odd readdir is only Codex's and Grok's concern.
    const users = name === 'readdir' ? ['codex', 'grok'] : AGENTS;
    try { for (const agent of users) answers.push(await recordOf(agent, ID, { home, env: {} })); } finally { fs.promises[name] = real; }
  }
  answers.forEach((r, i) => assert.equal(r, null, 'answer ' + i));
  assert.deepEqual(said, [], 'nothing was logged');
  for (const agent of AGENTS) assert.equal((await recordOf(agent, ID, { home, env: {} })).format, agent, 'and with the disk back, each is found');
});
