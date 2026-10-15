/**
 * Tests without the production-strength scrypt cost of Tower sign-in passwords (N = 2^17, about a quarter second per
 * hash) and backup passphrases (N = 2^16). One `fastScrypt()` line at the top of a test file replaces the scrypt
 * call behind `AuthStore` and the backup cipher for that file's process: the committed fixture backups, made by real
 * builds at the real cost, get their real keys from the map below, and every other (password, salt, parameters) gets a
 * SHA-512 key, so passwords still decide everything and a wrong one still fails. The stored parameters and their checks are untouched (auth.json and the
 * backup header always say what production uses).
 *
 * Only *.test.ts files import this (a gate test keeps it so): never fixture generators, shared helpers or server code,
 * because a file written with these keys does not open in production. A fixture backup missing from the map fails as
 * a wrong passphrase; add its key, derived once with the real scrypt, never in a test.
 */
import { createHash, type BinaryLike } from 'node:crypto';
import { replaceAuthScryptForTests, type Scrypt } from '../../server/auth/store.js';
import { replaceBackupScryptForTests } from '../../server/backup/crypto.js';

const bytes = (value: BinaryLike): Buffer => typeof value === 'string' ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);

/** Real production keys of the committed fixture backups, as `${passphrase hex}:${salt base64}` → key hex. */
const FIXTURE_KEYS = new Map([
  // tests/server/backup/fixtures/backup-*.towerbackup (make-backup.ts, FIXTURE_PASSPHRASE)
  ['fixture backup passphrase', 'ptTC1Pg8xofm37C2lmt2sA==', 'e4bf5cfc59a253b1dae1a3007d0f45163a05f9dc3361bf0174a52a2d84445e68'],
  ['fixture backup passphrase', 'pkJu1al5M+4Hj9SomVtGPg==', '40654c29590f914a4ce90046563e92022bde949ddf8923c3698f847af7d23a56'],
  ['fixture backup passphrase', '1MC4zkILUeeMVy/w+B2tPA==', '3d6af10231d6f9104e17112c3339910835de9d70359e176a555a1ace2b55a7d4'],
  ['fixture backup passphrase', '6B31Tv8xZ7Hy4CT3AdPq0g==', '86afaa7b6b81e2a44f90e1f5b44639b28bc8499f8e61898178d524aa0b51887e'],
].map(([password, salt, key]) => [`${Buffer.from(password).toString('hex')}:${salt}`, key]));

/** The cheap call `fastScrypt()` installs; a spy can pass its calls on to it. */
export const cheapScrypt: Scrypt = (password, salt, keylen, options, callback) => {
  setImmediate(() => { // stays asynchronous like the real call
    const known = FIXTURE_KEYS.get(`${bytes(password).toString('hex')}:${bytes(salt).toString('base64')}`);
    if (known && keylen === 32) return callback(null, Buffer.from(known, 'hex'));
    const { N, r, p } = options;
    callback(null, createHash('sha512').update('tower-test-scrypt:1\0').update(JSON.stringify({ N, r, p, keylen })).update('\0')
      .update(bytes(password)).update('\0').update(bytes(salt)).digest().subarray(0, keylen));
  });
};
let installed = false;
export function fastScrypt(): void {
  if (installed) return; installed = true;
  replaceAuthScryptForTests(cheapScrypt);
  replaceBackupScryptForTests(cheapScrypt);
}

/** Replaces the sign-in password scrypt call with `fn` (a spy) until the returned restore runs. */
export const replaceAuthScrypt = (fn: Scrypt): () => void => replaceAuthScryptForTests(fn);
/** Replaces the backup passphrase scrypt call with `fn` (a spy) until the returned restore runs. */
export const replaceBackupScrypt = (fn: Scrypt): () => void => replaceBackupScryptForTests(fn);
