// Hex Pipes — two colours of conduit (red `r`, teal `b`) plus blank `0`. A coloured edge only fits
// the same colour, so a pipe must run unbroken from board-edge to board-edge (or loop) and the two
// colours weave past one another at crossings. The all-blank tile guarantees a solution always
// exists; the colour constraints make the ones the solver finds genuinely interlock.

import type { Dir6 } from '../hexgrid';
import type { HexEdges, HexPrototype, HexTileset } from '../types_hex';
import { ribbon } from './draw';

const BG = '#101620';
const PANEL = '#16202e';
const CASING = '#070b12';
const RED = '#e2574b';
const TEAL = '#2fb6c4';

function panel(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.fillStyle = BG;
  ctx.fillRect(-s, -s, 2 * s, 2 * s);
  ctx.strokeStyle = PANEL;
  ctx.lineWidth = s * 0.04;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(-s, i * s * 0.4);
    ctx.lineTo(s, i * s * 0.4);
    ctx.stroke();
  }
}

function pipe(ctx: CanvasRenderingContext2D, a: Dir6, b: Dir6, s: number, color: string, pull: number): void {
  ctx.lineCap = 'round';
  ctx.strokeStyle = CASING;
  ctx.lineWidth = s * 0.36;
  ribbon(ctx, a, b, s, pull);
  ctx.strokeStyle = color;
  ctx.lineWidth = s * 0.24;
  ribbon(ctx, a, b, s, pull);
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = s * 0.06;
  ribbon(ctx, a, b, s, pull);
}

function straight(name: string, code: string, color: string, weight: number): HexPrototype {
  const edges = ['0', '0', '0', '0', '0', '0'] as HexEdges;
  edges[0] = code;
  edges[3] = code;
  return { name, edges, rotations: 3, weight, draw: (ctx, s) => { panel(ctx, s); pipe(ctx, 0, 3, s, color, 0.45); } };
}

function bend(name: string, code: string, color: string, weight: number): HexPrototype {
  const edges = ['0', '0', '0', '0', '0', '0'] as HexEdges;
  edges[0] = code;
  edges[1] = code;
  return { name, edges, rotations: 6, weight, draw: (ctx, s) => { panel(ctx, s); pipe(ctx, 0, 1, s, color, 0.55); } };
}

export const pipes: HexTileset = {
  key: 'pipes',
  name: 'Pipes',
  blurb: 'Two colours of conduit that only meet their own kind, so each runs unbroken across the board and the colours interlace at crossings; the blank tile keeps it always solvable.',
  background: BG,
  prototypes: [
    { name: 'blank', edges: ['0', '0', '0', '0', '0', '0'], rotations: 1, weight: 2.0, draw: (ctx, s) => panel(ctx, s) },
    straight('r-straight', 'r', RED, 1.0),
    bend('r-bend', 'r', RED, 0.9),
    straight('b-straight', 'b', TEAL, 1.0),
    bend('b-bend', 'b', TEAL, 0.9),
    {
      name: 'cross',
      edges: ['r', 'b', '0', 'r', 'b', '0'],
      rotations: 6,
      weight: 0.6,
      draw: (ctx, s) => {
        panel(ctx, s);
        pipe(ctx, 0, 3, s, RED, 0.45);
        pipe(ctx, 1, 4, s, TEAL, 0.45);
      },
    },
  ],
};
