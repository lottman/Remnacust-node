export type CoreFlavor = 'custom' | 'default';

export const CORE_FLAVOR_PATHS: Readonly<Record<CoreFlavor, string>> = {
    custom: '/usr/local/bin/xray',
    default: '/usr/local/bin/xray-default',
};

export function requestedCoreFlavor(geodata: unknown): CoreFlavor | undefined {
    if (!geodata || typeof geodata !== 'object' || Array.isArray(geodata)) return undefined;
    const value = geodata as Record<string, unknown>;
    const flavor = value.remnacustCoreFlavor;
    if (flavor === undefined) return undefined;
    if (flavor !== 'custom' && flavor !== 'default') throw new Error('Invalid core flavor');
    if (value.core !== undefined)
        throw new Error('A global core flavor cannot be combined with geodata.core');
    return flavor;
}

export function assertCoreFlavorConfiguration(
    flavor: CoreFlavor,
    config: Record<string, unknown>,
): void {
    if (flavor !== 'default') return;
    if (config.remnacustUserQuotaRequired)
        throw new Error('The default core cannot enforce mandatory user quotas');
    const routing = config.routing as { rules?: { webhook?: unknown }[] } | undefined;
    if (Array.isArray(routing?.rules) && routing.rules.some((rule) => rule?.webhook !== undefined))
        throw new Error('Routing webhooks require the custom core');
    for (const section of ['inbounds', 'outbounds']) {
        const entries = config[section];
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
            const stream = entry?.streamSettings;
            if (
                entry?.protocol === 'olcrtc' ||
                stream?.xeraHttpSettings !== undefined ||
                ['xera', 'xera-http'].includes(stream?.network) ||
                ['xera', 'xera-http'].includes(stream?.method)
            )
                throw new Error('This configuration requires the custom core');
        }
    }
}
