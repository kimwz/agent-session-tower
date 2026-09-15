import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSessionStates } from '../server/snapshot.js';
import type { Run, Session } from '../shared/types.js';

const session: Session = {
  id: 'codex:1', nativeId: '1', provider: 'codex', title: 'Task', cwd: '/work', project: 'work',
  status: 'working', statusReason: 'Recent unfinished task in session log', createdAt: '2026-09-14T09:00:00.000Z',
  updatedAt: '2026-09-14T10:00:01.000Z', lastMessage: 'Running', messageCount: 2, isSubagent: false, resumable: true,
};
const run: Run = {
  id: 'managed-1', sessionId: session.id, prompt: 'Continue', status: 'cancelled', output: '',
  createdAt: '2026-09-14T10:00:00.000Z', startedAt: '2026-09-14T10:00:00.500Z', finishedAt: '2026-09-14T10:00:02.000Z',
};
const settled = new Set([run.id]);

test('known stopped managed turn overrides an unfinished native log immediately', () => {
  assert.equal(projectSessionStates([session], [run], settled)[0]?.status, 'error');
  assert.equal(projectSessionStates([session], [{ ...run, status: 'error' }], settled)[0]?.status, 'error');
  assert.equal(session.status, 'working', 'projection must not mutate native evidence');
});

test('queued cancellation and historical failures never override independent activity', () => {
  assert.equal(projectSessionStates([session], [{ ...run, startedAt: undefined }], settled)[0]?.status, 'working');
  assert.equal(projectSessionStates([{ ...session, updatedAt: '2026-09-14T10:00:03.000Z' }], [run], settled)[0]?.status, 'working');
  assert.equal(projectSessionStates([{ ...session, status: 'completed' }], [run], settled)[0]?.status, 'completed');
  assert.equal(projectSessionStates([{ ...session, status: 'idle' }], [run], settled)[0]?.status, 'idle');
  assert.equal(projectSessionStates([session], [run])[0]?.status, 'working', 'recovered history has no proof that a detached process exited');
});

test('newer instructions and active managed processes take precedence over old cancellations', () => {
  const next: Run = { ...run, id: 'managed-2', createdAt: '2026-09-14T10:00:03.000Z', status: 'queued', startedAt: undefined, finishedAt: undefined };
  assert.equal(projectSessionStates([session], [run, next], settled)[0]?.status, 'working');
  assert.equal(projectSessionStates([{ ...session, status: 'completed' }], [run, { ...next, status: 'running' }], settled)[0]?.status, 'working');
});

test('managed request and completion times use lifecycle boundaries, preserving stronger native evidence', () => {
  const native = { ...session, lastRequestAt: '2026-09-14T09:59:00.000Z', lastCompletedAt: '2026-09-14T09:59:30.000Z' };
  const queued = { ...run, status: 'queued' as const, startedAt: undefined, finishedAt: undefined };
  const queuedSession = projectSessionStates([native], [queued])[0]!;
  assert.equal(queuedSession.lastRequestAt, run.createdAt);
  assert.equal(queuedSession.lastCompletedAt, native.lastCompletedAt);
  const streaming = projectSessionStates([native], [{ ...run, status: 'running', output: 'Much more streamed output', finishedAt: undefined }])[0]!;
  assert.equal(streaming.lastRequestAt, run.createdAt);
  assert.equal(streaming.lastCompletedAt, native.lastCompletedAt);
  const completed = projectSessionStates([native], [{ ...run, status: 'completed' }])[0]!;
  assert.equal(completed.lastRequestAt, run.createdAt);
  assert.equal(completed.lastCompletedAt, run.finishedAt);
  const laterNative = { ...native, lastRequestAt: '2026-09-14T10:00:03.000Z', lastCompletedAt: '2026-09-14T10:00:04.000Z' };
  const preserved = projectSessionStates([laterNative], [{ ...run, status: 'completed' }])[0]!;
  assert.equal(preserved.lastRequestAt, laterNative.lastRequestAt);
  assert.equal(preserved.lastCompletedAt, laterNative.lastCompletedAt);
  assert.equal(native.lastRequestAt, '2026-09-14T09:59:00.000Z', 'projection cannot mutate native records');
});

test('only proven managed execution endings count as completion, excluding queued cancellation and restart recovery', () => {
  assert.equal(projectSessionStates([session], [{ ...run, startedAt: undefined }], settled)[0]?.lastCompletedAt, undefined);
  assert.equal(projectSessionStates([session], [run])[0]?.lastCompletedAt, undefined, 'a recovered cancellation has no proof of process exit');
  assert.equal(projectSessionStates([session], [{ ...run, status: 'error' }])[0]?.lastCompletedAt, undefined, 'recovered error can use manufactured restart finishedAt');
  assert.equal(projectSessionStates([session], [run], settled)[0]?.lastCompletedAt, run.finishedAt);
  assert.equal(projectSessionStates([session], [{ ...run, status: 'error' }], settled)[0]?.lastCompletedAt, run.finishedAt);
  const queuedLater = { ...run, id: 'queued-later', status: 'queued' as const, createdAt: '2026-09-14T10:00:04.000Z', startedAt: undefined, finishedAt: undefined };
  const projected = projectSessionStates([session], [{ ...run, status: 'completed' }, queuedLater])[0]!;
  assert.equal(projected.lastRequestAt, queuedLater.createdAt);
  assert.equal(projected.lastCompletedAt, run.finishedAt, 'a newer queued request does not erase the previous completion');
});

test('invalid managed lifecycle dates cannot replace valid session times', () => {
  const native = { ...session, lastRequestAt: session.createdAt, lastCompletedAt: session.updatedAt };
  const result = projectSessionStates([native], [{ ...run, createdAt: 'invalid', status: 'completed', finishedAt: 'invalid' }])[0]!;
  assert.equal(result.lastRequestAt, native.lastRequestAt);
  assert.equal(result.lastCompletedAt, native.lastCompletedAt);
});
