import { createHash } from 'node:crypto';
import { z } from 'zod';

import { recoveryFenceRequest, recoveryFenceSchema } from './quota-recovery-fence';
import { readPersistedUsageJournal } from './usage-journal';
import { frameDigest, usageReceiptRequest } from './usage-receipt';

export const RECOVERY_USAGE_ACK = 'remnacust-recovery-usage-ack-v1';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const recoveryUsageAckRequest = recoveryFenceRequest
    .extend({
        instance: recoveryFenceRequest.shape.instance.unwrap(),
        previous: digest,
        decisionDigest: digest,
        sourceDigest: digest,
        receipt: usageReceiptRequest.options[1],
    })
    .refine((value) => value.receipt.stream === value.instance);
export type RecoveryUsageAckRequest = z.infer<typeof recoveryUsageAckRequest>;
export function recoveryAckJournal(original: Buffer, request: RecoveryUsageAckRequest) {
    const state = readPersistedUsageJournal(original);
    if (state.stream !== request.instance) throw new Error('Recovery receipt journal changed');
    const alreadyAcknowledged =
        state.acked === request.receipt.sequence && state.ackDigest === request.receipt.digest;
    if (
        !alreadyAcknowledged &&
        (!state.pending ||
            createHash('sha256').update(original).digest('hex') !== request.sourceDigest ||
            state.pending.sequence !== request.receipt.sequence ||
            state.pending.coreProcessId !== request.receipt.coreProcessId ||
            frameDigest(state.pending) !== request.receipt.digest)
    )
        throw new Error('Recovery receipt source changed');
    return {
        alreadyAcknowledged,
        journal: {
            stream: state.stream,
            acked: state.acked,
            ackDigest: state.ackDigest,
            digest: createHash('sha256').update(original).digest('hex'),
            pending: state.pending
                ? {
                      sequence: state.pending.sequence,
                      coreProcessId: state.pending.coreProcessId,
                      digest: frameDigest(state.pending),
                  }
                : null,
        },
    };
}
export const recoveryUsageAckReply = z.strictObject({
    version: z.literal(RECOVERY_USAGE_ACK),
    requestId: recoveryFenceRequest.shape.requestId,
    generation: recoveryFenceRequest.shape.generation,
    coreProcessId: recoveryFenceRequest.shape.coreProcessId,
    instance: recoveryFenceRequest.shape.instance.unwrap(),
    previous: digest,
    decisionDigest: digest,
    sourceDigest: digest,
    alreadyAcknowledged: z.boolean(),
    acknowledgement: z.strictObject({
        stream: recoveryFenceRequest.shape.instance.unwrap(),
        sequence: usageReceiptRequest.options[1].shape.sequence,
        acknowledged: z.literal(true),
    }),
    journal: z.strictObject({
        stream: recoveryFenceRequest.shape.instance.unwrap(),
        acked: usageReceiptRequest.options[1].shape.sequence,
        ackDigest: digest,
        digest,
        pending: z
            .strictObject({
                sequence: usageReceiptRequest.options[1].shape.sequence,
                coreProcessId: recoveryFenceRequest.shape.coreProcessId,
                digest,
            })
            .nullable(),
    }),
    recovery: recoveryFenceSchema,
});
