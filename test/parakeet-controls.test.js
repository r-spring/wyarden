const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {parakeetArgs,runParakeet,parakeetDetails}=require('../out/parakeet');
const {validateSpeech}=require('../out/voice');
function fixture(){const dir=fs.mkdtempSync(path.join(require('./exec-tmpdir').execTmpdir(),'parakeet-controls-')),audio=path.join(dir,'sample file.wav'),exe=path.join(dir,'parakeet-cli');fs.writeFileSync(audio,'sample');return{dir,audio,exe};}
test('all Parakeet processing switches use separate arguments and validate numeric settings',()=>{
 const f=fixture();try{
 const o={provider:'parakeet',modelPath:path.join(f.dir,'model.bin'),parakeet:{threads:6,useGpu:false,gpuDevice:1,printSegments:true,quiet:true}};
 assert.deepEqual(parakeetArgs(o,[f.audio],path.join(f.dir,'output')),['-m',o.modelPath,'-t','6','-dev','1','-ng','-ps','-np','-otxt','-of',path.join(f.dir,'output'),'-f',f.audio]);
 for(const parakeet of [{threads:0},{threads:1.2},{gpuDevice:-1},{gpuDevice:Infinity},{useGpu:'false'},{printSegments:'true'}])assert.throws(()=>parakeetArgs({...o,parakeet},[f.audio]));
 assert.throws(()=>parakeetArgs(o,[]),/at least one/);assert.throws(()=>parakeetArgs(o,[f.audio,f.audio],path.join(f.dir,'out')),/one input/);
 assert.throws(()=>parakeetArgs(o,['-']),/existing local/);
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('batch results and diagnostics are exposed; zero-exit errors fail without echoing diagnostics', {skip:process.platform==='win32'},async()=>{
 const f=fixture();try{
 fs.writeFileSync(f.exe,'#!/bin/sh\nprintf "first transcript\\nsecond transcript\\n"\nprintf "Segments (2):\\n" >&2\n',{mode:0o700});
 const o={provider:'parakeet',executable:f.exe,modelPath:f.audio};
 const result=await runParakeet(o,[f.audio,f.audio],new AbortController().signal);assert.match(result.stdout,/second transcript/);assert.match(parakeetDetails(),/Segments \(2\)/);
 fs.writeFileSync(f.exe,'#!/bin/sh\nprintf "error: private details\\n" >&2\nexit 0\n');
 await assert.rejects(runParakeet(o,[f.audio],new AbortController().signal),e=>/failed/.test(e.message)&&!e.message.includes('private details'));assert.match(parakeetDetails(),/private details/);
 // Recognized words resembling an error are not an engine error line.
 fs.writeFileSync(f.exe,'#!/bin/sh\nprintf \'Segment 0: "error: a spoken phrase"\\n\' >&2\nprintf "valid transcript"\n');
 assert.equal((await runParakeet(o,[f.audio],new AbortController().signal)).stdout,'valid transcript');
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('cancellation terminates a running Parakeet CLI and releases its busy state', {skip:process.platform==='win32'},async()=>{
 const f=fixture();try{
 fs.writeFileSync(f.exe,'#!/bin/sh\nexec sleep 30\n',{mode:0o700});const controller=new AbortController(),o={provider:'parakeet',executable:f.exe,modelPath:f.audio};
 const pending=runParakeet(o,[f.audio],controller.signal);
 await assert.rejects(runParakeet(o,[f.audio],new AbortController().signal),/already transcribing/);
 controller.abort();await assert.rejects(pending);
 fs.writeFileSync(f.exe,'#!/bin/sh\nprintf resumed\n');assert.equal((await runParakeet(o,[f.audio],new AbortController().signal)).stdout,'resumed');
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
test('file commands honor Parakeet settings, open batch text, export safely, and refuse overwrite', {skip:process.platform==='win32'},async()=>{
 const f=fixture();try{
 const model=path.join(f.dir,'ggml-parakeet.bin'),h=Buffer.alloc(48);[0x67676d6c,8192,5000,1024,8,24,128,2007,512,8,256,9].forEach((v,i)=>h.writeInt32LE(v,i*4));fs.writeFileSync(model,h);
 fs.writeFileSync(f.exe,`#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n case "$1" in -of) shift; out="$1";; esac\n shift\ndone\nprintf 'transcribed audio'\n[ -z "$out" ] || printf 'transcribed audio' > "$out.txt"\n`,{mode:0o700});
 const config={provider:'claude',parakeetFolder:f.dir,parakeetModelPath:model,parakeetThreads:3,parakeetUseGpu:false,parakeetGpuDevice:0,parakeetPrintSegments:true,parakeetQuiet:true};
 const commands=new Map(),dialogs=[],picks=[],docs=[];let disposed=0;
 const vscode={ConfigurationTarget:{Global:1},ProgressLocation:{Notification:15},workspace:{getConfiguration:()=>({get:(k,d)=>config[k]??d}),openTextDocument:async d=>{docs.push(d);return d;}},commands:{registerCommand:(k,v)=>{commands.set(k,v);return{}},executeCommand:async()=>{}},window:{showOpenDialog:async()=>dialogs.shift(),showQuickPick:async()=>picks.shift(),showTextDocument:async()=>{},showInformationMessage:async()=>{},withProgress:async(_opts,fn)=>fn({report(){}},{onCancellationRequested:()=>({dispose(){disposed++;}})})}};
 const Module=require('node:module'),file=require.resolve('../out/speech-settings'),m=new Module(file,module);m.filename=file;m.require=n=>n==='vscode'?vscode:require(n.startsWith('./')?path.join(path.dirname(file),n):n);m._compile(fs.readFileSync(file,'utf8'),file);
 m.exports.registerSpeechSettings({subscriptions:[],secrets:{get:()=>assert.fail('requested secret')}});
 const opts=await m.exports.speechOptions({},'parakeet');assert.deepEqual(opts.parakeet,{threads:3,useGpu:false,gpuDevice:0,printSegments:true,quiet:true});
 dialogs.push([{fsPath:f.audio}]);picks.push('Open transcripts in the editor');await commands.get('entomatical.parakeetFiles')();assert.equal(docs.at(-1).content,'transcribed audio');
 const target=path.join(f.dir,'export');fs.mkdirSync(target);dialogs.push([{fsPath:f.audio}],[{fsPath:target}]);picks.push('Save text files to a folder');await commands.get('entomatical.parakeetFiles')();assert.equal(fs.readFileSync(path.join(target,'sample file.txt'),'utf8'),'transcribed audio');
 dialogs.push([{fsPath:f.audio}],[{fsPath:target}]);picks.push('Save text files to a folder');await assert.rejects(commands.get('entomatical.parakeetFiles')(),/already exists/);assert.equal(disposed,2);
 }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
});
