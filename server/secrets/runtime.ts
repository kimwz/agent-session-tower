import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Run, RunDelegation, Session } from '../../shared/types.js';
import type { SecretAlignment, SecretAvailable, SecretContext, SecretSubjectMode, SecretDevice, SecretDisconnected, SecretMetadata, SecretPeer, SecretSessionError, SecretSessionView, SecretSettingsView, SecretShareNotice, SecretTarget, SecretTowerPassword, SecretUsage, SecretValue, SecretViewError, VaultStatus } from '../../shared/secrets.js';
import { SECRET_OPERATIONS } from '../../shared/secrets.js';
import type { Capability } from '../api/mcp.js';
import type { SessionOrigin } from '../runs/origin.js';
import { callWorkerTools, serveToolBridge } from '../mcp/stdio.js';
import { publicChain, secretSubject, type KnownRun, type SecretStage, type SecretSubject } from './access.js';
import { SecretBroker, remoteListing } from './broker.js';
import { parseSecretCli } from './cli.js';
import { parseDotenv } from './dotenv.js';
import { RemoteSecretBroker, wireMetadata, type RemoteSecretOperation, type RemoteSecretRequest, type RemoteSecretResponse } from './remote.js';
import { ensureMachineKey, readMachineKey } from './machine-key.js';
import { ownerConnection, ownerCreate, ownerInput, ownerSession, ownerSharingChange, secretUsage, VIEW_USAGE } from './owner-input.js';
import { SecretService, viewLocked } from './service.js';
import type { SecretUseReviewer } from './reviewer.js';
import type { SecretBlockNotice } from '../runs/runner-protocol.js';
import { SECRET_LOCKED_LIST, SECRET_LOCKED_UNINDEXED, SECRET_LOCKED_USE, SECRET_NO_VAULT, SECRET_NOT_SHARED_LIST, SECRET_USE_INSTRUCTIONS } from './notices.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import { TowerError, kindOf, type ErrorKind } from '../../shared/errors.js';

const fail = (message: string, kind: ErrorKind = 'invalid') => new TowerError(kind, message);
const ref = z.string().min(1).max(4096);
const runInput = z.object({ operationId: z.string().min(1).max(100), command: z.string().min(1).max(4096), args: z.array(z.string().max(32768)).max(256).optional(), cwd: z.string().max(4096).optional(), timeoutMs: z.number().int().positive().max(600000).optional(), env: z.record(z.string(), ref).optional(), envBundle: ref.optional(), stdin: ref.optional(), files: z.record(z.string(), ref).optional() }).strict();
const schemas = {
  secrets_list: z.object({}).strict(),
  secrets_run: runInput,
  secrets_compare: z.object({ left: ref, right: ref }).strict(),
  secrets_fingerprint: z.object({ reference: ref, domain: z.string().max(80).optional() }).strict(),
  secrets_cli: z.object({ argv: z.array(z.string().max(32768)).max(512), operationId: z.string().max(100).optional() }).strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  secrets_list: `List the secrets this session may use, with references, selected fields and permitted operations: those the owner shares with every folder (GLOBAL) or with this folder, and those connected to this session. Values are never returned. ${SECRET_USE_INSTRUCTIONS}`,
  secrets_run: 'Run a program with permitted secret references as environment variables, stdin or private temporary files. Use {secret-file:NAME} in args for a files mapping. Values never go in args. stdout/stderr are masked before return. Use a unique stable operationId; uncertain requests are not executed again.',
  secrets_compare: 'Compare two permitted secret references inside the broker; returns only equality.',
  secrets_fingerprint: 'Return a domain scoped HMAC fingerprint for a permitted secret reference, without its value.',
  secrets_cli: 'Use the Tower secrets CLI argv interface through this authenticated run: list; run --operation-id ID --env NAME=REF --env-bundle REF --file NAME=REF -- PROGRAM ARGS; pipe --operation-id ID --secret REF -- PROGRAM ARGS; compare LEFT RIGHT; fingerprint REF. Reuse the same ID only to check the same request result. No raw read/export command exists.',
};
export const SECRET_TOOLS = Object.entries(schemas).map(([name, input]) => {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(input, { io: 'input' });
  return { name, description: descriptions[name as keyof typeof schemas], inputSchema };
});
const SESSION_ERRORS = ['uninitialized', 'locked', 'not-eligible', 'session-closed', 'source-unavailable', 'worker-update-pending'] as const satisfies readonly SecretSessionError[];
/** Errors that stay until the owner does something; the page stops polling on them. */
const PERMANENT: ReadonlySet<SecretSessionError> = new Set(['uninitialized', 'not-eligible', 'session-closed']);
const MUTATIONS = new Set(['create', 'remove', 'sharing', 'session-connect', 'session-disconnect', 'session-reallow', 'trust', 'untrust']);
/** The web's value-viewing inputs: it verified `password` as the Tower password of the login credentials `credentialId` names. */
const credentialId = z.string().regex(/^[a-f0-9]{64}$/);
const vaultPassword = z.string().min(1).max(1024);
const towerCredential = z.object({ credentialId }).strict();
const towerWrapInput = z.object({ password: vaultPassword, credentialId }).strict();
const viewUnlockInput = z.object({ password: vaultPassword, credentialId, recoveryPassword: vaultPassword.optional() }).strict();
/** `generation`: the lock generation `view-unlock` answered; a value is read or changed only within it. */
const valueRead = z.object({ secretId: z.string().min(1).max(256), expectedVersion: z.number().int().positive(), generation: z.string().min(1).max(64) }).strict();
const valueWrite = valueRead.extend({ value: z.string().optional(), content: z.string().optional() }).strict();
/** A value-viewing refusal the web answers with its own `code`. */
const viewFail = (code: SecretViewError, kind: ErrorKind, message: string) => Object.assign(new TowerError(kind, message), { code });
/** How long a session view waits for a source's answer before listing it as unavailable. */
const VIEW_REMOTE_MS = 5000;
/** How long a refused use stays in the worker's report for the owner's notice; the web announces each once. */
const BLOCK_NOTICE_MS = 60 * 60_000;
const taskId = z.string().regex(/^[a-f0-9-]{36}$/);
/** A joined computer's session as its web verified it: the task an owner change applies to. */
const remoteTarget = z.object({ hostId: z.string().min(1).max(256), sessionId: z.string().min(1).max(512), root: z.string().min(1).max(8192), taskId, projectId: z.string().optional() });
const remoteSubject = z.union([z.object({ error: z.enum(SESSION_ERRORS) }).strict(),
  z.object({ hostId: z.string().min(1).max(256), sessionId: z.string().min(1).max(512), root: z.string().min(1).max(8192), taskId: taskId.optional(), usage: z.array(secretUsage).max(VIEW_USAGE),
    excluded: z.array(z.string().min(1).max(256)).max(4096).optional() }).strict()]);
/**
 * A joined computer's session as that computer reports it for its controller's owner view: canonical folder, open task,
 * the keys that task stops (`excluded`, absent before 1.132) and recent uses, or why it has none. Reading it starts
 * nothing on either computer.
 */
export type RemoteSessionSubject = z.output<typeof remoteSubject>;
/** A committed owner change for a joined computer's session, which its web announces there before reading the view. */
export interface SecretReceipt { connectedTarget: SecretTarget }
export type SecretControlResult = SecretSettingsView | SecretSessionView | SecretReceipt | SecretValue | { fields: string[] } | { generation: string } | { towerPassword: SecretTowerPassword } | { wrapped: boolean } | Record<string, never>;
/** A computer's public vault device, as the owner pastes it or its link hands it over: real Ed25519/X25519 keys and their fingerprint. */
const deviceInput = z.object({ id: z.string().uuid(), name: z.string().max(256), signingKey: z.string().max(4096), encryptionKey: z.string().max(4096), fingerprint: z.string() });
function peerDevice(value: unknown): SecretDevice {
  const device = deviceInput.parse(value);
  if (createPublicKey(device.signingKey).asymmetricKeyType !== 'ed25519' || createPublicKey(device.encryptionKey).asymmetricKeyType !== 'x25519' || device.fingerprint !== createHash('sha256').update(device.signingKey + ':' + device.encryptionKey).digest('hex')) throw fail('컴퓨터의 공개 키와 지문을 확인하세요.');
  return device;
}
/** One trust alignment request: this computer's side towards a link route, with the other side's device when known. */
const alignInput = z.object({ routeId: z.string().min(1).max(256), direction: z.enum(['node', 'controller']), device: z.unknown().optional() }).strict();
/** How often the owner hears that one computer asked for one secret not shared with it. */
const SHARE_NOTICE_MS = 10 * 60_000;
const closedView = (status: VaultStatus, error: SecretSessionError): SecretSessionView => ({ status, available: [], connectable: [], usage: [], unavailableSources: [], updatePendingSources: [], error, permanent: PERMANENT.has(error) });
const closureId = (sessionId: string) => createHash('sha256').update('tower-secret-session-close-v1:' + sessionId).digest('hex');
interface Runs { list(): Run[]; getSession(id: string): Session | undefined; sessionOrigin(id: string): SessionOrigin | undefined }

/** Owns the security task independently of conversation summaries and binds it once per run. */
export class SecretRuntime {
  readonly remote: RemoteSecretBroker;
  readonly broker: SecretBroker;
  private blocked = false;
  private paused = false;
  private housekeeping = 0;
  private closures: Promise<unknown> = Promise.resolve();
  private readonly closedSessions = new Set<string>();
  private readonly runTasks = new Map<string, SecretTarget>();
  /** The controller route this computer follows, as last read (`following`). */
  private followedRoute: string | undefined;
  /** The owner locked the vault: following a host does not open it again by itself until it opens some other way. */
  private ownerLocked = false;
  private machineQueue: Promise<unknown> = Promise.resolve();
  /** Pushes for the owner about computers that follow this host (`shares`), with when each secret and computer was last told. */
  private readonly shareNotices: SecretShareNotice[] = [];
  private readonly shareTold = new Map<string, number>();
  constructor(private readonly options: {
    stateDir: string; service: SecretService; runs: Runs;
    migrate?: () => Promise<void>; pendingImports?: () => Promise<string[]>;
    importPending?: (id: string, password: string) => Promise<void>;
    remoteAllowed?: (context: SecretContext) => boolean;
    isClosed?: (id: string) => Promise<boolean>;
    /** Explicit chat assignment only; owner input and secret material never reach the callback. */
    onConnect?: (sessionId: string) => void;
    /** Reviews each use of a session the owner did not open before its values are resolved. */
    reviewer?: Pick<SecretUseReviewer, 'review' | 'inFlight'>;
    /** The worker's effects gate; reviewed uses check it after their review and before their consumer starts. */
    effects?: () => Promise<void>;
    /** Its synchronous part (no hold now), checked inside the turn that starts a reviewed use's consumer. */
    effectsReady?: () => boolean;
    /**
     * The controller route this computer follows ("호스트 설정 따르기"), read again before each decision. Only then does
     * its vault open by itself (machine-key.ts), its trust align with that host, and its agents see that host's catalog.
     */
    followed?: () => Promise<string | undefined>;
  }) {
    const service = options.service;
    const accepted = new Map<string, SecretContext>();
    const normalized = (context: SecretContext) => {
      if (this.blocked) throw fail('보관함 잠금 해제를 완료하지 못했습니다.', 'unavailable');
      if (options.remoteAllowed && !options.remoteAllowed(context)) throw fail('원격 작업을 허용하지 않습니다.', 'forbidden');
      return service.ensureRemoteTask(context);
    };
    this.remote = new RemoteSecretBroker({ device: () => service.device(), deviceKeys: () => service.deviceKeys(), peers: () => service.status().locked ? [] : service.peers(),
      followed: () => this.followedRoute, refused: (context, request) => this.shareRequested(context, request),
      begin: async (context, id, digest) => { const trusted = await normalized(context); const claim = await service.beginOperation(trusted, id, digest); if (claim.fresh && id.startsWith('remote-id:')) accepted.set(id, trusted); return claim.fresh; },
      // Remote replay is refused even after completion; retain only its proof, not an unused response cache.
      finish: async (_context, id, digest, _answer) => { const trusted = accepted.get(id); if (!trusted) throw fail('원격 요청 기록을 확인할 수 없습니다.'); try { await service.finishOperation(trusted, id, digest, { answered: true }); } finally { accepted.delete(id); } },
      handle: async (context, request) => {
        // A read of what this vault allows the peer's session, or of every name it has: no task here, no claim, nothing kept.
        if (request.operation === 'available' || request.operation === 'catalog') {
          if (this.blocked) throw fail('보관함 잠금 해제를 완료하지 못했습니다.', 'unavailable');
          if (options.remoteAllowed && !options.remoteAllowed(context)) throw fail('원격 작업을 허용하지 않습니다.', 'forbidden');
          return request.operation === 'catalog' ? service.catalogFor(context) : service.availableFor(context).map(wireMetadata);
        }
        const trusted = await normalized(context);
        if (request.operation === 'list') return service.list(trusted);
        if (request.operation === 'close') { await service.closeTask(trusted.taskId); return { closed: true }; }
        const payload = z.object({ reference: ref, operation: z.enum(SECRET_OPERATIONS).exclude(['discover']), reasons: z.literal(true).optional() }).strict().parse(request.payload);
        return service.resolve(trusted, payload.reference, payload.operation);
      },
    });
    this.broker = new SecretBroker({ stateDir: options.stateDir, service, remote: this.remote, validate: context => this.validateBrokerContext(context), ...(options.reviewer ? { reviewer: options.reviewer } : {}), ...(options.effects ? { effects: options.effects } : {}), ...(options.effectsReady ? { effectsReady: options.effectsReady } : {}) });
  }
  initialized(): boolean { return this.options.service.status().initialized; }
  /** The vault's state, read cheaply (the relay asks every second while a following computer waits on it). */
  status(): VaultStatus { return { ...this.options.service.status(), ...(this.blocked ? { locked: true } : {}) }; }
  /** A review runs inside a broker call; it is counted on its own too, so a handoff waits for it (at most its deadline). */
  inFlight(): boolean { return this.housekeeping > 0 || this.broker.inFlight() || this.options.reviewer?.inFlight() === true || this.remote.inFlight() > 0 || this.remote.pending() > 0; }
  /** Every use refused in the last hour, from the session usage records; the web tells the owner of each once. Empty while locked. */
  blocks(): SecretBlockNotice[] {
    if (this.blocked) return [];
    return this.options.service.blocks(Date.now() - BLOCK_NOTICE_MS).map(block => ({ key: `secret-block:${block.operationId}:${block.at}`, sessionId: block.sessionId, at: block.at, reason: block.reason, secrets: block.secrets }));
  }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  async sweep(): Promise<void> {
    if (this.paused || this.blocked || this.housekeeping || this.options.service.status().locked) return;
    this.housekeeping++;
    try {
      await this.options.service.sweep(new Set(this.options.runs.list().filter(run => run.status === 'running' || run.status === 'queued').map(run => run.id)));
    }
    finally { this.housekeeping--; }
  }
  async flush(): Promise<void> { if (!this.options.service.status().locked) await this.options.service.flush(); }
  close(): void { this.remote.close(); }

  notifyConnection(target: SecretTarget): void {
    // Remote targets are notified on their own worker, never a same-named local session.
    if (target.hostId !== this.options.service.device().id) return;
    try { this.options.onConnect?.(target.sessionId); }
    catch { console.warn('Tower could not queue a private secret-connection notice; credentials remain discoverable when needed.'); }
  }

  /** The sessions and turns this computer knows now, for access.ts. */
  private known() {
    const runs = this.options.runs;
    let known: Map<string, Run> | undefined;
    return { lookup: (id: string) => { const found = runs.getSession(id); return found && { session: found, provenance: runs.sessionOrigin(id) }; },
      findRun: (id: string) => (known ??= new Map(runs.list().map(item => [item.id, item]))).get(id) };
  }
  /** Who a session of this computer is for secret use now (see access.ts), with `run` the turn asking, if any. */
  subject(session: Session, run: KnownRun | undefined, stage: SecretStage): SecretSubject {
    if (this.closedSessions.has(session.id)) return { mode: 'none', reason: 'closed' };
    return secretSubject({ run, session, provenance: this.options.runs.sessionOrigin(session.id), stage, ...this.known() });
  }
  /** What a delegated turn keeps when it is admitted, while its calling turns are still known (access.ts `publicChain`). */
  publicChain(delegation: RunDelegation): boolean | undefined { return publicChain(delegation, this.known()); }
  /** A live session of this computer that may use secrets at `stage`, in its canonical folder; `run` is the turn asking, if any. */
  private async session(id: string, run: KnownRun | undefined, stage: SecretStage): Promise<Session & { cwd: string; subject: SecretSubjectMode }> {
    const session = this.options.runs.getSession(id);
    if (!session || session.closed || await this.options.isClosed?.(session.id) || (await this.readClosures()).includes(closureId(session.id))) throw fail('이 프로젝트 세션은 종료되었습니다.', 'forbidden');
    const cwd = await realpath(session.cwd);
    const subject = this.subject(session, run, stage);
    if (subject.mode === 'none') throw fail('이 세션에서는 시크릿을 사용할 수 없습니다.', 'forbidden');
    return { ...session, cwd, subject: subject.mode };
  }
  /** Checked again at once before each use and consumer start: the turn still runs and its session may still use secrets. */
  private validateBrokerContext(context: SecretContext): void {
    if (this.blocked) throw fail('보관함 잠금 해제를 완료하지 못했습니다.', 'unavailable');
    const run = this.options.runs.list().find(item => item.id === context.runId);
    const session = run && this.options.runs.getSession(run.sessionId);
    if (!run || !session || run.sessionId !== context.sessionId || run.status !== 'running' || this.subject(session, run, 'use').mode === 'none') throw fail('이 시크릿 도구는 발급받은 실행 중에만 사용할 수 있습니다.', 'forbidden');
  }
  async target(sessionId: string): Promise<SecretTarget> { const session = await this.session(sessionId, undefined, 'issue'); return this.options.service.ensureTask(session.id, session.cwd); }
  async peekTarget(sessionId: string): Promise<SecretTarget | undefined> { const session = await this.session(sessionId, undefined, 'issue'); return this.options.service.currentTask(session.id, session.cwd); }
  async remoteTarget(sessionId: string, create = true): Promise<SecretTarget | undefined> { return create ? this.target(sessionId) : this.peekTarget(sessionId); }
  /**
   * The running turn a credential was issued for, and its session as it may use secrets now (see access.ts); decided again
   * on every call, whoever started the turn and whatever other tools it has. A credential never serves another run.
   */
  private async runSubject(capability: Extract<Capability, { kind: 'secret-run' }>, stage: SecretStage = 'use'): Promise<{ run: Run; session: Session & { cwd: string; subject: SecretSubjectMode } }> {
    if (this.blocked) throw fail('보관함 잠금 해제를 완료하지 못했습니다.', 'unavailable');
    const run = this.options.runs.list().find(item => item.id === capability.runId);
    if (!run || run.sessionId !== capability.sessionId || run.status !== 'running') throw fail('이 시크릿 도구는 발급받은 실행 중에만 사용할 수 있습니다.', 'forbidden');
    return { run, session: await this.session(run.sessionId, run, stage) };
  }
  /** The gate for every request: the tools are listed even before a new session's creation is confirmed; using them waits for it. */
  async authorizeCapability(capability: Extract<Capability, { kind: 'secret-run' }>): Promise<void> { await this.runSubject(capability, 'discover'); }
  async context(capability: Extract<Capability, { kind: 'secret-run' }>): Promise<SecretContext> {
    const { run, session } = await this.runSubject(capability);
    let target = this.runTasks.get(run.id);
    if (!target) { target = await this.options.service.bindRun(session.id, session.cwd, run.startedAt ?? run.createdAt); this.runTasks.set(run.id, target); }
    if (target.root !== session.cwd) throw fail('실행의 프로젝트 경로가 변경되었습니다.', 'forbidden');
    const current = this.options.service.currentTask(session.id, session.cwd, target.hostId);
    // Project registration can change during a run, but its original task identity must never change.
    if (current?.taskId === target.taskId) { target = { ...target, projectId: current.projectId }; this.runTasks.set(run.id, target); }
    // list/resolve revalidate the task; a closed task is never replaced for this run.
    return { ...target, runId: run.id, subject: session.subject };
  }
  async tool(capability: Extract<Capability, { kind: 'secret-run' }>, name: string, args: Record<string, unknown>): Promise<unknown> {
    const input = schemas[name as keyof typeof schemas];
    if (!input) throw fail('알 수 없는 시크릿 도구입니다.', 'not-found');
    if (!input.safeParse(args).success) throw fail('시크릿 도구 입력이 올바르지 않습니다.');
    if (this.options.service.status().locked) return this.lockedTool(capability, name, args);
    try { return await this.unlockedTool(capability, name, args); }
    catch (error) {
      // Locked by the owner or a failed save during this call: answer as the locked path would.
      if (this.options.service.status().locked && kindOf(error) === undefined) return this.lockedTool(capability, name, args);
      throw error;
    }
  }
  private async unlockedTool(capability: Extract<Capability, { kind: 'secret-run' }>, name: string, args: Record<string, unknown>): Promise<unknown> {
    const context = await this.context(capability);
    if (name === 'secrets_list') {
      const secrets = await this.broker.list(context); const followed = await this.following();
      // The host this computer follows also names what it has not shared here, so asking for one reaches its owner.
      const notShared = followed ? await this.broker.notShared(context, followed, secrets) : [];
      return { secrets: [...secrets, ...notShared], unavailableSources: this.broker.unavailableSources(context), ...(notShared.length ? { notice: SECRET_NOT_SHARED_LIST } : {}), usage: descriptions.secrets_cli };
    }
    if (name === 'secrets_run') return this.broker.run(context, runInput.parse(args));
    if (name === 'secrets_compare') { const parsed = schemas.secrets_compare.parse(args); return this.broker.compare(context, parsed.left, parsed.right); }
    if (name === 'secrets_fingerprint') { const parsed = schemas.secrets_fingerprint.parse(args); return this.broker.fingerprint(context, parsed.reference, parsed.domain); }
    const parsed = schemas.secrets_cli.parse(args);
    const argv = [...parsed.argv];
    if (parsed.operationId && ['run','pipe'].includes(argv[0])) {
      const existing = argv.indexOf('--operation-id');
      if (existing >= 0 && argv[existing + 1] !== parsed.operationId) throw fail('operationId가 일치하지 않습니다.');
      if (existing < 0) argv.splice(1, 0, '--operation-id', parsed.operationId);
    }
    const cli = parseSecretCli(argv);
    if (cli.kind === 'list') return this.tool(capability, 'secrets_list', {});
    if (cli.kind === 'run') return this.broker.run(context, { ...cli.input, ...(parsed.operationId ? { operationId: parsed.operationId } : {}) });
    if (cli.kind === 'compare') return this.broker.compare(context, cli.left, cli.right);
    return this.broker.fingerprint(context, cli.reference, cli.domain);
  }
  /** Names stay listable while locked; using one asks the agent to get the owner's unlock. */
  private async lockedTool(capability: Extract<Capability, { kind: 'secret-run' }>, name: string, args: Record<string, unknown>): Promise<unknown> {
    const { run, session } = await this.runSubject(capability);
    const argv = name === 'secrets_cli' ? schemas.secrets_cli.parse(args).argv : [];
    const listing = name === 'secrets_list' || (argv[0] === 'list' && parseSecretCli(argv).kind === 'list');
    if (!this.options.service.status().initialized) { if (listing) return { secrets: [], unavailableSources: [], usage: descriptions.secrets_cli }; throw fail(SECRET_NO_VAULT, 'not-found'); }
    if (!listing) throw fail(SECRET_LOCKED_USE, 'locked');
    // Archived while locked: the unlock closes this session's tasks, so their grants are not listed meanwhile.
    if ((await this.readClosures()).includes(closureId(session.id))) throw fail('이 세션의 시크릿 작업은 종료되었습니다.', 'forbidden');
    const bound = this.runTasks.get(run.id);
    if (bound && bound.root !== session.cwd) throw fail('실행의 프로젝트 경로가 변경되었습니다.', 'forbidden');
    const listed = this.options.service.lockedList(session.id, session.cwd, run.startedAt ?? run.createdAt, bound);
    if (!listed) return { locked: true, notice: SECRET_LOCKED_UNINDEXED, secrets: [], unavailableSources: [], usage: descriptions.secrets_cli };
    return { locked: true, notice: SECRET_LOCKED_LIST, secrets: listed.secrets, unavailableSources: listed.sources.map(sourceHostId => ({ sourceHostId, code: 'SECRET_SOURCE_UNAVAILABLE' })), usage: descriptions.secrets_cli };
  }
  /** The open vault for the successor worker, unless an unlock is still being completed. */
  handoff(): Buffer | undefined { return this.blocked ? undefined : this.options.service.handoff(); }
  /** Opens the vault with the previous worker's handoff, completing it as a password unlock would. */
  async adopt(carry: Buffer): Promise<void> { await this.open(() => this.options.service.adopt(carry)); }
  private async open(unlock: () => Promise<void>): Promise<void> {
    this.blocked = true; let opened: string | undefined;
    try { await unlock(); opened = this.options.service.lockGeneration; await this.options.migrate?.(); await this.applyClosures(); this.blocked = false; }
    catch (error) { await this.options.service.lock(); this.blocked = false; throw error; }
    // An owner lock that came after this open is kept (it moved the generation on).
    if (opened === this.options.service.lockGeneration) this.ownerLocked = false;
    // However it opened, the vault of a computer that follows a host opens by itself from now on.
    if (await this.following()) await this.wrapMachine().catch(() => console.warn('Tower could not let this computer\'s vault open by itself; it opens with its password until the next try.'));
  }
  /** The controller route this computer follows now, read again. */
  private async following(): Promise<string | undefined> { this.followedRoute = await this.options.followed?.(); return this.followedRoute; }
  private async wrapMachine(): Promise<void> {
    const service = this.options.service; const key = await ensureMachineKey(this.options.stateDir);
    try { if (!service.vault.hasMachine(key)) await service.machineWrap(key); } finally { key.fill(0); }
  }
  /**
   * While this computer follows a host, its vault is made with the machine key when it has none, and opened with it when
   * locked, unless the owner locked it; an open one gets the machine wrapper. `needs-open`: a vault the machine key does
   * not open yet (a password vault never opened since), which the owner opens once. One at a time.
   */
  machineVault(): Promise<SecretAlignment['vault'] | 'off'> {
    const next = this.machineQueue.then(() => this.openByMachine());
    // best-effort: the queue only orders the next call; this call's caller gets its own error
    this.machineQueue = next.catch(() => undefined);
    return next;
  }
  private async openByMachine(): Promise<SecretAlignment['vault'] | 'off'> {
    const service = this.options.service;
    if (!await this.following()) return 'off';
    if (this.blocked) return 'locked';
    if (!service.status().initialized) {
      const key = await ensureMachineKey(this.options.stateDir);
      try { await this.open(() => service.initialize('', key)); }
      catch (error) { if (!service.status().initialized) throw error; } // Made meanwhile by the owner: opened or not as below.
      finally { key.fill(0); }
    }
    if (service.status().locked) {
      if (this.ownerLocked) return 'needs-open';
      // Decided now: an owner lock from here on is queued before the open and wins.
      const generation = service.lockGeneration;
      const key = await readMachineKey(this.options.stateDir);
      try {
        if (!key || !service.vault.hasMachine(key)) return 'needs-open';
        await this.open(() => service.machineUnlock(key, generation));
      } catch { return 'needs-open'; } // best-effort: a machine key that does not open it waits for the owner's one open
      finally { key?.fill(0); }
      return 'open';
    }
    await this.wrapMachine();
    return 'open';
  }
  /**
   * This computer's side of the trust between a host and a computer that follows it, over their pinned link (see
   * `SecretService.alignPeer`): with the other side's device it trusts that side, unless the owner removed that trust.
   * A computer answers only the host it follows, after opening its vault as `machineVault` does.
   */
  async align(value: unknown): Promise<SecretAlignment> {
    const input = ownerInput(alignInput, value, '시크릿 신뢰 맞추기 요청이 올바르지 않습니다.'); const service = this.options.service;
    if (input.direction === 'controller') {
      if (await this.following() !== input.routeId) throw fail('이 컴퓨터는 그 Tower의 설정을 따르지 않습니다.', 'forbidden');
      await this.machineVault().catch(() => console.warn('Tower could not open this computer\'s vault by itself; the owner can open it once.'));
    }
    const status = service.status();
    if (!status.initialized) return { vault: 'missing', trusted: false };
    if (status.locked || this.blocked) return { vault: input.direction === 'controller' ? 'needs-open' : 'locked', trusted: false };
    const route = { routeId: input.routeId, direction: input.direction };
    if (service.untrustedRoute(route)) return { vault: 'open', device: service.device(), trusted: false, untrusted: true };
    // Opening the vault took a while: the host is trusted only while this computer still follows it.
    if (input.direction === 'controller' && input.device !== undefined && await this.following() !== input.routeId) throw fail('이 컴퓨터는 그 Tower의 설정을 따르지 않습니다.', 'forbidden');
    const trusted = input.device === undefined ? service.peers().some(peer => peer.enabled && peer.routeId === route.routeId && peer.direction === route.direction)
      : await service.alignPeer({ device: peerDevice(input.device), ...route, enabled: true });
    const peer = trusted && input.direction === 'node' ? service.peers().find(item => item.enabled && item.routeId === route.routeId && item.direction === 'node') : undefined;
    return { vault: 'open', device: service.device(), trusted, ...(peer ? { available: service.machineShared(peer.device.id) } : {}) };
  }
  /**
   * A computer that follows this host asked for a secret not shared with it: the owner hears of it once per secret and
   * computer every ten minutes, from the web's notifications (`shares`).
   */
  private shareRequested(context: SecretContext, request: { operation: RemoteSecretOperation; payload: unknown }): void {
    if (request.operation !== 'resolve') return;
    const service = this.options.service; const reference = (request.payload as { reference?: unknown } | undefined)?.reference;
    if (typeof reference !== 'string' || service.status().locked) return;
    const match = /^tower-secret:\/\/([^/]+)\/([^@/#]+)@\d+(?:#.+)?$/.exec(reference);
    const secret = service.settings().secrets.find(item => match ? match[1] === service.device().id && item.id === match[2] : item.name === reference);
    const peer = service.peers().find(item => item.enabled && item.direction === 'node' && item.device.id === context.hostId);
    if (!secret || !peer) return;
    const now = Date.now(); const told = `${secret.id}:${context.hostId}`;
    if (now - (this.shareTold.get(told) ?? 0) < SHARE_NOTICE_MS) return;
    this.shareTold.set(told, now);
    this.shareNotices.push({ key: `secret-share:${told}:${now}`, at: now, kind: 'not-shared', nodeId: peer.routeId, hostId: context.hostId, secretId: secret.id, secretName: secret.name });
    this.shareNotices.splice(0, Math.max(0, this.shareNotices.length - 200));
  }
  /** Share requests of the last hour, for the web's owner notifications; each is announced once. */
  shares(): SecretShareNotice[] { const since = Date.now() - BLOCK_NOTICE_MS; return this.shareNotices.filter(notice => notice.at >= since).map(notice => ({ ...notice })); }
  /** This vault's folders in saved secrets' sharing, for clones of the same repositories on computers that follow it. */
  sharedFolders(): { deviceId: string; folders: { secretId: string; root: string; revision: number }[] } {
    if (this.blocked) throw fail('보관함 잠금 해제를 완료하지 못했습니다.', 'unavailable');
    return { deviceId: this.options.service.device().id, folders: this.options.service.sharedFolders() };
  }
  /** Adds those clones' folders (see `SecretService.autoShareFolders`). */
  async autoShare(value: unknown): Promise<{ added: number }> {
    if (this.blocked) throw fail('보관함 잠금 해제를 완료하지 못했습니다.', 'unavailable');
    const input = ownerInput(z.object({ hostId: z.string().min(1).max(256), folders: z.array(z.object({ secretId: z.string().min(1).max(256), root: z.string().min(1).max(4096), revision: z.number().int().min(0), hostRoot: z.string().min(1).max(4096) }).strict()).max(2000) }).strict(), value);
    return { added: await this.options.service.autoShareFolders(input.hostId, input.folders) };
  }
  async endSession(sessionId: string): Promise<void> {
    const id = this.options.runs.getSession(sessionId)?.id;
    if (id) this.closedSessions.add(id);
    if (!id) throw fail('종료할 세션을 찾을 수 없습니다.', 'not-found');
    if (!this.options.service.status().initialized) return;
    await this.recordClosure(id);
    if (!this.options.service.status().locked) {
      // Archival only removes existing authority; it does not require eligibility for a new secret connection.
      const target = this.options.service.currentTask(id);
      if (target) await this.endTask(target);
      await this.applyClosures();
    }
  }
  /** Called only after the official session store committed a reopen; retired authority never returns. */
  async reopenSession(sessionId: string): Promise<void> {
    const session = this.options.runs.getSession(sessionId);
    if (!session || session.closed || await this.options.isClosed?.(sessionId)) throw fail('공식 재열기를 완료한 세션이 필요합니다.', 'forbidden');
    await this.closures;
    const pending = (await this.readClosures()).includes(closureId(sessionId));
    if (!this.closedSessions.has(sessionId) && !pending) return;
    if (this.options.service.status().initialized) {
      // Also repairs a close intent whose previous write failed; locked reopen waits for unlock's cleanup.
      await this.recordClosure(sessionId);
      if (!this.options.service.status().locked) {
        const target = this.options.service.currentTask(sessionId);
        if (target) await this.endTask(target);
        await this.applyClosures();
      }
    }
    const current = this.options.runs.getSession(sessionId);
    if (!current || current.closed || await this.options.isClosed?.(sessionId)) throw fail('세션이 다시 종료되었습니다.', 'forbidden');
    this.closedSessions.delete(sessionId);
  }
  private closurePath(): string { return join(this.options.stateDir, 'secret-close-intents.json'); }
  private async readClosures(): Promise<string[]> {
    try { return z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10000).parse(await readPrivateJson(this.closurePath(), 800000)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw fail('작업 종료 기록을 확인할 수 없습니다.', 'unavailable'); }
  }
  private async recordClosure(sessionId: string): Promise<void> {
    const next = this.closures.then(async () => {
      const ids = await this.readClosures();
      const id = closureId(sessionId);
      const unique = [...new Set([...ids, id])];
      if (unique.length > 10000) throw fail('보관함을 잠금 해제하여 작업 종료 기록을 정리하세요.', 'unavailable');
      await writePrivateJson(this.closurePath(), JSON.stringify(unique));
    });
    this.closures = next.catch(() => undefined); await next;
  }
  private async applyClosures(): Promise<void> {
    const next = this.closures.then(async () => {
      const ids = await this.readClosures();
      if (!ids.length) return;
      await this.options.service.closeSessions(ids);
      await unlink(this.closurePath());
    });
    this.closures = next.catch(() => undefined); await next;
  }
  private async endTask(target: SecretTarget): Promise<void> {
    const service = this.options.service;
    if (target.hostId === service.device().id) {
      const context = { ...target, runId: 'owner-close' };
      const peers = service.peers().filter(peer => peer.enabled && peer.direction === 'controller');
      // A disconnected source expires its grants; failure is visible to the owner.
      await service.closeTask(target.taskId);
      const results = await Promise.allSettled(peers.map(peer => this.remote.request(peer.device.id, context, 'close', {})));
      if (results.some(result => result.status === 'rejected')) throw fail('로컬 작업은 종료했습니다. 연결할 수 없는 원본 컴퓨터의 정리는 권한 만료 후 완료됩니다.', 'unavailable');
    } else { await service.closeTask(target.taskId); }
  }
  private async settingsView(): Promise<SecretSettingsView> {
    const view = this.options.service.settings();
    const ids = await this.options.pendingImports?.() ?? [];
    return { ...view, status: { ...view.status, pendingImports: ids.length, pendingImportIds: ids } };
  }
  /** Every saved secret the owner may connect to a session, shared or not; no values. */
  private connectable(): SecretMetadata[] { return this.options.service.settings().secrets.map(({ sharing: _sharing, legacy: _legacy, withheld: _withheld, ...metadata }) => metadata); }
  private recentUsage(sessionId: string): SecretUsage[] { return this.options.service.usage({ sessionId }).reverse().slice(0, VIEW_USAGE); }
  /**
   * The owner session a view reads, with its open task in its current folder and how a turn the owner starts there uses
   * secrets; reads only, and says why there is none.
   */
  private async viewSession(sessionId: string): Promise<{ session: Session & { cwd: string; subject: SecretSubjectMode }; task?: SecretTarget } | { error: SecretSessionError }> {
    const found = this.options.runs.getSession(sessionId);
    if (!found || found.closed || this.closedSessions.has(found.id) || await this.options.isClosed?.(found.id) || (await this.readClosures()).includes(closureId(found.id))) return { error: 'session-closed' };
    let session: Session & { cwd: string; subject: SecretSubjectMode };
    try { session = await this.session(found.id, { origin: { kind: 'owner' }, sessionId: found.id }, 'issue'); }
    catch (error) { if (kindOf(error) === 'forbidden' || (error as NodeJS.ErrnoException).code === 'ENOENT') return { error: 'not-eligible' }; throw error; }
    const open = this.options.service.currentTask(session.id);
    return { session, ...(open?.root === session.cwd ? { task: open } : {}) };
  }
  /**
   * What a session of this computer may use now: this vault's secrets and those of each source that confirmed it answers
   * reads. A source that polls without confirming reads is listed as waiting for its update, one that does not answer as
   * unavailable. Keys the session stopped that only a re-allow can bring back are `disconnected`. Neither this vault nor
   * a source starts a task for it.
   */
  private async sessionView(sessionId: string): Promise<SecretSessionView> {
    const service = this.options.service; const status = service.status();
    if (!status.initialized) return closedView(status, 'uninitialized');
    if (status.locked || this.blocked) return closedView(status, 'locked');
    try {
      const subject = await this.viewSession(sessionId);
      if ('error' in subject) return closedView(status, subject.error);
      const { session, task } = subject;
      // Without an open task here, a task ID nobody holds reads what a new task would get, here and at each source.
      const probe = { sessionId: session.id, root: session.cwd, taskId: task?.taskId ?? randomUUID() };
      const local = service.available(probe);
      const remote = await this.remoteAvailable(probe, task);
      const disconnected = [...(task ? service.disconnectedTemporary(task.taskId, service.exclusions(task.taskId)) : []), ...remote.disconnected];
      return { status, available: [...local, ...remote.available], connectable: this.connectable(), usage: this.recentUsage(session.id), unavailableSources: remote.unavailable, updatePendingSources: remote.updatePending, disconnected, subject: session.subject };
    } catch (error) { if (service.status().locked) return closedView(service.status(), 'locked'); throw error; }
  }
  /**
   * Each source's secrets for this session, read only from a source whose relay confirmed reads. A source whose relay
   * polled lately without confirming them runs an older build (`updatePending`); any other one did not answer (`unavailable`).
   */
  private async remoteAvailable(probe: { sessionId: string; root: string; taskId: string }, task?: SecretTarget): Promise<{ available: SecretAvailable[]; unavailable: string[]; updatePending: string[]; disconnected: SecretDisconnected[] }> {
    const service = this.options.service; const context: SecretContext = { hostId: service.device().id, ...probe, runId: 'owner-view' };
    const unavailable: string[] = [], updatePending: string[] = [], disconnected: SecretDisconnected[] = [];
    const excluded = task ? service.exclusions(task.taskId) : [];
    const sources = service.peers().filter(peer => peer.enabled && peer.direction === 'controller');
    const lists = await Promise.all(sources.map(async peer => {
      if (this.remote.declines(peer.device.id, 'available')) { updatePending.push(peer.device.id); return []; }
      try {
        // Only a source whose relay confirmed reads is asked; `list` would start a task there.
        const listed = remoteListing(await this.remote.request(peer.device.id, context, 'available', {}, { timeoutMs: VIEW_REMOTE_MS }), peer.device.id);
        // best-effort: a task that ended meanwhile simply lists nothing.
        try { if (task) service.checkTask(task); } catch { return []; }
        // A key this session stopped is offered to re-allow instead.
        disconnected.push(...listed.filter(item => excluded.includes(item.id)).map(item => ({ ...wireMetadata(item), remote: true })));
        return listed.filter(item => !excluded.includes(item.id))
          .map(item => ({ ...item, basis: ['remote' as const], operations: item.operations ?? [] }));
      } catch { unavailable.push(peer.device.id); return []; }
    }));
    return { available: lists.flat(), unavailable, updatePending, disconnected };
  }
  /** The owner view of a joined computer's session, from what that computer reported (`subject`) and this vault. */
  private remoteSessionView(sessionId: string, subject: RemoteSessionSubject): SecretSessionView {
    const service = this.options.service; const status = service.status();
    if (!status.initialized) return closedView(status, 'uninitialized');
    if (status.locked || this.blocked) return closedView(status, 'locked');
    if ('error' in subject) return closedView(status, subject.error);
    if (subject.sessionId !== sessionId) throw fail('원격 세션을 확인할 수 없습니다.', 'unavailable');
    try {
      // Keys stopped on either computer: the joined computer refuses what its own task stops, whatever this vault allows.
      const stopped = subject.taskId ? [...service.exclusions(subject.taskId), ...subject.excluded ?? []] : [];
      const available = service.availableFor({ hostId: subject.hostId, sessionId, root: subject.root, taskId: subject.taskId ?? randomUUID(), runId: 'owner-view' }).filter(item => !stopped.includes(item.id));
      // Saved keys stay connectable; a connection made here lifts the joined computer's stop too.
      const disconnected = subject.taskId ? service.disconnectedTemporary(subject.taskId, stopped) : [];
      return { status, available, connectable: this.connectable(), usage: subject.usage, unavailableSources: [], updatePendingSources: [], disconnected };
    } catch (error) { if (service.status().locked) return closedView(service.status(), 'locked'); throw error; }
  }
  /** This computer's session for its controller's owner view (`/secret-session`), with its exclusions when the controller reads them; reads only. */
  async sessionSubject(sessionId: string, exclusions = false): Promise<RemoteSessionSubject> {
    const service = this.options.service; const status = service.status();
    if (!status.initialized) return { error: 'uninitialized' };
    if (status.locked || this.blocked) return { error: 'locked' };
    const subject = await this.viewSession(sessionId);
    if ('error' in subject) return subject;
    return { hostId: service.device().id, sessionId: subject.session.id, root: subject.session.cwd, ...(subject.task ? { taskId: subject.task.taskId, ...(exclusions ? { excluded: service.exclusions(subject.task.taskId) } : {}) } : {}), usage: this.recentUsage(subject.session.id) };
  }
  /** A controller connected these keys to this computer's session: this session stops them no more; their source decides. */
  async reallowFromController(target: SecretTarget, secretIds: string[]): Promise<void> { await this.options.service.reallowSession(target, secretIds); }
  /** The session an owner change applies to: this computer's, whose task the change may start, or a joined computer's as its web verified it. */
  private async ownerTarget(input: { sessionId: string; nodeId?: string }, remote: unknown): Promise<SecretTarget> {
    if (input.nodeId === undefined) {
      if (remote !== undefined) throw fail('이 컴퓨터의 세션에는 원격 작업을 지정할 수 없습니다.');
      return this.target(input.sessionId);
    }
    const target = ownerInput(remoteTarget, remote, '원격 세션의 시크릿 작업을 확인할 수 없습니다.');
    if (target.sessionId !== input.sessionId) throw fail('원격 세션의 시크릿 작업을 확인할 수 없습니다.', 'unavailable');
    return { hostId: target.hostId, sessionId: target.sessionId, root: target.root, taskId: target.taskId };
  }
  /** A committed owner change for one session: a joined computer's is answered with its receipt; this computer's session is told of a connection. */
  private async changed(target: SecretTarget, remote: boolean, notify: boolean): Promise<SecretSessionView | SecretReceipt> {
    if (remote) return { connectedTarget: { hostId: target.hostId, sessionId: target.sessionId, root: target.root, taskId: target.taskId } };
    if (notify) this.notifyConnection(target);
    return this.sessionView(target.sessionId);
  }
  /**
   * Owner input travels only on the private owner API/RPC, never TowerApi's agent ledger. `remote` is what the web
   * verified for a joined computer's session (`nodeId`): its task for a change, its report for a view.
   */
  async control(action: string, input: Record<string, unknown>, remote?: unknown): Promise<SecretControlResult> {
    const service = this.options.service;
    if (action === 'settings') return this.settingsView();
    if (action === 'session') {
      const { sessionId, nodeId } = ownerInput(ownerSession, input);
      return nodeId === undefined ? this.sessionView(sessionId) : this.remoteSessionView(sessionId, ownerInput(remoteSubject, remote, '원격 세션을 확인할 수 없습니다.'));
    }
    if (action === 'preview') return { fields: Object.keys(parseDotenv(typeof input.value === 'string' ? input.value : '')) };
    if (action === 'tower-status') return { towerPassword: service.vault.hasTower(ownerInput(towerCredential, input).credentialId) ? 'ready' : 'missing' };
    if (action === 'tower-wrap') { const { password, credentialId } = ownerInput(towerWrapInput, input); return { wrapped: await this.towerWrap(password, credentialId) }; }
    if (action === 'tower-prune') { const { credentialId } = ownerInput(towerCredential, input); if (service.status().initialized) await service.towerPrune(credentialId); return {}; }
    if (action === 'view-unlock') return this.viewUnlock(ownerInput(viewUnlockInput, input));
    if (action === 'value' || action === 'value-update') return this.valueAction(action, input);
    const password = (field: string) => { if (typeof input[field] !== 'string') throw fail('보관함 비밀번호가 필요합니다.'); return input[field] as string; };
    if (action === 'initialize') await this.open(() => service.initialize(password('password')));
    else if (action === 'unlock') await this.open(() => service.unlock(password('password')));
    else if (action === 'lock') { await service.lock(); this.ownerLocked = true; }
    else if (action === 'password') await service.changePassword(password('currentPassword'), password('newPassword'));
    else if (action === 'import') { if (!this.options.importPending || typeof input.id !== 'string') throw fail('가져올 암호화 기록이 필요합니다.'); await this.options.importPending(input.id, password('password')); }
    else if (!MUTATIONS.has(action)) throw fail('알 수 없는 시크릿 작업입니다.', 'not-found');
    else if (service.status().locked) throw fail('시크릿 보관함이 잠겨 있습니다. 잠금을 해제한 뒤 다시 시도하세요.', 'locked');
    else if (action === 'create') {
      // Never a target, host, task or folder of the page's own: the session is verified here or by the web for a joined computer.
      const { name, kind, value, content, sharing, sessionId, nodeId, connect, temporary } = ownerInput(ownerCreate, input);
      const secret = { name, kind, value, content, ...(sharing ? { sharing } : {}), ...(connect ? { connect } : {}), ...(temporary ? { temporary } : {}) };
      if (sessionId === undefined) await service.create(secret);
      else { const target = await this.ownerTarget({ sessionId, nodeId }, remote); await service.create(secret, target); return this.changed(target, nodeId !== undefined, true); }
    } else if (action === 'session-connect' || action === 'session-disconnect' || action === 'session-reallow') {
      const { sessionId, nodeId, secretIds } = ownerInput(ownerConnection, input);
      // Another source's key is stopped by the session's own computer, and re-allowed there.
      if (action === 'session-reallow' && nodeId !== undefined) throw fail('다른 원본의 시크릿은 그 세션이 있는 컴퓨터에서 다시 허용하세요.');
      const target = await this.ownerTarget({ sessionId, nodeId }, remote);
      if (action === 'session-connect') await service.connectSession(target, secretIds);
      else if (action === 'session-disconnect') await service.disconnectSession(target, secretIds);
      else await service.reallowSession(target, secretIds);
      return this.changed(target, nodeId !== undefined, action === 'session-connect');
    } else if (action === 'sharing') {
      const { secretId, revision, allMachines, machines, folders, kept } = ownerInput(ownerSharingChange, input);
      await service.setSharing(secretId, revision, { allMachines, machines, folders }, kept);
    } else if (action === 'remove') await service.remove(ownerInput(z.object({ id: z.string().min(1).max(256) }), input).id);
    else if (action === 'trust') {
      const peer = z.object({ device: z.unknown(), routeId: z.string().min(1).max(256), direction: z.enum(['node','controller']) }).parse(input);
      await service.trustPeer({ device: peerDevice(peer.device), routeId: peer.routeId, direction: peer.direction, enabled: true });
    } else if (action === 'untrust') await service.removePeer(z.string().parse(input.id));
    return this.settingsView();
  }
  /** Adds the Tower password wrapper of `credentialId` around the open key; false, never an error, while locked or without a vault. */
  private async towerWrap(password: string, credentialId: string): Promise<boolean> {
    const service = this.options.service; if (service.status().locked) return false;
    try { await service.towerWrap(password, credentialId); return true; }
    catch (error) { if (service.status().locked) return false; throw error; }
  }
  /**
   * Value viewing with the Tower password the web verified for `credentialId`. A locked vault opens with that password's
   * wrapper, or once with the recovery (vault) password, which then wraps the key for it; an open one only checks the
   * wrapper unwraps its key and makes it when it does not (the first use). Only that wrapper is kept.
   */
  private async viewUnlock({ password, credentialId, recoveryPassword }: z.output<typeof viewUnlockInput>): Promise<{ generation: string }> {
    const service = this.options.service;
    if (!service.status().initialized) throw fail('시크릿 보관함이 아직 없습니다. 보관함을 먼저 만드세요.', 'not-found');
    // False when `unlock` itself fails; a failure after it opened (migration, closures) is the open's own and is thrown.
    const tryOpen = async (unlock: () => Promise<unknown>): Promise<boolean> => {
      let opened = false;
      try { await this.open(async () => { await unlock(); opened = true; }); return true; }
      catch (error) { if (opened) throw error; return false; }
    };
    if (service.status().locked) {
      // A wrapper that does not open counts as missing.
      if (service.vault.hasTower(credentialId)) await tryOpen(() => service.towerUnlock(password, credentialId));
      if (service.status().locked) {
        if (recoveryPassword === undefined) throw viewFail('needs-recovery', 'conflict', 'Tower 비밀번호로 연결된 보관함 열쇠가 없습니다. 복구 비밀번호(기존 보관함 비밀번호)를 한 번 입력하세요.');
        if (!await tryOpen(() => service.unlock(recoveryPassword))) throw fail('복구 비밀번호(기존 보관함 비밀번호)가 올바르지 않습니다.');
        await service.towerPrune(credentialId); await service.towerWrap(password, credentialId);
      }
    } else {
      let current = false;
      // best-effort: a wrapper that does not unwrap the open key is made again below.
      if (service.vault.hasTower(credentialId)) { try { await service.towerUnlock(password, credentialId); current = true; } catch { /* Made again below. */ } }
      // Other credentials' wrappers never open it (only this one is tried), and two of them would leave no room for it.
      if (!current) { await service.towerPrune(credentialId); await service.towerWrap(password, credentialId); }
    }
    await service.towerPrune(credentialId);
    return { generation: service.lockGeneration };
  }
  /** Reads or replaces one value for the owner, only within the lock generation value viewing was unlocked in. */
  private async valueAction(action: 'value' | 'value-update', input: Record<string, unknown>): Promise<SecretValue | SecretSettingsView> {
    const service = this.options.service;
    const { secretId, expectedVersion, generation, value, content } = ownerInput(action === 'value' ? valueRead : valueWrite, input) as z.output<typeof valueWrite>;
    if (this.blocked || service.status().locked || generation !== service.lockGeneration) throw viewLocked();
    // The service checks the generation again in its own turn of the queue, behind any lock or open queued first.
    if (action === 'value') return service.value(secretId, expectedVersion, generation);
    await service.update({ id: secretId, expectedVersion, value, content, generation });
    return this.settingsView();
  }
  peers(): SecretPeer[] { return this.options.service.status().locked ? [] : this.options.service.peers(); }
  device(): SecretDevice { return this.options.service.device(); }
  /**
   * `features` is what the source's relay says its worker serves; absent from older relays. `refused`: requests the
   * followed host's relay just said it cannot answer while its vault is locked, for its owner's notice.
   */
  poll(routeId: string, features?: unknown): { requests: RemoteSecretRequest[]; refused?: number } {
    const requests = this.remote.poll(routeId, features); const refused = this.remote.lockedRefusals(routeId);
    return { requests, ...(refused ? { refused } : {}) };
  }
  /** The source's link went away. */
  peerOffline(routeId: string): void { this.remote.forget(routeId); }
  /** `following`: that computer follows this Tower now, as the web's controller knows it (see `RemoteSecretBroker.answer`). */
  answer(routeId: string, request: RemoteSecretRequest, following = false): Promise<RemoteSecretResponse> { return this.remote.answer(routeId, request, following); }
  deliver(routeId: string, response: RemoteSecretResponse): void { this.remote.deliver(routeId, response); }
}

export async function startSecretsMcp(stateDir: string): Promise<void> {
  const capability = process.env.TOWER_SECRET_CAPABILITY;
  await serveToolBridge({ name: 'tower-secrets', listTools: async () => ((await callWorkerTools(stateDir, capability, { method: 'tools/list' })) as { tools: unknown[] }).tools,
    callTool: (name, args) => callWorkerTools(stateDir, capability, { method: 'tools/call', name, arguments: args }) });
}
