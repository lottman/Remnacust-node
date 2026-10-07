const assert = require('node:assert/strict');
const { mkdtemp, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const load = require('../../backend-3.4.4-xera/tests/load-typescript.cjs');

test('custom-core download failure never reports successful preparation', async () => {
    let renamed = false;
    const { CoreLoaderService } = load(join(__dirname, '../src/modules/xray-core/core-loader.service.ts'), {
        'node:fs/promises': {
            readFile: async () => { throw new Error('not installed'); },
            rm: async () => {},
            rename: async () => { renamed = true; },
        },
        'pretty-bytes': () => '',
        '@common/utils/download-file': { downloadFile: async () => { throw new Error('network failed'); } },
        '@common/utils/get-elapsed-time': { getTime: () => 0, formatExecutionTime: () => '' },
        '@common/utils/read-core-version': {},
    });
    const service = new CoreLoaderService({ applyOverride: async () => false });
    await assert.rejects(service.prepare({ core: { url: 'https://example.com/core', sha256: 'a'.repeat(64) } }), /Could not install/);
    assert.equal(renamed, false);
    await assert.rejects(service.prepare({ core: { url: 'http://example.com/core', sha256: 'invalid' } }), /Invalid custom core/);
});

test('oversized download aborts the HTTP request and leaves no temporary file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xera-download-test-'));
    const realFetch = global.fetch;
    let signal;
    global.fetch = async (_url, options) => {
        signal = options.signal;
        return { ok: true, url: 'https://example.com/file', body: {}, headers: new Headers({ 'content-length': '1024' }) };
    };
    try {
        const { downloadFile } = load(join(__dirname, '../src/common/utils/download-file.ts'));
        const target = join(directory, 'core');
        await assert.rejects(downloadFile('https://example.com/file', target, { maxSize: 10 }), /content-length/);
        assert.equal(signal.aborted, true);
        await assert.rejects(stat(target + '.download'), { code: 'ENOENT' });
    } finally { global.fetch = realFetch; await rm(directory, { recursive: true, force: true }); }
});

test('failed node authentication does not log Authorization or cookies', () => {
    const logs = [];
    let destroyed = false;
    const { JwtDefaultGuard } = load(join(__dirname, '../src/common/guards/jwt-guards/def-jwt-guard.ts'), {
        '@nestjs/passport': { AuthGuard: () => class {} },
        '@nestjs/common': { Logger: class { debug(v) { logs.push(v); } error(v) { logs.push(v); } }, UnauthorizedException: Error },
    });
    const context = { switchToHttp: () => ({
        getResponse: () => ({ socket: { destroy() { destroyed = true; } } }),
        getRequest: () => ({ headers: { authorization: 'Bearer PRIVATE-JWT', cookie: 'PRIVATE-COOKIE' }, url: '/api/test?key=PRIVATE-QUERY', path: '/api/test', ip: '127.0.0.1' }),
    }) };
    assert.throws(() => new JwtDefaultGuard().handleRequest(null, null, new Error(), context));
    assert.equal(JSON.stringify(logs).includes('PRIVATE-'), false);
    assert.equal(destroyed, false, 'unauthorized requests must receive 401 instead of a connection reset');
});
