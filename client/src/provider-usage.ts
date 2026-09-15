import type { ProviderUsage, UsageWindow } from '../../shared/types';
import { translate as t } from './i18n';

export function usageWindows(usage?: ProviderUsage): UsageWindow[] {
  if (usage?.status !== 'available' && !usage?.stale) return [];
  return (usage?.windows || []).filter(window => Number.isFinite(window.usedPercent) && window.usedPercent >= 0)
    .sort((a, b) => (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity));
}
export function usageWindowLabel(window: UsageWindow): string {
  if (window.id === 'seven_day_sonnet') return t('주간 · Sonnet');
  if (window.id === 'seven_day_opus') return t('주간 · Opus');
  if (window.windowMinutes === 300 || window.id === 'five_hour') return t('5시간');
  if (window.windowMinutes === 10080 || window.id === 'seven_day') return t('주간');
  if (window.windowMinutes && window.windowMinutes % 1440 === 0) return t('{0}일', { 0: window.windowMinutes / 1440 });
  if (window.windowMinutes && window.windowMinutes % 60 === 0) return t('{0}시간', { 0: window.windowMinutes / 60 });
  if (window.windowMinutes) return t('{0}분', { 0: window.windowMinutes });
  return window.id === 'primary' ? t('기본 한도') : window.id === 'secondary' ? t('추가 한도') : window.id;
}
export function usageUnavailableReason(usage?: ProviderUsage): string {
  if (usage?.status === 'loading') return t('사용량 확인 중');
  switch (usage?.reason) {
    case 'not_signed_in': return t('에이전트에 로그인하면 사용량을 확인할 수 있습니다.');
    case 'not_supported': return t('이 계정은 사용량 조회를 지원하지 않습니다.');
    case 'credentials_unavailable': return t('기존 로그인 정보를 읽을 수 없습니다.');
    case 'rate_limited': return t('사용량 조회 한도에 도달했습니다. 잠시 후 다시 확인합니다.');
    case 'unreachable': return t('사용량 서비스에 연결할 수 없습니다.');
    case 'no_data': return t('계정 사용량 정보가 아직 없습니다.');
    default: return t('사용량을 확인할 수 없습니다.');
  }
}
export function usagePercent(value: number): string {
  return `${Math.round(value)}%`;
}
