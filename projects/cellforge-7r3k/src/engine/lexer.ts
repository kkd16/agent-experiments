// A hand-written tokenizer for the formula grammar. The one subtlety worth calling
// out: a run of letters-then-digits like `LOG10` is ambiguous — it could be the
// function LOG10 or a reference to column "LOG", row 10. We disambiguate the way
// every spreadsheet does: if the run is immediately followed by `(`, it's a
// function name; otherwise, if it matches the A1 shape, it's a reference.

export type TokenType =
  | 'num'
  | 'str'
  | 'ref'
  | 'func'
  | 'name' // TRUE/FALSE, error literals, defined names, anything alphabetic that isn't a ref or call
  | 'tableref' // a structured table reference, e.g. Sales[Amount] — value carries the whole text
  | 'sheetname' // a quoted sheet name, e.g. 'Q3 Data' (always followed by `!`)
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'colon'
  | 'bang' // the `!` that separates a sheet qualifier from a reference
  | 'hash' // the `#` spill-range operator (postfix on a reference: `A1#`)
  | 'eof'

export interface Token {
  readonly type: TokenType
  readonly value: string
  readonly pos: number
}

export class LexError extends Error {}

const REF_SHAPE = /^\$?[A-Za-z]+\$?\d+$/
const OPS_2 = ['<>', '<=', '>=']

export function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = input.length

  const peekNonSpace = (from: number): string => {
    let k = from
    while (k < n && (input[k] === ' ' || input[k] === '\t')) k++
    return k < n ? input[k] : ''
  }

  while (i < n) {
    const ch = input[i]

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }

    // String literal: "..." with "" as an embedded quote.
    if (ch === '"') {
      let j = i + 1
      let str = ''
      while (j < n) {
        if (input[j] === '"') {
          if (input[j + 1] === '"') {
            str += '"'
            j += 2
            continue
          }
          break
        }
        str += input[j]
        j++
      }
      if (j >= n) throw new LexError('unterminated string literal')
      tokens.push({ type: 'str', value: str, pos: i })
      i = j + 1
      continue
    }

    // Quoted sheet name: 'My Sheet' with '' as an embedded apostrophe. Always a
    // sheet qualifier — the parser expects a `!` to follow.
    if (ch === "'") {
      let j = i + 1
      let str = ''
      while (j < n) {
        if (input[j] === "'") {
          if (input[j + 1] === "'") {
            str += "'"
            j += 2
            continue
          }
          break
        }
        str += input[j]
        j++
      }
      if (j >= n) throw new LexError('unterminated sheet name')
      tokens.push({ type: 'sheetname', value: str, pos: i })
      i = j + 1
      continue
    }

    // `#` is overloaded. Directly after a reference (`A1#`) it is the spill-range
    // operator — the whole dynamic array anchored at that cell. Otherwise it opens
    // an error literal: #DIV/0!, #VALUE!, etc.
    if (ch === '#') {
      const prev = tokens[tokens.length - 1]
      if (prev && prev.type === 'ref') {
        tokens.push({ type: 'hash', value: '#', pos: i })
        i++
        continue
      }
      const m = /^#[A-Za-z0-9/?]+!?/.exec(input.slice(i))
      if (m) {
        tokens.push({ type: 'name', value: m[0].toUpperCase(), pos: i })
        i += m[0].length
        continue
      }
    }

    // Number: 12, 3.14, .5, 1e3, 2.5E-2
    if ((ch >= '0' && ch <= '9') || (ch === '.' && input[i + 1] >= '0' && input[i + 1] <= '9')) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(input.slice(i))
      if (!m) throw new LexError(`bad number at ${i}`)
      tokens.push({ type: 'num', value: m[0], pos: i })
      i += m[0].length
      continue
    }

    // Identifier-ish run (letters, digits, $, _, .) — classified after reading.
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$.]*/.exec(input.slice(i))
      if (!m) throw new LexError(`unexpected character "${ch}" at ${i}`)
      const word = m[0]
      const next = peekNonSpace(i + word.length)
      // A structured table reference: `Name[…]` with the `[` immediately after the name.
      // Read the balanced bracket group (one level of nesting, so `Sales[[Net Amount]]`
      // and `Sales[@Region]` both lex) and carry the whole text on one token.
      if (input[i + word.length] === '[' && !REF_SHAPE.test(word)) {
        let j = i + word.length
        let depth = 0
        for (; j < n; j++) {
          if (input[j] === '[') depth++
          else if (input[j] === ']') {
            depth--
            if (depth === 0) {
              j++
              break
            }
          }
        }
        if (depth !== 0) throw new LexError('unbalanced [ ] in a table reference')
        tokens.push({ type: 'tableref', value: input.slice(i, j), pos: i })
        i = j
        continue
      }
      if (next === '(') {
        tokens.push({ type: 'func', value: word.toUpperCase(), pos: i })
      } else if (REF_SHAPE.test(word)) {
        tokens.push({ type: 'ref', value: word, pos: i })
      } else {
        tokens.push({ type: 'name', value: word, pos: i })
      }
      i += word.length
      continue
    }

    // Two-char operators first.
    const two = input.slice(i, i + 2)
    if (OPS_2.includes(two)) {
      tokens.push({ type: 'op', value: two, pos: i })
      i += 2
      continue
    }

    switch (ch) {
      case '(':
        tokens.push({ type: 'lparen', value: ch, pos: i })
        break
      case ')':
        tokens.push({ type: 'rparen', value: ch, pos: i })
        break
      case ',':
        tokens.push({ type: 'comma', value: ch, pos: i })
        break
      case ':':
        tokens.push({ type: 'colon', value: ch, pos: i })
        break
      case '!':
        tokens.push({ type: 'bang', value: ch, pos: i })
        break
      case '+':
      case '-':
      case '*':
      case '/':
      case '^':
      case '&':
      case '=':
      case '<':
      case '>':
      case '%':
        tokens.push({ type: 'op', value: ch, pos: i })
        break
      default:
        throw new LexError(`unexpected character "${ch}" at ${i}`)
    }
    i++
  }

  tokens.push({ type: 'eof', value: '', pos: n })
  return tokens
}
