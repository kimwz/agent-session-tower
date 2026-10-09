import type { Run } from '../../shared/types.js';
import { TowerError, type ErrorKind, type TowerErrorOptions } from '../../shared/errors.js';

/**
 * What a run record is and how it ends, shared by the run manager and the modules that own a part of its runs.
 * `RunError` is part of the manager's API and is exported from there as well.
 */
export class RunError extends TowerError {
  /** Nothing was accepted and the same request may succeed a little later (a full queue, a save that failed). */
  retryable?: boolean;
  commitDisposition?: 'committed' | 'not-committed' | 'unknown';
  constructor(message: string, kind: ErrorKind = 'invalid', options: TowerErrorOptions = {}) { super(kind, message, options); }
}
export function notAdmitted(error: RunError): RunError { if (error.disposition === 'uncertain') return error; error.retryable = true; error.commitDisposition = 'not-committed'; return error; }

export const MAX_PROMPT = 32_000;
export const MAX_OUTPUT = 64_000;

export const FINISHED = new Set<Run['status']>(['completed', 'error', 'cancelled']);
/** When a run finished, for keeping the most recently finished ones. */
export const finishedTime = (run: Run) => Date.parse(run.finishedAt ?? run.createdAt) || 0;
/** A run as anything outside the worker sees it: without its hidden instructions. */
export function shown(run: Run): Run { const { instructions: _hidden, ...rest } = run; return { ...rest }; }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** A receipt is required before this request may launch or be retried. */
export class RunAdmissionUncertain extends RunError {
  declare readonly commitDisposition: 'unknown' | 'committed';
  constructor(message: string, readonly identity: { commandId: string; sha256: string }, disposition: 'unknown' | 'committed' = 'unknown', cause?: unknown) {
    super(message, 'unavailable', { disposition: 'uncertain', cause });
    this.commitDisposition = disposition;
    this.retryable = false;
  }
}
export function admissionUncertain(error: unknown): boolean {
  const value = error as { disposition?: string } | null;
  return value?.disposition === 'uncertain' || value?.disposition === 'unknown' || value?.disposition === 'committed';
}
