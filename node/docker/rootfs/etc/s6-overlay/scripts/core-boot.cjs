#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT_PLAN_DELIVERY_CAPABILITY = 'remnacust-port-plan-delivery-v2';
const QUOTA_REGISTRATION_CAPABILITY = 'remnacust-quota-registrations-v1';
const QUOTA_WATERMARK_CAPABILITY = 'remnacust-quota-watermarks-v1';
const QUOTA_RECOVERY_FENCE = 'remnacust-quota-recovery-fence-v1';
function verifyRecoveryFence(data) {
    const value=JSON.parse(data.toString('utf8'));
    const keys=['version','generation','token','state','sequence','previous','digest'];
    const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)&&value!=='00000000-0000-0000-0000-000000000000';
    const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==keys.sort().join()||
       value.version!==QUOTA_RECOVERY_FENCE||!uuid(value.generation)||!uuid(value.token)||!['FENCED','RELEASED'].includes(value.state)||
       typeof value.sequence!=='string'||!/^[1-9][0-9]{0,18}$/.test(value.sequence)||BigInt(value.sequence)>9223372036854775807n||
       (value.previous!==null&&!hash(value.previous))||(value.sequence==='1')!==(value.previous===null)||
       (value.state==='RELEASED'&&value.sequence==='1')||!hash(value.digest)||
       crypto.createHash('sha256').update([value.version,value.generation,value.token,value.state,value.sequence,value.previous??'-',''].join('\n')).digest('hex')!==value.digest)
        throw Error('Invalid private recovery fence');
    return value;
}
function verifyRecoveryState(requiredData,recordData) {
    const first=requiredData?verifyRecoveryFence(requiredData):null;
    if(first&&(first.state!=='FENCED'||first.sequence!=='1'))throw Error('Invalid immutable recovery requirement');
    let record;try{record=recordData?verifyRecoveryFence(recordData):null;}catch(error){if(first)return first;throw error;}
    if(!first&&record)throw Error('Missing immutable recovery requirement');
    return first&&(!record||(record.sequence==='1'&&record.digest!==first.digest))?first:record;
}
function quotaJournalCheckpoint(data) {
    if(!data) return null;
    let previous=null;
    const versions=['remnacust-quota-reserves-v1',QUOTA_REGISTRATION_CAPABILITY,QUOTA_WATERMARK_CAPABILITY];
    const frames=data.toString('utf8').split('\n');
    if(frames.length>1 && frames.at(-1)!=='') throw Error('Incomplete quota journal');
    for(let i=0;i<frames.length;i++) {
        const frame=frames[i];if(!frame && i===frames.length-1 && i>0) break;
        const record=JSON.parse(frame),start=frame.indexOf('"payload":'),end=frame.lastIndexOf(',"sha256":');
        const payload=record.payload,rank=versions.indexOf(payload?.version),sequence=payload?.sequence??0,checkpoint=payload?.checkpoint??0;
        if(start<0 || end<start || crypto.createHash('sha256').update(frame.slice(start+10,end)).digest('hex')!==record.sha256 || rank<0 ||
            !Number.isSafeInteger(sequence)||sequence<0||!Number.isSafeInteger(checkpoint)||checkpoint<0||checkpoint>sequence||(checkpoint>0&&rank<2)||
            typeof payload?.instance!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(payload.instance)||
            (previous&&(rank<previous.rank||sequence!==previous.sequence+1||checkpoint<previous.checkpoint||payload.instance!==previous.instance))) throw Error('Invalid quota journal protocol');
        previous={rank,sequence,checkpoint,instance:payload.instance};
    }
    return previous;
}
function registeredQuotaJournal(data) { return (quotaJournalCheckpoint(data)?.rank??0)>=1; }
function verifyQuotaCheckpoint(policy,journal) {
    if(!policy?.quotaCheckpoint && (journal?.rank??0)<2) return;
    const checkpoint=policy?.quotaCheckpoint;
    if(!journal||!checkpoint||checkpoint.instance!==journal.instance||typeof checkpoint.sequence!=='string'||
        !/^(0|[1-9][0-9]{0,15})$/.test(checkpoint.sequence)||BigInt(checkpoint.sequence)>BigInt(journal.sequence)||BigInt(checkpoint.sequence)<BigInt(journal.checkpoint)) throw Error('Quota journal is behind its saved checkpoint; recover before starting the core');
}
function validateSavedPortPlan(state) {
    const counter = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
    const delivery = value => !!value && counter(value.epoch) && typeof value.owner === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.owner);
    if (!state || ![1,2].includes(state.version) ||
        (state.version === 2 && !delivery(state.delivery)) || (state.version === 1 && state.delivery !== undefined) ||
        (state.pluginDirty !== undefined && (state.version !== 2 || typeof state.pluginDirty !== 'boolean')) ||
        (state.appliedInputsHash !== undefined && (state.version !== 2 || !/^[a-f0-9]{64}$/.test(state.appliedInputsHash))) ||
        (state.desiredPluginHash !== undefined && (state.version !== 2 || !/^[a-f0-9]{64}$/.test(state.desiredPluginHash))) ||
        !counter(state.revision) || typeof state.enabled !== 'boolean' || typeof state.required !== 'boolean' ||
        (state.appliedRevision !== null && (!counter(state.appliedRevision) || BigInt(state.appliedRevision) > BigInt(state.revision))) ||
        (state.enabled && !state.required) || (state.appliedRevision === state.revision && state.required !== state.enabled)) throw Error('Invalid saved port-plan requirement');
    return state;
}

// Runs before s6 starts any public listener. A paused or invalid selection must
// never briefly expose the bundled core during container replacement.
function restoreCoreSelection(root = '/var/lib/remnawave/core-manager', link = '/usr/local/bin/rw-core', stock = '/usr/local/bin/xray') {
    const filename = path.join(root, 'state.json');
    let descriptor;
    try { descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    let state;
    try {
        const info = fs.fstatSync(descriptor);
        if (!info.isFile() || info.size > 1024 * 1024) throw Error('Invalid core selection journal');
        state = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    } finally { fs.closeSync(descriptor); }
    let interrupted = false;
    if (state.operation?.status === 'running') {
        if (!state.recovery) throw Error('Core operation has no recovery selection');
        state.mode = state.recovery.mode;
        state.paused = state.recovery.paused;
        state.binary = state.recovery.binary;
        state.operation = { ...state.operation, status:'failed', phase:'interrupted',
            error:'Container restarted during core operation; previous selection restored. Check readiness.',
            finishedAt:new Date().toISOString() };
        delete state.recovery;
        interrupted = true;
    }
    if (!['profile','managed','bundled'].includes(state.mode) || typeof state.paused !== 'boolean') throw Error('Invalid persisted core selection');
    let target = stock;
    if (state.binary && !(state.mode === 'bundled' && state.binary.path === stock)) {
        const digest = state.binary.sha256;
        if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) || state.binary.path !== path.join(root,digest)) throw Error('Core selection is outside managed storage');
        target = state.binary.path;
        const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
            const info = fs.fstatSync(fd);
            if (!info.isFile() || info.size > 192 * 1024 * 1024 || info.size === 0) throw Error('Invalid selected core binary');
            const hash = crypto.createHash('sha256');
            const buffer = Buffer.allocUnsafe(1024 * 1024);
            let n;
            while ((n = fs.readSync(fd, buffer,0,buffer.length,null)) > 0) hash.update(buffer.subarray(0,n));
            if (hash.digest('hex') !== digest) throw Error('Selected core failed its integrity check');
        } finally { fs.closeSync(fd); }
    } else if (state.mode === 'managed') throw Error('Managed core selection has no binary');
    const temporaryLink = link + '.boot-tmp';
    fs.rmSync(temporaryLink,{force:true});
    fs.symlinkSync(target,temporaryLink);
    fs.renameSync(temporaryLink,link);
    if (interrupted) {
        const temporary = filename + '.' + crypto.randomUUID() + '.boot-tmp';
        const fd = fs.openSync(temporary,'wx',0o600);
        try {
            try { fs.writeFileSync(fd,JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            fs.renameSync(temporary,filename);
        } finally { fs.rmSync(temporary,{force:true}); }
        if (process.platform !== 'win32') { const directory = fs.openSync(root,'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } }
    }
    return state.paused;
}

function verifyCorePolicy(binary = '/usr/local/bin/rw-core', filename = '/var/lib/remnanode/host-policy.json', checkpoint = '/var/lib/remnacust/run/core-state/checkpoint.pb') {
    let fd;
    let policy = {};
    try { fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if(fd !== undefined) {
    try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.size > 32*1024*1024) throw Error('Invalid host policy');
        policy = JSON.parse(fs.readFileSync(fd,'utf8'));
    } finally { fs.closeSync(fd); }
    }
    const required = [];
    const userQuota = 'remnacust-user-quota-reserves-v1';
    let userRequired = false;
    function readPrivate(file, limit) {
        let info;
        try { info = fs.lstatSync(file); } catch(error) { if(error.code==='ENOENT') return null; throw error; }
        if(!info.isFile() || info.isSymbolicLink() || info.size > limit) throw Error('Invalid private quota state');
        const parent=fs.lstatSync(path.dirname(file)),uid=process.getuid?.();
        if(!parent.isDirectory() || parent.isSymbolicLink() || (process.platform!=='win32' && ((info.mode|parent.mode)&0o077)) || (uid!==undefined && (info.uid!==uid || parent.uid!==uid))) throw Error('Quota state must be private and owned by the node');
        const descriptor=fs.openSync(file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW||0) | (fs.constants.O_NONBLOCK||0));
        try {
            const opened=fs.fstatSync(descriptor);
            if(!opened.isFile() || opened.dev!==info.dev || opened.ino!==info.ino || opened.size>limit) throw Error('Private quota state changed');
            const buffer=Buffer.alloc(limit+1);let count=0;
            while(count<buffer.length){const n=fs.readSync(descriptor,buffer,count,buffer.length-count,count);if(n===0)break;count+=n;}
            if(count>limit) throw Error('Private quota state exceeds limit');
            return buffer.subarray(0,count);
        } finally {fs.closeSync(descriptor);}
    }
    const recoveryRequired=readPrivate(path.join(path.dirname(filename),'quota/recovery-required.json'),8192);
    let recovery;try{recovery=readPrivate(path.join(path.dirname(filename),'quota/recovery.json'),8192);}catch(error){if(!recoveryRequired)throw error;recovery=Buffer.from('{}');}
    if(verifyRecoveryState(recoveryRequired,recovery))required.push(QUOTA_RECOVERY_FENCE);
    const marker=readPrivate(path.join(path.dirname(filename),'quota/user-quota-required'),128);
    const journal=quotaJournalCheckpoint(readPrivate(path.join(path.dirname(filename),'quota/ledger.json'),16*1024*1024));
    const registered=(journal?.rank??0)>=1;
    verifyQuotaCheckpoint(policy,journal);
    if(policy.quotaCheckpoint||(journal?.rank??0)>=2) required.push(QUOTA_WATERMARK_CAPABILITY);
    if(registered || policy.quotaRegistrations) {
        if(policy.quotaRegistrations!==QUOTA_REGISTRATION_CAPABILITY || policy.offlineReserves!=='remnacust-quota-reserves-v1') throw Error('Recover the registered quota policy before starting the core');
        required.push(QUOTA_REGISTRATION_CAPABILITY);
    }
    const portPlan=readPrivate(path.join(path.dirname(filename),'core/port-plan-state.json'),1024);
    if(portPlan) {
        const state=validateSavedPortPlan(JSON.parse(portPlan.toString()));
        if(state.required) required.push('remnacust-live-ports-v1');
    }
    if(marker) {
        if(marker.toString()!==userQuota+'\n') throw Error('Unknown user quota requirement');
        userRequired=true;
    }
    const cached=readPrivate(checkpoint,16*1024*1024+128);
    if(cached) {
        const legacy='REMNACUST-CORE-STATE-1\n', global='REMNACUST-CORE-STATE-2-USER-QUOTA\n';
        const header=cached.subarray(0,global.length).toString()===global?global:legacy;
        const checksum=cached.subarray(header.length,header.length+64).toString();
        const payload=cached.subarray(header.length+65);
        if(cached.subarray(0,header.length).toString()!==header || !/^[a-f0-9]{64}$/.test(checksum) || cached[header.length+64]!==10 || payload.length>16*1024*1024 || crypto.createHash('sha256').update(payload).digest('hex')!==checksum) throw Error('Invalid private restart checkpoint');
        userRequired ||= header===global;
    }
    if(userRequired || policy.userQuota) {
        if(policy.userQuota!==userQuota) throw Error('Recover the saved user quota policy before starting the core');
        required.push(userQuota);
    }
    try { fs.lstatSync(path.join(path.dirname(filename),'usage')); required.push('remnacust-usage-receipts-v1'); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
    if (policy.group || policy.protectedInbounds?.length) required.push(policy.version === 'xera-host-policy-v2' ? 'xera-host-policy-v2' : 'xera-host-policy-v1');
    if (policy.offlineReserves) required.push('remnacust-quota-reserves-v1');
    if (Object.values(policy.groups??{}).some(group=>group?.fenceAll===true || Object.values(group?.fencedOwners??{}).includes(true))) required.push('remnacust-quota-fences-v1');
    if (required.some(marker => marker === userQuota || marker === 'remnacust-usage-receipts-v1' || marker === 'remnacust-quota-reserves-v1')) required.push('remnacust-unreserved-usage-v1');
    if (!required.length) return;
    const details = fs.statSync(binary);
    if (!details.isFile() || details.size > 192*1024*1024) throw Error('Invalid core binary');
    const bytes = fs.readFileSync(binary);
    if (required.some(marker => !bytes.includes(Buffer.from(marker)))) throw Error('Selected core cannot enforce the saved host policy');
}

module.exports = { restoreCoreSelection, verifyCorePolicy, validateSavedPortPlan, PORT_PLAN_DELIVERY_CAPABILITY, QUOTA_REGISTRATION_CAPABILITY, registeredQuotaJournal, QUOTA_WATERMARK_CAPABILITY, quotaJournalCheckpoint, verifyQuotaCheckpoint, QUOTA_RECOVERY_FENCE, verifyRecoveryFence, verifyRecoveryState };
if (require.main === module) {
    try {
        const paused = restoreCoreSelection();
        verifyCorePolicy();
        process.exitCode = paused ? 75 : 0;
    }
    catch { console.error('[core-boot] Saved core selection could not be verified; public listeners remain stopped.'); process.exitCode = 1; }
}
