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
    await put(node, 'docker/Dockerfile', 'ARG XRAY_CORE_VERSION=v1.0.0\nARG XRAY_CORE_COMMIT=' + 'b'.repeat(40) + '\nARG XRAY_CORE_VERSION=v1.0.0\n');
    const files = {
        'xray/core/core.go': 'package core\n',
        'xray/go.mod': 'module example.com/core\n\nreplace github.com/openlibrecommunity/olcrtc => ../vendor/olcrtc\nreplace github.com/refraction-networking/utls => ../vendor/utls\n',
        'xray/go.sum': '',
        'xray/REMNACUST-UPSTREAM.json': JSON.stringify({ version: '1.1.14', upstreamVersion: 'v26.10.31', upstreamCommit: 'a'.repeat(40) }),
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
    };
    for (const [name, value] of Object.entries(files)) await put(core, name, value);
    const docker = path.join(node, 'docker');
    const run = () => execute(python, [...pythonArgs, path.join(docker, 'package-remnacust-core.py')], { timeout: 15000 });
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
            assert.equal(createHash('sha256').update(first[1]).digest('hex'), first[2].toString().split(' ')[0]);
        });
    }
});

test('incomplete combined source fails before replacing existing outputs', async t => {
    for (const missing of ['vendor/utls', 'vendor/utls/go.mod', 'vendor/utls/u_handshake_client.go', 'vendor/olcrtc']) {
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

test('missing uTLS in a fresh combined bundle cannot create an archive or checksum', async t => {
    const f = await fixture(t);
    await fs.rm(path.join(f.core, 'vendor/utls'), { recursive: true });
    const recipe = await fs.readFile(path.join(f.docker, 'Dockerfile'));
    await assert.rejects(f.run(), /vendor\/utls\/go.mod/);
    assert.deepEqual(await fs.readFile(path.join(f.docker, 'Dockerfile')), recipe);
    for (const name of outputs.slice(1)) await assert.rejects(fs.access(path.join(f.docker, name)), { code: 'ENOENT' });
});
