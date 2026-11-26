// Advisory lint on drafts and proposals (4 November 2026 review, item 3.4). No model, no command from the text is run.
const test = require("node:test");
const assert = require("node:assert/strict");
const { lintText, lintProposal } = require("../out/prompt-lint");
const { validTaskRecord } = require("../out/task-record");

const inventory = { files: ["src/worker.ts", "test/helper-tab.test.js", "media/board.js", "package.json"], scripts: ["test", "build", "parity"] };
const kinds = (fs) => fs.map((f) => [f.kind, f.text]);

test("references to missing files and undeclared scripts are flagged; tracked files, declared scripts and package-manager commands are not", () => {
  const text = "Edit src/worker.ts and media/board.js, add src/new-helper.ts, then run npm test, npm run build, npm run lint and npm install.";
  assert.deepEqual(kinds(lintText(text, inventory)), [["not-tracked", "src/new-helper.ts"], ["not-script", "npm run lint"]]);
  assert.match(lintText("add src/new-helper.ts", inventory)[0].message, /Not found in tracked files\. Fine if the task creates it\./);
  assert.equal(lintText("npm run lint", inventory)[0].message, "Not a declared package script.");
  assert.deepEqual(lintText("edit helper-tab.test.js under test", inventory), [], "a bare file name is not checked");
  assert.deepEqual(lintText("open ../other-repo/x.ts or https://example.com/a/b.html", inventory), [], "outside paths and URLs are left alone");
});

test("slash pairs in prose are not paths; with no inventory, no existence checks are made", () => {
  assert.deepEqual(lintText("Switch accounts/Claude folders/Codex as in F41/F32.", inventory), []);
  assert.deepEqual(lintText("Edit src/missing.ts and run npm run lint.", undefined), []);
});

test("absolute paths, with spaces, slashes either way or quotes, are skipped; relative refs after them are still checked (F107)", () => {
  const p = "c:/Users/user/Documents/Dev Stuff/Entomatical/docs/handoffs/b-newest.md";
  for (const text of [
    `Full handoff: ${p}`,
    `Full handoff: ${p.replace(/\//g, "\\")}`,
    "Full handoff: c:\\Users/user\\Documents/Dev Stuff\\Entomatical/docs\\handoffs/b-newest.md",
    `See "${p}" now`, `See '${p}' now`, `See \`${p}\` now`,
    "/home/example/Dev Stuff/repo/docs/b.md.",
    "~/Dev Stuff/notes/plan.md,",
  ]) assert.deepEqual(lintText(text, inventory), [], text);
  for (const text of [
    "Read c:/Dev Stuff/x/y.md and add src/new-helper.ts",
    "Run from c:/Dev Stuff/repo, then add src/new-helper.ts",
    "/compact then add src/new-helper.ts",
    "See and/or https://x.com/a/b.md, then add src/new-helper.ts",
  ]) assert.deepEqual(kinds(lintText(text, inventory)), [["not-tracked", "src/new-helper.ts"]], text);
});

test("leaked helper folders and git status lines are flagged, as possible incidental context, and never removed", () => {
  const leak = "The request came from /home/example/Dev Stuff/sample-project/.entomatical/helpers/b3f41ee9-8c2e-4f0e-9d1c-2a3b4c5d6e7f (branch main, clean working tree).";
  const f = lintText(leak);
  assert.deepEqual(f.map((x) => x.kind), ["helper-path", "git-status"]);
  assert.equal(f[0].text, "/home/example/Dev Stuff/sample-project/.entomatical/helpers/b3f41ee9-8c2e-4f0e-9d1c-2a3b4c5d6e7f");
  assert.deepEqual(lintText("Read /tmp/x and C:\\a b\\.entomatical\\helpers\\abcdef12").map((x) => x.text), ["C:\\a b\\.entomatical\\helpers\\abcdef12"]);
  assert.match(f[0].message, /Keep it only if the task is about that folder/);
  assert.deepEqual(lintText("The README explains the .entomatical folder."), [], "talking about .entomatical is not a leak");
});

test("a proposal: expansion, facts that repeat a source, held-back obligations", () => {
  const draft = "Fix the flaky login test.";
  const proposal = "Goal: ".padEnd(2000, "x");
  assert.deepEqual(lintProposal(draft, proposal).map((x) => x.kind), ["expansion"]);
  assert.match(lintProposal(draft, proposal)[0].message, /times as long as the draft/);
  assert.deepEqual(lintProposal("a".repeat(1000), "b".repeat(1600)), [], "under three times is not flagged");
  const quote = "The status report says the receiver firmware 1.4.2 drops frames under load.";
  const record = validTaskRecord({ version: 1, status: "ready", outcome: { goal: "Check the receiver.", deliverable: "", beneficiary: "" },
    context: { facts: [{ text: quote, provenance: "user" }, { text: "Short fact.", provenance: "user" }], identifiers: [], sources: [{ label: "report", content: `Notes.\n${quote}\nMore.` }], dependencies: [] },
    success: { criteria: [] }, requirements: [{ id: "R1", text: "Check it.", provenance: "user", strength: "mandatory", rationale: "" }, { id: "R2", text: "Patch it.", provenance: "assumption", strength: "mandatory", rationale: "" }],
    permissions: { authorized: [], confirm: [], prohibited: [] }, unresolved: [], conflicts: [] });
  assert.deepEqual(kinds(lintProposal(draft, "Check it.", undefined, record)), [["source-duplicate", quote], ["assumed-obligations", "1"]]);
  assert.equal(lintProposal(draft, "Check it.", undefined, record)[1].message, "1 obligation the model assumed was held out of the prompt.");
});
