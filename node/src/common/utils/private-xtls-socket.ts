import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';

export function privateXtlsConnectionUrl(socketPath: string): string {
    if (!/^\/run\/remnacust-xray-[a-zA-Z0-9]{10}\/api\.sock$/.test(socketPath)) {
        throw new Error('Xray API requires a private filesystem socket');
    }
    const directory = lstatSync(dirname(socketPath));
    if (
        !directory.isDirectory() ||
        (directory.mode & 0o077) !== 0 ||
        directory.uid !== process.getuid?.()
    ) {
        throw new Error('Xray API directory must be owned by the service user and private');
    }
    return `unix://${socketPath}`;
}
