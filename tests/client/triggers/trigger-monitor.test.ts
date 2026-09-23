import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { TriggerEventNode } from '../../../client/src/graph/TriggerGraphNodes.js';
import { TriggerEventDetail } from '../../../client/src/triggers/TriggerMonitorPanel.js';
import { keepTriggerEvents, laneWorthy, RecheckQueue, reconcileSnapshot, mergeTriggerEvents, monitorItems, monitorVisible, readMonitorPosition, readTriggerState, triggerUnread, TRIGGER_POSITION_KEY } from '../../../client/src/triggers/trigger-monitor.js';
import { SLACK_POSITION_KEY } from '../../../client/src/graph/slack-graph.js';
import type { SlackWorkflow } from '../../../shared/slack.js';
import type { TriggerEvent } from '../../../shared/triggers.js';

const run = (id: string, minute: number, status: TriggerEvent['status'] = 'completed', values: Partial<TriggerEvent> = {}): TriggerEvent => ({
  id, triggerId: 't1', triggerName: 'Nightly report', triggerRevision: 1, kind: 'schedule', dedupKey: id, occurredAt: `2026-09-24T00:${String(minute).padStart(2, '0')}:00Z`,
  receivedAt: `2026-09-24T00:${String(minute).padStart(2, '0')}:00Z`, updatedAt: `2026-09-24T00:${String(minute).padStart(2, '0')}:30Z`, status, summary: 'Scheduled',
  input: { instructions: '', provider: 'codex', approvals: 'auto', target: { node: 'local', mode: 'auto' }, untrustedInput: false, overlap: 'skip' }, requestId: id, ...values,
});
const mention = (id: string, minute: number): SlackWorkflow => ({ id, status: 'completed', createdAt: `2026-09-24T00:${String(minute).padStart(2, '0')}:00Z`, updatedAt: '', rules: [],
  mention: { id, teamId: 'T', channel: 'C', user: 'U', ts: '1', threadTs: '1', text: 'Please look' } });
const node = (data: unknown) => renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(TriggerEventNode as unknown as FunctionComponent<{ data: unknown }>, { data })));

test('the monitor lists Slack mentions and trigger runs together, newest first, keeping an older selection', () => {
  const items = monitorItems([mention('m1', 1), mention('m3', 30)], [run('r2', 20), run('r4', 40)], 3, 'm1');
  assert.deepEqual(items.map(item => `${item.kind}:${item.id}`), ['trigger:r4', 'slack:m3', 'trigger:r2', 'slack:m1']);
  assert.equal(laneWorthy(run('s', 1, 'skipped')), false);
  assert.equal(laneWorthy(run('c', 1, 'coalesced')), false);
  assert.equal(laneWorthy(run('e', 1, 'error')), true);
  assert.deepEqual(mergeTriggerEvents([run('a', 5, 'running')], [run('a', 5, 'queued'), run('b', 1)]).map(item => `${item.id}:${item.status}`), ['a:running', 'b:completed']);
  // A copy pushed out of the live list keeps updating from the run itself: the later update wins.
  const fresher = run('a', 5, 'completed', { updatedAt: '2026-09-24T01:00:00Z' });
  assert.equal(mergeTriggerEvents([run('a', 5, 'running')], [fresher])[0].status, 'completed');
  // Runs recorded at the same moment keep a stable order.
  assert.deepEqual(mergeTriggerEvents([run('x', 5), run('y', 5)], []).map(item => item.id), ['y', 'x']);
});

test('the lane appears for Slack or any trigger, and takes over where the Slack monitor was left', () => {
  assert.equal(monitorVisible(false, undefined), false);
  assert.equal(monitorVisible(false, { triggers: [{ id: 's', name: 'Slack', enabled: true, kind: 'slack', revision: 0, updatedAt: '', updatedBy: { kind: 'owner', via: 'ui' } }], recent: [] }), false);
  assert.equal(monitorVisible(false, { triggers: [{ id: 'a', name: 'A', enabled: false, kind: 'http', revision: 1, updatedAt: '', updatedBy: { kind: 'owner', via: 'ui' } }], recent: [] }), true);
  assert.equal(monitorVisible(true, undefined), true);
  const storage = (values: Record<string, string>) => ({ values, getItem: (key: string) => values[key] ?? null, setItem: (key: string, value: string) => { values[key] = value; } });
  const earlier = storage({ [SLACK_POSITION_KEY]: '{"x":5,"y":6}' });
  assert.deepEqual(readMonitorPosition(earlier), { x: 5, y: 6 });
  assert.equal(earlier.values[TRIGGER_POSITION_KEY], '{"x":5,"y":6}', 'carried over once into the lane’s own key');
  assert.deepEqual(readMonitorPosition(storage({ [SLACK_POSITION_KEY]: '{"x":5,"y":6}', [TRIGGER_POSITION_KEY]: '{"x":1,"y":2}' })), { x: 1, y: 2 });
});

test('runs finished before the monitor was first used start out read, even when loaded later', () => {
  assert.deepEqual(readTriggerState(null), {});
  assert.deepEqual(readTriggerState('{"a":"x","b":3}'), { a: 'x' });
  assert.deepEqual(readTriggerState('broken'), {});
  const since = '2026-09-24T00:10:00Z';
  assert.equal(triggerUnread(run('old', 1), {}, since), false, 'finished before first use');
  assert.equal(triggerUnread(run('later', 20), {}, since), true);
  assert.equal(triggerUnread(run('later', 20), { later: 'completed:2026-09-24T00:20:30Z' }, since), false);
  assert.equal(triggerUnread(run('working', 20, 'running'), {}, since), false);
  assert.equal(triggerUnread(run('skipped', 20, 'skipped'), {}, since), false);
  assert.equal(triggerUnread(run('later', 20), {}, null), false, 'nothing is unread before the start is recorded');
});

test('trigger run cards show their state, and working runs reuse the activity border', () => {
  assert.match(node({ event: run('r', 1, 'running'), selected: false }), /agent-activity-border/);
  const failed = node({ event: run('r', 1, 'error', { error: 'The folder is gone' }), selected: false });
  assert.match(failed, /trigger-event-card failed/);
  assert.match(failed, /title="The folder is gone"/);
  assert.match(node({ event: run('r', 1), selected: true, unread: true }), /읽지 않음/);
  assert.match(node({ event: run('r', 1, 'completed', { kind: 'http' }), selected: false }), /Nightly report/);
});

test('a run shows why it ran, what it saw and what went wrong, without executing markup', () => {
  const html = renderToStaticMarkup(createElement(TriggerEventDetail, { token: '', onNavigate() {}, eventId: 'r', initial: run('r', 1, 'error', {
    kind: 'http', summary: 'HTTP 200 · down', error: 'Auto Prompt could not route this run.', payload: { status: 200, selected: '<b>down</b>', trimmed: true },
    input: { instructions: 'Check the status page', provider: 'codex', approvals: 'auto', target: { node: 'local', mode: 'auto' }, untrustedInput: true, overlap: 'skip' } }) }));
  for (const text of ['Nightly report', 'HTTP 응답', 'HTTP 200 · down', 'Auto Prompt could not route this run.', 'Check the status page', '받은 응답']) assert.ok(html.includes(text), text);
  assert.ok(html.includes('&lt;b&gt;down&lt;/b&gt;'));
  assert.ok(!html.includes('<b>down</b>'));
});

test('a long history keeps its newest 500 runs, and runs still working always stay', () => {
  const many = Array.from({ length: 600 }, (_, index) => run(`r${String(index).padStart(3, '0')}`, 0, index === 0 ? 'running' : 'completed',
    { receivedAt: new Date(Date.UTC(2026, 8, 24, 0, 0, 600 - index)).toISOString() }));
  const kept = keepTriggerEvents(many);
  assert.equal(kept.length, 500);
  assert.ok(kept.some(event => event.id === 'r000'));
  const oldWorking = [...many.slice(1), run('old', 0, 'running', { receivedAt: '2026-09-23T00:00:00Z' })];
  assert.ok(keepTriggerEvents(oldWorking).some(event => event.id === 'old'));
  assert.equal(keepTriggerEvents(many.slice(0, 10)).length, 10);
});

test('an open run renders from its own copy even when it is no longer in the list', () => {
  const html = renderToStaticMarkup(createElement(TriggerEventDetail, { token: '', onNavigate() {}, eventId: 'gone' }));
  assert.match(html, /불러오는 중/);
});

test('a snapshot joins the runs already shown, starts over after a gap, and flags runs that finished unseen', () => {
  const page = (from: number, count: number, status: TriggerEvent['status'] = 'completed') => Array.from({ length: count }, (_, index) => run(`e${from + index}`, from + index, status)).reverse();
  const shown = [...page(20, 20), ...page(0, 20)];
  const joined = reconcileSnapshot(shown, page(21, 20));
  assert.equal(joined.joined, true);
  assert.equal(joined.next.length, 41);
  const newer = Array.from({ length: 20 }, (_, index) => run(`n${index}`, 50, 'completed', { receivedAt: `2026-09-24T01:${String(index).padStart(2, '0')}:00Z` }));
  const gap = reconcileSnapshot(shown, newer);
  assert.equal(gap.joined, false);
  assert.ok(gap.next.every(event => event.id.startsWith('n')), 'no run from before the gap stays next to the new ones');
  const working = run('w', 5, 'running');
  const later = reconcileSnapshot([...page(20, 20), working], page(21, 20), []);
  assert.deepEqual(later.stale, ['w'], 'no longer listed as working, so it is read again');
  assert.deepEqual(reconcileSnapshot([...page(20, 20), working], page(21, 20), [working]).stale, []);
});

test('runs are read again a few at a time until all are done, and a failed read is tried again later', async () => {
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  let peak = 0;
  const done: string[] = [];
  const queue = new RecheckQueue(id => new Promise<void>((resolve, reject) => { pending.set(id, { resolve: () => { done.push(id); resolve(); }, reject }); peak = Math.max(peak, pending.size); }), { concurrency: 4, retryMs: 5 });
  const settle = async (id: string, fail = false) => { const call = pending.get(id)!; pending.delete(id); if (fail) call.reject(new Error('offline')); else call.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
  queue.add(Array.from({ length: 41 }, (_, index) => `r${index}`));
  queue.add(Array.from({ length: 41 }, (_, index) => `r${index}`));
  assert.equal(pending.size, 4);
  await settle('r0', true);
  while (pending.size) await settle([...pending.keys()][0]);
  await new Promise(resolve => setTimeout(resolve, 20));
  while (pending.size) await settle([...pending.keys()][0]);
  assert.equal(peak, 4, 'never more than four at once, however often runs are added');
  assert.equal(new Set(done).size, 41, 'every run was read, the failed one on a later try');
  queue.add(['late']);
  queue.stop();
  const permanent = new RecheckQueue(async () => { throw new Error('Unknown Tower operation.'); }, { retryMs: 1, permanent: error => /Unknown Tower operation/.test(String(error)) });
  permanent.add(['x']);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(permanent.busy + permanent.queued, 0, 'a worker that cannot answer is not asked again');
});

test('a failed read waits before it is tried again, however often the run is added, and nothing continues after stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
  let calls = 0;
  let fail = true;
  const queue = new RecheckQueue(async () => { calls++; if (fail) throw new Error('offline'); }, { retryMs: 15_000 });
  queue.add(['a']);
  await flush();
  for (let index = 0; index < 10; index++) { queue.add(['a']); await flush(); }
  assert.equal(calls, 1, 'adding it again while it waits does not read it again');
  fail = false;
  t.mock.timers.tick(14_999);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 2, 'read again once the wait is over');
  const permanent = new RecheckQueue(async () => { calls++; throw new Error('Unknown Tower operation.'); }, { retryMs: 1, permanent: error => /Unknown Tower operation/.test(String(error)) });
  permanent.add(['x']); await flush(); permanent.add(['x']); await flush();
  assert.equal(calls, 3, 'a worker that cannot answer is asked once');
  // A read that finishes after stop, even once the queue has started again, changes nothing.
  const releases: Array<() => void> = [];
  const seen: boolean[] = [];
  const stopping = new RecheckQueue((_id, current) => new Promise<void>(resolve => { releases.push(() => { seen.push(current()); resolve(); }); }), { retryMs: 1 });
  stopping.add(['s']);
  stopping.stop();
  stopping.start();
  stopping.add(['t']);
  assert.equal(stopping.busy, 1, 'starting again accepts new work');
  releases[0]();
  releases[1]();
  await flush();
  assert.deepEqual(seen, [false, true]);
  assert.equal(stopping.busy, 0);
});
