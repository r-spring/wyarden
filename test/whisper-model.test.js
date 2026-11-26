const test=require('node:test'), assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {hasWhisperHeader}=require('../out/whisper-model');
const {whisperExitMessage,validateSpeech}=require('../out/voice');
const Module=require('node:module');
function model(dir,name,values){const p=path.join(dir,name),b=Buffer.alloc(48);values.forEach((v,i)=>b.writeInt32LE(v,i*4));fs.writeFileSync(p,b);return p;}
const whisper=[0x67676d6c,51866,1500,1280,20,32,448,1280,20,4,128,1];
const parakeet=[0x67676d6c,8192,5000,1024,8,24,128,2007,512,8,256,9];
test('only supported Whisper headers reach the dropdown; Parakeet, renamed and truncated models do not',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whisper-models-'));
 try{const valid=model(dir,'ggml-large-v3-turbo.bin',whisper);const invalid=model(dir,'ggml-parakeet-tdt.bin',parakeet);model(dir,'ggml-small.bin',parakeet);fs.writeFileSync(path.join(dir,'ggml-base.bin'),'truncated');
 assert.equal(hasWhisperHeader(valid),true);assert.equal(hasWhisperHeader(invalid),false);
 const file=require.resolve('../out/speech-settings'),m=new Module(file,module);m.filename=file;m.require=n=>n==='vscode'?{}:require(n.startsWith('./')?path.join(path.dirname(file),n):n);m._compile(fs.readFileSync(file,'utf8'),file);
 assert.deepEqual(m.exports.discoverWhisper(dir).models.map(m=>m.label),['large-v3-turbo']);
 assert.throws(()=>validateSpeech({provider:'local',executable:valid,modelPath:invalid}),/not a supported Whisper model/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('native model-loading errors are distinguished from microphone errors without exposing raw diagnostics',()=>{
 assert.match(whisperExitMessage(2,"unknown tensor '' in model file\nfailed to initialize whisper context"),/could not load/);
 assert.match(whisperExitMessage(1,'failed to open audio device'),/microphone/);
 assert.match(whisperExitMessage(3,'SENTINEL_PRIVATE_CONTENT'),/exit 3/);
 assert.doesNotMatch(whisperExitMessage(3,'SENTINEL_PRIVATE_CONTENT'),/SENTINEL/);
});
