/* Wyarden 3D monitor: the "Orbital Mechanics" look. Indigo sky, lilac latticed globes, peach rings and pyramids.
 *
 * Adapted from Entridir (the Entridir repository, GPL v3), commit 63197c31,
 * nexus-3d/ui-concepts/nexus-worlds-29d4d1/modes-city-orbit.js (worlds.orbit: palette, environment, shape,
 * sphere() and inclinedOrbit()) and worlds.css (:root and the .orbit rules); picture docs/monitor-3d/img/before/orbit.png.
 * Kept: the palette's hex values; the latticed globe (rings of latitude joined along meridians), the small
 * drum, the double ring and the three-sided pyramid; the tilted orbit rings in the source's colours and
 * strengths (.8 wide, not .65) and its golden-angle star field (180 dots at .35 and .7, not 62 dashes at
 * .22 and .5: stronger, to show at this scale); Consolas captions in capitals; an italic Georgia title, serif
 * headings, round corners and pill buttons.
 * Changed: the five classes take the nearest type's shape (agent a large globe, subagent the orchestrator's
 * small globe, tool the pyramid, MCP server the ring of "main" and "remote", resource the drums of tasks,
 * contexts and accounts), scaled to a slot and standing on it; colours are the picture's (lilac globes for
 * agents, peach for the rest) and never a state's; the rings and stars are centred on the floors and sized
 * from them, and they stand still: nothing orbits. Left out: the moving planets and their moons' rings, the
 * workspace star's rings (there is no star node), and separate corner radii for panels (16 px) and buttons
 * (pills): one radius serves both. Kept since the contract's second round: the viewport's radial glow
 * (palette.ground), each node's label in its own colour (palette.captionNode), and the panels' small labels
 * in the page's Consolas under Georgia headings (page.labelFont).
 *
 * A look is palette, meshes, lettering and a still backdrop. It has no say in where a node stands.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.MonitorEngine;
  const S = E.shapes;

  // The source's palette (modes-city-orbit.js, worlds.orbit.palette), as it gives it.
  const C = { bg: '#050514', panel: '#0c0b20', text: '#efe6ff', muted: '#a398c5', primary: '#c4a4ff', secondary: '#ffc88c', alert: '#ff719b' };
  // worlds.css: --line is the primary at 19% over the panel; here worked out as a flat colour.
  const LINE = '#2f284a';

  /** The source's sphere(): `rings` circles of latitude of `segments` corners, joined along the meridians; set on y = 0. */
  function sphere(radius, segments, rings) {
    const vertices = [], lines = [];
    for (let ring = 0; ring < rings; ring++) for (let i = 0; i < segments; i++) {
      const lon = i / segments * Math.PI * 2, lat = (ring + 1) / (rings + 1) * Math.PI - Math.PI / 2;
      vertices.push([Math.cos(lon) * Math.cos(lat) * radius, Math.sin(lat) * radius + radius, Math.sin(lon) * Math.cos(lat) * radius]);
      lines.push([ring * segments + i, ring * segments + (i + 1) % segments]);
      if (ring) lines.push([(ring - 1) * segments + i, ring * segments + i]);
    }
    return { vertices, lines };
  }
  /** The source's ring for "main" and "remote": two circles, the inner one set back, joined by spokes; upright. */
  function doubleRing(outer, inner, depth, count) {
    const vertices = [], lines = [];
    for (let i = 0; i < count; i++) {
      const a = i / count * Math.PI * 2;
      vertices.push([Math.cos(a) * outer, Math.sin(a) * outer + outer, -depth / 2], [Math.cos(a) * inner, Math.sin(a) * inner + outer, depth / 2]);
      lines.push([i * 2, ((i + 1) % count) * 2], [i * 2 + 1, ((i + 1) % count) * 2 + 1], [i * 2, i * 2 + 1]);
    }
    return { vertices, lines };
  }
  /** The source's inclinedOrbit(): a ring of `radius` round `c`, tilted by `tilt` and turned by `turn`. One polyline. */
  function orbit(c, radius, tilt, turn, segments) {
    const out = [];
    for (let i = 0; i <= segments; i++) {
      const a = i / segments * Math.PI * 2, x = Math.cos(a) * radius, z = Math.sin(a) * radius;
      out.push([c[0] + x * Math.cos(turn) - z * Math.cos(tilt) * Math.sin(turn), c[1] + z * Math.sin(tilt), c[2] + x * Math.sin(turn) + z * Math.cos(tilt) * Math.cos(turn)]);
    }
    return out;
  }

  const look = {
    id: 'orbital',
    name: 'Orbital Mechanics',
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
      // Lilac globes for agents; peach for the subagents' small globes, the pyramids, the rings and the drums.
      // The source gives a tool its lilac primary; the tool takes peach after the picture's outer-belt pyramids.
      cls: { agent: C.primary, subagent: C.secondary, tool: C.secondary, mcp: C.secondary, resource: C.secondary },
      // The source's own: peach for "waiting", its alert for "blocked", its text and quiet text for the rest.
      state: { needs: C.secondary, failed: C.alert, working: C.text, unclear: C.muted, idle: C.muted, done: C.muted },
      clash: C.alert,
      // worlds.css .orbit .viewport: radial-gradient(ellipse at center, #111e35, #02040c 75%).
      ground: { shape: 'round', at: [.5, .5], stops: [[0, '#111e35'], [.75, '#02040c']] },
      // The source's engine.js line 75: a node's label is in the node's own colour (the selected one in the text colour).
      captionNode: true,
      fill: .06, solid: .55, floorFill: .02, floorLine: .3, post: .25, captionBack: 0, captionHalo: .85
    },
    page: {
      ui: "Consolas, 'Liberation Mono', monospace",
      headFont: "Georgia, 'Times New Roman', serif",
      labelFont: "Consolas, 'Liberation Mono', monospace",   // worlds.css .panel-label: the body's --mono, 7px, spaced 1.3px
      titleFont: "Georgia, 'Times New Roman', serif", titleStyle: 'italic', titleWeight: '400', titleSize: '20px',
      titleSpacing: '-0.5px', titleCase: 'none', titleColor: C.text,
      labelSpacing: '1.3px', labelCase: 'uppercase', radius: '14px'
    },
    /** Globes for agents, a pyramid for a tool, a ring for a server, drums for resources: the source's shape() scaled to a slot. */
    mesh(key) {
      switch (key) {
        case 'agent': return sphere(23, 12, 4);                            // source: sphere(20, 12, 4)
        case 'subagent': return sphere(12, 10, 3);                         // source: the orchestrator's sphere(12, 10, 3)
        case 'tool': return { vertices: [[0, 24, 0], [14.4, 0, 0], [-8, 0, 12.8], [-8, 0, -12.8]], lines: [[0, 1], [0, 2], [0, 3], [1, 2], [2, 3], [3, 1]] };   // source's pyramid, x 1.6
        case 'mcp': return doubleRing(21, 17, 9, 20);                      // source: "main" and "remote"
        case 'resource.file': return sphere(11, 8, 2);                     // source: a task's drum, sphere(9, 8, 2)
        case 'resource.url': return S.merge(sphere(9, 8, 2), S.path([[0, 9, -16], [0, 9, 16]]));   // source: an account, a drum on an axis
        case 'resource.context': return sphere(15, 8, 2);                  // source: a context's wider drum, sphere(12, 8, 2)
        case 'stack': return S.merge(S.ring(13, 12, 'xz', 0), S.ring(13, 12, 'xz', 5), S.ring(13, 12, 'xz', 10), S.ring(13, 12, 'xz', 15));
      }
      throw new Error('Orbital Mechanics look: no mesh for "' + key + '"');
    },
    /** Tilted orbit rings round the middle of the floors and a sparse star field, as in the source; still. */
    backdrop(scene) {
      const { min, max } = scene.bounds;
      const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      const R = Math.max(380, Math.hypot(max[0] - min[0], max[2] - min[2]) / 2 + 120), k = R / 390;   // the source's outer belt is 390
      const low = [c[0], c[1] - 55 * k, c[2]];
      const items = [
        // [radius, tilt, turn, colour, alpha] from the source's environment(), radii in its units.
        [66, 1.05, 0, '#caadff', .2], [105, .8, 0, '#a99ad0', .15], [205, .12, .2, '#bf9ffc', .28], [215, .2, -.3, '#a786d9', .12],
        [316, .18, 0, '#d3a274', .2], [390, .18, 0, '#d1a782', .16]
      ].map(([r, tilt, turn, color, alpha]) => ({ lines: [orbit(c, r * k, tilt, turn, r < 150 ? 48 : 96)], color, alpha, width: .8 }));
      items.push({ lines: [orbit(low, 340 * k, .13, 0, 96)], color: '#638fa6', alpha: .2, width: .8 });
      // The source's star field: golden-angle scatter outside the rings, each fifth star brighter.
      const dim = [], bright = [];
      for (let i = 0; i < 180; i++) {
        const a = i * 2.399963, r = (1.05 + (i % 7) * .09) * R, y = c[1] - 260 + (i * 47) % 900;
        (i % 5 === 0 ? bright : dim).push([c[0] + Math.cos(a) * r, y, c[2] + Math.sin(a) * r]);
      }
      items.push({ dots: dim, color: '#8a82b5', alpha: .35, size: 1 }, { dots: bright, color: '#8a82b5', alpha: .7, size: 1.4 });
      items.push({ text: 'OUTER BELT', at: [c[0], c[1] - 30 * k, c[2] - 390 * k], color: '#887aa7', alpha: .7, size: 8, align: 'center' });
      return items;
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
