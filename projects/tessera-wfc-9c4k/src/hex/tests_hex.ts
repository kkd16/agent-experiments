// Hex Proof Lab — an in-app verification suite for the hexagonal engine, in the house style of the
// 2D and 3D Proof Labs. It runs the *real* compiler and the *real* solver and proves the properties
// the renderer relies on, deterministically and sharing no code with the propagation it checks.
//
// Pillars:
//   1. The lattice algebra is sound — six clockwise directions whose opposite is (d+3) mod 6, a
//      60° rotation that is a closed cyclic shift (rotate⁶ = identity), and a `fits` rule that is
//      symmetric across a seam.
//   2. The compiled adjacency tensor matches the edge rule exactly and is symmetric: B may sit in
//      dir d of A iff A may sit in dir opposite(d) of B.
//   3. The headline: the solver is deterministic from a seed, and every *finished* solve is fully
//      6-neighbour adjacency-valid — re-checked the long way against the edge rule.

import { compileHex } from './compile_hex';
import { DELTA_AX, DIRS6, fits6, opposite6, reverseCode, rotateHexEdges, type Dir6, type HexEdges } from './hexgrid';
import { HexSolver } from './hexsolver';
import { HEX_TILESETS } from './tilesets/index';
import type { CompiledHexTileset } from './types_hex';

export type TestResult = { name: string; pass: boolean; detail: string };
export type TestGroup = { group: string; results: TestResult[] };

// ---- 1. lattice algebra ----------------------------------------------------

function latticeTests(): TestResult[] {
  const out: TestResult[] = [];

  // opposite is an involution and the (d+3) partner
  let oppFail = 0;
  for (const d of DIRS6) {
    if (opposite6(d) !== ((d + 3) % 6)) oppFail++;
    if (opposite6(opposite6(d)) !== d) oppFail++;
  }
  out.push({ name: 'opposite(d) = d+3 mod 6, involutive', pass: oppFail === 0, detail: oppFail === 0 ? 'ok' : `${oppFail} bad` });

  // opposite directions are geometric negatives
  let negFail = 0;
  for (const d of DIRS6) {
    const [dq, dr] = DELTA_AX[d];
    const [oq, orr] = DELTA_AX[opposite6(d)];
    if (dq !== -oq || dr !== -orr) negFail++;
  }
  out.push({ name: 'opposite step = negated step', pass: negFail === 0, detail: negFail === 0 ? '6/6' : `${negFail} bad` });

  // rotation group closure: six 60° steps is the identity, and rotation shifts edges by one slot
  let rotFail = 0;
  const probe: HexEdges = ['a', 'b', 'c', 'd', 'e', 'f'];
  if (rotateHexEdges(probe, 6).join('') !== probe.join('')) rotFail++;
  const r1 = rotateHexEdges(probe, 1);
  for (const d of DIRS6) if (r1[d] !== probe[(d - 1 + 6) % 6]) rotFail++;
  out.push({ name: 'rotate⁶ = identity, rotate¹ = shift', pass: rotFail === 0, detail: rotFail === 0 ? 'closed' : `${rotFail} bad` });

  // fits is symmetric across a seam for every edge-code pair the sets use
  const codes = new Set<string>();
  for (const ts of HEX_TILESETS) for (const p of ts.prototypes) for (const e of p.edges) codes.add(e);
  const list = [...codes];
  let symFail = 0;
  for (const a of list)
    for (const b of list) {
      // a on dir d connects to b on opp(d)  ⇔  b on dir d connects to a on opp(d)
      const ab = a === reverseCode(b);
      const ba = b === reverseCode(a);
      if (ab !== ba) symFail++;
    }
  out.push({ name: 'edge fit is seam-symmetric', pass: symFail === 0, detail: symFail === 0 ? `${list.length}² codes` : `${symFail} asym` });

  return out;
}

// ---- 2. adjacency tensor ---------------------------------------------------

function tensorTests(): TestResult[] {
  const out: TestResult[] = [];
  for (const ts of HEX_TILESETS) {
    const c = compileHex(ts);
    let asym = 0;
    for (const d of DIRS6) {
      const opp = opposite6(d);
      for (let a = 0; a < c.variants.length; a++) for (const b of c.allowed[d][a]) if (!c.allowed[opp][b].includes(a)) asym++;
    }
    let mismatch = 0;
    for (const d of DIRS6) {
      for (let a = 0; a < c.variants.length; a++)
        for (let b = 0; b < c.variants.length; b++) {
          const inList = c.allowed[d][a].includes(b);
          const rule = fits6(c.variants[a].edges, c.variants[b].edges, d);
          if (inList !== rule) mismatch++;
        }
    }
    out.push({
      name: `${ts.name}: adjacency symmetric + rule-exact`,
      pass: asym === 0 && mismatch === 0,
      detail: asym === 0 && mismatch === 0 ? `${c.variants.length} variants` : `${asym} asym, ${mismatch} mismatch`,
    });
  }
  return out;
}

// ---- 3. solver guarantees --------------------------------------------------

function solveToEnd(c: CompiledHexTileset, seed: string, cols: number, rows: number, wrap = false): HexSolver {
  const sv = new HexSolver(c, { cols, rows, seed, wrap, backtracking: true, backtrackBudget: 8000 });
  let guard = 0;
  while (sv.status === 'running' && guard++ < 200000) sv.step();
  return sv;
}

/** Independent 6-neighbour adjacency check over a finished board (no shared code with propagation). */
function adjacencyViolations(c: CompiledHexTileset, sv: HexSolver, cols: number, rows: number): number {
  let v = 0;
  for (let r = 0; r < rows; r++)
    for (let q = 0; q < cols; q++) {
      const t = sv.collapsedTile(q + cols * r);
      if (t < 0) {
        v++;
        continue;
      }
      for (const d of DIRS6) {
        const [dq, dr] = DELTA_AX[d as Dir6];
        const nq = q + dq;
        const nr = r + dr;
        if (nq < 0 || nr < 0 || nq >= cols || nr >= rows) continue;
        const tn = sv.collapsedTile(nq + cols * nr);
        if (tn < 0) {
          v++;
          continue;
        }
        if (!fits6(c.variants[t].edges, c.variants[tn].edges, d as Dir6)) v++;
      }
    }
  return v;
}

function solverTests(): TestResult[] {
  const out: TestResult[] = [];
  const COLS = 9;
  const ROWS = 9;
  const SEEDS = 8;

  for (const ts of HEX_TILESETS) {
    const c = compileHex(ts);
    let done = 0;
    let viol = 0;
    for (let s = 0; s < SEEDS; s++) {
      const sv = solveToEnd(c, `proof-${s}`, COLS, ROWS);
      if (sv.status === 'done') {
        done++;
        viol += adjacencyViolations(c, sv, COLS, ROWS);
      }
    }
    out.push({
      name: `${ts.name}: finished solves are adjacency-valid`,
      pass: done > 0 && viol === 0,
      detail: viol === 0 ? `${done}/${SEEDS} solved, 0 violations` : `${viol} violations`,
    });
  }

  // toroidal wrap stays valid across the seam
  {
    const c = compileHex(HEX_TILESETS[0]);
    const sv = solveToEnd(c, 'torus', 8, 8, true);
    let wrapViol = 0;
    if (sv.status === 'done') {
      for (let r = 0; r < 8; r++)
        for (let q = 0; q < 8; q++) {
          const t = sv.collapsedTile(q + 8 * r);
          for (const d of DIRS6) {
            const [dq, dr] = DELTA_AX[d as Dir6];
            const nq = ((q + dq) % 8 + 8) % 8;
            const nr = ((r + dr) % 8 + 8) % 8;
            const tn = sv.collapsedTile(nq + 8 * nr);
            if (t < 0 || tn < 0 || !fits6(c.variants[t].edges, c.variants[tn].edges, d as Dir6)) wrapViol++;
          }
        }
    }
    out.push({ name: 'toroidal wrap: seam adjacency valid', pass: sv.status === 'done' && wrapViol === 0, detail: sv.status === 'done' ? `${wrapViol} violations` : 'did not finish' });
  }

  // determinism: same seed ⇒ identical board
  let detFail = 0;
  for (const ts of HEX_TILESETS) {
    const c = compileHex(ts);
    const a = solveToEnd(c, 'det', COLS, ROWS);
    const b = solveToEnd(c, 'det', COLS, ROWS);
    for (let cell = 0; cell < COLS * ROWS; cell++) if (a.collapsedTile(cell) !== b.collapsedTile(cell)) detFail++;
  }
  out.push({ name: 'deterministic from a seed', pass: detFail === 0, detail: detFail === 0 ? 'bit-identical' : `${detFail} cells differ` });

  return out;
}

export function runAllTestsHex(): TestGroup[] {
  return [
    { group: 'Lattice algebra', results: latticeTests() },
    { group: 'Adjacency tensor', results: tensorTests() },
    { group: 'Solver guarantees', results: solverTests() },
  ];
}

export function testCountHex(groups: TestGroup[]): { passed: number; total: number } {
  let passed = 0;
  let total = 0;
  for (const g of groups) for (const r of g.results) {
    total++;
    if (r.pass) passed++;
  }
  return { passed, total };
}
