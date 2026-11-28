/* Wyarden 3D monitor: the "Signal House" look. A paper stage beside dark slate panels whose text is paper-coloured;
 * slate ink with vermilion, sage green and blue; serif headings with an italic flourish; small spaced capitals in a
 * monospace for labels; flat cards with a coloured edge on a dotted planning canvas.
 *
 * Adapted from Entridir (the Entridir repository, GPL v3), commit 63197c31,
 * nexus-3d/ui-concepts/signal-house-29d4d1/style.css: line 2 (:root, every colour and the three font stacks);
 * line 3 (.sidebar #e5ece7 on --nav; .brand-symbol, its box #70837e and its vermilion cross and bar;
 * .workspace-label #8ea49c; .nav button.active #fff and its number #fa9b79; .sidebar-foot rule #405258;
 * .eyebrow 10px mono, 1.7px spacing, capitals; .page-heading h1 em, the vermilion italic serif word; .button.primary,
 * vermilion; .attention-card, a white card with a 3px coloured left edge; .plan-canvas, the dotted ground
 * #b7c4b5 every 15px; .error-text #a53d29) and index.html.
 * Changed:
 * - The page is flat, so it has no 3D shapes. The shapes here are this look's own, drawn as the page draws its
 *   cards: flat, filled, with a coloured edge and no glow. An agent is a signal mast (the brand's mark stood up), a
 *   subagent a card on edge, a tool a flat card with its left edge raised, an MCP server a house, a file a sheet
 *   with a turned corner, an address two rings, a context a flat diamond, a folded pile three cards.
 * - The classes take the page's colours: agent vermilion (its main button), subagent slate (its ink and dark
 *   button), tool sage (what is ready), MCP server blue, resource the page's muted grey-green. Five colours and
 *   five silhouettes, so it claims the classes rule.
 * - The page shows a tint for each provider (.provider-mark: #a65136, #31634c, #3a5490, #81598d). They are not
 *   used: three of them are the hues of a class here (vermilion, sage, blue), and colour would then say neither
 *   class nor provider. It does not claim the providers rule.
 * - The marks: "needs you" in vermilion, "failed" and a clash in the page's error red, "working" in blue (its
 *   focus ring), "done" in sage, "unclear" and "idle" in muted. A mark is all a state colours.
 * - The heading's one vermilion italic word cannot be drawn: the bar's title takes one style. "Monitor 3D" is set
 *   whole in the flourish's manner, Georgia italic in vermilion, on the slate bar. The scene's own text can only be
 *   in the look's font, so the backdrop's name is in the monospaced capitals of the page's labels.
 * - The bar, the list, the inspector and the boxes over the scene are slate with paper-coloured text, as the
 *   page's side panel; the stage is paper. The page's 52 px heading is 20 px, the most the bar holds.
 *
 * Its relatives: `paper` and `paper-dark` have one ink, no accent and no dark panels; this has colour and both.
 *
 * A look is palette, meshes and caption style. It has no say in where a node stands. See LOOKS.md.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.MonitorEngine;
  const S = E.shapes;

  // style.css line 2, :root.
  const C = { paper: '#f4f1e9', white: '#fffdf8', ink: '#192b32', muted: '#65726f', line: '#d8d9ce', orange: '#e55c36',
    green: '#396e56', blue: '#3756a0', soft: '#eae9df' };
  // style.css line 3: on the slate side panel, and the page's other named colours.
  const ON_SLATE = { strong: '#ffffff', text: '#e5ece7', quiet: '#8ea49c', rule: '#405258', orange: '#fa9b79', box: '#70837e' };
  const ERROR = '#a53d29', DOTS = '#b7c4b5';
  const SERIF = "Georgia, 'Times New Roman', serif";
  const SANS = "'Inter', 'Segoe UI', Arial, sans-serif";
  const MONO = "'SFMono-Regular', Consolas, 'Liberation Mono', monospace";

  /** A house: walls and a gabled roof along z, with a short mast on the ridge. */
  function house() {
    const b = S.box(24, 12, 20);
    const vertices = b.vertices.concat([[0, 21, -10], [0, 21, 10], [0, 21, 0], [0, 31, 0]]);
    const lines = b.lines.concat([[3, 8], [2, 8], [7, 9], [6, 9], [8, 9], [10, 11]]);
    return { vertices, lines };
  }

  const look = {
    id: 'signal-house',
    name: 'Signal House',
    theme: 'light',
    claims: { classes: true },
    font: MONO,                         // .eyebrow, .label, .badge: the page's labels are monospaced
    lineWidth: 1.1,
    glow: false,
    caption: text => text.toUpperCase(),// .eyebrow: small spaced capitals
    palette: {
      bg: C.paper, panel: C.ink, line: C.line, ink: C.ink, caption: C.ink, muted: C.muted, accent: C.orange,
      cls: { agent: C.orange, subagent: C.ink, tool: C.green, mcp: C.blue, resource: C.muted },
      state: { needs: C.orange, failed: ERROR, working: C.blue, unclear: C.muted, idle: C.muted, done: C.green },
      clash: ERROR,
      // Flat cards: filled in the class's colour over the white of the page's cards, edges in the same colour.
      fill: .42, solid: .96, floorFill: .03, floorLine: .45, post: .22, captionBack: 0, captionHalo: .9
    },
    page: {
      ui: SANS,
      titleFont: SERIF, titleStyle: 'italic', titleWeight: '400', titleSize: '20px', titleSpacing: '-0.5px',
      titleCase: 'none', titleColor: C.orange,
      headFont: MONO, labelSpacing: '1.7px', labelCase: 'uppercase', radius: '3px',
      panelInk: ON_SLATE.strong, panelText: ON_SLATE.text, panelMuted: ON_SLATE.quiet, panelLine: ON_SLATE.rule,
      panelAccent: ON_SLATE.orange
    },
    /**
     * The planning canvas: a dotted ground under the building (.plan-canvas, dots #b7c4b5), with the stats strip's
     * two hairline rules (.stats, --line) across its front and back, and the brand's mark and name at the back left.
     */
    backdrop(scene) {
      const { min, max } = scene.bounds, m = 60;
      const x0 = min[0] - m, x1 = max[0] + m, z0 = min[2] - m, z1 = max[2] + m;
      const low = Math.min(...['agent', 'mcp', 'tool', 'resource'].map(f => scene.floors[f])) - 6;
      const top = Math.max(...['agent', 'mcp', 'tool', 'resource'].map(f => scene.floors[f]));
      // A fixed number of dots whatever the building's size: 26 by 16, so never over the limit.
      const dots = [], NX = 26, NZ = 16;
      for (let i = 0; i <= NX; i++) for (let j = 0; j <= NZ; j++) dots.push([x0 + (x1 - x0) * i / NX, low, z0 + (z1 - z0) * j / NZ]);
      // The brand's mark (.brand-symbol), stood up at the back left: a box, a narrow vermilion cross and a bar.
      // Its proportions are the original's (35 by 43 px; the cross 24 high, 9 up, leaning 20 degrees; the bar 25 wide).
      const k = 1.2, bx = x0, by = top + 95, bz = z1, w = 35 * k, h = 43 * k;
      const frame = [[bx, by, bz], [bx + w, by, bz], [bx + w, by + h, bz], [bx, by + h, bz], [bx, by, bz]];
      const cx = bx + w / 2, half = 12 * k, cy = by + 9 * k + half, lean = Math.tan(20 * Math.PI / 180) * half;
      const cross = [[[cx - lean, cy - half, bz], [cx + lean, cy + half, bz]], [[cx + lean, cy - half, bz], [cx - lean, cy + half, bz]],
        [[cx - 12.5 * k, cy + 3 * k, bz], [cx + 12.5 * k, cy + 3 * k, bz]]];
      return [
        { dots, color: DOTS, alpha: 1, size: 1.4 },
        { lines: [[[x0, low, z0], [x1, low, z0]], [[x0, low, z1], [x1, low, z1]]], color: C.line, alpha: 1, width: 1 },
        { lines: [frame], color: ON_SLATE.box, alpha: 1, width: 1 },
        { lines: cross, color: C.orange, alpha: 1, width: 1.2 },
        { text: 'SIGNAL HOUSE', at: [bx + w + 14, by + h - 22, bz], color: C.ink, alpha: 1, size: 20, align: 'left' },
        { text: 'YOUR WORK, IN VIEW', at: [bx + w + 14, by + 6, bz], color: C.muted, alpha: 1, size: 10, align: 'left' }
      ];
    },
    mesh(key) {
      switch (key) {
        // A signal mast: the brand's narrow cross stood up as a tapering square frame, with a bar half way.
        case 'agent': return S.merge(S.pyramid(4, 15, 50, 0, Math.PI / 4), S.ring(8, 4, 'xz', 23), S.box(4, 4, 4, 50));
        // A card on edge.
        case 'subagent': return S.box(20, 24, 3);
        // A flat card with its left edge raised: .attention-card's coloured border.
        case 'tool': return S.merge(S.box(26, 3, 20), shiftX(S.box(3, 7, 20), -11.5));
        // A house.
        case 'mcp': return house();
        // A sheet with a turned corner.
        case 'resource.file': return S.merge(S.box(20, 2, 26), S.path([[4, 2, -13], [10, 2, -7]]));
        // An address: two rings, one inside the other.
        case 'resource.url': return S.merge(S.ring(12, 16, 'xz', 1), S.ring(6, 12, 'xz', 1), S.box(2, 2, 2));
        // A flat diamond.
        case 'resource.context': return S.prism(4, 13, 3);
        // A pile of three cards, each a little off the one below.
        case 'stack': return S.merge(shiftX(S.box(24, 2, 18), -3), S.box(24, 2, 18, 5), shiftX(S.box(24, 2, 18, 10), 3));
      }
      throw new Error('Signal House look: no mesh for "' + key + '"');
    }
  };

  /** The same mesh moved along x. */
  function shiftX(mesh, dx) { return { vertices: mesh.vertices.map(([x, y, z]) => [x + dx, y, z]), lines: mesh.lines }; }

  if (typeof module !== 'undefined' && module.exports) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
