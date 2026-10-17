const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const syncFs=require('node:fs');const path=require('node:path');const os=require('node:os');const ts=require('typescript');const {createRequire}=require('node:module');
const filename=path.join(__dirname,'../src/modules/xray-core/user-quota.ts'),local=createRequire(filename),ref={exports:{}};const code=ts.transpileModule(syncFs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function('require','module','exports',code)(local,ref,ref.exports);
const {userQuotaRequiredOnDisk,USER_QUOTA_VERSION,USER_QUOTA_CHECKPOINT_HEADER}=ref.exports;
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'remnacust-user-quota-state-'));await fs.chmod(dir,0o700);t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:20}));return {marker:path.join(dir,'required'),checkpoint:path.join(dir,'checkpoint.pb')};}
const checkpoint=header=>header+require('node:crypto').createHash('sha256').update('payload-fixture').digest('hex')+'\npayload-fixture';
test('persistent user quota requirement is recovered from either independent marker or native checkpoint header',async t=>{
    const f=await fixture(t);assert.equal(await userQuotaRequiredOnDisk(f.marker,f.checkpoint),false);
    await fs.writeFile(f.checkpoint,checkpoint('REMNACUST-CORE-STATE-1\n'),{mode:0o600});assert.equal(await userQuotaRequiredOnDisk(f.marker,f.checkpoint),false);
    await fs.writeFile(f.marker,USER_QUOTA_VERSION+'\n',{mode:0o600});assert.equal(await userQuotaRequiredOnDisk(f.marker,f.checkpoint),true);
    await fs.unlink(f.marker);await fs.writeFile(f.checkpoint,checkpoint(USER_QUOTA_CHECKPOINT_HEADER),{mode:0o600});assert.equal(await userQuotaRequiredOnDisk(f.marker,f.checkpoint),true);
});
test('corrupt requirement and unknown checkpoint cannot silently authorize an incompatible downgrade',async t=>{
    const f=await fixture(t);await fs.writeFile(f.marker,'broken',{mode:0o600});await assert.rejects(userQuotaRequiredOnDisk(f.marker,f.checkpoint),/Unknown user quota requirement/);
    await fs.unlink(f.marker);await fs.writeFile(f.checkpoint,'REMNACUST-CORE-STATE-3\n'+'0'.repeat(64)+'\n',{mode:0o600});await assert.rejects(userQuotaRequiredOnDisk(f.marker,f.checkpoint),/Unknown private checkpoint/);
    await fs.writeFile(f.checkpoint,checkpoint(USER_QUOTA_CHECKPOINT_HEADER)+'corruption',{mode:0o600});await assert.rejects(userQuotaRequiredOnDisk(f.marker,f.checkpoint),/integrity check/);
});
test('a FIFO or symlink requirement is rejected before opening',{skip:process.platform!=='linux'},async t=>{
    const f=await fixture(t);require('node:child_process').execFileSync('mkfifo',[f.marker]);await assert.rejects(userQuotaRequiredOnDisk(f.marker,f.checkpoint),/private regular file/);await fs.unlink(f.marker);
    await fs.writeFile(f.checkpoint,checkpoint(USER_QUOTA_CHECKPOINT_HEADER),{mode:0o600});await fs.symlink(f.checkpoint,f.marker);await assert.rejects(userQuotaRequiredOnDisk(f.marker,f.checkpoint),/private regular file/);
});
