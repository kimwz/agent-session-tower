import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

/**
 * Captured when this module loads, before any test mocks the timers: every wait here runs on the real clock, so it
 * works the same while a test fakes setTimeout or Date.
 */
const realSetTimeout = globalThis.setTimeout;

/** A real wait, also while setTimeout is mocked. */
export const realDelay = (ms: number) => new Promise<void>(resolve => realSetTimeout(resolve, ms));

/**
 * Waits for asynchronous state instead of sleeping a guessed duration: resolves with the first value that is neither
 * undefined nor false (`read` may be async), and fails clearly once `timeout` real milliseconds have passed (the deadline only bounds a
 * broken test; it is read from the monotonic clock, so a mocked Date.now cannot stall it).
 */
export async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, timeout = 10_000): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    if (performance.now() > deadline) throw new Error(`Timed out after ${timeout}ms waiting for: ${read}`);
    await realDelay(5);
  }
}

/**
 * Lets real I/O (sockets, child processes, files) run while setTimeout is mocked: waits on the real clock until `read`
 * holds, then gives pending callbacks a few more turns.
 */
export async function settle(read: () => boolean = () => true, rounds = 20, timeout = 10_000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!read() && performance.now() < deadline) await realDelay(1);
  assert.ok(read(), `settle timed out waiting for: ${read}`);
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
}

/**
 * Moves the test's fake clock on `stepMs` at a time, letting real I/O run in between, until `done`: however long the
 * real work takes, the fake waits in its way pass. Fails clearly once `timeout` real milliseconds have passed.
 */
export async function tickUntil(t: TestContext, done: () => unknown, stepMs: number, timeout = 10_000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!done() && performance.now() < deadline) { t.mock.timers.tick(stepMs); await realDelay(1); }
  assert.ok(done(), `tickUntil timed out waiting for: ${done}`);
}
