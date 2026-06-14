import type { IRFunc, Term } from './ir';

// Shared control-flow analysis over an SSA function: reverse postorder, the
// dominator tree (Cooper–Harvey–Kennedy), and dominator-tree children.

export interface DomInfo {
  rpo: number[];
  rpoIndex: Map<number, number>;
  idom: Map<number, number>;
  domChildren: Map<number, number[]>;
}

export function succOfTerm(t: Term): number[] {
  if (t.op === 'br') return [t.target];
  if (t.op === 'condbr') return t.t === t.f ? [t.t] : [t.t, t.f];
  return [];
}

export function computeDom(fn: IRFunc): DomInfo {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const rpo: number[] = [];
  const seen = new Set<number>();
  const visit = (id: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const s of succOfTerm(byId.get(id)!.term)) visit(s);
    rpo.push(id);
  };
  visit(fn.entry);
  rpo.reverse();
  const rpoIndex = new Map<number, number>();
  rpo.forEach((id, i) => rpoIndex.set(id, i));

  const idom = new Map<number, number>();
  idom.set(fn.entry, fn.entry);
  const intersect = (a: number, b: number): number => {
    while (a !== b) {
      while ((rpoIndex.get(a) ?? 0) > (rpoIndex.get(b) ?? 0)) a = idom.get(a)!;
      while ((rpoIndex.get(b) ?? 0) > (rpoIndex.get(a) ?? 0)) b = idom.get(b)!;
    }
    return a;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of rpo) {
      if (id === fn.entry) continue;
      let nd: number | undefined;
      for (const p of byId.get(id)!.preds) {
        if (rpoIndex.has(p) && idom.has(p)) nd = nd === undefined ? p : intersect(p, nd);
      }
      if (nd !== undefined && idom.get(id) !== nd) {
        idom.set(id, nd);
        changed = true;
      }
    }
  }

  const domChildren = new Map<number, number[]>();
  for (const id of rpo) domChildren.set(id, []);
  for (const id of rpo) {
    if (id === fn.entry) continue;
    const d = idom.get(id);
    if (d !== undefined && d !== id) domChildren.get(d)!.push(id);
  }
  return { rpo, rpoIndex, idom, domChildren };
}
