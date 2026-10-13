import type { SecretFolder, SecretGroup, SecretLegacySummary, SecretMetadata, SecretOperation, SecretProject, SecretRule, SecretTask } from '../../shared/secrets.js';
import { SECRET_OPERATIONS } from '../../shared/secrets.js';

/**
 * The rule policy of secrets saved before per-secret sharing, read live so a rule changed by any build applies.
 * It decides as rules always did, except that every rule is automatic and a task's grant is taken as issued: there
 * are no grant records, so a rule's `maxTtlMs` counts from the task's creation.
 */
export interface LegacyRules { projects: SecretProject[]; groups: SecretGroup[]; rules: SecretRule[] }
export interface LegacySecret { metadata: SecretMetadata; fieldNames?: string[] }

export function projectId(state: Pick<LegacyRules, 'projects'>, hostId: string, root: string) { return state.projects.find(project => project.bindings.some(binding => binding.hostId === hostId && binding.root === root))?.id; }

export function matchingRules(state: LegacyRules, task: SecretTask, secret: LegacySecret) {
  const group = state.groups.find(group => group.id === secret.metadata.groupId);
  if (!group || (group.scope === 'task' && group.taskId !== task.id) || (group.scope === 'project' && group.projectId !== projectId(state, task.hostId, task.root))) return [];
  return state.rules.filter(rule => rule.groupId === group.id && rule.secretIds.includes(secret.metadata.id) && rule.hostId === task.hostId && ((rule.projectId !== undefined && rule.projectId === projectId(state, task.hostId, task.root)) || (rule.projectId === undefined && ((group.scope === 'global' && rule.allProjects === true) || (rule.root !== undefined && rule.root === task.root) || (group.scope === 'task' && group.taskId === task.id)))));
}
export function activeRules(state: LegacyRules, task: SecretTask, secret: LegacySecret, now: number) { return matchingRules(state, task, secret).filter(rule => rule.enabled && (rule.expiresAt === undefined || rule.expiresAt > now)); }

/** A rule's field selection for the secret is a set of the secret's current fields, or absent (all of them). */
export function validSelection(secret: LegacySecret, rule: Pick<SecretRule, 'fields'>): boolean {
  const selected = rule.fields?.[secret.metadata.id];
  return selected === undefined || (!!secret.fieldNames && Array.isArray(selected) && new Set(selected).size === selected.length && selected.every(field => typeof field === 'string' && secret.fieldNames!.includes(field)));
}
export function selectedFields(secret: LegacySecret, rule: Pick<SecretRule, 'fields'>): string[] | undefined {
  if (!validSelection(secret, rule)) throw new Error('Invalid field selection');
  return rule.fields?.[secret.metadata.id] ?? (secret.fieldNames ? [...secret.fieldNames] : undefined);
}

/** The one rule that lets this task use the secret this way, or undefined; the task is open and has not stopped the secret. */
export function legacyRule(state: LegacyRules, task: SecretTask, secret: LegacySecret, operation: SecretOperation, now: number): SecretRule | undefined {
  const rules = activeRules(state, task, secret, now).filter(rule => rule.operations.includes(operation));
  if (rules.length !== 1 || !validSelection(secret, rules[0])) return;
  const rule = rules[0];
  return rule.maxTtlMs === undefined || task.createdAt + rule.maxTtlMs > now ? rule : undefined;
}

/** Whether any rule still names the secret. */
export function namedByRule(rules: readonly SecretRule[], secretId: string): boolean { return rules.some(rule => rule.secretIds.includes(secretId)); }

/** Rules without the dropped secrets and their field selections; a rule left naming none goes. Revisions stay. */
export function withoutSecrets(rules: readonly SecretRule[], dropped: (id: string) => boolean): SecretRule[] {
  return rules.flatMap(rule => {
    if (!rule.secretIds.some(dropped)) return [rule];
    const secretIds = rule.secretIds.filter(id => !dropped(id)); if (!secretIds.length) return [];
    return [{ ...rule, secretIds, ...(rule.fields ? { fields: Object.fromEntries(Object.entries(rule.fields).filter(([id]) => !dropped(id))) } : {}) }];
  });
}

/** Where the active rules of a secret apply, for the settings list; `limited` when they restrict operations, fields or time, or may conflict. */
export function legacySummary(state: LegacyRules, secret: LegacySecret, now: number): SecretLegacySummary {
  const group = state.groups.find(group => group.id === secret.metadata.groupId);
  const rules = !group || group.scope === 'task' ? [] : state.rules.filter(rule => rule.groupId === group.id && rule.secretIds.includes(secret.metadata.id) && rule.enabled && (rule.expiresAt === undefined || rule.expiresAt > now));
  const global = new Set<string>(); const folders = new Map<string, SecretFolder>();
  const folder = (hostId: string, root: string) => { if (group!.scope !== 'project' || group!.projectId === projectId(state, hostId, root)) folders.set(JSON.stringify([hostId, root]), { hostId, root }); };
  for (const rule of rules) {
    if (rule.projectId !== undefined) { for (const binding of state.projects.find(project => project.id === rule.projectId)?.bindings ?? []) if (binding.hostId === rule.hostId) folder(binding.hostId, binding.root); }
    else if (group!.scope === 'global' && rule.allProjects === true) global.add(rule.hostId);
    else if (rule.root !== undefined) folder(rule.hostId, rule.root);
  }
  const limited = rules.length > 1 || rules.some(rule => SECRET_OPERATIONS.some(operation => !rule.operations.includes(operation)) || rule.fields?.[secret.metadata.id] !== undefined || rule.maxTtlMs !== undefined || rule.expiresAt !== undefined);
  return { global: [...global].map(hostId => ({ hostId })), folders: [...folders.values()], limited };
}
