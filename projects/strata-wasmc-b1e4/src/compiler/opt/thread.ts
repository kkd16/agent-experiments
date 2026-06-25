import type { IRFunc, Operand, Term } from '../ir/ir';
import { succOfTerm } from '../ir/cfg';

// Jump threading
// ==============
//
// When a block `B` is a pure control-flow *merge* — only phi nodes, no
// instructions — and it ends in `condbr c, T, F` where `c` is one of `B`'s own
// phis, then on any incoming edge whose value for that phi is a **constant** the
// branch's outcome is already decided. We route that predecessor straight to the
// taken successor (`T` when the constant is non-zero, else `F`), skipping the
// test entirely. When *every* predecessor is decided this way, `B` itself
// evaporates.
//
// This is the optimization that collapses materialized booleans and
// short-circuit logic. `let t = a ? true : false; if (t) { … }` and
// `if (p || q) { … }` both lower to a boolean phi feeding a branch; threading
// turns the second test into a direct jump with no branch at all — and the dead
// arms the fold exposes are then swept by SCCP/DCE/simplify-cfg. It generalizes
// `simplify-cfg`'s branch-to-branch rule (which only threads *empty unconditional*
// forwarders) to *conditional* merges whose condition is known per edge.
//
// ## SSA safety
//
// Because `B` carries no instructions, the only values it defines are its phis,
// and we only ever rewire a predecessor `P` (and translate `T`/`F`'s `pred = B`
// phi incomings to the value seen from `P`). That is sound precisely when a
// `B`-phi is used *only* by `B`'s terminator and by `pred = B` phi incomings in
// `B`'s successors — i.e. never read by an instruction that a threaded edge would
// now bypass. We verify that before touching `B`; if any other use exists we
// leave `B` alone and let the rest of the pipeline handle it. The differential
// oracle (interpreter ≡ wasm ≡ from-scratch VM, at every opt level) proves the
// rest.

function cloneOperand(o: Operand): Operand {
  return o.tag === 'const' ? { tag: 'const', ty: o.ty, num: o.num } : { tag: 'val', id: o.id };
}

/** Recompute every block's predecessor list from the terminators. */
function recomputePreds(fn: IRFunc): void {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  for (const b of fn.blocks) b.preds = [];
  for (const b of fn.blocks) for (const s of succOfTerm(b.term)) byId.get(s)?.preds.push(b.id);
}

/** Rewrite a terminator's edges, replacing target `from` with `to`. */
function redirectTerm(t: Term, from: number, to: number): Term {
  if (t.op === 'br') return t.target === from ? { op: 'br', target: to } : t;
  if (t.op === 'condbr') return { op: 'condbr', cond: t.cond, t: t.t === from ? to : t.t, f: t.f === from ? to : t.f, span: t.span };
  return t;
}

export function jumpThread(fn: IRFunc): number {
  let changed = 0;
  let again = true;
  while (again) {
    again = false;
    recomputePreds(fn);
    const byId = new Map(fn.blocks.map((b) => [b.id, b]));

    for (const B of fn.blocks) {
      if (B.id === fn.entry) continue;
      if (B.insts.length !== 0) continue; // only pure merge blocks
      if (B.term.op !== 'condbr') continue;
      const cond = B.term.cond;
      if (cond.tag !== 'val') continue; // a constant condition is SCCP/simplify-cfg's job
      const cPhi = B.phis.find((p) => p.res === cond.id);
      if (!cPhi || cPhi.ty !== 'i32') continue; // condition must be one of B's i32 phis
      const T = B.term.t;
      const F = B.term.f;
      if (T === B.id || F === B.id) continue; // never thread into B itself

      // Safety: every value B defines (its phis) may only be used by B's own
      // terminator condition and by `pred = B` phi incomings in T/F. Any other
      // use — an instruction, a ret/condbr in another block, or an incoming on a
      // different edge — would observe a value a threaded edge no longer produces.
      const bIds = new Set(B.phis.map((p) => p.res));
      let safe = true;
      for (const X of fn.blocks) {
        for (const inst of X.insts) {
          for (const a of inst.args) if (a.tag === 'val' && bIds.has(a.id)) { safe = false; break; }
          if (!safe) break;
        }
        if (!safe) break;
        const t = X.term;
        if (X.id !== B.id && t.op === 'condbr' && t.cond.tag === 'val' && bIds.has(t.cond.id)) { safe = false; break; }
        if (t.op === 'ret' && t.value && t.value.tag === 'val' && bIds.has(t.value.id)) { safe = false; break; }
        for (const phi of X.phis) {
          for (const inc of phi.incomings) {
            if (inc.val.tag === 'val' && bIds.has(inc.val.id)) {
              const allowed = (X.id === T || X.id === F) && inc.pred === B.id;
              if (!allowed) { safe = false; break; }
            }
          }
          if (!safe) break;
        }
        if (!safe) break;
      }
      if (!safe) continue;

      // Collect the predecessors whose condition value is a known constant.
      const jobs: { pred: number; target: number }[] = [];
      for (const inc of cPhi.incomings) {
        const P = inc.pred;
        if (P === B.id) continue; // a self/back edge — leave it
        if (inc.val.tag !== 'const') continue;
        const target = Number(inc.val.num) !== 0 ? T : F;
        if (target === B.id) continue;
        const pb = byId.get(P);
        if (!pb) continue;
        if (succOfTerm(pb.term).includes(target)) continue; // would duplicate an edge P already has
        jobs.push({ pred: P, target });
      }
      if (jobs.length === 0) continue;

      for (const { pred, target } of jobs) {
        const pb = byId.get(pred)!;
        const tb = byId.get(target)!;
        // Give `target`'s phis an incoming for the new `pred → target` edge. A
        // `pred = B` incoming that names a B-phi resolves to that phi's own value
        // on the `pred` edge; anything else (a constant or a value that dominates
        // B, hence dominates `pred`) carries over unchanged.
        for (const tphi of tb.phis) {
          const fromB = tphi.incomings.find((i) => i.pred === B.id);
          let v: Operand = fromB ? fromB.val : { tag: 'const', ty: tphi.ty, num: 0 };
          if (v.tag === 'val' && bIds.has(v.id)) {
            const bphi = B.phis.find((p) => p.res === (v as { id: number }).id)!;
            const w = bphi.incomings.find((i) => i.pred === pred);
            v = w ? w.val : v;
          }
          tphi.incomings.push({ pred, val: cloneOperand(v) });
        }
        pb.term = redirectTerm(pb.term, B.id, target);
        for (const phi of B.phis) phi.incomings = phi.incomings.filter((i) => i.pred !== pred);
        changed++;
      }

      // If no predecessor still reaches B, it is dead: drop it and remove its now
      // vanished `pred = B` incomings from T/F.
      let stillReached = false;
      for (const b of fn.blocks) if (b.id !== B.id) for (const s of succOfTerm(b.term)) if (s === B.id) stillReached = true;
      if (!stillReached) {
        for (const succId of new Set([T, F])) {
          const sb = byId.get(succId);
          if (sb) for (const phi of sb.phis) phi.incomings = phi.incomings.filter((i) => i.pred !== B.id);
        }
        fn.blocks = fn.blocks.filter((x) => x.id !== B.id);
      }
      again = true;
      break; // CFG mutated — restart with fresh preds
    }
  }
  if (changed) recomputePreds(fn);
  return changed;
}
