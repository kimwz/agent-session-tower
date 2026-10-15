/**
 * The backup passphrase hash stays at production strength, without deriving a key at that cost here: the parameters
 * the cipher hands to scrypt and writes in the header, and that the call is node:crypto's. Other backup tests use
 * tests/helpers/fast-scrypt.ts; the committed fixture backups (owner-formats.test.ts) open with the real call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptBackup, encryptBackup, readBackupHeader, usesRealBackupScrypt } from '../../../server/backup/crypto.js';
import { cheapScrypt, replaceBackupScrypt } from '../../helpers/fast-scrypt.js';

test('backup passphrases are hashed with scrypt N=2^16, r=8, p=1 into 32 bytes, through the real call unless a test replaces it', async t => {
  assert.equal(usesRealBackupScrypt(), true, 'nothing replaced the scrypt call in this process');
  const calls: [string, string, number, object][] = [];
  const restore = replaceBackupScrypt((password, salt, keylen, options, done) => { const { N, r, p, maxmem } = options; calls.push([String(password), Buffer.from(salt as Buffer).toString('base64'), keylen, { N, r, p, maxmem }]); cheapScrypt(password, salt, keylen, options, done); });
  t.after(restore);
  assert.equal(usesRealBackupScrypt(), false);
  const text = await encryptBackup({ version: 1, secret: 'x' }, 'correct horse', { towerVersion: '1.91.0', from: 'studio' });
  const { kdf } = readBackupHeader(text);
  assert.deepEqual({ ...kdf, salt: undefined }, { name: 'scrypt', N: 65536, r: 8, p: 1, salt: undefined });
  assert.deepEqual((await decryptBackup(text, 'correct horse')).payload, { version: 1, secret: 'x' });
  await assert.rejects(decryptBackup(text, 'wrong horse'), /암호가 맞지 않거나/);
  assert.deepEqual(calls, ['correct horse', 'correct horse', 'wrong horse'].map(password => [password, kdf.salt, 32, { N: 65536, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }]));
  restore();
  assert.equal(usesRealBackupScrypt(), true, 'restoring brings back the real call');
});
