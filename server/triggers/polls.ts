import { randomUUID } from 'node:crypto';
import type { HttpRequest, IssuePreview, IssuePreviewItem, Trigger, TriggerActor, TriggerAuditEntry, TriggerEvent, TriggerPolicy, TriggerSource } from '../../shared/triggers.js';
import { logTrigger } from './audit.js';
import { hereOnly, seen, type TriggerScope } from './definitions.js';
import { failure } from './errors.js';
import { fire } from './firing.js';
import { checkGitHub, GitHubError, keyOf, noted, passed, readIssues, type GitHubCursor, type GitHubIssue } from './github.js';
import type { GitHubAccess } from './github-access.js';
import { keptGitHub } from './github-cursor.js';
import { evaluate, type HttpOutcome } from './http.js';
import { nextSlot } from './schedule.js';
import type { StoredSecret } from './secrets.js';
import { UNFINISHED, type Cursor, type EngineState } from './state.js';
import type { TriggerStore } from './store.js';
import { issueRef, responsePayload, responseSummary } from './text.js';

const MAX_PREVIEW = 100;

export interface PollPorts {
  /** A run now asks the engine for a tick, which dispatches it. */
  requestTick(): void;
  /** Sends a request with the secrets `usable` allows (see outbound.ts). */
  send(request: HttpRequest, usable: (secret: StoredSecret) => boolean): Promise<HttpOutcome>;
}

/**
 * The checks a trigger makes: HTTP polls and GitHub checks, scheduled or asked for now, and the owner's manual runs.
 * Owns the one-at-a-time lock per trigger, held from before a claim is saved until its result is.
 */
export class TriggerPolls {
  private readonly polling = new Map<string, Promise<void>>();
  constructor(private readonly store: TriggerStore, private readonly github: GitHubAccess, private readonly now: () => number, private readonly ports: PollPorts) {}

  has(id: string): boolean { return this.polling.has(id); }
  size(): number { return this.polling.size; }
  /** Waits for every request in flight and its save. */
  waitAll(): Promise<unknown> { return Promise.allSettled([...this.polling.values()]); }

  private trigger(id: string): Trigger {
    const trigger = this.store.state.triggers.find(item => item.id === id);
    if (!trigger) throw failure('Trigger not found.', 'not-found');
    return trigger;
  }
  /** Fires inside a commit; a capacity warning it answers is noted in that same commit. */
  private fire(state: EngineState, trigger: Trigger, dedupKey: string, at: number, kind: TriggerEvent['kind'], by?: TriggerActor, overlap?: TriggerPolicy['overlap']): TriggerEvent | undefined {
    const { event, capacity } = fire(state, trigger, dedupKey, at, kind, this.now, by, overlap);
    if (capacity) this.store.noteCapacity(capacity);
    return event;
  }
  private log(state: EngineState, actor: TriggerActor, action: TriggerAuditEntry['action'], trigger: Trigger, fromRevision: number | undefined, toRevision: number | undefined, summary: string): void {
    logTrigger(state, this.now, actor, action, trigger, fromRevision, toRevision, summary);
  }

  /**
   * Fires once now, under the trigger's usual overlap and hourly limits. An HTTP trigger sends its request
   * first and runs with that response whatever its condition says; what later polls compare against stays as it was.
   */
  async run(id: string, actor: TriggerActor, scope?: TriggerScope): Promise<TriggerEvent> {
    const trigger = this.trigger(id);
    if (!seen(trigger, scope)) throw failure('Trigger not found.', 'not-found');
    hereOnly(trigger, scope);
    if (this.store.state.onceConsumed[id]) throw failure('This once reservation was consumed. Create a new reservation to retry.', 'conflict');
    if (trigger.archivedAt) throw failure('Unarchive this trigger before running it.', 'conflict');
    if (this.store.full()) throw failure('Trigger history is full. Delete old triggers or wait for finished runs to expire.', 'storage-full');
    if (trigger.source.kind === 'github') {
      if (!trigger.enabled) throw failure('Turn the trigger on before checking it.', 'conflict');
      const blocked = this.store.state.cursors[id]?.blockedUntil;
      if (blocked && blocked > this.now()) throw failure(`GitHub's rate limit allows the next check at ${new Date(blocked).toISOString()}.`, 'rate-limited');
      const unlock = this.lock(id);
      if (!unlock) throw failure('This trigger is checking GitHub right now. Try again in a moment.', 'conflict');
      let fired: TriggerEvent[];
      const first = this.store.state.cursors[id]?.github?.checkedAt === undefined;
      try {
        await this.store.mutate({ type: 'cursor', id },state => { const position = state.cursors[id]; if (position) position.polling = { slot: this.now(), revision: trigger.revision, method: 'GET' }; }, 'settle');
        fired = await this.pollGitHub(trigger, this.now(), actor);
      } finally { unlock(); }
      const problem = this.store.state.cursors[id]?.lastError;
      const watch = trigger.source.watch;
      const full = watch.type === 'issues' && this.unfinished(id) >= watch.concurrency;
      const hour = this.now() - 60 * 60 * 1000;
      const limited = watch.type === 'issues' && this.store.state.recentFires.filter(item => item.triggerId === id && item.at > hour).length >= trigger.policy.maxEventsPerHour;
      const noted = watch.type === 'issues' && watch.start === 'new' && first && !problem;
      if (!fired.length) throw failure(full ? 'Every place of this trigger is taken; the next issue is taken when a run ends.'
        : problem ? `GitHub could not be checked: ${problem}`
        : limited ? 'This trigger reached its runs for this hour; the next issue is taken when the hour allows.'
        : noted ? 'Checked GitHub and noted the issues already open; issues that appear from now on will run.'
        : 'Checked GitHub: nothing new since the last check.', problem && !full ? 'upstream' : 'conflict');
      this.ports.requestTick();
      return structuredClone(fired[0]);
    }
    const event = trigger.source.kind === 'http' ? await this.runHttp(trigger, actor) : await this.store.mutate({ type: 'fire', id },state => {
      const current = state.triggers.find(item => item.id === id);
      if (!current || !seen(current, scope)) throw failure('Trigger not found.', 'not-found');
      hereOnly(current, scope);
      if (state.onceConsumed[id]) throw failure('This once reservation was consumed. Create a new reservation to retry.', 'conflict');
      if (current.archivedAt) throw failure('Unarchive this trigger before running it.', 'conflict');
      if (current.source.schedule.type === 'once' && !current.enabled) throw failure('Turn the once reservation on before running it.', 'conflict');
      const created = this.fire(state, current, `manual:${randomUUID()}`, this.now(), 'manual', actor);
      this.log(state, actor, 'run', current, current.revision, current.revision, `Ran now: ${created?.status ?? 'skipped'}`);
      return created;
    });
    if (!event) throw failure(`${trigger.name} did not run.`, 'conflict');
    this.ports.requestTick();
    return structuredClone(event);
  }

  /**
   * Sends the request under the same one-at-a-time lock and saved claim as scheduled requests. Once a POST may
   * have gone out, every failure says so, and an agent's retry with the same requestKey does not send it again.
   */
  private async runHttp(trigger: Trigger, actor: TriggerActor): Promise<TriggerEvent | undefined> {
    if (trigger.source.kind !== 'http') return undefined;
    const id = trigger.id;
    const method = trigger.source.request.method;
    // A turned-off trigger's run would never start, so its request is not sent either.
    if (!trigger.enabled) throw failure('Turn the trigger on before running it.', 'conflict');
    // A run that limits would skip is refused before anything is sent. Tried on a copy, so nothing is recorded.
    // The probe's capacity warning is dropped: it records nothing.
    const probe = fire(structuredClone(this.store.state), trigger, `manual:${randomUUID()}`, this.now(), 'manual', this.now, actor).event;
    if (!probe || probe.status === 'skipped') throw failure(`Nothing was sent: ${probe?.reason ?? 'this trigger cannot record more runs right now.'}`, 'conflict');
    const unlock = this.lock(id);
    if (!unlock) throw failure('This trigger is sending its request right now. Try again in a moment.', 'conflict');
    let sent = false;
    const uncertain = (error: unknown) => Object.assign(error instanceof Error ? error : new Error(String(error)), { uncertain: true,
      message: `${error instanceof Error ? error.message : String(error)} The POST was sent, or may have been; it will not be sent again for this request.` });
    try {
      await this.store.mutate({ type: 'cursor', id },state => {
        const position = state.cursors[id];
        if (position) position.polling = { slot: this.now(), revision: trigger.revision, method };
      }, 'settle');
      const outcome = await this.request(trigger);
      sent = method === 'POST' && (outcome.ok || outcome.uncertain);
      const unclaim = (state: EngineState) => { const position = state.cursors[id]; if (position) delete position.polling; };
      if (!outcome.ok) {
        await this.store.mutate({ type: 'cursor', id },unclaim, 'settle').catch(() => {});
        throw failure(`The request failed, so nothing ran: ${outcome.error}`, 'upstream');
      }
      return await this.store.mutate({ type: 'fire', id },state => {
        unclaim(state);
        const current = state.triggers.find(item => item.id === id);
        if (!current) throw failure('Trigger not found.', 'not-found');
        if (current.revision !== trigger.revision) throw failure('The trigger changed while its request was sent, so nothing ran.', 'conflict');
        const created = this.fire(state, current, `manual:${randomUUID()}`, this.now(), 'manual', actor);
        if (!created) throw failure(`${current.name} could not record this run.`, 'conflict');
        created.payload = responsePayload(current, outcome); created.summary = `Run now · ${responseSummary(outcome, undefined)}`;
        this.log(state, actor, 'run', current, current.revision, current.revision, `Ran now: ${created?.status ?? 'skipped'}`);
        return created;
      }).catch(async error => {
        await this.store.mutate({ type: 'cursor', id },unclaim, 'settle').catch(() => {});
        throw error;
      });
    } catch (error) {
      throw sent ? uncertain(error) : error;
    } finally {
      unlock();
    }
  }

  /**
   * The open issues an issue watch would work on, in its order, and where each stands for the saved trigger `id`:
   * what it took, what a run has now, and what a watch starting from now leaves. Only reads GitHub.
   */
  async previewIssues(source: Extract<TriggerSource, { kind: 'github' }>, id: string | undefined, actor: TriggerActor, scope?: TriggerScope): Promise<IssuePreview> {
    const watch = source.watch;
    if (watch.type !== 'issues') throw failure('Only issue watches have a preview.');
    if (source.auth.type === 'token' && actor.kind !== 'owner') throw failure('Only the owner can preview with a saved token.', 'forbidden');
    const saved = id ? this.store.state.triggers.find(item => item.id === id) : undefined;
    if (id && (!saved || !seen(saved, scope))) throw failure('Trigger not found.', 'not-found');
    let read;
    try {
      const { fetch, identity } = await this.github.fetchFor(source.auth);
      const login = await this.github.login(fetch, identity);
      if (login.toLowerCase() !== source.account.toLowerCase()) throw new GitHubError(`GitHub is signed in as ${login}, not ${source.account}.`);
      read = await readIssues(watch, fetch, source.account);
    } catch (error) { throw failure(error instanceof Error ? error.message : String(error), 'upstream'); }
    // What the saved trigger remembers counts while it is on; an edit is judged as saving it would.
    const cursor = saved?.enabled ? keptGitHub(saved, { ...saved, source }, this.store.state.cursors[saved.id]) ?? {} : {};
    const working = new Set(saved ? this.store.state.events.filter(event => event.triggerId === saved.id && UNFINISHED.has(event.status)).flatMap(event => { const ref = issueRef(event); return ref ? [keyOf(ref)] : []; }) : []);
    const handled = new Set(cursor.handled ?? []);
    const left = new Set([...watch.start === 'new' ? cursor.skipped ?? [] : [], ...noted(watch, cursor, read.issues)]);
    let position = 0;
    const issues: IssuePreviewItem[] = read.issues.map(issue => {
      const key = keyOf(issue);
      const status: IssuePreviewItem['status'] = working.has(key) ? 'working' : handled.has(key) ? 'taken' : left.has(key) ? 'existing' : 'next';
      return { repository: issue.repository, number: issue.number, title: issue.title, url: issue.url, labels: issue.labels, assignees: issue.assignees, createdAt: issue.createdAt, status,
        ...(status === 'next' ? { position: ++position } : {}) };
    });
    const counts = { next: 0, working: 0, taken: 0, existing: 0 };
    for (const issue of issues) counts[issue.status]++;
    return { issues: issues.slice(0, MAX_PREVIEW), total: issues.length, counts };
  }

  /** One request at a time per trigger. Taken before anything is awaited; only its holder releases it. */
  lock(id: string): (() => void) | undefined {
    if (this.polling.has(id)) return undefined;
    let done = () => {};
    const held = new Promise<void>(resolve => { done = resolve; });
    this.polling.set(id, held);
    return () => { if (this.polling.get(id) === held) this.polling.delete(id); done(); };
  }

  /** One HTTP poll at a time per trigger; handoff waits for polls in flight. */
  startPoll(triggerId: string, slot: number, revision: number, unlock: () => void): void {
    void this.poll(triggerId, slot, revision).catch(() => {}).finally(unlock);
  }

  private async poll(triggerId: string, slot: number, revision: number): Promise<void> {
    const trigger = this.store.state.triggers.find(item => item.id === triggerId);
    if (trigger?.source.kind === 'github' && trigger.revision === revision) { await this.pollGitHub(trigger, slot); return; }
    if (!trigger || trigger.source.kind !== 'http' || trigger.revision !== revision) return;
    const outcome = await this.request(trigger);
    await this.store.mutate({ type: 'fire', id: triggerId },state => {
      const current = state.triggers.find(item => item.id === triggerId);
      const position = state.cursors[triggerId];
      if (!position) return;
      delete position.polling;
      // A response to an older definition never updates what the current one compares against.
      if (!current || current.revision !== revision || current.source.kind !== 'http') return;
      if (!outcome.ok) { this.pollFailed(position, current, outcome.uncertain ? `${outcome.error} The POST may have reached the server; it was not sent again.` : outcome.error); return; }
      const result = evaluate(current.source.condition, outcome, position.observed);
      if (result.error) { this.pollFailed(position, current, result.error); return; }
      position.failures = 0; delete position.lastError;
      position.observed = result.state;
      if (!result.fire) return;
      const event = this.fire(state, current, new Date(slot).toISOString(), slot, 'http');
      if (event) { event.payload = responsePayload(current, outcome, result.selected); event.summary = responseSummary(outcome, result.selected); }
    }).catch(() => this.store.mutate({ type: 'cursor', id: triggerId },state => {
      // The result could not be recorded (history full): the claim is still released, so it is not reported as cut off.
      const position = state.cursors[triggerId];
      if (position?.polling?.slot === slot) delete position.polling;
    }, 'settle').catch(() => {}));
  }

  /** Repeated failures back off, up to half an hour, instead of hammering a broken endpoint. */
  private pollFailed(position: Cursor, trigger: Trigger, error: string, notBefore?: number): void {
    position.failures = (position.failures ?? 0) + 1;
    position.lastError = error.slice(0, 500);
    const retry = Math.max(this.now() + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(position.failures - 1, 5)), notBefore ?? 0);
    if (position.nextAt !== undefined && position.nextAt < retry) position.nextAt = nextSlot(trigger.source.schedule, retry, position.anchorAt);
  }

  // ---- GitHub ---------------------------------------------------------------------------------------

  /**
   * Checks GitHub once and records what is new. The first check only remembers what is there. A check that
   * does not finish changes nothing, so the next one looks at the same range again.
   */
  private async pollGitHub(trigger: Trigger, slot: number, manual?: TriggerActor): Promise<TriggerEvent[]> {
    if (trigger.source.kind !== 'github') return [];
    const source = trigger.source;
    let result: { issues: GitHubIssue[]; cursor: GitHubCursor } | undefined;
    let problem: { message: string; retryAt?: number } | undefined;
    // Working through open issues: while every place is taken, there is nothing to ask GitHub.
    if (source.watch.type === 'issues' && this.unfinished(trigger.id) >= source.watch.concurrency) {
      return this.store.mutate({ type: 'cursor', id: trigger.id },state => { const position = state.cursors[trigger.id]; if (position?.polling?.slot === slot) delete position.polling; return []; }, 'settle').catch(() => []);
    }
    try {
      const { fetch, identity } = await this.github.fetchFor(source.auth, trigger.id);
      const login = await this.github.login(fetch, identity);
      if (login.toLowerCase() !== source.account.toLowerCase()) throw new GitHubError(`GitHub is signed in as ${login}, not ${source.account}; this trigger stopped checking until the account is set again.`);
      result = await checkGitHub(source.watch, this.store.state.cursors[trigger.id]?.github ?? {}, fetch, source.account, this.now());
    } catch (error) { problem = { message: error instanceof Error ? error.message : String(error), ...((error as GitHubError).retryAt ? { retryAt: (error as GitHubError).retryAt } : {}) }; }
    return this.store.mutate({ type: 'fire', id: trigger.id },state => {
      const current = state.triggers.find(item => item.id === trigger.id);
      const position = state.cursors[trigger.id];
      if (!position) return [];
      delete position.polling;
      if (!current || current.revision !== trigger.revision || current.source.kind !== 'github') return [];
      if (!result) {
        this.pollFailed(position, current, problem?.message ?? 'GitHub could not be checked.', problem?.retryAt);
        if (problem?.retryAt) position.blockedUntil = problem.retryAt;
        return [];
      }
      const baseline = !position.github;
      position.github = result.cursor;
      position.failures = 0; delete position.lastError; delete position.blockedUntil;
      const fired: TriggerEvent[] = [];
      if (source.watch.type === 'issues') {
        const watch = source.watch;
        const handled = new Set(result.cursor.handled ?? []);
        const passedOver = passed(watch, result.cursor);
        // An issue still being worked on is never taken twice, even after the remembered list was reset.
        const working = new Set(state.events.filter(item => item.triggerId === current.id && UNFINISHED.has(item.status)).flatMap(item => { const ref = issueRef(item); return ref ? [keyOf(ref)] : []; }));
        const now = this.now();
        const hourly = state.recentFires.filter(item => item.at > now - 60 * 60 * 1000);
        // Waiting for room, never pausing: the next issue is taken when a run ends or the hour allows it.
        let room = Math.min(watch.concurrency - state.events.filter(item => item.triggerId === current.id && UNFINISHED.has(item.status)).length,
          current.policy.maxEventsPerHour - hourly.filter(item => item.triggerId === current.id).length, state.settings.maxEventsPerHour - hourly.length);
        for (const issue of result.issues) {
          if (room <= 0) break;
          const key = keyOf(issue);
          if (passedOver.has(key) || working.has(key)) continue;
          const dedup = `issue:${issue.repository}#${issue.number}:${slot}`;
          const event = this.fire(state, current, manual ? `manual:${randomUUID()}:${dedup}` : dedup, slot, manual ? 'manual' : 'github', manual, watch.concurrency > 1 ? 'parallel' : 'skip');
          if (!event) break;
          event.payload = issue;
          if (event.input.issue) Object.assign(event.input.issue, { repository: issue.repository, number: issue.number });
          event.summary = `${issue.repository}#${issue.number} ${issue.title}`.slice(0, 200);
          fired.push(event);
          // Only an issue that is really waiting to run counts as taken; one refused by a limit is tried next time.
          if (event.status !== 'queued') break;
          handled.add(key);
          room--;
        }
        position.github = { ...result.cursor, handled: [...handled] };
        if (manual) this.log(state, manual, 'run', current, current.revision, current.revision, `Checked GitHub now: ${fired.length} issue${fired.length === 1 ? '' : 's'} taken`);
        return structuredClone(fired);
      }
      for (const issue of result.issues) {
        const key = `review:${issue.repository}#${issue.number}:${slot}`;
        const event = this.fire(state, current, manual ? `manual:${randomUUID()}:${key}` : key, slot, manual ? 'manual' : 'github', manual);
        if (!event) continue;
        event.payload = issue;
        event.summary = `${issue.repository}#${issue.number} ${issue.title}`.slice(0, 200);
        fired.push(event);
      }
      if (manual) this.log(state, manual, 'run', current, current.revision, current.revision, baseline ? 'Checked GitHub and noted the current issues' : `Checked GitHub now: ${fired.length} new`);
      return structuredClone(fired);
    }).catch(() => this.store.mutate({ type: 'cursor', id: trigger.id },state => { const position = state.cursors[trigger.id]; if (position?.polling?.slot === slot) delete position.polling; return []; }, 'settle').catch(() => []));
  }

  /** A trigger's request, with only the secrets the owner gave this trigger. */
  private request(trigger: Trigger): Promise<HttpOutcome> {
    if (trigger.source.kind !== 'http') return Promise.resolve({ ok: false, error: 'Not an HTTP trigger.', uncertain: false });
    return this.ports.send(trigger.source.request, secret => (this.store.state.secretGrants[secret.id] ?? []).includes(trigger.id));
  }

  private unfinished(triggerId: string): number {
    return this.store.state.events.filter(event => event.triggerId === triggerId && UNFINISHED.has(event.status)).length;
  }
}
