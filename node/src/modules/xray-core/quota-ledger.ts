import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

export const QUOTA_RESERVE_VERSION = 'remnacust-quota-reserves-v1';
export const QUOTA_REGISTRATION_VERSION = 'remnacust-quota-registrations-v1';
export const QUOTA_WATERMARK_VERSION = 'remnacust-quota-watermarks-v1';
export const QUOTA_LEDGER_FILE = '/var/lib/remnanode/quota/ledger.json';
const MAX_LEDGER = 16 * 1024 * 1024;

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const amount = z
    .string()
    .refine(
        (value) => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n,
    );
const entrySchema = z.object({
    group: z.string().min(1).max(200),
    owner: z.string().regex(/^[1-9][0-9]{0,18}$/),
    expiresAt: z.int().positive().max(Number.MAX_SAFE_INTEGER),
    ceiling: amount,
    reserved: amount,
    closed: z.boolean().optional(),
    prepared: z.boolean().optional(),
    activated: z.boolean().optional(),
    scale: z.union([z.literal(0), z.literal(100), z.literal(1_000_000_000)]).optional(),
});
export type QuotaJournalEntry = z.infer<typeof entrySchema>;
export type QuotaJournalStatus = {
    instance: string;
    sequence: number;
    registrationsRequired: boolean;
    watermarksRequired: boolean;
    checkpoint: number;
    retiredBefore: number;
    entries: Map<string, QuotaJournalEntry>;
};

export async function readQuotaJournal(file = QUOTA_LEDGER_FILE): Promise<QuotaJournalStatus> {
    return readJournal(file, false);
}

// The running core only appends or atomically replaces this file. An opened,
// complete prefix is a consistent observation even while newer frames arrive.
// Boot and settlement verification deliberately retain the stricter reader.
export async function readQuotaJournalSnapshot(
    file = QUOTA_LEDGER_FILE,
): Promise<QuotaJournalStatus> {
    return readJournal(file, true);
}

async function readJournal(file: string, snapshot: boolean): Promise<QuotaJournalStatus> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await readQuotaJournalOnce(file, snapshot);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EAGAIN' || attempt >= 2) throw error;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }
}
export async function verifyQuotaLedger(file = QUOTA_LEDGER_FILE): Promise<string> {
    return (await readQuotaJournal(file)).instance;
}

async function readQuotaJournalOnce(file: string, snapshot: boolean): Promise<QuotaJournalStatus> {
    const details = await lstat(file);
    const parent = await lstat(dirname(file));
    if (
        !details.isFile() ||
        details.isSymbolicLink() ||
        details.size > MAX_LEDGER ||
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        (process.platform !== 'win32' && (details.mode & 0o077 || parent.mode & 0o077))
    )
        throw new Error('Quota ledger must be a bounded private regular file');
    const uid = process.getuid?.();
    if (uid !== undefined && (details.uid !== uid || parent.uid !== uid))
        throw new Error('Quota state has an untrusted owner');
    for (let current = dirname(dirname(file)); ; current = dirname(current)) {
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error('Untrusted quota directory ancestor');
        if (dirname(current) === current) break;
    }
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const opened = await handle.stat();
        if (opened.dev !== details.dev || opened.ino !== details.ino)
            throw new Error('Quota ledger changed while opening');
        // A single read is bounded even if another process replaces or grows the file.
        if (opened.size > MAX_LEDGER) throw new Error('Quota ledger is too large');
        const buffer = Buffer.alloc(
            snapshot ? opened.size : Math.min(opened.size + 1, MAX_LEDGER + 1),
        );
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            const result = await handle.read(
                buffer,
                bytesRead,
                buffer.length - bytesRead,
                bytesRead,
            );
            if (!result.bytesRead) break;
            bytesRead += result.bytesRead;
        }
        if (bytesRead > MAX_LEDGER) throw new Error('Quota ledger is too large');
        const completed = await handle.stat();
        if (
            bytesRead !== opened.size ||
            completed.size < opened.size ||
            (!snapshot && completed.size !== opened.size) ||
            (completed.size === opened.size && completed.mtimeMs !== opened.mtimeMs)
        )
            throw Object.assign(new Error('Quota journal changed while reading'), {
                code: 'EAGAIN',
            });
        const text = buffer.subarray(0, bytesRead).toString('utf8');
        const frames = text.split('\n');
        if (frames.length > 1 && frames.at(-1) !== '')
            throw Object.assign(new Error('Incomplete quota journal record'), {
                code: snapshot ? 'EAGAIN' : 'EINVAL',
            });
        let sequence = -1;
        let registrationsRequired = false;
        let watermarksRequired = false;
        let checkpoint = 0;
        let instance = '';
        let retiredBefore = 0;
        const entries = new Map<string, QuotaJournalEntry>();
        for (let index = 0; index < frames.length; index++) {
            const frame = frames[index];
            if (!frame && index === frames.length - 1 && index > 0) break;
            const envelope = JSON.parse(frame, function (key, value) {
                if (key === 'ceiling' || key === 'reserved') {
                    const context = arguments[2] as { source?: string } | undefined;
                    if (
                        typeof value !== 'number' ||
                        !context?.source ||
                        !/^[0-9]+$/.test(context.source)
                    )
                        throw new Error('Invalid quota integer representation');
                    return context.source;
                }
                return value;
            });
            const start = frame.indexOf('"payload":');
            const suffix = frame.lastIndexOf(',"sha256":');
            const currentSequence = envelope.payload?.sequence ?? 0;
            if (
                start < 0 ||
                suffix < start ||
                createHash('sha256')
                    .update(frame.slice(start + 10, suffix))
                    .digest('hex') !== envelope.sha256 ||
                ![
                    QUOTA_RESERVE_VERSION,
                    QUOTA_REGISTRATION_VERSION,
                    QUOTA_WATERMARK_VERSION,
                ].includes(envelope.payload?.version) ||
                (registrationsRequired && envelope.payload?.version === QUOTA_RESERVE_VERSION) ||
                (watermarksRequired && envelope.payload?.version !== QUOTA_WATERMARK_VERSION) ||
                !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
                    envelope.payload?.instance ?? '',
                ) ||
                (index > 0 && envelope.payload.instance !== instance) ||
                !envelope.payload?.entries ||
                Array.isArray(envelope.payload.entries) ||
                !Number.isSafeInteger(currentSequence) ||
                currentSequence < 0 ||
                (index > 0 && currentSequence !== sequence + 1)
            )
                throw new Error('Quota ledger integrity check failed');
            const currentRetired = envelope.payload.retiredBefore ?? 0;
            registrationsRequired = envelope.payload.version !== QUOTA_RESERVE_VERSION;
            watermarksRequired = envelope.payload.version === QUOTA_WATERMARK_VERSION;
            const currentCheckpoint = envelope.payload.checkpoint ?? 0;
            if (
                !Number.isSafeInteger(currentCheckpoint) ||
                currentCheckpoint < checkpoint ||
                currentCheckpoint > currentSequence ||
                (currentCheckpoint > 0 && !watermarksRequired)
            )
                throw new Error('Invalid quota journal checkpoint');
            checkpoint = currentCheckpoint;
            if (!Number.isSafeInteger(currentRetired) || currentRetired < retiredBefore)
                throw new Error('Invalid quota retirement boundary');
            for (const [id, value] of Object.entries(envelope.payload.entries)) {
                const parsed = entrySchema.safeParse(value);
                if (!uuid.test(id) || !parsed.success)
                    throw new Error('Invalid quota journal entry');
                const entry = parsed.data;
                if (
                    ((entry.prepared || entry.activated) && !registrationsRequired) ||
                    (entry.activated && !entry.prepared) ||
                    (entry.prepared && !entry.activated && entry.reserved !== '0')
                )
                    throw new Error('Invalid quota registration state');
                if (BigInt(entry.reserved) > BigInt(entry.ceiling))
                    throw new Error('Invalid quota journal charge');
                const previous = entries.get(id);
                if (
                    previous &&
                    (previous.group !== entry.group ||
                        previous.owner !== entry.owner ||
                        previous.expiresAt !== entry.expiresAt ||
                        !!previous.prepared !== !!entry.prepared ||
                        (previous.activated && !entry.activated) ||
                        (previous.scale || 100) !== (entry.scale || 100) ||
                        BigInt(entry.ceiling) < BigInt(previous.ceiling) ||
                        (previous.closed && !entry.closed) ||
                        (BigInt(entry.reserved) < BigInt(previous.reserved) &&
                            !(!previous.closed && entry.closed)))
                )
                    throw new Error('Non-monotonic quota journal entry');
                entries.set(id, entry);
                if (entries.size > 100000) throw new Error('Quota ledger capacity exceeded');
            }
            sequence = currentSequence;
            instance = envelope.payload.instance;
            retiredBefore = currentRetired;
        }
        return {
            instance,
            sequence,
            entries,
            registrationsRequired,
            watermarksRequired,
            checkpoint,
            retiredBefore,
        };
    } finally {
        await handle.close();
    }
}

// Only the first transition may create empty state. Lost or corrupt active state
// requires recovery; treating it as a new installation would reissue spent credit.
export async function prepareQuotaLedger(
    alreadyEnabled: boolean,
    file = QUOTA_LEDGER_FILE,
): Promise<string> {
    try {
        return await verifyQuotaLedger(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || alreadyEnabled) throw error;
    }
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const directory = await lstat(dirname(file));
    if (!directory.isDirectory() || directory.isSymbolicLink())
        throw new Error('Untrusted quota directory');
    await chmod(dirname(file), 0o700);
    const payload = JSON.stringify({
        instance: randomUUID(),
        version: QUOTA_RESERVE_VERSION,
        entries: {},
    });
    const data = `{"payload":${payload},"sha256":"${createHash('sha256').update(payload).digest('hex')}"}`;
    const handle = await open(file, 'wx', 0o600);
    try {
        await handle.writeFile(data + '\n');
        await handle.sync();
    } finally {
        await handle.close();
    }
    if (process.platform !== 'win32') {
        const parent = await open(dirname(file), 'r');
        try {
            await parent.sync();
        } finally {
            await parent.close();
        }
    }
    return await verifyQuotaLedger(file);
}
