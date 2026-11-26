const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
function load(config={},legacy={}) {
 const file=require.resolve('../out/speech-settings');const m=new Module(file,module);m.filename=file;
 const writes=[]; const commands=new Map(); const dialogs=[]; const executed=[];
 // As in VS Code, a getConfiguration() result is a snapshot: its get() does not see its own update() (seen on linux, 4 November 2026).
 const api={workspace:{getConfiguration:scope=>{const snap={...(scope==='entomaticalSpeech.speech'?legacy:config)};return {get:(k,d)=>snap[k]??d,inspect:k=>({globalValue:snap[k]}),update:async(k,v)=>{writes.push([k,v]);config[k]=v;}};}},ConfigurationTarget:{Global:1},
 commands:{registerCommand:(n,fn)=>{commands.set(n,fn);return {dispose(){}};},executeCommand:async(...args)=>{executed.push(args);}},window:{showOpenDialog:async()=>dialogs.shift(),showQuickPick:async()=>undefined,showInformationMessage:async()=>{},showInputBox:async()=>undefined}};
 m.require=n=>n==='vscode'?api:require(n.startsWith('./')?path.join(path.dirname(file),n):n);
 m._compile(fs.readFileSync(file,'utf8'),file);return {...m.exports,writes,config,commands,dialogs,executed};
}
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whisper-folder-'));fs.mkdirSync(path.join(dir,'bin'));fs.mkdirSync(path.join(dir,'models'));fs.writeFileSync(path.join(dir,'bin',process.platform==='win32'?'whisper-cli.exe':'whisper-cli'),'fake');for(const n of ['ggml-base.en.bin','ggml-large-v3-turbo.bin'])fs.writeFileSync(path.join(dir,'models',n),Buffer.from('6c6d67679aca0000dc050000000500001400000020000000c00100000005000014000000040000008000000001000000','hex'));return dir;}

test('speech settings commands target the installed public or private extension',async()=>{
 for(const id of ['alternate.entomatical','example-publisher.entomatical']){
  const s=load();s.registerSpeechSettings({subscriptions:[],secrets:{},extension:{id}});
  await s.commands.get('entomatical.speechSettings')();await s.commands.get('entomatical.parakeetSettings')();
  assert.deepEqual(s.executed,[['workbench.action.openSettings',`@ext:${id} speech`],['workbench.action.openSettings',`@ext:${id} parakeet`]]);
 }
});
test('local and Claude settings never request keys; cloud reads only its speech key',async()=>{
 const seen=[],secrets={get:async k=>{seen.push(k);return 'test-key';}};
 for(const provider of ['local','parakeet','claude'])assert.equal((await load({provider}).speechOptions(secrets)).apiKey,undefined);
 assert.deepEqual(seen,[]);assert.equal((await load({provider:'groq'}).speechOptions(secrets)).apiKey,'test-key');assert.deepEqual(seen,['speech.apiKey.groq']);
});
test('folder discovery lists sorted models, executable and rejects arbitrary model selections',async()=>{
 const dir=fixture();try{const s=load({provider:'local',whisperFolder:dir});const d=s.discoverWhisper(dir);assert.equal(d.models.length,2);assert.ok(d.executable);assert.deepEqual(d.models.map(m=>m.label),['base.en','large-v3-turbo']);await s.setWhisperModel(d.models[1].path);assert.equal(s.config.modelPath,d.models[1].path);await assert.rejects(s.setWhisperModel('/unrelated/model.bin'),/not in/);assert.equal((await s.speechOptions({get:async()=>undefined})).modelPath,d.models[1].path);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('folder chooser asks for one directory and selects a discovered model',async()=>{
 const dir=fixture();try{const s=load();s.dialogs.push([{fsPath:dir}]);s.registerSpeechSettings({subscriptions:[],secrets:{}});await s.commands.get('entomatical.configureLocalSpeech')();assert.equal(s.config.whisperFolder,dir);assert.equal(s.config.provider,'local');assert.ok(s.config.modelPath.endsWith('ggml-base.en.bin'));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('legacy local settings migrate without overwriting user selections',async()=>{
 const dir=fixture();try{const s=load({language:'fr'},{provider:'local',whisperPath:path.join(dir,'bin','whisper-cli'),modelPath:path.join(dir,'models','ggml-base.en.bin'),language:'en'});await s.migrateSpeechSettings();assert.equal(s.config.provider,'local');assert.equal(s.config.language,'fr');assert.equal(s.config.whisperFolder,dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test("speech settings commands filter on the installed extension ID", async () => {
  const speech = load();
  speech.registerSpeechSettings({ subscriptions: [], secrets: {}, extension: { id: "bottobot.entomatical" } });
  await speech.commands.get("entomatical.parakeetSettings")();
  assert.deepEqual(speech.executed, [["workbench.action.openSettings", "@ext:bottobot.entomatical parakeet"]]);
});
