const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('./load-typescript.cjs');

function service(stats) {
    class Users { constructor(users) { this.users = users; } }
    class Ips { constructor(ips) { this.ips = ips; } }
    const { StatsService } = load(path.join(__dirname, '../src/modules/stats/stats.service.ts'), {
        '@remnawave/xtls-sdk-nestjs': { InjectXtls: () => () => {} },
        '@common/types': { ok: response => ({ isOk: true, response }), fail: error => ({ isOk: false, ...error }) },
        '@common/utils/get-system-stats': {},
        '@libs/contracts/constants': { ERRORS: { FAILED_TO_GET_USERS_STATS: { code: 'COLLECTION_FAILED' } } },
        '../_plugin/queries/get-torrent-blocker-reports-count': {},
        '../network-stats/queries/get-interface-stats/get-interface-stats.query': {},
        '../xray-core/xray-process.service': {},
        '../xray-core/core-incarnation': {},
        '../xray-core/profile-traffic': {},
        './models': { GetUsersIpListResponseModel: Users, GetUserIpListResponseModel: Ips },
    });
    const instance = new StatsService({ stats }, {}, {}, {});
    instance.logger = { error() {}, warn() {} };
    return instance;
}
module.exports = { service };

test('SDK errors and malformed responses cannot masquerade as an empty successful scan', async () => {
    for (const response of [{ isOk: false }, { isOk: true, data: {} }, { isOk: true, data: { users: null } }]) {
        const instance = service({ getUsersStats: async () => response });
        assert.equal((await instance.getUsersIpList()).isOk, false);
        assert.equal((await instance.getUserIpList('45')).isOk, false);
    }
    const instance = service({ getUsersStats: async () => { throw Error('RPC unavailable'); } });
    assert.equal((await instance.getUsersIpList()).isOk, false);
    const empty = service({ getUsersStats: async (...args) => {
        assert.deepEqual(args, [false, false]);
        return { isOk: true, data: { users: [] } };
    } });
    const result = await empty.getUsersIpList();
    assert.equal(result.isOk, true);
    assert.deepEqual(result.response.users, []);
});

test('per-user inspection includes device and host sessions and uses the most recent sighting', async () => {
    const ip = (value, time) => ({ ip: value, lastSeen: new Date(time) });
    const instance = service({ getUsersStats: async () => ({ isOk: true, data: { users: [
        { userId: '45', ips: [ip('127.0.0.1', 1000)] },
        { userId: '45~' + 'a'.repeat(24), ips: [ip('127.0.0.1', 2000)] },
        { userId: '45~' + 'b'.repeat(24) + '~h' + 'c'.repeat(32), ips: [ip('::1', 3000)] },
        { userId: '46', ips: [ip('127.0.0.2', 4000)] },
    ] } }) });
    const result = await instance.getUserIpList('45');
    assert.equal(result.isOk, true);
    assert.deepEqual(result.response.ips, [ip('127.0.0.1', 2000), ip('::1', 3000)]);
});
