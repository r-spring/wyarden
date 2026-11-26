#!/usr/bin/env node
// tools/vsix-check.js: inspects a packaged Entomatical .vsix (a zip) without installing it (run d60bfd step 9, 4 November 2026).
//
//   node tools/vsix-check.js dist/entomatical-windows.vsix [--os windows|linux] [--list]
//
// It lists the archive's entries, checks that everything the extension loads at run time is inside (compiled code, the shared
// panel wrapper, the hooks, the board command, the webview, the orchestrator role briefs under docs/orchestrator/, every file
// under workflows/ including the check catalogue and workflow prompts), that each of those is byte-identical to its source
// file, that a Windows package carries both native .exe files and a Linux package none, and that nothing private or generated
// slipped in (unselected dependencies, src, tests, evidence, .entomatical data, source maps, logs, transcripts, credentials).
// The repository's TypeScript compiler supplies the reference JS. Exit 1 on any problem.
"use strict";
const fs = require("fs");
const path = require("path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const zlib = require("zlib");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
/** Native Windows binaries: in the Windows package, out of the Linux one. */
const EXES = ["wrapper/entomatical-claude.exe", "wrapper/entomatical-rec.exe"];
const DOCUMENT_NAMES = { LICENSE: "LICENSE.txt", "CHANGELOG.md": "changelog.md" };
const CS_SOURCES = ["wrapper/launcher.cs", "wrapper/recorder.cs"];
// Reviewed Mono build from the 0.8.24 win32-x64 VSIX (SHA-256 8c65dc72ddbf65f8a83b71e8095758d81af8249700a2d594aa802da40353b80d).
// Source hashes use LF so the same record covers the public export and either OS checkout.
const RELEASE_WRAPPERS = {
  "wrapper/launcher.cs": "5deea120e56ddb24e089817f12f1587e3949977c419bbaa1872fa4e3253d8c6a",
  "wrapper/recorder.cs": "915583cb319c18f093f8880c98e65f2345720f63f80ded01f710af39e7821a3f",
  "wrapper/entomatical-claude.exe": "ee90c2f204dfd9082861d2e3376f2194d099b2be2954780dea9703ab7466eda0",
  "wrapper/entomatical-rec.exe": "c38fdee8ff292b26f7ab13a07988dfd78af63764edf849f5db94a9a69a2add98",
};
const PANEL_WRAPPER = "wrapper/entomatical-claude.js";
/** Source files (or folders, recursive) that must be in every package, byte for byte. */
const MIRRORED_DIRS = ["workflows", "media", "hook", "licenses", "docs/agents"];
const MIRRORED = [...MIRRORED_DIRS, "docs/orchestrator/BRIEF.md", "docs/orchestrator/REVIEWER.md", "docs/orchestrator/WATCHER.md",
  "docs/orchestrator/PLANNER.md", "docs/orchestrator/PLANNER-CODEX.md", PANEL_WRAPPER, "tools/board.js", "tools/ledger.js", "tools/codex-panel-bridge.cjs", "tools/codex-panel-patch.cjs",
  "THIRD_PARTY_NOTICES.md", "LICENSE", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "docs/ledger.md", "docs/refinement-prompt.md", "docs/parakeet-cli.md", "docs/user-guide.md", "docs/development.md"];
const RUNTIME_PREFIXES = [...MIRRORED_DIRS, "docs/orchestrator", "tools", "out", "wrapper", "node_modules"].map((dir) => `extension/${dir}/`);
/** Always required, even when a checkout is missing a source entry point. */
const REQUIRED = ["extension.vsixmanifest", "[Content_Types].xml", "extension/package.json", "extension/README.md", "extension/out/extension.js", "extension/out/plan-setup.js"];
/** Only the PTY runtime, the headless screen (card screen/type, src/cardTerminal.ts) and the browser terminal files may come from node_modules. */
const TERMINAL_SHARED = [
  "node_modules/@xterm/xterm/LICENSE", "node_modules/@xterm/xterm/css/xterm.css", "node_modules/@xterm/xterm/lib/xterm.js",
  "node_modules/@xterm/addon-fit/LICENSE", "node_modules/@xterm/addon-fit/lib/addon-fit.js",
  "node_modules/@xterm/headless/package.json", "node_modules/@xterm/headless/lib-headless/xterm-headless.js",
  "node_modules/node-pty/LICENSE", "node_modules/node-pty/package.json", "node_modules/node-addon-api/LICENSE.md",
  ...["index", "interfaces", "terminal", "types", "eventEmitter2", "unixTerminal", "utils", "windowsConoutConnection", "windowsPtyAgent", "windowsTerminal", "conpty_console_list_agent", "shared/conout", "worker/conoutSocketWorker"].map((f) => `node_modules/node-pty/lib/${f}.js`),
];
/**
 * node-pty's pty.node, conpty.node and conpty_console_list.node compile in node-addon-api's C++ headers (napi.h), so its MIT
 * notice must ship with them (review DIST-15). SHA-256 of LICENSE.md in the node-addon-api 7.1.1 tarball package-lock.json locks.
 */
const NATIVE_NOTICES = { "node_modules/node-addon-api/LICENSE.md": "89024017b88a9f2b763f79b941a4f2db3b4428edfcacdc0b23866b2da633ad0c" };
const TERMINAL_NATIVE = {
  windows: ["win32-x64", "win32-arm64"].flatMap((arch) => ["conpty.node", "conpty_console_list.node", "conpty/conpty.dll", "conpty/OpenConsole.exe"].map((f) => `node_modules/node-pty/prebuilds/${arch}/${f}`)),
  linux: ["linux-x64", "linux-arm64"].map((arch) => `node_modules/node-pty/prebuilds/${arch}/pty.node`),
};
/** Never in a package: generated, private or development-only paths. */
const FORBIDDEN_PREFIXES = ["extension/node_modules/", "extension/src/", "extension/test/", "extension/eval/", "extension/dist/", "extension/docs/evidence/",
  "extension/docs/plans/", "extension/docs/releases/private-review/", "extension/docs/orchestrator/REPAIR-", "extension/.entomatical/", "extension/.claude/", "extension/.vscode/", "extension/.git"];
const FORBIDDEN_NAMES = /(\.(map|vsix|log|jsonl|pem|key)$)|((^|\/)(\.credentials\.json|auth\.json|settings\.local\.json|tasks\.json|\.env[^/]*)$)/i;

/** The archive's entries from its central directory: name, compression method, sizes and local-header offset. */
function entries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file: no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central directory entry at offset ${p}`);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    out.push({ name: buf.toString("utf8", p + 46, p + 46 + nameLen), method: buf.readUInt16LE(p + 10), compressed: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24), offset: buf.readUInt32LE(p + 42) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** One entry's bytes, inflated when stored with deflate (the only two methods a VSIX uses). */
function read(buf, e) {
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error(`bad local file header for ${e.name}`);
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const data = buf.subarray(start, start + e.compressed);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`${e.name}: unsupported compression method ${e.method}`);
}

/** Every file under the mirrored paths that exists in the source tree, as repo-relative forward-slash paths. */
function mirrored(root) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (fs.statSync(abs).isDirectory()) for (const f of fs.readdirSync(abs).sort()) walk(`${rel}/${f}`);
    else out.push(rel);
  };
  for (const m of MIRRORED) walk(m);
  return out;
}

/** Compile the intended project in memory. Inspection never reads or repairs the staged out/ files. */
function compiledRuntime(root) {
  const configFile = path.join(root, "tsconfig.json");
  const config = ts.readConfigFile(configFile, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config ?? {}, ts.sys, root, {}, configFile);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const js = new Map();
  const emit = program.emit(undefined, (file, content, bom) => {
    if (file.endsWith(".js")) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      js.set(rel, Buffer.from(bom ? "\uFEFF" + content : content));
    }
  });
  const diagnostics = [config.error, ...parsed.errors, ...ts.getPreEmitDiagnostics(program), ...emit.diagnostics].filter(Boolean);
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, ts.createCompilerHost(parsed.options)));
  if (!js.size) throw new Error(`No JavaScript emitted by ${configFile}`);
  return js;
}

/** Verify the archived pair against one build. The ignored staging executables are never reference inputs. */
function windowsWrapperProblems(root, archived) {
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  function compare(record, sources, normalize) {
    const problems = [];
    for (const rel of sources) {
      const bytes = fs.readFileSync(path.join(root, rel));
      if (digest(normalize ? bytes.toString("utf8").replace(/\r\n/g, "\n") : bytes) !== record[rel]) {
        problems.push(`Windows wrapper build input differs: ${rel}`);
      }
    }
    for (const [rel, bytes] of archived) {
      if (digest(bytes) !== record[rel]) problems.push(`differs from reviewed Windows build: extension/${rel}`);
    }
    return problems;
  }
  const released = compare(RELEASE_WRAPPERS, CS_SOURCES, true);
  const nativeRecord = path.join(root, "dist", "native-wrapper-build.proof");
  if (!released.length || process.platform !== "win32" || !fs.existsSync(nativeRecord)) return released;
  try {
    // Pass only the sealed data on stdin. No checkout path or build recipe is evaluated by PowerShell.
    const unseal = [
      "$ErrorActionPreference = 'Stop'",
      "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
      "$sealed = ConvertTo-SecureString -String ([Console]::In.ReadToEnd())",
      "ConvertFrom-SecureString -SecureString $sealed -AsPlainText",
    ].join("; ");
    const output = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", unseal], {
      input: fs.readFileSync(nativeRecord), encoding: "utf8", windowsHide: true, cwd: path.dirname(process.execPath),
    });
    const native = JSON.parse(output);
    if (typeof native.directory !== "string" || !path.win32.isAbsolute(native.directory) ||
        path.win32.relative(path.resolve(root, "wrapper"), native.directory) !== "") {
      return ["Windows wrapper build record belongs to a different checkout"];
    }
    return compare(native, [...CS_SOURCES, "wrapper/build.ps1"], false);
  } catch {
    return [...released, "Could not verify the local Windows wrapper build record. Run npm run build:wrapper on this machine."];
  }
}

/**
 * Inspects a .vsix (a path or its bytes) for the given OS package. Returns the entries, the mirrored files checked, and the
 * problems found (an empty list means the package is as expected).
 */
function inspect(vsix, { os, root = ROOT } = {}) {
  if (!["windows", "linux"].includes(os)) throw new Error(`--os must be windows or linux, not ${os}`);
  const buf = Buffer.isBuffer(vsix) ? vsix : fs.readFileSync(vsix);
  const list = entries(buf);
  const byName = new Map(list.map((e) => [e.name, e]));
  const problems = [];
  const lower = new Set(list.map((e) => e.name.toLowerCase()));
  for (const r of REQUIRED) if (!lower.has(r.toLowerCase())) problems.push(`missing: ${r}`); // vsce writes README.md as readme.md
  const xml = byName.get("extension.vsixmanifest");
  const target = xml && /\bTargetPlatform=["']([^"']+)["']/.exec(read(buf, xml).toString("utf8"))?.[1];
  const expectedTarget = os === "windows" ? "win32-x64" : "linux-x64";
  if (target !== expectedTarget) problems.push(`TargetPlatform is ${target || "missing"}; expected ${expectedTarget}`);
  const terminalFiles = [...TERMINAL_SHARED, ...TERMINAL_NATIVE[os]];
  const allowedTerminal = new Set(terminalFiles.map((f) => `extension/${f}`));
  const checked = [...mirrored(root), ...terminalFiles, ...(os === "windows" ? EXES : [])];
  const compiled = compiledRuntime(root);
  const windowsWrappers = new Map();
  for (const [rel, reference] of compiled) {
    const name = `extension/${rel}`;
    const entry = byName.get(name);
    if (!entry) problems.push(`missing: ${name}`);
    else if (!read(buf, entry).equals(reference)) problems.push(`differs from clean build: ${name}`);
  }
  for (const rel of checked) {
    const e = byName.get(`extension/${rel}`) ?? byName.get(`extension/${DOCUMENT_NAMES[rel] ?? rel}`);
    if (!e) {
      if (allowedTerminal.has(`extension/${rel}`)) problems.push(`missing terminal runtime: extension/${rel}`);
      else if (EXES.includes(rel)) problems.push(`missing native Windows binary: extension/${rel} (run npm run build:wrapper on Windows first)`);
      else problems.push(`missing: extension/${rel} (source file ${rel} is not in the package)`);
      continue;
    }
    const bytes = read(buf, e);
    if (EXES.includes(rel)) windowsWrappers.set(rel, bytes);
    else if (!bytes.equals(fs.readFileSync(path.join(root, rel)))) problems.push(`differs from source: extension/${rel}`);
    if (NATIVE_NOTICES[rel] && createHash("sha256").update(bytes).digest("hex") !== NATIVE_NOTICES[rel]) {
      problems.push(`differs from the locked dependency's license: extension/${rel}`);
    }
    if (os === "linux" && rel === PANEL_WRAPPER && bytes.subarray(0, "#!/usr/bin/env node\n".length).toString() !== "#!/usr/bin/env node\n") {
      problems.push(`invalid Linux wrapper shebang: extension/${rel} must start with #!/usr/bin/env node followed by LF`);
    }
  }
  if (os === "windows") problems.push(...windowsWrapperProblems(root, windowsWrappers));
  const expectedRuntime = new Set([...checked, ...compiled.keys()].map((rel) => `extension/${rel}`));
  for (const e of list) {
    if (byName.get(e.name) !== e) problems.push(`duplicate entry: ${e.name}`);
    if (os === "linux" && /\.exe$/i.test(e.name)) problems.push(`Windows binary in the Linux package: ${e.name}`);
    if (FORBIDDEN_PREFIXES.some((p) => e.name.startsWith(p)) && !allowedTerminal.has(e.name)) problems.push(`must not be packaged: ${e.name}`);
    else if (FORBIDDEN_NAMES.test(e.name)) problems.push(`must not be packaged: ${e.name}`);
    else if ((RUNTIME_PREFIXES.some((prefix) => e.name.toLowerCase().startsWith(prefix)) || /\.[cm]?js$/i.test(e.name)) && !expectedRuntime.has(e.name)) {
      problems.push(`unexpected runtime file: ${e.name}`);
    }
  }
  const manifest = byName.get("extension/package.json");
  if (manifest) {
    try {
      const packed = JSON.parse(read(buf, manifest).toString("utf8"));
      const source = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      if (packed.name !== source.name || packed.version !== source.version) problems.push(`package.json inside is ${packed.name}@${packed.version}, source is ${source.name}@${source.version}`);
    } catch (e) { problems.push(`package.json inside does not parse: ${e.message}`); }
  }
  const catalogue = byName.get("extension/workflows/checks.json");
  if (catalogue) {
    try { const c = JSON.parse(read(buf, catalogue).toString("utf8")); if (!c || typeof c !== "object" || Array.isArray(c)) problems.push("workflows/checks.json inside is not an object"); }
    catch (e) { problems.push(`workflows/checks.json inside does not parse: ${e.message}`); }
  }
  return { os, bytes: buf.length, entries: list, checked: [...checked, ...compiled.keys()], problems: [...new Set(problems)] };
}

/** A readable report: totals, the files per top-level folder, the mirrored files checked, and the problems. */
function report(r, { list = false } = {}) {
  const lines = [`VSIX for ${r.os}: ${r.entries.length} files, ${r.bytes} bytes`];
  const folders = new Map();
  for (const e of r.entries) { const k = e.name.replace(/^extension\//, "").split("/").slice(0, -1).join("/") || "(root)"; folders.set(k, (folders.get(k) ?? 0) + 1); }
  for (const [k, n] of [...folders].sort()) lines.push(`  ${k}: ${n}`);
  lines.push(`Expected runtime: ${r.checked.length} files compared with the clean build, source, wrappers and selected dependencies`);
  const exes = EXES.filter((x) => r.entries.some((e) => e.name === `extension/${x}`));
  lines.push(`Native Windows binaries inside: ${exes.length ? exes.join(", ") : "none"}`);
  if (list) for (const e of r.entries) lines.push(`  ${String(e.size).padStart(9)}  ${e.name}`);
  if (r.problems.length) { lines.push(`PROBLEMS (${r.problems.length}):`); for (const p of r.problems) lines.push(`  - ${p}`); }
  else lines.push("No problems: the package holds what it should and nothing it should not.");
  return `${lines.join("\n")}\n`;
}

function main(argv) {
  const files = argv.filter((a) => !a.startsWith("--"));
  const osIndex = argv.indexOf("--os");
  const os = osIndex >= 0 ? argv[osIndex + 1] : process.platform === "win32" ? "windows" : "linux";
  const file = files.filter((f) => f !== os)[0];
  if (!file) { console.error("usage: node tools/vsix-check.js <file.vsix> [--os windows|linux] [--list]"); return 2; }
  const r = inspect(path.resolve(file), { os });
  process.stdout.write(report(r, { list: argv.includes("--list") }));
  return r.problems.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { entries, read, mirrored, inspect, report, EXES, MIRRORED, REQUIRED, TERMINAL_SHARED, NATIVE_NOTICES, TERMINAL_NATIVE, FORBIDDEN_PREFIXES, FORBIDDEN_NAMES };
