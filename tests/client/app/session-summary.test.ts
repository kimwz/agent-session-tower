import test from 'node:test';
import assert from 'node:assert/strict';
import { pageSummary } from '../../../client/src/app/session-summary.js';
import type { Session } from '../../../shared/types.js';
import type { SessionSummary } from '../../../shared/session-scope.js';

const at = '2026-10-01T00:00:00.000Z';
const session = (id: string, extra: Partial<Session> = {}): Session => ({ id, nativeId: id, provider: 'claude', title: id, cwd: `/work/${id}`, project: id,
  status: 'completed', statusReason: '', createdAt: at, updatedAt: at, lastMessage: '', messageCount: 1, isSubagent: false, resumable: true, ...extra });

test('this computer is counted from its summary and joined computers from the sessions at hand', () => {
  const local: SessionSummary = { counts: { open: 40, closed: 7, working: 2, completed: 30 }, canvasHistory: true,
    projects: [{ cwd: '/work/old', project: 'old', open: true }, { cwd: '/work/archived', project: 'archived', open: false }] };
  const node = 'a'.repeat(32);
  const held = [session('recent'), session(`@${node}/n1`, { node, status: 'working', cwd: `@${node}//work/n1` }), session(`@${node}/n2`, { node, closed: true, cwd: `@${node}//work/n2` })];
  const summary = pageSummary(local, held);
  assert.deepEqual(summary.counts, { open: 41, closed: 8, working: 3, completed: 30 });
  assert.deepEqual(summary.folders.map(folder => folder.cwd), ['/work/old', '/work/archived', `@${node}//work/n1`, `@${node}//work/n2`]);
  assert.deepEqual(summary.openFolders.map(folder => folder.cwd), ['/work/old', `@${node}//work/n1`]);
  assert.equal(summary.canvasHistory, true);
  assert.deepEqual(summary.uncounted.map(item => item.id), [`@${node}/n1`]);
});

test('without a summary every held session is counted, as before', () => {
  const summary = pageSummary(undefined, [session('a', { status: 'working' }), session('b', { closed: true })]);
  assert.deepEqual(summary.counts, { open: 1, closed: 1, working: 1, completed: 0 });
  assert.equal(summary.canvasHistory, false);
  assert.deepEqual(summary.uncounted.map(item => item.id), ['a']);
});
