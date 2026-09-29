import { systemPercents } from '../../../shared/system-status';
import type { SystemStatus } from '../../../shared/types';

export type RingLevel = 'normal' | 'high' | 'critical';
export type RingKind = 'cpu' | 'memory' | 'disk';
export interface Ring { kind: RingKind; letter: string; percent?: number; level: RingLevel }

/** Amber from 75%, red from 90%: the same line for CPU, memory and disk. */
export function ringLevel(percent: number | undefined): RingLevel {
  if (percent === undefined) return 'normal';
  return percent >= 90 ? 'critical' : percent >= 75 ? 'high' : 'normal';
}

/** The three rings in order. */
export function systemRings(status: SystemStatus): Ring[] {
  const { cpu, memory, disk } = systemPercents(status);
  return [
    { kind: 'cpu', letter: 'C', percent: cpu, level: ringLevel(cpu) },
    { kind: 'memory', letter: 'R', percent: memory, level: ringLevel(memory) },
    { kind: 'disk', letter: 'D', percent: disk, level: ringLevel(disk) },
  ];
}

/** Bytes as GB with one decimal below 100 GB, whole above. */
export function gigabytes(bytes: number): string {
  const value = bytes / 1024 ** 3;
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}
