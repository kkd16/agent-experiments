// Hex Paths — a road / transit network on the hex lattice. Every edge is either road `r` or blank
// `0`, so a road edge only ever abuts another road edge: collapsed boards lay down a continuous web
// of streets with bends, junctions and the occasional cul-de-sac. Two-exit tiles are drawn as
// smooth ribbons; three- and six-way tiles meet at a round junction node.

import type { Dir6 } from '../hexgrid';
import type { HexTileset } from '../types_hex';
import { nub, ribbon, spoke } from './draw';

const GROUND = '#36422f';
const GROUND_HI = '#3d4a35';
const CASING = '#1c2230';
const ROAD = '#c9ccd6';
const DASH = '#f2c14e';

function ground(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.fillStyle = GROUND;
  ctx.fillRect(-s, -s, 2 * s, 2 * s);
  ctx.fillStyle = GROUND_HI;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * s * 0.5, Math.sin(a) * s * 0.5, s * 0.1, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Stroke a ribbon between two edges as a cased road with a centre dash. */
function roadRibbon(ctx: CanvasRenderingContext2D, a: Dir6, b: Dir6, s: number, pull: number): void {
  ctx.lineCap = 'round';
  ctx.strokeStyle = CASING;
  ctx.lineWidth = s * 0.42;
  ribbon(ctx, a, b, s, pull);
  ctx.strokeStyle = ROAD;
  ctx.lineWidth = s * 0.3;
  ribbon(ctx, a, b, s, pull);
  ctx.save();
  ctx.setLineDash([s * 0.16, s * 0.16]);
  ctx.strokeStyle = DASH;
  ctx.lineWidth = s * 0.05;
  ribbon(ctx, a, b, s, pull);
  ctx.restore();
}

/** Draw cased spokes from the centre to each listed edge, then a junction node. */
function roadHub(ctx: CanvasRenderingContext2D, dirs: Dir6[], s: number): void {
  ctx.lineCap = 'round';
  ctx.strokeStyle = CASING;
  ctx.lineWidth = s * 0.42;
  for (const d of dirs) spoke(ctx, d, s);
  ctx.strokeStyle = ROAD;
  ctx.lineWidth = s * 0.3;
  for (const d of dirs) spoke(ctx, d, s);
  nub(ctx, s, 0.2, ROAD);
  nub(ctx, s, 0.1, CASING);
}

export const paths: HexTileset = {
  key: 'paths',
  name: 'Paths',
  blurb: 'A road network — bends, chicanes, T-junctions and roundabouts wire themselves into a continuous web; blank edges keep the verges apart.',
  background: GROUND,
  prototypes: [
    { name: 'blank', edges: ['0', '0', '0', '0', '0', '0'], rotations: 1, weight: 1.6, draw: (ctx, s) => ground(ctx, s) },
    {
      name: 'cap',
      edges: ['r', '0', '0', '0', '0', '0'],
      rotations: 6,
      weight: 0.5,
      draw: (ctx, s) => {
        ground(ctx, s);
        roadHub(ctx, [0], s);
      },
    },
    {
      name: 'through',
      edges: ['r', '0', '0', 'r', '0', '0'],
      rotations: 3,
      weight: 1.4,
      draw: (ctx, s) => {
        ground(ctx, s);
        roadRibbon(ctx, 0, 3, s, 0.45);
      },
    },
    {
      name: 'bend',
      edges: ['r', 'r', '0', '0', '0', '0'],
      rotations: 6,
      weight: 1.2,
      draw: (ctx, s) => {
        ground(ctx, s);
        roadRibbon(ctx, 0, 1, s, 0.55);
      },
    },
    {
      name: 'chicane',
      edges: ['r', '0', 'r', '0', '0', '0'],
      rotations: 6,
      weight: 0.9,
      draw: (ctx, s) => {
        ground(ctx, s);
        roadRibbon(ctx, 0, 2, s, 0.5);
      },
    },
    {
      name: 'tee',
      edges: ['r', '0', 'r', '0', 'r', '0'],
      rotations: 2,
      weight: 0.8,
      draw: (ctx, s) => {
        ground(ctx, s);
        roadHub(ctx, [0, 2, 4], s);
      },
    },
    {
      name: 'hub',
      edges: ['r', 'r', 'r', 'r', 'r', 'r'],
      rotations: 1,
      weight: 0.35,
      draw: (ctx, s) => {
        ground(ctx, s);
        roadHub(ctx, [0, 1, 2, 3, 4, 5], s);
      },
    },
  ],
};
