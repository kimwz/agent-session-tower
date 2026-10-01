import test from 'node:test';
import assert from 'node:assert/strict';
import type { AutoPromptJob, Run, Session } from '../../shared/types.js';
import { scopeFromBody, scopeFromParams, scopeParams, sameScope, sessionSelector, sessionSummary, temporaryFolder } from '../../shared/session-scope.js';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
function session(id: string, extra: Partial<Session> = {}): Session {
  return { id, nativeId: id, provider: 'claude', title: id, cwd: '/work/app', project: 'app', status: 'completed', statusReason: '', createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1), lastCompletedAt: hoursAgo(1), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true, ...extra };
}
const run = (sessionId: string, status: Run['status']): Run => ({ id: `run-${sessionId}-${status}`, sessionId, prompt: '', status, createdAt: hoursAgo(0), output: '' });
const ids = (sessions: Session[]) => sessions.map(item => item.id);

test('a scope is read from the page request and written back the same way; anything else is the whole list', () => {
  const scope = scopeFromParams(new URLSearchParams('scoped=1&days=7&closed=1&focus=claude:a'));
  assert.deepEqual(scope, { days: 7, closed: true, focus: 'claude:a' });
  assert.deepEqual(scopeFromParams(new URLSearchParams(scopeParams(scope!))), scope);
  assert.equal(scopeFromParams(new URLSearchParams('patch=1&nodes=1')), undefined);
  assert.deepEqual(scopeFromParams(new URLSearchParams('scoped=1&days=all')), { closed: false });
  assert.deepEqual(scopeFromBody({ days: -3, closed: 'yes', focus: 'x'.repeat(2000) }), { closed: false });
  assert.deepEqual(scopeFromBody(null), { closed: false });
  assert.ok(sameScope({ days: 1, closed: false }, { days: 1, closed: false }));
  assert.ok(!sameScope({ days: 1, closed: false }, { days: 1, closed: false, focus: 'a' }));
});

test('the default scope holds only the open main sessions the list can show', () => {
  const sessions = [
    session('recent'),
    session('old', { lastCompletedAt: hoursAgo(72), createdAt: hoursAgo(80) }),
    session('old-working', { lastCompletedAt: hoursAgo(72), status: 'working' }),
    session('old-waiting', { lastCompletedAt: hoursAgo(72), outcome: 'needsOwner' }),
    session('old-process', { lastCompletedAt: hoursAgo(72), activeProcess: true }),
    session('archived', { closed: true }),
    session('sub', { isSubagent: true, parentId: 'recent' }),
    session('review-run', { launchedByAgent: true }),
    session('master', { master: true }),
  ];
  const select = sessionSelector({ sessions, runs: [] }, NOW);
  assert.deepEqual(ids(select({ days: 1, closed: false })), ['recent', 'old-working', 'old-waiting', 'old-process']);
  assert.deepEqual(ids(select({ closed: false })), ['recent', 'old', 'old-working', 'old-waiting', 'old-process']);
  // The archived list shows every closed main session, whatever its age.
  assert.deepEqual(ids(select({ days: 1, closed: true })), ['recent', 'old-working', 'old-waiting', 'old-process', 'archived']);
});

test('opening a session brings its whole family, by any id it is known by', () => {
  const sessions = [
    session('root', { lastCompletedAt: hoursAgo(100) }),
    session('child', { isSubagent: true, parentId: 'root' }),
    session('grandchild', { isSubagent: true, parentId: 'child' }),
    session('other'),
    session('other-child', { isSubagent: true, parentId: 'other' }),
    session('codex:monitor-1', { nativeId: 'native-1', provider: 'codex', closed: true }),
  ];
  const select = sessionSelector({ sessions, runs: [] }, NOW);
  assert.deepEqual(ids(select({ days: 1, closed: false, focus: 'grandchild' })), ['root', 'child', 'grandchild', 'other']);
  assert.deepEqual(ids(select({ days: 1, closed: false, focus: 'codex:native-1' })), ['other', 'codex:monitor-1']);
  assert.deepEqual(ids(select({ days: 1, closed: false, focus: 'gone' })), ['other']);
});

test('sessions a turn or a pending Auto Prompt names stay with their ancestors, and a busy family marks its root', () => {
  const sessions = [
    session('root', { lastCompletedAt: hoursAgo(100) }),
    session('child', { isSubagent: true, parentId: 'root', lastCompletedAt: hoursAgo(100) }),
    session('target', { lastCompletedAt: hoursAgo(100) }),
    session('done-target', { lastCompletedAt: hoursAgo(100) }),
    session('recent'),
    session('recent-child', { isSubagent: true, parentId: 'recent', status: 'working' }),
  ];
  const jobs = [{ id: 'job', status: 'routing', targetSessionId: 'target' }, { id: 'old', status: 'completed', sessionId: 'done-target' }] as AutoPromptJob[];
  const select = sessionSelector({ sessions, runs: [run('child', 'running'), run('root', 'completed')], autoPrompts: jobs }, NOW);
  const shown = select({ days: 1, closed: false });
  assert.deepEqual(ids(shown), ['root', 'child', 'target', 'recent']);
  assert.equal(shown.find(item => item.id === 'root')!.familyActive, true);
  assert.equal(shown.find(item => item.id === 'recent')!.familyActive, true);
  assert.equal(shown.find(item => item.id === 'target')!.familyActive, undefined);
  // The complete snapshot's sessions are not changed.
  assert.equal(sessions[0].familyActive, undefined);
});

test('the summary counts and lists every main session, as the page would from all of them', () => {
  const sessions = [
    session('a', { status: 'working', cwd: '/work/a', project: 'a' }),
    session('b', { cwd: '/work/b', project: 'b', lastCompletedAt: hoursAgo(500) }),
    session('c', { closed: true, cwd: '/work/c', project: 'c' }),
    session('sub', { isSubagent: true, parentId: 'a', cwd: '/work/sub' }),
    session('run', { launchedByAgent: true, cwd: '/work/run' }),
  ];
  const summary = sessionSummary(sessions, []);
  assert.deepEqual(summary.counts, { open: 2, closed: 1, working: 1, completed: 1 });
  assert.deepEqual(summary.projects, [{ cwd: '/work/a', project: 'a', open: true }, { cwd: '/work/b', project: 'b', open: true }, { cwd: '/work/c', project: 'c', open: false }]);
  assert.equal(summary.canvasHistory, true);
});

test('canvas history leaves out temporary folders and finished trigger sessions, but not a trigger session still at work', () => {
  assert.ok(temporaryFolder('/tmp/x') && temporaryFolder('/private/tmp') && !temporaryFolder('/work/tmp'));
  const trigger = { kind: 'trigger', triggerId: 't' } as const;
  assert.equal(sessionSummary([session('t', { cwd: '/tmp/w' }), session('c', { closed: true })], []).canvasHistory, false);
  assert.equal(sessionSummary([session('t', { launchedBy: trigger })], []).canvasHistory, false);
  assert.equal(sessionSummary([session('t', { launchedBy: trigger }), session('s', { isSubagent: true, parentId: 't', status: 'working' })], []).canvasHistory, true);
  assert.equal(sessionSummary([session('t', { launchedBy: trigger })], [run('t', 'queued')]).canvasHistory, true);
});
