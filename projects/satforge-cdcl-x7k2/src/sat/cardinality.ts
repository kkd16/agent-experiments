// Pseudo-Boolean / cardinality encodings, from scratch.
//
// The workhorse is the **Generalized Totalizer Encoding (GTE)** of Joshi, Martins &
// Manquinho (SAT 2015): a balanced binary tree whose internal nodes carry an output
// variable for every *achievable* partial weighted sum of the leaves beneath them. Those
// outputs let a downstream solver bound a weighted sum  Σ wᵢ·xᵢ ≤ K  by forbidding every
// root output whose weight exceeds K.
//
// Semantics we rely on (and prove in the test harness): for any assignment, the set of
// root output variables *forced true* is exactly the set of subset-sums achievable from
// the currently-true leaves. In particular the full true-weight S is always among them, so
// forbidding all outputs with weight > K rejects exactly the assignments that overspend —
// and never constrains an assignment whose true weight is ≤ K.
//
// With unit weights this degenerates to the classic Totalizer at-most-k cardinality
// encoding. Bounds tighten *incrementally*: lowering K only forbids more (already-built)
// outputs, so a solver can ratchet a budget down without ever re-encoding.

/** A place to allocate fresh variables and append clauses (DIMACS literals). */
export interface ClauseSink {
  /** Allocate and return a fresh 1-based variable id. */
  fresh(): number
  /** Append a clause (a disjunction of signed DIMACS literals). */
  add(lits: number[]): void
}

/** A concrete {@link ClauseSink} that grows on top of an existing variable count. */
export class PBBuilder implements ClauseSink {
  clauses: number[][] = []
  numVars: number
  constructor(numVars: number) {
    this.numVars = numVars
  }
  fresh(): number {
    return ++this.numVars
  }
  add(lits: number[]): void {
    this.clauses.push(lits.slice())
  }
}

export interface GteResult {
  /** Map from an achievable weighted sum `w` (> 0) at the root to its output variable.
   *  `outputs.get(w)` is forced true whenever a subset of leaves summing to exactly `w`
   *  is all true; in particular the full true-weight always forces its own output. */
  outputs: Map<number, number>
  /** Root output (weight, var) pairs, ascending by weight. */
  sorted: { weight: number; varId: number }[]
  /** Total weight of all terms (the maximum possible sum). */
  total: number
}

interface GteNode {
  // Map from an achievable partial sum (> 0) to the literal that represents it.
  // For a leaf this is { weight -> the leaf literal }; for an internal node a fresh var.
  outs: Map<number, number>
  total: number
}

/**
 * Encode the weighted sum of `terms` ( Σ weightᵢ · [litᵢ is true] ) into `sink`, returning
 * the root output variables. Terms with non-positive weight are ignored. Literals may be
 * any signed DIMACS literal (so you can sum negated variables too).
 */
export function encodeGTE(sink: ClauseSink, terms: { lit: number; weight: number }[]): GteResult {
  const leaves: GteNode[] = []
  let total = 0
  for (const { lit, weight } of terms) {
    if (weight <= 0 || lit === 0) continue
    total += weight
    leaves.push({ outs: new Map([[weight, lit]]), total: weight })
  }
  if (leaves.length === 0) {
    return { outputs: new Map(), sorted: [], total: 0 }
  }

  // Build a balanced tree by repeatedly merging adjacent nodes (bottom-up), which keeps
  // depth at ⌈log₂ n⌉ and total output count modest for small weighted instances.
  let level = leaves
  while (level.length > 1) {
    const next: GteNode[] = []
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(mergeNodes(sink, level[i], level[i + 1]))
      else next.push(level[i])
    }
    level = next
  }
  const root = level[0]
  const sorted = [...root.outs.entries()]
    .map(([weight, varId]) => ({ weight, varId }))
    .sort((a, b) => a.weight - b.weight)
  return { outputs: root.outs, sorted, total }
}

function mergeNodes(sink: ClauseSink, left: GteNode, right: GteNode): GteNode {
  const outs = new Map<number, number>()
  const total = left.total + right.total
  // Allocate (lazily) an output var for an achievable combined sum.
  const nodeVar = (w: number): number => {
    let v = outs.get(w)
    if (v === undefined) {
      v = sink.fresh()
      outs.set(w, v)
    }
    return v
  }
  // Left-alone and right-alone contributions: la → reaches `a`, rb → reaches `b`.
  for (const [a, la] of left.outs) sink.add([-la, nodeVar(a)])
  for (const [b, rb] of right.outs) sink.add([-rb, nodeVar(b)])
  // Joint contributions: both reach a+b.
  for (const [a, la] of left.outs) {
    for (const [b, rb] of right.outs) {
      sink.add([-la, -rb, nodeVar(a + b)])
    }
  }
  return { outs, total }
}

/**
 * Return the DIMACS literals that, asserted, bound the encoded sum to ≤ K: every root
 * output with weight > K must be false. (An empty list means the bound is trivially
 * satisfiable — every assignment already spends ≤ K.) These can be added as unit clauses
 * or, for incremental tightening, passed as *assumptions*.
 */
export function atMostBound(gte: GteResult, k: number): number[] {
  const lits: number[] = []
  for (const { weight, varId } of gte.sorted) {
    if (weight > k) lits.push(-varId)
  }
  return lits
}

/**
 * Encode an at-most-k *cardinality* constraint ( Σ [litᵢ] ≤ k ) directly into `sink`
 * (unit weights). Convenience wrapper used by encoders that need plain counting.
 */
export function encodeAtMostK(sink: ClauseSink, lits: number[], k: number): void {
  if (k < 0) {
    // Infeasible: forbid everything by forcing each literal false is wrong; instead add the
    // empty clause is too blunt. k<0 can't be satisfied if any literal exists — emit ⊥.
    if (lits.length > 0) sink.add([])
    return
  }
  if (k >= lits.length) return // trivially satisfied
  const gte = encodeGTE(
    sink,
    lits.map((lit) => ({ lit, weight: 1 })),
  )
  for (const lit of atMostBound(gte, k)) sink.add([lit])
}
