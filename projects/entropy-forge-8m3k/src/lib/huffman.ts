// huffman.ts — Huffman coding, from the tree up, plus canonical Huffman.
//
// Huffman's 1952 algorithm builds a provably optimal prefix code for a known
// symbol distribution: repeatedly merge the two least-frequent nodes. The result
// assigns short codes to frequent symbols. We keep the tree around for the
// visualiser, then derive *canonical* codes — the form real formats (DEFLATE,
// JPEG) transmit, because it needs only the code *lengths* to reconstruct, not
// the tree. encode/decode below round-trip through a real MSB-first bitstream.

import { BitReader, BitWriter } from './bits.ts'
import { frequencies } from './entropy.ts'

export interface HuffNode {
  symbol: number | null // leaf symbol, or null for internal nodes
  weight: number
  left: HuffNode | null
  right: HuffNode | null
  id: number
}

export interface HuffCode {
  symbol: number
  code: string // '0'/'1' string
  length: number
}

export interface HuffResult {
  tree: HuffNode | null
  codes: Map<number, string> // symbol -> code string
  canonical: HuffCode[] // canonical codes, sorted by (length, symbol)
  lengths: Map<number, number> // symbol -> code length
  encodedBits: number
  encoded: Uint8Array
  padBits: number
  avgLength: number // weighted average code length (bits/symbol)
}

// A tiny binary min-heap keyed on node weight (ties broken by insertion id so the
// tree is deterministic — important for a reproducible visualiser).
class NodeHeap {
  private a: HuffNode[] = []
  get size() {
    return this.a.length
  }
  private less(i: number, j: number): boolean {
    const x = this.a[i]
    const y = this.a[j]
    return x.weight < y.weight || (x.weight === y.weight && x.id < y.id)
  }
  push(n: HuffNode) {
    this.a.push(n)
    let i = this.a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.less(i, p)) {
        ;[this.a[i], this.a[p]] = [this.a[p], this.a[i]]
        i = p
      } else break
    }
  }
  pop(): HuffNode {
    const top = this.a[0]
    const last = this.a.pop()!
    if (this.a.length > 0) {
      this.a[0] = last
      let i = 0
      const n = this.a.length
      for (;;) {
        const l = 2 * i + 1
        const r = 2 * i + 2
        let m = i
        if (l < n && this.less(l, m)) m = l
        if (r < n && this.less(r, m)) m = r
        if (m === i) break
        ;[this.a[i], this.a[m]] = [this.a[m], this.a[i]]
        i = m
      }
    }
    return top
  }
}

/** Build the Huffman tree from a symbol->count table. */
export function buildTree(counts: number[]): HuffNode | null {
  const heap = new NodeHeap()
  let id = 0
  for (let b = 0; b < counts.length; b++) {
    if (counts[b] > 0) {
      heap.push({ symbol: b, weight: counts[b], left: null, right: null, id: id++ })
    }
  }
  if (heap.size === 0) return null
  // Single-symbol edge case: give it a one-bit code by pairing with itself-less
  // parent so decode still terminates.
  if (heap.size === 1) {
    const only = heap.pop()
    return { symbol: null, weight: only.weight, left: only, right: null, id }
  }
  while (heap.size > 1) {
    const a = heap.pop()
    const b = heap.pop()
    heap.push({
      symbol: null,
      weight: a.weight + b.weight,
      left: a,
      right: b,
      id: id++,
    })
  }
  return heap.pop()
}

/** Walk the tree to collect per-symbol code lengths (depths). */
export function codeLengths(tree: HuffNode | null): Map<number, number> {
  const lengths = new Map<number, number>()
  if (!tree) return lengths
  const walk = (node: HuffNode, depth: number) => {
    if (node.symbol !== null) {
      lengths.set(node.symbol, Math.max(1, depth))
      return
    }
    if (node.left) walk(node.left, depth + 1)
    if (node.right) walk(node.right, depth + 1)
  }
  walk(tree, 0)
  return lengths
}

// Canonical Huffman: from code *lengths* alone, assign codes in order of
// (length, symbol). The first code of each length is the previous code plus one,
// shifted left by the length delta. This is the deterministic form every real
// decoder rebuilds from a length table — no tree needs to be transmitted.
export function canonicalCodes(lengths: Map<number, number>): HuffCode[] {
  const entries = [...lengths.entries()].map(([symbol, length]) => ({ symbol, length }))
  entries.sort((a, b) => a.length - b.length || a.symbol - b.symbol)
  const out: HuffCode[] = []
  let code = 0
  let prevLen = 0
  for (const e of entries) {
    code <<= e.length - prevLen
    out.push({ symbol: e.symbol, length: e.length, code: code.toString(2).padStart(e.length, '0') })
    code++
    prevLen = e.length
  }
  return out
}

/** Full Huffman analysis + encode of `data`. */
export function huffmanEncode(data: Uint8Array): HuffResult {
  const counts = frequencies(data)
  const tree = buildTree(counts)
  const lengths = codeLengths(tree)
  const canonical = canonicalCodes(lengths)
  // Use the canonical codes for the actual bitstream so encode/decode agree with
  // the length-only reconstruction the visualiser shows.
  const codes = new Map<number, string>()
  for (const c of canonical) codes.set(c.symbol, c.code)

  const writer = new BitWriter()
  for (const b of data) {
    const code = codes.get(b)
    if (code) for (const ch of code) writer.writeBit(ch === '1' ? 1 : 0)
  }
  const encodedBits = writer.bitLength
  const encoded = writer.finish()
  const padBits = encoded.length * 8 - encodedBits

  let totalBits = 0
  for (const [sym, len] of lengths) totalBits += counts[sym] * len
  const avgLength = data.length > 0 ? totalBits / data.length : 0

  return { tree, codes, canonical, lengths, encodedBits, encoded, padBits, avgLength }
}

/**
 * Decode `bits` back to `length` symbols using canonical codes. We rebuild a
 * decode map from the canonical (symbol,code) list — this is what proves the
 * canonical reconstruction is sufficient to invert the stream.
 */
export function huffmanDecode(encoded: Uint8Array, canonical: HuffCode[], length: number): Uint8Array {
  const byCode = new Map<string, number>()
  let maxLen = 0
  for (const c of canonical) {
    byCode.set(c.code, c.symbol)
    if (c.length > maxLen) maxLen = c.length
  }
  const reader = new BitReader(encoded)
  const out = new Uint8Array(length)
  // Single-symbol streams have a 1-bit code; handle uniformly via the map.
  for (let i = 0; i < length; i++) {
    let acc = ''
    for (let l = 0; l < maxLen + 1; l++) {
      acc += reader.readBit() === 1 ? '1' : '0'
      const sym = byCode.get(acc)
      if (sym !== undefined) {
        out[i] = sym
        break
      }
    }
  }
  return out
}
