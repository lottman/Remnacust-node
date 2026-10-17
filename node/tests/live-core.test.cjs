const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const util=require('node:util');
const ts=require('typescript');
const profileHelpers=require('./load-typescript.cjs')(path.join(__dirname,'../src/modules/xray-core/profile-input.ts'));
const source=fs.readFileSync(path.join(__dirname,'../src/modules/xray-core/live-core.service.ts'),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true}}).outputText;

function fixture() {
    const state={calls:[],files:new Map(),removed:[],directories:[],closed:0,synced:0,reads:0,mtime:1,
        binary:Buffer.from('remnacust-live-ports-v1'),ack:JSON.stringify({hash:'a'.repeat(64),generation:'12'})};
    const execFile=()=>{throw Error('Use execFile promise interface');};
    execFile[util.promisify.custom]=async(binary,args,options)=>{state.calls.push({binary,args,options});if(state.error)throw state.error;return {stdout:state.ack,stderr:''};};
    const mocks={
        '@nestjs/common':{Injectable:()=>x=>x},
        './user-quota':{userQuotaRequiredOnDisk:async()=>state.userQuotaDisk??false},
        './profile-input':profileHelpers,
        'node:child_process':{execFile},'node:path':path,'node:util':util,
        'node:fs/promises':{
            stat:async()=>({isFile:()=>true,dev:1,ino:1,size:state.binary.length,mtimeMs:state.mtime,ctimeMs:state.mtime}),
            readFile:async()=>{state.reads++;return state.binary;},
            mkdir:async(...args)=>state.directories.push(args),
            mkdtemp:async prefix=>prefix+'fixture',
            open:async(filename,flags,mode)=>{assert.equal(flags,'wx');assert.equal(mode,0o600);return {
                writeFile:async content=>state.files.set(filename,content),sync:async()=>state.synced++,close:async()=>state.closed++,
            };},
            rm:async filename=>state.removed.push(filename),
            rmdir:async directory=>state.removed.push(directory),
        },
    };
    const ref={exports:{}};new Function('require','module','exports',compiled)(id=>mocks[id],ref,ref.exports);
    return {state,service:new ref.exports.LiveCoreService(),checkpoint:ref.exports.LIVE_CORE_CHECKPOINT};
}

test('capability detection is cached by executable identity and refreshed on replacement',async()=>{
    const {state,service}=fixture();assert.equal(await service.supported('/core'),true);assert.equal(await service.supported('/core'),true);assert.equal(state.reads,1);
    state.binary=Buffer.from('ordinary core');state.mtime++;assert.equal(await service.supported('/core'),false);assert.equal(state.reads,2);
});
test('live reconciliation uses a private flushed file and requires an acknowledgement before success',async()=>{
    const {state,service}=fixture();const config={users:[{password:'fixture-private-value'}]};
    await service.apply('/core','/private/api.sock',config);
    assert.equal(state.synced,1);assert.equal(state.closed,1);assert.equal(state.calls.length,1);
    assert.equal(state.calls[0].binary,'/core');assert.deepEqual(state.calls[0].args.slice(0,4),['api','reconcile','--server=unix:/private/api.sock','--timeout=20']);
    assert.equal(state.calls[0].options.timeout,25000);assert.ok(!JSON.stringify(state.calls).includes('fixture-private-value'));
    assert.equal(JSON.parse([...state.files.values()][0]).users[0].password,config.users[0].password);
    assert.equal(state.removed.length,2);
});
test('RPC failures and invalid acknowledgements do not report success and still remove private inputs',async()=>{
    for(const acknowledgement of ['{}',JSON.stringify({hash:'a'.repeat(64),generation:12}),'not json']){
        const {state,service}=fixture();state.ack=acknowledgement;
        await assert.rejects(service.apply('/core','/api',{}));assert.equal(state.removed.length,2);
    }
    const {state,service}=fixture();state.error=Error('fixture bind failure');
    await assert.rejects(service.apply('/core','/api',{}),/fixture bind failure/);assert.equal(state.removed.length,2);
});
test('an explicit restart prepares the fixed private checkpoint without passing configuration through command arguments',async()=>{
    const {state,service,checkpoint}=fixture();await service.prepareRestart('/core',{inbounds:[]});
    assert.ok(checkpoint.endsWith('/core-state/checkpoint.pb'));
    assert.deepEqual(state.calls[0].args.slice(0,3),['api','cache-runtime','--output='+checkpoint]);
    assert.ok(state.directories.some(([directory,options])=>directory.endsWith('core-state')&&options.mode===0o700));
});
test('oversized control bodies are rejected before writing or executing anything',async()=>{
    const {state,service}=fixture();await assert.rejects(service.apply('/core','/api',{data:'x'.repeat(4*1024*1024)}),/control limit/);
    assert.equal(state.files.size,0);assert.equal(state.calls.length,0);assert.equal(state.directories.length,0);
});

test('user quota requirement commits are bound to a core incarnation and remain sticky for maintenance snapshots',async()=>{
    const {state,service}=fixture();const core='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    state.ack=JSON.stringify({hash:'a'.repeat(64),generation:'12',coreProcessId:core,userQuotaRequired:true});
    await service.requireUserQuota('/core','/private.sock',core);await service.requireUserQuota('/core','/private.sock',core);
    assert.equal(state.calls.length,1);assert.equal(service.hasUserQuotaRequirement(core),true);assert.equal(service.hasUserQuotaRequirement('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),false);
    assert.deepEqual(state.calls[0].args,['api','require-user-quota','--server=unix:/private.sock','--timeout=10','--core='+core]);
    await service.prepareRestart('/core',{inbounds:[]});assert.equal(JSON.parse([...state.files.values()].at(-1)).remnacustUserQuotaRequired,true);
});

test('unknown quota requirement acknowledgements cannot authorize a policy or mark a new core as committed',async()=>{
    for(const ack of [{},{hash:'a'.repeat(64),generation:'12',coreProcessId:'wrong',userQuotaRequired:true},{hash:'a'.repeat(64),generation:'12',coreProcessId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',userQuotaRequired:false}]) {
        const {state,service}=fixture();state.ack=JSON.stringify(ack);await assert.rejects(service.requireUserQuota('/core','/api','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));assert.equal(service.hasUserQuotaRequirement('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),false);
    }
    const {state,service}=fixture();state.userQuotaDisk=true;await service.prepareRestart('/core',{inbounds:[]});assert.equal(JSON.parse([...state.files.values()][0]).remnacustUserQuotaRequired,true);
});

function nativeProfileInput() {
    const id='11111111-1111-4111-8111-111111111111';
    return {version:'remnacust-profile-input-v1',root:{stats:{},outbounds:[{tag:'root',protocol:'freedom'}]},delivery:{epoch:'2',owner:id,revision:'1',enabled:true,inputsHash:'a'.repeat(64)},graphs:[{bindingUuid:id,configProfileUuid:id,configProfileInboundUuid:id,config:{inbounds:[{tag:'same',listen:'127.0.0.1',port:443,protocol:'trojan',settings:{clients:[{email:'fixture',password:'private-profile-secret'}]}}],outbounds:[{tag:'direct',protocol:'freedom'}]}}]};
}
function nativeProfileAck(input,live=true) {
    return JSON.stringify({hash:'b'.repeat(64),graphCount:input.graphs.length,unchanged:false,delivery:{...input.delivery,planHash:'c'.repeat(64)},...(live?{coreProcessId:'22222222-2222-4222-8222-222222222222'}:{})});
}
test('independent profile delivery uses the versioned CLI, exact owner acknowledgement and private file',async()=>{
    const {state,service}=fixture(),input=nativeProfileInput();state.ack=nativeProfileAck(input);
    await service.applyProfiles('/core','/private/core.sock',input);
    assert.deepEqual(state.calls[0].args.slice(0,4),['api','profile-apply','--server=unix:/private/core.sock','--timeout=20']);
    assert.ok(!JSON.stringify(state.calls).includes('private-profile-secret'));
    assert.equal(JSON.parse([...state.files.values()][0]).graphs[0].config.inbounds[0].settings.clients[0].password,'private-profile-secret');
    assert.equal(state.synced,1);assert.equal(state.closed,1);assert.equal(state.removed.length,2);
    const failed=fixture();failed.state.ack=nativeProfileAck(input).replace('"epoch":"2"','"epoch":"1"');
    await assert.rejects(failed.service.applyProfiles('/core','/private/core.sock',input),/ownership/);
    assert.equal(failed.state.removed.length,2);
});
test('profile restart keeps sticky quota policy and cannot fall back to the legacy cache command',async()=>{
    const {state,service,checkpoint}=fixture(),input=nativeProfileInput();state.userQuotaDisk=true;state.ack=nativeProfileAck(input,false);
    await service.prepareProfileRestart('/core',input);
    assert.deepEqual(state.calls[0].args.slice(0,3),['api','cache-profiles','--output='+checkpoint]);
    assert.equal(JSON.parse([...state.files.values()][0]).root.remnacustUserQuotaRequired,true);
    assert.equal(input.root.remnacustUserQuotaRequired,undefined);
    assert.equal(state.removed.length,2);
});
test('profile payload limit permits aggregate plans above legacy four MiB but rejects above sixteen before I/O',async()=>{
    const {state,service}=fixture(),input=nativeProfileInput();
    input.graphs[0].config.remarks='x'.repeat(2200000);
    input.graphs.push(structuredClone(input.graphs[0]));input.graphs[1].bindingUuid='33333333-3333-4333-8333-333333333333';
    state.ack=nativeProfileAck(input);
    await service.applyProfiles('/core','/private/core.sock',input);assert.equal(state.calls.length,1);
    const rejected=fixture();input.graphs[0].config.remarks='x'.repeat(16*1024*1024);
    await assert.rejects(rejected.service.applyProfiles('/core','/private/core.sock',input),/control limit/);
    assert.equal(rejected.state.calls.length,0);assert.equal(rejected.state.files.size,0);
});
