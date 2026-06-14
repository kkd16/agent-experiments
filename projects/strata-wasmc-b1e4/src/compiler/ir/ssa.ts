import type { PBlock, PFunc, PModule, POperand } from './builder';
import type { Block, Inst, IRFunc, IRModule, IRType, Operand, Phi, Term } from './ir';

// Convert the pre-SSA CFG into pure SSA. The classic recipe (Cytron et al.):
//   1. compute the dominator tree (Cooper–Harvey–Kennedy iterative algorithm),
//   2. compute dominance frontiers,
//   3. insert phi nodes at the iterated dominance frontier of each variable's
//      definition sites (only multiply-defined variables can need one), and
//   4. rename every definition/use into a unique SSA value via a dominator-tree
//      walk with a per-variable version stack.

interface WorkPhi {
  varName: string;
  res: number;
  ty: IRType;
  incomings: Map<number, Operand>;
}

export function toSSA(pm: PModule): IRModule {
  return {
    funcs: pm.funcs.map(ssaFunc),
    globals: pm.globals,
    usesMemory: pm.usesMemory,
    memPages: pm.memPages,
  };
}

function succOf(b: PBlock): number[] {
  const t = b.term;
  if (!t) return [];
  if (t.op === 'br') return [t.target];
  if (t.op === 'condbr') return t.t === t.f ? [t.t] : [t.t, t.f];
  return [];
}

function ssaFunc(pf: PFunc): IRFunc {
  const byId = new Map(pf.blocks.map((b) => [b.id, b]));

  // --- 0. drop blocks unreachable from entry, prune dangling preds ---
  const reachable = new Set<number>();
  const stack = [pf.entry];
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const s of succOf(byId.get(id)!)) stack.push(s);
  }
  const blocks = pf.blocks.filter((b) => reachable.has(b.id));
  for (const b of blocks) b.preds = b.preds.filter((p) => reachable.has(p));

  // --- 1. reverse postorder + dominators ---
  const rpo = reversePostorder(pf.entry, byId, reachable);
  const rpoIndex = new Map<number, number>();
  rpo.forEach((id, i) => rpoIndex.set(id, i));
  const idom = dominators(pf.entry, blocks, rpo, rpoIndex);

  // dominator-tree children
  const domChildren = new Map<number, number[]>();
  for (const b of blocks) domChildren.set(b.id, []);
  for (const b of blocks) {
    if (b.id === pf.entry) continue;
    const d = idom.get(b.id);
    if (d !== undefined) domChildren.get(d)!.push(b.id);
  }

  // --- 2. dominance frontiers ---
  const df = dominanceFrontiers(blocks, idom);

  // --- 3. phi insertion ---
  const defsites = new Map<string, Set<number>>();
  const addDef = (v: string, blk: number) => {
    let s = defsites.get(v);
    if (!s) defsites.set(v, (s = new Set()));
    s.add(blk);
  };
  for (const p of pf.params) addDef(p.name, pf.entry);
  for (const b of blocks) for (const inst of b.insts) if (inst.dest) addDef(inst.dest, b.id);

  const phisByBlock = new Map<number, WorkPhi[]>();
  for (const b of blocks) phisByBlock.set(b.id, []);
  for (const [v, sites] of defsites) {
    if (sites.size < 2) continue; // single-definition variables are already SSA
    const ty = pf.varType.get(v)!;
    const worklist = [...sites];
    const everInserted = new Set<number>();
    const everWork = new Set<number>(sites);
    while (worklist.length) {
      const x = worklist.pop()!;
      for (const y of df.get(x) ?? []) {
        if (everInserted.has(y)) continue;
        everInserted.add(y);
        phisByBlock.get(y)!.push({ varName: v, res: -1, ty, incomings: new Map() });
        if (!everWork.has(y)) {
          everWork.add(y);
          worklist.push(y);
        }
      }
    }
  }

  // --- 4. rename ---
  const valueType = new Map<number, IRType>();
  let nextId = pf.params.length;
  pf.params.forEach((p, i) => valueType.set(i, p.ty));
  const stacks = new Map<string, number[]>();
  pf.params.forEach((p, i) => stacks.set(p.name, [i]));

  const fresh = (ty: IRType): number => {
    const id = nextId++;
    valueType.set(id, ty);
    return id;
  };
  const top = (v: string): number | undefined => {
    const s = stacks.get(v);
    return s && s.length ? s[s.length - 1] : undefined;
  };
  const reaching = (v: string): Operand => {
    const id = top(v);
    if (id !== undefined) return { tag: 'val', id };
    return { tag: 'const', ty: pf.varType.get(v) ?? 'i32', num: 0 };
  };
  const resolve = (o: POperand): Operand =>
    o.tag === 'const' ? { tag: 'const', ty: o.ty, num: o.num } : reaching(o.name);

  // resulting per-block instruction lists
  const renamedInsts = new Map<number, Inst[]>();
  const renamedTerm = new Map<number, Term>();

  const renameBlock = (id: number): void => {
    const b = byId.get(id)!;
    const pushed: string[] = [];
    const push = (v: string, valId: number) => {
      let s = stacks.get(v);
      if (!s) stacks.set(v, (s = []));
      s.push(valId);
      pushed.push(v);
    };

    for (const phi of phisByBlock.get(id)!) {
      phi.res = fresh(phi.ty);
      push(phi.varName, phi.res);
    }

    const out: Inst[] = [];
    for (const inst of b.insts) {
      const args = inst.args.map(resolve);
      let res: number | null = null;
      if (inst.dest !== null) {
        res = fresh(inst.ty as IRType);
        push(inst.dest, res);
      }
      out.push({ res, ty: inst.ty, kind: inst.kind, sub: inst.sub, args });
    }
    renamedInsts.set(id, out);

    const t = b.term!;
    let term: Term;
    if (t.op === 'condbr') term = { op: 'condbr', cond: resolve(t.cond), t: t.t, f: t.f };
    else if (t.op === 'ret') term = { op: 'ret', value: t.value ? resolve(t.value) : null };
    else if (t.op === 'br') term = { op: 'br', target: t.target };
    else term = { op: 'unreachable' };
    renamedTerm.set(id, term);

    for (const s of succOf(b)) {
      for (const phi of phisByBlock.get(s) ?? []) phi.incomings.set(id, reaching(phi.varName));
    }

    for (const c of domChildren.get(id) ?? []) renameBlock(c);
    for (const v of pushed) stacks.get(v)!.pop();
  };
  renameBlock(pf.entry);

  // --- assemble the SSA function, blocks in reverse-postorder ---
  const outBlocks: Block[] = rpo.map((id) => {
    const b = byId.get(id)!;
    const phis: Phi[] = phisByBlock.get(id)!.map((wp) => ({
      res: wp.res,
      ty: wp.ty,
      incomings: b.preds.map((pred) => ({ pred, val: wp.incomings.get(pred) ?? { tag: 'const', ty: wp.ty, num: 0 } })),
    }));
    return { id, phis, insts: renamedInsts.get(id)!, term: renamedTerm.get(id)!, preds: b.preds };
  });

  return {
    name: pf.name,
    params: pf.params,
    retTy: pf.retTy,
    blocks: outBlocks,
    entry: pf.entry,
    valueType,
    exported: pf.exported,
  };
}

function reversePostorder(entry: number, byId: Map<number, PBlock>, reachable: Set<number>): number[] {
  const post: number[] = [];
  const seen = new Set<number>();
  const visit = (id: number): void => {
    if (seen.has(id) || !reachable.has(id)) return;
    seen.add(id);
    for (const s of succOf(byId.get(id)!)) visit(s);
    post.push(id);
  };
  visit(entry);
  return post.reverse();
}

function dominators(
  entry: number,
  blocks: PBlock[],
  rpo: number[],
  rpoIndex: Map<number, number>,
): Map<number, number> {
  const idom = new Map<number, number>();
  idom.set(entry, entry);
  const intersect = (a: number, b: number): number => {
    while (a !== b) {
      while ((rpoIndex.get(a) ?? 0) > (rpoIndex.get(b) ?? 0)) a = idom.get(a)!;
      while ((rpoIndex.get(b) ?? 0) > (rpoIndex.get(a) ?? 0)) b = idom.get(b)!;
    }
    return a;
  };
  const predMap = new Map(blocks.map((b) => [b.id, b.preds]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of rpo) {
      if (id === entry) continue;
      let newIdom: number | undefined;
      for (const p of predMap.get(id) ?? []) {
        if (idom.has(p)) newIdom = newIdom === undefined ? p : intersect(p, newIdom);
      }
      if (newIdom !== undefined && idom.get(id) !== newIdom) {
        idom.set(id, newIdom);
        changed = true;
      }
    }
  }
  idom.delete(entry); // entry has no immediate dominator
  return idom;
}

function dominanceFrontiers(blocks: PBlock[], idom: Map<number, number>): Map<number, Set<number>> {
  const df = new Map<number, Set<number>>();
  for (const b of blocks) df.set(b.id, new Set());
  for (const b of blocks) {
    if (b.preds.length < 2) continue;
    const dpost = idom.get(b.id);
    for (const p of b.preds) {
      let runner: number | undefined = p;
      while (runner !== undefined && runner !== dpost) {
        df.get(runner)!.add(b.id);
        runner = idom.get(runner);
      }
    }
  }
  return df;
}

// Exposed for the dominator-tree / dominance-frontier visualizations in the UI.
export function analyzeCFG(pf: PFunc): {
  rpo: number[];
  idom: Map<number, number>;
  df: Map<number, Set<number>>;
} {
  const byId = new Map(pf.blocks.map((b) => [b.id, b]));
  const reachable = new Set<number>();
  const stack = [pf.entry];
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const s of succOf(byId.get(id)!)) stack.push(s);
  }
  const blocks = pf.blocks.filter((b) => reachable.has(b.id));
  for (const b of blocks) b.preds = b.preds.filter((p) => reachable.has(p));
  const rpo = reversePostorder(pf.entry, byId, reachable);
  const rpoIndex = new Map<number, number>();
  rpo.forEach((id, i) => rpoIndex.set(id, i));
  const idom = dominators(pf.entry, blocks, rpo, rpoIndex);
  const df = dominanceFrontiers(blocks, idom);
  return { rpo, idom, df };
}
