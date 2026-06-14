// A two-pass RV32IM assembler.
//
// Pipeline:
//   1. pre-scan    — collect `.equ` / `NAME = value` constants (needed to size `li`).
//   2. parse       — turn each source line into labels + a directive or instruction.
//   3. layout      — walk items in source order, expanding pseudo-instructions into real
//                    "micro" instructions, assigning addresses to text and data, and
//                    recording every label's address.
//   4. encode      — now that all symbols are known, encode each micro into a 32-bit word
//                    and resolve data relocations (`.word label`).
//
// Errors are accumulated with line numbers rather than thrown, so the editor can show as
// many problems as possible at once.

import {
  DATA_BASE,
  TEXT_BASE,
} from './constants';
import {
  INSTRUCTIONS,
  OPC,
  AMO_FUNCT5,
  AMO_MNEMONICS,
  CSR_FUNCT3,
  CSR_MNEMONICS,
  CSR_NUMBERS,
  SYS_WORDS,
} from './isa';
import type { InstrSpec } from './isa';
import { regIndex, fregIndex } from './registers';
import { FP_SPECS, FP_MNEMONICS, rmFromName } from './fp';
import { parseIntLiteral, signExtend, charCode, u32 } from './format';
import { C_MNEMONICS, encodeC } from './compressed';

export interface AsmError {
  line: number;
  message: string;
}

export interface AsmInstr {
  addr: number;
  word: number;
  line: number;
  source: string;
  /** Encoded byte length: 2 for an RV32C instruction, 4 otherwise. */
  len: number;
}

export interface AssembleResult {
  ok: boolean;
  errors: AsmError[];
  /** Byte writes to apply to memory (text words + data). */
  writes: { addr: number; bytes: number[] }[];
  /** Encoded text instructions, sorted by address, for the disassembly view. */
  instrs: AsmInstr[];
  symbols: Map<string, number>;
  lineToAddr: Map<number, number>;
  addrToLine: Map<number, number>;
  entry: number;
  textRange: [number, number];
  dataRange: [number, number];
}

type Reloc = 'abs' | 'hi' | 'lo' | 'rel';
type ImmSrc = { kind: 'num'; value: number } | { kind: 'sym'; name: string; reloc: Reloc };

interface MicroInstr {
  mnemonic: string;
  rd: number;
  rs1: number;
  rs2: number;
  imm: ImmSrc;
  line: number;
  source: string;
  /** Third source register for RV32F fused multiply-add (R4-type). */
  rs3?: number;
  /** Rounding mode (funct3) for RV32F ops; 7 = dynamic. */
  rm?: number;
  /** CSR address for Zicsr ops (also marks this micro as a CSR instruction). */
  csr?: number;
  /** Precomputed funct7 (funct5<<2 | aq<<1 | rl) for RV32A atomics. */
  amoFunct7?: number;
  /** When set, this is an RV32C instruction encoded to a 16-bit half-word. */
  compressed?: boolean;
}

type ByteSrc = { kind: 'lit'; values: number[] } | { kind: 'word'; imm: ImmSrc };

interface Slot {
  addr: number;
  size: number;
  line: number;
  source: string;
  micro: MicroInstr | null;
  bytes: ByteSrc[] | null;
}

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

/** Strip a `#` or `//` comment while respecting double-quoted strings. */
function stripComment(line: string): string {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === '#') {
      return line.slice(0, i);
    } else if (c === '/' && line[i + 1] === '/') {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Split a comma-separated operand list, honouring quotes and parentheses. */
function splitOperands(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      cur += c;
      if (c === '\\') {
        cur += text[i + 1] ?? '';
        i++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      cur += c;
    } else if (c === '(') {
      depth++;
      cur += c;
    } else if (c === ')') {
      depth--;
      cur += c;
    } else if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur.trim());
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

interface ParsedLine {
  line: number;
  labels: string[];
  op: string | null;
  operands: string[];
  raw: string;
}

class AsmFault extends Error {}

function parseLines(source: string): ParsedLine[] {
  const result: ParsedLine[] = [];
  const lines = source.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const rawLine = lines[n];
    let text = stripComment(rawLine).trim();
    const labels: string[] = [];
    // Pull leading `label:` tokens.
    let m: RegExpMatchArray | null;
    while ((m = text.match(/^([A-Za-z_.$][\w.$]*)\s*:\s*/))) {
      labels.push(m[1]);
      text = text.slice(m[0].length);
    }
    let op: string | null = null;
    let operands: string[] = [];
    if (text.length > 0) {
      const sp = text.search(/\s/);
      if (sp === -1) {
        op = text;
      } else {
        op = text.slice(0, sp);
        operands = splitOperands(text.slice(sp + 1));
      }
    }
    if (labels.length || op) {
      result.push({ line: n + 1, labels, op, operands, raw: rawLine });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Operand parsing
// ---------------------------------------------------------------------------

function parseReg(tok: string): number {
  const i = regIndex(tok);
  if (i < 0) throw new AsmFault(`expected a register, got '${tok}'`);
  return i;
}

function parseFReg(tok: string): number {
  const i = fregIndex(tok);
  if (i < 0) throw new AsmFault(`expected a float register, got '${tok}'`);
  return i;
}

/** Parse an atomic memory operand: `(rs1)` or bare `rs1`. Atomics have no offset. */
function parseAmoMem(tok: string): number {
  const m = tok.trim().match(/^\(?\s*([A-Za-z0-9]+)\s*\)?$/);
  if (!m) throw new AsmFault(`expected '(reg)', got '${tok}'`);
  return parseReg(m[1]);
}

/** Resolve a CSR operand (symbolic name like `cycle`, or a numeric address). */
function parseCsr(tok: string, consts: Map<string, number>): number {
  const t = tok.trim().toLowerCase();
  if (CSR_NUMBERS[t] !== undefined) return CSR_NUMBERS[t];
  return parseImmValue(tok, consts) & 0xfff;
}

/** Resolve an immediate token to a number, consulting `.equ` constants. */
function parseImmValue(tok: string, consts: Map<string, number>): number {
  const lit = parseIntLiteral(tok);
  if (lit !== null) return lit;
  const c = consts.get(tok.trim());
  if (c !== undefined) return c;
  throw new AsmFault(`expected a constant, got '${tok}'`);
}

/** An immediate that may be a constant or an (unresolved) symbol. */
function parseImmOrSym(tok: string, consts: Map<string, number>, reloc: Reloc): ImmSrc {
  const t = tok.trim();
  const hi = t.match(/^%hi\((.+)\)$/);
  if (hi) return { kind: 'sym', name: hi[1].trim(), reloc: 'hi' };
  const lo = t.match(/^%lo\((.+)\)$/);
  if (lo) return { kind: 'sym', name: lo[1].trim(), reloc: 'lo' };
  const lit = parseIntLiteral(t);
  if (lit !== null) return { kind: 'num', value: lit };
  const c = consts.get(t);
  if (c !== undefined) return { kind: 'num', value: c };
  if (/^[A-Za-z_.$][\w.$]*$/.test(t)) return { kind: 'sym', name: t, reloc };
  throw new AsmFault(`cannot parse operand '${tok}'`);
}

/** Parse a `offset(reg)` memory operand, returning [imm, reg]. */
function parseMem(tok: string, consts: Map<string, number>): { imm: ImmSrc; reg: number } {
  const m = tok.match(/^(.*?)\(\s*([A-Za-z0-9]+)\s*\)\s*$/);
  if (!m) throw new AsmFault(`expected 'offset(reg)', got '${tok}'`);
  const offTok = m[1].trim();
  const imm: ImmSrc = offTok === '' ? { kind: 'num', value: 0 } : parseImmOrSym(offTok, consts, 'lo');
  return { imm, reg: parseReg(m[2]) };
}

// ---------------------------------------------------------------------------
// Pseudo-instruction expansion
// ---------------------------------------------------------------------------

function micro(
  mnemonic: string,
  parts: { rd?: number; rs1?: number; rs2?: number; imm?: ImmSrc },
  line: number,
  source: string,
): MicroInstr {
  return {
    mnemonic,
    rd: parts.rd ?? 0,
    rs1: parts.rs1 ?? 0,
    rs2: parts.rs2 ?? 0,
    imm: parts.imm ?? { kind: 'num', value: 0 },
    line,
    source,
  };
}

const NEED = (op: string, ops: string[], n: number) => {
  if (ops.length !== n) throw new AsmFault(`${op} expects ${n} operand(s), got ${ops.length}`);
};

/** Expand one parsed instruction into one or more real micro-instructions. */
function expand(
  op: string,
  ops: string[],
  consts: Map<string, number>,
  line: number,
  source: string,
): MicroInstr[] {
  const M = (mn: string, parts: Parameters<typeof micro>[1]) => micro(mn, parts, line, source);

  // RV32C compressed instructions (`c.*`) encode to 16-bit half-words.
  if (C_MNEMONICS.has(op)) return [expandCompressed(op, ops, consts, line, source)];

  switch (op) {
    // ---- pseudo-instructions --------------------------------------------
    case 'nop':
      NEED(op, ops, 0);
      return [M('addi', {})];
    case 'li': {
      NEED(op, ops, 2);
      const rd = parseReg(ops[0]);
      const v = parseImmValue(ops[1], consts) | 0;
      if (v >= -2048 && v <= 2047) return [M('addi', { rd, imm: { kind: 'num', value: v } })];
      const lo = signExtend(v & 0xfff, 12);
      const hi = ((v - lo) >> 12) & 0xfffff;
      const out = [M('lui', { rd, imm: { kind: 'num', value: hi } })];
      if (lo !== 0) out.push(M('addi', { rd, rs1: rd, imm: { kind: 'num', value: lo } }));
      return out;
    }
    case 'la': {
      NEED(op, ops, 2);
      const rd = parseReg(ops[0]);
      const name = ops[1].trim();
      return [
        M('lui', { rd, imm: { kind: 'sym', name, reloc: 'hi' } }),
        M('addi', { rd, rs1: rd, imm: { kind: 'sym', name, reloc: 'lo' } }),
      ];
    }
    case 'call': {
      NEED(op, ops, 1);
      const name = ops[0].trim();
      return [
        M('lui', { rd: 1, imm: { kind: 'sym', name, reloc: 'hi' } }),
        M('jalr', { rd: 1, rs1: 1, imm: { kind: 'sym', name, reloc: 'lo' } }),
      ];
    }
    case 'mv':
      NEED(op, ops, 2);
      return [M('addi', { rd: parseReg(ops[0]), rs1: parseReg(ops[1]) })];
    case 'not':
      NEED(op, ops, 2);
      return [M('xori', { rd: parseReg(ops[0]), rs1: parseReg(ops[1]), imm: { kind: 'num', value: -1 } })];
    case 'neg':
      NEED(op, ops, 2);
      return [M('sub', { rd: parseReg(ops[0]), rs1: 0, rs2: parseReg(ops[1]) })];
    case 'seqz':
      NEED(op, ops, 2);
      return [M('sltiu', { rd: parseReg(ops[0]), rs1: parseReg(ops[1]), imm: { kind: 'num', value: 1 } })];
    case 'snez':
      NEED(op, ops, 2);
      return [M('sltu', { rd: parseReg(ops[0]), rs1: 0, rs2: parseReg(ops[1]) })];
    case 'sltz':
      NEED(op, ops, 2);
      return [M('slt', { rd: parseReg(ops[0]), rs1: parseReg(ops[1]), rs2: 0 })];
    case 'sgtz':
      NEED(op, ops, 2);
      return [M('slt', { rd: parseReg(ops[0]), rs1: 0, rs2: parseReg(ops[1]) })];
    case 'j':
      NEED(op, ops, 1);
      return [M('jal', { rd: 0, imm: { kind: 'sym', name: ops[0].trim(), reloc: 'rel' } })];
    case 'jr':
      NEED(op, ops, 1);
      return [M('jalr', { rd: 0, rs1: parseReg(ops[0]) })];
    case 'ret':
      NEED(op, ops, 0);
      return [M('jalr', { rd: 0, rs1: 1 })];
    case 'beqz':
      NEED(op, ops, 2);
      return [M('beq', { rs1: parseReg(ops[0]), rs2: 0, imm: relSym(ops[1]) })];
    case 'bnez':
      NEED(op, ops, 2);
      return [M('bne', { rs1: parseReg(ops[0]), rs2: 0, imm: relSym(ops[1]) })];
    case 'blez':
      NEED(op, ops, 2);
      return [M('bge', { rs1: 0, rs2: parseReg(ops[0]), imm: relSym(ops[1]) })];
    case 'bgez':
      NEED(op, ops, 2);
      return [M('bge', { rs1: parseReg(ops[0]), rs2: 0, imm: relSym(ops[1]) })];
    case 'bltz':
      NEED(op, ops, 2);
      return [M('blt', { rs1: parseReg(ops[0]), rs2: 0, imm: relSym(ops[1]) })];
    case 'bgtz':
      NEED(op, ops, 2);
      return [M('blt', { rs1: 0, rs2: parseReg(ops[0]), imm: relSym(ops[1]) })];
    case 'bgt':
      NEED(op, ops, 3);
      return [M('blt', { rs1: parseReg(ops[1]), rs2: parseReg(ops[0]), imm: relSym(ops[2]) })];
    case 'ble':
      NEED(op, ops, 3);
      return [M('bge', { rs1: parseReg(ops[1]), rs2: parseReg(ops[0]), imm: relSym(ops[2]) })];
    case 'bgtu':
      NEED(op, ops, 3);
      return [M('bltu', { rs1: parseReg(ops[1]), rs2: parseReg(ops[0]), imm: relSym(ops[2]) })];
    case 'bleu':
      NEED(op, ops, 3);
      return [M('bgeu', { rs1: parseReg(ops[1]), rs2: parseReg(ops[0]), imm: relSym(ops[2]) })];

    // ---- RV32F sign-injection pseudos -----------------------------------
    case 'fmv.s':
      NEED(op, ops, 2);
      return [fpMicro('fsgnj.s', { rd: parseFReg(ops[0]), rs1: parseFReg(ops[1]), rs2: parseFReg(ops[1]) }, line, source)];
    case 'fneg.s':
      NEED(op, ops, 2);
      return [fpMicro('fsgnjn.s', { rd: parseFReg(ops[0]), rs1: parseFReg(ops[1]), rs2: parseFReg(ops[1]) }, line, source)];
    case 'fabs.s':
      NEED(op, ops, 2);
      return [fpMicro('fsgnjx.s', { rd: parseFReg(ops[0]), rs1: parseFReg(ops[1]), rs2: parseFReg(ops[1]) }, line, source)];
    case 'fmv.d':
      NEED(op, ops, 2);
      return [fpMicro('fsgnj.d', { rd: parseFReg(ops[0]), rs1: parseFReg(ops[1]), rs2: parseFReg(ops[1]) }, line, source)];
    case 'fneg.d':
      NEED(op, ops, 2);
      return [fpMicro('fsgnjn.d', { rd: parseFReg(ops[0]), rs1: parseFReg(ops[1]), rs2: parseFReg(ops[1]) }, line, source)];
    case 'fabs.d':
      NEED(op, ops, 2);
      return [fpMicro('fsgnjx.d', { rd: parseFReg(ops[0]), rs1: parseFReg(ops[1]), rs2: parseFReg(ops[1]) }, line, source)];

    // ---- Zicsr counter / convenience pseudos ----------------------------
    case 'rdcycle':
      NEED(op, ops, 1);
      return [csrMicro('csrrs', { rd: parseReg(ops[0]), rs1: 0, csr: CSR_NUMBERS.cycle }, line, source)];
    case 'rdtime':
      NEED(op, ops, 1);
      return [csrMicro('csrrs', { rd: parseReg(ops[0]), rs1: 0, csr: CSR_NUMBERS.time }, line, source)];
    case 'rdinstret':
      NEED(op, ops, 1);
      return [csrMicro('csrrs', { rd: parseReg(ops[0]), rs1: 0, csr: CSR_NUMBERS.instret }, line, source)];
    case 'rdcycleh':
      NEED(op, ops, 1);
      return [csrMicro('csrrs', { rd: parseReg(ops[0]), rs1: 0, csr: CSR_NUMBERS.cycleh }, line, source)];
    case 'rdtimeh':
      NEED(op, ops, 1);
      return [csrMicro('csrrs', { rd: parseReg(ops[0]), rs1: 0, csr: CSR_NUMBERS.timeh }, line, source)];
    case 'rdinstreth':
      NEED(op, ops, 1);
      return [csrMicro('csrrs', { rd: parseReg(ops[0]), rs1: 0, csr: CSR_NUMBERS.instreth }, line, source)];
    case 'csrr':
      NEED(op, ops, 2);
      return [csrMicro('csrrs', { rd: parseReg(ops[0]), rs1: 0, csr: parseCsr(ops[1], consts) }, line, source)];
    case 'csrw':
      NEED(op, ops, 2);
      return [csrMicro('csrrw', { rd: 0, rs1: parseReg(ops[1]), csr: parseCsr(ops[0], consts) }, line, source)];
    case 'csrs':
      NEED(op, ops, 2);
      return [csrMicro('csrrs', { rd: 0, rs1: parseReg(ops[1]), csr: parseCsr(ops[0], consts) }, line, source)];
    case 'csrc':
      NEED(op, ops, 2);
      return [csrMicro('csrrc', { rd: 0, rs1: parseReg(ops[1]), csr: parseCsr(ops[0], consts) }, line, source)];
    case 'csrwi':
      NEED(op, ops, 2);
      return [csrMicro('csrrwi', { rd: 0, rs1: parseImmValue(ops[1], consts) & 0x1f, csr: parseCsr(ops[0], consts) }, line, source)];
    case 'csrsi':
      NEED(op, ops, 2);
      return [csrMicro('csrrsi', { rd: 0, rs1: parseImmValue(ops[1], consts) & 0x1f, csr: parseCsr(ops[0], consts) }, line, source)];
    case 'csrci':
      NEED(op, ops, 2);
      return [csrMicro('csrrci', { rd: 0, rs1: parseImmValue(ops[1], consts) & 0x1f, csr: parseCsr(ops[0], consts) }, line, source)];
    case 'frcsr':
      NEED(op, ops, 1);
      return [csrMicro('csrrs', { rd: parseReg(ops[0]), rs1: 0, csr: CSR_NUMBERS.fcsr }, line, source)];
    case 'frrm':
      NEED(op, ops, 1);
      return [csrMicro('csrrs', { rd: parseReg(ops[0]), rs1: 0, csr: CSR_NUMBERS.frm }, line, source)];
    case 'frflags':
      NEED(op, ops, 1);
      return [csrMicro('csrrs', { rd: parseReg(ops[0]), rs1: 0, csr: CSR_NUMBERS.fflags }, line, source)];
    case 'fscsr':
      return [csrSwapPseudo(ops, CSR_NUMBERS.fcsr, line, source)];
    case 'fsrm':
      return [csrSwapPseudo(ops, CSR_NUMBERS.frm, line, source)];
    case 'fsflags':
      return [csrSwapPseudo(ops, CSR_NUMBERS.fflags, line, source)];

    // ---- real instructions (base, FP, atomic, CSR) ----------------------
    default:
      return expandOther(op, ops, consts, line, source);
  }

  function relSym(tok: string): ImmSrc {
    return { kind: 'sym', name: tok.trim(), reloc: 'rel' };
  }
}

/** Build an FP/atomic/CSR micro-instruction (carries the extra fields). */
function fpMicro(
  mnemonic: string,
  parts: { rd?: number; rs1?: number; rs2?: number; rs3?: number; rm?: number; imm?: ImmSrc },
  line: number,
  source: string,
): MicroInstr {
  return {
    mnemonic,
    rd: parts.rd ?? 0,
    rs1: parts.rs1 ?? 0,
    rs2: parts.rs2 ?? 0,
    rs3: parts.rs3,
    rm: parts.rm,
    imm: parts.imm ?? { kind: 'num', value: 0 },
    line,
    source,
  };
}

function amoMicro(
  mnemonic: string,
  parts: { rd?: number; rs1?: number; rs2?: number; amoFunct7: number },
  line: number,
  source: string,
): MicroInstr {
  return {
    mnemonic,
    rd: parts.rd ?? 0,
    rs1: parts.rs1 ?? 0,
    rs2: parts.rs2 ?? 0,
    amoFunct7: parts.amoFunct7,
    imm: { kind: 'num', value: 0 },
    line,
    source,
  };
}

function csrMicro(
  mnemonic: string,
  parts: { rd?: number; rs1?: number; csr: number },
  line: number,
  source: string,
): MicroInstr {
  return {
    mnemonic,
    rd: parts.rd ?? 0,
    rs1: parts.rs1 ?? 0,
    rs2: 0,
    csr: parts.csr,
    imm: { kind: 'num', value: 0 },
    line,
    source,
  };
}

/** `fscsr/fsrm/fsflags` come in `rd, rs` (read-and-write) or `rs` (write-only) forms. */
function csrSwapPseudo(ops: string[], csr: number, line: number, source: string): MicroInstr {
  if (ops.length === 2) {
    return csrMicro('csrrw', { rd: parseReg(ops[0]), rs1: parseReg(ops[1]), csr }, line, source);
  }
  if (ops.length === 1) {
    return csrMicro('csrrw', { rd: 0, rs1: parseReg(ops[0]), csr }, line, source);
  }
  throw new AsmFault(`expected 1 or 2 operands, got ${ops.length}`);
}

/** Dispatch a non-pseudo mnemonic to the FP, atomic, CSR, or base encoder. */
function expandOther(
  op: string,
  ops: string[],
  consts: Map<string, number>,
  line: number,
  source: string,
): MicroInstr[] {
  if (FP_MNEMONICS.has(op)) return [expandFp(op, ops, consts, line, source)];
  if (CSR_MNEMONICS.has(op)) return [expandCsr(op, ops, consts, line, source)];
  const amoBase = stripAmoSuffix(op).base;
  if (AMO_MNEMONICS.has(amoBase)) return [expandAmo(op, ops, line, source)];
  return [expandReal(op, ops, consts, line, source)];
}

function stripAmoSuffix(op: string): { base: string; aq: number; rl: number } {
  if (op.endsWith('.aqrl')) return { base: op.slice(0, -5), aq: 1, rl: 1 };
  if (op.endsWith('.aq')) return { base: op.slice(0, -3), aq: 1, rl: 0 };
  if (op.endsWith('.rl')) return { base: op.slice(0, -3), aq: 0, rl: 1 };
  return { base: op, aq: 0, rl: 0 };
}

function expandAmo(op: string, ops: string[], line: number, source: string): MicroInstr {
  const { base, aq, rl } = stripAmoSuffix(op);
  const funct5 = AMO_FUNCT5[base];
  if (funct5 === undefined) throw new AsmFault(`unknown atomic '${op}'`);
  const amoFunct7 = (funct5 << 2) | (aq << 1) | rl;
  if (base === 'lr.w') {
    NEED(base, ops, 2); // lr.w rd, (rs1)
    return amoMicro(base, { rd: parseReg(ops[0]), rs1: parseAmoMem(ops[1]), amoFunct7 }, line, source);
  }
  // amo*.w / sc.w : rd, rs2, (rs1)
  NEED(base, ops, 3);
  return amoMicro(base, { rd: parseReg(ops[0]), rs2: parseReg(ops[1]), rs1: parseAmoMem(ops[2]), amoFunct7 }, line, source);
}

function expandCsr(op: string, ops: string[], consts: Map<string, number>, line: number, source: string): MicroInstr {
  NEED(op, ops, 3);
  const rd = parseReg(ops[0]);
  const csr = parseCsr(ops[1], consts);
  if (op.endsWith('i')) {
    return csrMicro(op, { rd, rs1: parseImmValue(ops[2], consts) & 0x1f, csr }, line, source);
  }
  return csrMicro(op, { rd, rs1: parseReg(ops[2]), csr }, line, source);
}

function expandFp(op: string, ops: string[], consts: Map<string, number>, line: number, source: string): MicroInstr {
  const spec = FP_SPECS[op];
  // Peel an optional trailing rounding-mode token for the ops that take one.
  let rm = 7; // dynamic by default
  const list = ops.slice();
  if (spec.hasRm && list.length > 0) {
    const maybe = rmFromName(list[list.length - 1]);
    if (maybe !== null) {
      rm = maybe;
      list.pop();
    }
  }
  const mk = (parts: Parameters<typeof fpMicro>[1]) => fpMicro(op, { ...parts, rm }, line, source);

  switch (spec.kind) {
    case 'load': {
      NEED(op, list, 2);
      const mem = parseMem(list[1], consts);
      return mk({ rd: parseFReg(list[0]), rs1: mem.reg, imm: mem.imm });
    }
    case 'store': {
      NEED(op, list, 2);
      const mem = parseMem(list[1], consts);
      return mk({ rs2: parseFReg(list[0]), rs1: mem.reg, imm: mem.imm });
    }
    case 'r-rm':
      NEED(op, list, 3);
      return mk({ rd: parseFReg(list[0]), rs1: parseFReg(list[1]), rs2: parseFReg(list[2]) });
    case 'sqrt':
      NEED(op, list, 2);
      return mk({ rd: parseFReg(list[0]), rs1: parseFReg(list[1]) });
    case 'sgnj':
    case 'minmax':
      NEED(op, list, 3);
      return mk({ rd: parseFReg(list[0]), rs1: parseFReg(list[1]), rs2: parseFReg(list[2]) });
    case 'cmp':
      NEED(op, list, 3);
      return mk({ rd: parseReg(list[0]), rs1: parseFReg(list[1]), rs2: parseFReg(list[2]) });
    case 'cvt.w':
      NEED(op, list, 2);
      return mk({ rd: parseReg(list[0]), rs1: parseFReg(list[1]) });
    case 'cvt.s':
      NEED(op, list, 2);
      return mk({ rd: parseFReg(list[0]), rs1: parseReg(list[1]) });
    case 'cvt.f2f':
      // fcvt.s.d / fcvt.d.s — float → float precision conversion.
      NEED(op, list, 2);
      return mk({ rd: parseFReg(list[0]), rs1: parseFReg(list[1]) });
    case 'mv.x':
    case 'fclass':
      NEED(op, list, 2);
      return mk({ rd: parseReg(list[0]), rs1: parseFReg(list[1]) });
    case 'mv.f':
      NEED(op, list, 2);
      return mk({ rd: parseFReg(list[0]), rs1: parseReg(list[1]) });
    case 'fma':
      NEED(op, list, 4);
      return mk({ rd: parseFReg(list[0]), rs1: parseFReg(list[1]), rs2: parseFReg(list[2]), rs3: parseFReg(list[3]) });
  }
}

function expandReal(
  op: string,
  ops: string[],
  consts: Map<string, number>,
  line: number,
  source: string,
): MicroInstr {
  const spec: InstrSpec | undefined = INSTRUCTIONS[op];
  if (!spec) throw new AsmFault(`unknown instruction '${op}'`);
  const M = (parts: Parameters<typeof micro>[1]) => micro(op, parts, line, source);

  switch (spec.format) {
    case 'R':
      NEED(op, ops, 3);
      return M({ rd: parseReg(ops[0]), rs1: parseReg(ops[1]), rs2: parseReg(ops[2]) });
    case 'SHIFT':
      NEED(op, ops, 3);
      return M({ rd: parseReg(ops[0]), rs1: parseReg(ops[1]), imm: { kind: 'num', value: parseImmValue(ops[2], consts) } });
    case 'U':
      NEED(op, ops, 2);
      return M({ rd: parseReg(ops[0]), imm: parseImmOrSym(ops[1], consts, 'abs') });
    case 'J': {
      // jal rd, label  OR  jal label (rd defaults to ra).
      if (ops.length === 1) return M({ rd: 1, imm: { kind: 'sym', name: ops[0].trim(), reloc: 'rel' } });
      NEED(op, ops, 2);
      return M({ rd: parseReg(ops[0]), imm: { kind: 'sym', name: ops[1].trim(), reloc: 'rel' } });
    }
    case 'B':
      NEED(op, ops, 3);
      return M({ rs1: parseReg(ops[0]), rs2: parseReg(ops[1]), imm: { kind: 'sym', name: ops[2].trim(), reloc: 'rel' } });
    case 'S': {
      NEED(op, ops, 2);
      const mem = parseMem(ops[1], consts);
      return M({ rs2: parseReg(ops[0]), rs1: mem.reg, imm: mem.imm });
    }
    case 'I': {
      if (spec.opcode === OPC.LOAD || spec.opcode === OPC.JALR) {
        // load/jalr have either `rd, off(rs1)` or (jalr) `rd, rs1, imm`.
        if (op === 'jalr' && ops.length === 3) {
          return M({ rd: parseReg(ops[0]), rs1: parseReg(ops[1]), imm: parseImmOrSym(ops[2], consts, 'lo') });
        }
        if (op === 'jalr' && ops.length === 1) {
          return M({ rd: 1, rs1: parseReg(ops[0]) });
        }
        NEED(op, ops, 2);
        const mem = parseMem(ops[1], consts);
        return M({ rd: parseReg(ops[0]), rs1: mem.reg, imm: mem.imm });
      }
      // OP-IMM arithmetic: rd, rs1, imm
      NEED(op, ops, 3);
      return M({ rd: parseReg(ops[0]), rs1: parseReg(ops[1]), imm: parseImmOrSym(ops[2], consts, 'lo') });
    }
    case 'SYS':
    case 'FENCE':
      NEED(op, ops, 0);
      return M({});
  }
}

// ---------------------------------------------------------------------------
// RV32C compressed instructions
// ---------------------------------------------------------------------------

function cmicro(
  mnemonic: string,
  parts: { rd?: number; rs1?: number; rs2?: number; imm?: ImmSrc },
  line: number,
  source: string,
): MicroInstr {
  return {
    mnemonic,
    rd: parts.rd ?? 0,
    rs1: parts.rs1 ?? 0,
    rs2: parts.rs2 ?? 0,
    imm: parts.imm ?? { kind: 'num', value: 0 },
    line,
    source,
    compressed: true,
  };
}

/** Parse one `c.*` mnemonic into a compressed micro-instruction (encoded later, once symbols resolve). */
function expandCompressed(
  op: string,
  ops: string[],
  consts: Map<string, number>,
  line: number,
  source: string,
): MicroInstr {
  const C = (parts: { rd?: number; rs1?: number; rs2?: number; imm?: ImmSrc }) =>
    cmicro(op, parts, line, source);
  const num = (tok: string): ImmSrc => ({ kind: 'num', value: parseImmValue(tok, consts) });
  const rel = (tok: string): ImmSrc => ({ kind: 'sym', name: tok.trim(), reloc: 'rel' });

  switch (op) {
    case 'c.nop':
    case 'c.ebreak':
      NEED(op, ops, 0);
      return C({});

    case 'c.addi':
    case 'c.li':
    case 'c.slli':
    case 'c.lui':
      NEED(op, ops, 2);
      return C({ rd: parseReg(ops[0]), imm: num(ops[1]) });

    case 'c.srli':
    case 'c.srai':
    case 'c.andi':
      NEED(op, ops, 2);
      return C({ rd: parseReg(ops[0]), imm: num(ops[1]) });

    case 'c.addi16sp':
      // `c.addi16sp imm` or `c.addi16sp sp, imm`.
      if (ops.length === 1) return C({ imm: num(ops[0]) });
      NEED(op, ops, 2);
      return C({ imm: num(ops[1]) });

    case 'c.addi4spn':
      // `c.addi4spn rd', imm` or `c.addi4spn rd', sp, imm`.
      if (ops.length === 2) return C({ rd: parseReg(ops[0]), imm: num(ops[1]) });
      NEED(op, ops, 3);
      return C({ rd: parseReg(ops[0]), imm: num(ops[2]) });

    case 'c.mv':
    case 'c.add':
      NEED(op, ops, 2);
      return C({ rd: parseReg(ops[0]), rs2: parseReg(ops[1]) });

    case 'c.sub':
    case 'c.xor':
    case 'c.or':
    case 'c.and':
      NEED(op, ops, 2);
      return C({ rd: parseReg(ops[0]), rs2: parseReg(ops[1]) });

    case 'c.jr':
    case 'c.jalr':
      NEED(op, ops, 1);
      return C({ rs1: parseReg(ops[0]) });

    case 'c.j':
    case 'c.jal':
      NEED(op, ops, 1);
      return C({ imm: rel(ops[0]) });

    case 'c.beqz':
    case 'c.bnez':
      NEED(op, ops, 2);
      return C({ rs1: parseReg(ops[0]), imm: rel(ops[1]) });

    case 'c.lw': {
      NEED(op, ops, 2);
      const mem = parseMem(ops[1], consts);
      return C({ rd: parseReg(ops[0]), rs1: mem.reg, imm: mem.imm });
    }
    case 'c.sw': {
      NEED(op, ops, 2);
      const mem = parseMem(ops[1], consts);
      return C({ rs2: parseReg(ops[0]), rs1: mem.reg, imm: mem.imm });
    }
    case 'c.lwsp': {
      NEED(op, ops, 2);
      const mem = parseMem(ops[1], consts);
      return C({ rd: parseReg(ops[0]), rs1: mem.reg, imm: mem.imm });
    }
    case 'c.swsp': {
      NEED(op, ops, 2);
      const mem = parseMem(ops[1], consts);
      return C({ rs2: parseReg(ops[0]), rs1: mem.reg, imm: mem.imm });
    }

    case 'c.flw':
    case 'c.fld':
    case 'c.flwsp':
    case 'c.fldsp': {
      NEED(op, ops, 2);
      const mem = parseMem(ops[1], consts);
      return C({ rd: parseFReg(ops[0]), rs1: mem.reg, imm: mem.imm });
    }
    case 'c.fsw':
    case 'c.fsd':
    case 'c.fswsp':
    case 'c.fsdsp': {
      NEED(op, ops, 2);
      const mem = parseMem(ops[1], consts);
      return C({ rs2: parseFReg(ops[0]), rs1: mem.reg, imm: mem.imm });
    }

    default:
      throw new AsmFault(`unknown compressed instruction '${op}'`);
  }
}

// ---------------------------------------------------------------------------
// Automatic RVC compression ("relaxation")
// ---------------------------------------------------------------------------
//
// When enabled (the `rvc` assemble option or a `.option rvc` directive), each freshly
// expanded *non-branch* instruction with a resolved numeric immediate is rewritten to its
// 16-bit RV32C form when one exists and its operands fit. Branches/jumps are left 32-bit, so
// no relaxation fixed-point is needed: the layout assigns final addresses with the chosen
// sizes, and branch offsets are still resolved from those final addresses at encode time.

const isRvcReg = (r: number): boolean => r >= 8 && r <= 15;

function compressedMicro(m: MicroInstr, mnemonic: string, value = 0): MicroInstr {
  return { ...m, mnemonic, compressed: true, imm: { kind: 'num', value } };
}

/** Return a compressed equivalent of `m`, or null if it cannot (safely) be compressed. */
function tryCompress(m: MicroInstr): MicroInstr | null {
  if (m.compressed || m.csr !== undefined || m.amoFunct7 !== undefined || FP_SPECS[m.mnemonic]) {
    return null;
  }
  const n = m.imm.kind === 'num' ? m.imm.value : null;
  const { rd, rs1, rs2 } = m;
  const mk = (mn: string, value = 0) => compressedMicro(m, mn, value);

  switch (m.mnemonic) {
    case 'addi':
      if (n === null) return null;
      if (rd === 2 && rs1 === 2 && n !== 0 && n >= -512 && n <= 496 && n % 16 === 0) return mk('c.addi16sp', n);
      if (isRvcReg(rd) && rs1 === 2 && n >= 4 && n <= 1020 && n % 4 === 0) return mk('c.addi4spn', n);
      if (rd !== 0 && rs1 === 0 && n >= -32 && n <= 31) return mk('c.li', n);
      if (rd !== 0 && rs1 === rd && n !== 0 && n >= -32 && n <= 31) return mk('c.addi', n);
      return null;
    case 'add':
      if (rd !== 0 && rs1 === rd && rs2 !== 0) return mk('c.add');
      if (rd !== 0 && rs1 === 0 && rs2 !== 0) return mk('c.mv');
      return null;
    case 'sub':
      return isRvcReg(rd) && rs1 === rd && isRvcReg(rs2) ? mk('c.sub') : null;
    case 'and':
      return isRvcReg(rd) && rs1 === rd && isRvcReg(rs2) ? mk('c.and') : null;
    case 'or':
      return isRvcReg(rd) && rs1 === rd && isRvcReg(rs2) ? mk('c.or') : null;
    case 'xor':
      return isRvcReg(rd) && rs1 === rd && isRvcReg(rs2) ? mk('c.xor') : null;
    case 'andi':
      return n !== null && isRvcReg(rd) && rs1 === rd && n >= -32 && n <= 31 ? mk('c.andi', n) : null;
    case 'slli':
      return n !== null && rd !== 0 && rs1 === rd && n >= 1 && n <= 31 ? mk('c.slli', n) : null;
    case 'srli':
      return n !== null && isRvcReg(rd) && rs1 === rd && n >= 1 && n <= 31 ? mk('c.srli', n) : null;
    case 'srai':
      return n !== null && isRvcReg(rd) && rs1 === rd && n >= 1 && n <= 31 ? mk('c.srai', n) : null;
    case 'lw':
      if (n === null) return null;
      if (rd !== 0 && rs1 === 2 && n >= 0 && n <= 252 && n % 4 === 0) return mk('c.lwsp', n);
      if (isRvcReg(rd) && isRvcReg(rs1) && n >= 0 && n <= 124 && n % 4 === 0) return mk('c.lw', n);
      return null;
    case 'sw':
      if (n === null) return null;
      if (rs1 === 2 && n >= 0 && n <= 252 && n % 4 === 0) return mk('c.swsp', n);
      if (isRvcReg(rs2) && isRvcReg(rs1) && n >= 0 && n <= 124 && n % 4 === 0) return mk('c.sw', n);
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Directives → data bytes
// ---------------------------------------------------------------------------

function parseStringLiteral(tok: string): number[] {
  const t = tok.trim();
  if (t.length < 2 || t[0] !== '"' || t[t.length - 1] !== '"') {
    throw new AsmFault(`expected a "string", got ${tok}`);
  }
  const body = t.slice(1, -1);
  const out: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') {
      out.push(charCode(body.slice(i, i + 2)));
      i++;
    } else {
      out.push(body.charCodeAt(i));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function resolveImm(src: ImmSrc, instrAddr: number, symbols: Map<string, number>): number {
  if (src.kind === 'num') return src.value;
  const base = symbols.get(src.name);
  if (base === undefined) throw new AsmFault(`undefined symbol '${src.name}'`);
  switch (src.reloc) {
    case 'abs':
      return base | 0;
    case 'hi':
      return ((base + 0x800) >>> 12) & 0xfffff;
    case 'lo':
      return signExtend(base & 0xfff, 12);
    case 'rel':
      return (base - instrAddr) | 0;
  }
}

function checkRange(v: number, lo: number, hi: number, what: string): number {
  if (v < lo || v > hi) throw new AsmFault(`${what} out of range: ${v} (allowed ${lo}..${hi})`);
  return v;
}

function encode(m: MicroInstr, addr: number, symbols: Map<string, number>): number {
  if (m.compressed) {
    const imm = resolveImm(m.imm, addr, symbols);
    return encodeC(m.mnemonic, {
      rd: m.rd & 0x1f,
      rs1: m.rs1 & 0x1f,
      rs2: m.rs2 & 0x1f,
      imm,
      frd: m.rd & 0x1f,
      frs2: m.rs2 & 0x1f,
    });
  }
  if (FP_SPECS[m.mnemonic]) return encodeFp(m, addr, symbols);
  if (m.amoFunct7 !== undefined) return encodeAmo(m);
  if (m.csr !== undefined) return encodeCsr(m);

  const spec = INSTRUCTIONS[m.mnemonic];
  const f3 = spec.funct3 ?? 0;
  const f7 = spec.funct7 ?? 0;
  const opc = spec.opcode;
  const rd = m.rd & 0x1f;
  const rs1 = m.rs1 & 0x1f;
  const rs2 = m.rs2 & 0x1f;

  switch (spec.format) {
    case 'R':
      return u32((f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | opc);
    case 'SHIFT': {
      const shamt = checkRange(resolveImm(m.imm, addr, symbols), 0, 31, 'shift amount');
      return u32((f7 << 25) | (shamt << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | opc);
    }
    case 'I': {
      const imm = checkRange(resolveImm(m.imm, addr, symbols), -2048, 2047, 'immediate');
      return u32(((imm & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | opc);
    }
    case 'S': {
      const imm = checkRange(resolveImm(m.imm, addr, symbols), -2048, 2047, 'store offset');
      const lo = imm & 0x1f;
      const hi = (imm >> 5) & 0x7f;
      return u32((hi << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (lo << 7) | opc);
    }
    case 'B': {
      const off = resolveImm(m.imm, addr, symbols);
      if (off & 1) throw new AsmFault(`branch target not 2-byte aligned (offset ${off})`);
      checkRange(off, -4096, 4094, 'branch offset');
      const b12 = (off >> 12) & 1;
      const b11 = (off >> 11) & 1;
      const b10_5 = (off >> 5) & 0x3f;
      const b4_1 = (off >> 1) & 0xf;
      return u32(
        (b12 << 31) | (b10_5 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (b4_1 << 8) | (b11 << 7) | opc,
      );
    }
    case 'U': {
      const v = resolveImm(m.imm, addr, symbols) & 0xfffff;
      return u32((v << 12) | (rd << 7) | opc);
    }
    case 'J': {
      const off = resolveImm(m.imm, addr, symbols);
      if (off & 1) throw new AsmFault(`jump target not 2-byte aligned (offset ${off})`);
      checkRange(off, -(1 << 20), (1 << 20) - 2, 'jump offset');
      const b20 = (off >> 20) & 1;
      const b19_12 = (off >> 12) & 0xff;
      const b11 = (off >> 11) & 1;
      const b10_1 = (off >> 1) & 0x3ff;
      return u32((b20 << 31) | (b10_1 << 21) | (b11 << 20) | (b19_12 << 12) | (rd << 7) | opc);
    }
    case 'SYS':
      return SYS_WORDS[m.mnemonic] ?? 0x0000_0073;
    case 'FENCE':
      return 0x0ff0_000f;
  }
}

// ---------------------------------------------------------------------------
// Extension encoders (RV32F / RV32A / Zicsr)
// ---------------------------------------------------------------------------

function encodeFp(m: MicroInstr, addr: number, symbols: Map<string, number>): number {
  const spec = FP_SPECS[m.mnemonic];
  const opc = spec.opcode;
  const rd = m.rd & 0x1f;
  const rs1 = m.rs1 & 0x1f;
  const rs2 = m.rs2 & 0x1f;
  const rm = (m.rm ?? 7) & 7;
  const f7 = spec.funct7 ?? 0;

  const f3 = spec.funct3 ?? 0;
  switch (spec.kind) {
    case 'load': {
      const imm = checkRange(resolveImm(m.imm, addr, symbols), -2048, 2047, 'load offset');
      return u32(((imm & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | opc);
    }
    case 'store': {
      const imm = checkRange(resolveImm(m.imm, addr, symbols), -2048, 2047, 'store offset');
      const lo = imm & 0x1f;
      const hi = (imm >> 5) & 0x7f;
      return u32((hi << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (lo << 7) | opc);
    }
    case 'r-rm':
      return u32((f7 << 25) | (rs2 << 20) | (rs1 << 15) | (rm << 12) | (rd << 7) | opc);
    case 'sqrt':
      return u32((f7 << 25) | (rs1 << 15) | (rm << 12) | (rd << 7) | opc);
    case 'sgnj':
    case 'minmax':
    case 'cmp':
      return u32((f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | opc);
    case 'cvt.w':
    case 'cvt.s':
    case 'cvt.f2f':
      return u32((f7 << 25) | ((spec.rs2 ?? 0) << 20) | (rs1 << 15) | (rm << 12) | (rd << 7) | opc);
    case 'mv.x':
    case 'fclass':
      return u32((f7 << 25) | (rs1 << 15) | (f3 << 12) | (rd << 7) | opc);
    case 'mv.f':
      return u32((f7 << 25) | (rs1 << 15) | (rd << 7) | opc);
    case 'fma':
      // The format (fmt) rides in bits 26:25; rs3 in bits 31:27. Double sets fmt = 01.
      return u32(
        ((m.rs3 ?? 0) & 0x1f) * 0x800_0000 +
          ((spec.dbl ? 1 : 0) << 25) +
          ((rs2 << 20) | (rs1 << 15) | (rm << 12) | (rd << 7) | opc),
      );
  }
}

function encodeAmo(m: MicroInstr): number {
  return u32(
    ((m.amoFunct7 ?? 0) << 25) |
      ((m.rs2 & 0x1f) << 20) |
      ((m.rs1 & 0x1f) << 15) |
      (2 << 12) |
      ((m.rd & 0x1f) << 7) |
      OPC.AMO,
  );
}

function encodeCsr(m: MicroInstr): number {
  const funct3 = CSR_FUNCT3[m.mnemonic];
  return u32(
    (((m.csr ?? 0) & 0xfff) << 20) |
      ((m.rs1 & 0x1f) << 15) |
      (funct3 << 12) |
      ((m.rd & 0x1f) << 7) |
      OPC.SYSTEM,
  );
}

// ---------------------------------------------------------------------------
// Top-level assemble
// ---------------------------------------------------------------------------

function align(value: number, boundary: number): number {
  const mask = boundary - 1;
  return (value + mask) & ~mask;
}

/** Pre-scan for `.equ NAME, value`, `.set NAME, value`, and `NAME = value`. */
function collectConstants(parsed: ParsedLine[], errors: AsmError[]): Map<string, number> {
  const consts = new Map<string, number>();
  for (const p of parsed) {
    try {
      if ((p.op === '.equ' || p.op === '.set') && p.operands.length === 2) {
        consts.set(p.operands[0].trim(), parseImmValue(p.operands[1], consts));
      } else if (p.op && !p.op.startsWith('.') && p.operands.length === 1 && p.operands[0].startsWith('=')) {
        // `NAME = value` parses as op='NAME', operands=['= value'].
        consts.set(p.op, parseImmValue(p.operands[0].slice(1), consts));
      }
    } catch (e) {
      errors.push({ line: p.line, message: (e as Error).message });
    }
  }
  return consts;
}

export interface AssembleOptions {
  /** Automatically emit RV32C 16-bit forms for eligible instructions ("relaxation"). */
  rvc?: boolean;
}

export function assemble(source: string, options: AssembleOptions = {}): AssembleResult {
  const errors: AsmError[] = [];
  const parsed = parseLines(source);
  const consts = collectConstants(parsed, errors);
  const symbols = new Map<string, number>();
  const slots: Slot[] = [];
  let rvc = options.rvc ?? false;

  let seg: 'text' | 'data' = 'text';
  let textLC = TEXT_BASE;
  let dataLC = DATA_BASE;
  const cur = () => (seg === 'text' ? textLC : dataLC);
  const advance = (n: number) => {
    if (seg === 'text') textLC += n;
    else dataLC += n;
  };
  const setCur = (v: number) => {
    if (seg === 'text') textLC = v;
    else dataLC = v;
  };

  const pushBytes = (bytes: ByteSrc[], size: number, line: number, source0: string) => {
    slots.push({ addr: cur(), size, line, source: source0, micro: null, bytes });
    advance(size);
  };

  // ---- layout pass --------------------------------------------------------
  for (const p of parsed) {
    for (const label of p.labels) {
      if (symbols.has(label)) errors.push({ line: p.line, message: `duplicate label '${label}'` });
      symbols.set(label, cur());
    }
    if (!p.op) continue;
    const op = p.op.toLowerCase();
    try {
      if (op === '.text') {
        seg = 'text';
      } else if (op === '.data' || op === '.rodata' || op === '.bss') {
        seg = 'data';
      } else if (op === '.globl' || op === '.global' || op === '.equ' || op === '.set') {
        // metadata / already handled
      } else if (op === '.option') {
        // `.option rvc` / `.option norvc` toggle automatic compression for following code.
        const a = (p.operands[0] ?? '').toLowerCase();
        if (a === 'rvc') rvc = true;
        else if (a === 'norvc') rvc = false;
      } else if (p.operands.length === 1 && p.operands[0].startsWith('=')) {
        // NAME = value, already collected
      } else if (op === '.align' || op === '.p2align') {
        const n = parseImmValue(p.operands[0] ?? '0', consts);
        setCur(align(cur(), 1 << n));
      } else if (op === '.balign') {
        const n = parseImmValue(p.operands[0] ?? '1', consts);
        setCur(align(cur(), n));
      } else if (op === '.space' || op === '.skip' || op === '.zero') {
        const n = parseImmValue(p.operands[0] ?? '0', consts);
        pushBytes([{ kind: 'lit', values: new Array<number>(n).fill(0) }], n, p.line, p.raw.trim());
      } else if (op === '.byte') {
        const vals = p.operands.map((o) => parseImmValue(o, consts) & 0xff);
        pushBytes([{ kind: 'lit', values: vals }], vals.length, p.line, p.raw.trim());
      } else if (op === '.half' || op === '.short' || op === '.2byte') {
        const vals: number[] = [];
        for (const o of p.operands) {
          const v = parseImmValue(o, consts);
          vals.push(v & 0xff, (v >> 8) & 0xff);
        }
        pushBytes([{ kind: 'lit', values: vals }], vals.length, p.line, p.raw.trim());
      } else if (op === '.word' || op === '.long' || op === '.4byte') {
        const srcs: ByteSrc[] = p.operands.map((o) => {
          const imm = parseImmOrSym(o, consts, 'abs');
          return { kind: 'word', imm } as ByteSrc;
        });
        pushBytes(srcs, srcs.length * 4, p.line, p.raw.trim());
      } else if (op === '.string' || op === '.asciz') {
        const bytes = parseStringLiteral(p.operands[0] ?? '""');
        bytes.push(0);
        pushBytes([{ kind: 'lit', values: bytes }], bytes.length, p.line, p.raw.trim());
      } else if (op === '.ascii') {
        const bytes = parseStringLiteral(p.operands[0] ?? '""');
        pushBytes([{ kind: 'lit', values: bytes }], bytes.length, p.line, p.raw.trim());
      } else if (op.startsWith('.')) {
        // Unknown directive — ignore quietly (e.g. .type, .size, .section).
      } else {
        // An instruction. RISC-V (with the C extension) only requires 2-byte alignment;
        // compressed micros take 2 bytes, everything else 4.
        if (seg !== 'text') throw new AsmFault(`instruction '${op}' outside .text segment`);
        setCur(align(cur(), 2));
        const micros = expand(op, p.operands, consts, p.line, p.raw.trim());
        for (const mi of micros) {
          const use = rvc ? tryCompress(mi) ?? mi : mi;
          const size = use.compressed ? 2 : 4;
          slots.push({ addr: textLC, size, line: p.line, source: p.raw.trim(), micro: use, bytes: null });
          textLC += size;
        }
      }
    } catch (e) {
      errors.push({ line: p.line, message: (e as Error).message });
    }
  }

  // ---- encode pass --------------------------------------------------------
  const writes: { addr: number; bytes: number[] }[] = [];
  const instrs: AsmInstr[] = [];
  const lineToAddr = new Map<number, number>();
  const addrToLine = new Map<number, number>();

  for (const slot of slots) {
    try {
      if (slot.micro) {
        const word = encode(slot.micro, slot.addr, symbols);
        const len = slot.micro.compressed ? 2 : 4;
        const bytes =
          len === 2
            ? [word & 0xff, (word >> 8) & 0xff]
            : [word & 0xff, (word >> 8) & 0xff, (word >> 16) & 0xff, (word >> 24) & 0xff];
        writes.push({ addr: slot.addr, bytes });
        instrs.push({ addr: slot.addr, word, line: slot.line, source: slot.source, len });
        if (!lineToAddr.has(slot.line)) lineToAddr.set(slot.line, slot.addr);
        addrToLine.set(slot.addr, slot.line);
      } else if (slot.bytes) {
        const bytes: number[] = [];
        for (const b of slot.bytes) {
          if (b.kind === 'lit') bytes.push(...b.values);
          else {
            const v = u32(resolveImm(b.imm, slot.addr, symbols));
            bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
          }
        }
        writes.push({ addr: slot.addr, bytes });
      }
    } catch (e) {
      errors.push({ line: slot.line, message: (e as Error).message });
    }
  }

  const entry = symbols.get('main') ?? symbols.get('_start') ?? TEXT_BASE;

  return {
    ok: errors.length === 0,
    errors: errors.sort((a, b) => a.line - b.line),
    writes,
    instrs: instrs.sort((a, b) => a.addr - b.addr),
    symbols,
    lineToAddr,
    addrToLine,
    entry,
    textRange: [TEXT_BASE, textLC],
    dataRange: [DATA_BASE, dataLC],
  };
}
