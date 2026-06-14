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

/** Reinterpret a 64-bit pattern (lo, hi little-endian halves) as the IEEE-754 double. */
export function f64FromBits(lo: number, hi: number): number {
  cvt.setUint32(0, lo >>> 0, true);
  cvt.setUint32(4, hi >>> 0, true);
  return cvt.getFloat64(0, true);
}

/** Raw 64-bit pattern of a double, as { lo, hi } little-endian halves. */
export function bitsFromF64(x: number): { lo: number; hi: number } {
  cvt.setFloat64(0, x, true);
  return { lo: cvt.getUint32(0, true), hi: cvt.getUint32(4, true) };
}

/** The canonical quiet NaN RISC-V produces for invalid single-precision results. */
export const CANONICAL_NAN = 0x7fc0_0000;
/** High half of the canonical quiet NaN double (low half is 0). */
export const CANONICAL_NAN_D_HI = 0x7ff8_0000;

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

/** The 10-bit classification mask returned by `fclass.d` (same bit meanings as `.s`). */
export function fclassD(lo: number, hi: number): number {
  const h = hi >>> 0;
  const sign = (h >>> 31) & 1;
  const exp = (h >>> 20) & 0x7ff;
  const fracHi = h & 0xf_ffff;
  const fracZero = fracHi === 0 && (lo >>> 0) === 0;
  if (exp === 0x7ff) {
    if (fracZero) return sign ? 1 << 0 : 1 << 7; // ±inf
    return fracHi & 0x8_0000 ? 1 << 9 : 1 << 8; // quiet : signaling NaN
  }
  if (exp === 0) {
    if (fracZero) return sign ? 1 << 3 : 1 << 4; // ±0
    return sign ? 1 << 2 : 1 << 5; // ±subnormal
  }
  return sign ? 1 << 1 : 1 << 6; // ±normal
}

/** Whether the sign bit of a double (its high half) is set. */
const dSign = (hi: number): boolean => (hi & 0x8000_0000) !== 0;

/** IEEE min/max for doubles on raw {lo,hi} halves (NaN- and ±0-aware). */
export function fminBitsD(
  aLo: number, aHi: number, bLo: number, bHi: number,
): { lo: number; hi: number; invalid: boolean } {
  const a = f64FromBits(aLo, aHi);
  const b = f64FromBits(bLo, bHi);
  const an = Number.isNaN(a);
  const bn = Number.isNaN(b);
  if (an && bn) return { lo: 0, hi: CANONICAL_NAN_D_HI, invalid: true };
  if (an) return { lo: bLo, hi: bHi, invalid: true };
  if (bn) return { lo: aLo, hi: aHi, invalid: true };
  if (a === 0 && b === 0) {
    const neg = dSign(aHi) || dSign(bHi);
    return { lo: 0, hi: neg ? 0x8000_0000 : 0, invalid: false };
  }
  return a < b ? { lo: aLo, hi: aHi, invalid: false } : { lo: bLo, hi: bHi, invalid: false };
}

export function fmaxBitsD(
  aLo: number, aHi: number, bLo: number, bHi: number,
): { lo: number; hi: number; invalid: boolean } {
  const a = f64FromBits(aLo, aHi);
  const b = f64FromBits(bLo, bHi);
  const an = Number.isNaN(a);
  const bn = Number.isNaN(b);
  if (an && bn) return { lo: 0, hi: CANONICAL_NAN_D_HI, invalid: true };
  if (an) return { lo: bLo, hi: bHi, invalid: true };
  if (bn) return { lo: aLo, hi: aHi, invalid: true };
  if (a === 0 && b === 0) {
    const pos = !dSign(aHi) || !dSign(bHi);
    return { lo: 0, hi: pos ? 0 : 0x8000_0000, invalid: false };
  }
  return a > b ? { lo: aLo, hi: aHi, invalid: false } : { lo: bLo, hi: bHi, invalid: false };
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
  | 'load' // flw/fld   rd(f), off(rs1)
  | 'store' // fsw/fsd   rs2(f), off(rs1)
  | 'r-rm' // fadd/fsub/fmul/fdiv   rd(f), rs1(f), rs2(f) [, rm]
  | 'sqrt' // fsqrt  rd(f), rs1(f) [, rm]
  | 'sgnj' // fsgnj[n|x]  rd(f), rs1(f), rs2(f)
  | 'minmax' // fmin/fmax   rd(f), rs1(f), rs2(f)
  | 'cmp' // feq/flt/fle  rd(x), rs1(f), rs2(f)
  | 'cvt.w' // fcvt.w.s/fcvt.wu.s (+ .d)   rd(x), rs1(f) [, rm]
  | 'cvt.s' // fcvt.s.w/fcvt.s.wu (+ .d.w) rd(f), rs1(x) [, rm]
  | 'cvt.f2f' // fcvt.s.d / fcvt.d.s   rd(f), rs1(f) [, rm]  (precision conversion)
  | 'mv.x' // fmv.x.w   rd(x), rs1(f)
  | 'fclass' // fclass.s/.d  rd(x), rs1(f)
  | 'mv.f' // fmv.w.x   rd(f), rs1(x)
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
  /** True for the double-precision (D) form — the executor reads/writes 64-bit operands. */
  readonly dbl?: boolean;
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

  'fmadd.s': fp('fmadd.s', 'fma', O.MADD, { hasRm: true }),
  'fmsub.s': fp('fmsub.s', 'fma', O.MSUB, { hasRm: true }),
  'fnmsub.s': fp('fnmsub.s', 'fma', O.NMSUB, { hasRm: true }),
  'fnmadd.s': fp('fnmadd.s', 'fma', O.NMADD, { hasRm: true }),

  // --- RV32D double precision (fmt = 01) ---
  'fld': fp('fld', 'load', O.LOAD_FP, { funct3: 3, dbl: true }),
  'fsd': fp('fsd', 'store', O.STORE_FP, { funct3: 3, dbl: true }),

  'fadd.d': fp('fadd.d', 'r-rm', O.OP_FP, { funct7: 0x01, hasRm: true, dbl: true }),
  'fsub.d': fp('fsub.d', 'r-rm', O.OP_FP, { funct7: 0x05, hasRm: true, dbl: true }),
  'fmul.d': fp('fmul.d', 'r-rm', O.OP_FP, { funct7: 0x09, hasRm: true, dbl: true }),
  'fdiv.d': fp('fdiv.d', 'r-rm', O.OP_FP, { funct7: 0x0d, hasRm: true, dbl: true }),
  'fsqrt.d': fp('fsqrt.d', 'sqrt', O.OP_FP, { funct7: 0x2d, rs2: 0, hasRm: true, dbl: true }),

  'fsgnj.d': fp('fsgnj.d', 'sgnj', O.OP_FP, { funct7: 0x11, funct3: 0, dbl: true }),
  'fsgnjn.d': fp('fsgnjn.d', 'sgnj', O.OP_FP, { funct7: 0x11, funct3: 1, dbl: true }),
  'fsgnjx.d': fp('fsgnjx.d', 'sgnj', O.OP_FP, { funct7: 0x11, funct3: 2, dbl: true }),

  'fmin.d': fp('fmin.d', 'minmax', O.OP_FP, { funct7: 0x15, funct3: 0, dbl: true }),
  'fmax.d': fp('fmax.d', 'minmax', O.OP_FP, { funct7: 0x15, funct3: 1, dbl: true }),

  'feq.d': fp('feq.d', 'cmp', O.OP_FP, { funct7: 0x51, funct3: 2, dbl: true }),
  'flt.d': fp('flt.d', 'cmp', O.OP_FP, { funct7: 0x51, funct3: 1, dbl: true }),
  'fle.d': fp('fle.d', 'cmp', O.OP_FP, { funct7: 0x51, funct3: 0, dbl: true }),

  'fcvt.w.d': fp('fcvt.w.d', 'cvt.w', O.OP_FP, { funct7: 0x61, rs2: 0, hasRm: true, dbl: true }),
  'fcvt.wu.d': fp('fcvt.wu.d', 'cvt.w', O.OP_FP, { funct7: 0x61, rs2: 1, hasRm: true, dbl: true }),
  'fcvt.d.w': fp('fcvt.d.w', 'cvt.s', O.OP_FP, { funct7: 0x69, rs2: 0, hasRm: true, dbl: true }),
  'fcvt.d.wu': fp('fcvt.d.wu', 'cvt.s', O.OP_FP, { funct7: 0x69, rs2: 1, hasRm: true, dbl: true }),

  // Precision conversions: fcvt.s.d narrows (single result), fcvt.d.s widens (double result).
  'fcvt.s.d': fp('fcvt.s.d', 'cvt.f2f', O.OP_FP, { funct7: 0x20, rs2: 1, hasRm: true }),
  'fcvt.d.s': fp('fcvt.d.s', 'cvt.f2f', O.OP_FP, { funct7: 0x21, rs2: 0, hasRm: true, dbl: true }),

  'fclass.d': fp('fclass.d', 'fclass', O.OP_FP, { funct7: 0x71, funct3: 1, rs2: 0, dbl: true }),

  'fmadd.d': fp('fmadd.d', 'fma', O.MADD, { hasRm: true, dbl: true }),
  'fmsub.d': fp('fmsub.d', 'fma', O.MSUB, { hasRm: true, dbl: true }),
  'fnmsub.d': fp('fnmsub.d', 'fma', O.NMSUB, { hasRm: true, dbl: true }),
  'fnmadd.d': fp('fnmadd.d', 'fma', O.NMADD, { hasRm: true, dbl: true }),
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
  // For the fused-multiply-add opcodes the format rides in bits 26:25 (= funct7 & 3).
  const fmaD = (funct7 & 3) === 1;
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
        // --- double precision (fmt = 01) ---
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
