// A from-scratch Reduced Ordered Binary Decision Diagram (ROBDD) package.
//
// A BDD is the *canonical* form of a Boolean function: fix a variable order and
// apply two reduction rules — (1) never create a node whose two children are
// identical (a redundant test), and (2) share structurally identical subgraphs —
// and every Boolean function has exactly ONE representation. That is the whole
// magic: two formulas are equivalent iff they compile to the *same node*, so
// equivalence, tautology and satisfiability all collapse to a pointer compare.
//
// The engine is built around one universal operator, Shannon's `ite(f, g, h)`
// ("if f then g else h"), memoized on its three arguments. Every Boolean
// connective — and, or, xor, implication, quantification, composition — is a
// thin wrapper over `ite`, so the apply algorithm is written once and shared.
//
// Nodes are interned in a unique table (so rule 2 holds by construction) and
// referenced by a small integer id. Terminals are fixed: 0 is FALSE, 1 is TRUE.
// Variables are 0-based indices `0 .. numVars-1`; their *order* (which variable
// sits near the root) is a separate permutation, so the same variable can be
// reordered without renaming it — the key to dynamic reordering (see reorder.ts).

export type NodeId = number

/** The two terminal nodes. Every BDD bottoms out here. */
export const BDD_FALSE: NodeId = 0
export const BDD_TRUE: NodeId = 1

/** One satisfying cube: a partial assignment (variables not listed are don't-cares). */
export interface Cube {
  /** Map from variable index to its forced value along this path to TRUE. */
  assign: Map<number, boolean>
}

export class Bdd {
  readonly numVars: number

  /** order[level] = variable sitting at that level (0 = nearest the root). */
  order: number[]
  /** pos[variable] = its level. Inverse of `order`. */
  pos: number[]

  // Node tables, indexed by node id. Terminals occupy ids 0 and 1.
  private vv: number[] // variable of the node (numVars for terminals — "below" all vars)
  private lo: NodeId[] // child taken when the node's variable is FALSE
  private hi: NodeId[] // child taken when the node's variable is TRUE

  private unique = new Map<string, NodeId>()
  private iteMemo = new Map<string, NodeId>()

  constructor(numVars: number, order?: number[]) {
    this.numVars = numVars
    this.order = order ? order.slice() : Array.from({ length: numVars }, (_, i) => i)
    this.pos = new Array<number>(numVars)
    for (let lvl = 0; lvl < numVars; lvl++) this.pos[this.order[lvl]] = lvl
    // Two terminal nodes. Their "variable" is numVars, a sentinel level strictly
    // below every real variable (whose levels are 0..numVars-1).
    this.vv = [numVars, numVars]
    this.lo = [BDD_FALSE, BDD_TRUE]
    this.hi = [BDD_FALSE, BDD_TRUE]
  }

  // ---- accessors -----------------------------------------------------------

  isTerminal(f: NodeId): boolean {
    return f === BDD_FALSE || f === BDD_TRUE
  }
  /** The variable tested at node `f` (or numVars if `f` is a terminal). */
  varOf(f: NodeId): number {
    return this.vv[f]
  }
  low(f: NodeId): NodeId {
    return this.lo[f]
  }
  high(f: NodeId): NodeId {
    return this.hi[f]
  }
  /** Level of a node in the current order; terminals are at level numVars. */
  levelOf(f: NodeId): number {
    return f < 2 ? this.numVars : this.pos[this.vv[f]]
  }
  /** Total number of distinct nodes ever allocated (including dead ones). */
  get allocated(): number {
    return this.vv.length
  }

  // ---- the unique-table constructor (enforces the two reduction rules) ------

  /**
   * Make (or look up) the node testing variable `v` with the given children.
   * Rule 1: a redundant test (`lo === hi`) is elided. Rule 2: identical nodes
   * are shared via the unique table. The caller must ensure `v` is ABOVE both
   * children in the current order — every routine here recurses top-down, so it
   * is. Returns a canonical id.
   */
  mk(v: number, lo: NodeId, hi: NodeId): NodeId {
    if (lo === hi) return lo // rule 1: no decision to make
    const key = v + ':' + lo + ':' + hi
    const found = this.unique.get(key)
    if (found !== undefined) return found // rule 2: share
    const id = this.vv.length
    this.vv.push(v)
    this.lo.push(lo)
    this.hi.push(hi)
    this.unique.set(key, id)
    return id
  }

  /** The BDD for a single positive literal `xv`. */
  ithVar(v: number): NodeId {
    return this.mk(v, BDD_FALSE, BDD_TRUE)
  }
  /** The BDD for a single negative literal `¬xv`. */
  nithVar(v: number): NodeId {
    return this.mk(v, BDD_TRUE, BDD_FALSE)
  }
  /** The BDD for a signed DIMACS-style literal (`+v` ⇒ x_{v-1}, `-v` ⇒ ¬x_{v-1}). */
  literal(lit: number): NodeId {
    const v = Math.abs(lit) - 1
    return lit > 0 ? this.ithVar(v) : this.nithVar(v)
  }

  // ---- the universal apply: if-then-else -----------------------------------

  /**
   * `ite(f, g, h)` = "if f then g else h". This single operator computes every
   * Boolean connective. It recurses on the topmost variable `v` shared by the
   * three operands, splitting each into its v=1 and v=0 cofactors, and rebuilds
   * with `mk`. Memoization on (f,g,h) makes the whole thing run in time
   * proportional to the product of the operand sizes, not exponential.
   */
  ite(f: NodeId, g: NodeId, h: NodeId): NodeId {
    // terminal & trivial simplifications
    if (f === BDD_TRUE) return g
    if (f === BDD_FALSE) return h
    if (g === h) return g
    if (g === BDD_TRUE && h === BDD_FALSE) return f // ite(f,1,0) = f

    const key = f + '|' + g + '|' + h
    const memo = this.iteMemo.get(key)
    if (memo !== undefined) return memo

    // Split on the topmost variable among the three operands.
    const lf = this.levelOf(f)
    const lg = this.levelOf(g)
    const lh = this.levelOf(h)
    const top = Math.min(lf, lg, lh)
    const v = this.order[top]

    const f1 = lf === top ? this.hi[f] : f
    const f0 = lf === top ? this.lo[f] : f
    const g1 = lg === top ? this.hi[g] : g
    const g0 = lg === top ? this.lo[g] : g
    const h1 = lh === top ? this.hi[h] : h
    const h0 = lh === top ? this.lo[h] : h

    const hiBranch = this.ite(f1, g1, h1)
    const loBranch = this.ite(f0, g0, h0)
    const r = this.mk(v, loBranch, hiBranch)
    this.iteMemo.set(key, r)
    return r
  }

  // ---- Boolean connectives (all thin wrappers over ite) --------------------

  not(f: NodeId): NodeId {
    return this.ite(f, BDD_FALSE, BDD_TRUE)
  }
  and(f: NodeId, g: NodeId): NodeId {
    return this.ite(f, g, BDD_FALSE)
  }
  or(f: NodeId, g: NodeId): NodeId {
    return this.ite(f, BDD_TRUE, g)
  }
  xor(f: NodeId, g: NodeId): NodeId {
    return this.ite(f, this.not(g), g)
  }
  nand(f: NodeId, g: NodeId): NodeId {
    return this.not(this.and(f, g))
  }
  nor(f: NodeId, g: NodeId): NodeId {
    return this.not(this.or(f, g))
  }
  implies(f: NodeId, g: NodeId): NodeId {
    return this.ite(f, g, BDD_TRUE)
  }
  iff(f: NodeId, g: NodeId): NodeId {
    return this.ite(f, g, this.not(g))
  }

  /** Conjoin / disjoin a whole list (empty ⇒ TRUE / FALSE respectively). */
  andAll(fs: NodeId[]): NodeId {
    let acc: NodeId = BDD_TRUE
    for (const f of fs) acc = this.and(acc, f)
    return acc
  }
  orAll(fs: NodeId[]): NodeId {
    let acc: NodeId = BDD_FALSE
    for (const f of fs) acc = this.or(acc, f)
    return acc
  }

  // ---- cofactors, quantification, composition ------------------------------

  /** The cofactor f|_{x_v = val}: substitute a constant for variable `v`. */
  restrict(f: NodeId, v: number, val: boolean): NodeId {
    if (f < 2) return f
    const lv = this.pos[v]
    const lf = this.levelOf(f)
    if (lf > lv) return f // f does not depend on v
    if (lf === lv) return val ? this.hi[f] : this.lo[f]
    // v is below f's top variable: recurse, rebuilding the nodes above it.
    const lo = this.restrict(this.lo[f], v, val)
    const hi = this.restrict(this.hi[f], v, val)
    return this.mk(this.vv[f], lo, hi)
  }

  /** Existential quantification ∃x_v. f  =  f|_{v=0} ∨ f|_{v=1}. */
  existsVar(f: NodeId, v: number): NodeId {
    return this.or(this.restrict(f, v, false), this.restrict(f, v, true))
  }
  /** Universal quantification ∀x_v. f  =  f|_{v=0} ∧ f|_{v=1}. */
  forallVar(f: NodeId, v: number): NodeId {
    return this.and(this.restrict(f, v, false), this.restrict(f, v, true))
  }
  exists(f: NodeId, vars: Iterable<number>): NodeId {
    let acc = f
    for (const v of vars) acc = this.existsVar(acc, v)
    return acc
  }
  forall(f: NodeId, vars: Iterable<number>): NodeId {
    let acc = f
    for (const v of vars) acc = this.forallVar(acc, v)
    return acc
  }

  /** Substitute the BDD `g` for variable `v` in `f` (functional composition). */
  compose(f: NodeId, v: number, g: NodeId): NodeId {
    const f0 = this.restrict(f, v, false)
    const f1 = this.restrict(f, v, true)
    return this.ite(g, f1, f0)
  }

  // ---- queries -------------------------------------------------------------

  /** The set of variables `f` actually depends on, in ascending index order. */
  support(f: NodeId): number[] {
    const seen = new Set<number>()
    const vis = new Set<NodeId>()
    const go = (n: NodeId) => {
      if (n < 2 || vis.has(n)) return
      vis.add(n)
      seen.add(this.vv[n])
      go(this.lo[n])
      go(this.hi[n])
    }
    go(f)
    return [...seen].sort((a, b) => a - b)
  }

  /** Number of distinct internal nodes reachable from `f` (the diagram's size). */
  size(f: NodeId): number {
    const vis = new Set<NodeId>()
    const go = (n: NodeId) => {
      if (n < 2 || vis.has(n)) return
      vis.add(n)
      go(this.lo[n])
      go(this.hi[n])
    }
    go(f)
    return vis.size
  }

  /** Combined size of a forest of roots (shared nodes counted once). */
  sharedSize(roots: NodeId[]): number {
    const vis = new Set<NodeId>()
    const go = (n: NodeId) => {
      if (n < 2 || vis.has(n)) return
      vis.add(n)
      go(this.lo[n])
      go(this.hi[n])
    }
    for (const r of roots) go(r)
    return vis.size
  }

  isSat(f: NodeId): boolean {
    return f !== BDD_FALSE
  }
  isTautology(f: NodeId): boolean {
    return f === BDD_TRUE
  }

  /**
   * Exact model count: the number of assignments over ALL `numVars` variables
   * that satisfy `f`. Variables skipped along a path contribute a factor of two
   * each, so the count is exact even though the diagram elides redundant tests.
   * BigInt arithmetic — never overflows.
   */
  satCount(f: NodeId): bigint {
    const memo = new Map<NodeId, bigint>()
    const pow2 = (k: number): bigint => 1n << BigInt(k)
    // cnt(n) = #assignments over the variables at levels [level(n), numVars) that
    // drive n to TRUE.
    const cnt = (n: NodeId): bigint => {
      if (n === BDD_FALSE) return 0n
      if (n === BDD_TRUE) return 1n
      const hit = memo.get(n)
      if (hit !== undefined) return hit
      const ln = this.levelOf(n)
      const skipLo = this.levelOf(this.lo[n]) - ln - 1
      const skipHi = this.levelOf(this.hi[n]) - ln - 1
      const r = cnt(this.lo[n]) * pow2(skipLo) + cnt(this.hi[n]) * pow2(skipHi)
      memo.set(n, r)
      return r
    }
    return cnt(f) * pow2(this.levelOf(f))
  }

  /** One satisfying assignment (don't-care variables returned false), or null. */
  anySat(f: NodeId): boolean[] | null {
    if (f === BDD_FALSE) return null
    const out = new Array<boolean>(this.numVars).fill(false)
    let n = f
    while (n !== BDD_TRUE) {
      const v = this.vv[n]
      if (this.hi[n] !== BDD_FALSE) {
        out[v] = true
        n = this.hi[n]
      } else {
        out[v] = false
        n = this.lo[n]
      }
    }
    return out
  }

  /**
   * Enumerate satisfying *cubes* (paths to TRUE; unmentioned variables are free).
   * Stops after `limit` cubes and reports whether the enumeration was complete.
   */
  cubes(f: NodeId, limit = 1000): { cubes: Cube[]; complete: boolean } {
    const cubes: Cube[] = []
    let complete = true
    const path = new Map<number, boolean>()
    const go = (n: NodeId): void => {
      if (cubes.length >= limit) {
        complete = false
        return
      }
      if (n === BDD_FALSE) return
      if (n === BDD_TRUE) {
        cubes.push({ assign: new Map(path) })
        return
      }
      const v = this.vv[n]
      path.set(v, false)
      go(this.lo[n])
      path.set(v, true)
      go(this.hi[n])
      path.delete(v)
    }
    go(f)
    return { cubes, complete }
  }

  /** Evaluate `f` under a full assignment (index = variable). */
  evaluate(f: NodeId, assign: boolean[]): boolean {
    let n = f
    while (n >= 2) n = assign[this.vv[n]] ? this.hi[n] : this.lo[n]
    return n === BDD_TRUE
  }
}
