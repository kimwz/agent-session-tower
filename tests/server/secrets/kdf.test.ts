/**
 * The vault password hash stays at production strength, without deriving a key here (one derivation takes over a
 * second): the parameters, what passwordKey hands to Argon2id, that the call is the real one, and that a vault stored or
 * imported with any other parameters is refused before a password is tried. Other vault tests use tests/helpers/fast-kdf.ts.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { KDF, passwordKey, usesRealArgon2 } from '../../../server/secrets/crypto.js';
import { SecretVault } from '../../../server/secrets/vault.js';
import { replaceVaultArgon2 } from '../../helpers/fast-kdf.js';

const FIXTURE = join(import.meta.dirname, '../backup/fixtures/vault-sharing-v2.json');
const OTHER_PARAMETERS = [{ algorithm: 'argon2i' }, { memory: 32768 }, { memory: 99999999 }, { iterations: 2 }, { parallelism: 1 }, { extra: 1 }];

/** Counts Argon2id calls; any call fails, so a refusal is proven to come before the password is tried. */
function forbidDerivation(t: TestContext) {
  const calls: unknown[] = [];
  t.after(replaceVaultArgon2(async (...args) => { calls.push(args); throw new Error('derived'); }));
  return calls;
}

test('the vault password hash is Argon2id with 64 MiB, 3 passes and 4 lanes, and passwordKey hands exactly that to the real call', async t => {
  assert.deepEqual({ ...KDF }, { algorithm: 'argon2id', memory: 65536, iterations: 3, parallelism: 4 });
  assert.equal(usesRealArgon2(), true, 'nothing replaced the Argon2id call in this process');
  const calls: [Uint8Array, Uint8Array, Record<string, unknown>][] = [];
  const restore = replaceVaultArgon2(async (password, salt, options) => { calls.push([password as Uint8Array, salt as Uint8Array, options]); return new Uint8Array(32).fill(7); });
  t.after(restore);
  assert.equal(usesRealArgon2(), false);
  const salt = randomBytes(16);
  const key = await passwordKey('correct horse battery staple ✓', salt.toString('base64'));
  assert.deepEqual(key, Buffer.alloc(32, 7));
  assert.equal(calls.length, 1);
  const [password, saltBytes, options] = calls[0];
  assert.deepEqual(Buffer.from(password), Buffer.from('correct horse battery staple ✓'));
  assert.deepEqual(Buffer.from(saltBytes), salt);
  assert.deepEqual(options, { m: 65536, t: 3, p: 4, dkLen: 32, maxmem: 80 * 1024 * 1024 });
  // Malformed input is refused before the call.
  await assert.rejects(passwordKey('x'.repeat(1025), salt.toString('base64')), /Invalid password/);
  await assert.rejects(passwordKey('password', randomBytes(15).toString('base64')), /Invalid encoding/);
  assert.equal(calls.length, 1);
  restore();
  assert.equal(usesRealArgon2(), true, 'restoring brings back the real call');
});

test('a stored vault with other hash parameters is refused at start, before any password', async t => {
  const calls = forbidDerivation(t);
  const directory = await mkdtemp(join(tmpdir(), 'tower-kdf-stored-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'secrets'));
  const fixture = JSON.parse(await readFile(FIXTURE, 'utf8'));
  await writeFile(join(directory, 'secrets/vault.json'), JSON.stringify(fixture));
  const vault = new SecretVault(directory); await vault.start(); assert.equal(vault.initialized, true, 'the production label starts');
  for (const change of OTHER_PARAMETERS) {
    await writeFile(join(directory, 'secrets/vault.json'), JSON.stringify({ ...fixture, kdf: { ...fixture.kdf, ...change } }));
    await assert.rejects(new SecretVault(directory).start(), /Unsupported vault format or KDF/, JSON.stringify(change));
  }
  assert.equal(calls.length, 0);
});

test('a vault file to import with other hash parameters is refused before any password or machine key', async t => {
  const calls = forbidDerivation(t);
  const fixture = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const vault = new SecretVault(await mkdtemp(join(tmpdir(), 'tower-kdf-import-'))); t.after(() => rm(vault.directory, { recursive: true, force: true }));
  for (const change of OTHER_PARAMETERS) {
    const bytes = Buffer.from(JSON.stringify({ ...fixture, kdf: { ...fixture.kdf, ...change } }));
    await assert.rejects(vault.decryptImport(bytes, 'fixture vault password 1'), /Unsupported import format/, JSON.stringify(change));
    assert.throws(() => vault.decryptImportWithMachineKey(bytes, randomBytes(32)), /Unsupported import format/);
  }
  assert.equal(calls.length, 0);
  // The production label reaches the password: the (forbidden) derivation is tried.
  await assert.rejects(vault.decryptImport(Buffer.from(JSON.stringify(fixture)), 'fixture vault password 1'), /derived/);
  assert.equal(calls.length, 1);
});
