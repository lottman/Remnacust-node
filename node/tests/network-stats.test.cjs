const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('./load-typescript.cjs');

const routeHeader = 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n';
const zeroAddress = '0'.repeat(32);
const ipv6Route = (
    iface,
    metric = '00000400',
    flags = '00000003',
    destination = zeroAddress,
    prefix = '00',
    source = zeroAddress,
    sourcePrefix = '00',
) =>
    `${destination} ${prefix} ${source} ${sourcePrefix} ${zeroAddress} ${metric} 00000001 00000000 ${flags} ${iface}\n`;

function fixture(options = {}) {
    const state = {
        now: 0,
        interfaces: [['eth0', 0, 0]],
        poll: null,
        route4: routeHeader + 'eth0 00000000 0 0 0 0 0 0 0 0 0\n',
        route6: '',
        missing: new Set(),
        errors: new Set(),
        reads: [],
        ...options,
    };
    const { NetworkStatsService } = load(
        path.join(__dirname, '../src/modules/network-stats/network-stats.service.ts'),
        {
            'node:fs': {
                existsSync: (file) => !state.missing.has(file),
                readFileSync: (file) => {
                    state.reads.push(file);
                    if (state.errors.has(file)) throw new Error('fixture read failure');
                    if (file === '/proc/net/route') return state.route4;
                    if (file === '/proc/net/ipv6_route') return state.route6;
                    assert.equal(file, '/proc/net/dev');
                    return (
                        'header\nheader\n' +
                        state.interfaces
                            .map(
                                ([iface, rx, tx]) =>
                                    `${iface}: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0`,
                            )
                            .join('\n')
                    );
                },
            },
            '@nestjs/common': {
                Injectable: () => (x) => x,
                Logger: class {
                    log() {}
                    warn() {}
                    error() {}
                },
            },
            '@nestjs/schedule': {},
        },
        {
            Date: class extends Date {
                constructor() {
                    super(state.now);
                }
                static now() {
                    return state.now;
                }
            },
            setInterval: (callback) => {
                state.poll = callback;
                return 1;
            },
        },
    );
    const service = new NetworkStatsService({ addInterval() {} });
    service.onModuleInit();
    return {
        state,
        service,
        poll: () => {
            state.now += 1000;
            state.poll();
        },
    };
}

test('deleted host interfaces disappear from rates and snapshots on the next successful poll', () => {
    const f = fixture();
    f.state.interfaces = [
        ['eth0', 100, 50],
        ['veth0', 10, 5],
    ];
    f.poll();
    f.state.interfaces = [
        ['eth0', 200, 100],
        ['veth0', 20, 10],
    ];
    f.poll();
    assert.equal(f.service.getByInterface('veth0').rxBytesPerSec, 10);
    f.state.interfaces = [['eth0', 300, 150]];
    f.poll();
    assert.equal(f.service.getByInterface('veth0'), null);
    assert.deepEqual(
        f.service.getSnapshot().interfaces.map((value) => value.interface),
        ['eth0'],
    );
    assert.equal(f.service.getDefault().rxBytesPerSec, 100);
});

test('interface churn retains only current rates instead of every historical veth name', () => {
    const f = fixture();
    for (let i = 0; i < 1000; i++) {
        f.state.interfaces = [[`veth${i}`, 0, 0]];
        f.poll();
        f.state.interfaces = [[`veth${i}`, 100, 50]];
        f.poll();
    }
    assert.equal(f.service.getSnapshot().interfaces.length, 1);
    assert.equal(f.service.getSnapshot().interfaces[0].interface, 'veth999');
    f.state.interfaces = [];
    f.poll();
    assert.deepEqual(f.service.getSnapshot().interfaces, []);
});

test('IPv6-only default interface supplies rates through the stats query and snapshot', async () => {
    const f = fixture({
        route4: routeHeader,
        route6: ipv6Route('eth6'),
        interfaces: [['eth6', 100, 50]],
    });
    assert.equal(f.service.getDefaultInterfaceName(), 'eth6');
    f.state.interfaces = [['eth6', 400, 150]];
    f.poll();
    const expected = {
        interface: 'eth6',
        rxBytesPerSec: 300,
        txBytesPerSec: 100,
        rxTotal: 400,
        txTotal: 150,
    };
    assert.deepEqual(f.service.getDefault(), expected);
    assert.equal(f.service.getSnapshot().defaultInterface, 'eth6');
    const { GetInterfaceStatsHandler } = load(
        path.join(
            __dirname,
            '../src/modules/network-stats/queries/get-interface-stats/get-interface-stats.handler.ts',
        ),
        {
            '@nestjs/cqrs': { QueryHandler: () => (x) => x, Query: class {} },
            '@nestjs/common': { Logger: class {} },
        },
    );
    assert.deepEqual(await new GetInterfaceStatsHandler(f.service).execute(), expected);
});

test('dual-stack discovery preserves IPv4 preference and its lowest decimal metric', () => {
    const f = fixture({
        route4:
            routeHeader + 'eth4a 00000000 0 0 0 0 100 0 0 0 0\neth4b 00000000 0 0 0 0 20 0 0 0 0\n',
        route6: ipv6Route('eth6', '00000001'),
    });
    assert.equal(f.service.getDefaultInterfaceName(), 'eth4b');
    assert.equal(f.state.reads.includes('/proc/net/ipv6_route'), false);
});

test('IPv6 discovery uses hexadecimal metrics and excludes unusable or source-specific routes', () => {
    const f = fixture({
        route4: routeHeader,
        route6: [
            ipv6Route('lo', '00000000', '00200200'),
            ipv6Route('rejected', '00000000', '00000201'),
            ipv6Route('down', '00000000', '00000000'),
            ipv6Route('subnet', '00000000', '00000001', zeroAddress, '40'),
            ipv6Route(
                'specific-source',
                '00000000',
                '00000001',
                zeroAddress,
                '00',
                '20010db8' + '0'.repeat(24),
                '40',
            ),
            ipv6Route('bad-metric', '0000000g'),
            ipv6Route('bad-flags', '00000000', '0000000g'),
            'malformed route\n',
            ipv6Route('eth6a', '00000100'),
            ipv6Route('eth6b', '000000ff'),
            ipv6Route('eth6c', '000000ff'),
        ].join(''),
    });
    assert.equal(f.service.getDefaultInterfaceName(), 'eth6b');
});

for (const unavailable of ['missing', 'errors'])
    test(`IPv6 discovery still works with ${unavailable} IPv4 route file`, () => {
        const f = fixture({
            [unavailable]: new Set(['/proc/net/route']),
            route6: ipv6Route('eth6'),
        });
        assert.equal(f.service.getDefaultInterfaceName(), 'eth6');
    });

for (const unavailable of ['missing', 'errors'])
    test(`unavailable ${unavailable} route files leave per-interface stats available`, () => {
        const f = fixture({ [unavailable]: new Set(['/proc/net/route', '/proc/net/ipv6_route']) });
        assert.equal(f.service.getDefaultInterfaceName(), null);
        f.state.interfaces = [['eth0', 200, 100]];
        f.poll();
        assert.equal(f.service.getDefault(), null);
        assert.equal(f.service.getSnapshot().isAvailable, true);
        assert.equal(f.service.getByInterface('eth0').rxBytesPerSec, 200);
    });

test('non-Linux systems do not start polling or read route files', () => {
    const f = fixture({ missing: new Set(['/proc/net/dev']) });
    assert.equal(f.state.poll, null);
    assert.deepEqual(f.state.reads, []);
    assert.equal(f.service.getSnapshot().isAvailable, false);
});
