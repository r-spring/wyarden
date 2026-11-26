const test = require('node:test');
const assert = require('node:assert/strict');
const { applyPlanSetup } = require('../out/plan-setup.js');
const { validatePlanFile } = require('../out/plan.js');
const source = () => ({ v: 1, name: 'Setup', review: 'model', account: 'acct', model: 'opus', effort: 'high',
  vars: { names: 'one two', note: 'before' }, reviewer: { account: 'review', model: 'sonnet' }, judge: 'sonnet',
  scribe: { model: 'haiku', documents: ['REPORT.md'], after: ['work'] },
  steps: [{ id: 'work', title: '{{item}}', goal: '{{note}}', each: 'names', model: 'haiku', permission: 'ask' }] });

test('overlays defaults and source-step settings without changing source, draft or untouched fields', () => {
  const raw = source(), before = structuredClone(raw);
  const draft = { defaults: { model: 'sonnet', effort: null }, steps: { work: { model: '', permission: 'bypass' } }, vars: { note: 'line one\nline two' } };
  const savedDraft = structuredClone(draft), got = applyPlanSetup(raw, draft);
  assert.ok(!got.errors);
  assert.equal(got.raw.model, 'sonnet'); assert.equal(got.raw.effort, undefined);
  assert.equal(got.raw.steps[0].model, undefined); assert.equal(got.raw.steps[0].permission, 'bypass');
  assert.deepEqual(got.raw.reviewer, raw.reviewer); assert.deepEqual(got.raw.vars, raw.vars);
  assert.deepEqual(got.vars, draft.vars); assert.deepEqual(raw, before); assert.deepEqual(draft, savedDraft);
  got.raw.scribe.documents.push('OTHER.md'); assert.deepEqual(raw.scribe.documents, ['REPORT.md']);
});

test('one source-step override applies to every expanded card through the existing validator', () => {
  const got = applyPlanSetup(source(), { steps: { work: { model: 'opus' } }, vars: { names: 'First person;Second person' } });
  const checked = validatePlanFile(got.raw, { models: ['opus', 'sonnet', 'haiku'], efforts: ['high'], permissions: ['ask'], maxSteps: 20 }, got.vars);
  assert.ok(!checked.errors, JSON.stringify(checked.errors));
  assert.deepEqual(checked.cards.map(c => [c.key, c.step.title, c.step.model]), [['work[1]', 'First person', 'opus'], ['work[2]', 'Second person', 'opus']]);
});

test('supported role edits preserve omitted properties and remove explicit runtime overrides', () => {
  const got = applyPlanSetup(source(), { reviewer: { account: null, effort: 'high' }, judge: null,
    scribe: { model: '', documents: ['docs/result.md'], after: ['work'] } });
  assert.deepEqual(got.raw.reviewer, { model: 'sonnet', effort: 'high' }); assert.equal(got.raw.judge, undefined);
  assert.deepEqual(got.raw.scribe, { documents: ['docs/result.md'], after: ['work'] });
  assert.deepEqual(applyPlanSetup(source(), {}).raw, source());
});

test('rejects unsupported fields and malformed inputs atomically', () => {
  const raw = source(), before = structuredClone(raw);
  const got = applyPlanSetup(raw, { defaults: { model: 'sonnet', provider: 'evil' }, vars: { unknown: 'x', note: 1 },
    steps: { 'work[1]': {}, work: { goal: 'replace task', effort: 3 } }, reviewer: { permission: 'bypass' },
    scribe: { account: 'other', documents: ['a\nb'], after: 'work' }, judge: {} });
  const refusals = [
    [{ defaults: { provider: 'evil' } }, 'Defaults: unknown field "provider".'],
    [{ vars: { unknown: 'x' } }, 'The plan has no variable "unknown".'],
    [{ vars: { note: 1 } }, 'Variable "note" must be text up to 2000 characters without control characters.'],
    [{ steps: { 'work[1]': {} } }, 'Step "work[1]" must identify exactly one source step of the selected plan.'],
    [{ steps: { work: { goal: 'replace task' } } }, 'Step "work": unknown field "goal".'],
    [{ steps: { work: { effort: 3 } } }, 'Step "work".effort must be one line of text up to 200 characters, or null to inherit.'],
    [{ reviewer: { permission: 'bypass' } }, 'Reviewer: unknown field "permission".'],
    [{ judge: {} }, 'Judge.model must be one line of text up to 200 characters, or null to inherit.'],
    [{ scribe: { account: 'other' } }, 'Scribe: unknown field "account".'],
    [{ scribe: { documents: ['a\nb'] } }, 'Scribe.documents must be a list of up to 20 one-line names or paths.'],
    [{ scribe: { after: 'work' } }, 'Scribe.after must be a list of up to 20 one-line names or paths.'],
  ];
  for (const [draft, message] of refusals) {
    const result = applyPlanSetup(raw, draft);
    assert.deepEqual(result.errors, [message]);
    assert.equal(result.raw, undefined);
  }
  assert.deepEqual(got.errors.sort(), refusals.map(([, message]) => message).sort());
  assert.equal(got.raw, undefined);
  assert.deepEqual(raw, before);
  for (const draft of [null, [], 'x', { defaults: [] }, { vars: [] }, { steps: [] }, { reviewer: null }, { scribe: null }])
    assert.ok(applyPlanSetup(raw, draft).errors, JSON.stringify(draft));
  assert.ok(applyPlanSetup(null, {}).errors);
});

test('rejects prototype-bearing objects, dangerous keys, duplicate step identities and oversized values', () => {
  assert.ok(applyPlanSetup(source(), Object.create({ defaults: {} })).errors);
  assert.ok(applyPlanSetup(source(), JSON.parse('{"__proto__":{"polluted":true}}')).errors);
  assert.ok(applyPlanSetup(source(), { vars: JSON.parse('{"__proto__":"bad"}') }).errors);
  const raw = source(); raw.steps.push(structuredClone(raw.steps[0]));
  assert.match(applyPlanSetup(raw, { steps: { work: {} } }).errors.join('\n'), /exactly one source step/);
  for (const draft of [{ vars: { note: 'x'.repeat(2001) } }, { vars: { note: '\u0000' } },
    { defaults: { model: 'x'.repeat(201) } }, { defaults: { account: 'a\nb' } }, { defaults: { effort: ' ' } }])
    assert.ok(applyPlanSetup(source(), draft).errors);
  assert.equal({}.polluted, undefined);
});

test('leaves effective account/model and plan semantics for the authoritative validator', () => {
  const got = applyPlanSetup(source(), { defaults: { model: 'not-offered' }, scribe: { documents: ['../outside'] } });
  assert.ok(!got.errors);
  const checked = validatePlanFile(got.raw, { models: ['opus', 'sonnet', 'haiku'], efforts: ['high'], permissions: ['ask'], maxSteps: 20 }, got.vars);
  assert.ok(checked.errors.some(e => e.includes('model'))); assert.ok(checked.errors.some(e => e.includes('safe repository-relative')));
});

test('graph edits reorder source steps without changing edges and overlay only supplied dependencies', () => {
  const raw = source(); raw.steps.push({ id: 'finish', title: 'Finish', goal: 'finish', after: ['work'] });
  const before = structuredClone(raw);
  const reordered = applyPlanSetup(raw, { order: ['finish', 'work'] });
  assert.deepEqual(reordered.raw.steps.map(s => s.id), ['finish', 'work']);
  assert.deepEqual(reordered.raw.steps[0].after, ['work']);
  const changed = applyPlanSetup(raw, { order: ['finish', 'work'], dependencies: { finish: [], work: ['abc123'] } });
  assert.deepEqual(changed.raw.steps.map(s => s.after), [[], ['abc123']]);
  assert.deepEqual(raw, before);
  for (const draft of [{ order: ['work', 'work'] }, { order: ['work'] }, { order: ['work', 'unknown'] },
    { dependencies: { unknown: [] } }, { dependencies: { work: ['finish', 'finish'] } },
    { dependencies: { work: 'finish' } }, { dependencies: [] }]) assert.ok(applyPlanSetup(raw, draft).errors);
  // Membership, cycles, and external card existence belong to Board.checkPlan.
  assert.ok(!applyPlanSetup(raw, { dependencies: { work: ['unknown'] } }).errors);
});
