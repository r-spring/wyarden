/* Wyarden 3D monitor, working mock-up: Claude Code's collector, set up and removed.
 *
 * The collector is one `http` hook entry per event in `<account folder>/settings.json`. Those files
 * are the user's own: they hold permissions, other tools' hooks and sometimes secrets. So this file
 * plans every change as text first (the command shows it in a diff editor), writes only what was
 * shown, and makes removal the exact inverse of set-up. Nothing here loads `vscode`, nothing is
 * asynchronous, and no backup copy is ever made (a copy of a secret is one more place to leak it).
 *
 * The file is never parsed and written back whole: JSON.parse and JSON.stringify reorder number-like
 * keys, drop a repeated key, round large numbers and unescape text. Only the text of the top-level
 * `hooks` member is replaced; every byte outside it stays as it was. Inside it, a value that would
 * not survive that round trip exactly is refused, not rewritten.
 *
 * An entry is ours only when it is an object with `type: "http"` and a `url` that passes
 * `contract.isHookUrl`. Never by position, never by a comment: a user may move, reorder or copy it.
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const contract = require('./contract.js');

const AGENT = 'claude';
const FILE = 'settings.json';
/** Far above any real settings file, and low enough that JSON.parse of a part cannot overflow the stack. */
const MAX_BYTES = 1024 * 1024;      // a settings file is a few kilobytes; scanning costs memory for every token, so a huge one is refused
const MAX_DEPTH = 256;

/**
 * The events registered, and whether each takes a matcher. The one table to change when Claude
 * Code accepts or names an event differently.
 *
 * Not SessionStart and not SessionEnd, measured against Claude Code 2.1.332: the CLI silently
 * skips an http hook for SessionStart, and a refused SessionEnd hook is the one failure it prints
 * on the session's stderr, address and token included. The session file gives both instead.
 * An entry of ours under any other event (an older set-up) is removed by set-up and by removal.
 */
const EVENTS = Object.freeze([
  ['UserPromptSubmit', false],
  ['Stop', false],
  ['StopFailure', false],
  ['PreToolUse', true],
  ['PostToolUse', true],
  ['PostToolUseFailure', true],
  ['PermissionRequest', true],
  ['PermissionDenied', false],
  ['Notification', false],
  ['SubagentStart', false],
  ['SubagentStop', false]
].map(([name, matcher]) => Object.freeze({ name, matcher })));
const EVENT_NAMES = new Set(EVENTS.map(e => e.name));

/** The one entry this monitor writes. The one place to change when its shape changes. */
const entryFor = hub => ({ type: 'http', url: contract.hookUrl(hub, AGENT), timeout: 1 });

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isOurs = h => isObject(h) && h.type === 'http' && contract.isHookUrl(h.url);
/** The same keys and values as the current entry, in any order: a reordered entry is not rewritten. */
function isCurrent(h, want) {
  if (!want) return true;
  const keys = Object.keys(want);
  return Object.keys(h).length === keys.length && keys.every(k => own(h, k) && h[k] === want[k]);
}
function checkHub(hub) {
  if (!hub || !contract.isHookUrl(contract.hookUrl(hub, AGENT))) throw new TypeError('install: a hub with a port and an ingest token is needed.');
}

/* ---------- a scanner over the file's own text ---------- */

/** Which rule a text broke. Never carries any of the text: a key or a value can be a secret. */
class Refused extends Error { constructor(rule) { super(rule); this.rule = rule; } }

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const LITERAL = /true|false|null/y;
const SINGLE = new Set(['{', '}', '[', ']', ':', ',']);
const ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

/** Strict JSON tokens: {k, s, e}, k one of { } [ ] : , s (string) n (number) l (literal). */
function tokenize(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (SINGLE.has(ch)) { out.push({ k: ch, s: i, e: i + 1 }); i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new Refused('syntax');
        const c = text.charCodeAt(j);
        if (c === 34) break;
        if (c < 0x20) throw new Refused('syntax');
        if (c === 92) {
          const x = text[j + 1];
          if (x === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(j + 2, j + 6))) throw new Refused('syntax'); j += 6; }
          else if (ESCAPES.has(x)) j += 2;
          else throw new Refused('syntax');
        } else j++;
      }
      out.push({ k: 's', s: i, e: j + 1 });
      i = j + 1;
      continue;
    }
    const re = ch === '-' || (ch >= '0' && ch <= '9') ? NUMBER : LITERAL;
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) throw new Refused('syntax');
    out.push({ k: re === NUMBER ? 'n' : 'l', s: i, e: i + m[0].length });
    i += m[0].length;
  }
  return out;
}

/**
 * Checks the grammar with a stack of its own (no recursion, so no depth can overflow it), and
 * finds each member of the top-level object: the token of its key, its colon and its value's end.
 */
function structure(tokens) {
  const stack = [], members = [];
  let want = 'value';
  const top = () => stack.length === 1 && stack[0] === '{';
  const valueDone = t => {
    if (stack.length === 0) { want = 'end'; return; }
    if (top()) members[members.length - 1].end = t;
    want = 'after';
  };
  for (let t = 0; t < tokens.length; t++) {
    const k = tokens[t].k;
    if (want === 'value' || want === 'value-or-close') {
      if (want === 'value-or-close' && k === ']') { stack.pop(); valueDone(t); continue; }
      if (k === '{' || k === '[') {
        stack.push(k);
        if (stack.length > MAX_DEPTH) throw new Refused('depth');
        want = k === '{' ? 'key-or-close' : 'value-or-close';
      } else if (k === 's' || k === 'n' || k === 'l') valueDone(t);
      else throw new Refused('syntax');
    } else if (want === 'key-or-close' || want === 'key') {
      if (want === 'key-or-close' && k === '}') { stack.pop(); valueDone(t); continue; }
      if (k !== 's') throw new Refused('syntax');
      if (top()) members.push({ key: t });
      want = 'colon';
    } else if (want === 'colon') {
      if (k !== ':') throw new Refused('syntax');
      if (top()) members[members.length - 1].colon = t;
      want = 'value';
    } else if (want === 'after') {
      const open = stack[stack.length - 1];
      if (k === ',') want = open === '{' ? 'key' : 'value';
      else if (k === (open === '{' ? '}' : ']')) { stack.pop(); valueDone(t); }
      else throw new Refused('syntax');
    } else throw new Refused('syntax');
  }
  if (want !== 'end') throw new Refused('syntax');
  return members;
}

/** A number as sign, significant digits and exponent, so "1.0" and "1" match and a rounded one does not. */
function canonicalNumber(text) {
  const m = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(text);
  let digits = (m[2] + (m[3] || '')).replace(/^0+/, '');
  let exp = Number(m[4] || 0) - (m[3] || '').length;
  if (!digits) return m[1] + '0';
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); exp++; }
  return m[1] + digits + 'e' + exp;
}

/**
 * True when JSON.stringify(JSON.parse(text)) holds the same tokens: the same keys in the same
 * order, the same strings once unescaped, the same numbers exactly. A repeated key, a key that
 * JavaScript moves (a number-like one), a number too large or too precise, or -0, all fail.
 */
function survivesRoundTrip(text, tokens) {
  let again;
  try { again = tokenize(JSON.stringify(JSON.parse(text))); } catch { return false; }
  if (again.length !== tokens.length) return false;
  const rewritten = JSON.stringify(JSON.parse(text));
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i], b = again[i];
    if (a.k !== b.k) return false;
    const ta = text.slice(a.s, a.e), tb = rewritten.slice(b.s, b.e);
    if (a.k === 's' && JSON.parse(ta) !== JSON.parse(tb)) return false;
    if (a.k === 'n' && canonicalNumber(ta) !== canonicalNumber(tb)) return false;
    if (a.k === 'l' && ta !== tb) return false;
  }
  return true;
}

/* ---------- the file's style ---------- */

const BOM = String.fromCharCode(0xfeff);
const NEW_STYLE = Object.freeze({ bom: '', eol: '\n', indent: '  ', final: true });

/** A whole object in a style. Used for a new file, and by tests to write files of every style. */
function serialize(json, style) {
  return style.bom + JSON.stringify(json, null, style.indent).split('\n').join(style.eol) + (style.final ? style.eol : '');
}

/** The byte order mark, line end and indentation unit of a file's text. */
function detectStyle(text, empty = false) {
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = text.slice(bom.length);
  const crlf = (body.match(/\r\n/g) || []).length;
  const lf = (body.match(/\n/g) || []).length - crlf;
  const eol = crlf > 0 && crlf >= lf ? '\r\n' : '\n';
  let indent = '';
  for (const line of body.split(/\r?\n/).slice(1)) {
    const m = /^([ \t]+)\S/.exec(line);
    if (m) { indent = m[1]; break; }
  }
  // Mixed or very deep leading space is hand formatting: no single unit reproduces it.
  if (indent && (!/^( +|\t+)$/.test(indent) || indent.length > 10)) indent = '  ';
  // `{}` reads the same minified or indented; what we add then gets the common style.
  if (!indent && empty) indent = '  ';
  return { bom, eol, indent };
}

/** A value's text, indented to sit on a line that starts with `base`. */
const valueText = (value, style, base) => JSON.stringify(value, null, style.indent).split('\n').join(style.eol + base);
/** The leading space of the line that holds `at`. */
function lineBase(body, at) {
  const start = body.lastIndexOf('\n', at - 1) + 1;
  return /^[ \t]*/.exec(body.slice(start, at))[0];
}

/* ---------- the structure Claude Code expects, checked before anything is touched ---------- */

/** The rule a `hooks` value breaks, or null. Names no key: a key is the file's content too. */
function shapeRule(hooks) {
  if (!isObject(hooks)) return 'hooks-type';
  for (const ev of Object.keys(hooks)) {
    const groups = hooks[ev];
    if (!Array.isArray(groups)) return 'event-type';
    for (const g of groups) if (!isObject(g) || !Array.isArray(g.hooks)) return 'group-type';
  }
  return null;
}

const RULES = {
  syntax: 'is not plain JSON (comments and trailing commas are not plain JSON)',
  depth: 'is nested more than ' + MAX_DEPTH + ' levels deep',
  size: 'is larger than ' + MAX_BYTES / 1024 / 1024 + ' MB',
  utf8: 'is not UTF-8 text',
  top: 'does not hold a JSON object at its top level',
  twice: 'has the "hooks" key more than once',
  exact: 'has hooks that hold something this installer cannot rewrite exactly (a repeated key, a number-like key, or a number it cannot keep exactly)',
  'hooks-type': 'has a "hooks" value that is not an object',
  'event-type': 'has an event under "hooks" whose value is not a list',
  'group-type': 'has a hook group that is not an object with a "hooks" list',
  link: 'is a link to a file that does not exist',
  internal: 'could not be changed exactly by this installer'
};
const refusal = (file, rule) => 'The file ' + file + ' ' + RULES[rule] + ', so it was left unchanged.';

/** installed, stale, partly or missing, for a `hooks` value that passed shapeRule (or none). */
function stateOf(hooks, want) {
  let stale = false;
  const current = new Map();
  for (const ev of Object.keys(hooks || {})) {
    for (const g of hooks[ev]) {
      for (const h of g.hooks) {
        if (!isOurs(h)) continue;
        if (!EVENT_NAMES.has(ev) || !isCurrent(h, want)) stale = true;
        else current.set(ev, (current.get(ev) || 0) + 1);
      }
    }
  }
  for (const n of current.values()) if (n > 1) stale = true;      // a copy made by hand: set-up collapses it
  if (stale) return 'stale';
  const have = EVENTS.filter(e => current.get(e.name) === 1).length;
  if (have === EVENTS.length) return 'installed';
  return have > 0 ? 'partly' : 'missing';
}

/* ---------- reading one folder ---------- */

function blank(dir) {
  return {
    dir, file: path.join(String(dir), FILE), exists: false, before: '', after: '', changed: false,
    state: 'missing', error: null, reformatted: false, added: 0, replaced: 0, collapsed: 0, removed: 0
  };
}

/**
 * The change record with `before` filled, and, when the file may be edited, `doc`: its text, the
 * spans of its top-level members, its style and its parsed `hooks` value (or undefined).
 */
function readFolder(dir) {
  const c = blank(dir);
  if (typeof dir !== 'string' || !dir) { c.error = 'A Claude folder was not named, so nothing was done.'; return { c }; }
  let st;
  try { st = fs.statSync(dir); } catch { c.error = 'The folder ' + dir + ' does not exist, so nothing was created there.'; return { c }; }
  if (!st.isDirectory()) { c.error = 'The path ' + dir + ' is not a folder, so nothing was created there.'; return { c }; }
  let raw;
  try { raw = fs.readFileSync(c.file); } catch (e) {
    if (e.code === 'ENOENT') {
      // A link whose target is gone: writing would replace the link with a file. Refuse instead.
      let link = false;
      try { link = fs.lstatSync(c.file).isSymbolicLink(); } catch { /* nothing there at all */ }
      if (!link) return { c, doc: null };
      c.exists = true; c.state = 'unreadable'; c.error = refusal(c.file, 'link');
      return { c };
    }
    c.exists = true; c.state = 'unreadable';
    c.error = 'The file ' + c.file + ' could not be read (' + (e.code || 'error') + '), so it was left unchanged.';
    return { c };
  }
  c.exists = true;
  c.state = 'unreadable';
  const refuse = rule => { c.error = refusal(c.file, rule); return { c }; };
  if (raw.length > MAX_BYTES) return refuse('size');
  const text = raw.toString('utf8');
  c.before = c.after = text;
  if (!Buffer.from(text, 'utf8').equals(raw)) return refuse('utf8');
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = text.slice(bom.length);
  let tokens, members;
  try { tokens = tokenize(body); members = structure(tokens); } catch (e) {
    if (e instanceof Refused) return refuse(e.rule);
    throw e;
  }
  if (tokens[0].k !== '{') return refuse('top');
  const span = t => ({ s: tokens[t].s, e: tokens[t].e });
  const spans = members.map(m => ({
    key: span(m.key), name: JSON.parse(body.slice(tokens[m.key].s, tokens[m.key].e)),
    colonEnd: tokens[m.colon].e, valueStart: tokens[m.colon + 1].s, valueEnd: tokens[m.end].e
  }));
  const named = spans.filter(m => m.name === 'hooks');
  if (named.length > 1) return refuse('twice');
  const member = named[0] || null;
  let hooks;
  if (member) {
    const inner = body.slice(member.valueStart, member.valueEnd);
    const innerTokens = tokens.filter(t => t.s >= member.valueStart && t.e <= member.valueEnd)
      .map(t => ({ k: t.k, s: t.s - member.valueStart, e: t.e - member.valueStart }));
    hooks = JSON.parse(inner);                   // depth is bounded by MAX_DEPTH, so this cannot overflow
    const rule = shapeRule(hooks);
    if (rule) return refuse(rule);
    if (!survivesRoundTrip(inner, innerTokens)) return refuse('exact');
  }
  const style = detectStyle(text, spans.length === 0);
  return { c, doc: { bom, body, open: tokens[0], close: tokens[tokens.length - 1], members: spans, member, style, hooks } };
}

/* ---------- the edits themselves, on the parsed `hooks` value ---------- */

/** Deletes our entries from one event, and the groups and the event key this empties. A count. */
function removeFromEvent(hooks, ev) {
  const groups = hooks[ev];
  if (groups.length === 0) return 0;             // already empty: not ours to tidy
  let removed = 0;
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi], n = g.hooks.length;
    if (n === 0) continue;                       // already empty: left alone
    const kept = g.hooks.filter(h => !isOurs(h));
    if (kept.length === n) continue;
    removed += n - kept.length;
    if (kept.length === 0) groups.splice(gi, 1);
    else g.hooks = kept;                         // assignment keeps the key's place in the group
  }
  if (removed && groups.length === 0) delete hooks[ev];
  return removed;
}

/** The mark set-up puts on a second entry of ours before it removes it. A value no settings file can hold. */
const EXTRA = Symbol('a second entry of ours');

/** Leaves exactly one current entry of ours (`want`, from entryFor) in each event of EVENTS. Mutates `hooks`. */
function setUp(hooks, want, c) {
  let dirty = false;
  // Ours under an event no longer registered (an older set-up): it would post forever.
  for (const ev of Object.keys(hooks)) {
    if (EVENT_NAMES.has(ev)) continue;
    const n = removeFromEvent(hooks, ev);
    if (n) { c.collapsed += n; dirty = true; }
  }
  for (const { name, matcher } of EVENTS) {
    const groups = own(hooks, name) ? hooks[name] : null;
    let first = null;
    if (groups) {
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        for (let hi = 0; hi < g.hooks.length; hi++) {
          if (!isOurs(g.hooks[hi])) continue;
          if (!first) { first = { g, hi }; continue; }
          g.hooks[hi] = EXTRA;                   // a second one of ours: marked, removed below
        }
      }
      for (let gi = groups.length - 1; gi >= 0; gi--) {
        // Only the mark is removed. A `null` or any other odd entry the user's file holds is not ours to tidy.
        const g = groups[gi], kept = g.hooks.filter(h => h !== EXTRA);
        if (kept.length === g.hooks.length) continue;
        c.collapsed += g.hooks.length - kept.length; dirty = true;
        if (kept.length === 0) groups.splice(gi, 1);
        else g.hooks = kept;
      }
    }
    if (first) {
      if (!isCurrent(first.g.hooks[first.hi], want)) { first.g.hooks[first.hi] = { ...want }; c.replaced++; dirty = true; }
      continue;
    }
    const entry = { ...want };
    c.added++; dirty = true;
    if (!groups) { hooks[name] = [matcher ? { matcher: '*', hooks: [entry] } : { hooks: [entry] }]; continue; }
    // Never into an empty group: removal could not tell it from one set-up made, and would delete it.
    const fits = g => g.hooks.length > 0 && (matcher
      ? !own(g, 'matcher') || g.matcher === '*' || g.matcher === ''
      : !own(g, 'matcher'));
    const target = groups.find(fits);
    if (target) target.hooks.push(entry);
    else groups.push(matcher ? { matcher: '*', hooks: [entry] } : { hooks: [entry] });
  }
  return dirty;
}

/** Deletes every entry of ours, and the groups and event lists this empties. A count. */
function takeDown(hooks, c) {
  for (const ev of Object.keys(hooks)) c.removed += removeFromEvent(hooks, ev);
  return c.removed > 0;
}

/* ---------- the edits, as text ---------- */

/**
 * The new text of the file: `hooks` is the new value, or null to delete the member. Only the
 * member's value (or the member itself, when added or deleted) changes.
 */
function editText(doc, hooks) {
  const { body, open, close, members, member, style } = doc;
  const cut = (s, e, text) => body.slice(0, s) + text + body.slice(e);
  if (member && hooks) return cut(member.valueStart, member.valueEnd, valueText(hooks, style, lineBase(body, member.key.s)));
  if (member) {
    const i = members.indexOf(member);
    // Back to the end of the member before it: the comma, the line end and the member go together.
    if (i > 0) return cut(members[i - 1].valueEnd, member.valueEnd, '');
    if (members.length > 1) return cut(member.key.s, members[1].key.s, '');
    return cut(open.e, close.s, '');
  }
  if (members.length === 0) {
    const inside = style.indent ? style.eol + style.indent + '"hooks": ' + valueText(hooks, style, style.indent) + style.eol : '"hooks":' + valueText(hooks, style, '');
    return cut(open.e, close.s, inside);
  }
  // A new last member, laid out like the members before it.
  const last = members[members.length - 1], base = lineBase(body, last.key.s);
  const between = members.length > 1
    ? body.slice(members[members.length - 2].valueEnd, last.key.s)
    : ',' + (style.indent ? style.eol + base : '');
  const colon = body.slice(last.key.e, last.valueStart);
  const sep = /[\r\n]/.test(colon) ? (style.indent ? ': ' : ':') : colon;
  return cut(last.valueEnd, last.valueEnd, between + '"hooks"' + sep + valueText(hooks, style, base));
}

/** Fills `after`, `changed` and `reformatted`, and checks the new text before anyone sees it. */
function finish(c, doc, hooks, dirty, emptied) {
  if (!dirty) { c.after = c.before; c.changed = false; return c; }
  const body = editText(doc, emptied ? null : hooks);
  c.after = doc.bom + body;
  c.changed = c.after !== c.before;
  if (doc.member && !emptied) {
    // Only the hooks value is ever rewritten; it is "reformatted" when its old text was not in our style.
    const old = doc.body.slice(doc.member.valueStart, doc.member.valueEnd);
    c.reformatted = c.changed && valueText(JSON.parse(old), doc.style, lineBase(doc.body, doc.member.key.s)) !== old;
  }
  // A last check of our own work: the new text is plain JSON and holds exactly the planned hooks.
  try {
    structure(tokenize(body));
    const parsed = JSON.parse(body);
    const ok = emptied ? !own(parsed, 'hooks') : JSON.stringify(parsed.hooks) === JSON.stringify(hooks);
    if (!ok) throw new Error('mismatch');
  } catch {
    c.error = refusal(c.file, 'internal'); c.after = c.before; c.changed = false; c.reformatted = false;
  }
  return c;
}

/* ---------- the API of the contract, section 8.4 ---------- */

/** The change records this module made itself. `apply` writes no other: a record is data, and data can be made by hand. */
const PLANNED = new WeakMap();

// Bind a review to the directory and file it read, even if a replacement has identical bytes.
function identity(file, io, follow) {
  try {
    const st = (follow ? io.statSync : io.lstatSync)(file, { bigint: true });
    return { key: st.dev + ':' + st.ino + ':' + (follow ? io.realpathSync(file) : ''),
      dir: st.isDirectory(), file: st.isFile(), link: st.isSymbolicLink() };
  } catch (error) {
    return error.code === 'ENOENT' ? { key: '' } : null;
  }
}

function targetOf(file, dir, provider, io = fs) {
  const account = identity(dir, io, true);
  const entry = identity(file, io, false);
  if (!account?.dir || !entry || (entry.key && !entry.file && !(provider === AGENT && entry.link))) return null;
  const folder = provider === 'grok' ? identity(path.dirname(file), io, false) : account;
  if (!folder || (folder.key && !folder.dir)) return null;
  const target = entry.key ? identity(file, io, true) : entry;
  if (!target || (entry.key && !target.file)) return null;
  return JSON.stringify([account.key, folder.key, entry.key, target.key]);
}

function remember(c, provider, file, dir, target, applyNative) {
  PLANNED.set(c, { provider, file, dir, target, applyNative, after: c.after, before: c.before,
    exists: c.exists, changed: c.changed, error: c.error });
  return c;
}

/** Never throws on a file's content: anything unexpected becomes an error record. */
function guarded(dir, fn) {
  const file = blank(dir).file;
  const target = targetOf(file, dir, AGENT);
  let c;
  try { c = fn(); } catch {
    c = blank(dir);
    c.error = 'The file ' + c.file + ' ' + RULES.internal + ', so it was left unchanged.';
    c.state = 'unreadable';
    try { c.before = c.after = fs.readFileSync(c.file, 'utf8'); c.exists = true; } catch { /* left empty */ }
  }
  return remember(c, AGENT, file, dir, target);
}

/** Only built-in provider planners can add a native configuration to the reviewed write path. */
function planProvider(provider, hub, dirs, options) {
  const plugins = require('./collectors.js');
  const adapter = plugins.providers[provider];
  if (!adapter || provider === AGENT) throw new TypeError('Unknown native collector');
  const { fileIn, apply: applyNative } = adapter;
  return Array.from(new Set(dirs)).flatMap(dir => {
    const file = fileIn(dir);
    const target = path.isAbsolute(dir) && targetOf(file, dir, provider);
    if (!target) return [{ dir, file, error: 'The collector target is not a safe file in its profile.' }];
    const planned = plugins.planConfig(provider, hub, { ...options, dirs: [dir] });
    const c = planned?.changes?.[0];
    if (planned?.changes?.length !== 1 || c?.file !== file || c.dir !== dir) {
      return [{ dir, file, error: 'The collector could not plan a change for this profile.' }];
    }
    return [remember(c, provider, file, dir, target, applyNative)];
  });
}

function planBridge(dir, file) {
  const target = targetOf(file, dir, 'bridge');
  const source = fs.readFileSync(require.resolve('./hook-bridge.js'), 'utf8').replace(/\r\n/g, '\n');
  const c = { dir, file, exists: false, before: '', after: source, changed: false };
  if (!target || file !== path.join(dir, 'collector-v1.js')) c.error = 'The local collector command cannot be installed safely.';
  else {
    try {
      const st = fs.lstatSync(file, { throwIfNoEntry: false });
      c.exists = !!st;
      if (!st) c.changed = true;
      else if (!st.isFile() || st.size > MAX_BYTES || fs.readFileSync(file, 'utf8') !== c.after) c.error = 'The existing local collector command differs from Wyarden’s copy.';
      else c.before = c.after;
    } catch { c.error = 'The local collector command could not be read.'; }
  }
  return remember(c, 'bridge', file, dir, target);
}

/** What set-up would write in each folder. Nothing is written. */
function plan(dirs, hub) {
  checkHub(hub);
  const want = entryFor(hub);
  return Array.from(dirs || [], dir => guarded(dir, () => {
    const { c, doc } = readFolder(dir);
    if (c.error) return c;
    if (doc === null) {                          // no file yet: our entries alone
      const hooks = {};
      setUp(hooks, want, c);
      c.after = serialize({ hooks }, NEW_STYLE);
      c.changed = true;
      return c;
    }
    const hooks = doc.hooks === undefined ? {} : doc.hooks;
    c.state = stateOf(hooks, want);
    const dirty = setUp(hooks, want, c) || doc.hooks === undefined;
    return finish(c, doc, hooks, dirty, false);
  }));
}

/**
 * What removal would write in each folder. Nothing is written. `hub` is optional: with it, `state`
 * tells a current entry from a stale one; without it, any entry of ours counts as current.
 */
function planRemoval(dirs, hub) {
  let want = null;
  if (hub !== undefined) { checkHub(hub); want = entryFor(hub); }
  return Array.from(dirs || [], dir => guarded(dir, () => {
    const { c, doc } = readFolder(dir);
    if (c.error || doc === null) return c;
    c.state = stateOf(doc.hooks, want);
    if (doc.hooks === undefined || Object.keys(doc.hooks).length === 0) return finish(c, doc, null, false, false);
    const dirty = takeDown(doc.hooks, c);
    // A `hooks` object this removal emptied goes with its member; one that was empty before stays.
    return finish(c, doc, doc.hooks, dirty, dirty && Object.keys(doc.hooks).length === 0);
  }));
}

/** One line for the status bar, from the same per-file states. */
function status(dirs, hub) {
  const changes = plan(dirs, hub);
  const count = s => changes.filter(c => c.state === s).length;
  const folders = changes.length, installed = count('installed');
  const some = installed + count('partly') + count('stale');
  const state = folders > 0 && installed === folders ? 'installed' : some > 0 ? 'partly' : 'missing';
  return { state, folders, installed, stale: count('stale'), unreadable: count('unreadable') };
}

/* ---------- writing ---------- */

const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** On Windows a scanner or an editor can hold the file for a moment; a rename is tried again then. */
function renameRetrying(io, from, to, stillCurrent) {
  for (let attempt = 0; ; attempt++) {
    if (!stillCurrent()) return false;
    try { io.renameSync(from, to); return true; } catch (e) {
      if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      wait(40 * (attempt + 1));
    }
  }
}

/** True when the file is still exactly what the plan read. */
function unchanged(c, io) {
  if (!c.exists) {
    try { io.lstatSync(c.file); return false; } catch (e) { return e.code === 'ENOENT'; }
  }
  try { return io.readFileSync(c.file).equals(Buffer.from(c.before, 'utf8')); } catch { return false; }
}

function applyOne(c, io) {
  const file = c && c.file;
  if (!c || typeof c.file !== 'string' || typeof c.dir !== 'string' || typeof c.before !== 'string' || typeof c.after !== 'string') {
    return { file, written: false, reason: 'not a change made by plan' };
  }
  const approved = PLANNED.get(c);
  if (!approved || file !== approved.file || c.dir !== approved.dir) return { file, written: false, reason: 'not a change made by plan' };
  if (c.error) return { file, written: false, reason: c.error };
  if (!c.changed) return { file, written: false, reason: 'no change' };
  if (!approved.applyNative && approved.provider !== 'bridge') {
    try {
      const body = c.after.startsWith(BOM) ? c.after.slice(1) : c.after;
      const tokens = tokenize(body);
      if (tokens[0].k !== '{') throw new Error('top');
      structure(tokens);
    } catch {
      return { file, written: false, reason: 'the new text is not JSON' };
    }
  }
  if (['before', 'after', 'exists', 'changed', 'error'].some(key => c[key] !== approved[key])) {
    return { file, written: false, reason: 'the plan changed after review' };
  }
  const sameTarget = () => approved.target && targetOf(file, c.dir, approved.provider, io) === approved.target;
  if (!sameTarget()) return { file, written: false, reason: 'changed since it was shown' };
  if (approved.applyNative) return approved.applyNative([c])[0];
  let tmp = null, fd = null;
  try {
    // A settings file kept elsewhere through a link: write the real file, so the link survives.
    let target = c.file, mode = null;
    if (c.exists) {
      try {
        if (io.lstatSync(c.file).isSymbolicLink()) target = io.realpathSync(c.file);
        mode = io.statSync(target).mode & 0o7777;
      } catch { return { file, written: false, reason: 'changed since it was shown' }; }
    }
    tmp = path.join(path.dirname(target), path.basename(target) + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp');
    fd = io.openSync(tmp, 'wx', mode === null ? 0o600 : mode);
    io.writeFileSync(fd, c.after, 'utf8');
    if (mode !== null && process.platform !== 'win32') io.fchmodSync(fd, mode);   // the umask would narrow it
    io.fsyncSync(fd);
    io.closeSync(fd); fd = null;
    const stillCurrent = () => sameTarget() && unchanged(c, io);
    if (c.exists) {
      if (!renameRetrying(io, tmp, target, stillCurrent)) return { file, written: false, reason: 'changed since it was shown' };
      tmp = null;
    } else {
      if (!stillCurrent()) return { file, written: false, reason: 'changed since it was shown' };
      io.linkSync(tmp, target);  // An unrelated file created after the check must win.
    }
    return { file, written: true, reason: null };
  } catch (e) {
    return { file, written: false, reason: e.code === 'EEXIST' ? 'changed since it was shown' : 'it could not be written (' + (e.code || 'error') + ')' };
  } finally {
    if (fd !== null) { try { io.closeSync(fd); } catch { /* already closed */ } }
    if (tmp !== null) { try { io.unlinkSync(tmp); } catch { /* never made, or already gone */ } }
  }
}

/**
 * Writes each change that has one and no error: a temporary file in the same folder, then a
 * rename over the target, so a reader sees the old file or the new one, never half of one.
 * `options.io` replaces `fs`, for tests that make a step fail.
 */
function apply(changes, options = {}) {
  const io = options.io || fs;
  return Array.from(changes || [], c => applyOne(c, io));
}

module.exports = { EVENTS, AGENT, FILE, MAX_BYTES, MAX_DEPTH, entryFor, isOurs, plan, planRemoval, planProvider, planBridge, apply, status, detectStyle, serialize };
