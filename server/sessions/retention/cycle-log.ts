import { join } from 'node:path';
import type { RetentionCycleRecord } from '../../../shared/retention.js';
import { readPrivateJson, writePrivateJson } from '../../stores/private-json.js';
import { privateDirectory } from './store.js';

/** How many cycles the file keeps; the oldest go first. */
const KEPT = 200;

/**
 * A short record of each retention cycle (when it ran, why, what left for cold storage), kept in
 * `<retention>/cycles.json` so a late or missing archive can be traced afterwards. Losing it loses only the trace:
 * a file that cannot be read starts a new one, and a failed write is reported, never thrown into the cycle.
 */
export class RetentionCycleLog {
  private records: RetentionCycleRecord[] = [];
  private writing: Promise<void> = Promise.resolve();
  private readonly path: string;
  constructor(private readonly root: string, private readonly onError: (error: unknown) => void = error => console.error('Retention cycle log failed:', error)) {
    this.path = join(root, 'cycles.json');
  }
  async start(): Promise<void> {
    try {
      const saved = await readPrivateJson(this.path);
      this.records = Array.isArray(saved) ? saved.filter(isRecord).slice(-KEPT) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.onError(error);
      this.records = [];
    }
  }
  recent(count: number): RetentionCycleRecord[] { return structuredClone(this.records.slice(-count)); }
  record(entry: RetentionCycleRecord): Promise<void> {
    this.records = [...this.records, structuredClone(entry)].slice(-KEPT);
    const records = this.records;
    this.writing = this.writing.then(async () => {
      await privateDirectory(this.root);
      await writePrivateJson(this.path, `${JSON.stringify(records)}\n`);
    }).catch(this.onError);
    return this.writing;
  }
}

const isRecord = (value: unknown): value is RetentionCycleRecord =>
  typeof value === 'object' && value !== null && typeof (value as RetentionCycleRecord).startedAt === 'string' && typeof (value as RetentionCycleRecord).trigger === 'string';
