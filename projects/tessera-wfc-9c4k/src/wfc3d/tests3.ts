// 3D Proof Lab — an in-app verification suite for the volumetric engine, in the house style of
// the 2D Proof Lab (../wfc/tests.ts) and the other engine projects: it runs the *real* compiler
// and the *real* solver and proves the properties the renderer relies on, deterministically.
//
// Pillars:
//   1. The socket algebra is sound — `connects` is symmetric, and the rotation group is closed
//      (rotating a tile four times is the identity, on both geometry and sockets).
//   2. The compiled adjacency tensor is symmetric: B may sit in dir d of A iff A may sit in dir
//      opposite(d) of B. (If this fails, propagation can wedge or accept invalid tilings.)
//   3. The headline: the solver is deterministic from a seed, and every *finished* solve is fully
//      6-neighbour adjacency-valid — re-checked the long way against the socket rule, sharing no
//      code with the support-counter propagation that produced it.

import { compile3, rotateFaces } from './compile3';
import { DELTA3, DIRS3, opposite3, type Dir3 } from './dirs3';
import { connects, type Faces } from './sockets3';
import { Solver3 } from './solver3';
import { TILESETS3 } from './tilesets3/index';
import type { CompiledTileset3 } from './types3';
import { modelKey, rotateY } from './voxel';

export type TestResult = { name: string; pass: boolean; detail: string };
export type TestGroup = { group: string; results: TestResult[] };

function facesKey(f: Faces): string {
  return f
    .map((s) => (s.kind === 'h' ? `h${s.key}${s.sym ? 's' : s.flip ? 'f' : ''}` : `v${s.key}${s.inv ? 'i' : s.rot}`))
    .join('|');
}

// ---- 1. socket algebra -----------------------------------------------------

function socketTests(): TestResult[] {
  const out: TestResult[] = [];
  // gather every socket the tilesets actually use
  const sockets = [];
  for (const ts of TILESETS3) for (const p of ts.prototypes) for (const s of p.sockets) sockets.push(s);

  let symFail = 0;
  for (const a of sockets) for (const b of sockets) if (connects(a, b) !== connects(b, a)) symFail++;
  out.push({
    name: 'connects() is symmetric',
    pass: symFail === 0,
    detail: symFail === 0 ? `${sockets.length}² pairs` : `${symFail} asymmetric pairs`,
  });

  // a horizontal socket never connects to a vertical one
  let mix = 0;
  for (const a of sockets) for (const b of sockets) if (a.kind !== b.kind && connects(a, b)) mix++;
  out.push({ name: 'horizontal ⊥ vertical never connect', pass: mix === 0, detail: mix === 0 ? 'ok' : `${mix} crossings` });

  // rotation group closure on sockets: 4 quarter-turns is the identity
  let rotFail = 0;
  for (const ts of TILESETS3)
    for (const p of ts.prototypes) if (facesKey(rotateFaces(p.sockets, 4)) !== facesKey(p.sockets)) rotFail++;
  out.push({ name: 'socket rotation⁴ = identity', pass: rotFail === 0, detail: rotFail === 0 ? 'closed' : `${rotFail} tiles` });

  // rotation group closure on geometry
  let geoFail = 0;
  for (const ts of TILESETS3)
    for (const p of ts.prototypes) if (modelKey(rotateY(p.model, 4)) !== modelKey(p.model)) geoFail++;
  out.push({ name: 'geometry rotation⁴ = identity', pass: geoFail === 0, detail: geoFail === 0 ? 'closed' : `${geoFail} tiles` });

  return out;
}

// ---- 2. adjacency tensor ---------------------------------------------------

function tensorTests(): TestResult[] {
  const out: TestResult[] = [];
  for (const ts of TILESETS3) {
    const c = compile3(ts);
    let asym = 0;
    for (const d of DIRS3) {
      const opp = opposite3(d);
      for (let a = 0; a < c.variants.length; a++)
        for (const b of c.allowed[d][a]) if (!c.allowed[opp][b].includes(a)) asym++;
    }
    // also: the tensor must agree with a fresh evaluation of the socket rule
    let mismatch = 0;
    for (const d of DIRS3) {
      const opp = opposite3(d);
      for (let a = 0; a < c.variants.length; a++)
        for (let b = 0; b < c.variants.length; b++) {
          const inList = c.allowed[d][a].includes(b);
          const rule = connects(c.variants[a].sockets[d], c.variants[b].sockets[opp]);
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

function solveToEnd(c: CompiledTileset3, seed: string, sx: number, sy: number, sz: number): Solver3 {
  const sv = new Solver3(c, { sizeX: sx, sizeY: sy, sizeZ: sz, seed, wrap: false, backtracking: true, backtrackBudget: 6000 });
  let guard = 0;
  while (sv.status === 'running' && guard++ < 400000) sv.step();
  return sv;
}

/** Independent 6-neighbour adjacency check over a finished grid (no shared code with propagation). */
function adjacencyViolations(c: CompiledTileset3, sv: Solver3, sx: number, sy: number, sz: number): number {
  let v = 0;
  for (let x = 0; x < sx; x++)
    for (let y = 0; y < sy; y++)
      for (let z = 0; z < sz; z++) {
        const t = sv.collapsedTile(x + sx * (y + sy * z));
        if (t < 0) {
          v++;
          continue;
        }
        for (const d of DIRS3) {
          const [dx, dy, dz] = DELTA3[d as Dir3];
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;
          if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
          const tn = sv.collapsedTile(nx + sx * (ny + sy * nz));
          if (tn < 0) {
            v++;
            continue;
          }
          if (!connects(c.variants[t].sockets[d], c.variants[tn].sockets[opposite3(d)])) v++;
        }
      }
  return v;
}

function solverTests(): TestResult[] {
  const out: TestResult[] = [];
  const SX = 7;
  const SY = 4;
  const SZ = 7;

  for (const ts of TILESETS3) {
    const c = compile3(ts);
    let done = 0;
    let viol = 0;
    const SEEDS = 8;
    for (let s = 0; s < SEEDS; s++) {
      const sv = solveToEnd(c, `proof-${s}`, SX, SY, SZ);
      if (sv.status === 'done') {
        done++;
        viol += adjacencyViolations(c, sv, SX, SY, SZ);
      }
    }
    out.push({
      name: `${ts.name}: finished solves are adjacency-valid`,
      pass: done > 0 && viol === 0,
      detail: viol === 0 ? `${done}/${SEEDS} solved, 0 violations` : `${viol} violations`,
    });
  }

  // determinism: same seed ⇒ identical tiling
  let detFail = 0;
  for (const ts of TILESETS3) {
    const c = compile3(ts);
    const a = solveToEnd(c, 'det', SX, SY, SZ);
    const b = solveToEnd(c, 'det', SX, SY, SZ);
    for (let cell = 0; cell < SX * SY * SZ; cell++) if (a.collapsedTile(cell) !== b.collapsedTile(cell)) detFail++;
  }
  out.push({ name: 'deterministic from a seed', pass: detFail === 0, detail: detFail === 0 ? 'bit-identical' : `${detFail} cells differ` });

  return out;
}

export function runAllTests3(): TestGroup[] {
  return [
    { group: 'Socket algebra', results: socketTests() },
    { group: 'Adjacency tensor', results: tensorTests() },
    { group: 'Solver guarantees', results: solverTests() },
  ];
}

export function testCount3(groups: TestGroup[]): { passed: number; total: number } {
  let passed = 0;
  let total = 0;
  for (const g of groups) for (const r of g.results) {
    total++;
    if (r.pass) passed++;
  }
  return { passed, total };
}
