import type { SecretCreateInput, SecretMetadata, SecretOverview, SecretScope } from '../../../shared/secrets';
import { api } from '../common/lib';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { localPart, nodeOf } from '../remote/scope';

/** All secret requests go to the source vault, including requests for a joined session. */
export function secretSession(sessionId?: string): { sessionId?: string; nodeId?: string } {
  return sessionId ? { sessionId: localPart(sessionId), ...(nodeOf(sessionId) ? { nodeId: nodeOf(sessionId) } : {}) } : {};
}
export function secretOverviewPath(sessionId?: string, cwd?: string): string {
  const query = new URLSearchParams({ ...secretSession(sessionId), ...(cwd ? { cwd: localPart(cwd) } : {}) } as Record<string, string>);
  return `/api/secrets/overview${query.size ? `?${query}` : ''}`;
}
export const readSecrets = (sessionId?: string, cwd?: string, signal?: AbortSignal) => api<SecretOverview>(secretOverviewPath(sessionId, cwd), { signal });
export const postSecret = <T,>(action: string, token: string, body: unknown) => api<T>(`/api/secrets/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token }, body: JSON.stringify(body) });
export const changeSecrets = (action: string, token: string, body: unknown) => postSecret<SecretOverview>(action, token, body);

export interface Registration {
  name: string; kind: SecretCreateInput['kind']; scope: SecretScope; groupId: string; groupName: string;
  projectId: string; allProjects?: boolean; activation: 'manual' | 'auto'; operations: SecretCreateInput['operations']; connect: boolean;
}
/** Transient values are added only at submission and never enter the conversation draft. */
export function registrationPayload(form: Registration, raw: string, sessionId?: string): SecretCreateInput & { sessionId?: string; nodeId?: string } {
  return { name: form.name.trim(), kind: form.kind, scope: form.scope,
    ...(form.kind === 'file' ? { content: raw } : { value: raw }),
    ...(form.groupId ? { groupId: form.groupId } : { groupName: form.groupName.trim() || form.name.trim() }),
    ...(form.scope === 'project' || (form.scope === 'global' && !form.allProjects && form.projectId) ? { projectId: form.projectId } : {}),
    ...(form.scope === 'global' ? { allProjects: form.allProjects === true } : {}),
    activation: form.activation, operations: form.operations, connect: !!sessionId && form.connect,
    ...secretSession(sessionId) };
}

/** Source identity determines which vault owns a key; display groups never grant ownership. */
export function isRemoteSecret(secret: SecretMetadata, localDeviceId?: string): boolean {
  return !!secret.sourceHostId && secret.sourceHostId !== localDeviceId;
}
export function localSecretOverview(overview: SecretOverview): SecretOverview {
  const secrets = overview.secrets.filter(secret => !isRemoteSecret(secret, overview.device?.id));
  const groups = overview.groups.filter(group => !overview.secrets.some(secret => secret.groupId === group.id) || secrets.some(secret => secret.groupId === group.id));
  const groupIds = new Set(groups.map(group => group.id));
  return { ...overview, secrets, groups, rules: overview.rules.filter(rule => groupIds.has(rule.groupId)) };
}
