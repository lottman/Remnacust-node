require('reflect-metadata');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const nest = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { PassportModule } = require('@nestjs/passport');
const jwt = require('jsonwebtoken');
const ts = require('typescript');

const root = path.join(__dirname, '..');

function sourceLoader(mocks = {}) {
    const cache = new Map();
    const aliases = {
        '@common/': 'src/common/',
        '@libs/contracts/': 'libs/contract/',
    };
    function load(filename) {
        filename = path.resolve(root, filename);
        if (fs.existsSync(filename) && fs.statSync(filename).isDirectory())
            filename = path.join(filename, 'index.ts');
        else if (!filename.endsWith('.ts')) filename += '.ts';
        if (cache.has(filename)) return cache.get(filename).exports;
        const ref = { exports: {} };
        cache.set(filename, ref);
        const local = createRequire(filename);
        const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                experimentalDecorators: true,
                emitDecoratorMetadata: true,
                esModuleInterop: true,
            },
        }).outputText;
        new Function('require', 'module', 'exports', code)(
            (id) => {
                if (Object.hasOwn(mocks, id)) return mocks[id];
                for (const [alias, directory] of Object.entries(aliases))
                    if (id.startsWith(alias)) return load(directory + id.slice(alias.length));
                if (id.startsWith('.')) return load(path.resolve(path.dirname(filename), id));
                return local(id);
            },
            ref,
            ref.exports,
        );
        return ref.exports;
    }
    return load;
}

const contract = sourceLoader();
const {
    AssignedUnicastAddressSchema,
    NetworkAddressesSchema,
    NodeSystemInfoSchema,
    MAX_NETWORK_ADDRESSES,
} = contract('libs/contract/models');
const { GetNetworkAddressesCommand, GetSystemStatsCommand } = contract('libs/contract/commands');

function assigned(address, overrides = {}) {
    return {
        address,
        family: address.includes(':') ? 'IPv6' : 'IPv4',
        internal: false,
        netmask: address.includes(':') ? 'ffff:ffff:ffff:ffff::' : '255.255.255.0',
        mac: '00:11:22:33:44:55',
        cidr: null,
        ...overrides,
    };
}

function inventory(count) {
    return {
        eth0: Array.from({ length: count }, (_, index) => assigned(`2001:db8::${index + 1}`)),
    };
}

function fixture(interfaces = {}) {
    const state = { interfaces, scans: 0, error: null, coreReads: 0, logs: [], up: false };
    class Config {}
    class Process {}
    class Internal {}
    class QueryBus {}
    class RuntimeService {}
    class GeocheckService {}
    const sdkToken = Symbol('isolated SDK');
    const forbidden = () => {
        throw Error('Network inventory must not access Core or its state');
    };
    const mocks = {
        'node:os': {
            ...os,
            networkInterfaces() {
                state.scans++;
                if (state.error) throw state.error;
                return state.interfaces;
            },
        },
        '@nestjs/cqrs': { ...require('@nestjs/cqrs'), QueryBus },
        '@remnawave/xtls-sdk': { XtlsApi: class {} },
        '@remnawave/xtls-sdk-nestjs': { InjectXtls: () => nest.Inject(sdkToken) },
        '@common/config/app-config/typed-config.service': { TypedConfigService: Config },
        '../internal/internal.service': { InternalService: Internal },
        '../xray-core/xray-process.service': { XrayProcessService: Process },
        '../xray-core/profile-traffic': { readProfileTraffic: forbidden },
        './runtime.service': { RuntimeService },
        './geocheck.service': { GeocheckService },
    };
    const load = sourceLoader(mocks);
    const utils = load('src/common/utils/get-system-stats');
    const { StatsService } = load('src/modules/stats/stats.service.ts');
    const { StatsController } = load('src/modules/stats/stats.controller.ts');
    const management = load('src/modules/xray-core/core-management.ts').coreManagement;
    const processService = {
        async getStatus() {
            state.coreReads++;
            return { up: state.up, pid: state.up ? 42 : null };
        },
        isApiSocketAvailable() {
            state.coreReads++;
            return state.up;
        },
    };
    const sdk = {
        get stats() {
            return forbidden();
        },
    };
    const queryBus = { execute: forbidden };
    const internalService = { hasConfiguration: forbidden, hasProfileBindings: forbidden };
    const service = new StatsService(sdk, queryBus, processService, internalService);
    service.logger = {
        error: (...args) => state.logs.push(args),
        warn: (...args) => state.logs.push(args),
    };
    const controller = new StatsController(service, new RuntimeService(), new GeocheckService());
    return {
        state,
        utils,
        load,
        mocks,
        service,
        controller,
        management,
        StatsService,
        StatsController,
        Config,
        Process,
        Internal,
        QueryBus,
        RuntimeService,
        GeocheckService,
        sdkToken,
        sdk,
        queryBus,
        processService,
        internalService,
    };
}

function readyTelemetry(f, service = f.service) {
    f.state.up = true;
    f.queryBus.execute = async (query) =>
        query.constructor.name === 'GetInterfaceStatsQuery' ? null : 0;
    f.internalService.hasConfiguration = () => true;
    f.internalService.hasProfileBindings = () => false;
    service.coreStats = {
        getSysStats: async () => ({
            isOk: true,
            data: {
                numGoroutine: 0,
                numGC: 0,
                alloc: 0,
                totalAlloc: 0,
                sys: 0,
                mallocs: 0,
                frees: 0,
                liveObjects: 0,
                pauseTotalNs: 0,
                uptime: 0,
            },
        }),
    };
}

test('every successful system-stats telemetry response carries fresh IP metadata and preserves Core availability semantics', async () => {
    const f = fixture({ eth0: [assigned('2001:db8::1')] });
    readyTelemetry(f);
    const first = GetSystemStatsCommand.ResponseSchema.parse(await f.controller.getSystemStats());
    assert.deepEqual(first.response.system.info, { ipAddresses: ['2001:db8::1'] });
    assert.equal(f.state.scans, 1);
    f.state.interfaces = { ens3: [assigned('192.0.2.2'), assigned('2001:db8::2')] };
    const second = GetSystemStatsCommand.ResponseSchema.parse(await f.controller.getSystemStats());
    assert.deepEqual(second.response.system.info, { ipAddresses: ['192.0.2.2', '2001:db8::2'] });
    assert.equal(f.state.scans, 2);
    const { info, ...legacySystem } = second.response.system;
    assert.equal(
        GetSystemStatsCommand.ResponseSchema.safeParse({
            response: { ...second.response, system: legacySystem },
        }).success,
        true,
    );
    assert.deepEqual(info.ipAddresses, ['192.0.2.2', '2001:db8::2']);
    f.state.interfaces = {};
    assert.deepEqual((await f.controller.getSystemStats()).response.system.info, {
        ipAddresses: [],
    });
    f.state.interfaces = inventory(65);
    assert.equal(
        Object.hasOwn((await f.controller.getSystemStats()).response.system, 'info'),
        false,
    );
    f.state.error = Error('isolated enumeration failure');
    assert.equal(
        Object.hasOwn((await f.controller.getSystemStats()).response.system, 'info'),
        false,
    );
    assert.equal(f.state.scans, 5);
    assert.deepEqual(f.state.logs, []);
    f.state.up = false;
    await assert.rejects(f.controller.getSystemStats(), (error) => error.getStatus() === 503);
    const release = f.management.acquire();
    try {
        await assert.rejects(f.controller.getSystemStats(), (error) => error.getStatus() === 503);
    } finally {
        release();
    }
    assert.equal(f.state.scans, 5);
    f.state.up = true;
    f.service.coreStats = { getSysStats: async () => ({ isOk: false }) };
    await assert.rejects(
        f.controller.getSystemStats(),
        (error) => error.getStatus() === 500 && error.errorCode === 'A010',
    );
    assert.equal(f.state.scans, 5);
});

test('the exported RPC schema canonicalizes safe unicast literals, mapped IPv4 and duplicates', () => {
    assert.equal(GetNetworkAddressesCommand.url, '/node/stats/network-addresses');
    assert.equal(MAX_NETWORK_ADDRESSES, 64);
    assert.deepEqual(
        GetNetworkAddressesCommand.ResponseSchema.parse({
            response: {
                addresses: [
                    '2001:0DB8:0:0:1:0:0:1',
                    '2001:db8::1:0:0:1',
                    '::FFFF:192.0.2.7',
                    '::ffff:c000:207',
                    '192.0.2.7',
                    '10.2.3.4',
                    'FC00:0:0:0:0:0:0:7',
                ],
                complete: true,
            },
        }),
        {
            response: {
                addresses: ['10.2.3.4', '192.0.2.7', '2001:db8::1:0:0:1', 'fc00::7'],
                complete: true,
            },
        },
    );
    assert.deepEqual(
        GetNetworkAddressesCommand.ResponseSchema.parse({
            response: { addresses: [], complete: true },
        }),
        { response: { addresses: [], complete: true } },
    );
    for (const response of [
        { addresses: [] },
        { addresses: [], complete: false },
        { addresses: '192.0.2.7', complete: true },
    ])
        assert.equal(
            GetNetworkAddressesCommand.ResponseSchema.safeParse({ response }).success,
            false,
        );
});

const rejected = [
    '',
    'node.example',
    ' 192.0.2.7',
    '192.0.2.7 ',
    '192.000.2.7',
    '192.0.2.7/24',
    '192.0.2.7:443',
    '999.2.3.4',
    '0.0.0.0',
    '0.1.2.3',
    '127.0.0.1',
    '127.9.8.7',
    '169.254.7.1',
    '224.0.0.1',
    '239.1.2.3',
    '240.1.2.3',
    '255.255.255.255',
    '::',
    '::1',
    '::192.0.2.7',
    'fe80::1',
    'febf::7',
    'fec0::7',
    'ff02::1',
    'ff0e::7',
    '[2001:db8::7]',
    '2001:db8::7/64',
    'fe80::1%eth0',
    '2001:db8::7%eth0',
    '2001:db8::7%25eth0',
    '2001:db8::g',
    '::ffff:0.0.0.0',
    '::ffff:127.0.0.1',
    '::ffff:169.254.1.2',
    '::ffff:224.0.0.1',
    '::ffff:255.255.255.255',
];

test('the shared validator rejects unsafe, nonliteral and scoped addresses in RPC and optional metadata', () => {
    const f = fixture();
    const info = f.utils.getSystemInfo();
    assert.equal(NodeSystemInfoSchema.safeParse(info).success, true);
    for (const address of rejected) {
        assert.equal(AssignedUnicastAddressSchema.safeParse(address).success, false, address);
        assert.equal(
            GetNetworkAddressesCommand.ResponseSchema.safeParse({
                response: { addresses: [address], complete: true },
            }).success,
            false,
            address,
        );
        assert.equal(
            NodeSystemInfoSchema.safeParse({ ...info, ipAddresses: [address] }).success,
            false,
            address,
        );
    }
    const { ipAddresses, ...legacy } = info;
    assert.deepEqual(ipAddresses, []);
    assert.equal(NodeSystemInfoSchema.safeParse(legacy).success, true);
    assert.deepEqual(NodeSystemInfoSchema.omit({ ipAddresses: true }).parse(info), legacy);
});

test('the collector filters internal, invalid and family-mismatched entries and deduplicates across interfaces', () => {
    const f = fixture({
        eth0: [
            ...rejected.map((address) => assigned(address)),
            assigned('192.0.2.7'),
            assigned('::ffff:192.0.2.7'),
            assigned('2001:0DB8:0:0:0:0:0:7'),
            assigned('2001:db8::7'),
            assigned('10.0.0.7'),
            assigned('100.64.0.7'),
            assigned('fc00::7'),
            assigned('192.0.2.8', { internal: true }),
            assigned('2001:db8::8', { internal: true }),
            assigned('192.0.2.9', { family: 'IPv6' }),
            assigned('2001:db8::9', { family: 'IPv4' }),
            assigned('192.0.2.10', { family: 'unsupported' }),
        ],
        ens3: [assigned('::ffff:c000:207'), assigned('2001:db8::7')],
        removed: undefined,
    });
    assert.deepEqual(f.utils.getNetworkAddresses(), {
        addresses: ['10.0.0.7', '100.64.0.7', '192.0.2.7', '2001:db8::7', 'fc00::7'],
        complete: true,
    });
    assert.equal(f.state.scans, 1);
});

test('private, CGNAT and ULA on ordinary interfaces survive but known data-plane adapters do not suggest them', () => {
    const privateAddresses = [
        '10.0.0.7',
        '172.16.0.7',
        '192.168.1.7',
        '100.64.0.7',
        'fd00::7',
        '::ffff:10.0.0.7',
    ];
    const virtualNames = [
        'docker0',
        'veth123',
        'br-ab12',
        'br0',
        'bridge0',
        'virbr0',
        'lxcbr0',
        'lxdbr0',
        'podman0',
        'vnet0',
        'tun0',
        'tap1',
        'utun2',
        'wg0',
        'wg-office',
        'wgprod',
        'WireGuard Tunnel',
        'wintun',
        'tailscale0',
        'ztabc123',
        'cni0',
        'flannel.1',
        'cali123',
        'kube-ipvs0',
        'vxlan0',
        'geneve0',
        'dummy0',
        'ifb0',
        'sit0',
        'ip6tnl0',
        'ipip0',
        'gre0',
        'gretap0',
        'ppp0',
        'vpn0',
        'ipsec0',
        'vEthernet (Default Switch)',
        'vboxnet0',
        'VMware Network Adapter VMnet8',
    ];
    const f = fixture(
        Object.fromEntries(
            virtualNames.map((name) => [
                name,
                privateAddresses.map((address) => assigned(address)),
            ]),
        ),
    );
    assert.deepEqual(f.utils.getNetworkAddresses(), { addresses: [], complete: true });
    f.state.interfaces = {
        tun0: [
            '198.18.0.1',
            '198.19.255.254',
            '::ffff:c612:1',
            '::ffff:198.19.0.1',
            '198.17.255.254',
            '198.20.0.1',
        ].map((address) => assigned(address)),
    };
    assert.deepEqual(f.utils.getNetworkAddresses(), {
        addresses: ['198.17.255.254', '198.20.0.1'],
        complete: true,
    });
    f.state.interfaces = {
        Ethernet: privateAddresses.map((address) => assigned(address)),
        'enp3s0.100': [assigned('fd00::8')],
        veth123: [assigned('192.0.2.8'), assigned('2001:db8::8')],
    };
    assert.deepEqual(f.utils.getNetworkAddresses(), {
        addresses: [
            '10.0.0.7',
            '100.64.0.7',
            '172.16.0.7',
            '192.0.2.8',
            '192.168.1.7',
            '2001:db8::8',
            'fd00::7',
            'fd00::8',
        ],
        complete: true,
    });
});

test('64 unique addresses are complete, overflow fails without truncation and metadata omits the optional field', async () => {
    const f = fixture(inventory(64));
    f.state.interfaces.eth0.push(...f.state.interfaces.eth0);
    assert.equal(f.utils.getNetworkAddresses().addresses.length, 64);
    assert.equal(
        NetworkAddressesSchema.safeParse(f.utils.getNetworkAddresses().addresses).success,
        true,
    );
    f.state.interfaces = inventory(65);
    assert.throws(() => f.utils.getNetworkAddresses(), /exceeds the supported limit/);
    assert.equal(
        NetworkAddressesSchema.safeParse(f.state.interfaces.eth0.map((entry) => entry.address))
            .success,
        false,
    );
    assert.equal(NetworkAddressesSchema.safeParse(Array(65).fill('2001:db8::1')).success, false);
    assert.equal(
        GetNetworkAddressesCommand.ResponseSchema.safeParse({
            response: {
                addresses: f.state.interfaces.eth0.map((entry) => entry.address),
                complete: true,
            },
        }).success,
        false,
    );
    const info = f.utils.getSystemInfo();
    assert.equal(Object.hasOwn(info, 'ipAddresses'), false);
    assert.deepEqual(info.networkInterfaces, ['eth0']);
    assert.equal(NodeSystemInfoSchema.safeParse(info).success, true);
    assert.equal((await f.service.getNetworkAddresses()).isOk, false);
    await assert.rejects(
        f.controller.getNetworkAddresses(),
        (error) => error.getStatus() === 503 && error.errorCode === 'A019',
    );
    assert.deepEqual(f.state.logs, []);
});

test('metadata and RPC scan freshly, distinguish empty success from failure, and hide raw enumeration errors', async () => {
    const f = fixture({ eth0: [assigned('2001:db8::1')] });
    assert.deepEqual(f.utils.getSystemInfo().ipAddresses, ['2001:db8::1']);
    f.state.interfaces = { ens3: [assigned('2001:db8::2'), assigned('192.0.2.2')] };
    assert.deepEqual(f.utils.getSystemInfo().ipAddresses, ['192.0.2.2', '2001:db8::2']);
    assert.deepEqual(await f.controller.getNetworkAddresses(), {
        response: { addresses: ['192.0.2.2', '2001:db8::2'], complete: true },
    });
    f.state.interfaces = {};
    assert.deepEqual(await f.controller.getNetworkAddresses(), {
        response: { addresses: [], complete: true },
    });
    assert.deepEqual(f.utils.getSystemInfo().ipAddresses, []);
    f.state.error = Error('isolated OS failure with sensitive fixture data');
    assert.equal(Object.hasOwn(f.utils.getSystemInfo(), 'ipAddresses'), false);
    await assert.rejects(
        f.controller.getNetworkAddresses(),
        (error) => error.getStatus() === 503 && !error.message.includes('sensitive'),
    );
    f.state.error = null;
    f.state.interfaces = { eth0: [assigned('2001:db8::3')] };
    assert.deepEqual(await f.controller.getNetworkAddresses(), {
        response: { addresses: ['2001:db8::3'], complete: true },
    });
    assert.equal(f.state.scans, 8);
    assert.deepEqual(f.state.logs, []);
});

test('the actual stats service and controller allow inventory while Core is down or management is busy', async () => {
    const f = fixture({ eth0: [assigned('2001:db8::7')] });
    assert.deepEqual(await f.controller.getNetworkAddresses(), {
        response: { addresses: ['2001:db8::7'], complete: true },
    });
    const release = f.management.acquire();
    try {
        assert.equal((await f.controller.getNetworkAddresses()).response.complete, true);
        assert.equal(f.management.isBusy(), true);
        await assert.rejects(f.service.getSystemStats(), (error) => error.getStatus() === 503);
    } finally {
        release();
    }
    assert.equal(f.state.coreReads, 0);
    await assert.rejects(f.service.getSystemStats(), (error) => error.getStatus() === 503);
    assert.equal(f.state.coreReads, 1);
    assert.equal(f.state.scans, 2);
});

test('the existing start response uses current system info rather than a bootstrap snapshot', async () => {
    const f = fixture({ eth0: [assigned('2001:db8::1')] });
    const filename = path.join(root, 'src/modules/xray-core/xray.service.ts');
    const mocks = Object.fromEntries(
        [...fs.readFileSync(filename, 'utf8').matchAll(/from '([^']+)'/g)]
            .filter((match) => !match[1].startsWith('node:'))
            .map((match) => [match[1], {}]),
    );
    Object.assign(mocks, {
        '@nestjs/common': nest,
        '@remnawave/xtls-sdk-nestjs': { InjectXtls: () => () => {} },
        '@common/types': f.load('src/common/types'),
        '@common/utils/get-system-stats': f.utils,
        '../network-stats/queries/get-interface-stats/get-interface-stats.query': f.load(
            'src/modules/network-stats/queries/get-interface-stats/get-interface-stats.query.ts',
        ),
        './core-management': { coreManagement: f.management },
        './models': f.load('src/modules/xray-core/models/start-xray.response.model.ts'),
    });
    const { XrayService } = sourceLoader(mocks)(filename);
    const service = Object.assign(Object.create(XrayService.prototype), {
        queryBus: { execute: async () => null },
        logger: { warn() {} },
        isXrayStartedProccesing: true,
        nodeVersion: 'fixture',
        xrayVersion: null,
    });
    assert.deepEqual((await service.startXray({}, '127.0.0.1')).response.system.info.ipAddresses, [
        '2001:db8::1',
    ]);
    f.state.interfaces = { eth0: [assigned('2001:db8::2')] };
    assert.deepEqual((await service.startXray({}, '127.0.0.1')).response.system.info.ipAddresses, [
        '2001:db8::2',
    ]);
    assert.equal(f.state.scans, 2);
});

test('inventory inherits JWT guards and the public mTLS listener, never the private unauthenticated path', () => {
    const f = fixture();
    const { JwtDefaultGuard } = f.load('src/common/guards/jwt-guards/def-jwt-guard.ts');
    assert.deepEqual(Reflect.getMetadata('__guards__', f.StatsController), [JwtDefaultGuard]);
    assert.equal(
        Reflect.getMetadata('path', f.StatsController.prototype.getNetworkAddresses),
        'network-addresses',
    );
    assert.equal(
        Reflect.getMetadata('method', f.StatsController.prototype.getNetworkAddresses),
        nest.RequestMethod.GET,
    );
    const main = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8');
    assert.match(main, /requestCert:\s*true/);
    assert.match(main, /rejectUnauthorized:\s*true/);
    assert.match(main, /minVersion:\s*'TLSv1\.3'/);
    assert.match(main, /app\.setGlobalPrefix\(ROOT/);
    assert.match(main, /\[XRAY_INTERNAL_FULL_PATH, XRAY_INTERNAL_FULL_WEBHOOK_PATH\]/);
    const internal = f.load('libs/contract/constants/internal/internal.constants.ts');
    assert.notEqual(internal.XRAY_INTERNAL_FULL_PATH, GetNetworkAddressesCommand.url);
    assert.notEqual(internal.XRAY_INTERNAL_FULL_WEBHOOK_PATH, GetNetworkAddressesCommand.url);
});

test('the actual stats module HTTP endpoint enforces JWT before scanning and works through Core downtime, busy starts and scan errors', async () => {
    const f = fixture({ eth0: [assigned('2001:db8::1')] });
    class Dependencies {}
    nest.Module({
        providers: [
            { provide: f.sdkToken, useValue: f.sdk },
            { provide: f.Process, useValue: f.processService },
            { provide: f.Internal, useValue: f.internalService },
            { provide: f.QueryBus, useValue: f.queryBus },
        ],
        exports: [f.sdkToken, f.Process, f.Internal, f.QueryBus],
    })(Dependencies);
    f.mocks['@nestjs/cqrs'].CqrsModule = Dependencies;
    f.mocks['../xray-core/xray.module'] = { XrayModule: Dependencies };
    const { StatsModule } = f.load('src/modules/stats/stats.module.ts');
    assert.deepEqual(Reflect.getMetadata('controllers', StatsModule), [f.StatsController]);
    assert.ok(Reflect.getMetadata('providers', StatsModule).includes(f.StatsService));
    const keyPair = () =>
        crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
    const { privateKey, publicKey } = keyPair();
    const other = keyPair();
    const { JwtStrategy } = f.load('src/common/guards/jwt-guards/strategies/validate-token.ts');
    class Root {}
    nest.Module({
        imports: [StatsModule, PassportModule.register({ defaultStrategy: 'registeredUserJWT' })],
        providers: [
            {
                provide: JwtStrategy,
                useFactory: () =>
                    new JwtStrategy({
                        getOrThrow: (key) => {
                            assert.equal(key, 'JWT_PUBLIC_KEY');
                            return publicKey;
                        },
                    }),
            },
        ],
    })(Root);
    const app = await NestFactory.create(Root, { logger: false, abortOnError: false });
    app.setGlobalPrefix('/node');
    try {
        await app.listen(0, '127.0.0.1');
        const origin = await app.getUrl();
        const request = (token) =>
            fetch(origin + GetNetworkAddressesCommand.url, {
                headers: token ? { authorization: `Bearer ${token}` } : {},
            });
        const payload = Buffer.from(JSON.stringify({ sub: 'panel' })).toString('base64url');
        const hmacInput =
            Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url') +
            '.' +
            payload;
        const confusion =
            hmacInput +
            '.' +
            crypto.createHmac('sha256', publicKey).update(hmacInput).digest('base64url');
        const invalid = [
            null,
            'broken',
            jwt.sign({ sub: 'panel' }, other.privateKey, { algorithm: 'RS256', expiresIn: 60 }),
            jwt.sign({ sub: 'panel' }, privateKey, { algorithm: 'RS256', expiresIn: -60 }),
            jwt.sign({ sub: 'panel', nbf: Math.floor(Date.now() / 1000) + 3600 }, privateKey, {
                algorithm: 'RS256',
                expiresIn: 60,
            }),
            Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') +
                '.' +
                payload +
                '.',
            confusion,
            jwt.sign({ sub: 'panel' }, 'isolated-hmac-fixture', {
                algorithm: 'HS256',
                expiresIn: 60,
            }),
        ];
        for (const token of invalid) {
            const response = await request(token);
            assert.equal(response.status, 401);
            await response.arrayBuffer();
        }
        const valid = jwt.sign({ sub: 'panel' }, privateKey, { algorithm: 'RS256', expiresIn: 60 });
        for (const [url, headers] of [
            [origin + GetNetworkAddressesCommand.url, { authorization: `Basic ${valid}` }],
            [origin + GetNetworkAddressesCommand.url + '?token=' + valid, {}],
            [origin + GetNetworkAddressesCommand.url + '?access_token=' + valid, {}],
        ]) {
            const denied = await fetch(url, { headers });
            assert.equal(denied.status, 401);
            await denied.arrayBuffer();
        }
        assert.equal(f.state.scans, 0);
        let response = await request(valid);
        assert.equal(response.status, 200);
        assert.deepEqual(GetNetworkAddressesCommand.ResponseSchema.parse(await response.json()), {
            response: { addresses: ['2001:db8::1'], complete: true },
        });
        const release = f.management.acquire();
        try {
            f.state.interfaces = { eth0: [assigned('192.0.2.2'), assigned('2001:db8::2')] };
            response = await request(valid);
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), {
                response: { addresses: ['192.0.2.2', '2001:db8::2'], complete: true },
            });
            assert.equal(f.management.isBusy(), true);
        } finally {
            release();
        }
        f.state.interfaces = {};
        response = await request(valid);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { response: { addresses: [], complete: true } });
        for (const failure of ['overflow', 'OS failure']) {
            f.state.interfaces = inventory(65);
            f.state.error =
                failure === 'OS failure' ? Error('sensitive isolated fixture details') : null;
            response = await request(valid);
            assert.equal(response.status, 503);
            const error = await response.json();
            assert.equal(error.errorCode, 'A019');
            assert.equal(Object.hasOwn(error, 'response'), false);
            assert.doesNotMatch(JSON.stringify(error), /sensitive|2001:db8/);
        }
        assert.equal(f.state.coreReads, 0);
        assert.equal(f.state.scans, 5);
        f.state.error = null;
        f.state.interfaces = { eth0: [assigned('2001:db8::31')] };
        readyTelemetry(f, app.get(f.StatsService));
        const telemetry = () =>
            fetch(origin + GetSystemStatsCommand.url, {
                headers: { authorization: `Bearer ${valid}` },
            });
        response = await telemetry();
        assert.equal(response.status, 200);
        assert.deepEqual(
            GetSystemStatsCommand.ResponseSchema.parse(await response.json()).response.system.info,
            { ipAddresses: ['2001:db8::31'] },
        );
        f.state.interfaces = { eth0: [assigned('2001:db8::32')] };
        response = await telemetry();
        assert.equal(response.status, 200);
        assert.deepEqual(
            GetSystemStatsCommand.ResponseSchema.parse(await response.json()).response.system.info,
            { ipAddresses: ['2001:db8::32'] },
        );
        assert.equal(f.state.scans, 7);
    } finally {
        await app.close();
    }
});
