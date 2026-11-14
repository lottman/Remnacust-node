const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { HashedSet } = createRequire('/opt/app/dist/main.js')('@remnawave/hashed-set');
const read = (name) => fs.readFileSync('/test/' + name);
const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600, sub: 'cold-start-test' }),
).toString('base64url');
const content = header + '.' + payload;
const token =
    content +
    '.' +
    crypto.sign('RSA-SHA256', Buffer.from(content), read('jwt.key')).toString('base64url');
function request(path, data) {
    return new Promise((resolve, reject) => {
        const body = data === undefined ? null : JSON.stringify(data);
        const req = https.request(
            {
                hostname: '127.0.0.1',
                port: 2222,
                path,
                method: body === null ? 'GET' : 'POST',
                ca: read('ca.crt'),
                cert: read('node.crt'),
                key: read('node.key'),
                headers: {
                    Authorization: 'Bearer ' + token,
                    ...(body === null
                        ? {}
                        : {
                              'Content-Type': 'application/json',
                              'Content-Length': Buffer.byteLength(body),
                          }),
                },
                timeout: 65000,
            },
            (res) => {
                let result = '';
                res.on('data', (chunk) => {
                    result += chunk;
                    if (result.length > 1000000) req.destroy(Error('oversized response'));
                });
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode, data: JSON.parse(result) });
                    } catch (error) {
                        reject(error);
                    }
                });
            },
        );
        req.on('error', reject);
        req.on('timeout', () => req.destroy(Error('request timeout')));
        req.end(body);
    });
}
const statsPath = '/node/stats/get-system-stats';
async function assertHealthReady(ready) {
    const result = await request('/node/xray/healthcheck');
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.data.response.isAlive, true);
    assert.equal(result.data.response.xrayInternalStatusCached, ready);
}
const coreId = () => {
    const status = execFileSync('/command/s6-svstat', ['-o', 'up,pid', '/run/service/xray'], {
        timeout: 2000,
    })
        .toString()
        .trim();
    assert.match(status, /^true [1-9][0-9]*$/);
    const pid = status.split(' ')[1];
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    return (
        pid +
        ':' +
        stat
            .slice(stat.lastIndexOf(')') + 2)
            .trim()
            .split(/\s+/)[19]
    );
};
async function leaveOrphanSocket() {
    const socket = fs.readFileSync('/run/s6/container_environment/XTLS_API_SOCKET_PATH', 'utf8');
    if (fs.existsSync(socket)) return;
    const child = spawn(
        process.execPath,
        [
            '-e',
            'const net=require("node:net"),fs=require("node:fs");net.createServer().listen(process.argv[1],()=>{fs.chmodSync(process.argv[1],0o600);process.stdout.write("ready");});',
            socket,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('orphan socket fixture timed out')), 5000);
            child.once('error', (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.stdout.once('data', () => {
                clearTimeout(timer);
                resolve();
            });
        });
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;
        assert(fs.lstatSync(socket).isSocket());
    } finally {
        child.kill('SIGKILL');
    }
}

async function main() {
    if (process.argv[2] === 'restored') return verifyRestored();
    await assertHealthReady(false);
    for (let attempt = 0; attempt < 3; attempt++) {
        assert.equal((await request(statsPath)).status, 503);
        assert.equal(
            (
                await request('/node/handler/remove-user', {
                    username: '1',
                    hashData: { vlessUuid: '00000000-0000-4000-8000-000000000001' },
                })
            ).status,
            503,
        );
    }
    const users = new HashedSet();
    const clients = Array.from({ length: 2788 }, (_, index) => {
        const id = crypto.randomUUID();
        users.add(id);
        return { id, email: String(index + 1) };
    });
    const body = {
        internals: {
            hashes: {
                emptyConfig: 'cold-start-fixture',
                inbounds: [
                    { tag: 'cold-start', hash: users.hash64String, usersCount: clients.length },
                ],
            },
        },
        xrayConfig: {
            log: { loglevel: 'warning' },
            inbounds: [
                {
                    tag: 'cold-start',
                    listen: '127.0.0.1',
                    port: 39123,
                    protocol: 'vless',
                    settings: { clients, decryption: 'none' },
                    streamSettings: { network: 'tcp', security: 'none' },
                },
            ],
            outbounds: [{ protocol: 'freedom', tag: 'direct' }],
        },
    };
    const blocker = net.createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(39123, '127.0.0.1', resolve);
    });
    try {
        const failed = await request('/node/xray/start', body);
        assert.equal(failed.status, 201, JSON.stringify(failed));
        assert.equal(failed.data.response.isStarted, false, JSON.stringify(failed));
        assert(failed.data.response.error);
        assert.equal((await request(statsPath)).status, 503);
        await assertHealthReady(false);
    } finally {
        await new Promise((resolve) => blocker.close(resolve));
    }
    await leaveOrphanSocket();
    const began = performance.now();
    const applied = await request('/node/xray/start', body);
    assert.equal(applied.status, 201, JSON.stringify(applied));
    assert.equal(applied.data.response.isStarted, true, JSON.stringify(applied));
    assert.equal(applied.data.response.error, null, JSON.stringify(applied));
    const startMs = Math.round(performance.now() - began);
    const stats = await request(statsPath);
    assert.equal(stats.status, 200, JSON.stringify(stats));
    assert.equal(stats.data.response.userStateSynchronized, true);
    await assertHealthReady(true);
    const id = coreId();
    assert(id);
    const repeated = await request('/node/xray/start', body);
    assert.equal(repeated.data.response.isStarted, true);
    assert.equal(repeated.data.response.error, null);
    assert.equal(
        coreId(),
        id,
        'unchanged authoritative configuration must not restart a running core',
    );
    fs.writeFileSync('/tmp/remnacust-cold-start-fixture.json', JSON.stringify(body), {
        mode: 0o600,
    });
    process.stdout.write(
        'PASS cold migration: premature requests rejected, failed bind unacknowledged, 2788 users, idempotent apply; startMs=' +
            startMs +
            '\n',
    );
}

async function verifyRestored() {
    const body = JSON.parse(fs.readFileSync('/tmp/remnacust-cold-start-fixture.json', 'utf8'));
    const clients = body.xrayConfig.inbounds[0].settings.clients;
    const stats = await request(statsPath);
    assert.equal(stats.status, 200, JSON.stringify(stats));
    assert.equal(stats.data.response.userStateSynchronized, false);
    await assertHealthReady(true);
    assert.equal(
        (
            await request('/node/handler/remove-user', {
                username: clients[0].email,
                hashData: { vlessUuid: clients[0].id },
            })
        ).status,
        503,
    );
    const id = coreId();
    const applied = await request('/node/xray/start', body);
    assert.equal(applied.data.response.isStarted, true, JSON.stringify(applied));
    assert.equal(applied.data.response.error, null, JSON.stringify(applied));
    assert.equal(coreId(), id, 'fresh identical configuration must preserve the recovered core');
    assert.equal((await request(statsPath)).data.response.userStateSynchronized, true);
    const removed = await request('/node/handler/remove-user', {
        username: clients[0].email,
        hashData: { vlessUuid: clients[0].id },
    });
    assert.equal(removed.status, 201, JSON.stringify(removed));
    assert.equal(removed.data.response.success, true);
    const stopped = await request('/node/xray/stop');
    assert.equal(stopped.data.response.isStopped, true, JSON.stringify(stopped));
    assert.equal((await request(statsPath)).status, 503);
    const health = await request('/node/xray/healthcheck');
    assert.equal(health.data.response.isAlive, true);
    assert.equal(health.data.response.xrayInternalStatusCached, false);
    const stock = structuredClone(body);
    stock.xrayConfig.geodata = { remnacustCoreFlavor: 'default' };
    const switched = await request('/node/xray/start', stock);
    assert.equal(switched.data.response.isStarted, true, JSON.stringify(switched));
    assert.equal(switched.data.response.error, null, JSON.stringify(switched));
    assert.equal((await request('/node/xray/healthcheck')).data.response.xrayVersion, '26.11.9');
    await assertHealthReady(true);
    const stockStats = await request(statsPath);
    assert.equal(stockStats.status, 200, JSON.stringify(stockStats));
    assert.equal(stockStats.data.response.userStateSynchronized, true);
    assert.equal((await request('/node/xray/stop')).data.response.isStopped, true);
    await assertHealthReady(false);
    assert.equal((await request(statsPath)).status, 503);
    process.stdout.write(
        'PASS checkpoint recovery: API rebind, fresh configuration without restart, user removal, explicit stop, stock Core flavor\n',
    );
}
main().catch((error) => {
    process.stderr.write(String(error.message) + '\n');
    process.exitCode = 1;
});
