import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { OPERATIONS, isOperationName, type OperationName } from '../../shared/api/operations.js';
import type { TriggerActor } from '../../shared/triggers.js';
import type { AutoPromptJob, AutoPromptRequest, ChatMessage, Run, RunOrigin, Session } from '../../shared/types.js';
import type { RunAdmission } from '../runs/manager.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import type { TriggerService } from '../triggers/service.js';

const failure = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });
const REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REQUESTS = 1000;
const MAX_RESULT_BYTES = 8 * 1024;

export interface TowerServices {
  stateDir: string;
  triggers: TriggerService;
  sessions?: { list(): Session[]; read(id: string, limit: number): Promise<ChatMessage[] | undefined> };
  runs?: { list(): Run[] };
  projects?: () => Array<{ cwd: string; title: string; sessions: number; pinned: boolean }>;
  autoPrompts?: { submit(request: AutoPromptRequest, internal: Pick<RunAdmission, 'origin'>): Promise<AutoPromptJob>; get(id: string): AutoPromptJob | undefined };
}
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
    if (!isOperationName(name)) throw failure('Unknown Tower operation.', 404);
    const operation = OPERATIONS[name];
    if ('ownerOnly' in operation && operation.ownerOnly && actor.kind !== 'owner') throw failure('Only the owner can do this in Tower.', 403);
    if (actor.kind === 'agent' && !('agent' in operation && operation.agent)) throw failure('Agents cannot use this Tower operation.', 403);
    const parsed = operation.input.safeParse(input ?? {});
    if (!parsed.success) throw failure(`Invalid request: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')}`, 400);
    if (actor.kind !== 'agent' || !operation.write) return this.perform(name, parsed.data as Record<string, any>, actor);
    // An Auto Prompt request is known by its requestId everywhere; other changes by the calling run's requestKey.
    const keyField = 'keyField' in operation ? operation.keyField : undefined;
    const ownKey = keyField ? (parsed.data as Record<string, string>)[keyField] : requestKey;
    if (typeof ownKey !== 'string' || !/^[\w.:-]{1,100}$/.test(ownKey)) throw failure('This operation needs a requestKey (1–100 letters, digits, dot, colon, dash or underscore). Reuse the same key to retry the same request.', 400);
    const key = keyField ? `${name}\n${ownKey.toLowerCase()}` : `${actor.runId ?? actor.sessionId ?? ''}\n${ownKey}`;
    const fingerprint = createHash('sha256').update(JSON.stringify([name, parsed.data])).digest('hex');
    const requests = await this.ledger();
    const previous = requests.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw failure('This requestKey was already used for a different request. Use a new key for a new request.', 409);
      if (previous.status === 'done') return previous.result;
      throw failure('An earlier call with this requestKey may or may not have completed. It was not repeated; list triggers to check before trying again with a new key.', 409);
    }
    this.expire();
    // Records within the retention period are never dropped for space: a full ledger refuses new changes instead.
    if (requests.size >= MAX_REQUESTS) throw failure('Agents made too many changes in the last 7 days to keep track of retries. Ask the owner to make this change in Tower.', 429);
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
    // A large result is not kept whole; a retry then learns the request succeeded and reads the details again.
    const kept = Buffer.byteLength(JSON.stringify(result) ?? '') <= MAX_RESULT_BYTES ? result : { done: true, note: 'This request already succeeded. Read the current state for details.' };
    requests.set(key, { at: Date.now(), fingerprint, status: 'done', result: kept });
    await this.save().catch(() => {});
    return result;
  }

  private async perform(name: OperationName, value: Record<string, any>, actor: TriggerActor): Promise<unknown> {
    const { triggers, sessions, runs, autoPrompts } = this.services;
    switch (name) {
      case 'sessions.list': {
        if (!sessions) throw failure('Sessions are unavailable.', 503);
        const list = sessions.list().filter(session => !session.isSubagent && (!value.provider || session.provider === value.provider) && (!value.cwd || session.cwd === value.cwd))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, value.limit ?? 50);
        return { sessions: list.map(session => ({ id: session.id, title: session.customTitle || session.title, provider: session.provider, cwd: session.cwd, status: session.status,
          updatedAt: session.updatedAt, lastMessage: session.lastMessage.slice(0, 300), ...(session.launchedBy ? { launchedBy: session.launchedBy } : {}) })) };
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
        const list = runs.list().filter(run => !value.sessionId || run.sessionId === value.sessionId).slice(-(value.limit ?? 20)).reverse();
        return { runs: list.map(run => ({ id: run.id, sessionId: run.sessionId, status: run.status, createdAt: run.createdAt, finishedAt: run.finishedAt, origin: run.origin,
          prompt: run.prompt.slice(0, 500), output: run.output.slice(-2000), ...(run.error ? { error: run.error } : {}) })) };
      }
      case 'autoPrompt.submit': {
        if (!autoPrompts) throw failure('Auto Prompt is unavailable.', 503);
        // Work an agent starts is the agent's, never the owner's: it gets no Tower tools and no owner approval.
        const origin: RunOrigin = actor.kind === 'agent' ? { kind: 'agent', ...(actor.runId ? { runId: actor.runId } : {}) } : { kind: 'owner' };
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
      case 'triggers.audit': return { audit: triggers.audit(value) };
      case 'triggers.deleted': return { triggers: triggers.deleted() };
      case 'triggers.preview': return { runs: triggers.preview(value.schedule) };
      case 'triggers.create': return { trigger: await triggers.create(value.trigger, actor) };
      case 'triggers.update': return { trigger: await triggers.update(value.id, value.trigger, value.expectedRevision, actor) };
      case 'triggers.setEnabled': return { trigger: await triggers.setEnabled(value.id, value.enabled, value.expectedRevision, actor) };
      case 'triggers.delete': await triggers.remove(value.id, value.expectedRevision, actor); return { deleted: true };
      case 'triggers.restore': return { trigger: await triggers.restore(value.id, actor) };
      case 'triggers.revert': return { trigger: await triggers.revert(value.id, value.revision, value.expectedRevision, actor) };
      case 'triggers.run': return { event: await triggers.run(value.id, actor) };
      case 'triggers.settings': return { settings: triggers.settings() };
      case 'triggers.updateSettings': return { settings: await triggers.updateSettings(value.settings, actor) };
      case 'triggers.testHttp': return { result: await triggers.testHttp(value.request, value.condition, actor) };
      case 'secrets.list': return { secrets: triggers.secretList() };
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
