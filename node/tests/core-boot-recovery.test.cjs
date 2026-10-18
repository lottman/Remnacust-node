const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('./load-typescript.cjs');
function fixture() {
    const state = { starts: 0, reads: 0, support: true, up: false, ready: true };
    const { restoreCachedCore } = load(path.join(__dirname, '../src/modules/xray-core/core-boot-recovery.ts'), {
        'node:fs/promises': { lstat: async filename => {
            state.reads++;
            if (state.error) throw state.error;
            return { isFile: () => !state.symlink, isDirectory: () => !state.symlink,
                mode: state.mode ?? (filename.endsWith('.pb') ? 0o100600 : 0o40700), uid: process.getuid?.() };
        } },
    });
    const options = { paused: false, checkpoint: '/private/checkpoint.pb', supported: async () => state.support,
        running: async () => state.up, start: async () => { state.starts++; }, ready: async () => state.ready };
    return { state, options, restore: () => restoreCachedCore(options) };
}
test('saved native configuration restores without the panel and does not restart an already running core', async () => {
    const { state, restore } = fixture();
    assert.equal(await restore(), true);assert.equal(state.starts, 1);
    state.up = true;assert.equal(await restore(), true);assert.equal(state.starts, 1);
});
test('administrative pause, new installations and unsupported legacy cores cannot be auto-started', async () => {
    const paused = fixture();paused.options.paused = true;assert.equal(await paused.restore(), false);assert.equal(paused.state.reads, 0);
    const fresh = fixture();fresh.state.error = Object.assign(Error('missing'), { code: 'ENOENT' });assert.equal(await fresh.restore(), false);assert.equal(fresh.state.starts, 0);
    const legacy = fixture();legacy.state.support = false;assert.equal(await legacy.restore(), false);assert.equal(legacy.state.starts, 0);
});
test('untrusted checkpoints and a failed private API never acknowledge successful recovery', async () => {
    for (const change of [{ symlink: true }, ...(process.platform === 'win32' ? [] : [{ mode: 0o777 }]), { error: Object.assign(Error('denied'), { code: 'EACCES' }) }]) {
        const value = fixture();Object.assign(value.state, change);await assert.rejects(value.restore());assert.equal(value.state.starts, 0);
    }
    const value = fixture();value.state.ready = false;await assert.rejects(value.restore(), /private API/);assert.equal(value.state.starts, 1);
});
