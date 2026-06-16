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
  AMO: 0x2f,
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

  // Privileged trap-return / fence / hint (encoded as full SYSTEM funct12s; see SYS_WORDS)
  mret: { name: 'mret', format: 'SYS', opcode: OPC.SYSTEM, funct3: 0 },
  sret: { name: 'sret', format: 'SYS', opcode: OPC.SYSTEM, funct3: 0 },
  wfi: { name: 'wfi', format: 'SYS', opcode: OPC.SYSTEM, funct3: 0 },
  // sfence.vma is modelled as a full TLB flush, so it encodes with zero rs1/rs2 (flush-all).
  'sfence.vma': { name: 'sfence.vma', format: 'SYS', opcode: OPC.SYSTEM, funct3: 0 },
};

/** Fully-specified 32-bit encodings for the operand-less SYSTEM instructions. */
export const SYS_WORDS: Record<string, number> = {
  ecall: 0x0000_0073,
  ebreak: 0x0010_0073,
  mret: 0x3020_0073,
  sret: 0x1020_0073,
  wfi: 0x1050_0073,
  'sfence.vma': 0x1200_0073, // sfence.vma x0, x0 — flush everything
};

/** Set of every recognised base (RV32IM) mnemonic (lowercased). */
export const REAL_MNEMONICS: ReadonlySet<string> = new Set(Object.keys(INSTRUCTIONS));

// ---------------------------------------------------------------------------
// RV32A (atomics) and Zicsr encoding data — kept here as the single source of
// truth, mirroring the INSTRUCTIONS table above.
// ---------------------------------------------------------------------------

/** AMO mnemonic → its 5-bit funct5 selector (bits 31:27 of the encoding). */
export const AMO_FUNCT5: Record<string, number> = {
  'amoadd.w': 0x00,
  'amoswap.w': 0x01,
  'lr.w': 0x02,
  'sc.w': 0x03,
  'amoxor.w': 0x04,
  'amoor.w': 0x08,
  'amoand.w': 0x0c,
  'amomin.w': 0x10,
  'amomax.w': 0x14,
  'amominu.w': 0x18,
  'amomaxu.w': 0x1c,
};
export const AMO_MNEMONICS: ReadonlySet<string> = new Set(Object.keys(AMO_FUNCT5));

/** CSR op mnemonic → its funct3 selector. */
export const CSR_FUNCT3: Record<string, number> = {
  csrrw: 1,
  csrrs: 2,
  csrrc: 3,
  csrrwi: 5,
  csrrsi: 6,
  csrrci: 7,
};
export const CSR_MNEMONICS: ReadonlySet<string> = new Set(Object.keys(CSR_FUNCT3));

/** Symbolic CSR names the assembler accepts in place of a raw address. */
export const CSR_NUMBERS: Record<string, number> = {
  fflags: 0x001,
  frm: 0x002,
  fcsr: 0x003,
  cycle: 0xc00,
  time: 0xc01,
  instret: 0xc02,
  cycleh: 0xc80,
  timeh: 0xc81,
  instreth: 0xc82,
  // Supervisor-mode trap CSRs + the Sv32 MMU control register
  sstatus: 0x100,
  sie: 0x104,
  stvec: 0x105,
  sscratch: 0x140,
  sepc: 0x141,
  scause: 0x142,
  stval: 0x143,
  sip: 0x144,
  satp: 0x180,
  // Machine-mode trap CSRs
  mstatus: 0x300,
  misa: 0x301,
  medeleg: 0x302,
  mideleg: 0x303,
  mie: 0x304,
  mtvec: 0x305,
  mscratch: 0x340,
  mepc: 0x341,
  mcause: 0x342,
  mtval: 0x343,
  mip: 0x344,
  mvendorid: 0xf11,
  marchid: 0xf12,
  mimpid: 0xf13,
  mhartid: 0xf14,
};
