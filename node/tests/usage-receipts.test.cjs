const test=require('node:test');const assert=require('node:assert/strict');
const path=require('node:path');const util=require('node:util');const crypto=require('node:crypto');
const root=path.join(__dirname,'../src/modules/xray-core');
const load=(name,mocks={})=>require('./load-typescript.cjs')(path.join(root,name+'.ts'),mocks);
const model=load('usage-receipt');
const stream='6bde8fbb-6d28-4d50-99a2-28074f3c235b',core='ff29ee68-a625-4160-9573-cc17de317a5d';
function response(){const frame={sequence:'1',coreProcessId:core,capturedAt:'1',stats:[{name:'user>>>77>>>traffic>>>uplink',value:'9007199254740993'}]};const text=JSON.stringify(frame).replaceAll('>','\\u003e');return {...frame,stream,capability:model.USAGE_RECEIPTS,digest:crypto.createHash('sha256').update(text).digest('hex')};}
const sample={action:'sample',stream,sequence:'1',coreProcessId:core};
test('receipt requests reject ambiguous numbers, unknown fields and nil stream identities',()=>{
    assert.equal(model.usageReceiptRequest.safeParse(sample).success,true);
    for(const value of [{...sample,sequence:1},{...sample,sequence:'01'},{...sample,sequence:'9223372036854775808'},{...sample,sequence:'0'},{...sample,stream:'00000000-0000-0000-0000-000000000000'},{...sample,stream:'ffffffff-ffff-ffff-ffff-ffffffffffff'},{...sample,other:true},{...sample,action:'ack'}])assert.equal(model.usageReceiptRequest.safeParse(value).success,false);
});
test('Go-compatible digest retains exact int64 counters and binds the replayed frame',()=>{
    const frame=response();assert.equal(frame.digest,'8a36f1c97332306024c3fbd25101e639271c84e0091abe904e143b5118f903eb');assert.equal(model.parseUsageReceiptResponse(sample,frame).stats[0].value,'9007199254740993');
    for(const mutate of [v=>v.stats[0].value='9007199254740992',v=>v.coreProcessId=stream,v=>v.sequence='2',v=>v.stream=core,v=>v.stats.push(v.stats[0]),v=>v.stats[0].name='inbound>>>77>>>traffic>>>uplink',v=>v.other=true]){const value=response();mutate(value);assert.throws(()=>model.parseUsageReceiptResponse(sample,value));}
    const ack={...sample,action:'ack',digest:frame.digest};
    assert.equal(model.parseUsageReceiptResponse(ack,{stream,sequence:'1',acknowledged:true}).acknowledged,true);
    assert.throws(()=>model.parseUsageReceiptResponse(ack,{stream,sequence:'2',acknowledged:true}));
});
function fixture(){const management=load('core-management');const state={calls:[],guards:[],instance:stream,process:{up:true,pid:77},binary:Buffer.from(model.USAGE_RECEIPTS),size:1024,stdout:JSON.stringify(response()),reads:0};
    const nest={};for(const name of ['Controller','Post','Body','Headers'])nest[name]=()=>()=>{};nest.UseGuards=(guard)=>{state.guards.push(guard);return ()=>{};};nest.BadRequestException=class extends Error{};nest.ServiceUnavailableException=class extends Error{};
    const execFile=()=>{throw Error('Use async exec');};execFile[util.promisify.custom]=async(binary,args,options)=>{state.calls.push({binary,args,options});if(state.runError)throw state.runError;await state.onRun?.();return {stdout:state.stdout};};
    const quiescence=load('recovery-quiescence',{'./quota-recovery-fence':{...load('quota-recovery-fence'),privateRead:async()=>state.witness?Buffer.from(JSON.stringify(state.witness)):null,publishPrivateRecord:async(file,record,validate)=>{await validate();if(state.witnessFails)throw Error('Witness persistence failed');state.witness=record;}}});
    const {UsageReceiptController}=load('usage-receipt.controller',{'@nestjs/common':nest,'@common/config/app-config':{},'@common/guards/jwt-guards':{JwtDefaultGuard:'JWT'},'./xray-process.service':{},'./core-incarnation':{readCoreIncarnation:async()=>state.currentCore??core},'./core-management':management,'./recovery-quiescence':quiescence,'./usage-archive':{readUsageArchiveFile:async()=>state.original??null},'./quota-recovery-fence':{...load('quota-recovery-fence'),readRecoveryFence:async()=>state.recovery??null,readRecoveryFenceState:async(process,live)=>{if(state.contextError)throw Error('changed');if(!process.up||process.pid!==state.process.pid||live!==(state.currentCore??core))throw Error('changed');return {version:'remnacust-quota-recovery-fence-v1',record:state.recovery??null};}},'./quota-ledger':{verifyQuotaLedger:async()=>state.instance},'./usage-receipt':model,'node:child_process':{execFile},'node:fs/promises':{stat:async()=>({isFile:()=>!state.nonregular,size:state.size,dev:1,ino:2,mtimeMs:3,ctimeMs:4}),readFile:async()=>{state.reads++;return state.binary;}}});
    const controller=new UsageReceiptController({getStatus:async()=>state.process},{getOrThrow:key=>{assert.equal(key,'INTERNAL_SOCKET_PATH');return '/private/control.sock';}});return {state,controller,management};
}
test('JWT-protected exchange binds the local node journal and invokes only the running core via its private socket',async()=>{
    const {state,controller}=fixture();assert.deepEqual(state.guards,['JWT']);
    for(let i=0;i<2;i++)assert.equal((await controller.exchange(sample)).response.stats[0].value,'9007199254740993');
    assert.equal(state.reads,1,'binary capability must be cached by executable identity');
    assert.deepEqual(state.calls[0],{binary:'/proc/77/exe',args:['api','usage-receipt','--server=unix:/private/control.sock','--timeout=10','--action=sample','--stream='+stream,'--sequence=1','--core='+core],options:{timeout:15000,maxBuffer:16*1024*1024}});
});
test('wrong node binding, stopped/nonregular/oversized/unsupported core fail before execution',async()=>{
    for(const mutate of [s=>s.instance=core,s=>s.process.up=false,s=>s.process.pid=0,s=>s.process.pid=1.1,s=>s.nonregular=true,s=>s.size=192*1024*1024+1,s=>s.binary=Buffer.from('legacy')]){const {state,controller}=fixture();mutate(state);await assert.rejects(controller.exchange(sample),/retry the same request/);assert.equal(state.calls.length,0);}
});
test('invalid request, corrupt response and uncertain subprocess failure never trigger a legacy reset',async()=>{
    const invalid=fixture();await assert.rejects(invalid.controller.exchange({...sample,sequence:1}),/Invalid usage receipt request/);assert.equal(invalid.state.calls.length,0);
    for(const value of ['{}','broken',JSON.stringify({...response(),digest:'0'.repeat(64)})]){const {state,controller}=fixture();state.stdout=value;await assert.rejects(controller.exchange(sample),/retry the same request/);assert.equal(state.calls.length,1);}
    const {state,controller}=fixture();state.runError=Error('lost RPC response');await assert.rejects(controller.exchange(sample),/retry the same request/);assert.equal(state.calls.length,1);
});


test('private outside-grant counters preserve exact owner/price and reject noncanonical bindings',()=>{
 const codec=load('unreserved-usage');
 const valid='qfree>>>ff29ee68-a625-4160-9573-cc17de317a5d>>>9007199254740993>>>1500000000>>>1000000000>>>traffic>>>downlink';
 const parsed=codec.parseUnreservedUsageCounter(valid);assert.equal(parsed.owner,'9007199254740993');assert.equal(parsed.factor,1500000000n);assert.equal(parsed.scale,1000000000n);assert.equal(codec.isUsageCounter(valid),true);
 for(const invalid of [valid.replace('9007199254740993','01'),valid.replace('9007199254740993','9223372036854775808'),valid.replace('ff29ee68','FF29ee68'),valid.replace('1500000000','0'),valid.replace('1500000000','100000000001'),valid.replace('1000000000','99'),valid.replace('downlink','sideways'),'user>>>>>>traffic>>>downlink','qfree>>>broken']){assert.equal(codec.isUsageCounter(invalid),false,invalid);}
 const payload={sequence:'1',coreProcessId:'ff29ee68-a625-4160-9573-cc17de317a5d',capturedAt:'1',stats:[{name:valid,value:'9007199254740993'}]};
 const hash=require('node:crypto').createHash('sha256').update(JSON.stringify(payload).replace(/[<>&\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))).digest('hex');
 const request={action:'sample',stream:'6bde8fbb-6d28-4d50-99a2-28074f3c235b',sequence:'1',coreProcessId:payload.coreProcessId};
 const result=model.parseUsageReceiptResponse(request,{...payload,stream:request.stream,capability:model.USAGE_RECEIPTS,digest:hash});assert.equal(result.stats[0].value,'9007199254740993');
});


test('recovery pause blocks old ACK before native execution while retaining readable saved usage',async()=>{
 const {state,controller}=fixture();state.recovery={state:'FENCED',generation:crypto.randomUUID(),digest:'a'.repeat(64)};
 const ack={...sample,action:'ack',digest:response().digest};
 await assert.rejects(controller.exchange(ack),/retry the same request/);assert.equal(state.calls.length,0);assert.equal(state.reads,0);
 assert.equal((await controller.exchange(sample)).response.digest,response().digest);
 assert.equal(state.calls.length,1);assert.ok(state.calls[0].args.includes('--action=sample'));
});
test('post-recovery ACK requires exact generation, fence, live core and journal binding',async()=>{
 const {state,controller}=fixture();const record={state:'RELEASED',generation:crypto.randomUUID(),digest:'a'.repeat(64)};state.recovery=record;
 const ack={...sample,action:'ack',digest:response().digest};state.stdout=JSON.stringify({stream,sequence:'1',acknowledged:true});
 const proof=['v1',record.generation,record.digest,core,stream].join(':');
 for(const value of [undefined,null,[proof],proof+', '+proof,proof.replace(record.generation,crypto.randomUUID()),proof.replace(record.digest,'b'.repeat(64)),proof.replace(core,crypto.randomUUID()),proof.replace(stream,crypto.randomUUID())])
  await assert.rejects(controller.exchange(ack,value),/retry the same request/);
 state.currentCore=crypto.randomUUID();await assert.rejects(controller.exchange(ack,proof),/retry the same request/);
 const freshProof=proof.replace(core,state.currentCore);
 assert.equal(state.calls.length,0);assert.equal((await controller.exchange(ack,freshProof)).response.acknowledged,true);
 assert.equal(state.calls.length,1);assert.ok(state.calls[0].args.includes('--action=ack'));assert.ok(state.calls[0].args.includes('--core='+core),'the original frame core is preserved after a live core restart');assert.ok(state.calls[0].args.includes('--digest='+ack.digest));assert.equal(state.calls[0].args.some(a=>a.includes(record.digest)),false);
});
test('native ACK and recovery pause share one barrier; a paused operation cannot clear a packet',async()=>{
 const {state,controller,management}=fixture();const ack={...sample,action:'ack',digest:response().digest};state.stdout=JSON.stringify({stream,sequence:'1',acknowledged:true});
 let enter,release;const entered=new Promise(r=>enter=r),hold=new Promise(r=>release=r);
 state.onRun=async()=>{enter();await hold;};
 const pending=controller.exchange(ack);await entered;
 await assert.rejects(management.coreManagement.run(async()=>{throw Error('pause must not enter during ACK');}),/configuration is changing/);
 release();await pending;const before=state.calls.length;
 await management.coreManagement.run(async()=>{state.recovery={state:'FENCED',generation:crypto.randomUUID(),digest:'a'.repeat(64)};});
 await assert.rejects(controller.exchange(ack),/retry the same request/);assert.equal(state.calls.length,before);
});


function recoveryFixture(){
 const f=fixture(),helpers=load('quota-recovery-fence');
 const frame={sequence:'1',coreProcessId:core,capturedAt:'1',stats:[{name:'user>>>77>>>traffic>>>uplink',value:'9007199254740993'}]};
 const record={version:helpers.QUOTA_RECOVERY_FENCE,generation:crypto.randomUUID(),token:crypto.randomUUID(),state:'FENCED',sequence:'1',previous:null};record.digest=helpers.recoveryFenceDigest(record);f.state.recovery=record;
 const encode=(acked,ackDigest,pending)=>{const payload=Buffer.from(JSON.stringify({version:1,stream,acked,ackDigest,pending}));return Buffer.concat([Buffer.from('REMNACUST-USAGE-1\n'+crypto.createHash('sha256').update(payload).digest('hex')+'\n'),payload]);};
 f.state.original=encode('0','',frame);const original=Buffer.from(f.state.original);
 const request={generation:record.generation,requestId:crypto.randomUUID(),coreProcessId:core,instance:stream,previous:record.digest,decisionDigest:'d'.repeat(64),sourceDigest:crypto.createHash('sha256').update(original).digest('hex'),receipt:{...sample,action:'ack',digest:model.frameDigest(frame)}};
 f.state.stdout=JSON.stringify({stream,sequence:'1',acknowledged:true});
 f.state.onRun=async()=>{f.state.original=encode('1',request.receipt.digest,null);};
 return {...f,request,frame,original,encode};
}
test('recovery ACK clears only the archived frame under a matching live pause; retry has no native side effect',async()=>{
 const f=recoveryFixture();const first=(await f.controller.acknowledgeRecovery(f.request)).response;
 assert.equal(first.alreadyAcknowledged,false);assert.equal(first.journal.acked,'1');assert.equal(first.journal.ackDigest,f.request.receipt.digest);assert.equal(first.recovery.state,'FENCED');assert.equal(f.state.calls.length,1);
 assert.ok(f.state.calls[0].args.includes('--action=ack'));assert.ok(f.state.calls[0].args.includes('--core='+core));
 const copy=Buffer.from(f.state.original);const retry=(await f.controller.acknowledgeRecovery(f.request)).response;
 assert.equal(retry.alreadyAcknowledged,true);assert.equal(f.state.calls.length,1);assert.deepEqual(f.state.original,copy);assert.equal(f.state.recovery.state,'FENCED');
});
test('recovery ACK refuses invalid context and changed source before native execution',async()=>{
 for(const patch of [{generation:crypto.randomUUID()},{coreProcessId:crypto.randomUUID()},{previous:'f'.repeat(64)},{sourceDigest:'0'.repeat(64)},{receipt:{...sample,action:'ack',digest:'0'.repeat(64)}}]){
  const f=recoveryFixture();await assert.rejects(f.controller.acknowledgeRecovery({...f.request,...patch}),/same source/);assert.equal(f.state.calls.length,0);assert.deepEqual(f.state.original,f.original);
 }
 for(const mutate of [f=>f.state.recovery=null,f=>f.state.recovery.state='RELEASED',f=>f.state.instance=crypto.randomUUID(),f=>f.state.contextError=true,f=>f.state.original=null]){
  const f=recoveryFixture();mutate(f);await assert.rejects(f.controller.acknowledgeRecovery(f.request),/same source/);assert.equal(f.state.calls.length,0);
 }
 for(const patch of [{extra:true},{receipt:sample},{instance:crypto.randomUUID()},{decisionDigest:'bad'}]){
  const f=recoveryFixture();await assert.rejects(f.controller.acknowledgeRecovery({...f.request,...patch}),/Invalid recovery receipt/);assert.equal(f.state.calls.length,0);
 }
});
test('recovery ACK requires persisted native progress and supports a lost response across a core restart',async()=>{
 const f=recoveryFixture();f.state.onRun=async()=>{};
 await assert.rejects(f.controller.acknowledgeRecovery(f.request),/same source/);assert.equal(f.state.calls.length,1);assert.deepEqual(f.state.original,f.original);
 f.state.onRun=async()=>{f.state.original=f.encode('1',f.request.receipt.digest,null);f.state.currentCore=crypto.randomUUID();};
 await assert.rejects(f.controller.acknowledgeRecovery(f.request),/same source/);
 assert.equal(f.state.calls.length,2);const rebound={...f.request,coreProcessId:f.state.currentCore};
 const retry=(await f.controller.acknowledgeRecovery(rebound)).response;assert.equal(retry.alreadyAcknowledged,true);assert.equal(retry.coreProcessId,f.state.currentCore);assert.equal(f.state.calls.length,2);
});
test('an already acknowledged recovery frame never clears the next pending frame',async()=>{
 const f=recoveryFixture();const next={...f.frame,sequence:'2',stats:[{name:'user>>>77>>>traffic>>>uplink',value:'7'}]};
 f.state.original=f.encode('1',f.request.receipt.digest,next);const original=Buffer.from(f.state.original);
 const result=(await f.controller.acknowledgeRecovery(f.request)).response;
 assert.equal(result.alreadyAcknowledged,true);assert.equal(result.journal.pending.sequence,'2');assert.equal(result.journal.pending.digest,model.frameDigest(next));assert.equal(f.state.calls.length,0);assert.deepEqual(f.state.original,original);
 f.state.original=f.encode('2',model.frameDigest(next),null);
 await assert.rejects(f.controller.acknowledgeRecovery(f.request),/same source/);assert.equal(f.state.calls.length,0);
});


test('recovery journal codec preserves exact values and rejects corrupt, noncanonical or oversized evidence',()=>{
 const f=recoveryFixture(),codec=load('usage-journal');
 assert.equal(codec.readPersistedUsageJournal(f.original).pending.stats[0].value,'9007199254740993');
 for(const original of [Buffer.from('broken'),Buffer.from(f.original.toString().replace('9007199254740993','9007199254740994')),Buffer.alloc(8*1024*1024+129)])assert.throws(()=>codec.readPersistedUsageJournal(original));
 for(const pending of [{...f.frame,sequence:'2'},{...f.frame,stats:[{name:'bad',value:'1'}]},{...f.frame,stats:[{name:'user>>>77>>>traffic>>>uplink',value:'01'}]},{...f.frame,extra:true}])assert.throws(()=>codec.readPersistedUsageJournal(f.encode('0','',pending)));
 assert.throws(()=>codec.readPersistedUsageJournal(f.encode('0','a'.repeat(64),null)));
});

function recoverySampleFixture(){
 const f=recoveryFixture(),prior={sequence:'1',digest:f.request.receipt.digest};
 f.state.original=f.encode('1',prior.digest,null);
 const frame={...f.frame,sequence:'2',capturedAt:'2'};
 const request={generation:f.request.generation,requestId:crypto.randomUUID(),coreProcessId:core,instance:stream,previous:f.request.previous,
  preparationDigest:'e'.repeat(64),sourceDigest:crypto.createHash('sha256').update(f.state.original).digest('hex'),retainedDigest:null,prior,receipt:{...sample,sequence:'2'}};
 f.state.stdout=JSON.stringify({...frame,capability:model.USAGE_RECEIPTS,stream,digest:model.frameDigest(frame)});
 f.state.onRun=async()=>{f.state.original=f.encode('1',prior.digest,frame);};
 return {...f,frame,request};
}
test('prepared recovery sample persists one exact frame and replay never samples or acknowledges again',async()=>{
 const f=recoverySampleFixture(),first=(await f.controller.sampleRecovery(f.request)).response;
 assert.equal(first.alreadyCaptured,false);assert.equal(first.frame.sequence,'2');assert.equal(first.frame.stats[0].value,'9007199254740993');assert.equal(f.state.calls.length,1);
 assert.ok(f.state.calls[0].args.includes('--action=sample'));assert.equal(first.recovery.state,'FENCED');
 const original=Buffer.from(f.state.original),retry=(await f.controller.sampleRecovery(f.request)).response;
 assert.equal(retry.alreadyCaptured,true);assert.deepEqual(retry.frame,first.frame);assert.equal(f.state.calls.length,1);assert.deepEqual(f.state.original,original);
});
test('prepared sampling rejects stale pause/head/source and malformed requests before native execution',async()=>{
 for(const patch of [{generation:crypto.randomUUID()},{coreProcessId:crypto.randomUUID()},{previous:'f'.repeat(64)},{sourceDigest:'0'.repeat(64)},{prior:{sequence:'1',digest:'0'.repeat(64)}},{retainedDigest:'f'.repeat(64)}]){
  const f=recoverySampleFixture();await assert.rejects(f.controller.sampleRecovery({...f.request,...patch}),/prepared request/);assert.equal(f.state.calls.length,0);
 }
 for(const patch of [{extra:true},{receipt:{...sample,action:'ack',sequence:'2',digest:'a'.repeat(64)}},{receipt:{...sample,sequence:'3'}},{preparationDigest:'bad'},{instance:crypto.randomUUID()}]){
  const f=recoverySampleFixture();await assert.rejects(f.controller.sampleRecovery({...f.request,...patch}),/Invalid recovery sample/);assert.equal(f.state.calls.length,0);
 }
 for(const mutate of [f=>f.state.recovery=null,f=>f.state.recovery.state='RELEASED',f=>f.state.original=null,f=>f.state.instance=crypto.randomUUID()]){
  const f=recoverySampleFixture();mutate(f);await assert.rejects(f.controller.sampleRecovery(f.request),/prepared request/);assert.equal(f.state.calls.length,0);
 }
});
test('retained and lost-response samples survive a live core restart without reassigning the original frame',async()=>{
 const f=recoverySampleFixture();f.state.original=f.encode('1',f.request.prior.digest,f.frame);f.state.currentCore=crypto.randomUUID();
 const retained={...f.request,coreProcessId:f.state.currentCore,retainedDigest:model.frameDigest(f.frame)};
 const result=(await f.controller.sampleRecovery(retained)).response;assert.equal(result.frame.coreProcessId,core);assert.equal(result.coreProcessId,f.state.currentCore);assert.equal(f.state.calls.length,0);
 f.state.original=f.encode('1',f.request.prior.digest,null);await assert.rejects(f.controller.sampleRecovery(retained),/prepared request/);assert.equal(f.state.calls.length,0);
 const lost=recoverySampleFixture();lost.state.onRun=async()=>{lost.state.original=lost.encode('1',lost.request.prior.digest,lost.frame);lost.state.currentCore=crypto.randomUUID();throw Error('Lost native reply after durable write');};
 await assert.rejects(lost.controller.sampleRecovery(lost.request),/prepared request/);assert.equal(lost.state.calls.length,1);
 const replay=(await lost.controller.sampleRecovery({...lost.request,coreProcessId:lost.state.currentCore})).response;
 assert.equal(replay.alreadyCaptured,true);assert.equal(replay.frame.coreProcessId,core);assert.equal(lost.state.calls.length,1);
});
test('sampling requires a matching persisted frame and shares the pause/ACK management barrier',async()=>{
 const f=recoverySampleFixture();f.state.onRun=async()=>{};await assert.rejects(f.controller.sampleRecovery(f.request),/prepared request/);assert.equal(f.state.calls.length,1);
 const race=recoverySampleFixture();let entered,release,passed=false;const ready=new Promise(r=>entered=r);
 race.state.onRun=async()=>{entered();await new Promise(r=>release=r);race.state.original=race.encode('1',race.request.prior.digest,race.frame);};
 const running=race.controller.sampleRecovery(race.request);await ready;
 await assert.rejects(race.management.coreManagement.run(async()=>{passed=true;}),/Core configuration is changing/);
 assert.equal(passed,false);release();await running;await race.management.coreManagement.run(async()=>{passed=true;});assert.equal(passed,true);assert.equal(race.state.recovery.state,'FENCED');
});


test('only a fresh empty fenced sample persists quiescence; lookup is read-only and survives exact ACK',async()=>{
 const f=recoverySampleFixture();f.frame.stats=[];f.state.stdout=JSON.stringify({...f.frame,capability:model.USAGE_RECEIPTS,stream,digest:model.frameDigest(f.frame)});
 assert.equal((await f.controller.quiescenceRecovery(f.request)).response.witness,null);
 await f.controller.sampleRecovery(f.request);const before=f.state.calls.length;
 const pendingProof=(await f.controller.quiescenceRecovery(f.request)).response;assert.equal(pendingProof.journal.acked,'1');assert.equal(pendingProof.journal.pending.sequence,'2');
 const witness=pendingProof.witness;
 assert.equal(witness.frame.sequence,'2');assert.equal(witness.frame.stats.length,0);assert.equal(witness.fence.digest,f.request.previous);
 f.state.original=f.encode('2',witness.frame.digest,null);
 const ackedProof=(await f.controller.quiescenceRecovery(f.request)).response;assert.deepEqual(ackedProof.witness,witness);assert.equal(ackedProof.journal.acked,'2');assert.equal(ackedProof.journal.ackDigest,witness.frame.digest);assert.equal(ackedProof.journal.pending,null);
 assert.equal(f.state.calls.length,before,'Looking up quiescence cannot sample or acknowledge');
 for(const patch of [{requestId:crypto.randomUUID()},{preparationDigest:'a'.repeat(64)}])assert.equal((await f.controller.quiescenceRecovery({...f.request,...patch})).response.witness,null);
 f.state.currentCore=crypto.randomUUID();assert.equal((await f.controller.quiescenceRecovery({...f.request,coreProcessId:f.state.currentCore})).response.witness,null);
});

test('replaying an empty retained frame cannot manufacture a missing quiescence witness',async()=>{
 const f=recoverySampleFixture();f.frame.stats=[];f.state.original=f.encode('1',f.request.prior.digest,f.frame);
 await f.controller.sampleRecovery(f.request);
 assert.equal(f.state.calls.length,0);assert.equal((await f.controller.quiescenceRecovery(f.request)).response.witness,null);
});

test('a lost witness write leaves the original empty receipt retryable but cannot authorize quiescence',async()=>{
 const f=recoverySampleFixture();f.frame.stats=[];f.state.stdout=JSON.stringify({...f.frame,capability:model.USAGE_RECEIPTS,stream,digest:model.frameDigest(f.frame)});f.state.witnessFails=true;
 await assert.rejects(f.controller.sampleRecovery(f.request),/prepared request/);assert.equal(f.state.calls.length,1);
 f.state.witnessFails=false;const replay=(await f.controller.sampleRecovery(f.request)).response;
 assert.equal(replay.alreadyCaptured,true);assert.equal(f.state.calls.length,1);assert.equal((await f.controller.quiescenceRecovery(f.request)).response.witness,null);
});
