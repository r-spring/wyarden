const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { change } = require("../tools/codex-panel-patch.cjs");

test("the version-pinned panel patch installs, updates and restores only its own files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-panel-patch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "out"));
  const entry = path.join(root, "out", "extension.js"), sidecar = path.join(root, "out", "entomatical-panel-bridge.cjs");
  const original = 'a;let ft=new hL($e,mt);b;this.isPanelAlive(r)&&(r.title=jje(c));';
  const spec = { version: "test", sha256: crypto.createHash("sha256").update(original).digest("hex"),
    activation: "let ft=new hL($e,mt);", title: "this.isPanelAlive(r)&&(r.title=jje(c))" };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ publisher: "openai", name: "chatgpt", version: "test" }));
  fs.writeFileSync(entry, original);
  const bridge = path.join(root, "bridge.cjs"); fs.writeFileSync(bridge, "first bridge");
  assert.match(change(root, "install", spec, bridge), /Installed/);
  assert.match(fs.readFileSync(entry, "utf8"), /entomatical-panel-bridge/);
  assert.equal(fs.readFileSync(sidecar, "utf8"), "first bridge");
  fs.writeFileSync(bridge, "updated bridge");
  change(root, "install", spec, bridge);
  assert.equal(fs.readFileSync(sidecar, "utf8"), "updated bridge");
  fs.writeFileSync(sidecar, "independent change");
  assert.throws(() => change(root, "remove", spec, bridge), /changed independently/);
  assert.match(fs.readFileSync(entry, "utf8"), /entomatical-panel-bridge/);
  fs.writeFileSync(sidecar, "updated bridge");
  assert.match(change(root, "remove", spec, bridge), /Restored/);
  assert.equal(fs.readFileSync(entry, "utf8"), original);
  assert.equal(fs.existsSync(sidecar), false);
  fs.writeFileSync(entry, "an unrelated extension update");
  assert.throws(() => change(root, "install", spec, bridge), /changed independently/);
  assert.equal(fs.readFileSync(entry, "utf8"), "an unrelated extension update");
});

test("a patch installed under the product's earlier name is recognised: install replaces it, remove restores the original", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "entomatical-panel-patch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "out"));
  const out = (f) => path.join(root, "out", f), sha = (d) => crypto.createHash("sha256").update(d).digest("hex");
  const original = 'a;let ft=new hL($e,mt);b;this.isPanelAlive(r)&&(r.title=jje(c));';
  const spec = { version: "test", sha256: sha(original), activation: "let ft=new hL($e,mt);", title: "this.isPanelAlive(r)&&(r.title=jje(c))" };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ publisher: "openai", name: "chatgpt", version: "test" }));
  const bridge = path.join(root, "bridge.cjs"); fs.writeFileSync(bridge, "bridge");
  // What the earlier build left behind: the same patch with the old name in its warning, its backup, sidecar and receipt.
  fs.writeFileSync(out("extension.js"), original);
  change(root, "install", spec, bridge);
  const old = fs.readFileSync(out("extension.js"), "utf8").replace("Entomatical panel bridge", `${["Agent", "Board"].join("")} panel bridge`);
  fs.writeFileSync(out("extension.js"), old);
  fs.writeFileSync(out("entomatical-panel-bridge.json"), JSON.stringify({ original: spec.sha256, patched: sha(old), bridge: sha("bridge") }));
  assert.match(change(root, "install", spec, bridge), /Installed/);
  assert.match(fs.readFileSync(out("extension.js"), "utf8"), /Entomatical panel bridge unavailable/);
  fs.writeFileSync(out("extension.js"), old);
  fs.writeFileSync(out("entomatical-panel-bridge.json"), JSON.stringify({ original: spec.sha256, patched: sha(old), bridge: sha("bridge") }));
  assert.match(change(root, "remove", spec, bridge), /Restored/);
  assert.equal(fs.readFileSync(out("extension.js"), "utf8"), original);
});
