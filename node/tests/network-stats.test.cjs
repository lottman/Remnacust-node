const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const load = require('./load-typescript.cjs');

function fixture() {
    const state = { now: 0, interfaces: [['eth0', 0, 0]], poll: null };
    const { NetworkStatsService } = load(path.join(__dirname, '../src/modules/network-stats/network-stats.service.ts'), {
        'node:fs': {
            existsSync: () => true,
            readFileSync: file => file.endsWith('/route')
                ? 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\neth0 00000000 0 0 0 0 0 0 0 0 0\n'
                : 'header\nheader\n' + state.interfaces.map(([iface, rx, tx]) => `${iface}: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0`).join('\n'),
        },
        '@nestjs/common': { Injectable: () => x => x, Logger: class { log() {} warn() {} error() {} } },
        '@nestjs/schedule': {},
    }, {
        Date: class extends Date { constructor() { super(state.now); } static now() { return state.now; } },
        setInterval: callback => { state.poll = callback; return 1; },
    });
    const service = new NetworkStatsService({ addInterval() {} });
    service.onModuleInit();
    return { state, service, poll: () => { state.now += 1000; state.poll(); } };
}

test('deleted host interfaces disappear from rates and snapshots on the next successful poll', () => {
    const f = fixture();
    f.state.interfaces = [['eth0', 100, 50], ['veth0', 10, 5]]; f.poll();
    f.state.interfaces = [['eth0', 200, 100], ['veth0', 20, 10]]; f.poll();
    assert.equal(f.service.getByInterface('veth0').rxBytesPerSec, 10);
    f.state.interfaces = [['eth0', 300, 150]]; f.poll();
    assert.equal(f.service.getByInterface('veth0'), null);
    assert.deepEqual(f.service.getSnapshot().interfaces.map(value => value.interface), ['eth0']);
    assert.equal(f.service.getDefault().rxBytesPerSec, 100);
});

test('interface churn retains only current rates instead of every historical veth name', () => {
    const f = fixture();
    for (let i = 0; i < 1000; i++) {
        f.state.interfaces = [[`veth${i}`, 0, 0]]; f.poll();
        f.state.interfaces = [[`veth${i}`, 100, 50]]; f.poll();
    }
    assert.equal(f.service.getSnapshot().interfaces.length, 1);
    assert.equal(f.service.getSnapshot().interfaces[0].interface, 'veth999');
    f.state.interfaces = []; f.poll();
    assert.deepEqual(f.service.getSnapshot().interfaces, []);
});
