/** Shared fixtures for secret tests: a vault on a temporary state folder and owner run registries. No personal state is read. */
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretService } from '../../server/secrets/service.js';
import type { PolicyState, StoredSharing } from '../../server/secrets/policy.js';
import { parseDotenv } from '../../server/secrets/dotenv.js';
import type { Capability } from '../../server/api/mcp.js';
import type { SessionOrigin } from '../../server/runs/origin.js';
import { DEFAULT_SECRET_USE_OPERATIONS, type SecretDevice, type SecretGroup, type SecretMetadata, type SecretProject, type SecretRule } from '../../shared/secrets.js';
import type { Run, Session } from '../../shared/types.js';

/** A started service on stateDir, initialized with password; without one it stays as a restarted worker finds it. */
export async function secretService(stateDir: string, options: { password?: string; now?: () => number } = {}): Promise<SecretService> {
  const service = new SecretService({ stateDir, ...(options.now ? { now: options.now } : {}) });
  await service.start();
  if (options.password !== undefined) await service.initialize(options.password);
  return service;
}

/**
 * A vault initialized once and copied for each test that wants a fresh, open one. A copy opens with the template's key, as
 * a worker handoff does, so only the template pays for the password derivation (about a second each on CI). Copies keep
 * the template's vault and device identity: a test that needs two distinct vaults takes two templates.
 */
export function vaultTemplate(password: string) {
  let made: Promise<{ directory: string; carry: Buffer }> | undefined;
  const ready = () => made ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tower-secret-template-'));
    const service = await secretService(directory, { password }); const carry = service.handoff()!; await service.lock();
    return { directory, carry };
  })();
  return {
    /** Makes the template now, e.g. in a `before` hook, so no single test's deadline pays for it. */
    async ready() { await ready(); },
    async open(stateDir: string, options: { now?: () => number } = {}): Promise<SecretService> {
      const { directory, carry } = await ready();
      await cp(join(directory, 'secrets'), join(stateDir, 'secrets'), { recursive: true });
      const service = await secretService(stateDir, options); await service.adopt(Buffer.from(carry));
      return service;
    },
    async dispose() { if (made) { const { directory, carry } = await made; carry.fill(0); await rm(directory, { recursive: true, force: true }); } },
  };
}

const session = (id: string, root: string, status: Session['status']): Session => {
  const at = new Date().toISOString();
  return { id, nativeId: id.slice(6), provider: 'codex', title: 'fixture', cwd: root, project: 'fixture', status, statusReason: '', createdAt: at, updatedAt: at, lastMessage: '', messageCount: 0, isSubagent: false, resumable: true };
};

/** Owner sessions and their running owner runs, as the run registry reports them to the secret runtime. */
export class FixtureRuns {
  readonly sessions = new Map<string, Session>(); readonly running: Run[] = [];
  /** An idle owner session without a run. */
  session(id: string, root: string): void { this.sessions.set(id, session(id, root, 'idle')); }
  /** An owner session with one running owner run, and that run's secret capability. */
  add(root: string, sessionId = `codex:${randomUUID()}`): Extract<Capability, { kind: 'secret-run' }> {
    const runId = randomUUID(); const at = new Date().toISOString();
    this.sessions.set(sessionId, session(sessionId, root, 'working'));
    this.running.push({ id: runId, sessionId, prompt: 'fixture owner task', status: 'running', createdAt: at, startedAt: at, output: '', origin: { kind: 'owner' }, towerTools: 'attached' });
    return { kind: 'secret-run', runId, sessionId };
  }
  list() { return this.running; } getSession(id: string) { return this.sessions.get(id); }
  sessionOrigin(_id: string): SessionOrigin { return { kind: 'owner', untrustedInput: false }; }
}

/** One saved secret in the vault's encrypted permanent payload. */
export interface StoredRecord { metadata: SecretMetadata; value: string; encoding?: 'base64'; fields?: Record<string, string>; sharing?: StoredSharing; temporaryTaskId?: string }
/** The encrypted permanent payload as any build reads it; builds keep the keys they do not know. */
export interface StoredPayload { device: SecretDevice; projects: SecretProject[]; groups: SecretGroup[]; secrets: StoredRecord[]; rules: SecretRule[]; [key: string]: unknown }

/**
 * Rewrites the permanent payload as another build would write it, then reopens the vault so the service reads it. The open
 * vault's own key reads and reopens it, as a worker handoff does: a password derivation costs about a second on CI.
 */
export async function editPayload(service: SecretService, edit: (payload: StoredPayload) => void): Promise<void> {
  await service.exportEncryptedVault(); // Waits for writes already queued.
  const carry = service.handoff(), key = service.vault.exportKey();
  if (!carry || !key) throw new Error('The fixture vault is locked');
  try {
    const payload = service.vault.unlockWithKey(key) as StoredPayload;
    edit(payload);
    await service.vault.save(payload, await service.vault.journal(), service.vault.index);
    await service.lock(); await service.adopt(carry);
  } finally { key.fill(0); carry.fill(0); }
}

/**
 * What the vault's last save keeps for authorization, without values: rules, projects, tasks with their connections and
 * exclusions, and every secret's metadata, temporary ones included. Read from the plaintext name index every save writes.
 */
export function stored(service: SecretService): PolicyState {
  const index = service.vault.index as { format?: number; policy?: PolicyState } | undefined;
  if (index?.format !== 2 || !index.policy) throw new Error('The fixture vault has no current index');
  return structuredClone(index.policy);
}
/** One stored task by ID. */
export function storedTask(service: SecretService, taskId: string) { return stored(service).tasks.find(task => task.id === taskId); }
/** Whether a secret, saved or temporary, is still stored. */
export function storedSecret(service: SecretService, secretId: string): boolean { return stored(service).secrets.some(secret => secret.metadata.id === secretId); }
/** A project registered as builds before per-secret sharing did, for rules to name. */
export async function addProject(service: SecretService, project: SecretProject): Promise<SecretProject> {
  await editPayload(service, payload => { payload.projects.push(structuredClone(project)); });
  return project;
}

/** A secret as builds before per-secret sharing saved it: in a group and governed by rules, without sharing. */
export function legacyRecord(vaultId: string, input: { name: string; groupId: string; value: string; kind?: 'scalar' | 'env'; id?: string; expiresAt?: number }): StoredRecord {
  const id = input.id ?? randomUUID(); const fields = input.kind === 'env' ? { ...parseDotenv(input.value) } : undefined;
  return { metadata: { id, name: input.name, groupId: input.groupId, kind: input.kind ?? 'scalar', version: 1, reference: `tower-secret://${vaultId}/${id}@1`, ...(fields ? { fields: Object.keys(fields) } : {}), ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}) },
    value: input.value, ...(fields ? { fields } : {}) };
}
/** A rule as builds before per-secret sharing saved it; manual and limited to the default use operations unless given. */
export function legacyRule(input: Pick<SecretRule, 'groupId' | 'secretIds' | 'hostId'> & Partial<SecretRule>): SecretRule {
  return { id: randomUUID(), activation: 'manual', operations: [...DEFAULT_SECRET_USE_OPERATIONS], enabled: true, revision: 1, ...input };
}
