/* Wyarden 3D monitor: the "Skyline" look. Light, a little warm; solid blocks and towers outlined in dark ink.
 *
 * Adapted from Entridir (the Entridir repository, GPL v3), commit 63197c31,
 * godot/looks/skyline.gd (palette lines 41-71: ground, panels, ink, captions, the four colours; draw() lines
 * 156-172: the white blocks outlined in ink with faint plot lines; shape() lines 182-208: towers with roofs, every
 * edge in ink; the kiosk, a hexagon) and its fonts (lines 24-30); picture docs/verification/godot-looks/looks.png,
 * lower left quarter.
 * Kept: the hex values; every shape solid in its colour and outlined in the ink #1d2b2e; towers with pointed
 * roofs in amber, red and blue; a field of teal-green glass blocks; low grey blocks; the floors outlined in ink with
 * faint plot lines; dark ink captions at 12 px on a pale halo; Segoe UI for the page, Bahnschrift 600 for the title,
 * 4 px corners.
 * Changed:
 * - The original coloured a tower by its state (amber needs you, red stalled, blue working, green ready for
 *   review, grey idle). Here those colours are the classes': an agent is the tall amber tower, an MCP server the red
 *   hexagonal one (the original's kiosk is a hexagon), a subagent the shorter blue tower, a tool the teal-green
 *   block, a resource a low pale grey block (the original's idle grey). A state is only the mark beside the shape
 *   and the word in the caption; the marks keep clear of the five class colours: the original's violet for needs you,
 *   its ink for failed, its dark title teal for working, its slate for the quiet ones.
 * - The arrangement is not carried: the four floors and the columns stay. A tower's height and roof no longer
 *   follow its state; each class has one.
 * - The original's slabs are white over the ground; a floor here has one colour for its tint and its outline, so
 *   the slab is the ground's colour with an ink outline. A shape has one
 *   fill, so the original's solid roof over tinted glass walls is one even tint, at .6.
 * - The backdrop is the street round the blocks: a kerb round each column's ground block and the street's centre
 *   line, in faint ink. Nothing moves.
 *
 * A look is palette, meshes, lettering and a still backdrop. It has no say in where a node stands. See LOOKS.md.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.MonitorEngine;
  const S = E.shapes;

  // skyline.gd, palette (lines 41-71).
  const O = {
    bg: '#f3f1ea', panel: '#f8f7f2', line: '#cfd2c8', text: '#16262a', title: '#0f3a40', muted: '#586b6c',
    teal: '#1f7a84', ink: '#1d2b2e',
    amber: '#eda100', red: '#e34948', blue: '#2a78d6', green: '#1baf7a', violet: '#7b61d9', idle: '#b5b4ac', clash: '#d03b3b'
  };

  /** A square tower with a pointed roof: the original's tower with its pyramid roof. */
  const tower = (side, h, roof) => S.merge(S.box(side, h, side), S.pyramid(4, side / Math.SQRT2, roof, h, Math.PI / 4));

  const look = {
    id: 'skyline',
    name: 'Skyline',
    theme: 'light',
    // Five colours, one for each class, and five silhouettes.
    claims: { classes: true },
    font: "'Segoe UI', Inter, 'Noto Sans', 'DejaVu Sans', sans-serif",
    lineWidth: 1.2,                                  // the original's outline: 1.0 on walls, 1.2 round a roof
    glow: false,
    caption: text => text,                           // the original writes names as they are
    captionSize: 12,                                 // caption_size 12
    palette: {
      bg: O.bg, panel: O.panel, line: O.line, ink: O.text, caption: O.text, muted: O.muted, accent: O.teal,
      cls: { agent: O.amber, subagent: O.blue, tool: O.green, mcp: O.red, resource: O.idle },
      // Every floor in ink: the outline of the original's blocks (draw(), 0.55 ink).
      floor: { agent: O.ink, mcp: O.ink, tool: O.ink, resource: O.ink },
      // The marks: colours no class has. Needs you the original's violet, failed its ink, working its title teal.
      state: { needs: O.violet, failed: O.ink, working: O.title, unclear: O.muted, idle: O.muted, done: O.muted },
      clash: O.clash,
      // skyline.gd line 44: stage_inner #fbfaf6 to stage_outer #e4e2d8 round stage_center (0.5, 0.45), stage_reach 0.95.
      // The reach is taken as the place of the outer colour, as synapse.gd's 0.75 is the 75% of its page's own gradient.
      ground: { shape: 'round', at: [.5, .45], stops: [[0, '#fbfaf6'], [.95, '#e4e2d8']] },
      outline: O.ink,
      fill: .6, solid: 1, floorFill: 0, floorLine: .6, post: .35, captionBack: 0, captionHalo: .9
    },
    page: {
      ui: "'Segoe UI', Inter, 'Noto Sans', 'DejaVu Sans', sans-serif",
      headFont: "'Segoe UI', Inter, 'Noto Sans', 'DejaVu Sans', sans-serif",
      titleFont: "Bahnschrift, 'DIN Alternate', 'Segoe UI Semibold', 'DejaVu Sans Condensed', sans-serif",
      titleStyle: 'normal', titleWeight: '600', titleSize: '20px', titleSpacing: '0px', titleCase: 'none', titleColor: O.title,
      labelSpacing: '.6px', labelCase: 'uppercase', radius: '4px'
    },
    /** Towers for agents, subagents and MCP servers; the glass block for a tool; low blocks for resources. */
    mesh(key) {
      switch (key) {
        case 'agent': return tower(28, 56, 22);                                                // the tall amber tower, 78 high
        case 'subagent': return tower(18, 28, 12);                                             // a shorter tower
        case 'mcp': return S.merge(S.prism(6, 15, 34), S.pyramid(6, 15, 14, 34));              // the kiosk's hexagon, as a tower
        case 'tool': return S.box(26, 26, 26);                                                 // the glass block
        case 'resource.file': return S.box(20, 9, 28);                                         // the low grey block
        case 'resource.url': return S.prism(8, 13, 11);
        case 'resource.context': return S.merge(S.box(26, 6, 20), S.box(16, 6, 12, 6));
        case 'stack': return S.merge(S.box(26, 3, 20), S.box(26, 3, 20, 5), S.box(26, 3, 20, 10));
      }
      throw new Error('Skyline look: no mesh for "' + key + '"');
    },
    /** The street: a kerb round each column's ground block, and the street's centre line between blocks. */
    backdrop(scene) {
      const y = -2, kerb = 22;
      const rect = (ax, az, bx, bz) => [[ax, y, az], [bx, y, az], [bx, y, bz], [ax, y, bz], [ax, y, az]];
      const kerbs = [];
      for (const col of scene.columns) {
        const h = col.half + kerb;
        kerbs.push(rect(col.x - h, col.z - h, col.x + h, col.z + h));
      }
      const { min, max } = scene.bounds, m = 70;
      const x0 = min[0] - m, x1 = max[0] + m, z0 = min[2] - m, z1 = max[2] + m;
      const centre = [];
      const xs = [...new Set(scene.columns.map(c => c.x))].sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) { const x = (xs[i - 1] + xs[i]) / 2; centre.push([[x, y, z0], [x, y, z1]]); }
      const zs = [...new Set(scene.columns.map(c => c.z))].sort((a, b) => a - b);
      for (let i = 1; i < zs.length; i++) { const z = (zs[i - 1] + zs[i]) / 2; centre.push([[x0, y, z], [x1, y, z]]); }
      return [
        { lines: kerbs, color: O.ink, alpha: .22, width: 1 },
        { lines: centre, color: O.ink, alpha: .14, width: 1, dash: [6, 6] },
        { lines: [rect(x0, z0, x1, z1)], color: O.ink, alpha: .1, width: 1 }
      ];
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
