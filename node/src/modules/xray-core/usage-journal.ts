import { createHash } from 'node:crypto';
import { z } from 'zod';

import { USAGE_JOURNAL_MAX_BYTES } from './usage-archive';
import { frameDigest, USAGE_RECEIPTS, parseUsageReceiptResponse } from './usage-receipt';

const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z
    .uuid()
    .refine(
        (value) =>
            value === value.toLowerCase() &&
            value !== '00000000-0000-0000-0000-000000000000' &&
            value !== 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    );
const integer = z
    .string()
    .regex(/^(0|[1-9][0-9]{0,18})$/)
    .refine((value) => BigInt(value) <= 9223372036854775807n);
const positive = integer.refine((value) => value !== '0');
const frame = z.strictObject({
    sequence: positive,
    coreProcessId: identity,
    capturedAt: positive,
    stats: z
        .array(z.strictObject({ name: z.string().min(1).max(1024), value: positive }))
        .max(100000),
});
const journal = z.strictObject({
    version: z.literal(1),
    stream: identity,
    acked: integer,
    ackDigest: z.string(),
    pending: frame.nullable(),
});

export function readPersistedUsageJournal(original: Buffer) {
    const magic = Buffer.from('REMNACUST-USAGE-1\n');
    if (
        original.length > USAGE_JOURNAL_MAX_BYTES ||
        !original.subarray(0, magic.length).equals(magic) ||
        original[magic.length + 64] !== 10
    )
        throw new Error('Invalid usage journal header');
    const payload = original.subarray(magic.length + 65);
    if (
        payload.length > 8 * 1024 * 1024 ||
        original.subarray(magic.length, magic.length + 64).toString() !== hash(payload)
    )
        throw new Error('Invalid usage journal checksum');
    const text = payload.toString('utf8');
    if (!Buffer.from(text).equals(payload)) throw new Error('Invalid usage journal encoding');
    const state = journal.parse(JSON.parse(text));
    if (
        (state.acked === '0' && state.ackDigest !== '') ||
        (state.acked !== '0' && !digest.safeParse(state.ackDigest).success)
    )
        throw new Error('Invalid usage acknowledgement');
    if (state.pending) {
        if (BigInt(state.pending.sequence) !== BigInt(state.acked) + 1n)
            throw new Error('Invalid pending sequence');
        parseUsageReceiptResponse(
            {
                action: 'sample',
                stream: state.stream,
                sequence: state.pending.sequence,
                coreProcessId: state.pending.coreProcessId,
            },
            {
                capability: USAGE_RECEIPTS,
                stream: state.stream,
                ...state.pending,
                digest: frameDigest(state.pending),
            },
        );
    }
    return state;
}

export function usageJournalHead(original: Buffer) {
    const state = readPersistedUsageJournal(original);
    return {
        stream: state.stream,
        acked: state.acked,
        ackDigest: state.ackDigest,
        digest: createHash('sha256').update(original).digest('hex'),
        pending: state.pending
            ? {
                  sequence: state.pending.sequence,
                  coreProcessId: state.pending.coreProcessId,
                  digest: frameDigest(state.pending),
              }
            : null,
    };
}
