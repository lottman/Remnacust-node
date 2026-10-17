const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const util=require('node:util');const ts=require('typescript');const {createRequire}=require('node:module');
function fixture(){
 const state={policy:null,usage:false,userRequired:false,portRequired:false,registered:false,watermarked:false,calls:[],writes:[],binary:Buffer.from('remnacust-quota-reserves-v1 remnacust-user-quota-reserves-v1 remnacust-usage-receipts-v1')};
 const execFile=()=>{throw Error('Use promise interface');};execFile[util.promisify.custom]=async(...args)=>{state.calls.push(args);return {stdout:'',stderr:''};};
 const filename=path.join(__dirname,'../src/modules/xray-core/managed-core.store.ts'),local=createRequire(filename),ref={exports:{}};
 const mocks={'./quota-ledger':{QUOTA_REGISTRATION_VERSION:'remnacust-quota-registrations-v1',QUOTA_WATERMARK_VERSION:'remnacust-quota-watermarks-v1',readQuotaJournal:async()=>({registrationsRequired:state.registered,watermarksRequired:state.watermarked,instance:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sequence:10,checkpoint:8})},'./port-plan-state':{PORT_PLAN_CAPABILITY:'remnacust-live-ports-v1',PortPlanStateStore:class{async read(){return state.portRequired?{required:true}:null;}}},'node:child_process':{execFile},'@common/utils/destination-rule':{isIpDestinationRule:()=>false},'./user-quota':{USER_QUOTA_VERSION:'remnacust-user-quota-reserves-v1',userQuotaRequiredOnDisk:async()=>state.userRequired},'node:fs/promises':{
  lstat:async()=>{if(state.usage)return {};throw Object.assign(Error('missing'),{code:'ENOENT'});},
  readFile:async file=>{if(file==='/candidate')return state.binary;if(file==='/var/lib/remnanode/host-policy.json'&&state.policy!==null)return JSON.stringify(state.policy);throw Object.assign(Error('missing'),{code:'ENOENT'});},
  writeFile:async(...args)=>state.writes.push(args),rm:async()=>{},
 }};
 mocks['./quota-recovery-fence']={QUOTA_RECOVERY_FENCE:'remnacust-quota-recovery-fence-v1',readRecoveryFence:async()=>state.recovery??null};
 const compiled=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',compiled)(id=>Object.hasOwn(mocks,id)?mocks[id]:local(id),ref,ref.exports);
 return {state,validate:()=>ref.exports.validateCoreConfig('/candidate',{inbounds:[{tag:'test'}]},'/isolated')};
}
test('managed install/rollback validation rejects an old core before execution or writing a validation config',async()=>{
 for(const configure of [s=>s.usage=true,s=>s.policy={offlineReserves:'remnacust-quota-reserves-v1'},s=>{s.userRequired=true;s.policy={userQuota:'remnacust-user-quota-reserves-v1'};}]){
  const f=fixture();configure(f.state);await assert.rejects(f.validate(),/outside-grant quota accounting/);assert.deepEqual(f.state.calls,[]);assert.deepEqual(f.state.writes,[]);
  f.state.binary=Buffer.concat([f.state.binary,Buffer.from(' remnacust-unreserved-usage-v1')]);await f.validate();assert.equal(f.state.writes.length,1);assert.ok(f.state.calls.length>0);
 }
});

test('managed rollback cannot discard a persisted native port plan',async()=>{
 const f=fixture();f.state.portRequired=true;await assert.rejects(f.validate(),/independent port plans/);
 assert.deepEqual(f.state.calls,[]);assert.deepEqual(f.state.writes,[]);
 f.state.binary=Buffer.concat([f.state.binary,Buffer.from(' remnacust-live-ports-v1')]);await f.validate();assert.equal(f.state.writes.length,1);
});

test('managed core changes cannot bypass an existing recovery pause even without a quota policy',async()=>{
 const f=fixture();f.state.recovery={state:'FENCED'};
 await assert.rejects(f.validate(),/recovery pause/);assert.deepEqual(f.state.calls,[]);assert.deepEqual(f.state.writes,[]);
 f.state.binary=Buffer.concat([f.state.binary,Buffer.from(' remnacust-quota-recovery-fence-v1')]);
 await f.validate();assert.equal(f.state.writes.length,1);
});

test('managed selection preserves registered journal protocol even if its policy was lost',async()=>{
 const f=fixture();f.state.registered=true;
 await assert.rejects(f.validate(),/durable quota registration/);assert.deepEqual(f.state.calls,[]);
 f.state.policy={offlineReserves:'remnacust-quota-reserves-v1',quotaRegistrations:'remnacust-quota-registrations-v1'};
 await assert.rejects(f.validate(),/durable quota registration/);assert.deepEqual(f.state.writes,[]);
 f.state.binary=Buffer.concat([f.state.binary,Buffer.from(' remnacust-quota-registrations-v1 remnacust-unreserved-usage-v1')]);
 await f.validate();assert.equal(f.state.writes.length,1);
});

test('managed core selection cannot ignore or rewind a watermarked quota journal',async()=>{
 const f=fixture();f.state.watermarked=true;
 await assert.rejects(f.validate(),/checkpoint/);assert.deepEqual(f.state.calls,[]);
 f.state.policy={quotaCheckpoint:{instance:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sequence:'9'}};
 await assert.rejects(f.validate(),/checkpoint/);assert.deepEqual(f.state.writes,[]);
 f.state.binary=Buffer.concat([f.state.binary,Buffer.from(' remnacust-quota-watermarks-v1')]);await f.validate();
 f.state.policy.quotaCheckpoint.sequence='7';await assert.rejects(f.validate(),/checkpoint/);
 f.state.policy.quotaCheckpoint.sequence='11';await assert.rejects(f.validate(),/checkpoint/);
});
