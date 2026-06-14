// A B+Tree index keyed on a *tuple* of SqlValues.
//
// This is a genuine B+Tree (not a JS Map wrapper): internal nodes hold
// separator keys and child pointers, leaves hold the actual entries and are
// chained in a singly-linked list so range scans walk leaf-to-leaf. Each key
// maps to a *set* of row ids, so the same structure serves both unique and
// non-unique indexes.
//
// Keys are arrays (`IndexKey`) so a single structure backs both single-column
// and composite (multi-column) indexes. Tuples are compared lexicographically;
// range bounds may be a *prefix* of the full key, which is exactly what lets
// the planner answer `WHERE a = ? AND b BETWEEN ? AND ?` from one composite
// B+Tree.
//
// The engine uses these for IndexScan, and the planner reports the tree's
// height & node count in EXPLAIN so you can see the structure it's exploiting.

import { orderValues, type SqlValue } from '../types'

/** A composite index key: one value per indexed column (length 1 for the
 *  common single-column case). */
export type IndexKey = SqlValue[]

/** Lexicographic tuple comparison. Shorter tuples sort before longer ones when
 *  the shared prefix is equal (so a prefix is "less than" any extension of it). */
export function compareKeys(a: IndexKey, b: IndexKey): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const c = orderValues(a[i], b[i])
    if (c !== 0) return c
  }
  return a.length - b.length
}

// Compare a full key against a (possibly shorter) bound, treating the bound as
// a prefix: the comparison only considers the bound's columns, so `[5, 9]`
// compared to the bound `[5]` is "equal" (prefix match) and inclusivity then
// decides whether it is in range.
function compareToBound(key: IndexKey, bound: IndexKey): number {
  const n = Math.min(key.length, bound.length)
  for (let i = 0; i < n; i++) {
    const c = orderValues(key[i], bound[i])
    if (c !== 0) return c
  }
  return 0
}

export interface LeafEntry {
  key: IndexKey
  rowids: number[]
}

interface LeafNode {
  leaf: true
  entries: LeafEntry[]
  next: LeafNode | null
  prev: LeafNode | null
}
interface InternalNode {
  leaf: false
  keys: IndexKey[]
  children: BTreeNode[]
}
type BTreeNode = LeafNode | InternalNode

export interface BTreeStats {
  order: number
  height: number
  nodes: number
  leaves: number
  entries: number
}

export class BTree {
  private root: BTreeNode
  private readonly order: number // max children per internal node
  private firstLeaf: LeafNode

  constructor(order = 32) {
    this.order = Math.max(4, order)
    const leaf: LeafNode = { leaf: true, entries: [], next: null, prev: null }
    this.root = leaf
    this.firstLeaf = leaf
  }

  // --- search -------------------------------------------------------------
  private findLeaf(key: IndexKey): LeafNode {
    let node = this.root
    while (!node.leaf) {
      let i = 0
      while (i < node.keys.length && compareKeys(key, node.keys[i]) >= 0) i++
      node = node.children[i]
    }
    return node
  }

  /** Exact-match lookup on a full key. Returns matching row ids (empty if none). */
  search(key: IndexKey): number[] {
    const leaf = this.findLeaf(key)
    const e = leaf.entries.find((x) => compareKeys(x.key, key) === 0)
    return e ? e.rowids.slice() : []
  }

  /**
   * Range scan [lo, hi] (inclusive by default). Pass null bounds for open
   * ranges. Bounds may be a prefix of the full key (so a composite index on
   * (a, b) answers `a = 5 AND b > 10` with lo=[5,10] exclusive, hi=[5]).
   * Walks the leaf chain — this is the operation IndexScan relies on.
   */
  range(lo: IndexKey | null, hi: IndexKey | null, loInclusive = true, hiInclusive = true): number[] {
    const out: number[] = []
    let leaf: LeafNode | null = lo === null ? this.firstLeaf : this.findLeaf(lo)
    while (leaf) {
      for (const e of leaf.entries) {
        if (lo !== null) {
          const c = compareToBound(e.key, lo)
          if (c < 0 || (c === 0 && !loInclusive)) continue
        }
        if (hi !== null) {
          const c = compareToBound(e.key, hi)
          if (c > 0 || (c === 0 && !hiInclusive)) return out
        }
        out.push(...e.rowids)
      }
      leaf = leaf.next
    }
    return out
  }

  // --- insert -------------------------------------------------------------
  insert(key: IndexKey, rowid: number): void {
    const result = this.insertInto(this.root, key, rowid)
    if (result) {
      // Root split: create a new root.
      const newRoot: InternalNode = {
        leaf: false,
        keys: [result.separator],
        children: [this.root, result.right],
      }
      this.root = newRoot
    }
  }

  private insertInto(node: BTreeNode, key: IndexKey, rowid: number): { separator: IndexKey; right: BTreeNode } | null {
    if (node.leaf) {
      const idx = this.leafIndex(node, key)
      if (idx < node.entries.length && compareKeys(node.entries[idx].key, key) === 0) {
        if (!node.entries[idx].rowids.includes(rowid)) node.entries[idx].rowids.push(rowid)
        return null
      }
      node.entries.splice(idx, 0, { key, rowids: [rowid] })
      if (node.entries.length > this.order) return this.splitLeaf(node)
      return null
    }

    let i = 0
    while (i < node.keys.length && compareKeys(key, node.keys[i]) >= 0) i++
    const split = this.insertInto(node.children[i], key, rowid)
    if (!split) return null
    node.keys.splice(i, 0, split.separator)
    node.children.splice(i + 1, 0, split.right)
    if (node.children.length > this.order) return this.splitInternal(node)
    return null
  }

  private leafIndex(node: LeafNode, key: IndexKey): number {
    let lo = 0
    let hi = node.entries.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (compareKeys(node.entries[mid].key, key) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  private splitLeaf(node: LeafNode): { separator: IndexKey; right: BTreeNode } {
    const mid = node.entries.length >> 1
    const right: LeafNode = {
      leaf: true,
      entries: node.entries.splice(mid),
      next: node.next,
      prev: node,
    }
    if (right.next) right.next.prev = right
    node.next = right
    return { separator: right.entries[0].key, right }
  }

  private splitInternal(node: InternalNode): { separator: IndexKey; right: BTreeNode } {
    const mid = node.keys.length >> 1
    const separator = node.keys[mid]
    const right: InternalNode = {
      leaf: false,
      keys: node.keys.splice(mid + 1),
      children: node.children.splice(mid + 1),
    }
    node.keys.splice(mid) // drop the separator from the left node
    return { separator, right }
  }

  // --- delete (lazy: remove from entry, drop empty entries) ---------------
  remove(key: IndexKey, rowid: number): void {
    const leaf = this.findLeaf(key)
    const idx = leaf.entries.findIndex((e) => compareKeys(e.key, key) === 0)
    if (idx < 0) return
    const e = leaf.entries[idx]
    e.rowids = e.rowids.filter((r) => r !== rowid)
    if (e.rowids.length === 0) leaf.entries.splice(idx, 1)
    // We intentionally don't rebalance on delete — entries stay searchable and
    // the tree only grows shallower lazily. This keeps deletes O(log n) and is
    // a common simplification in teaching/embedded B+Trees.
  }

  stats(): BTreeStats {
    let nodes = 0
    let leaves = 0
    let entries = 0
    let height = 0
    const walk = (node: BTreeNode, depth: number) => {
      nodes++
      height = Math.max(height, depth)
      if (node.leaf) {
        leaves++
        entries += node.entries.length
      } else {
        for (const c of node.children) walk(c, depth + 1)
      }
    }
    walk(this.root, 1)
    return { order: this.order, height, nodes, leaves, entries }
  }
}
