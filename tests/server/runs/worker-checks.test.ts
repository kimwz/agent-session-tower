import assert from 'node:assert/strict';
import test from 'node:test';
import { everySecond, WORKER_CHECK_MS } from '../../../server/runs/worker.js';

/** Tests run the worker's checks every few milliseconds through `scheduleChecks`; without it they run once a second. */
test('without a test schedule the worker checks for a handoff and for idleness once a second, each on its own timer', async t => {
  assert.equal(WORKER_CHECK_MS, 1000);
  t.mock.timers.enable({ apis: ['setInterval'] });
  let handoffs = 0, idles = 0;
  const stop = everySecond({ handoff: async () => { handoffs++; }, idle: () => { idles++; } });
  t.mock.timers.tick(999);
  assert.deepEqual([handoffs, idles], [0, 0]);
  t.mock.timers.tick(1);
  assert.deepEqual([handoffs, idles], [1, 1]);
  t.mock.timers.tick(2000);
  assert.deepEqual([handoffs, idles], [3, 3]);
  stop();
  t.mock.timers.tick(5000);
  assert.deepEqual([handoffs, idles], [3, 3], 'stopped with the worker');
});
