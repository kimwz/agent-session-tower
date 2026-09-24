/**
 * When a version that failed to install is tried again: after 1, 2, 4, 8 and 16 hours, then once a day for as long as
 * it is the newest. A newer version starts over. Transient trouble (network, disk, a busy computer) heals by itself,
 * and a version that keeps failing costs one attempt a day.
 */
export interface RetryRecord { version: string; attempts: number; nextAt: string }

const HOUR = 60 * 60_000;
const DELAYS = [1, 2, 4, 8, 16].map(hours => hours * HOUR);
const DAILY = 24 * HOUR;

export function retryDelay(attempts: number): number { return DELAYS[attempts - 1] ?? DAILY; }

/** The record after `version` failed once more at `now`. */
export function failedAgain(record: RetryRecord | undefined, version: string, now: number): RetryRecord {
  const attempts = record?.version === version ? record.attempts + 1 : 1;
  return { version, attempts, nextAt: new Date(now + retryDelay(attempts)).toISOString() };
}

/** Whether `version` may be tried now: it has not failed, or its next attempt is due. */
export function retryDue(record: RetryRecord | undefined, version: string, now: number): boolean {
  if (!record || record.version !== version) return true;
  const at = Date.parse(record.nextAt);
  return !Number.isFinite(at) || now >= at;
}

export function parseRetry(value: unknown): RetryRecord | undefined {
  const record = value as Partial<RetryRecord> | undefined;
  if (!record || typeof record !== 'object' || typeof record.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(record.version)
    || !Number.isSafeInteger(record.attempts) || record.attempts! < 1 || typeof record.nextAt !== 'string' || !Number.isFinite(Date.parse(record.nextAt))) return undefined;
  return { version: record.version, attempts: record.attempts!, nextAt: record.nextAt };
}
