import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SecretStore } from '../../../server/triggers/secrets.js';
import { SecretService } from '../../../server/secrets/service.js';
import { asideNames, blockQuarantine, captureErrors } from '../../helpers/quarantine.js';

async function stateDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tower-trigger-secrets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('unreadable trigger secrets are moved aside', async t => {
  const dir = await stateDir(t);
  const path = join(dir, 'trigger-secrets.json');
  await writeFile(path, '[{ not json', { mode: 0o600 });
  const logged = captureErrors(t, path);
  const store = new SecretStore(dir);
  await store.load();
  assert.deepEqual(store.list(), []);
  const [aside] = await asideNames(path);
  assert.equal(await readFile(join(dir, aside), 'utf8'), '[{ not json');
  assert.equal(logged[0].args[0], 'Trigger secrets could not be read and were moved aside:');
  assert.ok(logged[0].args[1] instanceof SyntaxError);
  assert.equal(logged[0].present, true, 'logged before the move');
});

test('trigger secrets that cannot be moved aside are logged and loading still finishes', async t => {
  const dir = await stateDir(t);
  const path = join(dir, 'trigger-secrets.json');
  await writeFile(path, '[{ not json', { mode: 0o600 });
  const blocked = await blockQuarantine(t, path);
  const logged = captureErrors(t, path);
  const store = new SecretStore(dir);
  await store.load();
  blocked.release();
  assert.deepEqual(store.list(), []);
  assert.equal(logged[0].args[0], 'Trigger secrets could not be read and were moved aside:');
  assert.deepEqual(await readdir(blocked.aside), ['occupied'], 'the move failed');
});

const secret = (id: string) => ({ id, name: `Secret ${id}`, origin: 'https://status.example.com', value: `Bearer ${id}`, createdAt: '2026-10-01T00:00:00.000Z' });

test('trigger secrets of the wrong shape are moved aside, not overwritten', async t => {
  for (const text of ['{}', '[{"id":1}]', JSON.stringify([secret('a'), secret('a')])]) {
    const dir = await stateDir(t);
    const path = join(dir, 'trigger-secrets.json');
    await writeFile(path, text, { mode: 0o600 });
    captureErrors(t, path);
    const store = new SecretStore(dir);
    await store.load();
    const [aside] = await asideNames(path);
    assert.ok(aside, text);
    assert.equal(await readFile(join(dir, aside), 'utf8'), text);
    assert.equal(store.problem, `Trigger secrets could not be read and were kept as ${join(dir, aside)}; triggers that use them fail until they are entered again.`);
    await store.create({ name: 'New', origin: 'https://status.example.com', value: 'Bearer new' }, Date.now());
    assert.equal(await readFile(join(dir, aside), 'utf8'), text, 'the kept file is never written');
  }
});

test('more than 50 valid trigger secrets from a restore are all kept', async t => {
  const { applyWorkerFiles } = await import('../../../server/backup/payload.js');
  const dir = await stateDir(t);
  const path = join(dir, 'trigger-secrets.json');
  const local = Array.from({ length: 30 }, (_, index) => secret(`local-${index}`));
  const restored = Array.from({ length: 30 }, (_, index) => secret(`backup-${index}`));
  await writeFile(path, JSON.stringify(local), { mode: 0o600 });
  await applyWorkerFiles(dir, { 'trigger-secrets.json': restored });
  const store = new SecretStore(dir);
  await store.load();
  assert.equal(store.list().length, 60);
  assert.equal(store.get('local-3')?.value, 'Bearer local-3');
  assert.equal(store.get('backup-7')?.value, 'Bearer backup-7');
  assert.equal(store.problem, undefined);
  assert.deepEqual(await asideNames(path), []);
  await assert.rejects(store.create({ name: 'One more', origin: 'https://status.example.com', value: 'Bearer more' }, Date.now()), { statusCode: 409 });

  const before = await readFile(path, 'utf8');
  const vault = new SecretService({ stateDir: dir });
  await vault.start(); await vault.initialize('fixture-password-1234');
  const encrypted = new SecretStore(dir, { vault });
  await assert.rejects(encrypted.migrate(), { message: 'Invalid legacy trigger secrets; original file preserved.' });
  assert.equal(await readFile(path, 'utf8'), before);
});

test('trigger secrets that cannot be moved aside are never written over', async t => {
  const dir = await stateDir(t);
  const path = join(dir, 'trigger-secrets.json');
  await writeFile(path, '{}', { mode: 0o600 });
  const blocked = await blockQuarantine(t, path);
  captureErrors(t, path);
  const store = new SecretStore(dir);
  await store.load();
  blocked.release();
  const locked = 'Trigger secrets could not be read or moved aside; nothing is saved until Tower restarts.';
  await assert.rejects(store.create({ name: 'New', origin: 'https://status.example.com', value: 'Bearer new' }, Date.now()), { statusCode: 503, message: locked });
  await assert.rejects(store.remove('a'), { statusCode: 503, message: locked });
  assert.equal(store.get('a'), undefined);
  assert.equal(store.problem, locked);
  assert.equal(await readFile(path, 'utf8'), '{}');
});

test('with the Vault initialized, a legacy file is neither read nor moved', async t => {
  const dir = await stateDir(t);
  const vault = new SecretService({ stateDir: dir });
  await vault.start(); await vault.initialize('fixture-password-1234');
  const path = join(dir, 'trigger-secrets.json');
  await writeFile(path, '{ not json', { mode: 0o600 });
  const logged = captureErrors(t, path);
  await new SecretStore(dir, { vault }).load();
  assert.equal(await readFile(path, 'utf8'), '{ not json');
  assert.deepEqual(await asideNames(path), []);
  assert.equal(logged.length, 0);
});
