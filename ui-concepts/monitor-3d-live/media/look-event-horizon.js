/* Wyarden 3D monitor: the "Event Horizon" look. Entridir's world 05, time as a tunnel of rings.
 *
 * Adapted from Entridir (the Entridir repository, GPL v3), commit 63197c31,
 * nexus-3d/ui-concepts/nexus-worlds-29d4d1/modes-horizon-terrain.js, world.js and worlds.css;
 * picture docs/monitor-3d/img/before/horizon.png.
 * Taken as they are: the palette (modes-horizon-terrain.js line 13), the one clock mesh for every node at its two radii
 * (clockMesh(), lines 5 to 9), which type takes the primary amber and which the secondary cyan (world.js line 16), the
 * tunnel's amber and grey-cyan rings, its eight long lines, the cyan ring of the present, the cyan streaks on the wall and
 * the words PRESENT, PAST and CONSEQUENCE (environment(), lines 23 to 34), each label in its node's colour (engine.js
 * line 75), and the page's colours and lettering and the viewport's light with its dark edges (worlds.css, the
 * .horizon rules and the base rules).
 * Changed: the original's twelve types are given to the monitor's five classes (agent the large amber clock, as its
 * workspace and orchestrator; subagent a small cyan clock; tool a small amber clock; MCP server a cyan clock, as its main
 * branch, drawn at 18 so it differs from a tool; resource a small cyan clock, as its context). The agent's clock is turned
 * edge-on so it reads as the tall diamond at the original's centre, which there came from the workspace's turning.
 * The tunnel stands still: the original scrolled it with the clock. Its axis runs along the monitor's first view instead of
 * along z, so that its rings stand inside each other as in the picture. "PRESENT / 034s" is only PRESENT: a look is never
 * told a time, and it stands just inside the ring's top, as above it the stage ends. The original coloured blocked and waiting nodes red and cyan: here those are only the colours of the marks.
 * Ring counts and segments are cut to keep the backdrop inside the contract's limits.
 *
 * A look is palette, meshes, caption style and a still backdrop. It has no say in where a node stands. See LOOKS.md.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.MonitorEngine;
  const S = E.shapes;

  /** clockMesh(): twelve corners on a circle facing the viewer, and two points on its axis joined to every third corner.
   *  Lifted by its radius so it stands on y = 0, and turned about the upright axis by `turn`. */
  function clock(r, turn) {
    const c = Math.cos(turn || 0), s = Math.sin(turn || 0), vertices = [], lines = [];
    const put = (x, y, z) => vertices.push([x * c - z * s, y + r, x * s + z * c]);
    for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; put(Math.cos(a) * r, Math.sin(a) * r, 0); lines.push([i, (i + 1) % 12]); }
    put(0, 0, -r); put(0, 0, r);
    for (let i = 0; i < 12; i += 3) lines.push([i, 12], [i, 13]);
    return { vertices, lines };
  }
  const lift = (mesh, y) => ({ vertices: mesh.vertices.map(v => [v[0], v[1] + y, v[2]]), lines: mesh.lines });

  const look = {
    id: 'event-horizon',
    name: 'Event Horizon',
    theme: 'dark',
    // Neither rule: the original draws every node with the one clock mesh, in one of two colours.
    claims: {},
    // The original's labels are 8 px Consolas (engine.js); the page's text is --mono.
    font: "Consolas, 'Liberation Mono', monospace",
    lineWidth: 1,                                         // the original's edges: 1 px with a 3 px glow
    glow: true,
    caption: text => text.toUpperCase(),
    page: {
      ui: "Consolas, 'Liberation Mono', monospace",
      // The inspector's heading: .horizon .node-title, 22px --sans. The small labels stay the page's --mono (.panel-label, .node-type).
      headFont: "'Segoe UI', Arial, sans-serif",
      labelFont: "Consolas, 'Liberation Mono', monospace",
      // The world's title: .horizon .world-title h1, 300 38px --sans, uppercase, 7px apart. The bar holds 20 px at most:
      // the spacing is cut in the same proportion.
      titleFont: "'Segoe UI', Arial, sans-serif",
      titleWeight: '300',
      titleSize: '20px',
      titleSpacing: '4px',
      titleCase: 'uppercase',
      titleColor: '#e9dfcc',
      titleStyle: 'normal',
      // The small headings: .panel-label 1.3px, .kicker 1.6px, in capitals.
      labelSpacing: '1.4px',
      labelCase: 'uppercase',
      radius: '3px'
    },
    palette: {
      // Line 13: bg, panel, text, muted, primary. Borders: the panels' #454037 (worlds.css .horizon .directory).
      bg: '#080b12', panel: '#10151f', line: '#454037', ink: '#e9dfcc', caption: '#e9dfcc', muted: '#9b9386', accent: '#f6bf77',
      // world.js line 16: agent and tool primary, subagent and context secondary; MCP server as the main branch, secondary,
      // so the four floors go amber, cyan, amber, cyan from the top.
      cls: { agent: '#f6bf77', subagent: '#9de2e9', tool: '#f6bf77', resource: '#9de2e9', mcp: '#9de2e9' },
      // The marks only. failed: alert; needs: primary; working: text; unclear: secondary; idle: muted;
      // done: the darker amber of the time panel's border (.horizon .special, #726049).
      state: { needs: '#f6bf77', failed: '#ff6574', working: '#e9dfcc', unclear: '#9de2e9', idle: '#9b9386', done: '#726049' },
      clash: '#ff6574',
      // worlds.css .horizon .viewport: radial-gradient(ellipse at 50% 40%, #1a1a1d, #05080d 80%): a grey light above the
      // middle, dark edges.
      ground: { shape: 'round', at: [.5, .4], stops: [[0, '#1a1a1d'], [.8, '#05080d']] },
      // The original's engine.js line 75: a node's label is in the node's own colour (the selected one in the text colour).
      captionNode: true,
      // Wireframe, as the original drew it. captionHalo: its labels had a shadow of the background (blur 4).
      fill: 0, solid: 0, floorFill: 0, floorLine: .35, post: .3, captionBack: 0, captionHalo: .8
    },
    /** One clock for every class: radius 26 for the agent (the original's workspace and orchestrator), 14 for the rest. */
    mesh(key) {
      switch (key) {
        case 'agent': return clock(26, -1);
        case 'subagent': return clock(14);
        case 'tool': return clock(14);
        case 'mcp': return clock(18);
        case 'resource.file':
        case 'resource.url':
        case 'resource.context': return clock(14);
        case 'stack': return S.merge(clock(10), lift(clock(10), 22), lift(clock(10), 44));
      }
      throw new Error('Event Horizon look: no mesh for "' + key + '"');
    },
    /** The tunnel of rings, standing still, its axis along the monitor's first view so the rings stand inside each other. */
    backdrop(scene) {
      const { min, max } = scene.bounds;
      const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      const cy = Math.cos(E.CAMERA.yaw), sy = Math.sin(E.CAMERA.yaw), cp = Math.cos(E.CAMERA.pitch), sp = Math.sin(E.CAMERA.pitch);
      const d = [sy * cp, -sp, cy * cp], u = [cy, 0, -sy], v = [sy * sp, cp, cy * sp];     // into the view, right, up
      // The floors' half-size across the view: the original's tunnel (285) stood round a scene some 300 from its centre.
      let half = 0;
      for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
        const p = [x - c[0], y - c[1], z - c[2]];
        half = Math.max(half, Math.abs(p[0] * u[0] + p[1] * u[1] + p[2] * u[2]), Math.abs(p[0] * v[0] + p[1] * v[1] + p[2] * v[2]));
      }
      const k = Math.max(1, half / 300);
      const at = (t, a, r) => [0, 1, 2].map(i => c[i] + (Math.cos(a) * u[i] + Math.sin(a) * v[i]) * r * k + d[i] * t * k);
      const ring = (t, r, n) => { const out = []; for (let i = 0; i <= n; i++) out.push(at(t, i / n * Math.PI * 2, r)); return out; };
      // The source's rings stand every 120 in z; here from 750 in front of the present to 1,050 behind it.
      const near = [], mid = [], far = [], grey = [], long = [], streaks = [];
      for (let i = -5; i <= 10; i++) {
        const z = i * 120 - 150, off = Math.abs(z);
        (off < 400 ? near : off < 800 ? mid : far).push(ring(z, 285, 44));
        if (i % 2 === 0) grey.push(ring(z + 5, 290, 36));
        if (i < 10) for (let j = 0; j < 8; j++) { const a = j * Math.PI / 4; long.push([at(z, a, 285), at(z + 120, a, 285)]); }
      }
      for (let i = 0; i < 24; i++) { const a = i * .71, z = (i * 97) % 1600 - 800; streaks.push([at(z, a, 286), at(z + 15, a + .018, 286)]); }
      return [
        { lines: far, color: '#c68f50', alpha: .1, width: .8 },
        { lines: mid, color: '#c68f50', alpha: .2, width: .8 },
        { lines: near, color: '#c68f50', alpha: .34, width: .8 },
        { lines: grey, color: '#5b8d99', alpha: .14, width: .8 },
        { lines: long, color: '#8e7551', alpha: .16, width: .7 },
        { lines: streaks, color: '#9de2e9', alpha: .3, width: .5 },
        { lines: [ring(0, 299, 72)], color: '#9de2e9', alpha: .8, width: .8 },
        { lines: [ring(0, 307, 72)], color: '#9de2e9', alpha: .16, width: .8 },
        { text: 'PRESENT', at: at(0, Math.PI / 2, 280), color: '#9de2e9', alpha: .8, size: 11, align: 'center' },
        { text: 'PAST ←', at: at(0, Math.PI, 325), color: '#f6bf77', alpha: .7, size: 10, align: 'right' },
        { text: '→ CONSEQUENCE', at: at(0, 0, 325), color: '#f6bf77', alpha: .7, size: 10, align: 'left' }
      ];
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
