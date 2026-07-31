// fountain.ts — Fountain codes: rateless erasure coding (LT + a Raptor-style precode).
//
// The channel-coding pages so far all answer the same question: given a *fixed*
// block of n symbols, how many errors/erasures can I survive? Fountain codes throw
// the block length away. From k source symbols an encoder manufactures a *limitless*
// stream of encoded symbols ("droplets"), each a XOR of a random subset of the
// sources. A receiver on an erasure channel collects whatever droplets survive and,
// once it has *slightly more than k* of them, recovers the whole message — no
// retransmission, no feedback, no rate chosen in advance. That is the "digital
// fountain": hold a bucket under the stream until it's full; which drops you caught
// doesn't matter, only how many.
//
// This module is deliberately self-contained and payload-honest: everything here
// round-trips real bytes. Two decoders are provided —
//
//   • the **peeling / belief-propagation** decoder (Luby's ripple process): the fast,
//     linear-time decoder that only ever solves degree-1 droplets, and
//   • a **Gaussian-elimination (inactivation) decoder over GF(2)**: the optimal
//     decoder that succeeds whenever the received droplets span the source space,
//     i.e. at the true information-theoretic overhead.
//
// On top of the LT inner code sits a small **LDPC precode** (the Raptor construction):
// a handful of parity symbols bridge the sources the LT layer happens to miss, which
// collapses the peeling decoder's error floor. All of it is checked by the self-test.
//
// Decode *success* depends only on the incidence structure (which droplet touches
// which source), never on the payload bytes — so the Monte-Carlo analysers below run
// on the graph alone and are cheap, while encode/peel/GE below carry real bytes.

import { RNG } from './channel.ts'

// ---------------------------------------------------------------------------
// Degree distributions
// ---------------------------------------------------------------------------

export interface DegreeDist {
  name: string
  k: number
  /** p[d] = probability of degree d, for d = 1..k (index 0 unused). */
  p: number[]
  /** cdf[d] = Σ_{i≤d} p[i]; cdf[k] = 1 (index 0 unused). */
  cdf: number[]
  /** Mean degree Σ d·p[d] — the average number of sources XORed per droplet. */
  meanDegree: number
}

function finish(name: string, k: number, raw: number[]): DegreeDist {
  // Normalise, then build the cdf. raw is indexed 1..k.
  let sum = 0
  for (let d = 1; d <= k; d++) sum += raw[d]
  const p = new Array<number>(k + 1).fill(0)
  const cdf = new Array<number>(k + 1).fill(0)
  let acc = 0
  let mean = 0
  for (let d = 1; d <= k; d++) {
    p[d] = raw[d] / sum
    acc += p[d]
    cdf[d] = acc
    mean += d * p[d]
  }
  cdf[k] = 1 // guard against fp drift so sampling always terminates
  return { name, k, p, cdf, meanDegree: mean }
}

/**
 * The **ideal soliton** distribution ρ. In expectation it releases exactly one
 * new degree-1 droplet at every peeling step — a perfect chain — which is why its
 * mean overhead is 0 in the limit. In practice the chain is fragile: one missing
 * link stalls the whole decode, so it is a teaching baseline, not a working code.
 */
export function idealSoliton(k: number): DegreeDist {
  const raw = new Array<number>(k + 1).fill(0)
  raw[1] = 1 / k
  for (let d = 2; d <= k; d++) raw[d] = 1 / (d * (d - 1))
  return finish('Ideal soliton', k, raw)
}

/**
 * The **robust soliton** distribution μ (Luby, 1998). It adds a spike τ on top of
 * ρ that (a) keeps the ripple from ever emptying, and (b) plants one high-degree
 * droplet to mop up the last few sources. Parameters:
 *   • c ∈ (0,1] — ripple-size knob (smaller ⇒ larger, safer ripple),
 *   • δ ∈ (0,1) — target failure probability.
 * R = c·ln(k/δ)·√k is the expected ripple size; the spike sits at degree k/R.
 * This is the distribution real LT codes ship with.
 */
export function robustSoliton(k: number, c = 0.03, delta = 0.5): DegreeDist {
  const rho = new Array<number>(k + 1).fill(0)
  rho[1] = 1 / k
  for (let d = 2; d <= k; d++) rho[d] = 1 / (d * (d - 1))

  const R = c * Math.log(k / delta) * Math.sqrt(k)
  const tau = new Array<number>(k + 1).fill(0)
  const kR = Math.floor(k / R) // the spike degree index
  for (let d = 1; d <= k; d++) {
    if (d >= 1 && d <= kR - 1) tau[d] = R / (d * k)
    else if (d === kR) tau[d] = (R * Math.log(R / delta)) / k
    else tau[d] = 0
  }
  const raw = new Array<number>(k + 1).fill(0)
  for (let d = 1; d <= k; d++) raw[d] = rho[d] + tau[d]
  return finish(`Robust soliton (c=${c}, δ=${delta})`, k, raw)
}

/** Draw a degree from `dist` using one uniform, by walking the cdf. */
export function sampleDegree(dist: DegreeDist, rng: RNG): number {
  const u = rng.float()
  const { cdf, k } = dist
  // Linear scan is fine: the cdf front-loads mass on tiny degrees.
  for (let d = 1; d <= k; d++) if (u <= cdf[d]) return d
  return k
}

// ---------------------------------------------------------------------------
// Reproducible neighbour selection (the shared heart of encoder + decoder)
// ---------------------------------------------------------------------------

/** Mix a droplet seed with a stream salt into a 32-bit RNG seed. */
function mixSeed(seed: number, salt: number): number {
  return (Math.imul(seed ^ 0x9e3779b1, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35)) >>> 0
}

/** Sample `d` *distinct* indices in [0, L). Deterministic given `rng`. */
function distinctSample(rng: RNG, L: number, d: number): number[] {
  const want = Math.min(d, L)
  if (want * 2 <= L) {
    // Rejection sampling: cheap when the degree is small (the common case).
    const seen = new Set<number>()
    while (seen.size < want) seen.add(Math.floor(rng.float() * L))
    return [...seen]
  }
  // Partial Fisher–Yates for large degrees (rare) so we never spin on rejections.
  const arr = new Array<number>(L)
  for (let i = 0; i < L; i++) arr[i] = i
  for (let i = 0; i < want; i++) {
    const j = i + Math.floor(rng.float() * (L - i))
    const t = arr[i]
    arr[i] = arr[j]
    arr[j] = t
  }
  return arr.slice(0, want)
}

/**
 * Derive the source/intermediate indices a droplet combines, from its seed alone.
 * The receiver reconstructs exactly this set from the transmitted seed — the only
 * side information a droplet carries besides its payload.
 */
export function deriveNeighbors(seed: number, salt: number, dist: DegreeDist, L: number): number[] {
  const rng = new RNG(mixSeed(seed, salt))
  const degree = sampleDegree(dist, rng)
  return distinctSample(rng, L, degree)
}

// ---------------------------------------------------------------------------
// Symbols & droplets
// ---------------------------------------------------------------------------

export interface Droplet {
  /** The transmitted seed; regenerates `neighbors` at the receiver. */
  seed: number
  /** Source/intermediate indices XORed into this droplet. */
  neighbors: number[]
  /** The payload: XOR of the neighbour symbols, `W` bytes. */
  data: Uint8Array
}

/** XOR `src` into `dst` in place (equal length). */
export function xorInto(dst: Uint8Array, src: Uint8Array): void {
  for (let i = 0; i < dst.length; i++) dst[i] ^= src[i]
}

/** Encode one droplet from a symbol array, deterministically from `seed`. */
export function makeDroplet(seed: number, symbols: Uint8Array[], dist: DegreeDist, salt = 0): Droplet {
  const L = symbols.length
  const W = symbols[0]?.length ?? 0
  const neighbors = deriveNeighbors(seed, salt, dist, L)
  const data = new Uint8Array(W)
  for (const idx of neighbors) xorInto(data, symbols[idx])
  return { seed, neighbors, data }
}

export interface EncodeOptions {
  /** First seed to use (default 1). Seeds increment by 1 per droplet. */
  startSeed?: number
  /** Stream salt, so two encoders of the same message differ (default 0). */
  salt?: number
}

/** Generate a stream of `count` droplets over the given symbols. */
export function ltEncode(symbols: Uint8Array[], dist: DegreeDist, count: number, opts: EncodeOptions = {}): Droplet[] {
  const start = opts.startSeed ?? 1
  const salt = opts.salt ?? 0
  const out: Droplet[] = []
  for (let i = 0; i < count; i++) out.push(makeDroplet(start + i, symbols, dist, salt))
  return out
}

// ---------------------------------------------------------------------------
// Peeling (belief-propagation) decoder — Luby's ripple process
// ---------------------------------------------------------------------------

export interface PeelStep {
  /** The source/intermediate index recovered at this step. */
  symbol: number
  /** The seed of the degree-1 droplet that released it. */
  viaSeed: number
  /** How many symbols are known after this step. */
  decoded: number
  /** Pending degree-1 droplets after this step — the "ripple". */
  rippleSize: number
}

export interface PeelResult {
  /** Recovered symbols (length L); entries are null where decode failed. */
  symbols: (Uint8Array | null)[]
  known: boolean[]
  decoded: number
  success: boolean
  /** The order symbols were released, for a step-by-step animation. */
  steps: PeelStep[]
}

/**
 * The peeling decoder. Any droplet whose neighbours are all known but one reveals
 * that one by XORing the knowns out of its payload. Recovering a symbol reduces the
 * degree of every droplet that referenced it, possibly creating fresh degree-1
 * droplets — the ripple. Decode succeeds iff the ripple never runs dry before all
 * L symbols are out. Linear time; the workhorse of real LT/Raptor decoders.
 */
export function peelDecode(droplets: { seed: number; neighbors: number[]; data: Uint8Array }[], L: number, W: number): PeelResult {
  const N = droplets.length
  const rem: Set<number>[] = droplets.map((d) => new Set(d.neighbors))
  const buf: Uint8Array[] = droplets.map((d) => d.data.slice())
  // symbol -> droplets that (may) still reference it
  const adj: number[][] = Array.from({ length: L }, () => [])
  for (let j = 0; j < N; j++) for (const s of rem[j]) adj[s].push(j)

  const symbols: (Uint8Array | null)[] = new Array(L).fill(null)
  const known = new Array<boolean>(L).fill(false)
  const steps: PeelStep[] = []

  const queue: number[] = []
  for (let j = 0; j < N; j++) if (rem[j].size === 1) queue.push(j)

  let decoded = 0
  while (queue.length) {
    const j = queue.shift()!
    if (rem[j].size !== 1) continue
    const s = rem[j].values().next().value as number
    if (known[s]) {
      rem[j].delete(s)
      continue
    }
    symbols[s] = buf[j].slice()
    known[s] = true
    decoded++
    const sol = symbols[s]!
    for (const jj of adj[s]) {
      if (!rem[jj].has(s)) continue
      xorInto(buf[jj], sol)
      rem[jj].delete(s)
      if (rem[jj].size === 1) queue.push(jj)
    }
    steps.push({ symbol: s, viaSeed: droplets[j].seed, decoded, rippleSize: queue.length })
    if (decoded === L) break
  }
  void W
  return { symbols, known, decoded, success: decoded === L, steps }
}

// ---------------------------------------------------------------------------
// Gaussian-elimination decoder over GF(2) — the optimal (ML) decoder
// ---------------------------------------------------------------------------

interface GERow {
  coeff: Uint32Array
  data: Uint8Array
}

export interface GEResult {
  symbols: (Uint8Array | null)[]
  /** Rank of the received incidence matrix over GF(2). */
  rank: number
  success: boolean
}

/**
 * Solve for the L symbols by Gauss–Jordan elimination over GF(2). Each droplet is a
 * linear equation "XOR of neighbours = payload"; the same row operations that reduce
 * the 0/1 coefficient matrix are applied to the byte payloads. Succeeds exactly when
 * the rank reaches L — i.e. the droplets you caught span the whole source space. This
 * is what lets an LT/Raptor code decode at overhead as low as a fraction of a percent,
 * far below what the greedy peeling decoder needs.
 */
export function geDecode(rows0: { neighbors: number[]; data: Uint8Array }[], L: number, W: number): GEResult {
  const words = (L + 31) >> 5
  const rows: GERow[] = rows0.map((r) => {
    const coeff = new Uint32Array(words)
    for (const s of r.neighbors) coeff[s >> 5] |= 1 << (s & 31)
    return { coeff, data: r.data.slice() }
  })
  const bit = (row: GERow, col: number) => (row.coeff[col >> 5] >>> (col & 31)) & 1
  const xorRow = (dst: GERow, src: GERow) => {
    for (let w = 0; w < words; w++) dst.coeff[w] ^= src.coeff[w]
    for (let b = 0; b < W; b++) dst.data[b] ^= src.data[b]
  }

  const pivotRowForCol = new Array<number>(L).fill(-1)
  let r = 0
  for (let col = 0; col < L && r < rows.length; col++) {
    let sel = -1
    for (let i = r; i < rows.length; i++) {
      if (bit(rows[i], col)) {
        sel = i
        break
      }
    }
    if (sel < 0) continue
    const t = rows[r]
    rows[r] = rows[sel]
    rows[sel] = t
    for (let i = 0; i < rows.length; i++) {
      if (i !== r && bit(rows[i], col)) xorRow(rows[i], rows[r])
    }
    pivotRowForCol[col] = r
    r++
  }

  const rank = r
  const symbols: (Uint8Array | null)[] = new Array(L).fill(null)
  if (rank === L) {
    // Full rank ⇒ no free columns ⇒ every pivot row's coeff is a unit vector,
    // so its payload is exactly that symbol.
    for (let col = 0; col < L; col++) symbols[col] = rows[pivotRowForCol[col]].data.slice()
  }
  return { symbols, rank, success: rank === L }
}

// ---------------------------------------------------------------------------
// Raptor-style LDPC precode
// ---------------------------------------------------------------------------

export interface Precode {
  k: number
  /** Number of parity (redundant) intermediate symbols. */
  p: number
  /** Total intermediate symbols L = k + p. */
  L: number
  /** subsets[j] = the source indices whose XOR defines parity symbol j. */
  subsets: number[][]
}

/**
 * Build a low-density parity precode: `p` parity symbols, each the XOR of a small
 * random subset of the k sources. These parities are extra intermediate symbols the
 * LT layer also mixes in; at the decoder they contribute `p` free linear equations
 * that bridge sources the droplets happened to miss, collapsing the peeling error
 * floor. This is the essence of Raptor codes (an LDPC precode feeding a weakened LT).
 */
export function buildPrecode(k: number, p: number, seed = 12345): Precode {
  const rng = new RNG(seed >>> 0)
  const subsets: number[][] = []
  // Each parity is the XOR of ~ (2..4) sources; guarantee a spread so every source
  // is covered by at least one parity (this is what removes the floor).
  const cover = new Array<number>(k).fill(0)
  for (let j = 0; j < p; j++) {
    const deg = 2 + Math.floor(rng.float() * 3) // 2..4
    const s = new Set<number>()
    while (s.size < Math.min(deg, k)) s.add(Math.floor(rng.float() * k))
    const arr = [...s]
    for (const idx of arr) cover[idx]++
    subsets.push(arr)
  }
  // Sweep any uncovered source into a parity so it is never orphaned.
  for (let i = 0; i < k && p > 0; i++) {
    if (cover[i] === 0) {
      const j = Math.floor(rng.float() * p)
      if (!subsets[j].includes(i)) subsets[j].push(i)
    }
  }
  return { k, p, L: k + p, subsets }
}

/** Materialise the L intermediate symbols [sources…, parities…] from the sources. */
export function precodeIntermediate(sources: Uint8Array[], pre: Precode): Uint8Array[] {
  const W = sources[0]?.length ?? 0
  const inter: Uint8Array[] = sources.map((s) => s.slice())
  for (let j = 0; j < pre.p; j++) {
    const parity = new Uint8Array(W)
    for (const idx of pre.subsets[j]) xorInto(parity, sources[idx])
    inter.push(parity)
  }
  return inter
}

/**
 * The precode's constraint equations as zero-payload "droplets": each says
 * (XOR of its sources) XOR (its parity symbol) = 0. Appending these to the received
 * droplets before `geDecode` folds the precode into the linear system.
 */
export function precodeConstraintRows(pre: Precode, W: number): { neighbors: number[]; data: Uint8Array }[] {
  const rows: { neighbors: number[]; data: Uint8Array }[] = []
  for (let j = 0; j < pre.p; j++) {
    rows.push({ neighbors: [...pre.subsets[j], pre.k + j], data: new Uint8Array(W) })
  }
  return rows
}

/** Decode a Raptor stream: GE over droplets + precode constraints, return the sources. */
export function raptorDecode(
  droplets: { neighbors: number[]; data: Uint8Array }[],
  pre: Precode,
  W: number,
): { sources: (Uint8Array | null)[]; rank: number; success: boolean } {
  const rows = droplets.concat(precodeConstraintRows(pre, W))
  const ge = geDecode(rows, pre.L, W)
  return { sources: ge.symbols.slice(0, pre.k), rank: ge.rank, success: ge.success }
}

// ---------------------------------------------------------------------------
// Message ↔ symbols (real byte round-trips)
// ---------------------------------------------------------------------------

/** Split bytes into k symbols of W bytes, zero-padding the final symbol. */
export function bytesToSymbols(bytes: Uint8Array, W: number): Uint8Array[] {
  const k = Math.max(1, Math.ceil(bytes.length / W))
  const out: Uint8Array[] = []
  for (let i = 0; i < k; i++) {
    const sym = new Uint8Array(W)
    sym.set(bytes.subarray(i * W, i * W + W))
    out.push(sym)
  }
  return out
}

/** Reassemble bytes from symbols, trimming to the original length. */
export function symbolsToBytes(symbols: (Uint8Array | null)[], origLen: number): Uint8Array {
  const W = symbols[0]?.length ?? 0
  const out = new Uint8Array(symbols.length * W)
  for (let i = 0; i < symbols.length; i++) {
    if (symbols[i]) out.set(symbols[i]!, i * W)
  }
  return out.subarray(0, origLen)
}

// ---------------------------------------------------------------------------
// Structural analysers (graph-only — success is independent of payload)
// ---------------------------------------------------------------------------

/** Whether the peeling decoder recovers all L symbols from these neighbour sets. */
export function peelSucceedsStruct(neigh: number[][], L: number): number {
  const N = neigh.length
  const rem: Set<number>[] = neigh.map((a) => new Set(a))
  const adj: number[][] = Array.from({ length: L }, () => [])
  for (let j = 0; j < N; j++) for (const s of rem[j]) adj[s].push(j)
  const known = new Array<boolean>(L).fill(false)
  const queue: number[] = []
  for (let j = 0; j < N; j++) if (rem[j].size === 1) queue.push(j)
  let decoded = 0
  while (queue.length) {
    const j = queue.shift()!
    if (rem[j].size !== 1) continue
    const s = rem[j].values().next().value as number
    if (known[s]) {
      rem[j].delete(s)
      continue
    }
    known[s] = true
    decoded++
    for (const jj of adj[s]) {
      if (!rem[jj].has(s)) continue
      rem[jj].delete(s)
      if (rem[jj].size === 1) queue.push(jj)
    }
    if (decoded === L) break
  }
  return decoded
}

/** Rank over GF(2) of the incidence matrix of these neighbour sets. */
export function rankStruct(neigh: number[][], L: number): number {
  const words = (L + 31) >> 5
  const rows: Uint32Array[] = neigh.map((a) => {
    const c = new Uint32Array(words)
    for (const s of a) c[s >> 5] |= 1 << (s & 31)
    return c
  })
  let r = 0
  for (let col = 0; col < L && r < rows.length; col++) {
    let sel = -1
    for (let i = r; i < rows.length; i++) {
      if ((rows[i][col >> 5] >>> (col & 31)) & 1) {
        sel = i
        break
      }
    }
    if (sel < 0) continue
    const t = rows[r]
    rows[r] = rows[sel]
    rows[sel] = t
    for (let i = 0; i < rows.length; i++) {
      if (i !== r && (rows[i][col >> 5] >>> (col & 31)) & 1) {
        for (let w = 0; w < words; w++) rows[i][w] ^= rows[r][w]
      }
    }
    r++
  }
  return r
}

export interface SuccessPoint {
  received: number
  pPeel: number
  pGE: number
  pRaptor: number
}

/**
 * Monte-Carlo decode-success probability vs number of received droplets, for the
 * peeling decoder, the optimal GE decoder, and Raptor (GE + a precode of `p`
 * parities). Purely structural, so it is fast. `trials` runs per point.
 */
export function successCurve(
  dist: DegreeDist,
  opts: { received: number[]; trials: number; salt: number; precodeParities: number; precodeSeed?: number },
): SuccessPoint[] {
  const k = dist.k
  const pre = opts.precodeParities > 0 ? buildPrecode(k, opts.precodeParities, opts.precodeSeed ?? 999) : null
  const preDistL = pre ? robustSoliton(pre.L, 0.03, 0.5) : null
  const out: SuccessPoint[] = []
  for (const received of opts.received) {
    let peelOk = 0
    let geOk = 0
    let rapOk = 0
    for (let t = 0; t < opts.trials; t++) {
      const base = (t + 1) * 1_000_003
      // LT over k sources
      const neigh: number[][] = []
      for (let i = 0; i < received; i++) neigh.push(deriveNeighbors(base + i, opts.salt, dist, k))
      if (peelSucceedsStruct(neigh, k) === k) peelOk++
      if (rankStruct(neigh, k) === k) geOk++
      // Raptor: LT over L intermediates + precode constraints, GE for full rank
      if (pre && preDistL) {
        const rneigh: number[][] = []
        for (let i = 0; i < received; i++) rneigh.push(deriveNeighbors(base + i, opts.salt + 7, preDistL, pre.L))
        for (let j = 0; j < pre.p; j++) rneigh.push([...pre.subsets[j], pre.k + j])
        if (rankStruct(rneigh, pre.L) === pre.L) rapOk++
      }
    }
    out.push({
      received,
      pPeel: peelOk / opts.trials,
      pGE: geOk / opts.trials,
      pRaptor: pre ? rapOk / opts.trials : 0,
    })
  }
  return out
}

/**
 * Mean decode overhead ε = (received − k)/k for the peeling decoder: for each trial,
 * add droplets until all k symbols peel, and average the fraction beyond k.
 */
export function meanPeelOverhead(dist: DegreeDist, trials: number, salt: number, cap = 4): number {
  const k = dist.k
  let total = 0
  let counted = 0
  for (let t = 0; t < trials; t++) {
    const base = (t + 1) * 2_000_003
    const neigh: number[][] = []
    let received = 0
    let ok = false
    const maxR = Math.ceil(k * cap)
    while (received < maxR) {
      neigh.push(deriveNeighbors(base + received, salt, dist, k))
      received++
      if (received >= k && peelSucceedsStruct(neigh, k) === k) {
        ok = true
        break
      }
    }
    if (ok) {
      total += (received - k) / k
      counted++
    }
  }
  return counted > 0 ? total / counted : NaN
}
