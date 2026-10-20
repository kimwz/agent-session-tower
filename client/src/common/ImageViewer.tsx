import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, ExternalLink, X, ZoomIn, ZoomOut } from 'lucide-react';
import { translate as t, useI18n } from '../i18n/i18n';
import { clampView, fitScale, fitView, panBy, swipeStep, toggleZoom, zoomAt, zoomedIn, type Point, type Size, type View } from './image-zoom';

/** An image the viewer shows: its address, its name, and where to download it (when it can be). */
export interface ViewerImage { src: string; name: string; download?: string }

type Gesture =
  | { kind: 'pan'; start: Point; view: View; moved: boolean; onImage: boolean }
  | { kind: 'pinch'; distance: number; middle: Point; view: View };

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Shows images over the page, starting from `start`: fitted to the screen, zoomed with the buttons, the wheel, a pinch
 * or a double click or tap (back to the fit, or to the image's own size there), moved by dragging when zoomed in, and
 * gone through with the arrows, the arrow keys or a sideways swipe. Esc, a click or tap beside the image or the close
 * button closes it, and the focus goes back to `opener` (Safari does not focus a clicked button) or where it was.
 */
export function ImageViewer({ images, start, opener, onClose }: { images: readonly ViewerImage[]; start: number; opener?: HTMLElement | null; onClose: () => void }) {
  useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [chosen, setChosen] = useState(start);
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  const [natural, setNatural] = useState<Size | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [failed, setFailed] = useState(false);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ time: number; point: Point } | null>(null);
  const index = Math.min(Math.max(chosen, 0), images.length - 1);
  const image = images[index];
  const count = images.length;
  // The handlers below read the latest of these, not the render they were made in.
  const live = useRef({ stage, natural, view, count, onClose });
  live.current = { stage, natural, view, count, onClose };

  useEffect(() => {
    const element = dialog.current!, back = opener ?? document.activeElement;
    if (!element.open) element.showModal();
    // Safari's own pinch would zoom the page behind; the stage's pinch is the viewer's.
    const gestures = (event: Event) => event.preventDefault();
    element.addEventListener('gesturestart', gestures);
    return () => {
      element.removeEventListener('gesturestart', gestures);
      if (element.open) element.close();
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);

  useLayoutEffect(() => {
    const element = stageRef.current!;
    const measure = () => setStage(current => current.width === element.clientWidth && current.height === element.clientHeight ? current : { width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A new picture starts fitted; a resized stage keeps a fitted picture fitted and a zoomed one in bounds.
  const shown = useRef<{ natural: Size; stage: Size } | null>(null);
  useLayoutEffect(() => {
    if (!natural || !stage.width) return;
    const before = shown.current;
    shown.current = { natural, stage };
    setView(current => before?.natural === natural && zoomedIn(current, fitScale(before.stage, natural)) ? clampView(current, stage, natural) : fitView(stage, natural));
  }, [natural, stage]);

  useEffect(() => {
    const element = stageRef.current!;
    const wheel = (event: WheelEvent) => {
      const { natural, stage } = live.current;
      event.preventDefault();
      if (!natural) return;
      // A trackpad pinch arrives as a wheel with the control key, in small steps.
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.height : 1);
      setView(current => zoomAt(current, Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), pointIn(event), stage, natural));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  const pointIn = (event: { clientX: number; clientY: number }): Point => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  };
  const go = (step: number) => {
    if (live.current.count < 2 || !step) return;
    setChosen(current => (current + step + live.current.count) % live.current.count);
    setNatural(null); setFailed(false);
    pointers.current.clear(); gesture.current = null; lastTap.current = null;
  };
  const zoomBy = (factor: number) => { if (natural) setView(current => zoomAt(current, factor, { x: 0, y: 0 }, stage, natural)); };
  const toggleAt = (point: Point) => { if (natural) setView(current => toggleZoom(current, point, stage, natural)); };

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointIn(event);
    pointers.current.set(event.pointerId, point);
    const [a, b] = [...pointers.current.values()];
    gesture.current = b
      ? { kind: 'pinch', distance: Math.max(distance(a, b), 1), middle: middle(a, b), view: live.current.view }
      : { kind: 'pan', start: point, view: live.current.view, moved: false, onImage: event.target === imageRef.current };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = pointIn(event);
    pointers.current.set(event.pointerId, point);
    const current = gesture.current, { natural, stage } = live.current;
    if (!current || !natural) return;
    if (current.kind === 'pinch') {
      const [a, b] = [...pointers.current.values()];
      if (!b) return;
      const now = middle(a, b);
      setView(panBy(zoomAt(current.view, distance(a, b) / current.distance, current.middle, stage, natural), now.x - current.middle.x, now.y - current.middle.y, stage, natural));
      return;
    }
    const dx = point.x - current.start.x, dy = point.y - current.start.y;
    if (Math.hypot(dx, dy) > 6) current.moved = true;
    if (current.moved && zoomedIn(current.view, fitScale(stage, natural))) setView(panBy(current.view, dx, dy, stage, natural));
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    const current = gesture.current, { natural, stage } = live.current;
    const rest = [...pointers.current.values()];
    // One finger left of a pinch goes on moving the picture from where it is.
    if (current?.kind === 'pinch') { gesture.current = rest.length === 1 ? { kind: 'pan', start: rest[0], view: live.current.view, moved: true, onImage: true } : null; return; }
    if (rest.length || !current) return;
    gesture.current = null;
    if (event.type === 'pointercancel') return;
    const point = pointIn(event);
    if (current.moved) {
      if (natural && !zoomedIn(current.view, fitScale(stage, natural))) go(swipeStep(point.x - current.start.x, point.y - current.start.y));
      return;
    }
    if (!current.onImage) { live.current.onClose(); return; }
    const previous = lastTap.current;
    if (previous && event.timeStamp - previous.time < 320 && distance(previous.point, point) < 30) { lastTap.current = null; toggleAt(point); }
    else lastTap.current = { time: event.timeStamp, point };
  };

  const keys = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    const actions: Record<string, () => void> = {
      // Esc is the viewer's alone: the page's own Esc handlers (its help, the task's detail) never see it.
      Escape: onClose, ArrowLeft: () => go(-1), ArrowRight: () => go(1), '+': () => zoomBy(1.25), '=': () => zoomBy(1.25), '-': () => zoomBy(0.8),
      '0': () => { if (natural) setView(fitView(stage, natural)); },
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault(); event.stopPropagation();
    action();
  };

  if (!image) return null;
  const fit = natural ? fitScale(stage, natural) : 1;
  const zoomed = zoomedIn(view, fit);
  return createPortal(<dialog ref={dialog} className="image-viewer" aria-label={image.name} onKeyDown={keys}
    // A close request without a key (Android's back gesture).
    onCancel={event => { event.preventDefault(); onClose(); }}
    // The browser may close a modal on its own (a second Esc); a close queued before it opened again is not one.
    onClose={event => { if (!event.currentTarget.open) onClose(); }}>
    <div className="image-viewer-bar">
      <span className="image-viewer-name" title={image.name}>{image.name}</span>
      {count > 1 && <span className="image-viewer-count">{index + 1} / {count}</span>}
      <button type="button" className="icon-button" aria-label={t('축소')} title={t('축소')} disabled={!natural || !zoomed} onClick={() => zoomBy(0.8)}><ZoomOut size={16} /></button>
      <button type="button" className="image-viewer-scale" disabled={!natural} aria-label={zoomed ? t('화면에 맞추기') : t('원본 크기로 보기')} title={zoomed ? t('화면에 맞추기') : t('원본 크기로 보기')}
        onClick={() => toggleAt({ x: 0, y: 0 })}>{natural ? `${Math.round(view.scale * 100)}%` : '–'}</button>
      <button type="button" className="icon-button" aria-label={t('확대')} title={t('확대')} disabled={!natural} onClick={() => zoomBy(1.25)}><ZoomIn size={16} /></button>
      <a className="icon-button" href={image.src} target="_blank" rel="noreferrer noopener" aria-label={t('새 탭에서 원본 열기')} title={t('새 탭에서 원본 열기')}><ExternalLink size={16} /></a>
      {image.download && <a className="icon-button" href={image.download} download={image.name} aria-label={t('“{0}” 내려받기', { 0: image.name })} title={t('“{0}” 내려받기', { 0: image.name })}><Download size={16} /></a>}
      <button type="button" className="icon-button" autoFocus aria-label={t('닫기')} title={t('닫기')} onClick={onClose}><X size={18} /></button>
    </div>
    <div ref={stageRef} className={`image-viewer-stage${zoomed ? ' zoomed' : ''}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {failed ? <p className="image-viewer-error">{t('이미지 미리보기를 불러올 수 없습니다.')}</p>
        : <img key={image.src} ref={imageRef} src={image.src} alt={image.name} draggable={false} decoding="async"
          onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setFailed(true)}
          style={natural ? { width: natural.width, height: natural.height, transform: `translate(${view.x}px, ${view.y}px) translate(-50%, -50%) scale(${view.scale})` } : { opacity: 0 }} />}
    </div>
    {count > 1 && <>
      <button type="button" className="image-viewer-nav previous" aria-label={t('이전 이미지')} title={t('이전 이미지')} onClick={() => go(-1)}><ChevronLeft size={22} /></button>
      <button type="button" className="image-viewer-nav next" aria-label={t('다음 이미지')} title={t('다음 이미지')} onClick={() => go(1)}><ChevronRight size={22} /></button>
    </>}
  </dialog>, document.body);
}
