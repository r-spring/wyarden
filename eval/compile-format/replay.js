#!/usr/bin/env node
// Replays the regression set (prompt-prep.json) through the current Refine and Improve prompts (4 November 2026 review, item 3.5).
//
//   node eval/compile-format/replay.js --manifest eval/compile-format/prompt-prep.json --dry-run
//   node eval/compile-format/replay.js --manifest ... --provider claude [--config-dir <account folder>] [--case forecast] [--include-held-out]
//   node eval/compile-format/replay.js --manifest ... --provider codex --codex <path to codex>
//
// --dry-run (the default when no --provider is given) calls no model: it reports what would be sent, from which stored input.
// A live run uses the maximum policy (Claude Fable at max effort, or the newest Astra at ultra), spends usage, and writes only under
// eval/compile-format/out/replay/<run id>/. Stored receipts are read, hashed before and after, and never changed. A case whose input
// was not stored is refused, never guessed. Held-out cases are skipped unless --include-held-out is given.
"use strict";
const fs = require("fs");
const path = require("path");
const lib = require("./lib");

/** A selection error: the CLI exits 2 before anything is replayed or printed (EVC-A-04). */
const usage = (message) => Object.assign(new Error(message), { exitCode: 2 });

function args(argv) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  return { manifest: get("--manifest") || path.join(__dirname, "prompt-prep.json"), provider: get("--provider"), configDir: get("--config-dir") || "",
    codex: get("--codex"), only: get("--case"), heldOut: argv.includes("--include-held-out"), dryRun: argv.includes("--dry-run") || !get("--provider") };
}

/** The exact stored input of a case, or why there is none. Reads only. */
function storedInput(c, roots, manifestDir) {
  if (c.draft !== undefined) return { draft: c.draft, answers: c.answers || "", executor: "", context: "", source: "authored" };
  if (!roots[c.root]) return { refused: `helpers root ${c.root} not found in the manifest` };
  const root = path.resolve(manifestDir, roots[c.root]);
  if (!fs.existsSync(root)) return { refused: `helpers root ${c.root} not found at ${root}` };
  const folder = fs.readdirSync(root).find((d) => d.startsWith(c.helper));
  if (!folder) return { refused: `helper folder ${c.helper} not found under ${root}` };
  const dir = path.join(root, folder);
  for (const name of ["compile-receipt.json", "refine-receipt.json"]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const r = lib.readJson(file);
    if (typeof r.draft !== "string") return { refused: `${name} in ${folder} has no draft` };
    return { draft: r.draft, answers: r.answers || "", executor: r.executor || "", context: r.context || "", source: path.join(dir, name),
      sourceHash: lib.sha256(fs.readFileSync(file, "utf8")), storedPromptVersion: r.promptVersion || null };
  }
  return { refused: `${folder} stored no input (output-only): replay refused` };
}

async function main(argv) {
  const a = args(argv);
  const manifest = lib.readJson(a.manifest), manifestDir = path.dirname(path.resolve(a.manifest));
  if (argv.includes("--case") && !a.only) throw usage("--case needs a case id");
  if (a.only && !manifest.cases.some((c) => c.id === a.only)) throw usage(`unknown case "${a.only}"`);
  const cases = manifest.cases.filter((c) => (!a.only || c.id === a.only) && (a.heldOut || c.split !== "held-out"));
  if (!cases.length) throw usage("empty selection: no case left (a held-out case needs --include-held-out)");
  const compile = lib.requireOut("compile"), text = lib.requireOut("text-actions");
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(lib.OUT, "replay", runId);
  const policy = a.provider === "codex" ? { model: "gpt-6-astra", effort: "ultra" } : { model: "fable", effort: "max" };
  const rows = [];
  for (const c of cases) {
    const input = storedInput(c, manifest.roots, manifestDir);
    if (input.refused) { rows.push({ case: c.id, kind: c.kind, status: "refused", reason: input.refused }); continue; }
    const packet = c.kind === "improve" ? compile.compilePrompt(input.draft, input.answers, { executor: input.executor || undefined, context: input.context || undefined })
      : text.refinePrompt(input.draft, input.answers, input.context, input.executor);
    const row = { case: c.id, kind: c.kind, split: c.split, source: input.source, storedPromptVersion: input.storedPromptVersion ?? null,
      currentPromptVersion: c.kind === "improve" ? compile.COMPILE_PROMPT_VERSION : text.REFINE_PROMPT_VERSION, draftChars: input.draft.length, packetChars: packet.length };
    if (a.dryRun) { rows.push({ ...row, status: "dry-run" }); continue; }
    const dir = path.join(outDir, c.id), signal = new AbortController().signal, started = Date.now();
    try {
      const codexPath = a.provider === "codex" ? a.codex : undefined;
      if (a.provider === "codex" && !codexPath) throw new Error("--codex <path> is needed for a Codex replay");
      if (c.kind === "improve") {
        const r = await compile.compileDraft(dir, input.draft, input.answers, a.configDir, policy.model, policy.effort, signal, [], codexPath, { executor: input.executor || undefined, context: input.context || undefined });
        Object.assign(row, { status: "done", outcome: r.record.status, format: r.rendered?.format ?? null, renderedChars: r.rendered?.text.length ?? 0, tally: r.tally,
          quarantined: r.quarantined.length, dropped: r.dropped, oversize: r.oversize ?? null, model: r.model, usage: r.usage });
      } else {
        const r = await text.generateText(dir, "refine", input.draft, a.configDir, policy.model, input.answers, signal, policy.effort, codexPath, [], input.context, undefined, input.executor);
        Object.assign(row, { status: "done", outcome: r.value.kind, revisionChars: r.value.revision.length, questions: r.value.questions.length, model: r.model, usage: r.usage });
      }
    } catch (e) { Object.assign(row, { status: "failed", error: e instanceof Error ? e.message : String(e) }); }
    row.elapsedMs = Date.now() - started;
    if (input.sourceHash && lib.sha256(fs.readFileSync(input.source, "utf8")) !== input.sourceHash) row.sourceChanged = true; // must never happen
    rows.push(row);
  }
  const report = { runId, dryRun: a.dryRun, provider: a.provider || null, policy: a.dryRun ? null : policy, rows };
  if (!a.dryRun) lib.saveJson(path.join(outDir, "replay.json"), report);
  console.log(JSON.stringify(report, null, 2));
  return rows.some((r) => r.sourceChanged) ? 2 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e.exitCode ? e.message : e); process.exitCode = e.exitCode ?? 1; });
module.exports = { storedInput, main };
