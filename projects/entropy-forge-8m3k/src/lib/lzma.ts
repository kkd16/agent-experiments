// lzma.ts — a genuine, from-scratch LZMA codec (the algorithm inside 7-Zip / xz),
// built on the same idea as the rest of the lab: a real bitstream that provably
// round-trips. Nothing here is a wrapper around a library — the binary range coder,
// the 12-state context machine, the rep-distance model, the bit-tree distance and
// length coders and the HC4 match finder are all hand-written.
//
// LZMA is the strongest general-purpose coder in this lab. Where DEFLATE splits a
// literal/length stream from a distance stream and Huffman-codes each, LZMA feeds
// *every* decision — is-this-a-match, is-it-a-repeat, the length, the distance
// slot, the literal byte — to a single adaptive **binary range coder** whose
// per-bit probabilities are selected by a rich context: the 12-state machine that
// remembers what the last few packets were, the low position bits, the previous
// byte, and (on the literal after a match) the byte that *would* have been copied.
// The four most-recent distances are kept in an MRU list (rep0..rep3) and recoded
// almost for free, which is why LZMA crushes structured data that reuses offsets.
//
// The decoder is driven purely by the model; it knows the output length (carried
// in the codec header, as everywhere else in this lab) rather than an end marker,
// so it decodes exactly `outLen` bytes and stops. Encoder and decoder call the
// identical sequence of model primitives in the identical order, so the adaptive
// probabilities stay in lock-step and the stream inverts by construction.
//
// References followed: the LZMA specification (lzma.txt, Igor Pavlov) and the
// reference range-coder normalisation (kTopValue renorm, the leading cache byte).

// ---- model constants ----
const K_NUM_STATES = 12
// The LZMA defaults (lc=3, lp=0, pb=2). These are now *tunable*: lc = literal
// context bits (high bits of the previous byte), lp = literal position bits, pb =
// position bits (low bits of the stream position). The encoder auto-selects the
// best (lc,lp,pb) for the data and transmits the one-byte `props` = (pb·5+lp)·9+lc
// — exactly what xz's `--lzma2=lc=..,lp=..,pb=..` tunes and stores.
const DEFAULT_LC = 3
const DEFAULT_LP = 0
const DEFAULT_PB = 2

export interface LzmaCfg {
  lc: number
  lp: number
  pb: number
  posMask: number
  litPosMask: number
}
function makeCfg(lc: number, lp: number, pb: number): LzmaCfg {
  return { lc, lp, pb, posMask: (1 << pb) - 1, litPosMask: (1 << lp) - 1 }
}
/** Encode (lc,lp,pb) into the single LZMA properties byte. */
export function propsByte(lc: number, lp: number, pb: number): number {
  return (pb * 5 + lp) * 9 + lc
}
/** Decode the LZMA properties byte back to (lc,lp,pb). */
export function parseProps(b: number): { lc: number; lp: number; pb: number } {
  const lc = b % 9
  const r = Math.floor(b / 9)
  return { lc, lp: r % 5, pb: Math.floor(r / 5) }
}

// The presets the auto-encoder races. lc+lp ≤ 4 and pb ≤ 4 keep the props byte
// valid and the arrays bounded (isMatch/isRep0Long are indexed by ≤4 pos bits).
// Each preset suits a different structure: pb=0 for byte-granular text, lp for
// column-aligned/binary data, higher lc for text with strong previous-byte order.
const CFG_PRESETS: [number, number, number][] = [
  [3, 0, 2], // LZMA default
  [3, 0, 0], // no position alignment (text, logs)
  [4, 0, 2], // more literal context (natural language)
  [2, 0, 0], // lean literal context, no alignment
  [0, 2, 2], // position-model literals (aligned/tabular binary)
  [0, 0, 0], // minimal context (near-random / tiny inputs)
]

const K_MATCH_MIN_LEN = 2
// 2 + (8 low + 8 mid + 256 high − 1) length symbols = 273, LZMA's maximum match.
const K_MATCH_MAX_LEN = 273

const K_NUM_POS_BITS_MAX = 4 // IsMatch/IsRep0Long are indexed by up to 4 pos bits
const K_NUM_POS_STATES_MAX = 1 << K_NUM_POS_BITS_MAX

const K_NUM_LEN_TO_POS_STATES = 4
const K_NUM_ALIGN_BITS = 4
const K_END_POS_MODEL_INDEX = 14
const K_START_POS_MODEL_INDEX = 4
const K_NUM_FULL_DISTANCES = 1 << (K_END_POS_MODEL_INDEX >> 1) // 128
const K_NUM_POS_SLOT_BITS = 6

const K_NUM_LEN_LOW_BITS = 3
const K_NUM_LEN_MID_BITS = 3
const K_NUM_LEN_HIGH_BITS = 8
const K_LEN_LOW_SYMBOLS = 1 << K_NUM_LEN_LOW_BITS // 8
const K_LEN_MID_SYMBOLS = 1 << K_NUM_LEN_MID_BITS // 8
const K_LEN_HIGH_SYMBOLS = 1 << K_NUM_LEN_HIGH_BITS // 256

// ---- range-coder constants ----
const K_TOP = 1 << 24
const K_NUM_BIT_MODEL_TOTAL_BITS = 11
const K_BIT_MODEL_TOTAL = 1 << K_NUM_BIT_MODEL_TOTAL_BITS // 2048
const K_NUM_MOVE_BITS = 5
const PROB_INIT = K_BIT_MODEL_TOTAL >> 1 // 1024

// state-machine transitions ---------------------------------------------------
const stateUpdateLiteral = (s: number) => (s < 4 ? 0 : s < 10 ? s - 3 : s - 6)
const stateUpdateMatch = (s: number) => (s < 7 ? 7 : 10)
const stateUpdateRep = (s: number) => (s < 7 ? 8 : 11)
const stateUpdateShortRep = (s: number) => (s < 7 ? 9 : 11)
const stateIsCharState = (s: number) => s < 7

// =============================================================================
// Binary range ENCODER — 32-bit range, 33-bit low with carry via a cache byte.
// =============================================================================
class RangeEnc {
  private low = 0 // < 2^33 (a uint32 that may carry once)
  private range = 0xffffffff
  private cache = 0
  private cacheSize = 1
  out: number[] = []

  private shiftLow() {
    const carry = Math.floor(this.low / 0x100000000) // 0 or 1
    if (carry !== 0 || this.low < 0xff000000) {
      let temp = this.cache
      do {
        this.out.push((temp + carry) & 0xff)
        temp = 0xff
      } while (--this.cacheSize !== 0)
      this.cache = Math.floor((this.low % 0x100000000) / 0x1000000) & 0xff
    }
    this.cacheSize++
    this.low = (this.low % 0x1000000) * 256
  }

  encodeBit(probs: Uint16Array, i: number, bit: number) {
    const prob = probs[i]
    const bound = (this.range >>> 11) * prob
    if (bit === 0) {
      this.range = bound
      probs[i] = prob + ((K_BIT_MODEL_TOTAL - prob) >>> K_NUM_MOVE_BITS)
    } else {
      this.low += bound
      this.range = this.range - bound
      probs[i] = prob - (prob >>> K_NUM_MOVE_BITS)
    }
    while (this.range < K_TOP) {
      this.range = (this.range * 256) >>> 0
      this.shiftLow()
    }
  }

  encodeDirectBits(value: number, numBits: number) {
    for (let i = numBits - 1; i >= 0; i--) {
      this.range = this.range >>> 1
      if ((value >>> i) & 1) this.low += this.range
      while (this.range < K_TOP) {
        this.range = (this.range * 256) >>> 0
        this.shiftLow()
      }
    }
  }

  // MSB-first bit tree over 2^numBits leaves (probs index base 1..2^n-1).
  encodeBitTree(probs: Uint16Array, base: number, numBits: number, symbol: number) {
    let m = 1
    for (let i = numBits - 1; i >= 0; i--) {
      const b = (symbol >>> i) & 1
      this.encodeBit(probs, base + m, b)
      m = (m << 1) | b
    }
  }

  // LSB-first (reverse) bit tree — for the align bits and the mid distances.
  encodeBitTreeReverse(probs: Uint16Array, base: number, numBits: number, symbol: number) {
    let m = 1
    for (let i = 0; i < numBits; i++) {
      const b = symbol & 1
      symbol >>>= 1
      this.encodeBit(probs, base + m, b)
      m = (m << 1) | b
    }
  }

  flush(): Uint8Array {
    for (let i = 0; i < 5; i++) this.shiftLow()
    return Uint8Array.from(this.out)
  }
}

// =============================================================================
// Binary range DECODER — the exact mirror of the encoder's renormalisation.
// =============================================================================
class RangeDec {
  private code = 0
  private range = 0xffffffff
  private data: Uint8Array
  private pos: number

  constructor(data: Uint8Array, start = 0) {
    this.data = data
    this.pos = start
    this.pos++ // skip the leading (always-zero) byte the encoder emits
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.nextByte()) >>> 0
  }

  private nextByte(): number {
    return this.pos < this.data.length ? this.data[this.pos++] : (this.pos++, 0)
  }

  private normalize() {
    if (this.range < K_TOP) {
      this.range = (this.range * 256) >>> 0
      this.code = ((this.code << 8) | this.nextByte()) >>> 0
    }
  }

  decodeBit(probs: Uint16Array, i: number): number {
    const prob = probs[i]
    const bound = (this.range >>> 11) * prob
    let bit: number
    // unsigned comparison: both operands are held in [0, 2^32)
    if ((this.code >>> 0) < bound) {
      this.range = bound
      probs[i] = prob + ((K_BIT_MODEL_TOTAL - prob) >>> K_NUM_MOVE_BITS)
      bit = 0
    } else {
      this.code = (this.code - bound) >>> 0
      this.range = this.range - bound
      probs[i] = prob - (prob >>> K_NUM_MOVE_BITS)
      bit = 1
    }
    this.normalize()
    return bit
  }

  decodeDirectBits(numBits: number): number {
    let result = 0
    for (let i = 0; i < numBits; i++) {
      this.range = this.range >>> 1
      let t = 0
      if ((this.code >>> 0) >= this.range) {
        this.code = (this.code - this.range) >>> 0
        t = 1
      }
      result = ((result << 1) | t) >>> 0
      this.normalize()
    }
    return result
  }

  decodeBitTree(probs: Uint16Array, base: number, numBits: number): number {
    let m = 1
    for (let i = 0; i < numBits; i++) m = (m << 1) | this.decodeBit(probs, base + m)
    return m - (1 << numBits)
  }

  decodeBitTreeReverse(probs: Uint16Array, base: number, numBits: number): number {
    let m = 1
    let symbol = 0
    for (let i = 0; i < numBits; i++) {
      const b = this.decodeBit(probs, base + m)
      m = (m << 1) | b
      symbol |= b << i
    }
    return symbol
  }
}

// =============================================================================
// The shared probability model — one flat set of tables, laid out exactly like
// the reference so encode and decode index it identically.
// =============================================================================
function newProbs(n: number): Uint16Array {
  const p = new Uint16Array(n)
  p.fill(PROB_INIT)
  return p
}

class LzmaModel {
  constructor(lc: number, lp: number) {
    this.literal = newProbs(0x300 << (lc + lp))
  }
  isMatch = newProbs(K_NUM_STATES << K_NUM_POS_BITS_MAX)
  isRep = newProbs(K_NUM_STATES)
  isRepG0 = newProbs(K_NUM_STATES)
  isRepG1 = newProbs(K_NUM_STATES)
  isRepG2 = newProbs(K_NUM_STATES)
  isRep0Long = newProbs(K_NUM_STATES << K_NUM_POS_BITS_MAX)
  posSlot = newProbs(K_NUM_LEN_TO_POS_STATES << K_NUM_POS_SLOT_BITS)
  // The reverse bit-tree base is (dist − posSlot); for posSlot=13 the top index
  // reaches (96−13)+31 = 114, so the table needs 115 slots (the reference's
  // `1 + kNumFullDistances − kEndPosModelIndex`). One short and an OOB write is
  // silently dropped by the typed array, later re-read as a zero probability.
  specPos = newProbs(1 + K_NUM_FULL_DISTANCES - K_END_POS_MODEL_INDEX)
  align = newProbs(1 << K_NUM_ALIGN_BITS)
  // literals: (0x300) sub-coders per (litPos<<lc | prevHigh) context; sized in
  // the constructor from the active (lc, lp).
  literal: Uint16Array
  // two length coders (one for new matches, one for rep matches)
  len = new LenModel()
  repLen = new LenModel()
}

class LenModel {
  choice = newProbs(2)
  low = newProbs(K_NUM_POS_STATES_MAX << K_NUM_LEN_LOW_BITS)
  mid = newProbs(K_NUM_POS_STATES_MAX << K_NUM_LEN_MID_BITS)
  high = newProbs(K_LEN_HIGH_SYMBOLS)
}

// length coder: value = len - K_MATCH_MIN_LEN, split low/mid/high
function encodeLen(rc: RangeEnc, lm: LenModel, value: number, posState: number) {
  if (value < K_LEN_LOW_SYMBOLS) {
    rc.encodeBit(lm.choice, 0, 0)
    rc.encodeBitTree(lm.low, posState << K_NUM_LEN_LOW_BITS, K_NUM_LEN_LOW_BITS, value)
  } else {
    rc.encodeBit(lm.choice, 0, 1)
    value -= K_LEN_LOW_SYMBOLS
    if (value < K_LEN_MID_SYMBOLS) {
      rc.encodeBit(lm.choice, 1, 0)
      rc.encodeBitTree(lm.mid, posState << K_NUM_LEN_MID_BITS, K_NUM_LEN_MID_BITS, value)
    } else {
      rc.encodeBit(lm.choice, 1, 1)
      rc.encodeBitTree(lm.high, 0, K_NUM_LEN_HIGH_BITS, value - K_LEN_MID_SYMBOLS)
    }
  }
}
function decodeLen(rc: RangeDec, lm: LenModel, posState: number): number {
  if (rc.decodeBit(lm.choice, 0) === 0) {
    return rc.decodeBitTree(lm.low, posState << K_NUM_LEN_LOW_BITS, K_NUM_LEN_LOW_BITS)
  }
  if (rc.decodeBit(lm.choice, 1) === 0) {
    return K_LEN_LOW_SYMBOLS + rc.decodeBitTree(lm.mid, posState << K_NUM_LEN_MID_BITS, K_NUM_LEN_MID_BITS)
  }
  return K_LEN_LOW_SYMBOLS + K_LEN_MID_SYMBOLS + rc.decodeBitTree(lm.high, 0, K_NUM_LEN_HIGH_BITS)
}

const lenToPosState = (len: number) => Math.min(len - K_MATCH_MIN_LEN, K_NUM_LEN_TO_POS_STATES - 1)

// distance (posSlot + direct bits + align) ------------------------------------
function encodeDistance(rc: RangeEnc, m: LzmaModel, len: number, dist: number) {
  const lenState = lenToPosState(len)
  const posSlot = getPosSlot(dist)
  rc.encodeBitTree(m.posSlot, lenState << K_NUM_POS_SLOT_BITS, K_NUM_POS_SLOT_BITS, posSlot)
  if (posSlot >= K_START_POS_MODEL_INDEX) {
    const numDirect = (posSlot >> 1) - 1
    const base = (2 | (posSlot & 1)) << numDirect
    if (posSlot < K_END_POS_MODEL_INDEX) {
      rc.encodeBitTreeReverse(m.specPos, base - posSlot, numDirect, dist - base)
    } else {
      rc.encodeDirectBits((dist - base) >>> K_NUM_ALIGN_BITS, numDirect - K_NUM_ALIGN_BITS)
      rc.encodeBitTreeReverse(m.align, 0, K_NUM_ALIGN_BITS, (dist - base) & ((1 << K_NUM_ALIGN_BITS) - 1))
    }
  }
}
function decodeDistance(rc: RangeDec, m: LzmaModel, len: number): number {
  const lenState = lenToPosState(len)
  const posSlot = rc.decodeBitTree(m.posSlot, lenState << K_NUM_POS_SLOT_BITS, K_NUM_POS_SLOT_BITS)
  if (posSlot < K_START_POS_MODEL_INDEX) return posSlot
  const numDirect = (posSlot >> 1) - 1
  let dist = (2 | (posSlot & 1)) << numDirect
  if (posSlot < K_END_POS_MODEL_INDEX) {
    dist += rc.decodeBitTreeReverse(m.specPos, dist - posSlot, numDirect)
  } else {
    dist = (dist + rc.decodeDirectBits(numDirect - K_NUM_ALIGN_BITS) * (1 << K_NUM_ALIGN_BITS)) >>> 0
    dist = (dist + rc.decodeBitTreeReverse(m.align, 0, K_NUM_ALIGN_BITS)) >>> 0
  }
  return dist >>> 0
}

// posSlot(d): the index of the top set bit doubled, plus the next bit — the
// classic LZMA "slot" that buckets a distance into a magnitude class.
function getPosSlot(dist: number): number {
  if (dist < K_START_POS_MODEL_INDEX) return dist
  let n = 31
  while (n > 0 && ((dist >>> n) & 1) === 0) n--
  // n = index of the most significant set bit
  return (n << 1) | ((dist >>> (n - 1)) & 1)
}

// literal -------------------------------------------------------------------
function litContextBase(pos: number, prevByte: number, cfg: LzmaCfg): number {
  const litState =
    (((pos & cfg.litPosMask) << cfg.lc) + (cfg.lc > 0 ? prevByte >>> (8 - cfg.lc) : 0)) >>> 0
  return litState * 0x300
}
function encodeLiteral(
  rc: RangeEnc,
  m: LzmaModel,
  base: number,
  symbol: number,
  matched: boolean,
  matchByte: number,
) {
  let ctx = 1
  if (matched) {
    let mb = matchByte
    for (let i = 7; i >= 0; i--) {
      const matchBit = (mb >>> 7) & 1
      mb = (mb << 1) & 0xff
      const bit = (symbol >>> i) & 1
      rc.encodeBit(m.literal, base + (((1 + matchBit) << 8) + ctx), bit)
      ctx = (ctx << 1) | bit
      if (matchBit !== bit) {
        for (i--; i >= 0; i--) {
          const b2 = (symbol >>> i) & 1
          rc.encodeBit(m.literal, base + ctx, b2)
          ctx = (ctx << 1) | b2
        }
        break
      }
    }
  } else {
    for (let i = 7; i >= 0; i--) {
      const bit = (symbol >>> i) & 1
      rc.encodeBit(m.literal, base + ctx, bit)
      ctx = (ctx << 1) | bit
    }
  }
}
function decodeLiteral(
  rc: RangeDec,
  m: LzmaModel,
  base: number,
  matched: boolean,
  matchByte: number,
): number {
  let ctx = 1
  if (matched) {
    let mb = matchByte
    do {
      const matchBit = (mb >>> 7) & 1
      mb = (mb << 1) & 0xff
      const bit = rc.decodeBit(m.literal, base + (((1 + matchBit) << 8) + ctx))
      ctx = (ctx << 1) | bit
      if (matchBit !== bit) {
        while (ctx < 0x100) ctx = (ctx << 1) | rc.decodeBit(m.literal, base + ctx)
        break
      }
    } while (ctx < 0x100)
  } else {
    while (ctx < 0x100) ctx = (ctx << 1) | rc.decodeBit(m.literal, base + ctx)
  }
  return ctx & 0xff
}

// =============================================================================
// HC4 match finder — hash2 + hash3 head tables and a hash4 chain, exactly the
// structure real LZMA "fast" mode uses. Returns the best (len, dist) at a pos.
// =============================================================================
const HASH2_BITS = 10
const HASH3_BITS = 16
const HASH4_BITS = 17
const HASH2_SIZE = 1 << HASH2_BITS
const HASH3_SIZE = 1 << HASH3_BITS
const HASH4_SIZE = 1 << HASH4_BITS

class MatchFinder {
  private data: Uint8Array
  private head2: Int32Array
  private head3: Int32Array
  private head4: Int32Array
  private chain: Int32Array
  private maxChain: number
  private niceLen: number

  constructor(data: Uint8Array, maxChain = 256, niceLen = 128) {
    this.data = data
    this.head2 = new Int32Array(HASH2_SIZE).fill(-1)
    this.head3 = new Int32Array(HASH3_SIZE).fill(-1)
    this.head4 = new Int32Array(HASH4_SIZE).fill(-1)
    this.chain = new Int32Array(data.length).fill(-1)
    this.maxChain = maxChain
    this.niceLen = niceLen
  }

  private h2(p: number) {
    return (this.data[p] | (this.data[p + 1] << 8)) & (HASH2_SIZE - 1)
  }
  private h3(p: number) {
    return ((this.data[p] * 506832829 + this.data[p + 1] * 65599 + this.data[p + 2]) >>> (32 - HASH3_BITS)) & (HASH3_SIZE - 1)
  }
  private h4(p: number) {
    return (
      (this.data[p] * 2654435761 + this.data[p + 1] * 40503 + this.data[p + 2] * 3266489917 + this.data[p + 3]) >>>
      (32 - HASH4_BITS)
    ) & (HASH4_SIZE - 1)
  }

  private matchLen(a: number, b: number, limit: number): number {
    const d = this.data
    let l = 0
    while (l < limit && d[a + l] === d[b + l]) l++
    return l
  }

  // Find the best normal (new-distance) match at pos. Returns {len,dist} with
  // dist = byteDistance-1 (the value the coder stores), or len < MIN if none.
  best(pos: number): { len: number; dist: number } {
    const n = this.data.length
    const remaining = n - pos
    if (remaining < K_MATCH_MIN_LEN) return { len: 0, dist: 0 }
    const limit = Math.min(remaining, K_MATCH_MAX_LEN)
    let bestLen = 0
    let bestDist = 0

    // length-2 candidate (head only)
    if (remaining >= 2) {
      const c = this.head2[this.h2(pos)]
      if (c >= 0) {
        const l = this.matchLen(c, pos, limit)
        if (l >= 2 && l > bestLen) {
          bestLen = l
          bestDist = pos - c - 1
        }
      }
    }
    // length-3 candidate (head only)
    if (remaining >= 3) {
      const c = this.head3[this.h3(pos)]
      if (c >= 0) {
        const l = this.matchLen(c, pos, limit)
        if (l >= 3 && l > bestLen) {
          bestLen = l
          bestDist = pos - c - 1
        }
      }
    }
    // length-4+ chain
    if (remaining >= 4) {
      let c = this.head4[this.h4(pos)]
      let depth = this.maxChain
      while (c >= 0 && depth-- > 0) {
        const l = this.matchLen(c, pos, limit)
        if (l > bestLen || (l === bestLen && l >= 4 && pos - c - 1 < bestDist)) {
          if (l >= 4) {
            bestLen = l
            bestDist = pos - c - 1
          }
        }
        if (bestLen >= this.niceLen || bestLen >= limit) break
        c = this.chain[c]
      }
    }
    return { len: bestLen, dist: bestDist }
  }

  // Register position `pos` into all three hash structures.
  insert(pos: number) {
    const n = this.data.length
    if (pos + 1 < n) this.head2[this.h2(pos)] = pos
    if (pos + 2 < n) this.head3[this.h3(pos)] = pos
    if (pos + 3 < n) {
      const h = this.h4(pos)
      this.chain[pos] = this.head4[h]
      this.head4[h] = pos
    }
  }
}

// =============================================================================
// Token trace (for the visualiser). Not part of the bitstream.
// =============================================================================
export type LzmaTokenKind = 'lit' | 'match' | 'rep' | 'shortrep'
export interface LzmaToken {
  kind: LzmaTokenKind
  pos: number
  len: number
  dist: number // byte distance (>=1), 0 for literals
  repIndex: number // 0..3 for rep matches, -1 otherwise
  state: number // context state BEFORE this packet
  byte: number // the literal byte (for kind==='lit')
}

export interface LzmaStats {
  literals: number
  matches: number
  reps: number
  shortReps: number
  matchBytes: number // bytes emitted by (rep+match) copies
  literalBytes: number
  streamBytes: number
  bitsPerByte: number
  repDist: [number, number, number, number] // packets resolved to rep0..rep3
}

export interface LzmaResult {
  encoded: Uint8Array
  tokens: LzmaToken[]
  stats: LzmaStats
  props: { lc: number; lp: number; pb: number } // the (auto-)selected literal/pos model
}

export const LZMA_PARAMS = {
  LC: DEFAULT_LC,
  LP: DEFAULT_LP,
  PB: DEFAULT_PB,
  MIN_MATCH: K_MATCH_MIN_LEN,
  MAX_MATCH: K_MATCH_MAX_LEN,
  STATES: K_NUM_STATES,
  PRESETS: CFG_PRESETS,
}

export interface LzmaOpts {
  maxChain?: number
  niceLen?: number
  collectTokens?: boolean
  // Force a specific model instead of auto-selecting. Omit to auto-tune.
  lc?: number
  lp?: number
  pb?: number
  auto?: boolean // default true when lc/lp/pb are not all given
}

// =============================================================================
// ENCODE — auto-tunes (lc,lp,pb) over CFG_PRESETS unless one is forced, then
// ships the properties byte + the smallest range stream.
// =============================================================================
export function lzmaEncode(data: Uint8Array, opts: LzmaOpts = {}): LzmaResult {
  const forced = opts.lc !== undefined && opts.lp !== undefined && opts.pb !== undefined
  const auto = opts.auto ?? !forced
  const collect = opts.collectTokens ?? false

  if (forced && !auto) {
    return encodeWith(data, makeCfg(opts.lc!, opts.lp!, opts.pb!), opts, collect)
  }

  // Race the presets; keep the smallest. Trials skip the token trace for speed;
  // the winner is re-encoded with the trace if the caller asked for one.
  let best: LzmaResult | null = null
  for (const [lc, lp, pb] of CFG_PRESETS) {
    const r = encodeWith(data, makeCfg(lc, lp, pb), opts, false)
    if (!best || r.encoded.length < best.encoded.length) best = r
  }
  const winner = best!
  if (collect) {
    return encodeWith(data, makeCfg(winner.props.lc, winner.props.lp, winner.props.pb), opts, true)
  }
  return winner
}

// One encode pass with a fixed model config. Output = [propsByte, ...rangeStream].
function encodeWith(data: Uint8Array, cfg: LzmaCfg, opts: LzmaOpts, collect: boolean): LzmaResult {
  const rc = new RangeEnc()
  const m = new LzmaModel(cfg.lc, cfg.lp)
  const mf = new MatchFinder(data, opts.maxChain ?? 256, opts.niceLen ?? 128)
  const n = data.length
  const tokens: LzmaToken[] = []

  let state = 0
  let rep0 = 0
  let rep1 = 0
  let rep2 = 0
  let rep3 = 0
  const reps = () => [rep0, rep1, rep2, rep3]

  const stats: LzmaStats = {
    literals: 0,
    matches: 0,
    reps: 0,
    shortReps: 0,
    matchBytes: 0,
    literalBytes: 0,
    streamBytes: 0,
    bitsPerByte: 0,
    repDist: [0, 0, 0, 0],
  }

  // rep match length at position p for a given byte-distance d (=repX+1)
  const repMatchLen = (p: number, d: number): number => {
    if (d < 1 || d > p) return 0
    const src = p - d
    const limit = Math.min(n - p, K_MATCH_MAX_LEN)
    let l = 0
    while (l < limit && data[src + l] === data[p + l]) l++
    return l
  }
  // best of the four reps at p → {len, index}
  const bestRep = (p: number): { len: number; index: number } => {
    const rs = reps()
    let bl = 0
    let bi = 0
    for (let i = 0; i < 4; i++) {
      const l = repMatchLen(p, rs[i] + 1)
      if (l > bl) {
        bl = l
        bi = i
      }
    }
    return { len: bl, index: bi }
  }

  let pos = 0
  while (pos < n) {
    const posState = pos & cfg.posMask
    const main = mf.best(pos)
    const rep = bestRep(pos)

    // decide the packet ----------------------------------------------------
    let action: 'lit' | 'match' | 'rep' = 'lit'
    let useLen = 0
    let useDist = 0 // stored dist for a new match
    let useRepIdx = 0

    const mainOk = main.len >= K_MATCH_MIN_LEN && !(main.len === 2 && main.dist >= 512)
    if (rep.len >= K_MATCH_MIN_LEN && rep.len + 1 >= (mainOk ? main.len : 0)) {
      action = 'rep'
      useLen = rep.len
      useRepIdx = rep.index
    } else if (mainOk) {
      action = 'match'
      useLen = main.len
      useDist = main.dist
    }

    // lazy: if the next position has a strictly longer match, emit a literal now
    if (action !== 'lit' && pos + 1 < n) {
      const main1 = mf.best(pos + 1)
      const rep1n = bestRep(pos + 1)
      const next = Math.max(main1.len >= K_MATCH_MIN_LEN ? main1.len : 0, rep1n.len)
      if (next > useLen) action = 'lit'
    }

    if (action === 'lit') {
      const prevByte = pos > 0 ? data[pos - 1] : 0
      const base = litContextBase(pos, prevByte, cfg)
      rc.encodeBit(m.isMatch, (state << K_NUM_POS_BITS_MAX) + posState, 0)
      const matched = !stateIsCharState(state)
      const matchByte = matched ? data[pos - rep0 - 1] : 0
      encodeLiteral(rc, m, base, data[pos], matched, matchByte)
      if (collect)
        tokens.push({ kind: 'lit', pos, len: 1, dist: 0, repIndex: -1, state, byte: data[pos] })
      state = stateUpdateLiteral(state)
      stats.literals++
      stats.literalBytes++
      mf.insert(pos)
      pos++
      continue
    }

    // it's a match of some kind — emit IsMatch=1
    rc.encodeBit(m.isMatch, (state << K_NUM_POS_BITS_MAX) + posState, 1)

    if (action === 'rep') {
      rc.encodeBit(m.isRep, state, 1)
      const idx = useRepIdx
      if (idx === 0) {
        rc.encodeBit(m.isRepG0, state, 0)
        rc.encodeBit(m.isRep0Long, (state << K_NUM_POS_BITS_MAX) + posState, 1) // always long (len>=2)
      } else {
        rc.encodeBit(m.isRepG0, state, 1)
        if (idx === 1) {
          rc.encodeBit(m.isRepG1, state, 0)
        } else {
          rc.encodeBit(m.isRepG1, state, 1)
          rc.encodeBit(m.isRepG2, state, idx === 2 ? 0 : 1)
        }
      }
      // reorder the MRU list exactly as the decoder will
      const dist = [rep0, rep1, rep2, rep3][idx]
      if (idx === 1) {
        rep1 = rep0
      } else if (idx === 2) {
        rep2 = rep1
        rep1 = rep0
      } else if (idx === 3) {
        rep3 = rep2
        rep2 = rep1
        rep1 = rep0
      }
      rep0 = dist
      encodeLen(rc, m.repLen, useLen - K_MATCH_MIN_LEN, posState)
      state = stateUpdateRep(state)
      if (collect)
        tokens.push({ kind: 'rep', pos, len: useLen, dist: rep0 + 1, repIndex: idx, state, byte: 0 })
      stats.reps++
      stats.repDist[idx]++
      stats.matchBytes += useLen
      for (let k = 0; k < useLen; k++) mf.insert(pos + k)
      pos += useLen
    } else {
      // new match
      rc.encodeBit(m.isRep, state, 0)
      rep3 = rep2
      rep2 = rep1
      rep1 = rep0
      rep0 = useDist
      encodeLen(rc, m.len, useLen - K_MATCH_MIN_LEN, posState)
      encodeDistance(rc, m, useLen, useDist)
      state = stateUpdateMatch(state)
      if (collect)
        tokens.push({ kind: 'match', pos, len: useLen, dist: useDist + 1, repIndex: -1, state, byte: 0 })
      stats.matches++
      stats.matchBytes += useLen
      for (let k = 0; k < useLen; k++) mf.insert(pos + k)
      pos += useLen
    }
  }

  const stream = rc.flush()
  // Prefix the one-byte LZMA properties so decode is self-describing.
  const encoded = new Uint8Array(stream.length + 1)
  encoded[0] = propsByte(cfg.lc, cfg.lp, cfg.pb)
  encoded.set(stream, 1)
  stats.streamBytes = encoded.length
  stats.bitsPerByte = n > 0 ? (encoded.length * 8) / n : 0
  return { encoded, tokens, stats, props: { lc: cfg.lc, lp: cfg.lp, pb: cfg.pb } }
}

// =============================================================================
// DECODE — model-driven, stops at outLen.
// =============================================================================
export function lzmaDecode(encoded: Uint8Array, outLen: number): Uint8Array {
  const out = new Uint8Array(outLen)
  if (outLen === 0) return out
  const { lc, lp, pb } = parseProps(encoded[0]) // read the properties byte
  const cfg = makeCfg(lc, lp, pb)
  const rc = new RangeDec(encoded, 1) // the range stream begins after the props byte
  const m = new LzmaModel(lc, lp)

  let state = 0
  let rep0 = 0
  let rep1 = 0
  let rep2 = 0
  let rep3 = 0
  let pos = 0

  while (pos < outLen) {
    const posState = pos & cfg.posMask
    if (rc.decodeBit(m.isMatch, (state << K_NUM_POS_BITS_MAX) + posState) === 0) {
      // literal
      const prevByte = pos > 0 ? out[pos - 1] : 0
      const base = litContextBase(pos, prevByte, cfg)
      const matched = !stateIsCharState(state)
      const matchByte = matched ? out[pos - rep0 - 1] : 0
      out[pos++] = decodeLiteral(rc, m, base, matched, matchByte)
      state = stateUpdateLiteral(state)
      continue
    }

    let len: number
    if (rc.decodeBit(m.isRep, state) === 1) {
      // rep match
      if (rc.decodeBit(m.isRepG0, state) === 0) {
        if (rc.decodeBit(m.isRep0Long, (state << K_NUM_POS_BITS_MAX) + posState) === 0) {
          // short rep — a single byte at rep0
          state = stateUpdateShortRep(state)
          out[pos] = out[pos - rep0 - 1]
          pos++
          continue
        }
      } else {
        let dist: number
        if (rc.decodeBit(m.isRepG1, state) === 0) {
          dist = rep1
        } else {
          if (rc.decodeBit(m.isRepG2, state) === 0) {
            dist = rep2
          } else {
            dist = rep3
            rep3 = rep2
          }
          rep2 = rep1
        }
        rep1 = rep0
        rep0 = dist
      }
      len = decodeLen(rc, m.repLen, posState) + K_MATCH_MIN_LEN
      state = stateUpdateRep(state)
    } else {
      // new match
      rep3 = rep2
      rep2 = rep1
      rep1 = rep0
      len = decodeLen(rc, m.len, posState) + K_MATCH_MIN_LEN
      state = stateUpdateMatch(state)
      rep0 = decodeDistance(rc, m, len)
    }

    // copy the match
    const src = pos - rep0 - 1
    for (let k = 0; k < len && pos < outLen; k++) out[pos + k] = out[src + k]
    pos += len
  }
  return out
}

// A convenience used by the visualiser and self-test: does encode→decode invert?
export function lzmaRoundTrips(data: Uint8Array): boolean {
  const { encoded } = lzmaEncode(data)
  const back = lzmaDecode(encoded, data.length)
  if (back.length !== data.length) return false
  for (let i = 0; i < data.length; i++) if (back[i] !== data[i]) return false
  return true
}
