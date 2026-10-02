import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, lstat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { KDF, encrypt, decrypt, passwordKey, type Ciphertext } from './crypto.js';
import { MIN_VAULT_PASSWORD } from '../../shared/secrets.js';
const MAX_FILE = 16 * 1024 * 1024;
interface Envelope { format: 1; vaultId: string; kdf: typeof KDF; salt: string; wrappedKey: Ciphertext; payload: Ciphertext }
export class SecretVault {
  readonly directory: string; vaultId = ''; private envelope?: Envelope; private key?: Buffer;
  /** Plaintext policy index (names, references, rules; no values) of the last unlocked save. */
  index?: unknown;
  constructor(stateDir: string) { this.directory = join(stateDir, 'secrets'); }
  get initialized() { return !!this.envelope; } get locked() { return !this.key; }
  /** Ties the index to one saved vault state; a vault saved after a failed index write disowns the old index. */
  private async saved() { return createHash('sha256').update(JSON.stringify(this.envelope?.payload ?? null)).update('\0').update((await this.read('journal.json')) ?? '').digest('hex'); }
  private aad(purpose: string) { return `tower-secrets:1:${this.vaultId}:${purpose}`; }
  async read(name: string): Promise<Buffer | undefined> {
    try { if (!(await lstat(this.directory)).isDirectory()) throw new Error('Invalid vault directory'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    let file; try { file = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try { const stat = await file.stat(); if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Invalid vault file'); return await file.readFile(); } finally { await file.close(); }
  }
  async write(name: string, bytes: Buffer) {
    if (bytes.length > MAX_FILE) throw new Error('Vault size limit');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory()) throw new Error('Invalid vault directory');
    await chmod(this.directory, 0o700);
    const temporary = join(this.directory, `.${name}.${randomUUID()}`); const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); } catch (error) { await unlink(temporary); throw error; } finally { await file.close(); }
    try { await rename(temporary, join(this.directory, name)); const directory = await open(this.directory, constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); } } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
  async start() {
    this.lock(); const bytes = await this.read('vault.json'); if (!bytes) return;
    const value = JSON.parse(bytes.toString()) as Envelope;
    if (value.format !== 1 || typeof value.vaultId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.vaultId) || JSON.stringify(value.kdf) !== JSON.stringify(KDF)) throw new Error('Unsupported vault format or KDF');
    this.envelope = value; this.vaultId = value.vaultId; this.index = undefined;
    try { const index = JSON.parse((await this.read('index.json'))?.toString() ?? 'null'); if (index?.format === 1 && index.vaultId === this.vaultId && index.saved === await this.saved()) this.index = index.state; }
    catch { /* An unreadable index only hides names until the next unlock. */ }
  }
  async initialize(password: string, payload: unknown, vaultId: string = randomUUID()) {
    if (this.initialized) throw new Error('Vault already initialized'); this.validatePassword(password);
    this.vaultId = vaultId; const salt = randomBytes(16).toString('base64'); const wrapper = await passwordKey(password, salt); const key = randomBytes(32);
    const envelope: Envelope = { format: 1, vaultId: this.vaultId, kdf: KDF, salt, wrappedKey: encrypt(wrapper, key, this.aad('key')), payload: encrypt(key, Buffer.from(JSON.stringify(payload)), this.aad('permanent')) }; wrapper.fill(0);
    try { await this.write('vault.json', Buffer.from(JSON.stringify(envelope))); this.envelope = envelope; this.key = key; } catch (error) { key.fill(0); throw error; }
  }
  async writeIndex(state: unknown) { if (!this.envelope) throw new Error('Vault not initialized'); this.index = undefined; await this.write('index.json', Buffer.from(JSON.stringify({ format: 1, vaultId: this.vaultId, saved: await this.saved(), state }))); this.index = JSON.parse(JSON.stringify(state)); }
  async unlock(password: string): Promise<unknown> {
    if (!this.envelope) throw new Error('Vault not initialized'); const wrapper = await passwordKey(password, this.envelope.salt); let key: Buffer | undefined;
    try { key = decrypt(wrapper, this.envelope.wrappedKey, this.aad('key')); if (key.length !== 32) throw new Error('Invalid vault key'); const payload = JSON.parse(decrypt(key, this.envelope.payload, this.aad('permanent')).toString()); this.lock(); this.key = key; return payload; } catch { key?.fill(0); throw new Error('Cannot unlock vault'); } finally { wrapper.fill(0); }
  }
  lock() { this.key?.fill(0); this.key = undefined; }
  async save(payload: unknown, journal: unknown, index: unknown) {
    if (!this.key || !this.envelope) throw new Error('Vault locked');
    this.index = undefined;
    const envelope = { ...this.envelope, payload: encrypt(this.key, Buffer.from(JSON.stringify(payload)), this.aad('permanent')) };
    await this.write('journal.json', Buffer.from(JSON.stringify(encrypt(this.key, Buffer.from(JSON.stringify(journal)), this.aad('journal')))));
    await this.write('vault.json', Buffer.from(JSON.stringify(envelope))); this.envelope = envelope;
    // The index only lists names while locked; failing it must not undo the committed vault.
    await this.writeIndex(index).catch(() => console.warn('Tower could not refresh the secret name index; names stay unlisted while locked until the next save.'));
  }
  async journal(): Promise<unknown | undefined> { if (!this.key) throw new Error('Vault locked'); const bytes = await this.read('journal.json'); return bytes ? JSON.parse(decrypt(this.key, JSON.parse(bytes.toString()), this.aad('journal')).toString()) : undefined; }
  async changePassword(current: string, next: string) {
    this.validatePassword(next); if (!this.key || !this.envelope) throw new Error('Vault locked');
    const check = await passwordKey(current, this.envelope.salt); try { const oldKey = decrypt(check, this.envelope.wrappedKey, this.aad('key')); if (!oldKey.equals(this.key)) throw new Error('Incorrect password'); oldKey.fill(0); } finally { check.fill(0); }
    const salt = randomBytes(16).toString('base64'); const wrapper = await passwordKey(next, salt);
    try { const envelope = { ...this.envelope, salt, wrappedKey: encrypt(wrapper, this.key, this.aad('key')) }; await this.write('vault.json', Buffer.from(JSON.stringify(envelope))); this.envelope = envelope; } finally { wrapper.fill(0); }
  }
  async decryptImport(bytes: Buffer, password: string): Promise<unknown> {
    if (bytes.length > MAX_FILE) throw new Error('Import size limit');
    const envelope = JSON.parse(bytes.toString()) as Envelope;
    if (envelope.format !== 1 || !/^[a-f0-9-]{36}$/.test(envelope.vaultId) || JSON.stringify(envelope.kdf) !== JSON.stringify(KDF)) throw new Error('Unsupported import format');
    const wrapper = await passwordKey(password, envelope.salt); let key: Buffer | undefined;
    try { key = decrypt(wrapper, envelope.wrappedKey, `tower-secrets:1:${envelope.vaultId}:key`); return JSON.parse(decrypt(key, envelope.payload, `tower-secrets:1:${envelope.vaultId}:permanent`).toString()); } finally { wrapper.fill(0); key?.fill(0); }
  }
  private validatePassword(password: string) { if (typeof password !== 'string' || password.length < MIN_VAULT_PASSWORD || Buffer.byteLength(password) > 1024) throw new Error('Password must contain at least 12 characters'); }
}
