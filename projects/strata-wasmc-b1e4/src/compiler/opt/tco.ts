import type { IRType } from '../ir/ir';
import type { PFunc, PModule, POperand } from '../ir/builder';

// Tail-call optimization by *loopification*. A self-recursive call in tail
// position — the last thing a block does, whose result is returned immediately —
// is rewritten into a jump back to the function entry with the parameters
// reassigned to the call's arguments. Self-recursion becomes a plain loop, so it
// runs in constant stack space (and, having shed its self-calls, the function may
// even become inlinable afterwards).
//
// This runs on the pre-SSA CFG; adding the back edge to the entry simply turns it
// into a loop header, and SSA construction inserts the parameter phis for free.
// We never need WebAssembly's tail-call proposal.

function recomputePreds(fn: PFunc): void {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  for (const b of fn.blocks) b.preds = [];
  for (const b of fn.blocks) {
    const t = b.term;
    if (!t) continue;
    const succ = t.op === 'br' ? [t.target] : t.op === 'condbr' ? [t.t, t.f] : [];
    for (const s of succ) byId.get(s)?.preds.push(b.id);
  }
}

export function tailCallOpt(pm: PModule): number {
  let total = 0;
  for (const fn of pm.funcs) {
    let changed = false;
    let tempCtr = 0;

    // The loop header is the *original* entry block, but we branch back to it
    // through a fresh entry that supplies the first iteration's arguments. Without
    // that preheader, the header's parameter phis would see only the back edges
    // and lose the initial call's argument values.
    let loopHeader = -1;
    let nextBlockId = 0;
    for (const b of fn.blocks) if (b.id >= nextBlockId) nextBlockId = b.id + 1;
    const ensurePreheader = (): number => {
      if (loopHeader === -1) {
        loopHeader = fn.entry;
        const pre = { id: nextBlockId++, insts: [], term: { op: 'br' as const, target: loopHeader }, preds: [] };
        fn.blocks.push(pre);
        fn.entry = pre.id;
      }
      return loopHeader;
    };

    // Snapshot the block list: ensurePreheader appends a block we must not visit.
    for (const b of [...fn.blocks]) {
      if (!b.term || b.insts.length === 0) continue;
      const last = b.insts[b.insts.length - 1];
      if (last.kind !== 'call' || last.sub !== fn.name) continue;

      // Is the call in tail position?
      const t = b.term;
      const isTail =
        last.dest === null
          ? t.op === 'ret' && t.value === null
          : t.op === 'ret' && t.value !== null && t.value.tag === 'var' && t.value.name === last.dest;
      if (!isTail) continue;

      // Reassign parameters via a parallel copy (read all args into temps first,
      // then write the parameters) so an argument that mentions a parameter sees
      // its pre-call value.
      const temps: { tmp: string; param: string; ty: IRType; val: POperand }[] = fn.params.map((p, i) => {
        const tmp = `%tco$${fn.name}$${tempCtr++}`;
        fn.varType.set(tmp, p.ty);
        return { tmp, param: p.name, ty: p.ty, val: last.args[i] ?? { tag: 'const', ty: p.ty, num: 0 } };
      });

      const header = ensurePreheader();
      b.insts.pop(); // drop the self-call
      for (const c of temps) b.insts.push({ dest: c.tmp, ty: c.ty, kind: 'copy', sub: '', args: [c.val] });
      for (const c of temps) b.insts.push({ dest: c.param, ty: c.ty, kind: 'copy', sub: '', args: [{ tag: 'var', name: c.tmp }] });
      b.term = { op: 'br', target: header };
      changed = true;
      total++;
    }
    if (changed) recomputePreds(fn);
  }
  return total;
}
