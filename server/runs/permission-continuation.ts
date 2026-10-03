import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import type { PermissionRequest } from '../../shared/permissions.js';
import { TOWER_NOTICE } from '../../shared/task-notification.js';
import type { Run, Session } from '../../shared/types.js';
import { FINISHED, finishedTime, RunError } from './run-records.js';

export interface PermissionHost {
  /** The manager's runs: read, and added to by a decision. */
  readonly runs: Map<string, Run>;
  readonly events: EventEmitter;
  getSession(id: string): Session | undefined;
  supersede(run: Run, reason: string): void;
  steer(runId: string, options: { targetRunId?: string }): Promise<Run>;
  changed(): void;
  flush(): Promise<void>;
  pump(): void;
  stopping(): boolean;
  /** A notice being saved is not offered for insertion by anyone else. */
  admit(runId: string): void;
  unadmit(runId: string): void;
  /** Latest native user record, read afresh; never inferred from activity timestamps. */
  latestUserMessage(sessionId: string): Promise<{ text: string; timestamp: string } | undefined> | undefined;
  shown(run: Run): Run;
}

/**
 * A decision about an agent's permission request, carried to its turn: an approval continues the work in a fresh
 * provider turn after the requesting one ends (never an insert), and a refusal is told to the running turn. Every
 * continuation keeps durable receipts of the requests it answers.
 */
export class PermissionContinuations {
  private readonly deliveries = new Map<string, Promise<Run>>();
  constructor(private readonly host: PermissionHost) {}

  /** The requesting turn's own native task outcome says its goal is done, inside that exact provider turn. */
  private goalFinished(target: Run | undefined): boolean {
    if (!target || target.status !== 'completed' || !target.finishedAt) return false;
    const session = this.host.getSession(target.sessionId);
    return session?.outcome === 'done' && !!session.lastRequestAt
      && Date.parse(session.lastRequestAt) >= Date.parse(target.startedAt ?? target.createdAt)
      && Date.parse(session.lastRequestAt) <= Date.parse(target.finishedAt) && Date.parse(session.updatedAt) >= Date.parse(target.finishedAt);
  }

  private async checkUserMessage(run: Run): Promise<void> {
    const observed = this.host.getSession(run.sessionId)?.lastRequestAt;
    let latest: { text: string; timestamp: string } | undefined;
    try { latest = await this.host.latestUserMessage(run.sessionId); }
    catch { if (run.status === 'queued') this.host.supersede(run, 'The latest native user instruction could not be verified.'); return; }
    if (run.status !== 'queued') return;
    if (this.goalFinished(this.host.runs.get(run.scheduled!.afterRunId))) {
      this.host.supersede(run, 'The requesting turn already completed the task.'); return;
    }
    const recorded = this.host.getSession(run.sessionId)?.lastRequestAt ?? observed;
    const newest = Math.max(Date.parse(recorded ?? '') || 0, Date.parse(latest?.timestamp ?? '') || 0);
    if (newest <= Date.parse(run.permissionRequestedAt ?? run.createdAt)) return;
    const ownNotice = latest && Date.parse(latest.timestamp) === newest && [...this.host.runs.values()].some(notice =>
      notice.sessionId === run.sessionId && notice.steering?.state === 'delivered' && notice.steering.targetRunId === run.scheduled!.afterRunId
      && (notice.permissionNotice?.targetRunId === run.scheduled!.afterRunId || notice.updateWrapUp)
      && notice.prompt === latest.text);
    if (!ownNotice) this.host.supersede(run, 'A newer native user instruction replaced the permission continuation, or its source could not be confirmed.');
  }

  /** Records a decision about a permission request; the same request answers with the same delivery while it is under way. */
  decide(request: PermissionRequest, prompt: string, options: { closed?: boolean } = {}): Promise<Run> {
    const pending = this.deliveries.get(request.id);
    if (pending) return pending;
    const delivery = this.record(request, prompt, options);
    this.deliveries.set(request.id, delivery);
    void delivery.finally(() => this.deliveries.delete(request.id)).catch(() => {});
    return delivery;
  }

  /** Records a permission decision once; approval needs a fresh provider turn, never an insert. */
  private async record(request: PermissionRequest, prompt: string, options: { closed?: boolean } = {}): Promise<Run> {
    const existing = [...this.host.runs.values()].find(run => run.permissionRequestIds?.includes(request.id));
    const revision = `${request.status}:${request.decidedAt ?? request.createdAt}`;
    const reopenedDecision = existing?.error && existing.permissionDecisionRevisions?.[request.id]?.startsWith('withdrawn:')
      && request.status !== 'withdrawn' && request.status !== 'pending' && existing.permissionDecisionRevisions[request.id] !== revision;
    if (existing && !reopenedDecision) { await this.host.flush(); if (!existing.scheduled && existing.error) throw new RunError(existing.error, 409); return this.host.shown(existing); }
    let target = request.runId ? this.host.runs.get(request.runId) : undefined;
    const visited = new Set<string>();
    while (target?.steering && !visited.has(target.id)) { visited.add(target.id); target = this.host.runs.get(target.steering.targetRunId); }
    if (!target || target.sessionId !== request.sessionId) throw new RunError('The requesting turn can no longer be reached.', 409);
    const now = new Date().toISOString();
    const approved = request.status === 'approved' && request.rule.kind !== 'run';
    const updateResume = [...this.host.runs.values()].find(run => run.status === 'queued' && run.sessionId === target!.sessionId && run.scheduled?.afterRunId === target!.id && run.scheduled.resume === 'update');
    const session = this.host.getSession(target.sessionId);
    // A latest native outcome is usable only when its user message falls inside this exact provider turn.
    const finishedTask = this.goalFinished(target);
    const superseded = [...this.host.runs.values()].some(run => run.sessionId === target!.sessionId && !run.permissionNotice && !run.permissionRequestIds?.length
      && !run.steering && run.id !== target!.id && Date.parse(run.createdAt) > Date.parse(request.createdAt) && run.origin?.kind === 'owner');
    const stopped = options.closed || session?.closed || finishedTask || superseded || target.ownerStopped
      || (target.status === 'cancelled' && !updateResume) || target.status === 'error';
    const merge = approved && !stopped ? [...this.host.runs.values()].find(run => run.status === 'queued' && run.sessionId === target!.sessionId && run.scheduled?.afterRunId === target!.id && (run.scheduled.resume === 'permission' || run.scheduled.resume === 'update')) : undefined;
    const continuation: Run = merge ?? { id: request.id, sessionId: target.sessionId, origin: target.origin ?? { kind: 'unknown' },
      prompt: `${TOWER_NOTICE} ${prompt.replace(/the next provider turn/g, 'this provider turn')}\nFirst inspect the conversation, existing artifacts and task results. Continue only unfinished work; do not repeat completed actions.`,
      status: approved && !stopped ? 'queued' : 'cancelled', createdAt: now, output: 'Permission decision recorded.',
      ...(approved && !stopped ? { scheduled: { at: now, afterRunId: target.id, resume: 'permission' as const } } : { finishedAt: now }),
      ...(target.delegation ? { delegation: { ...target.delegation } } : {}), ...(target.instructions?.required ? { instructions: { ...target.instructions } } : {}),
      ...(target.codexApprovalsReviewer ? { codexApprovalsReviewer: target.codexApprovalsReviewer } : {}),
      ...(target.unattended ? { unattended: true } : {}), ...(target.model ? { model: target.model } : {}), ...(target.effort ? { effort: target.effort } : {}) };
    if (!approved) continuation.error = 'Permission decision notice could not be delivered to its requesting turn.';
    continuation.permissionRequestedAt = !continuation.permissionRequestedAt || Date.parse(request.createdAt) < Date.parse(continuation.permissionRequestedAt)
      ? request.createdAt : continuation.permissionRequestedAt;
    continuation.permissionDecisionRevisions = { ...(continuation.permissionDecisionRevisions ?? {}), [request.id]: revision };
    continuation.permissionRequestIds = [...(continuation.permissionRequestIds ?? []), request.id];
    if (merge) continuation.prompt += `\n${prompt.replace(/the next provider turn/g, 'this provider turn')}`;
    this.host.runs.set(continuation.id, continuation);
    this.host.changed(); await this.host.flush();
    // Check the native owner record before our notice can become its latest user message.
    if (approved && continuation.status === 'queued') { await this.checkUserMessage(continuation); await this.host.flush(); }
    // Persisted intent precedes any notice. A failed/uncertain insert never becomes a separate native turn.
    if (!stopped && target.status === 'running' && !this.host.stopping() && (!approved || continuation.status === 'queued')) {
      const notice: Run = { id: randomUUID(), sessionId: target.sessionId, origin: target.origin ?? { kind: 'unknown' },
        prompt: `${TOWER_NOTICE} [Permission decision ${request.id}] ${approved ? 'The permission rule was approved and applies from the next provider turn. Bring the current step to a safe stopping point and end this turn normally. Tower will resume unfinished work in a fresh turn; do not repeat completed actions.' : prompt}`,
        status: 'queued', createdAt: now, output: '', permissionNotice: { targetRunId: target.id } };
      this.host.runs.set(notice.id, notice); this.host.admit(notice.id); this.host.changed(); await this.host.flush(); this.host.unadmit(notice.id);
      try {
        await this.host.steer(notice.id, { targetRunId: target.id });
        if (!approved && notice.steering?.state === 'sending') await new Promise<void>((resolve, reject) => {
          const finish = (delivered: boolean) => { clearTimeout(timer); this.host.events.off('change', check); if (delivered) resolve(); else reject(new Error('Permission decision notice delivery could not be confirmed.')); };
          const check = () => {
            if (notice.steering?.state === 'sending' && target.status === 'running' && !this.host.stopping()) return;
            finish(notice.steering?.state === 'delivered');
          };
          const timer = setTimeout(() => finish(false), 30_000); timer.unref();
          this.host.events.on('change', check); check();
        });
        if (!approved && notice.steering?.state === 'delivered') { delete continuation.error; this.host.changed(); await this.host.flush(); }
      }
      catch { if (notice.status === 'queued') { notice.status = 'cancelled'; notice.finishedAt = new Date().toISOString(); this.host.changed(); await this.host.flush(); } }
    }
    if (!approved && continuation.error) throw new RunError(continuation.error, 409);
    this.host.pump();
    return this.host.shown(continuation);
  }

  /** Before a permission continuation starts: a newer native owner instruction, or a finished goal, supersedes it. */
  async verifyBeforeLaunch(run: Run): Promise<void> {
    if (run.status === 'queued' && run.permissionRequestIds?.length && run.scheduled) await this.checkUserMessage(run);
  }

  /** Whether a permission continuation may start now; one whose requesting turn did not finish normally is superseded. */
  launchable(run: Run): boolean {
    if (run.scheduled?.resume !== 'permission') return true;
    const parent = this.host.runs.get(run.scheduled.afterRunId);
    if (!parent || parent.status === 'error' || parent.status === 'cancelled') { this.host.supersede(run, 'The requesting turn did not finish normally.'); return false; }
    return parent.status === 'completed';
  }

  /** A turn-only notice is shown for insertion only while its own requesting turn runs. */
  noticeBlocked(run: Run): boolean {
    return Boolean(run.permissionNotice && run.permissionNotice.targetRunId !== [...this.host.runs.values()].find(item => item.sessionId === run.sessionId && item.status === 'running' && !item.steering)?.id);
  }

  /** In every change: a continuation whose requesting turn stopped is not started. */
  sweep(): void {
    for (const run of this.host.runs.values()) if (run.status === 'queued' && run.permissionRequestIds?.length && run.scheduled) {
      const parent = this.host.runs.get(run.scheduled.afterRunId);
      if (parent && (parent.ownerStopped || parent.status === 'error' || (parent.status === 'cancelled' && run.scheduled.resume !== 'update'))) { run.status = 'cancelled'; run.finishedAt = new Date().toISOString(); run.error = 'The requesting turn stopped; permission continuation was not started.'; }
    }
  }

  /** A forced update carries the turn on once: a permission continuation waiting for it becomes the update's. */
  mergeIntoUpdate(run: Run, resumeNotice: string, resumeWait: string): boolean {
    const permission = [...this.host.runs.values()].find(other => other.status === 'queued' && other.scheduled?.afterRunId === run.id && other.scheduled.resume === 'permission');
    if (!permission) return false;
    permission.scheduled!.resume = 'update'; permission.prompt = `${resumeNotice}\n\n${permission.prompt}`; permission.output = resumeWait;
    return true;
  }
}

/** Permission receipts kept through pruning: every unfinished one, and the 200 most recently finished, with their requesting turns. */
export function retainedReceipts(runs: Iterable<Run>): string[] {
  const receipts = [...runs].filter(run => run.permissionRequestIds?.length);
  const kept = [...receipts.filter(run => !FINISHED.has(run.status)), ...receipts.filter(run => FINISHED.has(run.status)).sort((a, b) => finishedTime(b) - finishedTime(a)).slice(0, 200)];
  return kept.flatMap(run => [run.id, ...(run.scheduled ? [run.scheduled.afterRunId] : [])]);
}

/** A restored queued permission notice or continuation; false when `run` is neither. */
export function restorePermissionRun(run: Run): boolean {
  if (run.status === 'queued' && run.permissionNotice) { run.status = 'cancelled'; run.finishedAt = new Date().toISOString(); run.error = 'Turn-only permission notice was not resent after restart.'; return true; }
  if (run.status === 'queued' && run.scheduled?.resume === 'permission') { run.output = 'Waiting for the requesting turn to finish before permission continuation.'; return true; }
  return false;
}
