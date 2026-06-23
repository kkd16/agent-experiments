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
}

function tryVectorize(fn: IRFunc, loop: NaturalLoop, done: Set<number>): boolean {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const rec = recognize(fn, loop, byId);
  if (!rec) return false;
  const { H, PH, bodyBlocks, ivPhi, ivIsA, boundOp, cmpSub, trueIsBody, incInst } = rec;
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

  // `vec` = SSA values that hold (or derive from) loaded vector data.
  const vec = new Set<number>();
  for (const l of loads) if (l.res !== null) vec.add(l.res);
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
  const viRes = fresh('i32'); // the vector IV (strides by 4)

  // --- vector body: rewrite the original body, op by op ----------------------
  const vb: Block = { id: VB, phis: [], insts: [], term: { op: 'br', target: VH }, preds: [] };
  const map = new Map<number, Operand>(); // old SSA id -> new operand
  map.set(ivPhi.res, { tag: 'val', id: viRes });
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

  // --- vector header: phi + the "4 more iterations?" guard --------------------
  const ivInit = clone(ivPhi.incomings.find((x) => x.pred === PH)!.val);
  const vi: Operand = { tag: 'val', id: viRes };
  const vh: Block = {
    id: VH,
    phis: [{ res: viRes, ty: 'i32', incomings: [{ pred: PH, val: ivInit }, { pred: VB, val: viNext }] }],
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
  vh.term = { op: 'condbr', cond: allK!, t: VB, f: H.id };

  // --- splice: preheader → vector header; guard "no" edge → original loop -----
  const ph = byId.get(PH)!;
  ph.term = redirectTerm(ph.term, H.id, VH);
  // The original header now enters from the vector header (with the strided IV)
  // instead of the preheader — making it the remainder loop, reused verbatim.
  const inc = H.phis.find((p) => p.res === ivPhi.res)!.incomings.find((x) => x.pred === PH)!;
  inc.pred = VH;
  inc.val = vi;

  fn.blocks.push(vh, vb);
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

  // Exactly one induction phi, and it is the loop's IV.
  if (H.phis.length !== 1) return no("header phis="+H.phis.length);
  const ivPhi = H.phis[0];
  if (ivPhi.ty !== "i32") return no("iv not i32");
  const isIv = (o: Operand): boolean => o.tag === 'val' && o.id === ivPhi.res;
  const [cmpA, cmpB] = icmp.args;
  let ivIsA: boolean;
  let boundOp: Operand;
  if (isIv(cmpA) && !isIv(cmpB)) { ivIsA = true; boundOp = cmpB; }
  else if (isIv(cmpB) && !isIv(cmpA)) { ivIsA = false; boundOp = cmpA; }
  else return no("iv/bound");
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

  const trueIsBody = bodyEntry === H.term.t;
  return { H, PH, bodyBlocks, ivPhi, ivIsA, boundOp, cmpSub: icmp.sub, trueIsBody, incInst };
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
