import { getSemaphore } from '@henrygd/semaphore';
import ems from 'enhanced-ms';
import pMap from 'p-map';

import { Injectable, Logger } from '@nestjs/common';

import { HashedSet } from '@remnawave/hashed-set';

import { StartXrayCommand } from '@libs/contracts/commands';
import type { ProfileInput } from '../xray-core/profile-input';

@Injectable()
export class InternalService {
    private readonly logger = new Logger(InternalService.name);
    private readonly mutex = getSemaphore();

    private xrayConfig: null | Record<string, unknown> = null;
    private emptyConfigHash: null | string = null;
    private inboundsHashMap: Map<string, HashedSet> = new Map();
    private xtlsConfigInbounds: Set<string> = new Set();
    private profileBindings: Map<string, string[]> = new Map();
    private profileInput: ProfileInput | null = null;
    private configurationReady = false;

    public hasConfiguration(): boolean { return this.configurationReady; }
    public hasProfileBindings(): boolean { return this.profileInput !== null; }

    public getProfileInput(): ProfileInput | null {
        return this.profileInput ? structuredClone(this.profileInput) : null;
    }

    constructor() {}

    public async getXrayConfig(): Promise<Record<string, unknown>> {
        if (!this.xrayConfig) {
            return {};
        }

        return this.xrayConfig;
    }

    public setXrayConfig(config: Record<string, unknown>): void {
        this.xrayConfig = config;
    }

    public async extractUsersFromConfig(
        hashes: StartXrayCommand.Request['internals']['hashes'],
        newConfig: Record<string, unknown>,
        profileBindings: readonly { bindingUuid: string; inboundTag: string }[] = [],
        profileInput?: ProfileInput,
    ): Promise<void> {
        const index = new Map<string, string[]>();
        const seen = new Set<string>();
        if (profileBindings.length > 512) throw new Error('Too many profile bindings');
        for (const binding of profileBindings) {
            if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(binding.bindingUuid) ||
                typeof binding.inboundTag !== 'string' || !binding.inboundTag ||
                binding.inboundTag.length > 200 || seen.has(binding.bindingUuid) ||
                !Array.isArray(newConfig.inbounds) ||
                !newConfig.inbounds.some(inbound => inbound?.tag === binding.inboundTag))
                throw new Error('Invalid profile binding index');
            seen.add(binding.bindingUuid);
            const matches = index.get(binding.inboundTag) ?? [];
            matches.push(binding.bindingUuid);
            index.set(binding.inboundTag, matches);
        }
        this.cleanup();
        this.profileBindings = index;
        this.profileInput = profileInput ? structuredClone(profileInput) : null;

        this.emptyConfigHash = hashes.emptyConfig;
        this.xrayConfig = newConfig;

        this.logger.debug(JSON.stringify(hashes));

        this.logger.log(`Starting user extraction from inbounds...`);
        this.logger.log(`▸ Empty Config Hash: ${this.emptyConfigHash}`);

        const start = performance.now();
        if (newConfig.inbounds && Array.isArray(newConfig.inbounds)) {
            const validTags = new Set(hashes.inbounds.map((item) => item.tag));
            const remoteHashByTag = new Map(hashes.inbounds.map((i) => [i.tag, i.hash]));

            await pMap(
                newConfig.inbounds,
                async (inbound) => {
                    const inboundTag: string = inbound.tag;

                    if (!inboundTag || !validTags.has(inboundTag)) {
                        return;
                    }

                    const usersSet = new HashedSet();

                    if (
                        inbound.settings &&
                        inbound.settings.clients &&
                        Array.isArray(inbound.settings.clients)
                    ) {
                        for (const client of inbound.settings.clients) {
                            if (client.id) {
                                usersSet.add(client.id);
                            }
                        }
                    }

                    this.inboundsHashMap.set(inboundTag, usersSet);
                },
                { concurrency: 20 },
            );

            for (const [inboundTag, usersSet] of this.inboundsHashMap) {
                this.xtlsConfigInbounds.add(inboundTag);

                this.logger.log(
                    `▸ ${inboundTag} · ${String(usersSet.size)} users · ${usersSet.hash64String} (${remoteHashByTag.get(inboundTag) ?? 'N/A'})`,
                );
            }
        }

        const result = ems(performance.now() - start, {
            extends: 'short',
            includeMs: true,
        });

        this.logger.log(`User extraction completed in ${result ? result : '0ms'}`);
        this.configurationReady = true;
    }

    public isNeedRestartCore(
        incomingHashes: StartXrayCommand.Request['internals']['hashes'],
    ): boolean {
        const start = performance.now();
        try {
            if (!this.configurationReady || !this.emptyConfigHash) {
                return true;
            }

            if (incomingHashes.emptyConfig !== this.emptyConfigHash) {
                this.logger.warn('Detected changes in Xray Core base configuration');
                return true;
            }

            if (incomingHashes.inbounds.length !== this.inboundsHashMap.size) {
                this.logger.warn('Number of Xray Core inbounds has changed');
                return true;
            }

            for (const [inboundTag, usersSet] of this.inboundsHashMap) {
                const incomingInbound = incomingHashes.inbounds.find(
                    (item) => item.tag === inboundTag,
                );

                if (!incomingInbound) {
                    this.logger.warn(
                        `Inbound ${inboundTag} no longer exists in Xray Core configuration`,
                    );
                    return true;
                }

                if (usersSet.hash64String !== incomingInbound.hash) {
                    this.logger.warn(
                        `User configuration changed for inbound ${inboundTag} (${usersSet.hash64String} → ${incomingInbound.hash})`,
                    );
                    return true;
                }
            }

            this.logger.log('Xray Core configuration is up-to-date - no restart required');

            return false;
        } catch (error) {
            this.logger.error(`Failed to check if Xray Core restart is needed: ${error}`);
            return true;
        } finally {
            const result = ems(performance.now() - start, {
                extends: 'short',
                includeMs: true,
            });
            this.logger.log(`Configuration hash check completed in ${result ? result : '0ms'}`);
        }
    }

    public async addUserToInbound(inboundTag: string, user: string): Promise<void> {
        await this.mutex.acquire();

        try {
            const usersSet = this.inboundsHashMap.get(inboundTag);

            if (!usersSet) {
                this.logger.warn(
                    `Inbound ${inboundTag} not found in inboundsHashMap, creating new one`,
                );

                this.inboundsHashMap.set(inboundTag, new HashedSet([user]));

                return;
            }

            usersSet.add(user);
        } catch (error) {
            this.logger.error(`Failed to add user to inbound ${inboundTag}: ${error}`);
        } finally {
            this.mutex.release();
        }
    }

    public async removeUserFromInbound(inboundTag: string, user: string): Promise<void> {
        await this.mutex.acquire();

        try {
            const usersSet = this.inboundsHashMap.get(inboundTag);

            if (!usersSet) {
                return;
            }

            usersSet.delete(user);

            if (usersSet.size === 0) {
                this.xtlsConfigInbounds.delete(inboundTag);
                this.inboundsHashMap.delete(inboundTag);

                this.logger.warn(`Inbound ${inboundTag} has no users, clearing inboundsHashMap.`);
            }
        } catch (error) {
            this.logger.error(`Failed to remove user from inbound ${inboundTag}: ${error}`);
        } finally {
            this.mutex.release();
        }
    }

    public getXtlsConfigInbounds(): Set<string> {
        return this.xtlsConfigInbounds;
    }

    public getProfileBindingsForTag(tag: string): readonly string[] {
        return [...(this.profileBindings.get(tag) ?? [])];
    }

    public hasUserInInbound(inboundTag: string, vlessUuid: string): boolean {
        return this.inboundsHashMap.get(inboundTag)?.has(vlessUuid) ?? false;
    }

    public addXtlsConfigInbound(inboundTag: string): void {
        this.xtlsConfigInbounds.add(inboundTag);
    }

    public cleanup(): void {
        this.logger.log('Cleaning up internal service.');
        this.configurationReady = false;

        this.inboundsHashMap.clear();
        this.xtlsConfigInbounds.clear();
        this.profileBindings.clear();
        this.profileInput = null;
        this.xrayConfig = null;
        this.emptyConfigHash = null;
    }
}
