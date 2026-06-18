import type { Prototype, Tileset } from '../types';

// Classic Truchet tiles: two quarter-arcs per tile, each joining a pair of adjacent edge
// midpoints. Every edge carries a connection at its midpoint, so *any* tile meets *any* tile —
// the arcs always join up. The two orientations (NW·SE and NE·SW) are kept as separate
// prototypes because the rotation-dedup in `compile` would otherwise fold them together (their
// edge codes are identical). Scattering the two orientations is what grows the iconic
// labyrinth of interlocking loops.
const P = '010'; // every edge connects at its midpoint

const INK = '#f472b6';
const GLOW = 'rgba(244,114,182,0.18)';
const W = 7;

/** A quarter-arc centred on corner (cx,cy) of radius size/2, drawn with a soft glow. */
function arc(ctx: CanvasRenderingContext2D, size: number, cx: number, cy: number, a0: number, a1: number) {
  const r = size / 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = GLOW;
  ctx.lineWidth = W + 6;
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a1);
  ctx.stroke();
  ctx.strokeStyle = INK;
  ctx.lineWidth = W;
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a1);
  ctx.stroke();
}

const protos: Prototype[] = [
  {
    name: 'arc-a', // NW corner + SE corner
    edges: [P, P, P, P],
    symmetry: 'X',
    weight: 1,
    draw: (ctx, size) => {
      arc(ctx, size, 0, 0, 0, Math.PI / 2); // top-left corner: joins N & W mids
      arc(ctx, size, size, size, Math.PI, (3 * Math.PI) / 2); // bottom-right: joins S & E mids
    },
  },
  {
    name: 'arc-b', // NE corner + SW corner
    edges: [P, P, P, P],
    symmetry: 'X',
    weight: 1,
    draw: (ctx, size) => {
      arc(ctx, size, size, 0, Math.PI / 2, Math.PI); // top-right: joins N & E mids
      arc(ctx, size, 0, size, (3 * Math.PI) / 2, Math.PI * 2); // bottom-left: joins S & W mids
    },
  },
];

export const truchet: Tileset = {
  key: 'truchet',
  name: 'Truchet',
  blurb: 'Two quarter-arc orientations that always join — interlocking loops and labyrinths emerge.',
  background: '#13091a',
  prototypes: protos,
};
