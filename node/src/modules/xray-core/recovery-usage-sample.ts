import { createHash } from 'node:crypto';
import { z } from 'zod';

import { recoveryFenceRequest, recoveryFenceSchema } from './quota-recovery-fence';
import { readPersistedUsageJournal } from './usage-journal';
import {
    frameDigest,
    parseUsageReceiptResponse,
    sampleResponse,
    usageReceiptRequest,
    USAGE_RECEIPTS,
} from './usage-receipt';

export const RECOVERY_USAGE_SAMPLE = 'remnacust-recovery-usage-sample-v1';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const recoveryUsageSampleRequest = recoveryFenceRequest
    .extend({
        instance: recoveryFenceRequest.shape.instance.unwrap(),
        previous: digest,
        preparationDigest: digest,
        sourceDigest: digest,
        retainedDigest: digest.nullable(),
        prior: z.strictObject({ sequence: usageReceiptRequest.options[0].shape.sequence, digest }),
        receipt: usageReceiptRequest.options[0],
    })
    .refine(
        (value) =>
            value.receipt.stream === value.instance &&
            BigInt(value.receipt.sequence) === BigInt(value.prior.sequence) + 1n,
    );
export type RecoveryUsageSampleRequest = z.infer<typeof recoveryUsageSampleRequest>;

export function recoverySampleJournal(original: Buffer, request: RecoveryUsageSampleRequest) {
    const state = readPersistedUsageJournal(original);
    if (
        state.stream !== request.instance ||
        state.acked !== request.prior.sequence ||
        state.ackDigest !== request.prior.digest
    )
        throw Error('Recovery sample head changed');
    const journalDigest = createHash('sha256').update(original).digest('hex');
    if (!state.pending) {
        if (
            request.retainedDigest !== null ||
            journalDigest !== request.sourceDigest ||
            request.receipt.coreProcessId !== request.coreProcessId
        )
            throw Error('Recovery sample source or original core changed');
        return { frame: null, journalDigest };
    }
    const parsed = parseUsageReceiptResponse(request.receipt, {
        capability: USAGE_RECEIPTS,
        stream: state.stream,
        ...state.pending,
        digest: frameDigest(state.pending),
    });
    if (
        !('stats' in parsed) ||
        (request.retainedDigest !== null && parsed.digest !== request.retainedDigest)
    )
        throw Error('Retained recovery sample changed');
    return { frame: parsed, journalDigest };
}
export const recoveryUsageSampleReply = z.strictObject({
    version: z.literal(RECOVERY_USAGE_SAMPLE),
    requestId: recoveryFenceRequest.shape.requestId,
    generation: recoveryFenceRequest.shape.generation,
    coreProcessId: recoveryFenceRequest.shape.coreProcessId,
    instance: recoveryFenceRequest.shape.instance.unwrap(),
    previous: digest,
    preparationDigest: digest,
    sourceDigest: digest,
    retainedDigest: digest.nullable(),
    alreadyCaptured: z.boolean(),
    journalDigest: digest,
    frame: sampleResponse,
    recovery: recoveryFenceSchema,
});
