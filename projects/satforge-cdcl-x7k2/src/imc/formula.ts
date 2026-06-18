// A tiny Boolean-formula / circuit layer used by the interpolation and
// model-checking subsystem. Variables are positive integers (1, 2, …). The
// same formula can be (a) evaluated under a concrete assignment — the basis of
// the independent explicit-state reachability oracle — and (b) Tseitin-encoded
// into CNF for the proof-logging SAT solver. Keeping one representation for both
// is what lets the self-test cross-check the SAT-based answer against brute force.

export type Formula =
  | { t: 'const'; v: boolean }
  | { t: 'var'; v: number }
  | { t: 'not'; a: Formula }
  | { t: 'and'; a: Formula; b: Formula }
  | { t: 'or'; a: Formula; b: Formula }
  | { t: 'xor'; a: Formula; b: Formula }
  | { t: 'imp'; a: Formula; b: Formula }
  | { t: 'iff'; a: Formula; b: Formula }

export const TRUE: Formula = { t: 'const', v: true }
export const FALSE: Formula = { t: 'const', v: false }

export const fvar = (v: number): Formula => {
  if (!Number.isInteger(v) || v < 1) throw new Error(`formula variable must be a positive integer, got ${v}`)
  return { t: 'var', v }
}

export const fnot = (a: Formula): Formula => (a.t === 'const' ? { t: 'const', v: !a.v } : { t: 'not', a })

const bin =
  (t: 'and' | 'or' | 'xor' | 'imp' | 'iff') =>
  (a: Formula, b: Formula): Formula => ({ t, a, b }) as Formula

const and2 = bin('and')
const or2 = bin('or')
export const fxor = bin('xor')
export const fimp = bin('imp')
export const fiff = bin('iff')

/** Variadic AND with identity/annihilator folding. */
export function fand(...xs: Formula[]): Formula {
  const parts = xs.filter((x) => !(x.t === 'const' && x.v))
  if (parts.some((x) => x.t === 'const' && !x.v)) return FALSE
  if (parts.length === 0) return TRUE
  return parts.reduce((acc, x) => and2(acc, x))
}

/** Variadic OR with identity/annihilator folding. */
export function for_(...xs: Formula[]): Formula {
  const parts = xs.filter((x) => !(x.t === 'const' && !x.v))
  if (parts.some((x) => x.t === 'const' && x.v)) return TRUE
  if (parts.length === 0) return FALSE
  return parts.reduce((acc, x) => or2(acc, x))
}

/** Evaluate a formula under a concrete assignment. */
export function evalFormula(f: Formula, assign: (v: number) => boolean): boolean {
  switch (f.t) {
    case 'const':
      return f.v
    case 'var':
      return assign(f.v)
    case 'not':
      return !evalFormula(f.a, assign)
    case 'and':
      return evalFormula(f.a, assign) && evalFormula(f.b, assign)
    case 'or':
      return evalFormula(f.a, assign) || evalFormula(f.b, assign)
    case 'xor':
      return evalFormula(f.a, assign) !== evalFormula(f.b, assign)
    case 'imp':
      return !evalFormula(f.a, assign) || evalFormula(f.b, assign)
    case 'iff':
      return evalFormula(f.a, assign) === evalFormula(f.b, assign)
  }
}

/** All variable ids appearing in a formula. */
export function formulaVars(f: Formula, out: Set<number> = new Set()): Set<number> {
  switch (f.t) {
    case 'const':
      break
    case 'var':
      out.add(f.v)
      break
    case 'not':
      formulaVars(f.a, out)
      break
    default:
      formulaVars(f.a, out)
      formulaVars(f.b, out)
  }
  return out
}

/** Rename every variable through `map` (used to prime/unprime state variables). */
export function mapVars(f: Formula, map: (v: number) => number): Formula {
  switch (f.t) {
    case 'const':
      return f
    case 'var':
      return { t: 'var', v: map(f.v) }
    case 'not':
      return { t: 'not', a: mapVars(f.a, map) }
    default:
      return { t: f.t, a: mapVars(f.a, map), b: mapVars(f.b, map) } as Formula
  }
}

/** Render a formula as a compact infix string (for display). `name` maps var ids. */
export function formulaToString(f: Formula, name: (v: number) => string = (v) => `v${v}`): string {
  const prec = (g: Formula): number => {
    switch (g.t) {
      case 'const':
      case 'var':
        return 5
      case 'not':
        return 4
      case 'and':
        return 3
      case 'xor':
        return 2
      case 'or':
        return 1
      default:
        return 0 // imp / iff
    }
  }
  const wrap = (g: Formula, parentPrec: number): string => {
    const s = formulaToString(g, name)
    return prec(g) < parentPrec ? `(${s})` : s
  }
  switch (f.t) {
    case 'const':
      return f.v ? '⊤' : '⊥'
    case 'var':
      return name(f.v)
    case 'not':
      return `¬${wrap(f.a, 4)}`
    case 'and':
      return `${wrap(f.a, 3)} ∧ ${wrap(f.b, 3)}`
    case 'or':
      return `${wrap(f.a, 1)} ∨ ${wrap(f.b, 1)}`
    case 'xor':
      return `${wrap(f.a, 2)} ⊕ ${wrap(f.b, 2)}`
    case 'imp':
      return `${wrap(f.a, 1)} → ${wrap(f.b, 1)}`
    case 'iff':
      return `${wrap(f.a, 1)} ↔ ${wrap(f.b, 1)}`
  }
}

/**
 * Structural simplification: constant folding plus collapsing of trivially
 * redundant and/or (x∧x, x∨x, x∧¬x, …). Keeps displayed interpolants readable
 * without changing their truth value.
 */
export function simplify(f: Formula): Formula {
  const key = (g: Formula): string => {
    switch (g.t) {
      case 'const':
        return g.v ? 'T' : 'F'
      case 'var':
        return `v${g.v}`
      case 'not':
        return `!${key(g.a)}`
      default:
        return `(${g.t} ${key(g.a)} ${key(g.b)})`
    }
  }
  switch (f.t) {
    case 'const':
    case 'var':
      return f
    case 'not': {
      const a = simplify(f.a)
      return fnot(a)
    }
    case 'and': {
      const a = simplify(f.a)
      const b = simplify(f.b)
      if (a.t === 'const') return a.v ? b : FALSE
      if (b.t === 'const') return b.v ? a : FALSE
      if (key(a) === key(b)) return a
      if (key(fnot(a)) === key(b) || key(a) === key(fnot(b))) return FALSE
      return { t: 'and', a, b }
    }
    case 'or': {
      const a = simplify(f.a)
      const b = simplify(f.b)
      if (a.t === 'const') return a.v ? TRUE : b
      if (b.t === 'const') return b.v ? TRUE : a
      if (key(a) === key(b)) return a
      if (key(fnot(a)) === key(b) || key(a) === key(fnot(b))) return TRUE
      return { t: 'or', a, b }
    }
    default: {
      const a = simplify(f.a)
      const b = simplify(f.b)
      return { t: f.t, a, b } as Formula
    }
  }
}

// ---- CNF building + Tseitin transformation --------------------------------

/** A growable CNF under construction. Variables are 1..numVars. */
export class CnfBuilder {
  numVars: number
  clauses: number[][] = []
  private trueLit = 0

  constructor(startVars = 0) {
    this.numVars = startVars
  }

  fresh(): number {
    this.numVars += 1
    return this.numVars
  }

  /**
   * Start a new interpolation partition: forget the shared true-literal so the
   * next side allocates its own. This keeps every auxiliary (Tseitin) variable
   * local to one side, so an interpolant's vocabulary stays within the shared
   * (state) variables — exactly what McMillan's algorithm needs.
   */
  newPartition(): void {
    this.trueLit = 0
  }

  /** Snapshot of how many clauses have been emitted so far. */
  get clauseCount(): number {
    return this.clauses.length
  }

  add(...lits: number[]): void {
    this.clauses.push(lits)
  }

  /** A literal that is forced true (allocated lazily, shared across calls). */
  private getTrue(): number {
    if (this.trueLit === 0) {
      this.trueLit = this.fresh()
      this.add(this.trueLit)
    }
    return this.trueLit
  }

  /**
   * Tseitin-encode `f`, returning a literal whose truth value equals f. Fresh
   * variables and the defining clauses are appended to this builder.
   */
  encode(f: Formula): number {
    switch (f.t) {
      case 'const':
        return f.v ? this.getTrue() : -this.getTrue()
      case 'var':
        if (f.v > this.numVars) this.numVars = f.v
        return f.v
      case 'not':
        return -this.encode(f.a)
      case 'and': {
        const a = this.encode(f.a)
        const b = this.encode(f.b)
        const l = this.fresh()
        // l <-> (a ∧ b)
        this.add(-l, a)
        this.add(-l, b)
        this.add(l, -a, -b)
        return l
      }
      case 'or': {
        const a = this.encode(f.a)
        const b = this.encode(f.b)
        const l = this.fresh()
        // l <-> (a ∨ b)
        this.add(l, -a)
        this.add(l, -b)
        this.add(-l, a, b)
        return l
      }
      case 'imp':
        return this.encode({ t: 'or', a: { t: 'not', a: f.a }, b: f.b })
      case 'xor': {
        const a = this.encode(f.a)
        const b = this.encode(f.b)
        const l = this.fresh()
        // l <-> (a xor b)
        this.add(-l, -a, -b)
        this.add(-l, a, b)
        this.add(l, -a, b)
        this.add(l, a, -b)
        return l
      }
      case 'iff':
        return -this.encode({ t: 'xor', a: f.a, b: f.b })
    }
  }

  /** Append `f` as a hard constraint (assert it true). */
  assert(f: Formula): void {
    // Small fast paths keep generated CNF clean for tiny formulas.
    if (f.t === 'const') {
      if (!f.v) this.add() // empty clause -> immediately unsat
      return
    }
    this.add(this.encode(f))
  }
}
