/* Wyarden 3D monitor, working mock-up: everything about a node that is not drawing.
 *
 * - the reading order and the keyboard moves from node to node;
 * - the list twin of the scene (the same nodes as rows of text, for screen readers);
 * - the inspector's facts and its "In VS Code" list, which says what a double-click does now.
 *
 * Copied from ui-concepts/monitor-3d/nav.js. Changed for live data: an agent shows its folder and
 * where its calls come from (Claude Code's hooks, exact, or the transcript, derived), and the
 * "In VS Code" list names only what is wired in this slice (a double-click or Ctrl+Enter opens a
 * file or an address, and shows a session's terminal or chat panel, also from one of its subagents)
 * and says so plainly for every other class.
 * Changed again at the owner's word: an agent is named by its provider (the scene's caption says
 * "CLAUDE"), so the list and the inspector name the provider, its tab's title and its workspace.
 * In the scene the title shows only under the pointer; here it is always written out.
 *
 * Pure functions of the model: no DOM here, so they can be tested in Node.
 */
(function (root) {
  'use strict';
  const inNode = typeof module !== 'undefined' && module.exports;
  const L = inNode ? require('./layout.js') : root.MonitorLayout;
  const M = inNode ? require('./model.js') : root.MonitorModel;
  const E = inNode ? require('./engine.js') : root.MonitorEngine;      // for the providers' names, which the scene's captions use

  const clock = t => new Date(t).toISOString().slice(11, 19) + ' UTC';     // a clock time never needs a redraw as time passes
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const stateOf = n => M.STATES[n.status] || M.STATES.rest;
  const kindName = n => (n.cls === 'resource' ? { file: 'files in a folder', url: 'URLs on a host', context: 'context' }[n.kind] : '');
  const own = (object, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key);
  /** A provider's name as the scene writes it ("Claude"); an unknown one as it came. */
  const providerName = kind => (E && E.PROVIDERS && own(E.PROVIDERS, kind) ? E.PROVIDERS[kind] : String(kind || 'agent'));
  /** The provider of an agent or a subagent: its own, else its session's (a snapshot from before subagents carried one). */
  const providerOf = (n, model) => (typeof n.kind === 'string' && n.cls !== 'resource' && n.kind ? n.kind : ((model && model.sessions.get(n.owner)) || {}).kind || '');
  const text = value => (typeof value === 'string' ? value.trim() : '');
  /** An agent's heading: its provider and its folder ("Claude site-docs"). */
  const agentName = n => providerName(n.kind) + ' ' + (text(n.root) || String(n.label || '').replace(/^\S+\s+/, ''));

  /* ---------- order and keyboard ---------- */

  function cellNodes(model, col, floor) {
    const cell = model.cells.get(col + '|' + floor);
    if (!cell) return [];
    const slots = floor === 'agent' ? [L.AGENT_SLOT, 0, 1, 2, 3, 5, 6, 7, L.STACK_SLOT] : [0, 1, 2, 3, 4, 5, 6, 7, L.STACK_SLOT];
    return slots.map(slot => cell.slots[slot]).filter(id => id != null && model.nodes.has(id));
  }
  /** Reading order: each session's column from the agent down to its resources, then the MCP servers. */
  function order(model) {
    const out = [];
    for (const col of model.columnsInUse()) for (const floor of L.floorsOf(col)) out.push(...cellNodes(model, col, floor));
    out.push(...cellNodes(model, L.DOCK, 'mcp'));
    return out;
  }
  function floorRow(model, floor) {
    const out = [];
    for (const col of floor === 'mcp' ? [L.DOCK] : model.columnsInUse()) out.push(...cellNodes(model, col, floor));
    return out;
  }
  /**
   * Where a key takes the selection. Left and Right walk along a floor, Up and Down change floor
   * inside a column (the MCP floor is the dock, and `memo` remembers which column to come back to),
   * Page Up and Page Down step through everything, Home and End jump to the ends.
   */
  function move(model, id, key, memo) {
    const all = order(model);
    if (!all.length) return '';
    const n = model.nodes.get(id);
    if (!n || n.folded) return key === 'End' || key === 'PageUp' || key === 'ArrowLeft' || key === 'ArrowUp' ? all[all.length - 1] : all[0];
    const at = all.indexOf(id);
    if (key === 'Home') return all[0];
    if (key === 'End') return all[all.length - 1];
    if (key === 'PageDown') return all[(at + 1) % all.length];
    if (key === 'PageUp') return all[(at - 1 + all.length) % all.length];
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      const row = floorRow(model, n.floor), i = row.indexOf(id) + (key === 'ArrowRight' ? 1 : -1);
      return i >= 0 && i < row.length ? row[i] : id;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      const dir = key === 'ArrowDown' ? 1 : -1;
      if (memo && n.col !== L.DOCK) memo.col = n.col;
      const home = n.col !== L.DOCK ? n.col : memo && model.columns[memo.col] != null ? memo.col : model.columnsInUse()[0];
      for (let f = L.FLOORS.indexOf(n.floor) + dir; f >= 0 && f < L.FLOORS.length; f += dir) {
        const floor = L.FLOORS[f], ids = floor === 'mcp' ? cellNodes(model, L.DOCK, 'mcp') : home === undefined ? [] : cellNodes(model, home, floor);
        if (!ids.length) continue;
        if (n.col === L.DOCK) return ids[0];             // coming back from the dock: the agent, or the first of the floor
        return ids.slice().sort((a, b) => Math.abs(model.nodes.get(a).slot - n.slot) - Math.abs(model.nodes.get(b).slot - n.slot))[0];
      }
    }
    return id;
  }

  /* ---------- the list twin ---------- */

  /** One line of text that says what a node is, its state in words, and its counts. An agent's first
      sentence says, in this order: its provider, its tab's title in quotes, its workspace, its state. */
  function line(n, model) {
    const state = stateOf(n).name;
    if (n.cls === 'agent') {
      const wait = n.wait && n.wait.why !== 'idle' ? ' (' + n.wait.why + (n.wait.tool ? ' for ' + n.wait.tool : '') + ')' : '';
      const title = text(n.title), space = text(n.space);
      return 'Agent: ' + providerName(n.kind) + (title ? ', “' + title + '”' : '') + (space ? ', in ' + space : text(n.root) ? ', folder ' + text(n.root) : '') +
        ', ' + state + wait + ' since ' + clock(n.since) + '. ' + plural(n.calls, 'call') + ', ' + n.open + ' open, ' + n.failed + ' failed.';
    }
    if (n.cls === 'subagent') return 'Subagent of ' + providerName(providerOf(n, model)) + ': ' + n.label + '. ' + state + '. ' + plural(n.calls, 'call') + '.';
    if (n.cls === 'tool') return 'Tool: ' + n.label + '. ' + state + '. ' + plural(n.calls, 'call') + ', ' + n.open + ' open, ' + n.failed + ' failed.';
    if (n.cls === 'mcp') return 'MCP server: ' + n.label + '. ' + state + '. ' + plural(n.calls, 'call') + ', ' + n.open + ' open, ' + plural(n.ports.size, 'tool') + '.';
    if (n.cls === 'resource') return 'Resource, ' + kindName(n) + ': ' + n.label + '. ' + (n.open ? 'in use. ' : '') + 'read ' + n.reads + ', write ' + n.writes + (n.searches ? ', search ' + n.searches : '') + (n.unknowns ? ', unknown ' + n.unknowns : '') + '.';
    const what = { subagent: 'subagent', tool: 'tool', resource: 'resource', mcp: 'MCP server' }[n.of];
    return 'Stack: ' + plural(n.count, what) + ' folded' + (n.open ? ', ' + n.open + ' in use' : '') + '.';
  }
  /**
   * The scene as groups of rows. Agents waiting for the owner come first, longest wait first; then
   * each session's column; then the MCP servers. Every standing node has exactly one row in the
   * column and server groups (`key` equals its id); an attention row repeats an agent (`key` differs).
   */
  function rows(model) {
    const groups = [], waiting = [];
    for (const n of model.nodes.values()) if (n.cls === 'agent' && n.status === 'needs') waiting.push(n);
    waiting.sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : 1));
    if (waiting.length) groups.push({ title: 'Needs you (' + waiting.length + ')', rows: waiting.map(n => ({ key: 'attention ' + n.id, id: n.id, text: line(n, model) })) });
    for (const col of model.columnsInUse()) {
      const list = [];
      for (const floor of L.floorsOf(col)) for (const id of cellNodes(model, col, floor)) list.push({ key: id, id, text: line(model.nodes.get(id), model) });
      groups.push({ col, title: columnTitle(model, col), rows: list });
    }
    const servers = cellNodes(model, L.DOCK, 'mcp');
    if (servers.length) groups.push({ title: 'MCP servers, at the boundary', rows: servers.map(id => ({ key: id, id, text: line(model.nodes.get(id), model) })) });
    return groups;
  }
  /** A column's group title: its agent's provider and the workspace it works in (its folder when no workspace is named). */
  function columnTitle(model, col) {
    const session = model.sessions.get(model.columns[col]), agent = session && model.nodes.get(session.agentId);
    if (!agent) return 'Column ' + (col + 1);
    const space = text(agent.space);
    return 'Column ' + (col + 1) + ': ' + (space ? providerName(agent.kind) + ' in ' + space : agentName(agent));
  }

  /* ---------- the inspector ---------- */

  /* What VS Code does for each class in this slice. These are labels, not controls: the double-click
     and Ctrl+Enter are the only ways in. A file or an address is opened; a session, or the session a
     subagent belongs to, is only shown (never started, stopped or changed). Nothing else has anything
     behind them yet. */
  const ACTIONS = {
    open: ['Double-click, or Ctrl+Enter: open it in the editor', 'A folder with several files lists them first; a searched folder is shown in the Explorer.'],
    url: ['Double-click, or Ctrl+Enter: open the address', 'VS Code shows the address and asks before it opens your browser.'],
    select: ['A click selects it', 'The selection stays in this view. Nothing else happens.'],
    context: ['Nothing is wired for this kind of resource yet', 'A web search or an MCP resource keeps no address that could be opened.'],
    agent: ['Double-click, or Ctrl+Enter: show its terminal or chat panel', 'For a session in a terminal of this window, or in this window\'s Claude Code chat panel. For any other, a message says so and nothing is opened.'],
    subagent: ['Double-click, or Ctrl+Enter: show its session', 'The terminal or chat panel of the session that started it, as for an agent.'],
    tool: ['Nothing is wired for a tool yet', 'A list of its last calls comes in a later step.'],
    mcp: ['Nothing is wired for an MCP server yet', 'Opening its configuration comes in a later step.'],
    stack: ['Nothing is wired for a stack yet', 'Tidy unfolds it when there is room.']
  };
  const actions = keys => keys.map(key => ({ key, label: ACTIONS[key][0], detail: ACTIONS[key][1] }));
  /** Whether a double-click or Ctrl+Enter on this node asks the host to open something. */
  const opens = n => !!n && n.cls === 'resource' && (n.kind === 'file' || n.kind === 'url');
  /**
   * What a double-click or Ctrl+Enter on this node asks the host for, or null when it asks for nothing.
   * A file group or a URL group is opened. An agent is shown (its terminal or chat panel), and a subagent
   * shows the agent of its own session: the host knows a session by its agent node, not by a subagent.
   * A subagent whose session or agent node is not in the model asks for nothing.
   */
  function act(n, model) {
    if (opens(n)) return { action: 'open', class: n.cls, id: n.id };
    if (!n) return null;
    if (n.cls === 'agent') return { action: 'focus', class: 'agent', id: n.id };
    if (n.cls !== 'subagent' || !model) return null;
    const s = model.sessions.get(n.owner);
    return s && model.nodes.has(s.agentId) ? { action: 'focus', class: 'agent', id: s.agentId } : null;
  }
  /** Where an agent's calls come from, in plain words. The grade is named, as everywhere else. */
  const sourceOf = n => (n.collector
    ? 'exact, from ' + (n.kind === 'claude' ? "Claude Code's" : "the agent's") + ' hooks'
    : 'derived, read from the transcript; set up the collector for exact calls');
  const result = n => (n.lastOk == null ? 'none yet' : (n.lastOk ? 'ok' : 'failed (' + (n.lastError || 'failed') + ')') + (n.lastMs == null ? '' : ', ' + n.lastMs + ' ms'));
  const ownerLabel = (n, model) => { const s = model.sessions.get(n.owner); const a = s && model.nodes.get(s.agentId); return a ? agentName(a) : ''; };

  /** Everything the inspector shows for a node: facts as label and value, lists, and the "In VS Code" labels. */
  function describe(n, model) {
    const state = stateOf(n), out = {
      id: n.id, cls: n.cls, className: M.CLASS_NAME[n.cls], kindName: kindName(n), title: n.label, status: n.status, stateName: state.name,
      stateLine: n.cls === 'stack' ? '' : state.name + (n.since ? ' since ' + clock(n.since) : '') + (n.grade ? ' (' + n.grade + ')' : ''),
      facts: [], lists: [], actions: []
    };
    const fact = (label, value) => { if (value !== '' && value != null) out.facts.push([label, String(value)]); };
    if (n.cls === 'agent') {
      const s = model.sessions.get(n.owner);
      out.title = agentName(n);
      fact('Provider', providerName(n.kind)); fact('Tab title', text(n.title)); fact('Workspace', text(n.space));
      fact('Folder', n.root || 'not reported yet'); fact('Card', n.card); fact('Session id', n.session);
      fact('Calls', sourceOf(n));
      fact('Model', n.model); fact('Column', n.col + 1);
      if (n.wait) fact('Waiting for', n.wait.why + (n.wait.tool ? ' for ' + n.wait.tool : '') + ', since ' + clock(n.wait.since) + ' (' + n.wait.grade + ')');
      fact('Turn', n.turn); fact('Calls made', n.calls + ', ' + n.open + ' open, ' + n.failed + ' failed');
      fact('Subagents', [...s.nodes].filter(id => (model.nodes.get(id) || {}).cls === 'subagent').length);
      const last = s.history.slice(-5).reverse().map(c => clock(c.t) + '  ' + c.what + '  ' + (c.ok ? 'ok' : 'failed: ' + c.error) + (c.ms == null ? '' : '  ' + c.ms + ' ms' + (c.msGrade ? ' (' + c.msGrade + ')' : '')));
      if (last.length) out.lists.push({ title: 'Last calls', items: last });
      out.actions = actions(['agent', 'select']);
    } else if (n.cls === 'subagent') {
      fact('Provider', providerName(providerOf(n, model))); fact('Type', n.type); fact('Id', n.sub); fact('Agent', ownerLabel(n, model)); fact('Calls seen', n.calls);
      if (n.reported != null) fact('Reported at stop', plural(n.reported, 'call') + (n.ms == null ? '' : ', ' + n.ms + ' ms'));
      fact('Started by call', n.parentCall);
      out.actions = actions(['subagent', 'select']);
    } else if (n.cls === 'tool') {
      fact('Tool', n.tool); fact('Kind of call', n.toolClass); fact('Agent', ownerLabel(n, model));
      fact('Calls', n.calls + ', ' + n.open + ' open, ' + n.failed + ' failed'); fact('Last call', result(n));
      out.actions = actions(['select', 'tool']);
    } else if (n.cls === 'mcp') {
      fact('Server', n.server); fact('Configured in', n.source ? n.source + ' settings' : '');
      fact('Calls', n.calls + ', ' + n.open + ' open, ' + n.failed + ' failed'); fact('Last call', result(n));
      fact('Used by', [...n.usedBy].map(key => { const s = model.sessions.get(key), a = s && model.nodes.get(s.agentId); return a ? agentName(a) : ''; }).filter(Boolean).join(', '));
      out.lists.push({ title: 'Tools (' + (n.ports.size + n.morePorts) + ')', items: [...n.ports.values()].map(p => p.name + '  ' + plural(p.calls, 'call') + (p.open ? ', ' + p.open + ' open' : '') + (p.failed ? ', ' + p.failed + ' failed' : '')) });
      out.actions = actions(['select', 'mcp']);
    } else if (n.cls === 'resource') {
      fact('Kind', kindName(n)); fact(n.kind === 'url' ? 'Host' : n.kind === 'file' ? 'Folder' : 'Item', n.group); fact('Agent', ownerLabel(n, model));
      fact('Touches', n.touches + ': read ' + n.reads + ', write ' + n.writes + ', search ' + n.searches + ', unknown ' + n.unknowns);
      const members = [...n.members.entries()].sort((a, b) => b[1].last - a[1].last);
      if (members.length) out.lists.push({
        title: (n.kind === 'url' ? 'Pages' : n.kind === 'file' ? 'Files' : 'Parts') + ' (' + (members.length + n.more) + ')',
        items: members.slice(0, 8).map(([name, m]) => name + '  read ' + m.reads + ', write ' + m.writes + (m.unknowns ? ', unknown ' + m.unknowns : '')).concat(members.length + n.more > 8 ? ['and ' + (members.length + n.more - 8) + ' more'] : [])
      });
      const clashes = [...model.arcs.values()].filter(a => a.a === n.id || a.b === n.id);
      if (clashes.length) out.lists.push({ title: 'Also written by', items: clashes.map(a => ownerLabel(model.nodes.get(a.a === n.id ? a.b : a.a), model) + ': ' + a.paths.join(', ')) });
      out.actions = actions(n.kind === 'file' ? ['open', 'select'] : n.kind === 'url' ? ['url', 'select'] : ['select', 'context']);
    } else {
      const folded = model.foldedIn(n), cell = model.cell(n.col, n.floor);
      fact('Holds', plural(n.count, 'item') + ' with no slot'); fact('In use now', n.open || '');
      if (n.col !== L.DOCK) { const a = model.nodes.get('a:' + model.columns[n.col]); fact('Agent', a ? agentName(a) : ''); }
      out.lists.push({ title: 'Folded', items: folded.slice(-12).reverse().map(f => f.label).concat(n.count > 12 ? ['and ' + (n.count - Math.min(12, folded.length)) + ' more' + (cell.dropped ? ' (' + cell.dropped + ' no longer remembered)' : '')] : []) });
      out.actions = actions(['select', 'stack']);
    }
    return out;
  }

  const api = { order, move, rows, line, describe, clock, opens, act, sourceOf, providerName, providerOf, agentName, columnTitle, ACTIONS };
  if (inNode) module.exports = api; else root.MonitorNav = api;
})(typeof window === 'undefined' ? globalThis : window);
