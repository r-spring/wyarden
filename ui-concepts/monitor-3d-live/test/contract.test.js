// The shared rules: the hub's file, collector addresses, paths of both forms, and the text that may be kept.
// Every path and name here is invented.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../lib/contract.js');

const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wym-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('the hub file is made once and never replaced', t => {
  const home = path.join(temp(t), 'monitor');
  assert.equal(C.readHubFile(home), null);
  const first = C.ensureHubFile(home);
  assert.ok(C.validHub(first));
  assert.ok(first.port >= 21000 && first.port < 30000, 'below every system\'s temporary ports: ' + first.port);
  assert.notEqual(first.ingest, first.control);
  assert.deepEqual(C.ensureHubFile(home), first);
  assert.deepEqual(C.readHubFile(home), first);
  if (process.platform !== 'win32') assert.equal(fs.statSync(C.hubFile(home)).mode & 0o077, 0, 'only the owner can read the tokens');
});

test('a hub file that cannot be read is an error, not a new file', t => {
  const home = temp(t);
  fs.writeFileSync(C.hubFile(home), '{"v":1,"port":"x"}');
  assert.equal(C.readHubFile(home), null);
  assert.throws(() => C.ensureHubFile(home), /cannot be read/);
  assert.equal(fs.readFileSync(C.hubFile(home), 'utf8'), '{"v":1,"port":"x"}', 'it was left as it was');
});

test('the monitor\'s folder can be moved for tests', () => {
  assert.equal(C.monitorHome({ WYARDEN_MONITOR_HOME: '/tmp/example-home' }), '/tmp/example-home');
  assert.equal(C.monitorHome({}), path.join(os.homedir(), '.wyarden-monitor'));
});

test('a collector address is recognised whatever its port or token, and nothing else is', () => {
  const hub = { port: 21007, ingest: C.token() };
  const url = C.hookUrl(hub, 'claude');
  assert.equal(url, 'http://127.0.0.1:21007/wyarden-monitor/h/' + hub.ingest + '/claude');
  assert.equal(C.isHookUrl(url), true);
  assert.equal(C.isHookUrl('http://127.0.0.1:9/wyarden-monitor/h/abc_DEF-123/claude'), true, 'an older port and token');
  for (const other of ['http://127.0.0.1:21007/other/h/x/claude', 'http://localhost:21007/wyarden-monitor/h/x/claude', 'https://127.0.0.1:21007/wyarden-monitor/h/x/claude',
    'http://127.0.0.1:21007/wyarden-monitor/h/x/claude?x=1', 'http://127.0.0.1:21007/wyarden-monitor/h/x/claude/more', 'http://127.0.0.1.example.com:21007/wyarden-monitor/h/x/claude', '', null, 7])
    assert.equal(C.isHookUrl(other), false, String(other));
});

test('a path\'s form is read from the path', () => {
  assert.equal(C.isWinPath('C:\\Users\\example'), true);
  assert.equal(C.isWinPath('c:/Users/example'), true);
  assert.equal(C.isWinPath('\\\\server\\share\\x'), true);
  assert.equal(C.isWinPath('/home/example'), false);
  assert.equal(C.isAbsolute('src/a.js'), false);
  assert.equal(C.flavour('C:\\x'), path.win32);
  assert.equal(C.flavour('/x'), path.posix);
  assert.equal(C.lexical('C:\\Users\\example\\proj\\..\\other\\'), 'C:\\Users\\example\\other');
  assert.equal(C.lexical('/home/example//proj/./src/'), '/home/example/proj/src');
  assert.equal(C.lexical('C:\\'), 'C:\\');
  assert.equal(C.lexical('/'), '/');
});

test('relativeIn: both forms, on either system', () => {
  assert.equal(C.relativeIn('C:\\Users\\example\\proj', 'c:\\users\\EXAMPLE\\proj\\src\\a.js'), 'src/a.js', 'a Windows path ignores case');
  assert.equal(C.relativeIn('C:\\Users\\example\\proj', 'C:/Users/example/proj/src/a.js'), 'src/a.js', 'either slash');
  assert.equal(C.relativeIn('C:\\Users\\example\\proj\\', 'C:\\Users\\example\\proj'), '.');
  assert.equal(C.relativeIn('C:\\Users\\example\\proj', 'C:\\Users\\example\\project\\a.js'), null, 'a folder whose name only starts the same');
  assert.equal(C.relativeIn('C:\\Users\\example\\proj', 'D:\\Users\\example\\proj\\a.js'), null);
  assert.equal(C.relativeIn('/home/example/proj', '/home/example/proj/src/a.js'), 'src/a.js');
  assert.equal(C.relativeIn('/home/example/proj', '/home/example/proj/..hidden/a'), '..hidden/a', 'a name that starts with two dots is not a way out');
  assert.equal(C.relativeIn('/home/example/proj', '/home/example/proj/../other/a'), null);
  assert.equal(C.relativeIn('/home/example/proj', '/home/example/projx'), null);
  assert.equal(C.relativeIn('/', '/etc/hosts'), 'etc/hosts');
  assert.equal(C.relativeIn('/home/example/proj', 'C:\\home\\example\\proj\\a'), null, 'the two forms never contain each other');
  assert.equal(C.relativeIn('/home/example/proj', 'src/a.js'), null, 'a relative path is not judged');
  if (process.platform === 'linux') assert.equal(C.relativeIn('/home/example/Proj', '/home/example/proj/a'), null, 'case counts on Linux');
  assert.equal(C.isInside('/a/b', '/a/b/c'), true);
});

test('a workspace key is the same however the folder is spelled', t => {
  const dir = temp(t);
  const key = C.wsKey(dir);
  assert.match(key, /^[0-9a-f]{12}$/);
  assert.equal(C.wsKey(dir + path.sep), key);
  assert.equal(C.wsKey(path.join(dir, 'x', '..')), key);
  if (process.platform === 'win32') assert.equal(C.wsKey(dir.toUpperCase()), key);
  assert.equal(C.wsKey('C:\\Users\\Example\\Proj'), C.wsKey('c:\\users\\example\\proj\\'), 'a Windows path that is not on this machine');
  assert.notEqual(C.wsKey('/home/example/a'), C.wsKey('/home/example/b'));
});

test('a workspace is what one window has open: one key for its folders, in any order and spelling', () => {
  const a = 'C:\\Users\\example\\alpha', b = 'C:\\Users\\example\\beta', c = '/home/example/gamma';
  assert.equal(C.windowKey([a]), C.wsKey(a), 'a window with one folder keeps that folder\'s key');
  const two = C.windowKey([a, b]);
  assert.match(two, /^[0-9a-f]{12}$/);
  assert.notEqual(two, C.wsKey(a));
  assert.notEqual(two, C.wsKey(b));
  assert.equal(C.windowKey([b, a]), two, 'the order of the folders does not matter');
  assert.equal(C.windowKey(['c:\\users\\EXAMPLE\\alpha\\', b, a]), two, 'nor their spelling, nor a folder named twice');
  assert.notEqual(C.windowKey([a, b, c]), two);
  assert.equal(C.windowKey([a, b]), C.windowKeyOf([C.wsKey(b), C.wsKey(a)]), 'the hub, which holds keys, makes the same one');
  assert.equal(C.windowKey([]), '');
  assert.equal(C.windowKey(['relative/path', 7, null]), '', 'what is not a folder path is not counted');
  assert.equal(C.windowKey([a, 'relative/path']), C.wsKey(a));
  assert.equal(C.windowKeyOf(['not a key', C.wsKey(a)]), C.wsKey(a));
  assert.equal(C.windowKey('not a list'), '');
});

test('a window is named as its title shows it', () => {
  assert.equal(C.windowName('Example Shop (Workspace)'), 'Example Shop');
  assert.equal(C.windowName('example-folder'), 'example-folder');
  assert.equal(C.windowName('Untitled (Workspace)'), 'Untitled');
  assert.equal(C.windowName('A (Workspace) of mine'), 'A (Workspace) of mine', 'only at the end');
  assert.equal(C.windowName(''), '');
  assert.equal(C.windowName(null), '');
  assert.equal(C.windowName('x'.repeat(300)).length, C.LIMITS.name);
});

test('the session root is the nearest folder with a .git entry, else the folder itself', t => {
  const base = temp(t);
  const repo = path.join(base, 'repo'), deep = path.join(repo, 'src', 'deep'), tree = path.join(repo, '.wt', 'card');
  for (const dir of [deep, tree]) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'));
  fs.writeFileSync(path.join(tree, '.git'), 'gitdir: elsewhere\n');       // a worktree has a file, not a folder
  assert.equal(C.sessionRoot(deep), repo);
  assert.equal(C.sessionRoot(repo), repo);
  assert.equal(C.sessionRoot(tree), tree, 'a worktree inside a repository is its own root');
  // The temporary folder may itself sit inside a repository, so "no repository above" is shown with a folder that is on no disk.
  const plain = process.platform === 'win32' ? 'C:\\wym-no-such-folder-7c1e\\plain\\sub' : '/wym-no-such-folder-7c1e/plain/sub';
  assert.equal(C.sessionRoot(plain), plain, 'no repository above: the folder itself');
  const info = C.rootInfo(deep);
  assert.equal(info.root, repo); assert.equal(info.name, 'repo'); assert.equal(info.ws, C.wsKey(repo));
  assert.equal(C.rootInfo(deep), info, 'cached');
  assert.equal(C.rootInfo('relative/path'), null);
  const other = process.platform === 'win32' ? '/home/example/proj/src' : 'C:\\Users\\example\\proj\\src';
  assert.equal(C.sessionRoot(other), other, 'a path of the other system\'s form is its own root, and nothing is read');
});

test('keptPath: relative inside the root, the base name alone outside it', () => {
  const win = { root: 'C:\\Users\\example\\proj', real: 'C:\\Users\\example\\proj' };
  assert.equal(C.keptPath(win, 'C:\\Users\\example\\proj', 'C:\\Users\\example\\proj\\src\\a.js'), 'src/a.js');
  assert.equal(C.keptPath(win, 'C:\\Users\\example\\proj\\src', 'lib\\b.js'), 'src/lib/b.js', 'a relative path is taken from the cwd');
  assert.deepEqual(C.keptPath(win, 'C:\\Users\\example\\proj', 'C:\\Users\\example\\secret\\keys.txt'), { outside: true, name: 'keys.txt' });
  const nix = { root: '/home/example/proj', real: '/srv/data/proj' };
  assert.equal(C.keptPath(nix, '/home/example/proj', '/srv/data/proj/a.js'), 'a.js', 'the real path of the root counts too');
  assert.deepEqual(C.keptPath(nix, '/home/example/proj', '/etc/passwd'), { outside: true, name: 'passwd' });
  assert.equal(C.keptPath(nix, '/home/example/proj', '/home/example/proj'), '.');
  assert.equal(C.keptPath(nix, '/home/example/proj', ''), null);
  assert.equal(C.keptPath(nix, '/home/example/proj', 42), null);
  assert.equal(C.keptPath(null, '/x', '/x/a'), null);
  const long = C.keptPath(nix, '/home/example/proj', '/home/example/proj/' + 'a'.repeat(900));
  assert.equal(long.length, C.LIMITS.path);
});

test('text that may be kept: no control characters, no query, no user', () => {
  const bell = String.fromCharCode(7), sep = String.fromCharCode(0x2028), esc = String.fromCharCode(27);
  assert.equal(C.cleanText(' a' + bell + 'b' + sep + 'c' + esc + '[31m ', 40), 'a b c [31m');
  assert.equal(C.cleanName('x'.repeat(200)).length, C.LIMITS.name);
  assert.equal(C.cleanText(null, 5), '');
  assert.equal(C.cleanUrl('https://user:secret@example.com:8443/docs/page?token=abc#part'), 'https://example.com:8443/docs/page');
  assert.equal(C.cleanUrl('http://example.org'), 'http://example.org/');
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url', '', null, 5]) assert.equal(C.cleanUrl(bad), null, String(bad));
  assert.match(C.inputHash('Read', { file_path: '/x' }), /^[0-9a-f]{8}$/);
  assert.equal(C.inputHash('Read', { file_path: '/x' }), C.inputHash('Read', { file_path: '/x' }));
  assert.notEqual(C.inputHash('Read', { file_path: '/x' }), C.inputHash('Read', { file_path: '/y' }));
  const loop = {}; loop.self = loop;
  assert.match(C.inputHash('Loop', loop), /^[0-9a-f]{8}$/, 'an input that cannot be written still gives a hash');
  assert.notEqual(C.inputHash('Bash', { command: 'ls' }, 'salt-one'), C.inputHash('Bash', { command: 'ls' }, 'salt-two'), 'a salt keeps a guess from being checked');
  assert.equal(C.inputHash('Bash', { command: 'ls' }, 'salt-one'), C.inputHash('Bash', { command: 'ls' }, 'salt-one'));
});

test('an id or a name is kept only when it looks like one; anything else becomes a stand-in made from its hash', () => {
  for (const id of ['toolu_01AbCdEfGhIjKlMnOpQrStUv', '11111111-2222-4333-8444-555555555555', 'a0123456789abcdef', 'step-14', 'n-3'])
    assert.equal(C.safeId(id), id);
  for (const name of ['Read', 'mcp__probe_srv__echo', 'general-purpose', 'claude-opus-5-5', 'claude-fable-5-2[1m]', 'plugin:data:example', 'My Server 2', 'Explore'])
    assert.equal(C.safeName(name), name);
  const hidden = ['C:\\Users\\example\\secret.txt', '/home/example/.ssh/id_rsa', 'curl -H "Authorization: Bearer sk-EXAMPLE" https://example.com', 'git push https://ghp_EXAMPLE@example.com',
    'KEY=value', 'someone@example.com', 'a b c d e f', 'two  spaces', 'x'.repeat(200), '../up', 'semi;colon', '$(command)'];
  for (const text of hidden) {
    const id = C.safeId(text), name = C.safeName(text);
    assert.match(id, /^id-[0-9a-f]{12}$/, 'as an id: ' + text.slice(0, 30));
    assert.match(name, /^unnamed-[0-9a-f]{6}$/, 'as a name: ' + text.slice(0, 30));
    assert.equal(C.safeId(text), id, 'the same text gives the same stand-in, so a start still meets its end');
  }
  assert.notEqual(C.safeId('one thing'), C.safeId('another thing'));
  for (const nothing of ['', null, undefined, 5, {}]) { assert.equal(C.safeId(nothing), ''); assert.equal(C.safeName(nothing), ''); }
  assert.equal(C.isSessionId('11111111-2222-4333-8444-555555555555'), true);
  for (const bad of ['', 'a:b', 'x:file:sub', '/home/example', 'a b', '../x', 'x'.repeat(129), null, 7]) assert.equal(C.isSessionId(bad), false, String(bad));
});

test('a control request is signed, never carried by its token; the hub proves itself the same way', () => {
  const control = C.token(), nonce = C.newNonce();
  const header = C.signRequest(control, 'POST', '/v1/attach', nonce);
  assert.match(header, /^Wyarden [A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/);
  assert.ok(!header.includes(control), 'the token itself is not in the header');
  assert.equal(C.checkRequest(control, 'POST', '/v1/attach', header), nonce);
  assert.equal(C.checkRequest(control, 'POST', '/v1/update', header), null, 'a signature is for one path');
  assert.equal(C.checkRequest(control, 'GET', '/v1/attach', header), null, 'and one method');
  assert.equal(C.checkRequest(C.token(), 'POST', '/v1/attach', header), null, 'and one token');
  for (const bad of [undefined, null, 7, '', 'Bearer ' + control, 'Wyarden ' + nonce, 'Wyarden ' + nonce + '.', header + 'x', 'wyarden ' + header.slice(8), 'Wyarden ' + 'x'.repeat(500)])
    assert.equal(C.checkRequest(control, 'POST', '/v1/attach', bad), null, String(bad).slice(0, 30));
  const proof = C.hubProof(control, nonce);
  assert.match(proof, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(proof, C.hubProof(C.token(), nonce), 'only the holder of the token can make it');
  assert.notEqual(proof, C.hubProof(control, C.newNonce()), 'and only for this nonce');
  assert.notEqual(proof, header.split('.')[1], 'a proof is not a request signature');
  assert.equal(C.sameText('abc', 'abc'), true);
  assert.equal(C.sameText('abc', 'abd'), false);
  assert.equal(C.sameText('abc', 'abcd'), false);
});

test('a hostile payload cannot make the shared rules slow: a deep or huge input, a path thousands of levels deep', () => {
  const time = fn => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
  let nested = 'x';
  for (let i = 0; i < 200000; i++) nested = [nested];
  const wide = {};
  for (let i = 0; i < 300000; i++) wide['key' + i] = i;
  const long = { content: 'y'.repeat(8 * 1024 * 1024) };
  for (const [what, input] of [['200,000 levels', nested], ['300,000 keys', wide], ['8 MB of text', long]]) {
    let hash;
    const ms = time(() => { hash = C.inputHash('Write', input, 'salt'); });
    assert.match(hash, /^[0-9a-f]{8}$/, what);
    // Listing an object's keys costs time for every key, whatever is done with them: that is the floor, and it is
    // bounded by the size of one payload. What must not happen is a cost that grows faster than the input (seconds).
    assert.ok(ms < 1000, what + ' took ' + ms.toFixed(1) + ' ms');
  }
  assert.notEqual(C.inputHash('Read', { file_path: '/a' }, 's'), C.inputHash('Read', { file_path: '/b' }, 's'), 'ordinary inputs still differ');
  assert.notEqual(C.inputHash('Bash', { command: 'a', timeout: 1 }, 's'), C.inputHash('Bash', { command: 'a', timeout: 2 }, 's'));
  const sep = process.platform === 'win32' ? '\\' : '/', top = process.platform === 'win32' ? 'C:\\wym-no-such-7c1e' : '/wym-no-such-7c1e';
  const deep = top + (sep + 'd').repeat(1000);
  assert.ok(deep.length <= C.MAX_PATH);
  const fs = require('node:fs'), real = fs.existsSync;
  let reads = 0;
  fs.existsSync = (...args) => { reads++; return real(...args); };
  try {
    const ms = time(() => { assert.equal(C.sessionRoot(deep), deep); });
    assert.ok(reads <= C.MAX_CLIMB, 'the climb stopped after ' + reads + ' folders');
    assert.ok(ms < 250, 'a 1000-level path took ' + ms.toFixed(1) + ' ms');
  } finally { fs.existsSync = real; }
  const huge = top + (sep + 'd').repeat(40000);
  assert.equal(C.rootInfo(huge), null, 'a "path" longer than any path is not a folder');
  assert.deepEqual(C.keptPath({ root: top, real: top }, top, huge), { outside: true, name: '?' });
  assert.ok(time(() => C.keptPath({ root: top, real: top }, top, top + sep + 'a'.repeat(4000))) < 50);
});

test('the top of a file system: no name that is a path, and no "inside"', () => {
  assert.equal(C.isFsRoot('/'), true);
  assert.equal(C.isFsRoot('C:\\'), true);
  assert.equal(C.isFsRoot('c:/'), true);
  assert.equal(C.isFsRoot('\\\\server\\share'), true);
  assert.equal(C.isFsRoot('/home'), false);
  assert.equal(C.isFsRoot('C:\\Users'), false);
  for (const root of ['/', 'C:\\']) {
    const info = { root, real: root };
    assert.deepEqual(C.keptPath(info, root, root === '/' ? '/home/example/.ssh/id_rsa' : 'C:\\Users\\example\\.ssh\\id_rsa'), { outside: true, name: 'id_rsa' }, 'under ' + root + ' only the base name is kept');
  }
  const other = process.platform === 'win32' ? '/' : 'C:\\';
  assert.equal(C.rootInfo(other).name, '(root)', 'a root has no base name, and its own text is a path');
});

test('a path on another machine is never looked up on disk', () => {
  assert.equal(C.isNetworkPath('\\\\server\\share\\folder'), true);
  assert.equal(C.isNetworkPath('//server/share/folder'), true);
  assert.equal(C.isNetworkPath('C:\\Users\\example'), false);
  assert.equal(C.isNetworkPath('/home/example'), false);
  const fs = require('node:fs'), real = { existsSync: fs.existsSync, realpath: fs.realpathSync.native };
  let reads = 0;
  fs.existsSync = (...args) => { reads++; return real.existsSync(...args); };
  fs.realpathSync.native = (...args) => { reads++; return real.realpath(...args); };
  // The share form with backslashes is a network path on Windows and another system's path on Linux: never read on either.
  // The form with two slashes is a network path only where Windows reads it; on Linux it is an ordinary local path.
  const never = ['\\\\no-such-server-7c1e\\share\\project\\src'];
  if (process.platform === 'win32') never.push('//no-such-server-7c1e/share/project/src');
  try {
    for (const p of never) {
      assert.equal(C.sessionRoot(p), C.lexical(p));
      assert.equal(C.realOf(p), C.lexical(p));
      assert.ok(C.rootInfo(p));
      assert.match(C.wsKey(p), /^[0-9a-f]{12}$/);
    }
  } finally { fs.existsSync = real.existsSync; fs.realpathSync.native = real.realpath; }
  assert.equal(reads, 0, 'nothing was read from disk');
});
