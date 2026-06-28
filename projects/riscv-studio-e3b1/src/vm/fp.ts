// The RV32F single-precision floating-point extension: IEEE-754 bit helpers and the
// instruction table.
//
// FLEN = 32, so an `f` register is just a 32-bit raw bit pattern (no NaN-boxing needed). The
// VM stores those raw bits and converts to/from a JS double only to do arithmetic — writing a
// double back through `bitsFromF32` performs exactly the single-precision round-to-nearest-even
// the hardware would. As in the rest of this project the encoding tables are the single source
// of truth shared by the assembler, the decoder/disassembler and the interpreter.

// ---------------------------------------------------------------------------
// IEEE-754 single <-> raw bits (a tiny "soft float" boundary)
// ---------------------------------------------------------------------------

const cvt = new DataView(new ArrayBuffer(8));

/** Reinterpret a 32-bit pattern as the float it encodes. */
export function f32FromBits(bits: number): number {
  cvt.setUint32(0, bits >>> 0, true);
  return cvt.getFloat32(0, true);
}

/** Round a double to single precision and return its raw 32-bit pattern. */
export function bitsFromF32(x: number): number {
  cvt.setFloat32(0, x, true);
  return cvt.getUint32(0, true);
}

/** Reinterpret a 64-bit pattern (low + high words) as the double it encodes. */
export function f64FromBits(lo: number, hi: number): number {
  cvt.setUint32(0, lo >>> 0, true);
  cvt.setUint32(4, hi >>> 0, true);
  return cvt.getFloat64(0, true);
}

/** Decompose a double into its raw 64-bit pattern as `{ lo, hi }` little-endian words. */
export function bitsFromF64(x: number): { lo: number; hi: number } {
  cvt.setFloat64(0, x, true);
  return { lo: cvt.getUint32(0, true), hi: cvt.getUint32(4, true) };
}

/** The canonical quiet NaN RISC-V produces for invalid single-precision results. */
export const CANONICAL_NAN = 0x7fc0_0000;

/** The canonical quiet NaN for invalid double-precision results (0x7FF8_0000_0000_0000). */
export const CANONICAL_NAN_D = { lo: 0x0000_0000, hi: 0x7ff8_0000 } as const;

/**
 * NaN-boxing (FLEN = 64): a single-precision value occupies the low 32 bits with the high 32 bits
 * set to all-ones. A single-precision op that reads a register whose high word is *not* all-ones
 * must treat the input as the canonical single NaN — these helpers express that rule.
 */
export const NANBOX_HI = 0xffff_ffff;
export function isNanBoxed(hi: number): boolean {
  return (hi >>> 0) === NANBOX_HI;
}

// ---------------------------------------------------------------------------
// fcsr / rounding modes / accrued exception flags
// ---------------------------------------------------------------------------

/** Rounding modes (the funct3 field of an FP op, or frm for the dynamic mode). */
export const RM = { RNE: 0, RTZ: 1, RDN: 2, RUP: 3, RMM: 4, DYN: 7 } as const;

export const RM_NAMES: Record<number, string> = {
  0: 'rne', 1: 'rtz', 2: 'rdn', 3: 'rup', 4: 'rmm', 7: 'dyn',
};

export function rmFromName(tok: string): number | null {
  const t = tok.trim().toLowerCase();
  for (const [k, v] of Object.entries(RM_NAMES)) if (v === t) return Number(k);
  return null;
}

/** Accrued-exception flag bits (fflags = fcsr[4:0]). */
export const FFLAG = { NX: 1, UF: 2, OF: 4, DZ: 8, NV: 16 } as const;

/** Round a finite double to an integral value per a rounding mode. */
export function roundToInt(x: number, rm: number): number {
  switch (rm) {
    case RM.RTZ:
      return Math.trunc(x);
    case RM.RDN:
      return Math.floor(x);
    case RM.RUP:
      return Math.ceil(x);
    case RM.RMM:
      return x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5);
    case RM.RNE:
    default: {
      const fl = Math.floor(x);
      const diff = x - fl;
      if (diff < 0.5) return fl;
      if (diff > 0.5) return fl + 1;
      return fl % 2 === 0 ? fl : fl + 1; // tie → even
    }
  }
}

export interface CvtResult {
  value: number; // signed 32-bit bit pattern of the result
  invalid: boolean;
}

/** float → signed 32-bit, with RISC-V's saturating out-of-range / NaN behaviour. */
export function toI32(x: number, rm: number): CvtResult {
  if (Number.isNaN(x)) return { value: 0x7fff_ffff | 0, invalid: true };
  if (x === Infinity) return { value: 0x7fff_ffff | 0, invalid: true };
  if (x === -Infinity) return { value: -2147483648, invalid: true };
  const r = roundToInt(x, rm);
  if (r > 2147483647) return { value: 0x7fff_ffff | 0, invalid: true };
  if (r < -2147483648) return { value: -2147483648, invalid: true };
  return { value: r | 0, invalid: false };
}

/** float → unsigned 32-bit, saturating. The result is returned as a signed bit pattern. */
export function toU32(x: number, rm: number): CvtResult {
  if (Number.isNaN(x)) return { value: 0xffff_ffff | 0, invalid: true };
  if (x === Infinity) return { value: 0xffff_ffff | 0, invalid: true };
  if (x < 0 || x === -Infinity) return { value: 0, invalid: x !== 0 };
  const r = roundToInt(x, rm);
  if (r > 4294967295) return { value: 0xffff_ffff | 0, invalid: true };
  return { value: (r >>> 0) | 0, invalid: false };
}

/** The 10-bit classification mask returned by `fclass.s`. */
export function fclass(bits: number): number {
  const b = bits >>> 0;
  const sign = (b >>> 31) & 1;
  const exp = (b >>> 23) & 0xff;
  const frac = b & 0x7f_ffff;
  if (exp === 0xff) {
    if (frac === 0) return sign ? 1 << 0 : 1 << 7; // ±inf
    return frac & 0x40_0000 ? 1 << 9 : 1 << 8; // quiet : signaling NaN
  }
  if (exp === 0) {
    if (frac === 0) return sign ? 1 << 3 : 1 << 4; // ±0
    return sign ? 1 << 2 : 1 << 5; // ±subnormal
  }
  return sign ? 1 << 1 : 1 << 6; // ±normal
}

/** IEEE minimumNumber/maximumNumber on raw bit patterns (NaN- and ±0-aware). */
export function fminBits(ab: number, bb: number): { bits: number; invalid: boolean } {
  const a = f32FromBits(ab);
  const b = f32FromBits(bb);
  const an = Number.isNaN(a);
  const bn = Number.isNaN(b);
  if (an && bn) return { bits: CANONICAL_NAN, invalid: true };
  if (an) return { bits: bb, invalid: true };
  if (bn) return { bits: ab, invalid: true };
  if (a === 0 && b === 0) return { bits: (ab | bb) & 0x8000_0000 ? 0x8000_0000 : 0, invalid: false };
  return { bits: a < b ? ab : bb, invalid: false };
}

export function fmaxBits(ab: number, bb: number): { bits: number; invalid: boolean } {
  const a = f32FromBits(ab);
  const b = f32FromBits(bb);
  const an = Number.isNaN(a);
  const bn = Number.isNaN(b);
  if (an && bn) return { bits: CANONICAL_NAN, invalid: true };
  if (an) return { bits: bb, invalid: true };
  if (bn) return { bits: ab, invalid: true };
  if (a === 0 && b === 0) return { bits: ab & bb & 0x8000_0000 ? 0x8000_0000 : 0, invalid: false };
  return { bits: a > b ? ab : bb, invalid: false };
}

// ---------------------------------------------------------------------------
// Double-precision (FLEN = 64) bit helpers — the 64-bit counterparts of the above.
// Operands and results are carried as `{ lo, hi }` raw little-endian word pairs.
// ---------------------------------------------------------------------------

export interface D64 {
  lo: number;
  hi: number;
}

/** The 10-bit classification mask returned by `fclass.d`. */
export function fclass64(lo: number, hi: number): number {
  const h = hi >>> 0;
  const sign = (h >>> 31) & 1;
  const exp = (h >>> 20) & 0x7ff;
  const fracHi = h & 0xf_ffff;
  const fracZero = fracHi === 0 && (lo >>> 0) === 0;
  if (exp === 0x7ff) {
    if (fracZero) return sign ? 1 << 0 : 1 << 7; // ±inf
    return fracHi & 0x8_0000 ? 1 << 9 : 1 << 8; // quiet : signaling NaN (top frac bit)
  }
  if (exp === 0) {
    if (fracZero) return sign ? 1 << 3 : 1 << 4; // ±0
    return sign ? 1 << 2 : 1 << 5; // ±subnormal
  }
  return sign ? 1 << 1 : 1 << 6; // ±normal
}

function minmaxD(a: D64, b: D64, isMax: boolean): { bits: D64; invalid: boolean } {
  const av = f64FromBits(a.lo, a.hi);
  const bv = f64FromBits(b.lo, b.hi);
  const an = Number.isNaN(av);
  const bn = Number.isNaN(bv);
  if (an && bn) return { bits: { ...CANONICAL_NAN_D }, invalid: true };
  if (an) return { bits: b, invalid: true };
  if (bn) return { bits: a, invalid: true };
  if (av === 0 && bv === 0) {
    // ±0 ties: fmin returns −0 when either is −0; fmax returns +0 when either is +0.
    const negative = isMax ? (a.hi & b.hi & 0x8000_0000) !== 0 : ((a.hi | b.hi) & 0x8000_0000) !== 0;
    return { bits: negative ? { lo: 0, hi: 0x8000_0000 } : { lo: 0, hi: 0 }, invalid: false };
  }
  const pick = isMax ? av > bv : av < bv;
  return { bits: pick ? a : b, invalid: false };
}

export function fminBits64(a: D64, b: D64): { bits: D64; invalid: boolean } {
  return minmaxD(a, b, false);
}
export function fmaxBits64(a: D64, b: D64): { bits: D64; invalid: boolean } {
  return minmaxD(a, b, true);
}

/**
 * A correctly-fused double-precision multiply-add `a*b + c` with a *single* rounding.
 *
 * JavaScript has no `Math.fma`, and the naive `a*b + c` rounds twice (once for the product, once
 * for the sum) — which is exactly the error the hardware FMA instruction exists to eliminate. This
 * recovers the fused result with the standard error-free transforms: a Veltkamp split feeds a
 * two-product (the exact product as an unevaluated `p + pe` pair), a two-sum adds `c` exactly, and
 * the residuals are folded back before the one final rounding. For the finite, non-overflowing
 * domain this matches an IEEE-754 fused multiply-add; non-finite or overflow-prone inputs fall back
 * to the plain expression (where double-rounding is immaterial).
 */
export function fmaD(a: number, b: number, c: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return a * b + c;
  const p = a * b;
  // Bail out if the product or its split would overflow the EFT's headroom.
  if (!Number.isFinite(p) || Math.abs(a) > 1e150 || Math.abs(b) > 1e150) return p + c;
  const SPLIT = 134217729; // 2^27 + 1
  const ca = SPLIT * a;
  const ah = ca - (ca - a);
  const al = a - ah;
  const cb = SPLIT * b;
  const bh = cb - (cb - b);
  const bl = b - bh;
  const pe = al * bl - (((p - ah * bh) - al * bh) - ah * bl); // exact: p + pe === a*b
  const s = p + c;
  const bb = s - p;
  const se = (p - (s - bb)) + (c - bb); // exact: s + se === p + c
  return s + (pe + se);
}

// ---------------------------------------------------------------------------
// Instruction table
// ---------------------------------------------------------------------------

export const FP_OPC = {
  LOAD_FP: 0x07,
  STORE_FP: 0x27,
  OP_FP: 0x53,
  MADD: 0x43,
  MSUB: 0x47,
  NMSUB: 0x4b,
  NMADD: 0x4f,
} as const;

/** How an FP instruction's operands are laid out + how it encodes. */
export type FpKind =
  | 'load' // flw   rd(f), off(rs1)
  | 'store' // fsw   rs2(f), off(rs1)
  | 'r-rm' // fadd/fsub/fmul/fdiv   rd(f), rs1(f), rs2(f) [, rm]
  | 'sqrt' // fsqrt  rd(f), rs1(f) [, rm]
  | 'sgnj' // fsgnj[n|x]  rd(f), rs1(f), rs2(f)
  | 'minmax' // fmin/fmax   rd(f), rs1(f), rs2(f)
  | 'cmp' // feq/flt/fle  rd(x), rs1(f), rs2(f)
  | 'cvt.w' // fcvt.w.s/fcvt.wu.s   rd(x), rs1(f) [, rm]
  | 'cvt.s' // fcvt.s.w/fcvt.s.wu   rd(f), rs1(x) [, rm]
  | 'mv.x' // fmv.x.w   rd(x), rs1(f)
  | 'fclass' // fclass.s  rd(x), rs1(f)
  | 'mv.f' // fmv.w.x   rd(f), rs1(x)
  | 'cvt.ff' // fcvt.s.d / fcvt.d.s   rd(f), rs1(f) [, rm]   (cross-precision cast)
  | 'fma'; // fmadd/fmsub/fnmadd/fnmsub   rd(f), rs1(f), rs2(f), rs3(f) [, rm]

export interface FpSpec {
  readonly name: string;
  readonly kind: FpKind;
  readonly opcode: number;
  readonly funct7?: number;
  /** Fixed funct3 for ops that aren't rounding-mode parameterised. */
  readonly funct3?: number;
  /** Fixed rs2 field for unary ops / conversions. */
  readonly rs2?: number;
  /** True if funct3 carries a rounding mode (rather than a fixed selector). */
  readonly hasRm?: boolean;
  /** Precision format (funct2, bits [26:25]): 0 = single (`.s`), 1 = double (`.d`). */
  readonly fmt?: number;
}

function fp(name: string, kind: FpKind, opcode: number, extra: Partial<FpSpec> = {}): FpSpec {
  return { name, kind, opcode, ...extra };
}

const O = FP_OPC;

export const FP_SPECS: Record<string, FpSpec> = {
  'flw': fp('flw', 'load', O.LOAD_FP, { funct3: 2 }),
  'fsw': fp('fsw', 'store', O.STORE_FP, { funct3: 2 }),

  'fadd.s': fp('fadd.s', 'r-rm', O.OP_FP, { funct7: 0x00, hasRm: true }),
  'fsub.s': fp('fsub.s', 'r-rm', O.OP_FP, { funct7: 0x04, hasRm: true }),
  'fmul.s': fp('fmul.s', 'r-rm', O.OP_FP, { funct7: 0x08, hasRm: true }),
  'fdiv.s': fp('fdiv.s', 'r-rm', O.OP_FP, { funct7: 0x0c, hasRm: true }),
  'fsqrt.s': fp('fsqrt.s', 'sqrt', O.OP_FP, { funct7: 0x2c, rs2: 0, hasRm: true }),

  'fsgnj.s': fp('fsgnj.s', 'sgnj', O.OP_FP, { funct7: 0x10, funct3: 0 }),
  'fsgnjn.s': fp('fsgnjn.s', 'sgnj', O.OP_FP, { funct7: 0x10, funct3: 1 }),
  'fsgnjx.s': fp('fsgnjx.s', 'sgnj', O.OP_FP, { funct7: 0x10, funct3: 2 }),

  'fmin.s': fp('fmin.s', 'minmax', O.OP_FP, { funct7: 0x14, funct3: 0 }),
  'fmax.s': fp('fmax.s', 'minmax', O.OP_FP, { funct7: 0x14, funct3: 1 }),

  'feq.s': fp('feq.s', 'cmp', O.OP_FP, { funct7: 0x50, funct3: 2 }),
  'flt.s': fp('flt.s', 'cmp', O.OP_FP, { funct7: 0x50, funct3: 1 }),
  'fle.s': fp('fle.s', 'cmp', O.OP_FP, { funct7: 0x50, funct3: 0 }),

  'fcvt.w.s': fp('fcvt.w.s', 'cvt.w', O.OP_FP, { funct7: 0x60, rs2: 0, hasRm: true }),
  'fcvt.wu.s': fp('fcvt.wu.s', 'cvt.w', O.OP_FP, { funct7: 0x60, rs2: 1, hasRm: true }),
  'fcvt.s.w': fp('fcvt.s.w', 'cvt.s', O.OP_FP, { funct7: 0x68, rs2: 0, hasRm: true }),
  'fcvt.s.wu': fp('fcvt.s.wu', 'cvt.s', O.OP_FP, { funct7: 0x68, rs2: 1, hasRm: true }),

  'fmv.x.w': fp('fmv.x.w', 'mv.x', O.OP_FP, { funct7: 0x70, funct3: 0, rs2: 0 }),
  'fclass.s': fp('fclass.s', 'fclass', O.OP_FP, { funct7: 0x70, funct3: 1, rs2: 0 }),
  'fmv.w.x': fp('fmv.w.x', 'mv.f', O.OP_FP, { funct7: 0x78, funct3: 0, rs2: 0 }),

  'fmadd.s': fp('fmadd.s', 'fma', O.MADD, { hasRm: true, fmt: 0 }),
  'fmsub.s': fp('fmsub.s', 'fma', O.MSUB, { hasRm: true, fmt: 0 }),
  'fnmsub.s': fp('fnmsub.s', 'fma', O.NMSUB, { hasRm: true, fmt: 0 }),
  'fnmadd.s': fp('fnmadd.s', 'fma', O.NMADD, { hasRm: true, fmt: 0 }),

  // ---- RV32D (FLEN = 64): the double-precision counterparts -------------------
  // OP-FP doubles share each single op's funct7 with the format (fmt) bit set: `.s | 0x01`.
  'fld': fp('fld', 'load', O.LOAD_FP, { funct3: 3 }),
  'fsd': fp('fsd', 'store', O.STORE_FP, { funct3: 3 }),

  'fadd.d': fp('fadd.d', 'r-rm', O.OP_FP, { funct7: 0x01, hasRm: true }),
  'fsub.d': fp('fsub.d', 'r-rm', O.OP_FP, { funct7: 0x05, hasRm: true }),
  'fmul.d': fp('fmul.d', 'r-rm', O.OP_FP, { funct7: 0x09, hasRm: true }),
  'fdiv.d': fp('fdiv.d', 'r-rm', O.OP_FP, { funct7: 0x0d, hasRm: true }),
  'fsqrt.d': fp('fsqrt.d', 'sqrt', O.OP_FP, { funct7: 0x2d, rs2: 0, hasRm: true }),

  'fsgnj.d': fp('fsgnj.d', 'sgnj', O.OP_FP, { funct7: 0x11, funct3: 0 }),
  'fsgnjn.d': fp('fsgnjn.d', 'sgnj', O.OP_FP, { funct7: 0x11, funct3: 1 }),
  'fsgnjx.d': fp('fsgnjx.d', 'sgnj', O.OP_FP, { funct7: 0x11, funct3: 2 }),

  'fmin.d': fp('fmin.d', 'minmax', O.OP_FP, { funct7: 0x15, funct3: 0 }),
  'fmax.d': fp('fmax.d', 'minmax', O.OP_FP, { funct7: 0x15, funct3: 1 }),

  'feq.d': fp('feq.d', 'cmp', O.OP_FP, { funct7: 0x51, funct3: 2 }),
  'flt.d': fp('flt.d', 'cmp', O.OP_FP, { funct7: 0x51, funct3: 1 }),
  'fle.d': fp('fle.d', 'cmp', O.OP_FP, { funct7: 0x51, funct3: 0 }),

  'fcvt.w.d': fp('fcvt.w.d', 'cvt.w', O.OP_FP, { funct7: 0x61, rs2: 0, hasRm: true }),
  'fcvt.wu.d': fp('fcvt.wu.d', 'cvt.w', O.OP_FP, { funct7: 0x61, rs2: 1, hasRm: true }),
  'fcvt.d.w': fp('fcvt.d.w', 'cvt.s', O.OP_FP, { funct7: 0x69, rs2: 0, hasRm: true }),
  'fcvt.d.wu': fp('fcvt.d.wu', 'cvt.s', O.OP_FP, { funct7: 0x69, rs2: 1, hasRm: true }),

  // Cross-precision casts: fcvt.s.d narrows (funct7 0x20, rs2=1), fcvt.d.s widens (0x21, rs2=0).
  'fcvt.s.d': fp('fcvt.s.d', 'cvt.ff', O.OP_FP, { funct7: 0x20, rs2: 1, hasRm: true }),
  'fcvt.d.s': fp('fcvt.d.s', 'cvt.ff', O.OP_FP, { funct7: 0x21, rs2: 0, hasRm: true }),

  'fclass.d': fp('fclass.d', 'fclass', O.OP_FP, { funct7: 0x71, funct3: 1, rs2: 0 }),

  'fmadd.d': fp('fmadd.d', 'fma', O.MADD, { hasRm: true, fmt: 1 }),
  'fmsub.d': fp('fmsub.d', 'fma', O.MSUB, { hasRm: true, fmt: 1 }),
  'fnmsub.d': fp('fnmsub.d', 'fma', O.NMSUB, { hasRm: true, fmt: 1 }),
  'fnmadd.d': fp('fnmadd.d', 'fma', O.NMADD, { hasRm: true, fmt: 1 }),
};

export const FP_MNEMONICS: ReadonlySet<string> = new Set(Object.keys(FP_SPECS));

/** True if an opcode belongs to the F extension (so decode/execute should branch to FP). */
export function isFpOpcode(opcode: number): boolean {
  return (
    opcode === O.LOAD_FP ||
    opcode === O.STORE_FP ||
    opcode === O.OP_FP ||
    opcode === O.MADD ||
    opcode === O.MSUB ||
    opcode === O.NMSUB ||
    opcode === O.NMADD
  );
}

/** Resolve an FP encoding back to its mnemonic for the decoder/disassembler. */
export function decodeFpMnemonic(
  opcode: number,
  funct7: number,
  funct3: number,
  rs2: number,
): string {
  // For the R4-type fused multiply-adds the precision (fmt) sits in funct7's low two bits.
  const fmaD = (funct7 & 0x3) === 1;
  switch (opcode) {
    case O.LOAD_FP:
      return funct3 === 2 ? 'flw' : funct3 === 3 ? 'fld' : '?';
    case O.STORE_FP:
      return funct3 === 2 ? 'fsw' : funct3 === 3 ? 'fsd' : '?';
    case O.MADD:
      return fmaD ? 'fmadd.d' : 'fmadd.s';
    case O.MSUB:
      return fmaD ? 'fmsub.d' : 'fmsub.s';
    case O.NMSUB:
      return fmaD ? 'fnmsub.d' : 'fnmsub.s';
    case O.NMADD:
      return fmaD ? 'fnmadd.d' : 'fnmadd.s';
    case O.OP_FP:
      switch (funct7) {
        case 0x00:
          return 'fadd.s';
        case 0x04:
          return 'fsub.s';
        case 0x08:
          return 'fmul.s';
        case 0x0c:
          return 'fdiv.s';
        case 0x2c:
          return 'fsqrt.s';
        case 0x10:
          return ['fsgnj.s', 'fsgnjn.s', 'fsgnjx.s'][funct3] ?? '?';
        case 0x14:
          return ['fmin.s', 'fmax.s'][funct3] ?? '?';
        case 0x50:
          return { 0: 'fle.s', 1: 'flt.s', 2: 'feq.s' }[funct3] ?? '?';
        case 0x60:
          return rs2 === 0 ? 'fcvt.w.s' : 'fcvt.wu.s';
        case 0x68:
          return rs2 === 0 ? 'fcvt.s.w' : 'fcvt.s.wu';
        case 0x70:
          return funct3 === 0 ? 'fmv.x.w' : 'fclass.s';
        case 0x78:
          return 'fmv.w.x';
        // ---- RV32D ----
        case 0x01:
          return 'fadd.d';
        case 0x05:
          return 'fsub.d';
        case 0x09:
          return 'fmul.d';
        case 0x0d:
          return 'fdiv.d';
        case 0x2d:
          return 'fsqrt.d';
        case 0x11:
          return ['fsgnj.d', 'fsgnjn.d', 'fsgnjx.d'][funct3] ?? '?';
        case 0x15:
          return ['fmin.d', 'fmax.d'][funct3] ?? '?';
        case 0x51:
          return { 0: 'fle.d', 1: 'flt.d', 2: 'feq.d' }[funct3] ?? '?';
        case 0x61:
          return rs2 === 0 ? 'fcvt.w.d' : 'fcvt.wu.d';
        case 0x69:
          return rs2 === 0 ? 'fcvt.d.w' : 'fcvt.d.wu';
        case 0x20:
          return 'fcvt.s.d';
        case 0x21:
          return 'fcvt.d.s';
        case 0x71:
          return 'fclass.d';
        default:
          return '?';
      }
    default:
      return '?';
  }
}
