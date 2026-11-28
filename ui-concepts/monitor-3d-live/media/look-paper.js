/* Wyarden 3D monitor: the "Paper" look. The landing page, light: warm paper, brown-black ink, hairline rules,
 * a Palatino serif and a very large title of medium weight, set tight. No accent colour at all.
 *
 * Source: this repository, public/index.html (lines 14-15: paper #f3f0e8 and ink #1c1915; line 16: the serif
 * stack; line 28: the hairline rule in ink under the header; lines 30-34: the title, weight 500, -0.03em).
 * Changed:
 * - The page is flat, so it has no shapes. The shapes here are plain solids of this look's own, drawn as an
 *   engraving is: thin ink lines on paper, a hatched top on the cube, ruled lines on a sheet. One ink for every
 *   class, so the classes are told apart by shape alone (an obelisk, a small pyramid, a hatched cube, a drum, a
 *   ruled sheet, a globe, a pennant, a pile of sheets). It claims neither of the monitor's two rules.
 * - The page has no second text colour. The quiet text here is the ink at 62% on the paper (#6e6b65), worked out
 *   from those two, so the page's quiet lines stay readable.
 * - Every state mark, the clash arc, the focus ring and a pressed button are the ink: the page has no accent.
 * - The title is 20 px, the most the monitor's bar holds (4.6rem on the page). The page's title "Wyarden" and
 *   its hairline rule are drawn as a still backdrop above the building, at 40 px.
 *
 * Its relatives: `paper-dark` is this page turned over; `signal-house` has colour and dark panels, this has
 * one ink and neither.
 *
 * A look is palette, meshes and caption style. It has no say in where a node stands. See LOOKS.md.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.MonitorEngine;
  const S = E.shapes;

  const PAPER = '#f3f0e8', INK = '#1c1915', QUIET = '#6e6b65';     // index.html lines 14-15; QUIET: see above
  const SERIF = "Palatino, 'Palatino Linotype', 'Iowan Old Style', Georgia, serif";   // index.html line 16

  /** Parallel strokes across the top of a box `w` by `d` at height `y`: an engraver's hatching. */
  function hatch(w, d, y, count) {
    const out = [];
    for (let i = 1; i <= count; i++) {
      const t = -w / 2 + (w * i) / (count + 1);
      out.push(S.path([[t, y, -d / 2], [t, y, d / 2]]));
    }
    return out;
  }

  const look = {
    id: 'paper',
    name: 'Paper',
    theme: 'light',
    // One ink for five classes: told apart by shape only, like an engraving.
    claims: {},
    font: SERIF,
    lineWidth: .8,
    glow: false,
    caption: text => text,             // the page sets its words as written: no capitals added
    palette: {
      bg: PAPER, panel: PAPER, line: INK, ink: INK, caption: INK, muted: QUIET, accent: INK,
      cls: { agent: INK, subagent: INK, tool: INK, resource: INK, mcp: INK },
      state: { needs: INK, failed: INK, working: INK, unclear: INK, idle: INK, done: INK },
      clash: INK,
      // Ink lines on paper: next to no tint, and the paper hides what stands behind a shape.
      fill: .04, solid: .92, floorFill: 0, floorLine: .5, post: .18, captionBack: 0, captionHalo: .9
    },
    page: {
      ui: SERIF, headFont: SERIF,
      titleFont: SERIF, titleStyle: 'normal', titleWeight: '500', titleSize: '20px', titleSpacing: '-0.03em',
      titleCase: 'none', titleColor: INK,
      labelSpacing: '0px', labelCase: 'none', radius: '0px'
    },
    /** The page's header: its title, very large and tight, over one hairline rule in ink. Above the building's back. */
    backdrop(scene) {
      const { min, max } = scene.bounds;
      const top = Math.max(...['agent', 'mcp', 'tool', 'resource'].map(f => scene.floors[f]));
      const x0 = min[0] - 40, x1 = max[0] + 40, z = max[2] + 30, y = top + 105;
      return [
        { text: 'Wyarden', at: [x0, y + 10, z], color: INK, alpha: 1, size: 40, align: 'left' },
        { lines: [[[x0, y, z], [x1, y, z]]], color: INK, alpha: .9, width: .7 }
      ];
    },
    mesh(key) {
      switch (key) {
        // An obelisk on its plinth.
        case 'agent': return S.merge(S.box(22, 4, 22), S.prism(4, 10, 40, 4, Math.PI / 4), S.pyramid(4, 10, 9, 44, Math.PI / 4));
        // A small pyramid.
        case 'subagent': return S.pyramid(4, 14, 20, 0, Math.PI / 4);
        // A cube with a hatched top.
        case 'tool': return S.merge(S.box(22, 22, 22), ...hatch(22, 22, 22, 4));
        // A drum: ten-sided, with its lid's rim.
        case 'mcp': return S.merge(S.prism(10, 17, 15), S.ring(11, 10, 'xz', 15));
        // A ruled sheet, as the page's own lines.
        case 'resource.file': return S.merge(S.box(22, 2, 28), S.path([[-7, 2, -9], [7, 2, -9]]), S.path([[-7, 2, -4], [7, 2, -4]]), S.path([[-7, 2, 1], [7, 2, 1]]), S.path([[-7, 2, 6], [2, 2, 6]]));
        // A globe: two meridians, the equator and one parallel.
        case 'resource.url': return S.merge(S.ring(11, 16, 'xy', 11), S.ring(11, 16, 'zy', 11), S.ring(11, 16, 'xz', 11), S.ring(8, 12, 'xz', 18.5));
        // A pennant laid flat, with a ruled line inside.
        case 'resource.context': return S.merge(S.prism(3, 14, 3, 0, -Math.PI / 2), S.path([[-4, 3, -6], [-4, 3, 6]]));
        // A pile of sheets.
        case 'stack': return S.merge(S.box(22, 1.5, 28), S.box(22, 1.5, 28, 4.5), S.box(22, 1.5, 28, 9), S.box(22, 1.5, 28, 13.5));
      }
      throw new Error('Paper look: no mesh for "' + key + '"');
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
