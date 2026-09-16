import { useEffect, useId, useRef, useState } from 'react';
import { Move, Settings, Waypoints, X } from 'lucide-react';
import { translate as t, useI18n } from './i18n';
import type { GraphLayoutMode } from './graph-layout-preferences';

export function CanvasSettings({ manual, onLayoutChange, motion, onMotionChange, showHidden, onShowHiddenChange, suspended }: {
  manual: boolean;
  onLayoutChange: (mode: GraphLayoutMode) => void;
  motion: boolean;
  onMotionChange: (motion: boolean) => void;
  showHidden: boolean;
  onShowHiddenChange: (showHidden: boolean) => void;
  suspended: boolean;
}) {
  useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const visible = open && !suspended;

  useEffect(() => { if (suspended) setOpen(false); }, [suspended]);
  useEffect(() => {
    if (!visible) return;
    panel.current?.querySelector<HTMLButtonElement>('.canvas-layout-options button')?.focus({ preventScroll: true });
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('focusin', dismissOutside, true);
    document.addEventListener('keydown', dismissEscape, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('focusin', dismissOutside, true);
      document.removeEventListener('keydown', dismissEscape, true);
    };
  }, [visible]);

  return <div ref={root} className="canvas-settings">
    <button ref={trigger} className="canvas-settings-trigger" aria-label={t("캔버스 설정")} title={t("캔버스 설정")} aria-expanded={visible} aria-controls={id} disabled={suspended} onClick={() => setOpen(value => !value)}><Settings size={17} /></button>
    {visible && <section ref={panel} id={id} className="canvas-settings-popover" aria-label={t("캔버스 설정")} tabIndex={-1}>
      <header><strong>{t("캔버스 설정")}</strong><button className="icon-button" aria-label={t("캔버스 설정 닫기")} onClick={() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }}><X size={14} /></button></header>
      <div className="canvas-layout-options" role="group" aria-label={t("그래프 정렬 방식")}><button aria-pressed={!manual} onClick={() => onLayoutChange('auto')} title={t("최근 활동 순서로 자동 정렬")}><Waypoints size={13} />{t("자동 정렬")}</button><button aria-pressed={manual} onClick={() => onLayoutChange('manual')} title={t("폴더와 세션을 드래그해 위치 지정")}><Move size={13} />{t("수동 배치")}</button></div>
      <label className="canvas-setting-option"><input type="checkbox" checked={motion} onChange={event => onMotionChange(event.target.checked)} /><span>{t("연결선 애니메이션")}</span></label>
      <label className="canvas-setting-option" title={t("숨긴 폴더 포함 (Shift+A)")}><input type="checkbox" checked={showHidden} onChange={event => onShowHiddenChange(event.target.checked)} aria-label={t("전체보기")} aria-keyshortcuts="Shift+A" /><span>{t("전체보기")}</span><kbd>⇧A</kbd></label>
    </section>}
  </div>;
}
