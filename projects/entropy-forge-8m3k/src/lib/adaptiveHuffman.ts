// adaptiveHuffman.ts — the FGK (Faller–Gallager–Knuth) **adaptive Huffman** coder.
//
// Static Huffman needs two passes and a transmitted code table; adaptive Huffman
// needs neither. Encoder and decoder start from the same empty tree and, after
// every symbol, mutate it in lock-step so the codes track the statistics *as they
// arrive* — exactly the adaptive-arithmetic story, but told with an explicit,
// watchable binary tree. The invariant that makes it work is Gallager's **sibling
// property**: number the nodes so weights are non-decreasing along the numbering,
// and every node's sibling is adjacent. FGK restores that property after each
// increment by swapping the just-touched node with the highest-numbered node of
// equal weight before bumping its weight and walking to the root. A special
// **NYT** ("not yet transmitted") leaf is the escape hatch: the first time a
// symbol appears, we send NYT's code followed by the raw byte, then splice the new
// symbol into the tree. Because both sides run the identical mutation, the stream
// round-trips with no side information at all.

const NYT = -2 // symbol sentinel for the Not-Yet-Transmitted leaf
const INTERNAL = -1

export interface FGKNode {
  id: number // stable identity (for the visualiser / React keys)
  symbol: number // byte value, or NYT / INTERNAL
  weight: number
  order: number // implicit node number; larger = later in the sibling ordering
  parent: FGKNode | null
  left: FGKNode | null
  right: FGKNode | null
}

export class FGKTree {
  root: FGKNode
  private nyt: FGKNode
  private leaves = new Map<number, FGKNode>()
  private nodes: FGKNode[] = []
  private nextId = 0
  private nextOrder: number

  constructor() {
    // Orders count DOWN from 2*256+1 so the root has the largest number and the
    // NYT leaf (created first, deepest-left) has the smallest — the conventional
    // FGK numbering. We only need a consistent total order, so exact values are
    // arbitrary as long as new internal/leaf pairs slot in below their parent.
    this.nextOrder = 512
    this.root = this.makeNode(NYT, 0, this.nextOrder--)
    this.nyt = this.root
  }

  private makeNode(symbol: number, weight: number, order: number): FGKNode {
    const n: FGKNode = { id: this.nextId++, symbol, weight, order, parent: null, left: null, right: null }
    this.nodes.push(n)
    return n
  }

  /** '0'/'1' path from root to `node` (left = 0, right = 1). */
  codeOf(node: FGKNode): string {
    let s = ''
    let cur: FGKNode | null = node
    while (cur.parent) {
      s = (cur.parent.left === cur ? '0' : '1') + s
      cur = cur.parent
    }
    return s
  }

  has(symbol: number): boolean {
    return this.leaves.has(symbol)
  }
  leaf(symbol: number): FGKNode | undefined {
    return this.leaves.get(symbol)
  }
  nytNode(): FGKNode {
    return this.nyt
  }

  // Highest-order node sharing `node`'s weight (the block "leader" to swap with).
  // A node is never swapped with one of its own ancestors, so ancestors are not
  // eligible leaders — this keeps the tree well-formed even while many nodes
  // transiently share weight early in the stream.
  private blockLeader(node: FGKNode): FGKNode {
    let leader = node
    for (const n of this.nodes) {
      if (n.weight === node.weight && n.order > leader.order && !this.isAncestor(n, node)) {
        leader = n
      }
    }
    return leader
  }

  // Is `maybe` an ancestor of `node` (or the same node)?
  private isAncestor(maybe: FGKNode, node: FGKNode): boolean {
    let cur: FGKNode | null = node
    while (cur) {
      if (cur === maybe) return true
      cur = cur.parent
    }
    return false
  }

  // Swap two nodes' positions in the tree (their subtrees and parent links), and
  // exchange their order numbers so the numbering still tracks tree position.
  private swap(a: FGKNode, b: FGKNode) {
    if (a === b || a.parent === b || b.parent === a) return
    const pa = a.parent!
    const pb = b.parent!
    // Replace a with b under pa, and b with a under pb.
    if (pa.left === a) pa.left = b
    else pa.right = b
    if (pb.left === b) pb.left = a
    else pb.right = a
    a.parent = pb
    b.parent = pa
    const o = a.order
    a.order = b.order
    b.order = o
  }

  /** Feed one symbol; mutate the tree per FGK. Call identically on both sides. */
  update(symbol: number) {
    let node: FGKNode
    if (this.leaves.has(symbol)) {
      node = this.leaves.get(symbol)!
    } else {
      // First sighting: turn the current NYT leaf *in place* into an internal node
      // whose children are a fresh NYT (left) and the new symbol's leaf (right).
      // Mutating `old` — rather than orphaning it — keeps every node in `this.nodes`
      // attached to the tree, which the block-leader scan relies on.
      const old = this.nyt
      const newLeaf = this.makeNode(symbol, 0, this.nextOrder--) // larger order
      const newNYT = this.makeNode(NYT, 0, this.nextOrder--) // smaller order
      old.symbol = INTERNAL
      old.left = newNYT
      old.right = newLeaf
      newNYT.parent = old
      newLeaf.parent = old
      this.nyt = newNYT
      this.leaves.set(symbol, newLeaf)
      node = old // start the weight walk at the node that was NYT
    }

    // Walk to the root: swap with block leader, then increment.
    while (node) {
      const leader = this.blockLeader(node)
      if (leader !== node && leader !== node.parent && node !== leader.parent) {
        this.swap(node, leader)
      }
      node.weight += 1
      node = node.parent as FGKNode
    }
  }

  /** Snapshot for rendering: nodes + edges with computed depths/positions. */
  snapshot(): FGKNode {
    return this.root
  }
}

import { BitReader, BitWriter } from './bits.ts'

export interface AdaptiveResult {
  encoded: Uint8Array
  encodedBits: number
  symbolsSeen: number // distinct symbols (NYT escapes emitted)
}

export function adaptiveHuffmanEncode(data: Uint8Array): AdaptiveResult {
  const tree = new FGKTree()
  const w = new BitWriter()
  let seen = 0
  for (const sym of data) {
    if (tree.has(sym)) {
      for (const ch of tree.codeOf(tree.leaf(sym)!)) w.writeBit(ch === '1' ? 1 : 0)
    } else {
      for (const ch of tree.codeOf(tree.nytNode())) w.writeBit(ch === '1' ? 1 : 0)
      w.writeBits(sym, 8) // raw byte for a first-seen symbol
      seen++
    }
    tree.update(sym)
  }
  return { encoded: w.finish(), encodedBits: w.bitLength, symbolsSeen: seen }
}

export function adaptiveHuffmanDecode(encoded: Uint8Array, length: number): Uint8Array {
  const tree = new FGKTree()
  const r = new BitReader(encoded)
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    let node = tree.root
    // Descend to a leaf (root may itself be the NYT leaf at the very start).
    while (node.left || node.right) {
      node = r.readBit() === 1 ? node.right! : node.left!
    }
    let sym: number
    if (node.symbol === NYT) {
      sym = r.readBits(8)
    } else {
      sym = node.symbol
    }
    out[i] = sym
    tree.update(sym)
  }
  return out
}
