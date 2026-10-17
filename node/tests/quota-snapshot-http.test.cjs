require('reflect-metadata');
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),ts=require('typescript');
const {createRequire}=require('node:module'),{generateKeyPairSync,randomUUID}=require('node:crypto');
const nest=require('@nestjs/common'),{NestFactory}=require('@nestjs/core'),{PassportModule}=require('@nestjs/passport'),jwt=require('jsonwebtoken');
function load(filename,mocks={}){
 const local=createRequire(filename),ref={exports:{}};const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true,emitDecoratorMetadata:true,esModuleInterop:true}}).outputText;
 new Function('require','module','exports',code)(id=>{
  if(Object.hasOwn(mocks,id))return mocks[id];
  const sibling=path.resolve(path.dirname(filename),id+'.ts');if(id.startsWith('.')&&fs.existsSync(sibling))return load(sibling,mocks);
  return local(id);
 },ref,ref.exports);return ref.exports;
}
const src=relative=>path.join(__dirname,'../src',relative);
test('full snapshot HTTP route authenticates and validates before inspecting the journal',async()=>{
 const keys=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 const other=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 class Config{}class Process{}class Live{}
 const {JwtDefaultGuard}=load(src('common/guards/jwt-guards/def-jwt-guard.ts'));
 const {JwtStrategy}=load(src('common/guards/jwt-guards/strategies/validate-token.ts'),{'@common/config/app-config/typed-config.service':{TypedConfigService:Config}});
 let reads=0,statusReads=0;
 const instance=randomUUID(),core=randomUUID();
 let activeCore=core,changeAfterPause=false,pauseRecord=null,pauseWrites=0;
 const recoveryHelpers=load(src('modules/xray-core/quota-recovery-fence.ts'));
 const ledgerHelpers=load(src('modules/xray-core/quota-ledger.ts'));
 let policyRecord={version:'xera-host-policy-v2',revision:'1',generation:randomUUID(),expiresAt:Date.now()+90000,offlineReserves:ledgerHelpers.QUOTA_RESERVE_VERSION,userQuota:'remnacust-user-quota-reserves-v1',legacyGroups:['user:global'],legacyOwners:{'1':{allowed:true,expiresAt:0}},legacyQuotaMultipliers:{'user:global':1000000000},protectedInbounds:[],hosts:{},groups:{'user:global':{multiplierScale:1000000000,bytesPerSecond:0,totalBytesPerSecond:0,blockedOwners:{},blockAll:false,reserveRequired:true,reserves:{'1':{id:randomUUID(),instance,ceiling:'100',expiresAt:Date.now()+3600000}}}}};
 let stageWrites=0,changeAfterStage=false;
 const {HostPolicyController}=load(src('modules/xray-core/host-policy.controller.ts'),{
  'node:fs/promises':{...require('node:fs/promises'),readFile:async(file,...args)=>file==='/var/lib/remnanode/host-policy.json'?JSON.stringify(policyRecord):require('node:fs/promises').readFile(file,...args)},
  '@common/config/app-config':{TypedConfigService:Config},'@common/guards/jwt-guards':{JwtDefaultGuard},
  '@common/utils/destination-rule':{normalizeDestinationRule:v=>v,isIpDestinationRule:()=>false},
  './xray-process.service':{XrayProcessService:Process},'./live-core.service':{LiveCoreService:Live},
  './quota-recovery-fence':{...recoveryHelpers,readRecoveryFence:async()=>pauseRecord,persistRecoveryFence:async request=>{
   pauseWrites++;assert.equal(request.previous,pauseRecord?.digest??null);
   const value={version:recoveryHelpers.QUOTA_RECOVERY_FENCE,generation:request.generation,token:request.requestId,state:'FENCED',sequence:(BigInt(pauseRecord?.sequence??'0')+1n).toString(),previous:request.previous};
   pauseRecord={...value,digest:recoveryHelpers.recoveryFenceDigest(value)};if(changeAfterPause)activeCore=randomUUID();return pauseRecord;
  }},
  './quota-ledger':{...ledgerHelpers,readQuotaJournalSnapshot:async()=>{reads++;return {instance,sequence:1,checkpoint:0,retiredBefore:0,registrationsRequired:true,watermarksRequired:true,entries:new Map()};}},
 });
 const config={getOrThrow:()=>keys.publicKey};class Fixture{}
 nest.Module({imports:[PassportModule.register({defaultStrategy:'registeredUserJWT'})],controllers:[HostPolicyController],providers:[{provide:Config,useValue:config},{provide:Process,useValue:{}},{provide:Live,useValue:{}},{provide:JwtStrategy,useFactory:()=>new JwtStrategy(config)}]})(Fixture);
 const app=await NestFactory.create(Fixture,{logger:false});
 try{
  app.get(HostPolicyController).status=async()=>{statusReads++;return {response:{applied:true,userQuotaRequired:true,quotaFencesSupported:true,quotaWatermarksSupported:true,quotaRecoveryFencesSupported:true,quotaRecovery:{version:recoveryHelpers.QUOTA_RECOVERY_FENCE,record:pauseRecord},coreProcessId:activeCore,corePid:7,policyRevision:policyRecord.revision,policyGeneration:policyRecord.generation,quotaJournalSequence:'1',quotaInstanceId:instance}};};
  await app.listen(0,'127.0.0.1');const base=await app.getUrl();const body={generation:randomUUID(),requestId:randomUUID()};
  const request=(token,data)=>fetch(base+'/xray/host-policy/quota-snapshot',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});
  const bad=[null,'broken',jwt.sign({},other.privateKey,{algorithm:'RS256',expiresIn:60}),jwt.sign({},keys.privateKey,{algorithm:'RS256',expiresIn:-60}),jwt.sign({},'private-fixture',{algorithm:'HS256',expiresIn:60})];
  for(const token of bad){const response=await request(token,body);assert.equal(response.status,401);await response.arrayBuffer();}
  assert.equal(statusReads,0);assert.equal(reads,0);
  const valid=jwt.sign({},keys.privateKey,{algorithm:'RS256',expiresIn:60});
  for(const data of [{...body,extra:true},{...body,generation:'invalid'},{}]){const response=await request(valid,data);assert.equal(response.status,400);await response.arrayBuffer();}
  assert.equal(statusReads,0);assert.equal(reads,0);
  const response=await request(valid,body);assert.equal(response.status,201);const envelope=(await response.json()).response;
  assert.equal(envelope.encoding,'gzip-base64');assert.equal(reads,1);assert.equal(statusReads,2);
  const payload=JSON.parse(require('node:zlib').gunzipSync(Buffer.from(envelope.data,'base64')));assert.equal(payload.generation,body.generation);assert.equal(payload.requestId,body.requestId);assert.equal(payload.coreProcessId,core);
  const pauseBody={generation:body.generation,requestId:randomUUID(),coreProcessId:core,instance,previous:null};
  const pauseRequest=(token,data)=>fetch(base+'/xray/host-policy/quota-recovery-fence',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});
  for(const token of bad){const r=await pauseRequest(token,pauseBody);assert.equal(r.status,401);await r.arrayBuffer();}
  assert.equal(pauseWrites,0);assert.equal(statusReads,2,'Rejected pause cannot inspect the core');
  for(const data of [{...pauseBody,state:'RELEASED'},{...pauseBody,coreProcessId:'bad'},{}]){const r=await pauseRequest(valid,data);assert.equal(r.status,400);await r.arrayBuffer();}
  assert.equal(pauseWrites,0);
  const paused=await pauseRequest(valid,pauseBody);assert.equal(paused.status,201);
  const proof=(await paused.json()).response;assert.equal(proof.coreProcessId,core);assert.equal(proof.quotaRecovery.record.state,'FENCED');assert.equal(pauseWrites,1);
  const ordinary=await fetch(base+'/xray/host-policy',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+valid},body:'{}'});
  assert.equal(ordinary.status,409);await ordinary.arrayBuffer();assert.equal(pauseRecord.state,'FENCED','Ordinary policy cannot clear a recovery pause');

  const stageBody={generation:pauseRecord.generation,requestId:randomUUID(),coreProcessId:core,instance,previous:pauseRecord.digest,policyRevision:'2'};
  const stageRequest=(token,data)=>fetch(base+'/xray/host-policy/quota-recovery-policy',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});
  const beforeStageReads=statusReads;
  for(const token of bad){const r=await stageRequest(token,stageBody);assert.equal(r.status,401);await r.arrayBuffer();}
  for(const data of [{...stageBody,policy:{}},{...stageBody,policyRevision:'0'},{...stageBody,policyRevision:'9223372036854775808'},{...stageBody,instance:null}]){const r=await stageRequest(valid,data);assert.equal(r.status,400);await r.arrayBuffer();}
  assert.equal(statusReads,beforeStageReads);assert.equal(stageWrites,0);
  const heldHelpers=load(src('modules/xray-core/quota-recovery-policy.ts'));
  const original=structuredClone(policyRecord);
  app.get(HostPolicyController).apply=async(policy,gate)=>{heldHelpers.requireRecoveryPolicyGate(pauseRecord,gate);assert.equal(heldHelpers.recoveryPolicyHoldsAdmissions(policy),true);stageWrites++;policyRecord={...policy,generation:randomUUID(),expiresAt:Date.now()+90000};if(changeAfterStage)activeCore=randomUUID();return {response:{applied:true}};};
  for(const patch of [{generation:randomUUID()},{coreProcessId:randomUUID()},{instance:randomUUID()},{previous:'0'.repeat(64)}]){const r=await stageRequest(valid,{...stageBody,...patch});assert.equal(r.status,409);await r.arrayBuffer();}
  assert.equal(stageWrites,0);
  const staged=await stageRequest(valid,stageBody);assert.equal(staged.status,201);const stageProof=(await staged.json()).response;assert.equal(stageProof.policyRevision,'2');assert.equal(stageProof.quotaRecovery.record.state,'FENCED');assert.equal(stageProof.quotaRecovery.record.digest,stageBody.previous);assert.equal(stageWrites,1);
  assert.deepEqual(policyRecord.groups['user:global'].reserves,{});assert.deepEqual(policyRecord.legacyOwners,original.legacyOwners);assert.deepEqual(policyRecord.hosts,original.hosts);
  const repeated=await stageRequest(valid,stageBody);assert.equal(repeated.status,201);await repeated.arrayBuffer();
  changeAfterStage=true;const changed=await stageRequest(valid,{...stageBody,policyRevision:'3',requestId:randomUUID()});assert.equal(changed.status,503);await changed.arrayBuffer();assert.equal(pauseRecord.state,'FENCED');activeCore=core;changeAfterStage=false;
  changeAfterPause=true;const lost=await pauseRequest(valid,{...pauseBody,requestId:randomUUID(),previous:pauseRecord.digest});assert.equal(lost.status,503);await lost.arrayBuffer();
  assert.equal(pauseWrites,2);assert.equal(pauseRecord.state,'FENCED','A same-PID core change must leave the persisted pause in place');
 }finally{await app.close();}
});


test('recovery release HTTP requires JWT, original sources and native ACK; lost ACK retries the durable same intent',async t=>{
 const fsp=require('node:fs/promises'),os=require('node:os'),{createHash}=require('node:crypto');
 const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'release-route-'));await fsp.chmod(directory,0o700);t.after(()=>fsp.rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:30}));
 const file=path.join(directory,'recovery.json'),witnessFile=path.join(directory,'witness.json');
 const fsMocks={'node:fs/promises':{...fsp,open:async(file,...args)=>process.platform==='win32'&&file===directory?{sync:async()=>{},close:async()=>{}}:fsp.open(file,...args)}};
 const helpers=load(src('modules/xray-core/quota-recovery-fence.ts'),fsMocks),release=load(src('modules/xray-core/recovery-release.ts'),fsMocks),quiescence=load(src('modules/xray-core/recovery-quiescence.ts'),fsMocks),receipts=load(src('modules/xray-core/usage-receipt.ts'));
 const core=randomUUID(),instance=randomUUID(),generation=randomUUID();
 const paused=await helpers.persistRecoveryFence({generation,requestId:randomUUID(),coreProcessId:core,instance,previous:null},file);
 const sample={requestId:randomUUID(),generation,coreProcessId:core,instance,previous:paused.digest,preparationDigest:'a'.repeat(64),sourceDigest:'b'.repeat(64),retainedDigest:null,prior:{sequence:'1',digest:'c'.repeat(64)},receipt:{action:'sample',stream:instance,sequence:'2',coreProcessId:core}};
 const frame={sequence:'2',coreProcessId:core,capturedAt:'1792192954000',stats:[]},frameDigest=receipts.frameDigest(frame);
 const witness=await quiescence.persistRecoveryQuiescence(sample,{...frame,stream:instance,capability:receipts.USAGE_RECEIPTS,digest:frameDigest},paused,'d'.repeat(64),witnessFile);
 const payload=Buffer.from(JSON.stringify({version:1,stream:instance,acked:'2',ackDigest:frameDigest,pending:null}));
 const journal=Buffer.concat([Buffer.from('REMNACUST-USAGE-1\n'+createHash('sha256').update(payload).digest('hex')+'\n'),payload]);
 const ledger=load(src('modules/xray-core/quota-ledger.ts'));
 let policyRecord={version:'xera-host-policy-v2',revision:'42',generation:randomUUID(),expiresAt:Date.now()+90000,offlineReserves:ledger.QUOTA_RESERVE_VERSION,userQuota:'remnacust-user-quota-reserves-v1',legacyGroups:['user:global'],legacyOwners:{'1':{allowed:true,expiresAt:0}},legacyQuotaMultipliers:{'user:global':1000000000},protectedInbounds:[],hosts:{},groups:{'user:global':{multiplierScale:1000000000,bytesPerSecond:0,totalBytesPerSecond:0,blockedOwners:{},blockAll:true,fenceAll:true,reserveRequired:true,reserves:{}}}};
 const request={generation,requestId:randomUUID(),coreProcessId:core,instance,previous:paused.digest,policyRevision:'42',policyGeneration:policyRecord.generation,witnessDigest:witness.digest,journalDigest:createHash('sha256').update(journal).digest('hex')};
 const keys=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 const other=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 class Config{}class Process{}class Live{}
 const {JwtDefaultGuard}=load(src('common/guards/jwt-guards/def-jwt-guard.ts'));
 const {JwtStrategy}=load(src('common/guards/jwt-guards/strategies/validate-token.ts'),{'@common/config/app-config/typed-config.service':{TypedConfigService:Config}});
 let statusReads=0,writes=0,acknowledge=true,activeCore=core,changeAfterWrite=false,originalAvailable=true,releaseSupported=true,coreChangeOnRead=0;
 const {HostPolicyController}=load(src('modules/xray-core/host-policy.controller.ts'),{
  ...fsMocks,'node:fs/promises':{...fsMocks['node:fs/promises'],readFile:async(file,...args)=>file==='/var/lib/remnanode/host-policy.json'?JSON.stringify(policyRecord):fsp.readFile(file,...args)},
  '@common/config/app-config':{TypedConfigService:Config},'@common/guards/jwt-guards':{JwtDefaultGuard},
  '@common/utils/destination-rule':{normalizeDestinationRule:v=>v,isIpDestinationRule:()=>false},
  './xray-process.service':{XrayProcessService:Process},'./live-core.service':{LiveCoreService:Live},
  './quota-recovery-fence':{...helpers,privateRead:async(file)=>file==='/var/lib/remnanode/quota/recovery-quiescence.json'?originalAvailable?fsp.readFile(witnessFile):null:helpers.privateRead(file)},
  './usage-archive':{readUsageArchiveFile:async()=>originalAvailable?Buffer.from(journal):null},
  './recovery-release':{...release,persistRecoveryRelease:async(body,observe)=>{writes++;const result=await release.persistRecoveryRelease(body,observe,directory);if(changeAfterWrite)activeCore=randomUUID();return result;}},
 });
 const config={getOrThrow:()=>keys.publicKey};class Fixture{}
 nest.Module({imports:[PassportModule.register({defaultStrategy:'registeredUserJWT'})],controllers:[HostPolicyController],providers:[{provide:Config,useValue:config},{provide:Process,useValue:{}},{provide:Live,useValue:{}},{provide:JwtStrategy,useFactory:()=>new JwtStrategy(config)}]})(Fixture);
 const app=await NestFactory.create(Fixture,{logger:false});
 try{
  app.get(HostPolicyController).status=async()=>{statusReads++;if(coreChangeOnRead&&!--coreChangeOnRead)activeCore=randomUUID();const disk=await helpers.readRecoveryFence(file);return {response:{quotaRecoveryReleasesSupported:releaseSupported,applied:true,userQuotaRequired:true,corePid:7,coreProcessId:activeCore,quotaInstanceId:instance,policyRevision:policyRecord.revision,policyGeneration:policyRecord.generation,quotaRecovery:{version:helpers.QUOTA_RECOVERY_FENCE,record:acknowledge?disk:paused}}};};
  await app.listen(0,'127.0.0.1');const base=await app.getUrl();
  const send=(token,data)=>fetch(base+'/xray/host-policy/quota-recovery-release',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});
  for(const token of [null,'broken',jwt.sign({},other.privateKey,{algorithm:'RS256',expiresIn:60}),jwt.sign({},keys.privateKey,{algorithm:'RS256',expiresIn:-60}),jwt.sign({},'fixture',{algorithm:'HS256',expiresIn:60})]){const response=await send(token,request);assert.equal(response.status,401);await response.arrayBuffer();}
  assert.equal(statusReads,0);assert.equal(writes,0);
  const valid=jwt.sign({},keys.privateKey,{algorithm:'RS256',expiresIn:60});
  for(const data of [{...request,state:'RELEASED'},{...request,instance:null},{...request,policyRevision:'0'},{...request,witnessDigest:'wrong'},{}]){const response=await send(valid,data);assert.equal(response.status,400);await response.arrayBuffer();}
  assert.equal(statusReads,0);assert.equal(writes,0);
  for(const patch of [{coreProcessId:randomUUID()},{generation:randomUUID()},{instance:randomUUID()},{previous:'0'.repeat(64)},{policyGeneration:randomUUID()},{policyRevision:'43'},{witnessDigest:'0'.repeat(64)},{journalDigest:'0'.repeat(64)}]){const response=await send(valid,{...request,...patch});assert.equal(response.status,409);await response.arrayBuffer();}
  releaseSupported=false;let unsupported=await send(valid,request);assert.equal(unsupported.status,409);await unsupported.arrayBuffer();releaseSupported=true;
  coreChangeOnRead=2;let moved=await send(valid,request);assert.equal(moved.status,409);await moved.arrayBuffer();activeCore=core;
  originalAvailable=false;let response=await send(valid,request);assert.equal(response.status,409);await response.arrayBuffer();originalAvailable=true;
  policyRecord.groups['user:global'].fenceAll=false;response=await send(valid,request);assert.equal(response.status,409);await response.arrayBuffer();policyRecord.groups['user:global'].fenceAll=true;
  assert.equal(writes,0);assert.equal((await helpers.readRecoveryFence(file)).state,'FENCED');
  acknowledge=false;response=await send(valid,request);assert.equal(response.status,503);await response.arrayBuffer();const saved=await helpers.readRecoveryFence(file);assert.equal(saved.state,'RELEASED');assert.equal(saved.sequence,'2');
  await fsp.stat(path.join(directory,'release-'+request.requestId+'.json'));
  acknowledge=true;const responses=await Promise.all([send(valid,request),send(valid,request)]);
  for(const response of responses){assert.equal(response.status,201);const value=(await response.json()).response;assert.equal(value.requestId,request.requestId);assert.equal(value.quotaRecovery.record.digest,saved.digest);assert.equal(value.quotaRecovery.record.sequence,'2');assert.equal(value.journalDigest,request.journalDigest);}
  assert.deepEqual((await helpers.readRecoveryFence(file)),saved);assert.deepEqual(JSON.parse(await fsp.readFile(path.join(directory,'release-'+request.requestId+'.json'),'utf8')).request,request);
  // Even after a durable write, a new process cannot turn an old witness into
  // a current acknowledgement or make the same request appear successful.
  changeAfterWrite=true;response=await send(valid,request);assert.equal(response.status,503);await response.arrayBuffer();changeAfterWrite=false;
  response=await send(valid,request);assert.equal(response.status,409);await response.arrayBuffer();
  assert.deepEqual(await helpers.readRecoveryFence(file),saved);assert.deepEqual(journal,Buffer.concat([Buffer.from('REMNACUST-USAGE-1\n'+createHash('sha256').update(payload).digest('hex')+'\n'),payload]));
 }finally{await app.close();}
});
