import type { Span } from './diagnostics';

// The full token vocabulary of the Strata language. Punctuation tokens use their
// literal spelling as the type tag, which keeps the parser readable.
export type TokenType =
  | 'int_lit'
  | 'float_lit'
  | 'str_lit'
  | 'ident'
  // keywords
  | 'fn'
  | 'let'
  | 'if'
  | 'else'
  | 'while'
  | 'do'
  | 'for'
  | 'switch'
  | 'case'
  | 'default'
  | 'return'
  | 'break'
  | 'continue'
  | 'true'
  | 'false'
  // punctuation & operators
  | '('
  | ')'
  | '{'
  | '}'
  | '['
  | ']'
  | ','
  | ';'
  | ':'
  | '->'
  | '='
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '&&'
  | '||'
  | '!'
  | '&'
  | '|'
  | '^'
  | '<<'
  | '>>'
  | '~'
  | '?'
  | 'eof';

export interface Token {
  type: TokenType;
  /** Raw source text of the token (the spelling). */
  text: string;
  /** Numeric value for `int_lit` / `float_lit`, otherwise 0. */
  value: number;
  /** Decoded contents for `str_lit` (escapes resolved), otherwise undefined. */
  str?: string;
  span: Span;
}

export const KEYWORDS: Record<string, TokenType> = {
  fn: 'fn',
  let: 'let',
  if: 'if',
  else: 'else',
  while: 'while',
  do: 'do',
  for: 'for',
  switch: 'switch',
  case: 'case',
  default: 'default',
  return: 'return',
  break: 'break',
  continue: 'continue',
  true: 'true',
  false: 'false',
};
