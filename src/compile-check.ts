/**
 * Mechanical fidelity checks for the compile stage.
 *
 * The research document (test/fixtures/compile/document-example.source.xml, "Compression has three
 * different meanings", lines 29-43) names three transformations and what each must be checked for. This module
 * implements the two that can be checked mechanically and names the third so nobody mistakes it for covered:
 *
 *   1. Lossless serialization  - "decoding reconstructs the same values and relationships".
 *      parseXml / parseMarkdown / parseJson invert the frozen renderer line formats (CONTRACT.md, "Renderer line
 *      formats"); preservationCheck parses the rendering back, deep-compares it with executorView(record), checks
 *      text containment of every name, identifier, number (with its unit), obligation, permission and unresolved
 *      condition (step 5 of "How the final compilation stage should work", line 84), and checks that nothing in
 *      the rendering lacks a source in the record.
 *   2. Structural editing      - "all required context and dependencies remain available".
 *      structuralEditingCheck extracts anchors (paths, identifiers, flags, quoted spans, numbers with units) from the
 *      draft and answers and reports those absent from the record as `dropped`. It is informative, never blocking.
 *   3. Semantic compression    - "meaning, obligation strength, exceptions and permissions survive".
 *      NOT checkable mechanically. The compile instruction asks the model to compare, and the user reviews the
 *      rendered prompt before applying it. Nothing here claims to cover it.
 *
 * Priority order from the document: semantic fidelity, then execution reliability, then cost.
 *
 * The whole task prompt is never converted to a compact tabular format (TOON etc.): the document supports compact
 * serialization only selectively for large uniform reference payloads, and there is no payload-compaction path in
 * this change. Token savings are not measured here (unknown until M9 CLI-reported usage).
 *
 * This module must not import ./compile (compile.ts imports this module).
 */
import { TaskRecord, ExecutorView, ExecutorStatement, Strength, Unresolved, executorView } from "./task-record";

export type RenderedFormat = "xml" | "prose" | "markdown" | "json";
export interface PreservationResult { ok: boolean; missing: string[]; extra: string[] }

// ---------------------------------------------------------------------------------------------------------------
// Frozen labels (CONTRACT.md, "Renderer line formats"). The parsers below invert exactly these strings.
// ---------------------------------------------------------------------------------------------------------------
const ASSUMED = "Assumed (unconfirmed): ";
const RATIONALE = " Rationale: ";
const ID_STRENGTH: Record<string, Strength> = { "preference": "preference", "exclusion": "exclusion", "accepted tradeoff": "tradeoff" };
const PREFIX_STRENGTH: Record<string, Strength> = { "Preference: ": "preference", "Exclusion: ": "exclusion", "Accepted tradeoff: ": "tradeoff" };
const UNRESOLVED_LABEL: Record<string, Unresolved> = {
  "Not provided: ": "not-provided", "Not applicable: ": "not-applicable", "Delegated to you: ": "user-delegated", "Must ask before proceeding: ": "must-ask",
};
const PERMISSION_LABEL: Record<string, keyof ExecutorView["permissions"]> = { "Authorized: ": "authorized", "Requires confirmation: ": "confirm", "Not authorized: ": "prohibited" };
const MD_SECTIONS = ["Source content", "Goal", "Context", "Requirements", "Acceptance", "Permissions", "Deliverable", "Unresolved matters"];
const XML_SECTIONS = ["goal", "context", "requirements", "acceptance", "permissions", "deliverable", "unresolved"];

/** Inverse of the renderer's XML escaping. `&amp;` last, so `&amp;lt;` becomes `&lt;` (a literal in the record). */
export function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

const emptyView = (): ExecutorView => ({
  outcome: { goal: "", deliverable: "", beneficiary: "" },
  context: { facts: [], identifiers: [], sources: [], dependencies: [] },
  success: { criteria: [] }, requirements: [],
  permissions: { authorized: [], confirm: [], prohibited: [] }, unresolved: [],
});
const stripPrefix = (s: string, prefix: string): string | undefined => s.startsWith(prefix) ? s.slice(prefix.length) : undefined;
/** Statement text as rendered: one line, so the parser trims it and the expected view is normalised the same way. */
export const inline = (s: string): string => s.replace(/\s*(?:\r\n|\r|\n)\s*/g, " ").trim();
const lines = (block: string): string[] => block.split("\n").map(l => l.trim()).filter(Boolean);
const counter = (prefix: string) => { let n = 0; return () => `${prefix}${++n}`; };
const statementOf = (s: string): ExecutorStatement => {
  const rest = stripPrefix(s, ASSUMED);
  return rest === undefined ? { text: s, assumed: false } : { text: rest, assumed: true };
};
/**
 * `<label><text>` where the assumed prefix may sit before or after the label. The contract fixes the prefix on the
 * statement text ("Depends on: Assumed (unconfirmed): x"); accepting it before the label as well (agent choice)
 * costs nothing and tolerates the other reading.
 */
function labelled<T>(s: string, labels: Record<string, T>): { value: T; statement: ExecutorStatement } | undefined {
  let assumed = false, t = s;
  const a = stripPrefix(t, ASSUMED);
  if (a !== undefined) { assumed = true; t = a; }
  for (const [label, value] of Object.entries(labels)) {
    const rest = stripPrefix(t, label);
    if (rest !== undefined) { const st = statementOf(rest); return { value, statement: { text: st.text, assumed: assumed || st.assumed } }; }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Line parsers shared by XML and Markdown (the Markdown lines are "the same lines as XML", some as list items).
// ---------------------------------------------------------------------------------------------------------------
/** "Exact identifiers: `a`, `b`." An identifier may itself contain a backtick; only the separator "`, `" is reserved. */
function parseIdentifiers(s: string): string[] {
  let t = s.endsWith(".") ? s.slice(0, -1) : s;
  if (!(t.startsWith("`") && t.endsWith("`") && t.length >= 2)) throw new Error(`malformed identifiers line: ${s}`);
  t = t.slice(1, -1);
  return t === "" ? [] : t.split("`, `");
}
function parseContextLine(line: string, view: ExecutorView): void {
  // An escaped fact: "Fact: <text>" or "Assumed (unconfirmed): Fact: <text>", its text taken verbatim (the renderer's factLine).
  const assumedFact = stripPrefix(line, ASSUMED), fact = stripPrefix(assumedFact ?? line, "Fact: ");
  if (fact !== undefined) { view.context.facts.push({ text: fact, assumed: assumedFact !== undefined }); return; }
  const ids = stripPrefix(line, "Exact identifiers: ");
  if (ids !== undefined) { view.context.identifiers.push(...parseIdentifiers(ids)); return; }
  const dep = labelled(line, { "Depends on: ": true });
  if (dep) { view.context.dependencies.push(dep.statement); return; }
  const who = stripPrefix(line, "For: ");
  if (who !== undefined) { view.outcome.beneficiary = who; return; }
  view.context.facts.push(statementOf(line));
}
/**
 * With IDs: "R1: text", "R2 (preference): text", "R3 (exclusion): text", "R4 (accepted tradeoff): text".
 * Without IDs: "- text", "- Preference: text", "- Exclusion: text", "- Accepted tradeoff: text".
 * Either form may carry the assumed prefix on the text. Since 4 November 2026 the rationale is its own following line,
 * "Rationale for R1: <rationale>" with IDs or "Rationale: <rationale>" without (parseRationaleLine); the requirement line's text is
 * taken whole, so a requirement containing " Rationale: " is no longer split.
 */
function parseRequirementLine(line: string, nextId: () => string): ExecutorView["requirements"][number] {
  const listed = line.startsWith("- ");   // the ID-less form always has the list marker (Markdown adds it to the ID form too)
  let s = listed ? line.slice(2) : line;
  let assumed = false, id: string | undefined, strength: Strength = "mandatory";
  const pre = stripPrefix(s, ASSUMED);
  if (pre !== undefined) { assumed = true; s = pre; }
  const m = /^(R[1-9]\d*)(?: \((preference|exclusion|accepted tradeoff)\))?: (.*)$/.exec(s);
  if (m) { id = m[1]; if (m[2]) strength = ID_STRENGTH[m[2]]; s = m[3]; }
  else if (!listed) throw new Error(`malformed requirement line: ${line}`);
  else for (const [label, st] of Object.entries(PREFIX_STRENGTH)) { const rest = stripPrefix(s, label); if (rest !== undefined) { strength = st; s = rest; break; } }
  const post = stripPrefix(s, ASSUMED);
  if (post !== undefined) { assumed = true; s = post; }
  if (!s) throw new Error(`malformed requirement line: ${line}`);
  return { text: s, assumed, id: id ?? nextId(), strength, rationale: "" };
}
/** A rationale line, attached to the requirement before it: "Rationale for R1: …" must name that requirement; "Rationale: …" (ID-less
 *  form, never list-marked) follows its requirement. Returns false when the line is not a rationale line. */
function parseRationaleLine(line: string, requirements: ExecutorView["requirements"]): boolean {
  const s = line.startsWith("- ") ? line.slice(2) : line;
  const named = /^Rationale for (R[1-9]\d*): (.*)$/.exec(s);
  const bare = !line.startsWith("- ") ? stripPrefix(line, "Rationale: ") : undefined;
  if (!named && bare === undefined) return false;
  const last = requirements.at(-1);
  if (!last || last.rationale || (named && named[1] !== last.id)) throw new Error(`rationale line without its requirement: ${line}`);
  last.rationale = named ? named[2] : bare!;
  return true;
}
const requirementOrRationale = (line: string, view: ExecutorView, nextId: () => string) => {
  if (!parseRationaleLine(line, view.requirements)) view.requirements.push(parseRequirementLine(line, nextId));
};
/** "A1: text Covers R1, R2." (the Covers suffix is absent when the acceptance covers nothing). */
function parseAcceptanceLine(line: string, nextId: () => string): ExecutorView["success"]["criteria"][number] {
  let s = line.startsWith("- ") ? line.slice(2) : line;
  const m = /^(A[1-9]\d*): (.*)$/.exec(s);
  if (!m) throw new Error(`malformed acceptance line: ${line}`);
  const id = m[1];
  s = m[2];
  let covers: string[] = [];
  const c = / Covers (R[1-9]\d*(?:, R[1-9]\d*)*)\.$/.exec(s);
  if (c) { covers = c[1].split(", "); s = s.slice(0, c.index); }
  if (!s) throw new Error(`malformed acceptance line: ${line}`);
  void nextId;   // acceptance never appears without IDs (IDs are emitted iff acceptance exists), so nothing is re-assigned here
  return { ...statementOf(s), id, covers };
}
/** "Authorized: a": one statement per line (since 3 November 2026; joining them with "; " broke on a statement containing "; "). */
function parsePermissionLine(line: string, view: ExecutorView): void {
  const s = line.startsWith("- ") ? line.slice(2) : line;
  for (const [label, key] of Object.entries(PERMISSION_LABEL)) {
    const rest = stripPrefix(s, label);
    if (rest !== undefined) { view.permissions[key].push(statementOf(rest)); return; }
  }
  throw new Error(`malformed permissions line: ${line}`);
}
function parseUnresolvedLine(line: string): ExecutorView["unresolved"][number] {
  const s = line.startsWith("- ") ? line.slice(2) : line;
  const u = labelled(s, UNRESOLVED_LABEL);
  if (!u) throw new Error(`malformed unresolved line: ${line}`);
  return { ...u.statement, state: u.value };
}

// ---------------------------------------------------------------------------------------------------------------
// Format parsers. Each is strict: text that fits no line format throws, naming the offending line, so that an
// invented line anywhere in a rendering is reported rather than silently absorbed.
// ---------------------------------------------------------------------------------------------------------------
/** Inverts renderXml. Whitespace-insensitive for indentation; source content is taken verbatim (escaping undone). */
export function parseXml(text: string): ExecutorView {
  const view = emptyView();
  let rest = text;
  const sc = /<source_content>\n?([\s\S]*?)\n?[ \t]*<\/source_content>/.exec(rest);
  if (sc) {
    // The label attribute is read greedily to the end of its line, so an unescaped quote inside a label still parses.
    const docRe = /<document label="(.*)">\n?([\s\S]*?)\n?[ \t]*<\/document>/g;
    let m: RegExpExecArray | null;
    while ((m = docRe.exec(sc[1]))) view.context.sources.push({ label: unescapeXml(m[1]), content: unescapeXml(m[2]) });
    const leftover = sc[1].replace(docRe, "").trim();
    if (leftover) throw new Error(`unexpected text in <source_content>: ${leftover.split("\n")[0]}`);
    rest = rest.slice(0, sc.index) + rest.slice(sc.index + sc[0].length);
  }
  const task = /<task>([\s\S]*?)<\/task>/.exec(rest);
  if (!task) throw new Error("no <task> element");
  const outside = (rest.slice(0, task.index) + rest.slice(task.index + task[0].length)).trim();
  if (outside) throw new Error(`unexpected text outside <task>: ${outside.split("\n")[0]}`);
  let body = task[1];
  const section = (name: string): string | undefined => {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
    if (!m) return undefined;
    body = body.slice(0, m.index) + body.slice(m.index + m[0].length);
    return m[1];
  };
  const nextR = counter("R"), nextA = counter("A");
  for (const name of XML_SECTIONS) {
    const inner = section(name);
    if (inner === undefined) continue;
    switch (name) {
      case "goal": view.outcome.goal = unescapeXml(inline(inner)); break;
      case "deliverable": view.outcome.deliverable = unescapeXml(inline(inner)); break;
      case "context": for (const l of lines(inner)) parseContextLine(unescapeXml(l), view); break;
      case "requirements": for (const l of lines(inner)) requirementOrRationale(unescapeXml(l), view, nextR); break;
      case "acceptance": for (const l of lines(inner)) view.success.criteria.push(parseAcceptanceLine(unescapeXml(l), nextA)); break;
      case "permissions": for (const l of lines(inner)) parsePermissionLine(unescapeXml(l), view); break;
      case "unresolved": for (const l of lines(inner)) view.unresolved.push(parseUnresolvedLine(unescapeXml(l))); break;
    }
  }
  const stray = body.trim();
  if (stray) throw new Error(`unexpected text in <task>: ${stray.split("\n")[0]}`);
  return view;
}

/** Inverts renderMarkdown. Fences of any length (>= 3) are honoured; everything between them is source content. */
export function parseMarkdown(text: string): ExecutorView {
  const view = emptyView();
  const ls = text.split("\n");
  const nextR = counter("R"), nextA = counter("A");
  const goal: string[] = [], deliverable: string[] = [];
  let i = 0, section: string | undefined;
  while (i < ls.length && !ls[i].trim()) i++;
  if ((ls[i] ?? "").trim() !== "# Task") throw new Error("Markdown does not start with '# Task'");
  i++;
  while (i < ls.length) {
    const line = ls[i].trim();
    if (!line) { i++; continue; }
    if (line.startsWith("## ")) {
      section = line.slice(3);
      if (!MD_SECTIONS.includes(section)) throw new Error(`unknown section: ${line}`);
      i++; continue;
    }
    switch (section) {
      case "Source content": {
        const label = stripPrefix(line, "### ");
        if (label === undefined) throw new Error(`expected a '### <label>' line: ${line}`);
        i++;
        while (i < ls.length && !ls[i].trim()) i++;
        const f = /^(`{3,})\w*\s*$/.exec(ls[i] ?? "");
        if (!f) throw new Error(`expected a fence after '### ${label}'`);
        const fence = f[1];
        i++;
        const content: string[] = [];
        while (i < ls.length && ls[i].trimEnd() !== fence) content.push(ls[i++]);
        if (i >= ls.length) throw new Error(`unterminated fence for '${label}'`);
        i++;
        view.context.sources.push({ label, content: content.join("\n") });
        continue;
      }
      case "Goal": goal.push(line); break;
      case "Deliverable": deliverable.push(line); break;
      case "Context": parseContextLine(line, view); break;
      case "Requirements": requirementOrRationale(line, view, nextR); break;
      case "Acceptance": view.success.criteria.push(parseAcceptanceLine(line, nextA)); break;
      case "Permissions": parsePermissionLine(line, view); break;
      case "Unresolved matters": view.unresolved.push(parseUnresolvedLine(line)); break;
      default: throw new Error(`unexpected text outside a section: ${line}`);
    }
    i++;
  }
  view.outcome.goal = goal.join(" ");
  view.outcome.deliverable = deliverable.join(" ");
  return view;
}

/** Inverts renderJson (JSON.stringify(executorView(record), null, 2)). */
export function parseJson(text: string): ExecutorView {
  const v: unknown = JSON.parse(text);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("JSON rendering is not an object");
  return v as ExecutorView;
}

// ---------------------------------------------------------------------------------------------------------------
// Preservation check.
// ---------------------------------------------------------------------------------------------------------------
/**
 * The executor view as the line-oriented renderings carry it: statement text on one line, trimmed (the contract
 * replaces newlines by a single space; the parsers trim). Source content is verbatim and is left alone. The JSON
 * rendering is exact, so it is compared with the raw view instead.
 */
export function normalisedView(view: ExecutorView): ExecutorView {
  const st = <T extends ExecutorStatement>(s: T): T => ({ ...s, text: inline(s.text) });
  return {
    outcome: { goal: inline(view.outcome.goal), deliverable: inline(view.outcome.deliverable), beneficiary: inline(view.outcome.beneficiary) },
    context: { facts: view.context.facts.map(st), identifiers: view.context.identifiers.map(inline),
      sources: view.context.sources.map(s => ({ label: inline(s.label), content: s.content })), dependencies: view.context.dependencies.map(st) },
    success: { criteria: view.success.criteria.map(a => ({ ...st(a), covers: [...a.covers] })) },
    requirements: view.requirements.map(r => ({ ...st(r), rationale: inline(r.rationale) })),
    permissions: { authorized: view.permissions.authorized.map(st), confirm: view.permissions.confirm.map(st), prohibited: view.permissions.prohibited.map(st) },
    unresolved: view.unresolved.map(st),
  };
}

interface Atom { path: string; text: string }
/** Every piece of record text the rendering must carry, with its field path. */
function atomsOf(view: ExecutorView): Atom[] {
  const out: Atom[] = [];
  const add = (path: string, text: string) => { if (text) out.push({ path, text }); };
  add("outcome.goal", view.outcome.goal); add("outcome.deliverable", view.outcome.deliverable); add("outcome.beneficiary", view.outcome.beneficiary);
  view.context.facts.forEach((s, i) => add(`context.facts[${i}].text`, s.text));
  view.context.identifiers.forEach((s, i) => add(`context.identifiers[${i}]`, s));
  view.context.sources.forEach((s, i) => { add(`context.sources[${i}].label`, s.label); add(`context.sources[${i}].content`, s.content); });
  view.context.dependencies.forEach((s, i) => add(`context.dependencies[${i}].text`, s.text));
  view.success.criteria.forEach((s, i) => add(`success.criteria[${i}].text`, s.text));
  view.requirements.forEach((s, i) => { add(`requirements[${i}].text`, s.text); add(`requirements[${i}].rationale`, s.rationale); });
  (["authorized", "confirm", "prohibited"] as const).forEach(k => view.permissions[k].forEach((s, i) => add(`permissions.${k}[${i}].text`, s.text)));
  view.unresolved.forEach((s, i) => add(`unresolved[${i}].text`, s.text));
  return out;
}
/** Numbers with an adjacent unit token ("24,000 characters", "120 s", "5%"), reported separately when their statement is missing. */
const numbersIn = (s: string): string[] => s.match(/(?<![\w.])\d[\d,]*(?:\.\d+)?(?:\s?(?:%|[A-Za-z]+))?/g) ?? [];

const canon = (v: unknown): string => JSON.stringify(v, (_k, val) =>
  val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.keys(val as object).sort().map(k => [k, (val as Record<string, unknown>)[k]])) : val);
/** Field-path diff. Arrays of equal length are compared index by index; otherwise by item equality, so a dropped item names itself. */
function diff(expected: unknown, actual: unknown, path: string, missing: string[], extra: string[]): void {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length === actual.length) { expected.forEach((e, i) => diff(e, actual[i], `${path}[${i}]`, missing, extra)); return; }
    const es = expected.map(canon), as = actual.map(canon);
    expected.forEach((e, i) => { if (!as.includes(es[i])) missing.push(`${path}[${i}] = ${JSON.stringify(e)}`); });
    actual.forEach((a, i) => { if (!es.includes(as[i])) extra.push(`${path}[${i}] = ${JSON.stringify(a)}`); });
    if (es.length !== as.length && es.every(x => as.includes(x)) && as.every(x => es.includes(x))) missing.push(`${path} has ${expected.length} items, rendering has ${actual.length}`);
    return;
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object" && !Array.isArray(expected) && !Array.isArray(actual)) {
    const e = expected as Record<string, unknown>, a = actual as Record<string, unknown>;
    for (const k of new Set([...Object.keys(e), ...Object.keys(a)])) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in a)) missing.push(`${p} = ${JSON.stringify(e[k])}`);
      else if (!(k in e)) extra.push(`${p} = ${JSON.stringify(a[k])}`);
      else diff(e[k], a[k], p, missing, extra);
    }
    return;
  }
  if (canon(expected) !== canon(actual)) { missing.push(`${path} = ${JSON.stringify(expected)}`); extra.push(`${path} = ${JSON.stringify(actual)}`); }
}

const jsonEncode = (s: string): string => JSON.stringify(s).slice(1, -1);
const XML_TAG = /<\/?(?:task|goal|context|requirements|acceptance|permissions|deliverable|unresolved|source_content)>|<document label=".*">|<\/document>/g;
const MD_FIXED = /^(?:# Task|## (?:Source content|Goal|Context|Requirements|Acceptance|Permissions|Deliverable|Unresolved matters)|`{3,}\w*)$/;
const JSON_KEY = /"(?:outcome|context|success|requirements|permissions|unresolved|goal|deliverable|beneficiary|facts|identifiers|sources|dependencies|criteria|authorized|confirm|prohibited|text|assumed|id|covers|strength|rationale|state|label|content)":/g;
// Booleans are stripped only as the value of the assumed field; a bare "true" or "false" inside a string value is record text
// and must stay for atom matching (m9 probe, the authored preservation regression).
const JSON_ASSUMED = /"assumed": (?:true|false)/g;
const JSON_ENUM = /"(?:mandatory|preference|exclusion|tradeoff|not-provided|not-applicable|user-delegated|must-ask)"/g;
const LABEL_WORDS = "Rationale for R[1-9]\\d*|Rationale|Fact|R[1-9]\\d*(?: \\((?:preference|exclusion|accepted tradeoff)\\))?|A[1-9]\\d*|Exact identifiers|Depends on|For|Authorized|Requires confirmation|Not authorized|Not provided|Not applicable|Delegated to you|Must ask before proceeding|Preference|Exclusion|Accepted tradeoff|Preferred|Done when|Deliver";
const LINE_LABEL = new RegExp(`^(?:- )?(?:Assumed \\(unconfirmed\\): )?(?:(?:${LABEL_WORDS}): )?`);
const PROSE_LABEL = new RegExp(`(?<=^|[.!?;] )(?:${LABEL_WORDS}): `, "g");
const COVERS = / Covers R[1-9]\d*(?:, R[1-9]\d*)*\.$/;
const ONLY_PUNCTUATION = /^[\s\p{P}\p{S}]*$/u;

/** Removes the fixed scaffolding of a format from one line, leaving only what must come from the record. */
function stripStructure(line: string, format: RenderedFormat): string {
  let s = line;
  if (format === "xml") s = unescapeXml(s.replace(XML_TAG, ""));
  else if (format === "markdown") { if (MD_FIXED.test(s)) return ""; s = s.replace(/^### /, ""); }
  else if (format === "json") s = s.replace(JSON_ASSUMED, "").replace(JSON_KEY, "").replace(JSON_ENUM, "");
  if (format === "prose") s = s.replace(PROSE_LABEL, "");
  else s = s.replace(LINE_LABEL, "").replace(COVERS, "");
  return s.trim();
}
/** Fixed strings that may sit between or inside atoms; removed only after the atoms, so that an atom containing them still matches. */
const stripInfixes = (s: string): string => s.split(RATIONALE).join(" ").split(ASSUMED).join("");
/**
 * A unit of rendered text (a line; a sentence for prose) has a source when, after the scaffolding and every atom are
 * removed, only punctuation remains; or, tolerantly, when it contains an atom of 3+ characters or sits inside one
 * (a line of source content). Anything else is text the record does not contain.
 */
function sourced(unit: string, format: RenderedFormat, atoms: string[], ids: string[]): boolean {
  const core = stripStructure(unit, format);
  if (!core) return true;
  let s = core;
  for (const a of atoms) s = s.split(a).join("");
  s = stripInfixes(s);
  for (const id of ids) s = s.split(id).join("");
  if (ONLY_PUNCTUATION.test(s)) return true;
  return atoms.some(a => (a.length >= 3 && core.includes(a)) || a.includes(core));
}

/**
 * Prose has no parse-back, so text containment alone let "Not authorized: deploy" become "Authorized: deploy" unnoticed (4 November 2026
 * review, item 2.3). Every permission, requirement strength, check and unresolved state must appear under its own label, and a requirement
 * must not appear under another strength's label: meaning, not just words.
 */
const PROSE_STRENGTH: Record<Strength, string> = { mandatory: "", preference: "Preferred: ", exclusion: "Exclusion: ", tradeoff: "Accepted tradeoff: " };
const PROSE_UNRESOLVED: Record<Unresolved, string> = { "not-provided": "Not provided: ", "not-applicable": "Not applicable: ", "user-delegated": "Delegated to you: ", "must-ask": "Must ask before proceeding: " };
function proseLabels(view: ExecutorView, text: string, missing: string[], extra: string[]) {
  const st = (s: ExecutorStatement) => (s.assumed ? ASSUMED : "") + s.text;
  const labelled = (label: string, body: string) => text.includes(label + body) && (label !== "" || !Object.values(PROSE_STRENGTH).some((l) => l && text.includes(l + body)));
  for (const [label, key] of Object.entries(PERMISSION_LABEL)) {
    const items = view.permissions[key];
    if (items.length && !text.includes(label + items.map(st).join("; "))) missing.push(`permissions.${key} not under "${label.trim()}" in prose`);
  }
  view.requirements.forEach((r, i) => {
    if (!labelled(PROSE_STRENGTH[r.strength], st(r))) missing.push(`requirements[${i}] not stated as ${r.strength} in prose`);
    for (const [s, l] of Object.entries(PROSE_STRENGTH)) if (l && s !== r.strength && text.includes(l + st(r))) extra.push(`requirements[${i}] stated as ${s} in prose`);
  });
  view.success.criteria.forEach((a, i) => { if (!text.includes("Done when: " + st(a))) missing.push(`success.criteria[${i}] not under "Done when" in prose`); });
  view.unresolved.forEach((u, i) => {
    if (!text.includes(PROSE_UNRESOLVED[u.state] + st(u))) missing.push(`unresolved[${i}] not under its ${u.state} label in prose`);
  });
}

/**
 * Step 5 of the document: the rendered prompt preserves the task record. For xml/markdown/json the rendering is parsed
 * back and deep-compared with the executor view (field paths that differ are reported); every rendering, prose
 * included, must contain every record text; and every line (sentence, for prose) must have a source in the record.
 * ok = nothing missing and nothing extra. compileDraft throws when ok is false.
 */
export function preservationCheck(record: TaskRecord, rendered: { format: RenderedFormat; text: string }): PreservationResult {
  const { format, text } = rendered;
  const raw = executorView(record);
  const view = format === "json" ? raw : normalisedView(raw);
  const missing: string[] = [], extra: string[] = [];
  if (format !== "prose") {
    try {
      const actual = format === "xml" ? parseXml(text) : format === "markdown" ? parseMarkdown(text) : parseJson(text);
      diff(view, actual, "", missing, extra);
    } catch (e) { extra.push(`parse (${format}): ${(e as Error).message}`); }
  }
  if (format === "prose") proseLabels(view, text, missing, extra);
  const encode = format === "json" ? jsonEncode : (s: string) => s;
  const haystack = format === "xml" ? unescapeXml(text) : text;
  const atoms = atomsOf(view);
  for (const a of atoms) {
    if (haystack.includes(encode(a.text))) continue;
    missing.push(`${a.path} not in rendered text: ${a.text}`);
    for (const n of numbersIn(a.text)) if (!haystack.includes(encode(n))) missing.push(`${a.path} number not in rendered text: ${n}`);
  }
  const encoded = [...new Set(atoms.map(a => encode(a.text)))].sort((x, y) => y.length - x.length);
  const ids = [...view.requirements.map(r => r.id), ...view.success.criteria.map(a => a.id)];
  const units = format === "prose" ? text.split(/(?<=[.!?])\s+|;\s+|\n/) : text.split("\n");
  for (const u of units) {
    const t = u.trim();
    if (t && !sourced(t, format, encoded, ids)) extra.push(`unsourced text: ${t}`);
  }
  const uniq = (xs: string[]) => [...new Set(xs)];
  return { ok: missing.length === 0 && extra.length === 0, missing: uniq(missing), extra: uniq(extra) };
}

// ---------------------------------------------------------------------------------------------------------------
// Structural editing check.
// ---------------------------------------------------------------------------------------------------------------
/**
 * Anchor patterns (agent choice; the document names the check, not the patterns):
 *   - file paths: two or more segments joined by / or \, optionally with a drive letter      src/board.ts, C:\x\y.txt
 *   - dotted identifiers: word.word(.word)*                                                   config.yaml, board.ts, Node.js
 *   - underscore identifiers                                                                  CLAUDE_CONFIG_DIR, snake_case
 *   - backticked spans and double-quoted spans (straight or curly quotes)                     `CLAUDE_CONFIG_DIR`, "keep JSON"
 *   - numbers with an adjacent unit token from UNITS                                          24,000 characters, 120 s, 5%
 *     a number without a known unit is an anchor only when it has 3+ digits or a # prefix     #42, 2026
 *   - command-line flags                                                                       --safe-mode
 *   - capitalised proper names of two or more words (optional pattern; sentence starters are skipped)
 * Anchors shorter than 3 characters, common words/abbreviations and anchors contained in a longer anchor are
 * dropped, to keep false positives low. Trailing sentence punctuation is stripped.
 */
const UNITS = new Set(["%", "s", "ms", "sec", "secs", "second", "seconds", "min", "mins", "minute", "minutes", "h", "hr", "hrs", "hour", "hours",
  "day", "days", "week", "weeks", "month", "months", "year", "years", "char", "chars", "character", "characters", "byte", "bytes", "kb", "mb", "gb",
  "kib", "mib", "gib", "px", "pt", "em", "rem", "token", "tokens", "item", "items", "line", "lines", "row", "rows", "column", "columns", "file", "files",
  "word", "words", "request", "requests", "call", "calls", "retry", "retries", "attempt", "attempts", "mm", "cm", "m", "km", "kg", "g", "usd", "eur", "gbp"]);
const COMMON = new Set(["e.g", "i.e", "etc", "and/or", "the", "and", "for", "with", "that", "this", "not", "but", "you", "are", "was", "yes", "ok", "vs"]);
const STARTERS = new Set(["The", "A", "An", "This", "That", "These", "Those", "Then", "When", "If", "But", "And", "Or", "So", "Also", "Please", "Make", "Add",
  "Use", "Keep", "Do", "Not", "It", "We", "I", "In", "On", "For", "After", "Before", "No", "Yes", "Maybe", "Just", "Now", "Here", "There", "Only"]);

/**
 * Whether a slash-joined candidate is a path rather than alternatives in prose (4 November 2026 review, item 24). "accounts/Claude",
 * "folders/Codex" and "F41/F32" were reported as dropped paths (0ebb27e8). A candidate is a path when it has a drive letter or a leading
 * ./ ../ or /, three or more parts, a trailing slash, or a dotted last part; a bare two-part pair is a path only when both parts are
 * lowercase words (src/worker), never when either is capitalised or an id like F41.
 */
export function isPathLike(candidate: string): boolean {
  const c = candidate.replace(/[.,;:!?)\]]+$/, "");
  if (/^(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])/.test(c) || /[\\/]$/.test(c)) return true;
  const parts = c.split(/[\\/]/).filter(Boolean);
  if (parts.length >= 3) return true;
  if (parts.length < 2) return false;
  if (/\.[A-Za-z0-9]{1,8}$/.test(parts[parts.length - 1])) return true;
  const word = (p: string) => /^[a-z][a-z0-9_-]*$/.test(p);
  return parts.every(word);
}

export function extractAnchors(text: string): string[] {
  const found: string[] = [];
  const take = (re: RegExp, map: (m: RegExpExecArray) => string | undefined = m => m[0]) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) { const a = map(m); if (a !== undefined) found.push(a); }
  };
  take(/(?:[A-Za-z]:[\\/]|\.{1,2}[\\/])?(?:[\w.-]+[\\/])+[\w.-]*/g, m => (isPathLike(m[0]) ? m[0] : undefined));
  take(/\b[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+/g);
  take(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g);
  take(/`([^`\n]+)`/g, m => m[1]);
  take(/["\u201c]([^"\u201c\u201d\n]+)["\u201d]/g, m => m[1]);
  take(/(?<![\w-])--?[A-Za-z][\w-]*/g);
  take(/(?<![\w.])(#?)(\d[\d,]*(?:\.\d+)?)(?:(\s?)(%|[A-Za-z]+\b))?/g, m => {
    const [, hash, num, sep, unit] = m;
    if (unit && UNITS.has(unit.toLowerCase())) return `${hash}${num}${sep}${unit}`;
    return hash || num.replace(/\D/g, "").length >= 3 ? `${hash}${num}` : undefined;
  });
  take(/\b[A-Z][a-z]+(?: [A-Z][a-z]+)+\b/g, m => { const w = m[0].split(" "); if (STARTERS.has(w[0])) w.shift(); return w.length >= 2 ? w.join(" ") : undefined; });
  // Numeric anchors were screened by their own rule above ("5%" is a valid two-character anchor); everything else needs 3+ characters.
  const cleaned = [...new Set(found.map(a => a.replace(/[.,;:!?)\]]+$/, "").trim()))].filter(a => (a.length >= 3 || /^#?\d/.test(a)) && !COMMON.has(a.toLowerCase()));
  return cleaned.filter(a => !cleaned.some(b => b !== a && b.includes(a)));
}
const allStrings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach(x => allStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach(x => allStrings(x, out));
  return out;
};
/**
 * The "structural editing" check of the document's table: "all required context and dependencies remain available".
 * This is a mechanical availability check, not a semantic one: it asks whether each anchor from the draft and the
 * answers appears anywhere in the record (JSON.stringify of the whole record plus every string in it, so conflicts
 * and unresolved items count). Anchors that are absent are returned as `dropped` for the user to review. A
 * superseded alternative ("or maybe config.yaml instead, no, keep JSON") is reported too, by design: the check is
 * informative, not blocking, and it never throws.
 */
export function structuralEditingCheck(draft: string, answers: string, record: TaskRecord): { dropped: string[]; sourceOnly: string[] } {
  // Since 4 November 2026 (review item 24) the check looks at what the executor gets, not the whole record: a draft copied whole into
  // sources made every anchor "present" (6e5efced). sourceOnly: anchors found only inside pasted source material, which keeps them
  // available but does not carry them as instructions. Both lists are advisory.
  const view = executorView(record), sources = view.context.sources.map(s => `${s.label}\n${s.content}`).join("\n");
  // Conflicts are not sent, but an unfinished record shows them to the user, so an anchor named there is not lost.
  const instructions = allStrings([{ ...view, context: { ...view.context, sources: [] } }, record.conflicts]).join("\n");
  const anchors = extractAnchors(`${draft}\n${answers}`).filter(a => !instructions.includes(a));
  return { dropped: anchors.filter(a => !sources.includes(a)), sourceOnly: anchors.filter(a => sources.includes(a)) };
}
