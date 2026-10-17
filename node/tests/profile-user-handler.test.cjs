const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Metadata } = require('nice-grpc');
const load = require('./load-typescript.cjs');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function fixture(bindings = [A, B]) {
    const calls = [], users = new Map();
    let failB = false;
    const client = {
        async alterInbound(request, options) {
            const binding = options.metadata.get('x-remnacust-profile-binding');
            calls.push({ binding, request, signal: options.signal, retired: options.metadata.get('x-remnacust-retired-user-removal') });
            if (binding === B && failB) throw Error('second binding unavailable');
            const { AddUserOperation, RemoveUserOperation } = require('@remnawave/xtls-sdk/build/src/xray-protos/app/proxyman/command/command');
            if (request.operation.type.endsWith('AddUserOperation')) {
                const operation = AddUserOperation.decode(request.operation.value);
                if (users.has(binding)) throw Error('already exists');
                users.set(binding, operation.user);
            } else {
                const operation = RemoveUserOperation.decode(request.operation.value);
                if (users.get(binding)?.email === operation.email) users.delete(binding);
            }
            return {};
        },
        async getInboundUsers(request, options) {
            const binding = options.metadata.get('x-remnacust-profile-binding');
            return { users: users.has(binding) ? [users.get(binding)] : [] };
        },
    };
    const methods = ['addVlessUser', 'addTrojanUser', 'addShadowsocksUser', 'addShadowsocks2022User', 'addHysteriaUser', 'removeUser'];
    const legacy = [];
    const api = { channel: {}, handler: Object.fromEntries(methods.map(method => [method, async (...args) => {
        legacy.push({ method, args }); return { isOk: true, data: {} };
    }])) };
    const { ProfileUserHandler } = load(path.join(__dirname, '../src/modules/handler/profile-user-handler.ts'), {
        'nice-grpc': { Metadata, createClient: () => client },
        './masque-user': { addMasqueUser: async (...args) => { legacy.push({ method: 'masque', args }); return { isOk: true, data: {} }; } },
    });
    return { handler: new ProfileUserHandler(api, () => bindings), calls, users, legacy,
        failSecond(value) { failB = value; } };
}
const input = { tag: 'SAME', username: 'device-user', level: 0,
    uuid: '33333333-3333-4333-8333-333333333333', flow: '' };

test('all current user protocols address every binding over the private channel', async () => {
    const variants = [
        ['addVlessUser', input],
        ['addTrojanUser', { ...input, password: 'password' }],
        ['addShadowsocksUser', { ...input, password: 'password', cipherType: 5, ivCheck: false }],
        ['addShadowsocks2022User', { ...input, key: 'key' }],
        ['addHysteriaUser', input],
        ['addMasqueUser', { ...input, password: 'password' }],
    ];
    for (const [method, data] of variants) {
        const f = fixture();
        assert.equal((await f.handler[method](data)).isOk, true);
        assert.deepEqual(f.calls.map(call => call.binding), [A, B]);
        assert.equal(f.calls[0].signal, f.calls[1].signal, 'one deadline bounds the entire operation');
        assert.equal(f.legacy.length, 0);
        assert.equal((await f.handler.removeUser(input.tag, input.username)).isOk, true);
        assert.equal(f.users.size, 0);
    }
});

test('retry after partial addition verifies the exact credential before accepting an existing user', async () => {
    const f = fixture(); f.failSecond(true);
    assert.equal((await f.handler.addVlessUser(input)).isOk, false);
    assert.equal(f.users.size, 1);
    f.failSecond(false);
    assert.equal((await f.handler.addVlessUser(input)).isOk, true);
    assert.equal(f.users.size, 2);
    assert.equal((await f.handler.addVlessUser({ ...input, uuid: A })).isOk, false,
        'an unrelated credential with the same email must not become a successful retry');
});

test('legacy configurations continue using the existing SDK without binding metadata', async () => {
    const f = fixture([]);
    assert.equal((await f.handler.addVlessUser(input)).isOk, true);
    assert.equal((await f.handler.removeUser(input.tag, input.username)).isOk, true);
    assert.deepEqual(f.legacy.map(call => call.method), ['addVlessUser', 'removeUser']);
    assert.equal(f.calls.length, 0);
});

test('malformed binding indexes cannot fall back to an unscoped mutation', async () => {
    const f = fixture(['invalid']);
    assert.equal((await f.handler.addVlessUser(input)).isOk, false);
    assert.equal((await f.handler.removeUser(input.tag, input.username)).isOk, false);
    assert.equal(f.calls.length, 0); assert.equal(f.legacy.length, 0);
});

test('explicit retired-user removal addresses the node owner without a live binding',async()=>{
    const f=fixture([]);
    assert.equal((await f.handler.removeRetiredUser(input.username)).isOk,true);
    assert.equal(f.calls.length,1);
    assert.equal(f.calls[0].binding,undefined);
    assert.equal(f.calls[0].retired,'1');
    assert.equal(f.calls[0].request.tag,'');
    assert.equal(f.legacy.length,0);
});
