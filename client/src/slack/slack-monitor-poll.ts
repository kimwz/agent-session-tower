import type { SlackPublicStatus } from '../../../shared/slack';

export const SLACK_POLL_MS = 3000;
export const SLACK_REQUEST_MS = 15_000;
interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const timers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One overview read at a time, including a fresh read after a change received during an older request. */
export function startSlackMonitorPoll(options: {
  read(signal: AbortSignal): Promise<SlackPublicStatus>;
  loaded(value: SlackPublicStatus): void;
  failed(error: Error): void;
  timeoutMessage(): string;
}, clock: Timers = timers) {
  let disposed = false;
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  let pollTimer: unknown;
  let requestTimer: unknown;
  let cancel: (() => void) | undefined;
  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    clock.clearTimeout(pollTimer);
    controller = new AbortController();
    const signal = controller.signal;
    const deadline = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error('Disposed Slack overview request'));
      requestTimer = clock.setTimeout(() => {
        reject(new Error(options.timeoutMessage()));
        controller?.abort();
      }, SLACK_REQUEST_MS);
    });
    // Race even when a transport ignores abort: retry must not wait for a dead request to finish.
    pending = Promise.race([options.read(signal), deadline]).then(value => {
      if (!disposed) options.loaded(value);
    }).catch(cause => {
      if (!disposed) options.failed(cause instanceof Error ? cause : new Error(String(cause)));
    }).finally(() => {
      clock.clearTimeout(requestTimer);
      requestTimer = undefined;
      cancel = undefined;
      controller = undefined;
      pending = undefined;
      if (!disposed) pollTimer = clock.setTimeout(() => void refresh(), SLACK_POLL_MS);
    });
    return pending;
  }
  const changed = () => refresh().then(() => refresh());
  void refresh();
  return {
    refresh, changed,
    dispose() {
      disposed = true;
      clock.clearTimeout(pollTimer);
      clock.clearTimeout(requestTimer);
      cancel?.();
      controller?.abort();
    },
  };
}
