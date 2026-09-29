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
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);
  const rings = systemRings(status);
  const names: Record<RingKind, string> = { cpu: 'CPU', memory: t('메모리'), disk: t('디스크') };
  const shown = (percent?: number) => percent === undefined ? t('측정 중') : `${percent}%`;
  const [cpu, memory, disk] = rings;
  const load = status.load.map(value => value.toFixed(1)).join(' / ');
  return <div ref={container} className="system-rings nodrag nopan" onMouseEnter={() => setOpen(true)} onMouseLeave={() => { if (!container.current?.contains(document.activeElement)) setOpen(false); }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" className="system-rings-trigger" aria-label={t('컴퓨터 상태: {0}', { 0: rings.map(ring => `${names[ring.kind]} ${shown(ring.percent)}`).join(', ') })} aria-describedby={open ? id : undefined} aria-expanded={open} onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }}>
      {rings.map(ring => <span key={ring.kind} className={`system-ring ${ring.kind} ${ring.level}`} aria-hidden="true">
        <svg viewBox="0 0 36 36"><circle className="system-ring-track" cx="18" cy="18" r="14" />{ring.percent !== undefined && ring.percent > 0 && <circle className="system-ring-fill" cx="18" cy="18" r="14" pathLength="100" strokeDasharray={`${ring.percent} 100`} />}</svg>
        <b>{ring.letter}</b>
      </span>)}
    </button>
    {open && <div className="system-rings-tooltip" id={id} role="tooltip">
      <strong>{t('컴퓨터 상태')}</strong>
      <dl>
        <div className={cpu!.level}><dt>CPU</dt><dd><em>{shown(cpu!.percent)}</em><span>{t('코어 {0}개 · 부하 {1}', { 0: status.cores, 1: load })}</span></dd></div>
        <div className={memory!.level}><dt>{t('메모리')}</dt><dd><em>{shown(memory!.percent)}</em><span>{t('{0} / {1} GB 사용', { 0: gigabytes(status.memory.used), 1: gigabytes(status.memory.total) })}</span></dd></div>
        <div className={disk!.level}><dt>{t('디스크')}</dt><dd><em>{shown(disk!.percent)}</em><span>{status.disk ? t('{0} / {1} GB 사용 · {2} GB 남음', { 0: gigabytes(status.disk.total - status.disk.free), 1: gigabytes(status.disk.total), 2: gigabytes(status.disk.free) }) : t('정보 없음')}</span></dd></div>
      </dl>
      <small>{t('측정: {0}', { 0: relativeTime(status.sampledAt) })}</small>
    </div>}
  </div>;
}
