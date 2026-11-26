// tools/board.js, the board command for sessions (F70, F69): list, show, wait, watch, events and the inbox write verbs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tool = require("../tools/board.js");
require("./safe-temp.js").assertSafeTemp();

const NOW = Date.now();
/** A repo folder with a board: tasks.json, a status.jsonl with one record per card, and events for one card. */
function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-tool-"));
  const ab = path.join(repo, ".entomatical");
  fs.mkdirSync(path.join(ab, "events"), { recursive: true });
  const tasks = [
    { id: "aaaaaa", title: "Master", prompt: "run", status: "review", statusAt: new Date(NOW - 600_000).toISOString(), createdAt: "2026-11-04T10:00:00Z", updatedAt: new Date(NOW - 60_000).toISOString(), orchestrator: { caps: { total: 12 }, opened: 2 }, branch: "task/aaaaaa", worktree: path.join(ab, "wt", "aaaaaa") },
    { id: "bbbbbb", title: "Child one", prompt: "do one", status: "running", statusAt: new Date(NOW - 120_000).toISOString(), createdAt: "2026-11-04T10:01:00Z", updatedAt: new Date(NOW - 10_000).toISOString(), openedBy: "aaaaaa", headless: true,
      completion: { commands: ["npm test"] }, checks: { status: "error", run: path.join(ab, "checks", "bbbbbb", "1") }, usageRuns: [{ startedAt: 1, endedAt: 2, start: { week: 10, fiveHour: 1 }, end: { week: 12.5, fiveHour: 3 } }] },
    { id: "cccccc", title: "Child two", prompt: "do two", status: "done", statusAt: new Date(NOW - 30_000).toISOString(), createdAt: "2026-11-04T10:02:00Z", updatedAt: new Date(NOW - 30_000).toISOString(), openedBy: "aaaaaa" },
  ];
  fs.writeFileSync(path.join(ab, "tasks.json"), JSON.stringify(tasks));
  const rec = (t, extra = {}) => JSON.stringify({ id: t.id, at: NOW, status: t.status, since: Date.parse(t.statusAt), title: t.title, checks: null, asks: null, quiet: 0, repeating: null, judged: null, doing: null, last: null,
    watchedBy: t.openedBy ?? null, openedBy: t.openedBy ?? null, role: null, chips: [], line: `${t.id}  ${t.status}  "${t.title}"`, ...extra });
  fs.writeFileSync(path.join(ab, "status.jsonl"), tasks.map((t) => rec(t)).join("\n") + "\n");
  fs.writeFileSync(path.join(ab, "events", "bbbbbb.jsonl"), [
    { t: NOW - 100_000, hook_event_name: "SessionStart", source: "startup" }, { t: NOW - 99_000, hook_event_name: "UserPromptSubmit", prompt: "do one" },
    { t: NOW - 50_000, hook_event_name: "PostToolUse", tool_name: "Bash", desc: "Bash npm test" }, { t: NOW - 40_000, hook_event_name: "Stop", last_assistant_message: "First line of the reply\nSecond line" },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const run = path.join(ab, "checks", "bbbbbb", "1");
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, "check-0.json"), JSON.stringify({ command: "npm test", exitCode: 1 }));
  fs.writeFileSync(path.join(run, "check-0.log"), "line1\nline2\nFAIL: board.test.js\n");
  fs.mkdirSync(path.join(ab, "metrics"), { recursive: true });
  fs.writeFileSync(path.join(ab, "metrics", "bbbbbb.context.json"), JSON.stringify({ usedPercent: 23 }));
  return { repo, ab, rec, tasks };
}
const io = (repo, env = {}) => { const out = []; return { cwd: repo, env: { ...env }, write: (s) => out.push(s), out }; };

test("findRepo: ENTOMATICAL_REPO first, else the outermost folder above cwd with a board (a worktree's own board does not win)", () => {
  const { repo, ab } = fixture();
  const wt = path.join(ab, "wt", "aaaaaa");
  fs.mkdirSync(path.join(wt, ".entomatical"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".entomatical", "tasks.json"), "[]");
  assert.equal(tool.findRepo(wt, {}), path.resolve(repo));
  assert.equal(tool.findRepo(path.join(wt, "src"), { ENTOMATICAL_REPO: repo }), path.resolve(repo));
  assert.equal(tool.findRepo(os.tmpdir(), {}), undefined);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("list prints the latest status line per card, --mine the cards this task opened, --all the Done ones too", async () => {
  const { repo, ab, rec, tasks } = fixture();
  fs.appendFileSync(path.join(ab, "status.jsonl"), rec(tasks[1], { line: "bbbbbb  running  newer line" }) + "\n");
  let o = io(repo, {});
  assert.equal(await tool.main(["list"], o), 0);
  assert.deepEqual(o.out.join("").trim().split("\n"), ['aaaaaa  review  "Master"', "bbbbbb  running  newer line"]);
  o = io(repo, { ENTOMATICAL_TASK: "aaaaaa" });
  await tool.main(["list", "--mine", "--all"], o);
  assert.deepEqual(o.out.join("").trim().split("\n"), ["bbbbbb  running  newer line", 'cccccc  done  "Child two"']);
  // Without a status.jsonl (no owner yet) a plain line says so.
  fs.rmSync(path.join(ab, "status.jsonl"));
  o = io(repo, {});
  await tool.main(["list"], o);
  assert.match(o.out.join(""), /aaaaaa  review .*no status line yet/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("show prints the card: status, last reply, the failing check's last lines, chips, cost, branch and the last events", async () => {
  const { repo } = fixture();
  const o = io(repo, { ENTOMATICAL_TASK: "bbbbbb" });
  assert.equal(await tool.main(["show", "self"], o), 0);
  const text = o.out.join("");
  assert.match(text, /^bbbbbb  running  since \d\d:\d\d:\d\d \(2 min ago\)  "Child one"/);
  assert.match(text, /last reply: First line of the reply\n\s+Second line/);
  assert.match(text, /checks: failed \(npm test\)\n  npm test \(exit 1\):\n  line1\n  line2\n  FAIL: board\.test\.js/);
  assert.match(text, /chips: headless, opened by aaaaaa/);
  assert.match(text, /cost: 1 prompt · 1 tool call · account moved \+2\.5 pp weekly, \+2 pp 5-hour · context 23% at last reading/);
  assert.match(text, /branch: none  worktree: none/);
  assert.match(text, /parent: aaaaaa  root: aaaaaa/);
  assert.match(text, /assigned controller: aaaaaa  grouping parent: none/);
  assert.match(text, /events:\n(  \d\d:\d\d:\d\d .*\n){3}  \d\d:\d\d:\d\d Stop: First line of the reply/);
  const m = io(repo, {});
  await tool.main(["show", "aaaaaa"], m);
  assert.match(m.out.join(""), /chips: orchestrator \(2 of 12 opened\)/);
  assert.match(m.out.join(""), /cost: 0 prompts · 0 tool calls · No ledger data yet/);
  await assert.rejects(tool.main(["show", "ffffff"], io(repo)), /No card ffffff/);
  await assert.rejects(tool.main(["show", "self"], io(repo, {})), /No ENTOMATICAL_TASK/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("show reports unknown cost for a missing endpoint on a finished run", async (t) => {
  const { repo, ab, tasks } = fixture();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const task = tasks.find(t => t.id === "bbbbbb");
  task.usageRuns.push({ startedAt: 3, endedAt: 4, start: { week: 12.5, fiveHour: 3 }, end: { week: 14 } });
  fs.writeFileSync(path.join(ab, "tasks.json"), JSON.stringify(tasks));
  const o = io(repo, {});
  await tool.main(["show", task.id], o);
  assert.match(o.out.join(""), /account moved \+4 pp weekly, 5-hour unknown/);
});

test("F117: only receive resolves the editor thread and ambiguous snapshots fail closed in either order", async (t) => {
  const { repo, ab, tasks } = fixture();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const panel = tasks[0], editor = { CODEX_THREAD_ID: "panel-thread" };
  const save = () => fs.writeFileSync(path.join(ab, "tasks.json"), JSON.stringify(tasks));
  const show = async (env) => {
    const o = io(repo, env);
    assert.equal(await tool.main(["show", "self"], o), 0);
    return o.out.join("");
  };
  Object.assign(panel, { provider: "codex", sessionId: editor.CODEX_THREAD_ID, codexEditor: true });
  save();
  await assert.rejects(show(editor), /No ENTOMATICAL_TASK/);
  assert.match(await show({ ...editor, ENTOMATICAL_TASK: "bbbbbb" }), /^bbbbbb  running/);
  await assert.rejects(tool.main(["send", "bbbbbb", "--text", "hello", "--operator"], io(repo, editor)), /--operator is for the user's own terminal/);
  const receive = () => tool.main(["receive"], io(repo, editor));
  for (const [duplicate, reason] of [[{ ...panel, id: "dddddd" }, /Ambiguous editor thread/],
    [{ ...panel, sessionId: "different-thread" }, /Ambiguous card id/]]) {
    for (const rows of [[panel, duplicate], [duplicate, panel]]) {
      fs.writeFileSync(path.join(ab, "tasks.json"), JSON.stringify(rows));
      await assert.rejects(receive(), reason);
    }
  }
});

test("F117: a thread-only editor wait cannot create or advance the card's cursor", async (t) => {
  const { repo, ab, tasks, rec } = fixture();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const [parent, , child] = tasks;
  const editor = { CODEX_THREAD_ID: "original" };
  Object.assign(parent, { provider: "codex", codexEditor: true, sessionId: editor.CODEX_THREAD_ID });
  const save = () => fs.writeFileSync(path.join(ab, "tasks.json"), JSON.stringify(tasks));
  const wait = async (env) => {
    const o = io(repo, env);
    return [await tool.main(["wait", "--ids", child.id, "--timeout", "0.001"], o), o.out];
  };
  save();
  assert.deepEqual(await wait(editor), [2, []]);
  const dir = path.join(ab, "wait");
  assert.equal(fs.existsSync(dir), false);
  const caller = { ENTOMATICAL_TASK: parent.id, ...editor };
  assert.deepEqual(await wait(caller), [0, ['cccccc  done  "Child two"\n']]);
  const cursor = path.join(dir, parent.id + ".json");
  const before = fs.readFileSync(cursor, "utf8");
  parent.controller = { sessionId: "replacement" };
  save();
  fs.appendFileSync(path.join(ab, "status.jsonl"), rec(child, { status: "running", line: "child resumed" }) + "\n");
  assert.deepEqual(await wait(editor), [2, []]);
  assert.equal(fs.readFileSync(cursor, "utf8"), before);
  assert.deepEqual(fs.readdirSync(dir), [parent.id + ".json"]);
  assert.deepEqual(await wait({ ...caller, CODEX_THREAD_ID: "replacement" }), [0, ["child resumed\n"]]);
});

for (const first of ["bbbbbb", "cccccc"]) {
  test(`existing card cursor preserves filtered transitions when ${first} is checked first`, async (t) => {
    const { repo, ab, tasks, rec } = fixture();
    t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
    const [parent, a, b] = tasks;
    const append = (card, status) => fs.appendFileSync(path.join(ab, "status.jsonl"), rec(card, { status, line: card.id + " " + status }) + "\n");
    const wait = async (ids, env) => {
      const o = io(repo, { ENTOMATICAL_TASK: parent.id, ...env });
      return [await tool.main(["wait", "--ids", ids, "--timeout", "0.001"], o), o.out];
    };
    append(a, "review");
    append(b, "review");
    assert.deepEqual(await wait([a.id, b.id].join(",")), [0, ["bbbbbb review\n", "cccccc review\n"]]);
    parent.controller = { sessionId: "current" };
    fs.writeFileSync(path.join(ab, "tasks.json"), JSON.stringify(tasks));
    append(b, "running");
    const env = { CODEX_THREAD_ID: "current" };
    for (const id of [first, first === a.id ? b.id : a.id]) {
      assert.deepEqual(await wait(id, env), id === b.id ? [0, ["cccccc running\n"]] : [2, []]);
    }
    assert.deepEqual(await wait(b.id, env), [2, []]);
  });
}

test("events prints the raw lines from --from", async () => {
  const { repo } = fixture();
  const o = io(repo, {});
  assert.equal(await tool.main(["events", "bbbbbb", "--from", "3"], o), 0);
  const lines = o.out.join("").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).hook_event_name, "Stop");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("show never attributes old Claude context or usage to a switched ACP card", async () => {
  const { repo, ab, tasks } = fixture();
  try {
    for (const provider of ["grok", "antigravity"]) {
      tasks[1].provider = provider;
      fs.writeFileSync(path.join(ab, "tasks.json"), JSON.stringify(tasks));
      const o = io(repo, {});
      await tool.main(["show", "bbbbbb"], o);
      assert.match(o.out.join(""), /Provider usage unavailable/);
      assert.doesNotMatch(o.out.join(""), /context 23%|account moved/);
    }
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("wait returns 0 with the changed line once a watched card's record is appended, 2 on timeout with nothing printed, and survives a truncation", async () => {
  const { repo, ab, rec, tasks } = fixture();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const o = io(repo, { ENTOMATICAL_TASK: "aaaaaa" });
  const waiting = tool.main(["wait", "--ids", "bbbbbb", "--timeout", "10"], o);
  await sleep(300);
  fs.appendFileSync(path.join(ab, "status.jsonl"), rec(tasks[0], { line: "aaaaaa changed (not mine)" }) + "\n"); // the master itself: not watched by --mine
  await sleep(300);
  fs.appendFileSync(path.join(ab, "status.jsonl"), rec(tasks[1], { status: "review", line: "bbbbbb  review  settled" }) + "\n");
  assert.equal(await waiting, 0);
  assert.deepEqual(o.out, ["bbbbbb  review  settled\n"]);
  const t = io(repo, {});
  assert.equal(await tool.main(["wait", "--ids", "cccccc", "--timeout", "1"], t), 2);
  assert.deepEqual(t.out, []);
  // A new owner rewrites the file (shorter): the next change is still seen.
  const u = io(repo, { ENTOMATICAL_TASK: "aaaaaa" });
  const again = tool.main(["wait", "--ids", "bbbbbb", "--timeout", "10"], u);
  await sleep(300);
  fs.writeFileSync(path.join(ab, "status.jsonl"), rec(tasks[1], { line: "bbbbbb after takeover" }) + "\n");
  assert.equal(await again, 0);
  assert.deepEqual(u.out, ["bbbbbb after takeover\n"]);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("wait reads the file by bytes: lines with · and … do not make it miss a change, and a half-written line waits for its end", async () => {
  const { repo, ab, rec, tasks } = fixture();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wide = (t, extra) => rec(t, { title: "Parité · F14 … évidence", ...extra });
  fs.writeFileSync(path.join(ab, "status.jsonl"), [wide(tasks[0]), wide(tasks[1]), wide(tasks[2])].join("\n") + "\n");
  const o = io(repo, { ENTOMATICAL_TASK: "aaaaaa" });
  const waiting = tool.main(["wait", "--ids", "bbbbbb", "--timeout", "10"], o);
  await sleep(300);
  const line = wide(tasks[1], { status: "review", line: "bbbbbb  review  settled · with dots …" });
  fs.appendFileSync(path.join(ab, "status.jsonl"), line.slice(0, 40)); // half a line: not a change yet
  await sleep(400);
  assert.deepEqual(o.out, []);
  fs.appendFileSync(path.join(ab, "status.jsonl"), line.slice(40) + "\n");
  assert.equal(await waiting, 0);
  assert.deepEqual(o.out, ["bbbbbb  review  settled · with dots …\n"]);
  const { records, offset } = tool.readStatus(repo);
  assert.equal(records.length, 4);
  assert.equal(offset, fs.statSync(path.join(ab, "status.jsonl")).size);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("write verbs drop a request in the inbox with by and session from the environment and print the board's answer", async () => {
  const { repo, ab } = fixture();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const prompt = path.join(repo, "p.md");
  fs.writeFileSync(prompt, "Objective: one.\nOutput: two.\n");
  const o = io(repo, { ENTOMATICAL_TASK: "aaaaaa", CLAUDE_CODE_SESSION_ID: "sess-1" });
  const answer = (result) => { // the owner window: moves the request to done/ with the result appended
    const inbox = path.join(ab, "inbox");
    const file = fs.readdirSync(inbox).find((f) => f.endsWith(".json"));
    const req = JSON.parse(fs.readFileSync(path.join(inbox, file), "utf8"));
    fs.writeFileSync(path.join(inbox, "done", file), JSON.stringify({ ...req, ...result }));
    fs.rmSync(path.join(inbox, file));
    return req;
  };
  const adding = tool.main(["add", "--title", "Child three", "--prompt-file", prompt, "--model", "haiku", "--effort", "low", "--after", "bbbbbb,cccccc", "--may-open"], o);
  await sleep(300);
  const req = answer({ id: "dddddd" });
  assert.equal(await adding, 0);
  assert.deepEqual([req.v, req.op, req.by, req.session, req.title, req.prompt, req.parent, req.model, req.effort, req.after, req.start, req.mayOpen, req.autoRule, req.completion],
    [1, "add", "aaaaaa", "sess-1", "Child three", "Objective: one.\nOutput: two.\n", "aaaaaa", "haiku", "low", ["bbbbbb", "cccccc"], "auto", true, false, null]);
  assert.deepEqual(o.out, ["dddddd\n"]);
  const s = io(repo, { ENTOMATICAL_TASK: "aaaaaa" });
  const sending = tool.main(["send", "bbbbbb", "--text", "fix the failing test"], s);
  await sleep(300);
  const sent = answer({ error: "busy: the card is Running" });
  assert.equal(await sending, 1);
  assert.deepEqual([sent.op, sent.id, sent.text], ["send", "bbbbbb", "fix the failing test"]);
  assert.deepEqual(s.out, ["refused: busy: the card is Running\n"]);
  const n = io(repo, { ENTOMATICAL_TASK: "aaaaaa" });
  const noting = tool.main(["note", "child", "one", "needs", "you"], n);
  await sleep(300);
  assert.deepEqual([answer({ ok: true }).op, (await noting)], ["note", 0]);
  const p = io(repo, { ENTOMATICAL_TASK: "aaaaaa" });
  const planning = tool.main(["plan"], p);
  await sleep(300);
  assert.equal(answer({ ok: true }).op, "plan");
  assert.equal(await planning, 0);
  assert.equal(fs.readdirSync(path.join(ab, "inbox", "done")).length, 4);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("ACP write verbs and rebind use only the board-issued session, never foreign runtime ids", async (t) => {
  const { repo, ab } = fixture();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const requests = [];
  const answer = setInterval(() => {
    const inbox = path.join(ab, "inbox");
    if (!fs.existsSync(inbox)) return;
    for (const file of fs.readdirSync(inbox).filter((f) => f.endsWith(".json"))) {
      requests.push(JSON.parse(fs.readFileSync(path.join(inbox, file), "utf8")));
      fs.writeFileSync(path.join(inbox, "done", file), JSON.stringify({ ok: true }));
      fs.rmSync(path.join(inbox, file));
    }
  }, 10);
  t.after(() => clearInterval(answer));
  for (const runtime of ["grok", "antigravity"]) {
    for (const session of ["board-controller", undefined]) {
      const env = { ENTOMATICAL_TASK: "aaaaaa", ENTOMATICAL_RUNTIME: runtime, ENTOMATICAL_SESSION: session,
        CODEX_THREAD_ID: "foreign-codex", CLAUDE_CODE_SESSION_ID: "foreign-claude" };
      for (const argv of [["send", "bbbbbb", "--text", "hello"], ["rebind"]]) {
        assert.equal(await tool.main(argv, io(repo, env)), 0);
        assert.equal(requests.at(-1).session, session ?? null);
      }
      assert.equal(await tool.main(["rebind", "--session", "explicit-controller"], io(repo, env)), 0);
      assert.equal(requests.at(-1).session, "explicit-controller");
    }
  }
});

test("--help lists the verbs; an unknown verb is refused", async () => {
  const o = io(os.tmpdir(), {});
  assert.equal(await tool.main([], o), 0);
  assert.match(o.out.join(""), /board\.js list/);
  assert.match(o.out.join(""), /--runtime claude\|codex\|grok\|antigravity/);
  assert.match(o.out.join(""), /a short name always runs the newest version of that model/, "fix 11");
  assert.equal(await tool.main(["frobnicate"], o), 1);
});

test("capability labels, live descendants and host timezone are read from the owner's snapshot", async () => {
  const { repo, ab, tasks } = fixture();
  try {
    tasks.push({ ...tasks[1], id: "dddddd", openedBy: "bbbbbb", title: "Grandchild" });
    fs.writeFileSync(path.join(ab, "tasks.json"), JSON.stringify(tasks));
    const snapshot = { protocolVersion: 2, at: new Date().toISOString(), hostTimezone: "America/Vancouver", live: ["aaaaaa", "bbbbbb", "dddddd"],
      models: [{ runtime: "codex", id: "sol", newest: "gpt-6.1-sol" }, { runtime: "codex", id: "gpt-6.1-sol" }, { runtime: "grok", id: "advertised-id", account: "Grok · Work", lastSeen: "2026-11-06T00:00:00.000Z" }],
      accounts: [{ runtime: "codex", name: "Codex · test@example.com", aliases: ["Codex"] }, { runtime: "antigravity", name: "Antigravity · Shared" }] };
    fs.writeFileSync(path.join(ab, "capabilities.json"), JSON.stringify(snapshot));
    for (const [verb, pattern] of [["models", /codex  sol → gpt-6\.1-sol\n/], ["models", /codex  gpt-6\.1-sol\n/], ["models", /grok  advertised-id  Grok · Work, last seen 2026-11-06/], ["accounts", /aliases: Codex/], ["accounts", /antigravity  Antigravity · Shared/]]) {
      const output = io(repo, {}); assert.equal(await tool.main([verb], output), 0); assert.match(output.out.join(""), pattern);
    }
    const listed = io(repo, { ENTOMATICAL_TASK: "aaaaaa" });
    assert.equal(await tool.main(["list", "--mine", "--all", "--live"], listed), 0);
    assert.match(listed.out.join(""), /bbbbbb/); assert.match(listed.out.join(""), /dddddd/); assert.doesNotMatch(listed.out.join(""), /cccccc/);
    const all = io(repo, { ENTOMATICAL_TASK: "aaaaaa" });
    await tool.main(["list", "--all", "--live"], all);
    assert.match(all.out.join(""), /aaaaaa/);
    assert.match(tool.showText(repo, "dddddd"), /parent: bbbbbb  root: aaaaaa/);
    assert.match(tool.showText(repo, "bbbbbb"), /America\/Vancouver/);
    snapshot.at = "2000-01-01T00:00:00Z";
    fs.writeFileSync(path.join(ab, "capabilities.json"), JSON.stringify(snapshot));
    await assert.rejects(tool.main(["list", "--live"], io(repo, {})), /snapshot is stale/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("write verbs retry an explicit rate refusal once without hiding a later refusal", async () => {
  const { repo, ab } = fixture();
  let requests = 0;
  const answer = setInterval(() => {
    const inbox = path.join(ab, "inbox");
    if (!fs.existsSync(inbox)) return;
    for (const file of fs.readdirSync(inbox).filter((f) => f.endsWith(".json"))) {
      const error = ++requests === 1 ? "Rate: at most one request per second" : "Plan not approved";
      fs.writeFileSync(path.join(inbox, "done", file), JSON.stringify({ error }));
      fs.rmSync(path.join(inbox, file));
    }
  }, 20);
  try {
    const output = io(repo, { ENTOMATICAL_TASK: "aaaaaa" });
    assert.equal(await tool.main(["add", "--title", "next", "--prompt", "p"], output), 1);
    assert.equal(requests, 2);
    assert.deepEqual(output.out, ["refused: Plan not approved\n"]);
  } finally { clearInterval(answer); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("parallel write callers all succeed through rate refusals (up to 3 retries); a timeout is not retried", async () => {
  const { repo, ab } = fixture();
  let requests = 0, refused = 0;
  const answer = setInterval(() => {
    const inbox = path.join(ab, "inbox");
    if (!fs.existsSync(inbox)) return;
    for (const file of fs.readdirSync(inbox).filter((f) => f.endsWith(".json"))) {
      requests++;
      // the first 3 requests meet another call in flight and are refused; later ones go through
      const reply = requests <= 3 ? (refused++, { error: "Rate: at most one request per second" }) : { ok: true };
      fs.writeFileSync(path.join(inbox, "done", file), JSON.stringify(reply));
      fs.rmSync(path.join(inbox, file));
    }
  }, 20);
  try {
    const outs = await Promise.all([1, 2, 3, 4, 5].map((n) => {
      const output = io(repo, { ENTOMATICAL_TASK: "aaaaaa" });
      return tool.main(["note", `n${n}`], output).then((code) => ({ code, out: output.out.join("") }));
    }));
    assert.equal(refused, 3);
    for (const r of outs) assert.equal(r.code, 0, r.out);
  } finally { clearInterval(answer); }
  // no answer at all: a timeout comes back once, with no second request
  try {
    const output = io(repo, { ENTOMATICAL_TASK: "aaaaaa" });
    output.timeoutMs = 300;
    assert.equal(await tool.main(["note", "late"], output), 1);
    assert.match(output.out.join(""), /No answer from the board/);
    assert.equal(fs.readdirSync(path.join(ab, "inbox")).filter((f) => f.endsWith(".json")).length, 1);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("wait ignores tool activity until the watched card's state changes", async () => {
  const { repo, ab, rec, tasks } = fixture();
  try {
    const output = io(repo, { ENTOMATICAL_TASK: "aaaaaa" });
    const waiting = tool.main(["wait", "--ids", "bbbbbb", "--timeout", "3"], output);
    await new Promise((r) => setTimeout(r, 200));
    fs.appendFileSync(path.join(ab, "status.jsonl"), rec(tasks[1], { doing: "Tool activity", line: "tool call" }) + "\n");
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(output.out, []);
    fs.appendFileSync(path.join(ab, "status.jsonl"), rec(tasks[1], { status: "needs-input", line: "Child needs input" }) + "\n");
    assert.equal(await waiting, 0);
    assert.deepEqual(output.out, ["Child needs input\n"]);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("separate waits retain unseen completion, later settled replies and delivery readiness without repeating old Done states", async () => {
  const { repo, ab, rec, tasks } = fixture();
  const wait = async (args = ["--mine"]) => {
    const output = io(repo, { ENTOMATICAL_TASK: "aaaaaa" });
    const code = await tool.main(["wait", ...args, "--timeout", "0.05"], output);
    return { code, lines: output.out };
  };
  try {
    assert.deepEqual(await wait(), { code: 0, lines: ['cccccc  done  "Child two"\n'] }, "an already-settled unseen child is available immediately");
    fs.appendFileSync(path.join(ab, "status.jsonl"), rec(tasks[1], { status: "review", last: "First result", line: "bbbbbb first result" }) + "\n");
    assert.deepEqual(await wait(), { code: 0, lines: ["bbbbbb first result\n"] }, "completion between CLI calls is not swallowed into a fresh baseline");
    assert.deepEqual(await wait(), { code: 2, lines: [] }, "the same old Review and Done states are consumed only once");
    fs.appendFileSync(path.join(ab, "status.jsonl"), rec(tasks[1], { status: "review", last: "Final result", line: "bbbbbb final result" }) + "\n");
    assert.deepEqual(await wait(), { code: 0, lines: ["bbbbbb final result\n"] });
    fs.appendFileSync(path.join(ab, "status.jsonl"), rec(tasks[1], { status: "review", last: "Final result", chips: ["delivery ready"], line: "bbbbbb delivery ready" }) + "\n");
    assert.deepEqual(await wait(), { code: 0, lines: ["bbbbbb delivery ready\n"] });
    fs.appendFileSync(path.join(ab, "status.jsonl"), rec(tasks[1], { status: "review", since: NOW + 1000, last: "Final result", chips: ["delivery ready"], line: "bbbbbb another turn completed" }) + "\n");
    assert.deepEqual(await wait(), { code: 0, lines: ["bbbbbb another turn completed\n"] }, "a whole new turn between waits is seen even when its reply and checks repeat");
    assert.deepEqual(await wait(), { code: 2, lines: [] }, "the repeated reply's new completion is still consumed only once");
    tasks[1].deliveryReady = true;
    fs.writeFileSync(path.join(ab, "tasks.json"), JSON.stringify(tasks));
    assert.match(tool.showText(repo, "bbbbbb"), /delivery ready/);
    const another = io(repo, { ENTOMATICAL_TASK: "ffffff" });
    assert.equal(await tool.main(["wait", "--ids", "bbbbbb", "--timeout", "1"], another), 0, "another caller has an independent cursor");
    assert.deepEqual(another.out, ["bbbbbb another turn completed\n"]);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("a wait admits a grandchild added after the CLI started and leaves other filters' unseen states available", async () => {
  const { repo, ab, rec, tasks } = fixture();
  try {
    const first = io(repo, { ENTOMATICAL_TASK: "aaaaaa" });
    assert.equal(await tool.main(["wait", "--ids", "cccccc", "--timeout", "1"], first), 0);
    const output = io(repo, { ENTOMATICAL_TASK: "aaaaaa" });
    const waiting = tool.main(["wait", "--mine", "--timeout", "3"], output);
    await new Promise((r) => setTimeout(r, 100));
    const grandchild = { ...tasks[1], id: "dddddd", openedBy: "bbbbbb", status: "review", title: "New grandchild" };
    fs.appendFileSync(path.join(ab, "status.jsonl"), rec(grandchild, { last: "Grandchild finished", line: "dddddd completed" }) + "\n");
    assert.equal(await waiting, 0);
    assert.deepEqual(output.out, ["dddddd completed\n"]);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
