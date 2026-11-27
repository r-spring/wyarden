/* Monitor 3D mock-up: the NEXUS lattice look. Dark wireframe with a soft glow; the default.
 *
 * Palette and the octahedron, cube and ring meshes are adapted from Entridir
 * (the Entridir repository, GPL v3), commit 63197c31,
 * nexus-3d/ui-concepts/nexus-lattice-29d4d1/scene.js and style.css.
 * Changed: one mesh and one colour for each of the five classes, and no colour that stands for a state.
 * Changed for the working mock-up, at the owner's word: an agent is an icosahedron and a subagent a
 * dodecahedron, both in their provider's colour; and a caption has no plate behind it.
 *
 * A look is palette, meshes and caption style. It has no say in where a node stands.
 */
(function (root) {
  'use strict';
  const S = (typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.MonitorEngine).shapes;

  const look = {
    id: 'nexus',
    name: 'NEXUS lattice',
    theme: 'dark',
    font: "Consolas, 'Cascadia Code', 'SFMono-Regular', 'Liberation Mono', monospace",
    lineWidth: 1.15,
    glow: true,
    caption: text => text.toUpperCase(),
    palette: {
      bg: '#040b12', panel: '#07121b', line: '#28566b', ink: '#e8fcff', caption: '#c3dde4', muted: '#86a7b6', accent: '#61e5f5',
      // A class's own colour. `agent` is also the colour of the floor agents stand on; an agent itself, and a subagent,
      // takes its provider's colour below, and these two are only what is used for a provider the look does not know.
      cls: { agent: '#61e5f5', subagent: '#6a95ff', tool: '#7ee6ab', resource: '#b9a2ff', mcp: '#ffb36a' },
      // One colour for each provider, for its agents and their subagents: coral, cyan, silver, blue. None is a tool's
      // green, a resource's violet or an MCP server's amber, and none is a state's yellow or red.
      provider: { claude: '#ff8466', codex: '#4fd8e8', grok: '#e3e9ee', antigravity: '#6f9bff' },
      // The floor agents stand on: a quiet steel, so that no provider's colour (Codex's cyan above all) runs into it.
      floor: { agent: '#6f8996' },
      state: { needs: '#ffe14d', failed: '#ff647f', working: '#f4feff', unclear: '#b8c4cc', idle: '#9db4bf', done: '#7b919d' },
      clash: '#ff647f',
      // captionBack 0: a caption has no plate behind it. captionHalo: a thin outline in the background's colour, around the letters only.
      fill: .1, solid: .88, floorFill: 0, floorLine: .5, post: .55, captionBack: 0, captionHalo: .8
    },
    /** One silhouette for each class: twenty-sided, small twelve-sided, square, flat sheet, round, flat triangle, hexagon, pile. */
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
      throw new Error('NEXUS look: no mesh for "' + key + '"');
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
