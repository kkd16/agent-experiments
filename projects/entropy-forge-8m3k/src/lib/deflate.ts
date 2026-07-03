// deflate.ts — a from-scratch, RFC 1951-compliant DEFLATE codec.
//
// DEFLATE is the algorithm inside gzip, zlib, PNG and the ZIP format: an LZ77
// pass over a 32 KB window turns repetition into (length, distance) matches, and
// a Huffman pass turns the resulting literal/length/distance symbols into bits.
// A stream is a chain of blocks, each one of three flavours — *stored* (raw, for
// incompressible data), *fixed* (a canned Huffman code, no header) or *dynamic*
// (a Huffman code tailored to this block, transmitted up front). This module
// builds all three, an auto-selector that emits the cheapest, and the matching
// inflater. The payoff — proven in the self-test — is that our bytes decompress
// with the browser's native `gunzip`, and its bytes inflate here.

import { packageMerge } from './lengthLimited.ts'
import {
  DeflateWriter,
  DeflateReader,
  canonicalFromLengths,
  buildDecoder,
  decodeSym,
  type HuffTree,
} from './deflateBits.ts'
import {
  LEN_BASE,
  LEN_EXTRA,
  DIST_BASE,
  DIST_EXTRA,
  LEN_CODE,
  DIST_CODE,
  CLC_ORDER,
  MIN_MATCH,
  MAX_MATCH,
  WINDOW_SIZE,
  END_OF_BLOCK,
  NUM_LL,
  NUM_DIST,
  fixedLitLengths,
  fixedDistLengths,
} from './deflateTables.ts'

// ---- tokens: the output of the LZ77 parse ----
export type DToken =
  | { kind: 'lit'; pos: number; byte: number }
  | { kind: 'match'; pos: number; len: number; dist: number }

export interface MatchConfig {
  maxChain: number // hash-chain probes per position (effort vs speed)
  niceLen: number // stop searching once a match this long is found
  lazy: boolean // defer a match one byte to test for a longer one (zlib "slow")
}

export const LEVELS: Record<string, MatchConfig> = {
  fast: { maxChain: 16, niceLen: 16, lazy: false },
  default: { maxChain: 128, niceLen: 128, lazy: true },
  max: { maxChain: 1024, niceLen: MAX_MATCH, lazy: true },
}

// ---- LZ77 with hash chains + optional lazy matching ----
//
// A 3-byte rolling hash indexes a chain of earlier positions sharing that hash
// (`head`/`prev`); the matcher walks the chain, newest first, for the longest
// run within the 32 KB window. Lazy matching (Zip's "slow" strategy) holds a
// found match for one byte to see whether starting one later yields a longer one
// — a cheap, meaningful ratio win on text.
export function lz77(data: Uint8Array, cfg: MatchConfig = LEVELS.default): DToken[] {
  const n = data.length
  const tokens: DToken[] = []
  if (n === 0) return tokens

  const HASH_SIZE = 1 << 15
  const head = new Int32Array(HASH_SIZE).fill(-1)
  const prev = new Int32Array(n).fill(-1)
  const hash = (p: number) =>
    ((data[p] << 10) ^ (data[p + 1] << 5) ^ data[p + 2]) & (HASH_SIZE - 1)

  // Insert position p, returning the previous head of its chain (the newest
  // earlier occurrence — where a search should begin).
  const insert = (p: number): number => {
    if (p + MIN_MATCH > n) return -1
    const h = hash(p)
    const old = head[h]
    prev[p] = old
    head[h] = p
    return old
  }

  const longest = (pos: number, chainStart: number): { len: number; dist: number } => {
    const maxLen = Math.min(MAX_MATCH, n - pos)
    if (maxLen < MIN_MATCH) return { len: 0, dist: 0 }
    let bestLen = MIN_MATCH - 1
    let bestDist = 0
    let cand = chainStart
    let chain = cfg.maxChain
    const limit = Math.max(0, pos - WINDOW_SIZE)
    while (cand >= limit && cand >= 0 && chain-- > 0) {
      // Quick reject: only extend if the byte at bestLen already matches.
      if (data[cand + bestLen] === data[pos + bestLen]) {
        let l = 0
        while (l < maxLen && data[cand + l] === data[pos + l]) l++
        if (l > bestLen) {
          bestLen = l
          bestDist = pos - cand
          if (l >= cfg.niceLen) break
        }
      }
      cand = prev[cand]
    }
    return bestLen >= MIN_MATCH ? { len: bestLen, dist: bestDist } : { len: 0, dist: 0 }
  }

  // Insert every interior position of an accepted match so later matches can
  // reference into it — vital for ratio, harmless to correctness.
  const insertRun = (from: number, to: number) => {
    for (let q = from; q < to; q++) insert(q)
  }

  if (!cfg.lazy) {
    let pos = 0
    while (pos < n) {
      const chain = insert(pos)
      const m = longest(pos, chain)
      if (m.len >= MIN_MATCH) {
        tokens.push({ kind: 'match', pos, len: m.len, dist: m.dist })
        insertRun(pos + 1, pos + m.len)
        pos += m.len
      } else {
        tokens.push({ kind: 'lit', pos, byte: data[pos] })
        pos++
      }
    }
    return tokens
  }

  // Lazy strategy: keep the previous position's match pending until we know the
  // current position can't beat it.
  let pos = 0
  let prevLen = 0
  let prevDist = 0
  let available = false
  while (pos < n) {
    const chain = insert(pos)
    const m = pos + MIN_MATCH <= n ? longest(pos, chain) : { len: 0, dist: 0 }
    if (available && prevLen >= MIN_MATCH && m.len <= prevLen) {
      // The pending match (starting at pos-1) wins: emit it.
      tokens.push({ kind: 'match', pos: pos - 1, len: prevLen, dist: prevDist })
      insertRun(pos + 1, pos - 1 + prevLen)
      pos = pos - 1 + prevLen
      available = false
      prevLen = 0
    } else if (available) {
      // Current is better (or no pending match qualifies): flush the held byte.
      tokens.push({ kind: 'lit', pos: pos - 1, byte: data[pos - 1] })
      prevLen = m.len
      prevDist = m.dist
      available = true
      pos++
    } else {
      prevLen = m.len
      prevDist = m.dist
      available = true
      pos++
    }
  }
  if (available && prevLen >= MIN_MATCH) {
    tokens.push({ kind: 'match', pos: pos - 1, len: prevLen, dist: prevDist })
  } else if (available) {
    tokens.push({ kind: 'lit', pos: pos - 1, byte: data[pos - 1] })
  }
  return tokens
}

// ---- frequency counting over a token stream ----
function tokenFreqs(tokens: DToken[]): { ll: number[]; dist: number[] } {
  const ll = new Array(NUM_LL).fill(0)
  const dist = new Array(NUM_DIST).fill(0)
  for (const t of tokens) {
    if (t.kind === 'lit') ll[t.byte]++
    else {
      ll[257 + LEN_CODE[t.len]]++
      dist[DIST_CODE[t.dist]]++
    }
  }
  ll[END_OF_BLOCK]++ // exactly one EOB terminates the block
  return { ll, dist }
}

// package-merge returns a Map; expand to a dense length array of the given size.
function lengthArray(counts: number[], cap: number, size: number): number[] {
  const { lengths } = packageMerge(counts, cap)
  const out = new Array(size).fill(0)
  for (const [sym, len] of lengths) out[sym] = len
  return out
}

// ---- emitting one token stream against a given LL/dist code ----
function writeTokens(
  w: DeflateWriter,
  tokens: DToken[],
  llCodes: Uint16Array,
  llLen: number[],
  distCodes: Uint16Array,
  distLen: number[],
) {
  for (const t of tokens) {
    if (t.kind === 'lit') {
      w.huff(llCodes[t.byte], llLen[t.byte])
    } else {
      const lc = LEN_CODE[t.len]
      const sym = 257 + lc
      w.huff(llCodes[sym], llLen[sym])
      if (LEN_EXTRA[lc]) w.bits(t.len - LEN_BASE[lc], LEN_EXTRA[lc])
      const dc = DIST_CODE[t.dist]
      w.huff(distCodes[dc], distLen[dc])
      if (DIST_EXTRA[dc]) w.bits(t.dist - DIST_BASE[dc], DIST_EXTRA[dc])
    }
  }
  w.huff(llCodes[END_OF_BLOCK], llLen[END_OF_BLOCK])
}

// ---- code-length RLE (§3.2.7): compress the transmitted length arrays ----
export interface ClcToken {
  sym: number // 0..18
  extra: number
  extraBits: number
}
function rleCodeLengths(lengths: number[]): ClcToken[] {
  const out: ClcToken[] = []
  let i = 0
  while (i < lengths.length) {
    const v = lengths[i]
    let run = 1
    while (i + run < lengths.length && lengths[i + run] === v) run++
    if (v === 0) {
      while (run >= 11) {
        const take = Math.min(run, 138)
        out.push({ sym: 18, extra: take - 11, extraBits: 7 })
        run -= take
        i += take
      }
      while (run >= 3) {
        const take = Math.min(run, 10)
        out.push({ sym: 17, extra: take - 3, extraBits: 3 })
        run -= take
        i += take
      }
      while (run-- > 0) {
        out.push({ sym: 0, extra: 0, extraBits: 0 })
        i++
      }
    } else {
      out.push({ sym: v, extra: 0, extraBits: 0 })
      i++
      run--
      while (run >= 3) {
        const take = Math.min(run, 6)
        out.push({ sym: 16, extra: take - 3, extraBits: 2 })
        run -= take
        i += take
      }
      while (run-- > 0) {
        out.push({ sym: v, extra: 0, extraBits: 0 })
        i++
      }
    }
  }
  return out
}

// ---- the three block flavours, each a complete single-block stream ----

export function encodeStored(data: Uint8Array): Uint8Array {
  const w = new DeflateWriter()
  const n = data.length
  let off = 0
  do {
    const chunk = Math.min(65535, n - off)
    const final = off + chunk >= n ? 1 : 0
    w.bits(final, 1)
    w.bits(0, 2) // BTYPE = 00 (stored)
    w.align()
    w.bits(chunk & 0xff, 8)
    w.bits((chunk >>> 8) & 0xff, 8)
    w.bits(~chunk & 0xff, 8)
    w.bits((~chunk >>> 8) & 0xff, 8)
    for (let k = 0; k < chunk; k++) w.bits(data[off + k], 8)
    off += chunk
  } while (off < n)
  if (n === 0) {
    // A lone empty stored block still needs its header + zero length.
    w.bits(1, 1)
    w.bits(0, 2)
    w.align()
    w.bits(0, 16)
    w.bits(0xffff, 16)
  }
  return w.finish()
}

const FIXED_LL = fixedLitLengths()
const FIXED_DIST = fixedDistLengths()
const FIXED_LL_CODES = canonicalFromLengths(FIXED_LL)
const FIXED_DIST_CODES = canonicalFromLengths(FIXED_DIST)

export function encodeFixed(tokens: DToken[]): Uint8Array {
  const w = new DeflateWriter()
  w.bits(1, 1) // BFINAL
  w.bits(1, 2) // BTYPE = 01 (fixed)
  writeTokens(w, tokens, FIXED_LL_CODES, FIXED_LL, FIXED_DIST_CODES, FIXED_DIST)
  return w.finish()
}

export interface DynamicPlan {
  hlit: number
  hdist: number
  hclen: number
  llLengths: number[]
  distLengths: number[]
  clcLengths: number[]
  clcOrderSent: number[] // the trimmed CLC_ORDER actually transmitted
  clcTokens: ClcToken[]
  headerBits: number // bits spent on the block header (before the data symbols)
  bodyBits: number // bits spent on the literal/length/distance symbols + EOB
}

export function encodeDynamic(tokens: DToken[]): { bytes: Uint8Array; plan: DynamicPlan } {
  const { ll, dist } = tokenFreqs(tokens)

  // LL lengths — guarantee at least two symbols so the code is a *complete* tree
  // (zlib rejects an incomplete literal/length code, e.g. empty input's lone EOB).
  const llLengths = lengthArray(ll, 15, NUM_LL)
  let used = llLengths.filter((l) => l > 0).length
  for (let s = 0; used < 2 && s < NUM_LL; s++) {
    if (llLengths[s] === 0) {
      llLengths[s] = 1
      used++
    }
  }

  // Distance lengths — the RFC's special case: no distances → a single 1-bit
  // (deliberately incomplete) code, which inflaters accept as long as it's unused.
  const anyDist = dist.some((f) => f > 0)
  const distLengths = anyDist ? lengthArray(dist, 15, NUM_DIST) : [1]

  // HLIT/HDIST: highest used index (+1), clamped to the legal minimums.
  let hlit = NUM_LL
  while (hlit > 257 && llLengths[hlit - 1] === 0) hlit--
  let hdist = distLengths.length
  while (hdist > 1 && distLengths[hdist - 1] === 0) hdist--

  const sentLL = llLengths.slice(0, hlit)
  const sentDist = distLengths.slice(0, hdist)
  const clcTokens = rleCodeLengths(sentLL.concat(sentDist))

  const clcFreq = new Array(19).fill(0)
  for (const t of clcTokens) clcFreq[t.sym]++
  const clcLengths = lengthArray(clcFreq, 7, 19)

  // HCLEN: send CLC lengths in the shuffled order, dropping trailing zeros (≥4).
  let hclen = CLC_ORDER.length
  while (hclen > 4 && clcLengths[CLC_ORDER[hclen - 1]] === 0) hclen--
  const clcOrderSent = CLC_ORDER.slice(0, hclen)

  const llCodes = canonicalFromLengths(llLengths)
  const distCodes = canonicalFromLengths(distLengths)
  const clcCodes = canonicalFromLengths(clcLengths)

  const w = new DeflateWriter()
  w.bits(1, 1) // BFINAL
  w.bits(2, 2) // BTYPE = 10 (dynamic)
  w.bits(hlit - 257, 5)
  w.bits(hdist - 1, 5)
  w.bits(hclen - 4, 4)
  for (const c of clcOrderSent) w.bits(clcLengths[c], 3)
  for (const t of clcTokens) {
    w.huff(clcCodes[t.sym], clcLengths[t.sym])
    if (t.extraBits) w.bits(t.extra, t.extraBits)
  }
  const headerBits = w.bitLength
  writeTokens(w, tokens, llCodes, llLengths, distCodes, distLengths)
  const bodyBits = w.bitLength - headerBits

  return {
    bytes: w.finish(),
    plan: {
      hlit,
      hdist,
      hclen,
      llLengths,
      distLengths,
      clcLengths,
      clcOrderSent,
      clcTokens,
      headerBits,
      bodyBits,
    },
  }
}

// ---- the public compressor ----
export type Strategy = 'stored' | 'fixed' | 'dynamic' | 'auto'

export interface DeflateResult {
  bytes: Uint8Array
  chosen: Exclude<Strategy, 'auto'>
  tokens: DToken[]
  sizes: { stored: number; fixed: number; dynamic: number } // bytes per strategy
  plan: DynamicPlan
}

export function deflate(
  data: Uint8Array,
  opts: { strategy?: Strategy; level?: keyof typeof LEVELS } = {},
): DeflateResult {
  const strategy = opts.strategy ?? 'auto'
  const tokens = lz77(data, LEVELS[opts.level ?? 'default'])

  const stored = encodeStored(data)
  const fixed = encodeFixed(tokens)
  const { bytes: dynamic, plan } = encodeDynamic(tokens)
  const sizes = { stored: stored.length, fixed: fixed.length, dynamic: dynamic.length }

  let chosen: Exclude<Strategy, 'auto'>
  let bytes: Uint8Array
  if (strategy === 'stored') {
    chosen = 'stored'
    bytes = stored
  } else if (strategy === 'fixed') {
    chosen = 'fixed'
    bytes = fixed
  } else if (strategy === 'dynamic') {
    chosen = 'dynamic'
    bytes = dynamic
  } else {
    // auto: the smallest wins, ties preferring the simpler encoder.
    chosen = 'stored'
    bytes = stored
    if (fixed.length < bytes.length) {
      chosen = 'fixed'
      bytes = fixed
    }
    if (dynamic.length < bytes.length) {
      chosen = 'dynamic'
      bytes = dynamic
    }
  }
  return { bytes, chosen, tokens, sizes, plan }
}

// ---- the inflater ----
const FIXED_LL_TREE = buildDecoder(FIXED_LL)
const FIXED_DIST_TREE = buildDecoder(FIXED_DIST)

function inflateBlockData(r: DeflateReader, llTree: HuffTree, distTree: HuffTree, out: number[]) {
  for (;;) {
    const sym = decodeSym(r, llTree)
    if (sym === END_OF_BLOCK) return
    if (sym < 256) {
      out.push(sym)
      continue
    }
    const lc = sym - 257
    if (lc >= LEN_BASE.length) throw new Error(`bad length code ${sym}`)
    const len = LEN_BASE[lc] + r.bits(LEN_EXTRA[lc])
    const dc = decodeSym(r, distTree)
    if (dc >= DIST_BASE.length) throw new Error(`bad distance code ${dc}`)
    const dist = DIST_BASE[dc] + r.bits(DIST_EXTRA[dc])
    let from = out.length - dist
    if (from < 0) throw new Error('back-reference before start of stream')
    for (let k = 0; k < len; k++) out.push(out[from++])
  }
}

export function inflate(data: Uint8Array, byteOffset = 0): Uint8Array {
  const r = new DeflateReader(data, byteOffset)
  const out: number[] = []
  for (;;) {
    const bfinal = r.bits(1)
    const btype = r.bits(2)
    if (btype === 0) {
      r.align()
      const len = r.bits(16)
      const nlen = r.bits(16)
      if ((len ^ 0xffff) !== nlen) throw new Error('stored block length check failed')
      const chunk = r.bytes(len)
      for (let k = 0; k < len; k++) out.push(chunk[k])
    } else if (btype === 1) {
      inflateBlockData(r, FIXED_LL_TREE, FIXED_DIST_TREE, out)
    } else if (btype === 2) {
      const hlit = r.bits(5) + 257
      const hdist = r.bits(5) + 1
      const hclen = r.bits(4) + 4
      const clcLengths = new Array(19).fill(0)
      for (let i = 0; i < hclen; i++) clcLengths[CLC_ORDER[i]] = r.bits(3)
      const clcTree = buildDecoder(clcLengths)
      const allLengths: number[] = []
      while (allLengths.length < hlit + hdist) {
        const sym = decodeSym(r, clcTree)
        if (sym < 16) {
          allLengths.push(sym)
        } else if (sym === 16) {
          const rep = r.bits(2) + 3
          const prev = allLengths[allLengths.length - 1]
          for (let k = 0; k < rep; k++) allLengths.push(prev)
        } else if (sym === 17) {
          const rep = r.bits(3) + 3
          for (let k = 0; k < rep; k++) allLengths.push(0)
        } else {
          const rep = r.bits(7) + 11
          for (let k = 0; k < rep; k++) allLengths.push(0)
        }
      }
      if (allLengths.length !== hlit + hdist) throw new Error('code-length overrun')
      const llTree = buildDecoder(allLengths.slice(0, hlit))
      const distTree = buildDecoder(allLengths.slice(hlit))
      inflateBlockData(r, llTree, distTree, out)
    } else {
      throw new Error('reserved block type 11')
    }
    if (bfinal) break
  }
  return Uint8Array.from(out)
}
