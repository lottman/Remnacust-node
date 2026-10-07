const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(
    path.join(__dirname, '../src/modules/xray-core/host-policy.controller.ts'),
    'utf8',
);
const output = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        experimentalDecorators: true,
    },
}).outputText;
const ref = { exports: {} };
new Function('require', 'module', 'exports', output)(
    (id) =>
        id === '@common/utils/destination-rule'
            ? require('../../backend-3.4.4-xera/tests/load-typescript.cjs')(path.resolve(__dirname, '../src/common/utils/destination-rule.ts'))
            : id === '@common/guards/jwt-guards'
            ? { JwtDefaultGuard: class {} }
            : id === './xray-process.service'
              ? {}
              : require(id),
    ref,
    ref.exports,
);
const schema = ref.exports.hostPolicySchema;
const id = '1'.repeat(32);
const email = '42~' + 'a'.repeat(24) + '~h' + id;
const valid = () => ({
    version: 'xera-host-policy-v2',
    protectedInbounds: ['shared'],
    hosts: {
        [id]: {
            inboundTag: 'shared',
            allowedIdentities: { [email]: true },
            groups: ['host:a', 'tag:a', 'tag:b'],
            domainMode: 'OFF',
            domains: [],
        },
    },
    groups: Object.fromEntries(
        ['host:a', 'tag:a', 'tag:b'].map((key) => [
            key,
            { bytesPerSecond: 0, totalBytesPerSecond: 100, blockedOwners: {}, blockAll: false },
        ]),
    ),
});
test('host v2 accepts independent aggregate limits and multiple groups', () =>
    assert(schema.safeParse(valid()).success));
test('host v2 rejects cross-host identities, undefined groups, wrong inbound and node-wide v1 payload', () => {
    for (const mutate of [
        (p) => (p.hosts[id].allowedIdentities = { [email.slice(0, -1) + '2']: true }),
        (p) => delete p.groups['tag:b'],
        (p) => (p.protectedInbounds = []),
        (p) => (p.groups['host:a'].bytesPerSecond = -1),
        (p) => (p.version = 'xera-host-policy-v1'),
    ]) {
        const p = valid();
        mutate(p);
        assert.equal(schema.safeParse(p).success, false);
    }
    assert.equal(
        schema.safeParse({ group: 'node', bytesPerSecond: 1, blockedOwners: {}, blockAll: false })
            .success,
        false,
    );
});

test('node accepts canonical IP/CIDR and rejects malformed domain rules', () => {
    const p = valid();
    p.hosts[id].domainMode = 'ALLOW_ONLY';
    p.hosts[id].domains = ['t.me','149.154.160.0/20','2001:db8::/32','xn--e1afmkfd.xn--p1ai'];
    assert.equal(schema.safeParse(p).success, true);
    for (const value of ['geosite:telegram','999.1.1.1','1.2.3.4/33','a..b','a.com:443']) {
        p.hosts[id].domains = [value];
        assert.equal(schema.safeParse(p).success, false, value);
    }
});
