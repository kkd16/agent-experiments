import type { Prototype, Tileset } from '../types';
import { centerDot, spokes } from './paint';

// Edge codes are palindromic 3-char strings: "000" = no pipe, "010" = pipe through the middle.
const O = '000';
const P = '010';

const COLOR = '#5eead4';
const GLOW = 'rgba(94,234,212,0.18)';
const W = 9;

function pipe(sides: ('N' | 'E' | 'S' | 'W')[]) {
  return (ctx: CanvasRenderingContext2D, size: number) =>
    spokes(ctx, size, sides, { color: COLOR, width: W, hub: sides.length > 2 ? 6 : 0, glow: GLOW });
}

const protos: Prototype[] = [
  {
    name: 'empty',
    edges: [O, O, O, O],
    symmetry: 'X',
    weight: 1.1,
    draw: (ctx, size) => centerDot(ctx, size, 'rgba(94,234,212,0.25)', 2),
  },
  { name: 'line', edges: [P, O, P, O], symmetry: 'I', weight: 1.0, draw: pipe(['N', 'S']) },
  { name: 'elbow', edges: [P, P, O, O], symmetry: 'L', weight: 1.0, draw: pipe(['N', 'E']) },
  { name: 'tee', edges: [P, P, P, O], symmetry: 'T', weight: 0.45, draw: pipe(['N', 'E', 'S']) },
  { name: 'cross', edges: [P, P, P, P], symmetry: 'X', weight: 0.2, draw: pipe(['N', 'E', 'S', 'W']) },
  {
    name: 'end',
    edges: [P, O, O, O],
    symmetry: 'T',
    weight: 0.18,
    draw: (ctx, size) => {
      spokes(ctx, size, ['N'], { color: COLOR, width: W, glow: GLOW });
      centerDot(ctx, size, COLOR, 6);
    },
  },
];

export const knots: Tileset = {
  key: 'knots',
  name: 'Knots',
  blurb: 'Pipework that must join end-to-end — mazes, loops and dead-ends self-assemble.',
  background: '#0b1220',
  prototypes: protos,
};
