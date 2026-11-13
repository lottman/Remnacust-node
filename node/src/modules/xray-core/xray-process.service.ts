import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { Injectable, Logger } from '@nestjs/common';

import { isPrivateXtlsSocketAvailable } from '@common/utils/private-xtls-socket';
import { readCoreVersion } from '@common/utils/read-core-version';

const execFileAsync = promisify(execFile);

export interface IXrayProcessStatus {
    up: boolean;
    pid: number | null;
    raw: string;
}

@Injectable()
export class XrayProcessService {
    private readonly logger = new Logger(XrayProcessService.name);

    private readonly serviceDir: string;
    private readonly controlFifo: string;
    private statusFailureReported = false;

    private static readonly S6_SVC = '/command/s6-svc';
    private static readonly S6_SVSTAT = '/command/s6-svstat';
    private static readonly CORE_LINK = '/usr/local/bin/rw-core';

    private static readonly DOWN_TIMEOUT_MS = 10_000;
    private static readonly UP_TIMEOUT_MS = 10_000;

    constructor() {
        this.serviceDir = process.env.XRAY_S6_SERVICE_DIR ?? '/run/service/xray';
        this.controlFifo = `${this.serviceDir}/supervise/control`;
    }

    public isControlAvailable(): boolean {
        return existsSync(this.controlFifo);
    }

    public async stop(): Promise<void> {
        await execFileAsync(
            XrayProcessService.S6_SVC,
            ['-wd', '-T', String(XrayProcessService.DOWN_TIMEOUT_MS), '-d', this.serviceDir],
            { timeout: XrayProcessService.DOWN_TIMEOUT_MS + 2000, maxBuffer: 16 * 1024 },
        );
    }

    public async start(): Promise<void> {
        await execFileAsync(
            XrayProcessService.S6_SVC,
            ['-wu', '-T', String(XrayProcessService.UP_TIMEOUT_MS), '-o', this.serviceDir],
            { timeout: XrayProcessService.UP_TIMEOUT_MS + 2000, maxBuffer: 16 * 1024 },
        );
    }

    public isApiSocketAvailable(socket = process.env.XTLS_API_SOCKET_PATH): boolean {
        return !!socket && isPrivateXtlsSocketAvailable(socket);
    }

    public async probeApi(binary: string, socket: string, expectedPid: number): Promise<boolean> {
        if (!this.isApiSocketAvailable(socket)) return false;
        try {
            const { stdout } = await execFileAsync(
                binary,
                ['api', 'statssys', `--server=unix:${socket}`, '--timeout=2'],
                { timeout: 3000, maxBuffer: 8 * 1024 },
            );
            const response: unknown = JSON.parse(stdout);
            const current = await this.getStatus();
            return (
                current.up &&
                current.pid === expectedPid &&
                !!response &&
                typeof response === 'object' &&
                !Array.isArray(response)
            );
        } catch {
            return false;
        }
    }

    public async recoveryReady(binary: string, socket: string): Promise<boolean> {
        const initial = await this.getStatus();
        if (!initial.up || initial.pid === null) return false;
        for (let attempt = 0; attempt < 5; attempt++) {
            if (await this.probeApi(binary, socket, initial.pid)) return true;
            const current = await this.getStatus();
            if (!current.up || current.pid !== initial.pid) return false;
            if (attempt < 4) await delay(200);
        }
        return false;
    }

    public async getCoreVersion(): Promise<null | string> {
        try {
            return (await readCoreVersion(XrayProcessService.CORE_LINK)).semver;
        } catch (error) {
            this.logger.warn(`Failed to read xray core version: ${error}`);
            return null;
        }
    }

    public async getStatusLine(): Promise<string> {
        try {
            const { stdout } = await execFileAsync(XrayProcessService.S6_SVSTAT, [this.serviceDir]);

            return stdout.trim();
        } catch (error) {
            return `unavailable (${error instanceof Error ? error.message : String(error)})`;
        }
    }

    public async getStatus(): Promise<IXrayProcessStatus> {
        try {
            const { stdout } = await execFileAsync(
                XrayProcessService.S6_SVSTAT,
                ['-o', 'up,pid', this.serviceDir],
                { timeout: 2000, maxBuffer: 4096 },
            );

            const raw = stdout.trim();
            const match = /^(true [1-9][0-9]*|false -1)$/.exec(raw);
            if (!match) return { up: false, pid: null, raw: '' };
            const [up, pid] = raw.split(' ');
            const pidNum = Number(pid);
            if (!Number.isSafeInteger(pidNum)) return { up: false, pid: null, raw: '' };
            this.statusFailureReported = false;

            return {
                up: up === 'true',
                pid: Number.isFinite(pidNum) && pidNum > 0 ? pidNum : null,
                raw,
            };
        } catch (error) {
            if (!this.statusFailureReported)
                this.logger.warn(`Failed to read xray s6 status: ${error}`);
            this.statusFailureReported = true;
            return { up: false, pid: null, raw: '' };
        }
    }
}
