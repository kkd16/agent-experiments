// The irregular-mesh geometry engine — the fourth tiling. Where the square, hex and voxel engines
// run Wave Function Collapse on a *regular* lattice (every cell the same shape, a fixed direction
// set, neighbours found by integer arithmetic), this one runs it on an **irregular all-quad mesh**:
// a Townscaper-style organic grid where cells are quadrilaterals of many shapes and every vertex
// has a different valence. The WFC algebra survives the move intact because we keep one invariant —
// **every cell is a quad** (arity 4) — so a tile is still four cyclic edge sockets with a 4-fold
// rotation group, exactly as on the square lattice. What changes is that adjacency is no longer a
// formula: it is an explicit graph, `nbCell[cell*4 + slot]`, built here once and read by the solver.
//
// How an irregular all-quad mesh is grown deterministically from a seed (the real Townscaper
// recipe, minus the 3-D):
//
//   1. a sheared **triangular lattice** — a guaranteed-planar, guaranteed-manifold base
//      triangulation with no floating-point predicates (so it can never be malformed);
//   2. a random **maximal matching** that merges adjacent triangle *pairs* into quads, injecting the
//      irregular valence that makes the result look grown rather than gridded;
//   3. **primal quad subdivision** (Catmull–Clark's face step): every face — triangle *or* quad —
//      is split into quads through its edge midpoints and centroid. A k-gon becomes k quads, and
//      because incident faces share the one midpoint vertex per edge, the result is a conforming,
//      all-quad, 2-manifold-with-boundary mesh *by construction* — topology independent of geometry;
//   4. **Laplacian relaxation** (boundary pinned) to round the quads into the organic tiling.
//
// The topology is purely combinatorial, so jitter and relaxation can move vertices anywhere without
// ever breaking the mesh — the Proof Lab checks the manifold invariants the solver relies on
// (every interior edge shared by exactly two cells, in opposite senses; Euler characteristic).

import { hashSeed, makeRng, type Rng } from '../wfc/prng';

export type Vec2 = { x: number; y: number };

/** One quadrilateral cell of the mesh, with the geometry the renderer and tilesets consume. */
export type MeshCell = {
  /** Four vertex indices, in counter-clockwise order. */
  verts: [number, number, number, number];
  /** The four corner points (a copy, post-relaxation), CCW. */
  poly: [Vec2, Vec2, Vec2, Vec2];
  /** Edge midpoints: `mids[s]` is the midpoint of the edge from `verts[s]` to `verts[s+1]`. */
  mids: [Vec2, Vec2, Vec2, Vec2];
  /** Area centroid (average of the four corners). */
  centroid: Vec2;
  /** A representative inner radius (min centroid→edge-midpoint distance) for stroke sizing. */
  inradius: number;
};

export type Mesh = {
  vertices: Vec2[];
  cells: MeshCell[];
  /** `nbCell[c*4 + s]` = the cell across cell `c`'s edge-slot `s`, or −1 at the domain boundary. */
  nbCell: Int32Array;
  /** `nbSlot[c*4 + s]` = that neighbour's local slot for the same shared edge (−1 at boundary). */
  nbSlot: Int32Array;
  /**
   * `nbSameDir[c*4 + s]` = 1 iff the neighbour traverses the shared edge in the *same* direction as
   * cell `c` (an orientation clash). For a consistently-CCW mesh this is always 0 — the two cells
   * read the seam in opposite senses — and the socket rule reverses one side. Threaded anyway so
   * the socket algebra stays correct even if a future generator emits a clashing winding.
   */
  nbSameDir: Uint8Array;
  /** Axis-aligned bounds of the vertex cloud, for the renderer's fit-to-canvas transform. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Number of boundary (single-incidence) edges — a Proof-Lab statistic. */
  boundaryEdges: number;
};

export type MeshOptions = {
  cols: number;
  rows: number;
  seed: string;
  /** 0..1 fraction of the cell spacing to jitter interior lattice vertices by. */
  jitter: number;
  /** Laplacian relaxation iterations (boundary pinned). */
  relax: number;
  /** Merge adjacent triangle pairs into quads before subdividing (the irregularity injector). */
  merge: boolean;
};

const SQRT3_2 = Math.sqrt(3) / 2;

// A face during construction: an ordered (CCW) ring of vertex indices, 3 or 4 long.
type Face = number[];

function edgeKey(a: number, b: number): number {
  return a < b ? a * 0x40000000 + b : b * 0x40000000 + a;
}

/**
 * Build a deterministic irregular all-quad mesh. Pure function of the options (same seed + size →
 * bit-for-bit the same mesh), which is what makes the whole studio reproducible and shareable.
 */
export function buildMesh(opts: MeshOptions): Mesh {
  const rng = makeRng(hashSeed(`${opts.seed}|mesh`));
  const cols = Math.max(2, Math.min(24, Math.round(opts.cols)));
  const rows = Math.max(2, Math.min(24, Math.round(opts.rows)));

  // ---- 1. sheared triangular lattice --------------------------------------
  // Vertex (i, j) for i∈[0,cols], j∈[0,rows] sheared so each row slides half a cell: the classic
  // isotropic triangular lattice. Interior vertices are jittered; the rim is pinned so the board
  // keeps a clean parallelogram silhouette.
  const vx: number[] = [];
  const vy: number[] = [];
  const isBoundaryLattice: boolean[] = [];
  const idOf = (i: number, j: number) => j * (cols + 1) + i;
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const rim = i === 0 || j === 0 || i === cols || j === rows;
      let x = i + 0.5 * j;
      let y = j * SQRT3_2;
      if (!rim && opts.jitter > 0) {
        x += (rng.next() - 0.5) * opts.jitter;
        y += (rng.next() - 0.5) * opts.jitter;
      }
      vx.push(x);
      vy.push(y);
      isBoundaryLattice.push(rim);
    }
  }

  // Triangulate each sheared rhombus into two CCW triangles along the (i+1,j)–(i,j+1) diagonal.
  let faces: Face[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = idOf(i, j);
      const b = idOf(i + 1, j);
      const c = idOf(i, j + 1);
      const d = idOf(i + 1, j + 1);
      // With the shear, (a,b,c) and (b,d,c) are both counter-clockwise.
      faces.push([a, b, c]);
      faces.push([b, d, c]);
    }
  }

  // ---- 2. random maximal matching → merge triangle pairs into quads -------
  if (opts.merge) {
    faces = mergeTriangles(faces, rng);
  }

  // ---- 3. primal quad subdivision -----------------------------------------
  // New vertices: one shared midpoint per undirected edge, one centroid per face. A k-gon
  // [v0..v_{k-1}] emits k quads [v_i, mid_i, centroid, mid_{i-1}] — all CCW.
  const midOfEdge = new Map<number, number>();
  const quads: Face[] = [];
  const addVertex = (x: number, y: number, boundary: boolean): number => {
    vx.push(x);
    vy.push(y);
    isBoundaryLattice.push(boundary);
    return vx.length - 1;
  };
  // Which undirected edges lie on the domain boundary (appear in exactly one face)? Needed so their
  // midpoints are pinned during relaxation.
  const edgeFaceCount = new Map<number, number>();
  for (const f of faces) {
    for (let s = 0; s < f.length; s++) {
      const k = edgeKey(f[s], f[(s + 1) % f.length]);
      edgeFaceCount.set(k, (edgeFaceCount.get(k) ?? 0) + 1);
    }
  }
  const getMid = (a: number, b: number): number => {
    const k = edgeKey(a, b);
    let m = midOfEdge.get(k);
    if (m === undefined) {
      const boundary = (edgeFaceCount.get(k) ?? 0) === 1;
      m = addVertex((vx[a] + vx[b]) / 2, (vy[a] + vy[b]) / 2, boundary);
      midOfEdge.set(k, m);
    }
    return m;
  };
  for (const f of faces) {
    const k = f.length;
    let cx = 0;
    let cy = 0;
    for (const v of f) {
      cx += vx[v];
      cy += vy[v];
    }
    const g = addVertex(cx / k, cy / k, false);
    const mids: number[] = [];
    for (let s = 0; s < k; s++) mids.push(getMid(f[s], f[(s + 1) % k]));
    for (let s = 0; s < k; s++) {
      quads.push([f[s], mids[s], g, mids[(s - 1 + k) % k]]);
    }
  }

  // ---- 4. build adjacency from shared edges -------------------------------
  // Each quad edge-slot is a directed edge (verts[s] → verts[s+1]); the undirected key groups the
  // (at most two) slots that share a physical edge.
  type SlotRef = { cell: number; slot: number; a: number; b: number };
  const byEdge = new Map<number, SlotRef[]>();
  for (let c = 0; c < quads.length; c++) {
    const q = quads[c];
    for (let s = 0; s < 4; s++) {
      const a = q[s];
      const b = q[(s + 1) % 4];
      const k = edgeKey(a, b);
      let list = byEdge.get(k);
      if (!list) byEdge.set(k, (list = []));
      list.push({ cell: c, slot: s, a, b });
    }
  }
  const nbCell = new Int32Array(quads.length * 4).fill(-1);
  const nbSlot = new Int32Array(quads.length * 4).fill(-1);
  const nbSameDir = new Uint8Array(quads.length * 4);
  let boundaryEdges = 0;
  for (const refs of byEdge.values()) {
    if (refs.length === 1) {
      boundaryEdges++;
      continue;
    }
    // A well-formed 2-manifold shares each interior edge between exactly two faces. If a degenerate
    // merge ever produced more, keep only the first pairing (still valid; extras become boundary).
    const [p, r] = refs;
    nbCell[p.cell * 4 + p.slot] = r.cell;
    nbSlot[p.cell * 4 + p.slot] = r.slot;
    nbCell[r.cell * 4 + r.slot] = p.cell;
    nbSlot[r.cell * 4 + r.slot] = p.slot;
    const same = p.a === r.a && p.b === r.b ? 1 : 0; // opposite winding (the norm) ⇒ 0
    nbSameDir[p.cell * 4 + p.slot] = same;
    nbSameDir[r.cell * 4 + r.slot] = same;
  }

  // ---- 5. Laplacian relaxation (boundary pinned) --------------------------
  // Vertex adjacency over quad edges; average interior vertices toward their neighbours to round
  // the mesh. Purely geometric — the topology above is already frozen.
  if (opts.relax > 0) {
    const adj: Set<number>[] = Array.from({ length: vx.length }, () => new Set<number>());
    for (const q of quads) {
      for (let s = 0; s < 4; s++) {
        const a = q[s];
        const b = q[(s + 1) % 4];
        adj[a].add(b);
        adj[b].add(a);
      }
    }
    for (let it = 0; it < opts.relax; it++) {
      const nxX = vx.slice();
      const nxY = vy.slice();
      for (let v = 0; v < vx.length; v++) {
        if (isBoundaryLattice[v] || adj[v].size === 0) continue;
        let sx = 0;
        let sy = 0;
        for (const u of adj[v]) {
          sx += vx[u];
          sy += vy[u];
        }
        // A light pull (0.5) toward the neighbour centroid keeps it stable and gentle.
        nxX[v] = vx[v] + 0.5 * (sx / adj[v].size - vx[v]);
        nxY[v] = vy[v] + 0.5 * (sy / adj[v].size - vy[v]);
      }
      for (let v = 0; v < vx.length; v++) {
        vx[v] = nxX[v];
        vy[v] = nxY[v];
      }
    }
  }

  // ---- assemble ------------------------------------------------------------
  const vertices: Vec2[] = vx.map((x, i) => ({ x, y: vy[i] }));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of vertices) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const cells: MeshCell[] = quads.map((q) => {
    const poly = q.map((v) => ({ x: vx[v], y: vy[v] })) as [Vec2, Vec2, Vec2, Vec2];
    const mids = [0, 1, 2, 3].map((s) => {
      const p = poly[s];
      const n = poly[(s + 1) % 4];
      return { x: (p.x + n.x) / 2, y: (p.y + n.y) / 2 };
    }) as [Vec2, Vec2, Vec2, Vec2];
    const centroid = {
      x: (poly[0].x + poly[1].x + poly[2].x + poly[3].x) / 4,
      y: (poly[0].y + poly[1].y + poly[2].y + poly[3].y) / 4,
    };
    let inradius = Infinity;
    for (const m of mids) {
      const d = Math.hypot(m.x - centroid.x, m.y - centroid.y);
      if (d < inradius) inradius = d;
    }
    return { verts: q as [number, number, number, number], poly, mids, centroid, inradius };
  });

  return { vertices, cells, nbCell, nbSlot, nbSameDir, bounds: { minX, minY, maxX, maxY }, boundaryEdges };
}

/**
 * Randomly merge adjacent triangle pairs into quads (a maximal matching over the triangle-adjacency
 * graph, in a seed-shuffled order). Each matched pair drops its shared diagonal and stitches the
 * four remaining vertices into a CCW quad from the triangles' own winding. Unmatched triangles pass
 * through untouched.
 */
function mergeTriangles(tris: Face[], rng: Rng): Face[] {
  // Map each interior edge to the (two) triangles that share it.
  const byEdge = new Map<number, number[]>();
  for (let t = 0; t < tris.length; t++) {
    const f = tris[t];
    for (let s = 0; s < 3; s++) {
      const k = edgeKey(f[s], f[(s + 1) % 3]);
      let list = byEdge.get(k);
      if (!list) byEdge.set(k, (list = []));
      list.push(t);
    }
  }
  // Candidate merges: each interior edge shared by exactly two triangles.
  const cands: Array<{ e: number; t0: number; t1: number }> = [];
  for (const [e, ts] of byEdge) if (ts.length === 2) cands.push({ e, t0: ts[0], t1: ts[1] });
  // Fisher–Yates shuffle with the seeded RNG for a deterministic, unbiased matching order.
  for (let i = cands.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = cands[i];
    cands[i] = cands[j];
    cands[j] = tmp;
  }
  const used = new Array<boolean>(tris.length).fill(false);
  const out: Face[] = [];
  for (const c of cands) {
    if (used[c.t0] || used[c.t1]) continue;
    const shared = decodeEdge(c.e);
    const quad = mergeQuad(tris[c.t0], tris[c.t1], shared[0], shared[1]);
    if (!quad) continue;
    used[c.t0] = true;
    used[c.t1] = true;
    out.push(quad);
  }
  for (let t = 0; t < tris.length; t++) if (!used[t]) out.push(tris[t]);
  return out;
}

function decodeEdge(k: number): [number, number] {
  return [Math.floor(k / 0x40000000), k % 0x40000000];
}

/** Does CCW triangle `tri` traverse the directed edge `a → b`? */
function hasDirectedEdge(tri: Face, a: number, b: number): boolean {
  for (let i = 0; i < 3; i++) if (tri[i] === a && tri[(i + 1) % 3] === b) return true;
  return false;
}

/**
 * Merge two CCW triangles sharing undirected edge {a,b} into a CCW quad — *combinatorially*, from
 * the triangles' own winding, so it never depends on (possibly jittered) coordinates. Two CCW faces
 * sharing an edge traverse it in opposite senses, so exactly one triangle carries a→b (apex x) and
 * the other b→a (apex y); the union boundary is the CCW ring [a, y, b, x], with a and b — the shared
 * corners — sitting opposite each other. (An earlier version ordered by angle about the centroid,
 * which under jitter could mis-pair the corners and tear cracks into the mesh.)
 */
function mergeQuad(t0: Face, t1: Face, a: number, b: number): Face | null {
  const tAB = hasDirectedEdge(t0, a, b) ? t0 : t1;
  const tBA = tAB === t0 ? t1 : t0;
  if (!hasDirectedEdge(tBA, b, a)) return null; // inconsistent winding — leave unmerged
  const x = tAB.find((v) => v !== a && v !== b);
  const y = tBA.find((v) => v !== a && v !== b);
  if (x === undefined || y === undefined || x === y) return null;
  return [a, y, b, x];
}
