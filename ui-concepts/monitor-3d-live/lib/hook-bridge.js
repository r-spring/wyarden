/* Copied as-is to the monitor's profile. Keep this entry point independent of the installed VSIX path. */
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const CODEX_EVENTS = Object.freeze(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'Interrupt',
  'PreToolUse', 'PostToolUse', 'PermissionRequest', 'SubagentStart', 'SubagentStop']);
const ANTIGRAVITY_EVENTS = Object.freeze(['SessionStart', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop']);
const EVENTS = Object.freeze({ codex: CODEX_EVENTS, antigravity: ANTIGRAVITY_EVENTS });
const MAX_BYTES = 8 * 1024 * 1024; // Drop hook input or output larger than 8 MiB, like the hub.
const INPUT_MS = 400;
const POST_MS = 350;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function tagHookPayload(event, payload) {
  if (!ANTIGRAVITY_EVENTS.includes(event) || !object(payload) ||
      (Object.hasOwn(payload, 'hookEventName') && payload.hookEventName !== event)) return null;
  return { ...payload, hookEventName: event };
}

function hookAcknowledgement(event) {
  if (event === 'PreToolUse') return { decision: 'allow' };
  if (event === 'Stop') return { decision: 'stop' };
  return {};
}

function readInput(input) {
  return new Promise(resolve => {
    const done = value => { clearTimeout(timer); input.destroy(); resolve(value); };
    const timer = setTimeout(() => done(null), INPUT_MS);
    const chunks = [];
    let size = 0;
    input.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BYTES) done(null);
      else chunks.push(chunk);
    });
    input.once('error', () => done(null));
    input.once('end', () => done(Buffer.concat(chunks, size)));
  });
}

function forward(provider, hub, body) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: hub.port, method: 'POST', agent: false,
      path: '/wyarden-monitor/h/' + hub.ingest + '/' + provider,
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, res => res.destroy());
    const timer = setTimeout(() => req.destroy(), POST_MS);
    req.once('error', () => {});
    req.once('close', () => { clearTimeout(timer); resolve(); });
    req.end(body);
  });
}

async function run(provider, event) {
  const valid = Object.hasOwn(EVENTS, provider) && EVENTS[provider].includes(event);
  try {
    if (!valid) return;
    const input = await readInput(process.stdin);
    if (!input) return;
    const raw = JSON.parse(input.toString('utf8'));
    const payload = provider === 'antigravity' ? tagHookPayload(event, raw) :
      object(raw) && (!Object.hasOwn(raw, 'hook_event_name') || raw.hook_event_name === event) ? { ...raw, hook_event_name: event } : null;
    if (!payload) return;
    const file = path.join(__dirname, 'hub.json');
    if (fs.statSync(file).size > 4096) return; // A hub record over 4 KiB is invalid.
    const hub = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (hub.v !== 1 || !Number.isInteger(hub.port) || hub.port < 1024 || hub.port > 65535 ||
        typeof hub.ingest !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(hub.ingest)) return;
    const body = Buffer.from(JSON.stringify(payload));
    if (body.length <= MAX_BYTES) await forward(provider, hub, body);
  } catch { /* A monitoring failure never changes the provider's action or prints a diagnostic. */ }
  finally { process.stdout.write(JSON.stringify(valid && provider === 'antigravity' ? hookAcknowledgement(event) : {}) + '\n'); }
}

if (require.main === module) void run(...process.argv.slice(2));

module.exports = { EVENTS, tagHookPayload, hookAcknowledgement };
