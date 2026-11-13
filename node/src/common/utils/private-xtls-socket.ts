import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';

function requirePrivateSocket(socketPath: string, filename: 'api.sock' | 'internal.sock'): void {
    if (
        !/^\/run\/remnacust-xray-[a-zA-Z0-9]{10}\/(api|internal)\.sock$/.test(socketPath) ||
        !socketPath.endsWith('/' + filename)
    ) {
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

export function isPrivateXtlsSocketAvailable(socketPath: string): boolean {
    requirePrivateSocket(socketPath, 'api.sock');
    try {
        const socket = lstatSync(socketPath);
        return (
            socket.isSocket() && socket.uid === process.getuid?.() && (socket.mode & 0o077) === 0
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

export const PRIVATE_XTLS_RECONNECT_OPTIONS = Object.freeze({
    'grpc.initial_reconnect_backoff_ms': 100,
    'grpc.max_reconnect_backoff_ms': 1000,
});
