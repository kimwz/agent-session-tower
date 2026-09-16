import type { SessionContextUsage } from '../../shared/types';
import { locale, translate as t } from './i18n';

type ContextUsageTone = 'unknown' | 'low' | 'medium' | 'high' | 'critical';

export function contextUsageMeter(usage?: SessionContextUsage): { percent?: number; arc: number; tone: ContextUsageTone } {
  const percent = usage?.usedPercent;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) return { arc: 0, tone: 'unknown' };
  return { percent, arc: Math.min(100, percent), tone: percent <= 30 ? 'low' : percent <= 50 ? 'medium' : percent <= 75 ? 'high' : 'critical' };
}

const validTokens = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A token count without an observed capacity must never be presented as zero percent. */
export function contextUsageLabel(usage?: SessionContextUsage): string {
  const { percent } = contextUsageMeter(usage);
  const estimatedCapacity = usage?.capacitySource === 'model-default';
  const parts = [percent === undefined ? t('컨텍스트 사용량: 알 수 없음')
    : t(estimatedCapacity ? '컨텍스트 사용량: 약 {0}%' : '컨텍스트 사용량: {0}%', { 0: percent.toLocaleString(locale(), { maximumSignificantDigits: 15 }) })];
  const used = usage?.usedTokens;
  const capacity = usage?.contextWindow;
  if (validTokens(used) && validTokens(capacity) && capacity > 0) {
    parts.push(t('{0} / {1} 토큰', { 0: used.toLocaleString(locale()), 1: capacity.toLocaleString(locale()) }));
  } else if (validTokens(used)) {
    parts.push(t('사용한 토큰: {0}', { 0: used.toLocaleString(locale()) }));
  } else if (validTokens(capacity) && capacity > 0) {
    parts.push(t('컨텍스트 한도: {0} 토큰', { 0: capacity.toLocaleString(locale()) }));
  }
  if (estimatedCapacity) parts.push(t('Claude CLI 모델의 기본 한도 기준이며, 실제 한도는 설정에 따라 다를 수 있습니다.'));
  return parts.join(' · ');
}
