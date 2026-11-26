// Dry run: renders every case in every condition with the compiled renderers (out/compile.js) and writes
// out/<case>/<condition>.prompt.txt plus out/render-sizes.json (characters and lines, NOT tokens). Runs the
// mechanical preservation check (out/compile-check.js preservationCheck) on the three main formats when that
// module exists; a check that throws or is missing is reported as "unknown", never as a pass.
// Usage: node eval/compile-format/render.js [--out <dir>] [--cases <dir>]
"use strict";
const fs = require("fs");
const path = require("path");
const { OUT, CASES_DIR, loadCases, loadManifest, renderAll, optionalOut, requireOut, saveJson, sha256 } = require("./lib");

function args(argv) {
  const o = { out: OUT, cases: CASES_DIR };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") o.out = path.resolve(argv[++i]);
    else if (argv[i] === "--cases") o.cases = path.resolve(argv[++i]);
  }
  return o;
}

function preservation(record, format, text) {
  const check = optionalOut("compile-check");
  if (!check || typeof check.preservationCheck !== "function") return { status: "unknown", why: "out/compile-check.js has no preservationCheck" };
  try {
    // A check that accepts a garbage rendering is a stub (the module says "being filled in"); its "ok" proves nothing.
    const probe = check.preservationCheck(record, { format, text: "not a rendering" });
    if (probe && probe.ok === true) return { status: "unknown", why: "preservationCheck accepted a garbage rendering (stub); real check pending" };
    const r = check.preservationCheck(record, { format, text });
    if (r && r.ok === true) return { status: "pass" };
    return { status: "fail", missing: r?.missing, extra: r?.extra };
  } catch (e) { return { status: "unknown", why: e.message }; }
}

function render(options = args(process.argv.slice(2)), log = console.log) {
  const manifest = loadManifest();
  const { validTaskRecord } = requireOut("task-record");
  const conditions = [...manifest.formats, manifest.shortening.condition];
  const cases = loadCases(options.cases);
  const sizes = { unit: "characters and lines of the rendered prompt; token counts are unknown until CLI-reported usage exists (no counting endpoint is used)", cases: {} };
  const checks = {};
  let failures = 0;
  for (const c of cases) {
    const record = validTaskRecord(c.record);
    const rendered = renderAll(record);
    sizes.cases[c.id] = {};
    checks[c.id] = {};
    for (const condition of conditions) {
      const text = rendered[condition];
      if (typeof text !== "string" || !text.length) throw new Error(`${c.id}: renderer for ${condition} returned no text`);
      const file = path.join(options.out, c.id, `${condition}.prompt.txt`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      sizes.cases[c.id][condition] = { characters: text.length, lines: text.split("\n").length, sha256: sha256(text) };
      if (manifest.formats.includes(condition)) {
        const p = preservation(record, condition, text);
        checks[c.id][condition] = p;
        if (p.status === "fail") { failures++; log(`FAIL preservation ${c.id} ${condition}: missing=${JSON.stringify(p.missing)} extra=${JSON.stringify(p.extra)}`); }
      }
    }
    const line = conditions.map(k => `${k}=${sizes.cases[c.id][k].characters}c/${sizes.cases[c.id][k].lines}l`).join(" ");
    const pc = manifest.formats.map(k => `${k}:${checks[c.id][k].status}`).join(" ");
    log(`rendered ${c.id}: ${line} | preservation ${pc}`);
  }
  saveJson(path.join(options.out, "render-sizes.json"), sizes);
  saveJson(path.join(options.out, "preservation-checks.json"), checks);
  const statuses = Object.values(checks).flatMap(c => Object.values(c).map(p => p.status));
  const count = (s) => statuses.filter(x => x === s).length;
  log(`\nrender: ${cases.length} cases x ${conditions.length} conditions written under ${options.out}`);
  log(`preservation checks: pass ${count("pass")}, fail ${count("fail")}, unknown ${count("unknown")} (unknown = the check module threw or is missing; it is not a pass)`);
  if (count("unknown")) { const why = [...new Set(Object.values(checks).flatMap(c => Object.values(c).filter(p => p.status === "unknown").map(p => p.why)))]; log(`unknown reasons: ${why.join(" | ")}`); }
  return { ok: failures === 0, failures, sizes, checks };
}

if (require.main === module) process.exitCode = render().ok ? 0 : 1;
module.exports = { render, preservation };
