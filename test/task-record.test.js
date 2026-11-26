// Tests for src/task-record.ts: the compile-stage task record, its validator, the ready gate and the executor view.
// Run after `npx tsc -p .`: `node --test test/task-record.test.js`.
const test = require('node:test'), assert = require('node:assert/strict');
const { validTaskRecord, executorView, quarantined, quarantineProblems, TASK_RECORD_SCHEMA, PROVENANCE, UNRESOLVED, STRENGTH } = require('../out/task-record');

const st = (text, provenance = 'user') => ({ text, provenance });
const clone = (v) => JSON.parse(JSON.stringify(v));
/** A minimal ready record: only the goal is stated. Everything else is empty, which the schema allows. */
const minimal = () => ({
  version: 1, status: 'ready',
  outcome: { goal: 'Rename the export button.', deliverable: '', beneficiary: '' },
  context: { facts: [], identifiers: [], sources: [], dependencies: [] },
  success: { criteria: [] }, requirements: [], permissions: { authorized: [], confirm: [], prohibited: [] },
  unresolved: [], conflicts: [],
});
/** The research document's CSV example (test/fixtures/compile/document-example.source.xml, "Illustrative execution prompt") as a record. */
const csvExample = () => ({
  version: 1, status: 'ready',
  outcome: { goal: 'Add CSV export for the currently filtered results table.', deliverable: 'Working local change and a brief account of verification and remaining limits.', beneficiary: '' },
  context: { facts: [st('The table already supports filtering and column selection.')], identifiers: [], sources: [], dependencies: [] },
  success: { criteria: [
    { id: 'A1', text: 'Compare exported rows with the filtered table; they match.', provenance: 'user', covers: ['R1'] },
    { id: 'A2', text: 'Compare CSV headers with visible columns; order matches.', provenance: 'user', covers: ['R2'] },
    { id: 'A3', text: 'Verify existing filtering and sorting still work.', provenance: 'user', covers: ['R3'] },
  ] },
  requirements: [
    { id: 'R1', text: 'Export only rows matching the active filters.', provenance: 'user', strength: 'mandatory', rationale: '' },
    { id: 'R2', text: 'Preserve the visible column order.', provenance: 'user', strength: 'mandatory', rationale: '' },
    { id: 'R3', text: 'Preserve existing filtering and sorting behavior.', provenance: 'user', strength: 'mandatory', rationale: '' },
  ],
  permissions: { authorized: [st('local implementation and focused verification.')], confirm: [], prohibited: [st('deployment or unrelated changes.')] },
  unresolved: [], conflicts: [],
});
/** A record that exercises every field: all provenance values, all strengths, all unresolved states, sources, dependencies, rationale. */
const full = () => ({
  version: 1, status: 'ready',
  outcome: { goal: 'Migrate the `usage` table to the new schema.', deliverable: 'A migration script and its dry-run log.', beneficiary: 'the on-call engineer' },
  context: {
    facts: [st('Rows are keyed by account name.', 'user'), st('The table has 12,400 rows.', 'assumption')],
    identifiers: ['usage', 'account_name', 'C:\\data\\usage.db'],
    sources: [{ label: 'schema.sql', content: 'CREATE TABLE usage (\n  account_name TEXT,\n  used INTEGER\n);\n' }],
    dependencies: [st('The new schema file must exist before the migration runs.', 'explicit-change')],
  },
  success: { criteria: [
    { id: 'A1', text: 'Row count before and after the migration match.', provenance: 'user', covers: ['R1', 'R2'] },
    { id: 'A2', text: 'The dry-run log lists every renamed column.', provenance: 'assumption', covers: [] },
  ] },
  requirements: [
    { id: 'R1', text: 'Keep every row.', provenance: 'user', strength: 'mandatory', rationale: 'Historical usage feeds the forecast.' },
    { id: 'R2', text: 'Rename `used` to `tokens_used`.', provenance: 'explicit-change', strength: 'mandatory', rationale: '' },
    { id: 'R3', text: 'Prefer a single transaction.', provenance: 'assumption', strength: 'preference', rationale: '' },
    { id: 'R4', text: 'Do not drop the old table.', provenance: 'user', strength: 'exclusion', rationale: 'Rollback path.' },
    { id: 'R5', text: 'A slower migration is acceptable.', provenance: 'user', strength: 'tradeoff', rationale: 'Correctness over speed.' },
  ],
  permissions: { authorized: [st('edit files under src/.')], confirm: [st('running the migration against the live database.', 'user')], prohibited: [st('deleting backups.', 'explicit-change')] },
  unresolved: [
    { text: 'Target database path.', provenance: 'user', state: 'not-provided' },
    { text: 'Index rebuild policy.', provenance: 'assumption', state: 'not-applicable' },
    { text: 'Column type for tokens_used.', provenance: 'user', state: 'user-delegated' },
    { text: 'Whether to run during business hours.', provenance: 'explicit-change', state: 'must-ask' },
  ],
  conflicts: [],
});
const unfinished = () => ({ ...minimal(), status: 'unfinished', conflicts: [{ earlier: 'Do not touch the database.', later: 'Migrate the usage table.', why: 'The later answer does not say whether the earlier boundary was lifted.' }] });

// ---- Invalid records. Each entry: [reason, mutation of a valid record (or a replacement value), expected message fragment]. ----
const invalid = [
  ['non-object (null)', () => null, /record is not an object/],
  ['array instead of object', () => [minimal()], /record is not an object/],
  ['wrong version', r => { r.version = 2; }, /version is not 1/],
  ['unknown status', r => { r.status = 'done'; }, /status must be one of ready, unfinished/],
  ['unknown provenance', r => { r.context.facts[0].provenance = 'guess'; }, /context\.facts\[0\]\.provenance must be one of user, explicit-change, project, assumption/],
  ['unknown strength', r => { r.requirements[0].strength = 'optional'; }, /requirements\[0\]\.strength must be one of mandatory, preference, exclusion, tradeoff/],
  ['unknown unresolved state', r => { r.unresolved[0].state = 'pending'; }, /unresolved\[0\]\.state must be one of not-provided, not-applicable, user-delegated, must-ask/],
  ['missing outcome.deliverable', r => { delete r.outcome.deliverable; }, /outcome\.deliverable is not text/],
  ['missing conflicts list', r => { delete r.conflicts; }, /conflicts is not a list/],
  ['missing success object', r => { delete r.success; }, /success is not an object/],
  ['statement is a string, not an object', r => { r.permissions.authorized = ['anything']; }, /permissions\.authorized\[0\] is not an object/],
  ['non-string text (number)', r => { r.outcome.goal = 42; }, /outcome\.goal is not text/],
  ['non-string identifier', r => { r.context.identifiers = [7]; }, /context\.identifiers\[0\] is not text/],
  ['covers is not a list', r => { r.success.criteria[0].covers = 'R1'; }, /success\.criteria\[0\]\.covers is not a list/],
  ['duplicate requirement id', r => { r.requirements[1].id = 'R1'; }, /requirement id "R1" is duplicated/],
  ['malformed requirement id (R0)', r => { r.requirements[0].id = 'R0'; }, /requirement id "R0" is malformed/],
  ['malformed requirement id (lowercase)', r => { r.requirements[0].id = 'r1'; }, /requirement id "r1" is malformed/],
  ['malformed acceptance id (B1)', r => { r.success.criteria[0].id = 'B1'; }, /acceptance id "B1" is malformed/],
  ['duplicate acceptance id', r => { r.success.criteria[1].id = 'A1'; }, /acceptance id "A1" is duplicated/],
  ['dangling covers', r => { r.success.criteria[0].covers = ['R9']; }, /acceptance A1 covers unknown requirement "R9"/],
  ['ready with conflicts', r => { r.conflicts = [{ earlier: 'a', later: 'b', why: 'c' }]; }, /a ready record lists conflicts/],
  ['unfinished without conflicts', r => { r.status = 'unfinished'; }, /an unfinished record lists no conflict/],
  ['ready with empty goal', r => { r.outcome.goal = ''; }, /a ready record has no goal/],
  ['ready with whitespace-only goal', r => { r.outcome.goal = ' \n\t'; }, /a ready record has no goal/],
  ['oversize string (24,001 characters)', r => { r.outcome.deliverable = 'x'.repeat(24_001); }, /outcome\.deliverable exceeds 24000 characters/],
  ['oversize array (201 items)', r => { r.context.identifiers = Array.from({ length: 201 }, (_, i) => `id${i}`); }, /context\.identifiers has more than 200 items/],
  ['control character (U+0001)', r => { r.requirements[0].text = 'Keep\x01every row.'; }, /requirements\[0\]\.text contains control characters/],
  ['control character (DEL)', r => { r.context.sources[0].content = 'a\x7fb'; }, /context\.sources\[0\]\.content contains control characters/],
  ['empty requirement text', r => { r.requirements[0].text = '   '; }, /requirements\[0\] is empty/],
  ['empty acceptance text', r => { r.success.criteria[0].text = ''; }, /success\.criteria\[0\] is empty/],
  ['empty unresolved text', r => { r.unresolved[0].text = ''; }, /unresolved\[0\] is empty/],
  ['conflict missing why', () => { const r = unfinished(); delete r.conflicts[0].why; return r; }, /conflicts\[0\]\.why is not text/],
];
const N = invalid.length;
test(`validTaskRecord rejects ${N} invalid or incomplete records (N = ${N}) with the reason in the message`, () => {
  assert.ok(N >= 15, `expected at least 15 invalid cases, have ${N}`);
  for (const [reason, mutate, expected] of invalid) {
    const base = full();
    const result = mutate(base);
    const value = result === undefined ? base : result;
    assert.throws(() => validTaskRecord(value), expected, `case "${reason}" should throw ${expected}`);
    assert.throws(() => validTaskRecord(value), /The compiler returned an invalid task record \(.*\); the draft is unchanged\./, `case "${reason}" should use the standard message`);
  }
  // Every valid base is actually valid, so a rejection above is caused by the mutation alone.
  validTaskRecord(full()); validTaskRecord(unfinished());
});

// ---- Valid records. Each entry: [name, record]. validTaskRecord returns an equal copy. ----
const valid = [
  ['minimal ready record', minimal()],
  ['the document\'s CSV example as a record', csvExample()],
  ['every provenance value (user, explicit-change, assumption)', { ...minimal(), context: { ...minimal().context, facts: PROVENANCE.map(p => st(`stated as ${p}`, p)) } }],
  ['every unresolved state', { ...minimal(), unresolved: UNRESOLVED.map(state => ({ text: `item in state ${state}`, provenance: 'user', state })) }],
  ['every strength', { ...minimal(), requirements: STRENGTH.map((strength, i) => ({ id: `R${i + 1}`, text: `requirement with strength ${strength}`, provenance: 'user', strength, rationale: '' })) }],
  ['unfinished record with conflicts', unfinished()],
  ['record with sources and dependencies', { ...minimal(), context: { facts: [], identifiers: ['usage'], sources: [{ label: 'notes.txt', content: 'line one\n\tindented line two\r\nwindows line' }], dependencies: [st('depends on the schema file.')] } }],
  ['empty optional strings for beneficiary, deliverable and rationale', { ...minimal(), outcome: { goal: 'Do the thing.', deliverable: '', beneficiary: '' }, requirements: [{ id: 'R1', text: 'Keep it small.', provenance: 'user', strength: 'preference', rationale: '' }] }],
  ['the full record (all fields populated)', full()],
  ['boundary sizes: a 24,000-character string and a 200-item list', { ...minimal(), outcome: { goal: 'g'.repeat(24_000), deliverable: '', beneficiary: '' }, context: { ...minimal().context, identifiers: Array.from({ length: 200 }, (_, i) => `id${i}`) } }],
  ['unfinished record with an empty goal (the goal rule applies only to ready records)', { ...unfinished(), outcome: { goal: '', deliverable: '', beneficiary: '' } }],
  ['acceptance covering several requirements and one covering none', { ...csvExample(), success: { criteria: [{ id: 'A1', text: 'All three hold.', provenance: 'user', covers: ['R1', 'R2', 'R3'] }, { id: 'A2', text: 'Build passes.', provenance: 'assumption', covers: [] }] } }],
  ['non-sequential but well-formed ids (R2, R10, A7)', { ...minimal(), requirements: [{ id: 'R10', text: 'ten', provenance: 'user', strength: 'mandatory', rationale: '' }, { id: 'R2', text: 'two', provenance: 'user', strength: 'mandatory', rationale: '' }], success: { criteria: [{ id: 'A7', text: 'seven', provenance: 'user', covers: ['R10'] }] } }],
];
const M = valid.length;
test(`validTaskRecord accepts ${M} valid records (M = ${M}) and returns an equal copy`, () => {
  assert.ok(M >= 8, `expected at least 8 valid cases, have ${M}`);
  for (const [name, record] of valid) {
    const input = clone(record);
    const out = validTaskRecord(input);
    assert.deepEqual(out, record, `case "${name}" should round-trip`);
    assert.notEqual(out, input, `case "${name}" should return a new object, not the input`);
    assert.deepEqual(input, record, `case "${name}" should leave the input unchanged`);
  }
});

test('executorView drops conflicts, version and status, collapses provenance to an assumed flag, and keeps everything else', () => {
  const record = validTaskRecord(full());
  const view = executorView(record);
  assert.deepEqual(Object.keys(view).sort(), ['context', 'outcome', 'permissions', 'requirements', 'success', 'unresolved']);
  assert.equal('conflicts' in view, false); assert.equal('version' in view, false); assert.equal('status' in view, false);
  // Provenance collapses: user and explicit-change -> assumed:false; assumption -> assumed:true. No "provenance" key survives.
  assert.deepEqual(view.context.facts, [{ text: 'Rows are keyed by account name.', assumed: false }, { text: 'The table has 12,400 rows.', assumed: true }]);
  assert.deepEqual(view.context.dependencies, [{ text: 'The new schema file must exist before the migration runs.', assumed: false }]);
  assert.deepEqual(view.permissions, { authorized: [{ text: 'edit files under src/.', assumed: false }], confirm: [{ text: 'running the migration against the live database.', assumed: false }], prohibited: [{ text: 'deleting backups.', assumed: false }] });
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { assert.equal('provenance' in v, false); Object.values(v).forEach(walk); } };
  walk(view);
  // Strength, rationale, covers, state, identifiers, sources and outcome are preserved. Since 4 November 2026 (review items 19, 20, 50) the
  // assumed requirement R3 and the assumed check A2 are quarantined, and the rest are renumbered R1.. with covers following.
  assert.deepEqual(view.requirements.map(r => [r.id, r.strength, r.rationale, r.assumed]), [['R1', 'mandatory', 'Historical usage feeds the forecast.', false], ['R2', 'mandatory', '', false], ['R3', 'exclusion', 'Rollback path.', false], ['R4', 'tradeoff', 'Correctness over speed.', false]]);
  assert.deepEqual(view.success.criteria, [{ id: 'A1', text: 'Row count before and after the migration match.', assumed: false, covers: ['R1', 'R2'] }]);
  assert.deepEqual(quarantined(record).map(q => [q.kind, q.id]), [['requirement', 'R3'], ['acceptance', 'A2']]);
  assert.deepEqual(quarantineProblems(record), []);
  // An open question is never shown as a guess (3 November 2026): unresolved items carry no assumed flag.
  assert.deepEqual(view.unresolved.map(u => [u.state, u.assumed]), [['not-provided', false], ['not-applicable', false], ['user-delegated', false], ['must-ask', false]]);
  assert.deepEqual(view.context.identifiers, record.context.identifiers);
  assert.deepEqual(view.context.sources, record.context.sources);
  assert.deepEqual(view.outcome, record.outcome);
});

test('an authorization the compiler only assumed is quarantined, not turned into a confirmation; validTaskRecord drops empty statements', () => {
  const r = full();
  r.permissions.authorized.push({ text: 'push the branch to origin.', provenance: 'assumption' }, { text: '  ', provenance: 'user' });
  r.context.facts.push({ text: '', provenance: 'user' }); r.context.identifiers.push(' ');
  const record = validTaskRecord(r), view = executorView(record);
  assert.deepEqual(view.permissions.authorized, [{ text: 'edit files under src/.', assumed: false }]);
  // 4 November 2026 (review item 19): promoting it made 94e6f28b's executor ask before reading the workspace.
  assert.ok(!view.permissions.confirm.some(p => p.text === 'push the branch to origin.'));
  assert.ok(quarantined(record).some(q => q.kind === 'authorized' && q.text === 'push the branch to origin.'));
  assert.equal(record.permissions.authorized.length, 2, 'the record keeps the provenance; only the empty one is gone');
  assert.ok(!record.context.facts.some(f => !f.text) && !record.context.identifiers.some(i => !i.trim()));
});

test('executorView shares no object references with the record: mutating the view leaves the record unchanged', () => {
  const record = validTaskRecord(full());
  const before = clone(record);
  const view = executorView(record);
  assert.notEqual(view.outcome, record.outcome); assert.notEqual(view.context.identifiers, record.context.identifiers);
  assert.notEqual(view.context.sources[0], record.context.sources[0]); assert.notEqual(view.success.criteria[0].covers, record.success.criteria[0].covers);
  view.outcome.goal = 'changed'; view.context.identifiers.push('extra'); view.context.sources[0].content = 'changed';
  view.success.criteria[0].covers.push('R5'); view.requirements[0].text = 'changed'; view.requirements.pop();
  view.permissions.prohibited[0].text = 'changed'; view.unresolved[0].state = 'must-ask'; view.context.facts.length = 0;
  assert.deepEqual(record, before);
});

test('TASK_RECORD_SCHEMA: every object forbids extra properties and requires all of them; enums match the exported lists', () => {
  let objects = 0;
  const walk = (node, where) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      objects++;
      assert.equal(node.additionalProperties, false, `${where} must set additionalProperties:false`);
      assert.ok(node.properties && typeof node.properties === 'object', `${where} must list properties`);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), `${where} must require every property`);
      for (const [k, v] of Object.entries(node.properties)) walk(v, `${where}.${k}`);
    } else if (node.type === 'array') {
      assert.ok(node.items, `${where} must declare items`);
      walk(node.items, `${where}[]`);
    }
  };
  walk(TASK_RECORD_SCHEMA, 'schema');
  // Root, outcome, context, source, success, criterion, requirement, permissions, unresolved item, conflict, plus the four statement lists (facts, dependencies, authorized, confirm, prohibited share one statement object).
  assert.ok(objects >= 10, `walked ${objects} object schemas`);
  const p = TASK_RECORD_SCHEMA.properties;
  assert.deepEqual(p.context.properties.facts.items.properties.provenance.enum, PROVENANCE);
  assert.deepEqual(p.requirements.items.properties.provenance.enum, PROVENANCE);
  assert.deepEqual(p.success.properties.criteria.items.properties.provenance.enum, PROVENANCE);
  assert.deepEqual(p.unresolved.items.properties.provenance.enum, PROVENANCE);
  assert.deepEqual(p.unresolved.items.properties.state.enum, UNRESOLVED);
  assert.deepEqual(p.requirements.items.properties.strength.enum, STRENGTH);
  assert.deepEqual(p.version.enum, [1]);
  assert.deepEqual(p.status.enum, ['ready', 'unfinished']);
  assert.deepEqual(PROVENANCE, ['user', 'explicit-change', 'project', 'assumption']);
  assert.deepEqual(UNRESOLVED, ['not-provided', 'not-applicable', 'user-delegated', 'must-ask']);
  assert.deepEqual(STRENGTH, ['mandatory', 'preference', 'exclusion', 'tradeoff']);
  // The schema is plain JSON (what --json-schema receives).
  assert.deepEqual(JSON.parse(JSON.stringify(TASK_RECORD_SCHEMA)), TASK_RECORD_SCHEMA);
});

test('a record that satisfies the schema but fails the validator is still rejected (schema conformance is not readiness)', () => {
  // Shape-valid, meaning-invalid: an acceptance that covers a requirement which does not exist.
  const r = csvExample(); r.success.criteria[0].covers = ['R4'];
  assert.throws(() => validTaskRecord(r), /covers unknown requirement/);
});

console.log(`task-record counts: N (invalid records rejected) = ${N}, M (valid records accepted) = ${M}`);
