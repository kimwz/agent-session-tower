import test from 'node:test';
import assert from 'node:assert/strict';
import type { SecretSessionView } from '../../../shared/secrets.js';
import { SecretSessionPoller } from '../../../client/src/secrets/session-poller.js';

/** Timers the test fires by hand. */
class Timers {
  private next = 1;
  readonly queue = new Map<number, { run: () => void; ms: number }>();
  setTimeout = (run: () => void, ms: number) => { const id = this.next++; this.queue.set(id, { run, ms }); return id; };
  clearTimeout = (id: unknown) => { this.queue.delete(id as number); };
  waits() { return [...this.queue.values()].map(timer => timer.ms); }
  fire() { const [id, timer] = [...this.queue][0]!; this.queue.delete(id); timer.run(); }
}
const view = (patch: Partial<SecretSessionView> = {}): SecretSessionView => ({ status: { initialized: true, locked: false }, available: [], connectable: [], usage: [], unavailableSources: [], updatePendingSources: [], ...patch });
const tick = () => new Promise(resolve => setImmediate(resolve));

function poller(open: boolean) {
  const timers = new Timers();
  const reads: { resolve: (value: SecretSessionView) => void; reject: (error: unknown) => void; signal: AbortSignal }[] = [];
  const shown: SecretSessionView[] = []; const errors: unknown[] = [];
  const instance = new SecretSessionPoller({ open, timers, onView: next => shown.push(next), onError: error => errors.push(error),
    load: signal => new Promise((resolve, reject) => { reads.push({ resolve, reject, signal }); }) });
  return { instance, timers, reads, shown, errors };
}

test('an open dialog reads every 10 s and a closed one every 60 s, and opening reads at once', async () => {
  const { instance, timers, reads, shown } = poller(false);
  instance.start(); assert.equal(reads.length, 1);
  reads[0]!.resolve(view()); await tick();
  assert.equal(shown.length, 1); assert.deepEqual(timers.waits(), [60_000]);
  instance.setOpen(true); assert.equal(reads.length, 2, 'opening reads now'); assert.deepEqual(timers.waits(), []);
  reads[1]!.resolve(view()); await tick(); assert.deepEqual(timers.waits(), [10_000]);
  timers.fire(); assert.equal(reads.length, 3);
  reads[2]!.resolve(view()); await tick();
  instance.setOpen(false); assert.equal(reads.length, 3, 'closing does not read'); assert.deepEqual(timers.waits(), [60_000]);
  instance.stop(); assert.deepEqual(timers.waits(), []);
});

test('a permanent state stops reading until the dialog opens again or the window regains focus', async () => {
  const { instance, timers, reads } = poller(true);
  instance.start(); reads[0]!.resolve(view({ error: 'session-closed', permanent: true })); await tick();
  assert.deepEqual(timers.waits(), [], 'no further reads');
  instance.setOpen(false); instance.setOpen(true);
  assert.equal(reads.length, 2, 'reopening reads once');
  reads[1]!.resolve(view({ error: 'not-eligible', permanent: true })); await tick(); assert.deepEqual(timers.waits(), []);
  instance.wake(); assert.equal(reads.length, 3, 'focus reads once');
  reads[2]!.resolve(view({ error: 'locked', permanent: false })); await tick();
  assert.deepEqual(timers.waits(), [10_000], 'a passing state keeps reading');
  instance.stop();
});

test('a read that started before a mutation never overwrites the mutation’s answer', async () => {
  const { instance, timers, reads, shown } = poller(true);
  instance.start();
  instance.hold();
  assert.equal(reads[0]!.signal.aborted, true);
  reads[0]!.resolve(view({ usage: [] })); await tick();
  assert.deepEqual(shown, [], 'the earlier read is dropped'); assert.deepEqual(timers.waits(), []);
  const answer = view({ available: [{ id: 'a', name: 'A', groupId: 'g', kind: 'scalar', version: 1, reference: 'r', basis: ['session'], operations: ['env'] }] });
  instance.apply(answer);
  assert.deepEqual(shown, [answer]); assert.deepEqual(timers.waits(), [10_000]);
  instance.hold(); instance.release(); assert.deepEqual(timers.waits(), [10_000], 'a failed mutation resumes reading');
  instance.stop();
});

test('a failed read is reported and reading carries on; a stopped poller ignores late answers', async () => {
  const { instance, timers, reads, shown, errors } = poller(true);
  instance.start(); reads[0]!.reject(new Error('offline')); await tick();
  assert.equal(errors.length, 1); assert.deepEqual(timers.waits(), [10_000]);
  timers.fire(); instance.stop();
  reads[1]!.resolve(view()); await tick();
  assert.deepEqual(shown, []); assert.deepEqual(timers.waits(), []);
  instance.wake(); assert.equal(reads.length, 2, 'nothing reads after stop');
});
