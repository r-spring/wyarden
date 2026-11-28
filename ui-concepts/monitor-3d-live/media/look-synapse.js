/* Wyarden 3D monitor: the "Synapse" look. 04 Synapse as the original drew it: dark plum, pink ringed beads
 * and mint pointed diamonds, thin curved nerve strands, an italic serif title and pill-shaped buttons.
 *
 * Adapted from Entridir (the Entridir repository, GPL v3), commit 63197c31,
 * nexus-3d/ui-concepts/nexus-worlds-29d4d1/modes-glass-synapse.js (palette line 161, the bead line 136,
 * the nerve strand line 141, environment lines 198-227, shapes lines 228-237), world.js (line 16: which type
 * takes which of the two colours) and worlds.css (lines 1, 2 and 10: the page's lettering and panels).
 * Changed:
 * - Nothing moves. The strands no longer breathe: the original's wave is taken at time 0 and kept. The original
 *   also breathed active nodes (line 193) and its renderer pulsed a ring under them and ran dots along active
 *   calls; none of that is carried over.
 * - The strands cannot run to nodes (a backdrop is told only where the floors are): the trunk rises behind
 *   the floors to "one shared outcome", and a limb grows from the root to each column, up through its
 *   floors to the agent's, with three small dendrites at its tip; roots spread under the lowest floor.
 *   The original grew them to each provider's agent, task and worktree.
 * - The original coloured a blocked node and its strands in its alert colour. Here a state is only the
 *   mark beside the shape and the word in the caption; the classes keep the two colours.
 * - The original had no MCP server, URL, file or folded pile: an MCP server takes the original account's
 *   loop with a bead in it, a file and a URL the original worktree's mint diamond, a context the
 *   original's context bead, a pile three small beads.
 * - The title is 20 px, the most the bar holds (49 px in the original).
 * Kept since the contract's second round: the viewport's glow, lighter a little left of the middle
 * (palette.ground), and each node's label in its own colour (palette.captionNode).
 *
 * A look is palette, meshes and caption style. It has no say in where a node stands. See LOOKS.md.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.MonitorEngine;
  const S = E.shapes;
  const TAU = Math.PI * 2;

  // The original's palette (modes-glass-synapse.js line 161).
  const O = { bg: '#100817', panel: '#1c1026', text: '#eddbf4', muted: '#a087b3', primary: '#e59be3', secondary: '#8be0cf', alert: '#ff8b9d' };
  // The strands' colours (lines 201, 207, 222, 224-226).
  const TRUNK = '#a78cc8', PINK = '#d7a4eb', ROOT = '#97b6ca', RING = '#a88dcc', LOW = '#9f81b3', HIGH = '#d4a5e5';

  /** The original's bead (line 136): a pointed top, a shorter point below, eight corners round its waist; set down on y. */
  function bead(radius, elongation, y) {
    const base = (y || 0) + radius * .9 * elongation;
    const vertices = [[0, base + radius * 1.5 * elongation, 0], [0, base - radius * .9 * elongation, 0]], lines = [];
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * TAU;
      vertices.push([Math.cos(a) * radius, base + Math.sin(a * 2) * radius * .13, Math.sin(a) * radius]);
      lines.push([0, i + 2], [1, i + 2], [i + 2, 2 + (i + 1) % 8]);
    }
    return { vertices, lines };
  }
  /** The original's nerve (line 141): a Catmull-Rom strand through the knots, with its wave taken at time 0. One polyline. */
  function nerve(points, phase, steps) {
    const out = [], n = steps || 5;
    for (let segment = 0; segment < points.length - 1; segment++) {
      const a = points[Math.max(0, segment - 1)], b = points[segment], c = points[segment + 1], d = points[Math.min(points.length - 1, segment + 2)];
      for (let step = segment ? 1 : 0; step <= n; step++) {
        const t = step / n, t2 = t * t, t3 = t2 * t;
        const p = b.map((v, i) => .5 * ((2 * v) + (-a[i] + c[i]) * t + (2 * a[i] - 5 * v + 4 * c[i] - d[i]) * t2 + (-a[i] + 3 * v - 3 * c[i] + d[i]) * t3));
        const wave = Math.sin((segment + t) * 4 + phase) * 3;
        out.push([p[0] + wave * Math.cos(phase), p[1], p[2] + wave * Math.sin(phase)]);
      }
    }
    return out;
  }

  const look = {
    id: 'synapse',
    name: 'Synapse',
    theme: 'dark',
    // Two colours for five classes, as in the original: it claims neither rule.
    claims: {},
    // The original page and its scene's labels are Consolas (worlds.css line 2; engine.js), labels in capitals.
    font: "Consolas, 'Liberation Mono', monospace",
    lineWidth: 1,
    glow: true,
    caption: text => text.toUpperCase(),
    palette: {
      bg: O.bg, panel: O.panel,
      line: '#332039',                    // worlds.css line 10: the borders of the inspector and the transport
      ink: O.text, caption: O.text, muted: O.muted, accent: O.primary,
      // world.js line 16: agent, tool, account and workspace in the first colour (pink); subagent, task, worktree and
      // context in the second (mint). An MCP server takes the account's loop and its pink; a resource the mint.
      cls: { agent: O.primary, subagent: O.secondary, tool: O.primary, mcp: O.primary, resource: O.secondary },
      // The original had no floors: the monitor's four stay, quiet, in the trunk's violet.
      floor: { agent: TRUNK, mcp: TRUNK, tool: TRUNK, resource: TRUNK },
      // The marks. "Failed" and a clash take the original's alert; "needs you" the original NEXUS check amber
      // (engine.js line 4, #ffd48a); "done" the trunk's violet, quieter than idle's muted.
      state: { needs: '#ffd48a', failed: O.alert, working: O.text, unclear: O.muted, idle: O.muted, done: TRUNK },
      clash: O.alert,
      // worlds.css line 10, .synapse .viewport: radial-gradient(ellipse at 45% 50%, #2f103b, #100817 75%).
      ground: { shape: 'round', at: [.45, .5], stops: [[0, '#2f103b'], [.75, O.bg]] },
      // The original's engine.js line 75: a node's label is in the node's own colour (the selected one in the text colour).
      captionNode: true,
      // Wireframe beads with a soft glow; the original's labels stood on a shadow of the ground: a halo.
      fill: .08, solid: .85, floorFill: 0, floorLine: .22, post: .16, captionBack: 0, captionHalo: .8
    },
    // worlds.css: the page is Consolas (line 2, body), the title italic Georgia in #f1c9ee (line 10, 49px), the
    // buttons and the list rows pills (line 10: radius 20px and 30px), the panels plum (line 10, #180d20).
    page: {
      ui: "Consolas, 'Liberation Mono', monospace",
      titleFont: "Georgia, 'Times New Roman', serif", titleStyle: 'italic', titleWeight: '400', titleSize: '20px',
      titleSpacing: '0px', titleCase: 'none', titleColor: '#f1c9ee',
      // The inspector's heading: .synapse .node-title, italic 26px Georgia (a heading here takes the family, not the
      // slant). The small labels: .panel-label, the page's --mono.
      headFont: "Georgia, 'Times New Roman', serif", labelFont: "Consolas, 'Liberation Mono', monospace",
      labelSpacing: '1px', labelCase: 'uppercase', radius: '14px'
    },
    /**
     * The nervous system, standing still: a root ring and roots under the lowest floor; a trunk rising behind the
     * floors to "one shared outcome"; from the root, one limb to each column, up through its floors to the agent's
     * floor (to the MCP floor for the boundary dock), with a faint twin and three dendrites at its tip.
     */
    backdrop(scene) {
      const { min, max } = scene.bounds, f = scene.floors;
      const low = Math.min(f.resource, f.tool, f.mcp, f.agent), high = Math.max(f.resource, f.tool, f.mcp, f.agent);
      const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2, hub = [cx, low - 50, cz];
      // The trunk, through the original's knots (line 200), scaled to the floors and set behind them.
      const back = max[2] + 70, span = (high + 110) - (low - 70);
      const knots = [[0, -48, 0], [-13, 24, 9], [10, 93, -9], [-7, 164, 3], [12, 232, -2], [4, 287, -3], [35, 351, 16]]
        .map(([x, y, z]) => [cx + x * 2, low - 70 + (y + 48) / 399 * span, back + z * 2]);
      const trunk = [hub].concat(knots.slice(1));
      const limbs = { pink: [], mint: [], pinkTwin: [], mintTwin: [], pinkTip: [], mintTip: [] };
      let i = 0;
      for (const col of scene.columns) {
        const top = col.dock ? f.mcp : f.agent, steps = [low, f.tool, f.mcp, f.agent].filter(y => y <= top);
        const phase = (i * 1.37) % TAU, side = i % 2 ? 'mint' : 'pink';
        const knotsUp = [hub, [(hub[0] + col.x) / 2, low - 34, (hub[2] + col.z) / 2]].concat(steps.map((y, k) => [col.x + (k % 2 ? 9 : -9), y, col.z]));
        limbs[side].push(nerve(knotsUp, phase, 5));
        limbs[side + 'Twin'].push(nerve(knotsUp, phase + 2, 4));
        const tip = [col.x, top, col.z];
        for (let d = 0; d < 3; d++) {
          const a = phase + .35 * (d - 1), reach = 34 + d * 13;
          limbs[side + 'Tip'].push(nerve([tip, [tip[0] + Math.cos(a) * reach * .5, top + 22, tip[2] + Math.sin(a) * reach * .5], [tip[0] + Math.cos(a) * reach, top + 14 + d * 18, tip[2] + Math.sin(a) * reach]], a, 4));
        }
        i++;
      }
      // Roots under the lowest floor, out and back to the core (line 221).
      const roots = { mint: [], blue: [] }, rx = (max[0] - min[0]) / 2 + 40, rz = (max[2] - min[2]) / 2 + 60;
      for (let r = 0; r < 8; r++) {
        const a = r / 8 * TAU + .2, end = [cx + Math.cos(a) * rx, low - 40 + (r % 3) * 7, cz + Math.sin(a) * rz];
        roots[r % 2 ? 'blue' : 'mint'].push(nerve([end, [cx + Math.cos(a) * rx * .53, low - 60 + (r % 3) * 7, cz + Math.sin(a) * rz * .53], hub], r * .9, 5));
      }
      return [
        { lines: [E.strokes.ring([cx, low - 53, cz], 70, 40)], color: RING, alpha: .16, width: .8 },
        { lines: roots.mint, color: O.secondary, alpha: .15, width: .7 },
        { lines: roots.blue, color: ROOT, alpha: .15, width: .7 },
        { lines: [nerve(trunk, 0, 6)], color: TRUNK, alpha: .43, width: 1.3 },
        { lines: [nerve(trunk, 1.5, 6), nerve(trunk, 3, 6)], color: TRUNK, alpha: .19, width: .8 },
        { lines: limbs.pink, color: PINK, alpha: .45, width: 1.15 },
        { lines: limbs.mint, color: O.secondary, alpha: .45, width: 1.15 },
        { lines: limbs.pinkTwin.concat(limbs.pinkTip), color: PINK, alpha: .2, width: .7 },
        { lines: limbs.mintTwin.concat(limbs.mintTip), color: O.secondary, alpha: .2, width: .7 },
        { text: 'CONTEXT FEEDS THE ROOTS', at: [cx, low - 95, min[2] - 40], color: LOW, alpha: .63, size: 8, align: 'center' },
        { text: 'ONE SHARED OUTCOME', at: [knots[6][0], knots[6][1] + 30, knots[6][2]], color: HIGH, alpha: .62, size: 9, align: 'center' }
      ];
    },
    /** The original's shapes (lines 231-237), set down on the floor: a ringed bead, a small bead, a root, a loop, a diamond. */
    mesh(key) {
      switch (key) {
        case 'agent': return S.merge(bead(18, .85), S.ring(24, 16, 'xz', 18 * .9 * .85));
        case 'subagent': return bead(10, 1.25);
        // The root-shaped glyph (line 235): a stem and three roots. Strokes only: its hull would be a blob.
        case 'tool': return { vertices: [[0, 28, 0], [0, 10, 0], [-11, 2, 8], [10, 1, 6], [0, 0, -11]], lines: [[0, 1], [1, 2], [1, 3], [1, 4]], faces: [] };
        case 'mcp': return S.merge(S.ring(13, 12, 'xy', 13), bead(6, .8, 13 - 6 * .9 * .8));
        case 'resource.file':
        case 'resource.url': return { vertices: [[0, 0, 0], [-11, 23, -5], [0, 46, 0], [11, 23, 5], [0, 23, -10], [0, 23, 10]], lines: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [4, 2], [0, 5], [5, 2], [1, 3]] };
        case 'resource.context': return bead(12, .85);
        case 'stack': return S.merge(bead(7, .7), bead(7, .7, 12), bead(7, .7, 24));
      }
      throw new Error('Synapse look: no mesh for "' + key + '"');
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
