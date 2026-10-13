import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretService } from '../../../server/secrets/service.js';
import { editPayload, legacyRecord, legacyRule, secretService, stored, storedSecret, storedTask } from '../../helpers/secrets.js';
import { parseDotenv } from '../../../server/secrets/dotenv.js';
import { SecretVault } from '../../../server/secrets/vault.js';
import { collectEncryptedVault, listPendingSecretImports, stageVaultImport } from '../../../server/backup/secrets.js';
import { blockRename } from '../../helpers/private-writes.js';
const password = 'fixture-password-1234';
test('dotenv preserves literals, empty values and multiline; duplicate assignments fail', () => {
  assert.deepEqual({ ...parseDotenv('\uFEFFA=\r\nB="one\\ntwo"\r\nC=\'${literal}\'\nD="multi\nline"\n') }, { A: '', B: 'one\ntwo', C: '${literal}', D: 'multi\nline' });
  assert.throws(() => parseDotenv('A=1\nA=2')); assert.throws(() => parseDotenv('A="unclosed'));
});
test('encrypted vault: policy, selected fields, fixed expiry, revoke, restart lock and password change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-vault-domain-')); let now = 1000;
  try {
    const service = await secretService(directory, { password, now: () => now });
    const hostId = service.device().id; const project = { id: randomUUID(), name: 'fixture', bindings: [{ hostId, root: '/fixture' }] };
    const record = legacyRecord(hostId, { name: 'bundle', groupId: 'project-group', kind: 'env', value: 'A=CANARY_DOMAIN_VALUE\nB=hidden' }); const metadata = record.metadata;
    await editPayload(service, payload => {
      payload.projects.push(project); payload.groups.push({ id: 'project-group', name: 'Project', scope: 'project', projectId: project.id }); payload.secrets.push(record);
      payload.rules.push(legacyRule({ groupId: metadata.groupId, secretIds: [metadata.id], hostId, projectId: project.id, activation: 'auto', operations: ['discover', 'env'], fields: { [metadata.id]: ['A'] }, maxTtlMs: 100 }));
    });
    const target = await service.ensureTask('session', '/fixture'); const context = { ...target, runId: 'run' };
    assert.equal((await service.list(context)).length, 1); assert.equal((await service.resolve(context, metadata.reference + '#A', 'env')).bytes.toString(), 'CANARY_DOMAIN_VALUE');
    assert.deepEqual((await service.resolve(context, metadata.reference, 'env')).fields, { A: 'CANARY_DOMAIN_VALUE' });
    await assert.rejects(service.resolve(context, metadata.reference, 'file')); await assert.rejects(service.resolve(context, metadata.reference + '#B', 'env')); await assert.rejects(service.resolve({ ...context, root: '/forged' }, metadata.reference + '#A', 'env'));
    now = 1101; await assert.rejects(service.resolve(context, metadata.reference + '#A', 'env'));
    await service.closeTask(target.taskId); const fresh = { ...await service.ensureTask('session', '/fixture'), runId: 'newrun' }; assert.equal((await service.list(fresh)).length, 1);
    await service.disconnectSession(fresh, [metadata.id]); assert.deepEqual(await service.list(fresh), []); await assert.rejects(service.resolve(fresh, metadata.reference + '#A', 'env'));
    assert.equal((await readFile(join(directory, 'secrets/vault.json'), 'utf8')).includes('CANARY_DOMAIN_VALUE'), false);
    assert.equal((await readFile(join(directory, 'secrets/journal.json'), 'utf8')).includes('session'), false);
    await service.changePassword(password, 'changed-password-1234'); await service.lock(); await assert.rejects(service.unlock(password)); await service.unlock('changed-password-1234');
    const restarted = await secretService(directory); assert.equal(restarted.status().locked, true); await restarted.unlock('changed-password-1234'); assert.equal(restarted.settings().secrets.length, 1);
    const path = join(directory, 'secrets/vault.json'); const envelope = JSON.parse(await readFile(path, 'utf8')); envelope.kdf.memory = 99999999; await writeFile(path, JSON.stringify(envelope)); await assert.rejects(new SecretService({ stateDir: directory }).start());
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('discover-only and operation ledger do not disclose values or rerun operations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-vault-ledger-'));
  try {
    const service = await secretService(directory, { password });
    const target = await service.ensureTask('session', '/fixture'); const context = { ...target, runId: 'run' };
    const record = legacyRecord(service.device().id, { name: 'key', groupId: 'global-group', value: 'canary' }); const secret = record.metadata;
    await editPayload(service, payload => { payload.groups.push({ id: 'global-group', name: 'Global', scope: 'global' }); payload.secrets.push(record); payload.rules.push(legacyRule({ groupId: 'global-group', secretIds: [secret.id], hostId: target.hostId, root: target.root, operations: ['discover'] })); });
    assert.equal((await service.list(context)).length, 1); await assert.rejects(service.resolve(context, secret.reference, 'env'));
    const fingerprint = 'a'.repeat(64); assert.equal((await service.beginOperation(context, 'op', fingerprint)).fresh, true); assert.equal((await service.beginOperation(context, 'op', fingerprint)).fresh, false);
    await assert.rejects(service.beginOperation({ ...context, runId: 'other' }, 'op', fingerprint)); await service.finishOperation(context, 'op', fingerprint, { stdout: '[REDACTED]' }); assert.equal((await service.beginOperation(context, 'op', fingerprint)).state, 'done');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('binary file bytes survive encrypted storage and encrypted import preserves target identity', async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), 'tower-vault-source-')); const targetDir = await mkdtemp(join(tmpdir(), 'tower-vault-target-'));
  try {
    const source = await secretService(sourceDir, { password });
    const target = await source.ensureTask('session', '/fixture'); const context = { ...target, runId: 'run' }; const bytes = Buffer.from([0, 255, 13, 10, 128]);
    const metadata = await source.create({ name: 'binary', kind: 'file', content: bytes.toString('base64'), sharing: { global: true, folders: [] }, connect: 'session' }, target);
    assert.deepEqual((await source.resolve(context, metadata.reference, 'file')).bytes, bytes);
    const recipient = await secretService(targetDir, { password: 'recipient-password-1234' }); const identity = recipient.device();
    await recipient.importEncryptedVault((await source.exportEncryptedVault())!, password); assert.deepEqual(recipient.device(), identity); assert.equal(recipient.settings().secrets.length, 1); assert.equal(stored(recipient).rules.length, 0); assert.equal(recipient.settings().secrets[0].reference.startsWith(`tower-secret://${identity.id}/`), true);
    assert.deepEqual(recipient.settings().secrets[0].sharing, { revision: 1, global: false, folders: [] }, 'sharing never travels with an import');
    await recipient.importEncryptedVault((await source.exportEncryptedVault())!, password); assert.equal(recipient.settings().secrets.length, 1);
  } finally { await rm(sourceDir, { recursive: true, force: true }); await rm(targetDir, { recursive: true, force: true }); }
});
test('authenticated ciphertext tampering and symlink vault input fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-vault-tamper-'));
  try {
    const service = await secretService(directory, { password }); await service.lock();
    const path = join(directory, 'secrets/vault.json'); const envelope = JSON.parse(await readFile(path, 'utf8')); const bytes = Buffer.from(envelope.payload.ciphertext, 'base64'); bytes[0] ^= 1; envelope.payload.ciphertext = bytes.toString('base64'); await writeFile(path, JSON.stringify(envelope));
    const restarted = await secretService(directory); await assert.rejects(restarted.unlock(password)); assert.equal(restarted.status().locked, true);
    const { symlink } = await import('node:fs/promises'); await rm(path); await symlink(join(directory, 'external'), path); await writeFile(join(directory, 'external'), '{}'); await assert.rejects(new SecretService({ stateDir: directory }).start());
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('separate discover and manual use rules, task-only backup exclusion, journal-first failure recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-vault-commit-'));
  try {
    const service = await secretService(directory, { password });
    const target = await service.ensureTask('session', '/fixture'); const context = { ...target, runId: 'run' };
    const record = legacyRecord(service.device().id, { name: 'split', groupId: 'global-group', value: 'value' }); const secret = record.metadata;
    const remoteId = '11111111-1111-4111-8111-111111111111'; const remoteProject = { id: randomUUID(), name: 'remote', bindings: [{ hostId: remoteId, root: '/remote' }] };
    await editPayload(service, payload => {
      payload.projects.push(remoteProject); payload.groups.push({ id: 'global-group', name: 'Global', scope: 'global' }); payload.secrets.push(record);
      payload.rules.push(legacyRule({ groupId: secret.groupId, secretIds: [secret.id], hostId: target.hostId, root: target.root, activation: 'auto', operations: ['discover'] }), legacyRule({ groupId: secret.groupId, secretIds: [secret.id], hostId: target.hostId, root: target.root, operations: ['env'] }));
    });
    assert.equal((await service.list(context)).length, 1); assert.equal((await service.resolve(context, secret.reference, 'env')).bytes.toString(), 'value', 'a manual rule applies without an owner connection');
    const ephemeral = await service.create({ name: 'ephemeral', kind: 'scalar', value: 'transient', temporary: true }, target);
    const backup = await service.vault.decryptImport((await service.exportEncryptedVault())!, password) as { groups: { id: string }[]; rules: { secretIds: string[] }[]; secrets: { metadata: { id: string } }[] };
    assert.equal(backup.secrets.some(item => item.metadata.id === ephemeral.id), false); assert.equal(backup.rules.some(rule => rule.secretIds.includes(ephemeral.id)), false);
    assert.equal(JSON.stringify(backup).includes('transient'), false);
    await service.trustPeer({ device: { ...service.device(), id: remoteId }, routeId: 'fixture', direction: 'node', enabled: true });
    await service.create({ name: 'remote folder key', kind: 'scalar', value: 'remote', sharing: { global: false, folders: [{ hostId: remoteId, root: '/remote' }] } });
    const remote = await service.ensureRemoteTask({ hostId: remoteId, root: '/remote', sessionId: 'remote-session', taskId: '22222222-2222-4222-8222-222222222222', runId: 'remote-run', projectId: 'untrusted-peer-project' });
    assert.equal(remote.projectId, remoteProject.id); await service.closeTask(remote.taskId); await assert.rejects(service.ensureRemoteTask(remote));
    const originalWrite = service.vault.write.bind(service.vault); service.vault.write = async (name, bytes) => { if (name === 'vault.json') throw new Error('fixture atomic failure'); await originalWrite(name, bytes); };
    await assert.rejects(service.disconnectSession(target, [secret.id])); assert.equal(service.status().locked, true);
    const restarted = await secretService(directory); await restarted.unlock(password); await assert.rejects(restarted.resolve(context, secret.reference, 'env'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('dotenv closes double quotes after even backslashes and preserves odd escaped quotes', () => {
  const even = 'EVEN="tail' + '\\'.repeat(2) + '"\n';
  const four = 'FOUR="tail' + '\\'.repeat(4) + '"\n';
  const odd = 'ODD="say ' + '\\' + '"hello' + '\\' + '""\n';
  const triple = 'TRIPLE="tail' + '\\'.repeat(3) + '"continued"\n';
  assert.deepEqual({ ...parseDotenv(even + four + odd + triple) }, { EVEN: 'tail\\', FOUR: 'tail\\\\', ODD: 'say "hello"', TRIPLE: 'tail\\"continued' });
  assert.throws(() => parseDotenv('UNCLOSED="tail' + '\\' + '"'), /Unclosed/);
});
test('sweep discards expired remote task payload and claims while keeping active local claims and fixed task identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-vault-sweep-')); let now = 1000;
  try {
    const service = await secretService(directory, { password, now: () => now });
    const local = await service.bindRun('owner-session', '/local', new Date(now).toISOString()); const active = { ...local, runId: 'live-local-run' }; const dead = { ...local, runId: 'ended-local-run' }; const fingerprint = 'b'.repeat(64);
    await service.beginOperation(active, 'local-active', fingerprint); await service.finishOperation(active, 'local-active', fingerprint, { stdout: '[REDACTED]' });
    await service.beginOperation(active, 'remote-id:local-owner-operation', fingerprint); await service.beginOperation(dead, 'local-ended', fingerprint);
    const remoteHost = '11111111-1111-4111-8111-111111111111'; await service.trustPeer({ device: { ...service.device(), id: remoteHost }, routeId: 'fixture', direction: 'node', enabled: true });
    await editPayload(service, payload => { payload.projects.push({ id: randomUUID(), name: 'remote', bindings: [{ hostId: remoteHost, root: '/remote' }] }); });
    const remote = await service.ensureRemoteTask({ hostId: remoteHost, sessionId: 'remote-session', taskId: '22222222-2222-4222-8222-222222222222', root: '/remote', projectId: 'untrusted-project', runId: 'remote-run' }, { owner: true });
    const ephemeral = await service.create({ name: 'remote temporary', kind: 'scalar', value: 'SWEEP_EPHEMERAL_CANARY', temporary: true }, remote);
    assert.equal((await service.resolve(remote, ephemeral.reference, 'env')).bytes.toString(), 'SWEEP_EPHEMERAL_CANARY'); await service.beginOperation(remote, `remote-id:${remoteHost}:request`, fingerprint); await service.beginOperation(remote, `remote-nonce:${remoteHost}:nonce`, fingerprint);
    now += 8 * 60 * 60_000 + 1; await service.sweep(new Set(['live-local-run', 'remote-run']));
    const closed = storedTask(service, remote.taskId); assert.equal(closed?.status, 'closed'); assert.equal(closed?.closedAt, 1000 + 8 * 60 * 60_000); assert.equal(storedSecret(service, ephemeral.id), false); assert.deepEqual(closed?.connected, []);
    await assert.rejects(service.resolve(remote, ephemeral.reference, 'env')); await assert.rejects(service.ensureRemoteTask(remote));
    const journal = await service.vault.journal() as { operations: Record<string, { state: string }>; secrets: unknown[]; grants?: unknown }; assert.deepEqual(Object.keys(journal.operations), ['local-active', 'remote-id:local-owner-operation']); assert.deepEqual(journal.secrets, []); assert.equal(journal.grants, undefined);
    assert.deepEqual(await service.beginOperation(active, 'local-active', fingerprint), { state: 'done', fresh: false, result: { stdout: '[REDACTED]' } });
    const originalStartedAt = new Date(1000).toISOString(); await service.closeTask(local.taskId); now++; const replacement = await service.ensureTask('owner-session', '/local'); assert.notEqual(replacement.taskId, local.taskId); await assert.rejects(service.bindRun('owner-session', '/local', originalStartedAt), /predates/); await assert.rejects(service.list(active));
    assert.equal((await readFile(join(directory, 'secrets/journal.json'), 'utf8')).includes('SWEEP_EPHEMERAL_CANARY'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('dotenv field selections of rules deny duplicates and stale selections after value rotation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-vault-field-policy-'));
  try {
    const service = await secretService(directory, { password });
    const target = await service.ensureTask('session', '/fixture'); const context = { ...target, runId: 'run' };
    const record = legacyRecord(service.device().id, { name: 'selected bundle', groupId: 'global-group', kind: 'env', value: 'A=approved-a\nB=approved-b\nC=UNAPPROVED_C_CANARY' }); const secret = record.metadata;
    // Rules change only as an older build writes them; the policy reads each selection as it stands.
    const rule = legacyRule({ groupId: secret.groupId, secretIds: [secret.id], hostId: target.hostId, root: target.root, operations: ['discover', 'env', 'file', 'pipe'], fields: { [secret.id]: ['A', 'B'] } });
    await editPayload(service, payload => { payload.groups.push({ id: 'global-group', name: 'Global', scope: 'global' }); payload.secrets.push(record); payload.rules.push(rule); });
    const select = (fields?: string[]) => editPayload(service, payload => { const saved = payload.rules.find(item => item.id === rule.id)!; if (fields) saved.fields = { [secret.id]: fields }; else delete saved.fields; });
    const partial = await service.resolve(context, secret.reference, 'env'); assert.equal(partial.bytes.length, 0); assert.deepEqual(partial.fields, { A: 'approved-a', B: 'approved-b' }); await assert.rejects(service.resolve(context, secret.reference, 'file'), /Whole dotenv/);
    // A rotated value keeps the selection without an owner reapproval; fields outside it stay closed.
    const replacedHidden = await service.update({ id: secret.id, value: 'A=approved-a\nB=approved-b\nD=NEW_UNAPPROVED_D_CANARY' }); const stillPartial = await service.resolve(context, replacedHidden.reference, 'env'); assert.equal(stillPartial.bytes.length, 0); assert.deepEqual(stillPartial.fields, { A: 'approved-a', B: 'approved-b' }); await assert.rejects(service.resolve(context, replacedHidden.reference, 'file'), /Whole dotenv/); await assert.rejects(service.resolve(context, replacedHidden.reference + '#D', 'env'));
    const swapped = await service.update({ id: secret.id, value: 'A=updated-a\nC=NEW_UNAPPROVED_C_CANARY' });
    assert.deepEqual(await service.list(context), []); await assert.rejects(service.resolve(context, swapped.reference, 'env')); await assert.rejects(service.resolve(context, swapped.reference, 'file')); await assert.rejects(service.resolve(context, swapped.reference + '#C', 'env'));
    await select(['A']); const renewed = await service.resolve(context, swapped.reference, 'env'); assert.equal(renewed.bytes.length, 0); assert.deepEqual(renewed.fields, { A: 'updated-a' }); assert.equal(JSON.stringify(renewed.fields).includes('NEW_UNAPPROVED_C_CANARY'), false); await assert.rejects(service.resolve(context, swapped.reference, 'file'), /Whole dotenv/);
    const added = await service.update({ id: secret.id, value: 'A=latest-a\nC=NEW_UNAPPROVED_C_CANARY\nD=NEW_UNAPPROVED_D_CANARY' }); const expanded = await service.resolve(context, added.reference, 'env'); assert.equal(expanded.bytes.length, 0); assert.deepEqual(expanded.fields, { A: 'latest-a' }); assert.deepEqual((await service.list(context))[0].fields, ['A']); await assert.rejects(service.resolve(context, added.reference, 'file'), /Whole dotenv/); await assert.rejects(service.resolve(context, added.reference + '#D', 'env'));
    await select(['D', 'C', 'A']); const whole = await service.resolve(context, added.reference, 'file'); assert.equal(whole.bytes.toString(), 'A=latest-a\nC=NEW_UNAPPROVED_C_CANARY\nD=NEW_UNAPPROVED_D_CANARY');
    await select(); const wildcard = await service.update({ id: secret.id, value: 'A=latest-a\nE=OWNER_WILDCARD_FIELD' }); assert.deepEqual((await service.resolve(context, wildcard.reference, 'env')).fields, { A: 'latest-a', E: 'OWNER_WILDCARD_FIELD' });
    await assert.rejects(service.resolve(context, secret.reference, 'env'), /reference/);
    const saved = await service.vault.decryptImport((await service.exportEncryptedVault())!, password) as { rules: { id: string; fields?: Record<string, string[]> }[] }; saved.rules.find(item => item.id === rule.id)!.fields = { [secret.id]: ['A', 'A'] }; await service.vault.save(saved, await service.vault.journal(), service.vault.index); await service.lock(); await service.unlock(password);
    assert.deepEqual(await service.list(context), []); await assert.rejects(service.resolve(context, wildcard.reference, 'env'), /access denied/); await assert.rejects(service.resolve(context, wildcard.reference, 'file'), /access denied/); await assert.rejects(service.resolve(context, wildcard.reference + '#A', 'env'), /access denied/);

  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('vault files are 0600 in a 0700 directory and no temp file remains', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-vault-files-'));
  try {
    const vault = new SecretVault(directory);
    await vault.initialize(password, { secrets: [] });
    await vault.save({ secrets: ['saved'] }, { operations: [] }, { names: [] });
    const secrets = join(directory, 'secrets');
    assert.equal((await stat(secrets)).mode & 0o777, 0o700);
    assert.deepEqual((await readdir(secrets)).sort(), ['index.json', 'journal.json', 'vault.json']);
    for (const name of ['index.json', 'journal.json', 'vault.json']) assert.equal((await stat(join(secrets, name))).mode & 0o777, 0o600, name);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('a failed vault write keeps the previous vault.json and leaves no temp', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-vault-failed-write-'));
  try {
    const vault = new SecretVault(directory);
    await vault.initialize(password, { secrets: [] });
    const secrets = join(directory, 'secrets'); const path = join(secrets, 'vault.json');
    const before = await readFile(path);
    const restore = await blockRename(path);
    const error = await vault.changePassword(password, 'another-fixture-password').then(() => undefined, (caught: unknown) => caught as NodeJS.ErrnoException);
    assert.ok(error?.code, 'the filesystem error itself');
    assert.deepEqual((await readdir(secrets)).sort(), ['vault.json', 'vault.json.aside']);
    await restore();
    assert.deepEqual(await readFile(path), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('a pending secret import is listed only by its own name', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-vault-pending-list-'));
  try {
    const vault = new SecretVault(directory);
    await vault.initialize(password, { secrets: [] });
    const id = await stageVaultImport(directory, (await collectEncryptedVault(directory))!);
    const secrets = join(directory, 'secrets');
    await writeFile(join(secrets, `vault.json.${process.pid}.0123456789ab.tmp`), '');
    await writeFile(join(secrets, `.vault.json.${randomUUID()}`), '');
    await writeFile(join(secrets, `pending-import-${randomUUID()}.json.${process.pid}.0123456789ab.tmp`), '');
    assert.deepEqual(await listPendingSecretImports(directory), [id]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
