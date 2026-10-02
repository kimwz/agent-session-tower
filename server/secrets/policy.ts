import type { SecretGroup, SecretMetadata, SecretOperation, SecretProject, SecretRule, SecretTarget, SecretTask } from '../../shared/secrets.js';
import { SECRET_OPERATIONS } from '../../shared/secrets.js';

export interface PolicySecret { metadata: SecretMetadata; fieldNames?: string[] }
export interface PolicyGrant { taskId: string; secretId: string; version: number; ruleId: string; revision: number; deadline?: number }
/** Everything authorization reads, without values or keys; also persisted in plain text so names stay listable while locked. */
export interface PolicyState { deviceId: string; projects: SecretProject[]; groups: SecretGroup[]; rules: SecretRule[]; secrets: PolicySecret[]; tasks: SecretTask[]; grants: PolicyGrant[] }
/** How an automatic rule without a grant is treated: issue one, assume the one a fresh issue would create (locked listing), or deny. */
export type Automatic = ((task: SecretTask, secret: PolicySecret, rule: SecretRule) => PolicyGrant) | 'assume' | undefined;

export function projectId(state: Pick<PolicyState, 'projects'>, hostId: string, root: string) { return state.projects.find(project => project.bindings.some(binding => binding.hostId === hostId && binding.root === root))?.id; }

export function openTask(state: PolicyState, target: SecretTarget, now: number): SecretTask {
  const task = state.tasks.find(task => task.id === target.taskId);
  if (!task || task.status !== 'open' || task.hostId !== target.hostId || task.sessionId !== target.sessionId || task.root !== target.root || (task.expiresAt !== undefined && task.expiresAt <= now) || target.projectId !== projectId(state, task.hostId, task.root)) throw new Error('Task identity denied');
  return task;
}

export function matchingRules(state: PolicyState, task: SecretTask, secret: PolicySecret) {
  const group = state.groups.find(group => group.id === secret.metadata.groupId);
  if (!group || (group.scope === 'task' && group.taskId !== task.id) || (group.scope === 'project' && group.projectId !== projectId(state, task.hostId, task.root))) return [];
  return state.rules.filter(rule => rule.groupId === group.id && rule.secretIds.includes(secret.metadata.id) && rule.hostId === task.hostId && ((rule.projectId !== undefined && rule.projectId === projectId(state, task.hostId, task.root)) || (rule.projectId === undefined && ((group.scope === 'global' && rule.allProjects === true) || (rule.root !== undefined && rule.root === task.root) || (group.scope === 'task' && group.taskId === task.id)))));
}
export function activeRules(state: PolicyState, task: SecretTask, secret: PolicySecret, now: number) { return matchingRules(state, task, secret).filter(rule => rule.enabled && (rule.expiresAt === undefined || rule.expiresAt > now)); }

export function selectedFields(secret: PolicySecret, rule: Pick<SecretRule, 'fields'>): string[] | undefined {
  const selected = rule.fields?.[secret.metadata.id];
  if (selected === undefined) return secret.fieldNames ? [...secret.fieldNames] : undefined;
  if (!secret.fieldNames || !Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some(field => typeof field !== 'string' || !secret.fieldNames!.includes(field))) throw new Error('Invalid field selection');
  return selected;
}

export function authorize(state: PolicyState, task: SecretTask, secret: PolicySecret, operation: SecretOperation, now: number, automatic: Automatic): SecretRule {
  if (task.excluded.includes(secret.metadata.id) || (secret.metadata.expiresAt !== undefined && secret.metadata.expiresAt <= now)) throw new Error('Secret access denied');
  const rules = activeRules(state, task, secret, now).filter(rule => rule.operations.includes(operation));
  if (rules.length !== 1) throw new Error('Single matching rule required');
  const rule = rules[0]; selectedFields(secret, rule);
  let grant = state.grants.find(grant => grant.taskId === task.id && grant.secretId === secret.metadata.id && grant.ruleId === rule.id);
  if (!grant && rule.activation === 'auto' && automatic) grant = automatic !== 'assume' ? automatic(task, secret, rule) : { taskId: task.id, secretId: secret.metadata.id, version: secret.metadata.version, ruleId: rule.id, revision: rule.revision };
  if (!grant || grant.revision !== rule.revision || grant.version !== secret.metadata.version || (grant.deadline !== undefined && grant.deadline <= now)) throw new Error('Grant denied');
  return rule;
}

/** The secrets this task may discover, each with the operations it may use. */
export function discoverable(state: PolicyState, task: SecretTask, now: number, automatic: Automatic): SecretMetadata[] {
  const result: SecretMetadata[] = [];
  for (const secret of state.secrets) {
    try {
      const rule = authorize(state, task, secret, 'discover', now, automatic);
      result.push({ ...structuredClone(secret.metadata), fields: secret.fieldNames ? rule.fields?.[secret.metadata.id] ?? [...secret.fieldNames] : undefined,
        operations: SECRET_OPERATIONS.filter(operation => { try { authorize(state, task, secret, operation, now, automatic); return true; } catch { return false; } }),
        activation: rule.activation, sourceHostId: state.deviceId });
    } catch { /* A list omits resources not authorized for this subject. */ }
  }
  return result;
}
