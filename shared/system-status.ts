import type { SystemStatus } from './types.js';

const share = (part: number, whole: number) => whole > 0 ? Math.round(Math.min(100, Math.max(0, part / whole * 100))) : undefined;

/** Whole percentages as the host node's rings show them; none where there is nothing to divide yet. */
export function systemPercents(status: SystemStatus): { cpu?: number; memory?: number; disk?: number } {
  const memory = share(status.memory.used, status.memory.total);
  const disk = status.disk && share(status.disk.total - status.disk.free, status.disk.total);
  return { ...(status.cpu !== undefined ? { cpu: Math.round(status.cpu) } : {}), ...(memory !== undefined ? { memory } : {}), ...(disk !== undefined ? { disk } : {}) };
}
