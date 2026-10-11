import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

import { StartXrayCommand } from '@libs/contracts/commands';

type Enrollment = NonNullable<StartXrayCommand.Request['internals']['reconciliation']>;
const STATE_FILE = '/var/lib/remnacust/run/node-reconciliation.json';

@Injectable()
export class NodeReconciliationService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(NodeReconciliationService.name);
    private enrollment: Enrollment | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;
    private running = false;
    private refresh = true;
    private controller: AbortController | null = null;
    private failureReported = false;
    private appliedGeneration = 0;

    async onApplicationBootstrap(): Promise<void> {
        try {
            const stored = JSON.parse(await readFile(STATE_FILE, 'utf8'));
            const parsed =
                StartXrayCommand.RequestSchema.shape.internals.shape.reconciliation.safeParse(
                    stored,
                );
            if (parsed.success && parsed.data) this.enrollment = parsed.data;
        } catch {
            /* A node is enrolled by its first authenticated start request. */
        }
        this.schedule(0);
    }

    async enroll(value?: Enrollment): Promise<void> {
        if (!value) return;
        const parsed =
            StartXrayCommand.RequestSchema.shape.internals.shape.reconciliation.parse(value)!;
        if (
            !(
                value.url === this.enrollment?.url &&
                value.token === this.enrollment?.token &&
                value.revision === this.enrollment?.revision
            )
        ) {
            await mkdir(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
            await writeFile(`${STATE_FILE}.tmp`, JSON.stringify(parsed), { mode: 0o600 });
            await rename(`${STATE_FILE}.tmp`, STATE_FILE);
            this.enrollment = parsed;
        }
        // This start already supplies fresh configuration; request again only on
        // a future boot or connection recovery, not recursively during enrollment.
        this.refresh = false;
        this.failureReported = false;
        this.appliedGeneration++;
        this.schedule(30000);
    }

    private schedule(delay: number): void {
        if (this.stopped) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            void this.checkIn();
        }, delay);
        this.timer.unref();
    }

    async checkIn(): Promise<void> {
        if (this.stopped || this.running) return;
        if (!this.enrollment) {
            this.schedule(30000);
            return;
        }
        this.running = true;
        const enrolled = this.enrollment;
        const generation = this.appliedGeneration;
        this.controller = new AbortController();
        try {
            const response = await fetch(enrolled.url, {
                method: 'POST',
                redirect: 'error',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${enrolled.token}`,
                },
                body: JSON.stringify({ refresh: this.refresh, revision: enrolled.revision }),
                signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)]),
            });
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error('Check-in failed');
            }
            const reader = response.body?.getReader();
            if (!reader) throw new Error('Empty check-in response');
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
                for (;;) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    size += chunk.value.byteLength;
                    if (size > 1024) throw new Error('Check-in response exceeds limit');
                    chunks.push(chunk.value);
                }
            } finally {
                await reader.cancel();
            }
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                accepted?: boolean;
            };
            if (result.accepted !== true) throw new Error('Check-in not accepted');
            // Queue acceptance cannot acknowledge an applied configuration.
            // Only a successful authenticated start calls enroll() to do that.
            this.failureReported = false;
        } catch {
            if (generation === this.appliedGeneration) {
                this.refresh = true;
                if (!this.failureReported)
                    this.logger.warn(
                        'Panel unavailable; node will request current configuration after reconnecting',
                    );
                this.failureReported = true;
            }
        } finally {
            this.running = false;
            this.controller = null;
            this.schedule(30000 + Math.floor(Math.random() * 5000));
        }
    }

    onModuleDestroy(): void {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        this.controller?.abort();
    }
}
