// A small lexer that classifies assembly tokens for the editor's syntax highlighting.
// It is purely cosmetic and forgiving — anything it doesn't recognise becomes plain text.

import { REAL_MNEMONICS, AMO_MNEMONICS, CSR_MNEMONICS } from '../vm/isa';
import { FP_MNEMONICS } from '../vm/fp';
import { RVC_MNEMONICS } from '../vm/rvc';
import { regIndex, fregIndex } from '../vm/registers';

export type TokenKind =
  | 'comment'
  | 'string'
  | 'char'
  | 'directive'
  | 'label'
  | 'mnemonic'
  | 'reg'
  | 'num'
  | 'punct'
  | 'text';

export interface Token {
  value: string;
  kind: TokenKind;
}

const PSEUDO = new Set([
  'li', 'la', 'mv', 'not', 'neg', 'nop', 'j', 'jr', 'ret', 'call', 'tail',
  'seqz', 'snez', 'sltz', 'sgtz',
  'beqz', 'bnez', 'blez', 'bgez', 'bltz', 'bgtz', 'bgt', 'ble', 'bgtu', 'bleu',
  // RV32F / Zicsr pseudos
  'fmv.s', 'fneg.s', 'fabs.s',
  'rdcycle', 'rdtime', 'rdinstret', 'rdcycleh', 'rdtimeh', 'rdinstreth',
  'csrr', 'csrw', 'csrs', 'csrc', 'csrwi', 'csrsi', 'csrci',
  'frcsr', 'fscsr', 'frrm', 'fsrm', 'frflags', 'fsflags',
]);

const MNEMONICS = new Set<string>([
  ...REAL_MNEMONICS,
  ...FP_MNEMONICS,
  ...AMO_MNEMONICS,
  ...CSR_MNEMONICS,
  ...RVC_MNEMONICS,
  ...PSEUDO,
  'mret', 'wfi', // privileged (added with machine-mode traps)
]);

// Atomics accept `.aq` / `.rl` ordering suffixes; recognise those too.
const AMO_SUFFIXED = new Set<string>(
  [...AMO_MNEMONICS].flatMap((m) => [`${m}.aq`, `${m}.rl`, `${m}.aqrl`]),
);

// A single regex whose alternatives are tried in priority order via the sticky flag.
const SCANNER = new RegExp(
  [
    '(?<comment>(?:#|//)[^\\n]*)',
    '(?<string>"(?:\\\\.|[^"\\\\])*")',
    "(?<char>'(?:\\\\.|[^'])')",
    '(?<label>[A-Za-z_.$][\\w.$]*:)',
    '(?<directive>\\.[A-Za-z0-9_]+)',
    '(?<num>-?(?:0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\\d+))',
    '(?<ident>[A-Za-z_.$][\\w.$]*)',
    '(?<ws>\\s+)',
    '(?<punct>[(),:])',
    '(?<other>.)',
  ].join('|'),
  'gy',
);

/** Tokenise one line of assembly into classified spans. */
export function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  SCANNER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SCANNER.exec(line))) {
    const g = m.groups!;
    if (g.comment !== undefined) tokens.push({ value: g.comment, kind: 'comment' });
    else if (g.string !== undefined) tokens.push({ value: g.string, kind: 'string' });
    else if (g.char !== undefined) tokens.push({ value: g.char, kind: 'char' });
    else if (g.label !== undefined) tokens.push({ value: g.label, kind: 'label' });
    else if (g.directive !== undefined) tokens.push({ value: g.directive, kind: 'directive' });
    else if (g.num !== undefined) tokens.push({ value: g.num, kind: 'num' });
    else if (g.ident !== undefined) tokens.push({ value: g.ident, kind: classifyIdent(g.ident) });
    else if (g.punct !== undefined) tokens.push({ value: g.punct, kind: 'punct' });
    else tokens.push({ value: m[0], kind: 'text' });
    if (SCANNER.lastIndex === m.index) SCANNER.lastIndex++; // never get stuck
  }
  return tokens;
}

function classifyIdent(id: string): TokenKind {
  if (regIndex(id) >= 0 || fregIndex(id) >= 0) return 'reg';
  const lower = id.toLowerCase();
  if (MNEMONICS.has(lower) || AMO_SUFFIXED.has(lower)) return 'mnemonic';
  return 'text';
}
