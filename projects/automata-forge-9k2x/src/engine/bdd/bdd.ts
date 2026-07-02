// A from-scratch **Reduced Ordered Binary Decision Diagram** (ROBDD) engine — the data structure at
// the heart of *symbolic* model checking (the technique inside SMV / NuSMV that pushed hardware
// verification from thousands of states to 10²⁰ and beyond).
//
// A BDD represents a Boolean function f(x₀,…,x_{n-1}) as a DAG. Each internal node tests one variable
// and branches on a `lo` edge (the variable is 0) and a `hi` edge (the variable is 1); the two sinks
// are the constants ⊥ and ⊤. Two invariants make the representation *canonical* — equal functions are
// the **same node id**, so equivalence is a pointer comparison:
//
//   • **Ordered** — every path from the root reads the variables in one fixed order (`vars`).
//   • **Reduced** — (1) no node has `lo === hi` (a useless test is skipped), and (2) no two nodes are
//     structurally identical (they are *hash-consed* through the `unique` table).
//
// Every operation is the classic Shannon-expansion recursion `f = x·f|_{x=1} + x̄·f|_{x=0}`, memoized
// in a *computed table* so the cost is polynomial in the DAG size rather than exponential in n. The
// whole thing is pure integer bookkeeping — no dependencies, fully deterministic, and small enough to
// verify against brute-force truth tables (see `selftest.ts`).

/** A node handle. `0` is the ⊥ (false) sink, `1` is the ⊤ (true) sink; everything ≥ 2 is a real node. */
export type BddId = number

export const FALSE: BddId = 0
export const TRUE: BddId = 1

interface BddNode {
  v: number // variable *level* (index into `vars`)
  lo: BddId // successor when the variable is 0
  hi: BddId // successor when the variable is 1
}

/**
 * An ROBDD manager over a fixed, ordered set of variables. All BDDs built through one manager share
 * its node pool, so structural equality is `id` equality and every algebraic law (idempotence,
 * De Morgan, …) falls out for free.
 */
export class Bdd {
  /** Variable names in decision order; index = level. Lower level = tested nearer the root. */
  readonly vars: string[]
  private nodes: BddNode[] = [
    { v: -1, lo: 0, hi: 0 }, // slot 0 — the ⊥ sink (fields unused)
    { v: -1, lo: 1, hi: 1 }, // slot 1 — the ⊤ sink
  ]
  private unique = new Map<string, BddId>() // `${v},${lo},${hi}` → id  (hash-consing)
  // Memo tables — pure functions of node ids, so they stay valid for the manager's whole life.
  private notMemo = new Map<BddId, BddId>()
  private iteMemo = new Map<string, BddId>()
  private cofMemo = new Map<string, BddId>()

  constructor(vars: string[]) {
    this.vars = vars.slice()
  }

  get varCount(): number {
    return this.vars.length
  }
  /** Total internal nodes ever allocated (a rough gauge of engine activity). */
  get poolSize(): number {
    return this.nodes.length - 2
  }

  isTerminal(f: BddId): boolean {
    return f === FALSE || f === TRUE
  }
  /** The variable *level* a node tests; terminals sit *below* every variable (`level = varCount`). */
  levelOf(f: BddId): number {
    return f < 2 ? this.vars.length : this.nodes[f].v
  }
  varName(f: BddId): string {
    return this.vars[this.nodes[f].v]
  }
  lo(f: BddId): BddId {
    return this.nodes[f].lo
  }
  hi(f: BddId): BddId {
    return this.nodes[f].hi
  }

  /**
   * The reduced make-node: return the canonical id for `(v ? hi : lo)`. Applies both reduction rules —
   * a redundant test (`lo === hi`) collapses to the child, and structurally identical nodes are shared.
   */
  private mk(v: number, lo: BddId, hi: BddId): BddId {
    if (lo === hi) return lo // reduction rule 1: skip a variable that doesn't matter
    const key = v + ',' + lo + ',' + hi
    const found = this.unique.get(key)
    if (found !== undefined) return found // reduction rule 2: share an existing node
    const id = this.nodes.length
    this.nodes.push({ v, lo, hi })
    this.unique.set(key, id)
    return id
  }

  // --- variable projections ------------------------------------------------

  /** The BDD for the single variable at level `i` (true exactly when xᵢ = 1). */
  ithVar(i: number): BddId {
    return this.mk(i, FALSE, TRUE)
  }
  /** The BDD for the negated variable at level `i` (true exactly when xᵢ = 0). */
  nithVar(i: number): BddId {
    return this.mk(i, TRUE, FALSE)
  }
  constant(b: boolean): BddId {
    return b ? TRUE : FALSE
  }

  // --- the core operations -------------------------------------------------

  /** Logical negation. */
  not(f: BddId): BddId {
    if (f === FALSE) return TRUE
    if (f === TRUE) return FALSE
    const memo = this.notMemo.get(f)
    if (memo !== undefined) return memo
    const n = this.nodes[f]
    const r = this.mk(n.v, this.not(n.lo), this.not(n.hi))
    this.notMemo.set(f, r)
    return r
  }

  /**
   * The universal ternary connective `if-then-else`: `ite(f,g,h) = (f ∧ g) ∨ (¬f ∧ h)`. Every binary
   * Boolean operation is one `ite`, so this is the single recursion the whole algebra rests on.
   */
  ite(f: BddId, g: BddId, h: BddId): BddId {
    // Terminal & trivial simplifications.
    if (f === TRUE) return g
    if (f === FALSE) return h
    if (g === h) return g
    if (g === TRUE && h === FALSE) return f
    if (g === FALSE && h === TRUE) return this.not(f)
    const key = f + '?' + g + ':' + h
    const memo = this.iteMemo.get(key)
    if (memo !== undefined) return memo
    // Expand on the top variable among the three arguments.
    const v = Math.min(this.levelOf(f), this.levelOf(g), this.levelOf(h))
    const fl = this.cofactorTop(f, v, false)
    const fh = this.cofactorTop(f, v, true)
    const gl = this.cofactorTop(g, v, false)
    const gh = this.cofactorTop(g, v, true)
    const hl = this.cofactorTop(h, v, false)
    const hh = this.cofactorTop(h, v, true)
    const r = this.mk(v, this.ite(fl, gl, hl), this.ite(fh, gh, hh))
    this.iteMemo.set(key, r)
    return r
  }

  /** The child of `f` down the `val` edge *if* `f` tests level `v`, else `f` unchanged (it skips v). */
  private cofactorTop(f: BddId, v: number, val: boolean): BddId {
    if (f < 2 || this.nodes[f].v !== v) return f
    return val ? this.nodes[f].hi : this.nodes[f].lo
  }

  and(f: BddId, g: BddId): BddId {
    return this.ite(f, g, FALSE)
  }
  or(f: BddId, g: BddId): BddId {
    return this.ite(f, TRUE, g)
  }
  xor(f: BddId, g: BddId): BddId {
    return this.ite(f, this.not(g), g)
  }
  nand(f: BddId, g: BddId): BddId {
    return this.not(this.and(f, g))
  }
  nor(f: BddId, g: BddId): BddId {
    return this.not(this.or(f, g))
  }
  /** Material implication f → g. */
  imp(f: BddId, g: BddId): BddId {
    return this.ite(f, g, TRUE)
  }
  /** Bi-implication f ↔ g. */
  iff(f: BddId, g: BddId): BddId {
    return this.ite(f, g, this.not(g))
  }

  /** Fold a list with `and` (empty ⇒ ⊤). */
  andAll(fs: BddId[]): BddId {
    return fs.reduce((a, b) => this.and(a, b), TRUE)
  }
  /** Fold a list with `or` (empty ⇒ ⊥). */
  orAll(fs: BddId[]): BddId {
    return fs.reduce((a, b) => this.or(a, b), FALSE)
  }

  /**
   * The **cofactor** (restriction) `f|_{xᵢ = val}` — substitute a constant for one variable. This is
   * how quantification and variable renaming are built.
   */
  restrict(f: BddId, i: number, val: boolean): BddId {
    if (f < 2) return f
    const key = f + '|' + i + '=' + (val ? 1 : 0)
    const memo = this.cofMemo.get(key)
    if (memo !== undefined) return memo
    const n = this.nodes[f]
    let r: BddId
    if (n.v > i) r = f // f never tests xᵢ below this point
    else if (n.v === i) r = val ? n.hi : n.lo
    else r = this.mk(n.v, this.restrict(n.lo, i, val), this.restrict(n.hi, i, val))
    this.cofMemo.set(key, r)
    return r
  }

  /** Substitute the *variable* at level `i` by an arbitrary BDD `g`: `f[xᵢ := g]`. */
  compose(f: BddId, i: number, g: BddId): BddId {
    return this.ite(g, this.restrict(f, i, true), this.restrict(f, i, false))
  }

  /** Existential quantification ∃xᵢ. f = f|₀ ∨ f|₁. */
  existsVar(f: BddId, i: number): BddId {
    return this.or(this.restrict(f, i, false), this.restrict(f, i, true))
  }
  /** Universal quantification ∀xᵢ. f = f|₀ ∧ f|₁. */
  forallVar(f: BddId, i: number): BddId {
    return this.and(this.restrict(f, i, false), this.restrict(f, i, true))
  }
  /** ∃ over a set of variable levels (order-independent). */
  exists(f: BddId, is: Iterable<number>): BddId {
    let r = f
    for (const i of is) r = this.existsVar(r, i)
    return r
  }
  /** ∀ over a set of variable levels. */
  forall(f: BddId, is: Iterable<number>): BddId {
    let r = f
    for (const i of is) r = this.forallVar(r, i)
    return r
  }

  /**
   * Simultaneously rename variables by a level→level map. Correct whenever the *image* levels are
   * disjoint from the *domain* levels (the only case used here: current-state ↔ next-state bits),
   * because then substituting the domain variables one at a time never clobbers a pending rename.
   */
  rename(f: BddId, map: Map<number, number>): BddId {
    let r = f
    for (const [from, to] of map) r = this.compose(r, from, this.ithVar(to))
    return r
  }

  // --- extraction & measurement -------------------------------------------

  /** The set of variable *levels* the function actually depends on. */
  support(f: BddId): Set<number> {
    const out = new Set<number>()
    const seen = new Set<BddId>()
    const walk = (x: BddId) => {
      if (x < 2 || seen.has(x)) return
      seen.add(x)
      out.add(this.nodes[x].v)
      walk(this.nodes[x].lo)
      walk(this.nodes[x].hi)
    }
    walk(f)
    return out
  }

  /** The number of internal nodes reachable from any of `roots` (the DAG size — the true cost gauge). */
  nodeCount(roots: BddId | BddId[]): number {
    const seen = new Set<BddId>()
    const walk = (x: BddId) => {
      if (x < 2 || seen.has(x)) return
      seen.add(x)
      walk(this.nodes[x].lo)
      walk(this.nodes[x].hi)
    }
    for (const r of Array.isArray(roots) ? roots : [roots]) walk(r)
    return seen.size
  }

  /**
   * Count satisfying assignments over `nVars` variables (levels 0…nVars-1). Skipped variables on an
   * edge are free, contributing a factor of 2 each — so this is exact, not an estimate.
   */
  satCount(f: BddId, nVars: number): number {
    const memo = new Map<BddId, number>()
    // Treat the sinks as sitting just below variable `nVars` (so the caller controls the space size).
    const lvl = (x: BddId) => (x < 2 ? nVars : this.nodes[x].v)
    const below = (x: BddId): number => {
      if (x === FALSE) return 0
      if (x === TRUE) return 1
      const m = memo.get(x)
      if (m !== undefined) return m
      const n = this.nodes[x]
      const loGap = lvl(n.lo) - n.v - 1
      const hiGap = lvl(n.hi) - n.v - 1
      const r = below(n.lo) * 2 ** loGap + below(n.hi) * 2 ** hiGap
      memo.set(x, r)
      return r
    }
    return below(f) * 2 ** lvl(f)
  }

  /**
   * One satisfying assignment as a full bit-vector over `nVars` variables, or `null` if `f` is ⊥.
   * Variables the function doesn't constrain are filled with 0 (a concrete, replayable witness).
   */
  anySat(f: BddId, nVars: number): boolean[] | null {
    if (f === FALSE) return null
    const bits = new Array<boolean>(nVars).fill(false)
    let cur = f
    while (cur !== TRUE) {
      const n = this.nodes[cur]
      // Prefer the hi edge when it can still reach ⊤; otherwise take lo.
      if (n.hi !== FALSE) {
        bits[n.v] = true
        cur = n.hi
      } else {
        bits[n.v] = false
        cur = n.lo
      }
    }
    return bits
  }

  /** The reachable node ids (excluding sinks), for rendering the diagram. */
  reachable(roots: BddId | BddId[]): BddId[] {
    const seen = new Set<BddId>()
    const walk = (x: BddId) => {
      if (x < 2 || seen.has(x)) return
      seen.add(x)
      walk(this.nodes[x].lo)
      walk(this.nodes[x].hi)
    }
    for (const r of Array.isArray(roots) ? roots : [roots]) walk(r)
    return [...seen]
  }
}
