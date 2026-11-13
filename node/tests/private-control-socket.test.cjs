const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('./load-typescript.cjs');
const root = '/run/remnacust-xray-AbCd123456';
function fixture(change = {}) {
    const info = { isDirectory: () => true, mode: 0o40700, uid: process.getuid?.(), ...change };
    return load(path.join(__dirname, '../src/common/utils/private-xtls-socket.ts'), {
        'node:fs': { lstatSync: () => info },
    });
}
test('both node control channels require their own filesystem name in a private owned directory', () => {
    const control = fixture();
    assert.equal(control.privateInternalSocketPath(root + '/internal.sock'), root + '/internal.sock');
    assert.equal(control.privateXtlsConnectionUrl(root + '/api.sock'), 'unix://' + root + '/api.sock');
    for (const invalid of ['rwint-legacy', '@abstract', '/tmp/internal.sock', root + '/api.sock', root + '/internal.sock/../api.sock'])
        assert.throws(() => control.privateInternalSocketPath(invalid));
    assert.throws(() => control.privateXtlsConnectionUrl(root + '/internal.sock'));
    for (const change of [{ mode: 0o40755 }, { isDirectory: () => false }, { uid: process.getuid?.() === undefined ? -1 : process.getuid() + 1 }])
        assert.throws(() => fixture(change).privateInternalSocketPath(root + '/internal.sock'));
});


test('private API availability requires an existing owned socket instead of a stale file or symlink', () => {
    let entry = { isSocket: () => true, uid: process.getuid?.(), mode: 0o140600 };
    const control = load(path.join(__dirname, '../src/common/utils/private-xtls-socket.ts'), {
        'node:fs': { lstatSync: name => {
            if (name === root) return { isDirectory: () => true, mode: 0o40700, uid: process.getuid?.() };
            if (entry instanceof Error) throw entry;
            return entry;
        } },
    });
    const check = () => control.isPrivateXtlsSocketAvailable(root + '/api.sock');
    assert.equal(check(), true);
    for (const patch of [{ isSocket: () => false }, { mode: 0o140666 }, { uid: -1 }]) {
        const before = entry; entry = { ...entry, ...patch }; assert.equal(check(), false); entry = before;
    }
    entry = Object.assign(new Error('missing'), { code: 'ENOENT' });
    assert.equal(check(), false);
    entry = Object.assign(new Error('denied'), { code: 'EACCES' });
    assert.throws(check, /denied/);
});
