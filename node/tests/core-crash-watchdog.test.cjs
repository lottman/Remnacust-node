const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const load = require('./load-typescript.cjs');
const root = path.join(__dirname, '../src/modules/xray-core');
const { CoreCrashWatchdog, CORE_WATCHDOG_WINDOW_MS } = load(path.join(root, 'core-crash-watchdog.ts'));
const { CoreManagementBarrier } = load(path.join(root, 'core-management.ts'));

function fixture() {
    const barrier = new CoreManagementBarrier();
    const state = { now: 0, up: true, paused: false, statusReads: 0, pauseReads: 0, recoveries: 0, stops: 0, warnings: 0, online: [] };
    const options = {
        busy: () => barrier.isBusy(), exclusive: async action => (await barrier.tryRun(action)).entered,
        paused: async () => { state.pauseReads++; return state.paused; },
        status: async () => { state.statusReads++; return state.unknown ? 'unknown' : state.up ? 'up' : 'down'; },
        recover: async () => { state.recoveries++; state.up = true; return true; },
        stop: async () => { state.stops++; state.up = false; },
        online: value => state.online.push(value), warning: () => { state.warnings++; }, now: () => state.now,
    };
    return { state, options, barrier, watchdog: new CoreCrashWatchdog(options) };
}

test('24 virtual hours of real reconciliation failures preserve service, recover one crash and respect administrative pause', async () => {
    const f = fixture();
    let requests = 0, warnings = 0;
    const enrollment = { url: 'https://panel.example.com/api/nodes/00000000-0000-4000-8000-000000000001/reconcile', token: 'a'.repeat(43), revision: '12' };
    const { NodeReconciliationService } = load(path.join(root, 'node-reconciliation.service.ts'), {
        '@nestjs/common': { Injectable: () => x => x, Logger: class { warn() { warnings++; } } },
        '@libs/contracts/commands': { StartXrayCommand: require('../libs/contract/build/commands/xray/start.command.js').StartXrayCommand },
        'node:fs/promises': { readFile: async () => JSON.stringify(enrollment) },
    }, {
        fetch: async () => { requests++; throw Error('panel offline'); },
        setTimeout: () => ({ unref() {} }), clearTimeout() {},
        AbortSignal: { any: () => undefined, timeout: () => undefined },
    });
    const reconciliation = new NodeReconciliationService();
    await reconciliation.onApplicationBootstrap();
    f.watchdog.arm();
    for (f.state.now = 0; f.state.now <= 24 * CORE_WATCHDOG_WINDOW_MS; f.state.now += 5000) {
        if (f.state.now % 30000 === 0) await reconciliation.checkIn();
        if (f.state.now === 12 * CORE_WATCHDOG_WINDOW_MS) f.state.up = false;
        if (f.state.now === 18 * CORE_WATCHDOG_WINDOW_MS) {
            await f.barrier.run(async () => { f.state.paused = true; f.state.up = false; });
        }
        await f.watchdog.tick();
    }
    reconciliation.onModuleDestroy();
    assert.equal(requests, 2881);
    assert.equal(warnings, 1);
    assert.equal(f.state.recoveries, 1);
    assert.equal(f.state.pauseReads, 2);
    assert.equal(f.state.warnings, 0);
    assert.equal(f.state.up, false);
    assert.equal(f.state.online.at(-1), false);
});

test('healthy and unknown status never acquire management, read pause or inspect disk', async () => {
    const f = fixture();
    let locks = 0;
    f.options.exclusive = async action => { locks++; await action(); };
    await f.watchdog.tick();
    assert.equal(f.state.statusReads, 0);
    f.watchdog.arm();
    await f.watchdog.tick();
    f.state.up = false; f.state.unknown = true;
    await f.watchdog.tick();
    assert.equal(locks, 0);
    assert.equal(f.state.pauseReads, 0);
    assert.equal(f.state.recoveries, 0);
});

test('repeated crashes use backoff and exhaust a bounded budget until an explicit successful start rearms it', async () => {
    const f = fixture(); f.watchdog.arm();
    for (const [now, expected] of [[0, 1], [5000, 1], [10000, 2], [20000, 2], [40000, 3], [45000, 3], [86400000, 3]]) {
        f.state.now = now; f.state.up = false;
        await f.watchdog.tick();
        assert.equal(f.state.recoveries, expected, String(now));
    }
    assert.equal(f.state.warnings, 1);
    f.watchdog.arm(); await f.watchdog.tick();
    assert.equal(f.state.recoveries, 3);
    f.watchdog.arm(true); await f.watchdog.tick();
    assert.equal(f.state.recoveries, 4);
});

test('busy lifecycle work is skipped and status and pause are checked again under the same barrier', async () => {
    const f = fixture(); f.watchdog.arm(); f.state.up = false;
    const release = f.barrier.acquire();
    await f.watchdog.tick(); release();
    assert.equal(f.state.statusReads, 0);
    const status = f.options.status;
    f.options.status = async () => { const value = await status(); f.state.up = true; return value; };
    await f.watchdog.tick();
    assert.equal(f.state.recoveries, 0);
    f.options.status = status; f.state.up = false;
    f.options.paused = async () => { assert.equal(f.barrier.isBusy(), true); return true; };
    await f.watchdog.tick();
    assert.equal(f.state.recoveries, 0);
    assert.equal(f.barrier.isBusy(), false);
});

test('a credential write acquiring the barrier during the cheap status probe does not latch or change online state', async () => {
    const f = fixture(); f.watchdog.arm(); f.state.up = false;
    let entered, finish;
    const probing = new Promise(resolve => { entered = resolve; });
    f.options.status = async () => { entered(); return new Promise(resolve => { finish = resolve; }); };
    const pending = f.watchdog.tick(); await probing;
    const release = f.barrier.acquire();
    finish('down'); await pending;
    assert.equal(f.state.warnings, 0);
    assert.deepEqual(f.state.online, []);
    assert.equal(f.state.recoveries, 0);
    release();
    f.options.status = async () => f.state.up ? 'up' : 'down';
    await f.watchdog.tick();
    assert.equal(f.state.recoveries, 1);
    assert.deepEqual(f.state.online, [false, true]);
});

test('only one recovery holds the lifecycle barrier and concurrent stop or shutdown cannot revive it', async () => {
    for (const shutdown of [false, true]) {
        const f = fixture(); f.watchdog.arm(); f.state.up = false;
        let started, finish;
        const entered = new Promise(resolve => { started = resolve; });
        f.options.recover = async () => { f.state.recoveries++; started(); await new Promise(resolve => { finish = resolve; }); f.state.up = true; return true; };
        const pending = f.watchdog.tick(); await entered;
        await f.watchdog.tick();
        await assert.rejects(f.barrier.run(async () => assert.fail('must be exclusive')), error => error.getStatus() === 503);
        const closing = shutdown ? f.watchdog.shutdown() : Promise.resolve(f.watchdog.disarm());
        finish(); await pending; await closing; await f.watchdog.tick();
        assert.equal(f.state.recoveries, 1);
        assert.equal(f.state.stops, 1);
        assert.equal(f.state.up, false);
        assert.equal(f.state.online.includes(true), false);
    }
});

test('cancellation while awaiting the locked status or pause check never enters native recovery', async () => {
    for (const stage of ['status', 'pause']) {
        const f = fixture(); f.watchdog.arm(); f.state.up = false;
        let entered, finish, probes = 0;
        const waiting = new Promise(resolve => { entered = resolve; });
        const pause = async value => { entered(); return new Promise(resolve => { finish = () => resolve(value); }); };
        if (stage === 'status') f.options.status = async () => ++probes === 2 ? pause('down') : 'down';
        else f.options.paused = () => pause(false);
        const pending = f.watchdog.tick(); await waiting;
        const closed = f.watchdog.shutdown();
        finish(); await pending; await closed;
        assert.equal(f.state.recoveries, 0, stage);
        assert.equal(f.state.stops, 0, stage);
        assert.equal(f.state.warnings, 0, stage);
    }
});

test('failed cancellation cleanup is reported once and shutdown rejects instead of claiming that the core stopped', async () => {
    const f = fixture(); f.watchdog.arm(); f.state.up = false;
    let entered, finish;
    const starting = new Promise(resolve => { entered = resolve; });
    f.options.recover = async () => { entered(); await new Promise(resolve => { finish = resolve; }); return true; };
    f.options.stop = async () => { f.state.stops++; throw Error('s6 unavailable'); };
    const pending = f.watchdog.tick(); await starting;
    const closed = f.watchdog.shutdown();
    const rejected = assert.rejects(pending, /could not confirm/);
    const shutdownRejected = assert.rejects(closed, /could not confirm/);
    finish(); await rejected; await shutdownRejected;
    assert.equal(f.state.warnings, 1);
    assert.equal(f.state.stops, 1);
    await assert.rejects(f.watchdog.shutdown(), /could not confirm/);
});

test('timer callbacks remain bounded after a failing warning callback and shutdown cancels rescheduling', async () => {
    const f = fixture(), timers = new Set();
    const { CoreCrashWatchdog } = load(path.join(root, 'core-crash-watchdog.ts'), {}, {
        setTimeout: callback => { const timer = { callback, unref() {} }; timers.add(timer); return timer; },
        clearTimeout: timer => timers.delete(timer),
    });
    f.options.recover = async () => { f.state.recoveries++; return false; };
    f.options.warning = () => { f.state.warnings++; throw Error('logger unavailable'); };
    const watchdog = new CoreCrashWatchdog(f.options);
    f.state.up = false; watchdog.arm(); watchdog.start(); watchdog.start();
    assert.equal(timers.size, 1);
    for (let i = 0; i < 2; i++) {
        const timer = [...timers][0]; timers.delete(timer); timer.callback();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(timers.size, 1);
    }
    assert.equal(f.state.recoveries, 1); assert.equal(f.state.warnings, 1);
    await watchdog.shutdown();
    assert.equal(timers.size, 0);
});

test('the actual boot guard rejects damaged configuration or quota journal and the watchdog latches without repeated starts', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remnacust-watchdog-'));
    await fs.chmod(directory, 0o700);
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const checkpoint = path.join(directory, 'checkpoint.pb'), policy = path.join(directory, 'host-policy.json'), binary = path.join(directory, 'core');
    await fs.mkdir(path.join(directory, 'quota'), { mode: 0o700 });
    await fs.writeFile(binary, 'remnacust-live-ports-v1');
    await fs.writeFile(policy, '{}', { mode: 0o600 });
    const payload = Buffer.from('cached-native-config');
    const valid = Buffer.concat([Buffer.from('REMNACUST-CORE-STATE-1\n' + crypto.createHash('sha256').update(payload).digest('hex') + '\n'), payload]);
    const { restoreCachedCore } = load(path.join(root, 'core-boot-recovery.ts'));
    const { verifyCorePolicy } = require('../docker/rootfs/etc/s6-overlay/scripts/core-boot.cjs');
    for (const damaged of ['checkpoint', 'ledger', 'policy']) {
        await fs.writeFile(checkpoint, damaged === 'checkpoint' ? 'damaged' : valid, { mode: 0o600 });
        await fs.writeFile(policy, damaged === 'policy' ? '{' : '{}', { mode: 0o600 });
        await fs.rm(path.join(directory, 'quota/ledger.json'), { force: true });
        if (damaged === 'ledger') await fs.writeFile(path.join(directory, 'quota/ledger.json'), 'torn-frame', { mode: 0o600 });
        const f = fixture(); f.state.up = false; f.watchdog.arm();
        f.options.recover = async () => {
            f.state.recoveries++;
            return restoreCachedCore({ paused: false, checkpoint, supported: async () => true,
                running: async () => f.state.up,
                start: async () => { verifyCorePolicy(binary, policy, checkpoint); f.state.up = true; },
                ready: async () => f.state.up });
        };
        for (let i = 0; i < 100; i++) { f.state.now += CORE_WATCHDOG_WINDOW_MS; await f.watchdog.tick(); }
        assert.equal(f.state.recoveries, 1, damaged);
        assert.equal(f.state.warnings, 1, damaged);
        assert.equal(f.state.up, false, damaged);
    }
});

test('failed native readiness is stopped and missing checkpoints or incompatible cores never become a restart loop', async () => {
    for (const recover of [async () => false, async () => { throw Error('native startup rejected'); }]) {
        const f = fixture(); f.state.up = false; f.watchdog.arm();
        f.options.recover = async () => { f.state.recoveries++; f.state.up = true; return recover(); };
        await f.watchdog.tick(); await f.watchdog.tick();
        assert.equal(f.state.recoveries, 1);
        assert.equal(f.state.stops, 1);
        assert.equal(f.state.up, false);
        assert.equal(f.state.warnings, 1);
    }
});
