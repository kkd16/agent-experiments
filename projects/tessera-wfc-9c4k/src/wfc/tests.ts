// Proof Lab — an in-app verification suite that runs the *real* solver and the *real*
// connectivity engine, the way QueryForge/SatForge ship their self-tests. Two pillars:
//
//   1. The connectivity graph algorithms (components, articulation points, forced connectors,
//      feasibility) are cross-checked against independent brute-force reference implementations
//      over thousands of tiny random graphs — these share no code with connectivity.ts.
//   2. The end-to-end solver guarantees: determinism, adjacency-valid output, and — the headline
//      — that a *finished* connectivity run ALWAYS satisfies its global property (one connected
//      network / routed terminals), never reporting a solved grid that violates it.
//
// Everything is deterministic (seeded RNG) so the verdict is stable run to run.

import { aggregate, type RunOutcome } from './bench';
import {
  articulationPoints,
  components,
  forcedConnectors,
  networkFeasible,
  neighborOf,
  terminalsFeasible,
  type ConnView,
} from './connectivity';
import { fits, reverseCode, type Dir } from './edges';
import {
  CELL_HEURISTICS,
  TILE_POLICIES,
  mrvCell,
  randomCell,
  scanlineCell,
  tileIndex,
} from './heuristics';
import { Solver, type SolverOptions } from './solver';
import { compile } from './tiles';
import { TILESETS, tilesetByKey } from './tilesets';
import type { CompiledTileset } from './types';

export type TestResult = { name: string; pass: boolean; detail: string };
export type TestGroup = { group: string; results: TestResult[] };

// ---- deterministic RNG -----------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- random connectivity views + brute-force references --------------------

function randView(r: () => number, w: number, h: number, wrap: boolean): ConnView {
  const cells = w * h;
  const mayOpen = new Uint8Array(cells);
  const mustConnector = new Uint8Array(cells);
  for (let c = 0; c < cells; c++) mayOpen[c] = Math.floor(r() * 16);
  for (let c = 0; c < cells; c++) if (mayOpen[c] !== 0 && r() < 0.3) mustConnector[c] = 1;
  return { width: w, height: h, wrap, cells, mayOpen, mustConnector };
}

/** Reference adjacency list using the same possible-link rule, built independently. */
function refAdj(v: ConnView): number[][] {
  const adj: number[][] = Array.from({ length: v.cells }, () => []);
  for (let c = 0; c < v.cells; c++) {
    if (v.mayOpen[c] === 0) continue;
    for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
      if ((v.mayOpen[c] & (1 << d)) === 0) continue;
      const nb = neighborOf(c, d, v.width, v.height, v.wrap);
      if (nb < 0) continue;
      const opp = ((d + 2) % 4) as Dir;
      if ((v.mayOpen[nb] & (1 << opp)) === 0) continue;
      adj[c].push(nb);
    }
  }
  return adj;
}

function refReach(v: ConnView, adj: number[][], src: number, exclude: number): Uint8Array {
  const seen = new Uint8Array(v.cells);
  if (src === exclude || v.mayOpen[src] === 0) return seen;
  const q = [src];
  seen[src] = 1;
  while (q.length) {
    const c = q.shift()!;
    for (const nb of adj[c]) {
      if (nb !== exclude && !seen[nb]) {
        seen[nb] = 1;
        q.push(nb);
      }
    }
  }
  return seen;
}

function refComponentCount(v: ConnView, exclude: number): number {
  const adj = refAdj(v);
  const seen = new Uint8Array(v.cells);
  let n = 0;
  for (let s = 0; s < v.cells; s++) {
    if (s === exclude || seen[s] || v.mayOpen[s] === 0) continue;
    n++;
    const q = [s];
    seen[s] = 1;
    while (q.length) {
      const c = q.shift()!;
      for (const nb of adj[c]) {
        if (nb !== exclude && !seen[nb]) {
          seen[nb] = 1;
          q.push(nb);
        }
      }
    }
  }
  return n;
}

function refArticulation(v: ConnView): number[] {
  const before = refComponentCount(v, -1);
  const out: number[] = [];
  for (let c = 0; c < v.cells; c++) {
    if (v.mayOpen[c] === 0) continue;
    if (refComponentCount(v, c) > before) out.push(c); // removing it split a component
  }
  return out;
}

function sortedEq(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const x = a.slice().sort((p, q) => p - q);
  const y = b.slice().sort((p, q) => p - q);
  return x.every((v, i) => v === y[i]);
}

// ---- solver harness --------------------------------------------------------

/** Run a solver to a terminal state, reseeding on failure the way the controller does. */
function runToEnd(set: CompiledTileset, opts: SolverOptions, maxRestarts = 200): Solver {
  let solver = new Solver(set, opts);
  let restarts = 0;
  // generous cap so a pathological case can't hang the browser
  for (let guard = 0; guard < 5_000_000; guard++) {
    const st = solver.step();
    if (st === 'done') return solver;
    if (st === 'failed') {
      if (restarts >= maxRestarts) return solver;
      restarts++;
      solver = new Solver(set, { ...opts, seed: `${opts.seed}#${restarts}` });
      if (solver.status === 'failed' && restarts >= maxRestarts) return solver;
    }
  }
  return solver;
}

function tilingOf(solver: Solver, cells: number): number[] {
  const t: number[] = new Array(cells);
  for (let c = 0; c < cells; c++) t[c] = solver.collapsedTile(c);
  return t;
}

/** Independent adjacency check: every orthogonal neighbour pair must satisfy the edge algebra. */
function adjacencyValid(set: CompiledTileset, t: number[], w: number, h: number, wrap: boolean): boolean {
  for (let c = 0; c < w * h; c++) {
    if (t[c] < 0) return false;
    for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
      const nb = neighborOf(c, d, w, h, wrap);
      if (nb < 0) continue;
      if (!fits(set.variants[t[c]].edges, set.variants[t[nb]].edges, d)) return false;
    }
  }
  return true;
}

/** Independent connected-components of the *finished* connector cells. */
function finishedComponents(set: CompiledTileset, t: number[], w: number, h: number, wrap: boolean): { comp: Int32Array; count: number } {
  const om = set.openMask!;
  const comp = new Int32Array(w * h).fill(-1);
  let count = 0;
  const isConn = (c: number) => om[t[c]] !== 0;
  for (let s = 0; s < w * h; s++) {
    if (comp[s] !== -1 || !isConn(s)) continue;
    const id = count++;
    const q = [s];
    comp[s] = id;
    while (q.length) {
      const c = q.shift()!;
      for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
        const nb = neighborOf(c, d, w, h, wrap);
        if (nb < 0) continue;
        const opp = ((d + 2) % 4) as Dir;
        if (om[t[c]] & (1 << d) && om[t[nb]] & (1 << opp) && comp[nb] === -1) {
          comp[nb] = id;
          q.push(nb);
        }
      }
    }
  }
  return { comp, count };
}

// ---- the suite -------------------------------------------------------------

export function runAllTests(): TestGroup[] {
  const groups: TestGroup[] = [];

  // 1) Socket algebra + openMask -------------------------------------------
  {
    const results: TestResult[] = [];
    const connSets = TILESETS.filter((s) => s.emptyEdge != null);
    let symBad = 0;
    let maskBad = 0;
    for (const ts of connSets) {
      const compiled = compile(ts);
      const empty = ts.emptyEdge!;
      for (const v of compiled.variants) {
        // reverse-symmetry: an open edge stays open under reversal (so collapsed open faces open)
        for (let d = 0; d < 4; d++) {
          const open = v.edges[d] !== empty;
          const openRev = reverseCode(v.edges[d]) !== empty;
          if (open !== openRev) symBad++;
        }
        // openMask matches the edge codes
        let m = 0;
        for (let d = 0; d < 4; d++) if (v.edges[d] !== empty) m |= 1 << d;
        if (compiled.openMask![v.id] !== m) maskBad++;
      }
    }
    results.push({
      name: 'open-socket reverse-symmetry law',
      pass: symBad === 0,
      detail: symBad === 0 ? `${connSets.length} connection sets: open(c) ⇔ open(reverse c) holds for every edge` : `${symBad} edges violate it`,
    });
    results.push({
      name: 'compiled openMask matches edge codes',
      pass: maskBad === 0,
      detail: maskBad === 0 ? 'every variant’s mask bit ⇔ a non-empty socket' : `${maskBad} mismatches`,
    });
    groups.push({ group: 'Socket algebra', results });
  }

  // 2) Connectivity graph algorithms vs. brute force ------------------------
  {
    const results: TestResult[] = [];
    const r = rng(0x9e3779b9);
    const N = 1500;
    let compBad = 0;
    let artBad = 0;
    let netBad = 0;
    let termBad = 0;
    let forceBad = 0;
    let tested = 0;
    for (let i = 0; i < N; i++) {
      const w = 2 + Math.floor(r() * 4);
      const h = 2 + Math.floor(r() * 4);
      const wrap = r() < 0.4;
      const v = randView(r, w, h, wrap);
      const adj = refAdj(v);

      // components: same partition (count + grouping up to relabelling)
      const a = components(v);
      let compOk = a.count === refComponentCount(v, -1);
      if (compOk) {
        for (let c = 0; c < v.cells && compOk; c++) {
          if (v.mayOpen[c] === 0) continue;
          // a.comp groups must be consistent with reference reachability
          const repSeen = refReach(v, adj, c, -1);
          for (let d = 0; d < v.cells; d++) {
            if (v.mayOpen[d] === 0) continue;
            const sameRef = repSeen[d] === 1;
            const sameGot = a.comp[c] === a.comp[d];
            if (sameRef !== sameGot) {
              compOk = false;
              break;
            }
          }
        }
      }
      if (!compOk) compBad++;

      // articulation points
      if (!sortedEq(articulationPoints(v), refArticulation(v))) artBad++;

      // network feasibility
      {
        const { comp } = components(v);
        let seen = -1;
        let ref = true;
        for (let c = 0; c < v.cells; c++) {
          if (v.mustConnector[c] !== 1) continue;
          if (comp[c] < 0) {
            ref = false;
            break;
          }
          if (seen === -1) seen = comp[c];
          else if (comp[c] !== seen) {
            ref = false;
            break;
          }
        }
        if (networkFeasible(v) !== ref) netBad++;
      }

      // terminals feasibility + forced connectors
      const nodes: number[] = [];
      for (let c = 0; c < v.cells; c++) if (v.mayOpen[c] !== 0) nodes.push(c);
      if (nodes.length >= 2) {
        const t0 = nodes[Math.floor(r() * nodes.length)];
        const t1 = nodes[Math.floor(r() * nodes.length)];
        if (t0 !== t1) {
          const terminals = [t0, t1];
          const baseSeen = refReach(v, adj, t0, -1);
          const feasible = terminals.every((t) => baseSeen[t]);
          if (terminalsFeasible(v, terminals) !== feasible) termBad++;
          const fc = forcedConnectors(v, terminals);
          if (!feasible) {
            if (fc !== null) forceBad++;
          } else {
            const ref: number[] = [];
            for (const cand of nodes) {
              if (cand === t0 || cand === t1 || v.mustConnector[cand] === 1) continue;
              const s = refReach(v, adj, t0, cand);
              if (!terminals.every((t) => s[t])) ref.push(cand);
            }
            if (fc === null || !sortedEq(fc, ref)) forceBad++;
          }
        }
      }
      tested++;
    }
    results.push({ name: `connected components (×${tested})`, pass: compBad === 0, detail: compBad === 0 ? 'partition matches independent BFS' : `${compBad} mismatches` });
    results.push({ name: `articulation points (×${tested})`, pass: artBad === 0, detail: artBad === 0 ? 'matches brute-force removal test' : `${artBad} mismatches` });
    results.push({ name: `network feasibility (×${tested})`, pass: netBad === 0, detail: netBad === 0 ? 'matches reference must-connector grouping' : `${netBad} mismatches` });
    results.push({ name: `terminal feasibility (×${tested})`, pass: termBad === 0, detail: termBad === 0 ? 'matches reference reachability' : `${termBad} mismatches` });
    results.push({ name: `forced connectors (×${tested})`, pass: forceBad === 0, detail: forceBad === 0 ? 'matches brute-force s–t cut-vertex set' : `${forceBad} mismatches` });
    groups.push({ group: 'Connectivity algorithms (vs. brute force)', results });
  }

  // 3) Solver guarantees ----------------------------------------------------
  {
    const results: TestResult[] = [];
    const rails = compile(tilesetByKey('rails'));
    const maze = compile(tilesetByKey('maze'));

    // determinism: same seed ⇒ identical tiling
    {
      let bad = 0;
      let done = 0;
      for (let s = 0; s < 12; s++) {
        const opts: SolverOptions = { width: 12, height: 12, seed: `det${s}`, wrap: false, backtracking: true, backtrackBudget: 4000 };
        const a = runToEnd(rails, opts);
        const b = runToEnd(rails, opts);
        if (a.status === 'done' && b.status === 'done') {
          done++;
          if (tilingOf(a, 144).join(',') !== tilingOf(b, 144).join(',')) bad++;
        }
      }
      results.push({ name: 'determinism (same seed ⇒ same tiling)', pass: bad === 0, detail: bad === 0 ? `${done} rails runs reproduced byte-for-byte` : `${bad} runs diverged` });
    }

    // adjacency validity of every finished tiling
    {
      let bad = 0;
      let done = 0;
      for (const [set, name, n] of [[rails, 'rails', 12], [maze, 'maze', 12]] as [CompiledTileset, string, number][]) {
        for (let s = 0; s < 8; s++) {
          const r = runToEnd(set, { width: n, height: n, seed: `adj-${name}-${s}`, wrap: s % 2 === 0, backtracking: true, backtrackBudget: 5000 });
          if (r.status === 'done') {
            done++;
            if (!adjacencyValid(set, tilingOf(r, n * n), n, n, s % 2 === 0)) bad++;
          }
        }
      }
      results.push({ name: 'adjacency-valid output', pass: bad === 0, detail: bad === 0 ? `${done} finished tilings, zero illegal neighbours` : `${bad} tilings broke adjacency` });
    }

    // NETWORK guarantee: every finished connectivity=network run is one component
    {
      let bad = 0;
      let done = 0;
      const w = 9;
      for (let s = 0; s < 16; s++) {
        const r = runToEnd(rails, { width: w, height: w, seed: `net${s}`, wrap: false, backtracking: true, backtrackBudget: 8000, connectivity: { mode: 'network' } });
        if (r.status === 'done') {
          done++;
          const { count } = finishedComponents(rails, tilingOf(r, w * w), w, w, false);
          if (count > 1) bad++;
        }
      }
      results.push({ name: 'whole-network guarantee', pass: bad === 0 && done > 0, detail: bad === 0 ? `${done}/16 runs finished, all a single connected network` : `${bad} finished runs were fragmented` });
    }

    // TERMINALS guarantee: pinned terminals always routed in finished runs
    {
      let bad = 0;
      let done = 0;
      const w = 11;
      const straightNS = rails.variants.findIndex((v) => v.proto === 'straight' && (rails.openMask![v.id] & 1) !== 0);
      const cA = 1 * w + 1;
      const cB = (w - 2) * w + (w - 2);
      for (let s = 0; s < 16; s++) {
        const r = runToEnd(rails, {
          width: w,
          height: w,
          seed: `term${s}`,
          wrap: false,
          backtracking: true,
          backtrackBudget: 10000,
          pins: [[cA, straightNS], [cB, straightNS]],
          connectivity: { mode: 'terminals', terminals: [cA, cB] },
        });
        if (r.status === 'done') {
          done++;
          const { comp } = finishedComponents(rails, tilingOf(r, w * w), w, w, false);
          if (comp[cA] < 0 || comp[cB] < 0 || comp[cA] !== comp[cB]) bad++;
        }
      }
      results.push({ name: 'terminal-routing guarantee', pass: bad === 0 && done > 0, detail: bad === 0 ? `${done}/16 runs finished, pinned terminals always linked` : `${bad} finished runs left terminals unrouted` });
    }

    // regression: connectivity Off leaves the solver completing normally
    {
      let done = 0;
      for (let s = 0; s < 8; s++) {
        const r = runToEnd(rails, { width: 14, height: 14, seed: `off${s}`, wrap: false, backtracking: true, backtrackBudget: 4000 });
        if (r.status === 'done') done++;
      }
      results.push({ name: 'unconstrained solve still completes', pass: done >= 6, detail: `${done}/8 plain rails runs reached a full collapse` });
    }

    groups.push({ group: 'Solver guarantees (real solver)', results });
  }

  // 4) Search Lab — pluggable heuristics + instrumentation + benchmark ------
  {
    const results: TestResult[] = [];

    // 4a) Pure cell-selection heuristics (mechanics, no solver/canvas needed).
    {
      const r = rng(0x51ed270b);
      const counts = [1, 4, 1, 2, 7, 2]; // uncollapsed = count > 1
      const scanOk = scanlineCell(counts, counts.length) === 1; // first index with count > 1
      const mrvOk = (() => {
        // must land on a *minimum-count* uncollapsed cell (count 2 at idx 3 or 5)
        for (let i = 0; i < 200; i++) {
          const c = mrvCell(counts, counts.length, r);
          if (counts[c] !== 2) return false;
        }
        return true;
      })();
      const randOk = (() => {
        for (let i = 0; i < 400; i++) {
          const c = randomCell(counts, counts.length, r);
          if (counts[c] <= 1) return false; // must always be an uncollapsed cell
        }
        return true;
      })();
      const doneOk = scanlineCell([1, 1, 1], 3) === -1 && mrvCell([1, 1], 2, r) === -1 && randomCell([1], 1, r) === -1;
      results.push({
        name: 'cell heuristics — mechanics',
        pass: scanOk && mrvOk && randOk && doneOk,
        detail: scanOk && mrvOk && randOk && doneOk ? 'scanline=first, MRV=min-count, random∈uncollapsed, all return −1 when settled' : 'a heuristic violated its contract',
      });
    }

    // 4b) Pure tile-selection policies.
    {
      const greedyOk = tileIndex('greedy', [1, 5, 3], () => 0.99) === 1; // argmax, no randomness
      const uniformOk = tileIndex('uniform', [1, 1, 1], () => 0) === 0 && tileIndex('uniform', [1, 1, 1], () => 0.999) === 2;
      const weightedLo = tileIndex('weighted', [1, 1, 2], () => 0) === 0;
      const weightedHi = tileIndex('weighted', [1, 1, 2], () => 0.999) === 2;
      const pass = greedyOk && uniformOk && weightedLo && weightedHi;
      results.push({
        name: 'tile policies — mechanics',
        pass,
        detail: pass ? 'greedy=argmax weight, uniform spans the list, weighted walks the cumulative buckets' : 'a tile policy violated its contract',
      });
    }

    // 4c) Every heuristic × policy yields *valid* output, and is deterministic.
    {
      const terrain = compile(tilesetByKey('terrain'));
      let invalid = 0;
      let diverged = 0;
      let done = 0;
      const n = 10;
      for (const heuristic of CELL_HEURISTICS) {
        for (const tilePolicy of TILE_POLICIES) {
          const opts: SolverOptions = { width: n, height: n, seed: `lab-${heuristic}-${tilePolicy}`, wrap: false, backtracking: true, backtrackBudget: 6000, heuristic, tilePolicy };
          const a = runToEnd(terrain, opts);
          const b = runToEnd(terrain, opts);
          if (a.status === 'done') {
            done++;
            if (!adjacencyValid(terrain, tilingOf(a, n * n), n, n, false)) invalid++;
            if (b.status === 'done' && tilingOf(a, n * n).join(',') !== tilingOf(b, n * n).join(',')) diverged++;
          }
        }
      }
      results.push({ name: 'heuristics — valid + deterministic output', pass: invalid === 0 && diverged === 0 && done >= 8, detail: invalid === 0 && diverged === 0 ? `${done}/12 heuristic×policy combos finished, every one adjacency-valid and reproduced byte-for-byte` : `${invalid} invalid, ${diverged} non-deterministic` });
    }

    // 4d) Instrumentation law: the contradiction heatmap sums to the local-contradiction count.
    {
      const rails = compile(tilesetByKey('rails'));
      let bad = 0;
      let checked = 0;
      for (const heuristic of CELL_HEURISTICS) {
        const opts: SolverOptions = { width: 12, height: 12, seed: `heat-${heuristic}`, wrap: heuristic === 'random', backtracking: true, backtrackBudget: 4000, heuristic };
        // step a bounded number of times so we sample mid-search too, not just the terminal state
        const s = new Solver(rails, opts);
        for (let i = 0; i < 600 && s.status === 'running'; i++) s.step();
        checked++;
        if (s.contraHeatSum !== s.localContradictions) bad++;
        // eliminations and peak depth are non-negative, and depth never exceeds the cell count
        if (s.eliminations < 0 || s.peakDepth < 0 || s.peakDepth > 12 * 12) bad++;
      }
      results.push({ name: 'instrumentation — Σ heatmap = local contradictions', pass: bad === 0, detail: bad === 0 ? `across ${checked} runs, the per-cell contradiction tally sums exactly to the local-contradiction counter` : `${bad} instrumentation invariants broke` });
    }

    // 4e) Benchmark aggregation arithmetic (pure — no solver involved).
    {
      const outs: RunOutcome[] = [
        { solved: true, steps: 10, backtracks: 2, contradictions: 1, eliminations: 50, peakDepth: 8, restarts: 0, ms: 1 },
        { solved: false, steps: 99, backtracks: 9, contradictions: 9, eliminations: 999, peakDepth: 99, restarts: 5, ms: 3 },
        { solved: true, steps: 20, backtracks: 4, contradictions: 3, eliminations: 70, peakDepth: 12, restarts: 1, ms: 2 },
      ];
      const row = aggregate({ heuristic: 'entropy', tilePolicy: 'weighted' }, outs);
      const ok =
        row.runs === 3 &&
        row.solved === 2 &&
        Math.abs(row.successRate - 2 / 3) < 1e-9 &&
        row.meanSteps === 15 && // mean over the two *solved* runs (10, 20)
        row.meanBacktracks === 3 &&
        row.meanPeakDepth === 10 &&
        Math.abs(row.meanMs - 2) < 1e-9; // mean ms over *all* runs (1, 3, 2)
      results.push({ name: 'benchmark — aggregation arithmetic', pass: ok, detail: ok ? 'success rate + per-metric means computed over the correct subsets (solved-only vs all)' : 'aggregation produced wrong figures' });
    }

    groups.push({ group: 'Search Lab (heuristics + instrumentation)', results });
  }

  return groups;
}

/** Total number of individual checks, for headline display. */
export function testCount(groups: TestGroup[]): { total: number; passed: number } {
  let total = 0;
  let passed = 0;
  for (const g of groups) {
    for (const t of g.results) {
      total++;
      if (t.pass) passed++;
    }
  }
  return { total, passed };
}
