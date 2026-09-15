import test from 'node:test';
import assert from 'node:assert/strict';
import type { Run, Session } from '../shared/types.js';
import { acknowledgeSession, conversationRevision, parseReadState, pruneReadState } from '../client/src/session-read-state.js';

const session: Session = { id: 'codex:example', nativeId: 'example', provider: 'codex', title: 'Title', cwd: '/work', project: 'work', status: 'idle', statusReason: '', createdAt: '2026-09-15T00:00:00Z', updatedAt: '2026-09-15T01:00:00Z', lastMessage: 'Original answer', messageCount: 2, isSubagent: false, resumable: true };
test('acknowledging displayed content remains read across title, process, and timestamp updates', () => {
  const revision = conversationRevision(session);
  const read = acknowledgeSession({}, session.id, revision);
  assert.equal(acknowledgeSession(read, session.id, revision), read);
  assert.equal(conversationRevision({ ...session, customTitle: 'New title', activeProcess: true, status: 'working', updatedAt: '2026-09-16T00:00:00Z' }), revision);
  assert.notEqual(conversationRevision({ ...session, lastMessage: 'New reply' }), revision);
  assert.notEqual(conversationRevision({ ...session, messageCount: 3 }), revision);
  assert.notEqual(conversationRevision({ ...session, lastRequestAt: '2026-09-15T02:00:00Z' }), revision);
  assert.notEqual(conversationRevision({ ...session, lastCompletedAt: '2026-09-15T02:00:00Z' }), revision);
});
test('new task output and failure become unread even before native history updates', () => {
  const run: Run = { id: 'new-run', sessionId: session.id, prompt: 'Do work', createdAt: '2026-09-15T02:00:00Z', status: 'running', output: '' };
  const before = conversationRevision(session, [run]);
  assert.notEqual(conversationRevision(session, [{ ...run, output: 'Working' }]), before);
  assert.notEqual(conversationRevision(session, [{ ...run, status: 'error', error: 'Failed' }]), before);
  assert.equal(conversationRevision(session, [{ ...run, sessionId: 'other' }]), conversationRevision(session));
});
test('read state survives serialization, rejects malformed state and prunes only against complete sessions', () => {
  const read = { [session.id]: conversationRevision(session), absent: 'old' };
  assert.deepEqual(parseReadState(JSON.stringify(read)), read);
  assert.deepEqual(parseReadState('invalid'), {});
  assert.deepEqual(parseReadState('[]'), {});
  assert.deepEqual(parseReadState('{"valid":"revision","invalid":32}'), { valid: 'revision' });
  assert.deepEqual(pruneReadState(read, [session]), { [session.id]: read[session.id] });
});
