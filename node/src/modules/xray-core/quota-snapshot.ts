import type { RecoveryFenceState } from './quota-recovery-fence';

import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { z } from 'zod';

import { QuotaJournalStatus } from './quota-ledger';

export const QUOTA_SNAPSHOT_VERSION = 'remnacust-quota-snapshots-v1';
export const QUOTA_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
export const quotaSnapshotRequest = z.strictObject({ generation: z.uuid(), requestId: z.uuid() });
const compress = promisify(gzip);

export async function encodeQuotaSnapshot(
    request: z.infer<typeof quotaSnapshotRequest>,
    journal: QuotaJournalStatus,
    policyRevision: string,
    coreProcessId: string,
    recovery?: RecoveryFenceState | null,
) {
    const payload = Buffer.from(
        JSON.stringify({
            version: QUOTA_SNAPSHOT_VERSION,
            ...request,
            instance: journal.instance,
            sequence: journal.sequence,
            checkpoint: journal.checkpoint,
            retiredBefore: journal.retiredBefore,
            registrationsRequired: journal.registrationsRequired,
            watermarksRequired: journal.watermarksRequired,
            policyRevision,
            coreProcessId,
            ...(recovery ? { recovery } : {}),
            capturedAt: Date.now(),
            entries: [...journal.entries.keys()]
                .sort()
                .map((id) => ({ id, ...journal.entries.get(id)! })),
        }),
    );
    if (payload.length > QUOTA_SNAPSHOT_MAX_BYTES)
        throw new Error('Quota snapshot capacity exceeded');
    const compressed = await compress(payload, { level: 1 });
    return {
        version: QUOTA_SNAPSHOT_VERSION,
        encoding: 'gzip-base64' as const,
        bytes: payload.length,
        sha256: createHash('sha256').update(payload).digest('hex'),
        data: compressed.toString('base64'),
    };
}
