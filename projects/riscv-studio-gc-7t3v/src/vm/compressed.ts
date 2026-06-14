// RV32C — the compressed (16-bit) instruction extension.
//
// The C extension lets common instructions be encoded in 16 bits instead of 32, roughly
// halving code size. This module is the single source of truth for the *meaning* of every
// 16-bit form: `decompress(half)` expands a compressed half-word into the exact 32-bit
// instruction it is defined to be equivalent to, so the rest of the pipeline (decoder,
// disassembler, executor) needs no special cases — a compressed instruction just *is* its
// expansion. The matching `encodeC()` is the inverse, used by the assembler to emit 16-bit
// forms; the in-app verification suite round-trips assemble → decompress to prove the two
// halves agree bit-for-bit.
//
// A half-word is "compressed" iff its low two bits are not 0b11. Those low two bits select
// the *quadrant* (C0/C1/C2); the funct3 in bits 15:13 then selects the instruction. The
// 3-bit register fields address only x8..x15 (the "popular" registers), which is why the
// compressed register operands are `+8`.

import { signExtend, u32 } from './format';
import { OPC } from './isa';
import { FP_OPC } from './fp';

// ---------------------------------------------------------------------------
// 32-bit field builders (identical layout to the assembler's encoder)
// ---------------------------------------------------------------------------

function rType(funct7: number, rs2: number, rs1: number, funct3: number, rd: number, opc: number): number {
  return u32((funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opc);
}
function iType(imm12: number, rs1: number, funct3: number, rd: number, opc: number): number {
  return u32(((imm12 & 0xfff) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opc);
}
function sType(imm: number, rs2: number, rs1: number, funct3: number, opc: number): number {
  const lo = imm & 0x1f;
  const hi = (imm >> 5) & 0x7f;
  return u32((hi << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (lo << 7) | opc);
}
function bType(imm: number, rs2: number, rs1: number, funct3: number, opc: number): number {
  const b12 = (imm >> 12) & 1;
  const b11 = (imm >> 11) & 1;
  const b10_5 = (imm >> 5) & 0x3f;
  const b4_1 = (imm >> 1) & 0xf;
  return u32((b12 << 31) | (b10_5 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (b4_1 << 8) | (b11 << 7) | opc);
}
function uType(imm20: number, rd: number, opc: number): number {
  return u32(((imm20 & 0xfffff) << 12) | (rd << 7) | opc);
}
function jType(imm: number, rd: number, opc: number): number {
  const b20 = (imm >> 20) & 1;
  const b19_12 = (imm >> 12) & 0xff;
  const b11 = (imm >> 11) & 1;
  const b10_1 = (imm >> 1) & 0x3ff;
  return u32((b20 << 31) | (b10_1 << 21) | (b11 << 20) | (b19_12 << 12) | (rd << 7) | opc);
}

const EBREAK = 0x0010_0073;

/** Whether a 16-bit half-word begins a compressed instruction (low two bits ≠ 0b11). */
export function isCompressed(half: number): boolean {
  return (half & 3) !== 3;
}

/** A successfully decompressed instruction: its 32-bit equivalent + the C mnemonic. */
export interface Decompressed {
  word: number;
  mnem: string;
}

const bit = (h: number, i: number): number => (h >>> i) & 1;
const fld = (h: number, hi: number, lo: number): number => (h >>> lo) & ((1 << (hi - lo + 1)) - 1);
const rvc = (x: number): number => x + 8; // 3-bit reg field → x8..x15

// CIW (c.addi4spn) zero-extended immediate.
function immADDI4SPN(h: number): number {
  return (fld(h, 12, 11) << 4) | (fld(h, 10, 7) << 6) | (bit(h, 6) << 2) | (bit(h, 5) << 3);
}
// CL/CS word load/store offset (c.lw/c.sw/c.flw/c.fsw).
function immLW(h: number): number {
  return (bit(h, 5) << 6) | (fld(h, 12, 10) << 3) | (bit(h, 6) << 2);
}
// CL/CS double load/store offset (c.fld/c.fsd).
function immLD(h: number): number {
  return (fld(h, 6, 5) << 6) | (fld(h, 12, 10) << 3);
}
// CI signed 6-bit immediate (c.addi/c.li/c.andi/c.slli/c.srli/c.srai shamt).
function immCI(h: number): number {
  return signExtend((bit(h, 12) << 5) | fld(h, 6, 2), 6);
}
// CJ jump offset (c.j / c.jal).
function immCJ(h: number): number {
  const v =
    (bit(h, 12) << 11) |
    (bit(h, 8) << 10) |
    (fld(h, 10, 9) << 8) |
    (bit(h, 6) << 7) |
    (bit(h, 7) << 6) |
    (bit(h, 2) << 5) |
    (bit(h, 11) << 4) |
    (fld(h, 5, 3) << 1);
  return signExtend(v, 12);
}
// CB branch offset (c.beqz / c.bnez).
function immCB(h: number): number {
  const v =
    (bit(h, 12) << 8) |
    (fld(h, 6, 5) << 6) |
    (bit(h, 2) << 5) |
    (fld(h, 11, 10) << 3) |
    (fld(h, 4, 3) << 1);
  return signExtend(v, 9);
}
// c.addi16sp signed immediate.
function immADDI16SP(h: number): number {
  const v = (bit(h, 12) << 9) | (fld(h, 4, 3) << 7) | (bit(h, 5) << 6) | (bit(h, 2) << 5) | (bit(h, 6) << 4);
  return signExtend(v, 10);
}
// c.lwsp / c.flwsp offset.
function immLWSP(h: number): number {
  return (fld(h, 3, 2) << 6) | (bit(h, 12) << 5) | (fld(h, 6, 4) << 2);
}
// c.ldsp / c.fldsp offset.
function immLDSP(h: number): number {
  return (fld(h, 4, 2) << 6) | (bit(h, 12) << 5) | (fld(h, 6, 5) << 3);
}
// c.swsp / c.fswsp offset.
function immSWSP(h: number): number {
  return (fld(h, 8, 7) << 6) | (fld(h, 12, 9) << 2);
}
// c.sdsp / c.fsdsp offset.
function immSDSP(h: number): number {
  return (fld(h, 9, 7) << 6) | (fld(h, 12, 10) << 3);
}

/**
 * Expand a 16-bit compressed half-word into the 32-bit instruction it is defined to be, or
 * null if the encoding is illegal/reserved on RV32. `rv32d` enables the C.FLD/C.FSD family.
 */
export function decompress(half: number, rv32d = false): Decompressed | null {
  const h = half & 0xffff;
  const op = h & 3;
  const funct3 = fld(h, 15, 13);

  if (op === 0) {
    // -------- Quadrant 0 --------
    const rdp = rvc(fld(h, 4, 2));
    const rs1p = rvc(fld(h, 9, 7));
    switch (funct3) {
      case 0: {
        // C.ADDI4SPN: addi rd', x2, nzuimm
        const imm = immADDI4SPN(h);
        if (imm === 0) return null; // nzuimm=0 reserved (also catches the all-zero illegal half)
        return { word: iType(imm, 2, 0, rdp, OPC.OP_IMM), mnem: 'c.addi4spn' };
      }
      case 1: // C.FLD
        if (!rv32d) return null;
        return { word: iType(immLD(h), rs1p, 3, rdp, FP_OPC.LOAD_FP), mnem: 'c.fld' };
      case 2: // C.LW
        return { word: iType(immLW(h), rs1p, 2, rdp, OPC.LOAD), mnem: 'c.lw' };
      case 3: // C.FLW (RV32)
        return { word: iType(immLW(h), rs1p, 2, rdp, FP_OPC.LOAD_FP), mnem: 'c.flw' };
      case 5: // C.FSD
        if (!rv32d) return null;
        return { word: sType(immLD(h), rdp, rs1p, 3, FP_OPC.STORE_FP), mnem: 'c.fsd' };
      case 6: // C.SW
        return { word: sType(immLW(h), rdp, rs1p, 2, OPC.STORE), mnem: 'c.sw' };
      case 7: // C.FSW (RV32)
        return { word: sType(immLW(h), rdp, rs1p, 2, FP_OPC.STORE_FP), mnem: 'c.fsw' };
      default:
        return null; // 100 reserved
    }
  }

  if (op === 1) {
    // -------- Quadrant 1 --------
    switch (funct3) {
      case 0: {
        // C.ADDI (rd=0,imm=0 ⇒ C.NOP)
        const rd = fld(h, 11, 7);
        return { word: iType(immCI(h), rd, 0, rd, OPC.OP_IMM), mnem: rd === 0 ? 'c.nop' : 'c.addi' };
      }
      case 1: // C.JAL: jal x1, off
        return { word: jType(immCJ(h), 1, OPC.JAL), mnem: 'c.jal' };
      case 2: {
        // C.LI: addi rd, x0, imm
        const rd = fld(h, 11, 7);
        if (rd === 0) return null;
        return { word: iType(immCI(h), 0, 0, rd, OPC.OP_IMM), mnem: 'c.li' };
      }
      case 3: {
        const rd = fld(h, 11, 7);
        if (rd === 2) {
          // C.ADDI16SP: addi x2, x2, nzimm
          const imm = immADDI16SP(h);
          if (imm === 0) return null;
          return { word: iType(imm, 2, 0, 2, OPC.OP_IMM), mnem: 'c.addi16sp' };
        }
        // C.LUI: lui rd, imm (nzimm[17:12], sign-extended)
        if (rd === 0) return null;
        const v6 = (bit(h, 12) << 5) | fld(h, 6, 2);
        if (v6 === 0) return null; // nzimm=0 reserved
        const imm20 = signExtend(v6, 6) & 0xfffff;
        return { word: uType(imm20, rd, OPC.LUI), mnem: 'c.lui' };
      }
      case 4: {
        // MISC-ALU
        const rdp = rvc(fld(h, 9, 7));
        const funct2 = fld(h, 11, 10);
        if (funct2 === 0) {
          // C.SRLI: srli rd', rd', shamt
          if (bit(h, 12) !== 0) return null; // RV32: shamt[5] must be 0
          const shamt = fld(h, 6, 2);
          return { word: iType(shamt, rdp, 5, rdp, OPC.OP_IMM), mnem: 'c.srli' };
        }
        if (funct2 === 1) {
          // C.SRAI
          if (bit(h, 12) !== 0) return null;
          const shamt = fld(h, 6, 2);
          return { word: iType((0x20 << 5) | shamt, rdp, 5, rdp, OPC.OP_IMM), mnem: 'c.srai' };
        }
        if (funct2 === 2) {
          // C.ANDI: andi rd', rd', imm
          return { word: iType(immCI(h), rdp, 7, rdp, OPC.OP_IMM), mnem: 'c.andi' };
        }
        // funct2 === 3: register-register ALU
        const rs2p = rvc(fld(h, 4, 2));
        if (bit(h, 12) !== 0) return null; // C.SUBW/C.ADDW are RV64-only
        switch (fld(h, 6, 5)) {
          case 0:
            return { word: rType(0x20, rs2p, rdp, 0, rdp, OPC.OP), mnem: 'c.sub' };
          case 1:
            return { word: rType(0x00, rs2p, rdp, 4, rdp, OPC.OP), mnem: 'c.xor' };
          case 2:
            return { word: rType(0x00, rs2p, rdp, 6, rdp, OPC.OP), mnem: 'c.or' };
          default:
            return { word: rType(0x00, rs2p, rdp, 7, rdp, OPC.OP), mnem: 'c.and' };
        }
      }
      case 5: // C.J: jal x0, off
        return { word: jType(immCJ(h), 0, OPC.JAL), mnem: 'c.j' };
      case 6: // C.BEQZ
        return { word: bType(immCB(h), 0, rvc(fld(h, 9, 7)), 0, OPC.BRANCH), mnem: 'c.beqz' };
      case 7: // C.BNEZ
        return { word: bType(immCB(h), 0, rvc(fld(h, 9, 7)), 1, OPC.BRANCH), mnem: 'c.bnez' };
      default:
        return null;
    }
  }

  // -------- Quadrant 2 (op === 2) --------
  switch (funct3) {
    case 0: {
      // C.SLLI: slli rd, rd, shamt
      if (bit(h, 12) !== 0) return null; // RV32: shamt[5] must be 0
      const rd = fld(h, 11, 7);
      if (rd === 0) return null;
      const shamt = fld(h, 6, 2);
      return { word: iType(shamt, rd, 1, rd, OPC.OP_IMM), mnem: 'c.slli' };
    }
    case 1: {
      // C.FLDSP
      if (!rv32d) return null;
      const rd = fld(h, 11, 7);
      return { word: iType(immLDSP(h), 2, 3, rd, FP_OPC.LOAD_FP), mnem: 'c.fldsp' };
    }
    case 2: {
      // C.LWSP: lw rd, off(x2)
      const rd = fld(h, 11, 7);
      if (rd === 0) return null;
      return { word: iType(immLWSP(h), 2, 2, rd, OPC.LOAD), mnem: 'c.lwsp' };
    }
    case 3: {
      // C.FLWSP (RV32): flw rd, off(x2)
      const rd = fld(h, 11, 7);
      return { word: iType(immLWSP(h), 2, 2, rd, FP_OPC.LOAD_FP), mnem: 'c.flwsp' };
    }
    case 4: {
      const rs1 = fld(h, 11, 7);
      const rs2 = fld(h, 6, 2);
      if (bit(h, 12) === 0) {
        if (rs2 === 0) {
          // C.JR: jalr x0, 0(rs1)
          if (rs1 === 0) return null; // reserved
          return { word: iType(0, rs1, 0, 0, OPC.JALR), mnem: 'c.jr' };
        }
        // C.MV: add rd, x0, rs2
        if (rs1 === 0) return null;
        return { word: rType(0, rs2, 0, 0, rs1, OPC.OP), mnem: 'c.mv' };
      }
      // bit12 === 1
      if (rs1 === 0 && rs2 === 0) return { word: EBREAK, mnem: 'c.ebreak' };
      if (rs2 === 0) {
        // C.JALR: jalr x1, 0(rs1)
        return { word: iType(0, rs1, 0, 1, OPC.JALR), mnem: 'c.jalr' };
      }
      // C.ADD: add rd, rd, rs2
      if (rs1 === 0) return null;
      return { word: rType(0, rs2, rs1, 0, rs1, OPC.OP), mnem: 'c.add' };
    }
    case 5: {
      // C.FSDSP
      if (!rv32d) return null;
      return { word: sType(immSDSP(h), fld(h, 6, 2), 2, 3, FP_OPC.STORE_FP), mnem: 'c.fsdsp' };
    }
    case 6: // C.SWSP: sw rs2, off(x2)
      return { word: sType(immSWSP(h), fld(h, 6, 2), 2, 2, OPC.STORE), mnem: 'c.swsp' };
    case 7: // C.FSWSP (RV32)
      return { word: sType(immSWSP(h), fld(h, 6, 2), 2, 2, FP_OPC.STORE_FP), mnem: 'c.fswsp' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Encoding (the inverse: a parsed compressed instruction → its 16-bit pattern)
// ---------------------------------------------------------------------------

/** Operand bundle the assembler hands to `encodeC` (registers already resolved to indices). */
export interface CFields {
  rd: number;
  rs1: number;
  rs2: number;
  imm: number;
  /** float register index for the F/D compressed loads/stores. */
  frd: number;
  frs2: number;
}

class CEncodeError extends Error {}

function needRvcReg(x: number, what: string): number {
  if (x < 8 || x > 15) throw new CEncodeError(`${what} must be one of x8..x15 (got x${x})`);
  return x - 8;
}
function range(v: number, lo: number, hi: number, what: string): number {
  if (v < lo || v > hi) throw new CEncodeError(`${what} out of range: ${v} (allowed ${lo}..${hi})`);
  return v;
}
function aligned(v: number, n: number, what: string): number {
  if (v % n !== 0) throw new CEncodeError(`${what} must be a multiple of ${n} (got ${v})`);
  return v;
}

/** The set of compressed mnemonics the assembler understands. */
export const C_MNEMONICS: ReadonlySet<string> = new Set([
  'c.nop', 'c.addi', 'c.li', 'c.lui', 'c.addi16sp', 'c.addi4spn',
  'c.slli', 'c.srli', 'c.srai', 'c.andi',
  'c.mv', 'c.add', 'c.sub', 'c.xor', 'c.or', 'c.and',
  'c.lw', 'c.sw', 'c.lwsp', 'c.swsp',
  'c.flw', 'c.fsw', 'c.flwsp', 'c.fswsp',
  'c.fld', 'c.fsd', 'c.fldsp', 'c.fsdsp',
  'c.j', 'c.jal', 'c.jr', 'c.jalr', 'c.beqz', 'c.bnez', 'c.ebreak',
]);

/** Encode a parsed compressed instruction to its 16-bit pattern (throws on invalid operands). */
export function encodeC(mnem: string, f: CFields): number {
  const ci = (funct3: number, rd: number, imm5: number, imm0_4: number, op: number): number =>
    ((funct3 & 7) << 13) | ((imm5 & 1) << 12) | ((rd & 0x1f) << 7) | ((imm0_4 & 0x1f) << 2) | (op & 3);

  switch (mnem) {
    case 'c.nop':
      return 0x0001;
    case 'c.ebreak':
      return 0x9002;

    case 'c.addi': {
      const imm = range(f.imm, -32, 31, 'c.addi immediate');
      if (f.rd === 0) throw new CEncodeError('c.addi rd must not be x0 (use c.nop)');
      return ci(0, f.rd, (imm >> 5) & 1, imm & 0x1f, 1);
    }
    case 'c.li': {
      const imm = range(f.imm, -32, 31, 'c.li immediate');
      if (f.rd === 0) throw new CEncodeError('c.li rd must not be x0');
      return ci(2, f.rd, (imm >> 5) & 1, imm & 0x1f, 1);
    }
    case 'c.slli': {
      const sh = range(f.imm, 1, 31, 'c.slli shamt');
      if (f.rd === 0) throw new CEncodeError('c.slli rd must not be x0');
      return ci(0, f.rd, 0, sh & 0x1f, 2);
    }
    case 'c.lui': {
      if (f.rd === 0 || f.rd === 2) throw new CEncodeError('c.lui rd must not be x0 or x2');
      // imm here is the 6-bit value loaded into bits [17:12]; allow either that raw form
      // (-32..31, ≠0) or a full lui imm20 whose low bits fit.
      let v6 = f.imm;
      if (v6 > 31 || v6 < -32) v6 = signExtend(f.imm & 0x3f, 6);
      if (v6 === 0) throw new CEncodeError('c.lui immediate must not be 0');
      range(v6, -32, 31, 'c.lui immediate');
      return (3 << 13) | (((v6 >> 5) & 1) << 12) | (f.rd << 7) | ((v6 & 0x1f) << 2) | 1;
    }
    case 'c.addi16sp': {
      const imm = aligned(range(f.imm, -512, 496, 'c.addi16sp immediate'), 16, 'c.addi16sp immediate');
      if (imm === 0) throw new CEncodeError('c.addi16sp immediate must not be 0');
      return (
        (3 << 13) |
        (((imm >> 9) & 1) << 12) |
        (2 << 7) |
        (((imm >> 4) & 1) << 6) |
        (((imm >> 6) & 1) << 5) |
        (((imm >> 7) & 3) << 3) |
        (((imm >> 5) & 1) << 2) |
        1
      );
    }
    case 'c.addi4spn': {
      const rdp = needRvcReg(f.rd, 'c.addi4spn rd');
      const imm = aligned(range(f.imm, 4, 1020, 'c.addi4spn immediate'), 4, 'c.addi4spn immediate');
      return (
        (0 << 13) |
        (((imm >> 4) & 3) << 11) |
        (((imm >> 6) & 0xf) << 7) |
        (((imm >> 2) & 1) << 6) |
        (((imm >> 3) & 1) << 5) |
        (rdp << 2) |
        0
      );
    }
    case 'c.srli':
    case 'c.srai': {
      const rdp = needRvcReg(f.rd, `${mnem} rd`);
      const sh = range(f.imm, 1, 31, `${mnem} shamt`);
      const funct2 = mnem === 'c.srli' ? 0 : 1;
      return (4 << 13) | (((sh >> 5) & 1) << 12) | (funct2 << 10) | (rdp << 7) | ((sh & 0x1f) << 2) | 1;
    }
    case 'c.andi': {
      const rdp = needRvcReg(f.rd, 'c.andi rd');
      const imm = range(f.imm, -32, 31, 'c.andi immediate');
      return (4 << 13) | (((imm >> 5) & 1) << 12) | (2 << 10) | (rdp << 7) | ((imm & 0x1f) << 2) | 1;
    }
    case 'c.sub':
    case 'c.xor':
    case 'c.or':
    case 'c.and': {
      const rdp = needRvcReg(f.rd, `${mnem} rd`);
      const rs2p = needRvcReg(f.rs2, `${mnem} rs2`);
      const sel = { 'c.sub': 0, 'c.xor': 1, 'c.or': 2, 'c.and': 3 }[mnem]!;
      // CA format: funct6 = 0b100011 (bits 15:10), funct2 (bits 6:5) selects the op.
      return (0x23 << 10) | (rdp << 7) | (sel << 5) | (rs2p << 2) | 1;
    }
    case 'c.mv': {
      if (f.rd === 0) throw new CEncodeError('c.mv rd must not be x0');
      if (f.rs2 === 0) throw new CEncodeError('c.mv rs2 must not be x0');
      return (4 << 13) | (f.rd << 7) | (f.rs2 << 2) | 2;
    }
    case 'c.add': {
      if (f.rd === 0) throw new CEncodeError('c.add rd must not be x0');
      if (f.rs2 === 0) throw new CEncodeError('c.add rs2 must not be x0');
      return (4 << 13) | (1 << 12) | (f.rd << 7) | (f.rs2 << 2) | 2;
    }
    case 'c.jr': {
      if (f.rs1 === 0) throw new CEncodeError('c.jr rs1 must not be x0');
      return (4 << 13) | (f.rs1 << 7) | 2;
    }
    case 'c.jalr': {
      if (f.rs1 === 0) throw new CEncodeError('c.jalr rs1 must not be x0');
      return (4 << 13) | (1 << 12) | (f.rs1 << 7) | 2;
    }

    case 'c.lw':
    case 'c.sw':
    case 'c.flw':
    case 'c.fsw': {
      const isLoad = mnem === 'c.lw' || mnem === 'c.flw';
      const isFp = mnem === 'c.flw' || mnem === 'c.fsw';
      const rs1p = needRvcReg(f.rs1, `${mnem} base`);
      const regp = needRvcReg(isFp ? (isLoad ? f.frd : f.frs2) : isLoad ? f.rd : f.rs2, `${mnem} reg`);
      const off = aligned(range(f.imm, 0, 124, `${mnem} offset`), 4, `${mnem} offset`);
      const funct3 = isLoad ? (isFp ? 3 : 2) : isFp ? 7 : 6;
      return (
        (funct3 << 13) |
        (((off >> 3) & 7) << 10) |
        (rs1p << 7) |
        (((off >> 2) & 1) << 6) |
        (((off >> 6) & 1) << 5) |
        (regp << 2) |
        0
      );
    }
    case 'c.fld':
    case 'c.fsd': {
      const isLoad = mnem === 'c.fld';
      const rs1p = needRvcReg(f.rs1, `${mnem} base`);
      const regp = needRvcReg(isLoad ? f.frd : f.frs2, `${mnem} reg`);
      const off = aligned(range(f.imm, 0, 248, `${mnem} offset`), 8, `${mnem} offset`);
      const funct3 = isLoad ? 1 : 5;
      return (funct3 << 13) | (((off >> 3) & 7) << 10) | (rs1p << 7) | (((off >> 6) & 3) << 5) | (regp << 2) | 0;
    }

    case 'c.lwsp':
    case 'c.flwsp': {
      const isFp = mnem === 'c.flwsp';
      const rd = isFp ? f.frd : f.rd;
      if (!isFp && rd === 0) throw new CEncodeError('c.lwsp rd must not be x0');
      const off = aligned(range(f.imm, 0, 252, `${mnem} offset`), 4, `${mnem} offset`);
      const funct3 = isFp ? 3 : 2;
      return (
        (funct3 << 13) |
        (((off >> 5) & 1) << 12) |
        (rd << 7) |
        (((off >> 2) & 7) << 4) |
        (((off >> 6) & 3) << 2) |
        2
      );
    }
    case 'c.fldsp': {
      const off = aligned(range(f.imm, 0, 504, 'c.fldsp offset'), 8, 'c.fldsp offset');
      return (1 << 13) | (((off >> 5) & 1) << 12) | (f.frd << 7) | (((off >> 3) & 3) << 5) | (((off >> 6) & 7) << 2) | 2;
    }
    case 'c.swsp':
    case 'c.fswsp': {
      const isFp = mnem === 'c.fswsp';
      const rs2 = isFp ? f.frs2 : f.rs2;
      const off = aligned(range(f.imm, 0, 252, `${mnem} offset`), 4, `${mnem} offset`);
      const funct3 = isFp ? 7 : 6;
      return (funct3 << 13) | (((off >> 2) & 0xf) << 9) | (((off >> 6) & 3) << 7) | (rs2 << 2) | 2;
    }
    case 'c.fsdsp': {
      const off = aligned(range(f.imm, 0, 504, 'c.fsdsp offset'), 8, 'c.fsdsp offset');
      return (5 << 13) | (((off >> 3) & 7) << 10) | (((off >> 6) & 7) << 7) | (f.frs2 << 2) | 2;
    }

    case 'c.j':
    case 'c.jal': {
      const off = aligned(range(f.imm, -2048, 2046, `${mnem} offset`), 2, `${mnem} offset`);
      const funct3 = mnem === 'c.j' ? 5 : 1;
      return (
        (funct3 << 13) |
        (((off >> 11) & 1) << 12) |
        (((off >> 4) & 1) << 11) |
        (((off >> 8) & 3) << 9) |
        (((off >> 10) & 1) << 8) |
        (((off >> 6) & 1) << 7) |
        (((off >> 7) & 1) << 6) |
        (((off >> 1) & 7) << 3) |
        (((off >> 5) & 1) << 2) |
        1
      );
    }
    case 'c.beqz':
    case 'c.bnez': {
      const rs1p = needRvcReg(f.rs1, `${mnem} rs1`);
      const off = aligned(range(f.imm, -256, 254, `${mnem} offset`), 2, `${mnem} offset`);
      const funct3 = mnem === 'c.beqz' ? 6 : 7;
      return (
        (funct3 << 13) |
        (((off >> 8) & 1) << 12) |
        (((off >> 3) & 3) << 10) |
        (rs1p << 7) |
        (((off >> 6) & 3) << 5) |
        (((off >> 1) & 3) << 3) |
        (((off >> 5) & 1) << 2) |
        1
      );
    }

    default:
      throw new CEncodeError(`unknown compressed instruction '${mnem}'`);
  }
}
