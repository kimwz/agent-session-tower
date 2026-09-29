import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import { cpus, freemem, loadavg, platform, totalmem } from 'node:os';
import { systemPercents } from '../../shared/system-status.js';
import type { SystemStatus } from '../../shared/types.js';

/** How this computer is doing, measured by the web process for the host node's rings. */
export interface SystemSources {
  /** CPU time of all cores added up since boot, idle included. */
  cpuTimes(): Promise<CpuTimes>;
  loadavg(): number[];
  /** Bytes in use and in total. */
  memory(): Promise<{ total: number; used: number }>;
  /** The volume that holds the state directory; undefined when it cannot be read. */
  disk(): Promise<{ total: number; free: number } | undefined>;
  now(): number;
}

export interface CpuTimes { cores: number; idle: number; total: number }

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

/**
 * Linux's first `cpu` line in /proc/stat. Node's `os.cpus()` leaves out iowait, softirq and steal there, so a core
 * waiting on the disk would read as busy; waiting counts as idle here, as `top` counts it.
 */
export function linuxCpuTimes(procStat: string, cores: number): CpuTimes | undefined {
  const fields = /^cpu\s+(.*)$/m.exec(procStat)?.[1]?.trim().split(/\s+/).slice(0, 8).map(Number);
  if (!fields || fields.length < 4 || fields.some(value => !Number.isFinite(value))) return undefined;
  const [, , , idle = 0, iowait = 0] = fields;
  return { cores, idle: idle + iowait, total: fields.reduce((sum, value) => sum + value, 0) };
}

function osCpuTimes(): CpuTimes {
  const list = cpus();
  return list.reduce((sum, cpu) => {
    const { user, nice, sys, idle, irq } = cpu.times;
    return { ...sum, idle: sum.idle + idle, total: sum.total + user + nice + sys + idle + irq };
  }, { cores: list.length, idle: 0, total: 0 });
}

function vmStat(): Promise<string> {
  return new Promise((resolve, reject) => execFile('/usr/bin/vm_stat', { timeout: 5_000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

export function systemSources(stateDir: string): SystemSources {
  return {
    loadavg, now: Date.now,
    async cpuTimes() {
      if (platform() !== 'linux') return osCpuTimes();
      const measured = await readFile('/proc/stat', 'utf8').then(text => linuxCpuTimes(text, cpus().length), () => undefined);
      return measured ?? osCpuTimes();
    },
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

export class SystemMonitor {
  private last?: CpuTimes;
  private current?: SystemStatus;
  private published?: { shown: string; at: number };
  private timer?: NodeJS.Timeout;
  private sampling = false;
  private closed = false;

  constructor(private readonly sources: SystemSources, private readonly onChange: () => void) {}

  status(): SystemStatus | undefined { return this.current; }

  start(): void {
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(() => { void this.sample(); }, SAMPLE_MS);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Takes one sample; a sample that fails keeps the last one. */
  async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const [counted, memory, disk] = await Promise.all([this.sources.cpuTimes(), this.sources.memory(), this.sources.disk().catch(() => undefined)]);
      const previous = this.last;
      this.last = counted;
      // Times of a different set of cores do not subtract; the next sample starts from this one.
      const elapsed = previous && previous.cores === counted.cores ? counted.total - previous.total : 0;
      const cpu = elapsed > 0 ? Math.min(100, Math.max(0, (1 - (counted.idle - previous!.idle) / elapsed) * 100)) : undefined;
      const load = this.sources.loadavg();
      const now = this.sources.now();
      this.current = {
        ...(cpu !== undefined ? { cpu } : {}), cores: counted.cores,
        load: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0], memory, ...(disk ? { disk } : {}),
        sampledAt: new Date(now).toISOString(),
      };
      const shown = JSON.stringify(systemPercents(this.current));
      if (this.closed) return;
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
