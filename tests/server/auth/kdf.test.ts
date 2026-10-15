/**
 * The Tower sign-in password hash stays at production strength, without deriving a key at that cost here: the
 * parameters AuthStore hands to scrypt and saves, that the call is node:crypto's, and that saved credentials with other
 * parameters are refused before any password is tried. Other tests use tests/helpers/fast-scrypt.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore, usesRealAuthScrypt } from '../../../server/auth/store.js';
import { cheapScrypt, replaceAuthScrypt } from '../../helpers/fast-scrypt.js';

test('sign-in passwords are hashed with scrypt N=2^17, r=8, p=1 into 64 bytes, through the real call unless a test replaces it', async t => {
  assert.equal(usesRealAuthScrypt(), true, 'nothing replaced the scrypt call in this process');
  const calls: [string, Buffer, number, object][] = [];
  const restore = replaceAuthScrypt((password, salt, keylen, options, done) => { calls.push([String(password), Buffer.from(salt as Buffer), keylen, options]); cheapScrypt(password, salt, keylen, options, done); });
  t.after(restore);
  assert.equal(usesRealAuthScrypt(), false);
  const dir = await mkdtemp(join(tmpdir(), 'tower-auth-kdf-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new AuthStore(dir); await store.start(); t.after(async () => { store.close(); await store.flush(); });
  await store.setCredentials('admin', 'correct horse battery');
  assert.equal((await store.login('192.0.2.1', 'admin', 'correct horse battery')).status, 'success');
  assert.equal((await store.login('192.0.2.1', 'admin', 'wrong horse battery')).status, 'failure');
  const saved = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'));
  assert.deepEqual([saved.algorithm, saved.N, saved.r, saved.p], ['scrypt', 131072, 8, 1]);
  assert.deepEqual(calls.map(([password, salt, keylen, options]) => [password, salt.toString('hex'), keylen, options]),
    ['correct horse battery', 'correct horse battery', 'wrong horse battery'].map(password => [password, saved.salt, 64, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }]));
  // Saved credentials naming any other cost are refused at start, before a password is hashed.
  for (const change of [{ N: 16384 }, { r: 4 }, { p: 2 }, { algorithm: 'argon2id' }]) {
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ ...saved, ...change }));
    await assert.rejects(new AuthStore(dir).start(), /Invalid auth\.json/, JSON.stringify(change));
  }
  assert.equal(calls.length, 3);
  restore();
  assert.equal(usesRealAuthScrypt(), true, 'restoring brings back the real call');
});
