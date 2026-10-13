import type { SecretAvailable, SecretBasis, SecretGroup, SecretOperation, SecretPeer, SecretProject, SecretRule, SecretSharing, SecretTarget, SecretTask } from '../../shared/secrets.js';
import { SECRET_OPERATIONS } from '../../shared/secrets.js';
import { legacyRule, namedByRule, projectId, selectedFields, type LegacySecret } from './legacy-policy.js';

/** A secret as authorization reads it, without its value. With `sharing` it follows per-secret sharing, without it the rules. */
export interface PolicySecret extends LegacySecret { sharing?: SecretSharing }
/** Everything authorization reads, without values or keys; also persisted in plain text so names stay listable while locked. */
export interface PolicyState {
  deviceId: string;
  /** The computers GLOBAL covers: this vault's own and its enabled node peers. */
  servedHosts: string[];
  projects: SecretProject[]; groups: SecretGroup[]; rules: SecretRule[]; secrets: PolicySecret[]; tasks: SecretTask[];
}
/** Why a task may use a secret, and the dotenv fields it may use. */
export interface Decision { basis: SecretBasis[]; fields?: string[] }

export function servedHosts(deviceId: string, peers: readonly SecretPeer[]): string[] { return [deviceId, ...peers.filter(peer => peer.enabled && peer.direction === 'node').map(peer => peer.device.id)]; }

export function openTask(state: Pick<PolicyState, 'projects' | 'tasks'>, target: SecretTarget, now: number): SecretTask {
  const task = state.tasks.find(task => task.id === target.taskId);
  if (!task || task.status !== 'open' || task.hostId !== target.hostId || task.sessionId !== target.sessionId || task.root !== target.root || (task.expiresAt !== undefined && task.expiresAt <= now) || target.projectId !== projectId(state, task.hostId, task.root)) throw new Error('Task identity denied');
  return task;
}

/** The open task a run of this session binds to, or undefined when binding would start one; throws where binding refuses. */
export function sessionTask(state: Pick<PolicyState, 'tasks'>, sessionId: string, hostId: string, root: string, runStartedAt?: number): SecretTask | undefined {
  if (runStartedAt !== undefined && state.tasks.some(task => task.sessionId === sessionId && task.hostId === hostId && task.status === 'closed' && (task.closedAt ?? task.createdAt) >= runStartedAt)) throw new Error('Run predates task closure');
  const task = state.tasks.find(task => task.sessionId === sessionId && task.hostId === hostId && task.status === 'open');
  if (task && task.root !== root) throw new Error('Task project changed');
  return task;
}

/** Sharing set aside because a rule names the secret again, which only an older build writes; the owner's next save restores it. */
export function withheld(state: Pick<PolicyState, 'rules'>, secret: PolicySecret): boolean { return !!secret.sharing && namedByRule(state.rules, secret.metadata.id); }

/** Why this task may use the secret this way, or undefined when nothing allows it. */
export function decide(state: PolicyState, task: SecretTask, secret: PolicySecret, operation: SecretOperation, now: number): Decision | undefined {
  const id = secret.metadata.id;
  if (task.status !== 'open' || (task.expiresAt !== undefined && task.expiresAt <= now) || task.excluded.includes(id) || (secret.metadata.expiresAt !== undefined && secret.metadata.expiresAt <= now)) return;
  const basis: SecretBasis[] = task.connected.includes(id) ? ['session'] : [];
  let rule: SecretRule | undefined;
  if (secret.sharing) {
    if (!withheld(state, secret)) {
      if (secret.sharing.global && state.servedHosts.includes(task.hostId)) basis.push('global');
      if (secret.sharing.folders.some(folder => folder.hostId === task.hostId && folder.root === task.root)) basis.push('folder');
    }
  } else if ((rule = legacyRule(state, task, secret, operation, now))) basis.push('legacy');
  if (!basis.length) return;
  // A rule's field selection binds only where the rule alone allows the use: bases never combine into a union.
  return { basis, fields: rule && basis.length === 1 ? selectedFields(secret, rule) : secret.fieldNames && [...secret.fieldNames] };
}

export function authorize(state: PolicyState, task: SecretTask, secret: PolicySecret, operation: SecretOperation, now: number): Decision {
  const decision = decide(state, task, secret, operation, now);
  if (!decision) throw new Error('Secret access denied');
  return decision;
}

/** What this task may discover, each with the operations it may use and why. Reads only. */
export function available(state: PolicyState, task: SecretTask, now: number): SecretAvailable[] {
  return state.secrets.flatMap(secret => {
    const decision = decide(state, task, secret, 'discover', now);
    if (!decision) return [];
    return [{ ...structuredClone(secret.metadata), fields: decision.fields, basis: decision.basis, sourceHostId: state.deviceId,
      operations: SECRET_OPERATIONS.filter(operation => decide(state, task, secret, operation, now)) }];
  });
}

/** Whether automatic use may enter this folder: some secret allows some operation there, or the task already has the owner's connections. */
export function covered(state: PolicyState, hostId: string, root: string, taskId: string, now: number): boolean {
  const task = state.tasks.find(task => task.id === taskId);
  if (task && task.hostId === hostId && task.root === root && task.connected.length) return true;
  const probe: SecretTask = { id: taskId, hostId, sessionId: '', root, status: 'open', createdAt: task?.createdAt ?? now, excluded: [], connected: [] };
  // A rule may allow a use without discovery; 1.130.2 resolved such a key in any folder of a registered project.
  return state.secrets.some(secret => SECRET_OPERATIONS.some(operation => decide(state, probe, secret, operation, now)));
}
