import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { OPERATIONS, REMOTE_PAGE_OPERATIONS, isOperationName, type OperationName } from '../../shared/api/operations.js';
import type { TriggerActor, TriggerEvent, TriggerInput } from '../../shared/triggers.js';
import type { AutoPromptJob, AutoPromptRequest, ChatMessage, Run, RunOrigin, Session } from '../../shared/types.js';
import type { SlackWorkflow } from '../../shared/slack.js';
import type { RunAdmission } from '../runs/manager.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import type { TriggerScope, TriggerService } from '../triggers/service.js';
import { remoteRequestTime } from '../remote/request-ledger.js';
import { remoteJob, remoteJobVisible, type RemoteScope } from '../remote/visibility.js';
import { eventPaths, handlerPaths, RemoteView, type KeptTriggers } from './remote-view.js';

const failure = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });
const REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REQUESTS = 1000;
const MAX_RESULT_BYTES = 8 * 1024;
const SUCCEEDED = { done: true, note: 'This request succeeded. Read the current state for details.' } as const;

export interface TowerServices {
  stateDir: string;
  triggers: TriggerService;
  sessions?: { list(): Session[]; read(id: string, limit: number): Promise<ChatMessage[] | undefined> };
  runs?: { list(): Run[] };
  projects?: () => Array<{ cwd: string; title: string; sessions: number; pinned: boolean }>;
  autoPrompts?: { submit(request: AutoPromptRequest, internal: Pick<RunAdmission, 'origin'>): Promise<AutoPromptJob>; get(id: string): AutoPromptJob | undefined };
  github?: { workflow(sessionId: string): SlackWorkflow | undefined; approveReply(workflowId: string, requestKey: string, text: string): Promise<unknown> };
  /** What this computer keeps from controlling computers, with these folders' real locations resolved again now. */
  remote?: (paths: string[]) => Promise<RemoteScope>;
}
/** What this computer holds, read at once, so the look taken after judges exactly what an answer shows. */
interface Held { kept: KeptTriggers; sessions: Session[] }

/**
 * Operations a controlling computer may use, for the owner there or an agent in a turn started there. Secrets,
 * trigger limits, HTTP tests and GitHub replies stay with this computer's own Tower.
 */
const REMOTE_OPERATIONS: ReadonlySet<string> = new Set([...REMOTE_PAGE_OPERATIONS, 'sessions.list', 'sessions.read', 'projects.list', 'runs.list', 'autoPrompt.submit', 'autoPrompt.get']);
interface RequestRecord { at: number; fingerprint: string; status: 'pending' | 'done'; result?: unknown }

/**
 * The single entry point for Tower operations in the worker. Callers never choose their own actor:
 * the transport that authenticated them does, and owner-only operations check it here.
 */
export class TowerApi {
  private requests?: Map<string, RequestRecord>;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly services: TowerServices) {}

  /**
   * An agent names each creating call with a `requestKey`. The same key with the same input returns the
   * first result; a call whose outcome was not recorded is reported as uncertain rather than repeated.
   */
  async call(name: unknown, input: unknown, actor: TriggerActor, requestKey?: string): Promise<unknown> {
    const answer = await this.answer(name, input, actor, requestKey);
    // A controlling computer's answer is judged by what this computer shares now, a retry's recorded answer too.
    return actor.controllerId && isOperationName(name) ? this.shown(name, OPERATIONS[name].input.parse(input ?? {}) as Record<string, any>, answer, actor) : answer;
  }

  private async answer(name: unknown, input: unknown, actor: TriggerActor, requestKey?: string): Promise<unknown> {
    if (!isOperationName(name)) throw failure('Unknown Tower operation.', 404);
    const operation = OPERATIONS[name];
    if ('ownerOnly' in operation && operation.ownerOnly && actor.kind !== 'owner') throw failure('Only the owner can do this in Tower.', 403);
    if (actor.controllerId && !REMOTE_OPERATIONS.has(name)) throw failure('This is done in Tower on that computer itself.', 403);
    if (actor.kind === 'agent' && !('agent' in operation && operation.agent)) throw failure('Agents cannot use this Tower operation.', 403);
    const parsed = operation.input.safeParse(input ?? {});
    if (!parsed.success) throw failure(`Invalid request: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')}`, 400);
    // Changes from agents, and from controlling computers, are made once per request.
    if ((actor.kind !== 'agent' && !actor.controllerId) || !operation.write) return this.perform(name, parsed.data as Record<string, any>, actor);
    // An Auto Prompt request is known by its requestId everywhere; other changes by the calling run's requestKey.
    const keyField = 'keyField' in operation ? operation.keyField : undefined;
    const ownKey = keyField ? (parsed.data as Record<string, string>)[keyField] : requestKey;
    if (typeof ownKey !== 'string' || !/^[\w.:-]{1,100}$/.test(ownKey)) throw failure('This operation needs a requestKey (1–100 letters, digits, dot, colon, dash or underscore). Reuse the same key to retry the same request.', 400);
    // A controlling computer's request older than the ledger keeps is refused, never run a second time.
    const remoteOwner = actor.kind === 'owner' && Boolean(actor.controllerId);
    if (remoteOwner && !((remoteRequestTime(ownKey) ?? 0) > Date.now() - REQUEST_RETENTION_MS + 60 * 60_000)) throw Object.assign(failure('This request is too old to send again. Nothing was done.', 409), { disposition: 'not-admitted' });
    const caller = actor.kind === 'owner' && actor.controllerId ? `remote:${actor.controllerId}` : actor.runId ?? actor.sessionId ?? '';
    const key = keyField ? `${name}\n${ownKey.toLowerCase()}` : `${caller}\n${ownKey}`;
    const fingerprint = createHash('sha256').update(JSON.stringify([name, parsed.data])).digest('hex');
    const requests = await this.ledger();
    const previous = requests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw failure('This requestKey was already used for a different request. Use a new key for a new request.', 409);
      if (previous.status === 'done') return previous.result;
      throw remoteOwner ? Object.assign(failure('It is not known whether this request was carried out, so it was not sent again. Check the triggers before trying again.', 409), { disposition: 'uncertain' })
        : failure('An earlier call with this requestKey may or may not have completed. It was not repeated; list triggers to check before trying again with a new key.', 409);
    }
    this.expire();
    // Records within the retention period are never dropped for space: a full ledger refuses new changes instead.
    if (requests.size >= MAX_REQUESTS) throw remoteOwner ? Object.assign(failure('Too many changes reached this computer from other computers and agents in the last 7 days to keep track of retries. Nothing was done; make this change in Tower on that computer itself.', 429), { disposition: 'not-admitted' })
      : failure('Agents made too many changes in the last 7 days to keep track of retries. Ask the owner to make this change in Tower.', 429);
    // Claimed before acting, so a lost reply is never repeated under the same key.
    requests.set(key, { at: Date.now(), fingerprint, status: 'pending' });
    try { await this.save(); }
    catch (error) { requests.delete(key); throw error; }
    let result: unknown;
    // Operations fail before changing anything (validation, a refused save), so a failure frees the key, unless
    // the failure says something may already have happened outside Tower (a sent POST): then the key stays taken.
    try { result = await this.perform(name, parsed.data as Record<string, any>, actor); }
    catch (error) {
      if (!(error as { uncertain?: boolean }).uncertain) { requests.delete(key); await this.save().catch(() => {}); }
      throw error;
    }
    // A large result is not kept whole; a retry then learns the request succeeded, and what it made or changed.
    const kept = Buffer.byteLength(JSON.stringify(result) ?? '') <= MAX_RESULT_BYTES ? result : reference(result);
    requests.set(key, { at: Date.now(), fingerprint, status: 'done', result: kept });
    await this.save().catch(() => {});
    return result;
  }

  /** What this computer holds right now, read at once. */
  private held(): Held { return { kept: this.services.triggers.kept(), sessions: this.services.sessions?.list() ?? [] }; }

  /** How a controlling computer sees what was `held`: every folder it names, and `extra` ones, resolved again now. */
  private async view(held: Held, extra: string[] = []): Promise<RemoteView> {
    const { remote } = this.services;
    if (!remote) throw failure('Remote requests are unavailable.', 503);
    const { kept, sessions } = held;
    const paths = [...kept.triggers, ...kept.deleted, ...Object.values(kept.revisions).flat()].flatMap(trigger => handlerPaths(trigger.handler))
      .concat(sessions.map(session => session.cwd), extra);
    return new RemoteView(await remote(paths), sessions, kept);
  }

  private async perform(name: OperationName, value: Record<string, any>, actor: TriggerActor): Promise<unknown> {
    if (!actor.controllerId) return this.performLocal(name, value, actor);
    // What a controlling computer reads is gathered when it is answered, after the latest look (see `shown`).
    if (!OPERATIONS[name].write) return undefined;
    if (!name.startsWith('triggers.')) return this.performLocal(name, value, actor);
    // A change is judged by a fresh look at every folder it names. What it cannot see reads exactly as absent, and it
    // cannot aim a trigger at it (see TriggerScope).
    const input = value.trigger as TriggerInput | undefined;
    return this.performLocal(name, value, actor, await this.view(this.held(), input ? handlerPaths(input.handler) : []));
  }

  /**
   * A controlling computer's answer, from what this computer holds right now, read at once and judged by a fresh look
   * taken after it was read: nothing that points into a folder kept out of sharing or at a conversation it does not
   * show, and no coordinator conversation. Lists are filtered before they are paged. A change that was made is never
   * answered as not found, even if what it made can no longer be seen.
   */
  private async shown(name: OperationName, value: Record<string, any>, answer: unknown, actor: TriggerActor): Promise<unknown> {
    const { triggers, runs, autoPrompts } = this.services;
    if (name === 'sessions.read') {
      // Judged before anything is read from it, and again after.
      if (!(await this.view(this.held())).sessions.has(value.id)) throw failure('Session not found.', 404);
      const read = await this.performLocal(name, value, actor).catch(() => { throw failure('Session not found.', 404); });
      if (!(await this.view(this.held())).sessions.has(value.id)) throw failure('Session not found.', 404);
      return read;
    }
    if (name === 'triggers.preview' || name === 'triggers.settings') return this.performLocal(name, value, actor);
    if (name === 'triggers.delete') return answer;
    // Everything an answer shows is read here, before the look that judges it.
    const held = this.held();
    const find = (id: string | undefined) => { try { return id ? triggers.event(id) : undefined; } catch { return undefined; } };
    const pathsOf = (list: Array<TriggerEvent | undefined>) => list.flatMap(event => event ? eventPaths(event.input) : []);
    const events = (view: RemoteView, list: TriggerEvent[]) => list.filter(event => view.event(event)).map(event => view.shownEvent(event));
    const trigger = (view: RemoteView, id: string | undefined) => { const found = held.kept.triggers.find(item => item.id === id); return found && view.handler(found.handler) ? view.trigger(found) : undefined; };
    const limit = Math.min(Math.max(value.limit ?? 50, 1), 200);
    switch (name) {
      case 'sessions.list': {
        const view = await this.view(held);
        return { sessions: sessionList(held.sessions.filter(session => view.sessions.has(session.id)), value) };
      }
      case 'projects.list': {
        const projects = this.services.projects?.() ?? [];
        const view = await this.view(held, projects.map(project => project.cwd));
        // Counted again from the conversations it can see.
        const counts = new Map<string, number>();
        for (const session of held.sessions) if (view.sessions.has(session.id) && !session.isSubagent && !session.launchedByAgent) counts.set(session.cwd, (counts.get(session.cwd) ?? 0) + 1);
        return { projects: projects.filter(project => view.folder(project.cwd) && (counts.has(project.cwd) || project.pinned)).map(project => ({ ...project, sessions: counts.get(project.cwd) ?? 0 })) };
      }
      case 'runs.list': {
        if (!runs) throw failure('Runs are unavailable.', 503);
        const list = runs.list();
        const view = await this.view(held);
        return { runs: runList(list.filter(run => view.sessions.has(run.sessionId)), value).map(run => ({ ...run, ...(run.origin ? { origin: { kind: run.origin.kind, ...(run.origin.controllerId ? { controllerId: run.origin.controllerId } : {}) } } : {}) })) };
      }
      case 'autoPrompt.get': case 'autoPrompt.submit': {
        const job = autoPrompts?.get(value.requestId);
        const view = await this.view(held, job ? [job.cwd, job.decision?.cwd].filter((path): path is string => Boolean(path)) : []);
        if (job && remoteJobVisible(job, view.scope, view.sessions, actor.controllerId)) return { job: remoteJob(job, actor.controllerId, view.scope.matcher.revision) };
        if (name === 'autoPrompt.submit') return SUCCEEDED;
        throw failure('Auto Prompt request not found.', 404);
      }
      case 'triggers.list': {
        const overview = triggers.overview();
        const found = new Map([...overview.triggers.flatMap(summary => summary.lastEvent ? [summary.lastEvent.id] : []), ...overview.recent.map(event => event.id), ...(overview.updated ?? []).map(event => event.id)]
          .map(id => [id, find(id)]));
        const view = await this.view(held, pathsOf([...found.values()]));
        return { triggers: held.kept.triggers.filter(item => view.handler(item.handler)).map(item => view.trigger(item)), overview: view.overview(overview, id => found.get(id)) };
      }
      case 'triggers.get': {
        const found = triggers.get(value.id);
        const view = await this.view(held, pathsOf(found.events));
        const shown = trigger(view, value.id);
        if (!shown) throw failure('Trigger not found.', 404);
        return { trigger: shown, revisions: found.revisions.filter(revision => view.handler(revision.handler)).map(revision => view.trigger(revision)), events: events(view, found.events) };
      }
      case 'triggers.events': {
        // Every run kept that matches, so runs it cannot see never leave a page empty.
        const all: TriggerEvent[] = [];
        let cursor: { before?: string; beforeId?: string } = { ...(value.before ? { before: value.before } : {}), ...(value.beforeId ? { beforeId: value.beforeId } : {}) };
        for (let pages = 0; pages < 10; pages++) {
          const page = triggers.events({ ...value, ...cursor, limit: 200 });
          all.push(...page);
          if (page.length < 200) break;
          cursor = { beforeId: page.at(-1)!.id, before: page.at(-1)!.receivedAt };
        }
        const view = await this.view(held, pathsOf(all));
        return { events: events(view, all).slice(0, limit) };
      }
      case 'triggers.event': {
        const found = find(value.id);
        const view = await this.view(held, pathsOf([found]));
        if (!found || !view.event(found)) throw failure('This run is no longer in trigger history.', 404);
        return { event: view.shownEvent(found) };
      }
      case 'triggers.audit': {
        const entries = triggers.audit({ ...(value.before ? { before: value.before } : {}), limit: 1000 });
        const view = await this.view(held);
        return { audit: entries.filter(entry => view.audit(entry)).slice(0, limit).map(entry => ({ ...entry, actor: view.actor(entry.actor) })) };
      }
      case 'triggers.deleted': {
        const view = await this.view(held);
        return { triggers: held.kept.deleted.filter(item => view.handler(item.handler)).map(item => view.trigger(item)) };
      }
      case 'secrets.list': {
        const secrets = triggers.secretList();
        const view = await this.view(held);
        return { secrets: secrets.map(secret => view.secret(secret)) };
      }
      case 'triggers.create': case 'triggers.update': case 'triggers.setEnabled': case 'triggers.restore': case 'triggers.revert': {
        const view = await this.view(held);
        const shown = trigger(view, (answer as { trigger?: { id?: string } }).trigger?.id);
        return shown ? { trigger: shown } : SUCCEEDED;
      }
      case 'triggers.run': {
        const found = find((answer as { event?: { id?: string } }).event?.id);
        const view = await this.view(held, pathsOf([found]));
        return found && view.event(found) ? { event: view.shownEvent(found) } : SUCCEEDED;
      }
      default: throw failure('This is done in Tower on that computer itself.', 403);
    }
  }

  private async performLocal(name: OperationName, value: Record<string, any>, actor: TriggerActor, scope?: TriggerScope): Promise<unknown> {
    const { triggers, sessions, runs, autoPrompts } = this.services;
    switch (name) {
      case 'sessions.list': {
        if (!sessions) throw failure('Sessions are unavailable.', 503);
        return { sessions: sessionList(sessions.list(), value) };
      }
      case 'sessions.read': {
        if (!sessions) throw failure('Sessions are unavailable.', 503);
        const messages = await sessions.read(value.id, value.limit ?? 20);
        if (!messages) throw failure('Session not found.', 404);
        return { messages: messages.map(message => ({ role: message.role, text: message.text.slice(0, 4000), timestamp: message.timestamp, ...(message.toolName ? { toolName: message.toolName } : {}) })) };
      }
      case 'projects.list': {
        if (!this.services.projects) throw failure('Projects are unavailable.', 503);
        return { projects: this.services.projects() };
      }
      case 'runs.list': {
        if (!runs) throw failure('Runs are unavailable.', 503);
        return { runs: runList(runs.list(), value) };
      }
      case 'autoPrompt.submit': {
        if (!autoPrompts) throw failure('Auto Prompt is unavailable.', 503);
        // Work an agent starts is the agent's, never the owner's: it gets no Tower tools and no owner approval.
        // Work started from a controlling computer, directly or by an agent there, keeps that computer.
        const from = actor.controllerId ? { controllerId: actor.controllerId } : {};
        const origin: RunOrigin = actor.kind === 'agent' ? { kind: 'agent', ...(actor.runId ? { runId: actor.runId } : {}), ...from } : { kind: 'owner', ...from };
        return { job: await autoPrompts.submit({ requestId: value.requestId, provider: value.provider, prompt: value.prompt, ...(value.cwd ? { cwd: value.cwd } : {}),
          ...(value.model ? { model: value.model } : {}), ...(value.effort ? { effort: value.effort } : {}) }, { origin }) };
      }
      case 'autoPrompt.get': {
        const job = autoPrompts?.get(value.requestId);
        if (!job) throw failure('Auto Prompt request not found.', 404);
        return { job };
      }
      case 'triggers.list': return { triggers: triggers.list(), overview: triggers.overview() };
      case 'triggers.get': return triggers.get(value.id);
      case 'triggers.events': return { events: triggers.events(value) };
      case 'triggers.event': return { event: triggers.event(value.id) };
      case 'triggers.audit': return { audit: triggers.audit(value) };
      case 'triggers.deleted': return { triggers: triggers.deleted() };
      case 'triggers.preview': return { runs: triggers.preview(value.schedule) };
      case 'triggers.create': return { trigger: await triggers.create(value.trigger, actor, scope) };
      case 'triggers.update': return { trigger: await triggers.update(value.id, value.trigger, value.expectedRevision, actor, scope) };
      case 'triggers.setEnabled': return { trigger: await triggers.setEnabled(value.id, value.enabled, value.expectedRevision, actor, scope) };
      case 'triggers.delete': { const removed = await triggers.remove(value.id, value.expectedRevision, actor, scope); return { deleted: true, trigger: { id: removed.id, name: removed.name } }; }
      case 'triggers.restore': return { trigger: await triggers.restore(value.id, actor, scope) };
      case 'triggers.revert': return { trigger: await triggers.revert(value.id, value.revision, value.expectedRevision, actor, scope) };
      case 'triggers.run': return { event: await triggers.run(value.id, actor, scope) };
      case 'triggers.settings': return { settings: triggers.settings() };
      case 'triggers.updateSettings': return { settings: await triggers.updateSettings(value.settings, actor) };
      case 'triggers.testHttp': return { result: await triggers.testHttp(value.request, value.condition, actor) };
      case 'triggers.checkGitHub': return { result: await triggers.checkGitHub(value.auth, actor) };
      case 'secrets.list': return { secrets: triggers.secretList() };
      case 'github.conversation': {
        const workflow = this.services.github?.workflow(value.sessionId);
        if (!workflow) throw failure('This session is not a GitHub coordinator conversation.', 404);
        return { conversation: { id: workflow.id, status: workflow.status, repository: workflow.mention.channel, issue: Number(workflow.mention.threadTs), replies: workflow.replies ?? [],
          ...(workflow.ownerConditionalReply ? { permission: workflow.ownerConditionalReply } : {}), ...(workflow.error ? { error: workflow.error } : {}) } };
      }
      case 'github.approveReply': {
        if (!this.services.github) throw failure('GitHub conversations are unavailable.', 503);
        return { reply: await this.services.github.approveReply(value.workflowId, value.requestKey, value.text) };
      }
      case 'secrets.create': return { secret: await triggers.createSecret(value.secret, actor) };
      case 'secrets.delete': await triggers.deleteSecret(value.id, actor); return { deleted: true };
    }
  }

  private get path() { return join(this.services.stateDir, 'tower-api-requests.json'); }
  private async ledger(): Promise<Map<string, RequestRecord>> {
    if (this.requests) return this.requests;
    const requests = new Map<string, RequestRecord>();
    try {
      const saved = await readPrivateJson(this.path);
      if (Array.isArray(saved)) for (const entry of saved) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] && typeof entry[1] === 'object') requests.set(entry[0], entry[1] as RequestRecord);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return this.requests ??= requests;
  }
  private expire(): void {
    for (const [key, record] of this.requests!) if (record.at < Date.now() - REQUEST_RETENTION_MS) this.requests!.delete(key);
  }
  private save(): Promise<void> {
    this.expire();
    const data = JSON.stringify([...this.requests!]);
    const write = this.writes.catch(() => {}).then(() => writePrivateJson(this.path, data));
    this.writes = write;
    return write;
  }
}

/** What is kept of a result too large to keep whole: that it succeeded, and what it made or changed. */
function reference(result: unknown) {
  const { trigger, event, job } = (result ?? {}) as { trigger?: { id?: unknown }; event?: { id?: unknown }; job?: { id?: unknown } };
  return { ...SUCCEEDED, ...(typeof trigger?.id === 'string' ? { trigger: { id: trigger.id } } : {}), ...(typeof event?.id === 'string' ? { event: { id: event.id } } : {}),
    ...(typeof job?.id === 'string' ? { job: { id: job.id } } : {}) };
}

/** Conversations as Tower's tools list them, newest first. */
function sessionList(sessions: Session[], value: Record<string, any>) {
  return sessions.filter(session => !session.isSubagent && (!value.provider || session.provider === value.provider) && (!value.cwd || session.cwd === value.cwd))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, value.limit ?? 50)
    .map(session => ({ id: session.id, title: session.customTitle || session.title, provider: session.provider, cwd: session.cwd, status: session.status,
      updatedAt: session.updatedAt, lastMessage: session.lastMessage.slice(0, 300), ...(session.launchedBy ? { launchedBy: session.launchedBy } : {}) }));
}
/** Runs as Tower's tools list them, newest first. */
function runList(runs: Run[], value: Record<string, any>) {
  return runs.filter(run => !value.sessionId || run.sessionId === value.sessionId).slice(-(value.limit ?? 20)).reverse()
    .map(run => ({ id: run.id, sessionId: run.sessionId, status: run.status, createdAt: run.createdAt, finishedAt: run.finishedAt, origin: run.origin,
      prompt: run.prompt.slice(0, 500), output: run.output.slice(-2000), ...(run.error ? { error: run.error } : {}) }));
}
