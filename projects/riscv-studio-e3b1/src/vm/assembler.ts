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
} from './isa';
import type { InstrSpec } from './isa';
import { regIndex, fregIndex } from './registers';
import { FP_SPECS, FP_MNEMONICS, rmFromName } from './fp';
import { parseIntLiteral, signExtend, charCode, u32 } from './format';
import { RVC_MNEMONICS, encodeCompressed, isCompactReg } from './rvc';

/** Options controlling a single assembly run. */
export interface AssembleOptions {
  /** Automatically shrink eligible base instructions to their RV32C (compressed) forms. */
  compress?: boolean;
}

export interface AsmError {
  line: number;
  message: string;
}

export interface AsmInstr {
  addr: number;
  word: number;
  line: number;
  source: string;
  /** Encoded length in bytes: 2 for a compressed (RV32C) instruction, 4 otherwise. */
  size: number;
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
  /** When set, this micro is an RV32C (compressed) instruction encoded to 2 bytes. */
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
  if (RVC_MNEMONICS.has(op)) return [expandRvc(op, ops, consts, line, source)];
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

// ---------------------------------------------------------------------------
// RV32C (compressed) — explicit `c.*` mnemonics
// ---------------------------------------------------------------------------

function rvcMicro(
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
    compressed: true,
    line,
    source,
  };
}

/** Parse a `sp`/`x2` token, erroring if it is anything else. */
function parseSp(tok: string): number {
  const i = regIndex(tok);
  if (i !== 2) throw new AsmFault(`expected sp, got '${tok}'`);
  return 2;
}

/** Parse one explicit compressed instruction into a 2-byte micro. */
function expandRvc(op: string, ops: string[], consts: Map<string, number>, line: number, source: string): MicroInstr {
  const C = (parts: Parameters<typeof rvcMicro>[1]) => rvcMicro(op, parts, line, source);
  const relSym = (tok: string): ImmSrc => ({ kind: 'sym', name: tok.trim(), reloc: 'rel' });
  const num = (tok: string): ImmSrc => ({ kind: 'num', value: parseImmValue(tok, consts) });

  switch (op) {
    case 'c.nop':
    case 'c.ebreak':
    case 'c.unimp':
      NEED(op, ops, 0);
      return C({});

    // CI / register forms: `c.op rd, imm`  or  `c.op rd, rs2`
    case 'c.addi':
    case 'c.li':
    case 'c.lui':
    case 'c.andi':
    case 'c.slli':
    case 'c.srli':
    case 'c.srai':
      NEED(op, ops, 2);
      return C({ rd: parseReg(ops[0]), imm: num(ops[1]) });
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

    case 'c.addi16sp':
      NEED(op, ops, 2);
      parseSp(ops[0]);
      return C({ imm: num(ops[1]) });
    case 'c.addi4spn':
      NEED(op, ops, 3);
      parseSp(ops[1]);
      return C({ rd: parseReg(ops[0]), imm: num(ops[2]) });

    // Memory forms: `c.lw rd, off(rs1)` / `c.sw rs2, off(rs1)` / `*sp` variants
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
      parseSp(`x${mem.reg}`);
      return C({ rd: parseReg(ops[0]), imm: mem.imm });
    }
    case 'c.swsp': {
      NEED(op, ops, 2);
      const mem = parseMem(ops[1], consts);
      parseSp(`x${mem.reg}`);
      return C({ rs2: parseReg(ops[0]), imm: mem.imm });
    }

    // Control flow
    case 'c.j':
    case 'c.jal':
      NEED(op, ops, 1);
      return C({ imm: relSym(ops[0]) });
    case 'c.jr':
    case 'c.jalr':
      NEED(op, ops, 1);
      return C({ rs1: parseReg(ops[0]) });
    case 'c.beqz':
    case 'c.bnez':
      NEED(op, ops, 2);
      return C({ rs1: parseReg(ops[0]), imm: relSym(ops[1]) });
  }
  throw new AsmFault(`unknown compressed instruction '${op}'`);
}

// ---------------------------------------------------------------------------
// RV32C — automatic peephole compressor (the `.option rvc` / "Compress" path)
// ---------------------------------------------------------------------------

/**
 * If `m` (a fully-expanded base micro) has an equivalent 2-byte compressed form whose size is
 * independent of code layout, return that compressed micro; otherwise return null. Only
 * numeric-immediate, non-PC-relative forms are eligible, so enabling compression never needs
 * branch relaxation: every instruction's size is fixed before addresses are assigned.
 */
function tryCompress(m: MicroInstr): MicroInstr | null {
  if (m.compressed || m.csr !== undefined || m.amoFunct7 !== undefined || FP_SPECS[m.mnemonic]) return null;
  if (m.imm.kind !== 'num') return null; // symbol relocations are address-dependent
  const imm = m.imm.value | 0;
  const { rd, rs1, rs2 } = m;
  const C = (mnemonic: string, parts: { rd?: number; rs1?: number; rs2?: number; imm?: number }): MicroInstr => ({
    mnemonic,
    rd: parts.rd ?? 0,
    rs1: parts.rs1 ?? 0,
    rs2: parts.rs2 ?? 0,
    imm: { kind: 'num', value: parts.imm ?? 0 },
    compressed: true,
    line: m.line,
    source: m.source,
  });

  switch (m.mnemonic) {
    case 'addi':
      if (rs1 === 0 && rd !== 0 && imm >= -32 && imm <= 31) return C('c.li', { rd, imm });
      if (rd === rs1 && rd !== 0 && imm !== 0 && imm >= -32 && imm <= 31) return C('c.addi', { rd, imm });
      if (rd === rs1 && rd === 2 && imm !== 0 && imm >= -512 && imm <= 496 && (imm & 15) === 0)
        return C('c.addi16sp', { imm });
      if (rs1 === 2 && isCompactReg(rd) && imm > 0 && imm < 1024 && (imm & 3) === 0)
        return C('c.addi4spn', { rd, imm });
      if (imm === 0 && rd !== 0 && rs1 !== 0 && rd !== rs1) return C('c.mv', { rd, rs2: rs1 });
      return null;
    case 'add':
      if (rd === rs1 && rd !== 0 && rs2 !== 0) return C('c.add', { rd, rs2 });
      if (rs1 === 0 && rd !== 0 && rs2 !== 0) return C('c.mv', { rd, rs2 });
      return null;
    case 'sub':
      return rd === rs1 && isCompactReg(rd) && isCompactReg(rs2) ? C('c.sub', { rd, rs2 }) : null;
    case 'xor':
      return rd === rs1 && isCompactReg(rd) && isCompactReg(rs2) ? C('c.xor', { rd, rs2 }) : null;
    case 'or':
      return rd === rs1 && isCompactReg(rd) && isCompactReg(rs2) ? C('c.or', { rd, rs2 }) : null;
    case 'and':
      return rd === rs1 && isCompactReg(rd) && isCompactReg(rs2) ? C('c.and', { rd, rs2 }) : null;
    case 'andi':
      return rd === rs1 && isCompactReg(rd) && imm >= -32 && imm <= 31 ? C('c.andi', { rd, imm }) : null;
    case 'slli':
      return rd === rs1 && rd !== 0 && imm >= 1 && imm < 32 ? C('c.slli', { rd, imm }) : null;
    case 'srli':
      return rd === rs1 && isCompactReg(rd) && imm >= 1 && imm < 32 ? C('c.srli', { rd, imm }) : null;
    case 'srai':
      return rd === rs1 && isCompactReg(rd) && imm >= 1 && imm < 32 ? C('c.srai', { rd, imm }) : null;
    case 'lui':
      // The 20-bit field must sign-extend from bit 5 (i.e. be a 6-bit signed value) and ≠ 0.
      if (rd !== 0 && rd !== 2 && imm !== 0 && signExtend(imm & 0x3f, 6) === signExtend(imm & 0xfffff, 20))
        return C('c.lui', { rd, imm: signExtend(imm & 0x3f, 6) });
      return null;
    case 'lw':
      if (rs1 === 2 && rd !== 0 && imm >= 0 && imm < 256 && (imm & 3) === 0) return C('c.lwsp', { rd, imm });
      if (isCompactReg(rd) && isCompactReg(rs1) && imm >= 0 && imm < 128 && (imm & 3) === 0)
        return C('c.lw', { rd, rs1, imm });
      return null;
    case 'sw':
      if (rs1 === 2 && imm >= 0 && imm < 256 && (imm & 3) === 0) return C('c.swsp', { rs2, imm });
      if (isCompactReg(rs2) && isCompactReg(rs1) && imm >= 0 && imm < 128 && (imm & 3) === 0)
        return C('c.sw', { rs1, rs2, imm });
      return null;
    default:
      return null;
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

/** Encode a compressed micro to its 16-bit half-word, resolving its immediate/offset. */
function encodeCompressedMicro(m: MicroInstr, addr: number, symbols: Map<string, number>): number {
  const v = resolveImm(m.imm, addr, symbols);
  return encodeCompressed(
    m.mnemonic,
    { rd: m.rd, rs1: m.rs1, rs2: m.rs2, imm: v, off: v },
    (msg) => {
      throw new AsmFault(msg);
    },
  );
}

function encode(m: MicroInstr, addr: number, symbols: Map<string, number>): number {
  if (m.compressed) return encodeCompressedMicro(m, addr, symbols);
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
      return m.mnemonic === 'ebreak' ? 0x0010_0073 : 0x0000_0073;
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

  switch (spec.kind) {
    case 'load': {
      const imm = checkRange(resolveImm(m.imm, addr, symbols), -2048, 2047, 'load offset');
      return u32(((imm & 0xfff) << 20) | (rs1 << 15) | (2 << 12) | (rd << 7) | opc);
    }
    case 'store': {
      const imm = checkRange(resolveImm(m.imm, addr, symbols), -2048, 2047, 'store offset');
      const lo = imm & 0x1f;
      const hi = (imm >> 5) & 0x7f;
      return u32((hi << 25) | (rs2 << 20) | (rs1 << 15) | (2 << 12) | (lo << 7) | opc);
    }
    case 'r-rm':
      return u32((f7 << 25) | (rs2 << 20) | (rs1 << 15) | (rm << 12) | (rd << 7) | opc);
    case 'sqrt':
      return u32((f7 << 25) | (rs1 << 15) | (rm << 12) | (rd << 7) | opc);
    case 'sgnj':
    case 'minmax':
    case 'cmp':
      return u32((f7 << 25) | (rs2 << 20) | (rs1 << 15) | ((spec.funct3 ?? 0) << 12) | (rd << 7) | opc);
    case 'cvt.w':
    case 'cvt.s':
      return u32((f7 << 25) | ((spec.rs2 ?? 0) << 20) | (rs1 << 15) | (rm << 12) | (rd << 7) | opc);
    case 'mv.x':
    case 'fclass':
      return u32((f7 << 25) | (rs1 << 15) | ((spec.funct3 ?? 0) << 12) | (rd << 7) | opc);
    case 'mv.f':
      return u32((f7 << 25) | (rs1 << 15) | (rd << 7) | opc);
    case 'fma':
      return u32(((m.rs3 ?? 0) & 0x1f) * 0x800_0000 + ((rs2 << 20) | (rs1 << 15) | (rm << 12) | (rd << 7) | opc));
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

export function assemble(source: string, options: AssembleOptions = {}): AssembleResult {
  const errors: AsmError[] = [];
  const parsed = parseLines(source);
  const consts = collectConstants(parsed, errors);
  const symbols = new Map<string, number>();
  const slots: Slot[] = [];

  // Compression is on when the caller asks for it or the source opts in via `.option rvc`.
  let compress = options.compress ?? false;
  for (const p of parsed) {
    if (p.op?.toLowerCase() === '.option') {
      const arg = (p.operands[0] ?? '').trim().toLowerCase();
      if (arg === 'rvc' || arg === 'c') compress = true;
      else if (arg === 'norvc') compress = false;
    }
  }

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
        // An instruction. With the C extension, IALIGN is 16, so align to 2 bytes; pure
        // 32-bit programs (every prior item a multiple of 4) keep their natural alignment.
        if (seg !== 'text') throw new AsmFault(`instruction '${op}' outside .text segment`);
        setCur(align(cur(), 2));
        const micros = expand(op, p.operands, consts, p.line, p.raw.trim());
        for (let mi of micros) {
          if (compress) mi = tryCompress(mi) ?? mi;
          const sz = mi.compressed ? 2 : 4;
          slots.push({ addr: textLC, size: sz, line: p.line, source: p.raw.trim(), micro: mi, bytes: null });
          textLC += sz;
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
        const bytes =
          slot.size === 2
            ? [word & 0xff, (word >> 8) & 0xff]
            : [word & 0xff, (word >> 8) & 0xff, (word >> 16) & 0xff, (word >> 24) & 0xff];
        writes.push({ addr: slot.addr, bytes });
        instrs.push({ addr: slot.addr, word, line: slot.line, source: slot.source, size: slot.size });
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
