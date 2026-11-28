/* Wyarden 3D monitor: the "Battle neon" look. Battle Royale's neon (F105): near-black, four neons with a glow, a poster face.
 *
 * Adapted from the Entomatical repository (GPL v3, the same owner), media/board.css as it stood in this repository at
 * commit 0a8c20c (git show 0a8c20c:media/board.css): lines 23 to 31 (the four neons, the poster face, the light-theme
 * shades) and lines 297 to 348 (the neon cards, the button and the popup).
 * The meshes are the plain wireframes of look-nexus.js, which adapts them from Entridir (GPL v3), commit 63197c31,
 * nexus-3d/ui-concepts/nexus-lattice-29d4d1/scene.js.
 *
 * Taken as they are: the near-black #0b0b14 (the button and the popup); the four neons, one for each provider (line 25),
 * so agents and subagents take them as a battle card's 4 px top edge does; the poster face (line 26) in capitals; the
 * popup's colours for the page: neon orange text and borders, electric blue for its quieter text and its No button, the
 * title in orange with the button's blue text-shadow, 3 px corners; a glow under every edge (the cards' box-shadow).
 * Changed: a flat page gives no shapes, so the shapes are NEXUS's wireframes, drawn thick (the cards' 2 to 4 px neon
 * borders). The other classes take the popup's colours, but not a neon itself, so that a provider's colour stays its own:
 * a tool the popup's lighter orange (the danger button's hover, #ff8a33, line 336), a resource the darker blue of the Codex neon's
 * light-theme shade (#0069a8, line 31), an MCP server the red the popup's border falls back to (#f14c4c). The battle
 * look had no state colours: the marks take the board's status colours (lines 17 to 21, the dark fall-backs) and, for
 * idle and unclear, a pale grey of this look's own. The backdrop is the popup's border redrawn round the floors, flat
 * under them: a 3 px orange line with its orange and blue glow (the box-shadow of lines 330 to 331), standing still.
 * Not possible here: the slant. A caption in the scene is drawn in the look's font family only, so it is heavy capitals
 * but upright; the title above the scene is slanted.
 * For now: the page's running text starts the face's list at its second font (see TEXT below), because with Impact the
 * scene changes size at 560 x 600. The title, the panels' headings and the captions keep Impact.
 *
 * A look is palette, meshes, caption style and a still backdrop. It has no say in where a node stands. See LOOKS.md.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.MonitorEngine;
  const S = E.shapes;

  const NEON = { claude: '#ff6a00', codex: '#00b3ff', grok: '#39ff14', antigravity: '#ff2bd6' };
  const FACE = "Impact, Haettenschweiler, 'Arial Narrow Bold', 'DejaVu Sans Condensed', sans-serif";
  // The page's running text: the same list from its second font. Impact there sets the status line under the scene on
  // one line where every other look takes two, so the scene grows at 560 x 600 and the looks test's size check fails.
  // A finishing pass is to give the page its first font back once that check allows it (card 5a6363).
  const TEXT = "Haettenschweiler, 'Arial Narrow Bold', 'DejaVu Sans Condensed', sans-serif";

  const look = {
    id: 'battle-neon',
    name: 'Battle neon',
    theme: 'dark',
    // One neon for each provider. Not the classes rule: a tool's lighter orange cannot be told from Claude's neon at a glance.
    claims: { providers: true },
    font: FACE,
    lineWidth: 2.4,
    glow: true,
    captionSize: 12,
    caption: text => text.toUpperCase(),
    palette: {
      bg: '#0b0b14', panel: '#0b0b14', line: NEON.claude, ink: NEON.claude, caption: NEON.claude, muted: NEON.codex, accent: NEON.codex,
      // agent and subagent are only for a provider the look does not know: every agent and subagent takes its neon.
      cls: { agent: NEON.claude, subagent: NEON.codex, tool: '#ff8a33', resource: '#0069a8', mcp: '#f14c4c' },
      provider: Object.assign({}, NEON),
      // The floor agents stand on: the popup's quieter blue would be Codex's, so the pale grey of the idle marks.
      floor: { agent: '#c8c8d8' },
      state: { needs: '#d18616', failed: '#f14c4c', working: '#3794ff', unclear: '#c8c8d8', idle: '#c8c8d8', done: '#89d185' },
      clash: '#f14c4c',
      fill: .12, solid: .9, floorFill: .03, floorLine: .6, post: .5, captionBack: 0, captionHalo: .85
    },
    page: {
      ui: TEXT, headFont: FACE, titleFont: FACE, titleStyle: 'italic', titleWeight: '900', titleSize: '20px',
      titleSpacing: '0.04em', titleCase: 'uppercase', titleColor: NEON.claude, titleShadow: '0 0 6px rgba(0, 179, 255, 0.8)',
      labelSpacing: '0.04em', labelCase: 'uppercase', radius: '3px'
    },
    /** The popup's border round the floors, flat under them: its glow (orange 14 px, blue 28 px) and its 3 px orange line. */
    backdrop(scene) {
      const { min, max } = scene.bounds, pad = 60, y = min[1] - 6;
      const x0 = min[0] - pad, x1 = max[0] + pad, z0 = min[2] - pad, z1 = max[2] + pad;
      const frame = [[[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [x0, y, z0]]];
      return [
        { lines: frame, color: NEON.codex, alpha: .14, width: 6 },
        { lines: frame, color: NEON.claude, alpha: .3, width: 5 },
        { lines: frame, color: NEON.claude, alpha: .95, width: 2.2 }
      ];
    },
    /** NEXUS's silhouettes: twenty-sided, small twelve-sided, cube, hexagon, flat sheet, three rings, flat triangle, pile. */
    mesh(key) {
      switch (key) {
        case 'agent': return S.icosahedron(23);
        case 'subagent': return S.dodecahedron(12);
        case 'tool': return S.box(24, 24, 24);
        case 'mcp': return S.merge(S.prism(6, 19, 14), S.ring(9, 6, 'xz', 14));
        case 'resource.file': return S.merge(S.box(24, 3, 30), S.path([[-7, 3, -8], [7, 3, -8]]), S.path([[-7, 3, -2], [7, 3, -2]]), S.path([[-7, 3, 4], [3, 3, 4]]));
        case 'resource.url': return S.merge(S.ring(11, 14, 'xy', 11), S.ring(11, 14, 'zy', 11), S.ring(11, 14, 'xz', 11));
        case 'resource.context': return S.merge(S.prism(3, 15, 4, 0, -Math.PI / 2), S.ring(6, 3, 'xz', 4));
        case 'stack': return S.merge(S.box(24, 2, 18), S.box(24, 2, 18, 5), S.box(24, 2, 18, 10), S.box(24, 2, 18, 15));
      }
      throw new Error('Battle neon look: no mesh for "' + key + '"');
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
