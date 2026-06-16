// First-class full-text search for QueryForge — Postgres `tsvector`/`tsquery`.
//
// Two tagged, *plain* values — `{ t: 'tsvector', … }` and `{ t: 'tsquery', … }` —
// in the mould of the temporal / decimal / json values: their shapes are
// `JSON.stringify`/`parse`-round-trippable, so a search document persists to
// localStorage with zero special-casing and — once threaded through the six
// central value functions in `types.ts` — indexes, sorts, GROUP BYs, DISTINCTs,
// joins and renders for free.
//
// On top of the values sits the linguistic + search machinery, all from scratch
// and fully deterministic: a Porter (1980) stemmer, an English stop-word list, a
// text→lexeme normalizer, an operator-precedence `tsquery` parser, a positional
// match executor with true phrase (`<->`) semantics, ts_rank / ts_rank_cd
// relevance ranking and ts_headline highlighting.

import { SqlError } from './types'

// --- weights ----------------------------------------------------------------

/** A lexeme-position weight label. Postgres orders them A > B > C > D. */
export type Weight = 'A' | 'B' | 'C' | 'D'
const WEIGHT_ORDER: Record<Weight, number> = { A: 3, B: 2, C: 1, D: 0 }
/** Default ts_rank weights, indexed D,C,B,A (Postgres' {0.1,0.2,0.4,1.0}). */
const DEFAULT_RANK_WEIGHTS: [number, number, number, number] = [0.1, 0.2, 0.4, 1.0]

// --- tsvector ---------------------------------------------------------------

/** A single lexeme entry: the stemmed word plus its sorted positions and the
 *  parallel weight label of each position. A stripped vector has empty arrays. */
export interface TsLexeme {
  readonly word: string
  readonly pos: number[]
  readonly wt: Weight[]
}

/** A first-class SQL `tsvector` value: lexemes sorted, de-duplicated. */
export interface TsVector {
  readonly t: 'tsvector'
  readonly lex: TsLexeme[]
}

export function isTsVector(v: unknown): v is TsVector {
  return typeof v === 'object' && v !== null && (v as { t?: unknown }).t === 'tsvector'
}

// --- tsquery ----------------------------------------------------------------

export type TsQueryNode =
  | { op: 'val'; word: string; prefix: boolean; weights: Weight[] | null }
  | { op: '!'; a: TsQueryNode }
  | { op: '&'; a: TsQueryNode; b: TsQueryNode }
  | { op: '|'; a: TsQueryNode; b: TsQueryNode }
  | { op: '<->'; dist: number; a: TsQueryNode; b: TsQueryNode }

/** A first-class SQL `tsquery` value. `node === null` is the empty query. */
export interface TsQuery {
  readonly t: 'tsquery'
  readonly node: TsQueryNode | null
}

export function isTsQuery(v: unknown): v is TsQuery {
  return typeof v === 'object' && v !== null && (v as { t?: unknown }).t === 'tsquery'
}

// ============================================================================
// Porter (1980) stemmer — a faithful from-scratch implementation.
// ============================================================================

function isVowel(s: string, i: number): boolean {
  const c = s[i]
  if (c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u') return true
  // 'y' is a vowel only when preceded by a consonant.
  if (c === 'y') return i === 0 ? false : !isVowel(s, i - 1)
  return false
}

/** The "measure" m of a word: the number of VC sequences in [V]C…(VC)^m[V]. */
function measure(s: string): number {
  let m = 0
  let i = 0
  const n = s.length
  // skip leading consonants
  while (i < n && !isVowel(s, i)) i++
  while (i < n) {
    while (i < n && isVowel(s, i)) i++
    if (i >= n) break
    m++
    while (i < n && !isVowel(s, i)) i++
  }
  return m
}

function containsVowel(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (isVowel(s, i)) return true
  return false
}

/** True if the stem ends in a double consonant (e.g. -TT, -SS). */
function endsDoubleConsonant(s: string): boolean {
  const n = s.length
  if (n < 2) return false
  if (s[n - 1] !== s[n - 2]) return false
  return !isVowel(s, n - 1)
}

/** *o: the stem ends consonant-vowel-consonant where the final consonant is
 *  not W, X or Y (used to decide whether to restore an -E). */
function endsCVC(s: string): boolean {
  const n = s.length
  if (n < 3) return false
  if (isVowel(s, n - 1) || !isVowel(s, n - 2) || isVowel(s, n - 3)) return false
  const c = s[n - 1]
  return c !== 'w' && c !== 'x' && c !== 'y'
}

function endsWith(s: string, suf: string): boolean {
  return s.endsWith(suf)
}

/** Replace suffix `suf` with `rep` only when the resulting stem has m > minM. */
function replaceIf(s: string, suf: string, rep: string, minM: number): string | null {
  if (!endsWith(s, suf)) return null
  const stem = s.slice(0, s.length - suf.length)
  if (measure(stem) > minM) return stem + rep
  return s // matched but condition failed — stop trying further rules in this group
}

export function porterStem(wordRaw: string): string {
  let w = wordRaw
  if (w.length <= 2) return w

  // --- Step 1a ---
  if (endsWith(w, 'sses')) w = w.slice(0, -2)
  else if (endsWith(w, 'ies')) w = w.slice(0, -2)
  else if (endsWith(w, 'ss')) { /* keep */ }
  else if (endsWith(w, 's')) w = w.slice(0, -1)

  // --- Step 1b ---
  let step1bSecond = false
  if (endsWith(w, 'eed')) {
    const stem = w.slice(0, -3)
    if (measure(stem) > 0) w = stem + 'ee'
  } else if (endsWith(w, 'ed')) {
    const stem = w.slice(0, -2)
    if (containsVowel(stem)) { w = stem; step1bSecond = true }
  } else if (endsWith(w, 'ing')) {
    const stem = w.slice(0, -3)
    if (containsVowel(stem)) { w = stem; step1bSecond = true }
  }
  if (step1bSecond) {
    if (endsWith(w, 'at') || endsWith(w, 'bl') || endsWith(w, 'iz')) {
      w = w + 'e'
    } else if (endsDoubleConsonant(w)) {
      const c = w[w.length - 1]
      if (c !== 'l' && c !== 's' && c !== 'z') w = w.slice(0, -1)
    } else if (measure(w) === 1 && endsCVC(w)) {
      w = w + 'e'
    }
  }

  // --- Step 1c --- (Y → I when the stem has a vowel)
  if (endsWith(w, 'y')) {
    const stem = w.slice(0, -1)
    if (containsVowel(stem)) w = stem + 'i'
  }

  // --- Step 2 ---
  const step2: [string, string][] = [
    ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'],
    ['izer', 'ize'], ['bli', 'ble'], ['alli', 'al'], ['entli', 'ent'],
    ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'],
    ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'],
    ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'],
    ['logi', 'log'],
  ]
  for (const [suf, rep] of step2) {
    if (endsWith(w, suf)) { const r = replaceIf(w, suf, rep, 0); if (r !== null) w = r; break }
  }

  // --- Step 3 ---
  const step3: [string, string][] = [
    ['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['iciti', 'ic'],
    ['ical', 'ic'], ['ful', ''], ['ness', ''],
  ]
  for (const [suf, rep] of step3) {
    if (endsWith(w, suf)) { const r = replaceIf(w, suf, rep, 0); if (r !== null) w = r; break }
  }

  // --- Step 4 --- (remove suffix when m > 1)
  const step4 = [
    'al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment',
    'ent', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize',
  ]
  let did4 = false
  // 'ion' is special: only when preceded by s or t.
  if (endsWith(w, 'ion')) {
    const stem = w.slice(0, -3)
    if (measure(stem) > 1 && (stem.endsWith('s') || stem.endsWith('t'))) { w = stem; did4 = true }
  }
  if (!did4) {
    // longest suffix first
    const sorted = [...step4].sort((a, b) => b.length - a.length)
    for (const suf of sorted) {
      if (endsWith(w, suf)) {
        const stem = w.slice(0, w.length - suf.length)
        if (measure(stem) > 1) w = stem
        break
      }
    }
  }

  // --- Step 5a ---
  if (endsWith(w, 'e')) {
    const stem = w.slice(0, -1)
    const m = measure(stem)
    if (m > 1 || (m === 1 && !endsCVC(stem))) w = stem
  }
  // --- Step 5b ---
  if (measure(w) > 1 && endsDoubleConsonant(w) && w.endsWith('l')) {
    w = w.slice(0, -1)
  }

  return w
}

// ============================================================================
// Tokenization / normalization
// ============================================================================

/** A compact English stop-word list (Postgres' `english` config is similar). */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and',
  'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below',
  'between', 'both', 'but', 'by', 'can', 'cannot', 'could', 'did', 'do', 'does',
  'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had',
  'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him',
  'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself',
  'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'of', 'off', 'on',
  'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out',
  'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that',
  'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up',
  'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who',
  'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours', 'yourself',
  'yourselves',
])

const MAX_LEXEME_LEN = 80

/** A raw token of the source text: the matched word plus its 1-based ordinal. */
export interface RawToken {
  readonly text: string
  readonly start: number
  readonly end: number
  readonly position: number
}

/** Split text into word tokens (letters/digits, with internal apostrophes
 *  dropped) carrying 1-based positions counted over *all* word tokens — so a
 *  stop-word still advances the position counter, exactly like Postgres. */
export function rawTokens(text: string): RawToken[] {
  const out: RawToken[] = []
  const re = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu
  let m: RegExpExecArray | null
  let position = 0
  while ((m = re.exec(text)) !== null) {
    position++
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length, position })
  }
  return out
}

/** Normalize a raw word to a lexeme: lowercase, strip apostrophes, stem. Returns
 *  null for stop-words, over-long tokens or anything that normalizes to empty. */
export function normalizeWord(raw: string): string | null {
  const lower = raw.toLowerCase().replace(/['’]/g, '')
  if (lower.length === 0 || lower.length > MAX_LEXEME_LEN) return null
  if (STOP_WORDS.has(lower)) return null
  // Pure numbers are kept verbatim; words are stemmed.
  const stemmed = /^[0-9]+$/.test(lower) ? lower : porterStem(lower)
  return stemmed.length === 0 ? null : stemmed
}

// ============================================================================
// tsvector construction & algebra
// ============================================================================

/** Build a normalized tsvector from already-collected (word,position,weight)
 *  triples — sorts lexemes, merges duplicates, sorts/uniques positions. */
export function makeTsVector(entries: { word: string; position: number; weight?: Weight }[]): TsVector {
  const map = new Map<string, Map<number, Weight>>()
  for (const e of entries) {
    let m = map.get(e.word)
    if (!m) { m = new Map(); map.set(e.word, m) }
    if (e.position > 0) {
      const w = e.weight ?? 'D'
      const prev = m.get(e.position)
      // keep the strongest weight if a position repeats
      if (prev === undefined || WEIGHT_ORDER[w] > WEIGHT_ORDER[prev]) m.set(e.position, w)
    }
  }
  const lex: TsLexeme[] = []
  for (const word of [...map.keys()].sort(strcmp)) {
    const m = map.get(word)!
    const positions = [...m.keys()].sort((a, b) => a - b)
    lex.push({ word, pos: positions, wt: positions.map((p) => m.get(p)!) })
  }
  return { t: 'tsvector', lex }
}

function strcmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** `to_tsvector(text)` — tokenize, drop stop-words, stem, record positions. */
export function toTsVector(text: string): TsVector {
  const entries: { word: string; position: number }[] = []
  for (const tok of rawTokens(text)) {
    const word = normalizeWord(tok.text)
    if (word !== null) entries.push({ word, position: tok.position })
  }
  return makeTsVector(entries)
}

/** `setweight(vec, w)` — label every position of every lexeme with weight `w`. */
export function setWeight(v: TsVector, weight: Weight): TsVector {
  return { t: 'tsvector', lex: v.lex.map((l) => ({ word: l.word, pos: [...l.pos], wt: l.pos.map(() => weight) })) }
}

/** `strip(vec)` — drop all positions and weights. */
export function stripTsVector(v: TsVector): TsVector {
  return { t: 'tsvector', lex: v.lex.map((l) => ({ word: l.word, pos: [], wt: [] })) }
}

/** `a || b` — concatenate, shifting b's positions past a's max so phrases
 *  spanning the join still work (Postgres' tsvector concatenation rule). */
export function concatTsVector(a: TsVector, b: TsVector): TsVector {
  let maxPos = 0
  for (const l of a.lex) for (const p of l.pos) if (p > maxPos) maxPos = p
  const entries: { word: string; position: number; weight: Weight }[] = []
  for (const l of a.lex) {
    if (l.pos.length === 0) entries.push({ word: l.word, position: 0, weight: 'D' })
    for (let i = 0; i < l.pos.length; i++) entries.push({ word: l.word, position: l.pos[i], weight: l.wt[i] })
  }
  for (const l of b.lex) {
    if (l.pos.length === 0) entries.push({ word: l.word, position: 0, weight: 'D' })
    for (let i = 0; i < l.pos.length; i++) entries.push({ word: l.word, position: l.pos[i] + maxPos, weight: l.wt[i] })
  }
  return makeTsVector(entries)
}

/** Total length (number of distinct lexemes). */
export function tsVectorLength(v: TsVector): number {
  return v.lex.length
}

// ============================================================================
// tsquery: parser, algebra, canonical text
// ============================================================================

// A `tsquery` is parsed with operator precedence: | (lowest) < & < <-> < !.
// Tokens: lexeme[:weights][:*], '&', '|', '!', '<->' / '<N>', '(', ')'.

type QTok =
  | { k: 'val'; word: string; prefix: boolean; weights: Weight[] | null }
  | { k: '&' | '|' | '!' | '(' | ')' }
  | { k: 'phrase'; dist: number }

function lexTsQuery(src: string): QTok[] {
  const toks: QTok[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue }
    if (c === '&') { toks.push({ k: '&' }); i++; continue }
    if (c === '|') { toks.push({ k: '|' }); i++; continue }
    if (c === '!') { toks.push({ k: '!' }); i++; continue }
    if (c === '(') { toks.push({ k: '(' }); i++; continue }
    if (c === ')') { toks.push({ k: ')' }); i++; continue }
    if (c === '<') {
      // <-> (distance 1) or <N>
      const m = /^<(-|\d+)>/.exec(src.slice(i))
      if (!m) throw new SqlError(`tsquery: bad operator near "${src.slice(i, i + 4)}"`, 'fts')
      toks.push({ k: 'phrase', dist: m[1] === '-' ? 1 : parseInt(m[1], 10) })
      i += m[0].length
      continue
    }
    // a (possibly quoted) word, optionally followed by :weights and/or :*
    let word = ''
    if (c === "'") {
      i++
      while (i < n && src[i] !== "'") { word += src[i]; i++ }
      if (i >= n) throw new SqlError('tsquery: unterminated quoted lexeme', 'fts')
      i++ // closing quote
    } else {
      while (i < n && /[\p{L}\p{N}_'’]/u.test(src[i])) { word += src[i]; i++ }
      if (word === '') throw new SqlError(`tsquery: unexpected character "${c}"`, 'fts')
    }
    let prefix = false
    let weights: Weight[] | null = null
    if (src[i] === ':') {
      i++
      let wspec = ''
      while (i < n && /[ABCDabcd]/.test(src[i])) { wspec += src[i].toUpperCase(); i++ }
      if (src[i] === '*') { prefix = true; i++ }
      if (wspec) weights = [...new Set(wspec.split(''))] as Weight[]
    }
    toks.push({ k: 'val', word, prefix, weights })
  }
  return toks
}

class TsQueryParser {
  private toks: QTok[]
  private pos = 0
  constructor(toks: QTok[]) { this.toks = toks }
  private peek(): QTok | undefined { return this.toks[this.pos] }
  private next(): QTok | undefined { return this.toks[this.pos++] }

  parse(): TsQueryNode | null {
    if (this.toks.length === 0) return null
    const node = this.parseOr()
    if (this.pos < this.toks.length) throw new SqlError('tsquery: trailing tokens after expression', 'fts')
    return node
  }
  private parseOr(): TsQueryNode {
    let left = this.parseAnd()
    while (this.peek()?.k === '|') { this.next(); left = { op: '|', a: left, b: this.parseAnd() } }
    return left
  }
  private parseAnd(): TsQueryNode {
    let left = this.parsePhrase()
    while (this.peek()?.k === '&') { this.next(); left = { op: '&', a: left, b: this.parsePhrase() } }
    return left
  }
  private parsePhrase(): TsQueryNode {
    let left = this.parseNot()
    let t = this.peek()
    while (t && t.k === 'phrase') {
      this.next()
      left = { op: '<->', dist: t.dist, a: left, b: this.parseNot() }
      t = this.peek()
    }
    return left
  }
  private parseNot(): TsQueryNode {
    if (this.peek()?.k === '!') { this.next(); return { op: '!', a: this.parseNot() } }
    return this.parsePrimary()
  }
  private parsePrimary(): TsQueryNode {
    const t = this.next()
    if (!t) throw new SqlError('tsquery: unexpected end of input', 'fts')
    if (t.k === '(') {
      const inner = this.parseOr()
      const close = this.next()
      if (!close || close.k !== ')') throw new SqlError('tsquery: expected ")"', 'fts')
      return inner
    }
    if (t.k === 'val') {
      const word = normalizeWord(t.word)
      if (word === null) throw new SqlError(`tsquery: "${t.word}" is a stop word or empty`, 'fts')
      return { op: 'val', word, prefix: t.prefix, weights: t.weights }
    }
    throw new SqlError(`tsquery: unexpected operator`, 'fts')
  }
}

/** `to_tsquery(text)` — parse the full boolean+phrase operator syntax. */
export function toTsQuery(text: string): TsQuery {
  const node = new TsQueryParser(lexTsQuery(text)).parse()
  return { t: 'tsquery', node }
}

/** Build an AND/`<->`-chain of the normalized words of `text`. */
function chainWords(text: string, op: '&' | '<->'): TsQuery {
  const words: string[] = []
  for (const tok of rawTokens(text)) {
    const w = normalizeWord(tok.text)
    if (w !== null) words.push(w)
  }
  if (words.length === 0) return { t: 'tsquery', node: null }
  let node: TsQueryNode = { op: 'val', word: words[0], prefix: false, weights: null }
  for (let i = 1; i < words.length; i++) {
    const leaf: TsQueryNode = { op: 'val', word: words[i], prefix: false, weights: null }
    node = op === '&' ? { op: '&', a: node, b: leaf } : { op: '<->', dist: 1, a: node, b: leaf }
  }
  return { t: 'tsquery', node }
}

/** `plainto_tsquery(text)` — AND of the text's lexemes. */
export function plainToTsQuery(text: string): TsQuery {
  return chainWords(text, '&')
}

/** `phraseto_tsquery(text)` — a `<->` phrase of the text's lexemes. */
export function phraseToTsQuery(text: string): TsQuery {
  return chainWords(text, '<->')
}

/** `websearch_to_tsquery(text)` — Google-style: "quoted phrases", `or`,
 *  leading `-` negates, everything else ANDed. */
export function webSearchToTsQuery(text: string): TsQuery {
  // tokenize into operators and (possibly quoted, possibly negated) terms
  type Item = { kind: 'or' } | { kind: 'term'; node: TsQueryNode }
  const items: Item[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) {
      const phrase = phraseToTsQuery(m[1])
      if (phrase.node) items.push({ kind: 'term', node: phrase.node })
    } else {
      let tok = m[2]
      let negate = false
      while (tok.startsWith('-')) { negate = true; tok = tok.slice(1) }
      if (tok.toLowerCase() === 'or' && !negate) { items.push({ kind: 'or' }); continue }
      const w = normalizeWord(tok)
      if (w === null) continue
      let node: TsQueryNode = { op: 'val', word: w, prefix: false, weights: null }
      if (negate) node = { op: '!', a: node }
      items.push({ kind: 'term', node })
    }
  }
  // fold: AND terms, with `or` splitting into |-groups
  let result: TsQueryNode | null = null
  let group: TsQueryNode | null = null
  let pendingOr = false
  for (const it of items) {
    if (it.kind === 'or') { pendingOr = group !== null; continue }
    if (pendingOr) {
      result = result ? { op: '|', a: result, b: group! } : group
      group = it.node
      pendingOr = false
    } else {
      group = group ? { op: '&', a: group, b: it.node } : it.node
    }
  }
  if (group) result = result ? { op: '|', a: result, b: group } : group
  return { t: 'tsquery', node: result }
}

export function tsQueryAnd(a: TsQuery, b: TsQuery): TsQuery {
  if (!a.node) return b
  if (!b.node) return a
  return { t: 'tsquery', node: { op: '&', a: a.node, b: b.node } }
}
export function tsQueryOr(a: TsQuery, b: TsQuery): TsQuery {
  if (!a.node) return b
  if (!b.node) return a
  return { t: 'tsquery', node: { op: '|', a: a.node, b: b.node } }
}
export function tsQueryNot(a: TsQuery): TsQuery {
  if (!a.node) return a
  return { t: 'tsquery', node: { op: '!', a: a.node } }
}

/** `numnode(query)` — count nodes (operators + leaves). */
export function numNode(q: TsQuery): number {
  const walk = (n: TsQueryNode | null): number => {
    if (!n) return 0
    if (n.op === 'val') return 1
    if (n.op === '!') return 1 + walk(n.a)
    return 1 + walk(n.a) + walk(n.b)
  }
  return walk(q.node)
}

// ============================================================================
// Match: positional executor with true phrase (`<->`) semantics
// ============================================================================

/** Lexemes of `v` whose word matches `word` (exact, or prefix when `prefix`). */
function matchingLexemes(v: TsVector, word: string, prefix: boolean): TsLexeme[] {
  if (!prefix) {
    const l = lexemeFor(v, word)
    return l ? [l] : []
  }
  return v.lex.filter((l) => l.word.startsWith(word))
}

/** Binary-search a lexeme by exact word (lex is sorted). */
function lexemeFor(v: TsVector, word: string): TsLexeme | undefined {
  let lo = 0
  let hi = v.lex.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const c = strcmp(v.lex[mid].word, word)
    if (c === 0) return v.lex[mid]
    if (c < 0) lo = mid + 1
    else hi = mid - 1
  }
  return undefined
}

/** Does any of a lexeme's matched positions carry an allowed weight? */
function weightOk(l: TsLexeme, weights: Weight[] | null): boolean {
  if (!weights) return true
  if (l.pos.length === 0) return false // a stripped vector can't satisfy a weight filter
  return l.wt.some((w) => weights.includes(w))
}

/**
 * Execute a node against a vector. Returns whether it matches and, for
 * phrase composition, the set of end-positions at which it matched (null when
 * positions are unavailable / meaningless, e.g. under `!`, `&`, `|`).
 */
function execNode(node: TsQueryNode, v: TsVector): { match: boolean; positions: number[] | null } {
  switch (node.op) {
    case 'val': {
      const ls = matchingLexemes(v, node.word, node.prefix).filter((l) => weightOk(l, node.weights))
      if (ls.length === 0) return { match: false, positions: null }
      // union of positions across all matching lexemes (for prefix queries)
      const set = new Set<number>()
      for (const l of ls) for (const p of l.pos) set.add(p)
      const positions = [...set].sort((a, b) => a - b)
      return { match: true, positions: positions.length ? positions : null }
    }
    case '!': {
      const r = execNode(node.a, v)
      return { match: !r.match, positions: null }
    }
    case '&': {
      const a = execNode(node.a, v)
      if (!a.match) return { match: false, positions: null }
      const b = execNode(node.b, v)
      return { match: b.match, positions: null }
    }
    case '|': {
      const a = execNode(node.a, v)
      const b = execNode(node.b, v)
      return { match: a.match || b.match, positions: null }
    }
    case '<->': {
      const a = execNode(node.a, v)
      const b = execNode(node.b, v)
      if (!a.match || !b.match || !a.positions || !b.positions) return { match: false, positions: null }
      const bset = new Set(b.positions)
      const out: number[] = []
      for (const pa of a.positions) if (bset.has(pa + node.dist)) out.push(pa + node.dist)
      return { match: out.length > 0, positions: out.length ? out.sort((x, y) => x - y) : null }
    }
  }
}

/** `tsvector @@ tsquery`. */
export function tsMatch(v: TsVector, q: TsQuery): boolean {
  if (!q.node) return false
  return execNode(q.node, v).match
}

// ============================================================================
// Ranking
// ============================================================================

/** Collect the distinct leaf terms of a query (ignoring NOT branches, which
 *  don't contribute positive evidence to a rank). */
function queryLeaves(node: TsQueryNode | null): { word: string; prefix: boolean; weights: Weight[] | null }[] {
  const out: { word: string; prefix: boolean; weights: Weight[] | null }[] = []
  const walk = (n: TsQueryNode | null, negated: boolean) => {
    if (!n) return
    if (n.op === 'val') { if (!negated) out.push({ word: n.word, prefix: n.prefix, weights: n.weights }); return }
    if (n.op === '!') { walk(n.a, !negated); return }
    walk(n.a, negated); walk(n.b, negated)
  }
  walk(node, false)
  return out
}

/**
 * `ts_rank([weights,] vec, query [, normalization])`.
 *
 * Sums each matched query term's best position weight (using `weights` =
 * [D,C,B,A]), then applies the Postgres length-normalization bitmask:
 *   1 → / (1 + log(length))   2 → / length    4 → / mean-harmonic-distance
 *   8 → / unique words        16 → / (unique + 1)   32 → rank/(rank+1)
 */
export function tsRank(
  v: TsVector,
  q: TsQuery,
  weights: [number, number, number, number] = DEFAULT_RANK_WEIGHTS,
  normalization = 0,
): number {
  if (!q.node || !tsMatch(v, q)) return 0
  const wIndex: Record<Weight, number> = { D: 0, C: 1, B: 2, A: 3 }
  let score = 0
  for (const leaf of queryLeaves(q.node)) {
    const ls = matchingLexemes(v, leaf.word, leaf.prefix).filter((l) => weightOk(l, leaf.weights))
    if (ls.length === 0) continue
    let best = 0
    for (const l of ls) {
      if (l.pos.length === 0) best = Math.max(best, weights[0])
      for (const w of l.wt) best = Math.max(best, weights[wIndex[w]])
    }
    score += best
  }
  return applyNormalization(score, v, normalization)
}

/**
 * `ts_rank_cd([weights,] vec, query [, normalization])` — Clarke et al.
 * cover-density: shorter spans covering the query terms rank higher. We compute
 * the tightest window of distinct query-term positions and score by its density.
 */
export function tsRankCd(
  v: TsVector,
  q: TsQuery,
  weights: [number, number, number, number] = DEFAULT_RANK_WEIGHTS,
  normalization = 0,
): number {
  if (!q.node || !tsMatch(v, q)) return 0
  const wIndex: Record<Weight, number> = { D: 0, C: 1, B: 2, A: 3 }
  // gather (position, weight) of every matched query term occurrence
  const occ: { pos: number; w: number }[] = []
  let weightSum = 0
  for (const leaf of queryLeaves(q.node)) {
    const ls = matchingLexemes(v, leaf.word, leaf.prefix).filter((l) => weightOk(l, leaf.weights))
    let leafBest = 0
    for (const l of ls) {
      for (let i = 0; i < l.pos.length; i++) {
        const w = weights[wIndex[l.wt[i]]]
        occ.push({ pos: l.pos[i], w })
        leafBest = Math.max(leafBest, w)
      }
      if (l.pos.length === 0) leafBest = Math.max(leafBest, weights[0])
    }
    weightSum += leafBest
  }
  if (occ.length === 0) return applyNormalization(weightSum, v, normalization)
  occ.sort((a, b) => a.pos - b.pos)
  const span = occ[occ.length - 1].pos - occ[0].pos + 1
  // density: total term weight divided by the covering span length
  const density = weightSum / Math.max(1, span)
  return applyNormalization(density, v, normalization)
}

function applyNormalization(rank: number, v: TsVector, norm: number): number {
  if (rank === 0) return 0
  const length = v.lex.reduce((s, l) => s + Math.max(1, l.pos.length), 0)
  const unique = v.lex.length
  let r = rank
  if (norm & 1) r /= 1 + Math.log(Math.max(1, length))
  if (norm & 2) r /= Math.max(1, length)
  if (norm & 8) r /= Math.max(1, unique)
  if (norm & 16) r /= unique + 1
  if (norm & 32) r = r / (r + 1)
  return r
}

// ============================================================================
// Headline
// ============================================================================

/** `ts_headline(document, query)` — re-tokenize the *original* text and wrap
 *  the words whose lexeme is named by the query in <b>…</b>. */
export function tsHeadline(
  document: string,
  q: TsQuery,
  opts: { startSel?: string; stopSel?: string } = {},
): string {
  const start = opts.startSel ?? '<b>'
  const stop = opts.stopSel ?? '</b>'
  const leaves = queryLeaves(q.node)
  const exact = new Set<string>()
  const prefixes: string[] = []
  for (const l of leaves) {
    if (l.prefix) prefixes.push(l.word)
    else exact.add(l.word)
  }
  const toks = rawTokens(document)
  let out = ''
  let cursor = 0
  for (const tok of toks) {
    const word = normalizeWord(tok.text)
    const hit = word !== null && (exact.has(word) || prefixes.some((p) => word.startsWith(p)))
    out += document.slice(cursor, tok.start)
    if (hit) out += start + document.slice(tok.start, tok.end) + stop
    else out += document.slice(tok.start, tok.end)
    cursor = tok.end
  }
  out += document.slice(cursor)
  return out
}

// ============================================================================
// Canonical text forms + parsing (for CAST / display / round-trip)
// ============================================================================

function quoteLexeme(word: string): string {
  // Postgres single-quotes a lexeme, doubling any embedded quote.
  return `'${word.replace(/'/g, "''")}'`
}

/** Canonical tsvector text, e.g. `'cat':3 'fat':2A,4`. */
export function formatTsVector(v: TsVector): string {
  return v.lex
    .map((l) => {
      if (l.pos.length === 0) return quoteLexeme(l.word)
      const parts = l.pos.map((p, i) => (l.wt[i] === 'D' ? `${p}` : `${p}${l.wt[i]}`))
      return `${quoteLexeme(l.word)}:${parts.join(',')}`
    })
    .join(' ')
}

/** Canonical tsquery text, fully parenthesized only where precedence needs it. */
export function formatTsQuery(q: TsQuery): string {
  const prec: Record<string, number> = { '|': 1, '&': 2, '<->': 3, '!': 4, val: 5 }
  const walk = (n: TsQueryNode | null, parentPrec: number): string => {
    if (!n) return ''
    if (n.op === 'val') {
      let s = quoteLexeme(n.word)
      if (n.weights) s += ':' + n.weights.join('')
      if (n.prefix) s += (n.weights ? '' : ':') + '*'
      return s
    }
    let s: string
    if (n.op === '!') s = '!' + walk(n.a, prec['!'])
    else {
      const opTxt = n.op === '<->' ? (n.dist === 1 ? ' <-> ' : ` <${n.dist}> `) : n.op === '&' ? ' & ' : ' | '
      s = walk(n.a, prec[n.op]) + opTxt + walk(n.b, prec[n.op] + (n.op === '<->' ? 0 : 1))
    }
    return prec[n.op] < parentPrec ? `( ${s} )` : s
  }
  return walk(q.node, 0)
}

/** Parse a tsvector's canonical text back into a value (the `::tsvector` cast).
 *  Accepts `'word'` / `word` / `word:1,2A` entries separated by whitespace. */
export function parseTsVector(text: string): TsVector {
  const entries: { word: string; position: number; weight: Weight }[] = []
  let i = 0
  const n = text.length
  const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r'
  while (i < n) {
    while (i < n && isSpace(text[i])) i++
    if (i >= n) break
    // read the lexeme (quoted or bare)
    let word = ''
    if (text[i] === "'") {
      i++
      while (i < n) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") { word += "'"; i += 2; continue }
          i++; break
        }
        word += text[i]; i++
      }
    } else {
      while (i < n && !isSpace(text[i]) && text[i] !== ':') { word += text[i]; i++ }
    }
    if (word === '') throw new SqlError('tsvector: empty lexeme', 'fts')
    if (text[i] === ':') {
      i++
      // positions: comma-separated N[weight]
      let spec = ''
      while (i < n && !isSpace(text[i])) { spec += text[i]; i++ }
      for (const part of spec.split(',')) {
        const m = /^(\d+)([ABCDabcd]?)$/.exec(part)
        if (!m) throw new SqlError(`tsvector: bad position "${part}"`, 'fts')
        entries.push({ word, position: parseInt(m[1], 10), weight: (m[2] ? m[2].toUpperCase() : 'D') as Weight })
      }
    } else {
      entries.push({ word, position: 0, weight: 'D' })
    }
  }
  return makeTsVector(entries)
}

// --- equality / order / hash (for the central value functions) --------------

export function tsVectorEquals(a: TsVector, b: TsVector): boolean {
  return formatTsVector(a) === formatTsVector(b)
}
export function tsQueryEquals(a: TsQuery, b: TsQuery): boolean {
  return formatTsQuery(a) === formatTsQuery(b)
}
export function tsVectorOrder(a: TsVector, b: TsVector): number {
  return strcmp(formatTsVector(a), formatTsVector(b))
}
export function tsQueryOrder(a: TsQuery, b: TsQuery): number {
  return strcmp(formatTsQuery(a), formatTsQuery(b))
}
export function tsVectorHash(v: TsVector): string {
  return formatTsVector(v)
}
export function tsQueryHash(q: TsQuery): string {
  return formatTsQuery(q)
}

/** Coerce an arbitrary SqlValue to a tsvector (text is `to_tsvector`'d if it
 *  doesn't already look like a canonical vector; a vector passes through). */
export function asTsVector(v: unknown): TsVector | null {
  if (isTsVector(v)) return v
  if (typeof v === 'string') {
    // Canonical-looking text (has `:` positions or quoted lexemes) parses;
    // free text is processed through to_tsvector.
    try {
      if (/'/.test(v) || /:\d/.test(v)) return parseTsVector(v)
    } catch { /* fall through to to_tsvector */ }
    return toTsVector(v)
  }
  return null
}

// ============================================================================
// GIN inverted-index candidate generation
// ============================================================================

/** A read interface over a GIN inverted index, for candidate generation. */
export interface GinPostings {
  /** rowids whose document contains exactly this lexeme. */
  exact(word: string): Set<number> | undefined
  /** rowids whose document contains some lexeme with this prefix. */
  prefix(word: string): Set<number>
}

function setIntersect(a: Set<number>, b: Set<number>): Set<number> {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  const out = new Set<number>()
  for (const x of small) if (big.has(x)) out.add(x)
  return out
}
function setUnion(a: Set<number>, b: Set<number>): Set<number> {
  const out = new Set<number>(a)
  for (const x of b) out.add(x)
  return out
}

/**
 * A conservative set of candidate rowids for a tsquery against a GIN index, or
 * `null` when the query can't be bounded by the index (a bare NOT, or an OR
 * whose side is itself unboundable) and the caller must scan all rows instead.
 * The exact `@@` recheck happens downstream, so any over-approximation is safe.
 */
export function ginCandidates(node: TsQueryNode | null, g: GinPostings): Set<number> | null {
  if (!node) return new Set() // the empty query matches nothing
  switch (node.op) {
    case 'val':
      // A weight filter (`word:A`) is ignored here — postings don't track
      // weights, so we return every row containing the lexeme and let the
      // recheck enforce the weight.
      return node.prefix ? g.prefix(node.word) : (g.exact(node.word) ?? new Set<number>())
    case '&':
    case '<->': {
      // Both sides must be present; phrase adjacency is enforced by the recheck.
      const a = ginCandidates(node.a, g)
      const b = ginCandidates(node.b, g)
      if (a === null) return b
      if (b === null) return a
      return setIntersect(a, b)
    }
    case '|': {
      const a = ginCandidates(node.a, g)
      const b = ginCandidates(node.b, g)
      if (a === null || b === null) return null // can't bound the union
      return setUnion(a, b)
    }
    case '!':
      return null // negation can't be narrowed by the index
  }
}

/** Coerce an arbitrary SqlValue to a tsquery (text is parsed via to_tsquery). */
export function asTsQuery(v: unknown): TsQuery | null {
  if (isTsQuery(v)) return v
  if (typeof v === 'string') {
    try { return toTsQuery(v) } catch { return plainToTsQuery(v) }
  }
  return null
}
