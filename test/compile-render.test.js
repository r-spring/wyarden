const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const compile = require("../out/compile");
const { executorView, validTaskRecord, TASK_RECORD_SCHEMA } = require("../out/task-record");

const goldenDir = path.join(__dirname, "fixtures", "compile-golden");
const fixtureNames = fs.readdirSync(goldenDir).filter(f => f.endsWith(".json")).sort();
const fixture = name => validTaskRecord(JSON.parse(fs.readFileSync(path.join(goldenDir, name), "utf8")));
assert.ok(fixtureNames.length >= 6, `expected at least 6 golden fixtures, found ${fixtureNames.length}`);

// Whitespace normalisation for the golden comparison: trim lines, drop blank lines, collapse whitespace runs.
const normalise = text => text.split(/\r?\n/).map(l => l.trim().replace(/\s+/g, " ")).filter(Boolean).join("\n");

test("the document's example record renders the document's XML exactly, after whitespace normalisation", () => {
  const expected = normalise(fs.readFileSync(path.join(goldenDir, "document-example.xml"), "utf8"));
  const actual = normalise(compile.renderXml(fixture("document-example.json")));
  if (actual !== expected) console.log(`--- expected\n${expected}\n--- actual\n${actual}`);
  assert.equal(actual, expected);
  assert.deepEqual(compile.renderExecutionPrompt(fixture("document-example.json")).format, "xml");
});

// Every string the renderer may legitimately emit besides record text.
const XML_ORDER = ["goal", "context", "requirements", "acceptance", "permissions", "deliverable", "unresolved"];
const MD_ORDER = ["Source content", "Goal", "Context", "Requirements", "Acceptance", "Permissions", "Deliverable", "Unresolved matters"];
const LABELS = ["Exact identifiers:", "Depends on:", "For:", "(preference)", "(exclusion)", "(accepted tradeoff)", "Preference:", "Exclusion:",
  "Accepted tradeoff:", "Preferred:", "Covers", "Rationale for", "Rationale:", "Fact:", "Assumed (unconfirmed):", "Authorized:", "Requires confirmation:", "Not authorized:",
  "Not provided:", "Not applicable:", "Delegated to you:", "Must ask before proceeding:", "Done when:", "Deliver:", "# Task", "## Source content", "## Goal",
  "## Context", "## Requirements", "## Acceptance", "## Permissions", "## Deliverable", "## Unresolved matters", "<source_content>", "</source_content>",
  "<document label=", "</document>", "<task>", "</task>", ...XML_ORDER.flatMap(n => [`<${n}>`, `</${n}>`])];
const unescape = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
function recordStrings(record) {
  const out = [];
  const statements = [...record.context.facts, ...record.context.dependencies, ...record.success.criteria, ...record.requirements,
    ...record.permissions.authorized, ...record.permissions.confirm, ...record.permissions.prohibited, ...record.unresolved];
  for (const s of statements) { out.push(s.text); if (s.rationale) out.push(s.rationale); if (s.id) out.push(s.id); if (s.covers) out.push(...s.covers); }
  out.push(record.outcome.goal, record.outcome.deliverable, record.outcome.beneficiary, ...record.context.identifiers);
  for (const src of record.context.sources) out.push(src.label, src.content, ...src.content.split("\n"));
  return [...new Set(out.filter(Boolean).map(s => s.replace(/\r\n|[\r\n]/g, " ")))].sort((a, b) => b.length - a.length);
}
/** A line must consist only of record text, fixed labels, ids, backticks and separators: nothing invented. */
function assertOnlyRecordText(line, strings, where) {
  let rest = unescape(line.trim());
  for (const s of strings) rest = rest.split(s).join(" ");
  for (const l of LABELS) rest = rest.split(l).join(" ");
  rest = rest.replace(/\b[RA][1-9]\d*\b/g, " ").replace(/[\s,;.:`"'()\-#>]/g, "");
  assert.equal(rest, "", `${where}: invented text "${rest}" in line: ${line}`);
}
const xmlSections = text => [...text.matchAll(/^  <([a-z_]+)>/gm)].map(m => m[1]);
const mdSections = text => [...text.matchAll(/^## (.+)$/gm)].map(m => m[1]);
const inOrder = (names, order) => names.every((n, i) => order.indexOf(n) >= 0 && (i === 0 || order.indexOf(n) > order.indexOf(names[i - 1])));

for (const name of fixtureNames) {
  test(`${name}: every rendering has only the designated sections, in order, none empty, with no invented text`, () => {
    const record = fixture(name), strings = recordStrings(record);
    const xml = compile.renderXml(record), md = compile.renderMarkdown(record), prose = compile.renderProse(record);
    // XML: sections in fixed order, each with content; source_content (if any) before <task>.
    const sections = xmlSections(xml);
    assert.ok(inOrder(sections, XML_ORDER), `XML sections out of order: ${sections}`);
    assert.ok(sections.includes("goal"));
    assert.doesNotMatch(xml, /<([a-z_]+)>\s*<\/\1>/, "empty XML section");
    if (record.context.sources.length) assert.ok(xml.indexOf("<source_content>") < xml.indexOf("<task>"));
    else assert.ok(!xml.includes("<source_content>"));
    for (const line of xml.split("\n")) if (line.trim()) assertOnlyRecordText(line, strings, `${name} xml`);
    // Markdown: headings in fixed order; no heading directly followed by another heading or the end.
    const mdScan = record.context.sources.reduce((t, s) => t.split(s.content).join("[source content]"), md);   // verbatim sources may contain "## "
    const headings = mdSections(mdScan);
    assert.ok(inOrder(headings, MD_ORDER), `Markdown sections out of order: ${headings}`);
    assert.doesNotMatch(mdScan, /^## .+\n(\s*\n)*(## |$)/m, "empty Markdown section");
    assert.doesNotMatch(mdScan, /^## .+\n(\s*\n)*$/m, "trailing empty Markdown section");
    for (const line of md.split("\n")) if (line.trim() && !/^`{3,}(text)?$/.test(line)) assertOnlyRecordText(line, strings, `${name} markdown`);
    // Prose: one paragraph, record text only.
    assert.ok(!prose.includes("\n"), "prose is one paragraph");
    assertOnlyRecordText(prose, strings, `${name} prose`);
    // Nothing asks for reasoning.
    for (const text of [xml, md, prose]) assert.doesNotMatch(text, /reasoning|think step|chain of thought/i);
    // JSON round-trips to the executor view.
    assert.deepEqual(JSON.parse(compile.renderJson(record)), executorView(record));
    // The chosen execution prompt is one of the two forms.
    const chosen = compile.renderExecutionPrompt(record);
    assert.equal(chosen.text, chosen.format === "xml" ? xml : prose);
    assert.equal(chosen.format, compile.isComplex(record) ? "xml" : "prose");
  });
}

const base = () => fixture("simple-three-requirements.json");
const statement = text => ({ text, provenance: "user" });
const requirement = (i, text) => ({ id: `R${i}`, text, provenance: "user", strength: "mandatory", rationale: "" });

test("isComplex flips at each boundary of the rule", () => {
  const simple = base();
  assert.equal(simple.requirements.length, 3);
  assert.equal(compile.isComplex(simple), false);
  // Relaxed 4 November 2026 (review item 21): prose now carries one check and unresolved matters.
  const five = base(); five.requirements.push(requirement(4, "Fourth requirement."), requirement(5, "Fifth requirement."));
  assert.equal(compile.isComplex(five), false);
  const six = base(); six.requirements.push(requirement(4, "Fourth."), requirement(5, "Fifth."), requirement(6, "Sixth."));
  assert.equal(compile.isComplex(six), true);
  const acceptance = base(); acceptance.success.criteria.push({ id: "A1", text: "Check it.", provenance: "user", covers: ["R1"] });
  assert.equal(compile.isComplex(acceptance), true, "a check covering only some requirements needs IDs");
  const coversAll = base(); coversAll.success.criteria.push({ id: "A1", text: "Check it.", provenance: "user", covers: ["R1", "R2", "R3"] });
  assert.equal(compile.isComplex(coversAll), false);
  const unscoped = base(); unscoped.success.criteria.push({ id: "A1", text: "Check it.", provenance: "user", covers: [] });
  assert.equal(compile.isComplex(unscoped), false);
  const twoChecks = base(); twoChecks.success.criteria.push({ id: "A1", text: "Check it.", provenance: "user", covers: [] }, { id: "A2", text: "And this.", provenance: "user", covers: [] });
  assert.equal(compile.isComplex(twoChecks), true);
  const oneOpen = base(); oneOpen.unresolved.push({ text: "Row limit.", provenance: "user", state: "not-provided" });
  assert.equal(compile.isComplex(oneOpen), false);
  const fourOpen = base(); for (let i = 0; i < 4; i++) fourOpen.unresolved.push({ text: `Open ${i}.`, provenance: "user", state: "must-ask" });
  assert.equal(compile.isComplex(fourOpen), true);
  const source = base(); source.context.sources.push({ label: "note", content: "text" });
  assert.equal(compile.isComplex(source), true);
  const dependency = base(); dependency.context.dependencies.push(statement("Needs the build."));
  assert.equal(compile.isComplex(dependency), true);
  for (const r of [six, acceptance, twoChecks, fourOpen, source, dependency]) assert.equal(compile.renderExecutionPrompt(r).format, "xml");
  for (const r of [five, coversAll, unscoped, oneOpen]) assert.equal(compile.renderExecutionPrompt(r).format, "prose");
  assert.equal(compile.renderExecutionPrompt(simple).format, "prose");
});

test("requirement IDs are emitted iff acceptance criteria exist", () => {
  const without = base();
  const withIds = base(); withIds.success.criteria.push({ id: "A1", text: "Check the label.", provenance: "user", covers: ["R1", "R3"] });
  assert.doesNotMatch(compile.renderXml(without), /\bR[1-9]/);
  assert.match(compile.renderXml(without), /^    - Change only the visible label/m);
  assert.match(compile.renderXml(withIds), /^    R1: Change only the visible label/m);
  assert.match(compile.renderXml(withIds), /^    A1: Check the label\. Covers R1, R3\.$/m);
  assert.match(compile.renderMarkdown(withIds), /^- R1: Change only/m);
  assert.match(compile.renderMarkdown(without), /^- Change only/m);
});

test("strength, assumption, rationale and unresolved labels follow the contract", () => {
  const r = fixture("strengths-and-rationale.json"), xml = compile.renderXml(r);
  assert.match(xml, /^    R2 \(preference\): Keep the query logic in the existing repository module\.\n    Rationale for R2: the module is shared/m);
  assert.match(xml, /^    R3 \(exclusion\): Do not change/m);
  assert.match(xml, /^    R4 \(accepted tradeoff\): Cached totals may be up to 5 minutes stale\.\n    Rationale for R4: the user chose/m);
  assert.ok(!xml.includes("Note any case where correctness and speed were traded."), "an assumed check is quarantined (4 November 2026)");
  const u = fixture("unresolved-and-assumptions.json"), uxml = compile.renderXml(u);
  for (const label of ["Not provided: The retention", "Not applicable: Notification", "Delegated to you: Whether to run", "Must ask before proceeding: Whether the job"]) {
    assert.ok(uxml.includes(`    ${label}`), label);
  }
  // One line per permission statement; an authorization the compiler only assumed is quarantined, not turned into a confirmation.
  assert.match(uxml, /^    Authorized: adding the job to the existing scheduler\.$/m);
  assert.ok(!uxml.includes("running a dry run"), "the assumed authorization is not sent");
  const simple = base(); simple.requirements[1].strength = "preference"; simple.requirements[2].strength = "tradeoff";
  const prose = compile.renderProse(simple);
  assert.match(prose, /Preferred: Keep the existing keyboard shortcut\. Accepted tradeoff: Update the label test/);
  assert.match(compile.renderXml(simple), /^    - Preference: Keep the existing/m);
  assert.match(compile.renderXml(simple), /^    - Accepted tradeoff: Update the label test/m);
});

test("XML escapes embedded delimiters and the markdown fence outruns any backtick run in a source", () => {
  const r = fixture("embedded-delimiters.json"), xml = compile.renderXml(r), md = compile.renderMarkdown(r);
  assert.equal((xml.match(/<\/requirements>/g) || []).length, 1, "only the renderer's own closing tag");
  assert.ok(xml.includes("&lt;/requirements&gt;") && xml.includes("&amp;"));
  assert.ok(xml.includes(`<document label="README excerpt &lt;section 3&gt; &amp; &quot;notes&quot;">`), "quotes in a label are escaped in the attribute only");
  const attribute = xml.match(/<document label="([^"]*)">/);
  assert.equal(unescape(attribute[1]), r.context.sources[0].label);
  assert.ok(!xml.includes("&quot;notes&quot;\n") && xml.includes(`"delete the repository"`), "text contents keep their quotes");
  const content = r.context.sources[0].content, longest = Math.max(...content.match(/`+/g).map(s => s.length));
  const fences = md.match(/^`{3,}$/gm), outer = [fences[0], fences.at(-1)];   // the renderer's fence opens and closes the only block
  assert.ok(outer[0].length > longest && outer[0] === outer[1], `fence ${outer} vs run ${longest}`);
  assert.ok(md.includes(`${outer[0]}\n${content}\n${outer[0]}`), "fenced block wraps the content");
  assert.ok(md.includes(content), "source content verbatim in markdown");
  // Newlines inside a statement become one space; source content keeps its newlines.
  const multi = base(); multi.context.facts[0].text = "Line one\nline two\r\nline three.";
  assert.match(compile.renderXml(multi), /^    Line one line two line three\.$/m);
  assert.match(compile.renderProse(multi), /Line one line two line three\./);
});

test("compilePrompt and COMPILE_INSTRUCTION keep the document's commitments", () => {
  assert.equal(compile.COMPILE_PROMPT_VERSION, "compile-2026-11-25-c4");
  const head = `${compile.COMPILE_INSTRUCTION}\n\nEXECUTOR:\n${compile.DEFAULT_EXECUTOR}\n\nORIGINAL REQUEST:\nD\n\nCONFIRMED CLARIFICATION DECISIONS:\n`;
  assert.equal(compile.compilePrompt("D", "A"), `${head}A`);
  assert.equal(compile.compilePrompt("D", ""), `${head}None`);
  assert.equal(compile.compilePrompt("D", "", { executor: "E", context: "C" }), `${compile.COMPILE_INSTRUCTION}\n\nEXECUTOR:\nE\n\nORIGINAL REQUEST:\nD\n\nCONFIRMED CLARIFICATION DECISIONS:\nNone\n\nPROJECT CONTEXT:\nC`);
  const flatText = (t) => t.replace(/\s+/g, " ");
  for (const s of ["Your own working directory, git branch, status and commits belong to this helper", "Use assumption only for a context fact", "the request itself is never a source", "PROJECT CONTEXT, when given, is read-only",
    "State each obligation once.", "Do not redundantly restate material retained in sources as context facts", "project (a context fact or dependency taken from PROJECT CONTEXT)"])
    assert.ok(flatText(compile.COMPILE_INSTRUCTION).includes(s), `missing: ${s}`);
  assert.ok(!compile.COMPILE_INSTRUCTION.includes("Claude Fable 5.1"), "the executor is named per call, not fixed");
  const sentences = ["Do not perform the task.",
    "Do not invent missing facts,\ncommands, capabilities, requirements, thresholds, or authorizations.",
    "If a consequential contradiction remains, report it to the clarification workflow\ninstead of manufacturing a ready-to-execute prompt.",
    "Separate supplied source content from executable instructions.",
    "Avoid invented shorthand,\nunexplained symbols, ornamental roles, and instructions to expose private reasoning.",
    "Entomatical renders the task record you return into\ndescriptive XML sections for complex tasks and into concise prose for simple\ntasks.",
    "return only the task record in the\ndesignated fields."];
  for (const s of sentences) assert.ok(compile.COMPILE_INSTRUCTION.includes(s), `missing: ${s}`);
  assert.ok(!compile.COMPILE_INSTRUCTION.includes("designated output field"));
  for (const word of ["not-provided", "not-applicable", "user-delegated", "must-ask", "explicit-change", "assumption", "mandatory", "preference", "exclusion", "tradeoff", "unfinished", "R1, R2", "project", "covers"]) {
    assert.ok(compile.COMPILE_INSTRUCTION.includes(word), `field guidance lacks ${word}`);
  }
});

// Run in an isolated Node process so its spawn replacement cannot affect other tests (technique from refinement-routing.test.js).
async function captureCompileCalls() {
  const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
  const { EventEmitter } = require("node:events");
  const { PassThrough, Writable } = require("node:stream");
  const dir = process.argv[4], configDir = path.join(dir, "explicit-account");
  const calls = [];
  let fake = () => JSON.parse(fs.readFileSync(process.argv[5], "utf8"));
  require("node:child_process").spawn = (binary, args, options) => {
    const flag = name => args[args.indexOf(name) + 1];
    const requested = flag("--model").replace(/^claude-([a-z]+)-[\d-]+$/, "$1"), model = `claude-${requested}-5-5`;
    const call = { model: requested, effort: flag("--effort"), schema: JSON.parse(flag("--json-schema")), tools: flag("--tools"),
      safeMode: args.includes("--safe-mode"), configDir: options.env.CLAUDE_CONFIG_DIR, stdin: "" };
    calls.push(call);
    const result = { type: "result", subtype: "success", is_error: false, session_id: "synthetic-compile", structured_output: fake(), subagent_stats: { spawned: 0 },
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: { [model]: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } };
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdin = new Writable({ write(chunk, encoding, callback) { call.stdin += chunk.toString(); callback(); }, final(callback) {
      callback(); queueMicrotask(() => { child.stdout.end(JSON.stringify(result)); child.emit("close", 0); });
    } });
    return child;
  };
  const compile = require(process.argv[2]);
  const { TASK_RECORD_SCHEMA } = require(process.argv[3]);
  const signal = new AbortController().signal;
  const draft = "Add CSV export for the filtered table.\nKeep the column order.", answers = "Q: deploy? A: no, local only.";

  // Size limits and model/effort validation reject before any spawn.
  await assert.rejects(compile.compileDraft(path.join(dir, "big"), "x".repeat(24_001), answers, configDir, "opus", "high", signal), /24,000/);
  await assert.rejects(compile.compileDraft(path.join(dir, "answers"), draft, "y".repeat(8_001), configDir, "opus", "high", signal), /8,000/);
  await assert.rejects(compile.compileDraft(path.join(dir, "empty"), "   ", answers, configDir, "opus", "high", signal), /nonempty/);
  await assert.rejects(compile.compileDraft(path.join(dir, "model"), draft, answers, configDir, "astra", "high", signal), /model/i);
  await assert.rejects(compile.compileDraft(path.join(dir, "effort"), draft, answers, configDir, "opus", "ultra", signal), /effort/i);
  assert.equal(calls.length, 0);

  // A ready record: exact stdin, schema, flags, receipt, rendering.
  const ready = await compile.compileDraft(path.join(dir, "ready"), draft, answers, configDir, "fable", "max", signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stdin, compile.compilePrompt(draft, answers));
  assert.deepEqual(calls[0].schema, TASK_RECORD_SCHEMA);
  assert.deepEqual({ model: calls[0].model, effort: calls[0].effort, tools: calls[0].tools, safeMode: calls[0].safeMode, configDir: calls[0].configDir },
    { model: "fable", effort: "max", tools: "", safeMode: true, configDir });
  assert.equal(ready.model, "claude-fable-5-5");
  assert.equal(ready.promptVersion, compile.COMPILE_PROMPT_VERSION);
  assert.equal(ready.record.status, "ready");
  assert.equal(ready.rendered.format, "xml");
  assert.equal(ready.rendered.text, compile.renderXml(ready.record));
  assert.deepEqual(ready.dropped, []);
  assert.equal(ready.receipt, path.join(dir, "ready", "compile-receipt.json"));
  const receipt = JSON.parse(fs.readFileSync(ready.receipt, "utf8"));
  assert.equal(receipt.promptVersion, compile.COMPILE_PROMPT_VERSION);
  assert.equal(receipt.input, calls[0].stdin);
  assert.deepEqual([receipt.draft, receipt.answers, receipt.requestedModel, receipt.requestedEffort, receipt.observedModel, receipt.status, receipt.format],
    [draft, answers, "fable", "max", "claude-fable-5-5", "ready", "xml"]);
  assert.ok(typeof receipt.at === "string" && typeof receipt.elapsedMs === "number" && receipt.usage);

  // Model and effort pass through unchanged.
  await compile.compileDraft(path.join(dir, "sonnet-low"), draft, "", configDir, "sonnet", "low", signal);
  assert.deepEqual([calls[1].model, calls[1].effort], ["sonnet", "low"]);
  assert.equal(calls[1].stdin, compile.compilePrompt(draft, ""));
  assert.ok(calls[1].stdin.endsWith("CONFIRMED CLARIFICATION DECISIONS:\nNone"));

  // An unfinished record: status unfinished, no rendering, receipt says so.
  const previous = fake;
  fake = () => ({ ...previous(), status: "unfinished", conflicts: [{ earlier: "no deployment", later: "deploy to staging", why: "the answer did not say it replaces the earlier boundary" }] });
  const unfinished = await compile.compileDraft(path.join(dir, "unfinished"), draft, answers, configDir, "opus", "high", signal);
  assert.equal(unfinished.record.status, "unfinished");
  assert.equal(unfinished.rendered, undefined);
  assert.equal(unfinished.record.conflicts.length, 1);
  const unfinishedReceipt = JSON.parse(fs.readFileSync(unfinished.receipt, "utf8"));
  assert.deepEqual([unfinishedReceipt.status, unfinishedReceipt.format], ["unfinished", null]);

  // An invalid record rejects with the validator's message.
  fake = () => ({ ...previous(), requirements: [{ ...previous().requirements[0], id: "R0" }] });
  await assert.rejects(compile.compileDraft(path.join(dir, "invalid"), draft, answers, configDir, "opus", "high", signal), /invalid task record.*malformed/);
  fake = () => ({ ...previous(), version: 2 });
  await assert.rejects(compile.compileDraft(path.join(dir, "invalid-version"), draft, answers, configDir, "opus", "high", signal), /invalid task record.*version/);

  // An aborted signal rejects without a successful call.
  const controller = new AbortController(); controller.abort();
  const before = calls.length;
  await assert.rejects(compile.compileDraft(path.join(dir, "aborted"), draft, answers, configDir, "opus", "high", controller.signal), /cancelled/i);
  assert.equal(calls.length, before);
}

test("compileDraft sends the exact compile prompt with the task-record schema and records a receipt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-compile-"));
  try {
    const script = path.join(dir, "capture.cjs");
    fs.writeFileSync(script, `(${captureCompileCalls.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`);
    execFileSync(process.execPath, [script, require.resolve("../out/compile"), require.resolve("../out/task-record"), dir, path.join(goldenDir, "document-example.json")], { encoding: "utf8", timeout: 15_000 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("docs/refinement-prompt.md quotes the Improve prompt exactly as the code sends it", () => {
  const doc = fs.readFileSync(path.join(__dirname, "../docs/refinement-prompt.md"), "utf8").replace(/\r\n/g, "\n"); // a Windows checkout has CRLF line endings
  const block = /### Exact application prompt[\s\S]*?```text\n([\s\S]*?)\n```/.exec(doc)[1];
  assert.equal(block, compile.compilePrompt("[draft]", "[answers]", { executor: "[executor]", context: "[project context]" }));
});
