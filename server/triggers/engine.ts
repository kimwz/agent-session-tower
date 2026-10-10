import type { Trigger, TriggerActor, TriggerEvent, TriggerPolicy } from '../../shared/triggers.js';
import type { TriggerDispatch } from './dispatch.js';
import { fire } from './firing.js';
import type { RequestBudget } from './outbound.js';
import type { TriggerPolls } from './polls.js';
import { CATCH_UP_WINDOW_MS, LATE_AFTER_MS, latestSlot, nextSlot } from './schedule.js';
import type { EngineState } from './state.js';
import type { TriggerStore } from './store.js';
import { isKind } from '../../shared/errors.js';

/**
 * The engine's clock: a tick every so often fires what is due, starts polls, follows runs and hands queued ones over.
 * Owns the timer, whether it started, the tick under way, and the hold a worker handoff puts on new scheduled times.
 */
export class TriggerEngine {
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private started = false;
  private held = false;

  constructor(private readonly store: TriggerStore, private readonly polls: TriggerPolls, private readonly dispatch: TriggerDispatch, private readonly budget: RequestBudget,
    private readonly now: () => number, private readonly tickMs: number) {}

  markStarted(): void { this.started = true; }
  isStarted(): boolean { return this.started; }
  isTicking(): boolean { return Boolean(this.ticking); }
  isHeld(): boolean { return this.held; }
  /** Stops firing and dispatching without discarding anything, for a worker handoff. */
  pause(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  resume(): void {
    this.pause();
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, this.tickMs);
    this.timer.unref();
  }
  /** New scheduled times are left for the successor worker; its catch-up runs them. */
  hold(): void { this.held = true; }
  /** A forced update that gave up: scheduled times fire here again. */
  release(): void { this.held = false; }

  /** Fires inside a commit; a capacity warning it answers is noted in that same commit. */
  private fire(state: EngineState, trigger: Trigger, dedupKey: string, at: number, kind: TriggerEvent['kind'], by?: TriggerActor, overlap?: TriggerPolicy['overlap']): TriggerEvent | undefined {
    const { event, capacity } = fire(state, trigger, dedupKey, at, kind, this.now, by, overlap);
    if (capacity) this.store.noteCapacity(capacity);
    return event;
  }

  // ---- Firing and dispatch ------------------------------------------------------------------------

  tick(): Promise<void> {
    if (!this.started) return Promise.resolve();
    return this.ticking ??= this.step().finally(() => { this.ticking = undefined; });
  }

  private async step(): Promise<void> {
    // After a failed save, try saving again before anything new is accepted.
    if (this.store.problem) await this.store.mutate({ type: 'maintenance' },() => undefined, 'settle').catch(() => {});
    // A claim whose outcome could not be saved is matched to what was admitted, never submitted again.
    const orphans = this.dispatch.reconcileOrphans();
    if (orphans) await orphans;
    const now = this.now();
    if (!this.held && !this.store.problem) {
      for (const trigger of this.store.state.triggers) {
        if (!trigger.enabled) continue;
        const cursor = this.store.state.cursors[trigger.id];
        if (!cursor || cursor.paused || cursor.nextAt === undefined || cursor.nextAt > now || this.polls.has(trigger.id)) continue;
        if (trigger.source.kind === 'github' && cursor.blockedUntil !== undefined && cursor.blockedUntil > now) continue;
        // All HTTP triggers together send at most this many requests a minute; the rest wait for the next tick.
        const polled = trigger.source.kind !== 'schedule';
        if (polled && this.budget.sentSince(now - 60_000) >= this.budget.requestLimit) continue;
        // Taken before the claim is saved, so a manual run cannot start a second request in between.
        const unlock = polled ? this.polls.lock(trigger.id) : undefined;
        if (polled && !unlock) continue;
        const full = this.store.full();
        if (full && trigger.source.schedule.type === 'once') continue;
        let poll: { slot: number; revision: number } | undefined;
        await this.store.mutate({ type: 'fire', id: trigger.id },state => {
          const current = state.triggers.find(item => item.id === trigger.id);
          const position = state.cursors[trigger.id];
          const admissionNow = this.now();
          if (this.held || !current || !current.enabled || state.onceConsumed[current.id] || !position || position.paused || position.nextAt === undefined || position.nextAt > admissionNow) return;
          if (current.source.kind === 'schedule' && current.source.schedule.type === 'once') {
            const slot = position.nextAt;
            const event = this.fire(state, current, new Date(slot).toISOString(), slot, 'schedule');
            if (event && current.source.catchUp === 'skip' && admissionNow - slot > LATE_AFTER_MS) {
              event.status = 'skipped'; event.reason = 'The once reservation was missed and consumed without retrying.';
            }
            return;
          }
          // With history full, the schedule still moves on, but nothing new is recorded or run.
          if (full) { position.nextAt = nextSlot(current.source.schedule, now, position.anchorAt); return; }
          const schedule = current.source.schedule;
          // Late, or more than one time already passed: this is a catch-up, not an on-time run.
          const following = nextSlot(schedule, position.nextAt, position.anchorAt);
          const late = now - position.nextAt > LATE_AFTER_MS || (following !== undefined && following <= now);
          // A slot this late was missed; catch-up runs only the latest one inside the window. A poll always
          // looks once after a gap: what it checks is the current state, not what happened meanwhile.
          const catchUp = current.source.kind === 'schedule' ? current.source.catchUp : 'latest';
          const slot = !late ? position.nextAt
            : catchUp === 'latest' ? latestSlot(schedule, Math.max(position.lastSlot ?? -Infinity, now - CATCH_UP_WINDOW_MS), now, position.anchorAt) : undefined;
          position.nextAt = nextSlot(schedule, Math.max(now, position.lastSlot ?? 0), position.anchorAt);
          if (slot === undefined || (position.lastSlot !== undefined && slot <= position.lastSlot)) return;
          position.lastSlot = slot;
          if (current.source.kind === 'schedule') { this.fire(state, current, new Date(slot).toISOString(), slot, 'schedule'); return; }
          // Claimed before the request goes out, so a POST cut off by a stop is never sent again for this time.
          position.polling = { slot, revision: current.revision, method: current.source.kind === 'http' ? current.source.request.method : 'GET' };
          poll = { slot, revision: current.revision };
        }, full ? 'settle' : 'grow').then(() => { if (poll && unlock) this.polls.startPoll(trigger.id, poll.slot, poll.revision, unlock); else unlock?.(); }).catch(async error => {
          unlock?.();
          if (!isKind(error, 'storage-full')) return;
          // A once reservation keeps its due time without repeated settle writes until history has room.
          if (trigger.source.schedule.type === 'once') {
            this.store.noteCapacity(`"${trigger.name}" is waiting because trigger history is full.`);
            return;
          }
          // Repeating schedules move on, with a visible warning.
          this.store.noteCapacity(`"${trigger.name}" skipped a scheduled run because trigger history is full.`);
          await this.store.mutate({ type: 'cursor', id: trigger.id },state => {
            const position = state.cursors[trigger.id];
            const current = state.triggers.find(item => item.id === trigger.id);
            if (position && current && current.source.schedule.type !== 'once') position.nextAt = nextSlot(current.source.schedule, now, position.anchorAt);
          }, 'settle').catch(() => {});
        });
      }
    }
    await this.dispatch.track();
    // Closing issues talks to GitHub; it goes on beside the tick so a slow answer never holds up other triggers.
    if (!this.held && !this.store.problem) this.dispatch.startClosing();
    await this.dispatch.dispatch();
  }
}
