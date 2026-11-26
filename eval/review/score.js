// Scores one results.json from run.js --live (eval/review/README.md). Prints the report and saves score.md beside results.json.
// Usage: node eval/review/score.js <results.json>
"use strict";
const fs = require("fs");
const path = require("path");

const LABEL = { done: "Done", "not-done": "Not done", unsure: "Unsure" };
const VERDICTS = Object.keys(LABEL);
const rate = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");

/** results = { run, promptVersion, model, effort, repeat, results: [{ case, repeat, expected, expectedStatuses?, verdict, statuses } | { case, repeat, expected, error }] } */
function score(results) {
  const all = results.results, ok = all.filter((r) => VERDICTS.includes(r.verdict)), failed = all.length - ok.length;
  const hard = ok.filter((r) => r.expected !== "done"), soft = ok.filter((r) => r.expected === "done");
  const falseDone = hard.filter((r) => r.verdict === "done"), falseNot = soft.filter((r) => r.verdict === "not-done");
  const unsure = ok.filter((r) => r.verdict === "unsure");
  const byCase = new Map();
  for (const r of ok) byCase.set(r.case, [...(byCase.get(r.case) ?? []), r.verdict]);
  const repeated = [...byCase.values()].filter((v) => v.length >= 2), flips = repeated.filter((v) => new Set(v).size > 1);
  const withOther = ok.filter((r) => r.expectOther);
  const agree = []; // agree[i] = [matches, total] for condition i + 1
  for (const r of ok) (r.expectedStatuses ?? []).forEach((s, i) => { agree[i] ??= [0, 0]; agree[i][1]++; if (r.statuses?.[i] === s) agree[i][0]++; });
  const lines = [`# Review evaluation: ${results.run}`, "",
    `Prompt version: ${results.promptVersion}. Model: ${results.model}. Effort: ${results.effort}. Repeats: ${results.repeat}.`, "",
    `False Done: ${falseDone.length} of ${hard.length} runs expected Not done or Unsure (${rate(falseDone.length, hard.length)})`,
    ...falseDone.map((r) => `  - ${r.case} (repeat ${r.repeat}, expected ${LABEL[r.expected]})`),
    `False Not done: ${falseNot.length} of ${soft.length} runs expected Done (${rate(falseNot.length, soft.length)})`,
    ...falseNot.map((r) => `  - ${r.case} (repeat ${r.repeat})`),
    `Unsure: ${unsure.length} of ${ok.length} runs (${rate(unsure.length, ok.length)})`,
    `Flips: ${flips.length} of ${repeated.length} cases with 2 or more repeats (${rate(flips.length, repeated.length)})`,
    ...(withOther.length ? [`Reported in other: ${withOther.filter((r) => String(r.other ?? "").trim()).length} of ${withOther.length} runs of cases that plant text for the reviewer to report`] : []),
    `Failed runs: ${failed} of ${all.length}, left out of every rate above`, "",
    "Agreement with the expected statuses, per condition (position in the Done when):",
    ...(agree.length ? agree.map(([n, d], i) => `- condition ${i + 1}: ${n} of ${d} agree (${rate(n, d)})`) : ["- no case lists expected statuses"]), "",
    "Expected against returned verdict (runs):", "", "| | returned Done | returned Not done | returned Unsure |", "|---|---|---|---|",
    ...VERDICTS.map((e) => `| expected ${LABEL[e]} | ${VERDICTS.map((v) => ok.filter((r) => r.expected === e && r.verdict === v).length).join(" | ")} |`), ""];
  return lines.join("\n");
}

module.exports = { score };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node eval/review/score.js <results.json>"); process.exit(2); }
  const text = score(JSON.parse(fs.readFileSync(file, "utf8")));
  fs.writeFileSync(path.join(path.dirname(file), "score.md"), text);
  process.stdout.write(text);
}
