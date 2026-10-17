import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { Injectable } from '@nestjs/common';

import { ProfileInput, ProfileAcknowledgement, validateProfileAcknowledgement } from './profile-input';
import { userQuotaRequiredOnDisk } from './user-quota';

const run = promisify(execFile);
const ROOT = '/var/lib/remnacust/run';
export const LIVE_CORE_CHECKPOINT = `${ROOT}/core-state/checkpoint.pb`;
const CAPABILITY = Buffer.from('remnacust-live-ports-v1');

@Injectable()
export class LiveCoreService {
    private capabilityCache = { key: '', supported: false };
    private userQuotaCore = '';
    private userQuotaEnabled = false;
    private profileCapabilityCache = { key: '', supported: false };

    async profilesSupported(binary: string): Promise<boolean> {
        const details = await stat(binary);
        if (!details.isFile() || details.size > 192 * 1024 * 1024)
            throw new Error('Invalid core executable size');
        const key = `${binary}:${details.dev}:${details.ino}:${details.size}:${details.mtimeMs}:${details.ctimeMs}`;
        if (key !== this.profileCapabilityCache.key) {
            const bytes = await readFile(binary);
            this.profileCapabilityCache = { key, supported:
                bytes.includes(Buffer.from('remnacust-profile-control-v1')) &&
                bytes.includes(Buffer.from('remnacust-profile-input-v1')) &&
                bytes.includes(Buffer.from('x-remnacust-profile-binding')) &&
                bytes.includes(Buffer.from('x-remnacust-retired-user-removal')) &&
                bytes.includes(Buffer.from('remnacust-profile-traffic-v1')),
            };
        }
        return this.profileCapabilityCache.supported;
    }

    hasUserQuotaRequirement(core: string | null): boolean {
        return !!core && this.userQuotaCore === core;
    }

    async requireUserQuota(binary: string, socket: string, core: string): Promise<void> {
        if (this.hasUserQuotaRequirement(core)) return;
        const { stdout } = await run(
            binary,
            [
                'api',
                'require-user-quota',
                `--server=unix:${socket}`,
                '--timeout=10',
                `--core=${core}`,
            ],
            { timeout: 15000, maxBuffer: 64 * 1024 },
        );
        const response = JSON.parse(stdout) as {
            hash?: unknown;
            generation?: unknown;
            coreProcessId?: unknown;
            userQuotaRequired?: unknown;
        };
        if (
            response.userQuotaRequired !== true ||
            response.coreProcessId !== core ||
            typeof response.hash !== 'string' ||
            !/^[a-f0-9]{64}$/.test(response.hash) ||
            typeof response.generation !== 'string' ||
            !/^\d+$/.test(response.generation)
        )
            throw new Error('The core did not acknowledge its persisted user quota requirement');
        this.userQuotaEnabled = true;
        this.userQuotaCore = core;
    }
    async supported(binary: string): Promise<boolean> {
        const details = await stat(binary);
        if (!details.isFile() || details.size > 192 * 1024 * 1024)
            throw new Error('Invalid core executable size');
        const key = `${binary}:${details.dev}:${details.ino}:${details.size}:${details.mtimeMs}:${details.ctimeMs}`;
        if (key !== this.capabilityCache.key)
            this.capabilityCache = {
                key,
                supported: (await readFile(binary)).includes(CAPABILITY),
            };
        return this.capabilityCache.supported;
    }

    async apply(binary: string, socket: string, config: Record<string, unknown>): Promise<void> {
        await this.withConfiguration(config, async (path) => {
            const { stdout } = await run(
                binary,
                ['api', 'reconcile', `--server=unix:${socket}`, '--timeout=20', path],
                {
                    timeout: 25_000,
                    maxBuffer: 64 * 1024,
                },
            );
            const acknowledgement = JSON.parse(stdout.trim()) as {
                hash?: unknown;
                generation?: unknown;
            };
            if (
                typeof acknowledgement.hash !== 'string' ||
                !/^[a-f0-9]{64}$/.test(acknowledgement.hash) ||
                typeof acknowledgement.generation !== 'string' ||
                !/^\d+$/.test(acknowledgement.generation)
            ) {
                throw new Error('The core did not acknowledge an applied runtime revision');
            }
        });
    }

    async prepareRestart(binary: string, config: Record<string, unknown>): Promise<void> {
        if (this.userQuotaEnabled || (await userQuotaRequiredOnDisk()))
            config = { ...config, remnacustUserQuotaRequired: true };
        await mkdir(join(ROOT, 'core-state'), { recursive: true, mode: 0o700 });
        await this.withConfiguration(config, async (path) => {
            await run(binary, ['api', 'cache-runtime', `--output=${LIVE_CORE_CHECKPOINT}`, path], {
                timeout: 25_000,
                maxBuffer: 64 * 1024,
            });
        });
    }

    async applyProfiles(binary: string, socket: string, input: ProfileInput): Promise<ProfileAcknowledgement> {
        let acknowledgement: ProfileAcknowledgement | undefined;
        await this.withConfiguration(
            input,
            async (path) => {
                const { stdout } = await run(
                    binary,
                    ['api', 'profile-apply', `--server=unix:${socket}`, '--timeout=20', path],
                    { timeout: 25_000, maxBuffer: 64 * 1024 },
                );
                acknowledgement = validateProfileAcknowledgement(JSON.parse(stdout), input, true);
            },
            16 * 1024 * 1024,
        );
        if (!acknowledgement) throw new Error('Missing profile delivery acknowledgement');
        return acknowledgement;
    }

    async prepareProfileRestart(binary: string, input: ProfileInput): Promise<void> {
        if (this.userQuotaEnabled || (await userQuotaRequiredOnDisk()))
            input = { ...input, root: { ...input.root, remnacustUserQuotaRequired: true } };
        await mkdir(join(ROOT, 'core-state'), { recursive: true, mode: 0o700 });
        await this.withConfiguration(
            input,
            async (path) => {
                const { stdout } = await run(
                    binary,
                    ['api', 'cache-profiles', `--output=${LIVE_CORE_CHECKPOINT}`, path],
                    { timeout: 25_000, maxBuffer: 64 * 1024 },
                );
                validateProfileAcknowledgement(JSON.parse(stdout), input, false);
            },
            16 * 1024 * 1024,
        );
    }

    async validateProfiles(binary: string, input: ProfileInput): Promise<void> {
        if (!(await this.profilesSupported(binary)))
            throw new Error('The selected core does not support independent profile graphs');
        await this.withConfiguration(input, async path => {
            const output = join(dirname(path), 'validation.pb');
            try {
                const { stdout } = await run(binary,
                    ['api', 'cache-profiles', `--output=${output}`, path],
                    { timeout: 25_000, maxBuffer: 64 * 1024 });
                validateProfileAcknowledgement(JSON.parse(stdout), input, false);
            } finally {
                await rm(output, { force: true });
            }
        }, 16 * 1024 * 1024);
    }

    private async withConfiguration(
        config: Record<string, unknown>,
        action: (path: string) => Promise<void>,
        limit = 4 * 1024 * 1024,
    ): Promise<void> {
        const encoded = JSON.stringify(config);
        if (Buffer.byteLength(encoded) > limit)
            throw new Error('Core configuration exceeds the live-control limit');
        await mkdir(ROOT, { recursive: true, mode: 0o700 });
        const directory = await mkdtemp(join(ROOT, '.live-core-'));
        const path = join(directory, 'configuration.json');
        try {
            const file = await open(path, 'wx', 0o600);
            try {
                await file.writeFile(encoded);
                await file.sync();
            } finally {
                await file.close();
            }
            await action(path);
        } finally {
            await rm(path, { force: true });
            await rmdir(directory);
        }
    }
}
