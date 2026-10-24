const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const express = require('express');
const bodyParser = require('body-parser');

test('node JSON parser accepts the panel compression formats and bounds decoded payloads', async () => {
    const app = express();
    app.use(bodyParser.json({ limit: '2kb' }));
    app.post('/echo', (req, res) => res.json(req.body));
    app.get('/health', (_req, res) => res.send('healthy'));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ rejected: true }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const value = { users: [{ id: 'test-user' }], enabled: true };
    const source = Buffer.from(JSON.stringify(value));
    const encoders = {
        identity: (bytes) => bytes,
        gzip: zlib.gzipSync,
        deflate: zlib.deflateSync,
        br: zlib.brotliCompressSync,
        zstd: zlib.zstdCompressSync,
    };
    try {
        for (const [encoding, encode] of Object.entries(encoders)) {
            const response = await fetch(origin + '/echo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Encoding': encoding },
                body: encode(source),
            });
            assert.equal(response.status, 200, encoding);
            assert.deepEqual(await response.json(), value);
            const oversized = await fetch(origin + '/echo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Encoding': encoding },
                body: encode(Buffer.from(JSON.stringify({ text: 'x'.repeat(8192) }))),
            });
            assert.equal(oversized.status, 413, encoding + ' decoded limit');
        }
        for (const encoding of ['gzip', 'deflate', 'br', 'zstd']) {
            const rejected = await fetch(origin + '/echo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Encoding': encoding },
                body: 'invalid compressed data',
            });
            assert.equal(rejected.status, 400, encoding);
            assert.equal(await (await fetch(origin + '/health')).text(), 'healthy');
        }
        // A decoder can finish its first frame before the entire HTTP request ends.
        // Trailing input must never become an unhandled stream error after parsing.
        for (const encoding of ['br', 'zstd']) {
            await new Promise((resolve, reject) => {
                const request = http.request(
                    origin + '/echo',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Encoding': encoding,
                        },
                    },
                    (response) => {
                        response.resume();
                        response.once('end', resolve);
                    },
                );
                request.on('error', reject);
                request.setTimeout(2000, () => request.destroy(new Error('fixture timeout')));
                request.write(encoders[encoding](source));
                setImmediate(() => request.end(Buffer.from('trailing input')));
            });
            assert.equal(await (await fetch(origin + '/health')).text(), 'healthy');
        }
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});
