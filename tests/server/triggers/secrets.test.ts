import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SecretStore } from '../../../server/triggers/secrets.js';
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
