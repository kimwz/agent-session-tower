import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireStateLock } from '../../../server/instance/state-lock.js';

async function fixture(t: { after: (fn: () => unknown) => void }) {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-monitor-lock-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}

test('only one monitor can own a shared state directory, even on different ports', async (t) => {
  const stateDir = await fixture(t);
  const release = await acquireStateLock(stateDir, 8000);
  await assert.rejects(acquireStateLock(stateDir, 8001), /already using.*PID.*localhost:8000/);
  await release();
  await release();
  const next = await acquireStateLock(stateDir, 8001);
  await next();
  assert.deepEqual(await readdir(stateDir), []);
});

test('concurrent contenders recover a dead owner without removing the winning live lock', async (t) => {
  const stateDir = await fixture(t);
  const lock = join(stateDir, '.instance-lock');
  await mkdir(lock);
  await writeFile(join(lock, 'owner-11111111-1111-4111-8111-111111111111.json'), JSON.stringify({ pid: 2147483647, port: 8000 }));
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => acquireStateLock(stateDir, 8100 + i)));
  const winners = results.filter((result) => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  const files = await readdir(lock);
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(await readFile(join(lock, files[0]!), 'utf8')).pid, process.pid);
  await winners[0]!.value();
  assert.deepEqual(await readdir(stateDir), []);
});

test('unknown lock contents are preserved instead of deleting an unverifiable owner', async (t) => {
  const stateDir = await fixture(t);
  const lock = join(stateDir, '.instance-lock');
  await mkdir(lock);
  await writeFile(join(lock, 'unexpected-file'), 'preserve me');
  await assert.rejects(acquireStateLock(stateDir, 8000), /Cannot verify/);
  assert.equal(await readFile(join(lock, 'unexpected-file'), 'utf8'), 'preserve me');
});
