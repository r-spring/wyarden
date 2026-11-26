#!/usr/bin/env node
// tools/package.js: builds Entomatical and packages it into dist/entomatical-<os>.vsix, then inspects the result. It installs
// nothing (run d60bfd step 9, 4 November 2026).
//
//   node tools/package.js                      this machine's package (windows on Windows, linux elsewhere)
//   node tools/package.js --os linux           the Linux package: the same files without the two native .exe files
//   node tools/package.js --os windows         the Windows package: needs the .exe files, so it builds them here on Windows
//   option: --skip-build (reuse staged out/ and wrapper/ files; inspection still compiles an independent JS reference)
//
// The output path is always dist/entomatical-<os>.vsix: every argument handed to the shell is fixed text or derived from the
// validated windows/linux value, so no caller-supplied string reaches cmd.exe (review of 4 November 2026).
//
// One source checkout gives both packages. The Windows one carries wrapper/entomatical-claude.exe (the launcher) and
// wrapper/entomatical-rec.exe (the recorder), compiled by wrapper/build.ps1 with the C# compiler that ships with Windows; the
// Linux one leaves them out through a generated ignore file (dist/.vscodeignore.linux = .vscodeignore + wrapper/*.exe), so a
// Linux package can also be made on Windows for inspection. The shared panel wrapper wrapper/entomatical-claude.js, the hooks,
// the board command, workflows/ (check catalogue, workflow files and prompts) and docs/orchestrator/ (the role briefs) are in
// both; .vscodeignore decides that, and tools/vsix-check.js verifies it after packaging. Same TypeScript and vsce as the
// install scripts in package.json; no new dependency.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { inspect, report, EXES } = require("./vsix-check.js");

const ROOT = path.resolve(__dirname, "..");
/** The vsce the install scripts in package.json already use; kept in one place. */
const VSCE = "@vscode/vsce@4.0.0";

function parseArgs(argv) {
  const o = { os: undefined, skipBuild: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--os") o.os = argv[++i];
    else if (argv[i] === "--skip-build") o.skipBuild = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (o.os === undefined) o.os = process.platform === "win32" ? "windows" : "linux";
  if (!["windows", "linux"].includes(o.os)) throw new Error(`--os must be windows or linux, not ${o.os}`);
  o.out = artifact(o.os);
  return o;
}

/** Where a package lands, relative to the repo root; the only output path there is. */
function artifact(os) { return path.join("dist", `entomatical-${os}.vsix`); }

/**
 * The Linux ignore file: the shared .vscodeignore without the lines that let the native Windows binaries through. vsce applies
 * every `!` line after every ignore line whatever their order, so appending `wrapper/*.exe` would not take them out again.
 */
function linuxIgnore(base) {
  const kept = base.split(/\r?\n/).filter((l) => !/^\s*!.*\.exe\s*$/i.test(l) && !/^\s*!node_modules\/node-pty\/prebuilds\/win32-/i.test(l)).join("\n").replace(/\s*$/, "");
  return `# Linux package: Windows launchers and PTY binaries are left out.\n${kept}\n`;
}

/** Windows packages carry Windows PTY binaries, not Linux binaries. */
function windowsIgnore(base) {
  return base.split(/\r?\n/).filter((l) => !/^\s*!node_modules\/node-pty\/prebuilds\/linux-/i.test(l)).join("\n");
}

/** Runs one tool from the repo root, output shown as it comes; throws on a non-zero exit. */
function run(cmd, args, { cwd = ROOT } = {}) {
  const win = process.platform === "win32";
  // On Windows npm and npx are .cmd files, which need a shell. Every argument is fixed text or dist/entomatical-<os>.vsix,
  // so nothing needs quoting and nothing a caller typed reaches cmd.exe.
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: win });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
}

function main(argv) {
  const o = parseArgs(argv);
  const started = Date.now();
  fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
  if (!o.skipBuild) {
    if (o.os === "windows" && process.platform === "win32") run("npm", ["run", "build:wrapper"]);
    run("npm", ["run", "build"]);
  }
  if (o.os === "windows") {
    const missing = EXES.filter((e) => !fs.existsSync(path.join(ROOT, e)));
    if (missing.length) throw new Error(`a Windows package needs ${missing.join(" and ")}; they are built on Windows by npm run build:wrapper`);
  }
  const args = ["--yes", VSCE, "package", "--target", o.os === "windows" ? "win32-x64" : "linux-x64", "--out", o.out];
  const ignore = path.join("dist", `.vscodeignore.${o.os}`);
  const base = fs.readFileSync(path.join(ROOT, ".vscodeignore"), "utf8");
  fs.writeFileSync(path.join(ROOT, ignore), o.os === "linux" ? linuxIgnore(base) : windowsIgnore(base));
  args.push("--ignoreFile", ignore);
  run("npx", args);
  const result = inspect(path.resolve(ROOT, o.out), { os: o.os, root: ROOT });
  process.stdout.write(report(result));
  if (result.problems.length) { console.error(`${o.out}: ${result.problems.length} problem(s); the package was written but is not right`); return 1; }
  console.log(`Packaged ${o.out} for ${o.os} in ${((Date.now() - started) / 1000).toFixed(1)} s. Nothing was installed; see README.md for the install step.`);
  return 0;
}

if (require.main === module) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(`package: ${e instanceof Error ? e.message : e}`); process.exit(1); }
}
module.exports = { parseArgs, artifact, linuxIgnore, windowsIgnore, VSCE };
