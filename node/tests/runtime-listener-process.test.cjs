const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const load = require('./load-typescript.cjs');
const { applyRuntimeUpdate } = load(path.join(__dirname, '../src/modules/xray-core/runtime-listener-update.ts'));
const run = promisify(execFile);
const binary = process.env.REMNACUST_LISTENER_TEST_CORE;
const uuid = 'a4ac647a-075c-4b91-96e9-9fd341fba009';
async function listen(server) {
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    return server.address().port;
}
async function freePort() {
    const server = net.createServer();
    const port = await listen(server);
    await new Promise(resolve => server.close(resolve));
    return port;
}
async function exchange(port, bytes, length) {
    return new Promise((resolve, reject) => {
        const client = net.connect(port, '127.0.0.1'), chunks = [];
        let size = 0, completed = false;
        const finish = error => { if (completed) return; completed = true; client.destroy(); if (error) reject(error); else resolve(Buffer.concat(chunks)); };
        client.setTimeout(3000, () => finish(new Error('Local listener test timed out')));
        client.on('error', finish);
        client.on('end', () => { if (!completed) finish(new Error('Local listener closed early')); });
        client.on('connect', () => client.write(bytes));
        client.on('data', data => { chunks.push(data); size += data.length; if (size >= length) finish(); });
    });
}

test('a real core accepts port and transport updates, preserves unchanged PID and rolls back a failed bind', {
    skip: !binary, timeout: 90000,
}, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remnacust-listener-native-'));
    await fs.chmod(directory, 0o700);
    const checkpoint = path.join(directory, 'checkpoint.pb'), source = path.join(directory, 'config.json');
    const apiPort = await freePort(), initialPort = await freePort(), nextPort = await freePort();
    const echo = net.createServer(client => client.on('data', data => client.write(data)));
    const echoPort = await listen(echo);
    let process, current, starts = 0;
    const stop = async () => {
        const child = process;
        process = undefined;
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 3000);
        try { await exited; } finally { clearTimeout(force); }
    };
    t.after(async () => {
        await stop();
        await new Promise(resolve => echo.close(resolve));
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    });
    const write = async value => fs.writeFile(source, JSON.stringify(value), { mode: 0o600 });
    const invoke = args => run(binary, args, { timeout: 5000, maxBuffer: 65536 });
    const restart = async () => {
        await stop();
        starts++;
        const child = spawn(binary, ['-runtime-cache', checkpoint], { stdio: ['ignore', 'pipe', 'pipe'] });
        process = child;
        let output = '';
        for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { if (output.length < 16000) output += data; });
        for (let attempt = 0; attempt < 40; attempt++) {
            if (child.exitCode !== null || child.signalCode !== null) throw new Error('Native test core failed to start: ' + output.slice(-1000));
            if (/Xray [^\r\n]* started/.test(output)) {
                try { await invoke(['api', 'statsquery', `--server=127.0.0.1:${apiPort}`, '--timeout=1']); return; } catch {}
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('Native test core readiness failed: ' + output.slice(-1000));
    };
    const ping = async port => {
        const id = Buffer.from(uuid.replaceAll('-', ''), 'hex');
        const request = Buffer.concat([Buffer.from([0]), id, Buffer.from([0, 1, echoPort >> 8, echoPort & 255, 1, 127, 0, 0, 1]), Buffer.from('ping')]);
        assert.deepEqual(await exchange(port, request, 6), Buffer.from([0, 0, 112, 105, 110, 103]));
    };
    current = {
        log: { loglevel: 'warning' }, stats: {},
        api: { tag: 'CONTROL', listen: `127.0.0.1:${apiPort}`, services: ['HandlerService', 'StatsService'] },
        inbounds: [{ tag: 'YandexCDN-RU1', listen: '127.0.0.1', port: initialPort, protocol: 'vless', settings: { decryption: 'none', clients: [{ id: uuid, email: 'listener-fixture' }] } }],
        outbounds: [{ tag: 'direct', protocol: 'freedom', settings: { finalRules: [{ action: 'allow', ip: ['127.0.0.1/32'] }] } }],
    };
    await write(current);
    await invoke(['api', 'cache-runtime', '--output=' + checkpoint, source]);
    await restart();
    await ping(initialPort);
    const apply = async target => {
        await write(target);
        return applyRuntimeUpdate({
            requireLiveApply: false, checkpoint,
            apply: async () => { const result = await invoke(['api', 'reconcile', `--server=127.0.0.1:${apiPort}`, '--timeout=3', source]); assert.match(result.stdout, /"hash"/); },
            validate: async () => { await invoke(['run', '-test', '-config', source]); },
            prepare: async () => { await invoke(['api', 'cache-runtime', '--output=' + checkpoint, source]); },
            restart, stop,
        });
    };
    const moved = structuredClone(current);
    moved.inbounds[0].port = nextPort;
    assert.equal(await apply(moved), true);
    await ping(nextPort);
    const pid = process.pid;
    assert.equal(await apply(moved), false);
    assert.equal(process.pid, pid);
    const websocket = structuredClone(moved);
    websocket.inbounds[0].streamSettings = { network: 'ws', wsSettings: { path: '/replacement' } };
    assert.equal(await apply(websocket), true);
    const nonce = randomBytes(16).toString('base64');
    const handshake = await exchange(nextPort, Buffer.from(`GET /replacement HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${nonce}\r\nSec-WebSocket-Version: 13\r\n\r\n`), 12);
    assert.match(handshake.toString(), /^HTTP\/1\.1 101/);
    assert.equal(await apply(moved), true);
    await ping(nextPort);
    const occupied = net.createServer(client => client.destroy());
    const occupiedPort = await listen(occupied);
    t.after(() => new Promise(resolve => occupied.close(resolve)));
    const rejected = structuredClone(moved);
    rejected.inbounds[0].port = occupiedPort;
    await assert.rejects(apply(rejected), /previous running configuration was restored/);
    await ping(nextPort);
    assert.equal(starts, 6);
});
