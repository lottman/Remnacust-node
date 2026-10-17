const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = path.join(__dirname, '../src/modules/xray-core');
const CAP = 'remnacust-quota-reserves-v1';
const load = require('./load-typescript.cjs');
function fixture() {
    const state = { calls: [], existing: undefined, applied:undefined,core:{up:false}, files:new Map(),report:{instance:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sequence:3,entries:new Map()} };
    const userQuota=load(path.join(ROOT,'user-quota.ts'));
    const management=load(path.join(ROOT,'core-management.ts'));
    const nest = {};
    for (const name of ['UseGuards', 'Controller', 'Get', 'Post', 'Body', 'Headers']) nest[name] = () => () => {};
    nest.ConflictException = nest.BadRequestException = nest.ServiceUnavailableException = class extends Error {};
    const { hostPolicySchema, HostPolicyController } = load(path.join(ROOT, 'host-policy.controller.ts'), {
        '@nestjs/common': nest,
        './quota-recovery-fence': {...load(path.join(ROOT,'quota-recovery-fence.ts')),readRecoveryFence:async()=>{if(state.recoveryError)throw Error('corrupt');return state.recovery??null;}},
        '@common/guards/jwt-guards': {}, './xray-process.service': {},
        './core-incarnation': {CORE_INCARNATION:'remnacust-core-incarnation-v1',readCoreIncarnation:async()=>state.coreProcessId??null},
        './usage-receipt': load(path.join(ROOT,'usage-receipt.ts')),
        './quota-snapshot': load(path.join(ROOT, 'quota-snapshot.ts')),
        './user-quota':{...userQuota,userQuotaRequiredOnDisk:async()=>{if(state.requirementReadError)throw Error('corrupt requirement');return !!state.requiredOnDisk;}},
        './core-management':management,
        '@common/utils/destination-rule': { normalizeDestinationRule: value => value, isIpDestinationRule: () => false },
        './quota-ledger': { QUOTA_RESERVE_VERSION: CAP, verifyQuotaLedger:async()=> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', readQuotaJournalSnapshot:async()=>{state.calls.push(['quota-read']);if(state.journalError)throw state.journalError;await state.onJournalRead?.();return state.report;}, readQuotaJournal:async()=>{state.calls.push(['quota-read']);if(state.journalError)throw state.journalError;await state.onJournalRead?.();return state.report;},prepareQuotaLedger: async enabled => {
            state.calls.push(['ledger', enabled]); if (state.ledgerError) throw state.ledgerError; return 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        } },
        'node:fs/promises': {
            readFile: async filename => {
                if (filename.endsWith('/host-policy.json') && state.existing !== undefined) return state.existing;
                if (filename.endsWith('/host-policy.status.json') && state.applied !== undefined) return state.applied;
                throw Object.assign(Error('missing'), { code: 'ENOENT' });
            },
            mkdir: async () => state.calls.push(['mkdir']),
            open: async (filename, flags) => ({
                writeFile: async data => { state.calls.push(['write', data]);state.files.set(filename,data); },
                sync: async () => state.calls.push(['sync', flags]), close: async () => {},
            }),
            rename: async (source,target) => {state.calls.push(['rename']);if(target.endsWith('/host-policy.json'))state.existing=state.files.get(source);}, rm: async () => {},
        },
    });
    const controller = new HostPolicyController({ getStatus: async () => state.core },{
        hasUserQuotaRequirement:core=>!!core&&state.requiredCore===core,
        requireUserQuota:async(...args)=>{state.calls.push(['require-user-quota',...args]);if(state.requirementError)throw Error('checkpoint unavailable');state.requiredCore=args[2];},
    },{getOrThrow:()=>'/private.sock'});
    controller.supported = async () => true;
    controller.versionCache = { supported: true, quotaReservesSupported: true, quotaFencesSupported:true, destinationRulesSupported: true };
    return { state, schema: hostPolicySchema, controller };
}

function userPolicy() {
    const value=policy();value.userQuota='remnacust-user-quota-reserves-v1';value.legacyGroups=['user:global'];value.legacyOwners={'123':{allowed:true,expiresAt:0}};
    value.legacyQuotaMultipliers={'user:global':1500000000};value.hosts[H].groups.push('user:global');value.hosts[H].quotaMultipliers['user:global']=1500000000;
    value.groups['user:global']={multiplierScale:1000000000,reserveRequired:true,bytesPerSecond:0,totalBytesPerSecond:0,blockAll:false,blockedOwners:{},reserves:{123:{id:'22222222-2222-4222-8222-222222222222',instance:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ceiling:'1000',expiresAt:253402300799000}}};
    return value;
}

test('lost policy cannot downgrade a persisted user quota requirement; corrupt state cannot be replaced',async()=>{
    const {state,controller}=fixture();state.requiredOnDisk=true;
    await assert.rejects(controller.update(policy()),/cannot be removed/);
    assert.equal(state.calls.some(call=>call[0]==='write'),false);
    state.requiredOnDisk=false;state.requirementReadError=true;
    await assert.rejects(controller.update(policy()),/must be recovered/);
    assert.equal(state.calls.some(call=>call[0]==='write'),false);
});

test('global user quota bindings require an explicit capability, known owners and nanounit precision',()=>{
    const {schema}=fixture();assert.equal(schema.safeParse(userPolicy()).success,true);
    for(const mutate of [v=>delete v.userQuota,v=>delete v.legacyGroups,v=>delete v.legacyOwners,v=>delete v.legacyQuotaMultipliers,v=>v.legacyGroups.push('user:global'),v=>v.legacyGroups=['missing'],v=>v.groups['user:global'].multiplierScale=100,v=>delete v.hosts[H].quotaMultipliers['user:global'],v=>v.hosts[H].groups=['host:one'],v=>v.hosts[H].userQuotaExempt=true]) {
        const value=userPolicy();mutate(value);assert.equal(schema.safeParse(value).success,false);
    }
    const zero=userPolicy();zero.legacyQuotaMultipliers['user:global']=0;zero.hosts[H].quotaMultipliers['user:global']=0;assert.equal(schema.safeParse(zero).success,true);
    const recovery=userPolicy();recovery.hosts[H].groups=['host:one'];recovery.hosts[H].userQuotaExempt=true;assert.equal(schema.safeParse(recovery).success,true);
});

test('policy acknowledgement waits for a persisted requirement and invalidates the proof after a core restart',async()=>{
    const {state,controller}=fixture();const value=userPolicy(),core='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    controller.versionCache.userQuotaReservesSupported=true;controller.versionCache.coreIncarnationSupported=true;
    state.core={up:true,pid:7};state.coreProcessId=core;state.existing=JSON.stringify({...value,generation:'saved',expiresAt:Date.now()+90000});state.applied=JSON.stringify({pid:7,generation:'saved',quotaReserves:CAP,userQuotaReserves:value.userQuota});
    assert.equal((await controller.status()).response.applied,false);
    const result=await controller.update(value);assert.equal(result.response.applied,true);assert.equal(result.response.userQuotaRequired,true);
    assert.deepEqual(state.calls.find(call=>call[0]==='require-user-quota'),['require-user-quota','/proc/7/exe','/private.sock',core]);assert.equal((await controller.status()).response.applied,true);
    state.coreProcessId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';assert.equal((await controller.status()).response.applied,false);
    state.requirementError=true;await assert.rejects(controller.update(value),/persisted the user quota requirement/);assert.equal((await controller.status()).response.applied,false);
});
const H = '11111111111141118111111111111111';
const EMAIL = '123~0123456789abcdef01234567~h' + H;
function policy(offline = true) {
    return {
        version: 'xera-host-policy-v2', ...(offline ? { offlineReserves: CAP, revision: '1' } : {}),
        protectedInbounds: ['shared'],
        hosts: { [H]: { inboundTag: 'shared', allowedIdentities: { [EMAIL]: true }, groups: ['host:one'],
            domainMode: 'OFF', domains: [], ...(offline ? { identityExpiresAt: { [EMAIL]: 0 }, quotaMultipliers: { 'host:one': 150 } } : {}),
        } },
        groups: { 'host:one': { bytesPerSecond: 0, totalBytesPerSecond: 0, blockedOwners: {}, blockAll: false,
            ...(offline ? { reserveRequired: true, reserves: { 123: { id: '11111111-1111-4111-8111-111111111111', instance: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ceiling: '1000', expiresAt: 253402300799000 } } } : {}),
        } },
    };
}

test('legacy policy remains valid and reserves require expiry, capability and weighted scope references', () => {
    const { schema } = fixture();
    assert.equal(schema.safeParse(policy(false)).success, true);
    assert.equal(schema.safeParse(policy()).success, true);
    for (const mutate of [
        value => delete value.offlineReserves,
        value => delete value.hosts[H].identityExpiresAt,
        value => delete value.hosts[H].quotaMultipliers,
        value => value.groups['host:one'].reserves[123].ceiling = '9223372036854775808',
        value => value.groups['host:one'].reserves[123].ceiling = 'not-a-number',
        value => value.revision = 'not-a-number',
        value => value.groups['host:one'].unlimitedOwners = {123:true},
    ]) { const value = policy(); mutate(value); assert.equal(schema.safeParse(value).success, false); }
});

test('quota settlement reads are bounded, require a live acknowledgement and preserve missing IDs',async()=>{
    const {state,controller}=fixture();
    const id='11111111-1111-4111-8111-111111111111',missing='22222222-2222-4222-8222-222222222222';
    await assert.rejects(controller.quotaState({ids:[id]}),/acknowledge/);
    assert.equal(state.calls.filter(call=>call[0]==='quota-read').length,1,'Status may inspect journal metadata but settlement does not read or expose a report without live ACK');
    state.core={up:true,pid:7};state.existing=JSON.stringify({...policy(),generation:'acknowledged'});
    state.applied=JSON.stringify({generation:'acknowledged',pid:7,quotaReserves:CAP});
    state.report.entries.set(id,{group:'host:one',owner:'123',ceiling:'1000',reserved:'123',closed:true,expiresAt:253402300799000});
    const result=await controller.quotaState({ids:[id,missing]});
    assert.equal(result.response.entries[0].reserved,'123');
    assert.deepEqual(result.response.missingIds,[missing]);
    assert.equal(result.response.instance,state.report.instance);
    await assert.rejects(controller.quotaState({ids:Array(1001).fill(id)}),/selection/);
    await assert.rejects(controller.quotaState({ids:[id],after:id}),/selection/);
    state.journalError=Error('corrupt');
    await assert.rejects(controller.quotaState({ids:[id]}),/cannot be verified/);
});

test('empty quota state is prepared and flushed before staging a first autonomous policy', async () => {
    const { state, controller } = fixture();
    const result = await controller.update(policy());
    assert.equal(result.response.staged, true);
    assert.deepEqual(state.calls[0], ['ledger', false]);
    const write = state.calls.findIndex(call => call[0] === 'write');
    const sync = state.calls.findIndex(call => call[0] === 'sync');
    const rename = state.calls.findIndex(call => call[0] === 'rename');
    assert.ok(write > 0 && sync > write && rename > sync);
});

test('soft quota fences require a capable core and its explicit live acknowledgement',async()=>{
    const {state,schema,controller}=fixture();
    const body=policy();body.groups['host:one'].fenceAll=true;
    assert.equal(schema.safeParse(body).success,true);
    const invalid=structuredClone(body);invalid.groups['host:one'].reserveRequired=false;
    assert.equal(schema.safeParse(invalid).success,false);
    controller.versionCache.quotaFencesSupported=false;
    await assert.rejects(controller.update(body),/soft quota fences/);
    assert.equal(state.calls.some(call=>call[0]==='write'),false);
    state.existing=JSON.stringify({...body,generation:'fenced'});state.core={up:true,pid:7};
    state.applied=JSON.stringify({generation:'fenced',pid:7,quotaReserves:CAP});
    assert.equal((await controller.status()).response.applied,false);
    assert.deepEqual((await controller.status()).response.quotaRequiredGroups,[]);
    await assert.rejects(controller.quotaState({}),/acknowledge/);
    const release=policy();release.revision='2';
    await assert.rejects(controller.update(release),/soft quota fences/);
    controller.versionCache.quotaFencesSupported=true;
    state.applied=JSON.stringify({generation:'fenced',pid:7,quotaReserves:CAP,quotaFences:'remnacust-quota-fences-v1'});
    assert.equal((await controller.status()).response.applied,true);
    assert.deepEqual((await controller.status()).response.quotaRequiredGroups,['host:one']);
});

test('settlement cannot acknowledge a report spanning a core restart or concurrent policy write',async()=>{
    const {state,controller}=fixture();
    state.core={up:true,pid:7};state.existing=JSON.stringify({...policy(),generation:'acknowledged'});
    state.applied=JSON.stringify({generation:'acknowledged',pid:7,quotaReserves:CAP});
    state.onJournalRead=async()=>{state.core={up:true,pid:8};};
    await assert.rejects(controller.quotaState({}),/cannot be verified/);
    state.core={up:true,pid:7};
    let release,entered;
    const started=new Promise(resolve=>{entered=resolve;});
    const gate=new Promise(resolve=>{release=resolve;});
    state.onJournalRead=async()=>{entered();await gate;};
    const report=controller.quotaState({});
    await started;
    let writeEntered=false;
    controller.apply=async()=>{writeEntered=true;return {response:{applied:true}};};
    const write=controller.update(policy());
    await Promise.resolve();
    assert.equal(writeEntered,false,'Policy update must wait until the settlement snapshot is complete');
    release();await report;await write;
    assert.equal(writeEntered,true);
});

test('missing active quota state, unsupported cores and downgrade requests cannot publish a policy', async () => {
    for (const reason of ['lost', 'unsupported', 'downgrade', 'corrupt', 'binding']) {
        const { state, controller } = fixture();
        state.existing = JSON.stringify(policy());
        if (reason === 'lost') state.ledgerError = Error('lost ledger');
        if (reason === 'unsupported') controller.versionCache.quotaReservesSupported = false;
        if (reason === 'corrupt') state.existing = '{broken';
        const body = policy(reason !== 'downgrade');
        if (reason === 'binding') body.groups['host:one'].reserves[123].instance = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        await assert.rejects(controller.update(body));
        assert.equal(state.calls.some(call => call[0] === 'write'), false, reason);
        if (reason === 'lost') assert.deepEqual(state.calls[0], ['ledger', true]);
    }
});

test('out-of-order and reused policy revisions cannot overwrite a newer durable node policy', async () => {
    const { state, controller } = fixture();
    const existing = policy();existing.revision = '9';
    state.existing = JSON.stringify(existing);
    const older = policy();older.revision = '8';
    await assert.rejects(controller.update(older), /stale/);
    const reused = structuredClone(existing);reused.groups['host:one'].blockAll = true;
    await assert.rejects(controller.update(reused), /reused/);
    assert.equal(state.calls.length, 0, 'Rejected revisions must not touch quota state or policy files');
    const duplicate = await controller.update(existing);
    assert.equal(duplicate.response.staged, true);
    state.calls.length = 0;
    const newer = structuredClone(reused);newer.revision = '10';
    assert.equal((await controller.update(newer)).response.staged, true);
    assert.ok(state.calls.some(call => call[0] === 'write'));
    assert.equal((await controller.status()).response.policyRevision, '10');
    const writes=state.calls.filter(call=>call[0]==='write').length;
    await assert.rejects(controller.update(existing),/stale/);
    assert.equal(state.calls.filter(call=>call[0]==='write').length,writes,'A delayed earlier request cannot replace the newly staged revision');
});


test('outside-grant accounts require strict owners, unique bank IDs, pricing and an autonomous policy',()=>{
 const {schema}=fixture();const body=policy();body.groups['host:one'].unreservedAccounts={'123':'ff29ee68-a625-4160-9573-cc17de317a5d'};
 assert.equal(schema.safeParse(body).success,true);
 const disabled=structuredClone(body);delete disabled.groups['host:one'].reserveRequired;delete disabled.groups['host:one'].reserves;
 assert.equal(schema.safeParse(disabled).success,true,'quota-off intervals keep their old account');
 for(const mutate of [v=>delete v.offlineReserves,v=>v.groups['host:one'].unreservedAccounts={'01':'ff29ee68-a625-4160-9573-cc17de317a5d'},v=>v.groups['host:one'].unreservedAccounts={'9223372036854775808':'ff29ee68-a625-4160-9573-cc17de317a5d'},v=>v.groups['host:one'].unreservedAccounts={'123':'00000000-0000-0000-0000-000000000000'},v=>v.groups['host:one'].unreservedAccounts['124']='ff29ee68-a625-4160-9573-cc17de317a5d',v=>delete v.hosts[H].quotaMultipliers['host:one']]){const value=structuredClone(disabled);mutate(value);assert.equal(schema.safeParse(value).success,false);}
});

test('outside-grant accounting requires a capable core and explicit live acknowledgement',async()=>{
 const {state,controller}=fixture();const body=policy();body.groups['host:one'].unreservedAccounts={'123':'ff29ee68-a625-4160-9573-cc17de317a5d'};
 await assert.rejects(controller.update(body),/unreserved usage receipts/);assert.equal(state.calls.some(call=>call[0]==='write'),false);
 controller.versionCache.unreservedUsageSupported=true;
 assert.equal((await controller.update(body)).response.staged,true);
 const saved=JSON.parse(state.existing);state.core={up:true,pid:7};state.applied=JSON.stringify({pid:7,generation:saved.generation,quotaReserves:CAP});
 assert.equal((await controller.status()).response.applied,false);assert.deepEqual((await controller.status()).response.quotaRequiredGroups,[]);
 state.applied=JSON.stringify({pid:7,generation:saved.generation,quotaReserves:CAP,unreservedUsage:'remnacust-unreserved-usage-v1'});
 assert.equal((await controller.status()).response.applied,true);assert.equal((await controller.status()).response.unreservedUsageSupported,true);
});


test('autonomous owner fences also cover quota-off scopes without requiring a fabricated finite grant',()=>{
 const {schema}=fixture();const body=policy();body.groups['host:one'].fencedOwners={'123':true};delete body.groups['host:one'].reserves;delete body.groups['host:one'].reserveRequired;assert.equal(schema.safeParse(body).success,true);delete body.offlineReserves;assert.equal(schema.safeParse(body).success,false);
});

function snapshotFixture() {
 const f=fixture(),{state,controller}=f;
 state.core={up:true,pid:7};state.coreProcessId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 controller.versionCache.coreIncarnationSupported=true;controller.versionCache.quotaWatermarksSupported=true;
 state.existing=JSON.stringify({...policy(),generation:'acknowledged'});state.applied=JSON.stringify({generation:'acknowledged',pid:7,quotaReserves:CAP});
 Object.assign(state.report,{checkpoint:0,retiredBefore:0,registrationsRequired:true,watermarksRequired:true});
 return f;
}
const snapshotRequest=()=>({generation:'11111111-1111-4111-8111-111111111111',requestId:'22222222-2222-4222-8222-222222222222'});
test('full journal snapshots are read-only and bind the generation, request and live incarnation',async()=>{
 const {state,controller}=snapshotFixture(),request=snapshotRequest();
 for(let n=1001;n>=0;n--)state.report.entries.set(`${n.toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`,{group:'host:one',owner:'123',expiresAt:253402300799000,ceiling:'1000',reserved:'1'});
 assert.equal((await controller.status()).response.quotaSnapshotsSupported,true);
 const {response}=await controller.quotaSnapshot(request);const payload=JSON.parse(require('node:zlib').gunzipSync(Buffer.from(response.data,'base64')));
 assert.equal(payload.entries.length,1002);assert.equal(payload.coreProcessId,state.coreProcessId);assert.equal(payload.requestId,request.requestId);assert.equal(payload.generation,request.generation);
 assert.equal(state.calls.some(call=>['write','rename','require-user-quota'].includes(call[0])),false);
 await assert.rejects(controller.quotaSnapshot({...request,extra:true}),/request/);
});
test('snapshot refuses missing acknowledgements, journal rollback and same-PID incarnation changes',async()=>{
 for(const kind of ['down','unsupported','corrupt','instance','rollback','restart']){
  const {state,controller}=snapshotFixture();let reads=0;
  if(kind==='down')state.core.up=false;
  if(kind==='unsupported')controller.versionCache.quotaWatermarksSupported=false;
  if(kind==='corrupt')state.journalError=Error('private details');
  state.onJournalRead=async()=>{reads++;if(reads===2){
   if(kind==='instance')state.report.instance='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
   if(kind==='rollback')state.report={...state.report,sequence:2};
   if(kind==='restart')state.coreProcessId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  }};
  // Preserve each read's value as a real parsed file would, rather than a shared mutable object.
  const before=controller.status.bind(controller);controller.status=async()=>structuredClone(await before());
  await assert.rejects(controller.quotaSnapshot(snapshotRequest()),/cannot be verified/,kind);
 }
});
test('policy updates wait for a snapshot, and failed capture does not poison the control queue',async()=>{
 const {state,controller}=snapshotFixture();let release,arrive,reads=0;
 const gate=new Promise(r=>release=r),entered=new Promise(r=>arrive=r);
 state.onJournalRead=async()=>{if(++reads===2){arrive();await gate;}};
 const capture=controller.quotaSnapshot(snapshotRequest());await entered;
 let changed=false;controller.apply=async()=>{changed=true;return {response:{applied:true}};};
 const update=controller.update(policy());await Promise.resolve();assert.equal(changed,false);
 release();await capture;await update;assert.equal(changed,true);
 state.journalError=Error('broken');await assert.rejects(controller.quotaSnapshot(snapshotRequest()));
 await controller.update(policy());
});


test('delayed ordinary policy cannot replace a recovered policy without exact live transport proof',async()=>{
 const {state,controller}=fixture();const core='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';state.core={up:true,pid:7};state.coreProcessId=core;
 state.recovery={state:'RELEASED',generation:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',digest:'d'.repeat(64)};
 const proof=['v1',state.recovery.generation,state.recovery.digest,core,state.report.instance].join(':');
 const stale=policy();stale.revision='9223372036854775807';
 for(const header of [undefined,null,[proof],proof+', '+proof,proof.replace(state.recovery.generation,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),proof.replace(state.recovery.digest,'f'.repeat(64)),proof.replace(core,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),proof.replace(state.report.instance,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')])
  await assert.rejects(controller.update(stale,header),/requires reconciliation/);
 assert.equal(state.calls.length,0,'rejection precedes ledger preparation, revision change and file writes');
 const body=policy();state.existing=JSON.stringify({...body,generation:'saved',expiresAt:Date.now()+90000});state.applied=JSON.stringify({generation:'saved',pid:7,quotaReserves:CAP});
 assert.equal((await controller.update(body,proof)).response.unchanged,true);
 assert.equal(state.calls.some(c=>c[0]==='write'),false);
 state.recovery={...state.recovery,state:'FENCED'};await assert.rejects(controller.update(stale,proof),/requires reconciliation/);
 state.recovery=null;await assert.rejects(controller.update(stale,proof),/requires reconciliation/);
});


test('node status retains the recovery binding requirement while stopped or when its private marker is unreadable',async()=>{
 const {state,controller}=fixture();assert.equal((await controller.status()).response.quotaRecoveryPolicyBindingsRequired,false);
 state.recovery={state:'FENCED',generation:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',digest:'d'.repeat(64)};
 assert.equal((await controller.status()).response.quotaRecoveryPolicyBindingsRequired,true);
 state.recoveryError=true;assert.equal((await controller.status()).response.quotaRecoveryPolicyBindingsRequired,true);
 const before=structuredClone(state.calls);await assert.rejects(controller.update(policy()),/requires reconciliation/);assert.deepEqual(state.calls,before);
});
