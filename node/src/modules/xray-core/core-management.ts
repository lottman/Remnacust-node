import { AsyncLocalStorage } from 'node:async_hooks';

import { ServiceUnavailableException } from '@nestjs/common';

// One node process owns both the private core API and its restart checkpoint.
// Never acknowledge a credential edit between preparing that file and restart.
export class CoreManagementBarrier {
    private active: symbol | null = null;
    private readonly context = new AsyncLocalStorage<symbol>();

    acquire(): () => void {
        if (this.active && this.context.getStore() === this.active) return () => {};
        if (this.active)
            throw new ServiceUnavailableException(
                'Core configuration is changing; retry after synchronization',
            );
        const token = Symbol('core management operation');
        this.active = token;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (this.active === token) this.active = null;
        };
    }

    async run<T>(action: () => Promise<T>): Promise<T> {
        const release = this.acquire();
        try {
            return await this.context.run(this.active!, action);
        } finally {
            release();
        }
    }
}

export const coreManagement = new CoreManagementBarrier();
