// tans.ts — table-driven ANS (tANS / "FSE", Finite State Entropy).
//
// rANS (see `rans.ts`) reaches the entropy floor with a multiply and a divide per
// symbol. **tANS** reaches the *same* floor with only table lookups, shifts and
// bit I/O — no multiplies at all. That is the trick behind Yann Collet's FSE, the
// entropy stage of **Zstandard** and the "FSE" in Apple's LZFSE. The state is a
// small integer living in a window [L, 2L); a single table says, for the current
// state and next symbol, how many bits to spill and which state to jump to. The
// whole codec is a finite-state machine whose transition table is *built from the
// symbol frequencies* — the same normalised table rANS already produces here, so
// the two coders share their model and land within rounding of each other.
//
// Like all ANS, it is LIFO: the encoder walks the input **backwards** and the
// decoder walks the stream **forwards**, recovering the original order. We realise
// that by recording the encoder's bit-writes and laying them into the output in
// reverse, so a plain forward MSB-first reader inverts it exactly.

import { BitReader, BitWriter } from './bits.ts'
import {
  normaliseFreqs,
  RANS_M,
  RANS_SCALE_BITS,
  type RansTable,
  quantisedEntropy,
} from './rans.ts'

const L = RANS_M // table size = 2^tableLog (4096)
const TABLE_LOG = RANS_SCALE_BITS // 12
const MASK = L - 1

// floor(log2(v)) for v ≥ 1.
function highbit(v: number): number {
  return 31 - Math.clz32(v)
}

// The FSE "spread": lay each symbol's `freq[s]` occurrences across the L table
// slots by stepping a fixed odd stride, which (the stride being coprime to the
// power-of-two L) visits every slot exactly once. This near-uniform interleaving
// is what keeps the coding loss tiny.
function spreadSymbols(table: RansTable): Uint16Array {
  const tableSymbol = new Uint16Array(L)
  const step = (L >> 1) + (L >> 3) + 3 // odd ⇒ coprime to L ⇒ a full permutation
  let pos = 0
  for (let s = 0; s < table.alphabet; s++) {
    for (let i = 0; i < table.freq[s]; i++) {
      tableSymbol[pos] = s
      pos = (pos + step) & MASK
    }
  }
  return tableSymbol
}

// ---- encode-side transition table (Yann Collet's construction) ----
export interface EncodeTables {
  stateTable: Uint16Array // slot → next state value (∈ [L, 2L))
  deltaNbBits: Int32Array // per symbol: fixed-point term giving the bits to spill
  deltaFindState: Int32Array // per symbol: offset into stateTable
  tableSymbol: Uint16Array
}

export function buildEncodeTables(table: RansTable): EncodeTables {
  const tableSymbol = spreadSymbols(table)
  // cumulative starts per symbol (ascending), matching the decode ordering.
  const cumul = new Int32Array(table.alphabet + 1)
  for (let s = 0; s < table.alphabet; s++) cumul[s + 1] = cumul[s] + table.freq[s]

  const stateTable = new Uint16Array(L)
  const cumulWork = Int32Array.from(cumul)
  for (let u = 0; u < L; u++) {
    const s = tableSymbol[u]
    stateTable[cumulWork[s]++] = L + u // store the working-state value, not the slot
  }

  const deltaNbBits = new Int32Array(table.alphabet)
  const deltaFindState = new Int32Array(table.alphabet)
  let total = 0
  for (let s = 0; s < table.alphabet; s++) {
    const f = table.freq[s]
    if (f === 0) continue
    if (f === 1) {
      // A once-seen symbol always renormalises to a single state — the full
      // tableLog bits. (Yann's special case; the general formula's highbit(0)
      // is undefined.)
      deltaNbBits[s] = (TABLE_LOG << 16) - (1 << TABLE_LOG)
      deltaFindState[s] = total - 1
    } else {
      const maxBitsOut = TABLE_LOG - highbit(f - 1)
      const minStatePlus = f << maxBitsOut
      deltaNbBits[s] = (maxBitsOut << 16) - minStatePlus
      deltaFindState[s] = total - f
    }
    total += f
  }
  return { stateTable, deltaNbBits, deltaFindState, tableSymbol }
}

// ---- decode-side transition table ----
export interface DecodeTables {
  symbol: Uint16Array // slot → decoded symbol
  nbBits: Uint8Array // slot → bits to read
  newState: Uint16Array // slot → base of the next state (∈ [0, L))
  tableSymbol: Uint16Array
}

export function buildDecodeTables(table: RansTable): DecodeTables {
  const tableSymbol = spreadSymbols(table)
  const symbol = new Uint16Array(L)
  const nbBits = new Uint8Array(L)
  const newState = new Uint16Array(L)
  const symbolNext = new Int32Array(table.alphabet)
  for (let s = 0; s < table.alphabet; s++) symbolNext[s] = table.freq[s]
  for (let u = 0; u < L; u++) {
    const s = tableSymbol[u]
    symbol[u] = s
    const next = symbolNext[s]++ // ∈ [freq, 2·freq)
    const nb = TABLE_LOG - highbit(next)
    nbBits[u] = nb
    newState[u] = (next << nb) - L // ∈ [0, L)
  }
  return { symbol, nbBits, newState, tableSymbol }
}

// ---- codec ----
export interface TansResult {
  encoded: Uint8Array
  table: RansTable
  writes: number // number of bit-write groups (for the visualiser)
}

/** Build a normalised table straight from bytes (reuses rANS's normaliser). */
export function tansTableFromData(data: Uint8Array, alphabet = 256): RansTable {
  const counts = new Array<number>(alphabet).fill(0)
  for (const b of data) counts[b]++
  return normaliseFreqs(counts, alphabet)
}

export function tansEncode(data: Uint8Array, table?: RansTable): TansResult {
  const tbl = table ?? tansTableFromData(data)
  if (data.length === 0) return { encoded: new Uint8Array(0), table: tbl, writes: 0 }
  const { stateTable, deltaNbBits, deltaFindState } = buildEncodeTables(tbl)

  // Record every (value, bitCount) write in chronological order, then lay them
  // into the stream in reverse — the LIFO transport that makes a forward reader
  // the exact inverse.
  const vals: number[] = []
  const lens: number[] = []
  let value = L // a valid starting state in [L, 2L)
  for (let i = data.length - 1; i >= 0; i--) {
    const s = data[i]
    const nb = (value + deltaNbBits[s]) >> 16
    vals.push(value & ((1 << nb) - 1))
    lens.push(nb)
    value = stateTable[(value >> nb) + deltaFindState[s]]
  }
  // Flush the final state (its low tableLog bits — the slot index the decoder seeds from).
  vals.push(value & MASK)
  lens.push(TABLE_LOG)

  const w = new BitWriter()
  for (let i = vals.length - 1; i >= 0; i--) w.writeBits(vals[i], lens[i])
  return { encoded: w.finish(), table: tbl, writes: vals.length }
}

export function tansDecode(encoded: Uint8Array, length: number, table: RansTable): Uint8Array {
  const out = new Uint8Array(length)
  if (length === 0) return out
  const { symbol, nbBits, newState } = buildDecodeTables(table)
  const r = new BitReader(encoded)
  let x = r.readBits(TABLE_LOG) // seed state ∈ [0, L)
  for (let i = 0; i < length; i++) {
    out[i] = symbol[x]
    const nb = nbBits[x]
    x = newState[x] + r.readBits(nb)
  }
  return out
}

/** The floor tANS actually hits — identical model to rANS, so identical bound. */
export function tansQuantisedEntropy(table: RansTable, counts: number[]): number {
  return quantisedEntropy(table, counts)
}

export { TABLE_LOG as TANS_TABLE_LOG, L as TANS_L }
