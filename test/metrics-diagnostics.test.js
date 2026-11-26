const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageCollector, summarizeStream } = require('../out/metrics');
const line = o => JSON.stringify(o) + '\n';
const usage = n => ({ opus: { inputTokens:n, outputTokens:n, cacheReadInputTokens:n, cacheCreationInputTokens:n } });
const start = { kind:'start', producer:'p', sequence:0, at:1, resumed:false };
const end = (n=10) => ({ kind:'result', producer:'p', sequence:n, at:n+2, subtype:'success', modelUsage:usage(n) });
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ab-diagnostics-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.mkdirSync(path.join(dir,'metrics'));
 const stream=path.join(dir,'metrics','s.p.jsonl'), transcript=path.join(dir,'s.jsonl');
 const task={id:'task',sessionId:'s',status:'review'};
 const board={dir,events:()=>[],transcriptOf:()=>transcript};
 const log=path.join(dir,'measurements','task.diagnostics.jsonl');
 const rows=()=>fs.readFileSync(log,'utf8').split('\n').filter(Boolean).flatMap(s=>{try{return [JSON.parse(s)];}catch{return [];}});
 return {dir,stream,transcript,task,board,log,rows};
}
const codes = m => m.diagnostics.map(d=>d.code);
const transcriptRow = { type:'assistant',timestamp:'2026-10-25T00:00:00Z',message:{id:'request',model:'opus',usage:{input_tokens:5,cache_read_input_tokens:2,cache_creation_input_tokens:1,output_tokens:1}} };

test('fallback retains an investigable corrupt-stream location without copying its payload',t=>{
 const f=fixture(t),prefix=line({...start,irrelevant:'é'});
 fs.writeFileSync(f.stream,prefix+'{"DO_NOT_COPY_SECRET": broken}\n');fs.writeFileSync(f.transcript,line(transcriptRow));
 const m=new UsageCollector(f.board).session(f.task);
 assert.equal(m.source,'transcript');assert.equal(m.complete,false);assert.equal(m.tokens.input,5);
 const d=m.diagnostics.find(d=>d.code==='source_parse_failed');assert.ok(d);
 assert.equal(d.source.file,f.stream);assert.equal(d.source.line,2);assert.equal(d.source.byteOffset,Buffer.byteLength(prefix));assert.ok(d.source.identity);
 assert.ok(codes(m).includes('transcript_output_unfinalized'));assert.doesNotMatch(JSON.stringify(m),/DO_NOT_COPY_SECRET/);
 assert.ok(m.gaps.some(g=>/parse|JSON|read/i.test(g)));
});
test('valid JSON with invalid stream shape becomes a gap, never a crash or complete total',t=>{
 for(const bad of [null,[],{},42,{kind:'result',producer:'p',sequence:'bad',at:3}]){
  const m=summarizeStream([start,end(),bad]);assert.equal(m.complete,false);assert.ok(codes(m).includes('source_record_invalid'));
 }
 const f=fixture(t);fs.writeFileSync(f.stream,line(start)+line(null)+line(end()));
 assert.equal(new UsageCollector(f.board).session(f.task).complete,false);
});
test('counter diagnostics identify missing fields, invalid fields and exact numeric decreases',()=>{
 const missing=end();delete missing.modelUsage.opus.outputTokens;missing.modelUsage.opus.cacheReadInputTokens='DO_NOT_COPY_SECRET';
 const m=summarizeStream([start,missing]);const d=m.diagnostics.find(d=>d.code==='source_fields_invalid');assert.ok(d);
 assert.match(JSON.stringify(d.facts.missingFields),/outputTokens/);assert.match(JSON.stringify(d.facts.invalidFields),/cacheReadInputTokens/);
 assert.doesNotMatch(JSON.stringify(d),/DO_NOT_COPY_SECRET/);
 const decrease=summarizeStream([start,end(10),end(2)]).diagnostics.find(d=>d.code==='counter_decreased');assert.ok(decrease);
 assert.ok(decrease.facts.decreases.some(v=>v.previous===10&&v.current===2));
});
test('diagnostic history survives polling, reload and later recovery without duplicate records',t=>{
 const f=fixture(t);fs.writeFileSync(f.stream,'{bad}\n');fs.writeFileSync(f.transcript,line(transcriptRow));
 let c=new UsageCollector(f.board);const first=c.persist(f.task);const row=f.rows().find(d=>d.code==='source_parse_failed');assert.ok(row?.id);assert.equal(row.taskId,'task');assert.equal(row.sessionId,'s');assert.ok(row.firstObservedAt);
 const n=f.rows().length;c.persist(f.task);assert.equal(f.rows().length,n);
 c=new UsageCollector(f.board);c.persist(f.task);assert.equal(f.rows().length,n);
 fs.writeFileSync(f.stream,line(start)+line(end()));const repaired=c.persist(f.task);assert.equal(repaired.complete,true);
 assert.equal(f.rows().filter(d=>d.id===row.id).length,1);assert.deepEqual(f.rows().find(d=>d.id===row.id),row);
 assert.ok(first.diagnostics.find(d=>d.id===row.id));
});
test('a running session polled every tick adds one journal line per settled snapshot, not per tick, and the journal is not re-read',t=>{
 // Task 631b83 (29 Oct 2026) had 423 usage_newer_than_snapshot lines: status and lastWork made each tick a new fingerprint.
 const f=fixture(t);fs.writeFileSync(f.stream,line(start)+line(end()));
 let tick=100;f.board.events=()=>[{hook_event_name:'PostToolUse',t:tick}];
 const reads=[],readFileSync=fs.readFileSync;
 fs.readFileSync=function(file,...rest){if(file===f.log)reads.push(file);return readFileSync.call(this,file,...rest);};
 try {
  const c=new UsageCollector(f.board);
  for(let i=0;i<20;i++){tick+=1000;c.persist({...f.task,status:i%3?'running':'needs-input'});}
  let journalReads=reads.length;
  assert.equal(f.rows().filter(d=>d.code==='usage_newer_than_snapshot').length,1);
  fs.appendFileSync(f.stream,line({...end(20),at:50}));
  const before=reads.length;
  for(let i=0;i<5;i++){tick+=1000;c.persist({...f.task,status:'running'});}
  journalReads+=reads.length-before;
  assert.equal(f.rows().filter(d=>d.code==='usage_newer_than_snapshot').length,2); // a new snapshot is new evidence
  assert.equal(journalReads,0); // the journal did not exist at first, and each append updates what is kept in memory
 } finally { fs.readFileSync=readFileSync; }
});
test('an interrupted diagnostics tail does not swallow the next complete record',t=>{
 const f=fixture(t);fs.writeFileSync(f.stream,'{bad}\n');fs.writeFileSync(f.transcript,line(transcriptRow));
 new UsageCollector(f.board).persist(f.task);const original=f.rows().find(d=>d.code==='source_parse_failed');
 fs.appendFileSync(f.log,'{"interrupted":');fs.appendFileSync(f.stream,'null\n');
 new UsageCollector(f.board).persist(f.task);const rows=f.rows();
 assert.ok(rows.some(d=>d.id===original.id));assert.ok(rows.some(d=>d.code==='source_record_invalid'));
 assert.equal(rows.filter(d=>d.id===original.id).length,1);
});
test('failed diagnostic writes remain visible to later UI reads and can recover',t=>{
 const f=fixture(t);fs.writeFileSync(f.stream,'{bad}\n');fs.writeFileSync(f.transcript,line(transcriptRow));fs.mkdirSync(f.log,{recursive:true});
 const c=new UsageCollector(f.board);const m=c.persist(f.task);
 assert.ok(codes(m).includes('diagnostic_write_failed'));assert.ok(codes(c.session(f.task)).includes('diagnostic_write_failed'));
 const failure=m.diagnostics.find(d=>d.code==='diagnostic_write_failed');assert.equal(failure.stored,false);
 fs.rmdirSync(f.log);c.persist(f.task);assert.ok(f.rows().some(d=>d.code==='source_parse_failed'));
 assert.equal(codes(c.session(f.task)).includes('diagnostic_write_failed'),false);
});
test('filesystem errors retain safe OS evidence; optional context errors do not invalidate token totals',t=>{
 const f=fixture(t);fs.writeFileSync(f.stream,line(start)+line(end()));fs.mkdirSync(f.transcript);
 const context=path.join(f.dir,'metrics','task.context.json');fs.writeFileSync(context,'{"DO_NOT_COPY_SECRET": broken}');
 const c=new UsageCollector(f.board),m=c.session(f.task);assert.equal(m.complete,true);assert.equal(m.total,40);
 assert.ok(m.diagnostics.some(d=>d.metric==='context'));assert.doesNotMatch(JSON.stringify(m),/DO_NOT_COPY_SECRET/);
 fs.unlinkSync(f.stream);const missing=c.session(f.task);
 assert.ok(missing.diagnostics.some(d=>d.code==='source_read_failed' && d.source.file===f.transcript && d.facts.errorCode));
});
test('unsaved evidence is journaled after storage recovers even when the source recovered first',t=>{
 const f=fixture(t);fs.writeFileSync(f.stream,'{bad}\n');fs.writeFileSync(f.transcript,line(transcriptRow));fs.mkdirSync(f.log,{recursive:true});
 const stamp=new Date('2026-10-25T00:00:00Z');fs.utimesSync(f.stream,stamp,stamp);
 const c=new UsageCollector(f.board),failed=c.persist(f.task),original=failed.diagnostics.find(d=>d.code==='source_parse_failed');assert.ok(original);
 fs.writeFileSync(f.stream,line(start)+line(end()));fs.utimesSync(f.stream,stamp,stamp);fs.rmdirSync(f.log);
 const recovered=c.persist(f.task);assert.equal(recovered.complete,true);assert.equal(codes(recovered).includes('source_parse_failed'),false);
 const history=f.rows();assert.ok(history.some(d=>d.id===original.id));assert.ok(history.some(d=>d.code==='diagnostic_write_failed'));
 assert.equal(history.find(d=>d.id===original.id).firstObservedAt,original.firstObservedAt);
});
