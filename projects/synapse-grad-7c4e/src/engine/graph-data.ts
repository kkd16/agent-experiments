// Procedural graphs for the GNN lab. Each dataset hands the trainer an undirected edge list,
// per-node integer labels, and a node-feature matrix — no bundled data, no graph libraries.
//
// The features are deliberately a *weak* signal of the label (a class prototype drowned in
// Gaussian noise): on their own they barely beat chance, so the network only succeeds by
// propagating information along the edges. That's the whole point of the lab — the graph
// structure is the signal — and it's exactly what the "ignore edges" baseline strips away.
//
// Geometric datasets (the kNN graphs) also carry real 2-D positions, used both to *build* the
// graph (connect each point to its nearest neighbors) and to lay it out; the abstract graphs
// (SBM, Karate) leave positions null so the lab falls back to a force-directed layout.

import { mulberry32 } from './nn';

export type GraphDatasetKind = 'sbm' | 'karate' | 'knn-moons' | 'knn-circles' | 'knn-blobs' | 'knn-spirals';

export interface GraphDataset {
  kind: GraphDatasetKind;
  n: number;
  edges: [number, number][];
  labels: Int32Array;
  numClasses: number;
  features: Float64Array; // [n * featDim]
  featDim: number;
  positions: Float64Array | null; // [n * 2] in [-1,1], or null for force-directed layout
  classNames: string[];
}

export interface GraphParams {
  nodes: number; // SBM / kNN node count (Karate is fixed at 34)
  communities: number; // SBM blocks (also kNN clusters where applicable)
  pIn: number; // SBM intra-community edge probability
  pOut: number; // SBM inter-community edge probability
  knnK: number; // neighbors per node for the geometric graphs
  featDim: number;
  signal: number; // class-prototype strength in the features
  noise: number; // Gaussian feature noise
  seed: number;
}

function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Weak class-signal features: a random orthogonal-ish prototype per class, scaled by `signal`,
// plus per-entry Gaussian noise of standard deviation `noise`.
function makeFeatures(labels: Int32Array, numClasses: number, p: GraphParams): Float64Array {
  const rng = mulberry32((p.seed ^ 0x51ed270b) >>> 0);
  const D = p.featDim;
  const proto = new Float64Array(numClasses * D);
  for (let c = 0; c < numClasses; c++) for (let j = 0; j < D; j++) proto[c * D + j] = randn(rng);
  // normalize each prototype to unit length so `signal` is a comparable knob across classes
  for (let c = 0; c < numClasses; c++) {
    let s = 0;
    for (let j = 0; j < D; j++) s += proto[c * D + j] ** 2;
    const inv = 1 / Math.sqrt(s || 1);
    for (let j = 0; j < D; j++) proto[c * D + j] *= inv * Math.sqrt(D);
  }
  const n = labels.length;
  const feat = new Float64Array(n * D);
  for (let i = 0; i < n; i++) {
    const c = labels[i];
    for (let j = 0; j < D; j++) feat[i * D + j] = p.signal * proto[c * D + j] + p.noise * randn(rng);
  }
  return feat;
}

function dedupeEdges(raw: [number, number][]): [number, number][] {
  const seen = new Set<number>();
  const out: [number, number][] = [];
  for (let [u, v] of raw) {
    if (u === v) continue;
    if (u > v) [u, v] = [v, u];
    const key = u * 1_000_000 + v;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([u, v]);
  }
  return out;
}

// ---- Stochastic Block Model ---------------------------------------------------------

function makeSBM(p: GraphParams): GraphDataset {
  const rng = mulberry32(p.seed >>> 0);
  const n = Math.max(p.communities * 4, p.nodes);
  const k = p.communities;
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) labels[i] = Math.floor((i * k) / n); // contiguous blocks
  const raw: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const prob = labels[i] === labels[j] ? p.pIn : p.pOut;
      if (rng() < prob) raw.push([i, j]);
    }
  }
  // guarantee no isolated node: link it to a random same-community peer
  const edges = dedupeEdges(raw);
  ensureConnected(n, labels, edges, rng);
  return {
    kind: 'sbm',
    n,
    edges,
    labels,
    numClasses: k,
    features: makeFeatures(labels, k, p),
    featDim: p.featDim,
    positions: null,
    classNames: Array.from({ length: k }, (_, i) => `block ${i + 1}`),
  };
}

function ensureConnected(n: number, labels: Int32Array, edges: [number, number][], rng: () => number): void {
  const deg = new Int32Array(n);
  for (const [u, v] of edges) {
    deg[u]++;
    deg[v]++;
  }
  for (let i = 0; i < n; i++) {
    if (deg[i] > 0) continue;
    // attach to a random node sharing the label (or any node as a fallback)
    let target = -1;
    for (let tries = 0; tries < 50; tries++) {
      const c = Math.floor(rng() * n);
      if (c !== i && labels[c] === labels[i]) {
        target = c;
        break;
      }
    }
    if (target < 0) target = (i + 1) % n;
    edges.push(i < target ? [i, target] : [target, i]);
    deg[i]++;
    deg[target]++;
  }
}

// ---- Zachary's Karate Club (the canonical community-detection graph) -----------------
//
// 34 members, 78 friendships, and the historically-observed split into Mr. Hi's group and the
// officer's group after the club fractured. Node and edge indices are 0-based.

const KARATE_EDGES: [number, number][] = [
  [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 10], [0, 11], [0, 12],
  [0, 13], [0, 17], [0, 19], [0, 21], [0, 31], [1, 2], [1, 3], [1, 7], [1, 13], [1, 17], [1, 19],
  [1, 21], [1, 30], [2, 3], [2, 7], [2, 8], [2, 9], [2, 13], [2, 27], [2, 28], [2, 32], [3, 7],
  [3, 12], [3, 13], [4, 6], [4, 10], [5, 6], [5, 10], [5, 16], [6, 16], [8, 30], [8, 32], [8, 33],
  [9, 33], [13, 33], [14, 32], [14, 33], [15, 32], [15, 33], [18, 32], [18, 33], [19, 33],
  [20, 32], [20, 33], [22, 32], [22, 33], [23, 25], [23, 27], [23, 29], [23, 32], [23, 33],
  [24, 25], [24, 27], [24, 31], [25, 31], [26, 29], [26, 33], [27, 33], [28, 31], [28, 33],
  [29, 32], [29, 33], [30, 32], [30, 33], [31, 32], [31, 33], [32, 33],
];
// 1 = officer's faction, 0 = Mr. Hi's, the standard ground-truth labeling.
const KARATE_LABELS = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
];

function makeKarate(p: GraphParams): GraphDataset {
  const n = 34;
  const labels = Int32Array.from(KARATE_LABELS);
  return {
    kind: 'karate',
    n,
    edges: dedupeEdges(KARATE_EDGES.map((e) => [e[0], e[1]] as [number, number])),
    labels,
    numClasses: 2,
    features: makeFeatures(labels, 2, p),
    featDim: p.featDim,
    positions: null,
    classNames: ["Mr. Hi", "Officer"],
  };
}

// ---- geometric (kNN) graphs ---------------------------------------------------------

function moonPoints(n: number, rng: () => number): { pts: Float64Array; labels: Int32Array } {
  const pts = new Float64Array(n * 2);
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const c = i % 2;
    const t = rng() * Math.PI;
    let x: number;
    let y: number;
    if (c === 0) {
      x = Math.cos(t);
      y = Math.sin(t);
    } else {
      x = 1 - Math.cos(t);
      y = 0.5 - Math.sin(t);
    }
    pts[i * 2] = x + (rng() - 0.5) * 0.18;
    pts[i * 2 + 1] = y + (rng() - 0.5) * 0.18;
    labels[i] = c;
  }
  return { pts, labels };
}

function circlePoints(n: number, k: number, rng: () => number): { pts: Float64Array; labels: Int32Array } {
  const pts = new Float64Array(n * 2);
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const c = i % k;
    const r = 0.35 + c * 0.55;
    const a = rng() * Math.PI * 2;
    pts[i * 2] = r * Math.cos(a) + (rng() - 0.5) * 0.12;
    pts[i * 2 + 1] = r * Math.sin(a) + (rng() - 0.5) * 0.12;
    labels[i] = c;
  }
  return { pts, labels };
}

function blobPoints(n: number, k: number, rng: () => number): { pts: Float64Array; labels: Int32Array } {
  const pts = new Float64Array(n * 2);
  const labels = new Int32Array(n);
  const centers: [number, number][] = [];
  for (let c = 0; c < k; c++) {
    const a = (c / k) * Math.PI * 2;
    centers.push([1.15 * Math.cos(a), 1.15 * Math.sin(a)]);
  }
  for (let i = 0; i < n; i++) {
    const c = i % k;
    pts[i * 2] = centers[c][0] + randn(rng) * 0.34;
    pts[i * 2 + 1] = centers[c][1] + randn(rng) * 0.34;
    labels[i] = c;
  }
  return { pts, labels };
}

function spiralPoints(n: number, k: number, rng: () => number): { pts: Float64Array; labels: Int32Array } {
  const pts = new Float64Array(n * 2);
  const labels = new Int32Array(n);
  const per = Math.ceil(n / k);
  for (let i = 0; i < n; i++) {
    const c = i % k;
    const idx = Math.floor(i / k);
    const frac = idx / per;
    const r = 0.15 + frac * 1.0;
    const a = frac * 3.2 + (c / k) * Math.PI * 2 + (rng() - 0.5) * 0.25;
    pts[i * 2] = r * Math.cos(a);
    pts[i * 2 + 1] = r * Math.sin(a);
    labels[i] = c;
  }
  return { pts, labels };
}

// Connect each node to its kNN (Euclidean), then symmetrize: a small, undirected geometric
// graph whose edges respect the local manifold the points lie on.
function knnEdges(pts: Float64Array, n: number, k: number): [number, number][] {
  const raw: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const d: { j: number; dist: number }[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = pts[i * 2] - pts[j * 2];
      const dy = pts[i * 2 + 1] - pts[j * 2 + 1];
      d.push({ j, dist: dx * dx + dy * dy });
    }
    d.sort((a, b) => a.dist - b.dist);
    for (let m = 0; m < Math.min(k, d.length); m++) raw.push([i, d[m].j]);
  }
  return dedupeEdges(raw);
}

function normalizePositions(pts: Float64Array, n: number): Float64Array {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, pts[i * 2]);
    maxX = Math.max(maxX, pts[i * 2]);
    minY = Math.min(minY, pts[i * 2 + 1]);
    maxY = Math.max(maxY, pts[i * 2 + 1]);
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = ((pts[i * 2] - cx) / span) * 1.8;
    out[i * 2 + 1] = ((pts[i * 2 + 1] - cy) / span) * 1.8;
  }
  return out;
}

function makeKnn(kind: GraphDatasetKind, p: GraphParams): GraphDataset {
  const rng = mulberry32(p.seed >>> 0);
  const n = Math.max(20, p.nodes);
  let gen: { pts: Float64Array; labels: Int32Array };
  let k = p.communities;
  if (kind === 'knn-moons') {
    gen = moonPoints(n, rng);
    k = 2;
  } else if (kind === 'knn-circles') {
    gen = circlePoints(n, k, rng);
  } else if (kind === 'knn-blobs') {
    gen = blobPoints(n, k, rng);
  } else {
    gen = spiralPoints(n, k, rng);
  }
  const edges = knnEdges(gen.pts, n, p.knnK);
  return {
    kind,
    n,
    edges,
    labels: gen.labels,
    numClasses: k,
    features: makeFeatures(gen.labels, k, p),
    featDim: p.featDim,
    positions: normalizePositions(gen.pts, n),
    classNames: Array.from({ length: k }, (_, i) => `class ${i + 1}`),
  };
}

export const GRAPH_DATASETS: { id: GraphDatasetKind; label: string; note: string }[] = [
  { id: 'sbm', label: 'Stochastic Block Model', note: 'planted communities — the GNN benchmark' },
  { id: 'karate', label: "Zachary's Karate Club", note: '34 nodes, the real club-fracture split' },
  { id: 'knn-moons', label: 'kNN · two moons', note: 'geometric graph over interleaving crescents' },
  { id: 'knn-circles', label: 'kNN · concentric rings', note: 'geometric graph, non-linear classes' },
  { id: 'knn-blobs', label: 'kNN · Gaussian blobs', note: 'geometric graph over k clusters' },
  { id: 'knn-spirals', label: 'kNN · spirals', note: 'geometric graph over interleaved arms' },
];

export function makeGraphDataset(kind: GraphDatasetKind, p: GraphParams): GraphDataset {
  if (kind === 'sbm') return makeSBM(p);
  if (kind === 'karate') return makeKarate(p);
  return makeKnn(kind, p);
}
