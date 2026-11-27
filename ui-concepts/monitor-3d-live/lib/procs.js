/* Wyarden 3D monitor, working mock-up: a process and its ancestors.
 *
 * To show a session's terminal or chat panel, the extension must know whether the session's
 * process runs under one of this window's terminals, or under this window's extension host. That
 * is a question about the process's ancestors: its parent, grandparent and so on. This file
 * answers it, on Windows from one run of Windows PowerShell, on Linux from `/proc`.
 *
 * The answer decides whether a command runs, so the error to avoid is a stranger taken for a
 * parent. A process id is reused once its process ends: a child whose parent has ended still names
 * the old parent's number, and another program may hold that number now. So a parent is taken only
 * when it did not start after its child.
 *
 * `known` is false only when the process list itself cannot be read (another system, the query
 * failed, or it gave nothing). A process that is not in the list, or on Linux one whose own stat
 * file cannot be read, is not a failure: the chain just ends there, with `known: true`. The start
 * time of the process itself comes back too, so the caller can tell a session's process from a
 * later one that took its id.
 *
 * `ancestors` never throws and never rejects. `walk` is pure and throws only when the table it is
 * given throws (its own `get`, or a getter on a row); `ancestors` catches that.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

/** A session's process sits 3 to 10 levels under its extension host; 16 leaves room and stays cheap. */
const MAX_DEPTH = 16;

const isPid = v => Number.isSafeInteger(v) && v > 0;

/**
 * A start time as a BigInt, or undefined when it is not known: a bigint or a whole number above 0,
 * or a string of digits that is not zero. A Windows FILETIME is above 2^53, so it arrives as a
 * string and is never read through Number.
 */
function startValue(v) {
  if (typeof v === 'bigint') return v > 0n ? v : undefined;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? BigInt(v) : undefined;
  if (typeof v === 'string' && /^\d{1,40}$/.test(v)) { const n = BigInt(v); return n > 0n ? n : undefined; }
  return undefined;
}
/** True only when both times are known and the parent's is the later. Equal is not later: Linux counts in 10 ms ticks. */
function startedAfter(parentStart, childStart) {
  const p = startValue(parentStart), c = startValue(childStart);
  return p !== undefined && c !== undefined && p > c;
}
const rowOf = (table, pid) => { const row = table.get(pid); return row && typeof row === 'object' ? row : null; };

/**
 * `pid`, then its parent, grandparent and so on. Pure: `table` is a Map of pid -> { parent, start? }.
 * A parent is taken only when it is in the table, is above 0, is not already in the chain, and did
 * not start after its child (when both start times are known). The chain is at most `depth` long
 * when that is a whole number from 1 to MAX_DEPTH, else MAX_DEPTH: never longer.
 */
function walk(pid, table, depth = MAX_DEPTH) {
  if (!isPid(pid)) return [];
  const chain = [pid];
  if (!table || typeof table.get !== 'function') return chain;
  const limit = Number.isInteger(depth) && depth >= 1 && depth <= MAX_DEPTH ? depth : MAX_DEPTH;
  const seen = new Set(chain);
  while (chain.length < limit) {
    const child = rowOf(table, chain[chain.length - 1]);
    if (!child) break;
    const parent = child.parent;
    if (!isPid(parent) || seen.has(parent)) break;
    const up = rowOf(table, parent);
    if (!up || startedAfter(up.start, child.start)) break;
    chain.push(parent);
    seen.add(parent);
  }
  return chain;
}

/* ---------- Windows: one run of Windows PowerShell ---------- */

/**
 * A constant: nothing from a session, a page or a file is ever put into it. One line for each
 * process: `<ProcessId> <ParentProcessId> <CreationDate as FILETIME UTC, or 0>`. Progress is
 * silenced, else the first run writes "Preparing modules" to stderr.
 */
const WINDOWS_QUERY = "$ProgressPreference = 'SilentlyContinue'; " +
  'Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { ' +
  '$t = 0; if ($_.CreationDate) { $t = $_.CreationDate.ToFileTimeUtc() }; "$($_.ProcessId) $($_.ParentProcessId) $t" }';

/**
 * How Windows PowerShell is started: by its full path in the system folder, never by bare name
 * (a bare name is looked up in the working folder and on PATH first), and never through a shell.
 */
function powershellCall(env = process.env) {
  const root = env && typeof env.SystemRoot === 'string' && /^[A-Za-z]:\\/.test(env.SystemRoot) ? env.SystemRoot : 'C:\\Windows';
  return {
    file: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_QUERY, 'utf16le').toString('base64')],
    options: { shell: false, windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }
  };
}

/** The table from PowerShell's output. A line that is not three numbers is skipped. A start of 0 is "not known". */
function parseWindows(text) {
  const table = new Map();
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const m = /^(\d{1,10}) (\d{1,10}) (\d{1,20})$/.exec(line.trim());
    if (!m) continue;
    const start = BigInt(m[3]);
    table.set(Number(m[1]), start > 0n ? { parent: Number(m[2]), start: start.toString() } : { parent: Number(m[2]) });
  }
  return table;
}

function runPowerShell() {
  return new Promise((resolve, reject) => {
    const { file, args, options } = powershellCall();
    const child = execFile(file, args, options, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    // PowerShell is given no input; closing it means it never waits for any.
    if (child.stdin) child.stdin.end();
  });
}
const readWindows = async () => parseWindows(await runPowerShell());

/* ---------- Linux: /proc ---------- */

/**
 * { pid, parent, start } from the text of a `/proc/<pid>/stat`, or null. The command name sits in
 * parentheses and may itself hold spaces and ")", so fields are counted after the LAST ")": the
 * parent is the second (field 4 of the file), the start time the twentieth (field 22, in clock ticks).
 */
function parseStat(text) {
  if (typeof text !== 'string') return null;
  const close = text.lastIndexOf(')');
  const own = /^(\d+) \(/.exec(text);
  if (!own || close < 0) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/);
  if (!/^\d+$/.test(fields[1] || '')) return null;
  const row = { pid: Number(own[1]), parent: Number(fields[1]) };
  if (/^\d+$/.test(fields[19] || '')) row.start = fields[19];
  return row;
}

const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

/**
 * The rows of `pid` and its ancestors, read one at a time: at most MAX_DEPTH files. Null when
 * `/proc/self/stat` cannot be read, so there is no /proc to ask. This process's own row is in the
 * table too: it is a row that was read, and it keeps the table from being empty when `pid` has
 * already ended.
 */
function readLinux(pid, read = readText) {
  const self = parseStat(read('/proc/self/stat'));
  if (!self) return null;
  const table = new Map([[self.pid, { parent: self.parent, start: self.start }]]);
  const visited = new Set();
  let p = pid;
  // Each step reads one file, from the process up; a loop or a missing file ends it.
  while (isPid(p) && !visited.has(p) && visited.size < MAX_DEPTH) {
    visited.add(p);
    let row = table.get(p);
    if (!row) {
      const stat = parseStat(read('/proc/' + p + '/stat'));
      if (!stat) break;
      row = { parent: stat.parent, start: stat.start };
      table.set(p, row);
    }
    p = row.parent;
  }
  return table;
}

/* ---------- the one call the extension makes ---------- */

const unknown = pid => ({ chain: isPid(pid) ? [pid] : [], known: false });

/**
 * { chain, known, start?, unit? }: see the file's opening comment and `walk`.
 * `start` is the start time of `pid` itself as a string of digits: on Windows its FILETIME in UTC
 * (`unit: 'filetime'`), on Linux field 22 of its own `/proc/<pid>/stat`, clock ticks since boot
 * (`unit: 'ticks'`). Both keys are left out together when the start is not known, and a start of 0
 * is not known. `options` are for tests: `platform` (default: this system's) and `readTable(pid)`,
 * which gives the table (or a promise of it) in place of the system's own process list.
 */
async function ancestors(pid, options) {
  if (!isPid(pid)) return { chain: [], known: false };
  try {
    const o = options && typeof options === 'object' ? options : {};
    const platform = o.platform === undefined ? process.platform : o.platform;
    if (platform !== 'win32' && platform !== 'linux') return unknown(pid);
    const read = typeof o.readTable === 'function' ? o.readTable : platform === 'win32' ? readWindows : readLinux;
    const table = await read(pid);
    if (!(table instanceof Map) || table.size === 0) return unknown(pid);
    const result = { chain: walk(pid, table), known: true };
    const row = rowOf(table, pid), start = row ? startValue(row.start) : undefined;
    if (start !== undefined) {
      result.start = start.toString();
      result.unit = platform === 'win32' ? 'filetime' : 'ticks';
    }
    return result;
  } catch {
    return unknown(pid);
  }
}

// The last four are exported for the tests only; the extension calls `ancestors`.
module.exports = { ancestors, walk, MAX_DEPTH, parseWindows, parseStat, readLinux, powershellCall };
