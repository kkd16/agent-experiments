// Division / remainder by a constant — strength reduction.
//
// Hardware integer division is one of the most expensive scalar operations, an
// order of magnitude slower than a multiply. Every serious compiler therefore
// turns a division (or remainder) by a *constant* into a short sequence of
// cheap multiplies, shifts and adds. This pass implements the two classic
// lowerings, each an **exact algebraic identity** — never an approximation — so
// the differential oracle (interpreter == wasm at every opt level) proves it.
//
//   * **Power-of-two** divisors lower to an arithmetic shift with the standard
//     round-toward-zero bias correction (`x < 0 ? x + (2^k - 1) : x) >> k`),
//     expressed without an unsigned shift (the IR has none) by masking the
//     sign-broadcast `x >> (w-1)` with `2^k - 1`.
//   * **General** (non-power-of-two) i32 divisors lower to the signed
//     magic-number multiply of Hacker's Delight (Warren), §10-3: a high-word
//     multiply by a precomputed constant `M`, an optional add/sub of the
//     dividend, an arithmetic shift, and a final sign-bit add. The high word of
//     a signed 32x32 product is computed exactly by widening to i64, multiplying
//     and shifting right by 32 — so it needs no dedicated `mulhi` opcode.
//
// Remainder reuses the quotient: `x % d == x - (x / d) * d`, which is cheaper
// than a hardware remainder and lets the shared quotient be CSE'd when both the
// quotient and the remainder of the same operands appear (`divmod`).
//
// **Trap preservation.** Signed division traps only on `x / 0` and
// `INT_MIN / -1`. This pass fires only when `|d| >= 2` (and `d != INT_MIN`), a
// range in which the original division can never trap — so replacing it with
// non-trapping arithmetic cannot remove a trap the program would have raised.
// `d == 1` and `d == -1` are handled as identities below; `d == 0` is left
// untouched so its trap survives.

import type { Inst, IRFunc, IRType, Operand } from '../ir/ir';

// --- fresh value ids -------------------------------------------------------

function maxValueId(fn: IRFunc): number {
  let m = -1;
  for (const k of fn.valueType.keys()) if (k > m) m = k;
  for (const b of fn.blocks) {
    for (const p of b.phis) if (p.res > m) m = p.res;
    for (const i of b.insts) if (i.res !== null && i.res > m) m = i.res;
  }
  return m;
}

// A tiny straight-line instruction emitter. Each call allocates a fresh SSA
// value of the given type, records its type, appends the instruction to a local
// buffer, and returns it as an operand ready to feed the next one.
class Emitter {
  insts: Inst[] = [];
  private fn: IRFunc;
  private next: number;
  constructor(fn: IRFunc, next: number) {
    this.fn = fn;
    this.next = next;
  }
  private fresh(ty: IRType): number {
    const id = this.next++;
    this.fn.valueType.set(id, ty);
    return id;
  }
  emit(ty: IRType, kind: Inst['kind'], sub: string, args: Operand[]): Operand {
    const res = this.fresh(ty);
    this.insts.push({ res, ty, kind, sub, args });
    return { tag: 'val', id: res };
  }
  /** Emit the *final* instruction of an expansion, reusing the original result
   *  id `res` so every existing use keeps working untouched. */
  emitInto(res: number, ty: IRType, kind: Inst['kind'], sub: string, args: Operand[]): void {
    this.insts.push({ res, ty, kind, sub, args });
  }
  /** Make the value `op` available under id `res`. If `op` is exactly the last
   *  instruction's freshly-allocated result, retarget that instruction (no extra
   *  copy); otherwise emit a forwarding copy. */
  aliasResult(op: Operand, res: number, ty: IRType): void {
    const last = this.insts[this.insts.length - 1];
    if (op.tag === 'val' && last && last.res === op.id) last.res = res;
    else this.insts.push({ res, ty, kind: 'copy', sub: '', args: [op] });
  }
  get nextId(): number {
    return this.next;
  }
}

const ci32 = (n: number): Operand => ({ tag: 'const', ty: 'i32', num: n | 0 });
const ci64 = (n: bigint): Operand => ({ tag: 'const', ty: 'i64', num: BigInt.asIntN(64, n) });

// --- signed magic numbers (Hacker's Delight, fig. 10-1) --------------------
//
// Computed in BigInt with explicit 32-bit unsigned masking so it reproduces the
// reference C (unsigned int) arithmetic exactly. Valid for any `d` with
// `|d| >= 2` (callers exclude 0, ±1 and INT_MIN). Returns the magic multiplier
// `M` (a signed 32-bit value, possibly negative) and the post-shift `s` in
// `[0, 31]`.
function magicS32(d: number): { M: number; s: number } {
  const U32 = (x: bigint): bigint => x & 0xffffffffn;
  const two31 = 0x80000000n;
  const ad = BigInt(Math.abs(d)); // |d|, fits in 32 bits since d != INT_MIN
  const dU = BigInt(d >>> 0); // d reinterpreted as unsigned 32-bit
  const t = two31 + (dU >> 31n); // 2^31 + (sign bit of d)
  const anc = t - 1n - (t % ad); // |nc|, the largest multiple-of-d boundary
  let p = 31n;
  let q1 = two31 / anc;
  let r1 = two31 - q1 * anc;
  let q2 = two31 / ad;
  let r2 = two31 - q2 * ad;
  let delta: bigint;
  do {
    p += 1n;
    q1 = U32(2n * q1);
    r1 = U32(2n * r1);
    if (r1 >= anc) {
      q1 += 1n;
      r1 -= anc;
    }
    q2 = U32(2n * q2);
    r2 = U32(2n * r2);
    if (r2 >= ad) {
      q2 += 1n;
      r2 -= ad;
    }
    delta = ad - r2;
  } while (q1 < delta || (q1 === delta && r1 === 0n));
  let M = Number(BigInt.asIntN(32, U32(q2 + 1n))); // signed 32-bit magic
  if (d < 0) M = (-M) | 0; // negate (wraps in the M == INT_MIN edge, matching C)
  return { M, s: Number(p - 32n) };
}

// The 64-bit analogue (Hacker's Delight §10-15). Same recurrence, scaled to
// 2^63. Returns a signed 64-bit `M` (a BigInt) and a post-shift `s` in [0, 63].
// Valid for any `d` with `|d| >= 2`, `d != I64_MIN`.
function magicS64(d: bigint): { M: bigint; s: number } {
  const U = (x: bigint): bigint => BigInt.asUintN(64, x);
  const two63 = 1n << 63n;
  const ad = d < 0n ? -d : d;
  const dU = U(d);
  const t = U(two63 + (dU >> 63n));
  const anc = U(t - 1n - (t % ad));
  let p = 63n;
  let q1 = two63 / anc;
  let r1 = U(two63 - q1 * anc);
  let q2 = two63 / ad;
  let r2 = U(two63 - q2 * ad);
  let delta: bigint;
  do {
    p += 1n;
    q1 = U(2n * q1);
    r1 = U(2n * r1);
    if (r1 >= anc) {
      q1 += 1n;
      r1 -= anc;
    }
    q2 = U(2n * q2);
    r2 = U(2n * r2);
    if (r2 >= ad) {
      q2 += 1n;
      r2 -= ad;
    }
    delta = ad - r2;
  } while (q1 < delta || (q1 === delta && r1 === 0n));
  let M = BigInt.asIntN(64, U(q2 + 1n));
  if (d < 0n) M = BigInt.asIntN(64, -M);
  return { M, s: Number(p - 64n) };
}

// --- helpers ---------------------------------------------------------------

function log2Pow2(n: number): number | null {
  if (n <= 0 || (n & (n - 1)) !== 0) return null;
  return Math.log2(n) | 0;
}
function log2Pow2_64(n: bigint): number | null {
  if (n <= 0n || (n & (n - 1n)) !== 0n) return null;
  return n.toString(2).length - 1;
}

/** Build the i32 quotient `x / d` into `e`, returning the quotient operand.
 *  Precondition: `|d| >= 2` and `d != INT_MIN`. */
function quotient32(e: Emitter, x: Operand, d: number): Operand {
  const k = log2Pow2(Math.abs(d));
  if (k !== null) {
    // Power of two: bias = (x >> 31) & (2^k - 1)  (== 2^k-1 if x<0 else 0).
    const sign = e.emit('i32', 'ibin', 'shr_s', [x, ci32(31)]);
    const bias = e.emit('i32', 'ibin', 'and', [sign, ci32((1 << k) - 1)]);
    const biased = e.emit('i32', 'ibin', 'add', [x, bias]);
    const q = e.emit('i32', 'ibin', 'shr_s', [biased, ci32(k)]);
    return d < 0 ? e.emit('i32', 'ibin', 'sub', [ci32(0), q]) : q;
  }
  // General divisor: signed high-word multiply by the magic constant.
  const { M, s } = magicS32(d);
  const x64 = e.emit('i64', 'cast', 'i2l', [x]); // sign-extend x to i64
  const prod = e.emit('i64', 'ibin', 'mul', [x64, ci64(BigInt(M))]);
  const hi64 = e.emit('i64', 'ibin', 'shr_s', [prod, ci64(32n)]); // arithmetic >> 32
  let q = e.emit('i32', 'cast', 'l2i', [hi64]); // = signed mulhi(M, x)
  // Correction adds when the magic and the divisor disagree in sign.
  if (d > 0 && M < 0) q = e.emit('i32', 'ibin', 'add', [q, x]);
  else if (d < 0 && M > 0) q = e.emit('i32', 'ibin', 'sub', [q, x]);
  if (s > 0) q = e.emit('i32', 'ibin', 'shr_s', [q, ci32(s)]);
  // Add the sign bit: q += (unsigned)q >> 31, written as (q >> 31) & 1.
  const qs = e.emit('i32', 'ibin', 'shr_s', [q, ci32(31)]);
  const signBit = e.emit('i32', 'ibin', 'and', [qs, ci32(1)]);
  return e.emit('i32', 'ibin', 'add', [q, signBit]);
}

/** Build the i64 quotient `x / d` for a power-of-two `d` into `e`.
 *  Precondition: `|d|` is a power of two, `|d| >= 2`, `d != I64_MIN`. */
function quotient64Pow2(e: Emitter, x: Operand, d: bigint, k: number): Operand {
  const sign = e.emit('i64', 'ibin', 'shr_s', [x, ci64(63n)]);
  const bias = e.emit('i64', 'ibin', 'and', [sign, ci64((1n << BigInt(k)) - 1n)]);
  const biased = e.emit('i64', 'ibin', 'add', [x, bias]);
  const q = e.emit('i64', 'ibin', 'shr_s', [biased, ci64(BigInt(k))]);
  return d < 0n ? e.emit('i64', 'ibin', 'sub', [ci64(0n), q]) : q;
}

const MASK64 = 0xffffffffn;
const lo32 = (e: Emitter, v: Operand): Operand => e.emit('i64', 'ibin', 'and', [v, ci64(MASK64)]);
// The high 32 bits of a 64-bit value, as an unsigned [0, 2^32) i64 — extracted
// with an *arithmetic* shift then a mask, since the IR has no logical shift. The
// mask discards the sign-fill, leaving exactly the original bits [32, 63].
const hi32 = (e: Emitter, v: Operand): Operand =>
  e.emit('i64', 'ibin', 'and', [e.emit('i64', 'ibin', 'shr_s', [v, ci64(32n)]), ci64(MASK64)]);
const add64 = (e: Emitter, a: Operand, b: Operand): Operand => e.emit('i64', 'ibin', 'add', [a, b]);
const mul64 = (e: Emitter, a: Operand, b: Operand): Operand => e.emit('i64', 'ibin', 'mul', [a, b]);

/** The signed high 64 bits of the 128-bit product `a * b`, synthesized from
 *  i64 ops alone (wasm has no `i64.mulhi`). Schoolbook 32x32 limb multiply for
 *  the *unsigned* high word, then the two signed-correction subtractions
 *  `hi - (a<0 ? b : 0) - (b<0 ? a : 0)`. Proven exact against a 128-bit BigInt
 *  reference over millions of random and edge inputs. */
function smulhi64(e: Emitter, a: Operand, b: Operand): Operand {
  const aLo = lo32(e, a);
  const aHi = hi32(e, a);
  const bLo = lo32(e, b);
  const bHi = hi32(e, b);
  const ll = mul64(e, aLo, bLo);
  const lh = mul64(e, aLo, bHi);
  const hl = mul64(e, aHi, bLo);
  const hh = mul64(e, aHi, bHi);
  const cross = add64(e, add64(e, hi32(e, ll), lo32(e, lh)), lo32(e, hl));
  const uhi = add64(e, add64(e, add64(e, hh, hi32(e, lh)), hi32(e, hl)), hi32(e, cross));
  // signed correction: subtract b when a<0, and a when b<0 (mask by sign-broadcast)
  const t1 = e.emit('i64', 'ibin', 'and', [e.emit('i64', 'ibin', 'shr_s', [a, ci64(63n)]), b]);
  const t2 = e.emit('i64', 'ibin', 'and', [e.emit('i64', 'ibin', 'shr_s', [b, ci64(63n)]), a]);
  return e.emit('i64', 'ibin', 'sub', [e.emit('i64', 'ibin', 'sub', [uhi, t1]), t2]);
}

/** Build the i64 quotient `x / d` for a general (non-power-of-two) constant via
 *  the 64-bit signed magic-number multiply. Precondition: `|d| >= 2`,
 *  `d != I64_MIN`, `d` not a power of two. */
function quotient64Magic(e: Emitter, x: Operand, d: bigint): Operand {
  const { M, s } = magicS64(d);
  let q = smulhi64(e, ci64(M), x);
  if (d > 0n && M < 0n) q = e.emit('i64', 'ibin', 'add', [q, x]);
  else if (d < 0n && M > 0n) q = e.emit('i64', 'ibin', 'sub', [q, x]);
  if (s > 0) q = e.emit('i64', 'ibin', 'shr_s', [q, ci64(BigInt(s))]);
  const qs = e.emit('i64', 'ibin', 'shr_s', [q, ci64(63n)]);
  const signBit = e.emit('i64', 'ibin', 'and', [qs, ci64(1n)]);
  return e.emit('i64', 'ibin', 'add', [q, signBit]);
}

// --- the pass --------------------------------------------------------------

export function divRemByConst(fn: IRFunc): number {
  let changed = 0;
  const ctr = { n: maxValueId(fn) + 1 };

  for (const b of fn.blocks) {
    let touched = false;
    const out: Inst[] = [];
    for (const inst of b.insts) {
      const expanded = tryExpand(fn, inst, ctr);
      if (expanded) {
        out.push(...expanded);
        touched = true;
        changed++;
      } else {
        out.push(inst);
      }
    }
    if (touched) b.insts = out;
  }
  return changed;
}

/** If `inst` is a `div_s`/`rem_s` by a foldable constant, return the replacement
 *  instruction sequence (ending in one that defines `inst.res`); else null. */
function tryExpand(fn: IRFunc, inst: Inst, ctr: { n: number }): Inst[] | null {
  if (inst.kind !== 'ibin' || inst.res === null) return null;
  if (inst.sub !== 'div_s' && inst.sub !== 'rem_s') return null;
  const isRem = inst.sub === 'rem_s';
  const x = inst.args[0];
  const div = inst.args[1];
  if (div.tag !== 'const') return null;
  const res = inst.res;
  const ty = inst.ty as IRType;

  const e = new Emitter(fn, ctr.n);
  const finish = (): Inst[] => {
    ctr.n = e.nextId;
    return e.insts;
  };

  if (ty === 'i32') {
    const d = div.num as number;
    // Identities (each non-trapping for the values it fires on).
    if (d === 1) return [{ res, ty: 'i32', kind: 'copy', sub: '', args: [isRem ? ci32(0) : x] }];
    if (d === -1) {
      if (isRem) return [{ res, ty: 'i32', kind: 'copy', sub: '', args: [ci32(0)] }];
      return null; // x / -1 can trap (INT_MIN) — leave it to the hardware op
    }
    if (d === 0 || d === -2147483648 || Math.abs(d) < 2) return null;

    const q = quotient32(e, x, d);
    if (!isRem) {
      e.aliasResult(q, res, 'i32');
      return finish();
    }
    // remainder = x - q * d
    const qd = e.emit('i32', 'ibin', 'mul', [q, ci32(d)]);
    e.emitInto(res, 'i32', 'ibin', 'sub', [x, qd]);
    return finish();
  }

  if (ty === 'i64') {
    const d = div.num as bigint;
    const I64_MIN = -(2n ** 63n);
    if (d === 1n) return [{ res, ty: 'i64', kind: 'copy', sub: '', args: [isRem ? ci64(0n) : x] }];
    if (d === -1n) {
      if (isRem) return [{ res, ty: 'i64', kind: 'copy', sub: '', args: [ci64(0n)] }];
      return null;
    }
    if (d === 0n || d === I64_MIN) return null;
    const k = log2Pow2_64(d < 0n ? -d : d);
    const q = k !== null ? quotient64Pow2(e, x, d, k) : quotient64Magic(e, x, d);
    if (!isRem) {
      e.aliasResult(q, res, 'i64');
      return finish();
    }
    const qd = e.emit('i64', 'ibin', 'mul', [q, ci64(d)]);
    e.emitInto(res, 'i64', 'ibin', 'sub', [x, qd]);
    return finish();
  }

  return null;
}
