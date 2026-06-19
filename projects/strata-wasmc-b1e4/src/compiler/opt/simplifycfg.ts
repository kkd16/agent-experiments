import type { IRFunc, Operand, Term } from '../ir/ir';
import { eachOperand } from '../ir/ir';
import { succOfTerm } from '../ir/cfg';

// CFG simplification: structural clean-ups that shrink the block graph without
// touching observable behaviour. SCCP, if-conversion and inlining all leave
// straight-line block chains and empty forwarding blocks behind; this pass folds
// them away, so the backend reloops a tighter graph and the block-count metric
// drops on essentially every program. Both rewrites are guarded so they only ever
// merge when execution order is provably unchanged — the differential oracle
// proves the rest.

function cloneOperand(o: Operand): Operand {
  return o.tag === 'const' ? { tag: 'const', ty: o.ty, num: o.num } : { tag: 'val', id: o.id };
}

/** Replace every use of value `fromId` with the operand `to`, across the function. */
function replaceAllUses(fn: IRFunc, fromId: number, to: Operand): number {
  let n = 0;
  for (const b of fn.blocks) {
    eachOperand(b, (o, set) => {
      if (o.tag === 'val' && o.id === fromId) {
        set(cloneOperand(to));
        n++;
      }
    });
  }
  return n;
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
  if (t.op === 'condbr') return { op: 'condbr', cond: t.cond, t: t.t === from ? to : t.t, f: t.f === from ? to : t.f };
  return t;
}

export function simplifyCFG(fn: IRFunc): number {
  let changed = 0;
  let again = true;
  while (again) {
    again = false;
    recomputePreds(fn);
    const byId = new Map(fn.blocks.map((b) => [b.id, b]));

    // --- 1. straight-line block coalescing -------------------------------
    // `A` ends in an unconditional `br B`, and `B`'s only predecessor is `A`.
    // The two always run back-to-back, so merge `B` into `A`: fold `B`'s (now
    // single-incoming) phis, append its instructions, and let `A` inherit `B`'s
    // terminator. `B`'s successors re-point their phi incomings from `B` to `A`.
    for (const a of fn.blocks) {
      if (a.term.op !== 'br') continue;
      const b = byId.get(a.term.target);
      if (!b || b.id === a.id || b.id === fn.entry) continue;
      if (b.preds.length !== 1 || b.preds[0] !== a.id) continue;

      // Fold B's phis: with one predecessor each phi is just its A-incoming value.
      for (const phi of b.phis) {
        const inc = phi.incomings[0];
        const val = inc ? inc.val : { tag: 'const' as const, ty: phi.ty, num: 0 };
        changed += replaceAllUses(fn, phi.res, val);
      }
      a.insts.push(...b.insts);
      a.term = b.term;
      // Successors of (the old) B now have A as the predecessor in their phis.
      for (const s of succOfTerm(b.term)) {
        const sb = byId.get(s);
        if (!sb) continue;
        for (const phi of sb.phis) for (const inc of phi.incomings) if (inc.pred === b.id) inc.pred = a.id;
      }
      fn.blocks = fn.blocks.filter((x) => x.id !== b.id);
      changed++;
      again = true;
      break; // CFG mutated — restart with fresh preds
    }
    if (again) continue;

    // --- 2. branch-to-branch threading -----------------------------------
    // An empty forwarding block `E` (no phis, no instructions, `br C`) is spliced
    // out: every predecessor jumps straight to `C`. Guarded so no new phi
    // bookkeeping is needed and no duplicate edge is created: `C` must have no
    // phis, and no predecessor of `E` may already target `C`.
    for (const e of fn.blocks) {
      if (e.id === fn.entry) continue;
      if (e.phis.length > 0 || e.insts.length > 0 || e.term.op !== 'br') continue;
      const cId = e.term.target;
      if (cId === e.id) continue;
      const c = byId.get(cId);
      if (!c || c.phis.length > 0) continue;
      if (e.preds.length === 0) continue;
      const preds = e.preds.map((p) => byId.get(p)!).filter(Boolean);
      // No predecessor may already reach C (would create a duplicate edge).
      if (preds.some((p) => succOfTerm(p.term).includes(cId))) continue;
      for (const p of preds) p.term = redirectTerm(p.term, e.id, cId);
      fn.blocks = fn.blocks.filter((x) => x.id !== e.id);
      changed++;
      again = true;
      break;
    }
  }
  if (changed) recomputePreds(fn);
  return changed;
}
