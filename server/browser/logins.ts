import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { quarantineFile, readPrivateJson, writePrivateJson } from '../stores/private-json.js';

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
/** Well under what is read back, so a saved file can always be read. */
const SAVE_BUDGET_BYTES = 4_000_000;
/** A new browser visits each saved origin to restore its local storage (about 25 ms each): this keeps starting quick. */
const MAX_ORIGINS = 30;
/** A lock folder still without its owner's name after this long was left by a process that died taking it. */
const LOCK_UNNAMED_MS = 5_000;

export function loginsPath(stateDir: string): string { return join(stateDir, 'browser', 'logins.json'); }

const cookieKey = (cookie: Cookie) => JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey ?? '']);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Applies what one turn changed to the saved state. `baseline` is what the turn's browser started from (or last saved);
 * `current` is what it has now. Only cookies and origins that differ from the baseline are written, and a cookie is
 * deleted only when the turn had it and its browser dropped it, so a turn never undoes what another turn saved
 * meanwhile. What a save writes moves to the end, so the saved order is the order of last change. An origin whose local
 * storage the turn emptied is removed; one that was empty all along is never written. Expired cookies go.
 */
export function applyChanges(saved: StorageState, baseline: StorageState, current: StorageState, now = Date.now() / 1000, seen: ReadonlySet<string> = new Set()): StorageState {
  const before = new Map(baseline.cookies.map(cookie => [cookieKey(cookie), cookie]));
  const after = new Map(current.cookies.map(cookie => [cookieKey(cookie), cookie]));
  const cookies = new Map(saved.cookies.map(cookie => [cookieKey(cookie), cookie]));
  for (const key of before.keys()) if (!after.has(key)) cookies.delete(key);
  for (const [key, cookie] of after) if (!same(before.get(key), cookie)) { cookies.delete(key); cookies.set(key, cookie); }
  const origins = new Map(saved.origins.map(origin => [origin.origin, origin]));
  const startedWith = new Map(baseline.origins.map(origin => [origin.origin, origin]));
  for (const origin of current.origins) {
    if (same(startedWith.get(origin.origin), origin)) continue;
    origins.delete(origin.origin);
    if (origin.localStorage.length) origins.set(origin.origin, origin);
  }
  // An origin the turn used but did not change moves to the end too, with the value saved: it is in use.
  for (const name of seen) { const kept = origins.get(name); if (kept && !changedOrigin(startedWith.get(name), current.origins.find(origin => origin.origin === name))) { origins.delete(name); origins.set(name, kept); } }
  return { cookies: [...cookies.values()].filter(cookie => cookie.expires === -1 || cookie.expires > now), origins: [...origins.values()] };
}

const changedOrigin = (before: OriginState | undefined, after: OriginState | undefined) => !!after && !same(before, after);

/** What a save changed, by key; never evicted to make room. */
function changedKeys(baseline: StorageState, current: StorageState): { cookies: Set<string>; origins: Set<string> } {
  const before = new Map(baseline.cookies.map(cookie => [cookieKey(cookie), cookie]));
  const startedWith = new Map(baseline.origins.map(origin => [origin.origin, origin]));
  return {
    cookies: new Set(current.cookies.filter(cookie => !same(before.get(cookieKey(cookie)), cookie)).map(cookieKey)),
    origins: new Set(current.origins.filter(origin => origin.localStorage.length && !same(startedWith.get(origin.origin), origin)).map(origin => origin.origin)),
  };
}

/**
 * Keeps the saved logins readable and quick to restore: at most `maxOrigins` origins of local storage (each one costs
 * the browser a page visit whenever it reads its state) and at most `budget` bytes. What was changed least recently
 * (or used least recently) goes first: local storage, then cookies that last only for a browser session, then any other
 * cookie. What this save changed is kept; when
 * that alone is too much, the save fails and the saved logins stay as they were.
 */
export function fitToBudget(state: StorageState, keep: { cookies: Set<string>; origins: Set<string> }, limits: { budget?: number; maxOrigins?: number } = {}): StorageState {
  const budget = limits.budget ?? SAVE_BUDGET_BYTES, maxOrigins = limits.maxOrigins ?? MAX_ORIGINS;
  const origins = [...state.origins], cookies = [...state.cookies];
  const size = () => Buffer.byteLength(JSON.stringify({ cookies, origins }));
  const evictOrigin = () => { const index = origins.findIndex(origin => !keep.origins.has(origin.origin)); if (index < 0) return false; origins.splice(index, 1); return true; };
  const evictCookie = (session: boolean) => { const index = cookies.findIndex(cookie => (!session || cookie.expires === -1) && !keep.cookies.has(cookieKey(cookie))); if (index < 0) return false; cookies.splice(index, 1); return true; };
  while (origins.length > maxOrigins && evictOrigin());
  while (size() > budget && (evictOrigin() || evictCookie(true) || evictCookie(false)));
  if (size() > budget) throw new Error(`What this turn changed would grow the browser's saved logins past ${budget / 1_000_000} MB; its changes were not saved.`);
  return { cookies, origins };
}

/**
 * The saved state, or an empty one when nothing was saved yet. A file this build cannot read (damaged, or grown past
 * the limit) is set aside for inspection and reported, so the browser starts without logins instead of failing every
 * turn from then on.
 */
export async function readState(stateDir: string, log: (error: unknown) => void = () => {}): Promise<StorageState> {
  const path = loginsPath(stateDir);
  let raw: unknown;
  try { raw = await readPrivateJson(path, MAX_BYTES); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_STATE;
    if (!(error instanceof SyntaxError) && !/invalid or too large/.test(String(error))) throw error;
    raw = undefined;
  }
  try { return parseState(raw); }
  catch {
    let aside: string;
    try { aside = await quarantineFile(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_STATE; throw error; }
    log(new Error(`The browser's saved logins could not be read and were set aside at ${aside}; the browser starts without them.`));
    return EMPTY_STATE;
  }
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
  return !!origin && isWebOrigin(origin.origin) && Array.isArray(origin.localStorage)
    && origin.localStorage.every(item => item && typeof item.name === 'string' && typeof item.value === 'string');
}

/** An http(s) origin as a browser writes it; anything else cannot be restored (a browser cannot open `null`). */
export function isWebOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // best-effort: a string that is not a URL is not an origin.
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && url.origin === value; } catch { return false; }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };


/**
 * Adds one turn's changes to the saved logins under a lock the other turns' browsers take too. The lock names its
 * owner and is released only by that owner. A lock whose owner is gone is taken over one process at a time, after
 * checking again that the same dead owner still holds it; a live owner is waited for, and the save fails rather than
 * write alongside it.
 */
export async function saveChanges(stateDir: string, baseline: StorageState, current: StorageState, options: { waitMs?: number; log?: (error: unknown) => void; seen?: ReadonlySet<string> } = {}): Promise<void> {
  const lock = join(stateDir, 'browser', 'logins.lock');
  const owner = join(lock, 'owner');
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  await mkdir(join(stateDir, 'browser'), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + (options.waitMs ?? 10_000);
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); await writeFile(owner, token, { mode: 0o600 }); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = await lockHolder(lock);
      if (holder.gone) await takeOver(lock, holder.name);
      else if (Date.now() > deadline) throw new Error('Another turn is saving the browser\'s logins; this turn\'s changes were not saved.');
      else await delay(50);
    }
  }
  try {
    const merged = fitToBudget(applyChanges(await readState(stateDir, options.log), baseline, current, Date.now() / 1000, options.seen), changedKeys(baseline, current));
    await writePrivateJson(loginsPath(stateDir), JSON.stringify(merged));
  } finally {
    // best-effort: a lock whose owner file is unreadable is not ours to remove.
    if (await readFile(owner, 'utf8').catch(() => '') === token) await rm(lock, { recursive: true, force: true });
  }
}

/** Who holds the lock, and whether that holder is gone: its process ended, or it never wrote its name. */
async function lockHolder(lock: string): Promise<{ name: string; gone: boolean }> {
  // best-effort: a lock without a readable owner yet is judged by its age.
  const name = await readFile(join(lock, 'owner'), 'utf8').catch(() => '');
  if (name) { const pid = Number(name.split(':')[0]); return { name, gone: !(Number.isInteger(pid) && pid > 0 && alive(pid)) }; }
  // best-effort: a lock that vanished meanwhile is simply tried again.
  const age = await stat(lock).then(info => Date.now() - info.mtimeMs, () => 0);
  return { name, gone: age > LOCK_UNNAMED_MS };
}

/** Removes a dead holder's lock, one process at a time, only if that same holder still has it. */
async function takeOver(lock: string, deadHolder: string): Promise<void> {
  const takeover = `${lock}.takeover`;
  try { await mkdir(takeover, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Another process is taking it over; one that died doing so left a folder only a few milliseconds of work old.
    // best-effort: a takeover folder that vanished meanwhile needs nothing.
    const age = await stat(takeover).then(info => Date.now() - info.mtimeMs, () => 0);
    if (age > LOCK_UNNAMED_MS) await rm(takeover, { recursive: true, force: true });
    else await delay(20);
    return;
  }
  try {
    const now = await lockHolder(lock);
    if (now.gone && now.name === deadHolder) await rm(lock, { recursive: true, force: true });
  } finally { await rm(takeover, { recursive: true, force: true }); }
}

/**
 * One turn's saves, in order. Each applies what changed since the last save that succeeded, so a failed save's changes
 * go with the next one. A save carries the cookies and the local storage of the pages open at the time: the origins it
 * did not see keep what was saved for them. Reads are numbered by when they started, for the cookies and for each origin
 * apart, so a read that finished late never overwrites what a newer one saw, and still adds what only it saw.
 */
export class LoginSaver {
  private baseline: StorageState = EMPTY_STATE;
  private queue: Promise<void> = Promise.resolve();
  private cookiesRead = 0;
  private readonly originsRead = new Map<string, number>();
  constructor(private readonly stateDir: string, private readonly log: (error: unknown) => void, private readonly options: { waitMs?: number } = {}) {}

  /** A new browser started from `state`. */
  started(state: StorageState): void { this.baseline = state; }

  /** `read` numbers when the state was read. */
  save(seen: StorageState, read: number): Promise<void> {
    const cookies = read > this.cookiesRead ? seen.cookies : undefined;
    if (cookies) this.cookiesRead = read;
    const fresh = seen.origins.filter(origin => read > (this.originsRead.get(origin.origin) ?? 0));
    for (const origin of fresh) this.originsRead.set(origin.origin, read);
    if (!cookies && !fresh.length) return this.queue;
    this.queue = this.queue.then(async () => {
      const origins = new Map(this.baseline.origins.map(origin => [origin.origin, origin]));
      for (const origin of fresh) origins.set(origin.origin, origin);
      const next = { cookies: cookies ?? this.baseline.cookies, origins: [...origins.values()] };
      await saveChanges(this.stateDir, this.baseline, next, { ...this.options, log: this.log, seen: new Set(fresh.filter(origin => origin.localStorage.length).map(origin => origin.origin)) });
      this.baseline = { cookies: next.cookies, origins: next.origins.filter(origin => origin.localStorage.length) };
    }).catch(this.log);
    return this.queue;
  }

  idle(): Promise<void> { return this.queue; }
}
