// Fault tolerance in *space-time*: the phenomenological noise model and its 3-D decoding.
//
// The 6.0 surface code assumed perfect, instantaneous syndrome measurement (the "code
// capacity" model). Real hardware measures the stabilizers *repeatedly* and each measurement
// is itself noisy, so a single bad readout looks exactly like a data error that appears in one
// round and vanishes the next. The fix — due to Dennis, Kitaev, Landau & Preskill — is to
// decode in **space-time**: stack T noisy syndrome rounds into a 3-D history and let a *time*
// edge of the matching graph absorb a measurement error, while *space* edges absorb data
// errors. A **detection event** fires wherever the syndrome *changes* between consecutive
// rounds, which is exactly an endpoint of an error chain in this 3-D graph.
//
// Concretely (one Pauli sector, say X errors seen by the Z checks):
//   • T rounds of noise: each round every data qubit flips w.p. p and every measured check
//     outcome is flipped w.p. q (the measurement error). The data error *accumulates*.
//   • One final, perfect readout (the transversal data measurement) gives a noiseless syndrome.
//   • Detectors d_t = s_t ⊕ s_{t-1} (with s_{-1}=0), for layers t = 0 … T. A data error at
//     round t fires a horizontal pair at layer t; a measurement error at round t fires a
//     vertical pair (layers t, t+1) at one check.
// The decoder matches the detectors in this 3-D graph; only horizontal/boundary edges carry a
// data qubit, so the correction is read off in the data plane and tested against the logical.
//
// This model's MWPM threshold is the textbook ≈ 2.9–3.3% (well below the 10.3% code-capacity
// figure — the extra time dimension is the price of measuring imperfectly), and the
// Union-Find decoder sits just under it. Both are reproduced by the sweeps here.

import { buildSurfaceCode, mulberry32, type SurfaceCode, type StabType } from './SurfaceCode';
import { emptyGraph, addEdge, decodeMWPM, decodeUF, type MatchingGraph } from './decoder';

export type DecoderKind = 'mwpm' | 'uf';

const decodeWith = (kind: DecoderKind, g: MatchingGraph, defects: number[]): Set<number> =>
  kind === 'uf' ? decodeUF(g, defects) : decodeMWPM(g, defects);

/** Odd-overlap (anticommutation) test between a Pauli support and an error set. */
function anticommutes(support: number[], err: Set<number>): boolean {
  let n = 0;
  for (const q of support) if (err.has(q)) n++;
  return (n & 1) === 1;
}

// ---------------------------------------------------------------------------
// Per-sector structure shared by the 2-D and 3-D graph builders
// ---------------------------------------------------------------------------

interface Sector {
  detGlobal: number[];                 // global stab indices of detecting checks
  local: Map<number, number>;          // global → local check id
  nChecks: number;
  // data qubit → the 1 or 2 local detecting checks it touches
  checksOfQubit: Map<number, number[]>;
  logicalSupport: number[];            // logical operator this sector's residual must avoid
}

function sectorOf(code: SurfaceCode, detType: StabType): Sector {
  const detGlobal = code.stabs.map((s, i) => (s.type === detType ? i : -1)).filter((i) => i >= 0);
  const local = new Map<number, number>();
  detGlobal.forEach((g, l) => local.set(g, l));
  const checksOfQubit = new Map<number, number[]>();
  for (const g of detGlobal) {
    for (const q of code.stabs[g].qubits) {
      if (!checksOfQubit.has(q)) checksOfQubit.set(q, []);
      checksOfQubit.get(q)!.push(local.get(g)!);
    }
  }
  return {
    detGlobal,
    local,
    nChecks: detGlobal.length,
    checksOfQubit,
    logicalSupport: detType === 'Z' ? code.logicalZ : code.logicalX,
  };
}

/** The 2-D (code-capacity) decoding graph for one sector — nodes are the detecting checks. */
export function buildCodeCapacityGraph(code: SurfaceCode, detType: StabType): { graph: MatchingGraph; sector: Sector } {
  const sector = sectorOf(code, detType);
  const g = emptyGraph(sector.nChecks);
  for (const [q, checks] of sector.checksOfQubit) {
    if (checks.length === 2) addEdge(g, checks[0], checks[1], q);
    else if (checks.length === 1) addEdge(g, checks[0], g.BOUNDARY, q);
  }
  return { graph: g, sector };
}

/** The 3-D space-time decoding graph: `layers` copies of the 2-D graph stacked along time,
 *  with a vertical (measurement-error) edge linking each check between adjacent layers. The
 *  single boundary node is shared across all layers (the spatial boundary). */
export function buildSpaceTimeGraph(code: SurfaceCode, detType: StabType, layers: number): { graph: MatchingGraph; sector: Sector } {
  const sector = sectorOf(code, detType);
  const C = sector.nChecks;
  const node = (t: number, c: number) => t * C + c;
  const g = emptyGraph(layers * C);
  for (let t = 0; t < layers; t++) {
    // space edges within layer t (data errors at round t)
    for (const [q, checks] of sector.checksOfQubit) {
      if (checks.length === 2) addEdge(g, node(t, checks[0]), node(t, checks[1]), q);
      else if (checks.length === 1) addEdge(g, node(t, checks[0]), g.BOUNDARY, q);
    }
    // time edges to the next layer (measurement errors at round t) — no data qubit
    if (t + 1 < layers) for (let c = 0; c < C; c++) addEdge(g, node(t, c), node(t + 1, c), -1);
  }
  return { graph: g, sector };
}

// ---------------------------------------------------------------------------
// One phenomenological-noise experiment (single sector)
// ---------------------------------------------------------------------------

export interface SpaceTimeShot {
  layers: number;                 // T+1 detector layers
  defectLayers: number[][];       // per layer: global stab indices that fired a detector
  nDefects: number;
  accumulated: number[];          // true accumulated data error (data qubits)
  correction: number[];           // data qubits the decoder flips
  residual: number[];
  logicalError: boolean;
}

/**
 * Simulate one space-time correction experiment for a single Pauli sector: `T` noisy rounds
 * (data flip rate `p`, measurement flip rate `q`) followed by one perfect readout, decoded by
 * `kind`. Returns the full history (for the UI) and the success verdict.
 */
export function spaceTimeShot(opts: {
  d: number;
  detType?: StabType;
  T?: number;
  p: number;
  q?: number;
  kind?: DecoderKind;
  rng: () => number;
}): SpaceTimeShot {
  const code = buildSurfaceCode(opts.d);
  const detType = opts.detType ?? 'Z';
  const T = opts.T ?? opts.d;
  const q = opts.q ?? opts.p;
  const kind = opts.kind ?? 'mwpm';
  const { graph, sector } = buildSpaceTimeGraph(code, detType, T + 1);
  const C = sector.nChecks;
  const rng = opts.rng;

  const accumulated = new Set<number>();
  const syndromeOf = (): boolean[] =>
    sector.detGlobal.map((gi) => {
      let n = 0;
      for (const qb of code.stabs[gi].qubits) if (accumulated.has(qb)) n++;
      return (n & 1) === 1;
    });

  // Measured syndromes per round (rows 0..T-1 noisy, row T perfect).
  const measured: boolean[][] = [];
  for (let t = 0; t < T; t++) {
    for (let qb = 0; qb < code.nData; qb++) if (rng() < opts.p) {
      if (accumulated.has(qb)) accumulated.delete(qb); else accumulated.add(qb);
    }
    const s = syndromeOf();
    const m = s.map((b) => (rng() < q ? !b : b)); // measurement error
    measured.push(m);
  }
  measured.push(syndromeOf()); // perfect final readout

  // Detectors d_t = m_t ⊕ m_{t-1} (m_{-1} = 0).
  const layers = T + 1;
  const defects: number[] = [];
  const defectLayers: number[][] = Array.from({ length: layers }, () => []);
  const node = (t: number, c: number) => t * C + c;
  for (let t = 0; t < layers; t++) {
    for (let c = 0; c < C; c++) {
      const cur = measured[t][c];
      const prev = t === 0 ? false : measured[t - 1][c];
      if (cur !== prev) { defects.push(node(t, c)); defectLayers[t].push(sector.detGlobal[c]); }
    }
  }

  const correction = decodeWith(kind, graph, defects);
  const residual = new Set<number>(accumulated);
  for (const qb of correction) { if (residual.has(qb)) residual.delete(qb); else residual.add(qb); }

  return {
    layers,
    defectLayers,
    nDefects: defects.length,
    accumulated: [...accumulated].sort((a, b) => a - b),
    correction: [...correction].sort((a, b) => a - b),
    residual: [...residual].sort((a, b) => a - b),
    logicalError: anticommutes(sector.logicalSupport, residual),
  };
}

/** Monte-Carlo logical error rate for the phenomenological model: T=d rounds by default. */
export function phenomLogicalErrorRate(
  d: number, p: number, samples: number, rng: () => number,
  opts?: { kind?: DecoderKind; T?: number; q?: number; detType?: StabType },
): number {
  const code = buildSurfaceCode(d);
  const detType = opts?.detType ?? 'Z';
  const T = opts?.T ?? d;
  const q = opts?.q ?? p;
  const kind = opts?.kind ?? 'mwpm';
  const { graph, sector } = buildSpaceTimeGraph(code, detType, T + 1);
  const C = sector.nChecks;
  const node = (t: number, c: number) => t * C + c;

  let failures = 0;
  for (let s = 0; s < samples; s++) {
    const accumulated = new Set<number>();
    const measured: boolean[][] = [];
    const synd = (): boolean[] =>
      sector.detGlobal.map((gi) => {
        let n = 0;
        for (const qb of code.stabs[gi].qubits) if (accumulated.has(qb)) n++;
        return (n & 1) === 1;
      });
    for (let t = 0; t < T; t++) {
      for (let qb = 0; qb < code.nData; qb++) if (rng() < p) {
        if (accumulated.has(qb)) accumulated.delete(qb); else accumulated.add(qb);
      }
      const sy = synd();
      measured.push(sy.map((b) => (rng() < q ? !b : b)));
    }
    measured.push(synd());

    const defects: number[] = [];
    for (let t = 0; t <= T; t++) for (let c = 0; c < C; c++) {
      const prev = t === 0 ? false : measured[t - 1][c];
      if (measured[t][c] !== prev) defects.push(node(t, c));
    }
    const correction = decodeWith(kind, graph, defects);
    const residual = new Set<number>(accumulated);
    for (const qb of correction) { if (residual.has(qb)) residual.delete(qb); else residual.add(qb); }
    if (anticommutes(sector.logicalSupport, residual)) failures++;
  }
  return failures / samples;
}

export interface PhenomPoint { p: number; rates: { d: number; rate: number }[]; }
export interface PhenomThreshold {
  distances: number[];
  points: PhenomPoint[];
  threshold: number | null;
  kind: DecoderKind;
}

/** Sweep p across distances for the phenomenological model and locate the threshold crossing. */
export function phenomThresholdSweep(opts: {
  distances?: number[];
  ps?: number[];
  samples?: number;
  seed?: number;
  kind?: DecoderKind;
}): PhenomThreshold {
  const distances = opts.distances ?? [3, 5, 7];
  const ps = opts.ps ?? [0.01, 0.015, 0.02, 0.025, 0.03, 0.035, 0.04, 0.05, 0.06];
  const samples = opts.samples ?? 800;
  const kind = opts.kind ?? 'mwpm';
  const rng = mulberry32(opts.seed ?? 0xfa17);

  const points: PhenomPoint[] = ps.map((p) => ({
    p,
    rates: distances.map((d) => ({ d, rate: phenomLogicalErrorRate(d, p, samples, rng, { kind }) })),
  }));

  let threshold: number | null = null;
  const g = (i: number) => points[i].rates[0].rate - points[i].rates[distances.length - 1].rate;
  for (let i = 0; i + 1 < points.length; i++) {
    const f0 = g(i), f1 = g(i + 1);
    if (f0 >= 0 && f1 < 0) {
      const t = f0 === f1 ? 0 : f0 / (f0 - f1);
      threshold = points[i].p + t * (points[i + 1].p - points[i].p);
      break;
    }
  }
  return { distances, points, threshold, kind };
}

/** Code-capacity threshold sweep with a selectable decoder (the 6.0 sweep was MWPM-only).
 *  Same shape as `phenomThresholdSweep` so the UI can plot either uniformly. */
export function codeCapacityThresholdSweep(opts: {
  distances?: number[];
  ps?: number[];
  samples?: number;
  seed?: number;
  kind?: DecoderKind;
}): PhenomThreshold {
  const distances = opts.distances ?? [3, 5, 7];
  const ps = opts.ps ?? [0.05, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12, 0.13, 0.15, 0.18];
  const samples = opts.samples ?? 1500;
  const kind = opts.kind ?? 'mwpm';
  const rng = mulberry32(opts.seed ?? 0x51f5e);

  const points: PhenomPoint[] = ps.map((p) => ({
    p,
    rates: distances.map((d) => ({ d, rate: codeCapacityRate(d, p, samples, rng, kind) })),
  }));

  let threshold: number | null = null;
  const g = (i: number) => points[i].rates[0].rate - points[i].rates[distances.length - 1].rate;
  for (let i = 0; i + 1 < points.length; i++) {
    const f0 = g(i), f1 = g(i + 1);
    if (f0 >= 0 && f1 < 0) {
      const t = f0 === f1 ? 0 : f0 / (f0 - f1);
      threshold = points[i].p + t * (points[i + 1].p - points[i].p);
      break;
    }
  }
  return { distances, points, threshold, kind };
}

// ---------------------------------------------------------------------------
// Finite-size scaling: Λ ratios and the universal data collapse
// ---------------------------------------------------------------------------

/**
 * Λ_d = p_L(d) / p_L(d+2) at a fixed sub-threshold p. The hallmark of a working code is
 * Λ > 1 and *growing* with d: each two extra rows of qubits suppress the logical rate by a
 * widening factor. Above threshold Λ < 1 (more qubits hurt). Returns one ratio per adjacent
 * distance pair, using the code-capacity model by default (sharp, cheap) or phenomenological.
 */
export function lambdaRatios(opts: {
  distances?: number[];
  p: number;
  samples?: number;
  seed?: number;
  model?: 'code-capacity' | 'phenom';
  kind?: DecoderKind;
}): { pairs: { d: number; lambda: number; pL_d: number; pL_d2: number }[] } {
  const distances = opts.distances ?? [3, 5, 7, 9];
  const samples = opts.samples ?? 4000;
  const rng = mulberry32(opts.seed ?? 0x2bda);
  const kind = opts.kind ?? 'mwpm';
  const rate = (d: number) =>
    opts.model === 'phenom'
      ? phenomLogicalErrorRate(d, opts.p, samples, rng, { kind })
      : codeCapacityRate(d, opts.p, samples, rng, kind);

  const pL = distances.map((d) => rate(d));
  const pairs: { d: number; lambda: number; pL_d: number; pL_d2: number }[] = [];
  for (let i = 0; i + 1 < distances.length; i++) {
    if (distances[i + 1] === distances[i] + 2) {
      const a = pL[i], b = pL[i + 1];
      pairs.push({ d: distances[i], lambda: b > 0 ? a / b : Infinity, pL_d: a, pL_d2: b });
    }
  }
  return { pairs };
}

/** Code-capacity logical error rate via the generic graph + chosen decoder (used by Λ/collapse). */
export function codeCapacityRate(d: number, p: number, samples: number, rng: () => number, kind: DecoderKind = 'mwpm'): number {
  const code = buildSurfaceCode(d);
  const { graph, sector } = buildCodeCapacityGraph(code, 'Z');
  let failures = 0;
  for (let s = 0; s < samples; s++) {
    const err = new Set<number>();
    for (let qb = 0; qb < code.nData; qb++) if (rng() < p) err.add(qb);
    const defects: number[] = [];
    sector.detGlobal.forEach((gi, l) => {
      let n = 0;
      for (const qb of code.stabs[gi].qubits) if (err.has(qb)) n++;
      if (n & 1) defects.push(l);
    });
    const correction = decodeWith(kind, graph, defects);
    const residual = new Set<number>(err);
    for (const qb of correction) { if (residual.has(qb)) residual.delete(qb); else residual.add(qb); }
    if (anticommutes(sector.logicalSupport, residual)) failures++;
  }
  return failures / samples;
}

export interface CollapseResult {
  pth: number;
  nu: number;
  ssr: number;                                   // residual of the universal-curve fit
  points: { d: number; p: number; pL: number; x: number }[];
  curve: { x: number; y: number }[];             // the fitted quadratic universal curve
}

/**
 * Universal finite-size-scaling collapse (Wang–Harrington–Preskill). Near threshold the
 * logical rate is a single function of the rescaled variable x = (p − p_th)·d^{1/ν}; finding
 * the (p_th, ν) that make all the (d, p) curves fall on one quadratic is a sharp,
 * data-driven threshold estimate. We grid-search (p_th, ν), fit a quadratic in x by least
 * squares at each, and keep the minimum-residual collapse.
 */
export function collapseFit(points: { d: number; p: number; pL: number }[], opts?: {
  pthRange?: [number, number];
  nuRange?: [number, number];
  grid?: number;
}): CollapseResult {
  const [pthLo, pthHi] = opts?.pthRange ?? [0.06, 0.14];
  const [nuLo, nuHi] = opts?.nuRange ?? [0.8, 1.8];
  const G = opts?.grid ?? 40;

  // Least-squares quadratic fit y ≈ a0 + a1 x + a2 x², returns coefficients + SSR.
  const quadFit = (xs: number[], ys: number[]): { a: number[]; ssr: number } => {
    const s0 = xs.length;
    let s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i], y = ys[i], x2 = x * x;
      s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
      t0 += y; t1 += y * x; t2 += y * x2;
    }
    // Solve the 3×3 normal equations by Cramer's rule.
    const m = [
      [s0, s1, s2],
      [s1, s2, s3],
      [s2, s3, s4],
    ];
    const det3 = (a: number[][]) =>
      a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
      a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
      a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
    const D = det3(m);
    if (Math.abs(D) < 1e-18) return { a: [0, 0, 0], ssr: Infinity };
    const col = (j: number, v: number[]) => m.map((row, i) => row.map((val, k) => (k === j ? v[i] : val)));
    const rhs = [t0, t1, t2];
    const a0 = det3(col(0, rhs)) / D;
    const a1 = det3(col(1, rhs)) / D;
    const a2 = det3(col(2, rhs)) / D;
    let ssr = 0;
    for (let i = 0; i < xs.length; i++) {
      const yhat = a0 + a1 * xs[i] + a2 * xs[i] * xs[i];
      ssr += (ys[i] - yhat) ** 2;
    }
    return { a: [a0, a1, a2], ssr };
  };

  let best: CollapseResult | null = null;
  for (let gi = 0; gi <= G; gi++) {
    const pth = pthLo + ((pthHi - pthLo) * gi) / G;
    for (let gj = 0; gj <= G; gj++) {
      const nu = nuLo + ((nuHi - nuLo) * gj) / G;
      const xs = points.map((pt) => (pt.p - pth) * Math.pow(pt.d, 1 / nu));
      const ys = points.map((pt) => pt.pL);
      const { a, ssr } = quadFit(xs, ys);
      if (!best || ssr < best.ssr) {
        const xmin = Math.min(...xs), xmax = Math.max(...xs);
        const curve = Array.from({ length: 41 }, (_, i) => {
          const x = xmin + ((xmax - xmin) * i) / 40;
          return { x, y: a[0] + a[1] * x + a[2] * x * x };
        });
        best = {
          pth, nu, ssr,
          points: points.map((pt, i) => ({ ...pt, x: xs[i] })),
          curve,
        };
      }
    }
  }
  return best!;
}
