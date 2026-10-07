import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

/** The `browser` tool's saved logins: a Playwright storage state that every turn using it adds its changes to. */
export interface Cookie {
  name: string; value: string; domain: string; path: string;
  /** Seconds since the epoch; -1 for a cookie that lasts the browser session. */
  expires: number;
  httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None';
  partitionKey?: string;
}
export interface OriginState { origin: string; localStorage: { name: string; value: string }[] }
export interface StorageState { cookies: Cookie[]; origins: OriginState[] }

export const EMPTY_STATE: StorageState = { cookies: [], origins: [] };
const MAX_BYTES = 8_000_000;
/** A lock folder still without its owner's name after this long was left by a process that died taking it. */
const LOCK_UNNAMED_MS = 5_000;

export function loginsPath(stateDir: string): string { return join(stateDir, 'browser', 'logins.json'); }

const cookieKey = (cookie: Cookie) => JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey ?? '']);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Applies what one turn changed to the saved state. `baseline` is what the turn's browser started from (or last saved);
 * `current` is what it has now. Only cookies and origins that differ from the baseline are written, and a cookie is
 * deleted only when the turn had it and its browser dropped it, so a turn never undoes what another turn saved
 * meanwhile. An origin is never deleted. Expired cookies go.
 */
export function applyChanges(saved: StorageState, baseline: StorageState, current: StorageState, now = Date.now() / 1000): StorageState {
  const before = new Map(baseline.cookies.map(cookie => [cookieKey(cookie), cookie]));
  const after = new Map(current.cookies.map(cookie => [cookieKey(cookie), cookie]));
  const cookies = new Map(saved.cookies.map(cookie => [cookieKey(cookie), cookie]));
  for (const key of before.keys()) if (!after.has(key)) cookies.delete(key);
  for (const [key, cookie] of after) if (!same(before.get(key), cookie)) cookies.set(key, cookie);
  const origins = new Map(saved.origins.map(origin => [origin.origin, origin]));
  const startedWith = new Map(baseline.origins.map(origin => [origin.origin, origin]));
  for (const origin of current.origins) if (!same(startedWith.get(origin.origin), origin)) origins.set(origin.origin, origin);
  return { cookies: [...cookies.values()].filter(cookie => cookie.expires === -1 || cookie.expires > now), origins: [...origins.values()] };
}

/** The saved state, or an empty one when nothing was saved yet. An unreadable file is an error, never replaced silently. */
export async function readState(stateDir: string): Promise<StorageState> {
  try { return parseState(await readPrivateJson(loginsPath(stateDir), MAX_BYTES)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_STATE; throw error; }
}

export function parseState(value: unknown): StorageState {
  const state = value as Partial<StorageState> | null;
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new Error('The browser\'s saved logins are not a storage state.');
  return { cookies: state.cookies.filter(isCookie), origins: state.origins.filter(isOrigin) };
}

function isCookie(value: unknown): value is Cookie {
  const cookie = value as Cookie;
  return !!cookie && typeof cookie.name === 'string' && typeof cookie.value === 'string' && typeof cookie.domain === 'string'
    && typeof cookie.path === 'string' && typeof cookie.expires === 'number' && ['Strict', 'Lax', 'None'].includes(cookie.sameSite);
}
function isOrigin(value: unknown): value is OriginState {
  const origin = value as OriginState;
  return !!origin && typeof origin.origin === 'string' && Array.isArray(origin.localStorage)
    && origin.localStorage.every(item => item && typeof item.name === 'string' && typeof item.value === 'string');
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };

/**
 * Adds one turn's changes to the saved logins under a lock the other turns' browsers take too. The lock names its
 * owner; it is taken over only when that process is gone, and released only by its owner. A live owner is waited for,
 * and the save fails rather than write alongside it.
 */
export async function saveChanges(stateDir: string, baseline: StorageState, current: StorageState, options: { waitMs?: number } = {}): Promise<void> {
  const lock = join(stateDir, 'browser', 'logins.lock');
  const owner = join(lock, 'owner');
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  await mkdir(join(stateDir, 'browser'), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + (options.waitMs ?? 10_000);
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); await writeFile(owner, token, { mode: 0o600 }); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // best-effort: a lock without a readable owner yet is judged by its age below.
      const holder = await readFile(owner, 'utf8').catch(() => '');
      const pid = Number(holder.split(':')[0]);
      // best-effort: a lock that vanished meanwhile is simply tried again.
      const age = await stat(lock).then(info => Date.now() - info.mtimeMs, () => 0);
      const gone = holder ? !(Number.isInteger(pid) && pid > 0 && alive(pid)) : age > LOCK_UNNAMED_MS;
      if (gone) { await rm(lock, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error('Another turn is saving the browser\'s logins; this turn\'s changes were not saved.');
      await delay(50);
    }
  }
  try {
    await writePrivateJson(loginsPath(stateDir), JSON.stringify(applyChanges(await readState(stateDir), baseline, current)));
  } finally {
    // best-effort: a lock whose owner file is unreadable is not ours to remove.
    if (await readFile(owner, 'utf8').catch(() => '') === token) await rm(lock, { recursive: true, force: true });
  }
}
