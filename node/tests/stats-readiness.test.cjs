const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('./load-typescript.cjs');
const source = path.join(__dirname, '../src/modules');
const management = load(path.join(source, 'xray-core/core-management.ts'));
function fixture() {
    const state = {
        up: true,
        socket: true,
        calls: 0,
        warnings: 0,
        errors: 0,
        response: { isOk: true, data: {} },
    };
    const { StatsService } = load(path.join(source, 'stats/stats.service.ts'), {
        '@remnawave/xtls-sdk-nestjs': { InjectXtls: () => () => {} },
        '@common/types': {
            ok: (response) => ({ isOk: true, response }),
            fail: (error) => ({ isOk: false, ...error }),
        },
        '@common/utils/get-system-stats': { getSystemStats: () => ({}) },
        '@libs/contracts/constants': { ERRORS: { FAILED_TO_GET_SYSTEM_STATS: { code: 'A010' } } },
        '../_plugin/queries/get-torrent-blocker-reports-count': {
            GetTorrentBlockerReportsCountQuery: class {},
        },
        '../network-stats/queries/get-interface-stats/get-interface-stats.query': {
            GetInterfaceStatsQuery: class {},
        },
        '../xray-core/core-management': management,
        '../xray-core/xray-process.service': {},
        '../xray-core/profile-traffic': {
            readProfileTraffic: async () => {
                throw Error('unexpected profile traffic');
            },
        },
        './models': load(path.join(source, 'stats/models/get-system-stats.response.model.ts')),
    });
    const sdk = {
        stats: new Proxy(
            {},
            {
                get: () => async () => {
                    state.calls++;
                    return state.response;
                },
            },
        ),
    };
    const service = new StatsService(
        sdk,
        { execute: async () => 0 },
        { getStatus: async () => ({ up: state.up }), isApiSocketAvailable: () => state.socket },
        { hasConfiguration: () => false, hasProfileBindings: () => false },
    );
    service.logger = {
        warn() {
            state.warnings++;
        },
        error() {
            state.errors++;
        },
    };
    return { state, service };
}
const methods = [
    'getUserOnlineStatus',
    'getSystemStats',
    'getUsersStats',
    'getInboundStats',
    'getOutboundStats',
    'getAllInboundsStats',
    'getAllOutboundsStats',
    'getCombinedStats',
    'getUsersIpList',
];
test('all public core stats reject initialization and management with 503 before touching or resetting SDK counters', async () => {
    for (const unavailable of ['stopped', 'socket', 'management']) {
        const f = fixture();
        f.state.up = unavailable !== 'stopped';
        f.state.socket = unavailable !== 'socket';
        const release =
            unavailable === 'management' ? management.coreManagement.acquire() : () => {};
        try {
            for (const method of methods)
                await assert.rejects(
                    f.service[method]({ username: 'fixture' }, true),
                    (error) => error.getStatus() === 503,
                    method,
                );
        } finally {
            release();
        }
        assert.equal(f.state.calls, 0);
        assert.equal(f.state.warnings, 0);
        assert.equal(f.state.errors, 0);
    }
});
test('a restored running core still returns telemetry while user state awaits authoritative reconciliation', async () => {
    const f = fixture();
    const response = await f.service.getSystemStats();
    assert.equal(response.isOk, true);
    assert.equal(response.response.userStateSynchronized, false);
    assert.equal(f.state.calls, 1);
});
test('a ready process with a real SDK failure still reports the original failure and warning', async () => {
    const f = fixture();
    f.state.response = { isOk: false, message: 'fixture RPC failure' };
    const response = await f.service.getSystemStats();
    assert.equal(response.isOk, false);
    assert.equal(response.code, 'A010');
    assert.equal(f.state.calls, 1);
    assert.equal(f.state.warnings, 1);
});
