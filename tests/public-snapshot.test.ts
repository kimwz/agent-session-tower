import test from 'node:test';
import assert from 'node:assert/strict';
import { publicSnapshot } from '../server/http/public-snapshot.js';
import { conversationRevision } from '../client/src/sessions/session-read-state.js';
import type { Run, Session, Snapshot } from '../shared/types.js';

const session: Session = { id: 'claude:example', nativeId: 'example', provider: 'claude', title: 'Fixture', cwd: '/work', project: 'work',
  status: 'working', statusReason: '', createdAt: '2026-09-15T00:00:00Z', updatedAt: '2026-09-15T01:00:00Z', lastMessage: 'Native response',
  messageCount: 2, isSubagent: false, resumable: true, filePath: '/private/native.jsonl' };
const run: Run = { id: 'run', sessionId: session.id, prompt: 'Work', status: 'running', createdAt: '2026-09-15T01:00:00Z', output: '진행 중 😀' };
const snapshot = (runs: Run[] = [run]): Snapshot => ({ sessions: [session], runs, providers: [], scanning: false, hostname: 'fixture', version: 'test', updatedAt: '2026-09-15T01:00:00Z' });

test('public snapshots omit cumulative output and private log paths without changing source objects', () => {
  const source = snapshot([{ ...run, output: 'long response '.repeat(5000), canSteer: true,
    approvals: [{ id: 'approval', toolName: 'Bash', input: { command: 'pwd' } }] }]);
  const saved = structuredClone(source);
  const result = publicSnapshot(source);
  assert.equal(result.runs[0].output, '');
  assert.equal(Object.hasOwn(result.sessions[0], 'filePath'), false);
  assert.equal(result.runs[0].canSteer, true);
  assert.deepEqual(result.runs[0].approvals, source.runs[0].approvals);
  assert.deepEqual(source, saved);
  assert.notEqual(result.runs[0], source.runs[0]);
  assert.notEqual(result.sessions[0], source.sessions[0]);
  assert.ok(JSON.stringify(result).length < JSON.stringify(source).length / 10);
});

test('public read markers exactly match legacy revisions across same-length Unicode changes', () => {
  const variants = ['진행 중 😀', '진행 중 😃'];
  assert.equal(variants[0].length, variants[1].length);
  const revisions = variants.map(output => {
    const source = snapshot([{ ...run, output }]);
    const before = conversationRevision(source.sessions[0], source.runs);
    const result = publicSnapshot(source);
    assert.equal(result.sessions[0].readRevision, before);
    assert.equal(conversationRevision(result.sessions[0], result.runs), before);
    return before;
  });
  assert.notEqual(revisions[0], revisions[1]);
});

test('snapshot markers preserve latest-run tie breaking and ignore unrelated runs', () => {
  const older = { ...run, id: 'old', createdAt: '2026-09-14T01:00:00Z', output: 'old' };
  const tie = { ...run, id: 'a-first', output: 'chosen' };
  const unrelated = { ...run, id: 'other', sessionId: 'other', output: 'unrelated' };
  const source = snapshot([run, older, unrelated, tie]);
  const result = publicSnapshot(source);
  assert.equal(result.sessions[0].readRevision, conversationRevision(session, [tie]));
  assert.equal(result.sessions[0].readRevision, conversationRevision(session, source.runs));
  const noRuns = publicSnapshot(snapshot([]));
  assert.equal(noRuns.sessions[0].readRevision, conversationRevision(session));
});

test('snapshot markers retain completion and failure activity without native history changes', () => {
  const before = publicSnapshot(snapshot()).sessions[0].readRevision;
  for (const change of [{ status: 'completed' as const }, { status: 'error' as const, error: 'Failure' }]) {
    const source = snapshot([{ ...run, ...change }]);
    const result = publicSnapshot(source);
    assert.notEqual(result.sessions[0].readRevision, before);
    assert.equal(result.sessions[0].readRevision, conversationRevision(session, source.runs));
  }
});
