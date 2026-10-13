import test, { after, before, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretRuntime } from '../../../server/secrets/runtime.js';
import type { SecretService } from '../../../server/secrets/service.js';
import type { SecretSettingsView, SecretValue } from '../../../shared/secrets.js';
import { FixtureRuns, secretService, vaultTemplate } from '../../helpers/secrets.js';

/** The worker's value-viewing actions on fixture vaults: the web verified each Tower password before asking. */
const RECOVERY = 'fixture-value-view-recovery';
const TOWER = 'fixture-tower-password-1234';
const OTHER = 'fixture-other-tower-password';
const [idA, idB] = ['a', 'b'].map(digit => digit.repeat(64));
const vaults = vaultTemplate(RECOVERY);
before(() => vaults.ready());
after(() => vaults.dispose());
type Refusal = Error & { kind?: string; code?: string };
const refusal = (kind: string, code?: string) => (error: Refusal) => error.kind === kind && error.code === code && ![RECOVERY, TOWER, OTHER].some(password => error.message.includes(password));

async function fixture(t: TestContext, open = true) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tower-value-view-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const service: SecretService = open ? await vaults.open(directory) : await secretService(directory);
  let migrations = 0;
  const runtime = new SecretRuntime({ stateDir: directory, service, runs: new FixtureRuns(), migrate: async () => { migrations++; } }); t.after(() => runtime.close());
  const control = (action: string, input: Record<string, unknown> = {}) => runtime.control(action, input);
  const wrappers = async () => (JSON.parse(await readFile(join(directory, 'secrets', 'vault.json'), 'utf8')) as { tower?: { wrappers: { credentialId: string; salt: string }[] } }).tower?.wrappers ?? [];
  /** Locks and opens again with the open key, as a worker handoff does: no password derivation. */
  const reopen = async () => { const carry = service.handoff()!; await service.lock(); await service.adopt(carry); };
  return { directory, service, runtime, control, wrappers, reopen, migrations: () => migrations };
}

test('view-unlock: an open vault gets, checks or remakes the current wrapper; a locked one opens with it or once with the recovery password', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  // Open without a wrapper (a vault made before this release): the first use wraps the key for these credentials.
  const first = await f.control('view-unlock', { password: TOWER, credentialId: idA }) as { generation: string };
  assert.equal(first.generation, f.service.lockGeneration);
  assert.deepEqual(await f.control('tower-status', { credentialId: idA }), { towerPassword: 'ready' });
  assert.deepEqual(await f.control('tower-status', { credentialId: idB }), { towerPassword: 'missing' });
  const [made] = await f.wrappers();
  // Open with the current wrapper: only checked, and a candidate of another credential is pruned.
  assert.deepEqual(await f.control('tower-wrap', { password: OTHER, credentialId: idB }), { wrapped: true });
  assert.deepEqual(await f.control('view-unlock', { password: TOWER, credentialId: idA }), { generation: first.generation }, 'an open vault keeps its generation');
  assert.deepEqual(await f.wrappers(), [made]);
  // Open with a wrapper the verified password does not unwrap: it is made again for that password.
  await f.service.towerWrap(OTHER, idA);
  await f.control('view-unlock', { password: TOWER, credentialId: idA });
  const [remade] = await f.wrappers(); assert.equal(remade.credentialId, idA); assert.notEqual(remade.salt, made.salt);
  assert.equal(await f.service.towerUnlock(TOWER, idA), false, 'the remade wrapper unwraps the open key');

  // Locked with the current wrapper: opened through the runtime's open (migration and closures), in a new generation.
  await f.control('lock'); assert.equal(f.migrations(), 0);
  const opened = await f.control('view-unlock', { password: TOWER, credentialId: idA }) as { generation: string };
  assert.equal(f.service.status().locked, false); assert.equal(f.migrations(), 1);
  assert.notEqual(opened.generation, first.generation); assert.equal(opened.generation, f.service.lockGeneration);
  // Locked with a wrapper that does not open, or none: the recovery password is needed once.
  await f.control('lock');
  await assert.rejects(f.control('view-unlock', { password: OTHER, credentialId: idA }), refusal('conflict', 'needs-recovery'));
  await assert.rejects(f.control('view-unlock', { password: TOWER, credentialId: idB }), refusal('conflict', 'needs-recovery'));
  await assert.rejects(f.control('view-unlock', { password: TOWER, credentialId: idB, recoveryPassword: 'not-the-recovery-password' }), (error: Refusal) => refusal('invalid')(error) && /복구 비밀번호/.test(error.message));
  assert.equal(f.service.status().locked, true); assert.equal(f.migrations(), 1);
  const recovered = await f.control('view-unlock', { password: TOWER, credentialId: idB, recoveryPassword: RECOVERY }) as { generation: string };
  assert.equal(f.service.status().locked, false); assert.equal(f.migrations(), 2); assert.equal(recovered.generation, f.service.lockGeneration);
  assert.deepEqual((await f.wrappers()).map(item => item.credentialId), [idB], 'the recovery opens, wraps for these credentials and keeps only that wrapper');
  await f.control('lock');
  await f.control('view-unlock', { password: TOWER, credentialId: idB }); assert.equal(f.migrations(), 3, 'the next unlock needs no recovery');
});

test('two wrappers of other credentials (a backup taken mid-change, a reset login) leave room for the current one', { timeout: 120_000 }, async t => {
  const f = await fixture(t); const idC = 'c'.repeat(64);
  const others = async () => { await f.service.towerPrune(idA); await f.service.towerWrap(OTHER, idA); await f.service.towerWrap(OTHER, idB); };
  await others();
  await f.control('view-unlock', { password: TOWER, credentialId: idC });
  assert.deepEqual((await f.wrappers()).map(item => item.credentialId), [idC], 'open: the others go before the current one is made');
  await others(); await f.control('lock');
  await f.control('view-unlock', { password: TOWER, credentialId: idC, recoveryPassword: RECOVERY });
  assert.deepEqual((await f.wrappers()).map(item => item.credentialId), [idC], 'locked: the recovery password opens it and the same room is made');
});

test('value and value-update answer only in the unlocked generation, at the shown version, in one serial change', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const scalar = await f.service.create({ name: 'scalar', kind: 'scalar', value: 'SCALAR_VALUE' });
  const file = await f.service.create({ name: 'file', kind: 'file', content: Buffer.from('FILE_BYTES').toString('base64') });
  const env = await f.service.create({ name: 'env', kind: 'env', value: 'A=1\n' });
  const target = await f.service.ensureTask('codex:value-session', f.directory);
  const temporary = await f.service.create({ name: 'temporary', kind: 'scalar', value: 'TEMPORARY_VALUE', temporary: true, connect: 'session' }, target);
  const generation = f.service.lockGeneration;
  const read = (secretId: string, expectedVersion = 1, current = generation) => f.control('value', { secretId, expectedVersion, generation: current });
  assert.deepEqual(await read(scalar.id), { id: scalar.id, version: 1, kind: 'scalar', value: 'SCALAR_VALUE' } satisfies SecretValue);
  assert.deepEqual(await read(file.id), { id: file.id, version: 1, kind: 'file', content: Buffer.from('FILE_BYTES').toString('base64') });
  assert.deepEqual(await read(env.id), { id: env.id, version: 1, kind: 'env', value: 'A=1\n' });
  assert.deepEqual(await read(temporary.id), { id: temporary.id, version: 1, kind: 'scalar', value: 'TEMPORARY_VALUE' });
  await assert.rejects(read(scalar.id, 1, 'another-generation'), refusal('forbidden', 'view-locked'));
  await assert.rejects(read('missing-secret'), refusal('not-found'));
  await assert.rejects(read(scalar.id, 2), refusal('conflict', 'conflict'));
  await assert.rejects(f.control('value', { secretId: scalar.id, expectedVersion: 1 }), refusal('invalid'));

  // Two edits of the same shown version: the first wins, the second is refused and changes nothing.
  const edits = await Promise.allSettled([1, 2].map(n => f.control('value-update', { secretId: scalar.id, expectedVersion: 1, generation, value: `EDIT_${n}` })));
  assert.equal(edits[0].status, 'fulfilled'); assert.equal(edits[1].status, 'rejected');
  assert.ok(refusal('conflict', 'conflict')((edits[1] as PromiseRejectedResult).reason));
  assert.equal(((edits[0] as PromiseFulfilledResult<SecretSettingsView>).value).secrets.find(item => item.id === scalar.id)?.version, 2);
  assert.deepEqual(await read(scalar.id, 2), { id: scalar.id, version: 2, kind: 'scalar', value: 'EDIT_1' });
  await f.control('value-update', { secretId: file.id, expectedVersion: 1, generation, content: Buffer.from('NEW_FILE').toString('base64') });
  assert.deepEqual(await read(file.id, 2), { id: file.id, version: 2, kind: 'file', content: Buffer.from('NEW_FILE').toString('base64') });
  await assert.rejects(f.control('value-update', { secretId: scalar.id, expectedVersion: 2, generation: 'another-generation', value: 'NOPE' }), refusal('forbidden', 'view-locked'));

  // The removed action that changed values without value viewing or a version is gone.
  await assert.rejects(f.control('update', { id: scalar.id, value: 'NO_VERSION' }), refusal('not-found'));
  // A lock ends the generation, also once the vault is open again.
  await f.reopen();
  await assert.rejects(read(scalar.id, 2), refusal('forbidden', 'view-locked'));
  await assert.rejects(f.control('value-update', { secretId: scalar.id, expectedVersion: 2, generation, value: 'AFTER_LOCK' }), refusal('forbidden', 'view-locked'));
  await f.control('lock');
  await assert.rejects(read(scalar.id, 2, f.service.lockGeneration), refusal('forbidden', 'view-locked'));
});

test('tower-wrap answers false while locked or without a vault; tower-prune works locked; tower-status reads the envelope', { timeout: 60_000 }, async t => {
  const empty = await fixture(t, false);
  assert.deepEqual(await empty.control('tower-wrap', { password: TOWER, credentialId: idA }), { wrapped: false });
  assert.deepEqual(await empty.control('tower-prune', { credentialId: idA }), {});
  assert.deepEqual(await empty.control('tower-status', { credentialId: idA }), { towerPassword: 'missing' });
  await assert.rejects(empty.control('view-unlock', { password: TOWER, credentialId: idA }), refusal('not-found'));
  await assert.rejects(empty.control('tower-wrap', { password: TOWER, credentialId: 'not-a-credential' }), refusal('invalid'));

  const f = await fixture(t);
  assert.deepEqual(await f.control('tower-wrap', { password: TOWER, credentialId: idA }), { wrapped: true });
  await f.control('lock');
  assert.deepEqual(await f.control('tower-wrap', { password: TOWER, credentialId: idB }), { wrapped: false });
  assert.deepEqual(await f.control('tower-status', { credentialId: idA }), { towerPassword: 'ready' });
  assert.deepEqual(await f.control('tower-prune', { credentialId: idB }), {});
  assert.deepEqual(await f.wrappers(), []);
  assert.deepEqual(await f.control('tower-status', { credentialId: idA }), { towerPassword: 'missing' });
});
