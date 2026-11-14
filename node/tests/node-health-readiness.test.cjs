const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = require('./load-typescript.cjs');

function deferred() {
    let resolve;
    const promise = new Promise(value => { resolve = value; });
    return { promise, resolve };
}

function fixture() {
    const file = path.join(__dirname, '../src/modules/xray-core/xray.service.ts');
    const state = { up: true, pid: 42, raw: 'true 42', socket: true, ready: true,
        busy: false, probes: 0, starts: 0, stops: 0, probe: null, socketIdentity: 'socket-1' };
    const management = load(path.join(path.dirname(file), 'core-management.ts')).coreManagement;
    const mocks = {};
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g))
        if (!match[1].startsWith('node:')) mocks[match[1]] = {};
    Object.assign(mocks, {
        '@nestjs/common': { Injectable: () => value => value, Logger: class {} },
        '@remnawave/xtls-sdk-nestjs': { InjectXtls: () => () => {} },
        '@common/types': { ok: response => ({ isOk: true, response }) },
        './core-management': { coreManagement: {
            isBusy: () => state.busy || management.isBusy(),
            run: action => management.run(action),
        } },
        './models': load(path.join(path.dirname(file), 'models/get-node-health-check.model.ts')),
    });
    const { XrayService } = load(file, mocks);
    const service = Object.assign(Object.create(XrayService.prototype), {
        logger: { error() {}, log() {} }, isXrayOnline: true, isXrayStartedProccesing: false,
        xrayPath: '/fixture-core', xrayVersion: 'fixture', nodeVersion: 'fixture-node',
        internal: { xtlsApiSocketPath: '/fixture/api.sock' },
        liveCore: { supported: async () => false, profilesSupported: async () => false },
        portPlans: { read: async () => null },
        xrayProcess: {
            getStatus: async () => ({ up: state.up, pid: state.pid, raw: state.raw }),
            isApiSocketAvailable: () => state.socket,
            getApiSocketIdentity: () => state.socket ? state.socketIdentity : null,
            probeApi: async (binary, socket, pid) => {
                assert.equal(binary, '/fixture-core');
                assert.equal(socket, '/fixture/api.sock');
                assert.equal(pid, state.pid);
                state.probes++;
                return state.probe ? state.probe() : state.ready;
            },
            start: async () => { state.starts++; },
            stop: async () => { state.stops++; },
        },
    });
    return { state, service, management, health: async () => (await service.getNodeHealthCheck()).response };
}

function shutdownModule(service) {
    const file = path.join(__dirname, '../src/modules/xray-core/xray.module.ts');
    const mocks = {};
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g))
        if (!match[1].startsWith('node:')) mocks[match[1]] = {};
    Object.assign(mocks, {
        '@nestjs/common': { Module: () => value => value, Logger: class { log() {} } },
        './commands': { COMMANDS: [] },
    });
    const { XrayModule } = load(file, mocks);
    return new XrayModule(service);
}

async function holdFinalHealthStatus(f) {
    const entered = deferred();
    const release = deferred();
    const getStatus = f.service.xrayProcess.getStatus;
    let reads = 0;
    f.service.xrayProcess.getStatus = async () => {
        const snapshot = await getStatus();
        if (++reads === 2) {
            entered.resolve();
            await release.promise;
        }
        return snapshot;
    };
    const request = f.health();
    await entered.promise;
    return { request, release };
}

test('cached true is revalidated on every completed health check without restarting the core', async () => {
    const f = fixture();
    assert.equal((await f.health()).xrayInternalStatusCached, true);
    f.state.ready = false;
    const result = await f.health();
    assert.equal(result.isAlive, true);
    assert.equal(result.xrayInternalStatusCached, false);
    assert.equal(f.service.isXrayOnline, false);
    assert.equal(f.state.probes, 2);
    assert.equal(f.state.starts, 0);
    assert.equal(f.state.stops, 0);
});

test('stale true is cleared when the supervisor or private API socket is unavailable', async () => {
    for (const change of [
        state => { state.up = false; state.pid = null; state.raw = 'false -1'; },
        state => { state.up = false; state.pid = null; state.raw = ''; },
        state => { state.pid = null; },
        state => { state.socket = false; },
    ]) {
        const f = fixture();
        change(f.state);
        const result = await f.health();
        assert.equal(result.isAlive, true);
        assert.equal(result.xrayInternalStatusCached, false);
        assert.equal(f.service.isXrayOnline, false);
        assert.equal(f.state.probes, 0);
        assert.equal(f.state.starts + f.state.stops, 0);
    }
});

test('PID or socket changes during a successful probe cannot retain true', async () => {
    for (const change of [state => { state.pid = 43; }, state => { state.socket = false; }]) {
        const f = fixture();
        f.state.probe = async () => { change(f.state); return true; };
        assert.equal((await f.health()).xrayInternalStatusCached, false);
        assert.equal(f.service.isXrayOnline, false);
        f.state.probe = null;
        f.state.socket = true;
        assert.equal((await f.health()).xrayInternalStatusCached, true);
        assert.equal(f.state.probes, 2);
    }
});

test('concurrent health requests share one in-flight probe and failures are not cached', async () => {
    const f = fixture();
    const gate = deferred();
    f.state.probe = () => gate.promise;
    const requests = Array.from({ length: 16 }, () => f.health());
    await new Promise(setImmediate);
    assert.equal(f.state.probes, 1);
    gate.resolve(true);
    for (const result of await Promise.all(requests))
        assert.equal(result.xrayInternalStatusCached, true);
    f.state.probe = null;
    f.state.ready = false;
    assert.equal((await f.health()).xrayInternalStatusCached, false);
    assert.equal(f.state.probes, 2);
    f.state.ready = true;
    assert.equal((await f.health()).xrayInternalStatusCached, true);
    assert.equal(f.state.probes, 3);
});

test('busy health is not ready and does not overwrite the state owned by management', async () => {
    for (const startBusy of [false, true]) {
        const f = fixture();
        if (startBusy) f.service.isXrayStartedProccesing = true;
        else f.state.busy = true;
        const result = await f.health();
        assert.equal(result.isAlive, true);
        assert.equal(result.xrayInternalStatusCached, false);
        assert.equal(f.service.isXrayOnline, true);
        assert.equal(f.state.probes, 0);
    }
});

test('late health completion cannot overwrite managed recovery or stop decisions', async () => {
    for (const { online, probeResult } of [
        { online: true, probeResult: false },
        { online: false, probeResult: true },
    ]) {
        const f = fixture();
        const gate = deferred();
        f.state.probe = () => gate.promise;
        const request = f.health();
        await new Promise(setImmediate);
        assert.equal(f.state.probes, 1);
        f.service.isXrayOnline = !online;
        f.service.isXrayOnline = online;
        gate.resolve(probeResult);
        assert.equal((await request).xrayInternalStatusCached, false);
        assert.equal(f.service.isXrayOnline, online);
        assert.equal(f.state.starts + f.state.stops, 0);
    }
});

test('a management operation starting during a probe suppresses its result', async () => {
    const f = fixture();
    const gate = deferred();
    f.state.probe = () => gate.promise;
    const request = f.health();
    await new Promise(setImmediate);
    f.state.busy = true;
    gate.resolve(false);
    assert.equal((await request).xrayInternalStatusCached, false);
    assert.equal(f.service.isXrayOnline, true);
});

test('probe exceptions clear stale readiness and do not retain a rejected coalesced request', async () => {
    const f = fixture();
    f.state.probe = async () => { throw Error('controlled probe failure'); };
    assert.equal((await f.health()).xrayInternalStatusCached, false);
    assert.equal(f.service.isXrayOnline, false);
    f.state.probe = null;
    assert.equal((await f.health()).xrayInternalStatusCached, true);
    assert.equal(f.state.probes, 2);
    assert.equal(f.state.starts + f.state.stops, 0);
});

test('slow capability metadata cannot publish readiness sampled before management starts', async () => {
    const f = fixture();
    const gate = deferred();
    f.service.liveCore.supported = () => gate.promise;
    const request = f.health();
    await new Promise(setImmediate);
    f.state.busy = true;
    f.service.isXrayOnline = false;
    gate.resolve(false);
    assert.equal((await request).xrayInternalStatusCached, false);
    assert.equal(f.service.isXrayOnline, false);
    assert.equal(f.state.starts + f.state.stops, 0);
});

test('socket replacement after the RPC cannot inherit the readiness of the previous socket', async () => {
    const f = fixture();
    let reads = 0;
    const getStatus = f.service.xrayProcess.getStatus;
    f.service.xrayProcess.getStatus = async () => {
        if (++reads === 2) f.state.socketIdentity = 'socket-2';
        return getStatus();
    };
    assert.equal((await f.health()).xrayInternalStatusCached, false);
    assert.equal(f.service.isXrayOnline, false);
    assert.equal(f.state.probes, 1);
    assert.equal((await f.health()).xrayInternalStatusCached, true);
    assert.equal(f.state.probes, 2);
});

test('direct module shutdown fences an old successful health probe before releasing management', { timeout: 5000 }, async () => {
    const f = fixture();
    const pending = await holdFinalHealthStatus(f);
    f.service.xrayProcess.stop = async () => {
        assert.equal(f.management.isBusy(), true);
        f.state.stops++;
        f.state.up = false;
        f.state.pid = null;
        f.state.raw = 'false -1';
    };
    await shutdownModule(f.service).onModuleDestroy();
    assert.equal(f.management.isBusy(), false);
    pending.release.resolve();
    const result = await pending.request;
    assert.equal(f.state.up, false);
    assert.equal(result.isAlive, true);
    assert.equal(result.xrayInternalStatusCached, false);
    assert.equal(f.service.isXrayOnline, false);
    assert.equal((await f.health()).xrayInternalStatusCached, false);
    assert.equal(f.state.probes, 1);
    assert.equal(f.state.stops, 1);
    assert.equal(f.state.starts, 0);
});

test('failed module stop invalidates readiness before attempting shutdown and requires a new probe', { timeout: 5000 }, async () => {
    for (const remainsUp of [false, true]) {
        const f = fixture();
        const pending = await holdFinalHealthStatus(f);
        const entered = deferred();
        const finish = deferred();
        let onlineAtStop;
        f.service.xrayProcess.stop = async () => {
            f.state.stops++;
            onlineAtStop = f.service.isXrayOnline;
            entered.resolve();
            await finish.promise;
            f.state.up = remainsUp;
            f.state.pid = remainsUp ? 42 : null;
            f.state.raw = remainsUp ? 'true 42' : 'false -1';
            throw Error('controlled partial stop failure');
        };
        const stopping = shutdownModule(f.service).onModuleDestroy();
        await entered.promise;
        assert.equal((await f.health()).xrayInternalStatusCached, false);
        finish.resolve();
        await stopping;
        assert.equal(onlineAtStop, false);
        assert.equal(f.management.isBusy(), false);
        assert.equal(f.service.isXrayOnline, false);
        assert.equal((await f.health()).xrayInternalStatusCached, remainsUp);
        assert.equal(f.state.probes, remainsUp ? 2 : 1);
        pending.release.resolve();
        assert.equal((await pending.request).xrayInternalStatusCached, false);
        assert.equal(f.service.isXrayOnline, remainsUp);
        assert.equal(f.state.probes, remainsUp ? 2 : 1);
        assert.equal(f.state.stops, 1);
        assert.equal(f.state.starts, 0);
    }
});

test('a rejected module shutdown cannot overwrite state owned by another management operation', async () => {
    const f = fixture();
    const release = f.management.acquire();
    try {
        await shutdownModule(f.service).onModuleDestroy();
        assert.equal(f.service.isXrayOnline, true);
        assert.equal(f.state.stops, 0);
    } finally {
        release();
    }
    assert.equal((await f.health()).xrayInternalStatusCached, true);
    assert.equal(f.state.probes, 1);
    assert.equal(f.state.starts, 0);
});
