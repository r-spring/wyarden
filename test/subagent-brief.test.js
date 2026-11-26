const test = require("node:test");
const assert = require("node:assert/strict");
const { brief, todoFeatures, RULES } = require("../hook/subagent-brief.js");
const TABLE = "| ID | Feature | windows | linux |\n|---|---|---|---|\n| F01 | Board columns | done 3433c10 | done 3433c10 |\n| F93 | Grok tokens | todo (check: a Grok card) | done 5feec9b |\n| F96 | Scoped sub-agents | todo | todo |\n";
const fakeRun = (answers) => (file, args) => { const key = [file, ...args].join(" "); if (!(key in answers)) throw new Error(key); return answers[key]; };
const ANSWERS = {
  "git branch --show-current": "task/134e48",
  "git rev-parse --short HEAD": "f5f7969",
  "git rev-parse --short origin/main": "f2b5b6f",
  "git rev-list --count HEAD..origin/main": "3",
  "node tools/parity.js --status": TABLE,
};
test("todo features per side", () => {
  assert.deepEqual(todoFeatures(TABLE, "windows"), ["F93", "F96"]);
  assert.deepEqual(todoFeatures(TABLE, "linux"), ["F96"]);
});
test("brief lists the worktree facts and the rules", () => {
  const text = brief({ agent_type: "ab-mapper", cwd: "/w/wt/134e48" }, fakeRun(ANSWERS), "linux");
  assert.match(text, /^Worktree: \/w\/wt\/134e48$/m);
  assert.match(text, /^Branch: task\/134e48 at f5f7969; origin\/main f2b5b6f, 3 commits ahead of you$/m);
  assert.match(text, /^Machine: linux; parity todo here: F96$/m);
  assert.match(text, /^Evidence folder today: docs\/evidence\/parity-linux-\d{4}-\d{2}-\d{2}\/ \((exists|absent)\)$/m);
  for (const rule of RULES) assert.ok(text.includes(rule));
  const one = brief({ agent_type: "ab-mapper", cwd: "/w" }, fakeRun({ ...ANSWERS, "git rev-list --count HEAD..origin/main": "1" }), "linux");
  assert.match(one, /^Branch: task\/134e48 at f5f7969; origin\/main f2b5b6f, 1 commit ahead of you$/m);
});
test("a failing command leaves a gap, not a crash", () => {
  const text = brief({ agent_type: "ab-reviewer", cwd: "/w" }, fakeRun({}), "windows");
  assert.match(text, /^Branch: unknown$/m);
  assert.match(text, /^Machine: windows; parity todo here: unknown$/m);
});
test("Windows names the parity-win- evidence folder, as every existing Windows folder is named", () => {
  const text = brief({ agent_type: "ab-parity-checker", cwd: "/w" }, fakeRun(ANSWERS), "windows");
  assert.match(text, /^Machine: windows; parity todo here: F93, F96$/m);
  assert.match(text, /^Evidence folder today: docs\/evidence\/parity-win-\d{4}-\d{2}-\d{2}\/ \((exists|absent)\)$/m);
});
test("only ab- agents get a brief", () => {
  assert.equal(brief({ agent_type: "general-purpose", cwd: "/w" }, fakeRun(ANSWERS), "linux"), undefined);
  assert.equal(brief({ cwd: "/w" }, fakeRun(ANSWERS), "linux"), undefined);
});
