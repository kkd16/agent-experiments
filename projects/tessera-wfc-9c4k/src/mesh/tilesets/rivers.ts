// Rivers — a single-type water network, weighted to *meander*: straights and curves are common,
// junctions rare, so collapsed boards read as sparse rivers winding through green land rather than a
// dense grid of roads. Same connection algebra as Paths; only the palette and the weights differ —
// a nice demonstration that the *look* of a WFC output is tuned by frequency, not by new rules.

import type { Palette } from '../meshtypes';
import { makeConnectionSet, type Lane } from './factory';

const palette: Palette = {
  bg: [46, 74, 52],
  bgAlt: [54, 86, 60],
  ink: [22, 46, 58],
  a: [86, 158, 214],
  b: [86, 158, 214],
  accent: [176, 214, 236],
};

const laneFor = (_code: string, pal: Palette): Lane => ({
  color: pal.a,
  width: 0.5,
  casing: pal.ink,
  dash: pal.accent,
  dashWidth: 0.06,
});

export const rivers = makeConnectionSet({
  key: 'rivers',
  name: 'Rivers',
  blurb: 'A sparse, meandering water network — curves and straights dominate, junctions are rare.',
  background: '#0d1710',
  palette,
  laneFor,
  protos: [
    { name: 'land', sockets: ['.', '.', '.', '.'], symmetry: 'X', weight: 2.4 },
    { name: 'spring', sockets: ['r', '.', '.', '.'], symmetry: 'T', weight: 0.18 },
    { name: 'reach', sockets: ['r', '.', 'r', '.'], symmetry: 'I', weight: 1.5 },
    { name: 'bend', sockets: ['r', 'r', '.', '.'], symmetry: 'L', weight: 1.8 },
    { name: 'fork', sockets: ['r', 'r', 'r', '.'], symmetry: 'T', weight: 0.3 },
  ],
});
