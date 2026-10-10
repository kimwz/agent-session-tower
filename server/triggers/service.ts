import type { StorageUpdateInput } from '../link/storage-update.js';
import type { StorageClient } from '../storage/client.js';
import { triggerBackupOf } from './backup.js';
import { serializeState } from './state.js';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { type GitHubAuth, type GitHubCheck, type HttpCondition, type HttpRequest, type HttpTestResult, type SecretInput, type Trigger, type TriggerActor, type TriggerAuditEntry, type TriggerEvent, type TriggerOverview, type TriggerSecret, type TriggerSettings, type IssuePreview, type TriggerSource, type Schedule } from '../../shared/triggers.js';
import { previewSlots } from './schedule.js';
import { performHttp, type HttpOutcome } from './http.js';
import { SecretStore, type StoredSecret } from './secrets.js';
import type { TriggerBackup } from './backup.js';
import { checkGitHub, type GitHubFetch } from './github.js';
import { failure } from './errors.js';
import { UNFINISHED, type EngineState } from './state.js';
import { GitHubAccess, readGhToken } from './github-access.js';
import { type TriggerExecutor } from './handover.js';
import { RequestBudget, sendRequest, testResult } from './outbound.js';
import { TriggerStore } from './store.js';
import { TriggerDispatch } from './dispatch.js';
import { TriggerEngine } from './engine.js';
import { TriggerPolls } from './polls.js';
import { TriggerDefinitions, type TriggerScope } from './definitions.js';
import { restoreFrom, restoreOwnerBackup } from './restore.js';
import { type SlackProjection, auditPage, deletedTriggers, eventsPage, getTrigger, keptCopies, launchAllowed, listTriggers, oneEvent, overviewOf } from './views.js';

export type { TriggerExecutor } from './handover.js';
export { REMOTE_FOLDER_REFUSED } from './handover.js';
export { KEEP_OPEN } from './text.js';


export { MAX_ONCE_RESERVATIONS, MAX_RETAINED_TRIGGERS, MAX_REVISIONS } from './limits.js';
export { triggerRequestId } from './firing.js';

export { COORDINATOR_HERE, type TriggerScope } from './definitions.js';
export type { SlackProjection } from './views.js';

/**
 * Owns trigger definitions, their history and the events they fire. One worker writes the engine file;
 * every change is computed on a copy, saved, and only then made current.
 */
export class TriggerService extends EventEmitter {
  private readonly store: TriggerStore;
  private get state(): EngineState { return this.store.state; }
  private readonly definitions: TriggerDefinitions;
  private readonly budget: RequestBudget;
  private readonly github: GitHubAccess;
  private readonly polls: TriggerPolls;
  private readonly dispatch: TriggerDispatch;
  private readonly engine: TriggerEngine;
  private readonly secrets: SecretStore;
  private readonly now: () => number;

  constructor(private readonly options: { stateDir: string; executor: TriggerExecutor; now?: () => number; slack?: () => SlackProjection | undefined; tickMs?: number;
    storage?: StorageClient;
    secretStore?: SecretStore;
    /** Public agents appear among triggers; their settings and history stay in their own files. */
    publicAgents?: () => SlackProjection[];
    limits?: { acceptBytes?: number; maxBytes?: number; requestsPerMinute?: number };
    /** Ports this Tower listens on; HTTP triggers may never call them. */
    ownPorts?: () => Promise<number[]>;
    /**
     * Whether a folder is kept out of sharing with controlling computers: `check` reads the list and looks where the
     * folder is again; `now` answers at once from that look, as the run is admitted.
     */
    sharing?: { check(path: string): Promise<boolean>; now(path: string): boolean };
    /** Reads the gh CLI's token; replaceable in tests. */
    ghToken?: () => Promise<string>;
    /** Sends GitHub API requests with this Authorization value; replaceable in tests. */
    githubTransport?: (authorization: string) => GitHubFetch;
    resolve?: Parameters<typeof performHttp>[2] }) {
    super();
    this.secrets = options.secretStore ?? new SecretStore(options.stateDir);
    this.now = options.now ?? Date.now;
    this.store = new TriggerStore({ stateDir: options.stateDir, storage: options.storage, now: this.now, limits: () => this.options.limits, changed: () => this.emit('change') });
    this.budget = new RequestBudget(this.now, () => this.options.limits?.requestsPerMinute);
    this.github = new GitHubAccess({ secrets: this.secrets, budget: this.budget, grants: () => this.state.secretGrants, now: this.now, ghToken: options.ghToken ?? readGhToken,
      transport: () => this.options.githubTransport, ownPorts: options.ownPorts, resolve: options.resolve });
    this.definitions = new TriggerDefinitions(this.store, this.secrets, this.now, id => this.options.executor.session(id));
    // The ports look their target up when called, so the order these are built in does not matter.
    this.polls = new TriggerPolls(this.store, this.github, this.now, { requestTick: () => { void this.engine.tick().catch(() => {}); }, send: (request, usable) => this.send(request, usable) });
    this.dispatch = new TriggerDispatch(this.store, options.executor, this.now, { isHeld: () => this.engine.isHeld(), githubClient: (id, fresh) => this.githubClient(id, fresh), sharing: options.sharing });
    this.engine = new TriggerEngine(this.store, this.polls, this.dispatch, this.budget, this.now, options.tickMs ?? 1000);
  }

  /** Called by the worker's existing parked startup continuation before start(). */
  bootstrapStorage(update: () => Promise<StorageUpdateInput>): Promise<void> { return this.store.bootstrapStorage(update); }
  resolveStorage(): Promise<'committed' | 'not-committed'> { return this.store.resolveStorage(); }

  /**
   * `restore`: a backup's triggers and settings, applied before anything fires (see `restoreFrom`). Answers what of it
   * could not be applied.
   */
  async start(options: { restore?: TriggerBackup } = {}): Promise<{ errors: string[] }> {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    await this.store.load(loaded => TriggerDispatch.recoverLoaded(loaded, this.options.executor));
    await this.secrets.load();
    const errors = options.restore ? await restoreFrom(options.restore, this.restoreContext()).catch(error => {
      // A failed restore save must hold admission; a later settle cannot stand in for its receipt.
      if (this.store.problem) throw error;
      return [`트리거를 복원하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`];
    }) : [];
    await this.store.mutate({ type: 'maintenance' },() => undefined, 'settle');
    this.engine.markStarted();
    this.resume();
    return { errors };
  }

  /**
   * Makes a backup's triggers the definitions here, the way the owner's own edits would (see restore.ts), on an engine
   * that is already running: the owner's restore after the secret Vault was imported.
   */
  restoreBackup(backup: TriggerBackup): Promise<void> { return restoreOwnerBackup(backup, { ...this.restoreContext(), started: this.engine.isStarted() }); }
  private restoreContext() { return { store: this.store, secrets: this.secrets, definitions: this.definitions, now: this.now }; }

  // ---- Reading ----------------------------------------------------------------------------------

  list(query: { includeArchived?: boolean } = {}): Trigger[] { return listTriggers(this.state, query); }
  get(id: string) { return getTrigger(this.state, id); }
  /**
   * Runs newest first. `beforeId` pages by position in history, so runs recorded at the same moment are never
   * skipped; `before` is a time and applies when that run is no longer kept.
   */
  events(query: { triggerId?: string; before?: string; beforeId?: string; limit?: number } = {}): TriggerEvent[] { return eventsPage(this.state, query); }
  /** One run, whether or not its trigger still exists. */
  event(id: string): TriggerEvent { return oneEvent(this.state, id); }
  audit(query: { before?: string; limit?: number } = {}): TriggerAuditEntry[] { return auditPage(this.state, query); }
  deleted(): Trigger[] { return deletedTriggers(this.state); }
  /** Every copy kept, read at once: current triggers, deleted ones (newest first), and earlier revisions of both. */
  kept(): { triggers: Trigger[]; deleted: Trigger[]; revisions: Record<string, Trigger[]> } { return keptCopies(this.state); }
  overview(): TriggerOverview {
    return overviewOf(this.state, { slack: this.options.slack?.(), publicAgents: this.options.publicAgents?.() ?? [], problem: this.store.overviewProblem(this.secrets.problem) });
  }
  /**
   * Asked right before a trigger's run starts. A trigger deleted or turned off since the run fired starts
   * nothing, even if it was turned on again in between.
   */
  launchAllowed(triggerId: string, eventId: string | undefined): boolean { return launchAllowed(this.state, triggerId, eventId); }

  // ---- Changing definitions (see definitions.ts) ------------------------------------------------------

  create(value: unknown, actor: TriggerActor, scope?: TriggerScope): Promise<Trigger> { return this.definitions.create(value, actor, scope); }
  update(id: string, value: unknown, expectedRevision: number, actor: TriggerActor, scope?: TriggerScope): Promise<Trigger> { return this.definitions.update(id, value, expectedRevision, actor, scope); }
  setEnabled(id: string, enabled: boolean, expectedRevision: number, actor: TriggerActor, scope?: TriggerScope): Promise<Trigger> { return this.definitions.setEnabled(id, enabled, expectedRevision, actor, scope); }
  setArchived(id: string, archived: boolean, expectedRevision: number, actor: TriggerActor, scope?: TriggerScope): Promise<Trigger> { return this.definitions.setArchived(id, archived, expectedRevision, actor, scope); }
  /** Returns what was deleted. */
  remove(id: string, expectedRevision: number, actor: TriggerActor, scope?: TriggerScope): Promise<Trigger> { return this.definitions.remove(id, expectedRevision, actor, scope); }
  /** A revert is a new revision that copies an earlier one; history is never rewritten. */
  revert(id: string, revision: number, expectedRevision: number, actor: TriggerActor, scope?: TriggerScope): Promise<Trigger> { return this.definitions.revert(id, revision, expectedRevision, actor, scope); }
  restore(id: string, actor: TriggerActor, scope?: TriggerScope): Promise<Trigger> { return this.definitions.restore(id, actor, scope); }
  async updateSettings(value: unknown, actor: TriggerActor): Promise<TriggerSettings> {
    const saved = await this.definitions.updateSettings(value, actor);
    this.emit('settings', saved);
    return saved;
  }
  /** Slack keeps its own files; its changes still appear in the shared audit log. */
  recordSlack(actor: TriggerActor, slackId: string, summary: string): Promise<void> { return this.definitions.recordSlack(actor, slackId, summary); }
  createSecret(input: SecretInput, actor: TriggerActor): Promise<TriggerSecret> { return this.definitions.createSecret(input, actor); }
  deleteSecret(id: string, actor: TriggerActor): Promise<void> { return this.definitions.deleteSecret(id, actor); }

  /** Sends a request once for the owner to see; nothing is recorded, no run starts and no trigger changes. */
  async testHttp(request: HttpRequest, condition: HttpCondition | undefined, actor: TriggerActor): Promise<HttpTestResult> {
    if (actor.kind !== 'owner') throw failure('Only the owner can test requests.', 'forbidden');
    return testResult(await this.send(request, secret => secret.origin === new URL(request.url).origin), condition);
  }
  /** Shows the owner which account a connection acts as. Nothing is recorded. */
  checkGitHub(auth: GitHubAuth, actor: TriggerActor): Promise<GitHubCheck> { return this.github.check(auth, actor); }
  /**
   * GitHub access for a trigger's coordinator conversation: the trigger's own credentials (also after it is
   * deleted, while it can be restored), and only while they still act as the trigger's account.
   */
  githubClient(triggerId: string, fresh = false, beforeSend?: () => Promise<void>): Promise<GitHubFetch> {
    return this.github.clientFor(this.githubTrigger(triggerId), fresh, beforeSend);
  }
  private githubTrigger(id:string) { return this.state.triggers.find(item=>item.id===id) ?? [...this.state.tombstones].reverse().find(item=>item.id===id); }
  githubSource(id:string) { return this.githubTrigger(id)?.source; }
  private send(request: HttpRequest, usable: (secret: StoredSecret) => boolean): Promise<HttpOutcome> {
    return sendRequest(request, usable, { secrets: this.secrets, budget: this.budget, privateHosts: () => this.state.settings.privateHosts, ownPorts: this.options.ownPorts, resolve: this.options.resolve });
  }

  /** Stops firing and dispatching without discarding anything, for a worker handoff. */
  pause(): void { this.engine.pause(); }
  resume(): void { this.engine.resume(); }
  close(): void { this.engine.pause(); }
  /** New scheduled times are left for the successor worker; its catch-up runs them. */
  hold(): void { this.engine.hold(); }
  /** A forced update that gave up: scheduled times fire here again. */
  release(): void { this.engine.release(); }
  tick(): Promise<void> { return this.engine.tick(); }

  /**
   * Fires once now, under the trigger's usual overlap and hourly limits. An HTTP trigger sends its request
   * first and runs with that response whatever its condition says; what later polls compare against stays as it was.
   */
  run(id: string, actor: TriggerActor, scope?: TriggerScope): Promise<TriggerEvent> { return this.polls.run(id, actor, scope); }
  /**
   * The open issues an issue watch would work on, in its order, and where each stands for the saved trigger `id`:
   * what it took, what a run has now, and what a watch starting from now leaves. Only reads GitHub.
   */
  previewIssues(source: Extract<TriggerSource, { kind: 'github' }>, id: string | undefined, actor: TriggerActor, scope?: TriggerScope): Promise<IssuePreview> { return this.polls.previewIssues(source, id, actor, scope); }
  /** Waits for requests in flight and their saves, so the state lock is released only after the last write. */
  async settle(): Promise<void> {
    await Promise.allSettled([this.polls.waitAll(), this.dispatch.closing()]);
    await this.store.idle();
  }

  hasActive(): boolean { return this.state.triggers.some(trigger => trigger.enabled) || this.state.events.some(event => UNFINISHED.has(event.status)); }
  /** Work a handoff must wait for: a tick, a save, or a claim whose submission is not yet recorded. */
  inFlight(): boolean { return this.engine.isTicking() || Boolean(this.dispatch.closing()) || this.store.pending() > 0 || this.polls.size() > 0 || this.state.events.some(event => event.status === 'claimed'); }
  /** Saves again; a locked engine never saves, and a handoff must not wait on it. */
  flush(): Promise<void> { return this.store.flush(); }
  /** Authoritative owner DTO; absence of the legacy file is irrelevant under SQL authority. */
  async backup(): Promise<TriggerBackup> {
    await this.store.idle();
    if (!this.engine.isStarted()) throw failure('Trigger engine is not ready for a backup.','unavailable');
    if (this.store.problem) throw failure(this.store.problem,'unavailable');
    return triggerBackupOf(JSON.parse(serializeState(this.state)))!;
  }
  settings(): TriggerSettings { return structuredClone(this.state.settings); }
  preview(schedule: Schedule): string[] { return previewSlots(schedule, this.now()); }

  // ---- Secrets and request tests -------------------------------------------------------------------

  secretList(): TriggerSecret[] {
    return this.secrets.list().map(secret => ({ ...secret, triggerIds: [...(this.state.secretGrants[secret.id] ?? [])] }));
  }
}
