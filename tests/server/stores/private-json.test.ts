import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { quarantineFile, readPrivateBytes, readPrivateJson, writePrivateJson } from '../../../server/stores/private-json.js';

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

test('readPrivateBytes answers the bytes as they are, with the same checks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-private-json-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const bytes = Buffer.from([0x7b, 0xff, 0x7d]);
  await writeFile(path, bytes, { mode: 0o644 });
  await chmod(path, 0o644);
  assert.deepEqual(await readPrivateBytes(path), bytes);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(readPrivateBytes(path, 2), { message: `Saved state in ${path} is invalid or too large.` });
  await assert.rejects(readPrivateBytes(join(dir, 'missing.json')), { code: 'ENOENT' });
});

test('quarantineFile moves the file aside and answers where; a missing file throws', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-private-json-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  await writeFile(path, '{ not json', { mode: 0o600 });
  t.mock.method(Date, 'now', () => 1234);
  const aside = await quarantineFile(path);
  assert.equal(aside, `${path}.unreadable-1234`);
  assert.deepEqual(await readdir(dir), ['state.json.unreadable-1234']);
  assert.equal(await readFile(aside, 'utf8'), '{ not json');
  assert.equal((await stat(aside)).mode & 0o777, 0o600);
  await assert.rejects(quarantineFile(path), { code: 'ENOENT' });
});

test('writePrivateJson writes bytes as given, and with syncDirectory still leaves only the file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-private-write-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'vault.json');
  const bytes = Uint8Array.from([0, 1, 2, 0xff, 0x0a]);
  await writePrivateJson(path, bytes, { syncDirectory: true });
  assert.deepEqual(new Uint8Array(await readFile(path)), bytes);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ['vault.json']);
});

test('writePrivateJson always closes what it opened, and a close failure never hides the first error', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-private-close-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const fail = (code: string) => Object.assign(new Error(code), { code });
  // Test-only, limited to this folder: chosen handle calls fail after the real handle is used and closed.
  let plan: { file?: { sync?: string; close?: string }; folder?: { sync?: string; close?: string } } = {};
  const calls: string[] = [];
  const original = fsPromises.open;
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof original>) => {
    const handle = await original(...args);
    const target = String(args[0]);
    const kind = target === directory ? 'folder' : target.startsWith(`${path}.`) ? 'file' : undefined;
    if (!kind) return handle;
    calls.push(`${kind}:open`);
    const { sync, close } = { sync: handle.sync.bind(handle), close: handle.close.bind(handle) };
    handle.sync = async () => { calls.push(`${kind}:sync`); await sync(); const code = plan[kind]?.sync; if (code) throw fail(code); };
    handle.close = async () => { calls.push(`${kind}:close`); await close(); const code = plan[kind]?.close; if (code) throw fail(code); };
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const attempt = async (next: typeof plan, syncDirectory: boolean) => {
    plan = next; calls.length = 0;
    return writePrivateJson(path, 'x', { syncDirectory }).then(() => undefined, (error: NodeJS.ErrnoException) => error.code);
  };

  assert.equal(await attempt({}, true), undefined);
  assert.deepEqual(calls, ['file:open', 'file:sync', 'file:close', 'folder:open', 'folder:sync', 'folder:close']);
  assert.equal(await attempt({}, false), undefined);
  assert.deepEqual(calls, ['file:open', 'file:sync', 'file:close'], 'no folder sync unless asked');
  assert.equal(await attempt({ file: { sync: 'EIO', close: 'EBADF' } }, false), 'EIO', 'a failed file sync is the error, not the close after it');
  assert.equal(await attempt({ file: { close: 'EBADF' } }, false), 'EBADF', 'a close that alone fails is the error');
  assert.equal(await attempt({ folder: { sync: 'EIO', close: 'EBADF' } }, true), 'EIO', 'a failed folder sync is the error, not the close after it');
  assert.equal(await attempt({ folder: { close: 'EBADF' } }, true), 'EBADF');
  assert.ok(calls.includes('folder:close'), 'the folder is closed even when its sync fails');
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), []);
});
