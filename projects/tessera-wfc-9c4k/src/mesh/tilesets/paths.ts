// Paths — a cased road network on the irregular mesh. One connection type: every edge is road `r`
// or blank `.`, so roads only ever abut roads, and a collapsed board is a continuous web of streets
// with bends, junctions and the occasional cul-de-sac, threaded seamlessly across cells of every
// shape.

import type { Palette } from '../meshtypes';
import { makeConnectionSet, type Lane } from './factory';

const palette: Palette = {
  bg: [54, 66, 47],
  bgAlt: [61, 74, 53],
  ink: [28, 34, 48],
  a: [201, 204, 214],
  b: [201, 204, 214],
  accent: [242, 193, 78],
};

const laneFor = (_code: string, pal: Palette): Lane => ({
  color: pal.a,
  width: 0.42,
  casing: pal.ink,
  dash: pal.accent,
  dashWidth: 0.08,
});

export const paths = makeConnectionSet({
  key: 'paths',
  name: 'Paths',
  blurb: 'A cased road network — roads meet roads, so streets thread continuously across the irregular cells.',
  background: '#12160f',
  palette,
  laneFor,
  protos: [
    { name: 'blank', sockets: ['.', '.', '.', '.'], symmetry: 'X', weight: 1.1 },
    { name: 'end', sockets: ['r', '.', '.', '.'], symmetry: 'T', weight: 0.25 },
    { name: 'straight', sockets: ['r', '.', 'r', '.'], symmetry: 'I', weight: 1.4 },
    { name: 'curve', sockets: ['r', 'r', '.', '.'], symmetry: 'L', weight: 1.5 },
    { name: 'tee', sockets: ['r', 'r', 'r', '.'], symmetry: 'T', weight: 0.7 },
    { name: 'cross', sockets: ['r', 'r', 'r', 'r'], symmetry: 'X', weight: 0.35 },
  ],
});
