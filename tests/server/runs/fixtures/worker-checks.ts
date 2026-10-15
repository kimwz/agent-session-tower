import type { WorkerChecks } from '../../../../server/runs/worker.js';
import { until } from '../../../helpers/until.ts';

/** The drivers whose worker is running its checks now. */
const live = new Set<CheckDriver>();

/**
 * Runs one worker's handoff and idle checks every `periodMs` instead of once a second, through startRunnerHost's
 * test-only `scheduleChecks`: each round calls the handoff check, then the idle check, as the two production timers
 * fire. A test counts the worker's completed rounds to prove nothing happened after real checks instead of sleeping
 * for them. What a check decides is unchanged: hold, retry and idle deadlines are read from the clock.
 */
export class CheckDriver {
  /** Skips the idle check (a test sets it until its own request has reached the worker, as a second-long tick always allowed). */
  idleHeld = false;
  private started = 0;
  private readonly completed: number[] = [];
  /** Handoff attempts not yet settled: one under way ends with a handoff (the successor started) or a resume. */
  private readonly attempts = new Set<Promise<void>>();

  constructor(private readonly periodMs = 10, private readonly onRound?: () => void) {}

  /** Whether the worker is running its checks: from its start until its close has stopped its endpoint keeper. */
  running(): boolean { return live.has(this); }

  /** Settles once every handoff attempt started so far has (after the worker stopped its checks, no new one starts). */
  async settled(): Promise<void> { while (this.attempts.size) await Promise.all(this.attempts); }

  /** Pass as `scheduleChecks`. */
  readonly schedule = (checks: WorkerChecks): (() => void) => {
    live.add(this);
    const timer = setInterval(() => {
      const round = ++this.started;
      const handoff = checks.handoff();
      this.attempts.add(handoff);
      if (!this.idleHeld) checks.idle();
      void handoff.then(() => { this.attempts.delete(handoff); this.completed.push(round); this.onRound?.(); });
    }, this.periodMs);
    return () => { clearInterval(timer); live.delete(this); };
  };

  /**
   * Waits until `count` rounds started after this call have completed (a handoff attempt underway may still pause).
   * A worker that stops its checks meanwhile has nothing left to do.
   */
  async checks(count = 3): Promise<void> {
    const after = this.started;
    await until(() => !live.has(this) || this.completed.filter(round => round > after).length >= count);
  }
}

/** Waits until every worker running its checks has completed `count` more rounds. */
export async function checks(count = 3): Promise<void> {
  if (live.size === 0) throw new Error('No worker is running its checks.');
  await Promise.all([...live].map(driver => driver.checks(count)));
}
