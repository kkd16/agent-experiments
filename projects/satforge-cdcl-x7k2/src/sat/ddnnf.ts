// Knowledge compilation to **smooth deterministic Decomposable Negation Normal Form**
// (sd-DNNF), from scratch.
//
// Deciding satisfiability is a yes/no question; #SAT counts the solutions. *Knowledge
// compilation* goes one step further: it transforms the formula — once, paying the
// search up front — into a circuit on which a whole family of otherwise-hard queries
// becomes *linear-time*. Compile a CNF into an sd-DNNF and you can then, in a single
// pass each, read off:
//
//   • the exact model count (#SAT),
//   • the **weighted** model count (WMC) under arbitrary per-literal weights — the
//     engine behind exact probabilistic inference and the partition function of a
//     factor graph,
//   • every variable's exact **marginal probability** (how often it is true across all
//     solutions) in ONE forward+backward sweep, via the arithmetic-circuit derivative,
//   • an enumeration of the solutions themselves.
//
// The compiler is the *trace* of an exhaustive DPLL search — the very same recursion
// that powers the #SAT counter (modelCount.ts) — but instead of returning a number it
// records the search as a DAG:
//
//   • unit propagation forces literals → an AND of literal nodes (a fixed factor),
//   • variables that drop out of every clause are FREE → an OR(x, ¬x) "coin flip" node,
//   • the residual splits into independent CONNECTED COMPONENTS → an AND (decomposable:
//     children share no variables),
//   • branching on a variable v gives an OR of the v / ¬v sub-circuits (deterministic:
//     the two branches disagree on v, so their model sets are disjoint), and
//   • component sub-circuits are CACHED by their canonical clause set, so the result is
//     a shared DAG, not a tree — the same idea behind c2d / Dsharp.
//
// By emitting the forced literals and free-variable nodes explicitly, and by collapsing
// any unsatisfiable branch away, the circuit comes out **smooth** by construction
// (both children of every OR mention exactly the same variables) — which is what makes
// the WMC and marginal passes a clean ∏ / Σ with no on-the-fly bookkeeping.

import type { CNF } from './cnf'

/** A node of the compiled circuit. Children are indices into {@link Ddnnf.nodes}, and
 *  always precede their parent (the array is in topological order). */
export type DdnnfNode =
  | { kind: 'lit'; lit: number }
  | { kind: 'true' }
  | { kind: 'false' }
  | { kind: 'and'; children: number[] }
  /** A deterministic OR: a decision on `dvar`. Children are mutually exclusive on it. */
  | { kind: 'or'; dvar: number; children: number[] }

export interface Ddnnf {
  numVars: number
  /** Topologically ordered: every child index is < its parent's index. */
  nodes: DdnnfNode[]
  /** Index of the root node. */
  root: number
}

export interface CompileStats {
  /** Total nodes in the DAG. */
  nodes: number
  /** Total edges (sum of child counts). */
  edges: number
  litNodes: number
  andNodes: number
  /** Deterministic OR (decision + free-variable) nodes. */
  orNodes: number
  decisionNodes: number
  freeNodes: number
  /** DPLL recursion nodes explored while compiling. */
  searchNodes: number
  cacheHits: number
  cacheSize: number
  timeMs: number
  /** False when the node budget ran out before the circuit was complete. */
  exact: boolean
}

export interface CompileResult {
  /** The compiled circuit, or null if the search budget was exhausted. */
  ddnnf: Ddnnf | null
  stats: CompileStats
}

export interface CompileOptions {
  /** Abort (ddnnf: null, exact: false) after this many recursion nodes. */
  budget?: number
}

/**
 * Compile a CNF into a smooth, decomposable, deterministic DNNF circuit.
 */
export function compileDdnnf(cnf: CNF, opts: CompileOptions = {}): CompileResult {
  const budget = opts.budget ?? 400000
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

  // --- node table (built bottom-up, so children always precede parents) ---
  const nodes: DdnnfNode[] = []
  const TRUE = pushNode({ kind: 'true' })
  const FALSE = pushNode({ kind: 'false' })
  const litCache = new Map<number, number>()
  const freeCache = new Map<number, number>()

  function pushNode(n: DdnnfNode): number {
    nodes.push(n)
    return nodes.length - 1
  }
  function litNode(l: number): number {
    const hit = litCache.get(l)
    if (hit !== undefined) return hit
    const id = pushNode({ kind: 'lit', lit: l })
    litCache.set(l, id)
    return id
  }
  /** A free variable: OR(v, ¬v) — a deterministic "coin flip" worth a factor of two. */
  function freeNode(v: number): number {
    const hit = freeCache.get(v)
    if (hit !== undefined) return hit
    const id = pushNode({ kind: 'or', dvar: v, children: [litNode(v), litNode(-v)] })
    freeCache.set(v, id)
    return id
  }
  /** A decomposable AND, with the trivial cases collapsed. */
  function andNode(children: number[]): number {
    const kids = children.filter((c) => c !== TRUE)
    if (kids.some((c) => c === FALSE)) return FALSE
    if (kids.length === 0) return TRUE
    if (kids.length === 1) return kids[0]
    return pushNode({ kind: 'and', children: kids })
  }

  // --- normalize the input: drop tautologies + duplicate literals ---
  const clauses0: number[][] = []
  for (const c of cnf.clauses) {
    const seen = new Set<number>()
    let taut = false
    const lits: number[] = []
    for (const l of c) {
      if (l === 0) continue
      if (seen.has(-l)) {
        taut = true
        break
      }
      if (seen.has(l)) continue
      seen.add(l)
      lits.push(l)
    }
    if (taut) continue
    if (lits.length === 0) {
      // The empty clause makes the whole formula unsatisfiable — an exact answer (0 models).
      return finish(FALSE, true, 0, 0, 0)
    }
    clauses0.push(lits)
  }

  const allVars = new Set<number>()
  for (let v = 1; v <= cnf.numVars; v++) allVars.add(v)

  let searchNodes = 0
  let cacheHits = 0
  let aborted = false
  const cache = new Map<string, number>()

  // Compile a clause set over `vars` (every variable mentioned is in `vars`; vars that
  // vanish are free). Returns a node index whose variable scope is exactly `vars`.
  function build(clauses: number[][], vars: Set<number>): number {
    if (aborted) return FALSE
    if (++searchNodes > budget) {
      aborted = true
      return FALSE
    }

    // ---- unit propagation to a fixpoint ----
    const assign = new Map<number, boolean>()
    let work = clauses
    let conflict = false
    for (;;) {
      const simp: number[][] = []
      const units: number[] = []
      for (const cl of work) {
        let sat = false
        const rem: number[] = []
        for (const l of cl) {
          const v = Math.abs(l)
          if (assign.has(v)) {
            if (assign.get(v)! === l > 0) {
              sat = true
              break
            }
          } else rem.push(l)
        }
        if (sat) continue
        if (rem.length === 0) {
          conflict = true
          break
        }
        if (rem.length === 1) units.push(rem[0])
        simp.push(rem)
      }
      if (conflict) break
      work = simp
      if (units.length === 0) break
      let progressed = false
      for (const u of units) {
        const v = Math.abs(u)
        const val = u > 0
        if (assign.has(v)) {
          if (assign.get(v)! !== val) {
            conflict = true
            break
          }
        } else {
          assign.set(v, val)
          progressed = true
        }
      }
      if (conflict) break
      if (!progressed) break
    }
    if (conflict) return FALSE

    // Forced literals become AND-conjuncts (each contributes its own weight to a WMC).
    const factors: number[] = []
    for (const [v, val] of assign) factors.push(litNode(val ? v : -v))

    // `work` now holds only clauses of width >= 2, simplified under `assign`.
    const usedVars = new Set<number>()
    for (const cl of work) for (const l of cl) usedVars.add(Math.abs(l))

    // Variables in scope that are neither forced nor used are free (an OR(v,¬v) factor).
    for (const v of vars) if (!assign.has(v) && !usedVars.has(v)) factors.push(freeNode(v))

    for (const comp of connectedComponents(work)) {
      factors.push(buildComponent(comp))
      if (aborted) return FALSE
    }
    return andNode(factors)
  }

  // Compile one connected component (every clause has width >= 2). Memoized on the
  // canonical clause set, then split on the busiest variable into a deterministic OR.
  function buildComponent(comp: Component): number {
    const key = canonicalKey(comp.clauses)
    const hit = cache.get(key)
    if (hit !== undefined) {
      cacheHits++
      return hit
    }
    // Branch on the most frequently occurring variable.
    const freq = new Map<number, number>()
    for (const cl of comp.clauses)
      for (const l of cl) {
        const v = Math.abs(l)
        freq.set(v, (freq.get(v) ?? 0) + 1)
      }
    let branch = -1
    let best = -1
    for (const [v, f] of freq)
      if (f > best) {
        best = f
        branch = v
      }
    const hi = build(comp.clauses.concat([[branch]]), comp.vars)
    const lo = build(comp.clauses.concat([[-branch]]), comp.vars)
    // Collapse unsatisfiable branches: OR(FALSE, x) = x. Keeps the circuit smooth, since
    // a surviving branch still has scope exactly comp.vars.
    let result: number
    if (hi === FALSE && lo === FALSE) result = FALSE
    else if (hi === FALSE) result = lo
    else if (lo === FALSE) result = hi
    else result = pushNode({ kind: 'or', dvar: branch, children: [hi, lo] })
    if (!aborted) cache.set(key, result)
    return result
  }

  const root = build(clauses0, allVars)
  return finish(root, !aborted, searchNodes, cacheHits, cache.size)

  function finish(
    root: number,
    exact: boolean,
    searchNodes: number,
    cacheHits: number,
    cacheSize: number,
  ): CompileResult {
    if (!exact) {
      return {
        ddnnf: null,
        stats: {
          nodes: nodes.length,
          edges: 0,
          litNodes: 0,
          andNodes: 0,
          orNodes: 0,
          decisionNodes: 0,
          freeNodes: 0,
          searchNodes,
          cacheHits,
          cacheSize,
          timeMs: now() - t0,
          exact: false,
        },
      }
    }
    // Garbage-collect: keep only nodes reachable from the root, renumbered to a compact,
    // still-topological table. (The build leaves cached-but-unused branches behind.) The
    // variable count comes from the input, not the surviving nodes — an UNSAT circuit (a
    // lone FALSE) still ranges over all the original variables.
    const compact = gc(nodes, root, cnf.numVars)
    const stats = structureStats(compact)
    return {
      ddnnf: compact,
      stats: {
        nodes: stats.nodes,
        edges: stats.edges,
        litNodes: stats.litNodes,
        andNodes: stats.andNodes,
        orNodes: stats.orNodes,
        decisionNodes: stats.decisionNodes,
        freeNodes: stats.freeNodes,
        searchNodes,
        cacheHits,
        cacheSize,
        timeMs: now() - t0,
        exact: true,
      },
    }
  }
}

/** A connected component: a set of clauses plus the variables they span. */
interface Component {
  clauses: number[][]
  vars: Set<number>
}

/** Split a clause set into connected components by shared variables (union-find). */
function connectedComponents(clauses: number[][]): Component[] {
  const parent = new Map<number, number>()
  const find = (x: number): number => {
    if (!parent.has(x)) parent.set(x, x)
    let r = x
    while (parent.get(r)! !== r) r = parent.get(r)!
    while (parent.get(x)! !== r) {
      const nx = parent.get(x)!
      parent.set(x, r)
      x = nx
    }
    return r
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const cl of clauses) {
    const v0 = Math.abs(cl[0])
    find(v0)
    for (let i = 1; i < cl.length; i++) union(v0, Math.abs(cl[i]))
  }
  const byRoot = new Map<number, Component>()
  for (const cl of clauses) {
    const root = find(Math.abs(cl[0]))
    let comp = byRoot.get(root)
    if (!comp) {
      comp = { clauses: [], vars: new Set() }
      byRoot.set(root, comp)
    }
    comp.clauses.push(cl)
    for (const l of cl) comp.vars.add(Math.abs(l))
  }
  return [...byRoot.values()]
}

/** Order-independent signature of a clause set, for the component cache. */
function canonicalKey(clauses: number[][]): string {
  const rows = clauses.map((c) => c.slice().sort((a, b) => a - b).join(','))
  rows.sort()
  return rows.join(';')
}

/** Keep only the nodes reachable from `root`, renumbered into a compact topological table. */
function gc(nodes: DdnnfNode[], root: number, numVars: number): Ddnnf {
  const remap = new Int32Array(nodes.length).fill(-1)
  const out: DdnnfNode[] = []
  // DFS post-order guarantees children are emitted before parents.
  const stack: Array<{ id: number; phase: number }> = [{ id: root, phase: 0 }]
  while (stack.length) {
    const top = stack[stack.length - 1]
    const node = nodes[top.id]
    if (top.phase === 0) {
      if (remap[top.id] !== -1) {
        stack.pop()
        continue
      }
      top.phase = 1
      if (node.kind === 'and' || node.kind === 'or') {
        for (const c of node.children) if (remap[c] === -1) stack.push({ id: c, phase: 0 })
      }
    } else {
      stack.pop()
      if (remap[top.id] !== -1) continue
      let copy: DdnnfNode
      if (node.kind === 'and') copy = { kind: 'and', children: node.children.map((c) => remap[c]) }
      else if (node.kind === 'or')
        copy = { kind: 'or', dvar: node.dvar, children: node.children.map((c) => remap[c]) }
      else copy = node
      remap[top.id] = out.length
      out.push(copy)
    }
  }
  return { numVars, nodes: out, root: remap[root] }
}

interface StructureStats {
  nodes: number
  edges: number
  litNodes: number
  andNodes: number
  orNodes: number
  decisionNodes: number
  freeNodes: number
}

function structureStats(d: Ddnnf): StructureStats {
  let edges = 0
  let litNodes = 0
  let andNodes = 0
  let orNodes = 0
  let decisionNodes = 0
  let freeNodes = 0
  for (const n of d.nodes) {
    if (n.kind === 'lit') litNodes++
    else if (n.kind === 'and') {
      andNodes++
      edges += n.children.length
    } else if (n.kind === 'or') {
      orNodes++
      edges += n.children.length
      // A free node is OR(v, ¬v): exactly two literal children on the decision variable.
      const isFree =
        n.children.length === 2 &&
        n.children.every((c) => {
          const k = d.nodes[c]
          return k.kind === 'lit' && Math.abs(k.lit) === n.dvar
        })
      if (isFree) freeNodes++
      else decisionNodes++
    }
  }
  return { nodes: d.nodes.length, edges, litNodes, andNodes, orNodes, decisionNodes, freeNodes }
}

/** Public structural summary (recomputed from the circuit). */
export function ddnnfStats(d: Ddnnf): StructureStats {
  return structureStats(d)
}

// ---------------------------------------------------------------------------
// Linear-time queries over the compiled circuit. Every pass visits the nodes in
// index order (children before parents) exactly once.
// ---------------------------------------------------------------------------

/** Exact model count over all `numVars` variables (BigInt, never overflows). */
export function ddnnfCount(d: Ddnnf): bigint {
  const val = new Array<bigint>(d.nodes.length)
  for (let i = 0; i < d.nodes.length; i++) {
    const n = d.nodes[i]
    switch (n.kind) {
      case 'true':
      case 'lit':
        val[i] = 1n
        break
      case 'false':
        val[i] = 0n
        break
      case 'and': {
        let p = 1n
        for (const c of n.children) p *= val[c]
        val[i] = p
        break
      }
      case 'or': {
        let s = 0n
        for (const c of n.children) s += val[c]
        val[i] = s
        break
      }
    }
  }
  return val[d.root]
}

/** Per-variable literal weights, indexed 1..numVars. */
export interface Weights {
  pos: number[]
  neg: number[]
}

/** Uniform weights (every literal worth 0.5): WMC then equals modelCount / 2^numVars. */
export function uniformWeights(numVars: number): Weights {
  const pos = new Array(numVars + 1).fill(0.5)
  const neg = new Array(numVars + 1).fill(0.5)
  return { pos, neg }
}

/** Weighted model count: Σ over models of ∏ literal weights. */
export function ddnnfWmc(d: Ddnnf, w: Weights): number {
  return wmcValues(d, w)[d.root]
}

/** The forward WMC value at every node (used by both WMC and the marginal pass). */
function wmcValues(d: Ddnnf, w: Weights): Float64Array {
  const val = new Float64Array(d.nodes.length)
  for (let i = 0; i < d.nodes.length; i++) {
    const n = d.nodes[i]
    switch (n.kind) {
      case 'true':
        val[i] = 1
        break
      case 'false':
        val[i] = 0
        break
      case 'lit':
        val[i] = n.lit > 0 ? w.pos[n.lit] : w.neg[-n.lit]
        break
      case 'and': {
        let p = 1
        for (const c of n.children) p *= val[c]
        val[i] = p
        break
      }
      case 'or': {
        let s = 0
        for (const c of n.children) s += val[c]
        val[i] = s
        break
      }
    }
  }
  return val
}

export interface Marginals {
  /** Partition function: the weighted model count Z = WMC(formula). */
  z: number
  /** probTrue[v] = Pr(variable v is true | the formula holds), for v in 1..numVars. */
  probTrue: number[]
}

/**
 * Exact marginal probability that each variable is true, across the (weighted)
 * distribution of satisfying assignments — computed in ONE forward + backward pass.
 *
 * The circuit computes Z = WMC as a function of the literal weights. By the
 * arithmetic-circuit derivative, w[ℓ]·∂Z/∂w[ℓ] = WMC(formula ∧ ℓ), so the marginal of
 * a literal is just (its weight × the accumulated derivative at its nodes) / Z. The
 * backward pass propagates ∂Z/∂node from the root: through an OR it passes straight
 * down (Z is a sum of the children), through an AND it carries the product of the
 * sibling values. This is the classic Darwiche differential-of-an-AC, exact because
 * the circuit is decomposable (the sibling product is well defined) and deterministic
 * + smooth (no model is double-counted and every variable is mentioned on both OR arms).
 */
export function ddnnfMarginals(d: Ddnnf, w: Weights): Marginals {
  const val = wmcValues(d, w)
  const z = val[d.root]
  const deriv = new Float64Array(d.nodes.length)
  deriv[d.root] = 1
  // ∂Z/∂w[ℓ] accumulates over all literal nodes carrying literal ℓ.
  const dPos = new Array(d.numVars + 1).fill(0)
  const dNeg = new Array(d.numVars + 1).fill(0)
  for (let i = d.nodes.length - 1; i >= 0; i--) {
    const di = deriv[i]
    if (di === 0) {
      // No contribution flows through this node; still record literals as zero.
      continue
    }
    const n = d.nodes[i]
    if (n.kind === 'lit') {
      if (n.lit > 0) dPos[n.lit] += di
      else dNeg[-n.lit] += di
    } else if (n.kind === 'or') {
      for (const c of n.children) deriv[c] += di
    } else if (n.kind === 'and') {
      // ∂/∂child_j = di · ∏_{k≠j} val[child_k]. Handle a zero sibling robustly by
      // counting zeros instead of dividing the whole product.
      let zeros = 0
      let prodNonZero = 1
      for (const c of n.children) {
        if (val[c] === 0) zeros++
        else prodNonZero *= val[c]
      }
      for (const c of n.children) {
        let siblingProd: number
        if (zeros === 0) siblingProd = prodNonZero / val[c]
        else if (zeros === 1) siblingProd = val[c] === 0 ? prodNonZero : 0
        else siblingProd = 0
        deriv[c] += di * siblingProd
      }
    }
  }
  const probTrue = new Array(d.numVars + 1).fill(0)
  for (let v = 1; v <= d.numVars; v++) {
    const wmcTrue = w.pos[v] * dPos[v]
    probTrue[v] = z > 0 ? wmcTrue / z : 0
  }
  return { z, probTrue }
}

/**
 * Enumerate up to `limit` satisfying assignments directly from the circuit. Because the
 * circuit is smooth, decomposable and deterministic, each model is produced exactly once.
 * Each model is a 1-indexed boolean array over 1..numVars.
 */
export function ddnnfEnumerate(d: Ddnnf, limit = 1000): boolean[][] {
  // models(i) yields the (partial) assignments of node i over its own variable scope.
  // We materialize lazily-ish: an assignment is a Map<var, bool>. AND = cross product,
  // OR = concatenation, lit fixes one variable. Smoothness makes the cross products align.
  const memo = new Map<number, Array<Map<number, boolean>>>()
  let overflow = false
  function models(i: number): Array<Map<number, boolean>> {
    const cached = memo.get(i)
    if (cached) return cached
    const n = d.nodes[i]
    let out: Array<Map<number, boolean>>
    if (n.kind === 'false') out = []
    else if (n.kind === 'true') out = [new Map()]
    else if (n.kind === 'lit') out = [new Map([[Math.abs(n.lit), n.lit > 0]])]
    else if (n.kind === 'or') {
      out = []
      for (const c of n.children) {
        for (const m of models(c)) {
          if (out.length >= limit) {
            overflow = true
            break
          }
          out.push(m)
        }
        if (overflow) break
      }
    } else {
      // AND: cross product of children's model sets.
      out = [new Map()]
      for (const c of n.children) {
        const sub = models(c)
        const next: Array<Map<number, boolean>> = []
        for (const a of out) {
          for (const b of sub) {
            if (next.length >= limit) {
              overflow = true
              break
            }
            const merged = new Map(a)
            for (const [k, val] of b) merged.set(k, val)
            next.push(merged)
          }
          if (overflow) break
        }
        out = next
        if (overflow) break
      }
    }
    memo.set(i, out)
    return out
  }
  const partials = models(d.root)
  const result: boolean[][] = []
  for (const m of partials) {
    if (result.length >= limit) break
    const row: boolean[] = new Array(d.numVars + 1).fill(false)
    for (const [v, val] of m) row[v] = val
    result.push(row)
  }
  return result
}

// ---------------------------------------------------------------------------
// Structural certificates: prove the circuit really is sd-DNNF.
// ---------------------------------------------------------------------------

export interface CircuitProperties {
  decomposable: boolean
  deterministic: boolean
  smooth: boolean
}

/** Variable scope of every node (the set of variables that appear below it). */
function scopes(d: Ddnnf): Array<Set<number>> {
  const sc: Array<Set<number>> = new Array(d.nodes.length)
  for (let i = 0; i < d.nodes.length; i++) {
    const n = d.nodes[i]
    const s = new Set<number>()
    if (n.kind === 'lit') s.add(Math.abs(n.lit))
    else if (n.kind === 'and' || n.kind === 'or') for (const c of n.children) for (const v of sc[c]) s.add(v)
    sc[i] = s
  }
  return sc
}

/** Does the model set of node `i` entail literal `l`? (Sound under-approximation: an
 *  AND entails what any conjunct entails; a literal entails itself.) */
function entails(d: Ddnnf, i: number, l: number): boolean {
  const n = d.nodes[i]
  if (n.kind === 'lit') return n.lit === l
  if (n.kind === 'and') return n.children.some((c) => entails(d, c, l))
  return false
}

/**
 * Verify the three properties knowledge compilation relies on:
 *  - decomposable: an AND's children have pairwise-disjoint variable scopes,
 *  - deterministic: an OR's children are pairwise mutually exclusive (here certified by
 *    a decision variable on which the two arms disagree),
 *  - smooth: an OR's children all share the same variable scope.
 */
export function verifyCircuit(d: Ddnnf): CircuitProperties {
  const sc = scopes(d)
  let decomposable = true
  let deterministic = true
  let smooth = true
  for (let i = 0; i < d.nodes.length; i++) {
    const n = d.nodes[i]
    if (n.kind === 'and') {
      const seen = new Set<number>()
      for (const c of n.children) {
        for (const v of sc[c]) {
          if (seen.has(v)) decomposable = false
          seen.add(v)
        }
      }
    } else if (n.kind === 'or') {
      // smoothness: identical scopes.
      const ref = sc[n.children[0]]
      for (const c of n.children) {
        if (sc[c].size !== ref.size) smooth = false
        else for (const v of sc[c]) if (!ref.has(v)) smooth = false
      }
      // determinism: a binary decision where one arm entails +dvar and the other −dvar.
      if (n.children.length === 2) {
        const [a, b] = n.children
        const dv = n.dvar
        const ok =
          (entails(d, a, dv) && entails(d, b, -dv)) || (entails(d, a, -dv) && entails(d, b, dv))
        if (!ok) deterministic = false
      } else if (n.children.length > 2) {
        deterministic = false
      }
    }
  }
  return { decomposable, deterministic, smooth }
}

// ---------------------------------------------------------------------------
// Export to the standard c2d / Dsharp ".nnf" text format, so the compiled circuit
// can be inspected or fed to external tools.
//
//   nnf <#nodes> <#edges> <#vars>
//   L <literal>                       (leaf: a literal)
//   A <k> <child> ...                 (AND of k children, by node id)
//   O <j> <k> <child> ...             (OR, split variable j, of k children)
//   A 0                               (true)   /   O 0 0  (false)
// ---------------------------------------------------------------------------

export function toNnf(d: Ddnnf): string {
  const lines: string[] = []
  let edges = 0
  for (const n of d.nodes) {
    if (n.kind === 'true') lines.push('A 0')
    else if (n.kind === 'false') lines.push('O 0 0')
    else if (n.kind === 'lit') lines.push(`L ${n.lit}`)
    else if (n.kind === 'and') {
      edges += n.children.length
      lines.push(`A ${n.children.length} ${n.children.join(' ')}`)
    } else {
      edges += n.children.length
      lines.push(`O ${n.dvar} ${n.children.length} ${n.children.join(' ')}`)
    }
  }
  const header = `nnf ${d.nodes.length} ${edges} ${d.numVars}`
  return [header, ...lines].join('\n') + '\n'
}
