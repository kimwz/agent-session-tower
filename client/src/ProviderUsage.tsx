import { useEffect, useId, useRef, useState } from 'react';
import type { Provider, ProviderHealth } from '../../shared/types';
import { ProviderIcon } from './Icons';
import { absoluteTime, providerLabels, relativeTime } from './lib';
import { useI18n } from './i18n';
import { usagePercent, usageUnavailableReason, usageWindowLabel, usageWindows } from './provider-usage';
import './provider-usage.css';

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
  const usage = health?.usage;
  const windows = usageWindows(usage);
  const primary = windows.find(window => window.windowMinutes === 300 || window.id === 'five_hour') || windows[0];
  const percent = primary ? usagePercent(primary.usedPercent) : '—';
  const stale = !!usage?.stale;
  const label = primary ? t('{0} 사용', { 0: usageWindowLabel(primary) }) : usage?.status === 'loading' ? t('확인 중') : t('정보 없음');
  return <div ref={container} className={`provider-usage-meter ${provider} ${stale ? 'stale' : ''} nodrag nopan nowheel`} onMouseEnter={() => setOpen(true)} onMouseLeave={() => { if (!container.current?.contains(document.activeElement)) setOpen(false); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" className="usage-trigger" aria-label={t('{0} 계정 사용량: {1}{2}', { 0: providerLabels[provider], 1: primary ? `${percent} ${label}` : label, 2: stale ? t(' · 이전 정보') : '' })} aria-describedby={open ? id : undefined} aria-expanded={open} onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }}>
      <span className="usage-donut" aria-hidden="true">
        <svg viewBox="0 0 36 36"><circle className="usage-track" cx="18" cy="18" r="15" />{primary && <circle className="usage-fill" cx="18" cy="18" r="15" pathLength="100" strokeDasharray={`${Math.min(100, primary.usedPercent)} 100`} />}</svg>
        <ProviderIcon provider={provider} size={14} />
      </span>
      <span className="usage-summary"><strong>{percent}{stale && <i aria-hidden="true">*</i>}</strong><small>{provider === 'claude' ? 'Claude' : 'Codex'} · {primary ? usageWindowLabel(primary) : label}</small></span>
    </button>
    {open && <div className="usage-tooltip" id={id} role="tooltip">
      <strong>{t('{0} 계정 사용량', { 0: providerLabels[provider] })}</strong>
      <p>{t('모든 기기에서 공유하는 계정 한도입니다.')}</p>
      {windows.length ? <dl>{windows.map(window => <div key={window.id}><dt>{usageWindowLabel(window)}</dt><dd><b>{t('{0} 사용', { 0: usagePercent(window.usedPercent) })}</b><span>{window.resetsAt && absoluteTime(window.resetsAt) ? t('초기화: {0}', { 0: absoluteTime(window.resetsAt) }) : t('초기화 시간 정보 없음')}</span></dd></div>)}</dl> : <p className="usage-unavailable">{usageUnavailableReason(usage)}</p>}
      {stale && <p className="usage-stale">{t('이전 정보 · 새 사용량을 불러오지 못했습니다.')}</p>}
      {usage?.updatedAt && <small>{t('확인: {0}', { 0: relativeTime(usage.updatedAt) })}</small>}
    </div>}
  </div>;
}

export function ProviderUsage({ providers }: { providers: ProviderHealth[] }) {
  const { t } = useI18n();
  return <div className="provider-usage" aria-label={t('계정 사용량 · 모든 기기')}><div className="provider-usage-rings">{(['claude', 'codex'] as const).map(provider => <ProviderUsageMeter key={provider} provider={provider} health={providers.find(health => health.provider === provider)} />)}</div><span className="provider-usage-scope">{t('계정 사용량 · 모든 기기')}</span></div>;
}
