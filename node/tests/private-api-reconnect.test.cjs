const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createServer } = require('nice-grpc');
const { XtlsApi } = require('@remnawave/xtls-sdk');
const {
    StatsServiceDefinition,
} = require('@remnawave/xtls-sdk/build/src/xray-protos/app/stats/command/command');
const load = require('./load-typescript.cjs');
const { PRIVATE_XTLS_RECONNECT_OPTIONS } = load(
    path.join(__dirname, '../src/common/utils/private-xtls-socket.ts'),
);

test(
    'private SDK reconnects promptly when Xray API appears after repeated transport failures',
    { timeout: 15_000 },
    async (t) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-private-api-'));
        let attempts = 0,
            readyAt = 0,
            bindError;
        let api;
        const server = createServer();
        server.add(
            {
                ...StatsServiceDefinition,
                methods: { getSysStats: StatsServiceDefinition.methods.getSysStats },
            },
            {
                async getSysStats() {
                    return {
                        $type: 'xray.app.stats.command.SysStatsResponse',
                        NumGoroutine: 1,
                        NumGC: 0,
                        Alloc: 0,
                        TotalAlloc: 0,
                        Sys: 0,
                        Mallocs: 0,
                        Frees: 0,
                        LiveObjects: 0,
                        PauseTotalNs: 0,
                        Uptime: 1,
                    };
                },
            },
        );
        const socket = path.join(directory, 'api.sock');
        const transport = net.createServer((connection) => {
            connection.destroy();
            if (++attempts !== 5) return;
            transport.close(() => {
                server.listen(address).then(
                    () => {
                        readyAt = performance.now();
                    },
                    (error) => {
                        bindError = error;
                    },
                );
            });
        });
        t.after(async () => {
            api?.channel.close();
            await server.shutdown();
            if (transport.listening) await new Promise((resolve) => transport.close(resolve));
            fs.rmSync(directory, { recursive: true, force: true });
        });
        await new Promise((resolve, reject) => {
            transport.once('error', reject);
            if (process.platform === 'win32') transport.listen(0, '127.0.0.1', resolve);
            else transport.listen(socket, resolve);
        });
        const address =
            process.platform === 'win32'
                ? `127.0.0.1:${transport.address().port}`
                : `unix://${socket}`;
        api = new XtlsApi({ connectionUrl: address, options: PRIVATE_XTLS_RECONNECT_OPTIONS });
        const start = performance.now();
        let response;
        while (performance.now() - start < 12_000) {
            if (bindError) throw bindError;
            response = await api.stats.getSysStats();
            if (response.isOk) break;
            if (readyAt && performance.now() - readyAt > 2_000) break;
            await delay(25);
        }
        assert.equal(attempts, 5);
        assert(readyAt > 0);
        assert.equal(response?.isOk, true);
        assert(
            performance.now() - readyAt < 2_000,
            'SDK retained stale reconnect backoff after API became available',
        );
    },
);
