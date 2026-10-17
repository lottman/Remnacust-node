const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const load = require('./load-typescript.cjs');
const { makeProfileInput, validateProfileAcknowledgement } = load(path.join(__dirname, '../src/modules/xray-core/profile-input.ts'));
const id = '11111111-1111-4111-8111-111111111111';
const canonical = (value) => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
function fixture() {
    const graph = { bindingUuid: id, configProfileUuid: id, configProfileInboundUuid: id, config: { inbounds: [{ tag: 'same', port: 443, protocol: 'vless' }], outbounds: [{ tag: 'direct', protocol: 'freedom' }], dns: { hosts: { '\ue000.example': '127.0.0.1', '😀.example': '127.0.0.2' } } } };
    const entry = { ...graph, hash: hash(graph) };
    const plan = { version: 'remnacust-profile-graphs-v1', graphs: [entry] };
    plan.hash = hash(plan);
    const target = { revision: '9223372036854775807', enabled: true, delivery: { epoch: '9223372036854775807', owner: id } };
    return { plan, target, root: { stats: {}, outbounds: [{ protocol: 'freedom' }] }, inputs: 'a'.repeat(64) };
}
function inputOf(value) { return makeProfileInput(value.root, value.plan, value.target, value.inputs); }
test('panel canonical source hashes and UUID provenance survive native envelope translation', () => {
    const source = fixture(), input = inputOf(source);
    assert.equal(input.version, 'remnacust-profile-input-v1');
    assert.equal(input.delivery.epoch, source.target.delivery.epoch);
    assert.equal(input.delivery.revision, source.target.revision);
    assert.equal(input.graphs[0].bindingUuid, id);
    assert.equal(input.graphs[0].hash, undefined);
    source.plan.graphs[0].config.inbounds[0].port = 80;
    source.root.outbounds[0].protocol = 'blackhole';
    assert.equal(input.graphs[0].config.inbounds[0].port, 443);
    assert.equal(input.root.outbounds[0].protocol, 'freedom');
});
test('modified source hashes, ambiguous modes and unsafe environment fail before native execution', () => {
    for (const mutate of [
        s => { s.plan.graphs[0].config.inbounds[0].port = 80; },
        s => { s.plan.hash = 'b'.repeat(64); },
        s => { s.plan.graphs[0].bindingUuid = 'invalid'; },
        s => { s.target.delivery.epoch = '9223372036854775808'; },
        s => { s.target.enabled = false; },
        s => { s.root.eNv = { ENV_SENTINEL: 'changed' }; },
        s => { s.plan.graphs.push(s.plan.graphs[0]); },
    ]) { const source = fixture(); mutate(source); assert.throws(() => inputOf(source)); }
});
test('native acknowledgements bind the exact delivery and expose no false core incarnation', () => {
    const input = inputOf(fixture());
    const valid = { hash: 'b'.repeat(64), coreProcessId: id, graphCount: 1, unchanged: false, delivery: { ...input.delivery, planHash: 'c'.repeat(64) } };
    assert.equal(validateProfileAcknowledgement(valid, input, true), valid);
    for (const mutate of [
        s => { s.delivery.epoch = '1'; }, s => { s.delivery.inputsHash = 'd'.repeat(64); },
        s => { s.delivery.owner = '22222222-2222-4222-8222-222222222222'; },
        s => { s.graphCount = 2; }, s => { delete s.coreProcessId; }, s => { s.delivery.planHash = 'invalid'; },
    ]) { const response = structuredClone(valid); mutate(response); assert.throws(() => validateProfileAcknowledgement(response, input, true)); }
    const cached = { ...valid }; delete cached.coreProcessId;
    assert.equal(validateProfileAcknowledgement(cached, input, false), cached);
});
