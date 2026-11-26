// F93: Grok and Antigravity token counts, sign-in and recent totals from the CLIs' own files, and the model comparison.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-provider-usage-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// The collector discovers Antigravity conversations relative to the home at module load.
const home = test.mock.method(os, "homedir", () => tmp);
const p = require("../out/providerUsage.js");
home.mock.restore();
const { UsageCollector } = require("../out/metrics.js");
const { modelEfficiency } = require("../out/efficiency.js");

// Minimal protobuf writer for fixtures: varints and length-delimited fields only, as agy's files use.
const varint = (n) => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n); return out; };
const vfield = (f, n) => Buffer.from([...varint(f * 8), ...varint(n)]);
const lfield = (f, bytes) => Buffer.concat([Buffer.from([...varint(f * 8 + 2), ...varint(bytes.length)]), bytes]);
const callBlob = (u) => lfield(1, Buffer.concat([vfield(3, 1318), lfield(4, Buffer.concat([vfield(1, 1318), vfield(2, u.input), vfield(3, u.output),
  ...(u.cache ? [vfield(5, u.cache)] : []), vfield(9, u.thinking ?? 0)]))]));
const workspaceBlob = (dir) => lfield(1, Buffer.concat([lfield(1, Buffer.from(pathToFileURL(dir).href)), lfield(3, Buffer.alloc(0))]));

function grokUsage(session, turns, updatedAt = new Date().toISOString()) {
  return JSON.stringify({ sessionId: "s", updatedAt, session, turns });
}

test("Grok usage.json: input counts fresh input only, per model, with cache writes", () => {
  const u = p.grokUsageFile(grokUsage({ inputTokens: 1000, outputTokens: 50, cachedReadTokens: 600, cacheCreationTokens: 100, totalTokens: 1050,
    modelUsage: { "grok-4.7": { inputTokens: 1000, outputTokens: 50, cachedReadTokens: 600, cacheCreationTokens: 100 } } },
    [{ endedAt: "2026-11-06T04:58:20Z", inputTokens: 1000, outputTokens: 50, cachedReadTokens: 600, cacheCreationTokens: 100 }]));
  assert.deepEqual(u.models, { "grok-4.7": { input: 300, cacheRead: 600, cacheWrite: 100, output: 50 } });
  assert.deepEqual(u.turns, [{ at: Date.parse("2026-11-06T04:58:20Z"), total: 1050, output: 50 }]);
  assert.equal(p.grokUsageFile("not json"), undefined);
  assert.equal(p.grokUsageFile("{}"), undefined);
  // No per-model split: the session totals go to the primary model.
  assert.deepEqual(Object.keys(p.grokUsageFile(grokUsage({ inputTokens: 5, outputTokens: 1, primaryModelId: "grok-x" }, [])).models), ["grok-x"]);
});

test("Grok card: only sessions of the card's worktree count; a running turn is not complete", () => {
  const home = path.join(tmp, "grok-home"), wt = path.join(tmp, "work tree"), other = path.join(tmp, "other");
  const put = (cwd, id, session) => {
    const dir = path.join(home, "sessions", encodeURIComponent(cwd), id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "usage.json"), grokUsage(session, []));
  };
  put(wt, "a", { inputTokens: 100, outputTokens: 10, cachedReadTokens: 40, cacheCreationTokens: 0, modelUsage: { g: { inputTokens: 100, outputTokens: 10, cachedReadTokens: 40, cacheCreationTokens: 0 } } });
  put(wt, "b", { inputTokens: 50, outputTokens: 5, cachedReadTokens: 0, cacheCreationTokens: 0, modelUsage: { g: { inputTokens: 50, outputTokens: 5, cachedReadTokens: 0, cacheCreationTokens: 0 } } });
  put(other, "c", { inputTokens: 9999, outputTokens: 9, modelUsage: { g: { inputTokens: 9999, outputTokens: 9 } } });
  const m = p.grokMeasurement(home, wt, false);
  assert.equal(m.source, "stream");
  assert.equal(m.complete, true);
  assert.equal(m.total, 165);
  assert.deepEqual(m.tokens, { input: 110, cacheRead: 40, cacheWrite: 0, output: 15 });
  const live = p.grokMeasurement(home, wt, true);
  assert.equal(live.complete, false);
  assert.match(live.gaps.join(" "), /still running/);
  const none = p.grokMeasurement(home, path.join(tmp, "empty"), false);
  assert.equal(none.source, "unknown");
  assert.equal(p.grokMeasurement(home, undefined, false).source, "unknown");
});

test("Grok measurements require both core counters, retain valid subtotals and keep explicit zeros", () => {
  const home = path.join(tmp, "grok-counters");
  const good = { inputTokens: 12, outputTokens: 5 };
  const zero = { inputTokens: 0, outputTokens: 0 };
  const collector = new UsageCollector({ dir: tmp });
  // Each case has a separate worktree. Each item in sessions gets its own usage file.
  const cases = [
    ["no counters", [{ primaryModelId: "g" }], undefined],
    ["input only", [{ inputTokens: 12 }], undefined],
    ["output only", [{ outputTokens: 5 }], undefined],
    ["string", [{ ...good, inputTokens: "12" }], undefined],
    ["negative", [{ ...good, outputTokens: -1 }], undefined],
    ["fraction", [{ ...good, outputTokens: 0.5 }], undefined],
    ["optional only", [{ cachedReadTokens: 7 }], undefined],
    ["explicit zeros", [zero], 0],
    ["model zeros", [{ modelUsage: { g: zero } }], 0],
    ["no cache fields", [good], 17],
    ["cache read only", [{ ...good, cachedReadTokens: 3 }], 17, false, 3, 0],
    ["cache write only", [{ ...good, cacheCreationTokens: 4 }], 17, false, 0, 4],
    ["mixed models", [{ inputTokens: 99, outputTokens: 5, modelUsage: { g: good, bad: {} } }], 17, true],
    ["non-object model", [{ modelUsage: { g: good, bad: "invalid" } }], 17, true],
    ["aggregate fallback", [{ ...good, modelUsage: { bad: {} } }], 17, true],
    ["mixed sessions", [good, {}], 17, true],
    ["missing usage file", [good, undefined], 17, true],
  ];
  for (const [id, sessions, expected, partial = false, cacheRead = 0, cacheWrite = 0] of cases) {
    const wt = path.join(tmp, id);
    sessions.forEach((session, i) => {
      const dir = path.join(home, "sessions", encodeURIComponent(wt), String(i));
      fs.mkdirSync(dir, { recursive: true });
      if (session) fs.writeFileSync(path.join(dir, "usage.json"), grokUsage(session, []));
    });
    const task = { id, provider: "grok", configDir: home, ranIn: wt, status: "done" };
    const m = collector.session(task);
    assert.equal(m.total, expected, id);
    assert.equal(m.source, expected === undefined ? "unknown" : "stream", id);
    assert.equal(m.complete, expected !== undefined && !partial, id);
    assert.equal(m.tokens.cacheRead, cacheRead, id);
    assert.equal(m.tokens.cacheWrite, cacheWrite, id);
    if (partial || expected === undefined) assert.match(m.gaps.join(" "), /usage.*(counters|could not be read)/i, id);
    const [row] = modelEfficiency([{ ...task, measurement: m }]);
    assert.deepEqual([row.measured, row.partial, row.medianTotal], [Number(expected !== undefined), Number(partial), expected], id);
    const running = collector.session({ ...task, status: "running", worktree: wt });
    assert.equal(running.complete, false, id);
    assert.equal(running.source, m.source, id);
    assert.equal(running.total, expected, id);
    if (expected !== undefined) assert.match(running.gaps.join(" "), /still running/, id);
  }
});

test("Grok sign-in: the email, never the token", () => {
  const home = path.join(tmp, "grok-auth");
  fs.mkdirSync(home, { recursive: true });
  assert.deepEqual(p.grokSignIn(home), { signedIn: false });
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ "https://auth.x.ai::id": { key: "secret-token", refresh_token: "secret-refresh", email: "me@example.com" } }));
  const s = p.grokSignIn(home);
  assert.deepEqual(s, { signedIn: true, email: "me@example.com" });
  assert.doesNotMatch(JSON.stringify(s), /secret/);
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ x: { email: "gone@example.com" } }));
  assert.deepEqual(p.grokSignIn(home), { signedIn: false });
});

test("Grok recent totals use each turn's end time", () => {
  const home = path.join(tmp, "grok-recent"), now = Date.parse("2026-11-06T12:00:00Z");
  const dir = path.join(home, "sessions", encodeURIComponent(tmp), "s1");
  fs.mkdirSync(dir, { recursive: true });
  const turn = (iso, input, output) => ({ endedAt: iso, inputTokens: input, outputTokens: output, cachedReadTokens: 0, cacheCreationTokens: 0 });
  fs.writeFileSync(path.join(dir, "usage.json"), grokUsage({ inputTokens: 1, outputTokens: 1 },
    [turn("2026-11-06T10:00:00Z", 100, 10), turn("2026-11-03T10:00:00Z", 1000, 20), turn("2026-10-20T10:00:00Z", 5000, 50),
      turn("2026-11-06T11:00:00Z", "unreadable", 600)]));
  assert.deepEqual(p.grokRecent(home, now), { day: 110, dayOutput: 10, week: 1130, weekOutput: 30 });
});

test("protobuf reader: nested fields, and malformed input throws", () => {
  const f = p.protoFields(Buffer.concat([vfield(2, 300), lfield(4, vfield(1, 7))]));
  assert.equal(f.get(2)[0], 300);
  assert.equal(p.protoFields(f.get(4)[0]).get(1)[0], 7);
  assert.throws(() => p.protoFields(Buffer.from([0x22, 0x05, 0x01])), /truncated/);
  assert.deepEqual(p.agyCallTokens(callBlob({ input: 2487, output: 87, cache: 16300, thinking: 18 })), { input: 2487, cacheRead: 16300, cacheWrite: 0, output: 87 });
  assert.equal(p.agyCallTokens(lfield(1, vfield(3, 1))), undefined);
  assert.deepEqual(p.agyWorkspaces(workspaceBlob(path.join(tmp, "a b"))), [path.join(tmp, "a b")]);
});

test("Antigravity card: conversations naming the card's worktree, summed per call", { skip: (() => { try { require("node:sqlite"); return false; } catch { return "no node:sqlite"; } })() }, () => {
  const { DatabaseSync } = require("node:sqlite");
  const dir = path.join(p.AGY_DIR, "conversations"), wt = path.join(tmp, "agy wt");
  assert.equal(p.AGY_DIR, path.join(tmp, ".gemini", "antigravity-cli"));
  fs.mkdirSync(dir, { recursive: true });
  const conversation = (name, workspace, calls) => {
    const db = new DatabaseSync(path.join(dir, name + ".db"));
    db.exec("CREATE TABLE trajectory_metadata_blob (id text DEFAULT 'main', data blob, PRIMARY KEY (id)); CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))");
    db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(workspaceBlob(workspace));
    calls.forEach((c, i) => db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(i, callBlob(c)));
    db.close();
  };
  // The 6 November 2026 probe: ACP reported 10631 + 10810 input and 105 + 84 output for two prompts.
  conversation("one", wt, [{ input: 10631, output: 105, thinking: 104 }, { input: 10810, output: 84, thinking: 83 }]);
  conversation("two", wt, [{ input: 200, output: 20, cache: 5000 }]);
  conversation("elsewhere", path.join(tmp, "other"), [{ input: 99999, output: 9 }]);
  { // Valid metadata, malformed protobuf and an incorrectly typed usage field.
    const db = new DatabaseSync(path.join(dir, "two.db"));
    const insert = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
    insert.run(97, lfield(1, vfield(3, 1)));
    insert.run(98, lfield(1, vfield(4, 1)));
    insert.run(99, Buffer.concat([Buffer.from([0x0f]), Buffer.from("PRIVATE_CALL_BODY")]));
    db.close();
  }
  fs.writeFileSync(path.join(dir, "unattributed.db"), "invalid SQLite");
  const m = p.antigravityMeasurement(wt, 0, false, "gemini-3.8-flash", dir);
  assert.equal(m.source, "stream");
  assert.deepEqual(m.tokens, { input: 21641, cacheRead: 5000, cacheWrite: 0, output: 209 });
  assert.deepEqual(Object.keys(m.models), ["gemini-3.8-flash"]);
  assert.equal(m.complete, false);
  assert.deepEqual(m.gaps, ["Antigravity conversation two.db has unreadable call rows: 2.", p.AGY_NO_CACHE_WRITES]);
  const clean = p.antigravityMeasurement(path.join(tmp, "other"), 0, false, "x", dir);
  assert.equal(clean.complete, true);
  assert.deepEqual(clean.gaps, [p.AGY_NO_CACHE_WRITES]);
  const task = { id: "agy", provider: "antigravity", model: "gemini-3.8-flash", status: "done", ranIn: wt };
  const collector = new UsageCollector({ dir: tmp });
  const measurement = collector.session(task);
  assert.deepEqual(measurement.tokens, m.tokens);
  assert.equal(measurement.complete, false);
  assert.doesNotMatch(JSON.stringify(measurement), /PRIVATE_CALL_BODY/);
  const [row] = modelEfficiency([{ ...task, measurement }]);
  assert.deepEqual([row.measured, row.partial, row.medianTotal], [1, 1, m.total]);
  const running = collector.session({ ...task, status: "running", worktree: wt });
  assert.equal(running.complete, false);
  assert.deepEqual(running.tokens, m.tokens);
  assert.match(running.gaps.join(" "), /still running/);
  // A card created after every conversation changed finds none of them.
  assert.equal(p.antigravityMeasurement(wt, Date.now() + 3600_000, false, "x", dir).source, "unknown");
  // A terminal run (agy --prompt-interactive) writes no workspace into its conversation: its log names the folder and the conversations.
  const root = path.dirname(dir), id = (n) => `0000000${n}-0000-4000-8000-000000000000`;
  conversation(id(1), path.join(tmp, "unnamed"), [{ input: 1000, output: 7 }]);
  conversation(id(2), path.join(tmp, "unnamed"), [{ input: 3000, output: 9 }]);
  conversation(id(3), path.join(tmp, "unnamed"), [{ input: 5000, output: 11 }]);
  for (const n of [1, 2, 3]) { const db = new DatabaseSync(path.join(dir, id(n) + ".db")); db.exec("DELETE FROM trajectory_metadata_blob"); db.close(); }
  fs.mkdirSync(path.join(root, "log"), { recursive: true });
  fs.writeFileSync(path.join(root, "log", "cli-run.log"), `I1106 manager.go:549] Initializing CLI store manager for workspace ${wt}\nI1106 server.go:1242] Created conversation ${id(1)} (backend=BACKEND_TYPE_UNSPECIFIED)\n`);
  fs.writeFileSync(path.join(root, "log", "cli-other.log"), `I1106 manager.go:549] Initializing CLI store manager for workspace ${path.join(tmp, "other")}\nI1106 server.go:1242] Created conversation ${id(3)} (backend=BACKEND_TYPE_UNSPECIFIED)\n`);
  // The newest conversation per folder, kept even when the run's log is gone.
  fs.mkdirSync(path.join(root, "cache"), { recursive: true });
  fs.writeFileSync(path.join(root, "cache", "last_conversations.json"), JSON.stringify({ [wt + path.sep]: id(2), [path.join(tmp, "other")]: id(3) }));
  assert.deepEqual(p.antigravityMeasurement(wt, 0, false, "x", dir).tokens, { input: 21641 + 1000 + 3000, cacheRead: 5000, cacheWrite: 0, output: 209 + 7 + 9 });
  for (const n of ["cli-run.log", "cli-other.log"]) fs.rmSync(path.join(root, "log", n));
  fs.rmSync(path.join(root, "cache"), { recursive: true });
  for (const n of [1, 2, 3]) for (const ext of [".db", ".db-wal", ".db-shm"]) fs.rmSync(path.join(dir, id(n) + ext), { force: true });
  const r = p.antigravityRecent(Date.now(), dir);
  assert.equal(r.day, (21441 + 189) + (200 + 5000 + 20) + (99999 + 9));
  assert.equal(r.weekOutput, 189 + 20 + 9);
});

test("Antigravity totals: active by agy's own summary times, not file times its indexer touches", { skip: (() => { try { require("node:sqlite"); return false; } catch { return "no node:sqlite"; } })() }, () => {
  const { DatabaseSync } = require("node:sqlite");
  const root = path.join(tmp, "agy-summaries"), dir = path.join(root, "conversations");
  fs.mkdirSync(dir, { recursive: true });
  const put = (name, input) => {
    const db = new DatabaseSync(path.join(dir, name + ".db"));
    db.exec("CREATE TABLE trajectory_metadata_blob (id text, data blob); CREATE TABLE gen_metadata (idx integer, data blob)");
    db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (0, ?)").run(callBlob({ input, output: 1 }));
    db.close();
  };
  put("hour", 100); put("days", 2000); put("october", 30000); put("unsummarized", 400); // every file was just written
  const db = new DatabaseSync(path.join(root, "conversation_summaries.db"));
  db.exec("CREATE TABLE conversation_summaries (conversation_id text, last_modified_time datetime NOT NULL)");
  const at = (ms) => new Date(Date.now() - ms).toISOString().replace("T", " ").replace("Z", "123456+00:00"); // agy's own format
  for (const [id, ago] of [["hour", 3600_000], ["days", 3 * 86400_000], ["october", 30 * 86400_000]]) db.prepare("INSERT INTO conversation_summaries VALUES (?, ?)").run(id, at(ago));
  db.close();
  assert.deepEqual(p.antigravityRecent(Date.now(), dir), { day: 101 + 401, dayOutput: 2, week: 101 + 401 + 2001, weekOutput: 3 });
});

test("Antigravity sign-in: the newest log that records one", () => {
  const dir = path.join(tmp, "agy-log");
  fs.mkdirSync(dir, { recursive: true });
  assert.deepEqual(p.antigravitySignIn(dir), {});
  fs.writeFileSync(path.join(dir, "cli-1.log"), "I1106 server_oauth.go:221] applyAuthResult: email=old@example.com, authMethod=consumer\n");
  fs.utimesSync(path.join(dir, "cli-1.log"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  fs.writeFileSync(path.join(dir, "acp-2.log"), "x applyAuthResult: email=a@example.com, authMethod=consumer\ny applyAuthResult: email=new@example.com, quotaProject=\n");
  // Newest, but records no sign-in: agy writes this line at startup even in sessions that then sign in.
  fs.writeFileSync(path.join(dir, "acp-3.log"), "E You are not logged into Antigravity.\n");
  assert.equal(p.antigravitySignIn(dir).email, "new@example.com");
});

test("samePath ignores a trailing separator", () => {
  assert.equal(p.samePath(tmp + path.sep, tmp), true);
  assert.equal(p.samePath(tmp, path.join(tmp, "x")), false);
});

test("model efficiency: Done cards by main model, medians, transcript output left out", () => {
  const meas = (models, source = "stream", complete = true) => {
    const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    for (const t of Object.values(models)) for (const k of Object.keys(tokens)) tokens[k] += t[k];
    return { tokens, total: tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output, complete, source, models };
  };
  const t = (input, cacheRead, output) => ({ input, cacheRead, cacheWrite: 0, output });
  const rows = modelEfficiency([
    { provider: "grok", status: "done", measurement: meas({ "grok-4.7": t(100, 900, 10) }) },
    { provider: "grok", status: "done", measurement: meas({ "grok-4.7": t(300, 700, 30) }) },
    { provider: "grok", status: "done", measurement: meas({ "grok-4.7": t(500, 500, 50) }) },
    { provider: "grok", status: "review", measurement: meas({ "grok-4.7": t(1, 1, 1) }) }, // not finished
    { status: "done", ended: true, measurement: meas({ opus: t(1, 1, 1) }) }, // a found session that closed
    { provider: "grok", status: "done", discarded: true, measurement: meas({ "grok-4.7": t(1, 1, 1) }) }, // thrown away: its work never landed
    { status: "done", model: "opus", measurement: meas({ "claude-opus-5-5": t(2000, 8000, 0), "claude-haiku-5-5": t(10, 0, 0) }, "transcript", false) },
    { provider: "antigravity", status: "done", model: "gemini-3.8-flash", measurement: { tokens: t(0, 0, 0), complete: false, source: "unknown", models: {} } },
  ]);
  assert.deepEqual(rows, [
    { provider: "antigravity", model: "gemini-3.8-flash", finished: 1, measured: 0, partial: 0, medianTotal: undefined, medianFresh: undefined, medianOutput: undefined,
      attempts: 1, passed: 0, failed: 0, unverified: 1, perPassed: undefined, freshPerPassed: undefined, medianFollowUps: 0, fewCards: true },
    { provider: "claude", model: "claude-opus-5-5", finished: 1, measured: 1, partial: 1, medianTotal: 10010, medianFresh: 2010, medianOutput: undefined,
      attempts: 1, passed: 0, failed: 0, unverified: 1, perPassed: undefined, freshPerPassed: undefined, medianFollowUps: 0, fewCards: true },
    // The discarded grok card is an attempt (failed), but not finished and not in the medians.
    { provider: "grok", model: "grok-4.7", finished: 3, measured: 3, partial: 0, medianTotal: 1030, medianFresh: 330, medianOutput: 30,
      attempts: 4, passed: 0, failed: 1, unverified: 3, perPassed: undefined, freshPerPassed: undefined, medianFollowUps: 0, fewCards: true },
  ]);
});
