// Packaging (run d60bfd step 9, 4 November 2026): tools/package.js makes dist/entomatical-<os>.vsix from one checkout, with the
// native Windows binaries only in the Windows package, and tools/vsix-check.js inspects what went in. These tests build small
// zips in memory (the same format vsce writes) so they need no vsce and no network; the last two inspect a real package when
// one has been built, and are skipped otherwise.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const { assertSafeTemp } = require("./safe-temp");
const check = require("../tools/vsix-check.js");
const pkg = require("../tools/package.js");

const repo = path.join(__dirname, "..");
const manifest = require("../package.json");
let root;

test.before(() => {
  assertSafeTemp();
  root = fs.mkdtempSync(path.join(tmpdir(), "vsix 'test' "));
  function write(rel, bytes) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  for (const rel of check.mirrored(repo)) write(rel, fs.readFileSync(path.join(repo, rel)));
  for (const rel of [...check.TERMINAL_SHARED, ...check.TERMINAL_NATIVE.windows, ...check.TERMINAL_NATIVE.linux]) {
    write(rel, check.NATIVE_NOTICES[rel] ? fs.readFileSync(path.join(repo, rel)) : `fixture bytes for ${rel}`); // pinned bytes must be real
  }
  for (const rel of ["wrapper/launcher.cs", "wrapper/recorder.cs", "wrapper/build.ps1"]) write(rel, fs.readFileSync(path.join(repo, rel)));
  // Original PE bytes from the reviewed 0.8.24 Windows VSIX, never executed.
  const pair = fs.readFileSync(path.join(__dirname, "fixtures/windows-wrappers-0.8.24.zip"));
  for (const entry of check.entries(pair)) write(entry.name, check.read(pair, entry));
  write("package.json", JSON.stringify(manifest));
  write("tsconfig.json", JSON.stringify({ compilerOptions: { outDir: "out", types: [], lib: ["es5"] }, include: ["src"] }));
  for (const name of ["extension", "plan-setup", "model-sync"]) write(`src/${name}.ts`, `export const name: string = "${name}";\n`);
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", root]);
});
test.after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

/** A zip from [name, bytes, method] triples: local headers, central directory, end record, as a VSIX is laid out. */
function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, content, method = 8] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const nameBuf = Buffer.from(name), comp = method === 8 ? zlib.deflateRawSync(data) : data, crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(7, 28);
    const extra = Buffer.alloc(7); // an extra field, which the reader must skip
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(method, 10); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, extra, comp);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + extra.length + comp.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/** Assemble archive entries from the fixture's staged files, independently of the inspector's compiler. */
function goodPackage(os) {
  const out = path.join(root, "out");
  const source = [...check.mirrored(root), ...check.TERMINAL_SHARED, ...check.TERMINAL_NATIVE[os], ...(os === "windows" ? check.EXES : [])];
  const files = source.map((rel) => [`extension/${rel}`, fs.readFileSync(path.join(root, rel))]);
  files.push(["extension.vsixmanifest", `<PackageManifest><Identity TargetPlatform="${os === "windows" ? "win32-x64" : "linux-x64"}"/></PackageManifest>`], ["[Content_Types].xml", "<Types/>", 0], ["extension/package.json", JSON.stringify(manifest)],
    ["extension/README.md", "# Entomatical (rewritten by vsce)"]);
  for (const name of fs.readdirSync(out)) files.push([`extension/out/${name}`, fs.readFileSync(path.join(out, name))]);
  return files;
}

test("vsix-check reads a zip's entries and bytes, stored and deflated, skipping extra fields", () => {
  const big = Buffer.alloc(5000, "abc");
  const buf = zip([["a.txt", "hello", 0], ["dir/b.bin", big, 8]]);
  const entries = check.entries(buf);
  assert.deepEqual(entries.map((e) => [e.name, e.method, e.size]), [["a.txt", 0, 5], ["dir/b.bin", 8, 5000]]);
  assert.equal(check.read(buf, entries[0]).toString(), "hello");
  assert.ok(check.read(buf, entries[1]).equals(big));
  assert.throws(() => check.entries(Buffer.from("not a zip at all")), /no end-of-central-directory/);
});

test("vsix-check: the mirrored set covers the catalogue, the role briefs, the shared wrapper, hooks and the board command", () => {
  const m = check.mirrored(root);
  for (const must of ["workflows/checks.json", "docs/agents/examples/example.plan.json", "docs/orchestrator/BRIEF.md", "wrapper/entomatical-claude.js", "hook/hook.js", "hook/statusline.js", "tools/board.js", "tools/codex-panel-bridge.cjs", "tools/codex-panel-patch.cjs", "media/board.js", "THIRD_PARTY_NOTICES.md"])
    assert.ok(m.includes(must), `${must} is mirrored`);
  for (const f of fs.readdirSync(path.join(root, "workflows"))) if (fs.statSync(path.join(root, "workflows", f)).isFile()) assert.ok(m.includes(`workflows/${f}`), `workflows/${f}`);
  assert.ok(m.includes("docs/orchestrator/REVIEWER.md"));
  assert.ok(m.includes("docs/orchestrator/PLANNER.md"));
  assert.ok(m.includes("docs/orchestrator/PLANNER-CODEX.md"));
  assert.ok(m.includes("docs/orchestrator/WATCHER.md"), "the pressure watcher brief (F73) is shipped");
  assert.ok(!m.some((f) => f.startsWith("docs/orchestrator/REPAIR-")), "internal repair reports are not runtime briefs");
});

test("vsix-check passes a correct Windows package and a correct Linux package", () => {
  for (const os of ["windows", "linux"]) {
    const r = check.inspect(zip(goodPackage(os)), { os, root });
    assert.deepEqual(r.problems, [], `${os}: ${r.problems.join("; ")}`);
    assert.ok(r.checked.includes("out/model-sync.js"));
    assert.match(check.report(r), os === "windows" ? /Native Windows binaries inside: wrapper\/entomatical-claude\.exe, wrapper\/entomatical-rec\.exe/ : /Native Windows binaries inside: none/);
    assert.match(check.report(r), /No problems/);
  }
});

test("vsix-check verifies license and changelog bytes under vsce's normalized document names", () => {
  const names = { "extension/LICENSE": "extension/LICENSE.txt", "extension/CHANGELOG.md": "extension/changelog.md" };
  const files = goodPackage("windows").map(([name, content]) => [names[name] ?? name, content]);
  assert.deepEqual(check.inspect(zip(files), { os: "windows", root }).problems, []);
  const changed = files.map(([name, content]) => [name, name === "extension/LICENSE.txt" ? "wrong license" : content]);
  assert.ok(check.inspect(zip(changed), { os: "windows", root }).problems.includes("differs from source: extension/LICENSE"));
});

test("vsix-check: the Windows package must carry both .exe files, the Linux package none", () => {
  const noExes = check.inspect(zip(goodPackage("linux")), { os: "windows", root });
  assert.ok(noExes.problems.some((p) => p.startsWith("missing native Windows binary: extension/wrapper/entomatical-claude.exe")));
  assert.ok(noExes.problems.some((p) => p.startsWith("missing native Windows binary: extension/wrapper/entomatical-rec.exe")));
  const withExes = check.inspect(zip(goodPackage("windows")), { os: "linux", root });
  assert.ok(withExes.problems.includes("Windows binary in the Linux package: extension/wrapper/entomatical-claude.exe"));
  assert.ok(withExes.problems.includes("Windows binary in the Linux package: extension/wrapper/entomatical-rec.exe"));
});

test("vsix-check refuses a missing or wrong Marketplace target platform", () => {
  for (const xml of ["<PackageManifest/>", '<Identity TargetPlatform="linux-x64"/>']) {
    const files = goodPackage("windows").map(([name, content]) => [name, name === "extension.vsixmanifest" ? xml : content]);
    assert.ok(check.inspect(zip(files), { os: "windows", root }).problems.some((p) => p.startsWith("TargetPlatform is ")));
  }
});

test("vsix-check names missing, stale and extra modules from incomplete staging", (t) => {
  const out = path.join(root, "out"), saved = path.join(root, "saved-out");
  fs.renameSync(out, saved);
  t.after(() => { fs.rmSync(out, { recursive: true, force: true }); fs.renameSync(saved, out); });
  fs.mkdirSync(out);
  fs.copyFileSync(path.join(saved, "plan-setup.js"), path.join(out, "plan-setup.js"));
  fs.writeFileSync(path.join(out, "extension.js"), "// old entry point");
  fs.writeFileSync(path.join(out, "retired.js"), "// obsolete module");
  const { problems } = check.inspect(zip(goodPackage("linux")), { os: "linux", root });
  assert.deepEqual(problems.sort(), [
    "differs from clean build: extension/out/extension.js",
    "missing: extension/out/model-sync.js",
    "unexpected runtime file: extension/out/retired.js",
  ]);
});

test("vsix-check compares both planner briefs, installed dependencies and Windows wrapper bytes", () => {
  const stale = ["docs/orchestrator/PLANNER.md", "docs/orchestrator/PLANNER-CODEX.md", "node_modules/@xterm/xterm/lib/xterm.js",
    check.TERMINAL_NATIVE.windows[0], ...check.EXES].map((rel) => `extension/${rel}`);
  const files = goodPackage("windows").map(([name, bytes]) => [name, stale.includes(name) ? "old bytes" : bytes]);
  const { problems } = check.inspect(zip(files), { os: "windows", root });
  assert.deepEqual(problems.sort(), stale.map((name) => name.endsWith(".exe")
    ? `differs from reviewed Windows build: ${name}` : `differs from source: ${name}`).sort());
});

test("vsix-check rejects a substituted pair even when the archive matches Windows staging", (t) => {
  for (const exe of check.EXES) {
    const file = path.join(root, exe);
    const reviewed = fs.readFileSync(file);
    t.after(() => fs.writeFileSync(file, reviewed));
    fs.writeFileSync(file, Buffer.concat([reviewed, Buffer.from("inert fixture change")]));
  }
  const { problems } = check.inspect(zip(goodPackage("windows")), { os: "windows", root });
  assert.deepEqual(problems.sort(), check.EXES.map((exe) => `differs from reviewed Windows build: extension/${exe}`).sort());
});

test("the reviewed Windows pair is valid only for the reviewed C# sources", (t) => {
  const source = path.join(root, "wrapper/launcher.cs");
  const original = fs.readFileSync(source);
  t.after(() => fs.writeFileSync(source, original));
  fs.appendFileSync(source, "// changed source\n");
  const { problems } = check.inspect(zip(goodPackage("windows")), { os: "windows", root });
  assert.deepEqual(problems, ["Windows wrapper build input differs: wrapper/launcher.cs"]);
});

const recipeSentinel = 'Set-Content -LiteralPath (Join-Path $PSScriptRoot "recipe-invoked") -Value "invoked"\n';

function stagedSnapshot() {
  const files = {};
  for (const dir of ["out", "wrapper", "dist"]) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      const file = path.join(root, dir, name);
      files[`${dir}/${name}`] = [fs.statSync(file, { bigint: true }).mtimeNs, fs.readFileSync(file)];
    }
  }
  return files;
}

test("native inspection reads only the protected record and rejects a changed recipe without invoking it", (t) => {
  const recipe = path.join(root, "wrapper/build.ps1"), original = fs.readFileSync(recipe);
  const marker = path.join(root, "wrapper/recipe-invoked"), dist = path.join(root, "dist");
  const proof = path.join(dist, "native-wrapper-build.proof");
  fs.mkdirSync(dist);
  fs.writeFileSync(proof, "opaque proof fixture");
  t.after(() => {
    fs.writeFileSync(recipe, original);
    fs.rmSync(dist, { recursive: true, force: true });
    fs.rmSync(marker, { force: true });
  });
  const record = { directory: path.join(root, "wrapper") };
  for (const exe of check.EXES) {
    const file = path.join(root, exe), reviewed = fs.readFileSync(file);
    t.after(() => fs.writeFileSync(file, reviewed));
    fs.appendFileSync(file, "native fixture");
  }
  for (const rel of ["wrapper/launcher.cs", "wrapper/recorder.cs", "wrapper/build.ps1", ...check.EXES]) {
    record[rel] = require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex");
  }

  // Exercise inspect's Windows branch on either host. The double substitutes only for the PowerShell process.
  const calls = [];
  function run(cmd, args, options) {
    calls.push({ cmd, args, input: options.input });
    if (args.includes("-File") && fs.readFileSync(recipe, "utf8") === recipeSentinel) fs.writeFileSync(marker, "invoked");
    return JSON.stringify(record);
  }
  const file = require.resolve("../tools/vsix-check");
  const fixture = { exports: {} };
  require("node:vm").compileFunction(fs.readFileSync(file, "utf8"), ["require", "module", "__dirname", "process"])(
    (id) => id === "node:child_process" ? { execFileSync: run } : require(id), fixture, path.dirname(file), { platform: "win32", execPath: process.execPath });
  const bytes = zip(goodPackage("windows"));
  const inspect = () => fixture.exports.inspect(bytes, { os: "windows", root }).problems;
  assert.deepEqual(inspect(), []);
  fs.writeFileSync(recipe, recipeSentinel);
  const before = stagedSnapshot();
  const rejected = inspect();
  assert.equal(fs.existsSync(marker), false, "inspection invoked the changed build recipe");
  assert.deepEqual(rejected, ["Windows wrapper build input differs: wrapper/build.ps1"]);
  assert.deepEqual(stagedSnapshot(), before);
  record.directory = path.join(root, "different checkout", "wrapper");
  assert.ok(inspect().includes("Windows wrapper build record belongs to a different checkout"));
  for (const call of calls) {
    assert.equal(call.cmd, "pwsh");
    assert.ok(call.args.includes("-Command") && !call.args.includes("-File"));
    assert.equal(call.input.toString(), "opaque proof fixture");
    assert.ok(call.args.every((arg) => !arg.includes(root)));
  }
});

test("a fresh native Windows wrapper build authenticates its outputs after staging changes", { skip: process.platform !== "win32" }, (t) => {
  const originals = check.EXES.map((exe) => fs.readFileSync(path.join(root, exe)));
  const recipe = path.join(root, "wrapper/build.ps1"), originalRecipe = fs.readFileSync(recipe);
  const marker = path.join(root, "wrapper/recipe-invoked");
  t.after(() => {
    fs.writeFileSync(recipe, originalRecipe);
    fs.rmSync(marker, { force: true });
    check.EXES.forEach((exe, i) => fs.writeFileSync(path.join(root, exe), originals[i]));
    fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
  });
  execFileSync("pwsh", ["-NoProfile", "-File", path.join(root, "wrapper/build.ps1")]);
  assert.deepEqual(check.inspect(zip(goodPackage("windows")), { os: "windows", root }).problems, []);
  fs.appendFileSync(path.join(root, check.EXES[1]), "inert fixture change");
  assert.deepEqual(check.inspect(zip(goodPackage("windows")), { os: "windows", root }).problems,
    [`differs from reviewed Windows build: extension/${check.EXES[1]}`]);
  fs.writeFileSync(recipe, recipeSentinel);
  const before = stagedSnapshot();
  assert.ok(check.inspect(zip(goodPackage("windows")), { os: "windows", root }).problems.includes("Windows wrapper build input differs: wrapper/build.ps1"));
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(stagedSnapshot(), before);
});

test("vsix-check rejects duplicate entries and unexpected files in runtime directories", () => {
  const files = goodPackage("windows");
  const duplicate = files.find(([name]) => name === "extension/out/extension.js");
  files.push(duplicate, ["extension/wrapper/retired.exe", "old launcher"],
    ["extension/media/stale.css", "/* old rules */"], ["extension/docs/orchestrator/RETIRED.md", "old brief"]);
  assert.deepEqual(check.inspect(zip(files), { os: "windows", root }).problems.sort(), [
    "duplicate entry: extension/out/extension.js",
    "unexpected runtime file: extension/docs/orchestrator/RETIRED.md",
    "unexpected runtime file: extension/media/stale.css",
    "unexpected runtime file: extension/wrapper/retired.exe",
  ]);
});

test("vsix-check refuses a CRLF Linux panel wrapper shebang", () => {
  const wrapper = "extension/wrapper/entomatical-claude.js";
  const files = goodPackage("linux").map(([name, content]) =>
    [name, name === wrapper ? content.toString().replace(/^([^\n]+)\n/, "$1\r\n") : content]);
  const result = check.inspect(zip(files), { os: "linux", root });
  assert.ok(result.problems.some((problem) => problem.startsWith(`invalid Linux wrapper shebang: ${wrapper}`)));
});

test("vsix-check requires the terminal assets and rejects a wrong-platform binary or extra dependency", () => {
  for (const os of ["windows", "linux"]) {
    const missing = check.TERMINAL_NATIVE[os][0], other = check.TERMINAL_NATIVE[os === "windows" ? "linux" : "windows"][0];
    const files = goodPackage(os).filter(([name]) => name !== `extension/${missing}`);
    files.push([`extension/${other}`, "wrong platform"], ["extension/node_modules/node-pty/src/pty.cc", "source"]);
    const { problems } = check.inspect(zip(files), { os, root });
    assert.ok(problems.includes(`missing terminal runtime: extension/${missing}`));
    assert.ok(problems.includes(`must not be packaged: extension/${other}`));
    assert.ok(problems.includes("must not be packaged: extension/node_modules/node-pty/src/pty.cc"));
  }
});

test("vsix-check requires node-addon-api's locked license beside node-pty's native binaries in both packages", (t) => {
  const notice = "node_modules/node-addon-api/LICENSE.md", name = `extension/${notice}`;
  assert.ok(check.TERMINAL_SHARED.includes(notice));
  for (const os of ["windows", "linux"]) {
    const removed = check.inspect(zip(goodPackage(os).filter(([n]) => n !== name)), { os, root }).problems;
    assert.deepEqual(removed, [`missing terminal runtime: ${name}`], os);
  }
  // A changed notice fails even when the installed copy changed with it: the bytes are pinned to the locked release.
  const file = path.join(root, notice), locked = fs.readFileSync(file);
  t.after(() => fs.writeFileSync(file, locked));
  fs.writeFileSync(file, locked.toString().replace("Node.js API collaborators", "someone else"));
  for (const os of ["windows", "linux"]) {
    assert.deepEqual(check.inspect(zip(goodPackage(os)), { os, root }).problems, [`differs from the locked dependency's license: ${name}`], os);
  }
});

test("the node-addon-api notice matches the locked dependency and says why it ships", () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repo, "package-lock.json"), "utf8")).packages;
  assert.equal(lock["node_modules/node-addon-api"].version, "7.1.1", "a new node-addon-api needs its license reviewed and NATIVE_NOTICES updated");
  assert.equal(lock["node_modules/node-pty"].dependencies["node-addon-api"], "^7.1.0");
  for (const [rel, sha256] of Object.entries(check.NATIVE_NOTICES)) {
    const installed = require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(repo, rel))).digest("hex");
    assert.equal(installed, sha256, `${rel} as installed from package-lock.json`);
  }
  const notices = fs.readFileSync(path.join(repo, "THIRD_PARTY_NOTICES.md"), "utf8");
  for (const want of ["`pty.node`", "`conpty.node`", "`conpty_console_list.node`", "[node-addon-api](https://github.com/nodejs/node-addon-api)", "C++ header library (`napi.h`)", "7.1.1", "Node.js API collaborators", "`node_modules/node-addon-api/LICENSE.md`"])
    assert.ok(notices.includes(want), `THIRD_PARTY_NOTICES.md names ${want}`);
});

test("vsix-check refuses generated, private and development-only files", () => {
  const extras = ["extension/node_modules/typescript/lib/typescript.js", "extension/src/board.ts", "extension/test/board.test.js", "extension/out/extension.js.map",
    "extension/.entomatical/tasks.json", "extension/.claude/settings.local.json", "extension/docs/evidence/x/log.txt", "extension/docs/orchestrator/REPAIR-2026-11-04.md", "extension/docs/releases/private-review/inventory.md", "extension/wrapper/x.log", "extension/.credentials.json", "extension/a/auth.json", "extension/s/transcript.jsonl"];
  const r = check.inspect(zip([...goodPackage("windows"), ...extras.map((n) => [n, "x"])]), { os: "windows", root });
  assert.deepEqual(r.problems.sort(), extras.map((n) => `must not be packaged: ${n}`).sort());
});

test("vsix-check: a mirrored file that differs from its source, or is missing, is named", () => {
  const files = goodPackage("windows").map(([n, c]) => n === "extension/workflows/checks.json" ? [n, `${c}\n`] : [n, c]).filter(([n]) => n !== "extension/docs/orchestrator/BRIEF.md");
  const r = check.inspect(zip(files), { os: "windows", root });
  assert.ok(r.problems.includes("differs from source: extension/workflows/checks.json"), r.problems.join("; "));
  assert.ok(r.problems.includes("missing: extension/docs/orchestrator/BRIEF.md (source file docs/orchestrator/BRIEF.md is not in the package)"), r.problems.join("; "));
  const bad = goodPackage("windows").map(([n, c]) => n === "extension/package.json" ? [n, JSON.stringify({ name: "entomatical", version: "0.0.0" })] : [n, c]).filter(([n]) => n !== "extension/out/extension.js");
  const r2 = check.inspect(zip(bad), { os: "windows", root });
  assert.ok(r2.problems.includes("missing: extension/out/extension.js"));
  assert.ok(r2.problems.some((p) => p.startsWith("package.json inside is entomatical@0.0.0, source is entomatical@")));
});

test(".vscodeignore ships workflows, selected role briefs, public guides and the Windows binaries", () => {
  const lines = fs.readFileSync(path.join(repo, ".vscodeignore"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.equal(lines[0], "**", "everything is out unless listed");
  for (const want of ["!workflows/**", "!docs/orchestrator/BRIEF.md", "!docs/orchestrator/REVIEWER.md", "!docs/orchestrator/WATCHER.md", "!docs/user-guide.md", "!docs/development.md", "!docs/agents/README.md", "!docs/agents/schemas/*.json", "!docs/agents/examples/*.json", "!wrapper/entomatical-claude.js", "!wrapper/entomatical-claude.exe", "!wrapper/entomatical-rec.exe", "!hook/**", "!media/**", "!out/*.js", "!tools/board.js", "!node_modules/node-addon-api/LICENSE.md"])
    assert.ok(lines.includes(want), `${want} is in .vscodeignore`);
  assert.ok(!lines.some((l) => /^!(src|test|docs\/evidence|\.entomatical)/.test(l)), "no development or private folder is let through");
  assert.ok(!lines.includes("!node_modules/**"), "only listed terminal dependencies are let through");
  assert.ok(!lines.includes("!docs/orchestrator/**"), "internal orchestrator notes are excluded by default");
});

test("package.js: the Linux ignore file is the shared one without the .exe lines (vsce lets any negated file through); defaults follow the platform", () => {
  const base = fs.readFileSync(path.join(repo, ".vscodeignore"), "utf8");
  const baseLines = base.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const linuxLines = pkg.linuxIgnore(base).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  assert.ok(!linuxLines.some((l) => /^!.*\.exe$/.test(l)), "no .exe is let through");
  assert.deepEqual(linuxLines.filter((l) => !l.startsWith("#")), baseLines.filter((l) => !l.startsWith("#") && !/^!.*\.exe$/.test(l) && !/^!node_modules\/node-pty\/prebuilds\/win32-/.test(l)), "every other rule is kept, in order");
  assert.ok(!linuxLines.some((l) => /node-pty\/prebuilds\/win32-/.test(l)), "no Windows PTY files in Linux package");
  const windowsLines = pkg.windowsIgnore(base).split(/\r?\n/);
  assert.ok(!windowsLines.some((l) => /node-pty\/prebuilds\/linux-/.test(l)), "no Linux PTY files in Windows package");
  assert.equal(pkg.parseArgs([]).os, process.platform === "win32" ? "windows" : "linux");
  assert.deepEqual(pkg.parseArgs(["--os", "linux", "--skip-build"]), { os: "linux", out: path.join("dist", "entomatical-linux.vsix"), skipBuild: true });
  // The output path is never taken from the command line: every shell argument is fixed or derived from the OS enum.
  assert.equal(pkg.parseArgs(["--os", "windows"]).out, path.join("dist", "entomatical-windows.vsix"));
  assert.throws(() => pkg.parseArgs(["--os", "windows", "--out", "dist/a&b.vsix"]), /unknown argument --out/);
  assert.throws(() => pkg.parseArgs(["--os", "mac"]), /windows or linux/);
  assert.throws(() => pkg.parseArgs(["--bogus"]), /unknown argument/);
  assert.equal(pkg.artifact("windows"), path.join("dist", "entomatical-windows.vsix"));
});

test("package.json: package scripts install nothing; the install scripts take the packaged file from dist/", () => {
  const s = manifest.scripts;
  assert.equal(s.package, "node tools/package.js");
  assert.equal(s["package:linux"], "node tools/package.js --os linux");
  assert.equal(s["package:windows"], "node tools/package.js --os windows");
  for (const name of ["package", "package:linux", "package:windows", "build", "build:wrapper", "test", "parity"]) assert.ok(!/install-extension/.test(s[name]), `${name} does not install`);
  assert.match(s["install-global"], /^npm run package:windows && code --install-extension dist\/entomatical-windows\.vsix --force$/);
  assert.match(s["install-linux"], /^npm run package:linux && \$\{ENTOMATICAL_EDITOR:-codium\} --install-extension dist\/entomatical-linux\.vsix --force$/);
  const catalogue = JSON.parse(fs.readFileSync(path.join(root, "workflows", "checks.json"), "utf8"));
  assert.equal(catalogue.package?.run, "npm run package");
  assert.equal(catalogue["package-linux"]?.run, "npm run package:linux");
});

for (const os of ["windows", "linux"]) {
  const file = path.join(repo, pkg.artifact(os));
  const skip = !fs.existsSync(file) ? `no ${pkg.artifact(os)} here: run npm run package${os === "linux" ? ":linux" : ""} first` : false;
  test(`the built ${os} package in dist/ passes inspection`, { skip }, () => {
    const r = check.inspect(file, { os, root: repo });
    assert.deepEqual(r.problems, [], r.problems.join("; "));
    assert.ok(r.entries.some((e) => e.name === "extension/workflows/checks.json"));
    assert.ok(r.entries.some((e) => e.name === "extension/docs/orchestrator/BRIEF.md"));
  });
}
