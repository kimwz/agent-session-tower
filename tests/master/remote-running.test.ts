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

test('work on a joined computer counts as running while that computer is seen, not on a snapshot it left behind', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-remote-running-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'data'), { recursive: true });
  const now = new Date().toISOString();
  const run: Run = { id: 'remote-run', sessionId: 'codex:remote', prompt: 'work', status: 'running', createdAt: now, output: '', origin: { kind: 'owner' } };
  const local: Snapshot = { sessions: [], runs: [], autoPrompts: [], providers: [], scanning: false, hostname: 'h', version: 't', updatedAt: now } as unknown as Snapshot;
  const remote = { ...local, runs: [run] } as Snapshot;
  // The joined computer's last snapshot stays mirrored; when it last arrived decides whether it still counts.
  let arrivedAt = Date.now();
  const live = { fresh: async () => local, snapshot: () => local, node: (id: string) => id === NODE ? remote : undefined, nodeAt: () => arrivedAt } as unknown as LiveState;
  const tower = { hasCredentials: () => true, call: async () => ({ state: 'succeeded', status: 200, body: {} }) } as unknown as TowerClient;
  const master = new MasterSession({ stateDir: dir, dataDir: join(dir, 'data'), binding: () => ({ sessionId: 'claude:issue', provider: 'claude', startedAt: now }), folder: join(dir, 'f'),
    writeGuide: async () => {}, tower, live, followMs: 60_000 });
  t.after(() => master.close());
  await master.start();
  await master.started({ local: '/api/sessions', node: NODE } as never, { prompt: 'work' }, { session: { id: 'codex:remote' }, run: { id: run.id } });
  await master.follow();
  assert.equal(master.runningTasks(), 1, 'seen just now');
  arrivedAt = Date.now() - 31 * 60_000;
  const gone = new MasterSession({ stateDir: dir, dataDir: join(dir, 'data'), binding: () => ({ sessionId: 'claude:issue', provider: 'claude', startedAt: now }), folder: join(dir, 'f'),
    writeGuide: async () => {}, tower, live, followMs: 60_000 });
  t.after(() => gone.close());
  await gone.start();
  await gone.follow();
  assert.equal(gone.runningTasks(), 0, 'a snapshot that last arrived over 30 minutes ago does not keep the work running');
});
