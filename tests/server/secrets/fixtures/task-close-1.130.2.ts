/**
 * `endTask` of server/secrets/service.ts in 1.130.2, the only place that build drops temporary values: the journal secrets
 * of the closing task's task-scope groups. The code is unchanged but for taking the journal as an argument, and the types
 * are the parts of the 1.130.2 journal it reads, so a vault rolled back to that build can be checked against it.
 */
interface Journal {
  groups: { id: string; taskId?: string }[]; rules: { groupId: string }[]; secrets: { metadata: { id: string; groupId: string } }[];
  grants: { taskId: string }[];
}
interface SecretTask { id: string; status: 'open' | 'closed'; closedAt?: number }

export function endTask(journal: Journal, task: SecretTask, now: number): void {
  task.status = 'closed'; task.closedAt = now;
  journal.grants = journal.grants.filter(grant => grant.taskId !== task.id);
  const groupIds = journal.groups.filter(group => group.taskId === task.id).map(group => group.id);
  journal.secrets = journal.secrets.filter(secret => !groupIds.includes(secret.metadata.groupId));
  journal.groups = journal.groups.filter(group => !groupIds.includes(group.id));
  journal.rules = journal.rules.filter(rule => !groupIds.includes(rule.groupId));
}
