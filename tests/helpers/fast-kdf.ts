/**
 * Vault tests without the production-strength password hash (Argon2id, 64 MiB, about 1.3 s per derivation). One
 * `fastVaultKdf()` line at the top of a test file replaces the Argon2id call behind `passwordKey` for that file's process:
 * the committed fixture vaults, made by real builds with the real hash, get their real keys from the map below, and
 * every other (password, salt) gets a SHA-256 key, so passwords still decide everything and a wrong one still fails.
 * The stored KDF label and its checks are untouched (the envelope always says what production uses).
 *
 * Only *.test.ts files import this (a gate test keeps it so): never fixture generators, shared helpers or server code,
 * because a vault written with these keys does not open in production. A fixture vault missing from the map fails
 * with "Cannot unlock vault"; add its key, derived once with the real `passwordKey`, never in a test.
 */
import { createHash } from 'node:crypto';
import { replaceArgon2ForTests } from '../../server/secrets/crypto.js';

/** Real production keys of the committed fixture vaults, as `${password hex}:${salt base64}` → key hex. */
const FIXTURE_KEYS = new Map([
  // tests/server/backup/fixtures/vault-sharing-v2.json (make-sharing-vault.ts)
  ['fixture vault password 1', 'hDq430LhV5QPoizfGrQ12w==', '4b08049f08fee7b2124747554bdbee9cc78915fceda524ded524504c07ced434'],
  // the vault in backup-1.105.0-vault.{towerbackup,payload.json,state.json} and payload-1.106.0-vault.json (make-backup.ts)
  ['fixture vault password 1', 'VaT9w9yGzxE8/0lOGyWW5Q==', 'bec9bb01056903106e3612d6aa5c654ee4ffc6b5a3acd310832c7aa6ab84b6fd'],
].map(([password, salt, key]) => [`${Buffer.from(password).toString('hex')}:${salt}`, key]));

/** Replaces the Argon2id call with `fn` (a spy) until the returned restore runs; for tests of `passwordKey` itself. */
export const replaceVaultArgon2 = (fn: Parameters<typeof replaceArgon2ForTests>[0]): () => void => replaceArgon2ForTests(fn);

let installed = false;
export function fastVaultKdf(): void {
  if (installed) return; installed = true;
  replaceArgon2ForTests(async (password, salt, options) => {
    await new Promise(setImmediate); // stays asynchronous like the real call
    const known = FIXTURE_KEYS.get(`${Buffer.from(password as Uint8Array).toString('hex')}:${Buffer.from(salt as Uint8Array).toString('base64')}`);
    if (known) return Buffer.from(known, 'hex');
    return createHash('sha256').update('tower-test-kdf:1\0').update(JSON.stringify(options)).update('\0').update(password as Uint8Array).update('\0').update(salt as Uint8Array).digest().subarray(0, options.dkLen);
  });
}
