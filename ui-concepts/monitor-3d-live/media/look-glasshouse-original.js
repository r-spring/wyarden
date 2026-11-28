/* Wyarden 3D monitor: the "Glasshouse original" look. 03 Glasshouse as the original drew it: pale daylight,
 * stacked glass floors with lift shafts, flat stepped chips in two colours only, a serif title.
 *
 * Adapted from Entridir (the Entridir repository, GPL v3), commit 63197c31,
 * nexus-3d/ui-concepts/nexus-worlds-29d4d1/modes-glass-synapse.js (palette line 64, floors lines 43-50,
 * environment lines 83-106, shapes lines 107-119), world.js (line 16: which type takes which of the two
 * colours) and worlds.css (lines 1 and 8: the page's lettering and panels).
 * Changed:
 * - The floors are the monitor's four (agents, MCP servers, tools, resources), not the original's six; each
 *   takes the colour of the original floor it stands for, and the lowest is the original's salmon.
 * - Nothing moves. The lift cars no longer circle: each stands still at its own height. The original also lifted
 *   an active agent (line 78) and its renderer turned the workspace, pulsed a ring under active nodes and ran
 *   dots along active calls; none of that is carried over.
 * - The original coloured a blocked node in its alert colour and a waiting one in its second colour. Here a
 *   state is only the mark beside the shape and the word in the caption; the classes keep the two colours.
 * - The original had no MCP server, URL or folded pile: an MCP server takes the original's integration slab
 *   (main / remote), a URL a smaller one, a file and a context the original's context chip, a pile the
 *   original's worktree plates.
 * - The title is 20 px, the most the bar holds (46 px in the original).
 * - The original lettered each node in its own colour. Here every caption keeps the page's dark teal: on this pale
 *   ground the original's two colours have a contrast of 4.1 and 2.2 to 1, under the 4.5 a caption must have
 *   (LOOKS.md), so palette.captionNode would change nothing and is left out.
 *
 * Kept apart from its two relatives (`glasshouse`, `glasshouse-mockup`): two colours only, the original's flat
 * chips (an agent is a three-step chip, not a solid or a tower with a mast), lift shafts, the salmon floor,
 * monospaced captions and a serif title.
 *
 * A look is palette, meshes and caption style. It has no say in where a node stands. See LOOKS.md.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.MonitorEngine;
  const S = E.shapes;

  // The original's palette (modes-glass-synapse.js line 64).
  const O = { bg: '#f1f4ee', panel: '#e7ede6', text: '#214c52', muted: '#6d8987', primary: '#287c83', secondary: '#83a99a', alert: '#cb735c' };
  // The original's floors (lines 44-49), bottom up, as the monitor's four: integration under the resources (salmon),
  // evidence + tools under the tools, coordination under the MCP servers, reasoning under the agents.
  const FLOOR = { resource: '#c56e53', tool: '#558e86', mcp: '#567e89', agent: '#287984' };
  const SHAFT = '#83a49f', CAR = '#4c9b91', PLUMB = '#87a5a2', SIGN = '#507b7c';      // lines 97-105

  const look = {
    id: 'glasshouse-original',
    name: 'Glasshouse original',
    theme: 'light',
    // Two colours for five classes, as in the original, and a tool and a task share one box: it claims neither rule.
    claims: {},
    // The original scene's labels (engine.js: Consolas, monospace), in capitals as its labels were.
    font: "Consolas, 'Liberation Mono', monospace",
    lineWidth: 1,
    glow: false,
    caption: text => text.toUpperCase(),
    palette: {
      bg: O.bg, panel: O.panel,
      line: '#c7d9ce',                    // worlds.css line 8: the borders of the glass page's buttons
      ink: O.text, caption: O.text, muted: O.muted, accent: O.primary,
      // world.js line 16: agent, tool, workspace and remote in the first colour; subagent, task, context and main in
      // the second. An MCP server is an integration and takes the first; a resource is context and takes the second.
      cls: { agent: O.primary, subagent: O.secondary, tool: O.primary, mcp: O.primary, resource: O.secondary },
      floor: FLOOR,
      // The marks. "Failed" and a clash take the original's alert; "needs you" an amber that the original did not
      // have (it had one alert colour, and the two marks must be told apart by more than shape on a pale floor).
      state: { needs: '#b87700', failed: O.alert, working: O.text, unclear: O.muted, idle: O.muted, done: O.secondary },
      clash: O.alert,
      // worlds.css line 8, .glass .viewport: linear-gradient(#f5f7f1, #e5ede4): daylight from above.
      ground: { shape: 'straight', from: [.5, 0], to: [.5, 1], stops: [[0, '#f5f7f1'], [1, '#e5ede4']] },
      // Flat chips over clear glass. The original's labels stood on a soft shadow of the background: a halo.
      fill: .24, solid: .9, floorFill: .035, floorLine: .42, post: .3, captionBack: 0, captionHalo: .9
    },
    // worlds.css: the page is Segoe UI (line 1, --sans; line 8, .glass), the title Georgia (line 8, 46px, #214c52),
    // the small headings Consolas 8px with .8px spacing (line 8, .glass .panel-label), corners of 3px (line 2).
    page: {
      ui: "'Segoe UI', Arial, sans-serif",
      titleFont: "Georgia, 'Times New Roman', serif", titleStyle: 'normal', titleWeight: '400', titleSize: '20px',
      titleSpacing: '0px', titleCase: 'none', titleColor: O.text,
      headFont: "Consolas, 'Liberation Mono', monospace", labelSpacing: '.8px', labelCase: 'uppercase', radius: '3px'
    },
    /**
     * The section: one glass slab under each floor, wider than the columns, with its fine grid, a fainter slab just
     * below it and a measuring tab at its back left corner; four lift shafts with their cars standing still; a plumb
     * line at the facade with a tick at each floor, and the building's name above it (lines 84-105).
     */
    backdrop(scene) {
      const { min, max } = scene.bounds, m = 70;
      const x0 = min[0] - m, x1 = max[0] + m, z0 = min[2] - m, z1 = max[2] + m;
      const ys = ['resource', 'tool', 'mcp', 'agent'].map(f => scene.floors[f]);
      const low = Math.min(...ys), high = Math.max(...ys);
      const rect = y => [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [x0, y, z0]];
      const items = [];
      for (const floor of ['resource', 'tool', 'mcp', 'agent']) {
        const y = scene.floors[floor];
        items.push({ lines: [rect(y), [[x0 - 20, y, z0], [x0 - 10, y, z0]], [[x0 - 15, y - 5, z0], [x0 - 15, y + 5, z0]]], color: FLOOR[floor], alpha: .42, width: 1.1 });
      }
      items.push({ lines: ys.map(y => rect(y - 3)), color: SHAFT, alpha: .14, width: .6 });
      const grid = [];
      for (const y of ys) {
        for (let x = x0 + 65; x < x1 - 20; x += 90) grid.push([[x, y, z0], [x, y, z1]]);
        for (let z = z0 + 55; z < z1 - 20; z += 90) grid.push([[x0, y, z], [x1, y, z]]);
      }
      items.push({ lines: grid, color: FLOOR.tool, alpha: .1, width: .6 });
      // Four lift shafts, inset from the slab's corners as in the original (290 of 335, 190 of 235).
      const shafts = [[x0 + 45, z0 + 45], [x1 - 45, z0 + 45], [x0 + 45, z1 - 45], [x1 - 45, z1 - 45]];
      items.push({ lines: shafts.map(([x, z]) => [[x, low - 3, z], [x, high + 14, z]]), color: SHAFT, alpha: .22, width: .7 });
      items.push({ lines: shafts.map(([x, z]) => [[x + 5, low - 3, z + 5], [x + 5, high + 14, z + 5]]), color: SHAFT, alpha: .1, width: .6 });
      // Each car parked at its own height, between two floors: still, and never on a floor where a node stands.
      const cars = shafts.map(([x, z], i) => {
        const y = low + (high - low) * [.18, .52, .68, .36][i];
        return [[x - 8, y, z - 8], [x + 8, y, z - 8], [x + 8, y, z + 8], [x - 8, y, z + 8], [x - 8, y, z - 8]];
      });
      items.push({ lines: cars, color: CAR, alpha: .52, width: 1 });
      const px = x1 + 30, pz = (z0 + z1) / 2;
      items.push({ lines: [[[px, low, pz], [px, high, pz]]], color: PLUMB, alpha: .24, width: .8 });
      items.push({ lines: ys.map(y => [[px - 8, y, pz], [px + 8, y, pz]]), color: SIGN, alpha: .6, width: 1 });
      // The building's name, above the back left of the roof slab (the original set it over the facade, which the
      // monitor's wider building pushes out of the picture).
      items.push({ text: 'THE GLASSHOUSE', at: [x0 - 10, high + 30, z1], color: SIGN, alpha: .7, size: 11, align: 'right' });
      return items;
    },
    /** The original's chips (lines 112-118), set down on the floor: a three-step chip, a two-step chip, a flat box, a slab with a ring, plates. */
    mesh(key) {
      switch (key) {
        case 'agent': return S.merge(S.box(36, 6, 28), S.box(28, 3, 20, 9.5), S.box(16, 2, 12, 16));
        case 'subagent': return S.merge(S.box(22, 3, 18), S.box(13, 2, 10, 5.5));
        case 'tool': return S.box(26, 4, 20);
        case 'mcp': return S.merge(S.box(46, 4, 35), S.ring(14, 12, 'xz', 8));
        case 'resource.file': return S.merge(S.box(24, 2, 30), S.box(18, 1, 23, 3.5));
        case 'resource.url': return S.merge(S.box(30, 3, 24), S.ring(9, 12, 'xz', 6));
        case 'resource.context': return S.merge(S.box(24, 2, 30), S.box(18, 1, 23, 3.5));
        case 'stack': return S.merge(S.box(29, 1.5, 22), S.box(29, 1.5, 22, 5), S.box(29, 1.5, 22, 10));
      }
      throw new Error('Glasshouse original look: no mesh for "' + key + '"');
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
