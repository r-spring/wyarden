#!/usr/bin/env node
// Prints the medians from a draw-bench.js or probe-driver.js results file as Markdown rows.
//   node docs/monitor-3d/bench/summarise.js <results.json>
'use strict';
const r = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
const row = (label, x, a = 'js', b = 'flushed') => console.log(`| ${label} | ${x.nodes} | ${x[a].median} | ${x[b].median} | ${x[b].p90} |`);
const runs = r.runs || [{ gpuFlag: 'VS Code webview', gpu: r.webview?.gpu?.value, canvas: (r.webview?.canvas || []).map((c) => c.value), three: (r.webview?.three || []).map((c) => c.value) }];
for (const run of runs) {
  console.log(`\n${run.gpuFlag}: ${run.gpu?.renderer || 'no WebGL2'}`);
  console.log('| renderer | nodes | median ms (call) | median ms (finished) | p90 ms (finished) |\n|---|---|---|---|---|');
  for (const x of run.canvas || []) row('Canvas 2D', x);
  for (const x of run.canvasNoGlow || []) row('Canvas 2D, no glow', x);
  for (const x of run.three || []) row('three.js WebGL2', x);
  for (const x of run.domLabels || []) row('DOM labels only', x, 'js', 'layout');
  if (run.idle) console.log(`idle: at rest ${run.idle.rest.mainThreadBusyMs} ms busy per ${run.idle.rest.seconds} s; rAF loop ${run.idle.rafLoop40.mainThreadBusyMs} ms busy, ${run.idle.rafLoop40.framesIncludingWarmup} frames`);
}
if (r.phases) for (const [k, v] of Object.entries(r.phases)) console.log(`${k}: ${v.processes} processes, ${v.privateMB} MB private, ${v.workingSetMB} MB working set, ${v.cpuSecondsPer10s} s CPU per 10 s`);
