import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SecretService } from '../../../server/secrets/service.js';

const password = 'fixture-password-1234';

async function stateDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tower-vault-quarantine-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Moving the only copy of the Vault aside would let a new vault with another id replace it.
test('a corrupt vault is never moved aside: the start fails and its bytes stay', async t => {
  const dir = await stateDir(t);
  const service = new SecretService({ stateDir: dir });
  await service.start(); await service.initialize(password);
  const path = join(dir, 'secrets', 'vault.json');
  for (const text of ['{ not json', '{"format":1}']) {
    await writeFile(path, text);
    const before = (await readdir(join(dir, 'secrets'))).sort();
    await assert.rejects(new SecretService({ stateDir: dir }).start());
    assert.equal(await readFile(path, 'utf8'), text);
    assert.deepEqual((await readdir(join(dir, 'secrets'))).sort(), before);
    assert.equal(before.some(name => name.includes('.unreadable-')), false);
  }
});

test('a corrupt Vault journal keeps the Vault locked and both files as they are', async t => {
  const dir = await stateDir(t);
  const service = new SecretService({ stateDir: dir });
  await service.start(); await service.initialize(password);
  const folder = join(dir, 'secrets');
  const vault = await readFile(join(folder, 'vault.json'));
  await writeFile(join(folder, 'journal.json'), '{ not json');
  const before = (await readdir(folder)).sort();
  const restarted = new SecretService({ stateDir: dir });
  await restarted.start();
  await assert.rejects(restarted.unlock(password));
  assert.equal(restarted.status().locked, true);
  assert.deepEqual(await readFile(join(folder, 'vault.json')), vault);
  assert.equal(await readFile(join(folder, 'journal.json'), 'utf8'), '{ not json');
  assert.deepEqual((await readdir(folder)).sort(), before);
});

test('nothing in the secrets domain sets a file aside', async () => {
  const folder = join(import.meta.dirname, '../../../server/secrets');
  for (const name of await readdir(folder)) {
    const source = await readFile(join(folder, name), 'utf8');
    assert.doesNotMatch(source, /quarantineFile|\.unreadable-/, name);
  }
});
