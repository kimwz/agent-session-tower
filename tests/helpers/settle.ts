import assert from 'node:assert/strict';

/** Captured when this module loads, before any test mocks the timers. */
const realSetTimeout = globalThis.setTimeout;

/**
 * Lets real I/O (sockets, child processes, files) run while setTimeout is mocked: polls on the real clock until
 * `read` holds, then gives pending callbacks a few more turns. The real deadline only bounds a broken test.
 */
export async function settle(read: () => boolean = () => true, rounds = 20, timeout = 10_000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!read() && performance.now() < deadline) await new Promise(resolve => realSetTimeout(resolve, 1));
  assert.ok(read(), `settle timed out waiting for: ${read}`);
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
}

/** A real wait while setTimeout may be mocked. */
export const realDelay = (ms: number) => new Promise<void>(resolve => realSetTimeout(resolve, ms));
