import type { PortPlanTarget } from './port-plan-state';

import { createHash } from 'node:crypto';

type Json = Record<string, unknown>;
export type ProfileInput = {
    version: 'remnacust-profile-input-v1';
    root: Json;
    delivery: {
        epoch: string;
        owner: string;
        revision: string;
        enabled: boolean;
        inputsHash: string;
    };
    graphs: {
        bindingUuid: string;
        configProfileUuid: string;
        configProfileInboundUuid: string;
        config: Json;
    }[];
};
export type ProfileAcknowledgement = {
    hash: string;
    graphCount: number;
    unchanged: boolean;
    coreProcessId?: string;
    delivery: ProfileInput['delivery'] & { planHash: string };
};

const object = (value: unknown): value is Json =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const decimal = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^[1-9][0-9]{0,18}$/.test(value) &&
    BigInt(value) <= 9223372036854775807n;

function canonical(value: unknown, depth = 0): string {
    if (depth > 64) throw new Error('Profile source nesting exceeds its limit');
    if (Array.isArray(value))
        return '[' + value.map((entry) => canonical(entry, depth + 1)).join(',') + ']';
    if (object(value))
        return (
            '{' +
            Object.keys(value)
                .sort()
                .map((key) => JSON.stringify(key) + ':' + canonical(value[key], depth + 1))
                .join(',') +
            '}'
        );
    if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
    )
        return JSON.stringify(value);
    throw new Error('Profile source contains a non-JSON value');
}

const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

function configuration(value: unknown): asserts value is Json {
    if (!object(value) || Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024)
        throw new Error('Invalid or oversized profile configuration');
    for (const [key, environment] of Object.entries(value))
        if (
            key.toLowerCase() === 'env' &&
            (!object(environment) || Object.keys(environment).length)
        )
            throw new Error('Process environment is not profile-local');
}

// The panel's JS canonical hashes are checked here, before translating into the
// native compiler envelope. Go then binds the actual compiled protobuf source.
export function makeProfileInput(
    root: Json,
    rawPlan: unknown,
    target: PortPlanTarget,
    inputsHash: string,
): ProfileInput {
    if (
        !target.delivery ||
        !decimal(target.delivery.epoch) ||
        !uuid.test(target.delivery.owner) ||
        !decimal(target.revision) ||
        typeof target.enabled !== 'boolean' ||
        !digest.test(inputsHash)
    )
        throw new Error('A versioned profile delivery is required');
    const plan = structuredClone(rawPlan);
    if (
        !object(plan) ||
        plan.version !== 'remnacust-profile-graphs-v1' ||
        !Array.isArray(plan.graphs) ||
        plan.graphs.length > 512 ||
        typeof plan.hash !== 'string' ||
        !digest.test(plan.hash) ||
        Object.keys(plan).length !== 3
    )
        throw new Error('Invalid profile graph plan');
    if ((target.enabled && !plan.graphs.length) || (!target.enabled && plan.graphs.length))
        throw new Error('Profile graph exposure does not match its delivery mode');
    const seen = new Set<string>();
    const graphs: ProfileInput['graphs'] = [];
    for (const entry of plan.graphs) {
        if (
            !object(entry) ||
            Object.keys(entry).length !== 5 ||
            typeof entry.bindingUuid !== 'string' ||
            !uuid.test(entry.bindingUuid) ||
            seen.has(entry.bindingUuid) ||
            typeof entry.configProfileUuid !== 'string' ||
            !uuid.test(entry.configProfileUuid) ||
            typeof entry.configProfileInboundUuid !== 'string' ||
            !uuid.test(entry.configProfileInboundUuid) ||
            typeof entry.hash !== 'string' ||
            !digest.test(entry.hash)
        )
            throw new Error('Invalid profile graph provenance');
        configuration(entry.config);
        if (
            !Array.isArray(entry.config.inbounds) ||
            entry.config.inbounds.length !== 1 ||
            !Array.isArray(entry.config.outbounds) ||
            !entry.config.outbounds.length
        )
            throw new Error('A profile binding requires one inbound and its full outbounds');
        const graph = {
            bindingUuid: entry.bindingUuid,
            configProfileUuid: entry.configProfileUuid,
            configProfileInboundUuid: entry.configProfileInboundUuid,
            config: entry.config,
        };
        if (hash(graph) !== entry.hash) throw new Error('Profile graph source hash does not match');
        seen.add(entry.bindingUuid);
        graphs.push(graph);
    }
    if (hash({ version: plan.version, graphs: plan.graphs }) !== plan.hash)
        throw new Error('Profile plan source hash does not match');
    const rootCopy = structuredClone(root);
    configuration(rootCopy);
    const input: ProfileInput = {
        version: 'remnacust-profile-input-v1',
        root: rootCopy,
        graphs,
        delivery: {
            epoch: target.delivery.epoch,
            owner: target.delivery.owner,
            revision: target.revision,
            enabled: target.enabled,
            inputsHash,
        },
    };
    if (Buffer.byteLength(JSON.stringify(input)) > 16 * 1024 * 1024)
        throw new Error('Profile input exceeds its control limit');
    return input;
}

export function validateProfileAcknowledgement(
    value: unknown,
    input: ProfileInput,
    live: boolean,
): ProfileAcknowledgement {
    if (
        !object(value) ||
        typeof value.hash !== 'string' ||
        !digest.test(value.hash) ||
        value.graphCount !== input.graphs.length ||
        typeof value.unchanged !== 'boolean' ||
        !object(value.delivery) ||
        Object.keys(value.delivery).length !== 6 ||
        typeof value.delivery.planHash !== 'string' ||
        !digest.test(value.delivery.planHash)
    )
        throw new Error('Invalid native profile acknowledgement');
    for (const [key, expected] of Object.entries(input.delivery))
        if (value.delivery[key] !== expected)
            throw new Error('Native profile delivery ownership does not match');
    if (live && (typeof value.coreProcessId !== 'string' || !uuid.test(value.coreProcessId)))
        throw new Error('Native profile acknowledgement has no core incarnation');
    return value as ProfileAcknowledgement;
}
