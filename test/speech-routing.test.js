const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),fs=require('node:fs');
function fixture(provider,task,account){const calls=[];const file=require.resolve('../out/extension');const m=new Module(file,module);m.filename=file;const ended=Promise.resolve();
 m.require=n=> n==='vscode'?{window:{showErrorMessage:e=>assert.fail(e)}}:n==='./voice'?{dictate:(o)=>{calls.push(['cloud',o.provider]);return{stop:async()=>{},closed:ended};},dictateStream:(o)=>{calls.push(['local',o.provider]);return{stop:async()=>{},closed:ended};}}:n==='./speech-settings'?{speechOptions:async()=>({provider})}:n==='./board'?{accounts:()=>account?[account]:[]}:n==='./accounts'?{activeConfigDir:()=>'/default-claude'}:n.startsWith('./')?{}:require(n);
 m._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports.run=dictateDirect;',file);return{calls,run:()=>m.exports.run({get:()=>task,configDirOf:()=>'/task-claude'},{postMessage:()=>{}},{account:account?.name})};}
for(const provider of ['local','parakeet','openai','groq','deepgram'])test(`${provider} routing reaches its own engine`,async()=>{const f=fixture(provider);await f.run();assert.deepEqual(f.calls,[[provider==='local'?'local':'cloud',provider]]);});
test('a saved setting that still selects the removed Claude dictation falls back to Local Whisper, leaving the setting alone',async()=>{const file=require.resolve('../out/speech-settings');const m=new Module(file,module);m.filename=file;const writes=[];
 const config={get:(k,d)=>k==='provider'?'claude':d,inspect:()=>({globalValue:'claude'}),update:async(...a)=>writes.push(a)};
 m.require=n=>n==='vscode'?{workspace:{getConfiguration:()=>config},ConfigurationTarget:{Global:1}}:require(n.startsWith('./')?require('node:path').join(__dirname,'../out',n):n);
 m._compile(fs.readFileSync(file,'utf8'),file);
 assert.equal(m.exports.speechSnapshot().provider,'local');assert.ok(!m.exports.SPEECH_PROVIDERS.some(p=>p.id==='claude'));
 assert.equal((await m.exports.speechOptions({get:async()=>undefined})).provider,'local');assert.deepEqual(writes,[]);
 await assert.rejects(m.exports.setSpeechProvider('claude'),/Unknown speech provider/);});
