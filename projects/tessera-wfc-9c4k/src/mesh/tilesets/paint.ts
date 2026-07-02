// Shared painters for the mesh tilesets. Every tile is drawn *live* into its real (irregular)
// polygon — there is no pre-rendered bitmap to blit, because no two cells are the same shape. A
// connection tile is drawn by joining the midpoints of its open edges: two open edges become one
// smooth ribbon bowed through the centroid; three or more become cased spokes meeting at a hub node.
// Because a road always leaves at an *edge midpoint*, and the neighbour's matching road enters at
// that same shared midpoint, the network is seamless across the irregular seams for free.

import type { CellGeom, Palette, RGB } from '../meshtypes';
import { rgb } from '../meshtypes';
import type { Vec2 } from '../mesh';

export function fillCell(ctx: CanvasRenderingContext2D, poly: Vec2[], color: string): void {
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

export function strokeCell(ctx: CanvasRenderingContext2D, poly: Vec2[], color: string, w: number): void {
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.stroke();
}

type Lane = { color: RGB; width: number; casing?: RGB; dash?: RGB; dashWidth?: number };

/** A gently pulled quadratic ribbon from `a` through (near) the centroid to `b`. */
function ribbonPath(ctx: CanvasRenderingContext2D, a: Vec2, c: Vec2, b: Vec2): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
}

function spokePath(ctx: CanvasRenderingContext2D, a: Vec2, c: Vec2): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(c.x, c.y);
}

/**
 * Draw one connection lane over the open edges of a cell. `slots` are the local edge-slots this lane
 * occupies. Two slots → a single ribbon; otherwise spokes to a hub. Casing is stroked first, then
 * the coloured lane on top, then an optional centre dash.
 */
export function drawLane(ctx: CanvasRenderingContext2D, g: CellGeom, slots: number[], lane: Lane): void {
  if (slots.length === 0) return;
  const r = g.inradius;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const stroke = (color: RGB, width: number, build: () => void) => {
    build();
    ctx.strokeStyle = rgb(color);
    ctx.lineWidth = Math.max(0.6, width * r);
    ctx.stroke();
  };

  if (slots.length === 2) {
    const a = g.mids[slots[0]];
    const b = g.mids[slots[1]];
    const c = g.centroid;
    if (lane.casing) stroke(lane.casing, lane.width + 0.34, () => ribbonPath(ctx, a, c, b));
    stroke(lane.color, lane.width, () => ribbonPath(ctx, a, c, b));
    if (lane.dash) {
      ctx.save();
      ctx.setLineDash([r * 0.32, r * 0.3]);
      stroke(lane.dash, lane.dashWidth ?? lane.width * 0.28, () => ribbonPath(ctx, a, c, b));
      ctx.restore();
    }
    return;
  }

  const c = g.centroid;
  if (lane.casing) for (const s of slots) stroke(lane.casing, lane.width + 0.34, () => spokePath(ctx, g.mids[s], c));
  for (const s of slots) stroke(lane.color, lane.width, () => spokePath(ctx, g.mids[s], c));
  // hub node
  ctx.beginPath();
  ctx.arc(c.x, c.y, Math.max(1, (lane.width * 0.62) * r), 0, Math.PI * 2);
  ctx.fillStyle = rgb(lane.color);
  ctx.fill();
}

/** A subtle two-tone cell fill so the board reads as a surface, not flat colour. */
export function paintGround(ctx: CanvasRenderingContext2D, g: CellGeom, pal: Palette): void {
  fillCell(ctx, g.poly, rgb(pal.bg));
  // a faint centre glow toward bgAlt for depth
  const grad = ctx.createRadialGradient(g.centroid.x, g.centroid.y, 0, g.centroid.x, g.centroid.y, g.inradius * 1.6);
  grad.addColorStop(0, rgb(pal.bgAlt));
  grad.addColorStop(1, rgb(pal.bg));
  ctx.globalAlpha = 0.5;
  fillCellPath(ctx, g.poly);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function fillCellPath(ctx: CanvasRenderingContext2D, poly: Vec2[]): void {
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
}

/** Group a variant's open slots by their socket character. */
export function lanesBySocket(sockets: string[], empty: string): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (let s = 0; s < 4; s++) {
    const code = sockets[s];
    if (code === empty) continue;
    let list = m.get(code);
    if (!list) m.set(code, (list = []));
    list.push(s);
  }
  return m;
}
