import { Injectable } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { XtlsApi } from '@remnawave/xtls-sdk';
import { InjectXtls } from '@remnawave/xtls-sdk-nestjs';
import { readCoreVersion } from '@common/utils/read-core-version';
import { GetInterfaceStatsQuery } from '../network-stats/queries/get-interface-stats/get-interface-stats.query';
import { XrayProcessService } from '../xray-core/xray-process.service';
import { bounded, collectRuntimeSystem } from './runtime-metrics';

@Injectable()
export class RuntimeService {
    private pending?: ReturnType<RuntimeService['collect']>;
    private expiresAt = 0;
    constructor(
        @InjectXtls() private readonly xtls: XtlsApi,
        private readonly queryBus: QueryBus,
        private readonly xrayProcess: XrayProcessService,
    ) {}

    get() {
        if (!this.pending || Date.now() >= this.expiresAt) {
            this.expiresAt = Date.now() + 5000;
            this.pending = this.collect().catch(error => { this.pending = undefined; throw error; });
        }
        return this.pending;
    }

    private async collect() {
        const [system, network, processStatus, version, stats] = await Promise.all([
            collectRuntimeSystem(), bounded(this.queryBus.execute(new GetInterfaceStatsQuery())),
            bounded(this.xrayProcess.getStatus()), bounded(readCoreVersion('/usr/local/bin/rw-core')),
            bounded(this.xtls.stats.getSysStats()),
        ]);
        return {
            sampledAt: new Date().toISOString(),
            nodeVersion: typeof __RWNODE_VERSION__ === 'undefined' ? 'unknown' : __RWNODE_VERSION__,
            system: { ...system, network },
            xray: {
                state: processStatus?.raw ? (processStatus.up ? 'running' : 'stopped') : 'unknown',
                pid: processStatus?.pid ?? null, version: version?.semver ?? null,
                build: version?.raw ?? null, statsAvailable: !!(stats?.isOk && stats.data),
                uptimeSeconds: stats?.isOk ? stats.data?.uptime ?? null : null,
                memoryBytes: stats?.isOk ? stats.data?.alloc ?? null : null,
                goroutines: stats?.isOk ? stats.data?.numGoroutine ?? null : null,
            },
        };
    }
}
