import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateStatus } from '../../../shared/link.js';
import { currentVersion, pointCurrent, runtimePaths, versionDirectory } from '../../../server/link/service.js';
import { handoffHeld, managedByService, readUpdateStatus, runUpdateHelper, updatePaths, Updates, type UpdateHelperSteps } from '../../../server/link/update.js';

async function stateDir(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(runtimePaths(directory).versions, '1.0.0'), { recursive: true });
  await pointCurrent(directory, '1.0.0');
  return directory;
}

/** A service that starts whatever `current` points at, and a clock that moves only while the helper waits. */
function service(state: string, behaviour: { install?: 'fails'; check?: 'fails'; starts?: (version: string) => boolean; reconnects?: boolean } = {}) {
  let clock = Date.parse('2026-09-24T00:00:00.000Z');
  let running = { version: '1.0.0', pid: 100 };
  const restarts: string[] = [];
  const seen: string[] = [];
  const steps: UpdateHelperSteps = {
    install: async version => {
      if (behaviour.install === 'fails') throw new Error('npm install failed');
      await mkdir(versionDirectory(state, version), { recursive: true });
      return versionDirectory(state, version);
    },
    check: async () => { if (behaviour.check === 'fails') throw new Error('does not start'); },
    point: version => pointCurrent(state, version),
    restart: async () => {
      const version = (await currentVersion(state))!;
      restarts.push(version);
      running = (behaviour.starts ?? (() => true))(version) ? { version, pid: running.pid + 1 } : { version: 'none', pid: 0 };
      seen.push(`held:${existsSync(updatePaths(state).hold)}`);
    },
    health: async () => running.pid ? running : undefined,
    controllers: async () => running.version === '1.0.0' || behaviour.reconnects !== false ? ['controller-a'] : [],
    sleep: async ms => { clock += ms; },
    now: () => clock,
    log: () => {},
  };
  return { steps, restarts, seen, running: () => running };
}

async function requested(state: string, version = '1.1.0') {
  const updates = new Updates({ stateDir: state, version: '1.0.0', port: 1, managed: true, spawnHelper: () => {} });
  const answer = await updates.request(version);
  assert.equal(answer.status, 202);
  return updates;
}

test('an update installs, checks and restarts into the new version, and keeps it once it answers and reconnects', async t => {
  const state = await stateDir(t);
  await requested(state);
  const s = service(state);
  const status = await runUpdateHelper(state, '1.1.0', s.steps);
  assert.equal(status?.stage, 'done');
  assert.equal(await currentVersion(state), '1.1.0');
  assert.deepEqual(s.restarts, ['1.1.0']);
  assert.deepEqual(s.seen, ['held:true'], 'the new web starts while the worker handoff is held');
  assert.equal(existsSync(updatePaths(state).hold), false, 'keeping the update releases the handoff');
  assert.equal(existsSync(updatePaths(state).lock), false);
  assert.equal((await readUpdateStatus(state))?.stage, 'done');
});

test('an update that cannot be installed or does not run leaves the running version alone', async t => {
  for (const [behaviour, code] of [[{ install: 'fails' }, 'install-failed'], [{ check: 'fails' }, 'check-failed']] as const) {
    const state = await stateDir(t);
    await requested(state);
    const s = service(state, behaviour);
    const status = await runUpdateHelper(state, '1.1.0', s.steps);
    assert.equal(status?.stage, 'failed');
    assert.equal(status?.code, code);
    assert.equal(await currentVersion(state), '1.0.0');
    assert.deepEqual(s.restarts, [], 'nothing restarts');
  }
});

test('a new version that does not come up, or does not reconnect, is replaced by the previous one', async t => {
  for (const [behaviour, code] of [[{ starts: (version: string) => version !== '1.1.0' }, 'start-failed'], [{ reconnects: false }, 'link-failed']] as const) {
    const state = await stateDir(t);
    await requested(state);
    const s = service(state, behaviour);
    const status = await runUpdateHelper(state, '1.1.0', s.steps);
    assert.equal(status?.stage, 'failed');
    assert.equal(status?.code, code);
    assert.equal(status?.failedStage, 'verifying');
    assert.equal(await currentVersion(state), '1.0.0');
    assert.deepEqual(s.restarts, ['1.1.0', '1.0.0']);
    assert.equal(s.running().version, '1.0.0');
    assert.equal(existsSync(updatePaths(state).hold), false);
  }
});

test('a restart command that fails does not decide the outcome; the service coming up does', async t => {
  const state = await stateDir(t);
  await requested(state);
  const s = service(state, { starts: version => version !== '1.1.0' });
  const restart = s.steps.restart;
  let calls = 0;
  // Like launchctl while the service keeps failing to start: the command errs, and launchd starts it anyway.
  s.steps.restart = async () => { await restart(); if (++calls === 2) throw new Error('launchctl kickstart timed out'); };
  const status = await runUpdateHelper(state, '1.1.0', s.steps);
  assert.equal(status?.code, 'start-failed', 'the previous version came back');
  assert.equal(s.running().version, '1.0.0');
});

test('when even the previous version does not come back, the failure says so', async t => {
  const state = await stateDir(t);
  await requested(state);
  const s = service(state, { starts: () => false });
  const status = await runUpdateHelper(state, '1.1.0', s.steps);
  assert.equal(status?.code, 'rollback-failed');
  assert.equal(await currentVersion(state), '1.0.0', 'the previous version is still the one the service starts');
});

test('only one helper runs, and it only carries out the update that was asked for', async t => {
  const state = await stateDir(t);
  await requested(state);
  await writeFile(updatePaths(state).lock, String(process.pid));
  assert.equal(await runUpdateHelper(state, '1.1.0', service(state).steps), undefined, 'another helper holds the lock');
  await rm(updatePaths(state).lock);
  const other = await runUpdateHelper(state, '1.2.0', service(state).steps);
  assert.equal(other?.version, '1.1.0');
  assert.equal(other?.stage, 'installing', 'a helper for a version nobody asked for does nothing');
});

test('a computer accepts only newer released versions, only as the background service, and one update at a time', async t => {
  const state = await stateDir(t);
  const spawned: string[] = [];
  let now = Date.parse('2026-09-24T00:00:00.000Z');
  const updates = new Updates({ stateDir: state, version: '1.0.0', port: 1, managed: true, spawnHelper: version => spawned.push(version), now: () => now });
  assert.equal((await updates.request('latest')).status, 400);
  assert.deepEqual((await updates.request('1.0.0')).body, { current: true }, 'the version it runs is not installed again');
  assert.equal((await updates.request('0.9.0')).status, 200, 'it never goes back');
  const unmanaged = new Updates({ stateDir: state, version: '1.0.0', port: 1, managed: false, spawnHelper: version => spawned.push(version) });
  assert.equal((await unmanaged.request('1.1.0')).body.code, 'not-service');
  const [first, again] = await Promise.all([updates.request('1.1.0'), updates.request('1.1.0')]);
  assert.equal(first.status, 202);
  assert.equal(again.status, 202);
  assert.deepEqual(spawned, ['1.1.0'], 'the same request sent twice starts one helper');
  assert.equal((await updates.request('1.2.0')).body.code, 'busy');
  now += 60_000;
  assert.equal((await updates.status())?.code, 'interrupted', 'a helper that never started is not waited for');
  assert.equal((await updates.request('1.2.0')).status, 202);
  assert.deepEqual(spawned, ['1.1.0', '1.2.0']);
});

test('an update cut short by a restart is settled when Tower starts', async t => {
  const state = await stateDir(t);
  const save = (stage: UpdateStatus['stage']) => writeFile(updatePaths(state).status, JSON.stringify({ version: '1.1.0', previous: '1.0.0', stage, startedAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z' }));
  await save('verifying');
  await writeFile(updatePaths(state).hold, '{}');
  await new Updates({ stateDir: state, version: '1.1.0', port: 1, managed: true }).recover();
  assert.equal((await readUpdateStatus(state))?.stage, 'done', 'the new version is up: it is kept');
  assert.equal(existsSync(updatePaths(state).hold), false);
  await save('installing');
  await new Updates({ stateDir: state, version: '1.0.0', port: 1, managed: true }).recover();
  const settled = await readUpdateStatus(state);
  assert.equal(settled?.stage, 'failed');
  assert.equal(settled?.code, 'interrupted');
  assert.equal(settled?.failedStage, 'installing');
});

test('versions nothing runs anymore are removed; the current, previous and running ones stay', async t => {
  const state = await stateDir(t);
  for (const version of ['0.8.0', '0.9.0', '1.1.0', '1.2.0']) await mkdir(versionDirectory(state, version), { recursive: true });
  await pointCurrent(state, '1.2.0');
  await writeFile(updatePaths(state).status, JSON.stringify({ version: '1.2.0', previous: '1.1.0', stage: 'done', startedAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z' }));
  await new Updates({ stateDir: state, version: '1.2.0', port: 1, managed: true }).prune(['0.9.0', undefined]);
  assert.deepEqual((await readdir(runtimePaths(state).versions)).sort(), ['0.9.0', '1.1.0', '1.2.0']);
});

test('a hold stops holding once it is old, and only the service’s own install counts as managed', async t => {
  const state = await stateDir(t);
  assert.equal(await handoffHeld(state), false);
  await writeFile(updatePaths(state).hold, '{}');
  assert.equal(await handoffHeld(state), true);
  const old = new Date(Date.now() - 16 * 60_000);
  await utimes(updatePaths(state).hold, old, old);
  assert.equal(await handoffHeld(state), false);
  assert.equal(existsSync(updatePaths(state).hold), false);
  const entry = join(versionDirectory(state, '1.0.0'), 'node_modules', 'agent-session-tower', 'bin', 'agent-session-tower.mjs');
  await mkdir(join(entry, '..'), { recursive: true });
  await writeFile(entry, '');
  const throughCurrent = join(runtimePaths(state).current, 'node_modules', 'agent-session-tower', 'bin', 'agent-session-tower.mjs');
  assert.equal(await managedByService(state, throughCurrent, true), true);
  assert.equal(await managedByService(state, throughCurrent, false), false, 'started by hand from the same files');
  const elsewhere = join(state, 'checkout.mjs');
  await writeFile(elsewhere, '');
  await symlink(elsewhere, join(state, 'link.mjs'));
  assert.equal(await managedByService(state, join(state, 'link.mjs'), true), false);
});
