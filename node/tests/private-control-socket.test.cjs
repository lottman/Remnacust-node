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
