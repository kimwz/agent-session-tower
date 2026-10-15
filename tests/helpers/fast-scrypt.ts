import crypto, { type BinaryLike, type ScryptOptions } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

/**
 * Importing this makes every `crypto.scrypt` call in this test process use a cost (N) of at most 1024, keeping its
 * other options. A Tower login or credential change otherwise costs a quarter second of CPU each (N = 2^17), which
 * proves nothing a test of what is let in or kept out can observe. Hashes made under it are only readable in the same
 * process, so this is only for tests that make and check their own; never for saved fixtures or for tests of the
 * key derivation itself. Each test file runs in its own process, so this reaches no other file.
 */
const real = crypto.scrypt;
type Callback = (error: Error | null, key: Buffer) => void;
crypto.scrypt = ((password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions | Callback, callback?: Callback) => {
  if (typeof options === 'function') return real(password, salt, keylen, options);
  const cost = Math.min(options.N ?? options.cost ?? 16_384, 1024);
  const { N: _n, cost: _cost, ...rest } = options;
  return real(password, salt, keylen, { ...rest, N: cost }, callback!);
}) as typeof crypto.scrypt;
syncBuiltinESMExports();
