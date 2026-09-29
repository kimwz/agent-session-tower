import { useEffect, useId, useRef, useState } from 'react';
import type { SystemStatus } from '../../../shared/types';
import { relativeTime } from '../common/lib';
import { useI18n } from '../i18n/i18n';
import { gigabytes, systemRings, type RingKind } from './system-rings';

/** CPU, RAM and disk of a computer as three small rings under its version; hover, focus or tap shows the numbers. */
export function SystemRings({ status }: { status: SystemStatus }) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  // A tap toggles; whether it was open is read before the touch's emulated hover and focus open it.
  const tapped = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);
  const rings = systemRings(status);
  const names: Record<RingKind, string> = { cpu: 'CPU', memory: t('메모리'), disk: t('디스크') };
  const shown = (percent?: number) => percent === undefined ? t('측정 중') : `${percent}%`;
  const details: Record<RingKind, string> = {
    // Windows reports no load averages, only zeros.
    cpu: status.load.some(Boolean) ? t('코어 {0}개 · 부하 {1}', { 0: status.cores, 1: status.load.map(value => value.toFixed(1)).join(' / ') }) : t('코어 {0}개', { 0: status.cores }),
    memory: t('{0} / {1} GB 사용', { 0: gigabytes(status.memory.used), 1: gigabytes(status.memory.total) }),
    disk: status.disk ? t('{0} / {1} GB 사용 · {2} GB 남음', { 0: gigabytes(status.disk.total - status.disk.free), 1: gigabytes(status.disk.total), 2: gigabytes(status.disk.free) }) : t('정보 없음'),
  };
  return <div ref={container} className="system-rings nodrag nopan" onMouseEnter={() => setOpen(true)} onMouseLeave={() => { if (!container.current?.contains(document.activeElement)) setOpen(false); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" className="system-rings-trigger" aria-label={t('컴퓨터 상태: {0}', { 0: rings.map(ring => `${names[ring.kind]} ${shown(ring.percent)}`).join(', ') })} aria-describedby={open ? id : undefined} onFocus={() => setOpen(true)} onPointerDown={event => { tapped.current = event.pointerType === 'touch' ? open : undefined; }} onPointerCancel={() => { tapped.current = undefined; }} onClick={() => { setOpen(tapped.current === undefined || !tapped.current); tapped.current = undefined; }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }}>
      {rings.map(ring => <span key={ring.kind} className={`system-ring ${ring.kind} ${ring.level}`} aria-hidden="true">
        <svg viewBox="0 0 36 36"><circle className="system-ring-track" cx="18" cy="18" r="14" />{ring.percent !== undefined && ring.percent > 0 && <circle className="system-ring-fill" cx="18" cy="18" r="14" pathLength="100" strokeDasharray={`${ring.percent} 100`} />}</svg>
        <b>{ring.letter}</b>
      </span>)}
    </button>
    {open && <div className="system-rings-tooltip" id={id} role="tooltip">
      <strong>{t('컴퓨터 상태')}</strong>
      <dl>{rings.map(ring => <div key={ring.kind} className={ring.level}><dt>{names[ring.kind]}</dt><dd><em>{shown(ring.percent)}</em><span>{details[ring.kind]}</span></dd></div>)}</dl>
      <small>{t('측정: {0}', { 0: relativeTime(status.sampledAt) })}</small>
    </div>}
  </div>;
}
