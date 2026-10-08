import type { Run } from '../../shared/types.js';

/**
 * The run that carries on `run`'s work: a turn a forced worker update ended goes on in Tower's continuation for it
 * (`scheduled.resume` is `update` or `permission`), possibly more than once. Watchers that follow one run ID follow this one.
 */
export function continuedRun(runs: readonly Run[], run: Run | undefined): Run | undefined {
  const seen = new Set<string>();
  // An instruction delivered into a turn is answered by that turn, and so by whatever carries the turn on; the turn's
  // own record may already have left the history.
  if (run?.steering?.state === 'delivered') {
    const targetId = run.steering.targetRunId;
    const next = runs.find(item => (item.scheduled?.resume === 'update' || item.scheduled?.resume === 'permission') && item.scheduled.afterRunId === targetId);
    if (next) run = next;
  }
  while (run && !seen.has(run.id)) {
    seen.add(run.id);
    const id = run.id;
    const next = runs.find(item => (item.scheduled?.resume === 'update' || item.scheduled?.resume === 'permission') && item.scheduled.afterRunId === id);
    if (!next) break;
    run = next;
  }
  return run;
}

/** Like `continuedRun`, from a run ID whose own record may already be pruned. */
export function continuedRunById(runs: readonly Run[], id: string | undefined): Run | undefined {
  if (!id) return undefined;
  return continuedRun(runs, runs.find(item => item.id === id) ?? runs.find(item => (item.scheduled?.resume === 'update' || item.scheduled?.resume === 'permission') && item.scheduled.afterRunId === id));
}

/**
 * What a run Tower queues to carry `after`'s work on keeps of it: the same authority (origin, delegation), the
 * instructions it could not go without (a first turn's notes do not go on), unattended, model and effort. A permission
 * continuation also keeps the Codex reviewer its thread chose (`reviewer`).
 */
export function inheritedRunFields(after: Run, options: { reviewer?: boolean } = {}): Pick<Run, 'origin' | 'delegation' | 'heartbeat' | 'heartbeatRootRunId' | 'instructions' | 'codexApprovalsReviewer' | 'unattended' | 'model' | 'effort'> {
  return { origin: after.origin ?? { kind: 'unknown' },
    ...(after.heartbeat ? { heartbeat: structuredClone(after.heartbeat), heartbeatRootRunId: after.heartbeatRootRunId ?? after.id } : {}),
    ...(after.delegation ? { delegation: { ...after.delegation } } : {}),
    ...(after.instructions?.required ? { instructions: { ...after.instructions } } : {}),
    ...(options.reviewer && after.codexApprovalsReviewer ? { codexApprovalsReviewer: after.codexApprovalsReviewer } : {}),
    ...(after.unattended ? { unattended: true } : {}), ...(after.model ? { model: after.model } : {}), ...(after.effort ? { effort: after.effort } : {}) };
}
