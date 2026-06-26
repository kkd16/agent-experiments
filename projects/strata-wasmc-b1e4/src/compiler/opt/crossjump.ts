import type { Block, IRFunc, Inst, Operand } from '../ir/ir';
import { eachOperand, isPureValue } from '../ir/ir';
import { succOfTerm } from '../ir/cfg';

// Cross-jumping / tail merging — the bottom dual of code hoisting.
//
// Hoisting pulls a value computed at the *start* of both arms of a branch up
// above it. Cross-jumping does the mirror image at the *bottom*: when every
// predecessor of a merge block `M` ends in the **same instruction tail** before
// jumping to `M`, that tail runs once per `M`-entry no matter which predecessor
// is taken — so one copy at the *front* of `M` computes exactly the same thing.
// We delete the per-predecessor copies and keep a single shared copy in `M`:
//
//     T: … ; s = a + b ; print(s) ; br M        T: …            ; br M
//     F: … ; s = a + b ; print(s) ; br M    ⟶   F: …            ; br M
//     M: x = φ(T:s_T, F:s_F) ; …                M: s = a + b ; print(s) ; … (x ≡ s)
//
// It complements jump threading (which *splits* paths) by *merging* them: a pure
// code-size win, and it merges side-effecting tails (`print`/`store`/`gset`) that
// hoisting — which is pure-only — can never touch, because a tail shared by every
// path already runs exactly once and in the same relative order after the move.
//
// ## Why it is sound (the move preserves every execution)
//
// Take a merge `M` whose predecessors `P₁…Pₖ` (k ≥ 2, all distinct) each end in an
// **unconditional** `br M`, and let `t` be a maximal common suffix of their
// instruction lists. Because each `Pᵢ`'s sole successor is `M`, the program
// traverses some edge `Pᵢ → M` *exactly* on the executions that enter `M`; on each
// such traversal it ran `t` (the suffix) just before the jump. So across a whole
// run, `t` executes once per `M`-entry, in program order right before `M`'s body —
// which is *precisely* what a single copy at the front of `M` does. The count, the
// values, and the ordering relative to `M`'s own work are all preserved (loops
// included: `M` is entered once per `Pᵢ → M` traversal either way).
//
// Three preconditions make the suffix movable and keep SSA well-formed:
//
//  1. **Identical operands.** Two tail instructions match only when their operands
//     are equal: the same constant, the same SSA id defined *above* every `Pᵢ`
//     (hence dominating `M`, so it is available at `M`'s front), or a matched
//     earlier-suffix result (tracked by a correspondence map). An operand defined
//     *inside* a predecessor is rejected — it would differ per path. This makes the
//     moved copy reference only values live at `M`.
//
//  2. **Mergeable opcodes only.** Pure values (functions of their operands, so a
//     single evaluation is identical — even a trapping `div_s`, which trapped
//     identically on every path anyway) plus the effecting ops whose behaviour is a
//     pure function of their operands: `print`/`store`/`vstore`/`gset`. Ops that
//     *read* mutable state — `load`/`gget`/`call`/`callind` — are excluded (their
//     result could differ between paths), and `alloc` is excluded (each must stay a
//     distinct address).
//
//  3. **The merge φ collapses.** A φ in `M` that selected the per-predecessor tail
//     results (`φ(T:s_T, F:s_F)`) becomes uniform once those map to the single kept
//     result and is replaced by it. If any φ that touches a moved/deleted result
//     fails to collapse — or a deleted result is used anywhere but `M`'s φs — the
//     pass declines this merge untouched. The triple-differential oracle (reference
//     interpreter ≡ V8 wasm ≡ from-scratch VM, at every opt level) proves the rest.

/** Opcodes whose effect+value depend only on operands, so one shared copy is exact. */
function mergeable(i: Inst): boolean {
  if (isPureValue(i)) return true; // pure values: identical operands ⇒ identical result
  // Effecting ops that only *write* (a pure function of their operands), never read
  // mutable state. `print`/`store`/`vstore`/`gset` run once per M-entry either way.
  return i.kind === 'print' || i.kind === 'store' || i.kind === 'vstore' || i.kind === 'gset';
}

/** Structural equality of two tail instructions under the suffix correspondence. */
function instEquiv(a: Inst, b: Inst, corr: Map<number, number>, definedInPred: Set<number>): boolean {
  if (a.kind !== b.kind || a.sub !== b.sub || a.ty !== b.ty) return false;
  if ((a.res === null) !== (b.res === null)) return false;
  if (a.args.length !== b.args.length) return false;
  if (!mergeable(a)) return false; // (a,b share kind, so checking a suffices)
  for (let k = 0; k < a.args.length; k++) {
    const oa = a.args[k];
    const ob = b.args[k];
    if (oa.tag !== ob.tag) return false;
    if (oa.tag === 'const' && ob.tag === 'const') {
      if (oa.ty !== ob.ty || oa.num !== ob.num) return false;
    } else if (oa.tag === 'val' && ob.tag === 'val') {
      if (corr.has(ob.id)) {
        if (corr.get(ob.id) !== oa.id) return false; // must match the same earlier result
      } else {
        // An external operand: identical id, and defined above every predecessor
        // (so it dominates M and is live at the moved copy).
        if (ob.id !== oa.id || definedInPred.has(ob.id)) return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

/** Longest mergeable common suffix length of `ref` and `other` (≥ 0). */
function matchSuffixLen(ref: Block, other: Block, definedInPred: Set<number>): number {
  let i = ref.insts.length - 1;
  let j = other.insts.length - 1;
  let matched = 0;
  const corr = new Map<number, number>(); // other.res -> ref.res across the matched region
  while (i >= 0 && j >= 0) {
    const a = ref.insts[i];
    const b = other.insts[j];
    if (!instEquiv(a, b, corr, definedInPred)) break;
    if (a.res !== null && b.res !== null) corr.set(b.res, a.res);
    i--;
    j--;
    matched++;
  }
  return matched;
}

const cloneOperand = (o: Operand): Operand => (o.tag === 'const' ? { tag: 'const', ty: o.ty, num: o.num } : { tag: 'val', id: o.id });
const opKey = (o: Operand): string => (o.tag === 'const' ? `c${o.ty}:${o.num}` : `v${o.id}`);

function replaceAllUses(fn: IRFunc, fromId: number, to: Operand): void {
  for (const b of fn.blocks)
    eachOperand(b, (o, set) => {
      if (o.tag === 'val' && o.id === fromId) set(cloneOperand(to));
    });
}

function recomputePreds(fn: IRFunc): void {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  for (const b of fn.blocks) b.preds = [];
  for (const b of fn.blocks) for (const s of succOfTerm(b.term)) byId.get(s)?.preds.push(b.id);
}

export function crossJump(fn: IRFunc): number {
  let changed = 0;
  let again = true;
  let guard = 0;
  while (again && guard++ < 5000) {
    again = false;
    recomputePreds(fn);
    const byId = new Map(fn.blocks.map((b) => [b.id, b]));

    for (const M of fn.blocks) {
      if (M.id === fn.entry) continue;
      if (M.preds.length < 2) continue;
      if (new Set(M.preds).size !== M.preds.length) continue; // distinct predecessors only
      const preds = M.preds.map((p) => byId.get(p)).filter((p): p is Block => !!p);
      if (preds.length !== M.preds.length) continue;
      // Every predecessor jumps *unconditionally* and *only* to M, and has a tail.
      if (!preds.every((p) => p.id !== M.id && p.term.op === 'br' && (p.term as { target: number }).target === M.id)) continue;
      if (preds.some((p) => p.insts.length === 0)) continue;

      // Values defined inside *any* predecessor — disqualifies an operand from being
      // "external" (an operand must dominate M to survive the move to M's front).
      const definedInPred = new Set<number>();
      for (const p of preds) {
        for (const ph of p.phis) definedInPred.add(ph.res);
        for (const i of p.insts) if (i.res !== null) definedInPred.add(i.res);
      }

      const ref = preds[0];
      let L = Infinity;
      for (let pi = 1; pi < preds.length; pi++) L = Math.min(L, matchSuffixLen(ref, preds[pi], definedInPred));
      if (!Number.isFinite(L) || L < 1) continue;

      // Positional correspondence over the last L instructions: each predecessor's
      // d-th-from-last result maps to ref's d-th-from-last result.
      const corrOf = (p: Block): Map<number, number> => {
        const m = new Map<number, number>();
        for (let d = 0; d < L; d++) {
          const a = ref.insts[ref.insts.length - 1 - d];
          const b = p.insts[p.insts.length - 1 - d];
          if (a.res !== null && b.res !== null) m.set(b.res, a.res);
        }
        return m;
      };
      const corrs = preds.map((p) => (p === ref ? new Map<number, number>() : corrOf(p)));

      // Results that vanish (every non-ref predecessor's last L results) and results
      // that survive in M (ref's last L results).
      const deleted = new Set<number>();
      for (let pi = 1; pi < preds.length; pi++)
        for (let d = 0; d < L; d++) {
          const r = preds[pi].insts[preds[pi].insts.length - 1 - d].res;
          if (r !== null) deleted.add(r);
        }
      const refTail = new Set<number>();
      for (let d = 0; d < L; d++) {
        const r = ref.insts[ref.insts.length - 1 - d].res;
        if (r !== null) refTail.add(r);
      }

      // Plan the φ rewrites in M: a φ whose incomings are the per-predecessor tail
      // results (after correspondence) becomes uniform and is replaced by the single
      // kept value; a φ that touches a moved/deleted result without collapsing aborts.
      const remap = (pi: number, v: Operand): Operand => {
        if (v.tag === 'val' && corrs[pi].has(v.id)) return { tag: 'val', id: corrs[pi].get(v.id)! };
        return v;
      };
      const phiReplace: { res: number; to: Operand }[] = [];
      let abort = false;
      for (const phi of M.phis) {
        const incByPred = new Map<number, Operand>();
        for (const inc of phi.incomings) incByPred.set(inc.pred, inc.val);
        const touches = phi.incomings.some((inc) => inc.val.tag === 'val' && (deleted.has(inc.val.id) || refTail.has(inc.val.id)));
        const remapped = preds.map((p, pi) => remap(pi, incByPred.get(p.id) ?? { tag: 'const', ty: phi.ty, num: 0 }));
        const uniform = remapped.every((o) => opKey(o) === opKey(remapped[0]));
        if (uniform) phiReplace.push({ res: phi.res, to: remapped[0] });
        else if (touches) {
          abort = true; // a φ over the tail results that won't collapse — decline
          break;
        }
      }
      if (abort) continue;

      // Belt-and-suspenders: a deleted result may be used *only* within the suffix
      // we are dropping (chained tails reference each other) or by an M-φ we are
      // collapsing. Any other use means the move would leave a dangling reference —
      // decline. (For valid SSA this never triggers, since each deleted result is
      // defined in a predecessor whose sole successor is M.)
      const droppedInsts = new Set<Inst>();
      for (let pi = 1; pi < preds.length; pi++)
        for (let d = 0; d < L; d++) droppedInsts.add(preds[pi].insts[preds[pi].insts.length - 1 - d]);
      const phiResSet = new Set(phiReplace.map((p) => p.res));
      for (const b of fn.blocks) {
        for (const inst of b.insts) {
          if (droppedInsts.has(inst)) continue; // its own uses vanish with it
          for (const a of inst.args) if (a.tag === 'val' && deleted.has(a.id)) abort = true;
        }
        if (abort) break;
        if (b.term.op === 'condbr' && b.term.cond.tag === 'val' && deleted.has(b.term.cond.id)) abort = true;
        if (b.term.op === 'ret' && b.term.value && b.term.value.tag === 'val' && deleted.has(b.term.value.id)) abort = true;
        if (abort) break;
        for (const phi of b.phis)
          for (const inc of phi.incomings)
            if (inc.val.tag === 'val' && deleted.has(inc.val.id) && !(b === M && phiResSet.has(phi.res))) abort = true;
        if (abort) break;
      }
      if (abort) continue;

      // --- Apply: move ref's last L insts to M's front, drop the others' ----------
      const moved = ref.insts.splice(ref.insts.length - L, L);
      for (let pi = 1; pi < preds.length; pi++) preds[pi].insts.splice(preds[pi].insts.length - L, L);
      M.insts.unshift(...moved);
      // Collapse the tail φs to the single kept value.
      for (const { res, to } of phiReplace) {
        replaceAllUses(fn, res, to);
        M.phis = M.phis.filter((p) => p.res !== res);
      }
      changed += L * (preds.length - 1);
      again = true;
      break; // CFG/defs shifted — rebuild and rescan
    }

    // --- Return-tail merging: the exit-side variant ----------------------------
    //
    // Two arms `T`/`F` of a branch that each end in `ret` with the same returned
    // value and the same instruction tail are factored into one shared exit block
    // `R`: both arms `br R`, and `R` runs the tail once and returns. This is the
    // `if (c) { …; return e } else { …; return e }` shape — common, and one that the
    // merge-block scan above can't reach because the arms have no common successor
    // (a `ret` has none). It is *cleaner* than the merge case: `T`/`F` have no
    // successors, so no φ anywhere reads their tail results — the only references are
    // inside the moved suffix itself, which travels intact into `R`.
    if (!again) {
      const freshBlockId = fn.blocks.reduce((m, b) => Math.max(m, b.id), 0) + 1;
      for (const B of fn.blocks) {
        if (B.term.op !== 'condbr' || B.term.t === B.term.f) continue;
        const T = byId.get(B.term.t);
        const F = byId.get(B.term.f);
        if (!T || !F || T === F || T.id === fn.entry || F.id === fn.entry) continue;
        if (T.term.op !== 'ret' || F.term.op !== 'ret') continue;
        const tv = T.term.value;
        const fv = F.term.value;
        if ((tv === null) !== (fv === null)) continue; // one returns a value, the other void

        // Operands defined inside either arm are not available at the shared block.
        const definedInside = new Set<number>();
        for (const ph of T.phis) definedInside.add(ph.res);
        for (const i of T.insts) if (i.res !== null) definedInside.add(i.res);
        for (const ph of F.phis) definedInside.add(ph.res);
        for (const i of F.insts) if (i.res !== null) definedInside.add(i.res);

        const L = matchSuffixLen(T, F, definedInside);
        if (L < 1) continue;

        // Correspondence over the last L insts (F result → T result), and the kept
        // tail results, so the returned value can be checked + relocated.
        const corr = new Map<number, number>();
        const tTail = new Set<number>();
        for (let d = 0; d < L; d++) {
          const a = T.insts[T.insts.length - 1 - d];
          const b = F.insts[F.insts.length - 1 - d];
          if (a.res !== null && b.res !== null) corr.set(b.res, a.res);
          if (a.res !== null) tTail.add(a.res);
        }

        // The returned value must agree under the correspondence, and (if it is a
        // value) be either a moved tail result or available above both arms — never a
        // non-suffix arm-local, which would not exist in `R`.
        let retVal: Operand | null = null;
        if (tv !== null && fv !== null) {
          const remapF = (o: Operand): Operand => (o.tag === 'val' && corr.has(o.id) ? { tag: 'val', id: corr.get(o.id)! } : o);
          if (opKey(remapF(fv)) !== opKey(tv)) continue;
          if (tv.tag === 'val' && !tTail.has(tv.id) && definedInside.has(tv.id)) continue;
          retVal = cloneOperand(tv);
        }

        // Apply: relocate T's suffix into a fresh exit block, drop F's, redirect both.
        const moved = T.insts.splice(T.insts.length - L, L);
        F.insts.splice(F.insts.length - L, L);
        const R: Block = { id: freshBlockId, phis: [], insts: moved, term: { op: 'ret', value: retVal }, preds: [T.id, F.id] };
        T.term = { op: 'br', target: R.id };
        F.term = { op: 'br', target: R.id };
        fn.blocks.push(R);
        changed += L;
        again = true;
        break;
      }
    }
  }
  if (changed) recomputePreds(fn);
  return changed;
}
