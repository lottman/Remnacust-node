const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');
const path=require('node:path');const os=require('node:os');const ts=require('typescript');
const sync=require('node:fs');const file=path.join(__dirname,'../src/modules/xray-core/port-plan-state.ts');
const ref={exports:{}};new Function('require','module','exports',ts.transpileModule(sync.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(require,ref,ref.exports);
const {PortPlanStateStore,parsePortPlanState}=ref.exports;
const {StartXrayCommand}=require('../libs/contract/build/commands/xray/start.command.js');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'remnacust-port-plan-'));await fs.chmod(root,0o700);
    t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:50}));const filename=path.join(root,'core/port-plan-state.json');return {root,filename,store:new PortPlanStateStore(filename)};}

test('port-plan request validation rejects malformed or overflowing revisions without throwing',()=>{
    const request=revision=>({xrayConfig:{},internals:{hashes:{emptyConfig:'x',inbounds:[]},portPlan:{revision,enabled:true}}});
    for(const revision of ['invalid','','0','01','-1','1.5','1e2','9223372036854775808','9'.repeat(100)]){
        let result;assert.doesNotThrow(()=>result=StartXrayCommand.RequestSchema.safeParse(request(revision)));
        assert.equal(result.success,false);
    }
    assert.equal(StartXrayCommand.RequestSchema.safeParse(request('9223372036854775807')).success,true);
});

test('a port plan persists its requirement before apply; a fresh process rejects old targets and can finish the same one',async t=>{
    const f=await fixture(t);assert.equal(await f.store.read(),null);
    await f.store.begin({revision:'7',enabled:true});let state=await new PortPlanStateStore(f.filename).read();
    assert.deepEqual(state,{version:1,revision:'7',enabled:true,required:true,appliedRevision:null});
    await assert.rejects(f.store.begin({revision:'6',enabled:true}),/older/);
    await assert.rejects(f.store.begin({revision:'7',enabled:false}),/older/);
    const resumed=new PortPlanStateStore(f.filename);await resumed.begin({revision:'7',enabled:true});await resumed.complete({revision:'7',enabled:true});
    state=await resumed.read();assert.equal(state.appliedRevision,'7');assert.equal(state.required,true);
    assert.deepEqual(await fs.readdir(path.dirname(f.filename)),['port-plan-state.json']);
});

test('delivery epochs survive restart and reject old owners even for the same desired revision',async t=>{
    const f=await fixture(t),ownerA='aaaaaaaa-1111-4111-8111-111111111111',ownerB='bbbbbbbb-1111-4111-8111-111111111111';
    const first={revision:'7',enabled:true,delivery:{epoch:'1',owner:ownerA}};
    await f.store.begin(first);await f.store.complete(first);
    const resumed=new PortPlanStateStore(f.filename),second={...first,delivery:{epoch:'2',owner:ownerB}};
    await resumed.begin(second);assert.equal((await resumed.read()).version,2);
    for(const target of [first,{...second,delivery:{epoch:'2',owner:ownerA}},{revision:'7',enabled:true},{...second,revision:'8'}])
        await assert.rejects(resumed.begin(target),/older delivery owner/);
    await assert.rejects(resumed.complete(first),/no longer current/);
    await resumed.complete(second);assert.deepEqual((await new PortPlanStateStore(f.filename).read()).delivery,second.delivery);
    const encoded=JSON.parse(await fs.readFile(f.filename,'utf8'));encoded.version=1;
    assert.throws(()=>parsePortPlanState(JSON.stringify(encoded)),/Invalid saved/);
});

test('delivery request validation rejects malformed counters and owners without throwing',()=>{
    const delivery={epoch:'1',owner:'aaaaaaaa-1111-4111-8111-111111111111'};
    const request=value=>({xrayConfig:{},internals:{hashes:{emptyConfig:'x',inbounds:[]},portPlan:{revision:'7',enabled:true,delivery:value}}});
    for(const epoch of ['0','01','bad','-1','9223372036854775808','9'.repeat(100)]){
        let parsed;assert.doesNotThrow(()=>parsed=StartXrayCommand.RequestSchema.safeParse(request({...delivery,epoch})));assert.equal(parsed.success,false);
    }
    assert.equal(StartXrayCommand.RequestSchema.safeParse(request(delivery)).success,true);
    assert.equal(StartXrayCommand.RequestSchema.safeParse(request({...delivery,owner:'bad'})).success,false);
});

test('plugin dirtiness survives a lost start response and is cleared only by the current applied owner',async t=>{
    const f=await fixture(t),target={revision:'7',enabled:true,delivery:{epoch:'1',owner:'aaaaaaaa-1111-4111-8111-111111111111'}};
    await f.store.begin(target);await f.store.complete(target,'a'.repeat(64));await f.store.markPluginDirty(target);
    const resumed=new PortPlanStateStore(f.filename),next={...target,delivery:{...target.delivery,epoch:'2'}};
    await resumed.begin(next);assert.equal((await resumed.read()).pluginDirty,true);
    assert.equal((await resumed.read()).appliedInputsHash,'a'.repeat(64));
    await assert.rejects(resumed.complete(target,'b'.repeat(64)),/no longer current/);
    await resumed.complete(next,'b'.repeat(64));assert.equal((await resumed.read()).pluginDirty,undefined);
    assert.equal((await resumed.read()).appliedInputsHash,'b'.repeat(64));
});

test('desired input hashes normalize object keys but preserve routing order and integration changes',()=>{
    const {portPlanInputsHash}=ref.exports;
    assert.equal(portPlanInputsHash({a:1,b:2}),portPlanInputsHash({b:2,a:1}));
    assert.notEqual(portPlanInputsHash({rules:['first','second']}),portPlanInputsHash({rules:['second','first']}));
    assert.notEqual(portPlanInputsHash({}, {tls:true}),portPlanInputsHash({}, {tls:false}));
    assert.notEqual(portPlanInputsHash({},undefined,{name:'a'}),portPlanInputsHash({},undefined,{name:'b'}));
});

test('lost disabling ACK retains native support until a current disabling target is really applied',async t=>{
    const f=await fixture(t);await f.store.begin({revision:'1',enabled:true});
    // The first live change may have succeeded without the node's final ACK.
    await new PortPlanStateStore(f.filename).begin({revision:'2',enabled:false});
    assert.equal((await f.store.read()).required,true);
    await f.store.begin({revision:'3',enabled:true});
    await assert.rejects(f.store.complete({revision:'2',enabled:false}),/no longer current/);
    await f.store.complete({revision:'3',enabled:true});await f.store.begin({revision:'4',enabled:false});
    assert.equal((await new PortPlanStateStore(f.filename).read()).required,true);
    await f.store.complete({revision:'4',enabled:false});assert.deepEqual(await f.store.read(),
        {version:1,revision:'4',enabled:false,required:false,appliedRevision:'4'});
});

test('invalid or corrupt port state cannot silently authorize a downgrade',async t=>{
    const f=await fixture(t);await f.store.begin({revision:'1',enabled:true});
    for(const revision of ['0','01','-1','9223372036854775808','1.5','1e2'])await assert.rejects(f.store.begin({revision,enabled:true}),/Invalid/);
    for(const value of ['{}','{broken',JSON.stringify({version:1,revision:'1',enabled:true,required:false,appliedRevision:null}),
        JSON.stringify({version:1,revision:'1',enabled:false,required:true,appliedRevision:'1'}),
        JSON.stringify({version:1,revision:'1',enabled:true,required:true,appliedRevision:'2'})]){
        await fs.writeFile(f.filename,value,{mode:0o600});await assert.rejects(f.store.read());
    }
    assert.throws(()=>parsePortPlanState('null'));
});

test('FIFO, symlink and non-private port state fail promptly without opening an untrusted file',{skip:process.platform==='win32'},async t=>{
    const f=await fixture(t);await fs.mkdir(path.dirname(f.filename),{mode:0o700});
    require('node:child_process').execFileSync('mkfifo',[f.filename]);await assert.rejects(f.store.read(),/regular file/);await fs.unlink(f.filename);
    const other=path.join(f.root,'other');await fs.writeFile(other,'{}',{mode:0o600});await fs.symlink(other,f.filename);
    await assert.rejects(f.store.read(),/regular file/);await fs.unlink(f.filename);
    await f.store.begin({revision:'1',enabled:true});await fs.chmod(f.filename,0o644);await assert.rejects(f.store.read(),/regular file/);
    await fs.chmod(f.filename,0o600);await fs.chmod(path.dirname(f.filename),0o755);await assert.rejects(f.store.read(),/private/);
});
