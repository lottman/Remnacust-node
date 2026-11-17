const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const load = require('./load-typescript.cjs');
const { configSchema } = load(
    path.join(__dirname, '../src/common/config/app-config/config.schema.ts'),
    {
        '@common/utils/decode-node-payload': {
            parseNodePayloadFromConfigService: () => ({ jwtPublicKey: 'fixture' }),
        },
    },
);
test('nftables names retain the old default and reject unsafe identifiers', () => {
    const field = configSchema.shape.NFTABLES_TABLE_NAME;
    for (const value of [undefined, '', '   ']) assert.equal(field.parse(value), 'remnanode');
    for (const value of ['node_2', 'node-2', '_test', 'x'.repeat(63)])
        assert.equal(field.parse(' ' + value + ' '), value);
    for (const value of ['0bad', 'a;delete table inet x', '../nft', 'a\nb', 'x'.repeat(64)])
        assert.equal(field.safeParse(value).success, false, value);
    assert.equal(configSchema.shape.SUPPRESS_DUPLICATE_INSTANCE_WARNING.parse(undefined), false);
    assert.equal(configSchema.shape.SUPPRESS_DUPLICATE_INSTANCE_WARNING.parse('true'), true);
    assert.equal(
        configSchema.shape.SUPPRESS_DUPLICATE_INSTANCE_WARNING.safeParse('yes').success,
        false,
    );
});
test('configured nftables name reaches the real initialization path and NET_ADMIN absence still disables it', async () => {
    let options,
        capable = true;
    const { NftService } = load(
        path.join(__dirname, '../src/modules/_plugin/services/nft.service.ts'),
        {
            'nftables-napi': {
                NftManager: class {
                    constructor(value) {
                        options = value;
                    }
                },
            },
            sockdestroy: { hasCapNetAdmin: () => capable },
            '@common/config/app-config': { TypedConfigService: class {} },
            '@common/types/result.type': {},
            '../constants/nfttables.contants': load(
                path.join(__dirname, '../src/modules/_plugin/constants/nfttables.contants.ts'),
            ),
            '../dtos': {},
            '../events/drop-connections': {},
            '../models/generic.response.model': {},
            './plugin-state.service': {},
        },
    );
    const state = {
        plugins: {},
        setPlugins(value) {
            this.plugins = value;
        },
    };
    const config = {
        getOrThrow: (key) =>
            ({
                NFTABLES_TABLE_NAME: 'node_second',
                NFTABLES_LOGGING: false,
                NFTABLES_ACCEPT_REPLY_TRAFFIC: true,
            })[key],
    };
    const service = new NftService(state, {}, config);
    service.recreateTables = async () => {};
    await service.onModuleInit();
    assert.equal(service.isAvailable, true);
    assert.equal(options.tableName, 'node_second');
    assert.equal(options.acceptReplyTraffic, true);
    options = null;
    capable = false;
    const disabled = new NftService(state, {}, config);
    await disabled.onModuleInit();
    assert.equal(disabled.isAvailable, false);
    assert.equal(options, null);
});
