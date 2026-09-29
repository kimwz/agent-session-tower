import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { cpus, freemem, loadavg, platform, totalmem, type CpuInfo } from 'node:os';
import { systemPercents } from '../../shared/system-status.js';
import type { SystemStatus } from '../../shared/types.js';

/** How this computer is doing, measured by the web process for the host node's rings. */
export interface SystemSources {
  cpus(): Pick<CpuInfo, 'times'>[];
  loadavg(): number[];
  /** Bytes in use and in total. */
  memory(): Promise<{ total: number; used: number }>;
  /** The volume that holds the state directory; undefined when it cannot be read. */
  disk(): Promise<{ total: number; free: number } | undefined>;
  now(): number;
}

const SAMPLE_MS = 10_000;
/** A sample whose percentages did not move is still sent this often, so its details and time stay current. */
const REFRESH_MS = 60_000;

/**
 * macOS counts only never-used pages as free, so a busy Mac reads about 90% used. Activity Monitor's
 * "Memory Used" is app memory (anonymous minus purgeable), wired and compressed pages.
 */
export function macMemoryUsed(vmStat: string): number | undefined {
  const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
  const pages = (label: string) => Number(new RegExp(`^${label}:\\s+(\\d+)\\.?$`, 'm').exec(vmStat)?.[1]);
  const anonymous = pages('Anonymous pages'), purgeable = pages('Pages purgeable'), wired = pages('Pages wired down'), compressed = pages('Pages occupied by compressor');
  const values = [pageSize, anonymous, purgeable, wired, compressed];
  if (values.some(value => !Number.isFinite(value))) return undefined;
  return (Math.max(0, anonymous - purgeable) + wired + compressed) * pageSize;
}

function vmStat(): Promise<string> {
  return new Promise((resolve, reject) => execFile('/usr/bin/vm_stat', { timeout: 5_000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

export function systemSources(stateDir: string): SystemSources {
  return {
    cpus, loadavg, now: Date.now,
    async memory() {
      const total = totalmem();
      const fallback = total - freemem();
      if (platform() !== 'darwin') return { total, used: fallback };
      const used = await vmStat().then(macMemoryUsed, () => undefined);
      return { total, used: used === undefined ? fallback : Math.min(total, used) };
    },
    async disk() {
      const info = await statfs(stateDir).catch(() => undefined);
      return info ? { total: info.blocks * info.bsize, free: info.bavail * info.bsize } : undefined;
    },
  };
}

const idleAndTotal = (list: Pick<CpuInfo, 'times'>[]) => list.reduce((sum, cpu) => {
  const { user, nice, sys, idle, irq } = cpu.times;
  return { idle: sum.idle + idle, total: sum.total + user + nice + sys + idle + irq };
}, { idle: 0, total: 0 });

export class SystemMonitor {
  private last?: { idle: number; total: number };
  private current?: SystemStatus;
  private published?: { shown: string; at: number };
  private timer?: NodeJS.Timeout;
  private sampling = false;

  constructor(private readonly sources: SystemSources, private readonly onChange: () => void) {}

  status(): SystemStatus | undefined { return this.current; }

  start(): void {
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(() => { void this.sample(); }, SAMPLE_MS);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Takes one sample; a sample that fails keeps the last one. */
  async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const list = this.sources.cpus();
      const counted = idleAndTotal(list);
      const previous = this.last;
      this.last = counted;
      const elapsed = previous ? counted.total - previous.total : 0;
      const cpu = previous && elapsed > 0 ? Math.min(100, Math.max(0, (1 - (counted.idle - previous.idle) / elapsed) * 100)) : undefined;
      const [memory, disk] = await Promise.all([this.sources.memory(), this.sources.disk().catch(() => undefined)]);
      const load = this.sources.loadavg();
      const now = this.sources.now();
      this.current = {
        ...(cpu !== undefined ? { cpu } : {}), cores: list.length,
        load: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0], memory, ...(disk ? { disk } : {}),
        sampledAt: new Date(now).toISOString(),
      };
      const shown = JSON.stringify(systemPercents(this.current));
      if (!this.published || this.published.shown !== shown || now - this.published.at >= REFRESH_MS) {
        this.published = { shown, at: now };
        this.onChange();
      }
    } catch {
      // Measuring is best effort; the rings keep the last sample.
    } finally {
      this.sampling = false;
    }
  }
}
