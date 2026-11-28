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

A colour is any CSS colour.

## The meshes

`mesh(key)` returns `{ vertices: [[x, y, z], ...], lines: [[i, j], ...] }` for each of eight keys: `agent`, `subagent`, `tool`, `mcp`, `resource.file`, `resource.url`, `resource.context`, `stack` (a pile of folded things). It is given the key and nothing else.

- **Build with `E.shapes`:** `box(w, h, d, y)`, `prism(sides, radius, h, y, turn)`, `pyramid(sides, radius, h, y, turn)`, `octahedron(radius, y)`, `icosahedron(radius, y)`, `dodecahedron(radius, y)`, `ring(radius, count, plane, y)` with plane `'xz'`, `'xy'` or `'zy'`, `path(vertices, closed)`, `polygon(vertices)`, `merge(...meshes)`.
- **A mesh stays in its own slot:** it stands on y = 0, is centred on x = 0 and z = 0, reaches at most 31 from the centre (a resource 17, because it grows with use), and is at most 80 tall.
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

- **Fonts are the system's.** Name a family list that ends in a generic one. No font file can load: the page's policy allows no network and no font source.
- **The panel colours are for a look whose panels and stage differ** (dark panels beside a light stage). Without them a panel uses `ink`, `caption`, `muted`, `line` and `accent`. With them, the legend's and the inspector's swatches stand on the stage's colour, so your class and state colours need only work on `bg`.
- **The bar keeps its height,** so the scene has the same size in every look. A title above about 20px runs into the line under it.

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

- **The test** checks every built look: it is complete; it keeps what it claims; nothing stands elsewhere than in NEXUS; its backdrop is still and inside the limits; a real click on its button shows it with 0 frames at rest and no script error; its picture differs from every other look's; the scene keeps its size; a frame at about 200 nodes is inside the budget. It leaves a picture of the page in `ui-concepts/monitor-3d-live/.scratch/looks/<id>.png`, which git ignores.
- **The whole suite** is `node --test "ui-concepts/monitor-3d-live/test/*.test.js"`.
- **The shoot tool** writes `docs/looks/img/<id>.png` for the ids you name and no other: the page at 1280 x 720 on one fixed invented scene with every class and state. With `samples` it also writes `docs/looks/img/<id>-<name>.png` for each. Commit those pictures with your look.
- **To see it yourself,** open the picture, or run the test and open the one in `.scratch/looks/`.
