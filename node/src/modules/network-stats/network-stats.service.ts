import { existsSync, readFileSync } from 'node:fs';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

import { IInterfaceRate, IInterfaceStats, INetworkSnapshot } from './interfaces';

const INTERVAL_MS = 1_000;
const INTERVAL_NAME = 'network-stats-poll';
const ROUTE_UP = 0x1;
const ROUTE_REJECT = 0x200;

@Injectable()
export class NetworkStatsService implements OnModuleInit {
    private readonly logger = new Logger(NetworkStatsService.name);

    private static readonly PROC_NET_DEV = '/proc/net/dev';
    private static readonly PROC_NET_ROUTE = '/proc/net/route';
    private static readonly PROC_NET_IPV6_ROUTE = '/proc/net/ipv6_route';

    private isAvailable: boolean = false;
    private previousStats = new Map<string, IInterfaceStats>();
    private currentRates = new Map<string, IInterfaceRate>();
    private defaultIface: string | null = null;
    private updatedAt: Date = new Date();

    constructor(private readonly schedulerRegistry: SchedulerRegistry) {}

    onModuleInit(): void {
        const isAvailable = existsSync(NetworkStatsService.PROC_NET_DEV);
        if (!isAvailable) {
            this.logger.warn(
                `${NetworkStatsService.PROC_NET_DEV} not found — network stats polling disabled (non-Linux OS?)`,
            );
            return;
        } else {
            this.isAvailable = true;
        }

        this.defaultIface = this.resolveDefaultInterface();
        this.previousStats = this.readProcNetDev();
        this.updatedAt = new Date();

        const interval = setInterval(() => this.tick(), INTERVAL_MS);
        this.schedulerRegistry.addInterval(INTERVAL_NAME, interval);

        this.logger.log(
            `Network stats polling started (interval: ${INTERVAL_MS}ms, default: ${this.defaultIface ?? 'unknown'})`,
        );
    }

    getSnapshot(): INetworkSnapshot {
        return {
            isAvailable: this.isAvailable,
            interfaces: [...this.currentRates.values()],
            defaultInterface: this.defaultIface,
            updatedAt: this.updatedAt,
        };
    }

    getByInterface(name: string): IInterfaceRate | null {
        return this.currentRates.get(name) ?? null;
    }

    getDefault(): IInterfaceRate | null {
        if (!this.defaultIface) return null;
        return this.currentRates.get(this.defaultIface) ?? null;
    }

    getDefaultInterfaceName(): string | null {
        return this.defaultIface;
    }

    private tick(): void {
        try {
            const now = this.readProcNetDev();

            for (const iface of this.currentRates.keys()) {
                if (!now.has(iface)) this.currentRates.delete(iface);
            }

            for (const [iface, current] of now) {
                const prev = this.previousStats.get(iface);
                if (!prev) continue;

                const elapsed = (current.timestamp - prev.timestamp) / 1_000;
                if (elapsed <= 0) continue;

                this.currentRates.set(iface, {
                    interface: iface,
                    rxBytesPerSec: Math.max(0, (current.rxBytes - prev.rxBytes) / elapsed),
                    txBytesPerSec: Math.max(0, (current.txBytes - prev.txBytes) / elapsed),
                    rxTotal: current.rxBytes,
                    txTotal: current.txBytes,
                });
            }

            this.previousStats = now;
            this.updatedAt = new Date();
        } catch (error) {
            this.logger.error('Failed to read network stats', error);
        }
    }

    private readProcNetDev(): Map<string, IInterfaceStats> {
        const result = new Map<string, IInterfaceStats>();
        const timestamp = Date.now();

        const content = readFileSync(NetworkStatsService.PROC_NET_DEV, 'utf-8');
        const lines = content.split('\n').slice(2);

        for (const line of lines) {
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;

            const iface = line.slice(0, colonIdx).trim();
            if (!iface) continue;

            const fields = line
                .slice(colonIdx + 1)
                .trim()
                .split(/\s+/);
            if (fields.length < 16) continue;

            const rxBytes = Number(fields[0]);
            const txBytes = Number(fields[8]);
            if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;

            result.set(iface, { rxBytes, txBytes, timestamp });
        }

        return result;
    }

    private resolveDefaultInterface(): string | null {
        try {
            if (!existsSync(NetworkStatsService.PROC_NET_ROUTE))
                return this.resolveIpv6DefaultInterface();

            const content = readFileSync(NetworkStatsService.PROC_NET_ROUTE, 'utf-8');
            const lines = content.split('\n').slice(1);

            let best: { iface: string; metric: number } | null = null;
            for (const line of lines) {
                const f = line.trim().split(/\s+/);
                if (f.length < 11) continue;

                const [iface, destination, , , , , metricStr] = f;
                if (destination !== '00000000') continue;

                const metric = Number(metricStr) || 0;
                if (!best || metric < best.metric) best = { iface, metric };
            }

            return best?.iface ?? this.resolveIpv6DefaultInterface();
        } catch {
            this.logger.warn('Could not resolve default interface from /proc/net/route');
            return this.resolveIpv6DefaultInterface();
        }
    }

    private resolveIpv6DefaultInterface(): string | null {
        try {
            if (!existsSync(NetworkStatsService.PROC_NET_IPV6_ROUTE)) return null;
            const content = readFileSync(NetworkStatsService.PROC_NET_IPV6_ROUTE, 'utf-8');
            const unspecified = '0'.repeat(32);
            let best: { iface: string; metric: number } | null = null;
            for (const line of content.split('\n')) {
                const fields = line.trim().split(/\s+/);
                if (fields.length !== 10) continue;
                const [
                    destination,
                    prefix,
                    source,
                    sourcePrefix,
                    ,
                    metricText,
                    ,
                    ,
                    flagsText,
                    iface,
                ] = fields;
                if (
                    destination !== unspecified ||
                    prefix !== '00' ||
                    source !== unspecified ||
                    sourcePrefix !== '00' ||
                    !/^[\da-f]{8}$/i.test(metricText) ||
                    !/^[\da-f]{8}$/i.test(flagsText)
                )
                    continue;
                const flags = Number.parseInt(flagsText, 16);
                if (!(flags & ROUTE_UP) || flags & ROUTE_REJECT) continue;
                const metric = Number.parseInt(metricText, 16);
                if (!best || metric < best.metric) best = { iface, metric };
            }
            return best?.iface ?? null;
        } catch {
            this.logger.warn('Could not resolve default interface from /proc/net/ipv6_route');
            return null;
        }
    }
}
