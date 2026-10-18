import ems from 'enhanced-ms';
import { execFile } from 'node:child_process';
import { chmod, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pRetry, { AbortError } from 'p-retry';

import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    OnApplicationBootstrap,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';

import { XtlsApi } from '@remnawave/xtls-sdk';
import { InjectXtls } from '@remnawave/xtls-sdk-nestjs';

import { TypedConfigService } from '@common/config/app-config';
import { ok, TResult } from '@common/types';
import { downloadFile } from '@common/utils/download-file';
import { generateApiConfig } from '@common/utils/generate-api-config';
import { getSystemInfo, getSystemStats } from '@common/utils/get-system-stats';
import { StartXrayCommand } from '@libs/contracts/commands';
import { KNOWN_ERRORS } from '@libs/contracts/constants';

import { IntegrationsService } from '@integration-modules/integrations.service';

import { ResetPluginsCommand } from '../_plugin/commands/reset-plugins/reset-plugins.command';
import { RunPostStartCommand } from '../_plugin/commands/run-post-start/run-post-start.command';
import { RunPreStartCommand } from '../_plugin/commands/run-pre-start/run-pre-start.command';
import { GetTorrentBlockerStateQuery } from '../_plugin/queries/get-torrent-blocker-state';
import { InternalService } from '../internal/internal.service';
import { GetInterfaceStatsQuery } from '../network-stats/queries/get-interface-stats/get-interface-stats.query';
import { CoreLoaderService } from './core-loader.service';
import { coreManagement } from './core-management';
import { restoreCachedCore } from './core-boot-recovery';
import { GeodataService } from './geodata.service';
import { LiveCoreService, LIVE_CORE_CHECKPOINT } from './live-core.service';
import {
    ManagedCoreStore,
    CoreAction,
    CoreRelease,
    CoreSelection,
    validateCoreConfig,
    validateCoreRelease,
} from './managed-core.store';
import {
    GetNodeHealthCheckResponseModel,
    StartXrayResponseModel,
    StopXrayResponseModel,
} from './models';
import { NodeReconciliationService } from './node-reconciliation.service';
import { PortPlanStateStore, portPlanInputsHash } from './port-plan-state';
import { makeProfileInput } from './profile-input';
import { XrayProcessService } from './xray-process.service';

const XRAY_LOG_FILE = '/var/log/xray/current' as const;
const execFileAsync = promisify(execFile);

class XrayProcessDownError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'XrayProcessDownError';
    }
}

@Injectable()
export class XrayService implements OnApplicationBootstrap {
    private readonly portPlans = new PortPlanStateStore();
    private readonly logger = new Logger(XrayService.name);
    private readonly disableHashedSetCheck: boolean;
    private readonly internal: {
        socketPath: string;
        token: string;
        xtlsApiSocketPath: string;
    };

    private readonly xrayPath: string;

    private xrayVersion: null | string = null;
    private isXrayOnline: boolean = false;
    private isXrayStartedProccesing: boolean = false;
    private nodeVersion: string = '0.0.0';
    constructor(
        @InjectXtls() private readonly xtlsSdk: XtlsApi,
        private readonly xrayProcess: XrayProcessService,
        private readonly geodataService: GeodataService,
        private readonly coreLoaderService: CoreLoaderService,
        private readonly managedCore: ManagedCoreStore,
        private readonly integrations: IntegrationsService,
        private readonly internalService: InternalService,
        private readonly configService: TypedConfigService,
        private readonly queryBus: QueryBus,
        private readonly commandBus: CommandBus,
        private readonly reconciliation: NodeReconciliationService,
        private readonly liveCore: LiveCoreService,
    ) {
        this.internal = {
            socketPath: this.configService.getOrThrow('INTERNAL_SOCKET_PATH'),
            token: this.configService.getOrThrow('INTERNAL_REST_TOKEN'),
            xtlsApiSocketPath: this.configService.getOrThrow('XTLS_API_SOCKET_PATH'),
        };

        this.xrayPath = '/usr/local/bin/rw-core';
        this.xrayVersion = null;

        this.isXrayStartedProccesing = false;
        this.disableHashedSetCheck = this.configService.getOrThrow('DISABLE_HASHED_SET_CHECK');
    }

    async onApplicationBootstrap() {
        this.isXrayOnline = false;
        try {
            const paused = (await this.managedCore.load()).paused;
            if (paused) await this.xrayProcess.stop();
            await this.refreshXrayVersion();
            this.nodeVersion = `${__RWNODE_VERSION__ ?? '0.0.0'}-remnacust`;

            if (!this.xrayProcess.isControlAvailable()) {
                this.logger.error('s6 xray control socket not found, exiting...');
                process.exit(1);
            }
            this.isXrayOnline = await coreManagement.run(() => restoreCachedCore({
                paused,
                checkpoint: LIVE_CORE_CHECKPOINT,
                supported: () => this.liveCore.supported(this.xrayPath),
                running: async () => (await this.xrayProcess.getStatus()).up,
                start: () => this.xrayProcess.start(),
                ready: async () => (await this.getXrayInternalStatus()).isStarted,
            }));
        } catch (error: unknown) {
            this.logger.error(`Error in Application Bootstrap: ${error}`);
        }
    }

    public async startXray(
        body: StartXrayCommand.Request,
        ip: string,
    ): Promise<TResult<StartXrayResponseModel>> {
        return coreManagement.run(() => this.startXrayLocked(body, ip));
    }

    private async startXrayLocked(
        body: StartXrayCommand.Request,
        ip: string,
    ): Promise<TResult<StartXrayResponseModel>> {
        const interfaceStats = await this.queryBus.execute(new GetInterfaceStatsQuery());
        const tm = performance.now();
        const system = {
            info: getSystemInfo(),
            stats: getSystemStats(),
            interface: interfaceStats,
        };

        if (this.isXrayStartedProccesing) {
            this.logger.warn('Request already in progress');
            return ok(
                new StartXrayResponseModel(
                    false,
                    this.xrayVersion,
                    'Request already in progress',
                    {
                        version: this.nodeVersion,
                    },
                    system,
                ),
            );
        }

        this.isXrayStartedProccesing = true;
        let preserveRunningCore = this.isXrayOnline;
        let requireLiveApply = !!body.internals.requireLiveApply;
        const portPlan = body.internals.portPlan;
        const rawProfileGraphs = body.xrayConfig.remnacustProfileGraphs;

        try {
            if (rawProfileGraphs !== undefined &&
                (!portPlan?.enabled || !portPlan.delivery ||
                    !(await this.liveCore.profilesSupported(this.xrayPath))))
                throw new Error('This profile graph delivery requires a versioned port plan and a compatible core');
            const savedPortPlan = await this.portPlans.read();
            const inputsHash = portPlan?.delivery
                ? portPlanInputsHash(
                      body.xrayConfig,
                      body.internals.integrations,
                      body.internals.metadata,
                  )
                : undefined;
            requireLiveApply ||=
                !body.internals.forceRestart && (!!savedPortPlan?.required || !!portPlan?.enabled);
            if (savedPortPlan && !portPlan)
                throw new Error(
                    'This node has a saved port plan; an unversioned configuration cannot replace it',
                );
            if (body.internals.requireLiveApply && body.internals.forceRestart)
                throw new Error('A port plan cannot request a maintenance restart');
            let liveSupported: boolean | undefined;
            if (requireLiveApply || portPlan?.enabled || savedPortPlan?.required) {
                liveSupported = await this.liveCore.supported(this.xrayPath);
                if (!liveSupported)
                    throw new Error(
                        'Update Xray Core: this port plan requires native live application',
                    );
                if (requireLiveApply) {
                    preserveRunningCore = (await this.xrayProcess.getStatus()).up;
                    if (!preserveRunningCore) this.isXrayOnline = false;
                }
            }
            if (
                this.reconciliation &&
                !this.reconciliation.accepts(body.internals.reconciliation)
            ) {
                throw new Error(
                    'An older device revision cannot replace the configuration already applied by this node',
                );
            }
            if (portPlan) await this.portPlans.begin(portPlan);
            if (!this.isXrayOnline && !body.internals.forceRestart) {
                const status = await this.xrayProcess.getStatus();
                if (status.up) this.isXrayOnline = (await this.xtlsSdk.stats.getSysStats()).isOk;
            }
            const integrations = await this.integrations.sync(
                body.internals.integrations,
                body.internals.metadata,
            );

            if (integrations.error) {
                this.logger.error(`Failed to sync integrations: ${integrations.error}`);
                return ok(
                    new StartXrayResponseModel(
                        false,
                        null,
                        integrations.error,
                        {
                            version: this.nodeVersion,
                        },
                        system,
                    ),
                );
            }

            if (
                this.isXrayOnline &&
                !this.disableHashedSetCheck &&
                !body.internals.forceRestart &&
                (!portPlan?.delivery ||
                    (!savedPortPlan?.pluginDirty &&
                        savedPortPlan?.appliedInputsHash === inputsHash))
            ) {
                const { isOk } = await this.xtlsSdk.stats.getSysStats();

                let shouldRestart = false;

                if (isOk) {
                    shouldRestart = this.internalService.isNeedRestartCore(body.internals.hashes);
                } else {
                    this.isXrayOnline = false;
                    shouldRestart = true;

                    this.logger.warn(`Xray Core health check failed, restarting...`);
                }

                if (!shouldRestart) {
                    if (portPlan) await this.portPlans.complete(portPlan, inputsHash);
                    await this.reconciliation?.enroll(body.internals.reconciliation);
                    return ok(
                        new StartXrayResponseModel(
                            true,
                            this.xrayVersion,
                            null,
                            {
                                version: this.nodeVersion,
                            },
                            system,
                        ),
                    );
                }
            }

            if (body.internals.forceRestart) {
                this.logger.warn('Force restart requested');
            }

            const tblockerState = await this.queryBus.execute(new GetTorrentBlockerStateQuery());

            const rootSource = { ...body.xrayConfig };
            delete rootSource.remnacustProfileGraphs;
            const fullConfig = generateApiConfig({
                config: rootSource,
                torrentBlockerState: tblockerState,
                internal: this.internal,
            });
            const profileInput = rawProfileGraphs !== undefined
                ? makeProfileInput(fullConfig, rawProfileGraphs, portPlan!, inputsHash!)
                : undefined;
            if (profileInput) {
                const tags = new Map<string, string>();
                const geodata = new Set(profileInput.graphs.map(graph => portPlanInputsHash(graph.config.geodata)));
                if (geodata.size > 1)
                    throw new Error('Profiles on one node must select the same core and geodata release');
                for (const graph of profileInput.graphs) {
                    const tag = (graph.config.inbounds as { tag: string }[])[0].tag;
                    const owner = `${graph.configProfileUuid}:${graph.configProfileInboundUuid}`;
                    if (tags.has(tag) && tags.get(tag) !== owner)
                        throw new Error('User reconciliation requires distinct inbound tags across different source inbounds');
                    tags.set(tag, owner);
                }
                for (const graph of profileInput.graphs)
                    graph.config = generateApiConfig({
                        config: graph.config, torrentBlockerState: tblockerState,
                        internal: this.internal, control: false,
                    });
            }
            const rememberConfiguration = () => this.internalService.extractUsersFromConfig(
                body.internals.hashes,
                profileInput ? { ...fullConfig, inbounds: profileInput.graphs.flatMap(graph =>
                    Array.isArray(graph.config.inbounds) ? graph.config.inbounds : []) } : fullConfig,
                profileInput?.graphs.map(graph => ({
                    bindingUuid: graph.bindingUuid,
                    inboundTag: (graph.config.inbounds as { tag: string }[])[0].tag,
                })),
                profileInput,
            );

            if ((await this.managedCore.load()).paused) {
                return ok(
                    new StartXrayResponseModel(
                        false,
                        this.xrayVersion,
                        'Core paused by administrator',
                        { version: this.nodeVersion },
                        system,
                    ),
                );
            }

            await this.coreLoaderService.prepare(fullConfig.geodata);
            await this.geodataService.prepare(fullConfig.geodata);
            if (profileInput) {
                for (const graph of profileInput.graphs) {
                    await this.coreLoaderService.prepare(graph.config.geodata);
                    await this.geodataService.prepare(graph.config.geodata);
                }
            }

            liveSupported ??= await this.liveCore.supported(this.xrayPath);
            if (requireLiveApply && preserveRunningCore && !this.isXrayOnline)
                throw new Error(
                    'The running core is not ready for live application; its process was preserved',
                );
            if (this.isXrayOnline && liveSupported && !body.internals.forceRestart) {
                let replay = false;
                if (profileInput) {
                    const acknowledgement = await this.liveCore.applyProfiles(
                        this.xrayPath, this.internal.xtlsApiSocketPath, profileInput,
                    );
                    replay = acknowledgement.unchanged;
                    if (replay && (!this.internalService.hasProfileBindings() || !this.internalService.hasConfiguration()))
                        throw new Error('The core retained a replayed delivery; request a fresh panel delivery to rebuild node user state');
                } else await this.liveCore.apply(
                    this.xrayPath,
                    this.internal.xtlsApiSocketPath,
                    fullConfig,
                );
                // Replay preserves subsequent native user mutations. Replacing
                // the index from an old source would resurrect stale membership.
                if (!replay) await rememberConfiguration();
                await this.commandBus.execute(new RunPostStartCommand(body.internals.metadata));
                if (portPlan) await this.portPlans.complete(portPlan, inputsHash);
                await this.reconciliation?.enroll(body.internals.reconciliation);
                return ok(
                    new StartXrayResponseModel(
                        true,
                        this.xrayVersion,
                        null,
                        { version: this.nodeVersion },
                        system,
                    ),
                );
            }

            if (liveSupported) {
                await validateCoreConfig(this.xrayPath, fullConfig, this.managedCore.root);
                if (profileInput) await this.liveCore.prepareProfileRestart(this.xrayPath, profileInput);
                else await this.liveCore.prepareRestart(this.xrayPath, fullConfig);
            }
            if (!profileInput) await rememberConfiguration();

            const xrayProcess = await this.restartXrayProcess();

            if (xrayProcess.error) {
                this.logger.error(`Failed to (re)start Xray process via s6: ${xrayProcess.error}`);

                return ok(
                    new StartXrayResponseModel(
                        false,
                        null,
                        xrayProcess.error,
                        { version: this.nodeVersion },
                        system,
                    ),
                );
            }

            const { isStarted, error: startError } = await this.getXrayInternalStatus();

            if (!isStarted) {
                this.isXrayOnline = false;

                this.logger.error(`Xray Core v${this.xrayVersion} failed to start.`, {
                    timestamp: new Date().toISOString(),
                    ...KNOWN_ERRORS.XRAY_FAILED_TO_START,
                });

                const tail = await this.dumpTailBlock(XRAY_LOG_FILE, 5);
                const logReason = tail.at(-1)?.trim().slice(0, 500);

                return ok(
                    new StartXrayResponseModel(
                        isStarted,
                        this.xrayVersion,
                        logReason ? `${startError} · ${logReason}` : startError,
                        {
                            version: this.nodeVersion,
                        },
                        system,
                    ),
                );
            }

            this.isXrayOnline = true;

            await this.refreshXrayVersion();
            if (profileInput) await rememberConfiguration();

            this.logger.log(`✔ XRay Core v${this.xrayVersion} is up and running.`);

            await this.commandBus.execute(new RunPostStartCommand(body.internals.metadata));
            if (portPlan) await this.portPlans.complete(portPlan, inputsHash);
            await this.reconciliation?.enroll(body.internals.reconciliation);

            return ok(
                new StartXrayResponseModel(
                    isStarted,
                    this.xrayVersion,
                    null,
                    {
                        version: this.nodeVersion,
                    },
                    system,
                ),
            );
        } catch (error) {
            let errorMessage = null;
            if (error instanceof Error) {
                errorMessage = error.message;
            }

            this.logger.error(`Failed to start Xray: ${errorMessage}`);

            return ok(
                new StartXrayResponseModel(
                    requireLiveApply && (this.isXrayOnline || preserveRunningCore),
                    requireLiveApply ? this.xrayVersion : null,
                    errorMessage,
                    {
                        version: this.nodeVersion,
                    },
                    system,
                ),
            );
        } finally {
            this.logger.log(
                `Attempt to start XTLS took: ${ems(performance.now() - tm, {
                    extends: 'short',
                    includeMs: true,
                })} (IP: ${ip})`,
            );

            this.isXrayStartedProccesing = false;
        }
    }

    public async stopXray(args: {
        withPluginCleanup?: boolean;
        withOnlineCheck?: boolean;
    }): Promise<TResult<StopXrayResponseModel>> {
        return coreManagement.run(() => this.stopXrayLocked(args));
    }

    private async stopXrayLocked(args: {
        withPluginCleanup?: boolean;
        withOnlineCheck?: boolean;
    }): Promise<TResult<StopXrayResponseModel>> {
        if (this.isXrayStartedProccesing) return ok(new StopXrayResponseModel(false));
        this.isXrayStartedProccesing = true;
        const { withPluginCleanup = false, withOnlineCheck = false } = args;
        try {
            if (withPluginCleanup) {
                await this.commandBus.execute(new ResetPluginsCommand());
            }

            if (withOnlineCheck && !this.isXrayOnline) {
                return ok(new StopXrayResponseModel(true));
            }

            await this.killAllXrayProcesses();
            await this.integrations.stop();

            this.isXrayOnline = false;
            this.internalService.cleanup();

            return ok(new StopXrayResponseModel(true));
        } catch (error) {
            this.logger.error(`Failed to stop Xray Process: ${error}`);
            return ok(new StopXrayResponseModel(false));
        } finally {
            this.isXrayStartedProccesing = false;
        }
    }

    public async getManagedCoreStatus() {
        const state = await this.managedCore.load();
        const processStatus = await this.xrayProcess.getStatus();
        // /proc identifies the running image even if rw-core was switched afterwards.
        const running =
            processStatus.up && processStatus.pid
                ? await this.managedCore
                      .identity(`/proc/${processStatus.pid}/exe`)
                      .catch(() => null)
                : null;
        const selected = await this.managedCore.identity().catch(() => null);
        return {
            capabilityVersion: 1,
            platform: process.platform,
            arch: process.arch === 'x64' ? 'amd64' : process.arch,
            mode: state.mode,
            paused: state.paused,
            online: this.isXrayOnline && processStatus.up,
            running,
            selected,
            canRollback: !!state.previous,
            operation: state.operation ?? null,
            history: state.history,
        };
    }

    public async queueManagedCoreAction(request: {
        id: string;
        action: CoreAction;
        release?: CoreRelease;
    }) {
        const state = await this.managedCore.load();
        const prior = [state.operation, ...state.history].find((op) => op?.id === request.id);
        if (prior) return prior;
        if (this.isXrayStartedProccesing)
            throw new ConflictException('A node operation is already running');
        if (request.action === 'install') {
            if (!request.release) throw new BadRequestException('Select a release');
            try {
                validateCoreRelease(request.release);
            } catch (error) {
                throw new BadRequestException((error as Error).message);
            }
        }
        if (request.action === 'rollback' && !state.previous)
            throw new BadRequestException('No previous core');
        this.isXrayStartedProccesing = true;
        try {
            await this.managedCore.begin(request.id, request.action);
            void this.executeManagedCoreAction(request)
                .catch(() => this.logger.error('Core operation journal could not be finalized'))
                .finally(() => {
                    this.isXrayStartedProccesing = false;
                });
            return (await this.managedCore.load()).operation;
        } catch {
            this.isXrayStartedProccesing = false;
            throw new BadRequestException(
                'Cannot prepare core operation; check available disk space and node storage',
            );
        }
    }

    private async executeManagedCoreAction(request: {
        id: string;
        action: CoreAction;
        release?: CoreRelease;
    }) {
        const before = await this.managedCore.load();
        const wasUp = (await this.xrayProcess.getStatus()).up;
        const temporary = join(this.managedCore.root, request.id + '.staged');
        let switched = false;
        let releaseManagement: (() => void) | undefined;
        try {
            const config = await this.internalService.getXrayConfig();
            const profileInput = this.internalService.getProfileInput();
            let selection: CoreSelection = {
                mode: before.mode,
                paused: before.paused,
                binary: before.binary,
            };
            if (request.action === 'stop') {
                releaseManagement = coreManagement.acquire();
                await this.managedCore.phase('stopping');
                await this.xrayProcess.stop();
                this.isXrayOnline = false;
                await this.managedCore.select({ ...selection, paused: true });
            } else {
                if (request.action === 'install' && request.release) {
                    await this.managedCore.phase('downloading');
                    await downloadFile(request.release.url, temporary, {
                        expectedSha256: request.release.sha256,
                        allowRedirects: false,
                        maxSize: 128 * 1024 * 1024,
                        totalTimeoutMs: 180_000,
                        idleTimeoutMs: 15_000,
                    });
                    await this.managedCore.phase('verifying');
                    const file = await open(temporary, 'r');
                    try {
                        const header = Buffer.alloc(20);
                        await file.read(header, 0, 20, 0);
                        const machine = request.release.arch === 'amd64' ? 62 : 183;
                        if (
                            header.toString('hex', 0, 4) !== '7f454c46' ||
                            header[4] !== 2 ||
                            header[5] !== 1 ||
                            header.readUInt16LE(18) !== machine
                        )
                            throw new Error('Invalid ELF architecture');
                    } finally {
                        await file.close();
                    }
                    await chmod(temporary, 0o755);
                    const binary = await this.managedCore.identity(temporary);
                    if (!binary.version.includes(request.release.build))
                        throw new Error('Release build mismatch');
                    const path = join(this.managedCore.root, binary.sha256);
                    await rename(temporary, path);
                    selection = {
                        mode: 'managed',
                        paused: before.paused,
                        binary: { ...binary, path },
                    };
                } else if (request.action === 'rollback') {
                    selection = { ...before.previous!, paused: before.paused };
                    if (
                        selection.binary &&
                        (await this.managedCore.identity(selection.binary.path)).sha256 !==
                            selection.binary.sha256
                    )
                        throw new Error('Rollback integrity check failed');
                } else if (request.action === 'bundled') {
                    selection = {
                        mode: 'bundled',
                        paused: before.paused,
                        binary: await this.managedCore.identity(this.managedCore.stock),
                    };
                } else if (request.action === 'profile') {
                    releaseManagement = coreManagement.acquire();
                    selection = { mode: 'profile', paused: before.paused };
                    switched = true;
                    await this.managedCore.select(selection);
                    await this.coreLoaderService.prepare(profileInput?.graphs[0]?.config.geodata ?? config.geodata);
                }
                await this.managedCore.phase('validating');
                const binary = selection.binary?.path ?? this.managedCore.link;
                if (profileInput) {
                    await this.liveCore.validateProfiles(binary, profileInput);
                    for (const graph of profileInput.graphs)
                        await validateCoreConfig(binary, graph.config, this.managedCore.root);
                } else await validateCoreConfig(binary, config, this.managedCore.root);
                if (request.action !== 'check') {
                    releaseManagement ??= coreManagement.acquire();
                    if (request.action === 'start' || request.action === 'restart')
                        selection.paused = false;
                    switched = true;
                    await this.managedCore.phase('switching');
                    await this.managedCore.select(selection);
                    if (!selection.paused) {
                        if (profileInput) await this.liveCore.prepareProfileRestart(binary, profileInput);
                        await this.startManagedCore();
                    }
                }
            }
            await this.refreshXrayVersion();
            await this.managedCore.finish('succeeded');
        } catch {
            // Do not return download errors, configuration contents or authorization headers to the panel.
            const phase = (await this.managedCore.load()).operation?.phase ?? 'preparing';
            try {
                await this.managedCore.restore();
                if (switched) {
                    if (wasUp) await this.startManagedCore();
                    else {
                        await this.xrayProcess.stop();
                        this.isXrayOnline = false;
                    }
                }
                await this.managedCore.finish(
                    switched ? 'rolled-back' : 'failed',
                    `Operation failed during ${phase}. Previous core selection preserved.`,
                );
            } catch {
                this.isXrayOnline = false;
                await this.managedCore.finish(
                    'failed',
                    `Operation failed during ${phase}; automatic recovery failed. Check the node before retrying.`,
                );
            }
        } finally {
            releaseManagement?.();
            await rm(temporary, { force: true }).catch(() => undefined);
        }
    }

    private async startManagedCore() {
        await this.managedCore.phase('starting');
        const result = await this.restartXrayProcess();
        if (result.error) throw new Error('Core process failed to start');
        await this.managedCore.phase('checking-health');
        const readiness = await this.getXrayInternalStatus();
        if (!readiness.isStarted) throw new Error('Core readiness check failed');
        this.isXrayOnline = true;
    }

    public async getNodeHealthCheck(): Promise<TResult<GetNodeHealthCheckResponseModel>> {
        try {
            const status = await this.xrayProcess.getStatus();
            if (!status.up) this.isXrayOnline = false;
            else if (!this.isXrayOnline)
                this.isXrayOnline = (await this.xtlsSdk.stats.getSysStats()).isOk;
            return ok(
                new GetNodeHealthCheckResponseModel(
                    true,
                    this.isXrayOnline,
                    this.xrayVersion,
                    this.nodeVersion,
                    await this.liveCore.supported(this.xrayPath).catch(() => false),
                    (await this.portPlans.read())?.delivery?.epoch ?? '0',
                    await this.liveCore.profilesSupported(this.xrayPath).catch(() => false),
                ),
            );
        } catch (error) {
            this.logger.error(`Failed to get node health check: ${error}`);

            return ok(new GetNodeHealthCheckResponseModel(false, false, null, this.nodeVersion));
        }
    }

    public async killAllXrayProcesses(): Promise<void> {
        try {
            await this.xrayProcess.stop();

            this.logger.log('s6: Xray process stopped.');
        } catch (error) {
            this.logger.log(`s6: Failed to stop Xray process. Error: ${error}`);
        }
    }

    private async refreshXrayVersion(): Promise<void> {
        const version = await this.xrayProcess.getCoreVersion();

        if (version) {
            this.xrayVersion = version;
        }
    }

    public getXrayInfo(): {
        version: string | null;
        path: string;
    } {
        return {
            version: this.xrayVersion,
            path: this.xrayPath,
        };
    }

    private async getXrayInternalStatus(): Promise<{
        isStarted: boolean;
        error: string | null;
    }> {
        const tm = performance.now();

        const startedPid = (await this.xrayProcess.getStatus()).pid;

        try {
            await pRetry(
                async () => {
                    const { isOk, message } = await this.xtlsSdk.stats.getSysStats();
                    const status = await this.xrayProcess.getStatus();

                    if (!status.up || (startedPid !== null && status.pid !== startedPid)) {
                        throw new AbortError(
                            new XrayProcessDownError(
                                `Xray Core process is not running anymore (s6: ${await this.xrayProcess.getStatusLine()})`,
                            ),
                        );
                    }

                    if (isOk) return;

                    throw new Error(message);
                },
                {
                    retries: 30,
                    minTimeout: 100,
                    maxTimeout: 2000,
                    factor: 1.5,
                    onFailedAttempt: (context) => {
                        this.logger.warn(
                            `▸ XRay Core status check, ${context.attemptNumber}/${context.attemptNumber + context.retriesLeft} · elapsed ${ems(
                                performance.now() - tm,
                                {
                                    extends: 'short',
                                    includeMs: true,
                                },
                            )} · retrying in ${context.retryDelay}ms`,
                        );
                    },
                },
            );

            return { isStarted: true, error: null };
        } catch (error) {
            this.logger.error(`Failed to get Xray internal status: ${error}`);

            return {
                isStarted: false,
                error:
                    error instanceof XrayProcessDownError
                        ? error.message
                        : 'Xray Core did not become ready in time',
            };
        }
    }

    private async restartXrayProcess(): Promise<{
        error: string | null;
    }> {
        try {
            await this.xrayProcess.stop();

            await this.commandBus.execute(new RunPreStartCommand());

            await this.xrayProcess.start();

            return { error: null };
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    public async tailLogLines(path: string, n = 10): Promise<string[]> {
        try {
            const { stdout } = await execFileAsync('tail', ['-n', String(n), path]);
            return stdout.split('\n').filter(Boolean);
        } catch {
            return [];
        }
    }

    private async dumpTailBlock(path: string, lines: number): Promise<string[]> {
        const tail = await this.tailLogLines(path, lines);
        if (tail.length === 0) return tail;

        this.logger.error(
            [
                'Xray Core Log Tail',
                `${'─'.repeat(8)} ${path} (${tail.length} lines) ${'─'.repeat(8)}`,
                ...tail.map((l) => `│ ${l}`),
            ].join('\n'),
        );

        return tail;
    }
}
