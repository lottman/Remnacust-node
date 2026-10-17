import { join } from 'node:path';
import { z } from 'zod';

import {
    privateRead,
    publishPrivateRecord,
    readRecoveryFence,
    recoveryFenceRequest,
    recoveryFenceSchema,
    recoveryFenceDigest,
    type RecoveryFence,
} from './quota-recovery-fence';
import { recoveryPolicyHoldsAdmissions } from './quota-recovery-policy';
import { recoveryQuiescenceSchema } from './recovery-quiescence';
import { usageJournalHead } from './usage-journal';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const recoveryReleaseRequest = recoveryFenceRequest.extend({
    previous: digest,
    instance: recoveryFenceRequest.shape.instance.unwrap(),
    policyRevision: z
        .string()
        .regex(/^[1-9][0-9]{0,18}$/)
        .refine((value) => BigInt(value) <= 9223372036854775807n),
    policyGeneration: recoveryFenceRequest.shape.generation,
    witnessDigest: digest,
    journalDigest: digest,
});
export type RecoveryReleaseRequest = z.infer<typeof recoveryReleaseRequest>;
export type RecoveryReleaseObservation = {
    pid: number;
    coreProcessId: string;
    instance: string;
    applied: boolean;
    userQuotaRequired: boolean;
    fence: RecoveryFence;
    policy: Parameters<typeof recoveryPolicyHoldsAdmissions>[0] & { revision: string };
    policyGeneration: string;
    witness: unknown;
    journal: Buffer;
};

// The caller supplies a live native acknowledgement, stored schema-validated
// policy, original journal and private witness under coreManagement. A cached
// status or a panel-submitted observation is not a valid implementation.
export function planRecoveryRelease(
    input: RecoveryReleaseRequest,
    observation: RecoveryReleaseObservation,
) {
    const request = recoveryReleaseRequest.parse(input);
    const fence = recoveryFenceSchema.parse(observation.fence);
    const witness = recoveryQuiescenceSchema.parse(observation.witness);
    const head = usageJournalHead(observation.journal);
    if (
        !Number.isSafeInteger(observation.pid) ||
        observation.pid < 1 ||
        !observation.applied ||
        !observation.userQuotaRequired ||
        observation.coreProcessId !== request.coreProcessId ||
        observation.instance !== request.instance ||
        observation.policyGeneration !== request.policyGeneration ||
        observation.policy.revision !== request.policyRevision ||
        !recoveryPolicyHoldsAdmissions(observation.policy) ||
        witness.digest !== request.witnessDigest ||
        witness.request.generation !== request.generation ||
        witness.request.coreProcessId !== request.coreProcessId ||
        witness.request.instance !== request.instance ||
        witness.fence.digest !== request.previous ||
        head.stream !== request.instance ||
        head.pending !== null ||
        head.acked !== witness.frame.sequence ||
        head.ackDigest !== witness.frame.digest ||
        head.digest !== request.journalDigest
    )
        throw new Error('Recovery release source changed');
    if (fence.state === 'RELEASED') {
        if (
            fence.token !== request.requestId ||
            fence.generation !== request.generation ||
            fence.previous !== request.previous ||
            fence.sequence !== (BigInt(witness.fence.sequence) + 1n).toString()
        )
            throw new Error('Recovery release identity conflicts');
        return fence;
    }
    if (fence.generation !== request.generation || fence.digest !== request.previous)
        throw new Error('Recovery release fence changed');
    const value = {
        version: fence.version,
        generation: request.generation,
        token: request.requestId,
        state: 'RELEASED' as const,
        sequence: (BigInt(fence.sequence) + 1n).toString(),
        previous: fence.digest,
    };
    return recoveryFenceSchema.parse({ ...value, digest: recoveryFenceDigest(value) });
}

const intentSchema = z
    .strictObject({
        version: z.literal('remnacust-recovery-release-intent-v1'),
        request: recoveryReleaseRequest,
        record: recoveryFenceSchema,
    })
    .refine(
        (value) =>
            value.record.state === 'RELEASED' &&
            value.record.token === value.request.requestId &&
            value.record.generation === value.request.generation &&
            value.record.previous === value.request.previous,
    );

// This is a private durable write primitive, not a public release endpoint.
// Financial authorization must commit in Panel before its future delivery.
// A release leaves the underlying held policy in force and grants no credit.
export async function persistRecoveryRelease(
    input: RecoveryReleaseRequest,
    observe: () => Promise<RecoveryReleaseObservation>,
    directory = '/var/lib/remnanode/quota',
) {
    const request = recoveryReleaseRequest.parse(input);
    const file = join(directory, 'recovery.json');
    const intentFile = join(directory, 'release-' + request.requestId + '.json');
    const first = await observe();
    const record = planRecoveryRelease(request, first);
    const intent = intentSchema.parse({
        version: 'remnacust-recovery-release-intent-v1',
        request,
        record,
    });
    const known = await privateRead(intentFile);
    if (known) {
        const saved = intentSchema.parse(JSON.parse(known.toString('utf8')));
        if (JSON.stringify(saved) !== JSON.stringify(intent))
            throw new Error('Recovery release intent conflicts');
    } else if (first.fence.state === 'RELEASED') {
        throw new Error('Missing durable recovery release intent');
    }
    const validate = async () => {
        const next = await observe();
        const current = await readRecoveryFence(file);
        if (
            next.pid !== first.pid ||
            current?.digest !== first.fence.digest ||
            next.fence.digest !== first.fence.digest ||
            planRecoveryRelease(request, next).digest !== record.digest
        )
            throw new Error('Recovery release changed before commit');
    };
    if (!known) {
        await publishPrivateRecord(intentFile, intent, async () => {
            await validate();
            if (await privateRead(intentFile)) throw new Error('Recovery release intent raced');
        });
    }
    // Retry after a lost response checks the same durable intent and live
    // bindings. It does not create a successor release or rewrite the journal.
    if (first.fence.state === 'RELEASED') {
        await validate();
        return record;
    }
    await publishPrivateRecord(file, record, validate);
    return record;
}
