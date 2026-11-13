const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const load = require('./load-typescript.cjs');
const root = path.join(__dirname, '../src/modules/xray-core');
const { requestedCoreFlavor, CORE_FLAVOR_PATHS, assertCoreFlavorConfiguration } = load(
    path.join(root, 'core-flavor.ts'),
);
const { CoreLoaderService } = load(path.join(root, 'core-loader.service.ts'), {
    '@common/utils/download-file': {},
    '@common/utils/get-elapsed-time': {},
    '@common/utils/read-core-version': {},
    './managed-core.store': {},
    'pretty-bytes': { default: () => '' },
});

function loaderFixture() {
    const binaries = Object.fromEntries(
        Object.entries(CORE_FLAVOR_PATHS).map(([flavor, path]) => [
            path,
            { path, sha256: flavor, version: 'Xray ' + flavor },
        ]),
    );
    let selected = binaries[CORE_FLAVOR_PATHS.custom];
    const state = { mode: 'profile', paused: false };
    const calls = [];
    const store = {
        identity: async (path) => {
            if (!path) return selected;
            if (!binaries[path]) throw Error('missing executable');
            return binaries[path];
        },
        load: async () => structuredClone(state),
        select: async (selection) => {
            calls.push('select');
            Object.assign(state, selection);
            selected = selection.binary;
        },
        applyOverride: async () => {
            calls.push('legacy');
            return true;
        },
    };
    const loader = new CoreLoaderService(store);
    loader.verifyFlavorPolicy = async () => calls.push('policy');
    return { loader, state, calls, binaries, store };
}

test('optional flavor preserves legacy behavior and explicit flavor cannot hide a URL override or accept invalid enums', async () => {
    for (const data of [undefined, null, {}, { core: { url: 'https://example.test/core' } }])
        assert.equal(requestedCoreFlavor(data), undefined);
    for (const data of [
        { remnacustCoreFlavor: null },
        { remnacustCoreFlavor: 'stock' },
        { remnacustCoreFlavor: 'default', core: {} },
    ])
        assert.throws(() => requestedCoreFlavor(data), /flavor/);
    const f = loaderFixture();
    await f.loader.prepare(undefined);
    assert.deepEqual(f.calls, ['legacy']);
    await f.loader.prepare({ remnacustCoreFlavor: 'default' });
    assert.deepEqual(f.calls, ['legacy', 'policy', 'select']);
    assert.equal(f.state.mode, 'bundled');
    assert.equal(f.state.binary.path, CORE_FLAVOR_PATHS.default);
});

test('preflight cannot mutate selection, bypass missing binary or override a conflicting manual binary', async () => {
    const f = loaderFixture();
    assert.equal((await f.loader.inspectFlavor({ remnacustCoreFlavor: 'default' })).changed, true);
    assert.deepEqual(f.calls, []);
    f.state.mode = 'managed';
    f.state.binary = { path: '/private/manual', sha256: 'manual' };
    f.binaries['/private/manual'] = { ...f.state.binary, version: 'Xray third-party' };
    await assert.rejects(f.loader.prepare({ remnacustCoreFlavor: 'default' }), /profile mode/);
    assert.deepEqual(f.calls, []);
    f.state.mode = 'profile';
    delete f.binaries[CORE_FLAVOR_PATHS.default];
    await assert.rejects(f.loader.prepare({ remnacustCoreFlavor: 'default' }), /missing/);
    assert.deepEqual(f.calls, []);
});

test('custom mode preserves an integrity-verified installed Remnacust version and managed actions accept the same flavor', async (t) => {
    const os = require('node:os'),
        { createHash } = require('node:crypto');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remnacust-managed-flavor-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'installed'),
        bytes = Buffer.from('xera-http xera-host-policy-v2 installed fixture');
    fs.writeFileSync(file, bytes);
    const installed = {
        path: file,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        version: 'Xray 1.1.14 Remnacust-1.1.14',
    };
    const f = loaderFixture();
    f.binaries[file] = installed;
    await f.store.select({ mode: 'managed', paused: false, binary: installed });
    f.calls.length = 0;
    assert.equal((await f.loader.inspectFlavor({ remnacustCoreFlavor: 'custom' })).changed, false);
    await f.loader.prepare({ remnacustCoreFlavor: 'custom' });
    assert.equal(f.state.mode, 'managed');
    assert.equal(f.state.binary.path, file);
    assert.equal(await f.loader.acceptsFlavor({ remnacustCoreFlavor: 'custom' }, installed), true);
    assert.equal(
        await f.loader.acceptsFlavor({ remnacustCoreFlavor: 'default' }, installed),
        false,
    );
    assert.deepEqual(await f.loader.flavors(installed, installed), {
        supportedFlavors: ['custom', 'default'],
        selectedFlavor: 'custom',
        runningFlavor: 'custom',
    });
    await assert.rejects(f.loader.prepare({ remnacustCoreFlavor: 'default' }), /profile mode/);
    assert.equal(f.state.binary.path, file);
    f.binaries[file] = { ...installed, sha256: '0'.repeat(64) };
    await assert.rejects(f.loader.prepare({ remnacustCoreFlavor: 'custom' }), /integrity/);
});

test('stock JSON cannot silently ignore mandatory quotas, XERA/olcRTC or security webhooks', () => {
    for (const config of [
        { remnacustUserQuotaRequired: true },
        { routing: { rules: [{ webhook: { url: 'http://private' } }] } },
        { inbounds: [{ streamSettings: { xeraHttpSettings: {} } }] },
        { outbounds: [{ protocol: 'olcrtc' }] },
    ]) {
        assert.throws(() => assertCoreFlavorConfiguration('default', config), /custom|quota/i);
        assert.doesNotThrow(() => assertCoreFlavorConfiguration('custom', config));
    }
    assert.doesNotThrow(() =>
        assertCoreFlavorConfiguration('default', { inbounds: [{ protocol: 'socks' }] }),
    );
});

test('saved policy rejection leaves selection untouched and status classifies by actual image hash, not link name', async () => {
    const f = loaderFixture();
    f.loader.verifyFlavorPolicy = async () => {
        throw Error('durable quota required');
    };
    await assert.rejects(f.loader.prepare({ remnacustCoreFlavor: 'default' }), /durable quota/);
    assert.deepEqual(f.calls, []);
    const status = await f.loader.flavors(
        { path: '/new/link', sha256: 'default' },
        { path: '/proc/42/exe', sha256: 'custom' },
    );
    assert.deepEqual(status, {
        supportedFlavors: ['custom', 'default'],
        selectedFlavor: 'default',
        runningFlavor: 'custom',
    });
    assert.equal(
        (await f.loader.flavors(null, { path: '/proc/43/exe', sha256: 'manual' })).runningFlavor,
        null,
    );
    delete f.binaries[CORE_FLAVOR_PATHS.default];
    assert.deepEqual((await f.loader.flavors(null, null)).supportedFlavors, ['custom']);
});

function serviceFixture() {
    const file = path.join(root, 'xray.service.ts');
    const mocks = {};
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g))
        if (!match[1].startsWith('node:')) mocks[match[1]] = {};
    const calls = [],
        state = {
            online: true,
            validationError: null,
            required: false,
            targetSupported: false,
            ready: true,
        };
    const models = load(path.join(root, 'models/start-xray.response.model.ts'));
    Object.assign(mocks, {
        '@nestjs/common': { Injectable: () => (x) => x, Logger: class {} },
        '@remnawave/xtls-sdk-nestjs': { InjectXtls: () => () => {} },
        '@common/types': { ok: (response) => ({ isOk: true, response }) },
        '@common/utils/get-system-stats': { getSystemInfo: () => ({}), getSystemStats: () => ({}) },
        '@common/utils/generate-api-config': { generateApiConfig: ({ config }) => config },
        'enhanced-ms': { __esModule: true, default: () => '' },
        './managed-core.store': {
            validateCoreConfig: async (binary) => {
                calls.push('validate:' + binary);
                if (state.validationError) throw Error(state.validationError);
            },
        },
        './models': models,
        '../network-stats/queries/get-interface-stats/get-interface-stats.query': {
            GetInterfaceStatsQuery: class {},
        },
        '../_plugin/queries/get-torrent-blocker-state': { GetTorrentBlockerStateQuery: class {} },
        '../_plugin/commands/run-post-start/run-post-start.command': {
            RunPostStartCommand: class {},
        },
    });
    const { XrayService } = load(file, mocks);
    const service = Object.create(XrayService.prototype);
    const target = {
        flavor: 'default',
        binary: { path: CORE_FLAVOR_PATHS.default, sha256: 'default' },
        changed: true,
    };
    Object.assign(service, {
        xrayPath: '/active',
        xrayVersion: 'custom',
        nodeVersion: 'fixture',
        isXrayOnline: true,
        queryBus: { execute: async () => ({ enabled: state.torrent ?? false }) },
        commandBus: { execute: async () => calls.push('post') },
        logger: { log() {}, warn() {}, error() {} },
        internal: {},
        managedCore: {
            identity: async () => ({ path: '/active', sha256: 'custom' }),
            root: '/private',
            load: async () => ({ paused: false }),
            begin: async () => {
                calls.push('journal');
                return true;
            },
            restore: async () => calls.push('restore'),
            finish: async (status) => calls.push(status),
        },
        coreLoaderService: {
            inspectFlavor: async () => target,
            verifyFlavorPolicy: async () => calls.push('policy'),
            prepare: async () => calls.push('select'),
        },
        portPlans: { read: async () => (state.required ? { required: true } : null) },
        integrations: {
            sync: async () => {
                calls.push('integrations');
                return {};
            },
        },
        liveCore: {
            supported: async (binary) => {
                calls.push('capability:' + binary);
                return state.targetSupported;
            },
        },
        internalService: {
            cleanup: () => calls.push('clear-users'),
            setXrayConfig: () => calls.push('boot-config'),
            snapshotConfiguration: () => () => calls.push('restore-configuration'),
            isNeedRestartCore: () => false,
            extractUsersFromConfig: async () => calls.push('users'),
        },
        xtlsSdk: { stats: { getSysStats: async () => ({ isOk: true }) } },
        geodataService: { prepare: async () => {} },
        restartXrayProcess: async () => {
            calls.push('restart');
            return { error: state.restartError ?? null };
        },
        getXrayInternalStatus: async () => ({ isStarted: state.ready, error: null }),
        refreshXrayVersion: async () => {},
        xrayProcess: {
            getStatus: async () => ({ up: true, pid: 42 }),
            stop: async () => calls.push('stop'),
        },
    });
    const request = {
        xrayConfig: { geodata: { remnacustCoreFlavor: 'default' }, inbounds: [{ tag: 'in' }] },
        internals: { hashes: {}, forceRestart: false },
    };
    return {
        service,
        state,
        calls,
        request,
        target,
        run: () => service.startXrayLocked(request, '127.0.0.1'),
    };
}

test('flavor validation, saved live plans and custom-only plugins reject before effects', async () => {
    for (const change of [
        (f) => (f.state.validationError = 'saved quota requires custom'),
        (f) => {
            f.state.required = true;
            f.request.internals.portPlan = { enabled: false };
        },
        (f) => (f.state.torrent = true),
    ]) {
        const f = serviceFixture();
        change(f);
        assert.ok((await f.run()).response.error);
        for (const effect of ['integrations', 'journal', 'select', 'users', 'restart'])
            assert.equal(f.calls.includes(effect), false, effect);
    }
});

test('a divergent or unavailable running identity cannot receive a flavor apply and rejected config preserves online state', async () => {
    for (const configure of [
        (f) => {
            f.service.managedCore.identity = async (binary) => ({
                sha256: binary ? 'other-process' : 'custom',
            });
        },
        (f) => {
            f.service.xrayProcess.getStatus = async () => ({ up: true, pid: null });
        },
        (f) => {
            f.service.coreLoaderService.inspectFlavor = async () => {
                throw Error('incompatible default configuration');
            };
        },
    ]) {
        const f = serviceFixture();
        configure(f);
        const result = await f.run();
        assert(result.response.error);
        assert.equal(result.response.isStarted, true);
        for (const effect of ['integrations', 'journal', 'select', 'users', 'restart'])
            assert(!f.calls.includes(effect), effect);
    }
});

test('legacy profile graphs inherit the global root flavor; explicit conflicts or URL overrides fail before effects', async () => {
    const f = serviceFixture();
    f.request.xrayConfig.geodata.remnacustCoreFlavor = 'custom';
    f.request.xrayConfig.remnacustProfileGraphs = { graphs: [{ config: { geodata: {} } }] };
    assert.match((await f.run()).response.error, /versioned port plan/);
    for (const geodata of [
        { remnacustCoreFlavor: 'default' },
        { core: { url: 'https://example.test/core' } },
    ]) {
        const conflict = serviceFixture();
        conflict.request.xrayConfig.geodata.remnacustCoreFlavor = 'custom';
        conflict.request.xrayConfig.remnacustProfileGraphs = { graphs: [{ config: { geodata } }] };
        assert.match((await conflict.run()).response.error, /global core flavor/);
        assert.deepEqual(conflict.calls, []);
    }
});

test('a changed flavor bypasses unchanged hashes and cannot live-apply to the previous process', async () => {
    const f = serviceFixture();
    f.state.targetSupported = true;
    f.service.liveCore.prepareRestart = async () => f.calls.push('checkpoint');
    const result = await f.run();
    assert.equal(result.response.error, null);
    for (const action of ['journal', 'select', 'restart', 'succeeded'])
        assert(f.calls.includes(action), action);
    assert(
        f.calls.indexOf('validate:' + CORE_FLAVOR_PATHS.default) < f.calls.indexOf('integrations'),
    );
    assert(f.calls.indexOf('journal') < f.calls.indexOf('select'));
});

test('failed flavor restart restores the journal and old process, without committing a successful selection', async () => {
    const f = serviceFixture();
    let count = 0;
    f.service.restartXrayProcess = async () => {
        f.calls.push('restart');
        return { error: ++count === 1 ? 'target failed' : null };
    };
    assert.equal((await f.run()).response.error, 'target failed');
    assert(f.calls.indexOf('restore') > f.calls.indexOf('restart'));
    assert(f.calls.indexOf('restore-configuration') < f.calls.indexOf('restore'));
    assert.equal(count, 2);
    assert(f.calls.includes('rolled-back'));
    assert(!f.calls.includes('succeeded'));
});

test('failed recovery reports stopped listeners instead of claiming the previous process survived', async () => {
    const f = serviceFixture();
    f.state.restartError = 'target failed';
    f.service.managedCore.restore = async () => {
        throw Error('storage unavailable');
    };
    const result = await f.run();
    assert.equal(result.response.isStarted, false);
    assert.equal(result.response.version, null);
    assert.match(result.response.error, /recovery failed/);
    assert(f.calls.includes('stop'));
});

test('actual internal snapshot restores the old config, user hashes and profile bindings after replacement cleanup', async () => {
    const { InternalService } = load(
        path.join(__dirname, '../src/modules/internal/internal.service.ts'),
        {
            '@libs/contracts/commands': {},
            'enhanced-ms': { __esModule: true, default: () => '' },
        },
    );
    const internal = new InternalService();
    const config = { inbounds: [{ tag: 'old', settings: { clients: [{ id: 'old-user' }] } }] };
    const hashes = {
        emptyConfig: 'old-hash',
        inbounds: [{ tag: 'old', usersCount: 1, hash: 'old-user-hash' }],
    };
    await internal.extractUsersFromConfig(hashes, config);
    const before = internal.inboundsHashMap.get('old').hash64String;
    const restore = internal.snapshotConfiguration();
    await internal.extractUsersFromConfig(
        { emptyConfig: 'new-hash', inbounds: [] },
        { inbounds: [] },
    );
    restore();
    assert.deepEqual(await internal.getXrayConfig(), config);
    assert.equal(internal.emptyConfigHash, hashes.emptyConfig);
    assert.equal(internal.inboundsHashMap.get('old').hash64String, before);
    assert(internal.hasConfiguration());
});
