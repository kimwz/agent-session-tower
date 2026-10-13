import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SecretRuntime } from '../../../server/secrets/runtime.js';
import { FixtureRuns, editPayload, legacyRecord, legacyRule, secretService } from '../../helpers/secrets.js';
import { SECRET_LOCKED_UNINDEXED, SECRET_LOCKED_USE, SECRET_NO_VAULT } from '../../../server/secrets/notices.js';
import type { SecretContext, SecretMetadata, SecretRule } from '../../../shared/secrets.js';
import { statusOf } from '../../../shared/errors.js';

const PASSWORD = 'fixture-locked-list-password';
const CANARY = 'LOCKED_LIST_VALUE_CANARY_5531';

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tower-secret-locked-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDir = join(directory, 'state'), root = join(directory, 'project'), other = join(directory, 'other');
  await Promise.all([stateDir, root, other].map(path => mkdir(path)));
  let now = Date.now(); const clock = { advance: (ms: number) => { now += ms; } };
  const service = await secretService(stateDir, { password: PASSWORD, now: () => now });
  const host = service.device().id;
  const project = { id: randomUUID(), name: 'fixture', bindings: [{ hostId: host, root }] }, otherProject = { id: randomUUID(), name: 'other', bindings: [{ hostId: host, root: other }] };
  await editPayload(service, payload => { payload.projects.push(project, otherProject); });
  const startedAt = new Date(now).toISOString();
  const target = await service.bindRun('codex:session-a', root, startedAt);
  const context: SecretContext = { ...target, runId: 'run-a' };
  return { now: () => now, stateDir, root, other, service, host, project, otherProject, target, context, startedAt, clock, restart: () => secretService(stateDir, { now: () => now }) };
}

/** Every rule shape and sharing basis that decides discovery or operations, so locked and unlocked evaluation are held to one outcome. */
async function scenario(f: Awaited<ReturnType<typeof fixture>>) {
  const { service, target, project, otherProject, host, root, other } = f;
  // Keys saved by builds before per-secret sharing keep their rules; manual rules now apply automatically.
  const legacy = (name: string, groupId: string, extra: { kind?: 'env'; value?: string; expiresAt?: number } = {}) => legacyRecord(host, { name, groupId, value: CANARY, ...extra });
  const keys = { global: legacy('GLOBAL_AUTO', 'legacy-global'), manual: legacy('PROJECT_MANUAL', 'legacy-project'), other: legacy('OTHER_PROJECT', 'legacy-other'), expiring: legacy('EXPIRING', 'legacy-project', { expiresAt: f.now() + 60_000 }),
    dotenv: legacy('DOTENV', 'legacy-project', { kind: 'env', value: `A=${CANARY}\nB=${CANARY}\n` }), overlap: legacy('OVERLAP', 'legacy-project'), disabled: legacy('DISABLED', 'legacy-project'), deadline: legacy('DEADLINE', 'legacy-project') };
  const rule = (key: ReturnType<typeof legacy>, extra: Partial<SecretRule>) => legacyRule({ groupId: key.metadata.groupId, secretIds: [key.metadata.id], hostId: host, ...extra });
  await editPayload(service, payload => {
    payload.groups.push({ id: 'legacy-global', name: 'Global', scope: 'global' }, { id: 'legacy-project', name: 'Project', scope: 'project', projectId: project.id }, { id: 'legacy-other', name: 'Other', scope: 'project', projectId: otherProject.id });
    payload.secrets.push(...Object.values(keys));
    payload.rules.push(rule(keys.global, { allProjects: true, activation: 'auto', operations: ['discover', 'env'] }), rule(keys.manual, { projectId: project.id }), rule(keys.other, { projectId: otherProject.id, activation: 'auto' }),
      rule(keys.expiring, { projectId: project.id, activation: 'auto' }), rule(keys.dotenv, { projectId: project.id, activation: 'auto', operations: ['discover', 'env'], fields: { [keys.dotenv.metadata.id]: ['A'] } }),
      // A second rule granting only env makes env ambiguous while discover stays single.
      rule(keys.overlap, { projectId: project.id, activation: 'auto', operations: ['discover', 'env'] }), rule(keys.overlap, { projectId: project.id, activation: 'auto', operations: ['env'] }),
      rule(keys.disabled, { projectId: project.id, activation: 'auto', enabled: false }),
      // A time limit that passes while the vault is locked.
      rule(keys.deadline, { projectId: project.id, maxTtlMs: 60_000 }));
  });
  await service.create({ name: 'SHARED_GLOBAL', kind: 'scalar', value: CANARY, sharing: { global: true, folders: [] } });
  await service.create({ name: 'SHARED_FOLDER', kind: 'scalar', value: CANARY, sharing: { global: false, folders: [{ hostId: host, root }] } });
  await service.create({ name: 'OTHER_FOLDER', kind: 'scalar', value: CANARY, sharing: { global: false, folders: [{ hostId: host, root: other }] } });
  await service.create({ name: 'UNSHARED', kind: 'scalar', value: CANARY });
  await service.create({ name: 'UNSHARED_CONNECTED', kind: 'scalar', value: CANARY, connect: 'session' }, target);
  await service.create({ name: 'TEMPORARY', kind: 'env', value: `A=${CANARY}\n`, temporary: true }, target);
  const revoked = await service.create({ name: 'REVOKED', kind: 'scalar', value: CANARY, sharing: { global: true, folders: [] } });
  await service.disconnectSession(target, [revoked.id]);
  // An older build put this shared key back into a rule, so its sharing waits for the owner.
  const withheld = await service.create({ name: 'WITHHELD', kind: 'scalar', value: CANARY, sharing: { global: true, folders: [] } });
  await editPayload(service, payload => { payload.rules.push(legacyRule({ groupId: withheld.groupId, secretIds: [withheld.id], hostId: host, allProjects: true, activation: 'auto' })); });
}

const names = (list: SecretMetadata[]) => list.map(item => item.name).sort();
/** Tool results travel as JSON, where an undefined field and a missing one are the same. */
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));

test('locked listing matches unlocked authorization, including operations, fields, sharing, connections and expiry', async t => {
  const f = await fixture(t); await scenario(f);
  const unlocked = await f.service.list(f.context);
  assert.deepEqual(names(unlocked), ['DEADLINE', 'DOTENV', 'EXPIRING', 'GLOBAL_AUTO', 'OVERLAP', 'PROJECT_MANUAL', 'SHARED_FOLDER', 'SHARED_GLOBAL', 'TEMPORARY', 'UNSHARED_CONNECTED']);
  assert.deepEqual(unlocked.find(item => item.name === 'OVERLAP')!.operations, ['discover']);
  assert.deepEqual(unlocked.find(item => item.name === 'DOTENV')!.fields, ['A']);
  await f.service.lock();
  assert.deepEqual(wire(f.service.lockedList(f.target.sessionId, f.root, f.startedAt, f.target)!.secrets), wire(unlocked));
  const restarted = await f.restart();
  assert.equal(restarted.status().locked, true);
  assert.deepEqual(wire(restarted.lockedList(f.target.sessionId, f.root, f.startedAt, f.target)!.secrets), wire(unlocked));
  assert.deepEqual(wire(restarted.lockedList(f.target.sessionId, f.root, f.startedAt)!.secrets), wire(unlocked), 'an unbound run finds the session’s open task');

  f.clock.advance(120_000);
  const lockedLater = restarted.lockedList(f.target.sessionId, f.root, f.startedAt, f.target)!.secrets;
  await restarted.unlock(PASSWORD);
  assert.deepEqual(wire(lockedLater), wire(await restarted.list(f.context)));
  assert.ok(!names(lockedLater).includes('EXPIRING')); assert.ok(!names(lockedLater).includes('DEADLINE'));
});

test('a session without a task lists only what a fresh task would, and closed tasks stay closed', async t => {
  const f = await fixture(t); await scenario(f);
  await f.service.lock();
  const fresh = f.service.lockedList('codex:session-b', f.root, new Date(f.now()).toISOString())!.secrets;
  await f.service.unlock(PASSWORD);
  const bound = await f.service.bindRun('codex:session-b', f.root, new Date(f.now()).toISOString());
  assert.deepEqual(wire(fresh), wire(await f.service.list({ ...bound, runId: 'run-b' })));
  assert.deepEqual(names(fresh), ['DEADLINE', 'DOTENV', 'EXPIRING', 'GLOBAL_AUTO', 'OVERLAP', 'PROJECT_MANUAL', 'REVOKED', 'SHARED_FOLDER', 'SHARED_GLOBAL'], 'connections and revocations belong to the task they were made for');

  await f.service.closeTask(f.target.taskId); await f.service.lock();
  assert.throws(() => f.service.lockedList(f.target.sessionId, f.root, f.startedAt, f.target)!.secrets, /Task identity denied/);
  assert.throws(() => f.service.lockedList(f.target.sessionId, f.root, f.startedAt)!.secrets, /Run predates task closure/);
});

test('the plaintext index holds names but no value or password, and a foreign index is ignored', async t => {
  const f = await fixture(t); await scenario(f); await f.service.lock();
  const text = await readFile(join(f.stateDir, 'secrets', 'index.json'), 'utf8');
  assert.match(text, /GLOBAL_AUTO/); assert.doesNotMatch(text, new RegExp(`${CANARY}|${PASSWORD}`));
  const index = JSON.parse(text); index.vaultId = randomUUID();
  await writeFile(join(f.stateDir, 'secrets', 'index.json'), JSON.stringify(index));
  assert.equal((await f.restart()).lockedList(f.target.sessionId, f.root, f.startedAt), undefined);
  // An index of a build before per-secret sharing hides names until the next unlock writes a current one.
  const older = JSON.parse(text); delete older.state.format; delete older.state.policy.servedHosts;
  await writeFile(join(f.stateDir, 'secrets', 'index.json'), JSON.stringify(older));
  const upgraded = await f.restart(); assert.equal(upgraded.lockedList(f.target.sessionId, f.root, f.startedAt), undefined);
  await upgraded.unlock(PASSWORD); await upgraded.lock(); assert.ok(upgraded.lockedList(f.target.sessionId, f.root, f.startedAt));
});

test('broker approvals that 1.129–1.132 kept in the journal and the index are read past, and go at the next save', async t => {
  const f = await fixture(t);
  await f.service.create({ name: 'SHARED_GLOBAL', kind: 'scalar', value: CANARY, sharing: { global: true, folders: [] } });
  const approval = { id: randomUUID(), hostId: f.host, sessionId: f.target.sessionId, root: f.root, taskId: f.target.taskId, taskLabel: 'Deploy', createdAt: f.now(), expiresAt: f.now() + 3_600_000 };
  const key = f.service.vault.exportKey()!;
  try {
    const payload = f.service.vault.unlockWithKey(key);
    await f.service.vault.save(payload, { ...await f.service.vault.journal() as object, brokerApprovals: [approval] }, { ...f.service.vault.index as object, brokerApprovals: [approval] });
  } finally { key.fill(0); }
  await f.service.lock();
  const index = join(f.stateDir, 'secrets', 'index.json');
  assert.match(await readFile(index, 'utf8'), /brokerApprovals/);
  const restarted = await f.restart();
  assert.deepEqual(names(restarted.lockedList(f.target.sessionId, f.root, f.startedAt, f.target)!.secrets), ['SHARED_GLOBAL'], 'an older index still lists names while locked');
  await restarted.unlock(PASSWORD);
  assert.doesNotMatch(await readFile(index, 'utf8'), /brokerApprovals/, 'unlocking rewrites the index without them');
  assert.deepEqual(names(await restarted.list(f.context)), ['SHARED_GLOBAL']);
  await restarted.flush();
  assert.equal('brokerApprovals' in (await restarted.vault.journal() as object), false);
});

test('a failed index write never leaves an older index listing names, in memory or after restart', async t => {
  const f = await fixture(t); await scenario(f);
  const path = join(f.stateDir, 'secrets', 'index.json'); const previous = await readFile(path, 'utf8');
  await rm(path); await mkdir(join(path, 'blocked'), { recursive: true });
  await f.service.disconnectSession(f.target, (await f.service.list(f.context)).map(secret => secret.id));
  assert.deepEqual(await f.service.list(f.context), []);
  await f.service.lock();
  assert.equal(f.service.lockedList(f.target.sessionId, f.root, f.startedAt, f.target), undefined);
  await rm(path, { recursive: true }); await writeFile(path, previous);
  assert.equal((await f.restart()).lockedList(f.target.sessionId, f.root, f.startedAt, f.target), undefined, 'an index from an earlier save is not trusted');
});

test('locked tools list names and turn any use into an unlock request; ineligible runs are still refused', async t => {
  const f = await fixture(t); await scenario(f);
  const runs = new FixtureRuns(); const runtime = new SecretRuntime({ stateDir: f.stateDir, service: f.service, runs }); t.after(() => runtime.close());
  const capability = runs.add(f.root);
  const unlocked = await runtime.tool(capability, 'secrets_list', {}) as { secrets: SecretMetadata[]; locked?: boolean };
  assert.equal(unlocked.locked, undefined);
  await f.service.lock();

  const locked = await runtime.tool(capability, 'secrets_list', {}) as { secrets: SecretMetadata[]; locked: boolean; notice: string };
  assert.equal(locked.locked, true); assert.match(locked.notice, /locked/);
  assert.deepEqual(wire(locked.secrets), wire(unlocked.secrets));
  assert.deepEqual(await runtime.tool(capability, 'secrets_cli', { argv: ['list'] }), locked);

  const reference = locked.secrets.find(item => item.name === 'GLOBAL_AUTO')!.reference;
  await assert.rejects(runtime.tool(capability, 'secrets_run', { operationId: 'locked-use', command: process.execPath, args: ['-e', ''], env: { KEY: reference } }),
    (error: Error) => statusOf(error) === 423 && error.message === SECRET_LOCKED_USE);
  await assert.rejects(runtime.tool(capability, 'secrets_cli', { argv: ['fingerprint', reference] }), (error: Error) => statusOf(error) === 423);
  await assert.rejects(runtime.tool(capability, 'secrets_cli', { operationId: 'locked-cli', argv: ['run', '--env', `KEY=${reference}`, '--', process.execPath, '-e', ''] }), (error: Error) => statusOf(error) === 423);

  // Archiving while locked records a closure that the unlock applies; the locked list honours it already.
  await runtime.endSession(capability.sessionId);
  await assert.rejects(runtime.tool(capability, 'secrets_list', {}), (error: Error) => statusOf(error) === 403);
  runs.running.find(run => run.id === capability.runId)!.status = 'completed';
  await assert.rejects(runtime.tool(capability, 'secrets_list', {}), (error: Error) => statusOf(error) === 403);
});

test('without an index the locked list says names are unknown, and a vault-less Tower never asks for an unlock', async t => {
  const f = await fixture(t);
  const runs = new FixtureRuns(); const runtime = new SecretRuntime({ stateDir: f.stateDir, service: f.service, runs }); t.after(() => runtime.close());
  // An unbound run on a vault locked since start, as right after an upgrade from a build without the index.
  await rm(join(f.stateDir, 'secrets', 'index.json'));
  const upgraded = await f.restart(); const upgradedRuntime = new SecretRuntime({ stateDir: f.stateDir, service: upgraded, runs }); t.after(() => upgradedRuntime.close());
  const capability = runs.add(f.root);
  const unknown = await upgradedRuntime.tool(capability, 'secrets_list', {}) as { locked: boolean; notice: string; secrets: unknown[] };
  assert.deepEqual([unknown.locked, unknown.notice, unknown.secrets], [true, SECRET_LOCKED_UNINDEXED, []]);
  // The first unlock writes the index, so the next lock lists names for the same unbound run.
  await upgraded.unlock(PASSWORD); await upgraded.lock();
  assert.ok(upgraded.lockedList(f.target.sessionId, f.root, f.startedAt), 'unlocking alone writes the index');
  await upgraded.unlock(PASSWORD); await upgraded.create({ name: 'AFTER_UPGRADE', kind: 'scalar', value: CANARY, sharing: { global: true, folders: [] } }); await upgraded.lock();
  const listed = await upgradedRuntime.tool(capability, 'secrets_list', {}) as { secrets: SecretMetadata[] };
  assert.deepEqual(names(listed.secrets), ['AFTER_UPGRADE']);

  const emptyState = join(f.stateDir, '..', 'empty-state'); await mkdir(emptyState);
  const empty = await secretService(emptyState);
  const emptyRuntime = new SecretRuntime({ stateDir: emptyState, service: empty, runs }); t.after(() => emptyRuntime.close());
  assert.deepEqual((await emptyRuntime.tool(capability, 'secrets_list', {}) as { secrets: unknown[] }).secrets, []);
  await assert.rejects(emptyRuntime.tool(capability, 'secrets_run', { operationId: 'no-vault', command: process.execPath, env: { KEY: 'NAME' } }), (error: Error) => statusOf(error) === 404 && error.message === SECRET_NO_VAULT);
});

test('a lock that lands during an unlocked call still answers as the locked path', async t => {
  const f = await fixture(t); await scenario(f);
  const runs = new FixtureRuns(); const runtime = new SecretRuntime({ stateDir: f.stateDir, service: f.service, runs }); t.after(() => runtime.close());
  const capability = runs.add(f.root);
  const bindRun = f.service.bindRun.bind(f.service);
  f.service.bindRun = async (...args) => { await f.service.lock(); return bindRun(...args); };
  const listed = await runtime.tool(capability, 'secrets_list', {}) as { locked: boolean; secrets: SecretMetadata[] };
  assert.equal(listed.locked, true); assert.ok(names(listed.secrets).includes('GLOBAL_AUTO'));
  await f.service.unlock(PASSWORD);
  await assert.rejects(runtime.tool(capability, 'secrets_fingerprint', { reference: listed.secrets[0].reference }), (error: Error) => statusOf(error) === 423 && error.message === SECRET_LOCKED_USE);
});
