import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { RunManager, type RunAdmission } from '../../../server/runs/manager.js';
import { AttachmentStore } from '../../../server/stores/attachments.js';
import { SteeringError, type SteeringInput } from '../../../server/runs/steering.js';
import type { CodexStdioResult } from '../../../server/runs/codex-stdio.js';
import type { PermissionRequest } from '../../../shared/permissions.js';
import { randomUUID } from 'node:crypto';
import type { Run, Session } from '../../../shared/types.js';
import { until } from '../../helpers/until.ts';

const ID = '10000000-0000-4000-8000-000000000001';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t: TestContext, options: { external?: boolean; onSteer?: (input: SteeringInput) => Promise<void>; resolveRunTools?: ConstructorParameters<typeof RunManager>[0]['resolveRunTools'] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-runner-steering-'));
  const stateDir = join(directory, 'state');
  const session: Session = { id: `codex:${ID}`, nativeId: ID, provider: 'codex', title: 'Steering fixture', cwd: directory,
    project: 'fixture', status: options.external ? 'working' : 'completed', statusReason: 'Fixture', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true, model: 'model-a' };
  const inputs: SteeringInput[] = [];
  const controls: { finish(result?: CodexStdioResult): void }[] = [];
  const manager = new RunManager({ stateDir, getSession: id => id === session.id ? session : undefined,
    refreshSessions: async () => {}, pollMs: 10000, findExecutable: async () => '/fixture/codex', resolveRunTools: options.resolveRunTools,
    spawnProcess: () => { throw new Error('Native providers must never launch in steering fixtures'); },
    openCodexStdio: async config => {
      let active = false; let ended = false; let inserting = false;
      const done = deferred();
      const finish = (result: CodexStdioResult = { status: 'completed' }) => {
        if (ended) return; ended = true; active = false; config.onFinished(result); done.resolve();
      };
      controls.push({ finish });
      return { start: async () => { await config.onSession(ID); active = true; config.onStarted?.('fixture-turn'); },
        done: done.promise, close: () => finish({ status: 'cancelled' }), cancel: async () => finish({ status: 'cancelled' }),
        respondToApproval: async () => {}, canSteer: () => active && !inserting,
        // Like the Codex adapters, one insert at a time.
        steer: async input => { assert.equal(active, true); inserting = true; try { inputs.push(input); await options.onSteer?.(input); } finally { inserting = false; } } };
    },
  });
  // What the page last received: the run list as it was when the worker published a change.
  const published = new Map<string, Run>();
  manager.on('change', () => { for (const run of manager.list()) published.set(run.id, run); });
  await manager.start();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const read = (id: string) => manager.list().find(run => run.id === id)!;
  const pair = async () => {
    const first = await manager.enqueue(session.id, 'Original instruction');
    await until(() => controls.length === 1 && read(first.id).status === 'running');
    const second = await manager.enqueue(session.id, 'Inserted instruction');
    await until(() => Boolean(read(second.id).canSteer));
    return { first, second };
  };
  const running = async (origin?: RunAdmission['origin']) => {
    const first = await manager.enqueue(session.id, 'Original instruction', {}, { origin });
    await until(() => controls.length === 1 && read(first.id).status === 'running');
    return first;
  };
  return { manager, session, controls, inputs, read, pair, running, stateDir, published };
}

test('queued same-session instruction is persisted before delivery and follows original completion', async t => {
  const gate = deferred();
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, { onSteer: async input => {
    const saved: Run[] = JSON.parse(await readFile(join(f.stateDir, 'runs.json'), 'utf8'));
    assert.equal(saved.find(run => run.id === input.id)?.steering?.state, 'sending');
    await gate.promise;
  } });
  const { first, second } = await f.pair();
  const sending = f.manager.steer(second.id);
  await until(() => f.inputs.length === 1);
  assert.equal(f.read(second.id).steering?.state, 'sending');
  const duplicate = await f.manager.steer(second.id);
  assert.equal(duplicate.steering?.state, 'sending');
  assert.equal(f.inputs.length, 1);
  gate.resolve();
  const delivered = await sending;
  assert.equal(delivered.steering?.state, 'delivered');
  assert.equal(delivered.steering?.targetRunId, first.id);
  assert.equal(delivered.status, 'running');
  assert.equal(f.inputs[0].id, second.id);
  assert.equal(f.inputs[0].prompt, 'Inserted instruction');
  await assert.rejects(f.manager.cancel(second.id), /Stop the active turn/);
  f.controls[0].finish();
  assert.equal(f.read(second.id).status, 'completed');
  assert.equal(f.read(first.id).status, 'completed');
  await f.manager.steer(second.id); // Idempotent after delivery, including completed runs.
  assert.equal(f.inputs.length, 1);
  assert.equal(f.controls.length, 1);
});

test('external activity and requested model changes cannot receive steering', async t => {
  const external = await fixture(t, { external: true });
  const queued = await external.manager.enqueue(external.session.id, 'Wait for external writer');
  assert.equal(external.read(queued.id).canSteer, false);
  await assert.rejects(external.manager.steer(queued.id), { statusCode: 409 });
  assert.equal(external.controls.length, 0);
  const f = await fixture(t);
  await f.pair();
  const differentModel = await f.manager.enqueue(f.session.id, 'Different model', { model: 'model-b' });
  assert.equal(f.read(differentModel.id).canSteer, false);
  await assert.rejects(f.manager.steer(differentModel.id), { statusCode: 409 });
  assert.equal(f.inputs.length, 0);
});

test('a queued instruction that cannot join the running turn says why, and says nothing without one', async t => {
  const external = await fixture(t, { external: true });
  const alone = await external.manager.enqueue(external.session.id, 'Wait for external writer');
  assert.equal(external.read(alone.id).steerBlocked, undefined);
  const f = await fixture(t);
  await f.running({ kind: 'owner' });
  const owner = { origin: { kind: 'owner' as const } };
  const cases = [
    [await f.manager.enqueue(f.session.id, 'Other model', { model: 'model-b' }, owner), 'model'],
    [await f.manager.enqueue(f.session.id, 'Other effort', { effort: 'high' }, owner), 'effort'],
    [await f.manager.enqueue(f.session.id, 'Needs receipts', {}, { ...owner, instructions: { text: 'Tower receipt', required: true } }), 'instructions'],
    [await f.manager.enqueue(f.session.id, 'From elsewhere', {}, { origin: { kind: 'unknown' } }), 'origin'],
    [await f.manager.enqueue(f.session.id, 'Same work', { model: 'model-a' }, owner), undefined],
  ] as const;
  for (const [run, reason] of cases) {
    assert.equal(f.read(run.id).steerBlocked, reason, run.prompt);
    assert.equal(f.read(run.id).canSteer, reason === undefined, run.prompt);
  }
  await f.manager.flushState();
  const saved: Run[] = JSON.parse(await readFile(join(f.stateDir, 'runs.json'), 'utf8'));
  assert.ok(saved.every(run => run.steerBlocked === undefined && run.canSteer === undefined));
});

test('an owner message behind a trigger’s turn says the turn started elsewhere', async t => {
  const f = await fixture(t);
  await f.running({ kind: 'trigger', triggerId: 'trigger-1', eventId: 'event-1' });
  const queued = await f.manager.enqueue(f.session.id, 'check again', {}, { origin: { kind: 'owner' } });
  assert.equal(f.read(queued.id).canSteer, false);
  assert.equal(f.read(queued.id).steerBlocked, 'origin');
});

test('while one instruction goes into a Codex turn, the others are published as waiting for it', async t => {
  const gate = deferred();
  const f = await fixture(t, { onSteer: () => gate.promise });
  const { second } = await f.pair();
  const third = await f.manager.enqueue(f.session.id, 'And another');
  assert.equal(f.read(third.id).canSteer, true);
  const sending = f.manager.steer(second.id);
  await until(() => f.inputs.length === 1);
  assert.equal(f.published.get(third.id)?.steerBlocked, 'starting');
  assert.equal(f.published.get(third.id)?.canSteer, false);
  gate.resolve(); await sending;
  assert.equal(f.published.get(third.id)?.canSteer, true);
});

for (const disposition of ['rejected', 'uncertain'] as const) {
  test(`steering ${disposition} preserves the correct queue and retry behavior`, async t => {
    const f = await fixture(t, { onSteer: async () => { throw new SteeringError('Fixture delivery failure', disposition); } });
    const { second } = await f.pair();
    await assert.rejects(f.manager.steer(second.id), { disposition });
    const run = f.read(second.id);
    if (disposition === 'rejected') {
      assert.equal(run.status, 'queued'); assert.equal(run.steering, undefined); assert.equal(run.canSteer, true);
      assert.equal(run.startedAt, undefined);
      await f.manager.cancel(second.id);
    } else {
      assert.equal(run.status, 'error'); assert.equal(run.steering?.state, 'uncertain'); assert.equal(run.canSteer, false);
      await f.manager.steer(second.id);
      f.controls[0].finish();
      await delay(20);
      assert.equal(f.read(second.id).status, 'error');
    }
    assert.equal(f.inputs.length, 1); assert.equal(f.controls.length, 1);
  });
}

test('duplicate delivery and an active turn finishing during attachment preparation cannot inject twice', async t => {
  const f = await fixture(t);
  const { second } = await f.pair();
  const gate = deferred();
  const entered = deferred();
  const original = AttachmentStore.prototype.resolve;
  t.mock.method(AttachmentStore.prototype, 'resolve', async function(this: AttachmentStore, ...args: Parameters<typeof original>) {
    entered.resolve(); await gate.promise; return original.apply(this, args);
  });
  const sending = f.manager.steer(second.id);
  const rejected = assert.rejects(sending, { disposition: 'rejected' });
  await entered.promise;
  await assert.rejects(f.manager.steer(second.id), { statusCode: 409 });
  f.controls[0].finish();
  // Keep the normal scheduler waiting on external activity after the original finishes.
  f.session.status = 'working';
  f.session.activeProcess = true;
  gate.resolve(); await rejected;
  assert.equal(f.inputs.length, 0);
  assert.equal(f.read(second.id).status, 'queued');
  assert.equal(f.read(second.id).steering, undefined);
});

test('restart recovers an unacknowledged sending instruction as uncertain without resubmission', async t => {
  const f = await fixture(t);
  const { first, second } = await f.pair();
  const saved = f.manager.list().map(run => run.id === second.id ? { ...run, status: 'running', steering: { targetRunId: first.id, state: 'sending', requestedAt: new Date().toISOString() } } : run);
  await f.manager.close();
  await writeFile(join(f.stateDir, 'runs.json'), JSON.stringify(saved));
  const restored = new RunManager({ stateDir: f.stateDir, getSession: () => f.session, refreshSessions: async () => {},
    spawnProcess: () => { throw new Error('Recovery must not spawn providers'); } });
  await restored.start();
  try {
    const recovered = restored.list().find(run => run.id === second.id)!;
    assert.equal(recovered.status, 'error'); assert.equal(recovered.steering?.state, 'uncertain');
    assert.equal(recovered.canSteer, false);
    await restored.steer(second.id);
  } finally { await restored.close(); }
});

test('an owner message is inserted into the owner’s active turn', async t => {
  const f = await fixture(t);
  const first = await f.running({ kind: 'owner' });
  const second = await f.manager.enqueue(f.session.id, 'Also check the tests', {}, { origin: { kind: 'owner' } });
  await until(() => Boolean(f.read(second.id).canSteer));
  const delivered = await f.manager.steer(second.id);
  assert.equal(delivered.steering?.targetRunId, first.id);
  assert.deepEqual(delivered.origin, { kind: 'owner' });
});

test('work from another origin is never inserted into an active turn and keeps waiting', async t => {
  const f = await fixture(t);
  const first = await f.running({ kind: 'owner' });
  const agent = await f.manager.enqueue(f.session.id, 'Agent follow-up', {}, { origin: { kind: 'agent', runId: first.id } });
  const scheduled = await f.manager.enqueue(f.session.id, 'Scheduled check', {}, { origin: { kind: 'trigger', triggerId: 'daily', eventId: 'slot-1' } });
  for (const run of [agent, scheduled]) {
    assert.equal(f.read(run.id).canSteer, false);
    await assert.rejects(f.manager.steer(run.id), /cannot be inserted/);
    assert.equal(f.read(run.id).status, 'queued');
    assert.equal(f.read(run.id).origin?.kind, run.origin?.kind, 'the insert attempt does not relabel the run');
  }
  assert.equal(f.inputs.length, 0);
});


test('listing runs never re-enters tool resolution, even when the resolver reads the run list itself', async t => {
  let manager: RunManager | undefined;
  let resolutions = 0;
  // Slack's resolver reads the run list to find its conversation, as the real SlackService does.
  const f = await fixture(t, { resolveRunTools: () => { resolutions++; manager?.list(); return { required: false }; } });
  manager = f.manager;
  await f.running({ kind: 'owner' });
  const second = await f.manager.enqueue(f.session.id, 'Queued follow-up', {}, { origin: { kind: 'owner' } });
  await until(() => Boolean(f.read(second.id).canSteer));
  const before = resolutions;
  for (let index = 0; index < 5; index++) assert.equal(f.manager.list().find(run => run.id === second.id)?.canSteer, true);
  assert.equal(resolutions, before, 'computing steering does not resolve tools');
});

test('an insert meant for one turn is refused once another turn runs, and the message keeps waiting', async t => {
  const f = await fixture(t);
  const { first, second } = await f.pair();
  await assert.rejects(f.manager.steer(second.id, { targetRunId: 'some-other-turn' }), (error: unknown) => error instanceof SteeringError && error.disposition === 'rejected');
  assert.equal(f.read(second.id).status, 'queued');
  assert.deepEqual(f.inputs, []);
  const delivered = await f.manager.steer(second.id, { targetRunId: first.id });
  assert.equal(delivered.steering?.state, 'delivered');
  assert.equal(delivered.steering?.targetRunId, first.id);
});

function permissionRequest(f: Awaited<ReturnType<typeof fixture>>, runId: string, status: PermissionRequest['status'] = 'approved'): PermissionRequest {
  return { id: randomUUID(), sessionId: f.session.id, runId, status, rule: { kind: 'command', value: 'gh pr merge', providers: ['codex'], scope: 'project', cwd: f.session.cwd }, reason: 'Fixture', cwd: f.session.cwd, createdAt: new Date().toISOString() };
}

test('permission approval persists one protected next turn and a turn-only notice, preserving authority', async t => {
  const f = await fixture(t); const parent = await f.running({ kind: 'owner' });
  const request = permissionRequest(f, parent.id);
  const resume = await f.manager.permissionDecision(request, 'Approved for the next provider turn.');
  assert.equal(resume.scheduled?.resume, 'permission'); assert.equal(resume.status, 'queued');
  assert.equal(f.controls.length, 1); assert.equal(f.inputs.length, 1);
  assert.match(f.inputs[0].prompt, /next provider turn/);
  const notice = f.manager.list().find(run => run.permissionNotice)!;
  assert.equal(notice.steering?.targetRunId, parent.id);
  assert.equal((await f.manager.permissionDecision(request, 'Repeated')).id, resume.id);
  assert.equal(f.inputs.length, 1);
  await assert.rejects(f.manager.steer(resume.id), /cannot be inserted/);
  f.controls[0].finish();
  await until(() => f.controls.length === 2 && f.read(resume.id).status === 'running');
  assert.deepEqual(f.read(resume.id).origin, parent.origin);
  f.controls[1].finish(); await until(() => f.read(resume.id).status === 'completed');
  assert.equal((await f.manager.permissionDecision(request, 'Late retry')).id, resume.id);
  assert.equal(f.controls.length, 2);
});

test('approvals of steering aliases merge into one next turn with separate durable receipts', async t => {
  const f = await fixture(t); const { first, second } = await f.pair(); await f.manager.steer(second.id);
  const one = permissionRequest(f, second.id); const two = permissionRequest(f, first.id);
  const [a, b] = await Promise.all([f.manager.permissionDecision(one, 'One'), f.manager.permissionDecision(two, 'Two')]);
  assert.equal(a.id, b.id); assert.equal(f.read(a.id).scheduled?.afterRunId, first.id);
  assert.deepEqual(new Set(f.read(a.id).permissionRequestIds), new Set([one.id, two.id]));
  f.controls[0].finish(); await until(() => f.controls.length === 2); f.controls[1].finish();
});

test('permission denial and explicit parent cancellation never launch a continuation', async t => {
  const f = await fixture(t); const parent = await f.running();
  const denied = await f.manager.permissionDecision(permissionRequest(f, parent.id, 'denied'), 'Refused.');
  assert.equal(denied.status, 'cancelled'); assert.equal(denied.scheduled, undefined);
  const request = permissionRequest(f, parent.id); const resume = await f.manager.permissionDecision(request, 'Allowed.');
  await f.manager.cancel(parent.id); await until(() => f.read(resume.id).status === 'cancelled');
  assert.equal((await f.manager.permissionDecision(request, 'Retry')).status, 'cancelled');
  assert.equal(f.controls.length, 1);
});

test('failed permission notice is never launched as standalone work and a newer owner instruction supersedes resume', async t => {
  const f = await fixture(t, { onSteer: async () => { throw new SteeringError('Not delivered', 'rejected'); } });
  const parent = await f.running(); const request = permissionRequest(f, parent.id);
  const resume = await f.manager.permissionDecision(request, 'Allowed.');
  const notice = f.manager.list().find(run => run.permissionNotice)!;
  assert.equal(notice.status, 'cancelled'); assert.equal(notice.steering, undefined);
  await f.manager.enqueue(f.session.id, 'New owner instruction');
  assert.equal(f.read(resume.id).status, 'cancelled');
  f.controls[0].finish(); await until(() => f.controls.length === 2);
  assert.equal((await f.manager.permissionDecision(request, 'Retry')).status, 'cancelled');
  f.controls[1].finish(); assert.equal(f.controls.length, 2);
});

test('permission continuation survives queued restore but never restarts an uncertain parent', async t => {
  const f = await fixture(t); const parent = await f.running(); const request = permissionRequest(f, parent.id);
  const resume = await f.manager.permissionDecision(request, 'Allowed.'); await f.manager.flushState();
  // Read the persisted state using another manager with no provider transport: any launch is forbidden.
  const restored = new RunManager({ stateDir: f.stateDir, getSession: () => f.session, refreshSessions: async () => {}, pollMs: 10000,
    spawnProcess: () => { throw new Error('Native provider forbidden'); }, findExecutable: async () => { throw new Error('Launch forbidden'); } });
  await restored.start(); t.after(() => restored.close());
  assert.equal(restored.list().find(run => run.id === parent.id)?.status, 'error');
  assert.equal((await restored.permissionDecision(request, 'Retry')).id, resume.id);
  await until(() => restored.list().find(run => run.id === resume.id)?.status === 'cancelled');
});


test('forced update merges permission receipts into one continuation rather than starting both', async t => {
  const f = await fixture(t); const parent = await f.running(); const request = permissionRequest(f, parent.id);
  const resume = await f.manager.permissionDecision(request, 'Approved.');
  f.manager.beginUpdateDrain(Date.now() + 60000, () => false); f.manager.driveUpdateDrain();
  await until(() => f.inputs.length === 2);
  f.controls[0].finish(); await until(() => f.read(parent.id).status === 'completed');
  assert.equal(f.read(resume.id).scheduled?.resume, 'update');
  assert.deepEqual(f.read(resume.id).permissionRequestIds, [request.id]);
  assert.equal(f.manager.list().filter(run => run.status === 'queued' && run.scheduled?.afterRunId === parent.id).length, 1);
  f.manager.endUpdateDrain(); await until(() => f.controls.length === 2); f.controls[1].finish();
  assert.equal((await f.manager.permissionDecision(request, 'Retry')).id, resume.id);
});

test('a parent completed while waiting for permission resumes, but a closed conversation does not', async t => {
  const f = await fixture(t); const parent = await f.running(); f.controls[0].finish(); await until(() => f.read(parent.id).status === 'completed');
  const denied = await f.manager.permissionDecision(permissionRequest(f, parent.id), 'Approved.', { closed: true });
  assert.equal(denied.status, 'cancelled'); assert.equal(f.inputs.length, 0);
  const request = permissionRequest(f, parent.id); const resume = await f.manager.permissionDecision(request, 'Approved.');
  await until(() => f.controls.length === 2); assert.equal(f.inputs.length, 0); f.controls[1].finish();
  assert.match(resume.prompt, /Continue only unfinished work/);
});


test('an exact completed task outcome and missing requesting run cannot restart work', async t => {
  const f = await fixture(t); const parent = await f.running(); f.controls[0].finish(); await until(() => f.read(parent.id).status === 'completed');
  const ended = f.read(parent.id);
  f.session.outcome = 'done'; f.session.lastRequestAt = ended.startedAt; f.session.updatedAt = ended.finishedAt!;
  const receipt = await f.manager.permissionDecision(permissionRequest(f, parent.id), 'Approved.');
  assert.equal(receipt.status, 'cancelled'); assert.equal(f.controls.length, 1);
  await assert.rejects(f.manager.permissionDecision(permissionRequest(f, randomUUID()), 'Approved.'), /can no longer be reached/);
});

test('a saved queued turn-only notice is cancelled on restore and owner stop evidence survives', async t => {
  const f = await fixture(t); const parent = await f.running(); await f.manager.cancel(parent.id); await f.manager.flushState();
  const saved = JSON.parse(await readFile(join(f.stateDir, 'runs.json'), 'utf8')) as Run[];
  saved.push({ id: randomUUID(), sessionId: f.session.id, prompt: 'Turn only', createdAt: new Date().toISOString(), output: '', status: 'queued', permissionNotice: { targetRunId: parent.id } });
  await writeFile(join(f.stateDir, 'runs.json'), JSON.stringify(saved));
  const restored = new RunManager({ stateDir: f.stateDir, getSession: () => f.session, refreshSessions: async () => {}, pollMs: 10000,
    spawnProcess: () => { throw new Error('Native provider forbidden'); } });
  await restored.start(); t.after(() => restored.close());
  assert.equal(restored.list().find(run => run.id === parent.id)?.ownerStopped, true);
  assert.equal(restored.list().find(run => run.permissionNotice)?.status, 'cancelled');
});
