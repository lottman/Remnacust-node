const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const promises = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const load = require('./load-typescript.cjs');
const root = path.join(__dirname, '../src/modules/xray-core');

async function fixture(t, paused = false) {
    const directory = await promises.mkdtemp(path.join(os.tmpdir(), 'remnacust-lifecycle-'));
    await promises.chmod(directory, 0o700);
    t.after(() => promises.rm(directory, { recursive: true, force: true }));
    const checkpoint = path.join(directory, 'checkpoint.pb');
    await promises.writeFile(checkpoint, 'fixture-native-state', { mode: 0o600 });
    const state = { up: false, paused, starts: 0, stops: 0, capabilityReads: 0, warnings: 0, timers: new Set(), timeline: [], now: 0 };
    const management = load(path.join(root, 'core-management.ts'));
    const watchdog = load(path.join(root, 'core-crash-watchdog.ts'), {}, {
        setTimeout: callback => { const timer = { callback, unref() {} }; state.timers.add(timer); return timer; },
        clearTimeout: timer => state.timers.delete(timer),
        performance: { now: () => state.now },
    });
    const file = path.join(root, 'xray.service.ts');
    const mocks = {};
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)) {
        if (!match[1].startsWith('node:')) mocks[match[1]] = {};
    }
    Object.assign(mocks, {
        '@nestjs/common': { Injectable: () => x => x, Logger: class { log() {} error() {} warn() { state.warnings++; } } },
        '@remnawave/xtls-sdk-nestjs': { InjectXtls: () => () => {} },
        'enhanced-ms': { __esModule: true, default: () => '' },
        '@common/types': { ok: response => ({ response }) },
        './core-crash-watchdog': watchdog,
        './core-management': management,
        './core-boot-recovery': load(path.join(root, 'core-boot-recovery.ts')),
        './live-core.service': { LIVE_CORE_CHECKPOINT: checkpoint },
        './port-plan-state': { PortPlanStateStore: class {} },
        './managed-core.store': { validateCoreConfig: async () => {} },
        './models': { StopXrayResponseModel: class { constructor(isStopped) { this.isStopped = isStopped; } } },
        '../_plugin/commands/run-pre-start/run-pre-start.command': { RunPreStartCommand: class {} },
    });
    const { XrayService } = load(file, mocks, { __RWNODE_VERSION__: 'fixture' });
    const process = {
        isControlAvailable: () => true, getCoreVersion: async () => '1.1.13',
        getStatus: async () => ({ up: state.up, pid: state.up ? 42 : null, raw: state.unknown ? '' : state.up ? 'true 42' : 'false -1' }),
        start: async () => { state.timeline.push('start'); state.starts++; state.up = true; },
        stop: async () => { state.timeline.push('stop'); state.stops++; state.up = false; },
        recoveryReady: async () => state.up,
    };
    const managed = {
        root: directory, link: '/fixture/core',
        load: async () => ({ mode: 'profile', paused: state.paused }),
        phase: async () => {}, finish: async () => {}, restore: async () => {},
        select: async selection => { state.timeline.push('paused:' + selection.paused); state.paused = selection.paused; },
    };
    const live = { supported: async () => { state.capabilityReads++; return true; } };
    const config = { getOrThrow: key => key === 'DISABLE_HASHED_SET_CHECK' ? false : '/private/' + key };
    const service = new XrayService({}, process, {}, {}, managed, { stop: async () => {} },
        { cleanup() {}, getXrayConfig: async () => ({}), getProfileInput: () => null }, config, {},
        { execute: async () => {} }, {}, live);
    t.after(() => service.onModuleDestroy());
    return { state, service, process, management };
}

test('the real service arms after offline boot, keeps up ticks cheap and updates online state only after crash readiness', async t => {
    const f = await fixture(t);
    await f.service.onApplicationBootstrap();
    assert.equal(f.state.starts, 1); assert.equal(f.service.isXrayOnline, true);
    assert.equal(f.service.restoredUnclaimedConfiguration, true);
    f.state.capabilityReads = 0;
    for (let i = 0; i < 1000; i++) await f.service.watchdog.tick();
    assert.equal(f.state.capabilityReads, 0);
    assert.equal(f.state.starts, 1);
    f.state.up = false;
    let ready, release;
    const checking = new Promise(resolve => { ready = resolve; });
    f.process.recoveryReady = async () => { ready(); return new Promise(resolve => { release = resolve; }); };
    const pending = f.service.watchdog.tick(); await checking;
    assert.equal(f.service.isXrayOnline, false);
    release(true); await pending;
    assert.equal(f.service.isXrayOnline, true);
    assert.equal(f.state.starts, 2);
    assert.equal(f.state.capabilityReads, 1);
});

test('persisted admin pause survives bootstrap and ordinary stop cannot be undone by polling', async t => {
    const paused = await fixture(t, true);
    await paused.service.onApplicationBootstrap();
    await paused.service.watchdog.tick();
    assert.equal(paused.state.starts, 0);
    const f = await fixture(t);
    await f.service.onApplicationBootstrap();
    assert.equal((await f.service.stopXray({})).response.isStopped, true);
    for (let i = 0; i < 10; i++) await f.service.watchdog.tick();
    assert.equal(f.state.starts, 1);
    assert.equal(f.service.isXrayOnline, false);
});

test('managed stop journals pause before stopping and a successful managed start rearms recovery', async t => {
    const f = await fixture(t);
    await f.service.onApplicationBootstrap(); f.state.timeline = [];
    await f.service.executeManagedCoreAction({ id: 'stop-fixture', action: 'stop' });
    assert.deepEqual(f.state.timeline.slice(0, 2), ['paused:true', 'stop']);
    await f.service.watchdog.tick(); assert.equal(f.state.starts, 1);
    f.service.getXrayInternalStatus = async () => ({ isStarted: true });
    await f.service.executeManagedCoreAction({ id: 'start-fixture', action: 'start' });
    assert.equal(f.state.paused, false);
    f.state.up = false; await f.service.watchdog.tick();
    assert.equal(f.state.starts, 3);
    assert.equal(f.service.isXrayOnline, true);
});

test('unknown s6 observations leave the core alone and shutdown removes timers without rearming', async t => {
    const f = await fixture(t);
    await f.service.onApplicationBootstrap();
    f.state.up = false; f.state.unknown = true; f.state.capabilityReads = 0;
    await f.service.watchdog.tick();
    assert.equal(f.state.starts, 1); assert.equal(f.state.capabilityReads, 0);
    assert.equal(f.service.isXrayOnline, true);
    const callback = [...f.state.timers][0].callback;
    f.service.onModuleDestroy(); callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.state.timers.size, 0);
    f.service.watchdog.arm(); await f.service.watchdog.tick();
    assert.equal(f.state.starts, 1);
});
