// Fidelity tests for the compile stage: src/compile-check.ts against src/compile.ts (round trip, preservation,
// structural editing, lossless serialization). Run after `npx tsc -p .`: `node --test test/compile-fidelity.test.js`.
// Fixtures: test/fixtures/compile-fidelity/*.json (records) and test/fixtures/compile-fidelity/structural/*.json.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { parseXml, parseMarkdown, parseJson, preservationCheck, structuralEditingCheck, extractAnchors, normalisedView, unescapeXml } = require('../out/compile-check');
const { validTaskRecord, executorView } = require('../out/task-record');

// src/compile.ts belongs to compiler-dev. Its absence is a failure, never a silent skip.
let compile = null, compileError = null;
try { compile = require('../out/compile'); } catch (e) { compileError = e; }
const needCompile = () => { if (!compile) assert.fail(`../out/compile is not built yet: ${compileError && compileError.message}`); return compile; };

const fixtureDir = path.join(__dirname, 'fixtures', 'compile-fidelity');
const names = fs.readdirSync(fixtureDir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
const load = (name) => validTaskRecord(JSON.parse(fs.readFileSync(path.join(fixtureDir, `${name}.json`), 'utf8')));
const structuralDir = path.join(fixtureDir, 'structural');
const structuralNames = fs.readdirSync(structuralDir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
const loadStructural = (name) => JSON.parse(fs.readFileSync(path.join(structuralDir, `${name}.json`), 'utf8'));

console.log(`compile-fidelity: ${names.length} record fixtures: ${names.join(', ')}`);
console.log(`compile-fidelity: ${structuralNames.length} structural-editing fixtures: ${structuralNames.join(', ')}`);

test('fixture set covers the required cases (at least 8 records; structural fixtures present)', () => {
  assert.ok(names.length >= 8, `expected >= 8 record fixtures, found ${names.length}`);
  for (const n of ['doc-example', 'sources-tricky', 'identifiers', 'dependencies', 'unresolved-all-four', 'assumptions-everywhere',
    'strengths-rationale', 'many-requirements-no-ids', 'confirm-only', 'simple-prose', 'escaping']) assert.ok(names.includes(n), `missing fixture ${n}`);
  assert.ok(structuralNames.length >= 3);
  const tricky = load('sources-tricky');
  assert.ok(tricky.context.sources[0].label.includes('"'), 'a source label contains a double quote (contract addition)');
  assert.ok(tricky.context.sources[0].content.includes('```') && tricky.context.sources[0].content.includes('</requirements>') && tricky.context.sources[0].content.includes('<document'));
  const many = load('many-requirements-no-ids');
  assert.ok(many.requirements.length > 3 && many.success.criteria.length === 0);
  const confirm = load('confirm-only');
  assert.ok(confirm.permissions.confirm.length && !confirm.permissions.authorized.length && !confirm.permissions.prohibited.length);
  assert.equal(new Set(load('unresolved-all-four').unresolved.map(u => u.state)).size, 4);
});

// ---- the document's own example text, parsed without any renderer (docs/research/...-2026-10-26.md lines 94-121) ----
const DOC_XML = `<task>
  <goal>Add CSV export for the currently filtered results table.</goal>

  <context>
    The table already supports filtering and column selection.
  </context>

  <requirements>
    R1: Export only rows matching the active filters.
    R2: Preserve the visible column order.
    R3: Preserve existing filtering and sorting behavior.
  </requirements>

  <acceptance>
    A1: Compare exported rows with the filtered table; they match. Covers R1.
    A2: Compare CSV headers with visible columns; order matches. Covers R2.
    A3: Verify existing filtering and sorting still work. Covers R3.
  </acceptance>

  <permissions>
    Authorized: local implementation and focused verification.
    Not authorized: deployment or unrelated changes.
  </permissions>

  <deliverable>
    Working local change and a brief account of verification and remaining limits.
  </deliverable>
</task>`;

test('parseXml reads the research document\'s illustrative prompt verbatim into the doc-example executor view', () => {
  const view = executorView(load('doc-example'));
  assert.deepEqual(parseXml(DOC_XML), view);
  const check = preservationCheck(load('doc-example'), { format: 'xml', text: DOC_XML });
  assert.deepEqual(check, { ok: true, missing: [], extra: [] });
});

test('parseXml accepts both the block and the single-line deliverable form (contract amendment)', () => {
  const single = DOC_XML.replace(/<deliverable>\n\s+([^\n]+)\n\s+<\/deliverable>/, '<deliverable>$1</deliverable>');
  assert.notEqual(single, DOC_XML);
  assert.deepEqual(parseXml(single), executorView(load('doc-example')));
});

test('parseMarkdown reads a hand-written Markdown rendering of the document example', () => {
  const md = `# Task

## Goal
Add CSV export for the currently filtered results table.

## Context
The table already supports filtering and column selection.

## Requirements
- R1: Export only rows matching the active filters.
- R2: Preserve the visible column order.
- R3: Preserve existing filtering and sorting behavior.

## Acceptance
- A1: Compare exported rows with the filtered table; they match. Covers R1.
- A2: Compare CSV headers with visible columns; order matches. Covers R2.
- A3: Verify existing filtering and sorting still work. Covers R3.

## Permissions
- Authorized: local implementation and focused verification.
- Not authorized: deployment or unrelated changes.

## Deliverable
Working local change and a brief account of verification and remaining limits.
`;
  assert.deepEqual(parseMarkdown(md), executorView(load('doc-example')));
});

test('parsers re-assign R1.. in order when no IDs are emitted, and keep the assumed prefix and rationale apart', () => {
  const xml = `<task>
  <goal>G</goal>

  <requirements>
    - First one.
    - Preference: Assumed (unconfirmed): Second one.
    Rationale: because.
    - Exclusion: Third one.
    - Accepted tradeoff: Fourth one.
    Rationale: cost.
  </requirements>
</task>`;
  const v = parseXml(xml);
  assert.deepEqual(v.requirements, [
    { id: 'R1', text: 'First one.', assumed: false, strength: 'mandatory', rationale: '' },
    { id: 'R2', text: 'Second one.', assumed: true, strength: 'preference', rationale: 'because.' },
    { id: 'R3', text: 'Third one.', assumed: false, strength: 'exclusion', rationale: '' },
    { id: 'R4', text: 'Fourth one.', assumed: false, strength: 'tradeoff', rationale: 'cost.' },
  ]);
});

test('parseXml is strict: text outside a known line format throws and names the line', () => {
  assert.throws(() => parseXml(DOC_XML.replace('</task>', 'Run npm test\n</task>')), /Run npm test/);
  assert.throws(() => parseXml(DOC_XML.replace('    R2:', '    Run npm test\n    R2:')), /Run npm test/);
  assert.throws(() => parseXml(DOC_XML + '\nRun npm test'), /Run npm test/);
  assert.throws(() => parseXml('<task>\n  <goal>G</goal>\n  <permissions>\n    Allowed: x\n  </permissions>\n</task>'), /Allowed: x/);
});

test('unescapeXml inverts the renderer escaping including &quot; in labels, and leaves literal entities alone after one pass', () => {
  assert.equal(unescapeXml('&lt;a&gt; &amp; &quot;b&quot; &amp;lt;'), '<a> & "b" &lt;');
});

// ---- round trip through compiler-dev's renderers ----
for (const name of names) {
  test(`round trip [${name}]: parseXml(renderXml), parseMarkdown(renderMarkdown), parseJson(renderJson) equal executorView, and preservationCheck is ok for all three and for renderExecutionPrompt`, () => {
    const { renderXml, renderMarkdown, renderJson, renderExecutionPrompt } = needCompile();
    const record = load(name);
    const view = executorView(record);
    const lineView = normalisedView(view);   // statements are one trimmed line in the line renderings; identity for single-line fixtures
    assert.deepEqual(parseXml(renderXml(record)), lineView, 'xml round trip');
    assert.deepEqual(parseMarkdown(renderMarkdown(record)), lineView, 'markdown round trip');
    assert.deepEqual(parseJson(renderJson(record)), view, 'json round trip');
    for (const [format, text] of [['xml', renderXml(record)], ['markdown', renderMarkdown(record)], ['json', renderJson(record)]]) {
      const r = preservationCheck(record, { format, text });
      assert.deepEqual(r, { ok: true, missing: [], extra: [] }, `preservationCheck(${format}) for ${name}:\n${text}`);
    }
    const rendered = renderExecutionPrompt(record);
    const r = preservationCheck(record, rendered);
    assert.deepEqual(r, { ok: true, missing: [], extra: [] }, `preservationCheck(${rendered.format}) for ${name}:\n${rendered.text}`);
  });
}

test('round trip: the single-line fixtures need no normalisation (normalisedView is the identity on them)', () => {
  for (const name of names) if (name !== 'multiline-statement') assert.deepEqual(normalisedView(executorView(load(name))), executorView(load(name)), name);
});

test('renderExecutionPrompt picks prose for the simple fixtures and XML for the complex ones', () => {
  const { renderExecutionPrompt } = needCompile();
  // Since 4 November 2026 prose also takes one check covering everything and up to three unresolved matters (review item 21).
  const prose = ['boolean-words', 'confirm-only', 'escaping', 'many-requirements-no-ids', 'simple-prose', 'simple-prose-identifiers'];
  for (const n of names) {
    const r = renderExecutionPrompt(load(n));
    assert.equal(r.format, prose.includes(n) ? 'prose' : 'xml', n);
    assert.deepEqual(preservationCheck(load(n), r), { ok: true, missing: [], extra: [] }, n);
  }
});

// ---- negative: tampered renderings are reported with the offending text ----
test('negative [xml]: a dropped requirement line is reported as missing', () => {
  const { renderXml } = needCompile();
  const record = load('doc-example');
  const text = renderXml(record).split('\n').filter(l => !l.includes('R2: Preserve the visible column order.')).join('\n');
  const r = preservationCheck(record, { format: 'xml', text });
  assert.equal(r.ok, false);
  assert.ok(r.missing.some(m => m.includes('Preserve the visible column order.')), JSON.stringify(r));
});

test('negative [xml]: an added line "Run npm test" is reported as extra (inside context: parsed as a fact; inside requirements: parse error)', () => {
  const { renderXml } = needCompile();
  const record = load('doc-example');
  const inContext = renderXml(record).replace('  </context>', '    Run npm test\n  </context>');
  let r = preservationCheck(record, { format: 'xml', text: inContext });
  assert.equal(r.ok, false);
  assert.ok(r.extra.some(e => e.includes('Run npm test')), JSON.stringify(r));
  assert.deepEqual(r.missing, []);
  const inRequirements = renderXml(record).replace('  </requirements>', '    Run npm test\n  </requirements>');
  r = preservationCheck(record, { format: 'xml', text: inRequirements });
  assert.equal(r.ok, false);
  assert.ok(r.extra.some(e => e.includes('Run npm test')), JSON.stringify(r));
});

test('negative [xml]: changing 24,000 to 2,400 is reported as missing (24,000) and extra (2,400)', () => {
  const { renderXml } = needCompile();
  const record = load('many-requirements-no-ids');
  const text = renderXml(record).replace('24,000', '2,400');
  const r = preservationCheck(record, { format: 'xml', text });
  assert.equal(r.ok, false);
  assert.ok(r.missing.some(m => m.includes('24,000')), JSON.stringify(r.missing));
  assert.ok(r.extra.some(e => e.includes('2,400')), JSON.stringify(r.extra));
});

test('negative [xml]: changing "Not authorized" to "Authorized" moves the statement between permission lists and is reported', () => {
  const { renderXml } = needCompile();
  const record = load('doc-example');
  const text = renderXml(record).replace('Not authorized: deployment', 'Authorized: deployment');
  const r = preservationCheck(record, { format: 'xml', text });
  assert.equal(r.ok, false);
  assert.ok(r.missing.some(m => m.startsWith('permissions.prohibited') && m.includes('deployment or unrelated changes.')), JSON.stringify(r.missing));
  assert.ok(r.extra.some(e => e.startsWith('permissions.authorized') && e.includes('deployment or unrelated changes.')), JSON.stringify(r.extra));
});

test('negative [xml]: dropping the unresolved section is reported as missing for every unresolved item', () => {
  const { renderXml } = needCompile();
  const record = load('unresolved-all-four');
  const text = renderXml(record).replace(/\n\n  <unresolved>[\s\S]*?<\/unresolved>/, '');
  assert.ok(!text.includes('<unresolved>'));
  const r = preservationCheck(record, { format: 'xml', text });
  assert.equal(r.ok, false);
  for (const u of record.unresolved) assert.ok(r.missing.some(m => m.includes(u.text)), u.text);
});

test('json: bare words "true", "false" and "null" inside statement text are record text, not JSON scaffolding (m9 probe)', () => {
  const { renderJson } = needCompile();
  const record = load('boolean-words');
  assert.ok(record.success.criteria[0].text.includes('true') && record.requirements[0].text.includes('false'));
  assert.deepEqual(preservationCheck(record, { format: 'json', text: renderJson(record) }), { ok: true, missing: [], extra: [] });
  const r = preservationCheck(record, { format: 'json', text: renderJson(record).replace('"assumed": false', '"assumed": true') });
  assert.equal(r.ok, false);   // the assumed field itself is still compared
});

test('negative [markdown, json, prose]: the same tampers are caught in the other formats', () => {
  const { renderMarkdown, renderJson, renderProse } = needCompile();
  const doc = load('doc-example');
  let r = preservationCheck(doc, { format: 'markdown', text: renderMarkdown(doc).split('\n').filter(l => !l.includes('R2:')).join('\n') });
  assert.equal(r.ok, false); assert.ok(r.missing.some(m => m.includes('Preserve the visible column order.')));
  r = preservationCheck(doc, { format: 'markdown', text: renderMarkdown(doc).replace('## Deliverable', '## Deliverable\nRun npm test') });
  assert.equal(r.ok, false); assert.ok(r.extra.some(e => e.includes('Run npm test')));
  r = preservationCheck(doc, { format: 'json', text: renderJson(doc).replace('"Preserve the visible column order."', '"Preserve the column order."') });
  assert.equal(r.ok, false); assert.ok(r.missing.some(m => m.includes('Preserve the visible column order.')) && r.extra.some(e => e.includes('Preserve the column order.')));
  const simple = load('simple-prose');
  r = preservationCheck(simple, { format: 'prose', text: renderProse(simple) + ' Run npm test.' });
  assert.equal(r.ok, false); assert.ok(r.extra.some(e => e.includes('Run npm test')), JSON.stringify(r));
  r = preservationCheck(simple, { format: 'prose', text: renderProse(simple).replace('Do not change the tooltip.', '') });
  assert.equal(r.ok, false); assert.ok(r.missing.some(m => m.includes('Do not change the tooltip.')), JSON.stringify(r));
});

// ---- structural editing: "all required context and dependencies remain available" (document table, line 37) ----
test('structural editing: extractAnchors finds paths, identifiers, flags, backticks, quotes and numbers with units', () => {
  const f = loadStructural('carries-all');
  const anchors = extractAnchors(`${f.draft}\n${f.answers}`);
  for (const a of ['src/board.ts', '#42', '--safe-mode', 'CLAUDE_CONFIG_DIR', '24,000 characters', 'docs/refinement-prompt.md']) assert.ok(anchors.includes(a), `${a} in ${JSON.stringify(anchors)}`);
  assert.ok(!anchors.some(a => a.length < 3));
  assert.deepEqual(extractAnchors('e.g. this and/or that, etc. Just 3 things.'), []);
  assert.deepEqual(extractAnchors('At most 3 retries.'), ['3 retries']);   // a countable quantity is an anchor
  assert.deepEqual(extractAnchors('Wait 120 s, then 5% more, Claude Code it is.'), ['120 s', '5%', 'Claude Code']);
});

for (const name of structuralNames) {
  test(`structural editing [${name}]: dropped = ${JSON.stringify(loadStructural(name).expectDropped)}`, () => {
    const f = loadStructural(name);
    const record = validTaskRecord(f.record);
    assert.deepEqual(structuralEditingCheck(f.draft, f.answers, record), { dropped: f.expectDropped, sourceOnly: [] });
  });
}

test('structural editing: the check is informative, never throws, and searches conflicts and unresolved items too', () => {
  const record = load('unresolved-all-four');
  assert.deepEqual(structuralEditingCheck('Wait 120 s between attempts.', '', record), { dropped: [], sourceOnly: [] });
  const unfinished = { ...record, status: 'unfinished', conflicts: [{ earlier: 'use config.yaml', later: 'use settings.json', why: 'both named as the single settings file' }] };
  assert.deepEqual(structuralEditingCheck('Store it in config.yaml or settings.json.', '', validTaskRecord(unfinished)), { dropped: [], sourceOnly: [] });
  assert.deepEqual(structuralEditingCheck('', '', record), { dropped: [], sourceOnly: [] });
});

// ---- lossless serialization (document table, line 35) ----
test('lossless serialization: renderJson parses to executorView and whitespace-free JSON parses to the same value; token savings are NOT measured here (unknown until M9 CLI-reported usage)', () => {
  const { renderJson } = needCompile();
  for (const name of names) {
    const view = executorView(load(name));
    assert.deepEqual(JSON.parse(renderJson(load(name))), view, name);
    const compact = JSON.stringify(view);
    assert.ok(!/\n/.test(compact) && compact.length < renderJson(load(name)).length, name);
    assert.deepEqual(JSON.parse(compact), view, name);
  }
});
