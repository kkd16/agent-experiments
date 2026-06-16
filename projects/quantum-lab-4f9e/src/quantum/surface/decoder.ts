// A *generic* surface-code decoder layer, built from scratch.
//
// The 6.0 surface code shipped a Minimum-Weight Perfect Matching (MWPM) decoder welded
// directly onto the 2-D code-capacity decoding graph. To reach fault tolerance in
// *space-time* (7.0) — repeated noisy syndrome rounds whose detection graph is 3-D — we
// first factor the decoder out from the graph. A `MatchingGraph` is any graph of detector
// nodes plus a single boundary sink, whose edges each carry an optional **data qubit** (a
// horizontal/space edge that, if used, flips that qubit; a vertical/time edge carries no
// qubit because a measurement error leaves the data untouched). Both the code-capacity 2-D
// graph and the space-time 3-D graph are instances, and the same two decoders run on either:
//
//   • `decodeMWPM` — the optimal matching decoder (Edmonds' blossom, reused from 6.0),
//   • `decodeUF`   — the **Union-Find** decoder (Delfosse–Nivelle 2017): cluster growth by
//                    uniform syndrome-validation, then a linear-time peeling decoder. It is
//                    near-linear time and provably corrects every error of weight < d/2,
//                    trading a sliver of threshold for a large speed-up.
//
// Both return only a *correction* (a set of data qubits to flip). The interactive lattice
// view keeps using the 6.0 `decode()` for its matching lines; everything that just needs a
// correction (thresholds, scaling, the UF↔MWPM cross-check) goes through here.

import { minWeightPerfectMatching, type Edge } from './blossom';

/** An edge of a decoding graph: connects two detector nodes (or a node to BOUNDARY) and,
 *  if it is a space-like edge, names the single data qubit it would flip. Time-like edges
 *  (measurement errors) set `qubit = -1`. */
export interface DecEdge {
  u: number;
  v: number; // may equal BOUNDARY
  qubit: number; // data qubit flipped by this edge, or -1 for a measurement/time edge
}

/** A decoding graph: `nNodes` detector nodes [0, nNodes), one `BOUNDARY` sink at index
 *  `nNodes`, an edge list, and per-node adjacency into that edge list. */
export interface MatchingGraph {
  nNodes: number;
  BOUNDARY: number;
  edges: DecEdge[];
  adj: { to: number; qubit: number; edge: number }[][]; // length nNodes+1 (boundary included)
}

/** Build an (empty) matching graph with `nNodes` detector nodes. */
export function emptyGraph(nNodes: number): MatchingGraph {
  return {
    nNodes,
    BOUNDARY: nNodes,
    edges: [],
    adj: Array.from({ length: nNodes + 1 }, () => []),
  };
}

/** Add an undirected edge (recorded in both endpoints' adjacency). */
export function addEdge(g: MatchingGraph, u: number, v: number, qubit: number): void {
  const e = g.edges.length;
  g.edges.push({ u, v, qubit });
  g.adj[u].push({ to: v, qubit, edge: e });
  g.adj[v].push({ to: u, qubit, edge: e });
}

function toggle(set: Set<number>, q: number): void {
  if (q < 0) return;
  if (set.has(q)) set.delete(q);
  else set.add(q);
}

// ---------------------------------------------------------------------------
// MWPM decoder (Edmonds' blossom on the shortest-path metric of the graph)
// ---------------------------------------------------------------------------

/** BFS over a `MatchingGraph` from `src`. The boundary may be *entered* but never expanded,
 *  so it is never an interior vertex of a defect→defect path. Returns distances + the
 *  back-pointers needed to reconstruct the data qubits along each shortest path. */
function bfs(g: MatchingGraph, src: number): { dist: number[]; prevNode: number[]; prevQubit: number[] } {
  const N = g.nNodes + 1;
  const dist = new Array(N).fill(Infinity);
  const prevNode = new Array(N).fill(-1);
  const prevQubit = new Array(N).fill(-1);
  dist[src] = 0;
  const queue = [src];
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++];
    if (u === g.BOUNDARY) continue; // enter-only
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
  while (prevNode[cur] !== -1) {
    if (prevQubit[cur] >= 0) out.push(prevQubit[cur]);
    cur = prevNode[cur];
  }
  return out;
}

/** Decode a syndrome (a list of fired detector nodes) on a generic graph by MWPM, returning
 *  the set of data qubits to flip. */
export function decodeMWPM(g: MatchingGraph, defects: number[]): Set<number> {
  const correction = new Set<number>();
  const k = defects.length;
  if (k === 0) return correction;

  const bfsOf = defects.map((d) => bfs(g, d));
  const edges: Edge[] = [];
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const w = bfsOf[i].dist[defects[j]];
      if (Number.isFinite(w)) edges.push([i, j, w]);
    }
    const wb = bfsOf[i].dist[g.BOUNDARY];
    edges.push([i, k + i, Number.isFinite(wb) ? wb : 1e6]);
  }
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) edges.push([k + i, k + j, 0]);

  const mate = minWeightPerfectMatching(2 * k, edges);
  for (let i = 0; i < k; i++) {
    const m = mate[i];
    if (m < 0) continue;
    if (m < k) {
      if (i < m) for (const q of pathQubits(bfsOf[i].prevNode, bfsOf[i].prevQubit, defects[m])) toggle(correction, q);
    } else {
      for (const q of pathQubits(bfsOf[i].prevNode, bfsOf[i].prevQubit, g.BOUNDARY)) toggle(correction, q);
    }
  }
  return correction;
}

// ---------------------------------------------------------------------------
// Union-Find decoder (Delfosse–Nivelle): uniform cluster growth → peeling
// ---------------------------------------------------------------------------

/**
 * The Union-Find decoder. Each connected error chain lights up its endpoints as defects;
 * the decoder grows a cluster around every "odd" set of defects until the cluster either
 * becomes even (an internal pairing exists) or reaches the boundary, then *peels* the grown
 * region — a spanning forest of the fully-grown edges — to read off a concrete correction.
 *
 * Growth is uniform (each cluster boundary advances by one half-edge per round); an edge with
 * both half-edges claimed is "fully grown" and fuses its endpoints' clusters. Termination is
 * guaranteed because every round either grows the grown region or fuses clusters, and the
 * graph is finite. The peeling step is the linear-time decoder of Delfosse–Zémor.
 */
export function decodeUF(g: MatchingGraph, defects: number[]): Set<number> {
  const correction = new Set<number>();
  if (defects.length === 0) return correction;

  const B = g.BOUNDARY;
  const N = g.nNodes + 1; // include boundary node

  // Union-Find over all nodes (boundary included). A cluster is "even" once its defect
  // parity is even or it touches the boundary (the boundary is a free, infinite defect sink).
  const parent = new Int32Array(N);
  const size = new Int32Array(N);
  const parity = new Uint8Array(N); // odd defect count?
  const onBoundary = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    parent[i] = i;
    size[i] = 1;
    parity[i] = 0;
    onBoundary[i] = i === B ? 1 : 0;
  }
  for (const d of defects) parity[d] ^= 1;

  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const n = parent[x]; parent[x] = r; x = n; }
    return r;
  };
  const union = (a: number, b: number): void => {
    let ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (size[ra] < size[rb]) { const t = ra; ra = rb; rb = t; }
    parent[rb] = ra;
    size[ra] += size[rb];
    parity[ra] ^= parity[rb];
    onBoundary[ra] |= onBoundary[rb];
  };

  // An active cluster is odd and not boundary-connected; only active clusters grow.
  const isActive = (r: number) => parity[r] === 1 && onBoundary[r] === 0;
  const anyActive = (): boolean => {
    const seen = new Set<number>();
    for (const d of defects) { const r = find(d); if (!seen.has(r) && isActive(r)) return true; seen.add(r); }
    return false;
  };

  const support = new Uint8Array(g.edges.length); // 0,1,2 half-edges claimed
  const full = new Uint8Array(g.edges.length);

  // Uniform growth. Each round, every active cluster claims one half-edge on each incident,
  // not-yet-full edge; an edge claimed from both sides (support 2) is fully grown and fuses.
  let guard = 0;
  const maxRounds = (g.nNodes + 2) * 2 + 4;
  while (anyActive() && guard++ < maxRounds) {
    const newlyFull: number[] = [];
    let grew = false;
    for (let e = 0; e < g.edges.length; e++) {
      if (full[e]) continue;
      const { u, v } = g.edges[e];
      const ru = find(u), rv = find(v);
      if (ru === rv) continue; // internal edge — does not advance the frontier
      let claim = 0;
      if (isActive(ru)) claim++;
      if (isActive(rv)) claim++;
      if (claim === 0) continue;
      grew = true;
      support[e] = Math.min(2, support[e] + claim);
      if (support[e] >= 2) { full[e] = 1; newlyFull.push(e); }
    }
    // A boundary/even-bound edge advances one half-edge per round, so a round can grow the
    // frontier without yet fusing anything; only bail when *nothing* advanced (disconnected).
    if (!grew) break;
    for (const e of newlyFull) union(g.edges[e].u, g.edges[e].v);
  }

  // Erasure = the fully-grown edges. Peel a spanning forest of it.
  const erasure: number[] = [];
  for (let e = 0; e < g.edges.length; e++) if (full[e]) erasure.push(e);

  // Build a spanning forest (BFS) over the erasure so peeling runs on a forest.
  const treeEdges: number[] = [];
  const seen = new Uint8Array(N);
  const eadj: { to: number; edge: number }[][] = Array.from({ length: N }, () => []);
  for (const e of erasure) {
    const { u, v } = g.edges[e];
    eadj[u].push({ to: v, edge: e });
    eadj[v].push({ to: u, edge: e });
  }
  // Root each component at the boundary when reachable so syndrome drains into it.
  const roots: number[] = [];
  for (let s = 0; s < N; s++) if (eadj[s].length && !seen[s]) roots.push(s);
  const order = [B, ...roots]; // try boundary first
  for (const s0 of order) {
    if (seen[s0] || (s0 !== B && eadj[s0].length === 0) || (s0 === B && eadj[B].length === 0)) continue;
    seen[s0] = 1;
    const stack = [s0];
    while (stack.length) {
      const u = stack.pop()!;
      for (const { to, edge } of eadj[u]) {
        if (!seen[to]) { seen[to] = 1; treeEdges.push(edge); stack.push(to); }
      }
    }
  }

  // Peeling decoder (Delfosse–Zémor): repeatedly strip a leaf; if the leaf still carries a
  // syndrome, its pendant edge is in the correction and the syndrome moves to the parent.
  const synd = new Uint8Array(N);
  for (const d of defects) synd[d] ^= 1;
  synd[B] = 0; // the boundary absorbs syndrome for free

  const deg = new Int32Array(N);
  const tadj: { to: number; edge: number }[][] = Array.from({ length: N }, () => []);
  for (const e of treeEdges) {
    const { u, v } = g.edges[e];
    tadj[u].push({ to: v, edge: e });
    tadj[v].push({ to: u, edge: e });
    deg[u]++; deg[v]++;
  }
  const removed = new Uint8Array(g.edges.length);
  const leaves: number[] = [];
  for (let i = 0; i < N; i++) if (deg[i] === 1 && i !== B) leaves.push(i);
  // process non-boundary leaves first; fall back to boundary leaves last
  const allLeaves = (): number[] => {
    const out: number[] = [];
    for (let i = 0; i < N; i++) if (deg[i] === 1 && i !== B) out.push(i);
    if (out.length === 0) for (let i = 0; i < N; i++) if (deg[i] === 1) out.push(i);
    return out;
  };
  let work = leaves.length ? leaves : allLeaves();
  let safety = 0;
  while (work.length && safety++ < treeEdges.length + N + 5) {
    const u = work.pop()!;
    if (deg[u] !== 1) continue;
    let pend = -1, parent2 = -1;
    for (const { to, edge } of tadj[u]) if (!removed[edge]) { pend = edge; parent2 = to; break; }
    if (pend < 0) { deg[u] = 0; continue; }
    removed[pend] = 1;
    deg[u]--; deg[parent2]--;
    if (u !== B && synd[u]) {
      toggle(correction, g.edges[pend].qubit);
      synd[parent2] ^= 1;
    }
    if (deg[parent2] === 1 && parent2 !== B) work.push(parent2);
    if (work.length === 0) work = allLeaves();
  }

  return correction;
}
