/* Wyarden 3D monitor: the "Control Room" look. A wall chart: black, flat heavy solid marks, large lettering,
 * thin grey rules, small capitals with a coloured bar.
 *
 * Adapted from Entridir (the Entridir repository, GPL v3), commit 63197c31,
 * godot/looks/control_room.gd (palette lines 39-66: the ground, panels, rules, text and the colours chosen to
 * stay apart for colour-blind eyes; draw() lines 158-181: thin grey rules round the chart and a 3 px bar of colour
 * under every heading; shape() lines 191-205: flat solid tokens, the workspace a hexagon; fonts lines 22-28);
 * picture docs/verification/godot-looks/looks.png, lower right quarter.
 * Kept: the hex values; flat, solid marks standing upright like the chart's; heavy edges; a large semibold
 * caption in white; the rules in #383835; a coloured bar under each heading; Segoe UI Semibold for the page, Segoe UI Black for the title, 2 px corners.
 * Changed:
 * - The original coloured a mark by its state (amber needs you, red stalled, blue working, green ready for review,
 *   grey unclear and idle, violet queued). Here those colours are the classes': an agent amber, a subagent violet,
 *   a tool green, an MCP server blue, a resource grey. A state is only the mark beside the shape and the word in
 *   the caption. The marks keep clear of those five: white for needs you and working, the original's red for failed,
 *   its dark grey for the quiet ones.
 * - The original's marks were state marks too (triangle, cross, disc, diamond, square, dot). The monitor's state
 *   marks are a pyramid, a cross, a globe, a diamond, an hourglass and a dot, so a class takes none of those: the
 *   agent the original's hexagon (its workspace marker), a subagent the same hexagon hollow, a tool the original's
 *   square, an MCP server a heading bar on its stem, a resource a page, a frame or lines of text.
 * - The arrangement is not carried: the four floors and the columns stay; the chart's rows and state columns do
 *   not. The original's large figures over its columns were counts of a state, and the scene a backdrop is given
 *   carries no column number, so there is no figure. The amber and red washes behind the original's urgent columns
 *   stood for states and are left out.
 * - The backdrop is the chart's ruling, column by column: a thin grey rule along the front and back of every floor,
 *   one at each side of the column from the lowest floor to above the highest, and a coloured bar at its top (amber
 *   over a session's column, blue and the word MCP over the servers'). Nothing moves.
 * - Flat marks stand in the xy plane: the view turns, they do not, so a mark seen from the side is thin.
 *
 * A look is palette, meshes, lettering and a still backdrop. It has no say in where a node stands. See LOOKS.md.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.MonitorEngine;
  const S = E.shapes;

  // control_room.gd, palette (lines 39-66).
  const O = {
    bg: '#0b0b0c', panel: '#121214', rule: '#383835', white: '#f0efec', title: '#ffffff', muted: '#a3a299',
    amber: '#fab219', red: '#e66767', blue: '#3987e5', green: '#0ca30c', grey: '#c3c2b7', violet: '#9d8cf0', idle: '#6e6d68',
    redText: '#f08a8a'
  };

  /** A flat polygon standing upright, facing the camera, in the xy plane: corners as [x, y]. */
  const flat = corners => S.polygon(corners.map(([x, y]) => [x, y, 0]));
  /** The same outline, hollow: two heavy strokes and no fill. */
  const hollow = corners => Object.assign(S.path(corners.map(([x, y]) => [x, y, 0]), true), { faces: [] });
  const hexagon = (r, cy) => Array.from({ length: 6 }, (_, i) => { const a = i / 6 * Math.PI * 2 + Math.PI / 6; return [Math.cos(a) * r, cy + Math.sin(a) * r]; });
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

  const look = {
    id: 'control-room',
    name: 'Control Room',
    theme: 'dark',
    // Five colours, one for each class, and five silhouettes.
    claims: { classes: true },
    font: "'Segoe UI Semibold', 'Segoe UI', Inter, 'Noto Sans', sans-serif",
    lineWidth: 2.4,                                  // heavy marks
    glow: false,
    caption: text => text,
    captionSize: 14,                                 // large lettering: the original's selected caption, 14
    palette: {
      bg: O.bg, panel: O.panel, line: O.rule, ink: O.title, caption: O.white, muted: O.muted, accent: O.blue,
      cls: { agent: O.amber, subagent: O.violet, tool: O.green, mcp: O.blue, resource: O.grey },
      state: { needs: O.title, failed: O.red, working: O.white, unclear: O.idle, idle: O.idle, done: O.idle },
      clash: O.redText,
      fill: .95, solid: 1, floorFill: 0, floorLine: .45, post: .5, captionBack: 0, captionHalo: .9
    },
    page: {
      ui: "'Segoe UI Semibold', 'Segoe UI', Inter, 'Noto Sans', sans-serif",
      headFont: "'Segoe UI Semibold', 'Segoe UI', Inter, 'Noto Sans', sans-serif",
      titleFont: "'Segoe UI Black', 'Arial Black', 'Segoe UI', Inter, sans-serif",
      titleStyle: 'normal', titleWeight: '800', titleSize: '20px', titleSpacing: '.5px', titleCase: 'uppercase', titleColor: O.title,
      labelSpacing: '1px', labelCase: 'uppercase', radius: '2px'
    },
    /** Flat solid marks, upright like the wall chart's, none of them a state's mark. */
    mesh(key) {
      switch (key) {
        case 'agent': return flat(hexagon(21, 22));                                            // the original's hexagon
        case 'subagent': return hollow(hexagon(12, 13));                                       // the same, small and hollow
        case 'tool': return flat(rect(-12, 0, 12, 24));                                        // the original's square
        case 'mcp': return flat([[-22, 30], [22, 30], [22, 22], [5, 22], [5, 0], [-5, 0], [-5, 22], [-22, 22]]);   // a heading bar on its stem
        case 'resource.file': return flat([[-9, 0], [9, 0], [9, 18], [3, 24], [-9, 24]]);    // a page, its corner turned
        case 'resource.url': return hollow(rect(-10, 0, 10, 20));                              // a frame
        case 'resource.context': return S.merge(flat(rect(-12, 17, 12, 22)), flat(rect(-12, 9, 12, 14)), flat(rect(-12, 1, 4, 6)));   // lines of text
        case 'stack': return S.merge(flat(rect(-14, 0, 14, 3)), flat(rect(-14, 6, 14, 9)), flat(rect(-14, 12, 14, 15)));
      }
      throw new Error('Control Room look: no mesh for "' + key + '"');
    },
    /** The chart's ruling, column by column: grey rules along every floor and at each side, a coloured bar on top. */
    backdrop(scene) {
      const ys = Object.values(scene.floors), low = Math.min(...ys), high = Math.max(...ys), top = high + 230;
      const rules = [], bars = { agent: [], mcp: [] }, items = [];
      for (const col of scene.columns) {
        const a = col.x - scene.pitch / 2, b = col.x + scene.pitch / 2, front = col.z - col.half, back = col.z + col.half;
        for (const y of ys) for (const z of [front, back]) rules.push([[a, y, z], [b, y, z]]);
        rules.push([[a, low, front], [a, top, front]], [[b, low, front], [b, top, front]], [[a, top, front], [b, top, front]]);
        const h = col.half * .9;
        (col.dock ? bars.mcp : bars.agent).push([[col.x - h, top - 6, front], [col.x + h, top - 6, front]]);
        if (col.dock) items.push({ text: 'MCP', at: [col.x, top + 6, front], color: O.blue, alpha: 1, size: 11, align: 'center' });
      }
      items.unshift({ lines: rules, color: O.rule, alpha: .9, width: 1 });
      if (bars.agent.length) items.push({ lines: bars.agent, color: O.amber, alpha: .95, width: 3 });
      if (bars.mcp.length) items.push({ lines: bars.mcp, color: O.blue, alpha: .95, width: 3 });
      return items;
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
