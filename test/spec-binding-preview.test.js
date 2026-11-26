// Phase 1 of docs/plans/MASTER-PLAN-capability-profiles-and-orchestration.md (AC-G, AC-H), gap from phase-1.md: the Improve preview names
// a setting the form's own options change. Plan first on a Codex account fixes Astra at ultra (media/board.js formOverrides, syncChoices).
// Kept apart from spec-binding.test.js, which other cards are editing at the same time.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cdp = require("./compile-webview-cdp");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ab-spec-preview-"));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const RECORD = { version: 1, status: "ready", outcome: { goal: "Plan the CSV export.", deliverable: "", beneficiary: "" },
  context: { facts: [], identifiers: [], sources: [], dependencies: [] }, success: { criteria: [] },
  requirements: [{ id: "R1", text: "Plan the CSV export.", provenance: "user", strength: "mandatory", rationale: "" }],
  permissions: { authorized: [], confirm: [], prohibited: [] }, unresolved: [], conflicts: [] };

test("webview: Plan first on Codex is named in the preview and binds Astra at ultra; unticking it is a settings change that refuses Apply", { timeout: 120_000 }, async (t) => {
  if (!cdp.edgePath()) { t.skip("Microsoft Edge, Chrome or Chromium is not available on this machine; the webview scenario was not run."); return; }
  const url = require("node:url").pathToFileURL(path.resolve(__dirname, "compile-webview-harness.html")).href;
  let edge, page;
  try {
    try { edge = await cdp.launchEdge(url, fs.mkdtempSync(path.join(scratch, "edge-"))); } catch (e) { t.skip(`Edge could not be launched: ${e.message}`); return; }
    const target = await cdp.waitFor(async () => (await cdp.listTargets(edge.port)).find((x) => x.type === "page" && x.url.toLowerCase() === url.toLowerCase()), "the harness page");
    page = await cdp.Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.waitFor(() => page.evaluate("window.__ready === true"), "board.js to finish loading");
    await page.evaluate(cdp.HELPERS);
    const ev = (expr) => page.evaluate(expr);
    const tick = (on) => ev(`(() => { const b = document.getElementById("planFirst"); b.checked = ${on}; b.dispatchEvent(new Event("change")); return true; })()`);

    await ev(`window.__host({ tasks: [], live: [], own: [], accounts: ["acct", "cx"], helperModels: { codex: "luna · high effort" },
      codex: { accounts: ["cx"], models: [{ model: "gpt-6.1-sol", efforts: ["high", "ultra"] }],
        short: [{ name: "astra", id: "gpt-6.1-astra", label: "Astra" }, { name: "sol", id: "gpt-6.1-sol", label: "Sol" }] } }); true`);
    await ev(`__h.select("Account for new task", "cx"); __h.select("Model for new task", "gpt-6.1-sol"); true`);
    await tick(true);
    const D = "Plan the CSV export.";
    await ev(`__h.setBox(${JSON.stringify(D)}); __h.click("Improve prompt")`);
    const req = await ev("__h.lastCompile()");
    assert.deepEqual([req.account, req.model, req.effort], ["cx", "astra", "ultra"], "Improve carries the settings the task will really run with");
    const controls = { account: "cx", model: "astra", effort: "ultra", permission: req.permission };
    await ev(`__h.inject(${JSON.stringify({ requestId: req.requestId, target: "new", original: D, status: "ready", record: RECORD, rendered: { format: "prose", text: "Plan it." },
      conflicts: [], model: "claude-fable-5-2", effort: "max", promptVersion: "p", controls, bindable: true })})`);
    const muted = await ev("__h.muted()");
    assert.ok(muted.some((m) => m.startsWith("Runs with your settings: cx · astra · ultra effort")), muted.join(" | "));
    assert.ok(muted.includes("Plan first on Codex runs Astra at ultra effort."), muted.join(" | "));
    assert.ok((await ev("__h.buttons()")).includes("Apply improved prompt"));

    // Unticking brings back the picked model, which differs from what Improve bound: Apply is refused and the note goes.
    await tick(false);
    assert.ok((await ev("__h.buttons()")).includes("Apply improved prompt (disabled)"));
    assert.ok(!(await ev("__h.muted()")).includes("Plan first on Codex runs Astra at ultra effort."));
    assert.match((await ev("__h.alerts()"))[0], /^Settings changed after Improve \(model: astra → gpt-6\.1-sol; effort: ultra → /);
  } finally {
    page?.close();
    if (edge) await edge.kill();
  }
});
