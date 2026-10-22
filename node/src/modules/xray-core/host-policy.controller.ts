import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, open, rm } from 'node:fs/promises';
import { platform } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import {
    BadRequestException,
    ConflictException,
    Body,
    Controller,
    Get,
    Headers,
    Post,
    ServiceUnavailableException,
    UseGuards,
} from '@nestjs/common';

import { TypedConfigService } from '@common/config/app-config';
import { JwtDefaultGuard } from '@common/guards/jwt-guards';
import { normalizeDestinationRule, isIpDestinationRule } from '@common/utils/destination-rule';

import { CORE_INCARNATION, readCoreIncarnation } from './core-incarnation';
import { coreManagement } from './core-management';
import { LiveCoreService } from './live-core.service';
import {
    QUOTA_RESERVE_VERSION,
    QUOTA_REGISTRATION_VERSION,
    QUOTA_WATERMARK_VERSION,
    prepareQuotaLedger,
    verifyQuotaLedger,
    readQuotaJournal,
    readQuotaJournalSnapshot,
} from './quota-ledger';
import {
    QUOTA_RECOVERY_FENCE,
    QUOTA_RECOVERY_STATUS,
    readRecoveryFence,
    readRecoveryFenceState,
    recoveryFenceRequest,
    persistRecoveryFence,
    privateRead,
} from './quota-recovery-fence';
import {
    RECOVERY_POLICY_PROOF_HEADER,
    parseRecoveryPolicyProof,
    heldRecoveryPolicy,
    requireRecoveryPolicyGate,
    RecoveryPolicyGate,
} from './quota-recovery-policy';
import { encodeQuotaSnapshot, quotaSnapshotRequest } from './quota-snapshot';
import { RECOVERY_QUIESCENCE_FILE, recoveryQuiescenceSchema } from './recovery-quiescence';
import {
    persistRecoveryRelease,
    planRecoveryRelease,
    recoveryReleaseRequest,
    type RecoveryReleaseObservation,
} from './recovery-release';
import { readUsageArchiveFile } from './usage-archive';
import { USAGE_RECEIPTS } from './usage-receipt';
import {
    USER_QUOTA_VERSION,
    USER_QUOTA_SCALE,
    USER_QUOTA_MAX_FACTOR,
    userQuotaRequiredOnDisk,
} from './user-quota';
import { XrayProcessService } from './xray-process.service';

const VERSION = 'xera-host-policy-v2';
const DEVICE_SPEED_LIMITS = 'remnacust-device-speed-v1';
const DIRECTORY = '/var/lib/remnanode';
const FILE = `${DIRECTORY}/host-policy.json`;
const QUOTA_FENCES = 'remnacust-quota-fences-v1';
const UNRESERVED_USAGE = 'remnacust-unreserved-usage-v1';
function policyHasUnreservedUsage(value: unknown): boolean {
    const policy = value as {
        groups?: Record<string, { unreservedAccounts?: Record<string, string> } | null>;
    } | null;
    return Object.values(policy?.groups ?? {}).some(
        (group) => Object.keys(group?.unreservedAccounts ?? {}).length > 0,
    );
}
function policyHasQuotaFences(value: unknown): boolean {
    const policy = value as {
        groups?: Record<
            string,
            { fenceAll?: boolean; fencedOwners?: Record<string, boolean> } | null
        >;
    } | null;
    return Object.values(policy?.groups ?? {}).some(
        (group) =>
            group?.fenceAll === true || Object.values(group?.fencedOwners ?? {}).includes(true),
    );
}
const owner = z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .refine((value) => BigInt(value) <= 9223372036854775807n);
const usageAccount = z
    .string()
    .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const quotaStateRequest = z
    .object({
        ids: z.array(z.uuid()).max(1000).optional(),
        after: z.uuid().optional(),
        limit: z.int().min(1).max(1000).default(500),
    })
    .strict()
    .refine((value) => !(value.ids && value.after));
const reserve = z
    .object({
        id: z.uuid(),
        instance: z.uuid(),
        ceiling: z
            .string()
            .regex(/^(0|[1-9][0-9]{0,18})$/)
            .refine((value) => /^[0-9]+$/.test(value) && BigInt(value) <= 9223372036854775807n),
        expiresAt: z.int().positive().max(Number.MAX_SAFE_INTEGER),
        registrationRequired: z.boolean().optional(),
    })
    .strict();
const group = z
    .object({
        multiplierScale: z
            .union([z.literal(0), z.literal(100), z.literal(USER_QUOTA_SCALE)])
            .optional(),
        bytesPerSecond: z.int().min(0).max(1_250_000_000),
        deviceBytesPerSecond: z.int().min(0).max(1_250_000_000).optional(),
        totalBytesPerSecond: z.int().min(0).max(1_250_000_000),
        blockedOwners: z.record(owner, z.boolean()),
        blockAll: z.boolean(),
        reserveRequired: z.boolean().optional(),
        reserves: z.record(owner, reserve).optional(),
        unlimitedOwners: z.record(owner, z.boolean()).optional(),
        unreservedAccounts: z.record(owner, usageAccount).optional(),
        fenceAll: z.boolean().optional(),
        fencedOwners: z.record(owner, z.boolean()).optional(),
    })
    .strict();
export const hostPolicySchema = z
    .object({
        version: z.literal(VERSION),
        offlineReserves: z.literal(QUOTA_RESERVE_VERSION).optional(),
        quotaRegistrations: z.literal(QUOTA_REGISTRATION_VERSION).optional(),
        quotaCheckpoint: z
            .object({
                instance: z.uuid(),
                sequence: z
                    .string()
                    .regex(/^(0|[1-9][0-9]{0,15})$/)
                    .refine(
                        (value) =>
                            /^(0|[1-9][0-9]{0,15})$/.test(value) &&
                            BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
                    ),
            })
            .strict()
            .optional(),
        registrations: z
            .array(
                z
                    .object({
                        grant: reserve,
                        group: z.string().min(1).max(200),
                        owner,
                        scale: z
                            .union([z.literal(0), z.literal(100), z.literal(USER_QUOTA_SCALE)])
                            .optional(),
                        action: z.enum(['prepare', 'cancel']),
                        allowMissing: z.boolean().optional(),
                    })
                    .strict(),
            )
            .max(500)
            .optional(),
        userQuota: z.literal(USER_QUOTA_VERSION).optional(),
        legacyGroups: z.array(z.string().min(1).max(200)).min(1).max(200).optional(),
        legacyOwners: z
            .record(
                owner,
                z
                    .object({
                        allowed: z.boolean(),
                        expiresAt: z.int().nonnegative().max(253402300799999),
                    })
                    .strict(),
            )
            .optional(),
        legacyQuotaMultipliers: z
            .record(z.string().min(1).max(200), z.int().min(0).max(USER_QUOTA_MAX_FACTOR))
            .optional(),
        revision: z
            .string()
            .regex(/^[1-9][0-9]{0,18}$/)
            .refine((value) => /^[0-9]+$/.test(value) && BigInt(value) <= 9223372036854775807n)
            .optional(),
        protectedInbounds: z.array(z.string().min(1).max(255)).max(10000),
        hosts: z.record(
            z.string().regex(/^[a-f0-9]{32}$/),
            z
                .object({
                    inboundTag: z.string().min(1).max(255),
                    userQuotaExempt: z.boolean().optional(),
                    quotaMultipliers: z
                        .record(
                            z.string().min(1).max(200),
                            z.int().min(0).max(USER_QUOTA_MAX_FACTOR),
                        )
                        .optional(),
                    identityExpiresAt: z
                        .record(z.string(), z.int().nonnegative().max(Number.MAX_SAFE_INTEGER))
                        .optional(),
                    allowedIdentities: z.record(
                        z.string().regex(/^[1-9][0-9]{0,18}~[a-f0-9]{24}~h[a-f0-9]{32}$/),
                        z.boolean(),
                    ),
                    groups: z.array(z.string().min(1).max(200)).max(200),
                    domainMode: z.enum(['OFF', 'ALLOW_ONLY', 'DENY']),
                    domains: z
                        .array(
                            z
                                .string()
                                .min(1)
                                .max(253)
                                .refine((value) => {
                                    try {
                                        return normalizeDestinationRule(value) === value;
                                    } catch {
                                        return false;
                                    }
                                }),
                        )
                        .max(1000),
                })
                .strict(),
        ),
        groups: z.record(z.string().min(1).max(200), group),
    })
    .strict()
    .superRefine((policy, ctx) => {
        if (policy.quotaCheckpoint && !policy.quotaRegistrations)
            ctx.addIssue({
                code: 'custom',
                message: 'Journal checkpoint requires registered quota mode',
            });
        if (
            (policy.registrations || policy.quotaRegistrations) &&
            (!policy.quotaRegistrations || !policy.offlineReserves)
        )
            ctx.addIssue({ code: 'custom', message: 'Missing quota registration capability' });
        const registrationIds = new Set<string>();
        for (const item of policy.registrations ?? []) {
            if (
                !item.grant.registrationRequired ||
                registrationIds.has(item.grant.id) ||
                (item.allowMissing && item.action !== 'cancel')
            )
                ctx.addIssue({
                    code: 'custom',
                    message: 'Invalid or duplicate quota registration',
                });
            registrationIds.add(item.grant.id);
        }
        for (const group of Object.values(policy.groups))
            for (const grant of Object.values(group.reserves ?? {})) {
                if (
                    registrationIds.has(grant.id) ||
                    (grant.registrationRequired && !policy.quotaRegistrations)
                )
                    ctx.addIssue({
                        code: 'custom',
                        message: 'Active quota overlaps registration or lacks capability',
                    });
            }
        if (policy.offlineReserves && !policy.revision)
            ctx.addIssue({ code: 'custom', message: 'Missing monotonic policy revision' });
        let count = 0;
        const userQuotaFields =
            policy.userQuota ||
            policy.legacyGroups ||
            policy.legacyOwners ||
            policy.legacyQuotaMultipliers ||
            Object.values(policy.groups).some(
                (group) => group.multiplierScale === USER_QUOTA_SCALE,
            ) ||
            Object.values(policy.hosts).some((host) => host.userQuotaExempt);
        if (
            userQuotaFields &&
            (!policy.userQuota ||
                !policy.offlineReserves ||
                !policy.legacyGroups ||
                !policy.legacyOwners ||
                !policy.legacyQuotaMultipliers)
        )
            ctx.addIssue({ code: 'custom', message: 'Missing autonomous user quota bindings' });
        if (policy.legacyGroups) {
            if (
                new Set(policy.legacyGroups).size !== policy.legacyGroups.length ||
                policy.legacyGroups.some(
                    (key) =>
                        !policy.groups[key]?.reserveRequired ||
                        policy.groups[key]?.multiplierScale !== USER_QUOTA_SCALE ||
                        !Object.hasOwn(policy.legacyQuotaMultipliers ?? {}, key),
                )
            )
                ctx.addIssue({ code: 'custom', message: 'Invalid legacy user quota group' });
            count += policy.legacyGroups.length + Object.keys(policy.legacyOwners ?? {}).length;
        }
        for (const [id, host] of Object.entries(policy.hosts)) {
            if (
                policy.legacyGroups?.some(
                    (key) => host.groups.includes(key) === !!host.userQuotaExempt,
                )
            )
                ctx.addIssue({
                    code: 'custom',
                    message: 'Missing global quota binding or ambiguous recovery exemption',
                });
            count += Object.keys(host.allowedIdentities).length;
            for (const key of host.groups) {
                if (
                    !policy.groups[key]?.reserveRequired &&
                    !Object.keys(policy.groups[key]?.unreservedAccounts ?? {}).length
                )
                    continue;
                const factor = host.quotaMultipliers?.[key];
                const global = policy.groups[key]?.multiplierScale === USER_QUOTA_SCALE;
                if (
                    factor === undefined ||
                    factor < (global ? 0 : 1) ||
                    factor > (global ? USER_QUOTA_MAX_FACTOR : 10000)
                )
                    ctx.addIssue({ code: 'custom', message: 'Invalid quota billing multiplier' });
            }
            if (
                policy.offlineReserves &&
                Object.keys(host.allowedIdentities).some(
                    (identity) => !Object.hasOwn(host.identityExpiresAt ?? {}, identity),
                )
            )
                ctx.addIssue({ code: 'custom', message: 'Missing offline identity expiry' });
            if (
                policy.offlineReserves &&
                host.groups.some(
                    (key) =>
                        policy.groups[key]?.reserveRequired &&
                        !Object.hasOwn(host.quotaMultipliers ?? {}, key),
                )
            )
                ctx.addIssue({ code: 'custom', message: 'Missing quota multiplier' });
            if (
                !policy.protectedInbounds.includes(host.inboundTag) ||
                host.groups.some((key) => !policy.groups[key]) ||
                Object.keys(host.allowedIdentities).some((key) => !key.endsWith('~h' + id))
            )
                ctx.addIssue({ code: 'custom', message: 'Invalid host policy reference' });
        }
        const usageAccounts = new Set<string>();
        for (const group of Object.values(policy.groups)) {
            for (const account of Object.values(group.unreservedAccounts ?? {})) {
                if (usageAccounts.has(account))
                    ctx.addIssue({ code: 'custom', message: 'Duplicate unreserved usage account' });
                usageAccounts.add(account);
            }
            if (group.unreservedAccounts && !policy.offlineReserves)
                ctx.addIssue({
                    code: 'custom',
                    message: 'Usage accounts require autonomous quotas',
                });
            count +=
                Object.keys(group.blockedOwners).length +
                Object.keys(group.reserves ?? {}).length +
                Object.keys(group.unlimitedOwners ?? {}).length +
                Object.keys(group.fencedOwners ?? {}).length +
                Object.keys(group.unreservedAccounts ?? {}).length;
            if ((group.fenceAll || group.fencedOwners) && !policy.offlineReserves)
                ctx.addIssue({
                    code: 'custom',
                    message: 'Quota fences require autonomous quota mode',
                });
            if (
                (group.reserveRequired || group.reserves || group.unlimitedOwners) &&
                !policy.offlineReserves
            )
                ctx.addIssue({ code: 'custom', message: 'Missing reserve capability' });
            if ((group.reserves || group.unlimitedOwners) && !group.reserveRequired)
                ctx.addIssue({ code: 'custom', message: 'Reserve owners require a quota scope' });
            if (Object.keys(group.reserves ?? {}).some((owner) => group.unlimitedOwners?.[owner]))
                ctx.addIssue({
                    code: 'custom',
                    message: 'A quota owner cannot be both reserved and unlimited',
                });
        }
        if (
            count > 200000 ||
            Object.keys(policy.hosts).length > 10000 ||
            Object.keys(policy.groups).length > 10000
        )
            ctx.addIssue({ code: 'custom', message: 'Host policy too large' });
    });

const recoveryPolicyRequest = recoveryFenceRequest.extend({
    previous: z.string().regex(/^[a-f0-9]{64}$/),
    instance: recoveryFenceRequest.shape.instance.unwrap(),
    policyRevision: z
        .string()
        .regex(/^[1-9][0-9]{0,18}$/)
        .refine((value) => BigInt(value) <= 9223372036854775807n),
});

@UseGuards(JwtDefaultGuard)
@Controller('xray/host-policy')
export class HostPolicyController {
    private pending: Promise<unknown> = Promise.resolve();
    private versionCache = {
        key: '',
        supported: false,
        destinationRulesSupported: false,
        deviceSpeedLimitsSupported: false,
        quotaReservesSupported: false,
        quotaRegistrationsSupported: false,
        quotaWatermarksSupported: false,
        quotaFencesSupported: false,
        quotaRecoveryFencesSupported: false,
        coreIncarnationSupported: false,
        usageReceiptsSupported: false,
        userQuotaReservesSupported: false,
        unreservedUsageSupported: false,
    };
    constructor(
        private readonly xray: XrayProcessService,
        private readonly liveCore: LiveCoreService,
        private readonly config: TypedConfigService,
    ) {}

    private async supported(): Promise<boolean> {
        try {
            const process = await this.xray.getStatus();
            const path =
                process.up && process.pid
                    ? `/proc/${process.pid}/exe`
                    : await realpath('/usr/local/bin/rw-core');
            const details = await stat(path);
            if (!details.isFile() || details.size > 192 * 1024 * 1024) return false;
            const key = `${path}:${details.ino}:${details.size}:${details.mtimeMs}`;
            if (key !== this.versionCache.key) {
                const binary = await readFile(path);
                this.versionCache = {
                    key,
                    supported: binary.includes(Buffer.from(VERSION)),
                    deviceSpeedLimitsSupported: binary.includes(Buffer.from(DEVICE_SPEED_LIMITS)),
                    destinationRulesSupported: binary.includes(
                        Buffer.from('xera-destination-rules-v1'),
                    ),
                    quotaReservesSupported: binary.includes(Buffer.from(QUOTA_RESERVE_VERSION)),
                    quotaRegistrationsSupported: binary.includes(
                        Buffer.from(QUOTA_REGISTRATION_VERSION),
                    ),
                    quotaWatermarksSupported: binary.includes(Buffer.from(QUOTA_WATERMARK_VERSION)),
                    quotaFencesSupported: binary.includes(Buffer.from(QUOTA_FENCES)),
                    quotaRecoveryFencesSupported: binary.includes(
                        Buffer.from(QUOTA_RECOVERY_FENCE),
                    ),
                    coreIncarnationSupported: binary.includes(Buffer.from(CORE_INCARNATION)),
                    usageReceiptsSupported: binary.includes(Buffer.from(USAGE_RECEIPTS)),
                    userQuotaReservesSupported: binary.includes(Buffer.from(USER_QUOTA_VERSION)),
                    unreservedUsageSupported: binary.includes(Buffer.from(UNRESERVED_USAGE)),
                };
            }
            return this.versionCache.supported;
        } catch {
            return false;
        }
    }

    @Get()
    async status() {
        const supported = await this.supported();
        let recoveryPolicyBindingsRequired = true;
        try {
            recoveryPolicyBindingsRequired = (await readRecoveryFence()) !== null;
        } catch {
            /* Unreadable recovery state cannot authorize an unbound update. */
        }

        const policy = await readFile(FILE, 'utf8')
            .then((value) => JSON.parse(value))
            .catch(() => null);
        const applied = await readFile(`${DIRECTORY}/host-policy.status.json`, 'utf8')
            .then((value) => JSON.parse(value))
            .catch(() => null);
        const process = await this.xray.getStatus();
        const coreProcessId =
            supported && this.versionCache.coreIncarnationSupported
                ? ((await readCoreIncarnation(process)) ??
                  (this.versionCache.quotaRecoveryFencesSupported
                      ? await readCoreIncarnation(process, QUOTA_RECOVERY_STATUS)
                      : null))
                : null;
        const quotaRecovery =
            supported && this.versionCache.quotaRecoveryFencesSupported
                ? await readRecoveryFenceState(process, coreProcessId).catch(() => null)
                : null;
        const quotaRequirementReady =
            !policy?.userQuota || this.liveCore.hasUserQuotaRequirement(coreProcessId);
        const journal =
            supported && this.versionCache.quotaReservesSupported
                ? await readQuotaJournalSnapshot().catch(() => null)
                : null;
        const checkpointReady =
            !policy?.quotaCheckpoint ||
            !!(
                journal &&
                journal.instance === policy.quotaCheckpoint.instance &&
                /^(0|[1-9][0-9]{0,15})$/.test(policy.quotaCheckpoint.sequence) &&
                BigInt(journal.sequence) >= BigInt(policy.quotaCheckpoint.sequence) &&
                BigInt(journal.checkpoint) <= BigInt(policy.quotaCheckpoint.sequence) &&
                applied?.quotaWatermarks === QUOTA_WATERMARK_VERSION
            );
        return {
            response: {
                supported,
                destinationRulesSupported: supported && this.versionCache.destinationRulesSupported,
                deviceSpeedLimitsSupported:
                    supported && this.versionCache.deviceSpeedLimitsSupported,
                quotaReservesSupported: supported && this.versionCache.quotaReservesSupported,
                quotaRegistrationsSupported:
                    supported && this.versionCache.quotaRegistrationsSupported,
                quotaWatermarksSupported: supported && this.versionCache.quotaWatermarksSupported,
                quotaSnapshotsSupported: true,
                quotaRecoveryReceiptsSupported:
                    supported &&
                    this.versionCache.usageReceiptsSupported &&
                    this.versionCache.quotaRecoveryFencesSupported &&
                    this.versionCache.coreIncarnationSupported,
                quotaRecoveryReleasesSupported:
                    supported &&
                    this.versionCache.usageReceiptsSupported &&
                    this.versionCache.quotaRecoveryFencesSupported &&
                    this.versionCache.coreIncarnationSupported &&
                    this.versionCache.quotaFencesSupported,
                quotaRecoveryQuiescenceSupported:
                    supported &&
                    this.versionCache.usageReceiptsSupported &&
                    this.versionCache.quotaRecoveryFencesSupported &&
                    this.versionCache.coreIncarnationSupported,
                quotaRecoverySamplesSupported:
                    supported &&
                    this.versionCache.usageReceiptsSupported &&
                    this.versionCache.quotaRecoveryFencesSupported &&
                    this.versionCache.coreIncarnationSupported,

                quotaRecoveryFencesSupported:
                    supported && this.versionCache.quotaRecoveryFencesSupported,
                quotaRecoveryPolicyBindingsSupported:
                    supported && this.versionCache.quotaRecoveryFencesSupported,
                quotaRecoveryPolicyBindingsRequired: recoveryPolicyBindingsRequired,
                quotaRecoveryPoliciesSupported:
                    supported &&
                    this.versionCache.quotaRecoveryFencesSupported &&
                    this.versionCache.quotaFencesSupported,
                quotaRecovery,
                quotaJournalSequence: journal ? String(journal.sequence) : null,
                quotaFencesSupported: supported && this.versionCache.quotaFencesSupported,
                coreIncarnationSupported: supported && this.versionCache.coreIncarnationSupported,
                usageReceiptsSupported: supported && this.versionCache.usageReceiptsSupported,
                userQuotaReservesSupported:
                    supported && this.versionCache.userQuotaReservesSupported,
                unreservedUsageSupported: supported && this.versionCache.unreservedUsageSupported,
                userQuotaRequired: !!policy?.userQuota && quotaRequirementReady,
                coreProcessId,
                policyRevisionsSupported: true,
                offlineReserves: policy?.offlineReserves ?? null,
                policyRevision: typeof policy?.revision === 'string' ? policy.revision : '0',
                policyGeneration: typeof policy?.generation === 'string' ? policy.generation : null,
                quotaInstanceId:
                    supported && this.versionCache.quotaReservesSupported
                        ? (journal?.instance ?? null)
                        : null,
                quotaRequiredGroups:
                    supported &&
                    checkpointReady &&
                    process.up &&
                    policy?.generation === applied?.generation &&
                    applied?.pid === process.pid &&
                    applied?.quotaReserves === QUOTA_RESERVE_VERSION &&
                    (!policy?.quotaRegistrations ||
                        applied?.quotaRegistrations === QUOTA_REGISTRATION_VERSION) &&
                    (!policyHasQuotaFences(policy) || applied?.quotaFences === QUOTA_FENCES) &&
                    (!policyHasUnreservedUsage(policy) ||
                        applied?.unreservedUsage === UNRESERVED_USAGE) &&
                    (!policy?.userQuota ||
                        (applied?.userQuotaReserves === USER_QUOTA_VERSION &&
                            quotaRequirementReady))
                        ? Object.entries(policy?.groups ?? {})
                              .filter(
                                  ([, group]) =>
                                      (group as { reserveRequired?: boolean }).reserveRequired,
                              )
                              .map(([key]) => key)
                        : [],
                version: VERSION,
                corePid: process.up ? process.pid : null,
                group: policy?.group ?? null,
                applied:
                    supported &&
                    checkpointReady &&
                    process.up &&
                    applied?.pid === process.pid &&
                    !!policy &&
                    policy.generation === applied?.generation &&
                    (!policy.offlineReserves || applied?.quotaReserves === QUOTA_RESERVE_VERSION) &&
                    (!policy.quotaRegistrations ||
                        applied?.quotaRegistrations === QUOTA_REGISTRATION_VERSION) &&
                    (!policyHasQuotaFences(policy) || applied?.quotaFences === QUOTA_FENCES) &&
                    (!policyHasUnreservedUsage(policy) ||
                        applied?.unreservedUsage === UNRESERVED_USAGE) &&
                    (!policy?.userQuota ||
                        (applied?.userQuotaReserves === USER_QUOTA_VERSION &&
                            quotaRequirementReady)),
                expiresAt: policy?.expiresAt ?? null,
            },
        };
    }

    @Post()
    async update(@Body() body: unknown, @Headers(RECOVERY_POLICY_PROOF_HEADER) proof?: unknown) {
        const result = this.pending.then(() =>
            coreManagement.run(async () => {
                const result = await this.apply(body, undefined, proof);
                if (
                    (body as { userQuota?: unknown } | null)?.userQuota !== USER_QUOTA_VERSION ||
                    !result.response.applied
                )
                    return result;
                try {
                    const process = await this.xray.getStatus();
                    const core = await readCoreIncarnation(process);
                    if (!process.up || !process.pid || !core)
                        throw new Error('Missing core incarnation');
                    await this.liveCore.requireUserQuota(
                        `/proc/${process.pid}/exe`,
                        this.config.getOrThrow('INTERNAL_SOCKET_PATH'),
                        core,
                    );
                    if ((await readCoreIncarnation(await this.xray.getStatus())) !== core)
                        throw new Error('Core restarted during quota requirement commit');
                    return { response: { ...result.response, userQuotaRequired: true } };
                } catch {
                    throw new ServiceUnavailableException(
                        'Xray has not persisted the user quota requirement',
                    );
                }
            }),
        );
        this.pending = result.catch(() => undefined);
        return result;
    }

    @Post('quota-recovery-fence')
    async quotaRecoveryFence(@Body() body: unknown) {
        const parsed = recoveryFenceRequest.safeParse(body);
        if (!parsed.success) throw new BadRequestException('Invalid recovery pause request');
        const result = this.pending.then(() =>
            coreManagement.run(async () => {
                const before = (await this.status()).response;
                if (
                    !before.quotaRecoveryFencesSupported ||
                    !before.quotaRecovery ||
                    before.coreProcessId !== parsed.data.coreProcessId ||
                    before.quotaInstanceId !== parsed.data.instance
                )
                    throw new ConflictException('Recovery pause source changed');
                try {
                    const record = await persistRecoveryFence(parsed.data);
                    for (let attempt = 0; attempt < 35; attempt++) {
                        const after = (await this.status()).response;
                        if (
                            after.coreProcessId !== before.coreProcessId ||
                            after.corePid !== before.corePid ||
                            after.quotaInstanceId !== before.quotaInstanceId
                        )
                            throw new Error('Recovery pause core changed');
                        if (after.quotaRecovery?.record?.digest === record.digest)
                            return {
                                response: {
                                    coreProcessId: after.coreProcessId,
                                    quotaRecovery: after.quotaRecovery,
                                },
                            };
                        await new Promise((resolve) => setTimeout(resolve, 100));
                    }
                } catch {
                    throw new ServiceUnavailableException('Recovery pause cannot be verified');
                }
                throw new ServiceUnavailableException('Recovery pause is not acknowledged');
            }),
        );
        this.pending = result.catch(() => undefined);
        return result;
    }

    private async observeRecoveryRelease(): Promise<RecoveryReleaseObservation> {
        const before = (await this.status()).response;
        if (
            !before.quotaRecoveryReleasesSupported ||
            !before.applied ||
            !before.userQuotaRequired ||
            !before.corePid ||
            !before.coreProcessId ||
            !before.quotaInstanceId ||
            !before.policyGeneration ||
            !before.quotaRecovery?.record
        )
            throw new Error('Recovery release has no live native source');
        const stored = JSON.parse(await readFile(FILE, 'utf8'));
        const { generation, expiresAt: _expiry, ...content } = stored;
        if (generation !== before.policyGeneration || content.revision !== before.policyRevision)
            throw new Error('Recovery release saved policy changed');
        const policy = hostPolicySchema.parse(content);
        const bytes = await privateRead(RECOVERY_QUIESCENCE_FILE);
        const journal = await readUsageArchiveFile();
        if (!bytes || !journal) throw new Error('Recovery release original source is missing');
        const witness = recoveryQuiescenceSchema.parse(JSON.parse(bytes.toString('utf8')));
        const after = (await this.status()).response;
        if (
            !after.applied ||
            !after.userQuotaRequired ||
            after.corePid !== before.corePid ||
            after.coreProcessId !== before.coreProcessId ||
            after.quotaInstanceId !== before.quotaInstanceId ||
            after.policyRevision !== before.policyRevision ||
            after.policyGeneration !== before.policyGeneration ||
            after.quotaRecovery?.record?.digest !== before.quotaRecovery.record.digest
        )
            throw new Error('Recovery release live observation changed');
        return {
            pid: before.corePid,
            coreProcessId: before.coreProcessId,
            instance: before.quotaInstanceId,
            applied: true,
            userQuotaRequired: true,
            fence: before.quotaRecovery.record,
            policy: { ...policy, revision: before.policyRevision },
            policyGeneration: before.policyGeneration,
            witness,
            journal,
        };
    }

    @Post('quota-recovery-release')
    async quotaRecoveryRelease(@Body() body: unknown) {
        const parsed = recoveryReleaseRequest.safeParse(body);
        if (!parsed.success) throw new BadRequestException('Invalid recovery release request');
        const request = parsed.data;
        const result = this.pending.then(() =>
            coreManagement.run(async () => {
                let before: RecoveryReleaseObservation;
                try {
                    before = await this.observeRecoveryRelease();
                    planRecoveryRelease(request, before);
                } catch {
                    throw new ConflictException('Recovery release source changed');
                }
                try {
                    const record = await persistRecoveryRelease(request, () =>
                        this.observeRecoveryRelease(),
                    );
                    for (let attempt = 0; attempt < 35; attempt++) {
                        const status = (await this.status()).response;
                        if (
                            status.corePid !== before.pid ||
                            status.coreProcessId !== before.coreProcessId ||
                            status.quotaInstanceId !== before.instance
                        )
                            throw new Error('Recovery release core changed');
                        if (status.quotaRecovery?.record?.digest === record.digest) {
                            const live = await this.observeRecoveryRelease();
                            if (
                                live.pid !== before.pid ||
                                planRecoveryRelease(request, live).digest !== record.digest
                            )
                                throw new Error('Recovery release acknowledgement changed');
                            return {
                                response: {
                                    requestId: request.requestId,
                                    generation: request.generation,
                                    coreProcessId: live.coreProcessId,
                                    instance: live.instance,
                                    policyRevision: request.policyRevision,
                                    policyGeneration: live.policyGeneration,
                                    journalDigest: request.journalDigest,
                                    witnessDigest: request.witnessDigest,
                                    quotaRecovery: { version: record.version, record },
                                },
                            };
                        }
                        await new Promise((resolve) => setTimeout(resolve, 100));
                    }
                } catch {
                    throw new ServiceUnavailableException(
                        'Recovery release cannot be verified; retry the same request',
                    );
                }
                throw new ServiceUnavailableException(
                    'Recovery release is not acknowledged; retry the same request',
                );
            }),
        );
        this.pending = result.catch(() => undefined);
        return result;
    }

    @Post('quota-recovery-policy')
    async quotaRecoveryPolicy(@Body() body: unknown) {
        const parsed = recoveryPolicyRequest.safeParse(body);
        if (!parsed.success) throw new BadRequestException('Invalid recovery policy request');
        const request = parsed.data;
        const result = this.pending.then(() =>
            coreManagement.run(async () => {
                const before = (await this.status()).response;
                if (
                    !before.applied ||
                    !before.userQuotaRequired ||
                    !before.quotaFencesSupported ||
                    !before.quotaRecoveryFencesSupported ||
                    before.coreProcessId !== request.coreProcessId ||
                    before.quotaInstanceId !== request.instance ||
                    before.quotaRecovery?.record?.state !== 'FENCED' ||
                    before.quotaRecovery.record.generation !== request.generation ||
                    before.quotaRecovery.record.digest !== request.previous
                )
                    throw new ConflictException('Recovery policy source changed');
                let policy: z.infer<typeof hostPolicySchema>;
                try {
                    const stored = JSON.parse(await readFile(FILE, 'utf8'));
                    const { generation: storedGeneration, expiresAt: _expiry, ...content } = stored;
                    if (
                        storedGeneration !== before.policyGeneration ||
                        content.revision !== before.policyRevision
                    )
                        throw new Error('Policy changed');
                    policy = hostPolicySchema.parse(
                        heldRecoveryPolicy(hostPolicySchema.parse(content), request.policyRevision),
                    );
                } catch {
                    throw new ServiceUnavailableException(
                        'Saved recovery policy cannot be verified',
                    );
                }
                await this.apply(policy, {
                    generation: request.generation,
                    previous: request.previous,
                });
                const after = (await this.status()).response;
                if (
                    !after.applied ||
                    !after.userQuotaRequired ||
                    after.coreProcessId !== before.coreProcessId ||
                    after.corePid !== before.corePid ||
                    after.quotaInstanceId !== request.instance ||
                    after.policyRevision !== request.policyRevision ||
                    after.quotaRecovery?.record?.digest !== request.previous ||
                    after.quotaRecovery.record.state !== 'FENCED'
                )
                    throw new ServiceUnavailableException(
                        'Recovery policy acknowledgement changed',
                    );
                return {
                    response: {
                        requestId: request.requestId,
                        coreProcessId: after.coreProcessId,
                        instance: after.quotaInstanceId,
                        policyRevision: after.policyRevision,
                        policyGeneration: after.policyGeneration,
                        quotaRecovery: after.quotaRecovery,
                    },
                };
            }),
        );
        this.pending = result.catch(() => undefined);
        return result;
    }

    @Post('quota-snapshot')
    async quotaSnapshot(@Body() body: unknown) {
        const request = quotaSnapshotRequest.safeParse(body);
        if (!request.success) throw new BadRequestException('Invalid quota snapshot request');
        const result = this.pending.then(() =>
            coreManagement.run(async () => {
                try {
                    const before = (await this.status()).response;
                    if (
                        !before.applied ||
                        !before.quotaWatermarksSupported ||
                        !before.coreProcessId ||
                        (before.quotaRecoveryFencesSupported && !before.quotaRecovery)
                    )
                        throw new Error('Missing live quota acknowledgement');
                    const journal = await readQuotaJournalSnapshot();
                    const after = (await this.status()).response;
                    if (
                        !after.applied ||
                        !journal.watermarksRequired ||
                        !before.quotaJournalSequence ||
                        !after.quotaJournalSequence ||
                        before.coreProcessId !== after.coreProcessId ||
                        before.corePid !== after.corePid ||
                        before.policyRevision !== after.policyRevision ||
                        before.quotaInstanceId !== journal.instance ||
                        after.quotaInstanceId !== journal.instance ||
                        BigInt(journal.sequence) < BigInt(before.quotaJournalSequence) ||
                        BigInt(journal.sequence) > BigInt(after.quotaJournalSequence) ||
                        before.quotaRecovery?.record?.digest !==
                            after.quotaRecovery?.record?.digest ||
                        (after.quotaRecoveryFencesSupported && !after.quotaRecovery)
                    )
                        throw new Error('Quota source changed while capturing');
                    return {
                        response: await encodeQuotaSnapshot(
                            request.data,
                            journal,
                            before.policyRevision,
                            before.coreProcessId,
                            before.quotaRecovery,
                        ),
                    };
                } catch {
                    throw new ServiceUnavailableException('Quota snapshot cannot be verified');
                }
            }),
        );
        this.pending = result.catch(() => undefined);
        return result;
    }

    @Post('quota-state')
    async quotaState(@Body() body: unknown) {
        const result = this.pending.then(() => this.readQuotaState(body));
        this.pending = result.catch(() => undefined);
        return result;
    }

    private async readQuotaState(body: unknown) {
        const request = quotaStateRequest.safeParse(body);
        if (!request.success) throw new BadRequestException('Invalid quota state selection');
        const state = await this.status();
        if (!state.response.applied || !state.response.quotaReservesSupported)
            throw new ServiceUnavailableException(
                'A running core must acknowledge the current policy before quota settlement',
            );
        try {
            const journal = await readQuotaJournal();
            const ids =
                (request.data.ids
                    ? [...new Set(request.data.ids.map((id) => id.toLowerCase()))]
                    : undefined) ??
                [...journal.entries.keys()]
                    .sort()
                    .filter((id) => !request.data.after || id > request.data.after.toLowerCase())
                    .slice(0, request.data.limit);
            const entries = ids.flatMap((id) => {
                const entry = journal.entries.get(id);
                return entry ? [{ id, ...entry }] : [];
            });
            const after = await this.status();
            if (
                !after.response.applied ||
                after.response.corePid !== state.response.corePid ||
                after.response.policyRevision !== state.response.policyRevision
            )
                throw new Error('Core or policy changed during quota settlement');
            return {
                response: {
                    instance: journal.instance,
                    sequence: journal.sequence,
                    policyRevision: state.response.policyRevision,
                    entries,
                    missingIds: request.data.ids
                        ? ids.filter((id) => !journal.entries.has(id))
                        : [],
                    nextAfter:
                        !request.data.ids && ids.length === request.data.limit ? ids.at(-1) : null,
                },
            };
        } catch {
            throw new ServiceUnavailableException(
                'Quota journal cannot be verified; its state must be recovered before settlement',
            );
        }
    }
    private async apply(body: unknown, stage?: RecoveryPolicyGate, ordinaryProof?: unknown) {
        try {
            const recovery = await readRecoveryFence();
            const proof = parseRecoveryPolicyProof(ordinaryProof);
            requireRecoveryPolicyGate(recovery, stage, proof);
            if (!stage && recovery?.state === 'RELEASED') {
                const process = await this.xray.getStatus();
                const core = await readCoreIncarnation(process);
                const instance = await verifyQuotaLedger();
                if (
                    !process.up ||
                    !core ||
                    proof?.coreProcessId !== core ||
                    !instance ||
                    proof.instance !== instance
                )
                    throw new Error('Recovery policy identity changed');
            }
        } catch {
            throw new ConflictException(
                'Quota recovery requires reconciliation before policy changes',
            );
        }
        const parsed = hostPolicySchema.safeParse(body);
        if (!parsed.success) {
            throw new BadRequestException('Invalid host policy');
        }
        if (!(await this.supported()))
            throw new ServiceUnavailableException(
                'Update Xray Core: server host limits are not supported',
            );
        if (parsed.data.userQuota && !this.versionCache.userQuotaReservesSupported)
            throw new ServiceUnavailableException(
                'Update Xray Core: autonomous user quotas are not supported',
            );
        if (
            Object.values(parsed.data.groups).some(
                (group) => (group.deviceBytesPerSecond ?? 0) > 0,
            ) &&
            !this.versionCache.deviceSpeedLimitsSupported
        )
            throw new ServiceUnavailableException(
                'Update Xray Core: authenticated device speed limits are not supported',
            );
        const needsDestinationRules = Object.values(parsed.data.hosts).some(
            (host) => host.domainMode !== 'OFF' && host.domains.some(isIpDestinationRule),
        );
        if (needsDestinationRules && !this.versionCache.destinationRulesSupported)
            throw new ServiceUnavailableException(
                'Update Xray Core: IP and CIDR host rules are not supported',
            );
        let existingPolicy:
            | (Record<string, unknown> & { offlineReserves?: string; revision?: string })
            | null;
        try {
            const stored = JSON.parse(await readFile(FILE, 'utf8'));
            if (
                !stored ||
                typeof stored !== 'object' ||
                Array.isArray(stored) ||
                !['xera-host-policy-v1', VERSION].includes(stored.version) ||
                (stored.revision !== undefined &&
                    (typeof stored.revision !== 'string' ||
                        !/^[1-9][0-9]{0,18}$/.test(stored.revision) ||
                        BigInt(stored.revision) > 9223372036854775807n))
            )
                throw new Error('Unknown persisted policy');
            existingPolicy = stored;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw new ServiceUnavailableException(
                    'Saved host policy cannot be verified; recover its persistent state',
                );
            existingPolicy = null;
        }
        let requiredOnDisk: boolean;
        try {
            requiredOnDisk = await userQuotaRequiredOnDisk();
        } catch {
            throw new ServiceUnavailableException(
                'User quota state must be recovered before replacing the policy',
            );
        }
        if ((existingPolicy?.userQuota || requiredOnDisk) && !parsed.data.userQuota)
            throw new ServiceUnavailableException(
                'An existing user quota requirement cannot be removed',
            );
        if (existingPolicy?.revision) {
            if (
                !parsed.data.revision ||
                BigInt(parsed.data.revision) < BigInt(existingPolicy.revision)
            )
                throw new ConflictException(
                    'Host policy revision is stale; refresh node state before retrying',
                );
            if (parsed.data.revision === existingPolicy.revision) {
                const {
                    generation: _generation,
                    expiresAt: _expiresAt,
                    ...content
                } = existingPolicy;
                if (!isDeepStrictEqual(content, parsed.data))
                    throw new ConflictException(
                        'Host policy revision was reused for different content',
                    );
            }
        }
        const needsUnreservedUsage =
            policyHasUnreservedUsage(parsed.data) || policyHasUnreservedUsage(existingPolicy);
        if (needsUnreservedUsage && !this.versionCache.unreservedUsageSupported)
            throw new ServiceUnavailableException(
                'Update Xray Core: unreserved usage receipts are not supported',
            );
        const needsQuotaFences =
            policyHasQuotaFences(parsed.data) || policyHasQuotaFences(existingPolicy);
        if (needsQuotaFences && !this.versionCache.quotaFencesSupported)
            throw new ServiceUnavailableException(
                'Update Xray Core: soft quota fences are not supported',
            );
        if (parsed.data.offlineReserves) {
            if (
                (parsed.data.quotaRegistrations || existingPolicy?.quotaRegistrations) &&
                (!parsed.data.quotaRegistrations || !this.versionCache.quotaRegistrationsSupported)
            )
                throw new ServiceUnavailableException(
                    'Update Xray Core: durable grant registration is required',
                );
            if (!this.versionCache.quotaReservesSupported)
                throw new ServiceUnavailableException(
                    'Update Xray Core: durable quota reserves are not supported',
                );
            try {
                const instance = await prepareQuotaLedger(
                    existingPolicy?.offlineReserves === QUOTA_RESERVE_VERSION,
                );
                const journal = await readQuotaJournal();
                if (
                    (parsed.data.quotaCheckpoint ||
                        existingPolicy?.quotaCheckpoint ||
                        journal.watermarksRequired) &&
                    (!this.versionCache.quotaWatermarksSupported || !parsed.data.quotaCheckpoint)
                )
                    throw new Error('The core must preserve the quota journal checkpoint');
                if (
                    parsed.data.quotaCheckpoint &&
                    (parsed.data.quotaCheckpoint.instance !== instance ||
                        BigInt(parsed.data.quotaCheckpoint.sequence) > BigInt(journal.sequence) ||
                        BigInt(parsed.data.quotaCheckpoint.sequence) < BigInt(journal.checkpoint))
                )
                    throw new Error('Quota journal is behind its acknowledged checkpoint');
                if (
                    (journal.registrationsRequired && !parsed.data.quotaRegistrations) ||
                    parsed.data.registrations?.some((item) => item.grant.instance !== instance)
                )
                    throw new Error('Quota registration protocol or journal identity mismatch');
                if (
                    Object.values(parsed.data.groups).some((group) =>
                        Object.values(group.reserves ?? {}).some(
                            (grant) => grant.instance !== instance,
                        ),
                    )
                )
                    throw new Error('Quota reserve belongs to another node instance');
            } catch {
                throw new ServiceUnavailableException(
                    'Quota ledger is unavailable; recover its persistent state before resuming traffic',
                );
            }
        } else if (existingPolicy?.offlineReserves) {
            throw new ServiceUnavailableException(
                'Quota reserve mode requires an explicit coordinated downgrade',
            );
        }
        const process = await this.xray.getStatus();
        if (process.up) {
            const [existing, applied] = await Promise.all([
                readFile(FILE, 'utf8')
                    .then((value) => JSON.parse(value))
                    .catch(() => null),
                readFile(`${DIRECTORY}/host-policy.status.json`, 'utf8')
                    .then((value) => JSON.parse(value))
                    .catch(() => null),
            ]);
            if (
                existing &&
                applied &&
                applied.pid === process.pid &&
                typeof existing.generation === 'string' &&
                existing.generation === applied.generation &&
                Number.isFinite(existing.expiresAt) &&
                existing.expiresAt > Date.now() + 30_000 &&
                (!needsDestinationRules ||
                    applied.destinationRules === 'xera-destination-rules-v1') &&
                (!parsed.data.offlineReserves || applied.quotaReserves === QUOTA_RESERVE_VERSION) &&
                (!parsed.data.quotaRegistrations ||
                    applied.quotaRegistrations === QUOTA_REGISTRATION_VERSION) &&
                (!parsed.data.quotaCheckpoint ||
                    applied.quotaWatermarks === QUOTA_WATERMARK_VERSION) &&
                (!parsed.data.userQuota || applied.userQuotaReserves === USER_QUOTA_VERSION) &&
                (!needsQuotaFences || applied.quotaFences === QUOTA_FENCES) &&
                (!needsUnreservedUsage || applied.unreservedUsage === UNRESERVED_USAGE)
            ) {
                const { generation: _generation, expiresAt: _expiresAt, ...content } = existing;
                if (isDeepStrictEqual(content, parsed.data))
                    return {
                        response: {
                            version: VERSION,
                            supported: true,
                            applied: true,
                            unchanged: true,
                        },
                    };
            }
        }
        const generation = randomUUID();
        await mkdir(DIRECTORY, { recursive: true, mode: 0o700 });
        const tmp = `${FILE}.${generation}.tmp`;
        const checkpoint = await open(tmp, 'wx', 0o600);
        try {
            try {
                await checkpoint.writeFile(
                    JSON.stringify({
                        ...parsed.data,
                        version: VERSION,
                        generation,
                        expiresAt: Date.now() + 90_000,
                    }),
                );
                await checkpoint.sync();
            } finally {
                await checkpoint.close();
            }
            await rename(tmp, FILE);
            if (platform() !== 'win32') {
                const directory = await open(DIRECTORY, 'r');
                try {
                    await directory.sync();
                } finally {
                    await directory.close();
                }
            }
        } finally {
            await rm(tmp, { force: true });
        }
        const current = await this.xray.getStatus();
        if (!current.up)
            return {
                response: { version: VERSION, supported: true, staged: true, applied: false },
            };
        for (let attempt = 0; attempt < 20; attempt++) {
            const state = await readFile(`${DIRECTORY}/host-policy.status.json`, 'utf8')
                .then((value) => JSON.parse(value))
                .catch(() => null);
            if (
                state?.generation === generation &&
                state?.pid === current.pid &&
                (!needsDestinationRules ||
                    state.destinationRules === 'xera-destination-rules-v1') &&
                (!parsed.data.offlineReserves || state.quotaReserves === QUOTA_RESERVE_VERSION) &&
                (!parsed.data.quotaRegistrations ||
                    state.quotaRegistrations === QUOTA_REGISTRATION_VERSION) &&
                (!parsed.data.quotaCheckpoint ||
                    state.quotaWatermarks === QUOTA_WATERMARK_VERSION) &&
                (!parsed.data.userQuota || state.userQuotaReserves === USER_QUOTA_VERSION) &&
                (!needsQuotaFences || state.quotaFences === QUOTA_FENCES) &&
                (!needsUnreservedUsage || state.unreservedUsage === UNRESERVED_USAGE)
            )
                return { response: { version: VERSION, supported: true, applied: true } };
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new ServiceUnavailableException('Xray has not acknowledged the host policy');
    }
}
