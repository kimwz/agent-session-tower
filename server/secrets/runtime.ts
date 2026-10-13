import { createHash, createPublicKey } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { realpath, unlink } from 'node:fs/promises';
import { isAbsolute, normalize, join } from 'node:path';
import { z } from 'zod';
import type { Run, Session } from '../../shared/types.js';
import type { SecretBrokerAccess, SecretBrokerApproval, SecretContext, SecretCreateInput, SecretCreateRequest, SecretDevice, SecretOverview, SecretPeer, SecretProject, SecretTarget } from '../../shared/secrets.js';
import { SECRET_OPERATIONS } from '../../shared/secrets.js';
import type { Capability } from '../api/mcp.js';
import type { SessionOrigin } from '../runs/origin.js';
import { callWorkerTools, serveToolBridge } from '../mcp/stdio.js';
import { inMasterFolder } from '../runs/subscription.js';
import { SecretBroker } from './broker.js';
import { parseSecretCli } from './cli.js';
import { parseDotenv } from './dotenv.js';
import { RemoteSecretBroker, type RemoteSecretRequest, type RemoteSecretResponse } from './remote.js';
import { SecretService } from './service.js';
import { SECRET_LOCKED_LIST, SECRET_LOCKED_UNINDEXED, SECRET_LOCKED_USE, SECRET_NO_VAULT, SECRET_USE_INSTRUCTIONS } from './notices.js';
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
  secrets_list: `List secret names, references, selected fields and permitted operations for this authenticated project/task, including automatic project connections. Values are never returned. ${SECRET_USE_INSTRUCTIONS}`,
  secrets_run: 'Run a program with permitted secret references as environment variables, stdin or private temporary files. Use {secret-file:NAME} in args for a files mapping. Values never go in args. stdout/stderr are masked before return. Use a unique stable operationId; uncertain requests are not executed again.',
  secrets_compare: 'Compare two permitted secret references inside the broker; returns only equality.',
  secrets_fingerprint: 'Return a domain scoped HMAC fingerprint for a permitted secret reference, without its value.',
  secrets_cli: 'Use the Tower secrets CLI argv interface through this authenticated run: list; run --operation-id ID --env NAME=REF --env-bundle REF --file NAME=REF -- PROGRAM ARGS; pipe --operation-id ID --secret REF -- PROGRAM ARGS; compare LEFT RIGHT; fingerprint REF. Reuse the same ID only to check the same request result. No raw read/export command exists.',
};
export const SECRET_TOOLS = Object.entries(schemas).map(([name, input]) => {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(input, { io: 'input' });
  return { name, description: descriptions[name as keyof typeof schemas], inputSchema };
});
/** The owner page's group-and-rule create body as sharing: GLOBAL for every project, the session's or a project's folders, a session value temporary. */
function createInput(request: SecretCreateRequest & { currentProject?: boolean }, target: SecretTarget | undefined, projects: SecretProject[]): SecretCreateInput {
  const project = request.currentProject || !request.projectId ? undefined : projects.find(project => project.id === request.projectId);
  if (request.scope !== 'task' && request.projectId && !request.currentProject && !project) throw fail('공유할 프로젝트를 찾을 수 없습니다.');
  const folders = request.currentProject && target ? [{ hostId: target.hostId, root: target.root }] : project?.bindings.map(({ hostId, root }) => ({ hostId, root })) ?? [];
  return { name: request.name, kind: request.kind, value: request.value, content: request.content, ...(request.connect ? { connect: 'session' as const } : {}),
    ...(request.scope === 'task' ? { temporary: true } : { sharing: { global: request.scope === 'global' && request.allProjects === true, folders } }) };
}
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
  constructor(private readonly options: {
    stateDir: string; service: SecretService; runs: Runs;
    migrate?: () => Promise<void>; pendingImports?: () => Promise<string[]>;
    importPending?: (id: string, password: string) => Promise<void>;
    remoteAllowed?: (context: SecretContext) => boolean;
    isClosed?: (id: string) => Promise<boolean>;
    /** Explicit chat assignment only; owner input and secret material never reach the callback. */
    onConnect?: (sessionId: string) => void;
  }) {
    const service = options.service;
    const accepted = new Map<string, SecretContext>();
    const normalized = (context: SecretContext) => {
      if (this.blocked) throw fail('보관함 잠금 해제를 완료하지 못했습니다.', 'unavailable');
      if (options.remoteAllowed && !options.remoteAllowed(context)) throw fail('원격 작업을 허용하지 않습니다.', 'forbidden');
      return service.ensureRemoteTask(context);
    };
    this.remote = new RemoteSecretBroker({ device: () => service.device(), deviceKeys: () => service.deviceKeys(), peers: () => service.status().locked ? [] : service.peers(),
      begin: async (context, id, digest) => { const trusted = await normalized(context); const claim = await service.beginOperation(trusted, id, digest); if (claim.fresh && id.startsWith('remote-id:')) accepted.set(id, trusted); return claim.fresh; },
      // Remote replay is refused even after completion; retain only its proof, not an unused response cache.
      finish: async (_context, id, digest, _answer) => { const trusted = accepted.get(id); if (!trusted) throw fail('원격 요청 기록을 확인할 수 없습니다.'); try { await service.finishOperation(trusted, id, digest, { answered: true }); } finally { accepted.delete(id); } },
      handle: async (context, request) => {
        const trusted = await normalized(context);
        if (request.operation === 'list') return service.list(trusted);
        if (request.operation === 'close') { await service.closeTask(trusted.taskId); return { closed: true }; }
        const payload = z.object({ reference: ref, operation: z.enum(SECRET_OPERATIONS).exclude(['discover']) }).strict().parse(request.payload);
        return service.resolve(trusted, payload.reference, payload.operation);
      },
    });
    this.broker = new SecretBroker({ stateDir: options.stateDir, service, remote: this.remote, validate: context => this.validateBrokerContext(context) });
  }
  initialized(): boolean { return this.options.service.status().initialized; }
  inFlight(): boolean { return this.housekeeping > 0 || this.broker.inFlight() || this.remote.inFlight() > 0 || this.remote.pending() > 0; }
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

  private candidate(session: Session): Session & { cwd: string } {
    const provenance = this.options.runs.sessionOrigin(session.id);
    if (session.closed || session.node || session.master || session.creationPending || session.isSubagent || session.launchedByAgent || session.parentId || session.launchedBy || provenance?.untrustedInput !== false || provenance?.controllerId || provenance?.kind !== 'agent' || this.closedSessions.has(session.id)) throw fail('외부 입력이나 상속 없는 로컬 agent 생성 주 세션만 승인할 수 있습니다.', 'forbidden');
    const cwd = realpathSync(session.cwd);
    if (inMasterFolder(this.options.stateDir, session.cwd) || inMasterFolder(this.options.stateDir, cwd)) throw fail('마스터 폴더의 세션은 프로젝트 브로커 승인을 받을 수 없습니다.', 'forbidden');
    return { ...session, cwd };
  }
  /** Admission protection survives locks/root changes; it confers no secret or tool authority. */
  brokerAdmissionRequired(session: Session | undefined): boolean {
    if (!session) return false;
    const known = this.options.service.brokerAdmissionRequired(session.id);
    if (known === true || (!this.blocked && known !== undefined)) return known;
    // An old/unavailable index or an unfinished unlock cannot establish absence of protection.
    const provenance = this.options.runs.sessionOrigin(session.id);
    return this.options.service.status().initialized && !session.node && !session.master && !session.isSubagent && !session.launchedByAgent && !session.parentId && !session.launchedBy && provenance?.kind === 'agent' && provenance.untrustedInput === false && !provenance.controllerId;
  }
  brokerApproval(session: Session | undefined): SecretBrokerApproval | undefined {
    if (!session || this.blocked || this.options.service.status().locked) return;
    try { const current = this.options.runs.getSession(session.id); if (!current) return; const candidate = this.candidate(current); return this.options.service.brokerApproval(candidate.id, candidate.cwd); }
    catch (error) {
      if (!(error instanceof TowerError)) console.warn('Tower denied broker access because the session identity could not be verified.');
      return;
    }
  }
  private async session(id: string, approvalId?: string): Promise<Session & { cwd: string }> {
    const session = this.options.runs.getSession(id);
    const provenance = session && this.options.runs.sessionOrigin(session.id);
    if (!session || session.closed || await this.options.isClosed?.(session.id) || (await this.readClosures()).includes(closureId(session.id))) throw fail('이 프로젝트 세션은 종료되었습니다.', 'forbidden');
    if (approvalId) {
      const candidate = this.candidate(session), approval = this.brokerApproval(candidate);
      if (!approval || approval.id !== approvalId) throw fail('이 작업의 브로커 승인이 만료되거나 철회되었습니다.', 'forbidden');
      return candidate;
    }
    if (session.isSubagent || session.launchedByAgent || session.parentId || session.launchedBy || provenance?.untrustedInput || (provenance && provenance.kind !== 'owner')) throw fail('소유자의 프로젝트 세션에서만 시크릿을 연결할 수 있습니다.', 'forbidden');
    return { ...session, cwd: await realpath(session.cwd) };
  }
  private validateBrokerContext(context: SecretContext): void {
    if (!context.brokerApprovalId) return;
    const run = this.options.runs.list().find(item => item.id === context.runId);
    if (this.blocked || !run || run.sessionId !== context.sessionId || run.status !== 'running' || run.origin?.kind !== 'owner' || run.origin.controllerId || run.brokerOwnerAuthorized !== true || run.towerTools !== 'broker-only') throw fail('이 브로커 승인은 현재 소유자 실행에서만 사용할 수 있습니다.', 'forbidden');
    const session = this.options.runs.getSession(context.sessionId);
    if (!session || this.candidate(session).cwd !== context.root) throw fail('승인된 프로젝트 세션이 변경되었습니다.', 'forbidden');
    this.options.service.checkBrokerApproval(context);
  }
  async brokerAccess(sessionId: string): Promise<SecretBrokerAccess> {
    const locked = this.options.service.status().locked;
    const result: SecretBrokerAccess = { sessionId, taskId: null, eligible: false, requiresApproval: this.options.runs.sessionOrigin(sessionId)?.kind === 'agent', locked };
    const session = this.options.runs.getSession(sessionId);
    if (!session) return { ...result, reason: '세션을 찾을 수 없습니다.' };
    try {
      if (await this.options.isClosed?.(sessionId) || (await this.readClosures()).includes(closureId(sessionId))) throw fail('종료한 세션은 승인할 수 없습니다.', 'forbidden');
      const candidate = this.candidate(session);
      return { ...result, root: candidate.cwd, eligible: true, ...(!locked ? { taskId: this.options.service.currentTask(sessionId, candidate.cwd)?.taskId ?? null, approval: this.brokerApproval(candidate) } : {}) };
    } catch (error) { return { ...result, reason: error instanceof TowerError ? error.message : '프로젝트 경로를 확인할 수 없습니다.' }; }
  }
  async target(sessionId: string): Promise<SecretTarget> {
    const approval = this.brokerApproval(this.options.runs.getSession(sessionId));
    const session = await this.session(sessionId, approval?.id);
    if (approval) { const target = this.options.service.currentTask(session.id, session.cwd); if (!target || target.taskId !== approval.taskId) throw fail('승인한 작업을 찾을 수 없습니다.', 'forbidden'); return target; }
    return this.options.service.ensureTask(session.id, session.cwd);
  }
  async peekTarget(sessionId: string): Promise<SecretTarget | undefined> { const session = await this.session(sessionId, this.brokerApproval(this.options.runs.getSession(sessionId))?.id); return this.options.service.currentTask(session.id, session.cwd); }
  async remoteTarget(sessionId: string, create = true): Promise<SecretTarget | undefined> { return create ? this.target(sessionId) : this.peekTarget(sessionId); }
  private async ownerRun(capability: Extract<Capability, { kind: 'secret-run' }>): Promise<{ run: Run; session: Session & { cwd: string } }> {
    if (this.blocked) throw fail('보관함 잠금 해제를 완료하지 못했습니다.', 'unavailable');
    const run = this.options.runs.list().find(item => item.id === capability.runId);
    if (!run || run.sessionId !== capability.sessionId || run.status !== 'running' || run.origin?.kind !== 'owner' || (capability.approvalId ? run.towerTools !== 'broker-only' || run.brokerOwnerAuthorized !== true || !!run.origin.controllerId : run.towerTools !== 'attached')) throw fail('이 시크릿 도구는 발급받은 실행 중에만 사용할 수 있습니다.', 'forbidden');
    return { run, session: await this.session(run.sessionId, capability.approvalId) };
  }
  async authorizeCapability(capability: Extract<Capability, { kind: 'secret-run' }>): Promise<void> {
    const { run, session } = await this.ownerRun(capability);
    if (capability.approvalId) {
      const target = this.options.service.currentTask(session.id, session.cwd);
      if (!target) throw fail('승인한 시크릿 작업이 종료되었습니다.', 'forbidden');
      this.validateBrokerContext({ ...target, runId: run.id, brokerApprovalId: capability.approvalId });
    }
  }
  async context(capability: Extract<Capability, { kind: 'secret-run' }>): Promise<SecretContext> {
    const { run, session } = await this.ownerRun(capability);
    let target = this.runTasks.get(run.id);
    if (!target) {
      if (capability.approvalId) { const approval = this.brokerApproval(session); if (!approval || approval.id !== capability.approvalId) throw fail('브로커 승인이 변경되었습니다.', 'forbidden'); target = this.options.service.currentTask(session.id, session.cwd); if (!target || target.taskId !== approval.taskId) throw fail('승인한 시크릿 작업이 변경되었습니다.', 'forbidden'); }
      else target = await this.options.service.bindRun(session.id, session.cwd, run.startedAt ?? run.createdAt);
      this.runTasks.set(run.id, target);
    }
    if (target.root !== session.cwd) throw fail('실행의 프로젝트 경로가 변경되었습니다.', 'forbidden');
    const current = this.options.service.currentTask(session.id, session.cwd, target.hostId);
    // Project registration can change during a run, but its original task identity must never change.
    if (current?.taskId === target.taskId) { target = { ...target, projectId: current.projectId }; this.runTasks.set(run.id, target); }
    // list/resolve revalidate the task; a closed task is never replaced for this run.
    const context = { ...target, runId: run.id, ...(capability.approvalId ? { brokerApprovalId: capability.approvalId } : {}) };
    this.validateBrokerContext(context); return context;
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
    if (name === 'secrets_list') return { secrets: await this.broker.list(context), unavailableSources: this.broker.unavailableSources(context), usage: descriptions.secrets_cli };
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
    const { run, session } = await this.ownerRun(capability);
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
    this.blocked = true;
    try { await unlock(); await this.options.migrate?.(); await this.applyClosures(); this.blocked = false; }
    catch (error) { await this.options.service.lock(); this.blocked = false; throw error; }
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
  async overview(target?: SecretTarget): Promise<SecretOverview> {
    const service = this.options.service;
    const result = service.overview(target);
    const ids = await this.options.pendingImports?.() ?? [];
    result.status = { ...result.status, pendingImports: ids.length, pendingImportIds: ids };
    if (target && !result.status.locked) {
      const context = { ...target, runId: 'owner-ui' };
      const available = target.hostId === service.device().id ? await this.broker.list(context) : await service.list(context);
      result.connected = available.map(secret => secret.id);
      result.secrets = result.secrets.map(secret => ({ ...secret, ...available.find(item => item.id === secret.id) }));
      for (const secret of available) {
        if (result.secrets.some(item => item.id === secret.id)) continue;
        result.secrets.push(secret);
        if (!result.groups.some(group => group.id === secret.groupId)) {
          const source = result.peers.find(peer => peer.device.id === secret.sourceHostId)?.device.name ?? secret.sourceHostId;
          result.groups.push({ id: secret.groupId, name: `${source} · ${secret.groupId}`, scope: 'global' });
        }
      }
      if (target.hostId === service.device().id && this.broker.unavailableSources(context).length) result.status.error = 'SECRET_SOURCE_UNAVAILABLE';
    }
    return result;
  }
  /** Owner input travels only on the private owner API/RPC, never TowerApi's agent ledger. */
  async control(action: string, input: Record<string, unknown>, remoteTarget?: SecretTarget, receiptOnly = false): Promise<SecretOverview | SecretBrokerAccess | { fields: string[] } | { connectedTarget: SecretTarget }> {
    const service = this.options.service;
    if (['broker-access', 'approve-broker', 'revoke-broker'].includes(action)) {
      if (remoteTarget || receiptOnly) throw fail('로컬 프로젝트 세션에서만 브로커를 승인할 수 있습니다.', 'forbidden');
      if (action === 'broker-access') { const parsed = z.object({ sessionId: z.string().min(1).max(512) }).strict().parse(input); return this.brokerAccess(parsed.sessionId); }
      if (service.status().locked) throw fail('시크릿 보관함을 잠금 해제한 뒤 브로커 연결을 승인하세요.', 'locked');
      if (action === 'revoke-broker') { const parsed = z.object({ sessionId: z.string().min(1).max(512), approvalId: z.string().uuid() }).strict().parse(input); await service.revokeBroker(parsed.sessionId, parsed.approvalId); return this.brokerAccess(parsed.sessionId); }
      const parsed = z.object({ sessionId: z.string().min(1).max(512), root: z.string().min(1).max(4096), taskId: z.string().uuid().nullable(), taskLabel: z.string().trim().min(1).max(256), ttlMs: z.number().int().positive().max(8 * 60 * 60_000) }).strict().parse(input);
      const access = await this.brokerAccess(parsed.sessionId);
      if (!access.eligible || access.root !== parsed.root || access.taskId !== parsed.taskId) throw fail('승인할 세션의 프로젝트 또는 작업이 변경되었습니다.', 'conflict');
      await service.approveBroker(parsed, () => { const session = this.options.runs.getSession(parsed.sessionId); if (!session || this.candidate(session).cwd !== parsed.root) throw fail('승인할 세션이 변경되었습니다.', 'forbidden'); });
      return this.brokerAccess(parsed.sessionId);
    }
    const notifySession = z.boolean().optional().parse(input.notifySession);
    const explicitConnection = notifySession === true && ((action === 'create' && input.connect === true) || action === 'connect' || action === 'attach');
    if (receiptOnly && (!explicitConnection || !remoteTarget || typeof input.nodeId !== 'string' || typeof input.sessionId !== 'string')) throw fail('원격 채팅 연결의 완료 기록만 요청할 수 있습니다.');
    const password = (field: string) => { if (typeof input[field] !== 'string') throw fail('보관함 비밀번호가 필요합니다.'); return input[field] as string; };
    if (action === 'initialize') await this.open(() => service.initialize(password('password')));
    else if (action === 'unlock') await this.open(() => service.unlock(password('password')));
    else if (action === 'lock') await service.lock();
    else if (action === 'password') await service.changePassword(password('currentPassword'), password('newPassword'));
    else if (action === 'import') { if (!this.options.importPending || typeof input.id !== 'string') throw fail('가져올 암호화 기록이 필요합니다.'); await this.options.importPending(input.id, password('password')); }
    if (['create', 'update', 'remove', 'project', 'rule', 'attach', 'connect', 'revoke', 'end-task', 'trust', 'untrust'].includes(action) && service.status().locked) throw fail('시크릿 보관함이 잠겨 있습니다. 잠금을 해제한 뒤 다시 시도하세요.', 'locked');
    let target: SecretTarget | undefined; let currentProjectId: string | undefined;
    if (!service.status().locked && typeof input.sessionId === 'string') {
      const startsTask = ['create', 'attach', 'connect'].includes(action);
      if (typeof input.nodeId === 'string') target = remoteTarget ? await service.ensureRemoteTask({ ...remoteTarget, runId: 'owner-ui' }, { owner: startsTask }) : undefined;
      else target = startsTask ? await this.target(input.sessionId) : await this.peekTarget(input.sessionId);
      if (!target && typeof input.nodeId !== 'string') {
        const session = await this.session(input.sessionId);
        currentProjectId = service.overview().projects.find(project => project.bindings.some(binding => binding.hostId === service.device().id && binding.root === session.cwd))?.id;
      }
    }
    if (action === 'preview') return { fields: Object.keys(parseDotenv(typeof input.value === 'string' ? input.value : '')) };
    if (action === 'create') {
      // Never accept target, hostId, taskId, or projectRoot supplied by the page.
      const request = z.object({ name: z.string().min(1).max(256), kind: z.enum(['scalar','env','file']), scope: z.enum(['global','project','task']), value: z.string().optional(), content: z.string().optional(), groupId: z.string().optional(), groupName: z.string().max(256).optional(), allProjects: z.boolean().optional(), projectId: z.string().optional(), currentProject: z.boolean().optional(), activation: z.enum(['manual','auto']).optional(), operations: z.array(z.enum(SECRET_OPERATIONS)).max(6).optional(), connect: z.boolean().optional(), expiresAt: z.number().optional() }).parse(input);
      if (request.currentProject && (!target || request.scope !== 'project')) throw fail('저장할 프로젝트 세션이 필요합니다.');
      await service.create(createInput(request, target, service.overview().projects), target);
    } else if (action === 'update') {
      const update = z.object({ id: z.string(), value: z.string().optional(), content: z.string().optional() }).parse(input);
      await service.update(update);
    } else if (action === 'remove') {
      const id = z.string().parse(input.id); await service.remove(id);
    }
    else if (action === 'project') {
      const project = z.object({ id: z.string().optional(), name: z.string().min(1).max(256), bindings: z.array(z.object({ hostId: z.string(), root: z.string() })).min(1).max(100) }).parse(input);
      for (const binding of project.bindings) {
        if (binding.hostId === service.device().id) binding.root = await realpath(binding.root);
        else if (!service.peers().some(peer => peer.enabled && peer.device.id === binding.hostId)) throw fail('승인한 시크릿 컴퓨터를 선택하세요.');
        if (!isAbsolute(binding.root) || normalize(binding.root) !== binding.root) throw fail('프로젝트의 절대 경로가 필요합니다.');
      }
      await service.project(project);
    } else if (action === 'rule') {
      const parsed = z.object({ id: z.string().optional(), groupId: z.string(), secretIds: z.array(z.string()).max(4096), hostId: z.string(), projectId: z.string().optional(), activation: z.enum(['manual','auto']), operations: z.array(z.enum(SECRET_OPERATIONS)).min(1).max(6), fields: z.record(z.string(), z.array(z.string()).max(2048)).optional(), allProjects: z.boolean().optional(), root: z.string().optional(), maxTtlMs: z.number().int().positive().optional(), expiresAt: z.number().optional(), enabled: z.boolean() }).safeParse(input);
      if (!parsed.success) throw fail(parsed.error.issues.some(issue => issue.path[0] === 'maxTtlMs') ? '작업 내 최대 사용 시간이 올바르지 않습니다.' : '공유 규칙 입력 형식이 올바르지 않습니다.');
      const rule = parsed.data;
      if (rule.hostId !== service.device().id && !service.peers().some(peer => peer.enabled && peer.device.id === rule.hostId)) throw fail('승인한 시크릿 컴퓨터를 선택하세요.');
      // Remote grants have a finite deadline even if the page leaves it blank.
      if (rule.hostId !== service.device().id) rule.maxTtlMs ??= 8 * 60 * 60_000;
      await service.setRule(rule);
    } else if (action === 'attach' || action === 'connect' || action === 'revoke') {
      if (!target) throw fail('연결할 프로젝트 세션이 필요합니다.');
      const ids = z.array(z.string()).min(1).max(4096).parse(input.secretIds);
      if (action === 'revoke') await service.disconnectSession(target, ids); else await service.connectSession(target, ids);
    } else if (action === 'end-task') { if (!target) throw fail('종료할 작업이 필요합니다.'); await this.endTask(target); target = undefined; }
    else if (action === 'trust') {
      const peer = z.object({ device: z.object({ id: z.string().uuid(), name: z.string().max(256), signingKey: z.string().max(4096), encryptionKey: z.string().max(4096), fingerprint: z.string() }), routeId: z.string().min(1).max(256), direction: z.enum(['node','controller']) }).parse(input);
      if (createPublicKey(peer.device.signingKey).asymmetricKeyType !== 'ed25519' || createPublicKey(peer.device.encryptionKey).asymmetricKeyType !== 'x25519' || peer.device.fingerprint !== createHash('sha256').update(peer.device.signingKey + ':' + peer.device.encryptionKey).digest('hex')) throw fail('컴퓨터의 공개 키와 지문을 확인하세요.');
      await service.trustPeer({ ...peer, enabled: true });
    } else if (action === 'untrust') await service.removePeer(z.string().parse(input.id));
    else if (!['initialize','unlock','lock','password','import','overview'].includes(action)) throw fail('알 수 없는 시크릿 작업입니다.', 'not-found');
    // A committed explicit assignment is announced before reading its owner receipt.
    if (explicitConnection && target) this.notifyConnection(target);
    if (receiptOnly) {
      if (!target) throw fail('연결한 원격 작업을 확인할 수 없습니다.', 'unavailable');
      const { hostId, sessionId, root, taskId, projectId } = target;
      return { connectedTarget: { hostId, sessionId, root, taskId, ...(projectId ? { projectId } : {}) } };
    }
    const overview = await this.overview(target);
    return { ...overview, currentProjectId: target?.projectId ?? currentProjectId };
  }
  peers(): SecretPeer[] { return this.options.service.status().locked ? [] : this.options.service.peers(); }
  device(): SecretDevice { return this.options.service.device(); }
  poll(routeId: string): RemoteSecretRequest[] { return this.remote.poll(routeId); }
  answer(routeId: string, request: RemoteSecretRequest): Promise<RemoteSecretResponse> { return this.remote.answer(routeId, request); }
  deliver(routeId: string, response: RemoteSecretResponse): void { this.remote.deliver(routeId, response); }
}

export async function startSecretsMcp(stateDir: string): Promise<void> {
  const capability = process.env.TOWER_SECRET_CAPABILITY;
  await serveToolBridge({ name: 'tower-secrets', listTools: async () => ((await callWorkerTools(stateDir, capability, { method: 'tools/list' })) as { tools: unknown[] }).tools,
    callTool: (name, args) => callWorkerTools(stateDir, capability, { method: 'tools/call', name, arguments: args }) });
}
