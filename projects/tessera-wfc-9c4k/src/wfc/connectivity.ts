// Global connectivity analysis for Wave Function Collapse.
//
// Local WFC adjacency never sees the *global* shape of a solution: a rail set will happily
// strand a closed loop of track with no way off the board. This module adds a genuine global
// constraint — "the connector cells form one connected network" or "these terminal cells are
// mutually reachable" — on top of the existing solver, the hard/research-grade extension of WFC
// (Karth & Smith 2017; Boris-the-Brave's path constraints).
//
// Everything here is pure and DOM-free: it works on a *connectivity view* of the wave (which
// edges could still open, which cells must be connectors) so it is exhaustively unit-testable
// and shares no code with the rendering path. The solver supplies the view; this module answers
// three questions:
//
//   • FEASIBILITY  — could the partially-collapsed wave still satisfy connectivity? The check is
//     run over the most-permissive ("optimistic") graph in which every still-possible link is
//     present, so a NO is genuine: no completion's actual links (a subset) could reconnect what
//     the optimistic graph already leaves split. That makes it a sound contradiction the solver
//     can backtrack on, and it never rejects a state that some completion could finish.
//
//   • FORCING — for terminal routing, a cell that lies on *every* optimistic route between two
//     terminals must be a connector in every completion (the completion's route is a subset of
//     the optimistic one, so it passes through the same cut cell). Those cells are found exactly
//     via articulation points + a removal test, and the solver bans the blank tiles there — a
//     sound deduction that also steers the search toward a connected answer.
//
//   • FINAL — once every cell is collapsed the optimistic graph equals the real one, so the very
//     same feasibility routine, run on the finished assignment, is an exact verdict. The solver
//     calls it before declaring success, so it can never report a solved grid that violates the
//     property; it backtracks instead.

import { DELTA, opposite, type Dir } from './edges';

export type ConnMode = 'network' | 'terminals';

/** A snapshot of the wave reduced to just what connectivity reasoning needs. */
export type ConnView = {
  width: number;
  height: number;
  wrap: boolean;
  cells: number;
  /** Per cell: 4-bit mask of directions some still-possible tile keeps open (bit d = 1<<d). */
  mayOpen: Uint8Array;
  /** Per cell: 1 if *every* still-possible tile is a connector (the cell cannot end up blank). */
  mustConnector: Uint8Array;
};

/** Neighbour cell index in direction `d`, or -1 off a bounded grid. */
export function neighborOf(cell: number, d: Dir, width: number, height: number, wrap: boolean): number {
  const x = cell % width;
  const y = (cell / width) | 0;
  const [dx, dy] = DELTA[d];
  let nx = x + dx;
  let ny = y + dy;
  if (wrap) {
    nx = (nx + width) % width;
    ny = (ny + height) % height;
  } else if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
    return -1;
  }
  return ny * width + nx;
}

/** A cell can still be part of the network iff some possible tile opens an edge. */
function isNode(view: ConnView, cell: number): boolean {
  return view.mayOpen[cell] !== 0;
}

/**
 * Is there still a *possible* link across the edge from `cell` to its neighbour in dir `d`?
 * A link needs `cell` to keep edge `d` open AND the neighbour to keep the facing edge open.
 * Symmetric by construction, so the optimistic graph is undirected.
 */
function possibleLink(view: ConnView, cell: number, d: Dir): number {
  if ((view.mayOpen[cell] & (1 << d)) === 0) return -1;
  const nb = neighborOf(cell, d, view.width, view.height, view.wrap);
  if (nb < 0) return -1;
  if ((view.mayOpen[nb] & (1 << opposite(d))) === 0) return -1;
  return nb;
}

/** The optimistic neighbours of a node cell (cells reachable across a still-possible link). */
function nodeNeighbors(view: ConnView, cell: number): number[] {
  const out: number[] = [];
  for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
    const nb = possibleLink(view, cell, d);
    if (nb >= 0) out.push(nb);
  }
  return out;
}

/**
 * Connected-component labels over the optimistic graph. comp[cell] = component id for node cells,
 * or -1 for cells that can never be connectors. `count` is the number of distinct components.
 */
export function components(view: ConnView): { comp: Int32Array; count: number } {
  const { cells } = view;
  const comp = new Int32Array(cells).fill(-1);
  const queue = new Int32Array(cells);
  let count = 0;
  for (let s = 0; s < cells; s++) {
    if (comp[s] !== -1 || !isNode(view, s)) continue;
    const id = count++;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    comp[s] = id;
    while (head < tail) {
      const c = queue[head++];
      for (const nb of nodeNeighbors(view, c)) {
        if (comp[nb] === -1) {
          comp[nb] = id;
          queue[tail++] = nb;
        }
      }
    }
  }
  return { comp, count };
}

/**
 * Whole-network feasibility: every cell that *must* be a connector has to live in a single
 * optimistic component (optional connectors are free to fall either way; the final check pins
 * the exact property down). Sound — never NOs a still-completable state.
 */
export function networkFeasible(view: ConnView): boolean {
  const { comp } = components(view);
  let seen = -1;
  for (let c = 0; c < view.cells; c++) {
    if (view.mustConnector[c] !== 1) continue;
    const id = comp[c];
    if (id < 0) return false; // must be a connector but can't be one — impossible
    if (seen === -1) seen = id;
    else if (id !== seen) return false; // two required connectors already split
  }
  return true;
}

/** BFS reachability set from `sources` over the optimistic graph, optionally excluding one cell. */
function reachable(view: ConnView, sources: readonly number[], exclude = -1): Uint8Array {
  const { cells } = view;
  const seen = new Uint8Array(cells);
  const queue = new Int32Array(cells);
  let head = 0;
  let tail = 0;
  for (const s of sources) {
    if (s === exclude || !isNode(view, s) || seen[s]) continue;
    seen[s] = 1;
    queue[tail++] = s;
  }
  while (head < tail) {
    const c = queue[head++];
    for (const nb of nodeNeighbors(view, c)) {
      if (nb === exclude || seen[nb]) continue;
      seen[nb] = 1;
      queue[tail++] = nb;
    }
  }
  return seen;
}

/** Are all `terminals` valid connector cells and mutually reachable in the optimistic graph? */
export function terminalsFeasible(view: ConnView, terminals: readonly number[]): boolean {
  if (terminals.length === 0) return true;
  for (const t of terminals) if (!isNode(view, t)) return false;
  const seen = reachable(view, [terminals[0]]);
  for (const t of terminals) if (!seen[t]) return false;
  return true;
}

/**
 * Articulation points of the optimistic graph — cells whose removal increases the number of
 * components. Iterative Tarjan (no recursion, so it is safe on large grids). Only node cells are
 * considered; non-connector cells are skipped.
 */
export function articulationPoints(view: ConnView): number[] {
  const { cells } = view;
  const disc = new Int32Array(cells).fill(-1);
  const low = new Int32Array(cells);
  const isArt = new Uint8Array(cells);
  let timer = 0;

  // explicit DFS stack of frames; each frame walks a cell's neighbour list by index
  const stackCell = new Int32Array(cells);
  const stackParent = new Int32Array(cells);
  const stackIter: number[][] = new Array(cells);
  const stackPos = new Int32Array(cells);

  for (let root = 0; root < cells; root++) {
    if (disc[root] !== -1 || !isNode(view, root)) continue;
    let sp = 0;
    stackCell[sp] = root;
    stackParent[sp] = -1;
    stackIter[sp] = nodeNeighbors(view, root);
    stackPos[sp] = 0;
    disc[root] = low[root] = timer++;
    let rootChildren = 0;

    while (sp >= 0) {
      const c = stackCell[sp];
      const neigh = stackIter[sp];
      if (stackPos[sp] < neigh.length) {
        const nb = neigh[stackPos[sp]++];
        if (nb === stackParent[sp]) continue;
        if (disc[nb] === -1) {
          if (sp === 0) rootChildren++;
          sp++;
          stackCell[sp] = nb;
          stackParent[sp] = c;
          stackIter[sp] = nodeNeighbors(view, nb);
          stackPos[sp] = 0;
          disc[nb] = low[nb] = timer++;
        } else {
          if (disc[nb] < low[c]) low[c] = disc[nb];
        }
      } else {
        // done with c; fold its low into its parent and test the articulation condition
        sp--;
        if (sp >= 0) {
          const p = stackCell[sp];
          if (low[c] < low[p]) low[p] = low[c];
          if (stackParent[sp] !== -1 && low[c] >= disc[p]) isArt[p] = 1;
        }
      }
    }
    if (rootChildren > 1) isArt[root] = 1;
  }

  const out: number[] = [];
  for (let c = 0; c < cells; c++) if (isArt[c]) out.push(c);
  return out;
}

/**
 * Cells that MUST be connectors for terminal routing to remain possible: a cell whose removal
 * from the optimistic graph would leave some pair of terminals unreachable lies on every route
 * between them, so every completion routes a connector through it. Returns the forced cells
 * (excluding the terminals themselves), or `null` if the terminals are already unroutable.
 *
 * Sound: a forced cell is a connector in *every* completion (the completion's terminal route is
 * a subgraph of the optimistic one and must cross the same cut). Found exactly via articulation
 * points (the only removal candidates) plus a per-candidate reachability test.
 */
export function forcedConnectors(view: ConnView, terminals: readonly number[]): number[] | null {
  if (terminals.length < 2) return [];
  if (!terminalsFeasible(view, terminals)) return null;
  const termSet = new Set(terminals);
  const forced: number[] = [];
  for (const v of articulationPoints(view)) {
    if (termSet.has(v)) continue;
    if (view.mustConnector[v] === 1) continue; // already forced
    const seen = reachable(view, [terminals[0]], v);
    let split = false;
    for (const t of terminals) {
      if (!seen[t]) {
        split = true;
        break;
      }
    }
    if (split) forced.push(v);
  }
  return forced;
}
