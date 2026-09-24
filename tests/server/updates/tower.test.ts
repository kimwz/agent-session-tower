import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateStatus } from '../../../shared/link.js';
import { TowerAutoUpdate } from '../../../server/updates/tower.js';

const HOUR = 60 * 60_000;

async function fixture(t: TestContext, options: { managed?: boolean; controllers?: number; latest?: string | undefined; enabled?: boolean } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-auto-update-'));
  await mkdir(join(stateDir, 'runtime'), { recursive: true });
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let clock = Date.parse('2026-09-24T00:00:00Z');
  let status: UpdateStatus | undefined;
  let latest = 'latest' in options ? options.latest : '1.32.0';
  let controllers = options.controllers ?? 0;
  const requests: unknown[] = [];
  const updates = {
    managed: options.managed ?? true,
    request: async (version: unknown) => {
      requests.push(version);
      status = { version: String(version), previous: '1.31.0', stage: 'installing', startedAt: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString() };
      return { status: 202, body: { update: status } };
    },
    status: async () => status,
  };
  const auto = new TowerAutoUpdate({ stateDir, version: '1.31.0', enabled: options.enabled ?? true, updates, controllers: () => controllers,
    latest: async () => latest ? { version: latest, checkedAt: new Date(clock).toISOString(), source: 'api' } : undefined, now: () => clock, firstMs: 10 ** 9 });
  await auto.start();
  t.after(() => auto.stop());
  return {
    auto, stateDir, requests,
    fail: () => { status = { ...status!, stage: 'failed', code: 'install-failed', failedStage: 'installing', updatedAt: new Date(clock).toISOString() }; },
    advance: (ms: number) => { clock += ms; },
    set: (patch: { latest?: string; controllers?: number }) => { if ('latest' in patch) latest = patch.latest; if (patch.controllers !== undefined) controllers = patch.controllers; },
  };
}

test('a service moves to the latest release, and a failed version is tried again on the schedule only', async t => {
  const f = await fixture(t);
  await f.auto.check();
  assert.deepEqual(f.requests, ['1.32.0']);
  f.fail();
  await f.auto.check();
  assert.deepEqual(f.requests, ['1.32.0'], 'not again at once');
  assert.equal(f.auto.status().nextAt, '2026-09-24T01:00:00.000Z');
  assert.deepEqual(JSON.parse(await readFile(join(f.stateDir, 'runtime', 'auto-update.json'), 'utf8')).retry, { version: '1.32.0', attempts: 1, nextAt: '2026-09-24T01:00:00.000Z' });
  f.advance(HOUR);
  await f.auto.check();
  assert.deepEqual(f.requests, ['1.32.0', '1.32.0']);
  f.fail();
  f.advance(HOUR);
  await f.auto.check();
  assert.equal(f.requests.length, 2, 'the second retry waits two hours');
  f.set({ latest: '1.33.0' });
  await f.auto.check();
  assert.deepEqual(f.requests.at(-1), '1.33.0', 'a newer release is tried at once');
});

test('the owner’s own attempt failing leaves the retry schedule as it was', async t => {
  const f = await fixture(t);
  await f.auto.check();
  f.fail();
  await f.auto.check();
  const scheduled = { version: '1.32.0', attempts: 1, nextAt: '2026-09-24T01:00:00.000Z' };
  f.advance(10 * 60_000);
  assert.equal((await f.auto.updateNow()).status, 202);
  f.fail();
  await f.auto.check();
  const saved = JSON.parse(await readFile(join(f.stateDir, 'runtime', 'auto-update.json'), 'utf8'));
  assert.deepEqual(saved.retry, scheduled, 'only automatic attempts count; the owner can try as often as they like');
  assert.equal(saved.counted, '2026-09-24T00:10:00.000Z', 'the owner’s failure is seen once and never counted later');
  assert.equal(f.auto.status().nextAt, scheduled.nextAt);
  assert.deepEqual(f.requests, ['1.32.0', '1.32.0'], 'nothing is tried by itself before its time');
  f.advance(50 * 60_000);
  await f.auto.check();
  assert.deepEqual(f.requests, ['1.32.0', '1.32.0', '1.32.0'], 'the schedule goes on as if the owner had not tried');
});

test('a paired computer follows its controller, a disabled or unmanaged Tower only reports the latest, and the owner can update at once', async t => {
  const paired = await fixture(t, { controllers: 1 });
  await paired.auto.check();
  assert.deepEqual(paired.requests, []);
  assert.deepEqual(paired.auto.status(), { kind: 'service', latest: '1.32.0', checkedAt: '2026-09-24T00:00:00.000Z', followsController: true });
  const unmanaged = await fixture(t, { managed: false });
  await unmanaged.auto.check();
  assert.deepEqual(unmanaged.requests, []);
  assert.equal(unmanaged.auto.status().kind, 'unmanaged');
  const off = await fixture(t, { enabled: false });
  await off.auto.check();
  assert.deepEqual(off.requests, []);
  const current = await fixture(t, { latest: '1.31.0' });
  await current.auto.check();
  assert.deepEqual(current.requests, []);
  // The owner's own request tries at once, whatever the schedule says.
  paired.fail();
  assert.equal((await paired.auto.updateNow()).status, 202);
  assert.equal((await paired.auto.updateNow('1.32.1')).status, 202);
  assert.deepEqual(paired.requests, ['1.32.0', '1.32.1']);
  const unknown = await fixture(t, { latest: undefined });
  assert.equal((await unknown.auto.updateNow()).status, 503);
});
