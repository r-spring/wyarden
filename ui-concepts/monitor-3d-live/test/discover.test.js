// Discovery: the Claude Code config folders, and the live sessions their session files name.
// Everything runs against a temporary fake home; every name, id and path in it is invented.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { claudeConfigDirs, liveClaudeSessions, pidAlive, transcriptPath } = require('../lib/discover.js');
const { lexical } = require('../lib/contract.js');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const mkdir = p => { fs.mkdirSync(p, { recursive: true }); return p; };
const sessionFile = (dir, name, body) => {
  mkdir(path.join(dir, 'sessions'));
  fs.writeFileSync(path.join(dir, 'sessions', name), typeof body === 'string' ? body : JSON.stringify(body));
};
const ID = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const good = (n, extra = {}) => ({ pid: 1000 + n, sessionId: ID(n), cwd: '/home/dev/example-' + n, startedAt: 1767000000000, procStart: '123456789012345678',
  version: '2.1.0', kind: 'interactive', entrypoint: 'cli', name: 'example-' + n, nameSource: 'derived', status: 'idle',
  updatedAt: 1767000001000, statusUpdatedAt: 1767000001000, ...extra });
const aliveSet = pids => pid => pids.includes(pid);

function fakeHome(t) {
  const home = tmp(t);
  mkdir(path.join(home, '.claude'));
  mkdir(path.join(home, '.claude-accounts', 'b-account'));
  mkdir(path.join(home, '.claude-accounts', 'a@example.com'));
  mkdir(path.join(home, '.claude-accounts', 'a@example.com.lock'));
  fs.writeFileSync(path.join(home, '.claude-accounts', 'not-a-folder.txt'), 'invented');
  const envDir = mkdir(path.join(home, 'elsewhere', 'config'));
  return { home, envDir };
}

test('the three kinds of config folder, in order; a .lock folder and a plain file are not accounts', t => {
  const { home, envDir } = fakeHome(t);
  assert.deepEqual(claudeConfigDirs({ home, env: { CLAUDE_CONFIG_DIR: envDir } }), [
    path.join(home, '.claude'),
    path.join(home, '.claude-accounts', 'a@example.com'),
    path.join(home, '.claude-accounts', 'b-account'),
    envDir
  ]);
});

test('only folders that exist; no accounts folder; an environment folder that does not exist', t => {
  const home = tmp(t);
  assert.deepEqual(claudeConfigDirs({ home, env: {} }), []);
  assert.deepEqual(claudeConfigDirs({ home, env: { CLAUDE_CONFIG_DIR: path.join(home, 'nowhere') } }), []);
  mkdir(path.join(home, '.claude-accounts', 'only'));
  assert.deepEqual(claudeConfigDirs({ home, env: { CLAUDE_CONFIG_DIR: '' } }), [path.join(home, '.claude-accounts', 'only')]);
});

test('the environment folder is not listed twice: same folder, trailing separator, or (Windows) other case', t => {
  const { home } = fakeHome(t);
  const account = path.join(home, '.claude-accounts', 'b-account');
  const expected = [path.join(home, '.claude'), path.join(home, '.claude-accounts', 'a@example.com'), account];
  for (const spelt of [account, account + path.sep, account + path.sep + path.sep, path.join(home, '.claude') + path.sep]) {
    assert.deepEqual(claudeConfigDirs({ home, env: { CLAUDE_CONFIG_DIR: spelt } }), expected, spelt);
  }
  // Windows ignores case, so this is the same folder. Elsewhere the other-case path does not exist and is left out.
  // Either way it is listed once.
  assert.deepEqual(claudeConfigDirs({ home, env: { CLAUDE_CONFIG_DIR: account.toUpperCase() } }), expected);
});

test('the returned folders have no trailing separator', t => {
  const home = tmp(t);
  const envDir = mkdir(path.join(home, 'cfg'));
  assert.deepEqual(claudeConfigDirs({ home, env: { CLAUDE_CONFIG_DIR: envDir + path.sep } }), [lexical(envDir)]);
});

test('a session is listed only when its file is whole, its fields have the right types, and its process is alive', t => {
  const dir = tmp(t);
  sessionFile(dir, '1001.json', good(1, { status: 'busy' }));
  sessionFile(dir, '1002.json', good(2));                                  // its process is gone
  sessionFile(dir, '1003.json', JSON.stringify(good(3)).slice(0, 40));      // half-written
  sessionFile(dir, '1004.json', good(4, { pid: '1004' }));                  // pid a string
  sessionFile(dir, '1005.json', good(5, { sessionId: 5 }));                 // id a number
  sessionFile(dir, '1006.json', good(6, { cwd: undefined }));               // no folder
  sessionFile(dir, '1007.json', good(7, { sessionId: '../../outside' }));   // an id that would leave the folder
  sessionFile(dir, '1008.json', '[1,2,3]');
  sessionFile(dir, '1009.json', 'null');
  sessionFile(dir, '1010.txt', good(10));                                   // not a .json file
  sessionFile(dir, '1011.json', good(11, { status: 'thinking', waitingFor: 42, procStart: 'not digits', statusUpdatedAt: 'soon' }));
  const all = [1001, 1003, 1004, 1005, 1006, 1007, 1010, 1011];
  const list = liveClaudeSessions([dir], { alive: aliveSet(all) });
  assert.deepEqual(list.map(s => s.session), [ID(1), ID(11)]);
  assert.deepEqual(list[0], {
    agent: 'claude', session: ID(1), key: 'claude:' + ID(1), cwd: '/home/dev/example-1', pid: 1001, status: 'busy',
    waitingFor: undefined, updatedAt: 1767000001000, statusUpdatedAt: 1767000001000, procStart: '123456789012345678', entry: 'cli',
    title: undefined,                                                      // its name is the CLI's placeholder, which is no title
    configDir: dir, transcript: path.join(dir, 'projects', '-home-dev-example-1', ID(1) + '.jsonl')
  });
  assert.equal(list[1].status, undefined, 'an unknown status is not passed on');
  assert.equal(list[1].waitingFor, undefined);
  assert.equal(list[1].procStart, undefined);
  assert.equal(list[1].statusUpdatedAt, undefined);
});

test('a session\'s title is the name its tab shows: given when the CLI or the owner named it, cleaned and cut', t => {
  const dir = tmp(t);
  sessionFile(dir, '1001.json', good(1, { name: 'Fix the checkout total', nameSource: 'auto' }));
  sessionFile(dir, '1002.json', good(2, { name: 'My own name for it', nameSource: 'user' }));
  sessionFile(dir, '1003.json', good(3, { name: 'example-3-1f', nameSource: 'derived' }));          // the placeholder before a title exists
  sessionFile(dir, '1004.json', good(4, { name: 42, nameSource: 'auto' }));
  sessionFile(dir, '1005.json', good(5, { name: 'A title\twith a tab and a line\nbreak ' + 'x'.repeat(200), nameSource: 'auto' }));
  sessionFile(dir, '1006.json', good(6, { name: '   ', nameSource: 'auto' }));
  sessionFile(dir, '1007.json', good(7, { name: 'No source given' , nameSource: undefined }));
  const titles = liveClaudeSessions([dir], { alive: () => true }).map(s => s.title);
  assert.equal(titles[0], 'Fix the checkout total');
  assert.equal(titles[1], 'My own name for it');
  assert.equal(titles[2], undefined);
  assert.equal(titles[3], undefined);
  assert.equal(titles[4].length, 80);
  assert.ok(titles[4].startsWith('A title with a tab and a line break'), 'control characters become spaces');
  assert.equal(titles[5], undefined, 'a name of spaces is no title');
  assert.equal(titles[6], 'No source given');
});

test('where a session runs: the chat panel, a terminal or no terminal is passed on; any other value is not', t => {
  const dir = tmp(t);
  sessionFile(dir, '1001.json', good(1, { entrypoint: 'claude-vscode' }));
  sessionFile(dir, '1002.json', good(2, { entrypoint: 'cli' }));
  sessionFile(dir, '1003.json', good(3, { entrypoint: 'sdk-cli' }));
  sessionFile(dir, '1004.json', good(4, { entrypoint: 'example-new-place' }));
  sessionFile(dir, '1005.json', good(5, { entrypoint: 7 }));
  sessionFile(dir, '1006.json', good(6, { entrypoint: undefined }));
  sessionFile(dir, '1007.json', good(7, { entrypoint: 'CLI' }));
  const list = liveClaudeSessions([dir], { alive: () => true });
  assert.deepEqual(list.map(s => [s.session, s.entry]), [
    [ID(1), 'claude-vscode'], [ID(2), 'cli'], [ID(3), 'sdk-cli'],
    [ID(4), undefined], [ID(5), undefined], [ID(6), undefined], [ID(7), undefined]
  ]);
  assert.ok(list.every(s => Object.hasOwn(s, 'entry')), 'the key is there, undefined when the value is not known');
});

test('waiting and waitingFor are passed on', t => {
  const dir = tmp(t);
  sessionFile(dir, '1001.json', good(1, { status: 'waiting', waitingFor: 'permission for Bash' }));
  const [s] = liveClaudeSessions([dir], { alive: () => true });
  assert.equal(s.status, 'waiting');
  assert.equal(s.waitingFor, 'permission for Bash');
});

test('a missing sessions folder, a missing config folder, and bad arguments give nothing', t => {
  const dir = tmp(t);
  assert.deepEqual(liveClaudeSessions([dir, path.join(dir, 'gone')], { alive: () => true }), []);
  assert.deepEqual(liveClaudeSessions(undefined), []);
  assert.deepEqual(liveClaudeSessions([null, 7, ''], { alive: () => true }), []);
  sessionFile(dir, '1001.json', good(1));
  assert.deepEqual(liveClaudeSessions([dir], { alive: () => { throw new Error('invented'); } }), [], 'an alive check that throws means not alive');
});

test('the transcript path encodes a Windows-form and a POSIX-form cwd the same way', () => {
  const win = transcriptPath('C:\\Users\\dev\\.claude', 'C:\\Work\\my app.v2', ID(1));
  assert.equal(win, 'C:\\Users\\dev\\.claude\\projects\\C--Work-my-app-v2\\' + ID(1) + '.jsonl');
  const posix = transcriptPath('/home/dev/.claude', '/home/dev/my_app.v2', ID(2));
  assert.equal(posix, '/home/dev/.claude/projects/-home-dev-my-app-v2/' + ID(2) + '.jsonl');
  const unicode = transcriptPath('/home/dev/.claude', '/home/dev/caf\u00e9', ID(3));
  assert.equal(unicode, '/home/dev/.claude/projects/-home-dev-caf-/' + ID(3) + '.jsonl');
});

test('the transcript path in a listed session, for a Windows-form cwd', t => {
  const dir = tmp(t);
  sessionFile(dir, '1001.json', good(1, { cwd: 'D:\\Projects\\example' }));
  const [s] = liveClaudeSessions([dir], { alive: () => true });
  assert.equal(s.transcript, path.join(dir, 'projects', 'D--Projects-example', ID(1) + '.jsonl'));
});

test('the same session in two folders is listed once: the newer statusUpdatedAt wins, else the first', t => {
  const a = tmp(t), b = tmp(t);
  sessionFile(a, '1001.json', good(1, { statusUpdatedAt: 100, updatedAt: 900, status: 'idle' }));
  sessionFile(b, '1001.json', good(1, { statusUpdatedAt: 200, updatedAt: 200, status: 'busy' }));
  let list = liveClaudeSessions([a, b], { alive: () => true });
  assert.equal(list.length, 1);
  assert.equal(list[0].configDir, b);
  assert.equal(list[0].status, 'busy');
  list = liveClaudeSessions([b, a], { alive: () => true });
  assert.equal(list[0].configDir, b, 'the order of the folders does not matter');
  sessionFile(a, '2002.json', good(2, { statusUpdatedAt: undefined, updatedAt: undefined }));
  sessionFile(b, '2002.json', good(2, { statusUpdatedAt: undefined, updatedAt: undefined }));
  list = liveClaudeSessions([a, b], { alive: () => true });
  assert.equal(list.find(s => s.session === ID(2)).configDir, a, 'no time on either: the first');
  sessionFile(a, '3003.json', good(3, { statusUpdatedAt: undefined, updatedAt: 50 }));
  sessionFile(b, '3003.json', good(3, { statusUpdatedAt: undefined, updatedAt: 60 }));
  list = liveClaudeSessions([a, b], { alive: () => true });
  assert.equal(list.find(s => s.session === ID(3)).configDir, b, 'updatedAt when there is no statusUpdatedAt');
});

test('pidAlive: this process is alive; a pid that cannot exist is not; EPERM means alive', t => {
  assert.equal(pidAlive(process.pid), true);
  for (const bad of [0, -1, 1.5, NaN, '123', undefined]) assert.equal(pidAlive(bad), false, String(bad));
  assert.equal(pidAlive(0x7ffffffc), false);
  const real = process.kill;
  t.after(() => { process.kill = real; });
  process.kill = () => { const e = new Error('invented'); e.code = 'EPERM'; throw e; };
  assert.equal(pidAlive(4242), true);
  process.kill = () => { const e = new Error('invented'); e.code = 'ESRCH'; throw e; };
  assert.equal(pidAlive(4242), false);
});

test('discovery never starts a child process', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'discover.js'), 'utf8');
  assert.ok(!/child_process/.test(source));
});
