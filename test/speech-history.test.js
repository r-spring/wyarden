const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {speechHistory}=require('../out/speech-history');
test('speech history preserves data, remaps collisions and parents, and is idempotent',()=>{
 const r=fs.mkdtempSync(path.join(os.tmpdir(),'speech-history-'));try{fs.mkdirSync(path.join(r,'.entomatical-speech'));const old=[{id:'abc123',title:'old',prompt:'private draft',status:'done',worktree:'/old/path'},{id:'def456',parentId:'abc123',title:'child',prompt:'child',status:'done'}];fs.writeFileSync(path.join(r,'.entomatical-speech','tasks.json'),JSON.stringify(old));const original=[{id:'abc123',title:'existing'}];const added=speechHistory(r,original);assert.equal(added.length,2);assert.equal(added[0].id,'speech-abc123');assert.equal(added[0].worktree,'/old/path');assert.equal(added[1].parentId,'speech-abc123');assert.deepEqual(speechHistory(r,[...original,...added]),[]);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r,'.entomatical-speech','tasks.json'))),old);
 fs.mkdirSync(path.join(r,'.entomatical'));fs.writeFileSync(path.join(r,'.entomatical','speech-imported.json'),JSON.stringify(old.map(t=>t.id)));assert.deepEqual(speechHistory(r,original),[]);
 }finally{fs.rmSync(r,{recursive:true,force:true});}
});
