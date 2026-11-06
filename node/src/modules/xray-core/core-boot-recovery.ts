import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function restoreCachedCore(options: {
    paused: boolean;
    checkpoint: string;
    supported: () => Promise<boolean>;
    running: () => Promise<boolean>;
    start: () => Promise<void>;
    ready: () => Promise<boolean>;
    cancelled?: () => boolean;
}): Promise<boolean> {
    const cancelled = options.cancelled ?? (() => false);
    if (options.paused || cancelled()) return false;
    let file;
    try {
        file = await lstat(options.checkpoint);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
    const parent = await lstat(dirname(options.checkpoint));
    const uid = process.getuid?.();
    if (
        !file.isFile() ||
        !parent.isDirectory() ||
        (process.platform !== 'win32' && (file.mode | parent.mode) & 0o077) ||
        (uid !== undefined && (file.uid !== uid || parent.uid !== uid))
    )
        throw new Error('Cached core state must be a private owned file and directory');
    if (cancelled() || !(await options.supported()) || cancelled()) return false;
    const running = await options.running();
    if (cancelled()) return false;
    if (!running) await options.start();
    if (cancelled()) return false;
    if (!(await options.ready())) throw new Error('Cached core did not restore its private API');
    return !cancelled();
}
