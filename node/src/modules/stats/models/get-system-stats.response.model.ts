import { TNodeSystemStats, ProfileTrafficSnapshot } from '@libs/contracts/models';

interface IXrayStats {
    numGoroutine: number;
    numGC: number;
    alloc: number;
    totalAlloc: number;
    sys: number;
    mallocs: number;
    frees: number;
    liveObjects: number;
    pauseTotalNs: number;
    uptime: number;
}

interface IPluginStats {
    torrentBlocker: {
        reportsCount: number;
    };
}

export class GetSystemStatsResponseModel {
    public xrayInfo: IXrayStats | null;
    public plugins: IPluginStats;
    public system: {
        stats: TNodeSystemStats;
        info?: { ipAddresses: string[] };
    };

    constructor(
        xrayInfo: IXrayStats | null,
        plugins: IPluginStats,
        systemStats: TNodeSystemStats,
        public readonly userStateSynchronized = false,
        public readonly bindingTraffic: ProfileTrafficSnapshot | null = null,
        ipAddresses?: string[],
    ) {
        this.xrayInfo = xrayInfo;
        this.plugins = plugins;
        this.system = {
            stats: systemStats,
            ...(ipAddresses === undefined ? {} : { info: { ipAddresses } }),
        };
    }
}
