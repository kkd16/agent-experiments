import type { Block, Inst, IRFunc, IRType, Operand, Phi } from '../ir/ir';
import { eachOperand } from '../ir/ir';
import { findNaturalLoops } from '../ir/loops';
import { getPreheader, maxValueId } from './optimize';
import { i32 } from '../interp';

// =====================================================================
// OSR — Operator Strength Reduction on induction variables
// =====================================================================
//
// The classic transformation of Cooper, Simpson & Vick (*Operator Strength
// Reduction*, TOPLAS 2001): inside a loop, a multiplication of an induction
// variable by a loop-invariant "region constant" is replaced by a *new*
// induction variable that is incremented by an addition each iteration. A
// per-iteration multiply becomes a per-iteration add — the cheaper op — and the
// original multiply dies. This is exactly the move that turns an array index
// `base + i*stride` into a running pointer bump, and it complements the loop
// unroller: it pays off precisely on the loops the unroller *can't* touch
// (runtime or large trip counts), where the multiply would otherwise run every
// iteration.
//
// The reduction is an exact algebraic identity in the wrapping integer ring
// Z/2^w: if `i` advances by a region constant `c` each iteration, then `i*r`
// advances by `c*r`, because multiplication distributes over addition modulo
// 2^w — `(i+c)*r ≡ i*r + c*r (mod 2^w)`. A left shift `i << k` (k loop-invariant)
// is the same identity with `r = 2^(k mod w)`: `(i+c)<<k ≡ (i<<k) + (c<<k)`.
// Both multiply and shift never trap, so no trap is invented or erased. The
// reduction therefore preserves observable behaviour exactly, which the
// differential oracle (interp = wasm = VM, at every -O level) confirms.
//
// Floating point is deliberately excluded: FP multiplication does *not*
// distribute over addition (rounding makes `(i+c)*r ≠ i*r + c*r`), so only i32
// and i64 induction multiplies are reduced. Every precondition is checked; when
// anything is unrecognized the pass declines that candidate, so it can only ever
// strengthen the code, never change what it computes.

/** Replace every use of value `fromId` with operand `to`. */
function replaceAllUses(fn: IRFunc, fromId: number, to: Operand): number {
  let n = 0;
  for (const b of fn.blocks) {
    eachOperand(b, (o, set) => {
      if (o.tag === 'val' && o.id === fromId) {
        set(to.tag === 'const' ? { tag: 'const', ty: to.ty, num: to.num } : { tag: 'val', id: to.id });
        n++;
      }
    });
  }
  return n;
}

const constOf = (ty: IRType, num: number | bigint): Operand => ({ tag: 'const', ty, num });

/** Exact constant fold of `a (op) b` matching wasm i32/i64 semantics, or null. */
function foldConst(op: 'mul' | 'shl', ty: IRType, a: number | bigint, b: number | bigint): number | bigint {
  if (ty === 'i64') {
    const x = a as bigint;
    const y = b as bigint;
    return op === 'mul' ? BigInt.asIntN(64, x * y) : BigInt.asIntN(64, x << (y & 63n));
  }
  const x = a as number;
  const y = b as number;
  return op === 'mul' ? Math.imul(x, y) : i32(x << (y & 31));
}

interface BasicIV {
  /** The header phi defining the induction variable. */
  phi: Phi;
  /** The loop-invariant initial value (the preheader incoming). */
  init: Operand;
  /** Per-latch step: the increment instruction's direction and region constant. */
  steps: { pred: number; dir: 1 | -1; c: Operand }[];
}

export function osr(fn: IRFunc): number {
  const loops = findNaturalLoops(fn);
  if (loops.length === 0) return 0;

  // A single id counter, shared with getPreheader, past every existing block and
  // value id (the two namespaces are kept disjoint, as elsewhere in the mid-end).
  const idCtr = { n: maxValueId(fn) + 1 };
  for (const b of fn.blocks) if (b.id >= idCtr.n) idCtr.n = b.id + 1;

  let changed = 0;
  for (const loop of loops) {
    const header = fn.blocks.find((b) => b.id === loop.header);
    if (!header) continue;
    const ph = getPreheader(fn, header, loop.body, idCtr);
    if (!ph) continue;
    changed += reduceLoop(fn, loop.body, header, ph, idCtr);
  }
  return changed;
}

function reduceLoop(fn: IRFunc, body: Set<number>, header: Block, ph: Block, idCtr: { n: number }): number {
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));

  // Every value defined inside the loop — used to test loop-invariance.
  const loopDefs = new Set<number>();
  for (const id of body) {
    const b = byId.get(id);
    if (!b) continue;
    for (const p of b.phis) loopDefs.add(p.res);
    for (const i of b.insts) if (i.res !== null) loopDefs.add(i.res);
  }
  const invariant = (o: Operand): boolean => o.tag === 'const' || !loopDefs.has(o.id);

  // Index every in-loop instruction by its result, to read increment expressions.
  const instById = new Map<number, Inst>();
  for (const id of body) {
    const b = byId.get(id);
    if (!b) continue;
    for (const i of b.insts) if (i.res !== null) instById.set(i.res, i);
  }

  // --- discover the basic induction variables of this loop ---
  const ivs = new Map<number, BasicIV>(); // phi res -> IV
  for (const phi of header.phis) {
    const ty = phi.ty;
    if (ty !== 'i32' && ty !== 'i64') continue; // integer IVs only
    const initIncs = phi.incomings.filter((inc) => inc.pred === ph.id);
    const latchIncs = phi.incomings.filter((inc) => inc.pred !== ph.id);
    if (initIncs.length !== 1 || latchIncs.length === 0) continue;
    const init = initIncs[0].val;
    if (!invariant(init)) continue;

    // Every latch incoming must be `phi + c` / `c + phi` / `phi - c` with c invariant.
    const steps: BasicIV['steps'] = [];
    let ok = true;
    for (const inc of latchIncs) {
      if (inc.val.tag !== 'val') { ok = false; break; }
      const def = instById.get(inc.val.id);
      if (!def || def.kind !== 'ibin' || (def.sub !== 'add' && def.sub !== 'sub')) { ok = false; break; }
      const [x, y] = def.args;
      const isPhi = (o: Operand) => o.tag === 'val' && o.id === phi.res;
      if (def.sub === 'add') {
        if (isPhi(x) && invariant(y)) steps.push({ pred: inc.pred, dir: 1, c: y });
        else if (isPhi(y) && invariant(x)) steps.push({ pred: inc.pred, dir: 1, c: x });
        else { ok = false; break; }
      } else {
        // subtract: only `phi - c` is a simple decrement (`c - phi` is not).
        if (isPhi(x) && invariant(y)) steps.push({ pred: inc.pred, dir: -1, c: y });
        else { ok = false; break; }
      }
    }
    if (ok) ivs.set(phi.res, { phi, init, steps });
  }
  if (ivs.size === 0) return 0;

  // --- reduce each candidate `iv * r` / `iv << k` in the loop body ---
  let changed = 0;
  for (const id of body) {
    const b = byId.get(id);
    if (!b) continue;
    for (const m of b.insts) {
      if (m.res === null || m.kind !== 'ibin') continue;
      if (m.sub !== 'mul' && m.sub !== 'shl') continue;
      const ty = m.ty;
      if (ty !== 'i32' && ty !== 'i64') continue;
      const [a, bb] = m.args;

      // Identify the induction operand and the region constant.
      let iv: BasicIV | undefined;
      let rc: Operand | undefined;
      if (m.sub === 'mul') {
        if (a.tag === 'val' && ivs.has(a.id) && invariant(bb)) { iv = ivs.get(a.id); rc = bb; }
        else if (bb.tag === 'val' && ivs.has(bb.id) && invariant(a)) { iv = ivs.get(bb.id); rc = a; }
      } else {
        // shift: only `iv << k` reduces (k loop-invariant); the IV must be the shiftee.
        if (a.tag === 'val' && ivs.has(a.id) && invariant(bb)) { iv = ivs.get(a.id); rc = bb; }
      }
      if (!iv || !rc) continue;

      // Build the new induction variable j' that tracks `iv (op) rc`.
      const op = m.sub; // 'mul' | 'shl'
      // init' = init (op) rc, materialized in the preheader.
      const initPrime = buildInvariant(fn, ph, op, ty, iv.init, rc, idCtr);
      const newPhiRes = idCtr.n++;
      fn.valueType.set(newPhiRes, ty);
      const incomings: Phi['incomings'] = [{ pred: ph.id, val: initPrime }];
      for (const step of iv.steps) {
        // The derived per-iteration increment: c (op) rc, also loop-invariant.
        const inc = buildInvariant(fn, ph, op, ty, step.c, rc, idCtr);
        // j'_next = j' (+/-) inc, emitted in the latch block.
        const latch = byId.get(step.pred);
        if (!latch) continue;
        const stepRes = idCtr.n++;
        fn.valueType.set(stepRes, ty);
        latch.insts.push({ res: stepRes, ty, kind: 'ibin', sub: step.dir === 1 ? 'add' : 'sub', args: [{ tag: 'val', id: newPhiRes }, inc] });
        incomings.push({ pred: step.pred, val: { tag: 'val', id: stepRes } });
      }
      header.phis.push({ res: newPhiRes, ty, incomings });
      replaceAllUses(fn, m.res, { tag: 'val', id: newPhiRes });
      changed++;
    }
  }
  return changed;
}

/**
 * Materialize the loop-invariant value `a (op) b` in the preheader `ph`,
 * constant-folding when possible (so a reduced IV's setup never leaves a trivial
 * `mul x, 1` or `x, 0` behind even when OSR runs in the final optimizer round).
 */
function buildInvariant(fn: IRFunc, ph: Block, op: 'mul' | 'shl', ty: IRType, a: Operand, b: Operand, idCtr: { n: number }): Operand {
  if (a.tag === 'const' && b.tag === 'const') return constOf(ty, foldConst(op, ty, a.num, b.num));
  const isZero = (o: Operand) => o.tag === 'const' && (ty === 'i64' ? o.num === 0n : o.num === 0);
  const isOne = (o: Operand) => o.tag === 'const' && (ty === 'i64' ? o.num === 1n : o.num === 1);
  if (op === 'mul') {
    if (isZero(a) || isZero(b)) return constOf(ty, ty === 'i64' ? 0n : 0);
    if (isOne(b)) return a;
    if (isOne(a)) return b;
  } else {
    // shift: `x << 0` is `x`, `0 << k` is `0`.
    if (isZero(b)) return a;
    if (isZero(a)) return constOf(ty, ty === 'i64' ? 0n : 0);
  }
  const res = idCtr.n++;
  fn.valueType.set(res, ty);
  ph.insts.push({ res, ty, kind: 'ibin', sub: op, args: [a, b] });
  return { tag: 'val', id: res };
}
