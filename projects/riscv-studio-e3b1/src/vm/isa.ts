// The RV32IM instruction set, described as data.
//
// Every real instruction is specified once here by its encoding fields (opcode, funct3,
// funct7) and format. The assembler reads this table to encode, and the decoder reads it
// to disassemble — a single source of truth that keeps the two halves in lock-step.

export type Format = 'R' | 'I' | 'S' | 'B' | 'U' | 'J' | 'SHIFT' | 'SYS' | 'FENCE';

export interface InstrSpec {
  readonly name: string;
  readonly format: Format;
  readonly opcode: number;
  readonly funct3?: number;
  /** funct7 for R-type, or the high immediate bit for shift-immediate ops. */
  readonly funct7?: number;
}

// Opcodes (the low 7 bits).
export const OPC = {
  LUI: 0x37,
  AUIPC: 0x17,
  JAL: 0x6f,
  JALR: 0x67,
  BRANCH: 0x63,
  LOAD: 0x03,
  STORE: 0x23,
  OP_IMM: 0x13,
  OP: 0x33,
  MISC_MEM: 0x0f,
  SYSTEM: 0x73,
} as const;

function r(name: string, funct3: number, funct7: number): InstrSpec {
  return { name, format: 'R', opcode: OPC.OP, funct3, funct7 };
}
function i(name: string, opcode: number, funct3: number): InstrSpec {
  return { name, format: 'I', opcode, funct3 };
}
function shift(name: string, funct3: number, funct7: number): InstrSpec {
  return { name, format: 'SHIFT', opcode: OPC.OP_IMM, funct3, funct7 };
}
function s(name: string, funct3: number): InstrSpec {
  return { name, format: 'S', opcode: OPC.STORE, funct3 };
}
function b(name: string, funct3: number): InstrSpec {
  return { name, format: 'B', opcode: OPC.BRANCH, funct3 };
}

/** Mnemonic → encoding spec for every base instruction the assembler understands. */
export const INSTRUCTIONS: Record<string, InstrSpec> = {
  // U-type
  lui: { name: 'lui', format: 'U', opcode: OPC.LUI },
  auipc: { name: 'auipc', format: 'U', opcode: OPC.AUIPC },

  // J / jumps
  jal: { name: 'jal', format: 'J', opcode: OPC.JAL },
  jalr: { name: 'jalr', format: 'I', opcode: OPC.JALR, funct3: 0 },

  // Branches
  beq: b('beq', 0),
  bne: b('bne', 1),
  blt: b('blt', 4),
  bge: b('bge', 5),
  bltu: b('bltu', 6),
  bgeu: b('bgeu', 7),

  // Loads
  lb: i('lb', OPC.LOAD, 0),
  lh: i('lh', OPC.LOAD, 1),
  lw: i('lw', OPC.LOAD, 2),
  lbu: i('lbu', OPC.LOAD, 4),
  lhu: i('lhu', OPC.LOAD, 5),

  // Stores
  sb: s('sb', 0),
  sh: s('sh', 1),
  sw: s('sw', 2),

  // OP-IMM
  addi: i('addi', OPC.OP_IMM, 0),
  slti: i('slti', OPC.OP_IMM, 2),
  sltiu: i('sltiu', OPC.OP_IMM, 3),
  xori: i('xori', OPC.OP_IMM, 4),
  ori: i('ori', OPC.OP_IMM, 6),
  andi: i('andi', OPC.OP_IMM, 7),
  slli: shift('slli', 1, 0x00),
  srli: shift('srli', 5, 0x00),
  srai: shift('srai', 5, 0x20),

  // OP (R-type) — base
  add: r('add', 0, 0x00),
  sub: r('sub', 0, 0x20),
  sll: r('sll', 1, 0x00),
  slt: r('slt', 2, 0x00),
  sltu: r('sltu', 3, 0x00),
  xor: r('xor', 4, 0x00),
  srl: r('srl', 5, 0x00),
  sra: r('sra', 5, 0x20),
  or: r('or', 6, 0x00),
  and: r('and', 7, 0x00),

  // OP (R-type) — M extension (funct7 = 0x01)
  mul: r('mul', 0, 0x01),
  mulh: r('mulh', 1, 0x01),
  mulhsu: r('mulhsu', 2, 0x01),
  mulhu: r('mulhu', 3, 0x01),
  div: r('div', 4, 0x01),
  divu: r('divu', 5, 0x01),
  rem: r('rem', 6, 0x01),
  remu: r('remu', 7, 0x01),

  // System / misc
  ecall: { name: 'ecall', format: 'SYS', opcode: OPC.SYSTEM, funct3: 0, funct7: 0 },
  ebreak: { name: 'ebreak', format: 'SYS', opcode: OPC.SYSTEM, funct3: 0, funct7: 1 },
  fence: { name: 'fence', format: 'FENCE', opcode: OPC.MISC_MEM, funct3: 0 },
};

/** Set of every recognised real mnemonic (lowercased). */
export const REAL_MNEMONICS: ReadonlySet<string> = new Set(Object.keys(INSTRUCTIONS));
