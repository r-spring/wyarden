/* Wyarden 3D monitor: the "Signal Terrain" look. Entridir's world 06, the system read as a landscape.
 *
 * Adapted from Entridir (the Entridir repository, GPL v3), commit 63197c31,
 * nexus-3d/ui-concepts/nexus-worlds-29d4d1/modes-horizon-terrain.js, world.js and worlds.css;
 * picture docs/monitor-3d/img/before/terrain.png.
 * Taken as they are: the panel, text, muted, primary, secondary and alert colours (modes-horizon-terrain.js line 45), the
 * one beacon mesh for every node (beacon(), line 41), which type takes the primary olive and which the secondary gold (world.js line 16), the height field
 * (height(), line 37) drawn as a wire grid every 45 in its three height colours, its contour lines at -25, 0, 25, 50 and 75,
 * the three region names and the north arrow (environment(), lines 53 to 64), and the page's colours and lettering
 * (worlds.css, the .terrain rules and the base rules).
 * Changed: the original's twelve types are given to the monitor's five classes (agent the tall olive beacon, as its
 * workspace, orchestrator and agent; subagent a short gold beacon; tool a short olive beacon; MCP server a short gold
 * beacon, as its main branch, so the floors go olive, gold, olive, gold; resource a short gold beacon, as its context).
 * The beacon's head is drawn a quarter larger, and the agent's stem is 30 where the original's was 42, so that its head
 * stays inside the legend's icon. The background is #0d2a26, the middle of the stage's gradient (#133c32 to #07191a),
 * which the contract cannot draw. CONTEXT RESERVE and the north arrow are moved in from the field's corner so they stay
 * on the monitor's stage. The landscape stands still and is worked out once:
 * the original moved it a little with the clock and worked it out again in every frame. It lies under the lowest floor and
 * grows with the floors; nodes do not stand on it. The red rings round blocked nodes are left out: a look is never told a
 * state, and a state is only a mark. The original coloured blocked and waiting nodes red and gold: here those are only
 * the colours of the marks.
 *
 * A look is palette, meshes, caption style and a still backdrop. It has no say in where a node stands. See LOOKS.md.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.MonitorEngine;
  const S = E.shapes;

  /** beacon(): a stem, a square of four points round it, and a tip. Lifted by 12 so its foot stands on y = 0. The head
   *  is drawn a quarter larger: at the monitor's distance the original's 7 wide head was a dot. */
  function beacon(h, dx) {
    const q = 1.25, r = 7 * q, x = dx || 0, top = h + 12, ring = top - 10 * q;
    return {
      vertices: [[x, 0, 0], [x, top, 0], [x - r, ring, 0], [x + r, ring, 0], [x, ring, -r], [x, ring, r], [x, top + 9 * q, 0]],
      lines: [[0, 1], [2, 4], [4, 3], [3, 5], [5, 2], [2, 6], [3, 6], [4, 6], [5, 6]]
    };
  }
  /** height(): a mountain, a ridge and a long swell, at time 0. */
  function height(x, z) {
    const mountain = 90 * Math.exp(-((x + 60) ** 2 + (z + 80) ** 2) / 55000), ridge = 55 * Math.exp(-((x - 290) ** 2 + (z + 40) ** 2) / 24000);
    return mountain + ridge + 19 * Math.sin(x * .009 + z * .004) + 12 * Math.cos(z * .013) - 42 + Math.sin(x * .003) * 3;
  }

  const look = {
    id: 'signal-terrain',
    name: 'Signal Terrain',
    theme: 'dark',
    // Neither rule: the original draws every node with the one beacon, in one of two colours.
    claims: {},
    // The original's labels are 8 px Consolas (engine.js); the page's text is --mono.
    font: "Consolas, 'Liberation Mono', monospace",
    lineWidth: 1,                                         // the original's edges: 1 px with a 3 px glow
    glow: true,
    caption: text => text.toUpperCase(),
    page: {
      ui: "Consolas, 'Liberation Mono', monospace",
      headFont: "Consolas, 'Liberation Mono', monospace",
      // The world's title: .terrain .world-title h1, italic 42px Georgia, -1px apart, in cream. The bar holds 20 px at most.
      titleFont: "Georgia, 'Times New Roman', serif",
      titleStyle: 'italic',
      titleWeight: '400',
      titleSize: '20px',
      titleSpacing: '-0.5px',
      titleCase: 'none',
      titleColor: '#e3d5a9',
      // The small headings: .panel-label 1.3px, .kicker 1.6px, in capitals.
      labelSpacing: '1.4px',
      labelCase: 'uppercase',
      radius: '3px'
    },
    palette: {
      // bg: the stage's ground, the middle of its gradient (worlds.css .terrain .viewport, #133c32 to #07191a); line 45 gives
      // panel, text, muted and primary. Borders: the panels' #344b38 (worlds.css .terrain .directory).
      bg: '#0d2a26', panel: '#0b2423', line: '#344b38', ink: '#e7dbb8', caption: '#e7dbb8', muted: '#94a58b', accent: '#bacf88',
      // world.js line 16: agent and tool primary, subagent and context secondary; MCP server as the main branch, secondary,
      // so the four floors go olive, gold, olive, gold from the top.
      cls: { agent: '#bacf88', subagent: '#e0b96e', tool: '#bacf88', resource: '#e0b96e', mcp: '#e0b96e' },
      // The marks only. failed: alert; needs: secondary; working: text; unclear: the region names' green (#a3bc89);
      // idle: muted; done: the pressed lens button's border (.terrain .lens-row, #6b7b4d).
      state: { needs: '#e0b96e', failed: '#ff785e', working: '#e7dbb8', unclear: '#a3bc89', idle: '#94a58b', done: '#6b7b4d' },
      clash: '#ff785e',
      // Wireframe, as the original drew it. captionHalo: its labels had a shadow of the background (blur 4).
      fill: 0, solid: 0, floorFill: 0, floorLine: .35, post: .3, captionBack: 0, captionHalo: .8
    },
    /** One beacon for every class: tall for the agent (the original's workspace, orchestrator and agent: 42), 25 for the rest.
     *  The agent's stem is 30 here, so its head stays inside the 64 px icon of the legend and the inspector. */
    mesh(key) {
      switch (key) {
        case 'agent': return beacon(30);
        case 'subagent':
        case 'tool':
        case 'mcp':
        case 'resource.file':
        case 'resource.url':
        case 'resource.context': return beacon(25);
        case 'stack': return S.merge(beacon(14, -18), beacon(20), beacon(14, 18));
      }
      throw new Error('Signal Terrain look: no mesh for "' + key + '"');
    },
    /** The landscape: the height field as a wire grid in three colours, its contours, three region names, a north arrow. */
    backdrop(scene) {
      const { min, max } = scene.bounds, cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
      // The source's field is 990 square round a scene some 600 across; here it grows with the floors.
      const k = Math.max(1, (Math.max(max[0] - min[0], max[2] - min[2]) + 400) / 990);
      const base = min[1] - 30 - 80 * k;                    // its highest point (about 80) stays under the lowest floor
      const P = (x, z, y) => [cx + x * k, base + (y == null ? height(x, z) : y) * k, cz + z * k];
      const step = 45, lo = -495, hi = 495, high = [], mid = [], low = [], contours = [];
      for (let x = lo; x < hi; x += step) for (let z = lo; z < hi; z += step) {
        const y = height(x, z), list = y > 35 ? high : y > 0 ? mid : low;
        list.push([P(x, z), P(x + step, z)], [P(x, z), P(x, z + step)]);
      }
      // Contour crossings: where a level cuts a cell's sides, a line across the cell.
      for (const level of [-25, 0, 25, 50, 75]) for (let x = -450; x < 450; x += step) for (let z = -450; z < 450; z += step) {
        const corners = [[x, z], [x + step, z], [x + step, z + step], [x, z + step]], cross = [];
        for (let i = 0; i < 4; i++) {
          const a = corners[i], b = corners[(i + 1) % 4], ha = height(a[0], a[1]), hb = height(b[0], b[1]);
          if ((ha < level && hb >= level) || (hb < level && ha >= level)) { const t = (level - ha) / (hb - ha); cross.push(P(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, level + .3)); }
        }
        if (cross.length === 2) contours.push(cross);
      }
      const name = (text, x, z, lift, color, alpha) => ({ text, at: P(x, z, height(x, z) + lift), color, alpha, size: 10, align: 'center' });
      // The north arrow, moved in from the field's corner (-450, -400) so it stays on the monitor's stage.
      const ax = -400, az = -180, tip = P(ax, az - 25, 0);
      return [
        { lines: low, color: '#4c7c70', alpha: .24, width: .65 },
        { lines: mid, color: '#a6bc7e', alpha: .24, width: .65 },
        { lines: high, color: '#d9bc78', alpha: .24, width: .65 },
        { lines: contours, color: '#d4c88e', alpha: .28, width: .9 },
        { lines: [[P(ax, az + 25, 0), tip], [P(ax - 8, az - 10, 0), tip, P(ax + 8, az - 10, 0)]], color: '#e0b96e', alpha: .8, width: 1 },
        { text: 'N', at: P(ax, az - 45, 8), color: '#e0b96e', alpha: .8, size: 12, align: 'center' },
        name('CONTEXT RESERVE', -300, -260, 10, '#a3bc89', .75),
        name('DELIVERY RIDGE', 305, 10, 8, '#e0b96e', .7),
        name('CAPABILITY BASIN', -10, 340, 9, '#a3bc89', .7)
      ];
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
