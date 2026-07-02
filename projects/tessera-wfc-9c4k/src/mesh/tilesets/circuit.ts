// Circuit — two independent signal networks that share the board without ever touching. Data lines
// (`a`, cyan) and power lines (`b`, magenta) each only connect to their own kind, so an `a` edge
// must meet an `a` edge and a `b` edge a `b` edge; a cross tile carries one of each straight through,
// letting the two nets weave over one another. Neon traces on a dark board.

import type { Palette } from '../meshtypes';
import { makeConnectionSet, type Lane } from './factory';

const palette: Palette = {
  bg: [18, 22, 33],
  bgAlt: [24, 30, 44],
  ink: [8, 10, 18],
  a: [72, 214, 214],
  b: [226, 92, 196],
  accent: [240, 240, 200],
};

const laneFor = (code: string, pal: Palette): Lane => ({
  color: code === 'b' ? pal.b : pal.a,
  width: 0.3,
  casing: pal.ink,
});

export const circuit = makeConnectionSet({
  key: 'circuit',
  name: 'Circuit',
  blurb: 'Two signal nets — cyan data, magenta power — each joining only its own kind, crossing without touching.',
  background: '#080a12',
  palette,
  protos: [
    { name: 'blank', sockets: ['.', '.', '.', '.'], symmetry: 'X', weight: 1.0 },
    { name: 'a-line', sockets: ['a', '.', 'a', '.'], symmetry: 'I', weight: 1.2 },
    { name: 'a-bend', sockets: ['a', 'a', '.', '.'], symmetry: 'L', weight: 1.1 },
    { name: 'a-tee', sockets: ['a', 'a', 'a', '.'], symmetry: 'T', weight: 0.4 },
    { name: 'b-line', sockets: ['b', '.', 'b', '.'], symmetry: 'I', weight: 1.2 },
    { name: 'b-bend', sockets: ['b', 'b', '.', '.'], symmetry: 'L', weight: 1.1 },
    { name: 'b-tee', sockets: ['b', 'b', 'b', '.'], symmetry: 'T', weight: 0.4 },
    { name: 'cross', sockets: ['a', 'b', 'a', 'b'], symmetry: 'I', weight: 0.8 },
    { name: 'corner', sockets: ['a', 'a', 'b', 'b'], symmetry: 'L', weight: 0.6 },
  ],
  laneFor,
});
