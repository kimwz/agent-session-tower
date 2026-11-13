import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { writePrivateFile } from '../../stores/private-json.js';

/**
 * Claude Code's own sign-in store, read and written the way Claude Code does: the macOS keychain item first, then
 * `<configDir>/.credentials.json`. Tower changes only the `claudeAiOauth` record; every other key (MCP sign-ins and the like)
 * stays as Claude Code left it. Secrets never reach a command line when the keychain's stdin can carry them.
 */
type Json = Record<string, unknown>;
const MAX_JSON = 2 * 1024 * 1024;
// `security -i` reads one command line; longer payloads go on the command line, as Claude Code does.
const SECURITY_STDIN_LIMIT = 4000;
const object = (value: unknown): Json | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;

export function claudeStorage(env: NodeJS.ProcessEnv, defaultHome = homedir()): { directory: string; service: string; account: string } {
  const override = env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined ? env.CLAUDE_SECURESTORAGE_CONFIG_DIR : env.CLAUDE_CONFIG_DIR;
  const directory = (override || join(defaultHome, '.claude')).normalize('NFC');
  const suffix = override ? `-${createHash('sha256').update(directory).digest('hex').slice(0, 8)}` : '';
  const username = env.USER || userInfo().username;
  return { directory, service: `Claude Code-credentials${suffix}`, account: /^[a-zA-Z0-9._-]+$/.test(username) ? username : 'claude-code-user' };
}

/** The keychain as `security` sees it; tests replace it. */
export type Keychain = {
  read(account: string, service: string, signal?: AbortSignal): Promise<string>;
  write(account: string, service: string, data: string): Promise<void>;
  remove(account: string, service: string): Promise<void>;
};

function run(args: string[], options: { input?: string; signal?: AbortSignal } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/security', args, { timeout: 5000, maxBuffer: MAX_JSON, ...(options.signal ? { signal: options.signal } : {}) }, (error, stdout) => {
      // `security` can print item attributes on failure; only the exit status leaves this function.
      if (error) reject(new Error(`security ${args[0]} failed${typeof error.code === 'number' ? ` (exit ${error.code})` : ''}`));
      else resolve(stdout);
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

export const systemKeychain: Keychain = {
  read: (account, service, signal) => run(['find-generic-password', '-a', account, '-w', '-s', service], { signal }),
  async write(account, service, data) {
    const hex = Buffer.from(data, 'utf8').toString('hex');
    const command = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
    if (command.length <= SECURITY_STDIN_LIMIT) await run(['-i'], { input: command });
    else await run(['add-generic-password', '-U', '-a', account, '-s', service, '-X', hex]);
  },
  async remove(account, service) {
    try { await run(['delete-generic-password', '-a', account, '-s', service]); }
    catch { /* best-effort: no such item is the outcome removal wants. */ }
  },
};

export type StoreOptions = { env?: NodeJS.ProcessEnv; platform?: string; keychain?: Keychain; signal?: AbortSignal; readJson?: (path: string) => Promise<unknown> };
export type StoreReading =
  | { kind: 'stored'; blob: Json; source: 'keychain' | 'file' }
  | { kind: 'none' }
  | { kind: 'unreadable' };

async function readFileJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_JSON) throw new Error('invalid_private_file');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

/** Reads the store with Claude Code's precedence: a present keychain item wins even without an OAuth record. */
export async function readClaudeStore(options: StoreOptions = {}): Promise<StoreReading> {
  const env = options.env || process.env;
  const storage = claudeStorage(env);
  if ((options.platform || process.platform) === 'darwin') {
    let raw: string | undefined;
    try { raw = await (options.keychain || systemKeychain).read(storage.account, storage.service, options.signal); }
    catch { if (options.signal?.aborted) return { kind: 'unreadable' }; /* Claude Code falls back to the file. */ }
    if (raw !== undefined) {
      try { const blob = object(JSON.parse(raw)); return blob ? { kind: 'stored', blob, source: 'keychain' } : { kind: 'unreadable' }; }
      catch { return { kind: 'unreadable' }; }
    }
  }
  try {
    const blob = object(await (options.readJson || readFileJson)(join(storage.directory, '.credentials.json')));
    return blob ? { kind: 'stored', blob, source: 'file' } : { kind: 'unreadable' };
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'none' } : { kind: 'unreadable' }; }
}

export const oauthOf = (reading: StoreReading): Json | undefined => reading.kind === 'stored' ? object(reading.blob.claudeAiOauth) : undefined;

async function fileExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; } // best-effort: no file means nothing to keep in step
}

async function replaceInFile(path: string, oauth: Json, create: boolean): Promise<void> {
  let blob: Json = {};
  try { blob = object(await readFileJson(path)) || {}; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error; }
  await writePrivateFile(path, JSON.stringify({ ...blob, claudeAiOauth: oauth }));
}

/**
 * Puts `oauth` into the store as its `claudeAiOauth`, keeping every other key. On macOS the keychain item is written (Claude
 * Code reads it first), and an existing `.credentials.json` gets the same record, so a shell whose keychain is locked (SSH)
 * falls back to the same account. Elsewhere only the file.
 */
export async function writeClaudeOAuth(oauth: Json, options: StoreOptions = {}): Promise<void> {
  const env = options.env || process.env;
  const storage = claudeStorage(env);
  const file = join(storage.directory, '.credentials.json');
  if ((options.platform || process.platform) !== 'darwin') return replaceInFile(file, oauth, true);
  const keychain = options.keychain || systemKeychain;
  let blob: Json = {};
  let raw: string | undefined;
  try { raw = await keychain.read(storage.account, storage.service); } catch { /* best-effort: no item yet, so a new one is made. */ }
  if (raw !== undefined) {
    // An item Tower cannot parse is never overwritten: it may hold sign-ins Tower does not know.
    const parsed = object(JSON.parse(raw));
    if (!parsed) throw new Error('The Claude Code keychain item is not readable JSON.');
    blob = parsed;
  }
  await keychain.write(storage.account, storage.service, JSON.stringify({ ...blob, claudeAiOauth: oauth }));
  if (await fileExists(file)) await replaceInFile(file, oauth, false);
}

/** Removes a store Tower made for a saved account: its keychain item and its folder. Never used on the default store. */
export async function removeClaudeStore(directory: string, options: Omit<StoreOptions, 'env'> = {}): Promise<void> {
  const storage = claudeStorage({ ...process.env, CLAUDE_CONFIG_DIR: directory, CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined });
  if ((options.platform || process.platform) === 'darwin') await (options.keychain || systemKeychain).remove(storage.account, storage.service);
  await rm(directory, { recursive: true, force: true });
}

/** The profile record (`oauthAccount`) Claude Code keeps in `<configDir>/.claude.json`, or `~/.claude.json` by default. */
export function claudeConfigPath(env: NodeJS.ProcessEnv, home = homedir()): string {
  return join(env.CLAUDE_CONFIG_DIR || home, '.claude.json');
}
const MAX_CLAUDE_CONFIG = 32 * 1024 * 1024;

export async function readOAuthAccount(env: NodeJS.ProcessEnv, home = homedir()): Promise<Json | undefined> {
  try {
    const file = await open(claudeConfigPath(env, home), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_CLAUDE_CONFIG) return undefined;
      return object(object(JSON.parse(await file.readFile('utf8')))?.oauthAccount);
    } finally { await file.close(); }
  // best-effort: a missing or unreadable configuration has no profile.
  } catch { return undefined; }
}

/**
 * Sets `oauthAccount` in the configuration, keeping everything else, through a new owner-only file renamed over it.
 * Claude Code rewrites this file often; a write of its own in the same instant can win, which only leaves its profile text
 * (not the sign-in) on the earlier account.
 */
export async function writeOAuthAccount(account: Json, env: NodeJS.ProcessEnv, home = homedir()): Promise<void> {
  const path = claudeConfigPath(env, home);
  let config: Json = {};
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_CLAUDE_CONFIG) throw new Error('The Claude Code configuration is too large or not a file.');
      const parsed = object(JSON.parse(await file.readFile('utf8')));
      if (!parsed) throw new Error('The Claude Code configuration is not a JSON object.');
      config = parsed;
    } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writePrivateFile(path, JSON.stringify({ ...config, oauthAccount: account }, null, 2));
}
