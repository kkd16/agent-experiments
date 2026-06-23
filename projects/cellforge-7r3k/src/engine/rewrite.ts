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

    // A `ref` token that is immediately followed by `!` is actually a sheet name
    // (e.g. `Sheet2` in `Sheet2!A1`), not a cell reference — leave it verbatim.
    const isSheetQualifier = tok.type === 'ref' && tokens[i + 1].type === 'bang'

    if (tok.type === 'ref' && !isSheetQualifier) {
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

/** Render a sheet name as a formula qualifier — bare when it's a simple identifier,
 *  single-quoted (with `''` escaping) otherwise. */
export function formatSheetQualifier(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^[A-Za-z]+\d+$/.test(name)) return name
  return "'" + name.replace(/'/g, "''") + "'"
}

/** Rewrite every sheet-qualifier in a formula that names `oldName` to `newName`,
 *  preserving everything else verbatim. Used when a sheet is renamed. */
export function renameSheetInFormula(raw: string, oldName: string, newName: string): string {
  if (!raw.startsWith('=')) return raw
  const body = raw.slice(1)
  let tokens
  try {
    tokens = tokenize(body)
  } catch {
    return raw
  }
  const oldLower = oldName.toLowerCase()
  const replacement = formatSheetQualifier(newName)

  let out = '='
  let cursor = 0
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.type === 'eof') break
    const end = tokens[i + 1].pos
    const isQualifier =
      (tok.type === 'sheetname' || tok.type === 'name' || tok.type === 'ref') && tokens[i + 1].type === 'bang'

    if (isQualifier && tok.value.toLowerCase() === oldLower) {
      // Emit text up to the qualifier, then the replacement; the qualifier's own
      // source (up to the `!`) is dropped, so any whitespace before `!` goes too.
      out += body.slice(cursor, tok.pos)
      out += replacement
    } else {
      out += body.slice(cursor, end)
    }
    cursor = end
  }
  out += body.slice(cursor)
  return out
}
