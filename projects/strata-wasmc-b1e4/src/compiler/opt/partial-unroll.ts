import type { Block, Inst, IRFunc, IRType, Operand, Phi, Term } from '../ir/ir';
import { computeDom, succOfTerm } from '../ir/cfg';
import { findNaturalLoops, isInnermost } from '../ir/loops';
import type { NaturalLoop } from '../ir/loops';

// =====================================================================
// Partial loop unrolling (unroll-by-K with a remainder loop)
// =====================================================================
//
// The full unroller (`unroll.ts`) replaces a counted loop by straight-line clones
// — but only when the trip count is a *known small constant*. The common, hot
// case is a loop whose bound is a **runtime value** (`for i in 0..n`) or simply
// too large to peel away. Partial unrolling is the classic answer: run the body
// `K` times per back edge, so K−1 of every K back edges (and their loop-carried
// dependence stalls) vanish, and the K body copies sit contiguously where the
// rest of the optimizer — GVN, LICM, OSR, scheduling — can work across them.
//
// The transform splits the iteration space into a **main loop** that strides by
// `K` and a **remainder loop** that mops up the final `< K` iterations:
//
//      preheader                          preheader
//          │                                  │
//          ▼                                  ▼
//     ┌──[header]──┐        ──►          ┌──[main hdr]── guard: K more? ─┐
//     │   body     │                     │  body ×K (no internal test)  │ no
//     └────────────┘                     └──────────────┬───────────────┘
//                                                        ▼
//                                              ┌──[header (remainder)]──┐
//                                              │   the original loop    │
//                                              └────────────────────────┘
//
// Crucially the **remainder loop is the original loop, reused untouched** — we
// only ever *prepend* a strided main loop. So every loop-exit value, exit-block
// phi and live-out is computed by the unchanged original machinery: partial
// unrolling can never disturb them. That makes it strictly safer than full
// unrolling (which must delete the loop and rebuild its live-outs).
//
// The main loop's "K more?" guard is **exact and overflow-blind**: it evaluates
// the real loop predicate at `i, i+c, … , i+(K−1)c` with the same wrapping i32/
// i64 arithmetic and signed `icmp` the program uses, and enters the K-wide body
// only when *all* of them say "iterate". No closed-form trip-count and no
// no-overflow assumption is made, so the rewrite is an exact identity on every
// counted-loop shape (any predicate, any step sign, wrapping included). When a
// precondition is unmet the pass declines and leaves the IR untouched, so a bug
// can only ever miss an opportunity — the differential oracle (interpreter ==
// wasm == VM, at every -O level) proves it never changes behaviour.

/** Don't unroll if the K copies would exceed this many instructions. */
const MAX_GROWTH = 800;
/** A constant trip count this small is the *full* unroller's job — defer to it. */
const FULL_UNROLL_LIMIT = 64;

/** Pick the unroll factor from the body size: a tiny body wants a wide stride
 *  (more back edges removed per copy), a fat one a narrow stride (so the K copies
 *  stay within the growth budget and the guard's K compares don't dominate). */
function chooseK(bodyInsts: number): number {
  if (bodyInsts <= 4) return 8;
  if (bodyInsts <= 12) return 4;
  return 2;
}

export function partialUnroll(fn: IRFunc): number {
  // Headers we have already strided: the remainder reuses the original header id,
  // so without this we would re-stride the remainder every round and blow up.
  const done = new Set<number>();
  let changed = 0;
  for (let i = 0; i < 64; i++) {
    recomputePreds(fn);
    const dom = computeDom(fn);
    const loops = findNaturalLoops(fn, dom);
    let did = false;
    // Innermost first, exactly like the full unroller — striding an inner loop is
    // what can later expose an outer one.
    for (const loop of loops) {
      if (!isInnermost(loop, loops)) continue;
      if (done.has(loop.header)) continue;
      if (tryPartial(fn, loop, done)) {
        did = true;
        changed++;
        break;
      }
    }
    if (!did) break;
  }
  return changed;
}

const clone = (o: Operand): Operand => (o.tag === 'const' ? { tag: 'const', ty: o.ty, num: o.num } : { tag: 'val', id: o.id });

interface Recognized {
  H: Block;
  PH: number;
  latchId: number;
  bodyEntry: number;
  ivPhi: Phi;
  ivIsA: boolean;
  boundOp: Operand;
  cmpSub: string;
  trueIsBody: boolean;
  step: number | bigint;
  ty: IRType;
}

function tryPartial(fn: IRFunc, loop: NaturalLoop, done: Set<number>): boolean {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const body = loop.body;
  const rec = recognizeCountedLoop(loop, byId);
  if (!rec) return false;
  const { H, PH, latchId, bodyEntry, ivPhi, ivIsA, boundOp, cmpSub, trueIsBody, step, ty } = rec;

  // Decide whether this loop is *ours*: the full unroller owns loops whose trip
  // count is a known, small constant. We take everything else — a runtime bound,
  // or a constant bound whose trip count exceeds the full-unroll limit.
  if (boundOp.tag === 'const') {
    const init = ivInit(ivPhi, PH);
    // Only a fully-constant (init *and* bound) loop has a statically-known trip
    // count; if that count is small the full unroller owns it. A runtime start
    // with a constant bound is still a runtime-trip loop — ours to stride.
    if (init !== null) {
      const T = simulateTripCount(ty, cmpSub, ivIsA, init.num, boundOp.num, step, trueIsBody);
      if (T !== null) return false; // a small known count → leave it to full unrolling
    }
  } else {
    // Runtime bound must be loop-invariant: its definition lies outside the body.
    const defBlk = defBlockOf(fn, boundOp.id);
    if (defBlk === null || body.has(defBlk)) return false;
  }

  // Cost: K straight-line copies of the body must stay within budget. K is
  // adaptive — wide for tiny bodies, narrow for fat ones.
  let bodyInsts = 0;
  for (const bid of body) bodyInsts += byId.get(bid)!.insts.length;
  const KF = chooseK(bodyInsts);
  if (bodyInsts * KF > MAX_GROWTH) return false;

  // ====================================================================
  // Build the strided main loop and splice it ahead of the original (which
  // becomes the remainder loop, reused verbatim).
  // ====================================================================
  let nextBlock = maxBlockId(fn) + 1;
  let nextVal = maxValueId(fn) + 1;
  const MH = nextBlock++; // the main (strided) loop header

  // A fresh phi in the main header for every header phi of the original loop.
  const mainPhiRes = new Map<number, number>();
  for (const hp of H.phis) {
    const id = nextVal++;
    mainPhiRes.set(hp.res, id);
    fn.valueType.set(id, hp.ty);
  }

  // --- clone the body K times -----------------------------------------
  const blockMaps: Map<number, number>[] = [];
  const valMaps: Map<number, Operand>[] = [];
  for (let k = 0; k < KF; k++) {
    const blockMap = new Map<number, number>();
    for (const bid of body) blockMap.set(bid, nextBlock++);
    const valMap = new Map<number, Operand>();
    // Header phis resolve to operands rather than phi nodes in the clones:
    // copy 0 takes the main-header phi value; later copies take the previous
    // copy's latch value (the loop-carried update).
    for (const hp of H.phis) {
      const src = k === 0 ? ({ tag: 'val', id: mainPhiRes.get(hp.res)! } as Operand) : remap(valMaps[k - 1], latchIncoming(hp, latchId).val);
      valMap.set(hp.res, src);
    }
    for (const bid of body) {
      const b = byId.get(bid)!;
      if (bid !== H.id) for (const p of b.phis) valMap.set(p.res, freshVal(fn, nextVal++, p.ty));
      for (const ins of b.insts) if (ins.res !== null) valMap.set(ins.res, freshVal(fn, nextVal++, ins.ty as IRType));
    }
    blockMaps.push(blockMap);
    valMaps.push(valMap);
  }

  const newBlocks: Block[] = [];
  for (let k = 0; k < KF; k++) {
    const valMap = valMaps[k];
    const blockMap = blockMaps[k];
    // A branch back to the header means "advance an iteration": route it to the
    // next copy, and on the last copy back to the main header (the back edge).
    const mapTarget = (s: number): number => (s === H.id ? (k < KF - 1 ? blockMaps[k + 1].get(H.id)! : MH) : blockMap.get(s)!);
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
      // The cloned header's test is gone — the guard already proved the body runs,
      // so it falls straight into the body. Every other block keeps its shape.
      nb.term = bid === H.id ? { op: 'br', target: blockMap.get(bodyEntry)! } : mapTerm(ob.term, mapTarget, valMap);
      newBlocks.push(nb);
    }
  }

  // --- the main header: phis + the "K more iterations?" guard ----------
  const mh: Block = { id: MH, phis: [], insts: [], term: { op: 'unreachable' }, preds: [] };
  for (const hp of H.phis) {
    mh.phis.push({
      res: mainPhiRes.get(hp.res)!,
      ty: hp.ty,
      incomings: [
        { pred: PH, val: clone(ivOrPhiInit(hp, PH).val) },
        { pred: blockMaps[KF - 1].get(latchId)!, val: remap(valMaps[KF - 1], latchIncoming(hp, latchId).val) },
      ],
    });
  }
  const ivMain: Operand = { tag: 'val', id: mainPhiRes.get(ivPhi.res)! };
  let allK: Operand | null = null;
  for (let j = 0; j < KF; j++) {
    // The induction value this iteration would see: i + j*step (wrapping).
    const ivj: Operand = j === 0 ? ivMain : pushInst(mh, fn, nextVal++, ty, 'ibin', 'add', [ivMain, constOf(ty, mulStep(step, j, ty))]);
    // The original predicate, evaluated at ivj against the (invariant) bound.
    const cond = pushInst(mh, fn, nextVal++, 'i32', 'icmp', cmpSub, ivIsA ? [ivj, clone(boundOp)] : [clone(boundOp), ivj]);
    // "Enters the body" = predicate matches the body edge's polarity.
    const enter = trueIsBody ? cond : pushInst(mh, fn, nextVal++, 'i32', 'ibin', 'xor', [cond, { tag: 'const', ty: 'i32', num: 1 }]);
    allK = allK === null ? enter : pushInst(mh, fn, nextVal++, 'i32', 'ibin', 'and', [allK, enter]);
  }
  mh.term = { op: 'condbr', cond: allK!, t: blockMaps[0].get(H.id)!, f: H.id };

  // --- splice in: preheader → main header, main "no" edge → original ---
  const ph = byId.get(PH)!;
  ph.term = redirectTerm(ph.term, H.id, MH);
  // The original header now receives its entry edge from the main header (with
  // the strided values) instead of the preheader.
  for (const hp of H.phis) {
    const inc = hp.incomings.find((x) => x.pred === PH);
    if (inc) {
      inc.pred = MH;
      inc.val = { tag: 'val', id: mainPhiRes.get(hp.res)! };
    }
  }

  fn.blocks.push(mh, ...newBlocks);
  recomputePreds(fn);
  done.add(H.id);
  return true;
}

// --- counted-loop recognition (shared shape with the full unroller) --------

function recognizeCountedLoop(loop: NaturalLoop, byId: Map<number, Block>): Recognized | null {
  const body = loop.body;
  const H = byId.get(loop.header);
  if (!H) return null;
  if (loop.latches.length !== 1) return null;
  const latchId = loop.latches[0];
  if (latchId === H.id) return null;

  const outsidePreds = H.preds.filter((p) => !body.has(p));
  const insidePreds = H.preds.filter((p) => body.has(p));
  if (outsidePreds.length !== 1) return null;
  if (insidePreds.length !== 1 || insidePreds[0] !== latchId) return null;
  const PH = outsidePreds[0];

  if (H.term.op !== 'condbr' || H.term.t === H.term.f) return null;
  const tT = H.term.t;
  const fT = H.term.f;
  let bodyEntry: number;
  if (body.has(tT) && !body.has(fT)) bodyEntry = tT;
  else if (body.has(fT) && !body.has(tT)) bodyEntry = fT;
  else return null;
  if (bodyEntry === H.id) return null;

  // Single entry / single exit: only the header leaves the loop, and every body
  // block is reached only from within — so the body is a clean region to clone.
  for (const bid of body) {
    const b = byId.get(bid)!;
    if (bid !== H.id) {
      for (const p of b.preds) if (!body.has(p)) return null;
      for (const s of succOfTerm(b.term)) if (!body.has(s)) return null;
    }
  }

  if (H.term.cond.tag !== 'val') return null;
  const condId = H.term.cond.id;
  const icmp = H.insts.find((i) => i.res === condId);
  if (!icmp || icmp.kind !== 'icmp') return null;

  const headerPhiByRes = new Map(H.phis.map((p) => [p.res, p]));
  const asPhi = (o: Operand): Phi | undefined => (o.tag === 'val' ? headerPhiByRes.get(o.id) : undefined);
  const [cmpA, cmpB] = icmp.args;
  const phiA = asPhi(cmpA);
  const phiB = asPhi(cmpB);
  let ivPhi: Phi;
  let ivIsA: boolean;
  let boundOp: Operand;
  // The bound may be a constant *or* a loop-invariant runtime value — the whole
  // point of partial unrolling is the runtime-trip-count case.
  if (phiA && !asPhi(cmpB)) {
    ivPhi = phiA;
    ivIsA = true;
    boundOp = cmpB;
  } else if (phiB && !asPhi(cmpA)) {
    ivPhi = phiB;
    ivIsA = false;
    boundOp = cmpA;
  } else {
    return null;
  }

  const ty = ivPhi.ty;
  if (ty !== 'i32' && ty !== 'i64') return null;

  const initInc = ivPhi.incomings.find((x) => x.pred === PH);
  const latchInc = ivPhi.incomings.find((x) => x.pred === latchId);
  if (!initInc || !latchInc) return null;
  if (latchInc.val.tag !== 'val') return null;

  const stepInst = findInst(byId, body, latchInc.val.id);
  if (!stepInst || stepInst.kind !== 'ibin') return null;
  const isIv = (o: Operand): boolean => o.tag === 'val' && o.id === ivPhi.res;
  const [sa, sb] = stepInst.args;
  let step: number | bigint;
  if (stepInst.sub === 'add' && isIv(sa) && sb.tag === 'const') step = sb.num;
  else if (stepInst.sub === 'add' && isIv(sb) && sa.tag === 'const') step = sa.num;
  else if (stepInst.sub === 'sub' && isIv(sa) && sb.tag === 'const') step = negate(sb.num, ty);
  else return null;

  const trueIsBody = bodyEntry === H.term.t;
  return { H, PH, latchId, bodyEntry, ivPhi, ivIsA, boundOp, cmpSub: icmp.sub, trueIsBody, step, ty };
}

// --- small helpers (kept private to mirror unroll.ts) ----------------------

function ivInit(ivPhi: Phi, PH: number): { num: number | bigint } | null {
  const inc = ivPhi.incomings.find((x) => x.pred === PH);
  if (!inc || inc.val.tag !== 'const') return null;
  return { num: inc.val.num };
}

function ivOrPhiInit(hp: Phi, PH: number): { val: Operand } {
  return { val: hp.incomings.find((x) => x.pred === PH)!.val };
}

function latchIncoming(hp: Phi, latchId: number): { val: Operand } {
  return { val: hp.incomings.find((x) => x.pred === latchId)!.val };
}

function pushInst(b: Block, fn: IRFunc, id: number, ty: IRType, kind: Inst['kind'], sub: string, args: Operand[]): Operand {
  fn.valueType.set(id, ty);
  b.insts.push({ res: id, ty, kind, sub, args });
  return { tag: 'val', id };
}

function constOf(ty: IRType, num: number | bigint): Operand {
  return { tag: 'const', ty, num };
}

/** j*step with the same wrapping the runtime uses (mod 2^32 / 2^64). */
function mulStep(step: number | bigint, j: number, ty: IRType): number | bigint {
  if (ty === 'i64') return BigInt.asIntN(64, (step as bigint) * BigInt(j));
  return Math.imul(step as number, j) | 0;
}

function defBlockOf(fn: IRFunc, id: number): number | null {
  for (const b of fn.blocks) {
    for (const p of b.phis) if (p.res === id) return b.id;
    for (const ins of b.insts) if (ins.res === id) return b.id;
  }
  // A function parameter has no defining block but is invariant everywhere; model
  // it as the entry block so callers treat it as outside any loop body.
  if (fn.valueType.has(id)) return fn.entry;
  return null;
}

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

/** The exact number of body executions, or null if it exceeds the full-unroll
 *  limit — i.e. "this is not a small constant-trip loop". */
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
      if (!(trueIsBody ? cond : !cond)) return t;
      if (++t > FULL_UNROLL_LIMIT) return null;
      i = BigInt.asIntN(64, i + stp);
    }
  }
  let i = (init as number) | 0;
  const bnd = (bound as number) | 0;
  const stp = (step as number) | 0;
  for (;;) {
    const cond = ivIsA ? evalICmp(pred, i, bnd) : evalICmp(pred, bnd, i);
    if (!(trueIsBody ? cond : !cond)) return t;
    if (++t > FULL_UNROLL_LIMIT) return null;
    i = (i + stp) | 0;
  }
}

function redirectTerm(t: Term, from: number, to: number): Term {
  if (t.op === 'br') return t.target === from ? { op: 'br', target: to } : t;
  if (t.op === 'condbr') return { op: 'condbr', cond: t.cond, t: t.t === from ? to : t.t, f: t.f === from ? to : t.f };
  return t;
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
