import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n/i18n';

/**
 * Every Tower process on a computer: the web server that serves pages, the execution worker that runs agents, and
 * the terminal and master hosts. Each keeps its own code until it restarts, so after an update they can differ.
 * `null` means the process is not running; a missing entry means the computer did not say.
 */
export interface TowerVersions { web: string; worker?: string; terminalHost?: string | null; master?: string | null }

type Row = { key: keyof TowerVersions; name: string; hint: string; moves: string; value?: string | null };

/** Whether released version `a` is newer than `b`. */
export function newerVersion(a: string | undefined, b: string | undefined): boolean {
  const [x, y] = [a, b].map(value => /^\d+\.\d+\.\d+$/.test(value ?? '') ? value!.split('.').map(Number) : undefined);
  if (!x || !y) return false;
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] > y[index];
  return false;
}

/** Whether any running process is on an older version than the web server. */
export function versionsBehind(versions: TowerVersions): boolean {
  return [versions.worker, versions.terminalHost, versions.master].some(value => value === 'legacy' || (typeof value === 'string' && newerVersion(versions.web, value)));
}

/** The web server's version; hover, focus or tap shows every process's version and which ones wait to move. */
export function TowerVersionsBadge({ versions }: { versions: TowerVersions }) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLSpanElement>(null);
  // A tap toggles; whether it was open is read before the touch's emulated hover and focus open it.
  const tapped = useRef<boolean | undefined>(undefined);
  const panel = useRef<HTMLSpanElement>(null);
  // Leaving the version for the panel crosses a small gap; closing waits a moment so the pointer can get there.
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hold = () => { clearTimeout(closing.current); setOpen(true); };
  const release = () => { clearTimeout(closing.current); closing.current = setTimeout(() => { if (!container.current?.contains(document.activeElement)) setOpen(false); }, 150); };
  useEffect(() => () => clearTimeout(closing.current), []);
  // Drawn outside the canvas, so a zoomed-out canvas does not shrink it; placed under the version, inside the window.
  const [place, setPlace] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    if (!open) { setPlace(undefined); return; }
    const anchor = container.current?.getBoundingClientRect();
    if (!anchor) return;
    const width = 260;
    setPlace({ left: Math.max(8, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - 8)), top: anchor.bottom + 8 });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);
  const rows = ([
    { key: 'web', name: t('화면 서버'), hint: t('이 페이지와 API를 보냅니다.'), moves: '', value: versions.web },
    { key: 'worker', name: t('실행 워커'), hint: t('에이전트 작업과 트리거를 실행합니다.'), moves: t('실행 중인 작업이 없을 때 v{0}(으)로 바뀝니다.', { 0: versions.web }), value: versions.worker },
    { key: 'terminalHost', name: t('터미널 호스트'), hint: t('열어 둔 터미널을 유지합니다.'), moves: t('열린 터미널을 모두 닫으면 v{0}(으)로 바뀝니다.', { 0: versions.web }), value: versions.terminalHost },
    { key: 'master', name: t('마스터 호스트'), hint: t('마스터 에이전트 대화를 맡습니다.'), moves: t('다시 시작할 때 v{0}(으)로 바뀝니다.', { 0: versions.web }), value: versions.master },
  ] satisfies Row[]).filter(row => row.value !== undefined) as Row[];
  const behind = versionsBehind(versions);
  const shown = (row: Row) => row.value === null ? t('실행 중 아님') : row.value === 'legacy' ? t('이전 버전') : `v${row.value}`;
  const waiting = (row: Row) => row.key !== 'web' && (row.value === 'legacy' || (typeof row.value === 'string' && newerVersion(versions.web, row.value)));
  return <span ref={container} className="tower-versions nodrag nopan" onMouseEnter={hold} onMouseLeave={release} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" className={`tower-versions-trigger${behind ? ' behind' : ''}`} aria-describedby={open ? id : undefined}
      aria-label={t('Tower 버전: {0}', { 0: rows.map(row => `${row.name} ${shown(row)}`).join(', ') })}
      onFocus={() => setOpen(true)} onPointerDown={event => { tapped.current = event.pointerType === 'touch' ? open : undefined; }} onPointerCancel={() => { tapped.current = undefined; }}
      onClick={() => { setOpen(tapped.current === undefined || !tapped.current); tapped.current = undefined; }}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }}>v{versions.web}{behind && <i aria-hidden="true" />}</button>
    {open && place && createPortal(<span ref={panel} className="tower-versions-tooltip" id={id} role="tooltip" style={{ left: place.left, top: place.top }}
      onMouseEnter={hold} onMouseLeave={release}>
      <strong>{t('Tower 버전')}</strong>
      <dl>{rows.map(row => <div key={row.key} className={waiting(row) ? 'waiting' : row.value === null ? 'idle' : ''}>
        <dt>{row.name}</dt><dd><em>{shown(row)}</em><span>{waiting(row) ? row.moves : row.hint}</span></dd>
      </div>)}</dl>
    </span>, document.body)}
  </span>;
}
