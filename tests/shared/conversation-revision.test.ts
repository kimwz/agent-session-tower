import assert from 'node:assert/strict';
import test from 'node:test';
import { computeConversationRevision } from '../../shared/conversation-revision.ts';
import type { Run, Session } from '../../shared/types.ts';

const session: Session = {
  id: 'codex:fixture', nativeId: 'fixture', provider: 'codex', title: 'Fixture', cwd: '/work', project: 'work', status: 'idle', statusReason: '',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:05:00.000Z', lastMessage: 'Done', messageCount: 4,
  lastRequestAt: '2026-09-01T00:04:00.000Z', lastCompletedAt: '2026-09-01T00:05:00.000Z', isSubagent: false, resumable: true,
};
const run = (overrides: Partial<Run> = {}): Run => ({
  id: 'run-1', sessionId: session.id, prompt: 'Next', status: 'completed', output: 'ok', createdAt: '2026-09-01T00:06:00.000Z', ...overrides,
} as Run);

test('the revision format is stable, so read markers saved by earlier versions keep matching', () => {
  assert.equal(computeConversationRevision(session), '69:8e37fd23:30b85ced');
  assert.equal(computeConversationRevision(session, [run()]), '94:643b83fc:f0e9f340');
});

test('new conversation content changes the revision', () => {
  const base = computeConversationRevision(session, [run()]);
  assert.notEqual(computeConversationRevision({ ...session, messageCount: 5 }, [run()]), base);
  assert.notEqual(computeConversationRevision({ ...session, lastMessage: 'Done.' }, [run()]), base);
  assert.notEqual(computeConversationRevision({ ...session, lastCompletedAt: '2026-09-01T00:07:00.000Z' }, [run()]), base);
  assert.notEqual(computeConversationRevision(session, [run({ status: 'error', error: 'failed' })]), base);
  assert.notEqual(computeConversationRevision(session, [run({ output: 'ok, more' })]), base);
});

test('activity that is not conversation content leaves the revision alone', () => {
  const base = computeConversationRevision(session, [run()]);
  assert.equal(computeConversationRevision({ ...session, status: 'working', updatedAt: '2026-09-02T00:00:00.000Z', title: 'Renamed' }, [run()]), base);
  assert.equal(computeConversationRevision(session, [run(), run({ id: 'other', sessionId: 'codex:other', output: 'elsewhere' })]), base);
});

test('only the latest run of the session counts', () => {
  const older = run({ id: 'run-0', createdAt: '2026-09-01T00:05:30.000Z', output: 'old' });
  assert.equal(computeConversationRevision(session, [older, run()]), computeConversationRevision(session, [run(), older]));
  assert.equal(computeConversationRevision(session, [older, run()]), computeConversationRevision(session, [run()]));
});
