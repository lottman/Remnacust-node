import { AsyncLocalStorage } from 'node:async_hooks';

export const CORE_RPC_TIMEOUT_MS = 15_000;

const context = new AsyncLocalStorage<AbortSignal>();

export function coreRpcSignal(): AbortSignal {
    const signal = context.getStore() ?? AbortSignal.timeout(CORE_RPC_TIMEOUT_MS);
    signal.throwIfAborted();
    return signal;
}

export async function withCoreRpcDeadline<T>(
    action: () => Promise<T>,
    timeoutMs = CORE_RPC_TIMEOUT_MS,
): Promise<T> {
    if (context.getStore()) return action();
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(new Error('Core RPC deadline exceeded')),
        timeoutMs,
    );
    try {
        return await context.run(controller.signal, action);
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
}
