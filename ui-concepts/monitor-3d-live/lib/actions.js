/* Wyarden 3D monitor, working mock-up: what a double-click does.
 *
 * The page never names a path, a command or a window: it sends a node's id. This file asks the hub
 * what that node stands for, checks the answer, and shows a terminal, or runs an ordinary VS Code
 * command. Nothing here starts, stops or changes a session, and nothing is written.
 *
 * `open` opens a file or an address, or reveals a folder. `focus` only shows a session that already
 * runs in this window: its terminal, or Claude Code's chat panel. For any other session it shows one
 * message and runs nothing, because the chat panel's command would start a second copy of it.
 *
 * `vscode` is passed in, so the checks below can be tested against a stand-in.
 */
'use strict';
const fs = require('node:fs');
const C = require('./contract.js');

const CLASSES = ['agent', 'subagent', 'tool', 'resource', 'mcp', 'stack'];
const ACTIONS = ['open', 'focus'];
/** Claude Code's command that shows a chat panel session's tab. Given any other session id, it starts that session again. */
const PANEL_COMMAND = 'claude-vscode.editor.open';
/** How long the terminals' process ids are waited for. A terminal that is still starting may never answer. */
const TERMINAL_WAIT = 1500;
const DIGITS = /^\d+$/;
/** Two start times this far apart (in FILETIME's 100 ns units: 1 ms) are two processes, not one read twice. */
const SAME_START = 10000n;
/** A chain longer than this is not a process's ancestry (lib/procs.js stops at 16); the rest is not read. */
const MAX_CHAIN = 64;

/** A page message that asks for an action, or null when its shape is wrong. */
function checkAct(message) {
  if (!message || typeof message !== 'object' || !ACTIONS.includes(message.action)) return null;
  const target = message.target;
  if (!target || typeof target.id !== 'string' || !target.id || target.id.length > 1200 || !CLASSES.includes(target.class)) return null;
  const member = typeof message.member === 'string' && message.member.length <= C.LIMITS.path ? message.member : undefined;
  return { action: message.action, target: { class: target.class, id: target.id }, member };
}

/**
 * Open what a resource node stands for.
 *   deps.resolve(target) -> the hub's answer (docs/monitor-3d/05-working-mockup.md, section 7.4)
 *   deps.folders()       -> this window's folder paths
 */
async function open(vscode, deps, request) {
  if (request.target.class !== 'resource') return 'nothing';
  let found;
  try { found = await deps.resolve({ id: request.target.id, member: request.member }); }
  catch { found = null; }
  if (!found || typeof found !== 'object') {
    if (!deps.claim) void vscode.window.showWarningMessage('3D Monitor: the hub did not answer.');
    return 'no-answer';
  }
  const here = file => deps.folders().some(folder => C.isInside(folder, file));
  const forward = async member => {
    const result = await deps.elsewhere?.('open', { id: request.target.id, member });
    if (result === 'failed') throw new Error('the other editor window could not complete the action');
    return result;
  };

  if (found.kind === 'file') {
    const members = Array.isArray(found.members) ? found.members.filter(m => m && typeof m.path === 'string' && C.isAbsolute(m.path) && typeof m.name === 'string') : [];
    if (!members.length) {
      if (!deps.claim) void vscode.window.showInformationMessage('3D Monitor: no file is remembered for this group.');
      return 'empty';
    }
    let pick = members[0];
    if (deps.claim && (members.length !== 1 || request.member !== pick.name || !here(pick.path))) return 'nothing';
    if (members.length > 1) {
      const chosen = await vscode.window.showQuickPick(
        members.map(m => ({ label: m.name, description: typeof found.folder === 'string' ? found.folder : '', member: m })),
        { placeHolder: 'Open which file?' });
      if (!chosen) return 'cancelled';
      pick = chosen.member;
    }
    if (!isFile(pick.path)) {
      if (!deps.claim) void vscode.window.showInformationMessage('3D Monitor: ' + pick.name + ' is not on disk (any more).');
      return 'missing';
    }
    if (!here(pick.path) && await forward(pick.name) === 'opened') return 'opened';
    if (deps.claim && !await deps.claim()) return 'nothing';
    await deps.focusWindow?.();
    await vscode.window.showTextDocument(vscode.Uri.file(pick.path), { preview: true, viewColumn: deps.viewColumn ?? vscode.ViewColumn.Beside });
    return 'opened';
  }

  if (found.kind === 'dir' && typeof found.path === 'string' && C.isAbsolute(found.path)) {
    const uri = vscode.Uri.file(found.path);
    const local = here(found.path);
    if (deps.claim && (!local || !await deps.claim())) return 'nothing';
    if (!local && await forward() === 'revealed') return 'revealed';
    if (local) await deps.focusWindow?.();
    await vscode.commands.executeCommand(local ? 'revealInExplorer' : 'revealFileInOS', uri);
    return 'revealed';
  }

  if (deps.claim) return 'nothing';                 // URLs are confirmed and opened in the requesting window.
  if (found.kind === 'url') {
    const urls = Array.isArray(found.urls) ? found.urls.filter(u => C.cleanUrl(u) === u) : [];
    if (!urls.length) return 'empty';
    let url = urls[0];
    if (urls.length > 1) {
      url = await vscode.window.showQuickPick(urls, { placeHolder: 'Open which address in the browser?' });
      if (!url) return 'cancelled';
    }
    const go = await vscode.window.showWarningMessage('Open this address in the browser?', { modal: true, detail: url }, 'Open');
    if (go !== 'Open') return 'cancelled';
    await vscode.env.openExternal(vscode.Uri.parse(url, true));
    return 'opened';
  }

  if (found.kind === 'outside') { void vscode.window.showInformationMessage('3D Monitor: that file is outside the session\'s folder, so only its name is kept.'); return 'outside'; }
  void vscode.window.showInformationMessage('3D Monitor: there is nothing to open for this node.');
  return 'nothing';
}
function isFile(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }

/**
 * Show a session that runs in this window: its terminal, or its Claude Code chat panel.
 *   deps.resolve(target)    -> the hub's answer; for an agent node {kind: 'session', agent, session, cwd, root, pid}
 *   deps.session(sessionId) -> that session's entry of discover.liveClaudeSessions, or null
 *   deps.ancestors(pid)     -> {chain, known, start, unit} (lib/procs.js)
 *   deps.hostPid            -> this window's extension host
 * The steps are in the order of docs/monitor-3d/05-working-mockup.md; the first that fits ends it.
 *
 * Every value an answer gives is read once and then only that copy is checked and used: a getter that
 * answered one thing to the check could answer another to the use.
 */
async function focus(vscode, deps, request) {
  const info = text => { if (!deps.claim) void vscode.window.showInformationMessage('3D Monitor: ' + text); };
  const forward = async () => {
    const result = await deps.elsewhere?.('focus', { id: request.target.id });
    if (result === 'failed') throw new Error('the other editor window could not show the session');
    return result === 'terminal' || result === 'panel' ? result : null;
  };
  if (request.target.class !== 'agent') return 'nothing';

  let found;
  try { found = await deps.resolve({ id: request.target.id }); }
  catch { found = null; }
  if (!found || typeof found !== 'object') {
    if (!deps.claim) void vscode.window.showWarningMessage('3D Monitor: the hub did not answer.');
    return 'no-answer';
  }
  let kind, session;
  try { kind = found.kind; session = found.session; } catch { kind = undefined; }
  if (kind !== 'session' || !C.isSessionId(session)) { info('this session is no longer live.'); return 'gone'; }

  // The session's own file names its process. The hub's pid is not used: only the file also says where the
  // session runs and when its process started, and those must describe the same process as the pid.
  let file;
  try {
    const entry = await deps.session(session);
    file = entry && typeof entry === 'object' ? { pid: entry.pid, entry: entry.entry, procStart: entry.procStart } : null;
  } catch { file = null; }
  if (!file || !Number.isInteger(file.pid) || file.pid <= 0) {
    info('no running process is known for this session, so its terminal or chat panel cannot be found.');
    return 'no-process';
  }

  const tree = await processTree(deps, file.pid);
  if (!tree) {
    info('the process list could not be read, so this session\'s terminal or chat panel cannot be found.');
    return 'unknown';
  }
  const chain = tree.chain;
  const holds = pid => Number.isInteger(pid) && pid > 0 && chain.includes(pid);

  // A process id is reused once its process ends. `same` is true only when the start times prove the file's
  // process is the system's, false only when they prove it is another, and undefined when nothing is proved.
  const same = sameProcess(tree.unit, file.procStart, tree.start);
  if (same === false) { info('this session has ended. Another program now runs under its process id.'); return 'stale'; }

  // Showing a terminal starts nothing, so a terminal is shown also when `same` is not known.
  const terminal = await terminalOf(vscode, holds);
  if (terminal) {
    if (deps.claim && !await deps.claim()) return 'nothing';
    await deps.focusWindow?.();
    terminal.show();
    return 'terminal';
  }

  if (file.entry === 'claude-vscode') {
    // The command only reveals a session this window's Claude Code already runs; for any other it starts one.
    // So it is run only for a session whose process is under this extension host and is proved to be the
    // file's own: a leftover file whose pid another program here now holds must not start anything.
    if (!holds(deps.hostPid)) {
      const shown = await forward();
      if (shown) return shown;
      info('this session\'s chat panel is in another window.');
      return 'elsewhere';
    }
    if (same !== true) { info('this session\'s own process could not be confirmed, so its chat panel was not opened.'); return 'unconfirmed'; }
    const commands = await vscode.commands.getCommands(true);
    if (!Array.isArray(commands) || !commands.includes(PANEL_COMMAND)) {
      info('this session runs in Claude Code\'s chat panel, but Claude Code\'s command to show it is not available in this window.');
      return 'no-panel-command';
    }
    if (deps.claim && !await deps.claim()) return 'nothing';
    await deps.focusWindow?.();
    await vscode.commands.executeCommand(PANEL_COMMAND, session);
    return 'panel';
  }
  if (file.entry === 'sdk-cli') { info('this session runs in the background. It has no terminal or chat panel to show.'); return 'headless'; }
  const shown = await forward();
  if (shown) return shown;
  if (holds(deps.hostPid)) { info('this session runs in this window, but not in a terminal or chat panel that can be shown from here.'); return 'unshown'; }
  info('this session\'s terminal is not in this window. It runs in another window, or outside the editor.');
  return 'elsewhere';
}

/**
 * The process list's answer for `pid`, copied: {chain, start, unit}, or null when it could not be read.
 * Each field is read once. The chain becomes a new plain array, read by index, of at most MAX_CHAIN
 * positive whole numbers: no method of the answer's own array is called, so its own `includes` (or a
 * Proxy round it) cannot say yes to a pid it does not hold.
 */
async function processTree(deps, pid) {
  try {
    const tree = await deps.ancestors(pid);
    if (!tree || typeof tree !== 'object') return null;
    const known = tree.known, raw = tree.chain, start = tree.start, unit = tree.unit;
    if (known !== true || !Array.isArray(raw)) return null;
    const length = raw.length, chain = [];
    for (let i = 0; i < Math.min(Number.isInteger(length) ? length : 0, MAX_CHAIN); i++) {
      const p = raw[i];
      if (Number.isInteger(p) && p > 0) chain.push(p);
    }
    return { chain, start, unit };
  } catch {
    return null;                                     // the list, or a getter on its answer, failed
  }
}

/**
 * Whether the file's process is the one the system has under that pid. FILETIME values read twice differ
 * by less than 1 ms. A Linux tick count that matches exactly cannot match by chance; one that does not
 * match proves nothing, because what Claude Code writes into `procStart` there was never measured.
 */
function sameProcess(unit, mine, theirs) {
  if (typeof mine !== 'string' || !DIGITS.test(mine) || typeof theirs !== 'string' || !DIGITS.test(theirs)) return undefined;
  if (unit === 'filetime') {
    const gap = BigInt(mine) - BigInt(theirs);
    return gap < SAME_START && -gap < SAME_START;
  }
  if (unit === 'ticks') return mine === theirs ? true : undefined;
  return undefined;
}

/**
 * The first of this window's terminals, in the list's order, whose process is one `holds` names.
 * A terminal's process id comes as a thenable. They are asked for together, and waited for at most
 * TERMINAL_WAIT: one that fails, or has not answered by then, counts as a terminal with no id.
 */
async function terminalOf(vscode, holds) {
  const terminals = Array.isArray(vscode.window.terminals) ? vscode.window.terminals : [];
  if (!terminals.length) return null;
  const ids = new Array(terminals.length).fill(undefined);
  let timer;
  const late = new Promise(resolve => { timer = setTimeout(resolve, TERMINAL_WAIT); });
  // Promise.resolve takes a thenable as it is; a getter or a `then` that throws becomes a failure here.
  const asked = terminals.map((t, i) => Promise.resolve().then(() => t.processId).then(id => { ids[i] = id; }, () => {}));
  try { await Promise.race([Promise.all(asked), late]); }
  finally { clearTimeout(timer); }
  const at = ids.findIndex(holds);
  return at < 0 ? null : terminals[at];
}

module.exports = { checkAct, open, focus, ACTIONS, CLASSES, PANEL_COMMAND };
