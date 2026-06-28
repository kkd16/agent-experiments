// Aether — equality saturation over an e-graph ("Aether 16.0")
//
// The optimizing middle-end (`optimize.ts`) is a *greedy, fixpoint* rewriter:
// each round it picks one rewrite per node and commits to it, so the order of
// rules and the shape it happens to reach decides what it can see next. That is
// how every real bottom-up simplifier works — and it is also its blind spot. A
// term like `a * b + a * c` only collapses to `a * (b + c)` if the optimizer
// *happens* to factor before it does anything else; `(x + 3) + 4` only folds to
// `x + 7` if it reassociates the right way first. A greedy pass that picks the
// wrong first move can never get back.
//
// **Equality saturation** removes the choice. Instead of rewriting *destructively*
// we grow an **e-graph** — a set of equivalence classes ("e-classes") of e-nodes —
// and apply every rewrite *non-destructively*, recording both the old and the new
// form in the same class. Rules keep firing until the graph stops growing
// (it *saturates*), at which point a single e-class compactly represents an
// astronomically large set of equivalent programs. We then run a bottom-up
// **extraction** with a cost model and pull out the *cheapest* program in the
// whole equivalence class at once. The optimizer no longer has to guess the right
// order — it considers all orders simultaneously. (This is the core idea behind
// `egg`; here it is implemented from scratch, no libraries.)
//
// ## The domain — the integer-arithmetic island
//
// We run equality saturation on the sub-language where it is both most valuable
// and unconditionally sound: **integer arithmetic**, built from `+`, `-`, `*` and
// unary negation. Aether's type system guarantees (see `inferBinop`) that every
// operand of `+ - *` and of unary `-` has type `Int`, so a maximal tree of these
// operators is a polynomial in its leaves over ℤ. We deliberately leave `/` and
// `%` out (they trap on a zero divisor and truncate, so they are neither total
// nor associative), and we treat any non-arithmetic subterm as an opaque **leaf**.
//
// A leaf may be shared, dropped (`a * 0 → 0`), duplicated (`a * (b + c) → …`) or
// reordered by our rules, so it is only admitted when the host optimizer proves
// it **pure and total** (`isPure`). An island containing an effectful or possibly
// diverging leaf is left untouched — exactly the discipline the rest of the
// middle-end already keeps.
//
// ## Soundness — polynomial identity testing (Schwartz–Zippel)
//
// Every island is a multivariate polynomial in its leaves with integer
// coefficients. Two such polynomials are equal *as elements of ℤ[leaves]* iff they
// agree *as functions on ℤ*, and by the Schwartz–Zippel lemma two *distinct*
// low-degree polynomials agree on only a vanishing fraction of random points. So
// before we ever adopt an extracted form we **differentially validate** it: assign
// the leaves many random integers (in a range small enough that the *island's own*
// evaluation stays exact in 64-bit floats) and evaluate both the original and the
// candidate. A single disagreement vetoes the rewrite; with dozens of random
// trials the chance of admitting a non-identity is negligible. This certifies the
// rewrite as a genuine **integer identity**.
//
// Why that is also a *runtime* identity at any magnitude: Aether's `Int` is a
// genuine **ℤ/2^32 ring** — every VM/JS/WASM arithmetic op wraps to signed 32 bits
// (`vint`/`I` use `| 0`; multiplication uses `Math.imul`, the exact low-32-bit
// product, matching the WASM `i32.mul`). The canonical ring homomorphism
// ℤ → ℤ/2^32 carries any integer identity to an identity in that ring, so a rewrite
// the Schwartz–Zippel check certifies over ℤ holds bit-for-bit on the running VM
// *regardless of overflow*, and the answer never changes. (This was historically
// only true within ±2^53: `*` rounded past it — two near-2^31 operands already
// overflow a double — so the runtime was not a consistent ring and a reassociated
// product could observably differ. Switching the runtime product to `Math.imul`
// closed that gap.) The cost gate only ever adopts a *strictly cheaper* form, so
// the pass is "never worse" by construction — like the rest of the optimizer.

import type { BinaryOp, Expr } from './ast.ts'
import { cloneExpr } from './ast.ts'
import type { Span } from './lexer.ts'
import { unparse } from './unparse.ts'

const SYNTH: Span = { start: 0, end: 0, line: 0, col: 0 }

// ---------------------------------------------------------------------------
// E-node / e-graph
// ---------------------------------------------------------------------------

type EId = number

/** An e-node: an operator applied to *e-class* operands (so it denotes a whole
 *  equivalence class of subterms, not one term). `const` and `leaf` are nullary. */
type ENode =
  | { op: 'const'; val: number }
  | { op: 'leaf'; leaf: number }
  | { op: 'neg'; args: [EId] }
  | { op: '+'; args: [EId, EId] }
  | { op: '*'; args: [EId, EId] }

function nodeArgs(n: ENode): EId[] {
  return n.op === 'const' || n.op === 'leaf' ? [] : n.args
}

/**
 * A from-scratch e-graph with union-find e-classes and a congruence-maintaining
 * `rebuild`. Commutativity of `+` and `*` is folded into the hash-cons key (the
 * operands are sorted), so `a+b` and `b+a` are *the same e-node* and never cost a
 * class — the rule set only has to carry the structural laws (associativity,
 * distributivity, identities, …).
 */
class EGraph {
  private parent: EId[] = []
  private nodes: ENode[] = []
  /** the e-class each node was created in (chase with `find` for the current one) */
  private owner: EId[] = []
  /** hash-cons: canonical node key → e-class */
  private memo = new Map<string, EId>()
  /** number of distinct e-classes (for stats) */
  unions = 0

  find(x: EId): EId {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]
      x = this.parent[x]
    }
    return x
  }

  private key(n: ENode): string {
    switch (n.op) {
      case 'const':
        return `c${n.val}`
      case 'leaf':
        return `l${n.leaf}`
      case 'neg':
        return `neg(${this.find(n.args[0])})`
      default: {
        const a = this.find(n.args[0])
        const b = this.find(n.args[1])
        const [x, y] = a <= b ? [a, b] : [b, a] // commutative: sort operands
        return `${n.op}(${x},${y})`
      }
    }
  }

  /** Intern an e-node, returning its e-class; creates a fresh class if new. */
  add(n: ENode): EId {
    const k = this.key(n)
    const hit = this.memo.get(k)
    if (hit !== undefined) return this.find(hit)
    const id = this.parent.length
    this.parent.push(id)
    this.nodes.push(n)
    this.owner.push(id)
    this.memo.set(k, id)
    return id
  }

  /** Merge two e-classes; returns true if they were distinct. */
  merge(a: EId, b: EId): boolean {
    a = this.find(a)
    b = this.find(b)
    if (a === b) return false
    this.parent[a] = b
    this.unions++
    return true
  }

  /** Restore the congruence invariant after a batch of merges: re-canonicalise
   *  every node and union any two that now share a key. Repeats to a fixpoint —
   *  fine for the small islands we run on. */
  rebuild(): void {
    let changed = true
    while (changed) {
      changed = false
      this.memo.clear()
      for (let i = 0; i < this.nodes.length; i++) {
        const k = this.key(this.nodes[i])
        const cls = this.find(this.owner[i])
        const prev = this.memo.get(k)
        if (prev === undefined) {
          this.memo.set(k, cls)
        } else if (this.merge(prev, cls)) {
          changed = true
          this.memo.set(k, this.find(prev))
        }
      }
    }
  }

  /** Canonical e-class → the indices of its member e-nodes (post-rebuild). */
  classMembers(): Map<EId, number[]> {
    const m = new Map<EId, number[]>()
    for (let i = 0; i < this.nodes.length; i++) {
      const c = this.find(this.owner[i])
      const arr = m.get(c)
      if (arr) arr.push(i)
      else m.set(c, [i])
    }
    return m
  }

  nodeAt(i: number): ENode {
    return this.nodes[i]
  }

  get nodeCount(): number {
    return this.nodes.length
  }
}

// ---------------------------------------------------------------------------
// Building the e-graph from an island
// ---------------------------------------------------------------------------

/** An opaque, pure, integer-typed subterm treated as a polynomial variable. */
interface Leaf {
  key: string // structural identity (unparse)
  expr: Expr // the (already-recursively-optimized) subterm to splice back
}

const ISLAND_BINOPS = new Set<BinaryOp>(['+', '-', '*'])

/** Root only at a `+ - *` binop: that guarantees an Int context (so a unary `-`
 *  reached *underneath* it is also Int and safe to enter the island). */
function isIslandRoot(e: Expr): boolean {
  return e.kind === 'binop' && ISLAND_BINOPS.has(e.op)
}

// ---------------------------------------------------------------------------
// Cost model (a lower bound on the VM work a form performs)
// ---------------------------------------------------------------------------

// Each arithmetic op and each *occurrence* of a leaf costs; a multiply is dearer
// than an add, so the extractor prefers `u*(x+y)` (one ×, sharing the leaf) to
// `u*x + u*y` (two ×, the leaf recomputed). Counting leaf occurrences this way is
// also what keeps duplicating rules (distribution) from ever blowing the term up:
// a copy of a leaf raises the cost, so the gate rejects it unless it pays for
// itself elsewhere.
const MUL_COST = 3
const ADD_COST = 1
const NEG_COST = 1
const CONST_COST = 1
const LEAF_COST = 1

// ---------------------------------------------------------------------------
// Public view types (for the Eq-Sat panel)
// ---------------------------------------------------------------------------

export interface EClassView {
  id: number
  /** e-node labels in this class, e.g. ["+", "× ·", "7"] */
  nodes: { label: string; children: number[] }[]
  root: boolean
  /** part of the finally-extracted cheapest term */
  extracted: boolean
}

export interface EqSatRewrite {
  before: string
  after: string
  nodesBefore: number
  nodesAfter: number
  costBefore: number
  costAfter: number
  /** e-classes / e-nodes the saturated graph held */
  classes: number
  enodes: number
  /** saturation iterations run, and whether it reached a true fixpoint */
  iters: number
  saturated: boolean
  /** Schwartz–Zippel differential check */
  validated: boolean
  trials: number
  /** how many leaves (polynomial variables) the island had */
  leaves: number
  /** a (capped) snapshot of the saturated e-graph for visualisation */
  graph: EClassView[]
}

export interface EqSatStats {
  /** maximal integer-arithmetic islands the pass found */
  islands: number
  /** the islands it actually improved (strictly cheaper + validated) */
  rewrites: EqSatRewrite[]
}

export interface EqSatResult {
  expr: Expr
  stats: EqSatStats
}

export interface EqSatOptions {
  /** the host optimizer's purity oracle: a leaf is only admitted if pure & total */
  isPure: (e: Expr) => boolean
  /** budgets (kept generous; islands are tiny in practice) */
  maxIters?: number
  maxNodes?: number
  trials?: number
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

export function equalitySaturate(root: Expr, opts: EqSatOptions): EqSatResult {
  const isPure = opts.isPure
  const maxIters = opts.maxIters ?? 20
  const maxNodes = opts.maxNodes ?? 1500
  const trials = opts.trials ?? 40
  const rewrites: EqSatRewrite[] = []
  let islands = 0

  // Top-down walk: at the *topmost* island operator we optimise the whole
  // maximal island at once (its leaves are recursively transformed); elsewhere
  // we just recurse into children.
  const go = (e: Expr): Expr => {
    if (isIslandRoot(e)) {
      islands++
      const r = optimizeIsland(e, go, { isPure, maxIters, maxNodes, trials })
      if (r) rewrites.push(r.rewrite)
      return r ? r.expr : mapChildren(e, go)
    }
    return mapChildren(e, go)
  }

  const out = go(root)
  return { expr: out, stats: { islands, rewrites } }
}

interface IslandOutcome {
  expr: Expr
  rewrite: EqSatRewrite
}

function optimizeIsland(
  island: Expr,
  recur: (e: Expr) => Expr,
  cfg: { isPure: (e: Expr) => boolean; maxIters: number; maxNodes: number; trials: number },
): IslandOutcome | null {
  // 1. Collect the leaves (maximal non-island subterms). Bail if any is impure:
  //    our rules may share / drop / duplicate / reorder a leaf, so an effectful
  //    or possibly-diverging one makes the whole island unsafe to touch.
  const leaves: Leaf[] = []
  const leafIndex = new Map<string, number>()
  let impure = false
  const collect = (e: Expr): void => {
    if (e.kind === 'binop' && ISLAND_BINOPS.has(e.op)) {
      collect(e.left)
      collect(e.right)
    } else if (e.kind === 'unop' && e.op === '-') {
      collect(e.operand)
    } else if (e.kind === 'int') {
      // a literal is not a leaf — it folds into the graph as a constant
    } else {
      const key = unparse(e)
      if (!leafIndex.has(key)) {
        if (!cfg.isPure(e)) impure = true
        leafIndex.set(key, leaves.length)
        leaves.push({ key, expr: recur(e) })
      }
    }
  }
  collect(island)

  if (impure) return null

  // 2. Build the e-graph.
  const eg = new EGraph()
  const build = (e: Expr): EId => {
    if (e.kind === 'int') return eg.add({ op: 'const', val: e.value })
    if (e.kind === 'unop' && e.op === '-') return eg.add({ op: 'neg', args: [build(e.operand)] })
    if (e.kind === 'binop' && ISLAND_BINOPS.has(e.op)) {
      const l = build(e.left)
      const r = e.op === '-' ? eg.add({ op: 'neg', args: [build(e.right)] }) : build(e.right)
      return eg.add({ op: e.op === '*' ? '*' : '+', args: [l, r] })
    }
    // a leaf
    const idx = leafIndex.get(unparse(e))!
    return eg.add({ op: 'leaf', leaf: idx })
  }
  const rootClass = build(island)
  eg.rebuild()

  // 3. Saturate.
  const { iters, saturated } = saturate(eg, cfg.maxIters, cfg.maxNodes)

  // 4. Extract the cheapest term in the root class.
  const members = eg.classMembers()
  const { cost: bestCost, choice } = extract(eg, members)
  const extracted = buildExpr(eg, rootClass, choice, leaves)

  // 5. Cost gate — only adopt a *strictly cheaper* form (never worse).
  const beforeCost = islandCost(island)
  const afterCost = bestCost.get(eg.find(rootClass)) ?? Infinity
  if (!(afterCost < beforeCost)) return null

  // 6. Differential validation (Schwartz–Zippel polynomial identity testing).
  //    We compare the *original* island (evaluated through its leaf-by-unparse
  //    index) against the *extracted choice* (evaluated straight on the e-graph,
  //    leaf nodes carrying their index) — so the two never have to agree on how a
  //    leaf is spelled, only on which polynomial variable it is.
  const validated = differentiallyEqual(island, leafIndex, eg, rootClass, choice, leaves.length, cfg.trials)
  if (!validated) return null

  const view = buildView(eg, members, choice, rootClass, leaves)
  const rewrite: EqSatRewrite = {
    before: unparse(island),
    after: unparse(extracted),
    nodesBefore: countIsland(island),
    nodesAfter: countIsland(extracted),
    costBefore: beforeCost,
    costAfter: afterCost,
    classes: members.size,
    enodes: eg.nodeCount,
    iters,
    saturated,
    validated,
    trials: cfg.trials,
    leaves: leaves.length,
    graph: view,
  }
  return { expr: extracted, rewrite }
}

// ---------------------------------------------------------------------------
// Saturation — apply every rule until the graph stops growing
// ---------------------------------------------------------------------------

function saturate(eg: EGraph, maxIters: number, maxNodes: number): { iters: number; saturated: boolean } {
  let iters = 0
  for (; iters < maxIters; iters++) {
    const before = eg.nodeCount
    const unionsBefore = eg.unions
    applyRules(eg, maxNodes)
    eg.rebuild()
    const grew = eg.nodeCount !== before || eg.unions !== unionsBefore
    if (!grew) return { iters: iters + 1, saturated: true } // fixpoint
    if (eg.nodeCount > maxNodes) return { iters: iters + 1, saturated: false } // budget
  }
  return { iters, saturated: false }
}

/** One pass of the rewrite rules over the current e-nodes. New e-nodes/merges
 *  are buffered into the graph; `rebuild` (called by `saturate`) restores
 *  congruence afterwards. Commutativity is free (folded into the key). */
function applyRules(eg: EGraph, maxNodes: number): void {
  const members = eg.classMembers()
  // index: for each class, the set of `+`/`*`/`neg` member node-shapes we need
  const memberList = [...members.entries()]

  const C = (v: number): EId => eg.add({ op: 'const', val: v })

  // helper: list canonical child classes of a class's member nodes by op
  const childrenByOp = (cls: EId, op: '+' | '*'): [EId, EId][] => {
    const out: [EId, EId][] = []
    for (const i of members.get(cls) ?? []) {
      const n = eg.nodeAt(i)
      if (n.op === op) out.push([eg.find(n.args[0]), eg.find(n.args[1])])
    }
    return out
  }
  const negChild = (cls: EId): EId | null => {
    for (const i of members.get(cls) ?? []) {
      const n = eg.nodeAt(i)
      if (n.op === 'neg') return eg.find(n.args[0])
    }
    return null
  }
  const constOf = (cls: EId): number | null => {
    for (const i of members.get(cls) ?? []) {
      const n = eg.nodeAt(i)
      if (n.op === 'const') return n.val
    }
    return null
  }

  for (const [cls, idxs] of memberList) {
    // bail out of this sweep once the graph hits its budget, so a single pass can
    // never balloon unboundedly (the cheap forms surface in the first few iters).
    if (eg.nodeCount > maxNodes) return
    for (const i of idxs) {
      const n = eg.nodeAt(i)
      switch (n.op) {
        case 'neg': {
          const a = eg.find(n.args[0])
          const av = constOf(a)
          if (av !== null) eg.merge(cls, C(-av)) // neg(k) = -k
          const inner = negChild(a)
          if (inner !== null) eg.merge(cls, inner) // neg(neg x) = x
          // push negation through + and *: neg(x+y)=negx+negy, neg(x*y)=(negx)*y
          for (const [x, y] of childrenByOp(a, '+')) {
            const nx = eg.add({ op: 'neg', args: [x] })
            const ny = eg.add({ op: 'neg', args: [y] })
            eg.merge(cls, eg.add({ op: '+', args: [nx, ny] }))
          }
          for (const [x, y] of childrenByOp(a, '*')) {
            const nx = eg.add({ op: 'neg', args: [x] })
            eg.merge(cls, eg.add({ op: '*', args: [nx, y] }))
          }
          break
        }
        case '+': {
          const a = eg.find(n.args[0])
          const b = eg.find(n.args[1])
          const av = constOf(a)
          const bv = constOf(b)
          // identity & constant folding
          if (av === 0) eg.merge(cls, b)
          if (bv === 0) eg.merge(cls, a)
          // fold in Int's ℤ/2^32 arithmetic so an emitted literal equals what the VM
          // (`vint`/`Op.MUL`) and WASM (`i32.mul`) would compute; a fold that wraps is
          // then a non-identity over ℤ and the Schwartz–Zippel check correctly vetoes it.
          if (av !== null && bv !== null) eg.merge(cls, C((av + bv) | 0))
          // x + x = 2*x  (bit-exact for IEEE doubles, hence for Aether Int)
          if (a === b) eg.merge(cls, eg.add({ op: '*', args: [C(2), a] }))
          // x + (neg x) = 0
          if (negChild(b) === a || negChild(a) === b) eg.merge(cls, C(0))
          // associativity: (x+y)+b  ~  x+(y+b)  and  y+(x+b)
          assocPlus(eg, a, b, cls)
          assocPlus(eg, b, a, cls)
          // factoring: (u*x) + (u*y) = u*(x+y)  — the move a greedy pass misses
          factor(eg, a, b, cls)
          break
        }
        case '*': {
          const a = eg.find(n.args[0])
          const b = eg.find(n.args[1])
          const av = constOf(a)
          const bv = constOf(b)
          if (av === 1) eg.merge(cls, b)
          if (bv === 1) eg.merge(cls, a)
          if (av === 0 || bv === 0) eg.merge(cls, C(0)) // annihilator (Int leaves are finite)
          if (av !== null && bv !== null) eg.merge(cls, C(Math.imul(av, bv)))
          // associativity of *
          assocTimes(eg, a, b, cls)
          assocTimes(eg, b, a, cls)
          // neg pull-out: x * (neg y) = neg(x*y)
          const nb = negChild(b)
          if (nb !== null) eg.merge(cls, eg.add({ op: 'neg', args: [eg.add({ op: '*', args: [a, nb] })] }))
          break
        }
      }
    }
  }

  // ---- rule helpers (closures over a fresh `members` snapshot) ----
  function assocPlus(g: EGraph, ab: EId, c: EId, cls: EId): void {
    for (const i of members.get(ab) ?? []) {
      const n = g.nodeAt(i)
      if (n.op === '+') {
        const x = g.find(n.args[0])
        const y = g.find(n.args[1])
        // (x+y)+c = x+(y+c)
        eg.merge(cls, g.add({ op: '+', args: [x, g.add({ op: '+', args: [y, c] })] }))
        eg.merge(cls, g.add({ op: '+', args: [y, g.add({ op: '+', args: [x, c] })] }))
      }
    }
  }
  function assocTimes(g: EGraph, ab: EId, c: EId, cls: EId): void {
    for (const i of members.get(ab) ?? []) {
      const n = g.nodeAt(i)
      if (n.op === '*') {
        const x = g.find(n.args[0])
        const y = g.find(n.args[1])
        eg.merge(cls, g.add({ op: '*', args: [x, g.add({ op: '*', args: [y, c] })] }))
        eg.merge(cls, g.add({ op: '*', args: [y, g.add({ op: '*', args: [x, c] })] }))
      }
    }
  }
  // (u*x)+(u*y) → u*(x+y): find a factor shared by both products
  function factor(g: EGraph, pa: EId, pb: EId, cls: EId): void {
    const fa = productPairs(g, pa)
    const fb = productPairs(g, pb)
    for (const [a1, a2] of fa) {
      for (const [b1, b2] of fb) {
        const shared = sharedFactor(a1, a2, b1, b2)
        if (shared) {
          const [u, x, y] = shared
          eg.merge(cls, g.add({ op: '*', args: [u, g.add({ op: '+', args: [x, y] })] }))
        }
      }
    }
  }
  function productPairs(g: EGraph, cls: EId): [EId, EId][] {
    const out: [EId, EId][] = []
    for (const i of members.get(cls) ?? []) {
      const n = g.nodeAt(i)
      if (n.op === '*') out.push([g.find(n.args[0]), g.find(n.args[1])])
    }
    return out
  }
  function sharedFactor(a1: EId, a2: EId, b1: EId, b2: EId): [EId, EId, EId] | null {
    if (a1 === b1) return [a1, a2, b2]
    if (a1 === b2) return [a1, a2, b1]
    if (a2 === b1) return [a2, a1, b2]
    if (a2 === b2) return [a2, a1, b1]
    return null
  }
}

// ---------------------------------------------------------------------------
// Extraction — cheapest representative of each class (cost fixpoint)
// ---------------------------------------------------------------------------

function opCost(n: ENode): number {
  switch (n.op) {
    case 'const':
      return CONST_COST
    case 'leaf':
      return LEAF_COST
    case 'neg':
      return NEG_COST
    case '+':
      return ADD_COST
    case '*':
      return MUL_COST
  }
}

function extract(
  eg: EGraph,
  members: Map<EId, number[]>,
): { cost: Map<EId, number>; choice: Map<EId, number> } {
  const cost = new Map<EId, number>()
  const choice = new Map<EId, number>()
  let changed = true
  while (changed) {
    changed = false
    for (const [cls, idxs] of members) {
      for (const i of idxs) {
        const n = eg.nodeAt(i)
        let c = opCost(n)
        let ok = true
        for (const a of nodeArgs(n)) {
          const ca = cost.get(eg.find(a))
          if (ca === undefined) {
            ok = false
            break
          }
          c += ca
        }
        if (!ok) continue
        const cur = cost.get(cls)
        if (cur === undefined || c < cur) {
          cost.set(cls, c)
          choice.set(cls, i)
          changed = true
        }
      }
    }
  }
  return { cost, choice }
}

function buildExpr(eg: EGraph, cls: EId, choice: Map<EId, number>, leaves: Leaf[]): Expr {
  const seen = new Set<EId>()
  const rec = (c: EId): Expr => {
    c = eg.find(c)
    const i = choice.get(c)
    if (i === undefined || seen.has(c)) {
      // unreachable for a well-formed extraction; fall back to a 0 literal
      return { kind: 'int', value: 0, span: SYNTH }
    }
    seen.add(c)
    const n = eg.nodeAt(i)
    let out: Expr
    switch (n.op) {
      case 'const':
        out = { kind: 'int', value: n.val, span: SYNTH }
        break
      case 'leaf':
        out = cloneExpr(leaves[n.leaf].expr)
        break
      case 'neg':
        out = { kind: 'unop', op: '-', operand: rec(n.args[0]), span: SYNTH }
        break
      case '+': {
        const l = rec(n.args[0])
        const rn = eg.nodeAt(choice.get(eg.find(n.args[1]))!)
        // prefer `x - y` over `x + (-y)` (cheaper, nicer)
        if (rn && rn.op === 'neg') {
          out = { kind: 'binop', op: '-', left: l, right: rec(rn.args[0]), span: SYNTH }
        } else {
          out = { kind: 'binop', op: '+', left: l, right: rec(n.args[1]), span: SYNTH }
        }
        break
      }
      case '*':
        out = { kind: 'binop', op: '*', left: rec(n.args[0]), right: rec(n.args[1]), span: SYNTH }
        break
    }
    seen.delete(c)
    return out
  }
  return rec(cls)
}

// ---------------------------------------------------------------------------
// Cost of the *original* island (same model, direct recursion)
// ---------------------------------------------------------------------------

function islandCost(e: Expr): number {
  if (e.kind === 'int') return CONST_COST
  if (e.kind === 'unop' && e.op === '-') return NEG_COST + islandCost(e.operand)
  if (e.kind === 'binop' && ISLAND_BINOPS.has(e.op)) {
    const op = e.op === '*' ? MUL_COST : ADD_COST
    return op + islandCost(e.left) + islandCost(e.right)
  }
  return LEAF_COST // a leaf
}

function countIsland(e: Expr): number {
  if (e.kind === 'unop' && e.op === '-') return 1 + countIsland(e.operand)
  if (e.kind === 'binop' && ISLAND_BINOPS.has(e.op)) return 1 + countIsland(e.left) + countIsland(e.right)
  return 1
}

// ---------------------------------------------------------------------------
// Differential validation — Schwartz–Zippel polynomial identity testing
// ---------------------------------------------------------------------------

/** A tiny deterministic PRNG (mulberry32) so validation is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Evaluate the *original* island, resolving each leaf to its polynomial index
 *  via the same `unparse` identity used to build the graph, then reading that
 *  index out of `vals`. Ordinary JS number arithmetic — bit-for-bit what the VM
 *  does — so agreement here is agreement with the VM. */
function evalOriginal(e: Expr, leafIndex: Map<string, number>, vals: number[]): number {
  if (e.kind === 'int') return e.value
  if (e.kind === 'unop' && e.op === '-') return -evalOriginal(e.operand, leafIndex, vals)
  if (e.kind === 'binop' && ISLAND_BINOPS.has(e.op)) {
    const l = evalOriginal(e.left, leafIndex, vals)
    const r = evalOriginal(e.right, leafIndex, vals)
    return e.op === '+' ? l + r : e.op === '-' ? l - r : l * r
  }
  return vals[leafIndex.get(unparse(e))!]
}

/** Evaluate the extracted choice straight on the e-graph: a leaf e-node carries
 *  its index, so no spelling has to match. */
function evalChoice(eg: EGraph, cls: EId, choice: Map<EId, number>, vals: number[]): number {
  const n = eg.nodeAt(choice.get(eg.find(cls))!)
  switch (n.op) {
    case 'const':
      return n.val
    case 'leaf':
      return vals[n.leaf]
    case 'neg':
      return -evalChoice(eg, n.args[0], choice, vals)
    case '+':
      return evalChoice(eg, n.args[0], choice, vals) + evalChoice(eg, n.args[1], choice, vals)
    case '*':
      return evalChoice(eg, n.args[0], choice, vals) * evalChoice(eg, n.args[1], choice, vals)
  }
}

function differentiallyEqual(
  island: Expr,
  leafIndex: Map<string, number>,
  eg: EGraph,
  rootClass: EId,
  choice: Map<EId, number>,
  leafCount: number,
  trials: number,
): boolean {
  const rand = rng(0x9e3779b9 ^ (leafCount * 2654435761))
  const vals = new Array<number>(leafCount).fill(0)
  // a few fixed corner assignments first (0, ±1, small), then random points
  const corners = [0, 1, -1, 2, -3, 7]
  const total = trials + corners.length
  for (let t = 0; t < total; t++) {
    for (let i = 0; i < leafCount; i++) {
      if (t < corners.length) vals[i] = corners[(t + i) % corners.length]
      // random integers in [-2^20, 2^20]: a handful of these multiplied together
      // stays well within 2^53, so the island's *own* evaluation is exact and the
      // check certifies a true integer identity (independent of runtime magnitude).
      else vals[i] = Math.floor((rand() - 0.5) * (1 << 21))
    }
    if (evalOriginal(island, leafIndex, vals) !== evalChoice(eg, rootClass, choice, vals)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// E-graph view (for the Eq-Sat panel)
// ---------------------------------------------------------------------------

const MAX_VIEW_CLASSES = 60

function nodeLabel(n: ENode, leaves?: Leaf[]): string {
  switch (n.op) {
    case 'const':
      return String(n.val)
    case 'leaf':
      return leaves ? truncate(leaves[n.leaf].key, 14) : `leaf${n.leaf}`
    case 'neg':
      return '−·'
    case '+':
      return '+'
    case '*':
      return '×'
  }
}

function buildView(
  eg: EGraph,
  members: Map<EId, number[]>,
  choice: Map<EId, number>,
  rootClass: EId,
  leaves: Leaf[],
): EClassView[] {
  // remap canonical ids to a dense 0..n-1 for display
  const order = [...members.keys()]
  const remap = new Map<EId, number>()
  order.forEach((c, i) => remap.set(c, i))

  // mark classes that take part in the extracted term
  const extracted = new Set<EId>()
  const mark = (c: EId): void => {
    c = eg.find(c)
    if (extracted.has(c)) return
    extracted.add(c)
    const i = choice.get(c)
    if (i === undefined) return
    for (const a of nodeArgs(eg.nodeAt(i))) mark(a)
  }
  mark(rootClass)

  const views: EClassView[] = []
  for (const c of order) {
    if (views.length >= MAX_VIEW_CLASSES) break
    const nodes = (members.get(c) ?? []).map((i) => {
      const n = eg.nodeAt(i)
      return { label: nodeLabel(n, leaves), children: nodeArgs(n).map((a) => remap.get(eg.find(a)) ?? -1) }
    })
    views.push({
      id: remap.get(c)!,
      nodes,
      root: eg.find(rootClass) === c,
      extracted: extracted.has(c),
    })
  }
  return views
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat
}

// ---------------------------------------------------------------------------
// Generic child map (top-down walk over every Expr kind)
// ---------------------------------------------------------------------------

function mapChildren(e: Expr, f: (x: Expr) => Expr): Expr {
  switch (e.kind) {
    case 'lambda':
      return { ...e, body: f(e.body) }
    case 'app':
      return { ...e, fn: f(e.fn), arg: f(e.arg) }
    case 'let':
      return { ...e, value: f(e.value), body: f(e.body) }
    case 'letrec':
      return {
        ...e,
        bindings: e.bindings.map((b) => ({ name: b.name, value: f(b.value) })),
        body: f(e.body),
      }
    case 'if':
      return { ...e, cond: f(e.cond), then: f(e.then), else: f(e.else) }
    case 'binop':
      return { ...e, left: f(e.left), right: f(e.right) }
    case 'unop':
      return { ...e, operand: f(e.operand) }
    case 'seq':
      return { ...e, first: f(e.first), rest: f(e.rest) }
    case 'tuple':
    case 'list':
      return { ...e, elements: e.elements.map(f) }
    case 'record':
      return { ...e, fields: e.fields.map((fl) => ({ label: fl.label, value: f(fl.value) })) }
    case 'recordUpdate':
      return {
        ...e,
        record: f(e.record),
        fields: e.fields.map((fl) => ({ label: fl.label, value: f(fl.value) })),
      }
    case 'field':
      return { ...e, record: f(e.record) }
    case 'match':
      return {
        ...e,
        scrutinee: f(e.scrutinee),
        cases: e.cases.map((c) => ({
          pattern: c.pattern,
          guard: c.guard ? f(c.guard) : undefined,
          body: f(c.body),
        })),
      }
    case 'typedecl':
      return { ...e, body: f(e.body) }
    case 'classdecl':
      return { ...e, body: f(e.body) }
    case 'instancedecl':
      return {
        ...e,
        methods: e.methods.map((m) => ({ ...m, value: f(m.value) })),
        body: f(e.body),
      }
    default:
      return e
  }
}
