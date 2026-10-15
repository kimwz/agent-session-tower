import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretService } from '../../../server/secrets/service.js';
import { editPayload, legacyRecord, legacyRule, secretService, stored, storedSecret, storedTask } from '../../helpers/secrets.js';
import { fastVaultKdf } from '../../helpers/fast-kdf.js';

fastVaultKdf();

const password = 'owner-connect-fixture-password';
async function fixture(run: (service: SecretService, setTime: (time: number) => void) => Promise<void>) {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-owner-connect-')); let now = 1000;
  try { const service = await secretService(stateDir, { password, now: () => now }); await run(service, time => { now = time; }); }
  finally { await rm(stateDir, { recursive: true, force: true }); }
}
test('owner can connect a saved key to one session without giving other sessions automatic access', async () => fixture(async service => {
  const original = await service.ensureTask('original', '/original');
  const secret = await service.create({ name: 'SAVED_TOKEN', kind: 'scalar', value: 'FAKE_OWNER_TOKEN', connect: 'session' }, original);
  const target = await service.ensureTask('chosen', '/different'); const context = { ...target, runId: 'chosen-run' };
  assert.deepEqual(await service.list(context), []);
  await service.connectSession(target, [secret.id]);
  assert.equal((await service.resolve(context, secret.reference, 'env')).bytes.toString(), 'FAKE_OWNER_TOKEN');
  assert.deepEqual(stored(service).rules, [], 'a connection writes no rule');
  assert.deepEqual(service.settings().secrets[0].sharing, { revision: 1, allMachines: false, machines: [], folders: [] }, 'nor any sharing');
  const other = { ...await service.ensureTask('not-chosen', '/different'), runId: 'other-run' };
  assert.deepEqual(await service.list(other), []); await assert.rejects(service.resolve(other, secret.reference, 'env'));
  await service.disconnectSession(target, [secret.id]); await assert.rejects(service.resolve(context, secret.reference, 'env'));
  await service.connectSession(target, [secret.id]); assert.equal((await service.list(context))[0].id, secret.id);
}));
test('an owner connection opens every field and operation of a rule-governed key, while its rule alone keeps its limits', async () => fixture(async (service, setTime) => {
  const target = await service.ensureTask('chosen', '/fixture'); const context = { ...target, runId: 'run' };
  const bundle = legacyRecord(service.device().id, { name: 'bundle', groupId: 'legacy-group', kind: 'env', value: 'VISIBLE=FAKE_VISIBLE\nHIDDEN=FAKE_HIDDEN' });
  await editPayload(service, payload => {
    payload.groups.push({ id: 'legacy-group', name: 'Legacy', scope: 'global' }); payload.secrets.push(bundle);
    payload.rules.push(legacyRule({ groupId: 'legacy-group', secretIds: [bundle.metadata.id], hostId: target.hostId, root: target.root, operations: ['discover', 'env'], fields: { [bundle.metadata.id]: ['VISIBLE'] }, maxTtlMs: 100 }));
  });
  assert.deepEqual((await service.resolve(context, bundle.metadata.reference, 'env')).fields, { VISIBLE: 'FAKE_VISIBLE' }, 'a manual rule now applies automatically');
  await assert.rejects(service.resolve(context, `${bundle.metadata.reference}#HIDDEN`, 'env')); await assert.rejects(service.resolve(context, bundle.metadata.reference, 'file'));
  setTime(1100); await assert.rejects(service.resolve(context, bundle.metadata.reference, 'env'), 'the rule time limit counts from the task');
  await service.connectSession(target, [bundle.metadata.id]);
  assert.deepEqual((await service.resolve(context, bundle.metadata.reference, 'env')).fields, { VISIBLE: 'FAKE_VISIBLE', HIDDEN: 'FAKE_HIDDEN' });
  assert.equal((await service.resolve(context, `${bundle.metadata.reference}#HIDDEN`, 'env')).bytes.toString(), 'FAKE_HIDDEN');
  assert.deepEqual((await service.list(context))[0].operations, ['discover', 'env', 'pipe', 'file', 'compare', 'fingerprint']);
}));
test('an owner connection never edits rules, even disabled or expired ones', async () => fixture(async service => {
  const target = await service.ensureTask('chosen', '/fixture'); const context = { ...target, runId: 'run' };
  const records = [{ enabled: false }, { enabled: true, expiresAt: 999 }].map(policy => ({ policy, record: legacyRecord(service.device().id, { name: 'restricted', groupId: 'legacy-group', value: 'FAKE_RESTRICTED' }) }));
  await editPayload(service, payload => {
    payload.groups.push({ id: 'legacy-group', name: 'Legacy', scope: 'global' });
    for (const { policy, record } of records) { payload.secrets.push(record); payload.rules.push(legacyRule({ groupId: 'legacy-group', secretIds: [record.metadata.id], hostId: target.hostId, root: target.root, operations: ['discover'], ...policy })); }
  });
  for (const { record } of records) {
    assert.deepEqual(await service.list(context), []);
    const before = stored(service).rules; await service.connectSession(target, [record.metadata.id]);
    assert.deepEqual(stored(service).rules, before); assert.ok(storedTask(service, target.taskId)?.connected.includes(record.metadata.id));
    await service.disconnectSession(target, [record.metadata.id]);
  }
}));
test('owner connection refuses another task’s temporary value and rolls back a partially processed selection', async () => fixture(async service => {
  const chosen = await service.ensureTask('chosen', '/chosen'); const other = await service.ensureTask('other', '/other');
  const saved = await service.create({ name: 'saved', kind: 'scalar', value: 'FAKE_SAVED' });
  const temporary = await service.create({ name: 'private', kind: 'scalar', value: 'FAKE_TASK', temporary: true }, other);
  assert.deepEqual(storedTask(service, other.taskId)?.connected, [temporary.id], 'a pasted value is connected to its own session');
  const before = stored(service); await assert.rejects(service.connectSession(chosen, [saved.id, temporary.id]), /unavailable/);
  assert.deepEqual(stored(service).rules, before.rules); assert.deepEqual(storedTask(service, chosen.taskId)?.connected, []);
  await assert.rejects(service.connectSession(chosen, ['missing']), /unavailable/);
  await assert.rejects(service.connectSession({ ...chosen, root: '/forged' }, [saved.id]));
  await service.closeTask(chosen.taskId); await assert.rejects(service.connectSession(chosen, [saved.id]));
  await service.closeTask(other.taskId); assert.equal(storedSecret(service, temporary.id), false, 'it ends with its task');
}));
test('the owner’s first connection to a trusted node session starts its bounded task even where nothing is shared', async () => fixture(async service => {
  const hostId = '11111111-1111-4111-8111-111111111111';
  const remote = { hostId, root: '/remote', sessionId: 'remote-session', taskId: '22222222-2222-4222-8222-222222222222', projectId: 'node-local-project' };
  const secret = await service.create({ name: 'saved', kind: 'scalar', value: 'FAKE_REMOTE' });
  await assert.rejects(service.connectSession(remote, [secret.id]), /Remote task denied/, 'an untrusted computer');
  await service.trustPeer({ device: { ...service.device(), id: hostId }, routeId: 'fixture-route', direction: 'node', enabled: true });
  await assert.rejects(service.ensureRemoteTask({ ...remote, runId: 'remote-run' }), /Remote task denied/, 'automatic use cannot enter an uncovered folder');
  assert.deepEqual((await service.vault.journal() as { tasks: unknown[] }).tasks, []);
  await service.connectSession(remote, [secret.id]);
  const task = storedTask(service, remote.taskId)!;
  assert.deepEqual([task.connected, task.expiresAt! - task.createdAt, task.hostId, task.root], [[secret.id], 8 * 60 * 60_000, hostId, '/remote']);
  const context = await service.ensureRemoteTask({ ...remote, runId: 'remote-run' });
  assert.equal(context.projectId, undefined, 'the node’s own project ID never reaches the source');
  assert.equal((await service.resolve(context, secret.reference, 'env')).bytes.toString(), 'FAKE_REMOTE');
  await assert.rejects(service.ensureRemoteTask({ ...remote, root: '/remote/other', taskId: '33333333-3333-4333-8333-333333333333', runId: 'remote-run' }), /Remote task denied/);
  assert.deepEqual(stored(service).rules, [], 'no rule is written for a remote connection');
  // Stopping a key in a node session the owner has not acted on yet starts its task the same way, with the key excluded.
  const quiet = { ...remote, sessionId: 'remote-quiet', taskId: '44444444-4444-4444-8444-444444444444' };
  await service.disconnectSession(quiet, [secret.id]);
  assert.deepEqual([storedTask(service, quiet.taskId)?.excluded, storedTask(service, quiet.taskId)?.connected], [[secret.id], []]);
}));
