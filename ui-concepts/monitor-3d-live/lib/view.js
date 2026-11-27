/* Wyarden 3D monitor, working mock-up: the tab.
 *
 * One webview panel per window. This file builds its HTML from media/page.html, sets the content
 * security policy, and carries messages both ways: records, workspaces and hub state to the page;
 * the chosen scope, a selection and a request to open something from the page.
 *
 * A hidden tab has no page (VS Code destroys it), so while the tab is hidden the window asks the
 * hub for no scope and receives no records. When the page loads again it says "ready" and gets a
 * fresh snapshot.
 *
 * `vscode` is passed in, so this file can be loaded and tested without an editor.
 */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const C = require('./contract.js');
const actions = require('./actions.js');

const VIEW_TYPE = 'wyardenMonitor.view';
const SCOPE_KEY = 'wyardenMonitor.scope';
const HUB_STATES = ['connecting', 'up', 'blocked', 'stopped'];

/**
 * The page's policy: only the scripts and the stylesheet that carry this page's nonce, nothing from
 * the network, no inline code or style. The editor's own `cspSource` is not used: it allows a whole
 * family of hosts, and every file this page loads can carry the nonce instead.
 */
function policy(nonce) {
  return "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
}
/** media/page.html with its three placeholders filled. */
function fillTemplate(template, values) {
  return template.split('{{csp}}').join(values.csp).split('{{nonce}}').join(values.nonce).split('{{base}}').join(values.base);
}
/** A scope a page may ask for: "all", or a workspace key (12 hex characters). */
const validScope = scope => scope === C.ALL || (typeof scope === 'string' && /^[0-9a-f]{12}$/.test(scope));

class MonitorView {
  /**
   * deps.client        the hub client of this window
   * deps.folders()     this window's folders: [{path, name}]
   * deps.collectors()  {claude: {state, folders, installed}} for the status line
   * deps.log(message)
   */
  constructor(vscode, context, deps) {
    this.vscode = vscode; this.context = context; this.deps = deps;
    this.panel = undefined; this.ready = false;
    this.workspaces = undefined;          // the hub's last "workspaces" message
    this.hubState = 'connecting';
  }

  /* ---------- the panel ---------- */

  show() {
    if (this.panel) { this.panel.reveal(undefined, false); return; }
    const vscode = this.vscode;
    this.adopt(vscode.window.createWebviewPanel(VIEW_TYPE, '3D Monitor', vscode.ViewColumn.Active, this.options()));
  }
  options() {
    return { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [this.vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
  }
  /**
   * A tab the editor kept from the last session. It is restored late, when it is first shown, so
   * the owner may have opened a new tab meanwhile: there is one live tab per window, and a second
   * would sit there with no feed. The restored one is closed then, and the live one is shown.
   */
  restore(panel) {
    if (this.panel && this.panel !== panel) { panel.dispose(); this.panel.reveal(undefined, false); return; }
    this.adopt(panel);
  }
  /** Take a panel: a new one, or one VS Code restored after a restart. */
  adopt(panel) {
    this.panel = panel; this.ready = false;
    panel.webview.options = this.options();
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage(message => { try { this.fromPage(message); } catch (error) { this.deps.log('page message: ' + error.message); } });
    panel.onDidChangeViewState(() => { if (!panel.visible) this.pause(); });
    panel.onDidDispose(() => { if (this.panel === panel) { this.panel = undefined; this.pause(); } });
  }
  html(webview) {
    const media = this.vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const template = fs.readFileSync(path.join(this.context.extensionPath, 'media', 'page.html'), 'utf8');
    const nonce = crypto.randomBytes(18).toString('base64url');
    return fillTemplate(template, { csp: policy(nonce), nonce, base: webview.asWebviewUri(media).toString().replace(/\/+$/, '') });
  }
  /** No page is there to draw: ask the hub for nothing. */
  pause() {
    if (!this.ready) return;
    this.ready = false;
    this.deps.client.update({ scope: null });
  }
  post(message) {
    if (this.panel && this.ready) void this.panel.webview.postMessage(Object.assign({ v: C.VERSION }, message));
  }

  /* ---------- which workspace ---------- */

  /** The owner's last choice for this window, else this window's first folder, else every open workspace. */
  wanted() {
    const saved = this.context.workspaceState.get(SCOPE_KEY);
    if (validScope(saved)) return saved;
    const first = this.deps.folders()[0];
    return first ? C.wsKey(first.path) : C.ALL;
  }
  setScope(scope) {
    if (!validScope(scope)) return;
    void this.context.workspaceState.update(SCOPE_KEY, scope);
    if (this.ready) this.deps.client.update({ scope });
  }

  /* ---------- from the page ---------- */

  fromPage(message) {
    if (!message || typeof message !== 'object' || message.v !== C.VERSION) return;
    if (message.type === 'ready') {
      this.ready = true;
      this.sendLook(); this.sendHub(); this.sendWorkspaces();
      this.deps.client.update({ scope: this.wanted(), snapshot: true });
    } else if (message.type === 'scope') {
      this.setScope(message.scope);
    } else if (message.type === 'act') {
      const request = actions.checkAct(message);
      if (!request) return;
      const deps = { resolve: target => this.deps.client.resolve(target), folders: () => this.deps.folders().map(f => f.path) };
      actions.open(this.vscode, deps, request).catch(error => {
        void this.vscode.window.showWarningMessage('3D Monitor: that could not be opened (' + error.message + ').');
      });
    }
    // "select" needs nothing from the host yet: the selection lives in the page.
  }

  /* ---------- to the page ---------- */

  fromHub(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'records') this.post({ type: 'records', scope: message.scope, records: message.records });
    else if (message.type === 'workspaces') { this.workspaces = message; this.sendWorkspaces(); }
  }
  setHubState(state) {
    this.hubState = HUB_STATES.includes(state) ? state : 'connecting';
    if (this.hubState !== 'up') this.workspaces = undefined;      // the list belongs to a hub that is gone
    this.sendHub();
    // A hub that came (back) up has an empty picture for this window: ask again for what the page shows.
    if (this.hubState === 'up' && this.ready) this.deps.client.update({ scope: this.wanted(), snapshot: true });
  }
  sendWorkspaces() {
    const m = this.workspaces;
    if (!m) return;
    this.post({ type: 'workspaces', list: m.list, hidden: m.hidden, scope: m.scope, here: this.deps.folders().map(f => C.wsKey(f.path)) });
  }
  sendHub() {
    this.post({ type: 'hub', state: this.hubState, role: this.deps.client.role || 'client', collectors: this.deps.collectors() });
  }
  sendLook() {
    const kind = this.vscode.window.activeColorTheme.kind, K = this.vscode.ColorThemeKind;
    this.post({ type: 'look', look: kind === K.Light || kind === K.HighContrastLight ? 'glasshouse' : 'nexus' });
  }
}

module.exports = { MonitorView, VIEW_TYPE, SCOPE_KEY, policy, fillTemplate, validScope };
