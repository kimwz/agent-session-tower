import type { Run } from '../../shared/types.js';

/**
 * What a run record is and how it ends, shared by the run manager and the modules that own a part of its runs.
 * `RunError` is part of the manager's API and is exported from there as well.
 */
export class RunError extends Error {
  /** Nothing was accepted and the same request may succeed a little later (a full queue, a save that failed). */
  retryable?: boolean;
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}
export function notAdmitted(error: RunError): RunError { error.retryable = true; return error; }

export const MAX_PROMPT = 32_000;
export const MAX_OUTPUT = 64_000;

export const FINISHED = new Set<Run['status']>(['completed', 'error', 'cancelled']);
/** When a run finished, for keeping the most recently finished ones. */
export const finishedTime = (run: Run) => Date.parse(run.finishedAt ?? run.createdAt) || 0;
/** A run as anything outside the worker sees it: without its hidden instructions. */
export function shown(run: Run): Run { const { instructions: _hidden, ...rest } = run; return { ...rest }; }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
