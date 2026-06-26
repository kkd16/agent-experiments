// Parse the studio's own assembly text into the optimizer IR (see ir.ts).
//
// We fully structure the `.text` section (labels, instructions, operands) so passes can analyse
// and rewrite it, and keep `.data` (and any line we do not recognise) verbatim. Instructions whose
// operands we cannot cleanly type are still kept — their original text is stored on `origText` and
// re-emitted untouched, and the semantics layer treats them as opaque barriers. The result: Forge
// can only ever transform code it fully understands.

import { regIndex, fregIndex } from '../vm/registers';
import type { Item, Instr, Module, Operand, Section } from './ir';

// Strip a `#` or `//` line comment, honouring double-quoted strings. Returns [code, comment].
function splitComment(line: string): [string, string | undefined] {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === '#' || (c === '/' && line[i + 1] === '/')) {
      return [line.slice(0, i), line.slice(i + (c === '#' ? 1 : 2)).trim()];
    }
  }
  return [line, undefined];
}

const SECTION_SWITCH: Record<string, Section | undefined> = {
  '.text': 'text',
  '.data': 'data',
  '.rodata': 'data',
  '.bss': 'data',
};

/** Parse an integer literal the assembler accepts: decimal, 0x-hex, char literal, negatives. */
export function parseIntLiteral(tok: string): number | null {
  const t = tok.trim();
  if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(t)) return parseInt(t, 16) | 0;
  if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10) | 0;
  const ch = /^'(\\?.)'$/.exec(t);
  if (ch) {
    const s = ch[1];
    if (s.length === 1) return s.charCodeAt(0);
    const esc: Record<string, number> = { '\\n': 10, '\\t': 9, '\\r': 13, '\\0': 0, "\\'": 39, '\\\\': 92 };
    if (s in esc) return esc[s];
  }
  return null;
}

// Parse one operand token into a typed Operand, or null if we can't (caller keeps it opaque).
function parseOperand(tok: string): Operand | null {
  const t = tok.trim();
  if (t === '') return null;

  // memory: off(reg)
  const mem = /^(.*)\(\s*([A-Za-z0-9]+)\s*\)$/.exec(t);
  if (mem) {
    const base = regIndex(mem[2]);
    if (base < 0) return null;
    const offTok = mem[1].trim();
    const off: Operand = offTok === '' ? { kind: 'imm', v: 0 } : parseScalar(offTok);
    if (off.kind === 'raw') return null; // unknown offset form → keep whole instr opaque
    return { kind: 'mem', base, off };
  }

  const reg = regIndex(t);
  if (reg >= 0) return { kind: 'reg', n: reg };
  const fr = fregIndex(t);
  if (fr >= 0) return { kind: 'freg', n: fr };

  const s = parseScalar(t);
  return s.kind === 'raw' ? null : s;
}

// Parse a scalar (immediate / symbol / %hi-%lo) — never a register or memory.
function parseScalar(t: string): Operand {
  const reloc = /^%(hi|lo)\(\s*([A-Za-z_.$][\w.$]*)\s*\)$/.exec(t);
  if (reloc) return { kind: 'sym', name: reloc[2], reloc: reloc[1] as 'hi' | 'lo' };
  const n = parseIntLiteral(t);
  if (n !== null) return { kind: 'imm', v: n };
  if (/^[A-Za-z_.$][\w.$]*$/.test(t)) return { kind: 'sym', name: t };
  return { kind: 'raw', text: t };
}

// Split an operand string on top-level commas (mem operands contain no commas).
function splitOperands(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

export function parseModule(text: string): Module {
  const items: Item[] = [];
  let section: Section = 'text';
  let pendingLabels: string[] = [];
  const lines = text.split('\n');

  const flushLabels = (line: number) => {
    for (const name of pendingLabels) items.push({ kind: 'label', name, line, section });
    pendingLabels = [];
  };

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const lineNo = li + 1;
    const [code, comment] = splitComment(raw);
    let rest = code.trim();
    if (rest === '') continue; // blank or comment-only

    // Peel leading `label:` tokens.
    let m: RegExpExecArray | null;
    while ((m = /^([A-Za-z_.$][\w.$]*)\s*:\s*/.exec(rest))) {
      if (section === 'text') pendingLabels.push(m[1]);
      else items.push({ kind: 'dir', text: `${m[1]}:`, line: lineNo, section });
      rest = rest.slice(m[0].length);
    }
    if (rest === '') continue; // line was only labels

    // Directive (or `NAME = value`)?
    const isDir = rest.startsWith('.') || /^[A-Za-z_.$][\w.$]*\s*=/.test(rest);
    if (isDir) {
      flushLabels(lineNo);
      const head = rest.split(/\s+/)[0].toLowerCase();
      const sw = SECTION_SWITCH[head];
      // `rest` is the directive after any leading labels were peeled (those were emitted already).
      items.push({ kind: 'dir', text: `        ${rest}`, line: lineNo, section, switchTo: sw });
      if (sw) section = sw;
      continue;
    }

    if (section !== 'text') {
      // Non-text line we don't restructure — keep verbatim (labels already peeled above).
      items.push({ kind: 'dir', text: `        ${rest}`, line: lineNo, section });
      continue;
    }

    // An instruction. mnemonic = first token, rest = operands.
    const sp = rest.search(/\s/);
    const op = (sp < 0 ? rest : rest.slice(0, sp)).toLowerCase();
    const opStr = sp < 0 ? '' : rest.slice(sp).trim();
    const toks = splitOperands(opStr);
    let known = true;
    const operands: Operand[] = [];
    for (const tk of toks) {
      const o = parseOperand(tk);
      if (o === null) {
        known = false;
        operands.push({ kind: 'raw', text: tk.trim() });
      } else operands.push(o);
    }
    const instr: Instr = {
      kind: 'instr',
      op,
      operands,
      labels: pendingLabels,
      comment,
      line: lineNo,
      section: 'text',
      // origText is what we re-emit for opaque (unknown) instructions, byte-stable.
      origText: rest,
      known,
    };
    pendingLabels = [];
    items.push(instr);
  }
  flushLabels(lines.length);
  return { items };
}
