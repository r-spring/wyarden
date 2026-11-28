#!/usr/bin/env node
/* Wyarden 3D monitor: the contact sheet of the 18 looks.
 *
 *   node ui-concepts/monitor-3d-live/tools/shoot-sheet.js
 *
 * Writes docs/looks/img/contact-sheet.png, and nothing else: the 18 pictures docs/looks/img/<id>.png in the list's
 * order (docs/looks/looks.json), each with its number, its id and its name under it. The page is tools/contact-sheet.html.
 *
 * It makes no picture of a look: tools/shoot-looks.js does, and this sheet shows what that tool last wrote.
 * Needs Edge or Chrome (WYARDEN_BROWSER names another): headless, a temporary profile of its own, and two servers
 * on 127.0.0.1 at free ports, the page tests' harness and one here for the sheet. Nothing is fetched from the network.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const LOOKS_DIR = path.resolve(ROOT, '..', '..', 'docs', 'looks');
const OUT = path.join(LOOKS_DIR, 'img');
const PAGE = path.join(__dirname, 'contact-sheet.html');
const { findBrowser, Harness, sleep } = require('../test/page-harness.js');

/** The sheet's server: the page, the list and the pictures of the list's ids, and nothing else. */
function sheetServer() {
  const list = JSON.parse(fs.readFileSync(path.join(LOOKS_DIR, 'looks.json'), 'utf8'));
  const ids = new Set(list.map(e => e.id));
  const server = http.createServer((req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', fs.readFileSync(PAGE));
    if (url.pathname === '/looks.json') return send(200, 'application/json', JSON.stringify(list));
    const m = /^\/img\/([a-z-]+)\.png$/.exec(url.pathname);
    if (m && ids.has(m[1]) && fs.existsSync(path.join(OUT, m[1] + '.png'))) return send(200, 'image/png', fs.readFileSync(path.join(OUT, m[1] + '.png')));
    send(404, 'text/plain', 'not found');
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server)); });
}

async function shoot() {
  const browser = findBrowser();
  if (!browser.path) throw new Error(browser.why);
  const h = await Harness.start(browser.path), server = await sheetServer(), written = [];
  try {
    /* The contact sheet. */
    await h.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    const loaded = new Promise(resolve => h.cdp.once('Page.loadEventFired', resolve));
    await h.cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
    await Promise.race([loaded, sleep(10000)]);
    const sheet = await h.eval('window.sheetReady');
    if (sheet.count !== 18) throw new Error('the list has ' + sheet.count + ' looks, not 18');
    if (sheet.missing.length) throw new Error('no picture for ' + sheet.missing.join(', '));
    await h.cdp.send('Emulation.setDeviceMetricsOverride', { width: sheet.width, height: sheet.height, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
    written.push(await h.screenshot(path.join(OUT, 'contact-sheet.png')));
  } finally {
    await h.close();
    await new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  }
  return written.map(file => ({ file, bytes: fs.statSync(file).size }));
}

if (require.main === module) {
  shoot().then(written => {
    for (const w of written) console.log('wrote    ' + path.relative(process.cwd(), w.file).split(path.sep).join('/') + '  (' + w.bytes + ' bytes)');
  }, error => { console.error('failed   ' + error.message); process.exit(1); });
}

module.exports = { shoot, OUT };
