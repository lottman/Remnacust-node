import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

import {
    BadRequestException,
    Body,
    Controller,
    Headers,
    Post,
    ServiceUnavailableException,
    UseGuards,
} from '@nestjs/common';

import { TypedConfigService } from '@common/config/app-config';
import { JwtDefaultGuard } from '@common/guards/jwt-guards';

import { readCoreIncarnation } from './core-incarnation';
import { coreManagement } from './core-management';
import { verifyQuotaLedger } from './quota-ledger';
import { readRecoveryFence, readRecoveryFenceState } from './quota-recovery-fence';
import {
    RECOVERY_POLICY_PROOF_HEADER,
    parseRecoveryPolicyProof,
    requireRecoveryPolicyGate,
} from './quota-recovery-policy';
import {
    persistRecoveryQuiescence,
    readRecoveryQuiescence,
    recoveryQuiescenceReplySchema,
} from './recovery-quiescence';
import {
    recoveryUsageAckRequest,
    recoveryUsageAckReply,
    recoveryAckJournal,
    RECOVERY_USAGE_ACK,
    RecoveryUsageAckRequest,
} from './recovery-usage-ack';
import {
    RECOVERY_USAGE_SAMPLE,
    recoverySampleJournal,
    recoveryUsageSampleRequest,
    recoveryUsageSampleReply,
} from './recovery-usage-sample';
import { readUsageArchiveFile } from './usage-archive';
import { usageJournalHead } from './usage-journal';
import {
    USAGE_RECEIPTS,
    parseUsageReceiptResponse,
    usageReceiptRequest,
    UsageReceiptRequest,
} from './usage-receipt';
import { XrayProcessService } from './xray-process.service';

const run = promisify(execFile);

@UseGuards(JwtDefaultGuard)
@Controller('xray/usage-receipts')
export class UsageReceiptController {
    private capability = { key: '', supported: false };
    constructor(
        private readonly xray: XrayProcessService,
        private readonly config: TypedConfigService,
    ) {}

    @Post()
    async exchange(
        @Body() body: unknown,
        @Headers(RECOVERY_POLICY_PROOF_HEADER) proofHeader?: unknown,
    ) {
        const parsed = usageReceiptRequest.safeParse(body);
        if (!parsed.success) throw new BadRequestException('Invalid usage receipt request');
        try {
            return await coreManagement.run(async () => {
                if (parsed.data.action === 'ack') {
                    const proof = parseRecoveryPolicyProof(proofHeader);
                    requireRecoveryPolicyGate(await readRecoveryFence(), undefined, proof);
                    if (proof && proof.instance !== parsed.data.stream)
                        throw new Error('Usage acknowledgement recovery binding changed');
                }
                const proof =
                    parsed.data.action === 'ack' ? parseRecoveryPolicyProof(proofHeader) : null;
                return this.perform(parsed.data, proof?.coreProcessId);
            });
        } catch {
            // Never fall back to a destructive legacy reset after an uncertain
            // receipt exchange. The same request must be retried after recovery.
            throw new ServiceUnavailableException(
                'Usage receipt cannot be verified; retry the same request after recovery',
            );
        }
    }
    private async perform(request: UsageReceiptRequest, expectedLiveCore?: string) {
        if ((await verifyQuotaLedger()) !== request.stream)
            throw new Error('Node instance binding differs');
        const process = await this.xray.getStatus();
        if (!process.up || !Number.isSafeInteger(process.pid) || !process.pid || process.pid < 1)
            throw new Error('Core is stopped');
        if (expectedLiveCore && (await readCoreIncarnation(process)) !== expectedLiveCore)
            throw new Error('Usage acknowledgement core changed');
        const binary = `/proc/${process.pid}/exe`;
        const details = await stat(binary);
        if (!details.isFile() || details.size > 192 * 1024 * 1024)
            throw new Error('Invalid core executable');
        const key = `${binary}:${details.dev}:${details.ino}:${details.size}:${details.mtimeMs}:${details.ctimeMs}`;
        if (this.capability.key !== key)
            this.capability = {
                key,
                supported: (await readFile(binary)).includes(Buffer.from(USAGE_RECEIPTS)),
            };
        if (!this.capability.supported) throw new Error('Core does not support durable usage');
        const args = [
            'api',
            'usage-receipt',
            `--server=unix:${this.config.getOrThrow('INTERNAL_SOCKET_PATH')}`,
            '--timeout=10',
            `--action=${request.action}`,
            `--stream=${request.stream}`,
            `--sequence=${request.sequence}`,
            `--core=${request.coreProcessId}`,
        ];
        if (request.action === 'ack') args.push(`--digest=${request.digest}`);
        const { stdout } = await run(binary, args, {
            timeout: 15000,
            maxBuffer: 16 * 1024 * 1024,
        });
        return { response: parseUsageReceiptResponse(request, JSON.parse(stdout)) };
    }
    private async recoveryContext(
        request: Pick<
            RecoveryUsageAckRequest,
            'generation' | 'coreProcessId' | 'instance' | 'previous'
        >,
    ) {
        const process = await this.xray.getStatus();
        const core = await readCoreIncarnation(process);
        const state = await readRecoveryFenceState(process, core);
        if (
            core !== request.coreProcessId ||
            state.record?.state !== 'FENCED' ||
            state.record.generation !== request.generation ||
            state.record.digest !== request.previous ||
            (await verifyQuotaLedger()) !== request.instance
        )
            throw new Error('Recovery receipt context changed');
        return { pid: process.pid, record: state.record };
    }
    @Post('recovery-ack')
    async acknowledgeRecovery(@Body() body: unknown) {
        const parsed = recoveryUsageAckRequest.safeParse(body);
        if (!parsed.success) throw new BadRequestException('Invalid recovery receipt request');
        const request = parsed.data;
        try {
            return await coreManagement.run(async () => {
                const before = await this.recoveryContext(request);
                const original = await readUsageArchiveFile();
                if (!original) throw new Error('Recovery receipt source is missing');
                const source = recoveryAckJournal(original, request);
                // The panel commits and archives its SQL decision before using
                // this authenticated endpoint. Node verifies exact native state;
                // it cannot infer or approve the panel's financial decision.
                if (!source.alreadyAcknowledged)
                    await this.perform(request.receipt, request.coreProcessId);
                const after = await this.recoveryContext(request);
                if (after.pid !== before.pid) throw new Error('Recovery core restarted');
                const updated = await readUsageArchiveFile();
                if (!updated) throw new Error('Recovery receipt acknowledgement is missing');
                const verified = recoveryAckJournal(updated, request);
                if (!verified.alreadyAcknowledged)
                    throw new Error('Recovery receipt acknowledgement was not persisted');
                return {
                    response: recoveryUsageAckReply.parse({
                        version: RECOVERY_USAGE_ACK,
                        requestId: request.requestId,
                        generation: request.generation,
                        coreProcessId: request.coreProcessId,
                        instance: request.instance,
                        previous: request.previous,
                        decisionDigest: request.decisionDigest,
                        sourceDigest: request.sourceDigest,
                        alreadyAcknowledged: source.alreadyAcknowledged,
                        acknowledgement: {
                            stream: request.receipt.stream,
                            sequence: request.receipt.sequence,
                            acknowledged: true,
                        },
                        journal: verified.journal,
                        recovery: after.record,
                    }),
                };
            });
        } catch {
            throw new ServiceUnavailableException(
                'Recovery receipt cannot be verified; retain the same source and retry',
            );
        }
    }
    @Post('recovery-quiescence')
    async quiescenceRecovery(@Body() body: unknown) {
        const parsed = recoveryUsageSampleRequest.safeParse(body);
        if (!parsed.success) throw new BadRequestException('Invalid recovery quiescence request');
        const request = parsed.data;
        try {
            return await coreManagement.run(async () => {
                const before = await this.recoveryContext(request);
                const original = await readUsageArchiveFile();
                if (!original) throw Error('Recovery journal is missing');
                const witness = await readRecoveryQuiescence(request, original);
                const after = await this.recoveryContext(request);
                if (after.pid !== before.pid) throw Error('Recovery core restarted');
                return {
                    response: recoveryQuiescenceReplySchema.parse({
                        witness,
                        journal: usageJournalHead(original),
                    }),
                };
            });
        } catch {
            throw new ServiceUnavailableException('Recovery quiescence cannot be verified');
        }
    }
    @Post('recovery-sample')
    async sampleRecovery(@Body() body: unknown) {
        const parsed = recoveryUsageSampleRequest.safeParse(body);
        if (!parsed.success) throw new BadRequestException('Invalid recovery sample request');
        const request = parsed.data;
        try {
            return await coreManagement.run(async () => {
                const before = await this.recoveryContext(request);
                const original = await readUsageArchiveFile();
                if (!original) throw Error('Recovery sample source is missing');
                const initial = recoverySampleJournal(original, request);
                let sampled: Awaited<ReturnType<typeof this.perform>>['response'] | null = null;
                if (!initial.frame)
                    sampled = (await this.perform(request.receipt, request.coreProcessId)).response;
                const after = await this.recoveryContext(request);
                if (before.pid !== after.pid) throw Error('Recovery core restarted');
                const updated = await readUsageArchiveFile();
                if (!updated) throw Error('Recovery sample was not persisted');
                const result = recoverySampleJournal(updated, request);
                if (
                    !result.frame ||
                    (sampled && (!('stats' in sampled) || sampled.digest !== result.frame.digest))
                )
                    throw Error('Recovery sample differs from its persisted frame');
                if (sampled && result.frame.stats.length === 0) {
                    await persistRecoveryQuiescence(
                        request,
                        result.frame,
                        after.record,
                        result.journalDigest,
                    );
                    const final = await this.recoveryContext(request);
                    if (final.pid !== before.pid) throw Error('Recovery core restarted');
                }
                return {
                    response: recoveryUsageSampleReply.parse({
                        version: RECOVERY_USAGE_SAMPLE,
                        requestId: request.requestId,
                        generation: request.generation,
                        coreProcessId: request.coreProcessId,
                        instance: request.instance,
                        previous: request.previous,
                        preparationDigest: request.preparationDigest,
                        sourceDigest: request.sourceDigest,
                        retainedDigest: request.retainedDigest,
                        alreadyCaptured: !!initial.frame,
                        journalDigest: result.journalDigest,
                        frame: result.frame,
                        recovery: after.record,
                    }),
                };
            });
        } catch {
            throw new ServiceUnavailableException(
                'Recovery sample cannot be verified; retain the prepared request and retry',
            );
        }
    }
}
