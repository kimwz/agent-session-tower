import { useEffect, useId, useRef, useState } from 'react';
import type { Provider, ProviderHealth, UsageWindow } from '../../../shared/types';
import { ProviderIcon } from '../common/Icons';
import { absoluteTime, providerLabels, relativeTime } from '../common/lib';
import { useI18n } from '../i18n/i18n';
import { usageAheadOfTime, usageElapsedPercent, usagePercent, usageUnavailableReason, usageWindowLabel, usageWindows } from './provider-usage';

export function ProviderUsageMeter({ provider, health }: { provider: Provider; health?: ProviderHealth }) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const usage = health?.usage;
  const windows = usageWindows(usage);
  const primary = windows.find(window => window.windowMinutes === 300 || window.id === 'five_hour') || windows[0];
  const percent = primary ? usagePercent(primary.usedPercent) : '—';
  const elapsed = primary && usageElapsedPercent(primary, now);
  const ahead = !!primary && usageAheadOfTime(primary, elapsed);
  const stale = !!usage?.stale;
  const label = primary ? t('{0} 사용', { 0: usageWindowLabel(primary) }) : usage?.status === 'loading' ? t('확인 중') : t('정보 없음');
  return <div ref={container} className={`provider-usage-meter ${provider} ${stale ? 'stale' : ''} ${ahead ? 'ahead' : ''} nodrag nopan nowheel`} onMouseEnter={() => setOpen(true)} onMouseLeave={() => { if (!container.current?.contains(document.activeElement)) setOpen(false); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" className="usage-trigger" aria-label={t('{0} 계정 사용량: {1}{2}', { 0: providerLabels[provider], 1: primary ? `${percent} ${label}${elapsed === undefined ? '' : t(' · 기간 {0} 경과', { 0: usagePercent(elapsed) })}` : label, 2: stale ? t(' · 이전 정보') : '' })} aria-describedby={open ? id : undefined} aria-expanded={open} onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }}>
      <span className="usage-donut" aria-hidden="true">
        <svg viewBox="0 0 36 36"><circle className="usage-track" cx="18" cy="18" r="15" />{primary && <circle className="usage-fill" cx="18" cy="18" r="15" pathLength="100" strokeDasharray={`${Math.min(100, primary.usedPercent)} 100`} />}{elapsed !== undefined && <g className="usage-time" transform={`rotate(${elapsed * 3.6} 18 18)`}><line x1="31" y1="18" x2="35" y2="18" /><polygon points="35,18 38,16.2 38,19.8" /></g>}</svg>
        <ProviderIcon provider={provider} size={14} />
      </span>
      <span className="usage-summary"><strong>{percent}{stale && <i aria-hidden="true">*</i>}</strong><small>{provider === 'claude' ? 'Claude' : 'Codex'} · {primary ? usageWindowLabel(primary) : label}</small></span>
    </button>
    {open && <div className="usage-tooltip" id={id} role="tooltip">
      <strong>{t('{0} 계정 사용량', { 0: providerLabels[provider] })}</strong>
      <p>{t('모든 기기에서 공유하는 계정 한도입니다.')}</p>
      {windows.length ? <dl>{windows.map(window => <UsageWindowDetail key={window.id} window={window} now={now} />)}</dl> : <p className="usage-unavailable">{usageUnavailableReason(usage)}</p>}
      {stale && <p className="usage-stale">{usage?.status === 'loading' ? t('이전 정보 · 새 사용량 확인 중') : t('이전 정보 · 새 사용량을 불러오지 못했습니다.')}</p>}
      {usage?.updatedAt && <small>{t('확인: {0}', { 0: relativeTime(usage.updatedAt) })}</small>}
    </div>}
  </div>;
}

function UsageWindowDetail({ window, now }: { window: UsageWindow; now: number }) {
  const { t } = useI18n();
  const elapsed = usageElapsedPercent(window, now);
  const reset = window.resetsAt && absoluteTime(window.resetsAt);
  return <div className={usageAheadOfTime(window, elapsed) ? 'ahead' : undefined}>
    <dt>{usageWindowLabel(window)}<span>{reset ? t('초기화: {0}', { 0: reset }) : t('초기화 시간 정보 없음')}</span></dt>
    <dd title={elapsed === undefined ? undefined : t('기간 {0} 경과', { 0: usagePercent(elapsed) })}>
      <span className="usage-bar"><i><b style={{ width: `${Math.min(100, window.usedPercent)}%` }} /></i>{elapsed !== undefined && <u style={{ left: `${elapsed}%` }} />}</span>
      <em>{usagePercent(window.usedPercent)}</em>
    </dd>
  </div>;
}

export function ProviderUsage({ providers }: { providers: ProviderHealth[] }) {
  const { t } = useI18n();
  return <div className="provider-usage" aria-label={t('계정 사용량 · 모든 기기')}><div className="provider-usage-rings">{(['claude', 'codex'] as const).map(provider => <ProviderUsageMeter key={provider} provider={provider} health={providers.find(health => health.provider === provider)} />)}</div><span className="provider-usage-scope">{t('계정 사용량 · 모든 기기')}</span></div>;
}
