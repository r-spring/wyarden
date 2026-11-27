// Monitor 3D mock-up: a loopback-only preview. No packages; it serves the files listed below and nothing else.
//   node serve.js [port]        (default 4330)
// Adapted from the Entridir repository (GPL v3), commit 63197c31, nexus-3d/ui-concepts/nexus-lattice-29d4d1/serve.js.
// Changed: the file list, and a policy that lets the page load nothing but its own scripts and style.
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');

const FILES = ['index.html', 'style.css', 'layout.js', 'model.js', 'feed.js', 'engine.js', 'look-nexus.js', 'look-glasshouse.js', 'nav.js', 'app.js'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'";

function create() {
  return http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (!FILES.includes(name) || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404); res.end('Not found'); return; }
    fs.readFile(path.join(__dirname, name), (error, body) => {
      if (error) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': POLICY });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  });
}
/** Listen on the loopback address only. Port 0 picks a free port. */
function listen(port) {
  return new Promise((resolve, reject) => {
    const server = create();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { create, listen, FILES, HOST: '127.0.0.1' };
if (require.main === module) {
  listen(Number(process.argv[2] || 4330)).then(server => {
    console.log('Monitor 3D mock-up: http://127.0.0.1:' + server.address().port + '/\nSimulated feed, invented data. Ctrl+C stops this preview.');
  }, error => { console.error('Could not start the preview: ' + error.message); process.exit(1); });
}
