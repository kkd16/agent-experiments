// A B+Tree index keyed on a single SqlValue.
//
// This is a genuine B+Tree (not a JS Map wrapper): internal nodes hold
// separator keys and child pointers, leaves hold the actual entries and are
// chained in a doubly-ish linked list so range scans walk leaf-to-leaf. Each
// key maps to a *set* of row ids, so the same structure serves both unique
// and non-unique indexes.
//
// The engine uses these for IndexScan, and the planner reports the tree's
// height & node count in EXPLAIN so you can see the structure it's exploiting.

import { orderValues, type SqlValue } from '../types'

export interface LeafEntry {
  key: SqlValue
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
  keys: SqlValue[]
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
  private findLeaf(key: SqlValue): LeafNode {
    let node = this.root
    while (!node.leaf) {
      let i = 0
      while (i < node.keys.length && orderValues(key, node.keys[i]) >= 0) i++
      node = node.children[i]
    }
    return node
  }

  /** Exact-match lookup. Returns matching row ids (empty if none). */
  search(key: SqlValue): number[] {
    const leaf = this.findLeaf(key)
    const e = leaf.entries.find((x) => orderValues(x.key, key) === 0)
    return e ? e.rowids.slice() : []
  }

  /**
   * Range scan [lo, hi] (inclusive). Pass null bounds for open ranges.
   * Walks the leaf chain — this is the operation IndexScan relies on.
   */
  range(lo: SqlValue | null, hi: SqlValue | null, loInclusive = true, hiInclusive = true): number[] {
    const out: number[] = []
    let leaf: LeafNode | null = lo === null ? this.firstLeaf : this.findLeaf(lo)
    while (leaf) {
      for (const e of leaf.entries) {
        if (lo !== null) {
          const c = orderValues(e.key, lo)
          if (c < 0 || (c === 0 && !loInclusive)) continue
        }
        if (hi !== null) {
          const c = orderValues(e.key, hi)
          if (c > 0 || (c === 0 && !hiInclusive)) return out
        }
        out.push(...e.rowids)
      }
      leaf = leaf.next
    }
    return out
  }

  // --- insert -------------------------------------------------------------
  insert(key: SqlValue, rowid: number): void {
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

  private insertInto(node: BTreeNode, key: SqlValue, rowid: number): { separator: SqlValue; right: BTreeNode } | null {
    if (node.leaf) {
      const idx = this.leafIndex(node, key)
      if (idx < node.entries.length && orderValues(node.entries[idx].key, key) === 0) {
        if (!node.entries[idx].rowids.includes(rowid)) node.entries[idx].rowids.push(rowid)
        return null
      }
      node.entries.splice(idx, 0, { key, rowids: [rowid] })
      if (node.entries.length > this.order) return this.splitLeaf(node)
      return null
    }

    let i = 0
    while (i < node.keys.length && orderValues(key, node.keys[i]) >= 0) i++
    const split = this.insertInto(node.children[i], key, rowid)
    if (!split) return null
    node.keys.splice(i, 0, split.separator)
    node.children.splice(i + 1, 0, split.right)
    if (node.children.length > this.order) return this.splitInternal(node)
    return null
  }

  private leafIndex(node: LeafNode, key: SqlValue): number {
    let lo = 0
    let hi = node.entries.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (orderValues(node.entries[mid].key, key) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  private splitLeaf(node: LeafNode): { separator: SqlValue; right: BTreeNode } {
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

  private splitInternal(node: InternalNode): { separator: SqlValue; right: BTreeNode } {
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
  remove(key: SqlValue, rowid: number): void {
    const leaf = this.findLeaf(key)
    const idx = leaf.entries.findIndex((e) => orderValues(e.key, key) === 0)
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
