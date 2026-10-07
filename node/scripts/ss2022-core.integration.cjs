// Explicit native-core integration: loopback only, no production state.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { XtlsApi } = require('@remnawave/xtls-sdk');
const binary = process.env.REMNACUST_TEST_CORE;
const audit = process.env.REMNACUST_TEST_OUTPUT_DIR || path.resolve(__dirname,'../../../core-update-20261001');
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
async function freePort() {
    const server=net.createServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
    const port=server.address().port; await new Promise(resolve=>server.close(resolve)); return port;
}
function core(t,name,config) {
    const file=path.join(audit,name+'.json'); fs.writeFileSync(file,JSON.stringify(config));
    const child=spawn(binary,['run','-config',file],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output=''; child.stdout.on('data',d=>output+=d); child.stderr.on('data',d=>output+=d);
    t.after(()=>{child.kill();fs.writeFileSync(path.join(audit,name+'.log'),output);});
    return { child, output:()=>output };
}
for(const bytes of [16,32]) test(`SS2022 AES-${bytes*8} account crosses real gRPC and forwards TCP`,{skip:!binary,timeout:30000},async t=>{
    const apiPort=await freePort(), ssPort=await freePort(), clientPort=await freePort();
    const echo=net.createServer(conn=>{conn.on('error',()=>{});conn.pipe(conn);});
    echo.listen(0,'127.0.0.1');await once(echo,'listening');t.after(()=>echo.close());
    const method=`2022-blake3-aes-${bytes*8}-gcm`;
    const serverKey=Buffer.alloc(bytes,7).toString('base64');
    const credential=Buffer.from('12345678901234567890123456789012');
    const userKey=(bytes===16?createHash('sha256').update(credential).digest():credential).subarray(0,bytes).toString('base64');
    const username='42~aaaaaaaaaaaaaaaaaaaaaaaa';
    const server=core(t,`ss2022-${bytes}-server`,{
        log:{loglevel:'debug'},api:{tag:'api',listen:`127.0.0.1:${apiPort}`,services:['HandlerService']},
        inbounds:[{tag:'SS',listen:'127.0.0.1',port:ssPort,protocol:'shadowsocks',settings:{method,password:serverKey,clients:[],network:'tcp'}}],
        outbounds:[{protocol:'freedom',tag:'direct',settings:{redirect:`127.0.0.1:${echo.address().port}`,finalRules:[{action:'allow',ip:['127.0.0.1/32']}]}}],
    });
    const api=new XtlsApi({connectionUrl:`127.0.0.1:${apiPort}`});t.after(()=>api.channel.close());
    let ready=false;
    for(let i=0;i<50;i++){if((await api.handler.getInboundUsersCount('SS')).isOk){ready=true;break;}if(server.child.exitCode!==null)break;await pause(100);}
    assert.ok(ready,server.output());
    const result=await api.handler.addShadowsocks2022User({tag:'SS',username,key:userKey,level:0});
    assert.ok(result.isOk,result.message);
    assert.equal((await api.handler.getInboundUsersCount('SS')).data,1);
    const client=core(t,`ss2022-${bytes}-client`,{
        log:{loglevel:'debug'},
        inbounds:[{listen:'127.0.0.1',port:clientPort,protocol:'dokodemo-door',settings:{address:'192.0.2.1',port:443,network:'tcp'}}],
        outbounds:[{protocol:'shadowsocks',settings:{servers:[{address:'127.0.0.1',port:ssPort,method,password:`${serverKey}:${userKey}`} ]}}],
    });
    let socket;
    for(let i=0;i<40;i++){socket=net.connect(clientPort,'127.0.0.1');try{await once(socket,'connect');break;}catch{socket.destroy();socket=null;await pause(100);}}
    assert.ok(socket,client.output());t.after(()=>socket.destroy());
    socket.setTimeout(5000,()=>socket.destroy(new Error('SS2022 echo timed out')));
    const data=once(socket,'data');socket.write('remnacust-ss2022');
    assert.equal((await data)[0].toString(),'remnacust-ss2022');
    const closed=once(socket,'close');
    assert.equal((await api.handler.removeUser('SS',username)).isOk,true);
    await closed;
    assert.equal((await api.handler.getInboundUsersCount('SS')).data,0);
});
