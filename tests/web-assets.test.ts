import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWebAsset } from '../server/http/web-assets.js';

test('web asset paths serve SPA routes without allowing reads outside the UI root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'monitor-assets-'));
  const client = join(root, 'client');
  await mkdir(client);
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(client, 'index.html'), 'application');
  await writeFile(join(root, 'secret.txt'), 'private');
  await writeFile(join(client, 'app.js'), 'console.log(1)');
  assert.equal((await readWebAsset(client, '/'))?.content.toString(), 'application');
  assert.equal((await readWebAsset(client, '/sessions/example'))?.extension, '.html');
  assert.equal((await readWebAsset(client, '/app.js'))?.content.toString(), 'console.log(1)');
  assert.equal(await readWebAsset(client, '/../secret.txt'), undefined);
  assert.equal(await readWebAsset(client, '/..\\secret.txt'), undefined);
  assert.equal(await readWebAsset(client, '/missing.js'), undefined);
});
