#!/usr/bin/env node
// Entomatical parity check: compares the board's visible text with docs/parity/FEATURES.md.
// The spec is the feature list both machines check against (windows and linux, both building main).
// Each side may implement a feature its own way; the visible UI text must match the spec.
//
//   node tools/parity.js                      check this checkout (side from the platform)
//   node tools/parity.js --side linux        check as the Linux side
//   node tools/parity.js --spec-ref origin/main   read the spec from a git ref (for example from another branch)
//   node tools/parity.js --board <file>       check another board.js
//   node tools/parity.js --dump               list the visible strings found, with line numbers
//   node tools/parity.js --status             print the feature table for both sides
//
// Run it from a branch that lacks this file with:  git show origin/main:tools/parity.js | node - --spec-ref origin/main
// Exit code 0 = no drift for this side, 1 = drift, 2 = usage or parse error.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SPEC_PATH = "docs/parity/FEATURES.md";
const BOARD_PATH = "media/board.js";
// Helper and plan-setup surfaces count as present for a feature's ui list, but only board.js reports unlisted text.
const OTHER_UI = ["media/helper-tab.js", "media/plan-setup.js", "media/plan-graph.js", "media/plan-presets.js"];
const SIDES = ["windows", "linux"];
const UI_PROPS = new Set(["textContent", "title", "placeholder", "ariaLabel", "label"]);

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }
function flag(name) { return process.argv.includes(name); }

/** Parses FEATURES.md: "## F07 Name" headings, "- windows:" / "- linux:" status lines, "- ui:" string lists.
 * `file` only names the spec in error messages. */
function parseSpec(text, file = SPEC_PATH) {
  const features = [], ignore = new Set(), errors = [], aliases = new Map();
  let cur = null;
  const strings = (line) => [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  text.split(/\r?\n/).forEach((line, i) => {
    // A merge that left conflict markers still parses (the markers match nothing), so they are refused outright.
    if (/^(<<<<<<<|>>>>>>>|\|\|\|\|\|\|\|) |^=======$/.test(line)) { errors.push(`${file}:${i + 1}: merge conflict marker "${line}"; resolve the merge first`); return; }
    const h = line.match(/^## (F\d{2,3}) (.+)$/);
    if (h) { cur = { id: h[1], name: h[2].trim(), status: {}, ui: [], only: { windows: [], linux: [] }, line: i + 1 }; features.push(cur); return; }
    if (/^## /.test(line)) { cur = /^## Not UI/.test(line) ? "ignore" : null; return; }
    const m = line.match(/^- (windows|linux|ui|only-windows|only-linux|same-text|ignore):\s*(.*)$/);
    if (!m) return;
    if (cur === "ignore" && m[1] === "ignore") { strings(m[2]).forEach((s) => ignore.add(s)); return; }
    if (!cur || cur === "ignore") return;
    if (m[1] === "ui") cur.ui.push(...strings(m[2]));
    // "same-text": the first string is in ui; the others are the same visible text built differently in code.
    else if (m[1] === "same-text") { const [canon, ...alts] = strings(m[2]); for (const a of alts) aliases.set(a, canon); }
    else if (m[1].startsWith("only-")) cur.only[m[1].slice(5)].push(...strings(m[2]));
    else {
      const s = m[2].trim();
      // Two status lines for one side are a sloppy merge: the later one would silently win.
      if (cur.status[m[1]] !== undefined) errors.push(`${file}:${i + 1}: ${cur.id} has a second ${m[1]} status line`);
      if (!/^(done|todo|n\/a)\b/.test(s)) errors.push(`line ${i + 1}: ${cur.id} ${m[1]} status must start with done, todo or n/a`);
      cur.status[m[1]] = s;
    }
  });
  const seen = new Map();
  for (const f of features) {
    for (const side of SIDES) if (!f.status[side]) errors.push(`line ${f.line}: ${f.id} has no ${side} status`);
    if (seen.has(f.id)) errors.push(`line ${f.line}: ${f.id} is used twice`);
    seen.set(f.id, f);
  }
  const owner = new Map();
  for (const f of features) for (const s of [...f.ui, ...f.only.windows, ...f.only.linux]) {
    if (owner.has(s) && owner.get(s) !== f.id) errors.push(`"${s}" is listed under both ${owner.get(s)} and ${f.id}`);
    owner.set(s, f.id);
  }
  for (const f of features) for (const side of SIDES) {
    // A one-side string is a recorded difference. It is allowed only while the other side's version is still to build.
    if (f.only[side].length && f.status[side === "windows" ? "linux" : "windows"]?.startsWith("done") && f.status[side]?.startsWith("done"))
      errors.push(`line ${f.line}: ${f.id} is done on both sides but still has only-${side} text; make the UI the same and delete the line`);
  }
  for (const [alt, canon] of aliases) if (!owner.has(canon)) errors.push(`same-text "${alt}" points to "${canon}", which no feature lists under ui`);
  return { features, ignore, owner, aliases, errors };
}

/** Visible strings in board.js. Templates become text with {} for each ${...}. */
function extract(source, file) {
  let ts;
  try { ts = require("typescript"); } catch { ts = require(path.join(process.cwd(), "node_modules", "typescript")); }
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = new Map();
  const add = (text, node) => {
    const t = text.trim();
    if (!t || !/[\p{L}\p{So}×]/u.test(t.replace(/\{\}/g, ""))) return; // only placeholders and punctuation
    if (!found.has(t)) found.set(t, sf.getLineAndCharacterOfPosition(node.getStart()).line + 1);
  };
  const uiContext = (node) => {
    const p = node.parent;
    if (ts.isPropertyAssignment(p) && UI_PROPS.has(p.name.getText())) return true;
    if (ts.isCallExpression(p) && p.arguments[0] === node && p.expression.getText() === "button") return true;
    return false;
  };
  const visit = (node) => {
    let text;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) text = node.head.text + node.templateSpans.map((s) => "{}" + s.literal.text).join("");
    if (text !== undefined) {
      const t = text.trim();
      // Capitalised, symbol-led or placeholder-led text, or any text in a UI property; imports and keys are skipped.
      if (!ts.isImportDeclaration(node.parent) && !ts.isPropertyAccessExpression(node.parent)
        && (/^[\p{Lu}\p{So}×↩↳⚙⏹]/u.test(t) || /^\{\}/.test(t) || uiContext(node))) add(text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function readSpec() {
  const ref = arg("--spec-ref");
  if (ref) return execFileSync("git", ["show", `${ref}:${SPEC_PATH}`], { encoding: "utf8" });
  return fs.readFileSync(arg("--spec") || SPEC_PATH, "utf8");
}

function main() {
  const side = arg("--side") || (process.platform === "win32" ? "windows" : "linux");
  if (!SIDES.includes(side)) { console.error(`--side must be one of ${SIDES.join(", ")}`); return 2; }
  const ref = arg("--spec-ref");
  const spec = parseSpec(readSpec(), ref ? `${ref}:${SPEC_PATH}` : arg("--spec") || SPEC_PATH);
  if (spec.errors.length) { console.error("Spec errors:\n  " + spec.errors.join("\n  ")); return 2; }

  if (flag("--status")) {
    console.log("| ID | Feature | windows | linux |\n|---|---|---|---|");
    for (const f of spec.features) console.log(`| ${f.id} | ${f.name} | ${f.status.windows} | ${f.status.linux} |`);
    return 0;
  }

  const boardFile = arg("--board") || BOARD_PATH;
  const raw = extract(fs.readFileSync(boardFile, "utf8"), boardFile);
  if (flag("--dump")) { for (const [s, line] of [...raw].sort((a, b) => a[1] - b[1])) console.log(`${line}\t${s}`); return 0; }
  const found = new Map();
  for (const [s, l] of raw) { const c = spec.aliases.get(s) ?? s; if (!found.has(c)) found.set(c, l); }
  const present = new Set(found.keys());
  if (!arg("--board")) for (const file of OTHER_UI) for (const s of extract(fs.readFileSync(file, "utf8"), file).keys()) present.add(spec.aliases.get(s) ?? s);

  const other = side === "windows" ? "linux" : "windows";
  const done = spec.features.filter((f) => f.status[side].startsWith("done"));
  const missing = [];
  for (const f of done) for (const s of f.ui) if (!present.has(s)) missing.push(`${f.id} ${f.name}: "${s}"`);
  const foreign = new Set(spec.features.flatMap((f) => f.only[other]));
  const unlisted = [...found].filter(([s]) => (!spec.owner.has(s) || foreign.has(s)) && !spec.ignore.has(s))
    .map(([s, l]) => `${boardFile}:${l} "${s}"${foreign.has(s) ? ` (recorded as ${other}-only)` : ""}`);
  const exceptions = spec.features.filter((f) => f.only[side].length).map((f) => `${f.id} ${f.name}: ${f.only[side].map((s) => `"${s}"`).join(", ")}`);
  const early = [];
  for (const f of spec.features) if (!f.status[side].startsWith("done") && f.ui.length && f.ui.every((s) => present.has(s))) early.push(`${f.id} ${f.name}`);
  const todo = spec.features.filter((f) => f.status[side].startsWith("todo")).map((f) => `${f.id} ${f.name}`);

  console.log(`Parity check, side ${side}: ${spec.features.length} features in the spec, ${done.length} done here, ${found.size} visible strings in ${boardFile}.`);
  const section = (title, rows) => { if (rows.length) console.log(`\n${title} (${rows.length}):\n  ${rows.join("\n  ")}`); };
  section("MISSING: text the spec requires for a feature marked done on this side", missing);
  section("UNLISTED: visible text that no feature in the spec owns (add it to the spec, or change the UI to match)", unlisted);
  section("Marked not done here, but all its text is present (update the status?)", early);
  section("Recorded differences on this side (allowed until the other version is built here)", exceptions);
  section("Still to check on this side", todo);
  const drift = missing.length + unlisted.length;
  console.log(drift ? `\nDRIFT: ${missing.length} missing, ${unlisted.length} unlisted.` : "\nNo drift for this side.");
  return drift ? 1 : 0;
}

// "[stdin]" is how Node names a script piped in with `node -`, for running it against another branch.
if (require.main === module || module.id === "[stdin]") process.exitCode = main();
module.exports = { parseSpec, extract };
