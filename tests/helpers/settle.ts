import assert from 'node:assert/strict';

/**
 * Lets real I/O (sockets, child processes) run while setTimeout is mocked: polls on setImmediate,
 * never on a timer, until `read` holds, then gives pending I/O a few more turns.
 */
export async function settle(read: () => boolean = () => true, rounds = 20): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!read() && performance.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(read(), `settle timed out waiting for: ${read}`);
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve));
}
