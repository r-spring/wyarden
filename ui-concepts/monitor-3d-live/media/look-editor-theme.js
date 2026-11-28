/* Wyarden 3D monitor: the "Editor theme" look. The Entomatical board's own skin (F52): no colours of its own.
 *
 * Adapted from the Entomatical repository (GPL v3, the same owner), media/board.css as it stood in this repository at
 * commit 0a8c20c (git show 0a8c20c:media/board.css): lines 1 to 33 (the tokens, the status colours, the provider colours
 * and their light-theme shades), lines 132 to 147 (a card's status stripe and provider edge) and lines 275 to 283 (chips).
 * The meshes are the plain wireframes of look-nexus.js, which adapts them from Entridir (GPL v3), commit 63197c31,
 * nexus-3d/ui-concepts/nexus-lattice-29d4d1/scene.js.
 *
 * Taken as they are: every colour is the editor's theme variable that board.css reads (--vscode-foreground for text,
 * --vscode-descriptionForeground for quiet text, --vscode-widget-border then --vscode-panel-border for lines,
 * --vscode-editorWidget-background for a card's surface, --vscode-font-family for the lettering, the --vscode-charts-*
 * colours for status), with board.css's own fall-backs (#3794ff, #d18616, #89d185); the four provider colours and their
 * light-theme shades (lines 22 and 29); 4 px corners (--radius); no glow; thin lines.
 * Changed: a flat page gives no shapes, so the shapes are NEXUS's wireframes. The board coloured cards by status: here
 * the status colours are the marks' colours (running blue for working, needs input orange for needs, queued's quiet
 * text for idle and unclear, done's disabled text for done), and the classes take the other --vscode-charts-* colours: agent blue, subagent purple,
 * tool yellow, MCP server orange, resource the quiet text colour (as the board's queued cards and chips). Agents and
 * subagents take their provider's colour, as a card's 2 px top edge does. Light or dark is worked out from the editor's
 * background, because a look reads variables only, not the body's vscode-light class. The lines' last fall-back is a
 * real grey instead of board.css's `transparent`, so the floors still show. The editor background is the backdrop:
 * nothing is drawn behind the floors. Fall-backs that board.css does not name are VS Code's default dark and light
 * theme values, from memory.
 *
 * A look is palette, meshes and caption style. It has no say in where a node stands. See LOOKS.md.
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.MonitorEngine;
  const S = E.shapes;

  /** The fixed fall-backs: board.css's own where it names one, else VS Code's default dark and light themes. */
  const FALL = {
    dark: {
      bg: '#1e1e1e', fg: '#cccccc', ink: '#d4d4d4', muted: '#9d9d9d', disabled: '#8b8b8b', line: '#454545', surface: '#252526',
      focus: '#007fd4', error: '#f48771', font: "'Segoe WPC', 'Segoe UI', system-ui, sans-serif",
      blue: '#3794ff', orange: '#d18616', green: '#89d185', yellow: '#cca700', purple: '#b180d7', red: '#f14c4c'
    },
    light: {
      bg: '#ffffff', fg: '#616161', ink: '#3b3b3b', muted: '#717171', disabled: '#8b8b8b', line: '#c8c8c8', surface: '#f3f3f3',
      focus: '#0090f1', error: '#a1260d', font: "'Segoe WPC', 'Segoe UI', system-ui, sans-serif",
      blue: '#1a85ff', orange: '#d18616', green: '#388a34', yellow: '#bf8803', purple: '#652d90', red: '#e51400'
    }
  };
  /** board.css lines 22 and 29: the provider colours, and their darker shades on light themes. */
  const PROVIDER = {
    dark: { claude: '#d97757', codex: '#4fa8ff', grok: '#3fa95a', antigravity: '#b392f0' },
    light: { claude: '#b5512a', codex: '#0069a8', grok: '#1a7f37', antigravity: '#7e4fc9' }
  };

  /** Relative luminance of a CSS colour (#rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba()), or null when it cannot be read. */
  function luminance(text) {
    const s = String(text || '').trim().toLowerCase();
    let rgb = null, m;
    if ((m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s))) {
      const h = m[1].length <= 4 ? m[1].split('').map(c => c + c).join('') : m[1];
      rgb = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    } else if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s))) rgb = [m[1], m[2], m[3]].map(Number);
    if (!rgb || !rgb.every(Number.isFinite)) return null;
    const lin = v => { const c = Math.min(255, v) / 255; return c <= .03928 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4); };
    return .2126 * lin(rgb[0]) + .7152 * lin(rgb[1]) + .0722 * lin(rgb[2]);
  }

  /** The whole look from the editor's variables: every value from `read` and the constants, never from what was there before. */
  function build(read) {
    const bg = read('--vscode-editor-background', FALL.dark.bg), lum = luminance(bg);
    const kind = lum !== null && lum > .45 ? 'light' : 'dark', f = FALL[kind];
    const fg = read('--vscode-foreground', f.fg), muted = read('--vscode-descriptionForeground', f.muted);
    const chart = name => read('--vscode-charts-' + name, f[name]);
    const line = read('--vscode-widget-border', read('--vscode-panel-border', read('--vscode-contrastBorder', f.line)));
    const font = read('--vscode-font-family', f.font);
    return {
      theme: kind,
      font,
      palette: {
        bg, panel: read('--vscode-editorWidget-background', f.surface), line,
        ink: read('--vscode-editor-foreground', f.ink), caption: fg, muted, accent: read('--vscode-focusBorder', f.focus),
        cls: { agent: chart('blue'), subagent: chart('purple'), tool: chart('yellow'), resource: muted, mcp: chart('orange') },
        provider: Object.assign({}, PROVIDER[kind]),
        // The floor agents stand on: the text colour, so that no provider's colour runs into it.
        floor: { agent: fg },
        // board.css lines 17 to 21: running blue, needs input orange, queued the quiet text, done the disabled text.
        state: {
          needs: chart('orange'), failed: read('--vscode-errorForeground', f.error), working: chart('blue'),
          unclear: muted, idle: muted, done: read('--vscode-disabledForeground', f.disabled)
        },
        clash: read('--vscode-errorForeground', f.error),
        fill: .06, solid: .9, floorFill: 0, floorLine: .5, post: .4, captionBack: 0, captionHalo: .85
      },
      page: {
        ui: font, headFont: font, titleFont: font, titleStyle: 'normal', titleWeight: '600', titleSize: '13px',
        titleSpacing: '0px', titleCase: 'none', titleColor: fg, labelSpacing: '0px', labelCase: 'none', radius: '4px'
      }
    };
  }
  const start = build((name, fallback) => fallback);

  const look = {
    id: 'editor-theme',
    name: 'Editor theme',
    theme: start.theme,
    // Five classes in five chart colours with NEXUS's five silhouettes; the board's four provider colours.
    claims: { classes: true, providers: true },
    font: start.font,
    lineWidth: 1,                        // the board's 1 px borders
    glow: false,
    captionSize: 11,                     // --fs-small
    caption: text => text,               // the board keeps the text's own case
    palette: start.palette,
    page: start.page,
    // Sets of the editor's variables, from memory: VS Code's Dark Modern and Light Modern themes.
    samples: {
      dark: {
        '--vscode-editor-background': '#1f1f1f', '--vscode-editor-foreground': '#cccccc', '--vscode-foreground': '#cccccc',
        '--vscode-descriptionForeground': '#9d9d9d', '--vscode-disabledForeground': '#cccccc80', '--vscode-widget-border': '#313131',
        '--vscode-panel-border': '#2b2b2b', '--vscode-editorWidget-background': '#202020', '--vscode-focusBorder': '#0078d4',
        '--vscode-errorForeground': '#f85149', '--vscode-font-family': '"Segoe WPC", "Segoe UI", sans-serif',
        '--vscode-charts-blue': '#3794ff', '--vscode-charts-orange': '#d18616', '--vscode-charts-green': '#89d185',
        '--vscode-charts-yellow': '#cca700', '--vscode-charts-purple': '#b180d7', '--vscode-charts-red': '#f14c4c'
      },
      light: {
        '--vscode-editor-background': '#ffffff', '--vscode-editor-foreground': '#3b3b3b', '--vscode-foreground': '#3b3b3b',
        '--vscode-descriptionForeground': '#3b3b3b', '--vscode-disabledForeground': '#8f8f8f', '--vscode-widget-border': '#e5e5e5',
        '--vscode-panel-border': '#e5e5e5', '--vscode-editorWidget-background': '#f8f8f8', '--vscode-focusBorder': '#005fb8',
        '--vscode-errorForeground': '#f85149', '--vscode-font-family': '"Segoe WPC", "Segoe UI", sans-serif',
        '--vscode-charts-blue': '#1a85ff', '--vscode-charts-orange': '#d18616', '--vscode-charts-green': '#388a34',
        '--vscode-charts-yellow': '#bf8803', '--vscode-charts-purple': '#652d90', '--vscode-charts-red': '#e51400'
      }
    },
    /** The editor's colours and font, each time the look is applied and when the editor's theme changes. */
    fromPage(read) {
      const now = build(read);
      this.theme = now.theme; this.font = now.font; this.palette = now.palette; this.page = now.page;
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
      throw new Error('Editor theme look: no mesh for "' + key + '"');
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = look;
  else { root.MonitorLooks = root.MonitorLooks || {}; root.MonitorLooks[look.id] = look; }
})(typeof window === 'undefined' ? globalThis : window);
