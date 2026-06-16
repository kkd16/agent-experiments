// The rotated planar surface code, built from scratch, with a Minimum-Weight
// Perfect Matching (MWPM) decoder.
//
// The surface code is the leading candidate for fault-tolerant quantum computing:
// a topological [[d², 1, d]] stabilizer code on a 2-D lattice of data qubits whose
// logical information is stored non-locally in string-like operators, so it tolerates
// any error of weight < d/2. A distance-d code uses d² data qubits and d²−1 weight-≤4
// stabilizer checks. We construct the code, simulate independent bit/phase-flip noise,
// extract the syndrome, decode it with MWPM (Edmonds' blossom on a graph whose vertices
// are the lit-up checks and whose weights are lattice distances), and check whether the
// residual error is a stabilizer (success) or a logical operator (failure).
//
// Code-capacity model (perfect measurements). Under this model MWPM has a well-known
// error-correction threshold near p ≈ 10.3%: below it, increasing the distance d
// suppresses the logical error rate exponentially; above it, more qubits make things
// worse. The Monte-Carlo sweep here reproduces that crossing.

import { minWeightPerfectMatching, type Edge } from './blossom';

export type StabType = 'X' | 'Z';

export interface Stabilizer {
  type: StabType;
  qubits: number[];       // data-qubit indices this check measures
  cx: number;             // plaquette-centre coordinates (lattice units) for drawing
  cy: number;
  boundary: boolean;      // weight-2 boundary check?
}

export interface DataQubit {
  r: number;
  c: number;
}

export interface SurfaceCode {
  d: number;
  nData: number;
  data: DataQubit[];                // index → (row, col)
  stabs: Stabilizer[];
  xStabIdx: number[];               // indices into stabs of X-type checks
  zStabIdx: number[];               // indices into stabs of Z-type checks
  logicalZ: number[];               // data qubits in a representative logical-Z (a column)
  logicalX: number[];               // data qubits in a representative logical-X (a row)
}

const qid = (d: number, r: number, c: number) => r * d + c;

/** Build the rotated surface code of (odd) distance d. */
export function buildSurfaceCode(d: number): SurfaceCode {
  if (d < 3 || d % 2 === 0) throw new Error('distance must be odd ≥ 3');
  const data: DataQubit[] = [];
  for (let r = 0; r < d; r++) for (let c = 0; c < d; c++) data.push({ r, c });

  const stabs: Stabilizer[] = [];

  // Bulk weight-4 plaquettes: a (d-1)×(d-1) grid of unit cells, checkerboard-coloured.
  for (let r = 0; r < d - 1; r++) {
    for (let c = 0; c < d - 1; c++) {
      const type: StabType = (r + c) % 2 === 0 ? 'Z' : 'X';
      stabs.push({
        type,
        qubits: [qid(d, r, c), qid(d, r, c + 1), qid(d, r + 1, c), qid(d, r + 1, c + 1)],
        cx: c + 0.5,
        cy: r + 0.5,
        boundary: false,
      });
    }
  }

  // Boundary weight-2 checks. Top/bottom carry Z; left/right carry X. Parities chosen
  // so every X and Z check commutes (verified in the self-test suite for d = 3,5,7).
  for (let c = 1; c + 1 < d; c += 2) // top (row 0): Z, odd column starts
    stabs.push({ type: 'Z', qubits: [qid(d, 0, c), qid(d, 0, c + 1)], cx: c + 0.5, cy: -0.5, boundary: true });
  for (let c = 0; c + 1 < d; c += 2) // bottom (row d-1): Z, even column starts
    stabs.push({ type: 'Z', qubits: [qid(d, d - 1, c), qid(d, d - 1, c + 1)], cx: c + 0.5, cy: d - 0.5, boundary: true });
  for (let r = 0; r + 1 < d; r += 2) // left (col 0): X, even row starts
    stabs.push({ type: 'X', qubits: [qid(d, r, 0), qid(d, r + 1, 0)], cx: -0.5, cy: r + 0.5, boundary: true });
  for (let r = 1; r + 1 < d; r += 2) // right (col d-1): X, odd row starts
    stabs.push({ type: 'X', qubits: [qid(d, r, d - 1), qid(d, r + 1, d - 1)], cx: d - 0.5, cy: r + 0.5, boundary: true });

  const xStabIdx: number[] = [];
  const zStabIdx: number[] = [];
  stabs.forEach((s, i) => (s.type === 'X' ? xStabIdx : zStabIdx).push(i));

  // Representative logicals: logical Z is any full column (commutes with every X check),
  // logical X any full row. They overlap on one qubit, hence anticommute.
  const logicalZ: number[] = [];
  const logicalX: number[] = [];
  for (let r = 0; r < d; r++) logicalZ.push(qid(d, r, 0));
  for (let c = 0; c < d; c++) logicalX.push(qid(d, 0, c));

  return { d, nData: d * d, data, stabs, xStabIdx, zStabIdx, logicalZ, logicalX };
}

/** True if Pauli strings P, Q (each a set of qubits of a single fixed type) anticommute. */
const anticommutes = (a: number[], setB: Set<number>): boolean => {
  let n = 0;
  for (const q of a) if (setB.has(q)) n++;
  return (n & 1) === 1;
};

// ---------------------------------------------------------------------------
// Decoding graph: for one error type, the checks that detect it plus a single
// boundary node. Each data qubit contributes an edge (between its two detecting
// checks, or from its one detecting check to the boundary).
// ---------------------------------------------------------------------------

interface DecodeGraph {
  detIdx: number[];                       // indices (into code.stabs) of detecting checks
  stabOfQubit: Map<number, number[]>;     // data qubit → local detecting-check ids
  adj: { to: number; qubit: number }[][]; // local check id → edges (to = local id or BOUNDARY)
  boundaryEdges: { from: number; qubit: number }[]; // local check id → boundary, via a qubit
  BOUNDARY: number;                       // node id of the boundary
}

/** Build the decoding graph for errors detected by `detType` checks. */
function decodeGraph(code: SurfaceCode, detType: StabType): DecodeGraph {
  const detIdx = code.stabs.map((s, i) => (s.type === detType ? i : -1)).filter((i) => i >= 0);
  const local = new Map<number, number>(); // global stab index → local id
  detIdx.forEach((g, l) => local.set(g, l));
  const BOUNDARY = detIdx.length;

  const stabOfQubit = new Map<number, number[]>();
  for (const g of detIdx) {
    for (const q of code.stabs[g].qubits) {
      if (!stabOfQubit.has(q)) stabOfQubit.set(q, []);
      stabOfQubit.get(q)!.push(local.get(g)!);
    }
  }

  const adj: { to: number; qubit: number }[][] = Array.from({ length: detIdx.length }, () => []);
  const boundaryEdges: { from: number; qubit: number }[] = [];
  for (const [q, checks] of stabOfQubit) {
    if (checks.length === 2) {
      const [a, b] = checks;
      adj[a].push({ to: b, qubit: q });
      adj[b].push({ to: a, qubit: q });
    } else if (checks.length === 1) {
      const a = checks[0];
      adj[a].push({ to: BOUNDARY, qubit: q });
      boundaryEdges.push({ from: a, qubit: q });
    }
  }
  return { detIdx, stabOfQubit, adj, boundaryEdges, BOUNDARY };
}

/**
 * BFS from a source check over the decoding graph. The boundary node may be
 * *entered* but never *expanded*, so it never serves as an intermediate vertex:
 * defect→defect distances stay interior, while defect→boundary distance is the
 * shortest chain terminating at the boundary. Returns distance + back-pointers
 * (previous node and the qubit on the connecting edge) for path reconstruction.
 */
function bfs(g: DecodeGraph, src: number): { dist: number[]; prevNode: number[]; prevQubit: number[] } {
  const N = g.detIdx.length + 1; // +1 for boundary
  const dist = new Array(N).fill(Infinity);
  const prevNode = new Array(N).fill(-1);
  const prevQubit = new Array(N).fill(-1);
  dist[src] = 0;
  const queue = [src];
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    if (u === g.BOUNDARY) continue; // enter-only: do not expand the boundary
    for (const e of g.adj[u]) {
      if (dist[e.to] > dist[u] + 1) {
        dist[e.to] = dist[u] + 1;
        prevNode[e.to] = u;
        prevQubit[e.to] = e.qubit;
        queue.push(e.to);
      }
    }
  }
  return { dist, prevNode, prevQubit };
}

function pathQubits(prevNode: number[], prevQubit: number[], target: number): number[] {
  const out: number[] = [];
  let cur = target;
  while (prevNode[cur] !== -1) { out.push(prevQubit[cur]); cur = prevNode[cur]; }
  return out;
}

export interface DecodeResult {
  syndrome: boolean[];        // per detecting check (in code.stabs order? — see detIdx)
  detIdx: number[];           // global indices of detecting checks (syndrome aligns to this)
  defects: number[];          // global stab indices that fired
  matching: { a: number; b: number; toBoundary: boolean }[]; // global stab indices (b unused if boundary)
  correction: number[];       // data qubits the decoder flips
  correctionByDefect: number[][];
}

/**
 * Decode an error (a set of flipped data qubits) of a single Pauli type using MWPM.
 * @param detType the check type that detects this error (Z detects X errors; X detects Z).
 */
export function decode(code: SurfaceCode, error: Set<number>, detType: StabType): DecodeResult {
  const g = decodeGraph(code, detType);

  // Syndrome: a detecting check fires iff it overlaps the error on an odd number of qubits.
  const syndrome: boolean[] = g.detIdx.map((gi) => {
    let n = 0;
    for (const q of code.stabs[gi].qubits) if (error.has(q)) n++;
    return (n & 1) === 1;
  });
  const defectLocal: number[] = [];
  syndrome.forEach((s, l) => { if (s) defectLocal.push(l); });

  const k = defectLocal.length;
  const result: DecodeResult = {
    syndrome,
    detIdx: g.detIdx,
    defects: defectLocal.map((l) => g.detIdx[l]),
    matching: [],
    correction: [],
    correctionByDefect: [],
  };
  if (k === 0) return result;

  // Per-defect BFS for distances and path reconstruction.
  const bfsOf = defectLocal.map((l) => bfs(g, l));

  // Matching graph: nodes 0..k-1 are defects, k..2k-1 their personal boundary copies.
  const edges: Edge[] = [];
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const w = bfsOf[i].dist[defectLocal[j]];
      if (Number.isFinite(w)) edges.push([i, j, w]);
    }
    const wb = bfsOf[i].dist[g.BOUNDARY];
    edges.push([i, k + i, Number.isFinite(wb) ? wb : 1e6]);
  }
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) edges.push([k + i, k + j, 0]);

  const mate = minWeightPerfectMatching(2 * k, edges);

  const correction = new Set<number>();
  for (let i = 0; i < k; i++) {
    const m = mate[i];
    if (m < 0) continue;
    if (m < k) {
      if (i < m) {
        const qs = pathQubits(bfsOf[i].prevNode, bfsOf[i].prevQubit, defectLocal[m]);
        result.matching.push({ a: g.detIdx[defectLocal[i]], b: g.detIdx[defectLocal[m]], toBoundary: false });
        result.correctionByDefect.push(qs);
        for (const q of qs) toggle(correction, q);
      }
    } else {
      // matched to its boundary copy → connect to the lattice boundary
      const qs = pathQubits(bfsOf[i].prevNode, bfsOf[i].prevQubit, g.BOUNDARY);
      result.matching.push({ a: g.detIdx[defectLocal[i]], b: -1, toBoundary: true });
      result.correctionByDefect.push(qs);
      for (const q of qs) toggle(correction, q);
    }
  }
  result.correction = [...correction].sort((a, b) => a - b);
  return result;
}

function toggle(set: Set<number>, q: number): void {
  if (set.has(q)) set.delete(q); else set.add(q);
}

export interface RoundResult {
  error: number[];
  decodeX: DecodeResult;     // decode of X errors (Z checks fire)
  decodeZ: DecodeResult;     // decode of Z errors (X checks fire)
  residualX: number[];
  residualZ: number[];
  logicalXFailure: boolean;  // residual X anticommutes with logical Z
  logicalZFailure: boolean;  // residual Z anticommutes with logical X
  failure: boolean;
}

/**
 * Run one full correction round for a given X-error set and Z-error set, decoding
 * each sector independently and testing the residual against the logical operators.
 */
export function correctRound(code: SurfaceCode, xErr: Set<number>, zErr: Set<number>): RoundResult {
  const decodeX = decode(code, xErr, 'Z');
  const decodeZ = decode(code, zErr, 'X');

  const residualXSet = new Set<number>(xErr);
  for (const q of decodeX.correction) toggle(residualXSet, q);
  const residualZSet = new Set<number>(zErr);
  for (const q of decodeZ.correction) toggle(residualZSet, q);

  const logicalXFailure = anticommutes(code.logicalZ, residualXSet);
  const logicalZFailure = anticommutes(code.logicalX, residualZSet);

  return {
    error: [...new Set([...xErr, ...zErr])].sort((a, b) => a - b),
    decodeX, decodeZ,
    residualX: [...residualXSet].sort((a, b) => a - b),
    residualZ: [...residualZSet].sort((a, b) => a - b),
    logicalXFailure,
    logicalZFailure,
    failure: logicalXFailure || logicalZFailure,
  };
}

// ---------------------------------------------------------------------------
// Monte-Carlo threshold estimation.
// ---------------------------------------------------------------------------

/** Mulberry32 — a tiny deterministic PRNG so sweeps are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Estimate the logical X error rate for distance d at physical bit-flip rate p,
 * over `samples` Monte-Carlo trials (each data qubit flips independently w.p. p,
 * decoded by MWPM). This is the single-sector experiment whose curves cross at the
 * code-capacity threshold.
 */
export function logicalErrorRate(d: number, p: number, samples: number, rng: () => number): number {
  const code = buildSurfaceCode(d);
  let failures = 0;
  for (let s = 0; s < samples; s++) {
    const xErr = new Set<number>();
    for (let q = 0; q < code.nData; q++) if (rng() < p) xErr.add(q);
    const dec = decode(code, xErr, 'Z');
    const residual = new Set<number>(xErr);
    for (const q of dec.correction) toggle(residual, q);
    if (anticommutes(code.logicalZ, residual)) failures++;
  }
  return failures / samples;
}

export interface ThresholdPoint { p: number; rates: { d: number; rate: number }[]; }
export interface ThresholdResult {
  distances: number[];
  points: ThresholdPoint[];
  threshold: number | null;   // estimated crossing of the smallest two curves
}

/** Sweep physical error rate p across several distances and locate the threshold crossing. */
export function thresholdSweep(opts: {
  distances?: number[];
  ps?: number[];
  samples?: number;
  seed?: number;
}): ThresholdResult {
  const distances = opts.distances ?? [3, 5, 7];
  const ps = opts.ps ?? [0.05, 0.07, 0.08, 0.09, 0.10, 0.11, 0.12, 0.13, 0.15, 0.18];
  const samples = opts.samples ?? 1500;
  const rng = mulberry32(opts.seed ?? 0x51f5e );

  const points: ThresholdPoint[] = ps.map((p) => ({
    p,
    rates: distances.map((d) => ({ d, rate: logicalErrorRate(d, p, samples, rng) })),
  }));

  // Estimate the threshold as the crossing of the most-separated distance curves
  // (the cleanest signal). Below threshold the larger code wins, so
  // g(p) = rate(d_small) − rate(d_large) > 0; above threshold it flips negative.
  // Scan for the positive→negative sign change and linearly interpolate.
  let threshold: number | null = null;
  const d0 = 0, d1 = distances.length - 1;
  const g = (i: number) => points[i].rates[d0].rate - points[i].rates[d1].rate;
  for (let i = 0; i + 1 < points.length; i++) {
    const f0 = g(i), f1 = g(i + 1);
    if (f0 >= 0 && f1 < 0) {
      const t = f0 === f1 ? 0 : f0 / (f0 - f1);
      threshold = points[i].p + t * (points[i + 1].p - points[i].p);
      break;
    }
  }
  return { distances, points, threshold };
}
