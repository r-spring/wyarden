// A process and its ancestors: the pure walk, the two systems' readers, and one run against real
// processes. Every pid, start time and process name below is invented, except in the last test,
// which starts two Node processes of its own and ends them.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { ancestors, walk, MAX_DEPTH, parseWindows, parseStat, readLinux, powershellCall } = require('../lib/procs.js');

/** A table from [pid, parent, start?] rows. */
const table = rows => new Map(rows.map(([pid, parent, start]) => [pid, start === undefined ? { parent } : { parent, start }]));
/** A straight line of `n` processes: 1000 is the youngest, each parent is 1 higher and started earlier. */
const line = n => table(Array.from({ length: n }, (_, i) => [1000 + i, i === n - 1 ? 0 : 1001 + i, 5000 - i]));

/* ---------- walk ---------- */

test('walk: a plain chain, nearest first, ending where the parent is 0', () => {
  const t = table([[40, 30], [30, 20], [20, 10], [10, 0]]);
  assert.deepEqual(walk(40, t), [40, 30, 20, 10]);
  assert.deepEqual(walk(20, t), [20, 10]);
  assert.deepEqual(walk(10, t), [10]);
});

test('walk: at most MAX_DEPTH long, or the depth it is given when that is 1 to MAX_DEPTH', () => {
  assert.equal(MAX_DEPTH, 16);
  const t = line(30);
  assert.equal(walk(1000, t).length, MAX_DEPTH);
  assert.deepEqual(walk(1000, t), Array.from({ length: 16 }, (_, i) => 1000 + i));
  assert.deepEqual(walk(1000, t, 3), [1000, 1001, 1002]);
  assert.deepEqual(walk(1000, t, 1), [1000]);
  assert.equal(walk(1000, t, MAX_DEPTH).length, MAX_DEPTH);
  // Anything else, a larger whole number too, is MAX_DEPTH: no chain is ever longer.
  for (const depth of [0, -1, 1.5, '3', 17, 1000, NaN, Infinity, null, 3n]) {
    assert.equal(walk(1000, t, depth).length, MAX_DEPTH, 'depth ' + String(depth));
  }
  assert.equal(walk(1000, line(5)).length, 5, 'a shorter line is not padded');
  assert.equal(walk(1000, line(5), 1000).length, 5);
});

test('walk throws only what its table throws; ancestors catches it', async () => {
  const hostile = new Map([[40, { parent: 30 }], [30, { parent: 0 }]]);
  hostile.get = () => { throw new Error('invented failure'); };
  const poisoned = new Map([[40, { get parent() { throw new Error('invented failure'); } }]]);
  for (const t of [hostile, poisoned]) {
    assert.throws(() => walk(40, t), /invented failure/);
    assert.deepEqual(await ancestors(40, { platform: 'linux', readTable: () => t }), { chain: [40], known: false });
  }
  // Odd but harmless tables and rows do not make it throw.
  for (const t of [null, undefined, 7, 'x', {}, [], new Map([[40, null]]), new Map([[40, 7]]), new Map([[40, { parent: {} }]])]) {
    assert.deepEqual(walk(40, t), [40]);
  }
});

test('walk: a cycle ends the chain before a pid repeats', () => {
  assert.deepEqual(walk(1, table([[1, 2], [2, 3], [3, 1]])), [1, 2, 3]);
  assert.deepEqual(walk(5, table([[5, 5]])), [5]);
  assert.deepEqual(walk(7, table([[7, 8], [8, 9], [9, 8]])), [7, 8, 9]);
});

test('walk: a parent that is not in the table is not taken', () => {
  assert.deepEqual(walk(40, table([[40, 30]])), [40]);
  assert.deepEqual(walk(40, table([[40, 30], [30, 20]])), [40, 30]);
  assert.deepEqual(walk(99, table([[40, 30]])), [99], 'a pid that is not in the table is the whole chain');
});

test('walk: a parent that started after its child is a stranger with a reused pid, and is refused', () => {
  // 50 started at 200; the process now holding pid 60 started at 300, so it cannot be 50's parent.
  assert.deepEqual(walk(50, table([[50, 60, 200], [60, 70, 300], [70, 0, 100]])), [50]);
  // Above a good link, the same rule holds: 60 is a real parent of 50, 70 is a stranger to 60.
  assert.deepEqual(walk(50, table([[50, 60, 200], [60, 70, 150], [70, 0, 180]])), [50, 60]);
});

test('walk: a parent that started at the same time, earlier, or at an unknown time is taken', () => {
  assert.deepEqual(walk(50, table([[50, 60, 200], [60, 0, 200]])), [50, 60], 'equal');
  assert.deepEqual(walk(50, table([[50, 60, 200], [60, 0, 199]])), [50, 60], 'earlier');
  assert.deepEqual(walk(50, table([[50, 60, 200], [60, 0]])), [50, 60], 'parent unknown');
  assert.deepEqual(walk(50, table([[50, 60], [60, 0, 900]])), [50, 60], 'child unknown');
  assert.deepEqual(walk(50, table([[50, 60, 0], [60, 0, 900]])), [50, 60], 'a start of 0 is unknown');
  for (const bad of ['12a', '', 1.5, -3, NaN, Infinity, -1n, null, {}, [300], true]) {
    assert.deepEqual(walk(50, table([[50, 60, 200], [60, 0, bad]])), [50, 60], 'not a start time: ' + String(bad));
  }
});

test('walk: start times as bigint, number and string compare as whole numbers, even past 2^53', () => {
  for (const [p, c] of [[300n, 200n], [300, 200], ['300', '200'], ['300', 200n], [300n, '200'], [300, '200']]) {
    assert.deepEqual(walk(50, table([[50, 60, c], [60, 0, p]])), [50], typeof p + ' after ' + typeof c);
    assert.deepEqual(walk(50, table([[50, 60, p], [60, 0, c]])), [50, 60], typeof c + ' before ' + typeof p);
  }
  // Two FILETIMEs 100 ns apart. As Numbers they are the same value, so only an exact compare refuses this.
  const child = '133100000000000320', later = '133100000000000321';
  assert.equal(Number(child), Number(later));
  assert.deepEqual(walk(50, table([[50, 60, child], [60, 0, later]])), [50]);
  assert.deepEqual(walk(50, table([[50, 60, BigInt(child)], [60, 0, later]])), [50]);
});

test('walk: a pid or a parent that is not a positive whole number', () => {
  const t = table([[40, 30], [30, 0]]);
  for (const bad of [0, -1, 1.5, '40', NaN, null, undefined, 2 ** 53]) assert.deepEqual(walk(bad, t), [], String(bad));
  // The odd parent has a row of its own, so only the "positive whole number" rule can refuse it.
  for (const parent of [0, -1, 1.5, '30', null, undefined, 2 ** 53]) {
    assert.deepEqual(walk(40, new Map([[40, { parent }], [parent, { parent: 0 }]])), [40], 'parent ' + String(parent));
  }
  assert.deepEqual(walk(40, null), [40]);
  assert.deepEqual(walk(40, [[40, { parent: 30 }]]), [40], 'an array is not a table');
  assert.deepEqual(walk(40, new Map([[40, 30], [30, { parent: 0 }]])), [40], 'a row that is not an object');
});

/* ---------- ancestors, with injected tables ---------- */

test('ancestors: a pid that is not a positive whole number gives an empty chain and known false', async () => {
  let reads = 0;
  const readTable = () => { reads++; return table([[1, 0]]); };
  for (const bad of [0, -1, 1.5, '12', NaN, undefined, null, 2 ** 53, 12n]) {
    assert.deepEqual(await ancestors(bad, { platform: 'win32', readTable }), { chain: [], known: false }, String(bad));
  }
  assert.equal(reads, 0, 'nothing is read for a bad pid');
});

test('ancestors: a system that is neither Windows nor Linux is not known, and nothing is read', async () => {
  let reads = 0;
  const readTable = () => { reads++; return table([[40, 30], [30, 0]]); };
  for (const platform of ['darwin', 'freebsd', 'aix', '', 'Win32']) {
    assert.deepEqual(await ancestors(40, { platform, readTable }), { chain: [40], known: false }, platform);
  }
  assert.equal(reads, 0);
});

test('ancestors: a reader that throws, rejects, or gives no table, or an empty one, is not known', async () => {
  const readers = {
    throws: () => { throw new Error('invented failure'); },
    rejects: async () => { throw new Error('invented failure'); },
    'gives null': () => null,
    'gives an empty Map': () => new Map(),
    'gives a plain object': () => ({ get: () => ({ parent: 0 }) }),
    'gives an array': () => [[40, { parent: 30 }]]
  };
  for (const platform of ['win32', 'linux']) {
    for (const [name, readTable] of Object.entries(readers)) {
      assert.deepEqual(await ancestors(40, { platform, readTable }), { chain: [40], known: false }, platform + ': ' + name);
    }
  }
});

test('ancestors: never rejects, whatever its table does', async () => {
  const throwing = new Map([[40, { parent: 30 }]]);
  throwing.get = () => { throw new Error('invented failure'); };
  const poisoned = new Map([[40, { get parent() { throw new Error('invented failure'); } }]]);
  const cases = [
    [40, { platform: 'win32', readTable: () => throwing }],
    [40, { platform: 'linux', readTable: () => poisoned }],
    [40, { platform: 'win32', readTable: () => Promise.reject(new Error('invented')) }]
  ];
  for (const [pid, options] of cases) assert.deepEqual(await ancestors(pid, options), { chain: [40], known: false });
});

test('ancestors on Windows: the chain, and the start of the pid itself as a FILETIME string', async () => {
  const t = table([[40, 30, '133100000000000300'], [30, 20, '133100000000000200'], [20, 0, '133000000000000100']]);
  assert.deepEqual(await ancestors(40, { platform: 'win32', readTable: () => t }),
    { chain: [40, 30, 20], known: true, start: '133100000000000300', unit: 'filetime' });
  assert.deepEqual(await ancestors(30, { platform: 'win32', readTable: async () => t }),
    { chain: [30, 20], known: true, start: '133100000000000200', unit: 'filetime' });
  // A stranger that took the parent's pid after the child started.
  assert.deepEqual(await ancestors(40, { platform: 'win32', readTable: () => table([[40, 30, '200'], [30, 0, '300']]) }),
    { chain: [40], known: true, start: '200', unit: 'filetime' });
});

test('ancestors on Linux: the chain, and the start of the pid itself in clock ticks', async () => {
  const t = table([[40, 30, '700'], [30, 1, '600'], [1, 0, '5']]);
  assert.deepEqual(await ancestors(40, { platform: 'linux', readTable: () => t }), { chain: [40, 30, 1], known: true, start: '700', unit: 'ticks' });
  assert.deepEqual(await ancestors(30, { platform: 'linux', readTable: () => t }), { chain: [30, 1], known: true, start: '600', unit: 'ticks' });
  assert.deepEqual(await ancestors(40, { platform: 'linux', readTable: () => table([[40, 30, '700'], [30, 1, '900']]) }),
    { chain: [40], known: true, start: '700', unit: 'ticks' });
});

test('ancestors: start and unit are there together or not at all; a missing process still is known', async () => {
  for (const platform of ['win32', 'linux']) {
    // No start for the pid (none, 0, not digits), or the pid not in the list: both keys are left out, and known stays true.
    for (const start of [undefined, 0, '0', 'x1', 1.5]) {
      const r = await ancestors(40, { platform, readTable: () => table([[40, 30, start], [30, 0, '100']]) });
      assert.deepEqual(r, { chain: [40, 30], known: true }, platform + ' start ' + String(start));
      assert.equal('start' in r || 'unit' in r, false);
    }
    assert.deepEqual(await ancestors(99, { platform, readTable: () => table([[40, 30, '100']]) }), { chain: [99], known: true }, platform + ': not in the list');
    // Not known at all: neither key.
    assert.deepEqual(await ancestors(40, { platform, readTable: () => new Map() }), { chain: [40], known: false });
  }
});

/* ---------- Windows: the PowerShell call and its output ---------- */

test('Windows output: three numbers per line; other lines are skipped; CRLF; an empty output', () => {
  const out = '0 0 0\r\n11 0 133000000000000010\r\n' +
    '7101 11 133000000000000500\r\n' +
    '  7202 7201 133100000000000100  \r\n' +
    '7303 7202 133100000000000200\n' +
    '\r\n' +
    '7 8\r\n' +              // two numbers
    '7 8 9 10\r\n' +         // four
    '7 x 9\r\n' +            // not a number
    '-7 8 9\r\n' +           // a sign
    '7 8 1.5\r\n' +          // a fraction
    'Get-CimInstance : invented error\r\n' +
    '#< CLIXML\r\n';
  const t = parseWindows(out);
  assert.deepEqual([...t.entries()], [
    [0, { parent: 0 }],
    [11, { parent: 0, start: '133000000000000010' }],
    [7101, { parent: 11, start: '133000000000000500' }],
    [7202, { parent: 7201, start: '133100000000000100' }],
    [7303, { parent: 7202, start: '133100000000000200' }]
  ]);
  for (const empty of ['', '\r\n', '\r\n\r\n', 'nothing here', null, undefined]) assert.equal(parseWindows(empty).size, 0, JSON.stringify(empty));
});

test('Windows output into ancestors: CRLF lines give a chain; an empty output is not known', async () => {
  const out = '7303 7202 133100000000000200\r\n7202 11 133100000000000100\r\n11 0 133000000000000010\r\n';
  assert.deepEqual(await ancestors(7303, { platform: 'win32', readTable: () => parseWindows(out) }),
    { chain: [7303, 7202, 11], known: true, start: '133100000000000200', unit: 'filetime' });
  for (const empty of ['', '\r\n', 'not three numbers\r\n']) {
    assert.deepEqual(await ancestors(7303, { platform: 'win32', readTable: () => parseWindows(empty) }), { chain: [7303], known: false });
  }
});

test('Windows: PowerShell by its full path in the system folder, a constant encoded command, no shell', () => {
  const tail = '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  assert.equal(powershellCall({ SystemRoot: 'D:\\WinInvented' }).file, 'D:\\WinInvented' + tail);
  assert.equal(powershellCall({}).file, 'C:\\Windows' + tail);
  for (const bad of ['', 'Windows', '.\\here', '\\\\server\\share', null]) assert.equal(powershellCall({ SystemRoot: bad }).file, 'C:\\Windows' + tail, String(bad));
  const call = powershellCall({ SystemRoot: 'C:\\Windows' });
  assert.deepEqual(call.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(call.args.length, 5);
  const command = Buffer.from(call.args[4], 'base64').toString('utf16le');
  assert.match(command, /Get-CimInstance -ClassName Win32_Process /);
  assert.match(command, /\$_\.CreationDate\.ToFileTimeUtc\(\)/);
  assert.match(command, /"\$\(\$_\.ProcessId\) \$\(\$_\.ParentProcessId\) \$t"/);
  assert.deepEqual(powershellCall({ SystemRoot: 'D:\\WinInvented' }).args, call.args, 'the command does not depend on anything');
  assert.deepEqual(call.options, { shell: false, windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
});

/* ---------- Linux: /proc/<pid>/stat ---------- */

/** A stat line: 52 fields, each numbered field holding its own number so a wrong index shows. */
const statLine = (pid, name, parent, start) => {
  const fields = Array.from({ length: 52 }, (_, i) => String(i + 1));
  fields[0] = String(pid); fields[1] = '(' + name + ')'; fields[2] = 'S'; fields[3] = String(parent); fields[21] = String(start);
  return fields.join(' ') + '\n';
};

test('Linux stat: the parent and start are counted after the last ")", so a name with ") " and spaces is safe', () => {
  assert.deepEqual(parseStat(statLine(4242, 'invented', 4241, 987654)), { pid: 4242, parent: 4241, start: '987654' });
  assert.deepEqual(parseStat(statLine(4242, 'a) (b c) 9 9', 4241, 987654)), { pid: 4242, parent: 4241, start: '987654' });
  assert.deepEqual(parseStat(statLine(1, 'init', 0, 0)), { pid: 1, parent: 0, start: '0' });
  assert.deepEqual(parseStat('77 (short) S 76 77 77'), { pid: 77, parent: 76 }, 'too few fields: no start');
  for (const bad of ['', 'garbage', '77 short S 76', '77 (x) S x 77', '(x) S 76', null, 77]) assert.equal(parseStat(bad), null, String(bad));
});

test('Linux reader: one file per step, this process\'s own row, null with no /proc', async () => {
  const files = {
    '/proc/self/stat': statLine(900, 'invented-self', 1, 300),
    '/proc/900/stat': statLine(900, 'invented-self', 1, 300),
    '/proc/1/stat': statLine(1, 'init', 0, 1),
    '/proc/40/stat': statLine(40, 'invented-session', 30, 700),
    '/proc/30/stat': statLine(30, 'invented-shell', 900, 600)
  };
  const asked = [];
  const read = file => { asked.push(file); return Object.prototype.hasOwnProperty.call(files, file) ? files[file] : null; };
  const t = readLinux(40, read);
  assert.deepEqual(asked, ['/proc/self/stat', '/proc/40/stat', '/proc/30/stat', '/proc/1/stat'], 'self is read once, as /proc/self');
  assert.deepEqual(walk(40, t), [40, 30, 900, 1]);
  // The start is field 22 of the pid's own file (700), not its parent's or this process's.
  assert.deepEqual(await ancestors(40, { platform: 'linux', readTable: p => readLinux(p, read) }),
    { chain: [40, 30, 900, 1], known: true, start: '700', unit: 'ticks' });
  // A pid whose own stat file cannot be read (it has ended): /proc is there, so the answer is
  // known, the chain is the pid alone, and there is no start.
  assert.deepEqual(await ancestors(55, { platform: 'linux', readTable: p => readLinux(p, read) }), { chain: [55], known: true });
  // No /proc at all.
  assert.equal(readLinux(40, () => null), null);
  assert.deepEqual(await ancestors(40, { platform: 'linux', readTable: p => readLinux(p, () => null) }), { chain: [40], known: false });
  // A long line of processes is read at most MAX_DEPTH files deep (plus /proc/self).
  const deep = []; const deepRead = file => { deep.push(file); if (file === '/proc/self/stat') return statLine(9, 'invented-self', 1, 1); const p = Number(file.split('/')[2]); return statLine(p, 'x', p + 1, 1000 - p); };
  assert.equal(walk(100, readLinux(100, deepRead)).length, MAX_DEPTH);
  assert.equal(deep.length, MAX_DEPTH + 1);
});

/* ---------- real processes ---------- */

const REAL = process.platform === 'win32' || process.platform === 'linux';
// The grandchild prints its pid and waits; both scripts end themselves after 60 s, so nothing outlives a crashed run.
const GRANDCHILD = 'console.log(process.pid); setTimeout(() => {}, 60000);';
const CHILD = "require('node:child_process').spawn(process.execPath, ['-e', " + JSON.stringify(GRANDCHILD) + "], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true }); setTimeout(() => {}, 60000);";

/** The first line of a stream as a pid; rejects when the process ends first, or after `ms`. */
function firstPid(child, ms) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('no pid within ' + ms + ' ms')), ms);
    child.stdout.on('data', chunk => {
      text += chunk;
      const m = /^(\d+)\r?\n/.exec(text);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on('exit', code => { clearTimeout(timer); reject(new Error('the child ended first (' + code + ')')); });
  });
}

test('real processes: a grandchild, its parent and this test, nearest first', {
  skip: REAL ? false : 'the process list is read only on Windows and Linux, and this is ' + process.platform,
  timeout: 60000
}, async t => {
  const child = spawn(process.execPath, ['-e', CHILD], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  let grandchild = 0;
  // Killing the child does not end the grandchild on Windows, so each is ended by its own pid.
  t.after(() => { for (const pid of [grandchild, child.pid]) { try { if (pid) process.kill(pid); } catch { /* already gone */ } } });
  grandchild = await firstPid(child, 20000);
  const before = Date.now();
  const r = await ancestors(grandchild);
  assert.equal(r.known, true);
  assert.deepEqual(r.chain.slice(0, 3), [grandchild, child.pid, process.pid]);
  assert.match(String(r.start), /^\d+$/);
  if (process.platform === 'win32') {
    assert.equal(r.unit, 'filetime');
    // FILETIME: 100 ns units since 1601. 11644473600000 ms lie between 1601 and 1970.
    const started = Number(BigInt(r.start) / 10000n - 11644473600000n);
    assert.ok(started <= before + 1000 && started >= before - 120000, 'started ' + (before - started) + ' ms ago');
  } else {
    assert.equal(r.unit, 'ticks');
    // Read by the test itself: field 22 of the grandchild's own stat file, counted after the last ")".
    const stat = fs.readFileSync('/proc/' + grandchild + '/stat', 'utf8');
    const field22 = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    assert.match(field22, /^\d+$/);
    assert.equal(r.start, field22);
  }
});
