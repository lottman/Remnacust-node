const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),fs=require('node:fs/promises');
const {randomUUID,createHash}=require('node:crypto');
const load=(name,mocks={})=>require('./load-typescript.cjs')(path.join(__dirname,'../src/modules/xray-core',name+'.ts'),mocks);
const receipt=load('usage-receipt'),fences=load('quota-recovery-fence');
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'recovery-quiescence-'));await fs.chmod(dir,0o700);t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:30}));
 const mocks={'node:fs/promises':{...fs,open:async(file,...args)=>process.platform==='win32'&&file===dir?{sync:async()=>{},close:async()=>{}}:fs.open(file,...args)}};
 const codec=load('recovery-quiescence',mocks),stream=randomUUID(),core=randomUUID();
 const fence={version:fences.QUOTA_RECOVERY_FENCE,generation:randomUUID(),token:randomUUID(),state:'FENCED',sequence:'1',previous:null};fence.digest=fences.recoveryFenceDigest(fence);
 const request={requestId:randomUUID(),generation:fence.generation,coreProcessId:core,instance:stream,previous:fence.digest,preparationDigest:'a'.repeat(64),sourceDigest:'b'.repeat(64),retainedDigest:null,prior:{sequence:'9007199254740993',digest:'c'.repeat(64)},receipt:{action:'sample',stream,sequence:'9007199254740994',coreProcessId:core}};
 const frame={sequence:request.receipt.sequence,coreProcessId:core,capturedAt:'1792192954000',stats:[]};const response={...frame,capability:receipt.USAGE_RECEIPTS,stream,digest:receipt.frameDigest(frame)};
 const original=(acked=request.prior.sequence,ackDigest=request.prior.digest,pending=frame)=>{const payload=Buffer.from(JSON.stringify({version:1,stream,acked,ackDigest,pending}));return Buffer.concat([Buffer.from('REMNACUST-USAGE-1\n'+createHash('sha256').update(payload).digest('hex')+'\n'),payload]);};
 return {codec,dir,file:path.join(dir,'witness.json'),request,fence,frame,response,original};
}
test('a durable private witness binds the fresh empty frame, original request, native fence and exact int64 sequence',async t=>{
 const f=await fixture(t);assert.equal(await f.codec.readRecoveryQuiescence(f.request,f.original(),f.file),null);
 const witness=await f.codec.persistRecoveryQuiescence(f.request,f.response,f.fence,'d'.repeat(64),f.file);
 assert.equal(f.codec.recoveryQuiescenceSchema.safeParse(witness).success,true);
 assert.deepEqual(await f.codec.readRecoveryQuiescence(f.request,f.original(),f.file),witness);
 assert.deepEqual(await f.codec.readRecoveryQuiescence(f.request,f.original(f.frame.sequence,f.response.digest,null),f.file),witness);
 for(const patch of [{requestId:randomUUID()},{coreProcessId:randomUUID()},{previous:'e'.repeat(64)},{preparationDigest:'e'.repeat(64)},{sourceDigest:'e'.repeat(64)},{prior:{...f.request.prior,digest:'e'.repeat(64)}}])assert.equal(await f.codec.readRecoveryQuiescence({...f.request,...patch},f.original(),f.file),null);
 const next={...f.frame,sequence:'9007199254740995'};
 assert.equal(await f.codec.readRecoveryQuiescence(f.request,f.original(f.frame.sequence,f.response.digest,next),f.file),null);
 const disk=JSON.parse(await fs.readFile(f.file,'utf8'));disk.journalDigest='e'.repeat(64);await fs.writeFile(f.file,JSON.stringify(disk));
 await assert.rejects(f.codec.readRecoveryQuiescence(f.request,f.original(),f.file));
});
test('nonempty, retained, mismatched and corrupted evidence cannot become a quiescence witness',async t=>{
 const f=await fixture(t);const nonempty={...f.response,stats:[{name:'user>>>77>>>traffic>>>uplink',value:'1'}]};
 assert.equal(await f.codec.persistRecoveryQuiescence(f.request,nonempty,f.fence,'d'.repeat(64),f.file),null);
 await assert.rejects(fs.stat(f.file),{code:'ENOENT'});
 await assert.rejects(f.codec.persistRecoveryQuiescence({...f.request,retainedDigest:f.response.digest},f.response,f.fence,'d'.repeat(64),f.file));
 await assert.rejects(f.codec.persistRecoveryQuiescence({...f.request,coreProcessId:randomUUID()},f.response,f.fence,'d'.repeat(64),f.file));
 await f.codec.persistRecoveryQuiescence(f.request,f.response,f.fence,'d'.repeat(64),f.file);
 await assert.rejects(f.codec.readRecoveryQuiescence(f.request,Buffer.from('broken'),f.file));
 await fs.writeFile(f.file,Buffer.alloc(8193));await assert.rejects(f.codec.readRecoveryQuiescence(f.request,f.original(),f.file));
});
