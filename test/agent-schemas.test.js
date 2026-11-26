// The agent schemas (docs/agents/schemas, run 0db6d1 step 9) stay honest: every workflows/*.plan.json example passes the plan schema
// (by a tiny checker below, no dependency) and src/plan.ts alike; the schemas' field names, enums and limits match what src/plan.ts,
// src/orchestrator.ts (validateRequest, capsFrom) and src/board.ts (publishCapabilities, permission lists) accept. A field added to or
// dropped from the code without the schema fails here.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const planSchema = JSON.parse(read("docs/agents/schemas/plan.schema.json"));
const orchSchema = JSON.parse(read("docs/agents/schemas/orchestrator.schema.json"));
const plan = require("../out/plan.js");
const orch = require("../out/orchestrator.js");
const planSrc = read("src/plan.ts"), orchSrc = read("src/orchestrator.ts"), boardSrc = read("src/board.ts");

// ---- a tiny JSON Schema checker: the keywords these two schemas use ----
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
function check(schema, value, rootSchema, where = "$") {
  if (schema === true) return [];
  if (schema === false) return [`${where}: not allowed`];
  const errs = [];
  const sub = (s, v, w = where) => check(s, v, rootSchema, w);
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o[k], rootSchema);
    errs.push(...sub(target, value));
  }
  for (const s of schema.allOf ?? []) errs.push(...sub(s, value));
  if (schema.anyOf && !schema.anyOf.some((s) => !sub(s, value).length)) errs.push(`${where}: matches none of anyOf`);
  if (schema.oneOf && schema.oneOf.filter((s) => !sub(s, value).length).length !== 1) errs.push(`${where}: must match exactly one of oneOf`);
  if (schema.not && !sub(schema.not, value).length) errs.push(`${where}: matches not`);
  if (schema.if && !sub(schema.if, value).length && schema.then) errs.push(...sub(schema.then, value));
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errs.push(`${where}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errs.push(`${where}: not in enum`);
  if (schema.type) {
    const types = [].concat(schema.type), t = typeOf(value);
    if (!types.some((x) => x === t || (x === "integer" && Number.isInteger(value)) || (x === "number" && t === "number"))) return [...errs, `${where}: must be ${types.join("|")}`];
  }
  const t = typeOf(value);
  if (t === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${where}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${where}: too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${where}: does not match ${schema.pattern}`);
  }
  if (t === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${where}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${where}: above maximum`);
  }
  if (t === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${where}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${where}: too many items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errs.push(`${where}: items not unique`);
    if (schema.items) value.forEach((v, i) => errs.push(...sub(schema.items, v, `${where}[${i}]`)));
    if (schema.contains && !value.some((v) => !sub(schema.contains, v).length)) errs.push(`${where}: contains nothing matching`);
  }
  if (t === "object") {
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${where}: missing ${k}`);
    for (const [k, deps] of Object.entries(schema.dependentRequired ?? {})) if (k in value) for (const d of deps) if (!(d in value)) errs.push(`${where}: ${k} needs ${d}`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k] !== undefined) errs.push(...sub(props[k], v, `${where}.${k}`));
      else if (schema.additionalProperties !== undefined) errs.push(...sub(schema.additionalProperties, v, `${where}.${k}`));
      else if (schema.unevaluatedProperties === false) errs.push(`${where}.${k}: unknown field`); // every evaluated key is listed in properties
      if (schema.propertyNames) errs.push(...sub(schema.propertyNames, k, `${where}{${k}}`));
    }
  }
  return errs;
}
const planErrors = (p) => check(planSchema, p, planSchema);
test("schema and parser reject null text and judged steps without checks", () => {
  for (const raw of [
    { v: 1, name: "Probe", review: "model", about: null, steps: [{ id: "a", title: "A", goal: "G" }] },
    { v: 1, name: "Probe", review: "model", judge: "opus", steps: [{ id: "a", title: "A", goal: "G", judge: true }] },
  ]) {
    assert.ok(planErrors(raw).length);
    assert.ok("errors" in plan.validatePlanFile(raw, rules));
  }
});
test("root delegation requires an explicit boolean on a v1 model-reviewed plan", () => {
  const base = { v: 1, name: "Delegate", review: "model", steps: [{ id: "a", title: "A", goal: "G", checks: ["unit"] }] };
  const valid = { ...base, mayOpen: true };
  assert.deepEqual(planErrors(valid), []);
  assert.ok("plan" in plan.validatePlanFile(valid, { ...rules, catalogue: { unit: { run: "test" } } }));
  for (const raw of [{ ...valid, review: "checks" }, { ...valid, mayOpen: "yes" }]) {
    assert.ok(planErrors(raw).length);
    assert.ok("errors" in plan.validatePlanFile(raw, rules));
  }
});
test("v2 example agrees with schema and runtime, including typed input and contract refusals", () => {
  const raw = { v: 2, name: "Governed", review: "model", reusable: true, permission: "auto", reviewer: { permission: "ask" },
    execution: { limits: { active: 2, directChildren: 1, depth: 1 }, allowed: ["provider-defaults"], defaultChild: "provider-defaults" },
    inputs: { targets: { type: "list", required: true, default: ["Living room", "Office, upstairs"] } },
    steps: [{ id: "a", title: "Check {{item}}", goal: "Write evidence", each: "targets", contract: { reads: ["README.md"], writes: ["report.md"], artifacts: ["report.md"], acceptance: ["Evidence is traceable"], resources: ["named:router"] } }] };
  assert.deepEqual(planErrors(raw), []);
  assert.ok(!("errors" in plan.validatePlanFile(raw, rules)));
  for (const change of [(p) => p.mayOpen = true, (p) => p.reviewer.permission = null, (p) => p.inputs.targets.default = "A B", (p) => p.steps[0].contract.writes = ["../outside"], (p) => delete p.reusable]) {
    const copy = structuredClone(raw); change(copy);
    assert.ok(planErrors(copy).length, JSON.stringify(copy));
    assert.ok("errors" in plan.validatePlanFile(copy, rules), JSON.stringify(copy));
  }
});
const reqErrors = (r) => check(orchSchema.$defs.request, r, orchSchema);

// ---- the code's own lists, read from the source where they are not exported ----
const literal = (src, re) => { const m = re.exec(src); assert.ok(m, `not found in source: ${re}`); return vm.runInNewContext(`(${m[1]})`); };
const TOP = literal(planSrc, /const TOP = (\[[^\]]*\]);/), STEP = literal(planSrc, /const STEP = (\[[^\]]*\]);/);
const FIELDS = literal(orchSrc, /const FIELDS: Record<Op, string\[\]> = (\{[\s\S]*?\n\});/), COMMON = literal(orchSrc, /const COMMON = (\[[^\]]*\]);/);
const SCRIBE = literal(planSrc, /if \(!(\[[^\]]*\])\.includes\(k\)\) errors\.push\(`Unknown field "\$\{k\}" in "scribe"/);
const REVIEWER = [.../for \(const k of Object\.keys\(rv\)\) if \(([^)]*)\)/.exec(planSrc)[1].matchAll(/k !== "(\w+)"/g)].map((m) => m[1]);
const POLICY = literal(orchSrc, /Object\.keys\(p\)\.some\(\(k\) => !(\[[^\]]*\])\.includes\(k\)\)/);
const keysOf = (re, src) => Object.keys(literal(src, re));
const PERMISSIONS = new Set([...keysOf(/export const PERMISSIONS: Record<string, string> = (\{[^}]*\});/, boardSrc), ...keysOf(/export const ACP_PERMISSIONS: Record<string, string> = (\{[^}]*\});/, boardSrc),
  ...Object.keys(require("../out/codex.js").CODEX_PERMISSIONS)]);
const MODELS = literal(boardSrc, /export const MODELS = (\[[^\]]*\]);/), EFFORTS = literal(boardSrc, /export const EFFORTS = (\[[^\]]*\]);/);
const sorted = (a) => [...a].sort();
const regexSource = (src, re) => re.exec(src)[1];

const catalogue = JSON.parse(read("workflows/checks.json"));
const rules = { catalogue, models: MODELS, efforts: EFFORTS, permissions: [...PERMISSIONS], maxSteps: 600, cards: [] };
// The example plans (docs/agents/examples/). Cards' own plans also land in workflows/ (F98 commits them on main); the picker shows their problems.
const examples = ["docs/agents/examples/example.plan.json", "docs/agents/examples/parity-sweep.plan.json", "docs/agents/examples/research-write.plan.json", "docs/agents/examples/test-fix.plan.json"];

test("every shipped example plan passes the plan schema and src/plan.ts", () => {
  assert.ok(examples.length >= 4, "the four example plans are found");
  for (const n of examples) {
    const p = JSON.parse(read(n));
    assert.deepEqual(planErrors(p), [], `${n} against plan.schema.json`);
    const r = plan.validatePlanFile(p, rules);
    assert.ok(!("errors" in r), `${n} against validatePlanFile: ${JSON.stringify(r.errors)}`);
  }
});

test("the plan schema and src/plan.ts refuse the same broken plans", () => {
  const base = () => JSON.parse(read("docs/agents/examples/example.plan.json"));
  const broken = {
    "unknown top field": (p) => { p.steps_ = []; },
    "unknown step field": (p) => { p.steps[0].prompt = "x"; },
    "v is not 1": (p) => { p.v = 2; },
    "review is not an enum value": (p) => { p.review = "judge"; },
    "missing name": (p) => { delete p.name; },
    "name on two lines": (p) => { p.name = "a\nb"; },
    "name too long": (p) => { p.name = "x".repeat(61); },
    "no steps": (p) => { p.steps = []; },
    "step without goal": (p) => { delete p.steps[0].goal; },
    "bad step id": (p) => { p.steps[0].id = "Write"; },
    "title too long": (p) => { p.steps[0].title = "x".repeat(81); },
    "checks plan step without checks": (p) => { delete p.steps[0].checks; },
    "reviewer without model review": (p) => { p.reviewer = { model: "sonnet" }; },
    "as without each": (p) => { p.steps[0].as = "x"; },
    "judged step without a plan judge": (p) => { p.steps[0].judge = true; },
    "judge not boolean": (p) => { p.judge = "haiku"; p.steps[0].judge = "yes"; },
    "too many files": (p) => { p.steps[0].files = Array.from({ length: 21 }, (_, i) => `f${i}`); },
    "bad permission": (p) => { p.permission = "yolo"; },
    "scribe without documents": (p) => { p.scribe = { after: ["write"] }; },
    "scribe document outside the repo": (p) => { p.scribe = { documents: ["../x.md"], after: ["write"] }; },
    "bad variable name": (p) => { p.vars = { "1x": "a" }; },
    "variable too long": (p) => { p.vars = { a: "x".repeat(2001) }; },
  };
  for (const [what, edit] of Object.entries(broken)) {
    const p = base(); edit(p);
    assert.notDeepEqual(planErrors(p), [], `schema accepts: ${what}`);
    assert.ok("errors" in plan.validatePlanFile(p, rules), `validatePlanFile accepts: ${what}`);
  }
});

test("the plan schema's fields are exactly what src/plan.ts allows", () => {
  assert.deepEqual(sorted(Object.keys(planSchema.properties)), sorted(TOP), "top-level fields");
  assert.deepEqual(sorted(Object.keys(planSchema.$defs.step.properties)), sorted(STEP), "step fields");
  assert.deepEqual(sorted(Object.keys(planSchema.properties.scribe.properties)), sorted(SCRIBE), "scribe fields");
  assert.deepEqual(sorted(Object.keys(planSchema.properties.reviewer.properties)), sorted(REVIEWER), "reviewer fields");
  assert.deepEqual(sorted(planSchema.properties.review.enum), sorted(["checks", "model"]));
  assert.deepEqual(sorted(planSchema.$defs.permission.enum), sorted(PERMISSIONS), "permission names of Claude, Codex and ACP");
  assert.equal(planSchema.$defs.step.properties.id.pattern, regexSource(planSrc, /const ID = \/(.*)\/;/));
  assert.equal(planSchema.properties.vars.propertyNames.pattern, regexSource(planSrc, /const VAR = \/(.*)\/;/));
  assert.equal(planSchema.properties.vars.additionalProperties.maxLength, plan.VAR_CAP);
  assert.match(planSchema.$defs.step.properties.each.description, new RegExp(`1 to ${plan.MAX_EACH} items`));
  assert.match(planSchema.$defs.step.properties.reply.description, new RegExp(plan.DEFAULT_REPLY));
  for (const m of MODELS) assert.match(planSchema.$defs.model.description, new RegExp(`\\b${m}\\b`), `Claude model ${m} named`);
  for (const e of EFFORTS) assert.match(planSchema.$defs.effort.description, new RegExp(`\\b${e}\\b`), `Claude effort ${e} named`);
  // Every documented property has a description.
  const walk = (s, where) => { if (!s || typeof s !== "object") return; for (const [k, v] of Object.entries(s.properties ?? {})) { assert.ok(v.description, `${where}.${k} has a description`); walk(v, `${where}.${k}`); } for (const [k, v] of Object.entries(s.$defs ?? {})) walk(v, `$defs.${k}`); };
  walk(planSchema, "$");
});

/** The smallest valid body of each op, as board.js writes it. */
const by = { v: 1, by: "0db6d1", session: "s-1", at: "2026-11-06T00:00:00.000Z" };
const samples = {
  add: { op: "add", title: "T", prompt: "P", parent: "0db6d1", account: null, model: null, effort: null, completion: null, autoRule: false, after: [], start: "auto", mayOpen: false },
  send: { op: "send", id: "5c41bc", text: "hello" }, receive: { op: "receive" }, stop: { op: "stop", id: "5c41bc" }, resume: { op: "resume", id: "5c41bc" },
  done: { op: "done", id: "5c41bc" }, cancel: { op: "cancel", id: "5c41bc" }, adopt: { op: "adopt", id: "5c41bc" }, rebind: { op: "rebind" }, ready: { op: "ready" },
  note: { op: "note", text: "hi" }, plan: { op: "plan", caps: { open: 4, total: 600, depth: 4 }, policy: { allow: ["a"], deny: [], noSync: true } },
  discard: { op: "discard", id: "5c41bc" }, switch: { op: "switch", id: "5c41bc", account: "Codex · Work" }, finish: { op: "finish", self: true },
  "turn-done": { op: "turn-done" }, screen: { op: "screen", id: "5c41bc", lines: 40 }, type: { op: "type", id: "5c41bc", text: "y", keys: ["escape"], enter: true },
  claim: { op: "claim", id: "5c41bc", reason: "its run finished" }, "claim-tree": { op: "claim-tree", id: "9126b7", reason: "superseded run" },
  "request-takeover": { op: "request-takeover", id: "5c41bc", reason: "owner is live" }, handoff: { op: "handoff", id: "5c41bc", to: "744cc3" },
  submit: { op: "submit", head: "abcdef1", summary: "Delivered", protocol: 3 },
  integrate: { op: "integrate", id: "5c41bc", protocol: 3 }, readiness: { op: "readiness", id: "5c41bc" }, council: { op: "council", action: "convene", checkpoint: "final" },
};
const every = { title: "T", prompt: "P", parent: "0db6d1", account: "a", model: "claude-opus-5-5", effort: "high", permission: "bypass", completion: { commands: ["test"], doneWhen: "d", goal: "g" },
  autoRule: true, after: ["744cc3"], start: "manual", mayOpen: true, runtime: "grok", judge: true, watch: ["744cc3"],
  profile: "workspace:p@1", assignment: { key: "k", outcome: "o", owns: ["src"], acceptance: ["A-01"], evidence: ["log"], returns: "r" }, delegate: { allowed: ["workspace:p@1"], defaultChild: "workspace:p@1", depth: 1 } };

test("the request schema and validateRequest agree on every op", () => {
  assert.deepEqual(sorted(orchSchema.$defs.common.properties.op.enum), sorted(orch.OPS));
  assert.deepEqual(sorted(Object.keys(samples)), sorted(orch.OPS), "a sample for every op");
  assert.deepEqual(sorted(Object.keys(orchSchema.$defs.common.properties)), sorted(COMMON), "common fields");
  for (const op of orch.OPS) {
    const def = orchSchema.$defs[op];
    assert.ok(def, `$defs.${op}`);
    assert.ok(orchSchema.$defs.request.oneOf.some((s) => s.$ref === `#/$defs/${op}`), `request lists ${op}`);
    assert.deepEqual(sorted(Object.keys(def.properties).filter((k) => !COMMON.includes(k) && k !== "op")), sorted(FIELDS[op]), `fields of ${op}`);
    const body = { ...by, ...samples[op] };
    assert.deepEqual(reqErrors(body), [], `schema accepts the ${op} sample`);
    assert.ok("request" in orch.validateRequest(body, "n"), `validateRequest accepts the ${op} sample: ${JSON.stringify(orch.validateRequest(body, "n"))}`);
    const extra = { ...body, bogus: 1 };
    assert.notDeepEqual(reqErrors(extra), [], `schema refuses an unknown field for ${op}`);
    assert.ok("error" in orch.validateRequest(extra, "n"), `validateRequest refuses an unknown field for ${op}`);
  }
  const inferred = { ...by, op: "receive", inferredEditor: true };
  assert.deepEqual(reqErrors(inferred), []);
  assert.equal(orch.validateRequest(inferred, "n").request?.inferredEditor, true);
  // finish has two forms (F120): the sample above is `finish self`; this is `finish <id>`.
  const finishId = { ...by, op: "finish", id: "5c41bc" };
  assert.deepEqual(reqErrors(finishId), [], "schema accepts finish with a card id");
  assert.equal(orch.validateRequest(finishId, "n").request?.id, "5c41bc", "validateRequest accepts finish with a card id");
  const all = { ...by, op: "add", ...every };
  assert.ok("request" in orch.validateRequest(all, "n"), "validateRequest accepts every add field");
  assert.deepEqual(reqErrors(all), [], "schema accepts every add field");
  assert.deepEqual(sorted(orchSchema.$defs.add.properties.runtime.enum), sorted(orch.RUNTIMES));
  assert.deepEqual(sorted(orchSchema.$defs.add.properties.permission.anyOf[0].enum), sorted(PERMISSIONS));
  assert.equal(orchSchema.$defs.add.properties.prompt.maxLength, orch.PROMPT_CAP);
  assert.equal(orchSchema.$defs.add.properties.title.maxLength, orch.TITLE_CAP);
  assert.equal(orchSchema.$defs.send.properties.text.maxLength, orch.PROMPT_CAP);
  assert.equal(orchSchema.$defs.cardId.pattern, regexSource(orchSrc, /const ID = \/(.*)\/;/));
  // Refusals both make.
  const bad = {
    "false editor inference": { op: "receive", inferredEditor: false }, "editor inference on ready": { op: "ready", inferredEditor: true },
    "add without prompt": { op: "add", title: "T" }, "bad by": { op: "ready", by: "zz" }, "v 2": { op: "ready", v: 2 },
    "watch without may-open": { op: "add", title: "T", prompt: "P", watch: ["744cc3"] }, "role with may-open": { op: "add", title: "T", prompt: "P", role: "judge", mayOpen: true },
    "role with judge": { op: "add", title: "T", prompt: "P", role: "scribe", judge: true }, "bad runtime": { op: "add", title: "T", prompt: "P", runtime: "gemini" },
    "bad start": { op: "add", title: "T", prompt: "P", start: "later" }, "after not ids": { op: "add", title: "T", prompt: "P", after: ["x"] },
    "finish without self": { op: "finish" }, "note too long": { op: "note", text: "x".repeat(1001) }, "send without text": { op: "send", id: "5c41bc" },
    "depth over 8": { op: "plan", caps: { depth: 9 } }, "unknown cap": { op: "plan", caps: { cards: 3 } }, "fractional cap": { op: "plan", caps: { open: 1.5 } },
    "policy without noSync": { op: "plan", policy: { allow: [], deny: [] } }, "policy extra key": { op: "plan", policy: { allow: [], deny: [], noSync: true, x: 1 } },
    "claim without reason": { op: "claim", id: "5c41bc" }, "request-takeover with a blank reason": { op: "request-takeover", id: "5c41bc", reason: "" },
    "handoff without to": { op: "handoff", id: "5c41bc" }, "handoff with id and self": { op: "handoff", id: "5c41bc", self: true, to: "744cc3" },
    "finish with id and self": { op: "finish", id: "5c41bc", self: true }, "finish with a bad id": { op: "finish", id: "nope" },
    "mayClaim 2": { op: "plan", caps: { mayClaim: 2 } },
    "submit without summary": { op: "submit", head: "abcdef1" }, "submit with a bad head": { op: "submit", head: "HEAD", summary: "s" },
    "assignment without outcome": { op: "add", title: "T", prompt: "P", assignment: { key: "k" } }, "delegate without may-open": { op: "add", title: "T", prompt: "P", delegate: { depth: 1 } },
  };
  for (const [what, b] of Object.entries(bad)) {
    const body = { ...by, ...b };
    assert.notDeepEqual(reqErrors(body), [], `schema accepts: ${what}`);
    assert.ok("error" in orch.validateRequest(body, "n"), `validateRequest accepts: ${what}`);
  }
});

test("caps, policy and capabilities.json match the code", () => {
  assert.deepEqual(sorted(Object.keys(orchSchema.$defs.capsFile.properties)), sorted([...Object.keys(orch.DEFAULT_CAPS), ...orch.EXTRA_CAPS]));
  assert.deepEqual(Object.keys(orch.capsFrom({})).filter((k) => !(k in orchSchema.$defs.capsFile.properties)), [], "capsFrom keys are in the schema");
  for (const [k, v] of Object.entries(orch.DEFAULT_CAPS)) assert.match(orchSchema.$defs.capsFile.properties[k].description, new RegExp(`Default ${v}\\b`), `default of ${k}`);
  assert.deepEqual(sorted(Object.keys(orchSchema.$defs.policyFile.properties)), sorted(POLICY));
  assert.deepEqual(sorted(orchSchema.$defs.policyFile.required), sorted(POLICY));
  const pub = /private publishCapabilities\(\) \{([\s\S]*?)\n {2}\}/.exec(boardSrc)[1];
  const caps = /capabilities: \{ ([^\n]*?) \},\n/.exec(pub)[1];
  assert.deepEqual(sorted(Object.keys(orchSchema.$defs.capabilities.properties.capabilities.properties)), sorted([...caps.matchAll(/(\w+):/g)].map((m) => m[1])), "capabilities flags");
  for (const k of Object.keys(orchSchema.$defs.capabilities.properties).filter((k) => k !== "cliProtocolVersion")) assert.match(pub, new RegExp(`\\b${k}:`), `publishCapabilities writes ${k}`);
  for (const k of ["runtime", "id", "efforts", "name", "account", "lastSeen"]) assert.match(pub, new RegExp(`\\b${k}\\b`), `models rows carry ${k}`);
  assert.match(read("tools/board.js"), /cliProtocolVersion/);
  const sample = { protocolVersion: 2, at: "2026-11-06T00:00:00.000Z", hostTimezone: "America/Vancouver", live: ["0db6d1"],
    capabilities: { headless: ["claude", "codex", "grok", "antigravity"], nestedCards: true, nativeSubagents: true, pressureWatchers: true, standingRoles: ["judge", "scribe", "research"], controls: ["switch", "finish self"], runBudget: true },
    models: [{ runtime: "claude", id: "opus" }, { runtime: "codex", id: "gpt-6.1-sol", efforts: ["low"] }], accounts: [{ name: "Codex · Work", runtime: "codex", aliases: ["Codex"] }] };
  assert.deepEqual(check(orchSchema.$defs.capabilities, sample, orchSchema), []);
});

test("the agent guide is linked and covers every board.js verb", () => {
  const guide = read("docs/agents/README.md");
  assert.match(guide, /schemas\/plan\.schema\.json/); assert.match(guide, /schemas\/orchestrator\.schema\.json/);
  const verbs = literal(read("tools/board.js"), /const read = (\[[^\]]*\]), write/).concat(literal(read("tools/board.js"), /, write = (\[[^\]]*\]);/), ["reload-windows"]);
  for (const v of verbs) assert.match(guide, new RegExp(`\`${v}\``), `guide names ${v}`);
  for (const f of ["workflows/README.md", "docs/orchestrator/BRIEF.md", "CONTRIBUTING.md"]) assert.match(read(f), /docs\/agents\/README\.md/, `${f} points to the guide`);
});
