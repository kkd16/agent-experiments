// Instruction decoder: a 32-bit word → a structured DecodedInstruction.
//
// This is the front half of the execute pipeline and is also what the disassembler
// renders. The immediate-field bit gymnastics here are the real RISC-V encodings (the
// scrambled B/J layouts that let the sign bit always land in bit 31).

import { signExtend, u32 } from './format';
import { OPC } from './isa';
import { isFpOpcode, decodeFpMnemonic, FP_OPC } from './fp';

export type DecodedFormat =
  | 'R'
  | 'I'
  | 'S'
  | 'B'
  | 'U'
  | 'J'
  | 'SYS'
  | 'FENCE'
  | 'AMO'
  | 'CSR'
  | 'FP'
  | 'UNKNOWN';

export interface DecodedInstruction {
  readonly raw: number;
  readonly opcode: number;
  readonly rd: number;
  readonly rs1: number;
  readonly rs2: number;
  readonly funct3: number;
  readonly funct7: number;
  /** Third source register (R4-type fused multiply-add); 0 otherwise. */
  readonly rs3: number;
  /** Sign-extended immediate appropriate to the instruction format. */
  readonly imm: number;
  readonly format: DecodedFormat;
  /** Resolved mnemonic, or 'unknown' if the encoding is not recognised. */
  readonly mnemonic: string;
}

function bits(word: number, hi: number, lo: number): number {
  return (word >>> lo) & ((1 << (hi - lo + 1)) - 1);
}

// Bit-manipulation R-type ops (Zba/Zbb/Zbc/Zbs) in the OP opcode, keyed by `funct7 * 8 + funct3`
// so the decoder resolves them with a single table lookup before the base-ISA fall-through.
const ZB_OP: Record<number, string> = Object.fromEntries(
  (
    [
      [0x10, 2, 'sh1add'], [0x10, 4, 'sh2add'], [0x10, 6, 'sh3add'],
      [0x20, 7, 'andn'], [0x20, 6, 'orn'], [0x20, 4, 'xnor'],
      [0x05, 4, 'min'], [0x05, 5, 'minu'], [0x05, 6, 'max'], [0x05, 7, 'maxu'],
      [0x30, 1, 'rol'], [0x30, 5, 'ror'],
      [0x04, 4, 'zext.h'],
      [0x05, 1, 'clmul'], [0x05, 2, 'clmulr'], [0x05, 3, 'clmulh'],
      [0x24, 1, 'bclr'], [0x24, 5, 'bext'], [0x34, 1, 'binv'], [0x14, 1, 'bset'],
    ] as [number, number, string][]
  ).map(([f7, f3, name]) => [f7 * 8 + f3, name]),
);

function formatOf(opcode: number, funct3: number): DecodedFormat {
  switch (opcode) {
    case OPC.LUI:
    case OPC.AUIPC:
      return 'U';
    case OPC.JAL:
      return 'J';
    case OPC.JALR:
    case OPC.LOAD:
    case OPC.OP_IMM:
      return 'I';
    case OPC.BRANCH:
      return 'B';
    case OPC.STORE:
      return 'S';
    case OPC.OP:
      return 'R';
    case OPC.AMO:
      return 'AMO';
    case OPC.SYSTEM:
      return funct3 === 0 ? 'SYS' : 'CSR';
    case OPC.MISC_MEM:
      return 'FENCE';
    default:
      return 'UNKNOWN';
  }
}

function immI(w: number): number {
  return signExtend(bits(w, 31, 20), 12);
}
function immS(w: number): number {
  return signExtend((bits(w, 31, 25) << 5) | bits(w, 11, 7), 12);
}
function immB(w: number): number {
  const imm =
    (bits(w, 31, 31) << 12) |
    (bits(w, 7, 7) << 11) |
    (bits(w, 30, 25) << 5) |
    (bits(w, 11, 8) << 1);
  return signExtend(imm, 13);
}
function immU(w: number): number {
  // Already aligned to bit 12; keep the full 32-bit value.
  return w & 0xffff_f000;
}
function immJ(w: number): number {
  const imm =
    (bits(w, 31, 31) << 20) |
    (bits(w, 19, 12) << 12) |
    (bits(w, 20, 20) << 11) |
    (bits(w, 30, 21) << 1);
  return signExtend(imm, 21);
}

export function decode(word: number): DecodedInstruction {
  const w = u32(word);
  const opcode = bits(w, 6, 0);
  const rd = bits(w, 11, 7);
  const rs1 = bits(w, 19, 15);
  const rs2 = bits(w, 24, 20);
  const rs3 = bits(w, 31, 27);
  const funct3 = bits(w, 14, 12);
  const funct7 = bits(w, 31, 25);

  // Floating-point opcodes get their own decode path (loads/stores carry I/S immediates).
  if (isFpOpcode(opcode)) {
    let imm = 0;
    if (opcode === FP_OPC.LOAD_FP) imm = immI(w);
    else if (opcode === FP_OPC.STORE_FP) imm = immS(w);
    return {
      raw: w,
      opcode,
      rd,
      rs1,
      rs2,
      rs3,
      funct3,
      funct7,
      imm,
      format: 'FP',
      mnemonic: decodeFpMnemonic(opcode, funct7, funct3, rs2),
    };
  }

  const format = formatOf(opcode, funct3);

  let imm = 0;
  switch (format) {
    case 'I':
      imm = immI(w);
      break;
    case 'S':
      imm = immS(w);
      break;
    case 'B':
      imm = immB(w);
      break;
    case 'U':
      imm = immU(w);
      break;
    case 'J':
      imm = immJ(w);
      break;
    case 'CSR':
      // CSR address sits in the I-immediate slot (unsigned 12-bit).
      imm = bits(w, 31, 20);
      break;
    default:
      break; // R / AMO / SYS / FENCE / UNKNOWN carry no decoded immediate
  }

  return {
    raw: w,
    opcode,
    rd,
    rs1,
    rs2,
    rs3,
    funct3,
    funct7,
    imm,
    format,
    mnemonic: resolveMnemonic(opcode, funct3, funct7, w),
  };
}

/** Map an encoding back to its mnemonic, handling the funct3/funct7-disambiguated cases. */
function resolveMnemonic(opcode: number, funct3: number, funct7: number, w: number): string {
  switch (opcode) {
    case OPC.LUI:
      return 'lui';
    case OPC.AUIPC:
      return 'auipc';
    case OPC.JAL:
      return 'jal';
    case OPC.JALR:
      return 'jalr';
    case OPC.BRANCH:
      return ['beq', 'bne', '?', '?', 'blt', 'bge', 'bltu', 'bgeu'][funct3];
    case OPC.LOAD:
      return { 0: 'lb', 1: 'lh', 2: 'lw', 4: 'lbu', 5: 'lhu' }[funct3] ?? '?';
    case OPC.STORE:
      return { 0: 'sb', 1: 'sh', 2: 'sw' }[funct3] ?? '?';
    case OPC.OP_IMM: {
      const rs2 = (w >>> 20) & 0x1f;
      if (funct3 === 1) {
        switch (funct7) {
          case 0x24:
            return 'bclri';
          case 0x34:
            return 'binvi';
          case 0x14:
            return 'bseti';
          case 0x30:
            return (
              { 0x00: 'clz', 0x01: 'ctz', 0x02: 'cpop', 0x04: 'sext.b', 0x05: 'sext.h' }[rs2] ?? 'slli'
            );
          default:
            return 'slli';
        }
      }
      if (funct3 === 5) {
        switch (funct7) {
          case 0x20:
            return 'srai';
          case 0x30:
            return 'rori';
          case 0x24:
            return 'bexti';
          case 0x14:
            return rs2 === 0x07 ? 'orc.b' : 'srli';
          case 0x34:
            return rs2 === 0x18 ? 'rev8' : 'srli';
          default:
            return 'srli';
        }
      }
      return { 0: 'addi', 2: 'slti', 3: 'sltiu', 4: 'xori', 6: 'ori', 7: 'andi' }[funct3] ?? '?';
    }
    case OPC.OP: {
      if (funct7 === 0x01) {
        return ['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu'][funct3];
      }
      // Bit-manipulation R-type ops live in this opcode, keyed by (funct7, funct3).
      const zb = ZB_OP[funct7 * 8 + funct3];
      if (zb) return zb;
      if (funct3 === 0) return funct7 === 0x20 ? 'sub' : 'add';
      if (funct3 === 5) return funct7 === 0x20 ? 'sra' : 'srl';
      return { 1: 'sll', 2: 'slt', 3: 'sltu', 4: 'xor', 6: 'or', 7: 'and' }[funct3] ?? '?';
    }
    case OPC.AMO: {
      const funct5 = (funct7 >> 2) & 0x1f;
      return (
        {
          0x00: 'amoadd.w',
          0x01: 'amoswap.w',
          0x02: 'lr.w',
          0x03: 'sc.w',
          0x04: 'amoxor.w',
          0x08: 'amoor.w',
          0x0c: 'amoand.w',
          0x10: 'amomin.w',
          0x14: 'amomax.w',
          0x18: 'amominu.w',
          0x1c: 'amomaxu.w',
        }[funct5] ?? 'unknown'
      );
    }
    case OPC.SYSTEM:
      if (funct3 === 0) {
        // sfence.vma carries register operands, so it is identified by its funct7, not funct12.
        if (funct7 === 0x09) return 'sfence.vma';
        switch (w >>> 20) {
          case 0x000:
            return 'ecall';
          case 0x001:
            return 'ebreak';
          case 0x102:
            return 'sret';
          case 0x302:
            return 'mret';
          case 0x105:
            return 'wfi';
          default:
            return 'unknown';
        }
      }
      return { 1: 'csrrw', 2: 'csrrs', 3: 'csrrc', 5: 'csrrwi', 6: 'csrrsi', 7: 'csrrci' }[funct3] ?? 'unknown';
    case OPC.MISC_MEM:
      return 'fence';
    default:
      return 'unknown';
  }
}
