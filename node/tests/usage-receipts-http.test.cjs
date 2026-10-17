require('reflect-metadata');
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const ts=require('typescript');const {createRequire}=require('node:module');
const nest=require('@nestjs/common');const {NestFactory}=require('@nestjs/core');const {PassportModule}=require('@nestjs/passport');const jwt=require('jsonwebtoken');
function load(relative,mocks={}){const filename=path.join(__dirname,'../src',relative);const local=createRequire(filename);const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true,emitDecoratorMetadata:true,esModuleInterop:true}}).outputText;const ref={exports:{}};new Function('require','module','exports',code)(id=>Object.hasOwn(mocks,id)?mocks[id]:id.startsWith('.')&&fs.existsSync(path.resolve(path.dirname(filename),id+'.ts'))?load(path.relative(path.join(__dirname,'../src'),path.resolve(path.dirname(filename),id+'.ts')),mocks):local(id),ref,ref.exports);return ref.exports;}

test('the real HTTP route rejects missing, expired, forged and wrong-algorithm JWT before touching node state',async()=>{
    const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
    const other=crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
    class Config{} class Process{}
    const {JwtDefaultGuard}=load('common/guards/jwt-guards/def-jwt-guard.ts');
    const {JwtStrategy}=load('common/guards/jwt-guards/strategies/validate-token.ts',{'@common/config/app-config/typed-config.service':{TypedConfigService:Config}});
    const model=load('modules/xray-core/usage-receipt.ts');let journalReads=0;let recovery=null;
    const {UsageReceiptController}=load('modules/xray-core/usage-receipt.controller.ts',{'@common/config/app-config':{TypedConfigService:Config},'@common/guards/jwt-guards':{JwtDefaultGuard},'./xray-process.service':{XrayProcessService:Process},'./quota-recovery-fence':{...load('modules/xray-core/quota-recovery-fence.ts'),readRecoveryFence:async()=>recovery},'./quota-ledger':{verifyQuotaLedger:async()=>{journalReads++;throw Error('isolated HTTP fixture has no production ledger');}},'./usage-receipt':model});
    class FixtureModule{}
    const config={getOrThrow:key=>{assert.equal(key,'JWT_PUBLIC_KEY');return publicKey;}};
    nest.Module({imports:[PassportModule.register({defaultStrategy:'registeredUserJWT'})],controllers:[UsageReceiptController],providers:[{provide:Config,useValue:config},{provide:Process,useValue:{getStatus:async()=>({up:false,pid:null})}},{provide:JwtStrategy,useFactory:()=>new JwtStrategy(config)}]})(FixtureModule);
    const app=await NestFactory.create(FixtureModule,{logger:false});
    try{
        await app.listen(0,'127.0.0.1');const base=await app.getUrl();
        const request=async(token,body,extraHeaders={})=>fetch(base+'/xray/usage-receipts',{method:'POST',headers:{'content-type':'application/json',...extraHeaders,...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
        const body={action:'sample',stream:'6bde8fbb-6d28-4d50-99a2-28074f3c235b',sequence:'1',coreProcessId:'ff29ee68-a625-4160-9573-cc17de317a5d'};
        const invalid=[null,'broken',jwt.sign({sub:'panel'},other.privateKey,{algorithm:'RS256',expiresIn:60}),jwt.sign({sub:'panel'},privateKey,{algorithm:'RS256',expiresIn:-60}),jwt.sign({sub:'panel'},'isolated-hmac-fixture',{algorithm:'HS256',expiresIn:60})];
        for(const token of invalid){const response=await request(token,body);assert.equal(response.status,401);await response.arrayBuffer();}
        assert.equal(journalReads,0,'invalid authentication must not read or reset usage');
        const valid=jwt.sign({sub:'panel'},privateKey,{algorithm:'RS256',expiresIn:60});
        for(const invalidBody of [{...body,sequence:1},{...body,action:'reset'},{...body,extra:true}]){const response=await request(valid,invalidBody);assert.equal(response.status,400);await response.arrayBuffer();}
        assert.equal(journalReads,0,'validation precedes journal access');
        const authorized=await request(valid,body);assert.equal(authorized.status,503);const response=await authorized.json();assert.match(response.message,/retry the same request/);assert.equal(journalReads,1);
        recovery={state:'FENCED',generation:crypto.randomUUID(),digest:'a'.repeat(64)};
        const ack={...body,action:'ack',digest:'b'.repeat(64)};
        let denied=await request(valid,ack);assert.equal(denied.status,503);await denied.arrayBuffer();assert.equal(journalReads,1);
        recovery={...recovery,state:'RELEASED'};
        denied=await request(valid,ack);assert.equal(denied.status,503);await denied.arrayBuffer();assert.equal(journalReads,1);
        const proof=['v1',recovery.generation,recovery.digest,body.coreProcessId,body.stream].join(':');
        const bound=await request(valid,ack,{'x-remnacust-recovery-proof':proof});assert.equal(bound.status,503);await bound.arrayBuffer();assert.equal(journalReads,2,'a valid HTTP binding reaches the isolated journal verifier');
        const recoveryBody={generation:crypto.randomUUID(),requestId:crypto.randomUUID(),coreProcessId:body.coreProcessId,instance:body.stream,previous:'a'.repeat(64),decisionDigest:'d'.repeat(64),sourceDigest:'e'.repeat(64),receipt:ack};
        const recover=(token,value)=>fetch(base+'/xray/usage-receipts/recovery-ack',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(value)});
        for(const token of invalid){const r=await recover(token,recoveryBody);assert.equal(r.status,401);await r.arrayBuffer();}
        let r=await recover(valid,{...recoveryBody,extra:true});assert.equal(r.status,400);await r.arrayBuffer();
        r=await recover(valid,recoveryBody);assert.equal(r.status,503);await r.arrayBuffer();assert.equal(journalReads,2,'stopped recovery context never touches or acknowledges a journal');
        const sampling={generation:recoveryBody.generation,requestId:crypto.randomUUID(),coreProcessId:body.coreProcessId,instance:body.stream,previous:'a'.repeat(64),preparationDigest:'b'.repeat(64),sourceDigest:'c'.repeat(64),retainedDigest:null,prior:{sequence:'1',digest:'d'.repeat(64)},receipt:{...body,sequence:'2'}};
        const prepared=(token,value)=>fetch(base+'/xray/usage-receipts/recovery-sample',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(value)});
        for(const token of invalid){const r=await prepared(token,sampling);assert.equal(r.status,401);await r.arrayBuffer();}
        r=await prepared(valid,{...sampling,extra:true});assert.equal(r.status,400);await r.arrayBuffer();
        r=await prepared(valid,sampling);assert.equal(r.status,503);await r.arrayBuffer();assert.equal(journalReads,2,'stopped prepared sampling never resets or reads a journal');
        const inspect=(token,value)=>fetch(base+'/xray/usage-receipts/recovery-quiescence',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(value)});
        for(const token of invalid){const result=await inspect(token,{});assert.equal(result.status,401);await result.arrayBuffer();}
        const badInspect=await inspect(valid,{extra:true});assert.equal(badInspect.status,400);await badInspect.arrayBuffer();
        const stoppedInspect=await inspect(valid,sampling);assert.equal(stoppedInspect.status,503);await stoppedInspect.arrayBuffer();assert.equal(journalReads,2);
    } finally {await app.close();}
});
