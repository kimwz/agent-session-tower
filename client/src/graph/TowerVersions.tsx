import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n/i18n';

/**
 * Every Tower process on a computer: the web server that serves pages, the execution worker that runs agents, and
 * the terminal and master hosts. Each keeps its own code until it restarts, so after an update they can differ.
 * `null` means the process is not running; a missing entry means the computer did not say.
 */
export interface TowerVersions { web: string; worker?: string; terminalHost?: string | null; master?: string | null }

type Row = { key: keyof TowerVersions; name: string; hint: string; moves?: string; value?: string | null };

const PANEL_WIDTH = 260;

/** Whether released version `a` is newer than `b`. */
export function newerVersion(a: string | undefined, b: string | undefined): boolean {
  const [x, y] = [a, b].map(value => /^\d+\.\d+\.\d+$/.test(value ?? '') ? value!.split('.').map(Number) : undefined);
  if (!x || !y) return false;
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] > y[index];
  return false;
}

/** Whether a running process still waits to move to the web server's version. */
const waits = (web: string, value: string | null | undefined) => value === 'legacy' || (typeof value === 'string' && newerVersion(web, value));

/** Whether any running process is on an older version than the web server. */
export function versionsBehind(versions: TowerVersions): boolean {
  return [versions.worker, versions.terminalHost, versions.master].some(value => waits(versions.web, value));
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
  const hovered = useRef(false);
  const hold = () => { hovered.current = true; clearTimeout(closing.current); setOpen(true); };
  const release = () => { hovered.current = false; clearTimeout(closing.current); closing.current = setTimeout(() => { if (!container.current?.contains(document.activeElement)) setOpen(false); }, 150); };
  useEffect(() => () => clearTimeout(closing.current), []);
  // Drawn outside the canvas, so a zoomed-out canvas does not shrink it; placed under the version, inside the window.
  const [place, setPlace] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    if (!open) { setPlace(undefined); return; }
    const anchor = container.current?.getBoundingClientRect();
    if (!anchor) return;
    const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - PANEL_WIDTH / 2, window.innerWidth - PANEL_WIDTH - 8));
    // Below the version, or above it when the window has no room left below.
    const height = panel.current?.offsetHeight ?? 250;
    setPlace({ left, top: anchor.bottom + 8 + height > window.innerHeight && anchor.top - 8 - height > 0 ? anchor.top - 8 - height : anchor.bottom + 8 });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false); };
    // It stays where it opened, so moving the canvas or the window closes it rather than leave it behind.
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', closeOutside);
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => { document.removeEventListener('pointerdown', closeOutside); window.removeEventListener('wheel', close); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, [open]);
  const all: Row[] = [
    { key: 'web', name: t('화면 서버'), hint: t('이 페이지와 API를 보냅니다.'), value: versions.web },
    { key: 'worker', name: t('실행 워커'), hint: t('에이전트 작업과 트리거를 실행합니다.'), moves: t('실행 중인 작업이 없을 때 v{0}(으)로 바뀝니다.', { 0: versions.web }), value: versions.worker },
    { key: 'terminalHost', name: t('터미널 호스트'), hint: t('열어 둔 터미널을 유지합니다.'), moves: t('열린 터미널을 모두 닫으면 v{0}(으)로 바뀝니다.', { 0: versions.web }), value: versions.terminalHost },
    { key: 'master', name: t('마스터 호스트'), hint: t('마스터 에이전트 대화를 맡습니다.'), moves: t('다시 시작할 때 v{0}(으)로 바뀝니다.', { 0: versions.web }), value: versions.master },
  ];
  const rows = all.filter(row => row.value !== undefined);
  const behind = versionsBehind(versions);
  const shown = (row: Row) => row.value === null ? t('실행 중 아님') : row.value === 'legacy' ? t('이전 버전') : `v${row.value}`;
  const waiting = (row: Row) => row.key !== 'web' && waits(versions.web, row.value);
  return <span ref={container} className="tower-versions nodrag nopan" onMouseEnter={hold} onMouseLeave={release} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && !hovered.current) setOpen(false); }}>
    <button type="button" className={`tower-versions-trigger${behind ? ' behind' : ''}`} aria-describedby={open ? id : undefined}
      aria-label={t('Tower 버전: {0}', { 0: rows.map(row => `${row.name} ${shown(row)}`).join(', ') })}
      onFocus={() => setOpen(true)} onPointerDown={event => { tapped.current = event.pointerType === 'touch' ? open : undefined; }} onPointerCancel={() => { tapped.current = undefined; }}
      onClick={() => { setOpen(tapped.current === undefined || !tapped.current); tapped.current = undefined; }}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }}>v{versions.web}{behind && <i aria-hidden="true" />}</button>
    {open && place && createPortal(<span ref={panel} className="tower-versions-tooltip" id={id} role="tooltip"
      style={{ left: place.left, top: place.top, width: PANEL_WIDTH }} onMouseEnter={hold} onMouseLeave={release}>
      <strong>{t('Tower 버전')}</strong>
      <dl>{rows.map(row => <div key={row.key} className={waiting(row) ? 'waiting' : row.value === null ? 'idle' : ''}>
        <dt>{row.name}</dt><dd><em>{shown(row)}</em><span>{waiting(row) ? row.moves : row.hint}</span></dd>
      </div>)}</dl>
    </span>, document.body)}
  </span>;
}
