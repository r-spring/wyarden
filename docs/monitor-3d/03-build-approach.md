# 03. How to build the 3D view

**Recommendation: three.js on WebGL2 in a VS Code webview tab inside the Wyarden extension (option A2), with the existing Canvas 2D renderer kept as the fallback.**
**Where the 3D runs:** in the webview's own renderer process. The owner can float the tab to its own window with "Move Editor into New Window".
**How it talks to VS Code:** by `postMessage` to the extension host. The host owns the event feed (a snapshot, then changes) and turns every click into a VS Code command. A machine-wide hub of files lets any window show every workspace.
**Not Godot, and not a separate app.** On measured evidence a Godot app costs about 190 MB, a second unsigned installer and a Remote bridge. The webview costs +28 MB and one process. What Godot alone would give: a view that lives when VS Code is closed.
**Runner-up:** a Godot 4 desktop app talking to a small bridge extension over loopback (option B). It wins if the view must run without VS Code open (section 3).

Written 26 November 2026 by card 56b37b, step 3 of plan "3D agent monitor: critique, approach, wiring plan". Documents only: nothing is wired.

**Reading this document:**
- **Measured** numbers come from [bench/](bench/README.md), run today on one Windows 11 PC.
- **Entridir** figures are cited, not re-measured, as `Entridir: <file>:<line>`. P is `docs/plans/godot-port.md`; R is `godot/README.md`.
- **VS Code and Godot facts** come from official pages fetched today (appendix B).
- **Judgement** is marked as such.

---

## 1. Comparison

The options:
- **A1** is the concept's Canvas 2D renderer (`scene.js`, no dependencies) in a webview.
- **A2** is three.js on WebGL2 in a webview, with DOM labels.
- **B** is a Godot 4 desktop app with a bridge extension over loopback.
- **C** is a Godot web export inside a webview.
- **D** is a separate web window: a browser tab or a Tauri or Electron shell, fed by the hub, with the same bridge as B.

| Criterion | A1 Canvas webview | **A2 three.js webview** | B Godot app + bridge | C Godot web export in webview | D separate web window |
|---|---|---|---|---|---|
| **Click in 3D becomes a VS Code action** | Page posts `{action, id}`; the host runs the command in its own window. No socket, no token. The removed tab did exactly this (Entridir: `nexus-3d/src/lattice.ts:119`). | Same as A1. | Godot sends over loopback (WebSocket, token) to the bridge, which runs the command. VS Code must then take the foreground from another process, and Windows allows that only in some cases (Entridir: P:811-815, a second launch "did not bring the window in front"). Not tested for this path. | Same as A1, plus JavaScript glue between the wasm and the page. | Same as B. |
| **VS Code selection lights up in 3D** | `onDidChangeActiveTextEditor` → `postMessage` → one redraw: **4.0 ms** at 40 nodes, **18.45 ms** at 200 (measured, VS Code webview). | Same path. One redraw: **1.1 / 2.1 / 8.95 ms** at 40 / 200 / 1,000 nodes (measured, VS Code webview). | Bridge pushes over the socket. Draw time per change not recorded; script per camera move 0.41–0.49 ms at 79 shapes (Entridir: P:61-62). | As A, then JS into wasm. Not measured. | As B. Not measured. |
| **Delay from event to pixel** | Draw only: **4.0 / 18.45 / 91.6 ms** (40 / 200 / 1,000 nodes). The feed path is not measured: no live feed exists yet. | Draw only: **1.1 / 2.1 / 8.95 ms**. Feed not measured. | 60.4 fps while dragging at 75 nodes; zero idle frames (Entridir: P:1007). Entridir reads logs on a 4 s scan (P:134), which is a design choice, not a Godot limit. | Not measured. | Not measured. |
| **Memory** | **+1 process, +28.4 MB private, +133.4 MB working set** over a running VS Code, panel drawn once (measured, light run). | Same panel. After 1,000 sprite textures the GPU process held 418.1 MB (130.4 at baseline); not broken down. DOM labels avoid textures. | **1 process, 188.9–194.0 MB private** on demo data, 244.2–249.8 MB on real data (Entridir: P:1161, P:1166). The bridge is extra, inside the extension host; not measured. | Not measured. | Electron as a stand-in: 4 processes, 210.6–216.7 MB private (Entridir: P:1161, P:1170). Tauri not measured. |
| **Idle CPU** | At rest: VS Code tree **0.188 s per 10 s** with the panel against **0.094** without (one sample each, measured). Page main thread at rest: **1.6 ms per 10 s** (headless, GPU). With a never-stopping loop: **24.25 s per 10 s** (measured). | Same: nothing draws at rest. | **0.47–0.55 s per 60 s** (demo) and 1.95–2.03 s (real), mostly its own log scan (Entridir: P:1163, P:1168, P:134). | Not measured. The browser pauses a project in an inactive tab (Godot docs). Low processor mode on the web: docs silent. | Electron: 13.7–14.5 s per 60 s (Entridir: P:1163). |
| **GPU** | No WebGL. Canvas raster on the GPU. | WebGL2 confirmed in a VS Code 1.148 webview on Windows: "ANGLE (NVIDIA … Direct3D11)" (measured). Software fallback works: 33.95 ms at 1,000 nodes on Microsoft Basic Render Driver (measured, `--disable-gpu`). | Compatibility (OpenGL) renderer only: an empty window is 132 MB against 576 MB on Direct3D 12 and 962 MB on Vulkan (Entridir: P:30-32, P:129). | Needs WebGL 2 (Godot docs), which webviews give (measured). | Own GPU process (Entridir: P:1181-1185, Electron's GPU process busy at rest). |
| **Install and update** | Nothing new: inside the one VSIX, updated by the Marketplace or Open VSX. | One VSIX. three.js adds **2,133,699 bytes, 420,122 compressed** (measured). | **A second, unsigned installer**: NSIS 26 MB, AppImage 26 MB, .deb 21 MB (Entridir: P:1040-1043). "SmartScreen will warn about the unsigned installer" (P:1457). Updated by hand, separately (P:1063), so the bridge and app versions can drift. Shipping the binary inside per-platform VSIXs removes the installer, but at 105 MB (Windows) and 71 MB (Linux) each (P:1041, P:1045), still unsigned. | One VSIX plus the engine wasm (size not stated by Godot docs; not measured). | A second installer (Tauri, Electron) or none (a browser tab). |
| **Windows and Linux built together** | Same JS on both; no build step. `test/compile-webview-cdp.js:19-26` already picks Edge or Chrome per system. | Same; three.js is plain ES modules. | One export per system from one PC worked (Entridir: P:214, P:1535). Fonts differ on Linux and cut text to "4 ne" and "Wa" (P:1523-1531). No CI builds the packages (P:1466). | One export for both. | One build per system for a shell. |
| **VSCodium** | The earlier Canvas lattice tab ran natively in VSCodium 1.143 on Linux (Entridir: `nexus-3d/docs/evidence/…/2d3830-native-focus-api.md:11`). | Same webview. WebGL2 in VSCodium **not measured**. | Bridge from Open VSX, app from elsewhere. | As A2. | As B. |
| **Remote (WSL, SSH)** | The extension runs on the remote, and the webview always runs locally; `postMessage` crosses for free (VS Code docs). Nothing extra. | Same. | The app is local and the bridge is on the remote. It needs a forwarded port, or a UI-side bridge that cannot read the remote's files. Not tested. | As A. | As B. |
| **Label quality** | `fillText` at 8 px in the canvas (`scene.js:63, 77`). | **DOM labels over the canvas**: system font, theme colours, sharp at any DPI, reachable by a screen reader. Placing 1,000 costs **1.3 ms** with layout (measured; paint not counted). | Godot text: captions overlap and need rules (Entridir: P:218-224, P:888-890); fonts differ by system (P:1523). | Text inside the wasm canvas; no DOM. | DOM, as A2. |
| **Keyboard and screen reader** | DOM, ARIA, a list twin; VS Code adds `vscode-using-screen-reader` to the body (VS Code docs). | Same. | AccessKit on Windows, Linux and macOS (Godot docs). Names were set but "nobody has listened to them" (Entridir: P:665-666). A separate window sits outside VS Code's keyboard paths. | No web accessibility documented (Godot docs). Needs a DOM twin anyway. | DOM, but outside VS Code. |
| **Testing** | Headless Edge or Chrome over CDP, the harness `test/` already uses. This bench drove it, and drove a real Extension Development Host. | Same; also runs on software WebGL in CI (measured). | GDScript suites headless (Entridir: P:1535); one demo run in about 14 failed, cause unknown (P:316-319). No CDP; end-to-end needs both processes. | CDP reaches the page, but the scene is an opaque wasm canvas. | CDP for a browser; a shell needs its own driver. |
| **One view of every workspace, several windows** | Needs the machine-wide hub (each window has its own extension host). An action for another window's workspace goes through the hub. | Same. | Needs the same hub and the same routing. It is naturally one window. | Same as A. | Same as B. |
| **Reuse** | `scene.js` as is, plus the `lattice.ts` pattern (panel, CSP, ready/graph/open). | `scene.js` `geometry()` and `edgePoint()` (this bench reused both), plus the Canvas renderer as the fallback. | Entridir's Godot looks, line shader and log readers, as code. That app is a separate product with its own readers. | The Godot looks, but networking must be rewritten for the web: no TCP or UDP (Godot docs). | Web code, as A2. |
| **Licence (repo is GPL v3)** | Own code. | three.js MIT: compatible; add it to `licenses/` and `THIRD_PARTY_NOTICES.md`. | Godot MIT: compatible; ship its licence and `COPYRIGHT.txt` (Godot docs). | Same as B. | Tauri and Electron MIT. |
| **Survives moving and hiding** | Moving to a new window **reloads the page**. Measured: 1 reload; `getState()` kept, even with `retainContextWhenHidden`. Matches VS Code 1.88 notes. | Same. | Unaffected. | Same as A, and the engine restarts. | Unaffected. |
| **Rank (judgement)** | 3rd: the fallback. 18.45 ms at 200 nodes is over a 60 fps frame while dragging. | **1st** | 2nd | 5th: Godot's costs without its separate window. | 4th: B's bridge, with Electron's measured cost or a new shell. |

### Canvas or three.js

The plan asked for Canvas against three.js at 40, 200 and 1,000 nodes (Entridir: `nexus-3d/docs/research/2026-11-16-nexus-3d-infrastructure-options.md` section 5, question 2). Measured in the VS Code webview, median "finished" draw:

| Nodes | Canvas 2D (scene.js) | three.js WebGL2 |
|---|---|---|
| 40 | 4.0 ms | 1.1 ms |
| 200 | 18.45 ms | 2.1 ms |
| 1,000 | 91.6 ms | 8.95 ms |

**What this shows:**
- **Canvas is enough at 40 nodes** and misses a 16.7 ms frame at 200. Removing its glow saves about a quarter: 14.5 ms at 200 and 74.0 ms at 1,000 (headless, measured).
- **three.js stays under a frame at 1,000 nodes**, and under 34 ms even on software WebGL.
- **Draw-on-change makes both free at rest.** Speed matters only while the camera moves and during bursts of events.
- **So:** three.js for the view, and the Canvas renderer behind the same interface for when WebGL2 is missing.

## 2. What choosing this gives up (the case for Godot, answered)

The owner leans towards Godot, and the old tab was removed on 25 November 2026 to be remade as a separate app. **The evidence points away from both.** Here is what he would give up by following it.

**What he gives up:**
- **A view with VS Code closed.** A webview exists only inside a VS Code window. A floated window belongs to its main window and comes back with it (VS Code 1.86 notes). Agents run from a bare terminal with no VS Code open would go unseen until a window opens. They are still recorded, if the hub's collectors are installed per user (02-live-signals.md).
- **A window that never reloads.** Moving the tab to a new window reloads the page once (measured). The host resends a snapshot, and camera and selection come back from `getState()`, so the owner should see a short redraw, not lost state. That is judgement: not yet tried with a live feed.
- **Direct reuse of Entridir's GDScript looks and line shader.** Their ideas carry over (01-mockup-critique.md); their code does not.

**What he does not give up:**
- **Drawing nothing at rest.** The webview drew 0 frames at rest. The page's main thread was busy 1.6 ms in 10 s (headless, GPU). VS Code's whole tree used 0.188 s per 10 s with the panel open. Godot manages 0.47–0.55 s per 60 s, most of it its own scan.
- **Low memory.** VS Code is already open wherever this view is used, so the honest comparison is +28.4 MB private and one process (webview) against a whole 189–194 MB process (Godot).
- **A real 3D engine.** three.js has meshes, shaders, instancing and picking.

**Why the old tab felt broken, and why that does not argue for a separate app.** Its focus problems came from typing: the lattice opened cards whose live terminals were xterm instances in other webviews. The first keys after a click could reach the previous terminal, because no API orders a click in one webview before the next key in another (Entridir: `nexus-3d/docs/evidence/…/2d3830-native-focus-api.md:3`, `…/65242d-cross-webview-handoff.md:3`).
- **This view never takes typing.** Every change happens in ordinary VS Code UI, and a click calls a VS Code command such as `showTextDocument` or `terminal.show`. The worst case is one key landing in the 3D page, which ignores it.
- **A separate app has the same race, and a harder one.** The click is in another OS process, and Windows limits which process may take the foreground.

## 3. When the runner-up (Godot app + bridge) wins

Choose B instead if any of these holds:

1. **The view must run with no VS Code window open.** For example: always on a second screen while agents run in plain terminals, or watching another machine.
2. **WebGL2 fails in webviews on the owner's Linux machine or in VSCodium** (not measured), and the Canvas fallback is too slow at the node counts reached. Canvas took 18.45 ms at 200 nodes and 91.6 ms at 1,000, against 1.1–8.95 ms for three.js.
3. **Webview cost on Linux turns out far above the +28 MB and one process measured on Windows**, or VS Code changes how floated webviews behave.
4. **Entridir's Godot app becomes the owner's daily tool anyway** (Entridir: P:1469-1470). Then its installer is already paid for, and the bridge is the only new piece.

Because of section 6, choosing A2 now does not close this door: B can attach later to the same feed and action channel.

## 4. The three biggest risks, and how to reduce each

1. **No WebGL2, or a lost context.**
   - **Where:** a Linux GPU blocklist, remote desktop, a VM, or a VSCodium build.
   - **Reduce it:** keep the Canvas renderer behind the same scene interface; choose at start, and fall back on `webglcontextlost`.
   - **Test it:** run CI with `--disable-gpu`, which measured 33.95 ms at 1,000 nodes for three.js on software WebGL.
   - **Before building:** run `bench/vscode-probe/` on the Linux machine and in VSCodium. It takes about two minutes and settles question 1 of the infrastructure options.
2. **Webview lifecycle: reload on move, and loss when hidden.**
   - **Reduce it:** make the host the only source of truth. On the page's `ready`, send a snapshot, then changes. Keep camera and selection in `setState`.
   - **Leave out `retainContextWhenHidden`.** VS Code says it "has high memory overhead and should only be used when other persistence techniques will not work". The removed tab used it (`lattice.ts:110`).
   - **Test it:** the probe's move test (1 reload measured), made a test.
3. **Keyboard focus between the 3D page and the rest of VS Code** (the F121 history).
   - **Reduce it:** the page sends no keys anywhere and owns no terminal. Each action names its focus (`preserveFocus`), and keyboard movement inside the scene goes node to node.
   - **A screen-reader list twin** is part of the same page.
   - **Native check:** click a resource, then type at once. The keys must land in the opened editor, and none may reach a terminal.

## 5. Cost of the recommendation

| | Cost | Source |
|---|---|---|
| Processes | +1, the webview renderer. No daemon: the hub is files. | Measured (light probe: 12 → 13) |
| Memory | +28.4 MB private, +133.4 MB working set, panel drawn once. GPU process +11.5 MB private. | Measured |
| Idle CPU | VS Code tree 0.188 s per 10 s with the panel at rest, against 0.094 s without. One sample each, so the difference is within what one sample resolves. Never use a never-stopping loop: it measured 24.25 s per 10 s. | Measured |
| Frames at rest | 0 | Measured (headless) |
| Install steps | None beyond installing or updating Wyarden. +420,122 bytes compressed in the VSIX for three.js. | Measured |
| New dependency | three.js 0.187.0, MIT, vendored under `media/` with its licence (as the CSP requires; Entridir infrastructure options section 2.5). | Docs |

The wiring plan (step 5) sizes the engineering work in sessions.

## 6. Keeping the feed and the action channel independent of the renderer

**What it takes:**
- **The event feed lives in the extension host and the hub**, never in the page. It is the common vocabulary of 02-live-signals.md as contract version 1: a snapshot on connect, then changes, each with an id and a sequence number. The page sees it only through one function, `subscribe(onEvent)`. Step 4's mock-ups use the same seam.
- **The action channel is one request shape**, `{v: 1, action: "open" | "diff" | "focus" | "showCall" | "openMcpConfig", target: {class, id}}`. The host checks it and maps it to a VS Code command. A renderer never names a command, a path or a window; the host resolves the target.
- **Slot positions are computed once**, in a pure module the host runs, and sent with the snapshot. Any renderer then draws the same picture without porting the layout.
- **A second renderer, such as a Godot app later,** gets a loopback WebSocket endpoint in the extension. It binds to 127.0.0.1 only (Godot's `TCPServer.listen` defaults to all interfaces, so the bind address must be explicit). It uses a token in a file only the user can read, and starts only when a renderer asks.

**What it costs** (judgement, except where marked):
- The contract and its version rules: needed for the webview anyway, so no extra cost.
- Slot positions in the snapshot: a little more data per change.
- The loopback endpoint: about one session with its tests, built only when a second renderer is wanted. It costs nothing at runtime until then.
- **What it forbids:** state the page computes that the host does not know about. The test for that is replaying a recorded event file into two renderers and comparing their selection and slot lists.

## 7. The case against 3D, answered

The visualiser survey concluded "3D. Occlusion and WebGL for no extra information" (Entridir: `nexus-3d/docs/research/2026-11-11-live-agent-visualizers-report.md:235`). It also found that the 15 "world" visualisers carry about as much as a live dot and a `doing:` line (`…:9, 223`).

- **The third axis must carry meaning.** Here, height is the class: agents, then tools, then resources, with MCP servers at the boundary, on fixed floors. The ground plane is per-agent columns with slots that never move. Class separation then shows as height, and a top-down camera preset gives the 2D map.
- **Honestly, nothing here is impossible in 2D.** The information could be lanes. What 3D adds is room for many agents and their resources in one view without scrolling, plus the owner's preference.
- **The plan protects information from the 3D:**
  - every node is also in a list twin;
  - labels are DOM and drawn on top, so occlusion never hides a name;
  - the selected item is always drawn in front;
  - nothing important depends on depth.
- **"WebGL for no extra information" is now a measured cost:** zero at rest, and +420 KB compressed in the package. Below about 40 nodes even WebGL is optional (Canvas at 4.0 ms).
- **If the owner finds the 3D adds nothing,** the list twin and a 2D look remain, on the same feed.

## 8. Unverified

**Not measured:**
- **Linux, VSCodium, WSL and SSH.** No Linux desktop was reachable, the WSL Ubuntu here has no Chrome or Node, and VSCodium is not installed here. That leaves open, on Linux and VSCodium: WebGL2 in a webview, memory, idle CPU, and the Remote path.
- **Delay from event to pixel, end to end.** No live feed exists; this plan wires nothing.
- **`postMessage` latency.**
- **Paint and compositing of DOM labels.**
- **Godot, desktop and web export:**
  - the Godot web export's memory, idle CPU and wasm size, since it needs export templates and nothing may be built in Entridir;
  - Godot draw time at 40, 200 and 1,000 nodes: Entridir recorded only 75–79 shapes.
- **The bridge's own memory under option B.**

**Inferences, not checked:**
- That a Godot web export inside a webview needs the single-threaded build, because a webview cannot send COOP and COEP headers.
- That it needs `'wasm-unsafe-eval'` in the CSP. The VS Code docs do not mention WebAssembly.

**Not tried:**
- Whether VS Code takes the foreground when a separate app asks it to act. This weighs against B and D, and would need measuring if either is chosen.
- A real screen reader on the list twin. Nobody has listened to Entridir's Godot names either.
- The hub's multi-window appends on Windows and Linux (infrastructure options, question 5).

**Not broken down:** why VS Code's GPU process held 418.1 MB after the 1,000-texture benchmark.

**Single samples:** the idle CPU figures are one 10 s sample per phase.

---

## Appendix A. Measurements

Method, raw files and how to run them again are in [bench/README.md](bench/README.md). In short:
- **Page:** `bench-page.js` drives the unmodified `scene.js` and an equivalent three.js scene. Each of 50 full draws turns the camera a step after 10 warm-ups. The "finished" time includes a one-pixel read, so queued raster and GPU work is counted.
- **Headless:** `draw-bench.js` runs headless Edge 158 with and without `--disable-gpu`.
- **Real webview:** `vscode-probe/` runs in an isolated VS Code 1.148 Extension Development Host and samples its process tree.
- **Inputs:** Entridir files were read in place and never copied, changed or built. three.js 0.187.0 was fetched into a temporary folder and is not committed.

## Appendix B. Official documentation checked today (26 November 2026)

**VS Code:**
- [Webview guide](https://code.visualstudio.com/api/extension-guides/webview):
  - No mention of WebGL, GPU or WebAssembly, so WebGL2 was measured instead (section 1).
  - `retainContextWhenHidden` "has high memory overhead and should only be used when other persistence techniques will not work"; "getState and setState are the preferred way to persist state".
  - The CSP starts from `default-src 'none'`, with local files through `asWebviewUri` and `localResourceRoots`.
  - Workers load only from `data:` or `blob:` URIs.
  - It adds `vscode-using-screen-reader` and `vscode-reduce-motion` classes.
- [Release notes 1.85](https://code.visualstudio.com/updates/v1_85), [1.86](https://code.visualstudio.com/updates/v1_86) and [1.88](https://code.visualstudio.com/updates/v1_88):
  - 1.85 added Move Editor into New Window.
  - 1.86: floating windows restore with their main window.
  - 1.88 extended moving to webview editors: "moving a webview-based editor between windows requires the contents of that editor to reload".
- [Remote extensions](https://code.visualstudio.com/api/advanced-topics/remote-extensions):
  - Workspace extensions run on the remote, and a webview "is always run on the user's local machine".
  - `localhost` in a webview is the local machine unless `portMapping` is used; `asExternalUri` forwards ports.
- [Webview UX guidelines](https://code.visualstudio.com/api/ux-guidelines/webviews): views should follow colour contrast, ARIA labels and keyboard navigation.

**Godot (4.7 stable docs):**
- [Exporting for the Web](https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html):
  - It needs WebAssembly and WebGL 2.0.
  - Single-threaded export is "the preferred and now default way".
  - The threaded build needs COOP and COEP headers.
  - "Low-level networking is not implemented".
  - Projects pause in an inactive tab.
  - C# projects cannot be exported.
- [High-level multiplayer](https://docs.godotengine.org/en/stable/tutorials/networking/high_level_multiplayer.html): the web has WebSockets and WebRTC, but no raw TCP or UDP.
- [TCPServer](https://docs.godotengine.org/en/stable/classes/class_tcpserver.html): `listen(port, bind_address = "*")` listens on all addresses unless one is given.
- [OS](https://docs.godotengine.org/en/stable/classes/class_os.html): `low_processor_usage_mode` refreshes "only … if needed". `low_processor_usage_mode_sleep_usec` defaults to 6900. Entridir uses 33000 (R:268). Whether it applies on the web: docs silent.
- [AccessibilityServer](https://docs.godotengine.org/en/stable/classes/class_accessibilityserver.html): screen reader support "implemented on Linux, macOS, and Windows"; nothing for the web.
- [Complying with licenses](https://docs.godotengine.org/en/stable/about/complying_with_licenses.html): MIT; ship the licence text.
- [Exporting for Windows](https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_windows.html): signing on export needs a certificate.
