import type { ConstNum, IRFunc, IRType, Operand, Term } from '../ir/ir';
import { succOfTerm } from '../ir/cfg';
import { foldIntBinCmp } from './optimize';

// Jump threading
// ==============
//
// When a block `B` is a control-flow *merge* whose terminator `condbr c, T, F`
// branches on a value that is **decided per-incoming-edge**, we route each such
// predecessor straight to the successor it would have taken, skipping the test.
// When *every* predecessor is decided this way, `B` itself evaporates.
//
// The condition `c` need not be a bare phi. `B` may carry a small **pure foldable
// expression cone** — `ibin`/`icmp` instructions whose operands are constants,
// `B`'s own phis, or earlier cone results — rooted at `c`. On an incoming edge
// where every phi the cone reads is a constant, the cone folds (with SCCP's exact
// wasm-semantics evaluators, shared as `foldIntBinCmp`) to a known `c`, so the
// branch outcome is settled for that edge. This is the path-sensitive partner to
// SCCP: SCCP folds a branch only when `c` is constant on **every** path; threading
// acts when it is constant on **one** — the steady state of a materialized boolean
// (`let hot=false; if (p()) hot=true; if (hot) …`), a short-circuit chain
// (`if (p||q) …`), or now a *comparison/arithmetic over* such a value
// (`if (flag == 0) …`, `if ((mask & 1) != 0) …`) that earlier rounds left as a
// per-edge-constant cone feeding the branch.
//
// ## SSA safety
//
// `B` may define values only through its phis and its cone instructions, and we
// only ever rewire a predecessor `P` (translating `T`/`F`'s `pred = B` phi
// incomings to the value seen from `P`). That is sound precisely when (a) every
// instruction in `B` is a pure foldable `ibin`/`icmp` over constants / `B`-phis /
// earlier cone results — so bypassing `B` re-computes nothing observable — and (b)
// each value `B` defines is used *only* by `B`'s own cone, by `B`'s terminator, or,
// for a **phi** result, as a `pred = B` incoming in `B`'s successors. A cone result
// may never escape `B` (it cannot be materialized on a threaded edge), and no
// instruction outside `B` may read any `B` value. We verify exactly that before
// touching `B`; otherwise we decline. The triple-differential oracle (the reference
// interpreter, V8's WebAssembly, and the project's from-scratch wasm VM, all
// agreeing at every opt level) is the proof that the rewiring is sound.

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
      if (B.term.op !== 'condbr') continue;
      const cond = B.term.cond;
      if (cond.tag !== 'val') continue; // a constant condition is SCCP/simplify-cfg's job
      const cId = cond.id;
      const T = B.term.t;
      const F = B.term.f;
      if (T === B.id || F === B.id || T === F) continue; // never thread into B itself / degenerate

      // `B`'s condition cone: every instruction must be a pure foldable `ibin`/`icmp`
      // over constants, `B`-phis, or earlier cone results — nothing else (no side
      // effects, no loads, no external operands). `c` must name a phi or a cone result.
      const bPhiIds = new Set<number>(B.phis.map((p) => p.res));
      const bInstIds = new Set<number>();
      for (const inst of B.insts) if (inst.res !== null) bInstIds.add(inst.res);
      let coneOk = true;
      for (const inst of B.insts) {
        if ((inst.kind !== 'ibin' && inst.kind !== 'icmp') || inst.res === null) { coneOk = false; break; }
        for (const a of inst.args) {
          if (a.tag === 'const') continue;
          if (!bPhiIds.has(a.id) && !bInstIds.has(a.id)) { coneOk = false; break; }
        }
        if (!coneOk) break;
      }
      if (!coneOk) continue;
      if (!bPhiIds.has(cId) && !bInstIds.has(cId)) continue; // condition is external — can't fold per-edge

      // Safety: every value `B` defines may be used only by `B`'s own cone, by `B`'s
      // terminator condition, or — for a *phi* — as a `pred = B` incoming in T/F. A
      // cone result must never appear outside `B`.
      const bIds = new Set<number>([...bPhiIds, ...bInstIds]);
      let safe = true;
      for (const X of fn.blocks) {
        if (X.id !== B.id) {
          for (const inst of X.insts) {
            for (const a of inst.args) if (a.tag === 'val' && bIds.has(a.id)) { safe = false; break; }
            if (!safe) break;
          }
          if (!safe) break;
          const t = X.term;
          if (t.op === 'condbr' && t.cond.tag === 'val' && bIds.has(t.cond.id)) { safe = false; break; }
          if (t.op === 'ret' && t.value && t.value.tag === 'val' && bIds.has(t.value.id)) { safe = false; break; }
        }
        for (const phi of X.phis) {
          for (const inc of phi.incomings) {
            if (inc.val.tag === 'val' && bIds.has(inc.val.id)) {
              // Only a phi result may flow out, and only along T/F's `pred = B` edge.
              const allowed = (X.id === T || X.id === F) && inc.pred === B.id && bPhiIds.has(inc.val.id);
              if (!allowed) { safe = false; break; }
            }
          }
          if (!safe) break;
        }
        if (!safe) break;
      }
      if (!safe) continue;

      // Fold the cone on the edge from `P`: seed each phi with its (constant)
      // `P`-incoming, evaluate the cone in order, and read off `c`. Returns the
      // taken target, or null when the edge does not decide the branch.
      const decideEdge = (P: number): number | null => {
        const env = new Map<number, { ty: IRType; num: ConstNum }>();
        for (const phi of B.phis) {
          const inc = phi.incomings.find((i) => i.pred === P);
          if (inc && inc.val.tag === 'const') env.set(phi.res, { ty: inc.val.ty, num: inc.val.num });
        }
        for (const inst of B.insts) {
          const ops: { ty: IRType; num: ConstNum }[] = [];
          let ok = true;
          for (const a of inst.args) {
            if (a.tag === 'const') ops.push({ ty: a.ty, num: a.num });
            else {
              const v = env.get(a.id);
              if (!v) { ok = false; break; }
              ops.push(v);
            }
          }
          if (!ok || ops.length !== 2) continue; // result stays unknown
          const r = foldIntBinCmp(inst.kind as 'ibin' | 'icmp', inst.sub, ops[0].ty, ops[0].num, ops[1].num);
          if (r === null) continue; // unfoldable (e.g. div by zero) — leave unknown
          env.set(inst.res!, { ty: inst.kind === 'icmp' ? 'i32' : ops[0].ty, num: r });
        }
        const cv = env.get(cId);
        if (!cv) return null;
        const truthy = typeof cv.num === 'bigint' ? cv.num !== 0n : cv.num !== 0;
        return truthy ? T : F;
      };

      // Collect the predecessors whose edge decides the branch.
      const jobs: { pred: number; target: number }[] = [];
      for (const P of new Set(B.preds)) {
        if (P === B.id) continue; // a self/back edge — leave it
        const target = decideEdge(P);
        if (target === null || target === B.id) continue;
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
          if (v.tag === 'val' && bPhiIds.has(v.id)) {
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
