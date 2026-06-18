import type { Prototype, Tileset } from '../types';
import { centerDot } from './paint';

// Railway tracks: a ballast bed, two steel rails, and perpendicular sleepers. Unlike the
// always-connecting Truchet set, an edge either carries a track ("010") or bare gravel ("000"),
// so the solver must route continuous lines — straights, curves and crossings — through fields
// of empty ground, which is where the constraint propagation actually bites.
const O = '000';
const R = '010';

const BED = '#3f3f46';
const RAIL = '#d4d4d8';
const SLEEPER = '#7c5b3f';
const BEDW = 15;
const GAUGE = 4.2; // half the distance between the two rails
const TIE = 9; // half-length of a sleeper

function railStraight(ctx: CanvasRenderingContext2D, size: number) {
  const c = size / 2;
  // ballast bed
  ctx.lineCap = 'butt';
  ctx.strokeStyle = BED;
  ctx.lineWidth = BEDW;
  seg(ctx, c, 0, c, size);
  // sleepers
  ctx.strokeStyle = SLEEPER;
  ctx.lineWidth = 3;
  for (let y = size * 0.12; y < size; y += size * 0.2) seg(ctx, c - TIE, y, c + TIE, y);
  // rails
  ctx.strokeStyle = RAIL;
  ctx.lineWidth = 1.8;
  seg(ctx, c - GAUGE, 0, c - GAUGE, size);
  seg(ctx, c + GAUGE, 0, c + GAUGE, size);
}

function railCurve(ctx: CanvasRenderingContext2D, size: number) {
  // quarter turn joining N-mid and E-mid, centred on the NE corner
  const cx = size;
  const cy = 0;
  const r = size / 2;
  const a0 = Math.PI / 2;
  const a1 = Math.PI;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = BED;
  ctx.lineWidth = BEDW;
  arcSeg(ctx, cx, cy, r, a0, a1);
  // sleepers radiate from the curve centre
  ctx.strokeStyle = SLEEPER;
  ctx.lineWidth = 3;
  const steps = 5;
  for (let i = 1; i < steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    seg(ctx, cx + (r - TIE) * dx, cy + (r - TIE) * dy, cx + (r + TIE) * dx, cy + (r + TIE) * dy);
  }
  // rails
  ctx.strokeStyle = RAIL;
  ctx.lineWidth = 1.8;
  arcSeg(ctx, cx, cy, r - GAUGE, a0, a1);
  arcSeg(ctx, cx, cy, r + GAUGE, a0, a1);
}

function railCross(ctx: CanvasRenderingContext2D, size: number) {
  railStraight(ctx, size);
  ctx.save();
  // rotate 90° about centre to lay the perpendicular track on top
  ctx.translate(size / 2, size / 2);
  ctx.rotate(Math.PI / 2);
  ctx.translate(-size / 2, -size / 2);
  railStraight(ctx, size);
  ctx.restore();
}

function seg(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function arcSeg(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, a0: number, a1: number) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a1);
  ctx.stroke();
}

const protos: Prototype[] = [
  {
    name: 'gravel',
    edges: [O, O, O, O],
    symmetry: 'X',
    weight: 1.4,
    draw: (ctx, size) => centerDot(ctx, size, 'rgba(124,91,63,0.25)', 1.5),
  },
  { name: 'straight', edges: [R, O, R, O], symmetry: 'I', weight: 1.1, draw: railStraight },
  { name: 'curve', edges: [R, R, O, O], symmetry: 'L', weight: 0.9, draw: railCurve },
  { name: 'crossing', edges: [R, R, R, R], symmetry: 'X', weight: 0.18, draw: railCross },
  {
    name: 'buffer',
    edges: [R, O, O, O],
    symmetry: 'T',
    weight: 0.12,
    draw: (ctx, size) => {
      const c = size / 2;
      ctx.strokeStyle = BED;
      ctx.lineCap = 'butt';
      ctx.lineWidth = BEDW;
      seg(ctx, c, 0, c, c);
      ctx.strokeStyle = RAIL;
      ctx.lineWidth = 1.8;
      seg(ctx, c - GAUGE, 0, c - GAUGE, c);
      seg(ctx, c + GAUGE, 0, c + GAUGE, c);
      // buffer stop
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 4;
      seg(ctx, c - TIE, c, c + TIE, c);
    },
  },
];

export const rails: Tileset = {
  key: 'rails',
  name: 'Rails',
  blurb: 'Steel rails on a sleepered bed route across gravel — straights, curves, crossings and buffer stops.',
  background: '#0a0a0b',
  emptyEdge: '000',
  prototypes: protos,
};
