import type { IRFunc } from '../ir/ir';
import { computeDom, succOfTerm } from '../ir/cfg';
import { dominates } from '../ir/loops';

// Correlated-branch folding — decide a branch from a dominating test of the same value.
//
// When a block `B` ends in `condbr c, T, F` and some *other* block `D` already
// branched on the **same SSA value** `c` (`condbr c, DT, DF`) such that one of `D`'s
// arms **dominates** `B`, the outcome at `B` is already settled: if `DT` dominates
// `B` then every path that reaches `B` passed through `D`'s true arm, so `c` is true
// at `B` (and `c` is immutable in SSA — the same id is the same value); we fold `B`
// to `br T`. Symmetrically, if `DF` dominates `B`, `c` is false and `B` folds to
// `br F`. This is the path-sensitive complement to SCCP, which can only fold a branch
// whose condition is constant on *every* path:
//
//     if (valid) {            if (valid) {
//       …                       …
//       if (valid) { X }   ⟶    X            // inner test is known-true here
//     }                       }
//
//     while (c) { if (c) … }  ⟶  while (c) { … }   // c is true throughout the body
//
// GVN/CSE first gives the two textually-identical conditions the *same* value id, so
// correlation sees a shared `c`; this pass runs right after it. It only ever rewrites
// a terminator (never moves a computation), and folds a *runtime* branch SCCP can't.
//
// ## Soundness
//
// We need *reaching `B` to imply the `c`-true edge was taken*. Block domination of
// `B` by `DT` is not enough on its own: if `DT` had another predecessor, control
// could enter `DT` without `c` being true. So we additionally require the taken arm
// to be entered **only** from `D` (`DT.preds == [D]`) — then the edge `D → DT` itself
// dominates `B`, so every path to `B` traversed it with `c` true. Because `c`'s sole
// SSA definition dominates `D` and is therefore never re-evaluated between `D → DT`
// and `B` (re-evaluation would force its def block to lie strictly between `DT` and
// `B` while also dominating `D`, a contradiction), `c` holds that same truth at `B`.
// At most one of `DT`/`DF` can dominate `B` (they are siblings), so there is never a
// conflict. Folding drops the `B → dead-arm` edge; that arm's `pred = B` phi incomings
// are removed, and any block it orphaned is swept by the CFG-cleanup/DCE that follow.
// The triple-differential oracle (interpreter ≡ wasm ≡ from-scratch VM, every opt
// level) proves the rewrite changes nothing observable.

function recomputePreds(fn: IRFunc): void {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  for (const b of fn.blocks) b.preds = [];
  for (const b of fn.blocks) for (const s of succOfTerm(b.term)) byId.get(s)?.preds.push(b.id);
}

export function correlatedFold(fn: IRFunc): number {
  let changed = 0;
  let again = true;
  let guard = 0;
  while (again && guard++ < 5000) {
    again = false;
    recomputePreds(fn);
    const dom = computeDom(fn);
    const byId = new Map(fn.blocks.map((b) => [b.id, b]));

    for (const B of fn.blocks) {
      if (B.term.op !== 'condbr') continue;
      const c = B.term.cond;
      if (c.tag !== 'val') continue; // a constant condition is SCCP's job
      const T = B.term.t;
      const F = B.term.f;
      if (T === F) continue;

      let decided: number | null = null;
      for (const D of fn.blocks) {
        if (D.id === B.id || D.term.op !== 'condbr') continue;
        if (D.term.cond.tag !== 'val' || D.term.cond.id !== c.id) continue;
        const DT = D.term.t;
        const DF = D.term.f;
        if (DT === DF) continue;
        // The taken arm must be entered *only* from D, so the edge D→arm (not merely
        // the arm block) dominates B — otherwise reaching the arm need not imply c.
        const dtb = byId.get(DT);
        const dfb = byId.get(DF);
        const dtSole = !!dtb && dtb.preds.length === 1 && dtb.preds[0] === D.id;
        const dfSole = !!dfb && dfb.preds.length === 1 && dfb.preds[0] === D.id;
        // `DT == B` is allowed: with the sole-predecessor guard, B is entered only via
        // D's c-true edge, so B's own test on c folds to true (and `dominates` is
        // reflexive). The guard, not block inequality, is what makes this sound.
        if (dtSole && dominates(dom.idom, DT, B.id)) { decided = T; break; }
        if (dfSole && dominates(dom.idom, DF, B.id)) { decided = F; break; }
      }
      if (decided === null) continue;

      const dead = decided === T ? F : T;
      B.term = { op: 'br', target: decided };
      if (dead !== decided) {
        const db = byId.get(dead);
        if (db) for (const phi of db.phis) phi.incomings = phi.incomings.filter((i) => i.pred !== B.id);
      }
      changed++;
      again = true;
      break; // CFG mutated — recompute dominators and rescan
    }
  }
  if (changed) recomputePreds(fn);
  return changed;
}
