// RV32C — the "compressed" extension: 16-bit instruction encodings.
//
// The C extension is what real RISC-V toolchains emit for ~30% of every binary: a 16-bit
// alias for the most common 32-bit instructions, chosen so the assembler can transparently
// shrink code with no change in behaviour. This module is the single source of truth for the
// compressed encodings, used three ways:
//
//   • the CPU/decoder calls `expandCompressed` to turn a 16-bit half-word into the canonical
//     32-bit base instruction, so the existing executor runs it unchanged;
//   • the disassembler calls `formatCompressed` to render the idiomatic `c.*` text;
//   • the assembler calls `encodeCompressed` (explicit `c.*` mnemonics) and `tryCompress`
//     (the automatic peephole compressor).
//
// The immediate fields of RVC are famously scrambled (the bits are permuted so the common
// hardware paths stay cheap). Every scramble lives here exactly once, as a paired
// pack/unpack so the encoder and decoder can never drift.

import { ABI_NAMES, FREG_ABI_NAMES } from './registers';
import { signExtend, u32, hexWord } from './format';

// ---------------------------------------------------------------------------
// Tiny bit helpers
// ---------------------------------------------------------------------------

const bit = (x: number, n: number): number => (x >>> n) & 1;
const bits = (x: number, hi: number, lo: number): number => (x >>> lo) & ((1 << (hi - lo + 1)) - 1);

/** A compressed instruction occupies 16 bits iff its low two bits are not 0b11. */
export function isCompressed(half: number): boolean {
  return (half & 0x3) !== 0x3;
}

// Compressed-register fields are 3 bits and name x8..x15 (s0,s1,a0..a5).
const creg = (f: number): number => 8 + (f & 0x7);

// Base-instruction opcodes (low 7 bits).
const LOAD = 0x03;
const LOAD_FP = 0x07;
const OP_IMM = 0x13;
const STORE = 0x23;
const STORE_FP = 0x27;
const OP = 0x33;
const LUI = 0x37;
const BRANCH = 0x63;
const JALR = 0x67;
const JAL = 0x6f;

// ---------------------------------------------------------------------------
// Base-instruction (32-bit) encoders — used to expand a compressed half-word
// ---------------------------------------------------------------------------

const encI = (op: number, f3: number, rd: number, rs1: number, imm: number): number =>
  u32(((imm & 0xfff) << 20) | ((rs1 & 0x1f) << 15) | ((f3 & 7) << 12) | ((rd & 0x1f) << 7) | op);

const encR = (f7: number, f3: number, rd: number, rs1: number, rs2: number): number =>
  u32(((f7 & 0x7f) << 25) | ((rs2 & 0x1f) << 20) | ((rs1 & 0x1f) << 15) | ((f3 & 7) << 12) | ((rd & 0x1f) << 7) | OP);

const encS = (f3: number, rs1: number, rs2: number, imm: number): number =>
  u32(
    (((imm >> 5) & 0x7f) << 25) |
      ((rs2 & 0x1f) << 20) |
      ((rs1 & 0x1f) << 15) |
      ((f3 & 7) << 12) |
      ((imm & 0x1f) << 7) |
      STORE,
  );

const encU = (op: number, rd: number, imm20: number): number =>
  u32(((imm20 & 0xfffff) << 12) | ((rd & 0x1f) << 7) | op);

function encB(f3: number, rs1: number, rs2: number, off: number): number {
  return u32(
    (bit(off, 12) << 31) |
      (bits(off, 10, 5) << 25) |
      ((rs2 & 0x1f) << 20) |
      ((rs1 & 0x1f) << 15) |
      ((f3 & 7) << 12) |
      (bits(off, 4, 1) << 8) |
      (bit(off, 11) << 7) |
      BRANCH,
  );
}

function encJ(rd: number, off: number): number {
  return u32(
    (bit(off, 20) << 31) |
      (bits(off, 10, 1) << 21) |
      (bit(off, 11) << 20) |
      (bits(off, 19, 12) << 12) |
      ((rd & 0x1f) << 7) |
      JAL,
  );
}

// Compressed FP load/store (RV32FC) expand to the F-extension load/store opcodes (.s width = 2).
const encFlw = (rd: number, rs1: number, imm: number): number => encI(LOAD_FP, 2, rd, rs1, imm);
const encFsw = (rs1: number, rs2: number, imm: number): number =>
  u32(
    (((imm >> 5) & 0x7f) << 25) |
      ((rs2 & 0x1f) << 20) |
      ((rs1 & 0x1f) << 15) |
      (2 << 12) |
      ((imm & 0x1f) << 7) |
      STORE_FP,
  );

// Compressed double load/store (RV32DC) expand to the F/D load/store opcodes at width = 3 (.d).
const encFld = (rd: number, rs1: number, imm: number): number => encI(LOAD_FP, 3, rd, rs1, imm);
const encFsd = (rs1: number, rs2: number, imm: number): number =>
  u32(
    (((imm >> 5) & 0x7f) << 25) |
      ((rs2 & 0x1f) << 20) |
      ((rs1 & 0x1f) << 15) |
      (3 << 12) |
      ((imm & 0x1f) << 7) |
      STORE_FP,
  );

// Slli/srli/srai expand to OP-IMM I-type words; srai carries funct7=0x20 in its imm field.
const encSlli = (rd: number, rs1: number, shamt: number): number => encI(OP_IMM, 1, rd, rs1, shamt & 0x1f);
const encSrli = (rd: number, rs1: number, shamt: number): number => encI(OP_IMM, 5, rd, rs1, shamt & 0x1f);
const encSrai = (rd: number, rs1: number, shamt: number): number => encI(OP_IMM, 5, rd, rs1, 0x400 | (shamt & 0x1f));

// ---------------------------------------------------------------------------
// Immediate codecs (paired unpack/pack so encode and decode share one scramble)
// ---------------------------------------------------------------------------

// CIW: c.addi4spn — an 8-bit zero-extended word offset (already a byte count, *4 of a slot).
const ciwUnpack = (h: number): number =>
  (bits(h, 12, 11) << 4) | (bits(h, 10, 7) << 6) | (bit(h, 6) << 2) | (bit(h, 5) << 3);
const ciwPack = (v: number): number =>
  (bits(v, 5, 4) << 11) | (bits(v, 9, 6) << 7) | (bit(v, 2) << 6) | (bit(v, 3) << 5);

// CL/CS word: c.lw / c.sw — a 5-bit, word-scaled (×4) unsigned offset.
const clwUnpack = (h: number): number => (bit(h, 5) << 6) | (bits(h, 12, 10) << 3) | (bit(h, 6) << 2);
const clwPack = (v: number): number => (bit(v, 6) << 5) | (bits(v, 5, 3) << 10) | (bit(v, 2) << 6);

// CI signed 6-bit: c.addi / c.li / c.andi / shifts (shamt unsigned reuses the low 6 bits).
const ci6Unpack = (h: number): number => (bit(h, 12) << 5) | bits(h, 6, 2);
const ci6Pack = (v: number): number => (bit(v, 5) << 12) | (bits(v, 4, 0) << 2);

// CI c.lui: nzimm[17:12].
const cluiUnpack = (h: number): number => (bit(h, 12) << 5) | bits(h, 6, 2);
const cluiPack = (v: number): number => (bit(v, 5) << 12) | (bits(v, 4, 0) << 2);

// CI c.addi16sp: a 10-bit signed, 16-scaled stack adjustment.
const c16Unpack = (h: number): number =>
  (bit(h, 12) << 9) | (bits(h, 4, 3) << 7) | (bit(h, 5) << 6) | (bit(h, 2) << 5) | (bit(h, 6) << 4);
const c16Pack = (v: number): number =>
  (bit(v, 9) << 12) | (bits(v, 8, 7) << 3) | (bit(v, 6) << 5) | (bit(v, 5) << 2) | (bit(v, 4) << 6);

// CI c.lwsp: a 6-bit, word-scaled (×4) unsigned offset off sp.
const clwspUnpack = (h: number): number => (bit(h, 12) << 5) | (bits(h, 6, 4) << 2) | (bits(h, 3, 2) << 6);
const clwspPack = (v: number): number => (bit(v, 5) << 12) | (bits(v, 4, 2) << 4) | (bits(v, 7, 6) << 2);

// CSS c.swsp: a 6-bit, word-scaled (×4) unsigned offset off sp.
const cswspUnpack = (h: number): number => (bits(h, 12, 9) << 2) | (bits(h, 8, 7) << 6);
const cswspPack = (v: number): number => (bits(v, 5, 2) << 9) | (bits(v, 7, 6) << 7);

// CL/CS double: c.fld / c.fsd — an 8-bit, doubleword-scaled (×8) unsigned offset (uimm[7:3]).
const cldUnpack = (h: number): number => (bits(h, 6, 5) << 6) | (bits(h, 12, 10) << 3);
const cldPack = (v: number): number => (bits(v, 7, 6) << 5) | (bits(v, 5, 3) << 10);

// CI c.fldsp: a doubleword-scaled offset off sp — uimm[5]=h12, uimm[4:3]=h[6:5], uimm[8:6]=h[4:2].
const cldspUnpack = (h: number): number => (bit(h, 12) << 5) | (bits(h, 6, 5) << 3) | (bits(h, 4, 2) << 6);
const cldspPack = (v: number): number => (bit(v, 5) << 12) | (bits(v, 4, 3) << 5) | (bits(v, 8, 6) << 2);

// CSS c.fsdsp: a doubleword-scaled offset off sp — uimm[5:3]=h[12:10], uimm[8:6]=h[9:7].
const cfsdspUnpack = (h: number): number => (bits(h, 12, 10) << 3) | (bits(h, 9, 7) << 6);
const cfsdspPack = (v: number): number => (bits(v, 5, 3) << 10) | (bits(v, 8, 6) << 7);

// CJ c.j / c.jal: an 11-bit signed, 2-scaled jump offset.
const cjUnpack = (h: number): number =>
  (bit(h, 12) << 11) |
  (bit(h, 11) << 4) |
  (bits(h, 10, 9) << 8) |
  (bit(h, 8) << 10) |
  (bit(h, 7) << 6) |
  (bit(h, 6) << 7) |
  (bits(h, 5, 3) << 1) |
  (bit(h, 2) << 5);
const cjPack = (v: number): number =>
  (bit(v, 11) << 12) |
  (bit(v, 4) << 11) |
  (bits(v, 9, 8) << 9) |
  (bit(v, 10) << 8) |
  (bit(v, 6) << 7) |
  (bit(v, 7) << 6) |
  (bits(v, 3, 1) << 3) |
  (bit(v, 5) << 2);

// CB branch c.beqz / c.bnez: a 9-bit signed, 2-scaled branch offset.
const cbUnpack = (h: number): number =>
  (bit(h, 12) << 8) |
  (bits(h, 11, 10) << 3) |
  (bits(h, 6, 5) << 6) |
  (bits(h, 4, 3) << 1) |
  (bit(h, 2) << 5);
const cbPack = (v: number): number =>
  (bit(v, 8) << 12) |
  (bits(v, 4, 3) << 10) |
  (bits(v, 7, 6) << 5) |
  (bits(v, 2, 1) << 3) |
  (bit(v, 5) << 2);

// ---------------------------------------------------------------------------
// expandCompressed: 16-bit half-word → the canonical 32-bit base instruction.
// Returns null for illegal / reserved encodings.
// ---------------------------------------------------------------------------

export function expandCompressed(half: number): number | null {
  const h = half & 0xffff;
  const op = h & 0x3;
  const f3 = bits(h, 15, 13);

  if (h === 0) return null; // defined-illegal (c.unimp / all-zero)

  if (op === 0) {
    // ---- Quadrant 0 ----
    const rdp = creg(bits(h, 4, 2));
    const rs1p = creg(bits(h, 9, 7));
    switch (f3) {
      case 0: {
        // c.addi4spn → addi rd', x2, nzuimm
        const nz = ciwUnpack(h);
        if (nz === 0) return null; // reserved
        return encI(OP_IMM, 0, rdp, 2, nz);
      }
      case 1: // c.fld → fld rd', off(rs1')   (RV32DC)
        return encFld(rdp, rs1p, cldUnpack(h));
      case 2: // c.lw → lw rd', off(rs1')
        return encI(LOAD, 2, rdp, rs1p, clwUnpack(h));
      case 3: // c.flw → flw rd', off(rs1')   (RV32FC)
        return encFlw(rdp, rs1p, clwUnpack(h));
      case 5: // c.fsd → fsd rs2', off(rs1')   (RV32DC)
        return encFsd(rs1p, creg(bits(h, 4, 2)), cldUnpack(h));
      case 6: // c.sw → sw rs2', off(rs1')
        return encS(2, rs1p, creg(bits(h, 4, 2)), clwUnpack(h));
      case 7: // c.fsw → fsw rs2', off(rs1')   (RV32FC)
        return encFsw(rs1p, creg(bits(h, 4, 2)), clwUnpack(h));
      default:
        return null;
    }
  }

  if (op === 1) {
    // ---- Quadrant 1 ----
    switch (f3) {
      case 0: {
        // c.addi (rd=0,imm=0 ⇒ c.nop) → addi rd, rd, imm6
        const rd = bits(h, 11, 7);
        const imm = signExtend(ci6Unpack(h), 6);
        return encI(OP_IMM, 0, rd, rd, imm);
      }
      case 1: // c.jal → jal x1, off  (RV32 only)
        return encJ(1, signExtend(cjUnpack(h), 12));
      case 2: {
        // c.li → addi rd, x0, imm6
        const rd = bits(h, 11, 7);
        return encI(OP_IMM, 0, rd, 0, signExtend(ci6Unpack(h), 6));
      }
      case 3: {
        const rd = bits(h, 11, 7);
        if (rd === 2) {
          // c.addi16sp → addi x2, x2, nzimm
          const imm = signExtend(c16Unpack(h), 10);
          if (imm === 0) return null; // reserved
          return encI(OP_IMM, 0, 2, 2, imm);
        }
        // c.lui → lui rd, nzimm[17:12]
        if (rd === 0) return null; // HINT-only; treat dest-0 lui as reserved here
        const nz = cluiUnpack(h);
        if (nz === 0) return null; // reserved
        return encU(LUI, rd, signExtend(nz, 6) & 0xfffff);
      }
      case 4: {
        // MISC-ALU
        const rdp = creg(bits(h, 9, 7));
        const sel = bits(h, 11, 10);
        if (sel === 0 || sel === 1) {
          // c.srli / c.srai → shift rd', rd', shamt
          const shamt = ci6Unpack(h);
          if (shamt & 0x20) return null; // RV32: shamt[5] must be 0
          return sel === 0 ? encSrli(rdp, rdp, shamt & 0x1f) : encSrai(rdp, rdp, shamt & 0x1f);
        }
        if (sel === 2) {
          // c.andi → andi rd', rd', imm6
          return encI(OP_IMM, 7, rdp, rdp, signExtend(ci6Unpack(h), 6));
        }
        // sel === 3 : register-register ALU
        const rs2p = creg(bits(h, 4, 2));
        switch (bits(h, 6, 5)) {
          case 0:
            return encR(0x20, 0, rdp, rdp, rs2p); // c.sub
          case 1:
            return encR(0x00, 4, rdp, rdp, rs2p); // c.xor
          case 2:
            return encR(0x00, 6, rdp, rdp, rs2p); // c.or
          case 3:
            return encR(0x00, 7, rdp, rdp, rs2p); // c.and
        }
        return null;
      }
      case 5: // c.j → jal x0, off
        return encJ(0, signExtend(cjUnpack(h), 12));
      case 6: // c.beqz → beq rs1', x0, off
        return encB(0, creg(bits(h, 9, 7)), 0, signExtend(cbUnpack(h), 9));
      case 7: // c.bnez → bne rs1', x0, off
        return encB(1, creg(bits(h, 9, 7)), 0, signExtend(cbUnpack(h), 9));
    }
  }

  if (op === 2) {
    // ---- Quadrant 2 ----
    switch (f3) {
      case 0: {
        // c.slli → slli rd, rd, shamt
        const rd = bits(h, 11, 7);
        const shamt = ci6Unpack(h);
        if (shamt & 0x20) return null; // RV32
        return encSlli(rd, rd, shamt & 0x1f);
      }
      case 2: {
        // c.lwsp → lw rd, off(x2)
        const rd = bits(h, 11, 7);
        if (rd === 0) return null; // reserved
        return encI(LOAD, 2, rd, 2, clwspUnpack(h));
      }
      case 4: {
        const rd = bits(h, 11, 7);
        const rs2 = bits(h, 6, 2);
        const b12 = bit(h, 12);
        if (b12 === 0) {
          if (rs2 === 0) {
            // c.jr → jalr x0, 0(rs1)
            if (rd === 0) return null; // reserved
            return encI(JALR, 0, 0, rd, 0);
          }
          // c.mv → add rd, x0, rs2
          return encR(0, 0, rd, 0, rs2);
        }
        // b12 === 1
        if (rs2 === 0) {
          if (rd === 0) return 0x0010_0073; // c.ebreak
          // c.jalr → jalr x1, 0(rs1)
          return encI(JALR, 0, 1, rd, 0);
        }
        // c.add → add rd, rd, rs2
        return encR(0, 0, rd, rd, rs2);
      }
      case 1: // c.fldsp → fld rd, off(x2)   (RV32DC)
        return encFld(bits(h, 11, 7), 2, cldspUnpack(h));
      case 3: // c.flwsp → flw rd, off(x2)   (RV32FC)
        return encFlw(bits(h, 11, 7), 2, clwspUnpack(h));
      case 5: // c.fsdsp → fsd rs2, off(x2)   (RV32DC)
        return encFsd(2, bits(h, 6, 2), cfsdspUnpack(h));
      case 6: // c.swsp → sw rs2, off(x2)
        return encS(2, 2, bits(h, 6, 2), cswspUnpack(h));
      case 7: // c.fswsp → fsw rs2, off(x2)   (RV32FC)
        return encFsw(2, bits(h, 6, 2), cswspUnpack(h));
      default:
        return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// formatCompressed: render the idiomatic `c.*` assembly for the disassembler.
// ---------------------------------------------------------------------------

const r = (i: number): string => ABI_NAMES[i & 0x1f];
const fr = (i: number): string => FREG_ABI_NAMES[i & 0x1f];

export function formatCompressed(half: number, pc = 0): string {
  const h = half & 0xffff;
  const op = h & 0x3;
  const f3 = bits(h, 15, 13);
  const target = (off: number): string => hexWord((pc + off) >>> 0);

  if (h === 0) return 'c.unimp';

  if (op === 0) {
    const rdp = creg(bits(h, 4, 2));
    const rs1p = creg(bits(h, 9, 7));
    if (f3 === 0) {
      const nz = ciwUnpack(h);
      if (nz === 0) return `.half ${hexWord(h).slice(0, 6)}`;
      return `c.addi4spn ${r(rdp)}, sp, ${nz}`;
    }
    if (f3 === 1) return `c.fld ${fr(rdp)}, ${cldUnpack(h)}(${r(rs1p)})`;
    if (f3 === 2) return `c.lw ${r(rdp)}, ${clwUnpack(h)}(${r(rs1p)})`;
    if (f3 === 3) return `c.flw ${fr(rdp)}, ${clwUnpack(h)}(${r(rs1p)})`;
    if (f3 === 5) return `c.fsd ${fr(creg(bits(h, 4, 2)))}, ${cldUnpack(h)}(${r(rs1p)})`;
    if (f3 === 6) return `c.sw ${r(creg(bits(h, 4, 2)))}, ${clwUnpack(h)}(${r(rs1p)})`;
    if (f3 === 7) return `c.fsw ${fr(creg(bits(h, 4, 2)))}, ${clwUnpack(h)}(${r(rs1p)})`;
  } else if (op === 1) {
    switch (f3) {
      case 0: {
        const rd = bits(h, 11, 7);
        const imm = signExtend(ci6Unpack(h), 6);
        if (rd === 0) return 'c.nop';
        return `c.addi ${r(rd)}, ${imm}`;
      }
      case 1:
        return `c.jal ${target(signExtend(cjUnpack(h), 12))}`;
      case 2:
        return `c.li ${r(bits(h, 11, 7))}, ${signExtend(ci6Unpack(h), 6)}`;
      case 3: {
        const rd = bits(h, 11, 7);
        if (rd === 2) return `c.addi16sp sp, ${signExtend(c16Unpack(h), 10)}`;
        return `c.lui ${r(rd)}, 0x${(signExtend(cluiUnpack(h), 6) & 0xfffff).toString(16)}`;
      }
      case 4: {
        const rdp = creg(bits(h, 9, 7));
        const sel = bits(h, 11, 10);
        if (sel === 0) return `c.srli ${r(rdp)}, ${ci6Unpack(h) & 0x1f}`;
        if (sel === 1) return `c.srai ${r(rdp)}, ${ci6Unpack(h) & 0x1f}`;
        if (sel === 2) return `c.andi ${r(rdp)}, ${signExtend(ci6Unpack(h), 6)}`;
        const rs2p = creg(bits(h, 4, 2));
        return `${['c.sub', 'c.xor', 'c.or', 'c.and'][bits(h, 6, 5)]} ${r(rdp)}, ${r(rs2p)}`;
      }
      case 5:
        return `c.j ${target(signExtend(cjUnpack(h), 12))}`;
      case 6:
        return `c.beqz ${r(creg(bits(h, 9, 7)))}, ${target(signExtend(cbUnpack(h), 9))}`;
      case 7:
        return `c.bnez ${r(creg(bits(h, 9, 7)))}, ${target(signExtend(cbUnpack(h), 9))}`;
    }
  } else if (op === 2) {
    switch (f3) {
      case 0:
        return `c.slli ${r(bits(h, 11, 7))}, ${ci6Unpack(h) & 0x1f}`;
      case 1:
        return `c.fldsp ${fr(bits(h, 11, 7))}, ${cldspUnpack(h)}(sp)`;
      case 2:
        return `c.lwsp ${r(bits(h, 11, 7))}, ${clwspUnpack(h)}(sp)`;
      case 3:
        return `c.flwsp ${fr(bits(h, 11, 7))}, ${clwspUnpack(h)}(sp)`;
      case 4: {
        const rd = bits(h, 11, 7);
        const rs2 = bits(h, 6, 2);
        const b12 = bit(h, 12);
        if (b12 === 0) {
          if (rs2 === 0) return `c.jr ${r(rd)}`;
          return `c.mv ${r(rd)}, ${r(rs2)}`;
        }
        if (rs2 === 0) return rd === 0 ? 'c.ebreak' : `c.jalr ${r(rd)}`;
        return `c.add ${r(rd)}, ${r(rs2)}`;
      }
      case 5:
        return `c.fsdsp ${fr(bits(h, 6, 2))}, ${cfsdspUnpack(h)}(sp)`;
      case 6:
        return `c.swsp ${r(bits(h, 6, 2))}, ${cswspUnpack(h)}(sp)`;
      case 7:
        return `c.fswsp ${fr(bits(h, 6, 2))}, ${cswspUnpack(h)}(sp)`;
    }
  }
  return `.half ${hexWord(h).slice(0, 6)}`;
}

// ---------------------------------------------------------------------------
// Assembler side: encode an explicit c.* mnemonic, and auto-compress base ops.
// ---------------------------------------------------------------------------

/** The set of explicit compressed mnemonics the assembler accepts. */
export const RVC_MNEMONICS: ReadonlySet<string> = new Set([
  'c.addi4spn', 'c.lw', 'c.sw', 'c.nop', 'c.addi', 'c.jal', 'c.li', 'c.addi16sp', 'c.lui',
  'c.srli', 'c.srai', 'c.andi', 'c.sub', 'c.xor', 'c.or', 'c.and', 'c.j', 'c.beqz', 'c.bnez',
  'c.slli', 'c.lwsp', 'c.jr', 'c.mv', 'c.ebreak', 'c.jalr', 'c.add', 'c.swsp', 'c.unimp',
  'c.flw', 'c.fsw', 'c.flwsp', 'c.fswsp',
  'c.fld', 'c.fsd', 'c.fldsp', 'c.fsdsp',
]);

/** True if `reg` is one of x8..x15 (the 3-bit compressed register class). */
export function isCompactReg(reg: number): boolean {
  return reg >= 8 && reg <= 15;
}

/**
 * Encode the *body* (everything above the low 2-bit opcode quadrant) for one compressed
 * instruction from already-resolved operands. Returns the full 16-bit half-word, or throws
 * the given `fault(msg)` when an operand violates a compressed-form constraint. `off` is the
 * pc-relative byte offset for the control-flow forms.
 */
export interface RvcFields {
  rd: number;
  rs1: number;
  rs2: number;
  imm: number;
  /** pc-relative offset already resolved (for c.j/c.jal/c.beqz/c.bnez). */
  off: number;
}

export function encodeCompressed(name: string, f: RvcFields, fault: (m: string) => never): number {
  const need = (cond: boolean, msg: string) => {
    if (!cond) fault(msg);
  };
  const cf = (reg: number): number => {
    need(isCompactReg(reg), `${name} requires register x8..x15 (got ${r(reg)})`);
    return reg & 0x7;
  };
  switch (name) {
    case 'c.unimp':
      return 0x0000;
    case 'c.nop':
      return 0x0001;
    case 'c.ebreak':
      return 0x9002;

    case 'c.addi4spn': {
      need(f.imm > 0 && f.imm < 1024 && (f.imm & 3) === 0, `c.addi4spn offset 4..1020 (×4), got ${f.imm}`);
      return 0x0000 | (cf(f.rd) << 2) | ciwPack(f.imm);
    }
    case 'c.lw':
      need((f.imm & 3) === 0 && f.imm >= 0 && f.imm < 128, `c.lw offset 0..124 (×4), got ${f.imm}`);
      return 0x4000 | (cf(f.rs1) << 7) | (cf(f.rd) << 2) | clwPack(f.imm);
    case 'c.sw':
      need((f.imm & 3) === 0 && f.imm >= 0 && f.imm < 128, `c.sw offset 0..124 (×4), got ${f.imm}`);
      return 0xc000 | (cf(f.rs1) << 7) | (cf(f.rs2) << 2) | clwPack(f.imm);
    case 'c.flw':
      need((f.imm & 3) === 0 && f.imm >= 0 && f.imm < 128, `c.flw offset 0..124 (×4), got ${f.imm}`);
      return 0x6000 | (cf(f.rs1) << 7) | (cf(f.rd) << 2) | clwPack(f.imm);
    case 'c.fsw':
      need((f.imm & 3) === 0 && f.imm >= 0 && f.imm < 128, `c.fsw offset 0..124 (×4), got ${f.imm}`);
      return 0xe000 | (cf(f.rs1) << 7) | (cf(f.rs2) << 2) | clwPack(f.imm);
    case 'c.fld':
      need((f.imm & 7) === 0 && f.imm >= 0 && f.imm < 256, `c.fld offset 0..248 (×8), got ${f.imm}`);
      return 0x2000 | (cf(f.rs1) << 7) | (cf(f.rd) << 2) | cldPack(f.imm);
    case 'c.fsd':
      need((f.imm & 7) === 0 && f.imm >= 0 && f.imm < 256, `c.fsd offset 0..248 (×8), got ${f.imm}`);
      return 0xa000 | (cf(f.rs1) << 7) | (cf(f.rs2) << 2) | cldPack(f.imm);

    case 'c.addi':
      need(f.rd !== 0, 'c.addi destination must not be x0');
      need(f.imm >= -32 && f.imm <= 31, `c.addi immediate -32..31, got ${f.imm}`);
      return 0x0001 | (f.rd << 7) | ci6Pack(f.imm & 0x3f);
    case 'c.li':
      need(f.rd !== 0, 'c.li destination must not be x0');
      need(f.imm >= -32 && f.imm <= 31, `c.li immediate -32..31, got ${f.imm}`);
      return 0x4001 | (f.rd << 7) | ci6Pack(f.imm & 0x3f);
    case 'c.addi16sp':
      need(f.imm !== 0 && f.imm >= -512 && f.imm <= 496 && (f.imm & 15) === 0, `c.addi16sp imm -512..496 (×16), got ${f.imm}`);
      return 0x6101 | c16Pack(f.imm & 0x3ff);
    case 'c.lui':
      need(f.rd !== 0 && f.rd !== 2, 'c.lui destination must not be x0/sp');
      need((f.imm & 0x1f) === f.imm && f.imm !== 0 ? true : f.imm >= -32 && f.imm <= 31 && f.imm !== 0, `c.lui imm -32..31 (≠0), got ${f.imm}`);
      return 0x6001 | (f.rd << 7) | cluiPack(f.imm & 0x3f);

    case 'c.srli':
      need(f.imm >= 1 && f.imm < 32, `c.srli shamt 1..31, got ${f.imm}`);
      return 0x8001 | (cf(f.rd) << 7) | ci6Pack(f.imm & 0x3f);
    case 'c.srai':
      need(f.imm >= 1 && f.imm < 32, `c.srai shamt 1..31, got ${f.imm}`);
      return 0x8401 | (cf(f.rd) << 7) | ci6Pack(f.imm & 0x3f);
    case 'c.andi':
      need(f.imm >= -32 && f.imm <= 31, `c.andi imm -32..31, got ${f.imm}`);
      return 0x8801 | (cf(f.rd) << 7) | ci6Pack(f.imm & 0x3f);
    case 'c.sub':
      return 0x8c01 | (cf(f.rd) << 7) | (cf(f.rs2) << 2);
    case 'c.xor':
      return 0x8c21 | (cf(f.rd) << 7) | (cf(f.rs2) << 2);
    case 'c.or':
      return 0x8c41 | (cf(f.rd) << 7) | (cf(f.rs2) << 2);
    case 'c.and':
      return 0x8c61 | (cf(f.rd) << 7) | (cf(f.rs2) << 2);

    case 'c.j':
      need(f.off >= -2048 && f.off <= 2046 && (f.off & 1) === 0, `c.j target out of ±2KiB range (${f.off})`);
      return 0xa001 | cjPack(f.off & 0xfff);
    case 'c.jal':
      need(f.off >= -2048 && f.off <= 2046 && (f.off & 1) === 0, `c.jal target out of ±2KiB range (${f.off})`);
      return 0x2001 | cjPack(f.off & 0xfff);
    case 'c.beqz':
      need(f.off >= -256 && f.off <= 254 && (f.off & 1) === 0, `c.beqz target out of ±256B range (${f.off})`);
      return 0xc001 | (cf(f.rs1) << 7) | cbPack(f.off & 0x1ff);
    case 'c.bnez':
      need(f.off >= -256 && f.off <= 254 && (f.off & 1) === 0, `c.bnez target out of ±256B range (${f.off})`);
      return 0xe001 | (cf(f.rs1) << 7) | cbPack(f.off & 0x1ff);

    case 'c.slli':
      need(f.rd !== 0, 'c.slli destination must not be x0');
      need(f.imm >= 1 && f.imm < 32, `c.slli shamt 1..31, got ${f.imm}`);
      return 0x0002 | (f.rd << 7) | ci6Pack(f.imm & 0x3f);
    case 'c.lwsp':
      need(f.rd !== 0, 'c.lwsp destination must not be x0');
      need((f.imm & 3) === 0 && f.imm >= 0 && f.imm < 256, `c.lwsp offset 0..252 (×4), got ${f.imm}`);
      return 0x4002 | (f.rd << 7) | clwspPack(f.imm);
    case 'c.swsp':
      need((f.imm & 3) === 0 && f.imm >= 0 && f.imm < 256, `c.swsp offset 0..252 (×4), got ${f.imm}`);
      return 0xc002 | (f.rs2 << 2) | cswspPack(f.imm);
    case 'c.flwsp':
      need((f.imm & 3) === 0 && f.imm >= 0 && f.imm < 256, `c.flwsp offset 0..252 (×4), got ${f.imm}`);
      return 0x6002 | (f.rd << 7) | clwspPack(f.imm);
    case 'c.fswsp':
      need((f.imm & 3) === 0 && f.imm >= 0 && f.imm < 256, `c.fswsp offset 0..252 (×4), got ${f.imm}`);
      return 0xe002 | (f.rs2 << 2) | cswspPack(f.imm);
    case 'c.fldsp':
      need(f.rd !== 0, 'c.fldsp destination must not be x0');
      need((f.imm & 7) === 0 && f.imm >= 0 && f.imm < 512, `c.fldsp offset 0..504 (×8), got ${f.imm}`);
      return 0x2002 | (f.rd << 7) | cldspPack(f.imm);
    case 'c.fsdsp':
      need((f.imm & 7) === 0 && f.imm >= 0 && f.imm < 512, `c.fsdsp offset 0..504 (×8), got ${f.imm}`);
      return 0xa002 | (f.rs2 << 2) | cfsdspPack(f.imm);
    case 'c.jr':
      need(f.rs1 !== 0, 'c.jr source must not be x0');
      return 0x8002 | (f.rs1 << 7);
    case 'c.jalr':
      need(f.rs1 !== 0, 'c.jalr source must not be x0');
      return 0x9002 | (f.rs1 << 7);
    case 'c.mv':
      need(f.rd !== 0 && f.rs2 !== 0, 'c.mv operands must not be x0');
      return 0x8002 | (f.rd << 7) | (f.rs2 << 2);
    case 'c.add':
      need(f.rd !== 0 && f.rs2 !== 0, 'c.add operands must not be x0');
      return 0x9002 | (f.rd << 7) | (f.rs2 << 2);
  }
  fault(`unknown compressed instruction '${name}'`);
}
