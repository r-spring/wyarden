# Looks: every idea our interfaces and mock-ups show

**What this is:** the list for card 9a8eb9, milestone 1. Every interface and mock-up in this repository, and each idea it shows, one entry per idea.
**What an entry is:** one thing you could pick as a look. Its id is fixed here: it becomes the look's file name, its button, and the name the checks use.
**The count:** 18 ideas. 4 are looks today (2 in each monitor page), 14 are not built as looks.
**Where they will live:** in the live 3D Monitor tab, with a browser preview of that same page. You chose this on 27 November; see the end.

Written 27 November 2026.

**Changed the same day:** after this list was made, the Entomatical extension moved out of this repository into its own (commit `9f73bb0`). Section C and the table of interfaces with no look idea describe files as they stood here at commit `0a8c20c`. They are now in the Entomatical repository, and still in this repository's history.

## What a look carries

The rule is this repository's own ([the critique](../monitor-3d/01-mockup-critique.md), "The concept to build on"): a look has no say in where a thing stands, and nothing moves unless a call happens.

- **In a look:** colours, shapes, line weight and glow, caption style and lettering, the page's own colours and fonts, and a still backdrop (a street grid, orbit rings, contour lines).
- **Not in a look:** where things stand, anything that moves by itself, any control, any new behaviour.
- **So, for example:** Orbital Mechanics as a look has its lilac spheres, its rings and its indigo sky, on the same four floors and columns as every other look. Its planets do not orbit.
- **How true to the original:** an original is drawn as its picture shows it, in its own colours and shapes. Where an original gives every type one shape (Event Horizon, Signal Terrain), the look keeps that: the floor and the caption still say what class a thing is.
- **State is never a colour.** In every look a state is a mark beside the shape, with its name in the caption. Where an original colours things by state (Skyline, Control Room), the look uses those colours for the classes instead.

## The list

### A. The 3D monitor's looks that exist today (4)

Source is in this repository. Each pair is one idea in two versions that look different, so each version is an entry.

| id | Look | Shown in | What it looks like | Today |
|---|---|---|---|---|
| `nexus` | NEXUS lattice, as the live tab draws it | `ui-concepts/monitor-3d-live/media/look-nexus.js` · [screenshot](../monitor-3d/img/live/vscode-0.1.1.png) | Blue-black, glowing wireframe, capitals in a monospace font. An agent is an icosahedron and a subagent a dodecahedron, in their provider's colour (Claude orange, Codex blue, Antigravity purple, Grok green). Mint cubes for tools, amber hexagons for MCP servers, violet sheets and globes for resources. Captions have no plate. | A look in the live tab |
| `glasshouse` | Glasshouse, as the live tab draws it | `ui-concepts/monitor-3d-live/media/look-glasshouse.js` | Pale grey-green with tinted glass floors, no glow, ordinary sans-serif lettering. The same two solids in darker provider colours; green braced crates, burnt-orange hexagons, purple resources. | A look in the live tab |
| `nexus-mockup` | NEXUS lattice, as the simulated mock-up draws it | `ui-concepts/monitor-3d/look-nexus.js` · [screenshot](../monitor-3d/img/after/nexus.png) | The same dark wireframe with one colour for each class: a cyan octahedron for an agent, a blue pyramid for a subagent. Captions sit on a dark plate. | A look in the simulated page |
| `glasshouse-mockup` | Glasshouse, as the simulated mock-up draws it | `ui-concepts/monitor-3d/look-glasshouse.js` · [screenshot](../monitor-3d/img/after/glasshouse.png) | Light. An agent is a teal stepped tower with a mast, a subagent a blue two-step chip; green crates, orange hexagons. Captions sit on a pale plate. | A look in the simulated page |

### B. The seven original mock-ups (7)

Shown in this repository as screenshots and [a critique](../monitor-3d/01-mockup-critique.md). Their source is in the Entridir repository at commit `63197c31`, under `nexus-3d/ui-concepts/` (GPL v3, as this repository; the two looks above were carried over from the same place).

| id | Look | Shown in | What it looks like | Today |
|---|---|---|---|---|
| `lattice` | NEXUS lattice, the original | [lattice.png](../monitor-3d/img/before/lattice.png) | Blue-black, with a ground grid and rings round the centre. Glowing wireframe octahedrons, cubes and rings in eight colours: cyan for control, blue for tasks, mint for tools, amber for delivery, violet for accounts and context. Small capitals in a monospace font. | Not built |
| `circuit-city` | 01 Circuit City | [city.png](../monitor-3d/img/before/city.png) | Navy. Agents are tall cyan wireframe towers; the rest are amber and cyan blocks, on a blueprint street grid with district outlines. Wide-spaced capitals. | Not built |
| `orbital` | 02 Orbital Mechanics | [orbit.png](../monitor-3d/img/before/orbit.png) | Indigo, nearly black, with stars and tilted orbit rings. Lilac latticed spheres, peach rings and small pyramids. An italic serif title and rounded panels. | Not built |
| `glasshouse-original` | 03 Glasshouse, the original | [glass.png](../monitor-3d/img/before/glass.png) | Pale daylight. Stacked glass floors with lift shafts; flat stepped chips in teal and sage only. A serif title. | Not built |
| `synapse` | 04 Synapse | [synapse.png](../monitor-3d/img/before/synapse.png) | Dark plum. Pink beads and mint diamonds joined by curved nerve strands. An italic serif title and pill-shaped buttons. | Not built |
| `event-horizon` | 05 Event Horizon | [horizon.png](../monitor-3d/img/before/horizon.png) | Near-black. Rings inside rings, like a tunnel; every node is a round clock face in amber or pale cyan. Thin, wide-spaced capitals. | Not built |
| `signal-terrain` | 06 Signal Terrain | [terrain.png](../monitor-3d/img/before/terrain.png) | Dark green. A wireframe landscape with contour lines and a north arrow; every node is a small beacon in olive or gold. An italic serif title in cream. | Not built |

### C. The Entomatical board and the landing page (4)

The Entomatical board was this repository's main extension when the list was made. It has no look switch of any kind: nothing sets a theme, a skin or a density. It shows two styles of its own (paths below are Entomatical's, at commit `0a8c20c` here). The landing page, which is still here, shows a third in two versions.

| id | Look | Shown in | What it looks like | Today |
|---|---|---|---|---|
| `editor-theme` | The board's own skin (F52) | `media/board.css` lines 1 to 33 | No colours of its own: it takes the editor's theme, so it is dark, light or high contrast as the editor is. On top of that, the board's provider colours (Claude terracotta, Codex sky blue, Grok green, Antigravity lavender) and its status colours (blue running, amber needs input, green review). The editor's font, small pill chips, 4 px corners. | Not built |
| `battle-neon` | Battle Royale's neon (F105) | `media/board.css` lines 23 to 26 and 297 to 348 | Near-black with neon orange, electric blue, acid green and hot pink, each with a glow. Headings in a heavy, slanted, capital poster face. | Not built |
| `paper` | The landing page, light | `public/index.html` | Warm paper, dark brown-black ink, hairline rules, Palatino serif, a very large title. No accent colour at all. | Not built |
| `paper-dark` | The landing page, dark | `public/index.html` lines 19 to 22 | The same page turned over: brown-black with cream ink. | Not built |

These three interfaces are flat pages, so they show colours and lettering but no 3D shapes. As looks in the monitor they would bring their colours, lettering and line style; the shapes would be the plain wireframe ones.

### D. Named in this repository, shown only in Entridir (3 kept, 2 left out)

This repository names five more ideas and borrows rules from them, but has no picture of them. You asked on 27 November for those that are quite different from the other looks, and not the derivatives. Each was looked at in Entridir: the four Godot looks in `docs/verification/godot-looks/looks.png`, Signal House by opening its page.

| id | Look | Shown in (Entridir) | What it looks like | Today |
|---|---|---|---|---|
| `skyline` | Skyline, from the Godot build | `godot/looks/skyline.gd` | Off-white. Solid glass blocks and towers outlined in dark ink: teal-green blocks, with amber, red and blue towers. The only light city, and the only look with solid, ink-outlined shapes. | Not built |
| `control-room` | Control Room, from the Godot build | `godot/looks/control_room.gd` | Black. Flat, heavy, solid marks (triangle, cross, disc, diamond, square, dot), large lettering and thin grey rules, like a wall chart. Its colours were chosen to stay apart for colour-blind eyes. | Not built |
| `signal-house` | Signal House | `nexus-3d/ui-concepts/signal-house-29d4d1/` | Warm paper beside dark slate panels. Slate ink with vermilion, sage green and blue; large serif headings with an italic flourish; small spaced capitals. `paper` is its plainer relative: one ink and no accent. | Not built |

**Left out as derivatives:**

| Idea | It is a relative of | Why it adds nothing as a look |
|---|---|---|
| Synapse, from the Godot build | `synapse` | The same plum ground, pink strands and mint diamonds. What differs is how its tree is arranged, which a look does not carry. |
| Orbit, from the Godot build | `orbital` | Rings round a sun on a dark blue sky, as in Orbital Mechanics. What differs is that its shapes are coloured by state, which a look here may not do. |

## Interfaces with no look idea of their own

The first four are Entomatical's, at commit `0a8c20c`. So are the test harness pages.

| Interface | Where | Why it has no entry |
|---|---|---|
| Plan set-up ("Run a plan…") | `media/plan-setup.css`, `plan-setup.js` | A section of the board. Editor colours only: `editor-theme` covers it. |
| Helper tab | `src/helper-tab.ts`, `media/helper-tab.js` | Loads the board's stylesheet. No style of its own. |
| Card terminal | `media/card-terminal.js` | The editor's own terminal colours. |
| Status bar items, quick picks, the output channel | `src/extension.ts` | Drawn by the editor. |
| The bench page | `docs/monitor-3d/bench/page.html` | Draws the original lattice to time it. Nothing of its own. |
| The test harness pages | `test/*-harness.html` | The real board, loaded for tests. |
| The live tab's workspace chips, list, inspector and legend | `ui-concepts/monitor-3d-live/media/` | Parts of the page. Each look already colours them. |

## Where the looks live

**Decided on 27 November: the live 3D Monitor tab, with a browser preview of that same page.** One set of look files, in `ui-concepts/monitor-3d-live/media/`. You switch in the real tab on your own sessions. The preview shows the same page with invented data, so every look can be photographed and checked with nothing installed.

The repository did not say. The same two looks already lived in two places whose files have grown apart, and the main extension has no place for a look at all. The places that were weighed:

| Place | What it is | For | Against |
|---|---|---|---|
| The live 3D Monitor tab | `ui-concepts/monitor-3d-live/`, the VSIX you installed | It is what you use, on your real sessions. Its drawing code is the newer one: provider colours, both solids, captions with or without a plate. | Card 7917d5 is changing its page files now. You must install the new VSIX and reload each window. |
| A browser preview | A page opened from a local address, with invented data | Nothing to install. Every look can be photographed and checked. | It is not your real sessions. |
| The simulated mock-up page | `ui-concepts/monitor-3d/` | It exists, and nobody else is changing it. | Its drawing code is the older one: no provider colours, no icosahedrons, until they are carried back. |
| The Entomatical board | `media/board.css` | It is the main extension. | A board has no 3D scene: only colours and lettering would carry over, so most of the ideas would lose their shapes and backdrops. |
