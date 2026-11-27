# 3D agent monitor, step 1: critique of the seven NEXUS mock-ups

Step 1 of the plan in `workflows/2026-11-26-monitor-3d-design.plan.json`. This is a document only: nothing here is wired.

## Verdict

1. None of the seven can be wired as it is. All seven redraw every frame forever: with the replay paused and motion off, they still drew 11 to 50 frames and 32,000 to 120,000 canvas strokes a second.
2. None has a class for files, URLs or MCP servers. MCP is one tool node labelled `SEARCH / MCP`, and a tool call is a number in a metric, not an event.
3. Class is drawn weakly. Tool and task share one mesh in the lattice and in Glasshouse, Event Horizon and Signal Terrain use one mesh for every type, the worlds have only two type colours, and a blocked or waiting status colour replaces the type colour everywhere.
4. The layouts cannot take live data. Inserting one node moves 11 to 15 others in four worlds, two worlds move nodes every second, and labels already overlap at 40 nodes (6 to 24 overlapping pairs; up to 600 at 80 nodes).
5. Build on Glasshouse's fixed floors (one floor per class) crossed with Circuit City's per-agent columns, with stable slots. Keep NEXUS as a look over that layout, and make it the default look, because the owner accepted it by eye.

## How this was checked

- Each mock-up ran from its own `serve.js` on loopback (4320 for the lattice, 4321 for the worlds). Both servers were stopped afterwards.
- Headless Edge took the screenshots at 1600 × 1000 over the DevTools protocol, three seconds after load. The same run counted animation frames, canvas `stroke()` calls, script time, and the labels drawn in one frame. The script is [probe/shoot.js](probe/shoot.js); its numbers are in [probe-results.json](probe-results.json).
- [probe/stability.js](probe/stability.js) runs each world's `layout()` in Node and counts how many existing nodes move when one node is added.
- Three extra screenshots load 40 more nodes (16 tools, 6 of them MCP tools, and 24 files) into the lattice, Circuit City and Glasshouse.
- Code was read line by line. In the citations below, `L/` is `nexus-3d/ui-concepts/nexus-lattice-29d4d1/` and `W/` is `nexus-3d/ui-concepts/nexus-worlds-29d4d1/` in the Entridir repository.
- **Cost figures are indicative only.** They come from headless Edge on one machine, not from a VS Code webview. Their size relative to each other, and the fact that they do not fall when the data stops changing, is the finding. The exact milliseconds are not.

| Screenshot | What it shows |
| --- | --- |
| [lattice.png](img/before/lattice.png) | NEXUS lattice, 40 nodes, default camera |
| [city.png](img/before/city.png) | Circuit City |
| [orbit.png](img/before/orbit.png) | Orbital Mechanics |
| [glass.png](img/before/glass.png) | Glasshouse: the floors overlap in projection at the default camera |
| [synapse.png](img/before/synapse.png) | Synapse |
| [horizon.png](img/before/horizon.png) | Event Horizon: nodes are drawn under the transport and event panels |
| [terrain.png](img/before/terrain.png) | Signal Terrain: every type is the same beacon |
| [lattice-80-nodes.png](img/before/lattice-80-nodes.png) | The lattice with 40 more nodes: MCP tools are plain cubes, and files take the account ring |
| [city-80-nodes.png](img/before/city-80-nodes.png) | Circuit City with 40 more nodes: tools run off in a line, and fitting shrinks the city to 0.20× |
| [glass-80-nodes.png](img/before/glass-80-nodes.png) | Glasshouse with 40 more nodes: floors re-grid, and labels pile up |

### The starting points, checked

| Claim | Result |
| --- | --- |
| Hand-written Canvas 2D projection in a `requestAnimationFrame` loop that never stops | **True.** `L/scene.js:6-14` and `W/engine.js:6-14` project by hand. `L/app.js:117-127` and `W/world.js:100-111` call `requestAnimationFrame` on every frame, and only `pagehide` cancels it. |
| `model.js` is the same file in both | **True.** The two files have the same SHA-256. |
| 12 node types, 40 nodes, 52 edges, 32 scripted events | **True** (counted by `probe/stability.js`). |
| No file, URL or MCP server class | **True.** `L/model.js:10` lists the 12 types. MCP is one tool node, `L/model.js:52`. A file appears only as a `context` node (`HANDOFF.MD`, `L/model.js:44`) or as the `FILE SYSTEM` tool. |
| A tool and a task share one shape | **True in the lattice** (`L/scene.js:21-22`: everything not listed is a cube) **and in Glasshouse** (`W/modes-glass-synapse.js:118`: both fall through to `box(26,4,20)`). **Near-true in City** (two prisms of similar size, `W/modes-city-orbit.js:113`). **False in Orbit and Synapse**, which give tools their own mesh (`W/modes-city-orbit.js:206`, `W/modes-glass-synapse.js:235`). **Worse in Event Horizon and Signal Terrain**, which use one mesh for all 12 types. |
| Status colour replaces type colour | **True for blocked and waiting** (`L/scene.js:70`, `W/engine.js:68`). An idle node is dimmed instead; active and complete keep the type colour. |
| Layouts move existing nodes when the count changes | **Partly true.** Inserting one node mid-list moves 11 (City), 12 (Orbit), 12 (Glasshouse) and 15 (Event Horizon) existing nodes. Appending ten moves 13 in Glasshouse; appending one moves 5 in Synapse. The lattice and Signal Terrain have no layout at all: positions are hand-written in the fixture. |
| Labels collide past about 40 nodes | **Wrong: they already collide at 40.** In one frame there are 6 to 24 overlapping label pairs. At 80 nodes there are 27 (lattice), 43 (Glasshouse) and 600 (City). |
| Glasshouse's fixed floors plus Circuit City's per-agent columns are the best base | **Agreed, with conditions**: see "The concept to build on" below. |

## What each mock-up is

All seven share one data model: `model.js`, a fixed fictional graph whose nodes carry hand-written `position`s and whose 32 events are replayed over 120 seconds. To apply events, the replay rebuilds the graph from the seed and applies every event up to the current time (`L/app.js:29`, `W/world.js:70`). The six worlds also share one renderer, `W/engine.js`, a copy of `L/scene.js` with hooks for each world's `environment`, `shape` and palette.

| Mock-up | Renderer | Data model | Visual encoding | Interaction |
| --- | --- | --- | --- | --- |
| **NEXUS lattice** | `L/scene.js`: Canvas 2D wireframe, perspective by hand, glow by `shadowBlur`, redrawn every frame | `model.js` fixture positions, used as they are | 3 meshes for 12 types (octahedron, ring, cube). 8 distinct type colours (workspace, orchestrator and agent share cyan; worktree, main and remote share amber). Blocked and waiting recolour the node. Idle dims it. Active nodes have a pulsing ring. Edge colour by kind; dashed when inactive; a looping packet on each active edge. Ground zone labels. | Orbit, pan and zoom by drag, wheel, pinch or keys. Click or the directory selects. Hover tooltip. Strata toggles, lenses, search, trace lineage, focus, three camera presets, auto-orbit, replay scrubber, scenario jumps, snapshot export. |
| **01 Circuit City** | `W/engine.js` plus city environment: street grid, districts, skybridges, moving road traffic | Positions from `cityPosition()` (`W/modes-city-orbit.js:30-53`): four hard-coded provider districts. Owner guessed from id substrings (`:11`). Tools, worktrees and checks placed by list index (`:47-49`). | Agents are towers whose height is hard-coded per provider (`:29`), not taken from data. Other types are prisms of different sizes. Two palette colours for 12 types (`W/world.js:16`). | Shared world controls (below) plus "Show moving traffic only". |
| **02 Orbital Mechanics** | Engine plus inclined orbit rings and a star field | `orbitalPosition()` (`W/modes-city-orbit.js:123-141`): planets per provider; moons and satellites by index and **time** | Spheres for most types; tool, worktree and check share one tetrahedron (`:206`). Two colours. | Shared controls plus "Freeze orbital positions". |
| **03 Glasshouse** | Engine plus six stacked translucent floors, lift shafts, light palette | `glassFloor()` puts each type on a floor (`W/modes-glass-synapse.js:51-58`). Within a floor, a grid by index whose column count depends on the floor's total (`:66-80`). | Flat chips; agent, subagent, worktree, check and main each have their own chip. **Task and tool are the same box** (`:118`). Tools share the "evidence" floor with worktrees and checks (`:57`). Two colours. | Shared controls plus "Separate the floors" (y × 1.6). |
| **04 Synapse** | Engine plus Catmull-Rom nerve strands, recomputed every frame | Four hard-coded provider arms (`:122-125`) and an id-to-provider table (`:126-131`). Tools and context on root circles by index (`:177-182`). Active nodes "breathe". | Beads and loops. **Tool has its own root-shaped glyph** (`:235`); task, context and check are all beads (`:237`). Two colours. | Shared controls plus "Amplify the neural breath". |
| **05 Event Horizon** | Engine plus a scrolling ring tunnel | Depth = time of the node's first event minus now; angle by list index (`W/modes-horizon-terrain.js:16-21`). The whole world moves as time passes. | **One clock mesh for every type** (`:5-9`); only its size differs. Two colours. | Shared controls plus "Anchor the tunnel in time". |
| **06 Signal Terrain** | Engine plus a height field and contour lines, **recomputed every frame** (`:53-61`) | The fixture's hand-written positions, scaled, on a height field (`:47-52`) | **One beacon mesh for every type** (`:41`). Blocked nodes get red rings on the ground. Two colours. | Shared controls plus "Survey contours only". |

Shared world controls (`W/world.js`): orbit, pan and zoom; select in the scene or a searchable directory; focus; trace; four lenses (All, Agents, Friction, Delivery); one special toggle per world; replay and speed; scenario jumps; motion on or off; snapshot export. Selecting a hidden node resets the lens to reveal it (`:73`).

Signal House (`signal-house-29d4d1/`, 2D, out of scope) has three ideas worth borrowing:
- an attention queue first, longest wait first;
- a call ledger where a missing reading stays a gap instead of becoming a zero;
- clock times instead of "5 min ago", so nothing redraws as time passes.

## Weaknesses, most severe first

Each is weighed against the plan's needs:
- the owner clicks objects in 3D, and every change to information happens in ordinary VS Code UI;
- tools, resources (files, URLs, context) and MCP calls are separate, visible classes;
- the view runs beside the agents, so it draws only on change and its cost is measured.

| # | Severity | Weakness | Evidence |
| --- | --- | --- | --- |
| 1 | Critical | **It draws all the time.** The frame loop runs whether or not anything changed. With the replay paused and motion off, the seven pages still drew 11 to 50 frames a second, made 32,000 to 120,000 `stroke()` calls a second, and used 33 to 148 ms of script time a second. Signal Terrain is the worst: it rebuilds its height field and contours every frame. The wired Electron lattice (`ui/lattice.js:229-246`) also loops whenever it is visible. Only the Godot view (`godot/scripts/lattice_view.gd:5-9`, `:122`) renders on change. | `L/app.js:117-127`; `W/world.js:100-111`; `W/modes-horizon-terrain.js:53-61`; [probe-results.json](probe-results.json) `pausedMotionOff` |
| 2 | Critical | **No classes for what the plan must show.** There is no file, URL or MCP server type. MCP is a single tool node (`SEARCH / MCP`), and its calls are a metric (`calls: 12`), not events with a source, target and time. An agent's tools are edges to six shared tool nodes, so you cannot tell which call went where. | `L/model.js:10`, `:48-52`, `:96` |
| 3 | High | **Class is not visible.** The lattice has 3 meshes for 12 types; the worlds have 2 colours for 12 types (`W/world.js:16`). Tool and task are the same mesh in the lattice and Glasshouse. Event Horizon and Signal Terrain use one mesh for everything. Blocked and waiting recolour a node, so a waiting agent turns the amber of a worktree or check. In the 80-node lattice, MCP tools are ordinary cubes, and files take the account ring. | `L/scene.js:15-22`, `:70`; `W/engine.js:68`; [lattice-80-nodes.png](img/before/lattice-80-nodes.png); [terrain.png](img/before/terrain.png) |
| 4 | High | **Layouts are not stable.** Positions come from list index, floor totals or the clock, so a new node or a passing second moves things the owner may be about to click. Inserting one node moves 11 to 15 existing nodes in City, Orbit, Glasshouse and Event Horizon. Appending ten re-grids Glasshouse (13 moved). Orbit moves 20 nodes a second and Event Horizon 39. | `W/modes-glass-synapse.js:66-80`; `W/modes-city-orbit.js:131-137`; `W/modes-horizon-terrain.js:17-19`; [probe-results.json](probe-results.json) `layoutStability` |
| 5 | High | **Layouts are hard-coded to this fixture.** City and Synapse have exactly four provider slots and look nodes up by id. City places tools at `(index - 24) * 115`, so extra tools run off in a straight line, and fitting the view zooms the city out to 0.20×. The lattice and Signal Terrain have no layout at all. | `W/modes-city-orbit.js:11`, `:28-29`, `:47-49`; `W/modes-glass-synapse.js:122-131`; [city-80-nodes.png](img/before/city-80-nodes.png) |
| 6 | High | **Labels collide.** Every visible node gets a caption with no collision test. Overlapping label pairs in one frame: 6 to 24 at 40 nodes, and 27, 43 and 600 at 80 nodes (lattice, Glasshouse, City). At Glasshouse's default camera the floors also overlap in projection, so floor titles run into node labels. | `L/scene.js:77-78`; `W/engine.js:75-76`; [glass.png](img/before/glass.png); [glass-80-nodes.png](img/before/glass-80-nodes.png) |
| 7 | High | **Motion does not mean anything real.** Packets loop on every edge marked active, forever (`L/scene.js:67`). Workspaces spin, active nodes pulse, Synapse breathes and Glasshouse lifts circle. Road traffic in City is decoration. In a live monitor, motion has to mean that a call happened. | `L/scene.js:67`, `:73`, `:75`; `W/modes-city-orbit.js:96-99`; `W/modes-glass-synapse.js:96-101` |
| 8 | Medium | **The information UI lives inside the page.** Directory, inspector, metrics, event log, timeline and lenses are custom HTML around the canvas. Selection is the only thing the scene does, which is right. But in VS Code the inspector, lists and open actions belong in native UI (a tree view, a hover, Quick Pick, an editor), not in a second app inside a webview. | `L/app.js:44-69`; `W/world.js:54-68` |
| 9 | Medium | **Updates rebuild everything.** Each event re-seeds the graph and replays every earlier event. Every UI tick rewrites panel `innerHTML` (every 250 ms in the lattice, 300 ms in the worlds). Live use needs incremental updates and a bounded history. | `L/app.js:29`, `:120-122`; `W/world.js:103-105` |
| 10 | Medium | **Picking is coarse.** The lattice hit-tests a circle 10 px larger than the node and prefers the nearest in depth, not the nearest to the pointer. The worlds use a mesh bounding box plus 8 px, which is very large for City's towers, so overlapping nodes steal clicks. | `L/scene.js:36`, `:76`; `W/engine.js:36`, `:74` |
| 11 | Low | **Event Horizon draws under its own panels.** Its tunnel fills the page behind the transport and event panels, so nodes sit under them. | [horizon.png](img/before/horizon.png) |
| 12 | Low | **Per-frame waste.** The lattice looks up each edge's index with `indexOf(find())` for every edge on every frame, which is O(E²). Each edge is 16 separately stroked segments with `shadowBlur`. | `L/scene.js:66-67` |

The mock-ups do some things well: keyboard camera keys, a focusable canvas with an accessible name, a keyboard-reachable directory, reduced motion respected at start, and selection that reveals hidden nodes. Keep those.

## Can each concept carry the four classes?

Rated 0 to 3 on how well each concept could show agents, tools, resources and MCP servers as visibly separate classes, once fed real data. 3 means the concept's own structure separates the class; 0 means nothing does.

| Concept | Agents | Tools | Resources | MCP servers | Total /12 | Main flaw |
| --- | --- | --- | --- | --- | --- | --- |
| NEXUS lattice | 2 | 1 | 1 | 0 | 4 | No layout: positions are hand-written. 3 meshes for 12 types, and tool = task. |
| 01 Circuit City | 3 | 2 | 2 | 1 | 8 | Districts and tool lane are hard-coded and indexed; only two colours. |
| 02 Orbital Mechanics | 2 | 1 | 1 | 1 | 5 | Everything moves all the time, so clicking is a chase; tool = worktree = check. |
| 03 Glasshouse | 2 | 2 | 3 | 2 | 9 | Floors re-grid by count; tool = task box; tools share a floor with worktrees and checks. |
| 04 Synapse | 2 | 2 | 1 | 1 | 6 | Four hard-coded arms, and the organic curves are expensive; reads as one organism, not as classes. |
| 05 Event Horizon | 1 | 0 | 0 | 0 | 1 | One mesh for every type; position follows time, so nothing stays put. |
| 06 Signal Terrain | 1 | 0 | 0 | 0 | 1 | One beacon for every type; most expensive per frame (148 ms of script a second while idle). |

Why these scores:
- **Glasshouse** scores best on resources and MCP: a floor is a whole class at a glance, from any angle, without reading a label.
- **City** scores best on agents: a column per agent makes ownership readable.
- **Synapse and Orbit** are the only ones that give a tool its own mesh, but their structure (arms, orbits) is about providers, not classes.

## The concept to build on

**Glasshouse's floors crossed with Circuit City's per-agent columns, on stable slots.**

- **Y is the class.** There is one fixed floor each for agents, tools, MCP servers and resources. Glasshouse proves that a floor separates a class from any angle, and the plan asks for exactly these classes to be visibly separate.
- **X and Z are ownership.** Each agent gets a column through every floor, as City's districts do. An agent's tools, MCP calls and resources sit under it, so "which agent did this" needs no line. Shared items sit in a shared column.
- **Slots, not grids.** A node keeps the slot it was first given until it is removed. That is what Glasshouse's index grid and City's index offsets fail to do (weaknesses 4 and 5).
- **Not taken:** Glasshouse's light palette as the only look, its six Entomatical-specific floors, City's skyline decoration and traffic, and every ambient animation.

**Should the NEXUS lattice stay as a second look? Yes, and it should be the default look, but not as a layout.**

- The owner accepted the lattice by eye. Its dark wireframe, glow and type palette are its value.
- Its "layout" is hand-written coordinates (`L/model.js:19-64`), which cannot take live data.
- So NEXUS becomes a look over the shared floors-and-columns layout: palette, meshes, line weight, caption style. Glasshouse's light palette is the second look, useful when VS Code uses a light theme.
- Switching looks must not move anything. This differs from Godot, where a look also chooses the arrangement (`godot/looks/look.gd:1-4`). There, switching looks means relearning where things are.

## Improvements to build

Each item can be built and tested on its own. **M** marks a must-have, **N** a nice-to-have. Step 4 builds from this list.

1. **M. Four first-class node classes, with calls as events.**
   - Build: the model has `agent`, `tool`, `resource` (kind `file`, `url` or `context`) and `mcpServer`. A call is an event `{id, at, agent, target, kind, state}`, not a node and not a metric.
   - Test: a fixture with at least two of each class loads; an unknown class is rejected with an error; the legend shows a count per class equal to the fixture's.
2. **M. One fixed floor per class.**
   - Build: Y comes from the class alone. Agents are on the top floor, then MCP servers, then tools, then resources. Floors never change height when counts change.
   - Test: for every node, `position.y` equals its class's floor height. Adding 100 nodes of one class changes no floor height.
3. **M. One column per agent, for any number of agents.**
   - Build: columns are made from the data, ordered by first appearance, for 1 to 12 agents. A provider is a property, never read from an id. Shared tools and resources go in a shared column.
   - Test: fixtures with 1, 4 and 9 agents give non-overlapping columns. A text search finds no id-substring or provider-name branches in the layout code.
4. **M. Stable slots.**
   - Build: a node keeps its slot from first appearance until it is removed. A removed node leaves a gap, and only an explicit "Tidy" command compacts the gaps.
   - Test: the `probe/stability.js` cases as a unit test. Insert 1 in the middle, append 1 and append 10: **0** existing nodes moved. One second of time passing: **0** moved.
5. **M. Class is told by mesh and colour; state by a separate mark and text.**
   - Build: each class has its own mesh family and colour, and no state recolours it. State uses the Godot state shapes as a badge (see "What to carry over from the Godot looks"), plus its name in the caption.
   - Test: render-command check that the four classes produce four distinct mesh ids and colours. Changing a node's state changes only its badge and caption.
6. **M. MCP servers carry their tools.**
   - Build: an MCP server is one node on the MCP floor. Its tools are ports on that node, not free nodes. A call to `mcp__<server>__<tool>` lights that server's port. Step 2 settles the naming for each agent.
   - Test: a fixture with two servers and three tools each gives 2 server nodes and 6 ports. A call to `mcp__github__search_code` lights only the github node's port.
7. **M. Resources are grouped and capped.**
   - Build: files are grouped by folder, URLs by host, and context items stand alone. Each group shows a count. Past a cap per agent, one "+N more" node holds the rest.
   - Test: 500 file events give no more than the cap plus 1 resource nodes. The overflow node's count equals the number left out, exactly.
8. **M. Draw only on change.**
   - Build: there is no permanent animation loop. A frame is drawn when data, selection, hover, camera or size changes; frames run continuously only while the pointer drags.
   - Test: CDP probe. With no input and no data for 3 s: **0** frames and **0** strokes. One data event: at most 2 frames, plus the pulse frames of item 9.
9. **M. Motion means a call.**
   - Build: there is no ambient motion (no spin, breathing, orbit, lift or traffic). A call draws one pulse along its edge for at most 600 ms, then stops. With reduced motion, the edge is highlighted with no pulse.
   - Test: after one call event, frames stop within 1 s. With `prefers-reduced-motion`, a call draws exactly 1 frame.
10. **M. Cost is measured and has a budget.**
    - Build: the view counts frames, draw milliseconds, nodes, edges and labels. "Wyarden: 3D monitor cost" shows the counts in an output channel.
    - Test: a benchmark at 40, 200 and 500 nodes fails if a frame takes over 8 ms at 200 nodes, or if idle frames are above 0.
11. **M. Captions never overlap.**
    - Build: captions are placed greedily in priority order: selected, hovered, agents, nodes in a call now, MCP servers, then the rest. A caption whose box would overlap a placed one is skipped, and a skipped caption appears on hover.
    - Test: the overlap probe reports **0** overlapping pairs at 40, 80 and 200 nodes.
12. **M. A click selects; VS Code shows and changes.**
    - Build: a click in the scene posts `{type: "select", id}` and nothing else. The extension reveals the node in a native tree view. Opening a file opens the editor, opening a URL goes through VS Code's external-link confirmation, and an MCP server shows its configuration. The page has no form controls.
    - Test: an extension test where clicking a file node opens that file in an editor, and where the page DOM has no `input`, `select` or `textarea`.
13. **M. Picking finds what is under the pointer.**
    - Build: the node under the pointer is the one whose projected mesh outline contains the pointer. Ties go to the shape nearest the pointer, then the nearest in depth.
    - Test: two overlapping nodes. The pointer at each one's visible centre selects that one, and a pointer 20 px outside both selects nothing.
14. **M. Live data never moves the camera.**
    - Build: the camera moves only on user input or "Frame all". Framing ignores outliers beyond the floors' bounds.
    - Test: after 100 data events the camera state is unchanged. One far node does not shrink the framing below the floors' size.
15. **M. Updates are incremental and history is bounded.**
    - Build: events apply to the current graph with no re-seed or replay. Call history is a ring buffer per agent.
    - Test: 10,000 events in a row take under 1 ms each on average, and memory stops growing once the buffer is full.
16. **N. Two looks over one layout.**
    - Build: NEXUS (dark, the default) and Glasshouse (light), picked by VS Code's theme kind and overridable. A look changes palette, meshes and caption style only.
    - Test: switching looks leaves every node position identical.
17. **N. Separate the floors.**
    - Build: Glasshouse's toggle that spreads the floors vertically, as a stable view option.
    - Test: toggling twice restores every position exactly.
18. **N. Isolate one agent.**
    - Build: show one agent's column and its shared items alone, as Godot's "Isolate session" does. Escape returns to the saved camera.
    - Test: when isolated, every visible node is that agent's or shared, and after Escape the camera equals the saved one.
19. **N. Clash arcs.**
    - Build: two agents touching the same file get a dashed red arc between their columns on the resource floor, as in Godot.
    - Test: a fixture where two agents edit one file gives exactly one arc.
20. **N. A visible "left out" count.**
    - Build: when a cap applies, the view says how many items were left out, as `lattice.ts` `leftOut` does.
    - Test: the count equals the number of items not drawn.
21. **N. Attention first in the native view.**
    - Build: the tree view lists agents waiting on the owner first, longest wait first, with clock times rather than relative ones (from Signal House).
    - Test: order checked on a fixture. Nothing redraws when only the clock advances.

## What to carry over from the Godot looks

From `godot/looks/look.gd`, `godot/README.md`, `godot/scripts/lattice_view.gd`, `lattice_graph.gd` and `session_traffic.gd` in Entridir. These are the versions wired to real session readers; `docs/verification/godot-looks/looks.png` there shows four looks drawn on the same 66 sessions (35, 26 and 5 per workspace, by its captions).

**Carry over:**
- **Render on change, cheaply** (`lattice_view.gd:3-9`, `:122`). Render once per change (`UPDATE_ONCE`). All lines go in one batch and all fills in one mesh, rebuilt only when the data or look changes. Turning the camera costs no mesh work. No lights, shadows, multisampling or motion. While dragging, frames come faster than the 33 ms rest pace (`:55`, `:773`). This is improvement 8, already proven.
- **State is never told by colour alone** (`look.gd:6-7`, README "Looks"). Each state has a shape, a colour and its name, with one shared set:

  | State | Shape |
  | --- | --- |
  | needs you | pyramid |
  | stalled | cross |
  | working | globe |
  | unclear | diamond |
  | review | cube |
  | queued | hourglass |
  | done | small dot |

  Use these as the state badge in improvement 5, so they never collide with class meshes.
- **The urgency order** (`look.gd:13`): `needs_input`, `stalled`, `working`, `unknown`, `review`, `queued`, `idle`. It sets caption priority and the order of the attention list.
- **Captions** (`look.gd:31-49`, `lattice_view.gd:42-52`):
  - captions in ink, so text stays readable and the shape carries the state;
  - a caption that would cover another is left out, and pointing at a shape shows it;
  - a cap on resting captions (6 overall, 18 close up);
  - `keep_clear` boxes no caption may cover.
  This is improvement 11.
- **Camera and selection rules** (`lattice_view.gd:15-17`):
  - live data never moves the camera;
  - the selection is kept by id;
  - a selected item that disappears falls back to its parent.
- **Tool traffic** (`lattice_graph.gd:84-130`, `session_traffic.gd`):
  - one node per tool label, with a call count;
  - when a tool has several calls, active outranks pending, which outranks finished;
  - a cap with a `left_out` count;
  - **visual order sorted by label, so activity does not reorder things** (`:111-112`);
  - "pending" means the transcript records a request, and "active" needs evidence that execution started;
  - MCP tools are recognised by the `mcp__` prefix (`session_traffic.gd:309-315`).
  Step 2 should start from these readers.
- **Keyboard and screen readers.** Page Up and Page Down step through shapes, Enter goes in, Escape comes out, and the view, list and buttons have screen-reader names.
- **The look contract** (`look.gd`: palette, fonts, `shape()`, `mark()`; one script and one catalogue line per look), but without `layout()`: in Wyarden, looks must not move things (see "The concept to build on").

**Do not carry over:**
- **Tool traffic drawn as sessions.** Godot gives tool nodes `kind: "session"` and maps call states onto session states (`lattice_graph.gd:12`, `:122-124`), so a tool looks like a session. That is the class collapse this plan must avoid.
- **Tools only behind "Isolate".** In Godot, tools appear only after isolating one session. The plan wants tools, resources and MCP visible in the main view, on their own floors.
