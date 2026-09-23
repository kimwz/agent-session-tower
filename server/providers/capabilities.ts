import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { EffortOption, ModelOption, Provider, ProviderHealth, ProviderUsage, UsageWindow } from '../../shared/types.js';
import { CLAUDE_EFFORT_LEVELS, validEffort, validModelId } from './models.js';
import { APP_TITLE, APP_VERSION, LEGACY_APP_NAME } from '../../shared/app-identity.js';

const execute = promisify(execFile);
const MAX_JSON = 2 * 1024 * 1024;
type Json = Record<string, unknown>;
export type Capabilities = Pick<ProviderHealth, 'usage' | 'models' | 'defaultModel' | 'efforts'>;
type Reason = 'not_signed_in' | 'not_supported' | 'credentials_unavailable' | 'rate_limited' | 'unreachable' | 'no_data';
const object = (value: unknown): Json | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const timestamp = (value: unknown): string | undefined => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const percentage = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const unavailable = (reason: Reason): ProviderUsage => ({ status: reason === 'unreachable' || reason === 'rate_limited' ? 'error' : 'unavailable', windows: [], reason });
// `claude --effort` levels. Claude Code silently lowers a level the resolved model cannot use.
export const CLAUDE_EFFORTS: readonly EffortOption[] = CLAUDE_EFFORT_LEVELS.map(id => ({ id }));
// Native aliases resolve through Claude Code's own defaults and environment remaps.
export const CLAUDE_MODELS: readonly ModelOption[] = [
  { id: 'sonnet', label: 'Sonnet', efforts: [...CLAUDE_EFFORTS] }, { id: 'opus', label: 'Opus', efforts: [...CLAUDE_EFFORTS] }, { id: 'haiku', label: 'Haiku', efforts: [] },
];
const copyModel = (model: ModelOption): ModelOption => ({ ...model, ...(model.efforts ? { efforts: model.efforts.map(effort => ({ ...effort })) } : {}) });

/** Copy only quota windows; account identity, credit balances and tokens stay private. */
export function parseCodexUsage(value: unknown, now = Date.now()): ProviderUsage {
  const root = object(value);
  const limits = object(object(root?.rateLimitsByLimitId)?.codex) || object(root?.rateLimits);
  const windows: UsageWindow[] = [];
  for (const id of ['primary', 'secondary']) {
    const window = object(limits?.[id]);
    if (!window || !percentage(window.usedPercent)) continue;
    const duration = window.windowDurationMins;
    const resets = typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) ? window.resetsAt * 1000 : NaN;
    const resetsAt = Number.isFinite(resets) && Math.abs(resets) <= 8.64e15 ? new Date(resets).toISOString() : undefined;
    windows.push({ id, usedPercent: window.usedPercent,
      ...(typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? { windowMinutes: duration } : {}),
      ...(resetsAt ? { resetsAt } : {}) });
  }
  return quota(windows, now);
}

export function parseClaudeUsage(value: unknown, now = Date.now()): ProviderUsage {
  const root = object(value);
  const windows: UsageWindow[] = [];
  const durations: Record<string, number> = { five_hour: 300, seven_day: 10080, seven_day_sonnet: 10080, seven_day_opus: 10080 };
  for (const [id, windowMinutes] of Object.entries(durations)) {
    const window = object(root?.[id]);
    if (!window || !percentage(window.utilization)) continue;
    const resetsAt = timestamp(window.resets_at);
    windows.push({ id, usedPercent: window.utilization, windowMinutes, ...(resetsAt ? { resetsAt } : {}) });
  }
  return quota(windows, now);
}

function quota(windows: UsageWindow[], now: number): ProviderUsage {
  if (!windows.length) return { ...unavailable('no_data'), updatedAt: new Date(now).toISOString() };
  // An elapsed reset is not proof that usage is zero. Keep the observation marked stale.
  const stale = windows.some(window => window.resetsAt && Date.parse(window.resetsAt) <= now);
  return { status: stale ? 'unavailable' : 'available', windows, updatedAt: new Date(now).toISOString(),
    ...(stale ? { stale: true, reason: 'no_data' } : {}) };
}

export function parseCodexModels(value: unknown): Pick<Capabilities, 'models' | 'defaultModel'> {
  const entries = object(value)?.data;
  if (!Array.isArray(entries)) return { models: [] };
  const models = new Map<string, ModelOption>();
  let defaultModel: string | undefined;
  for (const entry of entries) {
    const item = object(entry);
    if (!item || item.hidden === true || !validModelId(item.model)) continue;
    const id = item.model;
    const efforts = Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts.map(object)
      .filter((option): option is Json => !!option && validEffort(option.reasoningEffort)).slice(0, 12)
      .map(option => ({ id: option.reasoningEffort as string, ...(typeof option.description === 'string' ? { description: option.description.slice(0, 300) } : {}) })) : undefined;
    const defaultEffort = efforts?.some(effort => effort.id === item.defaultReasoningEffort) ? item.defaultReasoningEffort as string : undefined;
    models.set(id, { id, label: typeof item.displayName === 'string' ? item.displayName.slice(0, 160) : id,
      ...(typeof item.description === 'string' ? { description: item.description.slice(0, 300) } : {}),
      ...(efforts ? { efforts } : {}), ...(defaultEffort ? { defaultEffort } : {}) });
    if (item.isDefault === true) defaultModel = id;
  }
  return { models: [...models.values()], ...(defaultModel ? { defaultModel } : {}) };
}

async function privateJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_JSON) throw new Error('invalid_private_file');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

export function claudeStorage(env: NodeJS.ProcessEnv, defaultHome = homedir()): { directory: string; service: string; account: string } {
  const override = env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined ? env.CLAUDE_SECURESTORAGE_CONFIG_DIR : env.CLAUDE_CONFIG_DIR;
  const directory = (override || join(defaultHome, '.claude')).normalize('NFC');
  const suffix = override ? `-${createHash('sha256').update(directory).digest('hex').slice(0, 8)}` : '';
  const username = env.USER || userInfo().username;
  return { directory, service: `Claude Code-credentials${suffix}`, account: /^[a-zA-Z0-9._-]+$/.test(username) ? username : 'claude-code-user' };
}

type CredentialReaderOptions = {
  env?: NodeJS.ProcessEnv; platform?: string; signal: AbortSignal;
  readJson?: (path: string) => Promise<unknown>;
  keychain?: (account: string, service: string, signal: AbortSignal) => Promise<string>;
};

/** Read the same native storage, without refresh, permission changes or copies. */
export async function readClaudeCredential(options: CredentialReaderOptions): Promise<{ token?: string; reason?: Reason }> {
  const env = options.env || process.env;
  // Match native auth precedence: an explicit account must never fall through to
  // the unrelated personal subscription stored on this machine.
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR || env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
    || ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_SIMPLE'].some(key => env[key] === '1' || env[key] === 'true')
    || env.ANTHROPIC_BASE_URL && env.ANTHROPIC_BASE_URL.replace(/\/$/, '') !== 'https://api.anthropic.com') return { reason: 'not_supported' };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    if (!env.CLAUDE_CODE_OAUTH_SCOPES?.split(/\s+/).includes('user:profile')) return { reason: 'not_supported' };
    return /[\r\n]/.test(env.CLAUDE_CODE_OAUTH_TOKEN) ? { reason: 'credentials_unavailable' } : { token: env.CLAUDE_CODE_OAUTH_TOKEN };
  }
  const storage = claudeStorage(env);
  let credentials: unknown;
  if ((options.platform || process.platform) === 'darwin') {
    try {
      const readKeychain = options.keychain || (async (account, service, signal) => (await execute('/usr/bin/security', ['find-generic-password', '-a', account, '-w', '-s', service], { timeout: 2000, maxBuffer: MAX_JSON, signal })).stdout);
      const raw = await readKeychain(storage.account, storage.service, options.signal);
      // A present keychain account takes precedence even when it has no OAuth record.
      credentials = JSON.parse(raw);
    } catch (error) {
      if (options.signal.aborted) return { reason: 'credentials_unavailable' };
      // Keychain lookup failures use native plaintext fallback; never echo stderr.
      if (error instanceof SyntaxError) return { reason: 'credentials_unavailable' };
    }
  }
  if (credentials === undefined) {
    try { credentials = await (options.readJson || privateJson)(join(storage.directory, '.credentials.json')); }
    catch (error) { return { reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_signed_in' : 'credentials_unavailable' }; }
  }
  const oauth = object(object(credentials)?.claudeAiOauth);
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken || /[\r\n]/.test(oauth.accessToken)) return { reason: 'not_signed_in' };
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()) return { reason: 'not_signed_in' };
  if (!Array.isArray(oauth.scopes) || !oauth.scopes.includes('user:profile')) return { reason: 'not_supported' };
  return { token: oauth.accessToken };
}

export async function readClaudeUsage(options: CredentialReaderOptions & { fetch?: typeof fetch }): Promise<ProviderUsage> {
  options = { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(5000)]) };
  const credentials = await readClaudeCredential(options);
  if (!credentials.token) return unavailable(credentials.reason || 'not_signed_in');
  try {
    const response = await (options.fetch || fetch)('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET', redirect: 'error', signal: options.signal,
      headers: { Authorization: `Bearer ${credentials.token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return unavailable(response.status === 401 ? 'not_signed_in' : response.status === 403 || response.status === 404 ? 'not_supported' : response.status === 429 ? 'rate_limited' : 'unreachable');
    }
    const body = response.body;
    if (!body) return unavailable('no_data');
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > MAX_JSON) { await reader.cancel(); return unavailable('no_data'); }
        chunks.push(part.value);
      }
      return parseClaudeUsage(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } finally { reader.releaseLock(); }
  } catch { return unavailable('unreachable'); }
}

function rpcReason(error: unknown): Reason {
  const message = error instanceof Error ? error.message : '';
  if (/unauthenticated|unauthorized|not.*logged|not.*signed|authentication|401/i.test(message)) return 'not_signed_in';
  if (/rate.limit|429/i.test(message)) return 'rate_limited';
  if (/unsupported|not.support|method.not.found|not.available.*account|requires.*ChatGPT/i.test(message)) return 'not_supported';
  return 'unreachable';
}

/** Isolated read-only app-server: no threads, prompts, auth refresh or settings calls. */
export async function readCodexCapabilities(executable: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Capabilities> {
  signal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  if (signal.aborted) return { usage: unavailable('unreachable') };
  const child = spawn(executable, ['app-server', '--stdio'], { env, stdio: 'pipe', shell: false });
  child.stderr.resume(); // Native diagnostics can contain private account details.
  let id = 0;
  let buffer = '';
  let stopped = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const fail = (error: Error) => { stopped = true; for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  const aborted = () => { fail(new Error('unreachable')); child.kill('SIGTERM'); };
  signal.addEventListener('abort', aborted, { once: true });
  child.once('error', () => fail(new Error('unreachable')));
  const closed = new Promise<void>(resolve => child.once('close', () => { fail(new Error('unreachable')); resolve(); }));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data: string) => {
    buffer += data;
    if (buffer.length > MAX_JSON) { fail(new Error('unreachable')); child.kill(); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const value = object(JSON.parse(line));
        const entry = typeof value?.id === 'number' ? pending.get(value.id) : undefined;
        if (!entry || !value) continue;
        pending.delete(value.id as number);
        if (value.error) entry.reject(new Error(String(object(value.error)?.message || 'unreachable')));
        else entry.resolve(value.result);
      } catch { fail(new Error('unreachable')); child.kill(); return; }
    }
  });
  const request = (method: string, params: object) => new Promise<unknown>((resolve, reject) => {
    if (stopped || signal.aborted) { reject(new Error('unreachable')); return; }
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n', error => { if (error) fail(new Error('unreachable')); });
  });
  child.stdin.on('error', () => fail(new Error('unreachable')));
  try {
    await request('initialize', { clientInfo: { name: LEGACY_APP_NAME, title: APP_TITLE, version: APP_VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const [usage, models] = await Promise.all([
      request('account/rateLimits/read', {}).then(parseCodexUsage).catch(error => unavailable(rpcReason(error))),
      (async () => {
        const data: unknown[] = [];
        let cursor: string | undefined;
        const cursors = new Set<string>();
        for (let page = 0; page < 5; page++) {
          const result = object(await request('model/list', { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) }));
          if (!Array.isArray(result?.data)) throw new Error('unreachable');
          data.push(...result.data);
          cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
          if (!cursor || cursors.has(cursor)) break;
          cursors.add(cursor);
        }
        return parseCodexModels({ data });
      })().catch(() => ({})),
    ]);
    return { usage, ...models };
  } catch (error) { return { usage: unavailable(rpcReason(error)) }; }
  finally {
    signal.removeEventListener('abort', aborted);
    child.stdin.end();
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 1000); kill.unref();
    await closed;
    clearTimeout(kill);
  }
}

type CapabilityOptions = {
  health: () => Promise<ProviderHealth[]>;
  onChange: () => void;
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  timeoutMs?: number;
  read?: (provider: ProviderHealth, signal: AbortSignal) => Promise<Capabilities>;
};

/** In-memory cache with one bounded read per provider, including on initial load. */
export class ProviderCapabilities {
  private providers: ProviderHealth[];
  private stopped = false;
  private refreshing?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private failures = 0;
  constructor(initial: ProviderHealth[], private readonly options: CapabilityOptions) {
    this.providers = initial.map(provider => ({ ...provider, usage: { status: 'loading', windows: [] } }));
  }
  list(): ProviderHealth[] {
    const now = Date.now();
    return this.providers.map(provider => {
      const usage = provider.usage;
      const expired = usage?.windows.some(window => window.resetsAt && Date.parse(window.resetsAt) <= now);
      return { ...provider, ...(provider.models ? { models: provider.models.map(copyModel) } : {}),
        ...(provider.efforts ? { efforts: provider.efforts.map(effort => ({ ...effort })) } : {}),
        ...(usage ? { usage: { ...usage, windows: usage.windows.map(window => ({ ...window })), ...(expired ? { status: 'unavailable' as const, stale: true, reason: 'no_data' } : {}) } } : {}) };
    });
  }
  start(): void { void this.refresh(); }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    return this.refreshing ||= this.read().finally(() => {
      this.refreshing = undefined;
      if (!this.stopped) {
        this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, (this.options.intervalMs || 60_000) * Math.min(5, 2 ** this.failures));
        this.timer.unref();
      }
    });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
    await this.refreshing;
  }
  private async read(): Promise<void> {
    this.controller = new AbortController();
    const timeout = setTimeout(() => this.controller?.abort(), this.options.timeoutMs || 12_000); timeout.unref();
    const signal = this.controller.signal;
    try {
      const health = await this.options.health();
      const results = await Promise.all(health.map(async provider => {
        let capabilities: Capabilities;
        try {
          if (!provider.available || !provider.executable) capabilities = { usage: unavailable('not_supported') };
          else if (this.options.read) capabilities = await this.options.read(provider, signal);
          else if (provider.provider === 'codex') capabilities = await readCodexCapabilities(provider.executable, this.options.env || process.env, signal);
          else capabilities = { usage: await readClaudeUsage({ env: this.options.env, signal }), models: CLAUDE_MODELS.map(copyModel), efforts: CLAUDE_EFFORTS.map(effort => ({ ...effort })) };
        } catch { capabilities = { usage: unavailable('unreachable') }; }
        const previous = this.providers.find(item => item.provider === provider.provider);
        if (capabilities.usage?.status !== 'available' && !capabilities.usage?.windows.length && previous?.usage?.windows.length) {
          capabilities.usage = { ...capabilities.usage!, windows: previous.usage.windows, updatedAt: previous.usage.updatedAt, stale: true };
        }
        return { ...provider, ...(previous?.models ? { models: previous.models, defaultModel: previous.defaultModel, ...(previous.efforts ? { efforts: previous.efforts } : {}) } : {}), ...capabilities };
      }));
      if (!this.stopped) {
        this.providers = results;
        this.failures = results.some(provider => provider.usage?.status === 'error') ? this.failures + 1 : 0;
        this.options.onChange();
      }
    } catch {
      if (!this.stopped) {
        this.failures++;
        this.providers = this.providers.map(provider => ({ ...provider, usage: {
          ...unavailable('unreachable'), ...(provider.usage?.windows.length ? { windows: provider.usage.windows, updatedAt: provider.usage.updatedAt, stale: true } : {}),
        } }));
        this.options.onChange();
      }
    } finally { clearTimeout(timeout); this.controller = undefined; }
  }
}
