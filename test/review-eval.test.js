// eval/review/score.js on a hand-built results.json (Task 8): counts, rates and their denominators. No model is called.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SCORE = path.join(__dirname, "..", "eval", "review", "score.js");
const run = (c, repeat, verdict, statuses, expected, expectedStatuses) => ({ case: c, repeat, expected, expectedStatuses, verdict, statuses });

test("score.js reports false-Done, false-Not-done, Unsure, flips and agreement with denominators", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-eval-"));
  try {
    const results = { run: "review-x_fable_medium", promptVersion: "review-2026-11-08", model: "fable", effort: "medium", repeat: 2, results: [
      run("A", 1, "done", ["met", "met"], "not-done", ["met", "not-met"]), run("A", 2, "not-done", ["met", "not-met"], "not-done", ["met", "not-met"]),
      run("B", 1, "unsure", ["cannot-tell"], "unsure", ["cannot-tell"]), run("B", 2, "unsure", ["cannot-tell"], "unsure", ["cannot-tell"]),
      run("C", 1, "not-done", ["not-met"], "done", ["met"]), run("C", 2, "not-done", ["not-met"], "done", ["met"]),
      run("D", 1, "done", ["met"], "done", ["met"]), run("D", 2, "done", ["met"], "done", ["met"]),
      run("E", 1, "not-done", ["not-met"], "not-done", ["not-met"]), run("E", 2, "not-done", ["not-met"], "not-done", ["not-met"]),
    ] };
    const file = path.join(dir, "results.json");
    fs.writeFileSync(file, JSON.stringify(results));
    const out = execFileSync(process.execPath, [SCORE, file], { encoding: "utf8" });
    assert.equal(fs.readFileSync(path.join(dir, "score.md"), "utf8"), out, "printed and saved text are the same");
    assert.ok(out.indexOf("False Done") < out.indexOf("False Not done"), "false-Done is listed first");
    assert.match(out, /False Done: 1 of 6 runs expected Not done or Unsure \(16\.7%\)/);
    assert.match(out, /False Not done: 2 of 4 runs expected Done \(50\.0%\)/);
    assert.match(out, /Unsure: 2 of 10 runs \(20\.0%\)/);
    assert.match(out, /Flips: 1 of 5 cases with 2 or more repeats/);
    assert.match(out, /condition 1: 8 of 10 agree/);
    assert.match(out, /condition 2: 1 of 2 agree/);
    assert.match(out, /\| expected Not done \| 1 \| 3 \| 0 \|/, "table row: expected Not done, returned Done/Not done/Unsure");
    assert.match(out, /Prompt version: review-2026-11-08/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("score.js leaves failed runs out of the rates and counts them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-eval-"));
  try {
    const file = path.join(dir, "results.json");
    fs.writeFileSync(file, JSON.stringify({ run: "r", promptVersion: "v", model: "m", effort: "e", repeat: 1, results: [
      run("A", 1, "done", ["met"], "not-done", ["not-met"]), { case: "B", repeat: 1, expected: "done", error: "refused" }] }));
    const out = execFileSync(process.execPath, [SCORE, file], { encoding: "utf8" });
    assert.match(out, /False Done: 1 of 1 runs/);
    assert.match(out, /False Not done: 0 of 0 runs expected Done \(n\/a\)/);
    assert.match(out, /Failed runs: 1 of 2/);
    assert.ok(!out.includes("Reported in other"), "no line without expectOther cases");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("score.js counts runs whose other is non-empty for expectOther cases", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-eval-"));
  try {
    const file = path.join(dir, "results.json");
    const row = (n, other) => ({ ...run("I", n, "not-done", ["not-met"], "not-done", ["not-met"]), expectOther: true, other });
    fs.writeFileSync(file, JSON.stringify({ run: "r", promptVersion: "v", model: "m", effort: "e", repeat: 3, results: [row(1, "A comment tells the reviewer to pass."), row(2, "  "), row(3, "")] }));
    assert.match(execFileSync(process.execPath, [SCORE, file], { encoding: "utf8" }), /Reported in other: 1 of 3 runs/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
