const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {restoreCoreSelection,verifyCorePolicy} = require('../docker/rootfs/etc/s6-overlay/scripts/core-boot.cjs');
const {validateSavedPortPlan,PORT_PLAN_DELIVERY_CAPABILITY} = require('../docker/rootfs/etc/s6-overlay/scripts/core-boot.cjs');
const {QUOTA_REGISTRATION_CAPABILITY,registeredQuotaJournal} = require('../docker/rootfs/etc/s6-overlay/scripts/core-boot.cjs');
const {QUOTA_WATERMARK_CAPABILITY,quotaJournalCheckpoint,verifyQuotaCheckpoint}=require('../docker/rootfs/etc/s6-overlay/scripts/core-boot.cjs');

test('saved journal floor rejects restored state before core boot without confusing normal offline restarts',()=>{
    const instance='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const journal={rank:2,sequence:10,checkpoint:8,instance};
    const policy={quotaCheckpoint:{instance,sequence:'9'}};
    assert.doesNotThrow(()=>verifyQuotaCheckpoint(policy,journal));
    for(const bad of [{...journal,sequence:7},{...journal,checkpoint:10},{...journal,instance:'wrong'},null])
        assert.throws(()=>verifyQuotaCheckpoint(policy,bad),/checkpoint/);
    assert.throws(()=>verifyQuotaCheckpoint({},journal),/checkpoint/);
    const payload=JSON.stringify({instance,version:QUOTA_WATERMARK_CAPABILITY,sequence:10,checkpoint:8,entries:{}});
    const raw=Buffer.from(`{"payload":${payload},"sha256":"${createHash('sha256').update(payload).digest('hex')}"}\n`);
    assert.deepEqual(quotaJournalCheckpoint(raw),journal);
});

test('registered journal boot gate survives lost policy and refuses old binaries and torn/downgraded frames', t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'remnacust-registered-boot-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.chmodSync(root,0o700);
    fs.mkdirSync(path.join(root,'quota'),{mode:0o700});
    const frame=(version,sequence=0)=>{const payload=JSON.stringify({version,sequence,instance:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',entries:{}});return `{"payload":${payload},"sha256":"${createHash('sha256').update(payload).digest('hex')}"}\n`;};
    const strict=frame(QUOTA_REGISTRATION_CAPABILITY,1),legacy=frame('remnacust-quota-reserves-v1');
    assert.equal(registeredQuotaJournal(Buffer.from(legacy+strict)),true);
    assert.throws(()=>registeredQuotaJournal(Buffer.from(strict+legacy)),/protocol/);
    assert.throws(()=>registeredQuotaJournal(Buffer.from(strict.slice(0,-3))),/Incomplete|JSON/);
    fs.writeFileSync(path.join(root,'quota/ledger.json'),strict,{mode:0o600});
    const binary=path.join(root,'candidate'),policy=path.join(root,'host-policy.json'),checkpoint=path.join(root,'absent');
    fs.writeFileSync(binary,'xera-host-policy-v2 remnacust-quota-reserves-v1 remnacust-unreserved-usage-v1');
    assert.throws(()=>verifyCorePolicy(binary,policy,checkpoint),/Recover/);
    fs.writeFileSync(policy,JSON.stringify({offlineReserves:'remnacust-quota-reserves-v1',quotaRegistrations:QUOTA_REGISTRATION_CAPABILITY}),{mode:0o600});
    assert.throws(()=>verifyCorePolicy(binary,policy,checkpoint),/cannot enforce/);
    fs.appendFileSync(binary,' '+QUOTA_REGISTRATION_CAPABILITY);
    assert.doesNotThrow(()=>verifyCorePolicy(binary,policy,checkpoint));
});

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'remnacust-core-boot-'));
    t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
    const root = path.join(directory,'state'); fs.mkdirSync(root,{mode:0o700});
    const stock = path.join(directory,'stock'); fs.writeFileSync(stock,'bundled fixture');
    const link = path.join(directory,'active');
    const binary = Buffer.from('selected fixture');
    const sha256 = createHash('sha256').update(binary).digest('hex');
    const identity = {path:path.join(root,sha256),sha256,version:'fixture'};
    fs.writeFileSync(identity.path,binary,{mode:0o700});
    const write = state => fs.writeFileSync(path.join(root,'state.json'),JSON.stringify(state),{mode:0o600});
    const run = () => restoreCoreSelection(root,link,stock);
    return {root,stock,link,identity,write,run};
}

test('managed selection and administrative pause survive container boot',t => {
    const f = fixture(t);
    f.write({mode:'managed',paused:true,binary:f.identity});
    assert.equal(f.run(),true);
    assert.equal(fs.realpathSync(f.link),f.identity.path);
    f.write({mode:'managed',paused:false,binary:f.identity});
    assert.equal(f.run(),false);
});
test('a bundled selection uses the updated image while profile recovery uses its verified snapshot',t => {
    const f = fixture(t);
    f.write({mode:'bundled',paused:false,binary:{...f.identity,path:f.stock}});
    assert.equal(f.run(),false);
    assert.equal(fs.realpathSync(f.link),f.stock);
    f.write({mode:'profile',paused:false,binary:f.identity});
    assert.equal(f.run(),false);
    assert.equal(fs.realpathSync(f.link),f.identity.path);
});
test('interrupted operations restore the previous verified selection before public listeners start',t => {
    const f = fixture(t);
    f.write({mode:'managed',paused:false,binary:{...f.identity,sha256:'0'.repeat(64)},
        operation:{id:'operation',status:'running'}, recovery:{mode:'managed',paused:true,binary:f.identity}});
    assert.equal(f.run(),true);
    const state = JSON.parse(fs.readFileSync(path.join(f.root,'state.json')));
    assert.equal(state.operation.status,'failed');
    assert.equal(state.operation.phase,'interrupted');
    assert.equal(state.recovery,undefined);
    assert.equal(f.run(),true);
});
test('tampered, missing and out-of-store binaries cannot be activated',t => {
    const f = fixture(t);
    f.write({mode:'managed',paused:false,binary:{...f.identity,path:f.stock}});
    assert.throws(f.run,/outside managed storage/);
    assert.equal(fs.existsSync(f.link),false);
    f.write({mode:'managed',paused:false,binary:f.identity});
    fs.writeFileSync(f.identity.path,'tampered');
    assert.throws(f.run,/integrity check/);
    assert.equal(fs.existsSync(f.link),false);
    f.write({mode:'managed',paused:false});
    assert.throws(f.run,/no binary/);
});
test('absent journal permits first installation; corrupt journal cannot fall back to a different core',t => {
    const f = fixture(t);
    assert.equal(f.run(),false);
    fs.writeFileSync(path.join(f.root,'state.json'),'{broken');
    assert.throws(f.run);
    assert.equal(fs.existsSync(f.link),false);
});

test('container downgrade cannot expose a core that ignores persisted quota reserves',t => {
    const f = fixture(t);
    const policy = path.join(f.root,'policy.json');
    fs.writeFileSync(policy,JSON.stringify({version:'xera-host-policy-v2',protectedInbounds:['private'],offlineReserves:'remnacust-quota-reserves-v1'}));
    fs.writeFileSync(f.stock,'xera-host-policy-v2');
    assert.throws(()=>verifyCorePolicy(f.stock,policy),/cannot enforce/);
    fs.writeFileSync(f.stock,'xera-host-policy-v2 remnacust-quota-reserves-v1');
    assert.throws(()=>verifyCorePolicy(f.stock,policy),/cannot enforce/);
    fs.appendFileSync(f.stock,' remnacust-unreserved-usage-v1');
    assert.doesNotThrow(()=>verifyCorePolicy(f.stock,policy));
    fs.writeFileSync(policy,JSON.stringify({version:'xera-host-policy-v2',protectedInbounds:['private'],offlineReserves:'remnacust-quota-reserves-v1',groups:{a:{fencedOwners:{123:true}}}}));
    assert.throws(()=>verifyCorePolicy(f.stock,policy),/cannot enforce/);
    fs.writeFileSync(f.stock,'xera-host-policy-v2 remnacust-quota-reserves-v1 remnacust-quota-fences-v1 remnacust-unreserved-usage-v1');
    assert.doesNotThrow(()=>verifyCorePolicy(f.stock,policy));
    fs.writeFileSync(policy,'{broken');
    assert.throws(()=>verifyCorePolicy(f.stock,policy));
});

test('a durable usage stream requires receipt support even without a saved policy or pending frame',t=>{
    const f=fixture(t),policy=path.join(f.root,'absent-policy.json');
    fs.mkdirSync(path.join(f.root,'usage'),{mode:0o700});
    assert.throws(()=>verifyCorePolicy(f.stock,policy),/cannot enforce/);
    fs.writeFileSync(f.stock,'remnacust-usage-receipts-v1');
    assert.throws(()=>verifyCorePolicy(f.stock,policy),/cannot enforce/);
    fs.appendFileSync(f.stock,' remnacust-unreserved-usage-v1');
    assert.doesNotThrow(()=>verifyCorePolicy(f.stock,policy));
});

test('mandatory user quota survives either lost policy or lost marker; corrupt checkpoint blocks boot',t=>{
    const f=fixture(t),policy=path.join(f.root,'policy.json'),checkpoint=path.join(f.root,'checkpoint.pb');
    const capability='remnacust-user-quota-reserves-v1';
    const payload=Buffer.from('compiled fixture');
    const record=Buffer.concat([Buffer.from('REMNACUST-CORE-STATE-2-USER-QUOTA\n'+createHash('sha256').update(payload).digest('hex')+'\n'),payload]);
    const run=()=>verifyCorePolicy(f.stock,policy,checkpoint);
    fs.writeFileSync(checkpoint,record,{mode:0o600});
    assert.throws(run,/Recover the saved user quota/);
    fs.writeFileSync(policy,JSON.stringify({userQuota:capability}));
    assert.throws(run,/cannot enforce/);
    fs.writeFileSync(f.stock,capability);assert.throws(run,/cannot enforce/);
    fs.appendFileSync(f.stock,' remnacust-unreserved-usage-v1');assert.doesNotThrow(run);
    fs.mkdirSync(path.join(f.root,'quota'),{mode:0o700});fs.writeFileSync(path.join(f.root,'quota/user-quota-required'),capability+'\n',{mode:0o600});
    fs.unlinkSync(checkpoint);assert.doesNotThrow(run);
    fs.writeFileSync(policy,'{}');assert.throws(run,/Recover the saved user quota/);
    fs.writeFileSync(policy,JSON.stringify({userQuota:capability}));fs.writeFileSync(checkpoint,Buffer.concat([record,Buffer.from('corrupt')]),{mode:0o600});
    assert.throws(run,/Invalid private restart checkpoint/);
});

test('container boot cannot downgrade a pending or applied native port plan',t=>{
    const f=fixture(t),policy=path.join(f.root,'absent-policy.json'),checkpoint=path.join(f.root,'absent-checkpoint.pb');
    const directory=path.join(f.root,'core');fs.mkdirSync(directory,{mode:0o700});
    const marker=path.join(directory,'port-plan-state.json'),run=()=>verifyCorePolicy(f.stock,policy,checkpoint);
    for(const state of [{version:1,revision:'7',enabled:true,required:true,appliedRevision:null},
        {version:1,revision:'8',enabled:false,required:true,appliedRevision:'7'}]){
        fs.writeFileSync(marker,JSON.stringify(state),{mode:0o600});fs.writeFileSync(f.stock,'old core');
        assert.throws(run,/cannot enforce/);fs.writeFileSync(f.stock,'remnacust-live-ports-v1');assert.doesNotThrow(run);
    }
    fs.writeFileSync(marker,JSON.stringify({version:1,revision:'8',enabled:false,required:false,appliedRevision:'8'}),{mode:0o600});
    fs.writeFileSync(f.stock,'legacy core after confirmed disable');assert.doesNotThrow(run);
    fs.writeFileSync(marker,JSON.stringify({version:1,revision:'9',enabled:true,required:false,appliedRevision:null}),{mode:0o600});assert.throws(run,/Invalid saved port-plan/);
});

test('container boot preserves delivery ownership and verifies version 2 state before starting listeners',t=>{
    const f=fixture(t),policy=path.join(f.root,'absent-policy.json'),checkpoint=path.join(f.root,'absent-checkpoint.pb');
    const directory=path.join(f.root,'core');fs.mkdirSync(directory,{mode:0o700});
    const marker=path.join(directory,'port-plan-state.json'),run=()=>verifyCorePolicy(f.stock,policy,checkpoint);
    const state={version:2,revision:'9',enabled:true,required:true,appliedRevision:'8',
        delivery:{epoch:'9007199254740993',owner:'f508a5b7-0422-4857-a07e-69aa63b90a09'},
        pluginDirty:true,appliedInputsHash:'a'.repeat(64),desiredPluginHash:'b'.repeat(64)};
    assert.equal(PORT_PLAN_DELIVERY_CAPABILITY,'remnacust-port-plan-delivery-v2');
    fs.writeFileSync(marker,JSON.stringify(state),{mode:0o600});
    assert.throws(run,/cannot enforce/);
    fs.writeFileSync(f.stock,'remnacust-live-ports-v1');assert.doesNotThrow(run);
    for(const invalid of [{...state,delivery:undefined},{...state,delivery:{...state.delivery,epoch:'9223372036854775808'}},
        {...state,delivery:{...state.delivery,epoch:'1.2'}},{...state,delivery:{...state.delivery,owner:'not-a-uuid'}},
        {...state,pluginDirty:'yes'},{...state,appliedInputsHash:'bad'},{...state,desiredPluginHash:1},
        {...state,version:1},{...state,required:false}]){
        fs.writeFileSync(marker,JSON.stringify(invalid),{mode:0o600});assert.throws(run,/Invalid saved port-plan/);
    }
    const disabled={...state,enabled:false,required:false,appliedRevision:state.revision};
    fs.writeFileSync(marker,JSON.stringify(disabled),{mode:0o600});fs.writeFileSync(f.stock,'legacy core');assert.doesNotThrow(run);
    assert.deepEqual(validateSavedPortPlan(disabled),disabled);
});
