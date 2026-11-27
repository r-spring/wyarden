#!/usr/bin/env node
// Runs vscode-probe/ in an isolated VS Code Extension Development Host (own user-data and extensions folders, a throwaway
// empty workspace) and samples the whole VS Code process tree at each phase. Windows only (it reads processes through
// PowerShell). Usage:
//   node docs/monitor-3d/bench/vscode-probe/probe-driver.js --scene <scene.js> [--three <dir>] [--code <Code.exe>] [--out <json>] [--light]
// The recorded output has no paths, user or machine names.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const scene = arg('scene'), three = arg('three'), outFile = arg('out'), light = process.argv.includes('--light');
const code = arg('code', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'));
const SAMPLE_S = 10;
if (!scene || !fs.existsSync(scene) || !fs.existsSync(code)) { console.error('Need --scene and a VS Code (--code).'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor3d-edh-'));
const dirs = Object.fromEntries(['user', 'ext', 'ws', 'out'].map((d) => [d, path.join(scratch, d)]));
for (const d of Object.values(dirs)) fs.mkdirSync(d);

// Every process whose command line names this run's user-data folder, plus the descendants of the started process.
function snapshot(rootPid) {
  const ps = `$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine); $all | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; [pscustomobject]@{ id=$_.ProcessId; parent=$_.ParentProcessId; cmd=[string]$_.CommandLine; ws=$(if($p){$p.WorkingSet64}else{0}); priv=$(if($p){$p.PrivateMemorySize64}else{0}); cpu=$(if($p -and $p.TotalProcessorTime){$p.TotalProcessorTime.TotalSeconds}else{0}) } } | ConvertTo-Json -Compress`;
  const all = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 128 << 20, windowsHide: true }));
  const mine = new Set(all.filter((p) => p.cmd.includes(dirs.user)).map((p) => p.id));
  mine.add(rootPid);
  for (let grew = true; grew;) { grew = false; for (const p of all) if (!mine.has(p.id) && mine.has(p.parent)) { mine.add(p.id); grew = true; } }
  const procs = all.filter((p) => mine.has(p.id) && (p.ws || p.cpu));
  const kind = (c) => (/--type=([a-z-]+)/.exec(c) || [, 'main'])[1] + (/--utility-sub-type=([\w.]+)/.exec(c) ? ':' + /--utility-sub-type=([\w.]+)/.exec(c)[1] : '') + (/extensionHost|--vscode-window-config/.test(c) && /utility/.test(c) ? '' : '');
  const byKind = {};
  for (const p of procs) { const k = kind(p.cmd); byKind[k] = byKind[k] || { count: 0, privateMB: 0 }; byKind[k].count++; byKind[k].privateMB = +(byKind[k].privateMB + p.priv / 1048576).toFixed(1); }
  return { processes: procs.length, workingSetMB: +(procs.reduce((s, p) => s + p.ws, 0) / 1048576).toFixed(1), privateMB: +(procs.reduce((s, p) => s + p.priv, 0) / 1048576).toFixed(1), cpuSeconds: procs.reduce((s, p) => s + p.cpu, 0), byKind, ids: procs.map((p) => p.id) };
}
async function sample(rootPid) {
  const a = snapshot(rootPid); await sleep(SAMPLE_S * 1000); const b = snapshot(rootPid);
  const { ids, cpuSeconds, ...rest } = b;
  return { ...rest, cpuSecondsPer10s: +(b.cpuSeconds - a.cpuSeconds).toFixed(3) };
}

(async () => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC|ELECTRON_|VSCODE_)/i.test(k)) env[k] = v;
  Object.assign(env, { MONITOR3D_OUT: dirs.out, MONITOR3D_SCENE: scene, ...(three ? { MONITOR3D_THREE: three } : {}), ...(light ? { MONITOR3D_LIGHT: '1' } : {}) });
  const args = [`--extensionDevelopmentPath=${__dirname}`, `--user-data-dir=${dirs.user}`, `--extensions-dir=${dirs.ext}`, '--disable-extensions',
    '--disable-workspace-trust', '--skip-release-notes', '--skip-welcome', '--new-window', dirs.ws];
  const child = spawn(code, args, { env, stdio: 'ignore', windowsHide: false });
  const report = { date: new Date().toLocaleDateString('en-CA'), mode: light ? 'light: panel drawn once, no benchmarks' : 'full: benchmarks first', sampleSeconds: SAMPLE_S, phases: {} };
  const until = async (name, ms) => { const f = path.join(dirs.out, 'phase-' + name); for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (fs.existsSync(f)) return true; throw new Error('phase ' + name + ' never came'); };
  try {
    for (const phase of ['baseline', 'rest', 'loop', 'move']) {
      await until(phase, 240_000);
      report.phases[phase] = await sample(child.pid);
      fs.writeFileSync(path.join(dirs.out, 'go-' + phase), '1');
      console.error('sampled ' + phase);
    }
    await until('done', 120_000);
    report.webview = JSON.parse(fs.readFileSync(path.join(dirs.out, 'results.json'), 'utf8'));
  } catch (e) { report.error = String(e.message || e); }
  finally {
    await sleep(4000);
    try { for (const id of snapshot(child.pid).ids) execFileSync('taskkill', ['/PID', String(id), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    await sleep(1500);
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* left in temp */ }
  }
  const text = JSON.stringify(report, null, 2);
  if (outFile) fs.writeFileSync(outFile, text + '\n');
  console.log(text);
})();
