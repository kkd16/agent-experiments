import type { Block, Inst, IRFunc, IRType, Operand, Phi, Term } from '../ir/ir';
import { eachOperand, hasSideEffect } from '../ir/ir';
import { computeDom, succOfTerm } from '../ir/cfg';
import { findNaturalLoops, isInnermost } from '../ir/loops';
import type { NaturalLoop } from '../ir/loops';

// Full loop unrolling for *counted* loops. A counted loop has a basic induction
// variable (a header phi `i = [init, i ± c]` with a constant step) tested against
// a loop-invariant constant bound. When that makes the trip count a known small
// constant `T`, the loop is replaced by `T` straight-line clones of its body —
// the back edge and the (now statically-decided) exit test disappear, and SSA is
// threaded across iterations so each iteration's header-phi value is the previous
// iteration's latch value.
//
// Soundness is by precondition: the transform inspects the loop and only fires
// when a short list of structural facts holds (one latch, a two-predecessor
// header, a single exit, live-outs limited to header phis, an innermost loop with
// a provable constant trip count). When anything is uncertain it declines and
// leaves the IR untouched, so a bug can only ever miss an opportunity — the
// differential oracle (interpreter == wasm) proves it never changes behaviour.

const UNROLL_LIMIT = 64; // largest trip count we will fully unroll
const SMALL_TRIP = 8; // a side-effecting loop unrolls only up to this many iterations
const MAX_GROWTH = 1500; // cap on total cloned instructions per loop

export function unrollLoops(fn: IRFunc): number {
  let changed = 0;
  // One loop per step (the CFG changes under us); re-discover after each. The cap
  // bounds work on pathological inputs — real programs have very few loops.
  for (let i = 0; i < 64; i++) {
    if (!unrollOne(fn)) break;
    changed++;
  }
  return changed;
}

function unrollOne(fn: IRFunc): boolean {
  recomputePreds(fn);
  const dom = computeDom(fn);
  const loops = findNaturalLoops(fn, dom);
  // Innermost first: unrolling an inner loop is what later enables an outer one.
  for (const loop of loops) {
    if (!isInnermost(loop, loops)) continue;
    if (tryUnroll(fn, loop)) return true;
  }
  return false;
}

const clone = (o: Operand): Operand => (o.tag === 'const' ? { tag: 'const', ty: o.ty, num: o.num } : { tag: 'val', id: o.id });

function tryUnroll(fn: IRFunc, loop: NaturalLoop): boolean {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const body = loop.body;
  const H = byId.get(loop.header);
  if (!H) return false;

  // --- structural preconditions ----------------------------------------
  if (loop.latches.length !== 1) return false;
  const latchId = loop.latches[0];
  if (latchId === H.id) return false; // a header that is its own latch — keep it simple

  const outsidePreds = H.preds.filter((p) => !body.has(p));
  const insidePreds = H.preds.filter((p) => body.has(p));
  if (outsidePreds.length !== 1) return false; // need a single preheader edge
  if (insidePreds.length !== 1 || insidePreds[0] !== latchId) return false;
  const PH = outsidePreds[0];

  if (H.term.op !== 'condbr' || H.term.t === H.term.f) return false;
  const tT = H.term.t;
  const fT = H.term.f;
  let bodyEntry: number;
  let exitTarget: number;
  if (body.has(tT) && !body.has(fT)) {
    bodyEntry = tT;
    exitTarget = fT;
  } else if (body.has(fT) && !body.has(tT)) {
    bodyEntry = fT;
    exitTarget = tT;
  } else {
    return false;
  }
  if (bodyEntry === H.id) return false; // no header self-loop

  // Single entry: every non-header body block is reached only from within.
  // Single exit: the header test is the only edge leaving the loop.
  for (const bid of body) {
    const b = byId.get(bid)!;
    if (bid !== H.id) {
      for (const p of b.preds) if (!body.has(p)) return false;
      for (const s of succOfTerm(b.term)) if (!body.has(s)) return false;
    }
  }

  // --- induction-variable & trip-count analysis ------------------------
  if (H.term.cond.tag !== 'val') return false;
  const condId = H.term.cond.id;
  const icmp = H.insts.find((i) => i.res === condId);
  if (!icmp || icmp.kind !== 'icmp') return false;

  const headerPhiByRes = new Map(H.phis.map((p) => [p.res, p]));
  const asPhi = (o: Operand): Phi | undefined => (o.tag === 'val' ? headerPhiByRes.get(o.id) : undefined);
  const [cmpA, cmpB] = icmp.args;
  const phiA = asPhi(cmpA);
  const phiB = asPhi(cmpB);
  let ivPhi: Phi;
  let ivIsA: boolean;
  let boundOp: Operand;
  if (phiA && cmpB.tag === 'const') {
    ivPhi = phiA;
    ivIsA = true;
    boundOp = cmpB;
  } else if (phiB && cmpA.tag === 'const') {
    ivPhi = phiB;
    ivIsA = false;
    boundOp = cmpA;
  } else {
    return false;
  }

  const ty = ivPhi.ty;
  if (ty !== 'i32' && ty !== 'i64') return false;

  const initInc = ivPhi.incomings.find((x) => x.pred === PH);
  const latchInc = ivPhi.incomings.find((x) => x.pred === latchId);
  if (!initInc || !latchInc) return false;
  if (initInc.val.tag !== 'const') return false;

  // The step: the latch value of the IV must be `i + c` or `i - c` with `c` const.
  if (latchInc.val.tag !== 'val') return false;
  const stepInst = findInst(byId, body, latchInc.val.id);
  if (!stepInst || stepInst.kind !== 'ibin') return false;
  const isIv = (o: Operand): boolean => o.tag === 'val' && o.id === ivPhi.res;
  const [sa, sb] = stepInst.args;
  let step: number | bigint;
  if (stepInst.sub === 'add' && isIv(sa) && sb.tag === 'const') step = sb.num;
  else if (stepInst.sub === 'add' && isIv(sb) && sa.tag === 'const') step = sa.num;
  else if (stepInst.sub === 'sub' && isIv(sa) && sb.tag === 'const') step = negate(sb.num, ty);
  else return false;

  // Simulate the counter with the exact i32/i64 wrapping + `icmp` semantics the
  // interpreter and wasm use — no closed form, so signed corner cases can't bite.
  const trueIsBody = bodyEntry === H.term.t;
  const T = simulateTripCount(ty, icmp.sub, ivIsA, initInc.val.num, boundOp.num, step, trueIsBody);
  if (T === null) return false; // didn't converge within the unroll limit

  // --- live-out restriction: only header phis may escape the loop ------
  const bodyDefs = new Set<number>();
  for (const bid of body) {
    const b = byId.get(bid)!;
    for (const p of b.phis) bodyDefs.add(p.res);
    for (const ins of b.insts) if (ins.res !== null) bodyDefs.add(ins.res);
  }
  const headerPhiRes = new Set(H.phis.map((p) => p.res));
  let escapes = false;
  for (const b of fn.blocks) {
    if (body.has(b.id)) continue;
    eachOperand(b, (o) => {
      if (o.tag === 'val' && bodyDefs.has(o.id) && !headerPhiRes.has(o.id)) escapes = true;
    });
  }
  if (escapes) return false;

  // --- cost model ------------------------------------------------------
  let bodyInsts = 0;
  let pure = true;
  for (const bid of body) {
    const b = byId.get(bid)!;
    bodyInsts += b.insts.length;
    for (const ins of b.insts) if (hasSideEffect(ins)) pure = false;
  }
  if (T > 0) {
    if (!pure && T > SMALL_TRIP) return false;
    if (T * bodyInsts > MAX_GROWTH) return false;
  }

  // ====================================================================
  // Transform.
  // ====================================================================
  const exit = byId.get(exitTarget)!;
  const ph = byId.get(PH)!;

  if (T === 0) {
    // The loop never runs: jump the preheader straight to the exit and feed every
    // live-out header phi its initial (preheader) value.
    ph.term = redirectTerm(ph.term, H.id, exitTarget);
    const initOf = (res: number): Operand => clone(headerPhiByRes.get(res)!.incomings.find((x) => x.pred === PH)!.val);
    for (const ophi of exit.phis) {
      for (const inc of ophi.incomings) {
        if (inc.pred !== H.id) continue;
        inc.pred = PH;
        if (inc.val.tag === 'val' && headerPhiRes.has(inc.val.id)) inc.val = initOf(inc.val.id);
      }
    }
    for (const hp of H.phis) {
      const init = clone(hp.incomings.find((x) => x.pred === PH)!.val);
      replaceOutsideUses(fn, body, hp.res, () => clone(init));
    }
    fn.blocks = fn.blocks.filter((b) => !body.has(b.id));
    recomputePreds(fn);
    return true;
  }

  // Allocate fresh block + value ids per iteration.
  let nextBlock = maxBlockId(fn) + 1;
  let nextVal = maxValueId(fn) + 1;
  const valMaps: Map<number, Operand>[] = [];
  const blockMaps: Map<number, number>[] = [];

  for (let k = 0; k < T; k++) {
    const blockMap = new Map<number, number>();
    for (const bid of body) blockMap.set(bid, nextBlock++);
    const valMap = new Map<number, Operand>();
    // Header phis become concrete operands: iteration 0 takes the preheader init;
    // later iterations take the previous iteration's latch value.
    for (const hp of H.phis) {
      const src = k === 0 ? clone(hp.incomings.find((x) => x.pred === PH)!.val) : remap(valMaps[k - 1], hp.incomings.find((x) => x.pred === latchId)!.val);
      valMap.set(hp.res, src);
    }
    for (const bid of body) {
      const b = byId.get(bid)!;
      if (bid !== H.id) for (const p of b.phis) valMap.set(p.res, freshVal(fn, nextVal++, p.ty));
      for (const ins of b.insts) if (ins.res !== null) valMap.set(ins.res, freshVal(fn, nextVal++, ins.ty as IRType));
    }
    valMaps.push(valMap);
    blockMaps.push(blockMap);
  }

  const newBlocks: Block[] = [];
  for (let k = 0; k < T; k++) {
    const valMap = valMaps[k];
    const blockMap = blockMaps[k];
    const mapTarget = (s: number): number => (s === H.id ? (k < T - 1 ? blockMaps[k + 1].get(H.id)! : exitTarget) : blockMap.get(s)!);
    for (const bid of body) {
      const ob = byId.get(bid)!;
      const nb: Block = { id: blockMap.get(bid)!, phis: [], insts: [], term: { op: 'unreachable' }, preds: [] };
      if (bid !== H.id) {
        for (const p of ob.phis) {
          nb.phis.push({
            res: (valMap.get(p.res) as { tag: 'val'; id: number }).id,
            ty: p.ty,
            incomings: p.incomings.map((inc) => ({ pred: blockMap.get(inc.pred) ?? inc.pred, val: remap(valMap, inc.val) })),
          });
        }
      }
      for (const ins of ob.insts) {
        const res = ins.res === null ? null : (valMap.get(ins.res) as { tag: 'val'; id: number }).id;
        nb.insts.push({ res, ty: ins.ty, kind: ins.kind, sub: ins.sub, args: ins.args.map((a) => remap(valMap, a)) });
      }
      nb.term = bid === H.id ? { op: 'br', target: blockMap.get(bodyEntry)! } : mapTerm(ob.term, mapTarget, valMap);
      newBlocks.push(nb);
    }
  }

  // The final iteration's latch value of each header phi is its loop-exit value.
  const finalOf = (res: number): Operand => remap(valMaps[T - 1], headerPhiByRes.get(res)!.incomings.find((x) => x.pred === latchId)!.val);

  // Wire the preheader into iteration 0, and the exit's incoming edge to come from
  // the last latch clone with the final live-out values.
  ph.term = redirectTerm(ph.term, H.id, blockMaps[0].get(H.id)!);
  const lastLatch = blockMaps[T - 1].get(latchId)!;
  for (const ophi of exit.phis) {
    for (const inc of ophi.incomings) {
      if (inc.pred !== H.id) continue;
      inc.pred = lastLatch;
      if (inc.val.tag === 'val' && headerPhiRes.has(inc.val.id)) inc.val = finalOf(inc.val.id);
    }
  }
  // Any remaining direct uses of a header phi after the loop get its final value.
  for (const hp of H.phis) replaceOutsideUses(fn, body, hp.res, () => finalOf(hp.res));

  fn.blocks = fn.blocks.filter((b) => !body.has(b.id));
  fn.blocks.push(...newBlocks);
  recomputePreds(fn);
  return true;
}

// --- helpers ---------------------------------------------------------------

function remap(valMap: Map<number, Operand>, op: Operand): Operand {
  if (op.tag === 'const') return clone(op);
  const m = valMap.get(op.id);
  return m ? clone(m) : clone(op);
}

function freshVal(fn: IRFunc, id: number, ty: IRType): Operand {
  fn.valueType.set(id, ty);
  return { tag: 'val', id };
}

function mapTerm(t: Term, mapTarget: (s: number) => number, valMap: Map<number, Operand>): Term {
  if (t.op === 'br') return { op: 'br', target: mapTarget(t.target) };
  if (t.op === 'condbr') return { op: 'condbr', cond: remap(valMap, t.cond), t: mapTarget(t.t), f: mapTarget(t.f) };
  if (t.op === 'ret') return { op: 'ret', value: t.value ? remap(valMap, t.value) : null };
  return { op: 'unreachable' };
}

function findInst(byId: Map<number, Block>, body: Set<number>, res: number): Inst | null {
  for (const bid of body) {
    const b = byId.get(bid)!;
    for (const ins of b.insts) if (ins.res === res) return ins;
  }
  return null;
}

function negate(n: number | bigint, ty: IRType): number | bigint {
  return ty === 'i64' ? BigInt.asIntN(64, -(n as bigint)) : (-(n as number)) | 0;
}

function evalICmp(sub: string, a: number, b: number): boolean {
  switch (sub) {
    case 'eq': return a === b;
    case 'ne': return a !== b;
    case 'lt_s': return a < b;
    case 'le_s': return a <= b;
    case 'gt_s': return a > b;
    case 'ge_s': return a >= b;
    default: return false;
  }
}
function evalICmp64(sub: string, a: bigint, b: bigint): boolean {
  switch (sub) {
    case 'eq': return a === b;
    case 'ne': return a !== b;
    case 'lt_s': return a < b;
    case 'le_s': return a <= b;
    case 'gt_s': return a > b;
    case 'ge_s': return a >= b;
    default: return false;
  }
}

/** The exact number of body executions, or null if it exceeds the unroll limit. */
function simulateTripCount(
  ty: IRType,
  pred: string,
  ivIsA: boolean,
  init: number | bigint,
  bound: number | bigint,
  step: number | bigint,
  trueIsBody: boolean,
): number | null {
  let t = 0;
  if (ty === 'i64') {
    let i = BigInt.asIntN(64, init as bigint);
    const bnd = BigInt.asIntN(64, bound as bigint);
    const stp = BigInt.asIntN(64, step as bigint);
    for (;;) {
      const cond = ivIsA ? evalICmp64(pred, i, bnd) : evalICmp64(pred, bnd, i);
      const routeBody = trueIsBody ? cond : !cond;
      if (!routeBody) return t;
      if (++t > UNROLL_LIMIT) return null;
      i = BigInt.asIntN(64, i + stp);
    }
  }
  let i = (init as number) | 0;
  const bnd = (bound as number) | 0;
  const stp = (step as number) | 0;
  for (;;) {
    const cond = ivIsA ? evalICmp(pred, i, bnd) : evalICmp(pred, bnd, i);
    const routeBody = trueIsBody ? cond : !cond;
    if (!routeBody) return t;
    if (++t > UNROLL_LIMIT) return null;
    i = (i + stp) | 0;
  }
}

function redirectTerm(t: Term, from: number, to: number): Term {
  if (t.op === 'br') return t.target === from ? { op: 'br', target: to } : t;
  if (t.op === 'condbr') return { op: 'condbr', cond: t.cond, t: t.t === from ? to : t.t, f: t.f === from ? to : t.f };
  return t;
}

function replaceOutsideUses(fn: IRFunc, body: Set<number>, fromId: number, mk: () => Operand): void {
  for (const b of fn.blocks) {
    if (body.has(b.id)) continue;
    eachOperand(b, (o, set) => {
      if (o.tag === 'val' && o.id === fromId) set(mk());
    });
  }
}

function recomputePreds(fn: IRFunc): void {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  for (const b of fn.blocks) b.preds = [];
  for (const b of fn.blocks) for (const s of succOfTerm(b.term)) byId.get(s)?.preds.push(b.id);
}

function maxBlockId(fn: IRFunc): number {
  let m = 0;
  for (const b of fn.blocks) if (b.id > m) m = b.id;
  return m;
}
function maxValueId(fn: IRFunc): number {
  let m = -1;
  for (const k of fn.valueType.keys()) if (k > m) m = k;
  for (const b of fn.blocks) {
    for (const p of b.phis) if (p.res > m) m = p.res;
    for (const i of b.insts) if (i.res !== null && i.res > m) m = i.res;
  }
  return m;
}
