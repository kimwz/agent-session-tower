import type { SystemStatus } from './types.js';

const share = (part: number, whole: number) => whole > 0 ? Math.round(Math.min(100, Math.max(0, part / whole * 100))) : 0;

/** Whole percentages as the host node's rings show them. CPU has none until its second sample, disk none when unreadable. */
export function systemPercents(status: SystemStatus): { cpu?: number; memory: number; disk?: number } {
  return {
    ...(status.cpu !== undefined ? { cpu: Math.round(Math.min(100, Math.max(0, status.cpu))) } : {}),
    memory: share(status.memory.used, status.memory.total),
    ...(status.disk ? { disk: share(status.disk.total - status.disk.free, status.disk.total) } : {}),
  };
}
