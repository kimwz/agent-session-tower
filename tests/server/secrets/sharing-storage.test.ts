import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SECRET_OPERATIONS, type SecretContext, type SecretMetadata, type SecretUsage } from '../../../shared/secrets.js';
import { kindOf } from '../../../shared/errors.js';
import type { SecretService } from '../../../server/secrets/service.js';
import { editPayload, legacyRecord, legacyRule, secretService, type StoredPayload, type StoredRecord } from '../../helpers/secrets.js';
import { writeState, type StateSnapshot } from '../backup/fixtures/state.js';
import * as oracle from './fixtures/grant-policy-1.130.2.js';
import { endTask as closeIn1130 } from './fixtures/task-close-1.130.2.js';

const PASSWORD = 'fixture-sharing-storage-password';
const FIXTURE_PASSWORD = 'fixture vault password 1';
const FIXTURES = join(import.meta.dirname, '../backup/fixtures');
const NODE = '11111111-1111-4111-8111-111111111111';

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tower-secret-sharing-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDir = join(directory, 'state'); await mkdir(stateDir);
  let now = 1_000_000; const service = await secretService(stateDir, { password: PASSWORD, now: () => now });
  const host = service.device().id;
  return { directory, stateDir, service, host, now: () => now, advance: (ms: number) => { now += ms; } };
}
const context = async (service: SecretService, sessionId: string, root: string): Promise<SecretContext> => ({ ...await service.ensureTask(sessionId, root), runId: `run-${sessionId}` });
const names = (list: SecretMetadata[]) => list.map(item => item.name).sort();
const payloadOf = async (service: SecretService, password = PASSWORD) => await service.vault.decryptImport((await service.exportEncryptedVault())!, password) as StoredPayload;
const refusal = (kind: string, message?: RegExp) => (error: Error) => kindOf(error) === kind && (!message || message.test(error.message));

test('keys saved before sharing keep 1.130.2 decisions, manual rules being the one change', async t => {
  const f = await fixture(t);
  const project = await f.service.project({ name: 'P', bindings: [{ hostId: f.host, root: '/p' }] });
  const record = (name: string, groupId: string, kind: 'scalar' | 'env' = 'scalar') => legacyRecord(f.host, { name, groupId, value: kind === 'env' ? 'A=1\nB=2\n' : `value-${name}`, kind });
  const keys = [record('manual-root', 'g'), record('auto-project', 'pg'), record('duplicate', 'g'), record('fields', 'g', 'env'), record('all-projects', 'g'), record('other-root', 'g'), record('boundary', 'pg')];
  const [manual, autoProject, duplicate, fields, allProjects, otherRoot, boundary] = keys;
  const rules = [legacyRule({ groupId: 'g', secretIds: [manual.metadata.id], hostId: f.host, root: '/p' }), legacyRule({ groupId: 'pg', secretIds: [autoProject.metadata.id], hostId: f.host, projectId: project.id, activation: 'auto' }),
    legacyRule({ groupId: 'g', secretIds: [duplicate.metadata.id], hostId: f.host, root: '/p' }), legacyRule({ groupId: 'g', secretIds: [duplicate.metadata.id], hostId: f.host, projectId: project.id, activation: 'auto' }),
    legacyRule({ groupId: 'g', secretIds: [fields.metadata.id], hostId: f.host, root: '/p', operations: ['discover', 'env', 'file'], fields: { [fields.metadata.id]: ['B'] } }),
    legacyRule({ groupId: 'g', secretIds: [allProjects.metadata.id], hostId: f.host, allProjects: true, activation: 'auto', operations: ['discover', 'env', 'compare'] }),
    legacyRule({ groupId: 'g', secretIds: [otherRoot.metadata.id], hostId: f.host, root: '/other' }), legacyRule({ groupId: 'pg', secretIds: [boundary.metadata.id], hostId: f.host, root: '/other' })];
  await editPayload(f.service, PASSWORD, payload => { payload.groups.push({ id: 'g', name: 'G', scope: 'global' }, { id: 'pg', name: 'PG', scope: 'project', projectId: project.id }); payload.secrets.push(...keys); payload.rules.push(...rules); });
  const subject = await context(f.service, 'session', '/p');
  const task = f.service.overview(subject).task!;
  const before = { deviceId: f.host, projects: [project], groups: [{ id: 'g', name: 'G', scope: 'global' as const }, { id: 'pg', name: 'PG', scope: 'project' as const, projectId: project.id }],
    rules: rules.map(rule => ({ ...rule, activation: 'auto' as const })), secrets: keys.map(key => ({ metadata: key.metadata, fieldNames: key.fields && Object.keys(key.fields) })), tasks: [task], grants: [] as oracle.PolicyGrant[] };
  const expected = oracle.discoverable(before, task, f.now(), 'assume').map(({ activation: _activation, ...item }) => JSON.parse(JSON.stringify(item)));
  assert.deepEqual(JSON.parse(JSON.stringify(await f.service.list(subject))), expected);
  assert.deepEqual(names(await f.service.list(subject)), ['all-projects', 'auto-project', 'fields', 'manual-root']);
  for (const key of keys) for (const operation of SECRET_OPERATIONS.filter(operation => operation !== 'discover')) {
    const item = { metadata: key.metadata, fieldNames: key.fields && Object.keys(key.fields) };
    // As in 1.130.2 resolution, a dotenv key with some fields selected goes out whole only to no operation, in part only to env.
    let allowed: boolean; try { const fields = oracle.selectedFields(item, oracle.authorize(before, task, item, operation, f.now(), 'assume')); allowed = operation === 'env' || !item.fieldNames || item.fieldNames.every(field => fields!.includes(field)); } catch { allowed = false; }
    assert.equal(await f.service.resolve(subject, key.metadata.reference, operation).then(() => true, () => false), allowed, `${key.metadata.name} ${operation}`);
  }
  assert.ok(f.service.settings().secrets.every(item => item.legacy && !item.sharing), 'nothing is converted');
  assert.deepEqual(f.service.settings().secrets.find(item => item.name === 'fields')?.legacy, { global: [], folders: [{ hostId: f.host, root: '/p' }], limited: true });
  assert.deepEqual(f.service.settings().secrets.find(item => item.name === 'auto-project')?.legacy, { global: [], folders: [{ hostId: f.host, root: '/p' }], limited: true });
});

test('sharing one key out of a shared rule leaves every other key’s decision, fields and rule revision as they were', async t => {
  const f = await fixture(t);
  const [edited, kept, alone] = ['edited', 'kept', 'alone'].map(name => legacyRecord(f.host, { name, groupId: 'g', value: `A=${name}\nB=${name}\n`, kind: 'env' }));
  const shared = legacyRule({ groupId: 'g', secretIds: [edited.metadata.id, kept.metadata.id], hostId: f.host, root: '/p', activation: 'auto', operations: ['discover', 'env'], fields: { [edited.metadata.id]: ['A'], [kept.metadata.id]: ['B'] }, revision: 3 });
  const only = legacyRule({ groupId: 'g', secretIds: [alone.metadata.id], hostId: f.host, root: '/p' });
  await editPayload(f.service, PASSWORD, payload => { payload.groups.push({ id: 'g', name: 'G', scope: 'global' }); payload.secrets.push(edited, kept, alone); payload.rules.push(shared, only); });
  const subject = await context(f.service, 'session', '/p');
  const keptBefore = (await f.service.list(subject)).find(item => item.id === kept.metadata.id);
  assert.deepEqual(keptBefore?.fields, ['B']);
  assert.deepEqual(await f.service.setSharing(edited.metadata.id, 0, { global: false, folders: [] }), { revision: 1, global: false, folders: [] });
  await f.service.setSharing(alone.metadata.id, 0, { global: false, folders: [{ hostId: f.host, root: '/q' }] });
  assert.deepEqual(f.service.overview().rules, [{ ...shared, secretIds: [kept.metadata.id], fields: { [kept.metadata.id]: ['B'] } }], 'only the edited keys leave; a rule left empty goes');
  assert.deepEqual((await f.service.list(subject)).find(item => item.id === kept.metadata.id), keptBefore);
  assert.deepEqual(names(await f.service.list(subject)), ['kept']);
  assert.deepEqual((await f.service.resolve(subject, kept.metadata.reference, 'env')).fields, { B: 'kept' });
  assert.ok(f.service.settings().secrets.find(item => item.id === kept.metadata.id)?.legacy);
});

test('sharing edits are revisioned, validated and limited to computers this vault serves', async t => {
  const f = await fixture(t);
  const secret = await f.service.create({ name: 'key', kind: 'scalar', value: 'v' });
  assert.deepEqual(f.service.settings().secrets[0].sharing, { revision: 1, global: false, folders: [] }, 'a new key is saved unshared');
  await assert.rejects(f.service.setSharing(secret.id, 0, { global: true, folders: [] }), refusal('conflict'));
  await assert.rejects(f.service.setSharing('missing', 1, { global: true, folders: [] }), refusal('not-found'));
  for (const folder of [{ hostId: NODE, root: '/node' }, { hostId: f.host, root: 'relative' }, { hostId: f.host, root: '/p/' }, { hostId: f.host, root: '/p/../q' }, { hostId: '', root: '/p' }])
    await assert.rejects(f.service.setSharing(secret.id, 1, { global: false, folders: [folder] }), refusal('invalid'), JSON.stringify(folder));
  await assert.rejects(f.service.setSharing(secret.id, 1, { global: 'yes', folders: [] } as never), refusal('invalid'));
  await f.service.trustPeer({ device: { ...f.service.device(), id: NODE }, routeId: 'node', direction: 'node', enabled: true });
  const saved = await f.service.setSharing(secret.id, 1, { global: false, folders: [{ hostId: NODE, root: '/node' }, { hostId: f.host, root: '/p' }, { hostId: NODE, root: '/node' }] });
  assert.deepEqual(saved, { revision: 2, global: false, folders: [{ hostId: NODE, root: '/node' }, { hostId: f.host, root: '/p' }] });
  await f.service.removePeer(NODE);
  assert.deepEqual((await f.service.setSharing(secret.id, 2, { global: true, folders: saved.folders })).folders, saved.folders, 'a kept folder of a computer no longer trusted can stay until the owner removes it');
  await assert.rejects(f.service.setSharing(secret.id, 3, { global: true, folders: [...saved.folders, { hostId: NODE, root: '/other' }] }), refusal('invalid'));
  const temporary = await f.service.create({ name: 'pasted', kind: 'scalar', value: 't', temporary: true }, await f.service.ensureTask('session', '/p'));
  await assert.rejects(f.service.setSharing(temporary.id, 1, { global: true, folders: [] }), refusal('not-found'), 'a session value is never shared');
  await assert.rejects(f.service.create({ name: 'pasted', kind: 'scalar', value: 't', temporary: true, sharing: { global: true, folders: [] } }, await f.service.ensureTask('session', '/p')), refusal('invalid'));
  await assert.rejects(f.service.create({ name: 'pasted', kind: 'scalar', value: 't', temporary: true }), /Task target required/);
});

test('an older build’s round trip: it reads, edits rules and saves; the upgrade follows its rules and withholds an edited key it named', async t => {
  const f = await fixture(t);
  const legacy = legacyRecord(f.host, { name: 'legacy', groupId: 'g', value: 'legacy-value' }), edited = legacyRecord(f.host, { name: 'edited', groupId: 'g', value: 'edited-value' });
  await editPayload(f.service, PASSWORD, payload => { payload.groups.push({ id: 'g', name: 'G', scope: 'global' }); payload.secrets.push(legacy, edited); payload.rules.push(legacyRule({ groupId: 'g', secretIds: [legacy.metadata.id, edited.metadata.id], hostId: f.host, root: '/a' })); });
  await f.service.setSharing(edited.metadata.id, 0, { global: true, folders: [] });
  const atA = await context(f.service, 'session-a', '/a'), atB = await context(f.service, 'session-b', '/b');
  assert.deepEqual(names(await f.service.list(atA)), ['edited', 'legacy']); assert.deepEqual(names(await f.service.list(atB)), ['edited']);
  // The older build keeps keys it does not know, so `sharing` survives; its rule editor sees the edited key in no rule.
  const saved = await payloadOf(f.service);
  assert.deepEqual(saved.rules.map(rule => rule.secretIds), [[legacy.metadata.id]]);
  assert.deepEqual(saved.secrets.find(item => item.metadata.id === edited.metadata.id)?.sharing, { revision: 1, global: true, folders: [] });
  await editPayload(f.service, PASSWORD, payload => {
    payload.rules[0] = { ...payload.rules[0], root: '/b', revision: payload.rules[0].revision + 1 };
    payload.rules.push(legacyRule({ groupId: 'g', secretIds: [edited.metadata.id], hostId: f.host, root: '/a' }));
  });
  assert.deepEqual(names(await f.service.list(atA)), [], 'the moved rule and the withheld key both apply at once');
  assert.deepEqual(names(await f.service.list(atB)), ['legacy']);
  const row = f.service.settings().secrets.find(item => item.id === edited.metadata.id)!;
  assert.deepEqual([row.withheld, row.sharing?.global], [true, true]);
  await f.service.connectSession(atA, [edited.metadata.id]);
  assert.deepEqual(names(await f.service.list(atA)), ['edited'], 'a session connection still opens a withheld key');
  await f.service.setSharing(edited.metadata.id, 1, { global: true, folders: [] });
  assert.equal(f.service.settings().secrets.find(item => item.id === edited.metadata.id)?.withheld, undefined);
  assert.deepEqual(f.service.overview().rules.map(rule => rule.secretIds), [[legacy.metadata.id]], 'the owner’s save takes the key out of the older build’s rule again');
  assert.deepEqual(names(await f.service.list(atB)), ['edited', 'legacy']);
});

test('a 1.105 vault opens in place, lists nothing while locked until its first unlock, and its key keeps its rules', async t => {
  const f = await fixture(t);
  const state = JSON.parse(await readFile(join(FIXTURES, 'backup-1.105.0-vault.state.json'), 'utf8')) as StateSnapshot;
  const stateDir = join(f.directory, 'state-1.105'); await mkdir(stateDir);
  await writeState(stateDir, Object.fromEntries(Object.entries(state).filter(([name]) => name.startsWith('secrets/'))));
  const service = await secretService(stateDir);
  assert.equal(service.lockedList('session', '/fixture', new Date().toISOString()), undefined, 'an index of an older build hides names');
  await service.unlock(FIXTURE_PASSWORD);
  const settings = service.settings();
  assert.deepEqual(settings.secrets.map(item => [item.name, item.sharing, item.legacy]), [['deploy-token', undefined, { global: [], folders: [], limited: false }]]);
  await service.lock();
  assert.deepEqual(service.lockedList('session', '/fixture', new Date().toISOString())?.secrets, []);
  const journal = JSON.parse(await readFile(join(stateDir, 'secrets', 'index.json'), 'utf8')) as { state: { format: number } };
  assert.equal(journal.state.format, 2);
});

/** What a vault file holds, values included, read with its password. */
const contents = async (service: SecretService, bytes: Buffer, password: string) => await service.vault.decryptImport(bytes, password) as StoredPayload;
const valueOf = (record: StoredRecord) => record.encoding === 'base64' ? Buffer.from(record.value, 'base64').toString() : record.value;

test('backups of 1.105 and of the sharing format import every key unshared, with IDs and values, and the Tower group', async t => {
  for (const [name, read] of [['1.105', async () => Buffer.from((JSON.parse(await readFile(join(FIXTURES, 'backup-1.105.0-vault.state.json'), 'utf8')) as StateSnapshot)['secrets/vault.json'], 'base64')],
    ['sharing v2', () => readFile(join(FIXTURES, 'vault-sharing-v2.json'))]] as const) {
    const f = await fixture(t); const bytes = await read();
    const source = await contents(f.service, bytes, FIXTURE_PASSWORD);
    if (name === 'sharing v2') {
      assert.deepEqual(source.secrets.map(item => [item.metadata.name, item.sharing?.global, item.sharing?.folders.length]).sort(), [['edited-token', false, 1], ['folder-env', false, 2], ['global-token', true, 0], ['ruled-token', undefined, undefined], ['unshared-file', false, 0]], 'the fixture mixes every kind');
      assert.ok(source.towerGroupId && source.groups.some(group => group.id === source.towerGroupId) && source.rules.length === 1 && !JSON.stringify(source).includes('FIXTURE_TEMPORARY_VALUE'));
    }
    await f.service.importEncryptedVault(bytes, FIXTURE_PASSWORD);
    await f.service.importEncryptedVault(bytes, FIXTURE_PASSWORD);
    const imported = await payloadOf(f.service);
    assert.deepEqual(imported.secrets.map(item => item.metadata.id).sort(), source.secrets.map(item => item.metadata.id).sort(), name);
    for (const record of imported.secrets) {
      const original = source.secrets.find(item => item.metadata.id === record.metadata.id)!;
      assert.equal(valueOf(record), valueOf(original), `${name}: ${record.metadata.name}`);
      assert.deepEqual([record.sharing, record.temporaryTaskId, record.metadata.reference], [{ revision: 1, global: false, folders: [] }, undefined, `tower-secret://${f.host}/${record.metadata.id}@${record.metadata.version}`]);
    }
    assert.deepEqual(imported.rules, []); assert.deepEqual(imported.peers, []);
    assert.ok(source.groups.filter(group => group.scope !== 'task').every(group => imported.groups.some(item => item.id === group.id)), `${name}: groups, Tower included`);
    const subject = await context(f.service, 'session', '/fixture/project');
    assert.deepEqual(await f.service.list(subject), [], `${name}: nothing imported is shared`);
  }
});

test('temporary values live in the journal with their task, and grants of an older journal are dropped at the next save', async t => {
  const f = await fixture(t);
  const target = await f.service.ensureTask('session', '/p'); const run = { ...target, runId: 'run' };
  const pasted = await f.service.create({ name: 'pasted', kind: 'scalar', value: 'PASTED_CANARY', temporary: true }, target);
  assert.equal((await f.service.resolve(run, pasted.reference, 'env')).bytes.toString(), 'PASTED_CANARY');
  assert.equal(JSON.stringify(await payloadOf(f.service)).includes(pasted.id), false, 'never in the permanent payload');
  const saved = await f.service.create({ name: 'saved', kind: 'scalar', value: 's' }); await f.service.create({ name: 'saved too', kind: 'scalar', value: 's' });
  const towerGroups = (await payloadOf(f.service)).groups.filter(group => group.name === 'Tower');
  assert.deepEqual(towerGroups.map(group => [group.id, group.scope]), [[saved.groupId, 'global']], 'one Tower group per vault, for saved keys only');
  assert.deepEqual(f.service.overview().groups.find(group => group.id === pasted.groupId), { id: pasted.groupId, name: 'pasted', scope: 'task', taskId: target.taskId });
  await f.service.closeTask(target.taskId);
  assert.equal(f.service.overview().secrets.some(secret => secret.id === pasted.id), false);
  // A journal as 1.130.2 left it: grants, and tasks without connections.
  const journal = await f.service.vault.journal() as Record<string, unknown> & { tasks: Record<string, unknown>[] };
  await f.service.vault.save(await payloadOf(f.service), { ...journal, tasks: journal.tasks.map(({ connected: _connected, ...task }) => task), grants: [{ taskId: target.taskId, secretId: saved.id, version: 1, ruleId: 'r', revision: 1 }] }, f.service.vault.index);
  await f.service.lock(); await f.service.unlock(PASSWORD);
  assert.deepEqual(f.service.overview(target).task?.connected, []);
  await f.service.flush();
  assert.equal('grants' in (await f.service.vault.journal() as object), false);
});

test('a temporary value keeps the task group 1.130.2 gave it, so that build drops it when it closes the task after a rollback', async t => {
  const f = await fixture(t);
  const target = await f.service.ensureTask('session', '/p');
  const pasted = await f.service.create({ name: 'pasted', kind: 'scalar', value: 'PASTED_ROLLBACK_CANARY', temporary: true }, target);
  // 1.130.2 reads the journal over its own empty one, then closes the task as it did.
  const older = { grants: [], ...await f.service.vault.journal() as object } as unknown as Parameters<typeof closeIn1130>[0] & { tasks: { id: string; status: 'open' | 'closed'; closedAt?: number }[] };
  assert.ok(older.secrets.some(secret => secret.metadata.id === pasted.id));
  closeIn1130(older, older.tasks.find(task => task.id === target.taskId)!, f.now());
  assert.equal(older.secrets.some(secret => secret.metadata.id === pasted.id), false);
  assert.equal(JSON.stringify(older).includes('PASTED_ROLLBACK_CANARY'), false);
});

test('usage is kept per session, value-free, for the latest thousand uses', async t => {
  const f = await fixture(t);
  const use = (index: number): SecretUsage => ({ at: index, secretId: `secret-${index % 3}`, name: `KEY_${index % 3}`, operation: 'env', outcome: 'delivered', review: 'exempt' });
  await f.service.recordUsage({ hostId: f.host, sessionId: 'other' }, [use(-1)]);
  await f.service.recordUsage({ hostId: f.host, sessionId: 'session' }, Array.from({ length: 1001 }, (_unused, index) => use(index)));
  const kept = f.service.usage({ sessionId: 'session' });
  assert.equal(kept.length, 1000); assert.deepEqual([kept[0].at, kept.at(-1)!.at], [1, 1000]);
  assert.deepEqual(f.service.usage({ sessionId: 'other' }), [], 'the oldest use of any session leaves first');
  await assert.rejects(f.service.recordUsage({ hostId: f.host, sessionId: 'session' }, [{ ...use(1), operation: 'read' as never }]), /Invalid secret usage/);
  await f.service.lock(); await f.service.unlock(PASSWORD);
  assert.equal(f.service.usage({ sessionId: 'session' }).length, 1000);
  assert.equal((await readFile(join(f.stateDir, 'secrets', 'journal.json'), 'utf8')).includes('KEY_1'), false, 'kept encrypted');
});

test('available and availableFor read without creating tasks or ledger entries', async t => {
  const f = await fixture(t);
  await f.service.trustPeer({ device: { ...f.service.device(), id: NODE }, routeId: 'node', direction: 'node', enabled: true });
  const global = await f.service.create({ name: 'global', kind: 'scalar', value: 'g', sharing: { global: true, folders: [] } });
  await f.service.create({ name: 'node-folder', kind: 'scalar', value: 'n', sharing: { global: false, folders: [{ hostId: NODE, root: '/node' }] } });
  const unshared = await f.service.create({ name: 'unshared', kind: 'scalar', value: 'u' });
  const journal = await readFile(join(f.stateDir, 'secrets', 'journal.json'));
  const fresh = f.service.available({ sessionId: 'session', root: '/p' });
  assert.deepEqual(fresh.map(item => [item.name, item.basis, item.operations.length, item.sourceHostId]), [['global', ['global'], 6, f.host]]);
  const remote = { hostId: NODE, sessionId: 'node-session', root: '/node', taskId: randomUUID(), runId: 'node-run' };
  assert.deepEqual(names(f.service.availableFor(remote)), ['global', 'node-folder']);
  assert.throws(() => f.service.availableFor({ ...remote, hostId: randomUUID() }), /Remote task denied/);
  assert.throws(() => f.service.availableFor({ ...remote, root: '/node/' }), /Remote task denied/);
  assert.deepEqual(await readFile(join(f.stateDir, 'secrets', 'journal.json')), journal, 'nothing was written');
  assert.deepEqual(f.service.overview().secrets.length, 3); assert.equal(f.service.currentTask('session'), undefined);
  const target = await f.service.ensureTask('session', '/p');
  await f.service.connectSession(target, [unshared.id]); await f.service.disconnectSession(target, [global.id]);
  assert.deepEqual(f.service.available({ sessionId: 'session', root: '/p' }).map(item => [item.name, item.basis]), [['unshared', ['session']]]);
  assert.deepEqual(f.service.available({ ...target }).map(item => item.name), ['unshared']);
  assert.throws(() => f.service.available({ ...target, root: '/elsewhere' }), /Task identity denied/);
});

test('a node’s existing task is admitted without coverage, only with its own identity from a trusted node', async t => {
  const f = await fixture(t);
  await f.service.trustPeer({ device: { ...f.service.device(), id: NODE }, routeId: 'node', direction: 'node', enabled: true });
  const secret = await f.service.create({ name: 'shared', kind: 'scalar', value: 's', sharing: { global: false, folders: [{ hostId: NODE, root: '/node' }] } });
  const remote = { hostId: NODE, sessionId: 'node-session', root: '/node', taskId: randomUUID(), runId: 'node-run' };
  const admitted = await f.service.ensureRemoteTask(remote);
  await f.service.setSharing(secret.id, 1, { global: false, folders: [] });
  assert.deepEqual(await f.service.ensureRemoteTask(remote), admitted, 'a close or list for the task it already has still reaches it');
  assert.deepEqual(await f.service.list(admitted), []);
  for (const other of [{ ...remote, sessionId: 'other-session' }, { ...remote, root: '/node/sub' }]) await assert.rejects(f.service.ensureRemoteTask(other), /Task identity denied/);
  await assert.rejects(f.service.ensureRemoteTask({ ...remote, taskId: randomUUID() }), /Remote task denied/, 'a new task still needs coverage');
  await f.service.removePeer(NODE); await assert.rejects(f.service.ensureRemoteTask(remote), /Remote task denied/);
});

test('disconnecting stops a key in that session whatever allows it, and connecting again lifts the stop', async t => {
  const f = await fixture(t);
  const ruled = legacyRecord(f.host, { name: 'ruled', groupId: 'g', value: 'r' });
  await editPayload(f.service, PASSWORD, payload => { payload.groups.push({ id: 'g', name: 'G', scope: 'global' }); payload.secrets.push(ruled); payload.rules.push(legacyRule({ groupId: 'g', secretIds: [ruled.metadata.id], hostId: f.host, allProjects: true, activation: 'auto' })); });
  const shared = await f.service.create({ name: 'shared', kind: 'scalar', value: 's', sharing: { global: true, folders: [{ hostId: f.host, root: '/p' }] } });
  const subject = await context(f.service, 'session', '/p'), other = await context(f.service, 'other', '/p');
  await f.service.connectSession(subject, [ruled.metadata.id, shared.id]);
  assert.deepEqual(f.service.available(subject).map(item => [item.name, item.basis]), [['ruled', ['session', 'legacy']], ['shared', ['session', 'global', 'folder']]]);
  await f.service.disconnectSession(subject, [ruled.metadata.id, shared.id]);
  assert.deepEqual(await f.service.list(subject), []); assert.deepEqual(names(await f.service.list(other)), ['ruled', 'shared'], 'only that session stops');
  await assert.rejects(f.service.resolve(subject, shared.reference, 'env'));
  await f.service.connectSession(subject, [shared.id]);
  assert.deepEqual(names(await f.service.list(subject)), ['shared']);
  assert.deepEqual(Object.keys((await f.service.list(subject))[0]).sort(), ['groupId', 'id', 'kind', 'name', 'operations', 'reference', 'sourceHostId', 'version'], 'listed metadata keeps the key set every paired build accepts');
  await f.service.remove(shared.id);
  assert.deepEqual(f.service.overview(subject).connected, [], 'a removed key leaves every connection');
  await f.service.connectSession(subject, [ruled.metadata.id]); await f.service.closeTask(subject.taskId);
  const next = await context(f.service, 'session', '/p');
  assert.deepEqual(f.service.available(next).map(item => [item.name, item.basis]), [['ruled', ['legacy']]], 'connections and stops end with their task');
});
