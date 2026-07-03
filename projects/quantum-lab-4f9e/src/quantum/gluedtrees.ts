import { C } from './Complex';
import { hermitianEig } from './Hermitian';
import { ctqwEngine, laplacian, type CTWalkEngine } from './walks';

/**
 * The glued trees — the one *provably exponential* quantum speedup that is a continuous-time
 * quantum walk and nothing else (Childs, Cleve, Deotto, Farhi, Gutmann & Spielman, STOC 2003).
 *
 * Take two balanced binary trees of height `h`. Their `2^h` leaves are glued together by a random
 * cycle that alternates between the two leaf sets, so every leaf gets degree 3 (one parent + two
 * cross edges) — the same degree as every internal node. Only the two roots have degree 2. You start
 * a walker at the ENTRANCE (the left root) and ask: how long until it reaches the EXIT (the right
 * root)?
 *
 *   • A CLASSICAL random walk is exponentially trapped. From the entrance the walk drifts *toward*
 *     the ever-widening middle (there are exponentially more nodes there), and once at the glue it is
 *     just as likely to fall back into the tree it came from as to cross — so the probability of ever
 *     standing on the exit is Θ(2^{−h}) at *every* time. No classical algorithm that only sees the
 *     graph through local exploration can find the exit in fewer than 2^{Ω(h)} steps.
 *
 *   • A QUANTUM walk crosses in time O(h). The reason is the **column subspace**. Group the vertices
 *     into `2h+2` columns (left root, left level 1, …, left leaves | right leaves, …, right root).
 *     The uniform superposition over a column, |col_c⟩, spans a subspace the adjacency matrix leaves
 *     invariant, and inside it A acts as a nearly-uniform **line** of `2h+2` sites — a quantum wire
 *     with hopping √2 everywhere except a single defect of 2 at the middle glue. A wavepacket launched
 *     at one end of an almost-uniform line propagates *ballistically* to the other end in linear time,
 *     landing on the exit with probability Ω(1/h). Exponential vs polynomial — an exact separation.
 *
 * Everything here is built on the lab's own `Complex`, `hermitianEig` and the existing `ctqwEngine`
 * from `walks.ts`; the column reduction is proven *exact* against the full-graph evolution in the
 * self-tests, and the same reduction reduces the classical heat kernel too — because within every
 * column all vertices share the same degree, the diagonal `D` acts as a scalar per column.
 */

export interface GluedTrees {
  /** Tree height: root at level 0, leaves at level h. */
  height: number;
  /** Total vertex count = 2·(2^{h+1} − 1) = 2^{h+2} − 2. */
  n: number;
  adjacency: number[][];
  edges: [number, number][];
  /** 2-D layout in [0,1]² for drawing. */
  layout: { x: number; y: number }[];
  /** The left root. */
  entrance: number;
  /** The right root. */
  exit: number;
  /** Column index 0..2h+1 for each vertex. */
  column: number[];
  /** Which tree each vertex belongs to (0 = left/entrance side, 1 = right/exit side). */
  tree: (0 | 1)[];
  /** (level,index-in-level) tree coordinates, for layout + debugging. */
  coord: { level: number; idx: number }[];
  /** Members of each column (length 2h+2). */
  columnMembers: number[][];
  /** Size of each column (length 2h+2): 2^c on the left half, 2^{2h+1−c} on the right. */
  columnSize: number[];
  /** Gluing seed; 0 = the deterministic alternating cycle, >0 = a seeded random alternating cycle. */
  seed: number;
  label: string;
}

/** Deterministic splitmix32 for the seeded random gluing (reproducible across workers). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build the glued-trees graph of height `h`. `seed = 0` uses the deterministic alternating cycle
 * L₀–R₀–L₁–R₁–…; any `seed > 0` picks a seeded random alternating Hamiltonian cycle on the leaves —
 * still 2-regular on each side and a single cycle, so the graph stays connected and the column
 * reduction stays exact, but with no exploitable structure (the point of the original hardness proof).
 */
export function buildGluedTrees(h: number, seed = 0): GluedTrees {
  const height = Math.max(1, h);
  const leaves = 1 << height; // 2^h leaves per tree

  const adjList: number[][] = [];
  const layoutY: number[] = [];
  const column: number[] = [];
  const tree: (0 | 1)[] = [];
  const coord: { level: number; idx: number }[] = [];

  // node[t][l][i] = global index of the i-th node on level l of tree t (0 = left, 1 = right)
  const node: number[][][] = [[], []];
  let next = 0;
  const push = (t: 0 | 1, l: number, i: number) => {
    const g = next++;
    node[t][l] = node[t][l] ?? [];
    node[t][l][i] = g;
    tree[g] = t;
    coord[g] = { level: l, idx: i };
    // column: left level l → column l; right level l → column (2h+1 − l).
    column[g] = t === 0 ? l : 2 * height + 1 - l;
    // y = centre of the node's subtree of leaves, giving the classic binary-tree fan.
    layoutY[g] = (i + 0.5) / (1 << l);
    adjList[g] = [];
    return g;
  };

  // Materialise both trees, level by level.
  for (const t of [0, 1] as const) for (let l = 0; l <= height; l++) for (let i = 0; i < (1 << l); i++) push(t, l, i);

  const link = (a: number, b: number) => { adjList[a].push(b); adjList[b].push(a); };

  // Tree edges: (l,i) — (l+1, 2i) and (l+1, 2i+1).
  for (const t of [0, 1] as const) for (let l = 0; l < height; l++) for (let i = 0; i < (1 << l); i++) {
    link(node[t][l][i], node[t][l + 1][2 * i]);
    link(node[t][l][i], node[t][l + 1][2 * i + 1]);
  }

  // Gluing: an alternating Hamiltonian cycle L₀–R_{π0}–L₁–R_{π1}–…–L_{k−1}–R_{π(k−1)}–L₀.
  const leftLeaf = (i: number) => node[0][height][i];
  const rightLeaf = (j: number) => node[1][height][j];
  const perm = Array.from({ length: leaves }, (_, i) => i);
  if (seed > 0) {
    const rng = mulberry32(seed);
    for (let i = leaves - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  }
  for (let i = 0; i < leaves; i++) {
    link(leftLeaf(i), rightLeaf(perm[i]));
    link(rightLeaf(perm[i]), leftLeaf((i + 1) % leaves));
  }

  const n = next;
  const adjacency = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const edges: [number, number][] = [];
  for (let a = 0; a < n; a++) for (const b of adjList[a]) { adjacency[a][b] = 1; if (a < b) edges.push([a, b]); }

  const cols = 2 * height + 2;
  const columnMembers: number[][] = Array.from({ length: cols }, () => []);
  for (let v = 0; v < n; v++) columnMembers[column[v]].push(v);
  const columnSize = columnMembers.map((m) => m.length);

  const colX = (c: number) => 0.04 + 0.92 * (c / (2 * height + 1));
  const layout = Array.from({ length: n }, (_, v) => ({ x: colX(column[v]), y: 0.06 + 0.88 * layoutY[v] }));

  return {
    height, n, adjacency, edges, layout,
    entrance: node[0][0][0], exit: node[1][0][0],
    column, tree, coord, columnMembers, columnSize, seed,
    label: `Glued trees h=${height} (${n} vertices)`,
  };
}

// ======================================================================================
// The exact column reduction: a nearly-uniform line of 2h+2 sites
// ======================================================================================

/** Column sizes N_c: 2^c on the left half (c ≤ h), 2^{2h+1−c} on the right half. */
export function columnSizes(height: number): number[] {
  const cols = 2 * height + 2;
  return Array.from({ length: cols }, (_, c) => (c <= height ? 1 << c : 1 << (2 * height + 1 - c)));
}

/**
 * The reduced adjacency A_red on the 2h+2 column basis: tridiagonal with off-diagonal hopping √2
 * between every neighbouring pair of columns, except the single central glue hop (columns h ↔ h+1)
 * which is exactly 2. Derived from ⟨col_{c+1}|A|col_c⟩ = (#edges between the columns)/√(N_c N_{c+1}):
 * inside a tree that is √(N_{c+1}/N_c) = √2; across the 2-regular glue it is 2^{h+1}/2^h = 2.
 */
export function columnReducedA(height: number): number[][] {
  const cols = 2 * height + 2;
  const A = Array.from({ length: cols }, () => new Array<number>(cols).fill(0));
  for (let c = 0; c + 1 < cols; c++) {
    const hop = c === height ? 2 : Math.SQRT2;
    A[c][c + 1] = hop; A[c + 1][c] = hop;
  }
  return A;
}

/** The reduced classical generator L_red = D_red − A_red, with degrees 2 at the two ends, 3 inside. */
export function columnReducedL(height: number): number[][] {
  const cols = 2 * height + 2;
  const A = columnReducedA(height);
  const L = A.map((row) => row.map((x) => -x));
  for (let c = 0; c < cols; c++) L[c][c] = c === 0 || c === cols - 1 ? 2 : 3;
  return L;
}

export interface GluedReduction {
  height: number;
  /** 2h+2. */
  size: number;
  /** Column sizes. */
  N: number[];
  A: number[][];
  L: number[][];
  /** Quantum column-probability vector |a_c(t)|², length 2h+2, sums to 1 (via e^{−iA_red t}). */
  quantumColProb(t: number): number[];
  /** Classical column-probability vector (√N_c·b_c(t)), length 2h+2, sums to 1 (via e^{−L_red t}). */
  classicalColProb(t: number): number[];
  /** P(exit,t) for the quantum walk (the last column's probability). */
  quantumExit(t: number): number;
  /** P(exit,t) for the classical continuous-time random walk. */
  classicalExit(t: number): number;
}

/**
 * Precompute the reduced quantum and classical engines for height `h`. Both are (2h+2)-dimensional,
 * so this is cheap even for large h — which is exactly what lets the scaling plot reach heights the
 * full 2^{h+2}-vertex graph never could.
 */
export function reduceGluedTrees(height: number): GluedReduction {
  const size = 2 * height + 2;
  const N = columnSizes(height);
  const A = columnReducedA(height);
  const L = columnReducedL(height);
  const qEng: CTWalkEngine = ctqwEngine(A);
  // classical: diagonalise L once, evolve e^{−Lt} from column 0.
  const eig = hermitianEig(L.map((row) => row.map((x) => C(x))));
  const lVal = eig.values;
  const lVec = eig.vectors.map((row) => row.map((z) => z.re));
  const sqrtN = N.map((x) => Math.sqrt(x));

  const quantumColProb = (t: number) => qEng.prob(0, t);
  const classicalColProb = (t: number) => {
    const b = new Array<number>(size).fill(0);
    for (let k = 0; k < size; k++) {
      const e = Math.exp(-lVal[k] * t) * lVec[0][k];
      if (e === 0) continue;
      for (let c = 0; c < size; c++) b[c] += lVec[c][k] * e;
    }
    return b.map((bc, c) => Math.max(0, sqrtN[c] * bc));
  };
  return {
    height, size, N, A, L,
    quantumColProb, classicalColProb,
    quantumExit: (t) => qEng.transport(0, size - 1, t),
    classicalExit: (t) => classicalColProb(t)[size - 1],
  };
}

// ======================================================================================
// Full-graph column aggregation (for the exactness proof and the graph-glow view)
// ======================================================================================

/** Aggregate a per-vertex distribution into per-column totals. */
export function aggregateColumns(g: GluedTrees, perVertex: number[]): number[] {
  const out = new Array<number>(2 * g.height + 2).fill(0);
  for (let v = 0; v < g.n; v++) out[g.column[v]] += perVertex[v];
  return out;
}

/**
 * A reusable classical heat-kernel engine on a full graph's Laplacian: p(t) = e^{−Lt}·e_from. One
 * eigendecomposition, evaluated at any number of times (unlike `classicalCTRW`, which re-diagonalises).
 */
export function heatKernelEngine(L: number[][]): (from: number, t: number) => number[] {
  const n = L.length;
  const eig = hermitianEig(L.map((row) => row.map((x) => C(x))));
  const val = eig.values;
  const vec = eig.vectors.map((row) => row.map((z) => z.re));
  return (from: number, t: number) => {
    const out = new Array<number>(n).fill(0);
    for (let k = 0; k < n; k++) {
      const e = Math.exp(-val[k] * t) * vec[from][k];
      if (e === 0) continue;
      for (let i = 0; i < n; i++) out[i] += vec[i][k] * e;
    }
    return out.map((p) => Math.max(0, p));
  };
}

export interface FullGlued {
  g: GluedTrees;
  qEng: CTWalkEngine;
  heat: (from: number, t: number) => number[];
  /** Per-vertex quantum probability |ψ_v(t)|² from the entrance. */
  quantumProb(t: number): number[];
  /** Per-vertex classical probability from the entrance. */
  classicalProb(t: number): number[];
  quantumExit(t: number): number;
  classicalExit(t: number): number;
}

/** Diagonalise the full graph once (quantum adjacency + classical Laplacian) for the interactive view. */
export function fullGluedEngine(g: GluedTrees): FullGlued {
  const qEng = ctqwEngine(g.adjacency);
  const heat = heatKernelEngine(laplacian(g.adjacency));
  return {
    g, qEng, heat,
    quantumProb: (t) => qEng.prob(g.entrance, t),
    classicalProb: (t) => heat(g.entrance, t),
    quantumExit: (t) => qEng.transport(g.entrance, g.exit, t),
    classicalExit: (t) => heat(g.entrance, t)[g.exit],
  };
}

/**
 * The exactness certificate: the maximum discrepancy, over the sampled times, between the full-graph
 * column-aggregated probabilities and the reduced-line probabilities — for BOTH the quantum walk and
 * the classical heat kernel. It should be at the eigensolver's floor (~1e-9), proving the column
 * subspace is genuinely invariant and the reduction loses nothing.
 */
export function reductionError(g: GluedTrees, times: number[]): { quantum: number; classical: number } {
  const full = fullGluedEngine(g);
  const red = reduceGluedTrees(g.height);
  let q = 0, c = 0;
  for (const t of times) {
    const qFull = aggregateColumns(g, full.quantumProb(t));
    const cFull = aggregateColumns(g, full.classicalProb(t));
    const qRed = red.quantumColProb(t);
    const cRed = red.classicalColProb(t);
    for (let i = 0; i < qRed.length; i++) { q = Math.max(q, Math.abs(qFull[i] - qRed[i])); c = Math.max(c, Math.abs(cFull[i] - cRed[i])); }
  }
  return { quantum: q, classical: c };
}

// ======================================================================================
// Hitting curves, space-time, and the exponential-separation scaling law
// ======================================================================================

export interface ExitCurve {
  times: number[];
  quantum: number[];
  classical: number[];
  /** first/peak quantum arrival. */
  qPeak: number; qPeakTime: number;
  /** peak classical exit probability over the window (its ceiling is Θ(2^{−h})). */
  cPeak: number; cPeakTime: number;
}

/** A natural time window for height h: long enough for the quantum wavepacket to cross and revive. */
export function gluedTimeWindow(height: number): number { return 2.6 * (height + 1); }

/** Sample P(exit,t) for both walks over the natural window (using the cheap reduced engines). */
export function exitCurve(height: number, samples = 400): ExitCurve {
  const red = reduceGluedTrees(height);
  const tMax = gluedTimeWindow(height);
  const times: number[] = [], quantum: number[] = [], classical: number[] = [];
  let qPeak = -1, qPeakTime = 0, cPeak = -1, cPeakTime = 0;
  for (let i = 0; i < samples; i++) {
    const t = (i * tMax) / (samples - 1);
    const q = red.quantumExit(t), c = red.classicalExit(t);
    times.push(t); quantum.push(q); classical.push(c);
    if (q > qPeak) { qPeak = q; qPeakTime = t; }
    if (c > cPeak) { cPeak = c; cPeakTime = t; }
  }
  return { times, quantum, classical, qPeak, qPeakTime, cPeak, cPeakTime };
}

/** Column-probability space-time (rows = time, cols = column index) for both walks. */
export function columnSpacetime(height: number, rows = 120): { quantum: number[][]; classical: number[][]; tMax: number } {
  const red = reduceGluedTrees(height);
  const tMax = gluedTimeWindow(height);
  const quantum: number[][] = [], classical: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const t = (r * tMax) / (rows - 1);
    quantum.push(red.quantumColProb(t));
    classical.push(red.classicalColProb(t));
  }
  return { quantum, classical, tMax };
}

/**
 * Why the crossing is ballistic, quantified. The reduced line is (bar the single glue defect) a
 * uniform tight-binding chain with hopping J = √2, whose dispersion is E(k) = 2J·cos k and whose
 * group velocity v_g(k) = dE/dk = −2J·sin k peaks at |v_g| = 2J = 2√2. A wavepacket therefore covers
 * the 2h+1 bonds from entrance to exit in time ≈ (2h+1)/(2√2) — LINEAR in h. The defect and packet
 * spreading add a small constant slowdown, so the measured arrival time tracks the same slope.
 */
export const REDUCED_HOP = Math.SQRT2;
export const MAX_GROUP_VELOCITY = 2 * Math.SQRT2;

/** The band structure of the (uniform part of the) reduced line, sampled over k ∈ [0, π]. */
export function dispersion(samples = 128): { k: number[]; energy: number[]; groupVel: number[] } {
  const k: number[] = [], energy: number[] = [], groupVel: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const kk = (i * Math.PI) / samples;
    k.push(kk); energy.push(2 * REDUCED_HOP * Math.cos(kk)); groupVel.push(-2 * REDUCED_HOP * Math.sin(kk));
  }
  return { k, energy, groupVel };
}

export interface ArrivalScaling {
  points: { height: number; measured: number; predicted: number }[];
  /** Least-squares slope of the measured arrival time vs height (≈ 1/√2 ≈ 0.71 for a clean line). */
  slope: number;
}

/**
 * Measured quantum arrival time vs the ballistic prediction (2h+1)/(2√2), across heights — the exact
 * evidence that the crossing time is O(h), not exponential. Returns the two curves and the fitted slope.
 */
export function arrivalScaling(maxHeight: number, samples = 500): ArrivalScaling {
  const points: { height: number; measured: number; predicted: number }[] = [];
  for (let h = 2; h <= maxHeight; h++) {
    points.push({ height: h, measured: exitCurve(h, samples).qPeakTime, predicted: (2 * h + 1) / MAX_GROUP_VELOCITY });
  }
  // least-squares slope of measured vs height
  const nP = points.length;
  const mh = points.reduce((a, p) => a + p.height, 0) / nP;
  const mm = points.reduce((a, p) => a + p.measured, 0) / nP;
  let num = 0, den = 0;
  for (const p of points) { num += (p.height - mh) * (p.measured - mm); den += (p.height - mh) ** 2; }
  return { points, slope: den > 0 ? num / den : 0 };
}

export interface ScalingPoint { height: number; qPeak: number; qPeakTime: number; cPeak: number; }

/**
 * The headline: peak exit probability vs tree height. The quantum peak falls only polynomially
 * (≈ 1/h) while the classical peak collapses exponentially (≈ 2^{−h}) — the separation, plotted.
 */
export function scalingLaw(maxHeight: number, samples = 500): ScalingPoint[] {
  const out: ScalingPoint[] = [];
  for (let h = 2; h <= maxHeight; h++) {
    const c = exitCurve(h, samples);
    out.push({ height: h, qPeak: c.qPeak, qPeakTime: c.qPeakTime, cPeak: c.cPeak });
  }
  return out;
}
