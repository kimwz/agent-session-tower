import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { GITHUB_API, type GitHubAuth, type GitHubCheck, type Trigger, type TriggerActor } from '../../shared/triggers.js';
import { findExecutable } from '../providers/discovery.js';
import { failure } from './errors.js';
import { GitHubError, refused, type GitHubFetch, type GitHubResponse } from './github.js';
import { performHttp } from './http.js';
import type { RequestBudget } from './outbound.js';
import type { SecretStore } from './secrets.js';

export interface GitHubAccessPorts {
  secrets: SecretStore;
  budget: RequestBudget;
  /** Secret id -> triggers the owner gave it to. */
  grants(): Record<string, string[]>;
  now: () => number;
  /** Reads the gh CLI's token; replaceable in tests. */
  ghToken?: () => Promise<string>;
  /** Sends GitHub API requests with this Authorization value; replaceable in tests, read at each use. */
  transport(): ((authorization: string) => GitHubFetch) | undefined;
  ownPorts?: () => Promise<number[]>;
  resolve?: Parameters<typeof performHttp>[2];
}

/**
 * Talking to GitHub as a trigger's account: its credential (a saved token, or the gh CLI's, read again every few minutes),
 * the account it acts as, and GitHub's rate limit per credential, all within the shared request budget.
 */
export class GitHubAccess {
  /** Tokens from the gh CLI, read again every few minutes; logins per token, so a changed account is noticed. */
  private ghToken?: { value: string; at: number };
  private readonly logins = new Map<string, { login: string; at: number }>();
  /** Per credential: GitHub's rate limit allows no request before this time. */
  private readonly githubBlocked = new Map<string, number>();
  constructor(private readonly ports: GitHubAccessPorts) {}

  /** The gh CLI's token is read again before the next request. */
  forgetGhToken(): void { this.ghToken = undefined; }

  /**
   * Requests to GitHub carry the credentials only to api.github.com, within the shared request budget.
   * `identity` names the credential itself, so a changed gh login is never taken for the account checked before.
   */
  async fetchFor(auth: GitHubAuth, triggerId?: string): Promise<{ fetch: GitHubFetch; identity: string }> {
    const token = await this.token(auth, triggerId);
    const authorization = /^\S+\s/.test(token) ? token : `Bearer ${token}`;
    const identity = createHash('sha256').update(authorization).digest('hex');
    // A used-up rate limit holds every trigger using this credential until it resets.
    const guard = (response: GitHubResponse): GitHubResponse => {
      if ((response.status === 403 || response.status === 429) && response.remaining === 0 && response.reset) this.githubBlocked.set(identity, response.reset * 1000);
      return response;
    };
    // Refused here, a request never left: `uncertain: false` tells a write that nothing was sent.
    const blocked = () => {
      const until = this.githubBlocked.get(identity);
      if (until !== undefined && until > this.ports.now()) throw Object.assign(new GitHubError(`GitHub's rate limit is used up until ${new Date(until).toISOString()}; checking resumes then.`, until), { uncertain: false });
    };
    if (this.ports.transport()) {
      const transport = this.ports.transport()!(authorization);
      return { identity, fetch: async (path, etag, send) => { blocked(); const over = this.ports.budget.spend(); if (over) throw Object.assign(new GitHubError(over), { uncertain: false }); return guard(await transport(path, etag, send)); } };
    }
    const ownPorts = await this.ports.ownPorts?.().catch(() => []) ?? [];
    return { identity, fetch: async (path, etag, send) => {
      blocked();
      const outcome = await performHttp({ method: send?.method ?? 'GET', url: `${GITHUB_API}${path}`, secretOrigin: GITHUB_API, secretHeaders: { authorization },
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(etag ? { 'if-none-match': etag } : {}), ...(send ? { 'content-type': 'application/json' } : {}) },
        // A write is never followed through a redirect: whatever answered it, the POST arrived and is not repeated.
        ...(send ? { body: JSON.stringify(send.body), noRedirects: true } : {}), timeoutMs: 30_000, maxBytes: 5_000_000, beforeSend: () => this.ports.budget.spend() }, { privateHosts: [], ownPorts }, this.ports.resolve);
      if (!outcome.ok) throw Object.assign(new GitHubError(outcome.error), { uncertain: outcome.uncertain });
      let body: unknown;
      try { body = outcome.status === 304 ? undefined : JSON.parse(outcome.body); } catch { body = undefined; }
      const number = (value: string | undefined) => value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
      const remaining = number(outcome.headers['x-ratelimit-remaining']);
      const reset = number(outcome.headers['x-ratelimit-reset']);
      // An ETag that echoed the credential is not kept.
      const tag = outcome.headers.etag && !outcome.headers.etag.includes('[secret removed]') ? outcome.headers.etag : undefined;
      return guard({ status: outcome.status, body, truncated: outcome.truncated, ...(tag ? { etag: tag } : {}),
        ...(remaining !== undefined ? { remaining } : {}), ...(reset !== undefined ? { reset } : {}) });
    } };
  }

  /**
   * GitHub access for a trigger's coordinator conversation: the trigger's own credentials (also after it is
   * deleted, while it can be restored), and only while they still act as the trigger's account.
   */
  async clientFor(trigger: Trigger | undefined, fresh = false): Promise<GitHubFetch> {
    if (!trigger || trigger.source.kind !== 'github') throw new GitHubError('This GitHub trigger no longer exists.');
    // For a write, the credential and its account are read again: what is checked is what posts.
    if (fresh && trigger.source.auth.type === 'gh') this.ghToken = undefined;
    const { fetch, identity } = await this.fetchFor(trigger.source.auth, trigger.id);
    const login = await this.login(fetch, identity, fresh);
    if (login.toLowerCase() !== trigger.source.account.toLowerCase()) throw new GitHubError(`GitHub is signed in as ${login}, not ${trigger.source.account}; nothing was sent.`);
    return fetch;
  }

  /** The account a credential acts as, looked up again every ten minutes and whenever the credential changes. */
  async login(fetch: GitHubFetch, identity: string, fresh = false): Promise<string> {
    const known = this.logins.get(identity);
    if (!fresh && known && Date.now() - known.at < 10 * 60_000) return known.login;
    const response = await fetch('/user');
    refused(response);
    const login = response.status === 200 && response.body && typeof response.body === 'object' ? (response.body as { login?: unknown }).login : undefined;
    if (typeof login !== 'string' || !login) throw new GitHubError(`GitHub did not say which account this is (HTTP ${response.status}).`);
    if (this.logins.size > 20) this.logins.clear();
    this.logins.set(identity, { login, at: Date.now() });
    return login;
  }

  private async token(auth: GitHubAuth, triggerId?: string): Promise<string> {
    if (auth.type === 'token') {
      const secret = this.ports.secrets.get(auth.secretId);
      if (!secret || secret.origin !== GITHUB_API) throw new GitHubError('The GitHub token secret is missing or is not saved for https://api.github.com.');
      if (triggerId && !(this.ports.grants()[secret.id] ?? []).includes(triggerId)) throw new GitHubError('The owner has not given this trigger the GitHub token secret.');
      return secret.value;
    }
    if (this.ghToken && Date.now() - this.ghToken.at < 5 * 60_000) return this.ghToken.value;
    const value = await (this.ports.ghToken ?? readGhToken)();
    this.ghToken = { value, at: Date.now() };
    return value;
  }

  /** Shows the owner which account a connection acts as. Nothing is recorded. */
  async check(auth: GitHubAuth, actor: TriggerActor): Promise<GitHubCheck> {
    if (actor.kind !== 'owner') throw failure('Only the owner can check GitHub connections.', 403);
    try {
      if (auth.type === 'gh') this.ghToken = undefined;
      const { fetch, identity } = await this.fetchFor(auth);
      const login = await this.login(fetch, identity, true);
      return { ok: true, login };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

/** The GitHub CLI's token for github.com. Nothing is cached on disk by Tower. */
export async function readGhToken(): Promise<string> {
  const gh = await findExecutable('gh');
  if (!gh) throw new GitHubError('The GitHub CLI (gh) was not found. Install it and run gh auth login, or use a saved token.');
  return new Promise((resolve, reject) => execFile(gh, ['auth', 'token', '--hostname', 'github.com'], { timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
    const token = String(stdout).trim();
    if (error || !token) reject(new GitHubError('gh is not signed in to github.com. Run gh auth login on this computer.'));
    else resolve(token);
  }));
}
