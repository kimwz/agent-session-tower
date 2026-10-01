import test from 'node:test';
import assert from 'node:assert/strict';
import { filledSessionTarget, offeredCandidates, resumeCandidates } from '../../../client/src/triggers/resume-candidates.js';
import type { Session } from '../../../shared/types.js';

const session = (id: string, extra: Partial<Session> = {}): Session => ({ id, nativeId: id, provider: 'claude', title: id, cwd: '/w', project: 'w', status: 'idle', statusReason: '',
  createdAt: '', updatedAt: '', lastMessage: '', messageCount: 1, isSubagent: false, resumable: true, ...extra });

test('a joined computer\'s candidates are its resumable conversations of the provider, at most 80', () => {
  const sessions = [session('a'), session('codex', { provider: 'codex' }), session('sub', { isSubagent: true }), session('master', { master: true }), session('done', { resumable: false }),
    ...Array.from({ length: 100 }, (_, index) => session(`bulk-${index}`))];
  const candidates = resumeCandidates(sessions, 'claude');
  assert.equal(candidates.length, 80);
  assert.equal(candidates[0].id, 'a');
  assert.ok(candidates.every(item => item.provider === 'claude' && !item.isSubagent && !item.master && item.resumable));
});

test('candidates offered from the server are the chosen provider\'s, even while the answer for it is still on its way', () => {
  assert.deepEqual(offeredCandidates([session('a'), session('b', { provider: 'codex' })], 'codex').map(item => item.id), ['b']);
});

test('a session target chosen before the candidates arrived takes the first of them; a chosen one is kept', () => {
  const empty = { node: 'local', mode: 'session', sessionId: '' } as const;
  assert.equal(filledSessionTarget(empty, []), undefined);
  assert.deepEqual(filledSessionTarget(empty, [session('first'), session('second')]), { node: 'local', mode: 'session', sessionId: 'first' });
  assert.equal(filledSessionTarget({ ...empty, sessionId: 'second' }, [session('first')]), undefined);
  assert.equal(filledSessionTarget({ node: 'local', mode: 'auto' }, [session('first')]), undefined);
});
