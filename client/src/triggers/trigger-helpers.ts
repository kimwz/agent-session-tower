import { createContext } from 'react';
import type { Trigger, TriggerAuditEntry, TriggerEvent, TriggerInput } from '../../../shared/triggers';
import { isOperationName, OPERATIONS } from '../../../shared/api/operations';
import { REQUEST_TOKEN_HEADER } from '../../../shared/app-identity';
import { authPost } from '../auth/AuthGate';
import { api } from '../common/lib';
import { forgetRequest, nodeHeaders, nodePath, settleRequest } from '../remote/scope';

export type Source = TriggerInput['source'];
export type SourceKind = Source['kind'];
export type HttpSource = Extract<Source, { kind: 'http' }>;
export type GitHubSource = Extract<Source, { kind: 'github' }>;
export type TaskHandler = Extract<TriggerInput['handler'], { kind: 'task' }>;
export type CoordinatorHandler = Extract<TriggerInput['handler'], { kind: 'coordinator' }>;
type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The computer whose triggers the panel shows: this one (no node), or a joined one by its node id and name. Its
 * triggers run there, and the parts that stay with that computer (secrets, limits, tests) are done there.
 */
export const TriggerMachine = createContext<{ node?: string; name?: string }>({});

/**
 * Calls a Tower operation (shared/api/operations.ts) as the owner, on this computer or on joined computer `node`.
 * A change on another computer carries a request ID, so sending it again after a lost answer makes it once. Once that
 * computer answers that it cannot tell whether an earlier send was carried out, the owner has been told to check
 * first, and the next send is a new request.
 */
export async function towerOperation<T>(token: string, operation: string, input: unknown = {}, node?: string): Promise<T> {
  if (!node) return authPost<{ result: T }>(`/api/v1/${operation}`, token, input).then(response => response.result);
  const body = JSON.stringify(input);
  const write = isOperationName(operation) && OPERATIONS[operation].write;
  const key = `v1:${operation}`;
  const headers = { 'Content-Type': 'application/json', [REQUEST_TOKEN_HEADER]: token };
  try {
    const { result } = await api<{ result: T }>(nodePath(node, `/api/v1/${operation}`), { method: 'POST', headers: write ? nodeHeaders(node, headers, key, body) : headers, body });
    if (write) settleRequest(node, key);
    return result;
  } catch (error) {
    // That computer's own answer is a conflict; a lost connection on the way is not, and keeps the same request.
    const { disposition, status } = error as { disposition?: string; status?: number };
    if (write) { if (disposition === 'uncertain' && status === 409) forgetRequest(node, key); else settleRequest(node, key, error); }
    throw error;
  }
}

export function eventStatusLabel(status: TriggerEvent['status'], t: (key: string) => string): string {
  const labels: Record<TriggerEvent['status'], string> = { queued: '대기', claimed: '시작 중', running: '실행 중', completed: '완료', error: '오류', cancelled: '취소됨', uncertain: '확인 불가', skipped: '건너뜀', coalesced: '합쳐짐' };
  return t(labels[status]);
}

/** What each audit entry did, in the owner's language; the stored summary stays as detail. */
export function auditActionLabel(action: TriggerAuditEntry['action'], t: (key: string) => string): string {
  const labels: Record<TriggerAuditEntry['action'], string> = { create: '만듦', update: '변경', delete: '삭제', enable: '켬', disable: '끔', run: '지금 실행', revert: '되돌림',
    restore: '복원', resume: '다시 시작', settings: '한도 변경', slack: 'Slack 설정 변경', secret: '비밀 변경' };
  return t(labels[action]);
}

/** The kind of trigger in one or two words. */
export function kindLabel(kind: SourceKind | 'slack', t: (key: string) => string): string {
  return t(kind === 'schedule' ? '예약 실행' : kind === 'http' ? 'HTTP 응답' : kind === 'github' ? 'GitHub 이슈' : 'Slack 멘션');
}

/** When a trigger looks, and at what. */
export function scheduleLabel(trigger: Pick<Trigger, 'source'>, t: Translate): string {
  const schedule = trigger.source.schedule;
  const when = schedule.type === 'interval' ? schedule.everySeconds % 3600 === 0 ? t('{0}시간마다', { 0: schedule.everySeconds / 3600 }) : t('{0}분마다', { 0: Math.round(schedule.everySeconds / 60) })
    : `${schedule.expression} · ${schedule.timezone}`;
  if (trigger.source.kind === 'github') {
    const watch = trigger.source.watch;
    const repos = watch.repos?.length ? ` · ${watch.repos[0]}${watch.repos.length > 1 ? ` +${watch.repos.length - 1}` : ''}` : '';
    return `GitHub · ${watch.type === 'issue-opened' ? t('새 이슈') : t('나에게 할당')}${repos} · ${when}`;
  }
  if (trigger.source.kind !== 'http') return when;
  let host = trigger.source.request.url;
  try { host = new URL(host).host; } catch { /* shown as written */ }
  return `${trigger.source.request.method} ${host} · ${when}`;
}

/** Who counts as an author by default: the repository's owners, members and collaborators. */
export const MEMBERS = ['OWNER', 'MEMBER', 'COLLABORATOR'] as const;
export const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
export function blankHttpSource(schedule: Source['schedule'] = { type: 'interval', everySeconds: 300 }): HttpSource {
  return { kind: 'http', schedule, request: { method: 'GET', url: '', headers: [], timeoutSeconds: 30 }, condition: { type: 'changed' } };
}
export function blankGitHubSource(schedule: Source['schedule'] = { type: 'interval', everySeconds: 300 }): GitHubSource {
  return { kind: 'github', schedule, auth: { type: 'gh' }, account: '', watch: { type: 'issue-opened', repos: [], authorAssociation: [...MEMBERS] } };
}
type Watch = GitHubSource['watch'];
/** The watch after switching to another kind, with the filters that kind had before (from `kept`) and the repositories typed now. */
export function switchedWatch(kept: Partial<Record<Watch['type'], Watch>>, type: Watch['type'], repos: string[]): Watch {
  const earlier = kept[type];
  return type === 'assigned-to-me'
    ? { type, ...(repos.length ? { repos } : {}), includePullRequests: earlier?.type === type && earlier.includePullRequests }
    : { ...(earlier?.type === type ? earlier : { authorAssociation: [...MEMBERS] }), type, repos };
}

/** A new trigger of one kind, with the defaults its editor starts from. */
export function blankTrigger(kind: SourceKind = 'schedule'): TriggerInput {
  const source: Source = kind === 'http' ? blankHttpSource() : kind === 'github' ? blankGitHubSource()
    : { kind: 'schedule', schedule: { type: 'cron', expression: '0 9 * * 1-5', timezone: browserZone() }, catchUp: 'latest' };
  return { name: '', enabled: true, source,
    handler: { kind: 'task', instructions: '', provider: 'codex', approvals: 'auto', target: { node: 'local', mode: 'auto' } }, policy: { overlap: 'skip', maxEventsPerHour: 20 } };
}
