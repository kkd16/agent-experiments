// PCTL — Probabilistic Computation Tree Logic (Hansson & Jonsson, 1994). CTL with the path
// quantifiers ∀/∃ replaced by a probability operator: P⋈p[ψ] holds in a state when the probability of
// the paths satisfying ψ is ⋈ p. Over an MDP the operator splits into Pmax / Pmin (the best and worst
// scheduler). This file is the front end — a tokenizer, a precedence-climbing parser, and an evaluator
// that compiles each formula down to the DTMC/MDP probability engines and returns a satisfaction set
// (for a ⋈p query) or a probability vector (for a P=? / S=? query).

import type { Model, DTMC, MDP } from './types.ts'
import type { Frac } from './frac.ts'
import { F1, fcmp, fsub, ftoNumber, parseFrac } from './frac.ts'
import { propStates } from './types.ts'
import { nextExact, untilExact, boundedUntilExact, steadyStateExact } from './dtmc.ts'
import { optimalUntilFloat, optimalBoundedUntilFloat, optimalNextFloat } from './mdp.ts'
import type { Opt } from './mdp.ts'

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type Cmp = '<' | '<=' | '>' | '>=' | '=?'
export type ProbKind = 'p' | 'max' | 'min'

export type StateF =
  | { t: 'true' }
  | { t: 'false' }
  | { t: 'ap'; name: string }
  | { t: 'not'; f: StateF }
  | { t: 'and'; a: StateF; b: StateF }
  | { t: 'or'; a: StateF; b: StateF }
  | { t: 'prob'; kind: ProbKind; cmp: Cmp; bound: Frac | null; path: PathF }
  | { t: 'steady'; kind: ProbKind; cmp: Cmp; bound: Frac | null; inner: StateF }

export type PathF =
  | { t: 'next'; f: StateF }
  | { t: 'until'; a: StateF; b: StateF; bound: number | null }
  | { t: 'eventually'; f: StateF; bound: number | null }
  | { t: 'globally'; f: StateF; bound: number | null }

export class PctlError extends Error {}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Tok =
  | { k: 'id'; v: string }
  | { k: 'num'; v: string }
  | { k: 'op'; v: string }

const OPS = ['<=', '>=', '=?', '<', '>', '=', '!', '&', '|', '(', ')', '[', ']']

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    // two-char ops first
    let matched = false
    for (const op of OPS) {
      if (src.startsWith(op, i)) {
        toks.push({ k: 'op', v: op })
        i += op.length
        matched = true
        break
      }
    }
    if (matched) continue
    if (/[0-9]/.test(c)) {
      let j = i + 1
      while (j < src.length && /[0-9./]/.test(src[j])) j++
      toks.push({ k: 'num', v: src.slice(i, j) })
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++
      toks.push({ k: 'id', v: src.slice(i, j) })
      i = j
      continue
    }
    throw new PctlError(`unexpected character '${c}' at ${i}`)
  }
  return toks
}

// ---------------------------------------------------------------------------
// Parser (precedence: | < & < unary ! < atom)
// ---------------------------------------------------------------------------

class Parser {
  private p = 0
  private toks: Tok[]
  constructor(toks: Tok[]) {
    this.toks = toks
  }

  private peek(): Tok | null {
    return this.toks[this.p] ?? null
  }
  private next(): Tok {
    const t = this.toks[this.p]
    if (!t) throw new PctlError('unexpected end of formula')
    this.p++
    return t
  }
  private eatOp(v: string): void {
    const t = this.next()
    if (t.k !== 'op' || t.v !== v) throw new PctlError(`expected '${v}'`)
  }
  private isOp(v: string): boolean {
    const t = this.peek()
    return !!t && t.k === 'op' && t.v === v
  }

  parse(): StateF {
    const f = this.parseOr()
    if (this.p !== this.toks.length) throw new PctlError('trailing input after formula')
    return f
  }

  private parseOr(): StateF {
    let a = this.parseAnd()
    while (this.isOp('|')) {
      this.next()
      a = { t: 'or', a, b: this.parseAnd() }
    }
    return a
  }
  private parseAnd(): StateF {
    let a = this.parseUnary()
    while (this.isOp('&')) {
      this.next()
      a = { t: 'and', a, b: this.parseUnary() }
    }
    return a
  }
  private parseUnary(): StateF {
    if (this.isOp('!')) {
      this.next()
      return { t: 'not', f: this.parseUnary() }
    }
    return this.parseAtom()
  }

  private parseCmp(): { cmp: Cmp; bound: Frac | null } {
    const t = this.next()
    if (t.k !== 'op') throw new PctlError('expected a comparison after P/S')
    if (t.v === '=?') return { cmp: '=?', bound: null }
    if (t.v === '=') {
      // allow "= ?" spelled with a space
      if (this.isOp('=?')) this.next()
      throw new PctlError("use '=?' for a value query (e.g. P=? [ F goal ])")
    }
    if (t.v === '<' || t.v === '<=' || t.v === '>' || t.v === '>=') {
      const nt = this.next()
      if (nt.k !== 'num') throw new PctlError('expected a probability bound')
      const b = parseFrac(nt.v)
      if (!b) throw new PctlError(`bad probability bound '${nt.v}'`)
      return { cmp: t.v, bound: b }
    }
    throw new PctlError(`unexpected '${t.v}' after P/S`)
  }

  private parseAtom(): StateF {
    const t = this.peek()
    if (!t) throw new PctlError('unexpected end of formula')
    if (t.k === 'op' && t.v === '(') {
      this.next()
      const f = this.parseOr()
      this.eatOp(')')
      return f
    }
    if (t.k === 'id') {
      const name = t.v
      // Probability / steady operators
      if (name === 'P' || name === 'Pmax' || name === 'Pmin') {
        this.next()
        const kind: ProbKind = name === 'Pmax' ? 'max' : name === 'Pmin' ? 'min' : 'p'
        const { cmp, bound } = this.parseCmp()
        this.eatOp('[')
        const path = this.parsePath()
        this.eatOp(']')
        return { t: 'prob', kind, cmp, bound, path }
      }
      if (name === 'S' || name === 'Smax' || name === 'Smin') {
        this.next()
        const kind: ProbKind = name === 'Smax' ? 'max' : name === 'Smin' ? 'min' : 'p'
        const { cmp, bound } = this.parseCmp()
        this.eatOp('[')
        const inner = this.parseOr()
        this.eatOp(']')
        return { t: 'steady', kind, cmp, bound, inner }
      }
      if (name === 'true') {
        this.next()
        return { t: 'true' }
      }
      if (name === 'false') {
        this.next()
        return { t: 'false' }
      }
      // plain atomic proposition
      this.next()
      return { t: 'ap', name }
    }
    throw new PctlError(`unexpected token '${t.v}'`)
  }

  private parseBound(): number | null {
    // Optional step bound after U / F / G, spelled "<=k".
    if (this.isOp('<=')) {
      this.next()
      const nt = this.next()
      if (nt.k !== 'num' || !/^\d+$/.test(nt.v)) throw new PctlError('step bound after <= must be a non-negative integer')
      return Number(nt.v)
    }
    return null
  }

  private parsePath(): PathF {
    const t = this.peek()
    if (t && t.k === 'id' && (t.v === 'X' || t.v === 'F' || t.v === 'G')) {
      this.next()
      if (t.v === 'X') return { t: 'next', f: this.parseUnary() }
      const bound = this.parseBound()
      const f = this.parseUnary()
      return t.v === 'F' ? { t: 'eventually', f, bound } : { t: 'globally', f, bound }
    }
    // binary until: φ U[<=k] ψ
    const a = this.parseOr()
    const ut = this.peek()
    if (!ut || ut.k !== 'id' || ut.v !== 'U') throw new PctlError("expected 'U' in an until path (or X/F/G)")
    this.next()
    const bound = this.parseBound()
    const b = this.parseOr()
    return { t: 'until', a, b, bound }
  }
}

export function parsePctl(src: string): StateF {
  const toks = tokenize(src)
  if (toks.length === 0) throw new PctlError('empty formula')
  return new Parser(toks).parse()
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/** A probability vector with an exact rational form when available (DTMC), always a float form. */
export interface ProbVec {
  exact: Frac[] | null
  approx: number[]
}

function flip(o: Opt): Opt {
  return o === 'max' ? 'min' : 'max'
}

function kindToOpt(kind: ProbKind, model: Model): Opt {
  if (model.kind === 'dtmc') return 'max' // coincide; unused for exact path
  if (kind === 'p') throw new PctlError('an MDP needs Pmax or Pmin (plain P is ambiguous under non-determinism)')
  return kind
}

/** Boolean satisfaction set of a state formula. */
export function checkState(model: Model, f: StateF): boolean[] {
  switch (f.t) {
    case 'true':
      return new Array<boolean>(model.n).fill(true)
    case 'false':
      return new Array<boolean>(model.n).fill(false)
    case 'ap':
      return propStates(model, f.name)
    case 'not': {
      const s = checkState(model, f.f)
      return s.map((x) => !x)
    }
    case 'and': {
      const a = checkState(model, f.a)
      const b = checkState(model, f.b)
      return a.map((x, i) => x && b[i])
    }
    case 'or': {
      const a = checkState(model, f.a)
      const b = checkState(model, f.b)
      return a.map((x, i) => x || b[i])
    }
    case 'prob': {
      if (f.cmp === '=?') throw new PctlError('a =? query has no truth value — evaluate it as a query')
      const pv = pathProb(model, f.path, kindToOpt(f.kind, model))
      return compareVec(pv, f.cmp, f.bound as Frac)
    }
    case 'steady': {
      if (f.cmp === '=?') throw new PctlError('a =? query has no truth value — evaluate it as a query')
      const pv = steadyProb(model, f.inner)
      return compareVec(pv, f.cmp, f.bound as Frac)
    }
  }
}

/** The probability vector of a P-node's path (used by both the boolean check and the =? query). */
export function pathProb(model: Model, path: PathF, opt: Opt): ProbVec {
  switch (path.t) {
    case 'next': {
      const psi = checkState(model, path.f)
      if (model.kind === 'dtmc') {
        const ex = nextExact(model as DTMC, psi)
        return { exact: ex, approx: ex.map(ftoNumber) }
      }
      return { exact: null, approx: optimalNextFloat(model as MDP, psi, opt) }
    }
    case 'until': {
      const a = checkState(model, path.a)
      const b = checkState(model, path.b)
      return untilProb(model, a, b, path.bound, opt)
    }
    case 'eventually': {
      const b = checkState(model, path.f)
      const a = new Array<boolean>(model.n).fill(true)
      return untilProb(model, a, b, path.bound, opt)
    }
    case 'globally': {
      // Pr(G φ) = 1 − Pr(F ¬φ); under a scheduler the optimum flips (max G = 1 − min F¬).
      const nf = checkState(model, path.f).map((x) => !x)
      const a = new Array<boolean>(model.n).fill(true)
      const ev = untilProb(model, a, nf, path.bound, flip(opt))
      if (ev.exact) return { exact: ev.exact.map((v) => fsub(F1, v)), approx: ev.approx.map((v) => 1 - v) }
      return { exact: null, approx: ev.approx.map((v) => 1 - v) }
    }
  }
}

function untilProb(model: Model, a: boolean[], b: boolean[], bound: number | null, opt: Opt): ProbVec {
  if (model.kind === 'dtmc') {
    const ex = bound === null ? untilExact(model, a, b) : boundedUntilExact(model, a, b, bound)
    return { exact: ex, approx: ex.map(ftoNumber) }
  }
  const mdp = model as MDP
  const approx = bound === null ? optimalUntilFloat(mdp, a, b, opt).value : optimalBoundedUntilFloat(mdp, a, b, opt, bound)
  return { exact: null, approx }
}

function steadyProb(model: Model, inner: StateF): ProbVec {
  if (model.kind !== 'dtmc') throw new PctlError('steady-state (S) is only defined for a DTMC here')
  const sat = checkState(model, inner)
  const ex = steadyStateExact(model, sat)
  return { exact: ex, approx: ex.map(ftoNumber) }
}

function compareVec(pv: ProbVec, cmp: Cmp, bound: Frac): boolean[] {
  const n = pv.approx.length
  const out = new Array<boolean>(n).fill(false)
  for (let s = 0; s < n; s++) {
    let c: number
    if (pv.exact) c = fcmp(pv.exact[s], bound) // exact three-way compare on DTMC
    else {
      const diff = pv.approx[s] - ftoNumber(bound)
      c = Math.abs(diff) < 1e-9 ? 0 : diff < 0 ? -1 : 1
    }
    out[s] = cmp === '<' ? c < 0 : cmp === '<=' ? c <= 0 : cmp === '>' ? c > 0 : c >= 0
  }
  return out
}

/** True iff the formula is a top-level value query (P=? / S=?). */
export function isQuery(f: StateF): boolean {
  return (f.t === 'prob' || f.t === 'steady') && f.cmp === '=?'
}

/** Evaluate a P=? / S=? query into a probability vector. */
export function queryProb(model: Model, f: StateF): ProbVec {
  if (f.t === 'prob') return pathProb(model, f.path, kindToOpt(f.kind, model))
  if (f.t === 'steady') return steadyProb(model, f.inner)
  throw new PctlError('not a value query')
}

/** Round-trip-safe pretty printer (mostly for tests / tooltips). */
export function showState(f: StateF): string {
  switch (f.t) {
    case 'true':
      return 'true'
    case 'false':
      return 'false'
    case 'ap':
      return f.name
    case 'not':
      return `!${showState(f.f)}`
    case 'and':
      return `(${showState(f.a)} & ${showState(f.b)})`
    case 'or':
      return `(${showState(f.a)} | ${showState(f.b)})`
    case 'prob': {
      const head = f.kind === 'max' ? 'Pmax' : f.kind === 'min' ? 'Pmin' : 'P'
      const rel = f.cmp === '=?' ? '=?' : `${f.cmp}${boundStr(f.bound)}`
      return `${head}${rel} [ ${showPath(f.path)} ]`
    }
    case 'steady': {
      const head = f.kind === 'max' ? 'Smax' : f.kind === 'min' ? 'Smin' : 'S'
      const rel = f.cmp === '=?' ? '=?' : `${f.cmp}${boundStr(f.bound)}`
      return `${head}${rel} [ ${showState(f.inner)} ]`
    }
  }
}

function boundStr(b: Frac | null): string {
  if (!b) return ''
  return b.d === 1n ? b.n.toString() : `${b.n}/${b.d}`
}

function showPath(p: PathF): string {
  const bs = (b: number | null) => (b === null ? '' : `<=${b}`)
  switch (p.t) {
    case 'next':
      return `X ${showState(p.f)}`
    case 'until':
      return `${showState(p.a)} U${bs(p.bound)} ${showState(p.b)}`
    case 'eventually':
      return `F${bs(p.bound)} ${showState(p.f)}`
    case 'globally':
      return `G${bs(p.bound)} ${showState(p.f)}`
  }
}
