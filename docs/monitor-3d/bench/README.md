# Draw-time and webview-cost benchmarks for 03-build-approach.md

Measured 26 November 2026 on one Windows 11 PC (AMD Ryzen 9 9950X, 32 logical CPUs, NVIDIA GeForce RTX 4080 SUPER), Microsoft Edge 158.0.4370.33, VS Code 1.148.0, Node 26.7.0. Nothing was measured on Linux, in VSCodium or over Remote (see "Not measured").

## What is measured, and how

**Renderer under test.** The NEXUS lattice concept's Canvas 2D renderer, `nexus-3d/ui-concepts/nexus-lattice-29d4d1/scene.js` in the Entridir repository, with its `model.js`. Both are served unmodified from where they are, read only, never copied here. `Scene.draw()` is called with `motion = false`: the draw-on-change case, with no packets or pulses.

**three.js comparison.** three.js 0.187.0 (MIT), fetched with `npm pack three` into a temporary folder outside this repository, not committed. The same scene is built: the same wireframe shapes (`geometry()` from scene.js), the same ground grid, edges as the same 16-segment curves merged into one buffer, and one text sprite per node.

**Graphs.**
- 40 nodes and 52 edges: the concept's own fixture (`model.js` `seed()`).
- 200 and 1,000 nodes: seeded random graphs that keep the fixture's type mix, statuses, edge kinds, edge-per-node ratio (1.3) and bounding box. Same camera, same panel.

**A draw.** Each draw turns the camera by 0.01 rad, as a drag would, so every draw is a full redraw.
- 10 warm-up draws, then 50 timed draws. Medians are reported.
- **call**: time inside `draw()` or `renderer.render()` only. The browser can queue raster or GPU work and return early.
- **finished**: the same, plus a one-pixel read (`getImageData`, or `gl.readPixels`). This makes the browser finish the frame before the timer stops. Read this column.

**Variants.**
- **No glow**: the Canvas draw with every `shadowBlur` ignored. scene.js gives each line a glow; this shows what the glow costs.
- **DOM labels**: one `<div>` per node over the scene, placed by a CSS transform from scene.js `project()`. Times the placing loop plus a forced style and layout pass. Paint and compositing are not counted.

**Idle.** In headless Edge, main-thread busy time (`Performance.getMetrics` `TaskDuration`) over 10 s, in two cases:
- after one draw, at rest;
- with the concept's never-stopping `requestAnimationFrame` loop (its `app.js` `frame()`), motion on, 40 nodes.

**Real VS Code webview** (`vscode-probe/`). A bench-only extension opens a webview panel with the same page and a nonce content security policy. It is run in an isolated Extension Development Host: its own user-data and extensions folders, `--disable-extensions`, and an empty workspace. The driver samples every process of that VS Code at each phase: count, private bytes, working set, and CPU seconds over 10 s.
- **Phases**: baseline (no webview), rest (panel drawn once), loop (never-stopping loop), move (after `workbench.action.moveEditorToNewWindow`).
- **Page loads** are counted, which shows whether moving the panel to a new window reloads the page.
- **Two runs:**
  - **full**: draw benchmarks first, then the phases;
  - **light** (`--light`): no benchmarks and a 30 s settle before the baseline, so "rest" is the clean cost of a drawn-once panel.

## Results

Draw time in ms, median of 50 full draws at 1280 x 720, device scale 1. Columns: call / finished, then p90 finished.

| Where | Renderer | 40 nodes | 200 nodes | 1,000 nodes |
|---|---|---|---|---|
| VS Code 1.148 webview, GPU (ANGLE D3D11, RTX 4080 SUPER) | Canvas 2D (scene.js) | 1.3 / **4.0**, p90 4.7 | 6.1 / **18.45**, p90 22.1 | 86.2 / **91.6**, p90 107.8 |
| same | three.js WebGL2 | 0.2 / **1.1**, p90 1.3 | 0.9 / **2.1**, p90 3.6 | 4.45 / **8.95**, p90 11.9 |
| Headless Edge, GPU allowed (same GPU) | Canvas 2D | 1.4 / **4.75**, p90 5.6 | 6.65 / **20.5**, p90 22.2 | 92.25 / **103.2**, p90 110.1 |
| same | Canvas 2D, no glow | 1.0 / **2.9**, p90 3.1 | 7.0 / **14.5**, p90 15.2 | 58.3 / **74.0**, p90 76.6 |
| same | three.js WebGL2 | 0.1 / **1.2**, p90 1.5 | 0.5 / **1.9**, p90 2.6 | 3.4 / **7.75**, p90 11.7 |
| same | DOM labels only (layout) | 0 / **0**, p90 0.1 | 0.1 / **0.3**, p90 0.4 | 0.5 / **1.3**, p90 1.4 |
| Headless Edge, `--disable-gpu` (as `test/` runs; WebGL on Microsoft Basic Render Driver) | Canvas 2D | 1.4 / **4.6**, p90 5.4 | 6.1 / **19.8**, p90 22.2 | 94.6 / **101.65**, p90 106.2 |
| same | Canvas 2D, no glow | 1.0 / **2.9**, p90 3.1 | 6.9 / **14.5**, p90 15.1 | 57.85 / **74.0**, p90 84.4 |
| same | three.js WebGL2 | 0.2 / **4.2**, p90 4.5 | 5.4 / **9.3**, p90 10.5 | 30.05 / **33.95**, p90 40.1 |
| same | DOM labels only (layout) | 0 / **0.05**, p90 0.1 | 0.1 / **0.3**, p90 0.3 | 0.4 / **1.3**, p90 1.7 |

**three.js setup.**
- Building the scene took 86.9, 126.6 and 501.7 ms in the VS Code webview, at 40, 200 and 1,000 nodes.
- Draw calls: 82, 402 and 2,002 (one object and one label sprite per node).

**Idle, headless Edge, page main thread, busy ms per 10 s.**

| | GPU allowed | `--disable-gpu` |
|---|---|---|
| At rest after one draw (0 frames drawn) | 1.6 | 41.5 |
| Never-stopping loop, 40 nodes | 945.1 (489 frames) | 3,411.8 (662 frames) |

**Real VS Code webview, light run.** The whole VS Code process tree, CPU seconds per 10 s:

| Phase | Processes | Private MB | Working set MB | CPU s per 10 s |
|---|---|---|---|---|
| Baseline, no webview | 12 | 1,290.7 | 2,066.4 | 0.094 |
| Panel open, drawn once, at rest | 13 | 1,319.1 | 2,199.8 | 0.188 |
| Never-stopping loop, 40 nodes | 13 | 1,349.1 | 2,249.8 | 24.25 (2,144 frames) |
| After moving the panel to a new window, at rest | 13 | 1,321.9 | 2,217.3 | 0.063 |

**What the light run shows.**
- The drawn-once panel costs one more process, +28.4 MB private and +133.4 MB working set.
- The GPU process went from 127.5 to 139.0 MB private.
- The CPU figures are one 10 s sample each.

**Full run.**
- After the benchmarks, VS Code's GPU process held 418.1 MB private (130.4 MB at baseline). The 1,000 sprite textures had been created and disposed. This was not broken down further.
- Moving the panel to a new window reloaded the page once (2 loads in all).
- Its saved `getState()` survived the reload, even with `retainContextWhenHidden: true`.
- Both runs agree on all of this.

**Package size.** three.js `three.module.js` and `three.core.js` together are 2,133,699 bytes, and 420,122 bytes compressed (raw deflate at level 9, as in a VSIX zip). Version 0.187.0 ships no minified build.

## Files

- `draw-bench.js`: serves the page on 127.0.0.1, drives headless Edge (or Chrome or Chromium off Windows) over the DevTools protocol, and runs with and without the GPU.
- `bench-page.js`, `page.html`: the page side.
- `vscode-probe/`: `extension.js` and `package.json` (bench-only, never packaged), and `probe-driver.js` (Windows only).
- `summarise.js`: prints the medians from a results file.
- `results-2026-11-26.json`, `vscode-results-2026-11-26.json` (full), `vscode-results-light-2026-11-26.json` (light): the raw numbers. They hold no paths, user names or machine names.

## Run it again

```sh
node docs/monitor-3d/bench/draw-bench.js --scene <Entridir>/nexus-3d/ui-concepts/nexus-lattice-29d4d1/scene.js \
     --three <folder with three.module.js and three.core.js> --out docs/monitor-3d/bench/results-<date>.json
node docs/monitor-3d/bench/vscode-probe/probe-driver.js --scene <same scene.js> [--three <same folder>] [--light] --out <json>
node docs/monitor-3d/bench/summarise.js <json>
```

The probe opens a visible VS Code window for about two minutes, then quits.

## Not measured, and why

- **Linux, VSCodium, WSL and SSH.**
  - No Linux desktop with a browser could be reached from this session.
  - The WSL Ubuntu here has neither Chrome nor Node.
  - VSCodium is not installed on this PC.
- **Godot, desktop and web export.** The plan says to cite Entridir's recorded figures, not re-measure them. A web export also needs Godot's export templates, and nothing may be built in the Entridir repository.
- **Delay from event to pixel, end to end.** No live feed exists yet, and this plan wires nothing. Only the draw part is measured above.
- **postMessage latency between the extension host and the webview.**
- **Paint and compositing of DOM labels.**
- **GPU time per frame.** Only "finished" wall time is measured.
