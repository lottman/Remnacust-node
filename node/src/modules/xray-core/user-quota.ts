import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname } from 'node:path';

export const USER_QUOTA_VERSION = 'remnacust-user-quota-reserves-v1';
export const USER_QUOTA_SCALE = 1_000_000_000;
export const USER_QUOTA_MAX_FACTOR = 100 * USER_QUOTA_SCALE;
export const USER_QUOTA_REQUIRED_FILE = '/var/lib/remnanode/quota/user-quota-required';
export const USER_QUOTA_CHECKPOINT_HEADER = 'REMNACUST-CORE-STATE-2-USER-QUOTA\n';
const LEGACY_CHECKPOINT_HEADER = 'REMNACUST-CORE-STATE-1\n';
const CHECKPOINT = '/var/lib/remnacust/run/core-state/checkpoint.pb';

async function prefix(file: string, limit: number, maxSize: number): Promise<Buffer | null> {
    let info;
    try {
        info = await lstat(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
    const parent = await lstat(dirname(file));
    const uid = process.getuid?.();
    if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > maxSize ||
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        (process.platform !== 'win32' && (info.mode & 0o077 || parent.mode & 0o077)) ||
        (uid !== undefined && (info.uid !== uid || parent.uid !== uid))
    )
        throw new Error('User quota state is not a private regular file');
    for (let current = dirname(dirname(file)); ; current = dirname(current)) {
        const entry = await lstat(current);
        if (!entry.isDirectory() || entry.isSymbolicLink())
            throw new Error('Untrusted user quota state ancestor');
        if (dirname(current) === current) break;
    }
    const handle = await open(
        file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
        const opened = await handle.stat();
        if (
            !opened.isFile() ||
            opened.dev !== info.dev ||
            opened.ino !== info.ino ||
            opened.size > maxSize
        )
            throw new Error('User quota state changed while opening');
        const buffer = Buffer.alloc(limit);
        let count = 0;
        while (count < buffer.length) {
            const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
            if (bytesRead === 0) break;
            count += bytesRead;
        }
        return buffer.subarray(0, count);
    } finally {
        await handle.close();
    }
}

export async function userQuotaRequiredOnDisk(
    marker = USER_QUOTA_REQUIRED_FILE,
    checkpoint = CHECKPOINT,
): Promise<boolean> {
    const [requirement, cached] = await Promise.all([
        prefix(marker, 129, 128),
        prefix(checkpoint, 16 * 1024 * 1024 + 129, 16 * 1024 * 1024 + 128),
    ]);
    if (requirement && requirement.toString('utf8') !== USER_QUOTA_VERSION + '\n')
        throw new Error('Unknown user quota requirement marker');
    let cachedRequirement = false;
    if (cached) {
        const text = cached.toString('utf8');
        const header = text.startsWith(USER_QUOTA_CHECKPOINT_HEADER)
            ? USER_QUOTA_CHECKPOINT_HEADER
            : LEGACY_CHECKPOINT_HEADER;
        if (!text.startsWith(header) || !/^([a-f0-9]{64})\n/.test(text.slice(header.length)))
            throw new Error('Unknown private checkpoint header');
        const checksum = cached.subarray(header.length, header.length + 64).toString('ascii');
        const payload = cached.subarray(header.length + 65);
        if (
            payload.length > 16 * 1024 * 1024 ||
            createHash('sha256').update(payload).digest('hex') !== checksum
        )
            throw new Error('Private checkpoint integrity check failed');
        cachedRequirement = header === USER_QUOTA_CHECKPOINT_HEADER;
    }
    return !!requirement || cachedRequirement;
}
