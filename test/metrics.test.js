const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { summarizeStream, UsageCollector } = require('../out/metrics');
const { subagents } = require('../out/sessions');
const usage = (n) => ({ opus: { inputTokens: n, outputTokens: n, cacheReadInputTokens: n, cacheCreationInputTokens: n } });
const records = (...rows) => rows.map((r, i) => ({ producer: 'a', sequence: i, at: i + 1, ...r }));
const start = {kind:'start', resumed:false};
const result = n => ({kind:'result', subtype:'success', modelUsage:usage(n)});
const temp = t => { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ab-metrics-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir; };
const line = o => JSON.stringify(o)+'\n';

test('cumulative results replace earlier snapshots, replay is deduplicated, and native children are not added twice', () => {
 const rows=records(start,result(10),result(20));
 const m=summarizeStream([...rows,...rows]);
 assert.equal(m.total,80);assert.equal(m.complete,true);
 const resumed=summarizeStream([...rows,...records({kind:'start',resumed:true},result(25)).map(r=>({...r,producer:'b'}))]);
 assert.equal(resumed.total,100);assert.equal(resumed.complete,true);
 assert.equal(summarizeStream(records({kind:'start',resumed:true},result(10))).complete,false);
 assert.equal(summarizeStream([...rows,{...start,producer:'b',sequence:0,resumed:true}]).complete,false);
});
test('a resumed process that starts its counters again keeps the earlier total; one that continues it is counted once', () => {
 // Session 19eff37a (29 Oct 2026): the first process ended at 4,446,508 (haiku + fable); the resumed one started again under opus.
 const models=(o)=>Object.fromEntries(Object.entries(o).map(([m,n])=>[m,{inputTokens:n,outputTokens:0,cacheReadInputTokens:0,cacheCreationInputTokens:0}]));
 const first=[{kind:'start',resumed:false,producer:'523ca6dd',sequence:0,at:1},{kind:'result',subtype:'success',producer:'523ca6dd',sequence:73,at:2,modelUsage:models({'claude-haiku-5-5':400000,'claude-fable-5-1':3088589})},
  {kind:'result',subtype:'success',producer:'523ca6dd',sequence:87,at:3,modelUsage:models({'claude-haiku-5-5':446508,'claude-fable-5-1':4000000})}];
 const resumed=[{kind:'start',resumed:true,producer:'2a6488c3',sequence:0,at:4},{kind:'result',subtype:'success',producer:'2a6488c3',sequence:16,at:5,modelUsage:models({'claude-opus-5-5':1191118})},
  {kind:'result',subtype:'success',producer:'2a6488c3',sequence:36,at:6,modelUsage:models({'claude-opus-5-5':2660236})}];
 const m=summarizeStream([...first,...resumed]);
 assert.equal(m.total,4446508+2660236);assert.equal(m.complete,true);
 assert.deepEqual(Object.fromEntries(Object.entries(m.models).map(([k,v])=>[k,v.input])),{'claude-haiku-5-5':446508,'claude-fable-5-1':4000000,'claude-opus-5-5':2660236});
 // Same model, lower first result: also a fresh start.
 assert.equal(summarizeStream([...records(start,result(20)),...records({kind:'start',resumed:true},result(3)).map(r=>({...r,producer:'b',at:r.at+10}))]).total,92);
 // Session 618fb753: the resumed process continued the total (112,256,910 then 114,100,359); it is not added twice.
 const cont=summarizeStream([...records(start,result(20)),...records({kind:'start',resumed:true},result(25),result(30)).map(r=>({...r,producer:'b',at:r.at+10}))]);
 assert.equal(cont.total,120);assert.equal(cont.complete,true);
 // Within one process a decrease is still an error, also after a fresh start.
 const bad=summarizeStream([...records(start,result(20)),...records({kind:'start',resumed:true},result(3),result(1)).map(r=>({...r,producer:'b',at:r.at+10}))]);
 assert.equal(bad.total,92);assert.ok(bad.diagnostics.some(d=>d.code==='counter_decreased'));
});
test('explicit resets preserve epochs, decreases and failed/missing results remain partial', () => {
 const reset=summarizeStream(records(start,result(20),{kind:'reset'},result(3)));
 assert.equal(reset.total,92);assert.equal(reset.complete,true);
 const decrease=summarizeStream(records(start,result(20),result(3)));
 assert.equal(decrease.total,80);assert.equal(decrease.complete,false);
 for(const bad of [{kind:'activity'},{kind:'result',subtype:'error_during_execution',modelUsage:usage(0)},{kind:'result',subtype:'success',modelUsage:{opus:{inputTokens:20}}}]) {
  assert.equal(summarizeStream(records(start,result(20),bad)).complete,false);
 }
});
test('collector handles partial lines, file replacement, recovery, and keeps context separate', t => {
 const dir=temp(t), metrics=path.join(dir,'metrics');fs.mkdirSync(metrics);
 const task={id:'t',sessionId:'session',status:'review'}, board={dir,events:()=>[],transcriptOf:()=>undefined};
 const file=path.join(metrics,'session.a.jsonl');const rows=records(start,result(10));fs.writeFileSync(file,rows.map(line).join(''));
 const c=new UsageCollector(board);assert.equal(c.session(task).total,40);
 fs.appendFileSync(file,'{"producer":"a","sequence":2,"kind":"activity"');
 assert.equal(c.session(task).complete,false);
 fs.appendFileSync(file,'}\n');assert.equal(c.session(task).complete,false);
 fs.appendFileSync(file,line({...result(20),producer:'a',sequence:3,at:50}));
 fs.writeFileSync(path.join(metrics,'t.context.json'),JSON.stringify({usedPercent:85,capacity:200000,at:50}));
 assert.equal(c.session(task).total,80);assert.equal(c.session(task).context.usedPercent,85);
 for (const provider of ['grok','antigravity']) {
  const m=c.session({...task,provider});
  assert.equal(m.source,'unknown');assert.equal(m.complete,false);assert.equal(m.total,undefined);assert.equal(m.context,undefined);
  assert.ok(m.diagnostics.some(d=>d.metric==='context'&&d.code==='source_unavailable'));
 }
 const home=path.join(dir,'grok-home'), ran=path.join(dir,'ran in'), sess=path.join(home,'sessions',encodeURIComponent(ran),'s1');fs.mkdirSync(sess,{recursive:true});
 fs.writeFileSync(path.join(sess,'usage.json'),JSON.stringify({session:{inputTokens:7,outputTokens:3,modelUsage:{g:{inputTokens:7,outputTokens:3}}},turns:[]}));
 assert.equal(c.session({...task,id:'g',provider:'grok',status:'done',configDir:home,ranIn:ran}).total,10); // finished: worktree gone, ranIn kept
 assert.equal(c.session({...task,status:'running'}).complete,false);
 assert.equal(new UsageCollector(board).session(task).total,80);
 fs.unlinkSync(file);fs.writeFileSync(file,records(start,result(2)).map(line).join(''));
 assert.equal(c.session(task).total,8);
 board.events=()=>[{hook_event_name:'UserPromptSubmit',t:999}];assert.equal(c.session(task).complete,false);
});
test('transcript fallback deduplicates request ids, counts input/cache only and includes nested workers', t => {
 const dir=temp(t), file=path.join(dir,'s.jsonl'), nested=path.join(dir,'s','subagents','deep');fs.mkdirSync(nested,{recursive:true});
 const row=(id,n)=>({type:'assistant',timestamp:new Date().toISOString(),message:{id,model:'opus',usage:{input_tokens:n,cache_read_input_tokens:n,cache_creation_input_tokens:n,output_tokens:1}}});
 fs.writeFileSync(file,line(row('same',10))+line(row('same',10)));
 fs.writeFileSync(path.join(nested,'agent-a.jsonl'),line(row('child',5)));
 const c=new UsageCollector({dir,events:()=>[],transcriptOf:()=>file});
 const m=c.session({id:'t',sessionId:'s',status:'review'});
 assert.equal(m.tokens.input,15);assert.equal(m.tokens.output,0);assert.equal(m.total,undefined);assert.equal(m.complete,false);
});
test('subagent observation reads nested transcripts incrementally and records the reported model',t=>{
 const dir=temp(t),file=path.join(dir,'s','subagents','nested','agent-a.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});
 const row={type:'assistant',message:{model:'claude-test',content:[{type:'tool_use',id:'tool1',name:'Read',input:{file_path:'a'}}]}};
 fs.writeFileSync(file,line(row));let a=subagents(path.join(dir,'s.jsonl'))[0];assert.equal(a.model,'claude-test');assert.equal(a.steps,1);
 fs.appendFileSync(file,line(row));assert.equal(subagents(path.join(dir,'s.jsonl'))[0].steps,1);
 fs.appendFileSync(file,line({type:'assistant',message:{stop_reason:'end_turn',content:[{type:'text',text:'Done'}]}}));assert.equal(subagents(path.join(dir,'s.jsonl'))[0].done,true);
});
test('wrapper passes streams unchanged and records only usage metadata across reset and resume', t=>{
 const wrapper=path.join(__dirname,'../wrapper',process.platform==='win32'?'entomatical-claude.exe':'entomatical-claude.js');
 // The launcher is git-ignored, so a fresh worktree has none: build it (npm run build:wrapper) instead of failing with ENOENT.
 if(process.platform==='win32'&&!fs.existsSync(wrapper))execFileSync('pwsh',['-NoProfile','-File',path.join(__dirname,'../wrapper/build.ps1')],{stdio:'ignore'});
 // Run JavaScript through Node when a Windows checkout is tested in WSL (its shebang can have CRLF).
 const binary=process.platform==='win32'?wrapper:process.execPath, prefix=process.platform==='win32'?[]:[wrapper];
 const dir=temp(t),id='12345678-1234-1234-1234-123456789abc';
 const rows=[{type:'system',subtype:'init',session_id:id},{type:'assistant',session_id:id,message:{content:'PRIVATE PROMPT'}},{type:'result',session_id:id,subtype:'success',modelUsage:usage(5),result:'PRIVATE RESULT'},{type:'system',subtype:'conversation_reset',session_id:id},{type:'result',session_id:id,subtype:'success',modelUsage:usage(2)}];
 // Scratch home and temp folder: never the machine's inner wrapper or the live wrapper log.
 const env={...process.env,ENTOMATICAL_METRICS_DIR:dir,TMPDIR:dir,TEMP:dir,TMP:dir,HOME:dir,USERPROFILE:dir};delete env.ENTOMATICAL_WRAPPED;
 const script=path.join(dir,'fake.js');fs.writeFileSync(script,'process.stdout.write('+JSON.stringify(rows.map(line).join(''))+');');
 const out=execFileSync(binary,[...prefix,process.execPath,script],{encoding:'utf8',input:'',cwd:dir,env});
 assert.equal(out,rows.map(line).join(''));
 const file=fs.readdirSync(dir).find(f=>f.endsWith('.jsonl')),saved=fs.readFileSync(path.join(dir,file),'utf8');assert.doesNotMatch(saved,/PRIVATE/);
 const measured=summarizeStream(saved.trim().split('\n').map(JSON.parse));assert.equal(measured.total,28);assert.equal(measured.complete,true);
 execFileSync(binary,[...prefix,process.execPath,script,'--resume',id],{encoding:'utf8',input:'',cwd:dir,env});
 const second=fs.readdirSync(dir).find(f=>f.endsWith('.jsonl')&&f!==file);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,second),'utf8').split('\n')[0]).resumed,true);
});
test('statusline saves context without rate limits and hook preserves native worker lifecycle fields',t=>{
 const dir=temp(t),context=path.join(dir,'context.json');
 execFileSync(process.execPath,[path.join(__dirname,'../hook/statusline.js'),'main',context],{input:JSON.stringify({session_id:'s',context_window:{used_percentage:42,context_window_size:200000}}),env:{...process.env,ENTOMATICAL_USAGE_DIR:dir}});
 const c=JSON.parse(fs.readFileSync(context,'utf8'));assert.equal(c.usedPercent,42);assert.equal(c.capacity,200000);
 const hook=path.join(dir,'hook.jsonl');
 execFileSync(process.execPath,[path.join(__dirname,'../hook/hook.js'),hook],{input:JSON.stringify({hook_event_name:'SubagentStart',agent_id:'child',agent_type:'Explore',model:'claude-test',effort_level:'high',secret:'not retained'})});
 const e=JSON.parse(fs.readFileSync(hook,'utf8'));assert.equal(e.agent_id,'child');assert.equal(e.effort_level,'high');assert.equal(e.secret,undefined);
});
