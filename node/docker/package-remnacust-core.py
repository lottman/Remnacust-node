"""Create the deterministic, verified source input used by the node image."""
import gzip, hashlib, io, json, pathlib, re, tarfile

node = pathlib.Path(__file__).resolve().parents[1]
workspace = node.parent
if not (workspace / "xray/core/core.go").is_file():
    workspace = workspace.parent / "Remnacust-core"
if not (workspace / "xray/core/core.go").is_file():
    raise SystemExit("Clone Remnacust-core next to Remnacust-node before repackaging the core")
docker = node / 'docker'
files = {}
for folder, source_folder in [('Xray-core-main', 'xray'), ('.tmp-olcrtc', 'vendor/olcrtc')]:
    for path in (workspace / source_folder).rglob('*'):
        relative = path.relative_to(workspace / source_folder)
        if not path.is_file() or any(p in {'.git', 'node_modules', 'vendor', '__pycache__'} for p in relative.parts):
            continue
        embedded_names = folder == '.tmp-olcrtc' and relative.parent.as_posix() == 'internal/names/data'
        if path.suffix not in {'.go', '.proto', '.mod', '.sum', '.md', '.txt', '.html', '.json', '.yaml', '.yml', '.s', '.dat', '.usa', '.crt', '.key'} and path.name != 'LICENSE' and not embedded_names:
            continue
        content = path.read_bytes()
        if path.suffix not in {'.dat', '.usa'}: content = content.replace(b'\r\n', b'\n')
        if folder == 'Xray-core-main' and relative.as_posix() == 'go.mod':
            content = content.replace(b'../vendor/olcrtc', b'../.tmp-olcrtc')
        files[f'{folder}/{relative.as_posix()}'] = content
source = json.loads((workspace / 'xray/REMNACUST-UPSTREAM.json').read_text(encoding='utf-8'))
if not re.fullmatch(r'v[0-9][A-Za-z0-9.+-]*', source['upstreamVersion']) or not re.fullmatch(r'[a-f0-9]{40}', source['upstreamCommit']):
    raise SystemExit('Invalid pinned upstream release metadata')
dockerfile = docker / 'Dockerfile'
recipe = dockerfile.read_text(encoding='utf-8')
recipe, versions = re.subn(r'(?m)^ARG XRAY_CORE_VERSION=\S+$', 'ARG XRAY_CORE_VERSION=' + source['upstreamVersion'], recipe)
recipe, commits = re.subn(r'(?m)^ARG XRAY_CORE_COMMIT=\S+$', 'ARG XRAY_CORE_COMMIT=' + source['upstreamCommit'], recipe)
if versions != 2 or commits != 1:
    raise SystemExit('Dockerfile upstream pin layout changed; update the source packager')
lock = {
    'version': source['version'],
    'upstreamVersion': source['upstreamVersion'],
    'upstreamCommit': source['upstreamCommit'],
    'upstreamPatchCommit': source.get('upstreamPatchCommit'),
    'files': {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())},
}
files['core-source-lock.json'] = (json.dumps(lock, indent=2) + '\n').encode()
files['core-source.sha256'] = ''.join(f'{digest}  {name}\n' for name, digest in lock['files'].items()).encode()
archive = docker / 'remnacust-core.tar.gz'
with archive.open('wb') as stream, gzip.GzipFile(fileobj=stream, mode='wb', mtime=0, filename='') as zipped, tarfile.open(fileobj=zipped, mode='w') as tar:
    for name, data in sorted(files.items()):
        member = tarfile.TarInfo(name)
        member.size, member.mode, member.mtime = len(data), 0o644, 0
        tar.addfile(member, io.BytesIO(data))
(docker / 'remnacust-core.tar.gz.sha256').write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + '  remnacust-core.tar.gz\n', encoding='utf-8', newline='\n')
dockerfile.write_text(recipe, encoding='utf-8', newline='\n')
print(f'{len(lock["files"])} source files, {archive.stat().st_size} bytes')
