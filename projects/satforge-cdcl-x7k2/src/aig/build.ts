// A tiny hardware DSL — the authoring front-end for the studio — plus a handful of
// structural circuit generators (ripple / carry-select adders, multipliers) that
// produce genuinely *different* AIGs computing the *same* function, which is exactly
// what makes equivalence checking interesting.
//
// DSL syntax, one statement per line:
//
//     # a full adder, two ways of writing the same thing
//     s  = a ^ b ^ cin              # an internal wire
//     out sum   = s                 # a primary output
//     out cout  = (a & b) | (cin & (a ^ b))
//
// Operators, lowest to highest precedence: `|` (or), `^` (xor), `&` (and),
// unary `~`/`!` (not), then atoms: an identifier, a literal `0`/`1`, or `( … )`.
// Any identifier that is referenced but never assigned is a primary input.

import { Aig, CONST0, CONST1, type Lit } from './aig'

export type Ast =
  | { k: 'const'; v: 0 | 1 }
  | { k: 'var'; name: string }
  | { k: 'not'; a: Ast }
  | { k: 'and'; a: Ast; b: Ast }
  | { k: 'or'; a: Ast; b: Ast }
  | { k: 'xor'; a: Ast; b: Ast }

export interface Circuit {
  inputs: string[]
  wires: Map<string, Ast>
  outputs: { name: string; ast: Ast }[]
}

export type ParseCircuit = { ok: true; circuit: Circuit } | { ok: false; error: string; line: number }

// ── lexer ───────────────────────────────────────────────────────────────────
type Tok = { t: string; v?: string }

function lex(line: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === ' ' || c === '\t') {
      i++
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j++
      toks.push({ t: 'id', v: line.slice(i, j) })
      i = j
      continue
    }
    if (c === '0' || c === '1') {
      toks.push({ t: 'num', v: c })
      i++
      continue
    }
    if ('&|^~!()='.includes(c)) {
      toks.push({ t: c })
      i++
      continue
    }
    throw new Error(`unexpected character '${c}'`)
  }
  return toks
}

// ── recursive-descent expression parser ──────────────────────────────────────
class ExprParser {
  private p = 0
  private toks: Tok[]
  constructor(toks: Tok[]) {
    this.toks = toks
  }
  private peek(): Tok | undefined {
    return this.toks[this.p]
  }
  private eat(t?: string): Tok {
    const tok = this.toks[this.p]
    if (!tok) throw new Error('unexpected end of expression')
    if (t && tok.t !== t) throw new Error(`expected '${t}', got '${tok.v ?? tok.t}'`)
    this.p++
    return tok
  }
  parse(): Ast {
    const e = this.or()
    if (this.p !== this.toks.length) throw new Error(`trailing tokens after expression`)
    return e
  }
  private or(): Ast {
    let a = this.xor()
    while (this.peek()?.t === '|') {
      this.eat('|')
      a = { k: 'or', a, b: this.xor() }
    }
    return a
  }
  private xor(): Ast {
    let a = this.and()
    while (this.peek()?.t === '^') {
      this.eat('^')
      a = { k: 'xor', a, b: this.and() }
    }
    return a
  }
  private and(): Ast {
    let a = this.unary()
    while (this.peek()?.t === '&') {
      this.eat('&')
      a = { k: 'and', a, b: this.unary() }
    }
    return a
  }
  private unary(): Ast {
    const t = this.peek()
    if (t && (t.t === '~' || t.t === '!')) {
      this.eat()
      return { k: 'not', a: this.unary() }
    }
    return this.atom()
  }
  private atom(): Ast {
    const t = this.eat()
    if (t.t === '(') {
      const e = this.or()
      this.eat(')')
      return e
    }
    if (t.t === 'num') return { k: 'const', v: t.v === '1' ? 1 : 0 }
    if (t.t === 'id') return { k: 'var', name: t.v! }
    throw new Error(`expected an atom, got '${t.v ?? t.t}'`)
  }
}

/** Parse a multi-line circuit description. */
export function parseCircuit(src: string): ParseCircuit {
  const wires = new Map<string, Ast>()
  const outputs: { name: string; ast: Ast }[] = []
  const assigned = new Set<string>()
  const referenced: string[] = []
  const seenRef = new Set<string>()

  const collectRefs = (a: Ast) => {
    if (a.k === 'var') {
      if (!seenRef.has(a.name)) {
        seenRef.add(a.name)
        referenced.push(a.name)
      }
    } else if (a.k === 'not') collectRefs(a.a)
    else if (a.k === 'and' || a.k === 'or' || a.k === 'xor') {
      collectRefs(a.a)
      collectRefs(a.b)
    }
  }

  const rawLines = src.split(/\r?\n/)
  for (let ln = 0; ln < rawLines.length; ln++) {
    let line = rawLines[ln]
    const hash = line.indexOf('#')
    if (hash >= 0) line = line.slice(0, hash)
    const dslash = line.indexOf('//')
    if (dslash >= 0) line = line.slice(0, dslash)
    line = line.trim()
    if (line === '') continue

    let isOut = false
    if (/^out\b/.test(line)) {
      isOut = true
      line = line.replace(/^out\b/, '').trim()
    }
    const eq = line.indexOf('=')
    if (eq < 0) return { ok: false, error: `statement has no '=' (expected NAME = EXPR)`, line: ln + 1 }
    const name = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      return { ok: false, error: `invalid signal name '${name}'`, line: ln + 1 }
    const rhs = line.slice(eq + 1).trim()
    let ast: Ast
    try {
      ast = new ExprParser(lex(rhs)).parse()
    } catch (e) {
      return { ok: false, error: (e as Error).message, line: ln + 1 }
    }
    collectRefs(ast)
    if (assigned.has(name)) return { ok: false, error: `signal '${name}' assigned twice`, line: ln + 1 }
    assigned.add(name)
    if (isOut) outputs.push({ name, ast })
    else wires.set(name, ast)
  }

  if (outputs.length === 0) return { ok: false, error: `no outputs — mark at least one line 'out NAME = …'`, line: rawLines.length }
  const inputs = referenced.filter((r) => !assigned.has(r))
  return { ok: true, circuit: { inputs, wires, outputs } }
}

/**
 * Elaborate a parsed circuit into a shared AIG, resolving wire references (with
 * memoization and cycle detection). `inputLit` supplies the literal for each named
 * primary input — the *same* map is passed for both circuits in an equivalence
 * check so they genuinely share inputs.
 */
export function buildCircuit(aig: Aig, c: Circuit, inputLit: Map<string, Lit>): { name: string; lit: Lit }[] {
  const memo = new Map<string, Lit>()
  const inProgress = new Set<string>()

  const build = (a: Ast): Lit => {
    switch (a.k) {
      case 'const':
        return a.v ? CONST1 : CONST0
      case 'not':
        return litNotHelper(build(a.a))
      case 'and':
        return aig.mkAnd(build(a.a), build(a.b))
      case 'or':
        return aig.mkOr(build(a.a), build(a.b))
      case 'xor':
        return aig.mkXor(build(a.a), build(a.b))
      case 'var': {
        const lit = inputLit.get(a.name)
        if (lit !== undefined) return lit
        if (memo.has(a.name)) return memo.get(a.name)!
        const w = c.wires.get(a.name)
        if (!w) throw new Error(`undefined signal '${a.name}'`)
        if (inProgress.has(a.name)) throw new Error(`combinational cycle through '${a.name}'`)
        inProgress.add(a.name)
        const r = build(w)
        inProgress.delete(a.name)
        memo.set(a.name, r)
        return r
      }
    }
  }
  return c.outputs.map((o) => ({ name: o.name, lit: build(o.ast) }))
}

// Local import-free negation (avoids a circular dependency with aig's litNot at call
// sites that already hold an Aig — kept trivial and inline).
const litNotHelper = (l: Lit): Lit => l ^ 1

export interface BuiltPair {
  aig: Aig
  pairs: { name: string; a: Lit; b: Lit }[]
}

export type BuildPairResult = { ok: true; built: BuiltPair } | { ok: false; error: string }

/**
 * Parse two DSL circuits and build them into one shared AIG, pairing outputs by
 * name. Both circuits see the same primary-input literals.
 */
export function buildPairFromDsl(srcA: string, srcB: string): BuildPairResult {
  const pa = parseCircuit(srcA)
  if (!pa.ok) return { ok: false, error: `Circuit A, line ${pa.line}: ${pa.error}` }
  const pb = parseCircuit(srcB)
  if (!pb.ok) return { ok: false, error: `Circuit B, line ${pb.line}: ${pb.error}` }

  const aig = new Aig()
  const inputLit = new Map<string, Lit>()
  const order: string[] = []
  for (const n of [...pa.circuit.inputs, ...pb.circuit.inputs]) {
    if (!inputLit.has(n)) {
      inputLit.set(n, aig.addInput(n))
      order.push(n)
    }
  }

  let outsA: { name: string; lit: Lit }[]
  let outsB: { name: string; lit: Lit }[]
  try {
    outsA = buildCircuit(aig, pa.circuit, inputLit)
    outsB = buildCircuit(aig, pb.circuit, inputLit)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  const namesA = outsA.map((o) => o.name).sort().join(',')
  const namesB = outsB.map((o) => o.name).sort().join(',')
  if (namesA !== namesB)
    return {
      ok: false,
      error: `output names differ — A has {${namesA}}, B has {${namesB}}. They must match to compare.`,
    }
  const mapB = new Map(outsB.map((o) => [o.name, o.lit]))
  const pairs = outsA.map((o) => ({ name: o.name, a: o.lit, b: mapB.get(o.name)! }))
  for (const p of pairs) aig.addOutput(p.name, p.a)
  return { ok: true, built: { aig, pairs } }
}

// ── structural circuit generators ────────────────────────────────────────────

/** A ripple-carry adder: returns the `width` sum bits and the final carry-out. */
export function rippleAdder(aig: Aig, a: Lit[], b: Lit[], cin: Lit = CONST0): { sum: Lit[]; cout: Lit } {
  const sum: Lit[] = []
  let carry = cin
  for (let i = 0; i < a.length; i++) {
    const axb = aig.mkXor(a[i], b[i])
    sum.push(aig.mkXor(axb, carry))
    carry = aig.mkOr(aig.mkAnd(a[i], b[i]), aig.mkAnd(axb, carry))
  }
  return { sum, cout: carry }
}

/**
 * A carry-select adder: split into blocks, precompute each upper block for carry-in
 * 0 and 1, then MUX by the real carry. Structurally very different from ripple —
 * more gates, less depth — yet exactly equal, the canonical CEC test case.
 */
export function carrySelectAdder(
  aig: Aig,
  a: Lit[],
  b: Lit[],
  block = 2,
  cin: Lit = CONST0,
): { sum: Lit[]; cout: Lit } {
  const n = a.length
  const sum: Lit[] = []
  let carry = cin
  for (let lo = 0; lo < n; lo += block) {
    const hi = Math.min(lo + block, n)
    const a0 = rippleAdder(aig, a.slice(lo, hi), b.slice(lo, hi), CONST0)
    const a1 = rippleAdder(aig, a.slice(lo, hi), b.slice(lo, hi), CONST1)
    for (let i = 0; i < hi - lo; i++) sum.push(aig.mkMux(carry, a1.sum[i], a0.sum[i]))
    carry = aig.mkMux(carry, a1.cout, a0.cout)
  }
  return { sum, cout: carry }
}

/** A shift-and-add array multiplier: returns the `2·width` product bits. */
export function arrayMultiplier(aig: Aig, a: Lit[], b: Lit[]): Lit[] {
  const n = a.length
  let acc: Lit[] = new Array(2 * n).fill(CONST0)
  for (let j = 0; j < n; j++) {
    const partial: Lit[] = new Array(2 * n).fill(CONST0)
    for (let i = 0; i < n; i++) partial[i + j] = aig.mkAnd(a[i], b[j])
    acc = rippleAdder(aig, acc, partial).sum
  }
  return acc.slice(0, 2 * n)
}

/** Declare `width` primary inputs named `<prefix>0..<prefix>(width-1)`. */
export function inputBus(aig: Aig, prefix: string, width: number): Lit[] {
  return Array.from({ length: width }, (_, i) => aig.addInput(`${prefix}${i}`))
}
