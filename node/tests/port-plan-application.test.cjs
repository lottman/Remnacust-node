const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const ts=require('typescript');const {createRequire}=require('node:module');
const file=path.join(__dirname,'../src/modules/xray-core/xray.service.ts'),local=createRequire(file);
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true,esModuleInterop:true}}).outputText;
const loadModel=name=>{const module={exports:{}};new Function('require','module','exports',compile(path.join(__dirname,'../src/modules/xray-core/models/'+name+'.ts')))(()=>({}),module,module.exports);return module.exports;};
const models={...loadModel('start-xray.response.model'),...loadModel('get-node-health-check.model')};
const portStateModule=(()=>{const ref={exports:{}};new Function('require','module','exports',compile(path.join(__dirname,'../src/modules/xray-core/port-plan-state.ts')))(require,ref,ref.exports);return ref.exports;})();
function fixture(){
    const state={supported:true,up:true,stats:true,calls:[],applyError:null,savedPortPlan:null};
    const mocks={};for(const match of fs.readFileSync(file,'utf8').matchAll(/from '([^']+)'/g))if(!match[1].startsWith('node:'))mocks[match[1]]={};
    mocks['enhanced-ms']={__esModule:true,default:()=>''};
    mocks['@nestjs/common']={Injectable:()=>value=>value,Logger:class{}};
    mocks['@remnawave/xtls-sdk-nestjs']={InjectXtls:()=>()=>{}};
    mocks['@common/types']={ok:response=>({isOk:true,response})};
    mocks['@common/utils/get-system-stats']={getSystemInfo:()=>({}),getSystemStats:()=>({})};
    mocks['@common/utils/generate-api-config']={generateApiConfig:({config})=>config};
    mocks['./managed-core.store']={validateCoreConfig:async()=>state.calls.push('validate')};
    for(const name of ['../network-stats/queries/get-interface-stats/get-interface-stats.query','../_plugin/queries/get-torrent-blocker-state',
        '../_plugin/commands/run-post-start/run-post-start.command']){
        const exportName=name.includes('get-interface')?'GetInterfaceStatsQuery':name.includes('get-torrent')?'GetTorrentBlockerStateQuery':'RunPostStartCommand';
        mocks[name]={[exportName]:class{}};
    }
    mocks['./port-plan-state']=portStateModule;
    mocks['./profile-input']=require('./load-typescript.cjs')(path.join(__dirname,'../src/modules/xray-core/profile-input.ts'));
    mocks['./models']=models;const module={exports:{}};
    new Function('require','module','exports',compile(file))(id=>Object.hasOwn(mocks,id)?mocks[id]:local(id),module,module.exports);
    const service=Object.create(module.exports.XrayService.prototype);
    Object.assign(service,{queryBus:{execute:async()=>({})},commandBus:{execute:async()=>state.calls.push('post')},
        logger:{log(){},warn(){},error(){}},internal:{xtlsApiSocketPath:'/fixture/api.sock'},isXrayOnline:true,isXrayStartedProccesing:false,disableHashedSetCheck:false,xrayPath:'/fixture-core',xrayVersion:'fixture',nodeVersion:'fixture',
        integrations:{sync:async()=>{state.calls.push('integrations');return {}; }},managedCore:{load:async()=>({paused:false})},
        internalService:{isNeedRestartCore:()=>true,hasConfiguration:()=>state.known!==false,hasProfileBindings:()=>!!state.profileInput,getProfileInput:()=>state.profileInput??null,extractUsersFromConfig:async(hashes,config,bindings,input)=>{state.calls.push('users');state.userConfig=config;state.bindings=bindings;state.profileInput=input;}},
        xtlsSdk:{stats:{getSysStats:async()=>({isOk:state.stats})}},xrayProcess:{getStatus:async()=>({up:state.up})},
        liveCore:{supported:async()=>{state.calls.push('capability');return state.supported;},profilesSupported:async()=>state.graphSupported!==false,
            apply:async()=>{state.calls.push('apply');if(state.applyError)throw Error(state.applyError);},prepareRestart:async()=>state.calls.push('checkpoint'),
            applyProfiles:async(binary,socket,input)=>{state.calls.push('apply-profiles');if(state.applyError)throw Error(state.applyError);state.nativeInput=input;return {unchanged:state.replay??false};},
            prepareProfileRestart:async(binary,input)=>{state.calls.push('checkpoint-profiles');state.nativeInput=input;}},
        coreLoaderService:{prepare:async()=>{}},geodataService:{prepare:async()=>{}},
        reconciliation:{accepts:()=>true,enroll:async()=>state.calls.push('enroll')},
        portPlans:{read:async()=>state.savedPortPlan,begin:async target=>{state.calls.push('begin-plan');state.savedPortPlan={version:1,...target,required:!!state.savedPortPlan?.required||target.enabled,appliedRevision:null};},
            complete:async target=>{state.calls.push('complete-plan');state.savedPortPlan={version:1,...target,required:target.enabled,appliedRevision:target.revision};}},
        restartXrayProcess:async()=>{state.calls.push('restart');return {error:null};},getXrayInternalStatus:async()=>({isStarted:true,error:null}),refreshXrayVersion:async()=>{}});
    const request={xrayConfig:{inbounds:[],outbounds:[]},internals:{requireLiveApply:true,forceRestart:false,hashes:{emptyConfig:'fixture',inbounds:[]}}};
    return {service,state,request,run:()=>service.startXrayLocked(request,'127.0.0.1')};
}
test('a required native port plan rejects an old core or force restart before changing integrations or users',async()=>{
    for(const change of [f=>f.state.supported=false,f=>f.request.internals.forceRestart=true]){
        const f=fixture();change(f);const result=await f.run();assert.equal(result.isOk,true);assert.equal(result.response.isStarted,true);assert.ok(result.response.error);
        for(const action of ['integrations','apply','checkpoint','restart','users','enroll'])assert.equal(f.state.calls.includes(action),false,action);
        assert.equal(f.service.isXrayStartedProccesing,false);
    }
});
test('a failed native apply keeps the existing process and cannot fall back to a maintenance restart',async()=>{
    const f=fixture();f.state.applyError='fixture live apply failed';const result=await f.run();assert.equal(result.response.isStarted,true);assert.equal(result.response.error,f.state.applyError);
    assert.ok(f.state.calls.includes('apply'));for(const action of ['checkpoint','restart','users','enroll'])assert.equal(f.state.calls.includes(action),false,action);
});

test('an owned delivery renders plugin changes even when user and profile hashes are unchanged',async()=>{
    const f=fixture();f.request.internals.portPlan={revision:'7',enabled:true,delivery:{epoch:'2',owner:'aaaaaaaa-1111-4111-8111-111111111111'}};
    f.service.internalService.isNeedRestartCore=()=>false;
    const result=await f.run();assert.equal(result.response.error,null);assert.ok(f.state.calls.includes('apply'));
    assert.ok(f.state.calls.includes('complete-plan'));assert.equal(f.state.calls.includes('restart'),false);
});

test('a stale start owner is rejected from real persisted state before integrations or native changes',async t=>{
    const promises=require('node:fs/promises'),os=require('node:os');
    const directory=await promises.mkdtemp(path.join(os.tmpdir(),'remnacust-start-owner-'));await promises.chmod(directory,0o700);
    t.after(()=>promises.rm(directory,{recursive:true,force:true}));
    const ref={exports:{}};new Function('require','module','exports',compile(path.join(__dirname,'../src/modules/xray-core/port-plan-state.ts')))(require,ref,ref.exports);
    const store=new ref.exports.PortPlanStateStore(path.join(directory,'private/port-plan-state.json'));
    const current={revision:'7',enabled:true,delivery:{epoch:'2',owner:'bbbbbbbb-1111-4111-8111-111111111111'}};
    await store.begin(current);await store.complete(current);
    const f=fixture();f.service.portPlans=new ref.exports.PortPlanStateStore(store.filename);
    f.request.internals.portPlan={...current,delivery:{epoch:'1',owner:'aaaaaaaa-1111-4111-8111-111111111111'}};
    const response=await f.run();assert.match(response.response.error,/older delivery owner/);
    for(const action of ['integrations','apply','checkpoint','restart','users','enroll'])assert.equal(f.state.calls.includes(action),false,action);
    assert.deepEqual(await store.read(),{version:2,...current,required:true,appliedRevision:'7'});
});
test('a running but unresponsive core is preserved instead of being mistaken for a cold start',async()=>{
    const f=fixture();f.state.stats=false;const result=await f.run();assert.equal(result.response.isStarted,true);assert.match(result.response.error,/process was preserved/);
    for(const action of ['apply','checkpoint','restart','users','enroll'])assert.equal(f.state.calls.includes(action),false,action);
});
test('only a confirmed stopped process may start from the committed port plan',async()=>{
    const f=fixture();f.state.up=false;f.service.isXrayOnline=false;const result=await f.run();assert.equal(result.response.isStarted,true);assert.equal(result.response.error,null);
    assert.deepEqual(f.state.calls,['capability','integrations','validate','checkpoint','users','restart','post','enroll']);
});
test('successful live application updates user hashes and enrollment only after the native acknowledgement',async()=>{
    const f=fixture();const result=await f.run();assert.equal(result.response.isStarted,true);assert.equal(result.response.error,null);
    assert.deepEqual(f.state.calls,['capability','integrations','apply','users','post','enroll']);
});
test('health advertises the explicit port-plan capability and a probe error does not hide an existing healthy process',async()=>{
    const f=fixture();let result=await f.service.getNodeHealthCheck();assert.equal(result.response.nativePortPlansSupported,true);
    f.service.liveCore.supported=async()=>{throw Error('fixture probe unavailable');};result=await f.service.getNodeHealthCheck();
    assert.equal(result.response.isAlive,true);assert.equal(result.response.xrayInternalStatusCached,true);assert.equal(result.response.nativePortPlansSupported,false);
});

test('a saved native port plan rejects a stale unversioned bulk payload before side effects',async()=>{
    const f=fixture();f.request.internals.requireLiveApply=undefined;
    f.state.savedPortPlan={version:1,revision:'7',enabled:true,required:true,appliedRevision:'7'};
    const response=await f.run();assert.match(response.response.error,/unversioned configuration/);
    assert.equal(response.response.isStarted,true);assert.deepEqual(f.state.calls,[]);
});

test('a versioned port target is persisted before live apply and completed only after its ACK',async()=>{
    const f=fixture();f.request.internals.portPlan={revision:'7',enabled:true};
    const result=await f.run();assert.equal(result.response.error,null);
    assert.deepEqual(f.state.calls,['capability','begin-plan','integrations','apply','users','post','complete-plan','enroll']);
    assert.equal(f.state.savedPortPlan.appliedRevision,'7');
    const failed=fixture();failed.request.internals.portPlan={revision:'8',enabled:true};failed.state.applyError='Occupied';
    assert.ok((await failed.run()).response.error);assert.equal(failed.state.savedPortPlan.required,true);
    assert.equal(failed.state.savedPortPlan.appliedRevision,null);assert(!failed.state.calls.includes('complete-plan'));
});

test('removing mandatory-live flag cannot make a versioned port target restart an unresponsive core',async()=>{
    const f=fixture();f.request.internals.requireLiveApply=undefined;f.request.internals.portPlan={revision:'9',enabled:true};f.state.stats=false;
    const response=await f.run();assert.match(response.response.error,/process was preserved/);
    assert.equal(response.response.isStarted,true);assert(!f.state.calls.includes('restart'));assert(!f.state.calls.includes('complete-plan'));
});

test('disabling a native plan still needs a native ACK before clearing its requirement',async()=>{
    const f=fixture();f.request.internals.requireLiveApply=undefined;f.request.internals.portPlan={revision:'8',enabled:false};
    f.state.savedPortPlan={version:1,revision:'7',enabled:true,required:true,appliedRevision:'7'};
    f.state.supported=false;const rejected=await f.run();assert.ok(rejected.response.error);assert.equal(f.state.savedPortPlan.required,true);
    assert(!f.state.calls.includes('begin-plan'));f.state.supported=true;f.state.calls=[];
    const applied=await f.run();assert.equal(applied.response.error,null);assert(f.state.calls.includes('apply'));
    assert.equal(f.state.savedPortPlan.required,false);assert.equal(f.state.savedPortPlan.appliedRevision,'8');
});


test('unchanged acknowledged owned inputs preserve the hash fast path on an ordinary external core',async t=>{
    const promises=require('node:fs/promises'),os=require('node:os');
    const directory=await promises.mkdtemp(path.join(os.tmpdir(),'remnacust-fast-owned-'));await promises.chmod(directory,0o700);
    t.after(()=>promises.rm(directory,{recursive:true,force:true}));
    const f=fixture();f.request.internals.requireLiveApply=false;
    const target={revision:'7',enabled:false,delivery:{epoch:'2',owner:'bbbbbbbb-1111-4111-8111-111111111111'}};
    f.request.internals.portPlan=target;const store=new portStateModule.PortPlanStateStore(path.join(directory,'private/port-plan-state.json'));
    await store.begin(target);await store.complete(target,portStateModule.portPlanInputsHash(f.request.xrayConfig));
    f.service.portPlans=store;f.state.supported=false;f.service.internalService.isNeedRestartCore=()=>false;
    const response=await f.run();assert.equal(response.response.error,null);
    for(const action of ['apply','checkpoint','restart','integrations']){
        if(action==='integrations')continue;assert.equal(f.state.calls.includes(action),false,action);
    }
    assert.equal((await store.read()).appliedRevision,'7');
});
const graphUuid = n => `${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
function graphFixture(){
    const f=fixture();
    const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
    const hash=value=>require('node:crypto').createHash('sha256').update(canonical(value)).digest('hex');
    const graphs=[1,2].map(n=>{
        const graph={bindingUuid:graphUuid(n),configProfileUuid:graphUuid(n+10),configProfileInboundUuid:graphUuid(n+20),
            config:{inbounds:[{tag:'PORT-'+n,listen:'127.0.0.1',port:24000+n,protocol:'vless',settings:{decryption:'none',clients:[{id:graphUuid(100)}]}}],
                outbounds:[{tag:'direct',protocol:'freedom'}],dns:{hosts:{'same.test':'192.0.2.'+n}},routing:{rules:[{outboundTag:'direct'}]}}};
        return {...graph,hash:hash(graph)};
    });
    const plan={version:'remnacust-profile-graphs-v1',graphs};plan.hash=hash(plan);
    f.request.xrayConfig={remnacustProfileGraphs:plan};
    f.request.internals.portPlan={revision:'7',enabled:true,delivery:{epoch:'2',owner:graphUuid(50)}};
    return f;
}

test('production start path delivers independent graphs and installs the binding index only after acknowledgement',async()=>{
    const f=graphFixture(),result=await f.run();
    assert.equal(result.response.error,null);
    assert.ok(f.state.calls.includes('apply-profiles'));
    for(const action of ['apply','checkpoint','restart'])assert.equal(f.state.calls.includes(action),false,action);
    assert.equal(f.state.nativeInput.graphs.length,2);
    assert.equal(f.state.nativeInput.graphs[0].config.dns.hosts['same.test'],'192.0.2.1');
    assert.equal(f.state.nativeInput.graphs[1].config.dns.hosts['same.test'],'192.0.2.2');
    assert.deepEqual(f.state.bindings.map(binding=>binding.bindingUuid),[graphUuid(1),graphUuid(2)]);
    assert.ok(f.state.calls.indexOf('users')>f.state.calls.indexOf('apply-profiles'));
});

test('replayed native delivery never overwrites current user membership from old source JSON',async()=>{
    const f=graphFixture();f.state.replay=true;f.state.profileInput={retained:true};
    assert.equal((await f.run()).response.error,null);
    assert.equal(f.state.calls.includes('users'),false);
    assert.deepEqual(f.state.profileInput,{retained:true});
    const cold=graphFixture();cold.state.replay=true;
    assert.match((await cold.run()).response.error,/fresh panel delivery/);
    assert.equal(cold.state.calls.includes('complete-plan'),false);
    assert.equal(cold.state.calls.includes('restart'),false);
});

test('an incompatible core or failed profile transaction cannot restart the running core or replace its user index',async()=>{
    for(const change of [f=>f.state.graphSupported=false,f=>f.state.applyError='profile transaction rejected']){
        const f=graphFixture();change(f);const result=await f.run();
        assert.ok(result.response.error);assert.equal(result.response.isStarted,true);
        for(const action of ['restart','checkpoint','checkpoint-profiles','users','complete-plan'])assert.equal(f.state.calls.includes(action),false,action);
    }
});

test('cold profile start prepares the complete manifest and waits for core readiness before installing users',async()=>{
    const f=graphFixture();f.service.isXrayOnline=false;f.state.up=false;f.state.stats=false;
    const result=await f.run();assert.equal(result.response.error,null);
    assert.ok(f.state.calls.includes('checkpoint-profiles'));
    assert.ok(f.state.calls.indexOf('users')>f.state.calls.indexOf('restart'));
    assert.equal(f.state.calls.includes('checkpoint'),false);
});
