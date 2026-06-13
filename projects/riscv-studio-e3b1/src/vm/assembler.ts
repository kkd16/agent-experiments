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
import { INSTRUCTIONS, OPC } from './isa';
import type { InstrSpec } from './isa';
import { regIndex } from './registers';
import { parseIntLiteral, signExtend, charCode, u32 } from './format';

export interface AsmError {
  line: number;
  message: string;
}

export interface AsmInstr {
  addr: number;
  word: number;
  line: number;
  source: string;
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

    // ---- real instructions ----------------------------------------------
    default:
      return [expandReal(op, ops, consts, line, source)];
  }

  function relSym(tok: string): ImmSrc {
    return { kind: 'sym', name: tok.trim(), reloc: 'rel' };
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

function encode(m: MicroInstr, addr: number, symbols: Map<string, number>): number {
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

export function assemble(source: string): AssembleResult {
  const errors: AsmError[] = [];
  const parsed = parseLines(source);
  const consts = collectConstants(parsed, errors);
  const symbols = new Map<string, number>();
  const slots: Slot[] = [];

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
        // An instruction. Force 4-byte alignment, then expand.
        if (seg !== 'text') throw new AsmFault(`instruction '${op}' outside .text segment`);
        setCur(align(cur(), 4));
        const micros = expand(op, p.operands, consts, p.line, p.raw.trim());
        for (const mi of micros) {
          slots.push({ addr: textLC, size: 4, line: p.line, source: p.raw.trim(), micro: mi, bytes: null });
          textLC += 4;
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
        writes.push({ addr: slot.addr, bytes: [word & 0xff, (word >> 8) & 0xff, (word >> 16) & 0xff, (word >> 24) & 0xff] });
        instrs.push({ addr: slot.addr, word, line: slot.line, source: slot.source });
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
