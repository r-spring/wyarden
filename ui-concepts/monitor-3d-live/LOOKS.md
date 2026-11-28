# How to write a look

**What a look is:** one file, `media/look-<id>.js`, that puts one object on `MonitorLooks`. It says how the scene and the page are drawn. It never says where a thing stands, it is never told a state or a time, and it adds no control.
**What you change:** your own `media/look-<id>.js`, and your picture `docs/looks/img/<id>.png`. Nothing else: the list, the switcher, the script tags and the tests already know your id.
**Done when:** `node --test ui-concepts/monitor-3d-live/test/looks.test.js` no longer counts your look as "to do" and fails nothing, and your picture is committed.

## The file

Replace the whole stub by this, and leave out `stub`. Keep the first and last lines as they are: the same file is loaded by the page and by the tests in Node.

```js
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.MonitorEngine;
  const S = E.shapes;

  const look = {
    id: 'circuit-city',                 // the file's id; the switcher shows the name in media/looks.js
    name: 'Circuit City',
    theme: 'dark',                      // 'dark' or 'light': the browser's own colour scheme (scroll bars)
    claims: {},                         // see "What a look claims"
    font: "Consolas, monospace",        // captions in the scene, the figures under it, the inspector's lists
    lineWidth: 1.2,                     // a shape's edges, 0.5 to 4
    glow: true,                         // a wide faint stroke under each edge, in the class's colour
    caption: text => text.toUpperCase(),// every caption and tile label passes through it: its case; return a text
    palette: { /* below */ },
    mesh(key) { /* below */ }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
```

The two built mock-up looks, `look-nexus-mockup.js` and `look-glasshouse-mockup.js`, are complete small examples. `test/fixtures/looks/look-every-knob.js` uses every knob below at once (it is a test's look, not a pretty one).

## The palette (all required unless marked)

| Key | What it does |
|---|---|
| `bg` | The scene's background, and the stage round it. |
| `panel` | The background of the bar, the list, the inspector, the legend and the boxes over the scene. |
| `line` | Borders and rules on the page; a backdrop item's colour when it names none. |
| `ink` | The strongest text; the outline of the selected shape. |
| `caption` | Ordinary text on the page; a caption in the scene. |
| `muted` | Quiet text; a caption's second line. |
| `accent` | A pressed button, the focus ring, the selected row. |
| `cls: { agent, subagent, tool, resource, mcp }` | A class's colour: its shapes, its floor, its calls. |
| `provider: { claude, codex, grok, antigravity }` (optional) | With it, an agent and its subagents take their provider's colour and the legend lists the four. Without it they take `cls.agent` and `cls.subagent`. |
| `floor: { agent, mcp, tool, resource }` (optional) | Another colour for a floor than its class's. |
| `state: { needs, failed, working, unclear, idle, done }` | The colour of each state's mark. A mark is all a state ever colours. |
| `clash` | The arc between two sessions that wrote one file. |
| `outline` (optional) | One colour for every shape's edges, apart from the fill. Skyline: dark ink round solid blocks. Absent: the edges have the class's colour. |
| `fill` | 0 to 1: how solid a shape is filled in its colour. 0.1 is a wireframe; 0.85 and more is a solid shape. |
| `solid` | 0 to 1: how much of what lies behind a shape is hidden, in the background's colour. |
| `floorFill`, `floorLine`, `post` | 0 to 1: a floor's tint, its outline, and the posts that join a column's floors. |
| `captionBack`, `captionHalo` | 0 to 1: a plate behind a caption; a thin outline of the background's colour round its letters. Use one of the two. |
| `ground` (optional) | The scene's background as one still gradient, round or straight, in place of the flat `bg`. See below. |
| `captionNode` (optional) | `true`: the first line of a caption is in its node's colour, where that can be read. See below. |

A colour is any CSS colour.

**A ground that is not flat (`ground`).** One gradient fills the scene where the flat `bg` did. Absent, the scene is drawn exactly as before.

```js
ground: { shape: 'round', at: [.5, .75], stops: [[0, '#0b2630'], [.45, '#06111c'], [.95, '#030910']] }
ground: { shape: 'straight', from: [.5, 0], to: [.5, 1], stops: [[0, '#f5f7f1'], [1, '#e5ede4']] }
```

- **`round`** is an ellipse round `at` that reaches the scene's farthest corner, as CSS's `radial-gradient(ellipse at 50% 75%, …)` does. `at` is the middle when absent.
- **`straight`** runs from `from` to `to`, as CSS's `linear-gradient(…)` does. Absent, they are the top and the bottom.
- **A position is a fraction of the scene:** `[0, 0]` is its top left corner, `[1, 1]` its bottom right one.
- **`stops`** are 2 to 6 of `[offset, colour]`, the offsets from 0 to 1 and never falling.
- **Its limits:** it is the one fill that begins a frame, so it costs nothing more and nothing is drawn at rest. It does not move. The stage round the scene and the panels keep `bg` and `panel`. What a shape hides (`solid`), a mark's disc and a caption's halo keep `bg` too, so choose stops near `bg`.
- **A ground that cannot be drawn** (a wrong shape, a colour the browser refuses) leaves the flat `bg`, and the test fails.

**A caption in its node's colour (`captionNode: true`).** The first line of a caption at rest takes its node's colour: its class's, or its provider's where the palette has `provider`.

- **What stays:** the selected and the pointed-at caption keep `ink`; a caption's second line keeps `muted`; the workspace names on the tiles keep `caption`. A state never colours a caption.
- **The floor is a contrast of 4.5 to 1** (WCAG's floor for small text) against `bg` and against every stop of `ground`. A node's colour under the floor is not used: that caption keeps `caption`.
- **Write `bg`, the ground's stops and the class and provider colours as `#rgb`, `#rrggbb` or `rgb(r, g, b)`.** The engine works the contrast out from the text; a colour written another way keeps `caption`, and the test asks for these forms.
- **The test fails** when a look asks for it and none of its colours reaches the floor: leave the key out then.

## The meshes

`mesh(key)` returns `{ vertices: [[x, y, z], ...], lines: [[i, j], ...] }` for each of eight keys: `agent`, `subagent`, `tool`, `mcp`, `resource.file`, `resource.url`, `resource.context`, `stack` (a pile of folded things). It is given the key and nothing else.

- **Build with `E.shapes`:** `box(w, h, d, y)`, `prism(sides, radius, h, y, turn)`, `pyramid(sides, radius, h, y, turn)`, `octahedron(radius, y)`, `icosahedron(radius, y)`, `dodecahedron(radius, y)`, `ring(radius, count, plane, y)` with plane `'xz'`, `'xy'` or `'zy'`, `path(vertices, closed)`, `polygon(vertices)`, `merge(...meshes)`.
- **A mesh stays in its own slot:** it stands on y = 0, is centred on x = 0 and z = 0, reaches at most 31 from the centre (a resource 17, because it grows with use), and is at most 80 tall.
- **Its icon shows all of it.** The legend and the inspector draw each mesh as a small icon. A mesh the usual view holds (up to about 45 tall) is drawn in it; a taller one is seen from farther back until it fits. So give a mesh the height its original has, up to 80.
- **A mesh is small:** at most 120 corners and 120 lines. The frame budget is measured with meshes of this size.
- **Filled as drawn (optional `faces`):** a mesh is filled by the hull of its outline. Give it `faces: [[i, j, k, ...], ...]` and those polygons are filled instead, so a flat mark may be a cross or a star. `faces: []` fills nothing (two heavy strokes). `S.polygon(corners)` makes a flat filled shape. A merge that holds any `faces` is filled by the faces alone.

## What else a look may carry (all optional)

| Knob | What it does |
|---|---|
| `captionSize` | The size of a caption in px, 10 (the default) to 20. Every line of a caption and the floors' titles grow with it. |
| `page: { ... }` | The page's lettering and panel style: the keys in the next table. A key that is not there is ignored. |
| `fromPage(read)` | Works out colours from the page. See below. |
| `samples: { name: { '--vscode-…': 'value' } }` | For a look with `fromPage`: sets of the editor's variables to be photographed under. |
| `backdrop(scene)` | A still backdrop behind the floors. See below. |

**`page` keys.** Each is a plain CSS value. Unset, the page is as NEXUS has it.

| Key | Sets | Key | Sets |
|---|---|---|---|
| `ui` | the page's font family | `headFont` | the panels' headings' font family |
| `titleFont` | the font family of "Monitor 3D" | `labelSpacing` | the small headings' letter spacing |
| `titleStyle` | `italic` or `normal` | `labelCase` | the small headings: `uppercase` or `none` |
| `titleWeight` | 100 to 900 | `radius` | corners of buttons and boxes (`999px` is a pill) |
| `titleSize` | 10px to 20px | `panelInk` | strong text on a panel |
| `titleSpacing` | its letter spacing | `panelText` | ordinary text on a panel |
| `titleCase` | `uppercase`, `none`, `lowercase` | `panelMuted` | quiet text on a panel |
| `titleColor` | its colour | `panelLine` | borders on a panel |
| `titleShadow` | a text shadow, for a glow | `panelAccent` | pressed and focused on a panel |
| `labelFont` | the small spaced headings' font family; absent, they have `headFont`'s | | |

- **Fonts are the system's.** Name a family list that ends in a generic one. No font file can load: the page's policy allows no network and no font source.
- **Two fonts in the panels.** `headFont` sets the headings ("List", "Inspector", "Legend", the selected node's name). `labelFont` sets the small spaced headings under them ("CLASSES", "STATES", "CALLS"), so a look may have serif headings over small monospace labels. `labelSpacing` and `labelCase` belong to the same small headings.
- **The panel colours are for a look whose panels and stage differ** (dark panels beside a light stage). Without them a panel uses `ink`, `caption`, `muted`, `line` and `accent`. With them, the legend's and the inspector's swatches stand on the stage's colour, so your class and state colours need only work on `bg`.

**The scene keeps its size.** Use the fonts your original used; the rule below is all a font has to keep.

- **At 1280 x 720 the scene has exactly the same size in every look.**
- **The top bar and the workspace chips keep their height at every size.** A title above about 20px runs into the line under it.
- **Below 1280 x 720 the status line may take more lines.** It is a sentence, and it is never cut: in a wide page font it wraps sooner (Cascadia Code: two lines at 800 x 600, where Segoe UI has one). The scene then gives exactly the height of those whole lines of text, and nothing else.
- **When the test fails on size, its message names the look and the row:** the top bar, the workspace chips or the status line.

**`fromPage(read)`.** Called each time the look is applied, and again when the editor's theme changes, also after the owner chose the look. `read(name, fallback)` gives a CSS variable of the page, or the fall-back when it is absent. Write into `this.palette` (and `this.page`, `this.theme`):

```js
fromPage(read) { this.palette.bg = read('--vscode-editor-background', '#1e1e1e'); }
```

- The palette in the file must be complete without it: those are the fixed fall-backs, used in the tests and wherever the editor's variables are absent.
- Read only variables the page does not set itself (`--vscode-…`).

**`backdrop(scene)`.** Returns a list of items in the scene's own coordinates (x to the right, y up, z away). It is asked once for a set of floors and kept; a frame only projects it. Each item is drawn as one path:

| Item | Draws |
|---|---|
| `{ lines: [[[x, y, z], [x, y, z], ...], ...], color, alpha, width, dash }` | polylines; a segment is a line of two points |
| `{ dots: [[x, y, z], ...], color, alpha, size }` | discs of `size` px (0.4 to 6) |
| `{ text: 'short', at: [x, y, z], color, alpha, size, align }` | one line in the look's font, 6 to 48 px |

- **`scene` holds only where the floors are:** `bounds: { min, max }`, the box round every floor; `floors: { agent, mcp, tool, resource }`, each floor's height; `columns: [{ dock, x, z, half, tiles: { floor: [4 corners] } }]`, one for each column shown (lift shafts stand there); `cell`, `pitch`, `rowPitch`.
- **Helpers:** `E.strokes.ring(center, radius, segments, tiltX, tiltZ)` gives one closed polyline; `E.strokes.grid(x0, z0, x1, z1, y, step)` gives a list of them; `E.seeded(seed)` gives a fixed sequence from 0 to 1, for stars.
- **Limits, for all items together:** 1,500 segments, 500 dots, 40 texts, 12 paths (items of lines or dots). What is over a limit is not drawn, and the test fails.
- **Still:** no clock, no `Math.random` (the test makes both throw), nothing that depends on a node or a state. Asked twice, it must give the same items.

## What a look claims

`claims` tells the test which of the monitor's two rules your look keeps. A faithful original may keep neither.

- `claims: { classes: true }`: five silhouettes and five colours, one for each class (agent, subagent, tool, MCP server, resource).
- `claims: { providers: true }`: one hue for each provider. Set it exactly when the palette has `provider`.

## The rules, for every look

- **A state is a mark beside the shape and a word in the caption, never a colour or a shape.** A look is never told a state: `mesh` gets a key, `backdrop` gets the floors, and the engine picks the colour from the class.
- **A look has no say in where anything stands.** No positions, no camera, no layout.
- **Nothing moves by itself.** No timer, no animation, no frame asked for. The test waits 3 seconds after your look is shown and requires 0 frames.
- **No control and no behaviour.** The switcher is the only control that knows about looks.
- **No package, no font file, no image, no network.**
- **Where an original colours things by state** (Skyline, Control Room), give those colours to the classes.

## Check it and photograph it

Run both from the repository's top folder. They need Edge or Chrome; the browser is headless with a temporary profile.

```
node --test ui-concepts/monitor-3d-live/test/looks.test.js
node ui-concepts/monitor-3d-live/tools/shoot-looks.js <id>
```

- **The test** checks every built look: it is complete; it keeps what it claims; nothing stands elsewhere than in NEXUS; its backdrop is still and inside the limits; its background is one fill and its ground can be drawn; a caption has its node's colour only where it reaches the floor; a real click on its button shows it with 0 frames at rest and no script error; its picture differs from every other look's; it keeps to the size rule; a frame at about 200 nodes is inside the budget. It leaves a picture of the page in `ui-concepts/monitor-3d-live/.scratch/looks/<id>.png`, which git ignores.
- **The whole suite** is `node --test "ui-concepts/monitor-3d-live/test/*.test.js"`.
- **The shoot tool** writes `docs/looks/img/<id>.png` for the ids you name and no other: the page at 1280 x 720 on one fixed invented scene with every class and state. With `samples` it also writes `docs/looks/img/<id>-<name>.png` for each. Commit those pictures with your look.
- **To see it yourself,** open the picture, or run the test and open the one in `.scratch/looks/`, or use the preview below.

## Preview

**What it is:** the live tab's own page (`media/page.html`, `page.js`, `style.css`, the engine and every look file, as the VSIX carries them) in your browser, on invented data. Every look is one click away in the switcher. Nothing is installed.

Run it from the repository's top folder:

```
node ui-concepts/monitor-3d-live/tools/preview.js [port]
```

- **It prints the address,** for example `http://127.0.0.1:51122/`. With no port it takes a free one. It listens on 127.0.0.1 only. Ctrl+C stops it.
- **The address carries the choices.** The page has no control for them.

| Choice | Does | Default |
|---|---|---|
| `?look=<id>` | Opens on that look. An id that is not in `media/looks.js` is ignored. A look you click is written back into the address, so a reload keeps it. | the colour scheme's: `nexus` dark, `glasshouse` light |
| `?seed=<integer>` | The simulator's seed. The same seed gives the same stream. | 7 |
| `?agents=1\|4\|12` | Sessions at once. | 4 |
| `?load=quiet\|busy` | How busy they are. | busy |
| `?warm=<seconds>` | How long the stream has run before the first picture, 0 to 600. | 90 |

Example: `http://127.0.0.1:51122/?look=glasshouse-mockup&agents=12`.

**What is invented:** everything shown. The stream is the older page's seeded simulator, `ui-concepts/monitor-3d/feed.js`: one session for each provider (Claude, Codex, Grok, Antigravity), and their subagents, tools, MCP servers, files, folders and addresses. Calls start and end; some wait for the owner, and some fail. The two editor windows are invented too: `demo-shop` holds the Claude and Grok sessions, `notes-app` the Codex and Antigravity ones. Their chips and "All open" work. The hub's status line is invented. A double-click that would open a file in the editor only writes a line in the browser's console.

**How it works:** `tools/preview.js` fills `media/page.html` as the extension host does: the host's own content security policy, a nonce and the media folder's address. Before the page's scripts it puts two more: the simulator, and `tools/preview/editor.js`, a stand-in for the editor. The stand-in gives the page `acquireVsCodeApi()` and answers it as the host and the hub do. Neither file is in `media/`, so the VSIX never carries them. `test/preview.test.js` checks all of this.
