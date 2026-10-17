import type { IXrayProcessStatus } from './xray-process.service';

import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

export const CORE_INCARNATION = 'remnacust-core-incarnation-v1';
const STATUS_FILE = '/var/lib/remnanode/host-policy.status.json';
const LIMIT = 64 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export async function readCoreIncarnation(
    status: Pick<IXrayProcessStatus, 'up' | 'pid'>,
    file = STATUS_FILE,
): Promise<string | null> {
    if (!status.up || !Number.isSafeInteger(status.pid) || !status.pid || status.pid < 1)
        return null;
    try {
        const before = await lstat(file);
        if (!before.isFile() || before.isSymbolicLink() || before.size > LIMIT) return null;
        const handle = await open(
            file,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        );
        try {
            const details = await handle.stat();
            if (
                !details.isFile() ||
                details.size > LIMIT ||
                details.dev !== before.dev ||
                details.ino !== before.ino
            )
                return null;
            const buffer = Buffer.alloc(Math.min(details.size + 1, LIMIT + 1));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > LIMIT) return null;
            const value: unknown = JSON.parse(buffer.toString('utf8', 0, bytesRead));
            if (!value || typeof value !== 'object') return null;
            const document = value as Record<string, unknown>;
            return document.pid === status.pid &&
                document.coreIncarnation === CORE_INCARNATION &&
                typeof document.coreProcessId === 'string' &&
                uuid.test(document.coreProcessId)
                ? document.coreProcessId
                : null;
        } finally {
            await handle.close();
        }
    } catch {
        // A legacy, starting, stopped, or damaged core cannot prove continuity.
        // The caller still records returned traffic but cannot bootstrap credit.
        return null;
    }
}
