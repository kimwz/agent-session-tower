import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishedSlackDelegatedSessionIds } from '../../shared/slack-delegated-sessions.js';
import type { SlackWorkflow } from '../../shared/slack.js';
import type { Session, Run } from '../../shared/types.js';
const session = (id: string, extra: Partial<Session> = {}): Session => ({ id, nativeId: id, provider: 'codex', title: id, cwd: '/repo', project: 'repo', status: 'idle', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 1, isSubagent: false, resumable: true, ...extra });
test('only finished owned delegates and proven idle descendants leave canvas; active, reused, coordinator and unrelated sessions remain', () => {
  const workflows = [{ mode: 'conversation', sessionId: 'coordinator', delegatedTasks: [{ createdSessionId: 'delegate', delegatedFinished: true }, { delegatedRunId: 'reused' }, { createdSessionId: 'coordinator', delegatedFinished: true }] }] as SlackWorkflow[];
  const sessions = [session('delegate'), session('child', { parentId: 'delegate', isSubagent: true }), session('grandchild', { parentId: 'child', isSubagent: true }), session('queued', { parentId: 'delegate', isSubagent: true }), session('working', { parentId: 'delegate', isSubagent: true, status: 'working' }), session('native-active', { parentId: 'delegate', isSubagent: true, activeProcess: true }), session('wrong-provider', { parentId: 'delegate', isSubagent: true, provider: 'claude' }), session('reused'), session('coordinator'), session('unrelated')];
  const runs = [{ id: 'q', sessionId: 'queued', status: 'queued' }] as Run[];
  assert.deepEqual([...finishedSlackDelegatedSessionIds(workflows, sessions, runs)], ['child', 'grandchild']);
  assert.equal(finishedSlackDelegatedSessionIds(workflows, sessions, [...runs, { sessionId: 'delegate', status: 'running' } as Run]).has('delegate'), false);
});

test('provider-prefixed parent aliases protect the whole ancestor chain during descendant work', () => {
  const workflows = [{ delegatedTasks: [{ createdSessionId: 'codex:new:monitor', delegatedFinished: true }] }] as SlackWorkflow[];
  const sessions = [session('codex:new:monitor', { nativeId: 'native' }), session('child', { parentId: 'codex:native', isSubagent: true }), session('leaf', { parentId: 'child', isSubagent: true, status: 'working' })];
  assert.equal(finishedSlackDelegatedSessionIds(workflows, sessions, []).size, 0);
  sessions[2].status = 'idle';
  assert.deepEqual([...finishedSlackDelegatedSessionIds(workflows, sessions, [])], sessions.map(session => session.id));
});
