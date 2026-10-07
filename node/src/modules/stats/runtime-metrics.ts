import os from 'node:os';
import { readFile, statfs } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export function cpuUsage(before: os.CpuInfo[], after: os.CpuInfo[]): number | null {
    if (!before.length || before.length !== after.length) return null;
    const sum = (cpus: os.CpuInfo[]) => cpus.reduce((out, cpu) => {
        out.idle += cpu.times.idle;
        out.total += Object.values(cpu.times).reduce((a, b) => a + b, 0);
        return out;
    }, { idle: 0, total: 0 });
    const a = sum(before), b = sum(after), elapsed = b.total - a.total;
    if (elapsed <= 0 || b.idle < a.idle) return null;
    return Math.round(Math.max(0, Math.min(100, 100 * (1 - (b.idle - a.idle) / elapsed))) * 100) / 100;
}

export async function collectDisk(path: string) {
    try {
        const fs = await statfs(path);
        const totalBytes = fs.blocks * fs.bsize;
        const freeBytes = fs.bfree * fs.bsize;
        const availableBytes = Math.max(0, fs.bavail * fs.bsize);
        const usedBytes = Math.max(0, totalBytes - freeBytes);
        return {
            path, scope: 'node-filesystem' as const, totalBytes, freeBytes, availableBytes,
            usedBytes, usedPercent: usedBytes + availableBytes > 0
                ? Math.round(10000 * usedBytes / (usedBytes + availableBytes)) / 100 : null,
            totalInodes: fs.files, freeInodes: fs.ffree, error: null,
        };
    } catch {
        return { path, scope: 'node-filesystem' as const, totalBytes: null, freeBytes: null,
            availableBytes: null, usedBytes: null, usedPercent: null,
            totalInodes: null, freeInodes: null, error: 'unavailable' as const };
    }
}

export async function collectRuntimeSystem() {
    const before = os.cpus();
    const [disks, meminfo] = await Promise.all([
        Promise.all(['/', '/var/lib/remnanode'].map(collectDisk)),
        readFile('/proc/meminfo', 'utf8').catch(() => ''),
        delay(200),
    ]);
    const totalBytes = os.totalmem();
    const availableKb = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
    const availableBytes = Math.min(totalBytes, availableKb ? Number(availableKb) * 1024 : os.freemem());
    return {
        cpu: { cores: before.length, model: before[0]?.model ?? null,
            usagePercent: cpuUsage(before, os.cpus()), sampleMs: 200, loadAverage: os.loadavg() },
        memory: { totalBytes, availableBytes, usedBytes: totalBytes - availableBytes,
            usedPercent: totalBytes > 0 ? 100 * (totalBytes - availableBytes) / totalBytes : null },
        uptimeSeconds: os.uptime(), platform: os.platform(), arch: os.arch(), disks,
    };
}

export async function bounded<T>(operation: Promise<T>, timeoutMs = 2500): Promise<T | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([operation.catch(() => null),
            new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
    } finally { clearTimeout(timer); }
}
