import type { IRFunc, Inst, Operand } from '../ir/ir';
import { eachOperand } from '../ir/ir';
import { findNaturalLoops } from '../ir/loops';
import { getPreheader, maxValueId } from './optimize';

// =====================================================================
// Loop-invariant load hoisting (Load-LICM)
// =====================================================================
//
// The scalar LICM in `optimize.ts` hoists loop-invariant *pure value* ops
// (arithmetic, compares, casts) out of a loop, and mem-opt's forward
// available-memory dataflow forwards a load from a dominating store. Neither can
// hoist a **loop-invariant load** — a `load [A]` whose address is invariant and
// whose location no iteration writes — because the value comes from memory, not an
// SSA computation, and the forward analysis's meet over the back edge drops the
// fact (the preheader has no prior load to make it available at the header). So a
// loop that reads the same field or element every iteration re-reads memory every
// iteration. This pass closes that gap: read it once in the preheader, reuse it.
//
//     preheader:                          preheader:
//        (nothing)                            t = load [p.field]   ← once
//     loop:  …                       ⟶     loop:  …
//        x = load [p.field]  ← each iter        … use t …
//        … use x …
//
// --- Soundness -----------------------------------------------------------------
// A load may be replaced by a single preheader load iff, across the whole loop
// body, (1) its address operand is loop-invariant (its SSA definition lies outside
// the loop, so the address is the same every iteration), and (2) no instruction in
// the body writes a location that may-alias it. The alias model is memopt's: two
// addresses may-alias unless they share a base SSA value with disjoint
// `[off,off+width)` ranges, or root at two distinct `alloc`s. To stay sound we
// bail on the whole loop if it contains any opaque writer — a `call`/`call_indirect`
// (may write anywhere) or a `vstore`/`vload` (16 bytes the scalar model can't
// place) — and otherwise hoist only loads disjoint from every scalar `store` in the
// body. A `print`/`gget`/`gset` never writes linear memory, so it does not block a
// hoist. We hoist only loads whose result is used *solely inside the loop*, so a
// zero-trip execution (where the preheader load now runs but the original never
// did) changes nothing observable — the extra read is in-bounds for the
// non-trapping programs the differential oracle pins, and its value is unused. When
// any precondition is unmet the load is left in place, so the three-engine oracle
// (interp = wasm = VM, every -O level) proves the pass never changes output.

type AccWidth = 1 | 4 | 8;
function widthOf(sub: string): AccWidth {
  return sub === 'i8' ? 1 : sub === 'i64' || sub === 'f64' ? 8 : 4;
}
interface Loc {
  root: string;
  off: number;
  width: AccWidth;
}
const locKey = (l: Loc): string => `${l.root}#${l.off}#${l.width}`;
function rangesOverlap(aOff: number, aW: number, bOff: number, bW: number): boolean {
  return aOff < bOff + bW && bOff < aOff + aW;
}

export function hoistInvariantLoads(fn: IRFunc): number {
  const naturalLoops = findNaturalLoops(fn);
  if (naturalLoops.length === 0) return 0;
  let anyLoad = false;
  for (const b of fn.blocks) {
    for (const i of b.insts)
      if (i.kind === 'load') {
        anyLoad = true;
        break;
      }
    if (anyLoad) break;
  }
  if (!anyLoad) return 0;

  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const idCtr = { n: maxValueId(fn) + 1 };
  for (const b of fn.blocks) if (b.id >= idCtr.n) idCtr.n = b.id + 1;

  const defOf = new Map<number, Inst>();
  for (const b of fn.blocks) for (const inst of b.insts) if (inst.res !== null) defOf.set(inst.res, inst);

  // Peel `copy` / `add(x, const)` chains to `base + off` (memopt's resolver).
  const resolveAddr = (op: Operand): { root: string; off: number } => {
    let off = 0;
    let cur: Operand = op;
    for (let guard = 0; guard < 64; guard++) {
      if (cur.tag === 'const') return { root: 'c', off: off + (cur.num as number) };
      const inst = defOf.get(cur.id);
      if (!inst) return { root: `v${cur.id}`, off };
      if (inst.kind === 'copy') {
        cur = inst.args[0];
        continue;
      }
      if (inst.kind === 'ibin' && inst.sub === 'add') {
        const [a, b] = inst.args;
        if (b.tag === 'const' && b.ty === 'i32') {
          off += b.num as number;
          cur = a;
          continue;
        }
        if (a.tag === 'const' && a.ty === 'i32') {
          off += a.num as number;
          cur = b;
          continue;
        }
      }
      return { root: `v${cur.id}`, off };
    }
    return { root: cur.tag === 'val' ? `v${cur.id}` : 'c', off };
  };

  const allocIds = new Set<number>();
  for (const b of fn.blocks) for (const i of b.insts) if (i.kind === 'alloc' && i.res !== null) allocIds.add(i.res);
  const freshDistinct = (ra: string, rb: string): boolean =>
    ra !== rb && ra[0] === 'v' && rb[0] === 'v' && allocIds.has(+ra.slice(1)) && allocIds.has(+rb.slice(1));
  const mayAlias = (a: Loc, b: Loc): boolean => {
    if (a.root === b.root) return rangesOverlap(a.off, a.width, b.off, b.width);
    if (freshDistinct(a.root, b.root)) return false;
    return true;
  };

  // Count every use of a value id, so we can require a hoisted load's result be
  // used only inside its loop.
  const usesOutside = (resId: number, body: Set<number>): boolean => {
    for (const b of fn.blocks) {
      const inLoop = body.has(b.id);
      let out = false;
      eachOperand(b, (o) => {
        if (o.tag === 'val' && o.id === resId && !inLoop) out = true;
      });
      if (out) return true;
    }
    return false;
  };

  let changed = 0;
  for (const loop of naturalLoops) {
    const header = byId.get(loop.header);
    if (!header) continue;
    const body = loop.body;

    // Loop-defined values are variant; everything else is invariant.
    const loopDefs = new Set<number>();
    for (const id of body) {
      const b = byId.get(id);
      if (!b) continue;
      for (const p of b.phis) loopDefs.add(p.res);
      for (const i of b.insts) if (i.res !== null) loopDefs.add(i.res);
    }
    const invariant = (o: Operand): boolean => o.tag === 'const' || !loopDefs.has(o.id);

    // Survey the loop's memory effects. An opaque writer forbids hoisting any load;
    // otherwise collect the scalar store locations to test disjointness against.
    let opaque = false;
    const storeLocs: Loc[] = [];
    for (const id of body) {
      const b = byId.get(id);
      if (!b) continue;
      for (const inst of b.insts) {
        if (inst.kind === 'store') {
          const a = resolveAddr(inst.args[0]);
          storeLocs.push({ root: a.root, off: a.off, width: widthOf(inst.sub) });
        } else if (inst.kind === 'call' || inst.kind === 'callind' || inst.kind === 'vstore' || inst.kind === 'vload') {
          opaque = true;
        }
      }
      if (opaque) break;
    }
    if (opaque) continue;

    // Find invariant, non-aliased loads; dedupe identical ones to the first.
    const hoistedByKey = new Map<string, Operand>();
    const toHoist: Inst[] = [];
    const toDelete = new Set<Inst>();
    const replace = new Map<number, Operand>(); // load result id -> value to substitute
    for (const id of body) {
      const b = byId.get(id);
      if (!b) continue;
      for (const inst of b.insts) {
        if (inst.kind !== 'load' || inst.res === null) continue;
        if (!invariant(inst.args[0])) continue;
        const a = resolveAddr(inst.args[0]);
        const rl: Loc = { root: a.root, off: a.off, width: widthOf(inst.sub) };
        if (storeLocs.some((sl) => mayAlias(sl, rl))) continue;
        if (usesOutside(inst.res, body)) continue;
        const key = locKey(rl) + '#' + inst.sub; // same access type required to reuse
        const prev = hoistedByKey.get(key);
        if (prev) {
          replace.set(inst.res, prev);
          toDelete.add(inst);
        } else {
          hoistedByKey.set(key, { tag: 'val', id: inst.res });
          toHoist.push(inst);
        }
      }
    }
    if (toHoist.length === 0) continue;

    const ph = getPreheader(fn, header, body, idCtr);
    if (!ph) continue;

    // Move the first load of each location to the preheader; delete the duplicates.
    const hoistSet = new Set(toHoist);
    for (const id of body) {
      const b = byId.get(id);
      if (!b) continue;
      b.insts = b.insts.filter((i) => !hoistSet.has(i) && !toDelete.has(i));
    }
    for (const inst of toHoist) ph.insts.push(inst);
    // Substitute the deleted duplicates' results with the surviving hoisted load.
    if (replace.size > 0) {
      for (const b of fn.blocks)
        eachOperand(b, (o, set) => {
          if (o.tag === 'val') {
            const r = replace.get(o.id);
            if (r) set(r.tag === 'const' ? { tag: 'const', ty: r.ty, num: r.num } : { tag: 'val', id: r.id });
          }
        });
    }
    changed += toHoist.length + toDelete.size;
  }
  return changed;
}
