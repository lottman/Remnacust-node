// Run explicitly against a locally built core. Opens loopback test listeners only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const ts = require('typescript');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const { X509Certificate } = require('node:crypto');
const { XtlsApi } = require('@remnawave/xtls-sdk');
const audit = process.env.REMNACUST_TEST_OUTPUT_DIR || path.resolve(__dirname, '../../../core-update-20261001');
const binary = process.env.REMNACUST_TEST_CORE;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function loadHelper() {
    const filename = path.resolve(__dirname, '../src/modules/handler/masque-user.ts');
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const mod = { exports: {} };
    new Function('require','module','exports', output)(createRequire(filename),mod,mod.exports);
    return mod.exports.addMasqueUser;
}
async function port() {
    const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const result = server.address().port; await new Promise(resolve => server.close(resolve)); return result;
}
function start(t, name, config) {
    const file = path.join(audit, name+'.json'); fs.writeFileSync(file, JSON.stringify(config));
    const child = spawn(binary, ['run','-config',file], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
    t.after(() => child.kill());
    t.after(() => fs.writeFileSync(path.join(audit,name+'.log'),output));
    return { child, output: () => output };
}

for (const alpn of ['h2', 'h3']) test(`MASQUE ${alpn} account crosses real gRPC, forwards TCP and revokes an active tunnel`, { skip: !binary, timeout: 30000 }, async t => {
    const apiPort = await port(), masquePort = await port(), localPort = await port();
    const echo = net.createServer(conn => { conn.on('error', () => {}); conn.pipe(conn); }); echo.listen(0,'127.0.0.1'); await once(echo,'listening');
    t.after(() => echo.close());
    const server = start(t,`masque-server-${alpn}-smoke`, {
        log: { loglevel: 'warning' }, api: { tag:'api', listen:`127.0.0.1:${apiPort}`, services:['HandlerService','StatsService'] }, stats:{},
        policy:{levels:{'0':{statsUserUplink:true,statsUserDownlink:true}}},
        inbounds:[{tag:'MASQUE',listen:'127.0.0.1',port:masquePort,protocol:'masque',settings:{address:['10.199.0.1/24'],clients:[]},streamSettings:{network:'masque',security:'tls',masqueSettings:{path:'/test/ip/'},tlsSettings:{alpn:['h2','h3'],certificates:[{certificate:fs.readFileSync(path.join(audit,'smoke-cert.pem'),'utf8').trim().split('\n'),key:fs.readFileSync(path.join(audit,'smoke-key.pem'),'utf8').trim().split('\n')}]}}}],
        outbounds:[{protocol:'freedom',tag:'direct',settings:{redirect:`127.0.0.1:${echo.address().port}`}}],
    });
    const api = new XtlsApi({ connectionUrl:`127.0.0.1:${apiPort}` }); t.after(() => api.channel.close());
    let ready = false;
    for (let i=0;i<50;i++) { const count = await api.handler.getInboundUsersCount('MASQUE'); if (count.isOk) {ready=true;break;} if (server.child.exitCode !== null) break; await pause(100); }
    assert.ok(ready, server.output());
    const add = loadHelper();
    const username = '42~aaaaaaaaaaaaaaaaaaaaaaaa', password = '44444444-4444-4444-8444-444444444444';
    assert.equal((await add(api,{tag:'MASQUE',username,password})).isOk,true);
    assert.equal((await api.handler.getInboundUsersCount('MASQUE')).data,1);
    assert.equal((await add(api,{tag:'MASQUE',username,password})).isOk,false);
    assert.equal((await add(api,{tag:'wrong-inbound',username,password})).isOk,false);
    const client = start(t,`masque-client-${alpn}-smoke`,{
        log:{loglevel:'warning'},
        inbounds:[{listen:'127.0.0.1',port:localPort,protocol:'dokodemo-door',settings:{address:'10.199.0.1',port:echo.address().port,network:'tcp'}}],
        outbounds:[{protocol:'masque',settings:{address:'127.0.0.1',port:masquePort},streamSettings:{network:'masque',security:'tls',masqueSettings:{path:'/test/ip/',user:username,pass:password},tlsSettings:{alpn:[alpn],serverName:'localhost',pinnedPeerCertSha256:new X509Certificate(fs.readFileSync(path.join(audit,'smoke-cert.pem'))).fingerprint256}}}],
    });
    let socket;
    for (let i=0;i<40;i++) {
        socket=net.connect(localPort,'127.0.0.1');
        try {await once(socket,'connect'); break;} catch {socket.destroy();socket=null;await pause(100);}
    }
    assert.ok(socket,client.output()); t.after(() => socket.destroy());
    socket.setTimeout(5000,() => socket.destroy(new Error('MASQUE echo timed out')));
    const data=once(socket,'data');socket.write('remnacust-masque-smoke');
    assert.equal((await data)[0].toString(),'remnacust-masque-smoke');
    const closed=once(socket,'close');
    assert.equal((await api.handler.removeUser('MASQUE',username)).isOk,true);
    await closed;
    assert.equal((await api.handler.getInboundUsersCount('MASQUE')).data,0);
    assert.equal((await add(api,{tag:'MASQUE',username,password})).isOk,true);
    assert.equal((await api.handler.getInboundUsersCount('MASQUE')).data,1);
    assert.equal((await api.handler.removeUser('MASQUE',username)).isOk,true);
});
