/* Wyarden 3D monitor, working mock-up: what a double-click does.
 *
 * The page never names a path, a command or a window: it sends a node's id. This file asks the hub
 * what that node stands for, checks the answer, and runs an ordinary VS Code command. Nothing here
 * starts, stops or changes a session, and nothing is written.
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
  if (!found || typeof found !== 'object') { void vscode.window.showWarningMessage('3D Monitor: the hub did not answer.'); return 'no-answer'; }

  if (found.kind === 'file') {
    const members = Array.isArray(found.members) ? found.members.filter(m => m && typeof m.path === 'string' && C.isAbsolute(m.path) && typeof m.name === 'string') : [];
    if (!members.length) { void vscode.window.showInformationMessage('3D Monitor: no file is remembered for this group.'); return 'empty'; }
    let pick = members[0];
    if (members.length > 1) {
      const chosen = await vscode.window.showQuickPick(
        members.map(m => ({ label: m.name, description: typeof found.folder === 'string' ? found.folder : '', member: m })),
        { placeHolder: 'Open which file?' });
      if (!chosen) return 'cancelled';
      pick = chosen.member;
    }
    if (!isFile(pick.path)) { void vscode.window.showInformationMessage('3D Monitor: ' + pick.name + ' is not on disk (any more).'); return 'missing'; }
    // Beside the monitor, not over it: a tab that is covered has no page, and the scene would stop while the file is read.
    await vscode.window.showTextDocument(vscode.Uri.file(pick.path), { preview: true, viewColumn: vscode.ViewColumn.Beside });
    return 'opened';
  }

  if (found.kind === 'dir' && typeof found.path === 'string' && C.isAbsolute(found.path)) {
    const uri = vscode.Uri.file(found.path);
    const here = deps.folders().some(folder => C.isInside(folder, found.path));
    await vscode.commands.executeCommand(here ? 'revealInExplorer' : 'revealFileInOS', uri);
    return 'revealed';
  }

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
 *   deps.ancestors(pid)     -> {chain, known, start} (lib/procs.js)
 *   deps.hostPid            -> this window's extension host
 * The steps are in the order of docs/monitor-3d/05-working-mockup.md; the first that fits ends it.
 */
async function focus(vscode, deps, request) {
  const info = text => { void vscode.window.showInformationMessage('3D Monitor: ' + text); };
  if (request.target.class !== 'agent') return 'nothing';

  let found;
  try { found = await deps.resolve({ id: request.target.id }); }
  catch { found = null; }
  if (!found || typeof found !== 'object') { void vscode.window.showWarningMessage('3D Monitor: the hub did not answer.'); return 'no-answer'; }
  if (found.kind !== 'session' || !C.isSessionId(found.session)) { info('this session is no longer live.'); return 'gone'; }
  const session = found.session;

  // The session's own file names its process. The hub's pid is not used: only the file also says where the
  // session runs and when its process started, and those must describe the same process as the pid.
  let entry;
  try { entry = await deps.session(session); }
  catch { entry = null; }
  if (!entry || typeof entry !== 'object' || !Number.isInteger(entry.pid) || entry.pid <= 0) {
    info('no running process is known for this session, so its terminal or chat panel cannot be found.');
    return 'no-process';
  }

  let tree;
  try { tree = await deps.ancestors(entry.pid); }
  catch { tree = null; }
  if (!tree || typeof tree !== 'object' || tree.known !== true || !Array.isArray(tree.chain)) {
    info('the process list could not be read, so this session\'s terminal or chat panel cannot be found.');
    return 'unknown';
  }
  const chain = tree.chain;
  const holds = pid => Number.isInteger(pid) && pid > 0 && chain.includes(pid);

  // A process id is reused once its process ends. The start time in the file and the one the system gives
  // must be the same process's; when either is not known, the check cannot be made and is skipped.
  if (typeof entry.procStart === 'string' && DIGITS.test(entry.procStart) && typeof tree.start === 'string' && DIGITS.test(tree.start)) {
    const gap = BigInt(entry.procStart) - BigInt(tree.start);
    if (gap >= SAME_START || -gap >= SAME_START) { info('this session has ended. Another program now runs under its process id.'); return 'stale'; }
  }

  const terminal = await terminalOf(vscode, holds);
  if (terminal) { terminal.show(); return 'terminal'; }

  if (entry.entry === 'claude-vscode') {
    // The command only reveals a session this window's Claude Code already runs; for any other it starts one.
    // So it is run only for a session whose process is under this extension host.
    if (!holds(deps.hostPid)) { info('this session\'s chat panel is in another window.'); return 'elsewhere'; }
    const commands = await vscode.commands.getCommands(true);
    if (!Array.isArray(commands) || !commands.includes(PANEL_COMMAND)) {
      info('this session runs in Claude Code\'s chat panel, but Claude Code\'s command to show it is not available in this window.');
      return 'no-panel-command';
    }
    await vscode.commands.executeCommand(PANEL_COMMAND, session);
    return 'panel';
  }
  if (entry.entry === 'sdk-cli') { info('this session runs in the background. It has no terminal or chat panel to show.'); return 'headless'; }
  if (holds(deps.hostPid)) { info('this session runs in this window, but not in a terminal or chat panel that can be shown from here.'); return 'unshown'; }
  info('this session\'s terminal is not in this window. It runs in another window, or outside the editor.');
  return 'elsewhere';
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
