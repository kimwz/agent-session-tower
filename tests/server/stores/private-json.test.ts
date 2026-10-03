import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readPrivateJson } from '../../../server/stores/private-json.js';

test('readPrivateJson keeps its errors and limits', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-private-json-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');

  await assert.rejects(readPrivateJson(path), { code: 'ENOENT' });

  await writeFile(path, '{"a":[1,"é"]}', { mode: 0o644 });
  await chmod(path, 0o644);
  assert.deepEqual(await readPrivateJson(path), { a: [1, 'é'] });
  assert.equal((await stat(path)).mode & 0o777, 0o600, 'a read makes the file owner-only');

  const link = join(dir, 'link.json');
  await symlink(path, link);
  await assert.rejects(readPrivateJson(link), { code: 'ELOOP' });

  await writeFile(path, '{"padding":"0123456789"}');
  await assert.rejects(readPrivateJson(path, 10), { message: `Saved state in ${path} is invalid or too large.` });
  assert.deepEqual(await readPrivateJson(path, 24), { padding: '0123456789' }, 'a file of exactly the limit is read');

  const folder = join(dir, 'folder.json');
  await mkdir(folder);
  await assert.rejects(readPrivateJson(folder), { message: `Saved state in ${folder} is invalid or too large.` });

  await writeFile(path, '{ not json');
  await assert.rejects(readPrivateJson(path), SyntaxError);
});
