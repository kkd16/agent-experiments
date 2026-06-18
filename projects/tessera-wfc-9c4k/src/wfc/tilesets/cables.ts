import type { Prototype, Tileset } from '../types';
import { centerDot, spokes } from './paint';

// Coloured wiring. Each wire colour is its own connection class, so a red wire only ever joins
// another red wire. Edge codes: "000" = none, "0c0" with c in {1,2,3} = a wire of colour c.
const O = '000';
const code = (c: number) => `0${c}0`;
const COLORS = ['#f472b6', '#38bdf8', '#a3e635']; // 1, 2, 3
const W = 7;

function wire(sides: ('N' | 'E' | 'S' | 'W')[], c: number) {
  const color = COLORS[c - 1];
  return (ctx: CanvasRenderingContext2D, size: number) =>
    spokes(ctx, size, sides, { color, width: W, hub: sides.length > 2 ? 5 : 0 });
}

const protos: Prototype[] = [
  { name: 'bare', edges: [O, O, O, O], symmetry: 'X', weight: 1.0, draw: (ctx, s) => centerDot(ctx, s, 'rgba(148,163,184,0.25)', 2) },
];

// straights + elbows for each colour
for (let c = 1; c <= 3; c++) {
  protos.push({ name: `wire${c}-straight`, edges: [code(c), O, code(c), O], symmetry: 'I', weight: 0.85, draw: wire(['N', 'S'], c) });
  protos.push({ name: `wire${c}-elbow`, edges: [code(c), code(c), O, O], symmetry: 'L', weight: 0.7, draw: wire(['N', 'E'], c) });
}

// two-colour crossovers (the vertical wire drawn under, horizontal over)
const pairs: [number, number][] = [
  [1, 2],
  [1, 3],
  [2, 3],
];
for (const [a, b] of pairs) {
  protos.push({
    name: `cross-${a}-${b}`,
    edges: [code(a), code(b), code(a), code(b)],
    symmetry: 'I',
    weight: 0.28,
    draw: (ctx, size) => {
      wire(['N', 'S'], a)(ctx, size);
      // gap so the over-wire reads as weaving over the under-wire
      ctx.save();
      ctx.strokeStyle = '#0b1220';
      ctx.lineCap = 'round';
      ctx.lineWidth = W + 5;
      ctx.beginPath();
      ctx.moveTo(0, size / 2);
      ctx.lineTo(size, size / 2);
      ctx.stroke();
      ctx.restore();
      wire(['E', 'W'], b)(ctx, size);
    },
  });
}

export const cables: Tileset = {
  key: 'cables',
  name: 'Cables',
  blurb: 'Three colours of wire that only join their own kind, weaving over and under.',
  background: '#0b1220',
  prototypes: protos,
};
