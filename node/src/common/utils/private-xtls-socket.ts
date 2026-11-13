import { lstatSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
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

export async function removeStalePrivateXtlsSocket(
    socketPath: string,
    stopped: () => Promise<boolean>,
): Promise<void> {
    requirePrivateSocket(socketPath, 'api.sock');
    let before;
    try {
        before = lstatSync(socketPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    if (!before.isSocket() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0)
        throw new Error('Refusing to remove an unsafe Xray API socket');
    if (!(await stopped())) throw new Error('Cannot verify that the Xray process is stopped');
    await new Promise<void>((resolve, reject) => {
        const connection = createConnection({ path: socketPath });
        connection.once('connect', () => {
            connection.destroy();
            reject(new Error('Refusing to remove an active Xray API socket'));
        });
        connection.once('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve();
            else reject(error);
        });
        connection.setTimeout(500, () =>
            connection.destroy(new Error('Xray API socket probe timed out')),
        );
    });
    if (!(await stopped())) throw new Error('Xray process changed during socket cleanup');
    let after;
    try {
        after = lstatSync(socketPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        !after.isSocket() ||
        after.uid !== before.uid ||
        after.mode !== before.mode
    )
        throw new Error('Xray API socket changed during cleanup');
    unlinkSync(socketPath);
}

export const PRIVATE_XTLS_RECONNECT_OPTIONS = Object.freeze({
    'grpc.initial_reconnect_backoff_ms': 100,
    'grpc.max_reconnect_backoff_ms': 1000,
});
