import { until } from '../../../helpers/until.ts';

/**
 * The execution worker checks for a handoff, then for idleness, once a second: two setInterval(…, 1000) in
 * server/runs/worker.ts, the handoff timer created first. Once installed, each worker's pair runs every `periodMs`, in
 * that same order, and every round is counted, so a test proves that nothing happened after real checks instead of
 * sleeping for them. What a check decides is unchanged: hold, retry and idle deadlines are read from the clock.
 * `idleHeld` skips the idle half (a test sets it until its own request has reached the worker, as a second-long tick
 * always allowed).
 */
export const workerChecks = { rounds: 0, idleHeld: false };

let installed = false;
export function installWorkerChecks(periodMs = 10, onRound?: () => void): void {
  if (installed) return;
  installed = true;
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  type Pair = { idle?: () => void };
  let last: Pair | undefined;
  const idles = new Map<unknown, Pair>();
  globalThis.setInterval = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const source = ms === 1000 && /server[\\/]runs[\\/]worker\.ts/.test(new Error().stack ?? '') ? String(callback) : '';
    if (source.includes('handOff')) {
      const pair: Pair = last = {};
      return realSet(() => { workerChecks.rounds++; onRound?.(); callback(...args); if (!workerChecks.idleHeld) pair.idle?.(); }, periodMs);
    }
    if (source.includes('onIdle') && last && !last.idle) {
      const pair = last;
      pair.idle = () => callback(...args);
      const handle = { unref: () => handle, ref: () => handle, hasRef: () => false };
      idles.set(handle, pair);
      return handle;
    }
    return realSet(callback, ms, ...args);
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
    const pair = idles.get(handle);
    if (pair) { pair.idle = undefined; idles.delete(handle); return; }
    realClear(handle);
  }) as typeof clearInterval;
}

/** Waits until the workers in this process have run `count` more rounds of their handoff and idle checks. */
export async function checks(count = 3): Promise<void> {
  const target = workerChecks.rounds + count;
  await until(() => workerChecks.rounds >= target);
}
