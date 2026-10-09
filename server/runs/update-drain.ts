import { randomUUID } from 'node:crypto';
import { TOWER_NOTICE } from '../../shared/task-notification.js';
import type { Run } from '../../shared/types.js';
import type { CodexBridgeRun } from './codex-bridge.js';
import { inheritedRunFields } from './continuations.js';
import { UPDATE_RESUME_WAIT } from './run-history.js';
import { FINISHED, admissionUncertain } from './run-records.js';

export const UPDATE_WAIT = 'Waiting: Tower is switching to its new version; this starts right after.';
const WRAP_UP_RETRY_MS = 30_000;
const WRAP_UP_NOTICE = `${TOWER_NOTICE} Tower is about to restart to apply an update. Within the next few minutes bring your work to a safe stopping point: finish or pause the current step, do not start long or risky operations, and do not leave half-applied changes. Then end your turn with a short note of what is done and what remains. Tower resumes this conversation automatically right after the update. Do not report the task as finished unless it is.`;
const RESUME_NOTICE = `${TOWER_NOTICE} Tower was updated while this conversation was working, and the previous turn was ended for the update. Continue the original task. First check the conversation, files and running processes to see what was already done; do not repeat actions with outside effects (deploys, pushes, sent messages) without checking their result. If the task is already complete, say so briefly and stop.`;
const UPDATE_STOPPED = 'Stopped for a Tower update before it finished; Tower resumes the conversation on its new version.';
const DELEGATED_STOPPED = 'Stopped for a Tower update before it finished; it was not resumed automatically.';
const UPDATE_NOT_STARTED = 'Stopped for a Tower update before it started in the Codex app. Send the instruction again.';

/** A running turn a forced update is ending, and Tower's own continuation for it. */
export interface UpdateTarget { delegated: boolean; retryAt: number;
  /** A wrap-up request is being inserted right now. */
  sending?: boolean;
  /** A wrap-up request was handed to the turn (it may or may not have taken it). */
  reached?: boolean;
  /** A deadline asked for its stop (kept across forced updates; decides whether it is carried on). */
  stopping?: boolean;
  /** The forced update (its sequence number) whose deadline sent the stop; a later one sends it again. */
  stopSent?: number }
/** `active` while new turns wait; after a give-up, turns already stopped or asked to wrap up are still settled. */
interface DrainState { sequence: number; startedAt: number; deadline: number; delegated: (run: Run) => boolean; active: boolean; targets: Map<string, UpdateTarget>; stoppingBridges: Set<string>; wrapUps: Set<string> }

export interface DrainHost {
  /** The manager's runs: read, and added to (wrap-up requests, continuations). */
  readonly runs: Map<string, Run>;
  /** Codex app submissions, by run. */
  readonly bridged: ReadonlyMap<string, CodexBridgeRun>;
  /** Runs the owner asked to stop. */
  ownerStopped(runId: string): boolean;
  stopping(): boolean;
  steer(runId: string, options: { targetRunId?: string }): Promise<Run>;
  cancel(runId: string, reason?: string): Promise<void>;
  changed(): void;
  pump(): void;
  /** A forced update carries the turn on once: a permission continuation waiting for it becomes the update's. */
  mergePermission(run: Run, resumeNotice: string, resumeWait: string): boolean;
}

/**
 * The owner asked Tower to switch to its new version now. From here no new turn starts, each running turn is asked to
 * wrap up, and at `deadline` the turns still running are stopped. When a turn the update interrupted ends, Tower
 * queues its own continuation in that same step (see settle). Delegated work of a Slack or GitHub workflow is neither
 * asked nor resumed: its coordinator hears how it ended and decides.
 */
export class UpdateDrain {
  private state?: DrainState;
  constructor(private readonly host: DrainHost) {}

  /** While a forced update holds new turns back. */
  get active(): boolean { return this.state?.active === true; }

  begin(deadline: number, delegated: (run: Run) => boolean): void {
    if (this.active || this.host.stopping()) return;
    // Turns from an earlier forced update that gave up are still followed until they end.
    this.state = { sequence: (this.state?.sequence ?? 0) + 1, startedAt: Date.now(), deadline, delegated, active: true, targets: this.state?.targets ?? new Map(), stoppingBridges: new Set(), wrapUps: this.state?.wrapUps ?? new Set() };
    this.host.changed();
  }

  /**
   * Gives up a forced update that could not hand off: queued turns start again here and nothing is cancelled. Turns it
   * already stopped or asked to wrap up still get their continuation when they end.
   */
  end(): void {
    if (!this.state?.active) return;
    this.state.active = false;
    this.host.changed();
    this.host.pump();
  }

  /** Shown while a forced update waits for running turns to wrap up. */
  status(): { startedAt: string; deadline: string; running: number } | undefined {
    const drain = this.state;
    if (!drain?.active) return undefined;
    const running = [...drain.targets.keys()].filter(id => this.host.runs.get(id)?.status === 'running').length
      + [...this.host.bridged.keys()].filter(id => this.host.runs.get(id)?.status === 'queued').length;
    return { startedAt: new Date(drain.startedAt).toISOString(), deadline: new Date(drain.deadline).toISOString(), running };
  }

  /** Called about once a second while a forced update waits: wrap-up requests, Codex app submissions, the deadline. */
  drive(now = Date.now()): void {
    const drain = this.state;
    if (!drain?.active || this.host.stopping()) return;
    for (const [id, bridge] of this.host.bridged) {
      const run = this.host.runs.get(id);
      if (run?.status !== 'queued') continue;
      if (now < drain.deadline) void bridge.withdraw?.().catch(() => {});
      else if (!drain.stoppingBridges.has(id)) { drain.stoppingBridges.add(id); void this.host.cancel(id, UPDATE_NOT_STARTED).catch(() => {}); }
    }
    for (const [id, target] of drain.targets) {
      const run = this.host.runs.get(id);
      if (run?.status !== 'running') continue;
      if (now >= drain.deadline) {
        if (target.stopSent !== drain.sequence) { target.stopSent = drain.sequence; target.stopping = true; void this.host.cancel(id, target.delegated ? DELEGATED_STOPPED : UPDATE_STOPPED).catch(() => {}); }
      } else if (!target.delegated && !target.stopping && !target.reached && !target.sending && now >= target.retryAt) this.sendWrapUp(run, target);
    }
  }

  /** Inserts the wrap-up request into a running turn. A request that surely did not reach it is removed and tried again. */
  private sendWrapUp(target: Run, state: UpdateTarget): void {
    const wrapUp: Run = { id: randomUUID(), sessionId: target.sessionId, origin: target.origin ?? { kind: 'unknown' }, prompt: WRAP_UP_NOTICE, status: 'queued',
      createdAt: new Date().toISOString(), updateWrapUp: true,
      output: 'Asking the running turn to wrap up for a Tower update.', ...(target.model ? { model: target.model } : {}), ...(target.effort ? { effort: target.effort } : {}) };
    this.host.runs.set(wrapUp.id, wrapUp);
    this.state!.wrapUps.add(wrapUp.id);
    state.sending = true;
    state.retryAt = Date.now() + WRAP_UP_RETRY_MS;
    this.host.changed();
    let uncertain = false;
    void this.host.steer(wrapUp.id, { targetRunId: target.id }).catch(error => { uncertain = admissionUncertain(error); }).finally(() => {
      if (uncertain) return;
      state.sending = false;
      // Put back in the queue means it was never handed over; it must not start later as a turn of its own.
      if (wrapUp.status !== 'queued' || wrapUp.steering || this.host.runs.get(wrapUp.id) !== wrapUp) return;
      this.host.runs.delete(wrapUp.id);
      state.reached = false;
      // The turn ended meanwhile, counted as asked to wrap up: it was not, so it is not carried on.
      const turn = this.host.runs.get(target.id);
      if (turn?.status === 'completed') {
        for (const run of [...this.host.runs.values()]) if (run.status === 'queued' && run.scheduled?.resume === 'update' && run.scheduled.afterRunId === turn.id) this.host.runs.delete(run.id);
      }
      this.host.changed();
    });
  }

  /** A wrap-up request is never carried: after a restart it would start as a turn of its own. */
  isWrapUp(runId: string): boolean { return this.state?.wrapUps.has(runId) === true; }

  /** Called as an inserted instruction is handed to its turn: a wrap-up request that got this far may have reached it. */
  noteHandedOver(run: Run): void {
    if (!this.state?.wrapUps.has(run.id) || !run.steering) return;
    const target = this.state.targets.get(run.steering.targetRunId);
    if (target) target.reached = true;
  }

  /**
   * Registers every turn running during a forced update in the same step as the change that shows it running, and
   * settles each one in the same step as the change that shows it ended.
   */
  track(): void {
    const drain = this.state;
    if (!drain) return;
    if (drain.active) for (const run of this.host.runs.values()) {
      if (run.status !== 'running' || run.steering || drain.targets.has(run.id)) continue;
      drain.targets.set(run.id, { delegated: drain.delegated(run), retryAt: 0 });
    }
    for (const [id, target] of drain.targets) {
      const run = this.host.runs.get(id);
      if (!run) { drain.targets.delete(id); continue; }
      if (!FINISHED.has(run.status)) continue;
      drain.targets.delete(id);
      this.settle(run, target);
    }
    if (!drain.active && !drain.targets.size) this.state = undefined;
  }

  /**
   * Only work the update itself interrupted is carried on: a turn the deadline stopped, or one that ended after its
   * wrap-up request reached it. A turn the owner stopped, one stopped in the Codex app, one that failed, and one that
   * finished its own work before any wrap-up reached it end as they are. The continuation is queued in the same step
   * that shows the turn ended, so no watcher sees one without the other; it replaces the agent's own wakeup.
   */
  settle(run: Run, target: UpdateTarget): void {
    if (target.delegated || this.host.ownerStopped(run.id)) return;
    // A stop the deadline asked for counts only once confirmed ('cancelled'): an unconfirmed one may still be running there.
    if (!((target.stopping && run.status === 'cancelled') || (run.status === 'completed' && target.reached))) return;
    if (this.host.mergePermission(run, RESUME_NOTICE, UPDATE_RESUME_WAIT)) return;
    for (const other of [...this.host.runs.values()]) {
      if (other.status === 'queued' && other.scheduled?.afterRunId === run.id && other.scheduled.resume !== 'update') this.host.runs.delete(other.id);
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    this.host.runs.set(id, { id, sessionId: run.sessionId, ...inheritedRunFields(run), prompt: RESUME_NOTICE, status: 'queued',
      createdAt: now, output: UPDATE_RESUME_WAIT, scheduled: { at: now, afterRunId: run.id, resume: 'update' } });
  }
}
