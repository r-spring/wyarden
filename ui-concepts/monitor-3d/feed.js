/* Monitor 3D mock-up: the feed simulator.
 *
 * A seeded generator that emits the event vocabulary of docs/monitor-3d/02-live-signals.md
 * section 11 as a stream. It connects to nothing: every session, file, URL and MCP server below is
 * invented. The view never calls this file's internals; it takes events through one function,
 *
 *     source.subscribe(onEvent)   // returns a function that stops the subscription
 *
 * so a real source with the same function can replace this one later without touching the view.
 * What each agent can and cannot report (no failure event from Codex, no session end from
 * Antigravity, an unknown caller while a Codex subagent runs) follows section 10 of that document.
 */
(function (root) {
  'use strict';

  const EPOCH = 1795689600000;      // the first timestamp of the stream; the same as the document's examples
  const KINDS = ['claude', 'codex', 'grok', 'antigravity'];
  const MIN_WAIT = 40;              // the driver never wakes more often than this, in ms

  /* Tool names by agent, as the signals document lists them. A missing key means the agent has no
     hook for that kind of call (Codex reads and searches through the shell, for example). */
  const TOOLS = {
    claude: { read: ['Read'], edit: ['Edit', 'Write'], search: ['Grep', 'Glob'], execute: ['Bash'], fetch: ['WebFetch'], websearch: ['WebSearch'], agent: ['Agent'], ask: ['AskUserQuestion'], mcpres: ['ReadMcpResourceTool'] },
    codex: { edit: ['apply_patch'], execute: ['Bash'], agent: ['spawn_agent'], ask: ['request_user_input'] },
    grok: { read: ['read_file'], edit: ['search_replace'], search: ['grep', 'list_dir'], execute: ['run_terminal_command'], fetch: ['web_fetch'], websearch: ['web_search'], agent: ['spawn_subagent'] },
    antigravity: { read: ['view_file'], edit: ['write_to_file', 'replace_file_content', 'multi_replace_file_content'], search: ['grep_search', 'find_by_name', 'list_dir'], execute: ['run_command'], fetch: ['read_url_content'], websearch: ['search_web'], agent: ['invoke_subagent'], ask: ['ask_question'] }
  };
  /* Grade and source of each signal, by agent. */
  const SIGNALS = {
    claude: {
      start: ['exact', 'hook:PreToolUse'], end: ['exact', 'hook:PostToolUse'], fail: ['exact', 'hook:PostToolUseFailure'], ms: 'exact', mcp: 'exact',
      turnStart: ['exact', 'hook:UserPromptSubmit'], turnEnd: ['exact', 'hook:Stop'], turnFail: ['exact', 'hook:StopFailure'],
      permission: ['exact', 'hook:PermissionRequest'], question: ['derived', 'hook:PreToolUse'], idle: ['exact', 'hook:Notification'],
      sessionStart: ['exact', 'hook:SessionStart'], sessionEnd: ['exact', 'hook:SessionEnd'], subStart: ['exact', 'hook:SubagentStart'], subStop: ['exact', 'hook:SubagentStop'], by: 'id', turn: 'p-'
    },
    codex: {
      start: ['exact', 'hook:PreToolUse'], end: ['exact', 'hook:PostToolUse'], fail: ['derived', 'hook:PostToolUse'], ms: 'derived', mcp: 'derived',
      turnStart: ['exact', 'hook:UserPromptSubmit'], turnEnd: ['exact', 'hook:Stop'], turnFail: null, turnInterrupt: ['exact', 'hook:Interrupt'],
      permission: ['exact', 'hook:PermissionRequest'], question: ['derived', 'hook:PreToolUse'], idle: ['derived', 'hook:Stop'],
      sessionStart: ['exact', 'hook:SessionStart'], sessionEnd: ['exact', 'hook:SessionEnd'], subStart: ['exact', 'hook:SubagentStart'], subStop: ['exact', 'hook:SubagentStop'], by: '?', turn: 't-'
    },
    grok: {
      start: ['exact', 'hook:PreToolUse'], end: ['exact', 'hook:PostToolUse'], fail: ['exact', 'hook:PostToolUseFailure'], ms: 'derived', mcp: 'derived',
      turnStart: ['exact', 'hook:UserPromptSubmit'], turnEnd: ['exact', 'hook:Stop'], turnFail: ['exact', 'hook:StopFailure'], turnInterrupt: ['exact', 'hook:StopCancelled'],
      permission: ['derived', 'hook:Notification'], idle: ['derived', 'hook:Stop'],
      sessionStart: ['exact', 'hook:SessionStart'], sessionEnd: ['exact', 'hook:SessionEnd'], subStart: ['exact', 'hook:SubagentStart'], subStop: ['exact', 'hook:SubagentStop'], by: 'id', turn: 'g-'
    },
    antigravity: {
      start: ['exact', 'hook:PreToolUse'], end: ['exact', 'hook:PostToolUse'], fail: ['exact', 'hook:PostToolUse'], ms: 'derived', mcp: 'derived',
      turnStart: ['derived', 'hook:PreInvocation'], turnEnd: ['derived', 'hook:PostInvocation'], turnFail: ['derived', 'hook:Stop'],
      permission: ['derived', 'hook:PreToolUse'], question: ['derived', 'hook:PreToolUse'], idle: ['derived', 'hook:Stop'],
      sessionStart: ['exact', 'hook:SessionStart'], sessionEnd: null, subStart: ['derived', 'hook:PreToolUse'], subStop: ['derived', 'hook:PostToolUse'], by: '?', turn: 'i-'
    }
  };
  const WEIGHTS = { read: 28, edit: 16, search: 14, execute: 16, fetch: 5, websearch: 3, mcp: 10, agent: 4, ask: 2, mcpres: 2 };
  const DURATION = { read: [30, 220], edit: [50, 320], search: [80, 700], execute: [400, 9000], fetch: [500, 4200], websearch: [600, 3500], mcpres: [100, 900], mcp: [200, 3200] };

  /* The invented workspace. */
  const FOLDERS = [
    ['src/app/', ['router.ts', 'store.ts', 'session.ts', 'events.ts', 'index.ts']],
    ['src/ui/', ['panel.tsx', 'toolbar.tsx', 'theme.css', 'list.tsx']],
    ['src/lib/', ['paths.ts', 'clock.ts', 'queue.ts']],
    ['src/server/', ['main.ts', 'auth.ts', 'config.ts']],
    ['src/server/routes/', ['items.ts', 'health.ts']],
    ['test/', ['router.test.ts', 'store.test.ts', 'queue.test.ts', 'fixtures.json']],
    ['test/e2e/', ['smoke.spec.ts', 'login.spec.ts']],
    ['docs/', ['guide.md', 'api.md', 'changelog.md']],
    ['scripts/', ['build.mjs', 'release.mjs']],
    ['./', ['package.json', 'tsconfig.json', 'README.md']],
    ['assets/', ['logo.svg', 'icons.json']],
    ['config/', ['default.yaml', 'ci.yaml']]
  ];
  const URLS = [
    ['https://docs.example.org', ['/guide/hooks', '/guide/install', '/reference/events', '/reference/config']],
    ['https://example.com', ['/blog/release-notes', '/pricing', '/status']],
    ['https://api.example.net', ['/v1/reference', '/v1/errors']],
    ['https://registry.example.net', ['/packages/left-pad', '/packages/tiny-queue']]
  ];
  const SERVERS = [
    ['github', 'user', ['list_issues', 'search_code', 'get_pull_request', 'create_comment']],
    ['browser', 'plugin', ['navigate', 'click', 'snapshot']],
    ['tracker', 'project', ['list_tasks', 'get_task', 'add_note']],
    ['notes', 'user', ['search', 'read_page']]
  ];
  const SUB_TYPES = ['Explore', 'Plan', 'general-purpose'];

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** The stream itself: a queue of things due to happen, advanced to a simulated time on demand. */
  function createSim(options) {
    const opts = Object.assign({ seed: 7, agents: 4, load: 'busy' }, options);
    const busy = opts.load !== 'quiet', rng = mulberry32(opts.seed);
    const rand = (a, b) => a + rng() * (b - a), int = (a, b) => Math.floor(rand(a, b + 1)), chance = p => rng() < p;
    const pick = list => list[Math.floor(rng() * list.length)];
    const hex = n => { let s = ''; while (s.length < n) s += Math.floor(rng() * 16).toString(16); return s; };
    const queue = [];
    let now = 0, seq = 0, out = [];

    const at = (delay, fn) => {
      const item = { time: now + Math.max(1, delay), seq: seq++, fn };
      let lo = 0, hi = queue.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (queue[mid].time < item.time || (queue[mid].time === item.time && queue[mid].seq < item.seq)) lo = mid + 1; else hi = mid; }
      queue.splice(lo, 0, item);
    };
    const emit = (S, ev, signal, extra, by) => {
      const e = { v: 1, t: EPOCH + Math.round(now), agent: S.kind, session: S.sid };
      if (S.kind === 'grok') e.at = e.t - 2;
      if (S.turn && ev !== 'session.start' && ev !== 'session.end') e.turn = S.turn;
      if (by) e.by = by;
      e.ws = S.ws; e.ev = ev; e.grade = signal[0]; e.src = signal[1];
      out.push(Object.assign(e, extra));
    };

    const filePath = (S, stay) => { const folder = chance(stay || .72) ? FOLDERS[pick(S.home)] : pick(FOLDERS); return folder[0].replace(/^\.\//, '') + pick(folder[1]); };
    const folderPath = S => { const f = (chance(.6) ? FOLDERS[pick(S.home)] : pick(FOLDERS))[0]; return f === './' ? '.' : f.slice(0, -1); };
    const touchesFor = (S, action) => {
      if (action === 'read') return [{ kind: 'file', op: 'read', path: filePath(S) }];
      if (action === 'edit') return [{ kind: 'file', op: 'write', path: filePath(S, .93) }];
      if (action === 'search') return [{ kind: 'dir', op: 'search', path: folderPath(S) }];
      if (action === 'fetch') { const site = pick(URLS); return [{ kind: 'url', op: 'read', url: site[0] + pick(site[1]) }]; }
      if (action === 'websearch') return [{ kind: 'search', op: 'search' }];
      if (action === 'mcpres') return [{ kind: 'mcp-resource', op: 'read', server: SERVERS[pick(S.servers)][0], scheme: pick(['file', 'notes', 'repo']) }];
      return [];                    // a shell call names no resource: what it reads and writes cannot be known
    };

    /** One tool call from start to end, with its resource touches and, sometimes, a wait for the owner. */
    function toolCall(S, by, action, done) {
      const sig = SIGNALS[S.kind], tool = pick(TOOLS[S.kind][action]), call = S.callPrefix + (++S.callNo), hash = hex(8);
      const cls = { read: 'read', edit: 'edit', search: 'search', execute: 'execute', fetch: 'fetch', websearch: 'fetch', ask: 'ask', mcpres: 'mcp' }[action];
      const started = now;
      emit(S, 'tool.start', sig.start, { call, tool, class: cls, hash }, by);
      for (const touch of touchesFor(S, action)) emit(S, 'resource.touch', ['derived', 'args:' + tool], Object.assign({ call }, touch), by);
      const end = (ok, error) => {
        const extra = { call, tool, ok, ms: Math.round(now - started), msGrade: sig.ms };
        if (!ok) { extra.error = error; extra.interrupted = false; }
        if (action === 'execute' && error !== 'denied') extra.exit = ok ? 0 : 1;
        emit(S, 'tool.end', ok ? sig.end : sig.fail, extra, by);
        done();
      };
      const run = () => at(rand.apply(null, DURATION[action] || [40, 400]) * (busy ? 1 : 1.4), () => (S.gone ? null : end(!chance(.03), 'tool_error')));
      if (action === 'ask') {
        emit(S, 'wait.start', sig.question, { why: 'question', tool, hash }, by);
        return at(rand(5000, 24000), () => { if (S.gone) return; emit(S, 'wait.end', ['derived', sig.end[1]], { why: 'question', answer: 'answered' }, by); end(true); });
      }
      if ((action === 'execute' || action === 'edit') && chance(busy ? .05 : .1)) {
        emit(S, 'wait.start', sig.permission, { why: 'permission', tool, hash }, by);
        return at(rand(4000, 20000), () => {
          if (S.gone) return;
          const allowed = chance(.85);
          emit(S, 'wait.end', ['derived', sig.end[1]], { why: 'permission', answer: allowed ? 'allowed' : 'refused' }, by);
          if (allowed) run(); else end(false, 'denied');
        });
      }
      run();
    }
    function mcpCall(S, by, done) {
      const sig = SIGNALS[S.kind], server = SERVERS[pick(S.servers)], tool = pick(server[2]), call = S.callPrefix + (++S.callNo), started = now;
      const src = S.kind === 'antigravity' ? 'args:call_mcp_tool' : sig.start[1];
      emit(S, 'mcp.start', [sig.mcp, src], { call, server: server[0], tool, serverSource: server[1] }, by);
      if (chance(.15)) emit(S, 'resource.touch', ['derived', 'args:' + server[0] + '.' + tool], { call, kind: 'file', op: 'unknown', path: filePath(S) }, by);
      at(rand.apply(null, DURATION.mcp), () => {
        if (S.gone) return;
        const ok = !chance(.04), extra = { call, server: server[0], tool, ok, ms: Math.round(now - started), msGrade: sig.ms };
        if (!ok) extra.error = 'tool_error';
        emit(S, 'mcp.end', [sig.mcp, ok ? sig.end[1] : sig.fail[1]], extra, by);
        done();
      });
    }
    /** A subagent: the call that starts it, its own calls, its stop, then the end of the starting call. */
    function agentCall(S, done) {
      const sig = SIGNALS[S.kind], tool = TOOLS[S.kind].agent[0], call = S.callPrefix + (++S.callNo), sub = 'a-' + hex(3), type = pick(SUB_TYPES), started = now;
      const by = sig.by === 'id' ? sub : '?';          // Codex and Antigravity do not say which subagent made a call
      emit(S, 'tool.start', sig.start, { call, tool, class: 'agent', hash: hex(8) });
      emit(S, 'subagent.start', sig.subStart, { sub, type, parentCall: call });
      let left = int(3, 8), made = 0;
      const step = () => {
        if (S.gone) return;
        if (left-- <= 0) {
          emit(S, 'subagent.stop', sig.subStop, { sub, type, calls: made, ms: Math.round(now - started) });
          emit(S, 'tool.end', sig.end, { call, tool, ok: true, ms: Math.round(now - started), msGrade: sig.ms });
          return done();
        }
        made++;
        at(rand(200, busy ? 1500 : 5000), () => { if (!S.gone) anyCall(S, by, step, true); });
      };
      step();
    }
    function anyCall(S, by, done, inner) {
      const have = TOOLS[S.kind], options = Object.keys(WEIGHTS).filter(a => (a === 'mcp' || have[a]) && !(inner && (a === 'agent' || a === 'ask')));
      let roll = rng() * options.reduce((sum, a) => sum + WEIGHTS[a], 0), action = options[0];
      for (const a of options) { roll -= WEIGHTS[a]; if (roll <= 0) { action = a; break; } }
      if (action === 'mcp') mcpCall(S, by, done);
      else if (action === 'agent') agentCall(S, done);
      else toolCall(S, by, action, done);
    }
    function turn(S) {
      if (S.gone) return;
      const sig = SIGNALS[S.kind];
      S.turn = sig.turn + (++S.turnNo);
      emit(S, 'turn.start', sig.turnStart, { chars: int(40, 1800) });
      let left = busy ? int(5, 16) : int(2, 5);
      const step = () => {
        if (S.gone) return;
        if (left-- <= 0) return endTurn(S);
        at(busy ? rand(250, 2200) : rand(2500, 9000), () => {
          if (S.gone) return;
          if (busy && TOOLS[S.kind].read && chance(.18)) {            // a batch of parallel reads
            let open = int(2, 3);
            for (let i = open; i > 0; i--) toolCall(S, '', chance(.7) ? 'read' : 'search', () => { if (--open === 0) step(); });
          } else anyCall(S, '', step, false);
        });
      };
      step();
    }
    function endTurn(S) {
      const sig = SIGNALS[S.kind], roll = rng();
      let outcome = roll < .05 ? 'failed' : roll < .09 ? 'interrupted' : 'done', signal = sig.turnEnd;
      if (outcome === 'failed') { if (sig.turnFail) signal = sig.turnFail; else outcome = 'done'; }
      if (outcome === 'interrupted') { if (sig.turnInterrupt) signal = sig.turnInterrupt; else if (S.kind === 'claude') signal = ['derived', 'hook:UserPromptSubmit']; else outcome = 'done'; }
      const asks = outcome === 'done' && chance(.12);
      emit(S, 'turn.end', signal, { outcome, asks });
      emit(S, 'wait.start', sig.idle, { why: 'idle' });
      at((busy ? rand(3000, 12000) : rand(20000, 70000)) * (asks ? 2 : 1), () => {
        if (S.gone) return;
        if (sig.sessionEnd && chance(busy ? .05 : .08)) {
          S.turn = '';
          emit(S, 'session.end', sig.sessionEnd, { reason: 'prompt_input_exit' });
          S.gone = true;
          return at(rand(4000, 15000), () => session(S.index));       // another session takes its place later
        }
        emit(S, 'wait.end', ['derived', sig.turnStart[1]], { why: 'idle', answer: 'answered' });
        turn(S);
      });
    }
    function session(index) {
      const kind = KINDS[index % KINDS.length], home = [], servers = [];
      while (home.length < 3) { const i = Math.floor(rng() * FOLDERS.length); if (!home.includes(i)) home.push(i); }
      while (servers.length < 2) { const i = Math.floor(rng() * SERVERS.length); if (!servers.includes(i)) servers.push(i); }
      // Up to four sessions share one workspace, so some of them write the same files.
      const S = { index, kind, sid: 's-' + hex(4), ws: 'w' + (1 + Math.floor(index / 4)), home, servers, turn: '', turnNo: 0, callNo: 0, gone: false };
      S.callPrefix = (kind === 'antigravity' ? 'step-' : 'call_') + hex(3) + '_';
      emit(S, 'session.start', SIGNALS[kind].sessionStart, { source: 'startup', model: 'sim-' + kind + '-model' });
      at(rand(400, busy ? 2500 : 9000), () => turn(S));
    }
    for (let i = 0; i < opts.agents; i++) at(1 + i * rand(250, 900), () => session(i));

    return {
      /** Run everything due up to simulated time `target` (ms) and return the events it emitted. */
      advanceTo(target) {
        while (queue.length && queue[0].time <= target) { const item = queue.shift(); now = item.time; item.fn(); }
        now = Math.max(now, target);
        const events = out; out = [];
        return events;
      },
      nextTime: () => (queue.length ? queue[0].time : Infinity),
      time: () => now
    };
  }

  const PRESETS = { agents: [1, 4, 12], load: ['quiet', 'busy'], speed: [0.5, 1, 2, 4] };

  /** The feed the page uses: the stream above, driven by a timer, with start, pause and speed. */
  function create(options) {
    let opts = Object.assign({ seed: 7, agents: 4, load: 'busy' }, options);
    const clock = opts.clock || {
      now: () => performance.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: id => clearTimeout(id)
    };
    const listeners = new Set();
    let sim = createSim(opts), running = false, speed = opts.speed || 1, timer = null, simAnchor = 0, wallAnchor = 0;
    const simNow = () => (running ? simAnchor + (clock.now() - wallAnchor) * speed : simAnchor);
    const deliver = events => { for (const e of events) for (const fn of [...listeners]) fn(e); };
    function arm() {
      if (timer !== null) { clock.clearTimeout(timer); timer = null; }
      const next = sim.nextTime();
      if (!running || !Number.isFinite(next)) return;
      timer = clock.setTimeout(pump, Math.max(MIN_WAIT, (next - simNow()) / speed));
    }
    function pump() { timer = null; if (!running) return; deliver(sim.advanceTo(simNow())); arm(); }
    const feed = {
      subscribe(onEvent) { listeners.add(onEvent); return () => listeners.delete(onEvent); },
      start() { if (running) return; running = true; wallAnchor = clock.now(); arm(); },
      pause() { if (!running) return; simAnchor = simNow(); running = false; arm(); },
      running: () => running,
      speed: () => speed,
      setSpeed(next) { simAnchor = simNow(); wallAnchor = clock.now(); speed = next; arm(); },
      /** Start a new stream (another number of agents, another load or another seed) from time zero. */
      preset(next) { const was = running; feed.pause(); opts = Object.assign({}, opts, next); sim = createSim(opts); simAnchor = 0; if (was) feed.start(); },
      /** Jump the stream forward by `ms` of simulated time at once. */
      warm(ms) { simAnchor = simNow() + ms; wallAnchor = clock.now(); deliver(sim.advanceTo(simAnchor)); arm(); },
      options: () => ({ seed: opts.seed, agents: opts.agents, load: opts.load }),
      simTime: simNow
    };
    return feed;
  }

  const api = { create, createSim, mulberry32, EPOCH, KINDS, TOOLS, SIGNALS, PRESETS, FOLDERS, URLS, SERVERS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MonitorFeed = api;
})(typeof window === 'undefined' ? globalThis : window);
