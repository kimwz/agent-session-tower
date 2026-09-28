import type { FitViewOptions } from '@xyflow/react';

/** The view the fit button shows; a freshly opened canvas starts from the same view. */
export const GRAPH_FIT = { padding: 0.13, minZoom: 0.15, maxZoom: 0.95 } satisfies FitViewOptions;

type FitNode = {
  hidden?: boolean;
  parentId?: string;
  measured: { width?: number; height?: number };
  internals: { positionAbsolute: { x: number; y: number } };
};

/**
 * Identifies what a whole-graph fit depends on: the extent of every shown node
 * and the canvas size. Empty until the canvas has a size and every node has been
 * measured, so a fit never frames a half-drawn graph.
 */
export function graphFitSignature(nodes: Iterable<FitNode>, width: number, height: number): string {
  if (!width || !height) return '';
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const node of nodes) {
    if (node.hidden) continue;
    const { width: nodeWidth, height: nodeHeight } = node.measured;
    if (!nodeWidth || !nodeHeight) return '';
    // Nested nodes stay inside their parent, which is already counted.
    if (node.parentId) continue;
    const { x, y } = node.internals.positionAbsolute;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x + nodeWidth); bottom = Math.max(bottom, y + nodeHeight);
  }
  if (left === Infinity) return '';
  return [left, top, right, bottom, width, height].map(Math.round).join(',');
}
