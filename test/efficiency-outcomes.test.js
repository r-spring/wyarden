// Tokens per passed task (plan f56b1d step 1): outcomeOf and the outcome fields of modelEfficiency (F93). Fake cards only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { outcomeOf, modelEfficiency } = require("../out/efficiency.js");

// A measurement of one model with the given token counts.
const meas = (input, cacheRead, cacheWrite, output, model = "m1") => {
  const tokens = { input, cacheRead, cacheWrite, output };
  return { tokens, total: input + cacheRead + cacheWrite + output, complete: true, source: "stream", models: { [model]: tokens } };
};
const card = (extra) => ({ provider: "claude", status: "done", ...extra });

test("outcomeOf: each rule, in order", () => {
  assert.equal(outcomeOf({ status: "review" }), undefined);
  assert.equal(outcomeOf({ status: "review", checks: { status: "complete" } }), undefined);
  assert.equal(outcomeOf({ status: "done", ended: true, checks: { status: "complete" } }), undefined);
  assert.equal(outcomeOf({ status: "done", ended: true, discarded: true }), undefined);
  assert.equal(outcomeOf({ status: "done", discarded: true }), "failed");
  assert.equal(outcomeOf({ status: "done", discarded: true, checks: { status: "complete" } }), "failed"); // discard beats passed checks
  assert.equal(outcomeOf({ status: "done", discarded: true, doneReview: { verdict: "done" } }), "failed");
  assert.equal(outcomeOf({ status: "done", checks: { status: "error" } }), "failed");
  assert.equal(outcomeOf({ status: "done", checks: { status: "error" }, doneReview: { verdict: "done" } }), "failed"); // errored checks beat the review
  assert.equal(outcomeOf({ status: "done", checks: { status: "complete" } }), "passed");
  assert.equal(outcomeOf({ status: "done", checks: { status: "running" }, doneReview: { verdict: "done" } }), "passed");
  assert.equal(outcomeOf({ status: "done", doneReview: { verdict: "done" } }), "passed");
  assert.equal(outcomeOf({ status: "done", doneReview: { verdict: "not done" } }), "unverified");
  assert.equal(outcomeOf({ status: "done", checks: { status: "running" } }), "unverified");
  assert.equal(outcomeOf({ status: "done" }), "unverified");
});

test("modelEfficiency: a discarded card counts in perPassed, not in finished or the medians", () => {
  const [row] = modelEfficiency([
    card({ checks: { status: "complete" }, measurement: meas(100, 800, 0, 100) }), // 1000 total, 200 fresh
    card({ discarded: true, checks: { status: "complete" }, measurement: meas(1000, 3000, 0, 0) }), // 4000 total, 1000 fresh
  ]);
  assert.equal(row.finished, 1);
  assert.equal(row.measured, 1);
  assert.equal(row.medianTotal, 1000);
  assert.equal(row.medianFresh, 200);
  assert.equal(row.attempts, 2);
  assert.equal(row.passed, 1);
  assert.equal(row.failed, 1);
  assert.equal(row.unverified, 0);
  assert.equal(row.perPassed, 5000);
  assert.equal(row.freshPerPassed, 1200);
});

test("modelEfficiency: perPassed divides by passes, counts unverified tokens and rounds; unmeasured attempts add nothing", () => {
  const [row] = modelEfficiency([
    card({ doneReview: { verdict: "done" }, measurement: meas(1, 0, 0, 0) }),
    card({ checks: { status: "complete" }, measurement: meas(1, 0, 0, 0) }),
    card({ checks: { status: "complete" }, measurement: meas(1, 0, 0, 0) }),
    card({ measurement: meas(1, 0, 0, 0) }), // unverified, still charged
    card({ checks: { status: "error" }, model: "m1" }), // failed, not measured
  ]);
  assert.equal(row.attempts, 5);
  assert.deepEqual([row.passed, row.failed, row.unverified], [3, 1, 1]);
  assert.equal(row.perPassed, 1); // 4 / 3 rounded
  assert.equal(row.freshPerPassed, 1);
});

test("modelEfficiency: perPassed undefined with no passes or no measured attempt", () => {
  const [none] = modelEfficiency([card({ measurement: meas(10, 0, 0, 0) }), card({ checks: { status: "error" }, measurement: meas(10, 0, 0, 0) })]);
  assert.equal(none.passed, 0);
  assert.equal(none.perPassed, undefined);
  assert.equal(none.freshPerPassed, undefined);
  const [unmeasured] = modelEfficiency([card({ model: "m1", checks: { status: "complete" } })]);
  assert.equal(unmeasured.passed, 1);
  assert.equal(unmeasured.perPassed, undefined);
  assert.equal(unmeasured.freshPerPassed, undefined);
});

test("modelEfficiency: fewCards on either side of 5 measured attempts", () => {
  const four = Array.from({ length: 4 }, () => card({ measurement: meas(1, 0, 0, 0) }));
  // Four measured plus an unmeasured one: still too few.
  assert.equal(modelEfficiency([...four, card({ model: "m1" })])[0].fewCards, true);
  assert.equal(modelEfficiency(four)[0].fewCards, true);
  // A discarded measured attempt counts toward the five.
  assert.equal(modelEfficiency([...four, card({ discarded: true, measurement: meas(1, 0, 0, 0) })])[0].fewCards, false);
  assert.equal(modelEfficiency([...four, card({ measurement: meas(1, 0, 0, 0) }), card({ measurement: meas(1, 0, 0, 0) })])[0].fewCards, false);
});

test("modelEfficiency: medianFollowUps over attempts, unset as 0", () => {
  const [odd] = modelEfficiency([card({ followUps: 4, model: "m1" }), card({ model: "m1" }), card({ followUps: 1, discarded: true, model: "m1" })]);
  assert.equal(odd.medianFollowUps, 1);
  const [even] = modelEfficiency([card({ followUps: 2, model: "m1" }), card({ followUps: 5, model: "m1" })]);
  assert.equal(even.medianFollowUps, 3.5);
});

test("modelEfficiency: a group of only discarded cards still gets a row", () => {
  const rows = modelEfficiency([
    card({ provider: "codex", discarded: true, measurement: meas(10, 20, 0, 5, "gpt-x") }),
    card({ provider: "codex", discarded: true, ended: true, measurement: meas(10, 20, 0, 5, "gpt-x") }), // not an attempt
  ]);
  assert.deepEqual(rows, [{
    provider: "codex", model: "gpt-x", finished: 0, measured: 0, partial: 0, medianTotal: undefined, medianFresh: undefined, medianOutput: undefined,
    attempts: 1, passed: 0, failed: 1, unverified: 0, perPassed: undefined, freshPerPassed: undefined, medianFollowUps: 0, fewCards: true,
  }]);
});
