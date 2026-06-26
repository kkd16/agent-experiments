// A B+Tree index keyed on a *tuple* of SqlValues.
//
// This is a genuine B+Tree (not a JS Map wrapper): internal nodes hold
// separator keys and child pointers, leaves hold the actual entries and are
// chained in a doubly-linked list so range scans walk leaf-to-leaf. Each key
// maps to a *set* of row ids, so the same structure serves both unique and
// non-unique indexes.
//
// Keys are arrays (`IndexKey`) so a single structure backs both single-column
// and composite (multi-column) indexes. Tuples are compared lexicographically;
// range bounds may be a *prefix* of the full key, which is exactly what lets
// the planner answer `WHERE a = ? AND b BETWEEN ? AND ?` from one composite
// B+Tree.
//
// Unlike a teaching tree that deletes lazily, this one is **self-balancing on
// delete**: an underfull node borrows a key from a sibling, or merges with one,
// updating the parent separators and collapsing the root as the tree shrinks —
// so a tree that grew to height 4 under load returns to height 1 when emptied,
// and every node stays at least half full. Inserts and deletes can record a
// structural *trace* (descend / split / borrow / merge / grow / shrink) that the
// Storage Lab animates, and `checkInvariants()` proves the structure is a valid
// B+Tree after every mutation.
//
// The engine uses these for IndexScan, and the planner reports the tree's
// height & node count in EXPLAIN so you can see the structure it's exploiting.

import { orderValues, formatValue, type SqlValue } from '../types'

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
  id: number
  entries: LeafEntry[]
  next: LeafNode | null
  prev: LeafNode | null
}
interface InternalNode {
  leaf: false
  id: number
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
  /** Mean leaf occupancy as a fraction of the maximum (entries / capacity). */
  fill: number
}

// --- structural trace -------------------------------------------------------
// A compact, replayable log of what an insert/delete did to the structure. The
// Storage Lab renders these as a narration; tests assert that the expected
// events fired (e.g. that a delete actually triggered a merge).

export type TraceKind =
  | 'descend' // walked into a child while searching for the key
  | 'insert' // placed a new entry / added a rowid into a leaf
  | 'split-leaf' // a full leaf split in two
  | 'split-internal' // a full internal node split in two
  | 'grow-root' // the root split, so the tree grew one level taller
  | 'remove' // removed a rowid (and maybe an empty entry) from a leaf
  | 'borrow-left' // an underfull node took a key from its left sibling
  | 'borrow-right' // an underfull node took a key from its right sibling
  | 'merge' // an underfull node merged with a sibling
  | 'shrink-root' // the root had a single child, so the tree got one level shorter
  | 'not-found' // the key wasn't present (delete was a no-op)

export interface TraceEvent {
  kind: TraceKind
  /** A human-readable, already-formatted description for the Lab narration. */
  detail: string
  /** The node ids touched by this event, so the Lab can highlight them. */
  nodes: number[]
}

function fmtKey(key: IndexKey): string {
  return key.length === 1 ? formatValue(key[0]) : `(${key.map(formatValue).join(', ')})`
}

export class BTree {
  private root: BTreeNode
  private readonly order: number // max children per internal node == max entries per leaf
  private readonly minFill: number // min children (internal) / entries (leaf) for a non-root node
  private firstLeaf: LeafNode
  private idCounter = 0

  constructor(order = 32) {
    this.order = Math.max(4, order)
    // After a split the smaller half holds ⌈order/2⌉ slots, so that is exactly
    // the floor below which a node is "underfull" and must borrow or merge.
    this.minFill = Math.ceil(this.order / 2)
    const leaf: LeafNode = { leaf: true, id: this.idCounter++, entries: [], next: null, prev: null }
    this.root = leaf
    this.firstLeaf = leaf
  }

  /** Maximum entries per leaf / children per internal node (the fanout). */
  get fanout(): number {
    return this.order
  }

  // --- search -------------------------------------------------------------
  private findLeaf(key: IndexKey, trace?: TraceEvent[]): LeafNode {
    let node = this.root
    while (!node.leaf) {
      let i = 0
      while (i < node.keys.length && compareKeys(key, node.keys[i]) >= 0) i++
      if (trace) trace.push({ kind: 'descend', detail: `descend into child ${i} of node #${node.id}`, nodes: [node.id, node.children[i].id] })
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

  /**
   * Like `range`, but returns the *leaf ids* it visited and the keys it matched.
   * The Storage Lab uses this to light up the leaf chain a range scan walks.
   */
  rangeTraced(
    lo: IndexKey | null,
    hi: IndexKey | null,
    loInclusive = true,
    hiInclusive = true,
  ): { visitedLeaves: number[]; matchedKeys: IndexKey[] } {
    const visitedLeaves: number[] = []
    const matchedKeys: IndexKey[] = []
    let leaf: LeafNode | null = lo === null ? this.firstLeaf : this.findLeaf(lo)
    while (leaf) {
      visitedLeaves.push(leaf.id)
      let stop = false
      for (const e of leaf.entries) {
        if (lo !== null) {
          const c = compareToBound(e.key, lo)
          if (c < 0 || (c === 0 && !loInclusive)) continue
        }
        if (hi !== null) {
          const c = compareToBound(e.key, hi)
          if (c > 0 || (c === 0 && !hiInclusive)) {
            stop = true
            break
          }
        }
        matchedKeys.push(e.key)
      }
      if (stop) break
      leaf = leaf.next
    }
    return { visitedLeaves, matchedKeys }
  }

  /**
   * Like `range`, but yields the matching *keys* (one per row id) instead of the
   * row ids. This is what an index-only / covering scan reads: every column it
   * needs is already in the key, so the heap is never touched.
   */
  rangeKeys(lo: IndexKey | null, hi: IndexKey | null, loInclusive = true, hiInclusive = true): IndexKey[] {
    const out: IndexKey[] = []
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
        for (let i = 0; i < e.rowids.length; i++) out.push(e.key)
      }
      leaf = leaf.next
    }
    return out
  }

  // --- insert -------------------------------------------------------------
  insert(key: IndexKey, rowid: number, trace?: TraceEvent[]): void {
    const result = this.insertInto(this.root, key, rowid, trace)
    if (result) {
      // Root split: create a new root.
      const newRoot: InternalNode = {
        leaf: false,
        id: this.idCounter++,
        keys: [result.separator],
        children: [this.root, result.right],
      }
      if (trace) trace.push({ kind: 'grow-root', detail: `root split — tree grows to height ${this.stats().height}`, nodes: [newRoot.id] })
      this.root = newRoot
    }
  }

  private insertInto(
    node: BTreeNode,
    key: IndexKey,
    rowid: number,
    trace?: TraceEvent[],
  ): { separator: IndexKey; right: BTreeNode } | null {
    if (node.leaf) {
      const idx = this.leafIndex(node, key)
      if (idx < node.entries.length && compareKeys(node.entries[idx].key, key) === 0) {
        if (!node.entries[idx].rowids.includes(rowid)) node.entries[idx].rowids.push(rowid)
        if (trace) trace.push({ kind: 'insert', detail: `add row ${rowid} to existing key ${fmtKey(key)} in leaf #${node.id}`, nodes: [node.id] })
        return null
      }
      node.entries.splice(idx, 0, { key, rowids: [rowid] })
      if (trace) trace.push({ kind: 'insert', detail: `insert key ${fmtKey(key)} into leaf #${node.id}`, nodes: [node.id] })
      if (node.entries.length > this.order) return this.splitLeaf(node, trace)
      return null
    }

    let i = 0
    while (i < node.keys.length && compareKeys(key, node.keys[i]) >= 0) i++
    if (trace) trace.push({ kind: 'descend', detail: `descend into child ${i} of node #${node.id}`, nodes: [node.id, node.children[i].id] })
    const split = this.insertInto(node.children[i], key, rowid, trace)
    if (!split) return null
    node.keys.splice(i, 0, split.separator)
    node.children.splice(i + 1, 0, split.right)
    if (node.children.length > this.order) return this.splitInternal(node, trace)
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

  private splitLeaf(node: LeafNode, trace?: TraceEvent[]): { separator: IndexKey; right: BTreeNode } {
    const mid = node.entries.length >> 1
    const right: LeafNode = {
      leaf: true,
      id: this.idCounter++,
      entries: node.entries.splice(mid),
      next: node.next,
      prev: node,
    }
    if (right.next) right.next.prev = right
    node.next = right
    if (trace) trace.push({ kind: 'split-leaf', detail: `leaf #${node.id} full → split, new leaf #${right.id} starts at ${fmtKey(right.entries[0].key)}`, nodes: [node.id, right.id] })
    return { separator: right.entries[0].key, right }
  }

  private splitInternal(node: InternalNode, trace?: TraceEvent[]): { separator: IndexKey; right: BTreeNode } {
    const mid = node.keys.length >> 1
    const separator = node.keys[mid]
    const right: InternalNode = {
      leaf: false,
      id: this.idCounter++,
      keys: node.keys.splice(mid + 1),
      children: node.children.splice(mid + 1),
    }
    node.keys.splice(mid) // drop the separator from the left node
    if (trace) trace.push({ kind: 'split-internal', detail: `internal #${node.id} full → split, separator ${fmtKey(separator)} rises, new node #${right.id}`, nodes: [node.id, right.id] })
    return { separator, right }
  }

  // --- delete (self-balancing: borrow / merge / collapse) -----------------
  remove(key: IndexKey, rowid: number, trace?: TraceEvent[]): void {
    const removed = this.removeFrom(this.root, key, rowid, trace)
    if (!removed && trace) trace.push({ kind: 'not-found', detail: `key ${fmtKey(key)} not present — nothing to delete`, nodes: [] })
    // Collapse the root if it became a single-child internal node.
    if (!this.root.leaf && this.root.children.length === 1) {
      const onlyChild = this.root.children[0]
      if (trace) trace.push({ kind: 'shrink-root', detail: `root #${this.root.id} has one child — collapse, tree shrinks`, nodes: [this.root.id, onlyChild.id] })
      this.root = onlyChild
    }
  }

  // Returns true if anything was actually removed (so the caller can report a
  // no-op). Rebalances any child that underflows on the way back up.
  private removeFrom(node: BTreeNode, key: IndexKey, rowid: number, trace?: TraceEvent[]): boolean {
    if (node.leaf) {
      const idx = node.entries.findIndex((e) => compareKeys(e.key, key) === 0)
      if (idx < 0) return false
      const e = node.entries[idx]
      const before = e.rowids.length
      e.rowids = e.rowids.filter((r) => r !== rowid)
      if (e.rowids.length === before) return false
      if (e.rowids.length === 0) {
        node.entries.splice(idx, 1)
        if (trace) trace.push({ kind: 'remove', detail: `remove key ${fmtKey(key)} from leaf #${node.id}`, nodes: [node.id] })
      } else {
        if (trace) trace.push({ kind: 'remove', detail: `remove row ${rowid} from key ${fmtKey(key)} in leaf #${node.id}`, nodes: [node.id] })
      }
      return true
    }

    let i = 0
    while (i < node.keys.length && compareKeys(key, node.keys[i]) >= 0) i++
    if (trace) trace.push({ kind: 'descend', detail: `descend into child ${i} of node #${node.id}`, nodes: [node.id, node.children[i].id] })
    const removed = this.removeFrom(node.children[i], key, rowid, trace)
    if (removed && this.underflows(node.children[i])) this.rebalanceChild(node, i, trace)
    return removed
  }

  // A non-root node is underfull when it has fewer than `minFill` slots.
  private underflows(node: BTreeNode): boolean {
    return node.leaf ? node.entries.length < this.minFill : node.children.length < this.minFill
  }

  private slots(node: BTreeNode): number {
    return node.leaf ? node.entries.length : node.children.length
  }

  // Restore the minimum-occupancy invariant for parent.children[i], which just
  // dropped below half full. Prefer borrowing from whichever sibling can spare a
  // slot; otherwise merge with a sibling.
  private rebalanceChild(parent: InternalNode, i: number, trace?: TraceEvent[]): void {
    const left = i > 0 ? parent.children[i - 1] : null
    const right = i < parent.children.length - 1 ? parent.children[i + 1] : null

    if (left && this.slots(left) > this.minFill) {
      this.borrowFromLeft(parent, i, trace)
    } else if (right && this.slots(right) > this.minFill) {
      this.borrowFromRight(parent, i, trace)
    } else if (left) {
      this.mergeChildren(parent, i - 1, trace) // merge child into its left sibling
    } else if (right) {
      this.mergeChildren(parent, i, trace) // merge right sibling into child
    }
    // (If a node has neither sibling it is the lone child of the root, which the
    //  caller collapses — nothing to do here.)
  }

  private borrowFromLeft(parent: InternalNode, i: number, trace?: TraceEvent[]): void {
    const child = parent.children[i]
    const left = parent.children[i - 1]
    if (child.leaf && left.leaf) {
      const moved = left.entries.pop()!
      child.entries.unshift(moved)
      parent.keys[i - 1] = child.entries[0].key
      if (trace) trace.push({ kind: 'borrow-left', detail: `leaf #${child.id} underfull → borrow ${fmtKey(moved.key)} from left sibling #${left.id}`, nodes: [child.id, left.id, parent.id] })
    } else if (!child.leaf && !left.leaf) {
      // The separator between left and child comes down into child; left's last
      // key rises to become the new separator.
      child.keys.unshift(parent.keys[i - 1])
      child.children.unshift(left.children.pop()!)
      parent.keys[i - 1] = left.keys.pop()!
      if (trace) trace.push({ kind: 'borrow-left', detail: `internal #${child.id} underfull → borrow a child from left sibling #${left.id}`, nodes: [child.id, left.id, parent.id] })
    }
  }

  private borrowFromRight(parent: InternalNode, i: number, trace?: TraceEvent[]): void {
    const child = parent.children[i]
    const right = parent.children[i + 1]
    if (child.leaf && right.leaf) {
      const moved = right.entries.shift()!
      child.entries.push(moved)
      parent.keys[i] = right.entries[0].key
      if (trace) trace.push({ kind: 'borrow-right', detail: `leaf #${child.id} underfull → borrow ${fmtKey(moved.key)} from right sibling #${right.id}`, nodes: [child.id, right.id, parent.id] })
    } else if (!child.leaf && !right.leaf) {
      child.keys.push(parent.keys[i])
      child.children.push(right.children.shift()!)
      parent.keys[i] = right.keys.shift()!
      if (trace) trace.push({ kind: 'borrow-right', detail: `internal #${child.id} underfull → borrow a child from right sibling #${right.id}`, nodes: [child.id, right.id, parent.id] })
    }
  }

  // Merge parent.children[leftIdx+1] into parent.children[leftIdx], dropping the
  // separator that sat between them.
  private mergeChildren(parent: InternalNode, leftIdx: number, trace?: TraceEvent[]): void {
    const left = parent.children[leftIdx]
    const right = parent.children[leftIdx + 1]
    if (left.leaf && right.leaf) {
      left.entries.push(...right.entries)
      left.next = right.next
      if (right.next) right.next.prev = left
      if (trace) trace.push({ kind: 'merge', detail: `merge leaf #${right.id} into #${left.id} (both underfull)`, nodes: [left.id, right.id, parent.id] })
    } else if (!left.leaf && !right.leaf) {
      left.keys.push(parent.keys[leftIdx])
      left.keys.push(...right.keys)
      left.children.push(...right.children)
      if (trace) trace.push({ kind: 'merge', detail: `merge internal #${right.id} into #${left.id} (both underfull)`, nodes: [left.id, right.id, parent.id] })
    }
    parent.keys.splice(leftIdx, 1)
    parent.children.splice(leftIdx + 1, 1)
  }

  // --- bulk load ----------------------------------------------------------
  /**
   * Build a packed B+Tree bottom-up from already-sorted entries. This is how a
   * real database loads an index over an existing table (CREATE INDEX / a
   * RESTORE) far faster than a million one-at-a-time inserts, and it lets you
   * dial the leaf fill factor: a freshly bulk-loaded leaf is packed to
   * `fill·order` so there's room for later inserts before it splits.
   *
   * `entries` must be sorted ascending by key with no duplicate keys (rowids
   * already grouped). Returns a brand-new tree.
   */
  static bulkLoad(entries: LeafEntry[], order = 32, fill = 0.7): BTree {
    const tree = new BTree(order)
    if (entries.length === 0) return tree
    const cap = Math.max(2, Math.min(order, Math.round(order * Math.min(1, Math.max(0.1, fill)))))

    // 1. Pack the entries into a chain of leaves.
    const leaves: LeafNode[] = []
    for (let i = 0; i < entries.length; i += cap) {
      const slice = entries.slice(i, i + cap)
      const leaf: LeafNode = { leaf: true, id: tree.idCounter++, entries: slice, next: null, prev: null }
      const last = leaves[leaves.length - 1]
      if (last) {
        last.next = leaf
        leaf.prev = last
      }
      leaves.push(leaf)
    }
    tree.firstLeaf = leaves[0]

    // Guard against a final leaf below the minimum by pulling one entry over
    // from its left neighbour (only matters when there are ≥ 2 leaves).
    if (leaves.length >= 2) {
      const last = leaves[leaves.length - 1]
      const prev = leaves[leaves.length - 2]
      while (last.entries.length < tree.minFill && prev.entries.length > tree.minFill) {
        last.entries.unshift(prev.entries.pop()!)
      }
    }

    // 2. Build internal levels on top of the leaf chain.
    let level: BTreeNode[] = leaves
    while (level.length > 1) {
      const parents: InternalNode[] = []
      for (let i = 0; i < level.length; i += order) {
        const group = level.slice(i, i + order)
        const node: InternalNode = {
          leaf: false,
          id: tree.idCounter++,
          keys: [],
          children: group,
        }
        for (let j = 1; j < group.length; j++) node.keys.push(tree.firstKeyOf(group[j]))
        parents.push(node)
      }
      // Avoid a last parent with a single child (which would violate the
      // internal-node minimum) by rebalancing the final two parents.
      if (parents.length >= 2) {
        const last = parents[parents.length - 1]
        const prev = parents[parents.length - 2]
        while (last.children.length < tree.minFill && prev.children.length > tree.minFill) {
          const moved = prev.children.pop()!
          prev.keys.pop()
          last.children.unshift(moved)
          last.keys.unshift(tree.firstKeyOf(last.children[1]))
        }
      }
      level = parents
    }
    tree.root = level[0]
    return tree
  }

  private firstKeyOf(node: BTreeNode): IndexKey {
    let n = node
    while (!n.leaf) n = n.children[0]
    return n.entries[0].key
  }

  // --- introspection ------------------------------------------------------
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
    const fill = leaves > 0 ? entries / (leaves * this.order) : 0
    return { order: this.order, height, nodes, leaves, entries, fill }
  }

  /**
   * Verify the B+Tree invariants and return a list of human-readable
   * violations (empty == a valid tree). Checked: every non-root node is at
   * least half full and no node overflows; keys within a node are sorted;
   * separators correctly fence their subtrees; all leaves sit at the same
   * depth; and the leaf chain is a sorted doubly-linked list covering exactly
   * the indexed keys.
   */
  checkInvariants(): string[] {
    const errors: string[] = []
    let leafDepth = -1

    const check = (node: BTreeNode, depth: number, lo: IndexKey | null, hi: IndexKey | null, isRoot: boolean) => {
      const n = this.slots(node)
      if (!isRoot && n < this.minFill) errors.push(`node #${node.id} underfull (${n} < ${this.minFill})`)
      if (node.leaf) {
        if (n > this.order) errors.push(`leaf #${node.id} overflow (${n} > ${this.order})`)
      } else {
        if (n > this.order) errors.push(`internal #${node.id} overflow (${n} > ${this.order})`)
        if (node.children.length !== node.keys.length + 1) errors.push(`internal #${node.id} has ${node.children.length} children but ${node.keys.length} keys`)
      }
      // Keys sorted within the node + within the fence [lo, hi).
      const localKeys = node.leaf ? node.entries.map((e) => e.key) : node.keys
      for (let i = 0; i < localKeys.length; i++) {
        if (i > 0 && compareKeys(localKeys[i - 1], localKeys[i]) >= 0) errors.push(`node #${node.id} keys out of order at ${i}`)
        if (lo !== null && compareKeys(localKeys[i], lo) < 0) errors.push(`node #${node.id} key ${fmtKey(localKeys[i])} below fence ${fmtKey(lo)}`)
        if (hi !== null && compareKeys(localKeys[i], hi) >= 0) errors.push(`node #${node.id} key ${fmtKey(localKeys[i])} at/above fence ${fmtKey(hi)}`)
      }
      if (node.leaf) {
        if (leafDepth === -1) leafDepth = depth
        else if (leafDepth !== depth) errors.push(`leaf #${node.id} at depth ${depth}, expected ${leafDepth}`)
        for (const e of node.entries) if (e.rowids.length === 0) errors.push(`leaf #${node.id} has an empty rowid set for ${fmtKey(e.key)}`)
      } else {
        for (let i = 0; i < node.children.length; i++) {
          const childLo = i === 0 ? lo : node.keys[i - 1]
          const childHi = i === node.keys.length ? hi : node.keys[i]
          // The *routing* invariant: every key in child i lives in the fence
          // [keys[i-1], keys[i]). (We deliberately do NOT require a separator to
          // exactly equal the current first key of its right subtree — deleting
          // a subtree's leftmost key without forcing a rebalance leaves the
          // separator a valid, if slack, lower bound. Searches and re-inserts of
          // that key still route correctly, which the fence above guarantees and
          // the differential tests confirm. This matches how textbook B+Trees
          // and production engines like Postgres treat high keys after deletes.)
          check(node.children[i], depth + 1, childLo, childHi, false)
        }
      }
    }
    check(this.root, 1, null, null, true)

    // Leaf chain: ascending, doubly linked, and starting at firstLeaf.
    let leaf: LeafNode | null = this.firstLeaf
    let prev: LeafNode | null = null
    let lastKey: IndexKey | null = null
    let guard = 0
    while (leaf) {
      if (leaf.prev !== prev) errors.push(`leaf #${leaf.id} prev pointer broken`)
      for (const e of leaf.entries) {
        if (lastKey !== null && compareKeys(lastKey, e.key) >= 0) errors.push(`leaf chain out of order at ${fmtKey(e.key)}`)
        lastKey = e.key
      }
      prev = leaf
      leaf = leaf.next
      if (++guard > 1_000_000) {
        errors.push('leaf chain cycle')
        break
      }
    }
    return errors
  }

  /** A plain-data, render-ready picture of the tree: one array of nodes per
   *  level (root first), plus the leaf-chain order. Used by the Storage Lab. */
  snapshot(): TreeSnapshot {
    const levels: SnapNode[][] = []
    const walk = (node: BTreeNode, depth: number) => {
      if (!levels[depth]) levels[depth] = []
      if (node.leaf) {
        levels[depth].push({
          id: node.id,
          leaf: true,
          keys: node.entries.map((e) => fmtKey(e.key)),
          rowCounts: node.entries.map((e) => e.rowids.length),
          next: node.next ? node.next.id : null,
        })
      } else {
        levels[depth].push({
          id: node.id,
          leaf: false,
          keys: node.keys.map(fmtKey),
          childIds: node.children.map((c) => c.id),
        })
        for (const c of node.children) walk(c, depth + 1)
      }
    }
    walk(this.root, 0)
    const leafOrder: number[] = []
    let leaf: LeafNode | null = this.firstLeaf
    while (leaf) {
      leafOrder.push(leaf.id)
      leaf = leaf.next
    }
    return { levels, leafOrder, order: this.order, minFill: this.minFill }
  }
}

export interface SnapNodeBase {
  id: number
  keys: string[]
}
export interface SnapInternal extends SnapNodeBase {
  leaf: false
  childIds: number[]
}
export interface SnapLeaf extends SnapNodeBase {
  leaf: true
  rowCounts: number[]
  next: number | null
}
export type SnapNode = SnapInternal | SnapLeaf
export interface TreeSnapshot {
  levels: SnapNode[][]
  leafOrder: number[]
  order: number
  minFill: number
}
