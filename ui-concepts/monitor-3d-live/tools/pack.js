#!/usr/bin/env node
/* Wyarden 3D monitor, working mock-up: makes the VSIX.
 *
 *   node tools/pack.js            writes dist/wyarden-monitor-3d-<version>.vsix and lists what is in it
 *
 * A VSIX is a zip with two descriptions at its top and the extension under extension/. This
 * extension is plain files with no package and no native code, so the archive is written here with
 * Node's own zlib: no vsce, no npx, no network. One archive serves every system and editor.
 * It installs nothing.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..', '..');
/** What ships: the host's files, the page, and the two texts an editor shows. Tests and tools do not. */
const SHIPPED = ['package.json', 'extension.js', 'README.md', 'lib', 'media'];
const TYPES = { '.json': 'application/json', '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css', '.md': 'text/markdown', '.txt': 'text/plain', '.vsixmanifest': 'text/xml' };

function filesUnder(rel) {
  const full = path.join(ROOT, rel);
  if (fs.statSync(full).isFile()) return [rel];
  // A name that starts with a dot (an editor's or a system's own file) never ships.
  return fs.readdirSync(full, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.')).sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap(entry => (entry.isDirectory() ? filesUnder(path.join(rel, entry.name)) : [path.join(rel, entry.name)]));
}
const xml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function manifest(pkg) {
  return '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">\n' +
    '  <Metadata>\n' +
    '    <Identity Language="en-US" Id="' + xml(pkg.name) + '" Version="' + xml(pkg.version) + '" Publisher="' + xml(pkg.publisher) + '"/>\n' +
    '    <DisplayName>' + xml(pkg.displayName) + '</DisplayName>\n' +
    '    <Description xml:space="preserve">' + xml(pkg.description) + '</Description>\n' +
    '    <Tags>' + xml((pkg.keywords || []).join(',')) + '</Tags>\n' +
    '    <Categories>' + xml((pkg.categories || ['Other']).join(',')) + '</Categories>\n' +
    '    <GalleryFlags>Public</GalleryFlags>\n' +
    '    <Properties>\n' +
    '      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="' + xml(pkg.engines.vscode) + '"/>\n' +
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>\n' +
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>\n' +
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>\n' +
    '      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value=""/>\n' +
    '      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="' + xml(pkg.repository.url) + '"/>\n' +
    '    </Properties>\n' +
    '    <License>extension/LICENSE.txt</License>\n' +
    '  </Metadata>\n' +
    '  <Installation>\n    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>\n  </Installation>\n' +
    '  <Dependencies/>\n' +
    '  <Assets>\n' +
    '    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>\n' +
    '    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>\n' +
    '    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true"/>\n' +
    '  </Assets>\n' +
    '</PackageManifest>\n';
}
function contentTypes(names) {
  const used = new Set(['.vsixmanifest']);
  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    if (!TYPES[ext]) throw new Error('no content type for ' + name + ': add its extension to TYPES, or do not ship it');
    used.add(ext);
  }
  return '<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    [...used].sort().map(ext => '<Default Extension="' + ext + '" ContentType="' + TYPES[ext] + '"/>').join('') + '</Types>\n';
}

/* ---------- a zip, written by hand: deflate, no encryption, no zip64 (the archive is a few hundred KB) ---------- */

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** entries: [{name, data: Buffer}]. Names use forward slashes. Every file gets one fixed time, so the same input gives the same archive. */
function zip(entries) {
  const DOS_TIME = 0, DOS_DATE = (46 << 9) | (1 << 5) | 1;          // 1 January 2026
  const parts = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8'), packed = zlib.deflateRawSync(entry.data, { level: 9 });
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(DOS_TIME, 10); head.writeUInt16LE(DOS_DATE, 12); head.writeUInt32LE(crc32(entry.data), 14);
    head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(entry.data.length, 22); head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(DOS_TIME, 12); dir.writeUInt16LE(DOS_DATE, 14); dir.writeUInt32LE(crc32(entry.data), 16);
    dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(entry.data.length, 24); dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    parts.push(head, name, packed); central.push(dir, name);
    offset += head.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

function build() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const names = SHIPPED.flatMap(filesUnder).map(name => name.split(path.sep).join('/'));
  const license = path.join(REPO, 'LICENSE');
  if (!fs.existsSync(license)) throw new Error('the repository\'s LICENSE was not found at ' + license);
  const entries = [
    { name: 'extension.vsixmanifest', data: Buffer.from(manifest(pkg), 'utf8') },
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes([...names, 'LICENSE.txt']), 'utf8') },
    { name: 'extension/LICENSE.txt', data: fs.readFileSync(license) },
    ...names.map(name => ({ name: 'extension/' + name, data: fs.readFileSync(path.join(ROOT, name)) }))
  ];
  const out = path.join(ROOT, 'dist', pkg.name + '-' + pkg.version + '.vsix');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, zip(entries));
  return { out, entries, pkg };
}

if (require.main === module) {
  const { out, entries } = build();
  for (const entry of entries) console.log(String(entry.data.length).padStart(8) + '  ' + entry.name);
  console.log('\n' + entries.length + ' files, ' + fs.statSync(out).size + ' bytes: ' + out);
}

module.exports = { build, zip, crc32, manifest, contentTypes, SHIPPED };
