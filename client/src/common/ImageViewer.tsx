import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, ExternalLink, X, ZoomIn, ZoomOut } from 'lucide-react';
import { translate as t, useI18n } from '../i18n/i18n';
import { clampView, fitScale, fitView, panBy, pinchView, swipeStep, toggleZoom, zoomAt, zoomedIn, type Point, type Size, type View } from './image-zoom';

/** An image the viewer shows: its address, its name, and where to download it (when it can be). */
export interface ViewerImage { src: string; name: string; download?: string }

// `view` is the view the gesture began from, or null when it began before the picture had loaded (never zoomed then).
type Gesture =
  | { kind: 'pan'; start: Point; view: View | null; moved: boolean; onImage: boolean }
  | { kind: 'pinch'; distance: number; middle: Point; view: View | null };

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
/** Files dragged or pasted over the viewer are not the page's: the task's detail under it would attach them. */
const keepFiles = (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'none'; };

/**
 * Shows `images` (at least one) over the page, starting from `start`: fitted to the screen, zoomed with the buttons, the
 * wheel, a pinch or a double click or tap (back to the fit, or to the image's own size there), moved by dragging or, zoomed
 * in, the arrow keys, and gone through with the arrows, the left and right keys or a sideways swipe. Esc, a click or tap
 * beside the image or the close button closes it, and the focus goes back to `opener` (Safari does not focus a clicked
 * button) or where it was. The list may change while open (an attachment deleted elsewhere): the picture shown stays,
 * or its neighbour when it is gone.
 */
export function ImageViewer({ images, start, opener, onClose }: { images: readonly ViewerImage[]; start: number; opener?: HTMLElement | null; onClose: () => void }) {
  useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  // The picture shown, by its address, so a change to the list does not swap it for another.
  const [chosen, setChosen] = useState(images[start]?.src);
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  // What loading a picture found, for that picture only: its size, or that it failed.
  const [loaded, setLoaded] = useState<{ src: string; size: Size | null } | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ time: number; point: Point } | null>(null);
  // A tap beside the picture closes the viewer on its click, not before: a viewer gone at the tap's end would leave the
  // click to whatever is under it on the page.
  const closeOnClick = useRef(false);
  const found = images.findIndex(image => image.src === chosen);
  const lastIndex = useRef(start);
  const index = found >= 0 ? found : Math.min(lastIndex.current, images.length - 1);
  lastIndex.current = index;
  const image = images[index];
  // The picture shown in place of one deleted is the one shown from now on, whatever is deleted next.
  if (found < 0 && chosen !== image.src) setChosen(image.src);
  const count = images.length;
  const natural = loaded?.src === image.src ? loaded.size : null;
  const failed = loaded?.src === image.src && !loaded.size;
  // The handlers below read the latest of these, not the render they were made in.
  const live = useRef({ stage, natural, view, count, index, images });
  live.current = { stage, natural, view, count, index, images };

  useEffect(() => {
    const element = dialog.current!, back = opener ?? document.activeElement;
    if (!element.open) element.showModal();
    // After `showModal`, which focuses the first control it finds (a link while the zoom buttons wait for the picture).
    closeButton.current?.focus();
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
    const { count, index, images } = live.current;
    if (count < 2 || !step) return;
    setChosen(images[(index + step + count) % count].src);
    pointers.current.clear(); gesture.current = null; lastTap.current = null;
  };
  const fit = natural ? fitScale(stage, natural) : 1;
  // A picture still loading, or one that failed, is never zoomed: the last picture's scale says nothing of it.
  const zoomed = natural !== null && zoomedIn(view, fit);
  const zoomBy = (factor: number) => { if (natural) setView(current => zoomAt(current, factor, { x: 0, y: 0 }, stage, natural)); };
  const toggleAt = (point: Point) => { if (natural) setView(current => toggleZoom(current, point, stage, natural)); };
  const panKeys = (dx: number, dy: number) => { if (natural) setView(current => panBy(current, dx, dy, stage, natural)); };

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    closeOnClick.current = false;
    const point = pointIn(event);
    pointers.current.set(event.pointerId, point);
    const [a, b] = [...pointers.current.values()];
    const from = live.current.natural ? live.current.view : null;
    gesture.current = b
      ? { kind: 'pinch', distance: Math.max(distance(a, b), 1), middle: middle(a, b), view: from }
      : { kind: 'pan', start: point, view: from, moved: false, onImage: event.target === imageRef.current };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = pointIn(event);
    pointers.current.set(event.pointerId, point);
    const current = gesture.current, { natural, stage } = live.current;
    if (!current) return;
    if (current.kind === 'pinch') {
      const [a, b] = [...pointers.current.values()];
      if (b && natural && current.view) setView(pinchView(current.view, distance(a, b) / current.distance, current.middle, middle(a, b), stage, natural));
      return;
    }
    // A move counts before the picture has loaded too: a swipe over one still loading (or failed) goes on, never closes.
    const dx = point.x - current.start.x, dy = point.y - current.start.y;
    if (Math.hypot(dx, dy) > 6) current.moved = true;
    if (natural && current.view && current.moved && zoomedIn(current.view, fitScale(stage, natural))) setView(panBy(current.view, dx, dy, stage, natural));
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    const current = gesture.current, { natural, stage } = live.current;
    const rest = [...pointers.current.values()];
    // One finger left of a pinch goes on moving the picture from where it is.
    if (current?.kind === 'pinch') { gesture.current = rest.length === 1 ? { kind: 'pan', start: rest[0], view: natural ? live.current.view : null, moved: true, onImage: true } : null; return; }
    if (rest.length || !current) return;
    gesture.current = null;
    if (event.type === 'pointercancel') return;
    const point = pointIn(event);
    if (current.moved) {
      if (!natural || !current.view || !zoomedIn(current.view, fitScale(stage, natural))) go(swipeStep(point.x - current.start.x, point.y - current.start.y));
      return;
    }
    if (!current.onImage) { closeOnClick.current = true; return; }
    const previous = lastTap.current;
    if (previous && event.timeStamp - previous.time < 320 && distance(previous.point, point) < 30) { lastTap.current = null; toggleAt(point); }
    else lastTap.current = { time: event.timeStamp, point };
  };

  const keys = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
    // Zoomed in, the arrow keys move the picture (a picture the keyboard could not see all of otherwise); fitted, left and
    // right go through the pictures.
    const step = 80;
    const actions: Record<string, () => void> = {
      // Esc is the viewer's alone: the page's own Esc handlers (its help, the task's detail) never see it.
      Escape: onClose, ArrowLeft: () => zoomed ? panKeys(step, 0) : go(-1), ArrowRight: () => zoomed ? panKeys(-step, 0) : go(1),
      ArrowUp: () => { if (zoomed) panKeys(0, step); }, ArrowDown: () => { if (zoomed) panKeys(0, -step); },
      '+': () => zoomBy(1.25), '=': () => zoomBy(1.25), '-': () => zoomBy(0.8),
      '0': () => { if (natural) setView(fitView(stage, natural)); },
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault(); event.stopPropagation();
    action();
  };

  // tabIndex: a click on the picture (not focusable) focuses the dialog, not the page, so the keys stay the viewer's.
  return createPortal(<dialog ref={dialog} className="image-viewer" tabIndex={-1} aria-label={image.name} onKeyDown={keys}
    onPaste={event => event.stopPropagation()} onDragOver={keepFiles} onDrop={keepFiles}
    // A close request without a key (Android's back gesture).
    onCancel={event => { event.preventDefault(); onClose(); }}
    // The browser may close a modal on its own (a second Esc); a close queued before it opened again is not one.
    onClose={event => { if (!event.currentTarget.open) onClose(); }}>
    <div className="image-viewer-bar">
      <span className="image-viewer-name" title={image.name}>{image.name}</span>
      {count > 1 && <span className="image-viewer-count">{index + 1} / {count}</span>}
      <button type="button" className="icon-button" aria-label={t('축소')} title={t('축소')} disabled={!zoomed} onClick={() => zoomBy(0.8)}><ZoomOut size={16} /></button>
      {/* Fit and actual size (1:1) are one for a picture smaller than the screen. */}
      <button type="button" className="image-viewer-scale" disabled={!natural || (fit >= 1 && !zoomed)} aria-label={zoomed ? t('화면에 맞추기') : t('원본 크기로 보기')} title={zoomed ? t('화면에 맞추기') : t('원본 크기로 보기')}
        onClick={() => toggleAt({ x: 0, y: 0 })}>{natural ? `${Math.round(view.scale * 100)}%` : '–'}</button>
      <button type="button" className="icon-button" aria-label={t('확대')} title={t('확대')} disabled={!natural} onClick={() => zoomBy(1.25)}><ZoomIn size={16} /></button>
      <a className="icon-button" href={image.src} target="_blank" rel="noreferrer noopener" aria-label={t('새 탭에서 원본 열기')} title={t('새 탭에서 원본 열기')}><ExternalLink size={16} /></a>
      {image.download && <a className="icon-button" href={image.download} download={image.name} aria-label={t('“{0}” 내려받기', { 0: image.name })} title={t('“{0}” 내려받기', { 0: image.name })}><Download size={16} /></a>}
      <button ref={closeButton} type="button" className="icon-button" aria-label={t('닫기')} title={t('닫기')} onClick={onClose}><X size={18} /></button>
    </div>
    <div ref={stageRef} className={`image-viewer-stage${zoomed ? ' zoomed' : ''}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onClick={() => { if (closeOnClick.current) { closeOnClick.current = false; onClose(); } }}>
      {failed ? <p className="image-viewer-error">{t('이미지 미리보기를 불러올 수 없습니다.')}</p>
        : <img key={image.src} ref={imageRef} src={image.src} alt={image.name} draggable={false} decoding="async"
          onLoad={event => setLoaded({ src: image.src, size: { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight } })}
          onError={() => setLoaded({ src: image.src, size: null })}
          style={natural ? { width: natural.width, height: natural.height, transform: `translate(${view.x}px, ${view.y}px) translate(-50%, -50%) scale(${view.scale})` } : { opacity: 0 }} />}
    </div>
    {count > 1 && <>
      <button type="button" className="image-viewer-nav previous" aria-label={t('이전 이미지')} title={t('이전 이미지')} onClick={() => go(-1)}><ChevronLeft size={22} /></button>
      <button type="button" className="image-viewer-nav next" aria-label={t('다음 이미지')} title={t('다음 이미지')} onClick={() => go(1)}><ChevronRight size={22} /></button>
    </>}
  </dialog>, document.body);
}
