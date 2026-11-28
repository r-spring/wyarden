/* Wyarden 3D monitor: the "Circuit City" look. Navy blueprint, cyan wireframe towers, amber blocks.
 *
 * Adapted from Entridir (the Entridir repository, GPL v3), commit 63197c31,
 * nexus-3d/ui-concepts/nexus-worlds-29d4d1/modes-city-orbit.js (worlds.city: palette, environment, shape)
 * and worlds.css (:root and the .city rules); picture docs/monitor-3d/img/before/city.png.
 * Kept: the palette's hex values; the tower with a line at every floor and a mast; the plain block; the
 * braced panel; the cube with a skirt; the blueprint street grid with a line every fourth street brighter,
 * the twin ring road and the district outlines with their labels, and the low skyline at the back, in the
 * source's own colours; its strengths too, except the minor streets (.16, not .11), the skyline (.2, not
 * .11 to .16) and the lines' width (.6 to .8, not .55 to .7), stronger to show at this scale; Consolas captions in capitals; a light, wide-spaced capital title.
 * Changed: the five classes take the nearest type's shape (agent a tall tower, subagent a short one, tool a
 * block, MCP server the braced "upstream" panel, resource the small blocks of tasks and accounts), scaled to
 * a slot; colours are the picture's (cyan for agents and resources, amber for the rest) and never a state's;
 * the districts are the columns, numbered, not providers; the grid lies under the floors, not round a
 * downtown. Left out: the road traffic and every other thing that moves, the skybridges (they would cross
 * the floors), the downtown rings, and the viewport's scan lines. Kept since the contract's second round: the
 * viewport's radial glow (palette.ground), each node's label in its own colour (palette.captionNode), and the
 * panels' small labels in the page's Consolas under Segoe UI headings (page.labelFont).
 *
 * A look is palette, meshes, lettering and a still backdrop. It has no say in where a node stands.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.MonitorEngine;
  const S = E.shapes;

  // The source's palette (modes-city-orbit.js, worlds.city.palette), as it gives it.
  const C = { bg: '#050913', panel: '#081725', text: '#d6f5fa', muted: '#7d9cab', primary: '#58e6ff', secondary: '#fead55', alert: '#ff5478' };
  // worlds.css: --line is the primary at 19% over the panel; here worked out as a flat colour.
  const LINE = '#173e4f';

  /** The source's tower(): a box standing on y = 0, a ring of lines at every floor, a mast on top. */
  function tower(w, h, d, step, mast) {
    const parts = [S.box(w, h, d)], x = w / 2, z = d / 2;
    for (let y = step; y < h - 1; y += step) parts.push(S.path([[-x, y, -z], [x, y, -z], [x, y, z], [-x, y, z]], true));
    if (mast) parts.push(S.path([[0, h, 0], [0, h + mast, 0]]));
    return S.merge(...parts);
  }

  const look = {
    id: 'circuit-city',
    name: 'Circuit City',
    theme: 'dark',
    // Faithful to the original, which draws every node in one of two colours: it claims neither rule.
    claims: {},
    font: "Consolas, 'Liberation Mono', monospace",
    lineWidth: 1,                                   // the source strokes every edge 1 px wide
    glow: true,                                     // ... with a 3 px shadow in the node's colour
    caption: text => text.toUpperCase(),
    captionSize: 10,
    palette: {
      bg: C.bg, panel: C.panel, line: LINE, ink: C.text, caption: C.text, muted: C.muted, accent: C.primary,
      // Agents are the cyan towers and the accounts and small boxes cyan; subagents, tasks, worktrees and the
      // upstream panel are amber in the picture. A resource is cyan, after the accounts and small cyan boxes,
      // though its file and context shapes come from the task and the context, which the source draws amber.
      // The tool takes amber (the source's tool is cyan) and the MCP server amber (the source's "remote" is
      // cyan; the picture shows it amber because it is waiting): each after the picture's small blocks.
      cls: { agent: C.primary, subagent: C.secondary, tool: C.secondary, mcp: C.secondary, resource: C.primary },
      // The source's own: amber for "waiting", its alert for "blocked", its text and quiet text for the rest.
      state: { needs: C.secondary, failed: C.alert, working: C.text, unclear: C.muted, idle: C.muted, done: C.muted },
      clash: C.alert,
      // worlds.css .city .viewport: radial-gradient(ellipse at 50% 75%, #103143, var(--bg) 75%).
      ground: { shape: 'round', at: [.5, .75], stops: [[0, '#103143'], [.75, C.bg]] },
      // The source's engine.js line 75: a node's label is in the node's own colour (the selected one in the text colour).
      captionNode: true,
      fill: .06, solid: .6, floorFill: .03, floorLine: .4, post: .35, captionBack: 0, captionHalo: .85
    },
    page: {
      ui: "Consolas, 'Liberation Mono', monospace",
      headFont: "'Segoe UI', Arial, sans-serif",
      labelFont: "Consolas, 'Liberation Mono', monospace",   // worlds.css .panel-label: the body's --mono, 7px, spaced 1.3px
      titleFont: "'Segoe UI', Arial, sans-serif", titleStyle: 'normal', titleWeight: '300', titleSize: '20px',
      titleSpacing: '3px', titleCase: 'uppercase', titleColor: C.text,
      labelSpacing: '1.3px', labelCase: 'uppercase', radius: '3px'
    },
    /** Towers for agents, braced panels for servers, blocks for the rest: the source's shape() scaled to a slot. */
    mesh(key) {
      switch (key) {
        case 'agent': return tower(29, 64, 32, 15, 16);                    // source: tower(29, 110, 32), mast 19
        case 'subagent': return tower(19, 42, 19, 14, 10);                 // source: tower(19, 58, 19)
        case 'tool': return S.box(25, 18, 26);                             // source: the plain block
        case 'mcp': return S.merge(S.box(40, 46, 8), S.path([[-20, 0, -4], [20, 46, 4]]), S.path([[20, 0, -4], [-20, 46, 4]]));   // source: "remote", a braced panel
        case 'resource.file': return S.box(16, 15, 24);                    // source: a task's long block
        case 'resource.url': return S.merge(S.box(14, 14, 14), S.path([[-12, 7, -12], [12, 7, -12], [12, 7, 12], [-12, 7, 12]], true));   // source: an account, a cube with a skirt
        case 'resource.context': return tower(16, 28, 22, 10, 0);          // source: a context's short tower
        case 'stack': return S.merge(S.box(26, 3, 18), S.box(26, 3, 18, 6), S.box(26, 3, 18, 12), S.path([[-13, 0, -9], [13, 15, -9]]));
      }
      throw new Error('Circuit City look: no mesh for "' + key + '"');
    },
    /** The blueprint under the floors: a street grid, a twin ring road, an outline and a label round each
        column's district, and a low skyline at the back. Built from where the floors are; the same every time. */
    backdrop(scene) {
      const { min, max } = scene.bounds, y = -4, step = 50, major = 200, margin = 160;
      const x0 = Math.floor((min[0] - margin) / step) * step, x1 = Math.ceil((max[0] + margin) / step) * step;
      const z0 = Math.floor((min[2] - margin) / step) * step, z1 = Math.ceil((max[2] + margin) / step) * step;
      const minor = [], strong = [];
      for (let x = x0; x <= x1; x += step) (x % major === 0 ? strong : minor).push([[x, y, z0], [x, y, z1]]);
      for (let z = z0; z <= z1; z += step) (z % major === 0 ? strong : minor).push([[x0, y, z], [x1, y, z]]);
      const rect = (ax, az, bx, bz, h) => [[ax, h, az], [bx, h, az], [bx, h, bz], [ax, h, bz], [ax, h, az]];
      const items = [
        { lines: minor, color: '#2f7d9c', alpha: .16, width: .6 },
        { lines: strong, color: '#2f7d9c', alpha: .34, width: .6 },
        { lines: [rect(min[0] - 70, min[2] - 70, max[0] + 70, max[2] + 70, -2)], color: '#54c8e1', alpha: .4, width: .8 },
        { lines: [rect(min[0] - 86, min[2] - 86, max[0] + 86, max[2] + 86, -2)], color: '#54c8e1', alpha: .15, width: .8 }
      ];
      const districts = [];
      let n = 0;
      for (const col of scene.columns) {
        const h = col.half * 1.18;
        districts.push(rect(col.x - h, col.z - h, col.x + h, col.z + h, -1));
        if (!col.dock) items.push({ text: 'DISTRICT ' + String(++n).padStart(2, '0'), at: [col.x + h, -1, col.z - h - 16], color: '#5a9bac', alpha: .7, size: 8, align: 'right' });
      }
      if (districts.length) items.push({ lines: districts, color: '#40c4da', alpha: .36, width: .8 });
      // The low skyline at the back: outlined blocks of varied height, as in the source.
      const sky = [], back = max[2] + 140, count = Math.max(8, Math.round((x1 - x0) / 80));
      for (let i = 0; i < count; i++) {
        const x = x0 + 40 + i * (x1 - x0 - 80) / Math.max(1, count - 1), height = 20 + (i * 19) % 51 * 1.6, w = 15, d = 18;
        sky.push(rect(x - w, back - d, x + w, back + d, height), [[x - w, y, back - d], [x - w, height, back - d]], [[x + w, y, back + d], [x + w, height, back + d]], [[x + w, y, back - d], [x + w, height, back - d]]);
      }
      items.push({ lines: sky, color: '#2f7d9c', alpha: .2, width: .6 });
      return items;
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
