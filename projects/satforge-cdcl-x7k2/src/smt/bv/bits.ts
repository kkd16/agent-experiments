// Gate-level CNF builder — the substrate every bit-vector operation is blasted
// onto. A `Blaster` hands out fresh SAT variables and accumulates clauses while
// you wire up Tseitin gates; the finished {numVars, clauses} feeds straight into
// the existing CDCL core (src/sat/solver.ts). This is the whole point of *eager*
// bit-blasting: a bit-vector formula becomes one big propositional circuit and
// the SAT engine does the search.
//
// A literal is a DIMACS-style signed integer (variable v>0, negation -v). Two
// reserved literals, TRUE and FALSE, let every primitive constant-fold: shifting
// in zeros, comparing against literals, and multiplying by constant bits all
// collapse instead of emitting dead gates, which keeps the CNF small enough that
// small instances are decided in well under a millisecond.

export type Lit = number

export class Blaster {
  readonly clauses: number[][] = []
  private nVars = 0
  /** A literal pinned to true (and its negation, pinned to false). */
  readonly TRUE: Lit
  readonly FALSE: Lit
  /** Tseitin-gate cache: structural key → output literal (subexpression sharing). */
  private gateCache = new Map<string, Lit>()

  constructor() {
    this.TRUE = this.newVar()
    this.clauses.push([this.TRUE])
    this.FALSE = -this.TRUE
  }

  get numVars(): number {
    return this.nVars
  }

  newVar(): Lit {
    return ++this.nVars
  }

  addClause(lits: Lit[]): void {
    this.clauses.push(lits)
  }

  private isTrue(l: Lit): boolean {
    return l === this.TRUE
  }
  private isFalse(l: Lit): boolean {
    return l === this.FALSE
  }

  not(a: Lit): Lit {
    return -a
  }

  // ---- Tseitin gates (each returns y with clauses encoding y ↔ gate) ---------
  and(a: Lit, b: Lit): Lit {
    if (this.isFalse(a) || this.isFalse(b)) return this.FALSE
    if (this.isTrue(a)) return b
    if (this.isTrue(b)) return a
    if (a === b) return a
    if (a === -b) return this.FALSE
    return this.cached('&', a, b, () => {
      const y = this.newVar()
      this.clauses.push([-y, a], [-y, b], [y, -a, -b])
      return y
    })
  }

  or(a: Lit, b: Lit): Lit {
    if (this.isTrue(a) || this.isTrue(b)) return this.TRUE
    if (this.isFalse(a)) return b
    if (this.isFalse(b)) return a
    if (a === b) return a
    if (a === -b) return this.TRUE
    return this.cached('|', a, b, () => {
      const y = this.newVar()
      this.clauses.push([y, -a], [y, -b], [-y, a, b])
      return y
    })
  }

  xor(a: Lit, b: Lit): Lit {
    if (this.isFalse(a)) return b
    if (this.isFalse(b)) return a
    if (this.isTrue(a)) return -b
    if (this.isTrue(b)) return -a
    if (a === b) return this.FALSE
    if (a === -b) return this.TRUE
    return this.cached('^', a, b, () => {
      const y = this.newVar()
      this.clauses.push([-y, -a, -b], [-y, a, b], [y, -a, b], [y, a, -b])
      return y
    })
  }

  /** Logical equivalence a ↔ b (xnor). */
  iff(a: Lit, b: Lit): Lit {
    return -this.xor(a, b)
  }

  /** Multiplexer: s ? t : e. Heavy constant-folding — shifters live and die here. */
  mux(s: Lit, t: Lit, e: Lit): Lit {
    if (this.isTrue(s)) return t
    if (this.isFalse(s)) return e
    if (t === e) return t
    if (this.isTrue(t) && this.isFalse(e)) return s
    if (this.isFalse(t) && this.isTrue(e)) return -s
    if (this.isTrue(t)) return this.or(s, e)
    if (this.isFalse(t)) return this.and(-s, e)
    if (this.isTrue(e)) return this.or(-s, t)
    if (this.isFalse(e)) return this.and(s, t)
    if (t === -e) return this.xor(-s, t) // s?t:¬t = (s∧t)∨(¬s∧¬t) = ¬(s⊕t)... = xnor(s,t)= ¬xor; xor(-s,t)
    return this.cached3('?', s, t, e, () => {
      const y = this.newVar()
      // y ↔ (s→t) ∧ (¬s→e)
      this.clauses.push([-s, -t, y], [-s, t, -y], [s, -e, y], [s, e, -y])
      return y
    })
  }

  // ---- assertions ------------------------------------------------------------
  assertTrue(a: Lit): void {
    this.clauses.push([a])
  }

  // ---- caches (structural sharing of identical gates) ------------------------
  private cached(tag: string, a: Lit, b: Lit, make: () => Lit): Lit {
    // commutative: normalize operand order
    const [x, y] = a <= b ? [a, b] : [b, a]
    const key = `${tag}:${x},${y}`
    const hit = this.gateCache.get(key)
    if (hit !== undefined) return hit
    const out = make()
    this.gateCache.set(key, out)
    return out
  }

  private cached3(tag: string, a: Lit, b: Lit, c: Lit, make: () => Lit): Lit {
    const key = `${tag}:${a},${b},${c}`
    const hit = this.gateCache.get(key)
    if (hit !== undefined) return hit
    const out = make()
    this.gateCache.set(key, out)
    return out
  }
}
