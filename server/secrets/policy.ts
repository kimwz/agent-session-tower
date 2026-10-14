import type { SecretAvailable, SecretBasis, SecretCatalogItem, SecretFolder, SecretGroup, SecretOperation, SecretPeer, SecretProject, SecretRule, SecretSharing, SecretTarget, SecretTask } from '../../shared/secrets.js';
import { SECRET_OPERATIONS } from '../../shared/secrets.js';
import { legacyRule, namedByRule, projectId, selectedFields, type LegacySecret } from './legacy-policy.js';

/**
 * Sharing as builds save it. Up to 1.136 it was `{ revision, global, folders }`; since machine sharing it is the whole
 * `SecretSharing` with `global` kept equal to `allMachines`, so a build rolled back to decides "all machines" the same
 * and, not knowing `machines`, allows less, never more. Read with `readSharing`.
 */
export type StoredSharing = Pick<SecretSharing, 'revision' | 'folders'> & Partial<Pick<SecretSharing, 'allMachines' | 'machines'>> & { global?: boolean };
/** Stored sharing of any build as this one decides with it: `global` alone is "all machines". */
export function readSharing(stored: StoredSharing): SecretSharing {
  const machines = Array.isArray(stored.machines) ? stored.machines.filter((id): id is string => typeof id === 'string') : [];
  return { revision: stored.revision, allMachines: typeof stored.allMachines === 'boolean' ? stored.allMachines : stored.global === true, machines, folders: stored.folders };
}
/** Sharing as this build saves it; see `StoredSharing`. */
export function storedSharing(sharing: SecretSharing): StoredSharing { return { ...structuredClone(sharing), global: sharing.allMachines }; }
/** A secret as authorization reads it, without its value. With `sharing` it follows per-secret sharing, without it the rules. */
export interface PolicySecret extends LegacySecret { sharing?: StoredSharing }
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
    const sharing = readSharing(secret.sharing);
    if (!withheld(state, secret)) {
      if (sharing.allMachines && state.servedHosts.includes(task.hostId)) basis.push('global');
      if (sharing.machines.includes(task.hostId)) basis.push('machine');
      if (sharing.folders.some((folder: SecretFolder) => folder.hostId === task.hostId && folder.root === task.root)) basis.push('folder');
    }
  } else if ((rule = legacyRule(state, task, secret, operation, now))) basis.push('legacy');
  if (!basis.length) return;
  // A rule's field selection binds only where the rule alone allows the use: bases never combine into a union.
  return { basis, fields: rule && basis.length === 1 ? selectedFields(secret, rule) : secret.fieldNames && [...secret.fieldNames] };
}

/** A refusal because nothing shares the secret with the task's folder or computer, which the owner can change by sharing it. */
export const notShared = (message = 'Secret access denied') => Object.assign(new Error(message), { code: 'SECRET_NOT_SHARED' as const });
export function authorize(state: PolicyState, task: SecretTask, secret: PolicySecret, operation: SecretOperation, now: number): Decision {
  const decision = decide(state, task, secret, operation, now);
  if (decision) return decision;
  // A key this session stopped, or one expired, is not a sharing question.
  if (task.excluded.includes(secret.metadata.id) || (secret.metadata.expiresAt !== undefined && secret.metadata.expiresAt <= now)) throw new Error('Secret access denied');
  throw notShared();
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

/** Every saved secret by name and reference, and whether this task may use it; values and fields stay out. Reads only. */
export function catalog(state: PolicyState, task: SecretTask, now: number): SecretCatalogItem[] {
  return state.secrets.filter(secret => secret.metadata.expiresAt === undefined || secret.metadata.expiresAt > now).map(secret => ({
    id: secret.metadata.id, name: secret.metadata.name, kind: secret.metadata.kind, reference: secret.metadata.reference.split('#')[0]!,
    status: SECRET_OPERATIONS.some(operation => decide(state, task, secret, operation, now)) ? 'available' as const : 'not-shared' as const }));
}
