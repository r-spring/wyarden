#!/usr/bin/env node
/* Wyarden 3D monitor: the picture of a look.
 *
 *   node ui-concepts/monitor-3d-live/tools/shoot-looks.js <id> [<id> ...]
 *
 * Writes docs/looks/img/<id>.png for each id named, and for no other: the whole page at 1280 x 720,
 * in that look, on the one fixed invented scene (test/fixtures/looks/scene.js) that shows every
 * class and state. The agent that needs its owner is selected, so the inspector is filled.
 *
 * A look that reads its colours from the page (look.fromPage) may name sets of editor variables to
 * be photographed under: `samples: { dark: { '--vscode-editor-background': '#1e1e1e', ... } }`. Each
 * gives one more picture, docs/looks/img/<id>-<name>.png. <id>.png itself is taken with none of the
 * editor's variables, so it shows the look's fixed fall-backs.
 *
 * It refuses an id that is not in the list (media/looks.js) and a look that is still a stub: a stub
 * is drawn like NEXUS, and its picture would say otherwise. Nothing is written for a refused id.
 *
 * Needs Edge or Chrome (WYARDEN_BROWSER names another). The browser is headless, with a temporary
 * profile of its own, and the page comes from a server on 127.0.0.1 at a free port: the page tests'
 * harness. No window is opened and nothing is installed.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(ROOT, '..', '..', 'docs', 'looks', 'img');
const R = require('../media/looks.js');
const FIXED = require('../test/fixtures/looks/scene.js');
const { findBrowser, Harness, sleep } = require('../test/page-harness.js');

/** Which of the ids can be photographed, and why the others cannot. */
function sort(ids) {
  const wanted = [], refused = [];
  for (const id of [...new Set(ids)]) {
    if (!R.entry(id)) { refused.push(id + ': not a look (the looks are ' + R.ids().join(', ') + ')'); continue; }
    const look = require('../media/look-' + id + '.js');
    if (look.stub) { refused.push(id + ': not built yet (media/look-' + id + '.js is a stub)'); continue; }
    wanted.push(id);
  }
  return { wanted, refused };
}
/** The sets of editor variables a look asks to be photographed under: [[name, {variable: value}], ...]. A set of another shape is an error. */
function samplesOf(look) {
  if (look.samples === undefined) return [];
  if (!look.samples || typeof look.samples !== 'object') throw new Error(look.id + ': samples must be an object');
  return Object.entries(look.samples).map(([name, vars]) => {
    if (!/^[a-z0-9]{1,16}$/.test(name)) throw new Error(look.id + ': a sample\'s name is lower-case letters and digits, and "' + name + '" is not');
    if (!vars || typeof vars !== 'object') throw new Error(look.id + ': sample "' + name + '" must be an object of variables');
    for (const [key, value] of Object.entries(vars)) if (!/^--vscode-[A-Za-z0-9-]+$/.test(key) || typeof value !== 'string' || !value.trim()) throw new Error(look.id + ': sample "' + name + '" may only set --vscode-… variables to a text, and has "' + key + '"');
    return [name, vars];
  });
}

async function shoot(ids, options = {}) {
  const browser = findBrowser();
  if (!browser.path) throw new Error(browser.why);
  const out = options.out || OUT, written = [];
  fs.mkdirSync(out, { recursive: true });
  const h = await Harness.start(browser.path);
  /** One picture: the look, under a set of the editor's variables or under none. */
  async function one(id, name, vars) {
    await h.open({ width: 1280, height: 720, state: { v: 1, look: id, lookChosen: true } });
    if (vars) await h.eval(`(() => { const set = ${JSON.stringify(vars)}; for (const key of Object.keys(set)) document.documentElement.style.setProperty(key, set[key]); })()`);
    for (const message of FIXED.around()) await h.deliver(message);
    await h.deliver(FIXED.message());
    await sleep(500);
    await h.eval(`Monitor3D.select(${JSON.stringify(FIXED.SELECTED)}, 'model')`);
    await sleep(500);
    const shown = await h.eval('({ look: document.documentElement.dataset.look, nodes: Monitor3D.view.stats.nodes, backdrop: Monitor3D.view.backdropInfo })');
    if (shown.look !== id) throw new Error(id + ': the page shows "' + shown.look + '"');
    if (!shown.nodes) throw new Error(id + ': the scene was not drawn');
    if (h.errors.length) throw new Error(id + ': ' + h.errors.join('; '));
    // The two figures that differ from run to run (frames drawn, the last frame's milliseconds) are set to fixed
    // values, so the same look gives the same picture. Nothing draws at rest, so they stay.
    await h.eval(`(() => { const b = document.querySelectorAll('#hud b'); if (b[0]) b[0].textContent = '1'; if (b[1]) b[1].textContent = '1.0'; })()`);
    await sleep(100);
    const file = path.join(out, id + (name ? '-' + name : '') + '.png');
    await h.screenshot(file);
    written.push({ id, sample: name || '', file, bytes: fs.statSync(file).size, nodes: shown.nodes, backdrop: shown.backdrop });
  }
  try {
    for (const id of ids) {
      const samples = samplesOf(require('../media/look-' + id + '.js'));
      await one(id, '', null);
      for (const [name, vars] of samples) await one(id, name, vars);
    }
  } finally { await h.close(); }
  return written;
}

if (require.main === module) {
  const { wanted, refused } = sort(process.argv.slice(2));
  for (const line of refused) console.error('refused  ' + line);
  if (!process.argv.slice(2).length) console.error('usage: node tools/shoot-looks.js <id> [<id> ...]\n  built looks: ' + R.ids().filter(id => !require('../media/look-' + id + '.js').stub).join(', '));
  if (!wanted.length) process.exit(2);
  shoot(wanted).then(written => {
    for (const w of written) console.log('wrote    ' + path.relative(process.cwd(), w.file).split(path.sep).join('/') + '  (' + w.bytes + ' bytes, ' + w.nodes + ' nodes' + (w.backdrop ? ', backdrop of ' + w.backdrop.segments + ' segments' : '') + ')');
    process.exit(refused.length ? 1 : 0);
  }, error => { console.error('failed   ' + error.message); process.exit(1); });
}

module.exports = { shoot, sort, samplesOf, OUT };
