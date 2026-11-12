const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(
    path.join(__dirname, '../src/modules/xray-core/xray.service.ts'),
    'utf8',
);
const ast = ts.createSourceFile('xray.service.ts', source, ts.ScriptTarget.Latest, true);
let initializer;
function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'rememberConfiguration') {
        assert.equal(initializer, undefined);
        initializer = node.initializer.getText(ast);
    }
    ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(initializer);
const emitted = ts
    .transpileModule(`(${initializer})`, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            alwaysStrict: false,
        },
    })
    .outputText.trim()
    .replace(/;$/, '');
const create = new Function('body', 'profileInput', 'fullConfig', `return ${emitted}`);

function fixture(profileInput = null) {
    let resolve, reject;
    const pending = new Promise((ok, fail) => {
        resolve = ok;
        reject = fail;
    });
    const calls = [];
    const service = {
        restoredUnclaimedConfiguration: true,
        configurationReady: true,
        cleanups: 0,
        internalService: {
            cleanup: () => {
                service.configurationReady = false;
                service.cleanups += 1;
            },
            extractUsersFromConfig: (...args) => {
                calls.push(args);
                return pending;
            },
        },
    };
    const config = { inbounds: [{ tag: 'default' }] };
    const body = { internals: { hashes: { emptyConfig: 'fixture' } } };
    return {
        service,
        calls,
        resolve,
        reject,
        body,
        config,
        remember: create.call(service, body, profileInput, config),
    };
}

test('configuration acknowledgement waits for extraction before clearing restored state', async () => {
    const f = fixture();
    const done = f.remember();
    assert.equal(typeof done?.then, 'function');
    assert.equal(f.service.restoredUnclaimedConfiguration, true);
    assert.equal(f.calls[0][0], f.body.internals.hashes);
    assert.equal(f.calls[0][1], f.config);
    f.resolve();
    await done;
    assert.equal(f.service.restoredUnclaimedConfiguration, false);
});

test('profile bindings are extracted completely before the caller continues', async () => {
    const input = {
        graphs: [
            { bindingUuid: 'binding-a', config: { inbounds: [{ tag: 'a' }] } },
            { bindingUuid: 'binding-b', config: { inbounds: [{ tag: 'b' }] } },
        ],
    };
    const f = fixture(input);
    let complete = false;
    const done = f.remember().then(() => {
        complete = true;
    });
    await Promise.resolve();
    assert.equal(complete, false);
    assert.deepEqual(f.calls[0][1].inbounds, [{ tag: 'a' }, { tag: 'b' }]);
    assert.deepEqual(f.calls[0][2], [
        { bindingUuid: 'binding-a', inboundTag: 'a' },
        { bindingUuid: 'binding-b', inboundTag: 'b' },
    ]);
    assert.equal(f.calls[0][3], input);
    f.resolve();
    await done;
    assert.equal(complete, true);
});

test('extraction failure reaches the start operation and keeps restored state unchanged', async () => {
    const f = fixture();
    const done = f.remember();
    const error = new Error('fixture extraction failed');
    const checked = assert.rejects(done, (value) => value === error);
    f.reject(error);
    await checked;
    assert.equal(f.service.restoredUnclaimedConfiguration, true);
    assert.equal(f.service.configurationReady, false);
    assert.equal(f.service.cleanups, 1);
});

test('real internal state is invalidated after both early and partial extraction failures', async () => {
    const load = require('./load-typescript.cjs');
    const { InternalService } = load(
        path.join(__dirname, '../src/modules/internal/internal.service.ts'),
        {
            '@nestjs/common': {
                Injectable: () => (value) => value,
                Logger: class {
                    log() {}
                    debug() {}
                },
            },
            '@libs/contracts/commands': {},
        },
    );
    for (const partial of [false, true]) {
        const internal = new InternalService();
        const config = {
            inbounds: [
                {
                    tag: 'fixture',
                    settings: { clients: [{ id: '00000000-0000-4000-8000-000000000001' }] },
                },
            ],
        };
        const hashes = { emptyConfig: 'fixture', inbounds: [{ tag: 'fixture', hash: 'fixture' }] };
        const extract = internal.extractUsersFromConfig.bind(internal);
        await extract(hashes, config);
        assert.equal(internal.hasConfiguration(), true);
        const error = new Error('fixture failure');
        internal.extractUsersFromConfig = async (...args) => {
            if (partial) await extract(...args);
            throw error;
        };
        const service = { internalService: internal, restoredUnclaimedConfiguration: true };
        const remember = create.call(service, { internals: { hashes } }, null, config);
        await assert.rejects(remember(), (value) => value === error);
        assert.equal(internal.hasConfiguration(), false);
        assert.equal(internal.hasProfileBindings(), false);
        assert.deepEqual(await internal.getXrayConfig(), {});
    }
});
