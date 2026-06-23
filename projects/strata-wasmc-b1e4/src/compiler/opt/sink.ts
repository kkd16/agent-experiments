import type { IRFunc, Inst } from '../ir/ir';
import { isPureValue } from '../ir/ir';
import { computeDom, succOfTerm } from '../ir/cfg';
import { findNaturalLoops, dominates } from '../ir/loops';

// Code sinking — partial dead-code elimination.
//
// A pure value computed in a block that ends in a two-way branch, but *used only
// on one arm*, is computed on every path even though one path throws the result
// away. Sinking moves the computation down into the arm that needs it:
//
//     B: t = a*a + b*b          B: condbr(cond, S, E)
//        condbr(cond, S, E)  ⟶  S: t = a*a + b*b   ← only computed when cond
//     S: … uses t …             S: … uses t …
//     E: … no use of t …        E: … (t never computed)
//
// When the other arm (`E`) is taken, `t` is never evaluated — a strict win (and
// it shortens the live range of `t`, easing the stackifier). It is the dual of
// LICM: LICM hoists invariants *out* of a loop; sinking pushes conditionally-used
// values *into* the branch that uses them.
//
// Soundness is by precondition. The target arm `S` must be entered *only* from
// `B` (`S.preds == [B]`), so `t`'s operands — available at `B`, which dominates
// `S` — are still available after the move, and `t` runs on exactly the paths it
// did before minus the ones that discarded it. `t` must be pure (no side effect,
// never traps — div/rem excluded), every use must be dominated by `S` (so the
// moved definition still dominates them), and `t` must not feed a φ (whose use is
// on a *predecessor* edge, not the φ's block). To never pessimize, the pass
// declines to sink into a deeper loop nest than `B` sits in. When any precondition
// is unmet it leaves the IR untouched, so the differential oracle proves it only
// ever moves work, never changes a result.

const TRAPPY = new Set(['div_s', 'rem_s']);

function isSinkable(i: Inst): boolean {
  if (i.res === null || !isPureValue(i)) return false;
  // A pure value that could trap must not be speculated onto a path; but sinking
  // only ever *removes* a path, never adds one, so even div/rem are safe to sink.
  // We keep them out only of the conservative set for clarity — they are rare and
  // the win is marginal. (Everything in isPureValue is non-trapping anyway except
  // an integer div/rem, which is an `ibin`.)
  if (i.kind === 'ibin' && TRAPPY.has(i.sub)) return false;
  return true;
}

export function sinkCode(fn: IRFunc): number {
  let changed = 0;
  let again = true;
  let guard = 0;
  while (again && guard++ < 2000) {
    again = false;
    recomputePreds(fn);
    const dom = computeDom(fn);
    const loops = findNaturalLoops(fn, dom);
    const depth = new Map<number, number>();
    for (const b of fn.blocks) depth.set(b.id, 0);
    for (const l of loops) for (const bid of l.body) depth.set(bid, Math.max(depth.get(bid) ?? 0, l.depth));
    const byId = new Map(fn.blocks.map((b) => [b.id, b]));

    // Non-φ use sites per value (a φ use lives on a predecessor edge, so values
    // that feed a φ are excluded from sinking entirely).
    const useBlocks = new Map<number, Set<number>>();
    const phiUsed = new Set<number>();
    const addUse = (id: number, bid: number): void => {
      let s = useBlocks.get(id);
      if (!s) {
        s = new Set();
        useBlocks.set(id, s);
      }
      s.add(bid);
    };
    for (const b of fn.blocks) {
      for (const p of b.phis) for (const inc of p.incomings) if (inc.val.tag === 'val') phiUsed.add(inc.val.id);
      for (const inst of b.insts) for (const a of inst.args) if (a.tag === 'val') addUse(a.id, b.id);
      if (b.term.op === 'condbr' && b.term.cond.tag === 'val') addUse(b.term.cond.id, b.id);
      else if (b.term.op === 'ret' && b.term.value && b.term.value.tag === 'val') addUse(b.term.value.id, b.id);
    }

    for (const B of fn.blocks) {
      if (B.term.op !== 'condbr' || B.term.t === B.term.f) continue;
      const succs = [B.term.t, B.term.f];
      // Bottom-up so that if one sunk value feeds another, the producer (earlier in
      // B) is sunk after the consumer and lands ahead of it at S's front.
      let sankHere = false;
      for (let idx = B.insts.length - 1; idx >= 0; idx--) {
        const i = B.insts[idx];
        if (!isSinkable(i)) continue;
        const r = i.res!;
        if (phiUsed.has(r)) continue;
        const ub = useBlocks.get(r);
        if (!ub || ub.size === 0) continue; // dead — leave it for DCE
        if (ub.has(B.id)) continue; // used within B (incl. the branch cond) — must stay

        let chosen: number | null = null;
        for (const S of succs) {
          const Sb = byId.get(S);
          if (!Sb || S === B.id) continue;
          if (Sb.preds.length !== 1 || Sb.preds[0] !== B.id) continue; // S entered only from B
          if ((depth.get(S) ?? 0) > (depth.get(B.id) ?? 0)) continue; // never sink deeper into a loop
          let allDom = true;
          for (const u of ub) {
            if (!dominates(dom.idom, S, u)) {
              allDom = false;
              break;
            }
          }
          if (allDom) {
            chosen = S;
            break;
          }
        }
        if (chosen === null) continue;

        B.insts.splice(idx, 1);
        byId.get(chosen)!.insts.unshift(i);
        changed++;
        sankHere = true;
      }
      if (sankHere) {
        again = true; // use map is now stale — rebuild and rescan
        break;
      }
    }
  }
  return changed;
}

function recomputePreds(fn: IRFunc): void {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  for (const b of fn.blocks) b.preds = [];
  for (const b of fn.blocks) for (const s of succOfTerm(b.term)) byId.get(s)?.preds.push(b.id);
}
