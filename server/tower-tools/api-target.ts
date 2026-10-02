import { isOperationName, OPERATIONS } from '../../shared/api/operations.js';

export interface ApiTarget {
  method: 'GET' | 'POST';
  /** The path as sent, query included. */
  path: string;
  /** The decoded path without query, as Tower's server matches it. */
  route: string;
  /** The joined computer the path goes to, if any. */
  node?: string;
  /** The route on that computer (or this one): `/api/...` without the node prefix. */
  local: string;
  write: boolean;
}

/** These routes accept new work; their successful response must say whether its caller was recorded. */
export function startsWork(target: ApiTarget): boolean {
  return target.method === 'POST' && (['/api/sessions', '/api/auto-prompts', '/api/v1/autoPrompt.submit'].includes(target.local)
    || /^\/api\/sessions\/[^/]+\/messages$/.test(target.local));
}

const NODE_PREFIX = /^\/api\/nodes\/([a-f0-9]{32})(\/.*)$/;
/** Not operations for an agent: sign-in, the page token, and live streams (read through their own tools). */
export const AGENT_REFUSED: readonly RegExp[] = [/^\/api\/auth\/(login|logout|status)$/, /^\/api\/bootstrap$/, /^\/api\/health$/, /^\/api\/events$/,
  /^\/api\/master\/events$/, /^\/api\/workspace\/terminals\/[^/]+\/events$/];
/** The master also keeps off its own routes. */
export const MASTER_REFUSED: readonly RegExp[] = [/^\/api\/master(\/|$)/, ...AGENT_REFUSED];
/** Provider request IDs are opaque and may hold an encoded slash; the server matches this route on the raw path. */
const APPROVAL = /^\/api\/(?:nodes\/[a-f0-9]{32}\/)?runs\/[^/]+\/approvals\/[^/]+$/;

/**
 * Checks a path the model gave and describes it the way Tower's server will see it. Anything that could be read
 * differently by the server (encoded slashes outside an approval's IDs, dot segments, doubled slashes) is refused.
 */
export function apiTarget(method: string, path: string, node?: string | null, refused: readonly RegExp[] = MASTER_REFUSED): ApiTarget {
  if (method !== 'GET' && method !== 'POST') throw refusal('GET 또는 POST만 쓸 수 있습니다.');
  if (typeof path !== 'string' || !path.startsWith('/api/') || /[\s\\]/.test(path) || path.includes('#')) throw refusal('경로는 /api/로 시작해야 합니다.');
  // Dot segments are refused as written, before URL parsing quietly resolves them.
  if (/\/(?:\.|%2e){1,2}(?:\/|\?|$)/i.test(path)) throw refusal('경로가 올바르지 않습니다.');
  const url = new URL(path, 'http://tower.invalid');
  const approval = APPROVAL.test(node ? `/api/nodes/${node}/${url.pathname.slice('/api/'.length)}` : url.pathname);
  if (/%2f|%5c/i.test(url.pathname) && !approval) throw refusal('경로에 인코딩된 구분자를 쓸 수 없습니다.');
  let route: string;
  try { route = approval ? url.pathname : decodeURIComponent(url.pathname); } catch { throw refusal('경로를 읽을 수 없습니다.'); }
  if (route.includes('//') || route.split('/').some(part => part === '.' || part === '..')) throw refusal('경로가 올바르지 않습니다.');
  let sent = `${url.pathname}${url.search}`;
  if (node) {
    if (!/^[a-f0-9]{32}$/.test(node)) throw refusal('연결된 컴퓨터 ID가 올바르지 않습니다.');
    if (NODE_PREFIX.test(route)) throw refusal('node와 /api/nodes 경로를 함께 쓸 수 없습니다.');
    route = `/api/nodes/${node}/${route.slice('/api/'.length)}`;
    sent = `/api/nodes/${node}/${sent.slice('/api/'.length)}`;
  }
  const scoped = NODE_PREFIX.exec(route);
  const local = scoped ? `/api${scoped[2]}` : route;
  if (refused.some(pattern => pattern.test(local)) || (scoped && /^\/api\/nodes\//.test(local))) throw refusal('이 경로는 도구로 부를 수 없습니다.');
  const operation = /^\/api\/v1\/([a-z]+\.[a-zA-Z]+)$/.exec(local)?.[1];
  const readOperation = operation !== undefined && isOperationName(operation) && !OPERATIONS[operation].write;
  const write = method === 'POST' && !readOperation && local !== '/api/auto-prompt-suggestions';
  return { method, path: sent, route, ...(scoped ? { node: scoped[1] } : {}), local, write };
}

function refusal(message: string) { return Object.assign(new Error(message), { statusCode: 400 }); }
