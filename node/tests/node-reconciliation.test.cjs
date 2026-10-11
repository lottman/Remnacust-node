const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const {StartXrayCommand}=require('../libs/contract/build/commands/xray/start.command.js');
const source=fs.readFileSync(path.join(__dirname,'../src/modules/xray-core/node-reconciliation.service.ts'),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true}}).outputText;
const uuid='00000000-0000-4000-8000-000000000001';
const enrollment={url:`https://panel.example.com/api/nodes/${uuid}/reconcile`,token:'a'.repeat(43),revision:'12'};
function fixture(stored=enrollment){
    const state={files:new Map(stored?[['/var/lib/remnacust/run/node-reconciliation.json',JSON.stringify(stored)]]:[]),requests:[],warnings:[],schedules:[],writeMode:null};
    state.fetch=async(url,options)=>{state.requests.push({url,options});return new Response(JSON.stringify({accepted:true,refreshQueued:JSON.parse(options.body).refresh}),{status:201});};
    const mocks={
        '@nestjs/common':{Injectable:()=>x=>x,Logger:class {warn(message){state.warnings.push(message);}}},
        '@libs/contracts/commands':{StartXrayCommand},
        'node:fs/promises':{mkdir:async()=>{},readFile:async filename=>{if(!state.files.has(filename))throw Error('ENOENT');return state.files.get(filename);},writeFile:async(filename,value,options)=>{state.writeMode=options.mode;state.files.set(filename,value);},rename:async(from,to)=>{state.files.set(to,state.files.get(from));state.files.delete(from);}},
        'node:path':require('node:path'),
    };
    const ref={exports:{}};
    new Function('require','module','exports','fetch','setTimeout','clearTimeout',compiled)(id=>mocks[id],ref,ref.exports,(...args)=>state.fetch(...args),(_fn,delay)=>{state.schedules.push(delay);return {unref(){}};},()=>{});
    const service=new ref.exports.NodeReconciliationService();
    return {state,service};
}
test('a paired node requests fresh data at boot; healthy heartbeats do not request restarts',async()=>{
    const {state,service}=fixture();await service.onApplicationBootstrap();
    assert.equal(state.schedules[0],0);
    await service.checkIn();await service.checkIn();
    assert.deepEqual(state.requests.map(r=>JSON.parse(r.options.body)),[{refresh:true,revision:'12'},{refresh:false,revision:'12'}]);
    assert.equal(state.requests[0].options.headers.Authorization,'Bearer '+enrollment.token);
    assert.equal(state.requests[0].options.redirect,'error');
    service.onModuleDestroy();
});
test('connection failure retries automatically and recovery requests authoritative data',async()=>{
    const {state,service}=fixture();await service.onApplicationBootstrap();await service.checkIn();
    const normal=state.fetch;state.fetch=async()=>{throw Error('offline');};
    await service.checkIn();await service.checkIn();assert.equal(state.warnings.length,1);
    state.fetch=normal;await service.checkIn();
    assert.equal(JSON.parse(state.requests.at(-1).options.body).refresh,true);
    assert.ok(state.schedules.at(-1)>=30000&&state.schedules.at(-1)<35000);
    service.onModuleDestroy();
});
test('enrollment survives a container replacement in the existing persistent run directory',async()=>{
    const {state,service}=fixture(null);await service.onApplicationBootstrap();await service.enroll(enrollment);
    assert.equal(state.writeMode,0o600);await service.checkIn();
    assert.equal(JSON.parse(state.requests[0].options.body).refresh,false);
    const stored=JSON.parse(state.files.get('/var/lib/remnacust/run/node-reconciliation.json'));
    service.onModuleDestroy();
    const next=fixture(stored);await next.service.onApplicationBootstrap();await next.service.checkIn();
    assert.equal(JSON.parse(next.state.requests[0].options.body).refresh,true);next.service.onModuleDestroy();
});
test('invalid stored endpoints cannot leak a token and oversized responses are rejected',async()=>{
    for(const url of ['http://panel.example.com/api/nodes/'+uuid+'/reconcile','https://user:pass@panel.example.com/api/nodes/'+uuid+'/reconcile','https://panel.example.com/other']){
        const {state,service}=fixture({...enrollment,url});await service.onApplicationBootstrap();await service.checkIn();assert.equal(state.requests.length,0);service.onModuleDestroy();
    }
    const {state,service}=fixture();await service.onApplicationBootstrap();state.fetch=async()=>new Response('x'.repeat(1025));await service.checkIn();
    assert.equal(service.refresh,true);assert.equal(state.warnings.length,1);assert.ok(!state.warnings.join().includes(enrollment.token));service.onModuleDestroy();
});
test('a rate-limited refresh remains pending; concurrent checks and shutdown do not create extra requests',async()=>{
    const {state,service}=fixture();await service.onApplicationBootstrap();
    state.fetch=async()=>new Response(JSON.stringify({accepted:true,refreshQueued:false}));await service.checkIn();assert.equal(service.refresh,true);
    let calls=0;state.fetch=(url,options)=>new Promise((resolve,reject)=>{calls++;options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});
    const running=service.checkIn();await service.checkIn();assert.equal(calls,1);
    const scheduled=state.schedules.length;service.onModuleDestroy();await running;assert.equal(state.schedules.length,scheduled);
});
