import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { RunManager } from '../server/runner.js';
import { AttachmentStore } from '../server/attachments.js';
import { SteeringError, type SteeringInput } from '../server/steering.js';
import type { CodexStdioResult } from '../server/codex-stdio.js';
import type { Run, Session } from '../shared/types.js';

const ID = '10000000-0000-4000-8000-000000000001';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < deadline, 'Runner fixture timed out'); await delay(5); }
}
async function fixture(t: TestContext, options: { external?: boolean; onSteer?: (input: SteeringInput) => Promise<void> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-runner-steering-'));
  const stateDir = join(directory, 'state');
  const session: Session = { id: `codex:${ID}`, nativeId: ID, provider: 'codex', title: 'Steering fixture', cwd: directory,
    project: 'fixture', status: options.external ? 'working' : 'completed', statusReason: 'Fixture', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), lastMessage: '', messageCount: 1, isSubagent: false, resumable: true, model: 'model-a' };
  const inputs: SteeringInput[] = [];
  const controls: { finish(result?: CodexStdioResult): void }[] = [];
  const manager = new RunManager({ stateDir, getSession: id => id === session.id ? session : undefined,
    refreshSessions: async () => {}, pollMs: 10000, findExecutable: async () => '/fixture/codex',
    spawnProcess: () => { throw new Error('Native providers must never launch in steering fixtures'); },
    openCodexStdio: async config => {
      let active = false; let ended = false;
      const done = deferred();
      const finish = (result: CodexStdioResult = { status: 'completed' }) => {
        if (ended) return; ended = true; active = false; config.onFinished(result); done.resolve();
      };
      controls.push({ finish });
      return { start: async () => { await config.onSession(ID); active = true; config.onStarted?.('fixture-turn'); },
        done: done.promise, close: () => finish({ status: 'cancelled' }), cancel: async () => finish({ status: 'cancelled' }),
        respondToApproval: async () => {}, canSteer: () => active,
        steer: async input => { assert.equal(active, true); inputs.push(input); await options.onSteer?.(input); } };
    },
  });
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
  return { manager, session, controls, inputs, read, pair, stateDir };
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
