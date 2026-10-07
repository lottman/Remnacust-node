const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

class Response { constructor(success, message) { this.success = success; this.message = message; } }
const ref = { exports: {} };
const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/modules/handler/handler.service.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
}).outputText;
new Function('require', 'module', 'exports', output)((id) => {
    if (id === 'enhanced-ms') return { default: () => '' };
    if (id === '@nestjs/common') return { Injectable: () => (value) => value, Logger: class { log() {} debug() {} error() {} } };
    if (id === '@remnawave/xtls-sdk-nestjs') return { InjectXtls: () => () => {} };
    if (id === '@common/types') return { ok: (response) => ({ isOk: true, response }), fail: (error) => ({ isOk: false, error }) };
    if (id.endsWith('/errors')) return { ERRORS: { INTERNAL_SERVER_ERROR: { code: 'error' } } };
    if (id === './masque-user') return { addMasqueUser: (api, data) => api.handler.addMasqueUser(data) };
    if (id === './models') return { AddUserResponseModel: Response, RemoveUserResponseModel: Response };
    return {};
}, ref, ref.exports);
const { HandlerService } = ref.exports;

function fixture({ removeFails = false, addFails = false, oldTags = ['old', 'new'] } = {}) {
    const present = new Set(oldTags);
    const calls = [];
    const state = {
        addXtlsConfigInbound() {}, getXtlsConfigInbounds: () => new Set(['old', 'new']),
        hasUserInInbound: (tag) => present.has(tag),
        removeUserFromInbound: async (tag) => { calls.push(['cache-remove', tag]); present.delete(tag); },
        addUserToInbound: async (tag) => { present.add(tag); },
    };
    const service = new HandlerService({ handler: {
        removeUser: async (tag) => { calls.push(['remove', tag]); return { isOk: !removeFails, message: 'remove failed' }; },
        addMasqueUser: async ({ tag, username, password }) => { calls.push(['masque', tag, username, password]); return { isOk: !addFails, message: 'add failed' }; },
        addShadowsocks2022User: async ({ tag, username, key }) => { calls.push(['ss2022', tag, username, key]); return { isOk: !addFails, message: 'add failed' }; },
        addVlessUser: async ({ tag }) => { calls.push(['add', tag]); return { isOk: !addFails, message: 'add failed' }; },
    } }, state, { publish() {} });
    return { service, calls, present };
}
const single = { hashData: { vlessUuid: 'key' }, data: [{ username: '1~device', tag: 'new', type: 'vless', uuid: 'key' }] };
const bulk = { affectedInboundTags: ['new'], users: [{ userData: { userId: '1~device', vlessUuid: 'key', hashUuid: 'key' }, inboundData: [{ tag: 'new', type: 'vless' }] }] };
test('unchanged personal grants do not interrupt active connections', async () => {
    const { service, calls } = fixture({ oldTags: ['new'] });
    assert.equal((await service.addUser(single)).response.success, true);
    assert.deepEqual(calls, []);
});
test('removing one squad clears stale inbound membership', async () => {
    const { service, calls, present } = fixture();
    assert.equal((await service.addUser(single)).response.success, true);
    assert.ok(calls.some(([action, tag]) => action === 'remove' && tag === 'old'));
    assert.deepEqual([...present], ['new']);
});
test('failed removal does not erase cache evidence or grant new access', async () => {
    const { service, calls } = fixture({ removeFails: true });
    assert.equal((await service.addUser(single)).isOk, false);
    assert.deepEqual(calls, [['remove', 'old']]);
});
test('bulk add reports a core failure instead of false success', async () => {
    const { service } = fixture({ addFails: true });
    assert.equal((await service.addUsers(bulk)).isOk, false);
});
test('bulk add reports failed revocation before changing cache', async () => {
    const { service, calls } = fixture({ removeFails: true });
    assert.equal((await service.addUsers(bulk)).isOk, false);
    assert.deepEqual(calls, [['remove', 'old']]);
});

test('MASQUE single add uses the authenticated identity and only caches successful grants', async () => {
    const { service, calls, present } = fixture({ oldTags: [] });
    const data = { hashData: { vlessUuid: 'secret' }, data: [{ type: 'masque', tag: 'new', username: '42~device', password: 'secret' }] };
    assert.equal((await service.addUser(data)).response.success, true);
    assert.deepEqual(calls.filter(([action]) => action === 'masque'), [['masque', 'new', '42~device', 'secret']]);
    assert.equal(present.has('new'), true);
    const failed = fixture({ oldTags: [], addFails: true });
    assert.equal((await failed.service.addUser(data)).response.success, false);
    assert.equal(failed.present.has('new'), false);
});
test('MASQUE bulk add derives the password from the scoped user key', async () => {
    const { service, calls } = fixture({ oldTags: [] });
    const data = { affectedInboundTags: ['new'], users: [{ userData: { userId: '42~device', vlessUuid: 'secret', hashUuid: 'secret' }, inboundData: [{ tag: 'new', type: 'masque' }] }] };
    assert.equal((await service.addUsers(data)).response.success, true);
    assert.deepEqual(calls.filter(([action]) => action === 'masque'), [['masque', 'new', '42~device', 'secret']]);
    const failed = fixture({ oldTags: [], addFails: true });
    assert.equal((await failed.service.addUsers(data)).isOk, false);
    assert.equal(failed.present.has('new'), false);
});

test('SS2022 bulk add uses the key for each inbound and preserves legacy AES-256 callers', async () => {
    const { service, calls } = fixture({ oldTags: [] });
    const password = '12345678901234567890123456789012';
    const key128 = Buffer.from(password).subarray(0,16).toString('base64');
    const key256 = Buffer.from(password).toString('base64');
    const userData = { userId: '42', vlessUuid: 'secret', hashUuid: 'secret', ssPassword: password };
    const data = { affectedInboundTags: ['old','new'], users: [{ userData, inboundData: [
        { tag:'old', type:'shadowsocks22', password:key128 },
        { tag:'new', type:'shadowsocks22', password:key256 },
    ] }] };
    assert.equal((await service.addUsers(data)).response.success, true);
    assert.deepEqual(calls.filter(([action]) => action === 'ss2022'), [
        ['ss2022','old','42',key128], ['ss2022','new','42',key256],
    ]);
    const legacy = fixture({ oldTags: [] });
    assert.equal((await legacy.service.addUsers({ affectedInboundTags:['new'], users:[{ userData, inboundData:[{tag:'new',type:'shadowsocks22'}] }] })).response.success,true);
    assert.deepEqual(legacy.calls.filter(([action]) => action === 'ss2022'), [['ss2022','new','42',key256]]);
});
