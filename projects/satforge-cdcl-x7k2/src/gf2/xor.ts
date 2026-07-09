// XOR-CNF: the model that lets parity constraints and ordinary clauses live in
// one problem, plus the bridges that make the whole thing cross-checkable.
//
//   • an XOR constraint is `⊕ vars = rhs` over 1-based DIMACS variables;
//   • `xorToClauses` expands one XOR into its 2^(k−1) equivalent CNF clauses,
//     so any XOR problem can be handed to the project's *clausal* CDCL / #SAT
//     engines and answered a second, independent way;
//   • `recoverXors` runs the expansion *backwards* — it sniffs a plain CNF for
//     the tell-tale 2^(k−1)-clause parity gadgets and rebuilds the XOR that
//     produced them (exactly what real solvers do to resurrect parity structure
//     a Tseitin encoding buried). Expand-then-recover is an exact round-trip.
//
// Extended-DIMACS convention (CryptoMiniSat-style): a line `x ℓ₁ … ℓ_k 0`
// asserts the XOR of the *literals* is 1 (odd parity). A negative literal
// ¬v = 1 ⊕ v, so it flips the right-hand side; repeated variables cancel
// (x ⊕ x = 0). `normalizeXorLits` folds all of that into a canonical
// `{ vars (distinct, sorted, positive), rhs }`.

import type { CNF } from '../sat/cnf'
import type { Gf2System } from './gf2'

/** A parity constraint `⊕ vars = rhs` over 1-based variables. */
export interface XorClause {
  vars: number[]
  rhs: number
}

/** A combined problem: ordinary CNF clauses *and* XOR constraints. */
export interface XorCnf {
  numVars: number
  clauses: number[][]
  xors: XorClause[]
  comments?: string[]
}

/**
 * Fold a list of signed literals (a CryptoMiniSat `x`-clause, whose literals
 * XOR to 1) into a canonical `{ vars, rhs }`. Duplicate variables cancel and
 * each negated literal flips the right-hand side.
 */
export function normalizeXorLits(lits: number[]): XorClause {
  const parityOf = new Map<number, number>() // var -> count mod 2
  let rhs = 1 // the literals XOR to 1
  for (const l of lits) {
    if (l === 0) continue
    const v = Math.abs(l)
    if (l < 0) rhs ^= 1 // ¬v = 1 ⊕ v
    parityOf.set(v, ((parityOf.get(v) ?? 0) + 1) & 1)
  }
  const vars: number[] = []
  for (const [v, p] of parityOf) if (p === 1) vars.push(v)
  vars.sort((a, b) => a - b)
  return { vars, rhs: rhs & 1 }
}

/** Build a canonical XOR from bare variables and an explicit rhs. */
export function makeXor(vars: number[], rhs: number): XorClause {
  const parityOf = new Map<number, number>()
  for (const v of vars) parityOf.set(v, ((parityOf.get(v) ?? 0) + 1) & 1)
  const out: number[] = []
  for (const [v, p] of parityOf) if (p === 1) out.push(v)
  out.sort((a, b) => a - b)
  return { vars: out, rhs: rhs & 1 }
}

/**
 * Expand one XOR into the 2^(k−1) CNF clauses it is equivalent to. An
 * assignment violates `⊕ vars = rhs` exactly when the variables' parity is
 * `1 ⊕ rhs`; each such bad assignment is excluded by one clause (the literal
 * for a variable is negative iff the assignment sets it true). A degenerate
 * XOR of no variables is either trivially true (rhs 0 → no clauses) or the
 * empty clause (rhs 1 → unsatisfiable).
 */
export function xorToClauses(x: XorClause): number[][] {
  const k = x.vars.length
  if (k === 0) return x.rhs === 1 ? [[]] : []
  const bad = 1 ^ (x.rhs & 1)
  const out: number[][] = []
  for (let mask = 0; mask < 1 << k; mask++) {
    let parity = 0
    for (let i = 0; i < k; i++) if ((mask >> i) & 1) parity ^= 1
    if (parity !== bad) continue
    const clause: number[] = []
    for (let i = 0; i < k; i++) {
      const set = (mask >> i) & 1
      clause.push(set ? -x.vars[i] : x.vars[i])
    }
    out.push(clause)
  }
  return out
}

/** All XORs of a problem, expanded and unioned with its ordinary clauses. */
export function xorCnfToCnf(p: XorCnf): CNF {
  const clauses = p.clauses.map((c) => c.slice())
  for (const x of p.xors) for (const c of xorToClauses(x)) clauses.push(c)
  return { numVars: p.numVars, clauses, comments: p.comments }
}

/** Just the XOR part of a problem as a 0-based 𝔽₂ system. */
export function xorSystem(p: XorCnf): Gf2System {
  return {
    numVars: p.numVars,
    rows: p.xors.map((x) => {
      let mask = 0n
      for (const v of x.vars) mask |= 1n << BigInt(v - 1)
      return { mask, rhs: x.rhs & 1 }
    }),
  }
}

/** Convert a bare XOR list into a 0-based 𝔽₂ system in `numVars` variables. */
export function xorsToSystem(xors: XorClause[], numVars: number): Gf2System {
  return {
    numVars,
    rows: xors.map((x) => {
      let mask = 0n
      for (const v of x.vars) mask |= 1n << BigInt(v - 1)
      return { mask, rhs: x.rhs & 1 }
    }),
  }
}

const sig = (vars: number[]) => vars.join(',')

export interface RecoverResult {
  /** XORs rebuilt from the clause gadgets. */
  xors: XorClause[]
  /** Clauses that were *not* consumed by any recovered XOR. */
  remaining: number[][]
  /** How many clauses were folded into XORs. */
  consumed: number
}

/**
 * Recover XOR constraints hiding inside a plain CNF. A full `⊕ vars = rhs`
 * gadget is the set of all 2^(k−1) clauses over exactly `vars` whose count of
 * negative literals shares a fixed parity `p`; that parity pins `rhs = 1 ⊕ p`.
 * We bucket the clauses by their (sorted, deduped, tautology-free) variable
 * set, and for each bucket of the right size test whether one parity class is
 * present in full. Widths above `maxK` are skipped (2^(k−1) grows fast).
 */
export function recoverXors(cnf: CNF, maxK = 12): RecoverResult {
  // Bucket by variable set; remember which original clause indices landed where.
  const buckets = new Map<string, { vars: number[]; idx: number[]; clauses: number[][] }>()
  const clean: (number[] | null)[] = cnf.clauses.map((c) => {
    const seen = new Set<number>()
    for (const l of c) {
      if (seen.has(-l)) return null // tautology — never part of an XOR gadget
      seen.add(l)
    }
    return c
  })
  for (let i = 0; i < cnf.clauses.length; i++) {
    const c = clean[i]
    if (!c) continue
    const vars = [...new Set(c.map((l) => Math.abs(l)))].sort((a, b) => a - b)
    if (vars.length === 0 || vars.length > maxK) continue
    if (vars.length !== c.length) continue // repeated variable ⇒ not a plain gadget clause
    const key = sig(vars)
    let b = buckets.get(key)
    if (!b) buckets.set(key, (b = { vars, idx: [], clauses: [] }))
    b.idx.push(i)
    b.clauses.push(c)
  }
  const xors: XorClause[] = []
  const consumedIdx = new Set<number>()
  for (const b of buckets.values()) {
    const k = b.vars.length
    const need = 1 << (k - 1)
    // Split this bucket's clauses by negated-literal-count parity, dedup by pattern.
    const byParity: Array<Map<number, number>> = [new Map(), new Map()] // pattern -> clause idx
    for (let j = 0; j < b.clauses.length; j++) {
      const c = b.clauses[j]
      let pattern = 0
      let negs = 0
      for (const l of c) {
        const pos = b.vars.indexOf(Math.abs(l))
        if (l < 0) {
          pattern |= 1 << pos
          negs++
        }
      }
      const par = negs & 1
      if (!byParity[par].has(pattern)) byParity[par].set(pattern, b.idx[j])
    }
    for (let par = 0; par < 2; par++) {
      if (byParity[par].size === need) {
        xors.push({ vars: b.vars.slice(), rhs: 1 ^ par })
        for (const idx of byParity[par].values()) consumedIdx.add(idx)
      }
    }
  }
  const remaining: number[][] = []
  for (let i = 0; i < cnf.clauses.length; i++) if (!consumedIdx.has(i)) remaining.push(cnf.clauses[i])
  return { xors, remaining, consumed: consumedIdx.size }
}

/** Verify a boolean model (1-based) against a set of XOR constraints. */
export function verifyXors(xors: XorClause[], model: boolean[]): { ok: boolean; failing: number } {
  for (let i = 0; i < xors.length; i++) {
    let parity = 0
    for (const v of xors[i].vars) if (model[v]) parity ^= 1
    if (parity !== (xors[i].rhs & 1)) return { ok: false, failing: i }
  }
  return { ok: true, failing: -1 }
}
