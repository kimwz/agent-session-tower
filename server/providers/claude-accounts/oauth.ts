/**
 * The two Anthropic OAuth calls Tower makes for saved Claude accounts, shaped like Claude Code's own: renewing a saved
 * account's token, and asking whose sign-in a token is. Bodies are bounded and never echoed; only typed values leave.
 */
type Json = Record<string, unknown>;
const object = (value: unknown): Json | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const MAX_BODY = 256 * 1024;
// Claude Code's public OAuth client, used when a stored sign-in does not name its own.
export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';

export type OAuthFetch = typeof fetch;
/** `rejected`: the server refused the refresh token (signed out elsewhere, expired); a new sign-in is needed. */
export class OAuthRejected extends Error { constructor() { super('The saved Claude sign-in was refused; sign in again.'); this.name = 'OAuthRejected'; } }

async function bodyOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_BODY) throw new Error('OAuth answer too large');
  return JSON.parse(text);
}

/**
 * Renews a stored `claudeAiOauth` record and returns the next one: the same fields with the new tokens and expiry.
 * The answered refresh token replaces the old one (they rotate); the caller must save the result before using it.
 */
export async function refreshClaudeOAuth(oauth: Json, options: { fetch?: OAuthFetch; signal?: AbortSignal; now?: () => number } = {}): Promise<Json> {
  const refreshToken = oauth.refreshToken;
  if (typeof refreshToken !== 'string' || !refreshToken) throw new OAuthRejected();
  const scopes = Array.isArray(oauth.scopes) ? oauth.scopes.filter((scope): scope is string => typeof scope === 'string') : [];
  const response = await (options.fetch || fetch)(TOKEN_URL, {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(15_000)]),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: typeof oauth.clientId === 'string' && oauth.clientId ? oauth.clientId : CLAUDE_CODE_CLIENT_ID, ...(scopes.length ? { scope: scopes.join(' ') } : {}) }),
  });
  if (response.status === 400 || response.status === 401) { await response.body?.cancel(); throw new OAuthRejected(); }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`OAuth refresh failed (${response.status})`); }
  const body = object(await bodyOf(response));
  const accessToken = body?.access_token;
  const expiresIn = body?.expires_in;
  if (typeof accessToken !== 'string' || !accessToken || /[\r\n]/.test(accessToken) || typeof expiresIn !== 'number' || !(expiresIn > 0)) throw new Error('OAuth refresh answer is malformed');
  const nextRefresh = typeof body?.refresh_token === 'string' && body.refresh_token ? body.refresh_token : refreshToken;
  const nextScopes = typeof body?.scope === 'string' && body.scope.trim() ? body.scope.trim().split(/\s+/) : oauth.scopes;
  return { ...oauth, accessToken, refreshToken: nextRefresh, expiresAt: (options.now ? options.now() : Date.now()) + expiresIn * 1000, ...(nextScopes ? { scopes: nextScopes } : {}) };
}

/** Whose sign-in a token is: account and organization, as Anthropic answers. */
export type ClaudeProfile = { accountUuid: string; email: string; displayName?: string; organizationUuid: string; organizationName?: string };
const text = (value: unknown, max = 320): string | undefined => typeof value === 'string' && value && value.length <= max && !/[\r\n]/.test(value) ? value : undefined;

export async function fetchClaudeProfile(token: string, options: { fetch?: OAuthFetch; signal?: AbortSignal } = {}): Promise<ClaudeProfile> {
  const response = await (options.fetch || fetch)(PROFILE_URL, {
    method: 'GET', redirect: 'error', signal: AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(10_000)]),
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
  });
  if (response.status === 401) { await response.body?.cancel(); throw new OAuthRejected(); }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Claude profile request failed (${response.status})`); }
  const body = object(await bodyOf(response));
  const account = object(body?.account);
  const organization = object(body?.organization);
  const accountUuid = text(account?.uuid, 64);
  const email = text(account?.email);
  const organizationUuid = text(organization?.uuid, 64);
  if (!accountUuid || !email || !organizationUuid) throw new Error('Claude profile answer is malformed');
  const displayName = text(account?.display_name ?? account?.displayName, 200);
  const organizationName = text(organization?.name, 200);
  return { accountUuid, email, organizationUuid, ...(displayName ? { displayName } : {}), ...(organizationName ? { organizationName } : {}) };
}
