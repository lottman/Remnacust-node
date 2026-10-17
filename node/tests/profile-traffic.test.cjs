const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const load=require('./load-typescript.cjs');
const schema=load(path.join(__dirname,'../libs/contract/models/profile-traffic.schema.ts'));
const id='11111111-1111-4111-8111-111111111111';

function fixture(){
    const state={payload:{capability:'remnacust-profile-traffic-v1',coreProcessId:id,bindings:[{
        bindingUuid:id,uplink:'9223372036854775807',downlink:'17',available:true,retired:false,
    }]},calls:[]};
    const module=load(path.join(__dirname,'../src/modules/xray-core/profile-traffic.ts'),{
        '@libs/contracts/models':schema,
        'nice-grpc':{createClient:definition=>({traffic:async(request,options)=>{
            const method=definition.traffic;
            state.calls.push({path:method.path,request:method.requestDeserialize(method.requestSerialize(request)),options});
            return method.responseDeserialize(method.responseSerialize(state.payload));
        }})},
    });
    return {state,read:()=>module.readProfileTraffic({channel:{}})};
}

test('read-only protobuf traffic retains int64 precision and does not request a reset',async()=>{
    const f=fixture(),value=await f.read();
    assert.equal(value.bindings[0].uplink,'9223372036854775807');
    assert.equal(value.bindings[0].downlink,'17');
    assert.equal(f.state.calls[0].path,'/remnacust-profile-control-v1/Traffic');
    assert.deepEqual(f.state.calls[0].request,{});
    assert.equal(f.state.calls[0].options.signal.aborted,false);
    assert.ok(Number.isFinite(Date.parse(value.capturedAt)));
});

test('invalid counters, duplicate bindings and unknown process identities cannot become traffic data',async()=>{
    for(const change of [
        s=>s.payload.bindings[0].uplink='9223372036854775808',
        s=>s.payload.bindings[0].uplink=-1,
        s=>s.payload.bindings[0].uplink='-1',
        s=>s.payload.bindings.push({...s.payload.bindings[0]}),
        s=>s.payload.coreProcessId='not-an-incarnation',
        s=>s.payload.capability='other-protocol',
    ]){
        const f=fixture();change(f.state);await assert.rejects(f.read());
    }
});

test('only declared observation fields leave the collector and unavailable data stays explicit',async()=>{
    const f=fixture();
    f.state.payload.privateDetails='must-not-be-returned';
    f.state.payload.bindings[0].privateDetails='must-not-be-returned';
    f.state.payload.bindings[0].available=false;
    const result=await f.read();
    assert.ok(!JSON.stringify(result).includes('must-not-be-returned'));
    assert.equal(result.bindings[0].available,false);
});

test('oversized native protobuf messages are rejected before publishing observations',async()=>{
    const f=fixture();f.state.payload.extra='x'.repeat(513*1024);
    await assert.rejects(f.read(),/exceeds its limit/);
});
