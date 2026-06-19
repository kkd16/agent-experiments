import type { IRFunc } from './ir';
import { computeDom, succOfTerm } from './cfg';
import type { DomInfo } from './cfg';

// Shared natural-loop analysis over an SSA function. A *natural loop* is induced
// by a back edge `b -> h` (a CFG edge whose target `h` dominates its source `b`):
// its body is `h` plus every block that can reach `b` without going through `h`.
// Two back edges with the same header are merged into one loop (so a loop with
// several `continue`/latch paths is a single loop). The forest also records each
// loop's nesting `depth` and the header of the immediately-enclosing loop.
//
// One definition of "what a loop is" for the whole mid-end: both LICM and the
// loop unroller consume this, so they never disagree about a loop's extent.

export interface NaturalLoop {
  /** The loop header — the single block every iteration re-enters through. */
  header: number;
  /** Loop blocks with a back edge to the header (one per `continue`/latch path). */
  latches: number[];
  /** Every block in the loop, including the header and the latches. */
  body: Set<number>;
  /** Nesting depth: 1 for an outermost loop, 2 for one nested directly inside it, … */
  depth: number;
  /** Header of the immediately-enclosing loop, or null if this loop is outermost. */
  parent: number | null;
}

/** Does `a` dominate `b`? (Walk `b`'s idom chain up to the entry.) */
export function dominates(idom: Map<number, number>, a: number, b: number): boolean {
  let n: number | undefined = b;
  while (n !== undefined) {
    if (n === a) return true;
    const d = idom.get(n);
    if (d === n) break; // reached the entry (idom(entry) === entry)
    n = d;
  }
  return false;
}

/** Discover every natural loop, as a forest keyed by header id. */
export function findNaturalLoops(fn: IRFunc, dom?: DomInfo): NaturalLoop[] {
  const d = dom ?? computeDom(fn);
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const loops = new Map<number, NaturalLoop>(); // header -> loop

  for (const b of fn.blocks) {
    for (const s of succOfTerm(b.term)) {
      // A back edge: the successor `s` dominates this block `b`.
      if (!dominates(d.idom, s, b.id)) continue;
      let loop = loops.get(s);
      if (!loop) loop = { header: s, latches: [], body: new Set([s]), depth: 0, parent: null };
      loops.set(s, loop);
      if (!loop.latches.includes(b.id)) loop.latches.push(b.id);
      // Grow the body backwards from the latch, stopping at the header.
      const stack = [b.id];
      while (stack.length) {
        const n = stack.pop()!;
        if (loop.body.has(n)) continue;
        loop.body.add(n);
        for (const p of byId.get(n)?.preds ?? []) if (!loop.body.has(p)) stack.push(p);
      }
    }
  }

  const all = [...loops.values()];
  // Nesting: loop A is nested in B iff A's header is a (non-header) member of B's
  // body. The immediate parent is the smallest such enclosing loop; depth counts
  // the enclosing chain.
  for (const a of all) {
    let parent: NaturalLoop | null = null;
    for (const b of all) {
      if (b === a) continue;
      if (b.body.has(a.header)) {
        if (parent === null || b.body.size < parent.body.size) parent = b;
      }
    }
    a.parent = parent ? parent.header : null;
  }
  // Depth = 1 + parent depth; resolve by repeated relaxation (forest is tiny).
  const byHeader = new Map(all.map((l) => [l.header, l]));
  const depthOf = (l: NaturalLoop): number => {
    let depth = 1;
    let p = l.parent;
    const seen = new Set<number>();
    while (p !== null && !seen.has(p)) {
      seen.add(p);
      depth++;
      p = byHeader.get(p)?.parent ?? null;
    }
    return depth;
  };
  for (const l of all) l.depth = depthOf(l);
  return all;
}

/** A loop is innermost when no other loop's header lies inside its body. */
export function isInnermost(loop: NaturalLoop, all: NaturalLoop[]): boolean {
  for (const other of all) {
    if (other === loop) continue;
    if (loop.body.has(other.header)) return false;
  }
  return true;
}
