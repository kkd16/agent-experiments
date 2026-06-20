// Pseudo-Boolean constraints — the core data type of the 0/1 integer-linear engine.
//
// A *pseudo-Boolean* (PB) constraint is a linear inequality over Boolean (0/1) variables,
// e.g.  3·x1 + 2·x2 + x3 ≥ 4.  Every clause is the special case  Σ ℓᵢ ≥ 1, and every
// cardinality constraint  Σ ℓᵢ ≥ k  is a PB constraint with unit coefficients — so PB is a
// strict generalization of CNF that the resolution-based SAT core cannot express natively.
//
// We keep constraints in **normal form**:   Σ aᵢ·ℓᵢ ≥ degree,   aᵢ > 0,  degree ≥ 0,
// where each ℓᵢ is a literal (a variable or its negation) and every variable occurs at most
// once. Any linear inequality (≤, =, negative coefficients, repeated variables) reduces to
// one or two normal-form constraints (see {@link normalizeLinear}).
//
// Coefficients are **bigint** throughout: cutting-plane reasoning multiplies and adds
// constraints, and coefficients genuinely grow, so 53-bit floats would silently corrupt a
// proof. bigint keeps every derivation exact.
//
// Internally a constraint is a `Map<varId, bigint>` of *signed* coefficients: the value's
// sign is the literal's polarity and its magnitude is the (positive) coefficient. This makes
// addition — the workhorse of generalized resolution — a simple per-variable merge, with the
// `x + ¬x = 1` identity folded into the degree.

/** A literal in DIMACS convention: a positive integer is a variable, its negative its negation. */
export type Lit = number

/** A single weighted literal `coef · lit` with `coef > 0`. */
export interface Term {
  lit: Lit
  coef: bigint
}

/** ceil(a / b) for positive bigints. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b
}

function absBig(x: bigint): bigint {
  return x < 0n ? -x : x
}

/**
 * A pseudo-Boolean constraint in normal form `Σ aᵢ·ℓᵢ ≥ degree`, stored as signed
 * coefficients keyed by variable. Mutable: the cutting-plane engine builds learned
 * constraints by multiplying, adding, dividing and saturating in place.
 */
export class Pbc {
  /** varId → signed coefficient. sign = literal polarity, |value| = positive weight. */
  readonly coef: Map<number, bigint>
  /** Right-hand side; the constraint demands the weighted literal sum reach at least this. */
  degree: bigint

  constructor(coef?: Map<number, bigint>, degree: bigint = 0n) {
    this.coef = coef ?? new Map()
    this.degree = degree
  }

  /** Build a constraint `Σ terms ≥ degree` from positive-coefficient literal terms. */
  static fromTerms(terms: Term[], degree: bigint): Pbc {
    const c = new Pbc(new Map(), degree)
    for (const t of terms) c.addTerm(t.lit, t.coef)
    return c
  }

  /** A clause `ℓ₁ ∨ … ∨ ℓₙ` as the PB constraint `Σ ℓᵢ ≥ 1`. */
  static fromClause(lits: Lit[]): Pbc {
    return Pbc.fromTerms(
      lits.map((lit) => ({ lit, coef: 1n })),
      1n,
    )
  }

  clone(): Pbc {
    return new Pbc(new Map(this.coef), this.degree)
  }

  /** The signed literal currently carried for `v` (DIMACS), or 0 if `v` is absent. */
  literalOf(v: number): Lit {
    const s = this.coef.get(v)
    if (s === undefined || s === 0n) return 0
    return s > 0n ? v : -v
  }

  /** The positive coefficient on variable `v` (0 if absent). */
  coefOf(v: number): bigint {
    const s = this.coef.get(v)
    return s === undefined ? 0n : absBig(s)
  }

  /** The sum of all (positive) coefficients — the largest the LHS can ever reach. */
  totalCoef(): bigint {
    let t = 0n
    for (const s of this.coef.values()) t += absBig(s)
    return t
  }

  /** Sorted (descending coefficient) list of literal terms — for display / iteration. */
  terms(): Term[] {
    const out: Term[] = []
    for (const [v, s] of this.coef) {
      if (s === 0n) continue
      out.push({ lit: s > 0n ? v : -v, coef: absBig(s) })
    }
    out.sort((a, b) => (b.coef === a.coef ? Math.abs(a.lit) - Math.abs(b.lit) : Number(b.coef - a.coef)))
    return out
  }

  /**
   * Add a single weighted literal `coef · lit` (coef > 0), folding it into the existing
   * term on the same variable. The merge implements the identity `x + ¬x = 1`: when a
   * variable carries opposite literals, the smaller cancels and slides into the degree.
   */
  addTerm(lit: Lit, coef: bigint): void {
    if (coef <= 0n || lit === 0) return
    const v = Math.abs(lit)
    const signed = lit > 0 ? coef : -coef
    const cur = this.coef.get(v)
    if (cur === undefined || cur === 0n) {
      this.coef.set(v, signed)
      return
    }
    if ((cur > 0n) === lit > 0) {
      // Same polarity: coefficients add.
      this.coef.set(v, cur + signed)
      return
    }
    // Opposite polarity: a·x + b·¬x = min(a,b) + |a−b|·(larger literal).
    const a = absBig(cur)
    const b = coef
    const m = a < b ? a : b
    this.degree -= m
    const diff = a - b
    if (diff === 0n) this.coef.delete(v)
    else this.coef.set(v, cur > 0n ? diff : -diff) // keep sign of the dominant side
  }

  /** Add another constraint term-by-term (a sound nonnegative combination). */
  addConstraint(other: Pbc): void {
    for (const [v, s] of other.coef) {
      if (s === 0n) continue
      this.addTerm(s > 0n ? v : -v, absBig(s))
    }
    this.degree += other.degree
  }

  /** Multiply the whole constraint by a positive integer (a sound scaling). */
  multiply(k: bigint): void {
    if (k <= 0n) throw new Error('multiply by non-positive')
    if (k === 1n) return
    for (const [v, s] of this.coef) this.coef.set(v, s * k)
    this.degree *= k
  }

  /**
   * Chvátal–Gomory division: divide every coefficient and the degree by `k`, rounding
   * **up**. Sound for 0/1 variables (each literal is integral, so its rounded share still
   * applies), and the engine's main lever for keeping coefficients small.
   */
  divideCeil(k: bigint): void {
    if (k <= 0n) throw new Error('divide by non-positive')
    if (k === 1n) return
    for (const [v, s] of this.coef) {
      const mag = ceilDiv(absBig(s), k)
      this.coef.set(v, s > 0n ? mag : -mag)
    }
    this.degree = this.degree > 0n ? ceilDiv(this.degree, k) : 0n
  }

  /**
   * Saturation: cap every coefficient at the degree. A literal can contribute at most
   * `degree` toward satisfying the constraint, so a larger coefficient is redundant; this
   * preserves the 0/1 solution set while shrinking the numbers.
   */
  saturate(): void {
    if (this.degree <= 0n) return
    for (const [v, s] of this.coef) {
      const mag = absBig(s)
      if (mag > this.degree) this.coef.set(v, s > 0n ? this.degree : -this.degree)
    }
  }

  /**
   * Weaken away a variable: drop its term and reduce the degree by its coefficient. The
   * result is implied by the original (since the dropped literal is ≤ 1), so weakening is a
   * sound — if lossy — inference. Used to clear non-divisible literals before division.
   */
  weaken(v: number): void {
    const s = this.coef.get(v)
    if (s === undefined || s === 0n) return
    this.degree -= absBig(s)
    this.coef.delete(v)
  }

  /** A constraint with non-positive degree is satisfied by every assignment. */
  isTriviallyTrue(): boolean {
    return this.degree <= 0n
  }

  /** A constraint demanding more than the literals can ever supply is unsatisfiable. */
  isContradiction(): boolean {
    return this.degree > 0n && this.totalCoef() < this.degree
  }

  /** Drop zero-coefficient ghosts (keeps the map tidy after cancellation). */
  trim(): void {
    for (const [v, s] of this.coef) if (s === 0n) this.coef.delete(v)
  }

  /**
   * Slack under a partial assignment `value[v] ∈ {true,false,undefined}` (1-based):
   * `(Σ over non-falsified literals of their coefficient) − degree`. A negative slack means
   * the constraint is already violated (a conflict); a literal whose coefficient exceeds the
   * slack must be set true (a propagation).
   */
  slack(value: (boolean | undefined)[]): bigint {
    let sum = 0n
    for (const [v, s] of this.coef) {
      if (s === 0n) continue
      const val = value[v]
      const falsified = val !== undefined && (s > 0n ? val === false : val === true)
      if (!falsified) sum += absBig(s)
    }
    return sum - this.degree
  }

  /** Evaluate against a complete model `value[v] ∈ {true,false}` (1-based). */
  satisfiedBy(value: boolean[]): boolean {
    let sum = 0n
    for (const [v, s] of this.coef) {
      if (s === 0n) continue
      const lit = s > 0n
      if ((lit && value[v]) || (!lit && !value[v])) sum += absBig(s)
    }
    return sum >= this.degree
  }

  /** Human-readable form, e.g. `3 x1 + 2 ~x2 + x3 >= 4`. */
  toString(): string {
    const ts = this.terms()
    if (ts.length === 0) return `0 >= ${this.degree}`
    const body = ts
      .map((t) => {
        const name = t.lit > 0 ? `x${t.lit}` : `~x${-t.lit}`
        return t.coef === 1n ? name : `${t.coef} ${name}`
      })
      .join(' + ')
    return `${body} >= ${this.degree}`
  }
}

/** A weighted literal with a possibly-negative integer coefficient (general linear input). */
export interface SignedTerm {
  lit: Lit
  coef: bigint
}

/** Comparison operators accepted by {@link normalizeLinear}. */
export type Cmp = '>=' | '<=' | '=' | '>' | '<'

/**
 * Build the normal-form constraint `Σ cᵢ·ℓᵢ ≥ b` where the `cᵢ` may be any sign. A negative
 * coefficient is turned positive with the identity `c·ℓ = c·(1 − ¬ℓ) = c + |c|·¬ℓ`, which
 * moves its weight onto the opposite literal and grows the degree.
 */
function geqSigned(ts: SignedTerm[], b: bigint): Pbc {
  const c = new Pbc(new Map(), b)
  for (const t of ts) {
    if (t.coef === 0n) continue
    if (t.coef > 0n) c.addTerm(t.lit, t.coef)
    else {
      c.addTerm(-t.lit, -t.coef)
      c.degree += -t.coef // subtract c (= −|c|) from both sides ⇒ degree grows by |c|
    }
  }
  if (c.degree < 0n) c.degree = 0n // a non-positive degree is trivially true; pin it at 0
  c.trim()
  c.saturate()
  return c
}

const flipSigns = (ts: SignedTerm[]): SignedTerm[] => ts.map((t) => ({ lit: t.lit, coef: -t.coef }))

/**
 * Reduce an arbitrary integer-linear constraint over 0/1 variables —
 * `Σ cᵢ·ℓᵢ  ⋈  rhs` with any integer coefficients (positive or negative), any comparator,
 * and possibly repeated variables — to a list of normal-form {@link Pbc}s whose conjunction
 * has the *same* 0/1 solution set. Equalities and strict comparisons split into two bounds.
 *
 * The reduction uses two identities: `ℓ = 1 − ¬ℓ` turns a negative coefficient positive
 * (moving its weight into the degree), and `−Σ ≥ −b` flips a ≤ into a ≥. Strict `>`/`<` over
 * integers tighten the bound by one.
 */
export function normalizeLinear(terms: SignedTerm[], cmp: Cmp, rhs: bigint): Pbc[] {
  switch (cmp) {
    case '>=':
      return [geqSigned(terms, rhs)]
    case '<=':
      // Σ cᵢ ℓᵢ ≤ rhs  ⇔  Σ (−cᵢ) ℓᵢ ≥ −rhs.
      return [geqSigned(flipSigns(terms), -rhs)]
    case '>':
      return [geqSigned(terms, rhs + 1n)]
    case '<':
      return [geqSigned(flipSigns(terms), -(rhs - 1n))]
    case '=':
      return [...normalizeLinear(terms, '>=', rhs), ...normalizeLinear(terms, '<=', rhs)]
  }
}
