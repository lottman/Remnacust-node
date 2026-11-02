import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MAX_CHECKPOINT = 16 * 1024 * 1024 + 128;

export function listenerReplacementRequired(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const failure = error as Error & {
        code?: unknown;
        signal?: unknown;
        killed?: unknown;
        stderr?: unknown;
        stdout?: unknown;
    };
    if (
        failure.code !== 1 || failure.signal != null || failure.killed === true ||
        typeof failure.stderr !== 'string' || Buffer.byteLength(failure.stderr) > 64 * 1024 ||
        (failure.stdout !== undefined && failure.stdout !== '')
    ) return false;
    const last = failure.stderr.trim().split(/\r?\n/).at(-1) ?? '';
    return /^runtime apply failed: rpc error: code = FailedPrecondition desc = Inbound [^\r\n]{1,200} changes its port or transport; create a separate port\/tag and retain this listener$/.test(last);
}

async function privateDirectory(filename: string): Promise<void> {
    const parent = dirname(filename), info = await lstat(parent), uid = process.getuid?.();
    if (!info.isDirectory() || info.isSymbolicLink() ||
        (process.platform !== 'win32' && (info.mode & 0o077)) ||
        (uid !== undefined && info.uid !== uid))
        throw new Error('Runtime checkpoint directory must be private and owned by the node');
    for (let current = dirname(parent); ; current = dirname(current)) {
        const entry = await lstat(current);
        if (!entry.isDirectory() || entry.isSymbolicLink())
            throw new Error('Untrusted runtime checkpoint ancestor');
        if (dirname(current) === current) break;
    }
}

async function snapshotCheckpoint(filename: string): Promise<Buffer> {
    await privateDirectory(filename);
    const info = await lstat(filename), uid = process.getuid?.();
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CHECKPOINT ||
        (process.platform !== 'win32' && (info.mode & 0o077)) ||
        (uid !== undefined && info.uid !== uid))
        throw new Error('Runtime checkpoint must be a private regular file');
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > MAX_CHECKPOINT)
            throw new Error('Runtime checkpoint changed while opening');
        const data = Buffer.alloc(MAX_CHECKPOINT + 1);
        let count = 0;
        while (count < data.length) {
            const { bytesRead } = await handle.read(data, count, data.length - count, count);
            if (!bytesRead) break;
            count += bytesRead;
        }
        const saved = data.subarray(0, count);
        const header = /^REMNACUST-CORE-STATE-(?:1|2-USER-QUOTA)\n([a-f0-9]{64})\n/.exec(saved.subarray(0, 128).toString('ascii'));
        if (count > MAX_CHECKPOINT || !header ||
            createHash('sha256').update(saved.subarray(header[0].length)).digest('hex') !== header[1])
            throw new Error('Runtime checkpoint integrity check failed');
        return saved;
    } finally {
        await handle.close();
    }
}

async function restoreCheckpoint(filename: string, data: Buffer): Promise<void> {
    await privateDirectory(filename);
    const temporary = join(dirname(filename), `.listener-rollback-${randomUUID()}`);
    try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(data);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temporary, filename);
        if (process.platform !== 'win32') {
            const directory = await open(dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY);
            try { await directory.sync(); } finally { await directory.close(); }
        }
    } finally {
        await rm(temporary, { force: true });
    }
}

export async function applyRuntimeUpdate(options: {
    apply: () => Promise<void>;
    requireLiveApply: boolean;
    checkpoint: string;
    validate: () => Promise<void>;
    prepare: () => Promise<void>;
    restart: () => Promise<void>;
    stop: () => Promise<void>;
}): Promise<boolean> {
    try {
        await options.apply();
        return false;
    } catch (error) {
        if (options.requireLiveApply || !listenerReplacementRequired(error)) throw error;
    }
    await options.validate();
    const previous = await snapshotCheckpoint(options.checkpoint);
    try {
        try {
            await options.prepare();
        } catch {
            await restoreCheckpoint(options.checkpoint, previous);
            throw new Error('Could not prepare the listener update; the running core was preserved');
        }
        try {
            await options.restart();
            return true;
        } catch {
            try {
                await options.stop();
                await restoreCheckpoint(options.checkpoint, previous);
                await options.restart();
            } catch {
                throw new Error('Listener update failed and automatic recovery did not complete; check the node');
            }
            throw new Error('Listener update failed; the previous running configuration was restored');
        }
    } finally {
        previous.fill(0);
    }
}
