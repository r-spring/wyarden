// Label collisions and meaning-level tampering (4 November 2026 review, item 2.3; both reviewers reproduced the collisions in round 1).
// A valid record must render and parse back whole; a rendering that keeps every word but changes a permission category, a requirement
// strength, a check's coverage or an unresolved state must fail the preservation check, in XML, Markdown and prose.
const test = require("node:test");
const assert = require("node:assert/strict");
const compile = require("../out/compile");
const { preservationCheck, parseXml, parseMarkdown } = require("../out/compile-check");
const { validTaskRecord, executorView } = require("../out/task-record");
const { normalisedView } = require("../out/compile-check");

const base = () => ({ version: 1, status: "ready", outcome: { goal: "Tidy the module headers.", deliverable: "", beneficiary: "" },
  context: { facts: [], identifiers: [], sources: [], dependencies: [] }, success: { criteria: [] }, requirements: [],
  permissions: { authorized: [], confirm: [], prohibited: [] }, unresolved: [], conflicts: [] });
const ok = { ok: true, missing: [], extra: [] };
const xml = (r) => ({ format: "xml", text: compile.renderXml(r) }), md = (r) => ({ format: "markdown", text: compile.renderMarkdown(r) });
const prose = (r) => ({ format: "prose", text: compile.renderProse(r) });

test("a requirement whose text contains ' Rationale: ' keeps its text and its rationale apart", () => {
  const r = base();
  r.requirements = [{ id: "R1", text: "Show the sentence Rationale: preserve it verbatim.", provenance: "user", strength: "mandatory", rationale: "The docs quote it." },
    { id: "R2", text: "Keep Rationale: as a heading word.", provenance: "user", strength: "preference", rationale: "" }];
  r.success.criteria = [{ id: "A1", text: "The sentence appears.", provenance: "user", covers: ["R1"] }];
  const record = validTaskRecord(r);
  for (const rendered of [xml(record), md(record)]) assert.deepEqual(preservationCheck(record, rendered), ok, rendered.format);
  const parsed = parseXml(compile.renderXml(record)).requirements;
  assert.deepEqual(parsed.map((q) => [q.text, q.rationale]), [["Show the sentence Rationale: preserve it verbatim.", "The docs quote it."], ["Keep Rationale: as a heading word.", ""]]);
  // Without IDs the rationale line is bare and still attaches to its requirement.
  r.success.criteria = [];
  const plain = validTaskRecord(r);
  assert.deepEqual(parseXml(compile.renderXml(plain)).requirements.map((q) => q.rationale), ["The docs quote it.", ""]);
  for (const rendered of [xml(plain), md(plain), prose(plain)]) assert.deepEqual(preservationCheck(plain, rendered), ok, `${rendered.format} without IDs`);
});

test("a context fact that begins with a reserved label stays a fact", () => {
  const r = base();
  r.outcome.beneficiary = "The release team.";
  r.context.facts = [{ text: "For: each module, keep its header.", provenance: "user" }, { text: "Depends on: nothing here, it is a note.", provenance: "assumption" },
    { text: "Exact identifiers: are listed in the README.", provenance: "user" }, { text: "Fact: the build is green.", provenance: "user" },
    { text: "Assumed (unconfirmed): is a label the user typed.", provenance: "user" }, { text: "An ordinary fact.", provenance: "user" }];
  const record = validTaskRecord(r);
  for (const rendered of [xml(record), md(record), prose(record)]) assert.deepEqual(preservationCheck(record, rendered), ok, rendered.format);
  const v = parseXml(compile.renderXml(record));
  assert.equal(v.outcome.beneficiary, "The release team.");
  assert.deepEqual(v.context.facts, normalisedView(executorView(record)).context.facts);
  assert.deepEqual(parseMarkdown(compile.renderMarkdown(record)).context.facts, v.context.facts);
  assert.ok(compile.renderXml(record).includes("Fact: For: each module, keep its header."));
  assert.ok(compile.renderXml(record).includes("Assumed (unconfirmed): Fact: Depends on: nothing here, it is a note."));
  assert.ok(compile.renderXml(record).includes("    An ordinary fact."), "an ordinary fact is not escaped");
});

const tamperRecord = () => {
  const r = base();
  r.requirements = [{ id: "R1", text: "Update every header.", provenance: "user", strength: "mandatory", rationale: "" },
    { id: "R2", text: "Keep the licence line.", provenance: "user", strength: "preference", rationale: "" }];
  r.success.criteria = [{ id: "A1", text: "Every header has the new form.", provenance: "user", covers: ["R1"] },
    { id: "A2", text: "The licence line is unchanged.", provenance: "user", covers: ["R2"] }];
  r.permissions.prohibited = [{ text: "Deploy anything.", provenance: "user" }];
  r.permissions.authorized = [{ text: "Edit files under src.", provenance: "user" }];
  r.unresolved = [{ text: "The header year.", provenance: "user", state: "must-ask" }];
  return validTaskRecord(r);
};

test("XML tampering that keeps every word is caught: permission category, strength, coverage, unresolved state, a dropped check", () => {
  const record = tamperRecord(), text = compile.renderXml(record);
  assert.deepEqual(preservationCheck(record, { format: "xml", text }), ok);
  const tampers = {
    "Not authorized becomes Authorized": text.replace("Not authorized: Deploy anything.", "Authorized: Deploy anything."),
    "Authorized becomes Requires confirmation": text.replace("Authorized: Edit files under src.", "Requires confirmation: Edit files under src."),
    "a preference becomes mandatory": text.replace("R2 (preference): Keep", "R2: Keep"),
    "a check covers another requirement": text.replace("Covers R1.", "Covers R2."),
    "must-ask becomes not provided": text.replace("Must ask before proceeding: The header year.", "Not provided: The header year."),
    "a check is dropped": text.split("\n").filter((l) => !l.includes("A2: The licence line")).join("\n"),
  };
  for (const [name, t] of Object.entries(tampers)) {
    assert.notEqual(t, text, `${name}: the tamper applied`);
    assert.equal(preservationCheck(record, { format: "xml", text: t }).ok, false, name);
  }
});

test("prose tampering that keeps every word is caught: permission category, strength, unresolved state, a dropped check", () => {
  const r = base();
  r.requirements = [{ id: "R1", text: "Update every header.", provenance: "user", strength: "mandatory", rationale: "" },
    { id: "R2", text: "Keep the licence line.", provenance: "user", strength: "preference", rationale: "" }];
  r.success.criteria = [{ id: "A1", text: "Every header has the new form.", provenance: "user", covers: [] }];
  r.permissions.prohibited = [{ text: "Deploy anything.", provenance: "user" }];
  r.unresolved = [{ text: "The header year.", provenance: "user", state: "must-ask" }];
  const record = validTaskRecord(r), rendered = compile.renderExecutionPrompt(record);
  assert.equal(rendered.format, "prose", "one check and one unresolved matter fit prose");
  assert.deepEqual(preservationCheck(record, rendered), ok);
  const text = rendered.text;
  const tampers = {
    "Not authorized becomes Authorized": text.replace("Not authorized: Deploy anything.", "Authorized: Deploy anything."),
    "a preference becomes mandatory": text.replace("Preferred: Keep the licence line.", "Keep the licence line."),
    "a requirement becomes an exclusion": text.replace("Update every header.", "Exclusion: Update every header."),
    "must-ask becomes not provided": text.replace("Must ask before proceeding: The header year.", "Not provided: The header year."),
    "the check loses its label": text.replace("Done when: Every header has the new form.", "Every header has the new form."),
  };
  for (const [name, t] of Object.entries(tampers)) {
    assert.notEqual(t, text, `${name}: the tamper applied`);
    assert.equal(preservationCheck(record, { format: "prose", text: t }).ok, false, name);
  }
});
