// The browser preview (tools/preview.js): the live tab's own page, served on loopback, fed by a stand-in for
// the editor on invented data. The server, loopback and VSIX checks need no browser; the page checks need Edge
// or Chrome (headless, a temporary profile, as test/page-harness.js runs it) and are skipped with a reason
// without one. Pictures go to .scratch/preview/ beside this extension, which git ignores.
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PREVIEW = path.join(ROOT, 'tools', 'preview.js');
const P = require('../tools/preview.js');
const R = require('../media/looks.js');
const view = require('../lib/view.js');
const { findBrowser, Harness, sleep } = require('./page-harness.js');
const SHOTS = path.join(ROOT, '.scratch', 'preview');

/** GET on the preview. Resolves to { status, headers, body: Buffer }. */
function get(url, headers) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: headers || {} }, res => { const parts = []; res.on('data', d => parts.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) })); }).on('error', reject);
  });
}
/** Run the command in a child process until `until(stdout)` holds; resolves to { child, out, err }. */
function run(args, until, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: path.resolve(ROOT, '..', '..'), env: Object.assign({}, process.env, env || {}), windowsHide: true });
    let out = '', err = '', done = false;
    const finish = fn => { if (!done) { done = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => finish(() => { child.kill(); reject(new Error('the preview said nothing in time: ' + out + err)); }), 15000);
    child.stdout.on('data', d => { out += d; if (until(out)) finish(() => resolve({ child, out, err })); });
    child.stderr.on('data', d => { err += d; });
    child.on('exit', code => finish(() => resolve({ child, out, err, code })));
  });
}
const exited = child => new Promise(resolve => { if (child.exitCode !== null) resolve(child.exitCode); else child.once('exit', code => resolve(code)); });
/** The names in a zip's central directory (the VSIX that tools/pack.js wrote). */
function zipNames(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'the VSIX has a central directory');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(at), 0x02014b50, 'a central directory entry');
    const n = buffer.readUInt16LE(at + 28), extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32);
    names.push(buffer.subarray(at + 46, at + 46 + n).toString('utf8'));
    at += 46 + n + extra + comment;
  }
  return names;
}

describe('the preview server', () => {
  let p;
  before(async () => { p = await P.start({ port: 0 }); });
  after(async () => { if (p) await p.close(); });

  it('binds 127.0.0.1 only, and answers no other name for itself', async () => {
    assert.equal(p.server.address().address, '127.0.0.1');
    assert.equal(p.url, 'http://127.0.0.1:' + p.port + '/');
    // Every other IPv4 address of this machine is refused at that port.
    const others = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
    for (const address of others) {
      const refused = await new Promise(resolve => {
        const s = net.connect({ host: address, port: p.port });
        s.setTimeout(1500, () => { s.destroy(); resolve('timeout'); });
        s.once('connect', () => { s.destroy(); resolve(false); });
        s.once('error', () => resolve(true));
      });
      assert.notEqual(refused, false, 'the preview answered on ' + address);
    }
    if (!others.length) console.log('NOTE preview: this machine has no other IPv4 address; only the bound address was checked');
    const elsewhere = await get(p.url, { Host: 'preview.example.com:' + p.port });
    assert.equal(elsewhere.status, 421, 'a request under another host name is refused');
  });

  it('serves media/page.html filled as the host fills it, with the stand-in and the simulator before the page\'s scripts', async () => {
    const r = await get(p.url);
    assert.equal(r.status, 200);
    const html = r.body.toString('utf8');
    assert.ok(!html.includes('{{'), 'every placeholder is filled');
    const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(html);
    assert.ok(nonce, 'the page carries a nonce in its policy');
    assert.ok(html.includes('content="' + view.policy(nonce[1]) + '"'), 'the host\'s own policy, unchanged');
    const scripts = [...html.matchAll(/<script nonce="([^"]+)" src="([^"]+)"><\/script>/g)];
    assert.ok(scripts.every(s => s[1] === nonce[1]), 'every script has the nonce');
    const page = fs.readFileSync(path.join(ROOT, 'media', 'page.html'), 'utf8');
    const theirs = [...page.matchAll(/src="\{\{base\}\}\/([^"]+)"/g)].map(m => '/media/' + m[1]);
    assert.deepEqual(scripts.map(s => s[2]), ['/preview/feed.js', '/preview/editor.js', ...theirs], 'the page\'s own scripts, in its order, after the two of the preview');
    assert.equal([...html.matchAll(/<script/g)].length, scripts.length, 'no inline script');
  });

  it('serves the very files the VSIX carries, and nothing outside media/ but its own two', async () => {
    for (const name of ['page.js', 'style.css', 'engine.js', 'looks.js', 'host-feed.js', 'look-nexus.js', 'look-glasshouse.js']) {
      const r = await get(p.url + 'media/' + name);
      assert.equal(r.status, 200, name);
      assert.ok(r.body.equals(fs.readFileSync(path.join(ROOT, 'media', name))), name + ' is the file on disk, byte for byte');
    }
    assert.ok((await get(p.url + 'preview/feed.js')).body.equals(fs.readFileSync(path.resolve(ROOT, '..', 'monitor-3d', 'feed.js'))), 'the older page\'s simulator, from where it is');
    for (const bad of ['media/../lib/view.js', 'media/%2e%2e%2flib%2fview.js', 'lib/view.js', 'tools/preview.js', 'package.json', 'media/.hidden', 'preview/../../package.json'])
      assert.equal((await get(p.url + bad)).status, 404, bad);
  });
});

describe('the preview command', () => {
  it('runs with one command, prints its address, and serves the page there', async () => {
    const { child, out } = await run([PREVIEW], text => /stops it/.test(text));
    try {
      const url = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      assert.ok(url, 'it prints the address: ' + out);
      assert.match(out, /\?look=/, 'and an address with a look');
      assert.equal((await get(url[1])).status, 200);
    } finally { child.kill(); await exited(child); }
  });

  it('stops cleanly on Ctrl+C (its SIGINT handler closes the server and exits with 0)', async () => {
    // A child on Windows cannot be sent a real Ctrl+C from here, so the child raises the signal on itself.
    const code = 'require(' + JSON.stringify(PREVIEW) + ').main([]).then(p => { const s = p.server; s.on("close", () => console.log("closed")); setTimeout(() => process.emit("SIGINT", "SIGINT"), 200); });';
    const { child, out } = await run(['-e', code], text => /stopped/.test(text));
    const status = await exited(child);
    assert.match(out, /closed[\s\S]*stopped/, 'the server closed, then it said so: ' + out);
    assert.equal(status, 0);
  });

  it('says so, and exits with 1, when the port is taken; and refuses a port that is not one', async () => {
    const blocker = net.createServer();
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    try {
      const taken = String(blocker.address().port);
      const r = await run([PREVIEW, taken], () => false);
      assert.equal(r.code, 1);
      assert.match(r.err, /in use/);
    } finally { blocker.close(); }
    const bad = await run([PREVIEW, 'eighty'], () => false);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /usage/);
  });
});

describe('the VSIX', () => {
  it('carries the page and no part of the preview', () => {
    const { out, entries } = require('../tools/pack.js').build();
    const names = zipNames(fs.readFileSync(out));
    assert.deepEqual(names, entries.map(e => e.name), 'the archive holds what pack.js listed');
    for (const name of ['extension/media/page.html', 'extension/media/page.js', 'extension/media/host-feed.js']) assert.ok(names.includes(name), name);
    assert.deepEqual(names.filter(n => /(^|\/)tools\/|preview/i.test(n)), [], 'nothing of tools/ and nothing named preview');
  });
});

const browser = findBrowser();
const skip = browser.path ? false : 'NO BROWSER: ' + browser.why + '; the preview was not checked in a page';
if (skip) console.log(skip);
const T = { timeout: 120000, skip };

const centre = selector => `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  return { x, y, w: r.width, h: r.height, inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, onTop: e.contains(document.elementFromPoint(x, y)) }; })()`;
const SHOWN = `({ look: document.documentElement.dataset.look, chosen: Monitor3D.state.lookChosen, pressed: [...document.querySelectorAll('button[data-look][aria-pressed="true"]')].map(b => b.dataset.look),
  search: location.search, title: document.title, frames: Monitor3D.view.redraw.frames, nodes: Monitor3D.view.stats.nodes, strokes: __m.strokes, csp: __m.csp, errors: __m.errors,
  sessions: [...Monitor3D.model.sessions.keys()], classes: [...new Set([...Monitor3D.model.nodes.values()].map(n => n.cls))],
  chips: [...document.querySelectorAll('#chips .chip')].map(b => ({ scope: b.dataset.scope, name: b.querySelector('.chip-name').textContent, pressed: b.getAttribute('aria-pressed') })),
  status: document.getElementById('status').textContent, scope: Monitor3D.state.scope, preview: window.MonitorPreview, theme: matchMedia('(prefers-color-scheme: light)').matches ? 'glasshouse' : 'nexus' })`;

describe('the preview in a headless browser', () => {
  let h, p;
  before(async () => {
    if (skip) return;
    p = await P.start({ port: 0 });
    h = await Harness.start(browser.path);
    fs.mkdirSync(SHOTS, { recursive: true });
  });
  after(async () => { if (h) await h.close(); if (p) await p.close(); });

  /** Open the preview at `query`, as a person would, and wait until the page has drawn the first snapshot. */
  async function open(query, size) {
    await h.cdp.send('Emulation.setDeviceMetricsOverride', Object.assign({ width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, size || {}));
    h.errors = [];
    const loaded = new Promise(resolve => h.cdp.once('Page.loadEventFired', resolve));
    await h.cdp.send('Page.navigate', { url: p.url + (query || '') });
    await Promise.race([loaded, sleep(10000)]);
    for (let i = 0; i < 100; i++) { if (await h.eval('!!(window.Monitor3D && Monitor3D.state.snapshots > 0 && Monitor3D.view.redraw.frames > 0)').catch(() => false)) break; await sleep(50); }
    await sleep(400);
    return h.eval(SHOWN);
  }
  async function clickOn(selector) {
    const at = await h.eval(centre(selector));
    assert.ok(at, selector + ' is in the page');
    assert.ok(at.w > 0 && at.h > 0 && at.inView && at.onTop, selector + ' is in view and not covered: ' + JSON.stringify(at));
    await h.click(at.x, at.y);
    await sleep(200);
  }
  const clean = s => { assert.deepEqual(h.errors, [], 'no script error'); assert.deepEqual(s.errors, [], 'no error in the page'); assert.deepEqual(s.csp, [], 'nothing the policy refused'); };

  it('draws the live tab\'s page on the invented feed: four providers, every class, the chips, under the host\'s policy', T, async () => {
    const s = await open('');
    clean(s);
    assert.ok(s.frames > 0 && s.nodes > 10 && s.strokes > 0, 'the scene was drawn: ' + JSON.stringify({ frames: s.frames, nodes: s.nodes, strokes: s.strokes }));
    assert.deepEqual(s.sessions.map(k => k.split(':')[0]).sort(), ['antigravity', 'claude', 'codex', 'grok'], 'one session for each provider');
    for (const cls of ['agent', 'tool', 'resource', 'mcp']) assert.ok(s.classes.includes(cls), cls + ' in the scene: ' + s.classes);
    const seen = s.preview.seen;
    assert.ok(seen.ev['subagent.start'] > 0, 'a subagent');
    assert.ok(seen.ev['tool.start'] > 0 && seen.ev['tool.end'] > 0 && seen.ev['mcp.start'] > 0 && seen.ev['mcp.end'] > 0, 'calls that start and end');
    assert.ok(seen.waits > 0, 'a wait for the owner');
    assert.ok(seen.failed > 0, 'a failure');
    assert.ok(seen.touches.file > 0, 'files');
    assert.deepEqual(s.chips.map(c => c.name), ['All open', 'demo-shop', 'notes-app'], 'two invented windows and "All open"');
    assert.equal(s.scope, 'all');
    assert.match(s.status, /^Hub: running in this window\. Showing 4 sessions\./);
    assert.equal(s.look, s.theme, 'with no look in the address the colour scheme picks one, as the host does');
    assert.match(s.title, /preview/);
    // The stream goes on: events keep coming in after the first snapshot.
    const before = await h.eval('Monitor3D.model.counts.events');
    await sleep(3000);
    assert.ok(await h.eval('Monitor3D.model.counts.events') > before, 'the stream goes on');
    clean(await h.eval(SHOWN));
  });

  it('a real click on a look\'s button changes the look, and the address follows', T, async () => {
    let s = await open('');
    const target = s.look === 'glasshouse' ? 'nexus' : 'glasshouse';
    await clickOn('#look-name');
    await clickOn('#look-panel button[data-look="' + target + '"]');
    s = await h.eval(SHOWN);
    clean(s);
    assert.deepEqual([s.look, s.pressed, s.chosen], [target, [target], true]);
    assert.equal(new URLSearchParams(s.search).get('look'), target, 'the address names the look chosen');
    await h.screenshot(path.join(SHOTS, 'clicked-' + target + '.png'));
  });

  it('?look=<id> opens on that look; an id that is not a look is ignored', T, async () => {
    const ids = R.ids(), id = ids[ids.length - 1];
    let s = await open('?look=' + id);
    clean(s);
    assert.deepEqual([s.look, s.pressed, s.chosen], [id, [id], true], '?look=' + id);
    for (const other of ['glasshouse-mockup', 'nexus-mockup']) {
      s = await open('?look=' + other);
      clean(s);
      assert.deepEqual([s.look, s.pressed], [other, [other]], '?look=' + other);
      await h.screenshot(path.join(SHOTS, other + '.png'));
    }
    for (const bad of ['no-such-look', 'toString', '__proto__', '']) {
      s = await open('?look=' + encodeURIComponent(bad));
      clean(s);
      assert.deepEqual([s.look, s.chosen], [s.theme, false], '?look=' + bad + ' is ignored');
    }
  });

  it('a chip shows one invented window, and "All open" all of them', T, async () => {
    let s = await open('');
    const second = s.preview.windows[1];
    await clickOn('#chips .chip[data-scope="' + second.key + '"]');
    await sleep(300);
    s = await h.eval(SHOWN);
    clean(s);
    assert.equal(s.scope, second.key);
    assert.deepEqual(s.sessions.map(k => k.split(':')[0]).sort(), second.kinds.slice().sort(), 'that window\'s sessions');
    assert.deepEqual(s.chips.filter(c => c.pressed === 'true').map(c => c.scope), [second.key]);
    await clickOn('#chips .chip[data-scope="all"]');
    await sleep(300);
    s = await h.eval(SHOWN);
    assert.equal(s.scope, 'all');
    assert.equal(s.sessions.length, 4);
  });

  it('?agents=, ?load= and ?seed= choose the stream, as on the older page', T, async () => {
    let s = await open('?agents=1&load=quiet');
    clean(s);
    assert.deepEqual([s.preview.options.agents, s.preview.options.load, s.sessions.length, s.sessions[0].split(':')[0]], [1, 'quiet', 1, 'claude']);
    s = await open('?agents=12');
    clean(s);
    assert.equal(s.preview.options.agents, 12);
    assert.equal(await h.eval('Monitor3D.model.sessions.size + Monitor3D.model.overflow.size'), 12, 'twelve sessions, in the scene or left out');
    const seven = (await open('')).sessions, three = (await open('?seed=3')).sessions;
    assert.notDeepEqual(three, seven, 'another seed, another stream');
    assert.deepEqual((await open('?seed=7')).sessions, seven, 'the same seed, the same stream');
    s = await open('?agents=5&load=loud&seed=x');
    assert.deepEqual([s.preview.options.agents, s.preview.options.load, s.preview.options.seed], [4, 'busy', 7], 'a choice that is not one is left at its default');
  });
});
