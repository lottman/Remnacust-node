import os from 'node:os';

import { TNodeSystemInfo, TNodeSystemStats } from '@libs/contracts/models';

import { getNetworkAddresses } from './get-network-addresses';

export function getSystemInfo(): TNodeSystemInfo {
    const cpus = os.cpus();
    let interfaces: ReturnType<typeof os.networkInterfaces> = {};
    let ipAddresses: string[] | undefined;
    try {
        interfaces = os.networkInterfaces();
        ipAddresses = getNetworkAddresses(interfaces).addresses;
    } catch {
        ipAddresses = undefined;
    }
    return {
        arch: os.arch(),
        cpus: cpus.length,
        cpuModel: cpus[0]?.model ?? 'unknown',
        memoryTotal: os.totalmem(),
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        type: os.type(),
        version: os.version(),
        networkInterfaces: Object.keys(interfaces),
        ...(ipAddresses === undefined ? {} : { ipAddresses }),
    };
}

export function getSystemStats(): TNodeSystemStats {
    return {
        memoryFree: os.freemem(),
        memoryUsed: os.totalmem() - os.freemem(),
        uptime: os.uptime(),
        loadAvg: os.loadavg(),
        interface: null,
    };
}
