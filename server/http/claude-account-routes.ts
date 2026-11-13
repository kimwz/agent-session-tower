import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import { AccountError, type ClaudeAccounts } from '../providers/claude-accounts/accounts.js';
import type { ClaudeLogin } from '../providers/claude-accounts/login.js';
import { readJson } from './requests.js';

/** `unavailable`: why this Tower does not manage Claude accounts, or undefined when it does. */
export type ClaudeAccountRoutes = { accounts: ClaudeAccounts; login: ClaudeLogin; unavailable: () => string | undefined };
type Json = (res: ServerResponse, status: number, body: unknown) => void;
/** What changed, for a joined computer's record of what its controllers did: never an email, a code or a token. */
export type ClaudeAccountChange = 'switch' | 'remove' | 'add';

const PATH = /^\/api\/claude-accounts(?:\/(switch|remove|login\/start|login\/code|login\/cancel))?$/;
/** The account request a method and path name: `null` for the list, a change otherwise; undefined when it is none. */
export function claudeAccountRequest(method: string | undefined, path: string): string | null | undefined {
  const match = path.match(PATH);
  if (!match) return undefined;
  const action = match[1] ?? null;
  return (action === null && method === 'GET') || (action !== null && method === 'POST') ? action : undefined;
}

/** One account request, answered the same for this computer's own page and for a controller over the link. */
async function answer(action: string | null, readBody: () => Promise<unknown>, routes: ClaudeAccountRoutes): Promise<{ status: number; body: unknown; change?: ClaudeAccountChange }> {
  const off = routes.unavailable();
  const list = () => off ? { available: false, accounts: [], reason: off } : { available: true, accounts: routes.accounts.list(), ...(routes.login.status() ? { login: routes.login.status() } : {}) };
  try {
    if (action === null) return { status: 200, body: list() };
    const body = (await readBody() ?? {}) as Record<string, unknown>;
    if (off) return { status: 409, body: { error: off } };
    const id = typeof body.id === 'string' ? body.id : '';
    let change: ClaudeAccountChange | undefined;
    if (action === 'switch') { await routes.accounts.switchTo(id); change = 'switch'; }
    else if (action === 'remove') { await routes.accounts.remove(id); change = 'remove'; }
    else if (action === 'login/start') { await routes.login.start(); change = 'add'; }
    else if (action === 'login/code') {
      if (typeof body.code !== 'string') return { status: 400, body: { error: '코드를 입력하세요.' } };
      routes.login.submitCode(body.code);
    } else await routes.login.cancel();
    return { status: 200, body: list(), ...(change ? { change } : {}) };
  } catch (error) {
    // Account errors and Korean messages are written for the owner; anything else may carry details from the network.
    const forOwner = error instanceof AccountError || (error instanceof Error && /[가-힣]/.test(error.message));
    if (!(error instanceof AccountError)) console.warn(`[claude-accounts] ${action ?? 'list'} failed: ${error instanceof Error ? error.message : error}`);
    return { status: error instanceof AccountError ? error.status : forOwner ? 400 : 502, body: { error: forOwner ? (error as Error).message : 'Claude 계정 서비스에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.' } };
  }
}

/**
 * The saved Claude accounts of this computer, for the owner's own page only: switching changes which account every Claude run
 * here uses, and adding one takes a sign-in code. `allowed` is decided by the caller like the secret vault's screens.
 */
export async function claudeAccountRoute(req: IncomingMessage, res: ServerResponse, path: string, routes: ClaudeAccountRoutes | undefined, json: Json, allowed: boolean): Promise<boolean> {
  const action = claudeAccountRequest(req.method, path);
  if (action === undefined) return false;
  if (!allowed) { json(res, 403, { error: 'Claude 계정 관리는 소유자의 화면에서만 할 수 있습니다.' }); return true; }
  if (!routes) { json(res, 503, { error: 'Claude 계정 관리를 사용할 수 없습니다.' }); return true; }
  const result = await answer(action, () => readJson(req, 4096), routes);
  json(res, result.status, result.body);
  return true;
}

/**
 * The same requests from a paired controller over the link; the controller forwards them only from its owner's page.
 * Changes are recorded for this computer's owner.
 */
export async function claudeAccountLink(req: Http2ServerRequest, res: Http2ServerResponse, routes: ClaudeAccountRoutes | undefined, record: (change: ClaudeAccountChange) => void): Promise<boolean> {
  const path = new URL(req.url ?? '/', 'https://tower.invalid').pathname;
  const action = claudeAccountRequest(req.method, path);
  if (action === undefined) return false;
  const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (!routes) { reply(503, { error: 'Claude 계정 관리를 사용할 수 없습니다.' }); return true; }
  const result = await answer(action, () => readJson(req as unknown as IncomingMessage, 4096), routes);
  if (result.change) record(result.change);
  reply(result.status, result.body);
  return true;
}
