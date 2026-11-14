const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer, createChannel, Metadata, ClientError, Status } = require('nice-grpc');
const load = require('./load-typescript.cjs');
const root = path.join(__dirname, '../src/modules');
const deadlines = load(path.join(root, 'xray-core/core-rpc-deadline.ts'));
const management = load(path.join(root, 'xray-core/core-management.ts'));
const id = '11111111-1111-4111-8111-111111111111';
const username = '123~' + 'a'.repeat(24);

function deferred() {
    let resolve;
    const promise = new Promise((value) => {
        resolve = value;
    });
    return { promise, resolve };
}

function pendingRpc() {
    const entered = deferred(),
        cancelled = deferred(),
        cleanup = deferred();
    const calls = [];
    const call = (request, options) => {
        calls.push({ request, options });
        entered.resolve();
        return new Promise((resolve, reject) => {
            options.signal.addEventListener(
                'abort',
                () => {
                    cancelled.resolve();
                    cleanup.promise.then(() => reject(options.signal.reason));
                },
                { once: true },
            );
        });
    };
    return { call, calls, entered, cancelled, cleanup };
}

function handler(raw, bindings = []) {
    const { ProfileUserHandler } = load(path.join(root, 'handler/profile-user-handler.ts'), {
        'nice-grpc': { Metadata, createClient: () => raw },
        '../xray-core/core-rpc-deadline': deadlines,
    });
    const models = {
        ...load(path.join(root, 'handler/models/add-user.response.model.ts')),
        ...load(path.join(root, 'handler/models/remove-user.response.model.ts')),
        ...load(path.join(root, 'handler/models/generic.response.model.ts')),
    };
    const { HandlerService } = load(path.join(root, 'handler/handler.service.ts'), {
        'enhanced-ms': () => '',
        sockdestroy: { hasCapNetAdmin: () => false },
        '@remnawave/xtls-sdk-nestjs': { InjectXtls: () => () => {} },
        '@common/types': {
            ok: (response) => ({ isOk: true, response }),
            fail: (error) => ({ isOk: false, ...error }),
        },
        '@libs/contracts/constants/errors': {
            ERRORS: { INTERNAL_SERVER_ERROR: { code: 'fixture' } },
        },
        '../_plugin/events/drop-connections': { DropConnectionsEvent: class {} },
        '../xray-core/core-management': management,
        '../xray-core/core-rpc-deadline': deadlines,
        './profile-user-handler': { ProfileUserHandler },
        './models': models,
    });
    const changed = [];
    const service = new HandlerService(
        { channel: {}, handler: { rawClient: raw } },
        {
            hasConfiguration: () => true,
            hasProfileBindings: () => bindings.length > 0,
            getProfileBindingsForTag: () => bindings,
            hasUserInInbound: () => false,
            getXtlsConfigInbounds: () => new Set(['PORT-A']),
            addXtlsConfigInbound() {},
            addUserToInbound: async (...args) => changed.push(args),
            removeUserFromInbound: async (...args) => changed.push(args),
        },
        { publish() {} },
    );
    service.logger = { debug() {}, error() {}, log() {} };
    return { service, changed };
}

function stats(raw, overrides = {}) {
    const { CoreStatsClient } = load(path.join(root, 'stats/core-stats-client.ts'), {
        '../xray-core/core-rpc-deadline': deadlines,
    });
    const { StatsService } = load(path.join(root, 'stats/stats.service.ts'), {
        '@remnawave/xtls-sdk-nestjs': { InjectXtls: () => () => {} },
        '@common/types': {
            ok: (response) => ({ isOk: true, response }),
            fail: (error) => ({ isOk: false, ...error }),
        },
        '@common/utils/get-system-stats': { getSystemStats: () => ({}) },
        '@libs/contracts/constants': { ERRORS: new Proxy({}, { get: (_, code) => ({ code }) }) },
        '../_plugin/queries/get-torrent-blocker-reports-count': {
            GetTorrentBlockerReportsCountQuery: class {},
        },
        '../network-stats/queries/get-interface-stats/get-interface-stats.query': {
            GetInterfaceStatsQuery: class {},
        },
        '../xray-core/core-management': management,
        '../xray-core/core-rpc-deadline': deadlines,
        '../xray-core/core-incarnation': {
            readCoreIncarnation: overrides.incarnation ?? (async () => id),
        },
        '../xray-core/profile-traffic': { readProfileTraffic: async () => null },
        './core-stats-client': { CoreStatsClient },
        './models': {
            ...load(path.join(root, 'stats/models/get-users-stats.response.model.ts')),
            ...load(path.join(root, 'stats/models/get-inbound-stats.response.model.ts')),
            ...load(path.join(root, 'stats/models/get-outbound-stats.response.model.ts')),
            ...load(path.join(root, 'stats/models/get-all-inbounds-stats.response.ts')),
            ...load(path.join(root, 'stats/models/get-all-outbounds-stats.response.ts')),
            ...load(path.join(root, 'stats/models/get-combined-stats.response.ts')),
        },
    });
    const service = new StatsService(
        { stats: { rawClient: raw } },
        { execute: async () => 0 },
        {
            getStatus: overrides.status ?? (async () => ({ up: true, pid: 42 })),
            isApiSocketAvailable: () => true,
        },
        { hasConfiguration: () => true, hasProfileBindings: () => false },
    );
    service.logger = { error() {}, warn() {} };
    return service;
}

test('single, bulk, profile, legacy and outbound handlers retain management until cancelled RPC cleanup settles', async () => {
    const methods = {
        addUser: {
            data: [{ tag: 'PORT-A', username, type: 'vless', uuid: id }],
            hashData: { vlessUuid: id },
        },
        removeUser: { username, hashData: { vlessUuid: id } },
        addUsers: {
            affectedInboundTags: ['PORT-A'],
            users: [
                {
                    userData: { userId: username, vlessUuid: id, hashUuid: id },
                    inboundData: [{ tag: 'PORT-A', type: 'vless' }],
                },
            ],
        },
        removeUsers: {
            users: [
                { userId: username, hashUuid: id },
                { userId: username + 'b', hashUuid: id },
            ],
        },
        removeOutbound: 'OUT',
    };
    for (const bindings of [[], [id]])
        for (const [method, data] of Object.entries(methods)) {
            const rpc = pendingRpc();
            const f = handler({ alterInbound: rpc.call, removeOutbound: rpc.call }, bindings);
            let settled = false;
            const request = deadlines
                .withCoreRpcDeadline(() => f.service[method](data), 25)
                .then(
                    (value) => {
                        settled = true;
                        return value;
                    },
                    (error) => {
                        settled = true;
                        return error;
                    },
                );
            try {
                await rpc.entered.promise;
                await rpc.cancelled.promise;
                assert.equal(settled, false, method);
                assert.equal(management.coreManagement.isBusy(), true, method);
                await assert.rejects(
                    management.coreManagement.run(async () => {}),
                    (error) => error.getStatus() === 503,
                );
            } finally {
                rpc.cleanup.resolve();
            }
            const result = await request;
            assert.equal(result?.isOk === true && result.response?.success === true, false, method);
            assert.equal(management.coreManagement.isBusy(), false, method);
            assert.equal(rpc.calls.length, 1, 'cancelled mutations are never replayed');
            assert.equal(
                f.changed.length,
                0,
                'unconfirmed RPC cannot change local credential acknowledgement',
            );
        }
});

test('every reset endpoint acquires management before status and holds it until actual query cancellation', async () => {
    const methods = {
        getUsersStats: [true],
        getInboundStats: ['PORT-A', true],
        getOutboundStats: ['OUT', true],
        getAllInboundsStats: [true],
        getAllOutboundsStats: [true],
        getCombinedStats: [true],
    };
    for (const [method, args] of Object.entries(methods)) {
        const rpc = pendingRpc();
        const status = deferred();
        const service = stats({ queryStats: rpc.call }, { status: () => status.promise });
        const request = deadlines.withCoreRpcDeadline(() => service[method](...args), 25);
        assert.throws(
            () => management.coreManagement.acquire(),
            (error) => error.getStatus() === 503,
        );
        status.resolve({ up: true, pid: 42 });
        await rpc.entered.promise;
        await rpc.cancelled.promise;
        assert.equal(management.coreManagement.isBusy(), true, method);
        rpc.cleanup.resolve();
        assert.equal((await request).isOk, false, method);
        assert.equal(rpc.calls.length, 1, 'ambiguous reset is not retried');
        assert.equal(management.coreManagement.isBusy(), false, method);
    }
});

test('completed usage counters survive deadline expiry during later continuity inspection', async () => {
    const after = deferred();
    let reads = 0,
        queries = 0;
    const service = stats(
        {
            queryStats: async () => {
                queries++;
                return {
                    stat: [
                        { name: 'user>>>123>>>traffic>>>uplink', value: 7 },
                        { name: 'user>>>123>>>traffic>>>downlink', value: 11 },
                    ],
                };
            },
        },
        { incarnation: async () => (++reads === 1 ? id : after.promise) },
    );
    const result = deadlines.withCoreRpcDeadline(() => service.getUsersStats(true), 20);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(management.coreManagement.isBusy(), true);
    after.resolve(null);
    const reply = await result;
    assert.equal(reply.isOk, true);
    assert.deepEqual(reply.response.users, [{ username: '123', uplink: 7, downlink: 11 }]);
    assert.equal(reply.response.coreProcessId, null);
    assert.equal(queries, 1);
});

test('legacy session fallback cancels every in-flight worker before reporting failure', async () => {
    const { CoreStatsClient } = load(path.join(root, 'stats/core-stats-client.ts'), {
        '../xray-core/core-rpc-deadline': deadlines,
    });
    let started = 0,
        stopped = 0;
    const client = new CoreStatsClient({
        stats: {
            rawClient: {
                getUsersStats: async () => {
                    throw new ClientError('/fixture', Status.UNIMPLEMENTED, 'legacy');
                },
                getAllOnlineUsers: async () => ({
                    users: Array.from({ length: 80 }, (_, i) => `user>>>${i}>>>online`),
                }),
                getStatsOnlineIpList: (_request, { signal }) =>
                    new Promise((resolve, reject) => {
                        started++;
                        signal.addEventListener(
                            'abort',
                            () =>
                                setImmediate(() => {
                                    stopped++;
                                    reject(signal.reason);
                                }),
                            { once: true },
                        );
                    }),
            },
        },
    });
    const result = await deadlines.withCoreRpcDeadline(() => client.getUsersStats(), 25);
    assert.equal(result.isOk, false);
    assert.equal(started, 50);
    assert.equal(stopped, started);
});

test('bulk connection revocation shares one cancellation budget across all users', async () => {
    for (const userIds of [['123'], ['123', '124']]) {
        const rpc = pendingRpc();
        const f = handler({});
        f.service.capNetAdminAvailable = true;
        f.service.xtlsApi.stats = { rawClient: { getStatsOnlineIpList: rpc.call } };
        const request = deadlines.withCoreRpcDeadline(
            () => f.service.dropUsersConnections({ userIds }),
            25,
        );
        await rpc.entered.promise;
        await rpc.cancelled.promise;
        rpc.cleanup.resolve();
        assert.equal((await request).response.success, false);
        assert.equal(rpc.calls.length, 1);
    }
});

test('cancellable stats preserve the installed SDK wire requests and response models', async () => {
    const { StatsService: SdkStats } = require('@remnawave/xtls-sdk/build/src/stats/stats.service');
    const { CoreStatsClient } = load(path.join(root, 'stats/core-stats-client.ts'), {
        '../xray-core/core-rpc-deadline': deadlines,
    });
    const calls = [];
    const raw = {
        queryStats: async (request, options) => {
            calls.push({ request, options });
            return {
                stat: [
                    { name: `${request.pattern}traffic>>>uplink`, value: 7 },
                    { name: `${request.pattern}traffic>>>downlink`, value: 11 },
                ],
            };
        },
        getSysStats: async (request, options) => {
            calls.push({ request, options });
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
                Uptime: 10,
            };
        },
        getStatsOnline: async (request, options) => {
            calls.push({ request, options });
            return {};
        },
        getUsersStats: async (request, options) => {
            calls.push({ request, options });
            return { users: [] };
        },
    };
    const sdk = Object.assign(Object.create(SdkStats.prototype), {
        client: raw,
        supportsGetUsersStats: null,
    });
    const bounded = new CoreStatsClient({ stats: { rawClient: raw } });
    const methods = {
        getSysStats: [],
        getUserOnlineStatus: ['123'],
        getAllUsersStats: [true],
        getAllInboundsStats: [true],
        getAllOutboundsStats: [true],
        getInboundStats: ['PORT-A', true],
        getOutboundStats: ['OUT', true],
        getUsersStats: [false, false],
    };
    for (const [method, args] of Object.entries(methods)) {
        calls.length = 0;
        const expected = await sdk[method](...args);
        assert.deepEqual(await bounded[method](...args), expected, method);
        assert.deepEqual(calls[1].request, calls[0].request, method);
        assert(calls[1].options.signal instanceof AbortSignal, method);
    }
});

test(
    'real nice-grpc transport receives cancellation and remains usable without replay',
    { timeout: 5000 },
    async (t) => {
        const {
            HandlerServiceDefinition,
        } = require('@remnawave/xtls-sdk/build/src/xray-protos/app/proxyman/command/command');
        const { ProfileUserHandler } = load(path.join(root, 'handler/profile-user-handler.ts'), {
            '../xray-core/core-rpc-deadline': deadlines,
        });
        const cancelled = deferred();
        let block = false,
            calls = 0;
        const server = createServer();
        server.add(
            {
                ...HandlerServiceDefinition,
                methods: { alterInbound: HandlerServiceDefinition.methods.alterInbound },
            },
            {
                async alterInbound(_request, context) {
                    calls++;
                    if (block)
                        await new Promise((resolve) =>
                            context.signal.addEventListener(
                                'abort',
                                () => {
                                    cancelled.resolve();
                                    resolve();
                                },
                                { once: true },
                            ),
                        );
                    return {};
                },
            },
        );
        const port = await server.listen('127.0.0.1:0');
        const channel = createChannel(`127.0.0.1:${port}`);
        t.after(async () => {
            channel.close();
            await server.shutdown();
        });
        const client = new ProfileUserHandler({ channel }, () => []);
        assert.equal((await client.removeUser('PORT-A', username)).isOk, true);
        block = true;
        const result = await deadlines.withCoreRpcDeadline(
            () => client.removeUser('PORT-A', username),
            100,
        );
        assert.equal(result.isOk, false);
        await cancelled.promise;
        block = false;
        assert.equal((await client.removeUser('PORT-A', username)).isOk, true);
        assert.equal(calls, 3);
    },
);
