import { admissionUncertain } from '../runs/run-records.js';
import { continuedRun, continuedRunById } from '../runs/continuations.js';
import type { TriggerEvent } from '../../shared/triggers.js';
import { refused, GitHubError, type GitHubFetch } from './github.js';
import { handEvent, type HandoverContext, type TriggerExecutor } from './handover.js';
import { ACTIVE, UNFINISHED, type EngineState } from './state.js';
import type { TriggerStore } from './store.js';
import { asksToKeepOpen, issueRef } from './text.js';

const CLOSE_TRIES = 5;
const CLOSE_RETRY_MS = 5 * 60_000;

export interface DispatchPorts {
  /** Whether a forced update holds new work back; read for each event, as it may change meanwhile. */
  isHeld(): boolean;
  /** GitHub as a trigger's account, for assigning and closing its issues. */
  githubClient(triggerId: string, fresh: boolean): Promise<GitHubFetch>;
  sharing?: HandoverContext['sharing'];
}

/** Claims matched to what the executor admitted: running, queued again (a coordinator's), or uncertain; never submitted again. */
export function reconcile(state: EngineState, include: (event: TriggerEvent) => boolean, executor: Pick<TriggerExecutor, 'runs' | 'getAutoPrompt'>): void {
  const runs = executor.runs();
  for (const event of state.events) {
    if (event.status !== 'claimed' || !include(event)) continue;
    // Handing an event to its coordinator is idempotent, so an unfinished hand-over is simply done again.
    if (event.input.handler === 'coordinator') { Object.assign(event, { status: 'queued', claimedAt: undefined }); continue; }
    const job = executor.getAutoPrompt(event.requestId);
    const run = runs.find(item => item.autoPromptId === event.requestId);
    if (job || run) Object.assign(event, { status: 'running', dispatch: { ...(run ? { runId: run.id, sessionId: run.sessionId } : {}) } });
    else Object.assign(event, { status: 'uncertain', error: 'Tower stopped while submitting this run. It was not submitted again; check before running it manually.' });
  }
}

/**
 * Hands queued runs over to project agents and follows them to their end: claims are saved before anything is
 * submitted, outcomes recorded in the order runs were submitted, open issues assigned and closed. Owns the claims being
 * submitted right now and the close retries, so a claim cut off is reconciled, never submitted again.
 */
export class TriggerDispatch {
  /** Claims this process is submitting right now; any other claim is reconciled, never resubmitted. */
  private readonly submitting = new Set<string>();
  /** Closes that failed in a way that may pass, by event: how often, and not again before `at`. */
  private readonly closeRetries = new Map<string, { tries: number; at: number }>();
  /** Open-issues runs' issues being closed now, one pass at a time. */
  private closingIssues?: Promise<void>;

  constructor(private readonly store: TriggerStore, private readonly executor: TriggerExecutor, private readonly now: () => number, private readonly ports: DispatchPorts) {}

  /**
   * Prepares a loaded state before it becomes current: claims saved before a stop are matched to what was admitted,
   * and a request cut off by a stop is not sent again for its time (a POST is reported, since it may have arrived).
   */
  static recoverLoaded(state: EngineState, executor: Pick<TriggerExecutor, 'runs' | 'getAutoPrompt'>): void {
    reconcile(state, () => true, executor);
    for (const position of Object.values(state.cursors)) {
      if (!position.polling) continue;
      if (position.polling.method === 'POST') position.lastError = 'Tower stopped while a POST was being sent. It may have reached the server and was not sent again.';
      delete position.polling;
    }
  }

  /**
   * A claim whose outcome could not be saved is matched to what was admitted, never submitted again. Undefined when
   * there is none, so a tick goes on without yielding, as it always did.
   */
  reconcileOrphans(): Promise<void> | undefined {
    if (!this.store.state.events.some(event => event.status === 'claimed' && !this.submitting.has(event.id))) return undefined;
    return this.store.commit(state => { reconcile(state, event => !this.submitting.has(event.id), this.executor); }, 'settle').catch(() => {});
  }

  /** Closing issues talks to GitHub; it goes on beside the tick so a slow answer never holds up other triggers. */
  startClosing(): void {
    if (!this.closingIssues) this.closingIssues = this.closeIssues().catch(() => {}).finally(() => { this.closingIssues = undefined; });
  }

  /** The close pass under way, if any. */
  closing(): Promise<void> | undefined { return this.closingIssues; }

  async dispatch(): Promise<void> {
    for (;;) {
      const active = this.store.state.events.filter(event => ACTIVE.has(event.status)).length;
      if (active >= this.store.state.settings.maxConcurrentRuns) return;
      const next = this.store.state.events.find(event => event.status === 'queued' && this.ready(event));
      if (!next) return;
      // The claim is saved before anything is submitted; if the result is lost it is never submitted again.
      const claimed = await this.store.commit(state => {
        const event = state.events.find(item => item.id === next.id);
        if (!event || event.status !== 'queued') return undefined;
        Object.assign(event, { status: 'claimed', claimedAt: new Date(this.now()).toISOString(), updatedAt: new Date(this.now()).toISOString() });
        return structuredClone(event);
      }, 'settle').catch(() => undefined);
      if (!claimed) return;
      this.submitting.add(claimed.id);
      try {
        let outcome: Partial<TriggerEvent>;
        try { outcome = await this.submit(claimed); }
        catch (error) { outcome = { status: admissionUncertain(error) ? 'uncertain' : 'error', error: (error instanceof Error ? error.message : String(error)).slice(0, 1500) }; }
        await this.store.commit(state => {
          const event = state.events.find(item => item.id === claimed.id);
          // Atomic admission may already have linked the run in SQL before its response was lost.
          if (event?.status === 'claimed' && event.requestId === claimed.requestId) { Object.assign(event, outcome, { updatedAt: new Date(this.now()).toISOString() }); this.handFailed(state, event); }
        }, 'settle').catch(() => {});
      } finally { this.submitting.delete(claimed.id); }
    }
  }

  /** Overlap `queue` waits for the previous run; `parallel` does not. */
  private ready(event: TriggerEvent): boolean {
    // The policy in force when it fired decides, not a later edit.
    if ((event.input.overlap ?? 'skip') === 'parallel') return true;
    return !this.store.state.events.some(item => item.triggerId === event.triggerId && item.id !== event.id && ACTIVE.has(item.status));
  }

  private async submit(event: TriggerEvent): Promise<Partial<TriggerEvent>> {
    const outcome = await handEvent(event, { executor: this.executor, sharing: this.ports.sharing, trustedFolders: () => this.store.state.trustedFolders,admissionLink: id => this.store.admissionLink(id) });
    // Assigned only once the run really started, so an issue nobody works on is not left assigned.
    const assigned = event.input.issue?.assign && outcome.status === 'running' ? await this.assignIssue(event) : undefined;
    return assigned ? { ...outcome, issueActions: assigned } : outcome;
  }

  /**
   * An open issue whose run could not even start pauses its trigger: taking the next one would fail the same way
   * and use up the queue. Turning the trigger on again takes the open issues again.
   */
  private handFailed(state: EngineState, event: TriggerEvent): void {
    if (!event.input.issue || event.status !== 'error') return;
    const position = state.cursors[event.triggerId];
    if (!position || position.paused) return;
    const reason = `Paused: the run for an issue could not start (${(event.error ?? 'unknown error').slice(0, 300)}). Turn the trigger on again to go on.`;
    position.paused = { reason, at: new Date(this.now()).toISOString() };
  }

  /** An open issue is assigned to the trigger's account as its run starts; a failure is noted and the run goes on. */
  private async assignIssue(event: TriggerEvent): Promise<NonNullable<TriggerEvent['issueActions']>> {
    const issue = issueRef(event);
    if (!issue || !event.input.issue) return { assignError: 'The event does not name an issue.' };
    try {
      const fetch = await this.ports.githubClient(event.triggerId, true);
      const response = await fetch(`/repos/${issue.repository}/issues/${issue.number}/assignees`, undefined, { method: 'POST', body: { assignees: [event.input.issue.account] } });
      refused(response);
      if (response.status < 200 || response.status > 299) return { assignError: `Assigning the issue failed: GitHub answered HTTP ${response.status}.` };
      return { assignedAt: new Date(this.now()).toISOString() };
    } catch (error) { return { assignError: `Assigning the issue failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) }; }
  }

  /** Once an open issue's run ends, the next check comes now instead of at the next scheduled time. */
  private nextIssue(state: EngineState, event: TriggerEvent): void {
    if (!event.input.issue || UNFINISHED.has(event.status)) return;
    const trigger = state.triggers.find(item => item.id === event.triggerId);
    const position = state.cursors[event.triggerId];
    // Only while the trigger still works through open issues, and never ahead of a failed check's back-off.
    if (trigger?.source.kind !== 'github' || trigger.source.watch.type !== 'issues' || !position || position.failures) return;
    if (position.nextAt !== undefined && !position.paused) position.nextAt = Math.min(position.nextAt, this.now());
  }

  /**
   * A completed open-issues run closes its issue unless its report asks to keep it open. Closing an issue twice does
   * no harm, so one cut off by a restart is simply sent again; one that failed is not.
   */
  private async closeIssues(): Promise<void> {
    const due = this.store.state.events.filter(event => event.status === 'completed' && event.input.issue?.close
      && !event.issueActions?.closedAt && !event.issueActions?.closeError && !event.issueActions?.keptOpen && (this.closeRetries.get(event.id)?.at ?? 0) <= this.now());
    for (const event of due) {
      if (this.ports.isHeld() || this.store.problem) return;
      const runs = this.executor.runs();
      // A turn that scheduled its own continuation goes on in that run: its last run's report decides.
      let run = runs.find(item => item.id === event.dispatch?.runId);
      for (let next = run; next; next = runs.find(item => item.scheduled?.afterRunId === run!.id)) run = next;
      if (run && (run.status === 'queued' || run.status === 'running')) continue;
      const issue = issueRef(event);
      let result: NonNullable<TriggerEvent['issueActions']>;
      if (!run) result = { keptOpen: true, keptReason: 'The run record is no longer available, so the issue was left open.' };
      else if (run.status !== 'completed') result = { keptOpen: true, keptReason: 'The run did not complete, so the issue was left open.' };
      else if (asksToKeepOpen(run.output)) result = { keptOpen: true, keptReason: 'The run asked to keep the issue open.' };
      else if (!issue) result = { closeError: 'The event does not name an issue.' };
      else {
        try {
          const fetch = await this.ports.githubClient(event.triggerId, true);
          const response = await fetch(`/repos/${issue.repository}/issues/${issue.number}`, undefined, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
          refused(response);
          if (response.status >= 200 && response.status <= 299) result = { closedAt: new Date(this.now()).toISOString() };
          else if (response.status >= 500 || response.status === 429 || response.status === 403) throw new GitHubError(`GitHub answered HTTP ${response.status}.`);
          else result = { closeError: `Closing the issue failed: GitHub answered HTTP ${response.status}.` };
        } catch (error) {
          // A failure that may pass (rate limits, the request budget, the network, GitHub's own errors) is tried again
          // a few times, a few minutes apart, before it is recorded.
          const message = `Closing the issue failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
          const tries = (this.closeRetries.get(event.id)?.tries ?? 0) + 1;
          if (tries < CLOSE_TRIES) { this.closeRetries.set(event.id, { tries, at: this.now() + CLOSE_RETRY_MS }); continue; }
          result = { closeError: message };
        }
        this.closeRetries.delete(event.id);
      }
      await this.store.commit(state => {
        const saved = state.events.find(item => item.id === event.id);
        if (saved) { saved.issueActions = { ...saved.issueActions, ...result }; saved.updatedAt = new Date(this.now()).toISOString(); }
      }, 'settle').catch(() => {});
    }
  }

  /** Follows each submitted run to its end. Missing records are reported as uncertain, never resubmitted. */
  async track(): Promise<void> {
    const runs = this.executor.runs();
    const updates = new Map<string, Partial<TriggerEvent>>();
    for (const event of this.store.state.events) {
      if (event.status !== 'running') continue;
      if (event.dispatch?.workflowId) {
        // A coordinator event follows its conversation: done when the coordinator's turn is.
        const conversation = this.executor.coordination?.(event.dispatch.workflowId);
        const patch: Partial<TriggerEvent> = {};
        if (conversation?.sessionId && event.dispatch.sessionId !== conversation.sessionId) {
          patch.dispatch = { ...event.dispatch, sessionId: conversation.sessionId, createdSessionId: conversation.sessionId, ...(conversation.runId ? { runId: conversation.runId } : {}) };
        }
        if (!conversation) Object.assign(patch, { status: 'uncertain', error: 'The coordinator conversation record is no longer available.' });
        else if (conversation.status === 'uncertain') Object.assign(patch, { status: 'uncertain', error: conversation.error ?? 'Run admission receipt is unresolved; this event was not resent.' });
        else if (conversation.status === 'completed') patch.status = 'completed';
        else if (conversation.status === 'error') Object.assign(patch, { status: 'error', ...(conversation.error ? { error: conversation.error.slice(0, 1500) } : {}) });
        if (Object.keys(patch).length) updates.set(event.id, patch);
        continue;
      }
      const job = event.input.target.mode === 'auto' ? this.executor.getAutoPrompt(event.requestId) : undefined;
      if (job?.status === 'uncertain') { updates.set(event.id, { status: 'uncertain',error: job.error }); continue; }
      // A turn a forced worker update ended goes on in Tower's continuation; the event follows it.
      const run = continuedRunById(runs, event.dispatch?.runId ?? job?.runId) ?? continuedRun(runs, runs.find(item => item.autoPromptId === event.requestId));
      const patch: Partial<TriggerEvent> = {};
      // A queued continuation is not recorded yet: it is removed again when the turn turns out to have finished itself.
      if (run && !(run.status === 'queued' && run.scheduled?.resume === 'update') && event.dispatch?.runId !== run.id) patch.dispatch = { ...event.dispatch, runId: run.id, sessionId: run.sessionId };
      if (job?.decision?.action === 'create' && job.sessionId && !event.dispatch?.createdSessionId) patch.dispatch = { ...event.dispatch, ...patch.dispatch, createdSessionId: job.sessionId };
      if (job && (job.status === 'error' || job.status === 'cancelled') && !run) Object.assign(patch, { status: job.status === 'error' ? 'error' : 'cancelled', error: job.error });
      else if (run?.status === 'completed') patch.status = 'completed';
      else if (run?.status === 'error') Object.assign(patch, { status: 'error', error: run.error });
      else if (run?.status === 'cancelled') Object.assign(patch, { status: 'cancelled', ...(run.error ? { error: run.error } : {}) });
      else if (!run && !job && event.input.target.mode !== 'auto') Object.assign(patch, { status: 'uncertain', error: 'The run record is no longer available; the outcome could not be confirmed.' });
      else if (!run && !job) Object.assign(patch, { status: 'uncertain', error: 'The routing record is no longer available; the outcome could not be confirmed.' });
      if (Object.keys(patch).length) updates.set(event.id, patch);
    }
    if (!updates.size) return;
    await this.store.commit(state => {
      for (const event of state.events) {
        const patch = updates.get(event.id);
        if (patch && event.status === 'running') { Object.assign(event, patch, { updatedAt: new Date(this.now()).toISOString() }); this.nextIssue(state, event); }
      }
    }, 'settle').catch(() => {});
  }
}
