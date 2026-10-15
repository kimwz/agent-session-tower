import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { argon2idAsync } from '@noble/hashes/argon2.js';
export const KDF = { algorithm: 'argon2id', memory: 65536, iterations: 3, parallelism: 4 } as const;
export interface Ciphertext { nonce: string; ciphertext: string; tag: string }
export function decode(value: string, size?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length > 24 * 1024 * 1024) throw new Error('Invalid encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (size !== undefined && bytes.length !== size)) throw new Error('Invalid encoding');
  return bytes;
}
export function encrypt(key: Buffer, bytes: Buffer, aad: string): Ciphertext {
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(aad));
  return { nonce: nonce.toString('base64'), ciphertext: Buffer.concat([cipher.update(bytes), cipher.final()]).toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
export function decrypt(key: Buffer, value: Ciphertext, aad: string): Buffer {
  const cipher = createDecipheriv('aes-256-gcm', key, decode(value.nonce, 12)); cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(decode(value.tag, 16));
  return Buffer.concat([cipher.update(decode(value.ciphertext)), cipher.final()]);
}
/** The Argon2id call behind passwordKey; only tests/helpers/fast-kdf.ts replaces it (a gate test keeps it so). */
let argon2: typeof argon2idAsync = argon2idAsync;
export async function passwordKey(password: string, salt: string): Promise<Buffer> {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024) throw new Error('Invalid password');
  return Buffer.from(await argon2(Buffer.from(password), decode(salt, 16), { m: KDF.memory, t: KDF.iterations, p: KDF.parallelism, dkLen: 32, maxmem: 80 * 1024 * 1024 }));
}
/** Test-only: swaps the Argon2id call so tests skip the production-strength hash; returns the restore. */
export function replaceArgon2ForTests(fn: typeof argon2idAsync): () => void {
  const previous = argon2; argon2 = fn; return () => { argon2 = previous; };
}
/** Test-only: whether the Argon2id call is the real one. */
export const usesRealArgon2 = () => argon2 === argon2idAsync;
