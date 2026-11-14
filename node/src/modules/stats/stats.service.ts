import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import { XtlsApi } from '@remnawave/xtls-sdk';
import { InjectXtls } from '@remnawave/xtls-sdk-nestjs';

import { fail, ok, TResult } from '@common/types';
import { getSystemStats } from '@common/utils/get-system-stats';
import { ERRORS } from '@libs/contracts/constants';

import { GetTorrentBlockerReportsCountQuery } from '../_plugin/queries/get-torrent-blocker-reports-count';
import { InternalService } from '../internal/internal.service';
import { GetInterfaceStatsQuery } from '../network-stats/queries/get-interface-stats/get-interface-stats.query';
import { readCoreIncarnation } from '../xray-core/core-incarnation';
import { coreManagement } from '../xray-core/core-management';
import { withCoreRpcDeadline } from '../xray-core/core-rpc-deadline';
import { readProfileTraffic } from '../xray-core/profile-traffic';
import { XrayProcessService } from '../xray-core/xray-process.service';
import { CoreStatsClient } from './core-stats-client';
import { IGetUserOnlineStatusRequest } from './interfaces';
import {
    GetAllInboundsStatsResponseModel,
    GetAllOutboundsStatsResponseModel,
    GetCombinedStatsResponseModel,
    GetInboundStatsResponseModel,
    GetOutboundStatsResponseModel,
    GetSystemStatsResponseModel,
    GetUserIpListResponseModel,
    GetUserOnlineStatusResponseModel,
    GetUsersIpListResponseModel,
    GetUsersStatsResponseModel,
} from './models';

@Injectable()
export class StatsService {
    private readonly coreStats: CoreStatsClient;
    constructor(
        @InjectXtls() private readonly xtlsSdk: XtlsApi,
        private readonly queryBus: QueryBus,
        private readonly xrayProcess: XrayProcessService,
        private readonly internalService: InternalService,
    ) {
        this.coreStats = new CoreStatsClient(xtlsSdk);
    }
    private readonly logger = new Logger(StatsService.name);

    private async requireCore(): Promise<void> {
        if (coreManagement.isBusy() && !coreManagement.isOwned())
            throw new ServiceUnavailableException(
                'Xray Core is not ready; retry after synchronization',
            );
        const status = await this.xrayProcess.getStatus();
        if (
            (coreManagement.isBusy() && !coreManagement.isOwned()) ||
            !status.up ||
            !this.xrayProcess.isApiSocketAvailable()
        )
            throw new ServiceUnavailableException(
                'Xray Core is not ready; retry after synchronization',
            );
    }

    private statsOperation<T>(reset: boolean, action: () => Promise<T>): Promise<T> {
        const run = () => withCoreRpcDeadline(action);
        return reset ? coreManagement.run(run) : run();
    }

    public async getUserOnlineStatus(
        body: IGetUserOnlineStatusRequest,
    ): Promise<TResult<GetUserOnlineStatusResponseModel>> {
        await this.requireCore();
        try {
            const response = await this.coreStats.getUserOnlineStatus(body.username);

            if (response.isOk && response.data) {
                return ok(new GetUserOnlineStatusResponseModel(response.data.online));
            }

            return ok(new GetUserOnlineStatusResponseModel(false));
        } catch (error) {
            this.logger.error(error);
            return {
                isOk: true,
                response: new GetUserOnlineStatusResponseModel(false),
            };
        }
    }

    public async getSystemStats(): Promise<TResult<GetSystemStatsResponseModel>> {
        await this.requireCore();
        try {
            const response = await this.coreStats.getSysStats();

            if (!response.isOk || !response.data) {
                this.logger.warn(response);
                return fail(ERRORS.FAILED_TO_GET_SYSTEM_STATS);
            }

            const interfaceStats = await this.queryBus.execute(new GetInterfaceStatsQuery());
            const systemStats = getSystemStats();
            const reportsCount = await this.queryBus.execute(
                new GetTorrentBlockerReportsCountQuery(),
            );
            const bindingTraffic = this.internalService.hasProfileBindings()
                ? await readProfileTraffic(this.xtlsSdk).catch(() => null)
                : null;

            return {
                isOk: true,
                response: new GetSystemStatsResponseModel(
                    response.data,
                    {
                        torrentBlocker: {
                            reportsCount,
                        },
                    },
                    {
                        ...systemStats,
                        interface: interfaceStats,
                    },
                    this.internalService.hasConfiguration(),
                    bindingTraffic,
                ),
            };
        } catch (error) {
            this.logger.error(error);
            return {
                isOk: false,
                ...ERRORS.FAILED_TO_GET_SYSTEM_STATS,
            };
        }
    }

    public async getUsersStats(reset: boolean): Promise<TResult<GetUsersStatsResponseModel>> {
        return this.statsOperation(reset, () => this.getUsersStatsLocked(reset));
    }

    private async getUsersStatsLocked(
        reset: boolean,
    ): Promise<TResult<GetUsersStatsResponseModel>> {
        await this.requireCore();
        try {
            const before = await readCoreIncarnation(await this.xrayProcess.getStatus());
            const response = await this.coreStats.getAllUsersStats(reset);

            if (!response.isOk || !response.data) {
                this.logger.warn(response);

                return fail(ERRORS.FAILED_TO_GET_USERS_STATS);
            }

            const after = await readCoreIncarnation(await this.xrayProcess.getStatus());
            return ok(
                new GetUsersStatsResponseModel(
                    response.data.users.filter((user) => user.uplink !== 0 || user.downlink !== 0),
                    before && before === after ? before : null,
                ),
            );

            // const demoRes = Array.from({ length: 160_000 }, (_, i) => ({
            //     username: String(i + 1),
            //     uplink: Math.floor(Math.random() * (107374182400 - 10485760) + 10485760), // Random between 10MB and 100GB
            //     downlink: Math.floor(Math.random() * (107374182400 - 10485760) + 10485760), // Random between 10MB and 100GB
            // }));

            // return {
            //     isOk: true,
            //     response: new GetUsersStatsResponseModel(demoRes),
            // };
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_USERS_STATS);
        }
    }

    public async getInboundStats(
        tag: string,
        reset: boolean,
    ): Promise<TResult<GetInboundStatsResponseModel>> {
        return this.statsOperation(reset, () => this.getInboundStatsLocked(tag, reset));
    }

    private async getInboundStatsLocked(
        tag: string,
        reset: boolean,
    ): Promise<TResult<GetInboundStatsResponseModel>> {
        await this.requireCore();
        try {
            const response = await this.coreStats.getInboundStats(tag, reset);

            if (!response.isOk || !response.data || !response.data.inbound) {
                return fail(ERRORS.FAILED_TO_GET_INBOUND_STATS);
            }

            return ok(
                new GetInboundStatsResponseModel({
                    inbound: response.data.inbound.inbound,
                    downlink: response.data.inbound.downlink,
                    uplink: response.data.inbound.uplink,
                }),
            );
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_INBOUND_STATS);
        }
    }

    public async getOutboundStats(
        tag: string,
        reset: boolean,
    ): Promise<TResult<GetOutboundStatsResponseModel>> {
        return this.statsOperation(reset, () => this.getOutboundStatsLocked(tag, reset));
    }

    private async getOutboundStatsLocked(
        tag: string,
        reset: boolean,
    ): Promise<TResult<GetOutboundStatsResponseModel>> {
        await this.requireCore();
        try {
            const response = await this.coreStats.getOutboundStats(tag, reset);

            if (!response.isOk || !response.data || !response.data.outbound) {
                return fail(ERRORS.FAILED_TO_GET_OUTBOUND_STATS);
            }

            return ok(
                new GetOutboundStatsResponseModel({
                    outbound: response.data.outbound.outbound,
                    downlink: response.data.outbound.downlink,
                    uplink: response.data.outbound.uplink,
                }),
            );
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_OUTBOUND_STATS);
        }
    }

    public async getAllInboundsStats(
        reset: boolean,
    ): Promise<TResult<GetAllInboundsStatsResponseModel>> {
        return this.statsOperation(reset, () => this.getAllInboundsStatsLocked(reset));
    }

    private async getAllInboundsStatsLocked(
        reset: boolean,
    ): Promise<TResult<GetAllInboundsStatsResponseModel>> {
        await this.requireCore();
        try {
            const response = await this.coreStats.getAllInboundsStats(reset);

            if (!response.isOk || !response.data) {
                return fail(ERRORS.FAILED_TO_GET_INBOUNDS_STATS);
            }

            return ok(new GetAllInboundsStatsResponseModel(response.data.inbounds));
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_INBOUNDS_STATS);
        }
    }

    public async getAllOutboundsStats(
        reset: boolean,
    ): Promise<TResult<GetAllOutboundsStatsResponseModel>> {
        return this.statsOperation(reset, () => this.getAllOutboundsStatsLocked(reset));
    }

    private async getAllOutboundsStatsLocked(
        reset: boolean,
    ): Promise<TResult<GetAllOutboundsStatsResponseModel>> {
        await this.requireCore();
        try {
            const response = await this.coreStats.getAllOutboundsStats(reset);

            if (!response.isOk || !response.data) {
                this.logger.error(response);
                return fail(ERRORS.FAILED_TO_GET_OUTBOUNDS_STATS);
            }

            return ok(new GetAllOutboundsStatsResponseModel(response.data.outbounds));
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_INBOUNDS_STATS);
        }
    }

    public async getCombinedStats(reset: boolean): Promise<TResult<GetCombinedStatsResponseModel>> {
        return this.statsOperation(reset, () => this.getCombinedStatsLocked(reset));
    }

    private async getCombinedStatsLocked(
        reset: boolean,
    ): Promise<TResult<GetCombinedStatsResponseModel>> {
        await this.requireCore();
        try {
            const { isOk: isOkInbounds, data: inboundsData } =
                await this.coreStats.getAllInboundsStats(reset);
            const { isOk: isOkOutbounds, data: outboundsData } =
                await this.coreStats.getAllOutboundsStats(reset);

            if (!isOkInbounds || !inboundsData || !isOkOutbounds || !outboundsData) {
                return fail(ERRORS.FAILED_TO_GET_COMBINED_STATS);
            }

            return ok(
                new GetCombinedStatsResponseModel(inboundsData.inbounds, outboundsData.outbounds),
            );
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_COMBINED_STATS);
        }
    }

    public async getUserIpList(userId: string): Promise<TResult<GetUserIpListResponseModel>> {
        const response = await this.getUsersIpList();
        if (!response.isOk) return fail(ERRORS.FAILED_TO_GET_USERS_STATS);
        const byIp = new Map<string, { ip: string; lastSeen: Date }>();
        for (const user of response.response.users) {
            const owner = /^([1-9][0-9]*)(?:~[a-f0-9]{24}(?:~h[a-f0-9]{32})?)?$/.exec(
                user.userId,
            )?.[1];
            if (owner !== userId) continue;
            for (const ip of user.ips) {
                const previous = byIp.get(ip.ip);
                if (
                    !previous ||
                    new Date(ip.lastSeen).getTime() > new Date(previous.lastSeen).getTime()
                )
                    byIp.set(ip.ip, ip);
            }
        }
        return ok(new GetUserIpListResponseModel([...byIp.values()]));
    }

    public async getUsersIpList(): Promise<TResult<GetUsersIpListResponseModel>> {
        await this.requireCore();
        try {
            const response = await this.coreStats.getUsersStats(false, false);

            if (!response.isOk || !response.data || !Array.isArray(response.data.users)) {
                this.logger.error(response);
                return fail(ERRORS.FAILED_TO_GET_USERS_STATS);
            }

            return ok(new GetUsersIpListResponseModel(response.data.users));
        } catch (error) {
            this.logger.error(error);
            return fail(ERRORS.FAILED_TO_GET_USERS_STATS);
        }
    }
}
