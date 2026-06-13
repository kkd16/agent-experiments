// Drive syntax highlighting from the *engine's own* tokenizer, so the editor
// colours exactly the dialect the parser accepts.

import { tokenize, type TokenKind } from '../db/lexer'

export interface Segment {
  text: string
  cls: string
}

const KIND_CLASS: Record<TokenKind, string> = {
  keyword: 'tk-keyword',
  ident: 'tk-ident',
  number: 'tk-number',
  string: 'tk-string',
  operator: 'tk-operator',
  punct: 'tk-punct',
  comment: 'tk-comment',
  eof: '',
}

export function highlight(src: string): Segment[] {
  let tokens
  try {
    tokens = tokenize(src, { includeComments: true })
  } catch {
    // Mid-edit the source may be invalid (e.g. an open string) — show it plain.
    return [{ text: src, cls: '' }]
  }
  const segments: Segment[] = []
  let pos = 0
  for (const tok of tokens) {
    if (tok.kind === 'eof') break
    if (tok.start > pos) segments.push({ text: src.slice(pos, tok.start), cls: '' })
    segments.push({ text: src.slice(tok.start, tok.end), cls: KIND_CLASS[tok.kind] })
    pos = tok.end
  }
  if (pos < src.length) segments.push({ text: src.slice(pos), cls: '' })
  return segments
}
