// Best-effort induction-variable & loop analysis for the UI's Loops panel. It
// classifies every natural loop of a function the same way the loop optimizers
// see it — a *counted* loop (a header phi `i = [init, i ± c]` tested against a
// loop-invariant bound), the *strided main loop* the partial unroller leaves
// behind (its exit test is the AND-chain "K more iterations?" guard), or a
// *general* loop — and surfaces the induction variable, step, bound and (when
// statically knowable) trip count. It is purely descriptive: it never mutates
// the IR and never throws, so the panel can render whatever the optimizer
// produced at any -O level.
import type { Block, IRFunc, Operand, Phi } from './ir/ir';
import { computeDom } from './ir/cfg';
import { findNaturalLoops } from './ir/loops';

export type LoopKind = 'counted' | 'strided-main' | 'general';

export interface LoopFact {
  header: number;
  depth: number;
  parent: number | null;
  latches: number;
  bodyBlocks: number;
  bodyInsts: number;
  kind: LoopKind;
  /** Induction variable, e.g. `v12:i32` (counted loops only). */
  iv?: string;
  init?: string;
  step?: string;
  bound?: string;
  /** The exit predicate, rendered as `i < n` etc. */
  pred?: string;
  /** A statically-known trip count, or undefined when it depends on runtime. */
  trip?: number;
}

const PRED_SYM: Record<string, string> = {
  eq: '==', ne: '!=', lt_s: '<', le_s: '<=', gt_s: '>', ge_s: '>=',
};

function opStr(o: Operand): string {
  return o.tag === 'const' ? String(o.num) : `v${o.id}`;
}

export function analyzeLoops(fn: IRFunc): LoopFact[] {
  let loops;
  try {
    loops = findNaturalLoops(fn, computeDom(fn));
  } catch {
    return [];
  }
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const facts: LoopFact[] = [];

  for (const loop of loops) {
    let bodyInsts = 0;
    for (const bid of loop.body) bodyInsts += byId.get(bid)?.insts.length ?? 0;
    const fact: LoopFact = {
      header: loop.header,
      depth: loop.depth,
      parent: loop.parent,
      latches: loop.latches.length,
      bodyBlocks: loop.body.size,
      bodyInsts,
      kind: 'general',
    };
    classify(loop.header, loop.latches, loop.body, byId, fact);
    facts.push(fact);
  }
  // Outer loops first, then by header id, so nesting reads top-down.
  facts.sort((a, b) => a.depth - b.depth || a.header - b.header);
  return facts;
}

function classify(
  headerId: number,
  latches: number[],
  body: Set<number>,
  byId: Map<number, Block>,
  fact: LoopFact,
): void {
  const H = byId.get(headerId);
  if (!H || H.term.op !== 'condbr' || H.term.cond.tag !== 'val') return;
  const condId = H.term.cond.id;
  const def = H.insts.find((i) => i.res === condId);
  if (!def) return;

  // The partial unroller's strided main loop: its exit test is an AND of several
  // shifted predicates, so the condition is produced by an `and`.
  if (def.kind === 'ibin' && def.sub === 'and') {
    fact.kind = 'strided-main';
    return;
  }
  if (def.kind !== 'icmp') return;

  // A counted loop: one operand is a header phi `i = [init, i ± c]`, the other a
  // loop-invariant bound.
  const headerPhiByRes = new Map(H.phis.map((p) => [p.res, p]));
  const asPhi = (o: Operand): Phi | undefined => (o.tag === 'val' ? headerPhiByRes.get(o.id) : undefined);
  const [a, b] = def.args;
  const phiA = asPhi(a);
  const phiB = asPhi(b);
  let iv: Phi;
  let ivIsA: boolean;
  let bound: Operand;
  if (phiA && !phiB) {
    iv = phiA; ivIsA = true; bound = b;
  } else if (phiB && !phiA) {
    iv = phiB; ivIsA = false; bound = a;
  } else {
    return;
  }
  if (iv.ty !== 'i32' && iv.ty !== 'i64') return;

  const latchId = latches.length === 1 ? latches[0] : null;
  const initInc = iv.incomings.find((x) => !body.has(x.pred));
  const latchInc = latchId !== null ? iv.incomings.find((x) => x.pred === latchId) : undefined;
  if (!initInc) return;

  // Recover the step from the latch update `i ± c`.
  let step: string | undefined;
  if (latchInc && latchInc.val.tag === 'val') {
    const stepInst = findDef(byId, body, latchInc.val.id);
    if (stepInst && stepInst.kind === 'ibin') {
      const [sa, sb] = stepInst.args;
      const isIv = (o: Operand): boolean => o.tag === 'val' && o.id === iv.res;
      if (stepInst.sub === 'add' && isIv(sa) && sb.tag === 'const') step = `+${sb.num}`;
      else if (stepInst.sub === 'add' && isIv(sb) && sa.tag === 'const') step = `+${sa.num}`;
      else if (stepInst.sub === 'sub' && isIv(sa) && sb.tag === 'const') step = `-${sb.num}`;
    }
  }

  fact.kind = 'counted';
  fact.iv = `v${iv.res}:${iv.ty}`;
  fact.init = initInc.val.tag === 'const' ? String(initInc.val.num) : `v${(initInc.val as { id: number }).id}`;
  fact.step = step;
  fact.bound = bound.tag === 'const' ? String(bound.num) : `runtime v${bound.id}`;
  const sym = PRED_SYM[def.sub] ?? def.sub;
  fact.pred = ivIsA ? `i ${sym} ${opStr(bound)}` : `${opStr(bound)} ${sym} i`;

  // A static trip count is available only when init, bound and step are all
  // constant; otherwise it depends on runtime values.
  if (initInc.val.tag === 'const' && bound.tag === 'const' && step) {
    const trueIsBody = H.term.op === 'condbr' && body.has(H.term.t);
    const trip = simulateTrip(iv.ty, def.sub, ivIsA, initInc.val.num, bound.num, step, trueIsBody);
    if (trip !== null) fact.trip = trip;
  }
}

function simulateTrip(
  ty: 'i32' | 'i64',
  pred: string,
  ivIsA: boolean,
  init: number | bigint,
  bound: number | bigint,
  stepStr: string,
  trueIsBody: boolean,
): number | null {
  const stepN = ty === 'i64' ? BigInt(stepStr) : Number(stepStr) | 0;
  const cmp = (x: number | bigint, y: number | bigint): boolean => {
    switch (pred) {
      case 'eq': return x === y;
      case 'ne': return x !== y;
      case 'lt_s': return x < y;
      case 'le_s': return x <= y;
      case 'gt_s': return x > y;
      case 'ge_s': return x >= y;
      default: return false;
    }
  };
  let t = 0;
  if (ty === 'i64') {
    let i = BigInt.asIntN(64, init as bigint);
    const bnd = BigInt.asIntN(64, bound as bigint);
    const stp = BigInt.asIntN(64, stepN as bigint);
    for (;;) {
      const c = ivIsA ? cmp(i, bnd) : cmp(bnd, i);
      if (!(trueIsBody ? c : !c)) return t;
      if (++t > 100000) return null;
      i = BigInt.asIntN(64, i + stp);
    }
  }
  let i = (init as number) | 0;
  const bnd = (bound as number) | 0;
  const stp = (stepN as number) | 0;
  for (;;) {
    const c = ivIsA ? cmp(i, bnd) : cmp(bnd, i);
    if (!(trueIsBody ? c : !c)) return t;
    if (++t > 100000) return null;
    i = (i + stp) | 0;
  }
}

function findDef(byId: Map<number, Block>, body: Set<number>, res: number) {
  for (const bid of body) {
    const b = byId.get(bid);
    if (!b) continue;
    for (const ins of b.insts) if (ins.res === res) return ins;
  }
  return null;
}
