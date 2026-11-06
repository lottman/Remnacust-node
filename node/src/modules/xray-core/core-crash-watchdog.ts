export const CORE_WATCHDOG_INTERVAL_MS = 5_000;
export const CORE_WATCHDOG_WINDOW_MS = 60 * 60 * 1000;
export const CORE_WATCHDOG_MAX_RESTARTS = 3;
export const CORE_WATCHDOG_BACKOFF_MS = [0, 10_000, 30_000] as const;

interface WatchdogOptions {
    busy: () => boolean;
    exclusive: (action: () => Promise<void>) => Promise<boolean>;
    paused: () => Promise<boolean>;
    status: () => Promise<'up' | 'down' | 'unknown'>;
    recover: (cancelled: () => boolean) => Promise<boolean>;
    stop: () => Promise<void>;
    online: (value: boolean) => void;
    warning: () => void;
    now?: () => number;
}

export class CoreCrashWatchdog {
    private timer?: ReturnType<typeof setTimeout>;
    private closed = false;
    private running = false;
    private desired = false;
    private blocked = false;
    private attempts: number[] = [];
    private retryAt = 0;
    private generation = 0;
    private inFlight?: Promise<void>;
    private cleanupFailure?: Error;

    constructor(private readonly options: WatchdogOptions) {}

    start(): void {
        if (this.closed || this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.tick().then(
                () => this.start(),
                () => this.start(),
            );
        }, CORE_WATCHDOG_INTERVAL_MS);
        this.timer.unref();
    }

    arm(reset = false): void {
        if (this.closed) return;
        this.desired = true;
        if (reset) {
            this.generation++;
            this.blocked = false;
            this.attempts = [];
            this.retryAt = 0;
            this.cleanupFailure = undefined;
        }
    }

    disarm(): void {
        this.desired = false;
        this.generation++;
    }

    async shutdown(): Promise<void> {
        this.closed = true;
        this.disarm();
        clearTimeout(this.timer);
        this.timer = undefined;
        await this.inFlight;
        if (this.cleanupFailure) throw this.cleanupFailure;
    }

    tick(): Promise<void> {
        if (this.running) return Promise.resolve();
        const pending = this.check();
        this.inFlight = pending;
        const complete = () => {
            if (this.inFlight === pending) this.inFlight = undefined;
        };
        void pending.then(complete, complete);
        return pending;
    }

    private async check(): Promise<void> {
        if (this.closed || this.running || !this.desired || this.blocked || this.options.busy())
            return;
        this.running = true;
        const generation = this.generation;
        const cancelled = () => this.closed || !this.desired || generation !== this.generation;
        try {
            if ((await this.options.status()) !== 'down') return;
            await this.options.exclusive(async () => {
                if (cancelled()) return;
                if ((await this.options.status()) !== 'down') return;
                if (cancelled()) return;
                this.options.online(false);
                const paused = await this.options.paused();
                if (cancelled()) return;
                if (paused) {
                    this.disarm();
                    return;
                }
                const now = (this.options.now ?? (() => performance.now()))();
                this.attempts = this.attempts.filter((at) => now - at < CORE_WATCHDOG_WINDOW_MS);
                if (this.attempts.length >= CORE_WATCHDOG_MAX_RESTARTS) {
                    this.block();
                    return;
                }
                if (now < this.retryAt) return;
                this.attempts.push(now);
                this.retryAt =
                    now +
                    CORE_WATCHDOG_BACKOFF_MS[
                        Math.min(this.attempts.length, CORE_WATCHDOG_BACKOFF_MS.length - 1)
                    ];
                let recovered = false;
                try {
                    recovered = await this.options.recover(cancelled);
                } catch {}
                if (cancelled() || !recovered) {
                    await this.stopRecoveredCore();
                    if (!cancelled()) this.block();
                    return;
                }
                this.options.online(true);
            });
        } catch {
            if (this.cleanupFailure) throw this.cleanupFailure;
            if (!cancelled()) this.block();
        } finally {
            this.running = false;
        }
    }

    private async stopRecoveredCore(): Promise<void> {
        try {
            await this.options.stop();
        } catch {
            this.cleanupFailure = new Error(
                'Local core recovery could not confirm that the process stopped',
            );
            this.block();
            throw this.cleanupFailure;
        }
    }

    private block(): void {
        if (this.blocked) return;
        this.blocked = true;
        this.options.online(false);
        this.options.warning();
    }
}
