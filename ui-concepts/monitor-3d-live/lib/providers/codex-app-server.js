'use strict';

const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { cleanText, isAbsolute, isSessionId, MAX_PATH } = require('../contract.js');

const MAX_THREADS = 64;
const MAX_LINE = 512 * 1024;

// The Codex proxy forwards raw bytes to the daemon's WebSocket, while a fresh server uses NDJSON.
function proxyWire(child, receive, close, ready) {
  const key = randomBytes(16).toString('base64');
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  let buffer = Buffer.alloc(0);
  let opened = false;
  let parts = [];
  let bytes = 0;
  const frame = (data, opcode) => {
    const size = data.length;
    const header = Buffer.alloc(size < 126 ? 6 : 8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | (size < 126 ? size : 126);
    if (size >= 126) header.writeUInt16BE(size, 2);
    const mask = randomBytes(4);
    mask.copy(header, header.length - 4);
    for (let i = 0; i < size; i++) data[i] ^= mask[i % 4];
    child.stdin.write(Buffer.concat([header, data]));
  };
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!opened) {
      const cut = buffer.indexOf('\r\n\r\n');
      if (cut === -1) { if (buffer.length > 8192) close(); return; }
      if (cut > 8192) return close();
      const headers = buffer.subarray(0, cut).toString('ascii').split('\r\n');
      if (!/^HTTP\/1\.1 101\b/.test(headers[0]) || !headers.some(line =>
        line.replace(/^Sec-WebSocket-Accept:\s*/i, '') === accept)) return close();
      buffer = buffer.subarray(cut + 4);
      opened = true;
      ready(true);
    }
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      const final = (buffer[0] & 0x80) !== 0;
      let size = buffer[1] & 0x7f;
      let header = 2;
      if (buffer[0] & 0x70 || buffer[1] & 0x80) return close();
      if (size === 126 || size === 127) {
        header = size === 126 ? 4 : 10;
        if (buffer.length < header) return;
        if (header === 10 && buffer.readUInt32BE(2) !== 0) return close();
        size = header === 4 ? buffer.readUInt16BE(2) : buffer.readUInt32BE(6);
      }
      if (size > MAX_LINE || (opcode >= 8 && (!final || size > 125))) return close(); // 512 KiB cap per message
      if (buffer.length < header + size) return;
      const data = buffer.subarray(header, header + size);
      buffer = buffer.subarray(header + size);
      if (opcode === 8) return close();
      if (opcode === 9) { frame(Buffer.from(data), 10); continue; }
      if (opcode === 10) continue;
      if ((opcode !== 1 && opcode !== 0) || (opcode === 0) !== (parts.length > 0)) return close();
      bytes += size;
      if (bytes > MAX_LINE) return close();
      parts.push(data);
      if (final) {
        receive(Buffer.concat(parts, bytes).toString('utf8'));
        parts = [];
        bytes = 0;
      }
    }
  });
  child.stdin.write(['GET / HTTP/1.1', 'Host: localhost', 'Connection: Upgrade', 'Upgrade: websocket',
    'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: ' + key, '', ''].join('\r\n'));
  return message => frame(Buffer.from(message), 1);
}

async function appServer(args, { executable = 'codex', env = process.env } = {}, run) {
  const child = spawn(executable, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = new Promise(resolve => child.once('close', resolve));
  const pending = new Map();
  let id = 0;
  let closed = false;
  let ready;
  const connected = new Promise(resolve => { ready = resolve; });
  const close = () => {
    if (closed) return;
    closed = true;
    ready(false);
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
    child.kill();  // only our stdio client, never the already-running provider daemon
  };
  const timer = setTimeout(close, 5000);
  child.once('error', close);
  child.once('exit', close);
  child.stdin.once('error', close);
  const receive = line => {
    let reply;
    try { reply = JSON.parse(line); } catch { return; }
    const resolve = pending.get(reply?.id);
    if (resolve) {
      pending.delete(reply.id);
      resolve(reply.result ?? null);
    }
  };
  let write;
  if (args.includes('proxy')) {
    write = proxyWire(child, receive, close, ready);
  } else {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    child.stdout.on('data', chunk => {
      if (closed) return;
      buffer += decoder.write(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        if (index > MAX_LINE) return close(); // Abort on a reply larger than 512 KiB.
        receive(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
      if (buffer.length > MAX_LINE) close();
    });
    write = message => child.stdin.write(message + '\n');
    ready(true);
  }
  const send = message => write(JSON.stringify(message));
  const request = (method, params) => new Promise(resolve => {
    if (closed) return resolve(null);
    pending.set(++id, resolve);
    send({ id, method, params });
  });
  try {
    if (!await connected) return null;
    const session = await request('initialize', { clientInfo: { name: 'wyarden-monitor', version: '1' },
      capabilities: { experimentalApi: true } });
    if (!session || closed) return null;
    send({ method: 'initialized' });
    return await run(request);
  } finally {
    clearTimeout(timer);
    close();
    await exited;
  }
}

function inspectCodexHooks(dir, { executable, env = process.env } = {}) {
  return appServer(['app-server'], { executable, env: { ...env, CODEX_HOME: dir } }, request => request('hooks/list', {}));
}

async function liveCodexSessions({ executable, env = process.env, run = appServer } = {}) {
  const rows = await run(['app-server', 'proxy'], { executable, env }, async request => {
    const list = await request('thread/loaded/list', { limit: MAX_THREADS });
    if (!Array.isArray(list?.data)) return [];
    // This samples up to 64 currently loaded threads on the existing shared daemon.
    const ids = [...new Set(list.data.filter(isSessionId))].slice(0, MAX_THREADS);
    const threads = await Promise.all(ids.map(threadId => request('thread/read', { threadId, includeTurns: false })));
    return threads.flatMap((reply, index) => {
      const thread = reply?.thread;
      if (thread?.id !== ids[index] || typeof thread.cwd !== 'string' || thread.cwd.length > MAX_PATH ||
          !isAbsolute(thread.cwd) || thread.cwd !== cleanText(thread.cwd, MAX_PATH)) return [];
      const status = thread.status?.type;
      if (status !== 'idle' && status !== 'active') return [];
      const flags = Array.isArray(thread.status.activeFlags) ? thread.status.activeFlags : [];
      const permission = flags.includes('waitingOnApproval');
      const question = flags.includes('waitingOnUserInput');
      return [{ agent: 'codex', session: thread.id, cwd: thread.cwd,
        status: permission || question ? 'waiting' : status === 'active' ? 'busy' : 'idle',
        ...(permission && { waitingFor: 'permission' }) }];
    });
  });
  return rows ?? [];
}

module.exports = { inspectCodexHooks, liveCodexSessions };
