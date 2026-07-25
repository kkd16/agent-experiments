// A from-scratch **e-graph** — the data structure behind equality saturation
// (Nelson's congruence closure promoted to a rewrite engine; the "egg" design,
// Willsey et al., POPL 2021). An e-graph compactly represents a whole
// *equivalence class of terms*: e-nodes (operators over child **e-classes**) are
// hash-consed and de-duplicated, a union-find merges classes proven equal, and a
// deferred **rebuild** restores the congruence invariant — "if x≡x′ and y≡y′ then
// f(x,y) ≡ f(x′,y′)" — in amortized near-linear time instead of after every union.
//
// On top of that sits an **e-class analysis** (Willsey §4): a lattice value
// attached to each class, here the class's constant integer value when it is one.
// Its `modify` hook folds `2*3` into `6` *inside the graph*, unioning the constant
// in — so constant folding falls out of the same machinery as the rewrites.
//
// Nothing here is float-y or approximate: the whole structure is exact, and
// `checkInvariants()` is an independent structural oracle the studio runs after
// every mutation, exactly like the B+Tree / LSM / BDD engines elsewhere.

import type { Term } from './term'
import { isNum, num } from './term'

export type EClassId = number

/** An e-node: an operator applied to child **e-classes** (not child e-nodes). */
export interface ENode {
  op: string
  children: EClassId[]
}

interface EClass {
  id: EClassId
  /** The e-nodes in this class (canonicalized lazily; deduped on rebuild). */
  nodes: ENode[]
  /** Parent e-nodes that reference this class, with their owning class. */
  parents: Array<{ node: ENode; cls: EClassId }>
  /** E-class analysis: the class's exact constant value, or null if unknown. */
  data: bigint | null
}

/** Canonical string key of a *canonicalized* e-node (for the hashcons). */
function enodeKey(n: ENode): string {
  return n.children.length === 0 ? n.op : `${n.op}(${n.children.join(',')})`
}

export class EGraph {
  private unionfind: EClassId[] = []
  private classes = new Map<EClassId, EClass>()
  private hashcons = new Map<string, EClassId>()
  private worklist: EClassId[] = []
  private analysisPending: EClassId[] = []

  /** Cheap O(1) "work done" meters: merges performed and fresh classes created.
   *  A full saturation pass that changes neither has reached a fixpoint. */
  totalUnions = 0
  totalAdds = 0

  // ---- union-find ----------------------------------------------------------

  find(x: EClassId): EClassId {
    let r = x
    while (this.unionfind[r] !== r) r = this.unionfind[r]
    // Path compression.
    while (this.unionfind[x] !== r) {
      const next = this.unionfind[x]
      this.unionfind[x] = r
      x = next
    }
    return r
  }

  equiv(a: EClassId, b: EClassId): boolean {
    return this.find(a) === this.find(b)
  }

  // ---- analysis (constant folding) ----------------------------------------

  /** Compute a fresh e-node's analysis value from its children's. */
  private makeData(n: ENode): bigint | null {
    if (n.children.length === 0) return isNum(n.op) ? BigInt(n.op) : null
    const cs = n.children.map((c) => this.classes.get(this.find(c))?.data ?? null)
    if (cs.some((d) => d === null)) return null
    const v = cs as bigint[]
    switch (n.op) {
      case '+':
        return v.reduce((s, x) => s + x, 0n)
      case '*':
        return v.reduce((p, x) => p * x, 1n)
      case 'neg':
        return -v[0]
      case 'shl':
        return v[1] < 0n ? null : v[0] << v[1]
      default:
        return null
    }
  }

  private mergeData(a: bigint | null, b: bigint | null): bigint | null {
    if (a === null) return b
    if (b === null) return a
    // Two constants for the same class must agree — the structure is exact.
    if (a !== b) throw new Error(`analysis contradiction: ${a} vs ${b}`)
    return a
  }

  // ---- construction --------------------------------------------------------

  private canon(n: ENode): ENode {
    return n.children.length === 0
      ? n
      : { op: n.op, children: n.children.map((c) => this.find(c)) }
  }

  /** Add an e-node, returning its (canonical) e-class. Hash-consed. */
  add(node: ENode): EClassId {
    const n = this.canon(node)
    const key = enodeKey(n)
    const hit = this.hashcons.get(key)
    if (hit !== undefined) return this.find(hit)

    const id = this.unionfind.length
    this.totalAdds++
    this.unionfind.push(id)
    const cls: EClass = { id, nodes: [n], parents: [], data: this.makeData(n) }
    this.classes.set(id, cls)
    for (const c of n.children) {
      this.classes.get(this.find(c))!.parents.push({ node: n, cls: id })
    }
    this.hashcons.set(key, id)
    if (cls.data !== null) this.analysisPending.push(id)
    return id
  }

  /** Recursively add a whole term, returning its root e-class. */
  addTerm(t: Term): EClassId {
    return this.add({ op: t.op, children: t.args.map((a) => this.addTerm(a)) })
  }

  /** Merge two e-classes. Returns the surviving root. Call `rebuild()` after. */
  union(a: EClassId, b: EClassId): EClassId {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return ra
    this.totalUnions++

    // Union by size: keep the class with more parents as the root.
    const ca = this.classes.get(ra)!
    const cb = this.classes.get(rb)!
    const [root, child, rootCls, childCls] =
      ca.parents.length >= cb.parents.length ? [ra, rb, ca, cb] : [rb, ra, cb, ca]

    this.unionfind[child] = root
    this.classes.delete(child)
    rootCls.nodes.push(...childCls.nodes)
    rootCls.parents.push(...childCls.parents)
    const before = rootCls.data
    rootCls.data = this.mergeData(rootCls.data, childCls.data)

    this.worklist.push(root)
    if (rootCls.data !== null && rootCls.data !== before) this.analysisPending.push(root)
    return root
  }

  // ---- rebuild: restore congruence + apply analysis ------------------------

  /** Restore the congruence invariant after a batch of unions. */
  rebuild(): void {
    while (this.worklist.length > 0 || this.analysisPending.length > 0) {
      if (this.worklist.length > 0) {
        const todo = this.dedupRoots(this.worklist)
        this.worklist = []
        for (const id of todo) this.repair(id)
      }
      if (this.analysisPending.length > 0) {
        const todo = this.dedupRoots(this.analysisPending)
        this.analysisPending = []
        for (const id of todo) {
          const cls = this.classes.get(id)
          if (cls && cls.data !== null) {
            // Fold: introduce the constant node and union it in.
            const cid = this.add({ op: String(cls.data), children: [] })
            this.union(cid, id)
          }
        }
      }
    }
  }

  private dedupRoots(ids: EClassId[]): EClassId[] {
    const seen = new Set<EClassId>()
    const out: EClassId[] = []
    for (const id of ids) {
      const r = this.find(id)
      if (!seen.has(r)) {
        seen.add(r)
        out.push(r)
      }
    }
    return out
  }

  private repair(id: EClassId): void {
    const cls = this.classes.get(id)
    if (!cls) return
    // Re-canonicalize every parent e-node; a collision means two parents just
    // became congruent, so union their owning classes.
    const newParents = new Map<string, { node: ENode; cls: EClassId }>()
    for (const p of cls.parents) {
      this.hashcons.delete(enodeKey(p.node))
      const cn = this.canon(p.node)
      const key = enodeKey(cn)
      const existing = newParents.get(key)
      if (existing) this.union(existing.cls, p.cls)
      const root = this.find(p.cls)
      newParents.set(key, { node: cn, cls: root })
      this.hashcons.set(key, root)
    }
    cls.parents = [...newParents.values()]
  }

  // ---- read API ------------------------------------------------------------

  numClasses(): number {
    return this.classes.size
  }

  numNodes(): number {
    let n = 0
    for (const c of this.classes.values()) n += this.dedupNodes(c.nodes).length
    return n
  }

  /** The exact constant value of a class, if the analysis proved it constant. */
  constantOf(id: EClassId): bigint | null {
    return this.classes.get(this.find(id))?.data ?? null
  }

  private dedupNodes(nodes: ENode[]): ENode[] {
    const seen = new Set<string>()
    const out: ENode[] = []
    for (const n of nodes) {
      const cn = this.canon(n)
      const key = enodeKey(cn)
      if (!seen.has(key)) {
        seen.add(key)
        out.push(cn)
      }
    }
    return out
  }

  /** A render-ready snapshot: every live class with its canonical e-nodes. */
  snapshot(): Array<{ id: EClassId; nodes: ENode[]; data: bigint | null }> {
    const out: Array<{ id: EClassId; nodes: ENode[]; data: bigint | null }> = []
    for (const [id, cls] of this.classes) {
      if (this.find(id) !== id) continue
      out.push({ id, nodes: this.dedupNodes(cls.nodes), data: cls.data })
    }
    out.sort((a, b) => a.id - b.id)
    return out
  }

  /** Iterate the canonical e-nodes of a class (deduped). */
  nodesOf(id: EClassId): ENode[] {
    const cls = this.classes.get(this.find(id))
    return cls ? this.dedupNodes(cls.nodes) : []
  }

  liveRoots(): EClassId[] {
    return [...this.classes.keys()].filter((id) => this.find(id) === id)
  }

  // ---- structural oracle ---------------------------------------------------

  /**
   * Independent invariant checker — the congruence-closure analogue of the
   * B+Tree's `checkInvariants`. Returns the list of violations (empty = sound).
   */
  checkInvariants(): string[] {
    const errs: string[] = []

    // (1) The hashcons must map each class's canonical nodes back to that class.
    for (const id of this.liveRoots()) {
      for (const n of this.nodesOf(id)) {
        const mapped = this.hashcons.get(enodeKey(n))
        if (mapped === undefined) {
          errs.push(`hashcons missing node ${enodeKey(n)} of class ${id}`)
        } else if (this.find(mapped) !== id) {
          errs.push(`hashcons: ${enodeKey(n)} → ${this.find(mapped)}, expected ${id}`)
        }
      }
    }

    // (2) Congruence closed: no canonical e-node appears in two distinct classes.
    const owner = new Map<string, EClassId>()
    for (const id of this.liveRoots()) {
      for (const n of this.nodesOf(id)) {
        const key = enodeKey(n)
        const prev = owner.get(key)
        if (prev !== undefined && prev !== id) {
          errs.push(`congruence broken: ${key} in classes ${prev} and ${id}`)
        }
        owner.set(key, id)
      }
    }

    // (3) Analysis soundness: a class flagged constant must actually contain that
    //     constant node, and never two different constant literals.
    for (const id of this.liveRoots()) {
      const cls = this.classes.get(id)!
      const consts = this.nodesOf(id).filter((n) => n.children.length === 0 && isNum(n.op))
      const values = new Set(consts.map((n) => n.op))
      if (values.size > 1) errs.push(`class ${id} holds distinct constants {${[...values].join(',')}}`)
      if (cls.data !== null && !values.has(String(cls.data))) {
        errs.push(`class ${id} data=${cls.data} but no matching constant node`)
      }
    }

    return errs
  }
}

/** Convenience: the constant e-node for a bigint (mirrors `term.num`). */
export function constNode(v: bigint): ENode {
  return { op: num(v).op, children: [] }
}
