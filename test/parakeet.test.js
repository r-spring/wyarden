const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module');
const {hasParakeetHeader}=require('../out/whisper-model');
const {transcribe,pcmToWav,validateSpeech,dictateStream}=require('../out/voice');
const header=Buffer.alloc(48);[0x67676d6c,8192,5000,1024,8,24,128,2007,512,8,256,9].forEach((v,i)=>header.writeInt32LE(v,i*4));
function setup(){const dir=fs.mkdtempSync(path.join(require('./exec-tmpdir').execTmpdir(),'parakeet-test-'));const model=path.join(dir,'ggml-parakeet-tdt-0.6b-v3-q8_0.bin'),exe=path.join(dir,process.platform==='win32'?'parakeet-cli.exe':'parakeet-cli');fs.writeFileSync(model,header);fs.writeFileSync(exe,'');return{dir,model,exe};}
function settings(config){const file=require.resolve('../out/speech-settings'),m=new Module(file,module);m.filename=file;m.require=n=>n==='vscode'?{ConfigurationTarget:{Global:1},workspace:{getConfiguration:()=>({get:(k,d)=>config[k]??d,update:async(k,v)=>config[k]=v})}}:require(n.startsWith('./')?path.join(path.dirname(file),n):n);m._compile(fs.readFileSync(file,'utf8'),file);return m.exports;}
test('Parakeet discovery uses its own executable and model, without overwriting Whisper selections',async()=>{
 const {dir,model,exe}=setup();try{
 const config={provider:'parakeet',whisperFolder:dir,modelPath:'preserve-whisper-model'},s=settings(config),d=s.discoverWhisper(dir,'parakeet');
 assert.equal(d.executable,exe);assert.deepEqual(d.models.map(x=>x.path),[model]);assert.equal(s.discoverWhisper(dir).models.length,0);assert.equal(hasParakeetHeader(model),true);
 const o=await s.speechOptions({get:()=>assert.fail('local engine requested credential')});assert.equal(o.executable,exe);assert.equal(o.modelPath,model);await s.setWhisperModel(model);assert.equal(config.parakeetModelPath,model);assert.equal(config.modelPath,'preserve-whisper-model');
 const whisper = path.join(dir, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
 fs.writeFileSync(whisper, '');
 assert.throws(() => validateSpeech({ ...o, executable: whisper }), /requires parakeet-cli/);
 assert.throws(()=>dictateStream(o,{}),/Live Whisper requires/);
 fs.writeFileSync(model,Buffer.alloc(48));assert.equal(hasParakeetHeader(model),false);assert.throws(()=>validateSpeech(o),/Parakeet TDT/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Parakeet adapter uses only its CLI flags, cleans audio and output, never uploads', {skip:process.platform==='win32'},async()=>{
 const {dir,model,exe}=setup();try{
 fs.writeFileSync(exe,`#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n case "$1" in -of) shift; out="$1";; -f) shift; audio="$1";; -m|-t|-dev) shift;; -otxt) ;; *) exit 9;; esac\n shift\ndone\n[ -f "$audio" ] || exit 8\nprintf 'Parakeet result' > "$out.txt"\nprintf '%s' "$audio" > '${dir}/seen'\n`,{mode:0o700});fs.chmodSync(exe,0o700);
 const o={provider:'parakeet',modelPath:model,executable:exe,language:'fr'};
 assert.equal(await transcribe(pcmToWav(Buffer.alloc(3200)),o,new AbortController().signal,()=>assert.fail('upload')),'Parakeet result');
 assert.equal(fs.existsSync(path.dirname(fs.readFileSync(path.join(dir,'seen'),'utf8'))),false);
 fs.writeFileSync(exe,'#!/bin/sh\necho SENTINEL_PRIVATE_CONTENT >&2\nexit 1\n');
 await assert.rejects(transcribe(pcmToWav(Buffer.alloc(3200)),o,new AbortController().signal),e=>/Local Parakeet/.test(e.message)&&!e.message.includes('SENTINEL'));
 const abort=new AbortController();abort.abort();await assert.rejects(transcribe(pcmToWav(Buffer.alloc(3200)),o,abort.signal));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Parakeet stops on silence, inserts once, and cancel never starts transcription', {skip:process.platform==='win32'},async()=>{
 const {dir,model,exe}=setup();const realNow=Date.now;
 try{
 fs.writeFileSync(exe,`#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n case "$1" in -of) shift; out="$1";; esac\n shift\ndone\nprintf 'Local final text' > "$out.txt"\nprintf invoked > '${dir}/invoked'\n`);fs.chmodSync(exe,0o700);
 const {EventEmitter}=require('events'),{PassThrough}=require('stream');
 function recording(){const rec=new EventEmitter();rec.stdout=new PassThrough();rec.stderr=new PassThrough();rec.pid=42;rec.exitCode=null;rec.signalCode=null;rec.kill=()=>{rec.signalCode='SIGTERM';queueMicrotask(()=>rec.emit('close'));return true;};return rec;}
 function adapter(rec){const file=require.resolve('../out/voice'),m=new Module(file,module);m.filename=file;m.require=n=>n==='child_process'?{...require('child_process'),spawn:()=>rec}:require(n.startsWith('./')?path.join(path.dirname(file),n):n);m._compile(fs.readFileSync(file,'utf8'),file);return m.exports;}
 const options={provider:'parakeet',executable:exe,modelPath:model,silenceSeconds:.5},events=[],on={recording:()=>events.push('recording'),transcribing:()=>events.push('transcribing'),text:t=>events.push(t),error:e=>assert.fail(e)};
 const rec=recording();let now=1000;Date.now=()=>now;const v=adapter(rec).dictate(options,on);rec.emit('spawn');rec.stdout.write(Buffer.alloc(3200,1));now+=600;rec.stdout.write(Buffer.alloc(3200));Date.now=realNow;
 await v.closed;await v.stop();assert.deepEqual(events,['recording','transcribing','Local final text']);fs.unlinkSync(path.join(dir,'invoked'));
 const next=recording(),cancelled=adapter(next).dictate(options,on);next.emit('spawn');next.stdout.write(Buffer.alloc(3200));cancelled.cancel();await cancelled.closed;await new Promise(r=>setImmediate(r));assert.equal(fs.existsSync(path.join(dir,'invoked')),false);
 }finally{Date.now=realNow;fs.rmSync(dir,{recursive:true,force:true});}
});
test('Linux: a local speech program gets its own folder first on the library path (a renamed install keeps a stale RUNPATH)', {skip:process.platform!=='linux'},async()=>{
 const {dir,model,exe}=setup();try{
 const {speechEnv}=require('../out/parakeet');assert.equal(speechEnv(exe).LD_LIBRARY_PATH.split(':')[0],dir);
 fs.writeFileSync(exe,`#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n case "$1" in -of) shift; out="$1";; esac\n shift\ndone\nprintf '%s' "$LD_LIBRARY_PATH" > "$out.txt"\n`,{mode:0o700});fs.chmodSync(exe,0o700);
 const seen=await transcribe(pcmToWav(Buffer.alloc(3200)),{provider:'parakeet',modelPath:model,executable:exe},new AbortController().signal);
 assert.equal(seen.split(':')[0],dir);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Parakeet live text: the recording so far is transcribed and delivered before Stop, then the final text once', {skip:process.platform==='win32'},async()=>{
 const {dir,model,exe}=setup();
 try{
 // The stand-in answers with the size of the audio it was given, so each pass is told apart.
 fs.writeFileSync(exe,`#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n case "$1" in -of) shift; out="$1";; -f) shift; audio="$1";; esac\n shift\ndone\nprintf 'bytes %s' "$(wc -c < "$audio" | tr -d ' ')" > "$out.txt"\n`);fs.chmodSync(exe,0o700);
 const {EventEmitter}=require('events'),{PassThrough}=require('stream');
 const rec=new EventEmitter();rec.stdout=new PassThrough();rec.stderr=new PassThrough();rec.pid=42;rec.exitCode=null;rec.signalCode=null;rec.kill=()=>{rec.signalCode='SIGTERM';queueMicrotask(()=>rec.emit('close'));return true;};
 const file=require.resolve('../out/voice'),m=new Module(file,module);m.filename=file;m.require=n=>n==='child_process'?{...require('child_process'),spawn:()=>rec}:require(n.startsWith('./')?path.join(path.dirname(file),n):n);m._compile(fs.readFileSync(file,'utf8'),file);
 const events=[];let gotPartial;const partial=new Promise(r=>{gotPartial=r;});
 const on={recording:()=>events.push('recording'),transcribing:()=>events.push('transcribing'),text:t=>events.push('final '+t),partial:t=>{events.push('live '+t);gotPartial();},error:e=>assert.fail(e)};
 const v=m.exports.dictate({provider:'parakeet',executable:exe,modelPath:model,silenceSeconds:60},on);rec.emit('spawn');
 rec.stdout.write(Buffer.alloc(16000,1));await new Promise(r=>setImmediate(r));assert.deepEqual(events,['recording']); // under a second: no pass yet
 rec.stdout.write(Buffer.alloc(16001,1));await partial; // an odd byte count is trimmed to whole samples
 rec.stdout.write(Buffer.alloc(3199,1));await v.stop();
 assert.deepEqual(events,['recording','live bytes 32044','transcribing','final bytes 35244']);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
