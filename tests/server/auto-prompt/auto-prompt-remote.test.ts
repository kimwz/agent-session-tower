import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { AutoPromptManager } from '../../../server/auto-prompt/manager.js';
import type { AutoPromptModelRequest } from '../../../server/auto-prompt/native.js';
import type { RunAdmission } from '../../../server/runs/manager.js';
import { RemoteExclusionStore } from '../../../server/remote/exclusions.js';
import type { CreateSessionRequest, Run, RunOrigin, Session, Snapshot } from '../../../shared/types.js';
import { until } from '../../helpers/until.ts';

const REMOTE: RunOrigin = { kind: 'owner', controllerId: 'controllera1b2c3d4e5f6' };
const session = (id: string, cwd: string): Session => ({ id: `codex:${id}`, nativeId: id, provider: 'codex', cwd, project: 'project', title: `Work in ${cwd}`, status: 'completed',
  statusReason: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', lastMessage: `last words in ${cwd}`, messageCount: 2, isSubagent: false, resumable: true });

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tower-auto-prompt-remote-')));
  const open = join(directory, 'open'), secret = join(directory, 'secret');
  await Promise.all([mkdir(open), mkdir(join(secret, 'deep'), { recursive: true }), mkdir(join(directory, 'state'))]);
  const exclusions = new RemoteExclusionStore(join(directory, 'state'));
  await exclusions.start();
  await exclusions.add(secret);
  const managed: Run[] = [];
  const current: Snapshot = {
    sessions: [session('11111111-1111-4111-8111-111111111111', open), session('22222222-2222-4222-8222-222222222222', join(secret, 'deep'))],
    runs: managed, providers: [{ provider: 'codex', available: true, sessionCount: 2 }], scanning: false, updatedAt: '2026-01-02T00:00:00.000Z', hostname: 'b', version: 'test',
    groups: [{ cwd: secret, title: 'Secret project', pinned: true }] };
  const calls: AutoPromptModelRequest[] = [];
  const coordinators = new Set<string>();
  const dispatches: Array<{ input: CreateSessionRequest; internal?: RunAdmission }> = [];
  let respond: (input: AutoPromptModelRequest) => Promise<unknown> = async () => ({ directoryId: 'd1', reason: 'fits' });
  const runs = {
    list: () => structuredClone(managed),
    create: async (input: CreateSessionRequest, internal?: RunAdmission) => {
      internal?.validate?.();
      const run: Run = { id: randomUUID(), sessionId: `codex:${randomUUID()}`, prompt: input.prompt, status: 'queued', output: '', createdAt: new Date().toISOString(), autoPromptId: internal?.autoPromptId };
      managed.push(run); dispatches.push({ input, internal });
      return { session: session(randomUUID(), input.cwd), run };
    },
    enqueue: async () => { throw new Error('Remote fixtures always create.'); },
  };
  const manager = new AutoPromptManager({ stateDir: join(directory, 'state'), snapshot: () => structuredClone(current), refresh: async () => { await exclusions.reload(); }, runs,
    detail: async id => { const found = current.sessions.find(item => item.id === id); return found ? { session: found, hasMore: false, messages: [] } : undefined; },
    model: async input => { calls.push(input); return respond(input); },
    remote: { prepare: (paths, options) => exclusions.prepare(paths, options), matcher: () => exclusions.matcher(), coordinators: () => coordinators } });
  await manager.start();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const finished = (id: string) => until(() => { const job = manager.get(id); return job && ['completed', 'error', 'cancelled'].includes(job.status) ? job : undefined; });
  return { directory, open, secret, exclusions, manager, calls, dispatches, finished, coordinators, current, respond: (fn: typeof respond) => { respond = fn; } };
}
const submit = (manager: AutoPromptManager, origin: RunOrigin, values: { cwd?: string } = {}) =>
  manager.submit({ requestId: randomUUID(), provider: 'codex', prompt: 'Start the next task', sessionMode: 'new', ...values }, { origin });

test('a remote Auto Prompt never shows excluded folders or their conversations to the router', async t => {
  const f = await fixture(t);
  const job = await f.finished((await submit(f.manager, REMOTE)).id);
  assert.equal(job.status, 'completed');
  const offered = f.calls[0].prompt;
  assert.match(offered, new RegExp(f.open.replace(/[/\\]/g, '.')));
  assert.equal(offered.includes(f.secret), false, 'neither the excluded folder nor its sessions are offered');
  assert.equal(offered.includes('last words in'.concat(' ', join(f.secret, 'deep'))), false);
  assert.equal(f.dispatches[0].input.cwd, f.open);
  assert.equal(job.exclusionRevision, f.exclusions.revision, 'the job records which exclusion list it was routed with');
});

test('the same request from this machine still sees every folder', async t => {
  const f = await fixture(t);
  await f.finished((await submit(f.manager, { kind: 'owner' })).id);
  assert.equal(f.calls[0].prompt.includes(f.secret), true);
});

test('a remote Auto Prompt cannot name an excluded folder, and one excluded while routing is not used', async t => {
  const f = await fixture(t);
  await assert.rejects(submit(f.manager, REMOTE, { cwd: join(f.secret, 'deep') }), /목록에 있는 작업 폴더/);
  f.respond(async () => { await f.exclusions.add(f.open); return { directoryId: 'd1', reason: 'fits' }; });
  const job = await f.finished((await submit(f.manager, REMOTE)).id);
  assert.equal(job.status, 'error');
  assert.deepEqual(f.dispatches, [], 'nothing was started in a folder that stopped being shared');
});

test('a remote Auto Prompt never offers or continues a coordinator conversation', async t => {
  const f = await fixture(t);
  const coordinator = { ...session('33333333-3333-4333-8333-333333333333', f.open), lastMessage: 'coordinator conversation about a GitHub issue' };
  f.current.sessions.push(coordinator);
  f.coordinators.add(coordinator.id);
  f.respond(async input => input.prompt.includes('"directories"') ? { directoryId: 'd1', reason: 'fits' } : { action: 'create', sessionId: null, relation: 'new', reason: 'new task' });
  const job = await f.finished((await f.manager.submit({ requestId: randomUUID(), provider: 'codex', prompt: 'Continue' }, { origin: REMOTE })).id);
  assert.equal(job.status, 'completed');
  assert.equal(f.calls.some(call => call.prompt.includes('coordinator conversation')), false);
});
