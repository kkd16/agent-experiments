// A binary Merkle tree over rows of Goldilocks field elements, hashed with the
// lab's own SHA-256. This is the *only* cryptographic assumption a STARK makes:
// no pairings, no trusted setup, no hardness of discrete log — just a collision-
// resistant hash. That is what makes STARKs "transparent" and plausibly
// post-quantum.
//
// A prover commits to a whole codeword (a vector of field elements) by its root;
// later it can reveal any single position together with an O(log n) authentication
// path, and the verifier re-hashes the path to the root to be convinced the value
// was fixed in advance. Leaf counts here are always powers of two (our evaluation
// domains are), which keeps the tree perfect and the code short.

import { sha256, concat, bytesToHex, hexToBytes, bigToBytes } from './sha256'
import { P } from './goldilocks'

/** Serialize one field element as 8 big-endian bytes (Goldilocks < 2^64). */
function feBytes(x: bigint): Uint8Array {
  return bigToBytes(((x % P) + P) % P, 8)
}

/** Hash a leaf: a row of one or more field elements. */
export function hashLeaf(row: bigint[]): Uint8Array {
  return sha256(concat(...row.map(feBytes)))
}

export interface MerkleTree {
  /** levels[0] = leaf hashes, levels[top] = [root]. */
  levels: Uint8Array[][]
  root: string
  size: number
}

/** Build a Merkle tree over an array of rows (leaf count must be a power of two). */
export function buildMerkle(rows: bigint[][]): MerkleTree {
  const n = rows.length
  if (n === 0 || (n & (n - 1)) !== 0) {
    throw new Error('buildMerkle: leaf count must be a power of two')
  }
  let level = rows.map(hashLeaf)
  const levels: Uint8Array[][] = [level]
  while (level.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256(concat(level[i], level[i + 1])))
    }
    levels.push(next)
    level = next
  }
  return { levels, root: bytesToHex(levels[levels.length - 1][0]), size: n }
}

/** The authentication path (sibling hashes, bottom-up) for one leaf index. */
export function openMerkle(tree: MerkleTree, index: number): string[] {
  if (index < 0 || index >= tree.size) throw new Error('openMerkle: index out of range')
  const path: string[] = []
  let idx = index
  for (let lvl = 0; lvl < tree.levels.length - 1; lvl++) {
    const sibling = idx ^ 1
    path.push(bytesToHex(tree.levels[lvl][sibling]))
    idx >>= 1
  }
  return path
}

/**
 * Re-derive the root from a claimed leaf value + path and compare. This is all
 * the verifier ever runs against a commitment.
 */
export function verifyMerkle(
  root: string,
  index: number,
  row: bigint[],
  path: string[],
): boolean {
  let hash = hashLeaf(row)
  let idx = index
  for (const sibHex of path) {
    const sib = hexToBytes(sibHex)
    hash = (idx & 1) === 0 ? sha256(concat(hash, sib)) : sha256(concat(sib, hash))
    idx >>= 1
  }
  return bytesToHex(hash) === root
}
