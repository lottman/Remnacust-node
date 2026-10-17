const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),fs=require('node:fs/promises');
const {randomUUID,createHash}=require('node:crypto');
const load=(name,mocks={})=>require('./load-typescript.cjs')(path.join(__dirname,'../src/modules/xray-core',name+'.ts'),mocks);
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'recovery-release-'));await fs.chmod(dir,0o700);t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:30}));
 let failRelease=false;
 const mocks={'node:fs/promises':{...fs,open:async(file,...args)=>process.platform==='win32'&&file===dir?{sync:async()=>{},close:async()=>{}}:fs.open(file,...args),rename:async(from,to)=>{if(failRelease&&to===path.join(dir,'recovery.json')){failRelease=false;throw Error('Injected marker rename failure');}return fs.rename(from,to);}}};
 const fence=load('quota-recovery-fence',mocks),codec=load('recovery-release',mocks),quiescence=load('recovery-quiescence',mocks),receipt=load('usage-receipt'),ledger=load('quota-ledger'),user=load('user-quota');
 const core=randomUUID(),stream=randomUUID(),generation=randomUUID(),file=path.join(dir,'recovery.json');
 const paused=await fence.persistRecoveryFence({generation,requestId:randomUUID(),coreProcessId:core,instance:stream,previous:null},file);
 const sample={requestId:randomUUID(),generation,coreProcessId:core,instance:stream,previous:paused.digest,preparationDigest:'a'.repeat(64),sourceDigest:'b'.repeat(64),retainedDigest:null,prior:{sequence:'9007199254740993',digest:'c'.repeat(64)},receipt:{action:'sample',stream,sequence:'9007199254740994',coreProcessId:core}};
 const frame={sequence:sample.receipt.sequence,coreProcessId:core,capturedAt:'1792192954000',stats:[]},response={...frame,stream,capability:receipt.USAGE_RECEIPTS,digest:receipt.frameDigest(frame)};
 const witness=await quiescence.persistRecoveryQuiescence(sample,response,paused,'d'.repeat(64),path.join(dir,'witness.json'));
 const encode=(pending=null)=>{const data=Buffer.from(JSON.stringify({version:1,stream,acked:frame.sequence,ackDigest:response.digest,pending}));return Buffer.concat([Buffer.from('REMNACUST-USAGE-1\n'+createHash('sha256').update(data).digest('hex')+'\n'),data]);};
 const journal=encode(),policyGeneration=randomUUID();
 const policy={revision:'42',userQuota:user.USER_QUOTA_VERSION,offlineReserves:ledger.QUOTA_RESERVE_VERSION,legacyGroups:['global'],registrations:[],groups:{global:{blockAll:true,fenceAll:true,reserves:{}}},hosts:{}};
 const request={generation,requestId:randomUUID(),coreProcessId:core,instance:stream,previous:paused.digest,policyRevision:'42',policyGeneration,witnessDigest:witness.digest,journalDigest:createHash('sha256').update(journal).digest('hex')};
 const context={pid:77,coreProcessId:core,instance:stream,applied:true,userQuotaRequired:true,fence:paused,policy,policyGeneration,witness,journal};
 const observe=async()=>({...context,fence:await fence.readRecoveryFence(file)});
 return {dir,file,codec,fence,request,context,observe,journal,encode,frame,fail:()=>{failRelease=true;}};
}
test('release records durable exact intent before marker; replay preserves ledger and held policy',async t=>{
 const f=await fixture(t),policy=structuredClone(f.context.policy),before=Buffer.from(f.journal);
 const result=await f.codec.persistRecoveryRelease(f.request,f.observe,f.dir);
 assert.equal(result.state,'RELEASED');assert.equal(result.sequence,'2');assert.equal(result.previous,f.request.previous);
 assert.deepEqual(await f.codec.persistRecoveryRelease(f.request,f.observe,f.dir),result);
 assert.deepEqual(f.context.policy,policy);assert.deepEqual(f.context.journal,before);
 const intent=JSON.parse(await fs.readFile(path.join(f.dir,'release-'+f.request.requestId+'.json'),'utf8'));assert.deepEqual(intent.request,f.request);assert.deepEqual(intent.record,result);
 await assert.rejects(f.codec.persistRecoveryRelease({...f.request,requestId:randomUUID()},f.observe,f.dir),/identity conflicts/);
 await fs.rm(path.join(f.dir,'release-'+f.request.requestId+'.json'));await assert.rejects(f.codec.persistRecoveryRelease(f.request,f.observe,f.dir),/Missing durable/);
});
test('non-held admissions, changed native proof or journal cannot create release',async t=>{
 const f=await fixture(t),original=structuredClone(f.context);
 const patches=[{applied:false},{userQuotaRequired:false},{coreProcessId:randomUUID()},{instance:randomUUID()},{policyGeneration:randomUUID()},
 {policy:{...original.policy,revision:'43'}},{policy:{...original.policy,groups:{global:{blockAll:true,fenceAll:false,reserves:{}}}}},
 {policy:{...original.policy,groups:{global:{blockAll:true,fenceAll:true,reserves:{'7':{}}}}}},
 {journal:f.encode({...f.frame,sequence:'9007199254740995'})},{witness:{...original.witness,digest:'f'.repeat(64)}}];
 for(const patch of patches){await assert.rejects(f.codec.persistRecoveryRelease(f.request,async()=>({...f.context,...patch}),f.dir));assert.equal((await f.fence.readRecoveryFence(f.file)).state,'FENCED');}
 await assert.rejects(fs.stat(path.join(f.dir,'release-'+f.request.requestId+'.json')),{code:'ENOENT'});
 assert.equal(f.codec.recoveryReleaseRequest.safeParse({...f.request,actor:randomUUID()}).success,false);
 assert.equal(f.codec.recoveryReleaseRequest.safeParse({...f.request,instance:null}).success,false);
});
test('intent survives failed marker publication and same request safely finishes without advancing twice',async t=>{
 const f=await fixture(t);f.fail();await assert.rejects(f.codec.persistRecoveryRelease(f.request,f.observe,f.dir),/Injected marker/);
 assert.equal((await f.fence.readRecoveryFence(f.file)).state,'FENCED');await fs.stat(path.join(f.dir,'release-'+f.request.requestId+'.json'));
 const result=await f.codec.persistRecoveryRelease(f.request,f.observe,f.dir);assert.equal(result.sequence,'2');
 assert.deepEqual(await f.codec.persistRecoveryRelease(f.request,f.observe,f.dir),result);
});
test('process changes before publication leave restrictive marker intact',async t=>{
 const f=await fixture(t);let reads=0;
 await assert.rejects(f.codec.persistRecoveryRelease(f.request,async()=>({...await f.observe(),pid:++reads===1?77:78}),f.dir),/changed before commit/);
 assert.equal((await f.fence.readRecoveryFence(f.file)).state,'FENCED');
});

test('persisted approval cannot be reused with a changed policy or corrupted intent',async t=>{
 const f=await fixture(t);f.fail();await assert.rejects(f.codec.persistRecoveryRelease(f.request,f.observe,f.dir));
 f.context.policy.revision='43';const edited={...f.request,policyRevision:'43'};
 await assert.rejects(f.codec.persistRecoveryRelease(edited,f.observe,f.dir),/intent conflicts/);
 assert.equal((await f.fence.readRecoveryFence(f.file)).state,'FENCED');
 f.context.policy.revision='42';await fs.writeFile(path.join(f.dir,'release-'+f.request.requestId+'.json'),'{}');
 await assert.rejects(f.codec.persistRecoveryRelease(f.request,f.observe,f.dir));
 assert.equal((await f.fence.readRecoveryFence(f.file)).state,'FENCED');
});
