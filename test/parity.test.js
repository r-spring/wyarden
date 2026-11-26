// The board's visible text must match docs/parity/FEATURES.md, the feature list both machines check against.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseSpec, extract } = require("../tools/parity.js");

const root = path.join(__dirname, "..");

test("parity: the Windows board matches docs/parity/FEATURES.md", () => {
  const r = spawnSync(process.execPath, [path.join(root, "tools", "parity.js"), "--side", "windows"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /No drift for this side\./);
});

// 4 November 2026: linux's side was red on main (F19 "Open in editor", which is in the helper tab, media/helper-tab.js) and no test saw it.
test("parity: the linux board matches docs/parity/FEATURES.md, helper tab included", () => {
  const r = spawnSync(process.execPath, [path.join(root, "tools", "parity.js"), "--side", "linux"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /No drift for this side\./);
});

test("parity: piped through stdin (how another branch can run it from main) it still runs and reports", () => {
  const source = require("node:fs").readFileSync(path.join(root, "tools", "parity.js"), "utf8");
  const r = spawnSync(process.execPath, ["-", "--side", "windows"], { cwd: root, input: source, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Parity check, side windows:.*\n[\s\S]*No drift for this side\./);
});

test("parity spec: one-side text is refused once both sides are done", () => {
  const spec = parseSpec(['## F01 X', '- windows: done abc', '- linux: done def', '- ui: "A"', '- only-windows: "Old A"'].join("\n"));
  assert.ok(spec.errors.some((e) => /only-windows/.test(e)), spec.errors.join("; "));
});

test("parity spec: every feature needs both statuses, and same-text must point to listed text", () => {
  const spec = parseSpec(['## F01 X', '- windows: done abc', '- ui: "A"', '- same-text: "B" "C"'].join("\n"));
  assert.ok(spec.errors.some((e) => /no linux status/.test(e)));
  assert.ok(spec.errors.some((e) => /same-text "C" points to "B"/.test(e)));
});

test("parity extract: templates become {} placeholders; CSS classes and message types are skipped", () => {
  const found = extract('const n = 2; el("p", { className: "muted", textContent: `${n} prompts · ${"x"}` }); send("refine"); button("Add task");', "t.js");
  assert.deepEqual([...found.keys()].sort(), ["Add task", "{} prompts · {}"]);
});

test("parity spec: merge conflict markers are refused with the file and line", () => {
  const text = ['## F01 X', '<<<<<<< HEAD', '- windows: done abc', '=======', '- windows: todo', '>>>>>>> task/x', '- linux: done def', '- ui: "A"'].join("\n");
  const spec = parseSpec(text, "FEATURES.md");
  for (const [line, marker] of [[2, "<<<<<<< HEAD"], [4, "======="], [6, ">>>>>>> task/x"]])
    assert.ok(spec.errors.some((e) => e.startsWith(`FEATURES.md:${line}: merge conflict marker "${marker}"`)), spec.errors.join("; "));
  // Lookalikes are not markers: the marker text inside a line, or a longer rule of equals signs.
  assert.deepEqual(parseSpec(['## F01 X', '- windows: done a', '- linux: done b', '- what: see <<<<<<< HEAD', '========'].join("\n")).errors, []);
});

test("parity: a spec with conflict markers fails the command with exit 2, naming the file and line", () => {
  const fs = require("node:fs"), os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-parity-"));
  const spec = path.join(dir, "FEATURES.md");
  const lines = fs.readFileSync(path.join(root, "docs", "parity", "FEATURES.md"), "utf8").split("\n");
  lines.splice(3, 0, "<<<<<<< HEAD");
  fs.writeFileSync(spec, lines.join("\n"));
  try {
    const r = spawnSync(process.execPath, [path.join(root, "tools", "parity.js"), "--side", "windows", "--spec", spec], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.ok(r.stderr.includes(`${spec}:4: merge conflict marker "<<<<<<< HEAD"`), r.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("parity spec: a second status line for one side (a sloppy merge) is refused", () => {
  const spec = parseSpec(['## F01 X', '- windows: done abc', '- linux: done def', '- linux: todo', '- ui: "A"'].join("\n"), "FEATURES.md");
  assert.ok(spec.errors.includes("FEATURES.md:4: F01 has a second linux status line"), spec.errors.join("; "));
});
