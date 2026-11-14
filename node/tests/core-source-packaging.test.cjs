const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');

const execute = promisify(execFile);
const python = process.env.REMNACUST_PACKAGER_PYTHON ?? (process.platform === 'win32' ? 'py' : 'python3');
const pythonArgs = process.platform === 'win32' && python === 'py' ? ['-3'] : [];
const packager = path.join(__dirname, '../docker/package-remnacust-core.py');
const outputs = ['Dockerfile', 'remnacust-core.tar.gz', 'remnacust-core.tar.gz.sha256'];

async function put(root, name, value) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
}

async function fixture(t, layout = 'combined') {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remnacust-source-packaging-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'source');
    const node = layout === 'combined' ? path.join(workspace, 'node') : path.join(workspace, 'Remnacust-node/node');
    const core = layout === 'combined' ? workspace : path.join(workspace, 'Remnacust-core');
    await put(node, 'docker/package-remnacust-core.py', await fs.readFile(packager));
    await put(node, 'docker/Dockerfile', 'ARG XRAY_CORE_VERSION=v1.0.0\nARG XRAY_CORE_COMMIT=' + 'b'.repeat(40) + '\nARG XRAY_CORE_VERSION=v1.0.0\nARG XRAY_DEFAULT_COMMIT=' + 'b'.repeat(40) + '\nARG XRAY_DEFAULT_SOURCE_SHA256=' + 'd'.repeat(64) + '\n');
    const files = {
        'xray/core/core.go': 'package core\n',
        'xray/go.mod': 'module example.com/core\n\nreplace github.com/openlibrecommunity/olcrtc => ../vendor/olcrtc\nreplace github.com/refraction-networking/utls => ../vendor/utls\n',
        'xray/go.sum': '',
        'xray/REMNACUST-UPSTREAM.json': JSON.stringify({ version: '1.1.14', upstreamVersion: 'v26.10.31', upstreamCommit: 'a'.repeat(40), upstreamSourceZipSha256: 'c'.repeat(64) }),
        'vendor/olcrtc/go.mod': 'module github.com/openlibrecommunity/olcrtc\n',
        'vendor/olcrtc/go.sum': '',
        'vendor/olcrtc/LICENSE': 'fixture license\n',
        'vendor/olcrtc/pkg/olcrtc/tunnel/tunnel.go': 'package tunnel\n',
        'vendor/olcrtc/internal/names/data/fixture.bin': 'embedded names fixture',
        'vendor/utls/go.mod': 'module github.com/refraction-networking/utls\n',
        'vendor/utls/go.sum': '',
        'vendor/utls/LICENSE': 'fixture license\n',
        'vendor/utls/u_handshake_client.go': 'package tls\n',
        'vendor/utls/REMNACUST-PATCH.json': '{"fixture":"certificate-backport"}\n',
        'vendor/utls/certificate-decompression.patch': 'fixture patch\n',
        'upstream-security/go.mod': 'module github.com/xtls/xray-core\n',
        'upstream-security/go.sum': 'reviewed security sums\n',
    };
    files['upstream-security/manifest.json'] = JSON.stringify({
        schemaVersion: 1, policy: 'official-baseline-with-security-dependency-updates',
        upstreamVersion: 'v26.10.31', upstreamCommit: 'a'.repeat(40), sourceArchiveSha256: 'c'.repeat(64),
        configurationSourceSha256: '1'.repeat(64),
        originalGoModSha256: 'e'.repeat(64), originalGoSumSha256: 'f'.repeat(64),
        goModSha256: createHash('sha256').update(files['upstream-security/go.mod']).digest('hex'),
        goSumSha256: createHash('sha256').update(files['upstream-security/go.sum']).digest('hex'),
    }, null, 2) + '\n';
    for (const [name, value] of Object.entries(files)) await put(core, name, value);
    const docker = path.join(node, 'docker');
    const run = coreSource => execute(python, [...pythonArgs, path.join(docker, 'package-remnacust-core.py'), ...(coreSource ? ['--core-source', coreSource] : [])], { timeout: 15000 });
    const snapshot = () => Promise.all(outputs.map(name => fs.readFile(path.join(docker, name))));
    return { root, node, core, docker, run, snapshot };
}

const inspectArchive = `
import hashlib, json, pathlib, sys, tarfile
archive = pathlib.Path(sys.argv[1])
assert hashlib.sha256(archive.read_bytes()).hexdigest() == archive.with_name(archive.name + '.sha256').read_text().split()[0]
with tarfile.open(archive) as source:
    names = source.getnames()
    lock = json.load(source.extractfile('core-source-lock.json'))
    assert lock['version'] == '1.1.14'
    assert set(names) == set(lock['files']) | {'core-source-lock.json', 'core-source.sha256'}
    for name, digest in lock['files'].items():
        assert hashlib.sha256(source.extractfile(name).read()).hexdigest() == digest, name
    module = source.extractfile('Xray-core-main/go.mod').read().decode()
    for name, module_name in [('.tmp-utls', 'github.com/refraction-networking/utls'), ('.tmp-olcrtc', 'github.com/openlibrecommunity/olcrtc')]:
        assert '=> ../' + name in module
        assert source.extractfile(name + '/go.mod').read().decode().startswith('module ' + module_name)
    assert '../vendor/' not in module
    assert '.tmp-utls/REMNACUST-PATCH.json' in names
    assert '.tmp-utls/certificate-decompression.patch' in names
    assert '.tmp-olcrtc/internal/names/data/fixture.bin' in names
    security = json.load(source.extractfile('upstream-security/manifest.json'))
    for name, field in [('go.mod', 'goModSha256'), ('go.sum', 'goSumSha256')]:
        assert hashlib.sha256(source.extractfile('upstream-security/' + name).read()).hexdigest() == security[field]
    assert source.extractfile('upstream-security/original-modules.sha256').read().decode() == security['originalGoModSha256'] + '  go.mod\\n' + security['originalGoSumSha256'] + '  go.sum\\n'
    assert source.extractfile('upstream-security/overrides.sha256').read().decode() == security['goModSha256'] + '  go.mod\\n' + security['goSumSha256'] + '  go.sum\\n'
print('verified archive layout and all hashes')
`;

test('the actual packager preserves vendored replacements and integrity in combined and sibling layouts', async t => {
    for (const layout of ['combined', 'sibling']) {
        await t.test(layout, async t => {
            const f = await fixture(t, layout);
            await f.run();
            const first = await f.snapshot();
            await execute(python, [...pythonArgs, '-c', inspectArchive, path.join(f.docker, outputs[1])], { timeout: 15000 });
            await f.run();
            assert.deepEqual(await f.snapshot(), first);
            assert.match(first[0].toString(), /ARG XRAY_CORE_VERSION=v26\.10\.31/);
            assert.ok(first[0].toString().includes('ARG XRAY_DEFAULT_COMMIT=' + 'a'.repeat(40)));
            assert.ok(first[0].toString().includes('ARG XRAY_DEFAULT_SOURCE_SHA256=' + 'c'.repeat(64)));
            assert.equal(createHash('sha256').update(first[1]).digest('hex'), first[2].toString().split(' ')[0]);
        });
    }
});

test('missing or malformed upstream source checksum cannot replace packaged outputs', async t => {
    const f = await fixture(t);
    await f.run();
    const previous = await f.snapshot();
    const metadata = path.join(f.core, 'xray/REMNACUST-UPSTREAM.json');
    const source = JSON.parse(await fs.readFile(metadata, 'utf8'));
    for (const value of [undefined, '', 'a'.repeat(63), '../source.zip']) {
        await fs.writeFile(metadata, JSON.stringify({ ...source, upstreamSourceZipSha256: value }));
        await assert.rejects(f.run(), /Missing verified upstream source archive checksum/);
        assert.deepEqual(await f.snapshot(), previous);
    }
});

test('incomplete combined source fails before replacing existing outputs', async t => {
    for (const missing of ['vendor/utls', 'vendor/utls/go.mod', 'vendor/utls/u_handshake_client.go', 'vendor/olcrtc', 'upstream-security', 'upstream-security/go.sum']) {
        await t.test(missing, async t => {
            const f = await fixture(t);
            await f.run();
            const previous = await f.snapshot();
            await fs.rm(path.join(f.core, missing), { recursive: true, force: true });
            await assert.rejects(f.run(), error => {
                assert.match(error.stderr, /Incomplete Core source input/);
                assert.ok(error.stderr.includes(missing));
                assert.match(error.stderr, /outputs were not changed/);
                return true;
            });
            assert.deepEqual(await f.snapshot(), previous);
        });
    }
});

test('tampered security locks or a different official baseline cannot replace packaged outputs', async t => {
    const f = await fixture(t);
    await f.run();
    const previous = await f.snapshot();
    for (const name of ['go.mod', 'go.sum']) {
        const filename = path.join(f.core, 'upstream-security', name);
        const original = await fs.readFile(filename);
        await fs.appendFile(filename, '\n');
        await assert.rejects(f.run(), /security dependency lock SHA256 mismatch/);
        assert.deepEqual(await f.snapshot(), previous);
        await fs.writeFile(filename, original);
    }
    const filename = path.join(f.core, 'upstream-security/manifest.json');
    const manifest = JSON.parse(await fs.readFile(filename));
    for (const change of [{ upstreamCommit: '0'.repeat(40) }, { sourceArchiveSha256: '0'.repeat(64) }, { policy: 'pristine' }]) {
        await fs.writeFile(filename, JSON.stringify({ ...manifest, ...change }));
        await assert.rejects(f.run(), /security dependency baseline does not match/);
        assert.deepEqual(await f.snapshot(), previous);
    }
});

test('missing uTLS in a fresh combined bundle cannot create an archive or checksum', async t => {
    const f = await fixture(t);
    await fs.rm(path.join(f.core, 'vendor/utls'), { recursive: true });
    const recipe = await fs.readFile(path.join(f.docker, 'Dockerfile'));
    await assert.rejects(f.run(), /vendor\/utls\/go.mod/);
    assert.deepEqual(await fs.readFile(path.join(f.docker, 'Dockerfile')), recipe);
    for (const name of outputs.slice(1)) await assert.rejects(fs.access(path.join(f.docker, name)), { code: 'ENOENT' });
});


test('an explicit detached Core checkout is honored and invalid overrides cannot fall back or replace outputs', async t => {
    const f = await fixture(t, 'sibling');
    const detached = path.join(f.root, 'detached-core');
    await fs.rename(f.core, detached);
    await f.run(detached);
    const previous = await f.snapshot();
    await execute(python, [...pythonArgs, '-c', inspectArchive, path.join(f.docker, outputs[1])], { timeout: 15000 });
    await assert.rejects(f.run(path.join(f.root, 'missing-core')), /Clone Remnacust-core/);
    assert.deepEqual(await f.snapshot(), previous);
});

test('the actual Docker verification rejects changed original builders or module locks before copying overrides', async t => {
    const shell = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe') : '/bin/sh';
    const recipe = await fs.readFile(path.join(__dirname, '../docker/Dockerfile'), 'utf8');
    const stage = recipe.split(' AS xray-default-build')[1].split('\nFROM ')[0];
    const command = stage.match(/^RUN export LC_ALL=C[\s\S]*?(?=\n\s*\n)/m)?.[0];
    assert(command);
    const verification = command.replace(/^RUN /, '').replace(/\\\r?\n/g, ' ')
        .split('&& go mod verify')[0].replaceAll('/tmp/upstream-security', '../security').trim();
    assert(verification.includes('cp ../security/go.mod ../security/go.sum .'));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remnacust-default-source-verification-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    const originals = {
        'go.mod': 'module example.org/official-fixture\n',
        'go.sum': 'original module checksum fixture\n',
        'infra/conf/a.go': 'package conf\nvar A = 1\n',
        'infra/conf/z.go': 'package conf\nvar Z = 2\n',
        'infra/conf/a_test.go': 'excluded test fixture\n',
    };
    const overrides = { 'go.mod': 'reviewed security module fixture\n', 'go.sum': 'reviewed security checksum fixture\n' };
    const sha = value => createHash('sha256').update(value).digest('hex');
    const builders = createHash('sha256');
    for (const name of ['a.go', 'z.go']) builders.update(name + '\0' + originals['infra/conf/' + name]);
    const manifest = {
        upstreamCommit: 'a'.repeat(40), configurationSourceSha256: builders.digest('hex'),
        originalGoModSha256: sha(originals['go.mod']), originalGoSumSha256: sha(originals['go.sum']),
        goModSha256: sha(overrides['go.mod']), goSumSha256: sha(overrides['go.sum']),
    };
    const reset = async () => {
        for (const [name, value] of Object.entries(originals)) await put(source, name, value);
        for (const [name, value] of Object.entries(overrides)) await put(root, 'security/' + name, value);
        await put(root, 'security/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
        await put(root, 'security/original-modules.sha256', manifest.originalGoModSha256 + '  go.mod\n' + manifest.originalGoSumSha256 + '  go.sum\n');
        await put(root, 'security/overrides.sha256', manifest.goModSha256 + '  go.mod\n' + manifest.goSumSha256 + '  go.sum\n');
    };
    const run = () => execute(shell, ['-c', verification], { cwd: source, timeout: 15000,
        env: { ...process.env, XRAY_DEFAULT_COMMIT: manifest.upstreamCommit } });
    await reset();
    await run();
    for (const [name, value] of Object.entries(overrides))
        assert.equal(await fs.readFile(path.join(source, name), 'utf8'), value);
    for (const name of ['source/infra/conf/a.go', 'source/go.mod', 'source/go.sum', 'security/go.mod', 'security/go.sum']) {
        await reset();
        await fs.appendFile(path.join(root, name), '\n');
        const before = await Promise.all(['go.mod', 'go.sum'].map(name => fs.readFile(path.join(source, name))));
        await assert.rejects(run());
        assert.deepEqual(await Promise.all(['go.mod', 'go.sum'].map(name => fs.readFile(path.join(source, name)))), before);
    }
});
