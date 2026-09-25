import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, chmod } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import type { AuthOverview, BlockedIp, LoginAttempt } from '../../shared/auth.js';

const LIMIT = 5;
const HISTORY = 1000;
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const KDF = { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };
interface Credentials { version: 1; username: string; algorithm: 'scrypt'; salt: string; hash: string; N: number; r: number; p: number }
interface Security { version: 1; attempts: LoginAttempt[]; failures: Record<string, number>; blockedIps: BlockedIp[] }
export function canonicalIp(address: string): string {
  if (!isIP(address)) throw new Error('Invalid client IP address.');
  if (isIP(address) === 4) return address;
  const normalized = new URL(`http://[${address.split('%')[0]}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
  if (mapped) {
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return normalized;
}
export function isLoopbackAddress(address: string): boolean {
  try { const ip = canonicalIp(address); return ip === '::1' || (isIP(ip) === 4 && ip.startsWith('127.')); }
  catch { return false; }
}
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, Buffer.from(salt, 'hex'), 64, KDF, (error, key) => error ? reject(error) : resolve(key)));
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validUsername(value: unknown): value is string { return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 64; }
function validIp(value: unknown): value is string { try { return typeof value === 'string' && canonicalIp(value) === value; } catch { return false; } }
function date(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
async function optional(path: string): Promise<unknown> { try { return await readPrivateJson(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }

export class AuthStore {
  private credentials?: Credentials;
  private security: Security = { version: 1, attempts: [], failures: {}, blockedIps: [] };
  private sessions = new Map<string, { ip: string; expires: number; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(sessionId: string) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private started = false;
  private closed = false;
  private persistenceError = false;
  constructor(private readonly stateDir: string) {}
  async start(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await chmod(this.stateDir, 0o700);
    const credentials = await optional(join(this.stateDir, 'auth.json'));
    if (credentials !== undefined) {
      if (!object(credentials) || credentials.version !== 1 || !validUsername(credentials.username) || credentials.algorithm !== 'scrypt' || credentials.N !== KDF.N || credentials.r !== KDF.r || credentials.p !== KDF.p || typeof credentials.salt !== 'string' || !/^[a-f0-9]{64}$/.test(credentials.salt) || typeof credentials.hash !== 'string' || !/^[a-f0-9]{128}$/.test(credentials.hash)) throw new Error('Invalid auth.json; authentication cannot start.');
      this.credentials = credentials as unknown as Credentials;
    }
    const security = await optional(join(this.stateDir, 'auth-security.json'));
    if (security !== undefined) {
      if (!object(security) || security.version !== 1 || !Array.isArray(security.attempts) || security.attempts.length > HISTORY || !object(security.failures) || !Array.isArray(security.blockedIps)) throw new Error('Invalid auth-security.json; authentication cannot start.');
      for (const [ip, count] of Object.entries(security.failures)) if (!validIp(ip) || !Number.isInteger(count) || (count as number) < 1 || (count as number) > LIMIT) throw new Error('Invalid authentication failure records.');
      for (const entry of security.attempts) if (!object(entry) || typeof entry.id !== 'string' || !date(entry.at) || !validIp(entry.ip) || typeof entry.username !== 'string' || entry.username.length > 64 || !['success', 'failure', 'blocked'].includes(String(entry.result))) throw new Error('Invalid authentication history.');
      const seen = new Set<string>();
      for (const entry of security.blockedIps) {
        if (!object(entry) || !validIp(entry.ip) || !date(entry.blockedAt) || entry.failures !== LIMIT || security.failures[entry.ip] !== LIMIT || seen.has(entry.ip)) throw new Error('Invalid blocked IP records.');
        seen.add(entry.ip);
      }
      for (const [ip, count] of Object.entries(security.failures)) if (count === LIMIT && !seen.has(ip)) throw new Error('Missing blocked IP record.');
      this.security = security as unknown as Security;
    }
    this.started = true;
  }
  configured(): boolean { return !!this.credentials; }
  username(): string | undefined { return this.credentials?.username; }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    if (!this.started || this.closed || this.persistenceError) return Promise.reject(new Error('Authentication store is not running.'));
    if (this.pending >= 16) return Promise.reject(Object.assign(new Error('Too many authentication requests.'), { statusCode: 429 }));
    this.pending++;
    const result = this.queue.then(() => {
      if (this.closed || this.persistenceError) throw new Error('Authentication store is not running.');
      return work();
    });
    this.queue = result.catch(() => {}).finally(() => { this.pending--; });
    return result;
  }
  async setCredentials(username: string, password: string): Promise<void> {
    username = username.trim();
    if (!validUsername(username) || password.length < 12 || password.length > 256) throw Object.assign(new Error('Username must be 1–64 characters and password must be 12–256 characters.'), { statusCode: 400 });
    return this.serial(async () => {
      const salt = randomBytes(32).toString('hex');
      const credentials: Credentials = { version: 1, username, algorithm: 'scrypt', salt, hash: (await derive(password, salt)).toString('hex'), N: KDF.N, r: KDF.r, p: KDF.p };
      await writePrivateJson(join(this.stateDir, 'auth.json'), JSON.stringify(credentials));
      this.credentials = credentials;
      for (const token of this.sessions.keys()) this.logout(token);
    });
  }
  login(ip: string, username: string, password: string): Promise<{ status: 'success' | 'failure' | 'blocked' | 'unconfigured'; sessionId?: string }> {
    ip = canonicalIp(ip);
    return this.serial(async () => {
      if (!this.credentials) return { status: 'unconfigured' };
      let result: LoginAttempt['result'];
      if (this.security.blockedIps.some(entry => entry.ip === ip)) result = 'blocked';
      else {
        const key = await derive(password.length <= 256 ? password : '', this.credentials.salt);
        result = timingSafeEqual(key, Buffer.from(this.credentials.hash, 'hex')) && username === this.credentials.username && password.length <= 256 ? 'success' : 'failure';
        if (result === 'failure') {
          this.security.failures[ip] = Math.min(LIMIT, (this.security.failures[ip] ?? 0) + 1);
          if (this.security.failures[ip] === LIMIT) {
            this.security.blockedIps.push({ ip, blockedAt: new Date().toISOString(), failures: LIMIT });
            result = 'blocked';
            for (const [token, session] of this.sessions) if (session.ip === ip) this.logout(token);
          }
        }
      }
      this.security.attempts.unshift({ id: randomUUID(), at: new Date().toISOString(), ip, username: username.slice(0, 64), result });
      this.security.attempts.length = Math.min(HISTORY, this.security.attempts.length);
      await this.persistSecurity();
      if (this.closed) throw new Error('Authentication store is closed.');
      if (result !== 'success') return { status: result };
      const token = randomBytes(32).toString('base64url');
      const timer = setTimeout(() => this.logout(token), SESSION_MS);
      timer.unref();
      this.sessions.set(token, { ip, expires: Date.now() + SESSION_MS, timer });
      return { status: 'success', sessionId: token };
    });
  }
  session(token: string, ip: string): boolean {
    const session = this.sessions.get(token);
    if (!session || this.closed) return false;
    if (session.expires <= Date.now()) { this.logout(token); return false; }
    return session.ip === canonicalIp(ip) && !this.security.blockedIps.some(entry => entry.ip === session.ip);
  }
  logout(token: string): void {
    const session = this.sessions.get(token);
    if (!session) return;
    clearTimeout(session.timer); this.sessions.delete(token);
    for (const listener of this.listeners) { try { listener(token); } catch { /* A disconnected consumer must not prevent revocation. */ } }
  }
  unblock(ip: string): Promise<void> {
    ip = canonicalIp(ip);
    return this.serial(async () => {
      const next: Security = { ...this.security, failures: { ...this.security.failures }, blockedIps: this.security.blockedIps.filter(entry => entry.ip !== ip) };
      delete next.failures[ip];
      await writePrivateJson(join(this.stateDir, 'auth-security.json'), JSON.stringify(next));
      this.security = next;
    });
  }
  overview(): AuthOverview { return { configured: this.configured(), username: this.username(), attempts: this.security.attempts.map(entry => ({ ...entry })), blockedIps: this.security.blockedIps.map(entry => ({ ...entry })), attemptLimit: LIMIT, historyLimit: HISTORY }; }
  onRevoke(listener: (sessionId: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close(): void { this.closed = true; for (const token of this.sessions.keys()) this.logout(token); }
  async flush(): Promise<void> { await this.queue; }
  private async persistSecurity(): Promise<void> {
    try { await writePrivateJson(join(this.stateDir, 'auth-security.json'), JSON.stringify(this.security)); }
    catch (error) {
      // Never continue authenticating against failure counts that could disappear on restart.
      this.persistenceError = true;
      for (const token of this.sessions.keys()) this.logout(token);
      throw error;
    }
  }
}
