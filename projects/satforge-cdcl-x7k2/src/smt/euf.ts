// EUF — the theory of Equality and Uninterpreted Functions — by proof-producing
// congruence closure (Nieuwenhuis & Oliveras, 2007).
//
// Every term is *curried* into binary applications, so the only structural facts
// are `apply(x, y) = z`. The algorithm maintains union-find classes plus a
// `lookup` table that detects congruences (if a₁≡b₁, a₂≡b₂ and apply(a₁,a₂)=c₁,
// apply(b₁,b₂)=c₂ then c₁≡c₂) and a *proof forest* that lets us, given a derived
// equality x≡y, reconstruct the minimal set of originally-asserted equalities
// that forced it. That explanation is what becomes a theory-conflict clause in
// DPLL(T): without it the SMT loop would have to block one full model at a time.

import type { Atom, Term, TermManager } from './term'

export interface TheoryLit {
  atom: Atom
  value: boolean
}

export interface TheoryResult {
  ok: boolean
  /** When !ok: a subset of the asserted literals that is jointly inconsistent. */
  conflict?: TheoryLit[]
  /** A theory may report it could not decide (e.g. integer branch-and-bound cap). */
  unknown?: boolean
}

// A union edge in the proof forest carries the reason it was created.
type Reason =
  | { kind: 'input'; lit: TheoryLit } // an asserted equality a=b
  | { kind: 'cong'; a: number; b: number } // congruence: apply nodes a,b became equal

export class EufSolver {
  private nNodes = 0
  private repr: number[] = []
  private classList: number[][] = [] // class id (repr) -> member nodes
  private size: number[] = []
  // application registry: appNode id -> {fn, arg}; and a structural lookup.
  private appOf: { fn: number; arg: number }[] = []
  private isApp: boolean[] = []
  private origUse: number[][] = [] // node -> apply-node ids that use it (immutable, built once)
  private use: number[][] = [] // per-check working copy, accumulated at class representatives
  private lookupTbl = new Map<string, number>() // (repr(fn),repr(arg)) -> apply node
  // proof forest (each node points to a parent with the reason that linked them)
  private pfParent: number[] = []
  private pfReason: (Reason | null)[] = []

  // term/symbol -> node id
  private symNode = new Map<string, number>()
  private termNode = new Map<number, number>()
  private applyCache = new Map<string, number>()
  // Boolean constants for predicate encoding.
  readonly TRUE: number
  readonly FALSE: number

  private tm: TermManager
  constructor(tm: TermManager) {
    this.tm = tm
    this.TRUE = this.freshNode()
    this.FALSE = this.freshNode()
  }

  private freshNode(): number {
    const id = this.nNodes++
    this.repr[id] = id
    this.classList[id] = [id]
    this.size[id] = 1
    this.origUse[id] = []
    this.use[id] = []
    this.isApp[id] = false
    this.pfParent[id] = -1
    this.pfReason[id] = null
    return id
  }

  private symbolNode(sym: string): number {
    let n = this.symNode.get(sym)
    if (n === undefined) {
      n = this.freshNode()
      this.symNode.set(sym, n)
    }
    return n
  }

  /** Build (and cache) the curried node for a term, registering apply equations. */
  nodeOf(t: Term): number {
    const cached = this.termNode.get(t.id)
    if (cached !== undefined) return cached
    this.termsById.set(t.id, t)
    let node: number
    if (t.args.length === 0) {
      // A constant symbol (or numeric literal): its own fresh node.
      node = this.symbolNode(t.kind === 'num' ? `#${t.num!.toString()}` : t.op)
    } else {
      let cur = this.symbolNode(t.op)
      for (const arg of t.args) cur = this.mkApply(cur, this.nodeOf(arg))
      node = cur
    }
    this.termNode.set(t.id, node)
    return node
  }

  private mkApply(fn: number, arg: number): number {
    const key = `${fn}.${arg}`
    const hit = this.applyCache.get(key)
    if (hit !== undefined) return hit
    const node = this.freshNode()
    this.isApp[node] = true
    this.appOf[node] = { fn, arg }
    this.applyCache.set(key, node)
    this.origUse[fn].push(node)
    if (arg !== fn) this.origUse[arg].push(node)
    return node
  }

  private find(x: number): number {
    while (this.repr[x] !== x) {
      this.repr[x] = this.repr[this.repr[x]]
      x = this.repr[x]
    }
    return x
  }

  owns(atom: Atom): boolean {
    return atom.kind === 'eq' || atom.kind === 'pred'
  }

  /** After a consistent check, list the congruence classes (term-id groups). */
  describeModel(lits: TheoryLit[]): string[] {
    this.check(lits) // re-establish classes
    const classes = new Map<number, Term[]>()
    for (const [tid, node] of this.termNode) {
      const r = this.find(node)
      const term = this.termsById.get(tid)
      if (!term) continue
      if (!classes.has(r)) classes.set(r, [])
      classes.get(r)!.push(term)
    }
    const out: string[] = []
    for (const group of classes.values()) {
      if (group.length > 1) out.push(group.map((t) => this.tm.termToString(t)).join(' = '))
    }
    return out
  }

  // map term id -> Term, captured as we build nodes (for describeModel)
  private termsById = new Map<number, Term>()

  // ---- main entry: check consistency of a conjunction of literals ------------
  check(lits: TheoryLit[]): TheoryResult {
    // Ensure every term node exists *before* resetUnion sets up the use/lookup
    // tables, so lazily-built apply nodes still participate in congruence.
    for (const l of lits) {
      const a = l.atom
      if (a.kind === 'eq') {
        this.nodeOf(a.a)
        this.nodeOf(a.b)
      } else if (a.kind === 'pred') {
        this.nodeOf(a.term)
      }
    }
    // Reset mutable union-find / proof state but keep the node graph.
    this.resetUnion()

    const diseqs: { a: number; b: number; lit: TheoryLit }[] = []
    // 1) process all asserted equalities (positive), collect disequalities.
    for (const l of lits) {
      const a = l.atom
      if (a.kind === 'eq') {
        const na = this.nodeOf(a.a)
        const nb = this.nodeOf(a.b)
        if (l.value) this.unionNodes(na, nb, { kind: 'input', lit: l })
        else diseqs.push({ a: na, b: nb, lit: l })
      } else if (a.kind === 'pred') {
        // A predicate literal is always an equality: term ≡ (value ? ⊤ : ⊥).
        const t = this.nodeOf(a.term)
        this.unionNodes(t, l.value ? this.TRUE : this.FALSE, { kind: 'input', lit: l })
      }
      // arithmetic atoms are not EUF-relevant — ignored.
    }
    // built-in ⊤ ≠ ⊥
    diseqs.push({ a: this.TRUE, b: this.FALSE, lit: { atom: { id: -999, kind: 'pred', term: undefined as unknown as Term }, value: true } })

    // 2) every disequality must straddle two distinct classes.
    for (const dq of diseqs) {
      if (this.find(dq.a) === this.find(dq.b)) {
        const expl = this.explain(dq.a, dq.b)
        // The conflict is {a=b explanation} ∪ {a≠b literal}, unless the diseq is the
        // built-in TRUE≠FALSE (id -999), which carries no asserted literal.
        const conflict = dq.lit.atom.id === -999 ? expl : [...expl, dq.lit]
        return { ok: false, conflict: dedupeLits(conflict) }
      }
    }
    return { ok: true }
  }

  private resetUnion(): void {
    for (let i = 0; i < this.nNodes; i++) {
      this.repr[i] = i
      this.classList[i] = [i]
      this.size[i] = 1
      this.use[i] = this.origUse[i].slice()
      this.pfParent[i] = -1
      this.pfReason[i] = null
    }
    this.lookupTbl.clear()
    // rebuild lookup with all current (singleton) classes
    for (let n = 0; n < this.nNodes; n++) {
      if (this.isApp[n]) {
        const { fn, arg } = this.appOf[n]
        const lk = `${this.find(fn)}.${this.find(arg)}`
        if (!this.lookupTbl.has(lk)) this.lookupTbl.set(lk, n)
      }
    }
  }

  // ---- union with congruence propagation -------------------------------------
  private unionNodes(a: number, b: number, reason: Reason): void {
    const pending: { a: number; b: number; r: Reason }[] = [{ a, b, r: reason }]
    while (pending.length) {
      const { a: x, b: y, r } = pending.pop()!
      const rx = this.find(x)
      const ry = this.find(y)
      if (rx === ry) continue
      // record proof-forest edge between the *original* endpoints x,y (reverse the
      // smaller proof tree so we can root it at x).
      this.addProofEdge(x, y, r)
      // union by size (smaller class merged into larger)
      let big = rx
      let small = ry
      if (this.size[big] < this.size[small]) [big, small] = [small, big]
      // gather use-list of `small` to re-examine for new congruences
      const movedUses = this.use[small]
      for (const m of this.classList[small]) {
        this.repr[m] = big
        this.classList[big].push(m)
      }
      this.size[big] += this.size[small]
      this.classList[small] = []
      // re-canonicalize lookups for moved applications
      for (const u of movedUses) {
        this.use[big].push(u)
        if (!this.isApp[u]) continue
        const { fn, arg } = this.appOf[u]
        const lk = `${this.find(fn)}.${this.find(arg)}`
        const ex = this.lookupTbl.get(lk)
        if (ex === undefined) this.lookupTbl.set(lk, u)
        else if (this.find(ex) !== this.find(u)) pending.push({ a: u, b: ex, r: { kind: 'cong', a: u, b: ex } })
      }
    }
  }

  // ---- proof forest ----------------------------------------------------------
  private addProofEdge(a: number, b: number, r: Reason): void {
    // Reroot a's tree at a, then attach a under b.
    this.reroot(a)
    this.pfParent[a] = b
    this.pfReason[a] = r
  }

  private reroot(x: number): void {
    let prev = -1
    let prevReason: Reason | null = null
    let cur = x
    while (cur !== -1) {
      const nextParent = this.pfParent[cur]
      const nextReason = this.pfReason[cur]
      this.pfParent[cur] = prev
      this.pfReason[cur] = prevReason
      prev = cur
      prevReason = nextReason
      cur = nextParent
    }
  }

  /** Path of nodes from x up to the proof-forest root. */
  private pathToRoot(x: number): number[] {
    const path: number[] = []
    let cur = x
    while (cur !== -1) {
      path.push(cur)
      cur = this.pfParent[cur]
    }
    return path
  }

  /** Explain why a≡b: the set of originally-asserted literals that forced it. */
  private explain(a: number, b: number): TheoryLit[] {
    const out: TheoryLit[] = []
    const visited = new Set<string>()
    const stack: [number, number][] = [[a, b]]
    while (stack.length) {
      const [x, y] = stack.pop()!
      if (x === y) continue
      const key = x < y ? `${x},${y}` : `${y},${x}`
      if (visited.has(key)) continue
      visited.add(key)
      // find nearest common ancestor in the proof forest and walk both sides.
      const px = this.pathToRoot(x)
      const onPx = new Set(px)
      let ancestor = -1
      for (const n of this.pathToRoot(y)) {
        if (onPx.has(n)) {
          ancestor = n
          break
        }
      }
      this.collectEdges(x, ancestor, out, stack)
      this.collectEdges(y, ancestor, out, stack)
    }
    return out
  }

  private collectEdges(from: number, to: number, out: TheoryLit[], stack: [number, number][]): void {
    let cur = from
    while (cur !== to && cur !== -1) {
      const r = this.pfReason[cur]
      const parent = this.pfParent[cur]
      if (r) {
        if (r.kind === 'input') out.push(r.lit)
        else {
          // congruence edge between two apply nodes: recurse on their fn/arg.
          const ax = this.appOf[r.a]
          const bx = this.appOf[r.b]
          stack.push([ax.fn, bx.fn])
          stack.push([ax.arg, bx.arg])
        }
      }
      cur = parent
    }
  }
}

function dedupeLits(lits: TheoryLit[]): TheoryLit[] {
  const seen = new Set<string>()
  const out: TheoryLit[] = []
  for (const l of lits) {
    if (l.atom.id < 0) continue // skip the synthetic ⊤≠⊥ literal
    const k = `${l.atom.id}:${l.value}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(l)
  }
  return out
}
