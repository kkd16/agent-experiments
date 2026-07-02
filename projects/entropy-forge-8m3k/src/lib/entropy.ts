// entropy.ts — Shannon information measures over a byte sequence.
//
// These are the yardstick the whole lab is measured against. Shannon's source
// coding theorem says no lossless coder can beat the order-0 entropy H(X) bits
// per symbol on average when symbols are i.i.d.; real data is not i.i.d., so the
// conditional entropy H(X|prev) (order-1) is usually much lower, which is exactly
// why context-modelling coders (adaptive arithmetic, PPM, LZ) win. We compute all
// of these so the Benchmark page can show each codec against its theoretical floor.

export interface SymbolStat {
  symbol: number // byte value 0..255
  count: number
  prob: number // count / total
  info: number // -log2(prob), the ideal code length in bits
  codeContribution: number // count * info, total ideal bits for this symbol
}

export interface EntropyReport {
  length: number // number of bytes
  distinct: number // number of distinct symbols
  order0: number // H(X) in bits/symbol
  order1: number // H(X | previous byte) in bits/symbol
  order2: number // H(X | previous 2 bytes) in bits/symbol
  idealBits: number // length * order0, the order-0 lower bound in bits
  maxEntropy: number // log2(distinct), the uniform-distribution ceiling
  redundancy: number // 1 - order0 / maxEntropy (0 = incompressible by order-0)
  stats: SymbolStat[] // per-symbol table, sorted by descending count
}

/** Raw frequency table: counts[b] = occurrences of byte value b. */
export function frequencies(data: Uint8Array): number[] {
  const counts = new Array<number>(256).fill(0)
  for (const b of data) counts[b]++
  return counts
}

const LOG2 = Math.log(2)
function log2(x: number): number {
  return Math.log(x) / LOG2
}

/** Order-0 (memoryless) Shannon entropy in bits per symbol. */
export function order0Entropy(data: Uint8Array): number {
  if (data.length === 0) return 0
  const counts = frequencies(data)
  const n = data.length
  let h = 0
  for (const c of counts) {
    if (c > 0) {
      const p = c / n
      h -= p * log2(p)
    }
  }
  return h
}

// Conditional entropy H(X | context) where the context is the previous `order`
// bytes. We estimate it empirically: group the stream by context, measure the
// per-context symbol distribution, and average by context frequency. This is the
// order-`order` block-entropy estimate; it converges to the true value only with
// enough data, but for the lab's short inputs it still shows the trend clearly.
function conditionalEntropy(data: Uint8Array, order: number): number {
  if (data.length <= order) return order0Entropy(data)
  // Map context key -> (symbol -> count) and context -> total.
  const ctxCounts = new Map<string, Map<number, number>>()
  const ctxTotal = new Map<string, number>()
  for (let i = order; i < data.length; i++) {
    let key = ''
    for (let k = order; k >= 1; k--) key += data[i - k] + ','
    let m = ctxCounts.get(key)
    if (!m) {
      m = new Map()
      ctxCounts.set(key, m)
    }
    m.set(data[i], (m.get(data[i]) ?? 0) + 1)
    ctxTotal.set(key, (ctxTotal.get(key) ?? 0) + 1)
  }
  const total = data.length - order
  let h = 0
  for (const [key, m] of ctxCounts) {
    const ct = ctxTotal.get(key)!
    const pCtx = ct / total
    let hCtx = 0
    for (const c of m.values()) {
      const p = c / ct
      hCtx -= p * log2(p)
    }
    h += pCtx * hCtx
  }
  return h
}

/** Full entropy report for the Analyzer page. */
export function analyze(data: Uint8Array): EntropyReport {
  const n = data.length
  const counts = frequencies(data)
  const stats: SymbolStat[] = []
  let distinct = 0
  for (let b = 0; b < 256; b++) {
    if (counts[b] > 0) {
      distinct++
      const prob = n === 0 ? 0 : counts[b] / n
      const info = prob > 0 ? -log2(prob) : 0
      stats.push({
        symbol: b,
        count: counts[b],
        prob,
        info,
        codeContribution: counts[b] * info,
      })
    }
  }
  stats.sort((a, b) => b.count - a.count || a.symbol - b.symbol)
  const order0 = order0Entropy(data)
  const maxEntropy = distinct > 0 ? log2(distinct) : 0
  return {
    length: n,
    distinct,
    order0,
    order1: conditionalEntropy(data, 1),
    order2: conditionalEntropy(data, 2),
    idealBits: order0 * n,
    maxEntropy,
    redundancy: maxEntropy > 0 ? 1 - order0 / maxEntropy : 0,
    stats,
  }
}
