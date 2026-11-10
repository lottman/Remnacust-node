const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const load = require('./load-typescript.cjs');
const { listenerReplacementRequired, applyRuntimeUpdate } = load(path.join(__dirname, '../src/modules/xray-core/runtime-listener-update.ts'));
const rejection = 'runtime apply failed: rpc error: code = FailedPrecondition desc = Inbound YandexCDN-RU1 changes its port or transport; create a separate port/tag and retain this listener';
const error = () => Object.assign(new Error('core command failed'), { code: 1, stdout: '', stderr: rejection + '\n' });
const globalError = () => Object.assign(error(), { stderr: 'runtime apply failed: rpc error: code = FailedPrecondition desc = Global core settings changed; preserve current sessions and apply this change during an explicit maintenance restart\n' });
const checkpoint = (text, quota = false) => {
    const payload = Buffer.from(text);
    return Buffer.concat([Buffer.from(`REMNACUST-CORE-STATE-${quota ? '2-USER-QUOTA' : '1'}\n${createHash('sha256').update(payload).digest('hex')}\n`), payload]);
};
async function fixture(t, quota = false) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remnacust-listener-update-'));
    await fs.chmod(root, 0o700);
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }));
    const filename = path.join(root, 'checkpoint.pb'), previous = checkpoint('retained-working-configuration', quota), target = checkpoint('new-listener-configuration', quota);
    await fs.writeFile(filename, previous, { mode: 0o600 });
    const calls = [];
    const options = {
        requireLiveApply: false, checkpoint: filename,
        apply: async () => { calls.push('apply'); throw error(); },
        validate: async () => { calls.push('validate'); },
        prepare: async () => { calls.push('prepare'); await fs.writeFile(filename, target); },
        restart: async () => { calls.push('restart'); },
        stop: async () => { calls.push('stop'); },
    };
    return { root, filename, previous, target, calls, options };
}

test('only a completed native listener precondition can authorize automatic restart', () => {
    assert.equal(listenerReplacementRequired(error()), true);
    assert.equal(listenerReplacementRequired(Object.assign(error(), { stderr: '[Warning] local validation\n' + rejection + '\n' })), true);
    for (const fields of [
        { code: 0 }, { code: 'ETIMEDOUT' }, { signal: 'SIGTERM' }, { killed: true }, { stdout: '{}' },
        { stderr: rejection.replace('FailedPrecondition', 'Unavailable') },
        { stderr: 'configuration validation failed: ' + rejection },
        { stderr: rejection + '\nother failure' }, { stderr: 'x'.repeat(65537) },
        { stderr: rejection.replace('port or transport', 'native authentication settings') },
    ]) assert.equal(listenerReplacementRequired(Object.assign(error(), fields)), false, JSON.stringify(fields).slice(0, 100));
    assert.equal(listenerReplacementRequired({ code: 1, stderr: rejection }), false);
});

test('normal hot application does not read a checkpoint or restart the process', async () => {
    const calls = [];
    const result = await applyRuntimeUpdate({ apply: async () => calls.push('apply'), checkpoint: '/missing', requireLiveApply: false });
    assert.equal(result, false);
    assert.deepEqual(calls, ['apply']);
});

test('a recovered unclaimed configuration may replace initial global settings only by explicit internal opt-in', async t => {
    for (const allowed of [false, true]) {
        const f = await fixture(t, true);
        f.options.allowInitialSettingsReplacement = allowed;
        f.options.apply = async () => { f.calls.push('apply'); throw globalError(); };
        if (allowed) {
            assert.equal(await applyRuntimeUpdate(f.options), true);
            assert.deepEqual(f.calls, ['apply', 'validate', 'prepare', 'restart']);
            assert.deepEqual(await fs.readFile(f.filename), f.target);
        } else {
            await assert.rejects(applyRuntimeUpdate(f.options), /core command failed/);
            assert.deepEqual(f.calls, ['apply']);
            assert.deepEqual(await fs.readFile(f.filename), f.previous);
        }
    }
});

test('an initial global replacement cannot bypass strict live plans or accept ambiguous process errors', async t => {
    for (const fields of [{}, { code: 'ETIMEDOUT' }, { killed: true }, { stdout: '{}' }, { stderr: globalError().stderr + 'another failure' }]) {
        const f = await fixture(t);
        f.options.allowInitialSettingsReplacement = true;
        f.options.requireLiveApply = Object.keys(fields).length === 0;
        f.options.apply = async () => { f.calls.push('apply'); throw Object.assign(globalError(), fields); };
        await assert.rejects(applyRuntimeUpdate(f.options));
        assert.deepEqual(f.calls, ['apply']);
        assert.deepEqual(await fs.readFile(f.filename), f.previous);
    }
});

test('listener changes are validated and started once, preserving both checkpoint formats', async t => {
    for (const quota of [false, true]) {
        const f = await fixture(t, quota);
        assert.equal(await applyRuntimeUpdate(f.options), true);
        assert.deepEqual(f.calls, ['apply', 'validate', 'prepare', 'restart']);
        assert.deepEqual(await fs.readFile(f.filename), f.target);
        assert.deepEqual(await fs.readdir(f.root), ['checkpoint.pb']);
    }
});

test('strict live plans and unknown RPC errors preserve the running process', async t => {
    for (const strict of [false, true]) {
        const f = await fixture(t);
        f.options.requireLiveApply = strict;
        if (!strict) f.options.apply = async () => { f.calls.push('apply'); throw Object.assign(error(), { code: 'ETIMEDOUT' }); };
        await assert.rejects(applyRuntimeUpdate(f.options));
        assert.deepEqual(f.calls, ['apply']);
        assert.deepEqual(await fs.readFile(f.filename), f.previous);
    }
});

test('invalid target configuration is rejected before modifying the checkpoint or stopping Xray', async t => {
    const f = await fixture(t);
    f.options.validate = async () => { f.calls.push('validate'); throw new Error('invalid target'); };
    await assert.rejects(applyRuntimeUpdate(f.options), /invalid target/);
    assert.deepEqual(f.calls, ['apply', 'validate']);
    assert.deepEqual(await fs.readFile(f.filename), f.previous);
});

test('failed preparation restores the exact checkpoint while the old core keeps serving', async t => {
    const f = await fixture(t);
    f.options.prepare = async () => { f.calls.push('prepare'); await fs.writeFile(f.filename, 'partial target'); throw new Error('prepare failed'); };
    await assert.rejects(applyRuntimeUpdate(f.options), /running core was preserved/);
    assert.deepEqual(f.calls, ['apply', 'validate', 'prepare']);
    assert.deepEqual(await fs.readFile(f.filename), f.previous);
    assert.deepEqual(await fs.readdir(f.root), ['checkpoint.pb']);
});

test('failed startup stops the failed process, restores the exact old checkpoint and checks recovery once', async t => {
    const f = await fixture(t, true);
    let starts = 0;
    f.options.restart = async () => {
        f.calls.push('restart');
        if (++starts === 1) { assert.deepEqual(await fs.readFile(f.filename), f.target); throw new Error('port occupied'); }
        assert.deepEqual(await fs.readFile(f.filename), f.previous);
    };
    await assert.rejects(applyRuntimeUpdate(f.options), /previous running configuration was restored/);
    assert.deepEqual(f.calls, ['apply', 'validate', 'prepare', 'restart', 'stop', 'restart']);
    assert.deepEqual(await fs.readFile(f.filename), f.previous);
});

test('failed recovery never reports success or retries indefinitely', async t => {
    const f = await fixture(t);
    f.options.restart = async () => { f.calls.push('restart'); throw new Error('readiness failed'); };
    await assert.rejects(applyRuntimeUpdate(f.options), /automatic recovery did not complete/);
    assert.deepEqual(f.calls, ['apply', 'validate', 'prepare', 'restart', 'stop', 'restart']);
    assert.deepEqual(await fs.readFile(f.filename), f.previous);
});

test('failure to stop the failed process cannot overwrite a checkpoint under a running target', async t => {
    const f = await fixture(t);
    f.options.restart = async () => { f.calls.push('restart'); throw new Error('unknown readiness'); };
    f.options.stop = async () => { f.calls.push('stop'); throw new Error('stop failed'); };
    await assert.rejects(applyRuntimeUpdate(f.options), /automatic recovery did not complete/);
    assert.deepEqual(f.calls, ['apply', 'validate', 'prepare', 'restart', 'stop']);
    assert.deepEqual(await fs.readFile(f.filename), f.target);
});

test('missing, corrupt and oversized saved checkpoints cannot authorize a restart', async t => {
    for (const invalid of [null, Buffer.from('bad checksum'), Buffer.alloc(16 * 1024 * 1024 + 129)]) {
        const f = await fixture(t);
        if (invalid === null) await fs.rm(f.filename);
        else await fs.writeFile(f.filename, invalid);
        await assert.rejects(applyRuntimeUpdate(f.options));
        assert.deepEqual(f.calls, ['apply', 'validate']);
    }
});

test('shared or symbolic checkpoint paths cannot authorize a restart', { skip: process.platform === 'win32' }, async t => {
    for (const kind of ['file-mode', 'directory-mode', 'symlink']) {
        const f = await fixture(t);
        if (kind === 'file-mode') await fs.chmod(f.filename, 0o644);
        else if (kind === 'directory-mode') await fs.chmod(f.root, 0o755);
        else { const link = f.filename + '.link'; await fs.symlink(f.filename, link); f.options.checkpoint = link; }
        await assert.rejects(applyRuntimeUpdate(f.options));
        assert.deepEqual(f.calls, ['apply', 'validate']);
    }
});
