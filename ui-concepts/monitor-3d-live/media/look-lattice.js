/* Wyarden 3D monitor: the "Lattice original" look. The NEXUS lattice as Entridir first drew it.
 *
 * Adapted from Entridir (the Entridir repository, GPL v3), commit 63197c31,
 * nexus-3d/ui-concepts/nexus-lattice-29d4d1/scene.js and style.css; picture docs/monitor-3d/img/before/lattice.png.
 * Taken as they are: the type colours (scene.js line 4), the octahedron, cube and ring meshes and their radii
 * (geometry() and nodeRadius()), the ground grid with every fourth line stronger, the three rings round the
 * centre and the four zone names lying on the ground (draw()), and the page's colours and lettering (style.css).
 * Changed: the original's twelve types are given to the monitor's five classes (agent the control cyan octahedron,
 * subagent the pale-blue smaller octahedron, tool the mint cube, MCP server the amber ring of main and remote,
 * resource the violet ring of context); the second violet and the second amber colour the resource and MCP floors,
 * which the original did not have. The original coloured blocked and waiting nodes red and amber: here those are
 * only the colours of the marks. The workspace's turning, the pulses and the travelling dots are left out: nothing
 * moves by itself. The ground is drawn round the floors instead of round the original's own scene.
 *
 * A look is palette, meshes, caption style and a still backdrop. It has no say in where a node stands. See LOOKS.md.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.MonitorEngine;
  const S = E.shapes;

  /** The original's ring: sixteen sides standing upright, with two points on its axis joined to every fourth corner. */
  function lantern(radius) {
    const vertices = [], lines = [];
    for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8; vertices.push([Math.cos(a) * radius, radius + Math.sin(a) * radius, 0]); lines.push([i, (i + 1) % 16]); }
    vertices.push([0, radius, -radius * .7], [0, radius, radius * .7]);
    for (let i = 0; i < 16; i += 4) lines.push([i, 16], [i, 17]);
    return { vertices, lines };
  }
  /** The original's cube: a node of radius 15 drawn with half-side 15 x 0.7. */
  const cube = (radius, y) => S.box(radius * 1.4, radius * 1.4, radius * 1.4, y);

  const look = {
    id: 'lattice',
    name: 'Lattice original',
    theme: 'dark',
    // Neither rule: as in the original, a subagent is the agent's octahedron made smaller, and an MCP server and a
    // resource share the ring, told apart by size and colour. Every class has its own colour; no provider has one.
    claims: {},
    // scene.js draws its labels in Consolas; style.css --mono names Cascadia Code first, but Cascadia is wider and the
    // page's status line would wrap at 800 px and shrink the scene. Consolas first, then the rest of --mono.
    font: "Consolas, 'Cascadia Code', 'SFMono-Regular', 'Liberation Mono', monospace",
    lineWidth: 1,                                         // the original's edges: 1 px with a 3 px glow
    glow: true,
    caption: text => text.toUpperCase(),
    page: {
      ui: "Consolas, 'Cascadia Code', 'SFMono-Regular', 'Liberation Mono', monospace",
      headFont: "Consolas, 'Cascadia Code', 'SFMono-Regular', 'Liberation Mono', monospace",
      // The masthead's NEXUS: Segoe UI 500, wide-spaced capitals in near-white (.brand).
      titleFont: "'Segoe UI', Arial, sans-serif",
      titleWeight: '500',
      titleSize: '18px',
      titleSpacing: '6px',
      titleCase: 'uppercase',
      titleColor: '#e3f9fd',
      titleStyle: 'normal',
      // The small headings: "01 / SYSTEM DIRECTORY" (.section-label, .eyebrow).
      labelSpacing: '1.25px',
      labelCase: 'uppercase',
      radius: '2px'
    },
    palette: {
      // style.css: the stage's ground (#06111c, the middle of its gradient), --panel, --line, the brand's white,
      // --white, --muted, --cyan.
      bg: '#06111c', panel: '#07121b', line: '#19313d', ink: '#e3f9fd', caption: '#cce6ec', muted: '#7697a8', accent: '#61e5f5',
      // scene.js line 4: agent cyan, subagent pale blue, tool mint, context violet, worktree / main / remote amber.
      cls: { agent: '#61e5f5', subagent: '#97d6ee', tool: '#7ee6ab', resource: '#a09aff', mcp: '#ffb36a' },
      // The second violet (account) and the second amber (check), on the floors of their families.
      floor: { resource: '#cf9bff', mcp: '#ffd48a' },
      // The marks only. needs: the original's waiting amber; failed: its blocked red (--red); working: its selected
      // label's white; the quiet ones: its grey-blue texts (#a6ccd4, --muted, .dim).
      state: { needs: '#ffce7b', failed: '#ff647f', working: '#e2fbff', unclear: '#a6ccd4', idle: '#7697a8', done: '#638493' },
      clash: '#ff647f',
      // Wireframe through and through: nothing filled and nothing hidden, as the original drew it.
      // captionHalo: the original's labels had a dark shadow (#020910, blur 4) round their letters.
      fill: 0, solid: 0, floorFill: 0, floorLine: .4, post: .45, captionBack: 0, captionHalo: .8
    },
    /** The original's three geometries at its own radii: octahedron 22 and 12, cube 15, ring 22 and 15. */
    mesh(key) {
      switch (key) {
        case 'agent': return S.octahedron(22);
        case 'subagent': return S.octahedron(12);
        case 'tool': return cube(15);
        case 'mcp': return lantern(22);
        case 'resource.file':
        case 'resource.url':
        case 'resource.context': return lantern(15);
        case 'stack': return S.merge(cube(12), cube(12, 18), cube(12, 36));
      }
      throw new Error('Lattice look: no mesh for "' + key + '"');
    },
    /** The ground: a grid every 50 with every fourth line stronger, three rings round the centre, four zone names. */
    backdrop(scene) {
      const { min, max } = scene.bounds, y = min[1] - 18;
      const cx = Math.round((min[0] + max[0]) / 2 / 50) * 50, cz = Math.round((min[2] + max[2]) / 2 / 50) * 50;
      const hx = Math.ceil(((max[0] - min[0]) / 2 + 300) / 200) * 200, hz = Math.ceil(((max[2] - min[2]) / 2 + 450) / 200) * 200;
      const faint = [], strong = [];
      for (let i = -hx; i <= hx; i += 50) (i % 200 === 0 ? strong : faint).push([[cx + i, y, cz - hz], [cx + i, y, cz + hz]]);
      for (let i = -hz; i <= hz; i += 50) (i % 200 === 0 ? strong : faint).push([[cx - hx, y, cz + i], [cx + hx, y, cz + i]]);
      // The original's rings are 92, 100 and 260 round a scene some 900 wide; here they grow with the floors.
      const k = Math.max(1, Math.min(2.2, (max[0] - min[0]) / 900)), at = [cx, y + 1, cz];
      const ring = r => E.strokes.ring(at, r * k, 64);
      const zone = (text, x, z, align) => ({ text, at: [x, y + 5, z], color: '#527e90', alpha: .45, size: 9, align: align || 'center' });
      return [
        { lines: faint, color: '#174251', alpha: .18, width: .5 },
        { lines: strong, color: '#174251', alpha: .38, width: .5 },
        { lines: [ring(92)], color: '#61e5f5', alpha: .3, width: .7 },
        { lines: [ring(100)], color: '#61e5f5', alpha: .12, width: .7 },
        { lines: [ring(260)], color: '#28566b', alpha: .18, width: .7 },
        zone('CONTEXT / INPUT', min[0] - 130, cz),
        zone('TOOLS / CAPABILITIES', cx, max[2] + 150),
        zone('ISOLATED WORKTREES', max[0] + 30, cz - 40, 'right'),
        zone('INTEGRATION GATE', max[0] - 40, max[2] + 150, 'right')
      ];
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
