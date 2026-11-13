import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClaudeAccountSummary, ProviderUsage, UsageWindow } from '../../../shared/types.js';
import { readPrivateJson, writePrivateJson } from '../../stores/private-json.js';
import { accountOf, credentialOf, readClaudeUsage, type ClaudeCredential } from '../capabilities.js';
import { fetchClaudeProfile, OAuthRejected, refreshClaudeOAuth, type ClaudeProfile, type OAuthFetch } from './oauth.js';
import { oauthOf, readClaudeStore, readOAuthAccount, removeClaudeStore, writeClaudeOAuth, writeOAuthAccount, type Keychain } from './storage.js';

/**
 * The Claude accounts this computer keeps for switching. Each saved account has its own Claude Code store (a config folder
 * under the state directory: its keychain item or `.credentials.json`, and `.claude.json` with its profile). The account
 * signed in now lives in Claude Code's default store, which belongs to Claude Code: Tower only copies it into the saved
 * account's store, and never renews or reads usage through that copy while the account is the active one, because Claude
 * Code rotates its refresh token. An inactive account's copy belongs to Tower, which renews it to read its usage.
 */
type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const REGISTRY = 'accounts.json';
// Inactive accounts are read this often; Anthropic's usage endpoint answers 429 readily.
const POLL_INTERVAL = 5 * 60_000;
const RATE_LIMIT_WAIT = 15 * 60_000;
// A token this close to its expiry is renewed before use.
const EXPIRY_MARGIN = 5 * 60_000;
// After a sign-in could not be saved, it is tried again this much later.
const SYNC_RETRY = 30 * 60_000;

export type SavedClaudeAccount = {
  id: string; accountUuid: string; organizationUuid: string; email: string;
  displayName?: string; organizationName?: string; plan?: string; addedAt: string;
  usage?: { windows: UsageWindow[]; updatedAt: string };
  /** The saved sign-in was refused: only a new sign-in brings it back. */
  problem?: 'sign_in_again';
};
export type ClaudeAccountView = ClaudeAccountSummary;

export class AccountError extends Error { constructor(message: string, readonly status = 409) { super(message); this.name = 'AccountError'; } }

export type ClaudeAccountsOptions = {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  keychain?: Keychain;
  fetch?: OAuthFetch;
  now?: () => number;
  /** The meter's newest Claude reading, kept as the active account's usage. */
  onChange: () => void;
  /** Asks the meter to read the (new) active account at once. */
  refreshMeter?: () => void;
  home?: string;
};

const ID = /^[a-f0-9]{12}$/;
const planId = (value: unknown): string | undefined => typeof value === 'string' && /^[a-z0-9_]{1,40}$/.test(value) ? value : undefined;
const sameIdentity = (account: Pick<SavedClaudeAccount, 'accountUuid' | 'organizationUuid'>, profile: Pick<ClaudeProfile, 'accountUuid' | 'organizationUuid'>) =>
  account.accountUuid === profile.accountUuid && account.organizationUuid === profile.organizationUuid;

function parseRegistry(value: unknown): SavedClaudeAccount[] {
  const list = Array.isArray(object(value)?.accounts) ? object(value)!.accounts as unknown[] : [];
  const accounts: SavedClaudeAccount[] = [];
  for (const item of list.slice(0, 50)) {
    const entry = object(item);
    if (!entry || typeof entry.id !== 'string' || !ID.test(entry.id) || typeof entry.accountUuid !== 'string' || typeof entry.organizationUuid !== 'string'
      || typeof entry.email !== 'string' || typeof entry.addedAt !== 'string') continue;
    const usage = object(entry.usage);
    accounts.push({ id: entry.id, accountUuid: entry.accountUuid, organizationUuid: entry.organizationUuid, email: entry.email, addedAt: entry.addedAt,
      ...(typeof entry.displayName === 'string' ? { displayName: entry.displayName } : {}),
      ...(typeof entry.organizationName === 'string' ? { organizationName: entry.organizationName } : {}),
      ...(planId(entry.plan) ? { plan: entry.plan as string } : {}),
      ...(usage && Array.isArray(usage.windows) && typeof usage.updatedAt === 'string' ? { usage: { windows: usage.windows as UsageWindow[], updatedAt: usage.updatedAt } } : {}),
      ...(entry.problem === 'sign_in_again' ? { problem: 'sign_in_again' as const } : {}) });
  }
  return accounts;
}

export class ClaudeAccounts {
  private accounts: SavedClaudeAccount[] = [];
  private readonly loaded: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  /** The saved account Claude Code's default store holds now; undefined until known. */
  private activeId?: string;
  /** Fingerprint of the default store's sign-in the last sync settled. */
  private settled?: string;
  private usageReasons = new Map<string, ProviderUsage['reason']>();
  /** A sign-in whose saving failed, and when to try again: no profile request and warning every minute meanwhile. */
  private failed?: { fingerprint: string; until: number };
  private waitUntil = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private stopping = new AbortController();

  constructor(private readonly options: ClaudeAccountsOptions) {
    this.loaded = this.load();
  }

  get directory(): string { return join(this.options.stateDir, 'claude-accounts'); }
  accountDirectory(id: string): string { return join(this.directory, id); }
  private now(): number { return this.options.now ? this.options.now() : Date.now(); }
  private get env(): NodeJS.ProcessEnv { return this.options.env || process.env; }
  /** The environment that points Claude Code (and Tower's store reader) at a saved account's own store. */
  accountEnv(id: string): NodeJS.ProcessEnv {
    return { ...this.env, CLAUDE_CONFIG_DIR: this.accountDirectory(id), CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined };
  }
  private storeOptions(env: NodeJS.ProcessEnv) {
    return { env, ...(this.options.platform ? { platform: this.options.platform } : {}), ...(this.options.keychain ? { keychain: this.options.keychain } : {}) };
  }

  private async load(): Promise<void> {
    try { this.accounts = parseRegistry(await readPrivateJson(join(this.directory, REGISTRY), 1_000_000)); }
    catch { this.accounts = []; }
  }
  private async save(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writePrivateJson(join(this.directory, REGISTRY), JSON.stringify({ version: 1, accounts: this.accounts }));
  }
  /** One account change at a time: syncs, switches, sign-ins, removals and usage reads never interleave. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => { await this.loaded; return work(); });
    this.queue = next.catch(() => {}); // best-effort: each caller gets its own error; the queue only keeps the order.
    return next;
  }

  list(): ClaudeAccountView[] {
    return this.accounts.map(({ accountUuid: _a, organizationUuid: _o, ...account }) => {
      // A refused sign-in makes its last usage an earlier reading too.
      const reason = account.problem ? 'not_signed_in' : this.usageReasons.get(account.id);
      return { ...account, active: account.id === this.activeId, ...(account.usage ? { usage: { windows: account.usage.windows.map(window => ({ ...window })), updatedAt: account.usage.updatedAt } } : {}),
        ...(reason ? { reason, stale: true } : {}) };
    });
  }

  /**
   * Called after each meter reading of the default store. A new sign-in there is identified once and saved (or its saved copy
   * updated); the reading itself is kept as the active account's usage.
   */
  observe(credential: ClaudeCredential, usage?: ProviderUsage): void {
    if (this.stopped || !credential.stored || !credential.account) return;
    void this.exclusive(async () => {
      if (credential.account !== this.settled) await this.sync();
      const active = this.accounts.find(account => account.id === this.activeId);
      if (active && credential.account === this.settled && usage?.status === 'available' && usage.windows.length && usage.updatedAt) {
        active.usage = { windows: usage.windows.map(window => ({ ...window })), updatedAt: usage.updatedAt };
        this.usageReasons.delete(active.id);
        await this.save();
        this.options.onChange();
      }
    }).catch(error => console.warn(`[claude-accounts] could not save the signed-in Claude account: ${error instanceof Error ? error.message : error}`));
  }

  /** Identifies the default store's sign-in and keeps its saved copy current; saves it when it is new. Runs exclusively. */
  private async sync(): Promise<void> {
    const reading = await readClaudeStore(this.storeOptions(this.env));
    const oauth = oauthOf(reading);
    const credential = credentialOf(oauth, this.now());
    if (!oauth || !credential.account) { this.activeId = undefined; this.settled = undefined; return; }
    if (credential.account === this.settled) return;
    // The sign-in in use is unknown until this one is identified; a later return to a known one is then looked at again.
    if (this.failed?.fingerprint === credential.account && this.now() < this.failed.until) { this.activeId = undefined; this.settled = undefined; return; }
    try { await this.identify(oauth, credential); }
    catch (error) {
      this.activeId = undefined;
      this.settled = undefined;
      this.failed = { fingerprint: credential.account, until: this.now() + SYNC_RETRY };
      throw error;
    }
  }

  private async identify(oauth: Json, credential: ClaudeCredential): Promise<void> {
    // A copy with the same refresh token is the same sign-in, even when its access token has expired.
    let saved: SavedClaudeAccount | undefined;
    for (const account of this.accounts) {
      const stored = oauthOf(await readClaudeStore(this.storeOptions(this.accountEnv(account.id))));
      if (stored && typeof stored.refreshToken === 'string' && stored.refreshToken === oauth.refreshToken) { saved = account; break; }
    }
    if (!saved) {
      // Unknown and not usable now (expired): Claude Code renews it on its next run; identify it then.
      if (!credential.token) { this.activeId = undefined; this.settled = undefined; return; }
      const profile = await fetchClaudeProfile(credential.token, { ...(this.options.fetch ? { fetch: this.options.fetch } : {}), signal: this.stopping.signal });
      saved = this.accounts.find(account => sameIdentity(account, profile));
      if (saved) Object.assign(saved, this.describe(profile, oauth));
      else {
        saved = { id: randomBytes(6).toString('hex'), accountUuid: profile.accountUuid, organizationUuid: profile.organizationUuid, addedAt: new Date(this.now()).toISOString(), ...this.describe(profile, oauth) };
        await this.createStore(saved.id);
        const current = await readOAuthAccount(this.env, this.options.home);
        await writeOAuthAccount(current && current.accountUuid === profile.accountUuid && current.organizationUuid === profile.organizationUuid ? current : minimalOAuthAccount(profile),
          this.accountEnv(saved.id), this.options.home);
        this.accounts.push(saved);
      }
      await writeClaudeOAuth(oauth, this.storeOptions(this.accountEnv(saved.id)));
      delete saved.problem;
      this.usageReasons.delete(saved.id);
      await this.save();
    }
    this.activeId = saved.id;
    this.settled = credential.account;
    this.failed = undefined;
    this.options.onChange();
  }

  /** Identifies the sign-in in use now, for an owner's action; refuses the action when it is there but cannot be identified. */
  private async settleActive(refused: string): Promise<void> {
    this.settled = undefined;
    this.failed = undefined;
    let error: unknown;
    try { await this.sync(); } catch (caught) { error = caught; }
    if (this.activeId || !oauthOf(await readClaudeStore(this.storeOptions(this.env)))) return;
    if (error) console.warn(`[claude-accounts] the Claude sign-in in use could not be identified: ${error instanceof Error ? error.message : error}`);
    throw new AccountError(`지금 로그인된 Claude 계정을 확인하지 못해 ${refused} 않았습니다. 잠시 뒤 다시 시도하세요.`);
  }

  private describe(profile: ClaudeProfile, oauth: Json): Pick<SavedClaudeAccount, 'email' | 'displayName' | 'organizationName' | 'plan'> {
    const plan = planId(oauth.subscriptionType);
    return { email: profile.email, ...(profile.displayName ? { displayName: profile.displayName } : {}), ...(profile.organizationName ? { organizationName: profile.organizationName } : {}), ...(plan ? { plan } : {}) };
  }
  private async createStore(id: string): Promise<void> {
    await mkdir(this.accountDirectory(id), { recursive: true, mode: 0o700 });
  }

  /** A saved account's usable sign-in, renewed (and saved) first when it is about to expire. Only for inactive accounts. */
  private async inactiveCredential(account: SavedClaudeAccount): Promise<{ oauth: Json; credential: ClaudeCredential }> {
    if (account.id === this.activeId) throw new Error('The active account belongs to Claude Code.');
    const env = this.accountEnv(account.id);
    let oauth = oauthOf(await readClaudeStore(this.storeOptions(env)));
    if (!oauth) { account.problem = 'sign_in_again'; await this.save(); throw new AccountError('저장된 로그인 정보를 찾지 못했습니다. 다시 로그인하세요.'); }
    if (typeof oauth.expiresAt !== 'number' || oauth.expiresAt - EXPIRY_MARGIN <= this.now()) {
      try { oauth = await refreshClaudeOAuth(oauth, { ...(this.options.fetch ? { fetch: this.options.fetch } : {}), signal: this.stopping.signal, now: () => this.now() }); }
      catch (error) {
        if (error instanceof OAuthRejected) { account.problem = 'sign_in_again'; await this.save(); this.options.onChange(); throw new AccountError('이 계정의 로그인이 만료되었습니다. 다시 로그인하세요.'); }
        throw error;
      }
      // The answered refresh token replaced the old one: keep it before anything else can fail.
      await writeClaudeOAuth(oauth, this.storeOptions(env));
    }
    return { oauth, credential: credentialOf(oauth, this.now()) };
  }

  /** Makes `id` the account Claude Code signs in with on this computer, from its next start (or token renewal) on. */
  switchTo(id: string): Promise<ClaudeAccountView[]> {
    return this.exclusive(async () => {
      const target = this.accounts.find(account => account.id === id);
      if (!target) throw new AccountError('저장된 계정이 아닙니다.', 404);
      // The account signed in now must be saved first, or switching would lose it.
      await this.settleActive('전환하지');
      if (this.activeId === id) return this.list();
      const { oauth } = await this.inactiveCredential(target);
      await writeClaudeOAuth(oauth, this.storeOptions(this.env));
      const profile = await readOAuthAccount(this.accountEnv(id), this.options.home);
      if (profile) {
        try { await writeOAuthAccount(profile, this.env, this.options.home); }
        catch (error) { console.warn(`[claude-accounts] the sign-in switched, but Claude Code's profile was not updated: ${error instanceof Error ? error.message : error}`); }
      }
      // Claude Code renewing the earlier account's token in the same instant writes it back; say so instead of claiming the switch.
      const written = oauthOf(await readClaudeStore(this.storeOptions(this.env)));
      if (written?.refreshToken !== oauth.refreshToken) {
        this.settled = undefined;
        throw new AccountError('전환하는 중 Claude가 이전 계정의 로그인을 갱신했습니다. 다시 시도하세요.');
      }
      const previous = this.activeId;
      this.activeId = id;
      this.settled = accountOf(oauth.refreshToken as string);
      delete target.problem;
      // The earlier account's last meter reading stays as its usage until the next poll.
      if (previous) this.usageReasons.delete(previous);
      await this.save();
      this.options.onChange();
      this.options.refreshMeter?.();
      return this.list();
    });
  }

  remove(id: string): Promise<ClaudeAccountView[]> {
    return this.exclusive(async () => {
      const index = this.accounts.findIndex(account => account.id === id);
      if (index < 0) throw new AccountError('저장된 계정이 아닙니다.', 404);
      // A terminal `/login` since the last meter reading may have made this one the account in use: look again first.
      await this.settleActive('지우지');
      if (id === this.activeId) throw new AccountError('지금 쓰고 있는 계정은 다른 계정으로 전환한 뒤에 지울 수 있습니다.');
      await removeClaudeStore(this.accountDirectory(id), { ...(this.options.platform ? { platform: this.options.platform } : {}), ...(this.options.keychain ? { keychain: this.options.keychain } : {}) });
      this.accounts.splice(index, 1);
      this.usageReasons.delete(id);
      await this.save();
      this.options.onChange();
      return this.list();
    });
  }

  /**
   * Takes a finished sign-in from a folder `claude auth login` wrote, as a saved account. The same account signed in again
   * replaces its earlier copy (and clears a sign-in problem); the account in use now is left to Claude Code.
   */
  adopt(directory: string): Promise<ClaudeAccountView> {
    return this.exclusive(async () => {
      const env = { ...this.env, CLAUDE_CONFIG_DIR: directory, CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined };
      const oauth = oauthOf(await readClaudeStore(this.storeOptions(env)));
      const credential = credentialOf(oauth, this.now());
      if (!oauth || !credential.token) throw new AccountError('로그인은 끝났지만 저장된 로그인 정보를 찾지 못했습니다.', 500);
      const profile = await fetchClaudeProfile(credential.token, { ...(this.options.fetch ? { fetch: this.options.fetch } : {}), signal: this.stopping.signal });
      const existing = this.accounts.find(account => sameIdentity(account, profile));
      if (existing && existing.id === this.activeId) throw new AccountError(`${profile.email}은(는) 지금 쓰고 있는 계정입니다.`);
      const account: SavedClaudeAccount = existing ?? { id: randomBytes(6).toString('hex'), accountUuid: profile.accountUuid, organizationUuid: profile.organizationUuid, addedAt: new Date(this.now()).toISOString(), email: profile.email };
      Object.assign(account, this.describe(profile, oauth));
      delete account.problem;
      await this.createStore(account.id);
      await writeClaudeOAuth(oauth, this.storeOptions(this.accountEnv(account.id)));
      await writeOAuthAccount((await readOAuthAccount(env, this.options.home)) ?? minimalOAuthAccount(profile), this.accountEnv(account.id), this.options.home);
      if (!existing) this.accounts.push(account);
      this.usageReasons.delete(account.id);
      this.waitUntil.delete(account.id);
      await this.save();
      this.options.onChange();
      void this.poll();
      return this.list().find(item => item.id === account.id)!;
    });
  }

  start(): void {
    const tick = () => { this.timer = setTimeout(() => { void this.poll().finally(() => { if (!this.stopped) tick(); }); }, POLL_INTERVAL); this.timer.unref?.(); };
    tick();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.stopping.abort();
    await this.queue.catch(() => {}); // best-effort: stopping only waits for the work in hand; its caller saw its error.
  }

  /** Reads every inactive account's usage, renewing its own token when needed. Skipped while the active account is unknown. */
  poll(): Promise<void> {
    return this.exclusive(async () => {
      if (this.stopped) return;
      // A `/login` since the last meter reading may have made a saved account the active one: look again first.
      await this.sync();
      // Until the default store's sign-in is known, any saved copy could be the one Claude Code is using.
      if (!this.activeId) return;
      let changed = false;
      for (const account of this.accounts) {
        if (account.id === this.activeId || account.problem || (this.waitUntil.get(account.id) ?? 0) > this.now()) continue;
        let usage: ProviderUsage;
        try {
          const { credential } = await this.inactiveCredential(account);
          usage = await readClaudeUsage({ env: this.accountEnv(account.id), signal: this.stopping.signal, credential, now: () => this.now(), ...(this.options.fetch ? { fetch: this.options.fetch } : {}) });
        } catch (error) {
          changed = true;
          if (!(error instanceof AccountError)) this.usageReasons.set(account.id, 'unreachable');
          continue;
        }
        changed = true;
        if (usage.status === 'available') {
          account.usage = { windows: usage.windows, updatedAt: usage.updatedAt || new Date(this.now()).toISOString() };
          this.usageReasons.delete(account.id);
        } else {
          this.usageReasons.set(account.id, usage.reason);
          if (usage.reason === 'rate_limited') this.waitUntil.set(account.id, this.now() + RATE_LIMIT_WAIT);
        }
      }
      if (changed) { await this.save(); this.options.onChange(); }
    }).catch(error => console.warn(`[claude-accounts] usage poll failed: ${error instanceof Error ? error.message : error}`));
  }
}

/** The profile Claude Code needs to show who is signed in, when no fuller record is at hand; it completes it itself. */
function minimalOAuthAccount(profile: ClaudeProfile): Json {
  return { accountUuid: profile.accountUuid, emailAddress: profile.email, organizationUuid: profile.organizationUuid,
    ...(profile.organizationName ? { organizationName: profile.organizationName } : {}), ...(profile.displayName ? { displayName: profile.displayName } : {}) };
}
