// The privacy rule of docs/monitor-3d/02-live-signals.md section 13, tested from the outside: every
// field that must never be kept carries its own marker, and no marker may come out of the
// normaliser in any event. What should be kept (a relative path, a URL's scheme, host and path, the
// tool and server names) must still come out. Both path forms are tested; the folder lookup is a
// stub, so no real folder is read. All values are invented.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const contract = require('../lib/contract.js');
const { createNormaliser } = require('../lib/normalise.js');
const M = require('../media/model.js');

const SID = 'priv-0000-4000-8000-000000000001';
const PID = 'priv-turn-0001';
const SUB = 'a00000000000000aa';

/* Every marker names the one field it sits in, so a failure says which field leaked. */
const MARKS = {
  cmd: 'MARK_CMD_7f3a', cmdDesc: 'MARK_CMDDESC_19c2', content: 'MARK_CONTENT_2b81', oldStr: 'MARK_OLD_5d0e', newStr: 'MARK_NEW_c4a9',
  result: 'MARK_RESULT_8e17', mcpResult: 'MARK_MCPRESULT_31f0', prompt: 'MARK_PROMPT_6a2d', reply: 'MARK_REPLY_0b7c', subReply: 'MARK_SUBREPLY_e3f5',
  pattern: 'MARK_PATTERN_9d44', webQuery: 'MARK_WEBQUERY_47b1', toolSearch: 'MARK_TOOLSEARCH_a91e',
  urlQuery: 'MARK_URLQUERY_5c3b', urlFragment: 'MARK_URLFRAG_d2e8', urlUser: 'MARK_URLUSER_7a60', urlPass: 'MARK_URLPASS_1f9d',
  home: 'MARK_HOME_b5c7', parent: 'MARK_PARENT_04da', otherDir: 'MARK_OTHERDIR_6e2f',
  transcript: 'MARK_TRANSCRIPT_c08b', agentTranscript: 'MARK_AGENTTRANSCRIPT_93a4', scratch: 'MARK_SCRATCH_2d6f',
  notice: 'MARK_NOTICE_f71c', noticeTitle: 'MARK_NOTICETITLE_58e0', error: 'MARK_ERROR_aa31', errorDetails: 'MARK_ERRORDETAILS_3c97',
  mcpArg: 'MARK_MCPARG_e5d2', mcpUriPath: 'MARK_MCPURIPATH_7b4e', resUriHost: 'MARK_RESURIHOST_1d8a', resUriPath: 'MARK_RESURIPATH_c62f',
  fetchPrompt: 'MARK_FETCHPROMPT_09bb', agentPrompt: 'MARK_AGENTPROMPT_4e13', agentDesc: 'MARK_AGENTDESC_b7a2', question: 'MARK_QUESTION_6c58',
  suggestion: 'MARK_SUGGESTION_d40f', deniedReason: 'MARK_DENIEDREASON_8f26', sessionTitle: 'MARK_SESSIONTITLE_25ec', background: 'MARK_BACKGROUND_e1a7',
  todo: 'MARK_TODO_3b5d', unknownField: 'MARK_UNKNOWNFIELD_90c4', mcpUrlQuery: 'MARK_MCPURLQUERY_47fe'
};

function stubRoot(root, ws) {
  return cwd => (contract.isInside(root, cwd)
    ? { root, real: root, ws, name: contract.flavour(root).basename(root) }
    : { root: cwd, real: cwd, ws, name: contract.flavour(cwd).basename(cwd) });
}

/** Every hook event of the table, in a session's order, with a marker in every field that must not be kept. */
function payloads(win) {
  const m = MARKS;
  const sep = win ? '\\' : '/';
  const home = win ? 'C:\\Users\\' + m.home : '/home/' + m.home;
  const root = home + sep + m.parent + sep + 'proj';
  const at = (...p) => root + sep + p.join(sep);
  const id = n => 'toolu_priv' + String(n).padStart(20, '0');
  const url = 'https://' + m.urlUser + ':' + m.urlPass + '@docs.example.com/guide/start?key=' + m.urlQuery + '#' + m.urlFragment;
  const common = (event, extra) => Object.assign({
    session_id: SID, transcript_path: home + sep + '.claude' + sep + m.transcript + '.jsonl', cwd: root,
    scratchpad_dir: home + sep + m.scratch, prompt_id: PID, hook_event_name: event, permission_mode: 'default',
    effort: { level: 'high' }, [m.unknownField]: m.unknownField
  }, extra);
  const tool = (event, name, n, input, extra) => common(event, Object.assign({ tool_name: name, tool_input: input, tool_use_id: id(n) }, extra));
  const out = (event, name, n, input, extra) => tool(event, name, n, input, Object.assign({ tool_response: { stdout: m.result, file: { content: m.result } }, duration_ms: 3 }, extra));
  const sub = { agent_id: SUB, agent_type: 'general-purpose' };
  const mcpServer = { mcp_server: { name: 'example_srv', source: 'dynamic' } };
  const pairs = [
    ['Read', 1, { file_path: at('src', 'a.js') }],
    ['Write', 2, { file_path: at('src', 'b.js'), content: m.content }],
    ['Edit', 3, { file_path: home + sep + m.otherDir + sep + 'secret.txt', old_string: m.oldStr, new_string: m.newStr }],
    ['MultiEdit', 4, { file_path: at('src', 'c.js'), edits: [{ old_string: m.oldStr, new_string: m.newStr }] }],
    ['NotebookEdit', 5, { notebook_path: at('nb', 'n.ipynb'), new_source: m.content }],
    ['Grep', 6, { pattern: m.pattern, path: at('src'), glob: m.pattern }],
    ['Glob', 7, { pattern: m.pattern }],
    ['Bash', 8, { command: m.cmd, description: m.cmdDesc }],
    ['PowerShell', 9, { command: m.cmd }],
    ['WebFetch', 10, { url, prompt: m.fetchPrompt }],
    ['WebSearch', 11, { query: m.webQuery }],
    ['ToolSearch', 12, { query: m.toolSearch, max_results: 5 }],
    ['TodoWrite', 13, { todos: [{ content: m.todo }] }],
    ['ReadMcpResourceTool', 14, { server: 'docs', uri: 'notes://' + m.resUriHost + '/' + m.resUriPath }],
    ['mcp__example_srv__echo', 15, { text: m.mcpArg, path: at('src', 'd.js'), uri: 'db://' + m.mcpArg + '/' + m.mcpUriPath, url: 'https://api.example.com/v1/items?q=' + m.mcpUrlQuery, nested: { file_path: m.mcpArg } }, mcpServer]
  ];
  const list = [
    common('SessionStart', { source: 'startup', model: 'claude-example-1', session_title: m.sessionTitle }),
    common('UserPromptSubmit', { prompt: m.prompt, session_title: m.sessionTitle })
  ];
  for (const [name, n, input, extra] of pairs) {
    list.push(tool('PreToolUse', name, n, input, extra));
    if (name === 'Bash') {
      list.push(common('PermissionRequest', { tool_name: name, tool_input: input, permission_suggestions: [{ rule: m.suggestion }] }));
      list.push(common('Notification', { message: m.notice, title: m.noticeTitle, notification_type: 'permission_prompt' }));
    }
    if (name === 'Write' || name === 'PowerShell') list.push(tool('PostToolUseFailure', name, n, input, Object.assign({ error: m.error, is_interrupt: false, duration_ms: 4 }, extra)));
    else if (name === 'WebFetch') list.push(tool('PermissionDenied', name, n, input, { reason: m.deniedReason }));
    else if (name.startsWith('mcp__')) list.push(out('PostToolUse', name, n, input, Object.assign({ tool_response: [{ type: 'text', text: m.mcpResult }] }, extra)));
    else list.push(out('PostToolUse', name, n, input, extra));
  }
  list.push(
    tool('PreToolUse', 'Agent', 20, { description: m.agentDesc, prompt: m.agentPrompt, subagent_type: 'general-purpose' }),
    common('SubagentStart', sub),
    tool('PreToolUse', 'Read', 21, { file_path: at('src', 'a.js') }, sub),
    out('PostToolUse', 'Read', 21, { file_path: at('src', 'a.js') }, sub),
    common('SubagentStop', Object.assign({ agent_transcript_path: home + sep + m.agentTranscript + '.jsonl', last_assistant_message: m.subReply, stop_hook_active: false }, sub)),
    out('PostToolUse', 'Agent', 20, { description: m.agentDesc, prompt: m.agentPrompt }, { tool_response: { agentId: SUB, content: [{ type: 'text', text: m.result }] } }),
    tool('PreToolUse', 'AskUserQuestion', 22, { questions: [{ question: m.question, options: [{ label: m.question }] }] }),
    out('PostToolUse', 'AskUserQuestion', 22, { questions: [{ question: m.question }] }, { tool_response: { answers: { [m.question]: m.question } } }),
    common('Notification', { message: m.notice, title: m.noticeTitle, notification_type: 'idle_prompt' }),
    common('Notification', { message: m.notice, title: m.noticeTitle, notification_type: 'elicitation_dialog' }),
    common('Stop', { last_assistant_message: m.reply + '?', stop_hook_active: false, background_tasks: [{ description: m.background }], session_crons: [] }),
    common('StopFailure', { error: m.error, error_details: m.errorDetails, last_assistant_message: m.reply }),
    common('UserPromptSubmit', { prompt: m.prompt }),
    common('PostToolBatch', { tool_calls: [{ tool_name: 'Bash', tool_input: { command: m.cmd }, tool_response: m.result }] }),
    common('SessionEnd', { reason: 'other' })
  );
  return { list, root, ws: win ? 'wsprivwin001' : 'wsprivposix1' };
}

/** All events from one form: each payload as a hook, and each tool payload again as a transcript would give it. */
function eventsOf(win) {
  const { list, root, ws } = payloads(win);
  const hookN = createNormaliser({ rootInfo: stubRoot(root, ws) });
  const tailN = createNormaliser({ rootInfo: stubRoot(root, ws) });
  const events = [];
  list.forEach((p, i) => {
    const out = hookN.feed(p, { t: 1000 + i });
    assert.ok(out, 'a result for ' + p.hook_event_name);
    events.push(...out.events);
    if (p.tool_use_id) {
      const tail = tailN.feed(Object.assign({}, p, { _wy: { src: 'transcript', at: 500 + i } }), { t: 2000 + i });
      events.push(...tail.events);
    }
  });
  for (const e of events) M.validate(e);
  return events;
}

for (const win of [false, true]) {
  const form = win ? 'Windows' : 'POSIX';

  test(form + ': no field that must not be kept comes out in any event', () => {
    const given = JSON.stringify(payloads(win).list);
    for (const [field, mark] of Object.entries(MARKS)) assert.ok(given.includes(mark), 'the payloads carry the ' + field + ' marker');
    const events = eventsOf(win);
    assert.ok(events.length > 60, 'enough events to mean something: ' + events.length);
    const text = JSON.stringify(events);
    for (const [field, mark] of Object.entries(MARKS)) assert.ok(!text.includes(mark), field + ' leaked: ' + mark);
    assert.ok(!text.includes('MARK_'), 'no marker of any kind');
  });

  test(form + ': no absolute path of either form comes out', () => {
    const text = JSON.stringify(eventsOf(win));
    assert.ok(!text.includes('C:\\\\') && !text.includes('C:\\'), 'no C:\\');
    assert.ok(!text.includes('\\'), 'no backslash at all');
    assert.ok(!/"\/home\//.test(text) && !text.includes('/home/'), 'no /home/');
    assert.ok(!/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(text), 'no drive letter followed by a colon and a slash');
    assert.ok(!text.includes('/Users/') && !text.includes('.claude'), 'no home or config folder');
  });

  test(form + ': what should be kept is kept', () => {
    const events = eventsOf(win);
    const paths = events.filter(e => e.ev === 'resource.touch' && typeof e.path === 'string').map(e => e.path);
    for (const p of ['src/a.js', 'src/b.js', 'src/c.js', 'nb/n.ipynb', 'src', '.', 'src/d.js']) assert.ok(paths.includes(p), 'relative path ' + p);
    const outside = events.find(e => e.path && typeof e.path === 'object');
    assert.deepEqual(outside.path, { outside: true, name: 'secret.txt' }, 'a path outside the root keeps its base name');
    const urls = events.filter(e => e.url).map(e => e.url);
    assert.ok(urls.includes('https://docs.example.com/guide/start'), 'the URL keeps scheme, host and path');
    assert.ok(urls.includes('https://api.example.com/v1/items'), 'an MCP url argument keeps scheme, host and path');
    const tools = new Set(events.filter(e => e.tool).map(e => e.tool));
    for (const t of ['Read', 'Write', 'Edit', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'ToolSearch', 'Agent', 'AskUserQuestion', 'echo']) assert.ok(tools.has(t), 'tool name ' + t);
    const mcp = events.find(e => e.ev === 'mcp.start');
    assert.deepEqual([mcp.server, mcp.tool, mcp.serverSource], ['example_srv', 'echo', 'dynamic'], 'the server name');
    const res = events.filter(e => e.kind === 'mcp-resource');
    assert.ok(res.some(e => e.server === 'docs' && e.scheme === 'notes'), 'a resource read keeps server and scheme');
    assert.ok(res.some(e => e.server === 'example_srv' && e.scheme === 'db'), 'an MCP uri argument keeps its scheme');
    assert.ok(events.some(e => e.ev === 'session.start' && e.root && e.root.name === 'proj'), 'the root folder\'s base name');
    assert.ok(events.some(e => e.ev === 'turn.start' && e.chars === MARKS.prompt.length), 'the prompt\'s length, not its text');
    assert.ok(events.some(e => e.ev === 'turn.end' && e.asks === true), 'only whether the reply asks');
    assert.ok(events.some(e => e.ev === 'tool.end' && e.error === 'tool_error'), 'the error class');
    assert.ok(events.every(e => e.hash === undefined || /^[0-9a-f]{8}$/.test(e.hash)), 'a hash is 8 hex only');
  });
}

/* ---------- ids and names: a short path or command line in a field meant for an id or a name ---------- */

const ROOT = '/home/example/proj';
const plainRoot = stubRoot(ROOT, 'wsplain00001');
const shell = (event, extra) => Object.assign({ session_id: SID, cwd: ROOT, prompt_id: PID, hook_event_name: event }, extra);
const toolCall = (event, name, id, input, extra) => shell(event, Object.assign({ tool_name: name, tool_use_id: id, tool_input: input }, extra));

function assertClean(events, marker, what) {
  const text = JSON.stringify(events);
  assert.ok(!text.includes(marker), what + ' leaked: ' + text);
  assert.ok(!text.includes('\\') && !/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(text), what + ': no Windows path');
  assert.ok(!/"\/|[ "]\/[a-z]/.test(text.replace(/"(path|url)":"[^"]*"/g, '')), what + ': no POSIX absolute path');
  for (const e of events) M.validate(e);
}

/** Each case: the field, a value under 80 characters holding its marker, and the payloads that carry it. */
const CASES = [
  ['tool_name as a Windows path', 'MKA_tool_9e1', v => [toolCall('PreToolUse', v, 'toolu_01a', { file_path: ROOT + '/src/a.js' })], 'C:\\Users\\x\\MKA_tool_9e1\\secret.txt'],
  ['tool_name as a command line', 'MKB_bearer_4c2', v => [toolCall('PreToolUse', v, 'toolu_01b', {}), toolCall('PostToolUse', v, 'toolu_01b', {})], 'curl -H "Authorization: Bearer MKB_bearer_4c2" https://x'],
  ['prompt_id as a path, also remembered for later events', 'MKC_turn_77d', v => [shell('UserPromptSubmit', { prompt_id: v, prompt: 'x' }),
    { hook_event_name: 'PreToolUse', session_id: SID, cwd: ROOT, tool_name: 'Read', tool_use_id: 'toolu_01c', tool_input: {}, _wy: { src: 'transcript', at: 5 } }], '/home/x/MKC_turn_77d/notes.txt'],
  ['tool_use_id as a path', 'MKD_call_1aa', v => [toolCall('PreToolUse', 'Read', v, {}), toolCall('PostToolUse', 'Read', v, {})], 'C:\\MKD_call_1aa\\id'],
  ['mcp_server.name as a path', 'MKE_srv_b03', v => [toolCall('PreToolUse', 'mcp__' + v + '__echo', 'toolu_01e', {}, { mcp_server: { name: v, source: 'dynamic' } })], '/srv/MKE_srv_b03/sock'],
  ['mcp_server.source as a path', 'MKF_src_5f0', v => [toolCall('PreToolUse', 'mcp__probe_srv__echo', 'toolu_01f', {}, { mcp_server: { name: 'probe_srv', source: v } })], 'C:\\MKF_src_5f0\\x'],
  ['the tool part of an MCP name', 'MKG_mcptool_2e9', v => [toolCall('PreToolUse', 'mcp__x__' + v, 'toolu_01g', {})], '/etc/MKG_mcptool_2e9'],
  ['agent_id as a path (by and sub)', 'MKH_agent_c41', v => [shell('SubagentStart', { agent_id: v, agent_type: 'general-purpose' }),
    toolCall('PreToolUse', 'Read', 'toolu_01h', {}, { agent_id: v }), shell('SubagentStop', { agent_id: v })], '/home/x/MKH_agent_c41/a'],
  ['agent_type as a command', 'MKI_type_6d8', v => [shell('SubagentStart', { agent_id: SUB, agent_type: v })], 'rm -rf /MKI_type_6d8'],
  ['source as a path', 'MKJ_source_0b5', v => [shell('SessionStart', { source: v })], '/home/x/MKJ_source_0b5'],
  ['model as a path', 'MKK_model_3a7', v => [shell('SessionStart', { model: v }), shell('SessionStart', { model: { id: v } })], 'C:\\MKK_model_3a7\\model'],
  ['reason as a command', 'MKL_reason_e62', v => [shell('SessionEnd', { reason: v })], 'curl http://MKL_reason_e62/x'],
  ['a PermissionRequest\'s tool_name', 'MKM_perm_91f', v => [shell('PermissionRequest', { tool_name: v, tool_input: {} })], '/usr/bin/MKM_perm_91f'],
  ['ReadMcpResourceTool\'s input.server', 'MKN_ressrv_d27', v => [toolCall('PreToolUse', 'ReadMcpResourceTool', 'toolu_01n', { server: v, uri: 'notes://a/b' })], '/var/MKN_ressrv_d27/srv'],
  ['a resource URI whose scheme is not a scheme', 'MKO_scheme_48c', v => [toolCall('PreToolUse', 'ReadMcpResourceTool', 'toolu_01o', { server: 'docs', uri: v }),
    toolCall('PreToolUse', 'mcp__probe_srv__echo', 'toolu_01p', { uri: v }, { mcp_server: { name: 'probe_srv', source: 'dynamic' } })], 'x/MKO_scheme_48c:rest'],
  ['hook_event_name as a path', 'MKP_event_7b1', v => [shell(v, { tool_name: 'Read' })], '/home/x/MKP_event_7b1']
];

for (const [what, marker, build, value] of CASES) {
  test('an id or name field cannot carry a path or command: ' + what, () => {
    assert.ok(value.length < 80 && value.includes(marker));
    const n = createNormaliser({ rootInfo: plainRoot });
    const events = [];
    for (const p of build(value)) { const out = n.feed(p, { t: 1 }); assert.ok(out, 'still a result'); events.push(...out.events); }
    // An unknown event name gives no events at all; every other case must still give some.
    if (!what.startsWith('hook_event_name')) assert.ok(events.length > 0, 'the payloads still give events');
    assertClean(events, marker, what);
  });
}

test('a session_id that is a path is not a session', () => {
  const n = createNormaliser({ rootInfo: plainRoot });
  for (const id of ['/home/x/.ssh/MKQ_sess', 'C:\\Users\\MKQ_sess', 'a b', 'x'.repeat(129), '']) {
    assert.equal(n.feed(shell('UserPromptSubmit', { session_id: id, prompt: 'x' }), { t: 1 }), null, id.slice(0, 20));
  }
  assert.equal(n.size(), 0);
});

test('a start and its end with the same odd tool_use_id carry the same call', () => {
  const n = createNormaliser({ rootInfo: plainRoot });
  const odd = '/home/x/odd id/MKR_call';
  const start = n.feed(toolCall('PreToolUse', 'Read', odd, { file_path: ROOT + '/a.js' }), { t: 1000 }).events[0];
  const end = n.feed(toolCall('PostToolUse', 'Read', odd, {}), { t: 1250 }).events[0];
  assert.match(start.call, /^id-[0-9a-f]{12}$/);
  assert.equal(end.call, start.call);
  assert.equal(end.ms, 250, 'the end met its start');
  const other = n.feed(toolCall('PreToolUse', 'Read', odd + '2', {}), { t: 1 }).events[0];
  assert.notEqual(other.call, start.call, 'two odd ids stay apart');
});

test('ordinary real-shaped ids and names come through unchanged', () => {
  const n = createNormaliser({ rootInfo: plainRoot });
  const uuid = '2b6da091-e550-4434-976f-f0a9c46617fa', turn = 'a878a781-4e42-485a-81cc-578af20c3141';
  const base = { session_id: uuid, cwd: ROOT, prompt_id: turn };
  const start = n.feed(Object.assign({ hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' }, base), { t: 1 }).events[0];
  assert.deepEqual([start.session, start.source, start.model], [uuid, 'startup', 'claude-opus-5-5']);
  const mcp = n.feed(Object.assign({ hook_event_name: 'PreToolUse', tool_name: 'mcp__probe_srv__echo', tool_use_id: 'toolu_0158Aa9HB8A1jRFEjoVtmffN', tool_input: { text: 'x' }, mcp_server: { name: 'probe_srv', source: 'dynamic' } }, base), { t: 2 }).events[0];
  assert.deepEqual([mcp.call, mcp.server, mcp.tool, mcp.serverSource, mcp.turn], ['toolu_0158Aa9HB8A1jRFEjoVtmffN', 'probe_srv', 'echo', 'dynamic', turn]);
  const sub = n.feed(Object.assign({ hook_event_name: 'SubagentStart', agent_id: 'a0f3c2b1d4e5f6a7b', agent_type: 'general-purpose' }, base), { t: 3 }).events[0];
  assert.deepEqual([sub.sub, sub.type], ['a0f3c2b1d4e5f6a7b', 'general-purpose']);
  const end = n.feed(Object.assign({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }, base), { t: 4 }).events[0];
  assert.equal(end.reason, 'prompt_input_exit');
});

test('the input hash is salted per normaliser, and still pairs a permission with its call', () => {
  const input = { command: 'ls' };
  const a = createNormaliser({ rootInfo: plainRoot }), b = createNormaliser({ rootInfo: plainRoot });
  const ha = a.feed(toolCall('PreToolUse', 'Bash', 'toolu_01s', input), { t: 1 }).events[0].hash;
  const hb = b.feed(toolCall('PreToolUse', 'Bash', 'toolu_01s', input), { t: 1 }).events[0].hash;
  assert.notEqual(ha, hb, 'two normalisers, two salts');
  assert.notEqual(ha, contract.inputHash('Bash', input), 'an unsalted guess does not find the input');
  const wait = a.feed(shell('PermissionRequest', { tool_name: 'Bash', tool_input: input }), { t: 2 }).events[0];
  assert.equal(wait.hash, ha);
  a.feed(toolCall('PreToolUse', 'Read', 'toolu_01t', {}), { t: 3 });
  assert.deepEqual(a.feed(toolCall('PostToolUse', 'Read', 'toolu_01t', {}), { t: 4 }).events.map(e => e.ev), ['tool.end'], 'the wait is tied to the Bash call');
  assert.equal(a.feed(toolCall('PostToolUse', 'Bash', 'toolu_01s', input), { t: 5 }).events[0].answer, 'allowed');
});

test('a session whose root is the top of a file system keeps base names only (the real rootInfo)', () => {
  for (const [cwd, file] of [['/', '/home/example/.ssh/id_rsa'], ['C:\\', '/home/example/.ssh/id_rsa'], ['C:\\', 'C:\\Users\\example\\.ssh\\id_rsa']]) {
    const n = createNormaliser();
    const out = n.feed({ hook_event_name: 'PreToolUse', session_id: SID, cwd, tool_name: 'Read', tool_use_id: 'toolu_01u', tool_input: { file_path: file } }, { t: 1 });
    assert.equal(out.root.name, '(root)', cwd);
    assert.deepEqual(out.events[1].path, { outside: true, name: 'id_rsa' }, cwd + ' ' + file);
    const start = n.feed({ hook_event_name: 'SessionStart', session_id: SID, cwd, source: 'startup' }, { t: 2 }).events[0];
    assert.deepEqual(start.root, { name: '(root)' });
    assertClean(out.events.concat(start), 'ssh', cwd);
  }
});

test('the cwd goes beside the events, for the hub, and never into one', () => {
  const { list, root, ws } = payloads(false);
  const n = createNormaliser({ rootInfo: stubRoot(root, ws) });
  const out = n.feed(list[1], { t: 1 });
  assert.equal(out.cwd, root);
  assert.equal(out.root.root, root);
  assert.ok(!JSON.stringify(out.events).includes(MARKS.home));
  assert.ok(!JSON.stringify(out.events).includes(path.posix.dirname(root)));
});
