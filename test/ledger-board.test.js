// Tokens per passed task in the ledger tools (plan f56b1d step 3): ledger.js compare --board and prompt-outcomes.js read a board
// folder's tasks.json and measurements/<id>.json and print modelEfficiency's outcome fields.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const LEDGER = path.join(__dirname, "..", "tools", "ledger.js"), OUTCOMES = path.join(__dirname, "..", "tools", "prompt-outcomes.js");
const made = [];
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-ledger-board-")); made.push(d); return d; };
const run = (script, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

const tokens = (input, cacheRead, cacheWrite, output) => ({ input, cacheRead, cacheWrite, output });
const measurement = (id, model, t, extra = {}) => ({ version: 1, taskId: id, sessionId: `s-${id}`, account: "a", tokens: t, complete: true, source: "ledger", models: { [model]: t }, ...extra });

/** A board folder: Opus has one pass, one discard and one unmeasured card; Codex has no pass. */
function board() {
  const dir = tmp();
  const tasks = [
    { id: "c1", prompt: "Pass it.", provider: "claude", model: "claude-opus-5-5", status: "done", checks: { status: "complete" }, followUps: 2 },
    { id: "c2", prompt: "Throw it away.", provider: "claude", model: "claude-opus-5-5", status: "done", discarded: true, checks: { status: "complete" } },
    { id: "c3", prompt: "Nobody checked.", provider: "claude", model: "claude-opus-5-5", status: "done", followUps: 1 }, // no measurement file
    { id: "c4", prompt: "Codex try.", provider: "codex", model: "gpt-6-astra", status: "done" },
    { id: "c5", prompt: "Codex broke.", provider: "codex", model: "gpt-6-astra", status: "done", checks: { status: "error" } }, // unreadable file
    { id: "c6", prompt: "Still going.", provider: "claude", model: "claude-opus-5-5", status: "running" },
    { id: "c7", prompt: "Unknown source.", provider: "claude", model: "claude-opus-5-5", status: "done", checks: { status: "complete" } },
  ];
  fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify(tasks));
  const m = path.join(dir, "measurements");
  fs.mkdirSync(m);
  fs.writeFileSync(path.join(m, "c1.json"), JSON.stringify(measurement("c1", "claude-opus-5-5", tokens(1000, 90000, 5000, 4000))));
  fs.writeFileSync(path.join(m, "c2.json"), JSON.stringify(measurement("c2", "claude-opus-5-5", tokens(500, 45000, 2500, 2000))));
  fs.writeFileSync(path.join(m, "c4.json"), JSON.stringify(measurement("c4", "gpt-6-astra", tokens(3000, 0, 0, 1000))));
  fs.writeFileSync(path.join(m, "c5.json"), "{half written");
  fs.writeFileSync(path.join(m, "c6.json"), JSON.stringify(measurement("c6", "claude-opus-5-5", tokens(9e6, 0, 0, 0))));
  fs.writeFileSync(path.join(m, "c7.json"), JSON.stringify(measurement("c7", "claude-opus-5-5", tokens(7e6, 0, 0, 0), { source: "unknown" })));
  return { dir, tasks };
}

test("compare --board prints passed/attempts and tokens per passed task per model; discards count, unmeasured cards do not", () => {
  const { dir } = board();
  const r = run(LEDGER, "compare", "--board", dir);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split(/\r?\n/);
  assert.match(lines[0], /^provider\tmodel\tpassed\ttokens\/passed/);
  // Opus: c1 passed, c2 discarded (failed, its 50k counts), c3 unverified with no file, c7 passed but unmeasured (source unknown):
  // (100k + 50k) / 2 passes = 75k, 7.5k without cache reads; c6 is not Done.
  assert.ok(lines.includes("claude\tclaude-opus-5-5\t2/4 passed\t75k\t7.5k\t0.5\ttoo few to compare"), r.stdout);
  // Codex: no pass gives "-", never 0; c5's unreadable measurement is unmeasured, not an error.
  assert.ok(lines.includes("codex\tgpt-6-astra\t0/2 passed\t-\t-\t0\ttoo few to compare"), r.stdout);
  assert.equal(lines.length, 3);
});

test("compare --board fails with one line on a folder without tasks.json; compare without --board still needs --since", () => {
  const r = run(LEDGER, "compare", "--board", tmp());
  assert.equal(r.status, 1);
  assert.match(r.stderr.trim(), /^no tasks\.json in .+$/);
  const s = spawnSync(process.execPath, [LEDGER, "compare"], { encoding: "utf8", env: { ...process.env, ENTOMATICAL_LEDGER_DIR: tmp() } });
  assert.equal(s.status, 1);
  assert.match(s.stderr, /compare needs --since/);
});

test("prompt-outcomes --json gives each prompt-source group its outcomes and tokens per passed task", () => {
  const { dir, tasks } = board();
  const create = (t, source, edited) => ({ at: "2026-11-14", event: "create", task: null, promptSha256: sha(t.prompt), chars: t.prompt.length, source,
    helpers: source === "raw" ? [] : [{ kind: source, edited }] });
  const by = Object.fromEntries(tasks.map((t) => [t.id, t]));
  fs.writeFileSync(path.join(dir, "provenance.jsonl"), [create(by.c1, "raw"), create(by.c2, "raw"), create(by.c3, "raw"), create(by.c6, "raw"),
    create(by.c4, "improve", false)].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const r = run(OUTCOMES, "--board", dir, "--json");
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const raw = out.groups.raw, improved = out.groups["improve, applied as is"];
  assert.deepEqual([raw.passed, raw.failed, raw.unverified, raw.perPassed], [1, 1, 1, 150000]); // the discard's tokens count; c6 is not Done
  assert.deepEqual([improved.passed, improved.failed, improved.unverified, improved.perPassed], [0, 0, 1, null]);
  assert.deepEqual(out.rows.map((x) => [x.task, x.outcome, x.tokens]), [["c1", "passed", 100000], ["c2", "failed", 50000], ["c3", "unverified", null],
    ["c6", null, null], ["c4", "unverified", 4000]]);
  const table = run(OUTCOMES, "--board", dir);
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /\| raw \| 4 \| 4 \|.*\| 1 \| 1 \| 1 \| 150k \|/);
  assert.match(table.stdout, /\| improve, applied as is \|.*\| 0 \| 0 \| 1 \| - \|/);
});

test("prompt-outcomes resolves an ID-less prefix only when unique and never substitutes for a missing ID", () => {
  const { dir, tasks } = board();
  tasks[1].prompt = tasks[0].prompt + "\nDone when: all checks pass.";
  fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify(tasks));
  const legacy = (prompt) => ({ event: "create", chars: prompt.length, promptSha256: sha(prompt), helpers: [], source: "raw" });
  const rows = [legacy(tasks[0].prompt), legacy(tasks[2].prompt.slice(0, 6)), legacy("absent"), { ...legacy(tasks[2].prompt), task: "removed" }];
  fs.writeFileSync(path.join(dir, "provenance.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"));
  const r = run(OUTCOMES, "--board", dir, "--json");
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.rows.map((x) => [x.task, x.attribution, x.recordedTask, x.followUps, x.outcome]), [
    [null, "ambiguous legacy prefix", null, null, null], ["c3", "unique legacy prefix", null, 0, "unverified"],
    [null, "unmatched legacy prefix", null, null, null], [null, "card ID", "removed", null, null]]);
  assert.equal(report.groups.raw.matched, 1);
  assert.equal(report.groups.raw.measured, 0);
  assert.match(run(OUTCOMES, "--board", dir).stdout, /unknown \(ambiguous legacy prefix\) 1/);
});

test("prompt-outcomes counts a measured card at most once across historical and ID-bearing receipts", () => {
  const { dir, tasks } = board();
  const card = tasks[0], prefix = card.prompt.slice(0, 4);
  const legacy = (text) => ({ event: "create", task: null, promptSha256: sha(text), chars: text.length, source: "raw", helpers: [] });
  const old = legacy(card.prompt), explicit = { ...old, task: card.id };
  fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([card]));
  fs.writeFileSync(path.join(dir, "measurements", card.id + ".json"), JSON.stringify({ total: 100, tokens: {}, source: "ledger" }));
  const follow = { event: "follow-up", task: card.id };
  function check(receipts, expected) {
    fs.writeFileSync(path.join(dir, "provenance.jsonl"), [...receipts, follow].map((r) => JSON.stringify(r)).join("\n"));
    const { join, summary } = require(OUTCOMES);
    const { rows } = join(dir);
    const g = summary(rows).raw, matched = expected.filter(Boolean).length;
    assert.deepEqual(rows.map((r) => r.task), expected);
    assert.deepEqual([g.matched, g.passed, g.measured, g.tokens, g.followUps], [matched, matched, matched, matched * 100, matched]);
    return rows;
  }
  // A has left the board. B received the same prompt and its ID is recorded.
  assert.equal(check([old, explicit], [null, card.id])[0].status, "unknown (legacy prefix matches reserved ID)");
  check([explicit, old], [card.id, null]);
  check([old, old], [null, null]);
  check([old, legacy(prefix)], [null, null]);
  check([legacy(prefix), old], [null, null]);
  check([old], [card.id]);
  check([explicit], [card.id]);
  check([explicit, explicit, old], [null, null, null]);
  // A shorter prefix could belong to either card. The full text has just one candidate, but competes for it.
  fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify([card, { ...card, id: "other", prompt: prefix + " differently." }]));
  check([legacy(prefix), old], [null, null]);
  check([old, legacy(prefix)], [null, null]);
});
