import type { Run } from '../../shared/types.js';

/**
 * The run that carries on `run`'s work: a turn a forced worker update ended goes on in Tower's continuation for it
 * (`scheduled.resume === 'update'`), possibly more than once. Watchers that follow one run ID follow this one.
 */
export function continuedRun(runs: readonly Run[], run: Run | undefined): Run | undefined {
  const seen = new Set<string>();
  // An instruction delivered into a turn is answered by that turn, and so by whatever carries the turn on.
  if (run?.steering?.state === 'delivered') {
    const target = runs.find(item => item.id === run!.steering!.targetRunId);
    const carried = target && continuedRun(runs, target);
    if (carried && carried !== target) return carried;
  }
  while (run && !seen.has(run.id)) {
    seen.add(run.id);
    const id = run.id;
    const next = runs.find(item => item.scheduled?.resume === 'update' && item.scheduled.afterRunId === id);
    if (!next) break;
    run = next;
  }
  return run;
}

/** Like `continuedRun`, from a run ID whose own record may already be pruned. */
export function continuedRunById(runs: readonly Run[], id: string | undefined): Run | undefined {
  if (!id) return undefined;
  return continuedRun(runs, runs.find(item => item.id === id) ?? runs.find(item => item.scheduled?.resume === 'update' && item.scheduled.afterRunId === id));
}
