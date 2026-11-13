import type { IncomingMessage, ServerResponse } from 'node:http';
import { AccountError, type ClaudeAccounts } from '../providers/claude-accounts/accounts.js';
import type { ClaudeLogin } from '../providers/claude-accounts/login.js';
import { readJson } from './requests.js';

export type ClaudeAccountRoutes = { accounts: ClaudeAccounts; login: ClaudeLogin; available: () => boolean };
type Json = (res: ServerResponse, status: number, body: unknown) => void;

/**
 * The saved Claude accounts of this computer, for the owner's own page only: switching changes which account every Claude run
 * here uses, and adding one takes a sign-in code. `allowed` is decided by the caller like the secret vault's screens.
 */
export async function claudeAccountRoute(req: IncomingMessage, res: ServerResponse, path: string, routes: ClaudeAccountRoutes | undefined, json: Json, allowed: boolean): Promise<boolean> {
  const match = path.match(/^\/api\/claude-accounts(?:\/(switch|remove|login\/start|login\/code|login\/cancel))?$/);
  if (!match) return false;
  const action = match[1];
  if ((action === undefined && req.method !== 'GET') || (action !== undefined && req.method !== 'POST')) return false;
  if (!allowed) { json(res, 403, { error: 'Claude 계정 관리는 소유자의 화면에서만 할 수 있습니다.' }); return true; }
  if (!routes) { json(res, 503, { error: 'Claude 계정 관리를 사용할 수 없습니다.' }); return true; }
  const answer = () => ({ available: routes.available(), accounts: routes.accounts.list(), ...(routes.login.status() ? { login: routes.login.status() } : {}) });
  try {
    if (action === undefined) { json(res, 200, answer()); return true; }
    const body = await readJson(req, 4096) as Record<string, unknown>;
    if (!routes.available()) { json(res, 409, { error: '이 컴퓨터의 Claude는 환경 변수의 로그인을 쓰고 있어 계정을 전환할 수 없습니다.' }); return true; }
    const id = typeof body.id === 'string' ? body.id : '';
    if (action === 'switch') await routes.accounts.switchTo(id);
    else if (action === 'remove') await routes.accounts.remove(id);
    else if (action === 'login/start') await routes.login.start();
    else if (action === 'login/code') {
      if (typeof body.code !== 'string') { json(res, 400, { error: '코드를 입력하세요.' }); return true; }
      routes.login.submitCode(body.code);
    } else await routes.login.cancel();
    json(res, 200, answer());
  } catch (error) {
    // Account errors and Korean messages are written for the owner; anything else may carry details from the network.
    const forOwner = error instanceof AccountError || (error instanceof Error && /[가-힣]/.test(error.message));
    json(res, error instanceof AccountError ? error.status : forOwner ? 400 : 502, { error: forOwner ? (error as Error).message : 'Claude 계정 서비스에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.' });
    if (!(error instanceof AccountError)) console.warn(`[claude-accounts] ${action ?? 'list'} failed: ${error instanceof Error ? error.message : error}`);
  }
  return true;
}
