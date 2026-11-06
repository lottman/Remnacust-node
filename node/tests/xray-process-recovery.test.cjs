const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('./load-typescript.cjs');

function fixture() {
    const state = { calls: [], up: true, pid: 42, output: '{}', failures: 0, waits: 0, warnings: 0 };
    const { XrayProcessService } = load(path.join(__dirname, '../src/modules/xray-core/xray-process.service.ts'), {
        '@common/utils/read-core-version': {},
        '@nestjs/common': { Injectable: () => x => x, Logger: class { warn() { state.warnings++; } } },
        'node:util': { promisify: fn => (...args) => new Promise((resolve, reject) => fn(...args,
            (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))) },
        'node:timers/promises': { setTimeout: async () => { state.waits++; } },
        'node:child_process': { execFile: (binary, args, options, callback) => {
            state.calls.push({ binary, args, options });
            if (state.failures-- > 0) callback(Error('unavailable'));
            else callback(null, state.output, '');
        } },
    });
    const service = new XrayProcessService();
    service.getStatus = async () => ({ up: state.up, pid: state.pid, raw: '' });
    return { state, service, readStatus: () => XrayProcessService.prototype.getStatus.call(service) };
}

test('recovery uses a bounded read-only private sys-stats call, retries startup and checks the same PID', async () => {
    const { state, service } = fixture(); state.failures = 2;
    assert.equal(await service.recoveryReady('/fixture-core', '/private/api.sock'), true);
    assert.equal(state.calls.length, 3); assert.equal(state.waits, 2);
    for (const call of state.calls) {
        assert.deepEqual(call.args, ['api', 'statssys', '--server=unix:/private/api.sock', '--timeout=2']);
        assert.equal(call.options.timeout, 3000); assert.equal(call.options.maxBuffer, 8192);
    }
    let count = 0;
    service.getStatus = async () => ({ up: true, pid: count++ === 0 ? 42 : 43 });
    assert.equal(await service.recoveryReady('/fixture-core', '/private/api.sock'), false);
});

test('real s6 status parsing distinguishes known down from unavailable or malformed observations', async () => {
    const { state, readStatus } = fixture();
    for (const output of ['', 'garbage', 'false', 'false 0', 'true -1', 'true 0', 'false -1 extra', 'true 9007199254740992']) {
        state.output = output;
        assert.deepEqual(await readStatus(), { up: false, pid: null, raw: '' }, output);
    }
    state.output = 'false -1\n';
    assert.deepEqual(await readStatus(), { up: false, pid: null, raw: 'false -1' });
    state.output = 'true 42\n';
    assert.deepEqual(await readStatus(), { up: true, pid: 42, raw: 'true 42' });
    state.failures = 1;
    assert.deepEqual(await readStatus(), { up: false, pid: null, raw: '' });
    state.failures = 1;
    await readStatus();
    assert.equal(state.warnings, 1);
    state.output = 'true 42'; await readStatus();
    state.failures = 1; await readStatus();
    assert.equal(state.warnings, 2);
});

test('unready, malformed or stopped native cores cannot pass readiness and retries remain bounded', async () => {
    for (const output of ['invalid JSON', 'null', '[]']) {
        const { state, service } = fixture(); state.output = output;
        assert.equal(await service.recoveryReady('/fixture-core', '/private/api.sock'), false);
        assert.equal(state.calls.length, 5); assert.equal(state.waits, 4);
    }
    const { state, service } = fixture(); state.up = false;
    assert.equal(await service.recoveryReady('/fixture-core', '/private/api.sock'), false);
    assert.equal(state.calls.length, 0);
});

test('s6 start remains once-only and both lifecycle subprocess calls have hard time and output bounds', async () => {
    const { state, service } = fixture(); await service.start(); await service.stop();
    assert.ok(state.calls[0].args.includes('-o'));
    assert.ok(!state.calls[0].args.includes('-u'));
    assert.ok(state.calls[1].args.includes('-d'));
    for (const call of state.calls) {
        assert.equal(call.options.timeout, 12000);
        assert.equal(call.options.maxBuffer, 16384);
    }
});
