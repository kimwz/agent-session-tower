import type { SlackWorkflow } from './slack.js';
import type { Run, Session } from './types.js';

/**
 * Sessions automation created that have finished: Slack's delegated work and sessions a trigger started,
 * with their finished subagents. Display and routing cleanup only; nothing is cancelled or deleted.
 */
export function finishedAutomationSessionIds(workflows: SlackWorkflow[], sessions: Session[], runs: Run[]): Set<string> {
  const coordinators = new Set(workflows.filter(item => item.mode === 'conversation').map(item => item.sessionId));
  const active = new Set(runs.filter(run => run.status === 'running' || run.status === 'queued').map(run => run.sessionId));
  const roots = new Set([...workflows.flatMap(item => (item.delegatedTasks ?? []).flatMap(task =>
    task.createdSessionId && task.delegatedFinished ? [task.createdSessionId] : [])),
    ...sessions.flatMap(session => session.launchedBy?.kind === 'trigger' ? [session.id] : [])]);
  const aliases = (session: Session) => [session.id, `${session.provider}:${session.nativeId}`];
  const descendants = new Set(sessions.filter(session => aliases(session).some(id => roots.has(id))).map(session => session.id));
  const parents = new Map<string, string>();
  for (const session of sessions) {
    if (!session.isSubagent || !session.parentId) continue;
    const parent = sessions.find(parent => session.parentLink === 'exec'
      ? aliases(parent).includes(session.parentId!)
      : parent.provider === session.provider && (aliases(parent).includes(session.parentId!) || parent.nativeId === session.parentId));
    if (parent) parents.set(session.id, parent.id);
  }
  // Native parent IDs stay provider-scoped. Proven CLI launches carry a qualified cross-provider link.
  for (let changed = true; changed;) {
    changed = false;
    for (const session of sessions) {
      if (!session.isSubagent || !session.parentId || descendants.has(session.id)) continue;
      const parentId = parents.get(session.id);
      if (parentId && descendants.has(parentId)) { descendants.add(session.id); changed = true; }
    }
  }
  const protectedIds = new Set(sessions.filter(session => aliases(session).some(id => active.has(id) || coordinators.has(id))
    || session.status === 'working' || session.activeProcess || session.creationPending).map(session => session.id));
  for (const id of [...protectedIds]) {
    const visited = new Set<string>();
    for (let ancestor = parents.get(id); ancestor && !visited.has(ancestor); ancestor = parents.get(ancestor)) {
      visited.add(ancestor); protectedIds.add(ancestor);
    }
  }
  return new Set(sessions.filter(session => descendants.has(session.id) && !protectedIds.has(session.id)).map(session => session.id));
}
