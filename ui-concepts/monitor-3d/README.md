# Monitor 3D: the improved mock-ups

Step 4 of the plan "3D agent monitor: critique, approach, wiring plan". A mock-up only: **nothing here is wired**, and every session, file, URL and MCP server in it is invented.

It builds the concept that [the critique](../../docs/monitor-3d/01-mockup-critique.md) ranks first, floors for classes crossed with a column for each agent on stable slots, in two looks on one model and one engine:

| Look | File | Screenshot |
| --- | --- | --- |
| **NEXUS lattice** (dark, the default) | `look-nexus.js` | [nexus.png](../../docs/monitor-3d/img/after/nexus.png) |
| **Glasshouse** (light) | `look-glasshouse.js` | [glasshouse.png](../../docs/monitor-3d/img/after/glasshouse.png) |

More screenshots, all taken by `shoot.js` in headless Edge: one column alone ([NEXUS](../../docs/monitor-3d/img/after/nexus-one-column.png), [Glasshouse](../../docs/monitor-3d/img/after/glasshouse-one-column.png)), twelve agents ([NEXUS](../../docs/monitor-3d/img/after/nexus-12-agents.png), [Glasshouse](../../docs/monitor-3d/img/after/glasshouse-12-agents.png)), and 800 x 600 ([NEXUS](../../docs/monitor-3d/img/after/nexus-800x600.png), [Glasshouse](../../docs/monitor-3d/img/after/glasshouse-800x600.png)).

## Open it

No packages, no build step, no network.

```
node serve.js          # then open http://127.0.0.1:4330/   (loopback only; node serve.js 5000 for another port)
node check.js          # 82 dependency-free checks
node shoot.js          # screenshots and measurements, needs Edge or Chrome
```

`index.html` also opens directly from the folder, with no server.

The address can carry choices: `?look=glasshouse&agents=12&load=quiet&seed=3&warm=90&autostart=0`. `warm` is the number of seconds of the stream run before the first frame (45 unless given), so the scene is not empty when it opens.

## What is in the scene

- **Y is the class.** Four fixed floors, top to bottom: agents (with their subagents), MCP servers, tools, resources.
- **X and Z are ownership.** Each session gets a column through the floors, in order of first appearance, six columns to a row, twelve at most. MCP servers stand apart in a **dock at the boundary**, on their own floor, because several sessions share them.
- **Slots.** Each column has nine fixed slots on each floor: eight for nodes and one for a "+N" stack. A node's position is a function of its column, floor and slot only.
- **Calls are links.** A tool call is a line from the agent (or subagent) to the tool from its start event to its end event. A file or URL the call touched hangs off the tool for the same time: dashed for a read, solid with a head for a write, dotted for a search. An MCP call is a line to the tool's port on the server.
- **State is a mark beside the shape**, with its name in the caption: needs you (pyramid), failed (cross), working (globe), unclear (diamond), idle (hourglass), done (dot). No state changes a node's colour or mesh.

| Class | NEXUS | Glasshouse |
| --- | --- | --- |
| Agent | cyan octahedron | teal stepped tower with a mast |
| Subagent | blue pyramid | blue two-step chip |
| Tool | mint cube | green crate with a cross brace |
| MCP server | amber hexagon with a port for each tool | orange hexagon with a port for each tool |
| Resource | violet: a sheet (files in a folder), a globe (URLs on a host), a triangle (context) | purple: the same three |

## Keys

Focus the scene first.

| Key | Does |
| --- | --- |
| Left, Right | the selection moves along the floor |
| Up, Down | the selection changes floor inside its column (the MCP floor is the dock) |
| Page Up, Page Down | step through every node |
| Home, End | first and last node |
| Enter, Escape | show the selected agent's column alone, and come back; Escape also clears the selection |
| Shift + arrow | turn the camera |
| + and -, F, R | zoom, frame all, reset the camera |

Drag turns the camera, Shift-drag or right-drag pans, the wheel zooms. The **List** panel is the same scene as text for screen readers: a list box with one row for each node, and agents that wait for the owner first.

## The work list

The numbers are the critique's "Improvements to build". **M** is a must-have, **N** a nice-to-have.

| # | | Improvement | Status | How it was built, and what differs |
| --- | --- | --- | --- | --- |
| 1 | M | Four first-class node classes, calls as events | **Done** | Five classes: agent, subagent, tool, resource, MCP server. The model rejects any other class or event with an error. A call is a link, never a node or a metric. |
| 2 | M | One fixed floor per class | **Done** | `layout.js`. Subagents share the agents' floor. |
| 3 | M | One column per agent, for any number | **Done, with one difference** | 1 to 12 columns from the data; a provider is only a property. The shared column is the MCP dock. A resource is **not** moved to a shared column when a second agent touches it, because that would move a standing node (item 4): each agent keeps its own copy, and a clash arc joins them. Tools are per agent. |
| 4 | M | Stable slots | **Done** | 0 nodes moved over ten minutes of twelve busy agents. A node that leaves leaves a gap; the next arrival takes the lowest gap; only **Tidy** closes gaps. |
| 5 | M | Class by mesh and colour, state by a separate mark and text | **Done** | The Godot state shapes as a badge, and the state's name in the caption, the inspector and the list. A session that has ended is also drawn dashed. |
| 6 | M | MCP servers carry their tools | **Done** | One node for a server, one port for each tool (eight drawn; the rest are listed in the inspector). An open call's line ends at its port, which fills. |
| 7 | M | Resources grouped and capped | **Done** | Files by folder, URLs by host, context alone. Eight to an agent; the rest fold into an exact "+N" stack. A folder with one file is named by the file. |
| 8 | M | Draw only on change | **Done** | No frame loop. Measured in Edge: 0 frames and 0 animation frames asked for in 3 s at rest. |
| 9 | M | Motion means a call | **Done** | No ambient motion at all. An ended call stays as a thin trace for 600 ms, which costs one more frame. A travelling pulse exists but is off unless the owner turns it on, and cannot be turned on when the system asks for reduced motion. |
| 10 | M | Cost is measured and has a budget | **Done in the page; the VS Code command is not done** | The page shows frames drawn, the last frame's milliseconds, nodes, open calls, captions and events. `check.js` fails over 8 ms a frame at 200 nodes, and `shoot.js` writes real numbers to `measured.json`. The "Wyarden: 3D monitor cost" output channel is wiring. |
| 11 | M | Captions never overlap | **Done** | Greedy, in the critique's priority order, four places tried for each caption. 0 overlapping pairs at about 40, 80 and 200 nodes. A caption left out shows when the shape is pointed at. |
| 12 | M | A click selects; VS Code shows and changes | **Done in the page; the extension side is not done** | The page has no form control and nothing editable; a click only selects. Posting the selection to an extension and revealing it in a tree view is wiring. |
| 13 | M | Picking finds what is under the pointer | **Done** | The node whose projected outline holds the pointer; ties go to the nearest centre, then the nearest in depth. |
| 14 | M | Live data never moves the camera | **Done** | Framing uses the floors' bounds, never a node's position. Nodes outside the view are counted on the page ("off screen"). |
| 15 | M | Updates are incremental, history is bounded | **Done** | About 0.003 ms an event here. Fifty calls remembered for each session; every other list has a cap. |
| 16 | N | Two looks over one layout | **Done, except the theme rule** | A look is palette, meshes and caption style, and switching it moves nothing. Choosing the look from VS Code's theme kind is wiring; here it is the button or `?look=`. |
| 17 | N | Separate the floors | **Done** | The **Separate floors** button; off again restores every position exactly. |
| 18 | N | Isolate one agent | **Done** | **Isolate** or Enter; Escape returns to the saved camera. |
| 19 | N | Clash arcs | **Done** | A dashed red arc with a "!" between two agents' copies of a file both **wrote** in the same workspace. At most 24 are drawn; the rest are counted. |
| 20 | N | A visible "left out" count | **Done** | On the page: sessions with no column and clashes not drawn. Each stack shows its own "+N". |
| 21 | N | Attention first in the native view | **Done in the list twin; the native view is not done** | The list puts agents that need the owner first, longest wait first, with clock times. |

The step's own list:

| # | Asked for | Status |
| --- | --- | --- |
| 1 | A live model fed by events; only nodes a live signal can supply | **Done.** Dropped: workspace, orchestrator, task, worktree, check, account, main, remote. |
| 2 | A seeded feed simulator with start, pause, speed, and presets for 1, 4 and 12 agents, quiet and busy; one `subscribe(onEvent)` | **Done.** |
| 3 | The must-have improvements | **Done**, with the difference under item 3 above. |
| 4 | Drawing only on change, a visible frame count, decorative motion off | **Done.** |
| 5 | Click selects; inspector with an "In VS Code" list of labels; keyboard; legend; list twin | **Done.** |
| 6 | The first-ranked concept, and the lattice as a second look, one file per look | **Done.** |
| 7 | No packages, build step or network; loopback preview; opens directly; 1280 x 720 and 800 x 600 | **Done.** |
| 8 | `node check.js` | **Done:** 82 checks. |
| 9 | This README, and a screenshot of each look | **Done.** |

## Replacing the simulator

The view takes events through one function. In `app.js`:

```js
const source = feed;                       // anything with subscribe(onEvent) can stand here
source.subscribe(event => { model.apply(event); view.dataChanged(); });
```

An event is one object of the vocabulary in [the live-signals document](../../docs/monitor-3d/02-live-signals.md), section 11. `model.js` throws on anything else.

## Measured

By `shoot.js` in headless Edge at 1280 x 720, on one machine, not in a VS Code webview. Read them as sizes, not as exact figures. The full output is in `measured.json`.

| | NEXUS | Glasshouse |
| --- | --- | --- |
| At rest for 3 s: frames drawn | 0 | 0 |
| At rest for 3 s: animation frames asked for | 0 | 0 |
| Twelve busy agents (about 13 events a second): frames a second | 7.2 | 7.0 |
| The same: median and worst frame | 1.3 ms, 3.1 ms | 1.7 ms, 5.5 ms |
| The same: script time a second | 14 ms | 18 ms |
| The same: overlapping caption pairs (190 nodes) | 0 | 0 |
| A real click selects, a real key press moves the selection | yes | yes |
| Form controls in the page | 0 | 0 |

The same run opened `index.html` straight from the folder with no error, and pressed all 15 buttons with no error.

The seven originals drew 11 to 50 frames a second while nothing changed.

## What is fictional

- **Everything the feed emits.** Sessions and their ids, turns, calls, files and folders, URLs (all on `example.com`, `example.org` or `example.net`), MCP servers and their tools, model names, durations, failure and permission rates.
- **Real, taken from the live-signals document:** the event names and fields, each agent's tool names, and what each agent cannot report. So the feed sends no failure event and no file read for Codex, no session end for Antigravity, and `by: "?"` while a Codex or Antigravity subagent runs.
- **My reading, not the document's:** a `resource.touch` of kind `mcp-resource` carries `server` and `scheme`, and it and a web search are drawn as the "context" kind of resource. Instruction files and memory have no live signal, so they are not drawn.
- **The "In VS Code" list.** It names what the wiring would do (open the file, show the diff, focus the session, show the call, open the MCP configuration). The entries are text.
- **The numbers under "Measured"** are from a headless browser on one machine.

## Not built, and why

- **A "stalled" state.** It is inferred from time passing, so it would need a redraw without an event. Step 5 should decide where that timer lives.
- **A shared column for resources.** See item 3.
- **More than two rows of columns.** A thirteenth live session is counted as left out until a session ends.
- At twelve agents the back row overlaps the front row in projection at the default camera. **Separate floors** and **Isolate** are the way to read it.
- A stack remembers 200 folded items; older ones are only counted.

## Files

| File | What |
| --- | --- |
| `layout.js` | floors, columns, slots: position from (column, floor, slot) |
| `model.js` | the live model: events in, nodes, links, stacks |
| `feed.js` | the seeded simulator and its `subscribe(onEvent)` |
| `engine.js` | projection, drawing on change, picking, captions; shared by the looks |
| `look-nexus.js`, `look-glasshouse.js` | one look each: palette, meshes, caption style |
| `nav.js` | keyboard moves, the list twin's rows, the inspector's facts and labels |
| `app.js`, `index.html`, `style.css` | the page |
| `serve.js`, `check.js`, `shoot.js`, `measured.json` | preview, checks, screenshots, measurements |

## Borrowed code

Both repositories are GPL v3. Parts of this folder started from the originals in the Entridir repository at commit `63197c31`, under `nexus-3d/ui-concepts/`, which stay untouched there:

- `engine.js`: the perspective projection, the arched edge and the pointer, wheel and pinch handling, from `nexus-lattice-29d4d1/scene.js`.
- `look-nexus.js`: the dark palette and the octahedron, cube and ring meshes, from the same file and `style.css`.
- `look-glasshouse.js`: the light palette and the stepped chips, from `nexus-worlds-29d4d1/modes-glass-synapse.js`.
- `serve.js`: from `nexus-lattice-29d4d1/serve.js`.
- `shoot.js`: from `docs/monitor-3d/probe/shoot.js` in this repository.

Each file names its source and what changed in a comment at the top. `THIRD_PARTY_NOTICES.md` at the root of the repository is outside this step's folders and was not changed.
