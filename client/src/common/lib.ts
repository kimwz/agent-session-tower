import { translate as t, locale } from '../i18n/i18n';
import type { Session, SessionStatus, Snapshot } from '../../../shared/types';
export { sessionActivityAt, sortSessions } from '../../../shared/session-activity';

export const statusLabels: Record<SessionStatus, string> = {
  get working() { return t('작업 중'); },
  get idle() { return t('대기 중'); },
  get completed() { return t('완료'); },
  get error() { return t('중단·오류'); },
};
/** A continuation the agent scheduled is not a finished conversation: it resumes on its own. */
export function sessionState(session: Pick<Session, 'status' | 'scheduledAt'>): { key: SessionStatus | 'scheduled'; label: string } {
  if (session.scheduledAt && session.status !== 'working') return { key: 'scheduled', label: scheduledLabel(session.scheduledAt) };
  return { key: session.status, label: statusLabels[session.status] };
}
/** Past its time, a continuation is waiting for the conversation to be free. */
export function scheduledLabel(at: string, now = Date.now()) {
  return Date.parse(at) <= now ? t('이어서 진행 대기 중') : t('{0}에 이어서 진행', { 0: clockTime(at) });
}
export function clockTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date().toDateString() === date.toDateString() ? date.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false }) : absoluteTime(value);
}
export const providerLabels = { claude: 'Claude Code', codex: 'Codex' };
export function relativeTime(value: string, now = Date.now()) {
  const elapsed = Math.max(0, now - new Date(value).getTime());
  if (!Number.isFinite(elapsed)) return t("시간 정보 없음");
  if (elapsed < 60_000) return t("방금 전");
  if (elapsed < 3_600_000) return t("{0}분 전", { 0: Math.floor(elapsed / 60_000) });
  if (elapsed < 86_400_000) return t("{0}시간 전", { 0: Math.floor(elapsed / 3_600_000) });
  if (elapsed < 604_800_000) return t("{0}일 전", { 0: Math.floor(elapsed / 86_400_000) });
  return new Date(value).toLocaleDateString(locale(), { month: 'short', day: 'numeric' });
}
export function absoluteTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
export function sessionTitle(session: Session) {
  if (session.customTitle) return session.customTitle;
  const agentName = session.agentName?.trim();
  return (agentName && !/^[a-f0-9]{12,}$/i.test(agentName) ? agentName : session.title) || t("제목 없는 세션");
}
export function cleanPreview(value: string, length = 160) {
  return value.replace(/<[^>]*>/g, ' ').replace(/[#*`\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length);
}
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard) { await navigator.clipboard.writeText(value); return true; }
  } catch { /* Direct HTTP connections need the selection-based browser fallback. */ }
  const previous = document.activeElement as HTMLElement | null;
  const input = document.createElement('textarea');
  input.value = value;
  input.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.append(input);
  input.select();
  try { return document.execCommand('copy'); }
  catch { return false; }
  finally { input.remove(); previous?.focus({ preventScroll: true }); }
}
export class ApiError extends Error {
  /** Set by the server when it knows whether the request ran: `not-admitted` is safe to send again. */
  disposition?: string;
  /** What kind of failure it was, when the server says (`node-offline`: the other computer is away). */
  code?: string;
  constructor(message: string, readonly status: number, disposition?: string, code?: string) { super(message); this.name = 'ApiError'; if (disposition) this.disposition = disposition; if (code) this.code = code; }
}
export const AUTH_REQUIRED_EVENT = 'tower:auth-required';
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/') && typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    let message = t("요청을 처리하지 못했습니다 ({0})", { 0: response.status });
    let disposition: string | undefined;
    let code: string | undefined;
    try {
      const body = await response.json(); message = body.error || message;
      disposition = typeof body.disposition === 'string' ? body.disposition : undefined;
      code = typeof body.code === 'string' ? body.code : undefined;
    } catch { /* non-JSON errors retain status */ }
    throw new ApiError(message, response.status, disposition, code);
  }
  return response.json() as Promise<T>;
}

const FRONT_LOGIN_RELOAD_KEY = 'agent-monitor.front-login-reload';
/**
 * After the live connection was refused, finds out why. A login in front of Tower (such as Cloudflare Access) whose
 * session ran out answers with a redirect that only a full page load can follow, so the page reloads, at most once a
 * minute. When Tower's own sign-in ended, the login form is shown.
 */
export async function recoverRefusedConnection(): Promise<void> {
  if (typeof window === 'undefined' || document.hidden) return;
  let response: Response;
  try { response = await fetch('/api/auth/status', { redirect: 'manual', cache: 'no-store' }); } catch { return; }
  if (response.type === 'opaqueredirect') {
    let last = 0;
    try { last = Number(window.sessionStorage.getItem(FRONT_LOGIN_RELOAD_KEY)) || 0; } catch { /* Without storage, the time guard still applies within this page. */ }
    if (Date.now() - last < 60_000) return;
    try { window.sessionStorage.setItem(FRONT_LOGIN_RELOAD_KEY, String(Date.now())); } catch { /* Reload anyway. */ }
    window.location.reload();
    return;
  }
  if (!response.ok) return;
  const status = await response.json().catch(() => undefined) as { local?: boolean; authenticated?: boolean } | undefined;
  if (status && !status.local && !status.authenticated) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
}

/**
 * The execution worker keeps its code until it idles, so requests can run on an older build than this page. A newer
 * worker (left by an update that was undone) is not waiting to be replaced.
 */
export function outdatedRunner(snapshot: Pick<Snapshot, 'version' | 'runnerVersion'> | null | undefined): string | undefined {
  const runner = snapshot?.runnerVersion;
  if (!runner || runner === snapshot.version) return undefined;
  const parts = (value: string) => /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : undefined;
  const [mine, theirs] = [parts(snapshot.version), parts(runner)];
  if (!mine || !theirs) return runner;
  const index = mine.findIndex((part, position) => part !== theirs[position]);
  return index >= 0 && theirs[index] < mine[index] ? runner : undefined;
}
