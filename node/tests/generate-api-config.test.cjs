const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const load = (file, imports = {}) => {
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} };
    new Function('require', 'module', 'exports', output)(id => {
        if (!Object.hasOwn(imports, id)) throw Error('Unexpected import: ' + id);
        return imports[id];
    }, module, module.exports);
    return module.exports;
};
const constants = load(path.join(__dirname, '../libs/contract/constants/xray/stats.ts'));
const generator = capability => load(path.join(__dirname, '../src/common/utils/generate-api-config.ts'), {
    sockdestroy: { hasCapNetAdmin: () => capability },
    '@libs/contracts/constants': { XRAY_INTERNAL_FULL_WEBHOOK_PATH: '/fixture' },
    '@libs/contracts/constants/xray': constants,
}).generateApiConfig;
const args = config => ({
    config,
    torrentBlockerState: { enabled: false, includeRuleTags: new Set(), rulePosition: 0 },
    internal: { socketPath: '/private/hook', token: 'fixture', xtlsApiSocketPath: '/private/api' },
});

test('node keeps every configured policy level and enforces accounting on each', () => {
    const config = {
        policy: { levels: {
            '0': { handshake: 17, connIdle: 110 },
            '2': { handshake: 31, connIdle: 240, uplinkOnly: 5, downlinkOnly: 9, bufferSize: 512, statsUserUplink: false },
            '17': { connIdle: 300, statsUserOnline: true },
        } },
        inbounds: [{ tag: 'public' }], outbounds: [{ tag: 'direct' }],
        routing: { rules: [{ outboundTag: 'direct' }] },
    };
    const before = structuredClone(config);
    for (const capability of [false, true]) {
        const result = generator(capability)(args(config));
        for (const level of ['0', '2', '17']) {
            assert.deepEqual(result.policy.levels[level], {
                ...config.policy.levels[level], statsUserUplink: true, statsUserDownlink: true, statsUserOnline: capability,
            });
        }
        assert.deepEqual(result.policy.system, constants.XRAY_DEFAULT_POLICY_MODEL.policy.system);
        assert.equal(result.inbounds[0].listen, '/private/api,0600');
        assert.deepEqual(result.routing.rules[0], constants.XRAY_ROUTING_RULES_MODEL);
        assert.deepEqual(result.api, constants.XRAY_DEFAULT_API_MODEL.api);
    }
    assert.deepEqual(config, before, 'Generating the private API must not change the saved profile');
});

test('profiles with only nonzero levels retain default accounting and their settings', () => {
    const result = generator(false)(args({ policy: { levels: { '5': { connIdle: 71 } } } }));
    assert.deepEqual(result.policy.levels['0'], { statsUserUplink: true, statsUserDownlink: true, statsUserOnline: false });
    assert.equal(result.policy.levels['5'].connIdle, 71);
    assert.equal(result.policy.levels['5'].statsUserUplink, true);
    assert.equal(result.policy.levels['5'].statsUserDownlink, true);
});

test('Lua routing keeps its original code and uses a private API socket without injected rules or inbounds', () => {
    for (const script of ['route.lua', '/etc/xray/scripts/route.lua']) {
        const config = { routing: { script }, inbounds: [{ tag: 'public' }], outbounds: [{ tag: 'direct' }] };
        const before = structuredClone(config);
        const result = generator(false)(args(config));
        assert.deepEqual(result.routing, { script });
        assert.equal(Object.hasOwn(result.routing, 'rules'), false);
        assert.deepEqual(result.inbounds, config.inbounds);
        assert.deepEqual(result.api, { ...constants.XRAY_DEFAULT_API_MODEL.api, listen: '/private/api,0600' });
        assert.deepEqual(config, before);
    }
});

test('a rules-based blocker cannot silently override or disable Lua routing', () => {
    const request = args({ routing: { script: 'route.lua' } });
    request.torrentBlockerState.enabled = true;
    assert.throws(() => generator(false)(request), /Lua routing cannot use the rules-based Torrent Blocker/);
    assert.deepEqual(request.config, { routing: { script: 'route.lua' } });
});
