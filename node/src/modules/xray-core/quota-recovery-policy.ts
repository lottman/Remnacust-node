import type { RecoveryFence } from './quota-recovery-fence';

import { z } from 'zod';

import { QUOTA_RESERVE_VERSION } from './quota-ledger';
import { USER_QUOTA_VERSION } from './user-quota';

type HoldPolicy = {
    userQuota?: string;
    offlineReserves?: string;
    legacyGroups?: string[];
    registrations?: unknown[];
    groups: Record<
        string,
        { fenceAll?: boolean; blockAll: boolean; reserves?: Record<string, unknown> }
    >;
    hosts: Record<string, { groups: string[]; userQuotaExempt?: boolean }>;
};
export type RecoveryPolicyGate = { generation: string; previous: string };
export const RECOVERY_POLICY_PROOF_HEADER = 'x-remnacust-recovery-proof';
const proofUuid = z
    .uuid()
    .refine(
        (value) =>
            value === value.toLowerCase() && value !== '00000000-0000-0000-0000-000000000000',
    );
const transportProof = z.strictObject({
    generation: proofUuid,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    coreProcessId: proofUuid,
    instance: proofUuid,
});
export type RecoveryPolicyTransportProof = z.infer<typeof transportProof>;
export function parseRecoveryPolicyProof(value: unknown): RecoveryPolicyTransportProof | null {
    if (value === undefined) return null;
    if (typeof value !== 'string' || value.length > 256)
        throw new Error('Invalid recovery policy proof');
    const parts = value.split(':');
    if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('Invalid recovery policy proof');
    return transportProof.parse({
        generation: parts[1],
        digest: parts[2],
        coreProcessId: parts[3],
        instance: parts[4],
    });
}

// Validate this after the ordinary policy schema: the global recovery gate
// stays closed while the underlying admission groups are replaced.
export function recoveryPolicyHoldsAdmissions(policy: HoldPolicy) {
    const groups = Object.values(policy.groups);
    return (
        policy.userQuota === USER_QUOTA_VERSION &&
        policy.offlineReserves === QUOTA_RESERVE_VERSION &&
        !!policy.legacyGroups?.length &&
        !policy.registrations?.length &&
        groups.length > 0 &&
        groups.every(
            (group) => group.fenceAll === true && !Object.keys(group.reserves ?? {}).length,
        ) &&
        policy.legacyGroups.every((key) => policy.groups[key]?.fenceAll === true) &&
        Object.values(policy.hosts).every(
            (host) =>
                host.userQuotaExempt === true ||
                host.groups.some((key) => policy.groups[key]?.fenceAll === true),
        )
    );
}

export function heldRecoveryPolicy<T extends HoldPolicy & { revision?: string }>(
    policy: T,
    revision: string,
): T {
    // Identity maps can be large. Copy only the groups that staging changes.
    const next = { ...policy, groups: { ...policy.groups } };
    next.revision = revision;
    if (next.registrations) next.registrations = [];
    for (const [key, current] of Object.entries(next.groups)) {
        const group = { ...current, fenceAll: true };
        if (group.reserves) group.reserves = {};
        next.groups[key] = group;
    }
    if (!recoveryPolicyHoldsAdmissions(next))
        throw new Error('Policy cannot hold all managed identities');
    return next;
}

export function requireRecoveryPolicyGate(
    record: RecoveryFence | null,
    stage?: RecoveryPolicyGate,
    proof?: RecoveryPolicyTransportProof | null,
) {
    if (stage) {
        if (proof) throw new Error('Recovery staging cannot use an ordinary proof');
        if (
            record?.state !== 'FENCED' ||
            record.generation !== stage.generation ||
            record.digest !== stage.previous
        )
            throw new Error('Recovery policy source changed');
    } else if (record?.state === 'FENCED') {
        throw new Error('Recovery is paused');
    } else if (record?.state === 'RELEASED') {
        if (!proof || proof.generation !== record.generation || proof.digest !== record.digest)
            throw new Error('Recovery policy proof changed');
    } else if (proof) {
        throw new Error('Recovery policy proof has no matching recovery');
    }
}
