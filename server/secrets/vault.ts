import { constants } from 'node:fs';
import { mkdir, open, lstat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { KDF, encrypt, decrypt, passwordKey, type Ciphertext } from './crypto.js';
import { MIN_VAULT_PASSWORD } from '../../shared/secrets.js';
import { writePrivateJson } from '../stores/private-json.js';
const MAX_FILE = 16 * 1024 * 1024;
/** The current Tower password's wrapper and, while a password change is under way, the next one. */
const MAX_TOWER_WRAPPERS = 2;
/**
 * The vault key wrapped by a Tower (login) password, named by the sha256 hex `credentialId` of the login credentials it
 * was made for. Older builds keep the field through their `{ ...envelope }` saves; the vault password wrapper
 * (`salt`/`wrappedKey`) stays the recovery password.
 */
interface TowerWrapper { credentialId: string; salt: string; wrappedKey: Ciphertext }
interface Envelope { format: 1; vaultId: string; kdf: typeof KDF; salt: string; wrappedKey: Ciphertext; payload: Ciphertext; tower?: { wrappers: TowerWrapper[] } }
const isCredentialId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isCiphertext = (value: unknown): value is Ciphertext => !!value && typeof value === 'object' && ['nonce', 'ciphertext', 'tag'].every(name => typeof (value as Record<string, unknown>)[name] === 'string');
/** The envelope's Tower password wrappers; undefined when the field is malformed. */
function towerWrappers(tower: unknown): TowerWrapper[] | undefined {
  if (tower === undefined) return [];
  const wrappers = (tower as { wrappers?: unknown } | null)?.wrappers;
  if (!Array.isArray(wrappers) || wrappers.length > MAX_TOWER_WRAPPERS || new Set(wrappers.map(item => item?.credentialId)).size !== wrappers.length) return undefined;
  return wrappers.every(item => isCredentialId(item?.credentialId) && typeof item.salt === 'string' && isCiphertext(item.wrappedKey)) ? wrappers : undefined;
}
export class SecretVault {
  readonly directory: string; vaultId = ''; private envelope?: Envelope; private key?: Buffer; private generation = randomUUID();
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
    // Durable, folder included, before the next file of a save is written (the journal before the vault).
    await writePrivateJson(join(this.directory, name), bytes, { syncDirectory: true });
  }
  async start() {
    this.lock(); const bytes = await this.read('vault.json'); if (!bytes) return;
    const value = JSON.parse(bytes.toString()) as Envelope;
    if (value.format !== 1 || typeof value.vaultId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.vaultId) || JSON.stringify(value.kdf) !== JSON.stringify(KDF)) throw new Error('Unsupported vault format or KDF');
    this.envelope = value; this.vaultId = value.vaultId; this.index = undefined;
    if (!towerWrappers(value.tower)) console.warn('Tower ignores the malformed Tower password wrappers of this vault; the vault password still opens it.');
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
    try { key = decrypt(wrapper, this.envelope.wrappedKey, this.aad('key')); return this.open(key); } catch { key?.fill(0); throw new Error('Cannot unlock vault'); } finally { wrapper.fill(0); }
  }
  /** Opens with the key a previous worker handed over; the key is kept only if it decrypts this vault. */
  unlockWithKey(key: Buffer): unknown {
    if (!this.envelope) throw new Error('Vault not initialized'); const copy = Buffer.from(key);
    try { return this.open(copy); } catch { copy.fill(0); throw new Error('Cannot unlock vault'); }
  }
  /** A copy of the open key for the successor worker; never written anywhere. */
  exportKey(): Buffer | undefined { return this.key ? Buffer.from(this.key) : undefined; }
  private open(key: Buffer): unknown {
    if (key.length !== 32) throw new Error('Invalid vault key');
    const payload = JSON.parse(decrypt(key, this.envelope!.payload, this.aad('permanent')).toString()); this.lock(); this.key = key; return payload;
  }
  lock() { this.key?.fill(0); this.key = undefined; this.generation = randomUUID(); }
  /** Changes at every lock (so at every open too) and never repeats, also across workers: an unlock is valid only within its generation. */
  get lockGeneration(): string { return this.generation; }
  private towerAad(credentialId: string) { return this.aad(`tower-key:${credentialId}`); }
  private wrappers(): TowerWrapper[] { return towerWrappers(this.envelope?.tower) ?? []; }
  hasTower(credentialId: string): boolean { return this.wrappers().some(wrapper => wrapper.credentialId === credentialId); }
  /** Opens with the Tower password wrapper of `credentialId` only, returning the payload; an open vault is only checked to be the one it unwraps (undefined). */
  async unlockTower(password: string, credentialId: string): Promise<unknown> {
    if (!this.envelope) throw new Error('Vault not initialized'); const wrapper = this.wrappers().find(item => item.credentialId === credentialId);
    if (!wrapper) throw new Error('Cannot unlock vault');
    let derived: Buffer | undefined; let key: Buffer | undefined;
    try {
      derived = await passwordKey(password, wrapper.salt); key = decrypt(derived, wrapper.wrappedKey, this.towerAad(credentialId));
      if (!this.key) return this.open(key);
      if (!key.equals(this.key)) throw new Error('Another vault key'); key.fill(0); return undefined;
    } catch { key?.fill(0); throw new Error('Cannot unlock vault'); } finally { derived?.fill(0); }
  }
  /** Adds, or replaces, the Tower password wrapper of `credentialId` around the open key. */
  async towerWrap(password: string, credentialId: string) {
    this.validatePassword(password); if (!isCredentialId(credentialId)) throw new Error('Invalid credential ID'); if (!this.key || !this.envelope) throw new Error('Vault locked');
    const others = this.wrappers().filter(item => item.credentialId !== credentialId);
    if (others.length >= MAX_TOWER_WRAPPERS) throw new Error('Too many Tower password wrappers');
    const salt = randomBytes(16).toString('base64'); const derived = await passwordKey(password, salt);
    try { if (!this.key) throw new Error('Vault locked'); await this.writeTower([...others, { credentialId, salt, wrappedKey: encrypt(derived, this.key, this.towerAad(credentialId)) }]); } finally { derived.fill(0); }
  }
  /** Removes every Tower password wrapper but the one of `credentialId`; needs no key. */
  async towerPrune(credentialId: string) {
    if (!this.envelope) throw new Error('Vault not initialized');
    const kept = this.wrappers().filter(item => item.credentialId === credentialId);
    if (towerWrappers(this.envelope.tower) && kept.length === this.wrappers().length) return;
    await this.writeTower(kept);
  }
  private async writeTower(wrappers: TowerWrapper[]) {
    const envelope: Envelope = { ...this.envelope!, tower: wrappers.length ? { wrappers } : undefined };
    await this.write('vault.json', Buffer.from(JSON.stringify(envelope))); this.envelope = envelope;
  }
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
