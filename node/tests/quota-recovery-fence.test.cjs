const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises');
const os=require('node:os'),ts=require('typescript'),{createRequire}=require('node:module'),{randomUUID}=require('node:crypto');
const root=path.join(__dirname,'../src/modules/xray-core');
function load(name,mocks={}){
 const filename=path.join(root,name+'.ts'),ref={exports:{}},local=createRequire(filename);
 const code=ts.transpileModule(require('node:fs').readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',code)(id=>Object.hasOwn(mocks,id)?mocks[id]:id.startsWith('.')?load(id.slice(2),mocks):local(id),ref,ref.exports);return ref.exports;
}
const helpers=load('quota-recovery-fence');
const boot=require('../docker/rootfs/etc/s6-overlay/scripts/core-boot.cjs');
const V=helpers.QUOTA_RECOVERY_FENCE,core=randomUUID(),instance=randomUUID();
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'quota-recovery-'));await fs.chmod(dir,0o700);t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:30}));
 const quota=path.join(dir,'quota');await fs.mkdir(quota,{mode:0o700});
 // Windows cannot fsync a directory; only that syscall is stubbed here.
 // The actual Linux directory fsync is checked in the Linux runtime tests.
 const h=load('quota-recovery-fence',{'node:fs/promises':{...fs,open:async(file,...args)=>process.platform==='win32'&&file===quota?{sync:async()=>{},close:async()=>{}}:fs.open(file,...args)}});
 return {h,dir,file:path.join(quota,'recovery.json'),status:path.join(quota,'recovery.status.json')};
}
const request=()=>({generation:randomUUID(),requestId:randomUUID(),coreProcessId:core,instance,previous:null});
const ack=(record,pid=7,processId=core)=>({version:V,pid,coreProcessId:processId,coreIncarnation:'remnacust-core-incarnation-v1',state:record?.state??'NONE',digest:record?.digest??null});

test('recovery pause persists an exact checksummed request; retries reuse it and stale edits cannot replace it',async t=>{
 const f=await fixture(t),r=request();const before=Buffer.from('untouched quota journal');await fs.writeFile(path.join(f.dir,'ledger.json'),before);
 const first=await f.h.persistRecoveryFence(r,f.file);assert.equal(first.state,'FENCED');assert.equal(first.sequence,'1');assert.equal(first.digest,f.h.recoveryFenceDigest(first));
 const candidate=path.join(f.dir,'candidate');await fs.writeFile(candidate,'old core');
 assert.throws(()=>boot.verifyCorePolicy(candidate,path.join(f.dir,'host-policy.json'),path.join(f.dir,'checkpoint.pb')),/cannot enforce/);
 await fs.writeFile(candidate,V);assert.doesNotThrow(()=>boot.verifyCorePolicy(candidate,path.join(f.dir,'host-policy.json'),path.join(f.dir,'checkpoint.pb')));
 assert.deepEqual(boot.verifyRecoveryFence(Buffer.from(JSON.stringify(first))),first);
 assert.deepEqual(await f.h.persistRecoveryFence(r,f.file),first);
 await assert.rejects(f.h.persistRecoveryFence({...r,generation:randomUUID()},f.file),/identity conflicts/);
 await assert.rejects(f.h.persistRecoveryFence(request(),f.file),/changed/);
 const second=await f.h.persistRecoveryFence({...request(),previous:first.digest},f.file);assert.equal(second.sequence,'2');assert.equal(second.previous,first.digest);
 assert.deepEqual(await fs.readFile(path.join(f.dir,'ledger.json')),before,'A pause must not change credit or the journal');
});

test('node and boot share the native recovery fence digest contract',()=>{
 const record={version:V,generation:'11111111-1111-4111-8111-111111111111',token:'22222222-2222-4222-8222-222222222222',state:'FENCED',sequence:'1',previous:null,
  digest:'a956d69b330b83f9d303c91064f5f9cbb7728c1df810bbf11a122dcc52e0fc8b'};
 assert.equal(helpers.recoveryFenceDigest(record),record.digest);assert.deepEqual(boot.verifyRecoveryFence(Buffer.from(JSON.stringify(record))),record);
});

test('a pause acknowledgement is bound to both the live PID and incarnation and cannot outlive its marker',async t=>{
 const f=await fixture(t),r=request();const record=await f.h.persistRecoveryFence(r,f.file);
 const write=async value=>{await fs.writeFile(f.status,JSON.stringify(value));await fs.chmod(f.status,0o600);};
 await write(ack(record));assert.deepEqual((await f.h.readRecoveryFenceState({up:true,pid:7},core,f.file,f.status)).record,record);
 for(const bad of [ack(record,8),ack(record,7,randomUUID()),{...ack(record),digest:'0'.repeat(64)},ack(null)]){
  await write(bad);await assert.rejects(f.h.readRecoveryFenceState({up:true,pid:7},core,f.file,f.status),/changed/);
 }
 await write(ack(record));await fs.unlink(f.file);assert.deepEqual((await f.h.readRecoveryFenceState({up:true,pid:7},core,f.file,f.status)).record,record);
 await write(ack(null));await assert.rejects(f.h.readRecoveryFenceState({up:true,pid:7},core,f.file,f.status),/changed/);
 await write(ack(record));assert.deepEqual((await f.h.readRecoveryFenceState({up:true,pid:7},core,f.file,f.status)).record,record);
 await assert.rejects(f.h.readRecoveryFenceState({up:false,pid:7},core,f.file,f.status),/No live/);
});

test('boot, node parser and digest reject malformed state, unbounded counters and fabricated release records',async t=>{
 const f=await fixture(t),record=await f.h.persistRecoveryFence(request(),f.file);
 const resign=value=>({...value,digest:f.h.recoveryFenceDigest(value)});
 for(const value of [resign({...record,state:'RELEASED'}),resign({...record,sequence:'9223372036854775808'}),
  resign({...record,previous:'0'.repeat(64)}),{...record,digest:'0'.repeat(64)},{...record,extra:true}]){
  assert.equal(f.h.recoveryFenceSchema.safeParse(value).success,false);
  assert.throws(()=>boot.verifyRecoveryFence(Buffer.from(JSON.stringify(value))));
 }
 await fs.writeFile(f.file,'{}');assert.deepEqual(await f.h.readRecoveryFence(f.file),record);
 await fs.writeFile(f.file,'x'.repeat(8193));assert.deepEqual(await f.h.readRecoveryFence(f.file),record);
 await fs.writeFile(path.join(path.dirname(f.file),'recovery-required.json'),'{}');await assert.rejects(f.h.readRecoveryFence(f.file));
});

test('recovery records refuse links, unsafe ownership modes and nonregular paths before opening',async t=>{
 const f=await fixture(t);const record=await f.h.persistRecoveryFence(request(),f.file),link=path.join(f.dir,'link.json');
 await fs.symlink(process.platform==='win32'?f.dir:f.file,link,process.platform==='win32'?'junction':'file');
 try{await assert.rejects(f.h.readRecoveryFence(link),/private/);}finally{await fs.unlink(link);}
 await assert.rejects(f.h.readRecoveryFence(f.dir),/private/);
 if(process.platform!=='win32'){
  await fs.chmod(f.file,0o644);assert.deepEqual(await f.h.readRecoveryFence(f.file),record);
  await fs.chmod(f.file,0o600);assert.deepEqual(await f.h.readRecoveryFence(f.file),record);
 }
});

test('recovery hold preserves access and prices, removes grant activation and leaves the input unchanged',()=>{
 const h=load('quota-recovery-policy');
 const original={revision:'1',userQuota:'remnacust-user-quota-reserves-v1',offlineReserves:'remnacust-quota-reserves-v1',legacyGroups:['user:global'],legacyOwners:{'1':{allowed:true,expiresAt:0}},legacyQuotaMultipliers:{'user:global':1500000000},registrations:[{original:'untouched'}],groups:{'user:global':{blockAll:false,blockedOwners:{},reserveRequired:true,reserves:{'1':{id:randomUUID(),ceiling:'100'}},unreservedAccounts:{'1':instance}}},hosts:{normal:{groups:['user:global'],allowedIdentities:{original:true}},recovery:{groups:[],userQuotaExempt:true}}};
 const before=structuredClone(original),held=h.heldRecoveryPolicy(original,'2');
 assert.deepEqual(original,before);assert.equal(held.revision,'2');assert.deepEqual(held.groups['user:global'].reserves,{});assert.deepEqual(held.registrations,[]);assert.equal(held.groups['user:global'].fenceAll,true);
 for(const key of ['hosts','legacyOwners','legacyQuotaMultipliers'])assert.deepEqual(held[key],original[key]);
 assert.deepEqual(held.groups['user:global'].unreservedAccounts,original.groups['user:global'].unreservedAccounts);
 assert.equal(h.recoveryPolicyHoldsAdmissions(held),true);
 for(const patch of [{userQuota:undefined},{offlineReserves:undefined},{legacyGroups:[]},{groups:{}},{hosts:{uncovered:{groups:[]}}}])assert.equal(h.recoveryPolicyHoldsAdmissions({...held,...patch}),false);
 const active=structuredClone(held);active.groups['user:global'].reserves={'1':{id:randomUUID()}};assert.equal(h.recoveryPolicyHoldsAdmissions(active),false);
});

test('ordinary policies cannot use the recovery staging gate and stale or released sources cannot stage',()=>{
 const h=load('quota-recovery-policy'),record={state:'FENCED',generation:randomUUID(),digest:'a'.repeat(64)},stage={generation:record.generation,previous:record.digest};
 assert.throws(()=>h.requireRecoveryPolicyGate(record),/paused/);assert.doesNotThrow(()=>h.requireRecoveryPolicyGate(record,stage));
 for(const old of [null,{...record,state:'RELEASED'},{...record,generation:randomUUID()},{...record,digest:'b'.repeat(64)}])assert.throws(()=>h.requireRecoveryPolicyGate(old,stage),/changed/);
 assert.doesNotThrow(()=>h.requireRecoveryPolicyGate(null));
});
