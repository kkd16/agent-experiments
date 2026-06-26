// The optimizer's structured assembly IR.
//
// Forge optimizes the studio's *own* assembly text. To do that safely it needs a lossless,
// structured model: every line is one of a handful of item kinds, and instruction operands are
// parsed into a typed form so passes can rewrite them and the printer can re-emit assembler-legal
// text. Anything Forge does not recognise (an exotic directive, a vector/atomic instruction it
// does not model) is preserved verbatim and treated as an opaque barrier, so the optimizer is
// always conservative-correct: it can only ever make code it fully understands smaller.

import { regIndex, ABI_NAMES, FREG_ABI_NAMES } from '../vm/registers';

// ---- operands --------------------------------------------------------------

export type Operand =
  | { kind: 'reg'; n: number } // integer register, index 0..31
  | { kind: 'freg'; n: number } // float register f0..f31 (modelled opaquely)
  | { kind: 'imm'; v: number } // a resolved numeric immediate
  | { kind: 'sym'; name: string; reloc?: 'hi' | 'lo' } // a label / %hi()/%lo() symbol reference
  | { kind: 'mem'; base: number; off: Operand } // off(base): off is an imm or sym operand
  | { kind: 'raw'; text: string }; // anything else (csr name, rounding mode, vector mask, …)

export function reg(n: number): Operand {
  return { kind: 'reg', n };
}
export function imm(v: number): Operand {
  return { kind: 'imm', v };
}

export function isReg(o: Operand | undefined): o is { kind: 'reg'; n: number } {
  return !!o && o.kind === 'reg';
}
export function isImm(o: Operand | undefined): o is { kind: 'imm'; v: number } {
  return !!o && o.kind === 'imm';
}

/** Structural equality for two operands — used by value numbering and peepholes. */
export function operandsEqual(a: Operand, b: Operand): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'reg':
    case 'freg':
      return a.n === (b as { n: number }).n;
    case 'imm':
      return a.v === (b as { v: number }).v;
    case 'sym': {
      const s = b as { name: string; reloc?: string };
      return a.name === s.name && a.reloc === s.reloc;
    }
    case 'mem': {
      const m = b as { base: number; off: Operand };
      return a.base === m.base && operandsEqual(a.off, m.off);
    }
    case 'raw':
      return a.text === (b as { text: string }).text;
  }
}

// ---- line items ------------------------------------------------------------

export type Section = 'text' | 'data';

export interface Instr {
  kind: 'instr';
  /** Normalised lowercase mnemonic, e.g. `addi`, `lw`, `beqz`, `j`, `mv`, `call`, `ret`. */
  op: string;
  operands: Operand[];
  /** Labels defined immediately before this instruction (on its own or a previous line). */
  labels: string[];
  /** Trailing `# comment`, preserved for re-emission (purely cosmetic). */
  comment?: string;
  /** 1-based line in the source text this came from (for diagnostics / mapping). */
  line: number;
  section: Section;
  /**
   * Whether every operand was recognised. When false the instruction is opaque: passes never
   * rewrite it (the semantics layer treats it as a full barrier) and it re-emits via `origText`.
   */
  known: boolean;
  /** The original `mnemonic operands` text (no labels/comment), for byte-stable opaque re-emission. */
  origText: string;
  /**
   * Set by a pass when it changes this instruction's op/operands. Until then we re-emit `origText`
   * verbatim, so instructions we merely *read* (including opaque vector/atomic forms whose operand
   * syntax we don't reproduce, like a bare `(s1)`) round-trip byte-for-byte.
   */
  rewritten?: boolean;
}

/** A label that stands alone (no instruction follows on the same logical position). */
export interface LabelOnly {
  kind: 'label';
  name: string;
  line: number;
  section: Section;
}

/** A directive line (.text/.data/.word/.string/…) or any unparsed line — kept verbatim. */
export interface Directive {
  kind: 'dir';
  text: string; // the exact original line (trimmed of trailing whitespace)
  line: number;
  section: Section;
  /** Set when this directive switches sections, so the model tracks the current section. */
  switchTo?: Section;
}

export type Item = Instr | LabelOnly | Directive;

export interface Module {
  items: Item[];
}

// ---- printing --------------------------------------------------------------

function regName(n: number): string {
  return ABI_NAMES[n] ?? `x${n}`;
}
function fregName(n: number): string {
  return FREG_ABI_NAMES[n] ?? `f${n}`;
}

export function printOperand(o: Operand): string {
  switch (o.kind) {
    case 'reg':
      return regName(o.n);
    case 'freg':
      return fregName(o.n);
    case 'imm':
      return String(o.v);
    case 'sym':
      return o.reloc ? `%${o.reloc}(${o.name})` : o.name;
    case 'mem':
      return `${printOperand(o.off)}(${regName(o.base)})`;
    case 'raw':
      return o.text;
  }
}

export function printInstr(i: Instr): string {
  // Only re-render from operands once a pass has actually rewritten the instruction; otherwise the
  // original text is the ground truth (and reproduces operand syntax we don't model, e.g. `(s1)`).
  const body = i.rewritten ? buildBody(i) : i.origText;
  const line = `        ${body}`;
  return i.comment ? `${line}        # ${i.comment}` : line;
}

function buildBody(i: Instr): string {
  const ops = i.operands.map(printOperand).join(', ');
  return ops ? `${i.op} ${ops}` : i.op;
}

/** Re-emit the whole module as assembler-legal text. */
export function printModule(m: Module): string {
  const out: string[] = [];
  for (const it of m.items) {
    switch (it.kind) {
      case 'dir':
        out.push(it.text);
        break;
      case 'label':
        out.push(`${it.name}:`);
        break;
      case 'instr':
        for (const l of it.labels) out.push(`${l}:`);
        out.push(printInstr(it));
        break;
    }
  }
  return out.join('\n') + '\n';
}

/** Convenience: the flat list of instructions in the text section, in program order. */
export function textInstrs(m: Module): Instr[] {
  return m.items.filter((i): i is Instr => i.kind === 'instr' && i.section === 'text');
}

export { regIndex, regName };
