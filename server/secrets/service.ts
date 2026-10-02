import { randomUUID, randomBytes, generateKeyPairSync, createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import type { SecretContext, SecretCreateInput, SecretDevice, SecretGroup, SecretMetadata, SecretOperation, SecretOverview, SecretPeer, SecretProject, SecretRule, SecretTarget, SecretTask, VaultStatus } from '../../shared/secrets.js';
import { MAX_SECRET_BYTES, SECRET_OPERATIONS, DEFAULT_SECRET_USE_OPERATIONS } from '../../shared/secrets.js';
import { SecretVault } from './vault.js';
import { decode } from './crypto.js';
import { parseDotenv } from './dotenv.js';
import { authorize, discoverable, openTask, projectId, sessionTask, matchingRules, activeRules, selectedFields, type PolicyGrant, type PolicySecret, type PolicyState } from './policy.js';
interface StoredSecret { metadata: SecretMetadata; value: string; encoding?: 'base64'; fields?: Record<string, string> }
type Grant = PolicyGrant;
interface Legacy { id: string; name: string; value: string; createdAt: string; origin: string }
interface Permanent { device: SecretDevice; keys: { signingPrivateKey: string; encryptionPrivateKey: string }; hmac: string; peers: SecretPeer[]; projects: SecretProject[]; groups: SecretGroup[]; secrets: StoredSecret[]; rules: SecretRule[]; legacy: Legacy[] }
interface Journal { groups: SecretGroup[]; rules: SecretRule[]; tasks: SecretTask[]; secrets: StoredSecret[]; grants: Grant[]; operations: Record<string, { taskId: string; runId: string; fingerprint: string; state: 'pending' | 'done'; remote: boolean; claimedAt?: number; result?: unknown }> }
export interface ResolvedSecret { metadata: SecretMetadata; bytes: Buffer; fields?: Record<string, string> }
export interface SecretDispatchUse { ref: string; operation: SecretOperation; value: ResolvedSecret }
/** Written in plain text at every unlocked save: the policy to list names by while locked, and the sources it cannot reach then. */
interface LockedIndex { policy: PolicyState; sources: string[] }
const policySecret = (secret: StoredSecret): PolicySecret => ({ metadata: secret.metadata, fieldNames: secret.fields ? Object.keys(secret.fields) : undefined });
const emptyJournal = (): Journal => ({ groups: [], rules: [], tasks: [], secrets: [], grants: [], operations: Object.create(null) });
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
  async unlock(password: string) { return this.serialize(async () => { const data = await this.vault.unlock(password) as Permanent; try { this.permanent = data; this.journal = { ...emptyJournal(), ...((await this.vault.journal() as Journal | undefined) ?? {}) }; this.data(); } catch (error) { this.vault.lock(); this.permanent = undefined; throw error; }
    // Vaults saved by older builds have no index yet; listing while locked works from the next lock on.
    await this.vault.writeIndex(this.lockedIndex()).catch(() => console.warn('Tower could not refresh the secret name index; names stay unlisted while locked until the next save.'));
  }); }
  async lock() { return this.serialize(async () => { this.vault.lock(); this.permanent = undefined; this.journal = emptyJournal(); }); }
  async changePassword(current: string, next: string) { return this.mutate(() => this.vault.changePassword(current, next)); }
  async flush() { return this.mutate(() => undefined); }
  device() { return structuredClone(this.data().device); }
  deviceKeys() { return { ...this.data().keys }; }
  fingerprintKey() { return Buffer.from(this.data().hmac, 'base64'); }
  peers() { return structuredClone(this.data().peers); }
  async trustPeer(peer: SecretPeer) { return this.mutate(() => { if (!peer.device.id || peer.device.id === this.device().id || !peer.device.signingKey || !peer.device.encryptionKey) throw new Error('Invalid peer'); const existing = this.data().peers.find(item => item.device.id === peer.device.id); if (existing && (existing.device.signingKey !== peer.device.signingKey || existing.device.encryptionKey !== peer.device.encryptionKey)) throw new Error('Peer key changed'); this.data().peers = [...this.data().peers.filter(item => item.device.id !== peer.device.id), structuredClone(peer)]; }); }
  async removePeer(deviceId: string) { return this.mutate(() => { this.data().peers = this.data().peers.filter(peer => peer.device.id !== deviceId); }); }
  async project(input: { id?: string; name: string; bindings: { hostId: string; root: string }[] }) { return this.mutate(() => {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 256 || !Array.isArray(input.bindings) || !input.bindings.length || input.bindings.length > 100 || input.bindings.some(binding => !binding.hostId || !isAbsolute(binding.root) || normalize(binding.root) !== binding.root)) throw new Error('Invalid project');
    if (input.id && !this.data().projects.some(project => project.id === input.id)) throw new Error('Unknown project');
    if (input.bindings.some(binding => this.data().projects.some(project => project.id !== input.id && project.bindings.some(other => other.hostId === binding.hostId && other.root === binding.root)))) throw new Error('Project binding already exists');
    const project: SecretProject = { id: input.id ?? randomUUID(), name: input.name, bindings: structuredClone(input.bindings) };
    this.data().projects = [...this.data().projects.filter(item => item.id !== project.id), project]; return structuredClone(project);
  }); }

  private projectId(hostId: string, root: string) { return projectId(this.data(), hostId, root); }
  /** Live view for authorization: grants issued during an evaluation land in the journal it reads. */
  private lockedIndex(): LockedIndex { return { policy: this.policy(), sources: this.data().peers.filter(peer => peer.enabled && peer.direction === 'controller').map(peer => peer.device.id) }; }
  private policy(): PolicyState { const data = this.data(); return { deviceId: data.device.id, projects: data.projects, groups: this.groups(), rules: this.allRules(), secrets: this.secrets().map(policySecret), tasks: this.journal.tasks, grants: this.journal.grants }; }
  private groups() { return [...this.data().groups, ...this.journal.groups]; }
  private allRules() { return [...this.data().rules, ...this.journal.rules]; }
  private secrets() { return [...this.data().secrets, ...this.journal.secrets]; }
  private metadata(secret: StoredSecret): SecretMetadata { return structuredClone(secret.metadata); }
  overview(target?: SecretTarget): SecretOverview { if (this.vault.locked) return { status: this.status(), peers: [], projects: [], groups: [], secrets: [], rules: [], connected: [] }; const data = this.data(); return { status: this.status(), device: this.device(), peers: this.peers(), projects: structuredClone(data.projects), groups: structuredClone(this.groups()), secrets: this.secrets().map(secret => this.metadata(secret)), rules: structuredClone(this.allRules()), target, task: target ? structuredClone(this.journal.tasks.find(task => task.id === target.taskId)) : undefined, connected: target ? this.journal.grants.filter(grant => grant.taskId === target.taskId).map(grant => grant.secretId) : [] }; }
  async create(input: SecretCreateInput): Promise<SecretMetadata> { return this.mutate(() => {
    if (this.secrets().length >= 4096) throw new Error('Secret count limit');
    if (!input.name.trim() || input.name.length > 256 || !['scalar', 'env', 'file'].includes(input.kind) || !['global', 'project', 'task'].includes(input.scope)) throw new Error('Invalid secret');
    const supplied = input.kind === 'scalar' ? input.value : input.kind === 'env' && input.value !== undefined ? input.value : input.content;
    if (typeof supplied !== 'string') throw new Error('Invalid secret value');
    const binary = input.kind === 'file' || (input.kind === 'env' && input.value === undefined);
    const bytes = binary ? decode(supplied) : Buffer.from(supplied); if (bytes.length > MAX_SECRET_BYTES) throw new Error('Invalid secret value');
    const value = binary ? bytes.toString('base64') : supplied;
    if (input.operations?.some(operation => !SECRET_OPERATIONS.includes(operation)) || (input.activation !== undefined && !['manual', 'auto'].includes(input.activation))) throw new Error('Invalid secret policy');
    if (input.expiresAt !== undefined && (!Number.isFinite(input.expiresAt) || input.expiresAt <= this.now())) throw new Error('Secret expired');
    if (input.scope === 'project' && !this.data().projects.some(project => project.id === input.projectId)) throw new Error('Unknown project');
    if (input.scope === 'task') { if (!input.target) throw new Error('Task target required'); this.task(input.target); }
    let group = input.groupId ? this.groups().find(group => group.id === input.groupId) : undefined;
    if (input.groupId && !group) throw new Error('Unknown group');
    if (group && (group.scope !== input.scope || group.projectId !== (input.scope === 'project' ? input.projectId : undefined) || group.taskId !== (input.scope === 'task' ? input.target?.taskId : undefined))) throw new Error('Group scope mismatch');
    if (!group) { group = { id: randomUUID(), name: input.groupName || input.name, scope: input.scope, projectId: input.scope === 'project' ? input.projectId : undefined, taskId: input.scope === 'task' ? input.target?.taskId : undefined }; (group.scope === 'task' ? this.journal.groups : this.data().groups).push(group); }
    const id = randomUUID(); const fields = input.kind === 'env' ? parseDotenv(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : undefined;
    const secret: StoredSecret = { metadata: { id, name: input.name, groupId: group.id, kind: input.kind, version: 1, reference: `tower-secret://${this.vault.vaultId}/${id}@1`, fields: fields ? Object.keys(fields) : undefined, expiresAt: input.expiresAt }, value, encoding: binary ? 'base64' : undefined, fields };
    (input.scope === 'task' ? this.journal.secrets : this.data().secrets).push(secret);
    if (input.target) { const target = this.task(input.target); const operations = input.operations ?? [...SECRET_OPERATIONS]; const rule: SecretRule = { id: randomUUID(), groupId: group.id, secretIds: [id], hostId: target.hostId, projectId: input.allProjects && group.scope === 'global' ? undefined : input.projectId ?? this.projectId(target.hostId, target.root), ...(group.scope === 'global' && input.allProjects ? { allProjects: true } : {}), ...(!input.projectId && !this.projectId(target.hostId, target.root) && !input.allProjects ? { root: target.root } : {}), activation: input.activation ?? 'manual', operations, enabled: true, revision: 1, ...(target.hostId !== this.device().id ? { maxTtlMs: 8 * 60 * 60_000 } : {}) }; (group.scope === 'task' ? this.journal.rules : this.data().rules).push(rule); if (input.connect) { if (!this.rules(target, secret).includes(rule)) throw new Error('Connection policy does not match task'); this.grant(target, policySecret(secret), rule); } }
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
  async remove(id: string) { return this.mutate(() => { this.data().secrets = this.data().secrets.filter(secret => secret.metadata.id !== id); this.journal.secrets = this.journal.secrets.filter(secret => secret.metadata.id !== id); this.journal.grants = this.journal.grants.filter(grant => grant.secretId !== id); }); }
  async setRule(input: Omit<SecretRule, 'id' | 'revision'> & { id?: string }): Promise<SecretRule> { return this.mutate(() => {
    const group = this.groups().find(group => group.id === input.groupId);
    if (!group || !input.hostId || (input.root !== undefined && (!isAbsolute(input.root) || normalize(input.root) !== input.root)) || (input.allProjects && (group.scope !== 'global' || input.projectId !== undefined || input.root !== undefined)) || !['manual', 'auto'].includes(input.activation) || !input.operations.length || input.operations.some(operation => !SECRET_OPERATIONS.includes(operation)) || input.secretIds.some(id => !this.secrets().some(secret => secret.metadata.id === id && secret.metadata.groupId === group.id)) || (input.projectId && !this.data().projects.some(project => project.id === input.projectId)) || (group.scope === 'project' && group.projectId !== input.projectId) || (input.maxTtlMs !== undefined && (!Number.isSafeInteger(input.maxTtlMs) || input.maxTtlMs <= 0))) throw new Error('Invalid rule');
    for (const id of Object.keys(input.fields ?? {})) { const secret = this.secrets().find(secret => secret.metadata.id === id); if (!input.secretIds.includes(id) || !secret) throw new Error('Invalid field selection'); this.selectedFields(secret, input); }
    const existing = input.id ? this.allRules().find(rule => rule.id === input.id) : undefined; if (input.id && !existing) throw new Error('Unknown rule');
    const rule: SecretRule = { ...structuredClone(input), id: input.id ?? randomUUID(), revision: (existing?.revision ?? 0) + 1 }; this.data().rules = this.data().rules.filter(item => item.id !== rule.id); this.journal.rules = this.journal.rules.filter(item => item.id !== rule.id); (group.scope === 'task' ? this.journal.rules : this.data().rules).push(rule); return structuredClone(rule);
  }); }
  currentTask(sessionId: string, root?: string, hostId = this.device().id): SecretTarget | undefined {
    const task = [...this.journal.tasks].reverse().find(task => task.sessionId === sessionId && task.hostId === hostId && (root === undefined || task.root === root) && task.status === 'open' && (task.expiresAt === undefined || task.expiresAt > this.now()));
    return task ? { hostId, sessionId, root: task.root, taskId: task.id, projectId: this.projectId(hostId, task.root) } : undefined;
  }
  async bindRun(sessionId: string, root: string, startedAt: string): Promise<SecretTarget> {
    const started = Date.parse(startedAt); if (!Number.isFinite(started)) throw new Error('Invalid run start');
    return this.ensureTask(sessionId, root, undefined, started);
  }

  async ensureTask(sessionId: string, canonicalRoot: string, hostId?: string, runStartedAt?: number): Promise<SecretTarget> { return this.mutate(() => { hostId ??= this.device().id; if (!sessionId || !isAbsolute(canonicalRoot) || normalize(canonicalRoot) !== canonicalRoot) throw new Error('Invalid task identity'); let task = sessionTask(this.journal, sessionId, hostId, canonicalRoot, runStartedAt); if (!task) { if (this.journal.tasks.length >= 10000) throw new Error('Task count limit'); task = { id: randomUUID(), hostId, sessionId, root: canonicalRoot, status: 'open', createdAt: this.now(), excluded: [] }; this.journal.tasks.push(task); } return { hostId, sessionId, root: canonicalRoot, taskId: task.id, projectId: this.projectId(hostId, canonicalRoot) }; }); }
  async ensureRemoteTask(context: SecretContext): Promise<SecretContext> { return this.mutate(() => {
    if (!this.data().peers.some(peer => peer.enabled && peer.device.id === context.hostId) || !this.projectId(context.hostId, context.root) || !isAbsolute(context.root) || normalize(context.root) !== context.root || !/^[a-f0-9-]{36}$/.test(context.taskId) || !context.sessionId) throw new Error('Remote task denied');
    context = { ...context, projectId: this.projectId(context.hostId, context.root) };
    const existing = this.journal.tasks.find(task => task.id === context.taskId);
    if (existing) { this.task(context); return context; }
    this.journal.tasks.push({ id: context.taskId, hostId: context.hostId, sessionId: context.sessionId, root: context.root, status: 'open', createdAt: this.now(), expiresAt: this.now() + 8 * 60 * 60_000, excluded: [] }); return context;
  }); }
  private task(target: SecretTarget): SecretTask { return openTask(this.policy(), target, this.now()); }
  /** Recipient-side task closure and exclusions also apply to remotely owned secrets. */
  checkTask(target: SecretTarget, secretId?: string): void {
    const task = this.task(target);
    if (secretId && task.excluded.includes(secretId)) throw new Error('Secret revoked for task');
  }
  async closeTask(taskId: string) { return this.mutate(() => { const task = this.journal.tasks.find(task => task.id === taskId); if (!task) throw new Error('Unknown task'); this.endTask(task); }); }

  async closeSessions(hashes: string[]): Promise<void> { return this.mutate(() => {
    for (const task of this.journal.tasks) if (task.status === 'open' && hashes.includes(createHash('sha256').update('tower-secret-session-close-v1:' + task.sessionId).digest('hex'))) this.endTask(task);
  }); }
  private endTask(task: SecretTask): void {
    task.status = 'closed'; task.closedAt = this.now();
    this.journal.grants = this.journal.grants.filter(grant => grant.taskId !== task.id);
    const groupIds = this.journal.groups.filter(group => group.taskId === task.id).map(group => group.id);
    this.journal.secrets = this.journal.secrets.filter(secret => !groupIds.includes(secret.metadata.groupId));
    this.journal.groups = this.journal.groups.filter(group => !groupIds.includes(group.id));
    this.journal.rules = this.journal.rules.filter(rule => !groupIds.includes(rule.groupId));
    // Claims stay while a signed close response is being committed; expired replay is rejected by its envelope.
  }
  async sweep(liveRuns: ReadonlySet<string>): Promise<void> { return this.mutate(() => {
    for (const task of this.journal.tasks) if (task.status === 'open' && task.expiresAt !== undefined && task.expiresAt <= this.now()) { this.endTask(task); task.closedAt = task.expiresAt; }
    const expired = this.secrets().filter(secret => secret.metadata.expiresAt !== undefined && secret.metadata.expiresAt <= this.now()).map(secret => secret.metadata.id);
    this.data().secrets = this.data().secrets.filter(secret => !expired.includes(secret.metadata.id));
    this.journal.secrets = this.journal.secrets.filter(secret => !expired.includes(secret.metadata.id));
    this.journal.grants = this.journal.grants.filter(grant => !expired.includes(grant.secretId));
    for (const [id, operation] of Object.entries(this.journal.operations)) {
      const remote = operation.remote === true;
      if (remote ? operation.claimedAt !== undefined && operation.claimedAt + 60_000 < this.now() : !liveRuns.has(operation.runId)) delete this.journal.operations[id];
    }
  }); }
  private matchingRules(task: SecretTask, secret: StoredSecret) { return matchingRules(this.policy(), task, policySecret(secret)); }
  private rules(task: SecretTask, secret: StoredSecret) { return activeRules(this.policy(), task, policySecret(secret), this.now()); }
  private selectedFields(secret: StoredSecret, rule: Pick<SecretRule, 'fields'>): string[] | undefined { return selectedFields(policySecret(secret), rule); }
  private grant(task: SecretTask, secret: PolicySecret, rule: SecretRule, renew = false) { selectedFields(secret, rule); if (task.excluded.includes(secret.metadata.id)) throw new Error('Secret revoked for task'); let grant = this.journal.grants.find(grant => grant.taskId === task.id && grant.secretId === secret.metadata.id && grant.ruleId === rule.id); if (!grant) { grant = { taskId: task.id, secretId: secret.metadata.id, version: secret.metadata.version, ruleId: rule.id, revision: rule.revision, deadline: rule.maxTtlMs === undefined ? undefined : this.now() + rule.maxTtlMs }; this.journal.grants.push(grant); } else if (renew) { grant.version = secret.metadata.version; grant.revision = rule.revision; } return grant; }
  async attach(target: SecretTarget, secretIds: string[]) { return this.mutate(() => { const task = this.task(target); for (const id of secretIds) { const secret = this.secrets().find(secret => secret.metadata.id === id); if (!secret) throw new Error('Unknown secret'); const rules = this.rules(task, secret); if (!rules.length) throw new Error('Matching rule required'); for (const rule of rules) this.grant(task, policySecret(secret), rule, true); } }); }
  /** An explicit owner click may authorize a saved global key for this exact project, never automatically. */
  async connect(target: SecretTarget, secretIds: string[]) { return this.mutate(() => {
    const task = this.task(target);
    for (const id of secretIds) {
      const secret = this.secrets().find(secret => secret.metadata.id === id);
      if (!secret || (secret.metadata.expiresAt !== undefined && secret.metadata.expiresAt <= this.now())) throw new Error('Secret unavailable');
      const group = this.groups().find(group => group.id === secret.metadata.groupId);
      let rules = this.rules(task, secret);
      if (!rules.length) {
        if (this.matchingRules(task, secret).length || group?.scope !== 'global') throw new Error('Update the existing secret policy in settings');
        const rule: SecretRule = { id: randomUUID(), groupId: group.id, secretIds: [id], hostId: task.hostId,
          ...(target.projectId ? { projectId: target.projectId } : { root: target.root }),
          activation: 'manual', operations: [...DEFAULT_SECRET_USE_OPERATIONS], enabled: true, revision: 1,
          ...(target.hostId !== this.device().id ? { maxTtlMs: 8 * 60 * 60_000 } : {}) };
        this.data().rules.push(rule); rules = [rule];
      }
      if (this.journal.grants.some(grant => grant.taskId === task.id && grant.secretId === id && grant.deadline !== undefined && grant.deadline <= this.now())) throw new Error('Secret grant expired for this task');
      task.excluded = task.excluded.filter(excluded => excluded !== id);
      for (const rule of rules) this.grant(task, policySecret(secret), rule, true);
    }
  }); }
  async revoke(target: SecretTarget, secretIds: string[]) { return this.mutate(() => { const task = this.task(target); task.excluded = [...new Set([...task.excluded, ...secretIds])]; this.journal.grants = this.journal.grants.filter(grant => grant.taskId !== task.id || !secretIds.includes(grant.secretId)); }); }
  private authorize(context: SecretContext, secret: StoredSecret, operation: SecretOperation, issueAutomatic = true) { const state = this.policy(); const task = openTask(state, context, this.now()); if (!context.runId) throw new Error('Secret access denied'); return authorize(state, task, policySecret(secret), operation, this.now(), issueAutomatic ? (task, secret, rule) => this.grant(task, secret, rule) : undefined); }
  async list(context: SecretContext): Promise<SecretMetadata[]> { return this.mutate(() => { const state = this.policy(); const task = openTask(state, context, this.now()); return context.runId ? discoverable(state, task, this.now(), (task, secret, rule) => this.grant(task, secret, rule)) : []; }); }
  /** What a run may discover while the vault is locked, read from the plaintext index of the last unlocked save; undefined without one. */
  lockedList(sessionId: string, root: string, runStartedAt: string, bound?: SecretTarget): { secrets: SecretMetadata[]; sources: string[] } | undefined {
    const index = this.vault.index as LockedIndex | undefined; if (!index) return;
    const { policy: state, sources } = index; const now = this.now();
    // An unbound run gets the task binding would give it; a task binding would create has no grants or task-scoped secrets yet.
    const open = bound ? undefined : sessionTask(state, sessionId, state.deviceId, root, Date.parse(runStartedAt));
    const target = bound ?? (open && { hostId: state.deviceId, sessionId, root, taskId: open.id });
    const task = target ? openTask(state, { ...target, projectId: projectId(state, target.hostId, target.root) }, now)
      : { id: '', hostId: state.deviceId, sessionId, root, status: 'open' as const, createdAt: now, excluded: [] };
    return { secrets: discoverable(state, task, now, 'assume'), sources };
  }
  async resolve(context: SecretContext, ref: string, operation: SecretOperation): Promise<ResolvedSecret> { return this.mutate(() => this.resolved(context, ref, operation, true)); }
  /** Validate committed grants and begin use in one turn; never hold policy writes for a consumer's runtime. */
  dispatch<T>(context: SecretContext, uses: readonly SecretDispatchUse[], start: () => T): Promise<{ result: T }> {
    return this.serialize(async () => {
      this.data(); this.checkTask(context);
      const localHost = this.device().id;
      for (const use of uses) {
        if (!use.ref.startsWith(`tower-secret://${localHost}/`)) { this.checkTask(context, use.value.metadata.id); continue; }
        const current = this.resolved(context, use.ref, use.operation, false);
        try { if (!current.bytes.equals(use.value.bytes) || JSON.stringify(current.fields) !== JSON.stringify(use.value.fields)) throw new Error('Secret authority or value changed'); }
        finally { current.bytes.fill(0); }
      }
      // Wrapping the promise releases this queue after spawn, so owner lock/revoke still applies immediately.
      return { result: start() };
    });
  }
  private resolved(context: SecretContext, ref: string, operation: SecretOperation, issueAutomatic: boolean): ResolvedSecret {
    if (operation === 'discover' || !SECRET_OPERATIONS.includes(operation)) throw new Error('Use operation required');
    const match = /^tower-secret:\/\/([^/]+)\/([^@/#]+)@(\d+)(?:#(.+))?$/.exec(ref);
    let candidates: StoredSecret[]; let field: string | undefined;
    if (match) { if (match[1] !== this.vault.vaultId) throw new Error('Wrong vault'); candidates = this.secrets().filter(secret => secret.metadata.id === match[2] && secret.metadata.version === Number(match[3])); field = match[4] ? decodeURIComponent(match[4]) : undefined; }
    else { if (ref.startsWith('tower-secret:')) throw new Error('Invalid reference'); candidates = this.secrets().filter(secret => secret.metadata.name === ref); }
    if (candidates.length !== 1) throw new Error('Unknown or ambiguous secret reference'); const secret = candidates[0]; const rule = this.authorize(context, secret, operation, issueAutomatic); const allowed = this.selectedFields(secret, rule);
    if (field !== undefined) { if (!secret.fields || !Object.hasOwn(secret.fields, field) || !allowed?.includes(field)) throw new Error('Field denied'); return { metadata: this.metadata(secret), bytes: Buffer.from(secret.fields[field]) }; }
    if (secret.fields && !Object.keys(secret.fields).every(key => allowed!.includes(key))) { if (operation !== 'env') throw new Error('Whole dotenv access denied'); return { metadata: this.metadata(secret), bytes: Buffer.alloc(0), fields: Object.fromEntries(allowed!.map(key => [key, secret.fields![key]])) }; }
    return { metadata: this.metadata(secret), bytes: secret.encoding === 'base64' ? decode(secret.value) : Buffer.from(secret.value), fields: secret.fields ? { ...secret.fields } : undefined };
  }
  async beginOperation(context: SecretContext, id: string, fingerprint: string): Promise<{ state: 'pending' | 'done'; fresh: boolean; result?: unknown }> { return this.mutate(() => { this.task(context); if (!context.runId || !/^[A-Za-z0-9._:-]{1,200}$/.test(id) || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid operation'); const existing = this.journal.operations[id]; if (existing) { if (existing.taskId !== context.taskId || existing.runId !== context.runId || existing.fingerprint !== fingerprint) throw new Error('Operation identity conflict'); return { state: existing.state, fresh: false, result: structuredClone(existing.result) }; } if (Object.keys(this.journal.operations).length >= 10000) throw new Error('Operation ledger full'); this.journal.operations[id] = { taskId: context.taskId, runId: context.runId, fingerprint, state: 'pending', remote: context.hostId !== this.device().id, claimedAt: this.now() }; return { state: 'pending', fresh: true }; }); }
  async finishOperation(context: SecretContext, id: string, fingerprint: string, result: unknown) { return this.mutate(() => { const existing = this.journal.operations[id]; if (!existing || existing.taskId !== context.taskId || existing.runId !== context.runId || existing.fingerprint !== fingerprint || existing.state !== 'pending') throw new Error('Operation identity conflict'); if (Buffer.byteLength(JSON.stringify(result)) > 3 * MAX_SECRET_BYTES) throw new Error('Operation result too large'); existing.state = 'done'; existing.result = structuredClone(result); }); }
  async importLegacy(records: Legacy[]) { return this.mutate(() => { for (const record of records) { if (!record.id || typeof record.name !== 'string' || typeof record.origin !== 'string' || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) || typeof record.value !== 'string' || Buffer.byteLength(record.value) > MAX_SECRET_BYTES) throw new Error('Invalid legacy secret'); const existing = this.data().legacy.find(item => item.id === record.id); if (existing && JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Legacy secret conflict'); if (!existing) this.data().legacy.push(structuredClone(record)); } }); }
  legacyList() { return this.data().legacy.map(({ value: _value, ...metadata }) => metadata); }
  legacyGet(id: string) { const record = this.data().legacy.find(record => record.id === id); return record ? structuredClone(record) : undefined; }
  async legacyCreate(input: { name: string; value: string; origin: string }, now = this.now()) { const record = { ...input, id: randomUUID(), createdAt: new Date(now).toISOString() }; await this.importLegacy([record]); return record; }
  async legacyRemove(id: string) { return this.mutate(() => { this.data().legacy = this.data().legacy.filter(record => record.id !== id); }); }
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
        const record = structuredClone(secret); record.metadata.reference = `tower-secret://${this.vault.vaultId}/${record.metadata.id}@${record.metadata.version}`; return record;
      });
      for (const record of records) { const existing = this.secrets().find(item => item.metadata.id === record.metadata.id); if (existing && JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Secret import conflict'); }
      for (const legacy of source.legacy) { const existing = this.data().legacy.find(item => item.id === legacy.id); if (existing && JSON.stringify(existing) !== JSON.stringify(legacy)) throw new Error('Legacy import conflict'); }
      for (const group of importedGroups) {
        if (!this.data().groups.some(item => item.id === group.id)) this.data().groups.push(structuredClone(group));
        if (group.projectId && !this.data().projects.some(item => item.id === group.projectId)) this.data().projects.push({ id: group.projectId, name: source.projects?.find(item => item.id === group.projectId)?.name ?? 'Imported project', bindings: [] });
      }
      for (const record of records) if (!this.secrets().some(item => item.metadata.id === record.metadata.id)) this.data().secrets.push(record);
      for (const legacy of source.legacy) if (!this.data().legacy.some(item => item.id === legacy.id)) this.data().legacy.push(structuredClone(legacy));
    });
  }
  async exportEncryptedVault() { await this.queue; return this.vault.read('vault.json'); }
}
