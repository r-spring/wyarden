// The shared helper size limits (4 November 2026 review, item 2.4): one constant, exact boundaries, oversize output flagged and kept whole.
const test = require("node:test");
const assert = require("node:assert/strict");
const { DRAFT_LIMIT, ANSWERS_LIMIT, oversize } = require("../out/limits");
const compile = require("../out/compile");
const { generateText } = require("../out/text-actions");
const { validTaskRecord } = require("../out/task-record");

test("the limit is exact at 23,999 / 24,000 / 24,001 characters, counted in UTF-16 units as JavaScript counts them", () => {
  assert.equal(DRAFT_LIMIT, 24_000);
  assert.equal(oversize("x".repeat(23_999)), undefined);
  assert.equal(oversize("x".repeat(24_000)), undefined);
  assert.deepEqual(oversize("x".repeat(24_001)), { chars: 24_001, limit: 24_000 });
  assert.deepEqual(oversize("中".repeat(24_001)), { chars: 24_001, limit: 24_000 });
});

test("helpers refuse an oversize draft or answers before any call", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(generateText("/nonexistent", "refine", "x".repeat(DRAFT_LIMIT + 1), "", "opus", "", signal, "high"), /at most 24,000/);
  await assert.rejects(generateText("/nonexistent", "refine", "ok", "", "opus", "y".repeat(ANSWERS_LIMIT + 1), signal, "high"), /8,000/);
  await assert.rejects(compile.compileDraft("/nonexistent", "x".repeat(DRAFT_LIMIT + 1), "", "", "opus", "high", signal), /at most 24,000/);
});

test("handoff mode: the handoff text may be up to HANDOFF_LIMIT (60,000); over it Refine refuses before any call, naming the limit", async () => {
  const { HANDOFF_LIMIT } = require("../out/limits");
  assert.equal(HANDOFF_LIMIT, 60_000);
  const signal = new AbortController().signal, h = (n) => ({ path: "/r/docs/handoffs/a.md", text: "x".repeat(n) });
  const draft = (n) => `<!-- handoff: /r/docs/handoffs/a.md -->\n${"x".repeat(n)}`;
  await assert.rejects(generateText("/nonexistent", "refine", draft(HANDOFF_LIMIT + 1), "", "opus", "", signal, "high", undefined, [], "", undefined, "", h(HANDOFF_LIMIT + 1)),
    (e) => /at most 60,000 characters \(this one has 60,001\)/.test(e.message));
  await assert.rejects(generateText("/nonexistent", "refine", draft(1), "", "opus", "", signal, "high", undefined, [], "", undefined, "", h(0)), /nonempty handoff/);
  // At the limit, and far over DRAFT_LIMIT, the size check passes: the next check (the model) is what refuses here.
  await assert.rejects(generateText("/nonexistent", "refine", draft(HANDOFF_LIMIT), "", "bogus", "", signal, "high", undefined, [], "", undefined, "", h(HANDOFF_LIMIT)), /Select a model/);
  await assert.rejects(generateText("/nonexistent", "refine", draft(1), "", "opus", "y".repeat(ANSWERS_LIMIT + 1), signal, "high", undefined, [], "", undefined, "", h(1)), /8,000/);
});

test("XML escaping can push a rendered prompt past the limit: it is flagged, not cut", () => {
  const big = "<a&b> ".repeat(3_500); // 21,000 characters, about 39,000 once escaped
  const r = validTaskRecord({ version: 1, status: "ready", outcome: { goal: "Keep the markup.", deliverable: "", beneficiary: "" },
    context: { facts: [], identifiers: [], sources: [{ label: "page", content: big }], dependencies: [] }, success: { criteria: [] },
    requirements: [{ id: "R1", text: "Keep every tag.", provenance: "user", strength: "mandatory", rationale: "" }],
    permissions: { authorized: [], confirm: [], prohibited: [] }, unresolved: [], conflicts: [] });
  const text = compile.renderExecutionPrompt(r).text;
  assert.ok(big.length < DRAFT_LIMIT && text.length > DRAFT_LIMIT, `${big.length} -> ${text.length}`);
  assert.deepEqual(oversize(text), { chars: text.length, limit: DRAFT_LIMIT });
  assert.ok(text.includes("&lt;a&amp;b&gt;"), "the whole text is kept");
});
