const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const DIR = path.join(__dirname, "fixtures", "agent-roles");
const EXPECTED = {
  "ab-reviewer": { tools: "Read, Grep, Glob, Bash", model: "opus", effort: "medium", prefix: "VERDICT: " },
  "ab-fixer": { tools: "Read, Grep, Glob, Edit, Write, Bash", model: "opus", effort: "medium", prefix: "RESULT: " },
  "ab-parity-checker": { tools: "Read, Grep, Glob, Edit, Write, Bash", model: "opus", effort: "medium", prefix: "RESULT: " },
  "ab-mapper": { tools: "Read, Grep, Glob, Bash", model: "opus", effort: "medium", prefix: "RESULT: " },
  "ab-test-gate": { tools: "Bash, Read", model: "opus", effort: "low", prefix: "RESULT: " },
  "ab-host-investigator": { tools: "Read, Grep, Glob, Bash", model: "opus", effort: "medium", prefix: "VERDICT: " },
};
const frontmatter = (text) => Object.fromEntries(text.split("\n---")[0].replace(/^---\n/, "").split("\n").filter(Boolean)
  .map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
for (const [name, want] of Object.entries(EXPECTED)) {
  test(`${name} frontmatter`, () => {
    const text = fs.readFileSync(path.join(DIR, `${name}.md`), "utf8");
    const fm = frontmatter(text);
    assert.equal(fm.name, name);
    assert.equal(fm.tools, want.tools);
    assert.equal(fm.model, want.model);
    assert.equal(fm.effort, want.effort);
    assert.ok(fm.description.length > 40, "description tells the orchestrator when to use it");
    assert.ok(text.includes(`"${want.prefix}`), `body names the reply prefix ${want.prefix}`);
  });
}
// the user, 11 November 2026: a sub-agent runs on Opus; never Sonnet or a Fable model. The medium effort cap was lifted on 12 November
// 2026, so any Opus effort is allowed.
test("every ab-* agent runs on Opus at an Opus effort", () => {
  const files = fs.readdirSync(DIR).filter((f) => /^ab-.*\.md$/.test(f));
  assert.ok(files.length >= 6, "found the ab-* agent files");
  for (const file of files) {
    const fm = frontmatter(fs.readFileSync(path.join(DIR, file), "utf8").replace(/\r\n/g, "\n"));
    assert.equal(fm.model, "opus", `${file} model`);
    assert.ok(["low", "medium", "high", "xhigh", "max"].includes(fm.effort), `${file} effort is ${fm.effort}`);
  }
});
test("mapper and test-gate omit CLAUDE.md", () => {
  for (const name of ["ab-mapper", "ab-test-gate"]) assert.equal(frontmatter(fs.readFileSync(path.join(DIR, `${name}.md`), "utf8")).omitClaudeMd, "true");
  for (const name of ["ab-reviewer", "ab-fixer", "ab-parity-checker", "ab-host-investigator"]) assert.equal(frontmatter(fs.readFileSync(path.join(DIR, `${name}.md`), "utf8")).omitClaudeMd, undefined, name);
});
test("read-only agents have no Edit or Write", () => {
  for (const name of ["ab-reviewer", "ab-mapper", "ab-test-gate", "ab-host-investigator"]) assert.doesNotMatch(frontmatter(fs.readFileSync(path.join(DIR, `${name}.md`), "utf8")).tools, /Edit|Write/);
});
test("agent bodies agree with receipt-gate FORMATS and agent-fence READ_ONLY", () => {
  const { FORMATS } = require("../hook/receipt-gate.js");
  const { READ_ONLY } = require("../hook/agent-fence.js");
  const names = Object.keys(EXPECTED);
  const text = (name) => fs.readFileSync(path.join(DIR, `${name}.md`), "utf8");
  for (const name of names) {
    assert.equal(Number(text(name).match(/at most (\d+) lines/)?.[1]), FORMATS[name].lines, `${name} cap`);
    assert.ok(text(name).includes(`"${FORMATS[name].prefix}`), `${name} prefix`);
  }
  assert.deepEqual([...READ_ONLY].sort(), names.filter((n) => !/Edit|Write/.test(frontmatter(text(n)).tools)).sort());
});
