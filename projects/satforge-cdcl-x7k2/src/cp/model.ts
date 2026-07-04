// The modelling layer: a small builder that turns a declarative constraint
// model into concrete variables (domains) + propagators, ready for the search
// engine. Keeping this separate from the engine means the example library reads
// like a specification, not solver plumbing.

import type { Domain } from './domain.ts'
import { range, fromValues, assign } from './domain.ts'
import type { Propagator } from './store.ts'
import type { AllDiffLevel } from './propagators.ts'
import { allDifferent, element, linearLe, notEqual, table } from './propagators.ts'

export type Op = '<=' | '>=' | '=' | '<' | '>'

export class Model {
  readonly names: string[] = []
  readonly domains: Domain[] = []
  readonly propagators: Propagator[] = []
  /**
   * Independent boolean checkers — one per posted constraint — evaluating the
   * constraint's semantics *directly* on a full assignment. These are a second,
   * separate code path from the propagators, so the self-test can run the
   * solver against a brute-force oracle built purely from these (a genuine
   * solver-vs-checker differential) and re-validate every reported solution.
   */
  readonly checks: Array<(a: number[]) => boolean> = []
  /** Default all-different filtering level (overridable per solve). */
  allDiffLevel: AllDiffLevel = 'domain'
  /** Scopes of every all-different, so the level can be re-chosen at solve time. */
  readonly allDiffScopes: number[][] = []

  /** Create an integer variable with domain [lo, hi]. Returns its id. */
  newVar(name: string, lo: number, hi: number): number {
    const id = this.domains.length
    this.names.push(name)
    this.domains.push(range(lo, hi))
    return id
  }

  /** Create an integer variable over an explicit value set. */
  newVarValues(name: string, vals: Iterable<number>): number {
    const id = this.domains.length
    this.names.push(name)
    this.domains.push(fromValues(vals))
    return id
  }

  /** Create a 0/1 variable. */
  newBool(name: string): number {
    return this.newVar(name, 0, 1)
  }

  /** Fix a variable's initial domain to a single value. */
  fix(v: number, val: number): void {
    this.domains[v] = assign(this.domains[v], val)
  }

  /** Restrict a variable's initial domain to [lo, hi]. */
  bound(v: number, lo: number, hi: number): void {
    this.domains[v] = range(lo, hi)
  }

  addAllDifferent(vars: number[], level?: AllDiffLevel): void {
    this.allDiffScopes.push(vars.slice())
    this.propagators.push(allDifferent(vars, level ?? this.allDiffLevel))
    const scope = vars.slice()
    this.checks.push((a) => {
      const seen = new Set<number>()
      for (const v of scope) {
        if (seen.has(a[v])) return false
        seen.add(a[v])
      }
      return true
    })
  }

  /** Post `Σ coeffs[i]·vars[i]  op  c`. */
  addLinear(coeffs: number[], vars: number[], op: Op, c: number): void {
    // Merge duplicate variables (sum their coefficients) and drop zeros, so the
    // bounds propagator sees each variable exactly once with its net coefficient.
    const merged = new Map<number, number>()
    const order: number[] = []
    for (let i = 0; i < vars.length; i++) {
      if (!merged.has(vars[i])) order.push(vars[i])
      merged.set(vars[i], (merged.get(vars[i]) ?? 0) + coeffs[i])
    }
    const cs: number[] = []
    const vs: number[] = []
    for (const v of order) {
      const a = merged.get(v)!
      if (a !== 0) {
        cs.push(a)
        vs.push(v)
      }
    }
    // Independent checker over the *original* (unfiltered) terms.
    const ocoeffs = coeffs.slice()
    const ovars = vars.slice()
    this.checks.push((a) => {
      let s = 0
      for (let i = 0; i < ovars.length; i++) s += ocoeffs[i] * a[ovars[i]]
      return op === '<=' ? s <= c : op === '>=' ? s >= c : op === '=' ? s === c : op === '<' ? s < c : s > c
    })

    if (vs.length === 0) {
      // Constant relation: post a trivially-failing propagator if violated.
      const ok =
        op === '<=' ? 0 <= c : op === '>=' ? 0 >= c : op === '=' ? 0 === c : op === '<' ? 0 < c : 0 > c
      if (!ok) this.propagators.push({ scope: [], label: 'infeasible constant', propagate: (s) => s.signalFail() })
      return
    }
    const neg = cs.map((a) => -a)
    switch (op) {
      case '<=':
        this.propagators.push(linearLe(cs, vs, c))
        break
      case '>=':
        this.propagators.push(linearLe(neg, vs, -c))
        break
      case '<':
        this.propagators.push(linearLe(cs, vs, c - 1))
        break
      case '>':
        this.propagators.push(linearLe(neg, vs, -(c + 1)))
        break
      case '=':
        this.propagators.push(linearLe(cs, vs, c))
        this.propagators.push(linearLe(neg, vs, -c))
        break
    }
  }

  /** Convenience: `Σ vars  op  c` (all coefficients 1). */
  addSum(vars: number[], op: Op, c: number): void {
    this.addLinear(vars.map(() => 1), vars, op, c)
  }

  /** Post `a ≠ b + k`. */
  addNotEqual(a: number, b: number, k = 0): void {
    this.propagators.push(notEqual(a, b, k))
    this.checks.push((asg) => asg[a] !== asg[b] + k)
  }

  /** Post `a = b` (as a linear equality). */
  addEqual(a: number, b: number): void {
    this.addLinear([1, -1], [a, b], '=', 0)
  }

  /** Post `y = arr[idx]` for a constant array. */
  addElement(y: number, idx: number, arr: number[]): void {
    this.propagators.push(element(y, idx, arr))
    const a2 = arr.slice()
    this.checks.push((a) => {
      const i = a[idx]
      return i >= 0 && i < a2.length && a[y] === a2[i]
    })
  }

  /** Post a positive table constraint. */
  addTable(vars: number[], tuples: number[][]): void {
    this.propagators.push(table(vars, tuples))
    const scope = vars.slice()
    const ts = tuples.map((t) => t.slice())
    this.checks.push((a) =>
      ts.some((t) => {
        for (let p = 0; p < scope.length; p++) if (a[scope[p]] !== t[p]) return false
        return true
      }),
    )
  }

  /** True iff a full assignment satisfies every posted constraint (checker path). */
  satisfies(a: number[]): boolean {
    for (const c of this.checks) if (!c(a)) return false
    return true
  }

  get n(): number {
    return this.domains.length
  }
}
