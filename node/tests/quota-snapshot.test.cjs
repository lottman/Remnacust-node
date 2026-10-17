const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
const { createHash, randomUUID } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const root = path.join(__dirname, '../src/modules/xray-core');
function load(name, mocks={}) {
    const source=require('node:fs').readFileSync(path.join(root,name+'.ts'),'utf8');
    const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const ref={exports:{}};new Function('require','module','exports',compiled)(id=>mocks[id]??require(id),ref,ref.exports);return ref.exports;
}
const ledger=load('quota-ledger');
const snapshot=load('quota-snapshot');
const frame=payload=>`{"payload":${JSON.stringify(payload)},"sha256":"${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}"}\n`;
async function fixture(t) {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'quota-snapshot-'));await fs.chmod(dir,0o700);
    t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'quota','ledger.json');await ledger.prepareQuotaLedger(false,file);
    const initial=JSON.parse(await fs.readFile(file,'utf8')).payload;
    return {file,initial};
}
function racingReader(mutate) {
    return load('quota-ledger',{'node:fs/promises':{...fs,open:async(...args)=>{
        const h=await fs.open(...args);let called=false;
        return {stat:()=>h.stat(),close:()=>h.close(),read:async(...readArgs)=>{if(!called){called=true;await mutate(args[0]);}return h.read(...readArgs);}};
    }}});
}
test('live reads take a complete prefix during ongoing appends; boot verification remains strict',async t=>{
    const {file,initial}=await fixture(t);let sequence=0;
    const reader=racingReader(()=>fs.appendFile(file,frame({...initial,sequence:++sequence})));
    const observed=await reader.readQuotaJournalSnapshot(file);assert.equal(observed.sequence,0);
    assert.equal((await ledger.readQuotaJournal(file)).sequence,1);
    await assert.rejects(reader.readQuotaJournal(file),{code:'EAGAIN'});
    assert.equal(sequence,4,'Strict verification retries and refuses a continuously changing file');
});
test('partial append is retried from a new descriptor, never accepted as an empty or partial report',async t=>{
    const {file,initial}=await fixture(t);const next=frame({...initial,sequence:1});
    await fs.appendFile(file,next.slice(0,-10));let completed=false;
    const reader=racingReader(async()=>{if(!completed){completed=true;await fs.appendFile(file,next.slice(-10));}});
    assert.equal((await reader.readQuotaJournalSnapshot(file)).sequence,1);
    await fs.appendFile(file,'broken\n');await assert.rejects(reader.readQuotaJournalSnapshot(file));
});
test('atomic compaction preserves the opened snapshot; the next observation sees the replacement',{skip:process.platform==='win32'},async t=>{
    const {file,initial}=await fixture(t);let replaced=false;
    const reader=racingReader(async()=>{if(replaced)return;replaced=true;const tmp=file+'.next';await fs.writeFile(tmp,frame({...initial,sequence:8,retiredBefore:123}),{mode:0o600});await fs.rename(tmp,file);});
    assert.equal((await reader.readQuotaJournalSnapshot(file)).sequence,0);
    const next=await ledger.readQuotaJournalSnapshot(file);assert.equal(next.sequence,8);assert.equal(next.retiredBefore,123);
});
test('truncated and same-size rewritten opened files fail closed',async t=>{
    const {file,initial}=await fixture(t);
    const truncated=racingReader(()=>fs.truncate(file,2));await assert.rejects(truncated.readQuotaJournalSnapshot(file));
    await fs.writeFile(file,frame(initial));let tick=Date.now()+10000;
    const rewritten=racingReader(async()=>{await fs.writeFile(file,frame(initial));tick+=1000;await fs.utimes(file,new Date(tick),new Date(tick));});
    await assert.rejects(rewritten.readQuotaJournalSnapshot(file),{code:'EAGAIN'});
});
test('one compressed snapshot carries all native journal entries, exact integers and request bindings',async()=>{
    const entries=new Map();
    for(let n=99999;n>=0;n--)entries.set(`${n.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`,{group:'user:global',owner:'9223372036854775807',expiresAt:253402300799000,ceiling:'9223372036854775807',reserved:'9007199254740993',prepared:true,activated:true,scale:1000000000});
    const request={generation:randomUUID(),requestId:randomUUID()},instance=randomUUID(),core=randomUUID();
    const envelope=await snapshot.encodeQuotaSnapshot(request,{instance,sequence:27,checkpoint:25,retiredBefore:123,registrationsRequired:true,watermarksRequired:true,entries},'19',core);
    const raw=gunzipSync(Buffer.from(envelope.data,'base64'));const data=JSON.parse(raw);
    assert.equal(raw.length,envelope.bytes);assert.equal(createHash('sha256').update(raw).digest('hex'),envelope.sha256);
    assert.equal(data.entries.length,100000);assert.equal(data.entries[0].id,'00000000-1111-4111-8111-111111111111');
    assert.equal(data.entries[99999].reserved,'9007199254740993');assert.equal(data.generation,request.generation);assert.equal(data.requestId,request.requestId);assert.equal(data.coreProcessId,core);
    assert.equal(data.retiredBefore,123);assert.equal(snapshot.quotaSnapshotRequest.safeParse({...request,after:randomUUID()}).success,false);
});
