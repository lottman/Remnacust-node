const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ServiceUnavailableException } = require('@nestjs/common');
const load = require('./load-typescript.cjs');

const root = path.join(__dirname, '../src/modules');
const coreProcessId = '11111111-1111-4111-8111-111111111111';

function deferred() {
    let resolve;
    const promise = new Promise((value) => {
        resolve = value;
    });
    return { promise, resolve };
}

function fixture() {
    const management = load(path.join(root, 'xray-core/core-management.ts'));
    const deadlines = load(path.join(root, 'xray-core/core-rpc-deadline.ts'));
    const entered = deferred();
    const release = deferred();
    const state = {
        up: true,
        pid: 42,
        socket: true,
        probes: 0,
        starts: 0,
        stops: 0,
        uptime: 4476,
        systemCalls: 0,
        queries: [],
        counters: { uplink: 7, downlink: 11 },
        rpcFailure: false,
    };
    const xrayProcess = {
        getStatus: async () => ({
            up: state.up,
            pid: state.up ? state.pid : null,
            raw: state.up ? `true ${state.pid}` : 'false -1',
        }),
        isApiSocketAvailable: () => state.socket,
        getApiSocketIdentity: () => (state.socket ? 'fixture-socket' : null),
        probeApi: async () => {
            state.probes++;
            return state.up && state.socket;
        },
        start: async () => {
            state.starts++;
        },
        stop: async () => {
            state.stops++;
        },
    };
    const sdk = {
        stats: {
            rawClient: {
                getSysStats: async () => {
                    state.systemCalls++;
                    return {
                        NumGoroutine: 1,
                        NumGC: 2,
                        Alloc: 3,
                        TotalAlloc: 4,
                        Sys: 5,
                        Mallocs: 6,
                        Frees: 7,
                        LiveObjects: 8,
                        PauseTotalNs: 9,
                        Uptime: state.uptime++,
                    };
                },
                queryStats: async (request, { signal }) => {
                    assert(signal instanceof AbortSignal);
                    assert.equal(signal.aborted, false);
                    state.queries.push(request);
                    if (request.reset) {
                        assert.equal(management.coreManagement.isOwned(), true);
                        entered.resolve();
                        await release.promise;
                    }
                    if (state.rpcFailure) throw Error('controlled reset RPC failure');
                    const stat = Object.entries(state.counters).map(([direction, value]) => ({
                        name: `user>>>123>>>traffic>>>${direction}`,
                        value,
                    }));
                    if (request.reset) state.counters = { uplink: 0, downlink: 0 };
                    return { stat };
                },
            },
        },
    };
    const { CoreStatsClient } = load(path.join(root, 'stats/core-stats-client.ts'), {
        '../xray-core/core-rpc-deadline': deadlines,
    });
    const { StatsService } = load(path.join(root, 'stats/stats.service.ts'), {
        '@remnawave/xtls-sdk-nestjs': { InjectXtls: () => () => {} },
        '@common/types': {
            ok: (response) => ({ isOk: true, response }),
            fail: (error) => ({ isOk: false, ...error }),
        },
        '@common/utils/get-system-stats': {
            getSystemStats: () => ({}),
            getNetworkAddresses: () => ({ addresses: [] }),
        },
        '@libs/contracts/constants': {
            ERRORS: { FAILED_TO_GET_USERS_STATS: { code: 'fixture-reset-failed' } },
        },
        '../_plugin/queries/get-torrent-blocker-reports-count': {
            GetTorrentBlockerReportsCountQuery: class {},
        },
        '../network-stats/queries/get-interface-stats/get-interface-stats.query': {
            GetInterfaceStatsQuery: class {},
        },
        '../xray-core/core-management': management,
        '../xray-core/core-rpc-deadline': deadlines,
        '../xray-core/core-incarnation': {
            readCoreIncarnation: async (status) => (status.up ? coreProcessId : null),
        },
        '../xray-core/profile-traffic': {
            readProfileTraffic: async () => {
                throw Error('unexpected profile traffic RPC');
            },
        },
        './core-stats-client': { CoreStatsClient },
        './models': {
            ...load(path.join(root, 'stats/models/get-system-stats.response.model.ts')),
            ...load(path.join(root, 'stats/models/get-users-stats.response.model.ts')),
        },
    });
    const stats = new StatsService(sdk, { execute: async () => 0 }, xrayProcess, {
        hasConfiguration: () => true,
        hasProfileBindings: () => false,
    });
    stats.logger = { warn() {}, error() {} };

    const healthFile = path.join(root, 'xray-core/xray.service.ts');
    const mocks = {};
    for (const match of fs.readFileSync(healthFile, 'utf8').matchAll(/from '([^']+)'/g))
        if (!match[1].startsWith('node:')) mocks[match[1]] = {};
    Object.assign(mocks, {
        '@nestjs/common': { Injectable: () => (value) => value, Logger: class {} },
        '@remnawave/xtls-sdk-nestjs': { InjectXtls: () => () => {} },
        '@common/types': { ok: (response) => ({ isOk: true, response }) },
        './core-management': management,
        './models': load(path.join(root, 'xray-core/models/get-node-health-check.model.ts')),
    });
    const { XrayService } = load(healthFile, mocks);
    const xray = Object.assign(Object.create(XrayService.prototype), {
        logger: { error() {} },
        isXrayOnline: true,
        isXrayStartedProccesing: false,
        xrayPath: '/fixture-core',
        xrayVersion: 'fixture-core',
        nodeVersion: 'fixture-node',
        internal: { xtlsApiSocketPath: '/fixture/api.sock' },
        liveCore: { supported: async () => false, profilesSupported: async () => false },
        portPlans: { read: async () => null },
        xrayProcess,
    });
    const health = async () => {
        const result = await xray.getNodeHealthCheck();
        assert.equal(result.isOk, true);
        assert.equal(result.response.isAlive, true);
        return result.response.xrayInternalStatusCached;
    };
    return { state, stats, xray, xrayProcess, health, management, entered, release };
}

function isUnavailable(error) {
    return error instanceof ServiceUnavailableException && error.getStatus() === 503;
}

for (const rpcFailure of [false, true]) {
    test(
        `a ${rpcFailure ? 'failed' : 'successful'} stats reset makes health not ready while the supervised core stays up`,
        { timeout: 10000 },
        async () => {
            const f = fixture();
            assert.equal(await f.health(), true);
            const before = await f.stats.getSystemStats();
            assert.equal(before.isOk, true);
            assert.equal(before.response.xrayInfo.uptime, 4476);
            const status = await f.xrayProcess.getStatus();
            f.state.rpcFailure = rpcFailure;
            const resetting = f.stats.getUsersStats(true);
            try {
                await f.entered.promise;
                assert.equal(f.management.coreManagement.isBusy(), true);
                assert.equal(f.management.coreManagement.isOwned(), false);
                await assert.rejects(f.stats.getSystemStats(), isUnavailable);
                await assert.rejects(f.stats.getUsersStats(false), isUnavailable);
                await assert.rejects(f.stats.getUsersStats(true), isUnavailable);
                let managedCalls = 0;
                await assert.rejects(
                    f.management.coreManagement.run(async () => {
                        managedCalls++;
                    }),
                    isUnavailable,
                );
                assert.equal(managedCalls, 0);
                assert.equal(await f.health(), false);
                assert.deepEqual(await f.xrayProcess.getStatus(), status);
                assert.equal(f.xrayProcess.isApiSocketAvailable(), true);
                assert.equal(f.xray.isXrayOnline, true);
                assert.equal(f.state.probes, 1, 'busy health must not probe the core');
                assert.equal(f.state.systemCalls, 1, '503 must not reach the stats RPC');
                assert.deepEqual(f.state.queries, [{ pattern: 'user>>>', reset: true }]);
                assert.deepEqual(f.state.counters, { uplink: 7, downlink: 11 });
            } finally {
                f.release.resolve();
                await resetting;
            }
            const reset = await resetting;
            assert.equal(reset.isOk, !rpcFailure);
            if (rpcFailure) assert.equal(reset.code, 'fixture-reset-failed');
            else {
                assert.deepEqual(reset.response.users, [
                    { username: '123', uplink: 7, downlink: 11 },
                ]);
                assert.equal(reset.response.coreProcessId, coreProcessId);
            }
            assert.equal(f.management.coreManagement.isBusy(), false);
            assert.equal(await f.health(), true);
            assert.equal(f.state.probes, 2, 'readiness requires a fresh probe after reset');
            const after = await f.stats.getSystemStats();
            assert.equal(after.isOk, true);
            assert.equal(after.response.xrayInfo.uptime, 4477);
            assert.deepEqual(await f.xrayProcess.getStatus(), status);
            f.state.rpcFailure = false;
            const retry = await f.stats.getUsersStats(false);
            assert.equal(retry.isOk, true);
            assert.deepEqual(
                retry.response.users,
                rpcFailure ? [{ username: '123', uplink: 7, downlink: 11 }] : [],
            );
            assert.deepEqual(f.state.queries, [
                { pattern: 'user>>>', reset: true },
                { pattern: 'user>>>', reset: false },
            ]);
            assert.equal(f.state.starts, 0);
            assert.equal(f.state.stops, 0);
        },
    );
}

for (const unavailable of ['stopped', 'socket']) {
    test(
        `reset completion cannot restore readiness when ${unavailable === 'stopped' ? 'the core is stopped' : 'the API socket is unavailable'}`,
        { timeout: 10000 },
        async () => {
            const f = fixture();
            assert.equal(await f.health(), true);
            const resetting = f.stats.getUsersStats(true);
            try {
                await f.entered.promise;
                assert.equal(await f.health(), false);
                if (unavailable === 'stopped') f.state.up = false;
                else f.state.socket = false;
            } finally {
                f.release.resolve();
                await resetting;
            }
            assert.equal(f.management.coreManagement.isBusy(), false);
            assert.equal(await f.health(), false);
            assert.equal(f.xray.isXrayOnline, false);
            assert.equal(f.state.probes, 1);
            await assert.rejects(f.stats.getSystemStats(), isUnavailable);
            assert.equal(f.state.systemCalls, 0);
            assert.equal(f.state.starts, 0);
            assert.equal(f.state.stops, 0);
        },
    );
}
