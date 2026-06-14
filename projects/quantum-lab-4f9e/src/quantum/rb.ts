import { Complex, C } from './Complex';
import type { Matrix } from './Matrix';
import { getSingleGateMatrix } from './gates/single';
import { DensityMatrix } from './DensityMatrix';
import { krausOps, type ChannelType } from './noise';
import type { GateOp } from './QuantumState';

/**
 * Single-qubit **randomized benchmarking** (Magesan, Gambetta & Emerson, 2011).
 *
 * Apply m random Clifford gates followed by the single recovery Clifford that inverts the
 * whole sequence; with perfect gates the qubit always returns to |0⟩. Under noise the
 * survival probability decays as  p(m) = B + A·f^m,  and because random Cliffords *twirl*
 * any error into a depolarizing channel, the decay rate f isolates the average gate error
 *
 *     r = (1 − f)(d − 1)/d      (d = 2 for one qubit)
 *
 * independent of state-prep and measurement errors. Here the "hardware" is the exact
 * density-matrix engine, so each sequence's survival is computed without shot noise.
 */

interface Clifford {
  ops: GateOp[];
  mat: Matrix; // 2×2 unitary (up to global phase)
}

function matmul2(a: Matrix, b: Matrix): Matrix {
  return [
    [a[0][0].mul(b[0][0]).add(a[0][1].mul(b[1][0])), a[0][0].mul(b[0][1]).add(a[0][1].mul(b[1][1]))],
    [a[1][0].mul(b[0][0]).add(a[1][1].mul(b[1][0])), a[1][0].mul(b[0][1]).add(a[1][1].mul(b[1][1]))],
  ];
}

/** |Tr(A·B)| — equals 2 iff A and B are inverse up to a global phase (for 2×2 unitaries). */
function absTrace(a: Matrix, b: Matrix): number {
  const t = a[0][0].mul(b[0][0]).add(a[0][1].mul(b[1][0]))
    .add(a[1][0].mul(b[0][1])).add(a[1][1].mul(b[1][1]));
  return t.abs();
}

/** Enumerate the 24 single-qubit Cliffords as gate sequences (BFS over {H, S}). */
export function singleQubitCliffords(): Clifford[] {
  const gens: { name: string; mat: Matrix }[] = [
    { name: 'H', mat: getSingleGateMatrix('H')! },
    { name: 'S', mat: getSingleGateMatrix('S')! },
  ];
  const key = (m: Matrix): string => {
    // Canonicalise away the global phase by rotating so the first nonzero entry is real+.
    const pivot = m[0][0].abs() > 1e-6 ? m[0][0] : m[0][1];
    const ph = pivot.abs() > 1e-9 ? pivot.scale(1 / pivot.abs()) : C(1);
    const norm = (z: Complex) => z.div(ph);
    return m.flat().map((z) => { const w = norm(z); return `${w.re.toFixed(3)},${w.im.toFixed(3)}`; }).join('|');
  };
  const I: Matrix = [[C(1), C(0)], [C(0), C(1)]];
  const seen = new Map<string, Clifford>();
  const start: Clifford = { ops: [], mat: I };
  seen.set(key(I), start);
  const queue: Clifford[] = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const g of gens) {
      const mat = matmul2(g.mat, cur.mat); // left-multiply: apply g after cur
      const k = key(mat);
      if (!seen.has(k)) {
        const cliff: Clifford = { ops: [...cur.ops, { name: g.name, qubits: [0] }], mat };
        seen.set(k, cliff);
        queue.push(cliff);
      }
    }
  }
  return [...seen.values()];
}

export interface RBPoint { length: number; survival: number; }
export interface RBFit { A: number; f: number; B: number; r: number; }
export interface RBResult {
  points: RBPoint[];
  fit: RBFit;
  channel: ChannelType;
  strength: number;
  curve: (m: number) => number;
}

/** Least-squares fit of p(m) = B + A·f^m with the RB asymptote fixed at B = 1/2. */
function fitDecay(points: RBPoint[]): RBFit {
  const B = 0.5;
  const xs: number[] = [], ys: number[] = [];
  for (const p of points) {
    const z = p.survival - B;
    if (z > 1e-6) { xs.push(p.length); ys.push(Math.log(z)); }
  }
  if (xs.length < 2) return { A: 0.5, f: 1, B, r: 0 };
  const nn = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / nn;
  const my = ys.reduce((a, b) => a + b, 0) / nn;
  let num = 0, den = 0;
  for (let i = 0; i < nn; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den > 1e-12 ? num / den : 0;
  const intercept = my - slope * mx;
  const f = Math.min(1, Math.exp(slope));
  const A = Math.exp(intercept);
  const r = ((1 - f) * 1) / 2; // (1-f)(d-1)/d, d=2
  return { A, f, B, r };
}

export interface RBOptions {
  lengths?: number[];
  sequences?: number;
  channel?: ChannelType;
  strength?: number;
  rng?: () => number;
}

/** Run single-qubit RB and return survival points plus the fitted decay & average error. */
export function randomizedBenchmark(opts: RBOptions = {}): RBResult {
  const lengths = opts.lengths ?? [1, 2, 4, 8, 16, 32, 64];
  const sequences = opts.sequences ?? 12;
  const channel = opts.channel ?? 'depolarizing';
  const strength = opts.strength ?? 0.04;
  const rng = opts.rng ?? Math.random;
  const cliffs = singleQubitCliffords();
  const kraus = strength > 1e-9 ? krausOps(channel, strength) : null;

  const points: RBPoint[] = lengths.map((m) => {
    let total = 0;
    for (let s = 0; s < sequences; s++) {
      // Sample m random Cliffords, then the exact inverse of their product.
      const seq: Clifford[] = [];
      let net: Matrix = [[C(1), C(0)], [C(0), C(1)]];
      for (let k = 0; k < m; k++) {
        const c = cliffs[Math.floor(rng() * cliffs.length)];
        seq.push(c);
        net = matmul2(c.mat, net);
      }
      // Recovery Clifford = element whose matrix inverts `net` (maximises |Tr(net·c)|).
      let inv = cliffs[0], bestTr = -1;
      for (const c of cliffs) { const tr = absTrace(net, c.mat); if (tr > bestTr) { bestTr = tr; inv = c; } }
      seq.push(inv);

      // Exact survival on the density-matrix engine, one noise channel per Clifford.
      const dm = new DensityMatrix(1);
      for (const c of seq) {
        for (const op of c.ops) dm.applyGate(op);
        if (kraus) dm.applyChannel(kraus, [0]);
      }
      total += dm.probabilities()[0]; // ⟨0|ρ|0⟩
    }
    return { length: m, survival: total / sequences };
  });

  const fit = fitDecay(points);
  return { points, fit, channel, strength, curve: (m: number) => fit.B + fit.A * fit.f ** m };
}
