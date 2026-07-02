// Mesh Proof Lab — an in-app verification suite for the irregular-grid engine, in the house style of
// the 2D / 3D / hex Proof Labs. It runs the *real* mesh generator, the *real* compiler and the
// *real* solver, and proves — deterministically, and sharing no code with the propagation it checks
// — the properties the renderer and solver rely on.
//
// Pillars:
//   1. The generated mesh is a valid 2-manifold-with-boundary: every cell is a quad, every interior
//      edge is shared by exactly two cells traced in *opposite* senses, adjacency is symmetric, and
//      the Euler characteristic of the disk (V − E + F = 1) holds. Topology is combinatorial, so it
//      must hold for every seed, jitter and relaxation setting.
//   2. The socket algebra is sound and the compiled adjacency tensor is symmetric: B may sit across
//      (sA, sB) of A iff A may sit across (sB, sA) of B.
//   3. The headline: the solver is deterministic from a seed (same mesh *and* same collapse), and
//      every *finished* solve is fully edge-adjacency-valid — re-checked the long way against the
//      socket rule — with no connection ever dead-ending into a blank across a real seam.

import { buildMesh, type Mesh, type MeshOptions } from './mesh';
import { compileMesh } from './compile_mesh';
import { MeshSolver } from './meshsolver';
import { MESH_TILESETS } from './tilesets/index';
import { reverseSocket, type CompiledMeshTileset } from './meshtypes';

export type TestResult = { name: string; pass: boolean; detail: string };
export type TestGroup = { group: string; results: TestResult[] };

const SEEDS = ['amber-koi-3f7', 'cobalt-fox-a12', 'jade-wren-9x', 'ember-asp-004', 'slate-orca-7c'];

function meshOpts(seed: string, over?: Partial<MeshOptions>): MeshOptions {
  return { cols: 8, rows: 8, seed, jitter: 30, relax: 3, merge: true, ...over };
}

// ---- 1. mesh topology ------------------------------------------------------

function edgeKey(a: number, b: number): number {
  return a < b ? a * 0x40000000 + b : b * 0x40000000 + a;
}

function topologyTests(): TestResult[] {
  const out: TestResult[] = [];

  // adjacency symmetry + opposite-winding seams across many seeds/settings.
  let symFail = 0;
  let dirFail = 0;
  let vertMismatch = 0;
  let cellsChecked = 0;
  const configs: MeshOptions[] = [
    meshOpts(SEEDS[0]),
    meshOpts(SEEDS[1], { merge: false }),
    meshOpts(SEEDS[2], { jitter: 0, relax: 0 }),
    meshOpts(SEEDS[3], { cols: 5, rows: 11 }),
  ];
  for (const opts of configs) {
    const mesh = buildMesh(opts);
    cellsChecked += mesh.cells.length;
    for (let c = 0; c < mesh.cells.length; c++) {
      for (let s = 0; s < 4; s++) {
        const nb = mesh.nbCell[c * 4 + s];
        if (nb < 0) continue;
        const ns = mesh.nbSlot[c * 4 + s];
        // symmetry
        if (mesh.nbCell[nb * 4 + ns] !== c || mesh.nbSlot[nb * 4 + ns] !== s) symFail++;
        // the two slots name the same physical edge
        const a = mesh.cells[c].verts[s];
        const b = mesh.cells[c].verts[(s + 1) % 4];
        const p = mesh.cells[nb].verts[ns];
        const q = mesh.cells[nb].verts[(ns + 1) % 4];
        if (edgeKey(a, b) !== edgeKey(p, q)) vertMismatch++;
        // opposite winding is the norm ⇒ sameDir flag 0
        if (mesh.nbSameDir[c * 4 + s] !== 0) dirFail++;
      }
    }
  }
  out.push({ name: 'adjacency is symmetric (a↔b)', pass: symFail === 0, detail: symFail === 0 ? `over ${cellsChecked} cells` : `${symFail} bad` });
  out.push({ name: 'paired slots name one physical edge', pass: vertMismatch === 0, detail: vertMismatch === 0 ? 'ok' : `${vertMismatch} bad` });
  out.push({ name: 'interior seams read in opposite senses', pass: dirFail === 0, detail: dirFail === 0 ? 'sameDir≡0' : `${dirFail} clashes` });

  // every interior edge shared by exactly two cells; boundary edges by one.
  let manifoldFail = 0;
  const mesh = buildMesh(meshOpts(SEEDS[4]));
  const count = new Map<number, number>();
  for (let c = 0; c < mesh.cells.length; c++) {
    for (let s = 0; s < 4; s++) {
      const a = mesh.cells[c].verts[s];
      const b = mesh.cells[c].verts[(s + 1) % 4];
      const k = edgeKey(a, b);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  let interior = 0;
  let boundary = 0;
  for (const v of count.values()) {
    if (v === 2) interior++;
    else if (v === 1) boundary++;
    else manifoldFail++;
  }
  out.push({
    name: 'every edge shared by ≤ 2 cells (manifold)',
    pass: manifoldFail === 0,
    detail: manifoldFail === 0 ? `${interior} interior · ${boundary} boundary` : `${manifoldFail} non-manifold`,
  });

  // Euler characteristic of a disk: V − E + F = 1 (interior faces only).
  const usedV = new Set<number>();
  for (const cell of mesh.cells) for (const v of cell.verts) usedV.add(v);
  const V = usedV.size;
  const E = count.size;
  const F = mesh.cells.length;
  const chi = V - E + F;
  out.push({ name: 'Euler χ = V − E + F = 1 (a disk)', pass: chi === 1, detail: `V=${V} E=${E} F=${F} χ=${chi}` });

  return out;
}

// ---- 2. socket algebra + compiler -----------------------------------------

function algebraTests(): TestResult[] {
  const out: TestResult[] = [];

  // reverse is an involution and (for these single-char codes) the identity.
  let revFail = 0;
  const codes = new Set<string>();
  for (const ts of MESH_TILESETS) for (const p of ts.prototypes) for (const e of p.sockets) codes.add(e);
  for (const c of codes) if (reverseSocket(reverseSocket(c)) !== c) revFail++;
  out.push({ name: 'reverseSocket is involutive', pass: revFail === 0, detail: `${codes.size} codes` });

  // tensor symmetry: tB ∈ allowedOpp[sA,sB][tA] ⟺ tA ∈ allowedOpp[sB,sA][tB].
  let tensorFail = 0;
  let variants = 0;
  for (const ts of MESH_TILESETS) {
    const set = compileMesh(ts);
    variants += set.variants.length;
    const n = set.variants.length;
    for (let sA = 0; sA < 4; sA++) {
      for (let sB = 0; sB < 4; sB++) {
        for (let a = 0; a < n; a++) {
          const fwd = new Set(set.allowedOpp[sA * 4 + sB][a]);
          for (let b = 0; b < n; b++) {
            const back = set.allowedOpp[sB * 4 + sA][b].includes(a);
            if (fwd.has(b) !== back) tensorFail++;
          }
        }
      }
    }
  }
  out.push({ name: 'adjacency tensor is symmetric', pass: tensorFail === 0, detail: tensorFail === 0 ? `${variants} variants` : `${tensorFail} bad` });

  // rotations dedup: no two variants of a set carry an identical (proto, sockets) pair.
  let dupFail = 0;
  for (const ts of MESH_TILESETS) {
    const set = compileMesh(ts);
    const seen = new Set<string>();
    for (const v of set.variants) {
      const k = `${v.proto}|${v.sockets.join(',')}`;
      if (seen.has(k)) dupFail++;
      seen.add(k);
    }
  }
  out.push({ name: 'rotation expansion is duplicate-free', pass: dupFail === 0, detail: dupFail === 0 ? 'ok' : `${dupFail} dup` });

  return out;
}

// ---- headless solve helper -------------------------------------------------

function solveToEnd(mesh: Mesh, set: CompiledMeshTileset, seed: string): MeshSolver {
  let solver = new MeshSolver(mesh, set, { seed, backtracking: true, backtrackBudget: 12000 });
  let restarts = 0;
  let guard = 0;
  while (solver.status === 'running' && guard++ < 200000) {
    const st = solver.step();
    if (st === 'failed') {
      if (++restarts > 200) break;
      solver = new MeshSolver(mesh, set, { seed: `${seed}#${restarts}`, backtracking: true, backtrackBudget: 12000 });
    }
  }
  return solver;
}

/** Independently re-check that a finished solve satisfies the socket rule on every real seam. */
function validateSolve(mesh: Mesh, set: CompiledMeshTileset, solver: MeshSolver): { bad: number; blanks: number } {
  let bad = 0;
  let blanks = 0;
  for (let c = 0; c < mesh.cells.length; c++) {
    const tc = solver.collapsedTile(c);
    if (tc < 0) continue;
    for (let s = 0; s < 4; s++) {
      const nb = mesh.nbCell[c * 4 + s];
      if (nb < 0) continue;
      const ns = mesh.nbSlot[c * 4 + s];
      const tn = solver.collapsedTile(nb);
      if (tn < 0) continue;
      const codeA = set.variants[tc].sockets[s];
      const codeB = set.variants[tn].sockets[ns];
      const same = mesh.nbSameDir[c * 4 + s] === 1;
      const ok = same ? codeA === codeB : codeA === reverseSocket(codeB);
      if (!ok) bad++;
      // a connection must never face a blank across a real seam
      const openA = codeA !== set.emptyEdge;
      const openB = codeB !== set.emptyEdge;
      if (openA !== openB) blanks++;
    }
  }
  return { bad, blanks };
}

// ---- 3. determinism + 4. the headline -------------------------------------

function solveTests(): TestResult[] {
  const out: TestResult[] = [];
  const paths = compileMesh(MESH_TILESETS[0]);

  // determinism: same seed+config ⇒ identical mesh AND identical collapse.
  let meshDiff = 0;
  let solveDiff = 0;
  {
    const m1 = buildMesh(meshOpts('determinism-x'));
    const m2 = buildMesh(meshOpts('determinism-x'));
    if (m1.vertices.length !== m2.vertices.length) meshDiff++;
    for (let i = 0; i < m1.vertices.length; i++) {
      if (m1.vertices[i].x !== m2.vertices[i].x || m1.vertices[i].y !== m2.vertices[i].y) meshDiff++;
    }
    const s1 = solveToEnd(m1, paths, 'run-1');
    const s2 = solveToEnd(m2, paths, 'run-1');
    for (let c = 0; c < m1.cells.length; c++) if (s1.collapsedTile(c) !== s2.collapsedTile(c)) solveDiff++;
  }
  out.push({ name: 'mesh is bit-for-bit deterministic', pass: meshDiff === 0, detail: meshDiff === 0 ? 'ok' : `${meshDiff} diff` });
  out.push({ name: 'collapse is deterministic from a seed', pass: solveDiff === 0, detail: solveDiff === 0 ? 'ok' : `${solveDiff} cells differ` });

  // the headline: every finished solve is adjacency-valid, across seeds and tilesets.
  let totalBad = 0;
  let totalBlank = 0;
  let solved = 0;
  let attempts = 0;
  for (const ts of MESH_TILESETS) {
    const set = compileMesh(ts);
    for (const seed of SEEDS) {
      attempts++;
      const mesh = buildMesh(meshOpts(seed, { cols: 7, rows: 7 }));
      const solver = solveToEnd(mesh, set, `solve-${seed}`);
      if (solver.status === 'done') solved++;
      const { bad, blanks } = validateSolve(mesh, set, solver);
      totalBad += bad;
      totalBlank += blanks;
    }
  }
  out.push({ name: 'finished solves are 4-edge adjacency-valid', pass: totalBad === 0, detail: totalBad === 0 ? `${attempts} runs clean` : `${totalBad} bad seams` });
  out.push({ name: 'no connection dead-ends across a seam', pass: totalBlank === 0, detail: totalBlank === 0 ? 'ok' : `${totalBlank} mismatched` });
  out.push({ name: 'solver reaches a full tiling', pass: solved === attempts, detail: `${solved}/${attempts} solved` });

  return out;
}

export function runAllTestsMesh(): TestGroup[] {
  return [
    { group: 'Mesh topology (a valid manifold)', results: topologyTests() },
    { group: 'Socket algebra + compiler', results: algebraTests() },
    { group: 'Determinism + the adjacency headline', results: solveTests() },
  ];
}

export function testCountMesh(groups: TestGroup[]): { passed: number; total: number } {
  let passed = 0;
  let total = 0;
  for (const g of groups) for (const r of g.results) {
    total++;
    if (r.pass) passed++;
  }
  return { passed, total };
}
