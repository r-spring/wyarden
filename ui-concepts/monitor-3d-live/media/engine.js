/* Monitor 3D mock-up: the renderer, shared by every look.
 *
 * Adapted from the Entridir repository (GPL v3), commit 63197c31,
 * nexus-3d/ui-concepts/nexus-lattice-29d4d1/scene.js: the hand-written perspective projection
 * (`project`), the arched edge (`arch`) and the pointer, wheel and pinch handling in `bind`.
 * Changed: there is no frame loop. A frame is drawn when data, selection, hover, camera or size
 * changes, and never otherwise. Layout, picking, captions, state marks and the look contract are new.
 *
 * A look (look-*.js) supplies palette, meshes and caption style, and may add an outline colour, a
 * caption size and a still backdrop behind the floors (LOOKS.md lists everything). It is never asked
 * where anything goes, so switching looks cannot move a node; and it is never told a state or a time.
 */
(function (root) {
  'use strict';
  const inNode = typeof module !== 'undefined' && module.exports;
  const L = inNode ? require('./layout.js') : root.MonitorLayout;
  const M = inNode ? require('./model.js') : root.MonitorModel;
  const TAU = Math.PI * 2, NO_DASH = [];
  const DATA_GAP = 100;        // ms between two frames caused by data: at most 10 a second
  const GLOW_MS = 600;         // how long an ended call stays visible as a thin trace
  const MIN_HIT = 8;           // px: a node smaller than this can still be clicked
  const MAX_GROWTH = .8;       // the most a resource grows: 1.8 times, which still fits its slot
  const CAMERA = { yaw: -0.42, pitch: 0.36, distance: 1800, target: [375, 250, 0] };
  const PHI = (1 + Math.sqrt(5)) / 2;
  /* What each provider's agent is called in the scene. An agent and its subagents take their provider's colour
     (the look's palette.provider); the name says the same in words, so the colour is never the only sign. */
  const PROVIDERS = { claude: 'Claude', codex: 'Codex', grok: 'Grok', antigravity: 'Antigravity' };
  const TITLE_SHOWN = 56;      // characters of a session's title shown under its agent when it is pointed at

  /* ---------- geometry ---------- */

  function project(point, camera, width, height) {
    const x = point[0] - camera.target[0], y = point[1] - camera.target[1], z = point[2] - camera.target[2];
    const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw), cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
    const rx = x * cy - z * sy, rz = x * sy + z * cy;
    const ry = y * cp + rz * sp, depth = -y * sp + rz * cp + camera.distance;
    if (depth < 20) return null;
    const scale = Math.min(width, height) * 1.28 / depth;
    return { x: width / 2 + rx * scale, y: height / 2 - ry * scale, depth, scale };
  }
  function arch(a, b, t, lift) {
    const mid = [(a[0] + b[0]) / 2, Math.max(a[1], b[1]) + lift, (a[2] + b[2]) / 2];
    return [0, 1, 2].map(i => (1 - t) * (1 - t) * a[i] + 2 * (1 - t) * t * mid[i] + t * t * b[i]);
  }
  /** Convex hull of 2D points (monotone chain). */
  function hull(points) {
    const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [], upper = [];
    for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }
  function inHull(poly, x, y) {
    if (poly.length < 3) return false;
    let sign = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (c === 0) continue;
      if (sign && Math.sign(c) !== sign) return false;
      sign = Math.sign(c);
    }
    return true;
  }
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  /* Mesh pieces for the looks. Every mesh stands on y = 0, so it sits on its floor. */
  const shapes = {
    box(w, h, d, y) {
      const x = w / 2, z = d / 2, y0 = y || 0, y1 = y0 + h;
      return { vertices: [[-x, y0, -z], [x, y0, -z], [x, y1, -z], [-x, y1, -z], [-x, y0, z], [x, y0, z], [x, y1, z], [-x, y1, z]],
        lines: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]] };
    },
    prism(sides, radius, h, y, turn) {
      const vertices = [], lines = [], y0 = y || 0;
      for (let i = 0; i < sides; i++) { const a = (turn || 0) + i / sides * TAU; vertices.push([Math.cos(a) * radius, y0, Math.sin(a) * radius], [Math.cos(a) * radius, y0 + h, Math.sin(a) * radius]); }
      for (let i = 0; i < sides; i++) { const j = (i + 1) % sides; lines.push([i * 2, j * 2], [i * 2 + 1, j * 2 + 1], [i * 2, i * 2 + 1]); }
      return { vertices, lines };
    },
    octahedron(radius, y) {
      const c = (y || 0) + radius;
      return { vertices: [[0, c + radius, 0], [radius, c, 0], [0, c, radius], [-radius, c, 0], [0, c, -radius], [0, c - radius, 0]],
        lines: [[0, 1], [0, 2], [0, 3], [0, 4], [5, 1], [5, 2], [5, 3], [5, 4], [1, 2], [2, 3], [3, 4], [4, 1]] };
    },
    /** A regular solid from its corners: scaled so every corner is `radius` from the centre, its edges found as the
        shortest distance between two corners, and set down on y. */
    solid(corners, radius, y) {
      const size = Math.hypot(...corners[0]), k = radius / size;
      const points = corners.map(p => p.map(v => v * k)), lines = [];
      let edge = Infinity;
      for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) edge = Math.min(edge, Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1], points[i][2] - points[j][2]));
      for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) if (Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1], points[i][2] - points[j][2]) < edge * 1.01) lines.push([i, j]);
      const low = Math.min(...points.map(p => p[1])), y0 = y || 0;
      return { vertices: points.map(p => [p[0], p[1] - low + y0, p[2]]), lines };
    },
    /** Twenty triangles: 12 corners, 30 edges. */
    icosahedron(radius, y) {
      const corners = [];
      for (const a of [-1, 1]) for (const b of [-PHI, PHI]) corners.push([0, a, b], [a, b, 0], [b, 0, a]);
      return shapes.solid(corners, radius, y);
    },
    /** Twelve pentagons: 20 corners, 30 edges. */
    dodecahedron(radius, y) {
      const corners = [], inv = 1 / PHI;
      for (const a of [-1, 1]) for (const b of [-1, 1]) {
        for (const c of [-1, 1]) corners.push([a, b, c]);
        corners.push([0, a * inv, b * PHI], [a * inv, b * PHI, 0], [a * PHI, 0, b * inv]);
      }
      return shapes.solid(corners, radius, y);
    },
    pyramid(sides, radius, h, y, turn) {
      const vertices = [], lines = [], y0 = y || 0;
      for (let i = 0; i < sides; i++) { const a = (turn || 0) + i / sides * TAU; vertices.push([Math.cos(a) * radius, y0, Math.sin(a) * radius]); lines.push([i, (i + 1) % sides], [i, sides]); }
      vertices.push([0, y0 + h, 0]);
      return { vertices, lines };
    },
    ring(radius, count, plane, y) {
      const vertices = [], lines = [], c = y || 0;
      for (let i = 0; i < count; i++) {
        const a = i / count * TAU, u = Math.cos(a) * radius, v = Math.sin(a) * radius;
        vertices.push(plane === 'xy' ? [u, c + v, 0] : plane === 'zy' ? [0, c + v, u] : [u, c, v]);
        lines.push([i, (i + 1) % count]);
      }
      return { vertices, lines };
    },
    path(vertices, closed) {
      const lines = [];
      for (let i = 0; i + 1 < vertices.length; i++) lines.push([i, i + 1]);
      if (closed) lines.push([vertices.length - 1, 0]);
      return { vertices, lines };
    },
    /** A flat filled shape: its corners in order. It is outlined, and filled as drawn (not as its hull), so it may be a cross or a star. */
    polygon(vertices) {
      return { vertices, lines: vertices.map((v, i) => [i, (i + 1) % vertices.length]), faces: [vertices.map((v, i) => i)] };
    },
    /** Several meshes as one. When any of them has `faces`, the result is filled by the faces alone: a part without faces is lines only. */
    merge(...meshes) {
      const vertices = [], lines = [], faces = [];
      let own = false;
      for (const mesh of meshes) {
        const offset = vertices.length; vertices.push(...mesh.vertices); lines.push(...mesh.lines.map(([a, b]) => [a + offset, b + offset]));
        if (mesh.faces) { own = true; faces.push(...mesh.faces.map(face => face.map(i => i + offset))); }
      }
      return own ? { vertices, lines, faces } : { vertices, lines };
    }
  };

  /* What a mesh is filled by: its own faces when it has them (`faces: []` fills nothing), else the hull of its outline. */
  const filled = (mesh, pts, outline) => (mesh.faces ? mesh.faces.map(face => face.map(i => pts[i])).filter(face => face.every(Boolean)) : [outline]);
  function trace(ctx, polygons) {
    ctx.beginPath();
    for (const poly of polygons) { poly.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); }
  }
  /* How much larger than 10 px a look's captions are: look.captionSize is the resting caption's size, from 10 to 20. */
  const captionScale = look => Math.max(1, Math.min(2, (Number(look.captionSize) || 10) / 10));

  /* ---------- a look's backdrop: still, behind the floors ----------
   * look.backdrop(scene) returns a list of items in the scene's own coordinates:
   *   { lines: [[[x, y, z], [x, y, z], ...], ...], color, alpha, width, dash }   polylines, drawn as ONE path
   *   { dots: [[x, y, z], ...], color, alpha, size }                             discs of `size` px, ONE path
   *   { text: 'short', at: [x, y, z], color, alpha, size, align }                one line in the look's font
   * It is asked once for a set of columns and a floor spacing, never for a frame: it gets no clock, no
   * model and no state. The result is kept; each frame only projects it. The cost is bounded here, for
   * every look: at most BACKDROP.segments line segments, .dots dots, .texts texts and .styles paths.
   * What is over a limit is not drawn and is counted in view.backdropInfo.over, which the looks test refuses.
   */
  const BACKDROP = { segments: 1500, dots: 500, texts: 40, styles: 12 };
  const isPoint = p => Array.isArray(p) && p.length === 3 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);
  const unit = (value, otherwise) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : otherwise);
  const strokes = {
    /** A closed ring round `center`, flat in XZ, then tilted about the X axis and about the Z axis (radians). One polyline. */
    ring(center, radius, segments, tiltX, tiltZ) {
      const n = Math.max(3, Math.min(96, Math.round(segments || 48))), cx = Math.cos(tiltX || 0), sx = Math.sin(tiltX || 0), cz = Math.cos(tiltZ || 0), sz = Math.sin(tiltZ || 0), out = [];
      for (let i = 0; i <= n; i++) {
        const a = (i % n) / n * TAU, x = Math.cos(a) * radius, z0 = Math.sin(a) * radius, y1 = -z0 * sx, z = z0 * cx;
        out.push([center[0] + x * cz - y1 * sz, center[1] + x * sz + y1 * cz, center[2] + z]);
      }
      return out;
    },
    /** A flat grid at height y from (x0, z0) to (x1, z1), a line every `step`. A list of two-point polylines. */
    grid(x0, z0, x1, z1, y, step) {
      const out = [], d = Math.max(1, step || 100);
      for (let x = x0; x <= x1 + 1e-6; x += d) out.push([[x, y, z0], [x, y, z1]]);
      for (let z = z0; z <= z1 + 1e-6; z += d) out.push([[x0, y, z], [x1, y, z]]);
      return out;
    }
  };
  /** A fixed sequence of numbers from 0 up to 1 for a seed: where a backdrop wants scatter (stars), it is the same every time. */
  function seeded(seed) {
    let a = (seed >>> 0) || 1;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  /** What a backdrop is told: where the floors of the shown columns are. Nothing about nodes, states or time. */
  function backdropScene(cols, spread) {
    const sessions = cols.filter(col => col !== L.DOCK), floors = {};
    for (const floor of L.FLOORS) floors[floor] = L.floorY(floor, spread);
    return {
      bounds: L.bounds(sessions.length ? sessions : [0], spread, true),      // the box round every floor; an empty scene has its first column's
      floors, cell: L.CELL, pitch: L.PITCH, rowPitch: L.ROW_PITCH,
      columns: cols.map(col => {
        const origin = L.columnOrigin(col), tiles = {};
        for (const floor of L.floorsOf(col)) tiles[floor] = L.tile(col, floor, spread);
        return { dock: col === L.DOCK, x: origin[0], z: origin[1], half: L.CELL / 2, tiles };
      })
    };
  }
  /** A backdrop's items as flat arrays, cut to the limits. Anything that is not of the shapes above is left out. */
  function compileBackdrop(items, pal) {
    const ops = [], count = { segments: 0, dots: 0, texts: 0, styles: 0 }, over = {};
    const more = (key, n) => { over[key] = (over[key] || 0) + n; };
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item !== 'object') continue;
      const color = typeof item.color === 'string' && item.color ? item.color : pal.line;
      if (Array.isArray(item.lines)) {
        if (count.styles >= BACKDROP.styles) { more('styles', 1); continue; }
        const xyz = [], runs = [];
        for (const line of item.lines) {
          const points = Array.isArray(line) ? line.filter(isPoint) : [];
          if (points.length < 2) continue;
          const room = BACKDROP.segments - count.segments, take = Math.min(points.length - 1, room);
          if (take < points.length - 1) more('segments', points.length - 1 - take);
          if (take < 1) continue;
          for (let i = 0; i <= take; i++) xyz.push(points[i][0], points[i][1], points[i][2]);
          runs.push(take + 1); count.segments += take;
        }
        if (!runs.length) continue;
        count.styles++;
        ops.push({ kind: 'lines', color, alpha: unit(item.alpha, .5), width: Number.isFinite(item.width) ? Math.max(.25, Math.min(6, item.width)) : 1,
          dash: Array.isArray(item.dash) && item.dash.every(Number.isFinite) ? item.dash.slice(0, 6) : NO_DASH, xyz: new Float32Array(xyz), runs });
      } else if (Array.isArray(item.dots)) {
        if (count.styles >= BACKDROP.styles) { more('styles', 1); continue; }
        const points = item.dots.filter(isPoint), take = Math.min(points.length, BACKDROP.dots - count.dots), xyz = [];
        if (take < points.length) more('dots', points.length - take);
        if (take < 1) continue;
        for (let i = 0; i < take; i++) xyz.push(points[i][0], points[i][1], points[i][2]);
        count.dots += take; count.styles++;
        ops.push({ kind: 'dots', color, alpha: unit(item.alpha, .7), size: Number.isFinite(item.size) ? Math.max(.4, Math.min(6, item.size)) : 1.2, xyz: new Float32Array(xyz) });
      } else if (typeof item.text === 'string' && item.text && isPoint(item.at)) {
        if (count.texts >= BACKDROP.texts) { more('texts', 1); continue; }
        count.texts++;
        ops.push({ kind: 'text', color, alpha: unit(item.alpha, .7), text: item.text.slice(0, 48), at: item.at.slice(), size: Number.isFinite(item.size) ? Math.max(6, Math.min(48, item.size)) : 10,
          align: item.align === 'center' || item.align === 'right' ? item.align : 'left' });
      }
    }
    return { ops, count, over };
  }

  /* ---------- a look's ground: the scene's background as one still gradient ----------
   * palette.ground is optional. Without it the scene's background is the flat palette.bg, drawn exactly as before.
   *   { shape: 'round', at: [x, y], stops: [[offset, colour], ...] }                 an ellipse round `at`, out to the farthest corner
   *   { shape: 'straight', from: [x, y], to: [x, y], stops: [[offset, colour], ...] }  from one point to the other
   * A position is a fraction of the scene: [0, 0] is its top left corner and [1, 1] its bottom right one. `at` is the
   * middle when absent; `from` and `to` are the top and the bottom. Two to GROUND.stops stops, offsets from 0 to 1.
   * It is the one fill that begins every frame, in place of the flat one: nothing more is drawn, and nothing at rest.
   * The stage round the scene, what a shape hides, a mark's disc and a caption's halo keep palette.bg.
   */
  const GROUND = { stops: 6 };
  /** What is wrong with a ground, or '' when it can be drawn. */
  function groundProblem(ground) {
    if (!ground || typeof ground !== 'object') return 'ground must be an object';
    if (ground.shape !== 'round' && ground.shape !== 'straight') return 'ground.shape must be "round" or "straight"';
    const spot = p => Array.isArray(p) && p.length === 2 && p.every(v => Number.isFinite(v) && v >= 0 && v <= 1);
    for (const key of ground.shape === 'round' ? ['at'] : ['from', 'to']) if (ground[key] !== undefined && !spot(ground[key])) return 'ground.' + key + ' must be [x, y], each from 0 to 1';
    if (ground.shape === 'straight') { const a = ground.from || [.5, 0], b = ground.to || [.5, 1]; if (a[0] === b[0] && a[1] === b[1]) return 'ground.from and ground.to must differ'; }
    const stops = ground.stops;
    if (!Array.isArray(stops) || stops.length < 2 || stops.length > GROUND.stops) return 'ground.stops must hold 2 to ' + GROUND.stops + ' stops';
    let last = 0;
    for (const stop of stops) {
      if (!Array.isArray(stop) || stop.length !== 2 || !Number.isFinite(stop[0]) || stop[0] < last || stop[0] > 1 || typeof stop[1] !== 'string' || !stop[1].trim()) return 'ground.stops: each is [offset, colour], the offsets from 0 to 1 and never falling';
      last = stop[0];
    }
    return '';
  }
  /**
   * Fill the scene's background: the look's ground, else the flat palette.bg. One fill. Returns '' or, when the ground
   * could not be drawn (a wrong shape, a colour the canvas refuses), what was wrong; the flat colour is drawn then.
   */
  function paintGround(ctx, pal, w, h) {
    let error = '';
    if (pal.ground !== undefined) {
      error = groundProblem(pal.ground);
      if (!error) {
        try {
          const ground = pal.ground, round = ground.shape === 'round';
          let fill, cx = 0, cy = 0, rx = 1, ry = 1;
          if (round) {
            // CSS's own default size, "farthest-corner": the ellipse through the corner farthest from its centre.
            const at = ground.at || [.5, .5];
            cx = at[0] * w; cy = at[1] * h; rx = Math.max(cx, w - cx) * Math.SQRT2; ry = Math.max(cy, h - cy) * Math.SQRT2;
            fill = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
          } else {
            const a = ground.from || [.5, 0], b = ground.to || [.5, 1];
            fill = ctx.createLinearGradient(a[0] * w, a[1] * h, b[0] * w, b[1] * h);
          }
          for (const [offset, color] of ground.stops) fill.addColorStop(offset, color);
          ctx.globalAlpha = 1; ctx.fillStyle = fill;
          // A circle of radius 1, stretched to the ellipse: the rectangle is the scene (and a pixel more), seen from inside the stretch.
          if (round) { ctx.save(); ctx.translate(cx, cy); ctx.scale(rx, ry); ctx.fillRect((-cx - 1) / rx, (-cy - 1) / ry, (w + 2) / rx, (h + 2) / ry); ctx.restore(); }
          else ctx.fillRect(0, 0, w, h);
          return '';
        } catch (e) { error = String(e && e.message || e); }      // a look's mistake must not stop the scene
      }
    }
    ctx.globalAlpha = 1; ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, w, h);
    return error;
  }
  /** Every colour the ground has: palette.bg, and each stop of palette.ground. A gradient is never lighter or darker than its stops. */
  function groundColors(pal) {
    const stops = pal.ground && !groundProblem(pal.ground) ? pal.ground.stops.map(stop => stop[1]) : [];
    return [pal.bg].concat(stops);
  }

  /* ---------- a caption in its node's colour ----------
   * palette.captionNode: true asks for the first line of a resting caption in its node's colour (its class's, or its
   * provider's). The selected and the pointed-at caption keep palette.ink, and the second line keeps palette.muted.
   * A caption must stay readable, so the colour is used only where its contrast is CAPTION_FLOOR to 1 or more against
   * every colour of the ground (WCAG 2's ratio; 4.5 is its floor for small text). Below the floor, and for a colour
   * that is not written as #rgb, #rrggbb or rgb(r, g, b), that caption keeps palette.caption. Never a state's colour.
   */
  const CAPTION_FLOOR = 4.5;
  const lumKept = new Map();
  /** The relative luminance of a colour written as #rgb, #rrggbb or rgb(r, g, b); null for any other text. */
  function luminance(color) {
    if (lumKept.has(color)) return lumKept.get(color);
    const text = typeof color === 'string' ? color.trim().toLowerCase() : '';
    let rgb = null, m;
    if ((m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text))) rgb = [m[1] + m[1], m[2] + m[2], m[3] + m[3]].map(v => parseInt(v, 16));
    else if ((m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(text))) rgb = [m[1], m[2], m[3]].map(v => parseInt(v, 16));
    else if ((m = /^rgb\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*\)$/.exec(text))) rgb = [m[1], m[2], m[3]].map(Number);
    let out = null;
    if (rgb && rgb.every(v => v <= 255)) {
      const [r, g, b] = rgb.map(v => { const c = v / 255; return c <= .03928 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4); });
      out = .2126 * r + .7152 * g + .0722 * b;
    }
    if (lumKept.size > 400) lumKept.clear();
    lumKept.set(color, out);
    return out;
  }
  /** The contrast of two colours, from 1 to 21; 0 when either cannot be read. */
  function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    return la === null || lb === null ? 0 : (Math.max(la, lb) + .05) / (Math.min(la, lb) + .05);
  }
  /** The colour of the first line of a resting caption of a node whose colour is `color`. */
  function captionColor(pal, color) {
    if (pal.captionNode !== true) return pal.caption;
    for (const ground of groundColors(pal)) if (contrast(color, ground) < CAPTION_FLOOR) return pal.caption;
    return color;
  }

  /* ---------- drawing on change ---------- */

  /** Draws only when asked, and never more than once per display frame. Frames caused by data
      (or by an ended call fading out) are at least DATA_GAP apart; frames caused by input are not held back. */
  class Redraw {
    constructor(draw, env) {
      env = env || {};
      this.drawFn = draw;
      this.raf = env.raf || (fn => root.requestAnimationFrame(fn));
      this.setTimeout = env.setTimeout || ((fn, ms) => setTimeout(fn, ms));
      this.now = env.now || (() => performance.now());
      this.gap = DATA_GAP;
      this.frames = 0; this.byReason = {};
      this.pending = false; this.reasons = new Set(); this.timer = null; this.lastData = -Infinity;
    }
    request(reason) {
      this.reasons.add(reason);
      if (this.pending) return;
      if (reason === 'data' || reason === 'decay') {
        const wait = this.lastData + this.gap - this.now();
        if (wait > 0) {
          if (this.timer === null) this.timer = this.setTimeout(() => { this.timer = null; if (this.reasons.size) this.queue(); }, wait);
          return;
        }
      }
      this.queue();
    }
    queue() {
      if (this.pending) return;
      this.pending = true;
      this.raf(() => {
        this.pending = false;
        const reasons = this.reasons;
        this.reasons = new Set();
        if (!reasons.size) return;
        if (reasons.has('data') || reasons.has('decay')) this.lastData = this.now();
        this.frames++;
        for (const r of reasons) this.byReason[r] = (this.byReason[r] || 0) + 1;
        this.drawFn(reasons);
      });
    }
  }

  /** How big a state mark is drawn beside a node at this scale, and how far out from the node's corner its centre stands (in mark radii). */
  const badgeSize = scale => Math.max(4.5, Math.min(8, 3.5 + scale * 5));
  const BADGE_OUT = .72;
  function drawBadge(ctx, shape, x, y, s, color, backdrop) {
    if (!shape) return;
    ctx.setLineDash(NO_DASH); ctx.globalAlpha = .92; ctx.fillStyle = backdrop;
    ctx.beginPath(); ctx.arc(x, y, s + 2.5, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1; ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.4, s * .28);
    ctx.beginPath();
    if (shape === 'pyramid') { ctx.moveTo(x, y - s); ctx.lineTo(x + s, y + s * .8); ctx.lineTo(x - s, y + s * .8); ctx.closePath(); ctx.fill(); }
    else if (shape === 'cross') { ctx.moveTo(x - s * .8, y - s * .8); ctx.lineTo(x + s * .8, y + s * .8); ctx.moveTo(x + s * .8, y - s * .8); ctx.lineTo(x - s * .8, y + s * .8); ctx.lineWidth = Math.max(2, s * .42); ctx.stroke(); }
    else if (shape === 'globe') { ctx.arc(x, y, s * .9, 0, TAU); ctx.moveTo(x - s * .9, y); ctx.lineTo(x + s * .9, y); ctx.moveTo(x + s * .4, y); ctx.ellipse(x, y, s * .4, s * .9, 0, 0, TAU); ctx.stroke(); }
    else if (shape === 'diamond') { ctx.moveTo(x, y - s); ctx.lineTo(x + s * .8, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s * .8, y); ctx.closePath(); ctx.fill(); }
    else if (shape === 'hourglass') { ctx.moveTo(x - s * .7, y - s * .9); ctx.lineTo(x + s * .7, y - s * .9); ctx.lineTo(x - s * .7, y + s * .9); ctx.lineTo(x + s * .7, y + s * .9); ctx.closePath(); ctx.stroke(); }
    else if (shape === 'dot') { ctx.arc(x, y, s * .42, 0, TAU); ctx.fill(); }
  }
  /**
   * The camera of an icon of `size` px. A mesh that fits the icon as it always was drawn (from 84 away, looking at 11
   * above the floor) keeps exactly that camera, and so does one whose tip leaves the icon by no more than ICON.slack of
   * its size: the NEXUS mock-up's agent does, by 4.7 %, and its icon stays as it was. Any other mesh (a mesh may be 80
   * tall, and that camera shows about 45) is looked at in its middle, from as far back as it takes to show all of it a
   * stroke's width inside the edge.
   */
  const ICON = { yaw: -0.5, pitch: 0.42, distance: 84, target: [0, 11, 0], slack: .06, pad: 1.5, far: 1200 };
  function iconCamera(mesh, size) {
    const usual = { yaw: ICON.yaw, pitch: ICON.pitch, distance: ICON.distance, target: ICON.target.slice() };
    const fits = (camera, pad) => mesh.vertices.every(v => { const q = project(v, camera, size, size); return q && q.x >= pad && q.x <= size - pad && q.y >= pad && q.y <= size - pad; });
    if (fits(usual, -size * ICON.slack)) return usual;
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (const v of mesh.vertices) for (let i = 0; i < 3; i++) { if (v[i] < low[i]) low[i] = v[i]; if (v[i] > high[i]) high[i] = v[i]; }
    const camera = { yaw: ICON.yaw, pitch: ICON.pitch, distance: ICON.far, target: [0, 1, 2].map(i => (low[i] + high[i]) / 2) };
    let near = ICON.distance, far = ICON.far;
    for (let i = 0; i < 22; i++) { camera.distance = (near + far) / 2; if (fits(camera, ICON.pad)) far = camera.distance; else near = camera.distance; }
    camera.distance = far;
    return camera;
  }
  /** One class's mesh on a small canvas, for the legend. */
  function drawIcon(ctx, look, key, color, size) {
    const mesh = look.mesh(key), camera = iconCamera(mesh, size);
    const pts = mesh.vertices.map(v => project(v, camera, size, size));
    ctx.clearRect(0, 0, size, size);
    ctx.globalAlpha = Math.min(1, look.palette.fill * 1.6); ctx.fillStyle = color;
    trace(ctx, filled(mesh, pts, hull(pts))); ctx.fill();
    ctx.globalAlpha = 1; ctx.strokeStyle = look.palette.outline || color; ctx.lineWidth = 1.2; ctx.lineJoin = 'round'; ctx.setLineDash(NO_DASH); ctx.beginPath();
    for (const [a, b] of mesh.lines) { ctx.moveTo(pts[a].x, pts[a].y); ctx.lineTo(pts[b].x, pts[b].y); }
    ctx.stroke();
  }

  /* ---------- the view ---------- */

  class View {
    constructor(canvas, options) {
      this.canvas = canvas; this.ctx = canvas.getContext('2d');
      if (!this.ctx) throw new Error('A Canvas 2D context is required.');
      this.model = options.model; this.look = options.look;
      this.onSelect = options.onSelect; this.onHover = options.onHover; this.onFrame = options.onFrame; this.onKey = options.onKey;
      this.camera = { yaw: CAMERA.yaw, pitch: CAMERA.pitch, distance: CAMERA.distance, target: CAMERA.target.slice() };
      this.width = 1; this.height = 1; this.ratio = 1;
      this.selected = ''; this.hover = ''; this.spread = 1; this.motion = false; this.isolated = null; this.savedCamera = null;
      this.keepClear = [];        // boxes, in canvas px, that no caption may cover (the page's overlays)
      this.hit = []; this.labels = []; this.tileLabels = []; this.afterglow = []; this.pulses = new Map(); this.seenLinks = new Set(); this.glowTimer = null;
      this.meshes = new Map();
      this.stats = { frames: 0, ms: 0, nodes: 0, links: 0, labels: 0, skipped: 0, offscreen: 0 };
      this.redraw = new Redraw(reasons => this.draw(reasons), options.env);
      if (typeof canvas.addEventListener === 'function') this.bind();
    }

    /* ----- what the page may ask for ----- */
    setModel(model) { this.model = model; this.afterglow = []; this.pulses.clear(); this.seenLinks.clear(); this.isolated = null; this.redraw.request('data'); }
    setLook(look) { this.look = look; this.meshes.clear(); this.backdropKept = null; this.redraw.request('input'); }
    setSelected(id) { if (id === this.selected) return; this.selected = id || ''; this.redraw.request('input'); }
    setSpread(spread) { this.spread = spread; this.redraw.request('input'); }
    setMotion(on) { this.motion = !!on; this.pulses.clear(); this.redraw.request('input'); }
    dataChanged() { this.redraw.request('data'); }
    setSize(width, height, ratio) {
      this.width = Math.max(1, width); this.height = Math.max(1, height); this.ratio = ratio || 1;
      this.canvas.width = Math.round(this.width * this.ratio); this.canvas.height = Math.round(this.height * this.ratio);
      this.redraw.request('size');
    }
    resize() { const r = this.canvas.getBoundingClientRect(); this.setSize(r.width, r.height, Math.min(root.devicePixelRatio || 1, 2)); }

    /* ----- camera: moved by the owner only, never by data ----- */
    orbit(yaw, pitch) { this.camera.yaw += yaw; this.camera.pitch = Math.max(-.1, Math.min(1.5, this.camera.pitch + pitch)); this.redraw.request('input'); }
    zoom(factor) { this.camera.distance = Math.max(260, Math.min(14000, this.camera.distance * factor)); this.redraw.request('input'); }
    pan(dx, dy) {
      const k = this.camera.distance / (Math.min(this.width, this.height) * 1.28), c = this.camera;
      c.target[0] -= dx * k * Math.cos(c.yaw); c.target[2] += dx * k * Math.sin(c.yaw); c.target[1] += dy * k;
      this.redraw.request('input');
    }
    /** Fit the floors of the given columns (default: the columns in use) and the dock into the canvas. */
    frame(cols, withDock) {
      const b = L.bounds(cols || this.model.columnsInUse(), this.spread, withDock), c = this.camera, pad = Math.min(46, this.width * .06);
      c.target = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      const corners = [];
      for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) corners.push([x, y, z]);
      let lo = 260, hi = 14000;
      for (let i = 0; i < 26; i++) {
        const mid = (lo + hi) / 2;
        const fits = corners.every(p => { const q = project(p, { yaw: c.yaw, pitch: c.pitch, distance: mid, target: c.target }, this.width, this.height); return q && q.x >= pad && q.x <= this.width - pad && q.y >= pad && q.y <= this.height - pad; });
        if (fits) hi = mid; else lo = mid;
      }
      c.distance = hi;
      this.redraw.request('input');
    }
    resetCamera(cols) { this.camera.yaw = CAMERA.yaw; this.camera.pitch = CAMERA.pitch; this.frame(cols); }
    /** Show one session's column and the dock alone, framed on the column; `release` goes back to the camera as it was. */
    isolate(col) {
      if (this.isolated == null) this.savedCamera = { yaw: this.camera.yaw, pitch: this.camera.pitch, distance: this.camera.distance, target: this.camera.target.slice() };
      this.isolated = col; this.frame([col], false);
    }
    release() {
      if (this.isolated == null) return false;
      this.isolated = null; this.camera = this.savedCamera; this.savedCamera = null; this.redraw.request('input');
      return true;
    }

    /* ----- what a node looks like: class decides mesh and colour, state decides only the mark ----- */
    /** The provider of an agent, a subagent, or a stack of subagents: its own, else its session's. */
    providerOf(n) {
      if (n.cls !== 'stack' && typeof n.kind === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, n.kind)) return n.kind;
      const key = n.owner || this.model.columns[n.col] || '';
      return String(key).split(':')[0];
    }
    /** An agent and its subagents are coloured by provider; every other class has its own colour. */
    colorOf(n) {
      const pal = this.look.palette, cls = n.cls === 'stack' ? n.of : n.cls;
      if (cls !== 'agent' && cls !== 'subagent') return pal.cls[cls];
      const kind = this.providerOf(n);
      return (pal.provider && Object.prototype.hasOwnProperty.call(pal.provider, kind) && pal.provider[kind]) || pal.cls[cls];
    }
    visual(n) {
      return {
        mesh: n.cls === 'stack' ? 'stack' : n.cls === 'resource' ? 'resource.' + n.kind : n.cls,
        color: this.colorOf(n),
        badge: M.STATES[n.status] ? M.STATES[n.status].shape : '',
        outline: n.cls === 'agent' && n.status === 'done' ? 'dashed' : 'solid',
        size: n.cls === 'resource' ? 1 + Math.min(MAX_GROWTH, Math.log2(1 + n.touches) * .16) : 1      // a resource grows with its touch count
      };
    }
    meshFor(key) {
      let mesh = this.meshes.get(key);
      if (!mesh) {
        mesh = this.look.mesh(key);
        mesh.height = Math.max(...mesh.vertices.map(v => v[1]));
        this.meshes.set(key, mesh);
      }
      return mesh;
    }
    captionOf(n, full) {
      // An agent is named by what it is: its provider. Its folder's name is a code more often than a word (a card's
      // worktree), so it is left to the inspector; the tile it stands on names its workspace, and its tab's title
      // shows under it when it is pointed at.
      const name = n.cls === 'agent' ? PROVIDERS[this.providerOf(n)] || n.label : full ? n.label : n.short || n.label;
      const text = this.look.caption(name || ''), max = full ? 64 : 22;
      return text.length > max ? text.slice(0, max - 1) + '…' : text;
    }
    /** The title of an agent's tab, as written, cut to fit. '' when there is none. */
    titleOf(n) {
      const text = n.cls === 'agent' && typeof n.title === 'string' ? n.title.trim() : '';
      return text.length > TITLE_SHOWN ? text.slice(0, TITLE_SHOWN - 1) + '…' : text;
    }
    detailOf(n) {
      const state = M.STATES[n.status].name;
      if (n.cls === 'agent') return state + (n.open ? ' / ' + n.open + ' open' : '');
      if (n.cls === 'subagent') return state;
      if (n.cls === 'tool') return n.calls + (n.calls === 1 ? ' call' : ' calls') + (n.status === 'rest' ? '' : ' / ' + state);
      if (n.cls === 'mcp') return n.calls + (n.calls === 1 ? ' call' : ' calls') + ' / ' + n.ports.size + (n.ports.size === 1 ? ' tool' : ' tools') + (n.status === 'rest' ? '' : ' / ' + state);
      if (n.cls === 'resource') return 'read ' + n.reads + ' / write ' + n.writes + (n.searches ? ' / search ' + n.searches : '');
      return 'folded' + (n.open ? ' / ' + n.open + ' in use' : '');
    }

    /* ----- one frame ----- */
    draw(reasons) {
      const started = this.redraw.now(), ctx = this.ctx, w = this.width, h = this.height, model = this.model, look = this.look, pal = look.palette, spread = this.spread;
      const P = point => project(point, this.camera, w, h);
      const seg = (a, b) => { if (a && b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); } };
      const stroke = (color, alpha, width, dash) => { ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || NO_DASH); ctx.stroke(); };
      const shown = col => this.isolated == null || col === this.isolated || col === L.DOCK;

      ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
      this.groundError = paintGround(ctx, pal, w, h);      // the flat palette.bg, or the look's ground (a still gradient)
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';

      /* 1. Floors: one tile for each column on each floor it has. A tile never changes place or height. */
      const cols = [L.DOCK].concat(model.columnsInUse()).filter(shown), placed = this.keepClear.map(b => Object.assign({}, b)), titles = [];
      this.drawBackdrop(cols);                             // the look's still backdrop, behind everything
      for (const floor of L.FLOORS) {
        // A floor has its class's colour, except the agents' floor: agents are coloured by provider, so their floor is a
        // neutral one that no provider's colour runs into.
        const color = (pal.floor && pal.floor[floor]) || pal.cls[floor], tiles = cols.filter(col => L.floorsOf(col).includes(floor)).map(col => L.tile(col, floor, spread).map(P));
        if (pal.floorFill) {
          ctx.globalAlpha = pal.floorFill; ctx.fillStyle = color; ctx.beginPath();
          for (const t of tiles) if (t.every(Boolean)) { ctx.moveTo(t[0].x, t[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(t[i].x, t[i].y); ctx.closePath(); }
          ctx.fill();
        }
        ctx.beginPath();
        for (const t of tiles) for (let i = 0; i < 4; i++) seg(t[i], t[(i + 1) % 4]);
        stroke(color, pal.floorLine, 1);
        ctx.beginPath();                                   // the slot grid, faint
        for (const col of cols) {
          if (!L.floorsOf(col).includes(floor)) continue;
          const o = L.columnOrigin(col), y = L.floorY(floor, spread), half = L.CELL / 2;
          for (const k of [-L.SLOT_PITCH / 2, L.SLOT_PITCH / 2]) { seg(P([o[0] + k, y, o[1] - half]), P([o[0] + k, y, o[1] + half])); seg(P([o[0] - half, y, o[1] + k]), P([o[0] + half, y, o[1] + k])); }
        }
        stroke(color, pal.floorLine * .3, .6);
        const first = cols.find(col => L.floorsOf(col).includes(floor));
        let named = 0;
        if (floor === 'agent') {
          // The tile an agent stands on is labelled with the workspace it works in: the window's title, never a key.
          for (const col of cols) {
            if (col === L.DOCK) continue;
            const agent = model.nodes.get('a:' + model.columns[col]), name = agent && typeof agent.space === 'string' ? agent.space.trim() : '';
            if (!name) continue;
            const tile = L.tile(col, floor, spread), at = P(tile[0]), end = P(tile[1]);
            // Room: the tile's front edge and the gap to the next column, so two neighbours' names never run into each other.
            titles.push({ floor, color, at, text: look.caption(name), room: at && end ? Math.max(24, (end.x - at.x) * (L.PITCH / L.CELL) - 8) : 0 });
            named++;
          }
        }
        // A hub that names no workspace (version 0.1.0) leaves the floor its own title.
        if (!named && first !== undefined) titles.push({ floor, color, at: P(L.tile(first, floor, spread)[0]) });
      }
      ctx.beginPath();                                     // the posts that make a column read as one thing
      for (const col of cols) {
        if (col === L.DOCK) continue;
        const top = L.tile(col, 'agent', spread), bottom = L.tile(col, 'resource', spread);
        for (let i = 0; i < 4; i++) seg(P(top[i]), P(bottom[i]));
      }
      stroke(pal.line, pal.post, .7);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      const k = captionScale(look), px = size => size * k + 'px ';      // a look may raise the captions' size; everything of a caption grows with it
      const fit = (text, room) => {
        if (ctx.measureText(text).width <= room) return text;
        let cut = text;
        while (cut.length > 3 && ctx.measureText(cut + '…').width > room) cut = cut.slice(0, -1);
        return cut + '…';
      };
      this.tileLabels = [];
      for (const t of titles) {
        if (!t.at) continue;
        ctx.font = px(t.text ? 10 : 9) + look.font;
        const text = t.text ? fit(t.text, t.room) : L.FLOOR_TITLE[t.floor], box = { x: t.at.x - 2, y: t.at.y + 4, w: ctx.measureText(text).width + 4, h: 12 * k };
        if (placed.some(b => overlap(b, box))) continue;
        // A workspace's name is a label to be read, so it has the captions' colour; a floor's own title has the floor's.
        ctx.globalAlpha = t.text ? 1 : .85; ctx.fillStyle = t.text ? pal.caption : t.color; ctx.fillText(text, box.x + 2, box.y + 9.5 * k);
        placed.push(box);
        if (t.text) this.tileLabels.push({ text, x: box.x, y: box.y, w: box.w, h: box.h });
      }

      /* 2. Where every standing node is on screen. */
      const vis = new Map();
      let offscreen = 0;
      for (const n of model.nodes.values()) {
        if (n.folded || !shown(n.col)) continue;
        const v = this.visual(n), mesh = this.meshFor(v.mesh), base = L.position(n, spread), k = v.size;
        const pts = mesh.vertices.map(q => P([base[0] + q[0] * k, base[1] + q[1] * k, base[2] + q[2] * k]));
        const c = P([base[0], base[1] + mesh.height * k / 2, base[2]]);
        if (!c || pts.some(q => !q)) continue;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const q of pts) { if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x; if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y; }
        if (c.x < 0 || c.x > w || c.y < 0 || c.y > h) offscreen++;
        vis.set(n.id, { n, v, mesh, base, k, pts, c, hull: hull(pts), minX, maxX, minY, maxY });
      }
      const middle = item => [item.base[0], item.base[1] + item.mesh.height * item.k / 2, item.base[2]];
      const portAt = (item, name) => {
        const index = [...item.n.ports.keys()].indexOf(name);
        if (index < 0 || index >= M.PORT_CAP) return null;
        const a = -Math.PI / 2 + index / M.PORT_CAP * TAU, y = item.base[1] + item.mesh.height / 2;
        return [[item.base[0] + Math.cos(a) * 19, y, item.base[2] + Math.sin(a) * 19], [item.base[0] + Math.cos(a) * 28, y, item.base[2] + Math.sin(a) * 28]];
      };

      /* 3. Calls: a link exists only while its call is open. Clash arcs join two agents' copies of a file both wrote. */
      const busy = new Set(), now = started;
      for (const link of model.takeClosed()) this.afterglow.push({ link, until: now + GLOW_MS });
      this.afterglow = this.afterglow.filter(g => g.until > now);
      let links = 0;
      const drawLink = (link, faded) => {
        const a = vis.get(model.visibleId(link.from)), b = vis.get(model.visibleId(link.to));
        if (!a || !b || a === b) return;
        const color = pal.cls[link.kind === 'touch' ? 'resource' : link.kind], from = middle(a);
        let to = middle(b);
        if (link.kind === 'mcp' && b.n.cls === 'mcp') { const port = portAt(b, link.port); if (port) to = port[1]; }
        const curved = link.kind === 'mcp', steps = curved ? 14 : 1, lift = curved ? 46 : 0;
        ctx.beginPath();
        let prev = P(from), mid = null;
        for (let i = 1; i <= steps; i++) { const next = P(curved ? arch(from, to, i / steps, lift) : to); seg(prev, next); if (i === Math.ceil(steps / 2)) mid = prev && next ? { x: (prev.x + next.x) / 2, y: (prev.y + next.y) / 2 } : null; prev = next; }
        const dash = faded ? [2, 6] : link.kind === 'touch' ? (link.op === 'read' ? [5, 4] : link.op === 'search' ? [1, 4] : link.op === 'unknown' ? [7, 3, 1, 3] : NO_DASH) : NO_DASH;
        stroke(color, faded ? .55 : .95, faded ? 1 : link.kind === 'touch' ? 1.5 : 1.9, dash);
        const end = P(to), before = P(curved ? arch(from, to, 1 - 1 / steps, lift) : from);
        if (!faded && link.kind === 'touch' && link.op === 'write' && end && before) {          // a write points at what it wrote
          const ang = Math.atan2(end.y - before.y, end.x - before.x), back = Math.min(14, Math.hypot(end.x - before.x, end.y - before.y) * .4);
          const tip = { x: end.x - Math.cos(ang) * back, y: end.y - Math.sin(ang) * back };
          ctx.setLineDash(NO_DASH); ctx.fillStyle = color; ctx.globalAlpha = 1; ctx.beginPath();
          ctx.moveTo(tip.x, tip.y); ctx.lineTo(tip.x - Math.cos(ang - .5) * 7, tip.y - Math.sin(ang - .5) * 7); ctx.lineTo(tip.x - Math.cos(ang + .5) * 7, tip.y - Math.sin(ang + .5) * 7); ctx.closePath(); ctx.fill();
        }
        if (mid && faded && link.ok === false) drawBadge(ctx, 'cross', mid.x, mid.y, 4, pal.state.failed, pal.bg);
        if (mid && !faded && link.unclear) drawBadge(ctx, 'diamond', mid.x, mid.y, 4, pal.state.unclear, pal.bg);
        if (!faded) {
          links++; busy.add(a.n.id); busy.add(b.n.id);
          const pulse = this.pulses.get(link.id);
          if (pulse !== undefined && now - pulse < GLOW_MS) {
            const q = P(curved ? arch(from, to, (now - pulse) / GLOW_MS, lift) : from.map((value, i) => value + (to[i] - value) * (now - pulse) / GLOW_MS));
            if (q) { ctx.globalAlpha = 1; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(q.x, q.y, 3, 0, TAU); ctx.fill(); }
          }
        }
      };
      for (const arc of model.arcs.values()) {
        const a = vis.get(model.visibleId(arc.a)), b = vis.get(model.visibleId(arc.b));
        if (!a || !b || a === b) continue;
        ctx.beginPath();
        let prev = P(middle(a)), mid = null;
        for (let i = 1; i <= 14; i++) { const next = P(arch(middle(a), middle(b), i / 14, 58)); seg(prev, next); if (i === 7) mid = next; prev = next; }
        stroke(pal.clash, .8, 1.2, [6, 4]);
        if (mid) {
          ctx.setLineDash(NO_DASH); ctx.globalAlpha = 1; ctx.fillStyle = pal.bg; ctx.strokeStyle = pal.clash; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(mid.x, mid.y, 5.5, 0, TAU); ctx.fill(); ctx.stroke();
          ctx.fillStyle = pal.clash; ctx.font = 'bold 9px ' + look.font; ctx.textAlign = 'center'; ctx.fillText('!', mid.x, mid.y + 3.2);
        }
      }
      if (this.motion) {
        for (const link of model.links.values()) if (!this.seenLinks.has(link.id)) { this.seenLinks.add(link.id); this.pulses.set(link.id, now); }
        for (const id of this.seenLinks) if (!model.links.has(id)) { this.seenLinks.delete(id); this.pulses.delete(id); }
      }
      for (const g of this.afterglow) drawLink(g.link, true);
      for (const link of model.links.values()) drawLink(link, false);

      /* 4. Nodes, far to near. The mesh and its colour come from the class; the state adds a mark beside it. */
      const order = [...vis.values()].sort((a, b) => b.c.depth - a.c.depth);
      this.hit = [];
      for (const item of order) {
        const n = item.n, v = item.v, chosen = n.id === this.selected, hovered = n.id === this.hover;
        ctx.setLineDash(NO_DASH);
        trace(ctx, filled(item.mesh, item.pts, item.hull));
        ctx.globalAlpha = pal.solid; ctx.fillStyle = pal.bg; ctx.fill();
        ctx.globalAlpha = Math.min(1, pal.fill * (chosen || hovered ? 2 : 1)); ctx.fillStyle = v.color; ctx.fill();
        if (chosen || hovered) { if (item.mesh.faces) trace(ctx, [item.hull]); stroke(pal.ink, chosen ? 1 : .6, chosen ? 2.6 : 1.4, chosen ? NO_DASH : [3, 3]); }
        ctx.beginPath();
        for (const [a, b] of item.mesh.lines) seg(item.pts[a], item.pts[b]);
        // The edges: the class's colour, or the look's one outline colour (palette.outline) over a fill in the class's colour.
        const dash = v.outline === 'dashed' ? [4, 4] : NO_DASH, edge = pal.outline || v.color;
        if (look.glow) stroke(v.color, .16, look.lineWidth * 3.4, dash);
        stroke(edge, 1, look.lineWidth * (chosen ? 1.5 : 1), dash);
        if (n.cls === 'mcp') {                              // the server's tools are ports on its rim
          for (const [name, port] of n.ports) {
            const at = portAt(item, name);
            if (!at) break;
            const a = P(at[0]), b = P(at[1]);
            if (!a || !b) continue;
            ctx.beginPath(); seg(a, b); stroke(edge, 1, look.lineWidth);
            ctx.beginPath(); ctx.arc(b.x, b.y, Math.max(2, 3.2 * b.scale + 1.2), 0, TAU);
            ctx.globalAlpha = 1; ctx.fillStyle = port.open ? v.color : pal.bg; ctx.fill(); stroke(edge, 1, look.lineWidth);
          }
        }
        if (n.cls === 'resource' && item.c.scale > .22) {   // read: a hollow ring on the left; write: a solid square on the right
          const y = item.maxY + 4.5, r = 2.6;
          ctx.setLineDash(NO_DASH); ctx.globalAlpha = 1; ctx.lineWidth = 1.2; ctx.strokeStyle = v.color; ctx.fillStyle = v.color;
          if (n.reads) { ctx.beginPath(); ctx.arc(item.c.x - 5, y, r, 0, TAU); ctx.stroke(); }
          if (n.writes) ctx.fillRect(item.c.x + 5 - r, y - r, r * 2, r * 2);
        }
        if (v.badge) {
          // The mark stands clear of the shape, up and to the right. On the shape's corner its backdrop hid half of a small node.
          const s = badgeSize(item.c.scale), out = (s + 2.5) * BADGE_OUT;
          drawBadge(ctx, v.badge, item.maxX + out, item.minY - out, s, pal.state[n.status], pal.bg);
        }
        this.hit.push({ id: n.id, hull: item.hull, x: item.c.x, y: item.c.y, depth: item.c.depth, base: item.base });
      }

      /* 5. Captions by level of detail. They are placed in priority order, and one that would cover
            another (or one of the page's overlays) is left out: pointing at the shape shows it. */
      const reference = Math.min(w, h) * 1.28 / this.camera.distance, cap = reference < .45 ? 18 : reference < 1 ? 34 : 64, wanted = [];
      const chosen = model.nodes.get(this.selected), near = chosen && chosen.col !== L.DOCK ? chosen.col : null;   // the selected node's column is read first
      for (const item of vis.values()) {
        const n = item.n, s = item.c.scale, rank = M.STATES[n.status].rank;
        let priority = -1;
        if (n.id === this.selected) priority = 0;
        else if (n.id === this.hover) priority = 1;
        else if (n.cls === 'agent') priority = 2 + rank / 10;
        else if (n.cls === 'stack') { if (s >= .2) priority = 3; }
        else if (n.status === 'needs' || n.status === 'failed') { if (s >= .3) priority = 4; }
        else if (busy.has(n.id)) { if (s >= .3) priority = 5; }
        else if (n.cls === 'mcp') { if (s >= .3) priority = 6; }
        else if (n.col === near) { if (s >= .3) priority = 6.5; }
        else if (s >= .62) priority = 7 + rank / 10;
        if (priority >= 0) wanted.push({ item, priority });
      }
      wanted.sort((a, b) => a.priority - b.priority || a.item.c.depth - b.item.c.depth || (a.item.n.id < b.item.n.id ? -1 : 1));
      this.labels = [];
      let resting = 0, skipped = 0;
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      for (const { item, priority } of wanted) {
        const n = item.n, focus = priority < 2, s = item.c.scale;
        if (!focus && resting >= cap) { skipped++; continue; }
        // Each line: its text, its font and its colour. The first names the node; the last gives its state.
        const lines = [{ text: this.captionOf(n, focus), font: (focus ? 'bold ' : '') + px(focus ? 11 : 10) + look.font, color: focus ? pal.ink : captionColor(pal, item.v.color) }];
        // The title of an agent's tab, under its name, only while the pointer is on the agent. It is shown as written.
        const title = n.id === this.hover ? this.titleOf(n) : '';
        if (title) lines.push({ text: title, font: px(10) + look.font, color: pal.ink, title: true });
        if (n.cls !== 'stack' && (focus || (n.cls === 'agent' ? s >= .34 : s >= 1))) lines.push({ text: look.caption(this.detailOf(n)), font: px(9) + look.font, color: pal.muted });
        const widths = lines.map(line => { ctx.font = line.font; return ctx.measureText(line.text).width; });
        const bw = Math.max(...widths) + 8, bh = lines.length * 12 * k + 3, marks = n.cls === 'resource' ? 9 : 3;
        // Four places to try. A node in the left or right third of its cell tries its outer side first, so a full cell can be read.
        const at = (x, y) => ({ x, y, w: bw, h: bh, id: n.id });
        // A state mark takes room up and to the right of its shape (see where it is drawn): a caption there starts beyond it.
        const mark = item.v.badge ? (badgeSize(s) + 2.5) * (1 + BADGE_OUT) : 0;
        const below = at(item.c.x - bw / 2, item.maxY + marks), above = at(item.c.x - bw / 2, item.minY - bh - (mark ? mark + 2 : 4));
        const right = at(item.maxX + (mark ? mark + 3 : 5), item.c.y - bh / 2), left = at(item.minX - bw - 5, item.c.y - bh / 2);
        const third = n.cls === 'agent' ? 1 : n.slot % 3, tries = third === 0 ? [left, below, above, right] : third === 2 ? [right, below, above, left] : [below, above, right, left];
        const blocked = b => b.x < 0 || b.x + b.w > w || b.y < 0 || b.y + b.h > h || placed.some(other => overlap(other, b));
        let box = tries.find(b => !blocked(b));
        if (!box) {
          if (!focus || placed.some(other => other.id && overlap(other, below))) { skipped++; continue; }
          box = below;                                     // the selected or pointed-at node is always named
        }
        box.lines = lines.map(line => line.text); box.title = title;
        placed.push(box); this.labels.push(box);
        if (!focus) resting++;
        // A caption is see-through: no plate behind it, so it never hides the shapes it lies over. A thin outline
        // in the background's colour, around the letters only, keeps it readable where a line runs through it.
        if (pal.captionBack > 0) { ctx.globalAlpha = pal.captionBack; ctx.fillStyle = pal.bg; ctx.fillRect(box.x, box.y, box.w, box.h); }
        lines.forEach((line, i) => {
          const x = box.x + bw / 2, y = box.y + (11 + i * 12) * k;
          ctx.font = line.font;
          if (pal.captionHalo > 0) { ctx.globalAlpha = pal.captionHalo; ctx.strokeStyle = pal.bg; ctx.lineWidth = 3; ctx.setLineDash(NO_DASH); ctx.strokeText(line.text, x, y); }
          ctx.globalAlpha = 1; ctx.fillStyle = line.color; ctx.fillText(line.text, x, y);
        });
      }
      ctx.globalAlpha = 1; ctx.setLineDash(NO_DASH);

      /* 6. What is left to do after this frame: one more frame when an ended call's trace runs out,
            and frames in a row only while a pulse is travelling (motion is off unless the owner turns it on). */
      this.armGlow();
      if (this.motion) {
        let moving = false;
        for (const [id, at] of this.pulses) { if (now - at < GLOW_MS) moving = true; else this.pulses.delete(id); }
        if (moving) this.redraw.request('motion');
      }
      this.stats = { frames: this.redraw.frames, ms: this.redraw.now() - started, nodes: vis.size, links, labels: this.labels.length, skipped, offscreen };
      if (this.onFrame) this.onFrame(this.stats, reasons || new Set());
    }

    /** Ask for one frame when the oldest trace of an ended call is due to go, and only if it is still on screen then. */
    armGlow() {
      if (this.glowTimer !== null || !this.afterglow.length) return;
      const wait = Math.min(...this.afterglow.map(g => g.until)) - this.redraw.now() + 4;
      this.glowTimer = this.redraw.setTimeout(() => {
        this.glowTimer = null;
        const now = this.redraw.now();
        if (this.afterglow.some(g => g.until <= now)) this.redraw.request('decay'); else this.armGlow();
      }, Math.max(1, wait));
    }

    /**
     * The look's backdrop, behind the floors. The look is asked for it once for these columns and this floor spacing; after
     * that a frame only projects what was kept: one path for each item, whatever the number of segments in it.
     */
    drawBackdrop(cols) {
      const look = this.look;
      if (typeof look.backdrop !== 'function') { this.backdropKept = null; this.backdropInfo = null; return; }
      const key = cols.join(',') + '|' + this.spread;
      let kept = this.backdropKept;
      if (!kept || kept.look !== look || kept.key !== key) {
        let items = [], error = '';
        try { items = look.backdrop(backdropScene(cols, this.spread)); } catch (e) { error = String(e && e.message || e); }      // a look's mistake must not stop the scene
        kept = this.backdropKept = Object.assign(compileBackdrop(items, look.palette), { look, key });
        this.backdropInfo = Object.assign({}, kept.count, { over: kept.over, error });
      }
      const ctx = this.ctx, c = this.camera, w = this.width, h = this.height, hw = w / 2, hh = h / 2, lens = Math.min(w, h) * 1.28;
      const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch), tx = c.target[0], ty = c.target[1], tz = c.target[2], far = c.distance;
      for (const op of kept.ops) {
        if (op.kind === 'text') {
          const q = project(op.at, c, w, h);
          if (!q) continue;
          ctx.globalAlpha = op.alpha; ctx.fillStyle = op.color; ctx.font = op.size + 'px ' + look.font; ctx.textAlign = op.align; ctx.textBaseline = 'alphabetic';
          ctx.fillText(op.text, q.x, q.y);
          continue;
        }
        const xyz = op.xyz;
        ctx.beginPath();
        if (op.kind === 'lines') {
          let at = 0;
          for (const points of op.runs) {
            let pen = false;
            for (let i = 0; i < points; i++, at += 3) {
              const x = xyz[at] - tx, y = xyz[at + 1] - ty, z = xyz[at + 2] - tz, rx = x * cy - z * sy, rz = x * sy + z * cy, depth = -y * sp + rz * cp + far;
              if (depth < 20) { pen = false; continue; }
              const scale = lens / depth, sx = hw + rx * scale, sy2 = hh - (y * cp + rz * sp) * scale;
              if (pen) ctx.lineTo(sx, sy2); else { ctx.moveTo(sx, sy2); pen = true; }
            }
          }
          ctx.globalAlpha = op.alpha; ctx.strokeStyle = op.color; ctx.lineWidth = op.width; ctx.setLineDash(op.dash); ctx.stroke();
        } else {
          for (let at = 0; at < xyz.length; at += 3) {
            const x = xyz[at] - tx, y = xyz[at + 1] - ty, z = xyz[at + 2] - tz, rx = x * cy - z * sy, rz = x * sy + z * cy, depth = -y * sp + rz * cp + far;
            if (depth < 20) continue;
            const scale = lens / depth, sx = hw + rx * scale, sy2 = hh - (y * cp + rz * sp) * scale;
            ctx.moveTo(sx + op.size, sy2); ctx.arc(sx, sy2, op.size, 0, TAU);
          }
          ctx.globalAlpha = op.alpha; ctx.fillStyle = op.color; ctx.fill();
        }
      }
      ctx.globalAlpha = 1; ctx.setLineDash(NO_DASH);
    }

    /* ----- picking: the node whose outline holds the pointer; ties go to the nearest centre, then the nearest in depth ----- */
    pick(x, y) {
      let best = null;
      for (const h of this.hit) {
        const d = Math.hypot(h.x - x, h.y - y);
        if (d > MIN_HIT && !inHull(h.hull, x, y)) continue;
        if (!best || d < best.d - .5 || (Math.abs(d - best.d) <= .5 && h.depth < best.depth)) best = { id: h.id, d, depth: h.depth };
      }
      return best ? best.id : null;
    }

    bind() {
      const canvas = this.canvas, pointers = new Map();
      let drag = null, pinch = null;
      const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      canvas.addEventListener('contextmenu', e => e.preventDefault());
      canvas.addEventListener('pointerdown', e => {
        canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]);
        drag = { x: e.clientX, y: e.clientY, total: 0, pan: e.shiftKey || e.button === 2 };
        if (pointers.size === 2) { const p = [...pointers.values()]; pinch = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]); }
      });
      canvas.addEventListener('pointermove', e => {
        if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
        if (pointers.size === 2) {
          const p = [...pointers.values()], d = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
          if (pinch && d > 0) this.zoom(pinch / d);
          pinch = d; if (drag) drag.total = 99;
          return;
        }
        if (drag && pointers.size) {
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          drag.total += Math.abs(dx) + Math.abs(dy); drag.x = e.clientX; drag.y = e.clientY;
          if (drag.total >= 4) { canvas.classList.add('dragging'); if (drag.pan) this.pan(dx, dy); else this.orbit(dx * .006, dy * .005); }
          return;
        }
        const at = local(e), id = this.pick(at[0], at[1]) || '';
        if (id !== this.hover) { this.hover = id; canvas.classList.toggle('pointing', !!id); this.redraw.request('input'); if (this.onHover) this.onHover(id); }
      });
      const release = e => {
        if (drag && drag.total < 4) { const at = local(e); if (this.onSelect) this.onSelect(this.pick(at[0], at[1]) || ''); }
        pointers.delete(e.pointerId);
        if (!pointers.size) { drag = null; pinch = null; canvas.classList.remove('dragging'); }
        else if (pointers.size === 1) { const p = [...pointers.values()][0]; drag = { x: p[0], y: p[1], total: 99, pan: false }; pinch = null; }
      };
      canvas.addEventListener('pointerup', release);
      canvas.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); drag = null; pinch = null; canvas.classList.remove('dragging'); });
      canvas.addEventListener('pointerleave', () => { if (this.hover) { this.hover = ''; canvas.classList.remove('pointing'); this.redraw.request('input'); if (this.onHover) this.onHover(''); } });
      canvas.addEventListener('wheel', e => { e.preventDefault(); this.zoom(Math.exp(Math.max(-100, Math.min(100, e.deltaY)) * .002)); }, { passive: false });
      canvas.addEventListener('keydown', e => {
        if (this.onKey && this.onKey(e)) { e.preventDefault(); return; }
        const keys = {
          ArrowLeft: () => this.orbit(-.1, 0), ArrowRight: () => this.orbit(.1, 0), ArrowUp: () => this.orbit(0, .08), ArrowDown: () => this.orbit(0, -.08),
          '+': () => this.zoom(.88), '=': () => this.zoom(.88), '-': () => this.zoom(1.14), f: () => this.frame(this.isolated == null ? undefined : [this.isolated]), r: () => this.resetCamera()
        };
        const key = e.shiftKey || !e.key.startsWith('Arrow') ? e.key : '';
        if (keys[key] && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); keys[key](); }
      });
    }
  }

  const api = { View, Redraw, project, arch, hull, inHull, overlap, shapes, strokes, seeded, BACKDROP, backdropScene, compileBackdrop, drawBadge, drawIcon,
    GROUND, groundProblem, paintGround, groundColors, CAPTION_FLOOR, luminance, contrast, captionColor, ICON, iconCamera, DATA_GAP, GLOW_MS, MIN_HIT, MAX_GROWTH, CAMERA, PROVIDERS, TITLE_SHOWN };
  if (inNode) module.exports = api; else root.MonitorEngine = api;
})(typeof window === 'undefined' ? globalThis : window);
