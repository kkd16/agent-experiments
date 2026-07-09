import type { Inst, IRFunc, Operand } from '../ir/ir';
import { eachOperand } from '../ir/ir';
import { computeDom } from '../ir/cfg';

// =====================================================================
// Known-bits — a bitwise (congruence) lattice analysis
// =====================================================================
//
// VRP (`opt/vrp.ts`) reasons about the *magnitude* of an integer — a signed
// interval `[lo, hi]`. This pass is its orthogonal twin: it reasons about the
// individual *bits*. Every i32 / i64 SSA value is assigned a pair of `W`-bit
// masks — `z` (bits proven 0 on every execution) and `o` (bits proven 1) — a
// sound **must**-over-approximation exactly analogous to LLVM's `KnownBits` /
// GCC's bit-CCP. A bit set in neither mask is unknown. The invariant `z & o == 0`
// holds by construction: no bit is ever proven both 0 and 1.
//
// The two analyses see facts the other is blind to. VRP knows `x & 7 ∈ [0, 7]`
// but not that its top bits are *zero*; known-bits knows `(x << 8)` has eight
// zero low bits but nothing about its magnitude. Bit facts unlock rewrites an
// interval can't express:
//
//   • a value whose every bit is known collapses to a **constant** — even when it
//     was computed through masks/shifts/xors that defeat SCCP (which only folds
//     when *operands* are already constant) and VRP (a full 32-bit range says
//     nothing). `((x << 8) | (x & 0xff)) & 0xff00 >> 8`-style bit plumbing folds.
//   • a **redundant mask** `x & C` where the bits outside `C` are already known
//     zero is the identity — drop the `and`. Symmetrically `x | C` where `C`'s
//     bits are already known one, and `x ^ C` where the toggled bits are known.
//   • an **`==` / `!=`** whose operands disagree on a single known bit is decided
//     (`(x | 1) == 0` is always false — parity VRP's disjoint-range test misses).
//
// ## Soundness
//
// Known-bits is a modular (per-bit) domain, so wasm's wrapping integer semantics
// need no special care — every transfer works in the `W`-bit ring where the wrap
// already lives. Each transfer is a sound must-fact: a bit is claimed known only
// when it is forced on *every* execution. Control-flow merges take the **meet**
// (bitwise agreement: `z = ⋀ zᵢ`, `o = ⋀ oᵢ`) over the incoming values — a bit
// survives only where every path agrees. Because the analysis is flow-insensitive
// in its *result* (a value's known bits are computed from its operands' known
// bits, with no path assumption folded in) and a definition dominates all its
// uses, `defKB[v]` is valid at every use of `v` — so every rewrite is
// unconditional and behaviour-preserving. Loop-carried φs whose latch operand is
// not yet computed fall to ⊤ (all-unknown), which both keeps the single
// reverse-postorder sweep a fixpoint and every fact an over-approximation. The
// rewrites are pinned bit-for-bit by the triple differential oracle (interpreter
// ≡ host wasm ≡ from-scratch VM) at every optimization level, plus a dedicated
// seeded bit-twiddling fuzzer (`tools/check-knownbits.mjs`).

export interface KB {
  z: bigint; // bits proven 0
  o: bigint; // bits proven 1
}

const TOP: KB = { z: 0n, o: 0n };

function maskOf(W: 32 | 64): bigint {
  return (1n << BigInt(W)) - 1n;
}

/** The integer width of an operand, or null for a float / vector / unknown value. */
function intWidth(fn: IRFunc, op: Operand): 32 | 64 | null {
  const t = op.tag === 'const' ? op.ty : fn.valueType.get(op.id);
  return t === 'i32' ? 32 : t === 'i64' ? 64 : null;
}

/** Known bits of a literal: every bit is known. */
function fromConst(num: number | bigint, W: 32 | 64): KB {
  const m = maskOf(W);
  const v = (typeof num === 'bigint' ? num : BigInt(num)) & m;
  return { z: m ^ v, o: v };
}

const knownMask = (k: KB): bigint => k.z | k.o;
const isFull = (k: KB, m: bigint): boolean => knownMask(k) === m;

/** Bitwise meet — a bit survives only where both agree (⋀ over paths). */
function meet(a: KB, b: KB): KB {
  return { z: a.z & b.z, o: a.o & b.o };
}

/** Count of contiguous known-zero low bits (the guaranteed 2-adic valuation). */
function trailingKnownZeros(k: KB, W: 32 | 64): number {
  let n = 0;
  while (n < W && (k.z & (1n << BigInt(n))) !== 0n) n++;
  return n;
}
/** Count of contiguous low bits known in *both* operands (either 0 or 1). */
function commonKnownLow(a: KB, b: KB, W: 32 | 64): number {
  const common = knownMask(a) & knownMask(b);
  let n = 0;
  while (n < W && (common & (1n << BigInt(n))) !== 0n) n++;
  return n;
}

// --- transfer functions --------------------------------------------------------

function transferIBin(sub: string, X: KB, Y: KB, W: 32 | 64): KB {
  const m = maskOf(W);
  switch (sub) {
    case 'and':
      return { z: (X.z | Y.z) & m, o: X.o & Y.o & m };
    case 'or':
      return { z: X.z & Y.z & m, o: (X.o | Y.o) & m };
    case 'xor': {
      const k = knownMask(X) & knownMask(Y); // bits known in both
      const o = (X.o ^ Y.o) & k;
      return { z: k & ~o & m, o };
    }
    case 'shl': {
      // Only a *constant* shift amount is tracked; the wasm shift count is taken
      // mod W, so an out-of-range literal isn't a simple left shift — decline it.
      if (!isFull(Y, m)) return TOP;
      const kk = Number(Y.o & 63n);
      if (kk < 0 || kk >= W) return TOP;
      const s = BigInt(kk);
      const low = (1n << s) - 1n; // the freshly shifted-in low bits are zero
      return { z: (((X.z << s) & m) | low), o: (X.o << s) & m };
    }
    case 'shr_s': {
      if (!isFull(Y, m)) return TOP;
      const kk = Number(Y.o & 63n);
      if (kk <= 0 || kk >= W) return kk === 0 ? X : TOP;
      const s = BigInt(kk);
      const lowMask = (1n << BigInt(W - kk)) - 1n; // result bits [0, W-kk)
      const topMask = m & ~lowMask; // sign-filled bits [W-kk, W)
      let z = (X.z >> s) & lowMask;
      let o = (X.o >> s) & lowMask;
      const sign = 1n << BigInt(W - 1);
      if ((X.z & sign) !== 0n) z |= topMask; // sign known 0
      else if ((X.o & sign) !== 0n) o |= topMask; // sign known 1
      return { z, o };
    }
    case 'add':
    case 'sub': {
      // The low `j` bits — where both operands are fully known — are exact: the
      // carry/borrow into bit `j` depends only on lower bits, all known. Bits at
      // and above `j` are unknown. This is the alignment-carrying rule that gives
      // `(a<<2) + (b<<2)` two known-zero low bits.
      const j = commonKnownLow(X, Y, W);
      if (j === 0) return TOP;
      const lowMask = (1n << BigInt(j)) - 1n;
      const xl = X.o & lowMask;
      const yl = Y.o & lowMask;
      const s = (sub === 'add' ? xl + yl : xl - yl) & lowMask;
      return { z: (lowMask & ~s), o: s };
    }
    case 'mul': {
      // The 2-adic valuation of a product is the sum of the factors' valuations,
      // so guaranteed trailing zeros add (capped at the width).
      const t = Math.min(trailingKnownZeros(X, W) + trailingKnownZeros(Y, W), W);
      return { z: (1n << BigInt(t)) - 1n, o: 0n };
    }
    default:
      return TOP; // div_s / rem_s: bit structure is not tracked (VRP owns ranges here)
  }
}

/** i32 boolean result of an `icmp`, decided by known bits where possible. */
function transferICmp(sub: string, X: KB, Y: KB): KB {
  const bit0Unknown: KB = { z: maskOf(32) & ~1n, o: 0n }; // in {0,1}
  if (sub !== 'eq' && sub !== 'ne') return bit0Unknown;
  const both = knownMask(X) & knownMask(Y);
  const differ = (X.o ^ Y.o) & both; // a bit both know but on which they disagree
  // If any commonly-known bit disagrees, the operands can never be equal.
  if (differ !== 0n) return fromConst(sub === 'eq' ? 0 : 1, 32);
  return bit0Unknown;
}

function transferInst(fn: IRFunc, kbOf: (o: Operand) => KB, inst: Inst): KB {
  switch (inst.kind) {
    case 'copy':
      return kbOf(inst.args[0]);
    case 'select':
      return meet(kbOf(inst.args[0]), kbOf(inst.args[1])); // args[0]/[1] are the values, args[2] the condition
    case 'ibin': {
      const W = intWidth(fn, inst.args[0]);
      if (W === null) return TOP;
      return transferIBin(inst.sub, kbOf(inst.args[0]), kbOf(inst.args[1]), W);
    }
    case 'iunary': {
      // clz / ctz / popcnt all land in [0, W]; the result is small and
      // non-negative, so every bit above ⌈log2(W+1)⌉ is a known zero.
      const W = intWidth(fn, inst.args[0]);
      if (W === null) return TOP;
      const bits = BigInt(W).toString(2).length; // 6 for W=32, 7 for W=64
      const m = maskOf(W);
      return { z: m & ~((1n << BigInt(bits)) - 1n), o: 0n };
    }
    case 'icmp':
      return transferICmp(inst.sub, kbOf(inst.args[0]), kbOf(inst.args[1]));
    case 'cast': {
      if (inst.sub === 'i2l') {
        // Sign-extend i32 → i64: low 32 bits carry over, the top 32 replicate the
        // sign bit (known only if the source's bit 31 is known).
        const src = kbOf(inst.args[0]);
        const m32 = maskOf(32);
        const hi = maskOf(64) & ~m32;
        let z = src.z & m32;
        let o = src.o & m32;
        const sign = 1n << 31n;
        if ((src.z & sign) !== 0n) z |= hi;
        else if ((src.o & sign) !== 0n) o |= hi;
        return { z, o };
      }
      if (inst.sub === 'l2i') {
        // Wrap i64 → i32: keep the low 32 bits.
        const src = kbOf(inst.args[0]);
        const m32 = maskOf(32);
        return { z: src.z & m32, o: src.o & m32 };
      }
      return TOP; // i2f / f2i / f32c / v128: not an integer bit pattern we track
    }
    default:
      return TOP; // load / gget / call / callind / float / vector: unknown
  }
}

// --- the analysis --------------------------------------------------------------

/**
 * Compute the known-bits fact for every tracked SSA value: a map from value id to
 * its `{z, o}` masks. Absent ⇒ ⊤ (fully unknown). One reverse-postorder sweep —
 * non-back-edge operands are already computed (a def dominates its uses), so a
 * straight-line value and a non-loop merge see final operand facts; a loop φ whose
 * latch operand is still ⊤ stays ⊤. Shared by the optimization pass and the
 * in-app Known-Bits inspector.
 */
export function analyzeKnownBits(fn: IRFunc): Map<number, KB> {
  const dom = computeDom(fn);
  const byId = new Map(fn.blocks.map((b) => [b.id, b]));
  const defKB = new Map<number, KB>();

  const kbOf = (op: Operand): KB => {
    const W = intWidth(fn, op);
    if (W === null) return TOP;
    if (op.tag === 'const') return fromConst(op.num, W);
    return defKB.get(op.id) ?? TOP;
  };

  for (const id of dom.rpo) {
    const b = byId.get(id)!;
    for (const phi of b.phis) {
      const W = intWidth(fn, { tag: 'val', id: phi.res });
      if (W === null) continue;
      let acc: KB | null = null;
      let top = false;
      for (const inc of phi.incomings) {
        const r = kbOf(inc.val);
        acc = acc === null ? r : meet(acc, r);
        if (acc.z === 0n && acc.o === 0n) {
          top = true;
          break;
        }
      }
      if (!top && acc !== null) defKB.set(phi.res, acc);
    }
    for (const inst of b.insts) {
      if (inst.res === null) continue;
      const W = intWidth(fn, { tag: 'val', id: inst.res });
      if (W === null) continue;
      const r = transferInst(fn, kbOf, inst);
      if (r.z !== 0n || r.o !== 0n) defKB.set(inst.res, r);
    }
  }
  return defKB;
}

/** The integer width of a tracked value, or null. Exposed for the inspector. */
export function valueWidth(fn: IRFunc, id: number): 32 | 64 | null {
  return intWidth(fn, { tag: 'val', id });
}

// --- the pass ------------------------------------------------------------------

export function knownBits(fn: IRFunc): number {
  const defKB = analyzeKnownBits(fn);

  // --- apply -------------------------------------------------------------------
  let changed = 0;
  const replaceUses = (fromId: number, to: Operand): number => {
    let n = 0;
    for (const blk of fn.blocks)
      eachOperand(blk, (op, set) => {
        if (op.tag === 'val' && op.id === fromId) {
          set(to.tag === 'const' ? { tag: 'const', ty: to.ty, num: to.num } : { tag: 'val', id: to.id });
          n++;
        }
      });
    return n;
  };

  for (const b of fn.blocks) {
    for (const inst of b.insts) {
      if (inst.res === null) continue;
      const W = intWidth(fn, { tag: 'val', id: inst.res });
      if (W === null) continue;
      const kb = defKB.get(inst.res);
      if (!kb) continue;
      const m = maskOf(W);

      // (1) Every bit known ⇒ the value is a constant, whatever plumbing produced
      // it. Skip a plain `copy` (copy-prop owns that) and anything already const.
      if (inst.kind !== 'copy' && isFull(kb, m)) {
        const c: Operand =
          W === 64
            ? { tag: 'const', ty: 'i64', num: BigInt.asIntN(64, kb.o) }
            : { tag: 'const', ty: 'i32', num: Number(BigInt.asIntN(32, kb.o)) };
        const n = replaceUses(inst.res, c);
        if (n > 0) {
          changed += n;
          continue;
        }
      }

      // (2) Redundant bit-mask identities: a mask/set/toggle that provably does
      // nothing, because the affected bits are already known. Only for `x <op> C`
      // with a constant `C` — the general two-value case rarely arises post-GVN.
      if (inst.kind === 'ibin' && (inst.sub === 'and' || inst.sub === 'or' || inst.sub === 'xor')) {
        const [x, y] = inst.args;
        if (x.tag === 'val' && y.tag === 'const') {
          const xkb = defKB.get(x.id);
          if (xkb) {
            const c = (typeof y.num === 'bigint' ? y.num : BigInt(y.num)) & m;
            const identity =
              inst.sub === 'and'
                ? ((~c & m) & ~xkb.z) === 0n // masking off bits already known zero is a no-op
                : inst.sub === 'or'
                  ? (c & ~xkb.o) === 0n // setting bits already known one is a no-op
                  : c === 0n; // xor of no bits is a no-op (a degenerate mask)
            if (identity) {
              changed += replaceUses(inst.res, { tag: 'val', id: x.id });
            }
          }
        }
      }
    }
  }

  return changed;
}
