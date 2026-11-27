/* Monitor 3D mock-up: the live model.
 *
 * It is fed one event at a time, in the vocabulary of docs/monitor-3d/02-live-signals.md section 11,
 * and changes in place: nothing is re-seeded or replayed. It holds five node classes (agent,
 * subagent, tool, resource, MCP server) and nothing else, because nothing else has a live signal.
 * A call is a link that exists from its start event to its end event.
 */
(function (root) {
  'use strict';
  const L = typeof module !== 'undefined' && module.exports ? require('./layout.js') : root.MonitorLayout;

  const VERSION = 1;
  const EVENTS = ['session.start', 'session.end', 'turn.start', 'turn.end', 'tool.start', 'tool.end', 'resource.touch',
    'mcp.start', 'mcp.end', 'subagent.start', 'subagent.stop', 'wait.start', 'wait.end'];
  const AGENT_KINDS = ['claude', 'codex', 'grok', 'antigravity'];
  const CLASSES = ['agent', 'subagent', 'tool', 'resource', 'mcp'];
  const CLASS_NAME = { agent: 'Agent', subagent: 'Subagent', tool: 'Tool', resource: 'Resource', mcp: 'MCP server', stack: 'Stack' };
  const RESOURCE_KINDS = ['file', 'url', 'context'];
  const TOUCH_KINDS = ['file', 'dir', 'url', 'search', 'mcp-resource'];
  const OPS = ['read', 'write', 'search', 'unknown'];
  const WHYS = ['permission', 'question', 'idle'];
  const OUTCOMES = ['done', 'failed', 'interrupted'];
  /* One shape, one colour and one name for each state, most urgent first. The shapes are the ones
     the Godot looks use, so a state never borrows a class's silhouette. */
  const STATES = {
    needs: { name: 'needs you', shape: 'pyramid', rank: 0 },
    failed: { name: 'failed', shape: 'cross', rank: 1 },
    working: { name: 'working', shape: 'globe', rank: 2 },
    unclear: { name: 'unclear', shape: 'diamond', rank: 3 },
    idle: { name: 'idle', shape: 'hourglass', rank: 4 },
    done: { name: 'done', shape: 'dot', rank: 5 },
    rest: { name: 'at rest', shape: '', rank: 6 }
  };

  const HISTORY = 50;          // calls remembered for each session
  const MEMBER_CAP = 40;       // files remembered inside one folder group
  const PORT_CAP = 8;          // ports drawn on one MCP server
  const PORT_MAX = 32;         // ports remembered on one MCP server
  const STACK_CAP = 200;       // folded items remembered in one stack; older ones become a bare count
  const ARC_CAP = 24;          // clash arcs drawn
  const WRITER_CAP = 2000;     // written paths remembered for clash arcs
  const CLOSED_CAP = 64;       // ended calls waiting for the view to take them
  const STALE_MS = 30000;      // an idle node this old may give its slot to a folded node that woke up

  const fail = message => { throw new Error('monitor model: ' + message); };
  const short = id => (id.length > 8 ? id.slice(0, 6) : id);

  function validate(e) {
    if (!e || typeof e !== 'object') fail('an event must be an object');
    if (e.v !== VERSION) fail('unknown schema version ' + e.v);
    if (!EVENTS.includes(e.ev)) fail('unknown event "' + e.ev + '"');
    if (!Number.isFinite(e.t)) fail(e.ev + ': t must be a number');
    if (!AGENT_KINDS.includes(e.agent)) fail(e.ev + ': unknown agent "' + e.agent + '"');
    if (typeof e.session !== 'string' || !e.session) fail(e.ev + ': session is missing');
    if (e.grade !== 'exact' && e.grade !== 'derived') fail(e.ev + ': grade must be exact or derived');
    const need = (...keys) => { for (const k of keys) if (typeof e[k] !== 'string' || !e[k]) fail(e.ev + ': ' + k + ' is missing'); };
    if (e.ev === 'tool.start') need('call', 'tool');
    if (e.ev === 'tool.end') { need('call'); if (typeof e.ok !== 'boolean') fail('tool.end: ok must be true or false'); }
    if (e.ev === 'mcp.start') need('call', 'server', 'tool');
    if (e.ev === 'mcp.end') { need('call', 'server', 'tool'); if (typeof e.ok !== 'boolean') fail('mcp.end: ok must be true or false'); }
    if (e.ev === 'resource.touch') {
      if (!TOUCH_KINDS.includes(e.kind)) fail('resource.touch: unknown kind "' + e.kind + '"');
      if (!OPS.includes(e.op)) fail('resource.touch: unknown op "' + e.op + '"');
    }
    if (e.ev === 'subagent.start' || e.ev === 'subagent.stop') need('sub');
    if (e.ev === 'wait.start' && !WHYS.includes(e.why)) fail('wait.start: unknown why "' + e.why + '"');
    if (e.ev === 'turn.end' && !OUTCOMES.includes(e.outcome)) fail('turn.end: unknown outcome "' + e.outcome + '"');
  }

  /** Which group a touch belongs to: files by folder, URLs by host, everything else a context item. */
  function groupOf(e) {
    if (e.kind === 'file' || e.kind === 'dir') {
      if (typeof e.path !== 'string') return { kind: 'file', key: '(outside the workspace)', member: (e.path && e.path.name) || '?' };
      const path = e.path.replace(/\\/g, '/').replace(/^\.\//, '');
      if (e.kind === 'dir') return { kind: 'file', key: (path.replace(/\/+$/, '') || '.') + '/', member: '' };
      const cut = path.lastIndexOf('/');
      return { kind: 'file', key: cut < 0 ? './' : path.slice(0, cut + 1), member: path.slice(cut + 1) };
    }
    if (e.kind === 'url') {
      const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)([^?#]*)/i.exec(e.url || '');
      return { kind: 'url', key: m ? m[1] : '(unknown host)', member: m ? (m[2] || '/') : '?' };
    }
    if (e.kind === 'search') return { kind: 'context', key: 'web search', member: '' };
    return { kind: 'context', key: 'MCP resource / ' + (e.server || '?'), member: e.scheme ? e.scheme + ':' : '' };
  }

  class Model {
    constructor() {
      this.nodes = new Map();       // id -> node
      this.cells = new Map();       // "col|floor" -> { col, floor, slots[9], folded[], dropped }
      this.columns = [];            // column index -> session key, or null for a gap
      this.sessions = new Map();    // session key -> session record
      this.overflow = new Set();    // sessions with no column to stand in
      this.links = new Map();       // link id -> open call, or a touch made by an open call
      this.arcs = new Map();        // clash arcs between two agents' copies of one written file
      this.writers = new Map();     // "ws|path" -> Map(session key -> resource node id)
      this.closed = [];             // calls that ended since the view last asked
      this.changed = new Set();     // node ids touched since the view last asked
      this.structure = false;       // true when a node appeared, left, folded or unfolded
      this.rev = 0;
      this.now = 0;
      this.counts = { events: 0, rejected: 0 };
      this.leftOut = { events: 0, arcs: 0 };
    }

    /* ---------- cells, slots and stacks ---------- */

    cell(col, floor) {
      const key = col + '|' + floor;
      let cell = this.cells.get(key);
      if (!cell) { cell = { col, floor, slots: new Array(L.SLOTS).fill(null), folded: [], dropped: 0 }; this.cells.set(key, cell); }
      return cell;
    }
    stackId(col, floor) { return 'k:' + col + ':' + floor; }
    syncStack(cell) {
      const id = this.stackId(cell.col, cell.floor), count = cell.folded.length + cell.dropped;
      let stack = this.nodes.get(id);
      if (!count) {
        if (stack) { this.nodes.delete(id); cell.slots[L.STACK_SLOT] = null; this.structure = true; this.changed.add(id); }
        return;
      }
      if (!stack) {
        const of = cell.floor === 'agent' ? 'subagent' : cell.floor;
        stack = { id, cls: 'stack', of, col: cell.col, floor: cell.floor, slot: L.STACK_SLOT, folded: false, status: 'rest', open: 0, count: 0, first: this.now, last: this.now };
        this.nodes.set(id, stack); cell.slots[L.STACK_SLOT] = id; this.structure = true;
      }
      let open = 0;
      for (const fid of cell.folded) open += this.nodes.get(fid).open;
      if (stack.count !== count || stack.open !== open) {
        stack.count = count; stack.open = open; stack.label = '+' + count; stack.status = open ? 'working' : 'rest'; this.changed.add(id);
      }
    }
    isIdle(n) { return n.cls !== 'agent' && n.cls !== 'stack' && n.open === 0 && n.status !== 'working' && n.status !== 'needs'; }
    oldestIdle(cell, cls, before) {
      let best = null;
      for (const slot of L.slotsFor(cls)) {
        const n = this.nodes.get(cell.slots[slot]);
        if (n && this.isIdle(n) && n.last < before && (!best || n.last < best.last)) best = n;
      }
      return best;
    }
    /** Give a new node a slot. Nothing that already stands moves: the node takes the lowest free
        slot, or the slot of the idle node that has been quiet longest (which folds into the stack),
        or it is born folded when every slot is busy. */
    addNode(node) {
      if (!CLASSES.includes(node.cls)) fail('unknown node class "' + node.cls + '"');
      if (this.nodes.has(node.id)) fail('node "' + node.id + '" exists already');
      node.floor = L.FLOOR_OF[node.cls]; node.folded = false; node.open = node.open || 0;
      node.status = node.status || 'rest'; node.first = node.last = this.now;
      const cell = this.cell(node.col, node.floor);
      this.nodes.set(node.id, node); this.structure = true; this.changed.add(node.id);
      const free = L.slotsFor(node.cls).find(slot => cell.slots[slot] == null);
      if (free !== undefined) { node.slot = free; cell.slots[free] = node.id; return node; }
      if (node.cls === 'agent') fail('column ' + node.col + ' has an agent already');
      const victim = this.oldestIdle(cell, node.cls, Infinity);
      if (victim) { const slot = victim.slot; this.fold(victim); node.slot = slot; cell.slots[slot] = node.id; }
      else { node.slot = -1; node.folded = true; cell.folded.push(node.id); this.trimStack(cell); this.syncStack(cell); }
      return node;
    }
    fold(node) {
      const cell = this.cell(node.col, node.floor);
      cell.slots[node.slot] = null; node.slot = -1; node.folded = true; cell.folded.push(node.id);
      this.trimStack(cell); this.syncStack(cell); this.structure = true; this.changed.add(node.id);
    }
    trimStack(cell) {
      while (cell.folded.length > STACK_CAP) {
        const index = cell.folded.findIndex(id => this.nodes.get(id).open === 0);
        if (index < 0) break;
        const gone = this.nodes.get(cell.folded.splice(index, 1)[0]);
        this.forget(gone); cell.dropped++;
      }
    }
    /** A folded node that is used again comes back when a slot is free, or when a node in its cell
        has been idle for STALE_MS. Otherwise it stays folded and its link goes to the stack. */
    surface(node) {
      if (!node.folded) return;
      const cell = this.cell(node.col, node.floor);
      let slot = L.slotsFor(node.cls).find(s => cell.slots[s] == null);
      if (slot === undefined) {
        const victim = this.oldestIdle(cell, node.cls, this.now - STALE_MS);
        if (!victim) return;
        slot = victim.slot; this.fold(victim);
      }
      cell.folded.splice(cell.folded.indexOf(node.id), 1);
      node.folded = false; node.slot = slot; cell.slots[slot] = node.id;
      this.syncStack(cell); this.structure = true; this.changed.add(node.id);
    }
    forget(node) {
      this.nodes.delete(node.id); this.changed.add(node.id); this.structure = true;
      const s = node.owner && this.sessions.get(node.owner);
      if (s) s.nodes.delete(node.id);
      for (const [id, link] of this.links) if (link.from === node.id || link.to === node.id) this.links.delete(id);
      for (const [id, arc] of this.arcs) if (arc.a === node.id || arc.b === node.id) this.arcs.delete(id);
    }
    removeNode(node) {
      const cell = this.cell(node.col, node.floor);
      if (node.folded) cell.folded.splice(cell.folded.indexOf(node.id), 1); else cell.slots[node.slot] = null;
      this.forget(node); this.syncStack(cell);
    }
    /** The node to draw for an id: itself, or the stack it is folded into. */
    visibleId(id) {
      const n = this.nodes.get(id);
      return !n ? null : n.folded ? this.stackId(n.col, n.floor) : id;
    }
    touch(node) { node.last = this.now; this.changed.add(node.id); }
    setStatus(node, status, e) {
      if (node.status !== status) { node.status = status; node.since = e.t; node.grade = e.grade; }
      this.changed.add(node.id);
    }

    /* ---------- sessions ---------- */

    ensureSession(e) {
      const key = e.agent + ':' + e.session;
      let s = this.sessions.get(key);
      if (s) return s;
      if (e.ev === 'session.end') { this.overflow.delete(key); return null; }
      let col = -1;
      for (let i = 0; i < L.MAX_COLUMNS && col < 0; i++) if (this.columns[i] == null) col = i;
      if (col < 0) {
        const ended = [...this.sessions.values()].filter(x => x.ended).sort((a, b) => a.endedAt - b.endedAt)[0];
        if (ended) { col = ended.col; this.removeSession(ended); }
      }
      if (col < 0) { this.overflow.add(key); return null; }
      this.overflow.delete(key);
      s = { key, col, kind: e.agent, session: e.session, agentId: 'a:' + key, turnOpen: false, ended: false, endedAt: 0, calls: new Map(), history: [], nodes: new Set() };
      this.sessions.set(key, s); this.columns[col] = key;
      this.own(s, this.addNode({
        id: s.agentId, cls: 'agent', col, kind: e.agent, label: e.agent + ' ' + short(e.session), session: e.session, ws: e.ws || '',
        status: e.ev === 'session.start' ? 'idle' : 'unclear', grade: e.grade, since: e.t, calls: 0, failed: 0, model: '', turn: '', wait: null
      }));
      return s;
    }
    own(s, node) { node.owner = s.key; s.nodes.add(node.id); return node; }
    removeSession(s) {
      for (const id of [...s.nodes]) { const n = this.nodes.get(id); if (n) this.removeNode(n); }
      for (const server of this.nodes.values()) if (server.cls === 'mcp') server.usedBy.delete(s.key);
      for (const [path, who] of this.writers) { who.delete(s.key); if (!who.size) this.writers.delete(path); }
      this.sessions.delete(s.key); this.columns[s.col] = null; this.structure = true;
    }
    agentOf(s) { return this.nodes.get(s.agentId); }
    subagent(s, sub, e) {
      const id = 's:' + s.key + ':' + sub;
      let n = this.nodes.get(id);
      if (!n) n = this.own(s, this.addNode({ id, cls: 'subagent', col: s.col, sub, type: '', label: 'subagent ' + short(sub), status: 'working', grade: e.grade, since: e.t, calls: 0, failed: 0 }));
      else if (e.ev !== 'subagent.stop') this.surface(n);
      return n;
    }
    callerOf(s, e) { return e.by && e.by !== '?' ? this.subagent(s, e.by, e) : this.agentOf(s); }
    tool(s, name, e) {
      const id = 't:' + s.key + ':' + name;
      let n = this.nodes.get(id);
      if (!n) n = this.own(s, this.addNode({ id, cls: 'tool', col: s.col, tool: name, label: name, toolClass: e.class || 'other', calls: 0, failed: 0, lastOk: null, lastMs: null, lastError: '' }));
      else this.surface(n);
      return n;
    }
    server(name, e) {
      const id = 'm:' + name;
      let n = this.nodes.get(id);
      if (!n) n = this.addNode({ id, cls: 'mcp', col: L.DOCK, server: name, label: name, source: e.serverSource || '', calls: 0, failed: 0, lastOk: null, lastMs: null, ports: new Map(), morePorts: 0, usedBy: new Set() });
      else this.surface(n);
      return n;
    }
    port(server, name) {
      let p = server.ports.get(name);
      if (!p) {
        if (server.ports.size >= PORT_MAX) { server.morePorts++; return null; }
        p = { name, calls: 0, open: 0, failed: 0 }; server.ports.set(name, p);
      }
      return p;
    }
    resource(s, e) {
      const g = groupOf(e), id = 'r:' + s.key + ':' + g.kind + ':' + g.key;
      let n = this.nodes.get(id);
      if (!n) n = this.own(s, this.addNode({ id, cls: 'resource', col: s.col, kind: g.kind, group: g.key, label: g.key, members: new Map(), more: 0, reads: 0, writes: 0, searches: 0, unknowns: 0, touches: 0 }));
      else this.surface(n);
      const field = { read: 'reads', write: 'writes', search: 'searches', unknown: 'unknowns' }[e.op];
      n[field]++; n.touches++;
      if (g.member) {
        let member = n.members.get(g.member);
        if (!member && n.members.size >= MEMBER_CAP) n.more++;
        else {
          if (!member) { member = { reads: 0, writes: 0, searches: 0, unknowns: 0, last: 0 }; n.members.set(g.member, member); }
          member[field]++; member.last = e.t;
        }
      }
      const count = n.members.size + n.more, only = count === 1 && n.members.size === 1 ? [...n.members.keys()][0] : '';
      if (n.kind === 'file') {
        const outside = n.group.charAt(0) === '(';
        n.label = only ? (outside ? only + ' ' + n.group : (n.group === './' ? '' : n.group) + only) : count > 1 ? n.group + ' (' + count + ' files)' : n.group;
        // The short name is what the scene's caption shows: the file, or the last folder and a count.
        n.short = only || (outside ? 'outside' : n.group.slice(0, -1).split('/').pop() + '/' + (count > 1 ? ' (' + count + ')' : ''));
      } else if (n.kind === 'url') n.label = count > 1 ? n.group + ' (' + count + ' pages)' : n.group;
      this.touch(n);
      return n;
    }

    /* ---------- calls ---------- */

    openCall(s, e, kind, target, port) {
      if (s.calls.has(e.call)) return;
      const caller = this.callerOf(s, e), agent = this.agentOf(s);
      const link = { id: e.call, kind, from: caller.id, to: target.id, call: e.call, session: s.key, what: e.tool, port: port ? port.name : '', unclear: e.by === '?', t: e.t };
      this.links.set(link.id, link);
      s.calls.set(e.call, { kind, target: target.id, caller: caller.id, port: port ? port.name : '', links: [link.id], touched: [], t: e.t });
      target.calls++; target.open++; this.touch(target); this.setStatus(target, 'working', e);
      if (port) { port.calls++; port.open++; }
      agent.calls++; agent.open = s.calls.size; this.touch(agent);
      if (caller !== agent) { caller.calls++; caller.open++; this.touch(caller); }
      this.syncFolded(target);
    }
    closeCall(s, callId, e) {
      const call = s.calls.get(callId);
      if (!call) return null;
      s.calls.delete(callId);
      for (const id of call.links) {
        const link = this.links.get(id);
        if (!link) continue;
        this.links.delete(id);
        this.closed.push(Object.assign({}, link, { ok: e && typeof e.ok === 'boolean' ? e.ok : null }));
        if (this.closed.length > CLOSED_CAP) this.closed.shift();
      }
      const target = this.nodes.get(call.target), caller = this.nodes.get(call.caller), agent = this.agentOf(s);
      if (target) {
        target.open = Math.max(0, target.open - 1); this.changed.add(target.id);
        const port = call.port && target.ports && target.ports.get(call.port);
        if (port) { port.open = Math.max(0, port.open - 1); if (e && e.ok === false) port.failed++; }
        this.syncFolded(target);
      }
      if (agent) { agent.open = s.calls.size; this.changed.add(agent.id); }
      if (caller && caller !== agent) { caller.open = Math.max(0, caller.open - 1); this.changed.add(caller.id); }
      for (const id of call.touched) {
        const res = this.nodes.get(id);
        if (!res) continue;
        res.open = Math.max(0, res.open - 1); res.status = res.open ? 'working' : 'rest'; this.changed.add(id); this.syncFolded(res);
      }
      return call;
    }
    syncFolded(node) { if (node.folded) this.syncStack(this.cell(node.col, node.floor)); }
    endCall(s, e, target) {
      const call = this.closeCall(s, e.call, e), agent = this.agentOf(s);
      if (!call) { target.calls++; agent.calls++; }            // the start was never seen: still count the call
      if (e.ok === false) { target.failed++; agent.failed++; }
      target.lastOk = e.ok; target.lastMs = Number.isFinite(e.ms) ? e.ms : null; target.lastError = e.ok === false ? (e.error || 'failed') : '';
      this.touch(target);
      this.setStatus(target, target.open ? 'working' : e.ok === false ? 'failed' : 'rest', e);
      s.history.push({ call: e.call, what: target.cls === 'mcp' ? target.server + ' / ' + e.tool : target.tool, ok: e.ok, ms: target.lastMs, msGrade: e.msGrade || '', error: target.lastError, t: e.t });
      if (s.history.length > HISTORY) s.history.shift();
    }
    clash(s, res, e) {
      if (typeof e.path !== 'string') return;
      const key = (e.ws || '') + '|' + e.path;
      let who = this.writers.get(key);
      if (!who) {
        if (this.writers.size >= WRITER_CAP) this.writers.delete(this.writers.keys().next().value);
        who = new Map(); this.writers.set(key, who);
      }
      who.set(s.key, res.id);
      for (const [other, otherId] of who) {
        if (other === s.key || !this.nodes.has(otherId)) continue;
        const id = [res.id, otherId].sort().join(' ~ ');
        const arc = this.arcs.get(id);
        if (arc) { if (!arc.paths.includes(e.path) && arc.paths.length < 8) arc.paths.push(e.path); continue; }
        if (this.arcs.size >= ARC_CAP) { this.leftOut.arcs++; continue; }
        this.arcs.set(id, { id, a: res.id, b: otherId, paths: [e.path] });
      }
    }

    /* ---------- the one way in ---------- */

    /** Apply one event. Throws on anything outside the vocabulary. */
    apply(e) {
      validate(e);
      this.counts.events++; this.rev++; this.now = e.t;
      const s = this.ensureSession(e);
      if (!s) { if (e.ev !== 'session.end') this.leftOut.events++; return; }
      const agent = this.agentOf(s);
      this.touch(agent);
      if (s.ended && e.ev !== 'session.end') s.ended = false;      // a resumed session speaks again
      switch (e.ev) {
        case 'session.start':
          s.ended = false; agent.model = e.model || agent.model; agent.source = e.source || '';
          this.setStatus(agent, s.turnOpen ? 'working' : 'idle', e); break;
        case 'session.end':
          for (const id of [...s.calls.keys()]) this.closeCall(s, id, null);
          for (const id of s.nodes) { const n = this.nodes.get(id); if (n && n.cls === 'subagent' && n.status === 'working') this.setStatus(n, 'done', e); }
          s.turnOpen = false; s.ended = true; s.endedAt = e.t; agent.wait = null; agent.reason = e.reason || '';
          this.setStatus(agent, 'done', e); break;
        case 'turn.start':
          s.turnOpen = true; agent.turn = e.turn || ''; agent.wait = null; this.setStatus(agent, 'working', e); break;
        case 'turn.end':
          s.turnOpen = false; agent.outcome = e.outcome;
          if (e.outcome === 'failed') this.setStatus(agent, 'failed', e);
          else if (e.outcome === 'interrupted') this.setStatus(agent, 'unclear', e);
          else if (e.asks) { agent.wait = { why: 'question', tool: '', since: e.t, grade: 'derived' }; this.setStatus(agent, 'needs', e); }
          else this.setStatus(agent, 'idle', e);
          break;
        case 'wait.start':
          if (e.why === 'idle') { if (agent.status === 'working') this.setStatus(agent, 'idle', e); if (!agent.wait) agent.wait = { why: 'idle', tool: '', since: e.t, grade: e.grade }; }
          else { agent.wait = { why: e.why, tool: e.tool || '', since: e.t, grade: e.grade }; this.setStatus(agent, 'needs', e); }
          break;
        case 'wait.end':
          agent.wait = null; agent.answer = e.answer || '';
          if (s.turnOpen) this.setStatus(agent, 'working', e); else if (agent.status === 'needs') this.setStatus(agent, 'idle', e);
          break;
        case 'tool.start': this.openCall(s, e, 'tool', this.tool(s, e.tool, e)); break;
        case 'tool.end': this.endCall(s, e, s.calls.has(e.call) ? this.nodes.get(s.calls.get(e.call).target) : this.tool(s, e.tool || 'unknown tool', e)); break;
        case 'mcp.start': { const server = this.server(e.server, e); server.usedBy.add(s.key); this.openCall(s, e, 'mcp', server, this.port(server, e.tool)); break; }
        case 'mcp.end': { const server = this.server(e.server, e); server.usedBy.add(s.key); if (!s.calls.has(e.call)) { const p = this.port(server, e.tool); if (p) { p.calls++; if (!e.ok) p.failed++; } } this.endCall(s, e, server); break; }
        case 'resource.touch': {
          const res = this.resource(s, e), call = e.call && s.calls.get(e.call);
          if (e.kind === 'file' && e.op === 'write') this.clash(s, res, e);
          if (!call) break;
          const id = e.call + ' > ' + res.id;
          if (this.links.has(id)) break;
          this.links.set(id, { id, kind: 'touch', from: call.target, to: res.id, call: e.call, session: s.key, op: e.op, what: res.label, t: e.t });
          call.links.push(id); call.touched.push(res.id);
          res.open++; this.setStatus(res, 'working', e); this.syncFolded(res);
          break;
        }
        case 'subagent.start': {
          const sub = this.subagent(s, e.sub, e);
          sub.type = e.type || sub.type; sub.parentCall = e.parentCall || ''; sub.label = (sub.type || 'subagent') + ' ' + short(e.sub);
          this.touch(sub); this.setStatus(sub, 'working', e); break;
        }
        case 'subagent.stop': {
          const sub = this.subagent(s, e.sub, e);
          sub.type = e.type || sub.type; sub.reported = Number.isFinite(e.calls) ? e.calls : null; sub.ms = Number.isFinite(e.ms) ? e.ms : null;
          this.touch(sub); this.setStatus(sub, 'done', e); break;
        }
      }
    }

    /* ---------- explicit commands ---------- */

    /** "Tidy": the only thing that moves a node that already stands. It drops ended sessions,
        closes the gaps between columns and inside cells, and unfolds stacks into the room made. */
    tidy() {
      for (const s of [...this.sessions.values()]) if (s.ended) this.removeSession(s);
      for (const n of [...this.nodes.values()]) {
        if (n.cls === 'stack') this.nodes.delete(n.id);
        else if (n.cls === 'mcp' && !n.usedBy.size && !n.open) this.removeNode(n);
      }
      const cells = new Map(), order = [...this.sessions.values()].sort((a, b) => a.col - b.col);
      const dock = this.cells.get(L.DOCK + '|mcp');
      if (dock) cells.set(L.DOCK + '|mcp', dock);
      this.columns = [];
      order.forEach((s, col) => {
        for (const floor of L.floorsOf(col)) {
          const cell = this.cells.get(s.col + '|' + floor);
          if (cell) { cell.col = col; cells.set(col + '|' + floor, cell); }
        }
        for (const id of s.nodes) this.nodes.get(id).col = col;
        s.col = col; this.columns[col] = s.key;
      });
      this.cells = cells;
      for (const cell of cells.values()) {
        const cls = cell.floor === 'agent' ? 'subagent' : cell.floor;
        const slots = L.slotsFor(cls), standing = slots.map(slot => cell.slots[slot]).filter(id => id != null);
        cell.folded.sort((a, b) => this.nodes.get(b).last - this.nodes.get(a).last);
        while (standing.length < slots.length && cell.folded.length) standing.push(cell.folded.shift());
        for (const slot of slots) cell.slots[slot] = null;
        cell.slots[L.STACK_SLOT] = null;
        standing.forEach((id, i) => { const n = this.nodes.get(id); n.slot = slots[i]; n.folded = false; cell.slots[slots[i]] = id; });
        this.syncStack(cell);
      }
      this.structure = true; this.rev++;
      for (const id of this.nodes.keys()) this.changed.add(id);
    }

    /* ---------- reading ---------- */

    columnsInUse() { const out = []; this.columns.forEach((key, col) => { if (key != null) out.push(col); }); return out; }
    standing() { const out = []; for (const n of this.nodes.values()) if (!n.folded) out.push(n); return out; }
    positions(spread) { const out = new Map(); for (const n of this.nodes.values()) if (!n.folded) out.set(n.id, L.position(n, spread)); return out; }
    classCounts() {
      const out = { agent: 0, subagent: 0, tool: 0, resource: 0, mcp: 0 };
      for (const n of this.nodes.values()) if (n.cls in out) out[n.cls]++;
      return out;
    }
    foldedIn(stack) { return this.cell(stack.col, stack.floor).folded.map(id => this.nodes.get(id)); }
    takeChanges() { const out = { ids: this.changed, structure: this.structure }; this.changed = new Set(); this.structure = false; return out; }
    takeClosed() { const out = this.closed; this.closed = []; return out; }
  }

  const api = {
    Model, create: () => new Model(), validate, groupOf,
    VERSION, EVENTS, AGENT_KINDS, CLASSES, CLASS_NAME, RESOURCE_KINDS, TOUCH_KINDS, OPS, WHYS, OUTCOMES, STATES,
    HISTORY, MEMBER_CAP, PORT_CAP, STACK_CAP, ARC_CAP, STALE_MS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MonitorModel = api;
})(typeof window === 'undefined' ? globalThis : window);
