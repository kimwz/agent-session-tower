import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretService } from '../../../server/secrets/service.js';

const password = 'owner-connect-fixture-password';
async function fixture(run: (service: SecretService, setTime: (time: number) => void) => Promise<void>) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-owner-connect-')); let now = 1000;
  try { const service = new SecretService({ stateDir, now: () => now }); await service.start(); await service.initialize(password); await run(service, time => { now = time; }); }
  finally { await rm(stateDir, { recursive: true, force: true }); }
}
test('owner can click a saved global key in another project without giving other sessions automatic access', async () => fixture(async service => {
  const original = await service.ensureTask('original', '/original');
  const secret = await service.create({ name: 'GLOBAL_TOKEN', scope: 'global', kind: 'scalar', value: 'FAKE_OWNER_TOKEN', target: original, connect: true });
  const target = await service.ensureTask('chosen', '/different'); const context = { ...target, runId: 'chosen-run' };
  assert.deepEqual(await service.list(context), []);
  await service.connect(target, [secret.id]);
  assert.equal((await service.resolve(context, secret.reference, 'env')).bytes.toString(), 'FAKE_OWNER_TOKEN');
  const rule = service.overview().rules.find(rule => rule.root === '/different')!;
  assert.equal(rule.activation, 'manual'); assert.equal(rule.allProjects, undefined);
  assert.deepEqual(rule.operations, ['discover', 'env', 'pipe', 'file']);
  const other = { ...await service.ensureTask('not-chosen', '/different'), runId: 'other-run' };
  assert.deepEqual(await service.list(other), []); await assert.rejects(service.resolve(other, secret.reference, 'env'));
  await service.revoke(target, [secret.id]); await assert.rejects(service.resolve(context, secret.reference, 'env'));
  await service.connect(target, [secret.id]); assert.equal((await service.list(context))[0].id, secret.id);
}));
test('owner connection preserves selected fields, discover-only access and fixed grant deadlines', async () => fixture(async (service, setTime) => {
  const target = await service.ensureTask('chosen', '/fixture'); const context = { ...target, runId: 'run' };
  const secret = await service.create({ name: 'bundle', scope: 'global', kind: 'env', value: 'VISIBLE=FAKE_VISIBLE\nHIDDEN=FAKE_HIDDEN' });
  await service.setRule({ groupId: secret.groupId, secretIds: [secret.id], hostId: target.hostId, root: target.root, activation: 'manual', operations: ['discover', 'env'], fields: { [secret.id]: ['VISIBLE'] }, maxTtlMs: 100, enabled: true });
  await service.connect(target, [secret.id]); assert.deepEqual((await service.resolve(context, secret.reference, 'env')).fields, { VISIBLE: 'FAKE_VISIBLE' });
  await assert.rejects(service.resolve(context, `${secret.reference}#HIDDEN`, 'env'));
  setTime(1050); await service.connect(target, [secret.id]); setTime(1101);
  await assert.rejects(service.connect(target, [secret.id]), /expired/); await assert.rejects(service.resolve(context, secret.reference, 'env'));
  const discover = await service.create({ name: 'discover-only', scope: 'global', kind: 'scalar', value: 'FAKE_DISCOVER' });
  await service.setRule({ groupId: discover.groupId, secretIds: [discover.id], hostId: target.hostId, root: target.root, activation: 'manual', operations: ['discover'], enabled: true });
  await service.connect(target, [discover.id]); assert.equal((await service.list(context)).some(key => key.id === discover.id), true);
  await assert.rejects(service.resolve(context, discover.reference, 'env'));
}));
test('owner connection never replaces disabled or expired policies with a default unrestricted rule', async () => fixture(async service => {
  const target = await service.ensureTask('chosen', '/fixture');
  for (const policy of [{ enabled: false }, { enabled: true, expiresAt: 999 }]) {
    const secret = await service.create({ name: 'restricted', scope: 'global', kind: 'scalar', value: 'FAKE_RESTRICTED' });
    await service.setRule({ groupId: secret.groupId, secretIds: [secret.id], hostId: target.hostId, root: target.root, activation: 'manual', operations: ['discover'], ...policy });
    const before = service.overview(); await assert.rejects(service.connect(target, [secret.id]), /policy/);
    assert.deepEqual(service.overview().rules, before.rules); assert.deepEqual(service.overview(target).connected, []);
  }
}));
test('owner connection rejects other project/task scope and rolls back a partially processed selection', async () => fixture(async service => {
  const chosen = await service.ensureTask('chosen', '/chosen'); const other = await service.ensureTask('other', '/other');
  const global = await service.create({ name: 'global', scope: 'global', kind: 'scalar', value: 'FAKE_GLOBAL' });
  const task = await service.create({ name: 'private', scope: 'task', kind: 'scalar', value: 'FAKE_TASK', target: other, connect: true });
  const before = service.overview(); await assert.rejects(service.connect(chosen, [global.id, task.id]));
  assert.deepEqual(service.overview().rules, before.rules); assert.deepEqual(service.overview(chosen).connected, []);
  await assert.rejects(service.connect({ ...chosen, root: '/forged' }, [global.id]));
  await service.closeTask(chosen.taskId); await assert.rejects(service.connect(chosen, [global.id]));
}));
test('owner remote connection requires a proven trusted task and creates only a bounded manual grant', async () => fixture(async service => {
  const hostId = '11111111-1111-4111-8111-111111111111';
  const remote = { hostId, root: '/remote', sessionId: 'remote-session', taskId: '22222222-2222-4222-8222-222222222222', runId: 'remote-run' };
  await assert.rejects(service.ensureRemoteTask(remote));
  await service.trustPeer({ device: { ...service.device(), id: hostId }, routeId: 'fixture-route', direction: 'node', enabled: true });
  await service.project({ name: 'remote', bindings: [{ hostId, root: remote.root }] });
  const target = await service.ensureRemoteTask(remote);
  const secret = await service.create({ name: 'global', scope: 'global', kind: 'scalar', value: 'FAKE_REMOTE' });
  await service.connect(target, [secret.id]); const rule = service.overview().rules[0];
  assert.equal(rule.maxTtlMs, 8 * 60 * 60_000); assert.equal(rule.hostId, hostId); assert.equal(rule.activation, 'manual'); assert.equal(rule.allProjects, undefined);
}));
