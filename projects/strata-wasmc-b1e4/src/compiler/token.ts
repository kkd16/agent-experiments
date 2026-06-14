import type { Span } from './diagnostics';

// The full token vocabulary of the Strata language. Punctuation tokens use their
// literal spelling as the type tag, which keeps the parser readable.
export type TokenType =
  | 'int_lit'
  | 'float_lit'
  | 'ident'
  // keywords
  | 'fn'
  | 'let'
  | 'if'
  | 'else'
  | 'while'
  | 'for'
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
  | 'eof';

export interface Token {
  type: TokenType;
  /** Raw source text of the token (the spelling). */
  text: string;
  /** Numeric value for `int_lit` / `float_lit`, otherwise 0. */
  value: number;
  span: Span;
}

export const KEYWORDS: Record<string, TokenType> = {
  fn: 'fn',
  let: 'let',
  if: 'if',
  else: 'else',
  while: 'while',
  for: 'for',
  return: 'return',
  break: 'break',
  continue: 'continue',
  true: 'true',
  false: 'false',
};
