import type { Block, Inst, IRFunc, Operand } from '../ir/ir';
import { eachOperand } from '../ir/ir';
import { maxValueId } from './optimize';
import { i32 } from '../interp';

// =====================================================================
// Reassociation — canonicalize integer affine expression trees
// =====================================================================
//
// A classic mid-end canonicalization (LLVM's `-reassociate`, Briggs & Cooper,
// *Effective Partial Redundancy Elimination*, PLDI'94). An integer add/sub/×-const
// expression is a **linear combination** `c1·x1 + c2·x2 + … + K` of atoms `xi`
// (opaque sub-values) and a constant `K`. This pass flattens such a tree into that
// canonical form — summing the coefficients of like atoms, folding every scattered
// constant into one `K`, and distributing a constant multiply over a sum — then
// rebuilds the smallest expression that computes it. The payoff is threefold:
//
//   • scattered constants collapse:      `(a + 3) + (b + 5)`      → `a + b + 8`
//   • like terms collect:                `x*8 + x*1024 + 2*x`     → `x * 1034`
//   • multiplicative const chains fold:  `(i*4) * 3`              → `i * 12`
//   • a constant distributes over a sum: `(i + 1) * r`           → `i*r + r`
//
// The last is exactly what surfaces fresh induction-variable × region-constant
// candidates for **OSR** (`opt/osr.ts`); the collected, canonically-ordered terms
// also let **GVN/CSE** recognize more equal expressions. Reassociation runs just
// before GVN and OSR at -O2+ so both see the canonical form.
//
// Why it is exact (and the differential oracle can't be fooled): every rewrite is
// an identity in the wrapping integer ring Z/2^w. Addition is associative and
// commutative mod 2^w; multiplication distributes over addition mod 2^w
// (`c·(a+b) ≡ c·a + c·b`); and a left shift `x << k` is the multiply `x · 2^(k mod w)`.
// Coefficients are combined with the *same* wrapping arithmetic the backend emits
// (`Math.imul` for i32, `BigInt.asIntN(64, …)` for i64), so `a·x + b·x` and
// `(a+b)·x` are the identical 2^w-residue. Multiply, shift and add never trap, so no
// trap is invented or erased. **Floats are excluded** — FP rounding breaks both
// associativity and distributivity. Only single-use, same-block nodes are ever
// decomposed (a multi-use value stays an opaque atom), so no shared computation is
// duplicated and SSA validity is preserved; the now-dead chain falls to DCE.
//
// The rewrite only fires when the rebuilt expression is **strictly smaller** than
// the chain it consumed, so the pass both can only improve code and is guaranteed
// to terminate (total instruction count strictly decreases each time it fires).

type IntTy = 'i32' | 'i64';

/** Number for i32, bigint for i64 — the constant payload of the value type. */
type Num = number | bigint;

// --- wrapping ring arithmetic, matching the backend / interpreter exactly ------
const wadd = (ty: IntTy, a: Num, b: Num): Num =>
  ty === 'i64' ? BigInt.asIntN(64, (a as bigint) + (b as bigint)) : i32((a as number) + (b as number));
const wmul = (ty: IntTy, a: Num, b: Num): Num =>
  ty === 'i64' ? BigInt.asIntN(64, (a as bigint) * (b as bigint)) : Math.imul(a as number, b as number);
const wneg = (ty: IntTy, a: Num): Num =>
  ty === 'i64' ? BigInt.asIntN(64, -(a as bigint)) : i32(-(a as number));
const zero = (ty: IntTy): Num => (ty === 'i64' ? 0n : 0);
const one = (ty: IntTy): Num => (ty === 'i64' ? 1n : 1);
const isZero = (ty: IntTy, n: Num): boolean => (ty === 'i64' ? n === 0n : n === 0);
const isOne = (ty: IntTy, n: Num): boolean => (ty === 'i64' ? n === 1n : n === 1);
const isNeg = (ty: IntTy, n: Num): boolean => (ty === 'i64' ? (n as bigint) < 0n : (n as number) < 0);
/** The wrapping coefficient of `x << k` for a constant shift `k`: `2^(k mod w)`. */
const shlCoeff = (ty: IntTy, k: Num): Num =>
  ty === 'i64' ? BigInt.asIntN(64, 1n << ((k as bigint) & 63n)) : i32(1 << ((k as number) & 31));

/** A canonicalized linear combination: `Σ terms[atom]·atom + K` over one type. */
interface LinForm {
  terms: Map<number, Num>; // atom SSA value id -> coefficient
  K: Num; // the folded constant
}

const constOp = (ty: IntTy, num: Num): Operand => ({ tag: 'const', ty, num });

export function reassociate(fn: IRFunc): number {
  let changedTotal = 0;
  const idCtr = { n: maxValueId(fn) + 1 };

  // Total use count of every value (single-use is the precondition for absorbing
  // a node into a chain — a multi-use node stays an opaque atom).
  const uses = new Map<number, number>();
  for (const b of fn.blocks) eachOperand(b, (o) => { if (o.tag === 'val') uses.set(o.id, (uses.get(o.id) ?? 0) + 1); });

  for (const block of fn.blocks) {
    // Index this block's value-defining instructions; only same-block, single-use
    // nodes are decomposable, so a per-block map is all the flattener needs.
    const defs = new Map<number, Inst>();
    for (const i of block.insts) if (i.res !== null) defs.set(i.res, i);

    const rewrites: { rootRes: number; insts: Inst[]; result: Operand }[] = [];

    for (const inst of block.insts) {
      if (inst.res === null) continue;
      const ty = inst.ty;
      if (ty !== 'i32' && ty !== 'i64') continue;
      if (!isReassocRoot(inst)) continue;
      // Skip a node that is itself a single-use operand of another reassoc root in
      // this block — its parent will absorb it, so processing it here is wasted.
      if ((uses.get(inst.res) ?? 0) === 1 && consumedByParent(inst.res, block, defs, uses)) continue;

      const absorbed = new Set<number>();
      const form = flatten({ tag: 'val', id: inst.res }, ty, defs, uses, absorbed, true);
      // `absorbed` holds every node decomposed *under* the root; the root counts too.
      absorbed.add(inst.res);

      const built = build(fn, form, ty, idCtr);
      // Fire only when the rebuilt expression is strictly smaller than the chain it
      // replaces — guarantees monotone progress (termination) and net improvement.
      if (built.insts.length < absorbed.size) {
        rewrites.push({ rootRes: inst.res, insts: built.insts, result: built.result });
      }
    }

    if (rewrites.length === 0) continue;

    // Splice each rebuilt expression in at its root's position (so its operands —
    // all defined earlier — still dominate it), leaving the now-dead original chain
    // for DCE, then point every use of the old root at the new value.
    const emitAt = new Map<number, Inst[]>();
    const resultOf = new Map<number, Operand>();
    for (const r of rewrites) { emitAt.set(r.rootRes, r.insts); resultOf.set(r.rootRes, r.result); }
    const next: Inst[] = [];
    for (const inst of block.insts) {
      if (inst.res !== null && emitAt.has(inst.res)) {
        next.push(...emitAt.get(inst.res)!);
      }
      next.push(inst); // keep the original (dead) root; DCE reclaims it
    }
    block.insts = next;
    for (const r of rewrites) changedTotal += replaceAllUses(fn, r.rootRes, resultOf.get(r.rootRes)!);
  }

  return changedTotal;
}

/** Roots are integer add/sub, or a mul/shl that has a constant operand (a monomial). */
function isReassocRoot(inst: Inst): boolean {
  if (inst.kind !== 'ibin') return false;
  if (inst.sub === 'add' || inst.sub === 'sub') return true;
  if (inst.sub === 'mul') return inst.args[0].tag === 'const' || inst.args[1].tag === 'const';
  if (inst.sub === 'shl') return inst.args[1].tag === 'const';
  return false;
}

/** Is `res`'s single use as an operand of a reassoc root defined in this block? */
function consumedByParent(res: number, block: Block, defs: Map<number, Inst>, uses: Map<number, number>): boolean {
  for (const inst of block.insts) {
    if (inst.res === null) continue;
    if (inst.args.some((o) => o.tag === 'val' && o.id === res)) {
      return isReassocRoot(inst) && wouldDecompose(inst, defs, uses);
    }
  }
  return false;
}

/** Whether the flattener would recurse into `inst` (vs. treat it as an opaque atom). */
function wouldDecompose(inst: Inst, defs: Map<number, Inst>, uses: Map<number, number>): boolean {
  // The root itself is always decomposed; this only guards *child* recursion, where
  // single-use + same-block (already true: it's in `defs`) is the rule.
  return inst.res !== null && (uses.get(inst.res) ?? 0) <= 1 && defs.has(inst.res);
}

/**
 * Flatten `op` (scaled by ±1 via `sign`) into a linear form. Recurses through
 * single-use, same-block add/sub and constant-scaled mul/shl; everything else
 * (a load, a call, a multi-use value, a cross-block def, a mul of two unknowns)
 * is an opaque atom. `isRoot` permits decomposing the top node even though it is
 * (legitimately) multi-use.
 */
function flatten(
  op: Operand,
  ty: IntTy,
  defs: Map<number, Inst>,
  uses: Map<number, number>,
  absorbed: Set<number>,
  isRoot = false,
): LinForm {
  if (op.tag === 'const') return { terms: new Map(), K: op.num };

  const def = defs.get(op.id);
  const decomposable = def && (isRoot || (uses.get(op.id) ?? 0) <= 1);
  if (!def || !decomposable || def.kind !== 'ibin') return atom(ty, op.id);

  if (!isRoot) absorbed.add(op.id);
  const [x, y] = def.args;
  switch (def.sub) {
    case 'add':
      return merge(ty, flatten(x, ty, defs, uses, absorbed), flatten(y, ty, defs, uses, absorbed));
    case 'sub':
      return merge(ty, flatten(x, ty, defs, uses, absorbed), scale(ty, flatten(y, ty, defs, uses, absorbed), wneg(ty, one(ty))));
    case 'mul': {
      if (x.tag === 'const') return scale(ty, flatten(y, ty, defs, uses, absorbed), x.num);
      if (y.tag === 'const') return scale(ty, flatten(x, ty, defs, uses, absorbed), y.num);
      if (!isRoot) absorbed.delete(op.id);
      return atom(ty, op.id); // mul of two unknowns — opaque
    }
    case 'shl': {
      if (y.tag === 'const') return scale(ty, flatten(x, ty, defs, uses, absorbed), shlCoeff(ty, y.num));
      if (!isRoot) absorbed.delete(op.id);
      return atom(ty, op.id);
    }
    default:
      if (!isRoot) absorbed.delete(op.id);
      return atom(ty, op.id);
  }
}

const atom = (ty: IntTy, id: number): LinForm => ({ terms: new Map([[id, one(ty)]]), K: zero(ty) });

function merge(ty: IntTy, a: LinForm, b: LinForm): LinForm {
  const terms = new Map(a.terms);
  for (const [id, c] of b.terms) terms.set(id, wadd(ty, terms.get(id) ?? zero(ty), c));
  return { terms, K: wadd(ty, a.K, b.K) };
}

function scale(ty: IntTy, f: LinForm, factor: Num): LinForm {
  const terms = new Map<number, Num>();
  for (const [id, c] of f.terms) terms.set(id, wmul(ty, c, factor));
  return { terms, K: wmul(ty, f.K, factor) };
}

/**
 * Emit the canonical, minimal instruction sequence for a linear form. Atoms are
 * laid out by ascending id (deterministic, so re-running is a fixpoint): positive
 * coefficients are summed first, then the constant, then negative coefficients are
 * subtracted (a `c·x` with `|c| ≠ 1` becomes a `mul`, which a later strength-reduce
 * pass may turn back into a shift if `|c|` is a power of two).
 */
function build(fn: IRFunc, form: LinForm, ty: IntTy, idCtr: { n: number }): { insts: Inst[]; result: Operand } {
  const insts: Inst[] = [];
  const emit = (sub: string, args: Operand[]): Operand => {
    const res = idCtr.n++;
    fn.valueType.set(res, ty);
    insts.push({ res, ty, kind: 'ibin', sub, args });
    return { tag: 'val', id: res };
  };

  // `c·x` as an operand: x for c=1, -x handled by the caller (subtraction), else a mul.
  const term = (id: number, coeff: Num): Operand =>
    isOne(ty, coeff) ? { tag: 'val', id } : emit('mul', [{ tag: 'val', id }, constOp(ty, coeff)]);

  const ids = [...form.terms.keys()].filter((id) => !isZero(ty, form.terms.get(id)!)).sort((p, q) => p - q);
  const pos = ids.filter((id) => !isNeg(ty, form.terms.get(id)!));
  const neg = ids.filter((id) => isNeg(ty, form.terms.get(id)!));

  let acc: Operand | null = null;
  for (const id of pos) {
    const t = term(id, form.terms.get(id)!);
    acc = acc === null ? t : emit('add', [acc, t]);
  }
  if (!isZero(ty, form.K)) {
    const kc = constOp(ty, form.K);
    acc = acc === null ? kc : emit('add', [acc, kc]);
  }
  for (const id of neg) {
    // `-c·x` (c>0): subtract the magnitude (so `mul` keeps a positive constant).
    const mag = wneg(ty, form.terms.get(id)!);
    const t = isOne(ty, mag) ? ({ tag: 'val', id } as Operand) : emit('mul', [{ tag: 'val', id }, constOp(ty, mag)]);
    acc = acc === null ? emit('sub', [constOp(ty, zero(ty)), t]) : emit('sub', [acc, t]);
  }
  if (acc === null) acc = constOp(ty, zero(ty)); // everything cancelled
  return { insts, result: acc };
}

/** Replace every use of value `fromId` with `to` (a fresh clone per slot). */
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
