import assert from 'node:assert/strict';
import test from 'node:test';
import { applySnapshotPatch, diffSnapshots, indexSnapshot, type SnapshotChanges } from '../../shared/snapshot-patch.js';
import type { AutoPromptJob, Run, Session, Snapshot } from '../../shared/types.js';

const at = '2026-09-23T00:00:00.000Z';
function session(id: string, overrides: Partial<Session> = {}): Session {
  return { id, nativeId: id, provider: 'codex', title: `Session ${id}`, cwd: '/fixture', project: 'fixture', status: 'idle', statusReason: '',
    createdAt: at, updatedAt: at, lastMessage: '', messageCount: 1, isSubagent: false, resumable: true, ...overrides };
}
function run(id: string, overrides: Partial<Run> = {}): Run {
  return { id, sessionId: 's1', prompt: `Prompt ${id}`, status: 'completed', createdAt: at, output: '', ...overrides };
}
function job(id: string, overrides: Partial<AutoPromptJob> = {}): AutoPromptJob {
  return { id, provider: 'codex', prompt: 'Route me', routerModel: 'router', status: 'completed', createdAt: at, updatedAt: at, ...overrides };
}
function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return { sessions: [session('s1'), session('s2')], runs: [run('r1')], providers: [], scanning: false, hostname: 'host', version: '1.13.0',
    updatedAt: at, groups: [], autoPrompts: [job('a1')], runnerVersion: '1.13.0', ...overrides };
}
function roundTrip(previous: Snapshot, next: Snapshot): { changes?: SnapshotChanges; applied: Snapshot } {
  const changes = diffSnapshots(indexSnapshot(previous), next);
  return { changes, applied: changes ? applySnapshotPatch(previous, changes) : previous };
}

test('a snapshot that differs only in its broadcast time produces no patch', () => {
  assert.equal(diffSnapshots(indexSnapshot(snapshot()), snapshot({ updatedAt: '2026-09-23T00:00:09.000Z' })), undefined);
});

test('one changed session is sent alone and applying it reproduces the next snapshot', () => {
  const previous = snapshot();
  const next = snapshot({ sessions: [session('s1', { lastMessage: 'New reply', messageCount: 2 }), session('s2')], updatedAt: '2026-09-23T00:00:05.000Z' });
  const { changes, applied } = roundTrip(previous, next);
  assert.deepEqual(changes?.sessions, { upsert: [next.sessions[0]] });
  assert.equal(changes?.runs, undefined);
  assert.deepEqual(applied, next);
  assert.equal(applied.sessions[1], previous.sessions[1], 'unchanged sessions keep their identity');
  assert.equal(applied.runs, previous.runs, 'an untouched collection keeps its identity');
});

test('nested activity times and read revisions are real changes', () => {
  const previous = snapshot();
  const nested = roundTrip(previous, snapshot({ sessions: [session('s1', { updatedAt: '2026-09-23T00:01:00.000Z' }), session('s2')], autoPrompts: [job('a1', { updatedAt: '2026-09-23T00:01:00.000Z' })] }));
  assert.equal(nested.changes?.sessions?.upsert?.length, 1);
  assert.equal(nested.changes?.autoPrompts?.upsert?.length, 1);
  const revision = roundTrip(previous, snapshot({ sessions: [session('s1', { readRevision: 'output-changed' }), session('s2')] }));
  assert.deepEqual(revision.changes?.sessions?.upsert?.map(item => item.id), ['s1']);
  assert.equal(revision.applied.sessions[0].readRevision, 'output-changed');
});

test('added, removed and reordered items carry the complete order', () => {
  const previous = snapshot({ sessions: [session('s1'), session('s2'), session('s3')] });
  const next = snapshot({ sessions: [session('s3'), session('s4'), session('s1')] });
  const { changes, applied } = roundTrip(previous, next);
  assert.deepEqual(changes?.sessions?.order, ['s3', 's4', 's1']);
  assert.deepEqual(changes?.sessions?.upsert?.map(item => item.id), ['s4']);
  assert.deepEqual(applied, next);
});

test('optional values that disappear are cleared, and values that appear are set', () => {
  const previous = snapshot();
  const { autoPrompts: _jobs, runnerVersion: _runner, groups: _groups, ...rest } = previous;
  const cleared = roundTrip(previous, { ...rest, scanning: true });
  assert.deepEqual(new Set(cleared.changes?.cleared), new Set(['autoPrompts', 'runnerVersion', 'groups']));
  assert.deepEqual(cleared.applied, { ...rest, scanning: true });
  const restored = roundTrip({ ...rest }, previous);
  assert.deepEqual(restored.applied, previous);
});

test('a collection with repeated ids is replaced whole instead of patched by id', () => {
  const previous = snapshot();
  const next = snapshot({ runs: [run('r1'), run('r1', { status: 'error' })] });
  const { changes, applied } = roundTrip(previous, next);
  assert.equal(changes?.runs, undefined);
  assert.deepEqual(changes?.fields?.runs, next.runs);
  assert.deepEqual(applied, next);
  assert.deepEqual(roundTrip(next, previous).applied, previous);
});

test('a patch that does not fit the snapshot is rejected so the page can resynchronize', () => {
  const base = snapshot();
  assert.throws(() => applySnapshotPatch(base, { sessions: { order: ['s1', 'missing'] } }), /unknown sessions/);
  assert.throws(() => applySnapshotPatch(base, { sessions: { upsert: [session('s9')] } }), /invalid sessions order/);
  assert.throws(() => applySnapshotPatch(base, { sessions: { order: ['s1', 's1'] } }), /invalid sessions order/);
  const { autoPrompts: _jobs, ...withoutJobs } = base;
  assert.throws(() => applySnapshotPatch(withoutJobs, { autoPrompts: { upsert: [job('a1')] } }), /no autoPrompts/);
});

test('random snapshot sequences always round-trip exactly', () => {
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!;
  const mutateList = <T extends { id: string }>(items: T[], make: (id: string) => T, change: (item: T) => T): T[] => {
    let next = items.map(item => random() < 0.2 ? change(item) : item);
    if (random() < 0.3) next = next.filter(() => random() < 0.8);
    if (random() < 0.3) next.push(make(`n${Math.floor(random() * 1e6)}`));
    if (random() < 0.2) next.reverse();
    return next;
  };
  let previous = snapshot();
  for (let step = 0; step < 500; step++) {
    const next: Snapshot = {
      ...previous,
      sessions: mutateList(previous.sessions, id => session(id), item => ({ ...item, lastMessage: `m${step}`, status: pick(['idle', 'working', 'completed'] as const) })),
      runs: mutateList(previous.runs, id => run(id), item => ({ ...item, status: pick(['queued', 'running', 'completed'] as const) })),
      updatedAt: `2026-09-23T00:00:${String(step % 60).padStart(2, '0')}.000Z`,
    };
    if (random() < 0.2) next.scanning = !previous.scanning;
    if (random() < 0.15) { if (next.autoPrompts) delete next.autoPrompts; else next.autoPrompts = [job(`a${step}`)]; }
    else if (next.autoPrompts) next.autoPrompts = mutateList(next.autoPrompts, id => job(id), item => ({ ...item, status: 'error' }));
    if (random() < 0.1) next.runnerVersion = random() < 0.5 ? undefined : `1.${step}`;
    if (next.runnerVersion === undefined) delete next.runnerVersion;
    const { changes, applied } = roundTrip(previous, next);
    if (changes) assert.deepEqual(applied, next, `step ${step}`);
    else assert.deepEqual({ ...previous, updatedAt: next.updatedAt }, next, `step ${step} reported no change`);
    previous = next;
  }
});
