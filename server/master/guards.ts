import { isOperationName, OPERATIONS } from '../../shared/api/operations.js';
import type { MasterGuards } from '../../shared/master.js';

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
  irreversible: boolean;
}

const NODE_PREFIX = /^\/api\/nodes\/([a-f0-9]{32})(\/.*)$/;
/** Pages that exist only for someone at this computer, whatever device the owner uses. */
const LOCAL_ONLY = new Set(['/api/auth/overview', '/api/auth/credentials', '/api/auth/unblock', '/api/tower/update']);
/** Not operations: the master's own routes, sign-in, and live streams (read through their own tools). */
const REFUSED = [/^\/api\/master(\/|$)/, /^\/api\/auth\/(login|logout|status)$/, /^\/api\/bootstrap$/, /^\/api\/health$/, /^\/api\/events$/, /^\/api\/workspace\/terminals\/[^/]+\/events$/];
/** Changes that cannot simply be undone: stopping work, deleting, sending out, typing into shells, writing files. */
const IRREVERSIBLE = [
  /^\/api\/runs\/[^/]+\/cancel$/, /^\/api\/auto-prompts\/[^/]+\/cancel$/, /^\/api\/sessions\/[^/]+\/close$/, /^\/api\/workspace\/terminals\/[^/]+\/(close|input)$/,
  /^\/api\/workspace\/file$/, /^\/api\/repositories$/, /^\/api\/runs\/[^/]+\/approvals\//, /^\/api\/tower\/update$/, /^\/api\/link\//, /^\/api\/remote\/exclusions$/,
  /^\/api\/slack\/(connect|disconnect|replies\/approve)$/, /^\/api\/public-agents\/(delete|rotate|password|reset|delete-conversation)$/, /^\/api\/notifications\/remove$/,
  /^\/api\/v1\/(triggers\.delete|triggers\.run|triggers\.testHttp|secrets\.delete|github\.approveReply)$/,
];

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
  return { method, path: sent, route, ...(scoped ? { node: scoped[1] } : {}), local, write, irreversible: write && IRREVERSIBLE.some(pattern => pattern.test(local)) };
}

export interface TurnScope {
  /** Every owner input of this turn was typed on this computer itself. */
  local: boolean;
  cause: 'owner' | 'event';
  /** Irreversible calls already made this turn. */
  irreversible: number;
}

/** Why the call is not allowed under the owner's settings, or nothing when it may go. */
/** `affected` is how much work the call stops or removes, counted against the optional cap. */
export function refusalFor(guards: MasterGuards, turn: TurnScope, target: ApiTarget, affected = 1): string | undefined {
  if (guards.localOnlyPages && LOCAL_ONLY.has(target.local) && (target.node || !turn.local)) {
    return '계정 관리와 Tower 업데이트는 이 컴퓨터에서 직접 입력한 요청으로만 할 수 있습니다(설정에서 바꿀 수 있음).';
  }
  if (!target.write) return undefined;
  if (guards.eventTurnsReadOnly && turn.cause === 'event') return '끝난 작업의 보고 중에는 조회만 합니다(설정에서 바꿀 수 있음). 소유자에게 먼저 물어보세요.';
  if (target.node && guards.readOnlyNodes.includes(target.node)) return '이 컴퓨터는 마스터 설정에서 읽기 전용입니다.';
  if (target.irreversible && guards.maxIrreversiblePerTurn > 0 && turn.irreversible + affected > guards.maxIrreversiblePerTurn) {
    return `한 번에 되돌릴 수 없는 작업은 ${guards.maxIrreversiblePerTurn}개까지로 설정돼 있습니다. 나눠서 요청해 달라고 하세요.`;
  }
  return undefined;
}

function refusal(message: string) { return Object.assign(new Error(message), { statusCode: 400 }); }
