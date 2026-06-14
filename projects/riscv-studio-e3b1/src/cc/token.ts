// Tokens produced by the C lexer. Each carries a precise source span so the parser and
// type checker can point diagnostics at the offending characters.

export type TokKind = 'ident' | 'keyword' | 'num' | 'char' | 'str' | 'punct' | 'eof';

export interface Tok {
  kind: TokKind;
  value: string; // raw text (identifier name, operator, keyword)
  num?: number; // numeric value for 'num' and 'char' tokens
  str?: string; // decoded bytes for 'str' tokens
  start: number; // byte offset into source
  end: number;
  line: number; // 1-based
  col: number; // 1-based
}

export const KEYWORDS = new Set([
  'int',
  'char',
  'void',
  'if',
  'else',
  'while',
  'for',
  'do',
  'return',
  'break',
  'continue',
  'sizeof',
  'struct',
  'const',
  'unsigned',
  'signed',
  'static',
  'va_list',
  'va_start',
  'va_arg',
  'va_end',
]);
