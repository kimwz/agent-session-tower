import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { type TestContext } from 'node:test';
import { PermissionContinuations, type PermissionHost } from '../../../server/runs/permission-continuation.js';
import type { PermissionRequest } from '../../../shared/permissions.js';
import type { Run } from '../../../shared/types.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

/** A running Claude turn that holds a refusal notice as Claude does: sent, and taken only at its next step. */
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runs = new Map<string, Run>();
  const events = new EventEmitter();
  const turn: Run = { id: 'turn', sessionId: 'claude:one', prompt: 'Release', status: 'running', createdAt: new Date().toISOString(), output: '', origin: { kind: 'owner' } };
  runs.set(turn.id, turn);
  let notice: Run | undefined;
  const host: PermissionHost = { runs, events, getSession: () => undefined, supersede: () => {},
    steer: async id => {
      notice = runs.get(id)!; notice.status = 'running';
      notice.steering = { targetRunId: turn.id, state: 'sending', requestedAt: new Date().toISOString() };
      return notice;
    },
    changed: () => { events.emit('change'); }, touch: () => {}, flush: async () => {}, pump: () => {}, stopping: () => false,
    admit: () => {}, unadmit: () => {}, latestUserMessage: async () => undefined, shown: run => run };
  const request = (status: PermissionRequest['status'], decidedAt = new Date().toISOString()): PermissionRequest => ({ id: 'request-1', sessionId: turn.sessionId, runId: turn.id, status,
    rule: { kind: 'command', value: 'gh api', providers: ['claude'], scope: 'project', cwd: '/fixture' }, reason: 'Fixture', cwd: '/fixture', createdAt: new Date().toISOString(), decidedAt });
  // How the run manager settles a sent notice: taken by Claude, or ended without it.
  const end = (state: 'delivered' | 'uncertain') => {
    notice!.steering!.state = state; if (state === 'uncertain') notice!.status = 'error';
    events.emit('change');
  };
  return { continuations: new PermissionContinuations(host), runs, events, turn, request, end };
}

test('a refusal notice Claude takes after more than 30 s counts as told, not as undelivered', async t => {
  const f = fixture(t);
  let undelivered = 0;
  const receipt = f.continuations.decide(f.request('withdrawn'), 'Ask for permissions_run instead.', { undelivered: () => { undelivered += 1; } });
  await settle();
  t.mock.timers.tick(30_000);
  assert.equal((await receipt).error, undefined);
  f.end('delivered');
  await settle();
  assert.equal(undelivered, 0);
  assert.equal(f.runs.get('request-1')!.error, undefined);
  assert.equal(f.events.listenerCount('change'), 0);
});

test('a notice counted as told that the turn ends without taking fails its receipt then, and a reopened approval still resumes', async t => {
  const f = fixture(t);
  let undelivered = 0;
  const receipt = f.continuations.decide(f.request('withdrawn'), 'Ask for permissions_run instead.', { undelivered: () => { undelivered += 1; } });
  await settle();
  t.mock.timers.tick(30_000);
  await receipt;
  f.end('uncertain');
  await settle();
  assert.equal(undelivered, 1);
  assert.match(f.runs.get('request-1')!.error ?? '', /could not be delivered/);
  assert.equal(f.events.listenerCount('change'), 0);
  // The owner, asked instead, allows it: the work continues in a fresh turn.
  const approval = f.continuations.decide(f.request('approved', new Date(Date.now() + 1000).toISOString()), 'The owner allowed it.');
  await settle();
  const resumed = await approval;
  assert.deepEqual([resumed.status, resumed.scheduled?.resume], ['queued', 'permission']);
});

test('a notice that fails within the wait still fails the decision at once', async t => {
  const f = fixture(t);
  let undelivered = 0;
  const receipt = f.continuations.decide(f.request('withdrawn'), 'Ask for permissions_run instead.', { undelivered: () => { undelivered += 1; } });
  await settle();
  f.end('uncertain');
  await assert.rejects(receipt, /could not be delivered/);
  assert.equal(undelivered, 0);
  assert.equal(f.events.listenerCount('change'), 0);
});
