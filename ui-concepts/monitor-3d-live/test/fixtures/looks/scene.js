// The one scene every look is photographed on (tools/shoot-looks.js) and compared on (test/looks.test.js).
// Written by hand, event by event, so it never changes unless this file does. Everything in it is invented.
//
// It shows each class and each state once at least:
//   four sessions, one for each provider: Claude working, Codex waiting for its owner ("needs you"),
//   Grok interrupted ("unclear"), Antigravity idle;
//   two subagents (one working, one done); eleven tools in the first session, so some fold into a stack;
//   two MCP servers with ports, one port in use; files, a searched folder, an address, a web search and
//   an MCP resource; three open calls (a write, a search, an MCP call); a failed call; and one file that
//   two sessions wrote (a clash).
'use strict';
const M = require('../../../media/model.js');

const SCOPE = '5d1e0c7a9b21';                    // a made-up workspace key: 12 hex characters
const T0 = Date.UTC(2026, 10, 27, 10, 41, 0);
const SELECTED = 'a:codex:looks-codex-02';       // the agent that needs its owner: selected in a look's picture

function events() {
  const out = [];
  let t = T0, seq = 0, call = 0;
  const say = (agent, session, e) => { t += 250; out.push(Object.assign({ v: 1, agent, session, ws: 'w1', grade: 'exact', src: 'hook:PreToolUse', t, seq: ++seq }, e)); };
  const who = (agent, session) => {
    const s = e => say(agent, session, e);
    /** One call of a tool: started, its touches, and ended unless `open`. Returns the call's id. */
    s.tool = (tool, { touch = [], ok = true, open = false, by, ms = 180 } = {}) => {
      const id = 'call_looks_' + String(++call).padStart(3, '0');
      s(Object.assign({ ev: 'tool.start', call: id, tool }, by ? { by } : {}));
      for (const r of touch) s(Object.assign({ ev: 'resource.touch', call: id }, r));
      if (!open) s(Object.assign({ ev: 'tool.end', src: 'hook:PostToolUse', call: id, tool, ok, ms, msGrade: 'exact' }, ok ? {} : { error: 'exit 1' }));
      return id;
    };
    s.mcp = (server, tool, { ok = true, open = false } = {}) => {
      const id = 'call_looks_' + String(++call).padStart(3, '0');
      s({ ev: 'mcp.start', call: id, server, tool });
      if (!open) s({ ev: 'mcp.end', src: 'hook:PostToolUse', call: id, server, tool, ok, ms: 240, msGrade: 'exact' });
      return id;
    };
    return s;
  };
  const file = (path, op) => ({ kind: 'file', op, path });

  // Codex first writes the file that Claude will write too: the clash.
  const codex = who('codex', 'looks-codex-02');
  codex({ ev: 'session.start', grade: 'derived', src: 'sessions-file', root: { name: 'b16b00' }, space: 'Notes App', title: 'Add dark mode to the notes list', model: 'sim-codex-model' });
  codex({ ev: 'turn.start', turn: 'p1' });
  codex.tool('read_file', { touch: [file('src/notes/list.js', 'read'), file('src/notes/theme.css', 'read')] });
  codex.tool('apply_patch', { touch: [file('src/shared/total.js', 'write'), file('src/notes/theme.css', 'write')] });
  codex.mcp('notes', 'search');
  codex.mcp('notes', 'read_note');
  codex.tool('shell');

  const claude = who('claude', 'looks-claude-01');
  claude({ ev: 'session.start', grade: 'derived', src: 'sessions-file', root: { name: 'c0ffee' }, space: 'Demo Shop', title: 'Fix the checkout total', model: 'sim-claude-model' });
  claude({ ev: 'turn.start', turn: 'p1' });
  claude.tool('Read', { touch: [file('src/cart/total.js', 'read'), file('src/cart/tax.js', 'read'), file('src/cart/coupon.js', 'read')] });
  claude.tool('Glob', { touch: [{ kind: 'dir', op: 'search', path: 'test/' }] });
  claude.tool('TodoWrite');
  claude.tool('WebFetch', { touch: [{ kind: 'url', op: 'read', url: 'https://docs.example.com/api/orders' }, { kind: 'url', op: 'read', url: 'https://docs.example.com/api/tax' }] });
  claude.tool('WebSearch', { touch: [{ kind: 'search', op: 'search' }] });
  claude.tool('Write', { touch: [file('test/cart/total.test.js', 'write')] });
  claude.tool('NotebookEdit');
  claude.tool('ToolSearch');
  claude.tool('Bash', { ok: false, ms: 2140 });                                       // the failed call
  claude.mcp('browser', 'click');
  claude.mcp('browser', 'screenshot');
  claude.mcp('browser', 'fill_form', { ok: false });
  claude({ ev: 'resource.touch', kind: 'mcp-resource', op: 'read', server: 'notes', scheme: 'note' });
  claude({ ev: 'subagent.start', sub: 'sub-review-1', type: 'Review' });
  claude({ ev: 'subagent.stop', src: 'hook:SubagentStop', sub: 'sub-review-1', type: 'Review', calls: 4, ms: 5200 });
  claude({ ev: 'subagent.start', sub: 'sub-explore-2', type: 'Explore' });

  const grok = who('grok', 'looks-grok-03');
  grok({ ev: 'session.start', grade: 'derived', src: 'sessions-file', root: { name: 'a1c3e5' }, space: 'Site Docs', title: 'Rewrite the install guide', model: 'sim-grok-model' });
  grok({ ev: 'turn.start', turn: 'p1' });
  grok.tool('read_file', { touch: [file('docs/install.md', 'read'), file('docs/index.md', 'read')] });
  grok.tool('search_replace', { touch: [file('docs/install.md', 'write')] });
  grok.tool('list_dir', { touch: [{ kind: 'dir', op: 'search', path: 'docs/img/' }] });
  grok({ ev: 'turn.end', src: 'hook:Stop', outcome: 'interrupted' });               // unclear

  const anti = who('antigravity', 'looks-antigravity-04');
  anti({ ev: 'session.start', grade: 'derived', src: 'sessions-file', root: { name: 'd00d42' }, space: 'Tiny Queue', title: 'Retry failed jobs once', model: 'sim-antigravity-model' });
  anti({ ev: 'turn.start', turn: 'p1', grade: 'derived', src: 'transcript:PreToolUse' });
  anti.tool('view_file', { touch: [file('queue/retry.py', 'read'), file('queue/worker.py', 'read')] });
  anti.tool('run_command');
  anti({ ev: 'turn.end', grade: 'derived', src: 'transcript:Stop', outcome: 'done' });   // idle

  // Last, what is still going on when the picture is taken.
  codex({ ev: 'wait.start', src: 'hook:PermissionRequest', why: 'permission', tool: 'shell' });                  // needs you
  claude.tool('Edit', { open: true, touch: [file('src/shared/total.js', 'write')] });                            // an open write, and the clash
  claude.tool('Grep', { open: true, by: 'sub-explore-2', touch: [{ kind: 'dir', op: 'search', path: 'src/cart/' }] });   // an open search, by the subagent
  claude.mcp('browser', 'navigate', { open: true });                                                              // an open MCP call, to its port
  return out;
}

function model() {
  const m = M.create();
  for (const e of events()) m.apply(e);
  return m;
}
/** The first message a page gets from the hub for this scene: one snapshot. */
function message() {
  const m = model();
  return { v: 1, type: 'records', scope: SCOPE, records: [{ ctl: 'snapshot', epoch: 'a1b2c3d4', seq: events().length, scope: SCOPE, state: m.serialize() }] };
}
/** The other messages a tab gets: the hub is up, and one workspace chip for each invented window. */
function around() {
  const list = [
    { key: SCOPE, name: 'looks-demo', apps: ['VS Code'], windows: 1, sessions: 4, needs: 1 },
    { key: '8f3a62c4d0e7', name: 'notes-app', apps: ['VS Code'], windows: 1, sessions: 0, needs: 0 }
  ];
  return [
    { v: 1, type: 'hub', state: 'up', role: 'hub', collectors: { claude: { state: 'installed', folders: 1, installed: 1 } } },
    { v: 1, type: 'workspaces', list, hidden: 0, scope: SCOPE, here: [SCOPE] }
  ];
}

module.exports = { SCOPE, T0, SELECTED, events, model, message, around };
