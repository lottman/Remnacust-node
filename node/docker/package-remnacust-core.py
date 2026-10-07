"""Create the deterministic, verified source input used by the node image."""
import gzip, hashlib, io, json, pathlib, tarfile

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
lock = {
    'upstreamVersion': 'v26.9.30',
    'upstreamCommit': 'b26a91de4f3294e26a0ad0a970b81a386a41f789',
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
print(f'{len(lock["files"])} source files, {archive.stat().st_size} bytes')
