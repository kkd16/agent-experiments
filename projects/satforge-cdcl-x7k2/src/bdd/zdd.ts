// Zero-suppressed Binary Decision Diagrams (ZDDs), Minato's variant of the BDD.
//
// Where a BDD canonically represents a Boolean *function*, a ZDD canonically
// represents a *family of subsets* (a set of sets). It swaps one reduction rule:
// instead of eliding a node whose two children agree, a ZDD elides a node whose
// 1-edge (the "include this element" branch) leads to the empty family ∅. That
// single change makes sparse set systems — combinations, matchings, paths —
// dramatically more compact than the same family as a BDD.
//
// Terminals: 0 is ∅ (the family containing NO sets); 1 is {∅} (the family whose
// only member is the empty set). An internal node (v, lo, hi) means: the sets
// that do NOT contain v (described by lo) together with the sets that DO contain
// v (described by hi, with v then added back). All set algebra below is a single
// recursion on the topmost element, memoized — exactly mirroring the BDD apply.

export type ZNode = number

export const ZDD_EMPTY: ZNode = 0 // ∅      — no sets at all
export const ZDD_UNIT: ZNode = 1 // {∅}    — the family of just the empty set

export class Zdd {
  readonly numVars: number
  order: number[]
  pos: number[]

  private vv: number[]
  private lo: ZNode[]
  private hi: ZNode[]
  private unique = new Map<string, ZNode>()
  private opMemo = new Map<string, ZNode>()

  constructor(numVars: number, order?: number[]) {
    this.numVars = numVars
    this.order = order ? order.slice() : Array.from({ length: numVars }, (_, i) => i)
    this.pos = new Array<number>(numVars)
    for (let lvl = 0; lvl < numVars; lvl++) this.pos[this.order[lvl]] = lvl
    this.vv = [numVars, numVars]
    this.lo = [ZDD_EMPTY, ZDD_UNIT]
    this.hi = [ZDD_EMPTY, ZDD_UNIT]
  }

  varOf(z: ZNode): number {
    return this.vv[z]
  }
  low(z: ZNode): ZNode {
    return this.lo[z]
  }
  high(z: ZNode): ZNode {
    return this.hi[z]
  }
  levelOf(z: ZNode): number {
    return z < 2 ? this.numVars : this.pos[this.vv[z]]
  }

  /** The ZDD reduction: suppress a node whose include-branch is ∅, then share. */
  mk(v: number, lo: ZNode, hi: ZNode): ZNode {
    if (hi === ZDD_EMPTY) return lo // zero-suppression rule
    const key = v + ':' + lo + ':' + hi
    const found = this.unique.get(key)
    if (found !== undefined) return found
    const id = this.vv.length
    this.vv.push(v)
    this.lo.push(lo)
    this.hi.push(hi)
    this.unique.set(key, id)
    return id
  }

  // Decompose z at element v (v must be at or above z's top level).
  private cof(z: ZNode, v: number): [ZNode, ZNode] {
    if (this.vv[z] === v) return [this.lo[z], this.hi[z]]
    return [z, ZDD_EMPTY] // z has no v-node ⇒ no set contains v
  }

  private topVar(a: ZNode, b: ZNode): number {
    return this.order[Math.min(this.levelOf(a), this.levelOf(b))]
  }

  union(a: ZNode, b: ZNode): ZNode {
    if (a === ZDD_EMPTY) return b
    if (b === ZDD_EMPTY) return a
    if (a === b) return a
    const key = 'u' + Math.min(a, b) + ',' + Math.max(a, b)
    const hit = this.opMemo.get(key)
    if (hit !== undefined) return hit
    const v = this.topVar(a, b)
    const [a0, a1] = this.cof(a, v)
    const [b0, b1] = this.cof(b, v)
    const r = this.mk(v, this.union(a0, b0), this.union(a1, b1))
    this.opMemo.set(key, r)
    return r
  }

  intersect(a: ZNode, b: ZNode): ZNode {
    if (a === ZDD_EMPTY || b === ZDD_EMPTY) return ZDD_EMPTY
    if (a === b) return a
    const key = 'i' + Math.min(a, b) + ',' + Math.max(a, b)
    const hit = this.opMemo.get(key)
    if (hit !== undefined) return hit
    const v = this.topVar(a, b)
    const [a0, a1] = this.cof(a, v)
    const [b0, b1] = this.cof(b, v)
    const r = this.mk(v, this.intersect(a0, b0), this.intersect(a1, b1))
    this.opMemo.set(key, r)
    return r
  }

  /** Set difference a \ b. */
  diff(a: ZNode, b: ZNode): ZNode {
    if (a === ZDD_EMPTY) return ZDD_EMPTY
    if (b === ZDD_EMPTY) return a
    if (a === b) return ZDD_EMPTY
    const key = 'd' + a + ',' + b
    const hit = this.opMemo.get(key)
    if (hit !== undefined) return hit
    const v = this.topVar(a, b)
    const [a0, a1] = this.cof(a, v)
    const [b0, b1] = this.cof(b, v)
    const r = this.mk(v, this.diff(a0, b0), this.diff(a1, b1))
    this.opMemo.set(key, r)
    return r
  }

  /** Number of sets in the family. */
  count(z: ZNode): bigint {
    const memo = new Map<ZNode, bigint>()
    const go = (n: ZNode): bigint => {
      if (n === ZDD_EMPTY) return 0n
      if (n === ZDD_UNIT) return 1n
      const hit = memo.get(n)
      if (hit !== undefined) return hit
      const r = go(this.lo[n]) + go(this.hi[n])
      memo.set(n, r)
      return r
    }
    return go(z)
  }

  /** Reachable node count — the diagram's size. */
  size(z: ZNode): number {
    const vis = new Set<ZNode>()
    const go = (n: ZNode) => {
      if (n < 2 || vis.has(n)) return
      vis.add(n)
      go(this.lo[n])
      go(this.hi[n])
    }
    go(z)
    return vis.size
  }

  /** Enumerate the member sets (each a sorted array of elements), up to `limit`. */
  enumerate(z: ZNode, limit = 1000): { sets: number[][]; complete: boolean } {
    const sets: number[][] = []
    let complete = true
    const cur: number[] = []
    const go = (n: ZNode): void => {
      if (sets.length >= limit) {
        complete = false
        return
      }
      if (n === ZDD_EMPTY) return
      if (n === ZDD_UNIT) {
        sets.push(cur.slice().sort((a, b) => a - b))
        return
      }
      go(this.lo[n])
      cur.push(this.vv[n])
      go(this.hi[n])
      cur.pop()
    }
    go(z)
    return { sets, complete }
  }

  // ---- builders ------------------------------------------------------------

  /** The family of all 2^n subsets of the universe. */
  allSubsets(): ZNode {
    let cur: ZNode = ZDD_UNIT
    for (let lvl = this.numVars - 1; lvl >= 0; lvl--) {
      const v = this.order[lvl]
      cur = this.mk(v, cur, cur)
    }
    return cur
  }

  /** The family of exactly-k-element subsets (the binomial family). */
  combinations(k: number): ZNode {
    const memo = new Map<string, ZNode>()
    const go = (lvl: number, need: number): ZNode => {
      if (need === 0) return ZDD_UNIT
      if (this.numVars - lvl < need) return ZDD_EMPTY
      const key = lvl + ',' + need
      const hit = memo.get(key)
      if (hit !== undefined) return hit
      const v = this.order[lvl]
      const r = this.mk(v, go(lvl + 1, need), go(lvl + 1, need - 1))
      memo.set(key, r)
      return r
    }
    return go(0, k)
  }

  /** The family containing exactly one set, `items`. */
  single(items: number[]): ZNode {
    const byLevelDesc = items.slice().sort((a, b) => this.pos[b] - this.pos[a])
    let cur: ZNode = ZDD_UNIT
    for (const v of byLevelDesc) cur = this.mk(v, ZDD_EMPTY, cur)
    return cur
  }
}
