// Flamegraph layout: flatten the call-path tree into positioned rectangles.
//
// This is the classic icicle layout (root on top, callees below). Each frame's width is
// proportional to its *inclusive* weight (cost or hits), and children are packed left-to-right
// within their parent's span, ordered by weight so the hot path reads left-first. The output is a
// flat list of unit-square-space rectangles (x ∈ [0,1], one row per depth) that the SVG view
// renders directly, plus a stable colour per function name.

import type { FlameNode } from './profile';

export type FlameMetric = 'cost' | 'hits';

export interface FlameRect {
  func: string;
  depth: number;
  x0: number;
  x1: number;
  selfCost: number;
  totalCost: number;
  selfHits: number;
  totalHits: number;
  /** Fraction of the whole (root) inclusive weight this frame represents. */
  fraction: number;
  colorIndex: number;
  /** The tree node this rectangle draws (for click-to-zoom + tooltips). */
  node: FlameNode;
}

const weightOf = (n: FlameNode, metric: FlameMetric): number =>
  metric === 'cost' ? n.totalCost : n.totalHits;

/**
 * Lay out the tree rooted at `root`. Frames narrower than `minFraction` of the whole are pruned
 * (they would be sub-pixel anyway), which also bounds the rectangle count on huge traces.
 */
export function layoutFlame(root: FlameNode, metric: FlameMetric, minFraction = 0.002): FlameRect[] {
  const total = Math.max(1, weightOf(root, metric));
  const rects: FlameRect[] = [];

  const recur = (node: FlameNode, x0: number, x1: number, depth: number) => {
    const span = x1 - x0;
    rects.push({
      func: node.func,
      depth,
      x0,
      x1,
      selfCost: node.selfCost,
      totalCost: node.totalCost,
      selfHits: node.selfHits,
      totalHits: node.totalHits,
      fraction: weightOf(node, metric) / total,
      colorIndex: hashName(node.func),
      node,
    });
    // Children ordered by weight (hot-first), packed within [x0, x1] scaled by inclusive weight.
    const kids = [...node.children].sort((a, b) => weightOf(b, metric) - weightOf(a, metric));
    const nodeWeight = Math.max(1, weightOf(node, metric));
    let cx = x0;
    for (const k of kids) {
      const w = (weightOf(k, metric) / nodeWeight) * span;
      const kx1 = cx + w;
      if (weightOf(k, metric) / total >= minFraction) {
        recur(k, cx, kx1, depth + 1);
      }
      cx = kx1;
    }
  };

  recur(root, 0, 1, 0);
  return rects;
}

/** The maximum depth actually present in a laid-out flamegraph. */
export function flameDepth(rects: readonly FlameRect[]): number {
  let d = 0;
  for (const r of rects) if (r.depth > d) d = r.depth;
  return d;
}

/** A stable per-name colour index (so a function keeps its colour across zoom/re-layout). */
export function hashName(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

/** A warm categorical palette (hue rotation) so adjacent frames stay distinguishable. */
export function flameColor(index: number, hot: boolean): string {
  const hue = (18 + index * 137.508) % 360; // golden-angle spread over the [0,360) hash
  const sat = hot ? 74 : 52;
  const light = hot ? 56 : 44;
  return `hsl(${hue} ${sat}% ${light}%)`;
}
