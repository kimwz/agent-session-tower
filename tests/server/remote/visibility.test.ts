import test from 'node:test';
import assert from 'node:assert/strict';
import type { AutoPromptJob, Run, Session, Snapshot } from '../../../shared/types.js';
import type { ExclusionMatcher } from '../../../server/remote/exclusions.js';
import { remoteSnapshot, remoteWorkingSnapshot, type RemoteScope } from '../../../server/remote/visibility.js';

const now = '2026-09-24T00:00:00.000Z';
const session = (id: string, cwd: string, extra: Partial<Session> = {}): Session => ({ id, nativeId: id.split(':')[1], provider: 'codex', title: id, cwd, project: 'p',
  status: 'idle', statusReason: '', createdAt: now, updatedAt: now, lastMessage: `last message of ${id}`, messageCount: 1, isSubagent: false, resumable: true, ...extra });
const run = (id: string, sessionId: string, extra: Partial<Run> = {}): Run => ({ id, sessionId, prompt: `prompt ${id}`, status: 'completed', createdAt: now, output: '', ...extra });
const job = (id: string, extra: Partial<AutoPromptJob> = {}): AutoPromptJob => ({ id, provider: 'codex', prompt: 'do it', routerModel: 'router', status: 'completed', createdAt: now, updatedAt: now, ...extra });
/** Excludes /work/secret and everything below it. */
const matcher = (revision = 3): ExclusionMatcher => ({ revision, excludes: path => path === '/work/secret' || path.startsWith('/work/secret/') });
const scope = (coordinators: string[] = []): RemoteScope => ({ matcher: matcher(), coordinators: new Set(coordinators) });
const base = (): Snapshot => ({
  sessions: [
    session('codex:open', '/work/open'),
    session('codex:secret', '/work/secret'),
    session('codex:deep', '/work/secret/deep'),
    session('codex:child', '/work/open', { parentId: 'codex:secret', isSubagent: true }),
    session('codex:orphan', '/work/open', { parentId: 'codex:missing', isSubagent: true }),
    session('codex:coordinator', '/state/slack'),
    { ...session('codex:file', '/work/open'), filePath: '/Users/me/.codex/sessions/file.jsonl' },
  ],
  runs: [run('r-open', 'codex:open', { origin: { kind: 'trigger', triggerId: 'daily' } }), run('r-secret', 'codex:secret'), run('r-deep', 'codex:deep'), run('r-coordinator', 'codex:coordinator')],
  providers: [{ provider: 'codex', available: true, sessionCount: 7, executable: '/Users/me/bin/codex', error: 'raw provider error',
    usage: { status: 'available', windows: [{ id: 'week', usedPercent: 12 }], reason: 'raw usage reason' } }],
  groups: [{ cwd: '/work/open', title: 'Open', pinned: true, hidden: true }, { cwd: '/work/secret', title: 'Secret', pinned: true }, { cwd: '/work/secret/deep', title: 'Deep', pinned: false }],
  autoPrompts: [],
  repositories: [
    { cwd: '/work/open', root: '/work', ahead: 0, behind: 1, changes: 0, checkedAt: now, fetchError: 'fatal: unable to access /work/secret', lastAction: { kind: 'pull', ok: false, error: 'error: /work/secret/deep conflicts', at: now } },
    { cwd: '/work/secret', root: '/work/secret', ahead: 0, behind: 0, changes: 2, checkedAt: now },
    { cwd: '/work/nested', root: '/work/secret/deep', ahead: 0, behind: 0, changes: 0, checkedAt: now },
  ],
  scanning: false, hostname: 'machine-b', version: '1.22.0', runnerVersion: '1.22.0', updatedAt: now,
  triggers: { triggers: [], recent: [], limits: {} } as unknown as Snapshot['triggers'],
});

test('a remote controller never sees an excluded folder, its sessions, their subagents or their runs', () => {
  const view = remoteSnapshot(base(), scope(['codex:coordinator']), 'controller-a1b2c3d4e5f6');
  assert.deepEqual(view.sessions.map(item => item.id), ['codex:open', 'codex:file']);
  assert.deepEqual(view.runs.map(item => item.id), ['r-open']);
  assert.deepEqual(view.groups?.map(item => item.cwd), ['/work/open']);
  assert.equal(JSON.stringify(view).includes('/work/secret'), false, 'no excluded path appears anywhere in the view');
  assert.equal(JSON.stringify(view).includes('codex:coordinator'), false, 'coordinator conversations stay on this machine');
});

test('only listed fields leave the machine, so a field added to the snapshot later stays home', () => {
  const snapshot = { ...base(), futureSecret: 'never sent', nodes: [{ id: 'other-machine' }] } as unknown as Snapshot;
  const view = remoteSnapshot(snapshot, scope(), 'controller-a1b2c3d4e5f6');
  assert.deepEqual(Object.keys(view).sort(), ['autoPrompts', 'groups', 'hostname', 'providers', 'repositories', 'runnerVersion', 'runs', 'scanning', 'sessions', 'updatedAt', 'version']);
  assert.equal('filePath' in view.sessions.find(item => item.id === 'codex:file')!, false);
  assert.deepEqual(view.groups, [{ cwd: '/work/open', title: 'Open', pinned: true }], 'screen hiding is the viewer’s own setting and is not shared');
  assert.deepEqual(view.runs[0].origin, { kind: 'trigger' }, 'only the kind of origin is shared');
});

test('providers are summarized: counts follow what is visible, and local paths and raw errors stay home', () => {
  const [provider] = remoteSnapshot(base(), scope(), 'controller-a1b2c3d4e5f6').providers;
  assert.equal(provider.sessionCount, 3);
  assert.equal(provider.executable, undefined);
  assert.equal(provider.error, undefined);
  assert.equal(provider.usage?.reason, undefined);
  assert.deepEqual(provider.usage?.windows, [{ id: 'week', usedPercent: 12 }]);
});

test('repository status for an excluded folder is dropped, and raw git errors never leave the machine', () => {
  const view = remoteSnapshot(base(), scope(), 'controller-a1b2c3d4e5f6');
  assert.deepEqual(view.repositories?.map(item => item.cwd), ['/work/open']);
  const [status] = view.repositories!;
  assert.equal(status.fetchError, undefined);
  assert.deepEqual(status.lastAction, { kind: 'pull', ok: false, at: now });
});

test('a routing explanation is shown only to the controller that asked, under the exclusion list it was routed with', () => {
  const asker = 'controller-a1b2c3d4e5f6';
  const other = 'controller-ffffffffffff';
  const snapshot = { ...base(), autoPrompts: [
    job('local', { origin: { kind: 'owner' }, cwd: '/work/open', decision: { action: 'create', cwd: '/work/open', reason: 'mentions the secret project' }, routingContext: 'hint' }),
    job('own', { origin: { kind: 'owner', controllerId: asker }, exclusionRevision: 3, decision: { action: 'create', cwd: '/work/open', reason: 'fits the open project' } }),
    job('stale', { origin: { kind: 'owner', controllerId: asker }, exclusionRevision: 2, decision: { action: 'create', cwd: '/work/open', reason: 'routed before a folder was excluded' } }),
    job('into-secret', { origin: { kind: 'owner', controllerId: asker }, decision: { action: 'create', cwd: '/work/secret/deep', reason: 'x' } }),
    job('choosing', { origin: { kind: 'owner', controllerId: asker }, status: 'routing' }),
  ] };
  const mine = remoteSnapshot(snapshot, scope(), asker).autoPrompts!;
  assert.deepEqual(mine.map(item => item.id), ['local', 'own', 'stale', 'choosing']);
  assert.deepEqual(mine.map(item => item.decision?.reason), ['', 'fits the open project', '', undefined]);
  assert.equal(mine[0].routingContext, undefined);
  const theirs = remoteSnapshot(snapshot, scope(), other).autoPrompts!;
  assert.deepEqual(theirs.map(item => item.id), ['local', 'own', 'stale'], 'a request still choosing its folder is visible only to the controller that asked');
  assert.equal(theirs[1].decision?.reason, '');
});

test('remote work inside this machine routes with the same view: no excluded folders, sessions, runs or coordinators', () => {
  const working = remoteWorkingSnapshot(base(), scope(['codex:coordinator']));
  assert.deepEqual(working.sessions.map(item => item.id), ['codex:open', 'codex:file']);
  assert.deepEqual(working.groups?.map(item => item.cwd), ['/work/open']);
  assert.deepEqual(working.runs.map(item => item.id), ['r-open']);
});
