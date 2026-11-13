const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function extractBootstrap() {
    const filename = path.join(__dirname, '../src/main.ts');
    const source = ts.createSourceFile(
        filename,
        fs.readFileSync(filename, 'utf8'),
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.TS,
    );
    const bootstrap = source.statements.find(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'bootstrap',
    );
    assert.ok(bootstrap, 'main.ts must declare bootstrap');
    const transformed = ts.transform(bootstrap, [
        (context) => {
            const visit = (node) => {
                if (
                    ts.isIfStatement(node) &&
                    ts.isPropertyAccessExpression(node.expression) &&
                    node.expression.name.text === 'webpackHot' &&
                    ts.isMetaProperty(node.expression.expression) &&
                    node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
                )
                    return ts.factory.createEmptyStatement();
                return ts.visitEachChild(node, visit, context);
            };
            return (node) => ts.visitNode(node, visit);
        },
    ]);
    try {
        const printed = ts
            .createPrinter()
            .printNode(ts.EmitHint.Unspecified, transformed.transformed[0], source);
        return ts.transpileModule(printed, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.CommonJS,
            },
        }).outputText;
    } finally {
        transformed.dispose();
    }
}

function fixture() {
    const socketPath = '/run/remnacust-xray-AbCd123456/internal.sock';
    const internalServer = new EventEmitter();
    const publicServer = { listening: false };
    const state = {
        initialized: false,
        bootstraps: 0,
        privateBinds: 0,
        chmod: [],
        publicBinds: [],
    };
    const permissions = Promise.withResolvers();
    const noop = () => {};
    const config = {
        getOrThrow: (name) => {
            assert.equal(name, 'NODE_PORT');
            return 2222;
        },
    };
    const app = {
        use: noop,
        useGlobalFilters: noop,
        setGlobalPrefix: noop,
        useGlobalPipes: noop,
        enableShutdownHooks: noop,
        get: () => config,
        getHttpServer: () => publicServer,
        getHttpAdapter: () => ({ getInstance: () => ({ handle: noop }) }),
        init: async () => {
            if (!state.initialized) {
                state.bootstraps++;
                state.initialized = true;
            }
        },
        listen: async (port) => {
            if (!state.initialized) await app.init();
            state.publicBinds.push(port);
            publicServer.listening = true;
        },
    };
    const bindings = {
        process: { env: { INTERNAL_SOCKET_PATH: socketPath }, on: noop },
        privateInternalSocketPath: (value) => value,
        parseNodePayload: () => ({}),
        logger: { info: noop, error: noop },
        NestFactory: { create: async () => app },
        AppModule: class {},
        WinstonModule: { createLogger: noop },
        bodyParser: { json: noop },
        compression: noop,
        helmet: noop,
        TypedConfigService: class {},
        isDevelopment: () => false,
        NotFoundExceptionFilter: class {},
        ZodValidationPipe: class {},
        ROOT: '/node',
        XRAY_INTERNAL_FULL_PATH: '/internal/get-config',
        XRAY_INTERNAL_FULL_WEBHOOK_PATH: '/internal/webhook',
        TokenAuthMiddleware: class {
            use() {}
        },
        createInternalHttpApp: () => ({
            listen: (value) => {
                assert.equal(value, socketPath);
                state.privateBinds++;
                return internalServer;
            },
        }),
        chmod: async (...args) => {
            state.chmod.push(args);
            await permissions.promise;
        },
        getStartMessage: async () => '',
        acquireInstanceLock: async () => true,
        getDuplicateInstanceMessage: () => '',
    };
    const bootstrap = new Function(
        ...Object.keys(bindings),
        extractBootstrap() + '\nreturn bootstrap;',
    )(...Object.values(bindings));
    const completion = bootstrap().then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
    );
    return { state, publicServer, internalServer, permissions, completion, socketPath };
}

for (const failChmod of [false, true])
    test(
        failChmod
            ? 'bootstrap never binds the public API when private socket chmod fails'
            : 'bootstrap waits for private listening and completed chmod 0600 before binding the public API',
        { timeout: 2000 },
        async () => {
            const f = fixture();
            await new Promise(setImmediate);
            assert.equal(f.state.bootstraps, 1);
            assert.equal(f.state.privateBinds, 1);
            assert.equal(
                f.publicServer.listening,
                false,
                'public API opened before private listening',
            );
            assert.deepEqual(f.state.publicBinds, []);
            assert.deepEqual(f.state.chmod, []);

            f.internalServer.emit('listening');
            await new Promise(setImmediate);
            assert.deepEqual(f.state.chmod, [[f.socketPath, 0o600]]);
            assert.equal(
                f.publicServer.listening,
                false,
                'public API opened before chmod completed',
            );
            assert.deepEqual(f.state.publicBinds, []);

            const failure = new Error('fixture chmod failed');
            if (failChmod) f.permissions.reject(failure);
            else f.permissions.resolve();
            const result = await f.completion;
            assert.equal(result.ok, !failChmod);
            assert.equal(f.state.bootstraps, 1);
            assert.equal(f.publicServer.listening, !failChmod);
            assert.deepEqual(f.state.publicBinds, failChmod ? [] : [2222]);
            if (failChmod) assert.equal(result.error, failure);
        },
    );

test(
    'bootstrap never binds the public API when private socket binding fails',
    { timeout: 2000 },
    async () => {
        const f = fixture();
        await new Promise(setImmediate);
        assert.equal(f.state.privateBinds, 1);
        assert.equal(f.publicServer.listening, false, 'public API opened before private listening');
        const failure = Object.assign(new Error('fixture private socket bind failed'), {
            code: 'EADDRINUSE',
        });
        f.internalServer.emit('error', failure);
        const result = await f.completion;
        assert.equal(result.ok, false);
        assert.equal(result.error, failure);
        assert.equal(f.state.bootstraps, 1);
        assert.equal(f.publicServer.listening, false);
        assert.deepEqual(f.state.publicBinds, []);
        assert.deepEqual(f.state.chmod, []);
    },
);
