import type { Block, Inst, IRFunc, IRType, Operand, Phi, Term } from '../ir/ir';
import { computeDom, succOfTerm } from '../ir/cfg';
import { findNaturalLoops, isInnermost } from '../ir/loops';
import type { NaturalLoop } from '../ir/loops';

// =====================================================================
// The auto-vectorizer — counted array loops → 4-wide v128 SIMD
// =====================================================================
//
// A counted loop that walks an array one element per iteration
//
//      for (let i = 0; i < n; i = i + 1) { c[i] = a[i] * b[i] + a[i]; }
//
// has four *independent* iterations sitting side by side: nothing iteration `i`
// writes is read by iteration `i+1`. This pass discovers that parallelism and
// runs four lanes at once — one `v128.load` per array, lanewise `f32x4.mul`/
// `f32x4.add`, one `v128.store` — for the classic 4× data-parallel win.
//
// The rewrite mirrors **partial unrolling**'s strictly-safe shape (see
// `partial-unroll.ts`): it never deletes the original loop, it only *prepends* a
// vector "main" loop and reuses the untouched original as the **remainder** that
// mops up the final `< 4` iterations. So every loop-exit value and live-out is
// still produced by the original machinery — the vectorizer can only ever add a
// fast path, never disturb a result.
//
//      preheader                          preheader
//          │                                  │
//          ▼                                  ▼
//     ┌──[header]──┐        ──►          ┌──[vec hdr]── guard: 4 more? ─┐ no
//     │   c[i]=…    │                    │  vload/arith/vstore  (i+=4)  │
//     └────────────┘                     └──────────────┬───────────────┘
//                                                        ▼
//                                              ┌──[header (remainder)]──┐
//                                              │   the original loop    │
//                                              └────────────────────────┘
//
// The "4 more?" guard is the exact, overflow-blind predicate partial unrolling
// uses: it evaluates the loop's real `i < n` test at `i, i+1, i+2, i+3` with the
// same wrapping i32 arithmetic and signed compare, and enters the vector body
// only when *all four* say iterate. The body therefore runs only on full groups
// of four; the original loop handles the rest, exactly.
//
// --- why it is sound (the load-bearing dependence argument) ----------------
//
// The pass requires **every** array subscript to be *exactly the induction
// variable* (`a[i]`, offset 0): each access's address must reduce to
// `handle + ARRAY_HEADER + i·4`, with the index operand being the IV itself.
// Under that single rule the four lanes are independent regardless of aliasing:
//
//   • Same array, same index each iteration ⇒ lane k touches element i+k only.
//     A store/load pair on one array is *within-lane*, and the vector body keeps
//     program order, so a read-after-write on one element is preserved exactly.
//   • Distinct arrays never collide across lanes. The "4 more?" guard means any
//     array the vector body touches is indexed at i … i+3, so it has ≥ 4 live
//     elements and occupies ≥ ARRAY_HEADER + 16 bytes. Two distinct 8-byte-
//     aligned bump allocations therefore have base handles ≥ 20 bytes apart,
//     while a cross-lane collision would need them within 4·3 = 12 bytes —
//     impossible. So `a[i+1] = a[i]` stencils (which *do* carry a dependence)
//     are rejected up front (index ≠ IV), and everything that survives is
//     provably lane-independent.
//
// Every precondition is checked; on the slightest doubt the pass declines and
// leaves the IR untouched, so a bug can only ever miss an opportunity — the
// three-engine differential oracle (interpreter = V8 = VM, at every -O level)
// proves the fast path it *did* take never changed behaviour.

const ARRAY_HEADER = 8; // bytes before element data — must match ir/builder.ts
const ELEM_SIZE = 4; // i32 / f32 element width (the shapes we pack 4-wide)
const LANES = 4;

// A scalar integer op promoted to its i32x4 / v128 lanewise form. No SIMD integer
// divide, remainder or shift exists, so a vector body using them is declined.
const IBIN_VEC: Record<string, string> = {
  add: 'i32x4.add', sub: 'i32x4.sub', mul: 'i32x4.mul',
  and: 'v128.and', or: 'v128.or', xor: 'v128.xor',
};
// A scalar float op promoted to its f32x4 lanewise form.
const FBIN_VEC: Record<string, string> = {
  add: 'f32x4.add', sub: 'f32x4.sub', mul: 'f32x4.mul', div: 'f32x4.div', min: 'f32x4.min', max: 'f32x4.max',
};

// =====================================================================
// Reductions — a loop-carried accumulator folded 4 lanes at a time
// =====================================================================
//
// A counted loop can also *fold* the array into one scalar:
//
//      let s = 0; for (let i = 0; i < n; i = i + 1) { s = s + a[i]; }
//
// Here `s` is loop-carried (iteration `i` reads what `i-1` wrote), so the naive
// lane-independence argument fails. But the fold is over an **associative and
// commutative** monoid, so the elements may be summed in any order: run four
// independent partial sums in the four lanes, then collapse them once at exit.
// The vector body keeps a `v128` accumulator (`vacc = vacc ⊕ vload a[i]`); the
// exit block does a **horizontal reduce** — four `extract_lane`s combined with the
// same scalar op — and seeds the remainder loop's accumulator with it. Because
// `⊕` is exactly associative+commutative on i32 (`add`/`mul` wrap mod 2³², and
// the bitwise ops are trivially so), the lane-shuffled fold is *bit-identical* to
// the sequential one — which the three-engine oracle then proves.
//
// Only **integer** reductions qualify: f32 `add`/`mul` are NOT associative under
// rounding, so a lane-shuffled float sum would round differently — that loses the
// bit-for-bit equality the oracle demands, so float accumulators are declined.
// The horizontal-combine, the per-lane init (the monoid identity) and the
// final init-fold are all the *same* scalar op `⊕`, which is what makes the one
// table below sufficient.
const REDUCE_OPS = new Set(['add', 'mul', 'and', 'or', 'xor']);
// The monoid identity per reduce op — the value each lane starts at so that
// `identity ⊕ x = x` and the four partial folds compose to the whole.
const REDUCE_IDENTITY: Record<string, number> = { add: 0, mul: 1, and: -1, or: 0, xor: 0 };

// A loop-carried integer accumulator `acc = acc ⊕ contrib`, recognised as a
// reduction. `vaccRes`/`init`/`enterRes` are filled in as the rewrite proceeds.
interface Acc {
  phi: Phi; // the header accumulator phi (i32)
  op: string; // the reduce op (`sub` of the body ibin), in REDUCE_OPS
  accNextRes: number; // the body ibin result that feeds the phi's latch incoming
  init: Operand; // the phi's preheader incoming (loop-invariant)
  vaccRes?: number; // the v128 lane-accumulator phi id (assigned during rewrite)
  vaccNext?: Operand; // the lane accumulator after one vector step (from the body)
  accEnter?: Operand; // the horizontally-reduced scalar that seeds the remainder
}

export function vectorize(fn: IRFunc): number {
  const done = new Set<number>();
  let changed = 0;
  for (let iter = 0; iter < 64; iter++) {
    recomputePreds(fn);
    const dom = computeDom(fn);
    const loops = findNaturalLoops(fn, dom);
    let did = false;
    for (const loop of loops) {
      if (!isInnermost(loop, loops)) continue;
      if (done.has(loop.header)) continue;
      if (tryVectorize(fn, loop, done)) {
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
  bodyBlocks: Block[]; // the straight-line body chain, in order: bodyEntry … latch
  ivPhi: Phi;
  ivIsA: boolean;
  boundOp: Operand;
  cmpSub: string;
  trueIsBody: boolean;
  incInst: Inst; // the `i = i + 1` latch update
  accs: Acc[]; // loop-carried integer reductions (possibly empty)
}

function tryVectorize(fn: IRFunc, loop: NaturalLoop, done: Set<number>): boolean {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const rec = recognize(fn, loop, byId);
  if (!rec) return false;
  const { H, PH, bodyBlocks, ivPhi, ivIsA, boundOp, cmpSub, trueIsBody, incInst, accs } = rec;
  const bodyInsts: Inst[] = bodyBlocks.flatMap((b) => b.insts);
  const findInst = (res: number): Inst | undefined => bodyInsts.find((i) => i.res === res);

  // SSA construction can leave `copy` instructions the early copy-prop didn't clear
  // (e.g. a loop-carried value renamed through a temporary). Make them transparent:
  // `chase` follows a value through any chain of body-local copies to its real source.
  const copySrc = new Map<number, Operand>();
  for (const i of bodyInsts) if (i.kind === 'copy' && i.res !== null) copySrc.set(i.res, i.args[0]);
  const chase = (o: Operand): Operand => {
    let cur = o;
    const seen = new Set<number>();
    while (cur.tag === 'val' && copySrc.has(cur.id) && !seen.has(cur.id)) { seen.add(cur.id); cur = copySrc.get(cur.id)!; }
    return cur;
  };

  // --- classify which body values are vectors (derive from a load) -----------
  const loads = bodyInsts.filter((i) => i.kind === 'load');
  const stores = bodyInsts.filter((i) => i.kind === 'store');
  if (loads.length === 0 && stores.length === 0) return false; // nothing to widen

  // One lane shape per loop: every element access must be the same 4-byte type.
  let elem: 'i32' | 'f32' | null = null;
  for (const m of [...loads, ...stores]) {
    if (m.sub !== 'i32' && m.sub !== 'f32') return false; // only 4-wide shapes in v1
    if (elem === null) elem = m.sub;
    else if (elem !== m.sub) return false; // mixed i32/f32 in one body — decline
  }
  const shape = elem === 'i32' ? 'i32x4' : 'f32x4';
  // Integer accumulators only fold bit-exactly into an i32x4 lane vector.
  if (accs.length > 0 && shape !== 'i32x4') return false;

  // `vec` = SSA values that hold (or derive from) loaded vector data. A reduction
  // accumulator phi also rides in the lanes, so seed it as a vector too — its fold
  // then validates and rewrites through the very same vbin machinery as a kernel.
  const vec = new Set<number>();
  for (const l of loads) if (l.res !== null) vec.add(l.res);
  for (const acc of accs) vec.add(acc.phi.res);
  const opInVec = (a: Operand): boolean => { const c = chase(a); return c.tag === 'val' && vec.has(c.id); };
  for (let again = true; again; ) {
    again = false;
    for (const inst of bodyInsts) {
      if (inst.res === null || vec.has(inst.res)) continue;
      const flows = inst.kind === 'ibin' || inst.kind === 'fbin' || inst.kind === 'copy';
      if (!flows) continue;
      if (inst.args.some(opInVec)) {
        vec.add(inst.res);
        again = true;
      }
    }
  }
  const isVec = opInVec;
  const invariant = (o: Operand): boolean => { const c = chase(o); return c.tag === 'const' || !definedInBody(fn, loop.body, c.id); };

  // --- validate every body instruction (decline on the first surprise) -------
  const nope = (reason: string): boolean => { void reason; return false; }; // reason documents the case
  for (const inst of bodyInsts) {
    if (inst === incInst) continue; // the IV step — handled specially
    switch (inst.kind) {
      case 'copy':
        break; // transparent (handled by `chase`)
      case 'load': {
        if (handleOfElemAddr(findInst, chase, inst.args[0], ivPhi.res) === null) return nope('load addr');
        break;
      }
      case 'store': {
        if (handleOfElemAddr(findInst, chase, inst.args[0], ivPhi.res) === null) return nope('store addr');
        const v = inst.args[1];
        if (!isVec(v) && !invariant(v)) return nope('store val per-lane'); // can't splat
        break;
      }
      case 'ibin':
      case 'fbin': {
        const isV = inst.res !== null && vec.has(inst.res);
        if (isV) {
          const table = inst.kind === 'ibin' ? IBIN_VEC : FBIN_VEC;
          if (!(inst.sub in table)) return nope(`no lanewise ${inst.kind}.${inst.sub}`);
          // a scalar operand of a vector op must be loop-invariant (so a splat is correct).
          for (const a of inst.args) if (!isVec(a) && !invariant(a)) return nope(`vec op scalar non-invariant operand`);
        } else {
          // a scalar op (address / index arithmetic): all-scalar operands by construction.
          if (inst.args.some((a) => isVec(a))) return nope('scalar op with vec operand');
        }
        break;
      }
      default:
        return nope(`body kind ${inst.kind}`);
    }
  }

  // ====================================================================
  // Build the vector main loop and splice it ahead of the original loop.
  // ====================================================================
  const nextBlock = maxBlockId(fn) + 1;
  let nextVal = maxValueId(fn) + 1;
  const fresh = (ty: IRType): number => {
    const id = nextVal++;
    fn.valueType.set(id, ty);
    return id;
  };

  const VH = nextBlock; // vector header (carries the strided IV + the guard)
  const VB = nextBlock + 1; // vector body
  const VE = nextBlock + 2; // vector exit (horizontal reduce; only used with reductions)
  const viRes = fresh('i32'); // the vector IV (strides by 4)
  for (const acc of accs) acc.vaccRes = fresh('v128'); // one v128 lane accumulator each

  // --- vector body: rewrite the original body, op by op ----------------------
  const vb: Block = { id: VB, phis: [], insts: [], term: { op: 'br', target: VH }, preds: [] };
  const map = new Map<number, Operand>(); // old SSA id -> new operand
  map.set(ivPhi.res, { tag: 'val', id: viRes });
  // The accumulator phi reads as its lane vector inside the body; its fold ibin
  // then rewrites (above) into a `vbin` over these lanes, exactly like a kernel op.
  for (const acc of accs) map.set(acc.phi.res, { tag: 'val', id: acc.vaccRes! });
  const remap = (o: Operand): Operand => {
    const c = chase(o); // copies are transparent
    return c.tag === 'const' ? clone(c) : (map.get(c.id) ?? clone(c));
  };
  const splatCache = new Map<string, Operand>();
  const splat = (o: Operand): Operand => {
    const r = remap(o);
    const key = r.tag === 'const' ? `c${r.ty}:${r.num}` : `v${r.id}`;
    let s = splatCache.get(key);
    if (!s) {
      const id = fresh('v128');
      vb.insts.push({ res: id, ty: 'v128', kind: 'vsplat', sub: shape, args: [r] });
      s = { tag: 'val', id };
      splatCache.set(key, s);
    }
    return s;
  };
  const vecOperand = (o: Operand): Operand => (isVec(o) ? remap(o) : splat(o));

  let viNext: Operand = { tag: 'val', id: viRes };
  for (const inst of bodyInsts) {
    if (inst === incInst) {
      const id = fresh('i32'); // vi = vi + 4
      vb.insts.push({ res: id, ty: 'i32', kind: 'ibin', sub: 'add', args: [{ tag: 'val', id: viRes }, { tag: 'const', ty: 'i32', num: LANES }] });
      viNext = { tag: 'val', id };
      map.set(inst.res!, viNext);
      continue;
    }
    switch (inst.kind) {
      case 'copy':
        break; // transparent — references resolve through `chase`/`remap`
      case 'load': {
        const id = fresh('v128');
        vb.insts.push({ res: id, ty: 'v128', kind: 'vload', sub: shape, args: [remap(inst.args[0])] });
        map.set(inst.res!, { tag: 'val', id });
        break;
      }
      case 'store': {
        const val = isVec(inst.args[1]) ? remap(inst.args[1]) : splat(inst.args[1]);
        vb.insts.push({ res: null, ty: 'void', kind: 'vstore', sub: shape, args: [remap(inst.args[0]), val] });
        break;
      }
      case 'ibin':
      case 'fbin': {
        const isV = inst.res !== null && vec.has(inst.res);
        if (isV) {
          const sub = (inst.kind === 'ibin' ? IBIN_VEC : FBIN_VEC)[inst.sub];
          const id = fresh('v128');
          vb.insts.push({ res: id, ty: 'v128', kind: 'vbin', sub, args: [vecOperand(inst.args[0]), vecOperand(inst.args[1])] });
          map.set(inst.res!, { tag: 'val', id });
        } else {
          const id = fresh(inst.ty as IRType);
          vb.insts.push({ res: id, ty: inst.ty, kind: inst.kind, sub: inst.sub, args: inst.args.map(remap) });
          map.set(inst.res!, { tag: 'val', id });
        }
        break;
      }
    }
  }

  // Each accumulator's lane vector after one vector step (the rewritten fold).
  for (const acc of accs) acc.vaccNext = map.get(acc.accNextRes)!;

  // --- vector header: phi + the "4 more iterations?" guard --------------------
  const ivInit = clone(ivPhi.incomings.find((x) => x.pred === PH)!.val);
  const vi: Operand = { tag: 'val', id: viRes };
  const ph = byId.get(PH)!;
  // A reduction's lane accumulator enters the loop at the monoid identity, splatted
  // into all four lanes in the preheader (so `identity ⊕ x = x` per lane).
  const accPhis: Phi[] = [];
  for (const acc of accs) {
    const sid = fresh('v128');
    ph.insts.push({ res: sid, ty: 'v128', kind: 'vsplat', sub: shape, args: [{ tag: 'const', ty: 'i32', num: REDUCE_IDENTITY[acc.op] }] });
    accPhis.push({ res: acc.vaccRes!, ty: 'v128', incomings: [{ pred: PH, val: { tag: 'val', id: sid } }, { pred: VB, val: acc.vaccNext! }] });
  }
  const vh: Block = {
    id: VH,
    phis: [{ res: viRes, ty: 'i32', incomings: [{ pred: PH, val: ivInit }, { pred: VB, val: viNext }] }, ...accPhis],
    insts: [],
    term: { op: 'unreachable' },
    preds: [],
  };
  let allK: Operand | null = null;
  for (let j = 0; j < LANES; j++) {
    const ivj: Operand = j === 0 ? vi : push(vh, fresh('i32'), 'i32', 'ibin', 'add', [vi, { tag: 'const', ty: 'i32', num: j }]);
    const cond = push(vh, fresh('i32'), 'i32', 'icmp', cmpSub, ivIsA ? [ivj, clone(boundOp)] : [clone(boundOp), ivj]);
    const enter = trueIsBody ? cond : push(vh, fresh('i32'), 'i32', 'ibin', 'xor', [cond, { tag: 'const', ty: 'i32', num: 1 }]);
    allK = allK === null ? enter : push(vh, fresh('i32'), 'i32', 'ibin', 'and', [allK, enter]);
  }

  // --- vector exit: collapse each lane accumulator to one scalar ---------------
  // Only built when there is a reduction; otherwise the guard's "no" edge goes
  // straight to the original loop, exactly as the elementwise pass always did.
  const hasAcc = accs.length > 0;
  // The guard's "no" edge goes to the remainder loop H — directly when there is no
  // reduction, or via the exit block VE (which horizontally reduces first) when
  // there is. `remPred` is the block H is *entered from*, for its phi incomings.
  const remPred = hasAcc ? VE : VH;
  vh.term = { op: 'condbr', cond: allK!, t: VB, f: hasAcc ? VE : H.id };
  const ve: Block = { id: VE, phis: [], insts: [], term: { op: 'br', target: H.id }, preds: [] };
  for (const acc of accs) {
    const lanes: Operand[] = [];
    for (let k = 0; k < LANES; k++) {
      lanes.push(push(ve, fresh('i32'), 'i32', 'vextract', `${shape}.extract_lane:${k}`, [{ tag: 'val', id: acc.vaccRes! }]));
    }
    // Fold the four lanes pairwise, then fold in the loop-invariant initial value
    // — every combine is the same associative+commutative op the loop carried.
    const r01 = push(ve, fresh('i32'), 'i32', 'ibin', acc.op, [lanes[0], lanes[1]]);
    const r23 = push(ve, fresh('i32'), 'i32', 'ibin', acc.op, [lanes[2], lanes[3]]);
    const hred = push(ve, fresh('i32'), 'i32', 'ibin', acc.op, [r01, r23]);
    acc.accEnter = push(ve, fresh('i32'), 'i32', 'ibin', acc.op, [clone(acc.init), hred]);
  }

  // --- splice: preheader → vector header; guard "no" edge → remainder ----------
  ph.term = redirectTerm(ph.term, H.id, VH);
  // The original header now enters from the vector exit (with the strided IV and
  // the reduced accumulators) instead of the preheader — making it the remainder
  // loop, reused verbatim. With no reduction, `remPred` is the header itself.
  const setEnter = (phiRes: number, val: Operand): void => {
    const inc = H.phis.find((p) => p.res === phiRes)!.incomings.find((x) => x.pred === PH)!;
    inc.pred = remPred;
    inc.val = val;
  };
  setEnter(ivPhi.res, vi);
  for (const acc of accs) setEnter(acc.phi.res, acc.accEnter!);

  fn.blocks.push(vh, vb);
  if (hasAcc) fn.blocks.push(ve);
  recomputePreds(fn);
  done.add(H.id);
  return true;
}

// --- counted-loop recognition (a stricter cousin of partial-unroll's) --------

function recognize(fn: IRFunc, loop: NaturalLoop, byId: Map<number, Block>): Recognized | null {
  const no = (reason: string): null => { void reason; return null; }; // reason documents the case
  const body = loop.body;
  const H = byId.get(loop.header);
  if (!H) return no('no header');
  if (loop.latches.length !== 1) return no('latches!=1');
  const latchId = loop.latches[0];
  if (latchId === H.id) return no('self-latch');

  const outside = H.preds.filter((p) => !body.has(p));
  const inside = H.preds.filter((p) => body.has(p));
  if (outside.length !== 1) return no(`outside preds=${outside.length}`);
  if (inside.length !== 1 || inside[0] !== latchId) return no('inside preds');
  const PH = outside[0];

  // The header tests `iv </<=/… bound` and branches into the body.
  if (H.term.op !== 'condbr' || H.term.t === H.term.f) return null;
  const bodyEntry = body.has(H.term.t) && !body.has(H.term.f) ? H.term.t : body.has(H.term.f) && !body.has(H.term.t) ? H.term.f : null;
  if (bodyEntry === null || bodyEntry === H.id) return no("bodyEntry");

  // The body must be a single straight-line chain bodyEntry → … → latch → header:
  // each block unconditionally falls through to the next, the last brs to the header,
  // none has a phi, and none is entered from outside the chain.
  const bodyBlocks: Block[] = [];
  const seen = new Set<number>();
  let cur = bodyEntry;
  for (;;) {
    if (seen.has(cur)) return no("cycle");
    seen.add(cur);
    const b = byId.get(cur);
    if (!b) return no("chain missing");
    if (b.phis.length !== 0) return no("body phi");
    if (b.preds.length !== 1) return no("body preds="+b.preds.length);
    bodyBlocks.push(b);
    if (cur === latchId) {
      if (b.term.op !== "br" || b.term.target !== H.id) return no("latch term");
      break;
    }
    if (b.term.op !== "br") return no("inner cf");
    cur = b.term.target;
    if (!body.has(cur)) return no("chain exits body");
  }
  if (bodyBlocks.length !== body.size - 1) return no("blocks off chain");

  if (H.term.cond.tag !== "val") return no("cond not val");
  const icmp = H.insts.find((i) => i.res === (H.term as { cond: Operand & { tag: 'val' } }).cond.id);
  if (!icmp || icmp.kind !== "icmp") return no("not icmp");
  const [cmpA, cmpB] = icmp.args;

  // The IV is the header phi the loop test compares; it must be i32 and stride +1.
  // Every *other* header phi has to be a recognised reduction accumulator, else we
  // decline — we never partially vectorize a loop with an unclassified carried value.
  const headerPhi = (o: Operand): Phi | undefined => (o.tag === 'val' ? H.phis.find((p) => p.res === o.id) : undefined);
  const aPhi = headerPhi(cmpA), bPhi = headerPhi(cmpB);
  let ivPhi: Phi, ivIsA: boolean, boundOp: Operand;
  if (aPhi && !bPhi) { ivPhi = aPhi; ivIsA = true; boundOp = cmpB; }
  else if (bPhi && !aPhi) { ivPhi = bPhi; ivIsA = false; boundOp = cmpA; }
  else return no("iv/bound");
  if (ivPhi.ty !== "i32") return no("iv not i32");
  const isIv = (o: Operand): boolean => o.tag === 'val' && o.id === ivPhi.res;
  // Runtime bound must be loop-invariant.
  if (boundOp.tag === "val" && definedInBody(fn, body, boundOp.id)) return no("bound not invariant");

  const initInc = ivPhi.incomings.find((x) => x.pred === PH);
  const latchInc = ivPhi.incomings.find((x) => x.pred === latchId);
  if (!initInc || !latchInc || latchInc.val.tag !== 'val') return null;
  const latch = bodyBlocks[bodyBlocks.length - 1];
  const incInst = latch.insts.find((i) => i.res === (latchInc.val as { id: number }).id);
  if (!incInst || incInst.kind !== "ibin" || incInst.sub !== "add") return no("inc");
  // Stride exactly +1 (so four consecutive iterations are four contiguous elements).
  const [sa, sb] = incInst.args;
  const stepOne = (isIv(sa) && sb.tag === 'const' && sb.num === 1) || (isIv(sb) && sa.tag === 'const' && sa.num === 1);
  if (!stepOne) return no("step!=1");

  // Classify the remaining header phis as reductions; any survivor that isn't one
  // means a carried value we can't reorder, so the whole loop is declined.
  const bodyInsts = bodyBlocks.flatMap((b) => b.insts);
  const accs: Acc[] = [];
  for (const phi of H.phis) {
    if (phi === ivPhi) continue;
    const acc = recognizeAcc(fn, body, phi, PH, latchId, bodyInsts);
    if (!acc) return no("header phi neither iv nor reduction");
    accs.push(acc);
  }

  const trueIsBody = bodyEntry === H.term.t;
  return { H, PH, bodyBlocks, ivPhi, ivIsA, boundOp, cmpSub: icmp.sub, trueIsBody, incInst, accs };
}

/** Recognise a loop-carried integer accumulator `acc = acc ⊕ contrib` over an
 *  associative+commutative op (so the four lanes may fold independently). Returns
 *  the reduction, or null to decline. */
function recognizeAcc(fn: IRFunc, body: Set<number>, phi: Phi, PH: number, latchId: number, bodyInsts: Inst[]): Acc | null {
  if (phi.ty !== 'i32') return null; // only the exact integer monoids reorder bit-for-bit
  const initInc = phi.incomings.find((x) => x.pred === PH);
  const latchInc = phi.incomings.find((x) => x.pred === latchId);
  if (!initInc || !latchInc || latchInc.val.tag !== 'val') return null;
  if (initInc.val.tag === 'val' && definedInBody(fn, body, initInc.val.id)) return null; // init must be invariant

  // SSA can leave body-local `copy`s (a loop-carried value renamed through a temp);
  // the elementwise pass makes them transparent with the same `chase`. `root`
  // follows a value through any chain of body copies to its real definition.
  const copySrc = new Map<number, number>();
  for (const i of bodyInsts) if (i.kind === 'copy' && i.res !== null && i.args[0].tag === 'val') copySrc.set(i.res, i.args[0].id);
  const root = (id: number): number => { let c = id; const seen = new Set<number>(); while (copySrc.has(c) && !seen.has(c)) { seen.add(c); c = copySrc.get(c)!; } return c; };

  const accNextRes = root(latchInc.val.id);
  const accNext = bodyInsts.find((i) => i.res === accNextRes);
  if (!accNext || accNext.kind !== 'ibin' || !REDUCE_OPS.has(accNext.sub)) return null;
  // Exactly one operand is the accumulator itself; the other is the contribution.
  // (Rules out `s = s ⊕ s` and a non-carried `s = c ⊕ d`.)
  const [x, y] = accNext.args;
  const xIsAcc = x.tag === 'val' && root(x.id) === phi.res;
  const yIsAcc = y.tag === 'val' && root(y.id) === phi.res;
  if (xIsAcc === yIsAcc) return null;
  // The phi may be consumed *only* by this fold, and the fold's result *only* by
  // the phi (copies are transparent and don't count as a real use). Any other use
  // would observe a mid-loop, per-lane-partial value and break under reordering —
  // which also forbids cross-accumulator chains.
  for (const inst of bodyInsts) {
    if (inst === accNext || inst.kind === 'copy') continue;
    for (const a of inst.args) {
      if (a.tag !== 'val') continue;
      const r = root(a.id);
      if (r === phi.res || r === accNextRes) return null;
    }
  }
  return { phi, op: accNext.sub, accNextRes, init: initInc.val };
}

type Find = (res: number) => Inst | undefined;
type Chase = (o: Operand) => Operand;

/** If `addr` is the canonical element address `handle + ARRAY_HEADER + iv·ELEM_SIZE`
 *  (subscript exactly the IV, offset 0), return the array handle operand; else null. */
function handleOfElemAddr(find: Find, chase: Chase, addr: Operand, iv: number): Operand | null {
  const a0 = chase(addr);
  if (a0.tag !== 'val') return null;
  const add = find(a0.id);
  if (!add || add.kind !== 'ibin' || add.sub !== 'add') return null;
  // addr = dataStart + off, in either operand order.
  for (const [ds, of] of [[add.args[0], add.args[1]], [add.args[1], add.args[0]]] as [Operand, Operand][]) {
    const dataStart = dataStartHandle(find, chase, ds);
    if (dataStart !== null && isIvTimesElem(find, chase, of, iv)) return dataStart;
  }
  return null;
}

/** `ds` is `handle + ARRAY_HEADER` ⇒ return `handle`, else null. */
function dataStartHandle(find: Find, chase: Chase, ds: Operand): Operand | null {
  const d = chase(ds);
  if (d.tag !== 'val') return null;
  const i = find(d.id);
  if (!i || i.kind !== 'ibin' || i.sub !== 'add') return null;
  const [a, b] = i.args;
  if (b.tag === 'const' && b.num === ARRAY_HEADER) return chase(a);
  if (a.tag === 'const' && a.num === ARRAY_HEADER) return chase(b);
  return null;
}

/** `of` is `iv * ELEM_SIZE` (subscript exactly the IV, offset 0)? */
function isIvTimesElem(find: Find, chase: Chase, of: Operand, iv: number): boolean {
  const o0 = chase(of);
  if (o0.tag !== 'val') return false;
  const i = find(o0.id);
  if (!i || i.kind !== 'ibin' || i.sub !== 'mul') return false;
  const isIv = (o: Operand): boolean => { const c = chase(o); return c.tag === 'val' && c.id === iv; };
  const [a, b] = i.args;
  return (isIv(a) && b.tag === 'const' && b.num === ELEM_SIZE) || (isIv(b) && a.tag === 'const' && a.num === ELEM_SIZE);
}

// --- small CFG helpers -------------------------------------------------------

function definedInBody(fn: IRFunc, body: Set<number>, id: number): boolean {
  for (const b of fn.blocks) {
    if (!body.has(b.id)) continue;
    for (const p of b.phis) if (p.res === id) return true;
    for (const i of b.insts) if (i.res === id) return true;
  }
  return false;
}

function push(b: Block, id: number, ty: IRType, kind: Inst['kind'], sub: string, args: Operand[]): Operand {
  b.insts.push({ res: id, ty, kind, sub, args });
  return { tag: 'val', id };
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
