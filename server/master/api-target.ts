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

const NODE_PREFIX = /^\/api\/nodes\/([a-f0-9]{32})(\/.*)$/;
/** Not operations: the master's own routes, sign-in, and live streams (read through their own tools). */
const REFUSED = [/^\/api\/master(\/|$)/, /^\/api\/auth\/(login|logout|status)$/, /^\/api\/bootstrap$/, /^\/api\/health$/, /^\/api\/events$/, /^\/api\/workspace\/terminals\/[^/]+\/events$/];
/**
 * Checks a path the model gave and describes it the way Tower's server will see it. Anything that could be read
 * differently by the server (encoded slashes, dot segments, doubled slashes) is refused.
 */
export function apiTarget(method: string, path: string, node?: string | null): ApiTarget {
  if (method !== 'GET' && method !== 'POST') throw refusal('GET 또는 POST만 쓸 수 있습니다.');
  if (typeof path !== 'string' || !path.startsWith('/api/') || /[\s\\]/.test(path) || path.includes('#')) throw refusal('경로는 /api/로 시작해야 합니다.');
  // Dot segments are refused as written, before URL parsing quietly resolves them.
  if (/\/(?:\.|%2e){1,2}(?:\/|\?|$)/i.test(path)) throw refusal('경로가 올바르지 않습니다.');
  const url = new URL(path, 'http://tower.invalid');
  if (/%2f|%5c/i.test(url.pathname)) throw refusal('경로에 인코딩된 구분자를 쓸 수 없습니다.');
  let route: string;
  try { route = decodeURIComponent(url.pathname); } catch { throw refusal('경로를 읽을 수 없습니다.'); }
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
  if (REFUSED.some(pattern => pattern.test(local)) || (scoped && /^\/api\/nodes\//.test(local))) throw refusal('이 경로는 마스터가 부를 수 없습니다.');
  const operation = /^\/api\/v1\/([a-z]+\.[a-zA-Z]+)$/.exec(local)?.[1];
  const readOperation = operation !== undefined && isOperationName(operation) && !OPERATIONS[operation].write;
  const write = method === 'POST' && !readOperation && local !== '/api/auto-prompt-suggestions';
  return { method, path: sent, route, ...(scoped ? { node: scoped[1] } : {}), local, write };
}

function refusal(message: string) { return Object.assign(new Error(message), { statusCode: 400 }); }
