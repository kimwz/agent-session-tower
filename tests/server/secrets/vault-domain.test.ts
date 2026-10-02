import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretService } from '../../../server/secrets/service.js';
import { parseDotenv } from '../../../server/secrets/dotenv.js';
const password = 'fixture-password-1234';
test('dotenv preserves literals, empty values and multiline; duplicate assignments fail', () => {
  assert.deepEqual({ ...parseDotenv('\uFEFFA=\r\nB="one\\ntwo"\r\nC=\'${literal}\'\nD="multi\nline"\n') }, { A: '', B: 'one\ntwo', C: '${literal}', D: 'multi\nline' });
  assert.throws(() => parseDotenv('A=1\nA=2')); assert.throws(() => parseDotenv('A="unclosed'));
});
test('encrypted vault: policy, selected fields, fixed expiry, revoke, restart lock and password change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-vault-domain-')); let now = 1000;
  try {
    const service = new SecretService({ stateDir: directory, now: () => now }); await service.start(); await service.initialize(password);
    const hostId = service.device().id; const project = await service.project({ name: 'fixture', bindings: [{ hostId, root: '/fixture' }] });
    const target = await service.ensureTask('session', '/fixture'); const context = { ...target, runId: 'run' };
    const metadata = await service.create({ name: 'bundle', kind: 'env', scope: 'project', projectId: project.id, value: 'A=CANARY_DOMAIN_VALUE\nB=hidden' });
    await service.setRule({ groupId: metadata.groupId, secretIds: [metadata.id], hostId, projectId: project.id, activation: 'auto', operations: ['discover', 'env'], fields: { [metadata.id]: ['A'] }, maxTtlMs: 100, enabled: true });
    assert.equal((await service.list(context)).length, 1); assert.equal((await service.resolve(context, metadata.reference + '#A', 'env')).bytes.toString(), 'CANARY_DOMAIN_VALUE');
    assert.deepEqual((await service.resolve(context, metadata.reference, 'env')).fields, { A: 'CANARY_DOMAIN_VALUE' });
    await assert.rejects(service.resolve(context, metadata.reference, 'file')); await assert.rejects(service.resolve(context, metadata.reference + '#B', 'env')); await assert.rejects(service.resolve({ ...context, root: '/forged' }, metadata.reference + '#A', 'env'));
    now = 1101; await assert.rejects(service.resolve(context, metadata.reference + '#A', 'env'));
    await service.closeTask(target.taskId); const fresh = { ...await service.ensureTask('session', '/fixture'), runId: 'newrun' }; assert.equal((await service.list(fresh)).length, 1);
    await service.revoke(fresh, [metadata.id]); assert.deepEqual(await service.list(fresh), []); await assert.rejects(service.resolve(fresh, metadata.reference + '#A', 'env'));
    assert.equal((await readFile(join(directory, 'secrets/vault.json'), 'utf8')).includes('CANARY_DOMAIN_VALUE'), false);
    assert.equal((await readFile(join(directory, 'secrets/journal.json'), 'utf8')).includes('session'), false);
    await service.changePassword(password, 'changed-password-1234'); await service.lock(); await assert.rejects(service.unlock(password)); await service.unlock('changed-password-1234');
    const restarted = new SecretService({ stateDir: directory }); await restarted.start(); assert.equal(restarted.status().locked, true); await restarted.unlock('changed-password-1234'); assert.equal(restarted.overview().secrets.length, 1);
    const path = join(directory, 'secrets/vault.json'); const envelope = JSON.parse(await readFile(path, 'utf8')); envelope.kdf.memory = 99999999; await writeFile(path, JSON.stringify(envelope)); await assert.rejects(new SecretService({ stateDir: directory }).start());
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('discover-only and operation ledger do not disclose values or rerun operations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-vault-ledger-'));
  try {
    const service = new SecretService({ stateDir: directory }); await service.start(); await service.initialize(password);
    const target = await service.ensureTask('session', '/fixture'); const context = { ...target, runId: 'run' };
    const secret = await service.create({ name: 'key', kind: 'scalar', scope: 'global', value: 'canary', target, connect: true, operations: ['discover'] });
    assert.equal((await service.list(context)).length, 1); await assert.rejects(service.resolve(context, secret.reference, 'env'));
    const fingerprint = 'a'.repeat(64); assert.equal((await service.beginOperation(context, 'op', fingerprint)).fresh, true); assert.equal((await service.beginOperation(context, 'op', fingerprint)).fresh, false);
    await assert.rejects(service.beginOperation({ ...context, runId: 'other' }, 'op', fingerprint)); await service.finishOperation(context, 'op', fingerprint, { stdout: '[REDACTED]' }); assert.equal((await service.beginOperation(context, 'op', fingerprint)).state, 'done');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('binary file bytes survive encrypted storage and encrypted import preserves target identity', async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), 'tower-vault-source-')); const targetDir = await mkdtemp(join(tmpdir(), 'tower-vault-target-'));
  try {
    const source = new SecretService({ stateDir: sourceDir }); await source.start(); await source.initialize(password);
    const target = await source.ensureTask('session', '/fixture'); const context = { ...target, runId: 'run' }; const bytes = Buffer.from([0, 255, 13, 10, 128]);
    const metadata = await source.create({ name: 'binary', kind: 'file', scope: 'global', content: bytes.toString('base64'), target, connect: true });
    assert.deepEqual((await source.resolve(context, metadata.reference, 'file')).bytes, bytes);
    const recipient = new SecretService({ stateDir: targetDir }); await recipient.start(); await recipient.initialize('recipient-password-1234'); const identity = recipient.device();
    await recipient.importEncryptedVault((await source.exportEncryptedVault())!, password); assert.deepEqual(recipient.device(), identity); assert.equal(recipient.overview().secrets.length, 1); assert.equal(recipient.overview().rules.length, 0); assert.equal(recipient.overview().secrets[0].reference.startsWith(`tower-secret://${identity.id}/`), true);
    await recipient.importEncryptedVault((await source.exportEncryptedVault())!, password); assert.equal(recipient.overview().secrets.length, 1);
  } finally { await rm(sourceDir, { recursive: true, force: true }); await rm(targetDir, { recursive: true, force: true }); }
});
test('authenticated ciphertext tampering and symlink vault input fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-vault-tamper-'));
  try {
    const service = new SecretService({ stateDir: directory }); await service.start(); await service.initialize(password); await service.lock();
    const path = join(directory, 'secrets/vault.json'); const envelope = JSON.parse(await readFile(path, 'utf8')); const bytes = Buffer.from(envelope.payload.ciphertext, 'base64'); bytes[0] ^= 1; envelope.payload.ciphertext = bytes.toString('base64'); await writeFile(path, JSON.stringify(envelope));
    const restarted = new SecretService({ stateDir: directory }); await restarted.start(); await assert.rejects(restarted.unlock(password)); assert.equal(restarted.status().locked, true);
    const { symlink } = await import('node:fs/promises'); await rm(path); await symlink(join(directory, 'external'), path); await writeFile(join(directory, 'external'), '{}'); await assert.rejects(new SecretService({ stateDir: directory }).start());
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('separate discover and manual use rules, task-only backup exclusion, journal-first failure recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-vault-commit-'));
  try {
    const service = new SecretService({ stateDir: directory }); await service.start(); await service.initialize(password);
    const target = await service.ensureTask('session', '/fixture'); const context = { ...target, runId: 'run' };
    const secret = await service.create({ name: 'split', kind: 'scalar', scope: 'global', value: 'value' });
    await service.setRule({ groupId: secret.groupId, secretIds: [secret.id], hostId: target.hostId, root: target.root, activation: 'auto', operations: ['discover'], enabled: true });
    await service.setRule({ groupId: secret.groupId, secretIds: [secret.id], hostId: target.hostId, root: target.root, activation: 'manual', operations: ['env'], enabled: true });
    assert.equal((await service.list(context)).length, 1); await assert.rejects(service.resolve(context, secret.reference, 'env')); await service.attach(target, [secret.id]); assert.equal((await service.resolve(context, secret.reference, 'env')).bytes.toString(), 'value');
    const ephemeral = await service.create({ name: 'ephemeral', kind: 'scalar', scope: 'task', target, connect: true, value: 'transient' });
    const backup = await service.vault.decryptImport((await service.exportEncryptedVault())!, password) as { groups: { id: string }[]; rules: { groupId: string }[]; secrets: { metadata: { id: string } }[] };
    assert.equal(backup.groups.some(group => group.id === ephemeral.groupId), false); assert.equal(backup.rules.some(rule => rule.groupId === ephemeral.groupId), false); assert.equal(backup.secrets.some(record => record.metadata.id === ephemeral.id), false);
    const remoteId = '11111111-1111-4111-8111-111111111111';
    await service.trustPeer({ device: { ...service.device(), id: remoteId }, routeId: 'fixture', direction: 'node', enabled: true });
    const remoteProject = await service.project({ name: 'remote', bindings: [{ hostId: remoteId, root: '/remote' }] });
    const remote = await service.ensureRemoteTask({ hostId: remoteId, root: '/remote', sessionId: 'remote-session', taskId: '22222222-2222-4222-8222-222222222222', runId: 'remote-run', projectId: 'untrusted-peer-project' });
    assert.equal(remote.projectId, remoteProject.id); await service.closeTask(remote.taskId); await assert.rejects(service.ensureRemoteTask(remote));
    const originalWrite = service.vault.write.bind(service.vault); service.vault.write = async (name, bytes) => { if (name === 'vault.json') throw new Error('fixture atomic failure'); await originalWrite(name, bytes); };
    await assert.rejects(service.revoke(target, [secret.id])); assert.equal(service.status().locked, true);
    const restarted = new SecretService({ stateDir: directory }); await restarted.start(); await restarted.unlock(password); await assert.rejects(restarted.resolve(context, secret.reference, 'env'));
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
    const service = new SecretService({ stateDir: directory, now: () => now }); await service.start(); await service.initialize(password);
    const local = await service.bindRun('owner-session', '/local', new Date(now).toISOString()); const active = { ...local, runId: 'live-local-run' }; const dead = { ...local, runId: 'ended-local-run' }; const fingerprint = 'b'.repeat(64);
    await service.beginOperation(active, 'local-active', fingerprint); await service.finishOperation(active, 'local-active', fingerprint, { stdout: '[REDACTED]' });
    await service.beginOperation(active, 'remote-id:local-owner-operation', fingerprint); await service.beginOperation(dead, 'local-ended', fingerprint);
    const remoteHost = '11111111-1111-4111-8111-111111111111'; await service.trustPeer({ device: { ...service.device(), id: remoteHost }, routeId: 'fixture', direction: 'node', enabled: true }); await service.project({ name: 'remote', bindings: [{ hostId: remoteHost, root: '/remote' }] });
    const remote = await service.ensureRemoteTask({ hostId: remoteHost, sessionId: 'remote-session', taskId: '22222222-2222-4222-8222-222222222222', root: '/remote', projectId: 'untrusted-project', runId: 'remote-run' });
    const ephemeral = await service.create({ name: 'remote temporary', scope: 'task', kind: 'scalar', value: 'SWEEP_EPHEMERAL_CANARY', target: remote, connect: true });
    assert.equal((await service.resolve(remote, ephemeral.reference, 'env')).bytes.toString(), 'SWEEP_EPHEMERAL_CANARY'); await service.beginOperation(remote, `remote-id:${remoteHost}:request`, fingerprint); await service.beginOperation(remote, `remote-nonce:${remoteHost}:nonce`, fingerprint);
    now += 8 * 60 * 60_000 + 1; await service.sweep(new Set(['live-local-run', 'remote-run']));
    assert.equal(service.overview(remote).task?.status, 'closed'); assert.equal(service.overview(remote).task?.closedAt, 1000 + 8 * 60 * 60_000); assert.equal(service.overview().secrets.some(secret => secret.id === ephemeral.id), false); assert.equal(service.overview().groups.some(group => group.id === ephemeral.groupId), false); assert.equal(service.overview().rules.some(rule => rule.groupId === ephemeral.groupId), false);
    await assert.rejects(service.resolve(remote, ephemeral.reference, 'env')); await assert.rejects(service.ensureRemoteTask(remote));
    const journal = await service.vault.journal() as { operations: Record<string, { state: string }>; secrets: unknown[]; grants: { taskId: string }[] }; assert.deepEqual(Object.keys(journal.operations), ['local-active', 'remote-id:local-owner-operation']); assert.deepEqual(journal.secrets, []); assert.equal(journal.grants.some(grant => grant.taskId === remote.taskId), false);
    assert.deepEqual(await service.beginOperation(active, 'local-active', fingerprint), { state: 'done', fresh: false, result: { stdout: '[REDACTED]' } });
    const originalStartedAt = new Date(1000).toISOString(); await service.closeTask(local.taskId); now++; const replacement = await service.ensureTask('owner-session', '/local'); assert.notEqual(replacement.taskId, local.taskId); await assert.rejects(service.bindRun('owner-session', '/local', originalStartedAt), /predates/); await assert.rejects(service.list(active));
    assert.equal((await readFile(join(directory, 'secrets/journal.json'), 'utf8')).includes('SWEEP_EPHEMERAL_CANARY'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('explicit dotenv field grants reject duplicates and stale selections after value rotation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-vault-field-policy-'));
  try {
    const service = new SecretService({ stateDir: directory }); await service.start(); await service.initialize(password);
    const target = await service.ensureTask('session', '/fixture'); const context = { ...target, runId: 'run' };
    const secret = await service.create({ name: 'selected bundle', kind: 'env', scope: 'global', value: 'A=approved-a\nB=approved-b\nC=UNAPPROVED_C_CANARY' });
    const policy = { groupId: secret.groupId, secretIds: [secret.id], hostId: target.hostId, root: target.root, activation: 'manual' as const, operations: ['discover', 'env', 'file', 'pipe'] as const, enabled: true };
    await assert.rejects(service.setRule({ ...policy, operations: [...policy.operations], fields: { [secret.id]: ['A', 'A', 'B'] } }), /field selection/);
    const rule = await service.setRule({ ...policy, operations: [...policy.operations], fields: { [secret.id]: ['A', 'B'] } }); await service.attach(target, [secret.id]);
    const partial = await service.resolve(context, secret.reference, 'env'); assert.equal(partial.bytes.length, 0); assert.deepEqual(partial.fields, { A: 'approved-a', B: 'approved-b' }); await assert.rejects(service.resolve(context, secret.reference, 'file'), /Whole dotenv/);
    const replacedHidden = await service.update({ id: secret.id, value: 'A=approved-a\nB=approved-b\nD=NEW_UNAPPROVED_D_CANARY' }); await assert.rejects(service.resolve(context, replacedHidden.reference, 'env'), /Grant denied/); await service.attach(target, [secret.id]); const stillPartial = await service.resolve(context, replacedHidden.reference, 'env'); assert.equal(stillPartial.bytes.length, 0); assert.deepEqual(stillPartial.fields, { A: 'approved-a', B: 'approved-b' }); await assert.rejects(service.resolve(context, replacedHidden.reference, 'file'), /Whole dotenv/); await assert.rejects(service.resolve(context, replacedHidden.reference + '#D', 'env'));
    const swapped = await service.update({ id: secret.id, value: 'A=updated-a\nC=NEW_UNAPPROVED_C_CANARY' });
    await assert.rejects(service.attach(target, [secret.id]), /field selection/); assert.deepEqual(await service.list(context), []); await assert.rejects(service.resolve(context, swapped.reference, 'env')); await assert.rejects(service.resolve(context, swapped.reference, 'file')); await assert.rejects(service.resolve(context, swapped.reference + '#C', 'env'));
    await assert.rejects(service.setRule({ ...rule, fields: { [secret.id]: ['A', 'B'] } }), /field selection/);
    const approvedA = await service.setRule({ ...rule, fields: { [secret.id]: ['A'] } }); await service.attach(target, [secret.id]); const renewed = await service.resolve(context, swapped.reference, 'env'); assert.equal(renewed.bytes.length, 0); assert.deepEqual(renewed.fields, { A: 'updated-a' }); assert.equal(JSON.stringify(renewed.fields).includes('NEW_UNAPPROVED_C_CANARY'), false); await assert.rejects(service.resolve(context, swapped.reference, 'file'), /Whole dotenv/);
    const added = await service.update({ id: secret.id, value: 'A=latest-a\nC=NEW_UNAPPROVED_C_CANARY\nD=NEW_UNAPPROVED_D_CANARY' }); await service.attach(target, [secret.id]); const expanded = await service.resolve(context, added.reference, 'env'); assert.equal(expanded.bytes.length, 0); assert.deepEqual(expanded.fields, { A: 'latest-a' }); assert.deepEqual((await service.list(context))[0].fields, ['A']); await assert.rejects(service.resolve(context, added.reference, 'file'), /Whole dotenv/); await assert.rejects(service.resolve(context, added.reference + '#D', 'env'));
    await service.setRule({ ...approvedA, fields: { [secret.id]: ['D', 'C', 'A'] } }); await service.attach(target, [secret.id]); const whole = await service.resolve(context, added.reference, 'file'); assert.equal(whole.bytes.toString(), 'A=latest-a\nC=NEW_UNAPPROVED_C_CANARY\nD=NEW_UNAPPROVED_D_CANARY');
    await service.setRule({ ...approvedA, fields: undefined }); const wildcard = await service.update({ id: secret.id, value: 'A=latest-a\nE=OWNER_WILDCARD_FIELD' }); await service.attach(target, [secret.id]); assert.deepEqual((await service.resolve(context, wildcard.reference, 'env')).fields, { A: 'latest-a', E: 'OWNER_WILDCARD_FIELD' });
    await assert.rejects(service.resolve(context, secret.reference, 'env'), /reference/);
    const saved = await service.vault.decryptImport((await service.exportEncryptedVault())!, password) as { rules: { id: string; fields?: Record<string, string[]> }[] }; saved.rules.find(item => item.id === rule.id)!.fields = { [secret.id]: ['A', 'A'] }; await service.vault.save(saved, await service.vault.journal(), service.vault.index); await service.lock(); await service.unlock(password);
    assert.deepEqual(await service.list(context), []); await assert.rejects(service.resolve(context, wildcard.reference, 'env'), /field selection/); await assert.rejects(service.resolve(context, wildcard.reference, 'file'), /field selection/); await assert.rejects(service.resolve(context, wildcard.reference + '#A', 'env'), /field selection/); await assert.rejects(service.attach(target, [secret.id]), /field selection/);

  } finally { await rm(directory, { recursive: true, force: true }); }
});
