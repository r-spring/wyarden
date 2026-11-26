const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Ledger } = require("../out/ledger.js");

const made = [];
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-ledger-")); made.push(d); return d; };

// Transcript lines in the shape of Claude CLI 2.1.312 (31 October 2026): user lines carry the turn's promptId, a reply spans
// several assistant lines sharing message.id, and requestRef names an api-request line.
const S = "11111111-2222-3333-4444-555555555555";
const user = (promptId, content, timestamp = "2026-10-31T18:00:00.000Z") => ({ type: "user", promptId, sessionId: S, timestamp, message: { role: "user", content } });
const request = (id, querySource) => ({ type: "api-request", id, querySource, sessionId: S });
const reply = (id, ref, content, output, stop, extra = {}) => ({ type: "assistant", sessionId: S, requestRef: ref, requestId: `req_${id}`, effort: "medium", cwd: "/repo", entrypoint: "claude-vscode", version: "2.1.312",
  timestamp: "2026-10-31T18:00:01.000Z", ...extra,
  message: { id, model: "claude-opus-5-5", stop_reason: stop, content, usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000, output_tokens: output,
    cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 }, output_tokens_details: { thinking_tokens: 3 } } } });
const jsonl = (...l) => l.map((x) => JSON.stringify(x) + "\n").join("");
const linesOf = (dir) => fs.readFileSync(path.join(dir, "sessions", `${S}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const LATER = Date.now() + 3600_000; // every file settled

function machine() {
  const home = tmp();
  const a = path.join(home, ".claude"), b = path.join(home, ".claude-accounts", "bob");
  for (const d of [a, b]) fs.mkdirSync(path.join(d, "projects", "-repo"), { recursive: true });
  return { home, folders: [a, b], file: (d) => path.join(d, "projects", "-repo", `${S}.jsonl`), ledger: path.join(home, "ledger") };
}

test("every API call is indexed once per session, with its prompt, tools, final counts and offsets, and no text", async () => {
  const m = machine();
  const body = jsonl(
    user("p1", "secret prompt one"),
    request("r1", "sdk"),
    reply("m1", "r1", [{ type: "thinking", thinking: "secret thought" }], 1, null),
    user("p1", [{ type: "tool_result", content: "secret output" }]), // between the lines of one reply
    reply("m1", "r1", [{ type: "tool_use", name: "Bash", input: { command: "secret" } }], 40, "tool_use"),
    request("r2", "sdk"),
    reply("m2", "r2", [{ type: "text", text: "secret reply" }], 25, "end_turn"),
    user("p2", "secret prompt two", "2026-10-31T18:05:00.000Z"),
    request("r3", "sdk"),
    reply("m3", "r3", [{ type: "tool_use", name: "Agent" }], 9, "tool_use"),
  );
  // The same transcript in two account folders (Switch account copies it); the longer copy is the one read.
  fs.writeFileSync(m.file(m.folders[0]), body.slice(0, body.indexOf('{"type":"user","promptId":"p2"')));
  fs.writeFileSync(m.file(m.folders[1]), body);
  // A subagent of prompt 2: its lines carry the parent's promptId; here its first line has a partial count, the final one later.
  const sub = path.join(m.folders[1], "projects", "-repo", S, "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "agent-a1.jsonl"), jsonl(
    user("p2", "secret task"), request("r9", "agent:custom"),
    reply("s1", "r9", [], 3, null, { isSidechain: true }),
    reply("s2", "r9", [{ type: "tool_use", name: "Read" }], 7, "tool_use", { isSidechain: true }),
    reply("s1", "r9", [{ type: "tool_use", name: "Grep" }], 2558, "tool_use", { isSidechain: true }),
  ));

  const ledger = new Ledger(m.ledger, () => m.folders);
  await ledger.pass(LATER);
  const lines = linesOf(m.ledger);
  assert.doesNotMatch(JSON.stringify(lines), /secret/);
  const files = lines.filter((l) => l.k === "f");
  assert.deepEqual(files.map((f) => [path.basename(f.file), f.agentId, f.account]).sort(), [[`${S}.jsonl`, undefined, "bob"], ["agent-a1.jsonl", "a1", "bob"]].sort());
  const prompts = lines.filter((l) => l.k === "p");
  assert.deepEqual(prompts.map((p) => [p.n, p.promptId, p.at]), [[1, "p1", "2026-10-31T18:00:00.000Z"], [2, "p2", "2026-10-31T18:05:00.000Z"]]);
  const calls = Object.fromEntries(lines.filter((l) => l.k === "c").map((c) => [c.messageId, c]));
  assert.deepEqual(Object.keys(calls).sort(), ["m1", "m2", "m3", "s1", "s2"]);
  assert.deepEqual([calls.m1.promptId, calls.m1.tools, calls.m1.output, calls.m1.stop, calls.m1.querySource], ["p1", ["Bash"], 40, "tool_use", "sdk"]);
  assert.deepEqual([calls.m3.promptId, calls.m3.tools], ["p2", ["Agent"]]);
  assert.deepEqual([calls.s1.promptId, calls.s1.output, calls.s1.tools, calls.s1.querySource], ["p2", 2558, ["Grep"], "agent:custom"]);
  assert.deepEqual([calls.m2.input, calls.m2.cacheWrite, calls.m2.cacheWrite1h, calls.m2.cacheRead, calls.m2.thinking], [2, 100, 100, 5000, 3]);
  // Each offset is the start of that reply's first line in its file.
  const main = fs.readFileSync(m.file(m.folders[1]));
  assert.equal(JSON.parse(main.toString("utf8", calls.m1.offset, main.indexOf(10, calls.m1.offset))).message.id, "m1");
  assert.equal(JSON.parse(main.toString("utf8", prompts[1].offset, main.indexOf(10, prompts[1].offset))).promptId, "p2");

  const cat = JSON.parse(fs.readFileSync(path.join(m.ledger, "sessions.json"), "utf8"))[S];
  assert.deepEqual([cat.account, cat.cwd, cat.entrypoint, cat.prompts, cat.calls, cat.tokens.output], ["bob", "/repo", "claude-vscode", 2, 5, 40 + 25 + 9 + 2558 + 7]);

  // The query tool reads the index and the one transcript line a prompt points at.
  const tool = (...args) => execFileSync(process.execPath, [path.join(__dirname, "..", "tools", "ledger.js"), ...args], { env: { ...process.env, ENTOMATICAL_LEDGER_DIR: m.ledger }, encoding: "utf8" });
  assert.equal(tool("prompt", S.slice(0, 8), "2").trim(), "secret prompt two");
  const perPrompt = tool("prompts", S.slice(0, 8)).trim().split("\n");
  assert.match(perPrompt[1], /^#2\t.*calls 3 \(subagents 2\)\t.*out 2574\t.*Agent×1/);
  assert.equal(tool("calls", S.slice(0, 8), "1").trim().split("\n").length, 2);
  assert.match(tool("sessions"), new RegExp(`^${S}\\t`));
});

test("later passes read only new bytes, hold the newest calls until the file settles, and never write a call twice", async () => {
  const m = machine();
  const file = m.file(m.folders[0]);
  fs.writeFileSync(file, jsonl(user("p1", "one"), request("r1", "sdk"), reply("m1", "r1", [], 5, "end_turn")));
  const ledger = new Ledger(m.ledger, () => [m.folders[0]]);
  await ledger.pass(Date.now()); // just written: not settled, so the call is held
  assert.deepEqual(linesOf(m.ledger).filter((l) => l.k === "c"), []);
  await ledger.pass(LATER);
  assert.deepEqual(linesOf(m.ledger).filter((l) => l.k === "c").map((c) => c.messageId), ["m1"]);
  await ledger.pass(LATER); // nothing new
  // A line still being written waits for the next pass; an api-request line in one pass names the reply in the next.
  fs.appendFileSync(file, jsonl(user("p2", "two"), request("r2", "title")) + '{"type":"assist');
  await ledger.pass(LATER);
  fs.appendFileSync(file, 'ant"}\n' + jsonl(reply("m2", "r2", [], 7, "end_turn")));
  // A second window's Ledger takes over: it reads the saved state rather than starting again.
  await new Ledger(m.ledger, () => [m.folders[0]]).pass(LATER);
  const calls = linesOf(m.ledger).filter((l) => l.k === "c");
  assert.deepEqual(calls.map((c) => [c.messageId, c.promptId, c.querySource]), [["m1", "p1", "sdk"], ["m2", "p2", "title"]]);
  assert.deepEqual(linesOf(m.ledger).filter((l) => l.k === "p").map((p) => p.n), [1, 2]);

  // Lost state: the index is rebuilt from the transcripts, not appended to a second time.
  fs.rmSync(path.join(m.ledger, "state.json"));
  await new Ledger(m.ledger, () => [m.folders[0]]).pass(LATER);
  assert.deepEqual(linesOf(m.ledger).filter((l) => l.k === "c").map((c) => c.messageId), ["m1", "m2"]);
});

// Reviewed fixes of 4 November 2026 (FEATURES.md F56).
const { sources } = require("../out/ledger.js");
const callsOf = (dir, session = S) => fs.readFileSync(path.join(dir, "sessions", `${session}.jsonl`), "utf8").trim().split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }).filter((l) => l.k === "c");
const catalogOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "sessions.json"), "utf8"))[S];
const done = (id, extra) => reply(id, "r1", [], 10, "end_turn", extra);

test("hard links of one transcript go to the account that ran it, and an append between two stats does not move them", async () => {
  const m = machine();
  const [a, b] = m.folders;
  fs.writeFileSync(m.file(a), jsonl(user("p1", "x"), request("r1", "sdk"), done("m1")));
  fs.linkSync(m.file(a), m.file(b));
  fs.mkdirSync(path.join(a, "session-env", S), { recursive: true }); // a's CLI ran it; bob is listed first, and sorts first
  await new Ledger(m.ledger, () => [b, a]).pass(LATER);
  assert.deepEqual(linesOf(m.ledger).filter((l) => l.k === "f").map((f) => f.file), [m.file(a)]);
  assert.equal(catalogOf(m.ledger).file, m.file(a));

  // The flip: the CLI appends between the two stats, so the second link looked longer.
  const n = machine();
  fs.writeFileSync(n.file(n.folders[0]), jsonl(user("p1", "x"), request("r1", "sdk"), done("m1")));
  fs.linkSync(n.file(n.folders[0]), n.file(n.folders[1]));
  fs.mkdirSync(path.join(n.folders[0], "session-env", S), { recursive: true });
  const stat = fs.statSync;
  let appended = false;
  fs.statSync = function (f, ...rest) {
    const r = stat.call(this, f, ...rest);
    if (!appended && f === n.file(n.folders[0])) { appended = true; fs.appendFileSync(f, jsonl(done("m2"))); }
    return r;
  };
  try { assert.equal(sources(n.folders)[0].file, n.file(n.folders[0])); } finally { fs.statSync = stat; }
  // Both folders ran it (resumed after Switch account): the newer session-env wins, not the path (bob sorts first).
  const q = machine();
  fs.writeFileSync(q.file(q.folders[0]), jsonl(user("p1", "x"), request("r1", "sdk"), done("m1")));
  fs.linkSync(q.file(q.folders[0]), q.file(q.folders[1]));
  for (const [d, t] of [[q.folders[0], 2000], [q.folders[1], 1000]]) {
    const env = path.join(d, "session-env", S);
    fs.mkdirSync(env, { recursive: true });
    fs.utimesSync(env, t, t);
  }
  assert.equal(sources(q.folders)[0].file, q.file(q.folders[0]));
  // No session-env anywhere: the link in the session's own project folder (cwd /repo is "-repo") wins.
  const o = machine();
  const elsewhere = path.join(o.folders[0], "projects", "-elsewhere", `${S}.jsonl`);
  fs.mkdirSync(path.dirname(elsewhere));
  fs.writeFileSync(elsewhere, jsonl(user("p1", "x"), request("r1", "sdk"), done("m1")));
  fs.linkSync(elsewhere, o.file(o.folders[1]));
  assert.equal(sources(o.folders)[0].file, o.file(o.folders[1]));
  // A real copy still wins by being longer.
  fs.rmSync(o.file(o.folders[1]));
  fs.copyFileSync(elsewhere, o.file(o.folders[1]));
  fs.appendFileSync(elsewhere, jsonl(done("m2")));
  assert.equal(sources(o.folders)[0].file, elsewhere);
});

test("a session indexed under the wrong hard link is corrected once, without reading it again", async () => {
  const m = machine();
  const [a, b] = m.folders;
  fs.writeFileSync(m.file(a), jsonl(user("p1", "x"), request("r1", "sdk"), done("m1")));
  fs.linkSync(m.file(a), m.file(b));
  await new Ledger(m.ledger, () => m.folders).pass(LATER); // no session-env yet: the path decides
  const first = linesOf(m.ledger).filter((l) => l.k === "f")[0];
  const other = first.file === m.file(a) ? b : a;
  fs.mkdirSync(path.join(other, "session-env", S), { recursive: true });
  await new Ledger(m.ledger, () => m.folders).pass(LATER);
  await new Ledger(m.ledger, () => m.folders).pass(LATER);
  const files = linesOf(m.ledger).filter((l) => l.k === "f");
  assert.deepEqual(files.map((f) => [f.f, f.file]), [[1, first.file], [1, m.file(other)]]);
  assert.equal(catalogOf(m.ledger).file, m.file(other));
  assert.deepEqual(callsOf(m.ledger).map((c) => c.messageId), ["m1"]);
});

test("a fork subagent's copy of its parent's call is not counted again; a user line over 256 KB ends the copy too", async () => {
  const m = machine();
  const [a] = m.folders;
  fs.writeFileSync(m.file(a), jsonl(user("p1", "x"), request("r1", "sdk"), reply("m1", "r1", [{ type: "tool_use", name: "Agent" }], 9, "tool_use")));
  const sub = path.join(a, "projects", "-repo", S, "subagents");
  fs.mkdirSync(sub, { recursive: true });
  const ref = { type: "fork-context-ref", sessionId: S, parentMessageId: "m1" };
  fs.writeFileSync(path.join(sub, "agent-f1.jsonl"), jsonl(ref, reply("m1", "r1", [{ type: "tool_use", name: "Agent" }], 9, "tool_use"), user("p1", "task"), done("f1")));
  const big = user("p1", [{ type: "tool_result", content: "y".repeat(300 << 10) }]);
  fs.writeFileSync(path.join(sub, "agent-f2.jsonl"), jsonl(ref, reply("m1", "r1", [], 9, "tool_use"), big, done("f2")));
  // A copy whose id the parent's file lacks: only the fork check keeps it out, not id dedupe.
  fs.writeFileSync(path.join(sub, "agent-f3.jsonl"), jsonl(ref, reply("copy", "r1", [], 9, "tool_use"), user("p1", "task"), done("f3")));
  await new Ledger(m.ledger, () => [a]).pass(LATER);
  const calls = callsOf(m.ledger);
  assert.deepEqual(calls.map((c) => c.messageId).sort(), ["f1", "f2", "f3", "m1"]);
  const parent = linesOf(m.ledger).find((l) => l.k === "f" && !l.agentId).f;
  assert.equal(calls.find((c) => c.messageId === "m1").f, parent);
  assert.equal(catalogOf(m.ledger).calls, 4);
});

test("a user line over 256 KB still starts its prompt", async () => {
  const m = machine();
  const [a] = m.folders;
  const p2 = "22222222-2222-3333-4444-555555555555"; // a big line's promptId is found by its UUID shape
  const big = user(p2, [{ type: "tool_result", content: "y".repeat(300 << 10) }], "2026-10-31T18:05:00.000Z");
  fs.writeFileSync(m.file(a), jsonl(user("p1", "x"), request("r1", "sdk"), done("m1"), big, done("m2")));
  await new Ledger(m.ledger, () => [a]).pass(LATER);
  assert.deepEqual(linesOf(m.ledger).filter((l) => l.k === "p").map((p) => [p.n, p.promptId, p.at]), [[1, "p1", "2026-10-31T18:00:00.000Z"], [2, p2, "2026-10-31T18:05:00.000Z"]]);
  assert.deepEqual(callsOf(m.ledger).map((c) => [c.messageId, c.promptId]), [["m1", "p1"], ["m2", p2]]);
});

test("a call or prompt written again far away, and a partial count more than eight calls before its final one, are counted once", async () => {
  const m = machine();
  const [a] = m.folders;
  const ten = Array.from({ length: 10 }, (_, i) => done(`m${i}`));
  fs.writeFileSync(m.file(a), jsonl(user("p1", "x"), request("r1", "sdk"), ...ten, user("p2", "y"), done("m10"), user("p1", "x"), done("m0"), done("m11")));
  const sub = path.join(a, "projects", "-repo", S, "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "agent-a1.jsonl"), jsonl(user("p1", "task"), reply("s1", "r1", [], 3, null),
    ...Array.from({ length: 9 }, (_, i) => done(`s${i + 2}`)), reply("s1", "r1", [{ type: "tool_use", name: "Grep" }], 2558, "tool_use")));
  const ledger = new Ledger(m.ledger, () => [a]);
  await ledger.pass(Date.now()); // not settled: only finished calls beyond the newest eight are written
  await ledger.pass(LATER);
  const calls = callsOf(m.ledger);
  const ids = calls.map((c) => c.messageId);
  assert.equal(ids.length, new Set(ids).size);
  assert.equal(ids.length, 12 + 10);
  const s1 = calls.find((c) => c.messageId === "s1");
  assert.deepEqual([s1.output, s1.stop, s1.tools], [2558, "tool_use", ["Grep"]]);
  assert.deepEqual(linesOf(m.ledger).filter((l) => l.k === "p").map((p) => [p.n, p.promptId]), [[1, "p1"], [2, "p2"]]);
  const cat = catalogOf(m.ledger);
  assert.deepEqual([cat.calls, cat.prompts, cat.tokens.output], [22, 2, 21 * 10 + 2558]);
});

test("a shorter copy left after the longer one's folder is removed adds no calls", async () => {
  const m = machine();
  const [a, b] = m.folders;
  const body = jsonl(user("p1", "x"), request("r1", "sdk"), done("m1"), done("m2"));
  fs.writeFileSync(m.file(a), body.slice(0, body.lastIndexOf('{"type":"assistant"')));
  fs.writeFileSync(m.file(b), body);
  await new Ledger(m.ledger, () => m.folders).pass(LATER);
  assert.equal(catalogOf(m.ledger).calls, 2);
  fs.rmSync(path.join(b, "projects"), { recursive: true });
  await new Ledger(m.ledger, () => m.folders).pass(LATER);
  assert.equal(catalogOf(m.ledger).calls, 2);
  assert.deepEqual(callsOf(m.ledger).map((c) => c.messageId), ["m1", "m2"]);
});

test("nothing is written while another window owns the ledger, and the 15-minute poll runs only in the owner", async (t) => {
  const m = machine();
  fs.writeFileSync(m.file(m.folders[0]), jsonl(user("p1", "x"), request("r1", "sdk"), done("m1")));
  fs.mkdirSync(m.ledger, { recursive: true });
  const owner = path.join(m.ledger, "owner.json");
  const ledger = new Ledger(m.ledger, () => [m.folders[0]]);
  fs.writeFileSync(owner, JSON.stringify({ pid: ledger.pid + 1, at: Date.now() })); // took it after this window's claim, or this one went stale
  assert.equal(await ledger.pass(LATER), 0);
  assert.equal(fs.existsSync(path.join(m.ledger, "sessions")) || fs.existsSync(path.join(m.ledger, "state.json")), false);
  fs.writeFileSync(owner, JSON.stringify({ pid: ledger.pid, at: Date.now() }));
  assert.equal(await ledger.pass(LATER), 3);

  t.mock.timers.enable({ apis: ["setInterval"] });
  let runs = 0;
  const poll = ledger.whileOwned(1000, () => runs++);
  ledger.owned = false;
  t.mock.timers.tick(1000);
  ledger.owned = true;
  fs.writeFileSync(owner, JSON.stringify({ pid: ledger.pid + 1, at: Date.now() }));
  t.mock.timers.tick(1000);
  assert.equal(runs, 0);
  fs.writeFileSync(owner, JSON.stringify({ pid: ledger.pid, at: Date.now() }));
  t.mock.timers.tick(1000);
  assert.equal(runs, 1);
  poll.dispose();
});

test("other-version state stops the ledger without deleting the index; damaged or missing state is set aside with the index and rebuilt, with one warning", async () => {
  const m = machine();
  const file = m.file(m.folders[0]);
  const body = jsonl(user("p1", "x"), request("r1", "sdk"), done("m1"));
  fs.writeFileSync(file, body);
  await new Ledger(m.ledger, () => [m.folders[0]]).pass(LATER);
  const index = fs.readFileSync(path.join(m.ledger, "sessions", `${S}.jsonl`), "utf8");
  fs.rmSync(file); // the CLI's cleanup: the index is the only record of m1 now
  const stateFile = path.join(m.ledger, "state.json");
  const other = JSON.stringify({ version: 99, files: {}, next: {} });
  fs.writeFileSync(stateFile, other);
  const warnings = [];
  const ledger = new Ledger(m.ledger, () => [m.folders[0]], undefined, (w) => warnings.push(w));
  assert.equal(await ledger.pass(LATER), 0);
  assert.equal(await ledger.pass(LATER), 0);
  assert.equal(fs.readFileSync(path.join(m.ledger, "sessions", `${S}.jsonl`), "utf8"), index);
  assert.equal(fs.readFileSync(stateFile, "utf8"), other);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /version 99/);

  // Damaged: kept as state.json.bad-<time>, the index set aside, and the ledger carries on.
  fs.writeFileSync(stateFile, "{half");
  const told = [];
  await new Ledger(m.ledger, () => [m.folders[0]], undefined, (w) => told.push(w)).pass(LATER);
  assert.equal(told.length, 1);
  assert.match(told[0], /state\.json\.bad-/);
  const bad = fs.readdirSync(m.ledger).filter((n) => n.startsWith("state.json.bad-"));
  assert.deepEqual(bad.map((n) => fs.readFileSync(path.join(m.ledger, n), "utf8")), ["{half"]);
  const aside = () => fs.readdirSync(m.ledger).filter((n) => n.startsWith("sessions.before-")).sort();
  const first = aside();
  assert.equal(first.length, 1);
  assert.equal(fs.readFileSync(path.join(m.ledger, first[0], `${S}.jsonl`), "utf8"), index);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).version, 1);

  // Missing state, twice more: only the newest two copies of the old index are kept.
  fs.writeFileSync(file, body);
  await new Ledger(m.ledger, () => [m.folders[0]]).pass(LATER); // a new index to set aside
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => setTimeout(r, 5)); // a new <time>
    fs.rmSync(stateFile);
    await new Ledger(m.ledger, () => [m.folders[0]]).pass(LATER);
  }
  assert.equal(aside().length, 2);
  assert.equal(aside().includes(first[0]), false);

  // A missing catalog beside present state is rebuilt too, so the session read already is in it again.
  fs.rmSync(path.join(m.ledger, "sessions.json"));
  await new Ledger(m.ledger, () => [m.folders[0]]).pass(LATER);
  assert.equal(catalogOf(m.ledger)?.calls, 1);
});

test("the old index folder that cannot be renamed (Windows: a file in it is open) is retried next pass; a failing pass is caught in the tick", async (t) => {
  const m = machine();
  fs.writeFileSync(m.file(m.folders[0]), jsonl(user("p1", "x"), request("r1", "sdk"), done("m1")));
  await new Ledger(m.ledger, () => [m.folders[0]]).pass(LATER);
  fs.rmSync(path.join(m.ledger, "state.json"));
  const rename = fs.renameSync;
  fs.renameSync = function (from, ...rest) {
    if (from === path.join(m.ledger, "sessions")) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    return rename.call(this, from, ...rest);
  };
  const errors = [], log = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try { assert.equal(await new Ledger(m.ledger, () => [m.folders[0]]).pass(LATER), 0); } finally { fs.renameSync = rename; console.error = log; }
  assert.match(errors.join("\n"), /retried next pass/);
  assert.equal(fs.readdirSync(m.ledger).some((n) => n.startsWith("sessions.before-")), false);
  assert.equal(await new Ledger(m.ledger, () => [m.folders[0]]).pass(LATER), 3);
  assert.equal(fs.readdirSync(m.ledger).filter((n) => n.startsWith("sessions.before-")).length, 1);

  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const ledger = new Ledger(m.ledger, () => [m.folders[0]]);
  ledger.pass = async () => { throw new Error("boom"); };
  errors.length = 0;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    ledger.start(1000);
    t.mock.timers.tick(5000);
    t.mock.timers.tick(1000);
    await new Promise((r) => setImmediate(r));
  } finally { console.error = log; ledger.dispose(); }
  assert.deepEqual(errors.filter((e) => /boom/.test(e)).length, 1);
});

test("a pass that ends without its save leaves no stale catalog: the next pass recounts from the index", async () => {
  const m = machine();
  const [a] = m.folders;
  fs.writeFileSync(m.file(a), jsonl(user("p1", "x"), request("r1", "sdk"), done("m1")));
  const ledger = new Ledger(m.ledger, () => [a]);
  await ledger.pass(LATER);
  fs.appendFileSync(m.file(a), jsonl(done("m2")));
  ledger.save = () => false; // another window took the ledger as the pass ended
  await ledger.pass(LATER);
  delete ledger.save;
  await ledger.pass(LATER);
  assert.deepEqual(callsOf(m.ledger).map((c) => c.messageId), ["m1", "m2"]);
  assert.equal(catalogOf(m.ledger).calls, 2);
});

// As 0.8.8 left a session: one call twice in the index and in the catalog's totals.
function doubled(m) {
  const idx = path.join(m.ledger, "sessions", `${S}.jsonl`);
  fs.appendFileSync(idx, JSON.stringify(callsOf(m.ledger)[0]) + "\n");
  const catFile = path.join(m.ledger, "sessions.json");
  const cat = JSON.parse(fs.readFileSync(catFile, "utf8"));
  cat[S].calls = 2;
  cat[S].tokens.output = 20;
  fs.writeFileSync(catFile, JSON.stringify(cat));
}

test("a session read again has its catalog totals recounted from the index, a call written twice counted once", async () => {
  const m = machine();
  const [a] = m.folders;
  fs.writeFileSync(m.file(a), jsonl(user("p1", "x"), request("r1", "sdk"), done("m1")));
  await new Ledger(m.ledger, () => [a]).pass(LATER);
  doubled(m);
  fs.appendFileSync(m.file(a), jsonl(done("m2")));
  await new Ledger(m.ledger, () => [a]).pass(LATER);
  assert.deepEqual([catalogOf(m.ledger).calls, catalogOf(m.ledger).tokens.output], [2, 20]);
});

test("after an upgrade from 0.8.8 state, a finished session's catalog totals are recounted once from its index", async () => {
  const m = machine();
  const [a] = m.folders;
  fs.writeFileSync(m.file(a), jsonl(user("p1", "x"), request("r1", "sdk"), done("m1")));
  await new Ledger(m.ledger, () => [a]).pass(LATER);
  doubled(m);
  const stateFile = path.join(m.ledger, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  for (const f of Object.values(state.files)) f.file = m.file(a); // 0.8.8's field
  fs.writeFileSync(stateFile, JSON.stringify(state));
  await new Ledger(m.ledger, () => [a]).pass(LATER); // the transcript has nothing new
  assert.deepEqual([catalogOf(m.ledger).calls, catalogOf(m.ledger).tokens.output], [1, 10]);
});

test("calls held when the picked copy shrinks are written before it is read from its start", async () => {
  const m = machine();
  const [a] = m.folders;
  fs.writeFileSync(m.file(a), jsonl(user("p1", "x"), request("r1", "sdk"), done("m1"), done("m2"), done("m3")));
  const ledger = new Ledger(m.ledger, () => [a]);
  await ledger.pass(Date.now()); // not settled: all three held
  fs.writeFileSync(m.file(a), jsonl(done("m9")));
  await ledger.pass(LATER);
  assert.deepEqual(callsOf(m.ledger).map((c) => c.messageId), ["m1", "m2", "m3", "m9"]);
  assert.equal(catalogOf(m.ledger).calls, 4);
});

test("the CLI's own <synthetic> lines are not calls", async () => {
  const m = machine();
  const [a] = m.folders;
  const limit = reply("syn1", "r1", [{ type: "text", text: "You've hit your session limit" }], 0, "stop_sequence");
  limit.message.model = "<synthetic>";
  fs.writeFileSync(m.file(a), jsonl(user("p1", "x"), request("r1", "sdk"), done("m1"), limit));
  await new Ledger(m.ledger, () => [a]).pass(LATER);
  assert.deepEqual(callsOf(m.ledger).map((c) => c.messageId), ["m1"]);
  assert.equal(catalogOf(m.ledger).calls, 1);
});

test("state is saved once per pass, keeps no entry for a deleted file, and writes that file's held calls first", async () => {
  const m = machine();
  const dir = path.join(m.folders[0], "projects", "-repo");
  const ids = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(8, "0")}-2222-3333-4444-555555555555`);
  for (const id of ids) fs.writeFileSync(path.join(dir, `${id}.jsonl`), jsonl({ ...user("p1", "x"), sessionId: id }, done(`m-${id}`)));
  const ledger = new Ledger(m.ledger, () => [m.folders[0]]);
  let saves = 0;
  const save = ledger.save;
  ledger.save = function () { saves++; return save.call(this); };
  await ledger.pass(Date.now()); // just written: every call held
  assert.equal(saves, 1);
  fs.rmSync(path.join(dir, `${ids[0]}.jsonl`));
  await ledger.pass(Date.now());
  assert.equal(saves, 2);
  // A pass with nothing new writes neither state file.
  const look = () => ["state.json", "sessions.json"].map((n) => { const s = fs.statSync(path.join(m.ledger, n), { bigint: true }); return `${s.ino}:${s.mtimeNs}`; });
  const before = look();
  await ledger.pass(Date.now());
  assert.deepEqual([saves, look()], [2, before]);
  const state = JSON.parse(fs.readFileSync(path.join(m.ledger, "state.json"), "utf8"));
  assert.equal(Object.keys(state.files).length, 29);
  assert.equal(Object.values(state.files).some((f) => "file" in f), false);
  assert.deepEqual(callsOf(m.ledger, ids[0]).map((c) => c.messageId), [`m-${ids[0]}`]);
});

test("subagents nested under subagents/workflows/<id>/ are indexed", async () => {
  const m = machine();
  const [a] = m.folders;
  fs.writeFileSync(m.file(a), jsonl(user("p1", "x"), request("r1", "sdk"), done("m1")));
  const deep = path.join(a, "projects", "-repo", S, "subagents", "workflows", "wf1");
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, "agent-w1.jsonl"), jsonl(user("p1", "task"), done("w1")));
  await new Ledger(m.ledger, () => [a]).pass(LATER);
  assert.deepEqual(callsOf(m.ledger).map((c) => c.messageId).sort(), ["m1", "w1"]);
  assert.deepEqual(linesOf(m.ledger).filter((l) => l.k === "f").map((f) => f.agentId ?? "main").sort(), ["main", "w1"]);
});

test("the query tool skips a half-written index line and says so plainly when a transcript is gone", async () => {
  const m = machine();
  const file = m.file(m.folders[0]);
  fs.writeFileSync(file, jsonl(user("p1", "x"), request("r1", "sdk"), done("m1")));
  await new Ledger(m.ledger, () => [m.folders[0]]).pass(LATER);
  fs.appendFileSync(path.join(m.ledger, "sessions", `${S}.jsonl`), '{"k":"c","f":1,"mess');
  const tool = (...args) => execFileSync(process.execPath, [path.join(__dirname, "..", "tools", "ledger.js"), ...args], { env: { ...process.env, ENTOMATICAL_LEDGER_DIR: m.ledger }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(tool("calls", S.slice(0, 8)).trim().split("\n").length, 1);
  fs.rmSync(file);
  assert.throws(() => tool("prompt", S.slice(0, 8), "1"), (e) => /transcript is gone/.test(e.stderr) && !/\n\s+at /.test(e.stderr));
  // The ledger's next line starts on a line of its own, after the half-written one.
  fs.writeFileSync(file, jsonl(user("p1", "x"), request("r1", "sdk"), done("m1"), done("m2")));
  await new Ledger(m.ledger, () => [m.folders[0]]).pass(LATER);
  assert.deepEqual(callsOf(m.ledger).map((c) => c.messageId), ["m1", "m2"]);
});

test("the query tool is placed in the ledger folder from installed windows only, never from a dev host's build", () => {
  const dir = tmp(), pkg = tmp();
  for (const f of ["docs/ledger.md", "tools/ledger.js", "out/efficiency.js"]) { fs.mkdirSync(path.dirname(path.join(pkg, f)), { recursive: true }); fs.writeFileSync(path.join(pkg, f), `built ${f}`); }
  const installed = new Ledger(dir, () => [], pkg);
  installed.place(); // start() runs this first
  assert.equal(fs.readFileSync(path.join(dir, "efficiency.js"), "utf8"), "built out/efficiency.js");
  // A dev host passes no packaged folder (src/extension.ts: placeFiles), so an installed window's copy survives it.
  fs.writeFileSync(path.join(dir, "efficiency.js"), "installed copy");
  const dev = new Ledger(dir, () => [], undefined);
  dev.place();
  assert.equal(fs.readFileSync(path.join(dir, "efficiency.js"), "utf8"), "installed copy");
  const source = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
  assert.match(source, /new Ledger\(undefined, undefined, placeFiles \? context\.extensionPath : undefined,/);
});
