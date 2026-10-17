const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const {createRequire} = require('node:module');
const sourceRoot=path.join(__dirname,'../src');
function load(file,mocks={}) {
    const filename=path.join(sourceRoot,file),local=createRequire(filename),ref={exports:{}};
    const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true}}).outputText;
    new Function('require','module','exports',code)(id=>Object.hasOwn(mocks,id)?mocks[id]:local(id),ref,ref.exports);
    return ref.exports;
}

test('concurrent management calls fail promptly; nested plugin work is allowed and release is idempotent',async()=>{
    const {CoreManagementBarrier}=load('modules/xray-core/core-management.ts');const barrier=new CoreManagementBarrier();
    const release=barrier.acquire();let ran=false;
    await assert.rejects(barrier.run(async()=>{ran=true;}),error=>error.getStatus()===503);
    assert.equal(ran,false);release();release();
    const second=barrier.acquire();release();assert.throws(()=>barrier.acquire(),error=>error.getStatus()===503);second();
    await barrier.run(async()=>{await barrier.run(async()=>{ran=true;});await assert.rejects(Promise.reject(Error('plugin failed')),/plugin failed/);});
    assert.equal(ran,true);
    await assert.rejects(barrier.run(async()=>{throw Error('write failed');}),/write failed/);
    await barrier.run(async()=>{});
});

test('a detached old async context cannot enter a different operation without acquiring its barrier',async()=>{
    const {CoreManagementBarrier}=load('modules/xray-core/core-management.ts');const barrier=new CoreManagementBarrier();let resume,late;
    await barrier.run(async()=>{late=new Promise(resolve=>resume=resolve).then(()=>barrier.run(async()=>{throw Error('must not run');}));});
    const release=barrier.acquire();resume();await assert.rejects(late,error=>error.getStatus()===503);release();
});

test('device removal cannot be acknowledged during checkpoint replacement, and retry reaches the actual handler',async()=>{
    const management=load('modules/xray-core/core-management.ts');
    const types=load('common/types/result.type.ts');
    const models={...load('modules/handler/models/remove-user.response.model.ts'),...load('modules/handler/models/add-user.response.model.ts'),...load('modules/handler/models/generic.response.model.ts')};
    const {HandlerService}=load('modules/handler/handler.service.ts',{
        'enhanced-ms':()=>'', 'sockdestroy':{hasCapNetAdmin:()=>false},
        '@remnawave/xtls-sdk-nestjs':{InjectXtls:()=>()=>{}},'@common/types':types,
        '@libs/contracts/constants/errors':{ERRORS:{INTERNAL_SERVER_ERROR:{code:'error'}}},
        '../_plugin/events/drop-connections':{DropConnectionsEvent:class{}},
        '../xray-core/core-management':management,'./masque-user':{},'./models':models,
        './profile-user-handler':{ProfileUserHandler:class{constructor(api){this.removeUser=(...args)=>api.handler.removeUser(...args);}}},
    });
    const calls=[];
    const handler=new HandlerService({handler:{removeUser:async(tag,user)=>{calls.push(['remove',tag,user]);return {isOk:true};}}},
        {hasConfiguration:()=>true,hasProfileBindings:()=>false,getXtlsConfigInbounds:()=>new Set(['PORT-A']),removeUserFromInbound:async(...args)=>calls.push(['hash',...args])},{publish:()=>{}});
    handler.logger={debug(){},error(){},log(){}};
    const data={username:'123~0123456789abcdef01234567',hashData:{vlessUuid:'fixture-device'}};
    const release=management.coreManagement.acquire();
    await assert.rejects(handler.removeUser(data),error=>error.getStatus()===503);
    assert.equal(calls.length,0);release();
    const result=await handler.removeUser(data);assert.equal(result.isOk,true);assert.equal(result.response.success,true);
    assert.deepEqual(calls,[['remove','PORT-A',data.username],['hash','PORT-A','fixture-device']]);
    handler.internalService.hasConfiguration=()=>false;
    const unavailable=await handler.removeUser(data);
    assert.equal(unavailable.isOk,false);
    assert.match(unavailable.message,/not synchronized/);
    assert.equal(calls.length,2,'unknown node state must not acknowledge or run a user mutation');
});
