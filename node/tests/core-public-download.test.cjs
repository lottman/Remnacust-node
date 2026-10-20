const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const {createRequire}=require('node:module');
const filename=path.join(__dirname,'../src/modules/xray-core/managed-core.store.ts');
const local=createRequire(filename),ref={exports:{}};
new Function('require','module','exports',ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>id.startsWith('.')||id.startsWith('@')?{}:local(id),ref,ref.exports);
const {validateCoreRelease,resolveCoreDownloadUrl}=ref.exports;
const arch=process.arch==='x64'?'amd64':process.arch;
const release={build:'1.1.9',arch,sha256:'a'.repeat(64),url:`https://github.com/lottman/Remnacust-core/releases/download/v1.1.9/remnacust-core-1.1.9-linux-${arch}`};
test('default installs accept the pinned public repository without a host env override',()=>{
 const before=process.env.REMNACUST_CORE_ALLOWED_HOSTS;
 try {
  delete process.env.REMNACUST_CORE_ALLOWED_HOSTS;
  assert.doesNotThrow(()=>validateCoreRelease(release));
  for(const url of [release.url.replace('/lottman/','/other/'),release.url+'?download=1',release.url.replace('github.com','github.com.evil.test'),release.url.replace('https:','http:'),release.url.replace('v1.1.9/','v1.1.8/')])assert.throws(()=>validateCoreRelease({...release,url}),/not permitted/);
  assert.throws(()=>validateCoreRelease({...release,sha256:'bad'}),/metadata/);
  assert.throws(()=>validateCoreRelease({...release,arch:'other'}),/not permitted/);
  process.env.REMNACUST_CORE_ALLOWED_HOSTS='custom.example';
  assert.throws(()=>validateCoreRelease(release),/not permitted/);
  assert.doesNotThrow(()=>validateCoreRelease({...release,url:'https://custom.example/core'}));
  process.env.REMNACUST_CORE_ALLOWED_HOSTS='';
  assert.throws(()=>validateCoreRelease(release),/not permitted/);
 }finally{if(before===undefined)delete process.env.REMNACUST_CORE_ALLOWED_HOSTS;else process.env.REMNACUST_CORE_ALLOWED_HOSTS=before}
});
test('GitHub redirects only resolve to its exact HTTPS asset storage, without sending headers',async()=>{
 let cancelled=false,calls=0;
 const target='https://release-assets.githubusercontent.com/github-production-release-asset/123/456?signature=fixture';
 const request=async(url,options)=>{
  calls++;assert.equal(url,release.url);assert.equal(options.redirect,'manual');assert.equal(options.headers,undefined);
  return new Response(new ReadableStream({cancel(){cancelled=true}}),{status:302,headers:{location:target}});
 };
 assert.equal(await resolveCoreDownloadUrl(release,request),target);
 assert.equal(calls,1);assert.equal(cancelled,true);
 for(const location of ['http://release-assets.githubusercontent.com/github-production-release-asset/a','https://evil.test/a','https://release-assets.githubusercontent.com.evil.test/github-production-release-asset/a','https://release-assets.githubusercontent.com/other/a','https://user:pass@release-assets.githubusercontent.com/github-production-release-asset/a']){
  await assert.rejects(resolveCoreDownloadUrl(release,async()=>new Response(null,{status:302,headers:{location}})),/not permitted/);
 }
 await assert.rejects(resolveCoreDownloadUrl(release,async()=>new Response(null,{status:404})),/404/);
 await assert.rejects(resolveCoreDownloadUrl(release,async()=>new Response(null,{status:302})),/missing/);
 assert.equal(await resolveCoreDownloadUrl(release,async()=>new Response(null,{status:200})),release.url);
 assert.equal(await resolveCoreDownloadUrl({...release,url:'https://custom.example/core'},()=>assert.fail('custom sources must not resolve redirects')),'https://custom.example/core');
});
