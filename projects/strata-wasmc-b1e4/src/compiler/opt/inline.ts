import type { PBlock, PFunc, PInst, PModule, POperand, PTerm } from '../ir/builder';

// Function inlining, performed on the *pre-SSA* CFG (before ssa.ts runs). Working
// here is dramatically simpler than splicing SSA: variables are still referenced
// by name and may be assigned more than once, so a call site becomes a plain
// block split + a renamed copy of the callee, with every `ret` rewritten to
// assign the result and branch to the continuation. The subsequent SSA pass then
// inserts whatever phi nodes the merged control flow needs — for free.
//
// Only small, non-recursive callees are inlined, under a global budget, so the
// program can never blow up unboundedly. Inlined code exposes fresh constant
// arguments and dead branches to the downstream optimizer (SCCP/GVN/DCE/LICM),
// which is where the real wins come from.

const MAX_CALLEE_INSTS = 40; // a callee larger than this is left as a call
const MAX_FUNC_INSTS = 1200; // stop inlining into a caller once it grows past this
const GLOBAL_BUDGET = 300; // hard cap on inline operations per compilation

function funcInstCount(fn: PFunc): number {
  let n = 0;
  for (const b of fn.blocks) n += b.insts.length;
  return n;
}

/** Names of functions that can transitively reach themselves (self/mutual recursion). */
function recursiveFunctions(pm: PModule): Set<number> {
  const calls = new Map<string, Set<string>>();
  for (const fn of pm.funcs) {
    const s = new Set<string>();
    for (const b of fn.blocks) for (const i of b.insts) if (i.kind === 'call') s.add(i.sub);
    calls.set(fn.name, s);
  }
  const recursive = new Set<string>();
  for (const fn of pm.funcs) {
    // does fn reach itself?
    const seen = new Set<string>();
    const stack = [...(calls.get(fn.name) ?? [])];
    let hit = false;
    while (stack.length) {
      const g = stack.pop()!;
      if (g === fn.name) { hit = true; break; }
      if (seen.has(g)) continue;
      seen.add(g);
      for (const h of calls.get(g) ?? []) stack.push(h);
    }
    if (hit) recursive.add(fn.name);
  }
  const idx = new Set<number>();
  pm.funcs.forEach((f, i) => { if (recursive.has(f.name)) idx.add(i); });
  return idx;
}

function reachableBlocks(fn: PFunc): Set<number> {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const seen = new Set<number>();
  const stack = [fn.entry];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = byId.get(id)?.term;
    if (!t) continue;
    if (t.op === 'br') stack.push(t.target);
    else if (t.op === 'condbr') { stack.push(t.t); stack.push(t.f); }
  }
  return seen;
}

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

/** Inline a single call (caller `fn`, block `B`, instruction index `i`). */
function inlineAt(fn: PFunc, B: PBlock, i: number, callee: PFunc, uid: number): void {
  const call = B.insts[i];
  const ren = (n: string): string => `@${callee.name}$${uid}$${n}`;
  const cloneOp = (o: POperand): POperand => (o.tag === 'var' ? { tag: 'var', name: ren(o.name) } : { ...o });

  let nextBlockId = 0;
  for (const b of fn.blocks) if (b.id >= nextBlockId) nextBlockId = b.id + 1;
  const blockMap = new Map<number, number>();
  for (const cb of callee.blocks) blockMap.set(cb.id, nextBlockId++);

  // Carry the callee's variable types (renamed) into the caller's type table.
  for (const [name, ty] of callee.varType) fn.varType.set(ren(name), ty);

  // Continuation: everything in B after the call (last fresh block id).
  const cont: PBlock = { id: nextBlockId, insts: B.insts.slice(i + 1), term: B.term, preds: [] };

  // Clone callee blocks; rewrite each `ret` to assign the result + branch to cont.
  const cloned: PBlock[] = callee.blocks.map((cb) => {
    const insts = cb.insts.map((inst): PInst => ({
      dest: inst.dest === null ? null : ren(inst.dest),
      ty: inst.ty,
      kind: inst.kind,
      sub: inst.sub,
      args: inst.args.map(cloneOp),
    }));
    let term: PTerm;
    const t = cb.term;
    if (!t || t.op === 'ret') {
      if (t && t.op === 'ret' && t.value !== null && call.dest !== null) {
        insts.push({ dest: call.dest, ty: call.ty, kind: 'copy', sub: '', args: [cloneOp(t.value)] });
      }
      term = { op: 'br', target: cont.id };
    } else if (t.op === 'br') {
      term = { op: 'br', target: blockMap.get(t.target)! };
    } else if (t.op === 'condbr') {
      term = { op: 'condbr', cond: cloneOp(t.cond), t: blockMap.get(t.t)!, f: blockMap.get(t.f)! };
    } else {
      term = { op: 'unreachable' };
    }
    return { id: blockMap.get(cb.id)!, insts, term, preds: [] };
  });

  // Bind parameters by value at the call site, then jump into the callee body.
  const binds: PInst[] = callee.params.map((p, k) => ({
    dest: ren(p.name),
    ty: p.ty,
    kind: 'copy',
    sub: '',
    args: [call.args[k] ?? { tag: 'const', ty: p.ty, num: 0 }],
  }));
  B.insts = [...B.insts.slice(0, i), ...binds];
  B.term = { op: 'br', target: blockMap.get(callee.entry)! };

  fn.blocks.push(cont, ...cloned);
}

/** Inline small non-recursive callees throughout the module. Returns #inlines. */
export function inlineModule(pm: PModule): number {
  const recursive = recursiveFunctions(pm);
  const byName = new Map(pm.funcs.map((f) => [f.name, f]));
  let uid = 1;
  let total = 0;

  for (let fi = 0; fi < pm.funcs.length; fi++) {
    const fn = pm.funcs[fi];
    let progress = true;
    while (progress && total < GLOBAL_BUDGET && funcInstCount(fn) < MAX_FUNC_INSTS) {
      progress = false;
      const reachable = reachableBlocks(fn);
      outer: for (const B of fn.blocks) {
        if (!reachable.has(B.id) || !B.term) continue;
        for (let i = 0; i < B.insts.length; i++) {
          const inst = B.insts[i];
          if (inst.kind !== 'call') continue;
          const callee = byName.get(inst.sub);
          if (!callee) continue;
          const ci = pm.funcs.indexOf(callee);
          if (recursive.has(ci)) continue; // never inline a (mutually) recursive callee
          if (funcInstCount(callee) > MAX_CALLEE_INSTS) continue;
          inlineAt(fn, B, i, callee, uid++);
          total++;
          progress = true;
          break outer; // block list + indices changed; rescan
        }
      }
    }
    recomputePreds(fn);
  }
  return total;
}
