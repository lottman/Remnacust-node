import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const PORT_PLAN_CAPABILITY = 'remnacust-live-ports-v1';
export const PORT_PLAN_STATE_FILE = '/var/lib/remnanode/core/port-plan-state.json';
export type PortPlanDelivery = { epoch: string; owner: string };
export type PortPlanTarget = { revision: string; enabled: boolean; delivery?: PortPlanDelivery };
export type PortPlanState = PortPlanTarget & {
    version: 1 | 2;
    required: boolean;
    appliedRevision: string | null;
    pluginDirty?: boolean;
    appliedInputsHash?: string;
    desiredPluginHash?: string;
};

const validRevision = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^[1-9][0-9]{0,18}$/.test(value) &&
    BigInt(value) <= 9223372036854775807n;

export function parsePortPlanState(encoded: string): PortPlanState {
    const state = JSON.parse(encoded) as PortPlanState;
    if (
        !state ||
        ![1, 2].includes(state.version) ||
        (state.version === 2 && !validDelivery(state.delivery)) ||
        (state.version === 1 && state.delivery !== undefined) ||
        (state.pluginDirty !== undefined &&
            (state.version !== 2 || typeof state.pluginDirty !== 'boolean')) ||
        (state.appliedInputsHash !== undefined &&
            (state.version !== 2 || !/^[a-f0-9]{64}$/.test(state.appliedInputsHash))) ||
        (state.desiredPluginHash !== undefined &&
            (state.version !== 2 || !/^[a-f0-9]{64}$/.test(state.desiredPluginHash))) ||
        !validRevision(state.revision) ||
        typeof state.enabled !== 'boolean' ||
        typeof state.required !== 'boolean' ||
        (state.appliedRevision !== null &&
            (!validRevision(state.appliedRevision) ||
                BigInt(state.appliedRevision) > BigInt(state.revision))) ||
        (state.enabled && !state.required) ||
        (state.appliedRevision === state.revision && state.required !== state.enabled)
    )
        throw new Error('Invalid saved port-plan requirement');
    return state;
}

export function portPlanInputsHash(
    config: unknown,
    integrations?: unknown,
    metadata?: unknown,
): string {
    const encoded = JSON.stringify(
        { config, integrations: integrations ?? null, metadata: metadata ?? null },
        (_key, value) =>
            value && typeof value === 'object' && !Array.isArray(value)
                ? Object.fromEntries(
                      Object.keys(value)
                          .sort()
                          .map((key) => [key, value[key]]),
                  )
                : value,
    );
    return createHash('sha256').update(encoded).digest('hex');
}

function validDelivery(value: unknown): value is PortPlanDelivery {
    const delivery = value as PortPlanDelivery | null;
    return (
        !!delivery &&
        validRevision(delivery.epoch) &&
        typeof delivery.owner === 'string' &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
            delivery.owner,
        )
    );
}

export class PortPlanStateStore {
    constructor(private readonly filename = PORT_PLAN_STATE_FILE) {}

    private async verifyDirectory(create = false): Promise<void> {
        const parent = dirname(this.filename);
        if (create) await mkdir(parent, { recursive: true, mode: 0o700 });
        const info = await lstat(parent),
            uid = process.getuid?.();
        if (
            !info.isDirectory() ||
            info.isSymbolicLink() ||
            (process.platform !== 'win32' && info.mode & 0o077) ||
            (uid !== undefined && info.uid !== uid)
        )
            throw new Error('Port-plan state directory must be private and owned by the node');
        for (let current = dirname(parent); ; current = dirname(current)) {
            const entry = await lstat(current);
            if (!entry.isDirectory() || entry.isSymbolicLink())
                throw new Error('Untrusted port-plan state ancestor');
            if (dirname(current) === current) break;
        }
    }

    async read(): Promise<PortPlanState | null> {
        let info;
        try {
            info = await lstat(this.filename);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
        await this.verifyDirectory();
        const uid = process.getuid?.();
        if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            info.size > 1024 ||
            (process.platform !== 'win32' && info.mode & 0o077) ||
            (uid !== undefined && info.uid !== uid)
        )
            throw new Error('Port-plan state must be a private regular file');
        const file = await open(
            this.filename,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        );
        try {
            const opened = await file.stat();
            if (
                !opened.isFile() ||
                opened.dev !== info.dev ||
                opened.ino !== info.ino ||
                opened.size > 1024
            )
                throw new Error('Port-plan state changed while opening');
            const buffer = Buffer.alloc(1025);
            let count = 0;
            while (count < buffer.length) {
                const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
                if (!bytesRead) break;
                count += bytesRead;
            }
            if (count > 1024) throw new Error('Port-plan state exceeds its limit');
            return parsePortPlanState(buffer.subarray(0, count).toString('utf8'));
        } finally {
            await file.close();
        }
    }

    async begin(target: PortPlanTarget): Promise<void> {
        if (!validRevision(target.revision) || typeof target.enabled !== 'boolean')
            throw new Error('Invalid port-plan target');
        const previous = await this.read();
        if (target.delivery !== undefined && !validDelivery(target.delivery))
            throw new Error('Invalid port-plan delivery owner');
        if (
            previous?.delivery &&
            (!target.delivery ||
                BigInt(target.delivery.epoch) < BigInt(previous.delivery.epoch) ||
                (target.delivery.epoch === previous.delivery.epoch &&
                    (target.delivery.owner !== previous.delivery.owner ||
                        target.revision !== previous.revision ||
                        target.enabled !== previous.enabled)))
        )
            throw new Error('An older delivery owner cannot replace the saved port plan');
        if (
            previous &&
            (BigInt(target.revision) < BigInt(previous.revision) ||
                (target.revision === previous.revision && target.enabled !== previous.enabled))
        )
            throw new Error('An older port-plan target cannot replace the saved plan');
        // Retain the old requirement until a disabling configuration is really
        // acknowledged. A lost ACK cannot make an incompatible rollback safe.
        await this.write({
            version: target.delivery ? 2 : 1,
            ...target,
            required: !!previous?.required || target.enabled,
            appliedRevision: previous?.appliedRevision ?? null,
            ...(previous?.pluginDirty ? { pluginDirty: true } : {}),
            ...(previous?.desiredPluginHash
                ? { desiredPluginHash: previous.desiredPluginHash }
                : {}),
            ...(previous?.appliedInputsHash
                ? { appliedInputsHash: previous.appliedInputsHash }
                : {}),
        });
    }

    async markPluginDirty(target: PortPlanTarget): Promise<void> {
        const current = await this.read();
        if (
            !current ||
            !target.delivery ||
            current.delivery?.epoch !== target.delivery.epoch ||
            current.delivery.owner !== target.delivery.owner ||
            current.revision !== target.revision ||
            current.enabled !== target.enabled
        )
            throw new Error('Plugin delivery owner is no longer current');
        await this.write({ ...current, pluginDirty: true });
    }

    async notePluginInputs(target: PortPlanTarget, hash: string): Promise<void> {
        const current = await this.read();
        if (
            !current ||
            !target.delivery ||
            current.delivery?.epoch !== target.delivery.epoch ||
            current.delivery.owner !== target.delivery.owner ||
            current.revision !== target.revision ||
            current.enabled !== target.enabled
        )
            throw new Error('Plugin delivery owner is no longer current');
        if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid plugin input hash');
        if (current.desiredPluginHash !== hash)
            await this.write({ ...current, desiredPluginHash: hash, pluginDirty: true });
    }

    async complete(target: PortPlanTarget, inputsHash?: string): Promise<void> {
        const current = await this.read();
        if (
            !current ||
            current.revision !== target.revision ||
            current.enabled !== target.enabled ||
            current.delivery?.epoch !== target.delivery?.epoch ||
            current.delivery?.owner !== target.delivery?.owner
        )
            throw new Error('The applied port-plan target is no longer current');
        if (inputsHash !== undefined && (!target.delivery || !/^[a-f0-9]{64}$/.test(inputsHash)))
            throw new Error('Invalid applied configuration hash');
        const acknowledged = { ...current };
        delete acknowledged.pluginDirty;
        delete acknowledged.appliedInputsHash;
        await this.write({
            ...acknowledged,
            required: target.enabled,
            appliedRevision: target.revision,
            ...(inputsHash ? { appliedInputsHash: inputsHash } : {}),
        });
    }

    private async write(state: PortPlanState): Promise<void> {
        await this.verifyDirectory(true);
        const temporary = join(dirname(this.filename), '.port-plan-' + randomUUID());
        try {
            const file = await open(temporary, 'wx', 0o600);
            try {
                await file.writeFile(JSON.stringify(state) + '\n');
                await file.sync();
            } finally {
                await file.close();
            }
            await rename(temporary, this.filename);
            if (process.platform !== 'win32') {
                const directory = await open(
                    dirname(this.filename),
                    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
                );
                try {
                    await directory.sync();
                } finally {
                    await directory.close();
                }
            }
        } finally {
            await rm(temporary, { force: true });
        }
    }
}
