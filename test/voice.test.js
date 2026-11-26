const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { transcribe, pcmToWav, validateSpeech, dictateStream, streamSibling, PROVIDERS } = require('../out/voice');
const whisperHeader = Buffer.from('6c6d67679aca0000dc050000000500001400000020000000c00100000005000014000000040000008000000001000000', 'hex');
const wav = () => pcmToWav(Buffer.alloc(3200));

test('WAV has correct format, rate, length and rejects incomplete samples', () => {
  const b = wav(); assert.equal(b.toString('ascii',0,4),'RIFF'); assert.equal(b.readUInt32LE(24),16000);
  assert.equal(b.readUInt16LE(22),1); assert.equal(b.readUInt32LE(40),3200); assert.equal(b.length,3244);
  assert.throws(() => pcmToWav(Buffer.alloc(1)), /incomplete audio/);
});
test('missing settings and unknown providers fail before recording', () => {
  assert.throws(() => validateSpeech({provider:'local'}), /absolute file path/);
  assert.throws(() => validateSpeech({provider:'openai'}), /API Key/);
  assert.throws(() => validateSpeech({provider:'custom',apiKey:'x'}), /supported/);
});
for (const provider of Object.keys(PROVIDERS)) test(`${provider}: fixed endpoint, appropriate upload and auth, final text`, async () => {
  let called=0; const apiKey='test-only-secret';
  const text = await transcribe(wav(),{provider,apiKey,language:'en'}, new AbortController().signal, async (url,init) => {
    called++; assert.equal(url.origin,new URL(PROVIDERS[provider].url).origin); assert.equal(init.redirect,'error');
    assert.equal(init.headers.Authorization,`${provider==='deepgram'?'Token':'Bearer'} ${apiKey}`);
    if(provider==='deepgram') { assert.ok(init.body instanceof Uint8Array); assert.equal(url.searchParams.get('model'),'nova-3'); }
    else { assert.equal(init.body.get('model'),PROVIDERS[provider].model); assert.equal(init.body.get('file').type,'audio/wav'); }
    return new Response(JSON.stringify(provider==='deepgram'?{results:{channels:[{alternatives:[{transcript:' hello ' }]}]}}:{text:' hello '}));
  });
  assert.equal(text,'hello'); assert.equal(called,1);
});
test('provider failures never expose returned body or credentials', async () => {
  const key='SENTINEL_NOT_REAL';
  await assert.rejects(transcribe(wav(),{provider:'groq',apiKey:key},new AbortController().signal,
    async () => new Response(key,{status:401})), e => /401/.test(e.message) && !e.message.includes(key));
  await assert.rejects(transcribe(wav(),{provider:'groq',apiKey:key},new AbortController().signal,
    async () => { throw Error(key); }), e => !e.message.includes(key));
});
test('malformed response and cancellation remain explicit', async () => {
  await assert.rejects(transcribe(wav(),{provider:'groq',apiKey:'test'},new AbortController().signal,
    async()=>new Response('{}')), /no transcript/);
  const c=new AbortController();c.abort();let calls=0;
  await assert.rejects(transcribe(wav(),{provider:'groq',apiKey:'test'},c.signal,async()=>{calls++;}));assert.equal(calls,0);
});
test('local Whisper uses argument array, isolated WAV and removes temporary output', {skip:process.platform==='win32'}, async () => {
  const dir=fs.mkdtempSync(path.join(require('./exec-tmpdir').execTmpdir(),'speech-test-'));
  const binary=path.join(dir,'fake whisper'), model=path.join(dir,'model with spaces.bin');
  fs.writeFileSync(model, whisperHeader);
  fs.writeFileSync(binary,`#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n case "$1" in -of) shift; out="$1";; -f) shift; audio="$1";; esac\n shift\ndone\n[ -f "$audio" ] || exit 8\nprintf 'local transcript' > "$out.txt"\nprintf '%s' "$audio" > '${dir}/seen'\n`,{mode:0o700});
  try {
    assert.equal(await transcribe(wav(),{provider:'local',executable:binary,modelPath:model},new AbortController().signal),'local transcript');
    assert.equal(fs.existsSync(fs.readFileSync(path.join(dir,'seen'),'utf8')),false);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
function liveWhisperFixture(t) {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-stream-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = path.join(dir, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  const modelPath = path.join(dir, 'model.bin');
  fs.writeFileSync(modelPath, whisperHeader);
  fs.writeFileSync(executable, '');
  fs.writeFileSync(streamSibling(executable), '');
  const children = [];
  t.mock.method(require('node:child_process'), 'spawn', () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    children.push(child);
    return child;
  });
  return on => {
    const voice = dictateStream({ provider: 'local', executable, modelPath, silenceSeconds: 1 }, on);
    const [recognizer, meter] = children.splice(0);
    t.after(() => voice.cancel());
    return { voice, recognizer, meter };
  };
}

test('live Whisper preserves Unicode utterances and drops noise on completed lines and Stop', async (t) => {
  const start = liveWhisperFixture(t);
  for (const [tail, expected] of [['最後です', ['最後です']], ['…！？', []]]) {
    const heard = [];
    const { voice, recognizer, meter } = start({
      text: line => heard.push(line), transcribing() {}, recording() {}, error: assert.fail,
    });
    recognizer.stdout.write('[BLANK_AUDIO]\r\nПривет!\r\n途中\r\x1b[');
    recognizer.stdout.write(`2Kこんにちは。\r\n…！？\n١٢٣\nEnglish.\n${tail}`);
    const completed = ['Привет!', 'こんにちは。', '١٢٣', 'English.'];
    assert.deepEqual(heard, completed);
    const stopping = voice.stop();
    recognizer.emit('close', 0);
    meter.emit('close', 0);
    await stopping;
    assert.deepEqual(heard, [...completed, ...expected]);
  }
});
test('live Whisper ends after meter silence and reports model failure from an unexpected exit', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const start = liveWhisperFixture(t);
  const events = [];
  const on = {
    recording: () => events.push('recording'), transcribing: () => events.push('transcribing'),
    text: value => events.push(value), error: message => events.push(message),
  };
  const { voice, recognizer, meter } = start(on);
  recognizer.emit('spawn');
  recognizer.stdout.write('pending text');
  t.mock.timers.tick(900);
  const speech = Buffer.alloc(2);
  speech.writeInt16LE(2000);
  meter.stdout.write(speech);
  t.mock.timers.tick(999);
  meter.stdout.write(Buffer.alloc(2));
  assert.deepEqual(events, ['recording']);
  t.mock.timers.tick(1);
  meter.stdout.write(Buffer.alloc(2));
  assert.deepEqual(events, ['recording', 'transcribing']);
  recognizer.emit('close', 0);
  meter.emit('close', 0);
  await voice.closed;
  assert.deepEqual(events, ['recording', 'transcribing', 'pending text']);

  events.length = 0;
  const failed = start(on);
  failed.recognizer.emit('spawn');
  failed.recognizer.stdout.write('unconfirmed text');
  failed.recognizer.stderr.write('unknown tensor');
  failed.recognizer.emit('close', 2);
  failed.meter.emit('close', 0);
  await failed.voice.closed;
  assert.equal(events.length, 2);
  assert.equal(events[0], 'recording');
  assert.match(events[1], /Whisper could not load the selected model/);
});
test('speech source has no credential-file reader or Anthropic network endpoint', () => {
  const source=fs.readFileSync(path.join(__dirname,'../src/voice.ts'),'utf8');
  assert.doesNotMatch(source,/\.credentials\.json|auth\.json|api\.anthropic\.com|claudeAiOauth/);
});
