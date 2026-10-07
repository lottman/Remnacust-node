import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
    chmod,
    copyFile,
    mkdir,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    stat,
    statfs,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { isIpDestinationRule } from '@common/utils/destination-rule';

const run = promisify(execFile);
export type CoreAction =
    | 'install'
    | 'rollback'
    | 'bundled'
    | 'profile'
    | 'start'
    | 'stop'
    | 'restart'
    | 'check';
export interface CoreRelease {
    url: string;
    sha256: string;
    build: string;
    arch: string;
}
export interface CoreIdentity {
    path: string;
    sha256: string;
    version: string;
}
export interface CoreSelection {
    mode: 'profile' | 'managed' | 'bundled';
    paused: boolean;
    binary?: CoreIdentity;
}
export interface CoreOperation {
    id: string;
    action: CoreAction;
    phase: string;
    status: 'running' | 'succeeded' | 'failed' | 'rolled-back';
    startedAt: string;
    finishedAt?: string;
    error?: string;
}
export interface CoreState extends CoreSelection {
    previous?: CoreSelection;
    recovery?: CoreSelection;
    operation?: CoreOperation;
    history: CoreOperation[];
}

/** One instance per node. No credentials or user configurations enter the journal. */
export class ManagedCoreStore {
    readonly root: string;
    readonly link: string;
    readonly stock: string;
    private state: CoreState = { mode: 'profile', paused: false, history: [] };
    private loaded?: Promise<void>;
    private identities = new Map<string, CoreIdentity>();
    constructor(
        root = '/var/lib/remnawave/core-manager',
        link = '/usr/local/bin/rw-core',
        stock = '/usr/local/bin/xray',
    ) {
        this.root = root;
        this.link = link;
        this.stock = stock;
    }
    async load(): Promise<CoreState> {
        this.loaded ??= this.initialize();
        await this.loaded;
        return structuredClone(this.state);
    }
    private async initialize() {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        try {
            this.state = JSON.parse(await readFile(join(this.root, 'state.json'), 'utf8'));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw new Error('Core journal is unreadable; restore it before changing the core');
        }
        if (this.state.operation?.status === 'running') {
            if (this.state.recovery) {
                Object.assign(this.state, this.state.recovery);
                if (this.state.binary) await this.activate(this.state.binary.path);
            }
            this.state.operation.status = 'failed';
            this.state.operation.phase = 'interrupted';
            this.state.operation.error =
                'Node restarted during the operation; previous selection restored. Check readiness.';
            this.state.operation.finishedAt = new Date().toISOString();
            delete this.state.recovery;
            await this.persist();
        }
    }
    async identity(path = this.link): Promise<CoreIdentity> {
        const info = await stat(path);
        const key = `${path}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
        const cached = this.identities.get(key);
        if (cached) return { ...cached };
        const resolved = await realpath(path);
        const digest = createHash('sha256');
        for await (const chunk of createReadStream(path)) digest.update(chunk);
        const { stdout } = await run(path, ['version'], { timeout: 5000, maxBuffer: 32_768 });
        const version = stdout.split('\n')[0].trim();
        if (!/^Xray\s/.test(version)) throw new Error('The executable is not an Xray core');
        const result = {
            path: resolved,
            sha256: digest.digest('hex'),
            version: version.slice(0, 300),
        };
        if (this.identities.size > 16) this.identities.clear();
        this.identities.set(key, result);
        return { ...result };
    }
    async snapshot(): Promise<CoreSelection> {
        const current = await this.identity();
        const path = join(this.root, current.sha256);
        if (current.path !== path) {
            try {
                await copyFile(current.path, path, constants.COPYFILE_EXCL);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
            if ((await this.identity(path)).sha256 !== current.sha256)
                throw new Error('Recovery snapshot integrity check failed');
        }
        await chmod(path, 0o755);
        return { mode: this.state.mode, paused: this.state.paused, binary: { ...current, path } };
    }
    async begin(id: string, action: CoreAction) {
        await this.load();
        if (this.state.operation?.id === id || this.state.history.some((op) => op.id === id))
            return false;
        if (this.state.operation?.status === 'running')
            throw new Error('Another core operation is running');
        const changesBinary = ['install', 'rollback', 'bundled', 'profile'].includes(action);
        if (changesBinary) {
            const space = await statfs(this.root);
            if (space.bavail * space.bsize < 192 * 1024 * 1024)
                throw new Error('At least 192 MiB of free disk space is required');
        }
        const recovery = changesBinary
            ? await this.snapshot()
            : { mode: this.state.mode, paused: this.state.paused, binary: this.state.binary };
        this.state.recovery = recovery;
        if (this.state.operation)
            this.state.history = [this.state.operation, ...this.state.history].slice(0, 30);
        this.state.operation = {
            id,
            action,
            phase: 'preparing',
            status: 'running',
            startedAt: new Date().toISOString(),
        };
        await this.persist();
        return true;
    }
    async phase(phase: string) {
        if (this.state.operation) this.state.operation.phase = phase;
        await this.persist();
    }
    async select(selection: CoreSelection) {
        this.state.mode = selection.mode;
        this.state.paused = selection.paused;
        this.state.binary = selection.binary;
        await this.persist(); // journal before changing the active link
        if (selection.binary) await this.activate(selection.binary.path);
    }
    async finish(status: CoreOperation['status'], error?: string) {
        if (!this.state.operation) throw new Error('No operation');
        if (
            status === 'succeeded' &&
            ['install', 'rollback', 'bundled', 'profile'].includes(this.state.operation.action)
        ) {
            this.state.previous = this.state.recovery;
        }
        this.state.operation.status = status;
        this.state.operation.phase = status;
        this.state.operation.finishedAt = new Date().toISOString();
        this.state.operation.error = error?.slice(0, 500);
        delete this.state.recovery;
        await this.persist();
        // Only manager-owned content-addressed files; retain active and rollback images.
        const keep = new Set([
            this.state.binary?.path,
            this.state.previous?.binary?.path,
            await realpath(this.link).catch(() => ''),
        ]);
        for (const name of await readdir(this.root)) {
            const path = join(this.root, name);
            if (/^[a-f0-9]{64}$/.test(name) && !keep.has(path))
                await rm(path, { force: true }).catch(() => undefined);
        }
    }
    async restore() {
        if (!this.state.recovery) throw new Error('No recovery snapshot');
        await this.select(this.state.recovery);
    }
    async applyOverride(): Promise<boolean> {
        await this.load();
        if (this.state.mode === 'profile') return false;
        if (!this.state.binary) throw new Error('Managed core selection has no binary');
        const found = await this.identity(this.state.binary.path);
        if (found.sha256 !== this.state.binary.sha256)
            throw new Error('Managed core integrity check failed');
        await this.activate(found.path);
        return true;
    }
    async activate(path: string) {
        const tmp = this.link + '.managed-tmp';
        await rm(tmp, { force: true });
        await symlink(path, tmp);
        await rename(tmp, this.link);
    }
    private async persist() {
        const path = join(this.root, 'state.json');
        await writeFile(path + '.tmp', JSON.stringify(this.state), { mode: 0o600 });
        await rename(path + '.tmp', path);
    }
}

export function validateCoreRelease(release: CoreRelease) {
    const url = new URL(release.url);
    const hosts = (process.env.REMNACUST_CORE_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim());
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash ||
        (url.port && url.port !== '443') ||
        !hosts.includes(url.hostname)
    ) {
        throw new Error('Core download host is not permitted');
    }
    if (!/^[a-f0-9]{64}$/.test(release.sha256) || !/^[\w.+-]{1,100}$/.test(release.build))
        throw new Error('Invalid release metadata');
    const architecture = process.arch === 'x64' ? 'amd64' : process.arch;
    if (release.arch !== architecture)
        throw new Error('Core architecture does not match this node');
}

export async function validateCoreConfig(
    binary: string,
    config: Record<string, unknown>,
    root: string,
) {
    const policy = await readFile('/var/lib/remnanode/host-policy.json', 'utf8')
        .then(
            (value) =>
                JSON.parse(value) as {
                    group?: string;
                    protectedInbounds?: string[];
                    version?: string;
                    hosts?: Record<string, { domainMode?: string; domains?: string[] }>;
                },
        )
        .catch(() => null);
    if (
        (policy?.group || policy?.protectedInbounds?.length) &&
        !(await readFile(binary)).includes(
            Buffer.from(
                policy?.version === 'xera-host-policy-v2'
                    ? 'xera-host-policy-v2'
                    : 'xera-host-policy-v1',
            ),
        )
    ) {
        throw new Error(
            'This node has active host limits; the selected core does not support their enforcement',
        );
    }
    if (
        Object.values(policy?.hosts ?? {}).some(
            (host) => host.domainMode !== 'OFF' && host.domains?.some(isIpDestinationRule),
        ) &&
        !(await readFile(binary)).includes(Buffer.from('xera-destination-rules-v1'))
    )
        throw new Error('This node has IP/CIDR host rules; the selected core cannot enforce them');
    if (!Array.isArray(config.inbounds) || config.inbounds.length === 0)
        throw new Error('Node has no loaded configuration; connect it to the panel first');
    const path = join(root, 'validation.json');
    try {
        await writeFile(path, JSON.stringify(config), { mode: 0o600 });
        await run(binary, ['run', '-test', '-config', path], {
            timeout: 20_000,
            maxBuffer: 128 * 1024,
        });
    } catch {
        throw new Error(
            'Core configuration validation failed; inspect the profile and core compatibility',
        );
    } finally {
        await rm(path, { force: true });
    }
}
