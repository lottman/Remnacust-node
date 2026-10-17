const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
const { createHash } = require('node:crypto');
const source = require('node:fs').readFileSync(path.join(__dirname, '../src/modules/xray-core/quota-ledger.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const ref = { exports: {} };
new Function('require', 'module', 'exports', compiled)(require, ref, ref.exports);
const { prepareQuotaLedger, verifyQuotaLedger, readQuotaJournal, QUOTA_RESERVE_VERSION } = ref.exports;
const { QUOTA_REGISTRATION_VERSION } = ref.exports;
const { QUOTA_WATERMARK_VERSION } = ref.exports;

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remnacust-quota-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.chmod(root, 0o700);
    return path.join(root, 'quota', 'ledger.json');
}

test('first activation flushes private empty state and repeated preparation never resets it', async t => {
    const file = await fixture(t);
    await prepareQuotaLedger(false, file);
    const first = await fs.readFile(file, 'utf8');
    const envelope = JSON.parse(first);
    assert.equal(envelope.payload.version, QUOTA_RESERVE_VERSION);
    assert.deepEqual(envelope.payload.entries, {});
    assert.equal(envelope.sha256, createHash('sha256').update(JSON.stringify(envelope.payload)).digest('hex'));
    await prepareQuotaLedger(true, file);
    assert.equal(await fs.readFile(file, 'utf8'), first);
});

test('active ledger loss and corruption fail closed without recreating credit', async t => {
    const file = await fixture(t);
    await assert.rejects(prepareQuotaLedger(true, file), { code: 'ENOENT' });
    await prepareQuotaLedger(false, file);
    await fs.writeFile(file, '{"payload":{"version":"bad","entries":{}},"sha256":"bad"}');
    await assert.rejects(prepareQuotaLedger(true, file), /integrity/);
    await assert.rejects(prepareQuotaLedger(false, file), /integrity/);
    assert.match(await fs.readFile(file, 'utf8'), /"version":"bad"/);
});

test('valid Go checkpoint is verified without rounding BIGINT counters through JavaScript', async t => {
    const file = await fixture(t);
    await prepareQuotaLedger(false, file);
    const payload = '{"instance":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","version":"remnacust-quota-reserves-v1","entries":{"11111111-1111-4111-8111-111111111111":{"group":"host:one","owner":"123","expiresAt":253402300799000,"ceiling":9223372036854775807,"reserved":9007199254740993}},"retiredBefore":123}';
    await fs.writeFile(file, `{"payload":${payload},"sha256":"${createHash('sha256').update(payload).digest('hex')}"}`);
    await verifyQuotaLedger(file);
    await fs.appendFile(file, 'broken');
    await assert.rejects(verifyQuotaLedger(file));
});

test('oversized and public ledgers are rejected', async t => {
    const file = await fixture(t);
    await prepareQuotaLedger(false, file);
    if (process.platform !== 'win32') {
        await fs.chmod(file, 0o644);
        await assert.rejects(verifyQuotaLedger(file), /private/);
        await fs.chmod(file, 0o600);
    }
    const handle = await fs.open(file, 'r+');
    await handle.truncate(16 * 1024 * 1024 + 1);
    await handle.close();
    await assert.rejects(verifyQuotaLedger(file), /bounded/);
});

test('symlink ledgers cannot redirect initialization', { skip: process.platform === 'win32' }, async t => {
    const file = await fixture(t);
    await fs.mkdir(path.dirname(file), { mode: 0o700 });
    const other = file + '.outside';
    await fs.writeFile(other, 'unchanged', { mode: 0o600 });
    await fs.symlink(other, file);
    await assert.rejects(prepareQuotaLedger(false, file), /private/);
    assert.equal(await fs.readFile(other, 'utf8'), 'unchanged');
});

test('incremental journal records require intact checksums and consecutive sequences', async t => {
    const file = await fixture(t);
    await prepareQuotaLedger(false, file);
    const base = await fs.readFile(file, 'utf8');
    const record = sequence => {
        const payload = JSON.stringify({ instance: JSON.parse(base).payload.instance, version: QUOTA_RESERVE_VERSION, entries: {}, sequence });
        return `{"payload":${payload},"sha256":"${createHash('sha256').update(payload).digest('hex')}"}\n`;
    };
    await fs.appendFile(file, record(1));
    await verifyQuotaLedger(file);
    await fs.appendFile(file, record(1));
    await assert.rejects(verifyQuotaLedger(file), /integrity/);
    await fs.writeFile(file, base + record(1).slice(0, -4));
    await assert.rejects(verifyQuotaLedger(file), /Incomplete/);
    await fs.writeFile(file, base + record(2));
    await assert.rejects(verifyQuotaLedger(file), /integrity/);
});

test('closed grant reports preserve exact charges and cannot be reopened by later records', async t => {
    const file=await fixture(t);await prepareQuotaLedger(false,file);
    const base=await fs.readFile(file,'utf8');const instance=JSON.parse(base).payload.instance;
    const id='11111111-1111-4111-8111-111111111111';
    const frame=(sequence,reserved,closed)=>{
        const payload=JSON.stringify({instance,version:QUOTA_RESERVE_VERSION,sequence,entries:{[id]:{group:'tag:example',owner:'123',expiresAt:253402300799000,ceiling:2000,reserved,closed}}});
        return `{"payload":${payload},"sha256":"${createHash('sha256').update(payload).digest('hex')}"}\n`;
    };
    await fs.appendFile(file,frame(1,1000,false)+frame(2,123,true));
    const report=await readQuotaJournal(file);
    assert.equal(report.instance,instance);assert.equal(report.sequence,2);
    assert.equal(report.entries.get(id).reserved,'123');assert.equal(report.entries.get(id).closed,true);
    await fs.appendFile(file,frame(3,124,false));
    await assert.rejects(readQuotaJournal(file),/Non-monotonic/);
});

test('global quota precision is preserved and cannot change within the same journal binding',async t=>{
    const file=await fixture(t);await prepareQuotaLedger(false,file);const base=await fs.readFile(file,'utf8');const instance=JSON.parse(base).payload.instance,id='11111111-1111-4111-8111-111111111111';
    const frame=(sequence,scale)=>{const payload=JSON.stringify({instance,version:QUOTA_RESERVE_VERSION,sequence,entries:{[id]:{group:'user:global',owner:'123',expiresAt:253402300799000,ceiling:2000,reserved:1,scale}}});return `{"payload":${payload},"sha256":"${createHash('sha256').update(payload).digest('hex')}"}\n`;};
    await fs.appendFile(file,frame(1,1000000000));assert.equal((await readQuotaJournal(file)).entries.get(id).scale,1000000000);
    await fs.appendFile(file,frame(2,100));await assert.rejects(readQuotaJournal(file),/Non-monotonic/);
    await fs.writeFile(file,base+frame(1,101));await assert.rejects(readQuotaJournal(file),/Invalid quota journal entry/);
});

test('registered journal stages, activates and closes exact credit without a protocol downgrade',async t=>{
    const file=await fixture(t);await prepareQuotaLedger(false,file);const base=await fs.readFile(file,'utf8');
    const instance=JSON.parse(base).payload.instance,id='11111111-1111-4111-8111-111111111111';
    const frame=(sequence,entry,version=QUOTA_REGISTRATION_VERSION)=>{
        const payload=JSON.stringify({instance,version,sequence,entries:{[id]:entry}});
        return `{"payload":${payload},"sha256":"${createHash('sha256').update(payload).digest('hex')}"}\n`;
    };
    const stage={group:'user:global',owner:'123',expiresAt:253402300799000,ceiling:2000,reserved:0,scale:1000000000,prepared:true};
    const used={...stage,activated:true,reserved:1000},closed={...used,closed:true,reserved:123};
    await fs.appendFile(file,frame(1,stage)+frame(2,used)+frame(3,closed));
    const report=await readQuotaJournal(file);assert.equal(report.registrationsRequired,true);
    assert.equal(report.entries.get(id).reserved,'123');assert.equal(report.entries.get(id).activated,true);
    for(const [entry,version,error] of [[closed,QUOTA_RESERVE_VERSION,/integrity/],[{...closed,prepared:false},QUOTA_REGISTRATION_VERSION,/registration/],[{...closed,activated:false},QUOTA_REGISTRATION_VERSION,/registration/]]){
        await fs.writeFile(file,base+frame(1,stage)+frame(2,used)+frame(3,closed)+frame(4,entry,version));
        await assert.rejects(readQuotaJournal(file),error);
    }
    await fs.writeFile(file,base+frame(1,{...stage,reserved:1}));await assert.rejects(readQuotaJournal(file),/registration/);
});

test('journal checkpoint and version survive restart and cannot be lowered or exceed durable sequence',async t=>{
    const file=await fixture(t);await prepareQuotaLedger(false,file);
    const base=await fs.readFile(file,'utf8'),instance=JSON.parse(base).payload.instance;
    const frame=(sequence,checkpoint,version=QUOTA_WATERMARK_VERSION)=>{
        const payload=JSON.stringify({instance,version,sequence,checkpoint,entries:{}});
        return `{"payload":${payload},"sha256":"${createHash('sha256').update(payload).digest('hex')}"}\n`;
    };
    await fs.appendFile(file,frame(1,0)+frame(2,1));
    const state=await readQuotaJournal(file);assert.equal(state.watermarksRequired,true);assert.equal(state.checkpoint,1);assert.equal(state.sequence,2);
    for(const tail of [frame(3,0),frame(3,4),frame(3,1,QUOTA_REGISTRATION_VERSION)]){
        await fs.writeFile(file,base+frame(1,0)+frame(2,1)+tail);await assert.rejects(readQuotaJournal(file),/checkpoint|integrity/);
    }
});
