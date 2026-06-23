// Reference rewriting for fill / paste. When a formula is copied to another cell,
// its *relative* references shift by the offset while *absolute* ($) ones stay put
// — exactly the rule offsetRef encodes. Rather than round-trip through the AST
// (which would lose the user's original spacing and formatting), we re-lex the
// formula and surgically replace only the reference tokens, copying everything
// else — strings, operators, whitespace — verbatim from the source.

import { tokenize } from './lexer'
import { parseRef, formatRef, offsetRef } from './address'

export function offsetFormula(raw: string, dRow: number, dCol: number): string {
  if (!raw.startsWith('=')) return raw
  if (dRow === 0 && dCol === 0) return raw
  const body = raw.slice(1)

  let tokens
  try {
    tokens = tokenize(body)
  } catch {
    return raw // unparseable text is left exactly as the user typed it
  }

  let out = '='
  let cursor = 0
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.type === 'eof') break
    const end = tokens[i + 1].pos // next token's start (eof.pos = body.length)

    if (tok.type === 'ref') {
      const ref = parseRef(tok.value)
      out += body.slice(cursor, tok.pos)
      out += ref ? formatRef(offsetRef(ref, dRow, dCol)) : tok.value
      out += body.slice(tok.pos + tok.value.length, end)
    } else {
      out += body.slice(cursor, end)
    }
    cursor = end
  }
  out += body.slice(cursor)
  return out
}
