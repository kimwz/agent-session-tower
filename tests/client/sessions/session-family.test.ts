import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '../../../shared/types.js';
import { getMainSessionId, getMainSessions, getSessionFamily } from '../../../client/src/sessions/session-family.js';
import { sessionActivityAt, sortSessions } from '../../../client/src/common/lib.js';
import { graphSessionGroups } from '../../../client/src/graph/graph-layout.js';

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id, nativeId: id, provider: 'codex', title: id, cwd: '/work', project: 'work',
    status: 'idle', statusReason: '', createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T01:00:00.000Z', lastMessage: '', messageCount: 0,
    isSubagent: false, resumable: true, ...extra,
  };
}

test('automatic children and nested descendants share the main session, user forks stay independent', () => {
  const root = session('root');
  const child = session('child', { parentId: root.id, isSubagent: true });
  const sibling = session('sibling', { parentId: root.id, isSubagent: true });
  const nested = session('nested', { parentId: child.id, isSubagent: true });
  const fork = session('fork', { parentId: root.id });
  const forkChild = session('fork-child', { parentId: fork.id, isSubagent: true });
  const sessions = [nested, forkChild, sibling, child, root, fork];
  assert.deepEqual(getMainSessions(sessions).map(item => item.id), ['root', 'fork']);
  assert.equal(getMainSessionId(sessions, nested.id), root.id);
  assert.equal(getMainSessionId(sessions, forkChild.id), fork.id);
  assert.equal(getMainSessionId(sessions, 'missing'), null);
  assert.equal(getMainSessionId(sessions, null), null);
  const family = getSessionFamily(sessions, nested.id);
  assert.equal(family.root, root);
  assert.deepEqual(family.members.map(item => item.id), ['root', 'child', 'nested', 'sibling']);
  assert.deepEqual(getSessionFamily(sessions, fork.id).members.map(item => item.id), ['fork', 'fork-child']);
});

test('missing parents preserve an accessible orphan root and its descendants', () => {
  const orphan = session('orphan', { isSubagent: true, parentId: 'missing' });
  const child = session('child', { isSubagent: true, parentId: orphan.id });
  const detached = session('detached', { isSubagent: true });
  const sessions = [child, detached, orphan];
  assert.deepEqual(getMainSessions(sessions).map(item => item.id), ['detached', 'orphan']);
  assert.equal(getMainSessionId(sessions, child.id), orphan.id);
  assert.deepEqual(getSessionFamily(sessions, child.id).members.map(item => item.id), ['orphan', 'child']);
  assert.deepEqual(getSessionFamily(sessions, 'missing'), { members: [] });
});

test('a proven Claude to Codex review stays in its parent family instead of creating a worktree project card', () => {
  const root = session('claude:project', { provider: 'claude', cwd: '/verse8-orchestrator' });
  const reviewer = session('claude:reviewer', { provider: 'claude', parentId: root.id, isSubagent: true });
  const cli = session('codex:review', { parentId: reviewer.id, parentLink: 'exec', isSubagent: true, cwd: '/onestore.wt-review-169' });
  const nested = session('codex:nested', { parentId: cli.id, isSubagent: true, cwd: cli.cwd });
  const manual = session('codex:manual', { cwd: cli.cwd });
  const sessions = [cli, nested, reviewer, root, manual];
  assert.deepEqual(getMainSessions(sessions), [root, manual]);
  assert.equal(getMainSessionId(sessions, nested.id), root.id);
  assert.deepEqual(getSessionFamily(sessions, cli.id).members, [root, reviewer, cli, nested]);
});

test('cyclic parent metadata chooses the same accessible representative for every input order', () => {
  const a = session('a', { isSubagent: true, parentId: 'b' });
  const b = session('b', { isSubagent: true, parentId: 'c' });
  const c = session('c', { isSubagent: true, parentId: 'a' });
  const descendant = session('descendant', { isSubagent: true, parentId: 'b' });
  for (const sessions of [[a, b, c, descendant], [descendant, c, b, a]]) {
    assert.deepEqual(getMainSessions(sessions).map(item => item.id), ['a']);
    for (const member of sessions) assert.equal(getMainSessionId(sessions, member.id), 'a');
    assert.deepEqual(getSessionFamily(sessions, descendant.id).members.map(item => item.id), ['a', 'c', 'b', 'descendant']);
  }
  const self = session('self', { isSubagent: true, parentId: 'self' });
  assert.deepEqual(getSessionFamily([self], self.id), { root: self, members: [self] });
});

test('family tabs stay in creation order when children stream or complete', () => {
  const root = session('root');
  const early = session('z-early', { parentId: root.id, isSubagent: true, createdAt: '2026-09-15T00:01:00.000Z' });
  const later = session('a-later', { parentId: root.id, isSubagent: true, createdAt: '2026-09-15T00:02:00.000Z' });
  const before = [root, later, early];
  const after = before.map(item => ({ ...item, updatedAt: '2026-09-15T23:00:00.000Z', status: 'completed' as const, lastCompletedAt: '2026-09-15T23:00:00.000Z' }));
  assert.deepEqual(getSessionFamily(before, early.id).members.map(item => item.id), ['root', 'z-early', 'a-later']);
  assert.deepEqual(getSessionFamily(after, early.id).members.map(item => item.id), ['root', 'z-early', 'a-later']);
});

test('main ordering changes only for requests or completion, with deterministic historical fallback', () => {
  const requested = session('request', { lastRequestAt: '2026-09-15T02:00:00.000Z' });
  const completed = session('complete', { lastRequestAt: '2026-09-15T01:00:00.000Z', lastCompletedAt: '2026-09-15T03:00:00.000Z' });
  const a = session('a');
  const b = session('b', { status: 'working', updatedAt: '2026-09-16T00:00:00.000Z' });
  const values = [b, requested, a, completed];
  const ids = (sessions: Session[]) => [...sessions].sort(sortSessions).map(item => item.id);
  assert.deepEqual(ids(values), ['complete', 'request', 'a', 'b']);
  assert.deepEqual(ids(values.map(item => ({ ...item, status: item.status === 'working' ? 'completed' : 'working', updatedAt: '2026-10-01T00:00:00.000Z', lastMessage: 'Streaming delta' }))), ids(values));
  assert.deepEqual(ids(values.map(item => item.id === 'request' ? { ...item, lastRequestAt: '2026-09-15T04:00:00.000Z' } : item)), ['request', 'complete', 'a', 'b']);
  assert.deepEqual(ids(values.map(item => item.id === 'a' ? { ...item, lastCompletedAt: '2026-09-15T05:00:00.000Z' } : item)), ['a', 'complete', 'request', 'b']);
  assert.equal(sessionActivityAt(session('invalid', { lastRequestAt: 'invalid', lastCompletedAt: 'invalid' })), a.createdAt);
});

test('subagent activity does not move its main session', () => {
  const root = session('root', { lastRequestAt: '2026-09-15T01:00:00.000Z' });
  const other = session('other', { lastRequestAt: '2026-09-15T02:00:00.000Z' });
  const child = session('child', { parentId: root.id, isSubagent: true, lastCompletedAt: '2026-09-15T23:00:00.000Z' });
  assert.deepEqual(getMainSessions([root, child, other]).sort(sortSessions).map(item => item.id), ['other', 'root']);
});

test('graph cutoff, project lanes, and node order ignore stream and status updates', () => {
  const sessions = Array.from({ length: 10 }, (_, index) => session(String(index), {
    cwd: index % 2 ? '/alpha' : '/beta', project: index % 2 ? 'alpha' : 'beta',
    lastRequestAt: `2026-09-15T${String(index).padStart(2, '0')}:00:00.000Z`,
  }));
  const layout = (items: Session[], selected: string | null = null) => graphSessionGroups(items, 8, selected).map(([path, members]) => [path, members.map(item => item.id)]);
  const expected = [['/alpha', ['9', '7', '5', '3']], ['/beta', ['8', '6', '4', '2']]];
  assert.deepEqual(layout(sessions), expected);
  const streamed = [...sessions].reverse().map(item => ({ ...item, status: (Number(item.id) < 4 ? 'working' : 'completed') as Session['status'], updatedAt: `2026-09-16T${item.id.padStart(2, '0')}:00:00.000Z`, lastMessage: 'Partial answer' }));
  assert.deepEqual(layout(streamed), expected);
  assert.deepEqual(layout(streamed, '0'), [['/alpha', ['9', '7', '5', '3']], ['/beta', ['8', '6', '4', '2', '0']]]);
  const requested = sessions.map(item => item.id === '0' ? { ...item, lastRequestAt: '2026-09-15T23:00:00.000Z' } : item);
  assert.deepEqual(layout(requested), [['/beta', ['0', '8', '6', '4']], ['/alpha', ['9', '7', '5', '3']]]);
});
