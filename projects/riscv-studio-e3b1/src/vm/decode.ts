// Instruction decoder: a 32-bit word → a structured DecodedInstruction.
//
// This is the front half of the execute pipeline and is also what the disassembler
// renders. The immediate-field bit gymnastics here are the real RISC-V encodings (the
// scrambled B/J layouts that let the sign bit always land in bit 31).

import { signExtend, u32 } from './format';
import { OPC } from './isa';

export type DecodedFormat = 'R' | 'I' | 'S' | 'B' | 'U' | 'J' | 'SYS' | 'FENCE' | 'UNKNOWN';

export interface DecodedInstruction {
  readonly raw: number;
  readonly opcode: number;
  readonly rd: number;
  readonly rs1: number;
  readonly rs2: number;
  readonly funct3: number;
  readonly funct7: number;
  /** Sign-extended immediate appropriate to the instruction format. */
  readonly imm: number;
  readonly format: DecodedFormat;
  /** Resolved mnemonic, or 'unknown' if the encoding is not recognised. */
  readonly mnemonic: string;
}

function bits(word: number, hi: number, lo: number): number {
  return (word >>> lo) & ((1 << (hi - lo + 1)) - 1);
}

function formatOf(opcode: number): DecodedFormat {
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
    case OPC.SYSTEM:
      return 'SYS';
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
  const funct3 = bits(w, 14, 12);
  const funct7 = bits(w, 31, 25);
  const format = formatOf(opcode);

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
    default:
      break; // R / SYS / FENCE / UNKNOWN carry no immediate
  }

  return {
    raw: w,
    opcode,
    rd,
    rs1,
    rs2,
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
    case OPC.OP_IMM:
      if (funct3 === 1) return 'slli';
      if (funct3 === 5) return funct7 === 0x20 ? 'srai' : 'srli';
      return { 0: 'addi', 2: 'slti', 3: 'sltiu', 4: 'xori', 6: 'ori', 7: 'andi' }[funct3] ?? '?';
    case OPC.OP:
      if (funct7 === 0x01) {
        return ['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu'][funct3];
      }
      if (funct3 === 0) return funct7 === 0x20 ? 'sub' : 'add';
      if (funct3 === 5) return funct7 === 0x20 ? 'sra' : 'srl';
      return { 1: 'sll', 2: 'slt', 3: 'sltu', 4: 'xor', 6: 'or', 7: 'and' }[funct3] ?? '?';
    case OPC.SYSTEM:
      return (w & 0x0010_0000) !== 0 ? 'ebreak' : 'ecall';
    case OPC.MISC_MEM:
      return 'fence';
    default:
      return 'unknown';
  }
}
