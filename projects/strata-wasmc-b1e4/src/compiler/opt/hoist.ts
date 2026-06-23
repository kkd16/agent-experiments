import type { IRFunc, Inst, Operand } from '../ir/ir';
import { eachOperand, isPureValue } from '../ir/ir';
import { succOfTerm } from '../ir/cfg';

// Code hoisting — very-busy / partially-redundant expressions.
//
// The dual of sinking: when *both* arms of a two-way branch begin by computing
// the same pure value, hoist one copy *above* the branch so it runs once on the
// way in, instead of once on each path:
//
//     B: condbr(cond, T, F)          B: x = a*a + b*b
//     T: x = a*a + b*b   ⟶              condbr(cond, T, F)
//        … uses x …                  T: … uses x …
//     F: y = a*a + b*b               F: … uses x …  (y folded into x)
//        … uses y …
//
// GVN/CSE cannot do this: neither arm dominates the other, so the two copies are
// *partial* redundancies, not dominating ones. (If both arms were pure and small,
// if-conversion would flatten the diamond and GVN would then dedupe — so hoisting
// earns its keep exactly when the arms are *not* if-converted: a side effect, or
// too much code. It pairs with LICM and sinking — LICM lifts invariants out of a
// loop, sinking pushes a one-arm value down, hoisting pulls a both-arms value up.)
//
// Soundness is by precondition. Each arm must be entered *only* from `B`
// (`preds == [B]`), so a value computed in `B` (which dominates both arms) is
// available wherever the originals were, and the move is on a path both arms
// already took. Only **pure** instructions whose operands are all available at
// `B` (defined neither in `T` nor `F`) are eligible, so the hoisted copy needs
// nothing the branch block can't see, and hoisting into `B` never adds a path
// (it sits on the dominator of both arms) — it only ever removes a duplicate.
// When a precondition is unmet it declines, so the differential oracle proves it
// never changes a result.

const opKey = (o: Operand): string => (o.tag === 'const' ? `c${o.ty}:${o.num}` : `v${o.id}`);
const sig = (i: Inst): string => `${i.kind}|${i.sub}|${i.ty}|${i.args.map(opKey).join(',')}`;

export function hoistCode(fn: IRFunc): number {
  let changed = 0;
  let again = true;
  let guard = 0;
  while (again && guard++ < 2000) {
    again = false;
    recomputePreds(fn);
    const byId = new Map(fn.blocks.map((b) => [b.id, b]));

    for (const B of fn.blocks) {
      if (B.term.op !== 'condbr' || B.term.t === B.term.f) continue;
      const Tb = byId.get(B.term.t);
      const Fb = byId.get(B.term.f);
      if (!Tb || !Fb || Tb === B || Fb === B || Tb === Fb) continue;
      if (Tb.preds.length !== 1 || Tb.preds[0] !== B.id) continue;
      if (Fb.preds.length !== 1 || Fb.preds[0] !== B.id) continue;

      // Values defined inside either arm are not available at B.
      const inT = blockDefs(Tb);
      const inF = blockDefs(Fb);
      const availAtB = (o: Operand): boolean => o.tag === 'const' || (!inT.has(o.id) && !inF.has(o.id));

      const eligible = (i: Inst): boolean => i.res !== null && isPureValue(i) && i.args.every(availAtB);

      // Index F's eligible instructions by signature (first wins per signature).
      const fBySig = new Map<string, Inst>();
      for (const iF of Fb.insts) if (eligible(iF) && !fBySig.has(sig(iF))) fBySig.set(sig(iF), iF);
      if (fBySig.size === 0) continue;

      let hoistedHere = false;
      for (const iT of [...Tb.insts]) {
        if (!eligible(iT)) continue;
        const iF = fBySig.get(sig(iT));
        if (!iF) continue;
        fBySig.delete(sig(iT)); // consume the F match

        // Move T's copy up into B (just before the terminator), keeping its id;
        // rewrite every use of F's copy to it and drop F's copy. Hoisted insts
        // never depend on one another (their operands predate B), so append order
        // among them is irrelevant.
        Tb.insts = Tb.insts.filter((x) => x !== iT);
        Fb.insts = Fb.insts.filter((x) => x !== iF);
        B.insts.push(iT);
        replaceAllUses(fn, iF.res!, iT.res!);
        changed++;
        hoistedHere = true;
      }
      if (hoistedHere) {
        again = true; // CFG defs shifted — rebuild and rescan
        break;
      }
    }
  }
  return changed;
}

function blockDefs(b: { phis: { res: number }[]; insts: Inst[] }): Set<number> {
  const s = new Set<number>();
  for (const p of b.phis) s.add(p.res);
  for (const i of b.insts) if (i.res !== null) s.add(i.res);
  return s;
}

function replaceAllUses(fn: IRFunc, fromId: number, toId: number): void {
  for (const b of fn.blocks)
    eachOperand(b, (o, set) => {
      if (o.tag === 'val' && o.id === fromId) set({ tag: 'val', id: toId });
    });
}

function recomputePreds(fn: IRFunc): void {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  for (const b of fn.blocks) b.preds = [];
  for (const b of fn.blocks) for (const s of succOfTerm(b.term)) byId.get(s)?.preds.push(b.id);
}
