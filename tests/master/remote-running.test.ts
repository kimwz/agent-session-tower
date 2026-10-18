import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MasterSession } from '../../server/master/session.js';
import type { LiveState } from '../../server/tower-tools/live-state.js';
import type { TowerClient } from '../../server/tower-tools/tower-client.js';
import type { Run, Snapshot } from '../../shared/types.js';

const NODE = 'a'.repeat(32);

test('work on a joined computer counts as running while its state arrives here, not on a snapshot it left behind', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-remote-running-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'data'), { recursive: true });
  const now = new Date().toISOString();
  const run: Run = { id: 'remote-run', sessionId: 'codex:remote', prompt: 'work', status: 'running', createdAt: now, output: '', origin: { kind: 'owner' } };
  const local: Snapshot = { sessions: [], runs: [], autoPrompts: [], providers: [], scanning: false, hostname: 'h', version: 't', updatedAt: now } as unknown as Snapshot;
  const remote = { ...local, runs: [run] } as Snapshot;
  // The joined computer's last snapshot stays mirrored; whether its state is arriving now decides whether its work counts.
  let streaming = true;
  const here = () => ({ ...local, nodes: [{ id: NODE, name: 'other', status: 'connected', features: [], streaming }] }) as unknown as Snapshot;
  const live = { fresh: async () => here(), snapshot: here, node: (id: string) => id === NODE ? remote : undefined } as unknown as LiveState;
  const tower = { hasCredentials: () => true, call: async () => ({ state: 'succeeded', status: 200, body: {} }) } as unknown as TowerClient;
  const master = new MasterSession({ stateDir: dir, dataDir: join(dir, 'data'), binding: () => ({ sessionId: 'claude:issue', provider: 'claude', startedAt: now }), folder: join(dir, 'f'),
    writeGuide: async () => {}, tower, live, followMs: 60_000 });
  t.after(() => master.close());
  await master.start();
  await master.started({ local: '/api/sessions', node: NODE } as never, { prompt: 'work' }, { session: { id: 'codex:remote' }, run: { id: run.id } });
  await master.follow();
  assert.equal(master.runningTasks(), 1, 'its state arrives: quiet work still counts');
  streaming = false;
  await master.follow();
  assert.equal(master.runningTasks(), 0, 'out of reach, the snapshot it left behind does not keep the work running');
  streaming = true;
  assert.equal(master.runningTasks(), 1, 'back in reach, it counts again');
});
