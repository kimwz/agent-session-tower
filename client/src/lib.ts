import { translate as t, locale } from './i18n';
import type { Session, SessionStatus } from '../../shared/types';
export { sessionActivityAt, sortSessions } from '../../shared/session-activity';

export const statusLabels: Record<SessionStatus, string> = {
  get working() { return t('작업 중'); },
  get idle() { return t('대기 중'); },
  get completed() { return t('완료'); },
  get error() { return t('중단·오류'); },
};
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
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = t("요청을 처리하지 못했습니다 ({0})", { 0: response.status });
    try { message = (await response.json()).error || message; } catch { /* non-JSON errors retain status */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
