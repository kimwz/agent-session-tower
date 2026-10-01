import test from 'node:test';
import assert from 'node:assert/strict';
import { startSlackMonitorPoll, SLACK_POLL_MS, SLACK_REQUEST_MS } from '../../../client/src/slack/slack-monitor-poll.js';
import type { SlackPublicStatus } from '../../../shared/slack.js';

const status = (connected = true): SlackPublicStatus => ({ connected, enabled: connected, status: 'ready', rules: [], events: [] });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

class Clock {
  time = 0;
  jobs = new Map<number, { at: number; call: () => void }>();
  next = 0;
  setTimeout = (call: () => void, delay: number) => { const id = ++this.next; this.jobs.set(id, { at: this.time + delay, call }); return id; };
  clearTimeout = (id: unknown) => { this.jobs.delete(id as number); };
  advance(ms: number) {
    this.time += ms;
    for (const [id, job] of [...this.jobs]) if (job.at <= this.time) { this.jobs.delete(id); job.call(); }
  }
}

function fixture() {
  const clock = new Clock();
  const requests: Array<{ signal: AbortSignal; resolve: (value: SlackPublicStatus) => void; reject: (error: Error) => void }> = [];
  const shown: SlackPublicStatus[] = [];
  const errors: string[] = [];
  const poll = startSlackMonitorPoll({ read: signal => new Promise((resolve, reject) => requests.push({ signal, resolve, reject })),
    loaded: value => shown.push(value), failed: error => errors.push(error.message), timeoutMessage: () => 'timed out' }, clock);
  return { clock, requests, shown, errors, poll };
}

test('initial failure can be retried; a successful disconnected account is still loaded', async () => {
  const f = fixture();
  assert.equal(f.requests.length, 1);
  f.requests[0].reject(new Error('offline'));
  await flush();
  assert.deepEqual(f.errors, ['offline']);
  const retry = f.poll.refresh();
  f.requests[1].resolve(status(false));
  await retry;
  assert.deepEqual(f.shown, [status(false)]);
  f.poll.dispose();
});

test('an overview that ignores abort still times out, allows retry, and cannot publish late data', async () => {
  const f = fixture();
  f.clock.advance(SLACK_REQUEST_MS);
  await flush();
  assert.equal(f.requests[0].signal.aborted, true);
  assert.deepEqual(f.errors, ['timed out']);
  const retry = f.poll.refresh();
  f.requests[1].resolve(status());
  await retry;
  f.requests[0].resolve(status(false));
  await flush();
  assert.deepEqual(f.shown, [status()]);
  f.poll.dispose();
});

test('ordinary refresh is deduplicated while changed refresh follows the in-flight read', async () => {
  const f = fixture();
  const first = f.poll.refresh();
  const second = f.poll.refresh();
  const changed = f.poll.changed();
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve(status());
  await first; await second; await flush();
  assert.equal(f.requests.length, 2, 'change made while loading gets a fresh answer afterward');
  f.requests[1].resolve(status(false));
  await changed;
  assert.deepEqual(f.shown, [status(), status(false)]);
  f.clock.advance(SLACK_POLL_MS);
  assert.equal(f.requests.length, 3);
  f.poll.dispose();
});

test('disconnect disposes work without clearing the last loaded overview, and suppresses late results', async () => {
  const f = fixture();
  f.requests[0].resolve(status()); await flush();
  f.clock.advance(SLACK_POLL_MS);
  f.poll.dispose();
  assert.equal(f.requests[1].signal.aborted, true);
  f.requests[1].resolve(status(false)); await flush();
  assert.deepEqual(f.shown, [status()]);
  assert.deepEqual(f.errors, []);
  f.clock.advance(SLACK_REQUEST_MS * 2);
  await f.poll.refresh(); await f.poll.changed();
  assert.equal(f.requests.length, 2);
  assert.equal(f.clock.jobs.size, 0);
});
