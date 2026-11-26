const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { promisify } = require('node:util');
const { dictate, dictateStream, streamSibling } = require('../out/voice');

function child() {
  const proc = Object.assign(new EventEmitter(), {
    pid: 42, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), signals: [],
  });
  proc.kill = signal => { proc.signals.push(signal); return true; };
  proc.close = () => { proc.exitCode = 0; proc.emit('close', 0); };
  return proc;
}

function fixture(t) {
  const children = [], events = [], uploads = [];
  const spawn = t.mock.method(cp, 'spawn', () => { const proc = child(); children.push(proc); return proc; });
  t.mock.method(global, 'fetch', async (url, init) => {
    uploads.push(init.body.get('file').type);
    return new Response('{"text":"dictated text"}');
  });
  const on = { recording: () => events.push('recording'), transcribing: () => events.push('transcribing'),
    text: text => events.push(text), partial: text => events.push(text), error: message => events.push(message) };
  return { children, events, uploads, spawn, on };
}
const cloud = { provider: 'groq', apiKey: 'test' };
const tick = () => new Promise(setImmediate);
function observe(promise) {
  let done = false;
  promise.then(() => { done = true; });
  return () => done;
}

function localOptions(t, provider) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dictation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, (provider === 'local' ? 'whisper-cli' : 'parakeet-cli') + (process.platform === 'win32' ? '.exe' : ''));
  const modelPath = path.join(dir, 'model.bin');
  const header = Buffer.from('6c6d67679aca0000dc050000000500001400000020000000c00100000005000014000000040000008000000001000000', 'hex');
  if (provider === 'local') fs.writeFileSync(streamSibling(executable), '');
  else [0x67676d6c,8192,5000,1024,8,24,128,2007,512,8,256,9].forEach((v,i) => header.writeInt32LE(v,i*4));
  fs.writeFileSync(executable, '');
  fs.writeFileSync(modelPath, header);
  return { provider, executable, modelPath };
}

test('Stop drains the recorder, uploads a WAV and delivers one final transcript', async t => {
  const f = fixture(t), voice = dictate(cloud, f.on), [rec] = f.children;
  rec.emit('spawn');
  const stopping = voice.stop();
  rec.stdout.write(Buffer.alloc(3200));
  assert.deepEqual(f.uploads, []);
  rec.close();
  await stopping; await voice.stop();
  assert.deepEqual(f.uploads, ['audio/wav']);
  assert.deepEqual(f.events, ['recording', 'transcribing', 'dictated text']);
});

for (const stopFirst of [false, true]) {
  test('cancel while writing waits for the recorder, including after Stop = ' + stopFirst, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t), voice = dictate(cloud, f.on), [rec] = f.children, done = observe(voice.closed);
    rec.emit('spawn'); rec.stdout.write(Buffer.alloc(3200));
    if (stopFirst) voice.stop();
    voice.cancel(); voice.cancel(); voice.stop();
    rec.emit('error', new Error('failed signal')); rec.emit('error', new Error('duplicate'));
    rec.stdout.write(Buffer.alloc(3200)); await tick();
    assert.equal(done(), false);
    t.mock.timers.tick(1999);
    assert.deepEqual(rec.signals, ['SIGTERM']);
    t.mock.timers.tick(1); voice.cancel(); t.mock.timers.tick(4000);
    assert.deepEqual(rec.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(done(), false);
    rec.close(); rec.close(); await voice.closed;
    assert.deepEqual(f.uploads, []);
    assert.deepEqual(f.events, stopFirst ? ['recording', 'transcribing'] : ['recording']);
  });
}

test('failed recorder spawn settles without exposing diagnostics or contacting the provider', async t => {
  const f = fixture(t), voice = dictate(cloud, f.on), [rec] = f.children;
  rec.pid = undefined; rec.emit('error', new Error('private recorder output'));
  await voice.closed;
  assert.equal(f.events.length, 1);
  assert.match(f.events[0], /recorder could not start/);
  assert.doesNotMatch(f.events[0], /private/);
  assert.deepEqual(f.uploads, []);
});

for (const first of ['recognizer', 'meter']) {
  for (const action of ['stop', 'cancel', 'unexpected close']) {
    test('stream ' + action + ' with ' + first + ' closing first', async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const f = fixture(t), voice = dictateStream(localOptions(t, 'local'), f.on, 'recorder.exe');
      const [rec, meter] = f.children, done = observe(voice.closed);
      assert.deepEqual(f.spawn.mock.calls[1].arguments.slice(0, 2), ['recorder.exe', []]);
      const [early, late] = first === 'recognizer' ? [rec, meter] : [meter, rec];
      rec.emit('spawn'); rec.stdout.write('pending');
      if (action !== 'unexpected close') voice[action]();
      early.close(); await tick();
      assert.equal(done(), false);
      if (action !== 'stop') rec.stdout.write(' late\n');
      const previous = early.signals.slice();
      t.mock.timers.tick(2000);
      assert.deepEqual(early.signals, previous);
      assert.deepEqual(late.signals, ['SIGTERM', 'SIGKILL']);
      late.close(); await voice.closed;
      if (action === 'unexpected close') {
        assert.equal(f.events.length, 2);
        assert.match(f.events[1], /unexpectedly/);
      } else assert.deepEqual(f.events, action === 'stop' ? ['recording', 'transcribing', 'pending'] : ['recording']);
      assert.deepEqual(f.uploads, []);
    });
  }
}

test('Stop then Cancel drops the pending Whisper tail while the meter still owns the microphone', async t => {
  const f = fixture(t), voice = dictateStream(localOptions(t, 'local'), f.on), [rec, meter] = f.children;
  rec.emit('spawn'); rec.stdout.write('tail'); voice.stop(); rec.close();
  voice.cancel(); meter.emit('error', new Error('late signal error')); meter.close();
  await voice.closed;
  assert.deepEqual(f.events, ['recording', 'transcribing']);
});

test('a synchronous meter launch failure still waits for the recognizer', async t => {
  const f = fixture(t);
  f.spawn.mock.mockImplementationOnce(() => { throw new Error('unable to spawn'); }, 1);
  const voice = dictateStream(localOptions(t, 'local'), f.on), [rec] = f.children, done = observe(voice.closed);
  voice.cancel(); await tick();
  assert.equal(done(), false);
  assert.deepEqual(rec.signals, ['SIGTERM']);
  rec.close(); await voice.closed;
  assert.equal(f.events.length, 1);
  assert.match(f.events[0], /silence detection/);
});

for (const pass of ['live', 'final']) {
  test('cancel waits for the ' + pass + ' Parakeet child and its audio cleanup', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t), worker = child(), started = Promise.withResolvers(), result = Promise.withResolvers();
    // execFile's promisified form exposes the actual child alongside its result.
    const original = cp.execFile;
    t.after(() => { cp.execFile = original; });
    cp.execFile = () => assert.fail('expected promisified execFile');
    cp.execFile[promisify.custom] = (_exe, args) => {
      started.resolve(args.at(-1));
      return Object.assign(result.promise, { child: worker });
    };
    const voice = dictate(localOptions(t, 'parakeet'), f.on), [rec] = f.children, done = observe(voice.closed);
    rec.emit('spawn'); rec.stdout.write(Buffer.alloc(pass === 'live' ? 32000 : 3200));
    if (pass === 'final') { voice.stop(); rec.close(); }
    const audio = await started.promise;
    voice.cancel(); rec.close();
    result.reject(new Error('interrupted')); await tick();
    assert.equal(done(), false);
    assert.ok(fs.existsSync(audio));
    t.mock.timers.tick(2000);
    assert.deepEqual(worker.signals, ['SIGTERM', 'SIGKILL']);
    worker.close(); await voice.closed;
    assert.equal(fs.existsSync(audio), false);
    assert.deepEqual(f.uploads, []);
    assert.deepEqual(f.events, pass === 'live' ? ['recording'] : ['recording', 'transcribing']);
  });
}
