import { renameSync, writeFileSync } from 'node:fs';

/** Publish a complete observation to the parent while the fixture worker updates its counters. */
export function publishTriggerCounts(path: string, counts: unknown): void {
  writeFileSync(`${path}.pending`, JSON.stringify(counts), { mode: 0o600 });
  renameSync(`${path}.pending`, path);
}
