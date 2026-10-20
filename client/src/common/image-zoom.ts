/**
 * The arithmetic of the image viewer (ImageViewer.tsx), free of the DOM. A view is the image's `scale` (screen pixels per
 * image pixel) and the position `x`, `y` of its centre from the stage's centre, in screen pixels.
 */

export interface Size { width: number; height: number }
export interface Point { x: number; y: number }
export interface View { scale: number; x: number; y: number }

/** The scale that fits the whole image on the stage, never above the image's own size (a small image is not blown up). */
export const fitScale = (stage: Size, image: Size) =>
  image.width > 0 && image.height > 0 ? Math.min(stage.width / image.width, stage.height / image.height, 1) : 1;

/** The closest the viewer zooms in: four times the image's own size, or twice the fit for an image smaller than that. */
export const maxScale = (fit: number) => Math.max(4, fit * 2);

export const fitView = (stage: Size, image: Size): View => ({ scale: fitScale(stage, image), x: 0, y: 0 });

/** Whether a view is zoomed in past the fit (within rounding). */
export const zoomedIn = (view: View, fit: number) => view.scale > fit * 1.001;

/**
 * The view kept in bounds: a scale between the fit and the most, and the image never pulled further than its own edge
 * (a side smaller than the stage stays centred on it).
 */
export function clampView(view: View, stage: Size, image: Size): View {
  const fit = fitScale(stage, image);
  const scale = Math.min(Math.max(view.scale, fit), maxScale(fit));
  const room = (side: number, stageSide: number) => Math.max(0, (side * scale - stageSide) / 2);
  const bound = (value: number, limit: number) => Math.min(Math.max(value, -limit), limit) || 0;
  return { scale, x: bound(view.x, room(image.width, stage.width)), y: bound(view.y, room(image.height, stage.height)) };
}

/**
 * The view scaled by `factor` around `point` (from the stage's centre): the part of the image under that point stays
 * under it, as far as the bounds allow.
 */
export function zoomAt(view: View, factor: number, point: Point, stage: Size, image: Size): View {
  const fit = fitScale(stage, image);
  const scale = Math.min(Math.max(view.scale * factor, fit), maxScale(fit));
  const ratio = scale / view.scale;
  return clampView({ scale, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio }, stage, image);
}

/** A double click or tap: back to the fit when zoomed in, otherwise to the image's own size (twice the fit for a small one) at `point`. */
export function toggleZoom(view: View, point: Point, stage: Size, image: Size): View {
  const fit = fitScale(stage, image);
  if (zoomedIn(view, fit)) return fitView(stage, image);
  const target = fit < 1 ? 1 : fit * 2;
  return zoomAt(view, target / view.scale, point, stage, image);
}

/** The view moved by `dx`, `dy`, kept in bounds. */
export const panBy = (view: View, dx: number, dy: number, stage: Size, image: Size): View =>
  clampView({ ...view, x: view.x + dx, y: view.y + dy }, stage, image);

/**
 * The image a sideways swipe goes to: 1 for the next (a swipe to the left), -1 for the previous, 0 for a move too short
 * or more up and down than across.
 */
export const swipeStep = (dx: number, dy: number): -1 | 0 | 1 =>
  Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5 ? 0 : dx < 0 ? 1 : -1;
