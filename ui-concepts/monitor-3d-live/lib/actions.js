/* Wyarden 3D monitor, working mock-up: what a double-click does.
 *
 * The page never names a path, a command or a window: it sends a node's id. This file asks the hub
 * what that node stands for, checks the answer, and runs an ordinary VS Code command. Nothing here
 * starts, stops or changes a session, and nothing is written.
 *
 * `vscode` is passed in, so the checks below can be tested against a stand-in.
 */
'use strict';
const fs = require('node:fs');
const C = require('./contract.js');

const CLASSES = ['agent', 'subagent', 'tool', 'resource', 'mcp', 'stack'];
const ACTIONS = ['open'];

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

module.exports = { checkAct, open, ACTIONS, CLASSES };
