/* Wyarden 3D monitor, working mock-up: which Claude Code sessions are alive on this machine.
 *
 * The Claude Code CLI keeps one small file for each running session, `<config>/sessions/<pid>.json`,
 * with its process id, session id, folder and status. Reading those files is how the view can show
 * every live session before any collector is set up. The files are the CLI's own and undocumented,
 * so every read here gives nothing rather than throwing: a folder may be missing, a file may be
 * half-written, and a field may change type in a later CLI.
 *
 * The hub calls this every 3 seconds, so it stays synchronous and cheap: a few directory listings
 * and small file reads, and never a child process.
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normPath, lexical, flavour, isAbsolute, cleanText } = require('./contract.js');

/** A session file is a few hundred bytes; anything far larger is not one, and is not read. */
const MAX_SESSION_FILE = 256 * 1024;
/** Real session ids are UUIDs. The id becomes a file name, so a value that could climb out of the folder is refused. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STATUSES = new Set(['busy', 'idle', 'waiting']);

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * Every Claude Code config folder that exists: `~/.claude`, each account folder in
 * `~/.claude-accounts` (where Wyarden keeps one folder per signed-in account), and
 * `$CLAUDE_CONFIG_DIR`. A `<name>.lock` folder there is the CLI's lock while it refreshes a login,
 * not an account. No folder is listed twice, however it is spelt.
 */
function claudeConfigDirs({ home = os.homedir(), env = process.env } = {}) {
  const out = [], seen = new Set();
  const add = dir => {
    if (!isDir(dir)) return;
    const key = normPath(dir);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(lexical(dir));
  };
  if (typeof home === 'string' && home) {
    const f = flavour(home);
    add(f.join(home, '.claude'));
    const accounts = f.join(home, '.claude-accounts');
    let names = [];
    try { names = fs.readdirSync(accounts); } catch { /* no accounts folder yet */ }
    for (const name of names.filter(n => !n.endsWith('.lock')).sort()) add(f.join(accounts, name));
  }
  const fromEnv = env && env.CLAUDE_CONFIG_DIR;
  // A relative value is taken from this process's folder, as the CLI would take it from its own.
  if (typeof fromEnv === 'string' && fromEnv.trim()) add(isAbsolute(fromEnv) ? fromEnv : path.resolve(fromEnv));
  return out;
}

/** True while a process with this id exists. EPERM means it exists but belongs to someone else. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return !!error && error.code === 'EPERM'; }
}

/** Where the CLI writes a session's transcript: every character of `cwd` outside [a-zA-Z0-9] becomes "-". */
function transcriptPath(configDir, cwd, sessionId) {
  return flavour(configDir).join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), sessionId + '.jsonl');
}

function readSessionFile(file) {
  try {
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st || !st.isFile() || st.size > MAX_SESSION_FILE) return null;
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : null;
  } catch {
    return null;                                     // mid-write, or not a session file
  }
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * The live sessions in these config folders, in folder order:
 * [{agent, session, key, cwd, pid, status, waitingFor, updatedAt, statusUpdatedAt, procStart, configDir, transcript}]
 *
 * A pid can be reused by another program after a session crashed and left its file behind. The
 * file's `procStart` names the process exactly, but checking it needs the system's process table,
 * which this slice does not read: it is passed through for a later check.
 */
function liveClaudeSessions(dirs, { alive = pidAlive } = {}) {
  const byId = new Map();
  for (const dir of Array.isArray(dirs) ? dirs : []) {
    if (typeof dir !== 'string' || !dir) continue;
    const f = flavour(dir), folder = f.join(dir, 'sessions');
    let names;
    try { names = fs.readdirSync(folder).filter(n => n.endsWith('.json')).sort(); } catch { continue; }
    for (const name of names) {
      const s = readSessionFile(f.join(folder, name));
      if (!s) continue;
      if (!Number.isInteger(s.pid) || s.pid <= 0) continue;
      if (typeof s.sessionId !== 'string' || !SESSION_ID.test(s.sessionId)) continue;
      if (typeof s.cwd !== 'string' || !s.cwd) continue;
      let up;
      try { up = alive(s.pid); } catch { up = false; }
      if (!up) continue;
      const entry = {
        agent: 'claude',
        session: s.sessionId,
        key: 'claude:' + s.sessionId,
        cwd: s.cwd,
        pid: s.pid,
        status: STATUSES.has(s.status) ? s.status : undefined,
        waitingFor: typeof s.waitingFor === 'string' && s.waitingFor ? cleanText(s.waitingFor, 200) : undefined,
        updatedAt: num(s.updatedAt),
        statusUpdatedAt: num(s.statusUpdatedAt),
        procStart: typeof s.procStart === 'string' && /^\d{1,40}$/.test(s.procStart) ? s.procStart : undefined,
        configDir: dir,
        transcript: transcriptPath(dir, s.cwd, s.sessionId)
      };
      // One session listed by two folders (or a stale file beside a fresh one): the most recently written wins.
      const had = byId.get(entry.session);
      const stamp = e => e.statusUpdatedAt ?? e.updatedAt ?? -Infinity;
      if (!had || stamp(entry) > stamp(had)) byId.set(entry.session, entry);
    }
  }
  return [...byId.values()];
}

module.exports = { claudeConfigDirs, liveClaudeSessions, pidAlive, transcriptPath };
