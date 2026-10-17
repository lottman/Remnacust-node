import { fromBinary, fromJson, toBinary, toJson, type JsonValue } from '@bufbuild/protobuf';
import { StructSchema } from '@bufbuild/protobuf/wkt';
import { createClient } from 'nice-grpc';

import { XtlsApi } from '@remnawave/xtls-sdk';

import { ProfileTrafficSchema, type ProfileTrafficSnapshot } from '@libs/contracts/models';

const serialize = (value: JsonValue) => toBinary(StructSchema, fromJson(StructSchema, value));
const deserialize = (bytes: Uint8Array): JsonValue => {
    if (bytes.byteLength > 512 * 1024) throw new Error('Profile traffic response exceeds its limit');
    return toJson(StructSchema, fromBinary(StructSchema, bytes));
};
const service = {
    traffic: {
        path: '/remnacust-profile-control-v1/Traffic',
        requestStream: false,
        responseStream: false,
        requestSerialize: serialize,
        requestDeserialize: deserialize,
        responseSerialize: serialize,
        responseDeserialize: deserialize,
        options: { idempotencyLevel: 'NO_SIDE_EFFECTS' },
    },
} as const;

/** Read-only observations. Never reset counters or feed them into quota credit. */
export async function readProfileTraffic(api: XtlsApi): Promise<ProfileTrafficSnapshot> {
    const value = await createClient(service, api.channel).traffic({}, { signal: AbortSignal.timeout(500) });
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid profile traffic response');
    return ProfileTrafficSchema.parse({ ...value, capturedAt: new Date().toISOString() });
}
