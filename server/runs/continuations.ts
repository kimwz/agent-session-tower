import type { Run } from '../../shared/types.js';

/**
 * The run that carries on `run`'s work: a turn a forced worker update ended goes on in Tower's continuation for it
 * (`scheduled.resume === 'update'`), possibly more than once. Watchers that follow one run ID follow this one.
 */
export function continuedRun(runs: readonly Run[], run: Run | undefined): Run | undefined {
  const seen = new Set<string>();
  while (run && !seen.has(run.id)) {
    seen.add(run.id);
    const id = run.id;
    const next = runs.find(item => item.scheduled?.resume === 'update' && item.scheduled.afterRunId === id);
    if (!next) break;
    run = next;
  }
  return run;
}
