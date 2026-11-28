/* A look for the tests only: it uses every knob of the contract (LOOKS.md), each at a value that
 * can be told from the default, and a backdrop that fills the engine's limits exactly. It is not in
 * media/, so it is not in the VSIX and not in the switcher; the looks test loads it into the page.
 * It is not meant to look good.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('../../../media/engine.js') : root.MonitorEngine;
  const S = E.shapes, B = E.BACKDROP;
  const FALLBACK = { bg: '#f4efe6', ink: '#1b1b1b' };

  const look = {
    id: 'every-knob',
    name: 'Every knob',
    theme: 'light',
    claims: {},                                    // one shape for two classes below: it claims nothing
    font: "Georgia, 'Times New Roman', serif",
    lineWidth: 2,
    glow: false,
    captionSize: 15,
    caption: text => text,
    palette: {
      bg: FALLBACK.bg, panel: '#20262e', line: '#8a8f98', ink: FALLBACK.ink, caption: '#2a2a2a', muted: '#5c5c5c', accent: '#c2410c',
      cls: { agent: '#0f766e', subagent: '#0f766e', tool: '#b45309', resource: '#1d4ed8', mcp: '#be123c' },
      state: { needs: '#b45309', failed: '#be123c', working: '#1b1b1b', unclear: '#5c5c5c', idle: '#5c5c5c', done: '#8a8f98' },
      clash: '#be123c',
      outline: '#101418',                          // every edge in one dark ink, over a fill in the class's colour
      fill: .85, solid: 1, floorFill: .05, floorLine: .5, post: .4, captionBack: 0, captionHalo: .9
    },
    page: {
      ui: "Georgia, 'Times New Roman', serif", titleFont: "Georgia, 'Times New Roman', serif", titleStyle: 'italic', titleWeight: '400', titleSize: '19px',
      titleSpacing: '1px', titleCase: 'none', titleColor: '#f59e0b', titleShadow: '0 0 6px #f59e0b', headFont: "Georgia, 'Times New Roman', serif",
      labelFont: "Consolas, 'Courier New', monospace", labelSpacing: '2px', labelCase: 'none', radius: '11px',
      panelInk: '#f8fafc', panelText: '#d7dde5', panelMuted: '#9aa4b2', panelLine: '#475569', panelAccent: '#f59e0b',
      notAKey: 'ignored'
    },
    // Sets of the editor's variables to be photographed under (tools/shoot-looks.js), and that the test tries fromPage with.
    samples: { dark: { '--vscode-editor-background': '#1e1e1e', '--vscode-editor-foreground': '#d4d4d4' } },
    /** Colours from the page, each time the look is applied: the editor's background and foreground, else the fixed ones. */
    fromPage(read) {
      this.palette.bg = read('--vscode-editor-background', FALLBACK.bg);
      this.palette.ink = read('--vscode-editor-foreground', FALLBACK.ink);
    },
    /** Exactly the limits: B.segments segments in B.styles - 2 paths (half of them dashed), B.dots dots in 2, B.texts texts. */
    backdrop(scene) {
      const { min, max } = scene.bounds, items = [], paths = B.styles - 2, per = B.segments / paths, rand = E.seeded(11);
      for (let p = 0; p < paths; p++) {
        const lines = [];
        for (let i = 0; i < per; i++) {
          const x = min[0] + (max[0] - min[0]) * (i / per), z = min[2] + (max[2] - min[2]) * (p / paths);
          lines.push([[x, -40 - p * 6, z], [x + 30, -40 - p * 6, z + 180]]);
        }
        items.push({ lines, color: p % 2 ? '#1d4ed8' : '#0f766e', alpha: .35, width: p % 3 ? 1 : 2, dash: p % 2 ? [6, 5] : undefined });
      }
      for (let d = 0; d < 2; d++) {
        const dots = [];
        for (let i = 0; i < B.dots / 2; i++) dots.push([min[0] + (max[0] - min[0]) * rand(), max[1] + 200 * rand(), min[2] + (max[2] - min[2]) * rand()]);
        items.push({ dots, color: '#b45309', alpha: .6, size: 1 + d });
      }
      for (let t = 0; t < B.texts; t++) items.push({ text: 'DISTRICT ' + (t + 1), at: [min[0] + (max[0] - min[0]) * (t / B.texts), -60, min[2] - 40], color: '#5c5c5c', alpha: .8, size: 9 });
      return items;
    },
    mesh(key) {
      const flat = (sides, r, y, turn) => S.polygon(S.ring(r, sides, 'xy', y).vertices.map(v => { const a = turn || 0; return [v[0] * Math.cos(a) - (v[1] - y) * Math.sin(a), y + v[0] * Math.sin(a) + (v[1] - y) * Math.cos(a), 0]; }));
      switch (key) {
        case 'agent': return flat(3, 18, 20, Math.PI / 2);                       // a solid upright triangle
        case 'subagent': return flat(3, 10, 12, Math.PI / 2);
        case 'tool': return Object.assign(S.merge(S.path([[-10, 2, 0], [10, 22, 0]]), S.path([[-10, 22, 0], [10, 2, 0]])), { faces: [] });      // a cross: two strokes, nothing filled
        case 'mcp': return flat(24, 14, 16);                                     // a disc
        case 'resource.file': return flat(4, 12, 14, Math.PI / 4);               // a square
        case 'resource.url': return flat(4, 12, 14);                             // a diamond
        case 'resource.context': return flat(12, 5, 7);                          // a dot
        case 'stack': return S.merge(S.box(24, 2, 18), S.box(24, 2, 18, 5), S.box(24, 2, 18, 10));
      }
      throw new Error('every-knob look: no mesh for "' + key + '"');
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
