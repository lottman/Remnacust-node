import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { z } from 'zod';

export const USAGE_ARCHIVE_VERSION = 'remnacust-usage-archives-v1';
export const USAGE_JOURNAL_FILE = '/var/lib/remnanode/usage/receipt.json';
export const USAGE_JOURNAL_MAX_BYTES = 8 * 1024 * 1024 + 128;
export const USAGE_ARCHIVE_MAX_BYTES = 12 * 1024 * 1024;
export const usageArchiveRequest = z.strictObject({ generation: z.uuid(), requestId: z.uuid() });
const compress = promisify(gzip);

// Open one immutable file generation. Atomic ACK/rename may proceed without
// mixing bytes from different frames; no core API, counter reset or ACK is used.
export async function readUsageArchiveFile(file = USAGE_JOURNAL_FILE): Promise<Buffer | null> {
    const parent = dirname(file);
    for (let directory = parent; ; directory = dirname(directory)) {
        try {
            const info = await lstat(directory);
            if (!info.isDirectory() || info.isSymbolicLink())
                throw new Error('Invalid usage journal ancestor');
            if (
                directory === parent &&
                process.platform !== 'win32' &&
                ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
            )
                throw new Error('Usage journal directory is not private');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (dirname(directory) === directory) break;
    }
    let before;
    try {
        before = await lstat(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
    if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.size > USAGE_JOURNAL_MAX_BYTES ||
        (process.platform !== 'win32' &&
            ((before.mode & 0o077) !== 0 || before.uid !== process.getuid?.()))
    )
        throw new Error('Invalid private usage journal');
    const handle = await open(
        file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
        const opened = await handle.stat();
        if (
            !opened.isFile() ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            opened.size !== before.size ||
            (process.platform !== 'win32' &&
                ((opened.mode & 0o077) !== 0 || opened.uid !== process.getuid?.()))
        )
            throw new Error('Usage journal changed while opening');
        const data = Buffer.alloc(opened.size + 1);
        let length = 0;
        while (length < data.length) {
            const { bytesRead } = await handle.read(data, length, data.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
        }
        const after = await handle.stat();
        if (
            length !== opened.size ||
            after.size !== opened.size ||
            after.mtimeMs !== opened.mtimeMs ||
            after.ctimeMs !== opened.ctimeMs
        )
            throw new Error('Usage journal changed while reading');
        return data.subarray(0, length);
    } finally {
        await handle.close();
    }
}

export async function captureUsageArchive(
    request: z.infer<typeof usageArchiveRequest>,
    file = USAGE_JOURNAL_FILE,
) {
    const original = await readUsageArchiveFile(file);
    // Corrupt files remain evidence. The panel classifies their contents rather
    // than treating a parse failure, or absence, as a zero-usage receipt.
    const payload = Buffer.from(
        JSON.stringify({
            version: USAGE_ARCHIVE_VERSION,
            ...request,
            capturedAt: Date.now(),
            journal:
                original === null
                    ? null
                    : {
                          bytes: original.length,
                          sha256: createHash('sha256').update(original).digest('hex'),
                          data: original.toString('base64'),
                      },
        }),
    );
    if (payload.length > USAGE_ARCHIVE_MAX_BYTES)
        throw new Error('Usage archive capacity exceeded');
    return {
        version: USAGE_ARCHIVE_VERSION,
        encoding: 'gzip-base64' as const,
        bytes: payload.length,
        sha256: createHash('sha256').update(payload).digest('hex'),
        data: (await compress(payload, { level: 1 })).toString('base64'),
    };
}
