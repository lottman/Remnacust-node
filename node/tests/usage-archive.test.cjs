require('reflect-metadata');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),ts=require('typescript');
const {createRequire}=require('node:module');
function load(relative,mocks={}){const file=path.join(__dirname,'../src',relative),ref={exports:{}},local=createRequire(file);const code=ts.transpileModule(require('node:fs').readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,experimentalDecorators:true,emitDecoratorMetadata:true,esModuleInterop:true}}).outputText;new Function('require','module','exports',code)(id=>Object.hasOwn(mocks,id)?mocks[id]:local(id),ref,ref.exports);return ref.exports;}
const helpers=load('modules/xray-core/usage-archive.ts');
const request=()=>({generation:crypto.randomUUID(),requestId:crypto.randomUUID()});
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'usage-archive-'));await fs.chmod(root,0o700);t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:30}));return {root,file:path.join(root,'receipt.json')};}

test('archive capture preserves original bytes, including corrupt or empty files, without sampling, ACK or writes',async t=>{
 const {root,file}=await fixture(t),decode=envelope=>JSON.parse(require('node:zlib').gunzipSync(Buffer.from(envelope.data,'base64')));
 assert.equal(decode(await helpers.captureUsageArchive(request(),file)).journal,null);
 for(const original of [Buffer.alloc(0),Buffer.from('corrupt-native-journal'),Buffer.from('REMNACUST-USAGE-1\noriginal bytes\n')]){
  await fs.writeFile(file,original,{mode:0o600});const before=await fs.readdir(root),body=request(),result=decode(await helpers.captureUsageArchive(body,file));
  assert.equal(result.generation,body.generation);assert.equal(result.requestId,body.requestId);
  assert.equal(result.journal.bytes,original.length);assert.equal(result.journal.sha256,crypto.createHash('sha256').update(original).digest('hex'));
  assert.deepEqual(Buffer.from(result.journal.data,'base64'),original);assert.deepEqual(await fs.readFile(file),original);assert.deepEqual(await fs.readdir(root),before);
 }
});

test('unsafe, oversized and nonregular outbox paths are refused before opening',async t=>{
 const {root,file}=await fixture(t);await fs.mkdir(file);await assert.rejects(helpers.readUsageArchiveFile(file));await fs.rmdir(file);
 const handle=await fs.open(file,'w',0o600);await handle.truncate(helpers.USAGE_JOURNAL_MAX_BYTES+1);await handle.close();await assert.rejects(helpers.readUsageArchiveFile(file));await fs.unlink(file);
 if(process.platform!=='win32'){
  const target=path.join(root,'target');await fs.writeFile(target,'private',{mode:0o600});await fs.symlink(target,file);await assert.rejects(helpers.readUsageArchiveFile(file));await fs.unlink(file);
  await fs.writeFile(file,'private',{mode:0o644});await assert.rejects(helpers.readUsageArchiveFile(file));await fs.chmod(file,0o600);
  await fs.chmod(root,0o755);await assert.rejects(helpers.readUsageArchiveFile(file));await fs.chmod(root,0o700);
  await fs.unlink(file);require('node:child_process').execFileSync('mkfifo',[file]);await assert.rejects(helpers.readUsageArchiveFile(file));
 }
});

test('atomic outbox replacement returns one whole generation or an explicit retry, never mixed bytes',async t=>{
 const {root,file}=await fixture(t),values=[Buffer.alloc(65536,65),Buffer.alloc(65536,66)];await fs.writeFile(file,values[0],{mode:0o600});
 for(let n=0;n<15;n++){
  const temporary=path.join(root,'next');await fs.writeFile(temporary,values[(n+1)%2],{mode:0o600});
  const result=await Promise.allSettled([helpers.readUsageArchiveFile(file),fs.rename(temporary,file)]);
  assert.equal(result[1].status,'fulfilled');if(result[0].status==='fulfilled')assert(values.some(value=>value.equals(result[0].value)));else assert.match(result[0].reason.message,/changed/);
 }
});

test('real RSA JWT route validates before reading and archives while no Xray process service exists',async t=>{
 const {file}=await fixture(t);await fs.writeFile(file,'native-file-fixture',{mode:0o600});
 const nest=require('@nestjs/common'),{NestFactory}=require('@nestjs/core'),{PassportModule}=require('@nestjs/passport'),jwt=require('jsonwebtoken');
 const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 class Config{}let reads=0;
 const {JwtDefaultGuard}=load('common/guards/jwt-guards/def-jwt-guard.ts');
 const {JwtStrategy}=load('common/guards/jwt-guards/strategies/validate-token.ts',{'@common/config/app-config/typed-config.service':{TypedConfigService:Config}});
 const {UsageArchiveController}=load('modules/xray-core/usage-archive.controller.ts',{'@common/guards/jwt-guards':{JwtDefaultGuard},'./usage-archive':{...helpers,captureUsageArchive:async body=>{reads++;return helpers.captureUsageArchive(body,file);}}});
 const config={getOrThrow:()=>keys.publicKey};class Root{};
 nest.Module({imports:[PassportModule.register({defaultStrategy:'registeredUserJWT'})],controllers:[UsageArchiveController],providers:[{provide:Config,useValue:config},{provide:JwtStrategy,useFactory:()=>new JwtStrategy(config)}]})(Root);
 const app=await NestFactory.create(Root,{logger:false});
 try{await app.listen(0,'127.0.0.1');const base=await app.getUrl(),body=request();
  const send=(token,data=body)=>fetch(base+'/xray/usage-receipts/archive',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});
  for(const token of [null,'broken',jwt.sign({},keys.privateKey,{algorithm:'RS256',expiresIn:-1}),jwt.sign({},'fixture',{algorithm:'HS256'})]){const response=await send(token);assert.equal(response.status,401);await response.arrayBuffer();}
  const valid=jwt.sign({},keys.privateKey,{algorithm:'RS256',expiresIn:60});
  for(const data of [{},{...body,file:'/etc/shadow'},{...body,generation:'bad'}]){const response=await send(valid,data);assert.equal(response.status,400);await response.arrayBuffer();}
  assert.equal(reads,0);const response=await send(valid);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await response.json()).response.encoding,'gzip-base64');assert.equal(reads,1);assert.equal(await fs.readFile(file,'utf8'),'native-file-fixture');
 }finally{await app.close();}
});
