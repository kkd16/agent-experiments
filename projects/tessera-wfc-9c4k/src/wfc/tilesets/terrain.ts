import type { Prototype, Tileset } from '../types';

// Corner-coded terrain (the classic WFC "marching-squares" trick). Each tile is defined by the
// terrain LEVEL at its four corners [NW, NE, SE, SW]; the body is bilinearly interpolated, so
// coastlines fall out organically. An edge's code is the pair of corner levels along it, read
// clockwise — neighbours match because they share those corner values.

const LEVELS = 4; // deep water, sand, grass, forest

// colour ramp keyed by continuous level v in [0, LEVELS-1]
const STOPS: { at: number; rgb: [number, number, number] }[] = [
  { at: 0.0, rgb: [26, 54, 120] }, // deep water
  { at: 0.6, rgb: [37, 99, 200] }, // water
  { at: 1.0, rgb: [216, 199, 142] }, // sand
  { at: 2.0, rgb: [86, 132, 52] }, // grass
  { at: 3.0, rgb: [22, 78, 44] }, // forest
];

function colorAt(v: number): [number, number, number] {
  if (v <= STOPS[0].at) return STOPS[0].rgb;
  for (let i = 1; i < STOPS.length; i++) {
    if (v <= STOPS[i].at) {
      const a = STOPS[i - 1];
      const b = STOPS[i];
      const t = (v - a.at) / (b.at - a.at);
      return [
        Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * t),
        Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * t),
        Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * t),
      ];
    }
  }
  return STOPS[STOPS.length - 1].rgb;
}

function drawCorners(corners: number[]) {
  const [nw, ne, se, sw] = corners;
  return (ctx: CanvasRenderingContext2D, size: number) => {
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let py = 0; py < size; py++) {
      const wy = py / (size - 1);
      for (let px = 0; px < size; px++) {
        const wx = px / (size - 1);
        const top = nw + (ne - nw) * wx;
        const bot = sw + (se - sw) * wx;
        const v = top + (bot - top) * wy;
        const [r, g, b] = colorAt(v);
        const o = (py * size + px) * 4;
        d[o] = r;
        d[o + 1] = g;
        d[o + 2] = b;
        d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  };
}

const code = (a: number, b: number) => `${a}${b}`;

function buildPrototypes(): Prototype[] {
  const out: Prototype[] = [];
  const adjacent = (a: number, b: number) => Math.abs(a - b) <= 1;
  for (let nw = 0; nw < LEVELS; nw++) {
    for (let ne = 0; ne < LEVELS; ne++) {
      if (!adjacent(nw, ne)) continue;
      for (let se = 0; se < LEVELS; se++) {
        if (!adjacent(ne, se)) continue;
        for (let sw = 0; sw < LEVELS; sw++) {
          if (!adjacent(se, sw) || !adjacent(sw, nw)) continue;
          const corners = [nw, ne, se, sw];
          const distinct = new Set(corners).size;
          const weight = distinct === 1 ? 2.2 : distinct === 2 ? 0.5 : 0.16;
          out.push({
            name: `t-${nw}${ne}${se}${sw}`,
            // edges read clockwise: N(L→R)=NW,NE  E(T→B)=NE,SE  S(R→L)=SE,SW  W(B→T)=SW,NW
            edges: [code(nw, ne), code(ne, se), code(se, sw), code(sw, nw)],
            symmetry: 'X', // all rotations are already enumerated as distinct corner tuples
            weight,
            draw: drawCorners(corners),
          });
        }
      }
    }
  }
  return out;
}

export const terrain: Tileset = {
  key: 'terrain',
  name: 'Terrain',
  blurb: 'Water, sand, grass and forest with bilinear coastlines — islands grow from local rules.',
  background: '#1a3678',
  prototypes: buildPrototypes(),
};
