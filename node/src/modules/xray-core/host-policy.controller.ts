import { normalizeDestinationRule, isIpDestinationRule } from '@common/utils/destination-rule';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { z } from 'zod';

import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Post,
    ServiceUnavailableException,
    UseGuards,
} from '@nestjs/common';

import { JwtDefaultGuard } from '@common/guards/jwt-guards';

import { XrayProcessService } from './xray-process.service';

const VERSION = 'xera-host-policy-v2';
const DIRECTORY = '/var/lib/remnanode';
const FILE = `${DIRECTORY}/host-policy.json`;
const owner = z.string().regex(/^[1-9][0-9]{0,18}$/);
const group = z
    .object({
        bytesPerSecond: z.int().min(0).max(1_250_000_000),
        totalBytesPerSecond: z.int().min(0).max(1_250_000_000),
        blockedOwners: z.record(owner, z.boolean()),
        blockAll: z.boolean(),
    })
    .strict();
export const hostPolicySchema = z
    .object({
        version: z.literal(VERSION),
        protectedInbounds: z.array(z.string().min(1).max(255)).max(10000),
        hosts: z.record(
            z.string().regex(/^[a-f0-9]{32}$/),
            z
                .object({
                    inboundTag: z.string().min(1).max(255),
                    allowedIdentities: z.record(
                        z.string().regex(/^[1-9][0-9]{0,18}~[a-f0-9]{24}~h[a-f0-9]{32}$/),
                        z.boolean(),
                    ),
                    groups: z.array(z.string().min(1).max(200)).max(200),
                    domainMode: z.enum(['OFF', 'ALLOW_ONLY', 'DENY']),
                    domains: z.array(z.string().min(1).max(253).refine((value) => {
                        try { return normalizeDestinationRule(value) === value; } catch { return false; }
                    })).max(1000),
                })
                .strict(),
        ),
        groups: z.record(z.string().min(1).max(200), group),
    })
    .strict()
    .superRefine((policy, ctx) => {
        let count = 0;
        for (const [id, host] of Object.entries(policy.hosts)) {
            count += Object.keys(host.allowedIdentities).length;
            if (
                !policy.protectedInbounds.includes(host.inboundTag) ||
                host.groups.some((key) => !policy.groups[key]) ||
                Object.keys(host.allowedIdentities).some((key) => !key.endsWith('~h' + id))
            )
                ctx.addIssue({ code: 'custom', message: 'Invalid host policy reference' });
        }
        for (const group of Object.values(policy.groups))
            count += Object.keys(group.blockedOwners).length;
        if (
            count > 200000 ||
            Object.keys(policy.hosts).length > 10000 ||
            Object.keys(policy.groups).length > 10000
        )
            ctx.addIssue({ code: 'custom', message: 'Host policy too large' });
    });

@UseGuards(JwtDefaultGuard)
@Controller('xray/host-policy')
export class HostPolicyController {
    private pending: Promise<unknown> = Promise.resolve();
    private versionCache = { key: '', supported: false, destinationRulesSupported: false };
    constructor(private readonly xray: XrayProcessService) {}

    private async supported(): Promise<boolean> {
        try {
            const process = await this.xray.getStatus();
            const path = process.up && process.pid ? `/proc/${process.pid}/exe` : await realpath('/usr/local/bin/rw-core');
            const details = await stat(path);
            const key = `${path}:${details.ino}:${details.size}:${details.mtimeMs}`;
            if (key !== this.versionCache.key) {
                const binary = await readFile(path);
                this.versionCache = {
                    key,
                    supported: binary.includes(Buffer.from(VERSION)),
                    destinationRulesSupported: binary.includes(Buffer.from('xera-destination-rules-v1')),
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
        const policy = await readFile(FILE, 'utf8')
            .then((value) => JSON.parse(value))
            .catch(() => null);
        const applied = await readFile(`${DIRECTORY}/host-policy.status.json`, 'utf8')
            .then((value) => JSON.parse(value))
            .catch(() => null);
        const process = await this.xray.getStatus();
        return {
            response: {
                supported,
                destinationRulesSupported: supported && this.versionCache.destinationRulesSupported,
                version: VERSION,
                group: policy?.group ?? null,
                applied:
                    supported &&
                    process.up &&
                    applied?.pid === process.pid &&
                    !!policy &&
                    policy.generation === applied?.generation,
                expiresAt: policy?.expiresAt ?? null,
            },
        };
    }

    @Post()
    async update(@Body() body: unknown) {
        const result = this.pending.then(() => this.apply(body));
        this.pending = result.catch(() => undefined);
        return result;
    }
    private async apply(body: unknown) {
        const parsed = hostPolicySchema.safeParse(body);
        if (!parsed.success) {
            throw new BadRequestException('Invalid host policy');
        }
        if (!(await this.supported()))
            throw new ServiceUnavailableException(
                'Update Xray Core: server host limits are not supported',
            );
        const needsDestinationRules = Object.values(parsed.data.hosts).some((host) => host.domainMode !== 'OFF' && host.domains.some(isIpDestinationRule));
        if (needsDestinationRules && !this.versionCache.destinationRulesSupported)
            throw new ServiceUnavailableException('Update Xray Core: IP and CIDR host rules are not supported');
        const process = await this.xray.getStatus();
        if (process.up) {
            const [existing, applied] = await Promise.all([
                readFile(FILE, 'utf8').then(value => JSON.parse(value)).catch(() => null),
                readFile(`${DIRECTORY}/host-policy.status.json`, 'utf8').then(value => JSON.parse(value)).catch(() => null),
            ]);
            if (existing && applied && applied.pid === process.pid &&
                typeof existing.generation === 'string' && existing.generation === applied.generation &&
                Number.isFinite(existing.expiresAt) && existing.expiresAt > Date.now() + 30_000 &&
                (!needsDestinationRules || applied.destinationRules === 'xera-destination-rules-v1')) {
                const { generation: _generation, expiresAt: _expiresAt, ...content } = existing;
                if (isDeepStrictEqual(content, parsed.data))
                    return { response: { version: VERSION, supported: true, applied: true, unchanged: true } };
            }
        }
        const generation = randomUUID();
        await mkdir(DIRECTORY, { recursive: true, mode: 0o700 });
        const tmp = `${FILE}.${generation}.tmp`;
        await writeFile(
            tmp,
            JSON.stringify({
                ...parsed.data,
                version: VERSION,
                generation,
                expiresAt: Date.now() + 90_000,
            }),
            { mode: 0o600 },
        );
        await rename(tmp, FILE);
        const current = await this.xray.getStatus();
        if (!current.up)
            return {
                response: { version: VERSION, supported: true, staged: true, applied: false },
            };
        for (let attempt = 0; attempt < 20; attempt++) {
            const state = await readFile(`${DIRECTORY}/host-policy.status.json`, 'utf8')
                .then((value) => JSON.parse(value))
                .catch(() => null);
            if (state?.generation === generation && state?.pid === current.pid &&
                (!needsDestinationRules || state.destinationRules === 'xera-destination-rules-v1'))
                return { response: { version: VERSION, supported: true, applied: true } };
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new ServiceUnavailableException('Xray has not acknowledged the host policy');
    }
}
