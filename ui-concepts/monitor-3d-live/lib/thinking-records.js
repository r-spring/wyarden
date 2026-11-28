/* Wyarden 3D monitor, working mock-up: where Codex, Grok Build and Antigravity keep their own record of one session.
 *
 * When the owner selects a Codex, Grok Build or Antigravity agent, the window's extension host reads that
 * session's reasoning from the tool's own record of it (lib/thinking.js `readThinking(file, { format })`).
 * The monitor knows such a session only by the id its hooks report. This file is the step in between:
 * from (tool, session id) to the record's path. The page never names a path and the hub is not asked; the
 * path is made here, in the extension host, from the tool's home folder and the id.
 *
 * The layouts are the tools' own and undocumented unless said. What follows was seen on this machine on
 * 28 November 2026, from folder and file names only.
 *
 * Codex CLI 0.172.0: <codex home>/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<thread id>.jsonl,
 * always at that depth (1,426 of 1,426 names had exactly that shape). The thread id is a UUID and is the
 * session id the hooks report: 39 hook-reported ids each named exactly one rollout file. The date in the
 * path is the day the thread was created, in local time, so a live thread's file can be in any day folder:
 * the day folders are looked through newest first, and the first regular file whose WHOLE name has that
 * shape and that id is the answer. The whole name is compared, not its end: an id holds "-", so a short id
 * can be the tail of another thread's id. A thread whose history Codex has moved into its database has no
 * file any more (2,115 of 3,578 threads here); then there is no record, which is an answer, not an error.
 * The Codex home is $CODEX_HOME, else <home>/.codex, as in lib/providers/codex-config.js.
 *
 * Grok Build 1.0.92: <grok home>/sessions/<a folder named after the session's working folder>/<session id>/
 * updates.jsonl. The session folder's name is the session id (it equalled the id inside the file on every
 * line read). The parent's name is NOT computed: it is encodeURIComponent of the working folder for most
 * sessions but not all (1,313 of 1,319; the rest differ in drive-letter case), and the monitor's idea of a
 * session's folder can be a step's folder. So every parent is looked in for a child folder named exactly
 * the id that holds updates.jsonl (386 parents and 1,346 session folders here; no id sits under two
 * parents; 37 session folders have no updates.jsonl, and those have no record). That the HOOK's
 * `sessionId` is this id is what the tool's bundled guide says, and it fits every trace found; it was not
 * measured directly. The Grok home is $GROK_HOME, else <home>/.grok, as in lib/providers/grok-config.js,
 * which also makes a relative $GROK_HOME absolute from this process's folder; so does this file.
 *
 * Antigravity (agy) 1.5.19: <home>/.gemini/<root>/brain/<conversation id>/.system_generated/logs/
 * transcript_full.jsonl, and beside it transcript.jsonl (the same records with long strings cut near 4 KB).
 * <root> is antigravity-cli for the CLI, antigravity for the desktop app and antigravity-ide for the IDE
 * (absent here); they are tried in that order, and in each the full file comes before the cut one. The
 * .db files beside them are never named, so never opened. That the HOOK's `conversationId` is this id is
 * read from the tool's guide and fits the traces; it was not measured directly. <home> is found as in
 * lib/providers/antigravity.js: the `home` option, else USERPROFILE (Windows) or HOME, else the user's home.
 *
 * The rules:
 * - Before the disk is touched: the tool must be one of AGENTS, the id must pass contract.isSessionId
 *   (so it holds no separator, dot or colon and can be one path component), and the tool's home must be
 *   an absolute path of this machine's form, on this machine (never `\\server\share` or `//server/...`,
 *   see lib/contract.js), of at most contract.MAX_PATH characters and with no NUL.
 * - Below the tool's sessions folder (Antigravity: its brain folder) no link is followed. Folders are
 *   listed with their types and only real folders are entered; each step to the record is an `lstat`
 *   that must be a real folder, and the record itself a regular file. Then the real paths of the sessions
 *   folder and of the record are compared, so a link or junction cannot lead outside. The home and the
 *   sessions folder themselves may be links (a home moved to another drive): their real path is what the
 *   record's real path is compared with.
 * - Folder listings and file metadata only (readdir, lstat, realpath). No file is opened, so no record's
 *   content is ever read here.
 * - fs.promises throughout, so the extension host is not blocked while a Grok lookup makes its several
 *   hundred `lstat` calls; one call at a time, so it never fills the thread pool.
 * - Bounded by the caps below. A folder that cannot be listed, or a step that cannot be looked at, is
 *   passed over.
 * - recordOf never throws and never rejects. Nothing is cached and nothing is logged, and no error's text
 *   leaves this file: a lookup that fails for any reason is null, "no record found", and the caller looks
 *   again later.
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('./contract.js');

const AGENTS = Object.freeze(['codex', 'grok', 'antigravity']);

/**
 * Most folders listed in one Codex lookup, the sessions, year and month folders included. Codex makes one
 * day folder for each day a thread was started (56 in four months here), so 5,000 is over thirteen years of
 * daily use; past it the answer is null rather than a walk that grows without end.
 */
const MAX_CODEX_FOLDERS = 5000;
/**
 * Most parent folders looked in for one Grok lookup, one `lstat` each. Grok makes one for each working
 * folder a session was started in (386 here); past it the answer is null.
 */
const MAX_GROK_PARENTS = 5000;

const HOST = process.platform === 'win32' ? path.win32 : path.posix;
const YEAR = /^\d{4}$/;
const TWO_DIGITS = /^\d{2}$/;
/** A rollout file's whole name: the creation time in Codex's own shape, then the thread id. */
const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;
const GROK_RECORD = 'updates.jsonl';
const ANTIGRAVITY_ROOTS = Object.freeze(['antigravity-cli', 'antigravity', 'antigravity-ide']);
const ANTIGRAVITY_FILES = Object.freeze(['transcript_full.jsonl', 'transcript.jsonl']);

/** A folder this window may look in: absolute, this machine's form, not on another machine, not too long, no NUL. */
const localDir = dir => typeof dir === 'string' && dir.length > 0 && dir.length <= C.MAX_PATH && !dir.includes('\0') &&
  C.isAbsolute(dir) && !C.isNetworkPath(dir) && C.flavour(dir) === HOST && path.isAbsolute(dir);
/** The folder normalised when it, and its normal form, pass localDir; else null. */
const checked = dir => {
  if (!localDir(dir)) return null;
  const normal = path.normalize(dir);
  return localDir(normal) ? normal : null;
};
/** A cap from the options, which may only lower it. */
const capOf = (value, max) => (Number.isSafeInteger(value) && value >= 0 && value < max ? value : max);

/** The tool's home folder, found as its provider finds it, or null when it is not one this window may look in. */
function toolHome(agent, env, home) {
  if (agent === 'codex') {
    const dir = (env && env.CODEX_HOME) || (typeof home === 'string' ? path.join(home, '.codex') : '');
    return checked(dir);
  }
  if (agent === 'grok') {
    const override = env && env.GROK_HOME;
    const dir = typeof override === 'string' && override.trim() ? path.resolve(override)
      : typeof home === 'string' ? path.join(home, '.grok') : '';
    return checked(dir);
  }
  const base = home || (env && (process.platform === 'win32' ? env.USERPROFILE : env.HOME)) || os.homedir();
  return typeof base === 'string' ? checked(path.join(base, '.gemini')) : null;
}

/** True when `file`'s real path is inside `root`'s real path (and is not the folder itself). */
async function within(root, file) {
  try {
    const realRoot = await fs.promises.realpath(root);
    const realFile = await fs.promises.realpath(file);
    if (typeof realRoot !== 'string' || typeof realFile !== 'string') return false;
    const rel = C.relativeIn(realRoot, realFile);
    return rel !== null && rel !== '.';
  } catch {
    return false;
  }
}

/**
 * The file at from/parts[0]/.../parts[n-1] when each step is a real folder (not a link), the last is a
 * regular file, and its real path is inside `root`'s; else null. Each step is one `lstat`.
 */
async function fileAt(root, from, parts) {
  let at = from;
  for (let i = 0; i < parts.length; i++) {
    at = path.join(at, parts[i]);
    if (at.length > C.MAX_PATH) return null;
    let st;
    try { st = await fs.promises.lstat(at); } catch { return null; }
    if (!st || typeof st !== 'object') return null;
    const last = i === parts.length - 1;
    if (!(last ? st.isFile() : st.isDirectory())) return null;
  }
  return (await within(root, at)) ? at : null;
}

/** A folder's entries with their types: [] for one that cannot be listed, null once the budget is spent. */
async function listing(dir, budget) {
  if (budget.left <= 0) return null;
  budget.left--;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
  return Array.isArray(entries) ? entries : [];
}
/** The real folders in `dir` whose names have `shape`, newest (highest) first; null once the budget is spent. */
async function subfolders(dir, shape, budget) {
  const entries = await listing(dir, budget);
  if (entries === null) return null;
  const names = [];
  for (const e of entries) if (e && typeof e.name === 'string' && shape.test(e.name) && e.isDirectory()) names.push(e.name);
  return names.sort().reverse().map(name => path.join(dir, name));
}
const isRollout = (name, id) => { const m = ROLLOUT.exec(name); return !!m && m[1] === id; };

/** Codex: the day folders newest first, and in them the rollout file of this thread. */
async function codexRecord(sessions, id, cap) {
  const budget = { left: cap };
  const years = await subfolders(sessions, YEAR, budget);
  if (!years) return null;
  for (const year of years) {
    const months = await subfolders(year, TWO_DIGITS, budget);
    if (!months) return null;
    for (const month of months) {
      const days = await subfolders(month, TWO_DIGITS, budget);
      if (!days) return null;
      for (const day of days) {
        const entries = await listing(day, budget);
        if (!entries) return null;
        for (const e of entries) {
          if (!e || typeof e.name !== 'string' || !isRollout(e.name, id) || !e.isFile()) continue;
          const file = await fileAt(sessions, day, [e.name]);
          if (file) return file;
        }
      }
    }
  }
  return null;
}

/** Grok: every parent folder, in name order, for a child folder named the id that holds updates.jsonl. */
async function grokRecord(sessions, id, cap) {
  let entries;
  try { entries = await fs.promises.readdir(sessions, { withFileTypes: true }); } catch { return null; }
  if (!Array.isArray(entries)) return null;
  const parents = [];
  for (const e of entries) if (e && typeof e.name === 'string' && e.isDirectory()) parents.push(e.name);
  parents.sort();
  const n = Math.min(parents.length, cap);
  for (let i = 0; i < n; i++) {
    const file = await fileAt(sessions, path.join(sessions, parents[i]), [id, GROK_RECORD]);
    if (file) return file;
  }
  return null;
}

/** Antigravity: each root in turn, and in it the full transcript before the cut one. */
async function antigravityRecord(gemini, id) {
  for (const root of ANTIGRAVITY_ROOTS) {
    const brain = path.join(gemini, root, 'brain');
    for (const name of ANTIGRAVITY_FILES) {
      const file = await fileAt(brain, brain, [id, '.system_generated', 'logs', name]);
      if (file) return file;
    }
  }
  return null;
}

/**
 * async recordOf(agent, sessionId, options?) -> { file, format } or null
 *   agent      'codex' | 'grok' | 'antigravity'  (anything else: null)
 *   sessionId  as the hub gives it; must pass contract.isSessionId
 *   options    { env, home }: for tests; default process.env and os.homedir()
 *              { maxCodexFolders, maxGrokParents }: for tests; may only lower MAX_CODEX_FOLDERS and MAX_GROK_PARENTS
 * `format` is the agent's name, as lib/thinking.js readThinking takes it.
 * Never throws and never rejects. Reads folder listings and file metadata only; never a record's content.
 * null means "no record found", for whatever reason; the caller looks again later.
 */
async function recordOf(agent, sessionId, options) {
  try {
    if (typeof agent !== 'string' || !AGENTS.includes(agent) || !C.isSessionId(sessionId)) return null;
    const o = options && typeof options === 'object' ? options : {};
    const env = o.env && typeof o.env === 'object' ? o.env : process.env;
    const home = agent === 'antigravity' || o.home !== undefined ? o.home : os.homedir();
    const dir = toolHome(agent, env, home);
    if (!dir) return null;
    let file = null;
    if (agent === 'codex') file = await codexRecord(path.join(dir, 'sessions'), sessionId, capOf(o.maxCodexFolders, MAX_CODEX_FOLDERS));
    else if (agent === 'grok') file = await grokRecord(path.join(dir, 'sessions'), sessionId, capOf(o.maxGrokParents, MAX_GROK_PARENTS));
    else file = await antigravityRecord(dir, sessionId);
    return typeof file === 'string' && file ? { file, format: agent } : null;
  } catch {
    return null;                                     // nothing of the error leaves this file
  }
}

module.exports = { recordOf, AGENTS, MAX_CODEX_FOLDERS, MAX_GROK_PARENTS };
