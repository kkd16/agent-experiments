// Small drawing helpers shared by the hex tilesets. Everything is expressed against the same
// pointy-top hex geometry the compiler uses (circumradius `s`, centred at the origin), so a tile's
// painted features line up exactly with the edge a neighbour will present.

import { dirAngle, edgeMid, type Dir6 } from '../hexgrid';

/** Corner (vertex) `k` of the hex — the vertex between edge `k` and edge `k+1`, at angle (2k+1)·30°. */
export function vertex(k: number, s: number): [number, number] {
  const a = ((2 * k + 1) * Math.PI) / 6;
  return [s * Math.cos(a), s * Math.sin(a)];
}

/** Unit inward normal of edge `d` (pointing from its midpoint toward the cell centre). */
export function inwardNormal(d: Dir6): [number, number] {
  const a = dirAngle(d) + Math.PI;
  return [Math.cos(a), Math.sin(a)];
}

/** Midpoint of edge `d` at apothem distance. Re-exported for tilesets that only import this module. */
export { edgeMid };

/**
 * Stroke a smooth ribbon connecting the midpoints of edges `a` and `b`, leaving each edge along its
 * inward normal so abutting tiles meet tangentially. A cubic Bézier whose control points sit on the
 * two inward normals — the workhorse of the weave and path sets.
 */
export function ribbon(
  ctx: CanvasRenderingContext2D,
  a: Dir6,
  b: Dir6,
  s: number,
  pull: number,
): void {
  const [ax, ay] = edgeMid(a, s);
  const [bx, by] = edgeMid(b, s);
  const [anx, any] = inwardNormal(a);
  const [bnx, bny] = inwardNormal(b);
  const c1x = ax + anx * s * pull;
  const c1y = ay + any * s * pull;
  const c2x = bx + bnx * s * pull;
  const c2y = by + bny * s * pull;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.bezierCurveTo(c1x, c1y, c2x, c2y, bx, by);
  ctx.stroke();
}

/** A filled dot at the cell centre (used as a junction/hub node). */
export function nub(ctx: CanvasRenderingContext2D, s: number, r: number, fill: string): void {
  ctx.beginPath();
  ctx.arc(0, 0, r * s, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

/** Stroke a spoke from the cell centre out to the midpoint of edge `d`. */
export function spoke(ctx: CanvasRenderingContext2D, d: Dir6, s: number): void {
  const [mx, my] = edgeMid(d, s);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(mx, my);
  ctx.stroke();
}
