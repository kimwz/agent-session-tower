import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { RunManager } from '../../../server/runs/manager.js';
import type { CodexBridgeOptions } from '../../../server/runs/codex-bridge.js';
import type { CreatedSession } from '../../../server/runs/saved-state.js';
import type { Run, Session } from '../../../shared/types.js';
import { until } from '../../helpers/until.ts';

const ID = '10000000-0000-4000-8000-000000000001';

/** The private save path, reached directly to order writes deterministically. */
interface Internals { persist(): void; flush(): Promise<void>; runs: Map<string, Run>; createdSessions: Map<string, CreatedSession> }

async function fixture(t: TestContext, outputPersistMs = 60_000) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-run-persistence-'));
  const stateDir = join(directory, 'state');
  const session: Session = { id: `codex:${ID}`, nativeId: ID, provider: 'codex', title: 'Persistence fixture', cwd: directory,
    project: 'fixture', status: 'idle', statusReason: 'Ready', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastMessage: '', messageCount: 1, isSubagent: false, resumable: true, activeProcess: true };
  let bridge: Omit<CodexBridgeOptions, 'codexHome'> | undefined;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const manager = new RunManager({ stateDir, getSession: id => id === session.id ? { ...session } : undefined, refreshSessions: async () => {},
    pollMs: 10, outputPersistMs, findExecutable: async () => '/fixture/codex',
    spawnProcess: () => { throw new Error('Native provider launch is forbidden in this fixture.'); },
    openCodexBridge: async options => {
      bridge = options;
      return { done, start: async () => { options.onStarted('fixture-turn'); },
        cancel: async () => { options.onFinished({ status: 'cancelled' }); finish(); }, close: () => finish() };
    },
  });
  await manager.start();
  const internals = manager as unknown as Internals;
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const saved = async (): Promise<Run[]> => JSON.parse(await readFile(join(stateDir, 'runs.json'), 'utf8'));
  const running = async () => {
    const run = await manager.enqueue(session.id, 'Stream some output');
    await until(() => bridge && manager.list().find(item => item.id === run.id)?.status === 'running');
    await internals.flush();
    return { run, bridge: bridge! };
  };
  return { manager, internals, stateDir, saved, running, finish };
}

test('streamed output is announced at once but saved on its slower cadence', async t => {
  const f = await fixture(t);
  const { run, bridge } = await f.running();
  let changes = 0;
  f.manager.on('change', () => { changes++; });
  bridge.onOutput('Partial answer');
  await until(() => changes > 0);
  assert.equal(f.manager.list().find(item => item.id === run.id)?.output, 'Partial answer');
  await f.internals.flush();
  assert.equal((await f.saved()).find(item => item.id === run.id)?.output, '', 'output alone waits for its save cadence');
  bridge.onFinished({ status: 'completed' });
  await f.internals.flush();
  const finished = (await f.saved()).find(item => item.id === run.id);
  assert.equal(finished?.status, 'completed');
  assert.equal(finished?.output, 'Partial answer', 'a state change saves the latest output with it');
});

test('output waiting for its cadence reaches disk on the cadence alone', async t => {
  const f = await fixture(t, 40);
  const { run, bridge } = await f.running();
  bridge.onOutput('Eventually saved');
  const deadline = Date.now() + 5000;
  for (;;) {
    await f.internals.flush();
    if ((await f.saved()).find(item => item.id === run.id)?.output === 'Eventually saved') break;
    assert.ok(Date.now() < deadline, 'output was not saved on its cadence');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await f.saved()).find(item => item.id === run.id)?.status, 'running');
});

test('shutdown saves output that was still waiting for its cadence', async t => {
  const f = await fixture(t);
  const { run, bridge } = await f.running();
  bridge.onOutput('Written at shutdown');
  await until(() => f.manager.list().find(item => item.id === run.id)?.output === 'Written at shutdown');
  await f.manager.close();
  assert.equal((await f.saved()).find(item => item.id === run.id)?.output, 'Written at shutdown');
});

test('saving unchanged state rewrites neither file, and no identities file appears without created sessions', async t => {
  const f = await fixture(t);
  const before = await stat(join(f.stateDir, 'runs.json'));
  f.internals.persist();
  await f.internals.flush();
  const after = await stat(join(f.stateDir, 'runs.json'));
  assert.equal(after.ino, before.ino, 'an atomic rewrite would replace the inode');
  await assert.rejects(stat(join(f.stateDir, 'created-sessions.json')), { code: 'ENOENT' });
});

test('a queued save that restores earlier content still reaches disk', async t => {
  const f = await fixture(t);
  const { run } = await f.running();
  const live = f.internals.runs.get(run.id)!;
  const original = live.prompt;
  // A, then B and back to A while B is still queued: comparing against the last completed write
  // outside the queue would skip the final A and leave B on disk.
  live.prompt = 'Temporarily different';
  f.internals.persist();
  live.prompt = original;
  f.internals.persist();
  await f.internals.flush();
  assert.equal((await f.saved()).find(item => item.id === run.id)?.prompt, original);
});

test('a failed run-history write is retried by the next save while saved identities are not rewritten', async t => {
  const f = await fixture(t);
  const { run } = await f.running();
  const runsFile = join(f.stateDir, 'runs.json');
  const createdFile = join(f.stateDir, 'created-sessions.json');
  const session = f.manager.getSession(`codex:${ID}`)!;
  f.internals.createdSessions.set('created-fixture', { session: { ...session, id: 'created-fixture' }, runId: run.id, confirmed: true });
  await rm(runsFile);
  await mkdir(runsFile);
  f.internals.runs.get(run.id)!.prompt = 'Saved after the failure';
  f.internals.persist();
  await assert.rejects(f.internals.flush(), /Cannot save the instruction queue/);
  const identities = await stat(createdFile);
  await rm(runsFile, { recursive: true });
  f.internals.persist();
  await f.internals.flush();
  assert.equal((await f.saved()).find(item => item.id === run.id)?.prompt, 'Saved after the failure');
  assert.equal((await stat(createdFile)).ino, identities.ino, 'identities already on disk are not written again');
});
