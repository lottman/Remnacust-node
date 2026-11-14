import { ClientError, Status } from 'nice-grpc';

import type { XtlsApi } from '@remnawave/xtls-sdk';
import { STATS_ERRORS } from '@remnawave/xtls-sdk/build/src/common/errors';
import type { ISdkResponse } from '@remnawave/xtls-sdk/build/src/common/types';
import {
    GetSysStatsResponseModel,
    GetAllUsersStatsResponseModel,
    GetUserOnlineStatusResponseModel,
    GetAllInboundsStatsResponseModel,
    GetInboundStatsResponseModel,
    GetAllOutboundsStatsResponseModel,
    GetOutboundStatsResponseModel,
    GetUsersStatsResponseModel,
} from '@remnawave/xtls-sdk/build/src/stats/models';

import { coreRpcSignal, withCoreRpcDeadline } from '../xray-core/core-rpc-deadline';

export class CoreStatsClient {
    private supportsUsersStats: boolean | null = null;

    constructor(private readonly api: XtlsApi) {}

    private async result<T>(
        action: () => Promise<T>,
        failure: (message: string) => { code: string; message: string },
    ): Promise<ISdkResponse<T>> {
        try {
            return { isOk: true, data: await withCoreRpcDeadline(action) };
        } catch (error) {
            return {
                isOk: false,
                ...failure(error instanceof Error ? error.message : 'Core RPC failed'),
            };
        }
    }

    getSysStats() {
        return this.result(
            async () =>
                new GetSysStatsResponseModel(
                    await this.api.stats.rawClient.getSysStats({}, { signal: coreRpcSignal() }),
                ),
            STATS_ERRORS.GET_SYS_STATS_ERROR,
        );
    }

    getAllUsersStats(reset: boolean) {
        return this.result(
            async () =>
                new GetAllUsersStatsResponseModel(
                    await this.api.stats.rawClient.queryStats(
                        { pattern: 'user>>>', reset },
                        { signal: coreRpcSignal() },
                    ),
                ),
            STATS_ERRORS.GET_ALL_USERS_STATS_ERROR,
        );
    }

    getUserOnlineStatus(username: string) {
        return this.result(async () => {
            try {
                await this.api.stats.rawClient.getStatsOnline(
                    { name: `user>>>${username}>>>online` },
                    { signal: coreRpcSignal() },
                );
                return new GetUserOnlineStatusResponseModel(true);
            } catch (error) {
                if (error instanceof Error && error.message.includes('online not found.'))
                    return new GetUserOnlineStatusResponseModel(false);
                throw error;
            }
        }, STATS_ERRORS.GET_USER_ONLINE_STATUS_ERROR);
    }

    getInboundStats(tag: string, reset: boolean) {
        return this.result(
            async () =>
                new GetInboundStatsResponseModel(
                    await this.api.stats.rawClient.queryStats(
                        { pattern: `inbound>>>${tag}>>>`, reset },
                        { signal: coreRpcSignal() },
                    ),
                ),
            STATS_ERRORS.GET_INBOUND_STATS_ERROR,
        );
    }

    getOutboundStats(tag: string, reset: boolean) {
        return this.result(
            async () =>
                new GetOutboundStatsResponseModel(
                    await this.api.stats.rawClient.queryStats(
                        { pattern: `outbound>>>${tag}>>>`, reset },
                        { signal: coreRpcSignal() },
                    ),
                ),
            STATS_ERRORS.GET_OUTBOUND_STATS_ERROR,
        );
    }

    getAllInboundsStats(reset: boolean) {
        return this.result(
            async () =>
                new GetAllInboundsStatsResponseModel(
                    await this.api.stats.rawClient.queryStats(
                        { pattern: 'inbound>>>', reset },
                        { signal: coreRpcSignal() },
                    ),
                ),
            STATS_ERRORS.GET_ALL_INBOUNDS_STATS_ERROR,
        );
    }

    getAllOutboundsStats(reset: boolean) {
        return this.result(
            async () =>
                new GetAllOutboundsStatsResponseModel(
                    await this.api.stats.rawClient.queryStats(
                        { pattern: 'outbound>>>', reset },
                        { signal: coreRpcSignal() },
                    ),
                ),
            STATS_ERRORS.GET_ALL_OUTBOUNDS_STATS_ERROR,
        );
    }

    getUsersStats(_includeTraffic: false = false, _reset: false = false) {
        return this.result(async () => {
            const signal = coreRpcSignal();
            if (this.supportsUsersStats !== false) {
                try {
                    const response = await this.api.stats.rawClient.getUsersStats(
                        { includeTraffic: false, reset: false },
                        { signal },
                    );
                    this.supportsUsersStats = true;
                    return new GetUsersStatsResponseModel(response);
                } catch (error) {
                    if (!(error instanceof ClientError) || error.code !== Status.UNIMPLEMENTED)
                        throw error;
                    this.supportsUsersStats = false;
                }
            }
            signal.throwIfAborted();
            const online = await this.api.stats.rawClient.getAllOnlineUsers({}, { signal });
            const names = [...new Set(online.users)];
            type UserStat = NonNullable<GetUsersStatsResponseModel['users']>[number];
            const users: (UserStat | undefined)[] = Array.from({ length: names.length });
            let cursor = 0;
            const workers = Array.from({ length: Math.min(50, names.length) }, async () => {
                while (cursor < names.length) {
                    signal.throwIfAborted();
                    const index = cursor++;
                    const name = names[index];
                    try {
                        const response = await this.api.stats.rawClient.getStatsOnlineIpList(
                            { name, reset: false },
                            { signal },
                        );
                        const ips = Object.entries(response.ips).map(([ip, lastSeen]) => ({
                            ip,
                            lastSeen: new Date(lastSeen * 1000),
                        }));
                        if (ips.length)
                            users[index] = {
                                userId: name.slice('user>>>'.length, -'>>>online'.length),
                                ips,
                                traffic: undefined,
                            };
                    } catch (error) {
                        if (signal.aborted) throw error;
                    }
                }
            });
            const settled = await Promise.allSettled(workers);
            const failed = settled.find((result) => result.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
            return GetUsersStatsResponseModel.fromUserStats(
                users.filter((user): user is UserStat => user !== undefined),
            );
        }, STATS_ERRORS.GET_USERS_STATS_ERROR);
    }
}
