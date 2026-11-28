#!/usr/bin/env node
/* Wyarden 3D monitor: the live tab's page in a browser, on invented data.
 *
 *   node ui-concepts/monitor-3d-live/tools/preview.js [port]
 *
 * Serves the page the VSIX carries, media/page.html with its page.js, style.css, engine and look files, from a
 * server on 127.0.0.1 only, and prints its address. With no port it takes a free one. Ctrl+C stops it.
 *
 * The page is filled as the extension host fills it (lib/view.js): the host's own content security policy, a
 * nonce, the media folder's address. Before the page's scripts come two more, with the same nonce: the older
 * page's seeded simulator (ui-concepts/monitor-3d/feed.js, read from where it is) and a stand-in for the editor
 * (tools/preview/editor.js). Neither is in media/, so neither ships. Nothing is installed, nothing is fetched
 * from the network, nothing is written.
 *
 * The address carries the choices: ?look=<id>, ?seed=<integer>, ?agents=1|4|12, ?load=quiet|busy, ?warm=<s>.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const MEDIA = path.join(ROOT, 'media');
const HOST = '127.0.0.1';
/** What the preview adds, by its address: the simulator and the stand-in. Nothing else outside media/ is served. */
const EXTRA = {
  '/preview/feed.js': path.resolve(ROOT, '..', 'monitor-3d', 'feed.js'),
  '/preview/editor.js': path.join(__dirname, 'preview', 'editor.js')
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

/** media/page.html as the host fills it, with the simulator and the stand-in before the page's first script. */
function page(nonce) {
  const view = require('../lib/view.js');
  const html = view.fillTemplate(fs.readFileSync(path.join(MEDIA, 'page.html'), 'utf8'), { csp: view.policy(nonce), nonce, base: '/media' });
  const at = html.indexOf('<script');
  if (at < 0) throw new Error('media/page.html has no script tag');
  const ours = Object.keys(EXTRA).map(src => '<script nonce="' + nonce + '" src="' + src + '"></script>\n').join('');
  return html.slice(0, at) + ours + html.slice(at);
}

/** Start the server. Resolves to { server, port, url, close() }; rejects when the port cannot be had. */
function start({ port = 0 } = {}) {
  const server = http.createServer((req, res) => {
    const send = (code, type, body) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    // Only this machine's own name for the server: a page elsewhere that points a name of its own at 127.0.0.1 gets nothing.
    const own = server.address().port, host = String(req.headers.host || '');
    if (host !== HOST + ':' + own && host !== 'localhost:' + own) return send(421, 'text/plain; charset=utf-8', 'this preview answers only at http://' + HOST + ':' + own + '/');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain; charset=utf-8', 'only GET');
    let pathname;
    try { pathname = new URL(req.url, 'http://' + HOST).pathname; } catch { return send(400, 'text/plain; charset=utf-8', 'bad address'); }
    if (pathname === '/' || pathname === '/page.html') return send(200, TYPES['.html'], page(crypto.randomBytes(18).toString('base64url')));
    if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (Object.prototype.hasOwnProperty.call(EXTRA, pathname)) return send(200, TYPES['.js'], fs.readFileSync(EXTRA[pathname]));
    const m = /^\/media\/([A-Za-z0-9._-]+)$/.exec(pathname);
    if (m && !m[1].startsWith('.')) {
      const file = path.join(MEDIA, m[1]);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return send(200, TYPES[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file));
    }
    send(404, 'text/plain; charset=utf-8', 'not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.removeListener('error', reject);
      const at = server.address().port;
      resolve({
        server, port: at, url: 'http://' + HOST + ':' + at + '/',
        close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); })
      });
    });
  });
}

/** The command. Resolves once the server listens; the process then runs until Ctrl+C. */
async function main(argv, out = console) {
  const arg = argv[0];
  if (arg !== undefined && (!/^\d{1,5}$/.test(arg) || Number(arg) > 65535)) {
    out.error('usage: node ui-concepts/monitor-3d-live/tools/preview.js [port]   (a port up to 65535; none, or 0, takes a free one)');
    process.exitCode = 2;
    return null;
  }
  let p;
  try { p = await start({ port: arg === undefined ? 0 : Number(arg) }); } catch (error) {
    out.error(error.code === 'EADDRINUSE' ? 'port ' + arg + ' on ' + HOST + ' is in use: name another, or none for a free one' : 'the preview could not start: ' + error.message);
    process.exitCode = 1;
    return null;
  }
  const looks = require('../media/looks.js').ids();
  out.log('3D Monitor preview, the live tab\'s page on invented data: ' + p.url);
  out.log('  on another look:   ' + p.url + '?look=' + (looks.find(id => id !== 'nexus') || 'nexus'));
  out.log('  other choices:     ?seed=7  ?agents=1|4|12  ?load=quiet|busy  ?warm=60');
  out.log('  looks:             ' + looks.join(', '));
  out.log('Ctrl+C stops it.');
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    p.close().then(() => { out.log('stopped'); process.exit(0); });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, stop);
  return p;
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { start, main, page, EXTRA, HOST };
