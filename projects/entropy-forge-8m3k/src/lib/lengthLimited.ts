// lengthLimited.ts — optimal **length-limited** prefix codes via the
// **package-merge** algorithm (Larmore & Hirschberg, 1990).
//
// Plain Huffman minimises expected code length with no cap on depth, so a very
// skewed distribution can produce a code word 20+ bits long. Real formats forbid
// that: JPEG caps Huffman codes at 16 bits, DEFLATE at 15, so the decoder tables
// stay small and fast. Package-merge finds the code that minimises total bits
// **subject to** every length ≤ L — the provably optimal length-limited code, not
// a heuristic. The trick is to recast "choose code lengths" as the *coin
// collector's problem*: each symbol offers a coin of nominal value 2^−l at each
// level l ∈ 1..L and weight = its frequency; we must buy exactly n−1 units of
// nominal value using 2n−2 coins of least total weight. Packaging pairs the
// cheapest coins at each level and merges them with the leaves — L passes, and the
// number of coins a symbol ends up in is exactly its code length.

export interface LLResult {
  lengths: Map<number, number> // symbol → code length (all ≤ maxLength)
  totalBits: number // Σ freq · length for the given counts
  maxUsed: number // deepest length actually assigned
}

interface Item {
  weight: number
  symbols: number[] // the leaf symbols this coin/package covers (with multiplicity)
}

function mergeSorted(a: Item[], b: Item[]): Item[] {
  const out: Item[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i].weight <= b[j].weight) out.push(a[i++])
    else out.push(b[j++])
  }
  while (i < a.length) out.push(a[i++])
  while (j < b.length) out.push(b[j++])
  return out
}

/**
 * Optimal length-limited code lengths for `counts` (symbol → occurrences),
 * capping every length at `maxLength`. Requires 2^maxLength ≥ (number of distinct
 * symbols); callers should pick maxLength ≥ ⌈log2 n⌉.
 */
export function packageMerge(counts: number[], maxLength: number): LLResult {
  const leaves: Item[] = []
  for (let s = 0; s < counts.length; s++) {
    if (counts[s] > 0) leaves.push({ weight: counts[s], symbols: [s] })
  }
  leaves.sort((a, b) => a.weight - b.weight)
  const n = leaves.length
  const lengths = new Map<number, number>()

  if (n === 0) return { lengths, totalBits: 0, maxUsed: 0 }
  if (n === 1) {
    lengths.set(leaves[0].symbols[0], 1) // a lone symbol still needs a 1-bit code
    return { lengths, totalBits: counts[leaves[0].symbols[0]], maxUsed: 1 }
  }

  // Build the level lists from the deepest level up. `current` starts as the
  // leaves (level L); each pass packages it and merges the leaves back in.
  let current: Item[] = leaves.slice()
  for (let level = 0; level < maxLength - 1; level++) {
    const packages: Item[] = []
    for (let i = 0; i + 1 < current.length; i += 2) {
      packages.push({
        weight: current[i].weight + current[i + 1].weight,
        symbols: current[i].symbols.concat(current[i + 1].symbols),
      })
    }
    current = mergeSorted(leaves, packages)
  }

  // Buy the 2n−2 cheapest coins; a symbol's code length = how many chosen coins
  // it appears in.
  const need = 2 * n - 2
  for (let s = 0; s < counts.length; s++) if (counts[s] > 0) lengths.set(s, 0)
  for (let k = 0; k < need && k < current.length; k++) {
    for (const sym of current[k].symbols) lengths.set(sym, (lengths.get(sym) ?? 0) + 1)
  }

  let totalBits = 0
  let maxUsed = 0
  for (const [sym, len] of lengths) {
    totalBits += counts[sym] * len
    if (len > maxUsed) maxUsed = len
  }
  return { lengths, totalBits, maxUsed }
}

/** Smallest length limit that can still encode `n` distinct symbols. */
export function minLimit(n: number): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(1, n))))
}
