import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';

function requirePrivateSocket(socketPath: string, filename: 'api.sock' | 'internal.sock'): void {
    if (!/^\/run\/remnacust-xray-[a-zA-Z0-9]{10}\/(api|internal)\.sock$/.test(socketPath) ||
        !socketPath.endsWith('/' + filename)) {
        throw new Error('Node control requires a private filesystem socket');
    }
    const directory = lstatSync(dirname(socketPath));
    if (
        !directory.isDirectory() ||
        (directory.mode & 0o077) !== 0 ||
        directory.uid !== process.getuid?.()
    ) {
        throw new Error('Xray API directory must be owned by the service user and private');
    }
}

export function privateInternalSocketPath(socketPath: string): string {
    requirePrivateSocket(socketPath, 'internal.sock');
    return socketPath;
}

export function privateXtlsConnectionUrl(socketPath: string): string {
    requirePrivateSocket(socketPath, 'api.sock');
    return `unix://${socketPath}`;
}
