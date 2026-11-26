// Reversible, version-pinned patch for Codex's otherwise private panel/app-server connection.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const supported = {
  version: "26.1021.22027",
  sha256: "a9cc6736cd2c2d22f6cf43fc5763d5f8a873e4f741f522b44a600b1926f4e627",
  activation: "let ft=new hL($e,mt);",
  title: "this.isPanelAlive(r)&&(r.title=jje(c))",
};
const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");
const bundledBridge = path.join(__dirname, "codex-panel-bridge.cjs");
function patched(original, spec, name = "Entomatical") {
  const source = original.toString("utf8");
  if (source.split(spec.activation).length !== 2 || source.split(spec.title).length !== 2) throw new Error("Codex's extension does not have the expected unique anchors");
  // A missing or broken optional sidecar must never prevent the Codex extension itself from activating.
  return Buffer.from(source.replace(spec.activation, `try{require("./entomatical-panel-bridge.cjs")(Ot,v,e,$e)}catch{console.warn("${name} panel bridge unavailable")};` + spec.activation)
    .replace(spec.title, "this.isPanelAlive(r)&&(c||!r.__entomaticalTitle)&&(r.title=jje(c))"));
}
function atomic(file, contents, mode) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  try { fs.writeFileSync(tmp, contents, { flag: "wx", mode }); fs.renameSync(tmp, file); }
  finally { try { fs.rmSync(tmp, { force: true }); } catch { /* already renamed */ } }
}

/** Install or remove our patch. Never modify an unrecognized or independently changed Codex extension. */
function change(root, action, spec = supported, bridgeFile = bundledBridge) {
  if (!['install', 'remove'].includes(action)) throw new Error("Expected install or remove");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (manifest.publisher !== "openai" || manifest.name !== "chatgpt" || manifest.version !== spec.version) throw new Error(`Unsupported Codex extension version; expected openai.chatgpt ${spec.version}`);
  const out = path.join(root, "out"), entry = path.join(out, "extension.js"), backup = path.join(out, "extension.js.entomatical-original"),
    sidecar = path.join(out, "entomatical-panel-bridge.cjs"), receipt = path.join(out, "entomatical-panel-bridge.json");
  const current = fs.readFileSync(entry), mode = fs.statSync(entry).mode & 0o777;
  const original = fs.existsSync(backup) ? fs.readFileSync(backup) : current;
  if (hash(original) !== spec.sha256) throw new Error("Codex's original extension has an unrecognized checksum; no files were changed");
  const modified = patched(original, spec), currentHash = hash(current);
  // A patch installed before the product was renamed (16 November 2026) carries the old name in its one console warning. It is ours:
  // recognised here so install replaces it and remove restores the original.
  const legacy = hash(patched(original, spec, ["Agent", "Board"].join("")));
  if (currentHash !== hash(original) && currentHash !== hash(modified) && currentHash !== legacy) throw new Error("Codex's extension was changed independently; no files were changed");
  let oldReceipt;
  if (fs.existsSync(receipt)) {
    oldReceipt = JSON.parse(fs.readFileSync(receipt, "utf8"));
    if (oldReceipt.original !== spec.sha256 || (oldReceipt.patched !== hash(modified) && oldReceipt.patched !== legacy)) throw new Error("The existing bridge receipt does not match this Codex version");
  }
  if (fs.existsSync(sidecar) && (!oldReceipt || hash(fs.readFileSync(sidecar)) !== oldReceipt.bridge)) throw new Error("The existing bridge file was changed independently; no files were changed");
  if ((currentHash === hash(modified) || currentHash === legacy) && (!oldReceipt || !fs.existsSync(sidecar))) throw new Error("Codex's installed bridge is incomplete; no files were changed");
  if (action === "remove") {
    if (currentHash === hash(original)) return "The original Codex extension is already in place";
    atomic(entry, original, mode);
    fs.rmSync(sidecar, { force: true }); fs.rmSync(receipt, { force: true });
    return "Restored Codex's original extension; reload the window when convenient";
  }
  // The sidecar runs in a different extension directory. Ship the same self-contained F79 function as the standalone hook.
  let bridge = fs.readFileSync(bridgeFile);
  if (path.resolve(bridgeFile) === bundledBridge) {
    const { asks } = require("../hook/hook.js");
    bridge = Buffer.concat([bridge, Buffer.from(`\nmodule.exports.asks = ${asks};\n`)]);
  }
  const oldBridge = fs.existsSync(sidecar) ? fs.readFileSync(sidecar) : undefined;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, { flag: "wx", mode });
  try {
    atomic(sidecar, bridge, 0o644);
    // Check again immediately before replacement in case an extension update ran while we prepared the files.
    if (hash(fs.readFileSync(entry)) !== currentHash) throw new Error("Codex changed during installation");
    atomic(entry, modified, mode);
    atomic(receipt, JSON.stringify({ original: spec.sha256, patched: hash(modified), bridge: hash(bridge) }) + "\n", 0o600);
  } catch (error) {
    if (hash(fs.readFileSync(entry)) === hash(modified)) atomic(entry, current, mode);
    if (oldBridge) atomic(sidecar, oldBridge, 0o644); else fs.rmSync(sidecar, { force: true });
    throw error;
  }
  return "Installed the Codex panel bridge; reload the window when convenient";
}
module.exports = { change, supported };
if (require.main === module) {
  try {
    const [, , action, root] = process.argv;
    if (!root) throw new Error("Usage: node codex-panel-patch.cjs install|remove <Codex extension directory>");
    console.log(change(root, action));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
