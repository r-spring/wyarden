/* Wyarden 3D monitor, working mock-up: the rules every part shares.
 *
 * Plain Node, no package, no `vscode`: the hub, the collector set-up, the tests and the extension
 * host all load this one file, so a workspace key, a collector address and "is this path inside
 * that folder" each have one implementation.
 *
 * Paths: the FORM of a path (Windows or POSIX) is read from the path itself, never from the
 * machine, so both forms can be handled and tested on either system. A path is only looked up on
 * disk when its form is this machine's.
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VERSION = 1;
/** In every collector address. It is how set-up and removal recognise their own entries. */
const MARK = 'wyarden-monitor';
const AGENTS = ['claude', 'codex', 'grok', 'antigravity'];
const ALL = 'all';                       // the scope that shows every open workspace
const LIMITS = {
  name: 80,                              // a tool, server or folder name
  path: 400,
  url: 400,
  body: 8 * 1024 * 1024,                 // one hook payload; larger is dropped and counted
  ring: 5000,                            // recent records the hub remembers
  perSecond: 200,                        // events from one session; above this they are sampled
  windows: 64,
  lingerMs: 20000,                       // an ended session stays this long, then leaves the scene
  silentMs: 30 * 60 * 1000               // a session with no end signal and no event for this long has ended
};

/* ---------- where the hub keeps its one file ---------- */

/** The hub's folder. WYARDEN_MONITOR_HOME is for tests. */
const monitorHome = (env = process.env) => env.WYARDEN_MONITOR_HOME || path.join(os.homedir(), '.wyarden-monitor');
const hubFile = home => path.join(home || monitorHome(), 'hub.json');
const token = () => crypto.randomBytes(32).toString('base64url');
/** Below every system's range of temporary ports (Linux starts at 32768, Windows at 49152). */
const pickPort = () => 21000 + crypto.randomInt(9000);
const validHub = h => !!h && h.v === VERSION && Number.isInteger(h.port) && h.port > 1023 && h.port < 65536 &&
  typeof h.ingest === 'string' && h.ingest.length >= 32 && typeof h.control === 'string' && h.control.length >= 32;
function readHubFile(home) {
  try { const h = JSON.parse(fs.readFileSync(hubFile(home), 'utf8')); return validHub(h) ? h : null; } catch { return null; }
}
/**
 * The port and the two tokens, made once. The collectors' addresses hold the port and the ingest
 * token, so an existing file is never replaced: a file that cannot be read is an error to show.
 */
function ensureHubFile(home) {
  const dir = home || monitorHome(), file = hubFile(dir);
  const had = readHubFile(dir);
  if (had) return had;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hub = { v: VERSION, port: pickPort(), ingest: token(), control: token(), created: Date.now() };
  try { fs.writeFileSync(file, JSON.stringify(hub, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return hub; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const other = readHubFile(dir);                 // another window made it at the same moment
    if (other) return other;
    throw new Error('The 3D monitor\'s file ' + file + ' cannot be read. Remove the collectors, delete it, and set the collectors up again.');
  }
}

/* ---------- collector addresses ---------- */

const hookPath = (ingest, agent) => '/' + MARK + '/h/' + ingest + '/' + agent;
const hookUrl = (hub, agent) => 'http://127.0.0.1:' + hub.port + hookPath(hub.ingest, agent);
/** Any address this monitor ever wrote, whatever its port or token. */
const HOOK_URL = new RegExp('^http://127\\.0\\.0\\.1:\\d{1,5}/' + MARK + '/h/[A-Za-z0-9_-]+/[a-z]+$');
const isHookUrl = value => typeof value === 'string' && HOOK_URL.test(value);

/* ---------- proving the control token without sending it ----------
 * The port is fixed, so while no hub runs, any program on the machine can listen on it. A window must
 * therefore never hand the control token to whatever answers. It sends a fresh nonce and a keyed
 * hash of the request instead, and the hub proves in turn, in its first message, that it holds
 * the same token. Neither side learns the token from the other.
 */
const AUTH_SCHEME = 'Wyarden';
const keyed = (key, text) => crypto.createHmac('sha256', String(key)).update(text).digest('base64url');
const newNonce = () => crypto.randomBytes(18).toString('base64url');
/** The Authorization header of a control request: `Wyarden <nonce>.<keyed hash of the method, the path and the nonce>`. */
const signRequest = (control, method, pathname, nonce) => AUTH_SCHEME + ' ' + nonce + '.' + keyed(control, 'request\n' + method + '\n' + pathname + '\n' + nonce);
/** The hub's side: the nonce when the header is a good signature of this request, else null. Never throws. */
function checkRequest(control, method, pathname, header) {
  if (typeof header !== 'string' || header.length > 200) return null;
  const m = /^Wyarden ([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{43})$/.exec(header);
  if (!m) return null;
  return sameText(m[2], keyed(control, 'request\n' + method + '\n' + pathname + '\n' + m[1])) ? m[1] : null;
}
/** What the hub puts in `hello.proof`, from the nonce of the attach request. Only a holder of the control token can make it. */
const hubProof = (control, nonce) => keyed(control, 'hub\n' + nonce);
/** Two short texts compared in a time that does not depend on where they differ. */
function sameText(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ---------- paths ---------- */

const isWinPath = p => /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p);
const isPosixPath = p => p.startsWith('/');
const isAbsolute = p => typeof p === 'string' && (isWinPath(p) || isPosixPath(p));
/** Node's path module for the form this path is written in. */
const flavour = p => (isWinPath(p) ? path.win32 : path.posix);
const HOST = process.platform === 'win32' ? path.win32 : path.posix;
/** Case is ignored for a Windows path anywhere, and for any path on macOS. */
const fold = (p, f) => (f === path.win32 || process.platform === 'darwin' ? p.toLowerCase() : p);
function trimSep(p, f) {
  const root = f.parse(p).root;
  return p.length > root.length ? p.replace(/[\\/]+$/, '') : p;
}
/** Normalised, with no trailing separator. Its own case. Nothing is read from disk. */
const lexical = p => { const f = flavour(p); return trimSep(f.normalize(p), f); };
/**
 * A path on another machine (`\\server\share\...`, or `//server/...`). Such a path is never looked
 * up on disk: a `cwd` arrives in a payload, and touching a share the payload names would make this
 * machine sign in to a server of the sender's choosing.
 */
const isNetworkPath = p => /^[\\/]{2}[^\\/]/.test(p);
/** The top of a file system: `/`, or a drive's or a share's root. */
const isFsRoot = p => { const f = flavour(p), lex = lexical(p); return trimSep(f.parse(lex).root, f) === lex || f.parse(lex).root === lex; };
/** The real path when the path exists on this machine, else its lexical form. Its own case. */
function realOf(p) {
  const f = flavour(p), lex = lexical(p);
  if (f !== HOST || isNetworkPath(lex)) return lex;
  try { return trimSep(fs.realpathSync.native(lex), f); } catch { return lex; }
}
/** The form two spellings of one folder share: real, and case-folded where case is ignored. */
const normPath = p => fold(realOf(p), flavour(p));
/** The first 12 hex characters of SHA-256 of the folder's normalised real path. */
const wsKey = folder => crypto.createHash('sha256').update(normPath(folder)).digest('hex').slice(0, 12);

/** `file` relative to `base` with forward slashes, '.' for the folder itself, or null when it is not inside. */
function relativeIn(base, file) {
  const f = flavour(base);
  if (flavour(file) !== f || !isAbsolute(file)) return null;
  const a = fold(lexical(base), f), b = fold(lexical(file), f);
  if (a === b) return '.';
  const prefix = a.endsWith(f.sep) ? a : a + f.sep;
  if (!b.startsWith(prefix)) return null;
  const own = lexical(file), ownBase = lexical(base);
  // Folding can change a string's length for a few letters; then the folded tail is used as it is.
  const tail = fold(own.slice(0, ownBase.length), f) === a ? own.slice(prefix.length) : b.slice(prefix.length);
  return tail.split(f.sep).join('/');
}
const isInside = (base, file) => relativeIn(base, file) !== null;

/**
 * The nearest folder at or above `cwd` that holds a `.git` entry (a folder, or a worktree's file),
 * else `cwd` itself. Folders are read; no git process is started. A path of the other system's
 * form, or on another machine, is its own root and nothing is read.
 */
function sessionRoot(cwd) {
  const f = flavour(cwd), start = lexical(cwd);
  if (f !== HOST || isNetworkPath(start)) return start;
  // A real folder is a few levels deep. The climb stops after MAX_CLIMB, so a made-up path of
  // thousands of levels cannot cost thousands of disk reads.
  let dir = start;
  for (let level = 0; level < MAX_CLIMB; level++) {
    try { if (fs.existsSync(f.join(dir, '.git'))) return dir; } catch { /* unreadable: keep climbing */ }
    const up = f.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return start;
}
const MAX_CLIMB = 64;
/** No folder or file path is longer than this on either system (Linux allows 4096). A longer "path" in a payload is not one. */
const MAX_PATH = 4096;

const rootCache = new Map();
/**
 * What the monitor knows about the folder a session works in:
 *   root: the session root (sessionRoot), real: its real path, ws: its key, name: its base name.
 * Cached for each cwd; the cache is bounded.
 */
function rootInfo(cwd) {
  if (!isAbsolute(cwd) || cwd.length > MAX_PATH) return null;
  const key = lexical(cwd);
  let info = rootCache.get(key);
  if (info) return info;
  const root = sessionRoot(key), f = flavour(root);
  // The top of a file system has no base name; its own text ("/", "C:\") is a path, so it gets a word instead.
  info = Object.freeze({ root, real: realOf(root), ws: wsKey(root), name: cleanName(f.basename(root)) || '(root)' });
  if (rootCache.size >= 500) rootCache.delete(rootCache.keys().next().value);
  rootCache.set(key, info);
  return info;
}
/**
 * A path a tool named, as the monitor may keep it: relative to the session root with forward
 * slashes, or `{ outside: true, name }` (the base name alone) when it is not inside the root.
 * A relative path is taken from `cwd`. Nothing is read from disk.
 * A session whose root is the top of a file system has no "inside": a path relative to `/` is the
 * whole path, so every file there is kept by its base name alone.
 */
function keptPath(info, cwd, file) {
  if (typeof file !== 'string' || !file || !info) return null;
  if (file.length > MAX_PATH || (typeof cwd === 'string' && cwd.length > MAX_PATH)) return { outside: true, name: '?' };
  const f = flavour(info.root);
  const abs = isAbsolute(file) ? file : f.join(cwd || info.root, file);
  const rel = isFsRoot(info.root) ? null : relativeIn(info.root, abs) ?? relativeIn(info.real, abs);
  if (rel !== null) return cleanText(rel, LIMITS.path);
  return { outside: true, name: cleanName(flavour(abs).basename(abs)) || '?' };
}

/* ---------- text that may be kept ---------- */

/** C0 and C1 control characters and the two Unicode line separators, built from codes so no raw control character sits in this file. */
const CONTROL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(0x1f) + String.fromCharCode(0x7f) + '-' + String.fromCharCode(0x9f) + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
/** No control characters, trimmed, cut to `max`. */
function cleanText(value, max) {
  return String(value == null ? '' : value).replace(CONTROL, ' ').trim().slice(0, max);
}
const cleanName = value => cleanText(value, LIMITS.name);
/** Scheme, host and path only: no user, no query, no fragment. Null when it is not an http(s) address. */
function cleanUrl(value) {
  if (typeof value !== 'string') return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return cleanText(url.protocol + '//' + url.host + url.pathname, LIMITS.url);
}
/**
 * Eight hex characters of a hash of the tool's name and input: a repeated call is seen without
 * keeping its input. `salt` (the normaliser makes a random one when it starts) keeps a short,
 * guessable input from being found again by hashing guesses.
 */
function inputHash(tool, input, salt) {
  const hash = crypto.createHash('sha256').update(String(salt || '') + '\n' + String(tool).slice(0, 256) + '\n');
  // The input is a payload's: it can be megabytes, or nested a million deep. So the walk has a budget
  // (values, depth, characters) and its cost never grows with the input beyond that.
  let values = 4000, chars = 262144;
  const walk = (v, depth) => {
    if (values-- <= 0) return;
    if (v === null || typeof v !== 'object') {
      const text = typeof v === 'string' ? v : String(v);
      const part = text.length > chars ? text.slice(0, chars) : text;
      chars -= part.length;
      hash.update(typeof v + text.length + ':' + part + ';');
      return;
    }
    if (depth >= 16) { hash.update('deeper;'); return; }
    if (Array.isArray(v)) {
      hash.update('[' + v.length + ';');
      for (let i = 0; i < v.length && values > 0; i++) walk(v[i], depth + 1);
      hash.update(']');
      return;
    }
    hash.update('{');
    for (const key in v) {
      if (values <= 0) break;
      if (!Object.prototype.hasOwnProperty.call(v, key)) continue;
      hash.update(key.length + ':' + key.slice(0, 256) + '=');
      walk(v[key], depth + 1);
    }
    hash.update('}');
  };
  try { walk(input, 0); } catch { /* a value that cannot be read: what was hashed so far stands */ }
  return hash.digest('hex').slice(0, 8);
}

/* ---------- ids and names: kept only when they look like what they claim to be ----------
 * An id or a name comes from a payload like everything else. Cutting it to 80 characters is not
 * enough: a path or a command line fits in 80 characters. So an id is kept as it is only when it is
 * made of id characters, and a name only when it is made of name characters and a few words; any
 * other value is replaced by a stand-in made from its hash, which still pairs a start with its end
 * and still tells two tools apart, and holds none of the text.
 */
const ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:[\] -]{0,79}$/;
const short = (value, n) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, n);
/** A session id as an agent makes one: letters, digits, "-" and "_". Anything else is not a session. */
const isSessionId = value => typeof value === 'string' && SESSION.test(value);
/** A call, turn or subagent id: itself, or `id-<12 hex>` of its hash. '' for nothing. */
function safeId(value) {
  if (typeof value !== 'string' || !value) return '';
  return ID.test(value) ? value : 'id-' + short(value, 12);
}
/** A tool, server, model or agent-type name: itself, or `unnamed-<6 hex>` of its hash. '' for nothing. */
function safeName(value) {
  if (typeof value !== 'string') return '';
  const text = cleanName(value);
  if (!text) return '';
  // A value longer than a name can be is not shown cut short: a cut path is still most of a path.
  const fits = value.trim().length <= LIMITS.name && NAME.test(text) && text.split(' ').length <= 4 && !text.includes('  ');
  return fits ? text : 'unnamed-' + short(value, 6);
}

module.exports = {
  VERSION, MARK, AGENTS, ALL, LIMITS,
  monitorHome, hubFile, readHubFile, ensureHubFile, validHub, token, pickPort,
  hookPath, hookUrl, HOOK_URL, isHookUrl,
  AUTH_SCHEME, newNonce, signRequest, checkRequest, hubProof, sameText,
  isWinPath, isPosixPath, isAbsolute, isNetworkPath, isFsRoot, flavour, lexical, realOf, normPath, wsKey, relativeIn, isInside, MAX_PATH, MAX_CLIMB,
  sessionRoot, rootInfo, keptPath,
  cleanText, cleanName, cleanUrl, inputHash, isSessionId, safeId, safeName
};
