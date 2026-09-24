import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireStateLock, commandEnvironment, COMMAND_ENV, lockOwners } from '../../../server/instance/state-lock.js';

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

test('a lock left from before a restart is taken over even when its pid now belongs to another process', async (t) => {
  const stateDir = await fixture(t);
  const lock = join(stateDir, '.instance-lock');
  await mkdir(lock);
  // This process's pid, but written by a process that started at another time.
  await writeFile(join(lock, 'owner-11111111-1111-4111-8111-111111111111.json'), JSON.stringify({ pid: process.pid, port: 8000, started: 'another boot:1' }));
  const release = await acquireStateLock(stateDir, 8001);
  const [owner] = await readdir(lock);
  const saved = JSON.parse(await readFile(join(lock, owner!), 'utf8'));
  assert.equal(saved.port, 8001);
  assert.ok(saved.started, 'the new owner records when it started');
  await assert.rejects(acquireStateLock(stateDir, 8002), /already using/, 'the owner that really runs keeps it');
  await release();
});

test('unknown lock contents are preserved instead of deleting an unverifiable owner', async (t) => {
  const stateDir = await fixture(t);
  const lock = join(stateDir, '.instance-lock');
  await mkdir(lock);
  await writeFile(join(lock, 'unexpected-file'), 'preserve me');
  await assert.rejects(acquireStateLock(stateDir, 8000), /Cannot verify/);
  assert.equal(await readFile(join(lock, 'unexpected-file'), 'utf8'), 'preserve me');
});

test('an owner records how it was started, so it can be started again the same way; older records still read', async (t) => {
  const stateDir = await fixture(t);
  const release = await acquireStateLock(stateDir, 8000);
  const [owner] = await lockOwners(stateDir);
  assert.equal(owner?.pid, process.pid);
  assert.equal(owner?.command?.execPath, process.execPath);
  assert.equal(owner?.command?.cwd, process.cwd());
  assert.deepEqual(owner?.command?.argv.slice(-process.argv.length + 1), process.argv.slice(1), 'its own arguments come last, after Node’s own options');
  assert.deepEqual(Object.keys(owner?.command?.env ?? {}).filter(key => !(COMMAND_ENV as readonly string[]).includes(key)), [], 'only what picks its tools is kept, never tokens');
  assert.equal(owner?.command?.env?.PATH, process.env.PATH);
  await release();
  const lock = join(stateDir, '.instance-lock');
  await mkdir(lock);
  await writeFile(join(lock, 'owner-11111111-1111-4111-8111-111111111111.json'), JSON.stringify({ pid: process.pid, port: 8001 }));
  assert.deepEqual(await lockOwners(stateDir), [{ pid: process.pid, port: 8001 }]);
  await writeFile(join(lock, 'owner-11111111-1111-4111-8111-111111111111.json'), JSON.stringify({ pid: process.pid, port: 8001, command: { execPath: '/bin/node', argv: [1], cwd: '/' } }));
  assert.deepEqual(await lockOwners(stateDir), [{ pid: process.pid, port: 8001 }], 'a command that is not one is left out');
});

test('a recorded environment is put back as it was: what it set is set again, and what it left unset stays unset', () => {
  const base = { PATH: '/now/bin', CODEX_HOME: '/now/codex', SECRET: 'kept as it is' };
  assert.deepEqual(commandEnvironment({ PATH: '/then/bin', CLAUDE_CONFIG_DIR: '/then/claude' }, base), { PATH: '/then/bin', CLAUDE_CONFIG_DIR: '/then/claude', SECRET: 'kept as it is' });
  assert.equal(commandEnvironment(undefined, base), base, 'an older record changes nothing');
});
