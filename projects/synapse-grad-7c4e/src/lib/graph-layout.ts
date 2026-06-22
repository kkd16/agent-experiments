// A tiny Fruchterman–Reingold force-directed layout — no graph-drawing libraries. Nodes repel
// each other (an inverse-distance Coulomb force) while edges pull their endpoints together (a
// Hooke spring); a cooling schedule freezes the configuration into a stable, readable picture.
// Used to place the abstract graphs (SBM, Karate) that carry no intrinsic coordinates; the
// geometric kNN graphs skip this and lay out at their own points.

import { mulberry32 } from '../engine/nn';

export function forceLayout(
  n: number,
  edges: ReadonlyArray<readonly [number, number]>,
  opts: { iterations?: number; seed?: number } = {},
): Float64Array {
  const iterations = opts.iterations ?? 320;
  const rng = mulberry32((opts.seed ?? 1) >>> 0);
  const pos = new Float64Array(n * 2);
  // seed on a small circle with jitter so symmetric graphs don't start degenerate
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pos[i * 2] = Math.cos(a) * 0.6 + (rng() - 0.5) * 0.2;
    pos[i * 2 + 1] = Math.sin(a) * 0.6 + (rng() - 0.5) * 0.2;
  }
  const area = 4.0;
  const kRepel = Math.sqrt(area / Math.max(n, 1)); // ideal node separation
  const disp = new Float64Array(n * 2);
  let temp = 0.9;
  for (let it = 0; it < iterations; it++) {
    disp.fill(0);
    // repulsion between every pair
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i * 2] - pos[j * 2];
        let dy = pos[i * 2 + 1] - pos[j * 2 + 1];
        let dist = Math.hypot(dx, dy);
        if (dist < 1e-4) {
          dx = (rng() - 0.5) * 0.01;
          dy = (rng() - 0.5) * 0.01;
          dist = Math.hypot(dx, dy) || 1e-4;
        }
        const force = (kRepel * kRepel) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        disp[i * 2] += fx;
        disp[i * 2 + 1] += fy;
        disp[j * 2] -= fx;
        disp[j * 2 + 1] -= fy;
      }
    }
    // attraction along edges
    for (const [u, v] of edges) {
      const dx = pos[u * 2] - pos[v * 2];
      const dy = pos[u * 2 + 1] - pos[v * 2 + 1];
      const dist = Math.hypot(dx, dy) || 1e-4;
      const force = (dist * dist) / kRepel;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      disp[u * 2] -= fx;
      disp[u * 2 + 1] -= fy;
      disp[v * 2] += fx;
      disp[v * 2 + 1] += fy;
    }
    // step, capped by the temperature, then cool
    for (let i = 0; i < n; i++) {
      const dx = disp[i * 2];
      const dy = disp[i * 2 + 1];
      const d = Math.hypot(dx, dy) || 1e-4;
      pos[i * 2] += (dx / d) * Math.min(d, temp);
      pos[i * 2 + 1] += (dy / d) * Math.min(d, temp);
    }
    temp = Math.max(0.02, temp * 0.985);
  }
  // normalize into [-1,1] (centered, uniform scale)
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, pos[i * 2]);
    maxX = Math.max(maxX, pos[i * 2]);
    minY = Math.min(minY, pos[i * 2 + 1]);
    maxY = Math.max(maxY, pos[i * 2 + 1]);
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = ((pos[i * 2] - cx) / span) * 1.85;
    out[i * 2 + 1] = ((pos[i * 2 + 1] - cy) / span) * 1.85;
  }
  return out;
}
