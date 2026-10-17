const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises');
const path=require('node:path'),os=require('node:os'),ts=require('typescript'),{createRequire}=require('node:module');
const root=path.join(__dirname,'../src/modules');
const load=(file,mocks={})=>{
    const ref={exports:{}},local=createRequire(file);
    const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true,esModuleInterop:true}}).outputText;
    new Function('require','module','exports',code)(id=>Object.hasOwn(mocks,id)?mocks[id]:local(id),ref,ref.exports);return ref.exports;
};
const {PortPlanStateStore,portPlanInputsHash}=load(path.join(root,'xray-core/port-plan-state.ts'));
const barrier=load(path.join(root,'xray-core/core-management.ts'));
class StopXrayCommand{}class RemoveOutboundCommand{}class GenericResponseModel{constructor(accepted){this.accepted=accepted;}}
const {PluginService}=load(path.join(root,'_plugin/plugin.service.ts'),{
    '@common/types/result.type':{ok:response=>({isOk:true,response})},
    '@libs/contracts/constants':{XRAY_TORRENT_BLOCKER_OUTBOUND_TAG:'block'},
    '@remnawave/node-plugins':{NodePluginSchema:{safeParseAsync:async()=>({success:false})}},
    '../asn-lmdb/queries/get-asn-prefixes/get-asn-prefixes.query':{},
    '../handler/commands/remove-outbound/remove-outbound.command':{RemoveOutboundCommand},
    '../xray-core/commands/stop-xray':{StopXrayCommand},'../xray-core/core-management':barrier,
    '../xray-core/port-plan-state':{PortPlanStateStore,portPlanInputsHash},'./models':{GenericResponseModel},
    './models/torrent-blocker-reports.response.model':{},
});
async function fixture(t){
    const directory=await fsp.mkdtemp(path.join(os.tmpdir(),'remnacust-plugin-delivery-'));await fsp.chmod(directory,0o700);
    t.after(()=>fsp.rm(directory,{recursive:true,force:true}));
    const calls=[],state={hasActivePlugin:()=>true,isConfigChanged:()=>true,resetState:()=>calls.push('reset'),cleanUpActivePlugin:()=>calls.push('clean')};
    const service=new PluginService(state,{recreateTables:async()=>calls.push('nft')},{execute:async command=>calls.push(command.constructor.name)},{});
    service.portPlans=new PortPlanStateStore(path.join(directory,'private/port-plan-state.json'));
    const target={revision:'7',enabled:true,delivery:{epoch:'2',owner:'aaaaaaaa-1111-4111-8111-111111111111'}};
    return {service,calls,target};
}
test('owned plugin removal does not stop the core and old or unversioned owners cannot change plugins',async t=>{
    const f=await fixture(t);const result=await f.service.sync({plugin:null,portPlanDelivery:f.target});
    assert.equal(result.response.accepted,true);assert.deepEqual(f.calls,['reset','clean','nft']);
    f.calls.length=0;
    await assert.rejects(f.service.sync({plugin:null,portPlanDelivery:{...f.target,delivery:{...f.target.delivery,epoch:'1'}}}),/older delivery owner/);
    await assert.rejects(f.service.sync({plugin:null}),/owned port-plan delivery/);
    assert.deepEqual(f.calls,[]);
});
test('invalid owned plugin config cannot clean state or stop the existing core',async t=>{
    const f=await fixture(t);const result=await f.service.sync({plugin:{uuid:'bad',name:'invalid',config:{}},portPlanDelivery:f.target});
    assert.equal(result.response.accepted,false);assert.deepEqual(f.calls,[]);
});
test('legacy plugin removal retains its previous explicit stop behavior',async t=>{
    const f=await fixture(t);const result=await f.service.sync({plugin:null});assert.equal(result.response.accepted,true);
    assert.deepEqual(f.calls,['reset','clean','nft','StopXrayCommand']);
});

test('offline plugin removal is dirty even when the restarted JavaScript plugin state is empty',async t=>{
    const f=await fixture(t),old={uuid:'aaaaaaaa-7777-4777-8777-777777777777',name:'old',config:{}};
    await f.service.portPlans.begin(f.target);await f.service.portPlans.notePluginInputs(f.target,portPlanInputsHash(old));
    await f.service.portPlans.complete(f.target,'a'.repeat(64));
    f.service.state.hasActivePlugin=()=>false;
    const result=await f.service.sync({plugin:null,portPlanDelivery:{...f.target,delivery:{...f.target.delivery,epoch:'3'}}});
    assert.equal(result.response.accepted,true);assert.equal((await f.service.portPlans.read()).pluginDirty,true);
    assert.deepEqual(f.calls,[],'Config must be reconciled rather than immediately stopping the core');
});
