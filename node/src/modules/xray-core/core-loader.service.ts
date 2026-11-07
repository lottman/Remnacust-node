import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import prettyBytes from 'pretty-bytes';
import { z } from 'zod';

import { Injectable, Logger } from '@nestjs/common';

import { downloadFile } from '@common/utils/download-file';
import { formatExecutionTime, getTime } from '@common/utils/get-elapsed-time';
import { readCoreVersion } from '@common/utils/read-core-version';

import {
    CORE_FLAVOR_PATHS,
    CoreFlavor,
    requestedCoreFlavor,
    assertCoreFlavorConfiguration,
} from './core-flavor';
import { ManagedCoreStore, CoreIdentity } from './managed-core.store';

const CORE_LINK = '/usr/local/bin/rw-core';
const CORE_STOCK = '/usr/local/bin/xray';
const CORE_CUSTOM = '/usr/local/bin/xray-custom';
const CORE_STAGED = `${CORE_CUSTOM}.staged`;
const CORE_MARKER = '/usr/local/bin/.rw-core.json';

const TOTAL_TIMEOUT_MS = 15_000;
const run = promisify(execFile);

export interface CoreFlavorTarget {
    flavor: CoreFlavor;
    binary: CoreIdentity;
    changed: boolean;
    preserveOverride?: boolean;
}

const CoreSchema = z.object({
    core: z
        .object({
            url: z.url({ protocol: /^https$/ }),
            sha256: z.hash('sha256').transform((value) => value.toLowerCase()),
        })
        .optional(),
});

type ICore = NonNullable<z.infer<typeof CoreSchema>['core']>;

interface ICoreMarker {
    url: string;
    sha256: string;
    size: number;
    mtimeMs: number;
    version: string;
    installedAt: string;
}

@Injectable()
export class CoreLoaderService {
    constructor(private readonly managed: ManagedCoreStore) {}
    private readonly logger = new Logger(CoreLoaderService.name);
    private readonly customIdentities = new Map<string, boolean>();

    public async prepare(geodata: unknown): Promise<void> {
        const target = await this.inspectFlavor(geodata);
        if (target) {
            await this.verifyFlavorPolicy(target.binary.path);
            const state = await this.managed.load();
            await this.managed.select({
                mode: target.preserveOverride ? state.mode : 'bundled',
                paused: state.paused,
                binary: target.binary,
            });
            return;
        }
        if (await this.managed.applyOverride()) return;
        const parsed = CoreSchema.safeParse(geodata ?? {});

        if (!parsed.success) {
            this.logger.warn(
                `Invalid "core" section: ${parsed.error.issues
                    .map((issue) => `${issue.path.join('.')} ${issue.message}`)
                    .join('; ')}`,
            );
            throw new Error('Invalid custom core configuration');
        }

        const { core } = parsed.data;

        if (!core) {
            await this.restoreStock();
            return;
        }

        if (await this.isInstalled(core)) return;

        await this.install(core);
    }

    public async inspectFlavor(
        geodata: unknown,
        config?: Record<string, unknown>,
    ): Promise<CoreFlavorTarget | undefined> {
        const flavor = requestedCoreFlavor(geodata);
        if (flavor === undefined) return undefined;
        if (config) assertCoreFlavorConfiguration(flavor, config);
        const state = await this.managed.load();
        let binary = await this.managed.identity(CORE_FLAVOR_PATHS[flavor]);
        const current = await this.managed.identity();
        let preserveOverride = false;
        if (state.binary && !Object.values(CORE_FLAVOR_PATHS).includes(state.binary.path)) {
            const installed = await this.managed.identity(state.binary.path);
            if (installed.sha256 !== state.binary.sha256)
                throw new Error('Managed core integrity check failed');
            if (
                installed.sha256 !== binary.sha256 &&
                (flavor !== 'custom' || !(await this.isCustomBinary(installed)))
            )
                throw new Error(
                    'Return the managed core to profile mode before applying the global flavor',
                );
            binary = installed;
            preserveOverride = true;
        }
        return { flavor, binary, changed: binary.sha256 !== current.sha256, preserveOverride };
    }

    public async acceptsFlavor(geodata: unknown, binary: CoreIdentity): Promise<boolean> {
        const flavor = requestedCoreFlavor(geodata);
        if (flavor === undefined) return true;
        const bundled = await this.managed.identity(CORE_FLAVOR_PATHS[flavor]);
        return (
            binary.sha256 === bundled.sha256 ||
            (flavor === 'custom' && (await this.isCustomBinary(binary)))
        );
    }

    private async isCustomBinary(binary: CoreIdentity): Promise<boolean> {
        if (!/\bRemnacust(?:-|\s)/.test(binary.version)) return false;
        const cached = this.customIdentities.get(binary.sha256);
        if (cached !== undefined) return cached;
        const details = await stat(binary.path);
        if (!details.isFile() || details.size > 192 * 1024 * 1024) return false;
        const bytes = await readFile(binary.path);
        const custom =
            bytes.includes(Buffer.from('xera-http')) &&
            (bytes.includes(Buffer.from('xera-host-policy-v2')) ||
                bytes.includes(Buffer.from('xera-host-policy-v1'))) &&
            createHash('sha256').update(bytes).digest('hex') === binary.sha256;
        if (this.customIdentities.size >= 16) this.customIdentities.clear();
        this.customIdentities.set(binary.sha256, custom);
        return custom;
    }

    public async verifyFlavorPolicy(binary: string): Promise<void> {
        try {
            await run(
                process.execPath,
                [
                    '-e',
                    "require('/etc/s6-overlay/scripts/core-boot.cjs').verifyCorePolicy(process.argv[1])",
                    binary,
                ],
                { timeout: 15_000, maxBuffer: 16 * 1024 },
            );
        } catch {
            throw new Error(
                'The selected core cannot safely preserve the saved policy, quotas or port plan',
            );
        }
    }

    public async flavors(selected: CoreIdentity | null, running: CoreIdentity | null) {
        const identities = await Promise.all(
            Object.entries(CORE_FLAVOR_PATHS).map(async ([flavor, path]) => ({
                flavor: flavor as CoreFlavor,
                binary: await this.managed.identity(path).catch(() => null),
            })),
        );
        const classify = async (identity: CoreIdentity | null): Promise<CoreFlavor | null> => {
            if (!identity) return null;
            return (
                identities.find((item) => item.binary?.sha256 === identity.sha256)?.flavor ??
                ((await this.isCustomBinary(identity).catch(() => false)) ? 'custom' : null)
            );
        };
        return {
            supportedFlavors: identities
                .filter((item) => item.binary !== null)
                .map((item) => item.flavor),
            selectedFlavor: await classify(selected),
            runningFlavor: await classify(running),
        };
    }

    private async isInstalled(core: ICore): Promise<boolean> {
        try {
            const marker = JSON.parse(await readFile(CORE_MARKER, 'utf8')) as ICoreMarker;

            if (marker.url !== core.url) {
                this.logger.log('Configured url changed, re-downloading.');
                return false;
            }

            if (marker.sha256 !== core.sha256) {
                this.logger.log('Configured sha256 changed, re-downloading.');
                return false;
            }

            const stats = await stat(CORE_CUSTOM);

            if (stats.size !== marker.size || stats.mtimeMs !== marker.mtimeMs) {
                this.logger.warn('Installed binary no longer matches the marker.');
                return false;
            }

            return (await readlink(CORE_LINK).catch(() => null)) === CORE_CUSTOM;
        } catch {
            return false;
        }
    }

    private async install(core: ICore): Promise<void> {
        const ct = getTime();

        try {
            const { sha256, size } = await downloadFile(core.url, CORE_STAGED, {
                totalTimeoutMs: TOTAL_TIMEOUT_MS,
                expectedSha256: core.sha256,
            });

            await chmod(CORE_STAGED, 0o755);

            const { raw: version } = await readCoreVersion(CORE_STAGED);

            await rename(CORE_STAGED, CORE_CUSTOM);
            await this.pointLinkAt(CORE_CUSTOM);

            const stats = await stat(CORE_CUSTOM);

            await this.writeMarker({
                url: core.url,
                sha256,
                size: stats.size,
                mtimeMs: stats.mtimeMs,
                version,
                installedAt: new Date().toISOString(),
            });

            this.logger.log(
                `Installed "${version}" (${prettyBytes(size)}) in ${formatExecutionTime(ct)}`,
            );
        } catch {
            this.logger.error('Failed to install the configured custom core');

            await rm(CORE_STAGED, { force: true }).catch(() => void 0);
            throw new Error('Could not install the configured custom core');
        }
    }

    private async restoreStock(): Promise<void> {
        const current = await readlink(CORE_LINK).catch(() => null);

        if (current === null || current === CORE_STOCK) return;

        await this.pointLinkAt(CORE_STOCK);
        await rm(CORE_MARKER, { force: true }).catch(() => void 0);
        await rm(CORE_CUSTOM, { force: true }).catch(() => void 0);

        this.logger.warn('No core configured, rolled back to the bundled one.');
    }

    private async pointLinkAt(target: string): Promise<void> {
        const tmpLink = `${CORE_LINK}.tmp`;

        await rm(tmpLink, { force: true });
        await symlink(target, tmpLink);
        await rename(tmpLink, CORE_LINK);
    }

    private async writeMarker(marker: ICoreMarker): Promise<void> {
        await writeFile(CORE_MARKER, JSON.stringify(marker, null, 2));
    }
}
