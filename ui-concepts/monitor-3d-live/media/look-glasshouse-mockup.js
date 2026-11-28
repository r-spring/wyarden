/* Wyarden 3D monitor: the Glasshouse look as the simulated mock-up draws it.
 *
 * From ui-concepts/monitor-3d/look-glasshouse.js in this repository, whose stepped chips and light
 * palette are adapted from Entridir (the Entridir repository, GPL v3), commit 63197c31,
 * nexus-3d/ui-concepts/nexus-worlds-29d4d1/modes-glass-synapse.js.
 * Kept from the mock-up, and what tells it from the live tab's Glasshouse: an agent is a teal stepped
 * tower with a mast and a subagent a blue two-step chip; every class has one colour and no provider
 * has one of its own; and a caption sits on a pale plate.
 *
 * A look is palette, meshes and caption style. It has no say in where a node stands. See LOOKS.md.
 */
(function (root) {
  'use strict';
  const S = (typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.MonitorEngine).shapes;

  const look = {
    id: 'glasshouse-mockup',
    name: 'Glasshouse mock-up',
    theme: 'light',
    // Five silhouettes and five colours, one for each class. No colour for a provider.
    claims: { classes: true },
    font: "'Segoe UI', system-ui, -apple-system, Arial, sans-serif",
    lineWidth: 1.35,
    glow: false,
    caption: text => text,
    palette: {
      bg: '#f1f4ee', panel: '#e6ece5', line: '#7f9c97', ink: '#12292e', caption: '#1f4046', muted: '#4f6b6a', accent: '#1f7480',
      cls: { agent: '#1f7480', subagent: '#2b5fd0', tool: '#2f7d46', resource: '#6c4bb0', mcp: '#b3541e' },
      state: { needs: '#b87700', failed: '#c8323f', working: '#12292e', unclear: '#6b7c7c', idle: '#6b7c7c', done: '#8d9d9a' },
      clash: '#c8323f',
      // captionBack .84: a caption sits on a plate of the background's colour, as in the mock-up; so it needs no halo.
      fill: .16, solid: .92, floorFill: .07, floorLine: .6, post: .5, captionBack: .84, captionHalo: 0
    },
    /** One silhouette for each class: a tower with a mast, a small step, a braced crate, a sheet, a globe on a plate, a triangle, a hexagon, a pile. */
    mesh(key) {
      switch (key) {
        case 'agent': return S.merge(S.box(40, 7, 32), S.box(28, 6, 22, 7), S.box(16, 6, 12, 13), S.path([[0, 19, 0], [0, 32, 0]]));
        case 'subagent': return S.merge(S.box(22, 5, 18), S.box(12, 5, 10, 5));
        case 'tool': return S.merge(S.box(26, 10, 20), S.path([[-13, 10, -10], [13, 10, 10]]), S.path([[13, 10, -10], [-13, 10, 10]]));
        case 'mcp': return S.merge(S.prism(6, 20, 6), S.prism(6, 11, 6, 6));
        case 'resource.file': return S.merge(S.box(24, 3, 30), S.path([[-7, 3, -8], [7, 3, -8]]), S.path([[-7, 3, -2], [7, 3, -2]]), S.path([[-7, 3, 4], [3, 3, 4]]));
        case 'resource.url': return S.merge(S.box(22, 2, 22), S.ring(10, 14, 'xy', 13), S.ring(10, 14, 'zy', 13));
        case 'resource.context': return S.merge(S.prism(3, 15, 4, 0, -Math.PI / 2), S.ring(6, 3, 'xz', 4));
        case 'stack': return S.merge(S.box(24, 2, 18), S.box(24, 2, 18, 5), S.box(24, 2, 18, 10), S.box(24, 2, 18, 15));
      }
      throw new Error('Glasshouse mock-up look: no mesh for "' + key + '"');
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
