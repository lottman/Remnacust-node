const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
function load(file, mocks = {}) {
    const ref = { exports: {} }, local = createRequire(file);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, esModuleInterop: true } }).outputText;
    new Function('require', 'module', 'exports', code)(id => {
        if (Object.hasOwn(mocks, id)) return mocks[id];
        const sibling = path.resolve(path.dirname(file), id + '.ts');
        return id.startsWith('.') && fs.existsSync(sibling) ? load(sibling, mocks) : local(id);
    }, ref, ref.exports);
    return ref.exports;
}
const { PluginService } = load(path.join(root, 'src/modules/_plugin/plugin.service.ts'), {
    '@common/types/result.type': { ok: response => ({ isOk: true, response }) },
    '@libs/contracts/constants': { XRAY_TORRENT_BLOCKER_OUTBOUND_TAG: 'block' },
    '../asn-lmdb/queries/get-asn-prefixes/get-asn-prefixes.query': {},
    '../handler/commands/remove-outbound/remove-outbound.command': { RemoveOutboundCommand: class {} },
    '../xray-core/commands/stop-xray': { StopXrayCommand: class {} },
    './models': { GenericResponseModel: class { constructor(accepted) { this.accepted = accepted; } } },
    './models/torrent-blocker-reports.response.model': {},
});
function fixture() {
    const calls = [];
    const state = {
        plugins: { connectionDrop: false, ingressFilter: false, egressFilter: false, torrentBlocker: false, preStart: true, postStart: true },
        torrentBlocker: { isEnabled: false, includeRuleTagsSet: new Set() },
        preStart: { configure: () => calls.push('preStart'), cleanupSocketsConfig: { enabled: false, files: [] } },
        postStart: { configure: () => calls.push('postStart'), webhookConfig: { enabled: false } },
        isConfigChanged: () => true, resetState: () => calls.push('reset'), cleanUpActivePlugin: () => calls.push('clean'),
        updateConfigHash: () => calls.push('hash'), setPluginConfigDetails: () => calls.push('assigned'), hasActivePlugin: () => false,
    };
    const nft = { isAvailable: false, recreateTables: async () => calls.push('recreate'), syncIngressFilter: async () => calls.push('ingress') };
    const service = new PluginService(state, nft, { execute: async () => calls.push('command') }, {});
    service.portPlans = { read: async () => undefined };
    return { service, state, calls, nft };
}
const plugin = config => ({ plugin: { uuid: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'test', config: { sharedLists: [], ...config } } });
test('enabled unavailable protections reject before reset, assignment or same-hash fast path', async () => {
    for (const changed of [true, false]) {
        const f = fixture(); f.state.isConfigChanged = () => changed;
        const result = await f.service.sync(plugin({ ingressFilter: { enabled: true, blockedIps: ['203.0.113.9'] } }));
        assert.equal(result.response.accepted, false);
        assert.deepEqual(f.calls, [], 'Previous working plugin must stay intact');
    }
    const f = fixture(); f.state.plugins.ingressFilter = true;
    assert.equal((await f.service.sync(plugin({ ingressFilter: { enabled: true, blockedIps: [] } }))).response.accepted, false, 'Stale advertised capabilities must not override nft unavailability');
    assert.deepEqual(f.calls, []);
});
test('available protection applies and disabled unsupported protections do not prevent sync', async () => {
    const f = fixture(); f.nft.isAvailable = true; f.state.plugins.ingressFilter = true;
    assert.equal((await f.service.sync(plugin({ ingressFilter: { enabled: true, blockedIps: [] } }))).response.accepted, true);
    assert.ok(f.calls.includes('ingress')); assert.ok(f.calls.includes('hash'));
    const disabled = fixture();
    assert.equal((await disabled.service.sync(plugin({ ingressFilter: { enabled: false, blockedIps: [] } }))).response.accepted, true);
    assert.ok(disabled.calls.includes('hash'));
});
test('pre/post start features work without network capabilities and removal is idempotent', async () => {
    const f = fixture();
    assert.equal((await f.service.sync(plugin({ preStart: { enabled: true, cleanupSockets: { enabled: false, files: [] } }, postStart: { enabled: true, webhook: { enabled: false, url: 'https://example.test/hook' } } }))).response.accepted, true);
    assert.ok(f.calls.includes('preStart')); assert.ok(f.calls.includes('postStart'));
    const empty = fixture();
    assert.equal((await empty.service.sync({ plugin: null })).response.accepted, true);
    assert.deepEqual(empty.calls, []);
});

test('health response advertises strict plugin ACK semantics without changing legacy schema compatibility', () => {
    const { GetNodeHealthCheckResponseModel } = load(path.join(root, 'src/modules/xray-core/models/get-node-health-check.model.ts'));
    const { GetNodeHealthCheckCommand } = require('../libs/contract/build/commands/xray/get-node-health-check.command.js');
    const current = GetNodeHealthCheckCommand.ResponseSchema.parse({ response: new GetNodeHealthCheckResponseModel(true, true, null, 'test') });
    assert.equal(current.response.pluginSyncAckSupported, true);
    delete current.response.pluginSyncAckSupported;
    assert.equal(GetNodeHealthCheckCommand.ResponseSchema.safeParse(current).success, true);
});

const { TorrentBlockerState } = load(path.join(root, 'src/modules/_plugin/services/states/torrent-blocker.state.ts'), {
    '@common/constants': { DEFAULT_IGNORED_IPS: new Set() }, '@libs/contracts/models': {},
});
const { XrayWebhookSchema } = load(path.join(root, 'libs/contract/models/xray-webhook.schema.ts'));
const { XrayWebhookHandler } = load(path.join(root, 'src/modules/_plugin/events/xray-webhook/xray-webhook.handler.ts'), {
    '@common/utils/get-elapsed-time': { getTime: () => 0, formatExecutionTime: () => '' },
    '@common/utils/send-webhook': { sendWebhook() {} }, '@libs/contracts/models': { XrayWebhookSchema },
    '../../services/nft.service': {}, '../../services/plugin-state.service': {},
    './xray-webhook.event': { XrayWebhookEvent: class {} },
});
test('owner exceptions cover all device/host keys, without matching malformed prefixes', async () => {
    const state = new TorrentBlockerState(); state.configure(60, 0); state.setIgnoredUsers(['42']);
    for (const id of ['42', `42~${'a'.repeat(24)}`, `42~${'a'.repeat(24)}~h${'b'.repeat(32)}`]) assert.equal(state.isUserIgnored(id), true);
    for (const id of ['42suffix', '42~bad', `42~${'a'.repeat(23)}`, '420']) assert.equal(state.isUserIgnored(id), false);
    const calls = [], handler = new XrayWebhookHandler({ torrentBlocker: state }, { blockIp: async ip => calls.push(ip) });
    const identity = `42~${'a'.repeat(24)}~h${'b'.repeat(32)}`;
    const webhook = { level: 0, protocol: 'bittorrent', network: 'tcp', source: '203.0.113.77:30000', destination: 'peer.example.test:6881', routeTarget: null, originalTarget: null, inboundTag: 'test', inboundName: null, inboundLocal: null, outboundTag: 'block', ts: 1, email: identity };
    await handler.handle({ webhook }); assert.deepEqual(calls, []); assert.deepEqual(state.flushReports(), []);
    state.setIgnoredUsers([]); await handler.handle({ webhook }); assert.deepEqual(calls, ['203.0.113.77']);
    const [report] = state.flushReports();
    assert.equal(report.actionReport.userId, '42'); assert.equal(report.xrayReport.email, identity);
});
