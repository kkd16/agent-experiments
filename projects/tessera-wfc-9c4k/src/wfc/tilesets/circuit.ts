import type { Prototype, Tileset } from '../types';
import { centerDot, spokes } from './paint';

// PCB traces. "000" = bare substrate, "010" = a copper trace crossing the edge.
const O = '000';
const T = '010';

const COPPER = '#fbbf24';
const GLOW = 'rgba(251,191,36,0.16)';
const W = 6;

function trace(sides: ('N' | 'E' | 'S' | 'W')[], hub = 0) {
  return (ctx: CanvasRenderingContext2D, size: number) =>
    spokes(ctx, size, sides, { color: COPPER, width: W, hub, glow: GLOW });
}

const protos: Prototype[] = [
  {
    name: 'substrate',
    edges: [O, O, O, O],
    symmetry: 'X',
    weight: 1.3,
    draw: (ctx, size) => {
      // faint solder-mask texture: a couple of vias
      ctx.fillStyle = 'rgba(16,185,129,0.18)';
      ctx.fillRect(size * 0.18, size * 0.18, size * 0.1, size * 0.1);
      centerDot(ctx, size, 'rgba(16,185,129,0.35)', 2);
    },
  },
  { name: 'trace', edges: [T, O, T, O], symmetry: 'I', weight: 1.0, draw: trace(['N', 'S']) },
  { name: 'bend', edges: [T, T, O, O], symmetry: 'L', weight: 0.9, draw: trace(['N', 'E']) },
  { name: 'fanout', edges: [T, T, T, O], symmetry: 'T', weight: 0.4, draw: trace(['N', 'E', 'S'], 5) },
  { name: 'junction', edges: [T, T, T, T], symmetry: 'X', weight: 0.18, draw: trace(['N', 'E', 'S', 'W'], 5) },
  {
    name: 'pad',
    edges: [T, T, T, T],
    symmetry: 'X',
    weight: 0.14,
    draw: (ctx, size) => {
      trace(['N', 'E', 'S', 'W'])(ctx, size);
      ctx.fillStyle = COPPER;
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0c1a14';
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size * 0.1, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  {
    name: 'chip',
    edges: [O, O, O, O],
    symmetry: 'X',
    weight: 0.12,
    draw: (ctx, size) => {
      ctx.fillStyle = '#111827';
      ctx.strokeStyle = '#374151';
      ctx.lineWidth = 1.5;
      const m = size * 0.24;
      ctx.fillRect(m, m, size - 2 * m, size - 2 * m);
      ctx.strokeRect(m, m, size - 2 * m, size - 2 * m);
      ctx.fillStyle = COPPER;
      centerDot(ctx, size, COPPER, 2.4);
    },
  },
];

export const circuit: Tileset = {
  key: 'circuit',
  name: 'Circuit',
  blurb: 'Copper traces route across a green PCB, fanning into pads, vias and chips.',
  background: '#07140f',
  prototypes: protos,
};
