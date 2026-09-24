import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateStatus } from '../../../shared/link.js';
import { currentVersion, pointCurrent, runtimePaths, versionDirectory } from '../../../server/link/service.js';
import { handoffHeld, heldWorkerEntry, managedByService, readUpdateStatus, runUpdateHelper, updatePaths, Updates, type UpdateHelperSteps } from '../../../server/link/update.js';

async function stateDir(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(runtimePaths(directory).versions, '1.0.0'), { recursive: true });
  await pointCurrent(directory, '1.0.0');
  return directory;
}

/** A service that starts whatever `current` points at, and a clock that moves only while the helper waits. */
function service(state: string, behaviour: { install?: 'fails'; check?: 'fails'; starts?: (version: string) => boolean; reconnects?: boolean; free?: number; dies?: string } = {}) {
  let clock = Date.parse('2026-09-24T00:00:00.000Z');
  let running = { version: '1.0.0', pid: 100 };
  const restarts: string[] = [];
  const seen: string[] = [];
  let answers = 0;
  const steps: UpdateHelperSteps = {
    free: async () => behaviour.free,
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
    // `dies`: that version answers a few times, then launchd starts it again as a new process.
    health: async () => { if (running.version === behaviour.dies && ++answers % 5 === 0) running = { ...running, pid: running.pid + 1 }; return running.pid ? running : undefined; },
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
    assert.deepEqual(s.seen, ['held:true', 'held:true'], 'the handoff stays held until the previous version answers again');
    assert.equal(s.running().version, '1.0.0');
    assert.equal(existsSync(updatePaths(state).hold), false);
  }
});

test('a new version that keeps being started again, or no space to install, is not kept', async t => {
  const state = await stateDir(t);
  await requested(state);
  const unstable = await runUpdateHelper(state, '1.1.0', service(state, { dies: '1.1.0' }).steps);
  assert.equal(unstable?.code, 'start-failed', 'answering once is not enough: it must stay up as the same process');
  assert.equal(await currentVersion(state), '1.0.0');
  await requested(state);
  const s = service(state, { free: 1024 ** 3 });
  const full = await runUpdateHelper(state, '1.1.0', s.steps);
  assert.equal(full?.code, 'low-disk');
  assert.deepEqual(s.restarts, []);
});

test('a busy computer that misses an answer while it is watched is not taken for a failed start', async t => {
  const state = await stateDir(t);
  await requested(state);
  const s = service(state);
  let asked = 0;
  const health = s.steps.health;
  const status = await runUpdateHelper(state, '1.1.0', { ...s.steps, health: async () => ++asked % 20 === 0 ? undefined : health() });
  assert.equal(status?.stage, 'done');
});

test('a switch that changed nothing leaves the running version as it is, without a restart', async t => {
  const state = await stateDir(t);
  await requested(state);
  const s = service(state);
  const status = await runUpdateHelper(state, '1.1.0', { ...s.steps, point: async () => { throw new Error('read-only file system'); } });
  assert.equal(status?.code, 'switch-failed');
  assert.deepEqual(s.restarts, []);
  assert.equal(existsSync(updatePaths(state).hold), false);
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
  assert.equal(existsSync(updatePaths(state).hold), true, 'a new web that may still run keeps holding the handoff');
});

test('only one helper runs, and it only carries out the update that was asked for', async t => {
  const state = await stateDir(t);
  await requested(state);
  await writeFile(updatePaths(state).lock, String(process.pid));
  assert.equal(await runUpdateHelper(state, '1.1.0', service(state).steps), undefined, 'another helper holds the lock');
  await writeFile(updatePaths(state).lock, `${process.pid} Thu Jan  1 00:00:00 1970`);
  assert.equal((await runUpdateHelper(state, '1.1.0', service(state).steps))?.stage, 'done', 'a lock whose pid now belongs to a process started later is left over');
  await requested(state, '1.2.0');
  const other = await runUpdateHelper(state, '1.3.0', service(state).steps);
  assert.equal(other?.version, '1.2.0');
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

test('an update cut short by a restart is checked again from where it was, or settled when it never came to run', async t => {
  const state = await stateDir(t);
  const save = (stage: UpdateStatus['stage'], extra = {}) => writeFile(updatePaths(state).status, JSON.stringify({ version: '1.1.0', previous: '1.0.0', stage, startedAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z', ...extra }));
  await save('verifying', { controllers: ['controller-a'] });
  await writeFile(updatePaths(state).hold, '{}');
  const long = new Date(Date.now() - 60 * 60_000);
  await utimes(updatePaths(state).hold, long, long);
  const resumed: Array<[string, boolean]> = [];
  await new Updates({ stateDir: state, version: '1.1.0', port: 1, managed: true, spawnHelper: (version, resume) => resumed.push([version, resume]) }).recover();
  assert.deepEqual(resumed, [['1.1.0', true]], 'the new version running is not proof it works: a helper checks it');
  assert.equal(await handoffHeld(state), true, 'held anew, however long the computer was off');
  await pointCurrent(state, '1.1.0');
  const checked = service(state);
  const status = await runUpdateHelper(state, '1.1.0', { ...checked.steps, health: async () => ({ version: '1.1.0', pid: 7 }) }, true);
  assert.equal(status?.stage, 'done');
  assert.equal(existsSync(updatePaths(state).hold), false);
  await save('verifying', { controllers: ['controller-a'] });
  await writeFile(updatePaths(state).hold, '{}');
  const unreachable = service(state, { reconnects: false });
  const back = await runUpdateHelper(state, '1.1.0', { ...unreachable.steps, controllers: async () => [], health: async () => unreachable.running().pid === 100 ? { version: '1.1.0', pid: 7 } : unreachable.running() }, true);
  assert.equal(back?.code, 'link-failed', 'a resumed check goes back just the same');
  assert.equal(await currentVersion(state), '1.0.0');
  await save('installing');
  await writeFile(updatePaths(state).hold, '{}');
  await new Updates({ stateDir: state, version: '1.0.0', port: 1, managed: true }).recover();
  assert.equal(existsSync(updatePaths(state).hold), false, 'the previous version running needs no hold');
  await save('rolling-back', { code: 'start-failed', failedStage: 'verifying' });
  await new Updates({ stateDir: state, version: '1.0.0', port: 1, managed: true }).recover();
  assert.equal((await readUpdateStatus(state))?.code, 'start-failed', 'going back brought the previous version up: the reason found stays');
  await save('installing');
  await new Updates({ stateDir: state, version: '1.0.0', port: 1, managed: false }).recover();
  assert.equal((await readUpdateStatus(state))?.stage, 'installing', 'a Tower not run as the service settles nothing');
  await pointCurrent(state, '1.1.0');
  const early = await runUpdateHelper(state, '1.1.0', service(state).steps, true);
  assert.equal(early?.code, 'interrupted', 'resumed at a stage that never switched anything, it ends');
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
  await new Updates({ stateDir: state, version: '1.2.0', port: 1, managed: true }).prune(async () => ['0.9.0', undefined, null]);
  assert.deepEqual((await readdir(runtimePaths(state).versions)).sort(), ['0.9.0', '1.1.0', '1.2.0']);
});

test('nothing is removed while an update is under way, when a helper runs, or when what runs cannot be told', async t => {
  const state = await stateDir(t);
  await mkdir(versionDirectory(state, '0.9.0'), { recursive: true });
  const updates = new Updates({ stateDir: state, version: '1.0.0', port: 1, managed: true, spawnHelper: () => {} });
  await writeFile(updatePaths(state).lock, String(process.pid));
  await updates.prune(async () => []);
  assert.ok(existsSync(versionDirectory(state, '0.9.0')), 'a helper is running');
  await rm(updatePaths(state).lock);
  await assert.rejects(updates.prune(async () => { throw new Error('the terminal host did not answer'); }));
  assert.ok(existsSync(versionDirectory(state, '0.9.0')));
  const [, answer] = await Promise.all([updates.prune(async () => []), updates.request('1.1.0')]);
  assert.equal(answer.status, 202, 'a request waits for pruning to finish');
  await mkdir(versionDirectory(state, '1.1.0'), { recursive: true });
  await updates.prune(async () => []);
  assert.ok(existsSync(versionDirectory(state, '1.1.0')), 'an update under way keeps what it installed');
});

test('while an update is tried, a worker that has to start is the previous version’s', async t => {
  const state = await stateDir(t);
  assert.equal(await heldWorkerEntry(state), undefined);
  await requested(state);
  await writeFile(updatePaths(state).hold, '{}');
  assert.equal(await heldWorkerEntry(state), undefined, 'the previous version is not installed where it can be started');
  const entry = join(versionDirectory(state, '1.0.0'), 'node_modules', 'agent-session-tower', 'bin', 'agent-session-tower.mjs');
  await mkdir(join(entry, '..'), { recursive: true });
  await writeFile(entry, '');
  assert.equal(await heldWorkerEntry(state), entry);
  await rm(updatePaths(state).hold);
  assert.equal(await heldWorkerEntry(state), undefined);
});

test('a hold stops holding once it is old, and only the service’s own install counts as managed', async t => {
  const state = await stateDir(t);
  assert.equal(await handoffHeld(state), false);
  await writeFile(updatePaths(state).hold, '{}');
  assert.equal(await handoffHeld(state), true);
  const old = new Date(Date.now() - 16 * 60_000);
  await utimes(updatePaths(state).hold, old, old);
  await writeFile(updatePaths(state).lock, String(process.pid));
  assert.equal(await handoffHeld(state), true, 'a hold does not run out while its helper is still at work');
  await rm(updatePaths(state).lock);
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
