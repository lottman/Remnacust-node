const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const load = require('./load-typescript.cjs');
const root = '/run/remnacust-xray-AbCd123456';
function fixture(options = {}) {
    const state = { removed: [], probes: 0, checks: 0, fileReads: 0 };
    const details = {
        isSocket: () => true,
        uid: process.getuid?.(),
        mode: 0o140600,
        dev: 1,
        ino: 7,
        ...options.file,
    };
    const { removeStalePrivateXtlsSocket } = load(
        path.join(__dirname, '../src/common/utils/private-xtls-socket.ts'),
        {
            'node:fs': {
                lstatSync: (name) => {
                    if (name === root)
                        return { isDirectory: () => true, uid: process.getuid?.(), mode: 0o40700 };
                    state.fileReads++;
                    if (options.missing) throw Object.assign(Error('missing'), { code: 'ENOENT' });
                    return state.fileReads > 1 && options.changed
                        ? { ...details, ino: 8 }
                        : details;
                },
                unlinkSync: (name) => state.removed.push(name),
            },
            'node:net': {
                createConnection: (args) => {
                    assert.deepEqual(args, { path: root + '/api.sock' });
                    state.probes++;
                    const socket = new EventEmitter();
                    socket.destroy = (error) => {
                        if (error) queueMicrotask(() => socket.emit('error', error));
                    };
                    socket.setTimeout = (ms, callback) => {
                        assert.equal(ms, 500);
                        if (options.probe === 'timeout') queueMicrotask(callback);
                    };
                    if (options.probe !== 'timeout')
                        queueMicrotask(() => {
                            if (options.probe === 'active') socket.emit('connect');
                            else
                                socket.emit(
                                    'error',
                                    Object.assign(Error('probe failure'), {
                                        code: options.probe ?? 'ECONNREFUSED',
                                    }),
                                );
                        });
                    return socket;
                },
            },
        },
    );
    return {
        state,
        run: () =>
            removeStalePrivateXtlsSocket(root + '/api.sock', async () => {
                return (options.stopped ?? [true, true])[state.checks++];
            }),
    };
}
test('only a refused private owned socket with confirmed stopped supervision is removed', async () => {
    const f = fixture();
    await f.run();
    assert.deepEqual(f.state.removed, [root + '/api.sock']);
    assert.equal(f.state.checks, 2);
    const absent = fixture({ missing: true });
    await absent.run();
    assert.equal(absent.state.probes, 0);
    assert.equal(absent.state.checks, 0);
});
test('unsafe files, live endpoints, uncertain process states and replacement inodes are preserved', async () => {
    for (const options of [
        { file: { isSocket: () => false } },
        { file: { uid: -1 } },
        { file: { mode: 0o140666 } },
        { probe: 'active' },
        { probe: 'EACCES' },
        { probe: 'timeout' },
        { stopped: [false] },
        { stopped: [true, false] },
        { changed: true },
    ]) {
        const f = fixture(options);
        await assert.rejects(f.run());
        assert.deepEqual(f.state.removed, [], JSON.stringify(options));
    }
});
