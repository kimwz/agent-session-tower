import { randomUUID, randomBytes, generateKeyPairSync, createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import type { SecretAvailable, SecretBrokerApproval, SecretContext, SecretCreateInput, SecretDevice, SecretFolder, SecretGroup, SecretMetadata, SecretOperation, SecretPeer, SecretProject, SecretRule, SecretSettingsView, SecretSharing, SecretTarget, SecretTask, SecretUsage, VaultStatus } from '../../shared/secrets.js';
import { TowerError } from '../../shared/errors.js';
import { MAX_SECRET_BYTES, SECRET_OPERATIONS } from '../../shared/secrets.js';
import { SecretVault } from './vault.js';
import { decode } from './crypto.js';
import { parseDotenv } from './dotenv.js';
import { authorize, available, covered, openTask, servedHosts, sessionTask, withheld, type Decision, type PolicySecret, type PolicyState } from './policy.js';
import { legacySummary, projectId, withoutSecrets } from './legacy-policy.js';
import { wireMetadata } from './remote.js';
interface StoredSecret {
  metadata: SecretMetadata; value: string; encoding?: 'base64'; fields?: Record<string, string>;
  /** Set when created or edited for sharing; until then the secret follows the rules it was saved with. */
  sharing?: SecretSharing;
  /** A pasted value that lives in the journal with this task only. */
  temporaryTaskId?: string;
}
interface Legacy { id: string; name: string; value: string; createdAt: string; origin: string }
interface Permanent {
  device: SecretDevice; keys: { signingPrivateKey: string; encryptionPrivateKey: string }; hmac: string; peers: SecretPeer[]; projects: SecretProject[]; groups: SecretGroup[]; secrets: StoredSecret[]; rules: SecretRule[]; legacy: Legacy[];
  /** The global group without rules that saved secrets with sharing belong to, so every build finds their group. */
  towerGroupId?: string;
}
interface UsageRecord extends SecretUsage { hostId: string; sessionId: string }
interface Journal { brokerApprovals: SecretBrokerApproval[]; groups: SecretGroup[]; rules: SecretRule[]; tasks: SecretTask[]; secrets: StoredSecret[]; usage: UsageRecord[]; operations: Record<string, { taskId: string; runId: string; fingerprint: string; state: 'pending' | 'done'; remote: boolean; claimedAt?: number; result?: unknown }> }
export interface ResolvedSecret { metadata: SecretMetadata; bytes: Buffer; fields?: Record<string, string> }
export interface SecretDispatchUse { ref: string; operation: SecretOperation; value: ResolvedSecret }
/** Written in plain text at every unlocked save: the policy to list names by while locked, and the sources it cannot reach then. */
interface LockedIndex { format: 2; policy: PolicyState; sources: string[]; brokerApprovals: SecretBrokerApproval[] }
const USAGE_LIMIT = 1000;
const REMOTE_TASK_MS = 8 * 60 * 60_000;
const unshared = (): SecretSharing => ({ revision: 1, global: false, folders: [] });
const policySecret = (secret: StoredSecret): PolicySecret => ({ metadata: secret.metadata, fieldNames: secret.fields ? Object.keys(secret.fields) : undefined, sharing: secret.sharing });
const emptyJournal = (): Journal => ({ brokerApprovals: [], groups: [], rules: [], tasks: [], secrets: [], usage: [], operations: Object.create(null) });
const canonicalRoot = (root: unknown): root is string => typeof root === 'string' && isAbsolute(root) && normalize(root) === root && (root === '/' || !root.endsWith('/'));
export class SecretService {
  readonly vault: SecretVault; private permanent?: Permanent; private journal = emptyJournal(); private queue: Promise<unknown> = Promise.resolve(); private readonly now: () => number;
  constructor(options: { stateDir: string; now?: () => number }) { this.vault = new SecretVault(options.stateDir); this.now = options.now ?? Date.now; }
  async start() { await this.vault.start(); this.permanent = undefined; this.journal = emptyJournal(); }
  status(): VaultStatus { return { initialized: this.vault.initialized, locked: this.vault.locked }; }
  private data(): Permanent { if (!this.permanent || this.vault.locked) throw new Error('Vault locked'); return this.permanent; }
  private serialize<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.then(operation); this.queue = next.catch(() => undefined); return next; }
  private async mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.serialize(async () => { this.data(); const permanent = structuredClone(this.permanent); const journal = structuredClone(this.journal); let saving = false; try { const result = await operation(); saving = true; await this.vault.save(this.data(), this.journal, this.lockedIndex()); return result; } catch (error) { if (saving) { this.vault.lock(); this.permanent = undefined; this.journal = emptyJournal(); } else { this.permanent = permanent; this.journal = journal; } throw error; } });
  }
  async initialize(password: string) { return this.serialize(async () => {
    const signing = generateKeyPairSync('ed25519'); const encryption = generateKeyPairSync('x25519');
    const signingKey = signing.publicKey.export({ type: 'spki', format: 'pem' }).toString(); const encryptionKey = encryption.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const data: Permanent = { device: { id: String(randomUUID()), name: 'This computer', signingKey, encryptionKey, fingerprint: createHash('sha256').update(signingKey + ':' + encryptionKey).digest('hex') }, keys: { signingPrivateKey: signing.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), encryptionPrivateKey: encryption.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }, hmac: randomBytes(32).toString('base64'), peers: [], projects: [], groups: [], secrets: [], rules: [], legacy: [] };
    await this.vault.initialize(password, data, data.device.id); this.permanent = data; this.journal = emptyJournal(); await this.vault.save(data, this.journal, this.lockedIndex());
  }); }
  async unlock(password: string) { return this.serialize(async () => this.opened(await this.vault.unlock(password) as Permanent)); }
  /** What the successor worker needs to open this vault without the password; undefined while locked. */
  handoff(): Buffer | undefined {
    const key = this.vault.exportKey(); if (!key) return;
    try { return Buffer.from(JSON.stringify({ format: 1, vaultId: this.vault.vaultId, key: key.toString('base64') })); } finally { key.fill(0); }
  }
  /** Opens with a previous worker's handoff; anything that does not open this very vault leaves it locked. */
  async adopt(carry: Buffer) { return this.serialize(async () => {
    let key: Buffer | undefined;
    try {
      const value = JSON.parse(carry.toString()) as { format?: unknown; vaultId?: unknown; key?: unknown };
      if (value.format !== 1 || typeof value.key !== 'string' || !this.vault.initialized || value.vaultId !== this.vault.vaultId) throw new Error('Handoff is not for this vault');
      key = Buffer.from(value.key, 'base64');
      return this.opened(this.vault.unlockWithKey(key) as Permanent);
    } finally { key?.fill(0); }
  }); }
  private async opened(data: Permanent) {
    try {
      this.permanent = data;
      // Grant records of older builds go at the next save; their tasks have no owner connections.
      const { grants: _grants, ...stored } = (await this.vault.journal() as (Journal & { grants?: unknown }) | undefined) ?? {};
      this.journal = { ...emptyJournal(), ...stored }; this.data();
      for (const task of this.journal.tasks) task.connected ??= [];
    } catch (error) { this.vault.lock(); this.permanent = undefined; throw error; }
    // Vaults saved by older builds have no current index yet; listing while locked works from the next lock on.
    await this.vault.writeIndex(this.lockedIndex()).catch(() => console.warn('Tower could not refresh the secret name index; names stay unlisted while locked until the next save.'));
  }
  async lock() { return this.serialize(async () => { this.vault.lock(); this.permanent = undefined; this.journal = emptyJournal(); }); }
  async changePassword(current: string, next: string) { return this.mutate(() => this.vault.changePassword(current, next)); }
  async flush() { return this.mutate(() => undefined); }
  device() { return structuredClone(this.data().device); }
  deviceKeys() { return { ...this.data().keys }; }
  fingerprintKey() { return Buffer.from(this.data().hmac, 'base64'); }
  peers() { return structuredClone(this.data().peers); }
  async trustPeer(peer: SecretPeer) { return this.mutate(() => { if (!peer.device.id || peer.device.id === this.device().id || !peer.device.signingKey || !peer.device.encryptionKey) throw new Error('Invalid peer'); const existing = this.data().peers.find(item => item.device.id === peer.device.id); if (existing && (existing.device.signingKey !== peer.device.signingKey || existing.device.encryptionKey !== peer.device.encryptionKey)) throw new Error('Peer key changed'); this.data().peers = [...this.data().peers.filter(item => item.device.id !== peer.device.id), structuredClone(peer)]; }); }
  async removePeer(deviceId: string) { return this.mutate(() => { this.data().peers = this.data().peers.filter(peer => peer.device.id !== deviceId); }); }
  private projectId(hostId: string, root: string) { return projectId(this.data(), hostId, root); }
  private lockedIndex(): LockedIndex { return { format: 2, brokerApprovals: structuredClone(this.journal.brokerApprovals), policy: this.policy(), sources: this.data().peers.filter(peer => peer.enabled && peer.direction === 'controller').map(peer => peer.device.id) }; }
  private policy(): PolicyState { const data = this.data(); return { deviceId: data.device.id, servedHosts: servedHosts(data.device.id, data.peers), projects: data.projects, groups: this.groups(), rules: this.allRules(), secrets: this.secrets().map(policySecret), tasks: this.journal.tasks }; }
  private groups() { return [...this.data().groups, ...this.journal.groups]; }
  private allRules() { return [...this.data().rules, ...this.journal.rules]; }
  private secrets() { return [...this.data().secrets, ...this.journal.secrets]; }
  private metadata(secret: StoredSecret): SecretMetadata { return structuredClone(secret.metadata); }
  /** The task a temporary value lives with: its own mark, or the task group it is kept in (the only mark older builds wrote). */
  private temporaryTask(secret: StoredSecret) { return secret.temporaryTaskId ?? this.journal.groups.find(group => group.id === secret.metadata.groupId)?.taskId; }
  private towerGroup(): string {
    const data = this.data();
    if (!data.towerGroupId || !data.groups.some(group => group.id === data.towerGroupId)) { data.towerGroupId = randomUUID(); data.groups.push({ id: data.towerGroupId, name: 'Tower', scope: 'global' }); }
    return data.towerGroupId;
  }
  /** Saved secrets with their sharing, or a summary of the rules they still follow; no values. */
  settings(): SecretSettingsView {
    if (this.vault.locked) return { status: this.status(), peers: [], secrets: [] };
    const state = this.policy();
    return { status: this.status(), device: this.device(), peers: this.peers(), secrets: this.data().secrets.map(secret => ({ ...this.metadata(secret),
      ...(secret.sharing ? { sharing: structuredClone(secret.sharing), ...(withheld(state, policySecret(secret)) ? { withheld: true } : {}) } : { legacy: legacySummary(state, policySecret(secret), this.now()) }) })) };
  }
  /** Validated sharing: folders on a computer this vault serves, or ones already kept, as canonical roots without duplicates. */
  private sharing(input: unknown, current?: SecretSharing): Pick<SecretSharing, 'global' | 'folders'> {
    const value = input as Partial<SecretSharing> | undefined; const invalid = (message: string) => new TowerError('invalid', message);
    if (!value || typeof value !== 'object' || typeof value.global !== 'boolean' || !Array.isArray(value.folders) || value.folders.length > 100) throw invalid('공유 범위 입력이 올바르지 않습니다.');
    const served = servedHosts(this.device().id, this.data().peers); const folders = new Map<string, SecretFolder>();
    for (const folder of value.folders as unknown[]) {
      const { hostId, root } = (folder ?? {}) as Partial<SecretFolder>;
      if (typeof hostId !== 'string' || !hostId || !canonicalRoot(root)) throw invalid('공유할 폴더는 컴퓨터와 정규 절대 경로가 필요합니다.');
      if (!served.includes(hostId) && !current?.folders.some(kept => kept.hostId === hostId && kept.root === root)) throw invalid('시크릿 신뢰를 승인한 컴퓨터의 폴더만 공유할 수 있습니다.');
      folders.set(JSON.stringify([hostId, root]), { hostId, root });
    }
    return { global: value.global, folders: [...folders.values()] };
  }
  async create(input: SecretCreateInput, target?: SecretTarget): Promise<SecretMetadata> { return this.mutate(() => {
    if (this.secrets().length >= 4096) throw new Error('Secret count limit');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 256 || !['scalar', 'env', 'file'].includes(input.kind) || (input.connect !== undefined && input.connect !== 'session')) throw new Error('Invalid secret');
    const supplied = input.kind === 'scalar' ? input.value : input.kind === 'env' && input.value !== undefined ? input.value : input.content;
    if (typeof supplied !== 'string') throw new Error('Invalid secret value');
    const binary = input.kind === 'file' || (input.kind === 'env' && input.value === undefined);
    const bytes = binary ? decode(supplied) : Buffer.from(supplied); if (bytes.length > MAX_SECRET_BYTES) throw new Error('Invalid secret value');
    const value = binary ? bytes.toString('base64') : supplied;
    if ((input.temporary || input.connect) && !target) throw new Error('Task target required');
    if (input.temporary && input.sharing && (input.sharing.global || input.sharing.folders?.length)) throw new TowerError('invalid', '이 세션에만 쓰는 값은 공유할 수 없습니다. 보관함에 저장하세요.');
    const sharing = input.sharing === undefined || input.temporary ? unshared() : { revision: 1, ...this.sharing(input.sharing) };
    const task = target && (input.temporary || input.connect) ? this.ownerTask(target) : undefined;
    const id = randomUUID(); const fields = input.kind === 'env' ? parseDotenv(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : undefined;
    // A temporary value keeps its own task-scope journal group, as 1.130.2 made one, so that build's task close drops it too.
    const groupId = input.temporary ? randomUUID() : this.towerGroup();
    if (input.temporary) this.journal.groups.push({ id: groupId, name: input.name, scope: 'task', taskId: task!.id });
    const secret: StoredSecret = { metadata: { id, name: input.name, groupId, kind: input.kind, version: 1, reference: `tower-secret://${this.vault.vaultId}/${id}@1`, fields: fields ? Object.keys(fields) : undefined }, value, encoding: binary ? 'base64' : undefined, fields, sharing, ...(input.temporary ? { temporaryTaskId: task!.id } : {}) };
    (input.temporary ? this.journal.secrets : this.data().secrets).push(secret);
    if (task) this.join(task, id);
    return this.metadata(secret);
  }); }
  async update(input: { id: string; value?: string; content?: string }): Promise<SecretMetadata> { return this.mutate(() => {
    const secret = this.secrets().find(item => item.metadata.id === input.id); if (!secret) throw new Error('Unknown secret');
    const binary = secret.metadata.kind === 'file' || (secret.metadata.kind === 'env' && input.value === undefined);
    const supplied = binary ? input.content : input.value; if (typeof supplied !== 'string') throw new Error('Invalid secret value');
    const bytes = binary ? decode(supplied) : Buffer.from(supplied); if (bytes.length > MAX_SECRET_BYTES) throw new Error('Invalid secret value');
    const fields = secret.metadata.kind === 'env' ? parseDotenv(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : undefined;
    secret.value = binary ? bytes.toString('base64') : supplied; secret.encoding = binary ? 'base64' : undefined; secret.fields = fields;
    secret.metadata.version++; secret.metadata.fields = fields ? Object.keys(fields) : undefined;
    secret.metadata.reference = `tower-secret://${this.vault.vaultId}/${secret.metadata.id}@${secret.metadata.version}`; return this.metadata(secret);
  }); }
  /**
   * The owner's sharing of one saved secret, replacing what its rules allowed. The rules stop naming it, so an older build
   * reads it as unshared, and a rule naming it again can only come from such a build.
   */
  async setSharing(secretId: string, expectedRevision: number, input: Pick<SecretSharing, 'global' | 'folders'>): Promise<SecretSharing> { return this.mutate(() => {
    const secret = this.data().secrets.find(secret => secret.metadata.id === secretId);
    if (!secret) throw new TowerError('not-found', '공유를 바꿀 키를 찾을 수 없습니다. 화면을 새로고침하세요.');
    if ((secret.sharing?.revision ?? 0) !== expectedRevision) throw new TowerError('conflict', '다른 곳에서 이 키의 공유가 바뀌었습니다. 화면을 새로고침한 뒤 다시 저장하세요.');
    secret.sharing = { revision: expectedRevision + 1, ...this.sharing(input, secret.sharing) };
    this.data().rules = withoutSecrets(this.data().rules, id => id === secretId); this.journal.rules = withoutSecrets(this.journal.rules, id => id === secretId);
    return structuredClone(secret.sharing);
  }); }
  async remove(id: string) { return this.mutate(() => {
    this.data().secrets = this.data().secrets.filter(secret => secret.metadata.id !== id); this.journal.secrets = this.journal.secrets.filter(secret => secret.metadata.id !== id);
    this.pruneRules();
  }); }
  /** Rules and connections never keep naming a removed or expired key: the editor could not unselect it and every save would be refused. */
  private pruneRules() {
    const live = new Set(this.secrets().map(secret => secret.metadata.id)); const gone = (id: string) => !live.has(id);
    this.data().rules = withoutSecrets(this.data().rules, gone); this.journal.rules = withoutSecrets(this.journal.rules, gone);
    for (const task of this.journal.tasks) task.connected = task.connected.filter(id => live.has(id));
  }
  currentTask(sessionId: string, root?: string, hostId = this.device().id): SecretTarget | undefined {
    const task = [...this.journal.tasks].reverse().find(task => task.sessionId === sessionId && task.hostId === hostId && (root === undefined || task.root === root) && task.status === 'open' && (task.expiresAt === undefined || task.expiresAt > this.now()));
    return task ? { hostId, sessionId, root: task.root, taskId: task.id, projectId: this.projectId(hostId, task.root) } : undefined;
  }
  /** Refusal metadata only: a locked index can protect admission, never authorize broker use. */
  brokerAdmissionRequired(sessionId: string): boolean | undefined {
    if (!this.status().initialized) return false;
    let hostId: string, tasks: SecretTask[], approvals: SecretBrokerApproval[];
    if (!this.status().locked) { hostId = this.device().id; tasks = this.journal.tasks; approvals = this.journal.brokerApprovals; }
    else {
      const index = this.vault.index as Partial<LockedIndex> | undefined;
      const id = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
      const name = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
      const root = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && normalize(value) === value;
      const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
      if (!index || !index.policy || !id(index.policy.deviceId) || index.policy.deviceId !== this.vault.vaultId || !Array.isArray(index.policy.tasks) || index.policy.tasks.length > 10000 || !Array.isArray(index.brokerApprovals) || index.brokerApprovals.length > 10000) return;
      if (index.policy.tasks.some(task => !task || !id(task.id) || !id(task.hostId) || !name(task.sessionId) || !root(task.root) || !['open', 'closed'].includes(task.status) || !time(task.createdAt) || (task.expiresAt !== undefined && !time(task.expiresAt)))) return;
      if (index.brokerApprovals.some(approval => !approval || !id(approval.id) || !id(approval.hostId) || !name(approval.sessionId) || !root(approval.root) || !id(approval.taskId) || !name(approval.taskLabel) || !time(approval.createdAt) || !time(approval.expiresAt) || approval.expiresAt <= approval.createdAt || approval.expiresAt - approval.createdAt > 8 * 60 * 60_000)) return;
      hostId = index.policy.deviceId; tasks = index.policy.tasks; approvals = index.brokerApprovals;
    }
    const protectedSession = approvals.some(approval => approval.hostId === hostId && approval.sessionId === sessionId && approval.expiresAt > this.now() && tasks.some(task => task.id === approval.taskId && task.hostId === hostId && task.sessionId === sessionId && task.root === approval.root && task.status === 'open' && (task.expiresAt === undefined || task.expiresAt > this.now())));
    // The plaintext index has freshness, not integrity: a positive only strengthens refusal.
    // Absence while locked can never prove that untrusted input is safe for this conversation.
    return protectedSession ? true : this.status().locked ? undefined : false;
  }
  /** Connection approval is independent of every secret policy and stays in the encrypted journal. */
  brokerApproval(sessionId: string, root: string): SecretBrokerApproval | undefined {
    if (this.status().locked) return;
    const target = this.currentTask(sessionId, root);
    const approval = this.journal.brokerApprovals.find(item => item.sessionId === sessionId && item.root === root && item.hostId === this.device().id && item.taskId === target?.taskId && item.expiresAt > this.now());
    return approval ? structuredClone(approval) : undefined;
  }
  async approveBroker(input: { sessionId: string; root: string; taskId: string | null; taskLabel: string; ttlMs: number }, validate: () => void): Promise<SecretBrokerApproval> {
    return this.mutate(() => {
      validate();
      if (!input.sessionId || !isAbsolute(input.root) || normalize(input.root) !== input.root || !input.taskLabel.trim() || input.taskLabel.length > 256 || !Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > 8 * 60 * 60_000) throw new TowerError('invalid', '브로커 승인 입력이 올바르지 않습니다.');
      // A session has one open security task across all roots; a project move requires closing it first.
      let bound: SecretTask | undefined;
      try { bound = sessionTask(this.journal, input.sessionId, this.device().id, input.root); }
      catch (error) { throw new TowerError('conflict', '현재 시크릿 작업을 종료한 뒤 다른 프로젝트를 승인하세요.', { cause: error }); }
      if (bound?.expiresAt !== undefined && bound.expiresAt <= this.now()) throw new TowerError('conflict', '만료된 시크릿 작업을 종료한 뒤 새 작업을 승인하세요.');
      const current = this.currentTask(input.sessionId, input.root);
      if ((current?.taskId ?? null) !== input.taskId) throw new TowerError('conflict', '시크릿 작업이 변경되었습니다. 화면을 새로고침하세요.');
      const existing = this.brokerApproval(input.sessionId, input.root);
      if (existing) {
        if (existing.taskLabel !== input.taskLabel.trim()) throw new TowerError('conflict', '기존 브로커 승인을 먼저 철회하세요.');
        return existing;
      }
      let taskId = current?.taskId;
      if (!taskId) {
        if (this.journal.tasks.length >= 10000) throw new Error('Task count limit');
        const task: SecretTask = { id: randomUUID(), hostId: this.device().id, sessionId: input.sessionId, root: input.root, status: 'open', createdAt: this.now(), excluded: [], connected: [] };
        this.journal.tasks.push(task); taskId = task.id;
      }
      const approval: SecretBrokerApproval = { id: randomUUID(), hostId: this.device().id, sessionId: input.sessionId, root: input.root, taskId, taskLabel: input.taskLabel.trim(), createdAt: this.now(), expiresAt: this.now() + input.ttlMs };
      this.journal.brokerApprovals = this.journal.brokerApprovals.filter(item => item.sessionId !== input.sessionId);
      this.journal.brokerApprovals.push(approval);
      return structuredClone(approval);
    });
  }
  async revokeBroker(sessionId: string, approvalId: string): Promise<void> {
    return this.mutate(() => {
      const approval = this.journal.brokerApprovals.find(item => item.sessionId === sessionId && item.id === approvalId);
      if (!approval) throw new TowerError('not-found', '철회할 브로커 승인을 찾을 수 없습니다.');
      this.journal.brokerApprovals = this.journal.brokerApprovals.filter(item => item.id !== approvalId);
    });
  }
  checkBrokerApproval(target: SecretTarget & { brokerApprovalId?: string }): void {
    if (!target.brokerApprovalId) return;
    const approval = this.brokerApproval(target.sessionId, target.root);
    if (!approval || approval.id !== target.brokerApprovalId || approval.taskId !== target.taskId || approval.hostId !== target.hostId) throw new TowerError('forbidden', '이 작업의 브로커 승인이 만료되거나 철회되었습니다.');
  }
  async bindRun(sessionId: string, root: string, startedAt: string): Promise<SecretTarget> {
    const started = Date.parse(startedAt); if (!Number.isFinite(started)) throw new Error('Invalid run start');
    return this.ensureTask(sessionId, root, undefined, started);
  }

  async ensureTask(sessionId: string, canonicalRoot: string, hostId?: string, runStartedAt?: number): Promise<SecretTarget> { return this.mutate(() => { hostId ??= this.device().id; if (!sessionId || !isAbsolute(canonicalRoot) || normalize(canonicalRoot) !== canonicalRoot) throw new Error('Invalid task identity'); let task = sessionTask(this.journal, sessionId, hostId, canonicalRoot, runStartedAt); if (!task) { if (this.journal.tasks.length >= 10000) throw new Error('Task count limit'); task = { id: randomUUID(), hostId, sessionId, root: canonicalRoot, status: 'open', createdAt: this.now(), excluded: [], connected: [] }; this.journal.tasks.push(task); } return { hostId, sessionId, root: canonicalRoot, taskId: task.id, projectId: this.projectId(hostId, canonicalRoot) }; }); }
  /**
   * A trusted node's task on this source. Automatic use starts one only in a folder `covered` here; `owner` is for a session
   * the owner acted on, which its node already verified, and starts one in any folder. A task that exists is admitted with
   * its own identity whatever is shared now, so its close still arrives; each use is authorized on its own.
   */
  async ensureRemoteTask(context: SecretContext, options: { owner?: boolean } = {}): Promise<SecretContext> { return this.mutate(() => ({ ...context, ...this.remoteTask(context, options.owner === true) })); }
  private remoteTask(target: SecretTarget, owner: boolean): SecretTarget {
    const existing = this.journal.tasks.some(task => task.id === target.taskId);
    if (!this.data().peers.some(peer => peer.enabled && peer.device.id === target.hostId) || !canonicalRoot(target.root) || !/^[a-f0-9-]{36}$/.test(target.taskId) || !target.sessionId || (!owner && !existing && !covered(this.policy(), target.hostId, target.root, target.taskId, this.now()))) throw new Error('Remote task denied');
    const { hostId, sessionId, root, taskId } = target; const trusted = { hostId, sessionId, root, taskId, projectId: this.projectId(hostId, root) };
    if (existing) { this.task(trusted); return trusted; }
    if (this.journal.tasks.length >= 10000) throw new Error('Task count limit');
    this.journal.tasks.push({ id: taskId, hostId, sessionId, root, status: 'open', createdAt: this.now(), expiresAt: this.now() + REMOTE_TASK_MS, excluded: [], connected: [] }); return trusted;
  }
  /** The open task of a target the owner acted on; a remote session's first one starts here, in the same commit as the owner's change. */
  private ownerTask(target: SecretTarget): SecretTask { return this.task(target.hostId === this.device().id ? target : this.remoteTask(target, true)); }
  private task(target: SecretTarget): SecretTask { this.checkBrokerApproval(target); return openTask(this.policy(), target, this.now()); }
  private join(task: SecretTask, id: string) { task.excluded = task.excluded.filter(excluded => excluded !== id); if (!task.connected.includes(id)) task.connected.push(id); }
  /** Recipient-side task closure and exclusions also apply to remotely owned secrets. */
  checkTask(target: SecretTarget, secretId?: string): void {
    const task = this.task(target);
    if (secretId && task.excluded.includes(secretId)) throw new Error('Secret revoked for task');
  }
  /** The owner connects saved secrets, or this task's own temporary values, to one session: every operation and field there. */
  async connectSession(target: SecretTarget, secretIds: string[]): Promise<void> { return this.mutate(() => {
    const task = this.ownerTask(target);
    for (const id of secretIds) {
      const secret = this.secrets().find(secret => secret.metadata.id === id);
      if (!secret || (secret.metadata.expiresAt !== undefined && secret.metadata.expiresAt <= this.now()) || (this.temporaryTask(secret) ?? task.id) !== task.id) throw new Error('Secret unavailable');
      this.join(task, id);
    }
  }); }
  /**
   * Stops secrets in one session whatever allows them there, connection, sharing or rules, until the owner connects them
   * again. Like a connection, a remote session's first one starts its task here.
   */
  async disconnectSession(target: SecretTarget, secretIds: string[]): Promise<void> { return this.mutate(() => {
    const task = this.ownerTask(target);
    task.connected = task.connected.filter(id => !secretIds.includes(id)); task.excluded = [...new Set([...task.excluded, ...secretIds])];
  }); }
  async closeTask(taskId: string) { return this.mutate(() => { const task = this.journal.tasks.find(task => task.id === taskId); if (!task) throw new Error('Unknown task'); this.endTask(task); }); }

  async closeSessions(hashes: string[]): Promise<void> { return this.mutate(() => {
    for (const task of this.journal.tasks) if (task.status === 'open' && hashes.includes(createHash('sha256').update('tower-secret-session-close-v1:' + task.sessionId).digest('hex'))) this.endTask(task);
  }); }
  private endTask(task: SecretTask): void {
    task.status = 'closed'; task.closedAt = this.now(); task.connected = [];
    const groupIds = this.journal.groups.filter(group => group.taskId === task.id).map(group => group.id);
    this.journal.secrets = this.journal.secrets.filter(secret => secret.temporaryTaskId !== task.id && !groupIds.includes(secret.metadata.groupId));
    this.journal.groups = this.journal.groups.filter(group => !groupIds.includes(group.id));
    this.journal.rules = this.journal.rules.filter(rule => !groupIds.includes(rule.groupId));
    // Claims stay while a signed close response is being committed; expired replay is rejected by its envelope.
  }
  async sweep(liveRuns: ReadonlySet<string>): Promise<void> { return this.mutate(() => {
    for (const task of this.journal.tasks) if (task.status === 'open' && task.expiresAt !== undefined && task.expiresAt <= this.now()) { this.endTask(task); task.closedAt = task.expiresAt; }
    const expired = this.secrets().filter(secret => secret.metadata.expiresAt !== undefined && secret.metadata.expiresAt <= this.now()).map(secret => secret.metadata.id);
    this.data().secrets = this.data().secrets.filter(secret => !expired.includes(secret.metadata.id));
    this.journal.secrets = this.journal.secrets.filter(secret => !expired.includes(secret.metadata.id));
    this.pruneRules();
    for (const [id, operation] of Object.entries(this.journal.operations)) {
      const remote = operation.remote === true;
      if (remote ? operation.claimedAt !== undefined && operation.claimedAt + 60_000 < this.now() : !liveRuns.has(operation.runId)) delete this.journal.operations[id];
    }
  }); }
  private authorize(context: SecretContext, secret: StoredSecret, operation: SecretOperation): Decision { this.checkBrokerApproval(context); const state = this.policy(); const task = openTask(state, context, this.now()); if (!context.runId) throw new Error('Secret access denied'); return authorize(state, task, policySecret(secret), operation, this.now()); }
  async list(context: SecretContext): Promise<SecretMetadata[]> { return this.serialize(async () => { this.data(); this.checkBrokerApproval(context); const state = this.policy(); const task = openTask(state, context, this.now()); return context.runId ? available(state, task, this.now()).map(wireMetadata) : []; }); }
  /** What a session may discover now, without starting or changing a task: its open task's view, or a fresh task's. */
  available(subject: { hostId?: string; sessionId: string; root: string; taskId?: string }): SecretAvailable[] {
    const state = this.policy(); const hostId = subject.hostId ?? state.deviceId; const now = this.now();
    const task = subject.taskId ? state.tasks.find(task => task.id === subject.taskId) : sessionTask(state, subject.sessionId, hostId, subject.root);
    if (task && (task.hostId !== hostId || task.sessionId !== subject.sessionId || task.root !== subject.root)) throw new Error('Task identity denied');
    return available(state, task ?? { id: subject.taskId ?? '', hostId, sessionId: subject.sessionId, root: subject.root, status: 'open', createdAt: now, excluded: [], connected: [] }, now);
  }
  /** A trusted node's read of what its session may discover here; admits and records nothing. */
  availableFor(context: SecretContext): SecretAvailable[] {
    if (!this.data().peers.some(peer => peer.enabled && peer.device.id === context.hostId) || !canonicalRoot(context.root) || !/^[a-f0-9-]{36}$/.test(context.taskId) || !context.sessionId) throw new Error('Remote task denied');
    return this.available(context);
  }
  /** What a vault locked since its last save lets a run discover, from that save's plaintext index; undefined without a current one. */
  lockedList(sessionId: string, root: string, runStartedAt: string, bound?: SecretTarget): { secrets: SecretMetadata[]; sources: string[] } | undefined {
    const index = this.vault.index as Partial<LockedIndex> | undefined; if (index?.format !== 2 || !index.policy || !index.sources) return;
    const { policy: state, sources } = index; const now = this.now();
    // An unbound run gets the task binding would give it; a task binding would create has no connections or temporary values yet.
    const open = bound ? undefined : sessionTask(state, sessionId, state.deviceId, root, Date.parse(runStartedAt));
    const target = bound ?? (open && { hostId: state.deviceId, sessionId, root, taskId: open.id });
    const task = target ? openTask(state, { ...target, projectId: projectId(state, target.hostId, target.root) }, now)
      : { id: '', hostId: state.deviceId, sessionId, root, status: 'open' as const, createdAt: now, excluded: [], connected: [] };
    return { secrets: available(state, task, now).map(wireMetadata), sources };
  }
  async resolve(context: SecretContext, ref: string, operation: SecretOperation): Promise<ResolvedSecret> { return this.serialize(async () => { this.data(); return this.resolved(context, ref, operation); }); }
  /** Validate current authority and begin use in one turn; never hold policy writes for a consumer's runtime. */
  dispatch<T>(context: SecretContext, uses: readonly SecretDispatchUse[], start: () => T, validate?: () => void): Promise<{ result: T }> {
    return this.serialize(async () => {
      this.data(); this.checkTask(context);
      const localHost = this.device().id;
      for (const use of uses) {
        if (!use.ref.startsWith(`tower-secret://${localHost}/`)) { this.checkTask(context, use.value.metadata.id); continue; }
        const current = this.resolved(context, use.ref, use.operation);
        try { if (!current.bytes.equals(use.value.bytes) || JSON.stringify(current.fields) !== JSON.stringify(use.value.fields)) throw new Error('Secret authority or value changed'); }
        finally { current.bytes.fill(0); }
      }
      // Wrapping the promise releases this queue after spawn, so owner lock/revoke still applies immediately.
      validate?.();
      return { result: start() };
    });
  }
  private resolved(context: SecretContext, ref: string, operation: SecretOperation): ResolvedSecret {
    if (operation === 'discover' || !SECRET_OPERATIONS.includes(operation)) throw new Error('Use operation required');
    const match = /^tower-secret:\/\/([^/]+)\/([^@/#]+)@(\d+)(?:#(.+))?$/.exec(ref);
    let candidates: StoredSecret[]; let field: string | undefined;
    if (match) { if (match[1] !== this.vault.vaultId) throw new Error('Wrong vault'); candidates = this.secrets().filter(secret => secret.metadata.id === match[2] && secret.metadata.version === Number(match[3])); field = match[4] ? decodeURIComponent(match[4]) : undefined; }
    else { if (ref.startsWith('tower-secret:')) throw new Error('Invalid reference'); candidates = this.secrets().filter(secret => secret.metadata.name === ref); }
    if (candidates.length !== 1) throw new Error('Unknown or ambiguous secret reference'); const secret = candidates[0]; const allowed = this.authorize(context, secret, operation).fields;
    if (field !== undefined) { if (!secret.fields || !Object.hasOwn(secret.fields, field) || !allowed?.includes(field)) throw new Error('Field denied'); return { metadata: this.metadata(secret), bytes: Buffer.from(secret.fields[field]) }; }
    if (secret.fields && !Object.keys(secret.fields).every(key => allowed!.includes(key))) { if (operation !== 'env') throw new Error('Whole dotenv access denied'); return { metadata: this.metadata(secret), bytes: Buffer.alloc(0), fields: Object.fromEntries(allowed!.map(key => [key, secret.fields![key]])) }; }
    return { metadata: this.metadata(secret), bytes: secret.encoding === 'base64' ? decode(secret.value) : Buffer.from(secret.value), fields: secret.fields ? { ...secret.fields } : undefined };
  }
  async beginOperation(context: SecretContext, id: string, fingerprint: string): Promise<{ state: 'pending' | 'done'; fresh: boolean; result?: unknown }> { return this.mutate(() => { this.task(context); if (!context.runId || !/^[A-Za-z0-9._:-]{1,200}$/.test(id) || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid operation'); const existing = this.journal.operations[id]; if (existing) { if (existing.taskId !== context.taskId || existing.runId !== context.runId || existing.fingerprint !== fingerprint) throw new Error('Operation identity conflict'); return { state: existing.state, fresh: false, result: structuredClone(existing.result) }; } if (Object.keys(this.journal.operations).length >= 10000) throw new Error('Operation ledger full'); this.journal.operations[id] = { taskId: context.taskId, runId: context.runId, fingerprint, state: 'pending', remote: context.hostId !== this.device().id, claimedAt: this.now() }; return { state: 'pending', fresh: true }; }); }
  async finishOperation(context: SecretContext, id: string, fingerprint: string, result: unknown) { return this.mutate(() => { const existing = this.journal.operations[id]; if (!existing || existing.taskId !== context.taskId || existing.runId !== context.runId || existing.fingerprint !== fingerprint || existing.state !== 'pending') throw new Error('Operation identity conflict'); if (Buffer.byteLength(JSON.stringify(result)) > 3 * MAX_SECRET_BYTES) throw new Error('Operation result too large'); existing.state = 'done'; existing.result = structuredClone(result); }); }
  /** Keeps the latest uses, value-free and encrypted, so each session's chat shows what it used. */
  async recordUsage(target: Pick<SecretTarget, 'hostId' | 'sessionId'>, entries: readonly SecretUsage[]): Promise<void> { return this.mutate(() => {
    for (const entry of entries) {
      if (!SECRET_OPERATIONS.includes(entry.operation) || !['delivered', 'blocked'].includes(entry.outcome) || !['exempt', 'allowed', 'blocked', 'failed'].includes(entry.review) || !Number.isSafeInteger(entry.at) || typeof entry.secretId !== 'string' || typeof entry.name !== 'string' || (entry.reason !== undefined && (typeof entry.reason !== 'string' || entry.reason.length > 2000))) throw new Error('Invalid secret usage');
      this.journal.usage.push({ ...structuredClone(entry), hostId: target.hostId, sessionId: target.sessionId });
    }
    this.journal.usage.splice(0, Math.max(0, this.journal.usage.length - USAGE_LIMIT));
  }); }
  usage(subject: { hostId?: string; sessionId: string }): SecretUsage[] {
    const hostId = subject.hostId ?? this.data().device.id;
    return this.journal.usage.filter(entry => entry.hostId === hostId && entry.sessionId === subject.sessionId).map(({ hostId: _hostId, sessionId: _sessionId, ...entry }) => structuredClone(entry));
  }
  async importLegacy(records: Legacy[]) { return this.mutate(() => { for (const record of records) { if (!record.id || typeof record.name !== 'string' || typeof record.origin !== 'string' || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) || typeof record.value !== 'string' || Buffer.byteLength(record.value) > MAX_SECRET_BYTES) throw new Error('Invalid legacy secret'); const existing = this.data().legacy.find(item => item.id === record.id); if (existing && JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Legacy secret conflict'); if (!existing) this.data().legacy.push(structuredClone(record)); } }); }
  legacyList() { return this.data().legacy.map(({ value: _value, ...metadata }) => metadata); }
  legacyGet(id: string) { const record = this.data().legacy.find(record => record.id === id); return record ? structuredClone(record) : undefined; }
  async legacyCreate(input: { name: string; value: string; origin: string }, now = this.now()) { const record = { ...input, id: randomUUID(), createdAt: new Date(now).toISOString() }; await this.importLegacy([record]); return record; }
  async legacyRemove(id: string) { return this.mutate(() => { this.data().legacy = this.data().legacy.filter(record => record.id !== id); }); }
  /** Copies another vault's saved values and groups, never its identity, trust, rules, sharing or connections: everything arrives unshared. */
  async importEncryptedVault(content: Buffer, password: string): Promise<void> {
    const source = await this.vault.decryptImport(content, password) as Permanent;
    await this.mutate(() => {
      if (!Array.isArray(source.secrets) || !Array.isArray(source.groups) || !Array.isArray(source.legacy)) throw new Error('Invalid import payload');
      const importedGroups = source.groups.filter(group => group.scope !== 'task');
      for (const group of importedGroups) {
        const existing = this.data().groups.find(item => item.id === group.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(group)) throw new Error('Group import conflict');
      }
      const records = source.secrets.filter(secret => importedGroups.some(group => group.id === secret.metadata.groupId)).map(secret => {
        const { sharing: _sharing, temporaryTaskId: _task, ...record } = structuredClone(secret);
        record.metadata.reference = `tower-secret://${this.vault.vaultId}/${record.metadata.id}@${record.metadata.version}`; return record;
      });
      // A secret already here keeps its own sharing or rules; its stored value and metadata must agree.
      const comparable = ({ sharing: _sharing, ...secret }: StoredSecret) => JSON.stringify(secret);
      for (const record of records) { const existing = this.secrets().find(item => item.metadata.id === record.metadata.id); if (existing && comparable(existing) !== JSON.stringify(record)) throw new Error('Secret import conflict'); }
      for (const legacy of source.legacy) { const existing = this.data().legacy.find(item => item.id === legacy.id); if (existing && JSON.stringify(existing) !== JSON.stringify(legacy)) throw new Error('Legacy import conflict'); }
      for (const group of importedGroups) {
        if (!this.data().groups.some(item => item.id === group.id)) this.data().groups.push(structuredClone(group));
        if (group.projectId && !this.data().projects.some(item => item.id === group.projectId)) this.data().projects.push({ id: group.projectId, name: source.projects?.find(item => item.id === group.projectId)?.name ?? 'Imported project', bindings: [] });
      }
      for (const record of records) if (!this.secrets().some(item => item.metadata.id === record.metadata.id)) this.data().secrets.push({ ...record, sharing: unshared() });
      for (const legacy of source.legacy) if (!this.data().legacy.some(item => item.id === legacy.id)) this.data().legacy.push(structuredClone(legacy));
    });
  }
  async exportEncryptedVault() { await this.queue; return this.vault.read('vault.json'); }
}
