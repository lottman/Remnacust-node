import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { CORE_INCARNATION } from './core-incarnation';

export const QUOTA_RECOVERY_FENCE = 'remnacust-quota-recovery-fence-v1';
export const QUOTA_RECOVERY_FILE = '/var/lib/remnanode/quota/recovery.json';
export const QUOTA_RECOVERY_STATUS = '/var/lib/remnanode/quota/recovery.status.json';
const canonicalUuid = z
    .uuid()
    .refine((value) => value === value.toLowerCase() && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sequence = z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .refine((value) => BigInt(value) <= 9223372036854775807n);
const recoveryFenceBase = z.strictObject({
    version: z.literal(QUOTA_RECOVERY_FENCE),
    generation: canonicalUuid,
    token: canonicalUuid,
    state: z.enum(['FENCED', 'RELEASED']),
    sequence,
    previous: digest.nullable(),
    digest,
});
export const recoveryFenceSchema = recoveryFenceBase.refine(
    (value) =>
        recoveryFenceDigest(value) === value.digest &&
        (value.sequence === '1') === (value.previous === null) &&
        !(value.state === 'RELEASED' && value.sequence === '1'),
);
export type RecoveryFence = z.infer<typeof recoveryFenceBase>;
export type RecoveryFenceState = {
    version: typeof QUOTA_RECOVERY_FENCE;
    record: RecoveryFence | null;
};
export const recoveryFenceRequest = z.strictObject({
    generation: canonicalUuid,
    requestId: canonicalUuid,
    coreProcessId: canonicalUuid,
    instance: canonicalUuid.nullable(),
    previous: digest.nullable(),
});

export function recoveryFenceDigest(value: Omit<RecoveryFence, 'digest'>) {
    return createHash('sha256')
        .update(
            [
                value.version,
                value.generation,
                value.token,
                value.state,
                value.sequence,
                value.previous ?? '-',
                '',
            ].join('\n'),
        )
        .digest('hex');
}

export async function privateRead(file: string): Promise<Buffer | null> {
    let before;
    try {
        before = await lstat(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
    const parent = await lstat(dirname(file));
    const uid = process.getuid?.();
    if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.size > 8192 ||
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        (process.platform !== 'win32' &&
            ((before.mode & 0o077) !== 0 ||
                (parent.mode & 0o077) !== 0 ||
                before.uid !== uid ||
                parent.uid !== uid))
    )
        throw new Error('Invalid private recovery state');
    const handle = await open(
        file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
        const stat = await handle.stat();
        if (
            !stat.isFile() ||
            stat.size > 8192 ||
            stat.ino !== before.ino ||
            stat.dev !== before.dev
        )
            throw new Error('Recovery state changed while opening');
        const bytes = Buffer.alloc(Math.min(stat.size + 1, 8193));
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 8192) throw new Error('Recovery state is too large');
        return bytes.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

export async function readRecoveryFence(file = QUOTA_RECOVERY_FILE): Promise<RecoveryFence | null> {
    const bytes = await privateRead(join(dirname(file), 'recovery-required.json'));
    const required =
        bytes === null ? null : recoveryFenceSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (required && (required.state !== 'FENCED' || required.sequence !== '1'))
        throw new Error('Invalid immutable recovery requirement');
    let record: RecoveryFence | null;
    try {
        const data = await privateRead(file);
        record =
            data === null ? null : recoveryFenceSchema.parse(JSON.parse(data.toString('utf8')));
    } catch (error) {
        if (required) return required;
        throw error;
    }
    if (!required && record) throw new Error('Missing immutable recovery requirement');
    if (required && (!record || (record.sequence === '1' && record.digest !== required.digest)))
        return required;
    return record;
}

export async function readRecoveryFenceState(
    process: { up: boolean; pid: number | null },
    core: string | null,
    file = QUOTA_RECOVERY_FILE,
    status = QUOTA_RECOVERY_STATUS,
): Promise<RecoveryFenceState> {
    if (!process.up || !process.pid || !core)
        throw new Error('No live recovery fence acknowledgement');
    const before = await readRecoveryFence(file);
    const bytes = await privateRead(status);
    if (!bytes) throw new Error('Recovery fence is not acknowledged');
    const ack = z
        .strictObject({
            version: z.literal(QUOTA_RECOVERY_FENCE),
            pid: z.int().positive(),
            coreProcessId: canonicalUuid,
            coreIncarnation: z.literal(CORE_INCARNATION),
            state: z.enum(['NONE', 'FENCED', 'RELEASED']),
            digest: digest.nullable(),
        })
        .parse(JSON.parse(bytes.toString('utf8')));
    const after = await readRecoveryFence(file);
    if (
        before?.digest !== after?.digest ||
        ack.pid !== process.pid ||
        ack.coreProcessId !== core ||
        ack.digest !== (before?.digest ?? null) ||
        ack.state !== (before?.state ?? 'NONE')
    )
        throw new Error('Recovery fence acknowledgement changed');
    return { version: QUOTA_RECOVERY_FENCE, record: before };
}

// Only a pause is exposed to the panel at this stage. Resumption requires the
// separate economic reconciliation workflow, never an ordinary policy update.
export async function publishPrivateRecord(
    file: string,
    record: unknown,
    validate: () => Promise<void>,
) {
    const parent = dirname(file),
        temporary = join(parent, '.recovery-' + randomUUID());
    const info = await lstat(parent),
        uid = process.getuid?.();
    if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== uid)) ||
        Buffer.byteLength(JSON.stringify(record) + '\n') > 8192
    )
        throw new Error('Invalid private recovery record');
    try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(JSON.stringify(record) + '\n');
            await handle.sync();
        } finally {
            await handle.close();
        }
        await validate();
        await rename(temporary, file);
        const directory = await open(parent, 'r');
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    } finally {
        await rm(temporary, { force: true });
    }
}

export async function persistRecoveryFence(
    request: z.infer<typeof recoveryFenceRequest>,
    file = QUOTA_RECOVERY_FILE,
): Promise<RecoveryFence> {
    const old = await readRecoveryFence(file);
    if (old?.token === request.requestId) {
        if (
            old.state !== 'FENCED' ||
            old.generation !== request.generation ||
            old.previous !== request.previous
        )
            throw new Error('Recovery request identity conflicts');
        return old;
    }
    if ((old?.digest ?? null) !== request.previous) throw new Error('Recovery fence changed');
    const value: Omit<RecoveryFence, 'digest'> = {
        version: QUOTA_RECOVERY_FENCE,
        generation: request.generation,
        token: request.requestId,
        state: 'FENCED',
        sequence: (BigInt(old?.sequence ?? '0') + 1n).toString(),
        previous: request.previous,
    };
    const record = recoveryFenceSchema.parse({ ...value, digest: recoveryFenceDigest(value) });
    const parent = dirname(file),
        info = await lstat(parent),
        uid = process.getuid?.();
    if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== uid))
    )
        throw new Error('Invalid private recovery directory');
    if (!old) {
        const requirement = join(parent, 'recovery-required.json');
        // Publish a permanent restrictive first record before the mutable one.
        // A torn first write or later lost file then falls back to PAUSED.
        await publishPrivateRecord(requirement, record, async () => {
            if (await privateRead(requirement)) throw new Error('Recovery requirement changed');
        });
    }
    await publishPrivateRecord(file, record, async () => {
        // The caller serializes all core management and policy operations.
        if ((await readRecoveryFence(file))?.digest !== (old?.digest ?? record.digest))
            throw new Error('Recovery fence changed');
    });
    return record;
}
