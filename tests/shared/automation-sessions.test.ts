import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishedAutomationSessionIds } from '../../shared/automation-sessions.js';
import type { SlackWorkflow } from '../../shared/slack.js';
import type { Session, Run } from '../../shared/types.js';
const session = (id: string, extra: Partial<Session> = {}): Session => ({ id, nativeId: id, provider: 'codex', title: id, cwd: '/repo', project: 'repo', status: 'idle', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 1, isSubagent: false, resumable: true, ...extra });
test('only finished owned delegates and proven idle descendants leave canvas; active, reused, coordinator and unrelated sessions remain', () => {
  const workflows = [{ mode: 'conversation', sessionId: 'coordinator', delegatedTasks: [{ createdSessionId: 'delegate', delegatedFinished: true }, { delegatedRunId: 'reused' }, { createdSessionId: 'coordinator', delegatedFinished: true }] }] as SlackWorkflow[];
  const sessions = [session('delegate'), session('child', { parentId: 'delegate', isSubagent: true }), session('grandchild', { parentId: 'child', isSubagent: true }), session('queued', { parentId: 'delegate', isSubagent: true }), session('working', { parentId: 'delegate', isSubagent: true, status: 'working' }), session('native-active', { parentId: 'delegate', isSubagent: true, activeProcess: true }), session('wrong-provider', { parentId: 'delegate', isSubagent: true, provider: 'claude' }), session('reused'), session('coordinator'), session('unrelated')];
  const runs = [{ id: 'q', sessionId: 'queued', status: 'queued' }] as Run[];
  assert.deepEqual([...finishedAutomationSessionIds(workflows, sessions, runs)], ['child', 'grandchild']);
  assert.equal(finishedAutomationSessionIds(workflows, sessions, [...runs, { sessionId: 'delegate', status: 'running' } as Run]).has('delegate'), false);
});

test('provider-prefixed parent aliases protect the whole ancestor chain during descendant work', () => {
  const workflows = [{ delegatedTasks: [{ createdSessionId: 'codex:new:monitor', delegatedFinished: true }] }] as SlackWorkflow[];
  const sessions = [session('codex:new:monitor', { nativeId: 'native' }), session('child', { parentId: 'codex:native', isSubagent: true }), session('leaf', { parentId: 'child', isSubagent: true, status: 'working' })];
  assert.equal(finishedAutomationSessionIds(workflows, sessions, []).size, 0);
  sessions[2].status = 'idle';
  assert.deepEqual([...finishedAutomationSessionIds(workflows, sessions, [])], sessions.map(session => session.id));
});

test('proven cross-provider CLI descendants disappear with Slack work while active children remain protected', () => {
  const workflows = [{ delegatedTasks: [{ createdSessionId: 'claude:delegate', delegatedFinished: true }] }] as SlackWorkflow[];
  const sessions = [session('claude:delegate', { provider: 'claude', nativeId: 'delegate' }),
    session('claude:reviewer', { provider: 'claude', nativeId: 'reviewer', parentId: 'claude:delegate', isSubagent: true }),
    session('codex:exec', { nativeId: 'exec', parentId: 'claude:reviewer', parentLink: 'exec', isSubagent: true, cwd: '/repo.wt-review-169' }),
    session('codex:child', { nativeId: 'child', parentId: 'codex:exec', isSubagent: true }),
    session('unrelated', { cwd: '/repo.wt-review-169' }),
    session('unproven', { parentId: 'claude:reviewer', isSubagent: true })];
  assert.deepEqual([...finishedAutomationSessionIds(workflows, sessions, [])], sessions.slice(0, 4).map(session => session.id));
  sessions[3].activeProcess = true;
  assert.equal(finishedAutomationSessionIds(workflows, sessions, []).size, 0);
});

test('a session a trigger created leaves the canvas once its work is done, not while it runs', () => {
  const base = { nativeId: 'n', provider: 'codex' as const, title: 't', cwd: '/p', project: 'p', status: 'completed' as const, statusReason: '', createdAt: '', updatedAt: '',
    lastMessage: '', messageCount: 1, isSubagent: false, resumable: true };
  const sessions = [{ ...base, id: 'scheduled', launchedBy: { kind: 'trigger' as const, triggerId: 'daily' } }, { ...base, id: 'mine' }];
  assert.deepEqual([...finishedAutomationSessionIds([], sessions, [])], ['scheduled']);
  assert.equal(finishedAutomationSessionIds([], sessions, [{ id: 'r', sessionId: 'scheduled', prompt: '', status: 'running', createdAt: '', output: '' }]).size, 0);
});
