import type { SecretSessionView } from '../../../shared/secrets';
import { pollDelay } from './secrets-client';

export interface SessionPollerOptions {
  load(signal: AbortSignal): Promise<SecretSessionView>;
  onView(view: SecretSessionView): void;
  onError(failure: unknown): void;
  open: boolean;
  timers?: { setTimeout(run: () => void, ms: number): unknown; clearTimeout(timer: unknown): void };
}

/**
 * Reads one session's secret view: every 10 s while its dialog is open, every 60 s while closed, never after a permanent
 * state until the dialog opens again or the window regains focus. Only reads; mutations hand their answer to `apply`,
 * and a read that started before a mutation is dropped so it cannot undo the mutation's answer.
 */
export class SecretSessionPoller {
  private open: boolean;
  private last?: SecretSessionView;
  private timer?: unknown;
  private reading?: AbortController;
  private version = 0;
  private stopped = false;
  private readonly timers: NonNullable<SessionPollerOptions['timers']>;

  constructor(private readonly options: SessionPollerOptions) {
    this.open = options.open;
    this.timers = options.timers ?? { setTimeout: (run, ms) => globalThis.setTimeout(run, ms), clearTimeout: timer => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>) };
  }

  start(): void { this.read(); }
  /** Opening reads now and resumes after a permanent state; closing only slows down. */
  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    if (open) this.read(); else if (this.timer !== undefined) this.schedule();
  }
  /** The window regained focus. */
  wake(): void { this.read(); }
  /** A mutation is on its way: nothing read until then may land. */
  hold(): void { this.version++; this.cancel(); }
  /** A mutation's answer. */
  apply(view: SecretSessionView): void { this.version++; this.cancel(); this.show(view); }
  /** A mutation failed; reading carries on from the last state. */
  release(): void { this.schedule(); }
  stop(): void { this.stopped = true; this.cancel(); }

  private read(): void {
    if (this.stopped) return;
    this.cancel();
    const reading = new AbortController(); const version = this.version;
    this.reading = reading;
    this.options.load(reading.signal).then(view => {
      if (reading.signal.aborted || version !== this.version) return;
      this.reading = undefined; this.show(view);
    }, failure => {
      if (reading.signal.aborted || version !== this.version) return;
      this.reading = undefined; this.options.onError(failure); this.schedule();
    });
  }
  private show(view: SecretSessionView): void {
    this.last = view;
    this.options.onView(view);
    this.schedule();
  }
  private schedule(): void {
    if (this.stopped) return;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    const delay = pollDelay(this.last, this.open);
    if (delay !== undefined) this.timer = this.timers.setTimeout(() => { this.timer = undefined; this.read(); }, delay);
  }
  private cancel(): void {
    this.reading?.abort(); this.reading = undefined;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
