const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const syncFs=require('node:fs');const os=require('node:os');const path=require('node:path');
const ts=require('typescript');const {createRequire}=require('node:module');
function load(filename,mocks={}){
    const code=ts.transpileModule(syncFs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true}}).outputText;
    const ref={exports:{}};const local=createRequire(filename);
    new Function('require','module','exports',code)(id=>Object.hasOwn(mocks,id)?mocks[id]:local(id),ref,ref.exports);return ref.exports;
}
const root=path.join(__dirname,'../src/modules');
const {readCoreIncarnation,CORE_INCARNATION}=load(path.join(root,'xray-core/core-incarnation.ts'));
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('nonregular status paths are rejected before opening a FIFO or following a symlink',{skip:process.platform!=='linux'},async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'remnacust-core-special-status-'));
    try{
        const fifo=path.join(dir,'status.fifo');require('node:child_process').execFileSync('mkfifo',[fifo]);
        const link=path.join(dir,'status.link');await fs.symlink(fifo,link);
        let opened=0;
        const helper=load(path.join(root,'xray-core/core-incarnation.ts'),{'node:fs/promises':{
            ...fs,open:async()=>{opened++;throw Error('Must not open a nonregular status path');},
        }}).readCoreIncarnation;
        for(const file of [fifo,link,dir])assert.equal(await helper({up:true,pid:123},file),null);
        assert.equal(opened,0,'A malformed status path cannot hang a statistics request in open()');
    }finally{await fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:20});}
});
test('core continuity requires a bounded valid status for the live PID',async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'remnacust-core-incarnation-'));
    try{
        const file=path.join(dir,'status.json');const status={up:true,pid:123};
        const write=value=>fs.writeFile(file,JSON.stringify(value));
        await write({pid:123,coreIncarnation:CORE_INCARNATION,coreProcessId:A});
        assert.equal(await readCoreIncarnation(status,file),A);
        assert.equal(await readCoreIncarnation({up:false,pid:123},file),null);
        assert.equal(await readCoreIncarnation({up:true,pid:124},file),null);
        await write({pid:123,coreProcessId:A});assert.equal(await readCoreIncarnation(status,file),null);
        await write({pid:123,coreIncarnation:CORE_INCARNATION,coreProcessId:'invalid'});assert.equal(await readCoreIncarnation(status,file),null);
        await fs.writeFile(file,'{');assert.equal(await readCoreIncarnation(status,file),null);
        await fs.writeFile(file,Buffer.alloc(65537));assert.equal(await readCoreIncarnation(status,file),null);
        assert.equal(await readCoreIncarnation(status,path.join(dir,'missing')),null);
    }finally{await fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:20});}
});
test('a replaced status file exposes the new incarnation even if its PID repeats',async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'remnacust-core-pid-reuse-'));
    try{
        const file=path.join(dir,'status.json');const status={up:true,pid:123};
        for(const id of [A,B]){
            const tmp=path.join(dir,'status.tmp');await fs.writeFile(tmp,JSON.stringify({pid:123,coreIncarnation:CORE_INCARNATION,coreProcessId:id}));
            await fs.rename(tmp,file);assert.equal(await readCoreIncarnation(status,file),id);
        }
    }finally{await fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:20});}
});
function serviceFixture(before,after){
    let reads=0;let requests=0;
    class Model{constructor(users,coreProcessId){Object.assign(this,{users,coreProcessId});}}
    const {StatsService}=load(path.join(root,'stats/stats.service.ts'),{
        '@remnawave/xtls-sdk-nestjs':{InjectXtls:()=>()=>{}},
        '@common/types':{ok:response=>({isOk:true,response}),fail:error=>({isOk:false,...error})},
        '@common/utils/get-system-stats':{},'@libs/contracts/constants':{ERRORS:{FAILED_TO_GET_USERS_STATS:{code:'test'}}},
        '../_plugin/queries/get-torrent-blocker-reports-count':{},
        '../network-stats/queries/get-interface-stats/get-interface-stats.query':{},
        '../xray-core/xray-process.service':{},'../xray-core/core-incarnation':{readCoreIncarnation:async()=>reads++===0?before:after},
        '../xray-core/profile-traffic':{readProfileTraffic:async()=>{throw Error('User accounting must not read profile observations');}},
        './models':{GetUsersStatsResponseModel:Model},
    });
    const service=new StatsService({stats:{getAllUsersStats:async reset=>{
        requests++;assert.equal(reset,true);
        return {isOk:true,data:{users:[{username:'901',uplink:7,downlink:11},{username:'902',uplink:0,downlink:0}]}};
    }}},{},{getStatus:async()=>({up:true,pid:123})},{hasProfileBindings:()=>false});
    return {service,requests:()=>requests};
}
test('the same core incarnation proves a stat sample without changing its traffic',async()=>{
    const f=serviceFixture(A,A);const result=await f.service.getUsersStats(true);
    assert.equal(result.isOk,true);assert.equal(result.response.coreProcessId,A);
    assert.deepEqual(result.response.users,[{username:'901',uplink:7,downlink:11}]);assert.equal(f.requests(),1);
});
test('core restart, missing status and legacy status keep billing data but cannot prove continuity',async()=>{
    for(const [before,after] of [[A,B],[A,null],[null,A],[null,null]]){
        const f=serviceFixture(before,after);const result=await f.service.getUsersStats(true);
        assert.equal(result.isOk,true);assert.equal(result.response.coreProcessId,null);
        assert.equal(result.response.users[0].uplink,7);assert.equal(result.response.users[0].downlink,11);
    }
});
