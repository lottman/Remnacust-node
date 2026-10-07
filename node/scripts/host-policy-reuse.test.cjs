const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const load=require('../../backend-3.4.4-xera/tests/load-typescript.cjs');
const base={version:'xera-host-policy-v2',protectedInbounds:['in'],hosts:{},groups:{}};
function fixture(){
 let writes=0;let pid=100;
 let policy={...structuredClone(base),generation:'confirmed',expiresAt:Date.now()+80000};
 let applied={generation:'confirmed',pid,destinationRules:'xera-destination-rules-v1'};
 const {HostPolicyController}=load(path.join(__dirname,'../src/modules/xray-core/host-policy.controller.ts'),{
  '@common/guards/jwt-guards':{JwtDefaultGuard:class{}},'./xray-process.service':{},
  '@common/utils/destination-rule':load(path.join(__dirname,'../src/common/utils/destination-rule.ts')),
  'node:fs/promises':{readFile:async file=>JSON.stringify(file.endsWith('status.json')?applied:policy),mkdir:async()=>{},
   writeFile:async(file,body)=>{writes++;policy=JSON.parse(body)},rename:async()=>{applied={...applied,generation:policy.generation,pid}}},
 });
 const controller=new HostPolicyController({getStatus:async()=>({up:true,pid})});
 controller.supported=async()=>true;controller.versionCache.destinationRulesSupported=true;
 return{controller,get policy(){return policy},get applied(){return applied},get writes(){return writes},restart:()=>pid++};
}
test('confirmed unchanged node policy is reused without extending its lease',async()=>{
 const f=fixture(),expires=f.policy.expiresAt;
 const results=await Promise.all([f.controller.update(base),f.controller.update(structuredClone(base))]);
 assert(results.every(r=>r.response.applied&&r.response.unchanged));assert.equal(f.writes,0);assert.equal(f.policy.expiresAt,expires);
});
test('renewal, process restart, missing acknowledgement and changed limits require a new apply',async()=>{
 for(const change of [f=>f.policy.expiresAt=Date.now()+10000,f=>f.restart(),f=>f.applied.generation='stale',f=>f.policy.groups.extra={bytesPerSecond:1,totalBytesPerSecond:0,blockedOwners:{},blockAll:false}]){
  const f=fixture();change(f);const result=await f.controller.update(base);
  assert.equal(f.writes,1);assert.equal(result.response.applied,true);assert.notEqual(result.response.unchanged,true);
 }
});
